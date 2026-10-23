'use strict';
// Guided setup for SarayDar Real Estate Development projects, and the deterministic draft-plan template.
// Nothing here invents amounts, dates or legal requirements: generated items are labelled "suggested" and carry no dates or costs.
const { parseMoney } = require('./money');

const PHASE_STATUS = [['', 'Choose…'], ['not_started', 'Not started'], ['in_progress', 'In progress'], ['done', 'Done'], ['na', 'Not applicable'], ['unknown', 'Not yet determined']];

const TEMPLATE = [
  { key: 'feasibility', name: 'Feasibility & land', w: 3, tasks: ['Confirm land title, plot references and dimensions', 'Feasibility study and cost estimate', 'Agree funding arrangement', ['Investment decision', true]] },
  { key: 'design', name: 'Design', w: 7, tasks: ['Appoint design consultant', 'Concept design', 'Detailed design and drawings', 'Cost plan / bill of quantities', ['Design freeze', true]] },
  { key: 'approvals', name: 'Approvals & permits', w: 5, tasks: ['List the approvals required (confirm with the authorities)', 'Submit building permit application', 'Utility connection applications', ['Building permit received', true]] },
  { key: 'procurement', name: 'Procurement & contracts', w: 5, tasks: ['Prepare tender documents', 'Tender and evaluate bids', 'Award main contract', ['Contractor mobilised', true]] },
  { key: 'construction', name: 'Construction', w: 70, tasks: ['Site set-up and hoarding', 'Substructure', 'Superstructure', 'Mechanical, electrical and plumbing', 'Finishes', 'External works', ['Practical completion', true]] },
  { key: 'handover', name: 'Handover & close-out', w: 5, tasks: ['Snagging inspections', 'Completion approvals', 'Handover documents and keys', ['Handover complete', true]] },
  { key: 'defects', name: 'Defects liability', w: 2, tasks: ['Track defects during the liability period', 'Final account and retention release'] },
  { key: 'sales', name: 'Sales & marketing', w: 0, tasks: ['Pricing and sales plan', 'Marketing material', 'Sales agreements', 'Collections from buyers'], when: a => ['sell', 'mixed'].includes(val(a, 'outcome')) }
];
const SUBDIVISION_CONSTRUCTION = ['Infrastructure design', 'Roads and utilities works', 'Plot demarcation', ['Infrastructure complete', true]];

const val = (a, k) => a && a[k] && !a[k].unknown ? a[k].v : undefined;
const isUnknown = (a, k) => !!(a && a[k] && a[k].unknown);

