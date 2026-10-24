'use strict';
// Phase 3: development projects. Needs TEST_DATABASE_URL.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const sharp = require('sharp');
const ExcelJS = require('exceljs');
const db = require('../db');
const { createApp } = require('../app');
const sec = require('../lib/security');
const money = require('../lib/money');
const progress = require('../lib/progress');
const { importAbuquwa } = require('../lib/abuquwa-import');
const { client } = require('./helpers');

const URL_ = process.env.TEST_DATABASE_URL;
const SECRET = 'q'.repeat(40);

test('money uses exact minor units', () => {
  assert.equal(money.parseMoney('1,234.567'), 1234567);
  assert.equal(money.parseMoney('0.1') + money.parseMoney('0.2'), money.parseMoney('0.3'));
  assert.equal(money.parseMoney(''), null);
  assert.throws(() => money.parseMoney('1.2345'), /3 decimal/);
  assert.throws(() => money.parseMoney('12abc'), /not a valid/);
  assert.equal(money.formatMoney(180000000), 'BHD 180,000.000');
  assert.equal(money.formatMoney(-5), 'BHD -0.005');
});

test('weighted progress: leaf tasks only, unavailable without baseline or weights', () => {
  const phases = [{ id: 'A', name: 'Design', weight: 10 }, { id: 'B', name: 'Build', weight: 90 }];
  const tasks = [
    { id: 't1', phase_id: 'A', status: 'done', progress: 100, weight: null },
    { id: 't2', phase_id: 'A', status: 'in_progress', progress: 50, weight: null },
    { id: 'p', phase_id: 'B', status: 'in_progress', progress: 99, weight: null },          // parent: ignored
    { id: 'c1', phase_id: 'B', parent_id: 'p', status: 'in_progress', progress: 40, weight: 3 },
    { id: 'c2', phase_id: 'B', parent_id: 'p', status: 'not_started', progress: 0, weight: 1 },
    { id: 'x', phase_id: 'B', status: 'cancelled', progress: 0, weight: 5 }
  ];
  assert.equal(progress.overall({ phases, tasks, approved: false }).available, false);
  const r = progress.overall({ phases, tasks, approved: true });
  assert.ok(r.available);
  // Design = 75%, Build = (3×40 + 1×0)/4 = 30% → (10×75 + 90×30)/100 = 34.5
  assert.equal(Math.round(r.pct * 10) / 10, 34.5);
  const missing = progress.overall({ phases: [{ ...phases[0], weight: null }, phases[1]], tasks, approved: true });
  assert.equal(missing.available, false);
  assert.match(missing.reason, /Design/);
  const base = { phases: [{ id: 'A', weight: 1 }], tasks: [{ id: 't', phase_id: 'A', start_date: '2026-01-01', due_date: '2026-01-10' }] };
  assert.equal(Math.round(progress.plannedAt(base, '2026-01-06').pct), 50);
  assert.equal(progress.plannedAt(base, '2025-12-01').pct, 0);
  assert.equal(progress.plannedAt({ phases: base.phases, tasks: [{ id: 't', phase_id: 'A' }] }, '2026-01-06').available, false);
  assert.ok(progress.createsCycle([{ task_id: 'b', depends_on: 'a' }], 'a', 'b'));
  assert.ok(!progress.createsCycle([{ task_id: 'b', depends_on: 'a' }], 'c', 'b'));
});

