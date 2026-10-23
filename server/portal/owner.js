'use strict';
// Owner account and statements (cash held vs available, recorded transfers, contributions, authorised fee
// deductions), the Unit History & Report (page, PDF with photos, Excel), property reports, and the
// property dashboard and portfolio figures.
//
// As-of policy for historical reports: a period shows what was recorded for it. Charges count from their due
// date; payments from the day received (and only once confirmed); credits from their date; a reversal counts
// from the day it was recorded. Balances "at period end" use those dates, so a later settlement does not
// change an earlier period's closing balance. Unit status shown for the past comes from the status history.
const ExcelJS = require('exceljs');
const sharp = require('sharp');
const { html, raw, pill, csrfField, field, emptyState, fmtDate, fmtDateTime } = require('./views');
const { parseMoney, formatMoney } = require('../lib/money');
const rentLib = require('../lib/rent');
const billing = require('../lib/billing');
const docs = require('../lib/fee-docs');
const { addDays } = require('../lib/fees');
const { M_STATUS, RESP, PAID_BY } = require('./maintenance');

const UUID = /^[0-9a-f-]{36}$/i;
const bad = m => Object.assign(new Error(m), { status: 400 });
const txt = (v, n = 300) => { const s = String(v ?? '').trim().slice(0, n); return s || null; };
const dateOrNull = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : null;
const todayBH = billing.todayBH;
const bhDay = ts => ts ? new Date(ts).toLocaleDateString('en-CA', { timeZone: 'Asia/Bahrain' }) : null;
const fm = (m, c = 'BHD') => m === null || m === undefined ? '—' : formatMoney(Number(m), c);
const safe = v => typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
const UNIT_STATUS = { available: 'Available', reserved: 'Reserved', occupied: 'Occupied', maintenance: 'Under maintenance', unavailable: 'Unavailable' };

// period presets: month, last_month, quarter, year, all, custom
function periodOf(q) {
  const t = todayBH(), y = Number(t.slice(0, 4)), m = Number(t.slice(5, 7));
  const mStart = (yy, mm) => `${yy}-${String(mm).padStart(2, '0')}-01`;
  const mEnd = (yy, mm) => `${yy}-${String(mm).padStart(2, '0')}-${String(new Date(Date.UTC(yy, mm, 0)).getUTCDate()).padStart(2, '0')}`;
  const preset = ['month', 'last_month', 'quarter', 'year', 'all', 'custom'].includes(q.preset) ? q.preset : (q.from || q.to ? 'custom' : 'month');
  let from, to;
  if (preset === 'month') { from = mStart(y, m); to = mEnd(y, m); }
  else if (preset === 'last_month') { const [yy, mm] = m === 1 ? [y - 1, 12] : [y, m - 1]; from = mStart(yy, mm); to = mEnd(yy, mm); }
  else if (preset === 'quarter') { const qs = Math.floor((m - 1) / 3) * 3 + 1; from = mStart(y, qs); to = mEnd(y, qs + 2); }
  else if (preset === 'year') { from = `${y}-01-01`; to = `${y}-12-31`; }
  else if (preset === 'all') { from = '2000-01-01'; to = t; }
  else { from = dateOrNull(q.from) || mStart(y, m); to = dateOrNull(q.to) || t; }
  if (to < from) throw bad('The end date is before the start date.');
  return { preset, from, to, label: preset === 'all' ? `All history to ${fmtDate(to)}` : `${fmtDate(from)} – ${fmtDate(to)}` };
}
const periodForm = (per, extra = '') => html`<form class="filters" method="get">${extra}
  <select name="preset" aria-label="Period">${[['month', 'This month'], ['last_month', 'Last month'], ['quarter', 'This quarter'], ['year', 'This year'], ['all', 'All history'], ['custom', 'Custom dates']].map(([v, l]) => html`<option value="${v}" ${v === per.preset ? raw('selected') : ''}>${l}</option>`)}</select>
  <label class="small">From <input type="date" name="from" value="${per.from}"></label><label class="small">To <input type="date" name="to" value="${per.to}"></label><button class="btn" type="submit">Apply</button></form>`;

