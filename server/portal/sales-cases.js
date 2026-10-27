'use strict';
const DL = require('../lib/download');
const CH = require('./choices');
// Property Sales & Acquisition — the case workspaces: sale listings, acquisition requests and deals.
// Mandate (versioned, authority verified, expiry blocks activity), property file with public vs confidential
// fields, asking-price and status history, marketing log, brochure, buyer brief with versions, external
// opportunities, transparent matching, shortlists, and the deal workspace with checklist and completion.
const multer = require('multer');
const { layout, html, raw, pill, statusPill, csrfField, field, emptyState, fmtDate, fmtDateTime } = require('./views');
const { SECTIONS, KIND_LABEL } = require('./core');
const { parseMoney, formatMoney, toInput } = require('../lib/money');
const uploads = require('../lib/uploads');
const docs = require('../lib/fee-docs');
const matching = require('../lib/matching');
const { sniff } = require('./workspaces');
const sharp = require('sharp');

const UUID = /^[0-9a-f-]{36}$/i;
const bad = m => Object.assign(new Error(m), { status: 400 });
const txt = (v, n = 300) => { const s = String(v ?? '').trim().slice(0, n); return s || null; };
const dateOrNull = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : null;
const todayBH = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bahrain' });
const fm = (m, c = 'BHD') => m === null || m === undefined ? '—' : formatMoney(Number(m), c);
const numOrNull = (v, label) => { if (v === undefined || String(v).trim() === '') return null; const x = Number(String(v).replace(/,/g, '')); if (!isFinite(x) || x < 0) throw bad(`${label} must be a positive number.`); return x; };
const moneyOrNull = (v, label) => { if (v === undefined || String(v).trim() === '') return null; const m = parseMoney(v, 'BHD'); if (m === null || m < 0) throw bad(`Check ${label}.`); return m; };
const pctToBp = v => { const s = String(v ?? '').trim(); if (!s) return null; if (!/^\d{1,3}(\.\d{1,2})?$/.test(s) || Number(s) > 100) throw bad('Enter the percentage, for example 2 or 2.5.'); const [w, f = ''] = s.split('.'); return Number(w) * 100 + Number((f + '00').slice(0, 2)); };
const bpLabel = bp => `${(bp / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 20, fields: 40 } });

const L_STATUS = { draft: 'Draft', awaiting_verification: 'Awaiting verification', ready: 'Ready for marketing', available: 'Available', under_offer: 'Under offer', reserved: 'Reserved', sold: 'Sold', withdrawn: 'Withdrawn', archived: 'Archived' };
const L_TONE = { draft: 'muted', awaiting_verification: 'warn', ready: 'info', available: 'ok', under_offer: 'warn', reserved: 'warn', sold: 'ok', withdrawn: 'muted', archived: 'muted' };
const R_STATUS = { draft: 'Draft', brief_confirmed: 'Brief confirmed', searching: 'Searching', shortlist_shared: 'Shortlist shared', viewings: 'Viewings', negotiation: 'Offer / negotiation', transaction: 'Due diligence / transaction', completed: 'Completed', on_hold: 'On hold', closed_unsuccessful: 'Closed unsuccessful' };
const M_LABEL = { draft: 'Draft', active: 'Active', suspended: 'Suspended', terminated: 'Terminated', superseded: 'Superseded', completed: 'Completed', expired: 'Expired' };
const PTYPES = ['Land', 'Villa', 'Apartment', 'Townhouse', 'Residential building', 'Commercial building', 'Commercial premises', 'Investment property', 'Other'];
const DEFAULT_CHECKLIST = ['Confirm identity and authority of both parties', 'Title / ownership documents reviewed (external professional)', 'Financing condition satisfied (if any)', 'Sale agreement prepared and reviewed by legal adviser', 'Deposit / payments evidenced (record who holds them)', 'Transfer appointment booked', 'Completion evidence received', 'Keys / possession handed over'];

function mountSalesCases(r, ctx) {
  const { pool, core, NotFound, Forbidden } = ctx;

  async function access(req, need = 'view') {
    if (!UUID.test(req.params.id || '')) throw new NotFound();
    const a = await core.workspaceAccess(req.user, req.params.id);
    if (!a || a.ws.section !== 'sales') throw new NotFound();
    if (!a.internal) throw new NotFound();                // seller/buyer viewer portals arrive in Phase 7
    if (need === 'edit' && !core.canEdit(a)) throw new Forbidden('Only the case manager or an editor can do this.');
    if (need === 'contribute' && !core.canContribute(a)) throw new Forbidden('Your role in this case is view-only.');
    a.finance = core.isSuper(req.user) || a.role === 'manager' || a.role === 'editor' || await core.can(req.user, 'view:financials');
    a.canPost = core.isSuper(req.user) || await core.can(req.user, 'finance:post');
    if (need === 'finance' && !a.finance) throw new NotFound();
    return a;
  }
  const kindOnly = (a, ...k) => { if (!k.includes(a.ws.kind)) throw new NotFound(); return a; };
  function tabs(a, cur) {
    const id = a.ws.id, f = a.finance !== false, k = a.ws.kind;
    const t = k === 'listing'
      ? [['Overview', `/w/${id}`], ['Mandate', `/w/${id}/mandate`], ['Property File', `/w/${id}/listing`], ['Marketing', `/w/${id}/marketing`], ['Buyers & Viewings', `/w/${id}/buyers`], ['Offers & Deal', `/w/${id}/offers`],
        ...(f ? [['Fee Billing', `/w/${id}/fees`], ['Expenses', `/w/${id}/sales-expenses`]] : []), ['Agreements', `/w/${id}/agreements`], ['Documents', `/w/${id}/documents`], ['Access & Invitations', `/w/${id}/access`], ['Activity', `/w/${id}/activity`]]
      : k === 'request'
        ? [['Overview', `/w/${id}`], ['Mandate', `/w/${id}/mandate`], ['Brief', `/w/${id}/brief`], ['Matches & Shortlist', `/w/${id}/shortlist`], ['Viewings & Offers', `/w/${id}/offers`],
          ...(f ? [['Fee Billing', `/w/${id}/fees`], ['Expenses', `/w/${id}/sales-expenses`]] : []), ['Agreements', `/w/${id}/agreements`], ['Documents', `/w/${id}/documents`], ['Access & Invitations', `/w/${id}/access`], ['Activity', `/w/${id}/activity`]]
        : [['Overview', `/w/${id}`], ['Checklist', `/w/${id}/checklist`], ['Agreements', `/w/${id}/agreements`], ['Documents', `/w/${id}/documents`], ['Access & Invitations', `/w/${id}/access`], ['Activity', `/w/${id}/activity`]];
    return t.map(([l, h]) => [l, h, l === cur]);
  }
  ctx.tabsFor = ctx.tabsFor || {};
  ctx.tabsFor.sales = (a, cur) => tabs(a, cur);
  function page(req, a, cur, body, crumb = null) {
    const w = a.ws, s = SECTIONS.sales;
    return layout(req, { title: `${crumb || cur} · ${w.name}`, heading: w.name, tabs: tabs(a, cur),
      crumbs: [['Home', '/'], [s.name, `/s/sales?kind=${w.kind === 'deal' ? 'listing' : w.kind}`], [w.name, `/w/${w.id}`], ...(crumb ? [[cur, null], [crumb]] : [[cur]])],
      sub: { above: `${w.ref} · ${KIND_LABEL[w.kind]}`, below: w.location || '', badge: statusPill(w.status) }, body });
  }
  const own = async (table, id, wsId, col = 'workspace_id') => {
    if (!UUID.test(String(id))) throw new NotFound();
    const row = (await pool.query(`select * from ${table} where id = $1 and ${col} = $2`, [id, wsId])).rows[0];
    if (!row) throw new NotFound();
    return row;
  };
  const touch = (db, wsId) => db.query('update workspaces set updated_at = now() where id = $1', [wsId]);

  // ---------- mandate ----------
  async function mandateState(wsId, db = pool) {
    const all = (await db.query(`select m.*, coalesce(nullif(u.name,''), u.email) as verifier from sale_mandates m left join users u on u.id = m.authority_verified_by where m.workspace_id = $1 order by version desc`, [wsId])).rows;
    const cur = all.find(m => ['active', 'suspended'].includes(m.status)) || null;
    const draft = all.find(m => m.status === 'draft') || null;
    const today = todayBH();
    const eff = !cur ? 'none' : cur.status === 'suspended' ? 'suspended' : cur.end_date && String(cur.end_date) < today ? 'expired' : 'active';
    const expiringSoon = cur && eff === 'active' && cur.end_date && String(cur.end_date) <= new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
    return { all, cur, draft, eff, canAct: eff === 'active' && !!cur.authority_verified_at, expiringSoon };
  }
  async function requireMandate(wsId, what) {
    const m = await mandateState(wsId);
    if (!m.canAct) throw bad(`${what} needs an active, verified mandate. ${m.eff === 'expired' ? 'The mandate has expired — renew it first.' : m.eff === 'suspended' ? 'The mandate is suspended.' : m.cur && !m.cur.authority_verified_at ? 'Verify the authority to represent the client first.' : 'Record and activate the mandate first.'}`);
    return m;
  }
  const SL = { access, page, own, touch, mandateState, requireMandate, tabs, L_STATUS, R_STATUS };
  ctx.SL = SL;

  const feeText = m => m.fee_type === 'fixed' ? `Fixed ${fm(m.fee_fixed_minor)}` : m.fee_type === 'percent' ? `${bpLabel(m.fee_bp || 0)} of the ${m.fee_base === 'final_price' ? 'final transaction price' : 'accepted price'}` : 'No fee recorded';

  r.get('/w/:id/mandate', async (req, res) => {
    const a = kindOnly(await access(req), 'listing', 'request');
    const M = await mandateState(a.ws.id);
    const edit = core.canEdit(a);
    const base = M.draft || M.cur || {};
    const side = a.ws.kind === 'listing' ? 'seller' : 'buyer';
    const agreements = (await pool.query("select id, ref, title, status from agreements where workspace_id = $1 and status <> 'cancelled' order by created_at desc", [a.ws.id])).rows;
    const v = (k, d = '') => base[k] === null || base[k] === undefined ? d : String(base[k]).slice(0, k.endsWith('_date') ? 10 : undefined);
    res.send(page(req, a, 'Mandate', html`
      ${M.eff === 'expired' ? html`<div class="notice warn">The mandate expired on ${fmtDate(M.cur.end_date)}. Marketing, viewings and offers are blocked until it is renewed. An expired mandate is not a completed ${side === 'seller' ? 'sale' : 'purchase'}.</div>`
        : M.eff === 'suspended' ? html`<div class="notice warn">The mandate is suspended: ${M.cur.status_reason || ''}. Activity is blocked.</div>`
        : M.expiringSoon ? html`<div class="notice warn">The mandate ends on ${fmtDate(M.cur.end_date)}.</div>` : ''}
      <section class="panel"><h2 class="h">${side === 'seller' ? 'Sale' : 'Acquisition'} mandate</h2>
        ${M.cur ? html`<dl class="details">
          <div><dt>Status</dt><dd>${pill(M_LABEL[M.eff] || M.cur.status, M.eff === 'active' ? 'ok' : 'warn')} v${M.cur.version}</dd></div>
          <div><dt>Appointing client</dt><dd>${(await pool.query('select name from parties where id = $1', [M.cur.party_id])).rows[0]?.name || '—'}</dd></div>
          <div><dt>Period</dt><dd>${fmtDate(M.cur.start_date)} – ${M.cur.end_date ? fmtDate(M.cur.end_date) : 'open-ended'}</dd></div>
          <div><dt>Representation</dt><dd>${{ exclusive: 'Exclusive', non_exclusive: 'Non-exclusive', unknown: 'Not stated' }[M.cur.exclusive]} · SarayDar acts for the ${side}${M.cur.dual_representation ? html`<div class="warn-text small">Documented dual representation: ${M.cur.dual_representation}</div>` : ''}</dd></div>
          <div><dt>Scope</dt><dd class="pre-line">${M.cur.scope || '—'}</dd></div>
          <div><dt>${side === 'seller' ? 'Asking-price authority' : 'Purchasing constraints'}</dt><dd class="pre-line">${M.cur.price_authority || '—'}</dd></div>
          ${side === 'seller' ? html`<div><dt>Marketing scope / budget</dt><dd>${M.cur.marketing_scope || '—'} · ${fm(M.cur.marketing_budget_minor)}</dd></div>` : ''}
          ${a.finance ? html`<div><dt>Fee</dt><dd>${feeText(M.cur)} · payer: ${M.cur.fee_payer || '—'} · earned on ${M.cur.fee_trigger} · tax: ${M.cur.tax_mode === 'rate' ? `${M.cur.tax_label || 'VAT'} ${bpLabel(M.cur.tax_rate_bp || 0)}` : M.cur.tax_mode === 'none' ? 'none' : 'not confirmed'}</dd></div>` : ''}
          <div><dt>Co-broker / referral</dt><dd>${M.cur.co_broker || 'None documented'}</dd></div>
          <div><dt>Client decisions required</dt><dd class="pre-line">${M.cur.client_decisions || '—'}</dd></div>
          <div><dt>Authority verified</dt><dd>${M.cur.authority_verified_at ? `${M.cur.verifier} · ${fmtDateTime(M.cur.authority_verified_at)} · ${M.cur.authority_evidence}` : html`<span class="err">Not verified — activity is blocked</span>`}</dd></div>
          <div><dt>Signed agreement</dt><dd>${M.cur.agreement_id ? html`<a href="/w/${a.ws.id}/agreements/${M.cur.agreement_id}">Open</a>` : 'Not linked'}</dd></div></dl>
          ${edit ? html`<div class="actions">
            ${!M.cur.authority_verified_at ? html`<form method="post" action="/w/${a.ws.id}/mandate/${M.cur.id}/verify" class="actions">${csrfField(req)}<input name="evidence" placeholder="Evidence (e.g. title deed seen, CR, power of attorney)" aria-label="Evidence" required size="40"><button class="btn primary" type="submit">Verify authority</button></form>` : ''}
            ${M.cur.status === 'active' ? html`<form method="post" action="/w/${a.ws.id}/mandate/${M.cur.id}/status" class="actions">${csrfField(req)}<input name="reason" placeholder="Reason" aria-label="Reason" required><button class="btn small" name="to" value="suspended">Suspend</button><button class="btn small" name="to" value="terminated">Terminate</button></form>` : ''}
            ${M.cur.status === 'suspended' ? html`<form method="post" action="/w/${a.ws.id}/mandate/${M.cur.id}/status" class="actions">${csrfField(req)}<input name="reason" placeholder="Reason" aria-label="Reason" required><button class="btn small" name="to" value="active">Reinstate</button><button class="btn small" name="to" value="terminated">Terminate</button></form>` : ''}</div>` : ''}`
          : html`<p class="muted">No mandate in force. Record the agreement below and activate it.</p>`}
        ${M.all.length > 1 ? html`<h3 class="h3">History</h3><ul class="rows">${M.all.map(m => html`<li><div class="grow">v${m.version} · ${fmtDate(m.start_date)} – ${m.end_date ? fmtDate(m.end_date) : 'open'}${a.finance ? ` · ${feeText(m)}` : ''}<div class="muted small">${m.status_reason || ''}</div></div>${pill(M_LABEL[m.status], m.status === 'active' ? 'ok' : 'muted')}</li>`)}</ul>` : ''}
      </section>
      ${edit ? html`<section class="panel"><h2 class="h">${M.draft ? `Draft v${M.draft.version}` : M.cur ? 'Renew or change (new version)' : 'Record the mandate'}</h2>
        <form method="post" action="/w/${a.ws.id}/mandate" class="form-grid">${csrfField(req)}
          ${field({ name: 'scope', label: 'Scope', type: 'textarea', value: v('scope') })}
          ${field({ name: 'exclusive', label: 'Representation', value: v('exclusive', 'unknown'), options: [['unknown', 'Not stated'], ['exclusive', 'Exclusive'], ['non_exclusive', 'Non-exclusive']] })}
          ${field({ name: 'start_date', label: 'Start', type: 'date', required: true, value: v('start_date', todayBH()) })}${field({ name: 'end_date', label: 'End', type: 'date', value: v('end_date'), hint: 'Activity is blocked after this date until renewed.' })}
          ${field({ name: 'renewal_terms', label: 'Renewal / termination terms', value: v('renewal_terms') })}
          ${field({ name: 'price_authority', label: side === 'seller' ? 'Asking-price authority' : 'Purchasing constraints', type: 'textarea', value: v('price_authority') })}
          ${side === 'seller' ? html`${field({ name: 'marketing_scope', label: 'Approved marketing scope', value: v('marketing_scope') })}${field({ name: 'marketing_budget', label: 'Approved marketing budget (BHD)', value: base.marketing_budget_minor == null ? '' : toInput(Number(base.marketing_budget_minor)) })}` : ''}
          ${a.finance ? html`${field({ name: 'fee_type', label: 'Fee', value: v('fee_type', 'percent'), options: [['percent', 'Percentage commission'], ['fixed', 'Fixed fee'], ['none', 'No fee']] })}
            ${field({ name: 'fee_pct', label: 'Commission (%)', value: base.fee_bp == null ? '' : base.fee_bp / 100 })}${field({ name: 'fee_fixed', label: 'Fixed fee (BHD)', value: base.fee_fixed_minor == null ? '' : toInput(Number(base.fee_fixed_minor)) })}
            ${field({ name: 'fee_base', label: 'Commission calculated on', value: v('fee_base', 'final_price'), options: [['final_price', 'Final transaction price'], ['accepted_price', 'Accepted offer price']] })}
            ${field({ name: 'fee_payer', label: 'Fee paid by', value: v('fee_payer', side === 'seller' ? 'Seller' : 'Buyer'), list: ['Seller', 'Buyer', 'Seller and buyer'] })}${field({ name: 'fee_trigger', label: 'Fee earned on', value: v('fee_trigger', 'completion'), options: [['completion', 'Completion'], ['signing', 'Signing of the sale agreement'], ['other', 'Other (see scope)']] })}
            ${field({ name: 'tax_mode', label: 'VAT on the fee', value: v('tax_mode', 'none'), options: [['none', 'No VAT'], ['rate', 'Charge VAT'], ['not_configured', 'Not yet confirmed']] })}${field({ name: 'tax_rate', label: 'VAT rate (%)', value: base.tax_rate_bp == null ? '' : base.tax_rate_bp / 100 })}
            ${field({ name: 'payment_terms_days', label: 'Payment due (days)', type: 'number', value: v('payment_terms_days', '15') })}` : ''}
          ${field({ name: 'dual_representation', label: 'Dual representation (only if approved and documented)', value: v('dual_representation') })}${field({ name: 'co_broker', label: 'Co-broker / referral split (documented)', value: v('co_broker') })}
          ${field({ name: 'client_decisions', label: 'Decisions the client takes', type: 'textarea', value: v('client_decisions') })}
          ${field({ name: 'agreement_id', label: 'Signed agreement', value: v('agreement_id'), options: [['', 'Not linked yet'], ...agreements.map(x => [x.id, `${x.ref} · ${x.title} (${x.status})`])] })}
          <div class="actions full"><button class="btn" type="submit">Save draft</button></div></form>
        ${M.draft ? html`<form method="post" action="/w/${a.ws.id}/mandate/${M.draft.id}/activate" class="actions">${csrfField(req)}<button class="btn primary" type="submit">Activate v${M.draft.version}${M.cur ? ' (replaces the current version)' : ''}</button></form>` : ''}
        <p class="muted small">No commission rate is assumed. SarayDar acts for one side unless dual representation is documented here.</p></section>` : ''}`));
  });

  r.post('/w/:id/mandate', async (req, res) => {
    const a = kindOnly(await access(req, 'edit'), 'listing', 'request');
    const b = req.body;
    const start = dateOrNull(b.start_date); if (!start) throw bad('Enter the start date.');
    const end = dateOrNull(b.end_date); if (end && end < start) throw bad('The end date is before the start.');
    const v = { scope: txt(b.scope, 2000), exclusive: ['exclusive', 'non_exclusive'].includes(b.exclusive) ? b.exclusive : 'unknown', start_date: start, end_date: end, renewal_terms: txt(b.renewal_terms, 500),
      price_authority: txt(b.price_authority, 2000), marketing_scope: txt(b.marketing_scope, 500), marketing_budget_minor: moneyOrNull(b.marketing_budget, 'the marketing budget'),
      dual_representation: txt(b.dual_representation, 500), co_broker: txt(b.co_broker, 500), client_decisions: txt(b.client_decisions, 1000),
      agreement_id: UUID.test(b.agreement_id || '') && (await pool.query('select 1 from agreements where id = $1 and workspace_id = $2', [b.agreement_id, a.ws.id])).rowCount ? b.agreement_id : null };
    if (a.finance) Object.assign(v, { fee_type: ['fixed', 'percent', 'none'].includes(b.fee_type) ? b.fee_type : 'none', fee_bp: pctToBp(b.fee_pct), fee_fixed_minor: moneyOrNull(b.fee_fixed, 'the fixed fee'),
      fee_base: b.fee_base === 'accepted_price' ? 'accepted_price' : 'final_price', fee_payer: txt(b.fee_payer, 80), fee_trigger: ['completion', 'signing', 'other'].includes(b.fee_trigger) ? b.fee_trigger : 'completion',
      tax_mode: ['none', 'rate', 'not_configured'].includes(b.tax_mode) ? b.tax_mode : 'none', tax_rate_bp: b.tax_mode === 'rate' ? pctToBp(b.tax_rate) : null, tax_label: b.tax_mode === 'rate' ? 'VAT' : null,
      payment_terms_days: Math.min(365, Math.max(0, parseInt(b.payment_terms_days, 10) || 15)) });
    if (v.fee_type === 'percent' && v.fee_bp === null) throw bad('Enter the commission percentage.');
    if (v.fee_type === 'fixed' && v.fee_fixed_minor === null) throw bad('Enter the fixed fee.');
    if (v.tax_mode === 'rate' && v.tax_rate_bp === null) throw bad('Enter the VAT rate.');
    await core.inTx(async db => {
      await db.query('select id from workspaces where id = $1 for update', [a.ws.id]);
      const d = (await db.query("select id from sale_mandates where workspace_id = $1 and status = 'draft'", [a.ws.id])).rows[0];
      const cols = Object.keys(v);
      if (d) await db.query(`update sale_mandates set ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}, party_id = $${cols.length + 2} where id = $1`, [d.id, ...cols.map(c => v[c]), a.ws.party_id]);
      else {
        const ver = (await db.query('select coalesce(max(version),0)+1 as v from sale_mandates where workspace_id = $1', [a.ws.id])).rows[0].v;
        await db.query(`insert into sale_mandates (workspace_id, version, side, party_id, created_by, ${cols.join(', ')}) values ($1,$2,$3,$4,$5,${cols.map((c, i) => `$${i + 6}`).join(',')})`, [a.ws.id, ver, a.ws.kind === 'listing' ? 'seller' : 'buyer', a.ws.party_id, req.user.id, ...cols.map(c => v[c])]);
      }
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'mandate.draft_saved', entity: 'workspace', entityId: a.ws.id, summary: `Mandate draft saved (${start} to ${end || 'open'})`, after: v, ip: req.ip });
    });
    res.redirect(`/w/${a.ws.id}/mandate?msg=saved`);
  });

  const mAct = (path, fn) => r.post(`/w/:id/mandate/:mid/${path}`, async (req, res) => {
    const a = kindOnly(await access(req, 'edit'), 'listing', 'request');
    const m = await own('sale_mandates', req.params.mid, a.ws.id);
    await core.inTx(async db => { await db.query('select id from workspaces where id = $1 for update', [a.ws.id]); await fn(db, a, m, req); await touch(db, a.ws.id); });
    res.redirect(`/w/${a.ws.id}/mandate?msg=saved`);
  });
  mAct('activate', async (db, a, m, req) => {
    if (m.status !== 'draft') throw bad('Only a draft can be activated.');
    if (!a.ws.party_id) throw bad('Link the appointing client to this case first (Overview › Edit).');
    const cur = (await db.query("select * from sale_mandates where workspace_id = $1 and status in ('active','suspended')", [a.ws.id])).rows[0];
    if (cur) await db.query("update sale_mandates set status = 'superseded', status_reason = $2 where id = $1", [cur.id, `Replaced by v${m.version}`]);
    // authority verification carries over to a renewal only if the same client appoints
    const carry = cur && cur.authority_verified_at && cur.party_id === a.ws.party_id;
    await db.query("update sale_mandates set status = 'active', party_id = $2, authority_verified_by = coalesce(authority_verified_by, $3), authority_verified_at = coalesce(authority_verified_at, $4), authority_evidence = coalesce(authority_evidence, $5) where id = $1",
      [m.id, a.ws.party_id, carry ? cur.authority_verified_by : null, carry ? cur.authority_verified_at : null, carry ? `${cur.authority_evidence} (carried from v${cur.version})` : null]);
    await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'mandate.activated', entity: 'workspace', entityId: a.ws.id, summary: `Mandate v${m.version} activated (${String(m.start_date).slice(0, 10)} to ${m.end_date ? String(m.end_date).slice(0, 10) : 'open'})`, ip: req.ip });
  });
  mAct('verify', async (db, a, m, req) => {
    const ev = txt(req.body.evidence, 300); if (!ev) throw bad('Record the evidence of authority.');
    if (!['active', 'suspended'].includes(m.status)) throw bad('Verify the mandate in force.');
    await db.query('update sale_mandates set authority_verified_by = $2, authority_verified_at = now(), authority_evidence = $3 where id = $1', [m.id, req.user.id, ev]);
    await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'mandate.authority_verified', entity: 'workspace', entityId: a.ws.id, summary: `Authority to represent the client verified: ${ev}`, ip: req.ip });
  });
  mAct('status', async (db, a, m, req) => {
    const to = ['active', 'suspended', 'terminated'].includes(req.body.to) ? req.body.to : null;
    const reason = txt(req.body.reason, 300); if (!to || !reason) throw bad('Choose the change and give a reason.');
    const ok = { suspended: ['active'], terminated: ['active', 'suspended'], active: ['suspended'] }[to];
    if (!ok.includes(m.status)) throw bad('That change is not possible.');
    await db.query('update sale_mandates set status = $2, status_reason = $3 where id = $1', [m.id, to, reason]);
    await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: `mandate.${to}`, entity: 'workspace', entityId: a.ws.id, summary: `Mandate v${m.version} ${to === 'active' ? 'reinstated' : to}: ${reason}`, ip: req.ip });
  });

  // ---------- listing file ----------
  const listingOf = async (wsId, db = pool) => (await db.query('select * from listings where workspace_id = $1', [wsId])).rows[0] || null;
  SL.listingOf = listingOf;
  async function ensureListing(db, wsId) { await db.query('insert into listings (workspace_id) values ($1) on conflict do nothing', [wsId]); return (await db.query('select * from listings where workspace_id = $1 for update', [wsId])).rows[0]; }
  async function setListingStatus(db, wsId, to, reason, evidence, userId) {
    await db.query('update listings set status = $2, updated_at = now(), available_since = case when $2 = \'available\' and available_since is null then $3::date else available_since end where workspace_id = $1', [wsId, to, todayBH()]);
    await db.query('insert into listing_status_history (workspace_id, status, changed_on, reason, evidence, created_by) values ($1,$2,$3,$4,$5,$6)', [wsId, to, todayBH(), reason, evidence, userId]);
  }
  SL.setListingStatus = setListingStatus;

  r.get('/w/:id/listing', async (req, res) => {
    const a = kindOnly(await access(req), 'listing');
    const l = await listingOf(a.ws.id) || { status: 'draft', currency: 'BHD', negotiable: 'unknown', verification: 'unverified' };
    const prices = (await pool.query("select p.*, coalesce(nullif(u.name,''), u.email) as by from listing_prices p left join users u on u.id = p.created_by where p.workspace_id = $1 order by p.effective_on desc, p.created_at desc", [a.ws.id])).rows;
    const hist = (await pool.query("select h.*, coalesce(nullif(u.name,''), u.email) as by from listing_status_history h left join users u on u.id = h.created_by where h.workspace_id = $1 order by h.id desc", [a.ws.id])).rows;
    const photos = await uploads.list(pool, a.ws.id, 'listing', [a.ws.id]);
    const units = (await pool.query("select u.id, u.ref, w.name from units u join workspaces w on w.id = u.workspace_id where u.archived_at is null and w.section = 'props' and " + core.visibleWhere(req.user).replace(/w\.id/g, 'w.id') + " order by w.name, u.ref limit 300", [req.user.id])).rows;
    const edit = core.canEdit(a);
    const M = await mandateState(a.ws.id);
    const id = a.ws.id;
    const nv = k => l[k] === null || l[k] === undefined ? '' : Number(l[k]);
    const next = { draft: ['awaiting_verification'], awaiting_verification: ['ready'], ready: ['available', 'withdrawn'], available: ['withdrawn'], under_offer: ['available', 'withdrawn'], reserved: [], sold: ['archived'], withdrawn: ['available', 'archived'], archived: [] }[l.status] || [];
    res.send(page(req, a, 'Property File', html`
      <div class="split"><section class="panel grow2"><div class="row-between"><h2 class="h">Property file ${pill(L_STATUS[l.status], L_TONE[l.status])} ${pill(l.verification === 'verified' ? 'Verified' : 'Unverified', l.verification === 'verified' ? 'ok' : 'warn')}</h2>
          <a class="btn small" href="/w/${id}/brochure.pdf">Brochure PDF</a></div>
        <h3 class="h3">Shown to buyers (when published)</h3>
        <dl class="details"><div><dt>Type</dt><dd>${l.property_type || '—'}${l.category ? ` · ${l.category}` : ''}</dd></div><div><dt>Location</dt><dd>${l.location || '—'}${l.map_ref ? ` · ${l.map_ref}` : ''}</dd></div>
          <div><dt>Land / built-up</dt><dd>${l.land_area_m2 == null ? '—' : `${Number(l.land_area_m2)} m²`} / ${l.built_area_m2 == null ? '—' : `${Number(l.built_area_m2)} m²`}</dd></div><div><dt>Unit / floor</dt><dd>${l.unit_floor || '—'}</dd></div>
          <div><dt>Bedrooms / bathrooms</dt><dd>${l.bedrooms ?? '—'} / ${l.bathrooms ?? '—'}</dd></div><div><dt>Features</dt><dd class="pre-line">${l.features || '—'}</dd></div><div><dt>Condition</dt><dd>${l.condition || '—'}</dd></div>
          <div><dt>Asking price</dt><dd>${l.asking_minor == null ? html`<span class="muted">Not set</span>` : fm(l.asking_minor, l.currency)} · negotiable: ${l.negotiable}</dd></div><div><dt>Description</dt><dd class="pre-line">${l.description || '—'}</dd></div></dl>
        <h3 class="h3">Internal and confidential — never shown to buyers</h3>
        <dl class="details"><div><dt>Minimum acceptable price</dt><dd>${a.finance ? (l.min_price_minor == null ? '—' : fm(l.min_price_minor, l.currency)) : 'Hidden for your role'}</dd></div>
          <div><dt>Occupancy / tenancy</dt><dd>${l.occupancy || '—'}</dd></div><div><dt>Access / viewing arrangements</dt><dd class="pre-line">${l.access_notes || '—'}</dd></div>
          <div><dt>Title / ownership information</dt><dd class="pre-line">${l.title_info || '—'}</dd></div><div><dt>Known restrictions</dt><dd class="pre-line">${l.restrictions || '—'}</dd></div>
          <div><dt>Source</dt><dd>${l.source || '—'}</dd></div><div><dt>Linked managed unit</dt><dd>${l.linked_unit_id ? (units.find(u => u.id === l.linked_unit_id) || {}).ref || 'Linked' : 'None'} <span class="muted small">(a sale never changes a lease or ownership in Properties Management automatically)</span></dd></div></dl>
        ${edit ? html`<details class="inline-form" ${l.status === 'draft' && !l.property_type ? raw('open') : ''}><summary>Edit the property file</summary><form method="post" action="/w/${id}/listing" class="form-grid">${csrfField(req)}
          ${field({ name: 'property_type', label: 'Type', value: l.property_type || '', options: [['', 'Choose…'], ...PTYPES.map(t => [t, t])] })}${field({ name: 'category', label: 'Category', value: l.category || '' })}
          ${field({ name: 'location', label: 'Location', value: l.location || '', list: CH.BH_AREAS })}${field({ name: 'map_ref', label: 'Map reference / block / plot', value: l.map_ref || '' })}
          ${field({ name: 'land_area_m2', label: 'Land area (m²)', value: nv('land_area_m2') })}${field({ name: 'built_area_m2', label: 'Built-up area (m²)', value: nv('built_area_m2') })}${field({ name: 'unit_floor', label: 'Unit / floor', value: l.unit_floor || '' })}
          ${field({ name: 'bedrooms', label: 'Bedrooms', value: nv('bedrooms') })}${field({ name: 'bathrooms', label: 'Bathrooms', value: nv('bathrooms') })}${field({ name: 'condition', label: 'Condition', value: l.condition || '', list: CH.CONDITIONS })}
          ${field({ name: 'features', label: 'Features / amenities', type: 'textarea', value: l.features || '' })}${field({ name: 'description', label: 'Public description', type: 'textarea', value: l.description || '' })}
          ${field({ name: 'negotiable', label: 'Negotiable', value: l.negotiable, options: [['unknown', 'Not stated'], ['yes', 'Yes'], ['no', 'No']] })}
          ${a.finance ? field({ name: 'min_price', label: 'Minimum acceptable price — confidential (BHD)', value: l.min_price_minor == null ? '' : toInput(Number(l.min_price_minor)) }) : ''}
          ${field({ name: 'occupancy', label: 'Occupancy / tenancy', value: l.occupancy || '' })}${field({ name: 'access_notes', label: 'Access / viewing arrangements', value: l.access_notes || '' })}
          ${field({ name: 'title_info', label: 'Title / ownership information provided', type: 'textarea', value: l.title_info || '' })}${field({ name: 'restrictions', label: 'Known restrictions', type: 'textarea', value: l.restrictions || '' })}
          ${field({ name: 'source', label: 'Source of the information', value: l.source || '' })}
          ${field({ name: 'linked_unit_id', label: 'Same unit managed in Properties Management', value: l.linked_unit_id || '', options: [['', 'Not linked'], ...units.map(u => [u.id, `${u.name} · ${u.ref}`])] })}
          <div class="actions full"><button class="btn primary" type="submit">Save</button></div><p class="muted small full">Leave anything unknown empty. The asking price is changed below so that every change keeps its date, reason and authorisation.</p></form></details>` : ''}
      </section>
      <section class="panel grow1"><h2 class="h">Asking price</h2>
        ${prices.length ? html`<ul class="rows">${prices.map(p => html`<li><div class="grow"><b>${fm(p.asking_minor, p.currency)}</b> from ${fmtDate(p.effective_on)}<div class="muted small">${p.reason || ''}${p.seller_approval ? ` · ${p.seller_approval}` : ''} · ${p.by || ''}</div></div></li>`)}</ul>` : html`<p class="muted">Not set.</p>`}
        ${edit && a.finance ? html`<details class="inline-form"><summary>${prices.length ? 'Change the asking price' : 'Set the asking price'}</summary><form method="post" action="/w/${id}/listing/price" class="form-grid">${csrfField(req)}
          ${field({ name: 'asking', label: 'Asking price (BHD)', required: true })}${field({ name: 'effective_on', label: 'From', type: 'date', required: true, value: todayBH() })}
          ${field({ name: 'reason', label: 'Reason', required: true })}${field({ name: 'authorization', label: 'Seller authorisation (evidence)', required: true })}<div class="actions full"><button class="btn" type="submit">Save price</button></div></form></details>` : ''}
        <h3 class="h3">Status</h3>
        ${edit ? html`${l.verification !== 'verified' ? html`<form method="post" action="/w/${id}/listing/verify" class="actions">${csrfField(req)}<input name="evidence" placeholder="What was checked" aria-label="What was checked" required><button class="btn small" type="submit">Mark information verified</button></form>` : ''}
          ${next.length ? html`<form method="post" action="/w/${id}/listing/status" class="form-grid">${csrfField(req)}${field({ name: 'to', label: 'Move to', options: next.map(s => [s, L_STATUS[s]]) })}${field({ name: 'reason', label: 'Reason', required: true })}${field({ name: 'evidence', label: 'Evidence' })}
            <div class="actions full"><button class="btn small" type="submit">Change status</button></div><p class="muted small full">“Available” needs an active, verified mandate, verified information and an asking price. “Under offer”, “Reserved” and “Sold” follow the recorded offer and deal — never set by hand.</p></form>` : html`<p class="muted small">Status follows the deal.</p>`}` : ''}
        ${!M.canAct ? html`<p class="warn-text small">Mandate: ${M_LABEL[M.eff] || 'none'} — marketing and viewings are blocked.</p>` : ''}
        <ol class="feed">${hist.map(h => html`<li><b>${L_STATUS[h.status]}</b> · ${fmtDate(h.changed_on)}<div class="muted small">${h.reason || ''}${h.evidence ? ` · ${h.evidence}` : ''} · ${h.by || ''}</div></li>`)}</ol>
      </section></div>
      <section class="panel"><h2 class="h">Photos, videos and plans</h2>
        ${photos.length ? html`<div class="gallery big-gallery">${photos.map(f => html`<figure>${f.has_thumb ? html`<a href="/files/${f.id}"><img src="/files/${f.id}/thumb" alt="${f.original_name}" loading="lazy"></a>` : html`<a href="/files/${f.id}">${f.original_name}</a>`}<figcaption class="small">${f.tag === 'published' ? pill('Client-approved', 'ok') : pill('Internal', 'muted')} ${f.caption || ''}</figcaption></figure>`)}</div>` : html`<p class="muted">None yet.</p>`}
        ${core.canContribute(a) ? html`<form method="post" action="/w/${id}/listing/photos" enctype="multipart/form-data" class="form-grid"><input type="hidden" name="_csrf" value="${req.csrfToken}">
          <label class="field"><span>Files</span><input type="file" name="files" multiple required></label>${field({ name: 'tag', label: 'Use', options: [['published', 'Client-approved for marketing'], ['internal', 'Internal only (title, authority, valuation…)']] })}
          ${field({ name: 'caption', label: 'Caption' })}${field({ name: 'observed_on', label: 'Photo date', type: 'date', value: todayBH() })}<div class="actions full"><button class="btn" type="submit">Upload</button></div></form>` : ''}
      </section>`));
  });

  r.post('/w/:id/listing', async (req, res) => {
    const a = kindOnly(await access(req, 'edit'), 'listing');
    const b = req.body;
    const v = { property_type: PTYPES.includes(b.property_type) ? b.property_type : null, category: txt(b.category, 80), location: txt(b.location, 200), map_ref: txt(b.map_ref, 120),
      land_area_m2: numOrNull(b.land_area_m2, 'Land area'), built_area_m2: numOrNull(b.built_area_m2, 'Built-up area'), unit_floor: txt(b.unit_floor, 60),
      bedrooms: numOrNull(b.bedrooms, 'Bedrooms'), bathrooms: numOrNull(b.bathrooms, 'Bathrooms'), condition: txt(b.condition, 200), features: txt(b.features, 2000), description: txt(b.description, 4000),
      negotiable: ['yes', 'no'].includes(b.negotiable) ? b.negotiable : 'unknown', occupancy: txt(b.occupancy, 300), access_notes: txt(b.access_notes, 500), title_info: txt(b.title_info, 2000), restrictions: txt(b.restrictions, 1000), source: txt(b.source, 200) };
    if (a.finance) v.min_price_minor = moneyOrNull(b.min_price, 'the minimum price');
    if (UUID.test(b.linked_unit_id || '')) { const u = (await pool.query('select workspace_id from units where id = $1', [b.linked_unit_id])).rows[0]; if (!u || !(await core.workspaceAccess(req.user, u.workspace_id))) throw bad('Choose a unit you can open.'); v.linked_unit_id = b.linked_unit_id; } else v.linked_unit_id = null;
    await core.inTx(async db => {
      const cur = await ensureListing(db, a.ws.id);
      const cols = Object.keys(v);
      await db.query(`update listings set ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}, verification = case when verification = 'verified' then 'unverified' else verification end, updated_at = now() where workspace_id = $1`, [a.ws.id, ...cols.map(c => v[c])]);
      if (cur.status === 'draft') await setListingStatus(db, a.ws.id, 'awaiting_verification', 'Property file recorded', null, req.user.id);
      if (v.location) await db.query('update workspaces set location = $2 where id = $1', [a.ws.id, v.location]);
      const changed = cols.filter(c => String(cur[c] ?? '') !== String(v[c] ?? ''));
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'listing.file_saved', entity: 'listing', entityId: a.ws.id, summary: `Property file updated${changed.length ? ` (${changed.filter(c => c !== 'min_price_minor').join(', ')}${changed.includes('min_price_minor') ? ', confidential minimum' : ''})` : ''}; needs re-verification`, ip: req.ip });
      await touch(db, a.ws.id);
    });
    res.redirect(`/w/${a.ws.id}/listing?msg=saved`);
  });

  r.post('/w/:id/listing/price', async (req, res) => {
    const a = kindOnly(await access(req, 'edit'), 'listing');
    if (!a.finance) throw new NotFound();
    const amt = moneyOrNull(req.body.asking, 'the asking price'); if (amt === null) throw bad('Enter the asking price.');
    const on = dateOrNull(req.body.effective_on); const reason = txt(req.body.reason, 300), auth = txt(req.body.authorization, 300);
    if (!on || !reason || !auth) throw bad('Enter the date, reason and the seller\'s authorisation.');
    await core.inTx(async db => {
      const cur = await ensureListing(db, a.ws.id);
      if (['sold', 'archived'].includes(cur.status)) throw bad('The listing is closed.');
      await db.query('insert into listing_prices (workspace_id, asking_minor, currency, effective_on, reason, seller_approval, created_by) values ($1,$2,$3,$4,$5,$6,$7)', [a.ws.id, amt, cur.currency, on, reason, auth, req.user.id]);
      await db.query('update listings set asking_minor = $2, updated_at = now() where workspace_id = $1', [a.ws.id, amt]);
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'listing.price', entity: 'listing', entityId: a.ws.id, summary: `Asking price ${cur.asking_minor == null ? 'set' : `changed from ${formatMoney(Number(cur.asking_minor))}`} to ${formatMoney(amt)} from ${on}: ${reason} (${auth})`, ip: req.ip });
      await touch(db, a.ws.id);
    });
    res.redirect(`/w/${a.ws.id}/listing?msg=saved`);
  });

  r.post('/w/:id/listing/verify', async (req, res) => {
    const a = kindOnly(await access(req, 'edit'), 'listing');
    const ev = txt(req.body.evidence, 300); if (!ev) throw bad('Record what was checked.');
    await core.inTx(async db => {
      const cur = await ensureListing(db, a.ws.id);
      if (!cur.property_type || !cur.location) throw bad('Record at least the type and location first.');
      await db.query("update listings set verification = 'verified', verified_by = $2, verified_at = now() where workspace_id = $1", [a.ws.id, req.user.id]);
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'listing.verified', entity: 'listing', entityId: a.ws.id, summary: `Property information verified: ${ev}`, ip: req.ip });
    });
    res.redirect(`/w/${a.ws.id}/listing?msg=saved`);
  });

  r.post('/w/:id/listing/status', async (req, res) => {
    const a = kindOnly(await access(req, 'edit'), 'listing');
    const to = req.body.to; const reason = txt(req.body.reason, 300);
    if (!reason) throw bad('Give a reason.');
    await core.inTx(async db => {
      const cur = await ensureListing(db, a.ws.id);
      const allowed = { draft: ['awaiting_verification'], awaiting_verification: ['ready'], ready: ['available', 'withdrawn'], available: ['withdrawn'], under_offer: ['available', 'withdrawn'], sold: ['archived'], withdrawn: ['available', 'archived'] }[cur.status] || [];
      if (!allowed.includes(to)) throw bad(['under_offer', 'reserved', 'sold'].includes(to) ? 'This status follows the recorded offer or deal.' : 'That change is not possible from the current status.');
      if (to === 'ready' && cur.verification !== 'verified') throw bad('Verify the property information first.');
      if (to === 'available') {
        if (cur.verification !== 'verified') throw bad('Verify the property information first.');
        if (cur.asking_minor == null) throw bad('Set the asking price first.');
        const m = await mandateState(a.ws.id, db);
        if (!m.canAct) throw bad('Marketing needs an active mandate with verified authority.');
        if (cur.status === 'under_offer' && (await db.query("select 1 from deals where listing_ws = $1 and status = 'in_progress'", [a.ws.id])).rowCount) throw bad('A deal is in progress. Record it as fallen through first.');
      }
      await setListingStatus(db, a.ws.id, to, reason, txt(req.body.evidence, 300), req.user.id);
      if (['withdrawn', 'archived'].includes(to)) await db.query("update workspaces set status = case when $2 = 'archived' then 'archived' else status end where id = $1", [a.ws.id, to]);
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'listing.status', entity: 'listing', entityId: a.ws.id, summary: `Listing ${L_STATUS[cur.status]} → ${L_STATUS[to]}: ${reason}`, ip: req.ip });
      await touch(db, a.ws.id);
    });
    res.redirect(`/w/${a.ws.id}/listing?msg=saved`);
  });

  r.post('/w/:id/listing/photos', upload.array('files', 20), async (req, res) => {
    if (!core.checkCsrf(req)) throw new Forbidden('Your form expired. Reload the page and try again.');
    const a = kindOnly(await access(req, 'contribute'), 'listing');
    const files = await uploads.prepare(req.files, sniff);
    if (!files.length) throw bad('Choose files.');
    const tag = req.body.tag === 'published' ? 'published' : 'internal';
    await core.inTx(async db => {
      await uploads.insert(db, { workspaceId: a.ws.id, entity: 'listing', entityId: a.ws.id, files, userId: req.user.id, tag, caption: txt(req.body.caption, 200), observedOn: dateOrNull(req.body.observed_on) });
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'listing.files', entity: 'listing', entityId: a.ws.id, summary: `${files.length} ${tag === 'published' ? 'client-approved' : 'internal'} file(s) added`, ip: req.ip });
    });
    res.redirect(`/w/${a.ws.id}/listing?msg=uploaded`);
  });

  // brochure: public fields and client-approved photos only — never the minimum price, title or owner details
  r.get('/w/:id/brochure.pdf', async (req, res) => {
    const a = kindOnly(await access(req), 'listing');
    const l = await listingOf(a.ws.id);
    if (!l) throw bad('Record the property file first.');
    const co = (await pool.query('select * from company_profile where id = 1')).rows[0] || {};
    const imgs = [];
    for (const f of (await pool.query("select data, caption from files where workspace_id = $1 and entity = 'listing' and tag = 'published' and thumb is not null and archived_at is null order by uploaded_at limit 9", [a.ws.id])).rows) {
      try { imgs.push({ buf: await sharp(f.data).rotate().resize(900, 900, { fit: 'inside' }).jpeg({ quality: 78 }).toBuffer(), caption: f.caption || '' }); } catch { /* skip */ }
    }
    const rows = [['Type', l.property_type], ['Location', l.location], ['Land area', l.land_area_m2 == null ? null : `${Number(l.land_area_m2)} m²`], ['Built-up area', l.built_area_m2 == null ? null : `${Number(l.built_area_m2)} m²`],
      ['Unit / floor', l.unit_floor], ['Bedrooms', l.bedrooms], ['Bathrooms', l.bathrooms], ['Condition', l.condition], ['Features', l.features]].filter(x => x[1] !== null && x[1] !== undefined && x[1] !== '');
    const buf = await docs.render({ company: co, letterhead: co.letterhead, marginTop: co.margin_top_mm, marginBottom: co.margin_bottom_mm, title: 'Property for sale', number: a.ws.ref, toLabel: 'PROPERTY',
      to: [a.ws.name, l.location], meta: [['Asking price', l.asking_minor == null ? 'On request' : docs.money(Number(l.asking_minor), l.currency)], ['Negotiable', l.negotiable === 'unknown' ? '—' : l.negotiable], ['Prepared', fmtDate(todayBH())]],
      tables: [{ head: ['Detail', ''], widths: [0.3, 0.7], rows: rows.map(([k, v]) => [k, String(v)]) }], images: imgs,
      notes: [l.description, 'Information provided by the owner and checked by SarayDar as noted; buyers should make their own enquiries. Subject to availability.'] });
    await core.audit(null, { actor: req.user, workspaceId: a.ws.id, action: 'listing.brochure', entity: 'listing', entityId: a.ws.id, summary: 'Brochure PDF downloaded', ip: req.ip });
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': DL.disposition(DL.fileName([a.ws.ref, a.ws.name, 'Brochure'], 'pdf'), req.query.view === '1'), 'Cache-Control': 'private, no-store' }); res.end(buf);
  });

  // ---------- marketing ----------
  r.get('/w/:id/marketing', async (req, res) => {
    const a = kindOnly(await access(req), 'listing');
    const rows = (await pool.query("select m.*, coalesce(nullif(u.name,''), u.email) as agent from marketing_activities m left join users u on u.id = m.agent_id where m.workspace_id = $1 order by coalesce(m.published_on, m.created_at::date) desc", [a.ws.id])).rows;
    const M = await mandateState(a.ws.id);
    const spent = rows.filter(m => m.status !== 'cancelled').reduce((s, m) => s + Number(m.cost_minor || 0), 0);
    const edit = core.canContribute(a);
    res.send(page(req, a, 'Marketing', html`
      ${!M.canAct ? html`<div class="notice warn">New marketing needs an active mandate with verified authority (${M_LABEL[M.eff] || 'none'}).</div>` : ''}
      ${a.finance && M.cur ? html`<p class="small">Approved marketing budget ${fm(M.cur.marketing_budget_minor)} · recorded costs ${fm(spent)}${M.cur.marketing_budget_minor != null && spent > Number(M.cur.marketing_budget_minor) ? html` <span class="err">over budget</span>` : ''}</p>` : ''}
      <section class="panel"><h2 class="h">Marketing activity</h2>
        ${rows.length ? html`<div class="table-wrap"><table><thead><tr><th>Channel</th><th>Reference / link</th><th>Published</th><th>Agent</th>${a.finance ? html`<th class="n">Cost</th>` : ''}<th>Results</th><th>Status</th><th></th></tr></thead><tbody>
          ${rows.map(m => html`<tr><td>${m.channel}<div class="muted small">${m.description || ''}</div></td><td class="small">${m.reference || ''}${m.url ? html`<div><a href="${/^https?:\/\//.test(m.url) ? m.url : '#'}" rel="noopener noreferrer">${m.url.slice(0, 60)}</a></div>` : ''}</td>
            <td class="small">${m.published_on ? fmtDate(m.published_on) : '—'}${m.ended_on ? ` – ${fmtDate(m.ended_on)}` : ''}${m.evidence ? html`<div class="muted">${m.evidence}</div>` : ''}</td><td class="small">${m.agent || '—'}</td>${a.finance ? html`<td class="n">${fm(m.cost_minor)}</td>` : ''}<td class="small">${m.results || '—'}</td>
            <td>${pill({ planned: 'Planned', published: 'Published (recorded)', ended: 'Ended', cancelled: 'Cancelled' }[m.status], m.status === 'published' ? 'ok' : 'muted')}</td>
            <td>${edit && m.status === 'planned' ? html`<form method="post" action="/w/${a.ws.id}/marketing/${m.id}" class="actions">${csrfField(req)}<input type="hidden" name="to" value="published"><input type="date" name="on" value="${todayBH()}" aria-label="Published on" required><input name="evidence" placeholder="Evidence (link, screenshot ref)" aria-label="Evidence" required><button class="btn small" type="submit">Record published</button></form>` : ''}
              ${edit && m.status === 'published' ? html`<form method="post" action="/w/${a.ws.id}/marketing/${m.id}" class="actions">${csrfField(req)}<input type="hidden" name="to" value="ended"><input type="date" name="on" value="${todayBH()}" aria-label="Ended on" required><input name="results" placeholder="Results" aria-label="Results"><button class="btn small" type="submit">End</button></form>` : ''}</td></tr>`)}</tbody></table></div>` : html`<p class="muted">Nothing recorded yet.</p>`}
        ${edit && M.canAct ? html`<details class="inline-form"><summary>Plan a marketing activity</summary><form method="post" action="/w/${a.ws.id}/marketing" class="form-grid">${csrfField(req)}
          ${field({ name: 'channel', label: 'Channel', required: true, list: CH.MARKETING_CHANNELS })}${field({ name: 'reference', label: 'Listing / campaign reference' })}
          ${field({ name: 'url', label: 'Link' })}${a.finance ? field({ name: 'cost', label: 'Cost (BHD)' }) : ''}${field({ name: 'description', label: 'Description', full: true })}
          <div class="actions full"><button class="btn" type="submit">Save</button></div><p class="muted small full">The system does not post to portals or social media. Record publication only with evidence that it is live.</p></form></details>` : ''}
      </section>`));
  });
  r.post('/w/:id/marketing', async (req, res) => {
    const a = kindOnly(await access(req, 'contribute'), 'listing');
    await requireMandate(a.ws.id, 'Marketing');
    const ch = txt(req.body.channel, 120); if (!ch) throw bad('Enter the channel.');
    const url = txt(req.body.url, 500); if (url && !/^https?:\/\//i.test(url)) throw bad('Links must start with http:// or https://');
    await core.inTx(async db => {
      const id = (await db.query('insert into marketing_activities (workspace_id, channel, reference, url, description, cost_minor, agent_id, created_by) values ($1,$2,$3,$4,$5,$6,$7,$7) returning id',
        [a.ws.id, ch, txt(req.body.reference, 120), url, txt(req.body.description, 1000), a.finance ? moneyOrNull(req.body.cost, 'the cost') : null, req.user.id])).rows[0].id;
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'marketing.planned', entity: 'marketing', entityId: id, summary: `Marketing planned: ${ch}`, ip: req.ip });
    });
    res.redirect(`/w/${a.ws.id}/marketing?msg=added`);
  });
  r.post('/w/:id/marketing/:mid', async (req, res) => {
    const a = kindOnly(await access(req, 'contribute'), 'listing');
    const m = await own('marketing_activities', req.params.mid, a.ws.id);
    const on = dateOrNull(req.body.on); if (!on) throw bad('Enter the date.');
    await core.inTx(async db => {
      if (req.body.to === 'published') {
        if (m.status !== 'planned') throw bad('Not planned.');
        await requireMandate(a.ws.id, 'Publishing');
        const ev = txt(req.body.evidence, 300); if (!ev) throw bad('Record the evidence that it is live.');
        await db.query("update marketing_activities set status = 'published', published_on = $2, evidence = $3 where id = $1", [m.id, on, ev]);
      } else if (req.body.to === 'ended') {
        if (m.status !== 'published') throw bad('Not published.');
        await db.query("update marketing_activities set status = 'ended', ended_on = $2, results = coalesce($3, results) where id = $1", [m.id, on, txt(req.body.results, 500)]);
      } else throw bad('Unknown change.');
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: `marketing.${req.body.to}`, entity: 'marketing', entityId: m.id, summary: `Marketing ${m.channel}: ${req.body.to} on ${on}`, ip: req.ip });
    });
    res.redirect(`/w/${a.ws.id}/marketing?msg=saved`);
  });

  // ---------- acquisition brief ----------
  const BRIEF = [['purpose', 'Purpose', 'text'], ['types', 'Property types (comma-separated)', 'text'], ['locations', 'Locations (comma-separated)', 'text'], ['budget_min', 'Budget from (BHD)', 'money'], ['budget_max', 'Budget up to (BHD)', 'money'],
    ['flexibility_pct', 'Budget flexibility (%)', 'num'], ['land_min_m2', 'Land area from (m²)', 'num'], ['land_max_m2', 'Land area to (m²)', 'num'], ['built_min_m2', 'Built-up from (m²)', 'num'], ['built_max_m2', 'Built-up to (m²)', 'num'],
    ['bedrooms_min', 'Bedrooms (at least)', 'num'], ['features', 'Required features', 'text'], ['condition', 'Condition', 'text'], ['yield_note', 'Required yield (only if the client stated one)', 'text'], ['timing', 'Purchase timing', 'text'],
    ['funding', 'Funding (if supplied)', 'text'], ['exclusions', 'Exclusions / deal-breakers (comma-separated)', 'text'], ['decision_makers', 'Decision-makers', 'text']];
  const briefOf = async wsId => (await pool.query('select * from request_briefs where workspace_id = $1 order by version desc limit 1', [wsId])).rows[0] || null;
  const reqOf = async (wsId, db = pool) => { await db.query('insert into acq_requests (workspace_id) values ($1) on conflict do nothing', [wsId]); return (await db.query('select * from acq_requests where workspace_id = $1', [wsId])).rows[0]; };
  SL.briefOf = briefOf; SL.reqOf = reqOf;
  const briefVal = (b, k) => { if (!b) return ''; const col = k === 'budget_min' ? 'budget_min_minor' : k === 'budget_max' ? 'budget_max_minor' : k; const v = b[col]; if (v === null || v === undefined) return ''; return k.startsWith('budget') ? toInput(Number(v)) : String(v); };

  r.get('/w/:id/brief', async (req, res) => {
    const a = kindOnly(await access(req), 'request');
    const versions = (await pool.query("select b.*, coalesce(nullif(u.name,''), u.email) as by from request_briefs b left join users u on u.id = b.created_by where b.workspace_id = $1 order by version desc", [a.ws.id])).rows;
    const b = versions[0] || null;
    const rq = await reqOf(a.ws.id);
    const edit = core.canEdit(a);
    const show = (k, label) => { const v = briefVal(b, k); return html`<div><dt>${label}</dt><dd>${b && b.unknown.includes(k) ? pill('Not stated', 'info') : v ? (k.startsWith('budget') ? fm(Number(b[k + '_minor']), b.currency) : v) : html`<span class="muted">—</span>`}</dd></div>`; };
    res.send(page(req, a, 'Brief', html`
      <div class="split"><section class="panel grow2"><h2 class="h">Buyer brief ${b ? `v${b.version}` : ''} ${pill(R_STATUS[rq.status], ['completed'].includes(rq.status) ? 'ok' : rq.status === 'closed_unsuccessful' ? 'muted' : 'info')}</h2>
        ${b ? html`<dl class="details">${BRIEF.map(([k, l]) => show(k, l))}</dl>${b.change_reason ? html`<p class="muted small">Last change: ${b.change_reason}${b.evidence ? ` (${b.evidence})` : ''}</p>` : ''}` : html`<p class="muted">No brief recorded yet.</p>`}
        ${edit ? html`<details class="inline-form" ${b ? '' : raw('open')}><summary>${b ? 'Change the brief (new version)' : 'Record the brief'}</summary><form method="post" action="/w/${a.ws.id}/brief" class="form-grid">${csrfField(req)}
          ${BRIEF.map(([k, l]) => html`<div class="q">${field({ name: k, label: l, value: briefVal(b, k) })}<label class="check small"><input type="checkbox" name="${k}__unknown" value="1" ${b && b.unknown.includes(k) ? raw('checked') : ''}> Not stated</label></div>`)}
          ${b ? html`${field({ name: 'change_reason', label: 'Why it changed', required: true })}${field({ name: 'evidence', label: 'Client decision / evidence' })}` : ''}
          <div class="actions full"><button class="btn primary" type="submit">Save brief</button></div><p class="muted small full">Earlier versions are kept. Leave unknown values empty — matching treats them as unknown, not as a match.</p></form></details>` : ''}
      </section>
      <section class="panel grow1"><h2 class="h">Request status</h2>
        ${edit ? html`<form method="post" action="/w/${a.ws.id}/request/status" class="form-grid">${csrfField(req)}${field({ name: 'to', label: 'Status', value: rq.status, options: Object.entries(R_STATUS).filter(([k]) => k !== 'completed') })}${field({ name: 'reason', label: 'Reason / note', required: true })}
          <div class="actions full"><button class="btn small" type="submit">Update</button></div><p class="muted small full">“Completed” is set by a completed deal.</p></form>` : ''}
        ${versions.length > 1 ? html`<h3 class="h3">Brief history</h3><ol class="feed">${versions.map(v => html`<li><b>v${v.version}</b> · ${fmtDateTime(v.created_at)}<div class="muted small">${v.change_reason || 'Original brief'} · ${v.by || ''}</div></li>`)}</ol>` : ''}
      </section></div>`));
  });

  r.post('/w/:id/brief', async (req, res) => {
    const a = kindOnly(await access(req, 'edit'), 'request');
    const b = req.body, v = {}, unknown = [];
    for (const [k, l, t] of BRIEF) {
      if (b[`${k}__unknown`] === '1') { unknown.push(k); continue; }
      const raw0 = b[k];
      if (t === 'money') v[`${k}_minor`] = moneyOrNull(raw0, l);
      else if (t === 'num') v[k] = numOrNull(raw0, l);
      else v[k] = txt(raw0, 1000);
    }
    if (v.budget_min_minor != null && v.budget_max_minor != null && v.budget_max_minor < v.budget_min_minor) throw bad('The budget maximum is below the minimum.');
    const prev = await briefOf(a.ws.id);
    if (prev && !txt(b.change_reason, 300)) throw bad('Say why the brief changed.');
    await core.inTx(async db => {
      await db.query('select id from workspaces where id = $1 for update', [a.ws.id]);
      const ver = (await db.query('select coalesce(max(version),0)+1 as v from request_briefs where workspace_id = $1', [a.ws.id])).rows[0].v;
      const cols = Object.keys(v);
      await db.query(`insert into request_briefs (workspace_id, version, unknown, change_reason, evidence, created_by, ${cols.join(', ')}) values ($1,$2,$3,$4,$5,$6,${cols.map((c, i) => `$${i + 7}`).join(',')})`, [a.ws.id, ver, unknown, txt(b.change_reason, 300), txt(b.evidence, 300), req.user.id, ...cols.map(c => v[c])]);
      const rq = await reqOf(a.ws.id, db);
      if (rq.status === 'draft') await db.query("update acq_requests set status = 'brief_confirmed', updated_at = now() where workspace_id = $1", [a.ws.id]);
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'request.brief', entity: 'request', entityId: a.ws.id, summary: `Buyer brief v${ver} saved${prev ? `: ${txt(b.change_reason, 300)}` : ''}`, ip: req.ip });
      await touch(db, a.ws.id);
    });
    res.redirect(`/w/${a.ws.id}/brief?msg=saved`);
  });

  r.post('/w/:id/request/status', async (req, res) => {
    const a = kindOnly(await access(req, 'edit'), 'request');
    const to = R_STATUS[req.body.to] && req.body.to !== 'completed' ? req.body.to : null; const reason = txt(req.body.reason, 300);
    if (!to || !reason) throw bad('Choose the status and give a reason.');
    await core.inTx(async db => {
      const rq = await reqOf(a.ws.id, db);
      if (rq.status === 'completed') throw bad('This request is completed.');
      await db.query('update acq_requests set status = $2, status_reason = $3, updated_at = now() where workspace_id = $1', [a.ws.id, to, reason]);
      if (to === 'closed_unsuccessful') await db.query("update workspaces set status = 'completed' where id = $1", [a.ws.id]);
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'request.status', entity: 'request', entityId: a.ws.id, summary: `Request ${R_STATUS[rq.status]} → ${R_STATUS[to]}: ${reason}`, ip: req.ip });
    });
    res.redirect(`/w/${a.ws.id}/brief?msg=saved`);
  });

  // ---------- matches, external opportunities, shortlist ----------
  async function candidates(user) {
    return (await pool.query(`select w.id, w.ref, w.name, l.* from workspaces w join listings l on l.workspace_id = w.id
      where w.section = 'sales' and w.kind = 'listing' and l.status in ('available', 'ready') and ${core.visibleWhere(user)} order by w.updated_at desc limit 500`, [user.id])).rows;
  }
  SL.candidates = candidates;

  r.get('/w/:id/shortlist', async (req, res) => {
    const a = kindOnly(await access(req), 'request');
    const b = await briefOf(a.ws.id);
    const cands = await candidates(req.user);
    const ext = (await pool.query('select * from external_opps where workspace_id = $1 order by created_at desc', [a.ws.id])).rows;
    const items = (await pool.query(`select s.*, w.name as l_name, w.ref as l_ref, l.asking_minor, l.status as l_status, l.currency, e.title as e_title, e.price_minor as e_price, e.availability, e.checked_on, e.source
      from shortlist_items s left join workspaces w on w.id = s.listing_ws left join listings l on l.workspace_id = s.listing_ws left join external_opps e on e.id = s.external_id where s.workspace_id = $1 order by s.rank, s.created_at`, [a.ws.id])).rows;
    const onList = new Set(items.map(i => i.listing_ws || i.external_id));
    const res2 = b ? cands.map(c => ({ c, m: matching.match(b, c) })).sort((x, y) => y.m.counts.match - x.m.counts.match || x.m.counts.no - y.m.counts.no) : [];
    const edit = core.canContribute(a);
    const st = s => s === 'match' ? pill('✓', 'ok') : s === 'no' ? pill('✗', 'bad') : pill('?', 'muted');
    res.send(page(req, a, 'Matches & Shortlist', html`
      <section class="panel"><h2 class="h">Shortlist</h2>
        ${items.length ? html`<div class="table-wrap"><table><thead><tr><th>#</th><th>Option</th><th class="n">Price</th><th>Availability rechecked</th><th>Reason</th><th>Client feedback</th><th>Status</th><th></th></tr></thead><tbody>
          ${items.map(i => html`<tr><td>${i.rank}</td><td>${i.listing_ws ? html`<a href="/w/${i.listing_ws}">${i.l_name}</a><div class="muted small">${i.l_ref} · SarayDar listing · ${L_STATUS[i.l_status] || ''}</div>` : html`<b>${i.e_title}</b><div class="muted small">External · ${i.source} · ${i.availability}${i.checked_on ? ` (checked ${fmtDate(i.checked_on)})` : ''}</div>`}</td>
            <td class="n">${fm(i.listing_ws ? i.asking_minor : i.e_price)}</td><td class="small">${i.rechecked_on ? `${fmtDate(i.rechecked_on)} · ${fm(i.rechecked_price_minor)}` : html`<span class="warn-text">Not rechecked</span>`}</td>
            <td class="small">${i.reason || ''}${i.internal_notes ? html`<div class="muted">Internal: ${i.internal_notes}</div>` : ''}</td><td class="small">${i.client_feedback || '—'}${i.rejection_reason ? html`<div class="muted">Rejected: ${i.rejection_reason}</div>` : ''}</td>
            <td>${pill(i.status, i.status === 'selected' ? 'ok' : i.status === 'rejected' ? 'muted' : i.published ? 'info' : 'warn')}${i.published ? html`<div class="small">published</div>` : ''}</td>
            <td>${edit ? html`<details class="inline-form"><summary class="small">Update</summary><form method="post" action="/w/${a.ws.id}/shortlist/${i.id}" class="form-grid">${csrfField(req)}
              ${field({ name: 'rechecked_on', label: 'Availability rechecked on', type: 'date', value: i.rechecked_on ? String(i.rechecked_on) : '' })}${field({ name: 'rechecked_price', label: 'Current price (BHD)', value: i.rechecked_price_minor == null ? '' : toInput(Number(i.rechecked_price_minor)) })}
              ${field({ name: 'status', label: 'Status', value: i.status, options: [['proposed', 'Proposed'], ['shared', 'Shared with client'], ['selected', 'Selected by client'], ['rejected', 'Rejected'], ['withdrawn', 'Withdrawn']] })}
              ${field({ name: 'rank', label: 'Rank', type: 'number', value: i.rank })}${field({ name: 'client_feedback', label: 'Client feedback (received outside the portal)', value: i.client_feedback || '' })}${field({ name: 'rejection_reason', label: 'Rejection reason', value: i.rejection_reason || '' })}
              <label class="field check"><input type="checkbox" name="published" value="1" ${i.published ? raw('checked') : ''}> <span>Publish to the client's view</span></label>
              <div class="actions full"><button class="btn small" type="submit">Save</button></div><p class="muted small full">Publishing needs a recheck of availability and price within the last 14 days. A shortlist is not a reservation.</p></form></details>` : ''}</td></tr>`)}</tbody></table></div>`
          : html`<p class="muted">No options shortlisted yet.</p>`}
      </section>
      ${ctx.marketPanel ? await ctx.marketPanel(req, a, b) : ''}
      <section class="panel"><h2 class="h">Internal listings checked against the brief</h2>
        ${!b ? html`<p class="muted">Record the brief first.</p>` : res2.length ? html`<div class="table-wrap"><table><thead><tr><th>Listing</th><th>Criteria</th><th>Result</th><th></th></tr></thead><tbody>
          ${res2.map(({ c, m }) => html`<tr><td><a href="/w/${c.id}">${c.name}</a><div class="muted small">${c.ref} · ${fm(c.asking_minor, c.currency)} · updated ${fmtDate(c.updated_at)}</div></td>
            <td class="small">${m.criteria.map(x => html`<div>${st(x.state)} ${x.label}: <span class="muted">${x.detail}</span></div>`)}</td>
            <td>${m.counts.match} matched · ${m.counts.no} not · ${m.counts.unknown} unknown${m.eligible ? '' : html`<div class="muted small">has a mismatch</div>`}</td>
            <td>${edit && !onList.has(c.id) ? html`<form method="post" action="/w/${a.ws.id}/shortlist" class="actions">${csrfField(req)}<input type="hidden" name="listing_ws" value="${c.id}"><input name="reason" placeholder="Why" aria-label="Reason"><button class="btn small" type="submit">Shortlist</button></form>` : onList.has(c.id) ? pill('On shortlist', 'info') : ''}</td></tr>`)}</tbody></table></div>
          <p class="muted small">Only SarayDar listings you can open that are ready or available. Criteria are compared as recorded; nothing is scored or estimated. Prices in other currencies are not converted.</p>` : html`<p class="muted">No available internal listings.</p>`}
      </section>
      <section class="panel"><h2 class="h">External opportunities</h2>
        ${ext.length ? html`<div class="table-wrap"><table><thead><tr><th>Opportunity</th><th>Source</th><th class="n">Price</th><th>Verified</th><th>Availability</th><th>Arrangement</th>${b ? html`<th>Match</th>` : ''}<th></th></tr></thead><tbody>
          ${ext.map(e => { const m = b ? matching.match(b, { ...e, status: e.availability }) : null; return html`<tr><td><b>${e.title}</b><div class="muted small">${[e.property_type, e.location].filter(Boolean).join(' · ')}</div></td><td class="small">${e.source}${e.source_contact ? html`<div class="muted">${e.source_contact}</div>` : ''}</td><td class="n">${fm(e.price_minor, e.currency)}</td>
            <td>${pill(e.verification, e.verification === 'verified' ? 'ok' : 'warn')}<div class="muted small">${e.checked_on ? `checked ${fmtDate(e.checked_on)}` : 'not checked'}</div></td><td>${e.availability}</td><td class="small">${e.arrangement || 'None documented'}</td>
            ${m ? html`<td class="small">${m.counts.match}✓ ${m.counts.no}✗ ${m.counts.unknown}?</td>` : ''}<td>${edit && !onList.has(e.id) ? html`<form method="post" action="/w/${a.ws.id}/shortlist" class="actions">${csrfField(req)}<input type="hidden" name="external_id" value="${e.id}"><button class="btn small" type="submit">Shortlist</button></form>` : ''}</td></tr>`; })}</tbody></table></div>` : html`<p class="muted">None recorded.</p>`}
        ${edit ? html`<details class="inline-form"><summary>Record an external opportunity</summary><form method="post" action="/w/${a.ws.id}/external" class="form-grid">${csrfField(req)}
          ${field({ name: 'title', label: 'Property', required: true })}${field({ name: 'source', label: 'Source (owner, agent, other)', required: true })}${field({ name: 'source_contact', label: 'Source contact' })}
          ${field({ name: 'property_type', label: 'Type', options: [['', '—'], ...PTYPES.map(t => [t, t])] })}${field({ name: 'location', label: 'Location', list: CH.BH_AREAS })}${field({ name: 'price', label: 'Price (BHD)' })}
          ${field({ name: 'land_area_m2', label: 'Land area (m²)' })}${field({ name: 'built_area_m2', label: 'Built-up (m²)' })}${field({ name: 'bedrooms', label: 'Bedrooms' })}
          ${field({ name: 'verification', label: 'Property / price verified', options: [['unverified', 'Not verified'], ['verified', 'Verified']] })}${field({ name: 'checked_on', label: 'Date checked', type: 'date', value: todayBH() })}
          ${field({ name: 'availability', label: 'Availability', options: [['unknown', 'Unknown'], ['available', 'Available'], ['under_offer', 'Under offer'], ['sold', 'Sold']] })}
          ${field({ name: 'arrangement', label: 'Referral / co-broker arrangement (documented)', full: true })}${field({ name: 'notes', label: 'Notes', full: true })}
          <div class="actions full"><button class="btn" type="submit">Save</button></div><p class="muted small full">An external opportunity is not a SarayDar listing and carries no mandate.</p></form></details>` : ''}
      </section>`));
  });

  r.post('/w/:id/external', async (req, res) => {
    const a = kindOnly(await access(req, 'contribute'), 'request');
    const b = req.body; const title = txt(b.title, 200), source = txt(b.source, 160);
    if (!title || !source) throw bad('Enter the property and the source.');
    await core.inTx(async db => {
      const id = (await db.query(`insert into external_opps (workspace_id, title, source, source_contact, property_type, location, price_minor, land_area_m2, built_area_m2, bedrooms, verification, checked_on, availability, arrangement, notes, created_by)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) returning id`, [a.ws.id, title, source, txt(b.source_contact, 160), PTYPES.includes(b.property_type) ? b.property_type : null, txt(b.location, 200), moneyOrNull(b.price, 'the price'),
        numOrNull(b.land_area_m2, 'Land area'), numOrNull(b.built_area_m2, 'Built-up'), numOrNull(b.bedrooms, 'Bedrooms'), b.verification === 'verified' ? 'verified' : 'unverified', dateOrNull(b.checked_on),
        ['available', 'under_offer', 'sold'].includes(b.availability) ? b.availability : 'unknown', txt(b.arrangement, 500), txt(b.notes, 1000), req.user.id])).rows[0].id;
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'request.external_recorded', entity: 'external_opp', entityId: id, summary: `External opportunity recorded: ${title} (${source})`, ip: req.ip });
    });
    res.redirect(`/w/${a.ws.id}/shortlist?msg=added`);
  });

  r.post('/w/:id/shortlist', async (req, res) => {
    const a = kindOnly(await access(req, 'contribute'), 'request');
    let listing = null, ext = null;
    if (UUID.test(req.body.listing_ws || '')) { listing = (await candidates(req.user)).find(c => c.id === req.body.listing_ws); if (!listing) throw bad('That listing is not available to you.'); }
    else if (UUID.test(req.body.external_id || '')) ext = await own('external_opps', req.body.external_id, a.ws.id);
    else throw bad('Choose an option.');
    try {
      await core.inTx(async db => {
        const rank = (await db.query('select coalesce(max(rank),0)+1 as r from shortlist_items where workspace_id = $1', [a.ws.id])).rows[0].r;
        const id = (await db.query('insert into shortlist_items (workspace_id, listing_ws, external_id, rank, reason, created_by) values ($1,$2,$3,$4,$5,$6) returning id', [a.ws.id, listing && listing.id, ext && ext.id, rank, txt(req.body.reason, 300), req.user.id])).rows[0].id;
        await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'shortlist.added', entity: 'shortlist', entityId: id, summary: `Shortlisted: ${listing ? listing.name : ext.title}`, ip: req.ip });
        // the listing's own case sees the interest as an opportunity for the buyer (no client data is shown to the seller)
        if (listing && a.ws.party_id) await db.query("insert into opportunities (party_id, listing_ws, request_ws, stage, source, agent_id, created_by) values ($1,$2,$3,'matched','Acquisition request',$4,$4) on conflict do nothing", [a.ws.party_id, listing.id, a.ws.id, req.user.id]);
        const rq = await reqOf(a.ws.id, db);
        if (['brief_confirmed', 'draft'].includes(rq.status)) await db.query("update acq_requests set status = 'searching' where workspace_id = $1", [a.ws.id]);
      });
    } catch (e) { if (e.code === '23505') throw bad('Already on the shortlist.'); throw e; }
    res.redirect(`/w/${a.ws.id}/shortlist?msg=added`);
  });

  r.post('/w/:id/shortlist/:sid', async (req, res) => {
    const a = kindOnly(await access(req, 'contribute'), 'request');
    const i = await own('shortlist_items', req.params.sid, a.ws.id);
    const b = req.body;
    const rechecked = dateOrNull(b.rechecked_on);
    const publish = b.published === '1';
    if (publish && (!rechecked || rechecked < new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10))) throw bad('Recheck availability and the current price (within 14 days) before publishing to the client.');
    if (publish && i.listing_ws) { const l = await listingOf(i.listing_ws); if (!l || !['available', 'ready'].includes(l.status)) throw bad('That listing is no longer available.'); }
    const status = ['proposed', 'shared', 'selected', 'rejected', 'withdrawn'].includes(b.status) ? b.status : i.status;
    if (status === 'rejected' && !txt(b.rejection_reason, 300)) throw bad('Give the rejection reason.');
    await core.inTx(async db => {
      await db.query(`update shortlist_items set rechecked_on = $2, rechecked_price_minor = $3, status = $4, rank = $5, client_feedback = $6, rejection_reason = $7, published = $8, published_at = case when $8 and not published then now() else published_at end where id = $1`,
        [i.id, rechecked, moneyOrNull(b.rechecked_price, 'the price'), status, parseInt(b.rank, 10) || i.rank, txt(b.client_feedback, 1000), txt(b.rejection_reason, 300), publish]);
      if (publish && !i.published) { const rq = await reqOf(a.ws.id, db); if (['searching', 'brief_confirmed'].includes(rq.status)) await db.query("update acq_requests set status = 'shortlist_shared' where workspace_id = $1", [a.ws.id]); }
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'shortlist.updated', entity: 'shortlist', entityId: i.id, summary: `Shortlist option updated: ${status}${publish ? ', published to client' : ''}`, ip: req.ip });
    });
    res.redirect(`/w/${a.ws.id}/shortlist?msg=saved`);
  });

  // ---------- deal workspace ----------
  r.get('/w/:id/checklist', async (req, res) => {
    const a = kindOnly(await access(req), 'deal');
    const items = (await pool.query("select c.*, coalesce(nullif(u.name,''), u.email) as by from deal_checklist c left join users u on u.id = c.done_by where c.workspace_id = $1 order by c.sort, c.created_at", [a.ws.id])).rows;
    const files = await uploads.list(pool, a.ws.id, 'deal_item', items.map(i => i.id));
    const edit = core.canContribute(a);
    const today = todayBH();
    res.send(page(req, a, 'Checklist', html`
      <section class="panel"><h2 class="h">Due diligence and closing checklist</h2>
        <p class="muted small">Adjust this list to the transaction. It does not state legal requirements; confirm them with the relevant professionals and authorities.</p>
        <div class="table-wrap"><table><thead><tr><th>Item</th><th>Owner</th><th>Due</th><th>Depends on</th><th>Status</th><th></th></tr></thead><tbody>
          ${items.map(i => { const dep = items.find(x => x.id === i.depends_on); const fs = files.filter(f => f.entity_id === i.id); return html`<tr><td>${i.title}${i.notes ? html`<div class="muted small">${i.notes}</div>` : ''}${fs.length ? html`<div class="small">${fs.map(f => html`<a href="/files/${f.id}">${f.original_name}</a> `)}</div>` : ''}</td>
            <td class="small">${i.owner || '—'}</td><td class="small ${i.status === 'open' && i.due_on && String(i.due_on) < today ? 'err' : ''}">${fmtDate(i.due_on) || '—'}</td><td class="small">${dep ? dep.title : '—'}</td>
            <td>${pill(i.status === 'not_applicable' ? 'N/A' : i.status, i.status === 'done' ? 'ok' : i.status === 'open' ? 'warn' : 'muted')}${i.done_on ? html`<div class="muted small">${fmtDate(i.done_on)} · ${i.by || ''}</div>` : ''}</td>
            <td>${edit && i.status === 'open' ? html`<details class="inline-form"><summary class="small">Update</summary><form method="post" action="/w/${a.ws.id}/checklist/${i.id}" enctype="multipart/form-data" class="form-grid"><input type="hidden" name="_csrf" value="${req.csrfToken}">
              ${field({ name: 'status', label: 'Status', options: [['open', 'Open'], ['done', 'Done'], ['not_applicable', 'Not applicable']] })}${field({ name: 'owner', label: 'Owner', value: i.owner || '' })}${field({ name: 'due_on', label: 'Due', type: 'date', value: i.due_on ? String(i.due_on) : '' })}
              <label class="field"><span>Evidence</span><input type="file" name="files" multiple></label>${field({ name: 'notes', label: 'Notes', value: i.notes || '', full: true })}<div class="actions full"><button class="btn small" type="submit">Save</button></div></form></details>` : ''}</td></tr>`; })}
        </tbody></table></div>
        ${edit ? html`<details class="inline-form"><summary>Add an item</summary><form method="post" action="/w/${a.ws.id}/checklist" class="form-grid">${csrfField(req)}
          ${field({ name: 'title', label: 'Item', required: true })}${field({ name: 'owner', label: 'Owner' })}${field({ name: 'due_on', label: 'Due', type: 'date' })}
          ${field({ name: 'depends_on', label: 'Depends on', options: [['', '—'], ...items.map(i => [i.id, i.title])] })}<div class="actions full"><button class="btn" type="submit">Add</button></div></form></details>` : ''}
      </section>`));
  });
  r.post('/w/:id/checklist', async (req, res) => {
    const a = kindOnly(await access(req, 'contribute'), 'deal');
    const title = txt(req.body.title, 200); if (!title) throw bad('Enter the item.');
    const dep = UUID.test(req.body.depends_on || '') ? (await own('deal_checklist', req.body.depends_on, a.ws.id)).id : null;
    await core.inTx(async db => {
      const s = (await db.query('select coalesce(max(sort),0)+1 as s from deal_checklist where workspace_id = $1', [a.ws.id])).rows[0].s;
      await db.query('insert into deal_checklist (workspace_id, title, owner, due_on, depends_on, sort) values ($1,$2,$3,$4,$5,$6)', [a.ws.id, title, txt(req.body.owner, 120), dateOrNull(req.body.due_on), dep, s]);
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'deal.checklist_added', entity: 'deal', entityId: a.ws.id, summary: `Checklist item added: ${title}`, ip: req.ip });
    });
    res.redirect(`/w/${a.ws.id}/checklist?msg=added`);
  });
  r.post('/w/:id/checklist/:cid', upload.array('files', 10), async (req, res) => {
    if (!core.checkCsrf(req)) throw new Forbidden('Your form expired. Reload the page and try again.');
    const a = kindOnly(await access(req, 'contribute'), 'deal');
    const i = await own('deal_checklist', req.params.cid, a.ws.id);
    const st = ['open', 'done', 'not_applicable'].includes(req.body.status) ? req.body.status : 'open';
    const files = await uploads.prepare(req.files, sniff);
    await core.inTx(async db => {
      if (st === 'done' && i.depends_on) { const d = (await db.query('select title, status from deal_checklist where id = $1', [i.depends_on])).rows[0]; if (d && d.status === 'open') throw bad(`“${d.title}” must be done first.`); }
      await db.query('update deal_checklist set status = $2, owner = $3, due_on = $4, notes = $5, done_on = case when $2 = \'done\' then $6::date else null end, done_by = case when $2 = \'done\' then $7::uuid else null end where id = $1',
        [i.id, st, txt(req.body.owner, 120), dateOrNull(req.body.due_on), txt(req.body.notes, 1000), todayBH(), req.user.id]);
      await uploads.insert(db, { workspaceId: a.ws.id, entity: 'deal_item', entityId: i.id, files, userId: req.user.id, tag: 'evidence' });
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'deal.checklist', entity: 'deal', entityId: a.ws.id, summary: `Checklist “${i.title}”: ${st}${files.length ? ` with ${files.length} file(s)` : ''}`, ip: req.ip });
    });
    res.redirect(`/w/${a.ws.id}/checklist?msg=saved`);
  });

  ctx.defaultChecklist = DEFAULT_CHECKLIST;
  return SL;
}

module.exports = { mountSalesCases, L_STATUS, R_STATUS, PTYPES };
