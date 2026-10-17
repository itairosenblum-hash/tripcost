# TripCost

אפליקציית PWA למעקב הוצאות טיולים. האתר (`index.html`) נפרס ל-GitHub Pages,
סנכרון וכניסה דרך Firebase (`trip-cost-ba9de`), וקבצים מצורפים נשמרים ב-Google Drive דרך Cloud Functions.

## קבצים מצורפים ודרייב

כמו באפליקציית הקבלות: המנהל מחבר את הדרייב **פעם אחת**, וה-refresh token נשמר בשרת
(`secrets/drive` ב-Firestore, אוסף שהלקוחות לא יכולים לקרוא). העלאה, צפייה ומחיקה עוברות דרך הפונקציות
ב-`functions/`, ולכן לא צריך להתחבר מחדש, וכל מי שהנתונים משותפים איתו רואה את כל הקבצים.
הקבצים נשמרים בתיקייה "TripCost - קבצים מצורפים" (הרשאה מצומצמת `drive.file`).

## סריקת קבלות

בטופס ההוצאה יש כפתור **סריקת קבלה**: מצלמים או בוחרים קובץ (תמונה או PDF), והפונקציה `scanReceipt`
שולחת אותו ל-Gemini (כמו בפרויקטים shopping ו-crane) ומחזירה: פריט/חברה, תאריך, מועד חיוב, סכום, מטבע,
שער (רק אם מודפס על הקבלה, או מחושב מסכום החיוב בש״ח), קטגוריה, אופן תשלום והערות. הקבלה מצורפת להוצאה אוטומטית.
כשאין שער על הקבלה, האפליקציה מביאה את השער ההיסטורי למועד החיוב. שדות שה-AI לא בטוח בהם מסומנים בכתום.
הפונקציה לא שומרת כלום בעצמה. נדרש Secret בריפו בשם `GEMINI_API_KEY` (אותו מפתח של shopping, מ-[Google AI Studio](https://aistudio.google.com/apikey)).

## הגדרה חד-פעמית (אפשר מהטלפון, ב"גרסת מחשב")

1. **Blaze:** [Firebase Console](https://console.firebase.google.com/project/trip-cost-ba9de/usage/details) ← Modify plan ← Blaze. נדרש ל-Cloud Functions; בשימוש כזה זה בפועל בחינם.
2. **מסך הסכמה:** [Audience](https://console.cloud.google.com/auth/audience?project=trip-cost-ba9de) ← **Publish app** (In production). במצב Testing ההרשאה לדרייב פגה כל 7 ימים.
3. **OAuth Client:** [Clients](https://console.cloud.google.com/auth/clients?project=trip-cost-ba9de) ← לפתוח את **Web client (auto created by Google Service)** (אותו לקוח שהאפליקציה כבר משתמשת בו, כך שהקבצים הקיימים נשארים נגישים):
   - Authorized redirect URIs ← להוסיף `https://europe-west1-trip-cost-ba9de.cloudfunctions.net/driveCallback` ← Save.
   - להעתיק את ה-**Client ID** וה-**Client secret**.
4. **חשבון שירות לפריסה:** [Service accounts](https://console.cloud.google.com/iam-admin/serviceaccounts?project=trip-cost-ba9de) ← Create service account בשם `github-deploy`, עם התפקידים **Editor**, **Cloud Functions Admin**, **Cloud Run Admin**, **Secret Manager Admin**, **Service Account User**. אחר כך: Keys ← Add key ← JSON.
5. **Secrets בריפו:** Settings ← Secrets and variables ← Actions ← New repository secret:

   | שם | ערך |
   | --- | --- |
   | `FIREBASE_SERVICE_ACCOUNT` | כל התוכן של קובץ ה-JSON משלב 4 |
   | `GOOGLE_OAUTH_CLIENT_ID` | Client ID משלב 3 |
   | `GOOGLE_OAUTH_CLIENT_SECRET` | Client secret משלב 3 |
   | `GEMINI_API_KEY` | מפתח Gemini לסריקת קבלות |

6. **פריסה:** Actions ← **Deploy Firebase functions** ← Run workflow. מכאן והלאה כל שינוי ב-`functions/` נפרס אוטומטית.
7. **חיבור הדרייב:** באפליקציה ← תפריט הסנכרון ← **חיבור Google Drive**, עם החשבון itai.rosenblum@gmail.com, ולאשר את ההרשאה לדרייב.

## פריסת האתר

`index.html` ו-`sw.js` מוגשים מ-GitHub Pages מהענף `main`. בכל שינוי בקבצי האתר מעלים את `CACHE_NAME` ב-`sw.js`,
ומעדכנים ב-`index.html` את `BUILD_STAMP`, `BUILD_EPOCH` ואת `versionStamp` בתחתית הדף (כמו ב-matlam). כשב-GitHub יש גרסה חדשה יותר מזו שנטענה, מופיע בתחתית קישור "גרסה חדשה זמינה — רענון".
חוקי Firestore (`firestore.rules`) מתעדכנים ידנית ב-Firebase Console.