test('development projects', { skip: !URL_ && 'set TEST_DATABASE_URL to run' }, async t => {
  const pool = new Pool({ connectionString: URL_ });
  await pool.query('drop schema public cascade; create schema public;');
  await db.migrate(pool);
  await db.seed(pool);
  await db.ensureAdmin(pool, { ADMIN_EMAIL: 'ali@example.com', ADMIN_PASSWORD: 'admin-pass-123' });
  const server = createApp({ pool, jwtSecret: SECRET, corsOrigins: [], env: { REQUIRE_MFA: '1' } }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.close(); await pool.end(); });
  const login = (c, i, p) => c.post('/login', { identifier: i, password: p }, '/login');
  const totp = async email => { const u = (await pool.query('select mfa_secret from users where email = $1', [email])).rows[0]; return sec.totpAt(sec.decrypt(SECRET, u.mfa_secret), Math.floor(Date.now() / 30000)); };

  await t.test('the Abuquwa tracker moves into DEV-2026-001 once', async () => {
    assert.equal(await importAbuquwa(pool), 36);
    assert.equal(await importAbuquwa(pool), 0);
    const ws = (await pool.query("select id, details from workspaces where ref = 'DEV-2026-001'")).rows[0];
    assert.ok(ws.details.imported_at);
    const n = q => pool.query(q, [ws.id]).then(r => r.rows[0].n);
    assert.equal(await n('select count(*)::int as n from tasks where workspace_id = $1'), 36);
    assert.equal(await n('select count(*)::int as n from budget_lines where workspace_id = $1 and not verified'), 9);
    assert.equal(await n("select count(*)::int as n from plans where workspace_id = $1 and status = 'draft'"), 1);
    assert.equal(await n("select count(*)::int as n from cost_payments where workspace_id = $1 and status = 'pending'"), 1);
    assert.equal(await n("select count(*)::int as n from register_items where workspace_id = $1 and kind = 'risk'"), 7);
    assert.equal(await n('select count(*)::int as n from dev_units where workspace_id = $1'), 4);
    const land = (await pool.query("select revised_minor from budget_lines where workspace_id = $1 and category = 'Land'", [ws.id])).rows[0];
    assert.equal(Number(land.revised_minor), 250000000);
    const fin = (await pool.query("select revised_minor from budget_lines where workspace_id = $1 and description = 'Financing costs'", [ws.id])).rows[0];
    assert.equal(fin.revised_minor, null);           // 0 in the old tracker meant "not entered" — kept unknown
    // the old tracker refuses changes now
    const l = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'ali@example.com', password: 'admin-pass-123' }) }).then(r => r.json());
    const w = await fetch(base + '/api/records/tasks', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${l.token}` }, body: '{"title":"x"}' });
    assert.equal(w.status, 410);
  });

  const admin = client(base);
  await login(admin, 'ali@example.com', 'admin-pass-123');
  await admin.get('/mfa/setup');
  await admin.post('/mfa/setup', { code: await totp('ali@example.com') });
  const mk = async (email, role, pw) => {
    await admin.post('/admin/users', { name: email.split('@')[0], email, kind: 'internal', system_role: role, password: 'temp-pass-123' }, '/admin/users');
    const c = client(base);
    await login(c, email, 'temp-pass-123');
    await c.post('/account/password', { current: 'temp-pass-123', password: pw, confirm: pw }, '/account/password');
    return [c, (await pool.query('select id from users where email = $1', [email])).rows[0].id];
  };
  const [pm, pmId] = await mk('pm@example.com', 'project_manager', 'pm-password-1');
  const [eng, engId] = await mk('eng@example.com', 'engineer', 'eng-password-1');
  const [fin, finId] = await mk('fin@example.com', 'finance', 'fin-password-1');
  let ws, other;

  await t.test('guided setup keeps unknowns as unknown and flags conflicts', async () => {
    ws = (await pm.post('/s/dev/new', { kind: 'project', name: 'Hamala Townhouses' }, '/s/dev/new')).location.slice(3, 39);
    other = (await pm.post('/s/dev/new', { kind: 'project', name: 'Other Project' }, '/s/dev/new')).location.slice(3, 39);
    assert.equal((await pm.get(`/w/${ws}/setup`)).location, `/w/${ws}/setup/identity`);
    assert.equal((await pm.post(`/w/${ws}/setup/identity`, { type: 'residential', outcome: 'sell', objective: '', developer: 'SarayDar', owner__unknown: '1', go: 'land' })).location, `/w/${ws}/setup/land?msg=saved`);
    await pm.post(`/w/${ws}/setup/budget`, { total_budget: '500,000', land_cost: '600,000.000', contingency_pct: '', funding__unknown: '1', go: 'stay' });
    await pm.post(`/w/${ws}/setup/timeline`, { start: '2026-12-01', target: '2026-06-01', go: 'stay' });
    const bad = await pm.post(`/w/${ws}/setup/budget`, { total_budget: '1.2345', go: 'stay' });
    assert.equal(bad.status, 400);
    const d = (await pool.query('select answers from setup_drafts where workspace_id = $1', [ws])).rows[0].answers;
    assert.deepEqual(d.owner, { unknown: true });
    assert.equal(d.total_budget.v, 500000000);
    assert.equal(d.contingency_pct, undefined);       // left empty: not converted to zero
    const rv = await pm.get(`/w/${ws}/setup/review`);
    assert.match(rv.text, /Target completion is before the start date/);
    assert.match(rv.text, /Land cost is higher than the total budget/);
    assert.match(rv.text, /Answer the required questions first/);   // stage still missing
    assert.equal((await pm.post(`/w/${ws}/plan/generate`, {}, `/w/${ws}/setup/review`)).status, 400);
    await pm.post(`/w/${ws}/setup/stage`, { stage: 'design', ph_feasibility: 'done', ph_design: 'in_progress', go: 'review' });
    assert.equal((await pool.query('select stage from workspaces where id = $1', [ws])).rows[0].stage, 'Design');
    assert.equal((await eng.get(`/w/${ws}/setup/review`)).status, 404);   // not a member
  });

  await t.test('draft plan: suggested items, approval needs weights, baseline saved', async () => {
    assert.equal((await pm.post(`/w/${ws}/plan/generate`, {}, `/w/${ws}/setup/review`)).location, `/w/${ws}/plan?msg=created`);
    assert.equal((await pm.post(`/w/${ws}/plan/generate`, {}, `/w/${ws}/setup/review`)).status, 400);      // never twice
    const tasks = (await pool.query('select * from tasks where workspace_id = $1', [ws])).rows;
    assert.ok(tasks.length > 20 && tasks.every(x => x.suggested && x.start_date === null && x.due_date === null));
    const feas = (await pool.query("select t.* from tasks t join phases p on p.id = t.phase_id where p.workspace_id = $1 and p.name = 'Feasibility & land'", [ws])).rows;
    assert.ok(feas.every(x => x.status === 'done' && !x.verified));      // reported, not verified
    assert.ok((await pool.query("select 1 from phases where workspace_id = $1 and name = 'Sales & marketing'", [ws])).rowCount);
    const lines = (await pool.query('select * from budget_lines where workspace_id = $1', [ws])).rows;
    assert.equal(Number(lines.find(l => l.category === 'Land').revised_minor), 600000000);
    assert.ok(lines.filter(l => l.category !== 'Land').every(l => l.revised_minor === null));   // no invented costs
    assert.ok((await pool.query("select 1 from register_items where workspace_id = $1 and kind = 'risk' and suggested", [ws])).rowCount);
    const page = await pm.get(`/w/${ws}/plan`);
    assert.match(page.text, /Blocks approval/);
    assert.equal((await pm.post(`/w/${ws}/plan/approve`, { reviewed: '1' }, `/w/${ws}/plan`)).status, 400);
    await pm.post(`/w/${ws}/plan/suggested-weights`, {}, `/w/${ws}/plan`);
    assert.equal((await pm.post(`/w/${ws}/plan/approve`, {}, `/w/${ws}/plan`)).status, 400);          // must confirm review
    assert.equal((await pm.post(`/w/${ws}/plan/approve`, { reviewed: '1', reason: 'First baseline' }, `/w/${ws}/plan`)).location, `/w/${ws}/plan?msg=saved`);
    const pl = (await pool.query("select * from plans where workspace_id = $1 and status = 'approved'", [ws])).rows[0];
    assert.equal(pl.baseline.tasks.length, tasks.length);
    assert.equal((await pool.query('select count(*)::int as n from tasks where workspace_id = $1 and suggested', [ws])).rows[0].n, 0);
    assert.equal(Number((await pool.query("select original_minor from budget_lines where workspace_id = $1 and category = 'Land'", [ws])).rows[0].original_minor), 600000000);
    // revision needs a reason
    await pm.post(`/w/${ws}/plan/revise`, {}, `/w/${ws}/plan`);
    assert.equal((await pm.post(`/w/${ws}/plan/approve`, { reviewed: '1', reason: '' }, `/w/${ws}/plan`)).status, 400);
    assert.equal((await pm.post(`/w/${ws}/plan/approve`, { reviewed: '1', reason: 'Dates added' }, `/w/${ws}/plan`)).location, `/w/${ws}/plan?msg=saved`);
    const versions = (await pool.query('select version, status from plans where workspace_id = $1 order by version', [ws])).rows;
    assert.deepEqual(versions.map(v => v.status), ['superseded', 'approved']);
  });

  let taskA, taskB;
  await t.test('tasks: progress follows the documented method; loops are refused; IDs stay inside their workspace', async () => {
    const before = await pm.get(`/w/${ws}`);
    assert.match(before.text, /Overall progress/);
    const ts = (await pool.query("select t.id, t.title, p.name from tasks t join phases p on p.id = t.phase_id where t.workspace_id = $1 and p.name = 'Design' order by t.sort", [ws])).rows;
    taskA = ts[0].id; taskB = ts[1].id;
    const form = (title, extra = {}) => ({ title, phase_id: '', parent_id: '', owner_text: 'Consultant', weight: '', start_date: '2026-11-01', due_date: '2026-11-30', status: 'done', progress: '', actual_start: '', actual_finish: '', notes: '', ...extra });
    const phaseId = (await pool.query("select id from phases where workspace_id = $1 and name = 'Design'", [ws])).rows[0].id;
    assert.equal((await pm.post(`/w/${ws}/tasks/${taskA}`, form(ts[0].title, { phase_id: phaseId })))
      .location, `/w/${ws}/tasks/${taskA}?msg=saved`);
    assert.equal((await pm.post(`/w/${ws}/tasks/${taskA}`, form(ts[0].title, { phase_id: phaseId, start_date: '2026-12-01', due_date: '2026-11-01' }))).status, 400);
    assert.equal((await pm.post(`/w/${ws}/tasks/${taskB}`, form(ts[1].title, { phase_id: phaseId, status: 'in_progress', deps: taskA }))).status, 302);
    assert.equal((await pm.post(`/w/${ws}/tasks/${taskA}`, form(ts[0].title, { phase_id: phaseId, deps: taskB }))).status, 400);   // loop
    // another workspace's URL cannot reach this task
    assert.equal((await pm.get(`/w/${other}/tasks/${taskA}`)).status, 404);
    assert.equal((await pm.post(`/w/${other}/tasks/${taskA}`, form('x'))).status, 404);
    const { metrics } = { metrics: null };
    void metrics;
    const r = await pm.get(`/w/${ws}/plan`);
    const overall = /<b>Overall:<\/b> ([\d.]+)%/.exec(r.text);
    assert.ok(overall, 'overall progress shown');
    // Expected: recompute from the database with the same rules
    const phases = (await pool.query('select * from phases where workspace_id = $1 and archived_at is null', [ws])).rows;
    const tasks = (await pool.query('select * from tasks where workspace_id = $1 and archived_at is null', [ws])).rows;
    const exp = progress.overall({ phases, tasks, approved: true }).pct;
    assert.equal(overall[1], String(Math.round(exp * 10) / 10));
    assert.ok(exp > 0);
  });

  await t.test('budget: commitment, invoice and payment are not triple-counted; approval ≠ payment', async () => {
    const line = (await pool.query("select id from budget_lines where workspace_id = $1 and category = 'Construction'", [ws])).rows[0].id;
    await pm.post(`/w/${ws}/budget/lines/${line}`, { category: 'Construction', description: 'Construction', revised: '180000', forecast: '20,000', notes: '' }, `/w/${ws}/budget`);
    await pm.post(`/w/${ws}/budget/commitments`, { counterparty: 'Gulf Builders', budget_line_id: line, value: '100000', committed_on: '2026-11-01', reference: 'C-1', description: '' }, `/w/${ws}/budget`);
    const commit = (await pool.query('select id from commitments where workspace_id = $1', [ws])).rows[0].id;
    await pm.post(`/w/${ws}/budget/invoices`, { supplier: 'Gulf Builders', invoice_no: 'INV-7', amount: '60000', invoice_date: '2026-11-20', budget_line_id: '', commitment_id: commit }, `/w/${ws}/budget`);
    assert.equal((await pm.post(`/w/${ws}/budget/invoices`, { supplier: 'gulf builders', invoice_no: 'INV-7', amount: '1', budget_line_id: '', commitment_id: '' }, `/w/${ws}/budget`)).status, 400);
    const inv = (await pool.query('select id from cost_invoices where workspace_id = $1', [ws])).rows[0].id;
    assert.equal((await pm.post(`/w/${ws}/budget/payments`, { payee: 'Gulf Builders', amount: '60000', invoice_id: inv, budget_line_id: '' }, `/w/${ws}/budget`)).status, 400);  // not approved yet
    await pm.post(`/w/${ws}/budget/invoices/${inv}`, { decision: 'approved' }, `/w/${ws}/budget`);
    assert.equal((await pm.post(`/w/${ws}/budget/payments`, { payee: 'Gulf Builders', amount: '60000.001', invoice_id: inv, budget_line_id: '' }, `/w/${ws}/budget`)).status, 400);  // over-payment
    assert.equal((await pm.post(`/w/${ws}/budget/payments`, { payee: 'Gulf Builders', amount: '60000', invoice_id: inv, budget_line_id: '', paid_on: '' }, `/w/${ws}/budget`)).location, `/w/${ws}/budget?msg=added`);
    const pay = (await pool.query('select id from cost_payments where workspace_id = $1', [ws])).rows[0].id;
    // the project manager cannot confirm payments; Finance can
    assert.equal((await pm.post(`/w/${ws}/budget/payments/${pay}/confirm`, { paid_on: '2026-11-25' }, `/w/${ws}/budget`)).status, 403);
    await pm.post(`/w/${ws}/access`, { user: finId, role: 'viewer' }, `/w/${ws}/access`);
    await pm.post(`/w/${ws}/access`, { user: engId, role: 'contributor' }, `/w/${ws}/access`);
    assert.equal((await eng.get(`/w/${ws}/budget`)).status, 404);            // contributor without financial access
    const page = await fin.get(`/w/${ws}/budget`);
    assert.equal(page.status, 200);
    assert.equal((await fin.post(`/w/${ws}/budget/payments/${pay}/confirm`, { paid_on: '2026-11-25' }, `/w/${ws}/budget`)).location, `/w/${ws}/budget?msg=saved`);
    const b = await pm.get(`/w/${ws}/budget`);
    const row = /<b>Construction<\/b>[\s\S]*?<\/tr>/.exec(b.text)[0];
    const cells = [...row.matchAll(/<td class="n">([\s\S]*?)<\/td>/g)].map(m => m[1].replace(/<[^>]+>/g, '').trim());
    // baseline, current, committed, incurred, paid, open commitments, forecast, EAC, variance
    assert.equal(cells[2], 'BHD 100,000.000');
    assert.equal(cells[3], 'BHD 60,000.000');
    assert.equal(cells[4], 'BHD 60,000.000');
    assert.equal(cells[5], 'BHD 40,000.000');
    assert.equal(cells[7], 'BHD 120,000.000');     // 60,000 incurred + 40,000 open + 20,000 forecast
    assert.equal(cells[8], 'BHD 60,000.000');
  });

  let upd;
  await t.test('progress updates: photos never change progress; drafts stay private; members only', async () => {
    const png = await sharp({ create: { width: 80, height: 60, channels: 3, background: '#7a5230' } }).jpeg().toBuffer();
    const before = (await pool.query('select progress from tasks where id = $1', [taskB])).rows[0].progress;
    const page = await eng.get(`/w/${ws}/updates/new`);
    const fd = new FormData();
    fd.append('_csrf', eng.csrfFrom(page.text)); fd.append('title', 'Drawings issued'); fd.append('observed_on', '2026-11-28');
    fd.append('task_id', taskB); fd.append('reported_progress', '80'); fd.append('status', 'published'); fd.append('completed_work', 'Ground floor plans issued');
    fd.append('photos', new Blob([png]), 'a.jpg'); fd.append('photos', new Blob([png]), 'b.jpg');
    const r = await eng.raw('POST', `/w/${ws}/updates`, { multipart: fd });
    assert.match(r.location, new RegExp(`^/w/${ws}/updates/`));
    upd = r.location.split('/')[4].split('?')[0];
    assert.equal((await pool.query('select progress from tasks where id = $1', [taskB])).rows[0].progress, before);   // not applied
    assert.equal((await pool.query("select count(*)::int as n from files where entity = 'progress_update' and entity_id = $1", [upd])).rows[0].n, 2);
    const view = await pm.get(`/w/${ws}/updates/${upd}`);
    assert.ok(view.text.includes('Drawings issued'));
    const photo = (await pool.query("select id from files where entity_id = $1 limit 1", [upd])).rows[0].id;
    assert.equal((await pm.raw('GET', `/files/${photo}/thumb`)).status, 200);
    const outsider = client(base);
    await login(outsider, 'fin@example.com', 'fin-password-1');
    assert.equal((await outsider.get(`/w/${other}/updates/${upd}`)).status, 404);
    // a draft by the PM is not visible to the engineer
    const p2 = await pm.get(`/w/${ws}/updates/new`);
    const fd2 = new FormData(); fd2.append('_csrf', pm.csrfFrom(p2.text)); fd2.append('title', 'Private draft'); fd2.append('observed_on', '2026-11-29'); fd2.append('status', 'draft');
    const d = (await pm.raw('POST', `/w/${ws}/updates`, { multipart: fd2 })).location.split('/')[4].split('?')[0];
    assert.equal((await eng.get(`/w/${ws}/updates/${d}`)).status, 404);
    assert.ok(!(await eng.get(`/w/${ws}/updates`)).text.includes('Private draft'));
    // the author can correct a published update; the task changes only when asked
    const ed = await eng.post(`/w/${ws}/updates/${upd}/edit`, { title: 'Drawings issued', observed_on: '2026-11-28', reported_progress: '90', workforce: '', completed_work: 'Ground floor plans issued' }, `/w/${ws}/updates/${upd}`);
    assert.equal(ed.status, 302);
    assert.equal((await pool.query('select reported_progress from progress_updates where id = $1', [upd])).rows[0].reported_progress, 90);
    assert.equal((await pool.query('select progress from tasks where id = $1', [taskB])).rows[0].progress, before);
    assert.equal((await pool.query("select count(*)::int as n from audit_events where action = 'update.edited'")).rows[0].n, 1);
    assert.equal((await eng.post(`/w/${ws}/updates/${upd}/edit`, { title: 'x', observed_on: '2026-11-28', reported_progress: '150' }, `/w/${ws}/updates/${upd}`)).status, 400);
  });

  await t.test('exports: real PDF and xlsx, formula text neutralised, finance sheets only for finance roles', async () => {
    await pm.post(`/w/${ws}/tasks`, { title: '=HYPERLINK("http://evil","x")', phase_id: '', owner_text: '', start_date: '', due_date: '' }, `/w/${ws}/tasks`);
    const x = await pm.raw('GET', `/w/${ws}/export.xlsx?from=2026-11-01&to=2026-11-30`);
    assert.equal(x.status, 200);
    const buf = Buffer.from(await x.res.arrayBuffer());
    assert.equal(buf.subarray(0, 2).toString(), 'PK');
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf);
    assert.ok(wb.getWorksheet('Budget'));
    const titles = []; wb.getWorksheet('Tasks').eachRow(r => titles.push(r.getCell(2).value));
    assert.ok(titles.includes('\'=HYPERLINK("http://evil","x")'));
    assert.ok(!titles.some(v => typeof v === 'object' && v && v.formula));
    const ex = await eng.raw('GET', `/w/${ws}/export.xlsx`);
    const wb2 = new ExcelJS.Workbook(); await wb2.xlsx.load(Buffer.from(await ex.res.arrayBuffer()));
    assert.equal(wb2.getWorksheet('Budget'), undefined);              // no financial access
    const pdf = await pm.raw('GET', `/w/${ws}/export.pdf?photos=1`);
    assert.equal(pdf.status, 200);
    const pb = Buffer.from(await pdf.res.arrayBuffer());
    assert.equal(pb.subarray(0, 5).toString(), '%PDF-');
    assert.ok(pb.length > 5000);
    assert.equal((await pm.raw('GET', `/w/${ws}/export.pdf?from=2026-12-01&to=2026-11-01`)).status, 400);
    const acts = (await pool.query("select action from audit_events where workspace_id = $1 and action like 'report.%'", [ws])).rows.length;
    assert.ok(acts >= 3);
  });

  await t.test('portfolio shows progress and next milestone per project', async () => {
    const list = await pm.get('/s/dev');
    assert.match(list.text, /Hamala Townhouses/);
    assert.match(list.text, /Next milestone/);
  });
});
