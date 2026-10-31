'use strict';
const AG = require('../lib/agreements');
const DL = require('../lib/download');
const CH = require('./choices');
// Clients Projects Management: the client & management-agreement tab, SarayDar's fee ledger
// (monthly invoice drafts, issue, credit notes, void, client payments, allocations, receipts,
// statements) and client approvals obtained outside the system.
//
// Separation rules: this ledger never reads or writes the client's construction budget/expenditure
// tables (budget_lines, commitments, cost_invoices, cost_payments), and those never feed fee figures.
// Issuing, payment recording, allocation and receipt issuance are separate, audited events.
const crypto = require('crypto');
const multer = require('multer');
const { html, raw, pill, csrfField, field, emptyState, fmtDate, fmtDateTime } = require('./views');
const { parseMoney, formatMoney, toInput, num } = require('../lib/money');
const fees = require('../lib/fees');
const docs = require('../lib/fee-docs');
const { sniff } = require('./workspaces');
const uploads = require('../lib/uploads');

const UUID = /^[0-9a-f-]{36}$/i;
const bad = m => Object.assign(new Error(m), { status: 400 });
const txt = (v, n = 300) => { const s = String(v ?? '').trim().slice(0, n); return s || null; };
const dateOrNull = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : null;
const todayBH = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bahrain' });
const iso = v => v ? fees.isoOf(v) : null;
const bhDay = ts => ts ? new Date(ts).toLocaleDateString('en-CA', { timeZone: 'Asia/Bahrain' }) : null;   // timestamp → Bahrain calendar day
const fm = (m, c = 'BHD') => m === null || m === undefined ? '—' : formatMoney(m, c);
const METHODS = ['Bank transfer', 'Cheque', 'Cash', 'Card', 'BenefitPay', 'Other'];
const SUBJECTS = { budget: 'Budget', appointment: 'Appointment', material: 'Material / sample', variation: 'Variation', payment: 'Payment', design: 'Design', agreement: 'Agreement', other: 'Other' };
const APPROVAL_TONE = { requested: 'warn', approved: 'ok', rejected: 'bad', withdrawn: 'muted' };
const INV_TONE = { draft: 'muted', issued: 'info', void: 'bad' };
const upload = require('./choices').withChoices(multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 6, fields: 30 } }));