const STEPS = [
  { key: 'identity', title: 'Project identity', fields: [
    { k: 'type', label: 'Project type', type: 'select', required: true, options: [['residential', 'Residential villas / townhouses'], ['apartments', 'Apartment building'], ['commercial', 'Commercial'], ['mixed_use', 'Mixed use'], ['subdivision', 'Land subdivision'], ['other', 'Other']] },
    { k: 'objective', label: 'Objective', type: 'textarea', hint: 'What the project should achieve.' },
    { k: 'outcome', label: 'Intended outcome', type: 'select', options: [['sell', 'Sell the units'], ['lease', 'Lease and hold'], ['mixed', 'Sell some, keep some'], ['hold', 'Own use / hold']] },
    { k: 'developer', label: 'Developer', type: 'text' },
    { k: 'owner', label: 'Land owner', type: 'text' }
  ] },
  { key: 'land', title: 'Land', fields: [
    { k: 'plots_count', label: 'Number of plots', type: 'number', hint: 'Record each plot (number, title deed, area, dimensions, documents) under Land & Plots.' },
    { k: 'plots', label: 'Plot references (summary)', type: 'textarea' },
    { k: 'tenure', label: 'Ownership / tenure', type: 'select', options: [['freehold', 'Freehold'], ['leasehold', 'Leasehold'], ['other', 'Other']] },
    { k: 'land_area', label: 'Total land area (m²)', type: 'number', hint: 'All plots together.' },
    { k: 'dimensions', label: 'Typical plot dimensions', type: 'text', hint: 'For example 10.3 × 17 m per plot.' },
    { k: 'access', label: 'Access and site information', type: 'textarea' }
  ] },
  { key: 'scope', title: 'Development scope', fields: [
    { k: 'buildings', label: 'Number of buildings', type: 'number' },
    { k: 'units', label: 'Number of units', type: 'number' },
    { k: 'use', label: 'Intended use', type: 'text' },
    { k: 'built_up', label: 'Total built-up area (m²)', type: 'number' },
    { k: 'inclusions', label: 'Included in scope', type: 'textarea' },
    { k: 'exclusions', label: 'Excluded from scope', type: 'textarea' }
  ] },
  { key: 'stage', title: 'Current stage', intro: 'Projects can join the system part-way through. Record what has already happened; it is marked as reported until someone checks it.', fields: [
    { k: 'stage', label: 'Current stage', type: 'select', required: true, options: [['feasibility', 'Feasibility'], ['design', 'Design'], ['approvals', 'Approvals'], ['procurement', 'Procurement'], ['construction', 'Construction'], ['handover', 'Handover'], ['operation', 'Operation / sales']] },
    ...TEMPLATE.map(p => ({ k: `ph_${p.key}`, label: `${p.name}: status`, type: 'select', options: PHASE_STATUS.slice(1), noUnknown: true })),
    { k: 'measurement', label: 'How is progress measured today?', type: 'textarea' },
    { k: 'completed', label: 'Work already completed (with evidence available)', type: 'textarea', hint: 'Upload supporting files in the Documents tab.' }
  ] },
  { key: 'budget', title: 'Budget & funding', intro: 'Only enter figures you have. Leave anything else as not yet determined.', fields: [
    { k: 'budget_status', label: 'Budget status', type: 'select', options: [['approved', 'Approved budget'], ['estimate', 'Estimate only']] },
    { k: 'total_budget', label: 'Total budget (BHD)', type: 'money' },
    { k: 'land_cost', label: 'Land cost (BHD)', type: 'money' },
    { k: 'contingency_pct', label: 'Contingency (%)', type: 'number' },
    { k: 'funding', label: 'Funding arrangement', type: 'select', options: [['saraydar', 'Fully funded by SarayDar'], ['investors', 'SarayDar with investors'], ['other', 'Other documented arrangement']] },
    { k: 'expected_income', label: 'Expected income (BHD)', type: 'money' },
    { k: 'income_basis', label: 'Basis for expected income', type: 'textarea' }
  ] },
  { key: 'timeline', title: 'Timeline', fields: [
    { k: 'start', label: 'Start date', type: 'date' },
    { k: 'target', label: 'Target completion', type: 'date' },
    { k: 'constraints', label: 'Known constraints, dependencies or delays', type: 'textarea' }
  ] },
  { key: 'team', title: 'Team', fields: [
    { k: 'consultant', label: 'Design consultant', type: 'text' },
    { k: 'contractor', label: 'Main contractor', type: 'text' },
    { k: 'pm', label: 'Project manager', type: 'text' },
    { k: 'others', label: 'Others (one per line: role – name)', type: 'textarea' }
  ] },
  { key: 'risks', title: 'Risks & approvals', fields: [
    { k: 'risks', label: 'Known risks (one per line)', type: 'textarea' },
    { k: 'approvals_obtained', label: 'Approvals already obtained (one per line)', type: 'textarea' },
    { k: 'approvals_pending', label: 'Approvals still needed (one per line)', type: 'textarea' }
  ] }
];
const IMPORTANT = ['outcome', 'start', 'target', 'total_budget', 'funding'];

function readStep(step, body) {
  const out = {};
  for (const f of step.fields) {
    const unknown = !f.noUnknown && body[`${f.k}__unknown`] === '1';
    let v = body[f.k];
    v = typeof v === 'string' ? v.trim().slice(0, f.type === 'textarea' ? 4000 : 300) : '';
    if (unknown) { out[f.k] = { unknown: true }; continue; }
    if (v === '') { out[f.k] = null; continue; }
    if (f.type === 'number') { const n = Number(v.replace(/,/g, '')); if (!isFinite(n) || n < 0) throw Object.assign(new Error(`${f.label} must be a positive number.`), { status: 400 }); out[f.k] = { v: n }; continue; }
    if (f.type === 'money') { out[f.k] = { v: parseMoney(v, 'BHD') }; continue; }
    if (f.type === 'date') { if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw Object.assign(new Error(`${f.label} must be a date.`), { status: 400 }); out[f.k] = { v }; continue; }
    if (f.type === 'select' && !f.options.some(o => o[0] === v)) throw Object.assign(new Error(`Choose a valid ${f.label.toLowerCase()}.`), { status: 400 });
    out[f.k] = { v };
  }
  return out;
}

