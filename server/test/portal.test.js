'use strict';
// Portal foundation tests against a real Postgres: TEST_DATABASE_URL=postgres://… npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const sharp = require('sharp');
const db = require('../db');
const { createApp } = require('../app');
const sec = require('../lib/security');

const URL_ = process.env.TEST_DATABASE_URL;
const SECRET = 'p'.repeat(40);

function client(base) {
  const jar = new Map();
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  async function req(method, path, { form, multipart, headers = {} } = {}) {
    const h = { cookie: cookie(), ...headers };
    let body;
    if (form) { body = new URLSearchParams(form).toString(); h['content-type'] = 'application/x-www-form-urlencoded'; }
    if (multipart) body = multipart;
    const res = await fetch(base + path, { method, headers: h, body, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';'); const i = kv.indexOf('=');
      const k = kv.slice(0, i), v = kv.slice(i + 1);
      if (v === '' || /expires=Thu, 01 Jan 1970/i.test(c)) jar.delete(k); else jar.set(k, v);
    }
    const ct = res.headers.get('content-type') || '';
    const text = ct.includes('text') || ct.includes('json') ? await res.text() : '';
    return { status: res.status, location: res.headers.get('location'), text, res };
  }
  const csrfFrom = t => (/name="_csrf" value="([^"]+)"/.exec(t) || [])[1];
  return {
    jar, get: p => req('GET', p),
    post: async (p, form = {}, page = null) => {
      let token = form._csrf;
      if (!token) { const g = await req('GET', page || p); token = csrfFrom(g.text); }
      return req('POST', p, { form: { ...form, _csrf: token } });
    },
    raw: req, csrfFrom
  };
}

