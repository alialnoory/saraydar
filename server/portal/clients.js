'use strict';
const CH = require('./choices');
const U = require('../lib/undo');
// Client register for Clients Projects Management: profiles, linked projects and agreements,
// correspondence log and a client-level fee statement across that client's projects.
// Only projects the signed-in user can open are listed or counted.
const { layout, html, raw, pill, statusPill, csrfField, field, emptyState, fmtDate } = require('./views');
const { formatMoney } = require('../lib/money');

const UUID = /^[0-9a-f-]{36}$/i;
const bad = m => Object.assign(new Error(m), { status: 400 });
const txt = (v, n = 300) => { const s = String(v ?? '').trim().slice(0, n); return s || null; };
const fm = m => formatMoney(m || 0);
const KINDS = { call: 'Call', email: 'Email', meeting: 'Meeting', letter: 'Letter', message: 'Message', other: 'Other' };
// Client details first, then who signs for the client, then billing and other details (owner request 2026-10-24).
const CLIENT_F = [['kind', 'Individual or company'], ['name', 'Name'], ['id_number', 'CPR / CR number'], ['phone', 'Telephone'], ['email', 'Email'],
  ['preferred_contact', 'Preferred communication'], ['contact_person', 'Day-to-day contact (if not the client)'], ['address', 'Address']];
const REP_F = [['representative', 'Representative name'], ['representative_title', 'Title / capacity'], ['representative_cpr', 'Representative CPR number'], ['representative_phone', 'Representative telephone'], ['representative_email', 'Representative email']];
const MORE_F = [['representatives', 'Other authorised representatives'], ['billing_name', 'Billing name'], ['billing_address', 'Billing address'], ['billing_email', 'Billing email'],
  ['tax_number', 'Tax registration number'], ['client_reference', 'Client reference'], ['communication_notes', 'Communication responsibilities'], ['notes', 'Notes']];
const FIELDS = [...CLIENT_F, ...REP_F, ...MORE_F];
const LONG = new Set(['representatives', 'address', 'billing_address', 'communication_notes', 'notes']);

