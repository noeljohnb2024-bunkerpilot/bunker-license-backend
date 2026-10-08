'use strict';
/* Bunker Pilot license server.
   Public API (used by the app):   POST /api/activate   POST /api/validate   GET /health
   Admin API (used by admin.html): POST /api/admin/generate | list | revoke | restore | reset-device | export | import
   Admin calls need the header  x-admin-password: <ADMIN_PASSWORD>.            */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CODE_PREFIX = 'BUNK';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const MAX_BODY = 10 * 1024;
const MAX_IMPORT_BODY = 2 * 1024 * 1024; // restore uploads
const MAX_IMPORT_ROWS = 1000;            // per request (the admin page sends several requests for big backups)

function genCode() {
  const g = () => Array.from({ length: 4 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('');
  return `${CODE_PREFIX}-${g()}-${g()}`;
}
// Accepts "bunk 7k4q p2xm", "BUNK-7K4Q-P2XM", "bunk7k4qp2xm" ... and returns the canonical form (or '').
function normCode(raw) {
  const s = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.length !== 12 || !s.startsWith(CODE_PREFIX)) return '';
  return `${CODE_PREFIX}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}
const validDevice = d => typeof d === 'string' && /^[A-Za-z0-9_-]{16,80}$/.test(d);
const cleanText = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);

// Failed-attempt limiter (in memory; resets if the server restarts).
function limiter(max, windowMs) {
  const hits = new Map();
  return {
    blocked(key) {
      const h = hits.get(key);
      if (!h) return false;
      if (Date.now() - h.start > windowMs) { hits.delete(key); return false; }
      return h.n >= max;
    },
    fail(key) {
      const now = Date.now();
      const h = hits.get(key);
      if (!h || now - h.start > windowMs) hits.set(key, { n: 1, start: now });
      else h.n++;
      if (hits.size > 5000) for (const [k, v] of hits) if (now - v.start > windowMs) hits.delete(k);
    },
    clear(key) { hits.delete(key); }
  };
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

const publicRow = r => ({
  code: r.code, note: r.note, status: r.status,
  device_label: r.device_label || null, bound: !!r.device_id,
  created_at: r.created_at, activated_at: r.activated_at,
  last_seen_at: r.last_seen_at, revoked_at: r.revoked_at
});

// ---- backup / restore helpers ----
// A backup CSV prefixes risky cells (starting with = + - @) with an apostrophe so Excel never runs them as formulas.
const unquoteCell = v => { const t = String(v == null ? '' : v); return /^'[=+\-@\t\r]/.test(t) ? t.slice(1) : t; };
function parseDate(v) {
  let t = String(v == null ? '' : v).trim();
  if (!t) return { ok: true, value: null };
  t = t.replace(/^(\d{4}-\d{2}-\d{2}) (\d)/, '$1T$2').replace(/([+-]\d\d)$/, '$1:00'); // also reads Supabase's own CSV export
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? { ok: false } : { ok: true, value: new Date(ms).toISOString() };
}
// Returns { row } or { why }.
function cleanImportRow(r) {
  if (!r || typeof r !== 'object') return { why: 'not a row' };
  const code = normCode(r.code);
  if (!code) return { why: 'bad code' };
  const status = String(r.status || 'active').trim().toLowerCase();
  if (status !== 'active' && status !== 'revoked') return { code, why: 'bad status' };
  const dev = String(r.device_id == null ? '' : r.device_id).trim();
  const device_id = unquoteCell(dev);
  if (device_id && !validDevice(device_id)) return { code, why: 'bad device id' };
  const row = {
    code, status, device_id: device_id || null,
    note: cleanText(unquoteCell(r.note), 200),
    device_label: cleanText(unquoteCell(r.device_label), 120) || null
  };
  for (const k of ['created_at', 'activated_at', 'last_seen_at', 'revoked_at']) {
    const d = parseDate(r[k]);
    if (!d.ok) return { code, why: 'bad date in ' + k };
    row[k] = d.value;
  }
  return { row };
}

function createApp({ store, adminPassword, allowedOrigin = '*', publicDir }) {
  const codeFails = limiter(15, 15 * 60 * 1000);
  const adminFails = limiter(8, 15 * 60 * 1000);

  const cors = {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-admin-password',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
  function send(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
  }
  function readJson(req, limit = MAX_BODY) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on('data', c => {
        size += c.length;
        if (size > limit) { reject(Object.assign(new Error('too_large'), { status: 413 })); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        if (!chunks.length) return resolve({});
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(Object.assign(new Error('bad_json'), { status: 400 })); }
      });
      req.on('error', reject);
    });
  }
  const ipOf = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

  async function handleActivate(req, res, body) {
    const ip = ipOf(req);
    if (codeFails.blocked(ip)) return send(res, 429, { ok: false, reason: 'too_many_attempts' });
    const code = normCode(body.code);
    if (!code || !validDevice(body.deviceId)) { codeFails.fail(ip); return send(res, 400, { ok: false, reason: 'invalid_code' }); }
    const row = await store.get(code);
    if (!row) { codeFails.fail(ip); return send(res, 404, { ok: false, reason: 'invalid_code' }); }
    if (row.status === 'revoked') return send(res, 403, { ok: false, reason: 'revoked' });
    const bound = await store.bind(code, body.deviceId, cleanText(body.deviceLabel, 120));
    if (!bound) {
      // active but bound to a different device (or revoked in the meantime)
      const again = await store.get(code);
      if (again && again.status === 'revoked') return send(res, 403, { ok: false, reason: 'revoked' });
      return send(res, 409, { ok: false, reason: 'used_on_other_device' });
    }
    codeFails.clear(ip);
    return send(res, 200, { ok: true, code, activatedAt: bound.activated_at });
  }

  async function handleValidate(req, res, body) {
    const code = normCode(body.code);
    if (!code || !validDevice(body.deviceId)) return send(res, 400, { ok: false, reason: 'invalid_code' });
    const row = await store.get(code);
    if (!row) return send(res, 404, { ok: false, reason: 'invalid_code' });
    if (row.status === 'revoked') return send(res, 403, { ok: false, reason: 'revoked' });
    if (row.device_id !== body.deviceId) return send(res, 403, { ok: false, reason: row.device_id ? 'used_on_other_device' : 'not_activated' });
    await store.touch(code);
    return send(res, 200, { ok: true });
  }

  async function handleAdmin(req, res, action, body) {
    const ip = ipOf(req);
    if (adminFails.blocked(ip)) return send(res, 429, { ok: false, reason: 'too_many_attempts' });
    const pw = req.headers['x-admin-password'];
    if (typeof pw !== 'string' || !safeEqual(pw, adminPassword)) {
      adminFails.fail(ip);
      return send(res, 401, { ok: false, reason: 'bad_password' });
    }
    adminFails.clear(ip);

    if (action === 'check') return send(res, 200, { ok: true });
    if (action === 'list') return send(res, 200, { ok: true, licenses: (await store.list()).map(publicRow) });
    if (action === 'export') {
      // Full-fidelity backup incl. device ids, so a restore keeps every buyer activated. Keep the file private.
      const rows = await store.all();
      return send(res, 200, { ok: true, count: rows.length, licenses: rows.map(r => ({
        code: r.code, note: r.note, status: r.status, device_id: r.device_id || null, device_label: r.device_label || null,
        created_at: r.created_at, activated_at: r.activated_at, last_seen_at: r.last_seen_at, revoked_at: r.revoked_at })) });
    }
    if (action === 'import') {
      if (!Array.isArray(body.rows)) return send(res, 400, { ok: false, reason: 'bad_request' });
      if (body.rows.length > MAX_IMPORT_ROWS) return send(res, 413, { ok: false, reason: 'too_many_rows' });
      const good = new Map(), invalid = []; let duplicates = 0;
      body.rows.forEach((raw, i) => {
        const c = cleanImportRow(raw);
        if (!c.row) { invalid.push({ row: i + 1, code: c.code || null, why: c.why }); return; }
        if (good.has(c.row.code)) { duplicates++; return; }
        good.set(c.row.code, c.row);
      });
      const added = await store.importMany([...good.values()]);
      return send(res, 200, { ok: true, received: body.rows.length, added,
        already_there: good.size - added, duplicates_in_file: duplicates, invalid: invalid.length, invalid_examples: invalid.slice(0, 10) });
    }
    if (action === 'generate') {
      const note = cleanText(body.note, 200);
      for (let i = 0; i < 8; i++) {
        const row = await store.create(genCode(), note);
        if (row) return send(res, 200, { ok: true, license: publicRow(row) });
      }
      return send(res, 500, { ok: false, reason: 'could_not_generate' });
    }
    const code = normCode(body.code);
    if (!code) return send(res, 400, { ok: false, reason: 'invalid_code' });
    const fn = { revoke: 'revoke', restore: 'restore', 'reset-device': 'resetDevice' }[action];
    if (!fn) return send(res, 404, { ok: false, reason: 'not_found' });
    const row = await store[fn](code);
    if (!row) return send(res, 404, { ok: false, reason: 'invalid_code' });
    return send(res, 200, { ok: true, license: publicRow(row) });
  }

  function serveStatic(req, res, pathname) {
    if (!publicDir) return send(res, 404, { ok: false, reason: 'not_found' });
    const name = pathname === '/' || pathname === '/admin' ? 'admin.html' : pathname.replace(/^\/+/, '');
    if (name !== 'admin.html') return send(res, 404, { ok: false, reason: 'not_found' });
    fs.readFile(path.join(publicDir, name), (err, data) => {
      if (err) return send(res, 404, { ok: false, reason: 'not_found' });
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex, nofollow', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer'
      });
      res.end(data);
    });
  }

  return async function handler(req, res) {
    try {
      const url = new URL(req.url, 'http://x');
      const p = url.pathname.replace(/\/+$/, '') || '/';
      if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
      if (req.method === 'GET' && p === '/health') {
        try { await store.ping(); return send(res, 200, { ok: true, db: true }); }
        catch (e) { console.error('health db error:', e.message); return send(res, 503, { ok: false, db: false }); }
      }
      if (req.method === 'GET') return serveStatic(req, res, p);
      if (req.method !== 'POST') return send(res, 405, { ok: false, reason: 'method_not_allowed' });
      const body = await readJson(req, p === '/api/admin/import' ? MAX_IMPORT_BODY : MAX_BODY);
      if (p === '/api/activate') return await handleActivate(req, res, body);
      if (p === '/api/validate') return await handleValidate(req, res, body);
      if (p.startsWith('/api/admin/')) return await handleAdmin(req, res, p.slice('/api/admin/'.length), body);
      return send(res, 404, { ok: false, reason: 'not_found' });
    } catch (e) {
      if (e && e.status) return send(res, e.status, { ok: false, reason: e.message });
      console.error('server error:', e);
      return send(res, 500, { ok: false, reason: 'server_error' });
    }
  };
}

module.exports = { createApp, genCode, normCode, cleanImportRow };

if (require.main === module) {
  const { pgStore } = require('./store');
  const { DATABASE_URL, ADMIN_PASSWORD, ALLOWED_ORIGIN } = process.env;
  const PORT = Number(process.env.PORT) || 3000;
  if (!DATABASE_URL) { console.error('Missing DATABASE_URL environment variable.'); process.exit(1); }
  if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 8) {
    console.error('ADMIN_PASSWORD is missing or shorter than 8 characters.'); process.exit(1);
  }
  const app = createApp({
    store: pgStore(DATABASE_URL), adminPassword: ADMIN_PASSWORD,
    allowedOrigin: ALLOWED_ORIGIN || '*', publicDir: path.join(__dirname, 'public')
  });
  http.createServer(app).listen(PORT, () => console.log(`Bunker license server listening on ${PORT}`));
}
