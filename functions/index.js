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

initializeApp();
const db = getFirestore();
setGlobalOptions({ region: "europe-west1", maxInstances: 5 });

/* ---------- configuration ---------- */

const CLIENT_ID = defineSecret("GOOGLE_OAUTH_CLIENT_ID");
const CLIENT_SECRET = defineSecret("GOOGLE_OAUTH_CLIENT_SECRET");
const APP_URL = defineString("APP_URL", { default: "https://itairosenblum-hash.github.io/tripcost/" });
const SECRETS = [CLIENT_ID, CLIENT_SECRET];

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
