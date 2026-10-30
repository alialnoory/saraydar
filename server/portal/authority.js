'use strict';
// Authority matrix (owner request 2026-10-29): for each staff role, which actions it may take in each area of the
// system, and up to which amount it may approve money. Super Admin can always do everything. The matrix sets the
// most a role may do; people still need to be added to a project, property or case to open it.
const { layout, html, raw, csrfField, field, ROLE_LABELS } = require('./views');
const { parseMoney, formatMoney } = require('../lib/money');

const ACTIONS = [['view', 'View'], ['create', 'Create'], ['edit', 'Edit'], ['approve', 'Approve'], ['delete', 'Delete / cancel'], ['export', 'Export']];
const ACT_SHORT = { view: 'V', create: 'C', edit: 'E', approve: 'A', delete: 'D', export: 'X' };

// areas, grouped as people see them; segs = the part of the address after /w/<id>/ that belongs to the area
const GROUPS = [
  ['dev', 'SarayDar Real Estate Development', [
    ['dev.record', 'Project record, setup and land', ['', 'edit', 'setup', 'plots', 'activity', 'client']],
    ['dev.plan', 'Plan and master plan', ['plan', 'master', 'tasks', 'phases', 'comments']],
    ['dev.updates', 'Progress updates', ['updates']],
    ['dev.registers', 'Registers (risks, permits, issues)', ['registers']],
    ['dev.budget', 'Budget and cost', ['budget']],
    ['dev.investors', 'Investors and funding', ['investors']],
    ['dev.units', 'Units and sales', ['units']],
    ['dev.docs', 'Agreements and documents', ['agreements', 'documents', 'files']],
    ['dev.reports', 'Reports', ['reports', 'export']],
    ['dev.access', 'Access and invitations', ['access', 'invitations']]]],
  ['cpm', 'Clients Projects Management', [
    ['cpm.record', 'Project record, client, setup and land', ['', 'edit', 'client', 'setup', 'plots', 'activity']],
    ['cpm.agreements', 'Agreements', ['agreements']],
    ['cpm.plan', 'Plan and master plan', ['plan', 'master', 'tasks', 'phases', 'comments']],
    ['cpm.approvals', 'Client approvals', ['approvals']],
    ['cpm.updates', 'Progress updates', ['updates']],
    ['cpm.registers', 'Registers (risks, permits, issues)', ['registers']],
    ['cpm.budget', 'Client budget and payments', ['budget']],
    ['cpm.fees', 'Fee billing (SarayDar fees)', ['fees', 'terms']],
    ['cpm.docs', 'Documents', ['documents', 'files']],
    ['cpm.reports', 'Reports', ['reports', 'export']],
    ['cpm.access', 'Access and invitations', ['access', 'invitations']]]],
  ['props', 'Clients Properties Management', [
    ['props.record', 'Property record, owner and setup', ['', 'edit', 'client', 'property', 'owners', 'history', 'activity']],
    ['props.units', 'Units', ['units']],
    ['props.leases', 'Leases and tenants', ['leases']],
    ['props.rent', 'Rent and collections', ['rent']],
    ['props.deposits', 'Deposits', ['deposits']],
    ['props.maint', 'Maintenance, cleaning and services', ['maintenance', 'services']],
    ['props.expenses', 'Expenses', ['expenses']],
    ['props.owner', 'Owner account and opening balances', ['owner', 'opening']],
    ['props.fees', 'Fee billing (SarayDar fees)', ['fees', 'terms']],
    ['props.docs', 'Agreements and documents', ['agreements', 'documents', 'files']],
    ['props.reports', 'Reports', ['reports', 'export']],
    ['props.access', 'Access and invitations', ['access', 'invitations']]]],
  ['sales', 'Property Sales & Acquisition', [
    ['sales.record', 'Listings and requests (mandate, property file, brief)', ['', 'edit', 'mandate', 'listing', 'brief', 'request', 'checklist', 'activity']],
    ['sales.marketing', 'Marketing, matches and shortlists', ['marketing', 'shortlist', 'brochure', 'external', 'market-search']],
    ['sales.buyers', 'Buyers, viewings and offers', ['buyers', 'offers', 'enquiries']],
    ['sales.fees', 'Fee billing and sales expenses', ['fees', 'terms', 'sales-expenses']],
    ['sales.docs', 'Agreements and documents', ['agreements', 'documents', 'files']],
    ['sales.access', 'Access and invitations', ['access', 'invitations']]]],
  ['gen', 'Across the system', [
    ['gen.clients', 'Clients and contacts', []],
    ['gen.assistant', 'AI assistant and market search', ['assistant']]]],
  ['admin', 'Administration', [
    ['admin.users', 'Users (never Super Admins)', []],
    ['admin.templates', 'Agreement and master-plan templates', []],
    ['admin.audit', 'Audit log, outbox and system', []]]]
];
const AREAS = Object.fromEntries(GROUPS.flatMap(([g, gl, as]) => as.map(([k, l, segs]) => [k, { key: k, group: g, groupLabel: gl, label: l, segs }])));
const SEG = {};
for (const a of Object.values(AREAS)) for (const s of a.segs) { SEG[a.group] = SEG[a.group] || {}; SEG[a.group][s] = a.key; }
const FINANCE = new Set(['dev.budget', 'dev.investors', 'cpm.budget', 'cpm.fees', 'props.rent', 'props.deposits', 'props.expenses', 'props.owner', 'props.fees', 'sales.fees']);

