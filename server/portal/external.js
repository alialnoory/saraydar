'use strict';
// View-only external portal (spec 5.6): client, owner, investor, seller and buyer viewers.
// Everything here is read from the database through queries that select published fields only. No route in
// this file changes a business record. Staff managers can preview exactly what a viewer role would see.
const { SECTIONS, SECTION_KEYS, KIND_LABEL, EXTERNAL_MEMBER_ROLES } = require('./core');
const { layout, html, raw, pill, statusPill, emptyState, fmtDate, fmtDateTime, fmtSize } = require('./views');
const { formatMoney } = require('../lib/money');
const { periodOf, periodForm } = require('./owner');
const { VIEWER_ROLES, ROLES_FOR, GRANTS, grantSummary } = require('./invitations');

const UUID = /^[0-9a-f-]{36}$/i;
const fm = (m, c = 'BHD') => m === null || m === undefined ? '—' : formatMoney(Number(m), c);
const human = s => s ? String(s).replace(/_/g, ' ').replace(/^./, c => c.toUpperCase()) : '—';
const TASK = { not_started: 'Not started', in_progress: 'In progress', blocked: 'Delayed', done: 'Done', cancelled: 'Cancelled' };
const UNIT = { available: 'Available', reserved: 'Reserved', occupied: 'Occupied', maintenance: 'Under maintenance', unavailable: 'Unavailable' };
const MAINT = { open: 'Reported', assigned: 'Assigned', approved: 'Approved', in_progress: 'In progress', completed: 'Completed', verified: 'Completed and checked', closed: 'Closed', cancelled: 'Cancelled', rejected: 'Not going ahead' };
const VIEW = { tentative: 'Tentative', confirmed: 'Confirmed', completed: 'Completed', cancelled: 'Cancelled', rescheduled: 'Rescheduled', no_show: 'Did not take place' };
const OFFER = { draft: 'Being prepared', submitted: 'Submitted', countered: 'Countered', accepted: 'Accepted', rejected: 'Rejected', expired: 'Expired', withdrawn: 'Withdrawn' };
const LISTING = { draft: 'Being prepared', awaiting_verification: 'Being prepared', ready: 'Ready for marketing', available: 'Available', under_offer: 'Under offer', reserved: 'Reserved', sold: 'Sold', withdrawn: 'Withdrawn', archived: 'Closed' };

