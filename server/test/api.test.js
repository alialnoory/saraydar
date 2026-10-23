'use strict';
// Needs a Postgres: TEST_DATABASE_URL=postgres://user:pass@host:port/db npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const db = require('../db');
const { createApp } = require('../app');

const URL = process.env.TEST_DATABASE_URL;
const ORIGIN = 'https://saraydar.netlify.app';

test('API', { skip: !URL && 'set TEST_DATABASE_URL to run' }, async t => {
  const pool = new Pool({ connectionString: URL });
  await pool.query('drop schema public cascade; create schema public;');
  await db.migrate(pool);

  const loaded = await db.seed(pool);
  const server = createApp({ pool, jwtSecret: 'x'.repeat(40), corsOrigins: [ORIGIN] }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.close(); await pool.end(); });

  const call = async (method, path, { token, body, headers } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    let json = null; try { json = await res.json(); } catch (e) {}
    return { status: res.status, json, res };
  };
  const login = async (email, password) => (await call('POST', '/api/auth/login', { body: { email, password } }));

  await t.test('starting data loads once', async () => {
    assert.equal(loaded, 59);
    assert.equal(await db.seed(pool), 0);
  });

  await t.test('first administrator is created from settings, once', async () => {
    assert.equal(await db.ensureAdmin(pool, {}), 'none');
    assert.equal(await db.ensureAdmin(pool, { ADMIN_EMAIL: 'Ali@Example.com', ADMIN_PASSWORD: 'correct horse 1' }), 'created');
    assert.equal(await db.ensureAdmin(pool, { ADMIN_EMAIL: 'other@example.com', ADMIN_PASSWORD: 'another long one' }), 'exists');
  });

  let admin;
  await t.test('sign in', async () => {
    assert.equal((await login('ali@example.com', 'wrong password')).status, 401);
    assert.equal((await login('nobody@example.com', 'correct horse 1')).status, 401);
    assert.equal((await login('', '')).status, 400);
    const ok = await login('ALI@example.com', 'correct horse 1');
    assert.equal(ok.status, 200);
    assert.equal(ok.json.user.role, 'admin');
    assert.ok(!('password_hash' in ok.json.user));
    admin = ok.json.token;
    assert.equal((await call('GET', '/api/auth/me', { token: admin })).json.user.email, 'ali@example.com');
  });

  await t.test('records need a valid sign-in', async () => {
    assert.equal((await call('GET', '/api/records')).status, 401);
    assert.equal((await call('GET', '/api/records', { token: 'not-a-token' })).status, 401);
    const r = await call('GET', '/api/records', { token: admin });
    assert.equal(r.status, 200);
    assert.equal(r.json.tasks.length, 36);
    assert.equal(r.json.units.length, 4);
    assert.equal(r.json.meta[0].id, 'project');
    assert.equal(r.json.tasks[0].id.startsWith('t'), true);
  });

  const mk = async (role) => {
    const email = `${role}@example.com`;
    const c = await call('POST', '/api/users', { token: admin, body: { email, name: role, role, password: 'temp-pass-1' } });
    assert.equal(c.status, 201, JSON.stringify(c.json));
    const l = await login(email, 'temp-pass-1');
    assert.equal(l.status, 200);
    return { id: c.json.id, token: l.json.token };
  };
  let editor, site, viewer;
  await t.test('administrator adds users', async () => {
    editor = await mk('editor'); site = await mk('site'); viewer = await mk('viewer');
    assert.equal((await call('POST', '/api/users', { token: admin, body: { email: 'EDITOR@example.com', role: 'viewer', password: 'temp-pass-1' } })).status, 409);
    assert.equal((await call('POST', '/api/users', { token: admin, body: { email: 'bad', role: 'viewer', password: 'temp-pass-1' } })).status, 400);
    assert.equal((await call('POST', '/api/users', { token: admin, body: { email: 'a@b.co', role: 'boss', password: 'temp-pass-1' } })).status, 400);
    assert.equal((await call('POST', '/api/users', { token: admin, body: { email: 'a@b.co', role: 'viewer', password: 'short' } })).status, 400);
    assert.equal((await call('GET', '/api/users', { token: editor.token })).status, 403);
    assert.equal((await call('GET', '/api/users', { token: admin })).json.length, 4);
  });

  await t.test('viewer reads but cannot change anything', async () => {
    assert.equal((await call('GET', '/api/records', { token: viewer.token })).status, 200);
    assert.equal((await call('POST', '/api/records/tasks', { token: viewer.token, body: { title: 'x' } })).status, 403);
    assert.equal((await call('PUT', '/api/records/tasks/t01', { token: viewer.token, body: { title: 'x' } })).status, 403);
    assert.equal((await call('DELETE', '/api/records/tasks/t01', { token: viewer.token })).status, 403);
    assert.equal((await call('GET', '/api/history', { token: viewer.token })).status, 403);
  });

  let newTask;
  await t.test('editor adds, edits and deletes records', async () => {
    const c = await call('POST', '/api/records/tasks', { token: editor.token, body: { title: 'Order site sign', phase: '1 · Mobilisation', status: 'Not started', progress: 0 } });
    assert.equal(c.status, 201);
    newTask = c.json.id;
    const u = await call('PUT', `/api/records/tasks/${newTask}`, { token: editor.token, body: { title: 'Order site sign', phase: '1 · Mobilisation', status: 'In progress', progress: 40 } });
    assert.equal(u.status, 200);
    const all = (await call('GET', '/api/records', { token: editor.token })).json;
    assert.equal(all.tasks.find(x => x.id === newTask).progress, 40);
    assert.equal((await call('PUT', '/api/records/tasks/does-not-exist', { token: editor.token, body: { title: 'x' } })).status, 404);
    assert.equal((await call('POST', '/api/records/nonsense', { token: editor.token, body: {} })).status, 404);
    assert.equal((await call('POST', '/api/records/tasks', { token: editor.token, body: [1, 2] })).status, 400);
    assert.equal((await call('PUT', '/api/records/meta/project', { token: editor.token, body: { name: 'Abuquwa Villas', company: 'Saraydar Real Estate' } })).status, 200);
    assert.equal((await call('DELETE', '/api/records/meta/project', { token: editor.token })).status, 400);
  });

  await t.test('site role: log entries and task progress only', async () => {
    assert.equal((await call('POST', '/api/records/log', { token: site.token, body: { date: '2026-11-02', work: 'Fencing erected' } })).status, 201);
    assert.equal((await call('POST', '/api/records/tasks', { token: site.token, body: { title: 'x' } })).status, 403);
    assert.equal((await call('POST', '/api/records/costs', { token: site.token, body: { item: 'x' } })).status, 403);
    assert.equal((await call('PUT', '/api/records/costs/land', { token: site.token, body: { item: 'x' } })).status, 403);
    assert.equal((await call('DELETE', `/api/records/tasks/${newTask}`, { token: site.token })).status, 403);
    const u = await call('PUT', `/api/records/tasks/${newTask}`, { token: site.token, body: { title: 'HACKED', status: 'Done', progress: 100, notes: 'Installed', owner: 'Someone else' } });
    assert.equal(u.status, 200);
    const t1 = (await call('GET', '/api/records', { token: site.token })).json.tasks.find(x => x.id === newTask);
    assert.equal(t1.title, 'Order site sign');
    assert.equal(t1.owner, undefined);
    assert.equal(t1.status, 'Done');
    assert.equal(t1.progress, 100);
    assert.equal(t1.notes, 'Installed');
  });

  await t.test('delete is recorded and removes the record', async () => {
    assert.equal((await call('DELETE', `/api/records/tasks/${newTask}`, { token: editor.token })).status, 200);
    assert.equal((await call('GET', '/api/records', { token: editor.token })).json.tasks.some(x => x.id === newTask), false);
  });

  await t.test('change history shows who changed what', async () => {
    const h = await call('GET', '/api/history', { token: admin });
    assert.equal(h.status, 200);
    const actions = h.json.map(x => `${x.action}:${x.who}`);
    assert.ok(actions.includes('create:editor'));
    assert.ok(actions.includes('delete:editor'));
    const siteEdit = h.json.find(x => x.action === 'update' && x.who === 'site' && x.collection === 'tasks');
    assert.deepEqual(siteEdit.fields.sort(), ['notes', 'progress', 'status']);
    assert.equal(siteEdit.summary, 'Order site sign');
  });

  await t.test('user management rules', async () => {
    const me = (await call('GET', '/api/users', { token: admin })).json.find(u => u.email === 'ali@example.com');
    assert.equal((await call('PATCH', `/api/users/${me.id}`, { token: admin, body: { role: 'viewer' } })).status, 400);
    assert.equal((await call('PATCH', `/api/users/${me.id}`, { token: admin, body: { active: false } })).status, 400);
    assert.equal((await call('PATCH', `/api/users/${viewer.id}`, { token: admin, body: { role: 'editor' } })).json.role, 'editor');
    // role change applies immediately, with the same token
    assert.equal((await call('POST', '/api/records/risks', { token: viewer.token, body: { risk: 'Test risk' } })).status, 201);
    // password reset signs the person out everywhere
    assert.equal((await call('PATCH', `/api/users/${viewer.id}`, { token: admin, body: { password: 'brand-new-pass' } })).status, 200);
    assert.equal((await call('GET', '/api/auth/me', { token: viewer.token })).status, 401);
    assert.equal((await login('viewer@example.com', 'temp-pass-1')).status, 401);
    assert.equal((await login('viewer@example.com', 'brand-new-pass')).status, 200);
    // deactivated users cannot sign in and lose their session
    assert.equal((await call('PATCH', `/api/users/${site.id}`, { token: admin, body: { active: false } })).status, 200);
    assert.equal((await call('GET', '/api/auth/me', { token: site.token })).status, 401);
    assert.equal((await login('site@example.com', 'temp-pass-1')).status, 401);
    assert.equal((await call('PATCH', '/api/users/not-an-id', { token: admin, body: { role: 'viewer' } })).status, 400);
  });

  await t.test('changing your own password', async () => {
    assert.equal((await call('POST', '/api/auth/password', { token: editor.token, body: { current: 'nope', next: 'a-new-password' } })).status, 400);
    assert.equal((await call('POST', '/api/auth/password', { token: editor.token, body: { current: 'temp-pass-1', next: 'short' } })).status, 400);
    const ok = await call('POST', '/api/auth/password', { token: editor.token, body: { current: 'temp-pass-1', next: 'a-new-password' } });
    assert.equal(ok.status, 200);
    assert.equal((await call('GET', '/api/auth/me', { token: editor.token })).status, 401);
    assert.equal((await call('GET', '/api/auth/me', { token: ok.json.token })).status, 200);
  });

  await t.test('only the Netlify site may call from a browser', async () => {
    const good = await call('GET', '/api/health', { headers: { Origin: ORIGIN } });
    assert.equal(good.res.headers.get('access-control-allow-origin'), ORIGIN);
    const bad = await call('GET', '/api/health', { headers: { Origin: 'https://evil.example' } });
    assert.equal(bad.res.headers.get('access-control-allow-origin'), null);
    const pre = await fetch(base + '/api/records', { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'authorization,content-type' } });
    assert.ok([200, 204].includes(pre.status));
    assert.match(pre.headers.get('access-control-allow-methods') || '', /PUT/);
  });

  await t.test('administrator password can be recovered with the reset switch', async () => {
    assert.equal(await db.ensureAdmin(pool, { ADMIN_EMAIL: 'ali@example.com', ADMIN_PASSWORD: 'recovered-pass-1', ADMIN_FORCE_RESET: '1' }), 'reset');
    assert.equal((await login('ali@example.com', 'correct horse 1')).status, 401);
    assert.equal((await login('ali@example.com', 'recovered-pass-1')).status, 200);
  });
});
