// TripCost — Cloud Functions לחיבור קבוע ל-Google Drive (כמו בפרויקט הקבלות).
// ה-refresh token נשמר בשרת (secrets/drive ב-Firestore, אוסף שה-Rules חוסמים ללקוחות),
// ולכן אין צורך להתחבר מחדש לדרייב. העלאה, צפייה ומחיקה של קבצים עוברות דרך הפונקציות האלה,
// כך שגם חשבון משותף (למשל בת הזוג) רואה את כל הקבצים בלי שיתוף תיקייה בדרייב.
import { initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { onCall, onRequest, HttpsError } from "firebase-functions/v2/https";
import { setGlobalOptions, logger } from "firebase-functions/v2";
import { defineSecret, defineString } from "firebase-functions/params";
import { OAuth2Client } from "google-auth-library";
import { drive as driveApi } from "@googleapis/drive";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { GoogleGenAI, Type, ThinkingLevel } from "@google/genai";

initializeApp();
const db = getFirestore();
setGlobalOptions({ region: "europe-west1", maxInstances: 5 });

/* ---------- configuration ---------- */

const CLIENT_ID = defineSecret("GOOGLE_OAUTH_CLIENT_ID");
const CLIENT_SECRET = defineSecret("GOOGLE_OAUTH_CLIENT_SECRET");
const APP_URL = defineString("APP_URL", { default: "https://itairosenblum-hash.github.io/tripcost/" });
const SECRETS = [CLIENT_ID, CLIENT_SECRET];
// קריאת קבלות עם Gemini (כמו בפרויקטים shopping ו-crane)
const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");
const GEMINI_MODEL = defineString("GEMINI_MODEL", { default: "gemini-3.8-flash" });
// מודל גיבוי כשהמודל הראשי עמוס (שגיאת 503)
const GEMINI_FALLBACK_MODEL = defineString("GEMINI_FALLBACK_MODEL", { default: "gemini-flash-latest" });

const ADMIN_EMAIL = "itai.rosenblum@gmail.com";
// אותו שם כמו התיקייה שהאפליקציה יצרה עד היום, כדי שהקבצים הקיימים יישארו במקום אחד
const APP_FOLDER_NAME = "TripCost - קבצים מצורפים";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const MAX_BYTES = 7 * 1024 * 1024;

const DRIVE_SECRET = db.doc("secrets/drive");
const DRIVE_CONFIG = db.doc("config/drive");
const OAUTH_STATE = db.doc("secrets/oauthState");

function projectId() {
  return process.env.GCLOUD_PROJECT || JSON.parse(process.env.FIREBASE_CONFIG || "{}").projectId;
}
const redirectUri = () => `https://europe-west1-${projectId()}.cloudfunctions.net/driveCallback`;
const oauthClient = () => new OAuth2Client(CLIENT_ID.value(), CLIENT_SECRET.value(), redirectUri());

/* ---------- auth ---------- */

function signedInEmail(request) {
  const t = request.auth?.token;
  if (!t?.email || !t.email_verified) throw new HttpsError("unauthenticated", "נדרשת התחברות");
  return t.email.toLowerCase();
}

// מורשים: המנהל, וכל מי שהמנהל שיתף איתו את הנתונים (members במסמך הנתונים שלו)
async function requireAllowed(request) {
  const email = signedInEmail(request);
  if (email === ADMIN_EMAIL) return { email, admin: true };
  const cfg = (await DRIVE_CONFIG.get()).data();
  if (cfg?.ownerUid) {
    const snap = await db.doc(`users/${cfg.ownerUid}/data/state`).get();
    const members = (snap.data()?.members || []).map((e) => String(e).toLowerCase());
    if (members.includes(email)) return { email, admin: false };
  }
  throw new HttpsError("permission-denied", "אין הרשאה לקבצים");
}

async function getDrive() {
  const refreshToken = (await DRIVE_SECRET.get()).data()?.refreshToken;
  if (!refreshToken) throw new HttpsError("failed-precondition", "הדרייב לא מחובר. יש לחבר אותו בתפריט הסנכרון.");
  const client = oauthClient();
  client.setCredentials({ refresh_token: refreshToken });
  return driveApi({ version: "v3", auth: client });
}

// מתרגם שגיאות של Google לשגיאה ברורה ללקוח
function driveError(e, fallback) {
  if (e instanceof HttpsError) return e;
  const msg = String(e?.response?.data?.error || e?.message || "");
  logger.error(fallback, msg);
  if (/invalid_grant/.test(msg)) return new HttpsError("failed-precondition", "ההרשאה לדרייב בוטלה. יש לחבר מחדש בתפריט הסנכרון.");
  if (e?.code === 404 || e?.status === 404) return new HttpsError("not-found", "הקובץ לא נמצא בדרייב");
  return new HttpsError("internal", fallback);
}

/* ---------- helpers ---------- */

function cleanName(s, max = 60) {
  return String(s || "").replace(/[\\/:*?"<>|#%{}~&\n\r\t]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
}

const isAllowedType = (t) => /^image\//.test(t) || t === "application/pdf";

/* ---------- Drive connection (admin) ---------- */

function allowedReturnUrl(url) {
  const allowed = [
    APP_URL.value(),
    "https://itairosenblum-hash.github.io/tripcost/",
    `https://${projectId()}.web.app/`,
    `https://${projectId()}.firebaseapp.com/`
  ];
  return allowed.find((a) => typeof url === "string" && url.split("#")[0].split("?")[0] === a) || APP_URL.value();
}

export const driveAuthUrl = onCall({ secrets: SECRETS }, async (request) => {
  const email = signedInEmail(request);
  if (email !== ADMIN_EMAIL) throw new HttpsError("permission-denied", "רק המנהל יכול לחבר את הדרייב");
  const state = crypto.randomBytes(24).toString("hex");
  await OAUTH_STATE.set({
    state,
    ownerUid: request.auth.uid,
    returnUrl: allowedReturnUrl(request.data?.returnUrl),
    expiresAt: Date.now() + 10 * 60 * 1000
  });
  const url = oauthClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [DRIVE_SCOPE, "openid", "email"],
    state,
    login_hint: ADMIN_EMAIL
  });
  return { url };
});

export const driveCallback = onRequest({ secrets: SECRETS }, async (req, res) => {
  let returnUrl = APP_URL.value();
  const back = (status) => res.redirect(`${returnUrl}#drive=${status}`);
  try {
    const { code, state, error } = req.query;
    const saved = (await OAUTH_STATE.get()).data();
    if (saved?.returnUrl) returnUrl = allowedReturnUrl(saved.returnUrl);
    if (error) return back("cancelled");

    await OAUTH_STATE.delete();
    if (!saved || saved.state !== state || saved.expiresAt < Date.now() || !code) return back("expired");

    const client = oauthClient();
    const { tokens } = await client.getToken(String(code));
    const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: CLIENT_ID.value() });
    const email = ticket.getPayload()?.email?.toLowerCase();
    if (email !== ADMIN_EMAIL) return back("wrong-account");
    if (!tokens.refresh_token) return back("no-refresh-token");
    if (!String(tokens.scope || "").includes(DRIVE_SCOPE)) return back("missing-scope");

    client.setCredentials(tokens);
    const drive = driveApi({ version: "v3", auth: client });

    // התיקייה הקיימת (מזוהה לפי מזהה שמור, או לפי השם), ואם אין — יוצרים חדשה
    let folder = null;
    const current = (await DRIVE_CONFIG.get()).data();
    if (current?.folderId) {
      folder = await drive.files.get({ fileId: current.folderId, fields: "id,name,webViewLink,trashed" })
        .then((r) => (r.data.trashed ? null : r.data)).catch(() => null);
    }
    if (!folder) {
      const q = `name='${APP_FOLDER_NAME.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
      const found = await drive.files.list({ q, fields: "files(id,name,webViewLink)", pageSize: 1 }).catch(() => null);
      folder = found?.data?.files?.[0] || null;
    }
    if (!folder) {
      folder = (await drive.files.create({
        requestBody: { name: APP_FOLDER_NAME, mimeType: "application/vnd.google-apps.folder" },
        fields: "id,name,webViewLink"
      })).data;
    }

    await DRIVE_SECRET.set({ refreshToken: tokens.refresh_token, email, connectedAt: FieldValue.serverTimestamp() });
    await DRIVE_CONFIG.set({
      connected: true,
      email,
      ownerUid: saved.ownerUid || current?.ownerUid || null,
      folderId: folder.id,
      folderName: folder.name,
      folderLink: folder.webViewLink || `https://drive.google.com/drive/folders/${folder.id}`,
      connectedAt: FieldValue.serverTimestamp()
    });
    return back("connected");
  } catch (e) {
    logger.error("drive callback failed", e);
    return back("error");
  }
});