function mountExternal(r, ctx) {
  const { pool, core, NotFound } = ctx;

  // The viewer for /p/:id — a real external member, or a staff manager previewing a role.
  async function viewer(req) {
    const a = await core.workspaceAccess(req.user, req.params.id);
    if (!a) throw new NotFound();
    const w = a.ws;
    if (a.internal) {
      if (!core.canManageAccess(req.user, a)) throw new NotFound();
      const roles = ROLES_FOR[w.kind] || VIEWER_ROLES;
      const role = roles.includes(req.query.preview) ? req.query.preview : roles[0];
      const grants = Object.fromEntries(Object.keys(GRANTS).filter(k => req.query[`g_${k}`] === '1').map(k => [k, true]));
      if (UUID.test(String(req.query.party || ''))) grants.party_id = req.query.party;
      const qs = new URLSearchParams({ preview: role, ...Object.fromEntries(Object.keys(grants).filter(k => k !== 'party_id').map(k => [`g_${k}`, '1'])), ...(grants.party_id ? { party: grants.party_id } : {}) });
      return { ws: w, role, grants, preview: true, qs: `?${qs}` };
    }
    return { ws: w, role: a.role, grants: a.grants || {}, preview: false, qs: '' };
  }

  function tabsOf(v) {
    const k = v.ws.kind, g = v.grants;
    const t = [['overview', 'Overview']];
    if (k === 'project' || k === 'client_project') t.push(['progress', 'Progress & Photos'], ['schedule', 'Phases & Milestones']);
    if (k === 'client_project') t.push(['approvals', 'Approvals']);
    if (k === 'property') t.push(['units', 'Units'], ['maintenance', 'Maintenance']);
    if (k === 'listing') t.push(['activity', 'Marketing & Viewings']);
    if (k === 'request') t.push(['shortlist', 'Shortlist'], ['viewings', 'Viewings']);
    if ((k === 'listing' || k === 'request') && g.offers) t.push(['offers', 'Offers & Deal']);
    if (g.financials) t.push(['statement', v.role === 'investor_viewer' ? 'My Investment' : k === 'property' ? 'Owner Statement' : k === 'client_project' ? 'Statement' : 'Fees']);
    t.push(['documents', 'Documents']);
    return t;
  }

  function page(req, v, tab, body) {
    const w = v.ws, tabs = tabsOf(v);
    req.canExport = v.preview || !!v.grants.export;
    return layout(req, { title: `${w.name} · ${tabs.find(t => t[0] === tab)[1]}`, heading: w.name,
      tabs: tabs.map(([k, l]) => [l, `/p/${w.id}${k === 'overview' ? '' : `/${k}`}${v.qs}`, k === tab]),
      crumbs: v.preview ? [['Home', '/'], [w.name, `/w/${w.id}`], ['Access & Invitations', `/w/${w.id}/access`], ['Preview']] : [['My Workspaces', '/my'], [w.name]],
      sub: { above: `${w.ref} · ${KIND_LABEL[w.kind]} · View only`, below: w.location || '', badge: statusPill(w.status) },
      body: html`${v.preview ? html`<div class="notice info preview-note"><b>Preview as ${EXTERNAL_MEMBER_ROLES[v.role]}.</b> This is exactly what an external viewer with these settings sees (${grantSummary(v.grants)}).
        ${(ROLES_FOR[w.kind] || []).length > 1 ? html` Preview as ${(ROLES_FOR[w.kind]).filter(x => x !== v.role).map(x => html`<a href="/p/${w.id}?preview=${x}">${EXTERNAL_MEMBER_ROLES[x]}</a>`)}.` : ''} <a href="/w/${w.id}/access">Back to Access & Invitations</a></div>` : ''}${body}` });
  }

  // ---------- shared queries (published data only) ----------
  const publishedUpdates = (wsId, limit = 50) => pool.query(
    `select u.id, u.title, u.observed_on, u.completed_work, u.remaining_work, u.reported_progress, u.published_at, ph.name as phase_name,
            (select array_agg(f.id order by f.uploaded_at) from files f where f.entity = 'progress_update' and f.entity_id = u.id::text and f.archived_at is null and f.thumb is not null) as photos,
            (select json_agg(json_build_object('id', f.id, 'name', f.original_name) order by f.uploaded_at) from files f where f.entity = 'progress_update' and f.entity_id = u.id::text and f.archived_at is null and f.thumb is null) as docs
       from progress_updates u left join phases ph on ph.id = u.phase_id
      where u.workspace_id = $1 and u.status = 'published' and u.external_visible and u.archived_at is null
      order by u.observed_on desc, u.published_at desc limit ${limit}`, [wsId]).then(x => x.rows);
  const publishedFiles = wsId => pool.query(
    `select id, original_name, mime, size, caption, location, observed_on, uploaded_at, thumb is not null as has_thumb
       from files where workspace_id = $1 and entity is null and visibility = 'published' and archived_at is null order by uploaded_at desc limit 200`, [wsId]).then(x => x.rows);
  const listingPhotos = wsId => pool.query("select id, caption from files where workspace_id = $1 and entity = 'listing' and tag = 'published' and thumb is not null and archived_at is null order by uploaded_at limit 24", [wsId]).then(x => x.rows);
  const gallery = (ids, cls = '') => ids && ids.length ? html`<div class="gallery ${cls}">${ids.map(f => html`<a href="/files/${f.id || f}"><img src="/files/${f.id || f}/thumb" alt="${f.caption || 'Photo'}" loading="lazy"></a>`)}</div>` : '';
  const kv = rows => html`<dl class="details">${rows.filter(x => x && x[1] !== null && x[1] !== undefined && x[1] !== '').map(([k, v]) => html`<div><dt>${k}</dt><dd>${v}</dd></div>`)}</dl>`;
  const partyOf = v => v.grants.party_id || v.ws.party_id || null;

  // ---------- tabs ----------
  const T = {};

  T.overview = async (req, v) => {
    const w = v.ws;
    if (w.kind === 'project' || w.kind === 'client_project') {
      const ups = await publishedUpdates(w.id, 6);
      const latest = ups[0];
      const imgs = (await publishedFiles(w.id)).filter(f => f.has_thumb).slice(0, 4).map(f => f.id);
      const photos = [...ups.flatMap(u => u.photos || []), ...imgs].slice(0, 12);
      const ms = (await pool.query(`select t.title, t.due_date, t.status, t.actual_finish from tasks t where t.workspace_id = $1 and t.is_milestone and t.archived_at is null
          and exists (select 1 from plans p where p.workspace_id = t.workspace_id and p.status = 'approved') order by t.due_date nulls last limit 4`, [w.id])).rows;
      return html`
        <section class="grid-cards">
          <div class="card"><div class="muted small">Latest reported progress</div><div class="big">${latest && latest.reported_progress !== null ? `${latest.reported_progress}%` : '—'}</div><div class="muted small">${latest ? `As reported on ${fmtDate(latest.observed_on)}` : 'No published update yet'}</div></div>
          <div class="card"><div class="muted small">Published updates</div><div class="big">${ups.length}${ups.length === 6 ? '+' : ''}</div><div class="muted small">${w.stage ? `Stage: ${w.stage}` : ''}</div></div>
          <div class="card"><div class="muted small">Next milestone</div><div class="mid">${(ms.find(m => m.status !== 'done') || {}).title || '—'}</div><div class="muted small">${(ms.find(m => m.status !== 'done') || {}).due_date ? `Planned ${fmtDate(ms.find(m => m.status !== 'done').due_date)}` : ''}</div></div>
        </section>
        ${latest ? html`<section class="panel"><h2 class="h">Latest update · ${latest.title}</h2><p class="muted small">${fmtDate(latest.observed_on)}${latest.phase_name ? ` · ${latest.phase_name}` : ''}</p>
          ${latest.completed_work ? html`<p class="pre-line">${latest.completed_work}</p>` : ''}${gallery(latest.photos)}<a class="btn" href="/p/${w.id}/progress${v.qs}">All updates</a></section>` : ''}
        ${photos.length ? html`<section class="panel"><h2 class="h">Recent photos</h2>${gallery(photos, 'big-gallery')}</section>` : ''}
        ${!latest && !photos.length ? emptyState('Nothing published yet', 'SarayDar will publish progress updates and photos here.') : ''}`;
    }
    if (w.kind === 'property') {
      const units = (await pool.query('select status, count(*)::int as n from units where workspace_id = $1 and archived_at is null group by status', [w.id])).rows;
      const total = units.reduce((s, u) => s + u.n, 0);
      const imgs = (await publishedFiles(w.id)).filter(f => f.has_thumb).slice(0, 12);
      const open = (await pool.query("select count(*)::int as n from maint_requests where workspace_id = $1 and owner_visible and status not in ('verified','closed','cancelled','rejected')", [w.id])).rows[0].n;
      return html`<section class="grid-cards">
          <div class="card"><div class="muted small">Units</div><div class="big">${total}</div><div class="muted small">${units.map(u => `${UNIT[u.status] || human(u.status)} ${u.n}`).join(' · ')}</div></div>
          <div class="card"><div class="muted small">Open maintenance shared with you</div><div class="big">${open}</div></div>
        </section>
        ${imgs.length ? html`<section class="panel"><h2 class="h">Photos</h2>${gallery(imgs, 'big-gallery')}</section>` : ''}`;
    }
    if (w.kind === 'listing') {
      const l = (await pool.query('select * from listings where workspace_id = $1', [w.id])).rows[0] || {};
      const photos = await listingPhotos(w.id);
      return html`${photos.length ? html`<section class="panel">${gallery(photos, 'big-gallery')}</section>` : ''}
        <section class="panel"><h2 class="h">Listing</h2>${kv([
          ['Status', LISTING[l.status] || human(l.status)], ['Property type', [l.property_type, l.category].filter(Boolean).join(' · ')], ['Location', l.location],
          ['Asking price', l.asking_minor ? fm(l.asking_minor, l.currency) : null], ['Land area', l.land_area_m2 ? `${Number(l.land_area_m2)} m²` : null], ['Built-up area', l.built_area_m2 ? `${Number(l.built_area_m2)} m²` : null],
          ['Bedrooms / bathrooms', l.bedrooms || l.bathrooms ? `${l.bedrooms ?? '—'} / ${l.bathrooms ?? '—'}` : null], ['Condition', l.condition], ['Features', l.features]])}
          ${l.description ? html`<p class="pre-line">${l.description}</p>` : ''}</section>`;
    }
    if (w.kind === 'request') {
      const b = (await pool.query('select * from request_briefs where workspace_id = $1 order by version desc limit 1', [w.id])).rows[0];
      const st = (await pool.query('select status from acq_requests where workspace_id = $1', [w.id])).rows[0];
      const n = (await pool.query("select count(*)::int as n from shortlist_items where workspace_id = $1 and published and status <> 'withdrawn'", [w.id])).rows[0].n;
      return html`<section class="grid-cards"><div class="card"><div class="muted small">Search status</div><div class="mid">${st ? human(st.status) : '—'}</div></div>
          <div class="card"><div class="muted small">Properties shared with you</div><div class="big">${n}</div><a href="/p/${w.id}/shortlist${v.qs}">Open the shortlist</a></div></section>
        <section class="panel"><h2 class="h">Your search criteria${b ? ` · version ${b.version}` : ''}</h2>${b ? kv([
          ['Purpose', b.purpose], ['Property types', b.types], ['Locations', b.locations],
          ['Budget', b.budget_min_minor || b.budget_max_minor ? `${b.budget_min_minor ? fm(b.budget_min_minor, b.currency) : '—'} to ${b.budget_max_minor ? fm(b.budget_max_minor, b.currency) : '—'}` : null],
          ['Land area', b.land_min_m2 || b.land_max_m2 ? `${b.land_min_m2 ?? '—'} – ${b.land_max_m2 ?? '—'} m²` : null], ['Built-up area', b.built_min_m2 || b.built_max_m2 ? `${b.built_min_m2 ?? '—'} – ${b.built_max_m2 ?? '—'} m²` : null],
          ['Bedrooms (minimum)', b.bedrooms_min], ['Features', b.features], ['Condition', b.condition], ['Timing', b.timing]]) : html`<p class="muted">Not recorded yet.</p>`}
          <p class="muted small">To change your criteria, contact your SarayDar agent. Changes are recorded by staff.</p></section>`;
    }
    return '';
  };

  T.progress = async (req, v) => {
    const ups = await publishedUpdates(v.ws.id);
    return ups.length ? ups.map(u => html`<section class="panel"><h2 class="h">${u.title}</h2>
        <p class="muted small">${fmtDate(u.observed_on)}${u.phase_name ? ` · ${u.phase_name}` : ''}${u.reported_progress !== null ? ` · ${u.reported_progress}% reported` : ''}</p>
        ${u.completed_work ? html`<h3 class="h3">Work completed</h3><p class="pre-line">${u.completed_work}</p>` : ''}
        ${u.remaining_work ? html`<h3 class="h3">Next</h3><p class="pre-line">${u.remaining_work}</p>` : ''}
        ${gallery(u.photos, 'big-gallery')}
        ${u.docs && u.docs.length ? html`<ul class="rows">${u.docs.map(d => html`<li><a href="/files/${d.id}">${d.name}</a></li>`)}</ul>` : ''}</section>`)
      : emptyState('No published updates yet', 'Progress updates appear here once SarayDar publishes them.');
  };

  T.schedule = async (req, v) => {
    const approved = (await pool.query("select approved_at from plans where workspace_id = $1 and status = 'approved' order by version desc limit 1", [v.ws.id])).rows[0];
    if (!approved) return emptyState('The schedule is not published yet', 'Phases and milestones appear here once the project plan is approved.');
    const phases = (await pool.query('select id, name from phases where workspace_id = $1 and archived_at is null order by sort', [v.ws.id])).rows;
    const ms = (await pool.query('select phase_id, title, start_date, due_date, actual_finish, status from tasks where workspace_id = $1 and archived_at is null and parent_id is null and (is_milestone or phase_id is not null) order by sort, due_date', [v.ws.id])).rows;
    const ph = (await pool.query(`select phase_id, count(*)::int as n, count(*) filter (where status = 'done')::int as done, min(start_date) as s, max(due_date) as e
        from tasks where workspace_id = $1 and archived_at is null and status <> 'cancelled' group by phase_id`, [v.ws.id])).rows;
    const by = Object.fromEntries(ph.map(x => [x.phase_id, x]));
    return html`<section class="panel"><h2 class="h">Phases</h2><div class="table-wrap"><table><thead><tr><th>Phase</th><th>Planned</th><th class="n">Activities done</th></tr></thead><tbody>
        ${phases.map(p => { const x = by[p.id] || { n: 0, done: 0 }; return html`<tr><td>${p.name}</td><td class="small">${x.s ? `${fmtDate(x.s)} – ${fmtDate(x.e)}` : '—'}</td><td class="n">${x.done} of ${x.n}</td></tr>`; })}</tbody></table></div>
        <p class="muted small">From the approved plan of ${fmtDate(approved.approved_at)}. Dates are planned dates and may change.</p></section>
      <section class="panel"><h2 class="h">Milestones</h2>${ms.filter(m => m.status !== 'cancelled').length ? html`<div class="table-wrap"><table><thead><tr><th>Milestone / activity</th><th>Planned finish</th><th>Status</th></tr></thead><tbody>
        ${ms.filter(m => m.status !== 'cancelled').map(m => html`<tr><td>${m.title}</td><td class="small">${fmtDate(m.due_date) || '—'}</td><td>${TASK[m.status] || human(m.status)}${m.actual_finish ? html` <span class="muted small">${fmtDate(m.actual_finish)}</span>` : ''}</td></tr>`)}</tbody></table></div>` : html`<p class="muted">None recorded.</p>`}</section>`;
  };

  T.approvals = async (req, v) => {
    const rows = (await pool.query('select subject, title, linked_ref, requested_on, status, decided_on, approver_name from client_approvals where workspace_id = $1 and client_visible order by requested_on desc', [v.ws.id])).rows;
    return html`<section class="panel"><h2 class="h">Approvals</h2>${rows.length ? html`<div class="table-wrap"><table><thead><tr><th>Subject</th><th>Requested</th><th>Status</th><th>Decided</th></tr></thead><tbody>
      ${rows.map(x => html`<tr><td><b>${x.title}</b><div class="muted small">${human(x.subject)}${x.linked_ref ? ` · ${x.linked_ref}` : ''}</div></td><td class="small">${fmtDate(x.requested_on)}</td><td>${human(x.status)}</td><td class="small">${x.decided_on ? `${fmtDate(x.decided_on)}${x.approver_name ? ` · ${x.approver_name}` : ''}` : '—'}</td></tr>`)}</tbody></table></div>` : html`<p class="muted">No approvals shared yet.</p>`}
      <p class="muted small">This portal is view-only. Approvals are given to SarayDar directly and recorded by staff with their evidence.</p></section>`;
  };

  T.units = async (req, v) => {
    const rows = (await pool.query('select ref, floor, unit_type, area_m2, bedrooms, status from units where workspace_id = $1 and archived_at is null order by sort, ref', [v.ws.id])).rows;
    return html`<section class="panel"><h2 class="h">Units</h2>${rows.length ? html`<div class="table-wrap"><table><thead><tr><th>Unit</th><th>Type</th><th>Floor</th><th class="n">Area</th><th class="n">Bedrooms</th><th>Status</th></tr></thead><tbody>
      ${rows.map(u => html`<tr><td>${u.ref}</td><td>${u.unit_type || '—'}</td><td>${u.floor || '—'}</td><td class="n">${u.area_m2 ? `${Number(u.area_m2)} m²` : '—'}</td><td class="n">${u.bedrooms ?? '—'}</td><td>${UNIT[u.status] || human(u.status)}</td></tr>`)}</tbody></table></div>` : html`<p class="muted">No units recorded.</p>`}
      <p class="muted small">Tenant details are kept by SarayDar and are not shown here.</p></section>`;
  };

  T.maintenance = async (req, v) => {
    const rows = (await pool.query(`select m.id, m.ref, m.title, m.category, m.reported_on, m.status, m.completed_on, u.ref as unit_ref,
        (select array_agg(f.id order by f.uploaded_at) from files f where f.entity = 'maint_request' and f.entity_id = m.id::text and f.archived_at is null and f.thumb is not null) as photos
        from maint_requests m left join units u on u.id = m.unit_id where m.workspace_id = $1 and m.owner_visible order by m.reported_on desc limit 200`, [v.ws.id])).rows;
    return html`<section class="panel"><h2 class="h">Maintenance</h2>${rows.length ? html`<ul class="rows">${rows.map(m => html`<li><div class="grow"><b>${m.ref} · ${m.title}</b>
        <div class="muted small">${m.unit_ref ? `Unit ${m.unit_ref}` : 'Common area'} · ${m.category} · reported ${fmtDate(m.reported_on)}${m.completed_on ? ` · completed ${fmtDate(m.completed_on)}` : ''}</div>${gallery(m.photos)}</div>${pill(MAINT[m.status] || human(m.status), ['verified', 'closed', 'completed'].includes(m.status) ? 'ok' : 'warn')}</li>`)}</ul>`
      : html`<p class="muted">No maintenance has been shared with you.</p>`}</section>`;
  };

  T.activity = async (req, v) => {
    const mk = (await pool.query("select channel, url, status, published_on, ended_on, results from marketing_activities where workspace_id = $1 and status in ('published','ended') order by published_on desc", [v.ws.id])).rows;
    const vw = (await pool.query("select starts_at, status, attended, owner_summary from viewings where listing_ws = $1 and status <> 'tentative' order by starts_at desc limit 200", [v.ws.id])).rows;
    return html`<section class="panel"><h2 class="h">Marketing</h2>${mk.length ? html`<div class="table-wrap"><table><thead><tr><th>Channel</th><th>Published</th><th>Status</th><th>Results</th></tr></thead><tbody>
        ${mk.map(m => html`<tr><td>${m.url && /^https?:\/\//.test(m.url) ? html`<a href="${m.url}" rel="noopener noreferrer" target="_blank">${m.channel}</a>` : m.channel}</td><td class="small">${fmtDate(m.published_on)}${m.ended_on ? ` – ${fmtDate(m.ended_on)}` : ''}</td><td>${human(m.status)}</td><td class="small">${m.results || '—'}</td></tr>`)}</tbody></table></div>` : html`<p class="muted">No published marketing yet.</p>`}</section>
      <section class="panel"><h2 class="h">Viewings</h2>${vw.length ? html`<ul class="rows">${vw.map(x => html`<li><div class="grow"><b>${fmtDateTime(x.starts_at)}</b>${x.owner_summary ? html`<div class="small pre-line">${x.owner_summary}</div>` : ''}</div>${pill(VIEW[x.status] || human(x.status), x.status === 'completed' ? 'ok' : 'muted')}</li>`)}</ul>` : html`<p class="muted">No viewings yet.</p>`}
        <p class="muted small">Viewing summaries are written by SarayDar. Buyers’ identities and contact details are not shared.</p></section>`;
  };

  T.shortlist = async (req, v) => {
    const rows = (await pool.query(`select s.id, s.rank, s.reason, s.status, s.rechecked_on, s.rechecked_price_minor, s.listing_ws, s.client_feedback,
        l.property_type, l.location, l.land_area_m2, l.built_area_m2, l.bedrooms, l.bathrooms, l.features, l.description, l.asking_minor, l.currency, lw.name as listing_name,
        e.title as ext_title, e.property_type as ext_type, e.location as ext_location, e.price_minor as ext_price, e.currency as ext_currency, e.land_area_m2 as ext_land, e.built_area_m2 as ext_built, e.bedrooms as ext_beds
       from shortlist_items s left join listings l on l.workspace_id = s.listing_ws left join workspaces lw on lw.id = s.listing_ws left join external_opps e on e.id = s.external_id
      where s.workspace_id = $1 and s.published and s.status <> 'withdrawn' order by s.rank, s.published_at`, [v.ws.id])).rows;
    if (!rows.length) return emptyState('No properties shared yet', 'Your SarayDar agent will share suitable properties here.');
    const out = [];
    for (const x of rows) {
      const photos = x.listing_ws ? await listingPhotos(x.listing_ws) : [];
      const own = !!x.listing_ws;
      out.push(html`<section class="panel"><h2 class="h">${own ? x.listing_name : x.ext_title}</h2>
        ${gallery(photos)}
        ${kv([['Type', own ? x.property_type : x.ext_type], ['Location', own ? x.location : x.ext_location],
          ['Price', x.rechecked_price_minor ? `${fm(x.rechecked_price_minor, own ? x.currency : x.ext_currency)} (checked ${fmtDate(x.rechecked_on)})` : own ? (x.asking_minor ? fm(x.asking_minor, x.currency) : null) : (x.ext_price ? fm(x.ext_price, x.ext_currency) : null)],
          ['Land area', (own ? x.land_area_m2 : x.ext_land) ? `${Number(own ? x.land_area_m2 : x.ext_land)} m²` : null], ['Built-up area', (own ? x.built_area_m2 : x.ext_built) ? `${Number(own ? x.built_area_m2 : x.ext_built)} m²` : null],
          ['Bedrooms', own ? x.bedrooms : x.ext_beds], ['Features', own ? x.features : null], ['Why it was shortlisted', x.reason], ['Your feedback (as recorded)', x.client_feedback], ['Status', human(x.status)]])}
        ${own && x.description ? html`<p class="pre-line small">${x.description}</p>` : ''}</section>`);
    }
    return out;
  };

  T.viewings = async (req, v) => {
    const rows = (await pool.query(`select x.starts_at, x.status, coalesce(lw.name, e.title) as property from viewings x left join workspaces lw on lw.id = x.listing_ws left join external_opps e on e.id = x.external_id
      where x.request_ws = $1 and x.status <> 'tentative' order by x.starts_at desc`, [v.ws.id])).rows;
    return html`<section class="panel"><h2 class="h">Viewings</h2>${rows.length ? html`<ul class="rows">${rows.map(x => html`<li><div class="grow"><b>${x.property}</b><div class="muted small">${fmtDateTime(x.starts_at)}</div></div>${pill(VIEW[x.status] || human(x.status), x.status === 'completed' ? 'ok' : 'muted')}</li>`)}</ul>` : html`<p class="muted">No viewings arranged yet.</p>`}</section>`;
  };

  T.offers = async (req, v) => {
    const col = v.ws.kind === 'listing' ? 'listing_ws' : 'request_ws';
    const offers = (await pool.query(`select o.id, o.ref, o.status, v.price_minor, v.currency, v.by_side, v.valid_until, v.decision, v.decided_on, v.version
        from offers o left join lateral (select * from offer_versions x where x.offer_id = o.id order by x.version desc limit 1) v on true
       where o.${col} = $1 and o.status <> 'draft' order by o.created_at`, [v.ws.id])).rows;
    const deals = (await pool.query(`select d.workspace_id, d.status, d.accepted_minor, d.currency, d.reserved_until, d.completed_on, d.fell_through_on from deals d where d.${col} = $1 order by d.created_at desc`, [v.ws.id])).rows;
    const out = [html`<section class="panel"><h2 class="h">Offers</h2>${offers.length ? html`<div class="table-wrap"><table><thead><tr><th>Offer</th><th class="n">Latest amount</th><th>Latest from</th><th>Status</th><th>Valid until</th></tr></thead><tbody>
      ${offers.map((o, i) => html`<tr><td>${v.ws.kind === 'listing' ? `Offer ${i + 1}` : o.ref}</td><td class="n">${fm(o.price_minor, o.currency)}</td><td>${o.by_side === 'buyer' ? 'Buyer' : o.by_side === 'seller' ? 'Seller' : human(o.by_side)}</td><td>${OFFER[o.status] || human(o.status)}</td><td class="small">${fmtDate(o.valid_until) || '—'}</td></tr>`)}</tbody></table></div>` : html`<p class="muted">No offers yet.</p>`}
      <p class="muted small">Decisions are given to SarayDar directly and recorded by staff. An accepted offer is not yet a completed sale.</p></section>`];
    for (const d of deals) {
      const cl = (await pool.query('select title, due_on, status, done_on from deal_checklist where workspace_id = $1 order by sort', [d.workspace_id])).rows;
      out.push(html`<section class="panel"><h2 class="h">Transaction progress</h2>${kv([['Status', human(d.status)], ['Agreed price', d.accepted_minor ? fm(d.accepted_minor, d.currency) : null], ['Reserved until', fmtDate(d.reserved_until)], ['Completed', fmtDate(d.completed_on)]])}
        ${cl.length ? html`<ul class="rows">${cl.map(c => html`<li><div class="grow">${c.title}<div class="muted small">${c.done_on ? `Done ${fmtDate(c.done_on)}` : c.due_on ? `Due ${fmtDate(c.due_on)}` : ''}</div></div>${pill(human(c.status), c.status === 'done' ? 'ok' : 'muted')}</li>`)}</ul>` : ''}</section>`);
    }
    return out;
  };

  T.statement = async (req, v) => {
    const w = v.ws;
    if (v.role === 'investor_viewer') {
      if (!ctx.investorStatement || !v.grants.party_id) return emptyState('No statement available', 'SarayDar has not linked your investor record to this project yet.');
      return ctx.investorStatement(req, w, v.grants.party_id, { external: true, qs: v.qs });
    }
    if (w.kind === 'property' && ctx.ownerAccount) {
      const per = periodOf(req.query);
      const acc = await ctx.ownerAccount(w.id, per.from, per.to);
      return html`${periodForm(per, v.preview ? raw(`<input type="hidden" name="preview" value="${v.role}">`) : '')}
        <section class="grid-cards"><div class="card"><div class="muted small">Funds held for you at ${fmtDate(per.to)}</div><div class="big">${fm(acc.closing)}</div></div>
          <div class="card"><div class="muted small">Available to transfer</div><div class="big">${fm(acc.available)}</div><div class="muted small">After approved unpaid expenses and the agreed reserve</div></div>
          <div class="card"><div class="muted small">Rent due but unpaid</div><div class="big">${fm(acc.arrears)}</div></div></section>
        <section class="panel"><h2 class="h">Owner statement · ${per.label}</h2><div class="table-wrap"><table><thead><tr><th>Date</th><th>Details</th><th class="n">In</th><th class="n">Out</th><th class="n">Balance</th></tr></thead><tbody>
          <tr><td></td><td><b>Opening balance</b></td><td></td><td></td><td class="n">${fm(acc.opening)}</td></tr>
          ${acc.rows.map(e => html`<tr><td class="small">${fmtDate(e.date)}</td><td class="small">${e.text}</td><td class="n">${e.amount > 0 ? fm(e.amount) : ''}</td><td class="n">${e.amount < 0 ? fm(-e.amount) : ''}</td><td class="n">${fm(e.balance)}</td></tr>`)}
          <tr class="total"><td></td><td>Closing balance</td><td></td><td></td><td class="n">${fm(acc.closing)}</td></tr></tbody></table></div>
          <p class="muted small">Transfers shown are recorded by SarayDar after the bank transfer is made.</p></section>`;
    }
    if (w.kind === 'client_project' && ctx.feeStatement) {
      const st = await ctx.feeStatement([w.id], null, null);
      return html`<section class="panel"><h2 class="h">Statement of SarayDar fees</h2><div class="table-wrap"><table><thead><tr><th>Date</th><th>Document</th><th>Details</th><th class="n">Debit</th><th class="n">Credit</th><th class="n">Balance</th></tr></thead><tbody>
        ${st.rows.map(e => html`<tr><td class="small">${fmtDate(e.date)}</td><td class="mono small">${e.doc}</td><td class="small">${e.text}</td><td class="n">${e.debit ? fm(e.debit) : ''}</td><td class="n">${e.credit ? fm(e.credit) : ''}</td><td class="n">${fm(e.balance)}</td></tr>`)}
        <tr class="total"><td></td><td></td><td>Balance</td><td class="n">${fm(st.debits)}</td><td class="n">${fm(st.credits)}</td><td class="n">${fm(st.closing)}</td></tr></tbody></table></div>
        <p class="muted small">Positive balance: amount due to SarayDar. Construction spending paid on your behalf is reported separately.</p></section>`;
    }
    // sales: this client's own fee invoices and receipts
    const party = partyOf(v);
    if (!party) return emptyState('No fee records', 'No fee records are linked to you for this case.');
    const inv = (await pool.query(`select i.number, i.issue_date, i.due_date, i.total_minor, i.currency, i.status,
        coalesce((select sum(amount_minor) from fee_credit_notes c where c.invoice_id = i.id),0) + coalesce((select sum(amount_minor) from fee_allocations x where x.invoice_id = i.id and x.status = 'active'),0) as settled
       from fee_invoices i where i.workspace_id = $1 and i.party_id = $2 and i.status in ('issued','void') and i.number is not null order by i.issue_date`, [w.id, party])).rows;
    const pay = (await pool.query("select receipt_no, received_on, amount_minor, currency, method, status from fee_payments where workspace_id = $1 and party_id = $2 and status in ('confirmed','reversed') order by received_on", [w.id, party])).rows;
    return html`<section class="panel"><h2 class="h">Your fee invoices</h2>${inv.length ? html`<div class="table-wrap"><table><thead><tr><th>Invoice</th><th>Date</th><th>Due</th><th class="n">Amount</th><th class="n">Outstanding</th><th>Status</th></tr></thead><tbody>
        ${inv.map(i => html`<tr><td class="mono">${i.number}</td><td class="small">${fmtDate(i.issue_date)}</td><td class="small">${fmtDate(i.due_date) || '—'}</td><td class="n">${fm(i.total_minor, i.currency)}</td><td class="n">${i.status === 'issued' ? fm(Number(i.total_minor) - Number(i.settled), i.currency) : '—'}</td><td>${i.status === 'void' ? 'Cancelled' : Number(i.total_minor) - Number(i.settled) <= 0 ? 'Paid' : 'Due'}</td></tr>`)}</tbody></table></div>` : html`<p class="muted">No invoices.</p>`}</section>
      <section class="panel"><h2 class="h">Your payments</h2>${pay.length ? html`<ul class="rows">${pay.map(p => html`<li><div class="grow"><b>${p.receipt_no || 'Payment'}</b><div class="muted small">${fmtDate(p.received_on)} · ${p.method}</div></div><b>${fm(p.amount_minor, p.currency)}</b>${p.status === 'reversed' ? pill('Reversed', 'muted') : ''}</li>`)}</ul>` : html`<p class="muted">No payments recorded.</p>`}</section>`;
  };

  T.documents = async (req, v) => {
    const rows = await publishedFiles(v.ws.id);
    const dl = v.preview || !!v.grants.download_files;
    const view = f => /^(image\/(jpeg|png|webp)|application\/pdf)$/.test(f.mime);
    return html`<section class="panel"><h2 class="h">Documents & photos</h2>${rows.length ? html`<ul class="files">${rows.map(f => html`<li>
        ${f.has_thumb ? html`<a href="/files/${f.id}" class="thumb"><img src="/files/${f.id}/thumb" alt="${f.caption || f.original_name}" loading="lazy" width="96" height="72"></a>` : html`<span class="thumb doc" aria-hidden="true">${(f.original_name.split('.').pop() || '').toUpperCase().slice(0, 4)}</span>`}
        <div class="grow">${view(f) || dl ? html`<a href="/files/${f.id}"><b>${f.original_name}</b></a>` : html`<b>${f.original_name}</b> <span class="muted small">(download not enabled)</span>`}
          <div class="muted small">${[f.caption, f.location, f.observed_on ? `Observed ${fmtDate(f.observed_on)}` : null].filter(Boolean).join(' · ')}</div><div class="muted small">${fmtSize(f.size)} · ${fmtDate(f.uploaded_at)}</div></div></li>`)}</ul>`
      : emptyState('Nothing shared yet', 'Documents appear here when SarayDar shares them with you.')}</section>`;
  };

  r.get(['/p/:id', '/p/:id/:tab'], async (req, res) => {
    const v = await viewer(req);
    const tab = req.params.tab || 'overview';
    if (!tabsOf(v).some(t => t[0] === tab) || !T[tab]) throw new NotFound();
    const body = await T[tab](req, v);
    res.send(page(req, v, tab, body));
  });

  // Files an external viewer may open beyond those published in Documents.
  ctx.externalFile = async (user, f, a) => {
    if (a && !a.internal) {
      if (f.entity === 'progress_update' && (await pool.query("select 1 from progress_updates where id::text = $1 and workspace_id = $2 and status = 'published' and external_visible and archived_at is null", [f.entity_id, f.workspace_id])).rowCount) return a.grants || {};
      if (f.entity === 'listing' && f.tag === 'published') return a.grants || {};
      if (f.entity === 'maint_request' && a.role === 'owner_viewer' && (await pool.query('select 1 from maint_requests where id::text = $1 and workspace_id = $2 and owner_visible', [f.entity_id, f.workspace_id])).rowCount) return a.grants || {};
      return null;
    }
    // a buyer may see published photos of a listing published on their own shortlist
    if (!a && f.entity === 'listing' && f.tag === 'published' && (await pool.query(`select 1 from shortlist_items s join workspace_members m on m.workspace_id = s.workspace_id
        where s.listing_ws = $1 and s.published and s.status <> 'withdrawn' and m.user_id = $2 and m.revoked_at is null and m.role = 'buyer_viewer'`, [f.workspace_id, user.id])).rowCount) return {};
    return null;
  };

  // ---------- My Workspaces (replaces the simple list) ----------
  r.get('/my', async (req, res) => {
    if (!core.isExternal(req.user)) return res.redirect('/');
    const q = String(req.query.q || '').trim().slice(0, 80).toLowerCase();
    const rows = (await pool.query(
      `select w.id, w.section, w.kind, w.ref, w.name, w.location, w.status, w.updated_at, m.role,
              (select max(observed_on) from progress_updates u where u.workspace_id = w.id and u.status = 'published' and u.external_visible) as last_update,
              (select f.id from files f where f.workspace_id = w.id and f.thumb is not null and f.archived_at is null and
                 ((f.entity is null and f.visibility = 'published') or (f.entity = 'listing' and f.tag = 'published')) order by f.uploaded_at desc limit 1) as cover
         from workspace_members m join workspaces w on w.id = m.workspace_id
        where m.user_id = $1 and m.revoked_at is null order by w.section, w.name`, [req.user.id])).rows
      .filter(w => !q || `${w.name} ${w.ref} ${w.location || ''}`.toLowerCase().includes(q));
    const GROUPS = [['Projects', ['dev', 'cpm']], ['Properties', ['props']], ['Sales & Acquisitions', ['sales']]];
    const groups = GROUPS.map(([l, secs]) => [l, rows.filter(x => secs.includes(x.section))]).filter(g => g[1].length);
    res.send(layout(req, { title: 'My Workspaces', heading: 'My Workspaces', sub: { below: 'Projects, properties and cases shared with you. View only.' }, noExport: true, body: html`
      <form class="filters" method="get" role="search"><input name="q" value="${q}" placeholder="Filter by name or reference" aria-label="Filter"><button class="btn" type="submit">Filter</button>${q ? html`<a class="btn" href="/my">Clear</a>` : ''}</form>
      ${groups.length ? groups.map(([l, list]) => html`<section class="panel"><h2 class="h">${l}</h2>
        <ul class="ws-cards">${list.map(w => html`<li><a class="ws-card" href="/p/${w.id}">
          ${w.cover ? html`<img src="/files/${w.cover}/thumb" alt="" loading="lazy">` : html`<span class="ws-cover" aria-hidden="true">${(w.name || '?').slice(0, 1)}</span>`}
          <span class="grow"><b>${w.name}</b><span class="muted small">${w.ref} · ${KIND_LABEL[w.kind]}${w.location ? ` · ${w.location}` : ''}</span>
          <span class="muted small">${SECTIONS[w.section].name} · ${EXTERNAL_MEMBER_ROLES[w.role] || ''}${w.last_update ? ` · updated ${fmtDate(w.last_update)}` : ''}</span></span>${statusPill(w.status)}</a></li>`)}</ul></section>`)
        : emptyState(q ? 'No matches' : 'Nothing shared with you yet', q ? 'Only workspaces shared with you are searched.' : 'SarayDar staff will share projects or properties with you when they are ready.')}` }));
  });
}

module.exports = { mountExternal };
