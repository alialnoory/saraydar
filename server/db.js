'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);

const COLLECTIONS = ['tasks', 'costs', 'payments', 'units', 'risks', 'log', 'meta'];
const ROLES = ['admin', 'editor', 'site', 'viewer'];

const SCHEMA = `
create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  email         text not null,
  name          text not null default '',
  role          text not null default 'viewer' check (role in ('admin', 'editor', 'site', 'viewer')),
  password_hash text not null,
  active        boolean not null default true,
  token_version integer not null default 0,
  created_at    timestamptz not null default now()
);
create unique index if not exists users_email_key on users (lower(email));

create table if not exists records (
  collection text not null check (collection in ('tasks', 'costs', 'payments', 'units', 'risks', 'log', 'meta')),
  id         text not null,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid references users(id) on delete set null,
  primary key (collection, id)
);

create table if not exists record_history (
  history_id       bigint generated always as identity primary key,
  collection       text not null,
  id               text not null,
  action           text not null,
  old_data         jsonb,
  new_data         jsonb,
  changed_by       uuid references users(id) on delete set null,
  changed_by_email text,
  changed_at       timestamptz not null default now()
);
create index if not exists record_history_changed_at on record_history (changed_at desc);

create table if not exists app_state (
  key   text primary key,
  value text not null
);
`;

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

async function migrate(pool) {
  await pool.query(SCHEMA);
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
      "insert into users (email, name, role, password_hash) values ($1, 'Administrator', 'admin', $2)",
      [email, await hashPassword(password)]
    );
    console.log(`Created administrator ${email}`);
    return 'created';
  }
  if (env.ADMIN_FORCE_RESET === '1' && email && password.length >= 10) {
    const r = await pool.query(
      "update users set password_hash = $2, token_version = token_version + 1, active = true, role = 'admin' where lower(email) = $1",
      [email, await hashPassword(password)]
    );
    if (r.rowCount) { console.log(`Reset password for ${email}. Remove ADMIN_FORCE_RESET now.`); return 'reset'; }
  }
  return 'exists';
}

module.exports = { COLLECTIONS, ROLES, migrate, seed, ensureAdmin, hashPassword, verifyPassword };
