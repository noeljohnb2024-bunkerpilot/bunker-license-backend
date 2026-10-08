'use strict';
// Database layer. server.js only talks to a "store" with these methods,
// so tests can swap in an in-memory store.
const { Pool } = require('pg');

function pgStore(connectionString) {
  const pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
    max: 4,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 15000
  });
  pool.on('error', e => console.error('pg pool error:', e.message));
  const q = (text, params) => pool.query(text, params);
  return {
    async ping() { await q('select 1'); },
    async create(code, note) {
      const r = await q(
        'insert into licenses(code, note) values($1,$2) on conflict (code) do nothing returning *',
        [code, note]
      );
      return r.rows[0] || null; // null = code already existed, caller retries
    },
    async get(code) {
      const r = await q('select * from licenses where code=$1', [code]);
      return r.rows[0] || null;
    },
    // Atomic: binds the device only if the code is active and unbound (or already bound to this device).
    async bind(code, deviceId, label) {
      const r = await q(
        `update licenses
            set device_id=$2,
                device_label=coalesce(nullif($3,''), device_label),
                activated_at=coalesce(activated_at, now()),
                last_seen_at=now()
          where code=$1 and status='active' and (device_id is null or device_id=$2)
          returning *`,
        [code, deviceId, label || '']
      );
      return r.rows[0] || null;
    },
    async touch(code) { await q('update licenses set last_seen_at=now() where code=$1', [code]); },
    async revoke(code) {
      const r = await q("update licenses set status='revoked', revoked_at=now() where code=$1 returning *", [code]);
      return r.rows[0] || null;
    },
    async restore(code) {
      const r = await q("update licenses set status='active', revoked_at=null where code=$1 returning *", [code]);
      return r.rows[0] || null;
    },
    async resetDevice(code) {
      const r = await q(
        'update licenses set device_id=null, device_label=null, activated_at=null where code=$1 returning *',
        [code]
      );
      return r.rows[0] || null;
    },
    async list() {
      const r = await q('select * from licenses order by created_at desc limit 2000');
      return r.rows;
    },
    // Full dump for backups (no row limit).
    async all() {
      const r = await q('select * from licenses order by created_at desc');
      return r.rows;
    },
    // Restore: inserts rows whose code is not in the table yet; existing codes are never touched.
    // rows = [{code,note,status,device_id,device_label,created_at,activated_at,last_seen_at,revoked_at}, ...]
    async importMany(rows) {
      if (!rows.length) return 0;
      const col = k => rows.map(r => r[k] == null ? null : r[k]);
      const r = await q(
        `insert into licenses(code,note,status,device_id,device_label,created_at,activated_at,last_seen_at,revoked_at)
         select code,note,status,device_id,device_label,coalesce(created_at,now()),activated_at,last_seen_at,revoked_at
           from unnest($1::text[],$2::text[],$3::text[],$4::text[],$5::text[],$6::timestamptz[],$7::timestamptz[],$8::timestamptz[],$9::timestamptz[])
             as t(code,note,status,device_id,device_label,created_at,activated_at,last_seen_at,revoked_at)
         on conflict (code) do nothing
         returning code`,
        [col('code'), col('note'), col('status'), col('device_id'), col('device_label'),
         col('created_at'), col('activated_at'), col('last_seen_at'), col('revoked_at')]
      );
      return r.rowCount;
    }
  };
}

module.exports = { pgStore };
