'use strict';
// The public site (https://portal.saraydar.com on Netlify) proxies every request to the Render service.
// Behind that proxy the Host header is the Render address while the browser sends the public Origin.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const db = require('../db');
const { createApp } = require('../app');

const URL_ = process.env.TEST_DATABASE_URL;
const PUBLIC = 'https://portal.saraydar.com';

test('netlify proxy', { skip: !URL_ && 'set TEST_DATABASE_URL to run' }, async t => {
  const pool = new Pool({ connectionString: URL_ });
  await pool.query('drop schema public cascade; create schema public;');
  await db.migrate(pool);
  await db.ensureAdmin(pool, { ADMIN_EMAIL: 'ali@example.com', ADMIN_PASSWORD: 'admin-pass-123' });
  const server = createApp({ pool, jwtSecret: 'x'.repeat(40), corsOrigins: [PUBLIC], env: { APP_URL: PUBLIC, TRUST_PROXY_HOPS: '2' } }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.close(); await pool.end(); });

  // what Netlify forwards: the visitor's address, https, and the browser's own Origin
  const proxied = { 'x-forwarded-for': '203.0.113.5, 198.51.100.7', 'x-forwarded-proto': 'https' };
  const page = await fetch(base + '/login', { headers: proxied });
  const pre = page.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  const csrf = (/name="_csrf" value="([^"]+)"/.exec(await page.text()) || [])[1];
  const post = (origin, extra = {}) => fetch(base + '/login', { method: 'POST', redirect: 'manual',
    headers: { ...proxied, origin, cookie: pre, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ identifier: 'ali@example.com', password: 'admin-pass-123', ...(csrf ? { _csrf: csrf } : {}), ...extra }) });

  await t.test('a form from another site is still refused', async () => {
    const r = await post('https://evil.example');
    assert.equal(r.status, 403);
  });

  await t.test('sign-in through the public address works and stays on it', async () => {
    const r = await post(PUBLIC);
    assert.equal(r.status, 302);
    assert.match(r.headers.get('location'), /^\/(?!\/)/, 'redirects are relative, so the browser stays on portal.saraydar.com');
    const sess = r.headers.getSetCookie().find(c => c.startsWith('sd_sid='));
    assert.ok(sess, 'session cookie set');
    assert.doesNotMatch(sess, /domain=/i, 'cookie belongs to whichever address the browser used');
    assert.match(sess, /httponly/i); assert.match(sess, /samesite=lax/i); assert.match(sess, /secure/i);
    const home = await fetch(base + '/', { headers: { ...proxied, cookie: sess.split(';')[0] }, redirect: 'manual' });
    assert.equal(home.status, 200);
  });

  await t.test('the visitor address behind two proxies is recorded', async () => {
    const ip = (await pool.query("select ip from audit_events where action = 'login' order by id desc limit 1")).rows[0].ip;
    assert.equal(String(ip).replace(/\/32$/, ''), '203.0.113.5');
  });

  await t.test('the tracker API accepts the public origin', async () => {
    const r = await fetch(base + '/api/health', { headers: { origin: PUBLIC } });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('access-control-allow-origin'), PUBLIC);
  });
});