export const driveStatus = onCall(async (request) => {
  const email = signedInEmail(request);
  const cfg = (await DRIVE_CONFIG.get()).data() || {};
  return {
    connected: !!cfg.connected,
    email: cfg.email || null,
    isAdmin: email === ADMIN_EMAIL,
    folderLink: email === ADMIN_EMAIL ? (cfg.folderLink || null) : null
  };
});

/* ---------- files ---------- */

export const uploadAttachment = onCall({ secrets: SECRETS, timeoutSeconds: 120, memory: "512MiB" }, async (request) => {
  await requireAllowed(request);
  const { data, mimeType, name, tripName, item } = request.data || {};
  const type = String(mimeType || "");
  if (!isAllowedType(type)) throw new HttpsError("invalid-argument", `סוג קובץ לא נתמך: ${type}`);
  const buffer = Buffer.from(String(data || ""), "base64");
  if (!buffer.length) throw new HttpsError("invalid-argument", "קובץ ריק");
  if (buffer.length > MAX_BYTES) throw new HttpsError("invalid-argument", "הקובץ גדול מדי (עד 7MB)");

  const cfg = (await DRIVE_CONFIG.get()).data();
  if (!cfg?.folderId) throw new HttpsError("failed-precondition", "הדרייב לא מחובר. יש לחבר אותו בתפריט הסנכרון.");

  const fileName = [cleanName(tripName, 40), cleanName(item, 40), cleanName(name, 80) || "קובץ"].filter(Boolean).join(" - ");
  try {
    const drive = await getDrive();
    const res = await drive.files.create({
      requestBody: { name: fileName, parents: [cfg.folderId] },
      media: { mimeType: type, body: Readable.from(buffer) },
      fields: "id,webViewLink"
    });
    return { driveId: res.data.id, driveUrl: res.data.webViewLink || null };
  } catch (e) {
    throw driveError(e, "ההעלאה לדרייב נכשלה");
  }
});

