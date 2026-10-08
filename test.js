'use strict';
// Run with:  node test.js     (no database or internet needed)
const http = require('http');
const path = require('path');
const assert = require('assert');
const { createApp, genCode, normCode } = require('./server');

function memStore() {
  const rows = new Map();
  return {
    async ping() {},
    async create(code, note) { if (rows.has(code)) return null; const r = { code, note, status: 'active', device_id: null, device_label: null, created_at: new Date(), activated_at: null, last_seen_at: null, revoked_at: null }; rows.set(code, r); return { ...r }; },
    async get(code) { const r = rows.get(code); return r ? { ...r } : null; },
    async bind(code, dev, label) { const r = rows.get(code); if (!r || r.status !== 'active' || (r.device_id && r.device_id !== dev)) return null; r.device_id = dev; r.device_label = label || r.device_label; r.activated_at = r.activated_at || new Date(); r.last_seen_at = new Date(); return { ...r }; },
    async touch(code) { rows.get(code).last_seen_at = new Date(); },
    async revoke(code) { const r = rows.get(code); if (!r) return null; r.status = 'revoked'; r.revoked_at = new Date(); return { ...r }; },
    async restore(code) { const r = rows.get(code); if (!r) return null; r.status = 'active'; r.revoked_at = null; return { ...r }; },
    async resetDevice(code) { const r = rows.get(code); if (!r) return null; r.device_id = null; r.device_label = null; r.activated_at = null; return { ...r }; },
    async list() { return [...rows.values()].map(r => ({ ...r })); },
    async all() { return [...rows.values()].map(r => ({ ...r })); },
    async importMany(list) { let n = 0; for (const r of list) { if (rows.has(r.code)) continue; rows.set(r.code, { created_at: new Date(), activated_at: null, last_seen_at: null, revoked_at: null, ...r, created_at: r.created_at ? new Date(r.created_at) : new Date() }); n++; } return n; }
  };
}

const PW = 'test-password-123';
const server = http.createServer(createApp({ store: memStore(), adminPassword: PW, publicDir: path.join(__dirname, 'public') }));
let base;
const call = (method, url, body, headers = {}) => new Promise((resolve, reject) => {
  const data = body === undefined ? null : JSON.stringify(body);
  const req = http.request(base + url, { method, headers: { 'Content-Type': 'application/json', ...headers } }, res => {
    let s = ''; res.on('data', c => s += c); res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch {} resolve({ status: res.statusCode, json: j, text: s, headers: res.headers }); });
  });
  req.on('error', reject); if (data) req.write(data); req.end();
});
const admin = (action, body) => call('POST', '/api/admin/' + action, body || {}, { 'x-admin-password': PW });
const DEV1 = 'device-aaaaaaaaaaaaaaaa1', DEV2 = 'device-bbbbbbbbbbbbbbbb2';
let passed = 0;
async function t(name, fn) { try { await fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; } }

