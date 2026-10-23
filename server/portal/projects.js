'use strict';
// SarayDar Real Estate Development workspaces: guided setup, plan & baseline, tasks, budget & cost,
// progress updates with photos, registers and units. Every nested record is looked up together with
// its workspace ID, so an ID from another workspace is never reachable.
const multer = require('multer');
const sharp = require('sharp');
const crypto = require('crypto');
const { layout, html, raw, pill, statusPill, csrfField, emptyState, field, fmtDate, fmtDateTime } = require('./views');
const { SECTIONS, KIND_LABEL } = require('./core');
const { parseMoney, formatMoney, toInput, num } = require('../lib/money');
const progress = require('../lib/progress');
const SETUPS = { dev: require('../lib/setup-dev'), cpm: require('../lib/setup-cpm') };
const { sniff } = require('./workspaces');

const UUID = /^[0-9a-f-]{36}$/i;
const PROJECT_SECTIONS = new Set(['dev', 'cpm']);
const bad = m => Object.assign(new Error(m), { status: 400 });
const txt = (v, n = 300) => { const s = String(v ?? '').trim().slice(0, n); return s || null; };
const dateOrNull = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : null;
const todayBH = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bahrain' });
const fm = (m, c = 'BHD') => m === null || m === undefined ? '—' : formatMoney(m, c);
const pct = v => v === null || v === undefined ? '—' : `${Math.round(v * 10) / 10}%`;
const iso = d => d ? (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)) : null;
const TASK_STATUS = { not_started: 'Not started', in_progress: 'In progress', blocked: 'Blocked', done: 'Done', cancelled: 'Cancelled' };
const TASK_TONE = { not_started: 'muted', in_progress: 'warn', blocked: 'bad', done: 'ok', cancelled: 'muted' };
const REG = {
  risk: { label: 'Risks', one: 'risk', statuses: ['open', 'mitigating', 'closed'] },
  issue: { label: 'Issues', one: 'issue', statuses: ['open', 'in_progress', 'resolved'] },
  decision: { label: 'Decisions', one: 'decision', statuses: ['pending', 'decided', 'withdrawn'] },
  change: { label: 'Changes', one: 'change request', statuses: ['proposed', 'approved', 'rejected', 'implemented'] },
  permit: { label: 'Permits & approvals', one: 'approval', statuses: ['open', 'submitted', 'obtained', 'not_required'] },
  stakeholder: { label: 'Stakeholders', one: 'stakeholder', statuses: ['active', 'inactive'] },
  procurement: { label: 'Procurement', one: 'procurement item', statuses: ['planned', 'tendering', 'awarded', 'cancelled'] },
  quality: { label: 'Quality & inspections', one: 'inspection item', statuses: ['open', 'passed', 'failed', 'closed'] },
  meeting: { label: 'Meetings', one: 'meeting', statuses: ['scheduled', 'held', 'cancelled'] },
  handover: { label: 'Handover & defects', one: 'item', statuses: ['open', 'fixed', 'verified', 'closed'] }
};
const COMMIT_KIND = { contract: 'Contract', order: 'Purchase order', appointment: 'Consultant appointment', variation: 'Approved variation' };
const DOC_TYPE = { invoice: 'Invoice', payment_application: 'Contractor payment application', consultant_fee: 'Consultant fee', variation: 'Variation' };
const PAYER = { client: 'Client (direct)', on_behalf: 'SarayDar on the client\'s behalf (exceptional)', other: 'Other party' };
const humanize = s => String(s || '').replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 12, fields: 30 } });

