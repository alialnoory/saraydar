'use strict';
// "What's missing" guide (owner request 2026-10-24): for every project, property, listing and search request,
// a checklist of the things that should be recorded, each linked to the place where it is done. Shown at the
// top of the workspace overview and as a count on the section cards. It only reads; it never changes anything.
const { html, pill } = require('./views');

function mountCompleteness(r, ctx) {
  const { pool, core } = ctx;
  const one = async (sql, v) => (await pool.query(sql, v)).rows[0] || {};
  const n = async (sql, v) => Number((await one(sql, v)).n || 0);

  async function check(ws) {
    const id = ws.id, W = p => `/w/${id}${p}`;
    const items = [];
    let st = 'Details', life = false;                       // the station of the journey the next items belong to
    const add = (label, done, href, hint = '') => items.push({ label, done: !!done, href, hint, station: st, life });
    const at = (name, isLife = false) => { st = name; life = isLife; };
    const party = ws.party_id ? await one('select * from parties where id = $1', [ws.party_id]) : null;
    add('Responsible manager assigned', ws.manager_id, W('?edit=1#edit'));
    add('Location recorded', ws.location, W('?edit=1#edit'));

    if (ws.kind === 'project' || ws.kind === 'client_project') {
      const cpm = ws.kind === 'client_project';
      if (cpm) {
        at('Client');
        add('Client linked', party, W('/client'));
        add('Client telephone or email', party && (party.phone || party.email), party ? `/clients/${party.id}?edit=1&back=${encodeURIComponent(W('/client'))}#edit` : W('/client'));
        add('Client representative recorded (or signs personally)', party && (party.signs_personally || party.representative), party ? `/clients/${party.id}?edit=1&back=${encodeURIComponent(W('/client'))}#edit` : W('/client'));
        at('Terms');
        const t = await one("select status, scope, monthly_fee_minor from mgmt_terms where workspace_id = $1 and status in ('draft','active') order by (status = 'active') desc limit 1", [id]);
        add('Management terms recorded (fee, period, scope)', t.status && t.scope && t.monthly_fee_minor !== null, W('/agreements'));
        add('Terms activated by Finance', await n("select count(*)::int as n from mgmt_terms where workspace_id = $1 and status = 'active'", [id]), W('/agreements'));
      }
      const ag = await one(`select g.status from agreements g join agreement_templates t on t.id = g.template_id where g.workspace_id = $1 ${cpm ? "and t.key = 'pm_services'" : ''} and g.status <> 'cancelled' order by (g.status = 'signed') desc limit 1`, [id]);
      if (cpm) {
        at('Agreement');
        add('Agreement generated', ag.status, W('/agreements'));
        add('Signed agreement recorded', ag.status === 'signed', W('/agreements'), 'Sign it on screen or upload the signed copy');
      }
      at('Setup');
      add('Guided setup completed', (await one('select status from setup_drafts where workspace_id = $1', [id])).status === 'reviewed', W('/setup'));
      at('Plan');
      add('Plan approved (baseline)', await n("select count(*)::int as n from plans where workspace_id = $1 and status = 'approved'", [id]), W('/plan'));
      add('Phase weights set', !(await n('select count(*)::int as n from phases where workspace_id = $1 and archived_at is null and weight is null', [id])) && await n('select count(*)::int as n from phases where workspace_id = $1 and archived_at is null', [id]), W('/tasks'));
      at('Budget');
      if (!(ws.section === 'cpm' && ws.budget_control === 'client')) add('Budget amounts entered', await n('select count(*)::int as n from budget_lines where workspace_id = $1 and archived_at is null and coalesce(revised_minor, original_minor, 0) > 0', [id]), W('/budget'));
      if (!cpm) { at('Land'); add('Land / plots recorded', await n('select count(*)::int as n from plots where workspace_id = $1 and archived_at is null', [id]), W('/plots')); }
      at('Progress');
      add('Progress update in the last 30 days', await n("select count(*)::int as n from progress_updates where workspace_id = $1 and status = 'published' and observed_on >= current_date - 30", [id]), W('/updates'));
    }

    if (ws.kind === 'property') {
      add('Owner linked', party, W('/client'));
      add('Owner telephone or email', party && (party.phone || party.email), party ? `/clients/${party.id}?edit=1&back=${encodeURIComponent(W('/client'))}#edit` : W('/client'));
      at('Setup');
      add('Property setup recorded (rent collection, limits)', await n('select count(*)::int as n from property_profiles where workspace_id = $1', [id]), W('/property'));
      at('Units');
      const units = await n('select count(*)::int as n from units where workspace_id = $1 and archived_at is null', [id]);
      add('Units added', units, W('/units'));
      const noLease = await n(`select count(*)::int as n from units u where u.workspace_id = $1 and u.archived_at is null and u.status = 'occupied'
          and not exists (select 1 from leases l where l.unit_id = u.id and l.status = 'active')`, [id]);
      at('Leases');
      add(noLease ? `Leases for occupied units (${noLease} missing)` : 'Leases for occupied units', units && !noLease, W('/leases'));
      at('Terms');
      add('Management terms activated', await n("select count(*)::int as n from mgmt_terms where workspace_id = $1 and status = 'active'", [id]), W('/agreements'));
      at('Agreement');
      add('Signed management agreement', await n("select count(*)::int as n from agreements where workspace_id = $1 and status = 'signed'", [id]), W('/agreements'));
      at('Billing', true);
      add('First fee invoice issued', await n("select count(*)::int as n from fee_invoices where workspace_id = $1 and status = 'issued'", [id]), W('/fees'));
    }

    if (ws.kind === 'listing' || ws.kind === 'request') {
      add(ws.kind === 'listing' ? 'Seller linked' : 'Buyer linked', party, W(''));
      at('Mandate');
      const m = await one("select status, authority_verified_at from sale_mandates where workspace_id = $1 order by version desc limit 1", [id]);
      add('Mandate active', m.status === 'active', W('/mandate'));
      add('Authority to represent verified', m.authority_verified_at, W('/mandate'));
      if (ws.kind === 'listing') {
        const l = await one('select * from listings where workspace_id = $1', [id]);
        at('Property file');
        add('Asking price set', l.asking_minor, W('/listing'));
        add('Description written', l.description, W('/listing'));
        add('Property information verified', l.verified_at, W('/listing'));
        add('Client-approved photos', await n("select count(*)::int as n from files where workspace_id = $1 and entity = 'listing' and tag = 'published' and archived_at is null", [id]), W('/listing'));
        at('Marketing');
        add('Published marketing', await n("select count(*)::int as n from marketing_activities where workspace_id = $1 and status = 'published'", [id]), W('/marketing'));
      } else {
        at('Brief');
        add('Search brief recorded', await n('select count(*)::int as n from request_briefs where workspace_id = $1', [id]), W('/brief'));
        at('Shortlist');
        add('Shortlist started', await n("select count(*)::int as n from shortlist_items where workspace_id = $1 and status <> 'withdrawn'", [id]), W('/shortlist'));
      }
      // what happens after the record is complete: the deal itself
      const col = ws.kind === 'listing' ? 'listing_ws' : 'request_ws';
      at('Viewings', true);
      add('A viewing completed', await n(`select count(*)::int as n from viewings where ${col} = $1 and status = 'completed'`, [id]), W(ws.kind === 'listing' ? '/buyers' : '/offers'));
      at('Offer', true);
      add('An offer accepted', await n(`select count(*)::int as n from offers where ${col} = $1 and status = 'accepted'`, [id]), W('/offers'));
      at('Deal', true);
      add('Deal completed', await n(`select count(*)::int as n from deals where ${col} = $1 and status = 'completed'`, [id]), W('/offers'));
      at('Fee', true);
      add('Fee invoice issued', await n("select count(*)::int as n from fee_invoices where workspace_id = $1 and status = 'issued'", [id]), W('/fees'));
    }
    return items;
  }

  async function summary(ws) {
    const items = (await check(ws)).filter(x => !x.life);   // the record checklist; the deal stages are only on the journey bar
    return { items, done: items.filter(x => x.done).length, total: items.length, missing: items.filter(x => !x.done) };
  }
  ctx.completeness = summary;

  // The journey (owner request 2026-10-27): the stations to follow, in order, with the one to work on now and its
  // next action. A station is done when everything in it is recorded; the current one is the first that is not.
  // What to do, as an instruction, for the "Next step" box (the checklist keeps the "done" wording).
  const TODO = {
    'Responsible manager assigned': 'Assign the responsible manager', 'Location recorded': 'Record the location',
    'Buyer linked': 'Link the buyer (client)', 'Seller linked': 'Link the seller (client)', 'Owner linked': 'Link the owner', 'Client linked': 'Link the client',
    'Owner telephone or email': 'Add the owner\'s telephone or email', 'Client telephone or email': 'Add the client\'s telephone or email',
    'Client representative recorded (or signs personally)': 'Record the client\'s representative (or that they sign personally)',
    'Management terms recorded (fee, period, scope)': 'Record the management terms (fee, period, scope)', 'Terms activated by Finance': 'Finance to activate the terms',
    'Agreement generated': 'Generate the agreement', 'Signed agreement recorded': 'Get the agreement signed', 'Phase weights set': 'Set the phase weights',
    'Property setup recorded (rent collection, limits)': 'Record the property setup (rent collection, limits)',
    'Mandate active': 'Record and activate the mandate (authority, period, fee)', 'Authority to represent verified': 'Verify the client\'s authority to be represented',
    'Search brief recorded': 'Record what the client is looking for (brief)', 'Shortlist started': 'Search the market and shortlist matching properties',
    'A viewing completed': 'Arrange a viewing and record it as completed', 'An offer accepted': 'Make an offer and record when it is accepted',
    'Deal completed': 'Close the deal: complete the deal checklist', 'Fee invoice issued': 'Issue SarayDar\'s fee invoice',
    'Asking price set': 'Set the asking price', 'Description written': 'Write the property description', 'Property information verified': 'Verify the property information',
    'Client-approved photos': 'Add the photos the client approved', 'Published marketing': 'Publish the marketing',
    'Units added': 'Add the units', 'Management terms activated': 'Activate the management terms', 'Signed management agreement': 'Upload the signed management agreement',
    'First fee invoice issued': 'Issue the first fee invoice', 'Guided setup completed': 'Complete the guided setup', 'Plan approved (baseline)': 'Approve the plan (baseline)',
    'Budget amounts entered': 'Enter the budget amounts', 'Land / plots recorded': 'Record the land / plots', 'Progress update in the last 30 days': 'Publish a progress update',
  };
  const STATION_NAMES = { request: { Details: 'Request', Shortlist: 'Search', Deal: 'Closing', Fee: 'Invoice' }, listing: { Details: 'Listing', Deal: 'Closing', Fee: 'Invoice' } };
  async function journey(ws) {
    const items = await check(ws);
    const rename = STATION_NAMES[ws.kind] || {};
    for (const it of items) { it.station = rename[it.station] || it.station; it.todo = TODO[it.label] || it.label; }
    const stations = [];
    for (const it of items) { let s = stations.find(x => x.name === it.station); if (!s) stations.push(s = { name: it.station, items: [] }); s.items.push(it); }
    for (const s of stations) { s.done = s.items.every(x => x.done); s.next = s.items.find(x => !x.done) || null; s.href = (s.next || s.items[0]).href; }
    const cur = stations.findIndex(s => !s.done);
    return { stations, cur, items };
  }
  ctx.journey = journey;

  // "Current stage" follows the bar for sales cases and properties (owner decision 2026-10-27): no typing.
  const AUTO = ['listing', 'request', 'property'];
  ctx.autoStage = kind => AUTO.includes(kind);
  async function syncStage(ws, j) {
    if (!AUTO.includes(ws.kind) || !['active', 'on_hold'].includes(ws.status)) return ws.stage;
    j = j || await journey(ws);
    const st = j.cur >= 0 ? j.stations[j.cur].name : ws.kind === 'property' ? 'Running' : 'Closed & invoiced';
    if (st !== ws.stage) { await pool.query('update workspaces set stage = $2 where id = $1', [ws.id, st]); ws.stage = st; }   // updated_at left alone: not a user edit
    return st;
  }
  ctx.syncStage = syncStage;

  r.use(async (req, res, next) => {
    try {
      const m = req.method === 'GET' && req.user && !req.query.export && /^\/w\/([0-9a-f-]{36})\/[a-z-]+(\/[^.]*)?$/i.exec(req.path);
      if (!m || core.isExternal(req.user)) return next();
      const a = await core.workspaceAccess(req.user, m[1]);
      if (!a || !a.internal) return next();
      if (ctx.authority && !(await ctx.authority.allowed(req.user, `${a.ws.section}.record`, 'edit'))) return next();
      req.topPanel = await ctx.completenessPanel(a, { compact: true });
    } catch (e) { /* the requirements bar is a guide; a page never fails because of it */ }
    next();
  });

  ctx.completenessPanel = async (a, { compact = false } = {}) => {
    if (!a.internal || ['completed', 'archived'].includes(a.ws.status)) return '';
    const j = await journey(a.ws);
    await syncStage(a.ws, j);
    if (!j.stations.length) return '';
    const what = a.ws.kind === 'property' ? 'property' : a.ws.kind === 'listing' ? 'listing' : a.ws.kind === 'request' ? 'request' : 'project';
    const now = j.cur >= 0 ? j.stations[j.cur] : null;
    const record = j.items.filter(x => !x.life), missing = record.filter(x => !x.done);
    const later = now ? j.stations.slice(j.cur + 1).flatMap(s => s.items.filter(x => !x.done && !x.life)) : [];   // gaps further along, not blocking
    const bar = html`<ol class="jr" style="--n:${j.stations.length}">${j.stations.map((s, i) => html`<li class="${s.done ? 'done' : i === j.cur ? 'now' : 'todo'}"><a href="${s.href}" title="${s.done ? `${s.name}: done` : `${s.name}: ${s.items.filter(x => !x.done).map(x => x.label).join(', ')}`}">
        <span class="jr-dot" aria-hidden="true">${s.done ? '✓' : String(i + 1)}</span><span class="jr-label">${s.name}</span></a></li>`)}</ol>`;
    // titled "System Requirements", compact and placed at the top of the overview (owner request 2026-10-28)
    if (!now) return html`<section class="panel journey jr-compact ${compact ? 'jr-tab' : ''} no-export"><div class="row-between"><h2 class="h">System Requirements <span class="muted small jr-sub">Everything this ${what} should have is recorded</span></h2>${pill(`${j.stations.length} of ${j.stations.length} complete`, 'ok')}</div>${bar}</section>`;
    if (compact) return html`<section class="panel journey jr-compact jr-tab no-export">
      <div class="row-between"><h2 class="h">System Requirements</h2><span class="guide-count">Stage ${j.cur + 1} of ${j.stations.length} · ${now.name}</span></div>
      ${bar}
      <a class="jr-next jr-next-slim" href="${now.next.href}"><span class="jr-next-k">Next</span><span class="grow"><b>${now.next.todo}</b></span><span class="muted small">Record ${record.length - missing.length} of ${record.length} complete</span><span class="btn primary small">Do it ›</span></a>
    </section>`;
    return html`<section class="panel journey jr-compact no-export">
      <div class="row-between"><h2 class="h">System Requirements</h2><span class="guide-count">Stage ${j.cur + 1} of ${j.stations.length} · ${now.name}</span></div>
      ${bar}
      <a class="jr-next" href="${now.next.href}"><span class="jr-next-k">${now.name}</span><span class="grow"><b>${now.next.todo}</b>${now.next.hint ? html`<span class="muted small"> · ${now.next.hint}</span>` : ''}
        ${now.items.filter(x => !x.done).length > 1 ? html`<span class="muted small jr-also">Also in this stage: ${now.items.filter(x => !x.done && x !== now.next).map(x => x.todo).join(' · ')}</span>` : ''}</span><span class="btn primary small">Do it ›</span></a>
      ${later.length ? html`<details class="small jr-more"><summary>Also missing further along (${later.length})</summary><ul class="guide-list">${later.map(m => html`<li><a href="${m.href}"><span class="guide-dot" aria-hidden="true"></span><span class="grow">${m.label}</span><span class="guide-go">Do it ›</span></a></li>`)}</ul></details>` : ''}
      <p class="muted small jr-foot">Record ${record.length - missing.length} of ${record.length} complete. Click any stage to open it.</p>
    </section>`;
  };
}

module.exports = { mountCompleteness };
