'use strict';
const U = require('../lib/undo');
const crypto = require('crypto');
const multer = require('multer');
const sharp = require('sharp');
const { SECTIONS, SECTION_KEYS, KIND_LABEL, STATUS_LABEL, INTERNAL_MEMBER_ROLES, EXTERNAL_MEMBER_ROLES } = require('./core');
const CH = require('./choices');
const budgetControlField = value => field({ name: 'budget_control', label: 'Project budget and payments controlled by', value, options: [['saraydar', 'SarayDar (we manage the budget and third-party payments)'], ['client', 'The client (SarayDar has no part in the budget or payments)']],
  hint: 'If the client controls them, the Client Budget & Payments tab is removed and SarayDar records no budget, contracts or payments for this project.' });
const stageField = (kind, value, hint = '') => CH.STAGES[kind]
  ? field({ name: 'stage', label: 'Current stage', value: value || '', hint, options: [['', 'Not yet determined'], ...(value && !CH.STAGES[kind].includes(value) ? [[value, value]] : []), ...CH.STAGES[kind].map(x => [x, x])] })
  : field({ name: 'stage', label: 'Current stage', value: value || '', attrs: 'maxlength="80"', hint });
const { layout, html, raw, statusPill, pill, csrfField, emptyState, field, pager, icons, fmtDate, fmtDateTime, fmtSize, ROLE_LABELS, avatar } = require('./views');

const PER_PAGE = 20;
const MAX_FILE = 25 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE, files: 10, fields: 20 } });
const UUID = /^[0-9a-f-]{36}$/i;