function mountProjects(r, ctx) {
  const { pool, core, NotFound, Forbidden } = ctx;

  async function access(req, need = 'view') {
    const a = await core.workspaceAccess(req.user, req.params.id);
    if (!a || !PROJECT_SECTIONS.has(a.ws.section)) throw new NotFound();
    if (!a.internal) throw new NotFound();               // external project views arrive with the portal in Phase 7
    if (need === 'edit' && !core.canEdit(a)) throw new Forbidden('Only the workspace manager or an editor can do this.');
    if (need === 'contribute' && !core.canContribute(a)) throw new Forbidden('Your role in this workspace is view-only.');
    if (need === 'manage' && !(core.isSuper(req.user) || a.role === 'manager')) throw new Forbidden('Only the workspace manager can approve the plan.');
    a.finance = core.isSuper(req.user) || a.role === 'manager' || a.role === 'editor' || await core.can(req.user, 'view:financials');
    return a;
  }
  const own = async (table, id, wsId) => {
    if (!UUID.test(String(id))) throw new NotFound();
    const row = (await pool.query(`select * from ${table} where id = $1 and workspace_id = $2`, [id, wsId])).rows[0];
    if (!row) throw new NotFound();
    return row;
  };
  const touch = (db, wsId) => db.query('update workspaces set updated_at = now() where id = $1', [wsId]);

  const budgetTab = a => a.ws.section === 'cpm' ? 'Client Budget & Payments' : 'Budget & Cost';
  function tabs(a, cur) {
    const id = a.ws.id;
    if (a.ws.section === 'cpm') return [['Overview', `/w/${id}`], ['Client & Agreement', `/w/${id}/client`], ['Setup', `/w/${id}/setup`], ['Land & Plots', `/w/${id}/plots`], ['Plan', `/w/${id}/plan`], ['Tasks & Schedule', `/w/${id}/tasks`],
      ...(a.finance !== false ? [['Client Budget & Payments', `/w/${id}/budget`], ['Fee Billing', `/w/${id}/fees`]] : []), ['Client Approvals', `/w/${id}/approvals`], ['Progress Updates', `/w/${id}/updates`], ['Registers', `/w/${id}/registers`],
      ['Agreements', `/w/${id}/agreements`], ['Documents', `/w/${id}/documents`], ['Reports', `/w/${id}/reports`], ['Access & Invitations', `/w/${id}/access`], ['Activity', `/w/${id}/activity`]]
      .map(([l, h]) => [l, h, l === cur]);
    return [['Overview', `/w/${id}`], ['Setup', `/w/${id}/setup`], ['Land & Plots', `/w/${id}/plots`], ['Plan', `/w/${id}/plan`], ['Tasks & Schedule', `/w/${id}/tasks`],
      ...(a.finance !== false ? [['Budget & Cost', `/w/${id}/budget`]] : []), ['Progress Updates', `/w/${id}/updates`], ['Registers', `/w/${id}/registers`],
      ['Units & Sales', `/w/${id}/units`], ['Agreements', `/w/${id}/agreements`], ['Documents', `/w/${id}/documents`], ['Reports', `/w/${id}/reports`], ['Access & Invitations', `/w/${id}/access`], ['Activity', `/w/${id}/activity`]]
      .map(([l, h]) => [l, h, l === cur]);
  }
  function page(req, a, cur, body) {
    const w = a.ws, s = SECTIONS[w.section];
    return layout(req, { title: `${cur} · ${w.name}`, heading: w.name, tabs: tabs(a, cur),
      crumbs: [['Home', '/'], [s.name, `/s/${w.section}`], [w.name, `/w/${w.id}`], [cur]],
      sub: { above: `${w.ref} · ${KIND_LABEL[w.kind]}`, below: [w.location, w.stage ? `Stage: ${w.stage}` : null].filter(Boolean).join(' · ') },
      actions: statusPill(w.status), body });
  }

  ctx.tabsFor = ctx.tabsFor || {};
  ctx.tabsFor.dev = (a, cur) => tabs(a, cur);
  ctx.tabsFor.cpm = (a, cur) => tabs(a, cur);

  // ---------- shared loaders ----------
  async function plans(wsId) {
    const rows = (await pool.query(`select p.*, coalesce(nullif(u.name,''), u.email) as approver, coalesce(nullif(c.name,''), c.email) as creator
      from plans p left join users u on u.id = p.approved_by left join users c on c.id = p.created_by where p.workspace_id = $1 order by version desc`, [wsId])).rows;
    return { all: rows, approved: rows.find(p => p.status === 'approved') || null, draft: rows.find(p => p.status === 'draft') || null };
  }
  const loadPhases = wsId => pool.query('select * from phases where workspace_id = $1 and archived_at is null order by sort, created_at', [wsId]).then(r => r.rows);
  const loadTasks = wsId => pool.query('select * from tasks where workspace_id = $1 and archived_at is null order by sort, created_at', [wsId]).then(r => r.rows);

  async function metrics(wsId) {
    const [pl, phases, tasks] = await Promise.all([plans(wsId), loadPhases(wsId), loadTasks(wsId)]);
    const today = todayBH();
    const ov = progress.overall({ phases, tasks, approved: !!pl.approved });
    const planned = pl.approved ? progress.plannedAt(pl.approved.baseline, today) : { available: false, reason: 'No approved baseline.' };
    const open = tasks.filter(t => !['done', 'cancelled'].includes(t.status));
    const overdue = open.filter(t => t.due_date && iso(t.due_date) < today);
    const next = open.filter(t => t.is_milestone).sort((x, y) => (iso(x.due_date) || '9999').localeCompare(iso(y.due_date) || '9999'))[0] || null;
    const risks = (await pool.query("select count(*) filter (where status <> 'closed')::int as open, count(*) filter (where status <> 'closed' and impact = 'High')::int as high from register_items where workspace_id = $1 and kind = 'risk' and archived_at is null", [wsId])).rows[0];
    return { pl, phases, tasks, ov, planned, overdue, next, risks, today };
  }

  async function budgetSummary(wsId) {
    const lines = (await pool.query('select * from budget_lines where workspace_id = $1 and archived_at is null order by sort, created_at', [wsId])).rows;
    const agg = async (sql) => Object.fromEntries((await pool.query(sql, [wsId])).rows.map(x => [x.k, num(x.v)]));
    const committed = await agg("select budget_line_id as k, sum(value_minor) as v from commitments where workspace_id = $1 and status <> 'cancelled' group by 1");
    const invoiced = await agg("select budget_line_id as k, sum(amount_minor) as v from cost_invoices where workspace_id = $1 and status = 'approved' group by 1");
    const invoicedOnCommit = await agg("select budget_line_id as k, sum(amount_minor) as v from cost_invoices where workspace_id = $1 and status = 'approved' and commitment_id is not null group by 1");
    const paid = await agg("select budget_line_id as k, sum(amount_minor) as v from cost_payments where workspace_id = $1 and status = 'confirmed' group by 1");
    const pending = await agg("select budget_line_id as k, sum(amount_minor) as v from cost_payments where workspace_id = $1 and status = 'pending' group by 1");
    const paidNoInvoice = await agg("select budget_line_id as k, sum(amount_minor) as v from cost_payments where workspace_id = $1 and status = 'confirmed' and invoice_id is null group by 1");
    const paidNoInvoiceOnCommit = await agg("select budget_line_id as k, sum(amount_minor) as v from cost_payments where workspace_id = $1 and status = 'confirmed' and invoice_id is null and commitment_id is not null group by 1");
    const rows = lines.map(l => {
      const c = committed[l.id] || 0;
      // incurred = approved invoices + confirmed payments made without an invoice (never both for the same cost)
      const inc = (invoiced[l.id] || 0) + (paidNoInvoice[l.id] || 0);
      const usedOfCommit = (invoicedOnCommit[l.id] || 0) + (paidNoInvoiceOnCommit[l.id] || 0);
      const openCommit = Math.max(0, c - usedOfCommit);
      const fc = l.forecast_uncommitted_minor === null ? null : num(l.forecast_uncommitted_minor);
      const eac = fc === null ? null : inc + openCommit + fc;
      return { ...l, original: num(l.original_minor), revised: num(l.revised_minor), committed: c, incurred: inc, paid: paid[l.id] || 0, pending: pending[l.id] || 0, openCommit, forecast: fc, eac };
    });
    const sum = k => rows.reduce((s, x) => s + (x[k] || 0), 0);
    const anyNull = k => rows.some(x => x[k] === null);
    const total = { original: anyNull('original') ? null : sum('original'), revised: anyNull('revised') ? null : sum('revised'), committed: sum('committed'), incurred: sum('incurred'), paid: sum('paid'), pending: sum('pending'), openCommit: sum('openCommit'), eac: anyNull('eac') || !rows.length ? null : sum('eac') };
    const unassigned = (await pool.query(`select
      (select coalesce(sum(value_minor),0) from commitments where workspace_id = $1 and budget_line_id is null and status <> 'cancelled') as c,
      (select coalesce(sum(amount_minor),0) from cost_invoices where workspace_id = $1 and budget_line_id is null and status = 'approved') as i`, [wsId])).rows[0];
    return { rows, total, unassigned: { committed: num(unassigned.c), invoiced: num(unassigned.i) } };
  }

  // ---------- overview block (used by the workspace Overview page) ----------
  ctx.overviewExtras = ctx.overviewExtras || {};
  ctx.overviewExtras.dev = async (req, wsAccess) => {
    const a = await core.workspaceAccess(req.user, wsAccess.ws.id);
    if (!a || !a.internal) return '';
    const finance = core.isSuper(req.user) || a.role === 'manager' || a.role === 'editor' || await core.can(req.user, 'view:financials');
    const m = await metrics(a.ws.id);
    const draft = (await pool.query('select status, answers from setup_drafts where workspace_id = $1', [a.ws.id])).rows[0];
    const bs = finance ? await budgetSummary(a.ws.id) : null;
    const upd = (await pool.query(`select u.*, (select array_agg(f.id order by f.uploaded_at) from files f where f.entity = 'progress_update' and f.entity_id = u.id::text and f.archived_at is null and f.thumb is not null) as photos
      from progress_updates u where u.workspace_id = $1 and u.status = 'published' and u.archived_at is null order by u.observed_on desc, u.created_at desc limit 1`, [a.ws.id])).rows[0];
    const id = a.ws.id;
    return html`
      ${!draft && !m.tasks.length ? html`<div class="notice">Start with the guided setup: it asks what is known about this project and prepares a draft plan for review. <a href="/w/${id}/setup">Open setup</a></div>` : ''}
      <section class="grid-cards" aria-label="Indicators">
        <div class="card"><div class="muted small">Overall progress</div>
          ${m.ov.available ? html`<div class="big">${pct(m.ov.pct)}</div><div class="bar"><span style="width:${Math.min(100, m.ov.pct)}%"></span></div>
            <div class="muted small">${m.planned.available ? `Planned today: ${pct(m.planned.pct)} · variance ${pct(m.ov.pct - m.planned.pct)}` : `Planned: not available — ${m.planned.reason}`}</div>`
            : html`<div class="big muted">Not available</div><div class="muted small">${m.ov.reason} Method: weighted task completion.</div>`}
          <a class="small" href="/w/${id}/plan">How it is calculated</a></div>
        <div class="card"><div class="muted small">Next milestone</div>
          ${m.next ? html`<div class="mid">${m.next.title}</div><div class="muted small">${m.next.due_date ? `Due ${fmtDate(m.next.due_date)}` : 'Due date not yet determined'}${m.next.owner_text ? ` · ${m.next.owner_text}` : ''}</div>` : html`<div class="mid muted">None open</div>`}</div>
        <div class="card"><div class="muted small">Tasks</div><div class="big">${m.tasks.length}</div>
          <div class="muted small">${m.tasks.filter(t => t.status === 'in_progress').length} in progress · ${m.tasks.filter(t => t.status === 'done').length} done · <span class="${m.overdue.length ? 'err' : ''}">${m.overdue.length} overdue</span></div></div>
        <div class="card"><div class="muted small">Open risks</div><div class="big">${m.risks.open}</div><div class="muted small">${m.risks.high} with high impact</div></div>
      </section>
      <div class="split">
        ${finance ? html`<section class="panel grow1"><h2 class="h">${a.ws.section === 'cpm' ? 'Client budget & payments' : raw('Budget &amp; cost')}</h2>
          <table class="kv"><tbody>
            <tr><th>Approved budget (baseline)</th><td>${bs.total.original === null ? html`<span class="muted">No baseline yet</span>` : fm(bs.total.original)}</td></tr>
            <tr><th>Current budget</th><td>${bs.total.revised === null ? html`<span class="muted">Incomplete: ${bs.rows.filter(x => x.revised === null).length} lines not set</span>` : fm(bs.total.revised)}</td></tr>
            <tr><th>Committed</th><td>${fm(bs.total.committed)}</td></tr>
            <tr><th>Incurred</th><td>${fm(bs.total.incurred)}</td></tr>
            <tr><th>Paid (confirmed)</th><td>${fm(bs.total.paid)}</td></tr>
            <tr><th>Estimate at completion</th><td>${bs.total.eac === null ? html`<span class="muted">Inputs missing</span>` : fm(bs.total.eac)}</td></tr>
          </tbody></table><a class="small" href="/w/${id}/budget">Open budget</a></section>` : ''}
        <section class="panel grow2"><h2 class="h">Latest published update</h2>
          ${upd ? html`<p><b>${upd.title}</b><br><span class="muted small">Observed ${fmtDate(upd.observed_on)} · ${upd.author_label || ''}</span></p>
            ${upd.completed_work ? html`<p>${upd.completed_work}</p>` : ''}
            ${upd.photos && upd.photos.length ? html`<div class="gallery">${upd.photos.slice(0, 4).map(f => html`<a href="/files/${f}"><img src="/files/${f}/thumb" alt="Photo from ${upd.title}" loading="lazy"></a>`)}</div>` : ''}
            <a class="small" href="/w/${id}/updates/${upd.id}">Open update</a>` : html`<p class="muted">No published updates yet.</p><a class="btn" href="/w/${id}/updates/new">+ Progress update</a>`}
        </section>
      </div>`;
  };

  // portfolio columns for the section list
  ctx.portfolioExtras = ctx.portfolioExtras || {};
  ctx.portfolioExtras.dev = async ids => {
    const out = {};
    for (const id of ids) {
      const m = await metrics(id);
      out[id] = { progress: m.ov.available ? pct(m.ov.pct) : 'Not available', next: m.next ? `${m.next.title}${m.next.due_date ? ` · ${fmtDate(m.next.due_date)}` : ''}` : '—', alerts: m.overdue.length + m.risks.high };
    }
    return out;
  };

  // ---------- setup questionnaire ----------
  async function loadDraft(wsId) {
    return (await pool.query('select * from setup_drafts where workspace_id = $1', [wsId])).rows[0] || { answers: {}, status: 'draft', step: null };
  }
  r.get('/w/:id/setup', async (req, res) => {
    const a = await access(req);
    const d = await loadDraft(a.ws.id);
    const setup = SETUPS[a.ws.section];
    const next = setup.STEPS.find(s => !s.fields.some(f => f.k in d.answers));
    res.redirect(`/w/${a.ws.id}/setup/${d.status === 'reviewed' || !next ? 'review' : next.key}`);
  });

  function stepNav(a, d, cur) {
    const setup = SETUPS[a.ws.section];
    return html`<nav class="steps-nav" aria-label="Setup steps"><ol>${[...setup.STEPS, { key: 'review', title: 'Review' }].map((s, i) => {
      const done = s.key !== 'review' && s.fields.some(f => f.k in d.answers);
      return html`<li class="${s.key === cur ? 'on' : done ? 'done' : ''}"><a href="/w/${a.ws.id}/setup/${s.key}" ${s.key === cur ? raw('aria-current="step"') : ''}><span>${i + 1}</span>${s.title}</a></li>`;
    })}</ol></nav>`;
  }

  r.get('/w/:id/setup/review', async (req, res) => {
    const a = await access(req);
    const d = await loadDraft(a.ws.id);
    const setup = SETUPS[a.ws.section];
    const noTerms = a.ws.section === 'cpm' && !(await pool.query("select 1 from mgmt_terms where workspace_id = $1 and status = 'active'", [a.ws.id])).rowCount;
    const rv = setup.review(d.answers, { noTerms });
    const pl = await plans(a.ws.id);
    const tasks = (await pool.query('select count(*)::int as n from tasks where workspace_id = $1 and archived_at is null', [a.ws.id])).rows[0].n;
    const plotSum = (await pool.query('select count(*)::int as n, sum(area_m2) as area, count(area_m2)::int as with_area from plots where workspace_id = $1 and archived_at is null', [a.ws.id])).rows[0];
    const plotsAns = setup.val(d.answers, 'plots_count');
    if (plotsAns !== undefined && plotSum.n !== Number(plotsAns)) rv.conflicts.push(`Setup says ${plotsAns} plot(s), but ${plotSum.n} are recorded under Land & Plots.`);
    const show = (f, x) => {
      if (!x) return html`<span class="muted">—</span>`;
      if (x.unknown) return pill('Not yet determined', 'info');
      if (f.type === 'money') return fm(x.v);
      if (f.type === 'select') return (f.options.find(o => o[0] === x.v) || [, x.v])[1];
      if (f.type === 'date') return fmtDate(x.v);
      return String(x.v);
    };
    res.send(page(req, a, 'Setup', html`${stepNav(a, d, 'review')}
      <section class="panel"><h2 class="h">Review</h2>
        <div class="split">
          <div class="grow1"><h3 class="h3">Missing</h3>${rv.missing.length ? html`<ul>${rv.missing.map(m => html`<li>${m.label}${m.required ? html` ${pill('Required', 'bad')}` : ''} <a href="/w/${a.ws.id}/${m.href || `setup/${m.step}`}">add</a></li>`)}</ul>` : html`<p class="muted">Nothing missing.</p>`}</div>
          <div class="grow1"><h3 class="h3">Not yet determined</h3>${rv.unknown.length ? html`<ul>${rv.unknown.map(u => html`<li>${u}</li>`)}</ul>` : html`<p class="muted">None.</p>`}</div>
          <div class="grow1"><h3 class="h3">Conflicts to check</h3>${rv.conflicts.length ? html`<ul>${rv.conflicts.map(c => html`<li class="err">${c}</li>`)}</ul>` : html`<p class="muted">None found.</p>`}</div>
        </div></section>
      <section class="panel"><div class="row-between"><h2 class="h">Plots</h2><a class="btn small" href="/w/${a.ws.id}/plots">Land &amp; Plots</a></div>
        <p>${plotSum.n ? `${plotSum.n} plot(s) recorded${plotSum.with_area ? `, ${Number(plotSum.area).toLocaleString('en-US')} m² in total${plotSum.with_area < plotSum.n ? ` (${plotSum.n - plotSum.with_area} without an area)` : ''}` : ''}.` : 'No plots recorded yet. Projects on several plots should list each one.'} Each recorded plot gets its own title and survey check in the draft plan.</p></section>
      ${setup.STEPS.map(s => html`<section class="panel"><div class="row-between"><h2 class="h">${s.title}</h2><a class="btn small" href="/w/${a.ws.id}/setup/${s.key}">Edit</a></div>
        <dl class="details">${s.fields.map(f => html`<div><dt>${f.label}</dt><dd class="pre-line">${show(f, d.answers[f.k])}</dd></div>`)}</dl></section>`)}
      <section class="panel"><h2 class="h">Draft plan</h2>
        ${tasks ? html`<p>This workspace already has ${tasks} tasks${pl.draft ? ' in a draft plan' : ''}. Edit them under <a href="/w/${a.ws.id}/tasks">Tasks &amp; Schedule</a> and approve under <a href="/w/${a.ws.id}/plan">Plan</a>.</p>`
          : core.canEdit(a) ? html`<p>Generate an editable draft: phases, tasks and milestones for this type and stage, a risk register, an approvals tracker, a stakeholder list and budget lines. Suggested items are labelled and carry no dates or costs until you add them.</p>
            ${rv.ready ? html`<form method="post" action="/w/${a.ws.id}/plan/generate">${csrfField(req)}<button class="btn primary" type="submit">Generate draft plan</button></form>` : html`<p class="err">Answer the required questions first.</p>`}`
          : html`<p class="muted">A manager or editor can generate the draft plan.</p>`}
      </section>`));
  });

  r.get('/w/:id/setup/:step', async (req, res) => {
    const a = await access(req);
    const setup = SETUPS[a.ws.section];
    const step = setup.STEPS.find(s => s.key === req.params.step);
    if (!step) throw new NotFound();
    const d = await loadDraft(a.ws.id);
    const ro = !core.canEdit(a);
    const idx = setup.STEPS.indexOf(step);
    const input = f => {
      const x = d.answers[f.k];
      const value = !x || x.unknown ? '' : f.type === 'money' ? toInput(x.v) : x.v;
      const opts = f.type === 'select' ? [['', 'Choose…'], ...f.options] : null;
      return html`<div class="q">${field({ name: f.k, label: f.label, type: f.type === 'money' ? 'text' : f.type, value, required: f.required, hint: f.hint || '', options: opts,
        attrs: `${f.type === 'money' ? 'inputmode="decimal" placeholder="0.000"' : ''} ${f.type === 'number' ? 'step="any" min="0" inputmode="decimal"' : ''} ${ro ? 'disabled' : ''}`, full: f.type === 'textarea' })}
        ${f.noUnknown || f.required ? '' : html`<label class="check small"><input type="checkbox" name="${f.k}__unknown" value="1" ${x && x.unknown ? raw('checked') : ''} ${ro ? raw('disabled') : ''}> Not yet determined</label>`}</div>`;
    };
    res.send(page(req, a, 'Setup', html`${stepNav(a, d, step.key)}
      <form method="post" action="/w/${a.ws.id}/setup/${step.key}" class="panel">${csrfField(req)}
        <h2 class="h">${idx + 1}. ${step.title}</h2>${step.intro ? html`<p class="muted">${step.intro}</p>` : ''}
        <div class="form-grid">${step.fields.map(input)}</div>
        ${ro ? html`<p class="muted">View only.</p>` : html`<div class="actions sticky-actions">
          ${idx > 0 ? html`<button class="btn" type="submit" name="go" value="${setup.STEPS[idx - 1].key}">Back</button>` : ''}
          <button class="btn" type="submit" name="go" value="stay">Save</button>
          <button class="btn primary" type="submit" name="go" value="${idx + 1 < setup.STEPS.length ? setup.STEPS[idx + 1].key : 'review'}">Save and continue</button></div>`}
        <p class="muted small">Answers are saved for this project only. You can leave and continue later.</p>
      </form>`));
  });

  r.post('/w/:id/setup/:step', async (req, res) => {
    const a = await access(req, 'edit');
    const setup = SETUPS[a.ws.section];
    const step = setup.STEPS.find(s => s.key === req.params.step);
    if (!step) throw new NotFound();
    const vals = setup.readStep(step, req.body);
    await core.inTx(async db => {
      const cur = (await db.query('select answers from setup_drafts where workspace_id = $1 for update', [a.ws.id])).rows[0];
      const answers = { ...(cur ? cur.answers : {}) };
      for (const [k, v] of Object.entries(vals)) { if (v === null) delete answers[k]; else answers[k] = v; }
      // keep empty-but-visited steps recognisable
      if (!step.fields.some(f => f.k in answers)) answers[`_${step.key}`] = { v: 'visited' };
      await db.query(`insert into setup_drafts (workspace_id, answers, step, updated_by, updated_at) values ($1,$2,$3,$4,now())
        on conflict (workspace_id) do update set answers = excluded.answers, step = excluded.step, updated_by = excluded.updated_by, updated_at = now()`, [a.ws.id, answers, step.key, req.user.id]);
      if (step.key === 'stage' && setup.val(answers, 'stage')) {
        const label = (step.fields[0].options.find(o => o[0] === setup.val(answers, 'stage')) || [])[1];
        await db.query('update workspaces set stage = $2, updated_at = now() where id = $1', [a.ws.id, label]);
      }
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'setup.saved', entity: 'setup', entityId: a.ws.id, summary: `Setup: ${step.title} saved`, after: vals, ip: req.ip });
    });
    const go = req.body.go === 'stay' ? step.key : [...setup.STEPS.map(s => s.key), 'review'].includes(req.body.go) ? req.body.go : step.key;
    res.redirect(`/w/${a.ws.id}/setup/${go}?msg=saved`);
  });

  r.post('/w/:id/plan/generate', async (req, res) => {
    const a = await access(req, 'edit');
    const d = await loadDraft(a.ws.id);
    const setup = SETUPS[a.ws.section];
    if (!setup.review(d.answers).ready) throw bad('Answer the required setup questions first.');
    const g = setup.generate(d.answers);
    await core.inTx(async db => {
      await db.query('select id from workspaces where id = $1 for update', [a.ws.id]);
      const existing = (await db.query('select count(*)::int as n from tasks where workspace_id = $1 and archived_at is null', [a.ws.id])).rows[0].n;
      if (existing) throw bad('This workspace already has tasks. Edit them under Tasks & Schedule.');
      const v = (await db.query('select coalesce(max(version),0)+1 as v from plans where workspace_id = $1', [a.ws.id])).rows[0].v;
      await db.query("insert into plans (workspace_id, version, status, source, note, created_by) values ($1,$2,'draft','generated','Generated from the setup answers. Suggested items need review.',$3) on conflict do nothing", [a.ws.id, v, req.user.id]);
      let ps = 0;
      for (const p of g.phases) {
        const ph = (await db.query('insert into phases (workspace_id, name, sort, suggested_weight, suggested) values ($1,$2,$3,$4,true) returning id', [a.ws.id, p.name, ps++, p.suggested_weight])).rows[0].id;
        let ts = 0;
        for (const t of p.tasks) await db.query('insert into tasks (workspace_id, phase_id, title, status, progress, is_milestone, suggested, verified, sort) values ($1,$2,$3,$4,$5,$6,true,$7,$8)', [a.ws.id, ph, t.title, t.status, t.progress, t.is_milestone, t.verified, ts++]);
      }
      const plotRows = (await db.query('select ref from plots where workspace_id = $1 and archived_at is null order by sort', [a.ws.id])).rows;
      if (plotRows.length) {
        const first = (await db.query('select id from phases where workspace_id = $1 order by sort limit 1', [a.ws.id])).rows[0];
        let ts = 100;
        if (first) for (const p of plotRows) await db.query('insert into tasks (workspace_id, phase_id, title, suggested, sort) values ($1,$2,$3,true,$4)', [a.ws.id, first.id, `Plot ${p.ref}: confirm title deed, survey and dimensions`, ts++]);
      }
      for (const x of [...g.risks, ...g.permits, ...g.stakeholders]) {
        await db.query('insert into register_items (workspace_id, kind, title, status, suggested, extra, created_by) values ($1,$2,$3,$4,$5,$6,$7)',
          [a.ws.id, x.kind, x.title.slice(0, 300), x.status || (x.kind === 'stakeholder' ? 'active' : 'open'), !!x.suggested, x.extra || {}, req.user.id]);
      }
      for (const b of g.budget) await db.query("insert into budget_lines (workspace_id, category, description, revised_minor, source, sort) values ($1,$2,$3,$4,$5,$6)", [a.ws.id, b.category, b.description, b.revised_minor, b.revised_minor === null ? 'suggested' : 'entered', b.sort]);
      await db.query("update setup_drafts set status = 'reviewed' where workspace_id = $1", [a.ws.id]);
      await touch(db, a.ws.id);
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'plan.generated', entity: 'plan', entityId: a.ws.id, summary: `Draft plan generated: ${g.phases.length} phases, ${g.phases.reduce((s, p) => s + p.tasks.length, 0)} tasks`, ip: req.ip });
    });
    res.redirect(`/w/${a.ws.id}/plan?msg=created`);
  });

  // ---------- plan & baseline ----------
  r.get('/w/:id/plan', async (req, res) => {
    const a = await access(req);
    const m = await metrics(a.ws.id);
    const deps = (await pool.query('select d.* from task_deps d join tasks t on t.id = d.task_id where t.workspace_id = $1', [a.ws.id])).rows;
    const byId = Object.fromEntries(m.tasks.map(t => [t.id, t]));
    const usedPhases = m.phases.filter(p => m.tasks.some(t => t.phase_id === p.id));
    const checks = [];
    const noWeight = usedPhases.filter(p => p.weight === null);
    if (noWeight.length) checks.push(['bad', `Phase weights missing: ${noWeight.map(p => p.name).join(', ')}`]);
    const noDates = m.tasks.filter(t => !t.start_date || !t.due_date).length;
    if (noDates) checks.push(['warn', `${noDates} tasks without start and due dates (planned progress will be unavailable)`]);
    const sugg = m.tasks.filter(t => t.suggested).length + m.phases.filter(p => p.suggested).length;
    if (sugg) checks.push(['info', `${sugg} suggested phases/tasks will be accepted as reviewed when you approve`]);
    const unver = m.tasks.filter(t => !t.verified).length;
    if (unver) checks.push(['warn', `${unver} tasks have a reported status that has not been verified`]);
    const seq = deps.filter(d => byId[d.task_id] && byId[d.depends_on] && byId[d.task_id].start_date && byId[d.depends_on].due_date && iso(byId[d.task_id].start_date) < iso(byId[d.depends_on].due_date));
    if (seq.length) checks.push(['warn', `${seq.length} tasks start before a task they depend on is due`]);
    const canApprove = (core.isSuper(req.user) || a.role === 'manager') && m.tasks.length && !noWeight.length;
    const anySuggestedWeight = m.phases.some(p => p.weight === null && p.suggested_weight !== null);
    res.send(page(req, a, 'Plan', html`
      <section class="panel"><h2 class="h">Plan status</h2>
        <p>${m.pl.approved ? html`${pill('Approved baseline v' + m.pl.approved.version, 'ok')} approved by ${m.pl.approved.approver || '—'} on ${fmtDateTime(m.pl.approved.approved_at)}` : pill('No approved baseline', 'warn')}
          ${m.pl.draft ? html` · ${pill('Draft v' + m.pl.draft.version + ' in review', 'info')}` : ''}</p>
        ${m.pl.draft && m.pl.draft.note ? html`<p class="muted">${m.pl.draft.note}</p>` : ''}
        <h3 class="h3">Before approval</h3>
        ${checks.length ? html`<ul class="rows">${checks.map(([t, c]) => html`<li>${pill(t === 'bad' ? 'Blocks approval' : t === 'warn' ? 'Check' : 'Note', t)}<span>${c}</span></li>`)}</ul>` : html`<p class="muted">No problems found.</p>`}
        ${anySuggestedWeight && core.canEdit(a) ? html`<form method="post" action="/w/${a.ws.id}/plan/suggested-weights">${csrfField(req)}<button class="btn" type="submit">Use the suggested phase weights</button> <span class="muted small">You can change them afterwards on Tasks &amp; Schedule.</span></form>` : ''}
        ${m.pl.draft || !m.pl.approved ? (canApprove ? html`<form method="post" action="/w/${a.ws.id}/plan/approve" class="form-grid">${csrfField(req)}
            ${field({ name: 'reason', label: m.pl.approved ? 'Reason for this revision' : 'Approval note', required: !!m.pl.approved, type: 'textarea', full: true })}
            <label class="field full check"><input type="checkbox" name="reviewed" value="1" required> <span>I have reviewed the phases, tasks, weights and dates.</span></label>
            <div class="full"><button class="btn primary" type="submit">Approve plan and save baseline</button></div></form>`
          : html`<p class="muted small">${m.tasks.length ? 'The workspace manager approves the plan once every phase with tasks has a weight.' : 'Add tasks or generate a draft plan from Setup first.'}</p>`)
          : core.canEdit(a) ? html`<form method="post" action="/w/${a.ws.id}/plan/revise">${csrfField(req)}<button class="btn" type="submit">Start a revision</button> <span class="muted small">Tasks stay editable at any time; a revision records a new approved baseline with a reason.</span></form>` : ''}
      </section>
      <section class="panel"><h2 class="h">Progress calculation</h2>
        <p>Overall progress = Σ(phase weight × phase %) ÷ Σ phase weights. Phase % = weighted average of its lowest-level tasks (a task's weight defaults to 1; a parent task's own % is ignored so nothing is counted twice; cancelled tasks are excluded). Photos never change progress. Shown only with an approved baseline.</p>
        <div class="table-wrap"><table><thead><tr><th>Phase</th><th class="n">Weight</th><th class="n">Tasks</th><th class="n">Phase %</th></tr></thead><tbody>
          ${m.ov.phases.map(p => html`<tr><td>${p.name}</td><td class="n">${p.weight === null ? html`<span class="muted">not set</span>` : p.weight}</td><td class="n">${p.tasks}</td><td class="n">${pct(p.pct)}</td></tr>`)}
        </tbody></table></div>
        <p><b>Overall:</b> ${m.ov.available ? pct(m.ov.pct) : html`<span class="muted">Not available — ${m.ov.reason}</span>`} · <b>Planned today:</b> ${m.planned.available ? pct(m.planned.pct) : html`<span class="muted">${m.planned.reason}</span>`}</p>
      </section>
      <section class="panel"><h2 class="h">Versions</h2>
        ${m.pl.all.length ? html`<div class="table-wrap"><table><thead><tr><th>Version</th><th>Status</th><th>Source</th><th>Approved</th><th>Reason / note</th></tr></thead><tbody>
          ${m.pl.all.map(p => html`<tr><td>v${p.version}</td><td>${pill(humanize(p.status), p.status === 'approved' ? 'ok' : p.status === 'draft' ? 'info' : 'muted')}</td><td>${humanize(p.source)}</td>
            <td class="small">${p.approved_at ? `${fmtDateTime(p.approved_at)} · ${p.approver || ''}` : '—'}</td><td class="small">${p.revision_reason || p.note || ''}${p.baseline ? html` · <a href="/w/${a.ws.id}/plan/v/${p.version}">baseline</a>` : ''}</td></tr>`)}
        </tbody></table></div>` : html`<p class="muted">No plan yet. Generate one from <a href="/w/${a.ws.id}/setup">Setup</a> or add tasks directly.</p>`}
      </section>`));
  });

  r.get('/w/:id/plan/v/:v', async (req, res) => {
    const a = await access(req);
    const p = (await pool.query('select * from plans where workspace_id = $1 and version = $2', [a.ws.id, parseInt(req.params.v, 10) || 0])).rows[0];
    if (!p || !p.baseline) throw new NotFound();
    const b = p.baseline;
    res.send(page(req, a, 'Plan', html`<p><a href="/w/${a.ws.id}/plan">‹ Plan</a></p><section class="panel"><h2 class="h">Baseline v${p.version}</h2>
      <p class="muted">Saved ${fmtDateTime(p.approved_at)}. ${p.revision_reason || ''}</p>
      ${b.phases.map(ph => html`<h3 class="h3">${ph.name} · weight ${ph.weight}</h3><div class="table-wrap"><table><thead><tr><th>Task</th><th>Start</th><th>Due</th><th class="n">Weight</th></tr></thead><tbody>
        ${b.tasks.filter(t => t.phase_id === ph.id).map(t => html`<tr><td>${t.title}${t.is_milestone ? html` ${pill('Milestone', 'info')}` : ''}</td><td>${fmtDate(t.start_date)}</td><td>${fmtDate(t.due_date)}</td><td class="n">${t.weight ?? 1}</td></tr>`)}</tbody></table></div>`)}
      ${a.finance && b.budget ? html`<h3 class="h3">Budget at approval</h3><table class="kv"><tbody>${b.budget.map(l => html`<tr><th>${l.description}</th><td>${fm(l.revised_minor, l.currency)}</td></tr>`)}</tbody></table>` : ''}
    </section>`));
  });

  r.post('/w/:id/plan/suggested-weights', async (req, res) => {
    const a = await access(req, 'edit');
    await core.inTx(async db => {
      const n = (await db.query('update phases set weight = suggested_weight where workspace_id = $1 and weight is null and suggested_weight is not null', [a.ws.id])).rowCount;
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'plan.weights_applied', entity: 'plan', entityId: a.ws.id, summary: `Applied suggested weights to ${n} phases`, ip: req.ip });
    });
    res.redirect(`/w/${a.ws.id}/plan?msg=saved`);
  });

  r.post('/w/:id/plan/revise', async (req, res) => {
    const a = await access(req, 'edit');
    await core.inTx(async db => {
      const v = (await db.query('select coalesce(max(version),0)+1 as v from plans where workspace_id = $1', [a.ws.id])).rows[0].v;
      await db.query("insert into plans (workspace_id, version, status, source, note, created_by) values ($1,$2,'draft','manual','Revision in progress',$3)", [a.ws.id, v, req.user.id]);
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'plan.revision_started', entity: 'plan', entityId: a.ws.id, summary: `Plan revision v${v} started`, ip: req.ip });
    }).catch(e => { if (e.code === '23505') throw bad('A revision is already in progress.'); throw e; });
    res.redirect(`/w/${a.ws.id}/plan`);
  });

  r.post('/w/:id/plan/approve', async (req, res) => {
    const a = await access(req, 'manage');
    if (req.body.reviewed !== '1') throw bad('Confirm that you have reviewed the plan.');
    const reason = txt(req.body.reason, 1000);
    await core.inTx(async db => {
      await db.query('select id from workspaces where id = $1 for update', [a.ws.id]);
      const pl = (await db.query("select * from plans where workspace_id = $1 and status in ('draft','approved') order by version desc", [a.ws.id])).rows;
      const approved = pl.find(p => p.status === 'approved');
      let draft = pl.find(p => p.status === 'draft');
      if (!draft && approved) throw bad('Start a revision first.');
      if (approved && !reason) throw bad('Give a reason for this revision.');
      const phases = (await db.query('select id, name, sort, weight from phases where workspace_id = $1 and archived_at is null order by sort', [a.ws.id])).rows;
      const tasks = (await db.query('select id, phase_id, parent_id, title, start_date, due_date, weight, is_milestone, status, progress, archived_at from tasks where workspace_id = $1 and archived_at is null order by sort', [a.ws.id])).rows;
      if (!tasks.length) throw bad('Add tasks before approving.');
      if (phases.some(p => p.weight === null && tasks.some(t => t.phase_id === p.id))) throw bad('Every phase with tasks needs a weight.');
      if (!draft) {
        const v = (await db.query('select coalesce(max(version),0)+1 as v from plans where workspace_id = $1', [a.ws.id])).rows[0].v;
        draft = (await db.query("insert into plans (workspace_id, version, status, source, created_by) values ($1,$2,'draft','manual',$3) returning *", [a.ws.id, v, req.user.id])).rows[0];
      }
      await db.query("update budget_lines set original_minor = revised_minor where workspace_id = $1 and original_minor is null and revised_minor is not null", [a.ws.id]);
      const budget = (await db.query('select id, category, description, revised_minor, original_minor, currency from budget_lines where workspace_id = $1 and archived_at is null order by sort', [a.ws.id])).rows;
      const baseline = { phases: phases.map(p => ({ ...p, weight: Number(p.weight) })), tasks: tasks.map(t => ({ ...t, start_date: iso(t.start_date), due_date: iso(t.due_date) })), budget };
      if (approved) await db.query("update plans set status = 'superseded' where id = $1", [approved.id]);
      await db.query("update plans set status = 'approved', baseline = $2, approved_by = $3, approved_at = now(), revision_reason = $4 where id = $1", [draft.id, baseline, req.user.id, reason]);
      await db.query('update tasks set suggested = false where workspace_id = $1', [a.ws.id]);
      await db.query('update phases set suggested = false where workspace_id = $1', [a.ws.id]);
      await touch(db, a.ws.id);
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'plan.approved', entity: 'plan', entityId: draft.id, summary: `Plan v${draft.version} approved as baseline`, after: { reason, tasks: tasks.length, phases: phases.length }, ip: req.ip });
    });
    res.redirect(`/w/${a.ws.id}/plan?msg=saved`);
  });

  // ---------- tasks & schedule ----------
  r.get('/w/:id/tasks', async (req, res) => {
    const a = await access(req);
    const m = await metrics(a.ws.id);
    const filter = ['open', 'overdue', 'milestones', 'all'].includes(req.query.f) ? req.query.f : 'all';
    const today = m.today;
    const show = t => filter === 'all' || (filter === 'open' && !['done', 'cancelled'].includes(t.status)) || (filter === 'overdue' && m.overdue.includes(t)) || (filter === 'milestones' && t.is_milestone);
    const deps = (await pool.query('select d.task_id, count(*)::int as n from task_deps d join tasks t on t.id = d.task_id where t.workspace_id = $1 group by 1', [a.ws.id])).rows;
    const depN = Object.fromEntries(deps.map(d => [d.task_id, d.n]));
    const edit = core.canEdit(a);
    const groups = [...m.phases.map(p => [p, m.tasks.filter(t => t.phase_id === p.id)]), [null, m.tasks.filter(t => !t.phase_id)]].filter(([p, ts]) => p || ts.length);
    const ph = Object.fromEntries(m.ov.phases.map(p => [p.id, p]));
    res.send(page(req, a, 'Tasks & Schedule', html`
      <div class="filters">${[['all', 'All'], ['open', 'Open'], ['overdue', `Overdue (${m.overdue.length})`], ['milestones', 'Milestones']].map(([k, l]) => html`<a class="btn small ${k === filter ? 'primary' : ''}" href="?f=${k}">${l}</a>`)}
        <span class="grow"></span>${!m.tasks.length ? html`<a class="btn" href="/w/${a.ws.id}/setup">Generate from setup</a>` : ''}</div>
      ${groups.length ? groups.map(([p, ts]) => html`<section class="panel">
        <div class="row-between"><h2 class="h">${p ? p.name : 'Not in a phase'}${p && p.suggested ? html` ${pill('Suggested', 'info')}` : ''}</h2>
          ${p ? html`<span class="muted small">Weight ${p.weight === null ? html`<b>not set</b>${p.suggested_weight !== null ? ` (suggested ${Number(p.suggested_weight)})` : ''}` : Number(p.weight)} · Phase ${pct(ph[p.id] && ph[p.id].pct)}</span>` : ''}</div>
        ${ts.length ? html`<div class="table-wrap"><table><thead><tr><th>Task</th><th>Owner</th><th>Start</th><th>Due</th><th>Status</th><th class="n">%</th><th class="n">Weight</th></tr></thead><tbody>
          ${ts.filter(show).map(t => html`<tr class="${m.overdue.includes(t) ? 'late' : ''}"><td><a href="/w/${a.ws.id}/tasks/${t.id}">${t.parent_id ? '↳ ' : ''}${t.title}</a>
              ${t.is_milestone ? html` ${pill('Milestone', 'info')}` : ''}${t.suggested ? html` ${pill('Suggested', 'info')}` : ''}${!t.verified ? html` ${pill('Reported, unverified', 'warn')}` : ''}${depN[t.id] ? html` <span class="muted small">· ${depN[t.id]} dependenc${depN[t.id] === 1 ? 'y' : 'ies'}</span>` : ''}</td>
            <td>${t.owner_text || '—'}</td><td class="small">${fmtDate(t.start_date) || '—'}</td><td class="small">${fmtDate(t.due_date) || '—'}${m.overdue.includes(t) ? html` ${pill('Overdue', 'bad')}` : ''}</td>
            <td>${pill(TASK_STATUS[t.status], TASK_TONE[t.status])}</td><td class="n">${t.status === 'done' ? 100 : t.progress}</td><td class="n">${t.weight === null ? '1' : Number(t.weight)}</td></tr>`)}
        </tbody></table></div>` : html`<p class="muted">No tasks in this phase.</p>`}
        ${p && edit ? html`<details class="inline-form"><summary>Phase settings / add task</summary>
          <form method="post" action="/w/${a.ws.id}/phases/${p.id}" class="form-grid">${csrfField(req)}
            ${field({ name: 'name', label: 'Phase name', value: p.name, required: true })}
            ${field({ name: 'weight', label: 'Weight', value: p.weight === null ? '' : Number(p.weight), type: 'number', attrs: 'min="0" step="any"' })}
            ${field({ name: 'sort', label: 'Order', value: p.sort, type: 'number', attrs: 'step="1"' })}
            <div class="actions full"><button class="btn" type="submit">Save phase</button><button class="btn" type="submit" name="archive" value="1">Archive phase</button></div></form>
          <form method="post" action="/w/${a.ws.id}/tasks" class="form-grid">${csrfField(req)}<input type="hidden" name="phase_id" value="${p.id}">
            ${field({ name: 'title', label: 'New task', required: true })}${field({ name: 'owner_text', label: 'Owner' })}
            ${field({ name: 'start_date', label: 'Start', type: 'date' })}${field({ name: 'due_date', label: 'Due', type: 'date' })}
            <label class="field check"><input type="checkbox" name="is_milestone" value="1"> <span>Milestone</span></label>
            <div class="actions full"><button class="btn primary" type="submit">Add task</button></div></form></details>` : ''}
      </section>`) : emptyState('No tasks yet', 'Generate a draft plan from Setup, or add a phase below.')}
      ${edit ? html`<section class="panel"><h2 class="h">Add a phase</h2><form method="post" action="/w/${a.ws.id}/phases" class="form-grid">${csrfField(req)}
        ${field({ name: 'name', label: 'Phase name', required: true })}${field({ name: 'weight', label: 'Weight (optional)', type: 'number', attrs: 'min="0" step="any"' })}
        <div class="actions full"><button class="btn" type="submit">Add phase</button></div></form></section>` : ''}`));
  });

  r.post('/w/:id/phases', async (req, res) => {
    const a = await access(req, 'edit');
    const name = txt(req.body.name, 120); if (!name) throw bad('Enter a phase name.');
    const w = req.body.weight === '' || req.body.weight === undefined ? null : Number(req.body.weight);
    if (w !== null && (!isFinite(w) || w < 0)) throw bad('Weight must be zero or more.');
    await core.inTx(async db => {
      const s = (await db.query('select coalesce(max(sort),-1)+1 as s from phases where workspace_id = $1', [a.ws.id])).rows[0].s;
      const id = (await db.query('insert into phases (workspace_id, name, weight, sort) values ($1,$2,$3,$4) returning id', [a.ws.id, name, w, s])).rows[0].id;
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'phase.created', entity: 'phase', entityId: id, summary: `Phase added: ${name}`, ip: req.ip });
      await touch(db, a.ws.id);
    });
    res.redirect(`/w/${a.ws.id}/tasks?msg=added`);
  });

  r.post('/w/:id/phases/:pid', async (req, res) => {
    const a = await access(req, 'edit');
    const p = await own('phases', req.params.pid, a.ws.id);
    if (req.body.archive === '1') {
      const n = (await pool.query("select count(*)::int as n from tasks where phase_id = $1 and archived_at is null", [p.id])).rows[0].n;
      if (n) throw bad('Move or archive the tasks in this phase first.');
      await core.inTx(async db => { await db.query('update phases set archived_at = now() where id = $1', [p.id]); await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'phase.archived', entity: 'phase', entityId: p.id, summary: `Phase archived: ${p.name}`, ip: req.ip }); });
      return res.redirect(`/w/${a.ws.id}/tasks?msg=archived`);
    }
    const name = txt(req.body.name, 120); if (!name) throw bad('Enter a phase name.');
    const w = req.body.weight === '' ? null : Number(req.body.weight);
    if (w !== null && (!isFinite(w) || w < 0)) throw bad('Weight must be zero or more.');
    const sort = Number.isInteger(Number(req.body.sort)) ? Number(req.body.sort) : p.sort;
    await core.inTx(async db => {
      await db.query('update phases set name = $2, weight = $3, sort = $4 where id = $1', [p.id, name, w, sort]);
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'phase.updated', entity: 'phase', entityId: p.id, summary: `Phase updated: ${name}`, before: { name: p.name, weight: p.weight === null ? null : Number(p.weight) }, after: { name, weight: w }, ip: req.ip });
      await touch(db, a.ws.id);
    });
    res.redirect(`/w/${a.ws.id}/tasks?msg=saved`);
  });

  function readTask(body, full) {
    const out = {};
    if (full) {
      out.title = txt(body.title, 300); if (!out.title) throw bad('Enter a task title.');
      out.owner_text = txt(body.owner_text, 120);
      out.start_date = dateOrNull(body.start_date); out.due_date = dateOrNull(body.due_date);
      if (out.start_date && out.due_date && out.due_date < out.start_date) throw bad('The due date is before the start date.');
      out.is_milestone = body.is_milestone === '1';
      out.weight = body.weight === '' || body.weight === undefined ? null : Number(body.weight);
      if (out.weight !== null && (!isFinite(out.weight) || out.weight < 0)) throw bad('Weight must be zero or more.');
      out.notes = txt(body.notes, 4000);
    }
    if (body.status !== undefined) { if (!(body.status in TASK_STATUS)) throw bad('Choose a valid status.'); out.status = body.status; }
    if (body.progress !== undefined && body.progress !== '') { const p = Number(body.progress); if (!Number.isInteger(p) || p < 0 || p > 100) throw bad('Progress must be a whole number from 0 to 100.'); out.progress = p; }
    if (out.status === 'done') out.progress = 100;
    if (body.actual_start !== undefined) out.actual_start = dateOrNull(body.actual_start);
    if (body.actual_finish !== undefined) out.actual_finish = dateOrNull(body.actual_finish);
    return out;
  }

  r.post('/w/:id/tasks', async (req, res) => {
    const a = await access(req, 'edit');
    const t = readTask(req.body, true);
    const phase = req.body.phase_id ? await own('phases', req.body.phase_id, a.ws.id) : null;
    await core.inTx(async db => {
      const s = (await db.query('select coalesce(max(sort),-1)+1 as s from tasks where workspace_id = $1 and phase_id is not distinct from $2', [a.ws.id, phase && phase.id])).rows[0].s;
      const id = (await db.query('insert into tasks (workspace_id, phase_id, title, owner_text, start_date, due_date, is_milestone, weight, notes, sort) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id',
        [a.ws.id, phase && phase.id, t.title, t.owner_text, t.start_date, t.due_date, t.is_milestone, t.weight, t.notes, s])).rows[0].id;
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'task.created', entity: 'task', entityId: id, summary: `Task added: ${t.title}`, after: t, ip: req.ip });
      await touch(db, a.ws.id);
    });
    res.redirect(`/w/${a.ws.id}/tasks?msg=added`);
  });

  r.get('/w/:id/tasks/:tid', async (req, res) => {
    const a = await access(req);
    const t = await own('tasks', req.params.tid, a.ws.id);
    const [phases, tasks] = await Promise.all([loadPhases(a.ws.id), loadTasks(a.ws.id)]);
    const deps = (await pool.query('select depends_on from task_deps where task_id = $1', [t.id])).rows.map(x => x.depends_on);
    const comments = (await pool.query(`select c.*, coalesce(nullif(u.name,''), u.email) as who from comments c left join users u on u.id = c.author_id where c.entity = 'task' and c.entity_id = $1 and c.workspace_id = $2 order by c.created_at`, [t.id, a.ws.id])).rows;
    const edit = core.canEdit(a), contrib = core.canContribute(a);
    const dis = edit ? '' : 'disabled';
    const others = tasks.filter(x => x.id !== t.id);
    res.send(page(req, a, 'Tasks & Schedule', html`<p><a href="/w/${a.ws.id}/tasks">‹ All tasks</a></p>
      <form method="post" action="/w/${a.ws.id}/tasks/${t.id}" class="panel form-grid">${csrfField(req)}
        <h2 class="h full">${t.title}${t.suggested ? html` ${pill('Suggested', 'info')}` : ''}${!t.verified ? html` ${pill('Reported, unverified', 'warn')}` : ''}</h2>
        ${field({ name: 'title', label: 'Title', value: t.title, required: true, attrs: dis, full: true })}
        ${field({ name: 'phase_id', label: 'Phase', value: t.phase_id || '', options: [['', 'Not in a phase'], ...phases.map(p => [p.id, p.name])], attrs: dis })}
        ${field({ name: 'parent_id', label: 'Part of task', value: t.parent_id || '', options: [['', '—'], ...others.map(x => [x.id, x.title])], attrs: dis })}
        ${field({ name: 'owner_text', label: 'Owner', value: t.owner_text || '', attrs: dis })}
        ${field({ name: 'weight', label: 'Weight within phase', value: t.weight === null ? '' : Number(t.weight), type: 'number', attrs: `min="0" step="any" ${dis}`, hint: 'Empty counts as 1.' })}
        ${field({ name: 'start_date', label: 'Planned start', value: iso(t.start_date) || '', type: 'date', attrs: dis })}
        ${field({ name: 'due_date', label: 'Planned due', value: iso(t.due_date) || '', type: 'date', attrs: dis })}
        ${field({ name: 'status', label: 'Status', value: t.status, options: Object.entries(TASK_STATUS), attrs: contrib ? '' : 'disabled' })}
        ${field({ name: 'progress', label: 'Progress %', value: t.progress, type: 'number', attrs: `min="0" max="100" step="1" ${contrib ? '' : 'disabled'}` })}
        ${field({ name: 'actual_start', label: 'Actual start', value: iso(t.actual_start) || '', type: 'date', attrs: contrib ? '' : 'disabled' })}
        ${field({ name: 'actual_finish', label: 'Actual finish', value: iso(t.actual_finish) || '', type: 'date', attrs: contrib ? '' : 'disabled' })}
        <label class="field check"><input type="checkbox" name="is_milestone" value="1" ${t.is_milestone ? raw('checked') : ''} ${raw(dis)}> <span>Milestone</span></label>
        ${!t.verified && contrib ? html`<label class="field check"><input type="checkbox" name="verify" value="1"> <span>I have checked the reported status</span></label>` : ''}
        ${field({ name: 'notes', label: 'Notes', value: t.notes || '', type: 'textarea', attrs: dis, full: true })}
        ${edit && others.length ? html`<fieldset class="full deps"><legend>Depends on</legend>${others.map(x => html`<label class="check small"><input type="checkbox" name="deps" value="${x.id}" ${deps.includes(x.id) ? raw('checked') : ''}> ${x.title}</label>`)}</fieldset>` : ''}
        ${contrib ? html`<div class="actions full"><button class="btn primary" type="submit">Save</button>${edit ? html`<button class="btn" type="submit" name="archive" value="1">Archive task</button>` : ''}</div>` : ''}
        ${!edit && contrib ? html`<p class="muted small full">Your role can update status, progress and actual dates.</p>` : ''}
      </form>
      <section class="panel"><h2 class="h">Comments</h2>
        ${comments.length ? html`<ol class="feed">${comments.map(c => html`<li><div class="pre-line">${c.body}</div><div class="muted small">${c.who || ''} · ${fmtDateTime(c.created_at)}</div></li>`)}</ol>` : html`<p class="muted">No comments.</p>`}
        ${contrib ? html`<form method="post" action="/w/${a.ws.id}/comments" class="stack">${csrfField(req)}<input type="hidden" name="entity" value="task"><input type="hidden" name="entity_id" value="${t.id}">
          ${field({ name: 'body', label: 'Add a comment', type: 'textarea', required: true })}<button class="btn" type="submit">Comment</button></form>` : ''}</section>`));
  });

  r.post('/w/:id/tasks/:tid', async (req, res) => {
    const a = await access(req, 'contribute');
    const t = await own('tasks', req.params.tid, a.ws.id);
    const edit = core.canEdit(a);
    if (req.body.archive === '1') {
      if (!edit) throw new Forbidden();
      await core.inTx(async db => { await db.query('update tasks set archived_at = now() where id = $1', [t.id]); await db.query('delete from task_deps where task_id = $1 or depends_on = $1', [t.id]); await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'task.archived', entity: 'task', entityId: t.id, summary: `Task archived: ${t.title}`, ip: req.ip }); await touch(db, a.ws.id); });
      return res.redirect(`/w/${a.ws.id}/tasks?msg=archived`);
    }
    const v = readTask(req.body, edit);
    if (edit) {
      v.phase_id = req.body.phase_id ? (await own('phases', req.body.phase_id, a.ws.id)).id : null;
      v.parent_id = req.body.parent_id ? (await own('tasks', req.body.parent_id, a.ws.id)).id : null;
      if (v.parent_id === t.id) throw bad('A task cannot be part of itself.');
    }
    if (req.body.verify === '1') v.verified = true;
    const newDeps = edit ? [].concat(req.body.deps || []).filter(x => UUID.test(x)) : null;
    await core.inTx(async db => {
      if (newDeps) {
        const valid = (await db.query('select id from tasks where workspace_id = $1 and id = any($2::uuid[]) and archived_at is null', [a.ws.id, newDeps])).rows.map(x => x.id);
        const edges = (await db.query('select d.* from task_deps d join tasks x on x.id = d.task_id where x.workspace_id = $1 and d.task_id <> $2', [a.ws.id, t.id])).rows;
        for (const d of valid) { if (progress.createsCycle(edges, t.id, d)) throw bad('That dependency would create a loop.'); edges.push({ task_id: t.id, depends_on: d }); }
        await db.query('delete from task_deps where task_id = $1', [t.id]);
        for (const d of valid) await db.query('insert into task_deps (task_id, depends_on) values ($1,$2)', [t.id, d]);
      }
      const cols = Object.keys(v);
      if (cols.length) await db.query(`update tasks set ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}, updated_at = now() where id = $1`, [t.id, ...cols.map(c => v[c])]);
      const before = Object.fromEntries(cols.map(c => [c, t[c] instanceof Date ? iso(t[c]) : t[c] === null ? null : (c === 'weight' ? Number(t[c]) : t[c])]));
      const changed = cols.filter(c => JSON.stringify(before[c]) !== JSON.stringify(v[c]));
      if (changed.length || newDeps) await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'task.updated', entity: 'task', entityId: t.id, summary: `Task updated: ${v.title || t.title}${changed.length ? ` (${changed.join(', ')})` : ''}`, before: Object.fromEntries(changed.map(c => [c, before[c]])), after: Object.fromEntries(changed.map(c => [c, v[c]])), ip: req.ip });
      await touch(db, a.ws.id);
    });
    res.redirect(`/w/${a.ws.id}/tasks/${t.id}?msg=saved`);
  });

  r.post('/w/:id/comments', async (req, res) => {
    const a = await access(req, 'contribute');
    const entity = ['task', 'progress_update'].includes(req.body.entity) ? req.body.entity : null;
    if (!entity) throw bad('Unknown item.');
    const target = await own(entity === 'task' ? 'tasks' : 'progress_updates', req.body.entity_id, a.ws.id);
    const body = txt(req.body.body, 4000); if (!body) throw bad('Write a comment.');
    await core.inTx(async db => {
      const id = (await db.query('insert into comments (workspace_id, entity, entity_id, body, author_id) values ($1,$2,$3,$4,$5) returning id', [a.ws.id, entity, target.id, body, req.user.id])).rows[0].id;
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'comment.added', entity: 'comment', entityId: id, summary: `Comment on ${target.title}`, ip: req.ip });
    });
    res.redirect(entity === 'task' ? `/w/${a.ws.id}/tasks/${target.id}` : `/w/${a.ws.id}/updates/${target.id}`);
  });

  // ---------- budget & cost ----------
  async function financeAccess(req, need) {
    const a = await access(req, need);
    if (!a.finance) throw new NotFound();
    return a;
  }
  r.get('/w/:id/budget', async (req, res) => {
    const a = await financeAccess(req);
    const b = await budgetSummary(a.ws.id);
    const commits = (await pool.query('select c.*, l.description as line from commitments c left join budget_lines l on l.id = c.budget_line_id where c.workspace_id = $1 order by c.created_at desc', [a.ws.id])).rows;
    const invoices = (await pool.query('select i.*, l.description as line, c.counterparty as commit_to from cost_invoices i left join budget_lines l on l.id = i.budget_line_id left join commitments c on c.id = i.commitment_id where i.workspace_id = $1 order by i.created_at desc', [a.ws.id])).rows;
    const payments = (await pool.query('select p.*, l.description as line, i.invoice_no from cost_payments p left join budget_lines l on l.id = p.budget_line_id left join cost_invoices i on i.id = p.invoice_id where p.workspace_id = $1 order by p.created_at desc', [a.ws.id])).rows;
    const edit = core.canEdit(a);
    const canConfirm = core.isSuper(req.user) || await core.can(req.user, 'finance:post');
    const lineOpts = [['', 'Not assigned to a line'], ...b.rows.map(l => [l.id, `${l.category} · ${l.description}`])];
    const id = a.ws.id;
    const cpm = a.ws.section === 'cpm';
    res.send(page(req, a, budgetTab(a), html`
      ${cpm ? html`<div class="notice info">These are the <b>client's</b> construction budget and payments. They are never SarayDar revenue or expense. SarayDar's own management fees are kept separately under <a href="/w/${id}/fees">Fee Billing</a>.</div>` : ''}
      <section class="panel"><h2 class="h">${cpm ? 'Client budget lines' : 'Budget lines'} <span class="muted small">BHD</span></h2>
        <div class="table-wrap"><table class="nums"><thead><tr><th>Line</th><th class="n">Baseline</th><th class="n">Current budget</th><th class="n">Committed</th><th class="n">Incurred</th><th class="n">Paid</th><th class="n">Open commitments</th><th class="n">Forecast uncommitted</th><th class="n">Est. at completion</th><th class="n">Variance</th></tr></thead><tbody>
          ${b.rows.map(l => html`<tr><td><b>${l.description}</b><div class="muted small">${l.category}${l.source !== 'entered' ? ` · ${humanize(l.source)}` : ''}${!l.verified ? ' · unverified' : ''}</div></td>
            <td class="n">${fm(l.original)}</td><td class="n">${l.revised === null ? html`<span class="muted">Not set</span>` : fm(l.revised)}</td><td class="n">${fm(l.committed)}</td><td class="n">${fm(l.incurred)}</td>
            <td class="n">${fm(l.paid)}${l.pending ? html`<div class="small warn-text">+${fm(l.pending)} awaiting confirmation</div>` : ''}</td><td class="n">${fm(l.openCommit)}</td>
            <td class="n">${l.forecast === null ? html`<span class="muted">Not estimated</span>` : fm(l.forecast)}</td><td class="n">${l.eac === null ? html`<span class="muted">—</span>` : fm(l.eac)}</td>
            <td class="n">${l.eac === null || l.revised === null ? '—' : fm(l.revised - l.eac)}</td></tr>`)}
          <tr class="total"><td>Total</td><td class="n">${b.total.original === null ? '—' : fm(b.total.original)}</td><td class="n">${b.total.revised === null ? html`<span class="muted">Incomplete</span>` : fm(b.total.revised)}</td><td class="n">${fm(b.total.committed)}</td><td class="n">${fm(b.total.incurred)}</td><td class="n">${fm(b.total.paid)}</td><td class="n">${fm(b.total.openCommit)}</td><td></td><td class="n">${b.total.eac === null ? html`<span class="muted">Inputs missing</span>` : fm(b.total.eac)}</td><td class="n">${b.total.eac === null || b.total.revised === null ? '—' : fm(b.total.revised - b.total.eac)}</td></tr>
        </tbody></table></div>
        ${b.unassigned.committed || b.unassigned.invoiced ? html`<p class="warn-text small">Not assigned to a line: committed ${fm(b.unassigned.committed)}, invoiced ${fm(b.unassigned.invoiced)}.</p>` : ''}
        <details class="small"><summary>How these figures relate</summary><p>Committed = signed contracts and orders. Incurred = approved invoices, plus confirmed payments that had no invoice. Paid = confirmed payments only. Open commitments = committed amounts not yet invoiced or paid. Estimate at completion = incurred + open commitments + forecast uncommitted cost, shown only when the forecast has been entered. A commitment, its invoice and its payment are never added together.</p></details>
      </section>
      ${edit ? html`<section class="panel"><h2 class="h">Edit budget lines</h2>
        ${b.rows.map(l => html`<details class="inline-form"><summary>${l.description}</summary><form method="post" action="/w/${id}/budget/lines/${l.id}" class="form-grid">${csrfField(req)}
          ${field({ name: 'category', label: 'Category', value: l.category, required: true })}${field({ name: 'description', label: 'Description', value: l.description, required: true })}
          ${field({ name: 'revised', label: 'Current budget (BHD)', value: toInput(l.revised), attrs: 'inputmode="decimal"', hint: 'Empty = not yet determined.' })}
          ${field({ name: 'forecast', label: 'Forecast uncommitted cost (BHD)', value: toInput(l.forecast), attrs: 'inputmode="decimal"', hint: 'Cost still expected beyond current commitments.' })}
          ${field({ name: 'notes', label: 'Notes', value: l.notes || '' })}
          ${!l.verified ? html`<label class="field check"><input type="checkbox" name="verify" value="1"> <span>Figures checked</span></label>` : ''}
          <div class="actions full"><button class="btn" type="submit">Save line</button></div></form></details>`)}
        <form method="post" action="/w/${id}/budget/lines" class="form-grid">${csrfField(req)}<h3 class="h3 full">Add a line</h3>
          ${field({ name: 'category', label: 'Category', required: true })}${field({ name: 'description', label: 'Description', required: true })}
          ${field({ name: 'revised', label: 'Budget (BHD)', attrs: 'inputmode="decimal"' })}<div class="actions full"><button class="btn" type="submit">Add line</button></div></form>
      </section>` : ''}
      <section class="panel"><h2 class="h">Commitments (contracts, orders, appointments and variations)</h2>
        ${commits.length ? html`<div class="table-wrap"><table><thead><tr><th>Counterparty</th><th>Line</th><th>Reference</th><th>Date</th><th class="n">Value</th><th>Status</th></tr></thead><tbody>
          ${commits.map(c => html`<tr><td>${c.counterparty} ${c.kind !== 'contract' ? pill(COMMIT_KIND[c.kind] || c.kind, 'info') : ''}${c.description ? html`<div class="muted small">${c.description}</div>` : ''}</td><td class="small">${c.line || '—'}</td><td class="small">${c.reference || '—'}</td><td class="small">${fmtDate(c.committed_on) || '—'}</td><td class="n">${fm(num(c.value_minor), c.currency)}</td><td>${humanize(c.status)}</td></tr>`)}</tbody></table></div>` : html`<p class="muted">None yet.</p>`}
        ${edit ? html`<details class="inline-form"><summary>Add commitment</summary><form method="post" action="/w/${id}/budget/commitments" class="form-grid">${csrfField(req)}
          ${field({ name: 'counterparty', label: 'Contractor / supplier / consultant', required: true })}${field({ name: 'kind', label: 'Type', options: Object.entries(COMMIT_KIND) })}${field({ name: 'budget_line_id', label: 'Budget line', options: lineOpts })}
          ${field({ name: 'value', label: 'Value (BHD)', required: true, attrs: 'inputmode="decimal"' })}${field({ name: 'committed_on', label: 'Date', type: 'date' })}
          ${field({ name: 'reference', label: 'Contract / order reference' })}${field({ name: 'description', label: 'Scope' })}
          <div class="actions full"><button class="btn primary" type="submit">Add commitment</button></div></form></details>` : ''}
      </section>
      <section class="panel"><h2 class="h">${cpm ? 'Contractor payment applications, consultant fees and invoices' : 'Supplier invoices'}</h2>
        ${invoices.length ? html`<div class="table-wrap"><table><thead><tr><th>Supplier</th><th>Invoice</th><th>Line</th><th class="n">Amount</th><th>Status</th><th></th></tr></thead><tbody>
          ${invoices.map(i => html`<tr><td>${i.supplier} ${i.doc_type !== 'invoice' ? pill(DOC_TYPE[i.doc_type] || i.doc_type, 'info') : ''}${i.commit_to ? html`<div class="muted small">against ${i.commit_to}</div>` : ''}</td><td class="small">${i.invoice_no || '—'} · ${fmtDate(i.invoice_date) || 'no date'}</td><td class="small">${i.line || '—'}</td><td class="n">${fm(num(i.amount_minor), i.currency)}</td>
            <td>${pill(humanize(i.status), i.status === 'approved' ? 'ok' : i.status === 'rejected' ? 'bad' : i.status === 'reviewed' ? 'info' : 'warn')}</td>
            <td>${edit && ['submitted', 'reviewed'].includes(i.status) ? html`<form method="post" action="/w/${id}/budget/invoices/${i.id}" class="actions">${csrfField(req)}${i.status === 'submitted' ? html`<button class="btn small" name="decision" value="reviewed">Mark reviewed</button>` : ''}${!cpm || i.status === 'reviewed' ? html`<button class="btn small" name="decision" value="approved">Approve</button>` : ''}<button class="btn small" name="decision" value="rejected">Reject</button></form>` : ''}</td></tr>`)}</tbody></table></div>` : html`<p class="muted">None yet.</p>`}
        ${edit ? html`<details class="inline-form"><summary>Record an invoice</summary><form method="post" action="/w/${id}/budget/invoices" class="form-grid">${csrfField(req)}
          ${field({ name: 'supplier', label: cpm ? 'Contractor / consultant / supplier' : 'Supplier', required: true })}${field({ name: 'doc_type', label: 'Document', options: Object.entries(DOC_TYPE) })}${field({ name: 'invoice_no', label: 'Invoice / application number' })}
          ${field({ name: 'amount', label: 'Amount (BHD)', required: true, attrs: 'inputmode="decimal"' })}${field({ name: 'invoice_date', label: 'Invoice date', type: 'date' })}
          ${field({ name: 'budget_line_id', label: 'Budget line', options: lineOpts })}${field({ name: 'commitment_id', label: 'Against commitment', options: [['', 'None'], ...commits.map(c => [c.id, `${c.counterparty} · ${fm(num(c.value_minor))}`])] })}
          <div class="actions full"><button class="btn primary" type="submit">Record invoice</button></div><p class="muted small full">Submitted → reviewed → approved → paid are separate steps.${cpm ? ' Client projects need a review before approval.' : ''} Recording is not approval; approval is not payment.</p></form></details>` : ''}
      </section>
      <section class="panel"><h2 class="h">Payments</h2>
        ${payments.length ? html`<div class="table-wrap"><table><thead><tr><th>Payee</th><th>For</th><th>Paid on</th><th>Reference</th><th class="n">Amount</th><th>Status</th><th></th></tr></thead><tbody>
          ${payments.map(p => html`<tr><td>${p.payee}<div class="muted small">Payer: ${p.payer}${p.on_behalf ? html` ${pill('On behalf of client', 'warn')}` : ''}${p.approval_ref ? ` · approval ${p.approval_ref}` : ''}</div></td><td class="small">${p.invoice_no ? `Invoice ${p.invoice_no}` : p.line || '—'}${p.notes ? html`<div class="muted">${p.notes}</div>` : ''}</td><td class="small">${fmtDate(p.paid_on) || html`<span class="warn-text">date missing</span>`}</td><td class="small">${p.reference || '—'}</td>
            <td class="n">${fm(num(p.amount_minor), p.currency)}</td><td>${pill(p.status === 'pending' ? 'Awaiting confirmation' : humanize(p.status), p.status === 'confirmed' ? 'ok' : p.status === 'reversed' ? 'muted' : 'warn')}</td>
            <td>${canConfirm && p.status === 'pending' ? html`<form method="post" action="/w/${id}/budget/payments/${p.id}/confirm" class="actions">${csrfField(req)}<input type="date" name="paid_on" aria-label="Paid on" value="${iso(p.paid_on) || ''}" required><button class="btn small" type="submit">Confirm</button></form>` : ''}
              ${canConfirm && p.status === 'confirmed' ? html`<form method="post" action="/w/${id}/budget/payments/${p.id}/reverse" class="actions">${csrfField(req)}<input name="reason" aria-label="Reason" placeholder="Reason" required><button class="btn small" type="submit">Reverse</button></form>` : ''}</td></tr>`)}</tbody></table></div>` : html`<p class="muted">None yet.</p>`}
        ${edit ? html`<details class="inline-form"><summary>Record a payment</summary><form method="post" action="/w/${id}/budget/payments" class="form-grid">${csrfField(req)}
          ${field({ name: 'payee', label: 'Payee', required: true })}${field({ name: 'amount', label: 'Amount (BHD)', required: true, attrs: 'inputmode="decimal"' })}
          ${cpm ? html`${field({ name: 'payer', label: 'Paid by', options: Object.entries(PAYER) })}${field({ name: 'approval_ref', label: 'Client approval for a payment on the client\'s behalf', hint: 'Required only when SarayDar pays on the client\'s behalf: reference of the recorded client approval.' })}` : ''}
          ${field({ name: 'invoice_id', label: 'For invoice', options: [['', 'No invoice'], ...invoices.filter(i => i.status === 'approved').map(i => [i.id, `${i.supplier} ${i.invoice_no || ''} · ${fm(num(i.amount_minor))}`])] })}
          ${field({ name: 'budget_line_id', label: 'Budget line (if no invoice)', options: lineOpts })}
          ${field({ name: 'paid_on', label: 'Paid on', type: 'date' })}${field({ name: 'method', label: 'Method' })}${field({ name: 'reference', label: 'Bank / cheque reference' })}${field({ name: 'notes', label: 'Notes' })}
          <div class="actions full"><button class="btn primary" type="submit">Record payment</button></div><p class="muted small full">A recorded payment stays “awaiting confirmation” until Finance confirms it against the bank record. This system does not make bank payments.</p></form></details>` : ''}
      </section>`));
  });

  const moneyField = (v, label, required = false) => { const m = parseMoney(v, 'BHD'); if (required && (m === null || m <= 0)) throw bad(`Enter ${label}.`); if (m !== null && m < 0) throw bad(`${label} cannot be negative.`); return m; };
  const lineOf = async (id, wsId) => id ? (await own('budget_lines', id, wsId)).id : null;

  r.post('/w/:id/budget/lines', async (req, res) => {
    const a = await financeAccess(req, 'edit');
    const category = txt(req.body.category, 80), description = txt(req.body.description, 200);
    if (!category || !description) throw bad('Enter a category and description.');
    const revised = moneyField(req.body.revised, 'the budget');
    await core.inTx(async db => {
      const s = (await db.query('select coalesce(max(sort),-1)+1 as s from budget_lines where workspace_id = $1', [a.ws.id])).rows[0].s;
      const id = (await db.query('insert into budget_lines (workspace_id, category, description, revised_minor, sort) values ($1,$2,$3,$4,$5) returning id', [a.ws.id, category, description, revised, s])).rows[0].id;
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'budget.line_added', entity: 'budget_line', entityId: id, summary: `Budget line added: ${description}`, after: { category, description, revised }, ip: req.ip });
      await touch(db, a.ws.id);
    });
    res.redirect(`/w/${a.ws.id}/budget?msg=added`);
  });

  r.post('/w/:id/budget/lines/:lid', async (req, res) => {
    const a = await financeAccess(req, 'edit');
    const l = await own('budget_lines', req.params.lid, a.ws.id);
    const category = txt(req.body.category, 80), description = txt(req.body.description, 200);
    if (!category || !description) throw bad('Enter a category and description.');
    const revised = moneyField(req.body.revised, 'the budget'), forecast = moneyField(req.body.forecast, 'the forecast');
    const verified = l.verified || req.body.verify === '1';
    await core.inTx(async db => {
      await db.query('update budget_lines set category = $2, description = $3, revised_minor = $4, forecast_uncommitted_minor = $5, notes = $6, verified = $7 where id = $1', [l.id, category, description, revised, forecast, txt(req.body.notes, 500), verified]);
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'budget.line_updated', entity: 'budget_line', entityId: l.id, summary: `Budget line updated: ${description}`,
        before: { revised: num(l.revised_minor), forecast: num(l.forecast_uncommitted_minor), verified: l.verified }, after: { revised, forecast, verified }, ip: req.ip });
      await touch(db, a.ws.id);
    });
    res.redirect(`/w/${a.ws.id}/budget?msg=saved`);
  });

  r.post('/w/:id/budget/commitments', async (req, res) => {
    const a = await financeAccess(req, 'edit');
    const counterparty = txt(req.body.counterparty, 160); if (!counterparty) throw bad('Enter the contractor or supplier.');
    const value = moneyField(req.body.value, 'the value', true);
    const line = await lineOf(req.body.budget_line_id, a.ws.id);
    await core.inTx(async db => {
      const id = (await db.query('insert into commitments (workspace_id, budget_line_id, counterparty, description, reference, committed_on, value_minor, created_by, kind) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id',
        [a.ws.id, line, counterparty, txt(req.body.description, 300), txt(req.body.reference, 80), dateOrNull(req.body.committed_on), value, req.user.id, COMMIT_KIND[req.body.kind] ? req.body.kind : 'contract'])).rows[0].id;
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'cost.commitment_added', entity: 'commitment', entityId: id, summary: `Commitment: ${counterparty} ${formatMoney(value)}`, ip: req.ip });
      await touch(db, a.ws.id);
    });
    res.redirect(`/w/${a.ws.id}/budget?msg=added`);
  });

  r.post('/w/:id/budget/invoices', async (req, res) => {
    const a = await financeAccess(req, 'edit');
    const supplier = txt(req.body.supplier, 160); if (!supplier) throw bad('Enter the supplier.');
    const amount = moneyField(req.body.amount, 'the amount', true);
    let line = await lineOf(req.body.budget_line_id, a.ws.id);
    const commit = req.body.commitment_id ? await own('commitments', req.body.commitment_id, a.ws.id) : null;
    if (commit && !line) line = commit.budget_line_id;
    try {
      await core.inTx(async db => {
        const id = (await db.query('insert into cost_invoices (workspace_id, budget_line_id, commitment_id, supplier, invoice_no, invoice_date, amount_minor, created_by, doc_type) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id',
          [a.ws.id, line, commit && commit.id, supplier, txt(req.body.invoice_no, 60), dateOrNull(req.body.invoice_date), amount, req.user.id, DOC_TYPE[req.body.doc_type] ? req.body.doc_type : 'invoice'])).rows[0].id;
        await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'cost.invoice_recorded', entity: 'cost_invoice', entityId: id, summary: `Invoice recorded: ${supplier} ${formatMoney(amount)}`, ip: req.ip });
        await touch(db, a.ws.id);
      });
    } catch (e) { if (e.code === '23505') throw bad('That supplier invoice number is already recorded.'); throw e; }
    res.redirect(`/w/${a.ws.id}/budget?msg=added`);
  });

  r.post('/w/:id/budget/invoices/:iid', async (req, res) => {
    const a = await financeAccess(req, 'edit');
    const i = await own('cost_invoices', req.params.iid, a.ws.id);
    const decision = ['reviewed', 'approved', 'rejected'].includes(req.body.decision) ? req.body.decision : null;
    if (!decision) throw bad('Choose review, approve or reject.');
    const from = decision === 'reviewed' ? ['submitted'] : decision === 'approved' && a.ws.section === 'cpm' ? ['reviewed'] : ['submitted', 'reviewed'];
    await core.inTx(async db => {
      const n = decision === 'reviewed'
        ? (await db.query("update cost_invoices set status = 'reviewed', reviewed_by = $2, reviewed_at = now() where id = $1 and status = 'submitted'", [i.id, req.user.id])).rowCount
        : (await db.query('update cost_invoices set status = $2, decided_by = $3, decided_at = now() where id = $1 and status = any($4::text[])', [i.id, decision, req.user.id, from])).rowCount;
      if (!n) throw bad(decision === 'approved' && a.ws.section === 'cpm' && i.status === 'submitted' ? 'Review this item before approving it.' : 'This item is not at a stage where that can be done.');
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: `cost.invoice_${decision}`, entity: 'cost_invoice', entityId: i.id, summary: `Invoice ${decision}: ${i.supplier} ${formatMoney(num(i.amount_minor))}`, ip: req.ip });
      await touch(db, a.ws.id);
    });
    res.redirect(`/w/${a.ws.id}/budget?msg=saved`);
  });

  r.post('/w/:id/budget/payments', async (req, res) => {
    const a = await financeAccess(req, 'edit');
    const payee = txt(req.body.payee, 160); if (!payee) throw bad('Enter the payee.');
    const amount = moneyField(req.body.amount, 'the amount', true);
    const inv = req.body.invoice_id ? await own('cost_invoices', req.body.invoice_id, a.ws.id) : null;
    if (inv && inv.status !== 'approved') throw bad('Only approved invoices can be paid.');
    let line = inv ? inv.budget_line_id : await lineOf(req.body.budget_line_id, a.ws.id);
    const cpm = a.ws.section === 'cpm';
    const payerKey = cpm ? (PAYER[req.body.payer] ? req.body.payer : 'client') : null;
    const approvalRef = txt(req.body.approval_ref, 120);
    if (payerKey === 'on_behalf' && !approvalRef) throw bad('A payment on the client\'s behalf needs the reference of the client\'s approval.');
    const payer = cpm ? (payerKey === 'client' ? 'Client' : payerKey === 'on_behalf' ? 'SarayDar (on behalf of the client)' : 'Other party') : 'SarayDar';
    await core.inTx(async db => {
      if (inv) {
        await db.query('select id from cost_invoices where id = $1 for update', [inv.id]);
        const paid = num((await db.query("select coalesce(sum(amount_minor),0) as s from cost_payments where invoice_id = $1 and status in ('pending','confirmed')", [inv.id])).rows[0].s);
        if (paid + amount > num(inv.amount_minor)) throw bad(`That would pay more than the invoice. Remaining: ${formatMoney(num(inv.amount_minor) - paid)}.`);
      }
      const id = (await db.query('insert into cost_payments (workspace_id, budget_line_id, invoice_id, commitment_id, payee, amount_minor, paid_on, method, reference, notes, created_by, payer, on_behalf, approval_ref) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id',
        [a.ws.id, line, inv && inv.id, inv && inv.commitment_id, payee, amount, dateOrNull(req.body.paid_on), txt(req.body.method, 60), txt(req.body.reference, 80), txt(req.body.notes, 300), req.user.id, payer, payerKey === 'on_behalf', payerKey === 'on_behalf' ? approvalRef : null])).rows[0].id;
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'cost.payment_recorded', entity: 'cost_payment', entityId: id, summary: `Payment recorded (awaiting confirmation): ${payee} ${formatMoney(amount)}`, ip: req.ip });
      await touch(db, a.ws.id);
    });
    res.redirect(`/w/${a.ws.id}/budget?msg=added`);
  });

  r.post('/w/:id/budget/payments/:pid/confirm', async (req, res) => {
    const a = await financeAccess(req);
    if (!(core.isSuper(req.user) || await core.can(req.user, 'finance:post'))) throw new Forbidden('Only Finance can confirm payments.');
    const p = await own('cost_payments', req.params.pid, a.ws.id);
    const paidOn = dateOrNull(req.body.paid_on); if (!paidOn) throw bad('Enter the date the payment left the bank.');
    await core.inTx(async db => {
      const n = (await db.query("update cost_payments set status = 'confirmed', paid_on = $2, confirmed_by = $3, confirmed_at = now() where id = $1 and status = 'pending'", [p.id, paidOn, req.user.id])).rowCount;
      if (!n) throw bad('This payment is not awaiting confirmation.');
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'cost.payment_confirmed', entity: 'cost_payment', entityId: p.id, summary: `Payment confirmed: ${p.payee} ${formatMoney(num(p.amount_minor))}`, ip: req.ip });
      await touch(db, a.ws.id);
    });
    res.redirect(`/w/${a.ws.id}/budget?msg=saved`);
  });

  r.post('/w/:id/budget/payments/:pid/reverse', async (req, res) => {
    const a = await financeAccess(req);
    if (!(core.isSuper(req.user) || await core.can(req.user, 'finance:post'))) throw new Forbidden('Only Finance can reverse payments.');
    const p = await own('cost_payments', req.params.pid, a.ws.id);
    const reason = txt(req.body.reason, 300); if (!reason) throw bad('Give a reason for the reversal.');
    await core.inTx(async db => {
      const n = (await db.query("update cost_payments set status = 'reversed', notes = concat_ws(' · ', notes, $2::text) where id = $1 and status = 'confirmed'", [p.id, `Reversed: ${reason}`])).rowCount;
      if (!n) throw bad('Only confirmed payments can be reversed.');
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'cost.payment_reversed', entity: 'cost_payment', entityId: p.id, summary: `Payment reversed: ${p.payee} ${formatMoney(num(p.amount_minor))}`, after: { reason }, ip: req.ip });
      await touch(db, a.ws.id);
    });
    res.redirect(`/w/${a.ws.id}/budget?msg=saved`);
  });

  // ---------- progress updates ----------
  r.get('/w/:id/updates', async (req, res) => {
    const a = await access(req);
    const phases = await loadPhases(a.ws.id);
    const vals = [a.ws.id]; const where = ['u.workspace_id = $1', 'u.archived_at is null'];
    if (UUID.test(req.query.phase || '')) { vals.push(req.query.phase); where.push(`u.phase_id = $${vals.length}`); }
    if (dateOrNull(req.query.from)) { vals.push(req.query.from); where.push(`u.observed_on >= $${vals.length}`); }
    if (dateOrNull(req.query.to)) { vals.push(req.query.to); where.push(`u.observed_on <= $${vals.length}`); }
    if (req.query.status === 'draft') where.push("u.status = 'draft'"); else if (req.query.status !== 'all') where.push("(u.status = 'published' or u.author_id = '" + req.user.id + "')");
    const rows = (await pool.query(`select u.*, p.name as phase_name, t.title as task_title,
        (select array_agg(f.id order by f.uploaded_at) from files f where f.entity = 'progress_update' and f.entity_id = u.id::text and f.archived_at is null and f.thumb is not null) as photos
      from progress_updates u left join phases p on p.id = u.phase_id left join tasks t on t.id = u.task_id where ${where.join(' and ')} order by u.observed_on desc, u.created_at desc limit 100`, vals)).rows;
    const gallery = req.query.view === 'gallery';
    const q = k => { const p = new URLSearchParams(req.query); p.delete('msg'); if (k) p.set('view', k); else p.delete('view'); return `?${p}`; };
    res.send(page(req, a, 'Progress Updates', html`
      <form class="filters" method="get">
        <select name="phase" aria-label="Phase"><option value="">All phases</option>${phases.map(p => html`<option value="${p.id}" ${req.query.phase === p.id ? raw('selected') : ''}>${p.name}</option>`)}</select>
        <label class="small">From <input type="date" name="from" value="${req.query.from || ''}"></label><label class="small">To <input type="date" name="to" value="${req.query.to || ''}"></label>
        <select name="status" aria-label="Status"><option value="">Published + my drafts</option><option value="draft" ${req.query.status === 'draft' ? raw('selected') : ''}>Drafts</option></select>
        ${gallery ? html`<input type="hidden" name="view" value="gallery">` : ''}<button class="btn" type="submit">Apply</button>
        <a class="btn small" href="${q(gallery ? '' : 'gallery')}">${gallery ? 'Show feed' : 'Show photo gallery'}</a>
        <span class="grow"></span>${core.canContribute(a) ? html`<a class="btn primary" href="/w/${a.ws.id}/updates/new">+ Progress update</a>` : ''}</form>
      ${!rows.length ? emptyState('No progress updates yet', 'Updates record what was observed on site, with photos.') : gallery
        ? html`<section class="panel"><div class="gallery big-gallery">${rows.flatMap(u => (u.photos || []).map(f => html`<figure><a href="/files/${f}"><img src="/files/${f}/thumb" alt="Photo from ${u.title}" loading="lazy"></a><figcaption class="small">${fmtDate(u.observed_on)} · ${u.phase_name || ''}</figcaption></figure>`))}</div></section>`
        : rows.map(u => html`<article class="panel update">
          <div class="row-between"><h2 class="h"><a href="/w/${a.ws.id}/updates/${u.id}">${u.title}</a></h2>${u.status === 'draft' ? pill('Draft', 'warn') : pill('Published', 'ok')}</div>
          <div class="muted small">Observed ${fmtDate(u.observed_on)} · ${u.author_label || ''}${u.phase_name ? ` · ${u.phase_name}` : ''}${u.task_title ? ` · ${u.task_title}` : ''}${u.workforce !== null ? ` · ${u.workforce} workers` : ''}</div>
          ${u.completed_work ? html`<p class="pre-line">${u.completed_work}</p>` : ''}
          ${u.photos && u.photos.length ? html`<div class="gallery">${u.photos.slice(0, 6).map(f => html`<a href="/files/${f}"><img src="/files/${f}/thumb" alt="Photo from ${u.title}" loading="lazy"></a>`)}</div>` : ''}
        </article>`)}`));
  });

  r.get('/w/:id/updates/new', async (req, res) => {
    const a = await access(req, 'contribute');
    const [phases, tasks] = await Promise.all([loadPhases(a.ws.id), loadTasks(a.ws.id)]);
    res.send(page(req, a, 'Progress Updates', html`<form method="post" action="/w/${a.ws.id}/updates" enctype="multipart/form-data" class="panel form-grid">
      <input type="hidden" name="_csrf" value="${req.csrfToken}"><h2 class="h full">New progress update</h2>
      ${field({ name: 'title', label: 'Title', required: true, full: true, attrs: 'maxlength="200"' })}
      ${field({ name: 'observed_on', label: 'Observation date', type: 'date', required: true, value: todayBH() })}
      ${field({ name: 'phase_id', label: 'Phase', options: [['', '—'], ...phases.map(p => [p.id, p.name])] })}
      ${field({ name: 'task_id', label: 'Task', options: [['', '—'], ...tasks.map(t => [t.id, t.title])] })}
      ${field({ name: 'reported_progress', label: 'Task progress observed (%)', type: 'number', attrs: 'min="0" max="100" step="1"', hint: 'Updates the linked task only if you tick the box below.' })}
      <label class="field check full"><input type="checkbox" name="apply_progress" value="1"> <span>Apply this % to the linked task</span></label>
      ${field({ name: 'completed_work', label: 'Work completed', type: 'textarea', full: true })}
      ${field({ name: 'remaining_work', label: 'Work remaining / next', type: 'textarea', full: true })}
      ${field({ name: 'issues', label: 'Issues', type: 'textarea' })}${field({ name: 'notes', label: 'Notes', type: 'textarea' })}
      ${field({ name: 'workforce', label: 'Workers on site', type: 'number', attrs: 'min="0" step="1"' })}
      <label class="field full" for="f-photos"><span>Photos and files</span><input id="f-photos" type="file" name="photos" multiple accept="image/*,.pdf"><small>Up to 12 files. Photos are evidence only; they do not change progress.</small></label>
      ${field({ name: 'caption', label: 'Photo caption' })}${field({ name: 'location', label: 'Location / work area' })}
      <div class="actions full"><button class="btn" type="submit" name="status" value="draft">Save draft</button><button class="btn primary" type="submit" name="status" value="published">Publish</button></div>
    </form>`));
  });

  r.post('/w/:id/updates', upload.array('photos', 12), async (req, res) => {
    if (!core.checkCsrf(req)) throw new Forbidden('Your form expired. Reload the page and try again.');
    const a = await access(req, 'contribute');
    const title = txt(req.body.title, 200); if (!title) throw bad('Enter a title.');
    const observed = dateOrNull(req.body.observed_on); if (!observed) throw bad('Enter the observation date.');
    const phase = req.body.phase_id ? await own('phases', req.body.phase_id, a.ws.id) : null;
    const task = req.body.task_id ? await own('tasks', req.body.task_id, a.ws.id) : null;
    const rp = req.body.reported_progress === '' || req.body.reported_progress === undefined ? null : Number(req.body.reported_progress);
    if (rp !== null && (!Number.isInteger(rp) || rp < 0 || rp > 100)) throw bad('Progress must be 0–100.');
    const wf = req.body.workforce === '' || req.body.workforce === undefined ? null : Number(req.body.workforce);
    if (wf !== null && (!Number.isInteger(wf) || wf < 0)) throw bad('Workers must be a whole number.');
    const status = req.body.status === 'published' ? 'published' : 'draft';
    const prepared = [];
    for (const f of req.files || []) {
      const t = sniff(f.buffer, f.originalname);
      if (!t || !(t.image || t.mime === 'application/pdf' || t.mime === 'image/heic')) throw Object.assign(new Error(`“${f.originalname}” is not a photo or PDF.`), { status: 415 });
      let thumb = null, width = null, height = null;
      if (t.image) {
        try { const meta = await sharp(f.buffer).metadata(); width = meta.width; height = meta.height; thumb = await sharp(f.buffer).rotate().resize(480, 480, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 74 }).toBuffer(); }
        catch (e) { throw Object.assign(new Error(`“${f.originalname}” could not be read as an image.`), { status: 415 }); }
      }
      prepared.push({ name: String(f.originalname).replace(/[/\\<>:"|?*\u0000-\u001f]/g, '_').slice(-150), mime: t.mime, size: f.size, sha: crypto.createHash('sha256').update(f.buffer).digest('hex'), data: f.buffer, thumb, width, height });
    }
    const id = await core.inTx(async db => {
      const uid = (await db.query(`insert into progress_updates (workspace_id, phase_id, task_id, title, observed_on, completed_work, remaining_work, notes, issues, workforce, reported_progress, status, author_id, author_label, published_at)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, case when $12 = 'published' then now() end) returning id`,
        [a.ws.id, phase && phase.id, task && task.id, title, observed, txt(req.body.completed_work, 4000), txt(req.body.remaining_work, 4000), txt(req.body.notes, 4000), txt(req.body.issues, 2000), wf, rp, status, req.user.id, req.user.name || req.user.email])).rows[0].id;
      for (const p of prepared) {
        await db.query(`insert into files (workspace_id, entity, entity_id, original_name, mime, size, sha256, data, thumb, width, height, caption, location, observed_on, uploaded_by)
          values ($1,'progress_update',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [a.ws.id, uid, p.name, p.mime, p.size, p.sha, p.data, p.thumb, p.width, p.height, txt(req.body.caption, 300), txt(req.body.location, 120), observed, req.user.id]);
      }
      if (task && rp !== null && req.body.apply_progress === '1') {
        await db.query("update tasks set progress = $2, status = case when $2 = 100 then 'done' when $2 > 0 and status = 'not_started' then 'in_progress' else status end, updated_at = now() where id = $1", [task.id, rp]);
        await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'task.updated', entity: 'task', entityId: task.id, summary: `Task progress set from update: ${task.title} → ${rp}%`, before: { progress: task.progress }, after: { progress: rp }, ip: req.ip });
      }
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: status === 'published' ? 'update.published' : 'update.drafted', entity: 'progress_update', entityId: uid, summary: `Progress update ${status === 'published' ? 'published' : 'saved as draft'}: ${title}${prepared.length ? ` (${prepared.length} files)` : ''}`, ip: req.ip });
      await touch(db, a.ws.id);
      return uid;
    });
    res.redirect(`/w/${a.ws.id}/updates/${id}?msg=${status === 'published' ? 'saved' : 'saved'}`);
  });

  r.get('/w/:id/updates/:uid', async (req, res) => {
    const a = await access(req);
    const u = await own('progress_updates', req.params.uid, a.ws.id);
    if (u.status === 'draft' && u.author_id !== req.user.id && !core.canEdit(a)) throw new NotFound();
    const files = (await pool.query("select id, original_name, caption, location, thumb is not null as t from files where entity = 'progress_update' and entity_id = $1 and workspace_id = $2 and archived_at is null order by uploaded_at", [u.id, a.ws.id])).rows;
    const ph = u.phase_id ? (await pool.query('select name from phases where id = $1', [u.phase_id])).rows[0] : null;
    const tk = u.task_id ? (await pool.query('select title from tasks where id = $1', [u.task_id])).rows[0] : null;
    const comments = (await pool.query(`select c.*, coalesce(nullif(us.name,''), us.email) as who from comments c left join users us on us.id = c.author_id where c.entity = 'progress_update' and c.entity_id = $1 and c.workspace_id = $2 order by c.created_at`, [u.id, a.ws.id])).rows;
    res.send(page(req, a, 'Progress Updates', html`<p><a href="/w/${a.ws.id}/updates">‹ All updates</a></p>
      <article class="panel"><div class="row-between"><h2 class="h">${u.title}</h2>${u.status === 'draft' ? pill('Draft', 'warn') : pill('Published', 'ok')}</div>
        <p class="muted small">Observed ${fmtDate(u.observed_on)} · by ${u.author_label || ''}${u.published_at ? ` · published ${fmtDateTime(u.published_at)}` : ''}${ph ? ` · ${ph.name}` : ''}${tk ? ` · ${tk.title}` : ''}</p>
        <dl class="details">
          ${u.completed_work ? html`<div><dt>Work completed</dt><dd class="pre-line">${u.completed_work}</dd></div>` : ''}
          ${u.remaining_work ? html`<div><dt>Remaining / next</dt><dd class="pre-line">${u.remaining_work}</dd></div>` : ''}
          ${u.issues ? html`<div><dt>Issues</dt><dd class="pre-line">${u.issues}</dd></div>` : ''}
          ${u.notes ? html`<div><dt>Notes</dt><dd class="pre-line">${u.notes}</dd></div>` : ''}
          ${u.workforce !== null ? html`<div><dt>Workers on site</dt><dd>${u.workforce}</dd></div>` : ''}
          ${u.reported_progress !== null ? html`<div><dt>Observed task progress</dt><dd>${u.reported_progress}%</dd></div>` : ''}
        </dl>
        ${files.length ? html`<div class="gallery big-gallery">${files.map(f => f.t ? html`<figure><a href="/files/${f.id}"><img src="/files/${f.id}/thumb" alt="${f.caption || f.original_name}" loading="lazy"></a><figcaption class="small">${[f.caption, f.location].filter(Boolean).join(' · ')}</figcaption></figure>` : html`<figure><a class="thumb doc" href="/files/${f.id}">${f.original_name}</a></figure>`)}</div>` : ''}
        ${u.status === 'draft' && core.canContribute(a) ? html`<form method="post" action="/w/${a.ws.id}/updates/${u.id}/publish">${csrfField(req)}<button class="btn primary" type="submit">Publish</button></form>` : ''}
      </article>
      <section class="panel"><h2 class="h">Comments and follow-up</h2>
        ${comments.length ? html`<ol class="feed">${comments.map(c => html`<li><div class="pre-line">${c.body}</div><div class="muted small">${c.who || ''} · ${fmtDateTime(c.created_at)}</div></li>`)}</ol>` : html`<p class="muted">No comments.</p>`}
        ${core.canContribute(a) ? html`<form method="post" action="/w/${a.ws.id}/comments" class="stack">${csrfField(req)}<input type="hidden" name="entity" value="progress_update"><input type="hidden" name="entity_id" value="${u.id}">
          ${field({ name: 'body', label: 'Add a comment', type: 'textarea', required: true })}<button class="btn" type="submit">Comment</button></form>` : ''}</section>`));
  });

  r.post('/w/:id/updates/:uid/publish', async (req, res) => {
    const a = await access(req, 'contribute');
    const u = await own('progress_updates', req.params.uid, a.ws.id);
    if (u.author_id !== req.user.id && !core.canEdit(a)) throw new Forbidden();
    await core.inTx(async db => {
      const n = (await db.query("update progress_updates set status = 'published', published_at = now(), updated_at = now() where id = $1 and status = 'draft'", [u.id])).rowCount;
      if (n) await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'update.published', entity: 'progress_update', entityId: u.id, summary: `Progress update published: ${u.title}`, ip: req.ip });
      await touch(db, a.ws.id);
    });
    res.redirect(`/w/${a.ws.id}/updates/${u.id}?msg=saved`);
  });

  // ---------- registers ----------
  r.get('/w/:id/registers', async (req, res) => {
    const a = await access(req);
    const kind = REG[req.query.kind] ? req.query.kind : 'risk';
    const R = REG[kind];
    const counts = Object.fromEntries((await pool.query('select kind, count(*)::int as n from register_items where workspace_id = $1 and archived_at is null group by 1', [a.ws.id])).rows.map(x => [x.kind, x.n]));
    const rows = (await pool.query('select * from register_items where workspace_id = $1 and kind = $2 and archived_at is null order by (status in (\'closed\',\'resolved\',\'obtained\',\'not_required\',\'inactive\',\'cancelled\',\'withdrawn\',\'verified\')), created_at', [a.ws.id, kind])).rows;
    const contrib = core.canContribute(a);
    const isRisk = kind === 'risk' || kind === 'issue';
    res.send(page(req, a, 'Registers', html`
      <nav class="subtabs" aria-label="Registers">${Object.entries(REG).map(([k, x]) => html`<a href="?kind=${k}" ${k === kind ? raw('aria-current="page"') : ''}>${x.label} <span class="muted">${counts[k] || 0}</span></a>`)}</nav>
      <section class="panel"><h2 class="h">${R.label}</h2>
        ${rows.length ? html`<div class="table-wrap"><table><thead><tr><th>Item</th><th>Owner</th>${isRisk ? html`<th>Likelihood</th><th>Impact</th>` : ''}<th>Due</th><th>Status</th><th></th></tr></thead><tbody>
          ${rows.map(x => html`<tr><td><b>${x.title}</b>${x.suggested ? html` ${pill('Suggested', 'info')}` : ''}${x.extra && x.extra.role ? html`<div class="muted small">${x.extra.role}</div>` : ''}${x.description ? html`<div class="muted small pre-line">${x.description}</div>` : ''}</td>
            <td>${x.owner_text || '—'}</td>${isRisk ? html`<td>${x.likelihood || '—'}</td><td>${x.impact ? pill(x.impact, x.impact === 'High' ? 'bad' : x.impact === 'Medium' ? 'warn' : 'muted') : '—'}</td>` : ''}
            <td class="small">${fmtDate(x.due_date) || '—'}</td><td>${humanize(x.status)}</td>
            <td>${contrib ? html`<details class="inline-form"><summary class="small">Edit</summary><form method="post" action="/w/${a.ws.id}/registers/${x.id}" class="form-grid">${csrfField(req)}
              ${field({ name: 'title', label: 'Title', value: x.title, required: true })}${field({ name: 'owner_text', label: 'Owner', value: x.owner_text || '' })}
              ${field({ name: 'status', label: 'Status', value: x.status, options: R.statuses.map(s => [s, humanize(s)]) })}${field({ name: 'due_date', label: 'Due', type: 'date', value: iso(x.due_date) || '' })}
              ${isRisk ? html`${field({ name: 'likelihood', label: 'Likelihood', value: x.likelihood || '', options: [['', '—'], ['Low', 'Low'], ['Medium', 'Medium'], ['High', 'High']] })}${field({ name: 'impact', label: 'Impact', value: x.impact || '', options: [['', '—'], ['Low', 'Low'], ['Medium', 'Medium'], ['High', 'High']] })}` : ''}
              ${field({ name: 'description', label: kind === 'risk' ? 'Description and mitigation' : 'Details', value: x.description || '', type: 'textarea', full: true })}
              <div class="actions full"><button class="btn small" type="submit">Save</button><button class="btn small" type="submit" name="archive" value="1">Archive</button></div></form></details>` : ''}</td></tr>`)}</tbody></table></div>` : html`<p class="muted">Nothing recorded.</p>`}
        ${contrib ? html`<details class="inline-form"><summary>Add ${R.one}</summary><form method="post" action="/w/${a.ws.id}/registers" class="form-grid">${csrfField(req)}<input type="hidden" name="kind" value="${kind}">
          ${field({ name: 'title', label: 'Title', required: true })}${field({ name: 'owner_text', label: 'Owner' })}${field({ name: 'due_date', label: 'Due', type: 'date' })}
          ${isRisk ? html`${field({ name: 'likelihood', label: 'Likelihood', options: [['', '—'], ['Low', 'Low'], ['Medium', 'Medium'], ['High', 'High']] })}${field({ name: 'impact', label: 'Impact', options: [['', '—'], ['Low', 'Low'], ['Medium', 'Medium'], ['High', 'High']] })}` : ''}
          ${field({ name: 'description', label: 'Details', type: 'textarea', full: true })}<div class="actions full"><button class="btn primary" type="submit">Add</button></div></form></details>` : ''}
      </section>`));
  });

  function readReg(body, kind) {
    const out = { title: txt(body.title, 300), owner_text: txt(body.owner_text, 120), description: txt(body.description, 4000), due_date: dateOrNull(body.due_date) };
    if (!out.title) throw bad('Enter a title.');
    for (const k of ['likelihood', 'impact']) { const v = body[k]; out[k] = ['Low', 'Medium', 'High'].includes(v) ? v : null; }
    if (body.status !== undefined) { if (!REG[kind].statuses.includes(body.status)) throw bad('Choose a valid status.'); out.status = body.status; }
    return out;
  }
  r.post('/w/:id/registers', async (req, res) => {
    const a = await access(req, 'contribute');
    const kind = REG[req.body.kind] ? req.body.kind : null; if (!kind) throw bad('Unknown register.');
    const v = readReg(req.body, kind);
    await core.inTx(async db => {
      const id = (await db.query('insert into register_items (workspace_id, kind, title, owner_text, description, due_date, likelihood, impact, status, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id',
        [a.ws.id, kind, v.title, v.owner_text, v.description, v.due_date, v.likelihood, v.impact, REG[kind].statuses[0], req.user.id])).rows[0].id;
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: `register.${kind}_added`, entity: 'register_item', entityId: id, summary: `${humanize(REG[kind].one)} added: ${v.title}`, ip: req.ip });
      await touch(db, a.ws.id);
    });
    res.redirect(`/w/${a.ws.id}/registers?kind=${kind}&msg=added`);
  });
  r.post('/w/:id/registers/:rid', async (req, res) => {
    const a = await access(req, 'contribute');
    const x = await own('register_items', req.params.rid, a.ws.id);
    if (req.body.archive === '1') {
      await core.inTx(async db => { await db.query('update register_items set archived_at = now() where id = $1', [x.id]); await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: `register.${x.kind}_archived`, entity: 'register_item', entityId: x.id, summary: `Archived: ${x.title}`, ip: req.ip }); });
      return res.redirect(`/w/${a.ws.id}/registers?kind=${x.kind}&msg=archived`);
    }
    const v = readReg(req.body, x.kind);
    await core.inTx(async db => {
      await db.query('update register_items set title = $2, owner_text = $3, description = $4, due_date = $5, likelihood = $6, impact = $7, status = coalesce($8, status), suggested = false, updated_at = now() where id = $1',
        [x.id, v.title, v.owner_text, v.description, v.due_date, v.likelihood, v.impact, v.status]);
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: `register.${x.kind}_updated`, entity: 'register_item', entityId: x.id, summary: `Updated: ${v.title}`, before: { status: x.status, impact: x.impact }, after: { status: v.status, impact: v.impact }, ip: req.ip });
      await touch(db, a.ws.id);
    });
    res.redirect(`/w/${a.ws.id}/registers?kind=${x.kind}&msg=saved`);
  });

  // ---------- units & sales ----------
  const UNIT_STATUS = { planned: 'Planned', available: 'Available', reserved: 'Reserved', sold: 'Sold', handed_over: 'Handed over', withdrawn: 'Withdrawn' };
  const devOnly = a => { if (a.ws.section !== 'dev') throw new NotFound(); return a; };
  r.get('/w/:id/units', async (req, res) => {
    const a = devOnly(await access(req));
    const rows = (await pool.query('select u.*, p.ref as plot_ref from dev_units u left join plots p on p.id = u.plot_id where u.workspace_id = $1 order by u.sort, u.name', [a.ws.id])).rows;
    const plotOpts = [['', 'Not linked to a plot'], ...(await pool.query('select id, ref from plots where workspace_id = $1 and archived_at is null order by sort', [a.ws.id])).rows.map(p => [p.id, `Plot ${p.ref}`])];
    const edit = core.canEdit(a);
    res.send(page(req, a, 'Units & Sales', html`<section class="panel"><h2 class="h">Units</h2>
      ${rows.length ? html`<div class="table-wrap"><table><thead><tr><th>Unit</th><th>Plot</th><th>Type</th><th class="n">Area m²</th>${a.finance ? html`<th class="n">List price</th>` : ''}<th>Status</th><th></th></tr></thead><tbody>
        ${rows.map(u => html`<tr><td><b>${u.name}</b>${u.notes ? html`<div class="muted small">${u.notes}</div>` : ''}</td><td>${u.plot_ref || '—'}</td><td>${u.unit_type || '—'}</td><td class="n">${u.area_m2 === null ? '—' : Number(u.area_m2)}</td>
          ${a.finance ? html`<td class="n">${u.list_price_minor === null ? html`<span class="muted">Not set</span>` : fm(num(u.list_price_minor), u.currency)}</td>` : ''}<td>${UNIT_STATUS[u.status]}</td>
          <td>${edit ? html`<details class="inline-form"><summary class="small">Edit</summary><form method="post" action="/w/${a.ws.id}/units/${u.id}" class="form-grid">${csrfField(req)}
            ${field({ name: 'name', label: 'Unit', value: u.name, required: true })}${field({ name: 'plot_id', label: 'Plot', value: u.plot_id || '', options: plotOpts })}${field({ name: 'unit_type', label: 'Type', value: u.unit_type || '' })}
            ${field({ name: 'area_m2', label: 'Area m²', value: u.area_m2 === null ? '' : Number(u.area_m2), type: 'number', attrs: 'min="0" step="any"' })}
            ${a.finance ? field({ name: 'price', label: 'List price (BHD)', value: toInput(num(u.list_price_minor)) }) : ''}
            ${field({ name: 'status', label: 'Status', value: u.status, options: Object.entries(UNIT_STATUS) })}${field({ name: 'notes', label: 'Notes', value: u.notes || '' })}
            <div class="actions full"><button class="btn small" type="submit">Save</button></div></form></details>` : ''}</td></tr>`)}
      </tbody></table></div>` : html`<p class="muted">No units recorded.</p>`}
      ${edit ? html`<details class="inline-form"><summary>Add unit</summary><form method="post" action="/w/${a.ws.id}/units" class="form-grid">${csrfField(req)}
        ${field({ name: 'name', label: 'Unit', required: true })}${field({ name: 'plot_id', label: 'Plot', options: plotOpts })}${field({ name: 'unit_type', label: 'Type' })}${field({ name: 'area_m2', label: 'Area m²', type: 'number', attrs: 'min="0" step="any"' })}
        ${a.finance ? field({ name: 'price', label: 'List price (BHD)' }) : ''}<div class="actions full"><button class="btn primary" type="submit">Add unit</button></div></form></details>` : ''}
      <p class="muted small">Reservations, buyers, offers and collections are handled in Property Sales &amp; Acquisition (Phase 6). Marking a unit sold here requires the sale to be completed there first once that section is live.</p></section>`));
  });
  async function readUnit(req, a) {
    const name = txt(req.body.name, 80); if (!name) throw bad('Enter the unit name.');
    const area = req.body.area_m2 === '' || req.body.area_m2 === undefined ? null : Number(req.body.area_m2);
    if (area !== null && (!isFinite(area) || area < 0)) throw bad('Area must be a positive number.');
    const status = req.body.status && UNIT_STATUS[req.body.status] ? req.body.status : undefined;
    const plot = req.body.plot_id ? (await pool.query('select id from plots where id = $1 and workspace_id = $2 and archived_at is null', [UUID.test(req.body.plot_id) ? req.body.plot_id : null, a.ws.id])).rows[0] : null;
    if (req.body.plot_id && !plot) throw bad('That plot is not part of this project.');
    return { plot_id: plot ? plot.id : null, name, unit_type: txt(req.body.unit_type, 80), area_m2: area, price: a.finance ? parseMoney(req.body.price, 'BHD') : undefined, status, notes: txt(req.body.notes, 300) };
  }
  r.post('/w/:id/units', async (req, res) => {
    const a = devOnly(await access(req, 'edit'));
    const u = await readUnit(req, a);
    await core.inTx(async db => {
      const id = (await db.query('insert into dev_units (workspace_id, name, unit_type, area_m2, list_price_minor, notes, plot_id) values ($1,$2,$3,$4,$5,$6,$7) returning id', [a.ws.id, u.name, u.unit_type, u.area_m2, u.price ?? null, u.notes, u.plot_id])).rows[0].id;
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'unit.added', entity: 'dev_unit', entityId: id, summary: `Unit added: ${u.name}`, ip: req.ip });
    });
    res.redirect(`/w/${a.ws.id}/units?msg=added`);
  });
  r.post('/w/:id/units/:uid', async (req, res) => {
    const a = devOnly(await access(req, 'edit'));
    const cur = await own('dev_units', req.params.uid, a.ws.id);
    const u = await readUnit(req, a);
    await core.inTx(async db => {
      await db.query('update dev_units set name = $2, unit_type = $3, area_m2 = $4, list_price_minor = coalesce($5, list_price_minor), status = coalesce($6, status), notes = $7, plot_id = $8 where id = $1',
        [cur.id, u.name, u.unit_type, u.area_m2, u.price === undefined ? null : u.price, u.status || null, u.notes, u.plot_id]);
      if (a.finance && u.price === null && cur.list_price_minor !== null) await db.query('update dev_units set list_price_minor = null where id = $1', [cur.id]);
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'unit.updated', entity: 'dev_unit', entityId: cur.id, summary: `Unit updated: ${u.name}`, before: { status: cur.status, price: num(cur.list_price_minor) }, after: { status: u.status, price: u.price }, ip: req.ip });
    });
    res.redirect(`/w/${a.ws.id}/units?msg=saved`);
  });

  return { metrics, budgetSummary, access, page, plans, own, touch, budgetTab };
}

module.exports = { mountProjects, PROJECT_SECTIONS, TASK_STATUS, REG };
