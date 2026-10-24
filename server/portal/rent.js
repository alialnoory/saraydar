'use strict';
// Rent & collections for managed properties: billing settings per lease, invoices from the rent ledger
// (manual or automatic), delivery tracking, tenant payments (reported → confirmed / bounced), allocations,
// receipts, credit notes, tenant statements and the separate deposit ledger.
// Sending or viewing an invoice never marks it paid; only a confirmed, allocated payment reduces the balance.
const crypto = require('crypto');
const { html, raw, pill, csrfField, field, emptyState, fmtDate, fmtDateTime } = require('./views');
const { parseMoney, formatMoney, toInput } = require('../lib/money');
const rentLib = require('../lib/rent');
const billing = require('../lib/billing');
const docs = require('../lib/fee-docs');
const { addDays } = require('../lib/fees');

const UUID = /^[0-9a-f-]{36}$/i;
const bad = m => Object.assign(new Error(m), { status: 400 });
const txt = (v, n = 300) => { const s = String(v ?? '').trim().slice(0, n); return s || null; };
const dateOrNull = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : null;
const todayBH = billing.todayBH;
const bhDay = ts => ts ? new Date(ts).toLocaleDateString('en-CA', { timeZone: 'Asia/Bahrain' }) : null;
const fm = (m, c = 'BHD') => m === null || m === undefined ? '—' : formatMoney(Number(m), c);
const METHODS = ['Bank transfer', 'Cheque', 'Cash', 'Card', 'BenefitPay', 'Other'];
const DELIVERY = { sent: ['Emailed', 'ok'], queued: ['Queued', 'warn'], unconfigured: ['Email not configured', 'muted'], failed: ['Delivery failed', 'bad'] };
const PAY_TONE = { reported: 'warn', confirmed: 'ok', bounced: 'bad', reversed: 'muted' };
const PAY_LABEL = { reported: 'Reported — not confirmed', confirmed: 'Confirmed', bounced: 'Bounced / not received', reversed: 'Reversed' };

