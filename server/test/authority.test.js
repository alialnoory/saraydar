'use strict';
// Authority matrix (owner request 2026-10-29): areas × actions per role, money limits, added roles, administration.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const db = require('../db');
const { createApp } = require('../app');
const { client } = require('./helpers');
const { defaults, legacyFrom, AREAS } = require('../portal/authority');

const URL_ = process.env.TEST_DATABASE_URL;

test('starting matrix keeps today\'s abilities and the older switches follow it', () => {
  const pm = defaults('project_manager');
  assert.deepEqual(legacyFrom(pm.matrix, pm.limits), ['create:cpm', 'create:dev', 'create:props', 'view:financials']);
  const fin = defaults('finance');
  assert.deepEqual(legacyFrom(fin.matrix, fin.limits), ['finance:post', 'view:financials']);
  assert.deepEqual(legacyFrom(defaults('engineer').matrix), []);
  assert.deepEqual(legacyFrom(defaults('brokerage_agent').matrix), ['create:sales']);
  for (const r of ['project_manager', 'finance', 'engineer', 'site_supervisor', 'administrator', 'viewer', 'brokerage_agent', 'sales_manager'])
    for (const k of Object.keys(defaults(r).matrix)) assert.ok(AREAS[k], `${r}: unknown area ${k}`);
});

