# Bunker Pilot — Gumroad automation update

This zip is the license server you already have (STEP1b) PLUS automatic sales:
Gumroad tells the server a sale happened -> the server makes a code -> the buyer gets it by email.

New / changed files (upload ALL of them to your GitHub repo `bunker-license-backend`, replacing the old ones):
- server.js     (changed: Gumroad sale receiver)
- store.js      (changed: remembers each Gumroad sale)
- email.js      (NEW: sends the email through Resend)
- schema.sql    (changed: adds the gumroad_sales table; run it again in Supabase, it is safe)
- package.json  (changed: tests only)
- test.js, test-gumroad.js (self-tests, 27 + 14 checks pass)
- public/admin.html, README-STEP-1.md (unchanged)

The full click-by-click guide is the Google-Docs-style document "Bunker Pilot — Gumroad Setup Guide"
that came with this zip. Nothing changes until you add the new settings on Render, so
uploading these files is safe: your existing code generation and app activation keep working.

New Render settings (Environment): GUMROAD_TOKEN, GUMROAD_PRODUCT, RESEND_API_KEY, MAIL_FROM, APP_URL
Optional: MAIL_REPLY_TO, SUPPORT_CONTACT, GUMROAD_FORWARD_URL

FREE GMAIL OPTION (no domain needed)
Instead of Resend you can send the emails through your own Gmail with the small Google script in
the folder 2-paste-into-google. Then set APPS_SCRIPT_URL and APPS_SCRIPT_SECRET on Render
(and you do NOT need RESEND_API_KEY or MAIL_FROM). Full steps: START-HERE.md.