export const getAttachment = onCall({ secrets: SECRETS, memory: "512MiB", timeoutSeconds: 120 }, async (request) => {
  await requireAllowed(request);
  const driveId = String(request.data?.driveId || "");
  if (!/^[\w-]{10,}$/.test(driveId)) throw new HttpsError("invalid-argument", "מזהה קובץ לא תקין");
  try {
    const drive = await getDrive();
    const meta = await drive.files.get({ fileId: driveId, fields: "name,mimeType,size,trashed" });
    if (meta.data.trashed) throw new HttpsError("not-found", "הקובץ נמחק מהדרייב");
    if (Number(meta.data.size) > 25 * 1024 * 1024) throw new HttpsError("failed-precondition", "הקובץ גדול מדי לתצוגה");
    const res = await drive.files.get({ fileId: driveId, alt: "media" }, { responseType: "arraybuffer" });
    return {
      name: meta.data.name,
      mimeType: meta.data.mimeType,
      data: Buffer.from(res.data).toString("base64")
    };
  } catch (e) {
    throw driveError(e, "טעינת הקובץ נכשלה");
  }
});

export const removeAttachment = onCall({ secrets: SECRETS }, async (request) => {
  await requireAllowed(request);
  const driveId = String(request.data?.driveId || "");
  if (!/^[\w-]{10,}$/.test(driveId)) throw new HttpsError("invalid-argument", "מזהה קובץ לא תקין");
  try {
    const drive = await getDrive();
    await drive.files.update({ fileId: driveId, requestBody: { trashed: true } });
    return { ok: true };
  } catch (e) {
    throw driveError(e, "מחיקת הקובץ נכשלה");
  }
});