function mountRent(r, ctx) {
  const { pool, core, mailer, NotFound } = ctx;
  const PR = ctx.PR;
  const page = (req, a, tab, body, crumb) => PR.page(req, a, tab, body, crumb);

  // ---------- tenant account helpers ----------
  async function leaseAccount(leaseId, db = pool) {
    const charges = await billing.chargeState(db, 'c.lease_id = $1', [leaseId]);
    const payments = (await db.query(`select p.*, coalesce((select sum(amount_minor) from tenant_allocations a where a.payment_id = p.id and a.status = 'active'),0)::bigint as allocated
      from tenant_payments p where p.lease_id = $1 order by p.received_on desc, p.recorded_at desc`, [leaseId])).rows
      .map(p => ({ ...p, amount: Number(p.amount_minor), allocated: Number(p.allocated), unapplied: p.status === 'confirmed' ? Number(p.amount_minor) - Number(p.allocated) : 0 }));
    const today = todayBH();
    const open = charges.filter(c => c.outstanding > 0);
    return { charges, payments, open, outstanding: open.reduce((s, c) => s + c.outstanding, 0), overdue: open.filter(c => String(c.due_date) < today).reduce((s, c) => s + c.outstanding, 0),
      pending: payments.filter(p => p.status === 'reported').reduce((s, p) => s + p.amount, 0), unapplied: payments.reduce((s, p) => s + p.unapplied, 0) };
  }
  async function depositBalance(leaseId, db = pool) {
    const rows = (await db.query('select * from deposit_txns where lease_id = $1 order by on_date, created_at', [leaseId])).rows;
    const bal = rows.reduce((s, t) => s + (t.kind === 'received' ? 1 : -1) * Number(t.amount_minor), 0);
    return { rows, balance: bal };
  }
  ctx.leaseAccount = leaseAccount; ctx.depositBalance = depositBalance;

  // ---------- lease page: billing, periods, account, payments, deposit ----------
  ctx.rentLeasePanel = async (req, a, l) => {
    const id = a.ws.id;
    const acc = await leaseAccount(l.id);
    const dep = await depositBalance(l.id);
    const invoices = (await pool.query('select * from rent_invoices where lease_id = $1 order by period_start', [l.id])).rows;
    const del = await billing.deliveryStatus(pool, invoices.map(i => i.id));
    const byPeriod = Object.fromEntries(invoices.filter(i => i.status !== 'void').map(i => [String(i.period_start), i]));
    const periods = ['active', 'ended', 'terminated'].includes(l.status) ? rentLib.periods(l) : [];
    const today = todayBH();
    const showPeriods = periods.filter(p => byPeriod[p.start] || p.start <= addDays(today, 62));
    const edit = core.canEdit(a);
    const idem = crypto.randomBytes(12).toString('hex');
    return html`
      <section class="panel"><h2 class="h">Rent schedule and invoices</h2>
        <div class="table-wrap"><table><thead><tr><th>Period</th><th class="n">Rent + charges</th><th>Due</th><th>Invoice</th><th>Delivery</th><th></th></tr></thead><tbody>
          ${showPeriods.map(p => { const inv = byPeriod[p.start]; const amt = rentLib.rentFor(l, l.steps, p).total + l.charges.filter(c => c.active).reduce((s, c) => s + rentLib.chargeFor(l, Number(c.amount_minor), p), 0);
            const d = inv && del[inv.id];
            return html`<tr><td class="small">${fmtDate(p.start)} – ${fmtDate(p.end)}</td><td class="n">${fm(inv ? inv.total_minor : amt)}${inv ? '' : html`<div class="muted small">preview</div>`}</td><td class="small">${fmtDate(rentLib.dueDate(l, p))}</td>
              <td>${inv ? html`<a href="/w/${id}/rent/invoices/${inv.id}">${inv.number}</a>` : html`<span class="muted">Not issued</span>`}</td>
              <td class="small">${inv ? (d ? pill(DELIVERY[d.status][0], DELIVERY[d.status][1]) : l.delivery === 'none' ? 'Not sent (by choice)' : html`<span class="muted">Not sent</span>`) : (l.auto_invoice && l.auto_from && p.start >= String(l.auto_from) ? html`<span class="muted">Automatic on ${fmtDate(rentLib.issueDate(l, p))}</span>` : '')}</td>
              <td>${!inv && ['active', 'ended', 'terminated'].includes(l.status) && edit ? html`<form method="post" action="/w/${id}/leases/${l.id}/invoice" class="actions">${csrfField(req)}<input type="hidden" name="period_start" value="${p.start}"><button class="btn small" type="submit">Issue now</button></form>` : ''}</td></tr>`; })}
          ${!showPeriods.length ? html`<tr><td colspan="6" class="muted">${l.status === 'draft' ? 'Activate the lease to start its rent schedule.' : 'No periods.'}</td></tr>` : ''}
        </tbody></table></div>
        <h3 class="h3">Automatic monthly invoicing</h3>
        ${l.auto_invoice ? html`<p>${pill('On', 'ok')} from the period starting ${fmtDate(l.auto_from)} · issued ${l.invoice_days_before ? `${l.invoice_days_before} day(s) before each period` : 'on the first day of each period'} · ${l.delivery === 'email' ? `emailed to ${l.tenant.email || html`<span class="err">no email on file</span>`}` : 'not emailed'} · reminders ${l.reminder_days.length ? l.reminder_days.map(d => `${d}`).join(', ') + ' day(s) after the due date' : 'off'}<br><span class="muted small">Enabled by an authorised user on ${fmtDateTime(l.auto_enabled_at)}.</span></p>`
          : html`<p class="muted">Off. Invoices are issued with “Issue now”.</p>`}
        ${a.canPost && l.status === 'active' ? html`<details class="inline-form"><summary>${l.auto_invoice ? 'Change or turn off' : 'Turn on automatic invoicing'}</summary><form method="post" action="/w/${id}/leases/${l.id}/billing" class="form-grid">${csrfField(req)}
          ${field({ name: 'auto_invoice', label: 'Automatic invoicing', value: l.auto_invoice ? '1' : '0', options: [['1', 'On'], ['0', 'Off']] })}
          ${field({ name: 'auto_from', label: 'First period to invoice automatically', value: l.auto_from ? String(l.auto_from) : '', options: [['', 'Choose…'], ...periods.filter(p => !byPeriod[p.start] && p.end >= today).map(p => [p.start, `${fmtDate(p.start)} – ${fmtDate(p.end)}`])] })}
          ${field({ name: 'invoice_days_before', label: 'Issue (days before the period starts)', type: 'number', value: l.invoice_days_before, attrs: 'min="0" max="31"' })}
          ${field({ name: 'delivery', label: 'Delivery', value: l.delivery, options: [['email', 'Email the PDF to the tenant'], ['none', 'Do not send (keep in the system)']] })}
          ${field({ name: 'reminder_days', label: 'Reminders (days after due, comma-separated)', value: l.reminder_days.join(', ') })}
          <div class="actions full"><button class="btn primary" type="submit">Save</button></div>
          <p class="muted small full">The background job runs every hour (Bahrain time). Each period is invoiced once; retries and resends reuse the same invoice. Without email settings, invoices are still created and show “Email not configured”.</p></form></details>` : ''}
      </section>
      <div class="split">
        <section class="panel grow2"><div class="row-between"><h2 class="h">Tenant account</h2><a class="btn small" href="/w/${id}/leases/${l.id}/statement">Tenant statement</a></div>
          <dl class="stats inline"><div><dt>Outstanding</dt><dd>${fm(acc.outstanding)}</dd></div><div><dt>Overdue</dt><dd class="${acc.overdue ? 'err' : ''}">${fm(acc.overdue)}</dd></div><div><dt>Reported, not confirmed</dt><dd>${fm(acc.pending)}</dd></div><div><dt>Unapplied credit</dt><dd>${fm(acc.unapplied)}</dd></div></dl>
          ${acc.payments.length ? html`<div class="table-wrap"><table><thead><tr><th>Received</th><th>Method</th><th class="n">Amount</th><th>Status</th><th>Receipt</th></tr></thead><tbody>
            ${acc.payments.map(p => html`<tr><td><a href="/w/${id}/rent/payments/${p.id}">${fmtDate(p.received_on)}</a></td><td class="small">${p.method}${p.reference ? ` · ${p.reference}` : ''}<div class="muted">to ${p.received_by === 'saraydar' ? 'SarayDar' : p.received_by === 'owner' ? 'the owner' : 'another party'}</div></td><td class="n">${fm(p.amount)}</td><td>${pill(PAY_LABEL[p.status], PAY_TONE[p.status])}</td><td class="small">${p.receipt_no || '—'}</td></tr>`)}</tbody></table></div>` : html`<p class="muted">No payments recorded.</p>`}
          ${edit ? html`<details class="inline-form"><summary>Record a payment from the tenant</summary><form method="post" action="/w/${id}/leases/${l.id}/payments" class="form-grid">${csrfField(req)}<input type="hidden" name="idem" value="${idem}">
            ${field({ name: 'received_on', label: 'Received / cheque received on', type: 'date', required: true, value: today })}${field({ name: 'amount', label: 'Amount (BHD)', required: true })}
            ${field({ name: 'method', label: 'Method', options: METHODS.map(m => [m, m]) })}${field({ name: 'reference', label: 'Bank reference / cheque number' })}
            ${field({ name: 'cheque_date', label: 'Cheque date (post-dated cheques)', type: 'date' })}
            ${field({ name: 'received_by', label: 'Money received by', value: 'saraydar', options: [['saraydar', 'SarayDar'], ['owner', 'The owner directly'], ['other', 'Another party']] })}
            ${field({ name: 'notes', label: 'Notes', full: true })}
            ${a.canPost ? html`<label class="field check full"><input type="checkbox" name="confirm" value="1"> <span>Confirmed in the bank / cash counted now (not for uncleared cheques)</span></label>` : ''}
            <div class="actions full"><button class="btn primary" type="submit">Record payment</button></div>
            <p class="muted small full">A payment stays “reported” until Finance confirms it (for cheques: after clearance). Only confirmed payments reduce the tenant's balance.</p></form></details>` : ''}
        </section>
        <section class="panel grow1"><div class="row-between"><h2 class="h">Deposit</h2><a class="small" href="/w/${id}/deposits">All deposits</a></div>
          <p>Agreed ${fm(l.deposit_minor)} · held now <b>${fm(dep.balance)}</b></p>
          ${dep.rows.length ? html`<ul class="rows">${dep.rows.map(t => html`<li><div class="grow">${{ received: 'Received', deduction: 'Deduction', refund: 'Refund' }[t.kind]} · ${fmtDate(t.on_date)}<div class="muted small">${t.reason || ''}${t.approval_ref ? ` · approval ${t.approval_ref}` : ''} · held by ${t.holder}</div></div><b>${t.kind === 'received' ? '' : '−'}${fm(t.amount_minor)}</b></li>`)}</ul>` : ''}
          ${edit ? html`<details class="inline-form"><summary>Record deposit movement</summary><form method="post" action="/w/${id}/leases/${l.id}/deposits" class="form-grid">${csrfField(req)}
            ${field({ name: 'kind', label: 'Movement', options: [['received', 'Deposit received'], ...(a.canPost ? [['deduction', 'Approved deduction (released to the owner)'], ['refund', 'Refund to tenant']] : [])] })}
            ${field({ name: 'on_date', label: 'Date', type: 'date', required: true, value: today })}${field({ name: 'amount', label: 'Amount (BHD)', required: true })}
            ${field({ name: 'holder', label: 'Held by', value: 'saraydar', options: [['saraydar', 'SarayDar'], ['owner', 'The owner'], ['other', 'Another party']] })}
            ${field({ name: 'reason', label: 'Reason (required for deductions)' })}${field({ name: 'approval_ref', label: 'Approval reference (deductions)' })}${field({ name: 'reference', label: 'Payment reference' })}
            <div class="actions full"><button class="btn" type="submit">Save</button></div><p class="muted small full">Deposits are kept apart from rent and owner funds. A deduction needs a reason and approval; only then does it count as money for the owner.</p></form></details>` : ''}
        </section></div>`;
  };

  r.post('/w/:id/leases/:lid/billing', async (req, res) => {
    const a = await PR.access(req, 'post');
    const l = await PR.own('leases', req.params.lid, a.ws.id);
    if (l.status !== 'active') throw bad('Only an active lease can be billed automatically.');
    const on = req.body.auto_invoice === '1';
    const from = dateOrNull(req.body.auto_from);
    if (on && (!from || !rentLib.periods(l).some(p => p.start === from))) throw bad('Choose the first period to invoice automatically.');
    const days = Math.min(31, Math.max(0, parseInt(req.body.invoice_days_before, 10) || 0));
    const rem = String(req.body.reminder_days || '').split(/[,\s]+/).filter(Boolean).map(Number);
    if (rem.some(x => !Number.isInteger(x) || x < 0 || x > 120) || rem.length > 5) throw bad('Reminders: up to five whole numbers of days, for example 3, 10.');
    const t = (await pool.query('select email from parties where id = $1', [l.tenant_id])).rows[0];
    if (on && req.body.delivery !== 'none' && !(t && t.email)) throw bad('The tenant has no email address. Add it to the tenant record, or choose not to send.');
    await core.inTx(async db => {
      await db.query(`update leases set auto_invoice = $2, auto_from = $3, invoice_days_before = $4, delivery = $5, reminder_days = $6, auto_enabled_by = case when $2 then $7::uuid else auto_enabled_by end,
        auto_enabled_at = case when $2 then now() else auto_enabled_at end, updated_at = now() where id = $1`, [l.id, on, on ? from : l.auto_from, days, req.body.delivery === 'none' ? 'none' : 'email', [...new Set(rem)].sort((x, y) => x - y), req.user.id]);
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: on ? 'billing.enabled' : 'billing.disabled', entity: 'lease', entityId: l.id, summary: on ? `Automatic invoicing on for ${l.ref} from ${from} (${days} day(s) before, ${req.body.delivery === 'none' ? 'not emailed' : 'email'})` : `Automatic invoicing off for ${l.ref}`, ip: req.ip });
    });
    res.redirect(`/w/${a.ws.id}/leases/${l.id}?msg=saved`);
  });

  r.post('/w/:id/leases/:lid/invoice', async (req, res) => {
    const a = await PR.access(req, 'edit');
    if (!a.finance) throw new NotFound();
    const l = await PR.own('leases', req.params.lid, a.ws.id);
    const p = rentLib.periods(l).find(x => x.start === req.body.period_start);
    if (!p) throw bad('Choose a period of this lease.');
    const out = await core.inTx(db => billing.ensurePeriod(db, { leaseId: l.id, period: p, origin: 'manual', actorId: req.user.id, actorLabel: req.user.name || req.user.email }));
    if (out.created && l.delivery === 'email') await billing.deliverInvoice(pool, mailer, out.invoice.id);
    res.redirect(`/w/${a.ws.id}/rent/invoices/${out.invoice.id}?msg=${out.created ? 'created' : 'saved'}`);
  });

  // ---------- Rent & Collections ----------
  r.get('/w/:id/rent', async (req, res) => {
    const a = await PR.access(req, 'finance');
    const id = a.ws.id, today = todayBH();
    const status = ['open', 'all', 'overdue', 'void'].includes(req.query.status) ? req.query.status : 'open';
    const invs = (await pool.query(`select i.*, l.ref as lease_ref, u.ref as unit_ref, t.name as tenant_name from rent_invoices i join leases l on l.id = i.lease_id join units u on u.id = l.unit_id join parties t on t.id = l.tenant_id
      where i.workspace_id = $1 order by i.period_start desc, u.sort limit ${req.exportAll ? 5000 : 400}`, [id])).rows;
    const ch = await billing.chargeState(pool, 'c.workspace_id = $1', [id]);
    const outBy = {}; for (const c of ch) if (c.invoice_id) outBy[c.invoice_id] = (outBy[c.invoice_id] || 0) + c.outstanding;
    const del = await billing.deliveryStatus(pool, invs.map(i => i.id));
    const list = invs.filter(i => status === 'all' ? true : status === 'void' ? i.status === 'void' : i.status === 'issued' && (outBy[i.id] || 0) > 0 && (status !== 'overdue' || String(i.due_date) < today));
    const pays = (await pool.query(`select p.*, l.ref as lease_ref, u.ref as unit_ref, t.name as tenant_name from tenant_payments p join leases l on l.id = p.lease_id join units u on u.id = l.unit_id join parties t on t.id = l.tenant_id
      where p.workspace_id = $1 order by (p.status = 'reported') desc, p.received_on desc limit 200`, [id])).rows;
    const monthStart = today.slice(0, 8) + '01';
    const dueMonth = ch.filter(c => c.status === 'open' && String(c.due_date) >= monthStart && String(c.due_date) <= today.slice(0, 8) + '31').reduce((s, c) => s + c.amount - c.credited, 0);
    const collected = pays.filter(p => p.status === 'confirmed' && String(p.received_on) >= monthStart).reduce((s, p) => s + Number(p.amount_minor), 0);
    const overdue = ch.filter(c => c.outstanding > 0 && String(c.due_date) < today).reduce((s, c) => s + c.outstanding, 0);
    const lastRun = (await pool.query("select * from job_runs where job = 'rent_billing' order by id desc limit 1")).rows[0];
    const q = s => `?status=${s}`;
    res.send(page(req, a, 'Rent & Collections', html`
      <section class="grid-cards" aria-label="Collections">
        <div class="card"><div class="muted small">Rent and charges due this month</div><div class="big">${fm(dueMonth)}</div><div class="muted small">Charges with a due date this month, after credits</div></div>
        <div class="card"><div class="muted small">Collected this month</div><div class="big">${fm(collected)}</div><div class="muted small">Confirmed payments received since ${fmtDate(monthStart)}</div></div>
        <div class="card"><div class="muted small">Arrears (overdue)</div><div class="big ${overdue ? 'err' : ''}">${fm(overdue)}</div><div class="muted small">Unpaid charges past their due date</div></div>
        <div class="card"><div class="muted small">Automatic invoicing</div><div class="mid">${lastRun ? html`${pill(lastRun.status, lastRun.status === 'ok' ? 'ok' : lastRun.status === 'skipped' ? 'muted' : 'bad')} ${fmtDateTime(lastRun.finished_at || lastRun.started_at)}` : 'Not run yet'}</div><div class="muted small">${lastRun ? lastRun.summary || lastRun.error || '' : 'Runs every hour once leases are switched on.'}</div>
          ${a.canPost ? html`<form method="post" action="/w/${id}/rent/run" class="actions">${csrfField(req)}<button class="btn small" type="submit">Run now</button></form>` : ''}</div>
      </section>
      ${!mailer.configured ? html`<div class="notice warn">Email is not configured, so invoices are created and kept here but not emailed. Their delivery shows “Email not configured” until Outlook email is set up (see the setup guide for the technical team).</div>` : ''}
      <section class="panel"><div class="row-between"><h2 class="h">Rent invoices</h2><div class="actions">${[['open', 'Unpaid'], ['overdue', 'Overdue'], ['all', 'All'], ['void', 'Void']].map(([k, l]) => html`<a class="btn small ${k === status ? 'primary' : ''}" href="${q(k)}">${l}</a>`)}</div></div>
        ${list.length ? html`<div class="table-wrap"><table><thead><tr><th>Invoice</th><th>Unit / tenant</th><th>Period</th><th>Due</th><th class="n">Total</th><th class="n">Outstanding</th><th>Delivery</th></tr></thead><tbody>
          ${list.map(i => { const d = del[i.id]; const od = i.status === 'issued' && (outBy[i.id] || 0) > 0 && String(i.due_date) < today; return html`<tr><td class="nowrap"><a href="/w/${id}/rent/invoices/${i.id}"><b>${i.number}</b></a>${i.origin === 'scheduler' ? html`<div class="muted small">automatic</div>` : ''}</td>
            <td>${i.unit_ref}<div class="muted small">${i.tenant_name}</div></td><td class="small">${fmtDate(i.period_start)} – ${fmtDate(i.period_end)}</td><td class="small ${od ? 'err' : ''}">${fmtDate(i.due_date)}</td>
            <td class="n">${fm(i.total_minor)}</td><td class="n">${i.status === 'void' ? pill('Void', 'muted') : fm(outBy[i.id] || 0)}</td><td class="small">${d ? pill(DELIVERY[d.status][0], DELIVERY[d.status][1]) : '—'}</td></tr>`; })}</tbody></table></div>` : html`<p class="muted">Nothing to show.</p>`}
      </section>
      <section class="panel"><h2 class="h">Tenant payments</h2>
        ${pays.length ? html`<div class="table-wrap"><table><thead><tr><th>Received</th><th>Unit / tenant</th><th>Method</th><th class="n">Amount</th><th>Status</th><th>Receipt</th></tr></thead><tbody>
          ${pays.map(p => html`<tr><td><a href="/w/${id}/rent/payments/${p.id}">${fmtDate(p.received_on)}</a></td><td>${p.unit_ref}<div class="muted small">${p.tenant_name}</div></td><td class="small">${p.method}${p.reference ? ` · ${p.reference}` : ''}</td><td class="n">${fm(p.amount_minor)}</td><td>${pill(PAY_LABEL[p.status], PAY_TONE[p.status])}</td><td class="small">${p.receipt_no || '—'}</td></tr>`)}</tbody></table></div>`
          : html`<p class="muted">No payments yet. Record them from the lease.</p>`}
      </section>`));
  });

  r.post('/w/:id/rent/run', async (req, res) => {
    const a = await PR.access(req, 'post');
    await billing.runBilling(pool, mailer, {});
    await billing.generateServiceTasks(pool, {});
    await core.audit(null, { actor: req.user, workspaceId: a.ws.id, action: 'billing.run_manual', entity: 'job', entityId: 'rent_billing', summary: 'Automatic invoicing run started by hand', ip: req.ip });
    res.redirect(`/w/${a.ws.id}/rent?msg=saved`);
  });

  // ---------- one invoice ----------
  async function invoiceOf(a, iid) {
    if (!UUID.test(iid)) throw new NotFound();
    const d = await billing.invoiceData(pool, iid);
    if (!d || d.inv.workspace_id !== a.ws.id) throw new NotFound();
    return d;
  }
  r.get('/w/:id/rent/invoices/:iid', async (req, res) => {
    const a = await PR.access(req, 'finance');
    const d = await invoiceOf(a, req.params.iid);
    const { inv, lease, unit, tenant, charges } = d;
    const sends = (await pool.query("select * from outbox_messages where ref_kind = 'rent_invoice' and ref_id = $1 order by id desc", [inv.id])).rows;
    const credits = (await pool.query('select * from rent_credits where charge_id = any($1::uuid[]) order by on_date', [charges.map(c => c.id)])).rows;
    const out = charges.reduce((s, c) => s + c.outstanding, 0);
    const id = a.ws.id;
    res.send(page(req, a, 'Rent & Collections', html`<p><a href="/w/${id}/rent">‹ Rent &amp; Collections</a> · <a href="/w/${id}/leases/${lease.id}">Lease ${lease.ref}</a></p>
      <section class="panel"><div class="row-between"><h2 class="h">Rent invoice ${inv.number} ${inv.status === 'void' ? pill('Void', 'muted') : out === 0 ? pill('Paid', 'ok') : String(inv.due_date) < todayBH() ? pill('Overdue', 'bad') : pill('Unpaid', 'warn')}</h2>
        <a class="btn small" href="/w/${id}/rent/invoices/${inv.id}/invoice.pdf">Download PDF</a></div>
        <dl class="details"><div><dt>Tenant</dt><dd>${tenant.name}<div class="muted small">${tenant.email || 'no email'}</div></dd></div><div><dt>Unit</dt><dd>${unit.ref}</dd></div>
          <div><dt>Period</dt><dd>${fmtDate(inv.period_start)} – ${fmtDate(inv.period_end)}</dd></div><div><dt>Issued / due</dt><dd>${fmtDate(inv.issue_date)} / ${fmtDate(inv.due_date)}</dd></div>
          <div><dt>Created</dt><dd>${inv.origin === 'scheduler' ? 'Automatically by the billing job' : 'By staff'} · ${fmtDateTime(inv.created_at)}</dd></div>${inv.void_reason ? html`<div><dt>Voided</dt><dd>${inv.void_reason}</dd></div>` : ''}</dl>
        <div class="table-wrap"><table><thead><tr><th>Charge</th><th class="n">Amount</th><th class="n">Credited</th><th class="n">Paid</th><th class="n">Outstanding</th><th></th></tr></thead><tbody>
          ${charges.map(c => html`<tr><td>${c.description}</td><td class="n">${fm(c.amount)}</td><td class="n">${c.credited ? fm(c.credited) : '—'}</td><td class="n">${c.paid ? fm(c.paid) : '—'}</td><td class="n">${fm(c.outstanding)}</td>
            <td>${a.canPost && c.outstanding > 0 ? html`<details class="inline-form"><summary class="small">Credit</summary><form method="post" action="/w/${id}/rent/charges/${c.id}/credit" class="form-grid">${csrfField(req)}
              ${field({ name: 'amount', label: `Amount (up to ${fm(c.outstanding)})`, required: true })}${field({ name: 'reason', label: 'Reason / approval', required: true })}<div class="actions full"><button class="btn small" type="submit">Issue credit note</button></div></form></details>` : ''}</td></tr>`)}
          <tr class="total"><td>Total</td><td class="n">${fm(inv.total_minor)}</td><td></td><td></td><td class="n">${fm(out)}</td><td></td></tr></tbody></table></div>
        ${credits.length ? html`<p class="small">Credit notes: ${credits.map(c => `${c.number} ${formatMoney(Number(c.amount_minor))} (${c.reason})`).join('; ')}</p>` : ''}
      </section>
      <section class="panel"><h2 class="h">Delivery</h2>
        ${sends.length ? html`<ul class="rows">${sends.map(s => html`<li><div class="grow">${s.kind === 'rent_reminder' ? 'Reminder' : 'Invoice email'} to ${s.to_address}<div class="muted small">${fmtDateTime(s.created_at)}${s.error ? ` · ${s.error}` : ''}</div></div>${pill((DELIVERY[s.status] || [s.status])[0], (DELIVERY[s.status] || [0, 'muted'])[1])}</li>`)}</ul>` : html`<p class="muted">Not sent.</p>`}
        ${inv.status === 'issued' && core.canEdit(a) ? html`<form method="post" action="/w/${id}/rent/invoices/${inv.id}/send" class="actions">${csrfField(req)}<button class="btn" type="submit">${sends.length ? 'Resend the same invoice' : 'Email to tenant'}</button></form>` : ''}
        ${inv.status === 'issued' && a.canPost && charges.every(c => c.paid === 0 && c.credited === 0) ? html`<details class="inline-form"><summary>Void this invoice</summary><form method="post" action="/w/${id}/rent/invoices/${inv.id}/void" class="form-grid">${csrfField(req)}
          ${field({ name: 'reason', label: 'Reason', required: true, full: true })}<div class="actions full"><button class="btn" type="submit">Void invoice and its charges</button></div><p class="muted small full">The number is kept, marked void. The period can be invoiced again.</p></form></details>` : ''}
      </section>`, inv.number));
  });

  r.get('/w/:id/rent/invoices/:iid/invoice.pdf', async (req, res) => {
    const a = await PR.access(req, 'finance');
    await invoiceOf(a, req.params.iid);
    const { buf, data } = await billing.invoicePdf(pool, req.params.iid);
    await core.audit(null, { actor: req.user, workspaceId: a.ws.id, action: 'rent.invoice_pdf', entity: 'rent_invoice', entityId: data.inv.id, summary: `Rent invoice PDF downloaded: ${data.inv.number}`, ip: req.ip });
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${data.inv.number}.pdf"`, 'Cache-Control': 'private, no-store' }); res.end(buf);
  });

  r.post('/w/:id/rent/invoices/:iid/send', async (req, res) => {
    const a = await PR.access(req, 'edit');
    if (!a.finance) throw new NotFound();
    const d = await invoiceOf(a, req.params.iid);
    if (d.inv.status !== 'issued') throw bad('A void invoice cannot be sent.');
    const r2 = await billing.deliverInvoice(pool, mailer, d.inv.id);
    await core.audit(null, { actor: req.user, workspaceId: a.ws.id, action: 'rent.invoice_sent', entity: 'rent_invoice', entityId: d.inv.id, summary: `Rent invoice ${d.inv.number} emailed by hand: ${r2.status}`, ip: req.ip });
    res.redirect(`/w/${a.ws.id}/rent/invoices/${d.inv.id}?msg=saved`);
  });

  r.post('/w/:id/rent/invoices/:iid/void', async (req, res) => {
    const a = await PR.access(req, 'post');
    const d = await invoiceOf(a, req.params.iid);
    const reason = txt(req.body.reason, 300); if (!reason) throw bad('Give a reason.');
    await core.inTx(async db => {
      await db.query('select id from leases where id = $1 for update', [d.inv.lease_id]);
      const used = (await db.query("select count(*)::int as n from rent_charges c where c.invoice_id = $1 and (exists (select 1 from tenant_allocations a where a.charge_id = c.id and a.status = 'active') or exists (select 1 from rent_credits r where r.charge_id = c.id))", [d.inv.id])).rows[0].n;
      if (used) throw bad('This invoice has payments or credits. Reverse them first, or issue a credit note.');
      const n = (await db.query("update rent_invoices set status = 'void', void_reason = $2 where id = $1 and status = 'issued'", [d.inv.id, reason])).rowCount;
      if (!n) throw bad('Already void.');
      await db.query("update rent_charges set status = 'void', void_reason = $2 where invoice_id = $1", [d.inv.id, `Invoice ${d.inv.number} voided: ${reason}`]);
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'rent.invoice_voided', entity: 'rent_invoice', entityId: d.inv.id, summary: `Rent invoice ${d.inv.number} voided: ${reason}`, ip: req.ip });
    });
    res.redirect(`/w/${a.ws.id}/rent/invoices/${d.inv.id}?msg=saved`);
  });

  r.post('/w/:id/rent/charges/:cid/credit', async (req, res) => {
    const a = await PR.access(req, 'post');
    const c0 = await PR.own('rent_charges', req.params.cid, a.ws.id);
    const amt = parseMoney(req.body.amount, 'BHD'); if (!amt || amt <= 0) throw bad('Enter the amount.');
    const reason = txt(req.body.reason, 300); if (!reason) throw bad('Give a reason.');
    await core.inTx(async db => {
      await db.query('select id from rent_charges where id = $1 for update', [c0.id]);
      const c = (await billing.chargeState(db, 'c.id = $1', [c0.id]))[0];
      if (amt > c.outstanding) throw bad(`The credit is more than the outstanding ${formatMoney(c.outstanding)}.`);
      const on = todayBH();
      const number = `RCN-${on.slice(0, 4)}-${String(await core.nextNumber(db, `RCN-${on.slice(0, 4)}`)).padStart(4, '0')}`;
      await db.query('insert into rent_credits (workspace_id, charge_id, number, on_date, amount_minor, reason, created_by) values ($1,$2,$3,$4,$5,$6,$7)', [a.ws.id, c.id, number, on, amt, reason, req.user.id]);
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'rent.credit_note', entity: 'rent_charge', entityId: c.id, summary: `Rent credit note ${number}: ${formatMoney(amt)} on “${c.description}” — ${reason}`, ip: req.ip });
    });
    const inv = c0.invoice_id;
    res.redirect(inv ? `/w/${a.ws.id}/rent/invoices/${inv}?msg=saved` : `/w/${a.ws.id}/leases/${c0.lease_id}?msg=saved`);
  });

  // ---------- payments ----------
  async function allocateOldest(db, a, req, payId) {
    const p = (await db.query('select * from tenant_payments where id = $1 for update', [payId])).rows[0];
    if (p.status !== 'confirmed') return 0;
    await db.query('select id from leases where id = $1 for update', [p.lease_id]);
    let left = Number(p.amount_minor) - Number((await db.query("select coalesce(sum(amount_minor),0) as s from tenant_allocations where payment_id = $1 and status = 'active'", [p.id])).rows[0].s);
    let n = 0;
    for (const c of await billing.chargeState(db, "c.lease_id = $1 and c.status = 'open'", [p.lease_id])) {
      if (left <= 0) break;
      if (c.outstanding <= 0) continue;
      const amt = Math.min(left, c.outstanding);
      await db.query('insert into tenant_allocations (payment_id, charge_id, amount_minor, created_by) values ($1,$2,$3,$4)', [p.id, c.id, amt, req.user.id]);
      left -= amt; n += amt;
    }
    if (n) await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'rent.payment_allocated', entity: 'tenant_payment', entityId: p.id, summary: `${formatMoney(n)} allocated to the oldest open charges`, ip: req.ip });
    return n;
  }

  r.post('/w/:id/leases/:lid/payments', async (req, res) => {
    const a = await PR.access(req, 'edit');
    if (!a.finance) throw new NotFound();
    const l = await PR.own('leases', req.params.lid, a.ws.id);
    const received = dateOrNull(req.body.received_on); if (!received) throw bad('Enter the date received.');
    if (received > todayBH()) throw bad('The received date cannot be in the future.');
    const amount = parseMoney(req.body.amount, 'BHD'); if (!amount || amount <= 0) throw bad('Enter the amount.');
    const method = METHODS.includes(req.body.method) ? req.body.method : 'Other';
    const confirmNow = req.body.confirm === '1' && a.canPost && method !== 'Cheque';
    const idem = /^[0-9a-f]{24}$/.test(req.body.idem || '') ? req.body.idem : null;
    let pid;
    try {
      pid = await core.inTx(async db => {
        if (idem) { const ex = (await db.query('select id from tenant_payments where idem_key = $1', [idem])).rows[0]; if (ex) return ex.id; }
        const id = (await db.query(`insert into tenant_payments (workspace_id, lease_id, received_on, amount_minor, method, reference, cheque_date, received_by, status, notes, idem_key, recorded_by, confirmed_by, confirmed_at, cleared_on)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning id`,
          [a.ws.id, l.id, received, amount, method, txt(req.body.reference, 80), dateOrNull(req.body.cheque_date), ['saraydar', 'owner', 'other'].includes(req.body.received_by) ? req.body.received_by : 'saraydar',
            confirmNow ? 'confirmed' : 'reported', txt(req.body.notes, 300), idem, req.user.id, confirmNow ? req.user.id : null, confirmNow ? new Date() : null, confirmNow ? received : null])).rows[0].id;
        await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: confirmNow ? 'rent.payment_confirmed' : 'rent.payment_reported', entity: 'tenant_payment', entityId: id, summary: `Tenant payment ${confirmNow ? 'recorded and confirmed' : 'reported (awaiting confirmation)'}: ${formatMoney(amount)} for ${l.ref}`, ip: req.ip });
        if (confirmNow) await allocateOldest(db, a, req, id);
        await PR.touch(db, a.ws.id);
        return id;
      });
    } catch (e) { if (e.code === '23505') throw bad('A payment with that method and reference is already recorded for this property.'); throw e; }
    res.redirect(`/w/${a.ws.id}/rent/payments/${pid}?msg=saved`);
  });

  async function paymentOf(a, pid) {
    if (!UUID.test(pid)) throw new NotFound();
    const p = (await pool.query(`select p.*, l.ref as lease_ref, l.unit_id, t.name as tenant_name, u.ref as unit_ref, coalesce((select sum(amount_minor) from tenant_allocations x where x.payment_id = p.id and x.status = 'active'),0)::bigint as allocated
      from tenant_payments p join leases l on l.id = p.lease_id join parties t on t.id = l.tenant_id join units u on u.id = l.unit_id where p.id = $1 and p.workspace_id = $2`, [pid, a.ws.id])).rows[0];
    if (!p) throw new NotFound();
    p.allocs = (await pool.query('select x.*, c.description, c.due_date from tenant_allocations x join rent_charges c on c.id = x.charge_id where x.payment_id = $1 order by x.created_at', [p.id])).rows;
    p.unapplied = p.status === 'confirmed' ? Number(p.amount_minor) - Number(p.allocated) : 0;
    return p;
  }

  r.get('/w/:id/rent/payments/:pid', async (req, res) => {
    const a = await PR.access(req, 'finance');
    const p = await paymentOf(a, req.params.pid);
    const id = a.ws.id;
    res.send(page(req, a, 'Rent & Collections', html`<p><a href="/w/${id}/rent">‹ Rent &amp; Collections</a> · <a href="/w/${id}/leases/${p.lease_id}">Lease ${p.lease_ref}</a></p>
      <section class="panel"><div class="row-between"><h2 class="h">Tenant payment ${pill(PAY_LABEL[p.status], PAY_TONE[p.status])}</h2>${p.receipt_no ? html`<a class="btn small" href="/w/${id}/rent/payments/${p.id}/receipt.pdf">Receipt ${p.receipt_no}</a>` : ''}</div>
        <dl class="details"><div><dt>Tenant / unit</dt><dd>${p.tenant_name} · ${p.unit_ref}</dd></div><div><dt>Received</dt><dd>${fmtDate(p.received_on)} by ${p.received_by === 'saraydar' ? 'SarayDar' : p.received_by === 'owner' ? 'the owner' : 'another party'}</dd></div>
          <div><dt>Amount</dt><dd>${fm(p.amount_minor)}</dd></div><div><dt>Method</dt><dd>${p.method}${p.reference ? ` · ${p.reference}` : ''}${p.cheque_date ? ` · cheque dated ${fmtDate(p.cheque_date)}` : ''}</dd></div>
          <div><dt>Confirmed</dt><dd>${p.confirmed_at ? `${fmtDateTime(p.confirmed_at)}${p.cleared_on ? ` · cleared ${fmtDate(p.cleared_on)}` : ''}` : 'Not yet'}</dd></div>
          <div><dt>Allocated / unapplied</dt><dd>${fm(p.allocated)} / ${fm(p.unapplied)}</dd></div>${p.reverse_reason ? html`<div><dt>Reversed</dt><dd>${p.reverse_reason}</dd></div>` : ''}${p.notes ? html`<div><dt>Notes</dt><dd>${p.notes}</dd></div>` : ''}</dl>
        ${p.allocs.length ? html`<h3 class="h3">Applied to</h3><ul class="rows">${p.allocs.map(x => html`<li><div class="grow">${x.description}<div class="muted small">due ${fmtDate(x.due_date)}${x.status === 'reversed' ? ` · reversed: ${x.reverse_reason}` : ''}</div></div><b>${fm(x.amount_minor)}</b></li>`)}</ul>` : ''}
        ${a.canPost ? html`<div class="actions">
          ${p.status === 'reported' ? html`<form method="post" action="/w/${id}/rent/payments/${p.id}/confirm" class="actions">${csrfField(req)}<label class="small">Cleared / confirmed on <input type="date" name="cleared_on" value="${todayBH()}" required></label><button class="btn primary" type="submit">Confirm and allocate</button></form>
            <form method="post" action="/w/${id}/rent/payments/${p.id}/bounce" class="actions">${csrfField(req)}<input name="reason" placeholder="Reason" aria-label="Reason" required><button class="btn" type="submit">Not received / bounced</button></form>` : ''}
          ${p.status === 'confirmed' && p.unapplied > 0 ? html`<form method="post" action="/w/${id}/rent/payments/${p.id}/allocate">${csrfField(req)}<button class="btn" type="submit">Allocate to oldest open charges</button></form>` : ''}
          ${p.status === 'confirmed' && !p.receipt_no ? html`<form method="post" action="/w/${id}/rent/payments/${p.id}/receipt">${csrfField(req)}<button class="btn" type="submit">Issue receipt</button></form>` : ''}
          ${p.status === 'confirmed' ? html`<form method="post" action="/w/${id}/rent/payments/${p.id}/bounce" class="actions">${csrfField(req)}<input name="reason" placeholder="Reason" aria-label="Reason" required><button class="btn" type="submit">Reverse (bounced cheque, error)</button></form>` : ''}</div>` : html`<p class="muted small">Finance confirms payments and issues receipts.</p>`}
      </section>`, 'Payment'));
  });

  const payAct = (path, fn) => r.post(`/w/:id/rent/payments/:pid/${path}`, async (req, res) => {
    const a = await PR.access(req, 'post');
    const p = await paymentOf(a, req.params.pid);
    await core.inTx(async db => { await db.query('select id from tenant_payments where id = $1 for update', [p.id]); await fn(db, a, p, req); await PR.touch(db, a.ws.id); });
    res.redirect(`/w/${a.ws.id}/rent/payments/${p.id}?msg=saved`);
  });
  payAct('confirm', async (db, a, p, req) => {
    const on = dateOrNull(req.body.cleared_on); if (!on) throw bad('Enter the date the money was confirmed.');
    const n = (await db.query("update tenant_payments set status = 'confirmed', confirmed_by = $2, confirmed_at = now(), cleared_on = $3 where id = $1 and status = 'reported'", [p.id, req.user.id, on])).rowCount;
    if (!n) throw bad('This payment is not awaiting confirmation.');
    await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'rent.payment_confirmed', entity: 'tenant_payment', entityId: p.id, summary: `Tenant payment confirmed: ${formatMoney(Number(p.amount_minor))} (${p.lease_ref})`, ip: req.ip });
    await allocateOldest(db, a, req, p.id);
  });
  payAct('allocate', async (db, a, p, req) => { if (!(await allocateOldest(db, a, req, p.id))) throw bad('Nothing to allocate: no open charges or no unapplied amount.'); });
  payAct('receipt', async (db, a, p, req) => {
    const cur = (await db.query('select * from tenant_payments where id = $1', [p.id])).rows[0];
    if (cur.status !== 'confirmed') throw bad('Receipts are issued only for confirmed payments.');
    if (cur.receipt_no) throw bad(`Receipt ${cur.receipt_no} already issued.`);
    const y = String(cur.received_on).slice(0, 4);
    const no = `RRC-${y}-${String(await core.nextNumber(db, `RRC-${y}`)).padStart(5, '0')}`;
    await db.query('update tenant_payments set receipt_no = $2, receipt_issued_at = now(), receipt_issued_by = $3 where id = $1', [p.id, no, req.user.id]);
    await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'rent.receipt_issued', entity: 'tenant_payment', entityId: p.id, summary: `Rent receipt ${no} issued (${formatMoney(Number(cur.amount_minor))})`, ip: req.ip });
  });
  payAct('bounce', async (db, a, p, req) => {
    const reason = txt(req.body.reason, 300); if (!reason) throw bad('Give a reason.');
    const cur = (await db.query('select status from tenant_payments where id = $1', [p.id])).rows[0];
    if (!['reported', 'confirmed'].includes(cur.status)) throw bad('Already reversed.');
    const to = cur.status === 'reported' ? 'bounced' : 'reversed';
    await db.query('update tenant_payments set status = $2, reversed_at = now(), reverse_reason = $3 where id = $1', [p.id, to, reason]);
    await db.query("update tenant_allocations set status = 'reversed', reversed_at = now(), reverse_reason = $2 where payment_id = $1 and status = 'active'", [p.id, `Payment ${to}: ${reason}`]);
    await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: `rent.payment_${to}`, entity: 'tenant_payment', entityId: p.id, summary: `Tenant payment ${to}: ${formatMoney(Number(p.amount_minor))} — ${reason}`, ip: req.ip });
  });

  r.get('/w/:id/rent/payments/:pid/receipt.pdf', async (req, res) => {
    const a = await PR.access(req, 'finance');
    const p = await paymentOf(a, req.params.pid);
    if (!p.receipt_no) throw new NotFound();
    const co = (await pool.query('select * from company_profile where id = 1')).rows[0] || {};
    const prof = await PR.profileOf(a.ws.id);
    const owner = a.ws.party_id ? (await pool.query('select name from parties where id = $1', [a.ws.party_id])).rows[0] : null;
    const allocs = p.allocs.filter(x => x.status === 'active');
    const buf = await docs.render({ company: co, letterhead: prof.billing_entity === 'owner' && owner ? null : co.letterhead, marginTop: co.margin_top_mm, marginBottom: co.margin_bottom_mm,
      title: 'Rent receipt', number: p.receipt_no, stamp: ['reversed', 'bounced'].includes(p.status) ? 'REVERSED' : null, to: [p.tenant_name],
      meta: [['Payment date', fmtDate(p.received_on)], ['Method', p.method], ['Reference', p.reference || '—'], ['Lease', p.lease_ref], ['Property', a.ws.name], ['Unit', p.unit_ref]],
      tables: [{ caption: 'Applied to', head: ['Charge', 'Due', 'Amount'], widths: [0.55, 0.2, 0.25], align: ['left', 'left', 'right'], empty: 'Not yet applied', rows: allocs.map(x => [x.description, fmtDate(x.due_date), docs.money(Number(x.amount_minor))]) }],
      totals: [['Amount received', docs.money(Number(p.amount_minor)), true], ['Unapplied credit', docs.money(p.unapplied)]],
      notes: [prof.billing_entity === 'owner' && owner ? `Received on behalf of the owner, ${owner.name}, by SarayDar as managing agent.` : 'Received by SarayDar.', 'This receipt acknowledges a confirmed payment.'] });
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${p.receipt_no}.pdf"`, 'Cache-Control': 'private, no-store' }); res.end(buf);
  });

  // ---------- tenant statement ----------
  async function tenantStatement(leaseId, from, to) {
    const ev = [];
    for (const c of (await pool.query("select * from rent_charges where lease_id = $1", [leaseId])).rows) {
      ev.push({ date: String(c.due_date), doc: c.kind === 'opening' ? 'Opening' : 'Charge', text: c.description, debit: Number(c.amount_minor), credit: 0 });
      if (c.status === 'void') ev.push({ date: String(c.due_date), doc: 'Void', text: c.void_reason || 'Voided', debit: 0, credit: Number(c.amount_minor) });
    }
    for (const x of (await pool.query('select r.* from rent_credits r join rent_charges c on c.id = r.charge_id where c.lease_id = $1', [leaseId])).rows)
      ev.push({ date: String(x.on_date), doc: x.number, text: `Credit: ${x.reason}`, debit: 0, credit: Number(x.amount_minor) });
    for (const p of (await pool.query("select * from tenant_payments where lease_id = $1 and status in ('confirmed','reversed')", [leaseId])).rows) {
      ev.push({ date: String(p.received_on), doc: p.receipt_no || 'Payment', text: `Payment — ${p.method}${p.reference ? ` ${p.reference}` : ''}`, debit: 0, credit: Number(p.amount_minor) });
      if (p.status === 'reversed') ev.push({ date: bhDay(p.reversed_at), doc: p.receipt_no || 'Payment', text: `Payment reversed: ${p.reverse_reason}`, debit: Number(p.amount_minor), credit: 0 });
    }
    ev.sort((x, y) => x.date.localeCompare(y.date));
    let opening = 0; const rows = [];
    for (const e of ev) { if (from && e.date < from) { opening += e.debit - e.credit; continue; } if (to && e.date > to) continue; rows.push(e); }
    let bal = opening; for (const e of rows) { bal += e.debit - e.credit; e.balance = bal; }
    const pending = (await pool.query("select coalesce(sum(amount_minor),0) as s from tenant_payments where lease_id = $1 and status = 'reported'", [leaseId])).rows[0].s;
    return { opening, rows, closing: bal, pending: Number(pending), debits: rows.reduce((s, e) => s + e.debit, 0), credits: rows.reduce((s, e) => s + e.credit, 0) };
  }
  ctx.tenantStatement = tenantStatement;
  const periodQ = q => { const from = dateOrNull(q.from), to = dateOrNull(q.to); if (from && to && to < from) throw bad('The end date is before the start date.'); return { from, to, label: from || to ? `${from ? fmtDate(from) : 'Start'} – ${to ? fmtDate(to) : fmtDate(todayBH())}` : `All dates to ${fmtDate(todayBH())}` }; };

  r.get('/w/:id/leases/:lid/statement', async (req, res) => {
    const a = await PR.access(req, 'finance');
    const l = await PR.leaseFull(a, req.params.lid);
    const per = periodQ(req.query);
    const st = await tenantStatement(l.id, per.from, per.to);
    const qs = new URLSearchParams({ ...(per.from ? { from: per.from } : {}), ...(per.to ? { to: per.to } : {}) });
    res.send(page(req, a, 'Leases & Tenants', html`<p><a href="/w/${a.ws.id}/leases/${l.id}">‹ Lease ${l.ref}</a></p>
      <form class="filters" method="get"><label class="small">From <input type="date" name="from" value="${per.from || ''}"></label><label class="small">To <input type="date" name="to" value="${per.to || ''}"></label><button class="btn" type="submit">Apply</button>
        <span class="grow"></span><a class="btn" href="/w/${a.ws.id}/leases/${l.id}/statement.pdf?${qs}">Statement PDF for the tenant</a></form>
      <section class="panel"><h2 class="h">Tenant statement · ${l.tenant.name} · unit ${l.unit.ref} · ${per.label}</h2>
        <div class="table-wrap"><table><thead><tr><th>Date</th><th>Document</th><th>Details</th><th class="n">Charges</th><th class="n">Payments / credits</th><th class="n">Balance</th></tr></thead><tbody>
          <tr><td></td><td></td><td><b>Opening balance</b></td><td></td><td></td><td class="n">${fm(st.opening)}</td></tr>
          ${st.rows.map(e => html`<tr><td class="small">${fmtDate(e.date)}</td><td class="small mono">${e.doc}</td><td class="small">${e.text}</td><td class="n">${e.debit ? fm(e.debit) : ''}</td><td class="n">${e.credit ? fm(e.credit) : ''}</td><td class="n">${fm(e.balance)}</td></tr>`)}
          <tr class="total"><td></td><td></td><td>Closing balance</td><td class="n">${fm(st.debits)}</td><td class="n">${fm(st.credits)}</td><td class="n">${fm(st.closing)}</td></tr></tbody></table></div>
        <p class="muted small">Charges are dated by their due date. Payments count when confirmed, dated by the day received. ${st.pending ? `Reported but not yet confirmed: ${formatMoney(st.pending)} (not included).` : ''} Deposits are not part of this account.</p></section>`, 'Statement'));
  });

  r.get('/w/:id/leases/:lid/statement.pdf', async (req, res) => {
    const a = await PR.access(req, 'finance');
    const l = await PR.leaseFull(a, req.params.lid);
    const per = periodQ(req.query);
    const st = await tenantStatement(l.id, per.from, per.to);
    const co = (await pool.query('select * from company_profile where id = 1')).rows[0] || {};
    const nb = m => docs.money(m).replace(/^BHD /, '');
    const buf = await docs.render({ company: co, letterhead: co.letterhead, marginTop: co.margin_top_mm, marginBottom: co.margin_bottom_mm, title: 'Tenant statement', number: l.ref, to: [l.tenant.name, l.tenant.address, l.tenant.email],
      meta: [['Period', per.label], ['Property', a.ws.name], ['Unit', l.unit.ref], ['Currency', 'BHD']],
      tables: [{ head: ['Date', 'Document', 'Details', 'Charges', 'Payments', 'Balance'], widths: [0.12, 0.15, 0.34, 0.13, 0.13, 0.13], align: ['left', 'left', 'left', 'right', 'right', 'right'],
        rows: [Object.assign(['', '', 'Opening balance', '', '', nb(st.opening)], { bold: true }), ...st.rows.map(e => [fmtDate(e.date), e.doc, e.text, e.debit ? nb(e.debit) : '', e.credit ? nb(e.credit) : '', nb(e.balance)])] }],
      totals: [['Closing balance', docs.money(st.closing), true]], notes: [st.pending ? `Payments reported but not yet confirmed (${docs.money(st.pending)}) are not included.` : null, 'Deposits are held separately and are not shown here.'] });
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="statement-${l.ref}.pdf"`, 'Cache-Control': 'private, no-store' }); res.end(buf);
  });

  // ---------- deposits ----------
  r.post('/w/:id/leases/:lid/deposits', async (req, res) => {
    const a = await PR.access(req, 'edit');
    if (!a.finance) throw new NotFound();
    const l = await PR.own('leases', req.params.lid, a.ws.id);
    const kind = ['received', 'deduction', 'refund'].includes(req.body.kind) ? req.body.kind : null; if (!kind) throw bad('Choose the movement.');
    if (kind !== 'received' && !a.canPost) throw new ctx.Forbidden('Only Finance can record deductions and refunds.');
    const on = dateOrNull(req.body.on_date); if (!on) throw bad('Enter the date.');
    const amt = parseMoney(req.body.amount, 'BHD'); if (!amt || amt <= 0) throw bad('Enter the amount.');
    const reason = txt(req.body.reason, 300), appr = txt(req.body.approval_ref, 120);
    if (kind === 'deduction' && (!reason || !appr)) throw bad('A deduction needs a reason and the approval reference.');
    await core.inTx(async db => {
      await db.query('select id from leases where id = $1 for update', [l.id]);
      const bal = (await depositBalance(l.id, db)).balance;
      if (kind !== 'received' && amt > bal) throw bad(`Only ${formatMoney(bal)} is held for this lease.`);
      const id = (await db.query('insert into deposit_txns (workspace_id, lease_id, kind, on_date, amount_minor, holder, reason, approval_ref, reference, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id',
        [a.ws.id, l.id, kind, on, amt, ['saraydar', 'owner', 'other'].includes(req.body.holder) ? req.body.holder : 'saraydar', reason, appr, txt(req.body.reference, 80), req.user.id])).rows[0].id;
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: `deposit.${kind}`, entity: 'deposit_txn', entityId: id, summary: `Deposit ${kind} for ${l.ref}: ${formatMoney(amt)}${reason ? ` — ${reason}` : ''}`, ip: req.ip });
      await PR.touch(db, a.ws.id);
    });
    res.redirect(`/w/${a.ws.id}/leases/${l.id}?msg=saved`);
  });

  r.get('/w/:id/deposits', async (req, res) => {
    const a = await PR.access(req, 'finance');
    const rows = (await pool.query(`select l.id, l.ref, l.status, l.deposit_minor, u.ref as unit_ref, t.name as tenant_name,
        coalesce(sum(case when d.kind = 'received' then d.amount_minor else -d.amount_minor end),0)::bigint as held,
        coalesce(sum(d.amount_minor) filter (where d.kind = 'deduction'),0)::bigint as deducted, coalesce(sum(d.amount_minor) filter (where d.kind = 'refund'),0)::bigint as refunded,
        string_agg(distinct d.holder, ', ') as holders
      from leases l join units u on u.id = l.unit_id join parties t on t.id = l.tenant_id left join deposit_txns d on d.lease_id = l.id
      where l.workspace_id = $1 and l.status <> 'cancelled' group by l.id, u.ref, t.name, u.sort order by u.sort, l.start_date`, [a.ws.id])).rows;
    const total = rows.reduce((s, x) => s + Number(x.held), 0);
    res.send(page(req, a, 'Deposits', html`
      <section class="grid-cards"><div class="card"><div class="muted small">Deposits held now</div><div class="big">${fm(total)}</div><div class="muted small">A liability to tenants — not rent, not owner funds</div></div></section>
      <section class="panel"><h2 class="h">Deposits by lease</h2>${rows.length ? html`<div class="table-wrap"><table><thead><tr><th>Unit</th><th>Lease / tenant</th><th class="n">Agreed</th><th class="n">Deducted</th><th class="n">Refunded</th><th class="n">Held now</th><th>Held by</th></tr></thead><tbody>
        ${rows.map(x => html`<tr><td>${x.unit_ref}</td><td><a href="/w/${a.ws.id}/leases/${x.id}">${x.ref}</a><div class="muted small">${x.tenant_name} · ${x.status}</div></td><td class="n">${fm(x.deposit_minor)}</td><td class="n">${fm(x.deducted)}</td><td class="n">${fm(x.refunded)}</td>
          <td class="n ${Number(x.held) !== Number(x.deposit_minor) && x.status === 'active' ? 'warn-text' : ''}">${fm(x.held)}</td><td class="small">${x.holders || '—'}</td></tr>`)}</tbody></table></div>` : html`<p class="muted">No leases.</p>`}</section>`));
  });

  return { leaseAccount, depositBalance, tenantStatement };
}

module.exports = { mountRent };
