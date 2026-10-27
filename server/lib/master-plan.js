'use strict';
// Construction master plan (owner request 2026-10-27): the shared baseline template for development and client
// projects, and the plain calculations behind it. Weights and durations are suggested defaults, not a standard,
// a contract payment schedule or a cost estimate. Nothing here touches the database.

const MILESTONES = new Set(['2.5', '3.6', '9.6']);      // permits obtained, contractor mobilised, handover signed
const T = (key, title, weight) => ({ key, title, weight, ...(MILESTONES.has(key) ? { milestone: true } : {}) });
// Stage weights are % of the whole project; task weights are % within their stage. Weeks are indicative elapsed
// calendar weeks for a conventional 2–3-storey villa (baseline Gantt example), counted from the project start.
const BASELINE = [
  { key: 'S1', name: 'Project setup', weight: 4, duration: '1–2 weeks', startWeek: 0, endWeek: 2, tasks: [
    T('1.1', 'Define project scope, requirements and intended outcome', 20), T('1.2', 'Set initial budget, funding and target completion date', 20),
    T('1.3', 'Appoint project manager and agree responsibilities', 20), T('1.4', 'Review site, ownership documents and constraints', 20),
    T('1.5', 'Set reporting, communication and decision process', 20)] },
  { key: 'S2', name: 'Design and approvals', weight: 6, duration: '4–8 weeks', startWeek: 1, endWeek: 9, tasks: [
    T('2.1', 'Prepare concept design and confirm client requirements', 20), T('2.2', 'Approve architectural design and outline specifications', 20),
    T('2.3', 'Coordinate structural, electrical and mechanical drawings', 20), T('2.4', 'Prepare final drawings, budget and tender documents', 15),
    T('2.5', 'Submit for permits and obtain required approvals', 25)] },
  { key: 'S3', name: 'Contracting and purchasing', weight: 5, duration: '3–6 weeks', startWeek: 6, endWeek: 12, tasks: [
    T('3.1', 'Request and compare contractor quotations', 15), T('3.2', 'Appoint contractor and agree contract, programme and payment terms', 20),
    T('3.3', 'Prepare procurement and long-lead item schedule', 15), T('3.4', 'Select and approve materials, samples and suppliers', 20),
    T('3.5', 'Place orders and monitor confirmed delivery dates', 20), T('3.6', 'Complete site handover and contractor mobilisation', 10)] },
  { key: 'S4', name: 'Groundworks and foundations', weight: 15, duration: '6–10 weeks', startWeek: 10, endWeek: 20, tasks: [
    T('4.1', 'Survey, set out and prepare the site', 10), T('4.2', 'Excavate and inspect formation and soil conditions', 15),
    T('4.3', 'Install foundation reinforcement and formwork', 20), T('4.4', 'Pour and inspect foundation concrete', 20),
    T('4.5', 'Complete underground drainage and service sleeves', 15), T('4.6', 'Complete below-ground waterproofing, backfill and compaction', 20)] },
  { key: 'S5', name: 'Structural frame', weight: 25, duration: '12–18 weeks', startWeek: 20, endWeek: 38, tasks: [
    T('5.1', 'Construct ground-floor columns, beams and slab', 25), T('5.2', 'Construct upper-floor columns, beams and slabs', 35),
    T('5.3', 'Construct staircase and roof structure', 20), T('5.4', 'Inspect concrete and rectify structural observations', 10),
    T('5.5', 'Approve completed structure for follow-on works', 10)] },
  { key: 'S6', name: 'Blockwork and first fix', weight: 15, duration: '6–10 weeks', startWeek: 32, endWeek: 42, tasks: [
    T('6.1', 'Complete external and internal blockwork', 30), T('6.2', 'Install electrical conduits, boxes and distribution routes', 20),
    T('6.3', 'Install water supply and drainage pipework', 20), T('6.4', 'Install AC ducts, piping and other required services', 15),
    T('6.5', 'Inspect and test concealed services before covering', 15)] },
  { key: 'S7', name: 'Finishes and installation', weight: 20, duration: '12–18 weeks', startWeek: 37, endWeek: 55, tasks: [
    T('7.1', 'Complete plaster and surface preparation', 10), T('7.2', 'Apply and test wet-area and roof waterproofing', 10),
    T('7.3', 'Install floor tiles and wall finishes', 15), T('7.4', 'Install windows, glazing and external doors', 10),
    T('7.5', 'Complete ceiling works and paint preparation', 10), T('7.6', 'Install internal doors, cabinetry and joinery', 10),
    T('7.7', 'Complete painting and decorative finishes', 10), T('7.8', 'Install sanitary ware and electrical fixtures', 10),
    T('7.9', 'Install AC equipment and other final fittings', 10), T('7.10', 'Carry out finishing inspections and corrections', 5)] },
  { key: 'S8', name: 'External works and utilities', weight: 5, duration: '3–6 weeks', startWeek: 50, endWeek: 56, tasks: [
    T('8.1', 'Complete boundary walls, gates and external finishes', 25), T('8.2', 'Complete external drainage and utility connections', 30),
    T('8.3', 'Complete paving, parking and access', 25), T('8.4', 'Complete landscaping and external cleaning if required', 20)] },
  { key: 'S9', name: 'Testing and handover', weight: 4, duration: '2–4 weeks', startWeek: 55, endWeek: 59, tasks: [
    T('9.1', 'Test and commission electrical, plumbing and AC systems', 20), T('9.2', 'Complete required inspections and completion approvals', 20),
    T('9.3', 'Inspect property and issue snag list', 20), T('9.4', 'Rectify snags and re-inspect', 20),
    T('9.5', 'Deliver manuals, warranties, keys and handover documents', 10), T('9.6', 'Sign handover and acceptance record', 10)] },
  { key: 'S10', name: 'Defects and closeout', weight: 1, duration: 'Contractual defects period (e.g. 12 months)', afterHandover: true, tasks: [
    T('10.1', 'Record defects reported during the agreed liability period', 25), T('10.2', 'Coordinate repairs and verify completion', 45),
    T('10.3', 'Complete final inspection and acceptance', 20), T('10.4', 'Close accounts and archive project records', 10)] }
];
const TEMPLATE_KEY = 'construction';
const DEFAULT_DEFECTS_MONTHS = 12;

