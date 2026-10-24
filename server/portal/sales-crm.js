'use strict';
const CH = require('./choices');
const U = require('../lib/undo');
// Property Sales & Acquisition — people and pipeline: prospective buyers and their per-property opportunities,
// follow-ups and duplicates; viewings; offers with immutable versions and externally recorded decisions;
// deals (reservation, completion with evidence, fall-through); commissions on the shared fee ledger; sales
// expenses; the section dashboard tabs and reports.
const { layout, html, raw, pill, statusPill, csrfField, field, emptyState, fmtDate, fmtDateTime } = require('./views');
const { SECTIONS, KIND_LABEL } = require('./core');
const { parseMoney, formatMoney, toInput } = require('../lib/money');
const fees = require('../lib/fees');
const { L_STATUS, R_STATUS } = require('./sales-cases');

const UUID = /^[0-9a-f-]{36}$/i;
const bad = m => Object.assign(new Error(m), { status: 400 });
const txt = (v, n = 300) => { const s = String(v ?? '').trim().slice(0, n); return s || null; };
const dateOrNull = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : null;
const todayBH = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bahrain' });
const addDays = (d, n) => fees.addDays(d, n);
const fm = (m, c = 'BHD') => m === null || m === undefined ? '—' : formatMoney(Number(m), c);
const moneyOrNull = (v, label) => { if (v === undefined || String(v).trim() === '') return null; const m = parseMoney(v, 'BHD'); if (m === null || m < 0) throw bad(`Check ${label}.`); return m; };
// local Bahrain date-time "2026-11-03T10:30" → UTC instant
const bhInstant = v => { const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(String(v || '')); return m ? new Date(`${m[1]}T${m[2]}:${m[3]}:00+03:00`) : null; };
const bhTime = d => new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bahrain' });
const STAGES = { new: 'New enquiry', contacted: 'Contacted', qualified: 'Qualified', matched: 'Matched', viewing_arranged: 'Viewing arranged', viewing_completed: 'Viewing completed', negotiation: 'Offer / negotiation', in_progress: 'Transaction in progress', won: 'Won', lost: 'Lost', on_hold: 'On hold' };
const OPEN_STAGES = ['new', 'contacted', 'qualified', 'matched', 'viewing_arranged', 'viewing_completed', 'negotiation', 'in_progress'];
const V_STATUS = { tentative: 'Tentative', confirmed: 'Confirmed', completed: 'Completed', cancelled: 'Cancelled', rescheduled: 'Rescheduled', no_show: 'No-show' };
const O_STATUS = { draft: 'Draft', submitted: 'Submitted', countered: 'Countered', accepted: 'Accepted', rejected: 'Rejected', expired: 'Expired', withdrawn: 'Withdrawn' };
const ACT = { call: 'Call', meeting: 'Meeting', message: 'Message', email: 'Email', note: 'Note', promise: 'Promised action' };
const STALE_DAYS = 30;
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9@+]/g, '');
const normPhone = s => String(s || '').replace(/\D/g, '').slice(-8);

