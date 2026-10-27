'use strict';
// Construction master plan for SarayDar Real Estate Development and Clients Projects Management (owner request
// 2026-10-27). One shared default template (Super Admin, future projects only); each project owns an editable copy:
// stages that expand to numbered tasks, weights that must add up to 100%, weighted progress, a project-specific
// Gantt chart, a stage pipeline and a procurement tracker. Existing projects keep their old plan until a manager
// previews and confirms the replacement; the old plan is archived read-only and can be restored.
const M = require('../lib/master-plan');
const MS = require('../lib/master-store');
const { layout, html, raw, pill, csrfField, field, progressField, emptyState, fmtDate, fmtDateTime } = require('./views');

const UUID = /^[0-9a-f-]{36}$/i;
const bad = m => Object.assign(new Error(m), { status: 400 });
const txt = (v, n = 300) => { const s = String(v ?? '').trim().slice(0, n); return s || null; };
const dateOrNull = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : null;
const iso = d => d ? (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)) : null;
const todayBH = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bahrain' });
const pct1 = v => v === null || v === undefined ? '—' : `${Math.round(v * 10) / 10}%`;
const wfmt = v => v === null || v === undefined ? '—' : `${Math.round(Number(v) * 1000) / 1000}%`;
const STATUS_OPTS = [['not_started', 'Not started'], ['in_progress', 'In progress'], ['on_hold', 'On hold'], ['done', 'Completed']];
const TONE = { not_started: 'muted', in_progress: 'warn', on_hold: 'bad', blocked: 'bad', done: 'ok', cancelled: 'muted' };
const tpill = s => pill(M.TASK_LABEL[s] || s, TONE[s] || 'muted');
const spill = s => pill(M.STAGE_LABEL[s] || s, TONE[s] || 'muted');
const range = (a, b) => a || b ? `${fmtDate(a) || '—'} – ${fmtDate(b) || '…'}` : '—';
const PROC_STATUS = { planned: 'Planned', approved: 'Approved', ordered: 'Ordered', delivered: 'Delivered', cancelled: 'Cancelled' };

