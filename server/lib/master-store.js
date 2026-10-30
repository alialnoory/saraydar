'use strict';
// Database side of the construction master plan: the default template, copying it into a project, and the one-time
// move of existing projects onto it (owner decision 2026-10-27).
const M = require('./master-plan');
const iso = d => d ? (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)) : null;

async function template(db, key = M.TEMPLATE_KEY) {
  if (!M.TEMPLATES[key]) key = M.TEMPLATE_KEY;
  let row = (await db.query('select * from master_templates where key = $1', [key])).rows[0];
  if (!row) row = (await db.query('insert into master_templates (key, version, stages) values ($1, 1, $2) on conflict (key) do update set key = excluded.key returning *', [key, JSON.stringify(M.TEMPLATES[key].stages)])).rows[0];
  return row;
}

// Copy the template into a project. carry: template task key → the old task whose progress and dates it keeps.
async function applyTemplate(db, wsId, userId, carry = {}, key = M.TEMPLATE_KEY) {
  const tpl = await template(db, key);
  let ps = 0;
  for (const s of tpl.stages) {
    const ph = (await db.query(`insert into phases (workspace_id, name, sort, weight, suggested_weight, template_key, duration_note, start_week, end_week, after_handover)
      values ($1,$2,$3,$4,$4,$5,$6,$7,$8,$9) returning id`, [wsId, s.name, ps++, s.weight, s.key, s.duration || null, s.startWeek ?? null, s.endWeek ?? null, !!s.afterHandover])).rows[0].id;
    let ts = 0;
    for (const t of s.tasks) {
      const o = carry[t.key] || {};
      await db.query(`insert into tasks (workspace_id, phase_id, title, weight, sort, template_key, is_milestone, status, progress, start_date, due_date, actual_start, actual_finish, owner_text, owner_user, notes, verified)
        values ($1,$2,$3,$4,$5,$6,$7,coalesce($8,'not_started'),coalesce($9,0),$10,$11,$12,$13,$14,$15,$16,coalesce($17,true))`,
        [wsId, ph, t.title, t.weight, ts++, t.key, !!t.milestone || !!o.is_milestone, o.status === 'cancelled' ? 'not_started' : o.status || null, o.progress ?? null,
          iso(o.start_date), iso(o.due_date), iso(o.actual_start), iso(o.actual_finish), o.owner_text || null, o.owner_user || null, o.notes || null, o.verified ?? null]);
    }
  }
  await db.query(`insert into master_plans (workspace_id, template_key, template_version, applied_by) values ($1,$2,$3,$4)
    on conflict (workspace_id) do update set template_key = excluded.template_key, template_version = excluded.template_version, applied_by = excluded.applied_by, applied_at = now()`,
    [wsId, tpl.key, tpl.version, userId]);
  return tpl;
}

// One-time move (owner decision 2026-10-27): every active or on-hold development and client project that is not yet on
// the master plan gets a fresh copy at 0%, and its old plan (phases, tasks, task comments and dependencies, plan
// versions and archives) is deleted permanently. Completed and archived projects keep their finished plans.
// Progress updates, photos, registers, budgets and documents are not touched. Runs once; one transaction per project.
const JOB = 'master_plan_conversion_v1';
async function convertExisting(pool, { log = console.log } = {}) {
  if ((await pool.query('select 1 from app_state where key = $1', [JOB])).rowCount) return null;
  const c = await pool.connect();
  const done = [];
  try {
    await c.query('select pg_advisory_lock(727021)');
    if ((await c.query('select 1 from app_state where key = $1', [JOB])).rowCount) return null;
    const list = (await c.query(`select w.id, w.ref, w.name from workspaces w where w.section in ('dev','cpm') and w.status in ('active','on_hold')
      and not exists (select 1 from master_plans m where m.workspace_id = w.id) order by w.ref`)).rows;
    for (const w of list) {
      await c.query('begin');
      try {
        const taskIds = (await c.query('select id from tasks where workspace_id = $1', [w.id])).rows.map(x => x.id);
        const phaseN = (await c.query('select count(*)::int as n from phases where workspace_id = $1', [w.id])).rows[0].n;
        if (taskIds.length) await c.query("delete from comments where workspace_id = $1 and entity = 'task' and entity_id = any($2::uuid[])", [w.id, taskIds]);
        await c.query("delete from undo_log where workspace_id = $1 and jsonb_typeof(changes) = 'array' and exists (select 1 from jsonb_array_elements(changes) e where e->>'table' in ('tasks','phases'))", [w.id]);
        await c.query('delete from tasks where workspace_id = $1', [w.id]);          // dependencies go with them; progress updates keep their text and photos
        await c.query('delete from phases where workspace_id = $1', [w.id]);
        await c.query('delete from plan_archives where workspace_id = $1', [w.id]);
        await c.query('delete from plans where workspace_id = $1', [w.id]);
        const tpl = await applyTemplate(c, w.id, null);
        await c.query("insert into plans (workspace_id, version, status, source, note) values ($1, 1, 'draft', 'generated', 'Construction master plan (the previous plan was deleted on the owner''s instruction). Review dates and weights, then approve a baseline.')", [w.id]);
        await c.query(`insert into audit_events (workspace_id, actor_label, action, entity, entity_id, summary) values ($1::uuid, 'System', 'master.converted', 'plan', $1::text, $2)`,
          [w.id, `Moved to the construction master plan v${tpl.version}; previous plan deleted (${phaseN} phases, ${taskIds.length} tasks)`]);
        await c.query('commit');
        done.push(`${w.ref} (${taskIds.length} old tasks deleted)`);
      } catch (e) { await c.query('rollback'); throw e; }
    }
    await c.query('insert into app_state (key, value) values ($1, $2) on conflict (key) do nothing', [JOB, `${new Date().toISOString()}: ${done.length} projects`]);
    await c.query("insert into app_state (key, value) values ('abuquwa_imported', 'superseded by the construction master plan') on conflict (key) do nothing");
    if (done.length) log(`Construction master plan: moved ${done.length} existing projects (${done.join(', ')})`);
    return done;
  } finally { await c.query('select pg_advisory_unlock(727021)').catch(() => {}); c.release(); }
}

module.exports = { template, applyTemplate, convertExisting, JOB };
