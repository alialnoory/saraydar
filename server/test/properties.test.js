'use strict';
// Phase 5 — Clients Properties Management (acceptance E).
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const ExcelJS = require('exceljs');
const db = require('../db');
const { createApp } = require('../app');
const rent = require('../lib/rent');
const billing = require('../lib/billing');
const { createMailer } = require('../lib/mailer');
const { client } = require('./helpers');

const URL_ = process.env.TEST_DATABASE_URL;

test('rent schedule maths: calendar periods, proration, rent change, quarterly', () => {
  const l = { start_date: '2026-01-15', end_date: '2026-12-31', rent_minor: 300000, frequency_months: 1, proration: 'daily', due_day_offset: 5 };
  const ps = rent.periods(l);
  assert.equal(ps.length, 12); assert.deepEqual(ps[0], { start: '2026-01-15', end: '2026-01-31' });
  assert.equal(rent.rentFor(l, [], ps[0]).total, Math.round(300000 * 17 / 31));
  assert.equal(rent.rentFor(l, [{ effective_from: '2026-06-16', rent_minor: 330000 }], ps[5]).total, 150000 + 165000);
  assert.equal(rent.dueDate(l, ps[1]), '2026-02-06');
  assert.equal(rent.periods({ ...l, frequency_months: 3 }).length, 4);
  assert.equal(rent.periods({ ...l, terminated_on: '2026-03-10' }).length, 3);
  assert.equal(rent.rentFor({ ...l, proration: 'none' }, [], ps[0]).total, 300000);
  assert.deepEqual(billing.occurrences('2026-01-31', 'monthly', '2026-01-01', '2026-03-31'), ['2026-01-31', '2026-02-28', '2026-03-31']);
});

