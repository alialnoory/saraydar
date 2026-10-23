'use strict';
// Profile photos, creating logins from a workspace, and multiple plots per project.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const sharp = require('sharp');
const db = require('../db');
const { createApp } = require('../app');
const sec = require('../lib/security');
const { generatePassword } = require('../portal/people');
const { client } = require('./helpers');

const URL_ = process.env.TEST_DATABASE_URL;
const SECRET = 's'.repeat(40);

test('generated passwords are long and mixed', () => {
  for (let i = 0; i < 50; i++) {
    const p = generatePassword();
    assert.equal(p.length, 14);
    assert.match(p, /[A-Z]/); assert.match(p, /[a-z]/); assert.match(p, /[2-9]/); assert.match(p, /[!#%+=?@]/);
    assert.doesNotMatch(p, /[0O1lI]/);
  }
});

test('people and plots', { skip: !URL_ && 'set TEST_DATABASE_URL to run' }, async t => {
  const pool = new Pool({ connectionString: URL_ });
  await pool.query('drop schema public cascade; create schema public;');
  await db.migrate(pool); await db.seed(pool);
  await db.ensureAdmin(pool, { ADMIN_EMAIL: 'ali@example.com', ADMIN_PASSWORD: 'admin-pass-123' });
  const server = createApp({ pool, jwtSecret: SECRET, corsOrigins: [], env: { REQUIRE_MFA: '1' } }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.close(); await pool.end(); });
  const login = (c, i, p) => c.post('/login', { identifier: i, password: p }, '/login');
  const admin = client(base);
  await login(admin, 'ali@example.com', 'admin-pass-123'); await admin.get('/mfa/setup');
  const s = (await pool.query("select mfa_secret from users where email = 'ali@example.com'")).rows[0].mfa_secret;
  await admin.post('/mfa/setup', { code: sec.totpAt(sec.decrypt(SECRET, s), Math.floor(Date.now() / 30000)) });
  const adminId = (await pool.query("select id from users where email = 'ali@example.com'")).rows[0].id;
  const multipart = async (c, path, page, fields, file) => {
    const p = await c.get(page); const fd = new FormData(); fd.append('_csrf', c.csrfFrom(p.text));
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    if (file) fd.append(file.field, new Blob([file.data]), file.name);
    return c.raw('POST', path, { multipart: fd });
  };
  let ws, ws2, pmC;

  await t.test('profile photo: uploaded, cropped square, shown in the header', async () => {
    const jpg = await sharp({ create: { width: 900, height: 600, channels: 3, background: '#8e4f2b' } }).jpeg().toBuffer();
    assert.equal((await multipart(admin, '/account/photo', '/account', {}, { field: 'photo', data: jpg, name: 'me.jpg' })).location, '/account?msg=saved');
    const img = await admin.raw('GET', `/users/${adminId}/photo`);
    assert.equal(img.res.headers.get('content-type'), 'image/webp');
    const meta = await sharp(Buffer.from(await img.res.arrayBuffer())).metadata();
    assert.equal(meta.width, 256); assert.equal(meta.height, 256);
    assert.match((await admin.get('/')).text, new RegExp(`<img class="avatar " src="/users/${adminId}/photo`));
    assert.equal((await multipart(admin, '/account/photo', '/account', {}, { field: 'photo', data: Buffer.from('not an image'), name: 'x.jpg' })).status, 400);
  });

  await t.test('create a login straight from a workspace: details shown once, must change password', async () => {
    ws = (await admin.post('/s/dev/new', { kind: 'project', name: 'Four Villas' }, '/s/dev/new')).location.slice(3, 39);
    ws2 = (await admin.post('/s/dev/new', { kind: 'project', name: 'Another' }, '/s/dev/new')).location.slice(3, 39);
    const r = await admin.post(`/w/${ws}/access/new`, { name: 'Mona Client', email: 'mona@example.com', username: 'mona', phone: '+973 3900 1122', job_title: 'Owner representative', kind: 'external', system_role: 'viewer', auto_password: '1', ws_role: 'client_viewer', send_welcome: '1' }, `/w/${ws}/access`);
    assert.equal(r.status, 200);
    const pw = /<dd class="mono creds">([^<]+)<\/dd>/.exec(r.text)[1].replace(/&#39;/g, "'").replace(/&amp;/g, '&');
    assert.equal(pw.length, 14);
    const u = (await pool.query("select * from users where email = 'mona@example.com'")).rows[0];
    assert.equal(u.kind, 'external'); assert.equal(u.phone, '+973 3900 1122'); assert.ok(u.must_change_password);
    const m = (await pool.query('select role from workspace_members where workspace_id = $1 and user_id = $2', [ws, u.id])).rows[0];
    assert.equal(m.role, 'client_viewer');
    const mail = (await pool.query("select * from outbox_messages where kind = 'welcome'")).rows[0];
    assert.equal(mail.status, 'unconfigured');
    assert.ok(mail.body_text.includes('mona') && !mail.body_text.includes(pw));      // never emails the password
    const c = client(base);
    assert.equal((await login(c, 'mona', pw)).location, '/account/password?forced=1');
    // an external viewer gets only a viewer role; mismatches are refused
    assert.equal((await admin.post(`/w/${ws}/access/new`, { name: 'X', email: 'x@example.com', kind: 'external', ws_role: 'editor', password: 'long-enough-1' }, `/w/${ws}/access`)).status, 400);
    // staff login created by the admin; a project manager cannot create logins
    const r2 = await admin.post(`/w/${ws}/access/new`, { name: 'Paul PM', email: 'pm@example.com', kind: 'internal', system_role: 'project_manager', password: 'pm-temp-pass-1', ws_role: 'manager' }, `/w/${ws}/access`);
    assert.equal(r2.status, 200);
    pmC = client(base); await login(pmC, 'pm@example.com', 'pm-temp-pass-1');
    await pmC.post('/account/password', { current: 'pm-temp-pass-1', password: 'pm-own-pass-1', confirm: 'pm-own-pass-1' }, '/account/password');
    assert.equal((await pmC.post(`/w/${ws}/access/new`, { name: 'Y', email: 'y@example.com', kind: 'internal', system_role: 'viewer', password: 'long-enough-1', ws_role: 'viewer' }, `/w/${ws}/access`)).status, 403);
    // external viewer cannot see other people's photos
    await c.post('/account/password', { current: pw, password: 'mona-own-pass-1', confirm: 'mona-own-pass-1' }, '/account/password');
    assert.equal((await c.raw('GET', `/users/${adminId}/photo`)).status, 404);
  });

  await t.test('several plots in one project, with totals, units and plan tasks', async () => {
    const add = (ref, area, extra = {}) => pmC.post(`/w/${ws}/plots`, { ref, title_deed: `TD-${ref}`, area_m2: String(area), frontage_m: '10.3', depth_m: '17', tenure: 'freehold', status: 'owned', purchase_price: '62,500', ...extra }, `/w/${ws}/plots`);
    for (const [i, ref] of ['1201', '1202', '1203', '1204'].entries()) assert.equal((await add(ref, 175.1)).location, `/w/${ws}/plots?msg=added`, `plot ${i}`);
    assert.equal((await add('1201', 1)).status, 400);                      // same plot twice
    const page = await pmC.get(`/w/${ws}/plots`);
    assert.match(page.text, /700\.4 m²/);
    assert.match(page.text, /BHD 250,000\.000/);
    const p1 = (await pool.query("select id from plots where workspace_id = $1 and ref = '1201'", [ws])).rows[0].id;
    // a unit is linked to a plot of the same project only
    assert.equal((await pmC.post(`/w/${ws}/units`, { name: 'Villa 1', plot_id: p1, unit_type: 'Townhouse', area_m2: '250' }, `/w/${ws}/units`)).location, `/w/${ws}/units?msg=added`);
    assert.match((await pmC.get(`/w/${ws}/plots`)).text, /Villa 1/);
    await admin.post(`/w/${ws2}/access`, { user: (await pool.query("select id from users where email = 'pm@example.com'")).rows[0].id, role: 'manager' }, `/w/${ws2}/access`);
    assert.equal((await pmC.post(`/w/${ws2}/units`, { name: 'Bad', plot_id: p1 }, `/w/${ws2}/units`)).status, 400);
    assert.equal((await pmC.post(`/w/${ws2}/plots/${p1}`, { ref: 'x' }, `/w/${ws2}/plots`)).status, 404);
    // documents per plot
    const pdf = Buffer.from('%PDF-1.4\n%deed\n');
    assert.equal((await multipart(pmC, `/w/${ws}/plots/${p1}/files`, `/w/${ws}/plots`, { caption: 'Title deed' }, { field: 'files', data: pdf, name: 'deed.pdf' })).location, `/w/${ws}/plots?msg=uploaded`);
    assert.match((await pmC.get(`/w/${ws}/plots`)).text, />Title deed</);
    // setup knows about plots; generated plan gets a check per plot
    await pmC.post(`/w/${ws}/setup/identity`, { type: 'residential', outcome: 'sell', go: 'stay' });
    await pmC.post(`/w/${ws}/setup/land`, { plots_count: '3', go: 'stay' });
    await pmC.post(`/w/${ws}/setup/stage`, { stage: 'design', go: 'stay' });
    assert.match((await pmC.get(`/w/${ws}/setup/review`)).text, /Setup says 3 plot\(s\), but 4 are recorded/);
    await pmC.post(`/w/${ws}/plan/generate`, {}, `/w/${ws}/setup/review`);
    const plotTasks = (await pool.query("select title from tasks where workspace_id = $1 and title like 'Plot %'", [ws])).rows.map(x => x.title);
    assert.deepEqual(plotTasks.sort(), ['1201', '1202', '1203', '1204'].map(r => `Plot ${r}: confirm title deed, survey and dimensions`));
  });
});
