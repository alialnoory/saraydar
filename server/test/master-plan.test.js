'use strict';
// Construction master plan: shared template copied per project, weighted progress, weight redistribution,
// stable references, Gantt, safe replacement of an old plan with restore, procurement, permissions.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const db = require('../db');
const { createApp } = require('../app');
const M = require('../lib/master-plan');
const { client, asLegacy } = require('./helpers');

const URL_ = process.env.TEST_DATABASE_URL;

test('the baseline template is complete and valid', () => {
  assert.deepEqual(M.validateTemplate(M.BASELINE), []);
  assert.equal(M.BASELINE.length, 10);
  assert.equal(M.BASELINE.reduce((s, x) => s + x.tasks.length, 0), 56);
  assert.deepEqual(M.BASELINE.map(s => s.weight), [4, 6, 5, 15, 25, 15, 20, 5, 4, 1]);
  assert.equal(M.BASELINE[6].tasks[9].title, 'Carry out finishing inspections and corrections');
  assert.equal(M.BASELINE[8].endWeek, 59);                       // handover about week 59
});

test('weighted progress, status rules and redistribution', () => {
  const ph = [{ id: 'a', name: 'A', weight: 25 }, { id: 'b', name: 'B', weight: 75 }, { id: 'c', name: 'Empty', weight: 0 }];
  const ts = [{ id: 1, phase_id: 'a', weight: 50, status: 'in_progress', progress: 80 }, { id: 2, phase_id: 'a', weight: 50, status: 'in_progress', progress: 40 },
    { id: 3, phase_id: 'b', weight: 100, status: 'not_started', progress: 0 }];
  const c = M.compute(ph, ts);
  assert.ok(c.valid); assert.equal(c.pct, 15);                     // a 25% stage at 60% contributes 15 points; empty zero-weight stage is fine
  assert.equal(c.stages[0].status, 'in_progress'); assert.equal(c.stages[2].status, 'not_started');
  ts.forEach(t => { t.status = 'done'; });
  assert.equal(M.compute(ph, ts).pct, 100);
  const bad = M.compute([{ id: 'a', name: 'A', weight: 60 }, { id: 'b', name: 'B', weight: 30 }], []);
  assert.equal(bad.valid, false); assert.equal(bad.pct, null); assert.match(bad.issues.join(' '), /90%/);
  assert.deepEqual(M.reconcile('not_started', 10), { status: 'in_progress', progress: 10 });
  assert.deepEqual(M.reconcile('in_progress', 100), { status: 'done', progress: 100 });
  assert.equal(M.reconcile('done', 0).progress, 100);
  assert.equal(M.reconcile('on_hold', 40).status, 'on_hold');
  assert.throws(() => M.reconcile('in_progress', 140));
  const s = M.scaleTo([1, 1, 1]); assert.equal(Math.round(s.reduce((x, y) => x + y, 0) * 1000), 100000);
  assert.deepEqual(M.scaleTo([0, 0]), [50, 50]);
  const w = M.withNew([20, 20, 20, 20, 20], 10); assert.deepEqual(w.others, [18, 18, 18, 18, 18]); assert.equal(w.added, 10);
  assert.deepEqual(M.procurementDates({ needed_on: '2027-06-01', lead_days: 60, buffer_days: 7, approval_days: 14, status: 'planned' }, '2027-01-01'), { order: '2027-03-26', approval: '2027-03-12', late: null });
  assert.equal(M.procurementDates({ needed_on: '2027-06-01', lead_days: 60, status: 'planned' }, '2027-05-01').late, 'order');
  assert.equal(M.procurementDates({ needed_on: '2027-06-01', lead_days: 60, status: 'ordered' }, '2027-05-01').late, null);
});