test('authority matrix', { skip: !URL_ && 'set TEST_DATABASE_URL to run' }, async t => {
  const pool = new Pool({ connectionString: URL_ });
  await pool.query('drop schema public cascade; create schema public;');
  await db.migrate(pool);
  await db.seed(pool);
  await db.ensureAdmin(pool, { ADMIN_EMAIL: 'ali@example.com', ADMIN_PASSWORD: 'admin-pass-123' });
  const app = createApp({ pool, jwtSecret: 'a'.repeat(40), corsOrigins: [], env: {} }).listen(0);
  const base = `http://127.0.0.1:${app.address().port}`;
  t.after(async () => { app.close(); await pool.end(); });
  const admin = client(base);
  await admin.post('/login', { identifier: 'ali@example.com', password: 'admin-pass-123' }, '/login');
  const mk = async (email, role) => {
    await admin.post('/admin/users', { name: email.split('@')[0], email, kind: 'internal', system_role: role, password: 'temp-pass-123' }, '/admin/users');
    const c = client(base);
    await c.post('/login', { identifier: email, password: 'temp-pass-123' }, '/login');
    await c.post('/account/password', { current: 'temp-pass-123', password: 'own-pass-1234', confirm: 'own-pass-1234' }, '/account/password');
    return [c, (await pool.query('select id from users where email = $1', [email])).rows[0].id];
  };
  const [pm, pmId] = await mk('pm@example.com', 'project_manager');
  const [sup, supId] = await mk('sup@example.com', 'site_supervisor');
  const [adm, admId] = await mk('office@example.com', 'administrator');
  const save = async (key, matrix, limits) => {
    const page = await admin.get(`/admin/roles?role=${key}`);
    const body = new URLSearchParams(); body.append('_csrf', admin.csrfFrom(page.text));
    for (const [k, acts] of Object.entries(matrix)) for (const a of acts) body.append('m', `${k}|${a}`);
    for (const [k, v] of Object.entries(limits)) { body.append(`lim_on_${k}`, '1'); body.append(`lim_${k}`, v); }
    const r = await fetch(`${base}/admin/roles/${key}`, { method: 'POST', body, redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: [...admin.jar].map(([k, v]) => `${k}=${v}`).join('; ') } });
    assert.equal(r.status, 302);
  };

  let ws;
  await t.test('areas and actions are enforced on top of project membership', async () => {
    ws = (await pm.post('/s/cpm/new', { kind: 'client_project', name: 'Matrix Villa' }, '/s/cpm/new')).location.slice(3, 39);
    await pm.post(`/w/${ws}/access`, { user: supId, role: 'editor' }, `/w/${ws}/access`);
    // the supervisor may post progress updates, but not open the budget or change the plan, even as an editor of the project
    assert.equal((await sup.get(`/w/${ws}/updates`)).status, 200);
    assert.equal((await sup.get(`/w/${ws}/budget`)).status, 404);
    assert.equal((await sup.get(`/w/${ws}/fees`)).status, 404);
    const plan = await sup.post(`/w/${ws}/master/stages`, { name: 'Extra', weight: '1' }, `/w/${ws}/master`);
    assert.equal(plan.status, 403);
    assert.match(plan.text, /Plan and master plan/);
    // tabs outside the role are left out
    const ov = await sup.get(`/w/${ws}`);
    assert.doesNotMatch(ov.text, /class="mtile" href="\/w\/[^"]+\/budget"/);
    assert.match(ov.text, /class="mtile" href="\/w\/[^"]+\/updates"/);
    assert.doesNotMatch(ov.text, /System Requirements/);                 // completing the record is not their job
    // export is its own right
    assert.equal((await sup.get(`/w/${ws}/updates?export=pdf`)).status, 403);
    await save('site_supervisor', { 'cpm.record': ['view'], 'cpm.updates': ['view', 'create', 'edit', 'export'] }, {});
    assert.equal((await sup.get(`/w/${ws}/updates?export=pdf`)).status, 200);
    assert.equal((await sup.get(`/w/${ws}/registers`)).status, 404);      // no longer ticked
  });

  await t.test('money limits: above the limit someone with more authority has to do it', async () => {
    await pool.query("update workspaces set budget_control = 'saraydar' where id = $1", [ws]);
    await admin.post(`/w/${ws}/budget/lines`, { category: 'Construction', description: 'Project construction', revised: '200000' }, `/w/${ws}/budget`);
    const line = (await pool.query("select id from budget_lines where workspace_id = $1 and description = 'Project construction'", [ws])).rows[0].id;
    await save('project_manager', (await pool.query("select matrix from roles where key = 'project_manager'")).rows[0].matrix, { invoice: '5,000', contract: '', budget: '' });
    await pm.post(`/w/${ws}/budget/invoices`, { supplier: 'Gulf Builders', invoice_no: 'A-1', amount: '4000', invoice_date: '2026-11-01', budget_line_id: line }, `/w/${ws}/budget`);
    await pm.post(`/w/${ws}/budget/invoices`, { supplier: 'Gulf Builders', invoice_no: 'A-2', amount: '9000', invoice_date: '2026-11-01', budget_line_id: line }, `/w/${ws}/budget`);
    const inv = Object.fromEntries((await pool.query('select invoice_no, id from cost_invoices where workspace_id = $1', [ws])).rows.map(x => [x.invoice_no, x.id]));
    for (const id of Object.values(inv)) await pm.post(`/w/${ws}/budget/invoices/${id}`, { decision: 'reviewed' }, `/w/${ws}/budget`);
    assert.equal((await pm.post(`/w/${ws}/budget/invoices/${inv['A-1']}`, { decision: 'approved' }, `/w/${ws}/budget`)).status, 302);
    const over = await pm.post(`/w/${ws}/budget/invoices/${inv['A-2']}`, { decision: 'approved' }, `/w/${ws}/budget`);
    assert.equal(over.status, 403);
    assert.match(over.text, /BHD 9,000[\s\S]*up to BHD 5,000/);
    assert.equal((await pool.query('select status from cost_invoices where id = $1', [inv['A-2']])).rows[0].status, 'reviewed');   // waits for a higher authority
    assert.equal((await admin.post(`/w/${ws}/budget/invoices/${inv['A-2']}`, { decision: 'approved' }, `/w/${ws}/budget`)).status, 302);   // the Super Admin has no limit
    // "Not allowed": variations need someone else
    const v = await pm.post(`/w/${ws}/budget/commitments`, { counterparty: 'Gulf Builders', kind: 'variation', value: '100', budget_line_id: line }, `/w/${ws}/budget`);
    assert.equal(v.status, 403);
    assert.match(v.text, /not allowed to approve variations/);
  });

  await t.test('administration: granted areas only, and never over a Super Admin', async () => {
    assert.equal((await adm.get('/admin/users')).status, 200);
    assert.equal((await adm.get('/admin/roles')).status, 404);           // the matrix itself stays with Super Admins
    assert.equal((await adm.get('/admin/audit')).status, 200);
    assert.equal((await pm.get('/admin/users')).status, 404);
    const superId = (await pool.query("select id from users where email = 'ali@example.com'")).rows[0].id;
    assert.equal((await adm.post(`/admin/users/${superId}`, { name: 'X', system_role: 'viewer', active: '0' }, `/admin/users/${superId}`)).status, 403);
    assert.equal((await adm.post(`/admin/users/${pmId}`, { name: 'pm', system_role: 'super_admin', active: '1' }, `/admin/users/${pmId}`)).status, 403);
    assert.equal((await adm.post(`/admin/users/${pmId}`, { name: 'Project Manager', system_role: 'project_manager', active: '1' }, `/admin/users/${pmId}`)).status, 302);
    assert.equal((await adm.post('/admin/users', { name: 'Boss', email: 'boss@example.com', kind: 'internal', system_role: 'super_admin', password: 'temp-pass-123' }, '/admin/users')).status, 403);
    const ua = await admin.get('/admin/audit');
    assert.match(ua.text, /Changed the authority of Project Manager/);
    void admId;
  });

  await t.test('Chairman: sees every record, including finance, without being added; changes nothing', async () => {
    const [ch] = await mk('chair@example.com', 'chairman');
    assert.equal((await ch.get(`/w/${ws}`)).status, 200);                 // not added to the project
    assert.equal((await ch.get(`/w/${ws}/budget`)).status, 200);
    assert.equal((await ch.get(`/w/${ws}/fees`)).status, 200);
    assert.match((await ch.get('/s/cpm')).text, /Matrix Villa/);
    assert.equal((await ch.get(`/w/${ws}/budget?export=xlsx`)).status, 200);
    assert.equal((await ch.post(`/w/${ws}/budget/lines`, { category: 'Other', description: 'X', revised: '1' }, `/w/${ws}/budget`)).status, 403);
    assert.equal((await ch.post(`/w/${ws}/updates`, { observed_on: '2026-10-30' }, `/w/${ws}/updates`)).status, 403);
    assert.equal((await ch.get('/admin/users')).status, 404);
    // the switch is per role: a Viewer sees only what they are added to, until "All records" is chosen
    const [vw] = await mk('viewer@example.com', 'viewer');
    assert.equal((await vw.get(`/w/${ws}`)).status, 404);
    const ro = (await pool.query("select matrix from roles where key = 'viewer'")).rows[0];
    await save('viewer', ro.matrix, {});
    const page = await admin.get('/admin/roles?role=viewer');
    const body = new URLSearchParams(); body.append('_csrf', admin.csrfFrom(page.text)); body.append('see_all', '1');
    for (const [k, acts] of Object.entries(ro.matrix)) for (const a of acts) body.append('m', `${k}|${a}`);
    await fetch(`${base}/admin/roles/viewer`, { method: 'POST', body, redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: [...admin.jar].map(([k, v]) => `${k}=${v}`).join('; ') } });
    assert.equal((await vw.get(`/w/${ws}`)).status, 200);
  });
});