function review(a) {
  const missing = [], unknown = [], conflicts = [];
  for (const s of STEPS) for (const f of s.fields) {
    if (isUnknown(a, f.k)) unknown.push(f.label);
    else if (val(a, f.k) === undefined && (f.required || IMPORTANT.includes(f.k))) missing.push({ label: f.label, required: !!f.required, step: s.key });
  }
  if (val(a, 'start') && val(a, 'target') && val(a, 'target') < val(a, 'start')) conflicts.push('Target completion is before the start date.');
  if (val(a, 'land_cost') !== undefined && val(a, 'total_budget') !== undefined && val(a, 'land_cost') > val(a, 'total_budget')) conflicts.push('Land cost is higher than the total budget.');
  if (val(a, 'contingency_pct') !== undefined && val(a, 'contingency_pct') > 25) conflicts.push('Contingency above 25% — check the figure.');
  if (val(a, 'land_area') && val(a, 'built_up') && val(a, 'buildings') === undefined && val(a, 'built_up') > val(a, 'land_area') * 6) conflicts.push('Built-up area looks very high for the land area.');
  const stageIdx = TEMPLATE.findIndex(p => p.key === val(a, 'stage'));
  if (stageIdx > 1) for (const p of TEMPLATE.slice(0, stageIdx)) if (val(a, `ph_${p.key}`) === 'not_started') conflicts.push(`${p.name} is marked not started, but the current stage is later.`);
  return { missing, unknown, conflicts, ready: !missing.some(m => m.required) };
}

const lines = s => String(s || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean).slice(0, 50);

// Draft plan generated from answers. Statuses for phases reported as done/in progress are kept but marked unverified.
function generate(a) {
  const type = val(a, 'type');
  const phases = [];
  for (const p of TEMPLATE) {
    if (p.when && !p.when(a)) continue;
    const st = val(a, `ph_${p.key}`);
    if (st === 'na') continue;
    const tasks = (type === 'subdivision' && p.key === 'construction' ? SUBDIVISION_CONSTRUCTION : p.tasks).map(t => {
      const [title, milestone] = Array.isArray(t) ? t : [t, false];
      const status = st === 'done' ? 'done' : 'not_started';
      return { title, is_milestone: !!milestone, status, progress: status === 'done' ? 100 : 0, verified: st !== 'done' };
    });
    phases.push({ name: type === 'subdivision' && p.key === 'construction' ? 'Infrastructure works' : p.name, suggested_weight: p.w, tasks, reported: st || null });
  }
  const risks = lines(val(a, 'risks')).map(t => ({ kind: 'risk', title: t, suggested: false }));
  const suggestedRisks = ['Construction cost overrun', 'Delay in approvals', 'Contractor performance', 'Funding gap during construction'];
  if (['sell', 'mixed'].includes(val(a, 'outcome'))) suggestedRisks.push('Sales slower than planned');
  for (const t of suggestedRisks) if (!risks.some(r => r.title.toLowerCase() === t.toLowerCase())) risks.push({ kind: 'risk', title: t, suggested: true });
  const permits = [
    ...lines(val(a, 'approvals_obtained')).map(t => ({ kind: 'permit', title: t, status: 'obtained' })),
    ...lines(val(a, 'approvals_pending')).map(t => ({ kind: 'permit', title: t, status: 'open' })),
    { kind: 'permit', title: 'Confirm the full list of required approvals with the relevant authorities', status: 'open', suggested: true }
  ];
  const stakeholders = [];
  for (const [k, role] of [['consultant', 'Design consultant'], ['contractor', 'Main contractor'], ['pm', 'Project manager']]) if (val(a, k)) stakeholders.push({ kind: 'stakeholder', title: val(a, k), extra: { role } });
  for (const l of lines(val(a, 'others'))) { const [role, ...rest] = l.split(/\s+[–-]\s+/); stakeholders.push({ kind: 'stakeholder', title: rest.join(' - ') || l, extra: { role: rest.length ? role : '' } }); }
  const budget = [
    ['Land', 'Land purchase', val(a, 'land_cost') ?? null], ['Professional fees', 'Design and supervision', null], ['Government & utilities', 'Permits and government fees', null],
    ['Construction', 'Construction', null], ['Government & utilities', 'Utility connections', null], ['Contingency', 'Contingency', null],
    ['Finance', 'Financing costs', null], ['Sales & marketing', 'Sales and marketing', null]
  ].filter(([c]) => c !== 'Sales & marketing' || ['sell', 'mixed'].includes(val(a, 'outcome'))).map(([category, description, amount], i) => ({ category, description, revised_minor: amount, sort: i }));
  return { phases, risks, permits, stakeholders, budget };
}

module.exports = { STEPS, TEMPLATE, PHASE_STATUS, readStep, review, generate, val, isUnknown };