function mountOwner(r, ctx) {
  const { pool, core, NotFound, Forbidden } = ctx;
  const PR = ctx.PR;
  const page = (req, a, tab, body, crumb) => PR.page(req, a, tab, body, crumb);

  // ---------- shared as-of figures ----------
  async function arrearsAsOf(wsId, asOf, unitId = null) {
    const vals = [wsId, asOf]; let extra = '';
    if (unitId) { vals.push(unitId); extra = ` and c.unit_id = $3`; }
    const rows = (await pool.query(`select c.id, c.lease_id, c.unit_id, c.amount_minor,
        coalesce((select sum(x.amount_minor) from rent_credits x where x.charge_id = c.id and x.on_date <= $2),0) as credited,
        coalesce((select sum(a.amount_minor) from tenant_allocations a join tenant_payments p on p.id = a.payment_id where a.charge_id = c.id and p.received_on <= $2
          and (a.status = 'active' or (a.reversed_at is not null and (a.reversed_at at time zone 'Asia/Bahrain')::date > $2))),0) as paid
      from rent_charges c where c.workspace_id = $1 and c.status = 'open' and c.due_date <= $2${extra}`, vals)).rows;
    return rows.map(x => ({ ...x, out: Number(x.amount_minor) - Number(x.credited) - Number(x.paid) })).filter(x => x.out > 0);
  }

  async function ownerAccount(wsId, from, to) {
    const ev = [], memo = [];
    for (const p of (await pool.query("select p.*, l.ref, u.ref as unit_ref from tenant_payments p join leases l on l.id = p.lease_id join units u on u.id = l.unit_id where p.workspace_id = $1 and p.status in ('confirmed','reversed')", [wsId])).rows) {
      const row = { date: String(p.received_on), text: `Rent received — unit ${p.unit_ref} (${p.ref})${p.receipt_no ? ` ${p.receipt_no}` : ''}`, cat: 'receipts', amount: Number(p.amount_minor) };
      if (p.received_by === 'saraydar') { ev.push(row); if (p.status === 'reversed') ev.push({ date: bhDay(p.reversed_at), text: `Rent payment reversed — unit ${p.unit_ref}: ${p.reverse_reason}`, cat: 'receipts', amount: -Number(p.amount_minor) }); }
      else if (p.received_by === 'owner') memo.push({ ...row, text: `Collected directly by the owner — unit ${p.unit_ref}`, amount: p.status === 'reversed' ? 0 : Number(p.amount_minor) });
    }
    for (const d of (await pool.query("select d.*, l.ref from deposit_txns d join leases l on l.id = d.lease_id where d.workspace_id = $1 and d.kind = 'deduction' and d.holder = 'saraydar'", [wsId])).rows)
      ev.push({ date: String(d.on_date), text: `Deposit deduction released (${d.ref}): ${d.reason}${d.approval_ref ? ` — approval ${d.approval_ref}` : ''}`, cat: 'receipts', amount: Number(d.amount_minor) });
    for (const e of (await pool.query("select e.*, u.ref as unit_ref from prop_expenses e left join units u on u.id = e.unit_id where e.workspace_id = $1 and e.pay_status in ('paid','reversed') and e.paid_on is not null", [wsId])).rows) {
      const row = { date: String(e.paid_on), text: `${e.supplier}${e.invoice_no ? ` ${e.invoice_no}` : ''} — ${e.description}${e.unit_ref ? ` (unit ${e.unit_ref})` : ' (shared)'}`, cat: 'expenses', amount: -Number(e.amount_minor) };
      if (e.paid_by === 'saraydar_held_funds') { ev.push(row); if (e.pay_status === 'reversed') ev.push({ ...row, text: `Payment reversed: ${row.text}`, amount: Number(e.amount_minor) }); }
      else if (e.paid_by === 'owner_direct' && e.pay_status === 'paid') memo.push({ ...row, text: `Paid directly by the owner: ${row.text}` });
    }
    const KIND = { opening_cash: ['Opening cash held at takeover', 'receipts', 1], contribution: ['Owner contribution', 'contributions', 1], transfer: ['Transfer to owner (recorded)', 'transfers', -1], fee_deduction: ['SarayDar fee deducted (authorised)', 'fees', -1] };
    for (const t of (await pool.query('select o.*, f.number as fee_no from owner_txns o left join fee_invoices f on f.id = o.fee_invoice_id where o.workspace_id = $1', [wsId])).rows) {
      const [label, cat, sign] = KIND[t.kind];
      ev.push({ date: String(t.on_date), text: `${label}${t.fee_no ? ` — ${t.fee_no}` : ''}${t.reference ? ` · ${t.reference}` : ''}${t.notes ? ` · ${t.notes}` : ''}`, cat, amount: sign * Number(t.amount_minor), id: t.id, kind: t.kind, status: t.status });
      if (t.status === 'reversed') ev.push({ date: bhDay(t.created_at), text: `Reversal: ${label} — ${t.reverse_reason}`, cat, amount: -sign * Number(t.amount_minor) });
    }
    ev.sort((x, y) => x.date.localeCompare(y.date));
    let opening = 0; const rows = [];
    for (const e of ev) { if (e.date < from) opening += e.amount; else if (e.date <= to) rows.push(e); }
    let bal = opening; for (const e of rows) { bal += e.amount; e.balance = bal; }
    const sumCat = c => rows.filter(e => e.cat === c).reduce((s, e) => s + e.amount, 0);
    const prof = await PR.profileOf(wsId);
    const liab = Number((await pool.query("select coalesce(sum(amount_minor),0) as s from prop_expenses where workspace_id = $1 and status = 'approved' and pay_status <> 'paid' and paid_by = 'saraydar_held_funds' and incurred_on <= $2", [wsId, to])).rows[0].s);
    const deposits = Number((await pool.query("select coalesce(sum(case when kind = 'received' then amount_minor else -amount_minor end),0) as s from deposit_txns where workspace_id = $1 and on_date <= $2 and holder = 'saraydar'", [wsId, to])).rows[0].s);
    const arrears = (await arrearsAsOf(wsId, to)).reduce((s, x) => s + x.out, 0);
    const reserve = Number(prof.reserve_minor || 0);
    const available = Math.max(0, bal - liab - reserve);
    return { opening, rows, closing: bal, receipts: sumCat('receipts'), contributions: sumCat('contributions'), expenses: sumCat('expenses'), fees: sumCat('fees'), transfers: sumCat('transfers'),
      liabilities: liab, reserve, available, deposits, arrears, memo: memo.filter(m => m.date >= from && m.date <= to), prof };
  }
  ctx.ownerAccount = ownerAccount;

  r.get('/w/:id/owner', async (req, res) => {
    const a = await PR.access(req, 'finance');
    const per = periodOf(req.query);
    const acc = await ownerAccount(a.ws.id, per.from, per.to);
    const now = per.to >= todayBH() ? acc : await ownerAccount(a.ws.id, '2000-01-01', todayBH());
    const L = ctx.feeLedger ? await ctx.feeLedger(a.ws.id) : null;
    const openFees = L ? L.invoices.filter(i => i.status === 'issued' && i.outstanding > 0) : [];
    const owner = a.ws.party_id ? (await pool.query('select name from parties where id = $1', [a.ws.party_id])).rows[0] : null;
    const id = a.ws.id;
    const qs = new URLSearchParams({ preset: per.preset, from: per.from, to: per.to });
    res.send(page(req, a, 'Owner Account', html`
      ${periodForm(per)}
      <section class="grid-cards" aria-label="Owner account">
        <div class="card"><div class="muted small">Cash held for the owner at ${fmtDate(per.to)}</div><div class="big">${fm(acc.closing)}</div><div class="muted small">Opening ${fm(acc.opening)} + receipts − expenses − fees − transfers</div></div>
        <div class="card"><div class="muted small">Available to transfer</div><div class="big">${fm(acc.available)}</div><div class="muted small">After unpaid approved expenses ${fm(acc.liabilities)} and reserve ${fm(acc.reserve)}</div></div>
        <div class="card"><div class="muted small">Tenant arrears at ${fmtDate(per.to)}</div><div class="big ${acc.arrears ? 'err' : ''}">${fm(acc.arrears)}</div><div class="muted small">Due but unpaid — not cash</div></div>
        <div class="card"><div class="muted small">Deposits held by SarayDar</div><div class="big">${fm(acc.deposits)}</div><div class="muted small">Owed to tenants — not owner funds</div></div>
      </section>
      ${acc.prof.rent_collector !== 'saraydar' ? html`<div class="notice info">Rent for this property is collected by ${acc.prof.rent_collector === 'owner' ? 'the owner' : 'another party'}; payments received by them appear as memo lines, not as cash held by SarayDar.</div>` : ''}
      <section class="panel"><div class="row-between"><h2 class="h">Owner statement · ${owner ? owner.name : 'owner not linked'} · ${per.label}</h2><a class="btn small" href="/w/${id}/owner/statement.pdf?${qs}">Statement PDF for the owner</a></div>
        <div class="table-wrap"><table><thead><tr><th>Date</th><th>Details</th><th class="n">In</th><th class="n">Out</th><th class="n">Balance held</th><th></th></tr></thead><tbody>
          <tr><td></td><td><b>Opening balance</b></td><td></td><td></td><td class="n">${fm(acc.opening)}</td><td></td></tr>
          ${acc.rows.map(e => html`<tr><td class="small">${fmtDate(e.date)}</td><td class="small">${e.text}</td><td class="n">${e.amount > 0 ? fm(e.amount) : ''}</td><td class="n">${e.amount < 0 ? fm(-e.amount) : ''}</td><td class="n">${fm(e.balance)}</td>
            <td>${a.canPost && e.id && e.status === 'recorded' && e.kind !== 'opening_cash' ? html`<details class="inline-form"><summary class="small">Reverse</summary><form method="post" action="/w/${id}/owner/txns/${e.id}/reverse" class="actions">${csrfField(req)}<input name="reason" placeholder="Reason" aria-label="Reason" required><button class="btn small" type="submit">Reverse</button></form></details>` : ''}</td></tr>`)}
          <tr class="total"><td></td><td>Closing balance held</td><td class="n">${fm(acc.receipts + acc.contributions)}</td><td class="n">${fm(-(acc.expenses + acc.fees + acc.transfers))}</td><td class="n">${fm(acc.closing)}</td><td></td></tr></tbody></table></div>
        <dl class="stats inline"><div><dt>Rent and other receipts</dt><dd>${fm(acc.receipts)}</dd></div><div><dt>Owner contributions</dt><dd>${fm(acc.contributions)}</dd></div><div><dt>Expenses paid</dt><dd>${fm(-acc.expenses)}</dd></div><div><dt>SarayDar fees deducted</dt><dd>${fm(-acc.fees)}</dd></div><div><dt>Transfers to owner</dt><dd>${fm(-acc.transfers)}</dd></div></dl>
        ${acc.memo.length ? html`<h3 class="h3">For information (not cash held by SarayDar)</h3><ul class="rows">${acc.memo.map(m => html`<li><div class="grow">${fmtDate(m.date)} · ${m.text}</div><b>${fm(Math.abs(m.amount))}</b></li>`)}</ul>` : ''}
        ${openFees.length ? html`<p class="small warn-text">Unpaid SarayDar fee invoices: ${openFees.map(i => `${i.number} ${formatMoney(i.outstanding)}`).join(', ')} — <a href="/w/${id}/fees">Fee Billing</a>.</p>` : ''}
      </section>
      ${a.canPost ? html`<div class="split">
        <form method="post" action="/w/${id}/owner/txns" class="panel grow1 form-grid">${csrfField(req)}<h3 class="h3 full">Record a transfer to the owner</h3><input type="hidden" name="kind" value="transfer">
          ${field({ name: 'on_date', label: 'Transfer date', type: 'date', required: true, value: todayBH() })}${field({ name: 'amount', label: `Amount (up to ${fm(now.available)} available)`, required: true })}
          ${field({ name: 'reference', label: 'Bank reference', required: true })}${field({ name: 'notes', label: 'Notes' })}
          <div class="actions full"><button class="btn primary" type="submit">Record transfer</button></div><p class="muted small full">Records a transfer already made through the bank. The system does not move money.</p></form>
        <form method="post" action="/w/${id}/owner/txns" class="panel grow1 form-grid">${csrfField(req)}<h3 class="h3 full">Record an owner contribution</h3><input type="hidden" name="kind" value="contribution">
          ${field({ name: 'on_date', label: 'Date received', type: 'date', required: true, value: todayBH() })}${field({ name: 'amount', label: 'Amount (BHD)', required: true })}
          ${field({ name: 'reference', label: 'Reference' })}${field({ name: 'notes', label: 'Purpose' })}<div class="actions full"><button class="btn" type="submit">Record contribution</button></div></form>
        ${acc.prof.fee_deduction_allowed && openFees.length ? html`<form method="post" action="/w/${id}/owner/fee-deduction" class="panel grow1 form-grid">${csrfField(req)}<h3 class="h3 full">Deduct a SarayDar fee from collected rent</h3>
          ${field({ name: 'fee_invoice_id', label: 'Fee invoice', options: openFees.map(i => [i.id, `${i.number} · outstanding ${fm(i.outstanding)}`]) })}${field({ name: 'amount', label: 'Amount (BHD)', required: true })}
          ${field({ name: 'on_date', label: 'Date', type: 'date', required: true, value: todayBH() })}<div class="actions full"><button class="btn" type="submit">Deduct and settle invoice</button></div>
          <p class="muted small full">Allowed by the owner for this property. Settles the fee invoice (shown in Fee Billing as “Deduction from rent”) and appears once on the owner statement.</p></form>` : ''}
      </div>` : ''}`));
  });

  r.post('/w/:id/owner/txns', async (req, res) => {
    const a = await PR.access(req, 'post');
    const kind = ['transfer', 'contribution'].includes(req.body.kind) ? req.body.kind : null; if (!kind) throw bad('Unknown entry.');
    const on = dateOrNull(req.body.on_date); if (!on) throw bad('Enter the date.');
    if (on > todayBH()) throw bad('The date cannot be in the future.');
    const amt = parseMoney(req.body.amount, 'BHD'); if (!amt || amt <= 0) throw bad('Enter the amount.');
    const ref = txt(req.body.reference, 80);
    if (kind === 'transfer' && !ref) throw bad('Enter the bank reference of the transfer.');
    await core.inTx(async db => {
      await db.query('select id from workspaces where id = $1 for update', [a.ws.id]);
      if (kind === 'transfer') {
        const acc = await ownerAccount(a.ws.id, '2000-01-01', todayBH());
        if (amt > acc.available) throw bad(`Only ${formatMoney(acc.available)} is available to transfer (cash held ${formatMoney(acc.closing)}, less unpaid approved expenses and the reserve).`);
      }
      const id = (await db.query('insert into owner_txns (workspace_id, kind, on_date, amount_minor, reference, notes, created_by) values ($1,$2,$3,$4,$5,$6,$7) returning id', [a.ws.id, kind, on, amt, ref, txt(req.body.notes, 300), req.user.id])).rows[0].id;
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: `owner.${kind}`, entity: 'owner_txn', entityId: id, summary: `Owner ${kind === 'transfer' ? 'transfer recorded' : 'contribution recorded'}: ${formatMoney(amt)}${ref ? ` (${ref})` : ''}`, ip: req.ip });
      await PR.touch(db, a.ws.id);
    });
    res.redirect(`/w/${a.ws.id}/owner?msg=saved`);
  });

  r.post('/w/:id/owner/fee-deduction', async (req, res) => {
    const a = await PR.access(req, 'post');
    const prof = await PR.profileOf(a.ws.id);
    if (!prof.fee_deduction_allowed) throw bad('The owner has not authorised fee deductions for this property.');
    if (!UUID.test(req.body.fee_invoice_id || '')) throw bad('Choose the fee invoice.');
    const amt = parseMoney(req.body.amount, 'BHD'); if (!amt || amt <= 0) throw bad('Enter the amount.');
    const on = dateOrNull(req.body.on_date); if (!on) throw bad('Enter the date.');
    await core.inTx(async db => {
      await db.query('select id from workspaces where id = $1 for update', [a.ws.id]);
      const inv = (await db.query("select * from fee_invoices where id = $1 and workspace_id = $2 for update", [req.body.fee_invoice_id, a.ws.id])).rows[0];
      if (!inv || inv.status !== 'issued') throw bad('Choose an issued fee invoice of this property.');
      const used = Number((await db.query("select coalesce((select sum(amount_minor) from fee_allocations where invoice_id = $1 and status = 'active'),0) + coalesce((select sum(amount_minor) from fee_credit_notes where invoice_id = $1),0) as s", [inv.id])).rows[0].s);
      const out = Number(inv.total_minor) - used;
      if (amt > out) throw bad(`Invoice ${inv.number} has only ${formatMoney(out)} outstanding.`);
      const acc = await ownerAccount(a.ws.id, '2000-01-01', todayBH());
      if (amt > acc.available) throw bad(`Only ${formatMoney(acc.available)} of collected funds is available.`);
      const tid = (await db.query("insert into owner_txns (workspace_id, kind, on_date, amount_minor, fee_invoice_id, reference, created_by) values ($1,'fee_deduction',$2,$3,$4,$5,$6) returning id", [a.ws.id, on, amt, inv.id, inv.number, req.user.id])).rows[0].id;
      const pid = (await db.query("insert into fee_payments (workspace_id, party_id, received_on, amount_minor, method, reference, notes, recorded_by) values ($1,$2,$3,$4,'Deduction from rent',$5,'Deducted from rent collected for the owner, as authorised',$6) returning id",
        [a.ws.id, a.ws.party_id, on, amt, `DED-${tid.slice(0, 8)}`, req.user.id])).rows[0].id;
      await db.query('insert into fee_allocations (payment_id, invoice_id, amount_minor, created_by) values ($1,$2,$3,$4)', [pid, inv.id, amt, req.user.id]);
      await db.query('update owner_txns set fee_payment_id = $2 where id = $1', [tid, pid]);
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'owner.fee_deduction', entity: 'owner_txn', entityId: tid, summary: `SarayDar fee ${formatMoney(amt)} deducted from collected rent and applied to ${inv.number}`, ip: req.ip });
      await PR.touch(db, a.ws.id);
    });
    res.redirect(`/w/${a.ws.id}/owner?msg=saved`);
  });

  r.post('/w/:id/owner/txns/:tid/reverse', async (req, res) => {
    const a = await PR.access(req, 'post');
    const t = await PR.own('owner_txns', req.params.tid, a.ws.id);
    const reason = txt(req.body.reason, 300); if (!reason) throw bad('Give a reason.');
    if (t.kind === 'opening_cash') throw bad('Opening balances are corrected through a new reviewed opening entry.');
    await core.inTx(async db => {
      const n = (await db.query("update owner_txns set status = 'reversed', reverse_reason = $2 where id = $1 and status = 'recorded'", [t.id, reason])).rowCount;
      if (!n) throw bad('Already reversed.');
      if (t.fee_payment_id) {
        await db.query("update fee_payments set status = 'reversed', reversed_by = $2, reversed_at = now(), reverse_reason = $3 where id = $1 and status = 'confirmed'", [t.fee_payment_id, req.user.id, `Fee deduction reversed: ${reason}`]);
        await db.query("update fee_allocations set status = 'reversed', reversed_by = $2, reversed_at = now(), reverse_reason = $3 where payment_id = $1 and status = 'active'", [t.fee_payment_id, req.user.id, `Fee deduction reversed: ${reason}`]);
      }
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: `owner.${t.kind}_reversed`, entity: 'owner_txn', entityId: t.id, summary: `Owner account ${t.kind.replace('_', ' ')} of ${formatMoney(Number(t.amount_minor))} reversed: ${reason}`, ip: req.ip });
    });
    res.redirect(`/w/${a.ws.id}/owner?msg=saved`);
  });

  r.get('/w/:id/owner/statement.pdf', async (req, res) => {
    const a = await PR.access(req, 'finance');
    const per = periodOf(req.query);
    const acc = await ownerAccount(a.ws.id, per.from, per.to);
    const co = (await pool.query('select * from company_profile where id = 1')).rows[0] || {};
    const owner = a.ws.party_id ? (await pool.query('select * from parties where id = $1', [a.ws.party_id])).rows[0] : null;
    const nb = m => docs.money(m).replace(/^BHD /, '');
    const buf = await docs.render({ company: co, letterhead: co.letterhead, marginTop: co.margin_top_mm, marginBottom: co.margin_bottom_mm, title: 'Owner statement', number: a.ws.ref,
      to: owner ? [owner.billing_name || owner.name, owner.billing_address || owner.address, owner.email] : ['Owner not linked'], meta: [['Property', a.ws.name], ['Period', per.label], ['Currency', 'BHD']],
      tables: [{ head: ['Date', 'Details', 'In', 'Out', 'Balance'], widths: [0.13, 0.45, 0.14, 0.14, 0.14], align: ['left', 'left', 'right', 'right', 'right'],
        rows: [Object.assign(['', 'Opening balance held', '', '', nb(acc.opening)], { bold: true }), ...acc.rows.map(e => [fmtDate(e.date), e.text, e.amount > 0 ? nb(e.amount) : '', e.amount < 0 ? nb(-e.amount) : '', nb(e.balance)])] },
        ...(acc.memo.length ? [{ caption: 'For information — not cash held by SarayDar', head: ['Date', 'Details', 'Amount'], widths: [0.15, 0.6, 0.25], align: ['left', 'left', 'right'], rows: acc.memo.map(m => [fmtDate(m.date), m.text, docs.money(Math.abs(m.amount))]) }] : [])],
      totals: [['Receipts', docs.money(acc.receipts + acc.contributions)], ['Expenses paid', docs.money(-acc.expenses)], ['SarayDar fees deducted', docs.money(-acc.fees)], ['Transfers to you', docs.money(-acc.transfers)],
        ['Closing balance held', docs.money(acc.closing), true], ['Unpaid approved expenses', docs.money(acc.liabilities)], ['Agreed reserve', docs.money(acc.reserve)], ['Available for transfer', docs.money(acc.available), true],
        ['Tenant arrears (outstanding, not received)', docs.money(acc.arrears)], ['Tenant deposits held (not your funds)', docs.money(acc.deposits)]],
      notes: ['Transfers listed are transfers recorded after they were made through the bank.', 'Arrears and deposits are shown separately and are not part of the balance held.'] });
    await core.audit(null, { actor: req.user, workspaceId: a.ws.id, action: 'owner.statement_pdf', entity: 'workspace', entityId: a.ws.id, summary: `Owner statement PDF: ${per.label}`, ip: req.ip });
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="owner-statement-${a.ws.ref}.pdf"`, 'Cache-Control': 'private, no-store' }); res.end(buf);
  });

  // ---------- Unit History & Report ----------
  async function unitReport(a, unitId, per) {
    const u = (await pool.query('select * from units where id = $1 and workspace_id = $2', [unitId, a.ws.id])).rows[0];
    if (!u) throw new NotFound();
    const { from, to } = per;
    const owner = a.ws.party_id ? (await pool.query('select name from parties where id = $1', [a.ws.party_id])).rows[0] : null;
    const leases = (await pool.query(`select l.*, t.name as tenant_name, t.phone, t.email from leases l join parties t on t.id = l.tenant_id
      where l.unit_id = $1 and l.status in ('active','ended','terminated') and l.start_date <= $3 and coalesce(l.terminated_on, l.end_date) >= $2 order by l.start_date`, [u.id, from, to])).rows;
    for (const l of leases) l.steps = (await pool.query('select * from lease_rent_steps where lease_id = $1 order by effective_from', [l.id])).rows;
    // vacant gaps within the period (days not covered by any effective lease)
    const vacant = []; let cur = from;
    for (const l of leases) { const s = String(l.start_date) > from ? String(l.start_date) : from; if (s > cur) vacant.push([cur, addDays(s, -1)]); const e = rentLib.effectiveEnd(l); if (addDays(e, 1) > cur) cur = addDays(e, 1); }
    if (cur <= to) vacant.push([cur, to]);
    const statusAtStart = (await pool.query('select status from unit_status_history where unit_id = $1 and changed_on <= $2 order by changed_on desc, id desc limit 1', [u.id, from])).rows[0];
    const statusChanges = (await pool.query('select * from unit_status_history where unit_id = $1 and changed_on between $2 and $3 order by changed_on, id', [u.id, from, to])).rows;
    const maint = (await pool.query(`select m.* from maint_requests m where m.unit_id = $1 and m.reported_on <= $3 and (m.completed_on is null or m.completed_on >= $2) and not (m.status in ('cancelled','rejected') and m.updated_at < $2::date) order by m.reported_on`, [u.id, from, to])).rows;
    const mFiles = maint.length ? (await pool.query(`select id, entity_id, original_name, tag, mime, thumb is not null as has_thumb from files where entity = 'maint_request' and entity_id = any($1::text[]) and archived_at is null order by uploaded_at`, [maint.map(m => m.id)])).rows : [];
    const services = (await pool.query(`select t.*, s.title, s.provider from service_tasks t join service_schedules s on s.id = t.schedule_id where s.unit_id = $1 and t.scheduled_on between $2 and $3 order by t.scheduled_on`, [u.id, from, to])).rows;
    const exps = a.finance ? (await pool.query(`select e.*, x.amount_minor as share, x.basis, m.ref as maint_ref from expense_allocations x join prop_expenses e on e.id = x.expense_id left join maint_requests m on m.id = e.maint_id
      where x.unit_id = $1 and e.status = 'approved' and ((e.incurred_on between $2 and $3) or (e.paid_on between $2 and $3) or (e.incurred_on <= $3 and (e.pay_status <> 'paid' or e.paid_on > $3))) order by e.incurred_on`, [u.id, from, to])).rows : [];
    const fin = a.finance ? {
      incurred: exps.filter(e => String(e.incurred_on) >= from && String(e.incurred_on) <= to).reduce((s, e) => s + Number(e.share), 0),
      paid: exps.filter(e => e.pay_status === 'paid' && String(e.paid_on) >= from && String(e.paid_on) <= to).reduce((s, e) => s + Number(e.share), 0),
      unpaidEnd: exps.filter(e => String(e.incurred_on) <= to && !(e.pay_status === 'paid' && String(e.paid_on) <= to)).reduce((s, e) => s + Number(e.share), 0),
      shared: exps.filter(e => e.basis !== 'direct').reduce((s, e) => s + (String(e.incurred_on) >= from && String(e.incurred_on) <= to ? Number(e.share) : 0), 0),
      rentDue: Number((await pool.query("select coalesce(sum(amount_minor),0) as s from rent_charges where unit_id = $1 and status = 'open' and due_date between $2 and $3", [u.id, from, to])).rows[0].s),
      credits: Number((await pool.query("select coalesce(sum(r.amount_minor),0) as s from rent_credits r join rent_charges c on c.id = r.charge_id where c.unit_id = $1 and r.on_date between $2 and $3", [u.id, from, to])).rows[0].s),
      collected: Number((await pool.query("select coalesce(sum(p.amount_minor),0) as s from tenant_payments p join leases l on l.id = p.lease_id where l.unit_id = $1 and p.status in ('confirmed','reversed') and p.received_on between $2 and $3", [u.id, from, to])).rows[0].s)
        - Number((await pool.query("select coalesce(sum(p.amount_minor),0) as s from tenant_payments p join leases l on l.id = p.lease_id where l.unit_id = $1 and p.status = 'reversed' and (p.reversed_at at time zone 'Asia/Bahrain')::date between $2 and $3", [u.id, from, to])).rows[0].s),
      openingArrears: (await arrearsAsOf(a.ws.id, addDays(from, -1), u.id)).reduce((s, x) => s + x.out, 0),
      outstandingEnd: (await arrearsAsOf(a.ws.id, to, u.id)).reduce((s, x) => s + x.out, 0),
      payments: (await pool.query("select p.*, l.ref from tenant_payments p join leases l on l.id = p.lease_id where l.unit_id = $1 and p.received_on between $2 and $3 order by p.received_on", [u.id, from, to])).rows,
      charges: (await pool.query("select c.*, l.ref from rent_charges c join leases l on l.id = c.lease_id where c.unit_id = $1 and c.due_date between $2 and $3 order by c.due_date", [u.id, from, to])).rows
    } : null;
    const events = [];
    for (const l of leases) {
      if (String(l.start_date) >= from) events.push([String(l.start_date), `Lease ${l.ref} starts — ${l.tenant_name}`]);
      if (l.move_in_date && String(l.move_in_date) >= from && String(l.move_in_date) <= to) events.push([String(l.move_in_date), `${l.tenant_name} moved in`]);
      if (l.move_out_date && String(l.move_out_date) >= from && String(l.move_out_date) <= to) events.push([String(l.move_out_date), `${l.tenant_name} moved out`]);
      if (rentLib.effectiveEnd(l) <= to) events.push([rentLib.effectiveEnd(l), `Lease ${l.ref} ${l.terminated_on ? 'terminated' : 'ends'}`]);
    }
    for (const s of statusChanges) events.push([String(s.changed_on), `Status: ${UNIT_STATUS[s.status]}${s.reason ? ` — ${s.reason}` : ''}`]);
    for (const m of maint) { if (String(m.reported_on) >= from) events.push([String(m.reported_on), `${m.ref} reported: ${m.title}`]); if (m.completed_on && String(m.completed_on) <= to) events.push([String(m.completed_on), `${m.ref} completed`]); }
    if (fin) for (const p of fin.payments) if (['confirmed', 'reversed'].includes(p.status)) events.push([String(p.received_on), `Payment ${formatMoney(Number(p.amount_minor))} received (${p.ref})${p.status === 'reversed' ? ' — later reversed' : ''}`]);
    events.sort((x, y) => x[0].localeCompare(y[0]));
    return { u, owner, leases, vacant, statusAtStart: statusAtStart ? statusAtStart.status : null, maint, mFiles, services, exps, fin, events, per,
      openAtStart: maint.filter(m => String(m.reported_on) < from && (!m.completed_on || String(m.completed_on) >= from)).length,
      unresolvedAtEnd: maint.filter(m => !m.completed_on || String(m.completed_on) > to).filter(m => !['cancelled', 'rejected'].includes(m.status)).length };
  }

  const unitSection = (a, R) => {
    const id = a.ws.id, f = R.fin;
    return html`<section class="panel unit-report"><h2 class="h">Unit ${R.u.ref} <span class="muted small">${R.u.unit_type || ''}${R.u.floor ? ` · floor ${R.u.floor}` : ''} · owner ${R.owner ? R.owner.name : '—'} · status at start: ${R.statusAtStart ? UNIT_STATUS[R.statusAtStart] : 'not recorded'}</span></h2>
      <section class="grid-cards">
        <div class="card"><div class="muted small">Tenancies in period</div><div class="big">${R.leases.length}</div><div class="muted small">${R.vacant.length ? `Vacant: ${R.vacant.map(v => `${fmtDate(v[0])}–${fmtDate(v[1])}`).join(', ')}` : 'No vacant days'}</div></div>
        <div class="card"><div class="muted small">Maintenance</div><div class="big">${R.maint.length}</div><div class="muted small">${R.openAtStart} open at start · ${R.unresolvedAtEnd} unresolved at end</div></div>
        ${f ? html`<div class="card"><div class="muted small">Rent due / collected</div><div class="mid">${fm(f.rentDue - f.credits)} / ${fm(f.collected)}</div><div class="muted small">Outstanding at end ${fm(f.outstandingEnd)} (opening ${fm(f.openingArrears)})</div></div>
        <div class="card"><div class="muted small">Costs incurred / paid</div><div class="mid">${fm(f.incurred)} / ${fm(f.paid)}</div><div class="muted small">Unpaid at end ${fm(f.unpaidEnd)} · shared-cost share ${fm(f.shared)}</div></div>` : ''}
      </section>
      <h3 class="h3">Tenancies</h3>
      ${R.leases.length ? html`<div class="table-wrap"><table><thead><tr><th>Tenant</th><th>Contact</th><th>Lease</th><th>Start – end</th><th>Moved in / out</th>${f ? html`<th>Agreed rent</th>` : ''}<th>Status</th></tr></thead><tbody>
        ${R.leases.map(l => html`<tr><td><b>${l.tenant_name}</b></td><td class="small">${[l.phone, l.email].filter(Boolean).join(' · ') || '—'}</td><td><a href="/w/${id}/leases/${l.id}">${l.ref}</a>${l.renewal_of ? html`<div class="muted small">renewal</div>` : ''}</td>
          <td class="small">${fmtDate(l.start_date)} – ${fmtDate(rentLib.effectiveEnd(l))}${l.terminated_on ? ' (terminated)' : ''}</td><td class="small">${fmtDate(l.move_in_date) || '—'} / ${fmtDate(l.move_out_date) || '—'}</td>
          ${f ? html`<td class="small">${l.steps.map(s => html`<div>${fm(s.rent_minor)} from ${fmtDate(s.effective_from)}</div>`)}</td>` : ''}<td>${l.status}</td></tr>`)}</tbody></table></div>` : html`<p class="muted">No tenancy in this period.</p>`}
      <h3 class="h3">Maintenance, repairs and inspections</h3>
      ${R.maint.length ? html`<div class="table-wrap"><table><thead><tr><th>Request</th><th>Reported / done</th><th>Provider</th><th>Approval</th><th>Responsible</th>${f ? html`<th class="n">Estimate</th>` : ''}<th>Status</th></tr></thead><tbody>
        ${R.maint.map(m => html`<tr><td><a href="/w/${id}/maintenance/${m.id}">${m.ref}</a> ${m.title}<div class="muted small">${m.category}${m.description ? ` · ${m.description.slice(0, 120)}` : ''}</div>
          ${R.mFiles.filter(x => x.entity_id === m.id && x.has_thumb).length ? html`<div class="gallery">${R.mFiles.filter(x => x.entity_id === m.id && x.has_thumb).slice(0, 6).map(x => html`<a href="/files/${x.id}"><img src="/files/${x.id}/thumb" alt="${x.tag || 'photo'}" loading="lazy" title="${x.tag || ''}"></a>`)}</div>` : ''}</td>
          <td class="small">${fmtDate(m.reported_on)} / ${fmtDate(m.completed_on) || '—'}${m.verified_on ? html`<div>verified ${fmtDate(m.verified_on)}</div>` : ''}</td><td class="small">${m.provider || '—'}</td><td class="small">${m.approval.replace('_', ' ')}${m.approval_ref ? ` · ${m.approval_ref}` : ''}</td><td class="small">${RESP[m.responsible]}</td>
          ${f ? html`<td class="n">${fm(m.estimate_minor)}</td>` : ''}<td>${M_STATUS[m.status]}</td></tr>`)}</tbody></table></div>` : html`<p class="muted">None.</p>`}
      ${R.services.length ? html`<h3 class="h3">Unit cleaning and services</h3><ul class="rows">${R.services.map(s => html`<li><div class="grow">${fmtDate(s.scheduled_on)} · ${s.title}<div class="muted small">${s.provider || ''}${s.notes ? ` · ${s.notes}` : ''}</div></div>${s.status}</li>`)}</ul>` : ''}
      ${f ? html`<h3 class="h3">Expenses for this unit</h3>
        ${R.exps.length ? html`<div class="table-wrap"><table><thead><tr><th>Incurred</th><th>Supplier / description</th><th>Category</th><th>Basis</th><th>Payer / responsible</th><th class="n">Full amount</th><th class="n">Unit share</th><th>Paid</th></tr></thead><tbody>
          ${R.exps.map(e => html`<tr><td class="small"><a href="/w/${id}/expenses/${e.id}">${fmtDate(e.incurred_on)}</a></td><td>${e.supplier}${e.invoice_no ? ` ${e.invoice_no}` : ''}<div class="muted small">${e.description}${e.maint_ref ? ` · ${e.maint_ref}` : ''}</div></td><td class="small">${e.category}</td>
            <td class="small">${e.basis === 'direct' ? 'This unit' : `Shared (${e.basis})`}</td><td class="small">${PAID_BY[e.paid_by] || '—'}<div class="muted">${RESP[e.responsible]}</div></td><td class="n">${fm(e.amount_minor)}</td><td class="n"><b>${fm(e.share)}</b></td><td class="small">${e.pay_status === 'paid' ? fmtDate(e.paid_on) : e.pay_status}</td></tr>`)}</tbody></table></div>
          <p class="muted small">Costs incurred = unit shares with an invoice date in the period. Cash paid = shares paid in the period. Unpaid at end = incurred by the end date and not paid by then. Shared building costs show the full amount and this unit's share only.</p>` : html`<p class="muted">None.</p>`}
        <h3 class="h3">Rent</h3>
        <div class="table-wrap"><table><thead><tr><th>Due</th><th>Lease</th><th>Charge</th><th class="n">Amount</th><th>Status</th></tr></thead><tbody>
          ${f.charges.map(c => html`<tr><td class="small">${fmtDate(c.due_date)}</td><td class="small">${c.ref}</td><td class="small">${c.description}</td><td class="n">${fm(c.amount_minor)}</td><td class="small">${c.status === 'void' ? 'void' : ''}</td></tr>`)}
          ${!f.charges.length ? html`<tr><td colspan="5" class="muted">No rent due in the period.</td></tr>` : ''}</tbody></table></div>
        <p class="muted small">Rent due = charges with a due date in the period (credits ${fm(f.credits)} shown separately). Collected = confirmed payments received in the period, less reversals recorded in it. Outstanding at end follows the as-of policy: payments received after the end date are not counted.</p>` : ''}
      <h3 class="h3">Chronological history</h3>${R.events.length ? html`<ol class="feed">${R.events.map(e => html`<li><b>${fmtDate(e[0])}</b> · ${e[1]}</li>`)}</ol>` : html`<p class="muted">No events in the period.</p>`}
    </section>`;
  };

  async function selection(a, q) {
    const units = await PR.unitsOf(a.ws.id);
    const pick = [].concat(q.unit || []).filter(x => UUID.test(x));
    const ids = q.all === '1' ? units.map(u => u.id) : pick.filter(x => units.some(u => u.id === x));
    return { units, ids };
  }

  r.get('/w/:id/history', async (req, res) => {
    const a = await PR.access(req);
    const per = periodOf(req.query);
    const { units, ids } = await selection(a, req.query);
    const reports = [];
    for (const uid of ids.slice(0, 60)) reports.push(await unitReport(a, uid, per));
    const qs = new URLSearchParams(req.query); qs.delete('msg');
    res.send(page(req, a, 'Unit History', html`
      <form class="filters" method="get">
        <select name="unit" multiple size="4" aria-label="Units" style="min-width:180px">${units.map(u => html`<option value="${u.id}" ${ids.includes(u.id) ? raw('selected') : ''}>${u.ref}</option>`)}</select>
        <label class="check small"><input type="checkbox" name="all" value="1" ${req.query.all === '1' ? raw('checked') : ''}> Whole building</label>
        <select name="preset" aria-label="Period">${[['month', 'This month'], ['last_month', 'Last month'], ['quarter', 'This quarter'], ['year', 'This year'], ['all', 'All history'], ['custom', 'Custom dates']].map(([v, l]) => html`<option value="${v}" ${v === per.preset ? raw('selected') : ''}>${l}</option>`)}</select>
        <label class="small">From <input type="date" name="from" value="${per.from}"></label><label class="small">To <input type="date" name="to" value="${per.to}"></label>
        <button class="btn primary" type="submit">Show report</button>
        ${ids.length ? html`<span class="grow"></span><a class="btn" href="/w/${a.ws.id}/history.pdf?${qs}">PDF with photos</a><a class="btn" href="/w/${a.ws.id}/history.xlsx?${qs}">Excel workbook</a>` : ''}</form>
      ${ids.length ? html`<p class="muted small">${per.label} · ${ids.length} unit(s). Each unit is reported separately; shared costs appear as each unit's share.</p>${reports.map(R => unitSection(a, R))}`
        : emptyState('Choose a unit and a period', 'Select one or more units (hold Ctrl / ⌘ for several) or tick Whole building, then Show report.')}`));
  });

  async function photoImages(R, limit = 12) {
    const out = [];
    for (const f of R.mFiles.filter(x => x.has_thumb && ['before', 'after', 'completion'].includes(x.tag)).slice(0, limit)) {
      const d = (await pool.query('select data from files where id = $1', [f.id])).rows[0];
      try { out.push({ buf: await sharp(d.data).rotate().resize(700, 700, { fit: 'inside' }).jpeg({ quality: 72 }).toBuffer(), caption: `${(R.maint.find(m => m.id === f.entity_id) || {}).ref || ''} · ${f.tag}` }); } catch { /* skip */ }
    }
    return out;
  }

  r.get('/w/:id/history.pdf', async (req, res) => {
    const a = await PR.access(req);
    const per = periodOf(req.query);
    const { ids } = await selection(a, req.query);
    if (!ids.length) throw bad('Choose a unit.');
    const co = (await pool.query('select * from company_profile where id = 1')).rows[0] || {};
    const tables = [], images = [];
    const totals = [];
    for (const uid of ids.slice(0, 60)) {
      const R = await unitReport(a, uid, per);
      tables.push({ caption: `Unit ${R.u.ref} — tenancies`, head: ['Tenant', 'Lease', 'Start – end', 'Moved in / out'], widths: [0.3, 0.2, 0.3, 0.2], empty: 'No tenancy in the period',
        rows: [...R.leases.map(l => [l.tenant_name, l.ref, `${fmtDate(l.start_date)} – ${fmtDate(rentLib.effectiveEnd(l))}`, `${fmtDate(l.move_in_date) || '—'} / ${fmtDate(l.move_out_date) || '—'}`]), ...R.vacant.map(v => ['Vacant', '', `${fmtDate(v[0])} – ${fmtDate(v[1])}`, ''])] });
      tables.push({ caption: `Unit ${R.u.ref} — maintenance`, head: ['Request', 'Reported / done', 'Provider', 'Responsible', 'Status'], widths: [0.34, 0.2, 0.18, 0.12, 0.16], empty: 'None',
        rows: R.maint.map(m => [`${m.ref} ${m.title}`, `${fmtDate(m.reported_on)} / ${fmtDate(m.completed_on) || '—'}`, m.provider || '—', RESP[m.responsible], M_STATUS[m.status]]) });
      if (R.fin) {
        tables.push({ caption: `Unit ${R.u.ref} — expenses`, head: ['Incurred', 'Supplier / description', 'Basis', 'Full', 'Unit share', 'Paid'], widths: [0.12, 0.34, 0.14, 0.13, 0.13, 0.14], align: ['left', 'left', 'left', 'right', 'right', 'left'], empty: 'None',
          rows: R.exps.map(e => [fmtDate(e.incurred_on), `${e.supplier} — ${e.description}`, e.basis === 'direct' ? 'This unit' : `Shared (${e.basis.split(':')[0]})`, docs.money(Number(e.amount_minor)), docs.money(Number(e.share)), e.pay_status === 'paid' ? fmtDate(e.paid_on) : e.pay_status]) });
        tables.push({ caption: `Unit ${R.u.ref} — figures`, head: ['Measure', 'Amount'], widths: [0.7, 0.3], align: ['left', 'right'], rows: [
          ['Rent due in period (before credits)', docs.money(R.fin.rentDue)], ['Credits in period', docs.money(R.fin.credits)], ['Rent collected in period', docs.money(R.fin.collected)],
          ['Rent outstanding at start', docs.money(R.fin.openingArrears)], ['Rent outstanding at end', docs.money(R.fin.outstandingEnd)], ['Costs incurred in period (unit share)', docs.money(R.fin.incurred)],
          ['Cash paid in period (unit share)', docs.money(R.fin.paid)], ['Unpaid costs at end', docs.money(R.fin.unpaidEnd)], ['Shared building costs allocated', docs.money(R.fin.shared)]] });
      }
      images.push(...await photoImages(R, Math.max(0, 24 - images.length)));
    }
    const buf = await docs.render({ company: co, letterhead: co.letterhead, marginTop: co.margin_top_mm, marginBottom: co.margin_bottom_mm, title: 'Unit history report', number: a.ws.ref, toLabel: 'PROPERTY',
      to: [a.ws.name, a.ws.location], meta: [['Period', per.label], ['Units', String(ids.length)], ['Prepared', fmtDate(todayBH())]], tables, images,
      notes: ['As-of policy: payments count from the day received once confirmed; later settlements do not change this period\'s closing figures.', 'Shared building costs show each unit\'s share only.'] });
    await core.audit(null, { actor: req.user, workspaceId: a.ws.id, action: 'report.unit_history_pdf', entity: 'workspace', entityId: a.ws.id, summary: `Unit history PDF: ${ids.length} unit(s), ${per.label}`, ip: req.ip });
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="unit-history-${a.ws.ref}.pdf"`, 'Cache-Control': 'private, no-store' }); res.end(buf);
  });

  r.get('/w/:id/history.xlsx', async (req, res) => {
    const a = await PR.access(req);
    const per = periodOf(req.query);
    const { ids } = await selection(a, req.query);
    if (!ids.length) throw bad('Choose a unit.');
    const wb = new ExcelJS.Workbook(); wb.creator = 'SarayDar Management System';
    const sheet = (name, cols) => { const s = wb.addWorksheet(name); s.columns = cols.map(([h, w]) => ({ header: h, width: w || 18 })); s.getRow(1).font = { bold: true }; return s; };
    const sum = sheet('Summary', [['Unit', 12], ['Period', 26], ['Tenancies'], ['Vacant periods', 40], ['Maintenance items'], ['Open at start'], ['Unresolved at end'], ...(a.finance ? [['Rent due'], ['Credits'], ['Collected'], ['Outstanding at start'], ['Outstanding at end'], ['Costs incurred'], ['Cash paid'], ['Unpaid at end'], ['Shared costs allocated']] : [])]);
    const ten = sheet('Tenancy', [['Unit', 12], ['Tenant', 26], ['Contact', 30], ['Lease', 16], ['Start'], ['End'], ['Moved in'], ['Moved out'], ['Status'], ...(a.finance ? [['Rent / month (latest)']] : [])]);
    const mt = sheet('Maintenance', [['Unit', 12], ['Request', 14], ['Issue', 34], ['Category'], ['Reported'], ['Completed'], ['Verified'], ['Provider', 22], ['Approval', 20], ['Responsible'], ...(a.finance ? [['Estimate']] : []), ['Status', 20]]);
    const fin = a.finance ? sheet('Finance', [['Unit', 12], ['Type', 14], ['Date'], ['Reference', 18], ['Description', 40], ['Basis', 24], ['Full amount'], ['Unit amount'], ['Paid on'], ['Status']]) : null;
    const money = v => Number(v) / 1000;
    const fmt3 = '#,##0.000';
    for (const uid of ids.slice(0, 200)) {
      const R = await unitReport(a, uid, per);
      sum.addRow([safe(R.u.ref), per.label, R.leases.length, R.vacant.map(v => `${v[0]} to ${v[1]}`).join('; '), R.maint.length, R.openAtStart, R.unresolvedAtEnd,
        ...(R.fin ? [money(R.fin.rentDue), money(R.fin.credits), money(R.fin.collected), money(R.fin.openingArrears), money(R.fin.outstandingEnd), money(R.fin.incurred), money(R.fin.paid), money(R.fin.unpaidEnd), money(R.fin.shared)] : [])]);
      for (const l of R.leases) ten.addRow([safe(R.u.ref), safe(l.tenant_name), safe([l.phone, l.email].filter(Boolean).join(' · ')), l.ref, String(l.start_date), rentLib.effectiveEnd(l), l.move_in_date ? String(l.move_in_date) : '', l.move_out_date ? String(l.move_out_date) : '', l.status, ...(a.finance ? [money(l.steps.length ? l.steps[l.steps.length - 1].rent_minor : l.rent_minor)] : [])]);
      for (const v of R.vacant) ten.addRow([safe(R.u.ref), 'Vacant', '', '', v[0], v[1], '', '', 'vacant']);
      for (const m of R.maint) mt.addRow([safe(R.u.ref), m.ref, safe(m.title), safe(m.category), String(m.reported_on), m.completed_on ? String(m.completed_on) : '', m.verified_on ? String(m.verified_on) : '', safe(m.provider || ''), m.approval, RESP[m.responsible], ...(a.finance ? [m.estimate_minor === null ? null : money(m.estimate_minor)] : []), M_STATUS[m.status]]);
      if (fin && R.fin) {
        for (const e of R.exps) fin.addRow([safe(R.u.ref), 'Expense', String(e.incurred_on), safe(e.invoice_no || ''), safe(`${e.supplier} — ${e.description}`), e.basis, money(e.amount_minor), money(e.share), e.paid_on ? String(e.paid_on) : '', e.pay_status]);
        for (const c of R.fin.charges) fin.addRow([safe(R.u.ref), 'Rent charge', String(c.due_date), c.ref, safe(c.description), '', money(c.amount_minor), money(c.amount_minor), '', c.status]);
        for (const p of R.fin.payments) fin.addRow([safe(R.u.ref), 'Payment', String(p.received_on), safe(p.reference || p.receipt_no || ''), `${p.method} (${p.ref})`, '', money(p.amount_minor), money(p.amount_minor), '', p.status]);
      }
    }
    for (const s of wb.worksheets) s.eachRow((row, i) => { if (i > 1) row.eachCell(c => { if (typeof c.value === 'number' && !Number.isInteger(c.value * 1) || (typeof c.value === 'number' && s.name !== 'Summary' && s.name !== 'Tenancy')) c.numFmt = fmt3; }); });
    sum.eachRow((row, i) => { if (i > 1) row.eachCell((c, col) => { if (col >= 8) c.numFmt = fmt3; }); });
    await core.audit(null, { actor: req.user, workspaceId: a.ws.id, action: 'report.unit_history_xlsx', entity: 'workspace', entityId: a.ws.id, summary: `Unit history Excel: ${ids.length} unit(s), ${per.label}`, ip: req.ip });
    res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="unit-history-${a.ws.ref}.xlsx"`, 'Cache-Control': 'private, no-store' });
    res.end(Buffer.from(await wb.xlsx.writeBuffer()));
  });

  // ---------- property reports ----------
  r.get('/w/:id/reports', async (req, res, next) => {
    if (!(await PR.isProps(req))) return next();
    const a = await PR.access(req);
    const per = periodOf(req.query);
    const today = todayBH(), id = a.ws.id;
    const kind = ['rentroll', 'occupancy', 'arrears', 'expiry', 'maintenance', 'expenses', 'fees'].includes(req.query.report) ? req.query.report : 'rentroll';
    const tabsR = [['rentroll', 'Rent roll'], ['occupancy', 'Occupancy'], ...(a.finance ? [['arrears', 'Arrears']] : []), ['expiry', 'Lease expiry'], ['maintenance', 'Maintenance'], ...(a.finance ? [['expenses', 'Expenses'], ['fees', 'Fee collection']] : [])];
    let body = '';
    if (kind === 'rentroll') {
      const rows = (await pool.query(`select u.ref, u.unit_type, u.status, l.ref as lease_ref, l.id as lease_id, t.name as tenant, l.start_date, l.end_date, l.terminated_on,
          (select rent_minor from lease_rent_steps s where s.lease_id = l.id and s.effective_from <= $2 order by effective_from desc limit 1) as rent
        from units u left join leases l on l.unit_id = u.id and l.status = 'active' and l.start_date <= $2 and coalesce(l.terminated_on, l.end_date) >= $2 left join parties t on t.id = l.tenant_id
        where u.workspace_id = $1 and u.archived_at is null order by u.sort, u.ref`, [id, today])).rows;
      body = html`<section class="panel"><h2 class="h">Rent roll at ${fmtDate(today)}</h2><div class="table-wrap"><table><thead><tr><th>Unit</th><th>Type</th><th>Status</th><th>Tenant</th><th>Lease</th><th>Term</th>${a.finance ? html`<th class="n">Rent / month</th>` : ''}</tr></thead><tbody>
        ${rows.map(x => html`<tr><td>${x.ref}</td><td class="small">${x.unit_type || '—'}</td><td>${UNIT_STATUS[x.status]}</td><td>${x.tenant || '—'}</td><td class="small">${x.lease_ref ? html`<a href="/w/${id}/leases/${x.lease_id}">${x.lease_ref}</a>` : '—'}</td><td class="small">${x.lease_ref ? `${fmtDate(x.start_date)} – ${fmtDate(x.terminated_on || x.end_date)}` : ''}</td>${a.finance ? html`<td class="n">${x.rent === null ? '—' : fm(x.rent)}</td>` : ''}</tr>`)}
        ${a.finance ? html`<tr class="total"><td>Total</td><td></td><td></td><td></td><td></td><td></td><td class="n">${fm(rows.reduce((s, x) => s + Number(x.rent || 0), 0))}</td></tr>` : ''}</tbody></table></div></section>`;
    } else if (kind === 'occupancy') {
      const units = await PR.unitsOf(id);
      const days = Math.round((Date.parse(per.to) - Date.parse(per.from)) / 864e5) + 1;
      const occ = [];
      for (const u of units) {
        const ls = (await pool.query("select start_date, coalesce(terminated_on, end_date) as e from leases where unit_id = $1 and status in ('active','ended','terminated') and start_date <= $3 and coalesce(terminated_on, end_date) >= $2", [u.id, per.from, per.to])).rows;
        const occDays = ls.reduce((s, l) => { const a0 = String(l.start_date) > per.from ? String(l.start_date) : per.from, b0 = String(l.e) < per.to ? String(l.e) : per.to; return s + Math.max(0, Math.round((Date.parse(b0) - Date.parse(a0)) / 864e5) + 1); }, 0);
        occ.push({ u, occDays: Math.min(days, occDays) });
      }
      const avail = occ.filter(x => x.u.status !== 'unavailable');
      const totalDays = avail.length * days, occTotal = avail.reduce((s, x) => s + x.occDays, 0);
      body = html`<section class="panel"><h2 class="h">Occupancy · ${per.label}</h2>
        <p><b>${totalDays ? (Math.round(occTotal / totalDays * 1000) / 10) : 0}%</b> of unit-days were let: ${occTotal} let unit-days ÷ ${totalDays} available unit-days (${avail.length} units × ${days} days). Units currently marked unavailable (${occ.length - avail.length}) are excluded from the denominator; units under maintenance are included.</p>
        <div class="table-wrap"><table><thead><tr><th>Unit</th><th>Status now</th><th class="n">Let days</th><th class="n">Vacant days</th><th class="n">Occupancy</th></tr></thead><tbody>
        ${occ.map(x => html`<tr><td>${x.u.ref}</td><td>${UNIT_STATUS[x.u.status]}</td><td class="n">${x.occDays}</td><td class="n">${days - x.occDays}</td><td class="n">${Math.round(x.occDays / days * 1000) / 10}%</td></tr>`)}</tbody></table></div></section>`;
    } else if (kind === 'arrears' && a.finance) {
      const ch = (await billing.chargeState(pool, "c.workspace_id = $1 and c.status = 'open' and c.due_date < $2", [id, today])).filter(c => c.outstanding > 0);
      const leases = Object.fromEntries((await pool.query('select l.id, l.ref, u.ref as unit, t.name, t.phone from leases l join units u on u.id = l.unit_id join parties t on t.id = l.tenant_id where l.workspace_id = $1', [id])).rows.map(x => [x.id, x]));
      const by = {};
      for (const c of ch) { const d = Math.round((Date.parse(today) - Date.parse(String(c.due_date))) / 864e5); const b = by[c.lease_id] || (by[c.lease_id] = { l: leases[c.lease_id], b: [0, 0, 0, 0], total: 0 }); b.b[d <= 30 ? 0 : d <= 60 ? 1 : d <= 90 ? 2 : 3] += c.outstanding; b.total += c.outstanding; }
      const rows = Object.values(by).sort((x, y) => y.total - x.total);
      body = html`<section class="panel"><h2 class="h">Arrears at ${fmtDate(today)} by days overdue</h2><div class="table-wrap"><table><thead><tr><th>Unit</th><th>Tenant</th><th>Lease</th><th class="n">1–30</th><th class="n">31–60</th><th class="n">61–90</th><th class="n">Over 90</th><th class="n">Total</th></tr></thead><tbody>
        ${rows.map(x => html`<tr><td>${x.l.unit}</td><td>${x.l.name}<div class="muted small">${x.l.phone || ''}</div></td><td><a href="/w/${id}/leases/${x.l.id}">${x.l.ref}</a></td>${x.b.map(v => html`<td class="n">${v ? fm(v) : '—'}</td>`)}<td class="n"><b>${fm(x.total)}</b></td></tr>`)}
        <tr class="total"><td>Total</td><td></td><td></td>${[0, 1, 2, 3].map(i => html`<td class="n">${fm(rows.reduce((s, x) => s + x.b[i], 0))}</td>`)}<td class="n">${fm(rows.reduce((s, x) => s + x.total, 0))}</td></tr></tbody></table></div>
        <p class="muted small">Unpaid charges past their due date, after credits and confirmed payments. Payments reported but not yet confirmed are not deducted.</p></section>`;
    } else if (kind === 'expiry') {
      const rows = (await pool.query(`select l.*, u.ref as unit, t.name, (select 1 from leases n where n.renewal_of = l.id and n.status <> 'cancelled' limit 1) as renewed from leases l join units u on u.id = l.unit_id join parties t on t.id = l.tenant_id
        where l.workspace_id = $1 and l.status = 'active' and coalesce(l.terminated_on, l.end_date) between $2 and $3 order by coalesce(l.terminated_on, l.end_date)`, [id, per.from, per.to < addDays(today, 90) ? addDays(today, 90) : per.to])).rows;
      body = html`<section class="panel"><h2 class="h">Leases ending (to ${fmtDate(per.to < addDays(today, 90) ? addDays(today, 90) : per.to)})</h2>${rows.length ? html`<div class="table-wrap"><table><thead><tr><th>Ends</th><th>Unit</th><th>Tenant</th><th>Lease</th><th>Renewal</th></tr></thead><tbody>
        ${rows.map(l => html`<tr><td>${fmtDate(rentLib.effectiveEnd(l))}</td><td>${l.unit}</td><td>${l.name}</td><td><a href="/w/${id}/leases/${l.id}">${l.ref}</a></td><td>${l.renewed ? pill('Prepared', 'ok') : pill('Not yet', 'warn')}</td></tr>`)}</tbody></table></div>` : html`<p class="muted">No active leases end in this window.</p>`}</section>`;
    } else if (kind === 'maintenance') {
      const rows = (await pool.query(`select m.*, u.ref as unit from maint_requests m left join units u on u.id = m.unit_id where m.workspace_id = $1 and m.reported_on <= $3 and (m.completed_on is null or m.completed_on >= $2) order by m.reported_on`, [id, per.from, per.to])).rows;
      body = html`<section class="panel"><h2 class="h">Maintenance · ${per.label}</h2><div class="table-wrap"><table><thead><tr><th>Request</th><th>Where</th><th>Reported</th><th>Completed</th><th>Provider</th><th>Responsible</th>${a.finance ? html`<th class="n">Estimate</th>` : ''}<th>Status</th></tr></thead><tbody>
        ${rows.map(m => html`<tr><td><a href="/w/${id}/maintenance/${m.id}">${m.ref}</a> ${m.title}</td><td>${m.unit || 'Common'}</td><td class="small">${fmtDate(m.reported_on)}</td><td class="small">${fmtDate(m.completed_on) || '—'}</td><td class="small">${m.provider || '—'}</td><td class="small">${RESP[m.responsible]}</td>${a.finance ? html`<td class="n">${fm(m.estimate_minor)}</td>` : ''}<td>${M_STATUS[m.status]}</td></tr>`)}</tbody></table></div></section>`;
    } else if (kind === 'expenses' && a.finance) {
      const rows = (await pool.query(`select e.*, u.ref as unit from prop_expenses e left join units u on u.id = e.unit_id where e.workspace_id = $1 and e.status = 'approved' and e.incurred_on between $2 and $3 order by e.incurred_on`, [id, per.from, per.to])).rows;
      const cats = {}; for (const e of rows) cats[e.category] = (cats[e.category] || 0) + Number(e.amount_minor);
      body = html`<section class="panel"><h2 class="h">Approved expenses · ${per.label}</h2><div class="table-wrap"><table><thead><tr><th>Incurred</th><th>Supplier</th><th>Category</th><th>Unit / shared</th><th>Paid by</th><th class="n">Amount</th><th>Payment</th></tr></thead><tbody>
        ${rows.map(e => html`<tr><td class="small">${fmtDate(e.incurred_on)}</td><td>${e.supplier}<div class="muted small">${e.description}</div></td><td>${e.category}</td><td>${e.unit || 'Shared'}</td><td class="small">${PAID_BY[e.paid_by] || '—'}</td><td class="n">${fm(e.amount_minor)}</td><td>${e.pay_status}</td></tr>`)}
        <tr class="total"><td>Total</td><td></td><td></td><td></td><td></td><td class="n">${fm(rows.reduce((s, e) => s + Number(e.amount_minor), 0))}</td><td></td></tr></tbody></table></div>
        <h3 class="h3">By category</h3><table class="kv"><tbody>${Object.entries(cats).map(([k, v]) => html`<tr><th>${k}</th><td>${fm(v)}</td></tr>`)}</tbody></table></section>`;
    } else if (kind === 'fees' && a.finance && ctx.feeLedger) {
      const L = await ctx.feeLedger(id);
      body = html`<section class="panel"><h2 class="h">SarayDar fee collection</h2><dl class="stats inline"><div><dt>Invoiced</dt><dd>${fm(L.t.invoiced)}</dd></div><div><dt>Collected</dt><dd>${fm(L.t.collected)}</dd></div><div><dt>Outstanding</dt><dd>${fm(L.t.outstanding)}</dd></div><div><dt>Overdue</dt><dd>${fm(L.t.overdueAmount)}</dd></div></dl>
        <div class="table-wrap"><table><thead><tr><th>Invoice</th><th>Period</th><th>Due</th><th class="n">Total</th><th class="n">Outstanding</th></tr></thead><tbody>${L.invoices.filter(i => i.status === 'issued').map(i => html`<tr><td><a href="/w/${id}/fees/invoices/${i.id}">${i.number}</a></td><td class="small">${i.period_start ? `${fmtDate(i.period_start)} – ${fmtDate(i.period_end)}` : 'Additional'}</td><td class="small">${fmtDate(i.due_date)}</td><td class="n">${fm(i.total)}</td><td class="n">${fm(i.outstanding)}</td></tr>`)}</tbody></table></div></section>`;
    }
    res.send(page(req, a, 'Reports', html`
      <div class="actions">${tabsR.map(([k, l]) => html`<a class="btn small ${k === kind ? 'primary' : ''}" href="?report=${k}&preset=${per.preset}&from=${per.from}&to=${per.to}">${l}</a>`)}</div>
      ${['occupancy', 'maintenance', 'expenses', 'expiry'].includes(kind) ? periodForm(per, html`<input type="hidden" name="report" value="${kind}">`) : ''}
      ${body}
      <p class="muted small">Use PDF or Excel above to export this report. For one unit or a whole building over any period, use <a href="/w/${id}/history">Unit History</a>.</p>`));
  });

  // ---------- dashboard & portfolio ----------
  async function snapshot(wsId) {
    const today = todayBH(), m0 = today.slice(0, 8) + '01';
    const mEnd = `${today.slice(0, 8)}${String(new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)).getUTCDate()).padStart(2, '0')}`;
    const units = (await pool.query('select status, count(*)::int as n from units where workspace_id = $1 and archived_at is null group by status', [wsId])).rows;
    const n = k => (units.find(u => u.status === k) || { n: 0 }).n;
    const total = units.reduce((s, u) => s + u.n, 0);
    const denom = total - n('unavailable');
    const due = Number((await pool.query("select coalesce(sum(amount_minor),0) as s from rent_charges where workspace_id = $1 and status = 'open' and due_date between $2 and $3", [wsId, m0, mEnd])).rows[0].s);
    const collected = Number((await pool.query("select coalesce(sum(amount_minor),0) as s from tenant_payments where workspace_id = $1 and status = 'confirmed' and received_on between $2 and $3", [wsId, m0, today])).rows[0].s);
    const arrears = (await billing.chargeState(pool, "c.workspace_id = $1 and c.status = 'open' and c.due_date < $2", [wsId, today])).reduce((s, c) => s + c.outstanding, 0);
    const expiring = (await pool.query("select count(*)::int as n from leases where workspace_id = $1 and status = 'active' and coalesce(terminated_on, end_date) between $2 and $3", [wsId, today, addDays(today, 60)])).rows[0].n;
    const maint = (await pool.query("select count(*)::int as n, count(*) filter (where priority = 'emergency')::int as em from maint_requests where workspace_id = $1 and status not in ('verified','closed','cancelled','rejected')", [wsId])).rows[0];
    const svc = (await pool.query("select count(*)::int as n from service_tasks where workspace_id = $1 and status = 'scheduled' and scheduled_on < $2", [wsId, today])).rows[0].n;
    const fees = ctx.feeLedger ? (await ctx.feeLedger(wsId)).t : null;
    const pending = Number((await pool.query("select coalesce(sum(amount_minor),0) as s from tenant_payments where workspace_id = $1 and status = 'reported'", [wsId])).rows[0].s);
    return { total, occupied: n('occupied'), vacant: n('available') + n('reserved'), maintenance: n('maintenance'), unavailable: n('unavailable'), denom, occPct: denom ? Math.round(n('occupied') / denom * 1000) / 10 : null,
      due, collected, arrears, expiring, maint, svc, fees, pending, m0, today };
  }

  ctx.propsDashboard = async (req, a) => {
    const s = await snapshot(a.ws.id);
    const p = await PR.profileOf(a.ws.id);
    const owner = a.ws.party_id ? (await pool.query('select id, name from parties where id = $1', [a.ws.party_id])).rows[0] : null;
    const id = a.ws.id;
    return html`${p._missing ? html`<div class="notice warn">Start with <a href="/w/${id}/property">Property Setup</a>: record who collects rent, holds deposits and pays suppliers, then add <a href="/w/${id}/units">units</a> and <a href="/w/${id}/leases">leases</a>.</div>` : ''}
      <section class="client-banner"><div><div class="muted small">Owner</div><div class="client-name">${owner ? html`<a href="/clients/${owner.id}">${owner.name}</a>` : html`<a href="/w/${id}/client">Link the owner</a>`}</div></div>
        <div><div class="muted small">Units</div><div class="mid"><a href="/w/${id}/units">${s.total}</a></div></div>
        <div><div class="muted small">Rent collected by</div><div class="mid">${{ saraydar: 'SarayDar', owner: 'Owner', other: 'Other' }[p.rent_collector]}</div></div></section>
      <section class="grid-cards" aria-label="Property figures">
        <div class="card"><div class="muted small">Occupancy today</div><div class="big">${s.occPct === null ? '—' : `${s.occPct}%`}</div><div class="muted small">${s.occupied} occupied ÷ ${s.denom} units (excludes ${s.unavailable} unavailable; includes ${s.maintenance} under maintenance) · ${s.vacant} vacant</div></div>
        ${a.finance ? html`<div class="card"><div class="muted small">Rent this month: due / collected</div><div class="mid">${fm(s.due)} / ${fm(s.collected)}</div><div class="muted small">Due = charges due ${fmtDate(s.m0)}–month end · collected = confirmed payments to date${s.pending ? ` · ${fm(s.pending)} reported, unconfirmed` : ''}</div></div>
        <div class="card"><div class="muted small">Arrears</div><div class="big ${s.arrears ? 'err' : ''}">${fm(s.arrears)}</div><div class="muted small"><a href="/w/${id}/reports?report=arrears">Aged arrears</a></div></div>` : ''}
        <div class="card"><div class="muted small">Leases ending in 60 days</div><div class="big">${s.expiring}</div><div class="muted small"><a href="/w/${id}/reports?report=expiry">Expiry list</a></div></div>
        <div class="card"><div class="muted small">Open maintenance</div><div class="big">${s.maint.n}</div><div class="muted small">${s.maint.em ? html`<span class="err">${s.maint.em} emergency</span> · ` : ''}<a href="/w/${id}/maintenance">Requests</a></div></div>
        <div class="card"><div class="muted small">Overdue service tasks</div><div class="big ${s.svc ? 'err' : ''}">${s.svc}</div><div class="muted small"><a href="/w/${id}/services">Cleaning &amp; services</a></div></div>
        ${a.finance && s.fees ? html`<div class="card"><div class="muted small">Unpaid SarayDar fees</div><div class="big">${fm(s.fees.outstanding)}</div><div class="muted small">${s.fees.overdue.length ? html`<span class="err">${s.fees.overdue.length} overdue</span> · ` : ''}<a href="/w/${id}/fees">Fee Billing</a></div></div>` : ''}
      </section>`;
  };

  ctx.portfolioCols = ctx.portfolioCols || {};
  ctx.portfolioCols.props = [['Units', 'units'], ['Occupancy', 'occ'], ['Rent this month (due / collected)', 'rent'], ['Open maintenance', 'maint'], ['Unpaid fees', 'fees']];
  ctx.propsPortfolioRow = async (wsId, user) => {
    const s = await snapshot(wsId);
    const fin = core.isSuper(user) || await core.can(user, 'view:financials') || ((await core.workspaceAccess(user, wsId)) || {}).role === 'manager';
    return { units: String(s.total), occ: s.occPct === null ? '—' : `${s.occPct}% (${s.occupied}/${s.denom})`, rent: fin ? `${fm(s.due)} / ${fm(s.collected)}` : '—', maint: String(s.maint.n), fees: fin && s.fees ? fm(s.fees.outstanding) : '—' };
  };

  return { ownerAccount, unitReport, arrearsAsOf, periodOf };
}

module.exports = { mountOwner, periodOf, periodForm };
