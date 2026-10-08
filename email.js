'use strict';
// Sends the buyer's activation email through Resend's web API (plain HTTPS, so Render's free plan allows it).
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function buildEmail({ name, code, appUrl, contact }) {
  const first = String(name || '').trim().split(/\s+/)[0];
  const hello = first ? `Hi ${first},` : 'Hello,';
  const contactLine = contact ? `If you need any help, reply to this email or contact: ${contact}` : 'If you need any help, just reply to this email.';
  const subject = 'Your Bunker Pilot activation code';
  const text = [
    hello, '', 'Thank you for purchasing Bunker Pilot!', '',
    '1. OPEN THE APP', appUrl, '',
    '2. INSTALL IT FIRST',
    'Android (Chrome): menu (three dots) > Install app / Add to Home screen.',
    'iPhone (Safari): Share button > Add to Home Screen.',
    'Then open Bunker Pilot from its icon on your Home Screen.', '',
    '3. ACTIVATE', 'Open the app, type this code, tick the Terms box and tap Activate:', '', code, '',
    'The first activation needs internet and can take up to a minute. After that the app works offline.',
    'Your license works on exactly ONE device. Please do not share this code.', '',
    contactLine, '', 'Bunker Pilot'
  ].join('\n');
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f4f1ee;font-family:Arial,Helvetica,sans-serif;color:#222">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f1ee"><tr><td align="center" style="padding:20px 10px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden">
<tr><td style="background:#2b0f1a;color:#ffc23a;padding:18px 22px;font-size:20px;font-weight:bold">&#9875; Bunker Pilot</td></tr>
<tr><td style="padding:22px;font-size:15px;line-height:1.5">
<p style="margin:0 0 12px">${esc(hello)}</p>
<p style="margin:0 0 18px">Thank you for purchasing <b>Bunker Pilot</b>!</p>
<p style="margin:0 0 6px"><b>1. Open the app</b></p>
<p style="margin:0 0 18px"><a href="${esc(appUrl)}" style="display:inline-block;background:#ffc23a;color:#2a1300;text-decoration:none;font-weight:bold;padding:11px 18px;border-radius:8px">Open Bunker Pilot</a></p>
<p style="margin:0 0 6px"><b>2. Install it first</b></p>
<p style="margin:0 0 18px">Android (Chrome): menu (three dots) &rarr; <i>Install app</i> / <i>Add to Home screen</i>.<br>iPhone (Safari): Share button &rarr; <i>Add to Home Screen</i>.<br>Then open Bunker Pilot from its icon on your Home Screen.</p>
<p style="margin:0 0 6px"><b>3. Activate</b></p>
<p style="margin:0 0 8px">Type this code in the app, tick the Terms box and tap Activate:</p>
<p style="margin:0 0 18px;text-align:center;background:#fff7e0;border:2px dashed #ffb81c;border-radius:10px;padding:14px;font:bold 24px 'Courier New',monospace;letter-spacing:2px">${esc(code)}</p>
<p style="margin:0 0 12px;font-size:13px;color:#555">The first activation needs internet and can take up to a minute. After that the app works offline.</p>
<p style="margin:0 0 12px;font-size:13px;color:#555"><b>Your license works on exactly one device.</b> Please do not share this code.</p>
<p style="margin:0;font-size:13px;color:#555">${esc(contactLine)}</p>
</td></tr></table></td></tr></table></body></html>`;
  return { subject, text, html };
}

// Returns an object with sendCode({to,name,code}) that throws if Resend refuses the email.
function makeMailer({ apiKey, from, replyTo, appUrl, contact, fetchImpl }) {
  const f = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  return {
    async sendCode({ to, name, code }) {
      if (!f) throw new Error('fetch is not available (needs Node 18+)');
      const { subject, text, html } = buildEmail({ name, code, appUrl, contact });
      const body = { from, to: [to], subject, html, text };
      if (replyTo) body.reply_to = replyTo;
      const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 20000);
      try {
        const r = await f('https://api.resend.com/emails', {
          method: 'POST', signal: ctl.signal,
          headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        if (!r.ok) {
          let detail = ''; try { detail = (await r.text()).slice(0, 300); } catch {}
          throw new Error(`Resend ${r.status} ${detail}`.trim());
        }
      } finally { clearTimeout(timer); }
    }
  };
}

// Free option: sends through a small Google Apps Script that lives in YOUR Gmail account.
// The script is called over normal HTTPS (Render's free plan blocks classic Gmail/SMTP sending).
// Limit of a free Gmail account: 100 email recipients per day.
function makeAppsScriptMailer({ url, secret, fromName, replyTo, appUrl, contact, fetchImpl }) {
  const f = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  return {
    async sendCode({ to, name, code }) {
      if (!f) throw new Error('fetch is not available (needs Node 18+)');
      const { subject, text, html } = buildEmail({ name, code, appUrl, contact });
      const body = { secret, to, subject, html, text, fromName: fromName || '', replyTo: replyTo || '' };
      const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 30000);
      try {
        // Apps Script answers a POST with a redirect to the result page; fetch follows it by default.
        const r = await f(url, {
          method: 'POST', redirect: 'follow', signal: ctl.signal,
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify(body)
        });
        const raw = await r.text();
        let j = null; try { j = JSON.parse(raw); } catch {}
        if (!r.ok || !j) throw new Error(`Gmail script HTTP ${r.status} ${(j ? '' : raw).replace(/\s+/g, ' ').slice(0, 120)}`.trim());
        if (j.ok !== true) throw new Error('Gmail script said: ' + String(j.error || 'unknown error').slice(0, 200));
      } finally { clearTimeout(timer); }
    }
  };
}

module.exports = { makeMailer, makeAppsScriptMailer, buildEmail };
