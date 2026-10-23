'use strict';
// AI assistant inside a workspace (spec section 11), for SarayDar staff only. It is optional: without an API key the
// tab says so and nothing is simulated. When configured, the question and a context assembled ONLY from records
// the asking user may already see in this one workspace are sent to the provider. Financial figures, people's
// contact details, tenant and buyer identities, confidential seller limits and internal notes are never sent.
// Answers are suggestions: the assistant cannot change, approve, send or publish anything.
const { SECTIONS, KIND_LABEL } = require('./core');
const { layout, html, raw, csrfField, field, statusPill, fmtDate, fmtDateTime } = require('./views');
const { formatMoney } = require('../lib/money');

const MAX_Q = 1000;
const PER_HOUR = 30;
const iso = d => d ? String(d).slice(0, 10) : '';

function aiConfig(env) {
  const key = env.ANTHROPIC_API_KEY;
  if (!key) return null;
  return { key, model: env.AI_MODEL || 'claude-sonnet-5-5', url: (env.AI_API_URL || 'https://api.anthropic.com').replace(/\/$/, '') + '/v1/messages' };
}

function mountAssistant(r, ctx) {
  const { pool, core, env, NotFound } = ctx;
  const cfg = () => aiConfig(env);

  // add the tab to every section's workspace tabs (before Activity)
  for (const s of Object.keys(SECTIONS)) {
    const orig = ctx.tabsFor && ctx.tabsFor[s];
    const base = orig || ((a, cur) => [['Overview', `/w/${a.ws.id}`, cur === 'Overview'], ['Documents', `/w/${a.ws.id}/documents`, cur === 'Documents'], ['Access & Invitations', `/w/${a.ws.id}/access`, cur === 'Access & Invitations'], ['Activity', `/w/${a.ws.id}/activity`, cur === 'Activity']]);
    ctx.tabsFor[s] = (a, cur) => {
      const t = base(a, cur).filter(x => x[0] !== 'Assistant');
      const i = t.findIndex(x => x[0] === 'Activity');
      t.splice(i < 0 ? t.length : i, 0, ['Assistant', `/w/${a.ws.id}/assistant`, cur === 'Assistant']);
      return t;
    };
  }

  async function access(req) {
    const a = await core.workspaceAccess(req.user, req.params.id);
    if (!a || !a.internal) throw new NotFound();          // never offered in the external portal
    a.finance = core.isSuper(req.user) || a.role === 'manager' || a.role === 'editor' || await core.can(req.user, 'view:financials');
    return a;
  }
  function page(req, a, body) {
    const w = a.ws, s = SECTIONS[w.section];
    return layout(req, { title: `Assistant · ${w.name}`, heading: w.name, tabs: ctx.tabsFor[w.section](a, 'Assistant'),
      crumbs: [['Home', '/'], [s.name, `/s/${w.section}`], [w.name, `/w/${w.id}`], ['Assistant']],
      sub: { above: `${w.ref} · ${KIND_LABEL[w.kind]}`, below: w.location || '', badge: statusPill(w.status) }, body, noExport: true });
  }

  // Context: plain facts from this workspace only, each with the page it came from.
  async function contextFor(a) {
    const w = a.ws, id = w.id, lines = [], sources = [];
    const src = (label, href) => sources.push([label, href]);
    lines.push(`Workspace: ${w.name} (${w.ref}), ${KIND_LABEL[w.kind]} in "${SECTIONS[w.section].name}". Status ${w.status}${w.stage ? `, stage ${w.stage}` : ''}${w.location ? `, location ${w.location}` : ''}. Today is ${new Date().toISOString().slice(0, 10)}.`);
    src('Overview', `/w/${id}`);
    if (w.kind === 'project' || w.kind === 'client_project') {
      const tasks = (await pool.query("select title, status, progress, due_date, is_milestone from tasks where workspace_id = $1 and archived_at is null and status not in ('done','cancelled') order by due_date nulls last limit 60", [id])).rows;
      if (tasks.length) { lines.push('Open tasks (title | status | progress % | due):'); for (const t of tasks) lines.push(`- ${t.title}${t.is_milestone ? ' [milestone]' : ''} | ${t.status} | ${t.progress ?? 0} | ${iso(t.due_date) || 'no date'}`); src('Tasks & Schedule', `/w/${id}/tasks`); }
      const ups = (await pool.query("select title, observed_on, completed_work, remaining_work, issues from progress_updates where workspace_id = $1 and status = 'published' and archived_at is null order by observed_on desc limit 8", [id])).rows;
      if (ups.length) { lines.push('Recent published progress updates:'); for (const u of ups) lines.push(`- ${iso(u.observed_on)} ${u.title}. Done: ${(u.completed_work || '').slice(0, 300)} Next: ${(u.remaining_work || '').slice(0, 200)} Issues: ${(u.issues || '').slice(0, 200)}`); src('Progress Updates', `/w/${id}/updates`); }
      const reg = (await pool.query("select kind, title, status, impact, due_date from register_items where workspace_id = $1 and archived_at is null and status <> 'closed' order by created_at desc limit 30", [id])).rows;
      if (reg.length) { lines.push('Open register items (risks, issues, decisions):'); for (const x of reg) lines.push(`- [${x.kind}] ${x.title} | ${x.status}${x.impact ? ` | impact ${x.impact}` : ''}${x.due_date ? ` | due ${iso(x.due_date)}` : ''}`); src('Registers', `/w/${id}/registers`); }
    }
    if (w.kind === 'property') {
      const units = (await pool.query('select ref, unit_type, status from units where workspace_id = $1 and archived_at is null order by sort, ref limit 200', [id])).rows;
      if (units.length) { lines.push(`Units: ${units.map(u => `${u.ref} (${u.unit_type || 'unit'}, ${u.status})`).join('; ')}`); src('Units', `/w/${id}/units`); }
      const ends = (await pool.query("select u.ref, l.end_date from leases l join units u on u.id = l.unit_id where l.workspace_id = $1 and l.status = 'active' and l.end_date <= current_date + 90 order by l.end_date", [id])).rows;
      if (ends.length) lines.push(`Leases ending within 90 days: ${ends.map(e => `unit ${e.ref} on ${iso(e.end_date)}`).join('; ')}`);
      const mt = (await pool.query("select ref, title, priority, status, reported_on from maint_requests where workspace_id = $1 and status not in ('verified','closed','cancelled','rejected') order by reported_on limit 50", [id])).rows;
      if (mt.length) { lines.push('Open maintenance:'); for (const m of mt) lines.push(`- ${m.ref} ${m.title} | ${m.priority} | ${m.status} | reported ${iso(m.reported_on)}`); src('Maintenance', `/w/${id}/maintenance`); }
    }
    if (w.kind === 'listing') {
      const l = (await pool.query('select status, property_type, location, land_area_m2, built_area_m2, bedrooms, asking_minor, currency, features from listings where workspace_id = $1', [id])).rows[0];
      if (l) { lines.push(`Listing: ${l.status}, ${l.property_type || 'type not recorded'}, ${l.location || ''}, land ${l.land_area_m2 ?? '?'} m², built ${l.built_area_m2 ?? '?'} m², bedrooms ${l.bedrooms ?? '?'}${l.asking_minor ? `, asking ${formatMoney(Number(l.asking_minor), l.currency)}` : ''}. Features: ${l.features || '—'}`); src('Listing', `/w/${id}/listing`); }
      const v = (await pool.query('select status, count(*)::int as n from viewings where listing_ws = $1 group by status', [id])).rows;
      if (v.length) lines.push(`Viewings by status: ${v.map(x => `${x.status} ${x.n}`).join(', ')}`);
      const o = (await pool.query('select status, count(*)::int as n from offers where listing_ws = $1 group by status', [id])).rows;
      if (o.length) lines.push(`Offers by status: ${o.map(x => `${x.status} ${x.n}`).join(', ')}`);
    }
    if (w.kind === 'request') {
      const b = (await pool.query('select purpose, types, locations, bedrooms_min, features, timing from request_briefs where workspace_id = $1 order by version desc limit 1', [id])).rows[0];
      if (b) { lines.push(`Buyer brief: purpose ${b.purpose || '—'}; types ${b.types || '—'}; locations ${b.locations || '—'}; bedrooms ≥ ${b.bedrooms_min ?? '—'}; features ${b.features || '—'}; timing ${b.timing || '—'}. (Budget not shared with the assistant.)`); src('Brief', `/w/${id}/brief`); }
      const s = (await pool.query("select status, count(*)::int as n from shortlist_items where workspace_id = $1 group by status", [id])).rows;
      if (s.length) lines.push(`Shortlist by status: ${s.map(x => `${x.status} ${x.n}`).join(', ')}`);
    }
    const act = (await pool.query('select at, summary from audit_events where workspace_id = $1 and summary is not null order by id desc limit 15', [id])).rows;
    if (act.length) { lines.push('Recent activity:'); for (const e of act) lines.push(`- ${new Date(e.at).toISOString().slice(0, 10)} ${e.summary.slice(0, 160)}`); src('Activity', `/w/${id}/activity`); }
    return { text: lines.join('\n').slice(0, 24000), sources };
  }

  const SYSTEM = 'You assist SarayDar Real Estate staff in Bahrain with one workspace. Answer only from the workspace facts provided. ' +
    'If the facts do not contain the answer, say what is missing. Never invent figures, dates or names. You cannot change records, approve, ' +
    'send messages or publish anything; when an action is needed, suggest it as a step for a staff member to review. Be concise and use plain English.';

  async function ask(question, context) {
    const c = cfg();
    const res = await fetch(c.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': c.key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: c.model, max_tokens: 1200, system: SYSTEM, messages: [{ role: 'user', content: `Workspace facts:\n${context}\n\nQuestion: ${question}` }] }),
      signal: AbortSignal.timeout(60000)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(`The AI provider returned an error (${res.status}${data.error && data.error.type ? `: ${data.error.type}` : ''}).`), { status: 502 });
    return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  }

  const form = (req, a, q = '') => html`<form method="post" action="/w/${a.ws.id}/assistant" class="stack">${csrfField(req)}
      ${field({ name: 'q', label: 'Ask about this workspace', type: 'textarea', value: q, required: true, attrs: `maxlength="${MAX_Q}" rows="3" placeholder="e.g. Which milestones are at risk this month, and why?"` })}
      <div class="actions"><button class="btn primary" type="submit">Ask</button></div></form>`;
  const disclosure = html`<p class="muted small">Sent to the AI provider: your question and a summary of this workspace's tasks, published progress updates, open registers, units or listing status and recent activity. Not sent: amounts and budgets (except a listing's public asking price), contact details, tenant and buyer identities, buyer budgets, confidential seller limits, files and internal notes. Answers are suggestions — check them before acting. The assistant cannot change anything.</p>`;

  r.get('/w/:id/assistant', async (req, res) => {
    const a = await access(req);
    if (!cfg()) return res.send(page(req, a, html`<section class="panel"><h2 class="h">Assistant</h2>
      <div class="notice info"><b>The AI assistant is not configured.</b> No answers are simulated. Everything else in the portal works without it.</div>
      ${core.isSuper(req.user) ? html`<p class="small">To turn it on, add <span class="mono">ANTHROPIC_API_KEY</span> (and optionally <span class="mono">AI_MODEL</span>) to the saraydar-api service settings on Render. See docs/AI.md.</p>` : html`<p class="small">Ask the Super Admin if you would like it enabled.</p>`}
      ${disclosure}</section>`));
    res.send(page(req, a, html`<section class="panel"><h2 class="h">Assistant</h2>${form(req, a)}${disclosure}</section>`));
  });

  r.post('/w/:id/assistant', async (req, res) => {
    const a = await access(req);
    if (!cfg()) return res.redirect(`/w/${a.ws.id}/assistant`);
    const q = String(req.body.q || '').trim().slice(0, MAX_Q);
    if (!q) throw Object.assign(new Error('Type a question.'), { status: 400 });
    const used = (await pool.query("select count(*)::int as n from audit_events where actor_id = $1 and action = 'ai.asked' and at > now() - interval '1 hour'", [req.user.id])).rows[0].n;
    if (used >= PER_HOUR) throw Object.assign(new Error(`You have asked ${PER_HOUR} questions in the last hour. Please try again later.`), { status: 429 });
    const c = await contextFor(a);
    await core.audit(null, { actor: req.user, workspaceId: a.ws.id, action: 'ai.asked', entity: 'workspace', entityId: a.ws.id, summary: `Asked the AI assistant: ${q.slice(0, 140)}`, after: { model: cfg().model, context_chars: c.text.length }, ip: req.ip });
    let answer, err = null;
    try { answer = await ask(q, c.text); } catch (e) { err = e.message || 'The AI provider could not be reached.'; }
    res.send(page(req, a, html`<section class="panel"><h2 class="h">Assistant</h2>
      <div class="ai-q"><span class="muted small">You asked</span><p class="pre-line">${q}</p></div>
      ${err ? html`<div class="notice warn">${err} Nothing was changed.</div>` : html`<div class="ai-a"><div class="row-between"><span class="pill pill-info">AI suggestion — not verified</span><span class="muted small">${cfg().model} · ${fmtDateTime(new Date())}</span></div><div class="pre-line">${answer || '(no answer)'}</div></div>
        <p class="small">Based on: ${c.sources.map(([l, h], i) => html`${i ? ', ' : ''}<a href="${h}">${l}</a>`)}</p>`}
      ${form(req, a)}${disclosure}</section>`));
  });
}

module.exports = { mountAssistant, aiConfig };
