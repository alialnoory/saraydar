'use strict';
// Guided onboarding for Clients Projects Management. Same answer format and draft-plan shape as the
// development setup (lib/setup-dev.js), so the shared plan, task and register screens work unchanged.
// The management agreement (fee, billing, tax, approvers) is recorded as structured, versioned terms
// under "Client & Agreement", not as free answers here.
const dev = require('./setup-dev');
const { parseMoney } = require('./money');

const PHASE_STATUS = dev.PHASE_STATUS;
const TEMPLATE = [
  { key: 'onboarding', name: 'Onboarding & handover of information', w: 2, tasks: ['Collect existing drawings, approvals and contracts from the client', 'Confirm the client approvers and reporting arrangement', 'Kick-off meeting with the client', ['Management agreement in force', true]] },
  { key: 'design', name: 'Design & coordination', w: 8, tasks: ['Review the design status and gaps', 'Coordinate the design consultant', 'Client approval of the design', ['Design approved by client', true]] },
  { key: 'approvals', name: 'Approvals & permits', w: 5, tasks: ['List the approvals required (confirm with the authorities)', 'Track the building permit application', 'Utility connection applications', ['Building permit received', true]] },
  { key: 'procurement', name: 'Procurement & appointments', w: 5, tasks: ['Tender packages and contractor shortlist', 'Bid evaluation and recommendation to client', 'Client approval of appointment', ['Contractor appointed by client', true]] },
  { key: 'construction', name: 'Construction supervision', w: 70, tasks: ['Site set-up and mobilisation', 'Substructure', 'Superstructure', 'Mechanical, electrical and plumbing', 'Finishes', 'External works', 'Monthly progress reports to the client', ['Practical completion', true]] },
  { key: 'handover', name: 'Handover & close-out', w: 8, tasks: ['Snagging inspections', 'Completion approvals', 'As-built drawings, warranties and manuals', ['Handover to client', true]] },
  { key: 'defects', name: 'Defects liability', w: 2, tasks: ['Track defects during the liability period', 'Final account and retention release recommendation'] }
];

const STEPS = [
  { key: 'identity', title: 'Project & objectives', fields: [
    { k: 'type', label: 'Project type', type: 'select', required: true, options: [['villa', 'Villa / house'], ['residential', 'Residential building'], ['commercial', 'Commercial'], ['mixed_use', 'Mixed use'], ['renovation', 'Renovation / fit-out'], ['other', 'Other']] },
    { k: 'objective', label: 'Client objectives', type: 'textarea', hint: 'What the client wants to achieve.' },
    { k: 'scope', label: 'Project scope', type: 'textarea' },
    { k: 'units', label: 'Number of buildings / units', type: 'number' },
    { k: 'built_up', label: 'Total built-up area (m²)', type: 'number' }
  ] },
  { key: 'site', title: 'Site, designs & approvals', fields: [
    { k: 'plots_count', label: 'Number of plots', type: 'number', hint: 'Record each plot under Land & Plots.' },
    { k: 'site_condition', label: 'Current site condition', type: 'textarea' },
    { k: 'design_status', label: 'Existing designs', type: 'select', options: [['none', 'No design yet'], ['concept', 'Concept design'], ['detailed', 'Detailed design'], ['ifc', 'Issued for construction']] },
    { k: 'approvals_obtained', label: 'Approvals already obtained (one per line)', type: 'textarea' },
    { k: 'approvals_pending', label: 'Approvals still needed (one per line)', type: 'textarea' }
  ] },
  { key: 'stage', title: 'Current stage', intro: 'Client projects often join part-way through. Record what has already happened; it stays marked as reported until someone checks it.', fields: [
    { k: 'stage', label: 'Current stage', type: 'select', required: true, options: [['onboarding', 'Onboarding'], ['design', 'Design'], ['approvals', 'Approvals'], ['procurement', 'Procurement'], ['construction', 'Construction'], ['handover', 'Handover'], ['defects', 'Defects liability']] },
    ...TEMPLATE.map(p => ({ k: `ph_${p.key}`, label: `${p.name}: status`, type: 'select', options: PHASE_STATUS.slice(1), noUnknown: true })),
    { k: 'completed', label: 'Work already completed (with evidence available)', type: 'textarea', hint: 'Upload supporting files in the Documents tab.' },
    { k: 'remaining', label: 'Remaining scope', type: 'textarea' }
  ] },
  { key: 'budget', title: 'Client budget', intro: 'The client funds the construction. These figures are the client\'s budget, never SarayDar revenue or cost.', fields: [
    { k: 'budget_status', label: 'Budget status', type: 'select', options: [['approved', 'Approved by the client'], ['estimate', 'Estimate only']] },
    { k: 'total_budget', label: 'Client construction budget (BHD)', type: 'money' },
    { k: 'spent_to_date', label: 'Already spent by the client before onboarding (BHD)', type: 'money' },
    { k: 'contingency_pct', label: 'Contingency (%)', type: 'number' },
    { k: 'payment_route', label: 'Who pays contractors?', type: 'select', options: [['client_direct', 'The client pays directly'], ['mixed', 'Mostly the client; some payments by SarayDar on the client\'s behalf under separate approval']] }
  ] },
  { key: 'timeline', title: 'Timeline', fields: [
    { k: 'start', label: 'Start date', type: 'date' },
    { k: 'target', label: 'Target completion', type: 'date' },
    { k: 'constraints', label: 'Known constraints, dependencies or delays', type: 'textarea' }
  ] },
  { key: 'team', title: 'Contractors, consultants & team', fields: [
    { k: 'client_rep', label: 'Client representative', type: 'text' },
    { k: 'consultant', label: 'Design consultant', type: 'text' },
    { k: 'contractor', label: 'Main contractor', type: 'text' },
    { k: 'pm', label: 'SarayDar project manager', type: 'text' },
    { k: 'others', label: 'Others: suppliers, subcontractors, team (one per line: role – name)', type: 'textarea' }
  ] },
  { key: 'risks', title: 'Risks', fields: [
    { k: 'risks', label: 'Known risks (one per line)', type: 'textarea' }
  ] }
];
const IMPORTANT = ['start', 'target', 'total_budget', 'payment_route'];
const { val, isUnknown } = dev;