// money limits: the most one approval may be worth (in BHD)
const LIMITS = [
  ['invoice', 'Approve contractor / supplier invoices', 'per invoice'],
  ['payment', 'Confirm payments', 'per payment'],
  ['contract', 'Record contracts, orders and appointments', 'per contract'],
  ['variation', 'Approve variations', 'per variation'],
  ['budget', 'Change a budget line', 'per change'],
  ['expense', 'Record property and sales expenses', 'per expense']
];

// ---- the starting matrix for each role (adjustable on screen) ----
const ALL = ACTIONS.map(a => a[0]);
const fill = (keys, acts) => Object.fromEntries(keys.map(k => [k, acts]));
const keysOf = (...groups) => Object.values(AREAS).filter(a => groups.includes(a.group)).map(a => a.key);
const nonFin = ks => ks.filter(k => !FINANCE.has(k));
const BHD = n => n * 1000;
// starting points close to how the system worked before the matrix, so nobody loses what they do today; adjust on screen
const notAdmin = () => Object.keys(AREAS).filter(k => !k.startsWith('admin.'));
const recordsOf = (...g) => keysOf(...g).filter(k => k.endsWith('.record'));
function defaults(role) {
  const ops = ['view', 'create', 'edit', 'export'];
  switch (role) {
    case 'project_manager': return { matrix: { ...fill(keysOf('dev', 'cpm', 'props'), ALL), ...fill(keysOf('sales'), ['view', 'export']), 'gen.clients': ['view', 'create', 'edit'], 'gen.assistant': ['view', 'create'] },
      limits: { invoice: null, contract: null, variation: null, budget: null, expense: null } };
    case 'finance': return { matrix: { ...fill(notAdmin(), ['view', 'export']), ...fill([...FINANCE], ALL), 'gen.clients': ['view', 'create', 'edit'], 'gen.assistant': ['view', 'create'], 'admin.audit': ['view'] },
      limits: { invoice: null, payment: null, contract: null, variation: null, budget: null, expense: null } };
    case 'engineer': return { matrix: { ...fill(nonFin(keysOf('dev', 'cpm', 'props')), ops), ...fill(recordsOf('dev', 'cpm', 'props'), ['view', 'edit', 'export']), 'gen.clients': ['view'], 'gen.assistant': ['view', 'create'] }, limits: {} };
    case 'site_supervisor': return { matrix: { ...fill(nonFin(keysOf('dev', 'cpm')).filter(k => !/\.(access|agreements)$/.test(k)), ['view']), 'dev.updates': ['view', 'create', 'edit'], 'cpm.updates': ['view', 'create', 'edit'],
      'dev.registers': ['view', 'create'], 'cpm.registers': ['view', 'create'], 'dev.docs': ['view', 'create'], 'cpm.docs': ['view', 'create'], 'props.record': ['view'], 'props.maint': ['view', 'create', 'edit'] }, limits: {} };
    case 'administrator': return { matrix: { ...fill(nonFin(notAdmin()), ops), ...fill([...FINANCE], ['view', 'export']), 'admin.users': ['view', 'create', 'edit'], 'admin.templates': ['view', 'edit'], 'admin.audit': ['view'] }, limits: {} };
    case 'chairman': return { matrix: { ...fill(notAdmin(), ['view', 'export']), 'admin.audit': ['view'] }, limits: {} };
    case 'viewer': return { matrix: fill(nonFin(notAdmin()).filter(k => k !== 'gen.assistant'), ['view', 'export']), limits: {} };
    case 'brokerage_agent': return { matrix: { ...fill(nonFin(keysOf('sales')), ALL), 'gen.clients': ['view', 'create', 'edit'], 'gen.assistant': ['view', 'create'] }, limits: {} };
    case 'sales_manager': return { matrix: { ...fill(keysOf('sales'), ALL), ...fill(keysOf('props'), ['view', 'export']), 'gen.clients': ['view', 'create', 'edit', 'delete'], 'gen.assistant': ['view', 'create'] },
      limits: { invoice: null, contract: null, expense: null } };
    default: return { matrix: {}, limits: {} };
  }
}

