'use strict';
// PDF/Excel export of any page, and the Back / Home / Next navigation bar.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const ExcelJS = require('exceljs');
const db = require('../db');
const { createApp } = require('../app');
const pe = require('../lib/page-export');
const { client, asLegacy } = require('./helpers');

const URL_ = process.env.TEST_DATABASE_URL;

test('page extraction keeps data, drops forms; numbers typed; formulas neutralised', () => {
  const page = pe.extract(`<html><head><title>x</title></head><body><header class="band"><nav class="crumbs"><a>Home</a> › <span>P</span></nav><div class="band-title"><div class="eyebrow">DEV-1</div><h1>Project A</h1></div><nav class="tabs"><a aria-current="page">Budget</a></nav></header>
    <main><div class="pagenav"><a>Back</a></div><section class="panel"><h2>Lines</h2><table><thead><tr><th>Line</th><th>Amount</th></tr></thead><tbody>
    <tr><td>Land<form><input value="secret"></form></td><td>BHD 1,250.500</td></tr><tr><td>=HYPERLINK("x")</td><td>45%</td></tr></tbody></table>
    <dl class="details"><div><dt>Status</dt><dd>Active</dd></div></dl><form><input name="password" value="p"></form></section></main></body></html>`);
  assert.equal(page.title, 'Project A'); assert.equal(page.tab, 'Budget'); assert.equal(page.eyebrow, 'DEV-1');
  const table = page.blocks.find(b => b.kind === 'table');
  assert.deepEqual(table.head, ['Line', 'Amount']);
  assert.deepEqual(table.rows[0], ['Land', 'BHD 1,250.500']);
  assert.ok(!JSON.stringify(page).includes('secret') && !JSON.stringify(page).includes('Back'));
  assert.deepEqual(page.blocks.find(b => b.kind === 'kv').pairs, [['Status', 'Active']]);
  assert.deepEqual(pe.typed('BHD 1,250.500'), { v: 1250.5, fmt: '"BHD" #,##0.000' });
  assert.equal(pe.typed('45%').v, 0.45);
  assert.equal(pe.typed('=HYPERLINK("x")').v, '\'=HYPERLINK("x")');
  assert.equal(pe.typed('00123').v, '00123');       // reference numbers stay text
});

