'use strict';
const U = require('../lib/undo');
// Clients Properties Management: property set-up (how money flows, limits, owners), units, tenants and leases,
// opening balances, and the property overview/portfolio figures. Rent, payments and deposits are in rent.js;
// maintenance, expenses and services in maintenance.js; owner account, unit history and reports in owner.js.
const multer = require('multer');
const { layout, html, raw, pill, statusPill, csrfField, field, emptyState, fmtDate, fmtDateTime } = require('./views');
const { SECTIONS, KIND_LABEL } = require('./core');
const { parseMoney, formatMoney, toInput, num } = require('../lib/money');
const rentLib = require('../lib/rent');
const billing = require('../lib/billing');
const uploads = require('../lib/uploads');
const { addDays } = require('../lib/fees');
const { sniff } = require('./workspaces');

const UUID = /^[0-9a-f-]{36}$/i;
const bad = m => Object.assign(new Error(m), { status: 400 });
const txt = (v, n = 300) => { const s = String(v ?? '').trim().slice(0, n); return s || null; };
const dateOrNull = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : null;
const todayBH = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bahrain' });
const fm = (m, c = 'BHD') => m === null || m === undefined ? '—' : formatMoney(Number(m), c);
const UNIT_STATUS = { available: 'Available', reserved: 'Reserved', occupied: 'Occupied', maintenance: 'Under maintenance', unavailable: 'Unavailable' };
const UNIT_TONE = { available: 'info', reserved: 'warn', occupied: 'ok', maintenance: 'warn', unavailable: 'muted' };
const LEASE_TONE = { draft: 'muted', active: 'ok', ended: 'info', terminated: 'warn', cancelled: 'muted' };
const PTYPE = { residential_building: 'Residential building', apartment: 'Apartment', villa: 'Villa', commercial: 'Commercial', mixed_use: 'Mixed use', other: 'Other' };
const HOLDER = { saraydar: 'SarayDar', owner: 'The owner', other: 'Another party' };
const FREQ = { 1: 'Monthly', 3: 'Quarterly', 6: 'Every 6 months', 12: 'Yearly' };
const EVENT = { move_in: 'Move-in inspection / handover', move_out: 'Move-out inspection', inspection: 'Inspection', keys: 'Keys', meter: 'Meter reading', notice: 'Notice', amendment: 'Amendment', other: 'Other' };
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 12, fields: 40 } });

