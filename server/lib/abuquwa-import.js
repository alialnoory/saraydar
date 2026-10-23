'use strict';
// One-time move of the original Abuquwa tracker records (table "records") into workspace DEV-2026-001.
// Runs at start-up; guarded by app_state so it never runs twice. Imported figures are marked unverified.
const STATUS = { 'Not started': 'not_started', 'In progress': 'in_progress', Done: 'done', Blocked: 'blocked' };
const minor = v => { const n = Number(v); return isFinite(n) && n > 0 ? Math.round(n * 1000) : null; };
const date = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : null;
const cap = v => ['Low', 'Medium', 'High'].includes(v) ? v : null;

async function importAbuquwa(pool) {
  const done = await pool.query("select 1 from app_state where key = 'abuquwa_imported'");
  if (done.rowCount) return 0;
  const ws = (await pool.query("select * from workspaces where ref = 'DEV-2026-001' and legacy")).rows[0];
  const recs = (await pool.query('select collection, id, data from records')).rows;
  if (!ws || !recs.length) return 0;
  const by = c => recs.filter(r => r.collection === c).map(r => ({ id: r.id, ...r.data }));
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query('select pg_advisory_xact_lock(727002)');
    if ((await c.query("select 1 from app_state where key = 'abuquwa_imported'")).rowCount) { await c.query('rollback'); return 0; }
    if ((await c.query('select 1 from tasks where workspace_id = $1 limit 1', [ws.id])).rowCount) {
      await c.query("insert into app_state (key, value) values ('abuquwa_imported', 'skipped: workspace already had tasks')");
      await c.query('commit'); return 0;
    }
    let n = 0;
    await c.query("insert into plans (workspace_id, version, status, source, note) values ($1, 1, 'draft', 'imported', 'Imported from the earlier Abuquwa tracker. Review the tasks, set phase weights and approve to save the first baseline.')", [ws.id]);
    const tasks = by('tasks').sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const phaseIds = new Map();
    for (const t of tasks) {
      const name = String(t.phase || 'General').replace(/^\d+\s*·\s*/, '');
      if (!phaseIds.has(name)) phaseIds.set(name, (await c.query('insert into phases (workspace_id, name, sort) values ($1,$2,$3) returning id', [ws.id, name, phaseIds.size])).rows[0].id);
      let start = date(t.start), due = date(t.due);
      if (start && due && due < start) due = null;
      const status = STATUS[t.status] || 'not_started';
      await c.query(`insert into tasks (workspace_id, phase_id, title, owner_text, start_date, due_date, status, progress, notes, verified, sort, is_milestone)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [ws.id, phaseIds.get(name), String(t.title || 'Task').slice(0, 300), t.owner || null, start, due, status, Math.max(0, Math.min(100, parseInt(t.progress, 10) || 0)), t.notes || null, status === 'not_started', n++, /milestone|handover complete|practical completion/i.test(String(t.title || ''))]);
    }
    const lineIds = new Map();
    for (const l of by('costs').sort((a, b) => (a.order || 0) - (b.order || 0))) {
      const id = (await c.query(`insert into budget_lines (workspace_id, category, description, revised_minor, source, verified, sort, notes)
        values ($1,$2,$3,$4,'imported',false,$5,$6) returning id`,
        [ws.id, l.category || 'General', String(l.item || 'Budget line').slice(0, 200), minor(l.budget), l.order || 0, minor(l.budget) === null ? 'Imported with no amount: not yet determined.' : (l.notes || null)])).rows[0].id;
      lineIds.set(l.id, id);
      if (minor(l.committed)) {
        const payee = (by('payments').find(p => p.costId === l.id) || {}).payee;
        await c.query("insert into commitments (workspace_id, budget_line_id, counterparty, description, value_minor, source) values ($1,$2,$3,'Imported from the earlier tracker',$4,'imported')", [ws.id, id, payee || 'Not yet recorded', minor(l.committed)]);
      }
    }
    for (const p of by('payments')) {
      if (!minor(p.amount)) continue;
      const line = lineIds.get(p.costId) || null;
      const commit = line ? (await c.query('select id from commitments where budget_line_id = $1 limit 1', [line])).rows[0] : null;
      await c.query(`insert into cost_payments (workspace_id, budget_line_id, commitment_id, payee, amount_minor, paid_on, reference, notes, status, source)
        values ($1,$2,$3,$4,$5,$6,$7,$8,'pending','imported')`, [ws.id, line, commit && commit.id, p.payee || 'Not yet recorded', minor(p.amount), date(p.date), p.reference || null, [p.notes, 'Imported: confirm against the bank record.'].filter(Boolean).join(' ')]);
    }
    for (const r of by('risks')) {
      const st = /closed/i.test(r.status || '') ? 'closed' : /open/i.test(r.status || '') ? 'open' : 'mitigating';
      await c.query("insert into register_items (workspace_id, kind, title, owner_text, likelihood, impact, status, description) values ($1,'risk',$2,$3,$4,$5,$6,$7)",
        [ws.id, String(r.risk || 'Risk').slice(0, 300), r.owner || null, cap(r.likelihood), cap(r.impact), st, r.mitigation ? `Mitigation: ${r.mitigation}` : null]);
    }
    for (const l of by('log')) {
      const d = date(l.date); if (!d) continue;
      await c.query(`insert into progress_updates (workspace_id, title, observed_on, completed_work, issues, workforce, status, author_label, published_at)
        values ($1,$2,$3,$4,$5,$6,'published',$7, now())`, [ws.id, `Site log ${d}`, d, l.work || null, l.issues || null, Number.isInteger(l.workforce) ? l.workforce : null, l.author || 'Imported']);
    }
    for (const [i, u] of by('units').entries()) {
      const st = { Available: 'available', Reserved: 'reserved', Sold: 'sold', 'Handed over': 'handed_over' }[u.status] || 'available';
      await c.query('insert into dev_units (workspace_id, name, status, list_price_minor, notes, sort) values ($1,$2,$3,$4,$5,$6)',
        [ws.id, String(u.unit || `Unit ${i + 1}`).slice(0, 80), st, minor(u.price), u.notes || null, i]);
    }
    const meta = by('meta')[0] || {};
    const answers = {};
    if (date(meta.start)) answers.start = { v: meta.start };
    if (date(meta.handover)) answers.target = { v: meta.handover };
    if (Object.keys(answers).length) await c.query('insert into setup_drafts (workspace_id, answers) values ($1,$2) on conflict (workspace_id) do nothing', [ws.id, answers]);
    await c.query("update workspaces set details = details || jsonb_build_object('imported_at', now()::text), updated_at = now() where id = $1", [ws.id]);
    await c.query("insert into audit_events (actor_label, workspace_id, action, entity, entity_id, summary) values ('system', $1::uuid, 'workspace.imported', 'workspace', $1::text, $2)",
      [ws.id, `Imported from the earlier tracker: ${tasks.length} tasks, ${lineIds.size} budget lines, ${by('risks').length} risks, ${by('units').length} units, ${by('log').length} log entries`]);
    await c.query("insert into app_state (key, value) values ('abuquwa_imported', now()::text)");
    await c.query('commit');
    return tasks.length;
  } catch (e) { await c.query('rollback').catch(() => {}); throw e; } finally { c.release(); }
}

module.exports = { importAbuquwa };