function mountMasterPlan(r, ctx, P) {
  const { pool, core, NotFound, Forbidden } = ctx;

  // ---------- template ----------
  const template = (db = pool) => MS.template(db);
  const masterOf = (wsId, db = pool) => db.query('select * from master_plans where workspace_id = $1', [wsId]).then(x => x.rows[0] || null);
  ctx.masterOf = masterOf;
  const applyTemplate = (db, wsId, user, carry = {}) => MS.applyTemplate(db, wsId, user ? user.id : null, carry);
  // new projects in both sections start on the master plan
  ctx.applyMasterOnCreate = async (db, wsId, user) => {
    const tpl = await applyTemplate(db, wsId, user);
    await core.audit(db, { actor: user, workspaceId: wsId, action: 'master.applied', entity: 'plan', entityId: wsId, summary: `Construction master plan v${tpl.version} added (${tpl.stages.length} stages)` });
  };

  // ---------- loading and computing ----------
  async function load(wsId) {
    const phases = (await pool.query('select * from phases where workspace_id = $1 and archived_at is null order by sort, created_at', [wsId])).rows;
    const tasks = (await pool.query('select * from tasks where workspace_id = $1 and archived_at is null order by sort, created_at', [wsId])).rows;
    const c = M.compute(phases, tasks);
    const st = Object.fromEntries(c.stages.map(s => [s.id, s]));
    return { phases, tasks, c, st };
  }
  ctx.masterCompute = async wsId => (await masterOf(wsId)) ? (await load(wsId)).c : null;

  async function access(req, need) {
    const a = await P.access(req, need);
    return a;
  }
  const W = a => `/w/${a.ws.id}/master`;
  const sub = (a, cur) => html`<nav class="subtabs mp-sub" aria-label="Master plan views">${[['Stages & tasks', ''], ['Gantt chart', '/gantt'], ['Procurement', '/procurement'], ['Weights', '/weights'], ['History', '/history']]
    .map(([l, p]) => html`<a href="${W(a)}${p}" class="${l === cur ? 'on' : ''}" ${l === cur ? raw('aria-current="page"') : ''}>${l}</a>`)}</nav>`;
  const pg = (req, a, cur, body) => P.page(req, a, 'Master Plan', html`${sub(a, cur)}${body}`);

  // ---------- the stage pipeline (same component as the stages bar on other sections) ----------
  function pipeline(a, c, { link = true } = {}) {
    if (!c.stages.length) return '';
    return html`<ol class="jr mp-pipe" style="--n:${c.stages.length}" aria-label="Construction stages">${c.stages.map((s, i) => {
      const cls = s.status === 'done' ? 'done' : s.status === 'in_progress' ? 'now' : s.status === 'on_hold' ? 'hold' : 'todo';
      const p = s.pct === null ? null : Math.round(s.pct);
      // a ring that fills with the stage's completion, the % inside it; the status as a small chip under the name
      const inner = html`<span class="mp-ring" style="--p:${p || 0}" role="img" aria-label="${p === null ? 'Progress not available' : `${p}% complete`}"><b>${s.status === 'done' ? '✓' : p === null ? '—' : `${p}%`}</b></span>
        <span class="jr-label">${s.name}</span><span class="mp-chip mp-chip-${s.status}">${M.STAGE_LABEL[s.status]}</span>`;
      return html`<li class="${cls}">${link ? html`<a href="/w/${a.ws.id}/master?open=${s.id}#stage-${s.id}" title="${s.name}: ${M.STAGE_LABEL[s.status]}${s.pct !== null ? `, ${Math.round(s.pct)}%` : ''}">${inner}</a>` : html`<span class="jr-static">${inner}</span>`}</li>`;
    })}</ol>`;
  }
  ctx.masterPipelinePanel = async (req, a, opts = {}) => {
    if (!['dev', 'cpm'].includes(a.ws.section)) return '';
    if (!(await masterOf(a.ws.id))) return '';
    const { c } = await load(a.ws.id);
    const active = c.stages.filter(s => s.status === 'in_progress');
    return html`<section class="panel mp-pipe-panel"><div class="row-between"><h2 class="h">Construction stages</h2>
        <span class="guide-count">${c.valid ? `Overall ${pct1(c.pct)}` : 'Weights incomplete'}</span></div>
      <div class="mp-pipe-scroll">${pipeline(a, c, { link: opts.link !== false })}</div>
      <p class="muted small">${active.length ? `In progress now: ${active.map(s => s.name).join(', ')}.` : c.stages.every(s => s.status === 'done') ? 'All stages completed.' : 'No stage in progress yet.'}
        ${opts.link !== false ? html` <a href="/w/${a.ws.id}/master">Open the master plan</a> · <a href="/w/${a.ws.id}/master/gantt">Gantt chart</a>` : ''}</p></section>`;
  };

  function progressCard(c, weightsHref) {
    if (!c.valid) return html`<div class="notice warn"><b>Progress is not shown because the plan's weights are incomplete.</b> ${c.issues.join(' ')} <a href="${weightsHref}">Fix the weights</a></div>`;
    return html`<section class="grid-cards" aria-label="Progress"><div class="card"><div class="muted small">Overall progress (weighted)</div><div class="big">${pct1(c.pct)}</div><div class="bar"><span style="width:${Math.min(100, c.pct)}%"></span></div></div>
      ${c.preHandover !== null ? html`<div class="card"><div class="muted small">Construction progress to handover</div><div class="big">${pct1(c.preHandover)}</div><div class="muted small">Excludes defects and closeout, so handover is not confused with final closeout.</div></div>` : ''}
      <div class="card"><div class="muted small">Stages</div><div class="big">${c.stages.length}</div><div class="muted small">${c.stages.filter(s => s.status === 'done').length} completed · ${c.stages.filter(s => s.status === 'in_progress').length} in progress · ${c.stages.filter(s => s.status === 'on_hold').length} on hold</div></div></section>`;
  }

  // ---------- adoption (existing projects) ----------
  async function adoptionPage(req, a) {
    const { phases, tasks } = await load(a.ws.id);
    const tpl = await template();
    const tKeys = tpl.stages.flatMap(s => s.tasks.map(t => ({ ...t, stage: s.name })));
    const map = M.matchTasks(tasks.map(t => ({ id: t.id, title: t.title })), tKeys);
    const canManage = core.isSuper(req.user) || a.role === 'manager';
    const hasData = t => t.status !== 'not_started' || Number(t.progress) > 0 || t.start_date || t.due_date || t.actual_start || t.owner_text || t.notes;
    const archives = (await pool.query('select * from plan_archives where workspace_id = $1 order by created_at desc', [a.ws.id])).rows;
    const opts = [['', 'Keep in the archive only'], ...tKeys.map(t => [t.key, `${t.key} ${t.title}`])];
    return pg(req, a, 'Stages & tasks', html`
      <section class="panel"><h2 class="h">Move this project to the construction master plan</h2>
        <p>This project still uses its previous plan (${phases.length} phases, ${tasks.length} tasks). The new master plan has ${tpl.stages.length} stages and ${tKeys.length} tasks with suggested weights.</p>
        <ul class="small"><li>The previous plan is kept as a read-only archive and can be restored at any time from History.</li>
          <li>Tasks matched below carry their status, %, dates, responsible person and notes into the new task. Unmatched tasks stay in the archive only.</li>
          <li>Progress then follows the new weights. Nothing changes until a manager confirms.</li></ul>
        ${archives.length ? html`<p class="small"><a href="${W(a)}/history">Plan history (${archives.length})</a></p>` : ''}
      </section>
      ${canManage ? html`<form method="post" action="${W(a)}/adopt" class="panel">${csrfField(req)}<h2 class="h">Preview: old tasks and where they go</h2>
        ${tasks.length ? html`<div class="table-wrap"><table><thead><tr><th>Old phase / task</th><th>Status</th><th>Data to carry</th><th>Goes to (new task)</th></tr></thead><tbody>
          ${tasks.map(t => { const ph = phases.find(p => p.id === t.phase_id); const m = map[t.id]; return html`<tr><td><span class="muted small">${ph ? ph.name : 'No phase'}</span><div>${t.title}</div></td>
            <td>${tpill(t.status)} <span class="small">${M.taskPct(t)}%</span></td><td class="small">${hasData(t) ? [t.start_date || t.due_date ? `dates ${fmtDate(t.start_date) || '—'} – ${fmtDate(t.due_date) || '—'}` : '', t.owner_text ? `owner ${t.owner_text}` : '', t.notes ? 'notes' : ''].filter(Boolean).join(' · ') || 'status / %' : html`<span class="muted">nothing</span>`}</td>
            <td>${field({ name: `map_${t.id}`, label: m ? `Matched (${m.score}% similar)` : hasData(t) ? 'Not matched: choose or keep in archive' : 'Not matched', value: m ? m.key : '', options: opts })}</td></tr>`; })}
        </tbody></table></div>` : html`<p class="muted">The project has no tasks yet, so nothing needs to be carried over.</p>`}
        <label class="field check"><input type="checkbox" name="confirm" value="1" required> <span>Replace this project's plan with the construction master plan. I understand the old plan is archived and can be restored.</span></label>
        <div class="actions"><button class="btn primary" type="submit">Replace the plan</button> <a class="btn" href="/w/${a.ws.id}/tasks">View the current plan</a></div></form>`
      : html`<p class="notice">Only the workspace manager can replace the plan. <a href="/w/${a.ws.id}/tasks">View the current plan</a></p>`}`);
  }

  async function snapshot(db, wsId) {
    const phases = (await db.query('select * from phases where workspace_id = $1 and archived_at is null', [wsId])).rows;
    const tasks = (await db.query('select * from tasks where workspace_id = $1 and archived_at is null', [wsId])).rows;
    const deps = (await db.query('select d.* from task_deps d join tasks t on t.id = d.task_id where t.workspace_id = $1', [wsId])).rows;
    const plans = (await db.query('select id, version, status from plans where workspace_id = $1', [wsId])).rows;
    const master = (await db.query('select * from master_plans where workspace_id = $1', [wsId])).rows[0] || null;
    return { phases, tasks, deps, plans, master };
  }
  async function archiveCurrent(db, a, user, reason, extra = {}) {
    const snap = await snapshot(db, a.ws.id);
    const id = (await db.query('insert into plan_archives (workspace_id, reason, snapshot, phase_ids, task_ids, created_by) values ($1,$2,$3,$4,$5,$6) returning id',
      [a.ws.id, reason, JSON.stringify({ ...snap, ...extra }), snap.phases.map(p => p.id), snap.tasks.map(t => t.id), user.id])).rows[0].id;
    await db.query('update tasks set archived_at = now() where workspace_id = $1 and archived_at is null', [a.ws.id]);
    await db.query('update phases set archived_at = now() where workspace_id = $1 and archived_at is null', [a.ws.id]);
    await db.query("update plans set status = 'superseded', note = coalesce(note || ' · ', '') || $2 where workspace_id = $1 and status in ('draft','approved')", [a.ws.id, `Archived ${todayBH()}: ${reason}`]);
    return { id, snap };
  }

  r.post('/w/:id/master/adopt', async (req, res) => {
    const a = await access(req, 'manage');
    if (req.body.confirm !== '1') throw bad('Tick the box to confirm the replacement.');
    if (await masterOf(a.ws.id)) return res.redirect(W(a));
    await core.inTx(async db => {
      await db.query('select id from workspaces where id = $1 for update', [a.ws.id]);
      if ((await db.query('select 1 from master_plans where workspace_id = $1', [a.ws.id])).rowCount) return;
      const tasks = (await db.query('select * from tasks where workspace_id = $1 and archived_at is null', [a.ws.id])).rows;
      const tpl = await template(db);
      const keys = new Set(tpl.stages.flatMap(s => s.tasks.map(t => t.key)));
      const carry = {}, mapping = {};
      for (const t of tasks) {
        const k = req.body[`map_${t.id}`];
        if (!k || !keys.has(k)) continue;
        if (carry[k]) throw bad(`Two old tasks are mapped to new task ${k}. Choose one.`);
        carry[k] = t; mapping[t.id] = k;
      }
      const { id: archiveId } = await archiveCurrent(db, a, req.user, 'Replaced by the construction master plan', { mapping });
      await applyTemplate(db, a.ws.id, req.user, carry);
      // carry links of mapped tasks: progress updates and dependencies between two mapped tasks
      const newIds = Object.fromEntries((await db.query('select id, template_key from tasks where workspace_id = $1 and archived_at is null', [a.ws.id])).rows.map(x => [x.template_key, x.id]));
      for (const [oldId, k] of Object.entries(mapping)) await db.query('update progress_updates set task_id = $2 where workspace_id = $3 and task_id = $1', [oldId, newIds[k], a.ws.id]);
      const deps = (await db.query('select d.* from task_deps d where d.task_id = any($1::uuid[])', [Object.keys(mapping)])).rows;
      for (const d of deps) if (mapping[d.depends_on]) await db.query('insert into task_deps (task_id, depends_on) values ($1,$2) on conflict do nothing', [newIds[mapping[d.task_id]], newIds[mapping[d.depends_on]]]);
      const v = (await db.query('select coalesce(max(version),0)+1 as v from plans where workspace_id = $1', [a.ws.id])).rows[0].v;
      await db.query("insert into plans (workspace_id, version, status, source, note, created_by) values ($1,$2,'draft','generated','Construction master plan adopted. Review dates and weights, then approve a new baseline.',$3)", [a.ws.id, v, req.user.id]);
      await P.touch(db, a.ws.id);
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'master.adopted', entity: 'plan_archive', entityId: archiveId, summary: `Plan replaced by the construction master plan (${Object.keys(mapping).length} of ${tasks.length} old tasks carried over; old plan archived)`, ip: req.ip });
    });
    res.redirect(`${W(a)}?msg=saved`);
  });

  // ---------- history: archives and restore ----------
  r.get('/w/:id/master/history', async (req, res) => {
    const a = await access(req);
    const arch = (await pool.query(`select p.*, coalesce(nullif(u.name,''), u.email) as who, coalesce(nullif(v.name,''), v.email) as rwho from plan_archives p
      left join users u on u.id = p.created_by left join users v on v.id = p.restored_by where p.workspace_id = $1 order by p.created_at desc`, [a.ws.id])).rows;
    const view = UUID.test(req.query.v || '') ? arch.find(x => x.id === req.query.v) : null;
    const canManage = core.isSuper(req.user) || a.role === 'manager';
    const removed = (await pool.query(`select 'task' as kind, t.id, t.title as name, t.archived_at, p.name as parent from tasks t left join phases p on p.id = t.phase_id
        where t.workspace_id = $1 and t.archived_at is not null and not exists (select 1 from plan_archives x where x.workspace_id = $1 and t.id = any(x.task_ids))
      union all select 'stage', p.id, p.name, p.archived_at, null from phases p where p.workspace_id = $1 and p.archived_at is not null and not exists (select 1 from plan_archives x where x.workspace_id = $1 and p.id = any(x.phase_ids))
      order by archived_at desc limit 200`, [a.ws.id])).rows;
    const master = await masterOf(a.ws.id);
    res.send(pg(req, a, 'History', html`
      ${master ? html`<section class="panel"><h2 class="h">Removed stages and tasks</h2>
        ${removed.length ? html`<div class="table-wrap"><table><thead><tr><th>Item</th><th>Removed</th><th></th></tr></thead><tbody>
          ${removed.map(x => html`<tr><td>${x.kind === 'stage' ? 'Stage' : 'Task'}: <b>${x.name}</b>${x.parent ? html`<div class="muted small">in ${x.parent}</div>` : ''}</td><td class="small">${fmtDateTime(x.archived_at)}</td>
            <td>${core.canEdit(a) ? html`<form method="post" action="${W(a)}/restore-item">${csrfField(req)}<input type="hidden" name="kind" value="${x.kind}"><input type="hidden" name="item" value="${x.id}"><button class="btn small" type="submit">Restore</button></form>` : ''}</td></tr>`)}
        </tbody></table></div><p class="muted small">A restored item comes back with its old weight; then set the weights so they add up to 100% again.</p>` : html`<p class="muted">Nothing removed.</p>`}</section>` : ''}
      <section class="panel"><h2 class="h">Archived plans</h2>
        ${arch.length ? html`<div class="table-wrap"><table><thead><tr><th>Archived</th><th>Why</th><th>Content</th><th></th></tr></thead><tbody>
          ${arch.map(x => html`<tr><td class="small">${fmtDateTime(x.created_at)}<div class="muted">${x.who || ''}</div></td><td>${x.reason}${x.restored_at ? html`<div class="small">${pill('Restored', 'ok')} ${fmtDateTime(x.restored_at)} · ${x.rwho || ''}</div>` : ''}</td>
            <td class="small">${x.phase_ids.length} phases · ${x.task_ids.length} tasks · <a href="?v=${x.id}">view</a></td>
            <td>${canManage && !x.restored_at ? html`<form method="post" action="${W(a)}/restore/${x.id}">${csrfField(req)}<button class="btn small" type="submit" data-confirm="Restore this archived plan? The current plan is archived first, so it can be restored too.">Restore this plan</button></form>` : ''}</td></tr>`)}
        </tbody></table></div>` : html`<p class="muted">No archived plans.</p>`}</section>
      ${view ? html`<section class="panel"><h2 class="h">Archived plan · ${fmtDateTime(view.created_at)} (read-only)</h2>
        ${view.snapshot.phases.sort((x, y) => x.sort - y.sort).map(p => html`<h3 class="h3">${p.name}${p.weight !== null && p.weight !== undefined ? ` · weight ${Number(p.weight)}` : ''}</h3>
          <div class="table-wrap"><table><thead><tr><th>Task</th><th>Status</th><th class="n">%</th><th>Planned</th><th>Carried to</th></tr></thead><tbody>
          ${view.snapshot.tasks.filter(t => t.phase_id === p.id).sort((x, y) => x.sort - y.sort).map(t => html`<tr><td>${t.title}</td><td>${tpill(t.status)}</td><td class="n">${M.taskPct(t)}</td><td class="small">${fmtDate(t.start_date) || '—'} – ${fmtDate(t.due_date) || '—'}</td><td class="small">${(view.snapshot.mapping || {})[t.id] || '—'}</td></tr>`)}
          </tbody></table></div>`)}</section>` : ''}`));
  });

  r.post('/w/:id/master/restore/:aid', async (req, res) => {
    const a = await access(req, 'manage');
    const ar = (await pool.query('select * from plan_archives where id = $1 and workspace_id = $2', [UUID.test(req.params.aid) ? req.params.aid : null, a.ws.id])).rows[0];
    if (!ar) throw new NotFound();
    if (ar.restored_at) throw bad('This plan has already been restored.');
    await core.inTx(async db => {
      await db.query('select id from workspaces where id = $1 for update', [a.ws.id]);
      await archiveCurrent(db, a, req.user, `Archived when the plan of ${fmtDateTime(ar.created_at)} was restored`);
      await db.query('update phases set archived_at = null where workspace_id = $1 and id = any($2::uuid[])', [a.ws.id, ar.phase_ids]);
      await db.query('update tasks set archived_at = null where workspace_id = $1 and id = any($2::uuid[])', [a.ws.id, ar.task_ids]);
      for (const p of ar.snapshot.plans || []) await db.query('update plans set status = $2 where id = $1 and workspace_id = $3', [p.id, p.status, a.ws.id]);
      await db.query('delete from master_plans where workspace_id = $1', [a.ws.id]);
      const m = ar.snapshot.master;
      if (m) await db.query('insert into master_plans (workspace_id, template_key, template_version, anchor_start, defects_months, applied_by, applied_at) values ($1,$2,$3,$4,$5,$6,$7)', [a.ws.id, m.template_key, m.template_version, iso(m.anchor_start), m.defects_months, m.applied_by, m.applied_at]);
      await db.query('update plan_archives set restored_at = now(), restored_by = $2 where id = $1', [ar.id, req.user.id]);
      await P.touch(db, a.ws.id);
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'master.restored', entity: 'plan_archive', entityId: ar.id, summary: `Archived plan of ${fmtDateTime(ar.created_at)} restored (the plan in use before was archived)`, ip: req.ip });
    });
    res.redirect(`${W(a)}${ar.snapshot.master ? '' : '/history'}?msg=saved`);
  });

  r.post('/w/:id/master/restore-item', async (req, res) => {
    const a = await access(req, 'edit');
    const kind = req.body.kind === 'stage' ? 'phases' : 'tasks';
    const row = await P.own(kind, req.body.item, a.ws.id);
    await core.inTx(async db => {
      if (kind === 'tasks' && row.phase_id) await db.query('update phases set archived_at = null where id = $1 and workspace_id = $2', [row.phase_id, a.ws.id]);
      await db.query(`update ${kind} set archived_at = null where id = $1`, [row.id]);
      if (kind === 'phases') await db.query('update tasks set archived_at = null where phase_id = $1 and archived_at = $2', [row.id, row.archived_at]);
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: kind === 'phases' ? 'stage.restored' : 'task.restored', entity: kind === 'phases' ? 'phase' : 'task', entityId: row.id, summary: `${kind === 'phases' ? 'Stage' : 'Task'} restored: ${row.name || row.title}`, ip: req.ip });
      await P.touch(db, a.ws.id);
    });
    res.redirect(`${W(a)}/weights?msg=saved`);
  });

  // ---------- the master plan page ----------
  r.get('/w/:id/master', async (req, res) => {
    const a = await access(req);
    const master = await masterOf(a.ws.id);
    if (!master) return res.send(await adoptionPage(req, a));
    const { phases, tasks, c, st } = await load(a.ws.id);
    const edit = core.canEdit(a), contrib = core.canContribute(a);
    const today = todayBH();
    const names = await require('./choices').knownNames(pool, a.ws.id);
    const open = UUID.test(req.query.open || '') ? req.query.open : null;
    const W_ = W(a);
    const stageBlock = (p, i) => {
      const s = st[p.id], ts = tasks.filter(t => t.phase_id === p.id);
      const pStart = p.planned_start || ts.map(t => iso(t.start_date)).filter(Boolean).sort()[0];
      const pEnd = p.planned_end || ts.map(t => iso(t.due_date)).filter(Boolean).sort().slice(-1)[0];
      return html`<details class="panel mp-stage st-${s.status}" id="stage-${p.id}" ${open === p.id || (!open && s.status === 'in_progress') ? raw('open') : ''}>
        <summary class="mp-sum"><span class="mp-num">${i + 1}</span><span class="mp-name"><b>${p.name}</b><span class="muted small">${[pStart || pEnd ? `${fmtDate(pStart) || '—'} – ${fmtDate(pEnd) || '—'}` : 'No dates', p.duration_note ? `indicative ${p.duration_note}` : null].filter(Boolean).join(' · ')}</span></span>
          <span class="mp-meta">${spill(s.status)}<span class="mp-w" title="Stage weight">${wfmt(s.weight)}</span><span class="mp-bar" aria-label="Stage progress ${s.pct === null ? 'not available' : Math.round(s.pct) + '%'}"><span style="width:${s.pct || 0}%"></span></span><b class="mp-pct">${s.pct === null ? '—' : `${Math.round(s.pct)}%`}</b></span></summary>
        <div class="mp-body">
          ${p.description ? html`<p>${p.description}</p>` : ''}
          <dl class="mp-facts"><div><dt>Responsible</dt><dd>${p.owner_text || '—'}</dd></div><div><dt>Planned</dt><dd>${range(p.planned_start, p.planned_end)}</dd></div>
            <div><dt>Actual</dt><dd>${range(p.actual_start, p.actual_finish)}</dd></div><div><dt>Contribution</dt><dd>${s.pct === null || s.weight === null ? '—' : `${Math.round(s.weight * s.pct) / 100} of ${s.weight} points`}</dd></div></dl>
          ${p.notes ? html`<p class="muted small pre-line">${p.notes}</p>` : ''}
          ${ts.length ? html`<div class="table-wrap"><table class="mp-tasks"><thead><tr><th>No.</th><th>Task</th><th>Responsible</th><th>Planned</th><th>Actual</th><th>Status</th><th class="n">%</th><th class="n">Weight</th><th></th></tr></thead><tbody>
            ${ts.map((t, j) => { const late = t.due_date && iso(t.due_date) < today && t.status !== 'done'; return html`<tr id="task-${t.id}" class="${late ? 'late' : ''}"><td class="mp-no">${i + 1}.${j + 1}</td>
              <td><b>${t.title}</b>${t.is_milestone ? html` ${pill('Milestone', 'info')}` : ''}${!t.verified ? html` ${pill('Reported, unverified', 'warn')}` : ''}${t.description ? html`<div class="muted small">${t.description}</div>` : ''}</td>
              <td>${t.owner_text || '—'}</td><td class="small">${range(t.start_date, t.due_date)}${late ? html` ${pill('Late', 'bad')}` : ''}</td><td class="small">${range(t.actual_start, t.actual_finish)}</td>
              <td>${tpill(t.status)}</td><td class="n">${M.taskPct(t)}</td><td class="n">${wfmt(t.weight)}</td>
              <td>${contrib ? html`<a class="btn small" href="#edit-${t.id}">Edit</a>` : ''}</td></tr>`; })}
          </tbody></table></div>${ts.map((t, j) => html`${contrib ? html`<div class="mp-editor" id="edit-${t.id}"><div class="row-between"><h3 class="h3">Edit ${i + 1}.${j + 1} ${t.title}</h3><a class="btn small" href="#task-${t.id}">Close</a></div><form method="post" action="${W_}/tasks/${t.id}" class="form-grid">${csrfField(req)}
                ${edit ? html`${field({ name: 'title', label: 'Task', value: t.title, required: true, full: true })}${field({ name: 'description', label: 'Description', value: t.description || '', type: 'textarea', full: true })}
                  ${field({ name: 'owner_text', label: 'Responsible', value: t.owner_text || '', list: names })}
                  ${field({ name: 'start_date', label: 'Planned start', type: 'date', value: iso(t.start_date) || '' })}${field({ name: 'due_date', label: 'Planned finish', type: 'date', value: iso(t.due_date) || '' })}` : ''}
                ${field({ name: 'status', label: 'Status', value: t.status === 'blocked' ? 'on_hold' : t.status, options: STATUS_OPTS })}${progressField({ name: 'progress', label: '% complete', value: M.taskPct(t), full: false })}
                ${field({ name: 'actual_start', label: 'Actual start', type: 'date', value: iso(t.actual_start) || '' })}${field({ name: 'actual_finish', label: 'Actual finish', type: 'date', value: iso(t.actual_finish) || '' })}
                ${edit ? html`<label class="field check"><input type="checkbox" name="is_milestone" value="1" ${t.is_milestone ? raw('checked') : ''}> <span>Milestone</span></label>${field({ name: 'notes', label: 'Notes', value: t.notes || '', type: 'textarea', full: true })}` : ''}
                <div class="actions full"><button class="btn primary small" type="submit">Save</button><a class="btn small" href="/w/${a.ws.id}/tasks/${t.id}">Comments &amp; dependencies</a></div>
                <p class="muted small full">Completed sets 100%; 100% sets Completed. Weight is changed under Weights so the stage keeps adding up to 100%.</p></form>
                ${edit ? html`<div class="mp-row-act"><span class="small muted">Order and removal:</span><form method="post" action="${W_}/tasks/${t.id}/move">${csrfField(req)}<button class="btn small" name="dir" value="up" ${j === 0 ? raw('disabled') : ''} aria-label="Move up">↑</button><button class="btn small" name="dir" value="down" ${j === ts.length - 1 ? raw('disabled') : ''} aria-label="Move down">↓</button></form>
                  <a class="btn small" href="${W_}/tasks/${t.id}/remove">Remove…</a></div>` : ''}</div>` : ''}`)}` : html`<p class="muted">No tasks in this stage.${s.pct !== null ? ` Stage progress is set directly: ${Math.round(s.pct)}%.` : ''}</p>`}
          ${edit ? html`<div class="mp-stage-act">
            <details class="inline-form"><summary>Add a task to this stage</summary><form method="post" action="${W_}/tasks" class="form-grid">${csrfField(req)}<input type="hidden" name="phase_id" value="${p.id}">
              ${field({ name: 'title', label: 'Task', required: true, full: true })}${field({ name: 'owner_text', label: 'Responsible', list: names })}
              ${field({ name: 'weight', label: 'Weight within the stage (%)', value: ts.length ? M.r3(100 / (ts.length + 1)) : 100, attrs: 'inputmode="decimal"' })}
              <fieldset class="full"><legend class="small">The other tasks' weights</legend><label class="check"><input type="radio" name="mode" value="scale" checked> Share the rest proportionally (preview first)</label><label class="check"><input type="radio" name="mode" value="manual"> I will set them myself under Weights</label></fieldset>
              <div class="actions full"><button class="btn primary" type="submit">Continue</button></div></form></details>
            <details class="inline-form"><summary>Edit stage details</summary><form method="post" action="${W_}/stages/${p.id}" class="form-grid">${csrfField(req)}
              ${field({ name: 'name', label: 'Stage name', value: p.name, required: true })}${field({ name: 'owner_text', label: 'Responsible', value: p.owner_text || '', list: names })}
              ${field({ name: 'description', label: 'Description', value: p.description || '', type: 'textarea', full: true })}
              ${field({ name: 'planned_start', label: 'Planned start', type: 'date', value: iso(p.planned_start) || '' })}${field({ name: 'planned_end', label: 'Planned finish', type: 'date', value: iso(p.planned_end) || '' })}
              ${field({ name: 'actual_start', label: 'Actual start', type: 'date', value: iso(p.actual_start) || '' })}${field({ name: 'actual_finish', label: 'Actual finish', type: 'date', value: iso(p.actual_finish) || '' })}
              ${field({ name: 'duration_note', label: 'Indicative duration', value: p.duration_note || '', hint: 'A default, not a promise.' })}
              ${field({ name: 'hold', label: 'Status', value: p.hold ? '1' : '', options: [['', 'Automatic (from its tasks)'], ['1', 'On hold']] })}
              ${!ts.length ? progressField({ name: 'progress', label: '% complete (stage without tasks)', value: Number(p.progress) || 0 }) : ''}
              ${field({ name: 'notes', label: 'Notes', value: p.notes || '', type: 'textarea', full: true })}
              <div class="actions full"><button class="btn primary" type="submit">Save stage</button></div></form></details>
            <div class="mp-row-act"><form method="post" action="${W_}/stages/${p.id}/move">${csrfField(req)}<button class="btn small" name="dir" value="up" ${i === 0 ? raw('disabled') : ''}>↑ Move stage up</button><button class="btn small" name="dir" value="down" ${i === phases.length - 1 ? raw('disabled') : ''}>↓ Move down</button></form>
              <a class="btn small" href="${W_}/stages/${p.id}/remove">Remove stage…</a></div></div>` : ''}
        </div></details>`;
    };
    res.send(pg(req, a, 'Stages & tasks', html`
      ${progressCard(c, `${W_}/weights`)}
      <section class="panel mp-pipe-panel"><h2 class="h">Stage pipeline</h2><div class="mp-pipe-scroll">${pipeline(a, c)}</div>
        <p class="muted small">Stages can overlap, so more than one can be in progress. Weights and durations are suggested defaults, not a standard, a contract payment schedule or a cost estimate. Money paid never counts as completion.</p></section>
      ${phases.map(stageBlock)}
      ${edit ? html`<section class="panel"><details class="inline-form"><summary><b>Add a stage</b></summary><form method="post" action="${W_}/stages" class="form-grid">${csrfField(req)}
          ${field({ name: 'name', label: 'Stage name', required: true })}${field({ name: 'weight', label: 'Stage weight (% of the project)', value: M.r3(100 / (phases.length + 1)), attrs: 'inputmode="decimal"' })}
          ${field({ name: 'position', label: 'Position', value: String(phases.length), options: [...phases.map((p, i) => [String(i), `Before ${i + 1}. ${p.name}`]), [String(phases.length), 'At the end']] })}
          <fieldset class="full"><legend class="small">The other stages' weights</legend><label class="check"><input type="radio" name="mode" value="scale" checked> Share the rest proportionally (preview first)</label><label class="check"><input type="radio" name="mode" value="manual"> I will set them myself under Weights</label></fieldset>
          <div class="actions full"><button class="btn primary" type="submit">Continue</button></div></form></details></section>
        <section class="panel" id="schedule"><details class="inline-form" ${req.query.schedule ? raw('open') : ''}><summary><b>Illustrative schedule from a start date</b></summary>
          <form method="post" action="${W_}/schedule" class="form-grid">${csrfField(req)}
          ${field({ name: 'anchor', label: 'Project start date', type: 'date', value: iso(master.anchor_start) || '', required: true })}${field({ name: 'defects_months', label: 'Defects period (months)', type: 'number', value: master.defects_months || M.DEFAULT_DEFECTS_MONTHS, attrs: 'min="1" max="60"' })}
          ${field({ name: 'mode', label: 'Dates to fill', value: 'empty', options: [['empty', 'Only empty planned dates'], ['all', 'Replace all planned dates']] })}
          <div class="actions full"><button class="btn" type="submit">Fill planned dates</button></div>
          <p class="muted small full">Uses each stage's indicative weeks for a conventional 2–3-storey villa (mobilisation about week 10, handover about week 59) and splits each stage evenly between its tasks. It is an illustrative starting point, not a calculated critical path: approvals, resources, weather, site conditions and suppliers change it. Adjust the dates by hand; changing the start date later does not reschedule anything by itself.</p></form></details></section>` : ''}`));
  });

  // ---------- stage and task edits ----------
  const num = (v, what) => { const n = Number(String(v ?? '').replace(/[,%\s]/g, '')); if (!Number.isFinite(n) || n < 0 || n > 100) throw bad(`${what} must be between 0 and 100.`); return M.r3(n); };

  // a preview of the weights before and after, with a confirm button that re-posts the same form
  function weightPreview(req, a, title, rows, hidden, back) {
    return pg(req, a, 'Stages & tasks', html`<section class="panel"><h2 class="h">${title}</h2>
      <p>Check the new weights. They add up to 100%, so progress stays valid.</p>
      <div class="table-wrap"><table><thead><tr><th>Item</th><th class="n">Weight now</th><th class="n">After</th></tr></thead><tbody>
        ${rows.map(x => html`<tr class="${x.isNew ? 'mp-new' : x.removed ? 'mp-gone' : ''}"><td>${x.name}${x.isNew ? html` ${pill('New', 'info')}` : ''}${x.removed ? html` ${pill('Removed', 'bad')}` : ''}</td><td class="n">${x.before === null ? '—' : wfmt(x.before)}</td><td class="n"><b>${x.after === null ? '—' : wfmt(x.after)}</b></td></tr>`)}
        <tr><th>Total</th><td class="n">${wfmt(rows.filter(x => !x.isNew).reduce((s, x) => s + (x.before || 0), 0))}</td><td class="n"><b>${wfmt(rows.filter(x => !x.removed).reduce((s, x) => s + (x.after || 0), 0))}</b></td></tr></tbody></table></div>
      <form method="post" action="${hidden.action}" class="actions">${csrfField(req)}${Object.entries(hidden.fields).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}<input type="hidden" name="confirm" value="1">
        <button class="btn primary" type="submit">Confirm</button><a class="btn" href="${back}">Cancel</a></form></section>`);
  }

  r.post('/w/:id/master/stages', async (req, res) => {
    const a = await access(req, 'edit');
    if (!(await masterOf(a.ws.id))) throw new NotFound();
    const name = txt(req.body.name, 120); if (!name) throw bad('Enter a stage name.');
    const w = num(req.body.weight, 'The stage weight');
    const mode = req.body.mode === 'manual' ? 'manual' : 'scale';
    const phases = (await pool.query('select id, name, weight, sort from phases where workspace_id = $1 and archived_at is null order by sort, created_at', [a.ws.id])).rows;
    const pos = Math.max(0, Math.min(phases.length, parseInt(req.body.position, 10) || 0));
    const scaled = mode === 'scale' ? M.withNew(phases.map(p => Number(p.weight) || 0), w) : null;
    if (mode === 'scale' && req.body.confirm !== '1') {
      const rows = phases.map((p, i) => ({ name: `${i + 1}. ${p.name}`, before: p.weight === null ? null : Number(p.weight), after: scaled.others[i] }));
      rows.splice(pos, 0, { name, before: null, after: scaled.added, isNew: true });
      return res.send(weightPreview(req, a, `Add stage “${name}”`, rows, { action: `${W(a)}/stages`, fields: { name, weight: w, position: pos, mode } }, W(a)));
    }
    await core.inTx(async db => {
      const order = phases.map(p => p.id); order.splice(pos, 0, null);
      const id = (await db.query('insert into phases (workspace_id, name, weight, sort) values ($1,$2,$3,$4) returning id', [a.ws.id, name, mode === 'scale' ? scaled.added : w, pos])).rows[0].id;
      order[pos] = id;
      for (let i = 0; i < order.length; i++) await db.query('update phases set sort = $2 where id = $1', [order[i], i]);
      if (scaled) for (let i = 0; i < phases.length; i++) await db.query('update phases set weight = $2 where id = $1', [phases[i].id, scaled.others[i]]);
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'stage.created', entity: 'phase', entityId: id, summary: `Stage added: ${name} (${mode === 'scale' ? `weight ${scaled.added}%, others rescaled` : 'weights to be set manually'})`, ip: req.ip });
      await P.touch(db, a.ws.id);
    });
    res.redirect(mode === 'manual' ? `${W(a)}/weights?msg=added` : `${W(a)}?msg=added`);
  });

  r.post('/w/:id/master/stages/:pid', async (req, res) => {
    const a = await access(req, 'edit');
    const p = await P.own('phases', req.params.pid, a.ws.id);
    const v = { name: txt(req.body.name, 120), owner_text: txt(req.body.owner_text, 120), description: txt(req.body.description, 2000), planned_start: dateOrNull(req.body.planned_start), planned_end: dateOrNull(req.body.planned_end),
      actual_start: dateOrNull(req.body.actual_start), actual_finish: dateOrNull(req.body.actual_finish), duration_note: txt(req.body.duration_note, 120), hold: req.body.hold === '1', notes: txt(req.body.notes, 4000) };
    if (!v.name) throw bad('Enter a stage name.');
    if (v.planned_start && v.planned_end && v.planned_end < v.planned_start) throw bad('The planned finish is before the planned start.');
    if (v.actual_start && v.actual_finish && v.actual_finish < v.actual_start) throw bad('The actual finish is before the actual start.');
    if (req.body.progress !== undefined) v.progress = num(req.body.progress, 'Progress');
    await core.inTx(async db => {
      const cols = Object.keys(v);
      await db.query(`update phases set ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} where id = $1`, [p.id, ...cols.map(c => v[c])]);
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'stage.updated', entity: 'phase', entityId: p.id, summary: `Stage updated: ${v.name}`, before: { name: p.name, hold: p.hold, planned_start: iso(p.planned_start), planned_end: iso(p.planned_end) }, after: v, ip: req.ip });
      await P.touch(db, a.ws.id);
    });
    res.redirect(`${W(a)}?open=${p.id}&msg=saved#stage-${p.id}`);
  });

  async function move(table, row, dir, scopeSql, scopeVals) {
    const list = (await pool.query(`select id from ${table} where ${scopeSql} and archived_at is null order by sort, created_at`, scopeVals)).rows.map(x => x.id);
    const i = list.indexOf(row.id), j = dir === 'up' ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    await core.inTx(async db => { for (let k = 0; k < list.length; k++) await db.query(`update ${table} set sort = $2 where id = $1`, [list[k], k]); });
  }
  r.post('/w/:id/master/stages/:pid/move', async (req, res) => {
    const a = await access(req, 'edit');
    const p = await P.own('phases', req.params.pid, a.ws.id);
    await move('phases', p, req.body.dir, 'workspace_id = $1', [a.ws.id]);
    await core.audit(pool, { actor: req.user, workspaceId: a.ws.id, action: 'stage.moved', entity: 'phase', entityId: p.id, summary: `Stage moved ${req.body.dir === 'up' ? 'up' : 'down'}: ${p.name}`, ip: req.ip });
    res.redirect(`${W(a)}#stage-${p.id}`);
  });
  r.post('/w/:id/master/tasks/:tid/move', async (req, res) => {
    const a = await access(req, 'edit');
    const t = await P.own('tasks', req.params.tid, a.ws.id);
    await move('tasks', t, req.body.dir, 'workspace_id = $1 and phase_id is not distinct from $2', [a.ws.id, t.phase_id]);
    await core.audit(pool, { actor: req.user, workspaceId: a.ws.id, action: 'task.moved', entity: 'task', entityId: t.id, summary: `Task moved ${req.body.dir === 'up' ? 'up' : 'down'}: ${t.title}`, ip: req.ip });
    res.redirect(`${W(a)}?open=${t.phase_id}#task-${t.id}`);
  });

  r.post('/w/:id/master/tasks', async (req, res) => {
    const a = await access(req, 'edit');
    if (!(await masterOf(a.ws.id))) throw new NotFound();
    const p = await P.own('phases', req.body.phase_id, a.ws.id);
    const title = txt(req.body.title, 300); if (!title) throw bad('Enter a task title.');
    const w = num(req.body.weight, 'The task weight');
    const mode = req.body.mode === 'manual' ? 'manual' : 'scale';
    const ts = (await pool.query('select id, title, weight from tasks where phase_id = $1 and archived_at is null order by sort, created_at', [p.id])).rows;
    const scaled = mode === 'scale' ? M.withNew(ts.map(t => Number(t.weight) || 0), w) : null;
    if (mode === 'scale' && req.body.confirm !== '1') {
      const rows = [...ts.map(t => ({ name: t.title, before: t.weight === null ? null : Number(t.weight), after: scaled.others[ts.indexOf(t)] })), { name: title, before: null, after: scaled.added, isNew: true }];
      return res.send(weightPreview(req, a, `Add a task to “${p.name}”`, rows, { action: `${W(a)}/tasks`, fields: { phase_id: p.id, title, weight: w, mode, owner_text: req.body.owner_text || '' } }, `${W(a)}?open=${p.id}#stage-${p.id}`));
    }
    await core.inTx(async db => {
      const s = (await db.query('select coalesce(max(sort),-1)+1 as s from tasks where phase_id = $1', [p.id])).rows[0].s;
      const id = (await db.query('insert into tasks (workspace_id, phase_id, title, owner_text, weight, sort) values ($1,$2,$3,$4,$5,$6) returning id', [a.ws.id, p.id, title, txt(req.body.owner_text, 120), mode === 'scale' ? scaled.added : w, s])).rows[0].id;
      if (scaled) for (let i = 0; i < ts.length; i++) await db.query('update tasks set weight = $2 where id = $1', [ts[i].id, scaled.others[i]]);
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'task.created', entity: 'task', entityId: id, summary: `Task added to ${p.name}: ${title}`, ip: req.ip });
      await P.touch(db, a.ws.id);
    });
    res.redirect(mode === 'manual' ? `${W(a)}/weights?msg=added` : `${W(a)}?open=${p.id}&msg=added#stage-${p.id}`);
  });

  r.post('/w/:id/master/tasks/:tid', async (req, res) => {
    const a = await access(req, 'contribute');
    const t = await P.own('tasks', req.params.tid, a.ws.id);
    const edit = core.canEdit(a);
    const v = {};
    if (edit) {
      v.title = txt(req.body.title, 300); if (!v.title) throw bad('Enter a task title.');
      v.description = txt(req.body.description, 2000); v.owner_text = txt(req.body.owner_text, 120);
      v.start_date = dateOrNull(req.body.start_date); v.due_date = dateOrNull(req.body.due_date);
      if (v.start_date && v.due_date && v.due_date < v.start_date) throw bad('The planned finish is before the planned start.');
      v.is_milestone = req.body.is_milestone === '1'; v.notes = txt(req.body.notes, 4000);
    }
    const status = ['not_started', 'in_progress', 'on_hold', 'done'].includes(req.body.status) ? req.body.status : undefined;
    const rc = M.reconcile(status, req.body.progress);
    if (rc.status) v.status = rc.status; if (rc.progress !== null) v.progress = rc.progress;
    v.actual_start = dateOrNull(req.body.actual_start); v.actual_finish = dateOrNull(req.body.actual_finish);
    if (v.actual_start && v.actual_finish && v.actual_finish < v.actual_start) throw bad('The actual finish is before the actual start.');
    await core.inTx(async db => {
      const cols = Object.keys(v);
      await db.query(`update tasks set ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}, updated_at = now() where id = $1`, [t.id, ...cols.map(c => v[c])]);
      const before = { status: t.status, progress: t.progress, start_date: iso(t.start_date), due_date: iso(t.due_date) };
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'task.updated', entity: 'task', entityId: t.id, summary: `Task updated: ${v.title || t.title} (${M.TASK_LABEL[v.status || t.status]}, ${v.progress ?? t.progress}%)`, before, after: v, ip: req.ip });
      await P.touch(db, a.ws.id);
    });
    res.redirect(`${W(a)}?open=${t.phase_id}&msg=saved#task-${t.id}`);
  });

  // ---------- remove (with impact and weight choice) ----------
  async function removal(a, kind, row) {
    const { c, st, tasks, phases } = await load(a.ws.id);
    const siblings = kind === 'stage' ? phases : tasks.filter(t => t.phase_id === row.phase_id);
    const rest = siblings.filter(x => x.id !== row.id);
    const after = M.scaleTo(rest.map(x => Number(x.weight) || 0), 100);
    let impact;
    if (kind === 'stage') { const s = st[row.id]; impact = s && s.pct !== null && s.weight !== null ? s.weight * s.pct / 100 : null; }
    else { const s = st[row.phase_id]; impact = s && s.weight !== null && row.weight !== null ? s.weight * Number(row.weight) * M.taskPct(row) / 10000 : null; }
    return { c, rest, after, impact, siblings };
  }
  async function removeForm(req, res, kind) {
    const a = await access(req, 'edit');
    const row = await P.own(kind === 'stage' ? 'phases' : 'tasks', kind === 'stage' ? req.params.pid : req.params.tid, a.ws.id);
    const { c, rest, after, impact } = await removal(a, kind, row);
    const nTasks = kind === 'stage' ? (await pool.query('select count(*)::int as n from tasks where phase_id = $1 and archived_at is null', [row.id])).rows[0].n : 0;
    const name = kind === 'stage' ? row.name : row.title;
    res.send(pg(req, a, 'Stages & tasks', html`<form method="post" class="panel">${csrfField(req)}<h2 class="h">Remove ${kind} “${name}”?</h2>
      <ul>${kind === 'stage' ? html`<li>Its ${nTasks} task${nTasks === 1 ? '' : 's'} are removed with it.</li>` : ''}
        <li>It currently adds <b>${impact === null ? 'an unknown amount' : `${Math.round(impact * 100) / 100} percentage points`}</b> to overall progress${c.valid ? ` (now ${pct1(c.pct)})` : ''}. Progress is recalculated with the new weights.</li>
        <li>Nothing is deleted: it goes to History, where it can be restored.</li></ul>
      <fieldset><legend><b>Weights of the remaining ${kind === 'stage' ? 'stages' : 'tasks in this stage'}</b></legend>
        <label class="check"><input type="radio" name="mode" value="scale" checked> Share its weight proportionally:</label>
        ${rest.length ? html`<div class="table-wrap"><table><thead><tr><th>Item</th><th class="n">Now</th><th class="n">After</th></tr></thead><tbody>${rest.map((x, i) => html`<tr><td>${x.name || x.title}</td><td class="n">${wfmt(x.weight)}</td><td class="n"><b>${wfmt(after[i])}</b></td></tr>`)}</tbody></table></div>` : html`<p class="muted small">Nothing remains, so there are no weights to share.</p>`}
        <label class="check"><input type="radio" name="mode" value="manual"> Leave them; I will set them myself under Weights (progress is hidden until they add up to 100%)</label></fieldset>
      <div class="actions"><button class="btn danger" type="submit">Remove</button><a class="btn" href="${W(a)}">Cancel</a></div></form>`));
  }
  async function removeDo(req, res, kind) {
    const a = await access(req, 'edit');
    const table = kind === 'stage' ? 'phases' : 'tasks';
    const row = await P.own(table, kind === 'stage' ? req.params.pid : req.params.tid, a.ws.id);
    if (row.archived_at) return res.redirect(W(a));
    const { rest, after } = await removal(a, kind, row);
    const scale = req.body.mode !== 'manual';
    await core.inTx(async db => {
      const now = (await db.query('select now() as t')).rows[0].t;
      await db.query(`update ${table} set archived_at = $2 where id = $1`, [row.id, now]);
      if (kind === 'stage') await db.query('update tasks set archived_at = $2 where phase_id = $1 and archived_at is null', [row.id, now]);
      else await db.query('delete from task_deps where task_id = $1 or depends_on = $1', [row.id]);
      if (scale) for (let i = 0; i < rest.length; i++) await db.query(`update ${table} set weight = $2 where id = $1`, [rest[i].id, after[i]]);
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: `${kind}.removed`, entity: kind === 'stage' ? 'phase' : 'task', entityId: row.id, summary: `${kind === 'stage' ? 'Stage' : 'Task'} removed: ${row.name || row.title} (${scale ? 'weights shared proportionally' : 'weights to be set manually'}; restorable from History)`, ip: req.ip });
      await P.touch(db, a.ws.id);
    });
    res.redirect(scale ? `${W(a)}?msg=archived` : `${W(a)}/weights?msg=archived`);
  }
  r.get('/w/:id/master/stages/:pid/remove', (req, res) => removeForm(req, res, 'stage'));
  r.post('/w/:id/master/stages/:pid/remove', (req, res) => removeDo(req, res, 'stage'));
  r.get('/w/:id/master/tasks/:tid/remove', (req, res) => removeForm(req, res, 'task'));
  r.post('/w/:id/master/tasks/:tid/remove', (req, res) => removeDo(req, res, 'task'));

  // ---------- weights ----------
  r.get('/w/:id/master/weights', async (req, res) => {
    const a = await access(req);
    if (!(await masterOf(a.ws.id))) return res.redirect(W(a));
    const { phases, tasks, c } = await load(a.ws.id);
    const edit = core.canEdit(a);
    const dis = edit ? '' : 'disabled';
    res.send(pg(req, a, 'Weights', html`
      ${c.valid ? html`<p class="notice ok-n">Weights are valid: stages add up to 100%, and each stage's tasks add up to 100%.</p>` : html`<div class="notice warn"><b>Progress is hidden until the weights are valid.</b> ${c.issues.join(' ')}</div>`}
      <form method="post" class="stack mp-weights" data-weights>${csrfField(req)}
        <section class="panel"><div class="row-between"><h2 class="h">Stage weights (% of the project)</h2><span class="mp-sum-live" data-sum-of="sw">Total ${wfmt(phases.reduce((s, p) => s + (Number(p.weight) || 0), 0))}</span></div>
          <div class="mp-wgrid">${phases.map((p, i) => html`<label class="field"><span>${i + 1}. ${p.name}</span><input name="sw_${p.id}" data-group="sw" value="${p.weight === null ? '' : Number(p.weight)}" inputmode="decimal" ${raw(dis)}></label>`)}</div>
          ${edit ? html`<p class="small"><button class="btn small" type="submit" name="scale" value="sw">Scale stage weights to 100%</button></p>` : ''}</section>
        ${phases.map((p, i) => { const ts = tasks.filter(t => t.phase_id === p.id); return ts.length ? html`<section class="panel"><div class="row-between"><h2 class="h">${i + 1}. ${p.name}: task weights (% of the stage)</h2><span class="mp-sum-live" data-sum-of="tw_${p.id}">Total ${wfmt(ts.reduce((s, t) => s + (Number(t.weight) || 0), 0))}</span></div>
          <div class="mp-wgrid">${ts.map((t, j) => html`<label class="field"><span>${i + 1}.${j + 1} ${t.title}</span><input name="tw_${t.id}" data-group="tw_${p.id}" value="${t.weight === null ? '' : Number(t.weight)}" inputmode="decimal" ${raw(dis)}></label>`)}</div>
          ${edit ? html`<p class="small"><button class="btn small" type="submit" name="scale" value="tw_${p.id}">Scale these to 100%</button></p>` : ''}</section>` : ''; })}
        ${edit ? html`<div class="actions"><button class="btn primary" type="submit">Save weights</button></div><p class="muted small">Saving needs every weight to be zero or more, the stages to add up to 100%, and each stage's tasks to add up to 100%. Nothing is saved otherwise.</p>` : ''}
      </form>`));
  });
  r.post('/w/:id/master/weights', async (req, res) => {
    const a = await access(req, 'edit');
    const { phases, tasks } = await load(a.ws.id);
    const read = (k, label) => { const v = req.body[k]; if (v === undefined || String(v).trim() === '') throw bad(`${label}: enter a weight.`); return num(v, label); };
    let sw = phases.map((p, i) => read(`sw_${p.id}`, `${i + 1}. ${p.name}`));
    const tw = {};
    for (const p of phases) { const ts = tasks.filter(t => t.phase_id === p.id); tw[p.id] = ts.map(t => read(`tw_${t.id}`, t.title)); }
    if (req.body.scale === 'sw') sw = M.scaleTo(sw);
    else if (String(req.body.scale || '').startsWith('tw_')) { const pid = req.body.scale.slice(3); if (tw[pid]) tw[pid] = M.scaleTo(tw[pid]); }
    const near = x => Math.abs(x - 100) <= 0.01;
    const total = sw.reduce((s, x) => s + x, 0);
    const errs = [];
    if (phases.length && !near(total)) errs.push(`Stage weights add up to ${M.r3(total)}%, not 100%.`);
    for (const p of phases) if (tw[p.id].length) { const s = tw[p.id].reduce((x, y) => x + y, 0); if (!near(s)) errs.push(`${p.name}: task weights add up to ${M.r3(s)}%, not 100%.`); }
    if (errs.length && !req.body.scale) throw bad(`Nothing was saved. ${errs.join(' ')}`);
    await core.inTx(async db => {
      for (let i = 0; i < phases.length; i++) await db.query('update phases set weight = $2 where id = $1', [phases[i].id, sw[i]]);
      for (const p of phases) { const ts = tasks.filter(t => t.phase_id === p.id); for (let j = 0; j < ts.length; j++) await db.query('update tasks set weight = $2 where id = $1', [ts[j].id, tw[p.id][j]]); }
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'master.weights', entity: 'plan', entityId: a.ws.id, summary: req.body.scale ? 'Weights scaled to 100%' : 'Plan weights updated', after: { stages: Object.fromEntries(phases.map((p, i) => [p.name, sw[i]])) }, ip: req.ip });
      await P.touch(db, a.ws.id);
    });
    res.redirect(`${W(a)}/weights?msg=saved`);
  });

  // ---------- illustrative schedule ----------
  r.post('/w/:id/master/schedule', async (req, res) => {
    const a = await access(req, 'edit');
    const master = await masterOf(a.ws.id); if (!master) throw new NotFound();
    const anchor = dateOrNull(req.body.anchor); if (!anchor) throw bad('Enter the project start date.');
    const months = Math.max(1, Math.min(60, parseInt(req.body.defects_months, 10) || M.DEFAULT_DEFECTS_MONTHS));
    const all = req.body.mode === 'all';
    const { phases, tasks } = await load(a.ws.id);
    const plan = M.illustrative(anchor, phases, tasks, months);
    let n = 0;
    await core.inTx(async db => {
      for (const p of phases) { const d = plan.phases[p.id]; if (!d) continue;
        if (all || !p.planned_start) { await db.query('update phases set planned_start = $2 where id = $1', [p.id, d.start]); n++; }
        if (all || !p.planned_end) await db.query('update phases set planned_end = $2 where id = $1', [p.id, d.end]); }
      for (const t of tasks) { const d = plan.tasks[t.id]; if (!d) continue;
        const s = all || !t.start_date ? d.start : iso(t.start_date), e = all || !t.due_date ? d.end : iso(t.due_date);
        if (e < s) continue;
        if (s !== iso(t.start_date) || e !== iso(t.due_date)) { await db.query('update tasks set start_date = $2, due_date = $3, updated_at = now() where id = $1', [t.id, s, e]); n++; } }
      await db.query('update master_plans set anchor_start = $2, defects_months = $3 where workspace_id = $1', [a.ws.id, anchor, months]);
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'master.scheduled', entity: 'plan', entityId: a.ws.id, summary: `Illustrative schedule from ${anchor} (${all ? 'all planned dates replaced' : 'empty dates filled'}; defects period ${months} months)`, ip: req.ip });
      await P.touch(db, a.ws.id);
    });
    res.redirect(`${W(a)}/gantt?msg=saved`);
  });

  // ---------- Gantt chart ----------
  r.get('/w/:id/master/gantt', async (req, res) => {
    const a = await access(req);
    if (!(await masterOf(a.ws.id))) return res.redirect(W(a));
    const { phases, tasks, c, st } = await load(a.ws.id);
    const today = todayBH();
    const zoom = req.query.z === 'month' ? 'month' : 'week';
    const only = req.query.show === 'stages';
    const deps = (await pool.query('select d.* from task_deps d join tasks t on t.id = d.task_id where t.workspace_id = $1', [a.ws.id])).rows;
    const span = p => { const ts = tasks.filter(t => t.phase_id === p.id); return { s: iso(p.planned_start) || ts.map(t => iso(t.start_date)).filter(Boolean).sort()[0] || null, e: iso(p.planned_end) || ts.map(t => iso(t.due_date)).filter(Boolean).sort().slice(-1)[0] || null }; };
    const dates = [...phases.flatMap(p => { const x = span(p); return [x.s, x.e, iso(p.actual_start), iso(p.actual_finish)]; }), ...tasks.flatMap(t => [iso(t.start_date), iso(t.due_date), iso(t.actual_start), iso(t.actual_finish)])].filter(Boolean).sort();
    const unscheduled = tasks.filter(t => !t.start_date || !t.due_date);
    if (!dates.length) return res.send(pg(req, a, 'Gantt chart', html`${emptyState('No planned dates yet', 'The Gantt chart draws this project\'s own planned dates. None are set yet, and the system does not invent them.', core.canEdit(a) ? html`<a class="btn primary" href="${W(a)}?schedule=1#schedule">Enter dates, or fill an illustrative schedule from a start date</a>` : '')}`));
    const D = s => Date.parse(s + 'T00:00:00Z') / 86400000;
    let d0 = D(dates[0]), d1 = D(dates[dates.length - 1]);
    const t0 = D(today); if (t0 < d0 && d0 - t0 < 60) d0 = t0; if (t0 > d1 && t0 - d1 < 60) d1 = t0;
    d0 -= 7; d1 += 7;
    const pxd = zoom === 'month' ? 2.2 : 7;
    const width = Math.round((d1 - d0 + 1) * pxd);
    const X = s => Math.round((D(s) - d0) * pxd);
    const W_ = s => Math.max(3, Math.round((D(s.e) - D(s.s) + 1) * pxd));
    // header: months (and week ticks at the week zoom)
    const months = []; { const d = new Date((d0 * 86400000)); d.setUTCDate(1); while (d.getTime() / 86400000 <= d1) { const s = d.toISOString().slice(0, 10); months.push({ x: Math.max(0, X(s)), label: d.toLocaleDateString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' }) }); d.setUTCMonth(d.getUTCMonth() + 1); } }
    const todayX = t0 >= d0 && t0 <= d1 ? X(today) : null;
    const rows = [];
    phases.forEach((p, i) => {
      const s = st[p.id], sp = span(p);
      rows.push({ kind: 'stage', id: p.id, no: `${i + 1}`, name: p.name, status: s.status, pct: s.pct, s: sp.s, e: sp.e, as: iso(p.actual_start), ae: iso(p.actual_finish), href: `${W(a)}?open=${p.id}#stage-${p.id}` });
      if (!only) tasks.filter(t => t.phase_id === p.id).forEach((t, j) => rows.push({ kind: 'task', id: t.id, no: `${i + 1}.${j + 1}`, name: t.title, status: t.status, pct: M.taskPct(t), s: iso(t.start_date), e: iso(t.due_date), as: iso(t.actual_start), ae: iso(t.actual_finish), ms: t.is_milestone, href: `${W(a)}?open=${p.id}#task-${t.id}` }));
    });
    const bar = x => {
      if (!x.s || !x.e) return html`<span class="gt-none">No dates</span>`;
      if (x.ms && x.kind === 'task') return html`<a class="gt-ms st-${x.status}" href="${x.href}" style="left:${X(x.e) - 7}px" title="${x.no} ${x.name}: milestone ${fmtDate(x.e)} · ${M.TASK_LABEL[x.status]}"><span class="sr-only">${x.name}</span></a>`;
      return html`<a class="gt-bar ${x.kind} st-${x.status}" href="${x.href}" style="left:${X(x.s)}px;width:${W_(x)}px" title="${x.no} ${x.name}: ${fmtDate(x.s)} – ${fmtDate(x.e)} · ${M.TASK_LABEL[x.status] || M.STAGE_LABEL[x.status]} · ${x.pct === null ? '—' : Math.round(x.pct) + '%'}">
        <span class="gt-fill" style="width:${x.pct || 0}%"></span><span class="gt-txt">${x.pct === null || W_(x) < 38 ? '' : `${Math.round(x.pct)}%`}</span></a>${x.as ? html`<span class="gt-actual" style="left:${X(x.as)}px;width:${Math.max(3, Math.round((D(x.ae || today) - D(x.as) + 1) * pxd))}px" title="Actual ${fmtDate(x.as)} – ${x.ae ? fmtDate(x.ae) : 'ongoing'}"></span>` : ''}`;
    };
    // overlapping stages (they may run at the same time; durations are never simply added)
    const sp = phases.map(p => ({ p, ...span(p) })).filter(x => x.s && x.e);
    const overlaps = []; for (let i = 0; i < sp.length; i++) for (let j = i + 1; j < sp.length; j++) if (sp[i].s <= sp[j].e && sp[j].s <= sp[i].e) overlaps.push(`${sp[i].p.name} / ${sp[j].p.name}`);
    const late = tasks.filter(t => t.due_date && iso(t.due_date) < today && t.status !== 'done').length;
    const q = (k, v) => { const u = new URLSearchParams({ z: zoom, ...(only ? { show: 'stages' } : {}), [k]: v }); if (k === 'show' && !v) u.delete('show'); return `?${u}`; };
    res.send(pg(req, a, 'Gantt chart', html`
      <div class="filters"><span class="small muted">Scale</span><a class="btn small ${zoom === 'week' ? 'primary' : ''}" href="${q('z', 'week')}">Weeks</a><a class="btn small ${zoom === 'month' ? 'primary' : ''}" href="${q('z', 'month')}">Months</a>
        <span class="small muted">Show</span><a class="btn small ${!only ? 'primary' : ''}" href="${q('show', '')}">Stages and tasks</a><a class="btn small ${only ? 'primary' : ''}" href="${q('show', 'stages')}">Stages only</a></div>
      <section class="panel gt-wrap" aria-label="Gantt chart for ${a.ws.name}">
        <div class="gt" style="--gw:${width}px">
          <div class="gt-head"><div class="gt-name gt-corner">Stage / task</div><div class="gt-track">${months.map(m => html`<span class="gt-month" style="left:${m.x}px">${m.label}</span>`)}${todayX !== null ? html`<span class="gt-today-lbl" style="left:${todayX}px">Today</span>` : ''}</div></div>
          ${rows.map(x => html`<div class="gt-row ${x.kind}"><div class="gt-name"><span class="gt-no">${x.no}</span><a href="${x.href}">${x.name}</a></div>
            <div class="gt-track">${months.map(m => html`<span class="gt-grid" style="left:${m.x}px"></span>`)}${todayX !== null ? html`<span class="gt-today" style="left:${todayX}px"></span>` : ''}${bar(x)}</div></div>`)}
        </div></section>
      <section class="panel"><ul class="gt-legend small"><li><span class="gt-key st-done"></span>Completed</li><li><span class="gt-key st-in_progress"></span>In progress</li><li><span class="gt-key st-not_started"></span>Not started</li><li><span class="gt-key st-on_hold"></span>On hold</li><li><span class="gt-key gt-key-act"></span>Actual dates</li><li><span class="gt-key gt-key-ms"></span>Milestone</li><li><span class="gt-key gt-key-today"></span>Today</li></ul>
        <p class="small">${c.valid ? `Overall progress ${pct1(c.pct)}. ` : 'Progress hidden: weights incomplete. '}${late ? html`<span class="err">${late} task${late === 1 ? ' is' : 's are'} past the planned finish.</span> ` : ''}${overlaps.length ? `Overlapping stages: ${overlaps.slice(0, 6).join('; ')}${overlaps.length > 6 ? '…' : ''}. ` : ''}${deps.length ? `${deps.length} dependenc${deps.length === 1 ? 'y is' : 'ies are'} recorded; dates are not moved automatically.` : 'Dates are planned by hand; nothing is rescheduled automatically and no critical path is calculated.'}</p>
        ${unscheduled.length ? html`<details class="small"><summary>Unscheduled tasks (${unscheduled.length})</summary><ul>${unscheduled.map(t => html`<li><a href="${W(a)}?open=${t.phase_id}#task-${t.id}">${t.title}</a></li>`)}</ul></details>` : ''}</section>`));
  });

  // ---------- procurement tracker ----------
  r.get('/w/:id/master/procurement', async (req, res) => {
    const a = await access(req);
    if (!(await masterOf(a.ws.id))) return res.redirect(W(a));
    const today = todayBH();
    const items = (await pool.query(`select x.*, p.name as stage from procurement_items x left join phases p on p.id = x.phase_id where x.workspace_id = $1 and x.archived_at is null order by x.needed_on nulls last, x.sort, x.created_at`, [a.ws.id])).rows;
    const phases = (await pool.query('select id, name from phases where workspace_id = $1 and archived_at is null order by sort', [a.ws.id])).rows;
    const edit = core.canContribute(a);
    const names = await require('./choices').knownNames(pool, a.ws.id);
    const CH = require('./choices');
    const phaseInfo = (await pool.query('select id, template_key, planned_start from phases where workspace_id = $1 and archived_at is null', [a.ws.id])).rows;
    const smart = JSON.stringify({ items: Object.fromEntries(CH.PROC_ITEMS), stages: Object.fromEntries(phaseInfo.map(p => [p.id, { key: p.template_key, start: iso(p.planned_start) }])) });
    // every input picks or taps where it can; the latest dates are worked out while filling in
    const form = (x = {}) => html`<div class="full" hidden data-proc-info="${smart}"></div>
      ${field({ name: 'item', label: 'Material / item', value: x.item || '', required: true, list: CH.PROC_ITEMS.map(i => i[0]) })}${field({ name: 'responsible', label: 'Responsible', value: x.responsible || '', list: names })}
      ${field({ name: 'phase_id', label: 'Stage (filled from the item)', value: x.phase_id || '', options: [['', '—'], ...phases.map(p => [p.id, p.name])], attrs: 'data-proc-stage' })}${field({ name: 'needed_on', label: 'Needed on site', type: 'date', value: iso(x.needed_on) || '', attrs: 'data-proc-needed', hint: 'Filled with the stage\'s planned start when it has one.' })}
      ${field({ name: 'approval_days', label: 'Approval time (days)', type: 'number', value: x.approval_days ?? '', attrs: 'min="0" data-proc-n', presets: [0, 7, 14, 21, 30] })}${field({ name: 'lead_days', label: 'Supplier lead time (days)', type: 'number', value: x.lead_days ?? '', attrs: 'min="0" data-proc-n', presets: [14, 30, 45, 60, 90, 120], hint: 'From the supplier; not estimated by the system.' })}
      ${field({ name: 'buffer_days', label: 'Buffer (days)', type: 'number', value: x.buffer_days ?? '', attrs: 'min="0" data-proc-n', presets: [0, 7, 14, 21] })}
      <div class="proc-calc" data-proc-calc aria-live="polite">Enter the date needed on site and the lead time to see the latest approval and order dates.</div>
      ${field({ name: 'status', label: 'Status', value: x.status || 'planned', options: Object.entries(PROC_STATUS), buttons: true, full: true })}
      ${field({ name: 'notes', label: 'Notes', value: x.notes || '', type: 'textarea', full: true })}`;
    const rows = items.map(x => ({ x, d: M.procurementDates(x, today) }));
    const overdue = rows.filter(r => r.d.late).length;
    res.send(pg(req, a, 'Procurement', html`
      ${overdue ? html`<div class="notice warn"><b>${overdue} item${overdue === 1 ? ' is' : 's are'} past the latest ${overdue === 1 ? 'date' : 'dates'}</b> for approval or ordering. Act now or move the needed-on-site date.</div>` : ''}
      <section class="panel"><h2 class="h">Key materials</h2>
        ${rows.length ? html`<div class="table-wrap"><table><thead><tr><th>Item</th><th>Responsible</th><th>Needed on site</th><th class="n">Approval + lead + buffer</th><th>Latest approval</th><th>Latest order</th><th>Status</th><th></th></tr></thead><tbody>
          ${rows.map(({ x, d }) => html`<tr class="${d.late ? 'late' : ''}"><td><b>${x.item}</b>${x.stage ? html`<div class="muted small">${x.stage}</div>` : ''}</td><td>${x.responsible || '—'}</td><td>${fmtDate(x.needed_on) || '—'}</td>
            <td class="n small">${x.approval_days ?? '—'} + ${x.lead_days ?? '—'} + ${x.buffer_days ?? 0} days</td>
            <td class="${d.late === 'approval' ? 'err' : ''}">${d.approval ? fmtDate(d.approval) : '—'}${d.late === 'approval' ? html` ${pill('Past due', 'bad')}` : ''}</td>
            <td class="${d.late === 'order' ? 'err' : ''}">${d.order ? fmtDate(d.order) : html`<span class="muted small">Needs the date and lead time</span>`}${d.late === 'order' ? html` ${pill('Past due', 'bad')}` : ''}</td>
            <td>${pill(PROC_STATUS[x.status], x.status === 'delivered' ? 'ok' : x.status === 'ordered' ? 'info' : 'muted')}</td>
            <td>${edit ? html`<details class="inline-form"><summary class="small">Edit</summary><form method="post" action="${W(a)}/procurement/${x.id}" class="form-grid">${csrfField(req)}${form(x)}
              <div class="actions full"><button class="btn primary small" type="submit">Save</button><button class="btn small" type="submit" name="archive" value="1">Remove</button></div></form></details>` : ''}</td></tr>`)}
        </tbody></table></div>` : html`<p class="muted">No items yet. Add the materials with long lead times (for example windows, AC equipment, lifts, sanitary ware, kitchens).</p>`}
        <p class="muted small">Latest order date = needed on site − supplier lead time − buffer. Latest approval date = latest order date − approval time. Calendar days. Lead times are entered per project from the supplier; nothing is assumed.</p></section>
      ${edit ? html`<section class="panel"><details class="inline-form" ${rows.length ? '' : raw('open')}><summary><b>Add an item</b></summary><form method="post" action="${W(a)}/procurement" class="form-grid">${csrfField(req)}${form()}
        <div class="actions full"><button class="btn primary" type="submit">Add</button></div></form></details></section>` : ''}`));
  });
  const readProc = b => {
    const n = (v, l) => { if (v === undefined || v === '') return null; const x = Number(v); if (!Number.isInteger(x) || x < 0 || x > 3650) throw bad(`${l} must be a whole number of days.`); return x; };
    const v = { item: txt(b.item, 200), responsible: txt(b.responsible, 120), needed_on: dateOrNull(b.needed_on), approval_days: n(b.approval_days, 'Approval time'), lead_days: n(b.lead_days, 'Lead time'), buffer_days: n(b.buffer_days, 'Buffer'),
      status: PROC_STATUS[b.status] ? b.status : 'planned', notes: txt(b.notes, 2000) };
    if (!v.item) throw bad('Enter the material or item.');
    return v;
  };
  r.post('/w/:id/master/procurement', async (req, res) => {
    const a = await access(req, 'contribute');
    const v = readProc(req.body);
    const ph = req.body.phase_id ? (await P.own('phases', req.body.phase_id, a.ws.id)).id : null;
    await core.inTx(async db => {
      const id = (await db.query(`insert into procurement_items (workspace_id, phase_id, item, responsible, needed_on, approval_days, lead_days, buffer_days, status, notes, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
        [a.ws.id, ph, v.item, v.responsible, v.needed_on, v.approval_days, v.lead_days, v.buffer_days, v.status, v.notes, req.user.id])).rows[0].id;
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'procurement.added', entity: 'procurement_item', entityId: id, summary: `Procurement item added: ${v.item}`, ip: req.ip });
    });
    res.redirect(`${W(a)}/procurement?msg=added`);
  });
  r.post('/w/:id/master/procurement/:pid', async (req, res) => {
    const a = await access(req, 'contribute');
    const x = await P.own('procurement_items', req.params.pid, a.ws.id);
    if (req.body.archive === '1') {
      await core.inTx(async db => { await db.query('update procurement_items set archived_at = now() where id = $1', [x.id]); await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'procurement.removed', entity: 'procurement_item', entityId: x.id, summary: `Procurement item removed: ${x.item}`, ip: req.ip }); });
      return res.redirect(`${W(a)}/procurement?msg=archived`);
    }
    const v = readProc(req.body);
    v.phase_id = req.body.phase_id ? (await P.own('phases', req.body.phase_id, a.ws.id)).id : null;
    await core.inTx(async db => {
      const cols = Object.keys(v);
      await db.query(`update procurement_items set ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}, updated_at = now() where id = $1`, [x.id, ...cols.map(c => v[c])]);
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'procurement.updated', entity: 'procurement_item', entityId: x.id, summary: `Procurement item updated: ${v.item} (${PROC_STATUS[v.status]})`, ip: req.ip });
    });
    res.redirect(`${W(a)}/procurement?msg=saved`);
  });

  // ---------- Super Admin: the default template ----------
  r.get('/admin/master-plan', async (req, res) => {
    if (!core.isSuper(req.user)) throw new Forbidden();
    const tpl = await template();
    const used = (await pool.query('select template_version as v, count(*)::int as n from master_plans group by 1 order by 1', [])).rows;
    const blank = { key: '', name: '', weight: '', duration: '', startWeek: '', endWeek: '', tasks: [] };
    const stageForm = (s, i) => html`<fieldset class="panel form-grid"><legend><b>Stage ${i + 1}</b></legend><input type="hidden" name="key_${i}" value="${s.key || ''}">
      ${field({ name: `name_${i}`, label: 'Stage name', value: s.name, hint: i >= tpl.stages.length ? 'Fill in to add a stage.' : 'Empty the name to remove the stage.' })}${field({ name: `weight_${i}`, label: 'Stage weight (%)', value: s.weight, attrs: 'inputmode="decimal"' })}
      ${field({ name: `duration_${i}`, label: 'Indicative duration', value: s.duration || '' })}${field({ name: `start_${i}`, label: 'Start week', value: s.startWeek ?? '', type: 'number', attrs: 'step="0.5" min="0"' })}${field({ name: `end_${i}`, label: 'End week', value: s.endWeek ?? '', type: 'number', attrs: 'step="0.5" min="0"' })}
      <label class="field check"><input type="checkbox" name="after_${i}" value="1" ${s.afterHandover ? raw('checked') : ''}> <span>Starts after handover (defects period)</span></label>
      ${field({ name: `tasks_${i}`, label: 'Tasks: one per line as “title | weight” (add “| milestone” for a milestone)', type: 'textarea', full: true, value: s.tasks.map(t => `${t.title} | ${t.weight}${t.milestone ? ' | milestone' : ''}`).join('\n'), attrs: 'rows="7"' })}</fieldset>`;
    res.send(layout(req, { title: 'Construction master template', heading: 'Admin', crumbs: [['Home', '/'], ['Admin', '/admin'], ['Master template']],
      tabs: [['Users', '/admin/users'], ['Roles', '/admin/roles'], ['Agreements', '/admin/agreements'], ['Master template', '/admin/master-plan', true], ['Outbox', '/admin/outbox'], ['Audit log', '/admin/audit'], ['System', '/admin/system']].map(([l, h, c]) => [l, h, !!c]), body: html`<h2 class="h">Construction master template</h2>
      <section class="panel"><p>Version <b>${tpl.version}</b>, used by both SarayDar Real Estate Development and Clients Projects Management for <b>new</b> projects. Saving creates a new version; existing projects keep their own plans and are never changed.</p>
        <p class="small muted">${used.length ? `Projects on the master plan: ${used.map(u => `${u.n} on v${u.v}`).join(', ')}.` : 'No project uses it yet.'} Weights and durations are suggested defaults, not a standard, a contract payment schedule or a cost estimate.</p></section>
      <form method="post" class="stack">${csrfField(req)}${[...tpl.stages, blank].map(stageForm)}
        <div class="actions"><button class="btn primary" type="submit">Save as version ${tpl.version + 1}</button><button class="btn" type="submit" name="reset" value="1" data-confirm="Replace the template with the original baseline as a new version?">Reset to the original baseline</button></div></form>` }));
  });
  r.post('/admin/master-plan', async (req, res) => {
    if (!core.isSuper(req.user)) throw new Forbidden();
    const tpl = await template();
    let stages;
    if (req.body.reset === '1') stages = M.BASELINE;
    else {
      stages = [];
      for (let i = 0; i <= tpl.stages.length; i++) {
        const name = txt(req.body[`name_${i}`], 120); if (!name) continue;
        const tasks = String(req.body[`tasks_${i}`] || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean).map((l, j) => {
          const parts = l.split('|').map(x => x.trim());
          return { key: `${stages.length + 1}.${j + 1}`, title: parts[0].slice(0, 300), weight: Number(String(parts[1] || '').replace(/[%\s]/g, '')), ...(/^milestone$/i.test(parts[2] || '') ? { milestone: true } : {}) };
        });
        const n = v => v === undefined || v === '' ? undefined : Number(v);
        stages.push({ key: req.body[`key_${i}`] || `S${stages.length + 1}`, name, weight: Number(String(req.body[`weight_${i}`] || '').replace(/[%\s]/g, '')), duration: txt(req.body[`duration_${i}`], 120) || '',
          startWeek: n(req.body[`start_${i}`]), endWeek: n(req.body[`end_${i}`]), ...(req.body[`after_${i}`] === '1' ? { afterHandover: true } : {}), tasks });
      }
      const errs = M.validateTemplate(stages);
      if (errs.length) throw bad(`Not saved. ${errs.join(' ')}`);
    }
    await core.inTx(async db => {
      await db.query('update master_templates set stages = $2, version = version + 1, updated_by = $3, updated_at = now() where key = $1', [M.TEMPLATE_KEY, JSON.stringify(stages), req.user.id]);
      await core.audit(db, { actor: req.user, workspaceId: null, action: 'master.template_updated', entity: 'master_template', entityId: null, summary: `Construction master template saved as version ${tpl.version + 1} (${stages.length} stages)${req.body.reset === '1' ? ' — reset to the original baseline' : ''}`, ip: req.ip });
    });
    res.redirect('/admin/master-plan?msg=saved');
  });
}

module.exports = { mountMasterPlan };