// the older section-wide switches, kept in step with the matrix so every existing check follows it
function legacyFrom(matrix, limits = {}) {
  const has = (k, a) => (matrix[k] || []).includes(a);
  const p = [];
  for (const s of ['dev', 'cpm', 'props', 'sales']) if (has(`${s}.record`, 'create')) p.push(`create:${s}`);
  if ([...FINANCE].some(k => has(k, 'view'))) p.push('view:financials');
  if ([...FINANCE].some(k => has(k, 'approve')) && 'payment' in (limits || {})) p.push('finance:post');   // posting money: approve in a finance area and a payment authority
  return p.sort();
}
const clean = m => Object.fromEntries(Object.entries(m || {}).filter(([k]) => AREAS[k]).map(([k, v]) => [k, ALL.filter(a => (v || []).includes(a))]).filter(([, v]) => v.length));

function mountAuthority(r, ctx) {
  const { pool, core, Forbidden, NotFound } = ctx;
  const bad = m => Object.assign(new Error(m), { status: 400 });

  // fill in the starting matrix for roles that have none yet, and keep labels of added roles known everywhere
  ctx.authorityReady = (async () => {
    const roles = (await pool.query("select * from roles where kind = 'internal'")).rows;
    for (const ro of roles) {
      if (ro.key === 'super_admin') continue;
      ROLE_LABELS[ro.key] = ro.label;
      if (ro.see_all) core.seeAllRoles.add(ro.key);
      if (ro.matrix) continue;
      const d = defaults(ro.key);
      await pool.query('update roles set matrix = $2, limits = $3, permissions = $4 where key = $1 and matrix is null', [ro.key, JSON.stringify(d.matrix), JSON.stringify(d.limits), legacyFrom(d.matrix, d.limits)]);
    }
  })();

  async function roleOf(user) {
    if (user._auth) return user._auth;
    const ro = (await pool.query('select matrix, limits from roles where key = $1', [user.system_role])).rows[0] || {};
    user._auth = { matrix: ro.matrix || {}, limits: ro.limits || {} };
    return user._auth;
  }
  async function allowed(user, area, action) {
    if (!user) return false;
    if (core.isSuper(user)) return true;
    if (core.isExternal(user)) return false;
    const { matrix } = await roleOf(user);
    return (matrix[area] || []).includes(action);
  }
  // money: throws when the amount is above what the person's role may approve
  async function checkLimit(req, kind, minor, what) {
    const u = req.user;
    if (core.isSuper(u) || minor === null || minor === undefined) return;
    const { limits } = await roleOf(u);
    const label = (LIMITS.find(l => l[0] === kind) || [kind, kind])[1].toLowerCase();
    if (!(kind in limits)) throw new Forbidden(`Your role (${ROLE_LABELS[u.system_role] || u.system_role}) is not allowed to ${label}. Ask a Super Admin or someone with this authority.`);
    const max = limits[kind];
    if (max !== null && Math.abs(minor) > max) throw new Forbidden(`${what || 'This'} is ${formatMoney(Math.abs(minor))}. Your role (${ROLE_LABELS[u.system_role] || u.system_role}) may ${label} up to ${formatMoney(max)}; someone with a higher limit has to do it.`);
  }
  ctx.authority = { allowed, checkLimit, AREAS, areaOfTab };

  // which area a workspace page belongs to
  function areaOfTab(section, href) {
    const m = /^\/w\/[0-9a-f-]{36}(?:\/([^/?#]*))?/i.exec(href || '');
    if (!m) return null;
    return (SEG[section] || {})[m[1] || ''] || null;
  }
  const COLLECTION = /^(updates|tasks|registers|lines|commitments|invoices|payments|leases|units|plots|files|comments|investors|txns|installments|agreements|invitations|maintenance|services|expenses|sales-expenses|marketing|shortlist|stages|procurement|phases|opening|owners|enquiries|drafts|additional|deposits|events|photos|range|new|add|access|buyers|offers|viewings|opportunities|activities|correspondence|clients|charges|assistant|market-search)$/;
  function actionOf(req) {
    if (req.method === 'GET' || req.method === 'HEAD') return req.query.export ? 'export' : 'view';
    const p = req.path.replace(/\/+$/, ''), last = p.split('/').pop();
    if (/\/(approve|confirm|activate|issue|publish|decision|signed|verify|send|receipt|allocate|adopt)$/.test(p)) return 'approve';
    if (/\/budget\/invoices\/[0-9a-f-]{36}$/i.test(p)) return req.body && req.body.decision === 'reviewed' ? 'edit' : 'approve';
    if (/\/(delete|remove|revoke|void|discard|reverse|withdraw|credit|stop|restore|restore-item)$/.test(p)) return 'delete';
    if (COLLECTION.test(last)) return 'create';
    return 'edit';
  }
  const ACT_WORD = { view: 'open', create: 'add records in', edit: 'change', approve: 'approve in', delete: 'delete or cancel in', export: 'export' };
  const deny = (area, action) => new Forbidden(`Your role does not allow you to ${ACT_WORD[action]} “${AREAS[area].label}” (${AREAS[area].groupLabel}). A Super Admin can change this in Administration › Authority matrix.`);

  // the gate: every staff request to a project, property, sales case, contacts or administration page
  r.use(async (req, res, next) => {
    try {
      const u = req.user;
      if (!u || core.isSuper(u) || core.isExternal(u)) return next();
      const { matrix } = await roleOf(u);
      req.adminAreas = Object.keys(matrix).filter(k => k.startsWith('admin.') && matrix[k].includes('view'));
      const action = actionOf(req);
      let area = null;
      const w = /^\/w\/([0-9a-f-]{36})(?:\/([^/?#]*))?/i.exec(req.path);
      if (w) {
        const ws = (await pool.query('select section from workspaces where id = $1', [w[1]])).rows[0];
        if (!ws) return next();
        req.wsSection = ws.section;
        // tabs of areas this role may not open are left out of the page
        req.tabFilter = href => { const k = areaOfTab(ws.section, href); return !k || (matrix[k] || []).includes('view'); };
        area = (SEG[ws.section] || {})[w[2] || ''] || null;
        if (!area) return next();
        // a "view" of the overview needs only view; reading a sub-page needs its own view right
      } else {
        const s = /^\/s\/(dev|cpm|props|sales)(\/new)?/.exec(req.path);
        if (s) area = `${s[1]}.record`;
        else if (/^\/(clients|people)(\/|$)/.test(req.path)) area = 'gen.clients';
        else if (/^\/sales\/(buyers|offers|viewings|opportunities|duplicates)/.test(req.path)) area = 'sales.buyers';
        else if (/^\/admin\/users/.test(req.path)) area = 'admin.users';
        else if (/^\/admin\/(agreements|master-plan)/.test(req.path)) area = 'admin.templates';
        else if (/^\/admin\/(audit|outbox|system)/.test(req.path)) area = 'admin.audit';
        else if (/^\/admin(\/|$)/.test(req.path)) return next(new NotFound());   // the matrix itself: Super Admin only
        if (!area) return next();
      }
      const act = /^\/s\/[a-z]+\/new/.test(req.path) ? 'create' : action;
      if (await allowed(u, area, act)) { if (area.startsWith('admin.')) req.adminArea = area; return next(); }
      if (act === 'view' || area.startsWith('admin.') || !(await allowed(u, area, 'view'))) return next(new NotFound());   // what you may not open stays out of sight
      return next(deny(area, act));
    } catch (e) { next(e); }
  });

  // ---------- Administration › Authority matrix ----------
  const pctx = (req, title, body) => layout(req, { title, heading: 'Administration', crumbs: [['Home', '/'], ['Administration', '/admin'], ['Authority matrix']], tabs: ctx.adminTabs ? ctx.adminTabs(req, 'roles') : null, body });
  const roleList = async () => (await pool.query("select * from roles where kind = 'internal' and key <> 'super_admin' order by builtin desc, label")).rows;
  const counts = async () => Object.fromEntries((await pool.query("select system_role as k, count(*)::int as n from users where active and kind = 'internal' group by 1")).rows.map(x => [x.k, x.n]));
  const fmtLimit = (limits, k) => !(k in (limits || {})) ? '—' : limits[k] === null ? 'No limit' : formatMoney(limits[k]);

  r.get('/admin/roles', async (req, res) => {
    await ctx.authorityReady;
    const roles = await roleList(), n = await counts();
    const sel = roles.find(x => x.key === req.query.role) || null;
    if (sel) return res.send(pctx(req, `Authority · ${sel.label}`, roleEditor(req, sel, roles, n)));
    res.send(pctx(req, 'Authority matrix', html`
      <section class="panel"><div class="row-between"><h2 class="h">Authority matrix</h2><span class="muted small">V view · C create · E edit · A approve · D delete / cancel · X export</span></div>
        <p class="muted">What each staff role may do in each area, and how much money it may approve. Super Admin can do everything. People also need to be added to a project, property or case to open it. Choose a role to change it.</p>
        <div class="am-roles">${roles.map(ro => html`<a class="am-role" href="/admin/roles?role=${ro.key}"><b>${ro.label}</b><span>${n[ro.key] || 0} ${n[ro.key] === 1 ? 'person' : 'people'}${ro.see_all ? ' · sees all records' : ''}</span>${!ro.builtin ? html`<i>Added</i>` : ''}</a>`)}
          <a class="am-role am-add" href="#add-role"><b>+ Add a role</b><span>e.g. Accountant, Leasing Officer</span></a></div>
        <p class="am-phone-note muted small">On a phone, open a role above to see and change what it can do.</p>
        <div class="table-wrap am-wrap"><table class="am-grid"><thead><tr><th>Area</th>${roles.map(ro => html`<th class="c"><a href="/admin/roles?role=${ro.key}">${ro.label}</a></th>`)}</tr></thead><tbody>
          ${GROUPS.map(([g, gl, as]) => html`<tr class="am-group"><th colspan="${roles.length + 1}">${gl}</th></tr>
            ${as.map(([k, l]) => html`<tr><td>${l}${FINANCE.has(k) ? html` <span class="am-fin">Finance</span>` : ''}</td>${roles.map(ro => { const v = (ro.matrix || {})[k] || []; return html`<td class="c am-cell ${v.length ? (v.length === ALL.length ? 'full' : 'part') : 'none'}">${v.length ? v.map(a => ACT_SHORT[a]).join(' ') : '—'}</td>`; })}</tr>`)}`)}
          <tr class="am-group"><th colspan="${roles.length + 1}">Money limits (BHD, the most one approval may be worth)</th></tr>
          ${LIMITS.map(([k, l, per]) => html`<tr><td>${l} <span class="muted small">${per}</span></td>${roles.map(ro => html`<td class="c am-cell ${!(k in (ro.limits || {})) ? 'none' : 'full'}">${fmtLimit(ro.limits, k)}</td>`)}</tr>`)}
        </tbody></table></div></section>
      <section class="panel" id="add-role"><h2 class="h">Add a role</h2>
        <form method="post" action="/admin/roles/new" class="form-grid">${csrfField(req)}
          ${field({ name: 'label', label: 'Role name', required: true, attrs: 'maxlength="60" placeholder="e.g. Accountant"' })}
          ${field({ name: 'copy', label: 'Start from', value: 'viewer', options: roles.map(ro => [ro.key, `Same as ${ro.label}`]) })}
          ${field({ name: 'description', label: 'What this role is for', full: true, attrs: 'maxlength="200"' })}
          <div class="actions full"><button class="btn primary" type="submit">Add role and adjust it</button></div></form></section>`));
  });

  function roleEditor(req, ro, roles, n) {
    const m = ro.matrix || {}, lim = ro.limits || {};
    return html`<p><a href="/admin/roles">‹ Authority matrix</a></p>
      <div class="am-roles am-roles-tabs">${roles.map(x => html`<a class="am-role ${x.key === ro.key ? 'on' : ''}" href="/admin/roles?role=${x.key}"><b>${x.label}</b><span>${n[x.key] || 0} ${n[x.key] === 1 ? 'person' : 'people'}</span></a>`)}</div>
      <form method="post" action="/admin/roles/${ro.key}" data-am>${csrfField(req)}
      <section class="panel"><div class="row-between"><h2 class="h">${ro.label}</h2><div class="am-quick"><button type="button" class="btn small" data-am-all="1">Tick everything</button><button type="button" class="btn small" data-am-all="0">Clear everything</button></div></div>
        ${ro.description ? html`<p class="muted">${ro.description}</p>` : ''}
        <div class="table-wrap"><table class="am-edit"><thead><tr><th>Area</th>${ACTIONS.map(([a, l]) => html`<th class="c">${l}</th>`)}<th class="c">Row</th></tr></thead><tbody>
          ${GROUPS.map(([g, gl, as]) => html`<tr class="am-group"><th colspan="${ACTIONS.length + 1}">${gl}</th><th class="c"><button type="button" class="linkbtn small" data-am-group="${g}">All</button></th></tr>
            ${as.map(([k, l]) => html`<tr data-g="${g}"><td>${l}${FINANCE.has(k) ? html` <span class="am-fin">Finance</span>` : ''}</td>
              ${ACTIONS.map(([a, al]) => html`<td class="c" data-l="${al.split(' ')[0]}"><label class="am-tick"><input type="checkbox" name="m" value="${k}|${a}" aria-label="${l}: ${al}" ${(m[k] || []).includes(a) ? raw('checked') : ''}><span></span></label><small class="am-l" aria-hidden="true">${al.split(' ')[0]}</small></td>`)}
              <td class="c"><button type="button" class="linkbtn small" data-am-row>All</button></td></tr>`)}`)}
        </tbody></table></div>
        <p class="muted small">Ticking Create, Edit, Approve, Delete or Export also ticks View. Approving money is limited by the amounts below.</p></section>
      <section class="panel"><h2 class="h">Which records</h2>
        <div class="seg-field am-scope"><label><input type="radio" name="see_all" value="0" ${!ro.see_all ? raw('checked') : ''}><span>Only records they are added to</span></label><label><input type="radio" name="see_all" value="1" ${ro.see_all ? raw('checked') : ''}><span>All records in the system</span></label></div>
        <p class="muted small">“All records” lets people with this role open every project, property and sales case their ticks above allow, without being added to each one. Changing a record they are not added to stays view-only.</p></section>
      <section class="panel"><h2 class="h">Money limits</h2>
        <p class="muted">The most one approval may be worth. Leave the amount empty for no limit; choose “Not allowed” to block it. Above the limit, someone with a higher limit (or a Super Admin) has to do it.</p>
        <div class="am-limits">${LIMITS.map(([k, l, per]) => html`<div class="am-limit"><div><b>${l}</b><span class="muted small">${per}</span></div>
          <div class="seg-field"><label><input type="radio" name="lim_on_${k}" value="0" ${!(k in lim) ? raw('checked') : ''}><span>Not allowed</span></label><label><input type="radio" name="lim_on_${k}" value="1" ${k in lim ? raw('checked') : ''}><span>Allowed up to</span></label></div>
          <label class="am-amt"><span>BHD</span><input name="lim_${k}" inputmode="decimal" value="${k in lim && lim[k] !== null ? String(lim[k] / 1000) : ''}" placeholder="No limit" aria-label="${l}: limit in BHD"></label></div>`)}</div></section>
      <section class="panel"><h2 class="h">Name</h2><div class="form-grid">${field({ name: 'label', label: 'Role name', value: ro.label, attrs: 'maxlength="60"' })}${field({ name: 'description', label: 'What this role is for', value: ro.description || '', attrs: 'maxlength="200"' })}</div>
        <p class="muted small">Changes apply to everyone with this role from their next page. Every change is kept in the audit log.</p></section>
      <section class="panel am-save"><div class="actions"><button class="btn primary" type="submit">Save ${ro.label}</button>
        ${!ro.builtin && !n[ro.key] ? html`<button class="btn danger-link" type="submit" formaction="/admin/roles/${ro.key}/delete" data-confirm="Delete the role ${ro.label}?">Delete this role</button>` : ''}</div></section>
      </form>`;
  }

  r.post('/admin/roles/new', async (req, res) => {
    if (!core.isSuper(req.user)) throw new NotFound();
    const label = String(req.body.label || '').trim().slice(0, 60);
    if (!label) throw bad('Enter the role name.');
    let key = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'role';
    if ((await pool.query('select 1 from roles where key = $1', [key])).rowCount) key = `${key}_${Date.now().toString(36).slice(-4)}`;
    const src = (await pool.query("select * from roles where key = $1 and kind = 'internal' and key <> 'super_admin'", [req.body.copy])).rows[0];
    const matrix = src && src.matrix ? src.matrix : {}, limits = src && src.limits ? src.limits : {};
    await core.inTx(async db => {
      await db.query("insert into roles (key, label, kind, permissions, builtin, matrix, limits, description, see_all) values ($1,$2,'internal',$3,false,$4,$5,$6,$7)", [key, label, legacyFrom(matrix, limits), JSON.stringify(matrix), JSON.stringify(limits), String(req.body.description || '').trim().slice(0, 200) || null, !!(src && src.see_all)]);
      await core.audit(db, { actor: req.user, action: 'role.added', entity: 'role', entityId: key, summary: `Added the role ${label}${src ? ` (started from ${src.label})` : ''}`, after: { matrix, limits }, ip: req.ip });
    });
    ROLE_LABELS[key] = label;
    if (src && src.see_all) core.seeAllRoles.add(key);
    res.redirect(`/admin/roles?role=${key}&msg=saved`);
  });

  r.post('/admin/roles/:key', async (req, res) => {
    if (!core.isSuper(req.user)) throw new NotFound();
    const ro = (await pool.query("select * from roles where key = $1 and kind = 'internal' and key <> 'super_admin'", [req.params.key])).rows[0];
    if (!ro) throw new NotFound();
    let ticks = req.body.m; ticks = Array.isArray(ticks) ? ticks : ticks ? [ticks] : [];
    const matrix = {};
    for (const t of ticks) { const [k, a] = String(t).split('|'); if (!AREAS[k] || !ALL.includes(a)) continue; (matrix[k] = matrix[k] || new Set()).add(a); }
    for (const k of Object.keys(matrix)) { if (matrix[k].size) matrix[k].add('view'); matrix[k] = ALL.filter(a => matrix[k].has(a)); }
    const limits = {};
    for (const [k] of LIMITS) {
      if (req.body[`lim_on_${k}`] !== '1') continue;
      const v = String(req.body[`lim_${k}`] || '').trim();
      if (!v) { limits[k] = null; continue; }
      const m = parseMoney(v, 'BHD'); if (m === null || m < 0) throw bad('Enter the limits as amounts in BHD, e.g. 5,000.');
      limits[k] = m;
    }
    const seeAll = req.body.see_all === '1';
    const label = String(req.body.label || '').trim().slice(0, 60) || ro.label, description = String(req.body.description || '').trim().slice(0, 200) || null;
    const clean2 = clean(matrix);
    await core.inTx(async db => {
      await db.query('update roles set matrix = $2, limits = $3, permissions = $4, label = $5, description = $6, see_all = $7 where key = $1', [ro.key, JSON.stringify(clean2), JSON.stringify(limits), legacyFrom(clean2, limits), label, description, seeAll]);
      await core.audit(db, { actor: req.user, action: 'role.authority_changed', entity: 'role', entityId: ro.key, summary: `Changed the authority of ${label}`, before: { matrix: ro.matrix, limits: ro.limits, label: ro.label, see_all: ro.see_all }, after: { matrix: clean2, limits, label, see_all: seeAll }, ip: req.ip });
    });
    if (seeAll) core.seeAllRoles.add(ro.key); else core.seeAllRoles.delete(ro.key);
    ROLE_LABELS[ro.key] = label;
    res.redirect(`/admin/roles?role=${ro.key}&msg=saved`);
  });

  r.post('/admin/roles/:key/delete', async (req, res) => {
    if (!core.isSuper(req.user)) throw new NotFound();
    const ro = (await pool.query("select * from roles where key = $1 and not builtin", [req.params.key])).rows[0];
    if (!ro) throw new NotFound();
    if ((await pool.query('select 1 from users where system_role = $1', [ro.key])).rowCount) throw bad('Move the people with this role to another role first.');
    await core.inTx(async db => {
      await db.query('delete from roles where key = $1', [ro.key]);
      await core.audit(db, { actor: req.user, action: 'role.deleted', entity: 'role', entityId: ro.key, summary: `Deleted the role ${ro.label}`, before: { matrix: ro.matrix, limits: ro.limits }, ip: req.ip });
    });
    delete ROLE_LABELS[ro.key];
    res.redirect('/admin/roles?msg=saved');
  });
}

module.exports = { mountAuthority, AREAS, GROUPS, ACTIONS, LIMITS, defaults, legacyFrom };