const EPS = 0.01;                  // weights are stored with 3 decimals; a sum within 0.01 of 100 is accepted
const r3 = x => Math.round(x * 1000) / 1000;
const sum = a => a.reduce((s, x) => s + x, 0);
const isNum = v => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));

// ---------- template checks (Super Admin edits) ----------
function validateTemplate(stages) {
  const errs = [];
  if (!Array.isArray(stages) || !stages.length) return ['The template needs at least one stage.'];
  const sw = sum(stages.map(s => Number(s.weight)));
  if (stages.some(s => !isNum(s.weight) || Number(s.weight) < 0)) errs.push('Every stage needs a weight of zero or more.');
  else if (Math.abs(sw - 100) > EPS) errs.push(`Stage weights add up to ${r3(sw)}%, not 100%.`);
  for (const s of stages) {
    if (!String(s.name || '').trim()) errs.push('Every stage needs a name.');
    if (!s.tasks.length) continue;
    if (s.tasks.some(t => !isNum(t.weight) || Number(t.weight) < 0 || !String(t.title || '').trim())) { errs.push(`${s.name}: every task needs a title and a weight of zero or more.`); continue; }
    const tw = sum(s.tasks.map(t => Number(t.weight)));
    if (Math.abs(tw - 100) > EPS) errs.push(`${s.name}: task weights add up to ${r3(tw)}%, not 100%.`);
  }
  return errs;
}

// ---------- status and progress ----------
const TASK_LABEL = { not_started: 'Not started', in_progress: 'In progress', on_hold: 'On hold', blocked: 'On hold', done: 'Completed', cancelled: 'Cancelled' };
const STAGE_LABEL = { not_started: 'Not started', in_progress: 'In progress', on_hold: 'On hold', done: 'Completed' };
const taskPct = t => t.status === 'done' ? 100 : Math.max(0, Math.min(100, Number(t.progress) || 0));

// Keep status and % consistent: Completed ⇔ 100%; any progress moves Not started to In progress.
function reconcile(status, progress) {
  let s = status, p = progress === null || progress === undefined || progress === '' ? null : Math.round(Number(progress));
  if (p !== null && (!Number.isFinite(p) || p < 0 || p > 100)) throw Object.assign(new Error('Progress must be a whole number from 0 to 100.'), { status: 400 });
  if (s === 'done') p = 100;
  else if (p === 100 && (s === undefined || s === 'not_started' || s === 'in_progress')) s = 'done';
  else if (p !== null && p > 0 && (s === undefined || s === 'not_started')) s = 'in_progress';
  else if (s === 'not_started' && p === null) p = 0;
  return { status: s, progress: p };
}