function mountProperties(r, ctx) {
  const { pool, core, NotFound, Forbidden } = ctx;

  // ---------- access, tabs, page ----------
  async function access(req, need = 'view') {
    const a = await core.workspaceAccess(req.user, req.params.id);
    if (!a || a.ws.section !== 'props') throw new NotFound();
    if (!a.internal) throw new NotFound();                 // owner and tenant views arrive with the Phase 7 portals
    if (need === 'edit' && !core.canEdit(a)) throw new Forbidden('Only the property manager or an editor can do this.');
    if (need === 'contribute' && !core.canContribute(a)) throw new Forbidden('Your role in this property is view-only.');
    a.finance = core.isSuper(req.user) || a.role === 'manager' || a.role === 'editor' || await core.can(req.user, 'view:financials');
    a.canPost = core.isSuper(req.user) || await core.can(req.user, 'finance:post');
    if (need === 'finance' && !a.finance) throw new NotFound();
    if (need === 'post') { if (!a.finance) throw new NotFound(); if (!a.canPost) throw new Forbidden('Only Finance can do this.'); }
    return a;
  }
  // routes shared in path with development projects fall through when the workspace is not a property
  async function isProps(req) {
    if (!UUID.test(req.params.id || '')) return false;
    return (await pool.query("select 1 from workspaces where id = $1 and section = 'props'", [req.params.id])).rowCount > 0;
  }
  function tabs(a, cur) {
    const id = a.ws.id, f = a.finance !== false;
    return [['Overview', `/w/${id}`], ['Owner', `/w/${id}/client`], ['Agreements', `/w/${id}/agreements`], ['Property Setup', `/w/${id}/property`], ['Units', `/w/${id}/units`], ['Leases & Tenants', `/w/${id}/leases`],
      ...(f ? [['Rent & Collections', `/w/${id}/rent`], ['Deposits', `/w/${id}/deposits`]] : []), ['Maintenance', `/w/${id}/maintenance`], ['Cleaning & Services', `/w/${id}/services`],
      ...(f ? [['Expenses', `/w/${id}/expenses`], ['Owner Account', `/w/${id}/owner`], ['Fee Billing', `/w/${id}/fees`]] : []), ['Unit History', `/w/${id}/history`], ['Reports', `/w/${id}/reports`],
      ['Documents', `/w/${id}/documents`], ['Access & Invitations', `/w/${id}/access`], ['Activity', `/w/${id}/activity`]].map(([l, h]) => [l, h, l === cur]);
  }
  ctx.tabsFor = ctx.tabsFor || {};
  ctx.tabsFor.props = (a, cur) => tabs({ ...a, finance: a.finance }, cur);
  function page(req, a, cur, body, extraCrumb = null) {
    const w = a.ws, s = SECTIONS[w.section];
    return layout(req, { title: `${extraCrumb || cur} · ${w.name}`, heading: w.name, tabs: tabs(a, cur),
      crumbs: [['Home', '/'], [s.name, `/s/${w.section}`], [w.name, `/w/${w.id}`], ...(extraCrumb ? [[cur, null], [extraCrumb]] : [[cur]])],
      sub: { above: `${w.ref} · ${KIND_LABEL[w.kind]}`, below: w.location || '', badge: statusPill(w.status) }, body });
  }
  const own = async (table, id, wsId) => {
    if (!UUID.test(String(id))) throw new NotFound();
    const row = (await pool.query(`select * from ${table} where id = $1 and workspace_id = $2`, [id, wsId])).rows[0];
    if (!row) throw new NotFound();
    return row;
  };
  const touch = (db, wsId) => db.query('update workspaces set updated_at = now() where id = $1', [wsId]);
  const profileOf = async (wsId, db = pool) => (await db.query('select * from property_profiles where workspace_id = $1', [wsId])).rows[0] || { rent_collector: 'saraydar', deposit_holder: 'saraydar', supplier_payer: 'saraydar', owner_transfers: 'saraydar', fee_deduction_allowed: false, reserve_minor: 0, billing_entity: 'owner', _missing: true };
  const unitsOf = async wsId => (await pool.query('select * from units where workspace_id = $1 and archived_at is null order by sort, ref', [wsId])).rows;
  const leaseLabel = l => `${l.ref} · ${l.tenant_name || ''}`;

  const PR = { access, page, own, touch, profileOf, unitsOf, isProps, tabs, UNIT_STATUS, HOLDER, FREQ };
  ctx.PR = PR;

  // ---------- Property Setup: profile, owners, opening balances ----------
  r.get('/w/:id/property', async (req, res) => {
    const a = await access(req);
    const p = await profileOf(a.ws.id);
    const edit = core.canEdit(a);
    const owners = (await pool.query('select o.*, p.name, p.phone, p.email from property_owners o join parties p on p.id = o.party_id where o.workspace_id = $1 order by o.is_primary desc, p.name', [a.ws.id])).rows;
    const primary = a.ws.party_id ? (await pool.query('select id, name, phone, email from parties where id = $1', [a.ws.party_id])).rows[0] : null;
    const ownersAll = (await pool.query("select id, name from parties where 'owner' = any(roles) and archived_at is null order by name limit 500")).rows;
    const ob = a.finance ? (await pool.query('select o.*, l.ref as lease_ref, t.name as tenant_name from opening_balances o left join leases l on l.id = o.lease_id left join parties t on t.id = l.tenant_id where o.workspace_id = $1 order by o.created_at', [a.ws.id])).rows : [];
    const leases = a.finance ? (await pool.query("select l.id, l.ref, t.name as tenant_name from leases l join parties t on t.id = l.tenant_id where l.workspace_id = $1 and l.status in ('active','ended','terminated') order by l.ref", [a.ws.id])).rows : [];
    const sel = (k, opts, label, hint = '') => field({ name: k, label, value: p[k] ?? '', options: Object.entries(opts), hint });
    const id = a.ws.id;
    const shareSum = owners.reduce((s, o) => s + (o.share_pct === null ? 0 : Number(o.share_pct)), 0);
    res.send(page(req, a, 'Property Setup', html`
      ${p._missing ? html`<div class="notice warn">Record how this property is run before leases and money are entered: who collects rent, who holds deposits, who pays suppliers, spending limits and reserves.</div>` : ''}
      <section class="panel"><h2 class="h">Property and money arrangement</h2>
        ${p._missing ? '' : html`<dl class="details">
          <div><dt>Type</dt><dd>${PTYPE[p.property_type] || '—'}</dd></div><div><dt>Address</dt><dd class="pre-line">${p.address || '—'}</dd></div>
          <div><dt>Facilities</dt><dd class="pre-line">${p.facilities || '—'}</dd></div>
          <div><dt>Rent is collected by</dt><dd>${HOLDER[p.rent_collector]}</dd></div><div><dt>Deposits are held by</dt><dd>${HOLDER[p.deposit_holder]}</dd></div>
          <div><dt>Suppliers are paid by</dt><dd>${p.supplier_payer === 'saraydar' ? 'SarayDar, from funds held for the owner' : 'The owner directly'}</dd></div>
          <div><dt>Owner transfers</dt><dd>${p.owner_transfers === 'saraydar' ? 'SarayDar transfers proceeds to the owner (recorded, not executed by the system)' : 'Not applicable (owner collects)'}</dd></div>
          <div><dt>SarayDar fee deducted from rent</dt><dd>${p.fee_deduction_allowed ? 'Allowed by the owner' : 'Not allowed — the owner pays fee invoices'}</dd></div>
          <div><dt>Maintenance limit without owner approval</dt><dd>${p.maintenance_limit_minor === null || p.maintenance_limit_minor === undefined ? 'None — every job needs owner approval' : fm(p.maintenance_limit_minor) + ' per job'}</dd></div>
          <div><dt>Emergency work</dt><dd>${p.emergency_allowed ? `Allowed up to ${fm(p.emergency_limit_minor)} with a recorded justification` : 'Not allowed without owner approval'}</dd></div>
          <div><dt>Reserve kept back</dt><dd>${fm(p.reserve_minor)}</dd></div>
          <div><dt>Rent invoices issued in the name of</dt><dd>${p.billing_entity === 'owner' ? 'The owner (SarayDar as managing agent)' : 'SarayDar'}</dd></div>
          <div><dt>Payment instructions on invoices</dt><dd class="pre-line">${p.payment_instructions || html`<span class="warn-text">Not recorded</span>`}</dd></div>
          <div><dt>Owner approval rules</dt><dd class="pre-line">${p.owner_approval_rules || '—'}</dd></div><div><dt>Reporting preferences</dt><dd class="pre-line">${p.reporting_prefs || '—'}</dd></div></dl>`}
        ${edit ? html`<details class="inline-form" ${p._missing ? raw('open') : ''}><summary>${p._missing ? 'Record the arrangement' : 'Edit'}</summary><form method="post" action="/w/${id}/property" class="form-grid">${csrfField(req)}
          ${sel('property_type', { '': 'Choose…', ...PTYPE }, 'Property type')}${field({ name: 'address', label: 'Address', value: p.address || '', type: 'textarea' })}
          ${field({ name: 'facilities', label: 'Facilities and providers', value: p.facilities || '', type: 'textarea', full: true })}
          ${sel('rent_collector', HOLDER, 'Rent is collected by')}${sel('deposit_holder', HOLDER, 'Deposits are held by')}
          ${sel('supplier_payer', { saraydar: 'SarayDar, from funds held for the owner', owner: 'The owner directly' }, 'Suppliers are paid by')}
          ${sel('owner_transfers', { saraydar: 'SarayDar transfers proceeds to the owner', not_applicable: 'Not applicable' }, 'Owner transfers')}
          ${field({ name: 'fee_deduction_allowed', label: 'SarayDar fee may be deducted from collected rent', value: p.fee_deduction_allowed ? '1' : '0', options: [['0', 'No'], ['1', 'Yes — the owner has authorised it']] })}
          ${field({ name: 'maintenance_limit', label: 'Maintenance limit per job without owner approval (BHD)', value: p.maintenance_limit_minor === null || p.maintenance_limit_minor === undefined ? '' : toInput(Number(p.maintenance_limit_minor)), hint: 'Empty = every job needs the owner\'s approval.' })}
          ${field({ name: 'emergency_allowed', label: 'Emergency work without prior approval', value: p.emergency_allowed ? '1' : '0', options: [['0', 'Not allowed'], ['1', 'Allowed up to a limit, with justification']] })}
          ${field({ name: 'emergency_limit', label: 'Emergency limit (BHD)', value: p.emergency_limit_minor === null || p.emergency_limit_minor === undefined ? '' : toInput(Number(p.emergency_limit_minor)) })}
          ${field({ name: 'reserve', label: 'Reserve kept back from transfers (BHD)', value: toInput(Number(p.reserve_minor || 0)) })}
          ${sel('billing_entity', { owner: 'The owner (SarayDar as managing agent)', saraydar: 'SarayDar' }, 'Rent invoices issued in the name of')}
          ${field({ name: 'payment_instructions', label: 'Payment instructions printed on rent invoices', value: p.payment_instructions || '', type: 'textarea', full: true, hint: 'Bank name, account name, IBAN, reference to quote. The system takes no online payments yet.' })}
          ${field({ name: 'owner_approval_rules', label: 'Owner approval rules', value: p.owner_approval_rules || '', type: 'textarea' })}${field({ name: 'reporting_prefs', label: 'Reporting preferences', value: p.reporting_prefs || '', type: 'textarea' })}
          <div class="actions full"><button class="btn primary" type="submit">Save</button></div></form></details>` : ''}
      </section>
      <section class="panel"><h2 class="h">Owners</h2>
        <ul class="rows">${primary ? html`<li><div class="grow"><a href="/clients/${primary.id}"><b>${primary.name}</b></a> ${pill('Primary owner', 'ok')}<div class="muted small">${[primary.phone, primary.email].filter(Boolean).join(' · ') || 'No contact details'}</div></div></li>` : html`<li class="muted">No owner linked. Link one under <a href="/w/${id}/client">Owner &amp; Agreement</a>.</li>`}
          ${owners.filter(o => o.party_id !== a.ws.party_id).map(o => html`<li><div class="grow"><b>${o.name}</b>${o.share_pct !== null ? ` · ${Number(o.share_pct)}%` : ''}<div class="muted small">${o.statement_rule || 'No statement rule recorded'}</div></div></li>`)}</ul>
        ${owners.length ? html`<p class="small ${shareSum && shareSum !== 100 ? 'err' : 'muted'}">${shareSum ? `Recorded shares total ${shareSum}%.` : 'No ownership shares recorded.'} Statements follow the recorded rules; nothing is split automatically.</p>` : ''}
        ${edit ? html`<details class="inline-form"><summary>Add a co-owner</summary><form method="post" action="/w/${id}/owners" class="form-grid">${csrfField(req)}
          ${field({ name: 'party_id', label: 'Existing owner', options: [['', 'New owner…'], ...ownersAll.map(o => [o.id, o.name])] })}${field({ name: 'name', label: 'Or new owner name' })}
          ${field({ name: 'share_pct', label: 'Ownership share (%)' })}${field({ name: 'statement_rule', label: 'Statement rule', hint: 'For example: one statement to the primary owner; shares shown for information.' })}
          <div class="actions full"><button class="btn" type="submit">Add owner</button></div></form></details>` : ''}
      </section>
      ${a.finance ? html`<section class="panel"><h2 class="h">Opening balances</h2>
        <p class="muted small">For properties taken over part-way: tenant arrears, deposits already held and owner cash held at the takeover date. Each is reviewed and approved by Finance before it is posted, and can be posted only once.</p>
        ${ob.length ? html`<div class="table-wrap"><table><thead><tr><th>Type</th><th>Lease</th><th>As of</th><th class="n">Amount</th><th>Evidence</th><th>Status</th><th></th></tr></thead><tbody>
          ${ob.map(o => html`<tr><td>${{ tenant_arrears: 'Tenant arrears', deposit_held: 'Deposit held', owner_cash: 'Owner cash held' }[o.kind]}</td><td class="small">${o.lease_ref ? `${o.lease_ref} · ${o.tenant_name}` : '—'}</td><td class="small">${fmtDate(o.as_of)}</td><td class="n">${fm(o.amount_minor)}</td>
            <td class="small">${o.evidence || html`<span class="warn-text">None</span>`}${o.verified ? '' : html`<div>${pill('Unverified', 'warn')}</div>`}</td><td>${pill(o.status, o.status === 'posted' ? 'ok' : o.status === 'rejected' ? 'muted' : 'warn')}</td>
            <td>${a.canPost && o.status === 'draft' ? html`<form method="post" action="/w/${id}/opening/${o.id}" class="actions">${csrfField(req)}<button class="btn small" name="do" value="approve">Approve</button><button class="btn small" name="do" value="reject">Reject</button></form>` : ''}
              ${a.canPost && o.status === 'approved' ? html`<form method="post" action="/w/${id}/opening/${o.id}" class="actions">${csrfField(req)}<button class="btn small primary" name="do" value="post">Post</button></form>` : ''}</td></tr>`)}</tbody></table></div>` : html`<p class="muted">None recorded.</p>`}
        ${edit ? html`<details class="inline-form"><summary>Record an opening balance</summary><form method="post" action="/w/${id}/opening" class="form-grid">${csrfField(req)}
          ${field({ name: 'kind', label: 'Type', options: [['tenant_arrears', 'Tenant arrears (unpaid rent at takeover)'], ['deposit_held', 'Deposit held for a tenant'], ['owner_cash', 'Owner cash held by SarayDar']] })}
          ${field({ name: 'lease_id', label: 'Lease (for tenant items)', options: [['', '—'], ...leases.map(l => [l.id, `${l.ref} · ${l.tenant_name}`])] })}
          ${field({ name: 'as_of', label: 'As of', type: 'date', required: true })}${field({ name: 'amount', label: 'Amount (BHD)', required: true })}
          ${field({ name: 'holder', label: 'Held by (deposits)', options: Object.entries(HOLDER) })}${field({ name: 'evidence', label: 'Evidence / source', hint: 'For example the previous agent\'s statement of 30 Sept.' })}
          <label class="field check"><input type="checkbox" name="verified" value="1"> <span>Checked against evidence</span></label>
          <div class="actions full"><button class="btn" type="submit">Save for review</button></div></form></details>` : ''}
      </section>` : ''}`));
  });

  r.post('/w/:id/property', async (req, res) => {
    const a = await access(req, 'edit');
    const b = req.body;
    const pick = (v, set, d) => set.includes(v) ? v : d;
    const money = (v, label) => { if (v === undefined || String(v).trim() === '') return null; const m = parseMoney(v, 'BHD'); if (m === null || m < 0) throw bad(`Check ${label}.`); return m; };
    const v = {
      property_type: pick(b.property_type, Object.keys(PTYPE), null), address: txt(b.address, 500), facilities: txt(b.facilities, 2000),
      rent_collector: pick(b.rent_collector, Object.keys(HOLDER), 'saraydar'), deposit_holder: pick(b.deposit_holder, Object.keys(HOLDER), 'saraydar'),
      supplier_payer: pick(b.supplier_payer, ['saraydar', 'owner'], 'saraydar'), owner_transfers: pick(b.owner_transfers, ['saraydar', 'not_applicable'], 'saraydar'),
      fee_deduction_allowed: b.fee_deduction_allowed === '1', maintenance_limit_minor: money(b.maintenance_limit, 'the maintenance limit'),
      emergency_allowed: b.emergency_allowed === '1', emergency_limit_minor: money(b.emergency_limit, 'the emergency limit'), reserve_minor: money(b.reserve, 'the reserve') || 0,
      billing_entity: pick(b.billing_entity, ['owner', 'saraydar'], 'owner'), payment_instructions: txt(b.payment_instructions, 1000),
      owner_approval_rules: txt(b.owner_approval_rules, 2000), reporting_prefs: txt(b.reporting_prefs, 1000)
    };
    if (v.emergency_allowed && v.emergency_limit_minor === null) throw bad('Enter the emergency limit, or do not allow emergency work.');
    const before = await profileOf(a.ws.id);
    await core.inTx(async db => {
      const cols = Object.keys(v);
      await db.query(`insert into property_profiles (workspace_id, ${cols.join(', ')}, updated_by, updated_at) values ($1, ${cols.map((c, i) => `$${i + 2}`).join(', ')}, $${cols.length + 2}, now())
        on conflict (workspace_id) do update set ${cols.map(c => `${c} = excluded.${c}`).join(', ')}, updated_by = excluded.updated_by, updated_at = now()`, [a.ws.id, ...cols.map(c => v[c]), req.user.id]);
      const changed = before._missing ? cols : cols.filter(c => String(before[c] ?? '') !== String(v[c] ?? ''));
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'property.profile_saved', entity: 'property', entityId: a.ws.id, summary: `Property arrangement saved${changed.length ? ` (${changed.join(', ')})` : ''}`, before: before._missing ? null : Object.fromEntries(changed.map(c => [c, before[c]])), after: Object.fromEntries(changed.map(c => [c, v[c]])), ip: req.ip });
      await touch(db, a.ws.id);
    });
    res.redirect(`/w/${a.ws.id}/property?msg=saved`);
  });

  r.post('/w/:id/owners', async (req, res) => {
    const a = await access(req, 'edit');
    const share = String(req.body.share_pct || '').trim() === '' ? null : Number(req.body.share_pct);
    if (share !== null && !(share > 0 && share <= 100)) throw bad('The share must be between 0 and 100%.');
    await core.inTx(async db => {
      let pid = UUID.test(req.body.party_id || '') ? req.body.party_id : null;
      if (!pid) {
        const name = txt(req.body.name, 160); if (!name) throw bad('Choose an owner or enter a name.');
        pid = (await db.query("insert into parties (name, roles, created_by) values ($1, '{owner}', $2) returning id", [name, req.user.id])).rows[0].id;
      }
      await db.query('insert into property_owners (workspace_id, party_id, share_pct, statement_rule) values ($1,$2,$3,$4) on conflict (workspace_id, party_id) do update set share_pct = excluded.share_pct, statement_rule = excluded.statement_rule', [a.ws.id, pid, share, txt(req.body.statement_rule, 300)]);
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'property.owner_added', entity: 'party', entityId: pid, summary: `Co-owner recorded${share !== null ? ` (${share}%)` : ''}`, ip: req.ip });
    });
    res.redirect(`/w/${a.ws.id}/property?msg=saved`);
  });

  // ---------- opening balances ----------
  r.post('/w/:id/opening', async (req, res) => {
    const a = await access(req, 'edit');
    if (!a.finance) throw new NotFound();
    const kind = ['tenant_arrears', 'deposit_held', 'owner_cash'].includes(req.body.kind) ? req.body.kind : null; if (!kind) throw bad('Choose the type.');
    const asOf = dateOrNull(req.body.as_of); if (!asOf) throw bad('Enter the as-of date.');
    const amount = parseMoney(req.body.amount, 'BHD'); if (!amount || amount <= 0) throw bad('Enter the amount.');
    let lease = null;
    if (kind !== 'owner_cash') lease = await own('leases', req.body.lease_id, a.ws.id);
    try {
      await core.inTx(async db => {
        const id = (await db.query('insert into opening_balances (workspace_id, kind, lease_id, as_of, amount_minor, holder, evidence, verified, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id',
          [a.ws.id, kind, lease && lease.id, asOf, amount, HOLDER[req.body.holder] ? req.body.holder : null, txt(req.body.evidence, 300), req.body.verified === '1', req.user.id])).rows[0].id;
        await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'opening.recorded', entity: 'opening_balance', entityId: id, summary: `Opening balance recorded for review: ${kind.replace('_', ' ')} ${formatMoney(amount)}`, ip: req.ip });
      });
    } catch (e) { if (e.code === '23505') throw bad('An opening balance of this type is already recorded for that lease/property. Reject it first to replace it.'); throw e; }
    res.redirect(`/w/${a.ws.id}/property?msg=saved`);
  });

  r.post('/w/:id/opening/:oid', async (req, res) => {
    const a = await access(req, 'post');
    const o = await own('opening_balances', req.params.oid, a.ws.id);
    const action = req.body.do;
    await core.inTx(async db => {
      const cur = (await db.query('select * from opening_balances where id = $1 for update', [o.id])).rows[0];
      if (action === 'approve' || action === 'reject') {
        if (cur.status !== 'draft') throw bad('Only a draft can be approved or rejected.');
        await db.query('update opening_balances set status = $2, approved_by = $3, approved_at = now() where id = $1', [o.id, action === 'approve' ? 'approved' : 'rejected', req.user.id]);
      } else if (action === 'post') {
        if (cur.status !== 'approved') throw bad(cur.status === 'posted' ? 'Already posted.' : 'Approve it first.');
        const amt = Number(cur.amount_minor);
        if (cur.kind === 'tenant_arrears') {
          const l = (await db.query('select * from leases where id = $1', [cur.lease_id])).rows[0];
          await db.query(`insert into rent_charges (workspace_id, lease_id, unit_id, kind, charge_key, description, period_start, period_end, due_date, amount_minor, opening_id, created_by)
            values ($1,$2,$3,'opening',$4,$5,$6,$6,$6,$7,$8,$9)`, [a.ws.id, l.id, l.unit_id, `opening:${cur.id}`, `Arrears brought forward at ${fmtDate(cur.as_of)}`, cur.as_of, amt, cur.id, req.user.id]);
        } else if (cur.kind === 'deposit_held') {
          await db.query("insert into deposit_txns (workspace_id, lease_id, kind, on_date, amount_minor, holder, reason, source, opening_id, created_by) values ($1,$2,'received',$3,$4,$5,'Deposit held at takeover','opening',$6,$7)",
            [a.ws.id, cur.lease_id, cur.as_of, amt, cur.holder || 'saraydar', cur.id, req.user.id]);
        } else {
          await db.query("insert into owner_txns (workspace_id, kind, on_date, amount_minor, notes, opening_id, created_by) values ($1,'opening_cash',$2,$3,'Owner cash held at takeover',$4,$5)", [a.ws.id, cur.as_of, amt, cur.id, req.user.id]);
        }
        await db.query("update opening_balances set status = 'posted', posted_at = now() where id = $1", [o.id]);
      } else throw bad('Unknown action.');
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: `opening.${action}`, entity: 'opening_balance', entityId: o.id, summary: `Opening balance ${action === 'post' ? 'posted' : action + 'd'}: ${o.kind.replace('_', ' ')} ${formatMoney(Number(o.amount_minor))}`, ip: req.ip });
      await touch(db, a.ws.id);
    });
    res.redirect(`/w/${a.ws.id}/property?msg=saved`);
  });

  // ---------- units ----------
  const currentLeases = async wsId => (await pool.query(`select l.*, t.name as tenant_name from leases l join parties t on t.id = l.tenant_id
     where l.workspace_id = $1 and l.status = 'active' and l.start_date <= $2 and coalesce(l.terminated_on, l.end_date) >= $2`, [wsId, todayBH()])).rows;

  r.get('/w/:id/units', async (req, res, next) => {
    if (!(await isProps(req))) return next();
    const a = await access(req);
    const units = await unitsOf(a.ws.id);
    const cur = Object.fromEntries((await currentLeases(a.ws.id)).map(l => [l.unit_id, l]));
    const edit = core.canEdit(a);
    const counts = Object.fromEntries(Object.keys(UNIT_STATUS).map(k => [k, units.filter(u => u.status === k).length]));
    res.send(page(req, a, 'Units', html`
      <section class="grid-cards" aria-label="Unit status">${Object.entries(UNIT_STATUS).map(([k, l]) => html`<div class="card"><div class="muted small">${l}</div><div class="big">${counts[k]}</div></div>`)}</section>
      <section class="panel"><h2 class="h">Units <span class="muted small">${units.length}</span></h2>
        ${units.length ? html`<div class="table-wrap"><table><thead><tr><th>Unit</th><th>Floor</th><th>Type</th><th class="n">Area m²</th><th>Status</th><th>Current tenant</th>${a.finance ? html`<th class="n">Rent / month</th><th class="n">Market rent</th>` : ''}<th></th></tr></thead><tbody>
          ${units.map(u => { const l = cur[u.id]; return html`<tr><td><a href="/w/${a.ws.id}/units/${u.id}"><b>${u.ref}</b></a></td><td>${u.floor || '—'}</td><td>${u.unit_type || '—'}</td><td class="n">${u.area_m2 === null ? '—' : Number(u.area_m2)}</td>
            <td>${pill(UNIT_STATUS[u.status], UNIT_TONE[u.status])}</td><td class="small">${l ? html`<a href="/w/${a.ws.id}/leases/${l.id}">${l.tenant_name}</a><div class="muted">to ${fmtDate(rentLib.effectiveEnd(l))}</div>` : '—'}</td>
            ${a.finance ? html`<td class="n">${l ? fm(l.rent_minor) : '—'}</td><td class="n">${u.market_rent_minor === null ? '—' : fm(u.market_rent_minor)}</td>` : ''}
            <td><a class="small" href="/w/${a.ws.id}/history?unit=${u.id}">History</a></td></tr>`; })}</tbody></table></div>` : emptyState('No units yet', 'Add the units of this property below — one at a time or as a numbered range.')}
      </section>
      ${edit ? html`<div class="split">
        <form method="post" action="/w/${a.ws.id}/units" class="panel grow1 form-grid">${csrfField(req)}<h3 class="h3 full">Add a unit</h3>
          ${field({ name: 'ref', label: 'Unit number', required: true })}${field({ name: 'floor', label: 'Floor' })}${field({ name: 'unit_type', label: 'Type', hint: 'For example 2-bedroom apartment, shop, office.' })}
          ${field({ name: 'area_m2', label: 'Area (m²)', type: 'number', attrs: 'min="0" step="any"' })}${field({ name: 'bedrooms', label: 'Bedrooms', type: 'number', attrs: 'min="0"' })}
          ${a.finance ? field({ name: 'market_rent', label: 'Market rent / month (BHD)' }) : ''}${field({ name: 'features', label: 'Features', full: true })}
          <div class="actions full"><button class="btn primary" type="submit">Add unit</button></div></form>
        <form method="post" action="/w/${a.ws.id}/units/range" class="panel grow1 form-grid">${csrfField(req)}<h3 class="h3 full">Add a numbered range</h3>
          ${field({ name: 'prefix', label: 'Prefix', hint: 'For example "Apartment " or "Shop ".' })}${field({ name: 'from', label: 'From number', type: 'number', required: true, attrs: 'min="0"' })}${field({ name: 'to', label: 'To number', type: 'number', required: true, attrs: 'min="0"' })}
          ${field({ name: 'unit_type', label: 'Type' })}${field({ name: 'floor', label: 'Floor (optional)' })}
          <div class="actions full"><button class="btn" type="submit">Add units</button></div><p class="muted small full">Up to 200 at a time. Numbers already used are skipped.</p></form>
      </div>` : ''}`));
  });

  function readUnit(b, finance) {
    const ref = txt(b.ref, 40); if (!ref) throw bad('Enter the unit number.');
    const area = String(b.area_m2 ?? '').trim() === '' ? null : Number(b.area_m2);
    if (area !== null && !(area >= 0)) throw bad('Area must be a positive number.');
    const bedrooms = String(b.bedrooms ?? '').trim() === '' ? null : parseInt(b.bedrooms, 10);
    return { ref, floor: txt(b.floor, 20), unit_type: txt(b.unit_type, 80), area_m2: area, bedrooms: Number.isFinite(bedrooms) && bedrooms >= 0 ? bedrooms : null, features: txt(b.features, 1000), condition: txt(b.condition, 500), notes: txt(b.notes, 1000),
      ...(finance ? { market_rent_minor: String(b.market_rent ?? '').trim() === '' ? null : parseMoney(b.market_rent, 'BHD') } : {}) };
  }

  r.post('/w/:id/units', async (req, res, next) => {
    if (!(await isProps(req))) return next();
    const a = await access(req, 'edit');
    const u = readUnit(req.body, a.finance);
    try {
      await core.inTx(async db => {
        const cols = Object.keys(u);
        const s = (await db.query('select coalesce(max(sort),0)+1 as s from units where workspace_id = $1', [a.ws.id])).rows[0].s;
        const id = (await db.query(`insert into units (workspace_id, sort, ${cols.join(', ')}) values ($1, $2, ${cols.map((c, i) => `$${i + 3}`).join(', ')}) returning id`, [a.ws.id, s, ...cols.map(c => u[c])])).rows[0].id;
        await db.query("insert into unit_status_history (unit_id, status, changed_on, reason, created_by) values ($1, 'available', $2, 'Unit added', $3)", [id, todayBH(), req.user.id]);
        await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'unit.added', entity: 'unit', entityId: id, summary: `Unit added: ${u.ref}`, ip: req.ip });
        await touch(db, a.ws.id);
      });
    } catch (e) { if (e.code === '23505') throw bad('That unit number is already used in this property.'); throw e; }
    res.redirect(`/w/${a.ws.id}/units?msg=added`);
  });

  r.post('/w/:id/units/range', async (req, res) => {
    const a = await access(req, 'edit');
    const from = parseInt(req.body.from, 10), to = parseInt(req.body.to, 10);
    if (!(from >= 0 && to >= from && to - from < 200)) throw bad('Enter a range of up to 200 numbers.');
    const prefix = String(req.body.prefix || '').slice(0, 30);
    let n = 0;
    await core.inTx(async db => {
      let s = (await db.query('select coalesce(max(sort),0)+1 as s from units where workspace_id = $1', [a.ws.id])).rows[0].s;
      for (let i = from; i <= to; i++) {
        const ref = `${prefix}${i}`.trim();
        const ins = await db.query("insert into units (workspace_id, ref, unit_type, floor, sort) select $1,$2,$3,$4,$5 where not exists (select 1 from units where workspace_id = $1 and lower(ref) = lower($2) and archived_at is null) returning id", [a.ws.id, ref, txt(req.body.unit_type, 80), txt(req.body.floor, 20), s++]);
        if (ins.rowCount) { n++; await db.query("insert into unit_status_history (unit_id, status, changed_on, reason, created_by) values ($1, 'available', $2, 'Unit added', $3)", [ins.rows[0].id, todayBH(), req.user.id]); }
      }
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'unit.range_added', entity: 'property', entityId: a.ws.id, summary: `${n} unit(s) added (${prefix}${from}–${to})`, ip: req.ip });
      await touch(db, a.ws.id);
    });
    res.redirect(`/w/${a.ws.id}/units?msg=added`);
  });

  r.get('/w/:id/units/:uid', async (req, res) => {
    const a = await access(req);
    const u = await own('units', req.params.uid, a.ws.id);
    const leases = (await pool.query('select l.*, t.name as tenant_name from leases l join parties t on t.id = l.tenant_id where l.unit_id = $1 order by l.start_date desc', [u.id])).rows;
    const hist = (await pool.query("select h.*, coalesce(nullif(x.name,''), x.email) as by from unit_status_history h left join users x on x.id = h.created_by where h.unit_id = $1 order by h.changed_on desc, h.id desc", [u.id])).rows;
    const maint = (await pool.query('select id, ref, title, status, reported_on from maint_requests where unit_id = $1 order by reported_on desc limit 20', [u.id])).rows;
    const edit = core.canEdit(a);
    res.send(page(req, a, 'Units', html`<p><a href="/w/${a.ws.id}/units">‹ Units</a> · <a href="/w/${a.ws.id}/history?unit=${u.id}">Unit history &amp; report</a></p>
      <div class="split"><section class="panel grow1"><h2 class="h">Unit ${u.ref} ${pill(UNIT_STATUS[u.status], UNIT_TONE[u.status])}</h2>
        <dl class="details"><div><dt>Floor</dt><dd>${u.floor || '—'}</dd></div><div><dt>Type</dt><dd>${u.unit_type || '—'}</dd></div><div><dt>Area</dt><dd>${u.area_m2 === null ? '—' : `${Number(u.area_m2)} m²`}</dd></div>
          <div><dt>Bedrooms</dt><dd>${u.bedrooms ?? '—'}</dd></div><div><dt>Features</dt><dd class="pre-line">${u.features || '—'}</dd></div><div><dt>Condition</dt><dd class="pre-line">${u.condition || '—'}</dd></div>
          ${a.finance ? html`<div><dt>Market rent</dt><dd>${u.market_rent_minor === null ? '—' : fm(u.market_rent_minor)}</dd></div>` : ''}<div><dt>Notes</dt><dd class="pre-line">${u.notes || '—'}</dd></div></dl>
        ${edit ? html`<details class="inline-form"><summary>Edit unit</summary><form method="post" action="/w/${a.ws.id}/units/${u.id}" class="form-grid">${csrfField(req)}
          ${field({ name: 'ref', label: 'Unit number', value: u.ref, required: true })}${field({ name: 'floor', label: 'Floor', value: u.floor || '' })}${field({ name: 'unit_type', label: 'Type', value: u.unit_type || '' })}
          ${field({ name: 'area_m2', label: 'Area (m²)', value: u.area_m2 === null ? '' : Number(u.area_m2), type: 'number', attrs: 'min="0" step="any"' })}${field({ name: 'bedrooms', label: 'Bedrooms', value: u.bedrooms ?? '', type: 'number' })}
          ${a.finance ? field({ name: 'market_rent', label: 'Market rent / month (BHD)', value: u.market_rent_minor === null ? '' : toInput(Number(u.market_rent_minor)) }) : ''}
          ${field({ name: 'features', label: 'Features', value: u.features || '', full: true })}${field({ name: 'condition', label: 'Condition', value: u.condition || '', full: true })}${field({ name: 'notes', label: 'Notes', value: u.notes || '', full: true })}
          <div class="actions full"><button class="btn" type="submit">Save</button></div></form></details>
        <details class="inline-form"><summary>Change status</summary><form method="post" action="/w/${a.ws.id}/units/${u.id}/status" class="form-grid">${csrfField(req)}
          ${field({ name: 'status', label: 'Status', value: u.status, options: Object.entries(UNIT_STATUS) })}${field({ name: 'changed_on', label: 'From', type: 'date', value: todayBH(), required: true })}
          ${field({ name: 'reason', label: 'Reason', required: true, full: true })}<div class="actions full"><button class="btn" type="submit">Change status</button></div></form></details>` : ''}</section>
        <section class="panel grow1"><h2 class="h">Leases</h2>${leases.length ? html`<ul class="rows">${leases.map(l => html`<li><div class="grow"><a href="/w/${a.ws.id}/leases/${l.id}"><b>${l.tenant_name}</b></a><div class="muted small">${l.ref} · ${fmtDate(l.start_date)} – ${fmtDate(rentLib.effectiveEnd(l))}</div></div>${pill(l.status, LEASE_TONE[l.status])}</li>`)}</ul>` : html`<p class="muted">No leases yet.</p>`}
          <h3 class="h3">Status history</h3><ol class="feed">${hist.map(h => html`<li><b>${UNIT_STATUS[h.status]}</b> from ${fmtDate(h.changed_on)}<div class="muted small">${h.reason || ''}${h.by ? ` · ${h.by}` : ''}</div></li>`)}</ol>
          <h3 class="h3">Maintenance</h3>${maint.length ? html`<ul class="rows">${maint.map(m => html`<li><div class="grow"><a href="/w/${a.ws.id}/maintenance/${m.id}">${m.ref} · ${m.title}</a><div class="muted small">${fmtDate(m.reported_on)}</div></div>${pill(m.status.replace('_', ' '), ['verified', 'closed'].includes(m.status) ? 'ok' : 'warn')}</li>`)}</ul>` : html`<p class="muted">None.</p>`}</section></div>`, `Unit ${u.ref}`));
  });

  r.post('/w/:id/units/:uid', async (req, res, next) => {
    if (!(await isProps(req))) return next();
    const a = await access(req, 'edit');
    const cur = await own('units', req.params.uid, a.ws.id);
    const u = readUnit(req.body, a.finance);
    try {
      await core.inTx(async db => U.track(db, req.user, { label: `Edited unit ${cur.ref}`, workspaceId: a.ws.id, returnTo: `/w/${a.ws.id}/units/${cur.id}`, targets: [['units', cur.id]] }, async () => {
        const cols = Object.keys(u);
        await db.query(`update units set ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} where id = $1`, [cur.id, ...cols.map(c => u[c])]);
        await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'unit.updated', entity: 'unit', entityId: cur.id, summary: `Unit ${u.ref} updated`, ip: req.ip });
      }));
    } catch (e) { if (e.code === '23505') throw bad('That unit number is already used in this property.'); throw e; }
    res.redirect(`/w/${a.ws.id}/units/${cur.id}?msg=saved`);
  });

  async function setUnitStatus(db, unitId, status, on, reason, userId) {
    const u = (await db.query('select status from units where id = $1 for update', [unitId])).rows[0];
    if (u.status === status) return;
    await db.query('update units set status = $2 where id = $1', [unitId, status]);
    await db.query('insert into unit_status_history (unit_id, status, changed_on, reason, created_by) values ($1,$2,$3,$4,$5)', [unitId, status, on, reason, userId]);
  }
  PR.setUnitStatus = setUnitStatus;

  r.post('/w/:id/units/:uid/status', async (req, res) => {
    const a = await access(req, 'edit');
    const u = await own('units', req.params.uid, a.ws.id);
    const status = UNIT_STATUS[req.body.status] ? req.body.status : null; if (!status) throw bad('Choose a status.');
    const on = dateOrNull(req.body.changed_on); if (!on) throw bad('Enter the date.');
    const reason = txt(req.body.reason, 300); if (!reason) throw bad('Give a reason.');
    if (status === 'occupied' && !(await currentLeases(a.ws.id)).some(l => l.unit_id === u.id)) throw bad('A unit is marked occupied by activating its lease.');
    await core.inTx(async db => {
      await setUnitStatus(db, u.id, status, on, reason, req.user.id);
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'unit.status', entity: 'unit', entityId: u.id, summary: `Unit ${u.ref}: ${UNIT_STATUS[status]} — ${reason}`, ip: req.ip });
    });
    res.redirect(`/w/${a.ws.id}/units/${u.id}?msg=saved`);
  });

  // ---------- leases & tenants ----------
  r.get('/w/:id/leases', async (req, res) => {
    const a = await access(req);
    const rows = (await pool.query(`select l.*, t.name as tenant_name, t.phone as tenant_phone, u.ref as unit_ref from leases l join parties t on t.id = l.tenant_id join units u on u.id = l.unit_id
      where l.workspace_id = $1 order by (l.status = 'active') desc, l.start_date desc`, [a.ws.id])).rows;
    const today = todayBH(), soon = addDays(today, 60);
    const units = await unitsOf(a.ws.id);
    const tenants = (await pool.query("select id, name from parties where 'tenant' = any(roles) and archived_at is null order by name limit 1000")).rows;
    const agreements = (await pool.query("select id, ref, title from agreements where workspace_id = $1 and status <> 'cancelled' order by created_at desc", [a.ws.id])).rows;
    const edit = core.canEdit(a);
    const pre = UUID.test(req.query.unit || '') ? req.query.unit : '';
    const expiring = rows.filter(l => l.status === 'active' && rentLib.effectiveEnd(l) >= today && rentLib.effectiveEnd(l) <= soon);
    res.send(page(req, a, 'Leases & Tenants', html`
      ${expiring.length ? html`<div class="notice warn">${expiring.length} lease(s) end within 60 days: ${expiring.map((l, i) => html`${i ? ', ' : ''}<a href="/w/${a.ws.id}/leases/${l.id}">${l.unit_ref} (${fmtDate(rentLib.effectiveEnd(l))})</a>`)}.</div>` : ''}
      <section class="panel"><h2 class="h">Leases</h2>
        ${rows.length ? html`<div class="table-wrap"><table><thead><tr><th>Lease</th><th>Unit</th><th>Tenant</th><th>Start</th><th>End</th>${a.finance ? html`<th class="n">Rent / month</th>` : ''}<th>Billing</th><th>Status</th></tr></thead><tbody>
          ${rows.map(l => html`<tr><td><a href="/w/${a.ws.id}/leases/${l.id}"><b>${l.ref}</b></a></td><td>${l.unit_ref}</td><td>${l.tenant_name}<div class="muted small">${l.tenant_phone || ''}</div></td><td class="small">${fmtDate(l.start_date)}</td>
            <td class="small ${l.status === 'active' && rentLib.effectiveEnd(l) <= soon ? 'warn-text' : ''}">${fmtDate(rentLib.effectiveEnd(l))}${l.terminated_on ? ' (terminated)' : ''}</td>${a.finance ? html`<td class="n">${fm(l.rent_minor)}</td>` : ''}
            <td class="small">${FREQ[l.frequency_months]}${l.auto_invoice ? html` · ${pill('Automatic', 'ok')}` : ''}</td><td>${pill(l.status, LEASE_TONE[l.status])}</td></tr>`)}</tbody></table></div>` : emptyState('No leases yet', 'Add units first, then record leases for them.')}
      </section>
      ${edit && units.length ? html`<section class="panel"><h2 class="h">New lease</h2><form method="post" action="/w/${a.ws.id}/leases" class="form-grid">${csrfField(req)}
        ${field({ name: 'unit_id', label: 'Unit', required: true, value: pre, options: [['', 'Choose…'], ...units.map(u => [u.id, `${u.ref} · ${UNIT_STATUS[u.status]}`])] })}
        ${field({ name: 'tenant_id', label: 'Existing tenant', options: [['', 'New tenant…'], ...tenants.map(t => [t.id, t.name])] })}
        ${field({ name: 'tenant_name', label: 'New tenant name' })}${field({ name: 'tenant_phone', label: 'Tenant phone' })}${field({ name: 'tenant_email', label: 'Tenant email', type: 'email', hint: 'Needed to email rent invoices.' })}${field({ name: 'tenant_id_number', label: 'CPR / CR / passport' })}
        ${field({ name: 'start_date', label: 'Start', type: 'date', required: true })}${field({ name: 'end_date', label: 'End', type: 'date', required: true })}
        ${field({ name: 'rent', label: 'Rent per month (BHD)', required: true })}${field({ name: 'frequency_months', label: 'Billed', value: '1', options: Object.entries(FREQ) })}
        ${field({ name: 'proration', label: 'Part months', value: 'daily', options: [['daily', 'Prorate by day'], ['none', 'Full month']] })}${field({ name: 'due_day_offset', label: 'Rent due (days after the period starts)', type: 'number', value: '0', attrs: 'min="0" max="60"' })}
        ${field({ name: 'deposit', label: 'Deposit agreed (BHD)' })}${field({ name: 'charge_desc', label: 'Recurring charge (optional)', hint: 'For example service charge. More can be added later.' })}${field({ name: 'charge_amount', label: 'Charge per month (BHD)' })}
        ${field({ name: 'agreement_id', label: 'Signed lease document', options: [['', 'Not linked yet'], ...agreements.map(x => [x.id, `${x.ref} · ${x.title}`])], hint: 'Prepare it from a template under Agreements.' })}
        ${field({ name: 'occupants', label: 'Authorised occupants', full: true })}
        <div class="actions full"><button class="btn primary" type="submit">Save as draft</button></div>
        <p class="muted small full">A draft reserves nothing. Activating it checks that no other lease on the unit overlaps these dates.</p></form></section>` : ''}`));
  });

  r.post('/w/:id/leases', async (req, res) => {
    const a = await access(req, 'edit');
    const b = req.body;
    const unit = await own('units', b.unit_id, a.ws.id);
    const start = dateOrNull(b.start_date), end = dateOrNull(b.end_date);
    if (!start || !end) throw bad('Enter the start and end dates.');
    if (end < start) throw bad('The end date is before the start.');
    const rentM = parseMoney(b.rent, 'BHD'); if (rentM === null || rentM < 0) throw bad('Enter the monthly rent.');
    const dep = String(b.deposit || '').trim() ? parseMoney(b.deposit, 'BHD') : 0;
    const chargeAmt = String(b.charge_amount || '').trim() ? parseMoney(b.charge_amount, 'BHD') : null;
    const freq = [1, 3, 6, 12].includes(Number(b.frequency_months)) ? Number(b.frequency_months) : 1;
    const due = Math.min(60, Math.max(0, parseInt(b.due_day_offset, 10) || 0));
    const agreement = UUID.test(b.agreement_id || '') ? (await pool.query('select id from agreements where id = $1 and workspace_id = $2', [b.agreement_id, a.ws.id])).rows[0] : null;
    const id = await core.inTx(async db => {
      let tid = UUID.test(b.tenant_id || '') ? (await db.query("select id from parties where id = $1", [b.tenant_id])).rows[0]?.id : null;
      if (!tid) {
        const name = txt(b.tenant_name, 160); if (!name) throw bad('Choose a tenant or enter the new tenant\'s name.');
        const email = txt(b.tenant_email, 160); if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('Check the tenant email.');
        tid = (await db.query("insert into parties (name, phone, email, id_number, roles, created_by) values ($1,$2,$3,$4,'{tenant}',$5) returning id", [name, txt(b.tenant_phone, 40), email, txt(b.tenant_id_number, 40), req.user.id])).rows[0].id;
      } else await db.query("update parties set roles = array_append(roles, 'tenant') where id = $1 and not ('tenant' = any(roles))", [tid]);
      const year = start.slice(0, 4);
      const ref = `LSE-${year}-${String(await core.nextNumber(db, `LSE-${year}`)).padStart(4, '0')}`;
      const id = (await db.query(`insert into leases (workspace_id, unit_id, tenant_id, ref, start_date, end_date, rent_minor, frequency_months, proration, due_day_offset, deposit_minor, occupants, agreement_id, created_by)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id`, [a.ws.id, unit.id, tid, ref, start, end, rentM, freq, b.proration === 'none' ? 'none' : 'daily', due, dep || 0, txt(b.occupants, 1000), agreement && agreement.id, req.user.id])).rows[0].id;
      await db.query('insert into lease_rent_steps (lease_id, effective_from, rent_minor, reason, created_by) values ($1,$2,$3,$4,$5)', [id, start, rentM, 'Agreed rent at start', req.user.id]);
      if (txt(b.charge_desc, 120) && chargeAmt > 0) await db.query('insert into lease_charges (lease_id, description, amount_minor) values ($1,$2,$3)', [id, txt(b.charge_desc, 120), chargeAmt]);
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'lease.drafted', entity: 'lease', entityId: id, summary: `Lease ${ref} drafted for unit ${unit.ref}: ${start} to ${end}, ${formatMoney(rentM)} / month`, ip: req.ip });
      await touch(db, a.ws.id);
      return id;
    });
    res.redirect(`/w/${a.ws.id}/leases/${id}?msg=created`);
  });

  async function leaseFull(a, lid) {
    const l = await own('leases', lid, a.ws.id);
    l.tenant = (await pool.query('select * from parties where id = $1', [l.tenant_id])).rows[0];
    l.unit = (await pool.query('select * from units where id = $1', [l.unit_id])).rows[0];
    l.steps = (await pool.query('select * from lease_rent_steps where lease_id = $1 order by effective_from', [l.id])).rows;
    l.charges = (await pool.query('select * from lease_charges where lease_id = $1 order by created_at', [l.id])).rows;
    l.events = (await pool.query("select e.*, coalesce(nullif(u.name,''), u.email) as by from lease_events e left join users u on u.id = e.created_by where e.lease_id = $1 order by e.on_date desc, e.created_at desc", [l.id])).rows;
    l.eventFiles = await uploads.list(pool, a.ws.id, 'lease_event', l.events.map(e => e.id));
    l.renewals = (await pool.query('select id, ref, status, start_date from leases where renewal_of = $1', [l.id])).rows;
    l.prev = l.renewal_of ? (await pool.query('select id, ref from leases where id = $1', [l.renewal_of])).rows[0] : null;
    l.agreement = l.agreement_id ? (await pool.query('select id, ref, title, status from agreements where id = $1', [l.agreement_id])).rows[0] : null;
    return l;
  }
  PR.leaseFull = leaseFull;

  r.get('/w/:id/leases/:lid', async (req, res) => {
    const a = await access(req);
    const l = await leaseFull(a, req.params.lid);
    const edit = core.canEdit(a);
    const id = a.ws.id;
    const end = rentLib.effectiveEnd(l);
    const finance = a.finance && ctx.rentLeasePanel ? await ctx.rentLeasePanel(req, a, l) : '';
    res.send(page(req, a, 'Leases & Tenants', html`<p><a href="/w/${id}/leases">‹ Leases</a></p>
      <div class="split"><section class="panel grow1"><h2 class="h">Lease ${l.ref} ${pill(l.status, LEASE_TONE[l.status])}</h2>
        <dl class="details"><div><dt>Unit</dt><dd><a href="/w/${id}/units/${l.unit.id}">${l.unit.ref}</a></dd></div>
          <div><dt>Tenant</dt><dd><b>${l.tenant.name}</b><div class="small">${[l.tenant.phone, l.tenant.email, l.tenant.id_number].filter(Boolean).join(' · ') || html`<span class="warn-text">No contact details</span>`}</div></dd></div>
          <div><dt>Term</dt><dd>${fmtDate(l.start_date)} – ${fmtDate(l.end_date)}${l.terminated_on ? html`<div class="warn-text small">Terminated ${fmtDate(l.terminated_on)}: ${l.termination_reason}</div>` : ''}</dd></div>
          <div><dt>Moved in / out</dt><dd>${l.move_in_date ? fmtDate(l.move_in_date) : '—'} / ${l.move_out_date ? fmtDate(l.move_out_date) : '—'}</dd></div>
          ${a.finance ? html`<div><dt>Rent</dt><dd>${l.steps.map(s => html`<div>${fm(s.rent_minor)} / month from ${fmtDate(s.effective_from)}${s.reason ? html` <span class="muted small">(${s.reason})</span>` : ''}</div>`)}</dd></div>
          <div><dt>Recurring charges</dt><dd>${l.charges.length ? l.charges.map(c => html`<div>${c.description}: ${fm(c.amount_minor)} / month${c.active ? '' : ' (stopped)'}</div>`) : '—'}</dd></div>
          <div><dt>Deposit agreed</dt><dd>${fm(l.deposit_minor)}</dd></div>` : ''}
          <div><dt>Billing</dt><dd>${FREQ[l.frequency_months]} · ${l.proration === 'daily' ? 'part months by day' : 'full months'} · due ${l.due_day_offset} day(s) after the period starts</dd></div>
          <div><dt>Occupants</dt><dd class="pre-line">${l.occupants || '—'}</dd></div>
          <div><dt>Lease document</dt><dd>${l.agreement ? html`<a href="/w/${id}/agreements/${l.agreement.id}">${l.agreement.ref} · ${l.agreement.title}</a> (${l.agreement.status})` : html`<span class="muted">Not linked</span>`}</dd></div>
          ${l.prev ? html`<div><dt>Renews</dt><dd><a href="/w/${id}/leases/${l.prev.id}">${l.prev.ref}</a></dd></div>` : ''}
          ${l.renewals.length ? html`<div><dt>Renewed by</dt><dd>${l.renewals.map(x => html`<a href="/w/${id}/leases/${x.id}">${x.ref}</a> (${x.status}) `)}</dd></div>` : ''}</dl>
        ${edit ? html`<div class="actions">
          ${l.status === 'draft' ? html`<form method="post" action="/w/${id}/leases/${l.id}/activate">${csrfField(req)}<button class="btn primary" type="submit">Activate lease</button></form>
            <form method="post" action="/w/${id}/leases/${l.id}/cancel">${csrfField(req)}<button class="btn" type="submit">Cancel draft</button></form>` : ''}
          ${l.status === 'active' && end < todayBH() ? html`<form method="post" action="/w/${id}/leases/${l.id}/end">${csrfField(req)}<button class="btn" type="submit">Mark as ended</button></form>` : ''}
          ${['active', 'ended'].includes(l.status) && !l.renewals.some(x => x.status !== 'cancelled') ? html`<form method="post" action="/w/${id}/leases/${l.id}/renew">${csrfField(req)}<button class="btn" type="submit">Prepare renewal</button></form>` : ''}</div>
          ${l.status === 'active' ? html`<details class="inline-form"><summary>Record a rent change</summary><form method="post" action="/w/${id}/leases/${l.id}/rent-step" class="form-grid">${csrfField(req)}
              ${field({ name: 'effective_from', label: 'From', type: 'date', required: true })}${field({ name: 'rent', label: 'New rent per month (BHD)', required: true })}${field({ name: 'reason', label: 'Reason / approval', required: true, full: true })}
              <div class="actions full"><button class="btn" type="submit">Save rent change</button></div><p class="muted small full">Periods already invoiced keep their amounts.</p></form></details>
            <details class="inline-form"><summary>Add a recurring charge</summary><form method="post" action="/w/${id}/leases/${l.id}/charges" class="form-grid">${csrfField(req)}
              ${field({ name: 'description', label: 'Charge', required: true })}${field({ name: 'amount', label: 'Per month (BHD)', required: true })}<div class="actions full"><button class="btn" type="submit">Add charge</button></div></form></details>
            <details class="inline-form"><summary>Terminate early</summary><form method="post" action="/w/${id}/leases/${l.id}/terminate" class="form-grid">${csrfField(req)}
              ${field({ name: 'terminated_on', label: 'Last day of the tenancy', type: 'date', required: true })}${field({ name: 'reason', label: 'Reason', required: true, full: true })}
              <div class="actions full"><button class="btn" type="submit">Terminate</button></div><p class="muted small full">Invoices for periods after this date must be voided first. Settle the deposit under Deposits.</p></form></details>` : ''}` : ''}
      </section>
      <section class="panel grow1"><h2 class="h">Move-in, inspections, keys and meters</h2>
        ${l.events.length ? html`<ol class="feed">${l.events.map(e => html`<li><b>${EVENT[e.kind]} · ${fmtDate(e.on_date)}</b><div class="pre-line">${e.details || ''}</div>
          ${l.eventFiles.filter(f => f.entity_id === e.id).length ? html`<div class="gallery">${l.eventFiles.filter(f => f.entity_id === e.id).map(f => f.has_thumb ? html`<a href="/files/${f.id}"><img src="/files/${f.id}/thumb" alt="${f.original_name}" loading="lazy"></a>` : html`<a href="/files/${f.id}">${f.original_name}</a>`)}</div>` : ''}
          <div class="muted small">${e.by || ''}</div></li>`)}</ol>` : html`<p class="muted">Nothing recorded yet.</p>`}
        ${core.canContribute(a) ? html`<details class="inline-form"><summary>Record</summary><form method="post" action="/w/${id}/leases/${l.id}/events" enctype="multipart/form-data" class="form-grid"><input type="hidden" name="_csrf" value="${req.csrfToken}">
          ${field({ name: 'kind', label: 'What', options: Object.entries(EVENT) })}${field({ name: 'on_date', label: 'Date', type: 'date', required: true, value: todayBH() })}
          ${field({ name: 'details', label: 'Details (condition, readings, keys handed over…)', type: 'textarea', full: true })}
          <label class="field full"><span>Photos / documents</span><input type="file" name="files" multiple accept="image/*,application/pdf"></label>
          <div class="actions full"><button class="btn" type="submit">Save</button></div><p class="muted small full">A move-in sets the move-in date; a move-out sets the move-out date and the unit is not re-let automatically.</p></form></details>` : ''}
      </section></div>
      ${finance}`, l.ref));
  });

  const leaseAct = (path, fn) => r.post(`/w/:id/leases/:lid/${path}`, async (req, res) => {
    const a = await access(req, 'edit');
    const l = await own('leases', req.params.lid, a.ws.id);
    await core.inTx(async db => { await db.query('select id from leases where id = $1 for update', [l.id]); await fn(db, a, l, req); await touch(db, a.ws.id); });
    res.redirect(req._to || `/w/${a.ws.id}/leases/${l.id}?msg=saved`);
  });

  leaseAct('activate', async (db, a, l, req) => {
    if (l.status !== 'draft') throw bad('Only a draft can be activated.');
    const t = (await db.query('select email, phone from parties where id = $1', [l.tenant_id])).rows[0];
    try { await db.query("update leases set status = 'active', updated_at = now() where id = $1", [l.id]); }
    catch (e) { if (e.code === '23P01') throw bad('Another lease on this unit overlaps these dates. Change the dates or end/terminate the other lease first.'); throw e; }
    const today = todayBH();
    const st = l.start_date <= today && rentLib.effectiveEnd(l) >= today ? 'occupied' : l.start_date > today ? 'reserved' : null;
    if (st) await setUnitStatus(db, l.unit_id, st, today, `Lease ${l.ref} activated`, req.user.id);
    await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'lease.activated', entity: 'lease', entityId: l.id, summary: `Lease ${l.ref} activated${t && !t.email ? ' (tenant has no email: invoices cannot be emailed)' : ''}`, ip: req.ip });
  });
  leaseAct('cancel', async (db, a, l, req) => {
    if (l.status !== 'draft') throw bad('Only a draft can be cancelled.');
    await db.query("update leases set status = 'cancelled', updated_at = now() where id = $1", [l.id]);
    await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'lease.cancelled', entity: 'lease', entityId: l.id, summary: `Draft lease ${l.ref} cancelled`, ip: req.ip });
  });
  leaseAct('end', async (db, a, l, req) => {
    if (l.status !== 'active' || rentLib.effectiveEnd(l) >= todayBH()) throw bad('Only an active lease whose term has passed can be marked ended.');
    await db.query("update leases set status = 'ended', updated_at = now() where id = $1", [l.id]);
    const u = (await db.query('select status from units where id = $1', [l.unit_id])).rows[0];
    const next = (await db.query("select 1 from leases where unit_id = $1 and status = 'active' and id <> $2 and start_date <= $3 and coalesce(terminated_on, end_date) >= $3", [l.unit_id, l.id, todayBH()])).rowCount;
    if (u.status === 'occupied' && !next) await setUnitStatus(db, l.unit_id, 'available', todayBH(), `Lease ${l.ref} ended`, req.user.id);
    await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'lease.ended', entity: 'lease', entityId: l.id, summary: `Lease ${l.ref} ended`, ip: req.ip });
  });
  leaseAct('terminate', async (db, a, l, req) => {
    if (l.status !== 'active') throw bad('Only an active lease can be terminated.');
    const on = dateOrNull(req.body.terminated_on); const reason = txt(req.body.reason, 300);
    if (!on || !reason) throw bad('Enter the last day and the reason.');
    if (on < l.start_date || on > l.end_date) throw bad('The termination date must fall within the lease term.');
    const later = (await db.query("select number from rent_invoices where lease_id = $1 and status <> 'void' and period_start > $2", [l.id, on])).rows;
    if (later.length) throw bad(`Void ${later.map(x => x.number).join(', ')} first: they bill periods after the termination date.`);
    await db.query("update leases set status = 'terminated', terminated_on = $2, termination_reason = $3, updated_at = now() where id = $1", [l.id, on, reason]);
    await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'lease.terminated', entity: 'lease', entityId: l.id, summary: `Lease ${l.ref} terminated from ${on}: ${reason}`, ip: req.ip });
  });
  leaseAct('renew', async (db, a, l, req) => {
    if (!['active', 'ended'].includes(l.status)) throw bad('Only an active or ended lease can be renewed.');
    if ((await db.query("select 1 from leases where renewal_of = $1 and status <> 'cancelled'", [l.id])).rowCount) throw bad('A renewal already exists.');
    const start = addDays(rentLib.effectiveEnd(l), 1);
    const len = Math.round((Date.parse(l.end_date) - Date.parse(l.start_date)) / 864e5);
    const end = addDays(start, len);
    const rentNow = (await db.query('select rent_minor from lease_rent_steps where lease_id = $1 order by effective_from desc limit 1', [l.id])).rows[0];
    const year = start.slice(0, 4);
    const ref = `LSE-${year}-${String(await core.nextNumber(db, `LSE-${year}`)).padStart(4, '0')}`;
    const rentM = rentNow ? Number(rentNow.rent_minor) : Number(l.rent_minor);
    const nid = (await db.query(`insert into leases (workspace_id, unit_id, tenant_id, ref, start_date, end_date, rent_minor, frequency_months, proration, due_day_offset, deposit_minor, occupants, renewal_of, created_by, invoice_days_before, delivery, reminder_days)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) returning id`, [a.ws.id, l.unit_id, l.tenant_id, ref, start, end, rentM, l.frequency_months, l.proration, l.due_day_offset, l.deposit_minor, l.occupants, l.id, req.user.id, l.invoice_days_before, l.delivery, l.reminder_days])).rows[0].id;
    await db.query('insert into lease_rent_steps (lease_id, effective_from, rent_minor, reason, created_by) values ($1,$2,$3,$4,$5)', [nid, start, rentM, `Renewal of ${l.ref}`, req.user.id]);
    for (const c of (await db.query('select * from lease_charges where lease_id = $1 and active', [l.id])).rows) await db.query('insert into lease_charges (lease_id, description, amount_minor) values ($1,$2,$3)', [nid, c.description, c.amount_minor]);
    await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'lease.renewal_drafted', entity: 'lease', entityId: nid, summary: `Renewal ${ref} drafted for ${l.ref} (${start} to ${end})`, ip: req.ip });
    req._to = `/w/${a.ws.id}/leases/${nid}?msg=created`;
  });
  leaseAct('rent-step', async (db, a, l, req) => {
    if (!a.finance) throw new NotFound();
    const from = dateOrNull(req.body.effective_from); const rentM = parseMoney(req.body.rent, 'BHD'); const reason = txt(req.body.reason, 300);
    if (!from || rentM === null || rentM < 0 || !reason) throw bad('Enter the date, the new rent and the reason.');
    if (from <= l.start_date || from > rentLib.effectiveEnd(l)) throw bad('The change must fall inside the lease term, after its start.');
    const inv = (await db.query("select number from rent_invoices where lease_id = $1 and status <> 'void' and period_end >= $2 limit 1", [l.id, from])).rows[0];
    if (inv) throw bad(`${inv.number} already bills a period on or after ${from}. Void it first or choose a later date.`);
    try { await db.query('insert into lease_rent_steps (lease_id, effective_from, rent_minor, reason, created_by) values ($1,$2,$3,$4,$5)', [l.id, from, rentM, reason, req.user.id]); }
    catch (e) { if (e.code === '23505') throw bad('A rent change already starts on that date.'); throw e; }
    await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'lease.rent_changed', entity: 'lease', entityId: l.id, summary: `Rent for ${l.ref} from ${from}: ${formatMoney(rentM)} / month — ${reason}`, ip: req.ip });
  });
  leaseAct('charges', async (db, a, l, req) => {
    if (!a.finance) throw new NotFound();
    const d = txt(req.body.description, 120), amt = parseMoney(req.body.amount, 'BHD');
    if (!d || !amt || amt <= 0) throw bad('Enter the charge and the monthly amount.');
    await db.query('insert into lease_charges (lease_id, description, amount_minor) values ($1,$2,$3)', [l.id, d, amt]);
    await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'lease.charge_added', entity: 'lease', entityId: l.id, summary: `Recurring charge on ${l.ref}: ${d} ${formatMoney(amt)} / month`, ip: req.ip });
  });

  r.post('/w/:id/leases/:lid/events', upload.array('files', 12), async (req, res) => {
    if (!core.checkCsrf(req)) throw new Forbidden('Your form expired. Reload the page and try again.');
    const a = await access(req, 'contribute');
    const l = await own('leases', req.params.lid, a.ws.id);
    const kind = EVENT[req.body.kind] ? req.body.kind : 'other';
    const on = dateOrNull(req.body.on_date); if (!on) throw bad('Enter the date.');
    const files = await uploads.prepare(req.files, sniff);
    await core.inTx(async db => {
      const id = (await db.query('insert into lease_events (lease_id, kind, on_date, details, created_by) values ($1,$2,$3,$4,$5) returning id', [l.id, kind, on, txt(req.body.details, 4000), req.user.id])).rows[0].id;
      await uploads.insert(db, { workspaceId: a.ws.id, entity: 'lease_event', entityId: id, files, userId: req.user.id, tag: kind === 'move_out' ? 'move_out' : kind === 'move_in' ? 'move_in' : 'inspection', observedOn: on });
      if (kind === 'move_in') await db.query('update leases set move_in_date = $2 where id = $1', [l.id, on]);
      if (kind === 'move_out') await db.query('update leases set move_out_date = $2 where id = $1', [l.id, on]);
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: `lease.${kind}`, entity: 'lease', entityId: l.id, summary: `${EVENT[kind]} recorded for ${l.ref}${files.length ? ` with ${files.length} file(s)` : ''}`, ip: req.ip });
      await touch(db, a.ws.id);
    });
    res.redirect(`/w/${a.ws.id}/leases/${l.id}?msg=saved`);
  });

  // ---------- overview and portfolio ----------
  ctx.overviewExtras = ctx.overviewExtras || {};
  ctx.overviewExtras.props = async (req, wsAccess) => {
    const a = await core.workspaceAccess(req.user, wsAccess.ws.id);
    if (!a || !a.internal) return '';
    a.finance = core.isSuper(req.user) || a.role === 'manager' || a.role === 'editor' || await core.can(req.user, 'view:financials');
    return ctx.propsDashboard ? ctx.propsDashboard(req, a) : '';
  };
  ctx.portfolioExtras = ctx.portfolioExtras || {};
  ctx.portfolioExtras.props = async (ids, user) => {
    const out = {};
    for (const id of ids) out[id] = ctx.propsPortfolioRow ? await ctx.propsPortfolioRow(id, user) : {};
    return out;
  };

  return PR;
}

module.exports = { mountProperties, UNIT_STATUS, HOLDER, FREQ };
