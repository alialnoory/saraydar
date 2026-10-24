'use strict';
// Standard choices offered as dropdowns, tick-boxes and typing suggestions, so people pick instead of typing
// the same things again (owner request 2026-10-24: "checks, drop down menus, avoid repetitive entries").
// Suggestions never restrict input: anything not in a list can still be typed.

const BH_AREAS = ['Abu Saiba', 'Abuquwa', 'Adliya', 'Al Hidd', 'Al Malikiya', 'Amwaj Islands', 'Arad', "A'ali", 'Awali', 'Barbar', 'Budaiya', 'Busaiteen',
  'Dilmunia', 'Diplomatic Area', 'Diyar Al Muharraq', 'Durrat Al Bahrain', 'Galali', 'Gudaibiya', 'Hamad Town', 'Hoora', 'Isa Town', 'Janabiya', 'Jasra',
  'Jidhafs', 'Juffair', 'Jurdab', 'Karbabad', 'Karzakan', 'Manama', 'Muharraq', 'Nuwaidrat', 'Riffa', 'East Riffa', 'West Riffa', 'Saar', 'Salmabad',
  'Salmaniya', 'Sanabis', 'Sanad', 'Seef', 'Sehla', 'Sitra', 'Tubli', 'Um Al Hassam', 'Zallaq', 'Zinj'];

const STAGES = {
  client_project: ['Onboarding', 'Design', 'Approvals', 'Procurement', 'Construction', 'Handover', 'Defects liability'],
  project: ['Feasibility', 'Design', 'Approvals', 'Procurement', 'Construction', 'Handover', 'Operation / sales']
};

const BUDGET_CATEGORIES = ['Land', 'Design & consultants', 'Government & utilities', 'Construction', 'Furniture & equipment', 'Sales & marketing',
  'Financing', 'Legal & registration', 'Contingency', 'Unallocated', 'Other'];

const PAY_METHODS = ['Bank transfer', 'Cheque', 'Cash', 'Card', 'BenefitPay', 'Other'];

const BH_APPROVALS = ['Zoning / planning certificate', 'Survey and land registration (SLRB)', 'Building permit', 'Demolition permit', 'Fence / boundary wall permit',
  'Civil Defence approval', 'Electricity connection (EWA)', 'Water connection (EWA)', 'Sewerage connection', 'Road opening permit', 'Completion certificate'];

const COMMON_RISKS = {
  client_project: ['Client decisions or approvals delayed', 'Construction cost above the client budget', 'Contractor performance', 'Late client payments to contractors',
    'Permit or authority delays', 'Design changes after approval', 'Material price increases', 'Utility connection delays'],
  project: ['Construction cost overrun', 'Permit or authority delays', 'Contractor performance', 'Material price increases', 'Funding delays',
    'Slower sales than planned', 'Design changes after approval', 'Utility connection delays']
};

const MGMT_SCOPE = ['Project management and coordination', 'Design management and review', 'Approvals and permits follow-up', 'Tendering and contractor selection',
  'Construction supervision', 'Cost control and payment certification', 'Monthly progress reports', 'Handover, snagging and close-out'];
const MGMT_EXCLUSIONS = ['Design and engineering services', 'Construction works and materials', 'Government and authority fees', 'Utility connection charges',
  'Legal and notary fees', 'Furniture and equipment'];

const PROP_SCOPE = ['Tenant search and leasing', 'Rent invoicing and collection', 'Lease renewals and notices', 'Maintenance coordination', 'Cleaning coordination',
  'Property inspections', 'Utility and service charge follow-up', 'Monthly owner statements'];
const PROP_EXCLUSIONS = ['Major repairs and capital works', 'Legal proceedings against tenants', 'Utility and service charges', 'Building insurance', 'Government fees'];
const MARKETING_CHANNELS = ['Property portal', 'Instagram', 'Facebook', 'TikTok', 'WhatsApp', 'Newspaper', 'Signboard', 'Email campaign', 'Website', 'Open house'];
const SALES_EXPENSE_CATEGORIES = ['Portal listing', 'Photography / video', 'Printing', 'Advertising', 'Signboard', 'Legal / registration', 'Valuation', 'Other'];
const CONTACT_CHANNELS = ['Phone call', 'WhatsApp', 'Email', 'In person'];
const LANGUAGES = ['English', 'Arabic'];
const LEAD_SOURCES = ['Referral', 'Walk-in', 'Website', 'Instagram', 'Property portal', 'WhatsApp', 'Existing client', 'Signboard'];
const UNIT_TYPES = ['Villa', 'Townhouse', 'Apartment', 'Penthouse', 'Shop', 'Office', 'Warehouse', 'Plot'];
const CONDITIONS = ['New', 'Excellent', 'Good', 'Needs renovation', 'Under construction', 'Off-plan'];

// Today in Bahrain as yyyy-mm-dd, for date fields that are almost always "today".
const today = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);

// Names already used in a workspace (team, contractors, suppliers, payees, owners, users), offered as suggestions.
async function knownNames(pool, wsId) {
  const r = await pool.query(`select distinct n from (
      select title as n from register_items where workspace_id = $1 and kind = 'stakeholder' and archived_at is null
      union select counterparty from commitments where workspace_id = $1
      union select supplier from cost_invoices where workspace_id = $1
      union select payee from cost_payments where workspace_id = $1
      union select owner_text from tasks where workspace_id = $1
      union select owner_text from register_items where workspace_id = $1
      union select name from users where kind = 'internal' and active
    ) x where n is not null and n <> '' order by n limit 300`, [wsId]).catch(() => ({ rows: [] }));
  return r.rows.map(x => x.n);
}

// Lines of a stored "tick-box" answer; used when a form shows the ticks again.
const lines = s => String(s || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);

// Express middleware: a tick-box group posts <name>__pick (each ticked option) and <name>__other (free lines);
// they are combined into one newline-separated <name> value so the handlers read a single text answer.
function combineChecks(req, res, next) {
  const b = req.body;
  if (b && typeof b === 'object') for (const k of Object.keys(b)) {
    if (!k.endsWith('__checks')) continue;
    const base = k.slice(0, -8);
    const picks = [].concat(b[`${base}__pick`] || []).map(String);
    const other = lines(b[`${base}__other`]);
    b[base] = [...new Set([...picks, ...other])].join('\n');
    delete b[k]; delete b[`${base}__pick`]; delete b[`${base}__other`];
  }
  next();
}

module.exports = { BH_AREAS, STAGES, BUDGET_CATEGORIES, PAY_METHODS, BH_APPROVALS, COMMON_RISKS, MGMT_SCOPE, MGMT_EXCLUSIONS, PROP_SCOPE, PROP_EXCLUSIONS, MARKETING_CHANNELS,
  SALES_EXPENSE_CATEGORIES, CONTACT_CHANNELS, LANGUAGES, LEAD_SOURCES, UNIT_TYPES, CONDITIONS, today, knownNames, lines, combineChecks };