function mountSalesCrm(r, ctx) {
  const { pool, core, NotFound, Forbidden } = ctx;
  const SL = ctx.SL;

  async function gate(req) {
    const u = req.user;
    if (core.isExternal(u)) throw new NotFound();
    if (!(core.isSuper(u) || await core.can(u, 'create:sales'))) throw new Forbidden('Your role does not work in Property Sales & Acquisition.');
    return { seeFees: core.isSuper(u) || await core.can(u, 'view:financials') };
  }
  const SECTION_TABS = [['Sales Listings', '/s/sales?kind=listing'], ['Acquisition Requests', '/s/sales?kind=request'], ['Prospective Buyers', '/sales/buyers'], ['Viewings', '/sales/viewings'], ['Offers & Deals', '/sales/deals'], ['Fees & Reports', '/sales/reports']];
  ctx.sectionTabs = ctx.sectionTabs || {};
  ctx.sectionTabs.sales = cur => SECTION_TABS.map(([l, h]) => [l, h, l === cur]);
  const shell = (req, cur, body, crumbs = [], actions = null) => layout(req, { title: cur, heading: SECTIONS.sales.name, tabs: ctx.sectionTabs.sales(cur), crumbs: [['Home', '/'], [SECTIONS.sales.name, '/s/sales'], ...(crumbs.length ? crumbs : [[cur]])], actions, body });
  const users = async () => (await pool.query("select id, coalesce(nullif(name,''), email) as label from users where active and kind = 'internal' order by 2")).rows;
  const visibleCases = async user => new Set((await pool.query(`select w.id from workspaces w where w.section = 'sales' and ${core.visibleWhere(user)}`, [user.id])).rows.map(x => x.id));

  // ---------- prospective buyers ----------
  r.get('/sales/buyers', async (req, res) => {
    await gate(req);
    const q = String(req.query.q || '').trim().slice(0, 80);
    const show = ['active', 'overdue', 'stale', 'all'].includes(req.query.show) ? req.query.show : 'active';
    const rows = (await pool.query(`select p.id, p.name, p.phone, p.email, p.lead_source, coalesce(nullif(u.name,''), u.email) as agent, b.status, b.budget_max_minor, b.currency, b.locations, b.types,
        (select min(o.next_followup_on) from opportunities o where o.party_id = p.id and o.stage = any($2::text[])) as next_fu,
        (select max(x.occurred_on) from crm_activities x where x.party_id = p.id) as last_contact,
        (select count(*) from opportunities o where o.party_id = p.id and o.stage = any($2::text[]))::int as open_opps,
        (select count(*) from opportunities o where o.party_id = p.id and o.stage = any($2::text[]) and o.next_followup_on is null and o.no_followup_reason is null)::int as no_next
      from parties p join buyer_profiles b on b.party_id = p.id left join users u on u.id = p.agent_id
      where p.merged_into is null and p.archived_at is null ${q ? 'and (p.name ilike $1 or coalesce(p.phone,\'\') ilike $1 or coalesce(p.email,\'\') ilike $1)' : 'and ($1::text is null)'} order by p.name limit 1000`,
      [q ? `%${q.replace(/[%_\\]/g, '\\$&')}%` : null, OPEN_STAGES])).rows;
    const today = todayBH(), staleBefore = addDays(today, -STALE_DAYS);
    const list = rows.filter(x => show === 'all' ? true : show === 'overdue' ? x.next_fu && String(x.next_fu) < today : show === 'stale' ? x.status === 'active' && (!x.last_contact || String(x.last_contact) < staleBefore) : x.status === 'active');
    const overdue = rows.filter(x => x.next_fu && String(x.next_fu) < today).length;
    const dups = await duplicates();
    res.send(shell(req, 'Prospective Buyers', html`
      <form class="filters" method="get"><input type="search" name="q" value="${q}" placeholder="Name, phone, email" aria-label="Search buyers">
        <select name="show" aria-label="Show">${[['active', 'Active'], ['overdue', `Overdue follow-up (${overdue})`], ['stale', `No contact for ${STALE_DAYS} days`], ['all', 'All']].map(([v, l]) => html`<option value="${v}" ${v === show ? raw('selected') : ''}>${l}</option>`)}</select><button class="btn" type="submit">Apply</button>
        ${dups.length ? html`<span class="grow"></span><a class="btn small" href="/sales/duplicates">${dups.length} possible duplicate(s)</a>` : ''}</form>
      ${list.length ? html`<div class="table-wrap"><table><thead><tr><th>Buyer</th><th>Looking for</th><th class="n">Budget up to</th><th>Agent</th><th>Open enquiries</th><th>Last contact</th><th>Next follow-up</th></tr></thead><tbody>
        ${list.map(x => html`<tr><td><a href="/sales/buyers/${x.id}"><b>${x.name}</b></a><div class="muted small">${[x.phone, x.email].filter(Boolean).join(' · ')}${x.lead_source ? ` · ${x.lead_source}` : ''}</div></td>
          <td class="small">${[x.types, x.locations].filter(Boolean).join(' · ') || html`<span class="muted">Not stated</span>`}</td><td class="n">${x.budget_max_minor == null ? '—' : fm(x.budget_max_minor, x.currency)}</td><td class="small">${x.agent || html`<span class="warn-text">Unassigned</span>`}</td>
          <td>${x.open_opps}${x.no_next ? html` ${pill(`${x.no_next} without next action`, 'warn')}` : ''}</td><td class="small ${!x.last_contact || String(x.last_contact) < staleBefore ? 'warn-text' : ''}">${fmtDate(x.last_contact) || 'Never'}</td>
          <td class="small ${x.next_fu && String(x.next_fu) < today ? 'err' : ''}">${fmtDate(x.next_fu) || '—'}</td></tr>`)}</tbody></table></div>` : emptyState('No buyers here', 'Add a prospective buyer with the button above.')}`,
      [], html`<a class="btn accent" href="/sales/buyers/new">+ Add Prospective Buyer</a>`));
  });

  const PROFILE = [['purpose', 'Buying purpose'], ['types', 'Property types'], ['locations', 'Preferred locations'], ['budget_min', 'Budget from (BHD)'], ['budget_max', 'Budget up to (BHD)'], ['size_min_m2', 'Size from (m²)'], ['size_max_m2', 'Size to (m²)'], ['bedrooms_min', 'Bedrooms (at least)'], ['timing', 'Target timing'], ['funding', 'Funding readiness (as volunteered)']];
  const PROFILE_LISTS = { purpose: ['Own home', 'Investment', 'Holiday home', 'Business use'], types: [...CH.UNIT_TYPES, 'Land'], locations: CH.BH_AREAS,
    timing: ['Immediately', 'Within 3 months', 'Within 6 months', 'Within a year', 'No fixed date'], funding: ['Cash', 'Mortgage approved', 'Mortgage in progress', 'Mix of cash and mortgage'] };
  const profileForm = (req, p = {}, b = {}, action, label, agents) => html`<form method="post" action="${action}" class="panel form-grid">${csrfField(req)}
    ${field({ name: 'name', label: 'Name', required: true, value: p.name || '' })}${field({ name: 'phone', label: 'Telephone', type: 'tel', value: p.phone || '' })}${field({ name: 'email', label: 'Email', type: 'email', value: p.email || '' })}
    ${field({ name: 'preferred_contact', label: 'Preferred channel', value: p.preferred_contact || '', options: [['', 'Not stated'], ...(p.preferred_contact && !CH.CONTACT_CHANNELS.includes(p.preferred_contact) ? [[p.preferred_contact, p.preferred_contact]] : []), ...CH.CONTACT_CHANNELS.map(x => [x, x])] })}${field({ name: 'preferred_language', label: 'Preferred language', value: p.preferred_language || '', options: [['', 'Not stated'], ...(p.preferred_language && !CH.LANGUAGES.includes(p.preferred_language) ? [[p.preferred_language, p.preferred_language]] : []), ...CH.LANGUAGES.map(x => [x, x])] })}
    ${field({ name: 'lead_source', label: 'Source / referral / campaign', value: p.lead_source || '', list: CH.LEAD_SOURCES })}${field({ name: 'agent_id', label: 'Assigned agent', value: p.agent_id || req.user.id, options: [['', 'Unassigned'], ...agents.map(u => [u.id, u.label])] })}
    ${PROFILE.map(([k, l]) => { const col = k.startsWith('budget') ? `${k}_minor` : k; const v = b[col] == null ? '' : k.startsWith('budget') ? toInput(Number(b[col])) : String(b[col]); return html`<div class="q">${field({ name: k, label: l, value: v, list: PROFILE_LISTS[k] || null })}<label class="check small"><input type="checkbox" name="${k}__unknown" value="1" ${(b.unknown || []).includes(k) ? raw('checked') : ''}> Not stated</label></div>`; })}
    ${field({ name: 'notes', label: 'Notes', type: 'textarea', full: true, value: b.notes || '' })}
    <div class="actions full"><button class="btn primary" type="submit">${label}</button></div><p class="muted small full">Record only what the buyer told you; leave the rest empty or tick “Not stated”.</p></form>`;
  function readProfile(body) {
    const p = { name: txt(body.name, 160), phone: txt(body.phone, 40), email: txt(body.email, 160), preferred_contact: txt(body.preferred_contact, 60), preferred_language: txt(body.preferred_language, 40), lead_source: txt(body.lead_source, 120), agent_id: UUID.test(body.agent_id || '') ? body.agent_id : null };
    if (!p.name) throw bad('Enter the name.');
    if (p.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p.email)) throw bad('Check the email address.');
    const b = { unknown: [] };
    for (const [k, l] of PROFILE) {
      if (body[`${k}__unknown`] === '1') { b.unknown.push(k); if (k.startsWith('budget')) b[`${k}_minor`] = null; else b[k] = null; continue; }
      if (k.startsWith('budget')) b[`${k}_minor`] = moneyOrNull(body[k], l);
      else if (['size_min_m2', 'size_max_m2', 'bedrooms_min'].includes(k)) { const v = String(body[k] ?? '').trim(); b[k] = v === '' ? null : Number(v); if (b[k] !== null && !(b[k] >= 0)) throw bad(`${l} must be a positive number.`); }
      else b[k] = txt(body[k], 300);
    }
    b.notes = txt(body.notes, 2000);
    return { p, b };
  }
  async function dupCandidates(p, exceptId = null) {
    const rows = (await pool.query("select id, name, phone, email from parties where merged_into is null and archived_at is null and ($1::uuid is null or id <> $1)", [exceptId])).rows;
    return rows.filter(x => (p.email && x.email && norm(x.email) === norm(p.email)) || (p.phone && x.phone && normPhone(x.phone).length >= 7 && normPhone(x.phone) === normPhone(p.phone)));
  }
  async function duplicates() {
    const rows = (await pool.query("select p.id, p.name, p.phone, p.email from parties p join buyer_profiles b on b.party_id = p.id where p.merged_into is null and p.archived_at is null")).rows;
    const all = (await pool.query("select id, name, phone, email from parties where merged_into is null and archived_at is null")).rows;
    const out = []; const seen = new Set();
    for (const x of rows) for (const y of all) {
      if (x.id === y.id) continue;
      const key = [x.id, y.id].sort().join('|'); if (seen.has(key)) continue;
      const why = [];
      if (x.email && y.email && norm(x.email) === norm(y.email)) why.push('same email');
      if (x.phone && y.phone && normPhone(x.phone).length >= 7 && normPhone(x.phone) === normPhone(y.phone)) why.push('same phone');
      if (why.length) { seen.add(key); out.push({ a: x, b: y, why }); }
    }
    return out;
  }

  r.get('/sales/buyers/new', async (req, res) => {
    await gate(req);
    res.send(shell(req, 'Prospective Buyers', profileForm(req, {}, {}, '/sales/buyers', 'Add buyer', await users()), [['Prospective Buyers', '/sales/buyers'], ['New buyer']]));
  });
  r.post('/sales/buyers', async (req, res) => {
    await gate(req);
    const { p, b } = readProfile(req.body);
    const dups = await dupCandidates(p);
    if (dups.length && req.body.confirm_new !== '1') {
      return res.status(409).send(shell(req, 'Prospective Buyers', html`<div class="notice warn">Possible existing contact: ${dups.map((d, i) => html`${i ? ', ' : ''}<a href="/sales/buyers/${d.id}">${d.name}</a> (${[d.phone, d.email].filter(Boolean).join(' · ')})`)}. Open it instead, or confirm that this is a different person.</div>
        <form method="post" action="/sales/buyers" class="panel">${csrfField(req)}${Object.entries(req.body).filter(([k]) => k !== '_csrf').map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}<input type="hidden" name="confirm_new" value="1"><button class="btn" type="submit">It is a different person — add</button></form>`, [['Prospective Buyers', '/sales/buyers'], ['Check duplicate']]));
    }
    const id = await core.inTx(async db => {
      const id = (await db.query("insert into parties (name, phone, email, preferred_contact, preferred_language, lead_source, agent_id, roles, created_by) values ($1,$2,$3,$4,$5,$6,$7,'{prospect}',$8) returning id",
        [p.name, p.phone, p.email, p.preferred_contact, p.preferred_language, p.lead_source, p.agent_id, req.user.id])).rows[0].id;
      const cols = Object.keys(b);
      await db.query(`insert into buyer_profiles (party_id, ${cols.join(', ')}) values ($1, ${cols.map((c, i) => `$${i + 2}`).join(', ')})`, [id, ...cols.map(c => b[c])]);
      await core.audit(db, { actor: req.user, action: 'buyer.created', entity: 'party', entityId: id, summary: `Prospective buyer added: ${p.name}${p.lead_source ? ` (${p.lead_source})` : ''}`, ip: req.ip });
      return id;
    });
    res.redirect(`/sales/buyers/${id}?msg=created`);
  });

  async function buyerOf(req) {
    if (!UUID.test(req.params.pid)) throw new NotFound();
    const p = (await pool.query('select * from parties where id = $1', [req.params.pid])).rows[0];
    if (!p) throw new NotFound();
    if (p.merged_into) return { merged: p.merged_into };
    await pool.query('insert into buyer_profiles (party_id) values ($1) on conflict do nothing', [p.id]);
    p.b = (await pool.query('select * from buyer_profiles where party_id = $1', [p.id])).rows[0];
    return p;
  }

  r.get('/sales/buyers/:pid', async (req, res) => {
    await gate(req);
    const p = await buyerOf(req);
    if (p.merged) return res.redirect(`/sales/buyers/${p.merged}`);
    const vis = await visibleCases(req.user);
    const opps = (await pool.query(`select o.*, w.name as l_name, w.ref as l_ref, rq.name as r_name, coalesce(nullif(u.name,''), u.email) as agent, l.asking_minor, l.currency, l.status as l_status
      from opportunities o left join workspaces w on w.id = o.listing_ws left join workspaces rq on rq.id = o.request_ws left join users u on u.id = o.agent_id left join listings l on l.workspace_id = o.listing_ws
      where o.party_id = $1 order by (o.stage = any($2::text[])) desc, o.updated_at desc`, [p.id, OPEN_STAGES])).rows;
    const acts = (await pool.query("select x.*, coalesce(nullif(u.name,''), u.email) as agent from crm_activities x left join users u on u.id = x.agent_id where x.party_id = $1 order by x.occurred_on desc, x.created_at desc limit 200", [p.id])).rows;
    const views = (await pool.query("select v.*, w.name as l_name from viewings v left join workspaces w on w.id = v.listing_ws where v.party_id = $1 order by v.starts_at desc", [p.id])).rows;
    const offers = (await pool.query("select o.*, w.name as l_name, (select price_minor from offer_versions x where x.offer_id = o.id order by version desc limit 1) as last_price from offers o left join workspaces w on w.id = o.listing_ws where o.party_id = $1 order by o.created_at desc", [p.id])).rows;
    const requests = (await pool.query("select w.id, w.ref, w.name from workspaces w where w.section = 'sales' and w.kind = 'request' and w.party_id = $1", [p.id])).rows;
    const listings = (await pool.query(`select w.id, w.ref, w.name from workspaces w join listings l on l.workspace_id = w.id where w.section = 'sales' and w.kind = 'listing' and l.status in ('available','ready','under_offer') and ${core.visibleWhere(req.user)} order by w.name`, [req.user.id])).rows;
    const agents = await users();
    const today = todayBH();
    const cases = id => vis.has(id);
    res.send(shell(req, 'Prospective Buyers', html`
      <div class="split"><section class="panel grow1"><h2 class="h">${p.name} ${pill(p.b.status, p.b.status === 'active' ? 'ok' : 'muted')}</h2>
        <dl class="details"><div><dt>Contact</dt><dd>${[p.phone, p.email].filter(Boolean).join(' · ') || '—'}</dd></div><div><dt>Preferred channel / language</dt><dd>${p.preferred_contact || '—'} / ${p.preferred_language || '—'}</dd></div>
          <div><dt>Source</dt><dd>${p.lead_source || '—'}</dd></div><div><dt>Agent</dt><dd>${(agents.find(u => u.id === p.agent_id) || {}).label || html`<span class="warn-text">Unassigned</span>`}</dd></div>
          ${PROFILE.map(([k, l]) => { const col = k.startsWith('budget') ? `${k}_minor` : k; return html`<div><dt>${l}</dt><dd>${p.b.unknown.includes(k) ? pill('Not stated', 'info') : p.b[col] == null ? html`<span class="muted">—</span>` : k.startsWith('budget') ? fm(p.b[col], p.b.currency) : String(p.b[col])}</dd></div>`; })}
          ${p.b.notes ? html`<div><dt>Notes</dt><dd class="pre-line">${p.b.notes}</dd></div>` : ''}</dl>
        <details class="inline-form"><summary>Edit buyer</summary>${profileForm(req, p, p.b, `/sales/buyers/${p.id}`, 'Save', agents)}</details>
        <form method="post" action="/sales/buyers/${p.id}/status" class="actions">${csrfField(req)}<select name="status" aria-label="Buyer status">${[['active', 'Active'], ['on_hold', 'On hold'], ['closed', 'Closed']].map(([v, l]) => html`<option value="${v}" ${v === p.b.status ? raw('selected') : ''}>${l}</option>`)}</select><button class="btn small" type="submit">Set status</button>
          <span class="muted small">The buyer's status is separate from each property enquiry.</span></form>
        ${requests.length ? html`<p class="small">Acquisition requests: ${requests.map(x => html`<a href="/w/${x.id}">${x.ref}</a> `)}</p>` : ''}
        <form method="post" action="/sales/buyers/${p.id}/convert" class="actions">${csrfField(req)}<button class="btn small" type="submit">Convert to client: create an acquisition request</button></form>
      </section>
      <section class="panel grow2"><h2 class="h">Enquiries by property</h2>
        ${opps.length ? html`<div class="table-wrap"><table><thead><tr><th>Property / request</th><th>Stage</th><th>Agent</th><th>Next action</th><th>Follow-up</th><th></th></tr></thead><tbody>
          ${opps.map(o => html`<tr><td>${o.listing_ws ? (cases(o.listing_ws) ? html`<a href="/w/${o.listing_ws}">${o.l_name}</a>` : o.l_name) : o.r_name || 'General interest'}<div class="muted small">${o.l_ref || ''}${o.asking_minor != null ? ` · asking ${fm(o.asking_minor, o.currency)}` : ''}${o.l_status ? ` · ${L_STATUS[o.l_status]}` : ''}</div></td>
            <td>${pill(STAGES[o.stage], o.stage === 'won' ? 'ok' : o.stage === 'lost' ? 'muted' : 'info')}${o.lost_reason ? html`<div class="muted small">${o.lost_reason}</div>` : ''}</td><td class="small">${o.agent || '—'}</td>
            <td class="small">${o.next_action || (o.no_followup_reason ? html`<span class="muted">No follow-up: ${o.no_followup_reason}</span>` : OPEN_STAGES.includes(o.stage) ? html`<span class="warn-text">None set</span>` : '—')}</td>
            <td class="small ${o.next_followup_on && String(o.next_followup_on) < today && OPEN_STAGES.includes(o.stage) ? 'err' : ''}">${fmtDate(o.next_followup_on) || '—'}</td>
            <td><details class="inline-form"><summary class="small">Update</summary><form method="post" action="/sales/opportunities/${o.id}" class="form-grid">${csrfField(req)}
              ${field({ name: 'stage', label: 'Stage', value: o.stage, options: Object.entries(STAGES) })}${field({ name: 'agent_id', label: 'Agent', value: o.agent_id || '', options: [['', 'Unassigned'], ...agents.map(u => [u.id, u.label])] })}
              ${field({ name: 'next_action', label: 'Next action', value: o.next_action || '' })}${field({ name: 'next_followup_on', label: 'Next follow-up', type: 'date', value: o.next_followup_on ? String(o.next_followup_on) : '' })}
              ${field({ name: 'no_followup_reason', label: 'Or: reason for no follow-up', value: o.no_followup_reason || '' })}${field({ name: 'lost_reason', label: 'Lost / declined reason', value: o.lost_reason || '' })}
              <div class="actions full"><button class="btn small" type="submit">Save</button></div></form></details></td></tr>`)}</tbody></table></div>` : html`<p class="muted">No enquiries yet.</p>`}
        <details class="inline-form"><summary>Record interest in a listing</summary><form method="post" action="/sales/buyers/${p.id}/opportunities" class="form-grid">${csrfField(req)}
          ${field({ name: 'listing_ws', label: 'Listing', required: true, options: [['', 'Choose…'], ...listings.map(l => [l.id, `${l.ref} · ${l.name}`])] })}${field({ name: 'source', label: 'How the enquiry came', value: p.lead_source || '' })}
          ${field({ name: 'next_action', label: 'Next action', required: true })}${field({ name: 'next_followup_on', label: 'Next follow-up', type: 'date', required: true, value: addDays(today, 2) })}
          <div class="actions full"><button class="btn" type="submit">Add enquiry</button></div></form></details>
      </section></div>
      <div class="split"><section class="panel grow2"><h2 class="h">Communication history</h2>
        <form method="post" action="/sales/buyers/${p.id}/activities" class="form-grid">${csrfField(req)}
          ${field({ name: 'kind', label: 'Type', options: Object.entries(ACT) })}${field({ name: 'occurred_on', label: 'Date', type: 'date', value: today, required: true })}
          ${field({ name: 'opportunity_id', label: 'About', options: [['', 'General'], ...opps.filter(o => OPEN_STAGES.includes(o.stage)).map(o => [o.id, o.l_name || o.r_name || 'Enquiry'])] })}
          ${field({ name: 'next_followup_on', label: 'Next follow-up', type: 'date' })}${field({ name: 'summary', label: 'Summary', type: 'textarea', required: true, full: true })}${field({ name: 'outcome', label: 'Outcome', full: true })}
          <div class="actions full"><button class="btn" type="submit">Log</button></div></form>
        ${acts.length ? html`<ol class="feed">${acts.map(x => html`<li><b>${ACT[x.kind]} · ${fmtDate(x.occurred_on)}</b><div class="pre-line">${x.summary}</div>${x.outcome ? html`<div class="small">Outcome: ${x.outcome}</div>` : ''}<div class="muted small">${x.agent || ''}${x.next_followup_on ? ` · next follow-up ${fmtDate(x.next_followup_on)}` : ''}</div></li>`)}</ol>` : html`<p class="muted">Nothing logged yet.</p>`}
      </section>
      <section class="panel grow1"><h2 class="h">Viewings</h2>${views.length ? html`<ul class="rows">${views.map(v => html`<li><div class="grow">${bhTime(v.starts_at)} · ${v.l_name || 'External property'}<div class="muted small">${v.feedback || ''}</div></div>${pill(V_STATUS[v.status], v.status === 'completed' ? 'ok' : ['cancelled', 'no_show'].includes(v.status) ? 'muted' : 'warn')}</li>`)}</ul>` : html`<p class="muted">None.</p>`}
        <h3 class="h3">Offers</h3>${offers.length ? html`<ul class="rows">${offers.map(o => html`<li><div class="grow">${o.ref} · ${o.l_name || 'External'}<div class="muted small">${fm(o.last_price)}</div></div>${pill(O_STATUS[o.status], o.status === 'accepted' ? 'ok' : 'info')}</li>`)}</ul>` : html`<p class="muted">None.</p>`}</section></div>`,
      [['Prospective Buyers', '/sales/buyers'], [p.name]]));
  });

  r.post('/sales/buyers/:pid', async (req, res) => {
    await gate(req);
    const cur = await buyerOf(req); if (cur.merged) throw new NotFound();
    const { p, b } = readProfile(req.body);
    await core.inTx(async db => U.track(db, req.user, { label: `Edited buyer ${cur.name}`, returnTo: `/sales/buyers/${cur.id}`, targets: [['parties', cur.id], ['buyer_profiles', cur.id]] }, async () => {
      await db.query('update parties set name = $2, phone = $3, email = $4, preferred_contact = $5, preferred_language = $6, lead_source = $7, agent_id = $8, updated_at = now() where id = $1', [cur.id, p.name, p.phone, p.email, p.preferred_contact, p.preferred_language, p.lead_source, p.agent_id]);
      const cols = Object.keys(b);
      await db.query(`update buyer_profiles set ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}, updated_at = now() where party_id = $1`, [cur.id, ...cols.map(c => b[c])]);
      await core.audit(db, { actor: req.user, action: 'buyer.updated', entity: 'party', entityId: cur.id, summary: `Buyer updated: ${p.name}`, ip: req.ip });
    }));
    res.redirect(`/sales/buyers/${cur.id}?msg=saved`);
  });
  r.post('/sales/buyers/:pid/status', async (req, res) => {
    await gate(req);
    const p = await buyerOf(req); if (p.merged) throw new NotFound();
    const st = ['active', 'on_hold', 'closed'].includes(req.body.status) ? req.body.status : null; if (!st) throw bad('Choose a status.');
    await core.inTx(async db => { await db.query('update buyer_profiles set status = $2 where party_id = $1', [p.id, st]); await core.audit(db, { actor: req.user, action: 'buyer.status', entity: 'party', entityId: p.id, summary: `Buyer ${p.name}: ${st}`, ip: req.ip }); });
    res.redirect(`/sales/buyers/${p.id}?msg=saved`);
  });
  async function addEnquiry(req, pid, a) {
    const p = (await pool.query('select * from parties where id = $1 and merged_into is null', [pid])).rows[0];
    if (!p) throw bad('Choose the buyer.');
    await pool.query('insert into buyer_profiles (party_id) values ($1) on conflict do nothing', [p.id]);
    if (a.ws.party_id === p.id) throw bad('This person is the seller of that listing.');
    const na = txt(req.body.next_action, 200), fu = dateOrNull(req.body.next_followup_on);
    if (!na || !fu) throw bad('An active enquiry needs a next action and a follow-up date.');
    try {
      await core.inTx(async db => {
        const id = (await db.query("insert into opportunities (party_id, listing_ws, stage, source, agent_id, next_action, next_followup_on, created_by) values ($1,$2,'new',$3,$4,$5,$6,$4) returning id", [p.id, a.ws.id, txt(req.body.source, 120), req.user.id, na, fu])).rows[0].id;
        await db.query("update parties set roles = array_append(roles, 'prospect') where id = $1 and not ('prospect' = any(roles))", [p.id]);
        await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'enquiry.recorded', entity: 'opportunity', entityId: id, summary: `Enquiry from ${p.name}`, ip: req.ip });
      });
    } catch (e) { if (e.code === '23505') throw bad('This buyer already has an enquiry for that listing.'); throw e; }
  }
  r.post('/sales/buyers/:pid/opportunities', async (req, res) => {
    await gate(req);
    const p = await buyerOf(req); if (p.merged) throw new NotFound();
    if (!UUID.test(req.body.listing_ws || '')) throw bad('Choose a listing.');
    const a = await core.workspaceAccess(req.user, req.body.listing_ws);
    if (!a || a.ws.section !== 'sales' || a.ws.kind !== 'listing' || !core.canContribute(a)) throw bad('Choose a listing you can work on.');
    await addEnquiry(req, p.id, a);
    res.redirect(`/sales/buyers/${p.id}?msg=added`);
  });
  r.post('/sales/buyers/:pid/activities', async (req, res) => {
    await gate(req);
    const p = await buyerOf(req); if (p.merged) throw new NotFound();
    const kind = ACT[req.body.kind] ? req.body.kind : 'note'; const on = dateOrNull(req.body.occurred_on); const summary = txt(req.body.summary, 4000);
    if (!on || !summary) throw bad('Enter the date and a summary.');
    const opp = UUID.test(req.body.opportunity_id || '') ? (await pool.query('select * from opportunities where id = $1 and party_id = $2', [req.body.opportunity_id, p.id])).rows[0] : null;
    const fu = dateOrNull(req.body.next_followup_on);
    await core.inTx(async db => {
      await db.query('insert into crm_activities (party_id, opportunity_id, workspace_id, kind, occurred_on, summary, outcome, next_followup_on, agent_id, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)',
        [p.id, opp && opp.id, opp && (opp.listing_ws || opp.request_ws), kind, on, summary, txt(req.body.outcome, 500), fu, req.user.id]);
      if (opp) await db.query("update opportunities set last_contact_on = greatest(coalesce(last_contact_on, $2), $2), next_followup_on = coalesce($3, next_followup_on), stage = case when stage = 'new' then 'contacted' else stage end, updated_at = now() where id = $1", [opp.id, on, fu]);
      await core.audit(db, { actor: req.user, workspaceId: opp && (opp.listing_ws || opp.request_ws), action: 'crm.activity', entity: 'party', entityId: p.id, summary: `${ACT[kind]} with ${p.name} logged`, ip: req.ip });
    });
    res.redirect(`/sales/buyers/${p.id}?msg=added`);
  });
  r.post('/sales/opportunities/:oid', async (req, res) => {
    await gate(req);
    if (!UUID.test(req.params.oid)) throw new NotFound();
    const o = (await pool.query('select * from opportunities where id = $1', [req.params.oid])).rows[0]; if (!o) throw new NotFound();
    const stage = STAGES[req.body.stage] ? req.body.stage : o.stage;
    const na = txt(req.body.next_action, 200), fu = dateOrNull(req.body.next_followup_on), nf = txt(req.body.no_followup_reason, 200), lost = txt(req.body.lost_reason, 300);
    if (OPEN_STAGES.includes(stage) && !(na && fu) && !nf) throw bad('An active enquiry needs a next action and follow-up date, or a reason for no follow-up.');
    if (stage === 'lost' && !lost) throw bad('Give the lost / declined reason.');
    if (stage === 'won' && o.stage !== 'won') throw bad('An enquiry is won when its deal is completed.');
    await core.inTx(async db => {
      await db.query('update opportunities set stage = $2, agent_id = $3, next_action = $4, next_followup_on = $5, no_followup_reason = $6, lost_reason = $7, updated_at = now() where id = $1', [o.id, stage, UUID.test(req.body.agent_id || '') ? req.body.agent_id : null, na, fu, nf, lost]);
      await core.audit(db, { actor: req.user, workspaceId: o.listing_ws || o.request_ws, action: 'enquiry.updated', entity: 'opportunity', entityId: o.id, summary: `Enquiry ${STAGES[o.stage]} → ${STAGES[stage]}${lost ? `: ${lost}` : ''}`, ip: req.ip });
    });
    res.redirect(req.body.back ? String(req.body.back).replace(/[^/\w?=&-]/g, '') : `/sales/buyers/${o.party_id}?msg=saved`);
  });
  r.post('/sales/buyers/:pid/convert', async (req, res) => {
    await gate(req);
    if (!(core.isSuper(req.user) || await core.can(req.user, 'create:sales'))) throw new Forbidden('Your role cannot create requests.');
    const p = await buyerOf(req); if (p.merged) throw new NotFound();
    const id = await core.inTx(async db => {
      const year = todayBH().slice(0, 4);
      const ref = `AR-${year}-${String(await core.nextNumber(db, `AR-${year}`)).padStart(3, '0')}`;
      const w = (await db.query("insert into workspaces (section, kind, ref, name, party_id, manager_id, created_by) values ('sales','request',$1,$2,$3,$4,$4) returning id", [ref, `${p.name} — property search`, p.id, req.user.id])).rows[0].id;
      await db.query("insert into workspace_members (workspace_id, user_id, role, added_by) values ($1,$2,'manager',$2)", [w, req.user.id]);
      await db.query("update parties set roles = array_append(roles, 'buyer') where id = $1 and not ('buyer' = any(roles))", [p.id]);
      const b = p.b;
      await db.query(`insert into request_briefs (workspace_id, version, purpose, types, locations, budget_min_minor, budget_max_minor, currency, built_min_m2, built_max_m2, bedrooms_min, timing, funding, unknown, change_reason, created_by)
        values ($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'Started from the buyer profile — confirm with the client',$14)`, [w, b.purpose, b.types, b.locations, b.budget_min_minor, b.budget_max_minor, b.currency, b.size_min_m2, b.size_max_m2, b.bedrooms_min, b.timing, b.funding, b.unknown, req.user.id]);
      await db.query("insert into acq_requests (workspace_id, status) values ($1, 'draft')", [w]);
      await db.query('update opportunities set request_ws = $2 where party_id = $1 and request_ws is null', [p.id, w]);
      await core.audit(db, { actor: req.user, workspaceId: w, action: 'workspace.created', entity: 'workspace', entityId: w, summary: `Acquisition request ${ref} created from prospective buyer ${p.name} (enquiry history kept)`, ip: req.ip });
      return w;
    });
    res.redirect(`/w/${id}/brief?msg=created`);
  });

  // ---------- duplicates ----------
  r.get('/sales/duplicates', async (req, res) => {
    await gate(req);
    const d = await duplicates();
    res.send(shell(req, 'Prospective Buyers', html`<section class="panel"><h2 class="h">Possible duplicate contacts</h2>
      <p class="muted small">Matched only on the same email or the same phone number — never on similar names. Merging moves enquiries, activities, viewings and offers to the kept record and marks the other as merged; nothing is deleted.</p>
      ${d.length ? html`<div class="table-wrap"><table><thead><tr><th>Contact A</th><th>Contact B</th><th>Why</th><th></th></tr></thead><tbody>${d.map(x => html`<tr><td><a href="/sales/buyers/${x.a.id}">${x.a.name}</a><div class="muted small">${[x.a.phone, x.a.email].filter(Boolean).join(' · ')}</div></td><td>${x.b.name}<div class="muted small">${[x.b.phone, x.b.email].filter(Boolean).join(' · ')}</div></td><td>${x.why.join(', ')}</td>
        <td><form method="post" action="/sales/duplicates/merge" class="actions">${csrfField(req)}<input type="hidden" name="keep" value="${x.a.id}"><input type="hidden" name="merge" value="${x.b.id}"><button class="btn small" type="submit">Keep A, merge B into it</button></form>
          <form method="post" action="/sales/duplicates/merge" class="actions">${csrfField(req)}<input type="hidden" name="keep" value="${x.b.id}"><input type="hidden" name="merge" value="${x.a.id}"><button class="btn small" type="submit">Keep B</button></form></td></tr>`)}</tbody></table></div>` : html`<p class="muted">None found.</p>`}</section>`, [['Prospective Buyers', '/sales/buyers'], ['Duplicates']]));
  });
  r.post('/sales/duplicates/merge', async (req, res) => {
    await gate(req);
    if (!(core.isSuper(req.user) || await core.can(req.user, 'create:sales'))) throw new Forbidden('Not allowed.');
    const keep = UUID.test(req.body.keep || '') ? req.body.keep : null, merge = UUID.test(req.body.merge || '') ? req.body.merge : null;
    if (!keep || !merge || keep === merge) throw bad('Choose two contacts.');
    await core.inTx(async db => {
      const [k, m] = [(await db.query('select * from parties where id = $1 for update', [keep])).rows[0], (await db.query('select * from parties where id = $1 for update', [merge])).rows[0]];
      if (!k || !m || k.merged_into || m.merged_into) throw bad('One of the contacts is already merged.');
      const sameEmail = k.email && m.email && norm(k.email) === norm(m.email), samePhone = k.phone && m.phone && normPhone(k.phone) === normPhone(m.phone) && normPhone(k.phone).length >= 7;
      if (!sameEmail && !samePhone) throw bad('These contacts share no email or phone; they are not merged.');
      // clashing enquiries for the same listing are kept on the merged record (history) rather than overwritten
      await db.query('update opportunities o set party_id = $1 where party_id = $2 and not exists (select 1 from opportunities x where x.party_id = $1 and x.listing_ws = o.listing_ws)', [keep, merge]);
      for (const t of ['crm_activities', 'viewings', 'offers']) await db.query(`update ${t} set party_id = $1 where party_id = $2`, [keep, merge]);
      await db.query("update parties set roles = (select array_agg(distinct x) from unnest(roles || $2::text[]) x), phone = coalesce(phone, $3), email = coalesce(email, $4) where id = $1", [keep, m.roles, m.phone, m.email]);
      await db.query('insert into buyer_profiles (party_id) values ($1) on conflict do nothing', [keep]);
      await db.query("update parties set merged_into = $1, archived_at = now() where id = $2", [keep, merge]);
      await core.audit(db, { actor: req.user, action: 'contact.merged', entity: 'party', entityId: keep, summary: `Contact “${m.name}” merged into “${k.name}” (${sameEmail ? 'same email' : 'same phone'})`, before: { merged: merge }, ip: req.ip });
    });
    res.redirect(`/sales/buyers/${keep}?msg=saved`);
  });

  // ---------- listing tab: buyers & viewings ----------
  r.get('/w/:id/buyers', async (req, res) => {
    const a = await SL.access(req);
    if (a.ws.kind !== 'listing') throw new NotFound();
    const opps = (await pool.query(`select o.*, p.name, p.phone, p.email, coalesce(nullif(u.name,''), u.email) as agent from opportunities o join parties p on p.id = o.party_id left join users u on u.id = o.agent_id
      where o.listing_ws = $1 order by (o.stage = any($2::text[])) desc, o.updated_at desc`, [a.ws.id, OPEN_STAGES])).rows;
    const views = (await pool.query("select v.*, p.name, coalesce(nullif(u.name,''), u.email) as agent from viewings v join parties p on p.id = v.party_id left join users u on u.id = v.agent_id where v.listing_ws = $1 order by v.starts_at desc", [a.ws.id])).rows;
    const buyers = (await pool.query("select p.id, p.name from parties p join buyer_profiles b on b.party_id = p.id where p.merged_into is null and b.status <> 'closed' order by p.name limit 1000")).rows;
    const M = await SL.mandateState(a.ws.id);
    const today = todayBH();
    const edit = core.canContribute(a);
    res.send(SL.page(req, a, 'Buyers & Viewings', html`
      ${!M.canAct ? html`<div class="notice warn">Viewings need an active, verified mandate.</div>` : ''}
      <section class="panel"><h2 class="h">Enquiries for this property</h2>
        <p class="muted small">${opps.length} enquiry(ies) from ${new Set(opps.map(o => o.party_id)).size} unique buyer(s).</p>
        ${opps.length ? html`<div class="table-wrap"><table><thead><tr><th>Buyer</th><th>Stage</th><th>Agent</th><th>Next action</th><th>Follow-up</th></tr></thead><tbody>
          ${opps.map(o => html`<tr><td><a href="/sales/buyers/${o.party_id}">${o.name}</a><div class="muted small">${[o.phone, o.email].filter(Boolean).join(' · ')}${o.source ? ` · ${o.source}` : ''}</div></td><td>${pill(STAGES[o.stage], o.stage === 'lost' ? 'muted' : 'info')}</td><td class="small">${o.agent || '—'}</td>
            <td class="small">${o.next_action || o.no_followup_reason || '—'}</td><td class="small ${o.next_followup_on && String(o.next_followup_on) < today && OPEN_STAGES.includes(o.stage) ? 'err' : ''}">${fmtDate(o.next_followup_on) || '—'}</td></tr>`)}</tbody></table></div>` : html`<p class="muted">No enquiries yet.</p>`}
        ${edit ? html`<details class="inline-form"><summary>Record an enquiry from an existing buyer</summary><form method="post" action="/w/${a.ws.id}/enquiries" class="form-grid">${csrfField(req)}
          ${field({ name: 'pid', label: 'Buyer', required: true, options: [['', 'Choose…'], ...buyers.map(b => [b.id, b.name])] })}${field({ name: 'source', label: 'How the enquiry came' })}
          ${field({ name: 'next_action', label: 'Next action', required: true })}${field({ name: 'next_followup_on', label: 'Next follow-up', type: 'date', required: true, value: addDays(today, 2) })}
          <div class="actions full"><button class="btn" type="submit">Add enquiry</button><a class="btn" href="/sales/buyers/new">+ New buyer</a></div></form></details>` : ''}
      </section>
      <section class="panel"><h2 class="h">Viewings</h2>
        ${viewTable(req, views, true)}
        ${edit && M.canAct ? viewForm(req, { listing_ws: a.ws.id, buyers: opps.filter(o => OPEN_STAGES.includes(o.stage)).map(o => [o.party_id, o.name]), back: `/w/${a.ws.id}/buyers` }) : ''}
      </section>`));
  });
  r.post('/w/:id/enquiries', async (req, res) => {
    const a = await SL.access(req, 'contribute');
    if (a.ws.kind !== 'listing') throw new NotFound();
    if (!UUID.test(req.body.pid || '')) throw bad('Choose the buyer.');
    await addEnquiry(req, req.body.pid, a);
    res.redirect(`/w/${a.ws.id}/buyers?msg=added`);
  });

  // ---------- viewings ----------
  const viewTable = (req, views, showBuyer) => views.length ? html`<div class="table-wrap"><table><thead><tr><th>When</th>${showBuyer ? html`<th>Buyer</th>` : html`<th>Property</th>`}<th>Agent</th><th>Status</th><th>Feedback</th><th></th></tr></thead><tbody>
    ${views.map(v => html`<tr><td class="small">${bhTime(v.starts_at)}<div class="muted">${v.location || ''}</div></td><td>${showBuyer ? v.name : v.l_name || 'External property'}</td><td class="small">${v.agent || '—'}</td>
      <td>${pill(V_STATUS[v.status], v.status === 'completed' ? 'ok' : ['cancelled', 'no_show', 'rescheduled'].includes(v.status) ? 'muted' : 'warn')}${v.status === 'completed' || new Date(v.starts_at) > new Date() || !['tentative', 'confirmed'].includes(v.status) ? '' : html`<div class="err small">Outcome not recorded</div>`}</td>
      <td class="small">${v.feedback || ''}${v.objections ? html`<div class="muted">Objections: ${v.objections}</div>` : ''}${v.owner_summary ? html`<div class="muted">For the owner: ${v.owner_summary}</div>` : ''}</td>
      <td>${['tentative', 'confirmed'].includes(v.status) ? html`<details class="inline-form"><summary class="small">Update</summary><form method="post" action="/sales/viewings/${v.id}" class="form-grid">${csrfField(req)}
        ${field({ name: 'status', label: 'Status', options: [['confirmed', 'Confirmed'], ['completed', 'Completed'], ['no_show', 'No-show'], ['cancelled', 'Cancelled'], ['rescheduled', 'Rescheduled']] })}
        ${field({ name: 'new_start', label: 'New time (if rescheduled)', type: 'datetime-local' })}${field({ name: 'attended', label: 'Who attended' })}
        ${field({ name: 'feedback', label: 'Feedback', type: 'textarea' })}${field({ name: 'objections', label: 'Objections' })}${field({ name: 'owner_summary', label: 'Summary the owner may see (no private buyer data)' })}
        ${field({ name: 'next_followup_on', label: 'Next follow-up', type: 'date' })}<div class="actions full"><button class="btn small" type="submit">Save</button></div></form></details>` : ''}</td></tr>`)}</tbody></table></div>` : html`<p class="muted">No viewings.</p>`;
  const viewForm = (req, o) => html`<details class="inline-form"><summary>Schedule a viewing</summary><form method="post" action="/sales/viewings" class="form-grid">${csrfField(req)}
    ${o.listing_ws ? html`<input type="hidden" name="listing_ws" value="${o.listing_ws}">` : ''}${o.request_ws ? html`<input type="hidden" name="request_ws" value="${o.request_ws}">` : ''}<input type="hidden" name="back" value="${o.back}">
    ${o.options ? field({ name: 'target', label: 'Property', required: true, options: [['', 'Choose…'], ...o.options] }) : ''}
    ${o.buyers ? field({ name: 'party_id', label: 'Buyer', required: true, options: [['', 'Choose…'], ...o.buyers] }) : html`<input type="hidden" name="party_id" value="${o.party_id}">`}
    ${field({ name: 'starts_at', label: 'Date and time (Bahrain)', type: 'datetime-local', required: true })}${field({ name: 'minutes', label: 'Duration (minutes)', type: 'number', value: '45' })}
    ${field({ name: 'location', label: 'Meeting point' })}${field({ name: 'access', label: 'Access arrangements' })}${field({ name: 'contact', label: 'Contact on site' })}
    ${field({ name: 'status', label: 'Status', options: [['tentative', 'Tentative'], ['confirmed', 'Confirmed']] })}
    <label class="field check full"><input type="checkbox" name="accept_conflict" value="1"> <span>Book even if it overlaps another viewing of this property or agent</span></label>
    <div class="actions full"><button class="btn" type="submit">Schedule</button></div><p class="muted small full">Scheduling records the appointment; it does not send an invitation.</p></form></details>`;
  ctx.viewTable = viewTable; ctx.viewForm = viewForm;

  r.post('/sales/viewings', async (req, res) => {
    await gate(req);
    const b = req.body;
    let listing = UUID.test(b.listing_ws || '') ? b.listing_ws : null, ext = null;
    if (b.target) { if (String(b.target).startsWith('l:')) listing = b.target.slice(2); else if (String(b.target).startsWith('e:')) ext = b.target.slice(2); }
    const requestWs = UUID.test(b.request_ws || '') ? b.request_ws : null;
    if (!listing && !ext) throw bad('Choose the property.');
    if (listing) { const la = await core.workspaceAccess(req.user, listing); if (!la || la.ws.kind !== 'listing' || !core.canContribute(la)) throw new NotFound(); await SL.requireMandate(listing, 'A viewing'); }
    if (requestWs) { const ra = await core.workspaceAccess(req.user, requestWs); if (!ra || ra.ws.kind !== 'request' || !core.canContribute(ra)) throw new NotFound(); if (ext) { if (!(await pool.query('select 1 from external_opps where id = $1 and workspace_id = $2', [ext, requestWs])).rowCount) throw new NotFound(); await SL.requireMandate(requestWs, 'A viewing'); } }
    if (!UUID.test(b.party_id || '')) throw bad('Choose the buyer.');
    const start = bhInstant(b.starts_at); if (!start) throw bad('Enter the date and time.');
    const mins = Math.min(480, Math.max(10, parseInt(b.minutes, 10) || 45));
    const end = new Date(start.getTime() + mins * 60000);
    const clash = (await pool.query(`select v.starts_at, w.name from viewings v left join workspaces w on w.id = v.listing_ws where v.status in ('tentative','confirmed') and v.starts_at < $3 and v.ends_at > $2
      and ((v.listing_ws is not null and v.listing_ws = $1::uuid) or v.agent_id = $4)`, [listing, start, end, req.user.id])).rows;
    if (clash.length && b.accept_conflict !== '1') throw bad(`This overlaps ${clash.map(c => `${c.name || 'a viewing'} at ${bhTime(c.starts_at)}`).join(', ')}. Tick “Book even if it overlaps” to keep both.`);
    await core.inTx(async db => {
      const opp = listing ? (await db.query('select id from opportunities where party_id = $1 and listing_ws = $2', [b.party_id, listing])).rows[0] : null;
      const id = (await db.query(`insert into viewings (listing_ws, external_id, request_ws, party_id, opportunity_id, agent_id, starts_at, ends_at, location, access, contact, status, created_by)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$6) returning id`, [listing, ext, requestWs, b.party_id, opp && opp.id, req.user.id, start, end, txt(b.location, 200), txt(b.access, 300), txt(b.contact, 120), b.status === 'confirmed' ? 'confirmed' : 'tentative'])).rows[0].id;
      if (opp) await db.query("update opportunities set stage = case when stage in ('new','contacted','qualified','matched') then 'viewing_arranged' else stage end, updated_at = now() where id = $1", [opp.id]);
      if (requestWs) await db.query("update acq_requests set status = case when status in ('brief_confirmed','searching','shortlist_shared') then 'viewings' else status end where workspace_id = $1", [requestWs]);
      await core.audit(db, { actor: req.user, workspaceId: listing || requestWs, action: 'viewing.scheduled', entity: 'viewing', entityId: id, summary: `Viewing scheduled for ${bhTime(start)}${clash.length ? ' (overlap accepted)' : ''}`, ip: req.ip });
    });
    res.redirect((b.back && String(b.back).startsWith('/') ? b.back : '/sales/viewings') + '?msg=added');
  });

  r.post('/sales/viewings/:vid', async (req, res) => {
    await gate(req);
    if (!UUID.test(req.params.vid)) throw new NotFound();
    const v = (await pool.query('select * from viewings where id = $1', [req.params.vid])).rows[0]; if (!v) throw new NotFound();
    const wsId = v.listing_ws || v.request_ws;
    const a = await core.workspaceAccess(req.user, wsId); if (!a || !core.canContribute(a)) throw new NotFound();
    const to = V_STATUS[req.body.status] ? req.body.status : null; if (!to) throw bad('Choose the status.');
    if (!['tentative', 'confirmed'].includes(v.status)) throw bad('This viewing is closed.');
    if (to === 'completed' && !txt(req.body.feedback, 2000)) throw bad('Record the feedback after a completed viewing.');
    await core.inTx(async db => {
      let newId = null;
      if (to === 'rescheduled') {
        const s = bhInstant(req.body.new_start); if (!s) throw bad('Enter the new time.');
        const e = new Date(s.getTime() + (new Date(v.ends_at) - new Date(v.starts_at)));
        newId = (await db.query(`insert into viewings (listing_ws, external_id, request_ws, party_id, opportunity_id, agent_id, starts_at, ends_at, location, access, contact, status, created_by) select listing_ws, external_id, request_ws, party_id, opportunity_id, agent_id, $2, $3, location, access, contact, 'tentative', $4 from viewings where id = $1 returning id`, [v.id, s, e, req.user.id])).rows[0].id;
      }
      await db.query('update viewings set status = $2, attended = $3, feedback = $4, objections = $5, owner_summary = $6, next_followup_on = $7, rescheduled_to = $8 where id = $1',
        [v.id, to, txt(req.body.attended, 200), txt(req.body.feedback, 2000), txt(req.body.objections, 500), txt(req.body.owner_summary, 1000), dateOrNull(req.body.next_followup_on), newId]);
      if (v.opportunity_id && to === 'completed') await db.query("update opportunities set stage = case when stage in ('new','contacted','qualified','matched','viewing_arranged') then 'viewing_completed' else stage end, next_followup_on = coalesce($2, next_followup_on), last_contact_on = $3, updated_at = now() where id = $1", [v.opportunity_id, dateOrNull(req.body.next_followup_on), todayBH()]);
      await core.audit(db, { actor: req.user, workspaceId: wsId, action: `viewing.${to}`, entity: 'viewing', entityId: v.id, summary: `Viewing of ${bhTime(v.starts_at)}: ${V_STATUS[to]}`, ip: req.ip });
    });
    res.redirect(req.get('referer') && new URL(req.get('referer')).host === req.get('host') ? new URL(req.get('referer')).pathname + '?msg=saved' : '/sales/viewings?msg=saved');
  });

  r.get('/sales/viewings', async (req, res) => {
    await gate(req);
    const vis = await visibleCases(req.user);
    const rows = (await pool.query(`select v.*, p.name, w.name as l_name, coalesce(nullif(u.name,''), u.email) as agent from viewings v join parties p on p.id = v.party_id left join workspaces w on w.id = v.listing_ws left join users u on u.id = v.agent_id
      where v.starts_at > now() - interval '60 days' order by v.starts_at`, [])).rows.filter(v => vis.has(v.listing_ws || v.request_ws));
    const now = new Date();
    const pending = rows.filter(v => ['tentative', 'confirmed'].includes(v.status) && new Date(v.starts_at) < now);
    res.send(shell(req, 'Viewings', html`
      ${pending.length ? html`<div class="notice warn">${pending.length} past viewing(s) have no recorded outcome.</div>` : ''}
      <section class="panel"><h2 class="h">Upcoming</h2>${viewTable(req, rows.filter(v => new Date(v.starts_at) >= now).map(v => ({ ...v, name: `${v.name} · ${v.l_name || 'External'}` })), true)}</section>
      <section class="panel"><h2 class="h">Last 60 days</h2>${viewTable(req, rows.filter(v => new Date(v.starts_at) < now).reverse().map(v => ({ ...v, name: `${v.name} · ${v.l_name || 'External'}` })), true)}</section>`));
  });

  // ---------- offers ----------
  async function offerFull(oid) {
    const o = (await pool.query('select o.*, p.name as buyer, w.name as l_name, w.party_id as seller_id, e.title as e_title from offers o join parties p on p.id = o.party_id left join workspaces w on w.id = o.listing_ws left join external_opps e on e.id = o.external_id where o.id = $1', [oid])).rows[0];
    if (!o) return null;
    o.versions = (await pool.query("select v.*, coalesce(nullif(u.name,''), u.email) as by from offer_versions v left join users u on u.id = v.created_by where v.offer_id = $1 order by version", [o.id])).rows;
    o.last = o.versions[o.versions.length - 1];
    o.deal = (await pool.query('select workspace_id, status from deals where offer_id = $1', [o.id])).rows[0] || null;
    return o;
  }
  const offerBlock = (req, o, canEdit) => html`<div class="panel-inner"><div class="row-between"><b>${o.ref} · ${o.buyer} → ${o.l_name || o.e_title || 'property'}</b>${pill(O_STATUS[o.status], o.status === 'accepted' ? 'ok' : ['rejected', 'expired', 'withdrawn'].includes(o.status) ? 'muted' : 'warn')}</div>
    <div class="table-wrap"><table><thead><tr><th>v</th><th>By</th><th class="n">Price</th><th>Terms / conditions</th><th>Valid until</th><th>Decision</th></tr></thead><tbody>
      ${o.versions.map(v => html`<tr><td>${v.version}</td><td>${v.by_side}</td><td class="n">${fm(v.price_minor, v.currency)}</td><td class="small">${[v.payment_terms, v.conditions, v.proposed_dates].filter(Boolean).join(' · ') || '—'}</td><td class="small">${fmtDate(v.valid_until) || '—'}</td>
        <td class="small">${v.decision ? html`${v.decision} by ${v.decided_by_name || '—'} on ${fmtDate(v.decided_on)}<div class="muted">${v.decision_evidence || ''}</div>` : html`<span class="muted">Awaiting</span>`}</td></tr>`)}</tbody></table></div>
    ${canEdit && ['submitted', 'countered'].includes(o.status) && !o.last.decision ? html`<details class="inline-form"><summary class="small">Record the ${o.last.by_side === 'buyer' ? 'seller' : 'buyer'}'s decision on v${o.last.version}</summary><form method="post" action="/sales/offers/${o.id}/decision" class="form-grid">${csrfField(req)}<input type="hidden" name="version" value="${o.last.version}">
      ${field({ name: 'decision', label: 'Decision', options: [['accepted', 'Accepted'], ['rejected', 'Rejected'], ['countered', 'Counter-offer'], ['withdrawn', 'Withdrawn by the offering side'], ['expired', 'Expired']] })}
      ${field({ name: 'decided_by_name', label: 'Decided by (name)', required: true })}${field({ name: 'decided_on', label: 'Date', type: 'date', required: true, value: todayBH() })}${field({ name: 'evidence', label: 'Evidence (signed letter, email…)', required: true })}
      ${field({ name: 'counter_price', label: 'Counter price (BHD, for counter-offers)' })}${field({ name: 'counter_terms', label: 'Counter terms / conditions' })}${field({ name: 'counter_valid_until', label: 'Counter valid until', type: 'date' })}
      <div class="actions full"><button class="btn small" type="submit">Record decision</button></div><p class="muted small full">Acceptance records agreement on price and terms; it is not a completed sale.</p></form></details>` : ''}
    ${o.status === 'accepted' ? (o.deal ? html`<p class="small">Deal: <a href="/w/${o.deal.workspace_id}">open</a> (${o.deal.status.replace('_', ' ')})</p>` : canEdit ? html`<form method="post" action="/sales/offers/${o.id}/deal" class="form-grid">${csrfField(req)}${field({ name: 'interest', label: 'Interest being sold', required: true, value: 'Whole property', hint: 'Say exactly what is sold (whole property, one unit, a share).' })}<div class="actions full"><button class="btn primary small" type="submit">Open deal workspace</button></div></form>` : '') : ''}</div>`;

  r.get('/w/:id/offers', async (req, res) => {
    const a = await SL.access(req);
    if (!['listing', 'request'].includes(a.ws.kind)) throw new NotFound();
    const col = a.ws.kind === 'listing' ? 'listing_ws' : 'request_ws';
    const ids = (await pool.query(`select id from offers where ${col} = $1 order by created_at desc`, [a.ws.id])).rows;
    const offers = []; for (const x of ids) offers.push(await offerFull(x.id));
    const deals = (await pool.query(`select d.*, w.ref, w.name from deals d join workspaces w on w.id = d.workspace_id where d.${col} = $1 order by d.created_at desc`, [a.ws.id])).rows;
    const edit = core.canContribute(a);
    const M = await SL.mandateState(a.ws.id);
    let opts = [], buyers = [], views = '';
    if (a.ws.kind === 'listing') buyers = (await pool.query("select distinct p.id, p.name from opportunities o join parties p on p.id = o.party_id where o.listing_ws = $1 and o.stage = any($2::text[]) order by p.name", [a.ws.id, OPEN_STAGES])).rows.map(b => [b.id, b.name]);
    else {
      const sl = (await pool.query("select s.listing_ws, s.external_id, w.name, e.title from shortlist_items s left join workspaces w on w.id = s.listing_ws left join external_opps e on e.id = s.external_id where s.workspace_id = $1 and s.status not in ('rejected','withdrawn')", [a.ws.id])).rows;
      opts = sl.map(s => s.listing_ws ? [`l:${s.listing_ws}`, `${s.name} (SarayDar listing)`] : [`e:${s.external_id}`, `${s.title} (external)`]);
      const vv = (await pool.query("select v.*, coalesce(w.name, e.title) as l_name, coalesce(nullif(u.name,''), u.email) as agent from viewings v left join workspaces w on w.id = v.listing_ws left join external_opps e on e.id = v.external_id left join users u on u.id = v.agent_id where v.request_ws = $1 order by v.starts_at desc", [a.ws.id])).rows;
      views = html`<section class="panel"><h2 class="h">Viewings for this request</h2>${viewTable(req, vv, false)}${edit && M.canAct && opts.length ? viewForm(req, { request_ws: a.ws.id, options: opts, party_id: a.ws.party_id, back: `/w/${a.ws.id}/offers` }) : ''}</section>`;
    }
    const listing = a.ws.kind === 'listing' ? await SL.listingOf(a.ws.id) : null;
    res.send(SL.page(req, a, a.ws.kind === 'listing' ? 'Offers & Deal' : 'Viewings & Offers', html`
      ${listing ? html`<p class="small">Asking price ${fm(listing.asking_minor, listing.currency)} · status ${L_STATUS[listing.status]}${a.finance && listing.min_price_minor != null ? html` · <span class="muted">confidential minimum ${fm(listing.min_price_minor)}</span>` : ''}</p>` : ''}
      ${views}
      ${deals.length ? html`<section class="panel"><h2 class="h">Deals</h2><ul class="rows">${deals.map(d => html`<li><div class="grow"><a href="/w/${d.workspace_id}"><b>${d.ref}</b> ${d.name}</a><div class="muted small">${d.interest} · accepted ${fm(d.accepted_minor, d.currency)}${d.final_minor ? ` · final ${fm(d.final_minor, d.currency)}` : ''}${d.fell_through_reason ? ` · ${d.fell_through_reason}` : ''}</div></div>${pill(d.status.replace('_', ' '), d.status === 'completed' ? 'ok' : d.status === 'fell_through' ? 'muted' : 'warn')}</li>`)}</ul></section>` : ''}
      <section class="panel"><h2 class="h">Offers</h2>${offers.length ? offers.map(o => offerBlock(req, o, edit)) : html`<p class="muted">No offers yet.</p>`}
        ${edit && M.canAct && (a.ws.kind === 'request' ? opts.length : buyers.length) ? html`<details class="inline-form"><summary>Record an offer</summary><form method="post" action="/sales/offers" class="form-grid">${csrfField(req)}
          ${a.ws.kind === 'listing' ? html`<input type="hidden" name="listing_ws" value="${a.ws.id}">${field({ name: 'party_id', label: 'Buyer', required: true, options: [['', 'Choose…'], ...buyers] })}`
            : html`<input type="hidden" name="request_ws" value="${a.ws.id}"><input type="hidden" name="party_id" value="${a.ws.party_id}">${field({ name: 'target', label: 'Property', required: true, options: [['', 'Choose…'], ...opts] })}`}
          ${field({ name: 'price', label: 'Offered price (BHD)', required: true })}${field({ name: 'payment_terms', label: 'Payment / funding terms' })}${field({ name: 'conditions', label: 'Conditions' })}
          ${field({ name: 'proposed_dates', label: 'Proposed dates' })}${field({ name: 'valid_until', label: 'Valid until', type: 'date' })}${field({ name: 'status', label: 'Status', options: [['submitted', 'Submitted to the other side'], ['draft', 'Draft']] })}
          <div class="actions full"><button class="btn" type="submit">Record offer</button></div><p class="muted small full">Each change is kept as a new version. The seller's minimum is never shown to buyers.</p></form></details>` : ''}
      </section>`));
  });

  r.post('/sales/offers', async (req, res) => {
    await gate(req);
    const b = req.body;
    let listing = UUID.test(b.listing_ws || '') ? b.listing_ws : null, ext = null;
    const requestWs = UUID.test(b.request_ws || '') ? b.request_ws : null;
    if (b.target) { if (String(b.target).startsWith('l:')) listing = b.target.slice(2); else if (String(b.target).startsWith('e:')) ext = b.target.slice(2); }
    const caseWs = requestWs || listing;
    const a = caseWs ? await core.workspaceAccess(req.user, caseWs) : null;
    if (!a || !core.canContribute(a)) throw new NotFound();
    await SL.requireMandate(caseWs, 'An offer');
    if (listing && requestWs && !(await pool.query('select 1 from shortlist_items where workspace_id = $1 and listing_ws = $2', [requestWs, listing])).rowCount) throw bad('Shortlist the property first.');
    if (ext && !(await pool.query('select 1 from external_opps where id = $1 and workspace_id = $2', [ext, requestWs])).rowCount) throw new NotFound();
    if (!UUID.test(b.party_id || '')) throw bad('Choose the buyer.');
    const price = moneyOrNull(b.price, 'the price'); if (!price) throw bad('Enter the offered price.');
    if (listing) { const l = await SL.listingOf(listing); if (!l || !['available', 'under_offer', 'ready'].includes(l.status)) throw bad('That property is not available for offers.'); }
    const id = await core.inTx(async db => {
      const y = todayBH().slice(0, 4);
      const ref = `OFR-${y}-${String(await core.nextNumber(db, `OFR-${y}`)).padStart(4, '0')}`;
      const id = (await db.query('insert into offers (ref, listing_ws, external_id, request_ws, party_id, agent_id, status, created_by) values ($1,$2,$3,$4,$5,$6,$7,$6) returning id', [ref, listing, ext, requestWs, b.party_id, req.user.id, b.status === 'draft' ? 'draft' : 'submitted'])).rows[0].id;
      await db.query("insert into offer_versions (offer_id, version, by_side, price_minor, payment_terms, conditions, proposed_dates, valid_until, created_by) values ($1,1,'buyer',$2,$3,$4,$5,$6,$7)", [id, price, txt(b.payment_terms, 500), txt(b.conditions, 1000), txt(b.proposed_dates, 300), dateOrNull(b.valid_until), req.user.id]);
      if (listing) await db.query("update opportunities set stage = 'negotiation', updated_at = now() where party_id = $1 and listing_ws = $2 and stage = any($3::text[])", [b.party_id, listing, OPEN_STAGES]);
      if (requestWs) await db.query("update acq_requests set status = 'negotiation' where workspace_id = $1 and status in ('brief_confirmed','searching','shortlist_shared','viewings')", [requestWs]);
      for (const w of [listing, requestWs].filter(Boolean)) await core.audit(db, { actor: req.user, workspaceId: w, action: 'offer.recorded', entity: 'offer', entityId: id, summary: `Offer ${ref}: ${formatMoney(price)} (v1, buyer)`, ip: req.ip });
      return id;
    });
    res.redirect(`/w/${caseWs}/offers?msg=added#${id}`);
  });

  async function offerCaseAccess(req, o) {
    for (const w of [o.listing_ws, o.request_ws].filter(Boolean)) { const a = await core.workspaceAccess(req.user, w); if (a && core.canContribute(a)) return a; }
    throw new NotFound();
  }
  r.post('/sales/offers/:oid/decision', async (req, res) => {
    await gate(req);
    if (!UUID.test(req.params.oid)) throw new NotFound();
    const o = await offerFull(req.params.oid); if (!o) throw new NotFound();
    const a = await offerCaseAccess(req, o);
    const d = ['accepted', 'rejected', 'countered', 'withdrawn', 'expired'].includes(req.body.decision) ? req.body.decision : null; if (!d) throw bad('Choose the decision.');
    const who = txt(req.body.decided_by_name, 160), on = dateOrNull(req.body.decided_on), ev = txt(req.body.evidence, 500);
    if (!who || !on || !ev) throw bad('Record who decided, when, and the evidence.');
    if (Number(req.body.version) !== o.last.version) throw bad('The offer has changed; reload and decide on the latest version.');
    await core.inTx(async db => {
      const cur = (await db.query('select status from offers where id = $1 for update', [o.id])).rows[0];
      if (!['submitted', 'countered'].includes(cur.status)) throw bad('This offer is closed.');
      const n = (await db.query('update offer_versions set decision = $3, decided_by_name = $4, decided_on = $5, decision_evidence = $6, decision_recorded_by = $7 where offer_id = $1 and version = $2 and decision is null', [o.id, o.last.version, d, who, on, ev, req.user.id])).rowCount;
      if (!n) throw bad('A decision is already recorded on this version.');
      if (d === 'countered') {
        const price = moneyOrNull(req.body.counter_price, 'the counter price'); if (!price) throw bad('Enter the counter price.');
        await db.query('insert into offer_versions (offer_id, version, by_side, price_minor, conditions, valid_until, created_by) values ($1,$2,$3,$4,$5,$6,$7)', [o.id, o.last.version + 1, o.last.by_side === 'buyer' ? 'seller' : 'buyer', price, txt(req.body.counter_terms, 1000), dateOrNull(req.body.counter_valid_until), req.user.id]);
        await db.query("update offers set status = 'countered' where id = $1", [o.id]);
      } else await db.query('update offers set status = $2 where id = $1', [o.id, d]);
      if (d === 'accepted' && o.listing_ws) {
        const l = (await db.query('select status from listings where workspace_id = $1 for update', [o.listing_ws])).rows[0];
        if (l && l.status === 'available') await SL.setListingStatus(db, o.listing_ws, 'under_offer', `Offer ${o.ref} accepted by ${who}`, ev, req.user.id);
      }
      for (const w of [o.listing_ws, o.request_ws].filter(Boolean)) await core.audit(db, { actor: req.user, workspaceId: w, action: `offer.${d}`, entity: 'offer', entityId: o.id, summary: `Offer ${o.ref} v${o.last.version} ${d} by ${who} on ${on} (${ev})${d === 'countered' ? ` — counter ${formatMoney(moneyOrNull(req.body.counter_price, 'x'))}` : ''}`, ip: req.ip });
    });
    res.redirect(`/w/${a.ws.id}/offers?msg=saved`);
  });

  r.post('/sales/offers/:oid/deal', async (req, res) => {
    await gate(req);
    if (!UUID.test(req.params.oid)) throw new NotFound();
    const o = await offerFull(req.params.oid); if (!o) throw new NotFound();
    const a = await offerCaseAccess(req, o);
    if (o.status !== 'accepted') throw bad('Only an accepted offer opens a deal.');
    const interest = txt(req.body.interest, 300); if (!interest) throw bad('Say exactly what is being sold.');
    const accepted = o.versions.filter(v => v.decision === 'accepted').pop();
    let dealId;
    try {
      dealId = await core.inTx(async db => {
        const y = todayBH().slice(0, 4);
        const ref = `DL-${y}-${String(await core.nextNumber(db, `DL-${y}`)).padStart(3, '0')}`;
        const w = (await db.query("insert into workspaces (section, kind, ref, name, location, party_id, manager_id, created_by) values ('sales','deal',$1,$2,(select location from workspaces where id = $3),$4,$5,$5) returning id",
          [ref, `${o.l_name || o.e_title} — ${o.buyer}`, o.listing_ws || o.request_ws, o.party_id, req.user.id])).rows[0].id;
        // the people working on the listing and the request work on the deal
        await db.query("insert into workspace_members (workspace_id, user_id, role, added_by) select $1, user_id, role, $2 from workspace_members where workspace_id = any($3::uuid[]) and revoked_at is null and role in ('manager','editor','contributor','viewer') on conflict do nothing", [w, req.user.id, [o.listing_ws, o.request_ws].filter(Boolean)]);
        await db.query("insert into workspace_members (workspace_id, user_id, role, added_by) values ($1,$2,'manager',$2) on conflict do nothing", [w, req.user.id]);
        await db.query('insert into deals (workspace_id, listing_ws, external_id, request_ws, offer_id, buyer_id, seller_id, interest, accepted_minor, currency) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          [w, o.listing_ws, o.external_id, o.request_ws, o.id, o.party_id, o.seller_id, interest, accepted.price_minor, accepted.currency]);
        let s = 0; for (const t of ctx.defaultChecklist) await db.query('insert into deal_checklist (workspace_id, title, sort) values ($1,$2,$3)', [w, t, s++]);
        if (o.listing_ws) await db.query("update opportunities set stage = 'in_progress', updated_at = now() where party_id = $1 and listing_ws = $2", [o.party_id, o.listing_ws]);
        if (o.request_ws) await db.query("update acq_requests set status = 'transaction' where workspace_id = $1", [o.request_ws]);
        for (const x of [w, o.listing_ws, o.request_ws].filter(Boolean)) await core.audit(db, { actor: req.user, workspaceId: x, action: 'deal.opened', entity: 'deal', entityId: w, summary: `Deal ${ref} opened from offer ${o.ref} at ${formatMoney(Number(accepted.price_minor))}: ${interest}`, ip: req.ip });
        return w;
      });
    } catch (e) { if (e.code === '23505') throw bad('This property already has a deal in progress or completed. A fallen-through deal must be recorded first.'); throw e; }
    res.redirect(`/w/${dealId}?msg=created`);
  });

  // ---------- deal overview, reservation, completion, fall-through, commissions ----------
  async function dealOf(wsId) {
    const d = (await pool.query(`select d.*, b.name as buyer, s.name as seller, o.ref as offer_ref, lw.name as l_name, lw.ref as l_ref, rw.name as r_name, rw.ref as r_ref, e.title as e_title, l.asking_minor
      from deals d left join parties b on b.id = d.buyer_id left join parties s on s.id = d.seller_id left join offers o on o.id = d.offer_id left join workspaces lw on lw.id = d.listing_ws left join workspaces rw on rw.id = d.request_ws left join external_opps e on e.id = d.external_id left join listings l on l.workspace_id = d.listing_ws where d.workspace_id = $1`, [wsId])).rows[0];
    return d;
  }
  async function commissionFor(m, d) {
    if (!m || m.fee_type === 'none') return null;
    if (m.fee_type === 'fixed') return { amount: Number(m.fee_fixed_minor), note: `Fixed fee ${formatMoney(Number(m.fee_fixed_minor))} under mandate v${m.version}` };
    const base = m.fee_base === 'final_price' ? d.final_minor : d.accepted_minor;
    if (base == null) return { amount: null, note: 'Waiting for the final transaction price' };
    const amount = fees.mulDiv(Number(base), m.fee_bp, 10000);
    return { amount, note: `${(m.fee_bp / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}% × ${m.fee_base === 'final_price' ? 'final transaction price' : 'accepted price'} ${formatMoney(Number(base))} = ${formatMoney(amount)} (rounded half up to 3 decimals) — mandate v${m.version}` };
  }

  ctx.overviewExtras = ctx.overviewExtras || {};
  ctx.overviewExtras.sales = async (req, wsAccess) => {
    const a = await core.workspaceAccess(req.user, wsAccess.ws.id);
    if (!a || !a.internal) return '';
    a.finance = core.isSuper(req.user) || a.role === 'manager' || a.role === 'editor' || await core.can(req.user, 'view:financials');
    a.canPost = core.isSuper(req.user) || await core.can(req.user, 'finance:post');
    const id = a.ws.id, edit = core.canEdit(a);
    if (a.ws.kind === 'deal') {
      const d = await dealOf(id);
      const cl = (await pool.query("select count(*) filter (where status = 'open')::int as open, count(*)::int as n from deal_checklist where workspace_id = $1", [id])).rows[0];
      const sides = [];
      for (const [w, label] of [[d.listing_ws, 'Seller side (listing mandate)'], [d.request_ws, 'Buyer side (acquisition mandate)']]) {
        if (!w) continue;
        const m = (await SL.mandateState(w)).cur;
        const inv = (await pool.query("select id, number, status, total_minor from fee_invoices where deal_ws = $1 and workspace_id = $2 and kind = 'commission' and status <> 'void'", [id, w])).rows[0];
        sides.push({ w, label, m, c: await commissionFor(m, d), inv });
      }
      return html`<section class="grid-cards">
          <div class="card"><div class="muted small">Stage</div><div class="mid">${pill(d.status.replace('_', ' '), d.status === 'completed' ? 'ok' : d.status === 'fell_through' ? 'muted' : 'warn')}</div><div class="muted small">${cl.n - cl.open} of ${cl.n} checklist items closed · <a href="/w/${id}/checklist">Checklist</a></div></div>
          <div class="card"><div class="muted small">Prices (kept separately)</div><div class="small">Asking ${fm(d.asking_minor, d.currency)}<br>Accepted offer ${fm(d.accepted_minor, d.currency)} (${d.offer_ref})<br>Final transaction ${d.final_minor == null ? '—' : fm(d.final_minor, d.currency)}</div></div>
          <div class="card"><div class="muted small">Parties</div><div class="small">Seller: ${d.seller || '—'}<br>Buyer: ${d.buyer || '—'}<br>Interest: <b>${d.interest}</b></div></div>
          <div class="card"><div class="muted small">Linked</div><div class="small">${d.listing_ws ? html`<a href="/w/${d.listing_ws}">${d.l_ref} ${d.l_name}</a><br>` : ''}${d.request_ws ? html`<a href="/w/${d.request_ws}">${d.r_ref} ${d.r_name}</a><br>` : ''}${d.e_title ? `External: ${d.e_title}` : ''}</div></div></section>
        ${d.status === 'in_progress' && edit ? html`<div class="split">
          <form method="post" action="/w/${id}/deal/reserve" class="panel grow1 form-grid">${csrfField(req)}<h3 class="h3 full">Reservation ${d.reserved_until ? `(until ${fmtDate(d.reserved_until)})` : ''}</h3>
            ${field({ name: 'reserved_until', label: 'Reserved until', type: 'date', required: true, value: d.reserved_until ? String(d.reserved_until) : '' })}${field({ name: 'reservation_ref', label: 'Authorisation (signed reservation, seller approval)', required: true, value: d.reservation_ref || '' })}
            ${field({ name: 'deposit_holder', label: 'Who holds any reservation deposit', value: d.deposit_holder || '', hint: 'SarayDar does not hold client money unless separately authorised.' })}<div class="actions full"><button class="btn" type="submit">Record reservation</button></div></form>
          <form method="post" action="/w/${id}/deal/complete" class="panel grow1 form-grid">${csrfField(req)}<h3 class="h3 full">Completion</h3>
            ${field({ name: 'final_price', label: 'Final transaction price (BHD)', required: true })}${field({ name: 'completed_on', label: 'Completed on', type: 'date', required: true, value: todayBH() })}
            ${field({ name: 'evidence', label: 'Completion evidence (transfer record, signed deed reference)', required: true, full: true })}
            <div class="actions full"><button class="btn primary" type="submit">Confirm completed sale</button></div><p class="muted small full">Needs every checklist item done or marked not applicable. The system records completion; it does not transfer title.</p></form>
          <form method="post" action="/w/${id}/deal/fall" class="panel grow1 form-grid">${csrfField(req)}<h3 class="h3 full">Fell through</h3>
            ${field({ name: 'reason', label: 'Reason', required: true })}${field({ name: 'release_notes', label: 'Release / refund obligations (as documented)' })}
            <div class="actions full"><button class="btn" type="submit">Record fall-through</button></div><p class="muted small full">The deal history is kept; the listing becomes available again if its mandate is active.</p></form></div>` : ''}
        ${d.status === 'completed' ? html`<p>Completed ${fmtDate(d.completed_on)} · ${d.completion_evidence}</p>` : d.status === 'fell_through' ? html`<p class="muted">Fell through ${fmtDate(d.fell_through_on)}: ${d.fell_through_reason}${d.release_notes ? ` · ${d.release_notes}` : ''}</p>` : ''}
        ${a.finance ? html`<section class="panel"><h2 class="h">SarayDar fees on this deal</h2><p class="muted small">Each side's fee comes only from its own mandate. The deal value is not SarayDar revenue.</p>
          <div class="table-wrap"><table><thead><tr><th>Side</th><th>Mandate fee</th><th>Calculation</th><th>Invoice</th><th></th></tr></thead><tbody>
          ${sides.map(s => html`<tr><td>${s.label}</td><td class="small">${s.m ? (s.m.fee_type === 'none' ? 'No fee' : s.m.fee_type === 'fixed' ? `Fixed ${fm(s.m.fee_fixed_minor)}` : `${s.m.fee_bp / 100}% of ${s.m.fee_base.replace('_', ' ')}`) : html`<span class="warn-text">No mandate</span>`}${s.m ? html`<div class="muted">earned on ${s.m.fee_trigger}</div>` : ''}</td>
            <td class="small">${s.c ? s.c.note : '—'}</td><td>${s.inv ? html`<a href="/w/${s.w}/fees/invoices/${s.inv.id}">${s.inv.number || 'Draft'}</a> ${fm(s.inv.total_minor)}` : '—'}</td>
            <td>${!s.inv && s.c && s.c.amount && core.canEdit(a) && (s.m.fee_trigger !== 'completion' || d.status === 'completed') && d.status !== 'fell_through' ? html`<form method="post" action="/w/${id}/deal/commission" class="actions">${csrfField(req)}<input type="hidden" name="side_ws" value="${s.w}"><button class="btn small" type="submit">Prepare invoice draft</button></form>` : !s.inv && s.m && s.m.fee_trigger === 'completion' && d.status !== 'completed' ? html`<span class="muted small">Earned on completion</span>` : ''}</td></tr>`)}
          ${!sides.length ? html`<tr><td colspan="5" class="muted">No mandate linked.</td></tr>` : ''}</tbody></table></div></section>` : ''}`;
    }
    const M = await SL.mandateState(id);
    if (a.ws.kind === 'listing') {
      const l = await SL.listingOf(id) || { status: 'draft' };
      const o = (await pool.query("select count(*)::int as n, count(distinct party_id)::int as u, count(*) filter (where stage = any($2::text[]))::int as open from opportunities where listing_ws = $1", [id, OPEN_STAGES])).rows[0];
      const v = (await pool.query("select count(*) filter (where status = 'completed')::int as done, count(*) filter (where status in ('tentative','confirmed') and starts_at > now())::int as next from viewings where listing_ws = $1", [id])).rows[0];
      const off = (await pool.query("select count(*)::int as n from offers where listing_ws = $1 and status in ('submitted','countered')", [id])).rows[0].n;
      const dom = l.available_since ? Math.round((Date.parse(todayBH()) - Date.parse(String(l.available_since))) / 864e5) : null;
      return html`${!M.canAct ? html`<div class="notice warn">Mandate: ${M.eff === 'none' ? 'not recorded' : M.eff}${M.cur && !M.cur.authority_verified_at ? ' — authority not verified' : ''}. <a href="/w/${id}/mandate">Open mandate</a></div>` : ''}
        <section class="grid-cards"><div class="card"><div class="muted small">Listing status</div><div class="mid">${pill(L_STATUS[l.status], 'info')}</div><div class="muted small">${dom === null ? 'Not yet on the market' : `${dom} day(s) on the market`}</div></div>
          <div class="card"><div class="muted small">Asking price</div><div class="mid">${fm(l.asking_minor, l.currency)}</div><div class="muted small"><a href="/w/${id}/listing">Property file</a></div></div>
          <div class="card"><div class="muted small">Enquiries</div><div class="big">${o.n}</div><div class="muted small">${o.u} unique buyer(s) · ${o.open} open</div></div>
          <div class="card"><div class="muted small">Viewings / open offers</div><div class="mid">${v.done} done · ${v.next} upcoming · ${off} offer(s)</div></div></section>`;
    }
    const rq = await SL.reqOf(id); const b = await SL.briefOf(id);
    const s = (await pool.query("select count(*)::int as n, count(*) filter (where published)::int as pub from shortlist_items where workspace_id = $1", [id])).rows[0];
    return html`${!M.canAct ? html`<div class="notice warn">Mandate: ${M.eff === 'none' ? 'not recorded' : M.eff}. <a href="/w/${id}/mandate">Open mandate</a></div>` : ''}
      <section class="grid-cards"><div class="card"><div class="muted small">Request status</div><div class="mid">${pill(R_STATUS[rq.status], 'info')}</div></div>
        <div class="card"><div class="muted small">Brief</div><div class="small">${b ? html`${b.types || 'Any type'} · ${b.locations || 'any location'}<br>${b.budget_max_minor != null ? `up to ${fm(b.budget_max_minor, b.currency)}` : 'budget not stated'}` : html`<a href="/w/${id}/brief">Record the brief</a>`}</div></div>
        <div class="card"><div class="muted small">Shortlist</div><div class="big">${s.n}</div><div class="muted small">${s.pub} published to the client</div></div></section>`;
  };

  const dealAct = (path, fn) => r.post(`/w/:id/deal/${path}`, async (req, res) => {
    const a = await SL.access(req, 'edit');
    if (a.ws.kind !== 'deal') throw new NotFound();
    await core.inTx(async db => { const d = (await db.query('select * from deals where workspace_id = $1 for update', [a.ws.id])).rows[0]; await fn(db, a, d, req); await SL.touch(db, a.ws.id); });
    res.redirect(req._to || `/w/${a.ws.id}?msg=saved`);
  });
  dealAct('reserve', async (db, a, d, req) => {
    if (d.status !== 'in_progress') throw bad('The deal is closed.');
    const until = dateOrNull(req.body.reserved_until), ref = txt(req.body.reservation_ref, 300);
    if (!until || !ref) throw bad('Enter the reservation end date and its authorisation.');
    await db.query('update deals set reserved_until = $2, reservation_ref = $3, deposit_holder = $4 where workspace_id = $1', [a.ws.id, until, ref, txt(req.body.deposit_holder, 200)]);
    if (d.listing_ws) { const l = (await db.query('select status from listings where workspace_id = $1', [d.listing_ws])).rows[0]; if (l && ['available', 'under_offer'].includes(l.status)) await SL.setListingStatus(db, d.listing_ws, 'reserved', `Reserved until ${until}`, ref, req.user.id); }
    await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'deal.reserved', entity: 'deal', entityId: a.ws.id, summary: `Reserved until ${until}: ${ref}`, ip: req.ip });
  });
  dealAct('complete', async (db, a, d, req) => {
    if (d.status !== 'in_progress') throw bad('The deal is not in progress.');
    const price = moneyOrNull(req.body.final_price, 'the final price'), on = dateOrNull(req.body.completed_on), ev = txt(req.body.evidence, 500);
    if (!price || !on || !ev) throw bad('Enter the final price, the date and the completion evidence.');
    const open = (await db.query("select title from deal_checklist where workspace_id = $1 and status = 'open'", [a.ws.id])).rows;
    if (open.length) throw bad(`Close the checklist first: ${open.map(x => x.title).slice(0, 3).join('; ')}${open.length > 3 ? '…' : ''}`);
    await db.query("update deals set status = 'completed', final_minor = $2, completed_on = $3, completion_evidence = $4, completed_by = $5 where workspace_id = $1", [a.ws.id, price, on, ev, req.user.id]);
    await db.query("update workspaces set status = 'completed' where id = $1", [a.ws.id]);
    if (d.listing_ws) {
      await SL.setListingStatus(db, d.listing_ws, 'sold', `Deal ${a.ws.ref} completed ${on}`, ev, req.user.id);
      await db.query("update opportunities set stage = 'won', updated_at = now() where listing_ws = $1 and party_id = $2", [d.listing_ws, d.buyer_id]);
      await db.query("update opportunities set stage = 'lost', lost_reason = 'Sold to another buyer', updated_at = now() where listing_ws = $1 and party_id <> $2 and stage = any($3::text[])", [d.listing_ws, d.buyer_id, OPEN_STAGES]);
      await db.query("update sale_mandates set status = 'completed', status_reason = $2 where workspace_id = $1 and status = 'active'", [d.listing_ws, `Sale completed ${on}`]);
    }
    if (d.request_ws) { await db.query("update acq_requests set status = 'completed' where workspace_id = $1", [d.request_ws]); await db.query("update sale_mandates set status = 'completed', status_reason = $2 where workspace_id = $1 and status = 'active'", [d.request_ws, `Purchase completed ${on}`]); }
    for (const w of [a.ws.id, d.listing_ws, d.request_ws].filter(Boolean)) await core.audit(db, { actor: req.user, workspaceId: w, action: 'deal.completed', entity: 'deal', entityId: a.ws.id, summary: `Sale completed ${on} at ${formatMoney(price)}: ${ev}`, ip: req.ip });
  });
  dealAct('fall', async (db, a, d, req) => {
    if (d.status !== 'in_progress') throw bad('The deal is not in progress.');
    const reason = txt(req.body.reason, 500); if (!reason) throw bad('Give the reason.');
    await db.query("update deals set status = 'fell_through', fell_through_on = $2, fell_through_reason = $3, release_notes = $4 where workspace_id = $1", [a.ws.id, todayBH(), reason, txt(req.body.release_notes, 500)]);
    await db.query("update workspaces set status = 'completed' where id = $1", [a.ws.id]);
    if (d.offer_id) await db.query("update offers set status = 'withdrawn' where id = $1", [d.offer_id]);
    if (d.listing_ws) {
      const m = await SL.mandateState(d.listing_ws, db);
      await SL.setListingStatus(db, d.listing_ws, m.canAct ? 'available' : 'ready', `Deal ${a.ws.ref} fell through: ${reason}`, null, req.user.id);
      await db.query("update opportunities set stage = 'lost', lost_reason = $3, updated_at = now() where listing_ws = $1 and party_id = $2", [d.listing_ws, d.buyer_id, `Deal fell through: ${reason}`]);
    }
    if (d.request_ws) await db.query("update acq_requests set status = 'searching' where workspace_id = $1", [d.request_ws]);
    for (const w of [a.ws.id, d.listing_ws, d.request_ws].filter(Boolean)) await core.audit(db, { actor: req.user, workspaceId: w, action: 'deal.fell_through', entity: 'deal', entityId: a.ws.id, summary: `Deal fell through: ${reason}`, ip: req.ip });
  });
  dealAct('commission', async (db, a, d, req) => {
    if (!a.finance) throw new NotFound();
    const side = [d.listing_ws, d.request_ws].find(w => w && w === req.body.side_ws); if (!side) throw bad('Choose the side.');
    const sa = await core.workspaceAccess(req.user, side); if (!sa || !core.canEdit(sa)) throw new Forbidden('You need edit access to that case.');
    const M = (await SL.mandateState(side, db)).cur || (await db.query("select * from sale_mandates where workspace_id = $1 and status = 'completed' order by version desc limit 1", [side])).rows[0];
    if (!M) throw bad('That case has no mandate.');
    if (M.fee_trigger === 'completion' && d.status !== 'completed') throw bad('This fee is earned on completion.');
    if (d.status === 'fell_through') throw bad('The deal fell through.');
    const c = await commissionFor(M, d); if (!c || !c.amount) throw bad('No fee can be calculated from the mandate.');
    const w = (await db.query('select party_id from workspaces where id = $1', [side])).rows[0];
    const tax = M.tax_mode === 'rate' ? fees.mulDiv(c.amount, M.tax_rate_bp || 0, 10000) : 0;
    try {
      const id = (await db.query(`insert into fee_invoices (workspace_id, party_id, kind, currency, subtotal_minor, tax_minor, total_minor, tax_mode, tax_rate_bp, tax_label, deal_ws, mandate_id, calc_note, notes, created_by)
        values ($1,$2,'commission',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id`, [side, w.party_id, d.currency, c.amount, tax, c.amount + tax, M.tax_mode, M.tax_rate_bp, M.tax_label, a.ws.id, M.id, c.note, `Deal ${a.ws.ref}`, req.user.id])).rows[0].id;
      await db.query("insert into fee_invoice_lines (invoice_id, kind, description, amount_minor) values ($1,'fee',$2,$3)", [id, `Brokerage fee — ${d.interest} (deal ${a.ws.ref}). ${c.note}`, c.amount]);
      await core.audit(db, { actor: req.user, workspaceId: side, action: 'fee.commission_draft', entity: 'fee_invoice', entityId: id, summary: `Commission invoice draft for deal ${a.ws.ref}: ${formatMoney(c.amount)} (${c.note})`, ip: req.ip });
      req._to = `/w/${side}/fees/invoices/${id}?msg=created`;
    } catch (e) { if (e.code === '23505') throw bad('A commission invoice for this deal and side already exists.'); throw e; }
  });

  // ---------- sales expenses ----------
  r.get('/w/:id/sales-expenses', async (req, res) => {
    const a = await SL.access(req, 'finance');
    const rows = (await pool.query('select * from sales_expenses where workspace_id = $1 order by cost_date desc', [a.ws.id])).rows;
    const M = (await SL.mandateState(a.ws.id)).cur;
    const PAYER = { saraydar: 'SarayDar cost', client_reimbursable: 'Client-reimbursable', client_direct: 'Paid by the client directly' };
    const total = k => rows.filter(e => e.status !== 'rejected' && (!k || e.payer === k)).reduce((s, e) => s + Number(e.amount_minor), 0);
    res.send(SL.page(req, a, 'Expenses', html`
      <section class="grid-cards"><div class="card"><div class="muted small">Approved budget (mandate)</div><div class="mid">${fm(M && M.marketing_budget_minor)}</div></div><div class="card"><div class="muted small">SarayDar costs</div><div class="mid">${fm(total('saraydar'))}</div></div>
        <div class="card"><div class="muted small">Client-reimbursable</div><div class="mid">${fm(total('client_reimbursable'))}</div></div><div class="card"><div class="muted small">Paid by client directly</div><div class="mid">${fm(total('client_direct'))}</div></div></section>
      <section class="panel"><h2 class="h">Marketing and transaction expenses</h2>
        ${rows.length ? html`<div class="table-wrap"><table><thead><tr><th>Date</th><th>Supplier / description</th><th>Category</th><th>Payer</th><th class="n">Amount</th><th>Approval</th><th>Payment</th><th></th></tr></thead><tbody>
          ${rows.map(e => html`<tr><td class="small">${fmtDate(e.cost_date)}</td><td>${e.supplier}${e.invoice_no ? ` · ${e.invoice_no}` : ''}<div class="muted small">${e.description}</div></td><td class="small">${e.category}</td><td class="small">${PAYER[e.payer]}</td><td class="n">${fm(e.amount_minor)}</td>
            <td>${pill(e.status, e.status === 'approved' ? 'ok' : e.status === 'rejected' ? 'muted' : 'warn')}</td><td>${e.pay_status === 'paid' ? fmtDate(e.paid_on) : 'unpaid'}</td>
            <td>${core.canEdit(a) && e.status === 'submitted' ? html`<form method="post" action="/w/${a.ws.id}/sales-expenses/${e.id}" class="actions">${csrfField(req)}<button class="btn small" name="do" value="approved">Approve</button><button class="btn small" name="do" value="rejected">Reject</button></form>` : ''}
              ${a.canPost && e.status === 'approved' && e.pay_status !== 'paid' && e.payer !== 'client_direct' ? html`<form method="post" action="/w/${a.ws.id}/sales-expenses/${e.id}" class="actions">${csrfField(req)}<input type="date" name="paid_on" value="${todayBH()}" aria-label="Paid on" required><button class="btn small" name="do" value="paid">Paid</button></form>` : ''}</td></tr>`)}</tbody></table></div>` : html`<p class="muted">None recorded.</p>`}
        ${core.canEdit(a) ? html`<details class="inline-form"><summary>Record an expense</summary><form method="post" action="/w/${a.ws.id}/sales-expenses" class="form-grid">${csrfField(req)}
          ${field({ name: 'category', label: 'Category', required: true, list: CH.SALES_EXPENSE_CATEGORIES })}${field({ name: 'description', label: 'Description', required: true })}${field({ name: 'supplier', label: 'Supplier', required: true })}
          ${field({ name: 'invoice_no', label: 'Invoice number' })}${field({ name: 'cost_date', label: 'Date', type: 'date', required: true, value: todayBH() })}${field({ name: 'amount', label: 'Amount (BHD)', required: true })}
          ${field({ name: 'payer', label: 'Payer', options: Object.entries(PAYER) })}<div class="actions full"><button class="btn" type="submit">Record</button></div></form></details>` : ''}
      </section>`));
  });
  r.post('/w/:id/sales-expenses', async (req, res) => {
    const a = await SL.access(req, 'edit'); if (!a.finance) throw new NotFound();
    const b = req.body; const v = [txt(b.category, 80), txt(b.description, 300), txt(b.supplier, 160)];
    if (v.some(x => !x)) throw bad('Enter the category, description and supplier.');
    const on = dateOrNull(b.cost_date), amt = moneyOrNull(b.amount, 'the amount'); if (!on || !amt) throw bad('Enter the date and amount.');
    await core.inTx(async db => {
      const id = (await db.query('insert into sales_expenses (workspace_id, category, description, supplier, invoice_no, cost_date, amount_minor, payer, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id',
        [a.ws.id, ...v, txt(b.invoice_no, 60), on, amt, ['saraydar', 'client_reimbursable', 'client_direct'].includes(b.payer) ? b.payer : 'saraydar', req.user.id])).rows[0].id;
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'sales_expense.recorded', entity: 'sales_expense', entityId: id, summary: `Expense: ${v[2]} ${formatMoney(amt)}`, ip: req.ip });
    });
    res.redirect(`/w/${a.ws.id}/sales-expenses?msg=added`);
  });
  r.post('/w/:id/sales-expenses/:eid', async (req, res) => {
    const a = await SL.access(req); if (!a.finance) throw new NotFound();
    const e = await SL.own('sales_expenses', req.params.eid, a.ws.id);
    const d = req.body.do;
    await core.inTx(async db => {
      if (['approved', 'rejected'].includes(d)) { if (!core.canEdit(a)) throw new Forbidden('Not allowed.'); if (e.status !== 'submitted') throw bad('Already decided.'); await db.query('update sales_expenses set status = $2, approved_by = $3 where id = $1', [e.id, d, req.user.id]); }
      else if (d === 'paid') { if (!a.canPost) throw new Forbidden('Only Finance confirms payments.'); if (e.status !== 'approved') throw bad('Approve it first.'); const on = dateOrNull(req.body.paid_on); if (!on) throw bad('Enter the date.'); await db.query("update sales_expenses set pay_status = 'paid', paid_on = $2 where id = $1", [e.id, on]); }
      else throw bad('Unknown action.');
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: `sales_expense.${d}`, entity: 'sales_expense', entityId: e.id, summary: `Expense ${e.supplier} ${formatMoney(Number(e.amount_minor))}: ${d}`, ip: req.ip });
    });
    res.redirect(`/w/${a.ws.id}/sales-expenses?msg=saved`);
  });

  // ---------- Offers & Deals (section) ----------
  r.get('/sales/deals', async (req, res) => {
    await gate(req);
    const vis = await visibleCases(req.user);
    const offers = (await pool.query(`select o.*, p.name as buyer, coalesce(w.name, e.title) as prop, (select price_minor from offer_versions v where v.offer_id = o.id order by version desc limit 1) as price, (select by_side from offer_versions v where v.offer_id = o.id order by version desc limit 1) as by_side
      from offers o join parties p on p.id = o.party_id left join workspaces w on w.id = o.listing_ws left join external_opps e on e.id = o.external_id where o.status in ('submitted','countered','accepted','draft') order by o.created_at desc`)).rows.filter(o => vis.has(o.listing_ws) || vis.has(o.request_ws));
    const deals = (await pool.query(`select d.*, w.ref, w.name, (select count(*) from deal_checklist c where c.workspace_id = d.workspace_id and c.status = 'open')::int as open_items from deals d join workspaces w on w.id = d.workspace_id order by (d.status = 'in_progress') desc, d.created_at desc`)).rows.filter(d => vis.has(d.workspace_id));
    res.send(shell(req, 'Offers & Deals', html`
      <section class="panel"><h2 class="h">Open offers</h2>${offers.length ? html`<div class="table-wrap"><table><thead><tr><th>Offer</th><th>Property</th><th>Buyer</th><th class="n">Latest price</th><th>Latest by</th><th>Status</th></tr></thead><tbody>
        ${offers.map(o => html`<tr><td><a href="/w/${o.listing_ws && vis.has(o.listing_ws) ? o.listing_ws : o.request_ws}/offers">${o.ref}</a></td><td>${o.prop}</td><td>${o.buyer}</td><td class="n">${fm(o.price)}</td><td>${o.by_side}</td><td>${pill(O_STATUS[o.status], o.status === 'accepted' ? 'ok' : 'warn')}</td></tr>`)}</tbody></table></div>` : html`<p class="muted">No open offers.</p>`}</section>
      <section class="panel"><h2 class="h">Deals</h2>${deals.length ? html`<div class="table-wrap"><table><thead><tr><th>Deal</th><th>Interest</th><th class="n">Accepted</th><th class="n">Final</th><th>Checklist</th><th>Stage</th></tr></thead><tbody>
        ${deals.map(d => html`<tr><td><a href="/w/${d.workspace_id}"><b>${d.ref}</b></a><div class="muted small">${d.name}</div></td><td class="small">${d.interest}</td><td class="n">${fm(d.accepted_minor, d.currency)}</td><td class="n">${d.final_minor == null ? '—' : fm(d.final_minor, d.currency)}</td>
          <td class="small">${d.status === 'in_progress' ? `${d.open_items} open item(s)` : '—'}</td><td>${pill(d.status.replace('_', ' '), d.status === 'completed' ? 'ok' : d.status === 'fell_through' ? 'muted' : 'warn')}</td></tr>`)}</tbody></table></div>` : html`<p class="muted">No deals yet.</p>`}</section>`));
  });

  // ---------- Fees & Reports (section) ----------
  r.get('/sales/reports', async (req, res) => {
    const g = await gate(req);
    const t = todayBH();
    const from = dateOrNull(req.query.from) || `${t.slice(0, 4)}-01-01`, to = dateOrNull(req.query.to) || t;
    if (to < from) throw bad('The end date is before the start date.');
    const vis = await visibleCases(req.user);
    const ids = [...vis];
    const listings = (await pool.query("select w.id, w.ref, w.name, w.created_at, l.* from workspaces w join listings l on l.workspace_id = w.id where w.id = any($1::uuid[])", [ids])).rows;
    const statusCount = {}; for (const l of listings) statusCount[l.status] = (statusCount[l.status] || 0) + 1;
    const sold = (await pool.query("select d.*, w.ref from deals d join workspaces w on w.id = d.workspace_id where d.workspace_id = any($1::uuid[]) and d.status = 'completed' and d.completed_on between $2 and $3", [ids, from, to])).rows;
    const fell = (await pool.query("select d.*, w.ref from deals d join workspaces w on w.id = d.workspace_id where d.workspace_id = any($1::uuid[]) and d.status = 'fell_through' and d.fell_through_on between $2 and $3", [ids, from, to])).rows;
    const inprog = (await pool.query("select d.*, w.ref from deals d join workspaces w on w.id = d.workspace_id where d.workspace_id = any($1::uuid[]) and d.status = 'in_progress'", [ids])).rows;
    const domRows = listings.filter(l => l.available_since).map(l => { const d = sold.find(s => s.listing_ws === l.workspace_id); const end = d ? String(d.completed_on) : ['withdrawn', 'archived'].includes(l.status) ? null : t; return end ? { ref: l.ref, days: Math.round((Date.parse(end) - Date.parse(String(l.available_since))) / 864e5), sold: !!d } : null; }).filter(Boolean);
    const enq = (await pool.query("select coalesce(source, 'Not recorded') as source, count(*)::int as n, count(distinct party_id)::int as u from opportunities where (listing_ws = any($1::uuid[]) or request_ws = any($1::uuid[])) and created_at::date between $2 and $3 group by 1 order by 2 desc", [ids, from, to])).rows;
    const enqTotal = (await pool.query("select count(*)::int as n, count(distinct party_id)::int as u from opportunities where (listing_ws = any($1::uuid[]) or request_ws = any($1::uuid[])) and created_at::date between $2 and $3", [ids, from, to])).rows[0];
    const vw = (await pool.query("select status, count(*)::int as n from viewings where (listing_ws = any($1::uuid[]) or request_ws = any($1::uuid[])) and (starts_at at time zone 'Asia/Bahrain')::date between $2 and $3 group by 1", [ids, from, to])).rows;
    const of = (await pool.query("select status, count(*)::int as n from offers where (listing_ws = any($1::uuid[]) or request_ws = any($1::uuid[])) and created_at::date between $2 and $3 group by 1", [ids, from, to])).rows;
    const lost = (await pool.query("select coalesce(lost_reason, 'Not recorded') as reason, count(*)::int as n from opportunities where (listing_ws = any($1::uuid[]) or request_ws = any($1::uuid[])) and stage = 'lost' and updated_at::date between $2 and $3 group by 1 order by 2 desc", [ids, from, to])).rows;
    const mandExp = (await pool.query("select w.id, w.ref, w.name, m.end_date from sale_mandates m join workspaces w on w.id = m.workspace_id where m.workspace_id = any($1::uuid[]) and m.status = 'active' and m.end_date is not null and m.end_date <= $2::date + 30 order by m.end_date", [ids, t])).rows;
    const mk = (await pool.query("select count(*)::int as n, coalesce(sum(cost_minor),0) as cost from marketing_activities where workspace_id = any($1::uuid[]) and status <> 'cancelled' and coalesce(published_on, created_at::date) between $2 and $3", [ids, from, to])).rows[0];
    let feeRows = [];
    if (g.seeFees) feeRows = (await pool.query(`select i.number, i.issue_date, i.total_minor, i.currency, w.ref, coalesce((select sum(amount_minor) from fee_allocations a where a.invoice_id = i.id and a.status = 'active'),0) as paid, coalesce((select sum(amount_minor) from fee_credit_notes c where c.invoice_id = i.id),0) as credited
      from fee_invoices i join workspaces w on w.id = i.workspace_id where i.workspace_id = any($1::uuid[]) and w.section = 'sales' and i.status = 'issued' and i.issue_date between $2 and $3 order by i.issue_date`, [ids, from, to])).rows;
    const exp = g.seeFees ? (await pool.query("select payer, coalesce(sum(amount_minor),0) as s from sales_expenses where workspace_id = any($1::uuid[]) and status = 'approved' and cost_date between $2 and $3 group by 1", [ids, from, to])).rows : [];
    const byCur = rows => { const o = {}; for (const r0 of rows) o[r0.currency] = (o[r0.currency] || 0) + Number(r0.final_minor ?? r0.accepted_minor); return Object.entries(o).map(([c, v]) => fm(v, c)).join(' + ') || fm(0); };
    res.send(shell(req, 'Fees & Reports', html`
      <form class="filters" method="get"><label class="small">From <input type="date" name="from" value="${from}"></label><label class="small">To <input type="date" name="to" value="${to}"></label><button class="btn" type="submit">Apply</button></form>
      <section class="grid-cards">
        <div class="card"><div class="muted small">Active listings now</div><div class="big">${(statusCount.available || 0) + (statusCount.under_offer || 0) + (statusCount.reserved || 0)}</div><div class="muted small">Available ${statusCount.available || 0} · under offer ${statusCount.under_offer || 0} · reserved ${statusCount.reserved || 0} · all-time listings ${listings.length}</div></div>
        <div class="card"><div class="muted small">Enquiries in period</div><div class="big">${enqTotal.n}</div><div class="muted small">from ${enqTotal.u} unique buyer(s)</div></div>
        <div class="card"><div class="muted small">Completed sales in period</div><div class="big">${sold.length}</div><div class="muted small">Transaction value ${byCur(sold)} — not SarayDar revenue</div></div>
        <div class="card"><div class="muted small">Pipeline (deals in progress)</div><div class="big">${inprog.length}</div><div class="muted small">Accepted value ${byCur(inprog.map(d => ({ ...d, final_minor: null })))} — forecast, not receipts</div></div>
      </section>
      <section class="panel"><h2 class="h">Listings and mandates</h2>
        <table class="kv"><tbody>${Object.entries(L_STATUS).map(([k, l]) => html`<tr><th>${l}</th><td>${statusCount[k] || 0}</td></tr>`)}</tbody></table>
        <h3 class="h3">Days on market</h3><p class="muted small">From the first day a listing became available to its completion date (sold), or to today (still on the market). Withdrawn listings and listings never made available are excluded.</p>
        ${domRows.length ? html`<div class="table-wrap"><table><thead><tr><th>Listing</th><th class="n">Days</th><th>Basis</th></tr></thead><tbody>${domRows.map(x => html`<tr><td>${x.ref}</td><td class="n">${x.days}</td><td class="small">${x.sold ? 'to completion' : 'to today'}</td></tr>`)}</tbody></table></div>` : html`<p class="muted">No listings on the market yet.</p>`}
        <h3 class="h3">Mandates ending within 30 days</h3>${mandExp.length ? html`<ul class="rows">${mandExp.map(m => html`<li><a href="/w/${m.id}/mandate">${m.ref} ${m.name}</a> · ${fmtDate(m.end_date)}</li>`)}</ul>` : html`<p class="muted">None.</p>`}
        <p class="small">Marketing activities in period: ${mk.n}${g.seeFees ? ` · recorded cost ${formatMoney(Number(mk.cost))}` : ''}</p></section>
      <section class="panel"><h2 class="h">Enquiries by source (period)</h2><p class="muted small">Enquiries count each buyer–property interest; unique buyers count each person once.</p>
        ${enq.length ? html`<div class="table-wrap"><table><thead><tr><th>Source</th><th class="n">Enquiries</th><th class="n">Unique buyers</th></tr></thead><tbody>${enq.map(e => html`<tr><td>${e.source}</td><td class="n">${e.n}</td><td class="n">${e.u}</td></tr>`)}</tbody></table></div>` : html`<p class="muted">None.</p>`}
        <h3 class="h3">Viewings (period)</h3><table class="kv"><tbody>${Object.entries(V_STATUS).map(([k, l]) => html`<tr><th>${l}</th><td>${(vw.find(x => x.status === k) || { n: 0 }).n}</td></tr>`)}</tbody></table>
        <h3 class="h3">Offers created (period)</h3><table class="kv"><tbody>${Object.entries(O_STATUS).map(([k, l]) => html`<tr><th>${l}</th><td>${(of.find(x => x.status === k) || { n: 0 }).n}</td></tr>`)}</tbody></table>
        <p class="muted small">Accepted offers are not completed sales; completed sales are listed above by completion date.</p>
        <h3 class="h3">Lost enquiries and fallen-through deals (period)</h3>${lost.length || fell.length ? html`<ul class="rows">${lost.map(x => html`<li>${x.reason} · ${x.n}</li>`)}${fell.map(d => html`<li>Deal ${d.ref} fell through: ${d.fell_through_reason}</li>`)}</ul>` : html`<p class="muted">None.</p>`}</section>
      ${g.seeFees ? html`<section class="panel"><h2 class="h">SarayDar fees (issued in period)</h2>
        ${feeRows.length ? html`<div class="table-wrap"><table><thead><tr><th>Invoice</th><th>Case</th><th>Issued</th><th class="n">Total</th><th class="n">Collected</th><th class="n">Outstanding</th></tr></thead><tbody>
          ${feeRows.map(f => html`<tr><td>${f.number}</td><td>${f.ref}</td><td class="small">${fmtDate(f.issue_date)}</td><td class="n">${fm(f.total_minor, f.currency)}</td><td class="n">${fm(f.paid)}</td><td class="n">${fm(Number(f.total_minor) - Number(f.paid) - Number(f.credited))}</td></tr>`)}
          <tr class="total"><td>Total</td><td></td><td></td><td class="n">${fm(feeRows.reduce((s, f) => s + Number(f.total_minor), 0))}</td><td class="n">${fm(feeRows.reduce((s, f) => s + Number(f.paid), 0))}</td><td class="n">${fm(feeRows.reduce((s, f) => s + Number(f.total_minor) - Number(f.paid) - Number(f.credited), 0))}</td></tr></tbody></table></div>` : html`<p class="muted">No fee invoices issued in the period.</p>`}
        <h3 class="h3">Approved expenses (period)</h3><table class="kv"><tbody>${[['saraydar', 'SarayDar costs'], ['client_reimbursable', 'Client-reimbursable'], ['client_direct', 'Paid by clients directly']].map(([k, l]) => html`<tr><th>${l}</th><td>${fm((exp.find(x => x.payer === k) || { s: 0 }).s)}</td></tr>`)}</tbody></table></section>` : ''}
      <p class="muted small">Only cases you can open are counted. Currencies are not combined without a recorded conversion.</p>`));
  });

  // portfolio columns
  ctx.portfolioCols = ctx.portfolioCols || {};
  ctx.portfolioCols.sales = [['Stage', 'status'], ['Mandate', 'mandate'], ['Price / budget', 'price'], ['Open enquiries', 'enq'], ['Next follow-up', 'next']];
  ctx.portfolioExtras = ctx.portfolioExtras || {};
  ctx.portfolioExtras.sales = async ids => {
    const out = {};
    for (const id of ids) {
      const w = (await pool.query('select kind from workspaces where id = $1', [id])).rows[0];
      const M = await SL.mandateState(id);
      const mandate = M.eff === 'none' ? 'Not recorded' : M.eff === 'active' && !M.cur.authority_verified_at ? 'Active — not verified' : `${M_LABEL2[M.eff]}${M.cur && M.cur.end_date ? ` to ${fmtDate(M.cur.end_date)}` : ''}`;
      if (w.kind === 'listing') {
        const l = await SL.listingOf(id) || { status: 'draft' };
        const o = (await pool.query("select count(*) filter (where stage = any($2::text[]))::int as open, min(next_followup_on) filter (where stage = any($2::text[])) as next from opportunities where listing_ws = $1", [id, OPEN_STAGES])).rows[0];
        out[id] = { status: L_STATUS[l.status], mandate, price: fm(l.asking_minor, l.currency || 'BHD'), enq: String(o.open), next: fmtDate(o.next) || '—' };
      } else if (w.kind === 'request') {
        const rq = await SL.reqOf(id); const b = await SL.briefOf(id);
        const o = (await pool.query("select min(next_followup_on) as next from opportunities where request_ws = $1", [id])).rows[0];
        out[id] = { status: R_STATUS[rq.status], mandate, price: b && b.budget_max_minor != null ? `up to ${fm(b.budget_max_minor, b.currency)}` : '—', enq: '—', next: fmtDate(o.next) || '—' };
      } else out[id] = { status: 'Deal', mandate: '—', price: '—', enq: '—', next: '—' };
    }
    return out;
  };
}
const M_LABEL2 = { active: 'Active', suspended: 'Suspended', expired: 'Expired', none: 'Not recorded' };

module.exports = { mountSalesCrm };