test('export and navigation', { skip: !URL_ && 'set TEST_DATABASE_URL to run' }, async t => {
  const pool = new Pool({ connectionString: URL_ });
  await pool.query('drop schema public cascade; create schema public;');
  await db.migrate(pool); await db.seed(pool);
  await db.ensureAdmin(pool, { ADMIN_EMAIL: 'ali@example.com', ADMIN_PASSWORD: 'admin-pass-123' });
  const server = createApp({ pool, jwtSecret: 'e'.repeat(40), corsOrigins: [], env: {} }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.close(); await pool.end(); });
  const login = (c, i, p) => c.post('/login', { identifier: i, password: p }, '/login');
  const admin = client(base); await login(admin, 'ali@example.com', 'admin-pass-123');
  const file = async (c, path) => { const r = await c.raw('GET', path); return { status: r.status, type: r.res.headers.get('content-type') || '', buf: r.status === 200 ? Buffer.from(await r.res.arrayBuffer()) : null }; };
  const sheets = async buf => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf); return wb; };

  const ids = [];
  for (let i = 1; i <= 23; i++) ids.push((await admin.post('/s/dev/new', { kind: 'project', name: `Project ${String(i).padStart(2, '0')}` }, '/s/dev/new')).location.slice(3, 39));
  const ws = ids[0];
  await asLegacy(pool, ws);
  await admin.post(`/w/${ws}/tasks`, { title: '=cmd|"/c calc"!A0', phase_id: '', owner_text: '', start_date: '', due_date: '' }, `/w/${ws}/tasks`);
  await admin.post(`/w/${ws}/plots`, { ref: '1201', area_m2: '175.1', status: 'owned', purchase_price: '62500' }, `/w/${ws}/plots`);

  await t.test('every data page offers PDF and Excel, plus Back / Home', async () => {
    for (const p of ['/', '/s/dev', `/w/${ws}`, `/w/${ws}/plots`, `/w/${ws}/budget`, `/w/${ws}/tasks`, `/w/${ids[1]}/master`, `/w/${ids[1]}/master/weights`, `/w/${ws}/registers`, `/w/${ws}/access`, '/admin/users', '/admin/audit']) {
      const page = await admin.get(p);
      assert.equal(page.status, 200, p);
      assert.match(page.text, /data-back><svg[^<]*<path[^>]*\/><\/svg>Back<\/a>/, p);
      assert.match(page.text, /export=pdf/, p);
      assert.match(page.text, /export=xlsx/, p);
    }
    const plots = await admin.get(`/w/${ws}/plots`);
    assert.match(plots.text, /class="band-actions"><div class="pagenav"/);     // in the title row of the ribbon
    assert.doesNotMatch(plots.text, /aria-label="Tabs"/);                      // no previous/next tab buttons
    assert.doesNotMatch((await admin.get('/account/password')).text, /export=pdf/);   // nothing to export on a form
  });

  await t.test('exports are real files with the page data, all rows, formulas neutralised, audited', async () => {
    const x = await file(admin, '/s/dev?export=xlsx');
    assert.match(x.type, /spreadsheetml/);
    const wb = await sheets(x.buf);
    const table = wb.worksheets.find(w => w.name !== 'Summary');
    const names = []; table.eachRow((r, i) => { if (i > 1) names.push(r.getCell(1).value); });
    assert.equal(names.length, 24);                         // 23 new + Abuquwa: no paging in exports
    const p = await file(admin, '/s/dev?export=pdf');
    assert.equal(p.buf.subarray(0, 5).toString(), '%PDF-');
    const pages = buf => (buf.toString('latin1').match(/\/Type \/Page\b/g) || []).length;
    assert.equal(pages((await file(admin, '/?export=pdf')).buf), 1);            // no empty extra page after the footer
    const t2 = await sheets((await file(admin, `/w/${ws}/tasks?export=xlsx`)).buf);
    const vals = []; t2.worksheets.forEach(w => w.eachRow(r => r.eachCell(c => vals.push(c.value))));
    assert.ok(vals.includes('\'=cmd|"/c calc"!A0'));
    assert.ok(!vals.some(v => v && typeof v === 'object' && v.formula));
    const pl = await sheets((await file(admin, `/w/${ws}/plots?export=xlsx`)).buf);
    const nums = []; pl.worksheets.forEach(w => w.eachRow(r => r.eachCell(c => { if (typeof c.value === 'number') nums.push(c.value); })));
    assert.ok(nums.includes(62500));                        // money exported as a number, not text
    for (const pth of [`/w/${ws}/budget`, `/w/${ws}?`, '/admin/audit?', `/w/${ws}/registers?kind=risk&`]) {
      const sep = pth.endsWith('?') || pth.endsWith('&') ? '' : '?';
      assert.equal((await file(admin, `${pth}${sep}export=pdf`)).status, 200, pth);
    }
    const n = (await pool.query("select count(*)::int as n from audit_events where action in ('export.pdf','export.xlsx')")).rows[0].n;
    assert.ok(n >= 8);
  });

  await t.test('exports never show more than the page: permissions and isolation hold', async () => {
    await admin.post('/admin/users', { name: 'Eng', email: 'eng@example.com', kind: 'internal', system_role: 'engineer', password: 'eng-temp-pass-1' }, '/admin/users');
    const eng = client(base); await login(eng, 'eng@example.com', 'eng-temp-pass-1');
    await eng.post('/account/password', { current: 'eng-temp-pass-1', password: 'eng-own-pass-1', confirm: 'eng-own-pass-1' }, '/account/password');
    assert.equal((await file(eng, `/w/${ws}/budget?export=xlsx`)).status, 404);
    assert.equal((await file(eng, '/admin/users?export=pdf')).status, 404);
    const list = await sheets((await file(eng, '/s/dev?export=xlsx')).buf);
    assert.equal(list.worksheets.length, 1);                // no projects visible → summary only
    const engId = (await pool.query("select id from users where email = 'eng@example.com'")).rows[0].id;
    await admin.post(`/w/${ws}/access`, { user: engId, role: 'contributor' }, `/w/${ws}/access`);
    const plots = await sheets((await file(eng, `/w/${ws}/plots?export=xlsx`)).buf);
    const vals = []; plots.worksheets.forEach(w => w.eachRow(r => r.eachCell(c => vals.push(String(c.value)))));
    assert.ok(vals.includes('1201'));
    assert.ok(!vals.some(v => v.includes('62500') || v.includes('62,500')));   // purchase price hidden for this role
  });
});