function review(a, extra = {}) {
  const missing = [], unknown = [], conflicts = [];
  for (const s of STEPS) for (const f of s.fields) {
    if (isUnknown(a, f.k)) unknown.push(f.label);
    else if (val(a, f.k) === undefined && (f.required || IMPORTANT.includes(f.k))) missing.push({ label: f.label, required: !!f.required, step: s.key });
  }
  if (extra.noTerms) missing.push({ label: 'Management agreement terms (fee, billing, tax)', required: false, href: 'client' });
  if (val(a, 'start') && val(a, 'target') && val(a, 'target') < val(a, 'start')) conflicts.push('Target completion is before the start date.');
  if (val(a, 'spent_to_date') !== undefined && val(a, 'total_budget') !== undefined && val(a, 'spent_to_date') > val(a, 'total_budget')) conflicts.push('Spent to date is higher than the client budget.');
  if (val(a, 'contingency_pct') !== undefined && val(a, 'contingency_pct') > 25) conflicts.push('Contingency above 25% — check the figure.');
  const stageIdx = TEMPLATE.findIndex(p => p.key === val(a, 'stage'));
  if (stageIdx > 1) for (const p of TEMPLATE.slice(0, stageIdx)) if (val(a, `ph_${p.key}`) === 'not_started') conflicts.push(`${p.name} is marked not started, but the current stage is later.`);
  return { missing, unknown, conflicts, ready: !missing.some(m => m.required) };
}

const lines = s => String(s || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean).slice(0, 50);

function generate(a) {
  const phases = [];
  for (const p of TEMPLATE) {
    const st = val(a, `ph_${p.key}`);
    if (st === 'na') continue;
    const tasks = p.tasks.map(t => {
      const [title, milestone] = Array.isArray(t) ? t : [t, false];
      const status = st === 'done' ? 'done' : 'not_started';
      return { title, is_milestone: !!milestone, status, progress: status === 'done' ? 100 : 0, verified: st !== 'done' };
    });
    phases.push({ name: p.name, suggested_weight: p.w, tasks, reported: st || null });
  }
  const risks = lines(val(a, 'risks')).map(t => ({ kind: 'risk', title: t, suggested: false }));
  for (const t of ['Client decisions or approvals delayed', 'Construction cost above the client budget', 'Contractor performance', 'Late client payments to contractors'])
    if (!risks.some(r => r.title.toLowerCase() === t.toLowerCase())) risks.push({ kind: 'risk', title: t, suggested: true });
  const permits = [
    ...lines(val(a, 'approvals_obtained')).map(t => ({ kind: 'permit', title: t, status: 'obtained' })),
    ...lines(val(a, 'approvals_pending')).map(t => ({ kind: 'permit', title: t, status: 'open' })),
    { kind: 'permit', title: 'Confirm the full list of required approvals with the relevant authorities', status: 'open', suggested: true }
  ];
  const stakeholders = [];
  for (const [k, role] of [['client_rep', 'Client representative'], ['consultant', 'Design consultant'], ['contractor', 'Main contractor'], ['pm', 'SarayDar project manager']]) if (val(a, k)) stakeholders.push({ kind: 'stakeholder', title: val(a, k), extra: { role } });
  for (const l of lines(val(a, 'others'))) { const [role, ...rest] = l.split(/\s+[–-]\s+/); stakeholders.push({ kind: 'stakeholder', title: rest.join(' - ') || l, extra: { role: rest.length ? role : '' } }); }
  const total = val(a, 'total_budget');
  const budget = [['Design & consultants', 'Design and supervision consultants'], ['Government & utilities', 'Permits and government fees'], ['Construction', 'Main contract'],
    ['Construction', 'Approved variations'], ['Government & utilities', 'Utility connections'], ['Contingency', 'Contingency']]
    .map(([category, description], i) => ({ category, description, revised_minor: null, sort: i }));
  // the client's approved total is kept as one unallocated line until it is split; nothing is invented
  if (total !== undefined) budget.push({ category: 'Unallocated', description: 'Client budget not yet split across lines', revised_minor: total, sort: budget.length });
  return { phases, risks, permits, stakeholders, budget };
}

function readStep(step, body) { return dev.readStep(step, body); }

module.exports = { STEPS, TEMPLATE, PHASE_STATUS, readStep, review, generate, val, isUnknown, parseMoney };