// Identify files by their content, not their name.
function sniff(buf, name) {
  const ext = (String(name).toLowerCase().match(/\.([a-z0-9]{1,6})$/) || [])[1] || '';
  const b = buf.subarray(0, 16);
  const hex = b.toString('hex');
  if (hex.startsWith('ffd8ff')) return { mime: 'image/jpeg', image: true };
  if (hex.startsWith('89504e470d0a1a0a')) return { mime: 'image/png', image: true };
  if (b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP') return { mime: 'image/webp', image: true };
  if (b.subarray(4, 8).toString() === 'ftyp' && /^(heic|heix|mif1|msf1|hevc)/.test(b.subarray(8, 12).toString())) return { mime: 'image/heic', image: false };
  if (b.subarray(0, 5).toString() === '%PDF-') return { mime: 'application/pdf' };
  if (hex.startsWith('504b0304')) {
    const office = { docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', zip: 'application/zip' };
    if (office[ext]) return { mime: office[ext] };
  }
  if (b.subarray(0, 4).toString() === 'AC10' && ext === 'dwg') return { mime: 'image/vnd.dwg' };
  if (['csv', 'txt'].includes(ext) && !buf.subarray(0, 4096).includes(0)) return { mime: ext === 'csv' ? 'text/csv' : 'text/plain' };
  return null;
}
const safeName = n => String(n || 'file').replace(/[/\\]/g, '_').replace(/[\u0000-\u001f<>:"|?*]/g, '').slice(-150) || 'file';

function mountWorkspaces(r, ctx) {
  const { pool, core, mailer, NotFound, Forbidden } = ctx;
  const sectionOf = key => { const s = SECTIONS[key]; if (!s) throw new NotFound(); return s; };

  async function access(req, id) {
    const a = await core.workspaceAccess(req.user, id);
    if (!a) throw new NotFound();
    return a;
  }

  // ---------- main dashboard ----------
  r.get('/', async (req, res) => {
    const u = req.user;
    if (core.isExternal(u)) return res.redirect('/my');
    const vis = core.visibleWhere(u);
    const counts = (await pool.query(
      `select section, count(*) filter (where status in ('active','on_hold'))::int as open, count(*)::int as total,
              count(*) filter (where kind = 'listing' and status in ('active','on_hold'))::int as listings,
              count(*) filter (where kind = 'request' and status in ('active','on_hold'))::int as requests
         from workspaces w where ${vis} group by section`, [u.id])).rows;
    const by = Object.fromEntries(counts.map(c => [c.section, c]));
    const attention = [];
    for (const fn of ctx.attention || []) attention.push(...await fn(u));
    if (core.isSuper(u) && !mailer.configured) attention.push(['Setup', 'warn', 'Email delivery is not configured', 'Invitations, password resets and invoices stay in the Outbox until Outlook email is set up (see the setup guide for the technical team).', '/admin/system']);
    if (core.isSuper(u) && ctx.mfaOn) {
      const n = (await pool.query("select count(*)::int as n from users where active and kind = 'internal' and not mfa_enabled")).rows[0].n;
      if (n) attention.push(['Security', 'info', `${n} staff ${n === 1 ? 'account has' : 'accounts have'} no two-step verification`, 'Recommended for everyone who sees financial records.', '/admin/users']);
    }
    const hour = Number(new Date().toLocaleString('en-GB', { hour: 'numeric', hour12: false, timeZone: 'Asia/Bahrain' }));
    const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
    const card = key => {
      const s = SECTIONS[key], c = by[key] || { open: 0, total: 0, listings: 0, requests: 0 };
      const plural = { dev: 'projects', cpm: 'projects', props: 'properties' }[key];
      const stats = key === 'sales'
        ? [['Active listings', c.listings, true, 'Properties for sale'], ['Active requests', c.requests, true, 'Buyers searching']]
        : [[`Active ${plural}`, c.open, true, ''], [`Total ${plural}`, c.total, false, 'Including completed']];
      return html`<a class="card section-card" href="/s/${key}" aria-label="Open ${s.name}">
        <div class="section-head"><span class="section-icon">${icons[key]}</span><h2>${s.name}</h2>
          <span class="section-go" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg></span></div>
        <dl class="section-stats">${stats.map(([l, v, dot, sub]) => html`<div><dt>${dot ? html`<i class="dot" aria-hidden="true"></i>` : ''}${l}</dt><dd>${v}</dd>${sub ? html`<span class="sub">${sub}</span>` : ''}</div>`)}</dl></a>`;
    };
    res.send(layout(req, { title: 'Home', body: html`
      <div class="page-head"><div><div class="muted small">Home</div><h1 class="display">${greet}, ${(u.name || '').split(' ')[0] || 'there'}</h1>
        <p class="muted">${new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Bahrain' })}</p></div></div>
      <section class="grid-cards home-sections" aria-label="Sections">${SECTION_KEYS.map(card)}</section>
      ${core.isSuper(u) ? html`<section class="panel"><h2 class="h">Needs your attention</h2>
          ${attention.length ? html`<ul class="rows">${attention.map(([tag, tone, t, d, href]) => html`<li>${pill(tag, tone)}<div class="grow"><a href="${href}"><b>${t}</b></a><div class="muted small">${d}</div></div></li>`)}</ul>`
            : html`<p class="muted">Nothing needs your attention right now.</p>`}</section>` : ''}` }));
  });

  // External viewers' My Workspaces page and portal live in external.js.

  // ---------- search ----------
  r.get('/search', async (req, res) => {
    if (core.isExternal(req.user)) return res.redirect('/my');
    const q = String(req.query.q || '').trim().slice(0, 100);
    const rows = q ? (await pool.query(
      `select w.*, p.name as party_name from workspaces w left join parties p on p.id = w.party_id
        where ${core.visibleWhere(req.user)} and (w.name ilike $2 or w.ref ilike $2 or coalesce(w.location,'') ilike $2 or coalesce(p.name,'') ilike $2)
        order by w.updated_at desc limit 50`, [req.user.id, `%${q.replace(/[%_\\]/g, '\\$&')}%`])).rows : [];
    res.send(layout(req, { title: 'Search', heading: q ? `Results for “${q}”` : 'Search', crumbs: [['Home', '/'], ['Search']], body: html`
      ${rows.length ? html`<div class="table-wrap"><table><thead><tr><th>Name</th><th>Section</th><th>Reference</th><th>Client / owner</th><th>Status</th></tr></thead><tbody>
        ${rows.map(w => html`<tr><td><a href="/w/${w.id}">${w.name}</a></td><td>${SECTIONS[w.section].name}</td><td class="mono">${w.ref}</td><td>${w.party_name || '—'}</td><td>${statusPill(w.status)}</td></tr>`)}</tbody></table></div>`
        : emptyState(q ? 'No matches' : 'Type in the search box above', q ? 'Only items you have access to are searched.' : '')}` }));
  });

  // ---------- section portfolio ----------
  // one workspace as a card on the section page (the whole card opens it). Redesigned 2026-10-27: a cover
  // (latest photo, or the section mark), the key figures as large numbers with bars, and the record's completeness.
  const { formatMoney } = require('../lib/money');
  const I = {
    pin: raw('<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>'),
    person: raw('<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>'),
    lead: raw('<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/><path d="M16 3.5a4 4 0 0 1 0 7"/></svg>'),
    go: raw('<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>')
  };
  const initials = n => String(n || '?').trim().split(/\s+/).filter(w => /^[A-Za-z0-9؀-ۿ]/.test(w)).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?';
  const money = m => m === null || m === undefined ? '—' : formatMoney(Number(m)).replace(/^BHD /, '');
  const meter = (pctv, tone = '') => html`<div class="wt-meter ${tone}"><span style="width:${Math.max(0, Math.min(100, Number(pctv) || 0))}%"></span></div>`;
  function wsCard(w, s, partyLabel, extra, pcols, comp) {
    const x = extra ? extra[w.id] || {} : null;
    const who = s.key === 'cpm' ? 'Client' : partyLabel ? partyLabel.label : null;
    // key figures for this kind of record
    let figures = '';
    if (s.key === 'props' && x) {
      const fin = x._due !== null && x._due !== undefined;
      const rentPct = fin && x._due > 0 ? x._collected / x._due * 100 : null;
      figures = html`<div class="wt-stats">
          <div><b>${x._units ?? '—'}</b><span>Units</span></div>
          <div><b>${x._occPct === null || x._occPct === undefined ? '—' : `${Math.round(x._occPct)}%`}</b><span>Occupied${x._denom ? ` · ${x._occupied}/${x._denom}` : ''}</span></div>
          <div class="${x._maintEm ? 'wt-bad' : ''}"><b>${x._maint ?? 0}</b><span>Open maintenance</span></div></div>
        ${x._occPct !== null && x._occPct !== undefined ? html`<div class="wt-row"><span>Occupancy</span>${meter(x._occPct, 'ok')}</div>` : ''}
        ${fin ? html`<div class="wt-money"><div class="wt-money-top"><span>Rent this month</span><span><b>BHD ${money(x._collected)}</b> of ${money(x._due)} collected</span></div>${meter(rentPct === null ? 0 : rentPct, rentPct !== null && rentPct >= 100 ? 'ok' : '')}
          ${x._arrears ? html`<div class="wt-flag bad">Arrears BHD ${money(x._arrears)}</div>` : ''}${x.fees && x.fees !== '—' && !/^BHD 0\.000$/.test(x.fees) ? html`<div class="wt-flag warn">Unpaid fees ${x.fees}</div>` : ''}</div>` : ''}`;
    } else if ((s.key === 'dev' || s.key === 'cpm') && x) {
      figures = html`<div class="wt-progress"><div class="wt-money-top"><span>Progress</span><b>${x._pct === null || x._pct === undefined ? 'Not started' : `${Math.round(x._pct)}%`}</b></div>${meter(x._pct || 0)}</div>
        <div class="wt-next"><span>Next milestone</span><b>${x.next || '—'}</b></div>
        <div class="wt-chips">${x._overdue ? html`<span class="wt-flag bad">${x._overdue} overdue task${x._overdue === 1 ? '' : 's'}</span>` : ''}${x._highRisks ? html`<span class="wt-flag bad">${x._highRisks} high risk${x._highRisks === 1 ? '' : 's'}</span>` : ''}
          ${s.key === 'cpm' && x.fees && x.fees !== '—' && !/^BHD 0\.000$/.test(x.fees) ? html`<span class="wt-flag warn">Unpaid fees ${x.fees}</span>` : ''}</div>`;
    } else if (s.key === 'sales' && x) {
      figures = html`<div class="wt-price"><span>${w.kind === 'request' ? 'Budget' : 'Asking price'}</span><b>${x.price || '—'}</b></div>
        <div class="wt-chips"><span class="wt-chip">${x.status || '—'}</span><span class="wt-chip ${/not verified|not recorded|expired/i.test(x.mandate || '') ? 'warn' : ''}">Mandate: ${x.mandate || '—'}</span></div>
        <div class="wt-stats two"><div><b>${x.enq ?? 0}</b><span>Open enquiries</span></div><div><b class="wt-small">${x.next || '—'}</b><span>Next follow-up</span></div></div>`;
    } else if (x && pcols) {
      figures = html`<dl class="wt-list">${pcols.map(([l, k]) => html`<div><dt>${l}</dt><dd>${x[k] === null || x[k] === undefined || x[k] === '' ? '—' : x[k]}</dd></div>`)}</dl>`;
    }
    const pctDone = comp && comp.total ? Math.round(comp.done / comp.total * 100) : null;
    return html`<li><a class="ws-tile wt" href="/w/${w.id}">
      <div class="wt-cover ${w.cover_id ? 'has-photo' : `wt-${s.key}`}">${w.cover_id ? html`<img src="/files/${w.cover_id}/thumb" alt="" loading="lazy">` : html`<span class="wt-mark" aria-hidden="true">${icons[s.key] || ''}</span><span class="wt-initials" aria-hidden="true">${initials(w.name)}</span>`}
        <span class="wt-ref">${w.ref}</span><span class="wt-status">${statusPill(w.status)}</span></div>
      <div class="wt-body">
        <b class="ws-tile-name">${w.name}</b>
        <div class="wt-meta">${w.location ? html`<span>${I.pin}${w.location}</span>` : ''}${w.stage ? html`<span class="wt-stage">${w.stage}</span>` : ''}</div>
        <div class="wt-people">${who ? html`<div><span class="wt-avatar">${initials(w.party_name)}</span><span><small>${who}</small>${w.party_name || html`<em>Not linked</em>`}</span></div>` : ''}
          <div><span class="wt-avatar staff">${initials(w.manager_name)}</span><span><small>Manager</small>${w.manager_name || html`<em>Not assigned</em>`}</span></div></div>
        ${figures}
      </div>
      <div class="wt-foot">${comp && comp.total ? (comp.missing.length ? html`<span class="wt-done" title="${comp.done} of ${comp.total} recorded"><span class="wt-ring" style="--p:${pctDone}"></span>${comp.missing.length} to complete</span>` : html`<span class="wt-done full"><span class="wt-ring" style="--p:100"></span>Record complete</span>`) : html`<span></span>`}
        <span class="wt-updated">Updated ${fmtDate(w.updated_at)}</span><span class="ws-tile-go" aria-hidden="true">${I.go}</span></div></a></li>`;
  }

  r.get('/s/:section', async (req, res) => {
    if (core.isExternal(req.user)) return res.redirect('/my');
    const s = sectionOf(req.params.section);
    const status = ['active', 'on_hold', 'completed', 'archived', 'all'].includes(req.query.status) ? req.query.status : 'open';
    const kind = s.tabs ? (s.tabs.some(t => t[0] === req.query.kind) ? req.query.kind : s.tabs[0][0]) : null;
    const sort = { name: 'w.name asc', ref: 'w.ref asc', created: 'w.created_at desc' }[req.query.sort] || 'w.updated_at desc';
    const q = String(req.query.q || '').trim().slice(0, 100);
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const vals = [req.user.id, s.key];
    const where = [core.visibleWhere(req.user), 'w.section = $2'];
    if (kind) { vals.push(kind); where.push(`w.kind = $${vals.length}`); }
    if (status === 'open') where.push("w.status in ('active','on_hold')");
    else if (status !== 'all') { vals.push(status); where.push(`w.status = $${vals.length}`); }
    if (q) { vals.push(`%${q.replace(/[%_\\]/g, '\\$&')}%`); where.push(`(w.name ilike $${vals.length} or w.ref ilike $${vals.length} or coalesce(w.location,'') ilike $${vals.length} or coalesce(p.name,'') ilike $${vals.length})`); }
    const from = `from workspaces w left join parties p on p.id = w.party_id left join users mu on mu.id = w.manager_id where ${where.join(' and ')}`;
    const total = (await pool.query(`select count(*)::int as n ${from}`, vals)).rows[0].n;
    const rows = (await pool.query(`select w.*, p.name as party_name, coalesce(mu.name, mu.email) as manager_name,
      (select f.id from files f where f.workspace_id = w.id and f.thumb is not null and f.archived_at is null order by (f.entity is null) desc, f.uploaded_at desc limit 1) as cover_id ${from} order by ${sort} limit ${req.exportAll ? 5000 : PER_PAGE} offset ${req.exportAll ? 0 : (page - 1) * PER_PAGE}`, vals)).rows;
    const extra = ctx.portfolioExtras && ctx.portfolioExtras[s.key] && rows.length ? await ctx.portfolioExtras[s.key](rows.map(x => x.id), req.user) : null;
    const pcols = ctx.portfolioCols && ctx.portfolioCols[s.key];
    const createKinds = [];
    for (const [k, c] of Object.entries(s.create)) if (await core.can(req.user, `create:${s.key}`)) createKinds.push([k, c]);
    const partyLabel = (s.create[kind || s.kinds[0]] || {}).party;
    const qs = extra => { const p = new URLSearchParams({ ...(kind ? { kind } : {}), ...(q ? { q } : {}), status, ...extra }); return `?${p}`; };
    res.send(layout(req, { title: s.name, heading: s.name, crumbs: [['Home', '/'], [s.name]],
      tabs: ctx.sectionTabs && ctx.sectionTabs[s.key] ? ctx.sectionTabs[s.key]((s.tabs.find(t => t[0] === kind) || [])[1]) : s.tabs ? s.tabs.map(([k, l]) => [l, `/s/${s.key}?kind=${k}`, k === kind]) : null,
      actions: createKinds.length || s.key === 'cpm' || s.key === 'sales' ? html`<div class="actions">${s.key === 'cpm' && (core.isSuper(req.user) || createKinds.length || await core.can(req.user, 'finance:post')) ? html`<a class="btn" href="/clients">Clients</a>` : ''}${s.key === 'sales' && createKinds.length ? html`<a class="btn accent" href="/sales/buyers/new">+ Add Prospective Buyer</a>` : ''}${createKinds.map(([k, c]) => html`<a class="btn accent" href="/s/${s.key}/new?kind=${k}">+ ${c.label}</a>`)}</div>` : null,
      body: html`
      <form class="filters" method="get">${kind ? html`<input type="hidden" name="kind" value="${kind}">` : ''}
        <label class="searchbox">${icons.search}<input type="search" name="q" value="${q}" placeholder="Search name, reference, location, client" aria-label="Search this section"></label>
        <select name="status" aria-label="Status">${[['open', 'Active & on hold'], ['active', 'Active'], ['on_hold', 'On hold'], ['completed', 'Completed'], ['archived', 'Archived'], ['all', 'All']].map(([v, l]) => html`<option value="${v}" ${v === status ? raw('selected') : ''}>${l}</option>`)}</select>
        <select name="sort" aria-label="Sort">${[['updated', 'Recently updated'], ['name', 'Name'], ['ref', 'Reference'], ['created', 'Newest']].map(([v, l]) => html`<option value="${v}" ${v === (req.query.sort || 'updated') ? raw('selected') : ''}>${l}</option>`)}</select>
        <button class="btn" type="submit">Apply</button></form>
      ${rows.length && !req.exportAll ? html`<ul class="ws-grid" aria-label="${s.name}">${await Promise.all(rows.map(async w => wsCard(w, s, partyLabel, extra, pcols, ctx.completeness && ['active', 'on_hold'].includes(w.status) ? await ctx.completeness(w) : null)))}</ul>${pager(req, total, page, PER_PAGE)}`
        : rows.length ? html`<div class="table-wrap"><table><thead><tr>${s.key === 'cpm' ? html`<th>Client</th>` : ''}<th>Name</th><th>Reference</th>${partyLabel && s.key !== 'cpm' ? html`<th>${partyLabel.label}</th>` : ''}<th>Location</th><th>Manager</th>${extra && pcols ? pcols.map(c => html`<th>${c[0]}</th>`) : extra ? html`<th>Progress</th><th>Next milestone</th>${s.key === 'cpm' ? html`<th>Unpaid fees</th>` : ''}<th>Alerts</th>` : ''}<th>Status</th><th>Updated</th></tr></thead><tbody>
        ${rows.map(w => html`<tr>${s.key === 'cpm' ? html`<td class="client-cell">${w.party_name || html`<span class="muted">Not linked</span>`}</td>` : ''}<td><a href="/w/${w.id}"><b>${w.name}</b></a>${w.stage ? html`<div class="muted small">${w.stage}</div>` : ''}</td><td class="mono">${w.ref}</td>${partyLabel && s.key !== 'cpm' ? html`<td>${w.party_name || '—'}</td>` : ''}<td>${w.location || '—'}</td><td>${w.manager_name || '—'}</td>${extra && pcols ? pcols.map(c => html`<td class="small">${extra[w.id][c[1]]}</td>`) : extra ? html`<td>${extra[w.id].progress}</td><td class="small">${extra[w.id].next}</td>${s.key === 'cpm' ? html`<td class="n">${extra[w.id].fees}</td>` : ''}<td>${extra[w.id].alerts ? pill(String(extra[w.id].alerts), 'bad') : '—'}</td>` : ''}<td>${statusPill(w.status)}</td><td class="small">${fmtDate(w.updated_at)}</td></tr>`)}
        </tbody></table></div>${pager(req, total, page, PER_PAGE)}`
        : emptyState(q || status !== 'open' ? 'Nothing matches these filters' : s.empty, createKinds.length && !q ? 'Use the button above to add the first one.' : 'Items appear here when you are added to them.')}` }));
  });

  // ---------- create ----------
  async function createForm(req, res, s, kind, err = '', vals = {}) {
    const c = s.create[kind];
    const users = (await pool.query("select id, coalesce(nullif(name,''), email) as label from users where active and kind = 'internal' order by 2")).rows;
    const parties = c.party ? (await pool.query('select name from parties where $1 = any(roles) and archived_at is null order by name limit 500', [c.party.role])).rows : [];
    res.status(err ? 400 : 200).send(layout(req, { title: c.label, heading: c.label, crumbs: [['Home', '/'], [s.name, `/s/${s.key}`], [c.label]], body: html`
      <form method="post" action="/s/${s.key}/new" class="panel form-grid">${csrfField(req)}<input type="hidden" name="kind" value="${kind}">
        ${field({ name: 'name', label: 'Name', value: vals.name || '', required: true, attrs: 'maxlength="160" autofocus' })}
        ${c.party ? html`${field({ name: 'party', label: `${c.party.label} name`, value: vals.party || '', attrs: 'list="party-list" maxlength="160"', hint: 'Pick an existing name from the list to link the same record, or type a new one. Leave empty if not yet determined.' })}
          <datalist id="party-list">${parties.map(p => html`<option value="${p.name}"></option>`)}</datalist>` : ''}
        ${field({ name: 'location', label: 'Location', value: vals.location || '', attrs: 'maxlength="200"', hint: 'Pick an area from the list or type one. Leave empty if not yet determined.', list: CH.BH_AREAS })}
        ${field({ name: 'manager', label: 'Responsible manager', value: vals.manager || req.user.id, options: [['', 'Not yet assigned'], ...users.map(x => [x.id, x.label])] })}
        ${['dev', 'cpm'].includes(s.key) ? '' : stageField(kind, vals.stage)}
        ${s.key === 'cpm' ? budgetControlField(vals.budget_control || 'saraydar') : ''}
        <p class="muted small full">${['dev', 'cpm'].includes(s.key) ? 'After creating it, the guided setup asks the remaining questions. Everything entered here can be edited later.' : 'The guided setup questionnaire for this section is added in a later phase. Everything entered here can be edited later.'}${s.key === 'cpm' ? html` New clients get a basic record; complete their profile under <a href="/clients">Clients</a>.` : ''}</p>
        ${err ? html`<p class="err full" role="alert">${err}</p>` : ''}
        <div class="full actions"><button class="btn primary" type="submit">Create</button><a class="btn" href="/s/${s.key}">Cancel</a></div>
      </form>` }));
  }

  r.get('/s/:section/new', async (req, res) => {
    const s = sectionOf(req.params.section);
    const kind = s.create[req.query.kind] ? req.query.kind : Object.keys(s.create)[0];
    if (!(await core.can(req.user, `create:${s.key}`))) throw new Forbidden('Your role cannot create items in this section.');
    const pre = UUID.test(req.query.client || '') ? (await pool.query('select name from parties where id = $1', [req.query.client])).rows[0] : null;
    await createForm(req, res, s, kind, '', pre ? { party: pre.name } : {});
  });

  r.post('/s/:section/new', async (req, res) => {
    const s = sectionOf(req.params.section);
    const kind = s.create[req.body.kind] ? req.body.kind : Object.keys(s.create)[0];
    if (!(await core.can(req.user, `create:${s.key}`))) throw new Forbidden('Your role cannot create items in this section.');
    const c = s.create[kind];
    const vals = { name: String(req.body.name || '').trim().slice(0, 160), party: String(req.body.party || '').trim().slice(0, 160),
      location: String(req.body.location || '').trim().slice(0, 200), stage: String(req.body.stage || '').trim().slice(0, 80), manager: String(req.body.manager || ''), budget_control: req.body.budget_control === 'client' ? 'client' : 'saraydar' };
    if (!vals.name) return createForm(req, res, s, kind, 'Enter a name.', vals);
    if (vals.manager && !UUID.test(vals.manager)) vals.manager = '';
    const id = await core.inTx(async db => {
      let partyId = null;
      if (c.party && vals.party) {
        const ex = (await db.query('select id from parties where lower(name) = lower($1) and $2 = any(roles) and archived_at is null limit 1', [vals.party, c.party.role])).rows[0];
        partyId = ex ? ex.id : (await db.query('insert into parties (name, roles, created_by) values ($1, $2, $3) returning id', [vals.party, [c.party.role], req.user.id])).rows[0].id;
      }
      const year = new Date().toLocaleString('en-GB', { year: 'numeric', timeZone: 'Asia/Bahrain' });
      const n = await core.nextNumber(db, `${c.prefix}-${year}`);
      const ref = `${c.prefix}-${year}-${String(n).padStart(3, '0')}`;
      const w = (await db.query(
        `insert into workspaces (section, kind, ref, name, location, stage, party_id, manager_id, created_by, budget_control)
         values ($1,$2,$3,$4,nullif($5,''),nullif($6,''),$7,nullif($8,'')::uuid,$9,$10) returning id`,
        [s.key, kind, ref, vals.name, vals.location, vals.stage, partyId, vals.manager, req.user.id, s.key === 'cpm' ? vals.budget_control : 'saraydar'])).rows[0];
      await db.query("insert into workspace_members (workspace_id, user_id, role, added_by) values ($1,$2,'manager',$2)", [w.id, req.user.id]);
      if (vals.manager && vals.manager !== req.user.id) {
        await db.query("insert into workspace_members (workspace_id, user_id, role, added_by) values ($1,$2,'manager',$3) on conflict do nothing", [w.id, vals.manager, req.user.id]);
      }
      await core.audit(db, { actor: req.user, workspaceId: w.id, action: 'workspace.created', entity: 'workspace', entityId: w.id, summary: `${KIND_LABEL[kind]} ${ref} created: ${vals.name}`, after: { ...vals, ref }, ip: req.ip });
      return w.id;
    });
    res.redirect(`/w/${id}?msg=created`);
  });

  // ---------- one workspace ----------
  function wsLayout(req, a, tab, body, extra = {}) {
    const w = a.ws, s = SECTIONS[w.section];
    const external = !a.internal;
    let tabs = [['Overview', `/w/${w.id}`, tab === 'overview'], ['Documents', `/w/${w.id}/documents`, tab === 'documents']];
    if (!external) { tabs.splice(1, 0, ['Agreements', `/w/${w.id}/agreements`, false]); tabs.push(['Access & Invitations', `/w/${w.id}/access`, tab === 'access'], ['Activity', `/w/${w.id}/activity`, tab === 'activity']); }
    const label = { overview: 'Overview', documents: 'Documents', access: 'Access & Invitations', activity: 'Activity' }[tab];
    if (!external && ctx.tabsFor && ctx.tabsFor[w.section]) tabs = ctx.tabsFor[w.section](a, label);
    return layout(req, { title: w.name, heading: w.name, tabs,
      crumbs: external ? [['My Workspaces', '/my'], [w.name]] : [['Home', '/'], [s.name, `/s/${w.section}${s.tabs ? `?kind=${w.kind}` : ''}`], [w.name]],
      sub: { above: `${w.ref} · ${KIND_LABEL[w.kind]}${external ? ' · View only' : ''}`, below: [w.location, w.stage ? `Stage: ${w.stage}` : null].filter(Boolean).join(' · '), badge: statusPill(w.status) },
      body, ...extra });
  }

  r.get('/w/:id', async (req, res) => {
    const a = await access(req, req.params.id);
    const w = a.ws;
    const party = w.party_id ? (await pool.query('select name from parties where id = $1', [w.party_id])).rows[0] : null;
    const mgr = w.manager_id ? (await pool.query('select coalesce(nullif(name,\'\'), email) as n from users where id = $1', [w.manager_id])).rows[0] : null;
    const pLabel = (SECTIONS[w.section].create[w.kind] || {}).party;
    let legacy = '';
    if (w.legacy && a.internal && !(w.details && w.details.imported_at)) {
      const c = (await pool.query('select collection, count(*)::int as n from records group by collection')).rows;
      const n = Object.fromEntries(c.map(x => [x.collection, x.n]));
      legacy = html`<section class="panel"><h2 class="h">Existing project tracker</h2>
        <p>This project's tasks, budget, risks and site log are still in the original Abuquwa tracker. They move into this workspace in Phase 3.</p>
        <dl class="stats inline"><div><dt>Tasks</dt><dd>${n.tasks || 0}</dd></div><div><dt>Budget lines</dt><dd>${n.costs || 0}</dd></div><div><dt>Risks</dt><dd>${n.risks || 0}</dd></div><div><dt>Site log entries</dt><dd>${n.log || 0}</dd></div></dl></section>`;
    }
    const extras = html`${ctx.completenessPanel ? await ctx.completenessPanel(a) : ''}${ctx.overviewExtras && ctx.overviewExtras[w.section] ? await ctx.overviewExtras[w.section](req, a) : ''}`;
    const editable = core.canEdit(a);
    const users = editable ? (await pool.query("select id, coalesce(nullif(name,''), email) as label from users where active and kind = 'internal' order by 2")).rows : [];
    res.send(wsLayout(req, a, 'overview', html`${extras}
      <div class="split">
        <section class="panel grow1"><h2 class="h">Details</h2>
          <dl class="details">
            <div><dt>Reference</dt><dd class="mono">${w.ref}</dd></div>
            <div><dt>Section</dt><dd>${SECTIONS[w.section].name}</dd></div>
            ${pLabel ? html`<div><dt>${pLabel.label}</dt><dd>${party ? party.name : html`<span class="muted">Not yet determined</span>`}</dd></div>` : ''}
            <div><dt>Location</dt><dd>${w.location || html`<span class="muted">Not yet determined</span>`}</dd></div>
            <div><dt>Stage</dt><dd>${w.stage || html`<span class="muted">Not yet determined</span>`}</dd></div>
            ${w.section === 'cpm' && a.internal ? html`<div><dt>Budget &amp; payments</dt><dd>${w.budget_control === 'client' ? 'Controlled by the client' : 'Controlled by SarayDar'}</dd></div>` : ''}
            ${a.internal ? html`<div><dt>Responsible manager</dt><dd>${mgr ? mgr.n : html`<span class="muted">Not yet assigned</span>`}</dd></div>` : ''}
            <div><dt>Status</dt><dd>${statusPill(w.status)}</dd></div>
            <div><dt>Created</dt><dd>${fmtDate(w.created_at)}</dd></div>
          </dl></section>
        ${editable ? html`<details class="panel grow1 edit-panel" id="edit" ${req.query.edit ? raw('open') : ''}><summary><h2 class="h">Edit details</h2></summary>
          <form method="post" action="/w/${w.id}/edit" class="form-grid">${csrfField(req)}
            ${field({ name: 'name', label: 'Name', value: w.name, required: true, attrs: 'maxlength="160"' })}
            ${field({ name: 'location', label: 'Location', value: w.location || '', attrs: 'maxlength="200"', list: CH.BH_AREAS })}
            ${stageField(w.kind, w.stage)}
            ${w.section === 'cpm' ? budgetControlField(w.budget_control) : ''}
            ${field({ name: 'manager', label: 'Responsible manager', value: w.manager_id || '', options: [['', 'Not yet assigned'], ...users.map(x => [x.id, x.label])] })}
            ${field({ name: 'status', label: 'Status', value: w.status, options: Object.entries(STATUS_LABEL) })}
            <div class="full actions"><button class="btn primary" type="submit">Save</button></div>
            <p class="muted small full">Completed and archived items keep all their history and stay reachable through the section filters.</p>
          </form></details>` : ''}
      </div>
      ${legacy}
      ${w.details && w.details.imported_at && a.internal ? html`<p class="muted small">Tasks, budget, risks, units and the site log were imported from the earlier Abuquwa tracker on ${fmtDate(w.details.imported_at)}. Imported items are marked unverified until checked.</p>` : ''}
      ${a.internal && !(ctx.overviewExtras && ctx.overviewExtras[w.section]) ? html`<section class="panel"><h2 class="h">Coming to this workspace</h2>
        <p class="muted">${{ dev: 'Guided setup, plan approval, tasks and schedule, budget and cost control, progress updates with photos, investors and funding, and PDF/Excel reports (Phases 3 and 7).',
          cpm: 'Management agreement, execution tracking, client-funded expenditure, monthly fee invoices, receipts and client statements (Phase 4).',
          props: 'Units, leases, rent invoicing, deposits, maintenance, cleaning, owner statements and the Unit History & Report (Phase 5).',
          sales: 'Mandate, listing details and price history, buyers and follow-ups, viewings, offers, deal checklist and commission (Phase 6).' }[w.section]}</p></section>` : ''}`));
  });

  r.post('/w/:id/edit', async (req, res) => {
    const a = await access(req, req.params.id);
    if (!core.canEdit(a)) throw new Forbidden();
    const w = a.ws;
    const name = String(req.body.name || '').trim().slice(0, 160);
    if (!name) throw Object.assign(new Error('Name cannot be empty.'), { status: 400 });
    const status = Object.keys(STATUS_LABEL).includes(req.body.status) ? req.body.status : w.status;
    const manager = UUID.test(String(req.body.manager || '')) ? req.body.manager : null;
    const after = { name, location: String(req.body.location || '').trim().slice(0, 200) || null, stage: String(req.body.stage || '').trim().slice(0, 80) || null, status, manager_id: manager,
      budget_control: w.section === 'cpm' && ['saraydar', 'client'].includes(req.body.budget_control) ? req.body.budget_control : w.budget_control };
    const before = { name: w.name, location: w.location, stage: w.stage, status: w.status, manager_id: w.manager_id, budget_control: w.budget_control };
    const changed = Object.keys(after).filter(k => (after[k] || null) !== (before[k] || null));
    if (!changed.length) return res.redirect(`/w/${w.id}`);
    await core.inTx(async db => U.track(db, req.user, { label: `Edited ${w.name} (${changed.join(', ')})`, workspaceId: w.id, returnTo: `/w/${w.id}`, targets: [['workspaces', w.id]] }, async () => {
      await db.query(`update workspaces set name = $2, location = $3, stage = $4, status = $5, manager_id = $6, budget_control = $7, updated_at = now(),
        archived_at = case when $5 = 'archived' then coalesce(archived_at, now()) else null end where id = $1`,
        [w.id, after.name, after.location, after.stage, after.status, after.manager_id, after.budget_control]);
      if (manager) await db.query("insert into workspace_members (workspace_id, user_id, role, added_by) values ($1,$2,'manager',$3) on conflict (workspace_id, user_id) do update set revoked_at = null", [w.id, manager, req.user.id]);
      await core.audit(db, { actor: req.user, workspaceId: w.id, action: 'workspace.updated', entity: 'workspace', entityId: w.id,
        summary: `Changed ${changed.join(', ')}`, before: Object.fromEntries(changed.map(k => [k, before[k]])), after: Object.fromEntries(changed.map(k => [k, after[k]])), ip: req.ip });
    }));
    res.redirect(`/w/${w.id}?msg=saved`);
  });

  // ---------- documents ----------
  r.get('/w/:id/documents', async (req, res) => {
    const a = await access(req, req.params.id);
    const w = a.ws;
    const rows = (await pool.query(
      `select f.id, f.original_name, f.mime, f.size, f.caption, f.location, f.observed_on, f.visibility, f.uploaded_at, f.thumb is not null as has_thumb,
              coalesce(nullif(u.name,''), u.email) as by
         from files f left join users u on u.id = f.uploaded_by
        where f.workspace_id = $1 and f.archived_at is null ${a.internal ? '' : "and f.visibility = 'published'"}
        order by f.uploaded_at desc limit 200`, [w.id])).rows;
    const contribute = core.canContribute(a);
    res.send(wsLayout(req, a, 'documents', html`
      ${contribute ? html`<section class="panel"><h2 class="h">Upload</h2>
        <form method="post" action="/w/${w.id}/files" enctype="multipart/form-data" class="form-grid">
          <input type="hidden" name="_csrf" value="${req.csrfToken}">
          <label class="field full" for="f-files"><span>Files <i class="req" aria-hidden="true">*</i></span><input id="f-files" type="file" name="files" multiple required accept="image/*,.pdf,.docx,.xlsx,.pptx,.dwg,.csv,.txt,.zip"><small>Photos, PDF, Word, Excel, PowerPoint, DWG, CSV. Up to 10 files, 25 MB each.</small></label>
          ${field({ name: 'caption', label: 'Caption', attrs: 'maxlength="300"' })}
          ${field({ name: 'location', label: 'Location / work area', attrs: 'maxlength="120"' })}
          ${field({ name: 'observed_on', label: 'Observation date', type: 'date' })}
          ${field({ name: 'visibility', label: 'Visible to', value: 'internal', options: [['internal', 'SarayDar staff only'], ['published', 'Also external viewers of this workspace']] })}
          <div class="full actions"><button class="btn primary" type="submit">Upload</button></div></form></section>` : ''}
      <section class="panel"><h2 class="h">Files</h2>
        ${rows.length ? html`<ul class="files">${rows.map(f => html`<li>
          ${f.has_thumb ? html`<a href="/files/${f.id}" class="thumb"><img src="/files/${f.id}/thumb" alt="${f.caption || f.original_name}" loading="lazy" width="96" height="72"></a>` : html`<span class="thumb doc" aria-hidden="true">${(f.original_name.split('.').pop() || '').toUpperCase().slice(0, 4)}</span>`}
          <div class="grow"><a href="/files/${f.id}"><b>${f.original_name}</b></a>
            <div class="muted small">${[f.caption, f.location, f.observed_on ? `Observed ${fmtDate(f.observed_on)}` : null].filter(Boolean).join(' · ')}</div>
            <div class="muted small">${fmtSize(f.size)} · ${a.internal ? `${f.by || 'Unknown'} · ` : ''}${fmtDateTime(f.uploaded_at)}</div></div>
          ${a.internal ? (f.visibility === 'published' ? pill('Published', 'ok') : pill('Internal', 'muted')) : ''}
          ${core.canEdit(a) ? html`<form method="post" action="/files/${f.id}/archive">${csrfField(req)}<button class="btn small" type="submit">Archive</button></form>` : ''}
        </li>`)}</ul>` : emptyState('No files yet', contribute ? 'Upload drawings, agreements, photos and other documents above.' : 'Nothing has been shared here yet.')}
      </section>`));
  });

  r.post('/w/:id/files', upload.array('files', 10), async (req, res) => {
    if (!core.checkCsrf(req)) throw new Forbidden('Your form expired. Reload the page and try again.');
    const a = await access(req, req.params.id);
    if (!core.canContribute(a)) throw new Forbidden();
    const files = req.files || [];
    if (!files.length) throw Object.assign(new Error('Choose at least one file.'), { status: 400 });
    const prepared = [];
    for (const f of files) {
      const t = sniff(f.buffer, f.originalname);
      if (!t) throw Object.assign(new Error(`“${safeName(f.originalname)}” is not an accepted file type.`), { status: 415 });
      let thumb = null, width = null, height = null;
      if (t.image) {
        try {
          const img = sharp(f.buffer, { failOn: 'error' }).rotate();
          const meta = await sharp(f.buffer).metadata();
          width = meta.width || null; height = meta.height || null;
          thumb = await img.resize(480, 480, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 74 }).toBuffer();
        } catch (e) { throw Object.assign(new Error(`“${safeName(f.originalname)}” could not be read as an image.`), { status: 415 }); }
      }
      prepared.push({ name: safeName(f.originalname), mime: t.mime, size: f.size, sha: crypto.createHash('sha256').update(f.buffer).digest('hex'), data: f.buffer, thumb, width, height });
    }
    const caption = String(req.body.caption || '').trim().slice(0, 300) || null;
    const location = String(req.body.location || '').trim().slice(0, 120) || null;
    const observed = /^\d{4}-\d{2}-\d{2}$/.test(req.body.observed_on || '') ? req.body.observed_on : null;
    const visibility = req.body.visibility === 'published' ? 'published' : 'internal';
    await core.inTx(async db => {
      for (const p of prepared) {
        const id = (await db.query(
          `insert into files (workspace_id, original_name, mime, size, sha256, data, thumb, width, height, caption, location, observed_on, visibility, uploaded_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id`,
          [a.ws.id, p.name, p.mime, p.size, p.sha, p.data, p.thumb, p.width, p.height, caption, location, observed, visibility, req.user.id])).rows[0].id;
        await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'file.uploaded', entity: 'file', entityId: id, summary: `Uploaded ${p.name}`, after: { name: p.name, size: p.size, visibility }, ip: req.ip });
      }
      await db.query('update workspaces set updated_at = now() where id = $1', [a.ws.id]);
    });
    res.redirect(`/w/${a.ws.id}/documents?msg=uploaded`);
  });

  async function fileAccess(req) {
    if (!UUID.test(req.params.fid)) throw new NotFound();
    const f = (await pool.query('select id, workspace_id, original_name, mime, size, visibility, archived_at, entity, entity_id, tag from files where id = $1', [req.params.fid])).rows[0];
    if (!f) throw new NotFound();
    const a = await core.workspaceAccess(req.user, f.workspace_id);
    if (a && a.internal) return { f, a };
    if (f.archived_at) throw new NotFound();
    if (a && f.visibility === 'published' && !f.entity) return { f, a };
    // published progress photos, approved listing photos, owner-visible maintenance photos (external.js decides)
    const grants = ctx.externalFile ? await ctx.externalFile(req.user, f, a) : null;
    if (!grants) throw new NotFound();
    return { f, a: { ws: a ? a.ws : null, internal: false, role: a ? a.role : null, grants } };
  }
  const INLINE = /^(image\/(jpeg|png|webp)|application\/pdf)$/;
  r.get('/files/:fid', async (req, res) => {
    const { f, a } = await fileAccess(req);
    const inline = INLINE.test(f.mime);
    if (!a.internal && !inline && !(a.grants && a.grants.download_files)) throw new Forbidden('Downloading this file has not been enabled for your account.');
    const data = (await pool.query('select data from files where id = $1', [f.id])).rows[0].data;
    res.set({ 'Content-Type': f.mime, 'Content-Length': data.length, 'Cache-Control': 'private, no-store',
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.original_name)}`,
      'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox" });
    res.end(data);
  });
  r.get('/files/:fid/thumb', async (req, res) => {
    const { f } = await fileAccess(req);
    const t = (await pool.query('select thumb from files where id = $1', [f.id])).rows[0].thumb;
    if (!t) throw new NotFound();
    res.set({ 'Content-Type': 'image/webp', 'Cache-Control': 'private, max-age=300' });
    res.end(t);
  });
  r.post('/files/:fid/archive', async (req, res) => {
    const { f, a } = await fileAccess(req);
    if (!core.canEdit(a)) throw new Forbidden();
    await core.inTx(async db => {
      await db.query('update files set archived_at = now() where id = $1 and archived_at is null', [f.id]);
      await core.audit(db, { actor: req.user, workspaceId: f.workspace_id, action: 'file.archived', entity: 'file', entityId: f.id, summary: `Archived ${f.original_name}`, ip: req.ip });
    });
    res.redirect(`/w/${f.workspace_id}/documents?msg=archived`);
  });

  // ---------- access ----------
  r.get('/w/:id/access', async (req, res) => {
    const a = await access(req, req.params.id);
    if (!a.internal) throw new NotFound();
    const w = a.ws;
    const members = (await pool.query(
      `select m.*, u.email, u.name, u.kind, u.active, u.phone, u.job_title, coalesce(nullif(b.name,''), b.email) as by,
              (select extract(epoch from p.updated_at)::bigint from user_photos p where p.user_id = u.id) as photo_v
         from workspace_members m join users u on u.id = m.user_id left join users b on b.id = m.added_by
        where m.workspace_id = $1 order by m.revoked_at nulls first, u.kind, u.name`, [w.id])).rows;
    const manage = core.canManageAccess(req.user, a);
    const candidates = manage ? (await pool.query(
      `select id, kind, coalesce(nullif(name,''), email) as label, email from users u
        where active and not exists (select 1 from workspace_members m where m.workspace_id = $1 and m.user_id = u.id and m.revoked_at is null) order by kind, 3`, [w.id])).rows : [];
    const roleLabel = r => INTERNAL_MEMBER_ROLES[r] || EXTERNAL_MEMBER_ROLES[r] || r;
    const invitePanels = ctx.accessExtras ? await ctx.accessExtras(req, a, manage, members) : '';
    res.send(wsLayout(req, a, 'access', html`
      <section class="panel"><h2 class="h">People with access</h2>
        <div class="table-wrap"><table><thead><tr><th>Person</th><th>Type</th><th>Workspace role</th><th>Added</th><th></th></tr></thead><tbody>
        ${members.map(m => html`<tr class="${m.revoked_at ? 'dim' : ''}"><td><div class="person">${avatar({ id: m.user_id, name: m.name, email: m.email, photo_v: m.photo_v })}<div><b>${m.name || m.email}</b><div class="muted small">${m.email}${m.phone ? ` · ${m.phone}` : ''}${m.job_title ? ` · ${m.job_title}` : ''}</div></div></div></td>
          <td>${m.kind === 'external' ? 'External' : 'Staff'}</td><td>${roleLabel(m.role)}${m.revoked_at ? html` ${pill('Removed', 'muted')}` : !m.active ? html` ${pill('Deactivated', 'muted')}` : ''}${m.kind === 'external' && !m.revoked_at && ctx.grantSummary ? html`<div class="muted small">${ctx.grantSummary(m.grants)}</div>` : ''}</td>
          <td class="small">${fmtDate(m.added_at)}${m.by ? ` by ${m.by}` : ''}</td>
          <td>${manage && !m.revoked_at && m.user_id !== req.user.id ? html`<form method="post" action="/w/${w.id}/access/revoke">${csrfField(req)}<input type="hidden" name="user" value="${m.user_id}"><button class="btn small" type="submit">Remove</button></form>` : ''}</td></tr>`)}
        </tbody></table></div>
        <p class="muted small">Super Admins can open every workspace. Everyone else sees only workspaces they are added to. Removing access takes effect on the person's next page load. Files they already downloaded cannot be recalled.</p>
      </section>
      ${invitePanels}
      ${manage ? html`<section class="panel"><h2 class="h">Add a person</h2>
        <form method="post" action="/w/${w.id}/access" class="form-grid">${csrfField(req)}
          ${field({ name: 'user', label: 'Person', required: true, options: [['', 'Choose…'], ...candidates.map(c => [c.id, `${c.label}${c.kind === 'external' ? ' (external)' : ''}`])] })}
          ${field({ name: 'role', label: 'Role in this workspace', options: [...Object.entries(INTERNAL_MEMBER_ROLES), ...Object.entries(EXTERNAL_MEMBER_ROLES).filter(([k]) => k !== 'tenant')], value: 'viewer' })}
          <label class="field full check"><input type="checkbox" name="download_files" value="1"> <span>External viewers may download non-image files</span></label>
          <div class="full actions"><button class="btn primary" type="submit">Add</button></div>
          <p class="muted small full">External viewers are always view-only and see only items marked “Published”.</p>
        </form></section>` : ''}
      ${core.isSuper(req.user) ? html`<section class="panel"><h2 class="h">Create a new login and add to this ${SECTIONS[w.section].noun}</h2>
        <form method="post" action="/w/${w.id}/access/new" class="form-grid">${csrfField(req)}
          ${ctx.userFormFields(await ctx.staffRoles())}
          <label class="field" for="f-ws_role"><span>Role in this ${SECTIONS[w.section].noun} <i class="req">*</i></span><select id="f-ws_role" name="ws_role" required>
            <optgroup label="SarayDar staff">${Object.entries(INTERNAL_MEMBER_ROLES).map(([k, l]) => html`<option value="${k}" ${k === 'viewer' ? raw('selected') : ''}>${l}</option>`)}</optgroup>
            <optgroup label="External viewers (view only)">${Object.entries(EXTERNAL_MEMBER_ROLES).filter(([k]) => k !== 'tenant').map(([k, l]) => html`<option value="${k}">${l}</option>`)}</optgroup></select></label>
          <label class="field check full"><input type="checkbox" name="download_files" value="1"> <span>External viewer may download non-image files</span></label>
          <div class="full actions"><button class="btn primary" type="submit">Create login and add</button></div>
          <p class="muted small full">The login details are shown once on the next screen so you can pass them on. The person must choose their own password at first sign-in.</p>
        </form></section>` : ''}`));
  });

  r.post('/w/:id/access', async (req, res) => {
    const a = await access(req, req.params.id);
    if (!core.canManageAccess(req.user, a)) throw new Forbidden();
    const uid = String(req.body.user || '');
    if (!UUID.test(uid)) throw Object.assign(new Error('Choose a person.'), { status: 400 });
    const target = (await pool.query('select id, kind, email, name from users where id = $1 and active', [uid])).rows[0];
    if (!target) throw Object.assign(new Error('That person was not found.'), { status: 400 });
    const role = String(req.body.role || '');
    const ok = target.kind === 'external' ? role in EXTERNAL_MEMBER_ROLES : role in INTERNAL_MEMBER_ROLES;
    if (!ok) throw Object.assign(new Error(target.kind === 'external' ? 'External people can only get a viewer role.' : 'Staff need a staff role.'), { status: 400 });
    const grants = target.kind === 'external' && req.body.download_files ? { download_files: true } : {};
    await core.inTx(async db => {
      await db.query(`insert into workspace_members (workspace_id, user_id, role, grants, added_by) values ($1,$2,$3,$4,$5)
        on conflict (workspace_id, user_id) do update set role = excluded.role, grants = excluded.grants, added_by = excluded.added_by, added_at = now(), revoked_at = null`,
        [a.ws.id, uid, role, grants, req.user.id]);
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'access.granted', entity: 'user', entityId: uid, summary: `Gave ${target.name || target.email} ${INTERNAL_MEMBER_ROLES[role] || EXTERNAL_MEMBER_ROLES[role]} access`, after: { role, grants }, ip: req.ip });
    });
    res.redirect(`/w/${a.ws.id}/access?msg=added`);
  });

  r.post('/w/:id/access/revoke', async (req, res) => {
    const a = await access(req, req.params.id);
    if (!core.canManageAccess(req.user, a)) throw new Forbidden();
    const uid = String(req.body.user || '');
    if (!UUID.test(uid) || uid === req.user.id) throw Object.assign(new Error('You cannot remove yourself.'), { status: 400 });
    await core.inTx(async db => {
      const m = (await db.query('update workspace_members set revoked_at = now() where workspace_id = $1 and user_id = $2 and revoked_at is null returning role', [a.ws.id, uid])).rows[0];
      if (m) await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'access.revoked', entity: 'user', entityId: uid, summary: 'Removed access', before: { role: m.role }, ip: req.ip });
    });
    res.redirect(`/w/${a.ws.id}/access?msg=revoked`);
  });

  // ---------- activity ----------
  r.get('/w/:id/activity', async (req, res) => {
    const a = await access(req, req.params.id);
    if (!a.internal) throw new NotFound();
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const total = (await pool.query('select count(*)::int as n from audit_events where workspace_id = $1', [a.ws.id])).rows[0].n;
    const rows = (await pool.query(`select * from audit_events where workspace_id = $1 order by id desc limit ${req.exportAll ? 5000 : PER_PAGE} offset ${req.exportAll ? 0 : (page - 1) * PER_PAGE}`, [a.ws.id])).rows;
    res.send(wsLayout(req, a, 'activity', html`<section class="panel"><h2 class="h">Activity</h2>
      ${rows.length ? html`<ol class="feed">${rows.map(e => html`<li><b>${e.summary || e.action}</b><div class="muted small">${e.actor_label} · ${fmtDateTime(e.at)} · <span class="mono">${e.action}</span></div></li>`)}</ol>${pager(req, total, page, PER_PAGE)}`
        : html`<p class="muted">No activity recorded yet.</p>`}</section>`));
  });
}

module.exports = { mountWorkspaces, sniff };