test('construction master plan', { skip: !URL_ && 'set TEST_DATABASE_URL to run' }, async t => {
  const pool = new Pool({ connectionString: URL_ });
  await pool.query('drop schema public cascade; create schema public;');
  await db.migrate(pool); await db.seed(pool);
  await db.ensureAdmin(pool, { ADMIN_EMAIL: 'ali@example.com', ADMIN_PASSWORD: 'admin-pass-123' });
  const app = createApp({ pool, jwtSecret: 'm'.repeat(40), corsOrigins: [], env: {} }).listen(0);
  t.after(async () => { app.close(); await pool.end(); });
  const base = `http://127.0.0.1:${app.address().port}`;
  const admin = client(base);
  await admin.post('/login', { identifier: 'ali@example.com', password: 'admin-pass-123' }, '/login');
  const q = async (s, v) => (await pool.query(s, v)).rows;
  const q1 = async (s, v) => (await q(s, v))[0];
  const wsOf = r => r.location.slice(3, 39);
  const live = ws => q('select * from phases where workspace_id = $1 and archived_at is null order by sort', [ws]);
  const liveTasks = (ws, pid) => q('select * from tasks where workspace_id = $1 and phase_id = $2 and archived_at is null order by sort', [ws, pid]);
  const sum = a => Math.round(a.reduce((s, x) => s + Number(x.weight), 0) * 1000) / 1000;

  let A, B, C;
  await t.test('new projects in both sections get their own copy of the template', async () => {
    A = wsOf(await admin.post('/s/dev/new', { kind: 'project', name: 'Saar Villas' }, '/s/dev/new'));
    B = wsOf(await admin.post('/s/dev/new', { kind: 'project', name: 'Hidd Villas' }, '/s/dev/new'));
    C = wsOf(await admin.post('/s/cpm/new', { kind: 'client_project', name: 'Client Villa', party: 'Noor Family' }, '/s/cpm/new'));
    for (const ws of [A, B, C]) {
      const ph = await live(ws);
      assert.equal(ph.length, 10); assert.equal(sum(ph), 100);
      assert.equal((await q1('select count(*)::int as n from tasks where workspace_id = $1', [ws])).n, 56);
      assert.ok(await q1('select 1 from master_plans where workspace_id = $1', [ws]));
    }
    const page = await admin.get(`/w/${C}/master`);
    assert.equal(page.status, 200);
    assert.match(page.text, /Groundworks and foundations/); assert.match(page.text, /mp-pipe/); assert.match(page.text, /Overall progress \(weighted\)/);
    assert.match((await admin.get(`/w/${A}`)).text, /Construction stages/);          // pipeline on the overview
    assert.equal((await admin.get(`/w/${A}/tasks`)).location, `/w/${A}/master`);
  });

  await t.test('editing one project never changes another; progress follows the weights', async () => {
    const t41 = await q1("select t.* from tasks t where t.workspace_id = $1 and t.template_key = '4.1'", [A]);
    await admin.post(`/w/${A}/master/tasks/${t41.id}`, { title: 'Survey and set out plots 1–4', status: 'in_progress', progress: '100', owner_text: 'Site engineer', start_date: '2027-01-10', due_date: '2027-01-20' }, `/w/${A}/master`);
    const after = await q1('select * from tasks where id = $1', [t41.id]);
    assert.equal(after.title, 'Survey and set out plots 1–4'); assert.equal(after.status, 'done'); assert.equal(after.progress, 100);   // 100% means completed
    assert.equal((await q1("select title from tasks where workspace_id = $1 and template_key = '4.1'", [B])).title, 'Survey, set out and prepare the site');
    // 4.1 is 10% of a 15% stage → 1.5 points
    assert.match((await admin.get(`/w/${A}/master`)).text, /Overall progress \(weighted\)<\/div><div class="big">1\.5%/);
    assert.match((await admin.get(`/w/${B}/master`)).text, /<div class="big">0%/);
  });

  await t.test('adding and removing keeps weights at 100% and references stable', async () => {
    const s4 = (await live(A))[3];
    const before = await liveTasks(A, s4.id);
    const ids = before.map(x => x.id);
    const pv = await admin.post(`/w/${A}/master/tasks`, { phase_id: s4.id, title: 'Soil test report', weight: '10', mode: 'scale' }, `/w/${A}/master`);
    assert.equal(pv.status, 200); assert.match(pv.text, /Confirm/);                               // preview first
    assert.equal((await liveTasks(A, s4.id)).length, 6);
    await admin.post(`/w/${A}/master/tasks`, { phase_id: s4.id, title: 'Soil test report', weight: '10', mode: 'scale', confirm: '1' }, `/w/${A}/master`);
    const after = await liveTasks(A, s4.id);
    assert.equal(after.length, 7); assert.equal(sum(after), 100);
    assert.deepEqual(after.slice(0, 6).map(x => x.id), ids);                                     // same ids, renumbered display only
    assert.equal(Number(after[0].weight), 9);                                                   // 10 × 0.9
    // move the new task to the top: ids unchanged, order changed
    const neu = after[6];
    for (let i = 0; i < 6; i++) await admin.post(`/w/${A}/master/tasks/${neu.id}/move`, { dir: 'up' }, `/w/${A}/master`);
    assert.equal((await liveTasks(A, s4.id))[0].id, neu.id);
    // remove a stage with proportional redistribution: weights add to 100, item restorable
    const s10 = (await live(A))[9];
    const form = await admin.get(`/w/${A}/master/stages/${s10.id}/remove`);
    assert.match(form.text, /percentage points/);
    await admin.post(`/w/${A}/master/stages/${s10.id}/remove`, { mode: 'scale' }, `/w/${A}/master/stages/${s10.id}/remove`);
    const ph = await live(A);
    assert.equal(ph.length, 9); assert.equal(sum(ph), 100);
    assert.match((await admin.get(`/w/${A}/master/history`)).text, /Defects and closeout/);
    await admin.post(`/w/${A}/master/restore-item`, { kind: 'stage', item: s10.id }, `/w/${A}/master/history`);
    assert.equal((await live(A)).length, 10);
    assert.equal((await liveTasks(A, s10.id)).length, 4);                                       // its tasks came back with it
    assert.match((await admin.get(`/w/${A}/master`)).text, /weights are incomplete/);             // 101% until rebalanced
    // invalid weights are refused and nothing is saved; scaling fixes them
    const w = Object.fromEntries((await live(A)).map(p => [`sw_${p.id}`, '10']));
    const tw = {}; for (const p of await live(A)) for (const x of await liveTasks(A, p.id)) tw[`tw_${x.id}`] = String(Number(x.weight));
    assert.equal((await admin.post(`/w/${A}/master/weights`, { ...w, ...tw, [`sw_${s10.id}`]: '5' }, `/w/${A}/master/weights`)).status, 400);
    await admin.post(`/w/${A}/master/weights`, { ...Object.fromEntries((await live(A)).map(p => [`sw_${p.id}`, String(Number(p.weight))])), ...tw, scale: 'sw' }, `/w/${A}/master/weights`);
    assert.equal(sum(await live(A)), 100);
    assert.doesNotMatch((await admin.get(`/w/${A}/master`)).text, /weights are incomplete/);
  });

  await t.test('all work complete gives exactly 100%; on hold and stage details', async () => {
    await pool.query("update tasks set status = 'done', progress = 100 where workspace_id = $1", [B]);
    assert.match((await admin.get(`/w/${B}/master`)).text, /<div class="big">100%<\/div>/);
    const s5 = (await live(B))[4];
    await admin.post(`/w/${B}/master/stages/${s5.id}`, { name: 'Structural frame', hold: '1', planned_start: '2027-03-01', planned_end: '2027-02-01' }, `/w/${B}/master`).then(r => assert.equal(r.status, 400));
    await admin.post(`/w/${B}/master/stages/${s5.id}`, { name: 'Structural frame', hold: '1', owner_text: 'Gulf Builders' }, `/w/${B}/master`);
    assert.match((await admin.get(`/w/${B}/master`)).text, /On hold/);
  });

  await t.test('illustrative schedule and the project-specific Gantt chart', async () => {
    assert.match((await admin.get(`/w/${C}/master/gantt`)).text, /No planned dates yet/);       // nothing invented
    await admin.post(`/w/${C}/master/schedule`, { anchor: '2027-01-03', defects_months: '12', mode: 'empty' }, `/w/${C}/master`);
    const s9 = (await live(C))[8], s10 = (await live(C))[9];
    assert.equal(String(s9.planned_end).slice(0, 10), M.addDays('2027-01-03', 59 * 7 - 1));
    assert.ok(String(s10.planned_start) > String(s9.planned_end));                                               // defects period after handover
    const g = await admin.get(`/w/${C}/master/gantt`);
    assert.equal(g.status, 200); assert.match(g.text, /gt-bar/); assert.match(g.text, /gt-ms/); assert.match(g.text, /Overlapping stages/);
    assert.doesNotMatch(g.text, /Saar Villas|Survey and set out plots/);                        // only this project
    // a manual date change shows on the chart
    const t11 = await q1("select id from tasks where workspace_id = $1 and template_key = '1.1'", [C]);
    await admin.post(`/w/${C}/master/tasks/${t11.id}`, { title: 'Define project scope, requirements and intended outcome', start_date: '2027-02-01', due_date: '2027-02-05', status: 'not_started', progress: '0' }, `/w/${C}/master`);
    assert.match((await admin.get(`/w/${C}/master/gantt`)).text, /1 Feb 2027 – 5 Feb 2027/);
  });

  await t.test('an existing project: preview, confirm, archive and restore', async () => {
    const L = wsOf(await admin.post('/s/dev/new', { kind: 'project', name: 'Old Plan Villas' }, '/s/dev/new'));
    await asLegacy(pool, L);
    const ph = (await pool.query("insert into phases (workspace_id, name, sort, weight) values ($1,'Construction',0,100) returning id", [L])).rows[0].id;
    const keep = (await pool.query("insert into tasks (workspace_id, phase_id, title, status, progress, start_date, due_date, owner_text) values ($1,$2,'Pour and inspect foundation concrete','in_progress',40,'2026-11-01','2026-11-20','Gulf Builders') returning id", [L, ph])).rows[0].id;
    const lost = (await pool.query("insert into tasks (workspace_id, phase_id, title, status, progress) values ($1,$2,'Hoarding around the site','done',100) returning id", [L, ph])).rows[0].id;
    const prev = await admin.get(`/w/${L}/master`);
    assert.match(prev.text, /Move this project to the construction master plan/);
    assert.match(prev.text, /Matched \(100% similar\)/);                                          // confident match only
    assert.equal((await admin.post(`/w/${L}/master/adopt`, { [`map_${keep}`]: '4.4', [`map_${lost}`]: '' }, `/w/${L}/master`)).status, 400);   // confirmation required
    await admin.post(`/w/${L}/master/adopt`, { [`map_${keep}`]: '4.4', [`map_${lost}`]: '', confirm: '1' }, `/w/${L}/master`);
    const t44 = await q1("select * from tasks where workspace_id = $1 and template_key = '4.4' and archived_at is null", [L]);
    assert.equal(t44.progress, 40); assert.equal(t44.owner_text, 'Gulf Builders'); assert.equal(String(t44.start_date).slice(0, 10), '2026-11-01');
    assert.ok((await q1('select archived_at from tasks where id = $1', [lost])).archived_at);       // kept, archived
    const ar = await q1('select * from plan_archives where workspace_id = $1', [L]);
    assert.deepEqual(ar.task_ids.sort(), [keep, lost].sort());
    assert.match((await admin.get(`/w/${L}/master/history?v=${ar.id}`)).text, /Hoarding around the site/);
    await admin.post(`/w/${L}/master/restore/${ar.id}`, {}, `/w/${L}/master/history`);
    assert.equal((await q1('select count(*)::int as n from tasks where workspace_id = $1 and archived_at is null', [L])).n, 2);
    assert.equal(await q1('select 1 from master_plans where workspace_id = $1', [L]), undefined);
    assert.equal((await q1('select count(*)::int as n from plan_archives where workspace_id = $1', [L])).n, 2);   // the master version is archived too
  });

  await t.test('procurement tracker warns about past deadlines', async () => {
    await admin.post(`/w/${A}/master/procurement`, { item: 'Aluminium windows', responsible: 'Procurement', needed_on: '2020-03-01', approval_days: '14', lead_days: '60', buffer_days: '7', status: 'planned' }, `/w/${A}/master/procurement`);
    const p = await admin.get(`/w/${A}/master/procurement`);
    assert.match(p.text, /Aluminium windows/); assert.match(p.text, /Past due/); assert.match(p.text, /past the latest/);
    assert.match((await admin.get(`/w/${B}/master/procurement`)).text, /No items yet/);
  });

  await t.test('view-only members cannot edit; the template is the Super Admin\'s; changes never touch existing projects', async () => {
    const pw = 'viewer-pass-12345';
    const vid = (await pool.query("insert into users (email, name, kind, password_hash, active) values ('viewer@example.com','Viewer','internal',$1,true) returning id", [await db.hashPassword(pw)])).rows[0].id;
    await pool.query("insert into workspace_members (workspace_id, user_id, role, added_by) values ($1,$2,'viewer',$2)", [A, vid]);
    const v = client(base); await v.post('/login', { identifier: 'viewer@example.com', password: pw }, '/login');
    assert.equal((await v.get(`/w/${A}/master`)).status, 200);
    const t = await q1("select id from tasks where workspace_id = $1 and template_key = '5.1'", [A]);
    assert.equal((await v.post(`/w/${A}/master/tasks/${t.id}`, { status: 'done' }, `/w/${A}/master`)).status, 403);
    assert.equal((await v.post(`/w/${A}/master/weights`, {}, `/w/${A}/master/weights`)).status, 403);
    assert.equal((await v.get('/admin/master-plan')).status, 404);   // administration stays out of sight
    // admin saves a new template version: future projects only
    const tplPage = await admin.get('/admin/master-plan');
    assert.match(tplPage.text, /Version <b>1<\/b>/);
    const form = {}; M.BASELINE.forEach((s, i) => { form[`key_${i}`] = s.key; form[`name_${i}`] = i === 0 ? 'Project start-up' : s.name; form[`weight_${i}`] = String(s.weight); form[`duration_${i}`] = s.duration; form[`start_${i}`] = s.startWeek ?? ''; form[`end_${i}`] = s.endWeek ?? ''; if (s.afterHandover) form[`after_${i}`] = '1'; form[`tasks_${i}`] = s.tasks.map(x => `${x.title} | ${x.weight}`).join('\n'); });
    assert.equal((await admin.post('/admin/master-plan', { ...form, weight_0: '50' }, '/admin/master-plan')).status, 400);   // must add up to 100
    await admin.post('/admin/master-plan', form, '/admin/master-plan');
    assert.equal((await q1("select version from master_templates where key = 'construction'")).version, 2);
    assert.equal((await live(B))[0].name, 'Project setup');
    const D = wsOf(await admin.post('/s/dev/new', { kind: 'project', name: 'New After Change' }, '/s/dev/new'));
    assert.equal((await live(D))[0].name, 'Project start-up');
  });

  await t.test('renovation: chosen at creation or switched later; the old plan is archived', async () => {
    const R1 = wsOf(await admin.post('/s/cpm/new', { kind: 'client_project', name: 'Bait Test', works: 'renovation' }, '/s/cpm/new'));
    const st = await live(R1);
    assert.equal(st.length, 11);
    assert.equal(st[1].name, 'Survey and condition assessment');
    assert.equal((await q1('select template_key from master_plans where workspace_id = $1', [R1])).template_key, 'renovation');
    const N = wsOf(await admin.post('/s/cpm/new', { kind: 'client_project', name: 'Switch Me' }, '/s/cpm/new'));
    assert.equal((await live(N)).length, 10);
    assert.equal((await admin.post(`/w/${N}/master/type`, { template: 'renovation' }, `/w/${N}/master`)).status, 400);   // needs the confirmation
    await admin.post(`/w/${N}/master/type`, { template: 'renovation', confirm: '1' }, `/w/${N}/master`);
    assert.equal((await live(N))[4].name, 'Strip-out and temporary works');
    assert.equal((await q1('select count(*)::int as n from plan_archives where workspace_id = $1', [N])).n, 1);
    assert.match((await admin.get(`/w/${N}/master`)).text, /Type of works:<\/b> Renovation of an existing house/);
    assert.match((await admin.get('/admin/master-plan?t=renovation')).text, /Strip-out and temporary works/);
  });
});

