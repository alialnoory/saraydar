'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);

const COLLECTIONS = ['tasks', 'costs', 'payments', 'units', 'risks', 'log', 'meta'];
const ROLES = ['admin', 'editor', 'site', 'viewer'];


async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const N = 16384, r = 8, p = 1;
  const hash = await scrypt(password, salt, 64, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, salt, hash] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const expected = Buffer.from(hash, 'base64');
    const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, { N: +N, r: +r, p: +p });
    return crypto.timingSafeEqual(actual, expected);
  } catch (e) {
    return false;
  }
}

// Applies migrations/NNN_*.sql in order, once each, under an advisory lock.
async function migrate(pool, dir = path.join(__dirname, 'migrations')) {
  const client = await pool.connect();
  try {
    await client.query('select pg_advisory_lock(727001)');
    await client.query('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())');
    const done = new Set((await client.query('select name from schema_migrations')).rows.map(r => r.name));
    const files = fs.readdirSync(dir).filter(f => /^\d{3}_.+\.sql$/.test(f)).sort();
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = fs.readFileSync(path.join(dir, f), 'utf8');
      try {
        await client.query('begin');
        await client.query(sql);
        await client.query('insert into schema_migrations (name) values ($1)', [f]);
        await client.query('commit');
      } catch (e) {
        await client.query('rollback').catch(() => {});
        throw new Error(`Migration ${f} failed: ${e.message}`);
      }
    }
  } finally {
    await client.query('select pg_advisory_unlock(727001)').catch(() => {});
    client.release();
  }
}

// Loads the current project data once, on the first start only.
async function seed(pool, file = path.join(__dirname, 'seed.json')) {
  const done = await pool.query("select 1 from app_state where key = 'seeded'");
  if (done.rowCount) return 0;
  const all = JSON.parse(fs.readFileSync(file, 'utf8'));
  const client = await pool.connect();
  let n = 0;
  try {
    await client.query('begin');
    for (const coll of COLLECTIONS) {
      for (const row of all[coll] || []) {
        const { id, ...data } = row;
        const r = await client.query(
          'insert into records (collection, id, data) values ($1, $2, $3) on conflict do nothing',
          [coll, String(id), data]
        );
        n += r.rowCount;
      }
    }
    await client.query("insert into app_state (key, value) values ('seeded', now()::text) on conflict do nothing");
    await client.query('commit');
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
  return n;
}

// Creates the first administrator from ADMIN_EMAIL / ADMIN_PASSWORD when there are no users yet.
// ADMIN_FORCE_RESET=1 resets that administrator's password to ADMIN_PASSWORD (remove the variable afterwards).
async function ensureAdmin(pool, env = process.env) {
  const email = String(env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = String(env.ADMIN_PASSWORD || '');
  const count = (await pool.query('select count(*)::int as n from users')).rows[0].n;
  if (count === 0) {
    if (!email || password.length < 10) {
      console.warn('No users exist yet. Set ADMIN_EMAIL and an ADMIN_PASSWORD of at least 10 characters, then redeploy.');
      return 'none';
    }
    await pool.query(
      "insert into users (email, name, role, system_role, password_hash) values ($1, 'Administrator', 'admin', 'super_admin', $2)",
      [email, await hashPassword(password)]
    );
    console.log(`Created administrator ${email}`);
    return 'created';
  }
  if (env.ADMIN_FORCE_RESET === '1' && email && password.length >= 10) {
    const r = await pool.query(
      "update users set password_hash = $2, token_version = token_version + 1, active = true, role = 'admin', system_role = 'super_admin', failed_logins = 0, locked_until = null where lower(email) = $1",
      [email, await hashPassword(password)]
    );
    if (r.rowCount) { console.log(`Reset password for ${email}. Remove ADMIN_FORCE_RESET now.`); return 'reset'; }
  }
  // the configured administrator is always the Super Admin
  if (email) await pool.query("update users set system_role = 'super_admin', kind = 'internal' where lower(email) = $1 and system_role <> 'super_admin'", [email]);
  return 'exists';
}

module.exports = { COLLECTIONS, ROLES, migrate, seed, ensureAdmin, hashPassword, verifyPassword };
