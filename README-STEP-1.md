# Bunker Pilot licensing — STEP 1 of 2: the license server + admin page

You will set up two free accounts: **Supabase** (stores your codes) and **Render**
(runs the license check), plus **GitHub** (just a shelf that holds these files for Render).
No coding — only clicking and copy/paste. Allow about 30 minutes.

When you finish this step you will be able to generate license codes.
STEP 2 (next message) puts the activation screen inside the Bunker Pilot app.

What is in this zip
- server.js, store.js, package.json — the license server
- schema.sql — creates the "licenses" table
- public/admin.html — your private page for making and revoking codes
- test.js — automatic self-test (already passed 20/20 before I sent you this; you do not need to run it)

---------------------------------------------------------------
## Phase 1 — Database (Supabase)

1. Go to **supabase.com** and sign up (free, no card).
2. **New Project** -> name it `bunker-license`.
   - Database password: use **letters and numbers only** (no @ : / # ? symbols — they break the
     connection string later). Write it down.
   - Region: **Singapore**.
3. Wait ~2 minutes until the project dashboard appears.
4. Left sidebar -> **SQL Editor** -> **New query**.
5. Open `schema.sql` from this zip with Notepad/TextEdit, copy everything, paste it into the editor,
   click **Run**. You should see "Success. No rows returned".
6. Get the connection string — **read this carefully, it is the #1 thing that goes wrong**:
   - Click the green **Connect** button at the top of the dashboard.
   - Choose **Session pooler** (NOT "Direct connection"). Render's free plan cannot reach the
     direct connection (it uses IPv6); the Session pooler works.
   - Copy the URI. It looks like:
     `postgresql://postgres.abcdefgh:[YOUR-PASSWORD]@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres`
   - Replace the text `[YOUR-PASSWORD]` (including the square brackets) with your database password.
   - Paste the finished string into Notes. You need it in Phase 2.

---------------------------------------------------------------
## Phase 2 — Put the server online (GitHub + Render)

1. Sign in (or sign up) at **github.com**.
2. **+** (top right) -> **New repository**. Name: `bunker-license-backend`. Set **Private**.
   Do not tick any "add README" boxes. **Create repository**.
3. Unzip this zip on your computer. On the empty repo page click **uploading an existing file**,
   drag in EVERYTHING inside the unzipped folder: `server.js`, `store.js`, `package.json`,
   `schema.sql`, `test.js`, `README-STEP-1.md` and the whole `public` folder.
   Scroll down -> **Commit changes**.
   (Check: the repo page should list `public` as a folder, and `public/admin.html` inside it.)
4. Sign up at **render.com** (free) and choose **GitHub** when asked to connect a Git provider.
5. **New** -> **Web Service** -> pick `bunker-license-backend`.
   - Language/Runtime: **Node**
   - Build Command: `npm install`
   - Start Command: `node server.js`
   - Instance type: **Free**
6. Under **Environment Variables** add two:
   - `DATABASE_URL` = the Session pooler string from Phase 1 (with your password filled in)
   - `ADMIN_PASSWORD` = a strong password you invent (at least 8 characters). This unlocks your
     admin page. Don't lose it. The server refuses to start if it is shorter than 8.
7. **Create Web Service**. Wait 2-3 minutes until it says **Live**.
8. Copy the address at the top, like `https://bunker-license-backend-xxxx.onrender.com`.
   **Save it — STEP 2 needs it.**

---------------------------------------------------------------
## Phase 3 — Check that it works

1. Open `YOUR-RENDER-URL/health` in your browser. You should see:
   `{"ok":true,"db":true}`
   - `"db":false` or an error = the DATABASE_URL is wrong. Most common causes: you copied the
     Direct connection instead of Session pooler, the password still has the [brackets], or the
     password contains symbols. Fix it in Render -> your service -> **Environment**, then it redeploys.
2. Open `YOUR-RENDER-URL/admin.html` -> enter your ADMIN_PASSWORD -> **Unlock**.
3. Type a note (e.g. "test") -> **Generate new code**. A code like `BUNK-7K4Q-P2XM` appears and is
   copied for you. Keep one test code for STEP 2.

---------------------------------------------------------------
## How the admin page works

- **Generate new code** — type the buyer's name in the note first. Send the code only AFTER payment.
- **Activated** — the buyer typed the code in the app; it is now locked to their phone.
- **Reset device** — buyer got a new phone? Click this and the same code can be activated on the
  new phone (the old phone stops working at its next online check).
- **Revoke** — stops the code working. **Restore** undoes a revoke.
- One code = one device. A second phone trying the same code is refused.

---------------------------------------------------------------
## Things to know (free-plan realities)

1. **Slow first tap.** Render's free server falls asleep after ~15 minutes without visits. The first
   request afterwards can take 30-60 seconds. The activation screen I build in STEP 2 will tell the
   buyer to wait. Buyers who already activated are NOT affected — the app works offline.
2. **Supabase pauses idle free projects** after about a week with no activity (they email a warning).
   If a paused database makes activation fail, open the Supabase dashboard and click Restore.
   OPTIONAL keep-awake: a free monitor such as uptimerobot.com pinging `YOUR-RENDER-URL/health`
   every 5-10 minutes keeps both awake. Not officially supported by Render, but it works for most people.
3. **Keep your admin link private.** The password is the only protection; 8 wrong tries locks the
   page for 15 minutes.
4. **Back up your codes (one click).** The Supabase free plan has no backups, so the admin page has a
   **Backup & restore** box. See the section below.

---------------------------------------------------------------
## Backup & restore (admin page, bottom box)

**Backup:** click **Download backup (CSV)**. A file like `bunker-licenses-backup-2026-10-07.csv` lands in
your Downloads folder. Do it after every few sales and at least once a week. The box shows how long ago
your last backup was (orange after 7 days). Copy the file somewhere safe (Google Drive / USB).
- The file contains every code AND which phone each one is locked to. That is what lets a restore keep
  your buyers activated. Treat it like a password: don't post it or send it to buyers.
- Don't open and re-save it in Excel/Sheets before restoring (they can change the date formats). Opening
  to look is fine; just close without saving.

**Restore** (new or emptied database, Supabase paused-and-lost, mistakes):
1. If the database is new/empty: run `schema.sql` in Supabase first (Phase 1), and make sure Render
   points to it (`DATABASE_URL`).
2. Open the admin page, unlock, click **Restore from backup...**, pick your CSV, confirm.
3. It says e.g. "Restore finished: 120 added, 0 already there." Buyers who were activated stay
   activated on their phones; nobody has to re-enter anything.
- Restore **only adds missing codes**; codes already in the database are never changed, so running it
  twice is harmless. To undo a mistake on one code, use Revoke / Restore / Reset device as usual.
- It also understands the CSV from Supabase -> Table Editor -> licenses -> Export (extra columns such as
  `id` are ignored), so either file works.
- Big backups (over 500 codes) are sent in pieces automatically.

**First-time safety check (2 minutes):** after deploying this version, click **Download backup**, then
**Restore from backup...** with that same file. It should say "0 added, N already there". That proves
the backup and restore work on your real database, before you ever need them.

---------------------------------------------------------------
## Next
Come back and say **continue** for STEP 2: the activation screen inside the Bunker Pilot app,
plus publishing it on Netlify.