function mountFees(r, ctx, P) {
  const { pool, core, NotFound, Forbidden } = ctx;

  // fee billing serves client projects (cpm) and managed properties (props)
  async function access(req, need = 'view') {
    if (!UUID.test(req.params.id || '')) throw new NotFound();
    const w = (await pool.query('select section from workspaces where id = $1', [req.params.id])).rows[0];
    const impl = w && w.section === 'cpm' ? P : w && w.section === 'props' ? ctx.PR : w && w.section === 'sales' ? ctx.SL : null;
    if (!impl) throw new NotFound();
    const a = await impl.access(req, need === 'finance-edit' ? 'edit' : need);
    a.impl = impl;
    return a;
  }
  const cpmOnly = a => { if (a.ws.section !== 'cpm') throw new NotFound(); return a; };
  const party = a => a.ws.section === 'props' ? 'Owner' : 'Client';
  async function finAccess(req, need = 'view') {
    const a = await access(req, need === 'post' ? 'view' : need);
    if (!a.finance) throw new NotFound();
    a.canPost = core.isSuper(req.user) || await core.can(req.user, 'finance:post');
    if (need === 'post' && !a.canPost) throw new Forbidden('Only Finance can do this.');
    return a;
  }
  const own = (t, id, ws) => P.own(t, id, ws);
  const touch = (db, ws) => P.touch(db, ws);
  const page = (req, a, tab, body) => a.impl.page(req, a, tab === 'Client' && a.ws.section === 'props' ? 'Owner' : tab, body);

  // ---------- ledger state (one fee account per client project) ----------
  async function ledger(wsId, db = pool) {
    const invoices = (await db.query(`select i.*,
        coalesce((select sum(amount_minor) from fee_credit_notes c where c.invoice_id = i.id), 0) as credited,
        coalesce((select sum(amount_minor) from fee_allocations x where x.invoice_id = i.id and x.status = 'active'), 0) as allocated
      from fee_invoices i where i.workspace_id = $1 order by coalesce(i.period_start, i.issue_date, i.created_at::date) desc, i.created_at desc`, [wsId])).rows
      .map(i => ({ ...i, total: num(i.total_minor), credited: num(i.credited), allocated: num(i.allocated), outstanding: i.status === 'issued' ? num(i.total_minor) - num(i.credited) - num(i.allocated) : 0 }));
    const payments = (await db.query(`select p.*, coalesce((select sum(amount_minor) from fee_allocations x where x.payment_id = p.id and x.status = 'active'), 0) as allocated
      from fee_payments p where p.workspace_id = $1 order by p.received_on desc, p.recorded_at desc`, [wsId])).rows
      .map(p => ({ ...p, amount: num(p.amount_minor), allocated: num(p.allocated), unapplied: p.status === 'confirmed' ? num(p.amount_minor) - num(p.allocated) : 0 }));
    const today = todayBH();
    const issued = invoices.filter(i => i.status === 'issued');
    const t = {
      invoiced: issued.reduce((s, i) => s + i.total, 0),
      credited: issued.reduce((s, i) => s + i.credited, 0),
      collected: payments.filter(p => p.status === 'confirmed').reduce((s, p) => s + p.amount, 0),
      outstanding: issued.reduce((s, i) => s + i.outstanding, 0),
      unapplied: payments.reduce((s, p) => s + p.unapplied, 0),
      overdue: issued.filter(i => i.outstanding > 0 && i.due_date && iso(i.due_date) < today),
      drafts: invoices.filter(i => i.status === 'draft').length
    };
    t.overdueAmount = t.overdue.reduce((s, i) => s + i.outstanding, 0);
    t.balance = t.invoiced - t.credited - t.collected;            // positive: client owes; negative: credit in hand
    return { invoices, payments, t, today };
  }
  ctx.feeLedger = ledger;

  const termsAll = async (wsId, db = pool) => (await db.query('select t.*, coalesce(nullif(u.name,\'\'), u.email) as activator from mgmt_terms t left join users u on u.id = t.activated_by where t.workspace_id = $1 order by version desc', [wsId])).rows;
  const activeTerms = rows => rows.find(t => t.status === 'active') || null;
  const company = async () => (await pool.query('select * from company_profile where id = 1')).rows[0] || {};
  const clientOf = async ws => ws.party_id ? (await pool.query('select * from parties where id = $1', [ws.party_id])).rows[0] : null;

  // ---------- overview & portfolio additions ----------
  ctx.overviewExtras = ctx.overviewExtras || {};
  const devOverview = ctx.overviewExtras.dev;
  ctx.overviewExtras.cpm = async (req, wsAccess) => {
    const a = await core.workspaceAccess(req.user, wsAccess.ws.id);
    if (!a || !a.internal) return '';
    const finance = core.isSuper(req.user) || a.role === 'manager' || a.role === 'editor' || await core.can(req.user, 'view:financials');
    const client = await clientOf(a.ws);
    const terms = activeTerms(await termsAll(a.ws.id));
    const pend = (await pool.query("select count(*)::int as n from client_approvals where workspace_id = $1 and status = 'requested'", [a.ws.id])).rows[0].n;
    let feeCell = '';
    if (finance) {
      const L = await ledger(a.ws.id);
      feeCell = html`<div><div class="muted small">SarayDar fees outstanding</div><div class="mid ${L.t.overdue.length ? 'err' : ''}"><a href="/w/${a.ws.id}/fees">${fm(L.t.outstanding)}</a></div>
        ${L.t.overdue.length ? html`<div class="small err">${L.t.overdue.length} overdue · ${fm(L.t.overdueAmount)}</div>` : ''}</div>`;
    }
    return html`<section class="client-banner"><div><div class="muted small">Client</div><div class="client-name">${client ? html`<a href="/clients/${client.id}">${client.name}</a>` : html`<span class="muted">Not linked yet</span>`}</div></div>
        <div><div class="muted small">Management fee</div><div class="mid">${terms ? html`${fm(num(terms.monthly_fee_minor), terms.currency)} / month` : html`<a href="/w/${a.ws.id}/agreements">Terms not recorded</a>`}</div></div>
        ${feeCell}
        ${req.projectScreen ? '' : html`<div><div class="muted small">Client approvals pending</div><div class="mid"><a href="/w/${a.ws.id}/approvals">${pend}</a></div></div>`}</section>
      ${devOverview ? await devOverview(req, wsAccess) : ''}`;
  };
  ctx.portfolioExtras = ctx.portfolioExtras || {};
  const devPortfolio = ctx.portfolioExtras.dev;
  ctx.portfolioExtras.cpm = async (ids, user) => {
    const out = devPortfolio ? await devPortfolio(ids) : {};
    const seeFees = core.isSuper(user) || await core.can(user, 'view:financials');
    for (const id of ids) {
      let feesCell = '—';
      if (seeFees || (await core.workspaceAccess(user, id) || {}).role === 'manager') {
        const L = await ledger(id);
        feesCell = L.t.outstanding ? `${fm(L.t.outstanding)}${L.t.overdue.length ? ' · overdue' : ''}` : fm(0);
      }
      out[id] = { ...(out[id] || {}), fees: feesCell };
    }
    return out;
  };
  ctx.attention = ctx.attention || [];
  ctx.attention.push(async user => {
    if (!(core.isSuper(user) || await core.can(user, 'view:financials'))) return [];
    const rows = (await pool.query(`select w.id, w.name, count(*)::int as n from fee_invoices i join workspaces w on w.id = i.workspace_id
      where ${core.visibleWhere(user)} and i.status = 'issued' and i.due_date < $2
        and i.total_minor > coalesce((select sum(amount_minor) from fee_credit_notes c where c.invoice_id = i.id),0) + coalesce((select sum(amount_minor) from fee_allocations x where x.invoice_id = i.id and x.status='active'),0)
      group by w.id, w.name order by w.name limit 10`, [user.id, todayBH()])).rows;
    return rows.map(x => ['Fees', 'bad', `${x.n} overdue fee invoice${x.n > 1 ? 's' : ''}: ${x.name}`, 'Follow up the client payment or record it.', `/w/${x.id}/fees`]);
  });

  // ---------- Client tab, and the terms block of the Agreements tab ----------
  const termLabel = t => `v${t.version} · ${fm(num(t.monthly_fee_minor), t.currency)} / month from ${fmtDate(t.effective_from)}`;
  const taxText = t => t.tax_mode === 'rate' ? `${t.tax_label || 'Tax'} ${fees.pctLabel(t.tax_rate_bp || 0)}` : t.tax_mode === 'none' ? 'No VAT charged' : 'Not configured';

  // The Client (Owner) tab holds the client's details; the management terms and the agreement made from them
  // sit at the top of the Agreements tab (owner request 2026-10-24: one place for everything about the agreement).
  async function clientAndTerms(req) {
    const a = await access(req);
    const client = await clientOf(a.ws);
    const all = await termsAll(a.ws.id);
    const draft = all.find(t => t.status === 'draft');
    const act = activeTerms(all);
    const edit = core.canEdit(a);
    const canPost = core.isSuper(req.user) || await core.can(req.user, 'finance:post');
    const role = a.ws.section === 'props' ? 'owner' : 'client';
    const clients = edit ? (await pool.query("select id, name from parties where $1 = any(roles) and archived_at is null order by name limit 500", [role])).rows : [];
    const base = { ...(draft || act || {}) };
    // the reference fills itself from this workspace's agreement (signed first, then issued, then the latest draft)
    const agr = (await pool.query("select ref, signed_on, status from agreements where workspace_id = $1 and status <> 'cancelled' order by case status when 'signed' then 0 when 'issued' then 1 else 2 end, created_at desc limit 1", [a.ws.id])).rows[0];
    if (agr && !base.agreement_ref) { base.agreement_ref = agr.ref; if (!base.signed_on && agr.signed_on) base.signed_on = agr.signed_on; }
    const showTerms = a.finance;
    const tf = (k, label, extra = {}) => field({ name: k, label, value: base[k] instanceof Date ? iso(base[k]) : base[k] ?? '', ...extra });
    const clientHtml = html`
        <section class="panel grow1"><div class="row-between"><h2 class="h">${party(a)}</h2>${client ? html`<div class="actions">${edit ? html`<a class="btn small primary" href="/clients/${client.id}?edit=1&back=${encodeURIComponent(`/w/${a.ws.id}/client`)}#edit">Edit ${party(a).toLowerCase()} details</a>` : ''}<a class="btn small" href="/clients/${client.id}">Full profile</a></div>` : ''}</div>
          ${client ? html`<p class="client-name">${client.name}</p>
            <div class="profile-groups">
              <div><h3 class="h3">${party(a)} details</h3><dl class="details">
                <div><dt>Individual or company</dt><dd>${client.kind === 'company' ? 'Company' : 'Individual'}</dd></div>
                <div><dt>${client.kind === 'company' ? 'CR number' : 'CPR number'}</dt><dd>${client.id_number || html`<span class="muted">Not recorded</span>`}</dd></div>
                <div><dt>Telephone</dt><dd>${client.phone || '—'}</dd></div><div><dt>Email</dt><dd>${client.email || '—'}</dd></div>
                <div><dt>Preferred contact</dt><dd>${client.preferred_contact || '—'}</dd></div>
                ${client.contact_person && client.contact_person !== client.name ? html`<div><dt>Day-to-day contact</dt><dd>${client.contact_person}</dd></div>` : ''}
                ${client.address ? html`<div><dt>Address</dt><dd class="pre-line">${client.address}</dd></div>` : ''}</dl></div>
              <div><h3 class="h3">${party(a)}'s representative</h3>${client.signs_personally ? html`<p class="muted">The ${party(a).toLowerCase()} signs personally (no representative).</p>`
                : client.representative ? html`<dl class="details">
                <div><dt>Name</dt><dd>${client.representative}</dd></div>
                <div><dt>Title / capacity</dt><dd>${client.representative_title || `${party(a)}'s Representative`}</dd></div>
                <div><dt>CPR number</dt><dd>${client.representative_cpr || html`<span class="muted">Not recorded</span>`}</dd></div>
                <div><dt>Telephone</dt><dd>${client.representative_phone || '—'}</dd></div><div><dt>Email</dt><dd>${client.representative_email || '—'}</dd></div></dl>`
                : html`<p class="muted">Not recorded. ${client.contact_person && client.contact_person !== client.name ? `${client.contact_person} (day-to-day contact) signs for now.` : ''}</p>`}</div>
            </div>`
            : html`<p class="muted">Not linked to ${a.ws.section === 'props' ? 'an owner' : 'a client'} yet.</p>`}
          ${edit ? html`<details class="inline-form"><summary>${client ? `Change ${party(a).toLowerCase()}` : `Link ${a.ws.section === 'props' ? 'an owner' : 'a client'}`}</summary><form method="post" action="/w/${a.ws.id}/client/link" class="form-grid">${csrfField(req)}
            ${field({ name: 'party_id', label: party(a), options: [['', 'Choose…'], ...clients.map(c => [c.id, c.name])], required: true })}
            ${a.ws.section === 'props' ? field({ name: 'new_name', label: 'Or new owner name' }) : ''}
            <div class="actions full"><button class="btn" type="submit">Save</button>${a.ws.section === 'cpm' ? html`<a class="btn" href="/clients/new">+ New client</a>` : ''}</div></form></details>` : ''}
        </section>`;
    const termsHtml = !showTerms ? '' : html`<section class="panel"><h2 class="h">Management agreement terms</h2>
          ${act ? html`<dl class="details">
            <div><dt>In force</dt><dd>${termLabel(act)}</dd></div>
            <div><dt>Agreement</dt><dd>${act.agreement_ref || '—'}${act.signed_on ? ` · signed ${fmtDate(act.signed_on)}` : ''}</dd></div>
            <div><dt>Period</dt><dd>${fmtDate(act.start_date)} – ${act.end_date ? fmtDate(act.end_date) : 'open-ended'}</dd></div>
            <div><dt>Billing</dt><dd>Monthly in ${act.billing_timing} · ${act.proration === 'daily' ? 'part months prorated by day' : 'full fee for part months'} · payment due ${act.payment_terms_days} days after issue</dd></div>
            <div><dt>Tax</dt><dd>${act.tax_mode === 'not_configured' ? html`<span class="err">Not configured — invoices cannot be issued until it is</span>` : taxText(act)}</dd></div>
            <div><dt>Client approvers</dt><dd class="pre-line">${client ? AG.approversOf(client).join('\n') : act.client_approvers || '—'}</dd></div>
            <div><dt>Scope</dt><dd class="pre-line">${act.scope || '—'}</dd></div>
            ${act.responsibilities ? html`<div><dt>Responsibilities</dt><dd class="pre-line">${act.responsibilities}</dd></div>` : ''}
            <div><dt>Exclusions</dt><dd class="pre-line">${act.exclusions || '—'}</dd></div>
            <div><dt>Activated</dt><dd>${act.activator || '—'} · ${fmtDateTime(act.activated_at)}</dd></div></dl>`
            : html`<p class="muted">No terms in force yet. Record them below; Finance activates them.</p>`}
          ${all.length > 1 || draft ? html`<h3 class="h3">Versions</h3><div class="table-wrap"><table><thead><tr><th>Version</th><th>Effective from</th><th class="n">Monthly fee</th><th>Tax</th><th>Status</th><th></th></tr></thead><tbody>
            ${all.map(t => html`<tr><td>v${t.version}</td><td>${fmtDate(t.effective_from)}</td><td class="n">${fm(num(t.monthly_fee_minor), t.currency)}</td><td class="small">${taxText(t)}</td><td>${pill(t.status === 'active' ? 'In force' : t.status.replace('_', ' '), t.status === 'active' ? 'ok' : t.status === 'draft' ? 'warn' : 'muted')}</td>
              <td>${t.status === 'draft' && canPost ? html`<form method="post" action="/w/${a.ws.id}/terms/${t.id}/activate" class="actions">${csrfField(req)}<button class="btn small primary" type="submit">Activate</button></form>` : ''}
                ${t.status === 'draft' && edit ? html`<form method="post" action="/w/${a.ws.id}/terms/${t.id}/withdraw" class="actions">${csrfField(req)}<button class="btn small" type="submit">Discard draft</button></form>` : ''}</td></tr>`)}</tbody></table></div>
            <p class="muted small">Earlier versions are kept. A new version applies from its effective date; invoices for earlier periods keep using the terms in force then.</p>` : ''}
          ${edit ? html`<details class="inline-form" ${!act && !draft ? raw('open') : ''}><summary>${draft ? `Edit draft v${draft.version}` : act ? 'Change the terms (new version)' : 'Record the terms'}</summary>
            <form method="post" action="/w/${a.ws.id}/terms" class="form-grid">${csrfField(req)}
              <input type="hidden" name="agreement_ref" value="${base.agreement_ref || ''}"><input type="hidden" name="signed_on" value="${base.signed_on ? iso(base.signed_on) : ''}">
              ${base.agreement_ref ? html`<p class="muted small full">Agreement ${base.agreement_ref}${base.signed_on ? ` · signed ${fmtDate(base.signed_on)}` : ''} — filled automatically from the agreement.</p>` : ''}
              ${tf('start_date', 'Agreement start', { type: 'date', required: true })}${tf('end_date', 'Agreement end', { type: 'date', hint: 'Leave empty if open-ended.' })}
              ${act ? field({ name: 'effective_from', label: 'This change applies from', type: 'date', required: true, value: draft ? iso(draft.effective_from) : '', hint: 'The date the new terms take effect.' }) : ''}
              ${field({ name: 'monthly_fee', label: 'Monthly management fee (BHD)', required: true, value: base.monthly_fee_minor !== undefined ? toInput(num(base.monthly_fee_minor)) : '', attrs: 'inputmode="decimal" placeholder="0"' })}
              ${field({ name: 'billing_timing', label: 'Billed', value: base.billing_timing || 'advance', options: [['advance', 'In advance (start of the month)'], ['arrears', 'In arrears (after the month)']] })}
              ${field({ name: 'proration', label: 'Part months', value: base.proration || 'daily', options: [['daily', 'Prorate by day'], ['none', 'Full monthly fee']] })}
              ${field({ name: 'payment_terms_days', label: 'Payment due (days after invoice)', value: base.payment_terms_days ?? 30, options: [7, 14, 15, 30, 45, 60, 90].concat(base.payment_terms_days != null && ![7, 14, 15, 30, 45, 60, 90].includes(base.payment_terms_days) ? [base.payment_terms_days] : []).map(d => [d, `${d} days`]) })}
              ${field({ name: 'notice_days', label: 'Termination notice', value: base.notice_days ?? 30, options: [['', 'Not stated'], ...[30, 60, 90].concat(base.notice_days != null && ![30, 60, 90].includes(base.notice_days) ? [base.notice_days] : []).map(d => [d, `${d} days`])], hint: 'Printed in the agreement.' })}
              ${field({ name: 'tax_mode', label: 'VAT on the fee', value: base.tax_mode || 'none', options: [['none', 'No VAT'], ['rate', 'Charge VAT'], ['not_configured', 'Not yet confirmed']] })}
              <div data-show-when="tax_mode=rate">${field({ name: 'tax_rate', label: 'VAT rate (%)', value: base.tax_rate_bp !== undefined && base.tax_rate_bp !== null ? base.tax_rate_bp / 100 : '', attrs: 'inputmode="decimal" placeholder="10"' })}</div>
              <input type="hidden" name="tax_label" value="${base.tax_label || ''}">
              ${field({ name: 'scope', label: 'SarayDar management scope — tick what SarayDar will do', type: 'checks', value: base.scope || '', options: a.ws.section === 'props' ? CH.PROP_SCOPE : CH.MGMT_SCOPE, otherLabel: 'Anything else (one per line)' })}
              ${field({ name: 'exclusions', label: 'Not included — tick what is excluded', type: 'checks', value: base.exclusions || '', options: a.ws.section === 'props' ? CH.PROP_EXCLUSIONS : CH.MGMT_EXCLUSIONS, otherLabel: 'Other exclusions (one per line)' })}
              ${tf('notes', 'Notes', { type: 'textarea' })}
              <div class="actions full"><button class="btn primary" type="submit">Save draft terms</button></div>
              <p class="muted small full">Saved as a draft. Finance activates it; activation replaces the previous version from the effective date and keeps it in the history.</p></form></details>` : ''}
        </section>
      ${ctx.mgmtAgreement ? await agreementPanel(req, a, base, edit) : ''}`;
    return { a, client, clientHtml, termsHtml };
  }

  r.get('/w/:id/client', async (req, res) => {
    const w = UUID.test(req.params.id || '') ? (await pool.query('select section from workspaces where id = $1', [req.params.id])).rows[0] : null;
    if (w && w.section === 'sales') return res.redirect(`/w/${req.params.id}/mandate`);
    const { a, client, clientHtml } = await clientAndTerms(req);
    const terms = a.finance ? (await termsAll(a.ws.id)).find(t => t.status === 'active') : null;
    res.send(page(req, a, 'Client', html`${clientHtml}
      ${a.finance && ['cpm', 'props'].includes(a.ws.section) ? html`<section class="panel"><div class="row-between"><h2 class="h">Management agreement</h2><a class="btn small primary" href="/w/${a.ws.id}/agreements">Open Agreements</a></div>
        <p class="muted">${terms ? `In force: ${termLabel(terms)}.` : 'No terms in force yet.'} The terms and the agreement document are under the Agreements tab.</p></section>` : ''}`));
  });
  // the terms and the generated agreement, shown at the top of the Agreements tab
  ctx.mgmtTermsBlock = async req => {
    const w = (await pool.query('select section from workspaces where id = $1', [req.params.id])).rows[0];
    if (!w || !['cpm', 'props'].includes(w.section)) return '';
    const { termsHtml } = await clientAndTerms(req);
    return termsHtml;
  };

  // after reviewing the agreement, send it to the client for approval from the same place (owner request 2026-10-31):
  // an approval request with the PDF attached appears in the client's portal, where they preview it and approve or reject
  async function sendForApproval(req, a, g, edit) {
    const v = g.versions[0];
    const last = (await pool.query("select id, status, requested_on, decided_on, approver_name, client_comment, linked_ref from client_approvals where workspace_id = $1 and subject = 'agreement' and linked_ref like $2 order by created_at desc limit 1", [a.ws.id, `${g.ref} v%`])).rows[0];
    const lastV = last ? Number(String(last.linked_ref).split(' v').pop()) : null;
    const viewers = (await pool.query("select count(*)::int as n from workspace_members m join users u on u.id = m.user_id where m.workspace_id = $1 and m.revoked_at is null and m.role = 'client_viewer' and u.active", [a.ws.id])).rows[0].n;
    const state = !last ? '' : last.status === 'requested' ? html`${pill(`Version ${lastV} sent for approval ${fmtDate(last.requested_on)} · waiting`, 'warn')}`
      : last.status === 'approved' ? html`${pill(`Version ${lastV} approved${last.approver_name ? ` by ${last.approver_name}` : ''} ${fmtDate(last.decided_on)}`, 'ok')}`
      : last.status === 'rejected' ? html`${pill(`Version ${lastV} rejected ${fmtDate(last.decided_on)}`, 'bad')}${last.client_comment ? html` <span class="small">“${last.client_comment}”</span>` : ''}` : html`${pill(`Version ${lastV} request withdrawn`, 'muted')}`;
    const pending = last && last.status === 'requested' && lastV === v.version;
    return html`<div class="send-approval">
      <div class="row-between"><h3 class="h3">Client approval</h3><span>${state}${last ? html` <a class="small" href="/w/${a.ws.id}/approvals#a-${last.id}">Open</a>` : ''}</span></div>
      ${edit && !pending ? html`<form method="post" action="/w/${a.ws.id}/client/agreement/send" class="form-grid">${csrfField(req)}<input type="hidden" name="version" value="${v.version}">
        ${field({ name: 'client_note', label: 'Message to the client (optional)', type: 'textarea', full: true, value: 'Please review the agreement and approve it, or reject it with your comments.', attrs: 'rows="2" maxlength="2000"' })}
        <div class="actions full"><button class="btn primary" type="submit">Send version ${v.version} to the client for approval</button>
          <span class="muted small">${viewers ? `The client gets an email and sees it under Approvals in their portal, with the PDF to preview.` : 'No client portal access yet: the request is recorded on Client Approvals, and you can record the client’s answer there. Invite the client under Access & Invitations to let them answer themselves.'}</span></div></form>`
      : pending ? html`<p class="muted small">Waiting for the client's answer. Generating a new version and sending it replaces this request.</p>` : ''}
    </div>`;
  }

  r.post('/w/:id/client/agreement/send', async (req, res) => {
    const a = cpmOnly(await access(req, 'edit'));
    const g = await ctx.mgmtAgreement.current(a.ws.id, a.ws.section);
    if (!g || !g.versions.length) throw bad('Generate the agreement first.');
    if (['signed', 'cancelled'].includes(g.status)) throw bad(`${g.ref} is ${g.status}.`);
    const n = Number(req.body.version) || g.versions[0].version;
    const ver = (await pool.query('select version, pdf from agreement_versions where agreement_id = $1 and version = $2', [g.id, n])).rows[0];
    if (!ver || !ver.pdf) throw bad('That version has no PDF.');
    const party = a.ws.party_id ? (await pool.query('select name from parties where id = $1', [a.ws.party_id])).rows[0] : null;
    const title = `${g.title || 'Agreement'} (${g.ref}, version ${n})`, note = txt(req.body.client_note, 2000);
    const name = DL.fileName([g.ref, a.ws.name, `v${n}`], 'pdf');
    const file = { name, mime: 'application/pdf', size: ver.pdf.length, sha: require('crypto').createHash('sha256').update(ver.pdf).digest('hex'), data: ver.pdf, thumb: null, width: null, height: null };
    const id = await core.inTx(async db => {
      // an earlier request for this agreement that is still open is withdrawn: only the latest version is asked
      await db.query("update client_approvals set status = 'withdrawn', decided_on = $3, decided_by = $4, decided_at = now(), notes = concat_ws(' · ', notes, 'Replaced by a newer version') where workspace_id = $1 and subject = 'agreement' and linked_ref like $2 and status = 'requested'", [a.ws.id, `${g.ref} v%`, todayBH(), req.user.id]);
      const id = (await db.query("insert into client_approvals (workspace_id, subject, title, linked_ref, requested_on, requested_from, client_note, client_visible, created_by) values ($1,'agreement',$2,$3,$4,$5,$6,true,$7) returning id",
        [a.ws.id, title, `${g.ref} v${n}`, todayBH(), party ? party.name : null, note, req.user.id])).rows[0].id;
      await uploads.insert(db, { workspaceId: a.ws.id, entity: 'client_approval', entityId: id, files: [file], userId: req.user.id, tag: 'request', observedOn: todayBH() });
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'approval.requested', entity: 'client_approval', entityId: id, summary: `Agreement ${g.ref} version ${n} sent to the client for approval`, ip: req.ip });
      await touch(db, a.ws.id);
      return id;
    });
    const told = await tellClientViewers(req, a, id, title, note);
    res.redirect(`/w/${a.ws.id}/agreements?msg=${told ? 'sent' : 'added'}#agreement`);
  });

  // the whole agreement, generated from the terms above plus the standard clauses of the management template
  async function agreementPanel(req, a, terms, edit) {
    const g = await ctx.mgmtAgreement.current(a.ws.id, a.ws.section);
    const id = a.ws.id;
    const hasTerms = !!terms.start_date;
    const locked = g && ['signed', 'cancelled'].includes(g.status);
    const missing = hasTerms ? await ctx.mgmtAgreement.missing(a) : [];
    return html`<section class="panel" id="agreement"><div class="row-between"><h2 class="h">Agreement document</h2>${g ? html`<span>${pill(g.ref, 'muted')} ${pill(g.status === 'signed' ? 'Signed' : g.status === 'issued' ? 'Issued for signature' : g.status === 'cancelled' ? 'Cancelled' : 'Draft', g.status === 'signed' ? 'ok' : 'warn')}</span>` : ''}</div>
      <p class="muted small">The full agreement is written from the terms above (parties, scope, exclusions, fee, billing, payment, term, approvers, notice) together with the standard clauses: governing law, entire agreement and signature boxes. Edit the terms, then generate again — each generation is kept as a numbered version.</p>
      ${g && g.versions.length ? html`<ul class="rows">${g.versions.slice(0, 5).map(v => html`<li><div class="grow"><b>${g.ref} · version ${v.version}</b><div class="muted small">${fmtDateTime(v.created_at)}</div></div>
          ${v.has_pdf ? html`<a class="btn small primary" href="/w/${id}/agreements/${g.id}/v/${v.version}.pdf${DL.pretty(DL.fileName([g.ref, a.ws.name, `v${v.version}`], 'pdf'))}?view=1" target="_blank" rel="noopener">Preview</a><a class="btn small" href="/w/${id}/agreements/${g.id}/v/${v.version}.pdf">PDF</a>` : ''}${v.has_docx ? html`<a class="btn small" href="/w/${id}/agreements/${g.id}/v/${v.version}.docx">Word</a>` : ''}${edit && g.status === 'draft' && v.version !== g.versions[0].version ? html`<form method="post" action="/w/${id}/agreements/${g.id}/v/${v.version}/delete" class="inline">${csrfField(req)}<input type="hidden" name="back" value="/w/${id}/agreements"><button class="btn small danger-link" type="submit" data-confirm="Delete version ${v.version}? This cannot be undone.">Delete</button></form>` : ''}</li>`)}</ul>` : html`<p class="muted">No agreement generated yet.</p>`}
      <div class="actions">
        ${missing.length ? html`<div class="notice warn full">To write the agreement, add: <b>${missing.join(', ')}</b>.</div>` : ''}
        ${edit && hasTerms && a.ws.party_id && !missing.length ? html`<form method="post" action="/w/${id}/client/agreement" class="inline">${csrfField(req)}<button class="btn primary" type="submit">${locked ? 'Prepare a new agreement from these terms' : g && g.versions.length ? 'Generate again from the terms' : 'Generate the agreement'}</button></form>` : ''}
        ${g ? html`<a class="btn" href="/w/${id}/agreements/${g.id}">Issue for signature / upload the signed copy</a>` : ''}
      </div>
      ${a.ws.section === 'cpm' && g && g.versions.length && !locked ? await sendForApproval(req, a, g, edit) : ''}
      ${!hasTerms ? html`<p class="muted small">Record the terms first.</p>` : !a.ws.party_id ? html`<p class="muted small">Link the ${a.ws.section === 'props' ? 'owner' : 'client'} first.</p>` : ''}
      ${locked ? html`<p class="muted small">${g.ref} is ${g.status}; it stays exactly as signed. Generating again starts a new agreement (for example an amendment) with a new reference.</p>` : ''}
    </section>`;
  }

  r.post('/w/:id/client/agreement', async (req, res) => {
    const a = await access(req, 'edit');
    if (!['cpm', 'props'].includes(a.ws.section)) throw new NotFound();
    const { g, v } = await ctx.mgmtAgreement.generate(req, a);
    res.redirect(`/w/${a.ws.id}/agreements?msg=created#agreement`);
  });

  r.post('/w/:id/client/link', async (req, res) => {
    const a = await access(req, 'edit');
    const role = a.ws.section === 'props' ? 'owner' : 'client';
    const pid = UUID.test(req.body.party_id || '') ? req.body.party_id : null;
    let p = pid ? (await pool.query("select id, name, roles from parties where id = $1 and archived_at is null", [pid])).rows[0] : null;
    if (!p && role === 'owner' && txt(req.body.new_name, 160)) p = (await pool.query("insert into parties (name, roles, created_by) values ($1, '{owner}', $2) returning id, name, roles", [txt(req.body.new_name, 160), req.user.id])).rows[0];
    if (!p) throw bad(`Choose ${role === 'owner' ? 'an owner' : 'a client'}.`);
    await core.inTx(async db => {
      if (!p.roles.includes(role)) await db.query("update parties set roles = array_append(roles, $2) where id = $1", [p.id, role]);
      await db.query('update workspaces set party_id = $2, updated_at = now() where id = $1', [a.ws.id, p.id]);
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'workspace.client_linked', entity: 'workspace', entityId: a.ws.id, summary: `${role === 'owner' ? 'Owner' : 'Client'} linked: ${p.name}`, before: { party_id: a.ws.party_id }, after: { party_id: p.id }, ip: req.ip });
    });
    res.redirect(`/w/${a.ws.id}/client?msg=saved`);
  });

  function readTerms(b) {
    const start = dateOrNull(b.start_date); if (!start) throw bad('Enter the agreement start date.');
    const eff = dateOrNull(b.effective_from) || start;
    const end = dateOrNull(b.end_date);
    if (end && end < start) throw bad('The agreement end is before its start.');
    if (eff < start) throw bad('The terms cannot apply before the agreement starts.');
    if (end && eff > end) throw bad('The terms cannot apply after the agreement ends.');
    const fee = parseMoney(b.monthly_fee, 'BHD');
    if (fee === null || fee < 0) throw bad('Enter the monthly management fee.');
    const tax_mode = ['not_configured', 'none', 'rate'].includes(b.tax_mode) ? b.tax_mode : 'not_configured';
    let tax_rate_bp = null;
    if (tax_mode === 'rate') {
      const v = String(b.tax_rate || '').trim();
      if (!/^\d{1,3}(\.\d{1,2})?$/.test(v) || Number(v) > 100) throw bad('Enter the tax rate as a percentage, for example 10.');
      const [w, f = ''] = v.split('.'); tax_rate_bp = Number(w) * 100 + Number((f + '00').slice(0, 2));
    }
    const days = parseInt(b.payment_terms_days, 10);
    const notice = parseInt(b.notice_days, 10);
    return { notice_days: Number.isFinite(notice) && notice >= 0 && notice <= 365 ? notice : null, agreement_ref: txt(b.agreement_ref, 80), signed_on: dateOrNull(b.signed_on), start_date: start, end_date: end, effective_from: eff,
      monthly_fee_minor: fee, billing_timing: b.billing_timing === 'arrears' ? 'arrears' : 'advance', proration: b.proration === 'none' ? 'none' : 'daily',
      payment_terms_days: Number.isFinite(days) && days >= 0 && days <= 365 ? days : 30, tax_mode, tax_rate_bp, tax_label: txt(b.tax_label, 40) || (tax_mode === 'rate' ? 'VAT' : null),
      client_approvers: txt(b.client_approvers, 2000), scope: txt(b.scope, 4000), responsibilities: txt(b.responsibilities, 4000), exclusions: txt(b.exclusions, 4000), notes: txt(b.notes, 2000) };
  }

  r.post('/w/:id/terms', async (req, res) => {
    const a = await finAccess(req, 'edit');
    const t = readTerms(req.body);
    // approvers are the client and their representative (from the client's profile); the terms keep a copy as at this version
    if (!t.client_approvers) { const c = await clientOf(a.ws); t.client_approvers = c ? AG.approversOf(c).join('\n') || null : null; }
    await core.inTx(async db => {
      await db.query('select id from workspaces where id = $1 for update', [a.ws.id]);
      const act = (await db.query("select * from mgmt_terms where workspace_id = $1 and status = 'active'", [a.ws.id])).rows[0];
      if (act && t.effective_from <= iso(act.effective_from)) throw bad(`A change must take effect after the current terms (from ${fmtDate(act.effective_from)}).`);
      const draft = (await db.query("select id, version from mgmt_terms where workspace_id = $1 and status = 'draft'", [a.ws.id])).rows[0];
      const cols = Object.keys(t);
      let id;
      if (draft) {
        await db.query(`update mgmt_terms set ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} where id = $1`, [draft.id, ...cols.map(c => t[c])]);
        id = draft.id;
      } else {
        const v = (await db.query('select coalesce(max(version),0)+1 as v from mgmt_terms where workspace_id = $1', [a.ws.id])).rows[0].v;
        id = (await db.query(`insert into mgmt_terms (workspace_id, version, created_by, ${cols.join(', ')}) values ($1,$2,$3,${cols.map((c, i) => `$${i + 4}`).join(',')}) returning id`, [a.ws.id, v, req.user.id, ...cols.map(c => t[c])])).rows[0].id;
      }
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'terms.draft_saved', entity: 'mgmt_terms', entityId: id, summary: `Management terms draft saved: ${formatMoney(t.monthly_fee_minor)} / month from ${t.effective_from}`, after: t, ip: req.ip });
    });
    res.redirect(`/w/${a.ws.id}/agreements?msg=saved`);
  });

  r.post('/w/:id/terms/:tid/activate', async (req, res) => {
    const a = await finAccess(req, 'post');
    const t = await own('mgmt_terms', req.params.tid, a.ws.id);
    await core.inTx(async db => {
      await db.query('select id from workspaces where id = $1 for update', [a.ws.id]);
      const cur = (await db.query('select status from mgmt_terms where id = $1', [t.id])).rows[0];
      if (cur.status !== 'draft') throw bad('Only a draft can be activated.');
      const act = (await db.query("select * from mgmt_terms where workspace_id = $1 and status = 'active'", [a.ws.id])).rows[0];
      if (act && iso(t.effective_from) <= iso(act.effective_from)) throw bad('The new terms must take effect after the current ones.');
      // invoices already issued for periods on/after the change are not rewritten: warn by refusing silently-changing history
      const clash = (await db.query("select number from fee_invoices where workspace_id = $1 and status = 'issued' and kind = 'monthly' and period_end >= $2 limit 1", [a.ws.id, iso(t.effective_from)])).rows[0];
      if (clash) throw bad(`Invoice ${clash.number} is already issued for a period after ${fmtDate(t.effective_from)}. Credit or void it first, or choose a later effective date.`);
      if (act) await db.query("update mgmt_terms set status = 'superseded' where id = $1", [act.id]);
      await db.query("update mgmt_terms set status = 'active', activated_by = $2, activated_at = now() where id = $1", [t.id, req.user.id]);
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'terms.activated', entity: 'mgmt_terms', entityId: t.id, summary: `Management terms v${t.version} in force from ${iso(t.effective_from)}: ${formatMoney(num(t.monthly_fee_minor))} / month`, before: act ? { version: act.version, fee: num(act.monthly_fee_minor) } : null, after: { version: t.version, fee: num(t.monthly_fee_minor) }, ip: req.ip });
      await touch(db, a.ws.id);
    });
    res.redirect(`/w/${a.ws.id}/agreements?msg=saved`);
  });

  r.post('/w/:id/terms/:tid/withdraw', async (req, res) => {
    const a = await finAccess(req, 'edit');
    const t = await own('mgmt_terms', req.params.tid, a.ws.id);
    await core.inTx(async db => {
      const n = (await db.query("update mgmt_terms set status = 'withdrawn' where id = $1 and status = 'draft'", [t.id])).rowCount;
      if (!n) throw bad('Only a draft can be discarded.');
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'terms.draft_withdrawn', entity: 'mgmt_terms', entityId: t.id, summary: `Draft terms v${t.version} discarded`, ip: req.ip });
    });
    res.redirect(`/w/${a.ws.id}/agreements?msg=saved`);
  });

  // ---------- Fee Billing ----------
  const monthsAround = () => {
    const now = new Date(`${todayBH()}T00:00:00Z`); const out = [];
    for (let k = -6; k <= 2; k++) { const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + k, 1)); out.push(d.toISOString().slice(0, 7)); }
    return out;
  };
  r.get('/w/:id/fees', async (req, res) => {
    const a = await finAccess(req);
    const L = await ledger(a.ws.id);
    const all = await termsAll(a.ws.id);
    const act = activeTerms(all);
    const edit = core.canEdit(a);
    const id = a.ws.id;
    const open = L.invoices.filter(i => i.status === 'issued' && i.outstanding > 0).sort((x, y) => String(iso(x.due_date)).localeCompare(String(iso(y.due_date))));
    const billed = new Set(L.invoices.filter(i => i.kind === 'monthly' && i.status !== 'void').map(i => iso(i.period_start).slice(0, 7)));
    const idem = crypto.randomBytes(12).toString('hex');
    res.send(page(req, a, 'Fee Billing', html`
      ${a.ws.section === 'sales' ? html`<div class="notice info">SarayDar's brokerage fees for this case, from its mandate. Commission invoices are prepared from the deal; the property price and any deposits are never counted here.</div>` : a.ws.section === 'props' ? html`<div class="notice info">SarayDar's own management-fee account for this property, addressed to the owner. Rent, deposits and property expenses are kept separately and never counted here.${(await ctx.PR.profileOf(id)).fee_deduction_allowed ? html` Fees may be deducted from collected rent under <a href="/w/${id}/owner">Owner Account</a>.` : ''}</div>`
        : html`<div class="notice info">SarayDar's own management-fee account for this project. The client's construction spending is kept separately under <a href="/w/${id}/budget">Client Budget &amp; Payments</a> and is never counted here.</div>`}
      <section class="grid-cards" aria-label="Fee account">
        <div class="card"><div class="muted small">Invoiced (issued)</div><div class="big">${fm(L.t.invoiced)}</div><div class="muted small">Credited ${fm(L.t.credited)}</div></div>
        <div class="card"><div class="muted small">Collected (confirmed payments)</div><div class="big">${fm(L.t.collected)}</div><div class="muted small">${L.t.unapplied ? `Unapplied credit ${fm(L.t.unapplied)}` : 'All payments allocated'}</div></div>
        <div class="card"><div class="muted small">Outstanding</div><div class="big ${L.t.overdue.length ? 'err' : ''}">${fm(L.t.outstanding)}</div><div class="muted small">${L.t.overdue.length ? html`<span class="err">${L.t.overdue.length} overdue · ${fm(L.t.overdueAmount)}</span>` : 'Nothing overdue'}</div></div>
        <div class="card"><div class="muted small">Account balance</div><div class="big">${fm(L.t.balance)}</div><div class="muted small">${L.t.balance < 0 ? 'Credit in the client\'s favour' : 'Invoiced − credited − collected'} · <a href="/w/${id}/fees/statement">Statement</a></div></div>
      </section>
      ${a.ws.section === 'sales' ? '' : !act ? html`<div class="notice warn">No management-agreement terms are in force. <a href="/w/${id}/agreements">Record and activate them</a> before preparing monthly invoices.</div>`
        : act.tax_mode === 'not_configured' ? html`<div class="notice warn">Tax treatment is not configured in the terms. Drafts can be prepared, but invoices cannot be issued until it is set under <a href="/w/${id}/agreements">Client &amp; Agreement</a>.</div>` : ''}
      <section class="panel"><h2 class="h">Invoices</h2>
        ${L.invoices.length ? html`<div class="table-wrap"><table><thead><tr><th>Invoice</th><th>Period / description</th><th>Issued</th><th>Due</th><th class="n">Total</th><th class="n">Credited</th><th class="n">Paid</th><th class="n">Outstanding</th><th>Status</th></tr></thead><tbody>
          ${L.invoices.map(i => { const od = i.status === 'issued' && i.outstanding > 0 && i.due_date && iso(i.due_date) < L.today; return html`<tr>
            <td class="nowrap"><a href="/w/${id}/fees/invoices/${i.id}"><b>${i.number || 'Draft'}</b></a></td>
            <td class="small">${i.period_start ? `${fmtDate(i.period_start)} – ${fmtDate(i.period_end)}` : i.kind === 'commission' ? 'Brokerage fee' : 'Additional charges'}</td>
            <td class="small">${fmtDate(i.issue_date) || '—'}</td><td class="small ${od ? 'err' : ''}">${fmtDate(i.due_date) || '—'}</td>
            <td class="n">${fm(i.total, i.currency)}</td><td class="n">${i.credited ? fm(i.credited) : '—'}</td><td class="n">${i.allocated ? fm(i.allocated) : '—'}</td><td class="n">${i.status === 'issued' ? fm(i.outstanding) : '—'}</td>
            <td>${pill(od ? 'Overdue' : i.status === 'issued' && i.outstanding === 0 ? 'Paid' : i.status === 'issued' && i.allocated + i.credited > 0 ? 'Part paid' : i.status[0].toUpperCase() + i.status.slice(1), od ? 'bad' : i.status === 'issued' && i.outstanding === 0 ? 'ok' : INV_TONE[i.status])}</td></tr>`; })}</tbody></table></div>`
          : html`<p class="muted">No fee invoices yet.</p>`}
        ${edit && a.ws.section !== 'sales' ? html`<div class="split">
          <form method="post" action="/w/${id}/fees/drafts" class="panel-inner grow1">${csrfField(req)}<h3 class="h3">Prepare a monthly invoice draft</h3>
            <div class="form-grid">${field({ name: 'month', label: 'Billing month', options: monthsAround().map(m => [m, `${fees.monthOf(m).label}${billed.has(m) ? ' — already billed' : ''}`]), value: todayBH().slice(0, 7) })}
            <div class="actions full"><button class="btn primary" type="submit" ${act ? '' : raw('disabled')}>Prepare draft</button></div></div>
            <p class="muted small">Calculated from the terms in force for each day of the month. A month can be billed once; a draft can be discarded and an issued invoice voided or credited.</p></form>
          <form method="post" action="/w/${id}/fees/additional" class="panel-inner grow1">${csrfField(req)}<h3 class="h3">Draft an invoice for additional charges</h3>
            <div class="form-grid">${field({ name: 'description', label: 'Charge', required: true, hint: 'Only charges authorised by the agreement.' })}${field({ name: 'amount', label: 'Amount (BHD)', required: true, attrs: 'inputmode="decimal"' })}
            <div class="actions full"><button class="btn" type="submit" ${act ? '' : raw('disabled')}>Create draft</button></div></div></form>
        </div>` : ''}
      </section>
      <section class="panel"><h2 class="h">Client payments &amp; receipts</h2>
        ${L.payments.length ? html`<div class="table-wrap"><table><thead><tr><th>Received</th><th>Method / reference</th><th class="n">Amount</th><th class="n">Allocated</th><th class="n">Unapplied</th><th>Receipt</th><th>Status</th></tr></thead><tbody>
          ${L.payments.map(p => html`<tr><td><a href="/w/${id}/fees/payments/${p.id}">${fmtDate(p.received_on)}</a></td><td class="small">${p.method}${p.reference ? ` · ${p.reference}` : ''}</td>
            <td class="n">${fm(p.amount, p.currency)}</td><td class="n">${fm(p.allocated)}</td><td class="n">${p.unapplied ? fm(p.unapplied) : '—'}</td>
            <td class="small">${p.receipt_no ? html`<a href="/w/${id}/fees/payments/${p.id}/receipt.pdf">${p.receipt_no}</a>` : html`<span class="muted">Not issued</span>`}</td>
            <td>${pill(p.status === 'confirmed' ? 'Confirmed' : 'Reversed', p.status === 'confirmed' ? 'ok' : 'muted')}</td></tr>`)}</tbody></table></div>` : html`<p class="muted">No payments recorded.</p>`}
        ${a.canPost ? html`<details class="inline-form" ${req.query.pay ? raw('open') : ''}><summary>Record a confirmed client payment</summary>
          <form method="post" action="/w/${id}/fees/payments" class="form-grid">${csrfField(req)}<input type="hidden" name="idem" value="${idem}">
            ${field({ name: 'received_on', label: 'Received on', type: 'date', required: true, value: todayBH() })}${field({ name: 'amount', label: 'Amount (BHD)', required: true, attrs: 'inputmode="decimal"' })}
            ${field({ name: 'method', label: 'Method', options: METHODS.map(m => [m, m]) })}${field({ name: 'reference', label: 'Bank / cheque reference', hint: 'The same reference cannot be recorded twice.' })}
            ${field({ name: 'notes', label: 'Notes' })}
            ${open.length ? html`<fieldset class="full"><legend class="small">Allocate to invoices now (optional)</legend><div class="form-grid">
              ${open.map(i => field({ name: `alloc_${i.id}`, label: `${i.number} · outstanding ${fm(i.outstanding)}`, attrs: 'inputmode="decimal" placeholder="0"' }))}</div></fieldset>` : ''}
            <div class="actions full"><button class="btn primary" type="submit">Record payment</button></div>
            <p class="muted small full">Record only money confirmed received. Any part not allocated stays as unapplied credit. The receipt is issued as a separate step.</p></form></details>` : ''}
      </section>`));
  });

  async function newDraft(db, a, req, { kind, month, lines, notes }) {
    const all = await termsAll(a.ws.id, db);
    const terms = kind === 'monthly' ? month.terms : activeTerms(all);
    if (!terms) throw bad('No management-agreement terms are in force.');
    const tot = fees.totals(lines, terms.tax_mode, terms.tax_rate_bp);
    const inv = (await db.query(`insert into fee_invoices (workspace_id, party_id, kind, period_start, period_end, currency, subtotal_minor, tax_minor, total_minor, tax_mode, tax_rate_bp, tax_label, terms_id, notes, created_by)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning id`,
      [a.ws.id, a.ws.party_id, kind, month ? month.month.start : null, month ? month.month.end : null, terms.currency, tot.subtotal, tot.tax, tot.total, terms.tax_mode, terms.tax_rate_bp, terms.tax_label, terms.id, notes || null, req.user.id])).rows[0].id;
    let s = 0;
    for (const l of lines) await db.query('insert into fee_invoice_lines (invoice_id, kind, description, amount_minor, sort) values ($1,$2,$3,$4,$5)', [inv, l.kind, l.description, l.amount, s++]);
    return { id: inv, total: tot.total };
  }

  r.post('/w/:id/fees/drafts', async (req, res) => {
    const a = await finAccess(req, 'edit');
    const all = await termsAll(a.ws.id);
    const m = fees.monthlyLines(all, req.body.month);
    if (!m.lines.length) throw bad(m.reason);
    let id;
    try {
      id = await core.inTx(async db => {
        await db.query('select id from workspaces where id = $1 for update', [a.ws.id]);
        const d = await newDraft(db, a, req, { kind: 'monthly', month: m, lines: m.lines });
        await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'fee.draft_prepared', entity: 'fee_invoice', entityId: d.id, summary: `Fee invoice draft prepared for ${m.month.label}: ${formatMoney(d.total)}`, ip: req.ip });
        return d.id;
      });
    } catch (e) { if (e.code === '23505') throw bad(`${m.month.label} already has an invoice. Open it from the list, or void it first.`); throw e; }
    res.redirect(`/w/${a.ws.id}/fees/invoices/${id}?msg=created`);
  });

  r.post('/w/:id/fees/additional', async (req, res) => {
    const a = await finAccess(req, 'edit');
    const description = txt(req.body.description, 200); if (!description) throw bad('Describe the charge.');
    const amount = parseMoney(req.body.amount, 'BHD'); if (!amount || amount <= 0) throw bad('Enter the amount.');
    const id = await core.inTx(async db => {
      const d = await newDraft(db, a, req, { kind: 'additional', lines: [{ kind: 'additional', description, amount }] });
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'fee.draft_prepared', entity: 'fee_invoice', entityId: d.id, summary: `Additional-charge invoice draft: ${description} ${formatMoney(amount)}`, ip: req.ip });
      return d.id;
    });
    res.redirect(`/w/${a.ws.id}/fees/invoices/${id}?msg=created`);
  });

  async function invoiceFull(a, iid, db = pool) {
    const L = await ledger(a.ws.id, db);
    const i = L.invoices.find(x => x.id === iid);
    if (!i) throw new NotFound();
    i.lines = (await db.query('select * from fee_invoice_lines where invoice_id = $1 order by sort, id', [i.id])).rows.map(l => ({ ...l, amount: num(l.amount_minor) }));
    i.credits = (await db.query('select c.*, coalesce(nullif(u.name,\'\'), u.email) as by from fee_credit_notes c left join users u on u.id = c.created_by where c.invoice_id = $1 order by c.issued_on, c.created_at', [i.id])).rows;
    i.allocs = (await db.query('select x.*, p.received_on, p.receipt_no, p.method, p.reference from fee_allocations x join fee_payments p on p.id = x.payment_id where x.invoice_id = $1 order by x.created_at', [i.id])).rows;
    i.terms = i.terms_id ? (await db.query('select * from mgmt_terms where id = $1', [i.terms_id])).rows[0] : null;
    return { i, L };
  }

  r.get('/w/:id/fees/invoices/:iid', async (req, res) => {
    const a = await finAccess(req);
    if (!UUID.test(req.params.iid)) throw new NotFound();
    const { i, L } = await invoiceFull(a, req.params.iid);
    const edit = core.canEdit(a);
    const id = a.ws.id;
    const draft = i.status === 'draft';
    const tot = fees.totals(i.lines, i.tax_mode, i.tax_rate_bp);
    const terms = i.terms;
    const defaultIssue = todayBH();
    res.send(page(req, a, 'Fee Billing', html`<p><a href="/w/${id}/fees">‹ Fee Billing</a></p>
      <section class="panel"><div class="row-between"><h2 class="h">${i.number ? `Invoice ${i.number}` : 'Invoice draft'} ${pill(i.status, INV_TONE[i.status])}</h2>
        <a class="btn small" href="/w/${id}/fees/invoices/${i.id}/invoice.pdf">${draft ? 'Preview PDF' : 'PDF'}</a></div>
        <dl class="details">
          <div><dt>Type</dt><dd>${i.kind === 'monthly' ? 'Monthly management fee' : i.kind === 'commission' ? 'Brokerage fee (commission)' : 'Additional charges'}</dd></div>
          ${i.calc_note ? html`<div><dt>Calculation</dt><dd>${i.calc_note}</dd></div>` : ''}
          ${i.period_start ? html`<div><dt>Billing period</dt><dd>${fmtDate(i.period_start)} – ${fmtDate(i.period_end)}</dd></div>` : ''}
          <div><dt>Issue date</dt><dd>${fmtDate(i.issue_date) || '—'}</dd></div><div><dt>Due date</dt><dd>${fmtDate(i.due_date) || '—'}</dd></div>
          <div><dt>Terms used</dt><dd>${terms ? termLabel(terms) : '—'}</dd></div>
          <div><dt>Tax</dt><dd>${i.tax_mode === 'rate' ? `${i.tax_label || 'Tax'} ${fees.pctLabel(i.tax_rate_bp || 0)}` : i.tax_mode === 'none' ? 'No VAT charged' : html`<span class="err">Not configured</span>`}</dd></div>
          ${i.status === 'void' ? html`<div><dt>Voided</dt><dd>${fmtDateTime(i.voided_at)} · ${i.void_reason}</dd></div>` : ''}
        </dl>
        <div class="table-wrap"><table><thead><tr><th>Description</th><th class="n">Amount</th>${draft && edit ? html`<th></th>` : ''}</tr></thead><tbody>
          ${i.lines.map(l => html`<tr><td>${l.description}${l.kind !== 'fee' ? html` <span class="muted small">(${l.kind})</span>` : ''}</td><td class="n">${fm(l.amount, i.currency)}</td>
            ${draft && edit ? html`<td><form method="post" action="/w/${id}/fees/invoices/${i.id}/lines/${l.id}/delete">${csrfField(req)}<button class="btn small" type="submit">Remove</button></form></td>` : ''}</tr>`)}
          <tr><td>Subtotal</td><td class="n">${fm(draft ? tot.subtotal : num(i.subtotal_minor), i.currency)}</td>${draft && edit ? html`<td></td>` : ''}</tr>
          ${i.tax_mode === 'rate' ? html`<tr><td>${i.tax_label || 'Tax'} ${fees.pctLabel(i.tax_rate_bp || 0)}</td><td class="n">${fm(draft ? tot.tax : num(i.tax_minor), i.currency)}</td>${draft && edit ? html`<td></td>` : ''}</tr>` : ''}
          <tr class="total"><td>Total</td><td class="n">${fm(draft ? tot.total : i.total, i.currency)}</td>${draft && edit ? html`<td></td>` : ''}</tr>
          ${i.status === 'issued' ? html`<tr><td>Credited</td><td class="n">${fm(i.credited)}</td></tr><tr><td>Paid (allocated payments)</td><td class="n">${fm(i.allocated)}</td></tr><tr class="total"><td>Outstanding</td><td class="n">${fm(i.outstanding)}</td></tr>` : ''}
        </tbody></table></div>
        ${draft && edit ? html`<details class="inline-form"><summary>Add a line (authorised additional charge or adjustment)</summary><form method="post" action="/w/${id}/fees/invoices/${i.id}/lines" class="form-grid">${csrfField(req)}
          ${field({ name: 'kind', label: 'Type', options: [['additional', 'Additional charge'], ['adjustment', 'Adjustment (may be negative)']] })}${field({ name: 'description', label: 'Description', required: true })}
          ${field({ name: 'amount', label: 'Amount (BHD)', required: true, attrs: 'inputmode="decimal"' })}<div class="actions full"><button class="btn" type="submit">Add line</button></div></form></details>` : ''}
      </section>
      ${draft ? html`<section class="panel"><h2 class="h">Issue</h2>
        ${a.canPost ? html`<form method="post" action="/w/${id}/fees/invoices/${i.id}/issue" class="form-grid">${csrfField(req)}
          ${field({ name: 'issue_date', label: 'Issue date', type: 'date', required: true, value: defaultIssue })}
          <p class="small full muted">Due ${terms ? terms.payment_terms_days : 30} days after the issue date. Issuing assigns the next invoice number and freezes the invoice; corrections then need a credit note or a void.</p>
          ${i.kind === 'monthly' && terms && terms.billing_timing === 'arrears' && iso(i.period_end) >= todayBH() ? html`<p class="warn-text small full">This agreement bills in arrears and the period has not ended yet.</p>` : ''}
          <div class="actions full"><button class="btn primary" type="submit">Issue invoice</button></div></form>` : html`<p class="muted">Finance issues invoices.</p>`}
        ${edit ? html`<form method="post" action="/w/${id}/fees/invoices/${i.id}/discard" class="actions">${csrfField(req)}<button class="btn small" type="submit">Discard draft</button></form>` : ''}</section>` : ''}
      ${i.status === 'issued' ? html`<section class="panel"><h2 class="h">Payments allocated</h2>
          ${i.allocs.length ? html`<div class="table-wrap"><table><thead><tr><th>Payment received</th><th>Receipt</th><th class="n">Amount</th><th>Status</th></tr></thead><tbody>
            ${i.allocs.map(x => html`<tr><td><a href="/w/${id}/fees/payments/${x.payment_id}">${fmtDate(x.received_on)} · ${x.method}${x.reference ? ` ${x.reference}` : ''}</a></td><td>${x.receipt_no || '—'}</td><td class="n">${fm(num(x.amount_minor))}</td><td>${x.status === 'active' ? 'Applied' : html`<span class="muted">Reversed: ${x.reverse_reason}</span>`}</td></tr>`)}</tbody></table></div>`
            : html`<p class="muted">No payments allocated yet.</p>`}
          ${a.canPost && i.outstanding > 0 ? html`<p><a class="btn" href="/w/${id}/fees?pay=1">Record a payment</a></p>` : ''}</section>
        <section class="panel"><h2 class="h">Credit notes</h2>
          ${i.credits.length ? html`<ul class="rows">${i.credits.map(c => html`<li><div class="grow"><b>${c.number}</b> · ${fmtDate(c.issued_on)} · ${fm(num(c.amount_minor))}<div class="muted small">${c.reason} · ${c.by || ''}</div></div><a class="btn small" href="/w/${id}/fees/credits/${c.id}/credit.pdf">PDF</a></li>`)}</ul>` : html`<p class="muted">None.</p>`}
          ${a.canPost && i.outstanding > 0 ? html`<details class="inline-form"><summary>Issue a credit note</summary><form method="post" action="/w/${id}/fees/invoices/${i.id}/credit" class="form-grid">${csrfField(req)}
            ${field({ name: 'amount', label: `Amount (BHD, up to ${fm(i.outstanding)})`, required: true, attrs: 'inputmode="decimal"' })}${field({ name: 'issued_on', label: 'Date', type: 'date', required: true, value: todayBH() })}
            ${field({ name: 'reason', label: 'Reason', required: true, full: true })}<div class="actions full"><button class="btn" type="submit">Issue credit note</button></div></form></details>` : ''}
          ${a.canPost && !i.allocs.some(x => x.status === 'active') && !i.credits.length ? html`<details class="inline-form"><summary>Void this invoice</summary><form method="post" action="/w/${id}/fees/invoices/${i.id}/void" class="form-grid">${csrfField(req)}
            ${field({ name: 'reason', label: 'Reason', required: true, full: true })}<div class="actions full"><button class="btn" type="submit">Void invoice</button></div>
            <p class="muted small full">The invoice and its number are kept, marked void. For a monthly invoice the month can then be billed again.</p></form></details>` : ''}
        </section>` : ''}`));
  });

  r.post('/w/:id/fees/invoices/:iid/lines', async (req, res) => {
    const a = await finAccess(req, 'edit');
    const i = await own('fee_invoices', req.params.iid, a.ws.id);
    const description = txt(req.body.description, 200); if (!description) throw bad('Describe the line.');
    const kind = req.body.kind === 'adjustment' ? 'adjustment' : 'additional';
    const raw = String(req.body.amount || '').trim();
    const neg = kind === 'adjustment' && raw.startsWith('-');
    const amt = parseMoney(neg ? raw.slice(1) : raw, 'BHD');
    if (!amt || amt <= 0) throw bad('Enter the amount.');
    await core.inTx(async db => {
      const cur = (await db.query('select status from fee_invoices where id = $1 for update', [i.id])).rows[0];
      if (cur.status !== 'draft') throw bad('Only drafts can be changed.');
      const s = (await db.query('select coalesce(max(sort),0)+1 as s from fee_invoice_lines where invoice_id = $1', [i.id])).rows[0].s;
      await db.query('insert into fee_invoice_lines (invoice_id, kind, description, amount_minor, sort) values ($1,$2,$3,$4,$5)', [i.id, kind, description, neg ? -amt : amt, s]);
      await recalc(db, i.id);
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'fee.draft_line_added', entity: 'fee_invoice', entityId: i.id, summary: `Draft invoice line: ${description} ${formatMoney(neg ? -amt : amt)}`, ip: req.ip });
    });
    res.redirect(`/w/${a.ws.id}/fees/invoices/${i.id}?msg=saved`);
  });
  async function recalc(db, invId) {
    const inv = (await db.query('select * from fee_invoices where id = $1', [invId])).rows[0];
    const lines = (await db.query('select amount_minor from fee_invoice_lines where invoice_id = $1', [invId])).rows;
    const t = fees.totals(lines.map(l => ({ amount: num(l.amount_minor) })), inv.tax_mode, inv.tax_rate_bp);
    if (t.total < 0) throw bad('The invoice total cannot be negative. Use a credit note for refunds or reductions.');
    await db.query('update fee_invoices set subtotal_minor = $2, tax_minor = $3, total_minor = $4 where id = $1', [invId, t.subtotal, t.tax, t.total]);
    return t;
  }
  r.post('/w/:id/fees/invoices/:iid/lines/:lid/delete', async (req, res) => {
    const a = await finAccess(req, 'edit');
    const i = await own('fee_invoices', req.params.iid, a.ws.id);
    if (!UUID.test(req.params.lid)) throw new NotFound();
    await core.inTx(async db => {
      const cur = (await db.query('select status from fee_invoices where id = $1 for update', [i.id])).rows[0];
      if (cur.status !== 'draft') throw bad('Only drafts can be changed.');
      const n = (await db.query('delete from fee_invoice_lines where id = $1 and invoice_id = $2 returning description', [req.params.lid, i.id])).rows[0];
      if (!n) throw new NotFound();
      await recalc(db, i.id);
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'fee.draft_line_removed', entity: 'fee_invoice', entityId: i.id, summary: `Draft invoice line removed: ${n.description}`, ip: req.ip });
    });
    res.redirect(`/w/${a.ws.id}/fees/invoices/${i.id}?msg=saved`);
  });
  r.post('/w/:id/fees/invoices/:iid/discard', async (req, res) => {
    const a = await finAccess(req, 'edit');
    const i = await own('fee_invoices', req.params.iid, a.ws.id);
    await core.inTx(async db => {
      const n = (await db.query("delete from fee_invoices where id = $1 and status = 'draft' and number is null", [i.id])).rowCount;
      if (!n) throw bad('Only an unissued draft can be discarded.');
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'fee.draft_discarded', entity: 'fee_invoice', entityId: i.id, summary: `Fee invoice draft discarded (${formatMoney(num(i.total_minor))})`, ip: req.ip });
    });
    res.redirect(`/w/${a.ws.id}/fees?msg=saved`);
  });

  r.post('/w/:id/fees/invoices/:iid/issue', async (req, res) => {
    const a = await finAccess(req, 'post');
    const i0 = await own('fee_invoices', req.params.iid, a.ws.id);
    const issue = dateOrNull(req.body.issue_date); if (!issue) throw bad('Enter the issue date.');
    await core.inTx(async db => {
      const i = (await db.query('select * from fee_invoices where id = $1 for update', [i0.id])).rows[0];
      if (i.status !== 'draft') throw bad('This invoice has already been issued.');
      if (i.tax_mode === 'not_configured') throw bad('Tax treatment is not configured in the management-agreement terms used by this draft. Set it, then prepare the draft again.');
      if (!a.ws.party_id) throw bad('Link the project to a client before issuing invoices.');
      if (i.tax_mode === 'rate' && !(await db.query('select vat_number from company_profile where id = 1')).rows[0]?.vat_number) throw bad('Add SarayDar\'s VAT registration number under Admin › Agreements (company details) before issuing a VAT invoice.');
      const t = await recalc(db, i.id);
      if (t.total <= 0) throw bad('The invoice total must be more than zero.');
      const terms = i.terms_id ? (await db.query('select payment_terms_days from mgmt_terms where id = $1', [i.terms_id])).rows[0] : i.mandate_id ? (await db.query('select payment_terms_days from sale_mandates where id = $1', [i.mandate_id])).rows[0] : null;
      const due = fees.addDays(issue, terms ? terms.payment_terms_days : 30);
      const year = issue.slice(0, 4);
      const number = `INV-${year}-${String(await core.nextNumber(db, `INV-${year}`)).padStart(4, '0')}`;
      await db.query("update fee_invoices set status = 'issued', number = $2, issue_date = $3, due_date = $4, party_id = $5, issued_by = $6, issued_at = now() where id = $1", [i.id, number, issue, due, a.ws.party_id, req.user.id]);
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'fee.invoice_issued', entity: 'fee_invoice', entityId: i.id, summary: `Fee invoice ${number} issued: ${formatMoney(t.total)}, due ${due}`, after: { number, total: t.total, issue, due }, ip: req.ip });
      await touch(db, a.ws.id);
    });
    res.redirect(`/w/${a.ws.id}/fees/invoices/${i0.id}?msg=saved`);
  });

  r.post('/w/:id/fees/invoices/:iid/void', async (req, res) => {
    const a = await finAccess(req, 'post');
    const i0 = await own('fee_invoices', req.params.iid, a.ws.id);
    const reason = txt(req.body.reason, 300); if (!reason) throw bad('Give a reason.');
    await core.inTx(async db => {
      const i = (await db.query('select * from fee_invoices where id = $1 for update', [i0.id])).rows[0];
      if (i.status !== 'issued') throw bad('Only an issued invoice can be voided.');
      const used = (await db.query("select (select count(*) from fee_allocations where invoice_id = $1 and status = 'active') + (select count(*) from fee_credit_notes where invoice_id = $1) as n", [i.id])).rows[0].n;
      if (Number(used)) throw bad('This invoice has payments or credit notes. Reverse the allocations instead, or issue a credit note for the balance.');
      await db.query("update fee_invoices set status = 'void', voided_by = $2, voided_at = now(), void_reason = $3 where id = $1", [i.id, req.user.id, reason]);
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'fee.invoice_voided', entity: 'fee_invoice', entityId: i.id, summary: `Fee invoice ${i.number} voided: ${reason}`, ip: req.ip });
    });
    res.redirect(`/w/${a.ws.id}/fees/invoices/${i0.id}?msg=saved`);
  });

  r.post('/w/:id/fees/invoices/:iid/credit', async (req, res) => {
    const a = await finAccess(req, 'post');
    const i0 = await own('fee_invoices', req.params.iid, a.ws.id);
    const amount = parseMoney(req.body.amount, 'BHD'); if (!amount || amount <= 0) throw bad('Enter the credit amount.');
    const reason = txt(req.body.reason, 300); if (!reason) throw bad('Give a reason.');
    const on = dateOrNull(req.body.issued_on) || todayBH();
    await core.inTx(async db => {
      await db.query('select id from fee_invoices where id = $1 for update', [i0.id]);
      const { i } = await invoiceFull(a, i0.id, db);
      if (i.status !== 'issued') throw bad('Credit notes apply to issued invoices.');
      if (amount > i.outstanding) throw bad(`The credit is more than the outstanding ${formatMoney(i.outstanding)}.`);
      const year = on.slice(0, 4);
      const number = `CN-${year}-${String(await core.nextNumber(db, `CN-${year}`)).padStart(4, '0')}`;
      const id = (await db.query('insert into fee_credit_notes (workspace_id, invoice_id, number, issued_on, amount_minor, reason, created_by) values ($1,$2,$3,$4,$5,$6,$7) returning id', [a.ws.id, i.id, number, on, amount, reason, req.user.id])).rows[0].id;
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'fee.credit_note_issued', entity: 'fee_credit_note', entityId: id, summary: `Credit note ${number} on ${i.number}: ${formatMoney(amount)} — ${reason}`, ip: req.ip });
    });
    res.redirect(`/w/${a.ws.id}/fees/invoices/${i0.id}?msg=saved`);
  });

  // ---------- payments, allocations, receipts ----------
  async function allocate(db, a, req, payId, invId, amount) {
    const p = (await db.query('select * from fee_payments where id = $1 and workspace_id = $2 for update', [payId, a.ws.id])).rows[0];
    const inv = (await db.query('select * from fee_invoices where id = $1 and workspace_id = $2 for update', [invId, a.ws.id])).rows[0];
    if (!p || !inv) throw new NotFound();
    if (p.status !== 'confirmed') throw bad('That payment has been reversed.');
    if (inv.status !== 'issued') throw bad('Payments can only be allocated to issued invoices.');
    const pAlloc = num((await db.query("select coalesce(sum(amount_minor),0) as s from fee_allocations where payment_id = $1 and status = 'active'", [p.id])).rows[0].s);
    const iUsed = num((await db.query("select coalesce((select sum(amount_minor) from fee_allocations where invoice_id = $1 and status = 'active'),0) + coalesce((select sum(amount_minor) from fee_credit_notes where invoice_id = $1),0) as s", [inv.id])).rows[0].s);
    const unapplied = num(p.amount_minor) - pAlloc, outstanding = num(inv.total_minor) - iUsed;
    if (amount > unapplied) throw bad(`Only ${formatMoney(unapplied)} of this payment is unallocated.`);
    if (amount > outstanding) throw bad(`Invoice ${inv.number} has only ${formatMoney(outstanding)} outstanding.`);
    const id = (await db.query('insert into fee_allocations (payment_id, invoice_id, amount_minor, created_by) values ($1,$2,$3,$4) returning id', [p.id, inv.id, amount, req.user.id])).rows[0].id;
    await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'fee.payment_allocated', entity: 'fee_allocation', entityId: id, summary: `${formatMoney(amount)} allocated to ${inv.number}`, ip: req.ip });
  }

  r.post('/w/:id/fees/payments', async (req, res) => {
    const a = await finAccess(req, 'post');
    const received = dateOrNull(req.body.received_on); if (!received) throw bad('Enter the date the payment was received.');
    if (received > todayBH()) throw bad('The received date cannot be in the future.');
    const amount = parseMoney(req.body.amount, 'BHD'); if (!amount || amount <= 0) throw bad('Enter the amount received.');
    const method = METHODS.includes(req.body.method) ? req.body.method : 'Other';
    const allocs = Object.entries(req.body).filter(([k, v]) => /^alloc_[0-9a-f-]{36}$/i.test(k) && String(v).trim()).map(([k, v]) => [k.slice(6), parseMoney(v, 'BHD')]);
    if (allocs.some(([, v]) => v === null || v < 0)) throw bad('Allocation amounts must be positive.');
    if (allocs.reduce((s, [, v]) => s + v, 0) > amount) throw bad('The allocations add up to more than the payment.');
    const idem = /^[0-9a-f]{24}$/.test(req.body.idem || '') ? req.body.idem : null;
    let pid;
    try {
      pid = await core.inTx(async db => {
        if (idem) { const ex = (await db.query('select id from fee_payments where idem_key = $1', [idem])).rows[0]; if (ex) return ex.id; }
        const id = (await db.query('insert into fee_payments (workspace_id, party_id, received_on, amount_minor, method, reference, notes, idem_key, recorded_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id',
          [a.ws.id, a.ws.party_id, received, amount, method, txt(req.body.reference, 80), txt(req.body.notes, 300), idem, req.user.id])).rows[0].id;
        await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'fee.payment_recorded', entity: 'fee_payment', entityId: id, summary: `Client fee payment recorded: ${formatMoney(amount)} received ${received} (${method})`, ip: req.ip });
        for (const [inv, v] of allocs) if (v > 0) await allocate(db, a, req, id, inv, v);
        await touch(db, a.ws.id);
        return id;
      });
    } catch (e) { if (e.code === '23505') throw bad('A payment with that method and reference is already recorded for this project.'); throw e; }
    res.redirect(`/w/${a.ws.id}/fees/payments/${pid}?msg=saved`);
  });

  async function paymentFull(a, pid) {
    if (!UUID.test(pid)) throw new NotFound();
    const L = await ledger(a.ws.id);
    const p = L.payments.find(x => x.id === pid);
    if (!p) throw new NotFound();
    p.allocs = (await pool.query('select x.*, i.number, i.period_start, i.period_end from fee_allocations x join fee_invoices i on i.id = x.invoice_id where x.payment_id = $1 order by x.created_at', [p.id])).rows;
    return { p, L };
  }
  r.get('/w/:id/fees/payments/:pid', async (req, res) => {
    const a = await finAccess(req);
    const { p, L } = await paymentFull(a, req.params.pid);
    const id = a.ws.id;
    const open = L.invoices.filter(i => i.status === 'issued' && i.outstanding > 0);
    res.send(page(req, a, 'Fee Billing', html`<p><a href="/w/${id}/fees">‹ Fee Billing</a></p>
      <section class="panel"><div class="row-between"><h2 class="h">Client payment ${pill(p.status === 'confirmed' ? 'Confirmed' : 'Reversed', p.status === 'confirmed' ? 'ok' : 'muted')}</h2>
        ${p.receipt_no ? html`<a class="btn small" href="/w/${id}/fees/payments/${p.id}/receipt.pdf">Receipt ${p.receipt_no} (PDF)</a>` : ''}</div>
        <dl class="details"><div><dt>Received on</dt><dd>${fmtDate(p.received_on)}</dd></div><div><dt>Amount</dt><dd>${fm(p.amount, p.currency)}</dd></div>
          <div><dt>Method</dt><dd>${p.method}</dd></div><div><dt>Reference</dt><dd>${p.reference || '—'}</dd></div>
          <div><dt>Allocated</dt><dd>${fm(p.allocated)}</dd></div><div><dt>Unapplied credit</dt><dd>${fm(p.unapplied)}</dd></div>
          <div><dt>Recorded</dt><dd>${fmtDateTime(p.recorded_at)}</dd></div>
          <div><dt>Receipt</dt><dd>${p.receipt_no ? `${p.receipt_no} · issued ${fmtDateTime(p.receipt_issued_at)}` : 'Not issued yet'}</dd></div>
          ${p.status === 'reversed' ? html`<div><dt>Reversed</dt><dd>${fmtDateTime(p.reversed_at)} · ${p.reverse_reason}</dd></div>` : ''}
          ${p.notes ? html`<div><dt>Notes</dt><dd>${p.notes}</dd></div>` : ''}</dl></section>
      <section class="panel"><h2 class="h">Allocations</h2>
        ${p.allocs.length ? html`<div class="table-wrap"><table><thead><tr><th>Invoice</th><th>Period</th><th class="n">Amount</th><th>Status</th><th></th></tr></thead><tbody>
          ${p.allocs.map(x => html`<tr><td><a href="/w/${id}/fees/invoices/${x.invoice_id}">${x.number}</a></td><td class="small">${x.period_start ? `${fmtDate(x.period_start)} – ${fmtDate(x.period_end)}` : '—'}</td><td class="n">${fm(num(x.amount_minor))}</td>
            <td>${x.status === 'active' ? 'Applied' : html`<span class="muted">Reversed: ${x.reverse_reason}</span>`}</td>
            <td>${a.canPost && x.status === 'active' ? html`<form method="post" action="/w/${id}/fees/allocations/${x.id}/reverse" class="actions">${csrfField(req)}<input name="reason" aria-label="Reason" placeholder="Reason" required><button class="btn small" type="submit">Reverse</button></form>` : ''}</td></tr>`)}</tbody></table></div>`
          : html`<p class="muted">Not allocated to any invoice.</p>`}
        ${a.canPost && p.status === 'confirmed' && p.unapplied > 0 && open.length ? html`<form method="post" action="/w/${id}/fees/payments/${p.id}/allocate" class="form-grid">${csrfField(req)}
          ${field({ name: 'invoice_id', label: 'Invoice', options: open.map(i => [i.id, `${i.number} · outstanding ${fm(i.outstanding)}`]) })}
          ${field({ name: 'amount', label: `Amount (up to ${fm(p.unapplied)})`, required: true, attrs: 'inputmode="decimal"' })}
          <div class="actions full"><button class="btn" type="submit">Allocate</button></div></form>` : ''}
      </section>
      ${a.canPost && p.status === 'confirmed' ? html`<section class="panel"><h2 class="h">Receipt and corrections</h2>
        ${!p.receipt_no ? html`<form method="post" action="/w/${id}/fees/payments/${p.id}/receipt" class="actions">${csrfField(req)}<button class="btn primary" type="submit">Issue receipt</button>
          <span class="muted small">Assigns the next receipt number. A receipt acknowledges this confirmed payment; it lists the invoices it was applied to.</span></form>` : ''}
        <details class="inline-form"><summary>Reverse this payment</summary><form method="post" action="/w/${id}/fees/payments/${p.id}/reverse" class="form-grid">${csrfField(req)}
          ${field({ name: 'reason', label: 'Reason (for example cheque returned)', required: true, full: true })}<div class="actions full"><button class="btn" type="submit">Reverse payment</button></div>
          <p class="muted small full">The payment, its allocations and any receipt are kept and marked reversed; the invoices become outstanding again.</p></form></details></section>` : ''}`));
  });

  r.post('/w/:id/fees/payments/:pid/allocate', async (req, res) => {
    const a = await finAccess(req, 'post');
    const p = await own('fee_payments', req.params.pid, a.ws.id);
    if (!UUID.test(req.body.invoice_id || '')) throw bad('Choose an invoice.');
    const amount = parseMoney(req.body.amount, 'BHD'); if (!amount || amount <= 0) throw bad('Enter the amount.');
    await core.inTx(async db => { await allocate(db, a, req, p.id, req.body.invoice_id, amount); });
    res.redirect(`/w/${a.ws.id}/fees/payments/${p.id}?msg=saved`);
  });

  r.post('/w/:id/fees/allocations/:aid/reverse', async (req, res) => {
    const a = await finAccess(req, 'post');
    if (!UUID.test(req.params.aid)) throw new NotFound();
    const reason = txt(req.body.reason, 300); if (!reason) throw bad('Give a reason.');
    const x = (await pool.query('select x.*, i.number from fee_allocations x join fee_invoices i on i.id = x.invoice_id where x.id = $1 and i.workspace_id = $2', [req.params.aid, a.ws.id])).rows[0];
    if (!x) throw new NotFound();
    await core.inTx(async db => {
      const n = (await db.query("update fee_allocations set status = 'reversed', reversed_by = $2, reversed_at = now(), reverse_reason = $3 where id = $1 and status = 'active'", [x.id, req.user.id, reason])).rowCount;
      if (!n) throw bad('This allocation is already reversed.');
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'fee.allocation_reversed', entity: 'fee_allocation', entityId: x.id, summary: `Allocation of ${formatMoney(num(x.amount_minor))} to ${x.number} reversed: ${reason}`, ip: req.ip });
    });
    res.redirect(`/w/${a.ws.id}/fees/payments/${x.payment_id}?msg=saved`);
  });

  r.post('/w/:id/fees/payments/:pid/receipt', async (req, res) => {
    const a = await finAccess(req, 'post');
    const p = await own('fee_payments', req.params.pid, a.ws.id);
    await core.inTx(async db => {
      const cur = (await db.query('select * from fee_payments where id = $1 for update', [p.id])).rows[0];
      if (cur.status !== 'confirmed') throw bad('A reversed payment cannot get a receipt.');
      if (cur.receipt_no) throw bad(`Receipt ${cur.receipt_no} has already been issued.`);
      const year = iso(cur.received_on).slice(0, 4);
      const no = `RCT-${year}-${String(await core.nextNumber(db, `RCT-${year}`)).padStart(4, '0')}`;
      await db.query('update fee_payments set receipt_no = $2, receipt_issued_by = $3, receipt_issued_at = now() where id = $1', [p.id, no, req.user.id]);
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'fee.receipt_issued', entity: 'fee_payment', entityId: p.id, summary: `Receipt ${no} issued for ${formatMoney(num(cur.amount_minor))}`, ip: req.ip });
    });
    res.redirect(`/w/${a.ws.id}/fees/payments/${p.id}?msg=saved`);
  });

  r.post('/w/:id/fees/payments/:pid/reverse', async (req, res) => {
    const a = await finAccess(req, 'post');
    const p = await own('fee_payments', req.params.pid, a.ws.id);
    const reason = txt(req.body.reason, 300); if (!reason) throw bad('Give a reason.');
    await core.inTx(async db => {
      const n = (await db.query("update fee_payments set status = 'reversed', reversed_by = $2, reversed_at = now(), reverse_reason = $3 where id = $1 and status = 'confirmed'", [p.id, req.user.id, reason])).rowCount;
      if (!n) throw bad('This payment is already reversed.');
      await db.query("update fee_allocations set status = 'reversed', reversed_by = $2, reversed_at = now(), reverse_reason = $3 where payment_id = $1 and status = 'active'", [p.id, req.user.id, `Payment reversed: ${reason}`]);
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'fee.payment_reversed', entity: 'fee_payment', entityId: p.id, summary: `Client fee payment of ${formatMoney(num(p.amount_minor))} reversed: ${reason}`, ip: req.ip });
    });
    res.redirect(`/w/${a.ws.id}/fees/payments/${p.id}?msg=saved`);
  });

  // ---------- statement ----------
  async function statementRows(wsIds, from, to) {
    const ev = [];
    for (const wsId of wsIds) {
      const ws = (await pool.query('select id, ref, name from workspaces where id = $1', [wsId])).rows[0];
      const inv = (await pool.query("select * from fee_invoices where workspace_id = $1 and number is not null", [wsId])).rows;
      for (const i of inv) {
        ev.push({ date: iso(i.issue_date), at: i.issued_at, ws, doc: i.number, text: i.period_start ? `Invoice — management fee ${fmtDate(i.period_start)} – ${fmtDate(i.period_end)}` : i.kind === 'commission' ? 'Invoice — brokerage fee' : 'Invoice — additional charges', debit: num(i.total_minor), credit: 0 });
        if (i.status === 'void') ev.push({ date: bhDay(i.voided_at), at: i.voided_at, ws, doc: i.number, text: `Invoice voided: ${i.void_reason}`, debit: 0, credit: num(i.total_minor) });
      }
      for (const c of (await pool.query('select c.*, i.number as inv from fee_credit_notes c join fee_invoices i on i.id = c.invoice_id where c.workspace_id = $1', [wsId])).rows)
        ev.push({ date: iso(c.issued_on), at: c.created_at, ws, doc: c.number, text: `Credit note on ${c.inv}: ${c.reason}`, debit: 0, credit: num(c.amount_minor) });
      for (const p of (await pool.query('select * from fee_payments where workspace_id = $1', [wsId])).rows) {
        ev.push({ date: iso(p.received_on), at: p.recorded_at, ws, doc: p.receipt_no || 'Payment', text: `Payment received — ${p.method}${p.reference ? ` ${p.reference}` : ''}`, debit: 0, credit: num(p.amount_minor) });
        if (p.status === 'reversed') ev.push({ date: bhDay(p.reversed_at), at: p.reversed_at, ws, doc: p.receipt_no || 'Payment', text: `Payment reversed: ${p.reverse_reason}`, debit: num(p.amount_minor), credit: 0 });
      }
    }
    ev.sort((x, y) => x.date.localeCompare(y.date) || new Date(x.at) - new Date(y.at));
    let opening = 0; const rows = []; let bal = 0;
    for (const e of ev) {
      if (from && e.date < from) { opening += e.debit - e.credit; continue; }
      if (to && e.date > to) continue;
      rows.push(e);
    }
    bal = opening;
    for (const e of rows) { bal += e.debit - e.credit; e.balance = bal; }
    return { opening, rows, closing: bal, debits: rows.reduce((s, e) => s + e.debit, 0), credits: rows.reduce((s, e) => s + e.credit, 0) };
  }
  ctx.feeStatement = statementRows;
  const period = q => {
    const from = dateOrNull(q.from), to = dateOrNull(q.to);
    if (from && to && to < from) throw bad('The end date is before the start date.');
    return { from, to, label: from || to ? `${from ? fmtDate(from) : 'Start'} – ${to ? fmtDate(to) : fmtDate(todayBH())}` : `All dates to ${fmtDate(todayBH())}` };
  };
  const statementTable = (st, multi) => html`<div class="table-wrap"><table><thead><tr><th>Date</th>${multi ? html`<th>Project</th>` : ''}<th>Document</th><th>Details</th><th class="n">Debit</th><th class="n">Credit</th><th class="n">Balance</th></tr></thead><tbody>
    <tr><td></td>${multi ? html`<td></td>` : ''}<td></td><td><b>Opening balance</b></td><td></td><td></td><td class="n">${fm(st.opening)}</td></tr>
    ${st.rows.map(e => html`<tr><td class="small">${fmtDate(e.date)}</td>${multi ? html`<td class="small">${e.ws.ref}</td>` : ''}<td class="mono small">${e.doc}</td><td class="small">${e.text}</td><td class="n">${e.debit ? fm(e.debit) : ''}</td><td class="n">${e.credit ? fm(e.credit) : ''}</td><td class="n">${fm(e.balance)}</td></tr>`)}
    <tr class="total"><td></td>${multi ? html`<td></td>` : ''}<td></td><td>Closing balance</td><td class="n">${fm(st.debits)}</td><td class="n">${fm(st.credits)}</td><td class="n">${fm(st.closing)}</td></tr></tbody></table></div>`;

  r.get('/w/:id/fees/statement', async (req, res) => {
    const a = await finAccess(req);
    const per = period(req.query);
    const st = await statementRows([a.ws.id], per.from, per.to);
    const L = await ledger(a.ws.id);
    const q = new URLSearchParams({ ...(per.from ? { from: per.from } : {}), ...(per.to ? { to: per.to } : {}) });
    res.send(page(req, a, 'Fee Billing', html`<p><a href="/w/${a.ws.id}/fees">‹ Fee Billing</a></p>
      <form class="filters" method="get"><label class="small">From <input type="date" name="from" value="${per.from || ''}"></label><label class="small">To <input type="date" name="to" value="${per.to || ''}"></label>
        <button class="btn" type="submit">Apply</button><span class="grow"></span><a class="btn" href="/w/${a.ws.id}/fees/statement.pdf?${q}">Statement PDF for the client</a></form>
      <section class="panel"><h2 class="h">Statement of account · ${per.label}</h2>${statementTable(st, false)}
        <p class="muted small">Positive balance: owed by the client. Negative: credit in the client's favour. Unapplied payments at today: ${fm(L.t.unapplied)}. Only SarayDar fee documents appear here; construction spending is excluded.</p></section>`));
  });

  // ---------- PDFs ----------
  async function docBase(a) {
    const co = await company();
    const client = await clientOf(a.ws);
    const to = client ? [client.billing_name || client.name, client.billing_address || client.address, client.billing_email || client.email, client.tax_number ? `Tax no. ${client.tax_number}` : null] : ['Client not linked'];
    return { company: co, letterhead: co.letterhead || null, marginTop: co.margin_top_mm, marginBottom: co.margin_bottom_mm, to, client };
  }
  const sendPdf = (res, buf, parts) => { res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': DL.disposition(DL.fileName(parts, 'pdf'), res.req.query.view === '1'), 'Cache-Control': 'private, no-store' }); res.end(buf); };

  // The fee documents as PDFs. Staff open them from Fee Billing; the client opens issued ones from the portal
  // (ctx.feePdfs, used by external.js). Each returns the file and the parts of its download name.
  async function invoicePdf(a, iid) {
    if (!UUID.test(String(iid))) throw new NotFound();
    const { i } = await invoiceFull(a, iid);
    const b = await docBase(a);
    const draft = i.status === 'draft';
    const t = draft ? fees.totals(i.lines, i.tax_mode, i.tax_rate_bp) : { subtotal: num(i.subtotal_minor), tax: num(i.tax_minor), total: i.total };
    const buf = await docs.render({ ...b, title: i.tax_mode === 'rate' ? 'Tax invoice' : 'Invoice', number: i.number, stamp: draft ? 'DRAFT — NOT ISSUED' : i.status === 'void' ? 'VOID' : null,
      meta: [...(i.tax_mode === 'rate' && b.company.vat_number ? [['VAT no.', b.company.vat_number]] : []), ['Issue date', fmtDate(i.issue_date) || '—'], ['Due date', fmtDate(i.due_date) || '—'], ['Project', `${a.ws.ref}`], ['', a.ws.name], ...(i.period_start ? [['Period', `${fmtDate(i.period_start)} – ${fmtDate(i.period_end)}`]] : []), ['Currency', i.currency]],
      tables: [{ head: ['Description', 'Amount'], widths: [0.75, 0.25], align: ['left', 'right'], rows: i.lines.map(l => [l.description, docs.money(l.amount, i.currency)]) }],
      totals: [['Subtotal', docs.money(t.subtotal, i.currency)], ...(i.tax_mode === 'rate' ? [[`${i.tax_label || 'Tax'} ${fees.pctLabel(i.tax_rate_bp || 0)}`, docs.money(t.tax, i.currency)]] : []), ['Total due', docs.money(t.total, i.currency), true],
        ...(i.status === 'issued' && (i.credited || i.allocated) ? [['Credited', docs.money(i.credited)], ['Paid', docs.money(i.allocated)], ['Outstanding', docs.money(i.outstanding), true]] : [])],
      notes: [i.kind === 'commission' ? `This invoice requests payment of SarayDar's brokerage fee under the mandate. ${i.calc_note || ''} The property price is not part of this invoice. It is not a receipt.` : 'This invoice requests payment of SarayDar\'s management fee under the management agreement. It is not a receipt.', i.tax_mode === 'none' ? 'No VAT has been charged on this fee.' : null, b.company.legal_name ? `${b.company.legal_name}${b.company.cr_number ? ` · CR ${b.company.cr_number}` : ''}${i.tax_mode === 'rate' && b.company.vat_number ? ` · VAT registration ${b.company.vat_number}` : ''}` : null] });
    return { buf, doc: i, parts: i.number ? [i.number, a.ws.name] : ['DRAFT invoice', a.ws.ref, a.ws.name] };
  }
  async function receiptPdf(a, pid) {
    const { p } = await paymentFull(a, pid);
    if (!p.receipt_no) throw new NotFound();
    const b = await docBase(a);
    const allocs = p.allocs.filter(x => x.status === 'active');
    const buf = await docs.render({ ...b, title: 'Payment receipt', number: p.receipt_no, stamp: p.status === 'reversed' ? 'REVERSED' : null,
      meta: [['Payment date', fmtDate(p.received_on)], ['Receipt issued', fmtDate(p.receipt_issued_at)], ['Method', p.method], ['Reference', p.reference || '—'], ['Project', a.ws.ref], ['', a.ws.name]],
      tables: [{ caption: 'Applied to', head: ['Invoice', 'Period', 'Amount'], widths: [0.3, 0.45, 0.25], align: ['left', 'left', 'right'], empty: 'Not yet applied to an invoice',
        rows: allocs.map(x => [x.number, x.period_start ? `${fmtDate(x.period_start)} – ${fmtDate(x.period_end)}` : 'Additional charges', docs.money(num(x.amount_minor))]) }],
      totals: [['Amount received', docs.money(p.amount, p.currency), true], ['Applied to invoices', docs.money(allocs.reduce((s, x) => s + num(x.amount_minor), 0))], ['Unapplied credit', docs.money(p.status === 'confirmed' ? p.unapplied : 0)]],
      notes: [`Received with thanks from ${b.client ? b.client.name : 'the client'}. This receipt acknowledges a confirmed payment recorded by SarayDar.`, p.status === 'reversed' ? `This payment was reversed on ${fmtDate(p.reversed_at)}: ${p.reverse_reason}` : null] });
    return { buf, doc: p, parts: [p.receipt_no, a.ws.name] };
  }
  async function creditPdf(a, cid) {
    const c = await own('fee_credit_notes', cid, a.ws.id);
    const inv = (await pool.query('select number, status, party_id from fee_invoices where id = $1', [c.invoice_id])).rows[0];
    const b = await docBase(a);
    const buf = await docs.render({ ...b, title: 'Credit note', number: c.number, meta: [['Date', fmtDate(c.issued_on)], ['Against invoice', inv.number], ['Project', a.ws.ref], ['', a.ws.name]],
      tables: [{ head: ['Reason', 'Amount'], widths: [0.75, 0.25], align: ['left', 'right'], rows: [[c.reason, docs.money(num(c.amount_minor))]] }],
      totals: [['Credit', docs.money(num(c.amount_minor)), true]], notes: ['This credit note reduces the amount due on the invoice shown.'] });
    return { buf, doc: { ...c, invoice: inv }, parts: [c.number, a.ws.name] };
  }
  async function statementPdf(a, query) {
    const per = period(query);
    const st = await statementRows([a.ws.id], per.from, per.to);
    const b = await docBase(a);
    const nb = m => docs.money(m).replace(/^BHD /, '');     // currency is stated once in the heading
    const buf = await docs.render({ ...b, title: 'Statement of account', number: `${a.ws.ref}`, meta: [['Period', per.label], ['Project', a.ws.name], ['Currency', 'BHD']],
      tables: [{ head: ['Date', 'Document', 'Details', 'Debit (BHD)', 'Credit (BHD)', 'Balance (BHD)'], widths: [0.12, 0.15, 0.34, 0.13, 0.13, 0.13], align: ['left', 'left', 'left', 'right', 'right', 'right'],
        rows: [Object.assign(['', '', 'Opening balance', '', '', nb(st.opening)], { bold: true }), ...st.rows.map(e => [fmtDate(e.date), e.doc, e.text, e.debit ? nb(e.debit) : '', e.credit ? nb(e.credit) : '', nb(e.balance)])] }],
      totals: [['Total debits', docs.money(st.debits)], ['Total credits', docs.money(st.credits)], ['Closing balance', docs.money(st.closing), true]],
      notes: ['Positive balance: amount due to SarayDar. Negative balance: credit in your favour.', 'Covers SarayDar management-fee documents only.'] });
    return { buf, per, parts: [a.ws.ref, a.ws.name, 'Statement', DL.today()] };
  }
  ctx.feePdfs = { invoice: invoicePdf, receipt: receiptPdf, credit: creditPdf, statement: statementPdf, send: sendPdf };

  r.get('/w/:id/fees/invoices/:iid/invoice.pdf', async (req, res) => {
    const a = await finAccess(req);
    const { buf, doc: i, parts } = await invoicePdf(a, req.params.iid);
    await core.audit(null, { actor: req.user, workspaceId: a.ws.id, action: 'fee.invoice_pdf', entity: 'fee_invoice', entityId: i.id, summary: `Invoice PDF downloaded: ${i.number || 'draft'}`, ip: req.ip });
    sendPdf(res, buf, parts);
  });

  r.get('/w/:id/fees/payments/:pid/receipt.pdf', async (req, res) => {
    const a = await finAccess(req);
    const { buf, doc: p, parts } = await receiptPdf(a, req.params.pid);
    await core.audit(null, { actor: req.user, workspaceId: a.ws.id, action: 'fee.receipt_pdf', entity: 'fee_payment', entityId: p.id, summary: `Receipt PDF downloaded: ${p.receipt_no}`, ip: req.ip });
    sendPdf(res, buf, parts);
  });

  r.get('/w/:id/fees/credits/:cid/credit.pdf', async (req, res) => {
    const a = await finAccess(req);
    const { buf, parts } = await creditPdf(a, req.params.cid);
    sendPdf(res, buf, parts);
  });

  r.get('/w/:id/fees/statement.pdf', async (req, res) => {
    const a = await finAccess(req);
    const { buf, per, parts } = await statementPdf(a, req.query);
    await core.audit(null, { actor: req.user, workspaceId: a.ws.id, action: 'fee.statement_pdf', entity: 'workspace', entityId: a.ws.id, summary: `Fee statement PDF: ${per.label}`, ip: req.ip });
    sendPdf(res, buf, parts);
  });

  // ---------- client approvals ----------
  r.get('/w/:id/approvals', async (req, res) => {
    const a = cpmOnly(await access(req));
    const rows = (await pool.query(`select c.*, coalesce(nullif(u.name,''), u.email) as recorder,
        (select array_agg(json_build_object('id', f.id, 'name', f.original_name, 'tag', f.tag, 'mime', f.mime) order by f.uploaded_at) from files f where f.entity = 'client_approval' and f.entity_id = c.id::text and f.archived_at is null) as evidence,
        coalesce(nullif(ru.name,''), ru.email) as responder
      from client_approvals c left join users u on u.id = coalesce(c.decided_by, c.created_by) left join users ru on ru.id = c.responded_by where c.workspace_id = $1 order by (c.status = 'requested') desc, c.requested_on desc, c.created_at desc`, [a.ws.id])).rows;
    const edit = core.canContribute(a);
    const id = a.ws.id;
    const client = await clientOf(a.ws);
    const terms = activeTerms(await termsAll(a.ws.id));
    res.send(page(req, a, 'Client Approvals', html`
      <p class="muted">Requests shared with the client appear in their portal, where they approve or reject them with a comment (they are emailed when a request is added). Approvals given outside the system (signed letters, emails, meeting minutes) are recorded here by staff with the evidence.${client && AG.approversOf(client).length ? html` Authorised approvers: <b>${AG.approversOf(client).join(', ')}</b>.` : ''}</p>
      <section class="panel"><h2 class="h">Approvals</h2>
        ${rows.length ? html`<div class="ap-list">${rows.map(c => html`<article class="ap-card st-${c.status}" id="a-${c.id}">
          <div class="ap-head"><div class="ap-title"><span class="ap-subj">${SUBJECTS[c.subject]}</span><h3>${c.title}</h3>
              <div class="muted small">${[c.linked_ref, `Requested ${fmtDate(c.requested_on)}`, c.requested_from ? `from ${c.requested_from}` : null].filter(Boolean).join(' · ')}</div></div>
            <div class="ap-state">${pill(c.status[0].toUpperCase() + c.status.slice(1), APPROVAL_TONE[c.status])}${!c.client_visible ? pill('Internal only', 'muted') : ''}</div></div>
          ${c.client_note ? html`<p class="ap-note pre-line">${c.client_note}</p>` : ''}
          ${[['request', 'Sent for review'], ['client_response', 'From the client'], [null, 'Evidence']].map(([tag, label]) => { const fs = (c.evidence || []).filter(f => tag ? f.tag === tag : !['request', 'client_response'].includes(f.tag)); return fs.length ? html`<div class="dp-label">${label}</div>${require('./views').docPreviews(fs)}` : ''; })}
          ${c.decided_on ? html`<div class="ap-decision"><b>${c.status === 'approved' ? 'Approved' : c.status === 'rejected' ? 'Rejected' : 'Withdrawn'} ${fmtDate(c.decided_on)}</b>${c.approver_name ? ` by ${c.approver_name}` : ''}${c.method ? ` · ${c.method}` : ''}
            <div class="muted small">${c.responded_by ? `Answered in the portal by ${c.responder}` : `Recorded by ${c.recorder}`}</div>${c.client_comment ? html`<div class="pre-line">“${c.client_comment}”</div>` : ''}</div>` : ''}
          ${c.notes ? html`<p class="muted small">Internal: ${c.notes}</p>` : ''}
          ${edit && c.status === 'requested' ? html`<details class="inline-form ap-decide"><summary>Record the decision</summary>
              <form method="post" action="/w/${id}/approvals/${c.id}/decision" enctype="multipart/form-data" class="form-grid"><input type="hidden" name="_csrf" value="${req.csrfToken}">
                ${field({ name: 'status', label: 'Decision', value: 'approved', options: [['approved', 'Approved'], ['rejected', 'Rejected'], ['withdrawn', 'Request withdrawn']] })}
                ${field({ name: 'decided_on', label: 'Decision date', type: 'date', required: true, value: todayBH() })}${field({ name: 'approver_name', label: 'Decided by (client side)', required: true, value: c.requested_from || '' })}
                ${field({ name: 'method', label: 'How it was given', options: [['Signed letter', 'Signed letter'], ['Email', 'Email'], ['Meeting minutes', 'Meeting minutes'], ['Message', 'Message'], ['In person', 'In person'], ['Other', 'Other']] })}
                <label class="field full"><span>Evidence (PDF, image, email export)</span><input type="file" name="files" multiple></label>
                ${field({ name: 'notes', label: 'Notes', full: true })}<div class="actions full"><button class="btn primary" type="submit">Save decision</button></div></form></details>` : ''}
          ${c.status === 'requested' && c.client_visible ? html`<p class="muted small">Waiting for the client's answer in the portal${edit ? ', or record it above' : ''}.</p>` : ''}
        </article>`)}</div>`
          : html`<p class="muted">No approvals recorded yet.</p>`}
      </section>
      ${edit ? html`<section class="panel"><h2 class="h">Ask the client for an approval</h2><form method="post" action="/w/${id}/approvals" enctype="multipart/form-data" class="form-grid"><input type="hidden" name="_csrf" value="${req.csrfToken}">
        ${field({ name: 'subject', label: 'Subject', options: Object.entries(SUBJECTS) })}${field({ name: 'title', label: 'What needs approval', required: true })}
        ${field({ name: 'linked_ref', label: 'Linked item / version', hint: 'For example Budget v2, VO-03, drawing A-101 rev C.' })}${field({ name: 'requested_on', label: 'Requested on', type: 'date', required: true, value: todayBH() })}
        ${field({ name: 'requested_from', label: 'Requested from (client approver)', list: client ? AG.approversOf(client) : [], value: client ? AG.approversOf(client)[0] || '' : '', hint: 'The client or their representative.' })}
        ${field({ name: 'client_note', label: 'Details for the client', type: 'textarea', full: true, hint: 'Shown in the client portal with the request: what they are approving, cost, deadline.' })}
        <label class="field full"><span>Photos and documents for the client to review before approving (optional, up to 6)</span><input type="file" name="files" multiple accept=".pdf,image/*,.doc,.docx,.xls,.xlsx"><small>Photos show as pictures and PDFs open in a viewer, so the client can look at them before answering.</small></label>
        <label class="field check full"><input type="checkbox" name="client_visible" value="1" checked> <span>Show in the client portal so the client can approve or reject it (and email them)</span></label>
        ${field({ name: 'notes', label: 'Internal notes (not shown to the client)', full: true })}<div class="actions full"><button class="btn primary" type="submit">Send request</button></div></form></section>` : ''}`));
  });

  // the client viewers of a project are told an approval is waiting for them in the portal
  async function tellClientViewers(req, a, id, title, note) {
    let told = 0;
    const viewers = (await pool.query(`select u.email, coalesce(nullif(u.name,''), u.email) as name from workspace_members m join users u on u.id = m.user_id
      where m.workspace_id = $1 and m.revoked_at is null and m.role = 'client_viewer' and u.active and u.email is not null`, [a.ws.id])).rows;
    const base = (ctx.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    for (const v of viewers) {
      await ctx.mailer.send({ to: v.email, kind: 'approval_request', workspaceId: a.ws.id, refKind: 'client_approval', refId: id,
        subject: `Approval requested: ${title} — ${a.ws.name}`,
        text: `Dear ${v.name},\n\nSarayDar asks for your approval on ${a.ws.name}:\n\n${title}${note ? `\n\n${note}` : ''}\n\nPlease review it and approve or reject it in the portal:\n${base}/p/${a.ws.id}/approvals\n\nSarayDar` });
      told++;
    }
    return told;
  }

  r.post('/w/:id/approvals', upload.array('files', 6), async (req, res) => {
    if (!core.checkCsrf(req)) throw new Forbidden('Your form expired. Reload the page and try again.');
    const a = cpmOnly(await access(req, 'contribute'));
    const files = await uploads.prepare(req.files, sniff);
    const visible = req.body.client_visible === '1';
    const title = txt(req.body.title, 200); if (!title) throw bad('Describe what needs approval.');
    const requested = dateOrNull(req.body.requested_on); if (!requested) throw bad('Enter the request date.');
    const subject = SUBJECTS[req.body.subject] ? req.body.subject : 'other';
    const id = await core.inTx(async db => {
      const id = (await db.query('insert into client_approvals (workspace_id, subject, title, linked_ref, requested_on, requested_from, notes, client_note, client_visible, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id',
        [a.ws.id, subject, title, txt(req.body.linked_ref, 120), requested, txt(req.body.requested_from, 120), txt(req.body.notes, 1000), txt(req.body.client_note, 2000), visible, req.user.id])).rows[0].id;
      // documents attached here are what the client reviews before deciding (shown in the portal)
      await uploads.insert(db, { workspaceId: a.ws.id, entity: 'client_approval', entityId: id, files, userId: req.user.id, tag: 'request', observedOn: todayBH() });
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'approval.requested', entity: 'client_approval', entityId: id, summary: `Client approval requested: ${title}${files.length ? ` with ${files.length} document(s)` : ''}`, ip: req.ip });
      await touch(db, a.ws.id);
      return id;
    });
    const told = visible ? await tellClientViewers(req, a, id, title, txt(req.body.client_note, 2000)) : 0;
    res.redirect(`/w/${a.ws.id}/approvals?msg=${told ? 'sent' : 'added'}`);
  });

  r.post('/w/:id/approvals/:cid/decision', upload.array('files', 6), async (req, res) => {
    if (!core.checkCsrf(req)) throw new Forbidden('Your form expired. Reload the page and try again.');
    const a = cpmOnly(await access(req, 'contribute'));
    const c = await own('client_approvals', req.params.cid, a.ws.id);
    const status = ['approved', 'rejected', 'withdrawn'].includes(req.body.status) ? req.body.status : null;
    if (!status) throw bad('Choose the decision.');
    const on = dateOrNull(req.body.decided_on); if (!on) throw bad('Enter the decision date.');
    if (on < iso(c.requested_on)) throw bad('The decision date is before the request.');
    const who = txt(req.body.approver_name, 120);
    if (status !== 'withdrawn' && !who) throw bad('Enter who decided on the client side.');
    const files = (req.files || []).map(f => ({ f, t: sniff(f.buffer, f.originalname) }));
    if (files.some(x => !x.t)) throw bad('Evidence must be a PDF, image, Office document or text file.');
    await core.inTx(async db => {
      const n = (await db.query("update client_approvals set status = $2, decided_on = $3, approver_name = $4, method = $5, notes = concat_ws(' · ', notes, $6::text), decided_by = $7, decided_at = now() where id = $1 and status = 'requested'",
        [c.id, status, on, who, txt(req.body.method, 60), txt(req.body.notes, 1000), req.user.id])).rowCount;
      if (!n) throw bad('A decision is already recorded. Record a new request if the client changes their decision.');
      for (const { f, t } of files) {
        await db.query("insert into files (workspace_id, entity, entity_id, original_name, mime, size, sha256, data, uploaded_by) values ($1,'client_approval',$2,$3,$4,$5,$6,$7,$8)",
          [a.ws.id, c.id, f.originalname.slice(-150), t.mime, f.size, crypto.createHash('sha256').update(f.buffer).digest('hex'), f.buffer, req.user.id]);
      }
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: `approval.${status}`, entity: 'client_approval', entityId: c.id, summary: `Client approval ${status}: ${c.title}${who ? ` (by ${who})` : ''}${files.length ? `, ${files.length} evidence file(s)` : ''}`, ip: req.ip });
      await touch(db, a.ws.id);
    });
    res.redirect(`/w/${a.ws.id}/approvals?msg=saved`);
  });

  return { ledger, statementRows, statementTable, period, docBase };
}

module.exports = { mountFees, METHODS };
