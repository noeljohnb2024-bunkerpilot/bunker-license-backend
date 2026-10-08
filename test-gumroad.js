'use strict';
// Run with:  node test-gumroad.js   (no database, no internet, no real emails)
const http = require('http');
const assert = require('assert');
const { createApp, productMatches, gumroadFromEnv } = require('./server');
const { makeMailer, makeAppsScriptMailer, buildEmail } = require('./email');

function memStore() {
  const lic = new Map(), sales = new Map();
  return {
    lic, sales,
    async ping() {},
    async create(code, note) { if (lic.has(code)) return null; const r = { code, note, status: 'active', device_id: null }; lic.set(code, r); return { ...r }; },
    async get(code) { const r = lic.get(code); return r ? { ...r } : null; },
    async revoke(code) { const r = lic.get(code); if (!r) return null; r.status = 'revoked'; return { ...r }; },
    async setNote(code, note) { lic.get(code).note = note; },
    async claimSale(id, email, name) { if (sales.has(id)) return null; const r = { sale_id: id, email, buyer_name: name, code: null, emailed_at: null, email_error: null, refunded_at: null }; sales.set(id, r); return { ...r }; },
    async getSale(id) { const r = sales.get(id); return r ? { ...r } : null; },
    async attachCode(id, code) { sales.get(id).code = code; },
    async markEmailed(id) { const r = sales.get(id); r.emailed_at = new Date(); r.email_error = null; },
    async markEmailFailed(id, e) { sales.get(id).email_error = e; },
    async markRefunded(id) { sales.get(id).refunded_at = new Date(); }
  };
}

const TOKEN = 'a-long-secret-token-1234';
const store = memStore();
const sent = [], relayed = []; let failMail = false;
const mailer = { async sendCode(m) { if (failMail) throw new Error('Resend 403 domain not verified'); sent.push(m); } };
const server = http.createServer(createApp({ store, adminPassword: 'x'.repeat(10),
  gumroad: { token: TOKEN, product: 'bunkerpilot', mailer, relay: async (raw, ct) => { relayed.push({ raw, ct }); } } }));
const noGumroadServer = http.createServer(createApp({ store, adminPassword: 'x'.repeat(10) }));

let base, base2, passed = 0;
const post = (b, url, form, ct = 'application/x-www-form-urlencoded') => new Promise((resolve, reject) => {
  const data = typeof form === 'string' ? form : new URLSearchParams(form).toString();
  const req = http.request(b + url, { method: 'POST', headers: { 'Content-Type': ct } }, res => { let s = ''; res.on('data', c => s += c); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(s || '{}') })); });
  req.on('error', reject); req.end(data);
});
const ping = (form, token = TOKEN) => post(base, '/api/gumroad?token=' + token, form);
const sale = (o = {}) => ({ sale_id: 'S1', email: 'Buyer@Example.com', full_name: 'Juan Dela Cruz', product_permalink: 'bunkerpilot', refunded: 'false', ...o });
async function t(name, fn) { try { await fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; } }

