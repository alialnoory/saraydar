'use strict';
// Default (owner decision 2026-10-23): no two-step verification; sign-in is username/email + password.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const db = require('../db');
const { createApp } = require('../app');
const { client } = require('./helpers');

const URL_ = process.env.TEST_DATABASE_URL;

test('two-step verification is off by default', { skip: !URL_ && 'set TEST_DATABASE_URL to run' }, async t => {
  const pool = new Pool({ connectionString: URL_ });
  await pool.query('drop schema public cascade; create schema public;');
  await db.migrate(pool);
  await db.ensureAdmin(pool, { ADMIN_EMAIL: 'ali@example.com', ADMIN_PASSWORD: 'admin-pass-123' });
  await pool.query("update users set mfa_enabled = true, mfa_secret = 'v1.x.y.z' where email = 'ali@example.com'");  // enrolled earlier
  const server = createApp({ pool, jwtSecret: 'm'.repeat(40), corsOrigins: [], env: {} }).listen(0);
  t.after(async () => { server.close(); await pool.end(); });
  const c = client(`http://127.0.0.1:${server.address().port}`);
  assert.equal((await c.post('/login', { identifier: 'ali@example.com', password: 'admin-pass-123' }, '/login')).location, '/');
  const home = await c.get('/');
  assert.equal(home.status, 200);
  assert.equal((await c.get('/mfa/setup')).location, '/');
  assert.doesNotMatch((await c.get('/account')).text, /Two-step verification/);
  assert.equal((await c.get('/admin/users')).status, 200);
});
