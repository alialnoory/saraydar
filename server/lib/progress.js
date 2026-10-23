'use strict';
// Overall progress = weighted completion.
//   Task level: leaf tasks only (a parent's own % is ignored when it has children → no double counting).
//   Phase %  = Σ(task weight × task %) / Σ task weights over the phase's leaf tasks (cancelled tasks excluded).
//              A task with no weight counts as weight 1 inside its phase.
//   Overall % = Σ(phase weight × phase %) / Σ phase weights, phases with weight > 0 and at least one leaf task.
// Available only when a plan baseline is approved and every phase that has tasks has a weight.
// Planned % on a date uses the approved baseline: each leaf task contributes linearly between its baseline start and due dates.

function leafTasks(tasks) {
  const parents = new Set(tasks.filter(t => t.parent_id).map(t => t.parent_id));
  return tasks.filter(t => !parents.has(t.id) && t.status !== 'cancelled' && !t.archived_at);
}

function phaseProgress(leaves) {
  let w = 0, s = 0;
  for (const t of leaves) { const tw = t.weight === null || t.weight === undefined ? 1 : Number(t.weight); w += tw; s += tw * (t.status === 'done' ? 100 : Number(t.progress) || 0); }
  return w > 0 ? s / w : null;
}

function overall({ phases, tasks, approved }) {
  const leaves = leafTasks(tasks);
  const byPhase = phases.filter(p => !p.archived_at).map(p => ({ phase: p, leaves: leaves.filter(t => t.phase_id === p.id) }));
  const used = byPhase.filter(x => x.leaves.length);
  const missingWeights = used.filter(x => x.phase.weight === null || x.phase.weight === undefined).map(x => x.phase.name);
  const unphased = leaves.filter(t => !t.phase_id).length;
  const rows = byPhase.map(x => ({ id: x.phase.id, name: x.phase.name, weight: x.phase.weight === null ? null : Number(x.phase.weight), tasks: x.leaves.length, pct: phaseProgress(x.leaves) }));
  if (!approved) return { available: false, reason: 'No approved plan baseline yet.', phases: rows };
  if (!used.length) return { available: false, reason: 'No tasks yet.', phases: rows };
  if (missingWeights.length) return { available: false, reason: `Weights missing for: ${missingWeights.join(', ')}.`, phases: rows };
  let w = 0, s = 0;
  for (const x of used) { const pw = Number(x.phase.weight); if (pw > 0) { w += pw; s += pw * phaseProgress(x.leaves); } }
  if (w <= 0) return { available: false, reason: 'All phase weights are zero.', phases: rows };
  return { available: true, pct: s / w, phases: rows, unphased };
}

function plannedAt(baseline, onDate) {
  if (!baseline || !baseline.tasks || !baseline.phases) return { available: false, reason: 'No approved baseline.' };
  const day = d => Date.parse(d + 'T00:00:00Z');
  const t0 = day(onDate);
  const leaves = leafTasks(baseline.tasks);
  let w = 0, s = 0, missing = 0;
  for (const p of baseline.phases) {
    const pl = leaves.filter(t => t.phase_id === p.id);
    if (!pl.length || !(Number(p.weight) > 0)) continue;
    let tw = 0, ts = 0;
    for (const t of pl) {
      const tWeight = t.weight === null || t.weight === undefined ? 1 : Number(t.weight);
      if (!t.start_date || !t.due_date) { missing++; continue; }
      const a = day(t.start_date), b = day(t.due_date) + 86400000;
      const f = t0 <= a ? 0 : t0 >= b ? 1 : (t0 - a) / (b - a);
      tw += tWeight; ts += tWeight * f * 100;
    }
    if (tw > 0) { w += Number(p.weight); s += Number(p.weight) * (ts / tw); }
  }
  if (missing) return { available: false, reason: `${missing} baseline task${missing === 1 ? '' : 's'} without start and due dates.` };
  if (w <= 0) return { available: false, reason: 'Baseline has no weighted phases.' };
  return { available: true, pct: s / w };
}

// Cycle check for "task depends on X": would adding edge task→dep create a loop?
function createsCycle(edges, taskId, depId) {
  if (taskId === depId) return true;
  const next = new Map();
  for (const e of edges) { if (!next.has(e.task_id)) next.set(e.task_id, []); next.get(e.task_id).push(e.depends_on); }
  const seen = new Set(); const stack = [depId];
  while (stack.length) {
    const n = stack.pop();
    if (n === taskId) return true;
    if (seen.has(n)) continue; seen.add(n);
    for (const m of next.get(n) || []) stack.push(m);
  }
  return false;
}

module.exports = { overall, plannedAt, leafTasks, phaseProgress, createsCycle };