function mountClients(r, ctx, F) {
  const { pool, core, NotFound, Forbidden } = ctx;
  async function gate(req) {
    const u = req.user;
    if (core.isExternal(u)) throw new NotFound();
    if (!(core.isSuper(u) || await core.can(u, 'create:cpm') || await core.can(u, 'finance:post'))) throw new Forbidden('Your role cannot open the client register.');
    return { canEdit: core.isSuper(u) || await core.can(u, 'create:cpm'), seeFees: core.isSuper(u) || await core.can(u, 'view:financials') || await core.can(u, 'finance:post') };
  }
  const shell = (req, title, crumbs, body, actions = null) => layout(req, { title, heading: title, crumbs: [['Home', '/'], ['Clients Projects Management', '/s/cpm'], ...crumbs], actions, body });
  const visibleProjects = async (user, partyId) => (await pool.query(
    `select w.* from workspaces w where ${core.visibleWhere(user)} and w.section = 'cpm' and w.party_id = $2 order by w.name`, [user.id, partyId])).rows;

  function readClient(b) {
    const v = {};
    for (const [k] of FIELDS) v[k] = txt(b[k], LONG.has(k) ? 2000 : 200);
    v.kind = v.kind === 'company' ? 'company' : 'person';
    if (!v.name) throw bad('Enter the client name.');
    v.signs_personally = b.signs_personally === '1';
    if (v.signs_personally) { v.representative = null; v.representative_title = null; v.representative_cpr = null; v.representative_phone = null; v.representative_email = null; }
    if (!v.billing_name) v.billing_name = v.name;          // the billing name is the client's name unless a different one is entered
    if (!v.billing_address) v.billing_address = v.address;
    if (!v.billing_email) v.billing_email = v.email;
    if (v.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.email)) throw bad('Check the email address.');
    if (v.representative_email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.representative_email)) throw bad('Check the representative\'s email address.');
    if (v.billing_email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.billing_email)) throw bad('Check the billing email address.');
    return v;
  }
  const one = (c, k, l) => k === 'kind' ? field({ name: k, label: l, value: c.kind || 'person', options: [['person', 'Individual'], ['company', 'Company']] })
    : k === 'preferred_contact' ? field({ name: k, label: l, value: c[k] || '', options: [['', 'Not stated'], ...(c[k] && !CH.CONTACT_CHANNELS.includes(c[k]) ? [[c[k], c[k]]] : []), ...CH.CONTACT_CHANNELS.map(x => [x, x])] })
    : field({ name: k, label: l, value: k === 'billing_name' ? (c.billing_name || c.name || '') : c[k] || '', required: k === 'name', type: LONG.has(k) ? 'textarea' : k.includes('email') ? 'email' : /phone/.test(k) ? 'tel' : 'text', full: LONG.has(k),
        hint: k === 'id_number' ? 'CPR for an individual, CR for a company. Printed in agreements.' : k === 'representative' ? 'Printed in agreements as "represented by …" and in the signature box.'
          : k === 'representative_title' ? 'For example Attorney under power of attorney, Managing Director. Empty = "Client\'s Representative".' : k === 'billing_name' ? 'Same as the client name unless different.'
          : k === 'billing_address' ? 'Leave empty to use the address above.' : k === 'billing_email' ? 'Leave empty to use the email.' : '' });
  const form = (req, c = {}, action, label) => {
    const anyMore = MORE_F.some(([k]) => k !== 'billing_name' && c[k] && !(k === 'billing_address' && c[k] === c.address) && !(k === 'billing_email' && c[k] === c.email));
    return html`<form method="post" action="${action}" class="panel form-grid">${csrfField(req)}
    <h3 class="h3 full form-section">Client details</h3>
    ${CLIENT_F.map(([k, l]) => one(c, k, l))}
    <h3 class="h3 full form-section">Client's representative</h3>
    <label class="check full"><input type="checkbox" name="signs_personally" value="1" data-hides="rep-fields" ${c.signs_personally ? raw('checked') : ''}> The client represents himself / herself and signs personally (no representative)</label>
    <div class="full form-grid" id="rep-fields" ${c.signs_personally ? raw('hidden') : ''}>${REP_F.map(([k, l]) => one(c, k, l))}</div>
    <details class="full inline-form" ${anyMore ? raw('open') : ''}><summary>Billing and other details</summary><div class="form-grid">${MORE_F.map(([k, l]) => one(c, k, l))}</div></details>
    <div class="actions full"><button class="btn primary" type="submit">${label}</button></div></form>`;
  };

  r.get('/clients', async (req, res) => {
    const g = await gate(req);
    const q = String(req.query.q || '').trim().slice(0, 100);
    const rows = (await pool.query(`select p.* from parties p where 'client' = any(p.roles) and p.archived_at is null ${q ? 'and (p.name ilike $1 or coalesce(p.contact_person,\'\') ilike $1 or coalesce(p.email,\'\') ilike $1)' : ''} order by p.name limit 500`, q ? [`%${q.replace(/[%_\\]/g, '\\$&')}%`] : [])).rows;
    for (const c of rows) {
      c.projects = await visibleProjects(req.user, c.id);
      if (g.seeFees) { c.outstanding = 0; c.overdue = 0; for (const w of c.projects) { const L = await F.ledger(w.id); c.outstanding += L.t.outstanding; c.overdue += L.t.overdueAmount; } }
    }
    res.send(shell(req, 'Clients', [['Clients']], html`
      <form class="filters" method="get"><input type="search" name="q" value="${q}" placeholder="Search clients" aria-label="Search clients"><button class="btn" type="submit">Search</button></form>
      ${rows.length ? html`<div class="table-wrap"><table><thead><tr><th>Client</th><th>Main contact</th><th>Telephone</th><th>Email</th><th class="n">Projects</th>${g.seeFees ? html`<th class="n">Fees outstanding</th>` : ''}</tr></thead><tbody>
        ${rows.map(c => html`<tr><td><a href="/clients/${c.id}"><b>${c.name}</b></a><div class="muted small">${c.kind === 'company' ? 'Company' : 'Individual'}</div></td><td>${c.contact_person || c.representative || '—'}</td><td>${c.phone || '—'}</td><td>${c.email || '—'}</td><td class="n">${c.projects.length}</td>
          ${g.seeFees ? html`<td class="n ${c.overdue ? 'err' : ''}">${fm(c.outstanding)}${c.overdue ? html`<div class="small">${fm(c.overdue)} overdue</div>` : ''}</td>` : ''}</tr>`)}</tbody></table></div>`
        : emptyState(q ? 'No clients match' : 'No clients yet', 'Add a client, then create client projects for them.')}`,
      g.canEdit ? html`<a class="btn accent" href="/clients/new">+ New client</a>` : null));
  });

  r.get('/clients/new', async (req, res) => {
    const g = await gate(req); if (!g.canEdit) throw new Forbidden('Your role cannot add clients.');
    res.send(shell(req, 'New client', [['Clients', '/clients'], ['New client']], form(req, {}, '/clients', 'Add client')));
  });
  r.post('/clients', async (req, res) => {
    const g = await gate(req); if (!g.canEdit) throw new Forbidden('Your role cannot add clients.');
    const v = readClient(req.body);
    const id = await core.inTx(async db => {
      const ex = (await db.query("select id from parties where lower(name) = lower($1) and 'client' = any(roles) and archived_at is null", [v.name])).rows[0];
      if (ex) throw bad('A client with this name already exists. Open it from the client list.');
      const cols = Object.keys(v);
      const id = (await db.query(`insert into parties (roles, created_by, ${cols.join(', ')}) values ('{client}', $1, ${cols.map((c, i) => `$${i + 2}`).join(',')}) returning id`, [req.user.id, ...cols.map(c => v[c])])).rows[0].id;
      await core.audit(db, { actor: req.user, action: 'client.created', entity: 'party', entityId: id, summary: `Client added: ${v.name}`, ip: req.ip });
      return id;
    });
    res.redirect(`/clients/${id}?msg=created`);
  });

  async function load(req) {
    if (!UUID.test(req.params.pid)) throw new NotFound();
    const c = (await pool.query("select * from parties where id = $1 and 'client' = any(roles)", [req.params.pid])).rows[0];
    if (!c) throw new NotFound();
    return c;
  }

  const backOf = b => typeof b === 'string' && /^\/w\/[0-9a-f-]{36}\/client$/i.test(b) ? b : null;   // return to the workspace after editing
  r.get('/clients/:pid', async (req, res) => {
    const g = await gate(req);
    const c = await load(req);
    const projects = await visibleProjects(req.user, c.id);
    const ids = projects.map(w => w.id);
    const agreements = ids.length ? (await pool.query('select a.*, w.name as ws_name from agreements a join workspaces w on w.id = a.workspace_id where a.workspace_id = any($1::uuid[]) and (a.party_id = $2 or w.party_id = $2) order by a.created_at desc', [ids, c.id])).rows : [];
    const log = (await pool.query(`select x.*, coalesce(nullif(u.name,''), u.email) as by, w.name as ws_name from party_correspondence x left join users u on u.id = x.created_by left join workspaces w on w.id = x.workspace_id
      where x.party_id = $1 and (x.workspace_id is null or x.workspace_id = any($2::uuid[])) order by x.occurred_on desc, x.created_at desc limit 100`, [c.id, ids])).rows;
    const fees = {};
    if (g.seeFees) for (const w of projects) fees[w.id] = (await F.ledger(w.id)).t;
    res.send(shell(req, c.name, [['Clients', '/clients'], [c.name]], html`
      <section class="panel"><div class="row-between"><h2 class="h">Profile</h2>${g.canEdit ? html`<a class="btn small primary" href="?edit=1#edit">Edit profile</a>` : ''}</div>
        <div class="profile-groups">
          <div><h3 class="h3">Client details</h3><dl class="details">${CLIENT_F.filter(([k]) => k !== 'name').map(([k, l]) => html`<div><dt>${l}</dt><dd class="pre-line">${k === 'kind' ? (c.kind === 'company' ? 'Company' : 'Individual') : c[k] || html`<span class="muted">—</span>`}</dd></div>`)}</dl></div>
          <div><h3 class="h3">Client's representative</h3>${c.signs_personally ? html`<p class="muted">The client signs personally (no representative).</p>`
            : html`<dl class="details">${REP_F.map(([k, l]) => html`<div><dt>${l}</dt><dd>${c[k] || html`<span class="muted">—</span>`}</dd></div>`)}</dl>`}</div>
          ${MORE_F.some(([k]) => c[k]) ? html`<div><h3 class="h3">Billing and other details</h3><dl class="details">${MORE_F.filter(([k]) => c[k]).map(([k, l]) => html`<div><dt>${l}</dt><dd class="pre-line">${c[k]}</dd></div>`)}</dl></div>` : ''}
        </div></section>
        <section class="panel"><h2 class="h">Projects</h2>
          ${projects.length ? html`<div class="table-wrap"><table><thead><tr><th>Project</th><th>Reference</th><th>Status</th>${g.seeFees ? html`<th class="n">Invoiced</th><th class="n">Outstanding</th>` : ''}</tr></thead><tbody>
            ${projects.map(w => html`<tr><td><a href="/w/${w.id}"><b>${w.name}</b></a>${w.location ? html`<div class="muted small">${w.location}</div>` : ''}</td><td class="mono">${w.ref}</td><td>${statusPill(w.status)}</td>
              ${g.seeFees ? html`<td class="n">${fm(fees[w.id].invoiced)}</td><td class="n ${fees[w.id].overdue.length ? 'err' : ''}">${fm(fees[w.id].outstanding)}</td>` : ''}</tr>`)}</tbody></table></div>`
            : html`<p class="muted">No client projects you can open.</p>`}
          <div class="actions">${g.canEdit ? html`<a class="btn" href="/s/cpm/new?client=${c.id}">+ New project for this client</a>` : ''}${g.seeFees && projects.length ? html`<a class="btn" href="/clients/${c.id}/statement">Statement across projects</a>` : ''}</div>
        </section>
      <section class="panel"><h2 class="h">Agreements</h2>
        ${agreements.length ? html`<ul class="rows">${agreements.map(x => html`<li><div class="grow"><a href="/w/${x.workspace_id}/agreements/${x.id}"><b>${x.title}</b></a><div class="muted small">${x.ref} · ${x.ws_name}</div></div>${pill(x.status, x.status === 'signed' ? 'ok' : x.status === 'cancelled' ? 'muted' : 'info')}</li>`)}</ul>` : html`<p class="muted">No agreements yet.</p>`}</section>
      <section class="panel"><h2 class="h">Correspondence</h2>
        ${log.length ? html`<ol class="feed">${log.map(x => html`<li><b>${KINDS[x.kind]} · ${fmtDate(x.occurred_on)}</b>${x.ws_name ? html` <span class="muted small">· ${x.ws_name}</span>` : ''}<div class="pre-line">${x.summary}</div><div class="muted small">${x.by || ''}</div></li>`)}</ol>` : html`<p class="muted">Nothing recorded yet.</p>`}
        <details class="inline-form"><summary>Record correspondence</summary><form method="post" action="/clients/${c.id}/correspondence" class="form-grid">${csrfField(req)}
          ${field({ name: 'kind', label: 'Type', options: Object.entries(KINDS) })}${field({ name: 'occurred_on', label: 'Date', type: 'date', required: true, value: new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bahrain' }) })}
          ${field({ name: 'workspace_id', label: 'Project', options: [['', 'General'], ...projects.map(w => [w.id, w.name])] })}
          ${field({ name: 'summary', label: 'Summary', type: 'textarea', required: true, full: true })}<div class="actions full"><button class="btn" type="submit">Save</button></div></form></details></section>
      ${g.canEdit ? html`<details class="panel inline-form" id="edit" ${req.query.edit ? raw('open') : ''}><summary><b>Edit profile</b></summary>${form(req, c, `/clients/${c.id}${backOf(req.query.back) ? `?back=${encodeURIComponent(backOf(req.query.back))}` : ''}`, 'Save profile')}</details>` : ''}`));
  });

  r.post('/clients/:pid', async (req, res) => {
    const g = await gate(req); if (!g.canEdit) throw new Forbidden('Your role cannot edit clients.');
    const c = await load(req);
    const v = readClient(req.body);
    if (!c.billing_name || v.billing_name === c.name) v.billing_name = v.name;   // keep following the client's name when renamed
    await core.inTx(async db => U.track(db, req.user, { label: `Edited client ${c.name}`, returnTo: `/clients/${c.id}`, targets: [['parties', c.id]] }, async () => {
      const cols = Object.keys(v);
      await db.query(`update parties set ${cols.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() where id = $1`, [c.id, ...cols.map(k => v[k])]);
      const changed = cols.filter(k => (c[k] || null) !== v[k]);
      await core.audit(db, { actor: req.user, action: 'client.updated', entity: 'party', entityId: c.id, summary: `Client updated: ${v.name}${changed.length ? ` (${changed.join(', ')})` : ''}`, before: Object.fromEntries(changed.map(k => [k, c[k]])), after: Object.fromEntries(changed.map(k => [k, v[k]])), ip: req.ip });
    }));
    res.redirect(backOf(req.query.back) ? `${backOf(req.query.back)}?msg=saved` : `/clients/${c.id}?msg=saved`);
  });

  r.post('/clients/:pid/correspondence', async (req, res) => {
    await gate(req);
    const c = await load(req);
    const summary = txt(req.body.summary, 4000); if (!summary) throw bad('Write a summary.');
    const on = /^\d{4}-\d{2}-\d{2}$/.test(req.body.occurred_on || '') ? req.body.occurred_on : null; if (!on) throw bad('Enter the date.');
    let ws = null;
    if (req.body.workspace_id) { const p = (await visibleProjects(req.user, c.id)).find(w => w.id === req.body.workspace_id); if (!p) throw bad('Choose one of this client\'s projects.'); ws = p.id; }
    await core.inTx(async db => {
      const id = (await db.query('insert into party_correspondence (party_id, workspace_id, kind, occurred_on, summary, created_by) values ($1,$2,$3,$4,$5,$6) returning id', [c.id, ws, KINDS[req.body.kind] ? req.body.kind : 'other', on, summary, req.user.id])).rows[0].id;
      await core.audit(db, { actor: req.user, workspaceId: ws, action: 'client.correspondence', entity: 'party', entityId: c.id, summary: `Correspondence with ${c.name} recorded`, after: { id }, ip: req.ip });
    });
    res.redirect(`/clients/${c.id}?msg=added`);
  });

  r.get('/clients/:pid/statement', async (req, res) => {
    const g = await gate(req); if (!g.seeFees) throw new NotFound();
    const c = await load(req);
    const projects = await visibleProjects(req.user, c.id);
    const per = F.period(req.query);
    const st = await F.statementRows(projects.map(w => w.id), per.from, per.to);
    res.send(shell(req, `${c.name} · statement`, [['Clients', '/clients'], [c.name, `/clients/${c.id}`], ['Statement']], html`
      <form class="filters" method="get"><label class="small">From <input type="date" name="from" value="${per.from || ''}"></label><label class="small">To <input type="date" name="to" value="${per.to || ''}"></label><button class="btn" type="submit">Apply</button></form>
      <section class="panel"><h2 class="h">Statement of account across ${projects.length} project(s) · ${per.label}</h2>${F.statementTable(st, true)}
        <p class="muted small">SarayDar management-fee documents only, for the projects you can open.</p></section>`));
  });
}

module.exports = { mountClients };