(async () => {
  await new Promise(r => server.listen(0, r)); base = 'http://127.0.0.1:' + server.address().port;
  await new Promise(r => noGumroadServer.listen(0, r)); base2 = 'http://127.0.0.1:' + noGumroadServer.address().port;

  await t('product matching', () => {
    assert(productMatches({ product_permalink: 'bunkerpilot' }, 'bunkerpilot'));
    assert(productMatches({ product_permalink: 'https://x.gumroad.com/l/BunkerPilot' }, 'bunkerpilot'));
    assert(productMatches({ short_product_id: 'AbC123==' }, 'abc123=='));
    assert(!productMatches({ product_permalink: 'eorbmarine' }, 'bunkerpilot'));
    assert(productMatches({ product_permalink: 'anything' }, ''));
  });
  await t('gumroad endpoint is off when not configured', async () => { assert.strictEqual((await post(base2, '/api/gumroad?token=x', sale())).status, 404); });
  await t('wrong or missing token is refused, no code made', async () => {
    assert.strictEqual((await ping(sale(), 'nope')).status, 401);
    assert.strictEqual((await post(base, '/api/gumroad', sale())).status, 401);
    assert.strictEqual(store.lic.size, 0);
  });
  let code;
  await t('a sale creates a code, emails the buyer once, and records the sale', async () => {
    const r = await ping(sale()); assert.strictEqual(r.status, 200); assert(r.json.emailed);
    assert.strictEqual(sent.length, 1); assert.strictEqual(sent[0].to, 'buyer@example.com'); assert.strictEqual(sent[0].name, 'Juan Dela Cruz');
    code = sent[0].code; assert(/^BUNK-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code));
    assert.strictEqual(store.lic.get(code).status, 'active'); assert(store.lic.get(code).note.includes('buyer@example.com'));
    assert(store.sales.get('S1').emailed_at);
  });
  await t('the same sale arriving again does not make a second code or email', async () => {
    const r = await ping(sale()); assert.strictEqual(r.status, 200); assert(r.json.duplicate);
    assert.strictEqual(sent.length, 1); assert.strictEqual(store.lic.size, 1);
  });
  await t('json pings are accepted too', async () => {
    const r = await post(base, '/api/gumroad?token=' + TOKEN, JSON.stringify(sale({ sale_id: 'S-JSON' })), 'application/json');
    assert.strictEqual(r.status, 200); assert.strictEqual(sent.length, 2);
  });
  await t('email failure: code kept, sale flagged, Gumroad told to retry; the retry then succeeds with the SAME code', async () => {
    failMail = true;
    const r = await ping(sale({ sale_id: 'S2', email: 'two@example.com' })); assert.strictEqual(r.status, 500); assert.strictEqual(r.json.reason, 'email_failed');
    const s = store.sales.get('S2'); assert(s.code && s.email_error && !s.emailed_at);
    assert(store.lic.get(s.code).note.startsWith('EMAIL NOT SENT'));
    failMail = false; const before = store.lic.size;
    const r2 = await ping(sale({ sale_id: 'S2', email: 'two@example.com' })); assert.strictEqual(r2.status, 200);
    assert.strictEqual(store.lic.size, before); assert.strictEqual(sent[sent.length - 1].code, s.code);
    assert(!store.lic.get(s.code).note.startsWith('EMAIL NOT SENT')); assert(store.sales.get('S2').emailed_at);
  });
  await t('other products are passed on untouched (e-ORB) and make no code', async () => {
    const n = store.lic.size; const form = sale({ sale_id: 'E1', product_permalink: 'eorbmarine' });
    const r = await ping(form); assert.strictEqual(r.status, 200); assert(r.json.relayed);
    assert.strictEqual(relayed.length, 1); assert(relayed[0].raw.includes('sale_id=E1')); assert(/urlencoded/.test(relayed[0].ct));
    assert.strictEqual(store.lic.size, n);
  });
  await t('a refund revokes the code and sends no email', async () => {
    const n = sent.length; const r = await ping(sale({ refunded: 'true' }));
    assert.strictEqual(r.status, 200); assert(r.json.refunded);
    assert.strictEqual(store.lic.get(code).status, 'revoked'); assert(store.sales.get('S1').refunded_at); assert.strictEqual(sent.length, n);
  });
  await t('refund for an unknown sale is harmless', async () => { const r = await ping(sale({ sale_id: 'NOPE', refunded: 'true' })); assert.strictEqual(r.status, 200); assert.strictEqual(r.json.refunded, false); });
  await t('junk pings (no email / no sale id) get 200 and do nothing', async () => {
    const n = store.lic.size;
    assert.strictEqual((await ping(sale({ sale_id: 'J1', email: 'not-an-email' }))).json.ignored, 'bad_email');
    assert.strictEqual((await ping({ email: 'a@b.co', product_permalink: 'bunkerpilot' })).json.ignored, 'no_sale_id');
    assert.strictEqual(store.lic.size, n);
  });
  await t('guessing the token is rate limited', async () => {
    let last; for (let i = 0; i < 12; i++) last = await ping(sale(), 'guess' + i); assert.strictEqual(last.status, 429);
  });

  // ---- email module ----
  await t('email text carries the code and link; names are HTML-escaped', () => {
    const m = buildEmail({ name: '<b>Ann</b> Lee', code: 'BUNK-AAAA-BBBB', appUrl: 'https://app.example', contact: 'WhatsApp +63 900' });
    assert(m.html.includes('BUNK-AAAA-BBBB') && m.text.includes('https://app.example') && m.text.includes('WhatsApp +63 900'));
    assert(!m.html.includes('<b>Ann</b>') && m.html.includes('&lt;b&gt;Ann&lt;/b&gt;'));
    assert(buildEmail({ name: '', code: 'C', appUrl: 'u' }).text.startsWith('Hello,'));
  });
  await t('mailer calls Resend correctly and reports refusals', async () => {
    let seen; const ok = makeMailer({ apiKey: 're_test', from: 'Bunker Pilot <hi@x.com>', replyTo: 'me@x.com', appUrl: 'https://app', fetchImpl: async (u, o) => { seen = { u, o }; return { ok: true }; } });
    await ok.sendCode({ to: 'b@c.de', name: 'B', code: 'BUNK-AAAA-BBBB' });
    assert.strictEqual(seen.u, 'https://api.resend.com/emails'); assert.strictEqual(seen.o.headers.Authorization, 'Bearer re_test');
    const body = JSON.parse(seen.o.body); assert.deepStrictEqual(body.to, ['b@c.de']); assert.strictEqual(body.from, 'Bunker Pilot <hi@x.com>'); assert.strictEqual(body.reply_to, 'me@x.com');
    const bad = makeMailer({ apiKey: 'k', from: 'f', appUrl: 'u', fetchImpl: async () => ({ ok: false, status: 403, text: async () => 'domain not verified' }) });
    await assert.rejects(() => bad.sendCode({ to: 'b@c.de', name: '', code: 'C' }), /403/);
  });

  // ---- free Gmail script mailer + settings check ----
  await t('gmail script mailer: sends the right request and accepts {ok:true}', async () => {
    let seen; const m = makeAppsScriptMailer({ url: 'https://script.google.com/macros/s/ABC/exec', secret: 'shh', fromName: 'Bunker Pilot', replyTo: 'me@x.com', appUrl: 'https://app', contact: 'WA',
      fetchImpl: async (u, o) => { seen = { u, o }; return { ok: true, status: 200, text: async () => '{"ok":true}' }; } });
    await m.sendCode({ to: 'b@c.de', name: 'Ann', code: 'BUNK-AAAA-BBBB' });
    assert.strictEqual(seen.u, 'https://script.google.com/macros/s/ABC/exec'); assert.strictEqual(seen.o.method, 'POST'); assert.strictEqual(seen.o.redirect, 'follow');
    const b = JSON.parse(seen.o.body); assert.strictEqual(b.secret, 'shh'); assert.strictEqual(b.to, 'b@c.de'); assert(b.html.includes('BUNK-AAAA-BBBB')); assert.strictEqual(b.fromName, 'Bunker Pilot');
  });
  await t('gmail script mailer: script errors, bad secret, HTML error pages and HTTP errors all fail loudly', async () => {
    const mk = res => makeAppsScriptMailer({ url: 'u', secret: 's', appUrl: 'a', fetchImpl: async () => res });
    await assert.rejects(() => mk({ ok: true, status: 200, text: async () => '{"ok":false,"error":"bad_secret"}' }).sendCode({ to: 'b@c.de', name: '', code: 'C' }), /bad_secret/);
    await assert.rejects(() => mk({ ok: true, status: 200, text: async () => '<html>Sign in</html>' }).sendCode({ to: 'b@c.de', name: '', code: 'C' }), /Gmail script HTTP/);
    await assert.rejects(() => mk({ ok: false, status: 500, text: async () => '{"ok":false}' }).sendCode({ to: 'b@c.de', name: '', code: 'C' }), /HTTP 500/);
  });
  await t('settings check: off, Resend, Gmail script, and the mistakes people make', () => {
    const noRelay = { relayFactory: u => ({ url: u }) };
    assert.strictEqual(gumroadFromEnv({}), null);
    assert.throws(() => gumroadFromEnv({ GUMROAD_TOKEN: 'short' }), /at least 16/);
    assert.throws(() => gumroadFromEnv({ GUMROAD_TOKEN: 'a'.repeat(20), APP_URL: 'https://a' }), /RESEND_API_KEY, MAIL_FROM/);
    assert.throws(() => gumroadFromEnv({ GUMROAD_TOKEN: 'a'.repeat(20), APP_URL: 'https://a', APPS_SCRIPT_URL: 'https://script.google.com/x' }), /APPS_SCRIPT_SECRET/);
    assert.throws(() => gumroadFromEnv({ GUMROAD_TOKEN: 'a'.repeat(20), APP_URL: 'https://a', APPS_SCRIPT_URL: 'https://evil.example/x', APPS_SCRIPT_SECRET: 's'.repeat(12) }), /script\.google\.com/);
    const g = gumroadFromEnv({ GUMROAD_TOKEN: 'a'.repeat(20), APP_URL: 'https://a', APPS_SCRIPT_URL: 'https://script.google.com/macros/s/X/exec', APPS_SCRIPT_SECRET: 's'.repeat(12), GUMROAD_PRODUCT: 'Bunkerpilot', GUMROAD_FORWARD_URL: 'https://eorb/api/gumroad' }, noRelay);
    assert.strictEqual(g.mailerName, 'Gmail script'); assert.strictEqual(g.product, 'Bunkerpilot'); assert.deepStrictEqual(g.relay, { url: 'https://eorb/api/gumroad' });
    const r = gumroadFromEnv({ GUMROAD_TOKEN: 'a'.repeat(20), APP_URL: 'https://a', RESEND_API_KEY: 're_x', MAIL_FROM: 'B <a@b.co>' });
    assert.strictEqual(r.mailerName, 'Resend'); assert.strictEqual(r.relay, null);
  });

  server.close(); noGumroadServer.close(); console.log(`\n${passed} checks passed${process.exitCode ? ', SOME FAILED' : ''}`);
})();