/* ---------- receipt scanning (Gemini) ---------- */
// (GEMINI_API_KEY מגיע מ-Secret בריפו ומסונכרן בפריסה)
// הפונקציה רק קוראת את הקבלה ומחזירה שדות לטופס ההוצאה — לא שומרת כלום.
// הקובץ עצמו נשמר בדרייב כרגיל דרך uploadAttachment כשהמשתמש שומר את ההוצאה.

const SCAN_INSTRUCTIONS = `You extract structured data from a receipt, invoice, booking confirmation or card-charge slip for a family trip expense tracker.
Documents may be in any language (Hebrew, English, German, Italian, Thai, Japanese...). Write Hebrew output text, keeping brand and place names in their original Latin letters.
Rules:
- vendor: the business / company name as printed (hotel, airline, restaurant, shop, car rental). Drop legal suffixes like GmbH, Ltd, בע"מ, S.p.A. unless part of the brand.
- description: 2-5 Hebrew words saying what was bought, only if it adds something beyond the vendor (for example "3 לילות", "השכרת רכב", "ארוחת ערב", "כרטיסי כניסה"). null otherwise.
- amount: the total actually paid / charged including tax and tip, in the document's own currency, as a number. Ignore subtotals and VAT lines.
- currency: ISO 4217 code of that amount. € = EUR, $ = USD (unless the country makes it clearly CAD/AUD), £ = GBP, ₪ / ש"ח / NIS = ILS, ¥ = JPY, ฿ = THB, ₺ = TRY, CHF / Fr = CHF.
- date: the purchase / transaction date, YYYY-MM-DD. For a hotel use the stay's check-in date. Many countries print day first (DD/MM/YY, DD.MM.YYYY); US documents print month first.
- chargeDate: YYYY-MM-DD of the actual card charge (מועד חיוב / תאריך חיוב / charge date / debit date) ONLY if printed separately from the purchase date, else null.
- paymentMethod: "card" for a credit/debit card or Apple/Google Pay, "cash" for cash, "other" for bank transfer, Bit, PayPal and the like, null if not shown.
- paid: true if the document shows the amount was paid (a receipt, a charge slip, "paid", "שולם"). false for a quote, a reservation without payment, or "pay at property". null if unclear.
- chargedAmountILS: if the document also shows the amount charged in Israeli shekels (an Israeli card slip, a dynamic currency conversion line, "סכום חיוב בש\"ח"), that ILS number, else null.
- exchangeRate: ONLY a conversion rate to ILS explicitly printed on the document (שער / exchange rate / Kurs), else null. Never use your own knowledge of exchange rates.
- categoryId: exactly one of the category ids given, by what was bought. Flights and car rentals share one category. Taxis, trains, fuel, parking and public transport go under transport. Restaurants, cafes and supermarkets go under food.
- notes: one short Hebrew line with details worth keeping (number of nights, number of people, reservation or order number), or null.
- Use null for anything not on the document. Never invent dates or amounts.
- confidence: 0 to 1 per field, honest. Use below 0.7 when the text is blurry, cut off, handwritten or ambiguous.`;