function stageStatus(phase, tasks) {
  if (phase.hold) return 'on_hold';
  const live = tasks.filter(t => t.status !== 'cancelled');
  if (!live.length) { const p = Number(phase.progress) || 0; return p >= 100 ? 'done' : p > 0 ? 'in_progress' : 'not_started'; }
  if (live.every(t => t.status === 'done')) return 'done';
  if (live.some(t => t.status === 'in_progress' || t.status === 'done' || taskPct(t) > 0)) return 'in_progress';
  if (live.length && live.every(t => t.status === 'on_hold' || t.status === 'blocked')) return 'on_hold';
  return 'not_started';
}

// Phase progress = Σ(task weight × task completion) / 100; project = Σ(stage weight × stage progress) / 100.
// Returns valid:false with plain reasons instead of a misleading percentage when the weights are not set up.
function compute(phases, tasks) {
  const live = phases.filter(p => !p.archived_at);
  const issues = [];
  const stages = live.map(p => {
    const ts = tasks.filter(t => t.phase_id === p.id && !t.archived_at && t.status !== 'cancelled');
    const status = stageStatus(p, ts);
    let pct = null, ok = true;
    if (!ts.length) pct = Math.max(0, Math.min(100, Number(p.progress) || 0));
    else if (ts.some(t => !isNum(t.weight))) { ok = false; issues.push(`${p.name}: some tasks have no weight.`); }
    else {
      const tw = sum(ts.map(t => Number(t.weight)));
      if (Math.abs(tw - 100) > EPS) { ok = false; issues.push(`${p.name}: task weights add up to ${r3(tw)}%, not 100%.`); }
      else pct = sum(ts.map(t => Number(t.weight) * taskPct(t))) / 100;
    }
    return { id: p.id, name: p.name, key: p.template_key, weight: isNum(p.weight) ? Number(p.weight) : null, tasks: ts.length, pct: ok ? pct : null, status, afterHandover: !!p.after_handover };
  });
  if (!live.length) issues.push('The plan has no stages.');
  if (stages.some(s => s.weight === null)) issues.push('Some stages have no weight.');
  else if (live.length) { const sw = sum(stages.map(s => s.weight)); if (Math.abs(sw - 100) > EPS) issues.push(`Stage weights add up to ${r3(sw)}%, not 100%.`); }
  const valid = !issues.length;
  const pct = valid ? sum(stages.map(s => s.weight * s.pct)) / 100 : null;
  // construction progress up to handover: the same calculation without the after-handover stage(s), rescaled
  const pre = stages.filter(s => !s.afterHandover), preW = sum(pre.map(s => s.weight || 0));
  const preHandover = valid && preW > 0 && pre.length < stages.length ? sum(pre.map(s => s.weight * s.pct)) / preW : null;
  return { valid, issues, stages, pct, preHandover };
}

// ---------- weights ----------
// Scale a list of weights to a total, keeping their proportions; equal shares when they are all zero. Rounded to
// 3 decimals with the remainder put on the largest item, so the result adds up exactly.
function scaleTo(weights, total = 100) {
  if (!weights.length) return [];
  const ws = weights.map(w => Math.max(0, Number(w) || 0));
  const s = sum(ws);
  let out = s > 0 ? ws.map(w => r3(w * total / s)) : ws.map(() => r3(total / ws.length));
  const diff = r3(total - sum(out));
  if (diff) { let i = 0; out.forEach((w, j) => { if (w > out[i]) i = j; }); out[i] = r3(out[i] + diff); }
  return out;
}
// Add an item with weight w: the others share 100 − w in their current proportions.
function withNew(weights, w) {
  w = Number(w);
  if (!Number.isFinite(w) || w < 0 || w > 100) throw Object.assign(new Error('The new weight must be between 0 and 100.'), { status: 400 });
  if (!weights.length) return { others: [], added: 100 };
  return { others: scaleTo(weights, 100 - w), added: r3(w) };
}

