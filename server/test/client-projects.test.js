'use strict';
// Phase 4 — Clients Projects Management: clients, management-agreement terms, SarayDar fee ledger
// (invoice → partial payment → allocation → receipt → credit/void/reversal → statement), client-funded
// expenditure kept separate, client approvals with evidence, and workspace isolation.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const db = require('../db');
const { createApp } = require('../app');
const fees = require('../lib/fees');
const { client } = require('./helpers');

const URL_ = process.env.TEST_DATABASE_URL;

test('fee calculations: daily proration, mid-month fee change, tax rounding', () => {
  const v1 = { id: 'a', version: 1, status: 'superseded', start_date: '2026-01-10', end_date: null, effective_from: '2026-01-10', monthly_fee_minor: 1500000, proration: 'daily', currency: 'BHD' };
  const v2 = { ...v1, id: 'b', version: 2, status: 'active', effective_from: '2026-03-16', monthly_fee_minor: 1800000 };
  const jan = fees.monthlyLines([v1, v2], '2026-01');
  assert.equal(jan.lines.length, 1);
  assert.equal(jan.lines[0].amount, Math.round(1500000 * 22 / 31));       // 10–31 Jan = 22 days
  const feb = fees.monthlyLines([v1, v2], '2026-02');
  assert.equal(feb.lines[0].amount, 1500000);                               // full month
  const mar = fees.monthlyLines([v1, v2], '2026-03');
  assert.deepEqual(mar.lines.map(l => l.amount), [Math.round(1500000 * 15 / 31), Math.round(1800000 * 16 / 31)]);
  assert.equal(fees.monthlyLines([v1, v2], '2025-12').lines.length, 0);    // before the agreement
  assert.equal(fees.monthlyLines([{ ...v1, proration: 'none' }], '2026-01').lines[0].amount, 1500000);
  assert.equal(fees.taxOf(1234567, 'rate', 1000), 123457);                  // 10%, half-up on the last mil
  assert.equal(fees.taxOf(1234567, 'none', 1000), 0);
  assert.equal(fees.mulDiv(5, 1, 2), 3);
});