test('one-time move of existing projects: fresh master plan, old plan deleted', { skip: !URL_ && 'set TEST_DATABASE_URL to run' }, async () => {
  const MS = require('../lib/master-store');
  const pool = new Pool({ connectionString: URL_ });
  try {
    await pool.query('drop schema public cascade; create schema public;');
    await db.migrate(pool); await db.seed(pool);
    const mk = async (ref, status, section = 'dev') => (await pool.query("insert into workspaces (section, kind, ref, name, status) values ($1, $2, $3, $3, $4) returning id", [section, section === 'dev' ? 'project' : 'client_project', ref, status])).rows[0].id;
    const act = await mk('DEV-T-1', 'active'), cpm = await mk('CPM-T-1', 'on_hold', 'cpm'), fin = await mk('DEV-T-2', 'completed');
    for (const ws of [act, cpm, fin]) {
      const ph = (await pool.query("insert into phases (workspace_id, name, weight) values ($1,'Construction',100) returning id", [ws])).rows[0].id;
      const t = (await pool.query("insert into tasks (workspace_id, phase_id, title, status, progress) values ($1,$2,'Old task','in_progress',50) returning id", [ws, ph])).rows[0].id;
      await pool.query("insert into comments (workspace_id, entity, entity_id, body) values ($1,'task',$2,'old comment')", [ws, t]);
      await pool.query("insert into progress_updates (workspace_id, task_id, title, observed_on, status) values ($1,$2,'Site visit',current_date,'published')", [ws, t]);
      await pool.query("insert into plans (workspace_id, version, status) values ($1, 1, 'approved')", [ws]);
    }
    const done = await MS.convertExisting(pool, { log: () => {} });
    assert.ok(done.some(x => x.startsWith('DEV-T-1')) && done.some(x => x.startsWith('CPM-T-1')) && !done.some(x => x.startsWith('DEV-T-2')));
    for (const ws of [act, cpm]) {
      const tasks = (await pool.query('select * from tasks where workspace_id = $1', [ws])).rows;
      assert.equal(tasks.length, 56);
      assert.ok(tasks.every(t => t.progress === 0 && t.status === 'not_started' && !t.start_date));
      assert.equal((await pool.query("select count(*)::int as n from comments where workspace_id = $1 and entity = 'task'", [ws])).rows[0].n, 0);
      const up = (await pool.query('select * from progress_updates where workspace_id = $1', [ws])).rows;
      assert.equal(up.length, 1); assert.equal(up[0].task_id, null);                         // the report and photos stay
      assert.deepEqual((await pool.query('select status, version from plans where workspace_id = $1', [ws])).rows, [{ status: 'draft', version: 1 }]);
      assert.ok((await pool.query("select 1 from audit_events where workspace_id = $1 and action = 'master.converted'", [ws])).rowCount);
    }
    assert.equal((await pool.query("select title from tasks where workspace_id = $1", [fin])).rows[0].title, 'Old task');   // completed: untouched
    assert.equal(await MS.convertExisting(pool, { log: () => {} }), null);                                                // runs once
  } finally { await pool.end(); }
});