// ---------- old plan → master plan mapping ----------
const STOP = new Set(['and', 'the', 'of', 'for', 'to', 'a', 'an', 'in', 'on', 'with', 'or', 'if', 'required', 'complete', 'completed', 'all', 'any']);
const words = s => new Set(String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !STOP.has(w)).map(w => w.replace(/(ing|ion|s)$/, '')));
function similarity(a, b) {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return 0;
  let n = 0; for (const w of A) if (B.has(w)) n++;
  return n / (A.size + B.size - n);
}
// Only confident matches: the same wording, or a strong overlap that is the best for both sides.
function matchTasks(oldTasks, newTasks, threshold = 0.6) {
  const pairs = [];
  for (const o of oldTasks) for (const n of newTasks) {
    const s = String(o.title).trim().toLowerCase() === String(n.title).trim().toLowerCase() ? 1 : similarity(o.title, n.title);
    if (s >= threshold) pairs.push({ old: o.id, new: n.key, score: s });
  }
  pairs.sort((x, y) => y.score - x.score);
  const usedO = new Set(), usedN = new Set(), out = {};
  for (const p of pairs) { if (usedO.has(p.old) || usedN.has(p.new)) continue; usedO.add(p.old); usedN.add(p.new); out[p.old] = { key: p.new, score: Math.round(p.score * 100) }; }
  return out;
}

// ---------- illustrative schedule ----------
const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const addMonths = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); };
// Planned dates from a start date and each stage's indicative weeks; tasks share their stage's window in order.
// Returns proposals only for empty dates; nothing is a calculated critical path.
function illustrative(anchor, phases, tasks, defectsMonths = DEFAULT_DEFECTS_MONTHS) {
  const out = { phases: {}, tasks: {} };
  const live = phases.filter(p => !p.archived_at);
  let handoverEnd = null;
  for (const p of live) {
    if (p.after_handover || !isNum(p.start_week) || !isNum(p.end_week)) continue;
    const s = addDays(anchor, Math.round(Number(p.start_week) * 7)), e = addDays(anchor, Math.max(Math.round(Number(p.end_week) * 7) - 1, Math.round(Number(p.start_week) * 7)));
    out.phases[p.id] = { start: s, end: e };
    if (!handoverEnd || e > handoverEnd) handoverEnd = e;
  }
  for (const p of live.filter(x => x.after_handover)) {
    const s = addDays(handoverEnd || anchor, 1);
    out.phases[p.id] = { start: s, end: addDays(addMonths(s, Math.max(1, Number(defectsMonths) || DEFAULT_DEFECTS_MONTHS)), -1) };
  }
  for (const p of live) {
    const win = out.phases[p.id]; if (!win) continue;
    const ts = tasks.filter(t => t.phase_id === p.id && !t.archived_at).sort((a, b) => a.sort - b.sort);
    if (!ts.length) continue;
    const days = Math.round((Date.parse(win.end) - Date.parse(win.start)) / 86400000) + 1;
    const slice = days / ts.length;
    ts.forEach((t, i) => { out.tasks[t.id] = { start: addDays(win.start, Math.floor(i * slice)), end: addDays(win.start, Math.max(Math.floor(i * slice), Math.floor((i + 1) * slice) - 1)) }; });
  }
  return out;
}

// ---------- procurement ----------
// Latest order date = needed on site − supplier lead time − buffer; latest approval = latest order − approval time.
function procurementDates(x, today) {
  if (!x.needed_on || !isNum(x.lead_days)) return { order: null, approval: null, late: null };
  const needed = typeof x.needed_on === 'string' ? x.needed_on.slice(0, 10) : x.needed_on.toISOString().slice(0, 10);
  const order = addDays(needed, -(Number(x.lead_days) + (Number(x.buffer_days) || 0)));
  const approval = isNum(x.approval_days) ? addDays(order, -Number(x.approval_days)) : null;
  const done = ['ordered', 'delivered', 'cancelled'].includes(x.status);
  const late = done ? null : x.status === 'approved' ? (order < today ? 'order' : null) : approval && approval < today ? 'approval' : order < today ? 'order' : null;
  return { order, approval, late };
}

module.exports = { BASELINE, TEMPLATE_KEY, DEFAULT_DEFECTS_MONTHS, validateTemplate, compute, stageStatus, reconcile, taskPct, scaleTo, withNew, matchTasks, similarity,
  illustrative, procurementDates, addDays, TASK_LABEL, STAGE_LABEL, r3 };