test('client projects', { skip: !URL_ && 'set TEST_DATABASE_URL to run' }, async t => {
  const pool = new Pool({ connectionString: URL_ });
  await pool.query('drop schema public cascade; create schema public;');
  await db.migrate(pool); await db.seed(pool);
  await db.ensureAdmin(pool, { ADMIN_EMAIL: 'ali@example.com', ADMIN_PASSWORD: 'admin-pass-123' });
  const server = createApp({ pool, jwtSecret: 'c'.repeat(40), corsOrigins: [], env: {} }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.close(); await pool.end(); });
  const login = (c, i, p) => c.post('/login', { identifier: i, password: p }, '/login');
  const admin = client(base); await login(admin, 'ali@example.com', 'admin-pass-123');
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bahrain' });
  const month = today.slice(0, 7);
  const q1 = async sql => (await pool.query(sql)).rows[0];
  const pdf = async (c, path) => { const r = await c.raw('GET', path); return { status: r.status, head: r.status === 200 ? Buffer.from(await r.res.arrayBuffer()).subarray(0, 5).toString() : '' }; };

  let clientA, clientB, p1, p2, p3;
  await t.test('client register and several projects per client', async () => {
    let r = await admin.post('/clients', { kind: 'company', name: 'Al Noor Holdings', contact_person: 'Fatima', phone: '+973 3333 0000', email: 'f@alnoor.bh', billing_name: 'Al Noor Holdings W.L.L.', billing_address: 'Manama', approval_authorities: 'Fatima (budgets)\nYousif (payments)' }, '/clients/new');
    assert.equal(r.status, 302); clientA = r.location.slice(9, 45);
    r = await admin.post('/clients', { kind: 'person', name: 'Hassan Ali' }, '/clients/new'); clientB = r.location.slice(9, 45);
    assert.equal((await admin.post('/clients', { kind: 'person', name: 'al noor holdings' }, '/clients/new')).status, 400);   // duplicate
    const mk = async (name, party) => (await admin.post('/s/cpm/new', { kind: 'client_project', name, party, location: 'Saar' }, '/s/cpm/new')).location.slice(3, 39);
    p1 = await mk('Al Noor Villa', 'Al Noor Holdings'); p2 = await mk('Al Noor Offices', 'Al Noor Holdings'); p3 = await mk('Hassan House', 'Hassan Ali');
    assert.equal((await q1(`select count(distinct party_id)::int as n from workspaces where id in ('${p1}','${p2}','${p3}')`)).n, 2);
    const list = await admin.get('/s/cpm');
    assert.match(list.text, /<dt>Client<\/dt><dd>Al Noor Holdings/); assert.match(list.text, /Unpaid fees/);
    const prof = await admin.get(`/clients/${clientA}`);
    assert.match(prof.text, /Al Noor Villa/); assert.match(prof.text, /Al Noor Offices/); assert.doesNotMatch(prof.text, /Hassan House/);
    for (const p of ['client', 'setup/identity', 'plan', 'tasks', 'budget', 'fees', 'approvals', 'updates', 'registers', 'agreements', 'documents', 'reports', 'access', 'activity', 'plots'])
      assert.equal((await admin.get(`/w/${p1}/${p}`)).status, 200, p);
    assert.equal((await admin.get(`/w/${p1}/units`)).status, 404);           // development-only tab
    const ov = await admin.get(`/w/${p1}`);
    assert.match(ov.text, /client-banner/); assert.match(ov.text, /Al Noor Holdings/);
  });

  await t.test('guided onboarding generates a client-project draft plan', async () => {
    await admin.post(`/w/${p1}/setup/identity`, { type: 'villa', objective: 'Family villa', go: 'stay' }, `/w/${p1}/setup/identity`);
    await admin.post(`/w/${p1}/setup/stage`, { stage: 'construction', ph_onboarding: 'done', ph_design: 'done', ph_approvals: 'done', ph_procurement: 'done', ph_construction: 'in_progress', ph_handover: 'not_started', ph_defects: 'not_started', go: 'stay' }, `/w/${p1}/setup/stage`);
    await admin.post(`/w/${p1}/setup/budget`, { budget_status: 'approved', total_budget: '250000', payment_route: 'client_direct', go: 'stay' }, `/w/${p1}/setup/budget`);
    const rv = await admin.get(`/w/${p1}/setup/review`);
    assert.match(rv.text, /Management agreement terms/);                     // flagged until terms exist
    assert.equal((await admin.post(`/w/${p1}/plan/generate`, {}, `/w/${p1}/setup/review`)).status, 302);
    assert.equal((await q1(`select count(*)::int as n from phases where workspace_id = '${p1}'`)).n, 7);
    const un = await q1(`select revised_minor from budget_lines where workspace_id = '${p1}' and category = 'Unallocated'`);
    assert.equal(Number(un.revised_minor), 250000000);                       // client budget kept, not split by invention
  });

  await t.test('management terms are versioned and activated by Finance', async () => {
    const r = await admin.post(`/w/${p1}/terms`, { agreement_ref: 'PMA-1', start_date: `${month}-01`, effective_from: `${month}-01`, monthly_fee: '1500', billing_timing: 'advance', proration: 'daily', payment_terms_days: '15', tax_mode: 'none' }, `/w/${p1}/client`);
    assert.equal(r.status, 302);
    const tid = (await q1(`select id from mgmt_terms where workspace_id = '${p1}'`)).id;
    // a project manager (not Finance) cannot activate
    await admin.post('/admin/users', { name: 'PM', email: 'pm@example.com', kind: 'internal', system_role: 'project_manager', password: 'pm-temp-pass-1' }, '/admin/users');
    const pm = client(base); await login(pm, 'pm@example.com', 'pm-temp-pass-1');
    await pm.post('/account/password', { current: 'pm-temp-pass-1', password: 'pm-own-pass-1', confirm: 'pm-own-pass-1' }, '/account/password');
    const pmId = (await q1("select id from users where email = 'pm@example.com'")).id;
    await admin.post(`/w/${p1}/access`, { user: pmId, role: 'manager' }, `/w/${p1}/access`);
    assert.equal((await pm.post(`/w/${p1}/terms/${tid}/activate`, {}, `/w/${p1}/client`)).status, 403);
    assert.equal((await admin.post(`/w/${p1}/terms/${tid}/activate`, {}, `/w/${p1}/client`)).status, 302);
    assert.equal((await q1(`select status from mgmt_terms where id = '${tid}'`)).status, 'active');
    // a new management agreement starts with the answers already in the terms
    await admin.get(`/w/${p1}/agreements`);
    const pmTpl = (await q1("select id from agreement_templates where key = 'pm_services'")).id;
    const af = await admin.get(`/w/${p1}/agreements/new?template=${pmTpl}`);
    assert.match(af.text, /name="v_payment_days"[^>]*value="15"/);
    assert.match(af.text, new RegExp(`name="v_start_date"[^>]*value="${month}-01"`));
    // one window: the whole agreement is generated from the terms on the Agreements tab
    let ca = await admin.get(`/w/${p1}/agreements`);
    assert.match(ca.text, /Agreement document/); assert.match(ca.text, /To write the agreement, add: <b>SarayDar management scope<\/b>/);
    await admin.post(`/w/${p1}/terms`, { agreement_ref: 'PMA-1', start_date: `${month}-15`, effective_from: `${month}-15`, monthly_fee: '1500', billing_timing: 'advance', proration: 'daily', payment_terms_days: '15', tax_mode: 'none', notice_days: '60', scope: 'Full project management of the villa works.' }, `/w/${p1}/client`);
    ca = await admin.get(`/w/${p1}/agreements`);
    assert.match(ca.text, /Generate the agreement/);
    const gen = await admin.post(`/w/${p1}/client/agreement`, {}, `/w/${p1}/client`);
    assert.equal(gen.status, 302, (gen.text.match(/<main[\s\S]{0,600}/) || [""])[0]);
    const ag = await q1(`select g.id, g.ref, (select count(*)::int from agreement_versions v where v.agreement_id = g.id and v.pdf is not null and v.docx is not null) as n from agreements g where g.workspace_id = '${p1}'`);
    assert.equal(ag.n, 1);
    assert.equal((await q1(`select agreement_ref from mgmt_terms where workspace_id = '${p1}' and status = 'draft'`)).agreement_ref, ag.ref);
    const ver = await q1(`select values from agreement_versions where agreement_id = '${ag.id}'`);
    assert.equal(ver.values.monthly_fee_amount, 1500000); assert.equal(ver.values.payment_days, 15); assert.equal(ver.values.notices_days, 60);
    assert.equal(ver.values.services, 'Full project management of the villa works.');
    assert.match(ver.values.billing_timing, /in advance/);
    assert.equal(ver.values.governing_law, 'the Kingdom of Bahrain');
    assert.match((await admin.get(`/w/${p1}/agreements`)).text, new RegExp(`${ag.ref} · version 1`));
    // downloads are named "Reference - project name - version", also when previewed in the browser
    const pv = /href="([^"]*\/v\/1\.pdf\/~\/[^"]+\?view=1)"/.exec((await admin.get(`/w/${p1}/agreements`)).text);
    assert.ok(pv, 'preview link carries the file name');
    const pr = await admin.get(pv[1].replace(/&amp;/g, '&'));
    assert.equal(pr.status, 200);
    const pname = (await q1(`select name from workspaces where id = '${p1}'`)).name;
    assert.match(decodeURIComponent(pr.res.headers.get('content-disposition')), new RegExp(`^inline; .*${ag.ref} - ${pname} - v1\\.pdf`));
    assert.equal((await admin.post(`/w/${p1}/client/agreement`, {}, `/w/${p1}/client`)).status, 302);
    assert.equal((await q1(`select count(*)::int as n from agreement_versions where agreement_id = '${ag.id}'`)).n, 2);
    // an unused older version of a draft can be deleted; the latest cannot
    assert.match((await admin.get(`/w/${p1}/agreements`)).text, /\/v\/1\/delete/);
    assert.equal((await admin.post(`/w/${p1}/agreements/${ag.id}/v/2/delete`, { back: `/w/${p1}/agreements` }, `/w/${p1}/agreements`)).status, 400);
    const dv = await admin.post(`/w/${p1}/agreements/${ag.id}/v/1/delete`, { back: `/w/${p1}/agreements` }, `/w/${p1}/agreements`);
    assert.equal(dv.location, `/w/${p1}/agreements?msg=deleted`);
    assert.equal((await q1(`select count(*)::int as n from agreement_versions where agreement_id = '${ag.id}'`)).n, 1);
    assert.equal((await q1(`select count(*)::int as n from audit_events where action = 'agreement.version_deleted'`)).n, 1);
    await admin.post(`/w/${p1}/client/agreement`, {}, `/w/${p1}/client`);
    // p2 gets terms with tax not configured
    await admin.post(`/w/${p2}/terms`, { start_date: `${month}-01`, monthly_fee: '900', tax_mode: 'not_configured' }, `/w/${p2}/client`);
    const t2 = (await q1(`select id from mgmt_terms where workspace_id = '${p2}'`)).id;
    await admin.post(`/w/${p2}/terms/${t2}/activate`, {}, `/w/${p2}/client`);
  });

  let inv1;
  await t.test('monthly invoice: draft once per month, issue with number and due date', async () => {
    let r = await admin.post(`/w/${p1}/fees/drafts`, { month }, `/w/${p1}/fees`);
    assert.equal(r.status, 302); inv1 = r.location.split('/')[5].slice(0, 36);
    assert.equal((await admin.post(`/w/${p1}/fees/drafts`, { month }, `/w/${p1}/fees`)).status, 400);     // same month again
    // add an authorised additional charge to the draft, then issue
    await admin.post(`/w/${p1}/fees/invoices/${inv1}/lines`, { kind: 'additional', description: 'Extra site visit (clause 6.2)', amount: '100' }, `/w/${p1}/fees/invoices/${inv1}`);
    assert.equal((await pdf(admin, `/w/${p1}/fees/invoices/${inv1}/invoice.pdf`)).head, '%PDF-');       // draft preview
    r = await admin.post(`/w/${p1}/fees/invoices/${inv1}/issue`, { issue_date: today }, `/w/${p1}/fees/invoices/${inv1}`);
    assert.equal(r.status, 302);
    const i = await q1(`select * from fee_invoices where id = '${inv1}'`);
    assert.match(i.number, /^INV-\d{4}-0001$/); assert.equal(i.status, 'issued');
    assert.equal(Number(i.total_minor), 1600000);                              // 1,500 + 100, no tax
    assert.equal(fees.isoOf(i.due_date), fees.addDays(today, 15));
    assert.equal((await admin.post(`/w/${p1}/fees/invoices/${inv1}/lines`, { kind: 'additional', description: 'x', amount: '1' }, `/w/${p1}/fees/invoices/${inv1}`)).status, 400);  // frozen
    // project 2: tax not configured blocks issuing
    r = await admin.post(`/w/${p2}/fees/drafts`, { month }, `/w/${p2}/fees`);
    const d2 = r.location.split('/')[5].slice(0, 36);
    const iss = await admin.post(`/w/${p2}/fees/invoices/${d2}/issue`, { issue_date: today }, `/w/${p2}/fees/invoices/${d2}`);
    assert.equal(iss.status, 400); assert.match(iss.text, /Tax treatment is not configured/);
  });

  let pay1;
  await t.test('partial payment, allocation, receipt, remaining balance; no over-allocation or duplicates', async () => {
    const page = await admin.get(`/w/${p1}/fees`);
    const idem = /name="idem" value="([0-9a-f]+)"/.exec(page.text)[1];
    const form = { idem, received_on: today, amount: '1000', method: 'Bank transfer', reference: 'TRX-778', [`alloc_${inv1}`]: '1000' };
    let r = await admin.post(`/w/${p1}/fees/payments`, form, `/w/${p1}/fees`);
    assert.equal(r.status, 302); pay1 = r.location.split('/')[5].slice(0, 36);
    r = await admin.post(`/w/${p1}/fees/payments`, form, `/w/${p1}/fees`);       // retried submission
    assert.equal(r.location.split('/')[5].slice(0, 36), pay1);
    assert.equal((await q1(`select count(*)::int as n from fee_payments where workspace_id = '${p1}'`)).n, 1);
    r = await admin.post(`/w/${p1}/fees/payments`, { received_on: today, amount: '50', method: 'Bank transfer', reference: 'trx-778' }, `/w/${p1}/fees`);
    assert.equal(r.status, 400);                                               // same bank reference
    const outstanding = async () => { const x = await q1(`select total_minor - coalesce((select sum(amount_minor) from fee_allocations where invoice_id = '${inv1}' and status='active'),0) - coalesce((select sum(amount_minor) from fee_credit_notes where invoice_id = '${inv1}'),0) as o from fee_invoices where id = '${inv1}'`); return Number(x.o); };
    assert.equal(await outstanding(), 600000);
    // a second payment larger than what is left: allocating more than outstanding is refused, the rest stays unapplied
    r = await admin.post(`/w/${p1}/fees/payments`, { received_on: today, amount: '800', method: 'Cheque', reference: 'CHQ-1' }, `/w/${p1}/fees`);
    const pay2 = r.location.split('/')[5].slice(0, 36);
    assert.equal((await admin.post(`/w/${p1}/fees/payments/${pay2}/allocate`, { invoice_id: inv1, amount: '700' }, `/w/${p1}/fees/payments/${pay2}`)).status, 400);
    assert.equal((await admin.post(`/w/${p1}/fees/payments/${pay2}/allocate`, { invoice_id: inv1, amount: '600' }, `/w/${p1}/fees/payments/${pay2}`)).status, 302);
    assert.equal(await outstanding(), 0);
    const view = await admin.get(`/w/${p1}/fees`);
    assert.match(view.text, /Unapplied credit BHD 200\.000/);
    // receipt is a separate event with its own number
    assert.equal((await pdf(admin, `/w/${p1}/fees/payments/${pay1}/receipt.pdf`)).status, 404);
    assert.equal((await admin.post(`/w/${p1}/fees/payments/${pay1}/receipt`, {}, `/w/${p1}/fees/payments/${pay1}`)).status, 302);
    assert.match((await q1(`select receipt_no from fee_payments where id = '${pay1}'`)).receipt_no, /^RCT-\d{4}-0001$/);
    assert.equal((await admin.post(`/w/${p1}/fees/payments/${pay1}/receipt`, {}, `/w/${p1}/fees/payments/${pay1}`)).status, 400);
    assert.equal((await pdf(admin, `/w/${p1}/fees/payments/${pay1}/receipt.pdf`)).head, '%PDF-');
    // void refused while payments are allocated
    assert.equal((await admin.post(`/w/${p1}/fees/invoices/${inv1}/void`, { reason: 'test' }, `/w/${p1}/fees/invoices/${inv1}`)).status, 400);
    // reversing the cheque puts its 600 back on the invoice; history is kept
    assert.equal((await admin.post(`/w/${p1}/fees/payments/${pay2}/reverse`, { reason: 'Cheque returned' }, `/w/${p1}/fees/payments/${pay2}`)).status, 302);
    assert.equal(await outstanding(), 600000);
    assert.equal((await q1(`select count(*)::int as n from fee_allocations where payment_id = '${pay2}' and status = 'reversed'`)).n, 1);
    // credit note cannot exceed the outstanding amount
    assert.equal((await admin.post(`/w/${p1}/fees/invoices/${inv1}/credit`, { amount: '700', reason: 'x', issued_on: today }, `/w/${p1}/fees/invoices/${inv1}`)).status, 400);
    assert.equal((await admin.post(`/w/${p1}/fees/invoices/${inv1}/credit`, { amount: '100', reason: 'Extra visit waived', issued_on: today }, `/w/${p1}/fees/invoices/${inv1}`)).status, 302);
    assert.equal(await outstanding(), 500000);
  });

  await t.test('statement reconciles to the ledger; PDFs and exports', async () => {
    const st = await admin.get(`/w/${p1}/fees/statement`);
    assert.equal(st.status, 200);
    // debits: invoice 1,600 + cheque reversal 800; credits: credit note 100 + payments 1,000 + 800; balance 500
    assert.match(st.text, /Closing balance<\/td><td class="n">BHD 2,400\.000<\/td><td class="n">BHD 1,900\.000<\/td><td class="n">BHD 500\.000/);
    assert.equal((await pdf(admin, `/w/${p1}/fees/statement.pdf`)).head, '%PDF-');
    assert.equal((await pdf(admin, `/w/${p1}/fees?export=xlsx`)).status, 200);
    const cs = await admin.get(`/clients/${clientA}/statement`);
    assert.match(cs.text, /BHD 500\.000/);
    assert.equal((await q1("select count(*)::int as n from audit_events where action like 'fee.%'")).n >= 10, true);
  });

  await t.test('client-funded expenditure stays out of the fee ledger; review ≠ approval ≠ payment', async () => {
    const before = await q1(`select coalesce(sum(total_minor),0) as s from fee_invoices where workspace_id = '${p1}' and status = 'issued'`);
    await admin.post(`/w/${p1}/budget/invoices`, { supplier: 'Gulf Builders', doc_type: 'payment_application', invoice_no: 'PA-03', amount: '40000' }, `/w/${p1}/budget`);
    const ci = (await q1(`select id from cost_invoices where workspace_id = '${p1}'`)).id;
    const r = await admin.post(`/w/${p1}/budget/invoices/${ci}`, { decision: 'approved' }, `/w/${p1}/budget`);
    assert.equal(r.status, 400); assert.match(r.text, /Review this item before approving/);
    await admin.post(`/w/${p1}/budget/invoices/${ci}`, { decision: 'reviewed' }, `/w/${p1}/budget`);
    await admin.post(`/w/${p1}/budget/invoices/${ci}`, { decision: 'approved' }, `/w/${p1}/budget`);
    assert.equal((await q1(`select count(*)::int as n from cost_payments where invoice_id = '${ci}'`)).n, 0);   // approved, not paid
    assert.equal((await admin.post(`/w/${p1}/budget/payments`, { payee: 'Gulf Builders', amount: '40000', invoice_id: ci, payer: 'on_behalf' }, `/w/${p1}/budget`)).status, 400);
    await admin.post(`/w/${p1}/budget/payments`, { payee: 'Gulf Builders', amount: '40000', invoice_id: ci, payer: 'client' }, `/w/${p1}/budget`);
    const cp = await q1(`select * from cost_payments where invoice_id = '${ci}'`);
    assert.equal(cp.status, 'pending'); assert.equal(cp.payer, 'Client'); assert.equal(cp.on_behalf, false);
    const after = await q1(`select coalesce(sum(total_minor),0) as s from fee_invoices where workspace_id = '${p1}' and status = 'issued'`);
    assert.equal(after.s, before.s);
    const feesPage = await admin.get(`/w/${p1}/fees`);
    assert.doesNotMatch(feesPage.text, /40,000/);
  });

  await t.test('client approvals recorded with evidence', async () => {
    await admin.post(`/w/${p1}/approvals`, { subject: 'variation', title: 'VO-03 kitchen upgrade', linked_ref: 'VO-03', requested_on: today, requested_from: 'Fatima', client_visible: '1' }, `/w/${p1}/approvals`);
    const cid = (await q1(`select id from client_approvals where workspace_id = '${p1}'`)).id;
    const g = await admin.get(`/w/${p1}/approvals`);
    const fd = new FormData(); fd.append('_csrf', admin.csrfFrom(g.text));
    for (const [k, v] of Object.entries({ status: 'approved', decided_on: today, approver_name: 'Fatima', method: 'Email' })) fd.append(k, v);
    fd.append('files', new Blob([Buffer.from('%PDF-1.4\n%\n')]), 'approval.pdf');
    assert.equal((await admin.raw('POST', `/w/${p1}/approvals/${cid}/decision`, { multipart: fd })).status, 302);
    const c = await q1(`select * from client_approvals where id = '${cid}'`);
    assert.equal(c.status, 'approved'); assert.equal(c.approver_name, 'Fatima');
    assert.equal((await q1(`select count(*)::int as n from files where entity = 'client_approval' and entity_id = '${cid}'`)).n, 1);
    assert.equal((await admin.post(`/w/${p1}/approvals/${cid}/decision`, { status: 'rejected', decided_on: today, approver_name: 'x' }, `/w/${p1}/approvals`)).status, 400);  // a recorded decision is final
  });

  await t.test('VAT later: a new terms version with a rate; VAT invoices need SarayDar\'s VAT number', async () => {
    const next = fees.monthOf(fees.addDays(`${month}-28`, 7).slice(0, 7));
    const form = await admin.get(`/w/${p3}/agreements`);
    assert.match(form.text, /<option value="none" selected>No VAT</);              // the form's default today
    await admin.post(`/w/${p3}/terms`, { start_date: `${month}-01`, monthly_fee: '1000', tax_mode: 'none' }, `/w/${p3}/client`);
    const tA = (await q1(`select id, tax_mode from mgmt_terms where workspace_id = '${p3}'`));
    assert.equal(tA.tax_mode, 'none');
    await admin.post(`/w/${p3}/terms/${tA.id}/activate`, {}, `/w/${p3}/client`);
    await admin.post(`/w/${p3}/terms`, { start_date: `${month}-01`, effective_from: next.start, monthly_fee: '1000', tax_mode: 'rate', tax_rate: '10' }, `/w/${p3}/client`);
    const tB = (await q1(`select id, tax_label from mgmt_terms where workspace_id = '${p3}' and status = 'draft'`));
    assert.equal(tB.tax_label, 'VAT');
    await admin.post(`/w/${p3}/terms/${tB.id}/activate`, {}, `/w/${p3}/client`);
    let r = await admin.post(`/w/${p3}/fees/drafts`, { month }, `/w/${p3}/fees`);
    const noVat = r.location.split('/')[5].slice(0, 36);
    assert.equal((await admin.post(`/w/${p3}/fees/invoices/${noVat}/issue`, { issue_date: today }, `/w/${p3}/fees/invoices/${noVat}`)).status, 302);
    assert.equal(Number((await q1(`select tax_minor from fee_invoices where id = '${noVat}'`)).tax_minor), 0);
    r = await admin.post(`/w/${p3}/fees/drafts`, { month: next.start.slice(0, 7) }, `/w/${p3}/fees`);
    const vat = r.location.split('/')[5].slice(0, 36);
    assert.equal(Number((await q1(`select tax_minor from fee_invoices where id = '${vat}'`)).tax_minor), 100000);
    r = await admin.post(`/w/${p3}/fees/invoices/${vat}/issue`, { issue_date: today }, `/w/${p3}/fees/invoices/${vat}`);
    assert.equal(r.status, 400); assert.match(r.text, /VAT registration number/);
    await pool.query("update company_profile set vat_number = '200000000000002' where id = 1");
    assert.equal((await admin.post(`/w/${p3}/fees/invoices/${vat}/issue`, { issue_date: today }, `/w/${p3}/fees/invoices/${vat}`)).status, 302);
  });

  await t.test('isolation: other projects, non-members and roles without financial access', async () => {
    // an invoice of project 1 cannot be reached through project 3
    assert.equal((await admin.get(`/w/${p3}/fees/invoices/${inv1}`)).status, 404);
    assert.equal((await pdf(admin, `/w/${p3}/fees/payments/${pay1}/receipt.pdf`)).status, 404);
    await admin.post('/admin/users', { name: 'Eng', email: 'eng2@example.com', kind: 'internal', system_role: 'engineer', password: 'eng-temp-pass-1' }, '/admin/users');
    const eng = client(base); await login(eng, 'eng2@example.com', 'eng-temp-pass-1');
    await eng.post('/account/password', { current: 'eng-temp-pass-1', password: 'eng-own-pass-1', confirm: 'eng-own-pass-1' }, '/account/password');
    assert.equal((await eng.get(`/w/${p1}/fees`)).status, 404);              // not a member
    assert.equal((await eng.get('/clients')).status, 403);
    const engId = (await q1("select id from users where email = 'eng2@example.com'")).id;
    await admin.post(`/w/${p1}/access`, { user: engId, role: 'contributor' }, `/w/${p1}/access`);
    assert.equal((await eng.get(`/w/${p1}/fees`)).status, 404);              // member, but no financial access
    assert.equal((await eng.get(`/w/${p1}/fees/statement.pdf`)).status, 404);
    assert.equal((await eng.get(`/w/${p1}/approvals`)).status, 200);         // execution records are open to members
    const ov = await eng.get(`/w/${p1}`);
    assert.doesNotMatch(ov.text, /fees outstanding/i);
    assert.equal((await eng.post(`/w/${p1}/fees/payments`, { received_on: today, amount: '1', method: 'Cash' }, `/w/${p1}`)).status, 404);
    const pm = client(base); await login(pm, 'pm@example.com', 'pm-own-pass-1');
    assert.equal((await pm.get(`/w/${p1}/fees`)).status, 200);               // manager with financial visibility
    assert.equal((await pm.post(`/w/${p1}/fees/payments`, { received_on: today, amount: '1', method: 'Cash' }, `/w/${p1}/fees`)).status, 403);  // only Finance records payments
  });
});