const SCAN_FIELDS = ["vendor", "description", "amount", "currency", "date", "chargeDate", "paymentMethod", "paid",
  "chargedAmountILS", "exchangeRate", "categoryId", "notes"];

const SCAN_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    vendor: { type: Type.STRING, nullable: true },
    description: { type: Type.STRING, nullable: true },
    amount: { type: Type.NUMBER, nullable: true },
    currency: { type: Type.STRING, nullable: true },
    date: { type: Type.STRING, nullable: true, description: "YYYY-MM-DD" },
    chargeDate: { type: Type.STRING, nullable: true, description: "YYYY-MM-DD" },
    paymentMethod: { type: Type.STRING, nullable: true, enum: ["card", "cash", "other"] },
    paid: { type: Type.BOOLEAN, nullable: true },
    chargedAmountILS: { type: Type.NUMBER, nullable: true },
    exchangeRate: { type: Type.NUMBER, nullable: true },
    categoryId: { type: Type.STRING },
    notes: { type: Type.STRING, nullable: true },
    confidence: {
      type: Type.OBJECT,
      properties: Object.fromEntries(["vendor", "amount", "currency", "date", "categoryId"].map((f) => [f, { type: Type.NUMBER }]))
    }
  },
  required: [...SCAN_FIELDS, "confidence"],
  propertyOrdering: [...SCAN_FIELDS, "confidence"]
};

const validDate = (v) => {
  const s = typeof v === "string" ? v.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const t = Date.parse(s + "T00:00:00Z");
  return Number.isFinite(t) ? s : null;
};
const posNum = (v, max = 1e8) => (typeof v === "number" && Number.isFinite(v) && v > 0 && v < max ? v : null);
const cleanStr = (v, max = 120) => {
  if (v == null) return null;
  const s = String(v).replace(/\s+/g, " ").trim();
  return s && s !== "null" ? s.slice(0, max) : null;
};