(async () => {
  await new Promise(r => server.listen(0, r)); base = 'http://127.0.0.1:' + server.address().port;

  await t('code format and normalisation', () => {
    for (let i = 0; i < 200; i++) assert(/^BUNK-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(genCode()));
    assert.strictEqual(normCode('bunk 7k4q p2xm'), 'BUNK-7K4Q-P2XM');
    assert.strictEqual(normCode('BUNK7K4QP2XM'), 'BUNK-7K4Q-P2XM');
    assert.strictEqual(normCode('EORB-7K4Q-P2XM'), '');
    assert.strictEqual(normCode(''), '');
  });
  await t('health works', async () => { const r = await call('GET', '/health'); assert.strictEqual(r.status, 200); assert(r.json.ok); });
  await t('admin page is served, other files are not', async () => {
    const r = await call('GET', '/admin.html'); assert.strictEqual(r.status, 200); assert(r.text.includes('License admin'));
    assert.strictEqual((await call('GET', '/server.js')).status, 404);
    assert.strictEqual((await call('GET', '/../server.js')).status, 404);
  });
  await t('CORS preflight', async () => { const r = await call('OPTIONS', '/api/activate'); assert.strictEqual(r.status, 204); assert.strictEqual(r.headers['access-control-allow-origin'], '*'); });
  await t('admin rejects missing / wrong password', async () => {
    assert.strictEqual((await call('POST', '/api/admin/list', {})).status, 401);
    assert.strictEqual((await call('POST', '/api/admin/list', {}, { 'x-admin-password': 'nope' })).status, 401);
  });

  let code;
  await t('admin generates a code', async () => {
    const r = await admin('generate', { note: 'Juan FB' }); assert.strictEqual(r.status, 200);
    code = r.json.license.code; assert(/^BUNK-/.test(code)); assert.strictEqual(r.json.license.note, 'Juan FB');
  });
  await t('activation: unknown code', async () => { const r = await call('POST', '/api/activate', { code: 'BUNK-AAAA-BBBB', deviceId: DEV1 }); assert.strictEqual(r.status, 404); assert.strictEqual(r.json.reason, 'invalid_code'); });
  await t('activation: bad device id', async () => { const r = await call('POST', '/api/activate', { code, deviceId: 'x' }); assert.strictEqual(r.status, 400); });
  await t('validate before activation fails', async () => { const r = await call('POST', '/api/validate', { code, deviceId: DEV1 }); assert.strictEqual(r.status, 403); assert.strictEqual(r.json.reason, 'not_activated'); });
  await t('activation succeeds (lower case, no dashes)', async () => { const r = await call('POST', '/api/activate', { code: code.toLowerCase().replace(/-/g, ' '), deviceId: DEV1, deviceLabel: 'Android phone' }); assert.strictEqual(r.status, 200); assert.strictEqual(r.json.code, code); });
  await t('re-activating the same device is fine', async () => { assert.strictEqual((await call('POST', '/api/activate', { code, deviceId: DEV1 })).status, 200); });
  await t('a second device is refused', async () => { const r = await call('POST', '/api/activate', { code, deviceId: DEV2 }); assert.strictEqual(r.status, 409); assert.strictEqual(r.json.reason, 'used_on_other_device'); });
  await t('validate: right device ok, wrong device refused', async () => {
    assert.strictEqual((await call('POST', '/api/validate', { code, deviceId: DEV1 })).status, 200);
    const r = await call('POST', '/api/validate', { code, deviceId: DEV2 }); assert.strictEqual(r.status, 403); assert.strictEqual(r.json.reason, 'used_on_other_device');
  });
  await t('list shows device label, never the device id', async () => {
    const r = await admin('list'); const l = r.json.licenses.find(x => x.code === code);
    assert.strictEqual(l.bound, true); assert.strictEqual(l.device_label, 'Android phone'); assert(!('device_id' in l));
  });
  await t('revoke kills activation and validation', async () => {
    assert.strictEqual((await admin('revoke', { code })).status, 200);
    const v = await call('POST', '/api/validate', { code, deviceId: DEV1 }); assert.strictEqual(v.status, 403); assert.strictEqual(v.json.reason, 'revoked');
    const a = await call('POST', '/api/activate', { code, deviceId: DEV1 }); assert.strictEqual(a.json.reason, 'revoked');
  });
  await t('restore brings it back', async () => { await admin('restore', { code }); assert.strictEqual((await call('POST', '/api/validate', { code, deviceId: DEV1 })).status, 200); });
  await t('reset-device lets a new device take the code', async () => {
    await admin('reset-device', { code });
    assert.strictEqual((await call('POST', '/api/validate', { code, deviceId: DEV1 })).status, 403);
    assert.strictEqual((await call('POST', '/api/activate', { code, deviceId: DEV2 })).status, 200);
    assert.strictEqual((await call('POST', '/api/activate', { code, deviceId: DEV1 })).status, 409);
  });
  await t('bad JSON and oversized bodies are rejected', async () => {
    const r = await new Promise(res => { const q = http.request(base + '/api/activate', { method: 'POST' }, x => { let s = ''; x.on('data', c => s += c); x.on('end', () => res({ status: x.statusCode })); }); q.write('{nope'); q.end(); });
    assert.strictEqual(r.status, 400);
    const big = await call('POST', '/api/activate', { code: 'x'.repeat(20000) }).catch(() => ({ status: 413 }));
    assert([413, 400].includes(big.status));
  });

  // ---- backup / restore ----
  let backup;
  await t('export returns every code incl. device id (full backup)', async () => {
    const r = await admin('export'); assert.strictEqual(r.status, 200); backup = r.json.licenses;
    const l = backup.find(x => x.code === code); assert(l); assert.strictEqual(l.device_id, DEV2); assert.strictEqual(r.json.count, backup.length);
  });
  await t('export / import need the admin password', async () => {
    assert.strictEqual((await call('POST', '/api/admin/export', {}, { 'x-admin-password': 'nope' })).status, 401);
    assert.strictEqual((await call('POST', '/api/admin/import', { rows: [] }, { 'x-admin-password': 'nope' })).status, 401);
  });
  await t('restore into a brand-new empty database keeps buyers activated', async () => {
    const second = http.createServer(createApp({ store: memStore(), adminPassword: PW })); await new Promise(r => second.listen(0, r));
    const b2 = 'http://127.0.0.1:' + second.address().port;
    const c2 = (url, body, h = {}) => new Promise((resolve, reject) => { const d = JSON.stringify(body); const q = http.request(b2 + url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...h } }, x => { let z = ''; x.on('data', c => z += c); x.on('end', () => resolve({ status: x.statusCode, json: JSON.parse(z) })); }); q.on('error', reject); q.end(d); });
    const imp = await c2('/api/admin/import', { rows: backup }, { 'x-admin-password': PW });
    assert.strictEqual(imp.status, 200); assert.strictEqual(imp.json.added, backup.length); assert.strictEqual(imp.json.invalid, 0);
    assert.strictEqual((await c2('/api/validate', { code, deviceId: DEV2 })).status, 200);           // same phone still fine
    assert.strictEqual((await c2('/api/activate', { code, deviceId: DEV1 })).status, 409);           // other phone still refused
    const again = await c2('/api/admin/import', { rows: backup }, { 'x-admin-password': PW });         // running it twice changes nothing
    assert.strictEqual(again.json.added, 0); assert.strictEqual(again.json.already_there, backup.length);
    second.close();
  });
  await t('import never overwrites a code that already exists', async () => {
    const r = await admin('import', { rows: [{ code, status: 'revoked', device_id: '', note: 'HACK' }] });
    assert.strictEqual(r.json.added, 0); assert.strictEqual(r.json.already_there, 1);
    const l = (await admin('list')).json.licenses.find(x => x.code === code); assert.strictEqual(l.status, 'active'); assert.notStrictEqual(l.note, 'HACK');
  });
  await t('import accepts CSV-style text values, Supabase dates, odd code spacing; reports bad rows', async () => {
    const r = await admin('import', { rows: [
      { code: 'bunk 2222 3333', note: "'=HYPERLINK(1)", status: '', device_id: '', device_label: '', created_at: '2026-10-07 13:27:00.123+00', activated_at: '', last_seen_at: '', revoked_at: '' },
      { code: 'BUNK-4444-5555', status: 'weird' },
      { code: 'nope' },
      { code: 'BUNK-6666-7777', created_at: 'not a date' },
      { code: 'BUNK-8888-9999', device_id: 'x' },
      { code: 'BUNK-2222-3333', note: 'dup in file' }
    ] });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.json.added, 1); assert.strictEqual(r.json.invalid, 4); assert.strictEqual(r.json.duplicates_in_file, 1);
    assert(r.json.invalid_examples.every(e => e.why));
    const l = (await admin('list')).json.licenses.find(x => x.code === 'BUNK-2222-3333');
    assert.strictEqual(l.note, '=HYPERLINK(1)'); assert.strictEqual(l.status, 'active'); assert.strictEqual(new Date(l.created_at).toISOString(), '2026-10-07T13:27:00.123Z');
  });
  await t('import: bad request and too many rows are rejected', async () => {
    assert.strictEqual((await admin('import', { rows: 'x' })).status, 400);
    const r = await admin('import', { rows: Array.from({ length: 1001 }, () => ({ code: 'BUNK-AAAA-BBBB' })) }); assert.strictEqual(r.status, 413);
  });
  await t('a 1000-row restore body is accepted (larger than the normal 10 KB limit)', async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({ code: 'BUNK-' + String(1000 + i).replace(/[01]/g, '2').padStart(4, '2') + '-ABCD', note: 'row ' + i, device_label: 'Android phone ' + i }));
    const r = await admin('import', { rows }); assert.strictEqual(r.status, 200); assert(r.json.added > 0);
  });
  await t('wrong-guess limiter blocks after 15 bad codes', async () => {
    let last; for (let i = 0; i < 17; i++) last = await call('POST', '/api/activate', { code: 'BUNK-ZZZZ-ZZZ' + (i % 9 + 2), deviceId: DEV1 });
    assert.strictEqual(last.status, 429);
  });
  await t('admin password limiter blocks after 8 bad tries', async () => {
    let last; for (let i = 0; i < 10; i++) last = await call('POST', '/api/admin/list', {}, { 'x-admin-password': 'bad' + i });
    assert.strictEqual(last.status, 429);
  });

  server.close(); console.log(`\n${passed} checks passed${process.exitCode ? ', SOME FAILED' : ''}`);
})();