test('portal', { skip: !URL_ && 'set TEST_DATABASE_URL to run' }, async t => {
  const pool = new Pool({ connectionString: URL_ });
  await pool.query('drop schema public cascade; create schema public;');
  await db.migrate(pool);
  await db.seed(pool);
  await db.ensureAdmin(pool, { ADMIN_EMAIL: 'ali@example.com', ADMIN_PASSWORD: 'admin-pass-123' });
  const server = createApp({ pool, jwtSecret: SECRET, corsOrigins: [], env: {} }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.close(); await pool.end(); });

  const login = async (c, ident, pw) => c.post('/login', { identifier: ident, password: pw }, '/login');
  const totpFor = async email => {
    const u = (await pool.query('select mfa_secret from users where lower(email) = $1', [email])).rows[0];
    return sec.totpAt(sec.decrypt(SECRET, u.mfa_secret), Math.floor(Date.now() / 30000));
  };

  const admin = client(base);
  let recovery;

  await t.test('sign-in requires a valid form token and password', async () => {
    assert.equal((await admin.get('/')).location, '/login');
    const noToken = await admin.raw('POST', '/login', { form: { identifier: 'ali@example.com', password: 'admin-pass-123' } });
    assert.equal(noToken.status, 400);
    assert.equal((await login(admin, 'ali@example.com', 'wrong-password')).status, 401);
    const ok = await login(admin, 'ALI@example.com', 'admin-pass-123');
    assert.equal(ok.status, 302);
    assert.equal(ok.location, '/mfa/setup');
  });

  await t.test('Super Admin must enrol in two-step verification before anything else', async () => {
    assert.equal((await admin.get('/')).location, '/mfa/setup');
    assert.equal((await admin.get('/admin/users')).location, '/mfa/setup');
    const page = await admin.get('/mfa/setup');
    assert.match(page.text, /<svg/);
    const bad = await admin.post('/mfa/setup', { code: '000000' });
    assert.equal(bad.location, '/mfa/setup?err=1');
    const good = await admin.post('/mfa/setup', { code: await totpFor('ali@example.com') });
    assert.equal(good.status, 200);
    recovery = [...good.text.matchAll(/<li>([0-9A-F]{5}-[0-9A-F]{5})<\/li>/g)].map(m => m[1]);
    assert.equal(recovery.length, 8);
    const home = await admin.get('/');
    assert.equal(home.status, 200);
    for (const s of ['SarayDar Real Estate Development', 'Clients Projects Management', 'Clients Properties Management', 'Property Sales &amp; Acquisition']) assert.ok(home.text.includes(s), s);
  });

  await t.test('later sign-ins ask for the code; recovery codes work once', async () => {
    const c = client(base);
    assert.equal((await login(c, 'ali@example.com', 'admin-pass-123')).location, '/mfa');
    assert.equal((await c.get('/')).location, '/mfa');
    assert.equal((await c.post('/mfa', { code: '123456' })).location, '/mfa?err=1');
    assert.equal((await c.post('/mfa', { code: recovery[0] })).location, '/');
    const c2 = client(base);
    await login(c2, 'ali@example.com', 'admin-pass-123');
    assert.equal((await c2.post('/mfa', { code: recovery[0] })).location, '/mfa?err=1');
    assert.equal((await c2.post('/mfa', { code: await totpFor('ali@example.com') })).location, '/');
  });

  const mkUser = async (form) => {
    const r = await admin.post('/admin/users', form, '/admin/users');
    assert.equal(r.location, '/admin/users?msg=user_created', r.text.slice(0, 300));
    return (await pool.query('select id from users where email = $1', [form.email])).rows[0].id;
  };
  let pm, eng, ext, pmId, engId, extId, projectId;

  await t.test('admin adds staff; temporary password must be changed', async () => {
    pmId = await mkUser({ name: 'Paula PM', email: 'pm@example.com', username: 'paula', kind: 'internal', system_role: 'project_manager', password: 'temp-pass-123' });
    engId = await mkUser({ name: 'Eli Engineer', email: 'eng@example.com', kind: 'internal', system_role: 'engineer', password: 'temp-pass-123' });
    extId = await mkUser({ name: 'Cara Client', email: 'client@example.com', kind: 'external', system_role: 'viewer', password: 'temp-pass-123' });
    const dup = await admin.post('/admin/users', { name: 'x', email: 'PM@example.com', kind: 'internal', system_role: 'viewer', password: 'temp-pass-123' }, '/admin/users');
    assert.equal(dup.status, 400);
    pm = client(base); eng = client(base); ext = client(base);
    assert.equal((await login(pm, 'paula', 'temp-pass-123')).location, '/account/password?forced=1');
    assert.equal((await pm.get('/')).location, '/account/password?forced=1');
    assert.match((await pm.post('/account/password', { current: 'temp-pass-123', password: 'short', confirm: 'short' })).location, /err=short/);
    assert.equal((await pm.post('/account/password', { current: 'temp-pass-123', password: 'paula-new-pass', confirm: 'paula-new-pass' })).location, '/?msg=password');
    for (const [c, e, p] of [[eng, 'eng@example.com', 'eli-new-pass-1'], [ext, 'client@example.com', 'cara-new-pass-1']]) {
      await login(c, e, 'temp-pass-123');
      await c.post('/account/password', { current: 'temp-pass-123', password: p, confirm: p }, '/account/password');
    }
    assert.equal((await ext.get('/')).location, '/my');
  });

  await t.test('workspaces: create, isolation, membership and revocation', async () => {
    assert.equal((await eng.get('/s/dev/new')).status, 403);
    const r = await pm.post('/s/dev/new', { kind: 'project', name: 'Test Villas', location: '', stage: '', manager: '' }, '/s/dev/new?kind=project');
    assert.match(r.location, /^\/w\/[0-9a-f-]{36}\?msg=created$/);
    projectId = r.location.slice(3, 39);
    const ws = (await pool.query('select ref, location from workspaces where id = $1', [projectId])).rows[0];
    assert.equal(ws.ref, `DEV-${new Date().getFullYear()}-002`);   // 001 is Abuquwa Villas
    assert.equal(ws.location, null);                                // unknown stays unknown
    const second = await pm.post('/s/cpm/new', { kind: 'client_project', name: 'Client Villa', party: 'Al Test Family', location: 'Saar' }, '/s/cpm/new');
    assert.match(second.location, /^\/w\//);
    assert.ok((await pm.get('/s/dev')).text.includes('Test Villas'));
    const abq = (await pool.query("select id from workspaces where ref = 'DEV-2026-001'")).rows[0].id;
    assert.equal((await pm.get(`/w/${abq}`)).status, 404);           // not a member
    assert.ok(!(await pm.get('/s/dev')).text.includes('Abuquwa'));
    assert.ok((await admin.get('/s/dev')).text.includes('Abuquwa Villas'));
    assert.equal((await eng.get(`/w/${projectId}`)).status, 404);
    assert.equal((await eng.get(`/w/${projectId}/documents`)).status, 404);
    assert.equal((await pm.post(`/w/${projectId}/access`, { user: engId, role: 'viewer' }, `/w/${projectId}/access`)).location, `/w/${projectId}/access?msg=added`);
    assert.equal((await eng.get(`/w/${projectId}`)).status, 200);
    assert.equal((await eng.post(`/w/${projectId}/edit`, { name: 'Hacked', status: 'active' }, `/w/${projectId}`)).status, 403);  // viewer
    assert.equal((await pm.post(`/w/${projectId}/access/revoke`, { user: engId }, `/w/${projectId}/access`)).location, `/w/${projectId}/access?msg=revoked`);
    assert.equal((await eng.get(`/w/${projectId}`)).status, 404);
    // an external person cannot be given a staff role
    assert.equal((await pm.post(`/w/${projectId}/access`, { user: extId, role: 'editor' }, `/w/${projectId}/access`)).status, 400);
  });

  await t.test('changes need the session form token', async () => {
    const r = await pm.raw('POST', `/w/${projectId}/edit`, { form: { name: 'No token', status: 'active' } });
    assert.equal(r.status, 403);
    const cross = await pm.raw('POST', `/w/${projectId}/edit`, { form: { name: 'x', _csrf: 'nope' }, headers: { origin: 'https://evil.example' } });
    assert.equal(cross.status, 403);
    assert.equal((await pool.query('select name from workspaces where id = $1', [projectId])).rows[0].name, 'Test Villas');
    const ok = await pm.post(`/w/${projectId}/edit`, { name: 'Test Villas Phase 1', location: 'Hamala', stage: 'Design', manager: pmId, status: 'active' }, `/w/${projectId}`);
    assert.equal(ok.location, `/w/${projectId}?msg=saved`);
  });

  let internalFile, publishedFile;
  await t.test('files: type checks, thumbnails, internal vs published, external read-only', async () => {
    const png = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#a0522d' } }).png().toBuffer();
    const page = await pm.get(`/w/${projectId}/documents`);
    const token = pm.csrfFrom(page.text);
    const up = async (name, buf, vis) => {
      const fd = new FormData();
      fd.append('_csrf', token); fd.append('caption', 'North wall'); fd.append('visibility', vis);
      fd.append('files', new Blob([buf]), name);
      return pm.raw('POST', `/w/${projectId}/files`, { multipart: fd });
    };
    assert.equal((await up('site.png', png, 'internal')).location, `/w/${projectId}/documents?msg=uploaded`);
    assert.equal((await up('pub.png', png, 'published')).location, `/w/${projectId}/documents?msg=uploaded`);
    assert.equal((await up('fake.pdf', Buffer.from('MZ this is not a pdf'), 'internal')).status, 415);
    const noToken = new FormData(); noToken.append('files', new Blob([png]), 'x.png');
    assert.equal((await pm.raw('POST', `/w/${projectId}/files`, { multipart: noToken })).status, 403);
    const files = (await pool.query('select id, original_name, thumb is not null as t from files where workspace_id = $1 order by uploaded_at', [projectId])).rows;
    assert.equal(files.length, 2);
    assert.ok(files.every(f => f.t));
    internalFile = files.find(f => f.original_name === 'site.png').id;
    publishedFile = files.find(f => f.original_name === 'pub.png').id;
    const img = await pm.raw('GET', `/files/${internalFile}`);
    assert.equal(img.status, 200);
    assert.equal(img.res.headers.get('content-type'), 'image/png');
    assert.equal((await eng.raw('GET', `/files/${internalFile}`)).status, 404);   // not a member any more
    // external viewer
    await pm.post(`/w/${projectId}/access`, { user: extId, role: 'client_viewer' }, `/w/${projectId}/access`);
    const my = await ext.get('/my');
    assert.ok(my.text.includes('Test Villas Phase 1'));
    assert.ok(!my.text.includes('Client Villa'));
    assert.equal((await ext.raw('GET', `/files/${internalFile}`)).status, 404);
    assert.equal((await ext.raw('GET', `/files/${publishedFile}`)).status, 200);
    const docs = await ext.get(`/w/${projectId}/documents`);
    assert.ok(docs.text.includes('pub.png') && !docs.text.includes('site.png'));
    assert.equal((await ext.get(`/w/${projectId}/access`)).status, 404);
    assert.equal((await ext.get('/s/dev')).location, '/my');
    assert.equal((await ext.get('/admin/users')).status, 404);
    // every write attempt is refused and nothing changes
    const before = (await pool.query('select name, updated_at from workspaces where id = $1', [projectId])).rows[0];
    const extPage = await ext.get(`/w/${projectId}`);
    const extToken = ext.csrfFrom(extPage.text);
    for (const [path, form] of [[`/w/${projectId}/edit`, { name: 'x', status: 'archived' }], [`/w/${projectId}/access`, { user: extId, role: 'client_viewer' }], [`/files/${publishedFile}/archive`, {}], ['/s/dev/new', { name: 'x' }], ['/admin/users', { name: 'x', email: 'x@x.co', password: 'xxxxxxxxxxxx' }]]) {
      const r = await ext.raw('POST', path, { form: { ...form, _csrf: extToken } });
      assert.equal(r.status, 403, path);
    }
    const fd = new FormData(); fd.append('_csrf', extToken); fd.append('files', new Blob([png]), 'x.png');
    assert.equal((await ext.raw('POST', `/w/${projectId}/files`, { multipart: fd })).status, 403);
    const after = (await pool.query('select name, updated_at from workspaces where id = $1', [projectId])).rows[0];
    assert.deepEqual(after, before);
    assert.equal((await pool.query('select count(*)::int as n from files where workspace_id = $1', [projectId])).rows[0].n, 2);
  });

  await t.test('audit trail is recorded and cannot be rewritten', async () => {
    const actions = (await pool.query('select action from audit_events where workspace_id = $1', [projectId])).rows.map(r => r.action);
    for (const a of ['workspace.created', 'workspace.updated', 'access.granted', 'access.revoked', 'file.uploaded']) assert.ok(actions.includes(a), a);
    await assert.rejects(pool.query('update audit_events set summary = $1', ['x']), /append-only/);
    await assert.rejects(pool.query('delete from audit_events'), /append-only/);
    assert.ok((await pm.get(`/w/${projectId}/activity`)).text.includes('Changed'));
  });

  await t.test('password recovery: single-use expiring link, never shown in the outbox', async () => {
    assert.equal((await client(base).post('/forgot', { identifier: 'nobody@example.com' }, '/forgot')).location, '/login?msg=reset_sent');
    assert.equal((await client(base).post('/forgot', { identifier: 'paula' }, '/forgot')).location, '/login?msg=reset_sent');
    const msg = (await pool.query("select * from outbox_messages where kind = 'password_reset' order by id desc limit 1")).rows[0];
    assert.equal(msg.status, 'unconfigured');
    assert.equal(msg.to_address, 'pm@example.com');
    const token = /\/reset\/([A-Za-z0-9_-]+)/.exec(msg.body_text)[1];
    assert.ok(!(await admin.get('/admin/outbox')).text.includes(token));
    const c = client(base);
    assert.equal((await c.post(`/reset/${token}`, { password: 'paula-reset-pass', confirm: 'paula-reset-pass' })).location, '/login?msg=reset_done');
    assert.equal((await pm.get('/')).location, '/login');            // old session ended
    assert.equal((await client(base).get(`/reset/${token}`)).status, 400);  // single use
    const p2 = client(base);
    assert.equal((await login(p2, 'pm@example.com', 'paula-reset-pass')).location, '/');
    pm = p2;
  });

  await t.test('deactivation ends sessions; repeated failures lock the account', async () => {
    const r = await admin.post(`/admin/users/${engId}`, { name: 'Eli Engineer', username: '', system_role: 'engineer', active: '0' }, `/admin/users/${engId}`);
    assert.equal(r.location, `/admin/users/${engId}?msg=user_saved`);
    assert.equal((await eng.get('/')).location, '/login');
    assert.equal((await login(client(base), 'eng@example.com', 'eli-new-pass-1')).status, 401);
    const c = client(base);
    for (let i = 0; i < 10; i++) await login(c, 'client@example.com', 'wrong-' + i);
    const locked = await login(c, 'client@example.com', 'cara-new-pass-1');
    assert.equal(locked.status, 401);
    assert.match(locked.text, /Too many failed attempts/);
  });

  await t.test('role permissions are configurable', async () => {
    assert.equal((await pm.get('/s/sales/new')).status, 403);
    const roles = (await pool.query("select key, permissions from roles where kind = 'internal' and key <> 'super_admin'")).rows;
    const form = { };
    const body = new URLSearchParams();
    for (const r of roles) for (const p of r.permissions) body.append(r.key, p);
    body.append('project_manager', 'create:sales');
    const page = await admin.get('/admin/roles');
    body.append('_csrf', admin.csrfFrom(page.text));
    const res = await fetch(base + '/admin/roles', { method: 'POST', body, redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: [...admin.jar].map(([k, v]) => `${k}=${v}`).join('; ') } });
    assert.equal(res.headers.get('location'), '/admin/roles?msg=roles');
    assert.equal((await pm.get('/s/sales/new')).status, 200);
    void form;
  });

  await t.test('legacy tracker API keeps working alongside the portal', async () => {
    assert.equal((await fetch(base + '/api/health')).status, 200);
    assert.equal((await fetch(base + '/api/records')).status, 401);
  });
});