export const scanReceipt = onCall({ secrets: [GEMINI_API_KEY], timeoutSeconds: 300, memory: "512MiB" }, async (request) => {
  await requireAllowed(request);
  const { data, mimeType, categories, tripName, tripStart } = request.data || {};
  const type = String(mimeType || "");
  if (!isAllowedType(type)) throw new HttpsError("invalid-argument", `סוג קובץ לא נתמך: ${type}`);
  const buffer = Buffer.from(String(data || ""), "base64");
  if (buffer.length < 100) throw new HttpsError("invalid-argument", "הקובץ ריק");
  if (buffer.length > MAX_BYTES) throw new HttpsError("invalid-argument", "הקובץ גדול מדי (עד 7MB)");

  // הקטגוריות מגיעות מהאפליקציה כדי שהתשובה תתאים בדיוק לרשימה שלה
  const cats = (Array.isArray(categories) ? categories : []).map((c) => cleanStr(c, 40)).filter(Boolean).slice(0, 30);
  if (!cats.length) cats.push("שונות");
  const ids = cats.map((_, i) => `c${i}`);
  const context = [
    "Categories (id: name):",
    ...cats.map((c, i) => `- c${i}: ${c}`),
    tripName ? `\nTrip: ${cleanStr(tripName, 60)}` : "",
    validDate(tripStart) ? `Trip starts ${tripStart}. Use it to resolve ambiguous or two-digit years.` : "",
    `Today is ${new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Jerusalem" })}.`
  ].filter(Boolean).join("\n");

  const schema = structuredClone(SCAN_SCHEMA);
  schema.properties.categoryId.enum = ids;

  const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY.value(), httpOptions: { timeout: 120000 } });
  const ask = (model) => ai.models.generateContent({
    model,
    contents: [{ role: "user", parts: [
      { inlineData: { mimeType: type, data: buffer.toString("base64") } },
      { text: context }
    ] }],
    config: {
      systemInstruction: SCAN_INSTRUCTIONS,
      responseMimeType: "application/json",
      responseSchema: schema,
      temperature: 0,
      // קריאת קבלה לא דורשת חשיבה ארוכה; ברירת המחדל של המודל איטית מדי
      thinkingConfig: { thinkingLevel: ThinkingLevel.LOW }
    }
  });

  // עומס זמני אצל Gemini (503/429) — מנסים שוב, ואז עוברים למודל הגיבוי. מכסה שנגמרה — אין טעם לנסות שוב
  const quota = (e) => /exceeded your current quota|billing/i.test(String(e?.message || ""));
  const busy = (e) => !quota(e) && /\b(503|429)\b|UNAVAILABLE|RESOURCE_EXHAUSTED|overloaded|high demand/i.test(String(e?.status || "") + " " + String(e?.message || ""));
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const primary = GEMINI_MODEL.value();
  const fallback = GEMINI_FALLBACK_MODEL.value();
  const plan = [[primary, 0], [primary, 2000], [primary, 5000], [fallback, 0], [fallback, 4000]];
  let r, usedModel, lastErr;
  for (let i = 0; i < plan.length; i++) {
    const [model, wait] = plan[i];
    if (wait) await sleep(wait);
    try {
      r = JSON.parse((await ask(model)).text);
      usedModel = model;
      break;
    } catch (e) {
      lastErr = e;
      logger.warn("gemini attempt failed", { model, message: String(e?.message || e).slice(0, 300) });
      if (quota(e)) break;
      if (!busy(e) && model === primary) i = plan.findIndex(([m]) => m === fallback) - 1;
    }
  }
  if (!r) {
    logger.error("gemini receipt scan failed", lastErr?.message || lastErr);
    const msg = String(lastErr?.message || lastErr?.cause?.message || "");
    if (quota(lastErr)) throw new HttpsError("resource-exhausted", "מכסת השימוש ב-AI נגמרה. בינתיים אפשר למלא ידנית.");
    throw new HttpsError("unavailable", busy(lastErr)
      ? "שירות ה-AI עמוס כרגע. נסו שוב בעוד דקה או מלאו ידנית."
      : /timeout|aborted/i.test(msg) ? "הסריקה לקחה יותר מדי זמן. נסו שוב או מלאו ידנית." : "הסריקה נכשלה. אפשר למלא את הפרטים ידנית.");
  }

  // ניקוי ובדיקות סבירות
  const currency = typeof r.currency === "string" && /^[A-Z]{3}$/.test(r.currency.trim().toUpperCase()) ? r.currency.trim().toUpperCase() : null;
  const amount = posNum(r.amount);
  const chargedAmountILS = posNum(r.chargedAmountILS);
  let exchangeRate = posNum(r.exchangeRate, 1000);
  // שער שלא הודפס אבל אפשר לחשב: סכום בש"ח חלקי הסכום במטבע המקורי
  let rateSource = exchangeRate ? "printed" : null;
  if (!exchangeRate && currency && currency !== "ILS" && amount && chargedAmountILS) {
    exchangeRate = Math.round((chargedAmountILS / amount) * 10000) / 10000;
    rateSource = "computed";
  }
  if (currency === "ILS") { exchangeRate = null; rateSource = null; }
  const vendor = cleanStr(r.vendor, 60);
  const description = cleanStr(r.description, 40);
  const catIndex = ids.indexOf(r.categoryId);

  return {
    model: usedModel,
    vendor,
    item: [vendor, description].filter(Boolean).join(" · ") || null,
    amount,
    currency,
    date: validDate(r.date),
    chargeDate: validDate(r.chargeDate),
    paymentMethod: ["card", "cash", "other"].includes(r.paymentMethod) ? r.paymentMethod : null,
    paid: typeof r.paid === "boolean" ? r.paid : null,
    chargedAmountILS,
    exchangeRate,
    rateSource,
    category: catIndex >= 0 ? cats[catIndex] : null,
    notes: cleanStr(r.notes, 160),
    confidence: r.confidence && typeof r.confidence === "object" ? r.confidence : {}
  };
});