test('managed properties', { skip: !URL_ && 'set TEST_DATABASE_URL to run' }, async t => {
  const pool = new Pool({ connectionString: URL_ });
  await pool.query('drop schema public cascade; create schema public;');
  await db.migrate(pool); await db.seed(pool);
  await db.ensureAdmin(pool, { ADMIN_EMAIL: 'ali@example.com', ADMIN_PASSWORD: 'admin-pass-123' });
  const sent = [];
  const fakeTransport = { sendMail: async m => { sent.push(m); return { messageId: `m${sent.length}` }; } };
  const mailer = createMailer({ pool, env: { MAIL_FROM: 'info@saraydar.com' }, transport: fakeTransport });
  const server = createApp({ pool, jwtSecret: 'p'.repeat(40), corsOrigins: [], env: {}, mailer }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.close(); await pool.end(); });
  const login = (c, i, p) => c.post('/login', { identifier: i, password: p }, '/login');
  const admin = client(base); await login(admin, 'ali@example.com', 'admin-pass-123');
  const q1 = async (sql, v = []) => (await pool.query(sql, v)).rows[0];
  const loc = r => r.location;
  const idFrom = (r, i = 5) => r.location.split('/')[i].slice(0, 36);
  const idFrom4 = r => idFrom(r, 4);
  const today = billing.todayBH();
  const fileOf = async path => { const r = await admin.raw('GET', path); return { status: r.status, buf: r.status === 200 ? Buffer.from(await r.res.arrayBuffer()) : null }; };

  let ws, ws2, apt13, apt1, apt2, leaseA, leaseB;
  await t.test('owner, property arrangement, units', async () => {
    ws = (await admin.post('/s/props/new', { kind: 'property', name: 'Seef Residence', party: 'Mansour Holdings', location: 'Seef' }, '/s/props/new')).location.slice(3, 39);
    ws2 = (await admin.post('/s/props/new', { kind: 'property', name: 'Juffair Tower', party: 'Mansour Holdings', location: 'Juffair' }, '/s/props/new')).location.slice(3, 39);
    assert.equal((await q1(`select count(distinct party_id)::int as n from workspaces where id in ('${ws}','${ws2}')`)).n, 1);   // one owner, several properties
    assert.equal((await admin.post(`/w/${ws}/property`, { property_type: 'residential_building', rent_collector: 'saraydar', deposit_holder: 'saraydar', supplier_payer: 'saraydar', owner_transfers: 'saraydar',
      fee_deduction_allowed: '1', maintenance_limit: '100', emergency_allowed: '1', emergency_limit: '300', reserve: '200', billing_entity: 'owner', payment_instructions: 'NBB · IBAN BH00 0000' }, `/w/${ws}/property`)).status, 302);
    await admin.post(`/w/${ws}/units/range`, { prefix: 'Apartment ', from: '12', to: '14', unit_type: '2BR' }, `/w/${ws}/units`);
    assert.equal((await admin.post(`/w/${ws}/units`, { ref: 'Apartment 13' }, `/w/${ws}/units`)).status, 400);          // duplicate number
    const u = (await pool.query(`select id, ref from units where workspace_id = '${ws}' order by ref`)).rows;
    assert.equal(u.length, 3);
    [apt1, apt13, apt2] = [u.find(x => x.ref === 'Apartment 12').id, u.find(x => x.ref === 'Apartment 13').id, u.find(x => x.ref === 'Apartment 14').id];
    for (const [id, area] of [[apt1, '80'], [apt13, '100'], [apt2, '120']]) await admin.post(`/w/${ws}/units/${id}`, { ref: (u.find(x => x.id === id)).ref, area_m2: area }, `/w/${ws}/units/${id}`);
    const pg = await admin.get(`/w/${ws}/units`);
    assert.match(pg.text, /Apartment 13/);
    for (const p of ['', '/client', '/property', '/units', '/leases', '/rent', '/deposits', '/maintenance', '/services', '/expenses', '/owner', '/fees', '/history', '/reports', '/agreements', '/documents', '/access', '/activity'])
      assert.equal((await admin.get(`/w/${ws}${p}`)).status, 200, p);
    assert.match((await admin.get('/s/props')).text, /Occupancy/);
  });

  await t.test('leases: two tenants over time on Apartment 13; overlapping lease refused', async () => {
    leaseA = idFrom4(await admin.post(`/w/${ws}/leases`, { unit_id: apt13, tenant_name: 'Ahmed Saleh', tenant_email: 'ahmed@example.com', tenant_phone: '3311', start_date: '2026-01-01', end_date: '2026-03-31', rent: '300', deposit: '300', due_day_offset: '4' }, `/w/${ws}/leases`));
    assert.equal((await admin.post(`/w/${ws}/leases/${leaseA}/activate`, {}, `/w/${ws}/leases/${leaseA}`)).status, 302);
    const clash = idFrom4(await admin.post(`/w/${ws}/leases`, { unit_id: apt13, tenant_name: 'Clash Co', start_date: '2026-03-15', end_date: '2026-09-30', rent: '310' }, `/w/${ws}/leases`));
    const r = await admin.post(`/w/${ws}/leases/${clash}/activate`, {}, `/w/${ws}/leases/${clash}`);
    assert.equal(r.status, 400); assert.match(r.text, /overlaps/);
    await admin.post(`/w/${ws}/leases/${clash}/cancel`, {}, `/w/${ws}/leases/${clash}`);
    await admin.post(`/w/${ws}/leases/${leaseA}/end`, {}, `/w/${ws}/leases/${leaseA}`);
    assert.equal((await q1(`select status from leases where id = '${leaseA}'`)).status, 'ended');
    leaseB = idFrom4(await admin.post(`/w/${ws}/leases`, { unit_id: apt13, tenant_name: 'Sara Khalid', tenant_email: 'sara@example.com', start_date: '2026-05-01', end_date: '2027-04-30', rent: '320', deposit: '320', charge_desc: 'Service charge', charge_amount: '20' }, `/w/${ws}/leases`));
    assert.equal((await admin.post(`/w/${ws}/leases/${leaseB}/activate`, {}, `/w/${ws}/leases/${leaseB}`)).status, 302);
    assert.equal((await q1(`select status from units where id = '${apt13}'`)).status, 'occupied');
  });

  await t.test('opening balances are reviewed, approved and posted once', async () => {
    await admin.post(`/w/${ws}/opening`, { kind: 'tenant_arrears', lease_id: leaseA, as_of: '2026-01-01', amount: '50', evidence: 'Previous agent statement' }, `/w/${ws}/property`);
    assert.equal((await admin.post(`/w/${ws}/opening`, { kind: 'tenant_arrears', lease_id: leaseA, as_of: '2026-01-01', amount: '50' }, `/w/${ws}/property`)).status, 400);   // duplicate
    const ob = (await q1(`select id from opening_balances where lease_id = '${leaseA}'`)).id;
    assert.equal((await admin.post(`/w/${ws}/opening/${ob}`, { do: 'post' }, `/w/${ws}/property`)).status, 400);    // not approved yet
    await admin.post(`/w/${ws}/opening/${ob}`, { do: 'approve' }, `/w/${ws}/property`);
    assert.equal((await admin.post(`/w/${ws}/opening/${ob}`, { do: 'post' }, `/w/${ws}/property`)).status, 302);
    assert.equal((await admin.post(`/w/${ws}/opening/${ob}`, { do: 'post' }, `/w/${ws}/property`)).status, 400);    // posted once
    assert.equal((await q1(`select count(*)::int as n from rent_charges where opening_id = '${ob}'`)).n, 1);
  });

  let invB;
  await t.test('automatic invoicing: one invoice per period despite retries and concurrent runs; delivery recorded honestly', async () => {
    // lease A: invoice its three months by hand
    for (const p of rent.periods(await q1(`select * from leases where id = '${leaseA}'`)))
      assert.equal((await admin.post(`/w/${ws}/leases/${leaseA}/invoice`, { period_start: p.start }, `/w/${ws}/leases/${leaseA}`)).status, 302);
    // issuing the same period again returns the existing invoice; nothing is duplicated
    await admin.post(`/w/${ws}/leases/${leaseA}/invoice`, { period_start: '2026-01-01' }, `/w/${ws}/leases/${leaseA}`);
    assert.equal((await q1(`select count(*)::int as n from rent_invoices where lease_id = '${leaseA}'`)).n, 3);
    assert.equal((await q1(`select count(*)::int as n from rent_charges where lease_id = '${leaseA}' and kind = 'rent'`)).n, 3);
    // lease B: switch on automatic invoicing from May, then run the job twice and concurrently
    assert.equal((await admin.post(`/w/${ws}/leases/${leaseB}/billing`, { auto_invoice: '1', auto_from: '2026-05-01', invoice_days_before: '0', delivery: 'email', reminder_days: '3' }, `/w/${ws}/leases/${leaseB}`)).status, 302);
    await Promise.all([billing.runBilling(pool, mailer, { today }), billing.runBilling(pool, mailer, { today }), billing.runBilling(pool, mailer, { today })]);
    await billing.runBilling(pool, mailer, { today });
    const months = rent.periods(await q1(`select * from leases where id = '${leaseB}'`)).filter(p => p.start <= today).length;
    assert.equal((await q1(`select count(*)::int as n from rent_invoices where lease_id = '${leaseB}'`)).n, months);
    assert.equal((await q1(`select count(*)::int as n from rent_charges where lease_id = '${leaseB}' and kind = 'rent'`)).n, months);
    assert.equal((await q1(`select count(*)::int as n from (select period_start from rent_invoices where lease_id = '${leaseB}' group by 1 having count(*) > 1) x`)).n, 0);
    const may = await q1(`select * from rent_invoices where lease_id = '${leaseB}' and period_start = '2026-05-01'`);
    invB = may.id;
    assert.equal(Number(may.total_minor), 340000);                                 // 320 rent + 20 service charge
    assert.equal(may.origin, 'scheduler');
    const mails = sent.filter(m => /Rent invoice/.test(m.subject) && m.to === 'sara@example.com');
    assert.equal(mails.length, months);                                            // one email per invoice, not per run
    assert.equal(mails[0].attachments[0].contentType, 'application/pdf');
    assert.equal((await q1(`select status from outbox_messages where ref_id = '${invB}' and kind = 'rent_invoice' order by id limit 1`)).status, 'sent');
    // resending reuses the same invoice
    await admin.post(`/w/${ws}/rent/invoices/${invB}/send`, {}, `/w/${ws}/rent/invoices/${invB}`);
    assert.equal((await q1(`select count(*)::int as n from rent_invoices where lease_id = '${leaseB}' and period_start = '2026-05-01'`)).n, 1);
    assert.equal((await q1(`select count(*)::int as n from outbox_messages where ref_id = '${invB}' and kind = 'rent_invoice'`)).n, 2);
    // reminders for overdue invoices are sent once per configured day
    const rem = sent.filter(m => /Reminder/.test(m.subject)).length;
    await billing.runBilling(pool, mailer, { today });
    assert.equal(sent.filter(m => /Reminder/.test(m.subject)).length, rem);
    assert.ok(rem >= 1);
    // without email settings delivery is shown as not configured, never as sent
    const plain = createMailer({ pool, env: {} });
    const r = await billing.deliverInvoice(pool, plain, invB);
    assert.equal(r.status, 'unconfigured');
    assert.equal((await fileOf(`/w/${ws}/rent/invoices/${invB}/invoice.pdf`)).buf.subarray(0, 5).toString(), '%PDF-');
  });

  await t.test('payments: reported ≠ paid; confirm, allocate, receipt; partial; duplicates refused; bounce reverses', async () => {
    const acct = async () => { const c = await billing.chargeState(pool, "c.lease_id = $1 and c.status = 'open'", [leaseA]); return c.reduce((s, x) => s + x.outstanding, 0); };
    const before = await acct();                                                   // 50 opening + 3 × 300
    assert.equal(before, 950000);
    const page = await admin.get(`/w/${ws}/leases/${leaseA}`);
    const idem = /name="idem" value="([0-9a-f]+)"/.exec(page.text)[1];
    const pay = { idem, received_on: '2026-02-10', amount: '400', method: 'Cheque', reference: 'CHQ-77', received_by: 'saraydar' };
    const p1 = idFrom(await admin.post(`/w/${ws}/leases/${leaseA}/payments`, pay, `/w/${ws}/leases/${leaseA}`));
    assert.equal(idFrom(await admin.post(`/w/${ws}/leases/${leaseA}/payments`, pay, `/w/${ws}/leases/${leaseA}`)), p1);    // retried form
    assert.equal(await acct(), before);                                            // reported cheque does not reduce the balance
    assert.equal((await admin.post(`/w/${ws}/leases/${leaseA}/payments`, { received_on: '2026-02-11', amount: '10', method: 'Cheque', reference: 'chq-77' }, `/w/${ws}/leases/${leaseA}`)).status, 400);
    await admin.post(`/w/${ws}/rent/payments/${p1}/confirm`, { cleared_on: '2026-02-12' }, `/w/${ws}/rent/payments/${p1}`);
    assert.equal(await acct(), 550000);                                            // oldest first: opening 50, Jan 300, 50 of Feb
    await admin.post(`/w/${ws}/rent/payments/${p1}/receipt`, {}, `/w/${ws}/rent/payments/${p1}`);
    assert.match((await q1(`select receipt_no from tenant_payments where id = '${p1}'`)).receipt_no, /^RRC-2026-\d{5}$/);
    assert.equal((await fileOf(`/w/${ws}/rent/payments/${p1}/receipt.pdf`)).buf.subarray(0, 5).toString(), '%PDF-');
    const p2 = idFrom(await admin.post(`/w/${ws}/leases/${leaseA}/payments`, { received_on: '2026-03-05', amount: '250', method: 'Bank transfer', reference: 'TRX-9', received_by: 'saraydar', confirm: '1' }, `/w/${ws}/leases/${leaseA}`));
    assert.equal(await acct(), 300000);
    // a later bounce/reversal restores the balance and keeps history
    await admin.post(`/w/${ws}/rent/payments/${p2}/bounce`, { reason: 'Recalled by bank' }, `/w/${ws}/rent/payments/${p2}`);
    assert.equal(await acct(), 550000);
    assert.equal((await q1(`select status from tenant_payments where id = '${p2}'`)).status, 'reversed');
    await admin.post(`/w/${ws}/leases/${leaseA}/payments`, { received_on: '2026-03-20', amount: '250', method: 'Cash', received_by: 'saraydar', confirm: '1' }, `/w/${ws}/leases/${leaseA}`);
    // credit note on the March charge cannot exceed what is outstanding
    const mar = await q1(`select id from rent_charges where lease_id = '${leaseA}' and period_start = '2026-03-01' and kind = 'rent'`);
    assert.equal((await admin.post(`/w/${ws}/rent/charges/${mar.id}/credit`, { amount: '400', reason: 'x' }, `/w/${ws}/rent`)).status, 400);
    await admin.post(`/w/${ws}/rent/charges/${mar.id}/credit`, { amount: '100', reason: 'Water outage compensation' }, `/w/${ws}/rent`);
    assert.equal(await acct(), 200000);
    const st = await admin.get(`/w/${ws}/leases/${leaseA}/statement`);
    // charges 950 + reversed payment 250 = 1,200; payments 400 + 250 + 250 and credit 100 = 1,000; balance 200
    assert.match(st.text, /Closing balance<\/td><td class="n">BHD 1,200\.000<\/td><td class="n">BHD 1,000\.000<\/td><td class="n">BHD 200\.000/);
  });

  await t.test('deposits stay separate until an approved deduction', async () => {
    await admin.post(`/w/${ws}/leases/${leaseA}/deposits`, { kind: 'received', on_date: '2026-01-01', amount: '300', holder: 'saraydar' }, `/w/${ws}/leases/${leaseA}`);
    assert.equal((await admin.post(`/w/${ws}/leases/${leaseA}/deposits`, { kind: 'deduction', on_date: '2026-04-02', amount: '50', holder: 'saraydar' }, `/w/${ws}/leases/${leaseA}`)).status, 400);   // needs reason + approval
    await admin.post(`/w/${ws}/leases/${leaseA}/deposits`, { kind: 'deduction', on_date: '2026-04-02', amount: '50', holder: 'saraydar', reason: 'Wall damage repair', approval_ref: 'Tenant signed move-out report' }, `/w/${ws}/leases/${leaseA}`);
    assert.equal((await admin.post(`/w/${ws}/leases/${leaseA}/deposits`, { kind: 'refund', on_date: '2026-04-03', amount: '300', holder: 'saraydar' }, `/w/${ws}/leases/${leaseA}`)).status, 400);       // more than held
    await admin.post(`/w/${ws}/leases/${leaseA}/deposits`, { kind: 'refund', on_date: '2026-04-03', amount: '250', holder: 'saraydar' }, `/w/${ws}/leases/${leaseA}`);
    const acc = await admin.get(`/w/${ws}/owner?preset=custom&from=2026-01-01&to=2026-04-30`);
    assert.match(acc.text, /Deposit deduction released/);
    assert.doesNotMatch(acc.text, /Deposit received/);
  });

  let mr;
  await t.test('maintenance: spending limit, owner approval, completion with photos, verification; expense split across units', async () => {
    const g = await admin.get(`/w/${ws}/maintenance`);
    const fd = new FormData(); fd.append('_csrf', admin.csrfFrom(g.text));
    for (const [k, v] of Object.entries({ unit_id: apt13, title: 'AC not cooling', category: 'AC', priority: 'high', reported_on: '2026-05-10', reported_by: 'Tenant (phone)' })) fd.append(k, v);
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
    fd.append('files', new Blob([png], { type: 'image/png' }), 'before.png');
    mr = (await admin.raw('POST', `/w/${ws}/maintenance`, { multipart: fd })).location.split('/')[4].slice(0, 36);
    await admin.post(`/w/${ws}/maintenance/${mr}/assign`, { provider: 'CoolFix', target_date: '2026-05-15', estimate: '180' }, `/w/${ws}/maintenance/${mr}`);
    let r = await admin.post(`/w/${ws}/maintenance/${mr}/approve`, { mode: 'within_limit' }, `/w/${ws}/maintenance/${mr}`);
    assert.equal(r.status, 400); assert.match(r.text, /above the owner/);
    assert.equal((await admin.post(`/w/${ws}/maintenance/${mr}/step`, { to: 'in_progress' }, `/w/${ws}/maintenance/${mr}`)).status, 400);   // not approved yet
    await admin.post(`/w/${ws}/maintenance/${mr}/approve`, { mode: 'owner', decision: 'approved', approval_ref: 'Owner email 11 May' }, `/w/${ws}/maintenance/${mr}`);
    await admin.post(`/w/${ws}/maintenance/${mr}/step`, { to: 'in_progress' }, `/w/${ws}/maintenance/${mr}`);
    const g2 = await admin.get(`/w/${ws}/maintenance/${mr}`);
    const fd2 = new FormData(); fd2.append('_csrf', admin.csrfFrom(g2.text)); fd2.append('completed_on', '2026-05-14');
    fd2.append('files', new Blob([png], { type: 'image/png' }), 'after.png');
    assert.equal((await admin.raw('POST', `/w/${ws}/maintenance/${mr}/complete`, { multipart: fd2 })).status, 302);
    await admin.post(`/w/${ws}/maintenance/${mr}/step`, { to: 'verified' }, `/w/${ws}/maintenance/${mr}`);
    await admin.post(`/w/${ws}/maintenance/${mr}/responsibility`, { responsible: 'owner', note: 'Wear and tear — lease clause 9' }, `/w/${ws}/maintenance/${mr}`);
    const m = await q1(`select * from maint_requests where id = '${mr}'`);
    assert.equal(m.status, 'verified'); assert.equal(m.approval, 'owner_approved');
    assert.equal((await q1(`select count(*)::int as n from files where entity = 'maint_request' and entity_id = '${mr}' and tag = 'after'`)).n, 1);
    // its invoice: approval separate from payment
    const e1 = idFrom4(await admin.post(`/w/${ws}/expenses`, { unit_id: apt13, maint_id: mr, category: 'AC', description: 'Compressor repair', supplier: 'CoolFix', invoice_no: 'CF-1', incurred_on: '2026-05-14', amount: '175', responsible: 'owner', paid_by: 'saraydar_held_funds' }, `/w/${ws}/expenses`));
    await admin.post(`/w/${ws}/expenses/${e1}/decide`, { decision: 'approved' }, `/w/${ws}/expenses/${e1}`);
    assert.equal((await q1(`select pay_status from prop_expenses where id = '${e1}'`)).pay_status, 'unpaid');
    await admin.post(`/w/${ws}/expenses/${e1}/paid`, { paid_on: '2026-05-20', pay_reference: 'TRX-55' }, `/w/${ws}/expenses/${e1}`);
    // one shared cost, split by area across the three apartments — never the full amount on each
    const e2 = idFrom4(await admin.post(`/w/${ws}/expenses`, { unit_id: '', allocation: 'area', category: 'Common areas', description: 'Lift service', supplier: 'LiftCo', invoice_no: 'L-7', incurred_on: '2026-05-20', amount: '300.001', responsible: 'owner', paid_by: 'saraydar_held_funds' }, `/w/${ws}/expenses`));
    await admin.post(`/w/${ws}/expenses/${e2}/decide`, { decision: 'approved' }, `/w/${ws}/expenses/${e2}`);
    const al = (await pool.query(`select unit_id, amount_minor from expense_allocations where expense_id = '${e2}'`)).rows;
    assert.equal(al.length, 3);
    assert.equal(al.reduce((s, x) => s + Number(x.amount_minor), 0), 300001);
    assert.equal(Number(al.find(x => x.unit_id === apt13).amount_minor), 100000);  // 100 of 300 m²
    assert.ok(al.every(x => Number(x.amount_minor) < 300001));
  });

  await t.test('recurring service tasks are not duplicated', async () => {
    await admin.post(`/w/${ws}/services`, { title: 'Lobby cleaning', frequency: 'weekly', start_date: today, location: 'Lobby', provider: 'CleanCo' }, `/w/${ws}/services`);
    const n1 = (await q1(`select count(*)::int as n from service_tasks where workspace_id = '${ws}'`)).n;
    await Promise.all([billing.generateServiceTasks(pool, { today }), billing.generateServiceTasks(pool, { today })]);
    assert.equal((await q1(`select count(*)::int as n from service_tasks where workspace_id = '${ws}'`)).n, n1);
    assert.ok(n1 >= 8);
  });

  await t.test('owner account: transfers limited to available cash; authorised fee deduction counted once', async () => {
    // fee terms + one issued fee invoice for the property
    await admin.post(`/w/${ws}/terms`, { start_date: '2026-01-01', monthly_fee: '100', tax_mode: 'none' }, `/w/${ws}/client`);
    const tid = (await q1(`select id from mgmt_terms where workspace_id = '${ws}'`)).id;
    await admin.post(`/w/${ws}/terms/${tid}/activate`, {}, `/w/${ws}/client`);
    const inv = idFrom(await admin.post(`/w/${ws}/fees/drafts`, { month: today.slice(0, 7) }, `/w/${ws}/fees`));
    await admin.post(`/w/${ws}/fees/invoices/${inv}/issue`, { issue_date: today }, `/w/${ws}/fees/invoices/${inv}`);
    const acc = async () => { const r = await admin.get(`/w/${ws}/owner?preset=all`); return r.text; };
    let txt = await acc();
    const avail = Number(/Available to transfer<\/div><div class="big">BHD ([\d,.]+)/.exec(txt)[1].replace(/,/g, ''));
    assert.ok(avail > 0);
    assert.equal((await admin.post(`/w/${ws}/owner/txns`, { kind: 'transfer', on_date: today, amount: String(avail + 1), reference: 'X' }, `/w/${ws}/owner`)).status, 400);
    // cash held 525 (650 rent + 50 deposit deduction − 175 repair) less the unpaid lift invoice 300.001 and the reserve 200
    assert.equal(avail, 24.999);
    const big = await admin.post(`/w/${ws}/owner/fee-deduction`, { fee_invoice_id: inv, amount: '30', on_date: today }, `/w/${ws}/owner`);
    assert.equal(big.status, 400); assert.match(big.text, /available/);
    assert.equal((await admin.post(`/w/${ws}/owner/fee-deduction`, { fee_invoice_id: inv, amount: '20', on_date: today }, `/w/${ws}/owner`)).status, 302);
    const over = await admin.post(`/w/${ws}/owner/fee-deduction`, { fee_invoice_id: inv, amount: '81', on_date: today }, `/w/${ws}/owner`);
    assert.equal(over.status, 400); assert.match(over.text, /only BHD 80\.000 outstanding/);
    assert.equal((await q1(`select count(*)::int as n from owner_txns where workspace_id = '${ws}' and kind = 'fee_deduction'`)).n, 1);
    const fp = await q1(`select p.method, a.amount_minor from fee_payments p join fee_allocations a on a.payment_id = p.id where p.workspace_id = '${ws}'`);
    assert.equal(fp.method, 'Deduction from rent'); assert.equal(Number(fp.amount_minor), 20000);
    txt = await acc();
    assert.equal((txt.match(/SarayDar fee deducted/g) || []).length, 1);
    assert.equal((await admin.post(`/w/${ws}/owner/txns`, { kind: 'transfer', on_date: today, amount: '4', reference: 'BNK-1' }, `/w/${ws}/owner`)).status, 302);
    assert.equal((await fileOf(`/w/${ws}/owner/statement.pdf?preset=all`)).buf.subarray(0, 5).toString(), '%PDF-');
  });

  await t.test('Unit History & Report for Apartment 13 across a tenant change', async () => {
    const r = await admin.get(`/w/${ws}/history?unit=${apt13}&preset=custom&from=2026-01-01&to=2026-06-30`);
    assert.equal(r.status, 200);
    assert.match(r.text, /Ahmed Saleh/); assert.match(r.text, /Sara Khalid/);           // both tenancies
    assert.match(r.text, /Vacant: 1 Apr 2026–30 Apr 2026/);                           // gap between them
    assert.match(r.text, /AC not cooling/); assert.match(r.text, /CoolFix/);
    assert.match(r.text, /BHD 100\.000/);                                             // its share of the lift service
    assert.doesNotMatch(r.text, /<b>BHD 300\.001<\/b>/);                                // never the full shared cost as its share
    assert.match(r.text, /Ahmed Saleh moved|Lease LSE-2026-0001 starts/);
    // history before Sara's lease must not show her
    const early = await admin.get(`/w/${ws}/history?unit=${apt13}&preset=custom&from=2026-01-01&to=2026-02-28`);
    assert.doesNotMatch(early.text, /Sara Khalid/);
    const pdf = await fileOf(`/w/${ws}/history.pdf?unit=${apt13}&preset=custom&from=2026-01-01&to=2026-06-30`);
    assert.equal(pdf.buf.subarray(0, 5).toString(), '%PDF-');
    const x = await fileOf(`/w/${ws}/history.xlsx?all=1&preset=custom&from=2026-01-01&to=2026-06-30`);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(x.buf);
    assert.deepEqual(wb.worksheets.map(s => s.name), ['Summary', 'Tenancy', 'Maintenance', 'Finance']);
    assert.equal(wb.getWorksheet('Summary').rowCount, 4);                              // three units, one row each
    for (const k of ['rentroll', 'occupancy', 'arrears', 'expiry', 'maintenance', 'expenses', 'fees']) assert.equal((await admin.get(`/w/${ws}/reports?report=${k}`)).status, 200, k);
  });

  await t.test('isolation between properties and roles', async () => {
    assert.equal((await admin.get(`/w/${ws2}/leases/${leaseA}`)).status, 404);
    assert.equal((await admin.get(`/w/${ws2}/rent/invoices/${invB}`)).status, 404);
    assert.equal((await admin.get(`/w/${ws2}/maintenance/${mr}`)).status, 404);
    await admin.post('/admin/users', { name: 'Eng', email: 'eng3@example.com', kind: 'internal', system_role: 'engineer', password: 'eng-temp-pass-1' }, '/admin/users');
    const eng = client(base); await login(eng, 'eng3@example.com', 'eng-temp-pass-1');
    await eng.post('/account/password', { current: 'eng-temp-pass-1', password: 'eng-own-pass-1', confirm: 'eng-own-pass-1' }, '/account/password');
    assert.equal((await eng.get(`/w/${ws}/units`)).status, 404);
    const engId = (await q1("select id from users where email = 'eng3@example.com'")).id;
    await admin.post(`/w/${ws}/access`, { user: engId, role: 'contributor' }, `/w/${ws}/access`);
    assert.equal((await eng.get(`/w/${ws}/maintenance`)).status, 200);
    assert.equal((await eng.get(`/w/${ws}/rent`)).status, 404);                      // no financial access
    assert.equal((await eng.get(`/w/${ws}/owner`)).status, 404);
    assert.equal((await eng.post(`/w/${ws}/leases/${leaseA}/payments`, { received_on: today, amount: '1', method: 'Cash' }, `/w/${ws}/maintenance`)).status, 403);
  });
});
