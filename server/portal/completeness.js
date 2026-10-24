'use strict';
// "What's missing" guide (owner request 2026-10-24): for every project, property, listing and search request,
// a checklist of the things that should be recorded, each linked to the place where it is done. Shown at the
// top of the workspace overview and as a count on the section cards. It only reads; it never changes anything.
const { html, pill } = require('./views');

function mountCompleteness(r, ctx) {
  const { pool } = ctx;
  const one = async (sql, v) => (await pool.query(sql, v)).rows[0] || {};
  const n = async (sql, v) => Number((await one(sql, v)).n || 0);

  async function check(ws) {
    const id = ws.id, W = p => `/w/${id}${p}`;
    const items = [];
    const add = (label, done, href, hint = '') => items.push({ label, done: !!done, href, hint });
    const party = ws.party_id ? await one('select * from parties where id = $1', [ws.party_id]) : null;
    add('Responsible manager assigned', ws.manager_id, W(''), 'Overview › Edit details');
    add('Location recorded', ws.location, W(''), 'Overview › Edit details');

    if (ws.kind === 'project' || ws.kind === 'client_project') {
      const cpm = ws.kind === 'client_project';
      if (cpm) {
        add('Client linked', party, W('/client'));
        add('Client telephone or email', party && (party.phone || party.email), party ? `/clients/${party.id}?edit=1&back=${encodeURIComponent(W('/client'))}#edit` : W('/client'));
        add('Client approvers recorded', party && party.approval_authorities, party ? `/clients/${party.id}?edit=1&back=${encodeURIComponent(W('/client'))}#edit` : W('/client'));
        const t = await one("select status, scope, monthly_fee_minor from mgmt_terms where workspace_id = $1 and status in ('draft','active') order by (status = 'active') desc limit 1", [id]);
        add('Management terms recorded (fee, period, scope)', t.status && t.scope && t.monthly_fee_minor !== null, W('/client'));
        add('Terms activated by Finance', await n("select count(*)::int as n from mgmt_terms where workspace_id = $1 and status = 'active'", [id]), W('/client'));
      }
      const ag = await one(`select g.status from agreements g join agreement_templates t on t.id = g.template_id where g.workspace_id = $1 ${cpm ? "and t.key = 'pm_services'" : ''} and g.status <> 'cancelled' order by (g.status = 'signed') desc limit 1`, [id]);
      if (cpm) {
        add('Agreement generated', ag.status, W('/client'));
        add('Signed agreement recorded', ag.status === 'signed', W('/agreements'), 'Upload the signed copy');
      }
      add('Guided setup completed', (await one('select status from setup_drafts where workspace_id = $1', [id])).status === 'reviewed', W('/setup'));
      add('Plan approved (baseline)', await n("select count(*)::int as n from plans where workspace_id = $1 and status = 'approved'", [id]), W('/plan'));
      add('Phase weights set', !(await n('select count(*)::int as n from phases where workspace_id = $1 and archived_at is null and weight is null', [id])) && await n('select count(*)::int as n from phases where workspace_id = $1 and archived_at is null', [id]), W('/tasks'));
      add('Budget amounts entered', await n('select count(*)::int as n from budget_lines where workspace_id = $1 and archived_at is null and coalesce(revised_minor, original_minor, 0) > 0', [id]), W('/budget'));
      if (!cpm) add('Land / plots recorded', await n('select count(*)::int as n from plots where workspace_id = $1 and archived_at is null', [id]), W('/plots'));
      add('Progress update in the last 30 days', await n("select count(*)::int as n from progress_updates where workspace_id = $1 and status = 'published' and observed_on >= current_date - 30", [id]), W('/updates'));
    }

    if (ws.kind === 'property') {
      add('Owner linked', party, W('/client'));
      add('Owner telephone or email', party && (party.phone || party.email), party ? `/clients/${party.id}?edit=1&back=${encodeURIComponent(W('/client'))}#edit` : W('/client'));
      add('Property setup recorded (rent collection, limits)', await n('select count(*)::int as n from property_profiles where workspace_id = $1', [id]), W('/property'));
      const units = await n('select count(*)::int as n from units where workspace_id = $1 and archived_at is null', [id]);
      add('Units added', units, W('/units'));
      const noLease = await n(`select count(*)::int as n from units u where u.workspace_id = $1 and u.archived_at is null and u.status = 'occupied'
          and not exists (select 1 from leases l where l.unit_id = u.id and l.status = 'active')`, [id]);
      add(noLease ? `Leases for occupied units (${noLease} missing)` : 'Leases for occupied units', units && !noLease, W('/leases'));
      add('Management terms activated', await n("select count(*)::int as n from mgmt_terms where workspace_id = $1 and status = 'active'", [id]), W('/client'));
      add('Signed management agreement', await n("select count(*)::int as n from agreements where workspace_id = $1 and status = 'signed'", [id]), W('/client'));
    }

    if (ws.kind === 'listing' || ws.kind === 'request') {
      add(ws.kind === 'listing' ? 'Seller linked' : 'Buyer linked', party, W(''));
      const m = await one("select status, authority_verified_at from sale_mandates where workspace_id = $1 order by version desc limit 1", [id]);
      add('Mandate active', m.status === 'active', W('/mandate'));
      add('Authority to represent verified', m.authority_verified_at, W('/mandate'));
      if (ws.kind === 'listing') {
        const l = await one('select * from listings where workspace_id = $1', [id]);
        add('Asking price set', l.asking_minor, W('/listing'));
        add('Description written', l.description, W('/listing'));
        add('Property information verified', l.verified_at, W('/listing'));
        add('Client-approved photos', await n("select count(*)::int as n from files where workspace_id = $1 and entity = 'listing' and tag = 'published' and archived_at is null", [id]), W('/listing'));
        add('Published marketing', await n("select count(*)::int as n from marketing_activities where workspace_id = $1 and status = 'published'", [id]), W('/marketing'));
      } else {
        add('Search brief recorded', await n('select count(*)::int as n from request_briefs where workspace_id = $1', [id]), W('/brief'));
        add('Shortlist started', await n("select count(*)::int as n from shortlist_items where workspace_id = $1 and status <> 'withdrawn'", [id]), W('/shortlist'));
      }
    }
    return items;
  }

  async function summary(ws) {
    const items = await check(ws);
    return { items, done: items.filter(x => x.done).length, total: items.length, missing: items.filter(x => !x.done) };
  }
  ctx.completeness = summary;

  ctx.completenessPanel = async a => {
    if (!a.internal || ['completed', 'archived'].includes(a.ws.status)) return '';
    const s = await summary(a.ws);
    if (!s.total) return '';
    const pct = Math.round(100 * s.done / s.total);
    if (!s.missing.length) return html`<section class="panel guide guide-done"><div class="row-between"><h2 class="h">Record complete</h2>${pill(`${s.done} of ${s.total}`, 'ok')}</div><p class="muted small">Everything this ${a.ws.kind === 'property' ? 'property' : a.ws.kind === 'listing' ? 'listing' : a.ws.kind === 'request' ? 'request' : 'project'} should have is recorded.</p></section>`;
    return html`<section class="panel guide"><div class="row-between"><h2 class="h">What's missing</h2><span class="guide-count">${s.done} of ${s.total} done</span></div>
      <div class="guide-bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="Record completeness"><span style="width:${pct}%"></span></div>
      <ul class="guide-list">${s.missing.map(m => html`<li><a href="${m.href}"><span class="guide-dot" aria-hidden="true"></span><span class="grow">${m.label}${m.hint ? html`<span class="muted small"> · ${m.hint}</span>` : ''}</span><span class="guide-go">Do it ›</span></a></li>`)}</ul>
      <details class="small"><summary>Show completed (${s.done})</summary><ul class="guide-list done">${s.items.filter(x => x.done).map(m => html`<li><span class="guide-tick" aria-hidden="true">✓</span> ${m.label}</li>`)}</ul></details>
    </section>`;
  };
}

module.exports = { mountCompleteness };
