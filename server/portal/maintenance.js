'use strict';
// Maintenance requests (with owner spending limits, emergency rules, responsibility and verification),
// property expenses (approval separate from payment; shared costs split across units, never charged in full
// to each unit) and recurring cleaning / service schedules.
const multer = require('multer');
const { html, raw, pill, csrfField, field, emptyState, fmtDate, fmtDateTime } = require('./views');
const { parseMoney, formatMoney, toInput } = require('../lib/money');
const uploads = require('../lib/uploads');
const billing = require('../lib/billing');
const { sniff } = require('./workspaces');

const UUID = /^[0-9a-f-]{36}$/i;
const bad = m => Object.assign(new Error(m), { status: 400 });
const txt = (v, n = 300) => { const s = String(v ?? '').trim().slice(0, n); return s || null; };
const dateOrNull = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : null;
const todayBH = billing.todayBH;
const fm = (m, c = 'BHD') => m === null || m === undefined ? '—' : formatMoney(Number(m), c);
const upload = require('./choices').withChoices(multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 12, fields: 40 } }));

const M_STATUS = { open: 'Open', assigned: 'Assigned', awaiting_approval: 'Awaiting owner approval', approved: 'Approved', in_progress: 'In progress', completed: 'Completed — to verify', verified: 'Verified', closed: 'Closed', cancelled: 'Cancelled', rejected: 'Rejected by owner' };
const M_TONE = { open: 'warn', assigned: 'warn', awaiting_approval: 'warn', approved: 'info', in_progress: 'info', completed: 'info', verified: 'ok', closed: 'ok', cancelled: 'muted', rejected: 'muted' };
const APPROVAL = { none: 'Not approved yet', within_limit: 'Approved within the owner\'s limit', owner_approved: 'Approved by the owner', emergency: 'Emergency — done without prior approval', owner_rejected: 'Rejected by the owner' };
const RESP = { undecided: 'Not decided', owner: 'Owner', tenant: 'Tenant', saraydar: 'SarayDar', other: 'Other party' };
const PAID_BY = { saraydar_held_funds: 'SarayDar from funds held for the owner', owner_direct: 'Owner directly', tenant: 'Tenant', saraydar_own: 'SarayDar (own cost)', other: 'Other' };
const TAGS = { before: 'Before', after: 'After', quotation: 'Quotation', invoice: 'Invoice', completion: 'Completion evidence', warranty: 'Warranty', other: 'Other' };
const KIND = { reactive: 'Repair', preventive: 'Preventive', inspection: 'Inspection', warranty: 'Warranty claim' };
const FREQ = { weekly: 'Weekly', fortnightly: 'Every two weeks', monthly: 'Monthly', quarterly: 'Quarterly' };

function mountMaintenance(r, ctx) {
  const { pool, core, NotFound, Forbidden } = ctx;
  const PR = ctx.PR;
  const page = (req, a, tab, body, crumb) => PR.page(req, a, tab, body, crumb);
  const unitOpts = async wsId => [['', 'Common area / whole building'], ...(await PR.unitsOf(wsId)).map(u => [u.id, u.ref])];

  // ---------- maintenance ----------
  r.get('/w/:id/maintenance', async (req, res) => {
    const a = await PR.access(req);
    const show = ['open', 'all', 'done'].includes(req.query.show) ? req.query.show : 'open';
    const rows = (await pool.query(`select m.*, u.ref as unit_ref from maint_requests m left join units u on u.id = m.unit_id where m.workspace_id = $1
      ${show === 'open' ? "and m.status not in ('verified','closed','cancelled','rejected')" : show === 'done' ? "and m.status in ('verified','closed','cancelled','rejected')" : ''} order by (m.priority = 'emergency') desc, m.reported_on desc limit 300`, [a.ws.id])).rows;
    const p = await PR.profileOf(a.ws.id);
    const today = todayBH();
    res.send(page(req, a, 'Maintenance', html`
      <p class="muted small">Owner's limit per job without prior approval: <b>${p.maintenance_limit_minor === null || p.maintenance_limit_minor === undefined ? 'none — every job needs approval' : fm(p.maintenance_limit_minor)}</b>${p.emergency_allowed ? html` · emergencies up to <b>${fm(p.emergency_limit_minor)}</b> with justification` : ''}. Change under <a href="/w/${a.ws.id}/property">Property Setup</a>.</p>
      <section class="panel"><div class="row-between"><h2 class="h">Requests</h2><div class="actions">${[['open', 'Open'], ['done', 'Finished'], ['all', 'All']].map(([k, l]) => html`<a class="btn small ${k === show ? 'primary' : ''}" href="?show=${k}">${l}</a>`)}</div></div>
        ${rows.length ? html`<div class="table-wrap"><table><thead><tr><th>Request</th><th>Where</th><th>Priority</th><th>Reported</th><th>Provider</th><th>Target</th>${a.finance ? html`<th class="n">Estimate</th>` : ''}<th>Status</th></tr></thead><tbody>
          ${rows.map(m => html`<tr><td><a href="/w/${a.ws.id}/maintenance/${m.id}"><b>${m.ref}</b></a><div class="small">${m.title}</div><div class="muted small">${KIND[m.kind]} · ${m.category}</div></td><td>${m.unit_ref || html`<span class="muted">Common: ${m.location || 'building'}</span>`}</td>
            <td>${m.priority === 'emergency' ? pill('Emergency', 'bad') : m.priority === 'high' ? pill('High', 'warn') : m.priority[0].toUpperCase() + m.priority.slice(1)}</td><td class="small">${fmtDate(m.reported_on)}<div class="muted">${m.reported_by || ''}</div></td>
            <td class="small">${m.provider || '—'}</td><td class="small ${m.target_date && String(m.target_date) < today && !['verified', 'closed', 'cancelled'].includes(m.status) ? 'err' : ''}">${fmtDate(m.target_date) || '—'}</td>
            ${a.finance ? html`<td class="n">${fm(m.estimate_minor)}</td>` : ''}<td>${pill(M_STATUS[m.status], M_TONE[m.status])}</td></tr>`)}</tbody></table></div>` : html`<p class="muted">Nothing here.</p>`}
      </section>
      ${core.canContribute(a) ? html`<section class="panel"><h2 class="h">New request</h2><form method="post" action="/w/${a.ws.id}/maintenance" enctype="multipart/form-data" class="form-grid"><input type="hidden" name="_csrf" value="${req.csrfToken}">
        ${field({ name: 'unit_id', label: 'Unit', options: await unitOpts(a.ws.id), value: UUID.test(req.query.unit || '') ? req.query.unit : '' })}${field({ name: 'location', label: 'Location (for common areas)', hint: 'For example lobby, roof, car park.' })}
        ${field({ name: 'title', label: 'Issue', required: true })}${field({ name: 'category', label: 'Category', required: true, hint: 'For example plumbing, electrical, AC, painting.' })}
        ${field({ name: 'kind', label: 'Type', options: Object.entries(KIND) })}${field({ name: 'priority', label: 'Priority', value: 'normal', options: [['low', 'Low'], ['normal', 'Normal'], ['high', 'High'], ['emergency', 'Emergency']] })}
        ${field({ name: 'reported_on', label: 'Reported on', type: 'date', required: true, value: todayBH() })}${field({ name: 'reported_by', label: 'Reported by', hint: 'Tenant, owner (outside the portal), staff…' })}
        ${field({ name: 'description', label: 'Description', type: 'textarea', full: true })}
        <label class="field full"><span>“Before” photos and files</span><input type="file" name="files" multiple accept="image/*,application/pdf"></label>
        <div class="actions full"><button class="btn primary" type="submit">Record request</button></div></form></section>` : ''}`));
  });

  // publish a request (title, status, dates and photos — not costs) to owner viewers of this property
  r.post('/w/:id/maintenance/:mid/owner-visible', async (req, res) => {
    const a = await PR.access(req, 'edit');
    const m = await PR.own('maint_requests', req.params.mid, a.ws.id);
    const on = req.body.on === '1';
    await core.inTx(async db => {
      await db.query('update maint_requests set owner_visible = $2, updated_at = now() where id = $1', [m.id, on]);
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: on ? 'maint.published' : 'maint.unpublished', entity: 'maint_request', entityId: m.id, summary: `${m.ref} ${on ? 'shown to' : 'hidden from'} the owner portal`, ip: req.ip });
    });
    res.redirect(`/w/${a.ws.id}/maintenance/${m.id}?msg=saved`);
  });

  r.post('/w/:id/maintenance', upload.array('files', 12), async (req, res) => {
    if (!core.checkCsrf(req)) throw new Forbidden('Your form expired. Reload the page and try again.');
    const a = await PR.access(req, 'contribute');
    const b = req.body;
    const unit = b.unit_id ? await PR.own('units', b.unit_id, a.ws.id) : null;
    const title = txt(b.title, 200), category = txt(b.category, 60);
    if (!title || !category) throw bad('Enter the issue and the category.');
    const on = dateOrNull(b.reported_on); if (!on) throw bad('Enter the reported date.');
    const files = await uploads.prepare(req.files, sniff);
    const id = await core.inTx(async db => {
      const y = on.slice(0, 4);
      const ref = `MR-${y}-${String(await core.nextNumber(db, `MR-${y}`)).padStart(4, '0')}`;
      const id = (await db.query(`insert into maint_requests (workspace_id, unit_id, location, ref, kind, category, title, description, priority, reported_on, reported_by, created_by)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`, [a.ws.id, unit && unit.id, txt(b.location, 120), ref, KIND[b.kind] ? b.kind : 'reactive', category, title, txt(b.description, 4000),
        ['low', 'normal', 'high', 'emergency'].includes(b.priority) ? b.priority : 'normal', on, txt(b.reported_by, 120), req.user.id])).rows[0].id;
      await uploads.insert(db, { workspaceId: a.ws.id, entity: 'maint_request', entityId: id, files, userId: req.user.id, tag: 'before', observedOn: on });
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'maint.reported', entity: 'maint_request', entityId: id, summary: `Maintenance ${ref}: ${title}${unit ? ` (unit ${unit.ref})` : ' (common area)'}`, ip: req.ip });
      await PR.touch(db, a.ws.id);
      return id;
    });
    res.redirect(`/w/${a.ws.id}/maintenance/${id}?msg=created`);
  });

  r.get('/w/:id/maintenance/:mid', async (req, res) => {
    const a = await PR.access(req);
    const m = await PR.own('maint_requests', req.params.mid, a.ws.id);
    const unit = m.unit_id ? (await pool.query('select ref from units where id = $1', [m.unit_id])).rows[0] : null;
    const files = await uploads.list(pool, a.ws.id, 'maint_request', [m.id]);
    const p = await PR.profileOf(a.ws.id);
    const exps = a.finance ? (await pool.query('select * from prop_expenses where maint_id = $1 order by incurred_on', [m.id])).rows : [];
    const log = (await pool.query("select at, summary, actor_label from audit_events where workspace_id = $1 and entity = 'maint_request' and entity_id = $2 order by id", [a.ws.id, m.id])).rows;
    const edit = core.canEdit(a), contrib = core.canContribute(a);
    const id = a.ws.id;
    const limit = p.maintenance_limit_minor === null || p.maintenance_limit_minor === undefined ? null : Number(p.maintenance_limit_minor);
    const est = m.estimate_minor === null ? null : Number(m.estimate_minor);
    const withinLimit = est !== null && limit !== null && est <= limit;
    const emergencyOk = m.priority === 'emergency' && p.emergency_allowed && est !== null && est <= Number(p.emergency_limit_minor || 0);
    const approved = ['within_limit', 'owner_approved', 'emergency'].includes(m.approval);
    const finished = ['verified', 'closed', 'cancelled', 'rejected'].includes(m.status);
    const spent = exps.filter(e => e.status !== 'rejected').reduce((s, e) => s + Number(e.amount_minor), 0);
    const byTag = Object.entries(TAGS).map(([k, l]) => [l, files.filter(f => (f.tag || 'other') === k)]).filter(x => x[1].length);
    res.send(page(req, a, 'Maintenance', html`<p><a href="/w/${id}/maintenance">‹ Maintenance</a></p>
      <div class="split"><section class="panel grow2"><h2 class="h">${m.ref} · ${m.title} ${pill(M_STATUS[m.status], M_TONE[m.status])}</h2>
        <dl class="details"><div><dt>Where</dt><dd>${unit ? `Unit ${unit.ref}` : `Common area${m.location ? `: ${m.location}` : ''}`}</dd></div><div><dt>Type / category</dt><dd>${KIND[m.kind]} · ${m.category}</dd></div>
          <div><dt>Priority</dt><dd>${m.priority}</dd></div><div><dt>Reported</dt><dd>${fmtDate(m.reported_on)}${m.reported_by ? ` by ${m.reported_by}` : ''}</dd></div>
          <div><dt>Description</dt><dd class="pre-line">${m.description || '—'}</dd></div><div><dt>Provider</dt><dd>${m.provider || '—'}</dd></div><div><dt>Target date</dt><dd>${fmtDate(m.target_date) || '—'}</dd></div>
          ${a.finance ? html`<div><dt>Estimate</dt><dd>${fm(est)}${est !== null && limit !== null ? html` <span class="muted small">(limit ${fm(limit)})</span>` : ''}</dd></div><div><dt>Costs recorded</dt><dd>${fm(spent)}${est !== null && spent > est ? html` <span class="warn-text small">above the approved estimate</span>` : ''}</dd></div>` : ''}
          <div><dt>Approval</dt><dd>${APPROVAL[m.approval]}${m.approval_ref ? ` · ${m.approval_ref}` : ''}${m.approval_note ? html`<div class="muted small">${m.approval_note}</div>` : ''}</dd></div>
          <div><dt>Cost responsibility</dt><dd>${RESP[m.responsible]}${m.responsibility_note ? html`<div class="muted small">${m.responsibility_note}</div>` : ''}</dd></div>
          <div><dt>Started / completed / verified</dt><dd>${fmtDate(m.started_on) || '—'} / ${fmtDate(m.completed_on) || '—'} / ${fmtDate(m.verified_on) || '—'}</dd></div>
          ${m.warranty_until ? html`<div><dt>Warranty until</dt><dd>${fmtDate(m.warranty_until)}</dd></div>` : ''}</dl>
        ${byTag.map(([l, fs]) => html`<h3 class="h3">${l}</h3><div class="gallery">${fs.map(f => f.has_thumb ? html`<a href="/files/${f.id}"><img src="/files/${f.id}/thumb" alt="${l}: ${f.original_name}" loading="lazy"></a>` : html`<a class="small" href="/files/${f.id}">${f.original_name}</a>`)}</div>`)}
        ${contrib && !finished ? html`<details class="inline-form"><summary>Add photos or documents</summary><form method="post" action="/w/${id}/maintenance/${m.id}/files" enctype="multipart/form-data" class="form-grid"><input type="hidden" name="_csrf" value="${req.csrfToken}">
          ${field({ name: 'tag', label: 'What they show', options: Object.entries(TAGS) })}<label class="field"><span>Files</span><input type="file" name="files" multiple required></label><div class="actions full"><button class="btn" type="submit">Upload</button></div></form></details>` : ''}
      </section>
      <section class="panel grow1"><h2 class="h">Next steps</h2>
        ${edit ? html`<form method="post" action="/w/${id}/maintenance/${m.id}/owner-visible" class="actions">${csrfField(req)}<input type="hidden" name="on" value="${m.owner_visible ? '0' : '1'}">
          ${m.owner_visible ? pill('Shown to the owner in the portal', 'ok') : pill('Not shown to the owner', 'muted')}<button class="btn small" type="submit">${m.owner_visible ? 'Hide from owner' : 'Show to owner'}</button></form>` : ''}
        ${edit && !finished ? html`
          ${!approved ? html`<details class="inline-form" open><summary>Provider and estimate</summary><form method="post" action="/w/${id}/maintenance/${m.id}/assign" class="form-grid">${csrfField(req)}
            ${field({ name: 'provider', label: 'Provider', value: m.provider || '' })}${field({ name: 'target_date', label: 'Target date', type: 'date', value: m.target_date ? String(m.target_date) : '' })}
            ${a.finance ? field({ name: 'estimate', label: 'Estimated cost (BHD)', value: est === null ? '' : toInput(est), hint: 'From the quotation. Upload it above.' }) : ''}
            <div class="actions full"><button class="btn" type="submit">Save</button></div></form></details>` : ''}
          ${!approved && est !== null && a.finance ? html`<div class="panel-inner"><h3 class="h3">Approval</h3>
            ${withinLimit ? html`<form method="post" action="/w/${id}/maintenance/${m.id}/approve" class="actions">${csrfField(req)}<input type="hidden" name="mode" value="within_limit"><button class="btn primary" type="submit">Approve within the owner's limit</button></form>` : html`<p class="small">Above the owner's limit — record the owner's approval.</p>`}
            <form method="post" action="/w/${id}/maintenance/${m.id}/approve" class="form-grid">${csrfField(req)}<input type="hidden" name="mode" value="owner">
              ${field({ name: 'decision', label: 'Owner decision', options: [['approved', 'Approved'], ['rejected', 'Rejected']] })}${field({ name: 'approval_ref', label: 'How / reference', required: true, hint: 'For example email of 3 Nov, signed quotation.' })}
              ${field({ name: 'note', label: 'Note' })}<div class="actions full"><button class="btn" type="submit">Record owner decision</button></div></form>
            ${emergencyOk ? html`<form method="post" action="/w/${id}/maintenance/${m.id}/approve" class="form-grid">${csrfField(req)}<input type="hidden" name="mode" value="emergency">
              ${field({ name: 'note', label: 'Emergency justification', required: true, full: true })}<div class="actions full"><button class="btn" type="submit">Proceed as emergency</button></div></form>` : ''}</div>` : ''}
          ${approved && ['approved', 'assigned', 'open'].includes(m.status) ? html`<form method="post" action="/w/${id}/maintenance/${m.id}/step" class="actions">${csrfField(req)}<input type="hidden" name="to" value="in_progress"><button class="btn" type="submit">Work started</button></form>` : ''}
          ${['in_progress', 'approved'].includes(m.status) ? html`<details class="inline-form"><summary>Work completed</summary><form method="post" action="/w/${id}/maintenance/${m.id}/complete" enctype="multipart/form-data" class="form-grid"><input type="hidden" name="_csrf" value="${req.csrfToken}">
            ${field({ name: 'completed_on', label: 'Completed on', type: 'date', required: true, value: todayBH() })}${field({ name: 'warranty_until', label: 'Warranty until', type: 'date' })}
            <label class="field full"><span>“After” photos / completion evidence</span><input type="file" name="files" multiple accept="image/*,application/pdf"></label>
            ${field({ name: 'note', label: 'Note', full: true })}<div class="actions full"><button class="btn" type="submit">Mark completed</button></div></form></details>` : ''}
          ${m.status === 'completed' ? html`<form method="post" action="/w/${id}/maintenance/${m.id}/step" class="actions">${csrfField(req)}<input type="hidden" name="to" value="verified"><button class="btn primary" type="submit">Verify completion</button><span class="muted small">Check the work and the “after” photos first.</span></form>` : ''}
          <details class="inline-form"><summary>Who pays</summary><form method="post" action="/w/${id}/maintenance/${m.id}/responsibility" class="form-grid">${csrfField(req)}
            ${field({ name: 'responsible', label: 'Cost responsibility', value: m.responsible, options: Object.entries(RESP) })}${field({ name: 'note', label: 'Basis (agreement clause, decision)', value: m.responsibility_note || '', required: true })}
            <div class="actions full"><button class="btn" type="submit">Save</button></div><p class="muted small full">Not every repair is chargeable to the tenant — record the basis.</p></form></details>
          <form method="post" action="/w/${id}/maintenance/${m.id}/step" class="actions">${csrfField(req)}<input type="hidden" name="to" value="cancelled"><input name="note" placeholder="Reason" aria-label="Reason" required><button class="btn small" type="submit">Cancel request</button></form>` : ''}
        ${edit && m.status === 'verified' ? html`<form method="post" action="/w/${id}/maintenance/${m.id}/step" class="actions">${csrfField(req)}<input type="hidden" name="to" value="closed"><button class="btn" type="submit">Close</button></form>` : ''}
        ${a.finance ? html`<h3 class="h3">Costs</h3>${exps.length ? html`<ul class="rows">${exps.map(e => html`<li><div class="grow"><a href="/w/${id}/expenses/${e.id}">${e.supplier} ${e.invoice_no || ''}</a><div class="muted small">${fmtDate(e.incurred_on)} · ${e.status} · ${e.pay_status}</div></div><b>${fm(e.amount_minor)}</b></li>`)}</ul>` : html`<p class="muted small">No costs recorded.</p>`}
          ${edit ? html`<a class="btn small" href="/w/${id}/expenses?maint=${m.id}">+ Record cost / invoice</a>` : ''}` : ''}
        <h3 class="h3">History</h3><ol class="feed">${log.map(e => html`<li>${e.summary}<div class="muted small">${e.actor_label || ''} · ${fmtDateTime(e.at)}</div></li>`)}</ol>
      </section></div>`, m.ref));
  });

  const mAct = (path, fn, need = 'edit', multipart = false) => r.post(`/w/:id/maintenance/:mid/${path}`, ...(multipart ? [upload.array('files', 12)] : []), async (req, res) => {
    if (multipart && !core.checkCsrf(req)) throw new Forbidden('Your form expired. Reload the page and try again.');
    const a = await PR.access(req, need);
    const m = await PR.own('maint_requests', req.params.mid, a.ws.id);
    const files = multipart ? await uploads.prepare(req.files, sniff) : [];
    await core.inTx(async db => { await db.query('select id from maint_requests where id = $1 for update', [m.id]); await fn(db, a, m, req, files); await db.query('update maint_requests set updated_at = now() where id = $1', [m.id]); await PR.touch(db, a.ws.id); });
    res.redirect(`/w/${a.ws.id}/maintenance/${m.id}?msg=saved`);
  });
  const audit = (db, a, m, req, action, summary) => core.audit(db, { actor: req.user, workspaceId: a.ws.id, action, entity: 'maint_request', entityId: m.id, summary: `${m.ref}: ${summary}`, ip: req.ip });

  mAct('files', async (db, a, m, req, files) => {
    if (!files.length) throw bad('Choose files to upload.');
    const tag = TAGS[req.body.tag] ? req.body.tag : 'other';
    await uploads.insert(db, { workspaceId: a.ws.id, entity: 'maint_request', entityId: m.id, files, userId: req.user.id, tag, observedOn: todayBH() });
    await audit(db, a, m, req, 'maint.files', `${files.length} ${TAGS[tag].toLowerCase()} file(s) added`);
  }, 'contribute', true);
  mAct('assign', async (db, a, m, req) => {
    if (['within_limit', 'owner_approved', 'emergency'].includes(m.approval)) throw bad('Already approved: changes to the estimate need a new request.');
    const est = a.finance && String(req.body.estimate ?? '').trim() !== '' ? parseMoney(req.body.estimate, 'BHD') : (a.finance ? null : m.estimate_minor);
    if (est !== null && est < 0) throw bad('Check the estimate.');
    await db.query("update maint_requests set provider = $2, target_date = $3, estimate_minor = $4, status = case when status = 'open' and $2::text is not null then 'assigned' else status end where id = $1", [m.id, txt(req.body.provider, 160), dateOrNull(req.body.target_date), est]);
    await audit(db, a, m, req, 'maint.assigned', `provider ${txt(req.body.provider, 160) || '—'}, target ${dateOrNull(req.body.target_date) || '—'}${a.finance ? `, estimate ${est === null ? '—' : formatMoney(Number(est))}` : ''}`);
  });
  mAct('approve', async (db, a, m, req) => {
    if (!a.finance) throw new NotFound();
    if (['within_limit', 'owner_approved', 'emergency'].includes(m.approval)) throw bad('Already approved.');
    const p = await PR.profileOf(a.ws.id, db);
    const est = m.estimate_minor === null ? null : Number(m.estimate_minor);
    if (est === null) throw bad('Enter the estimated cost first.');
    const mode = req.body.mode;
    if (mode === 'within_limit') {
      const limit = p.maintenance_limit_minor === null || p.maintenance_limit_minor === undefined ? null : Number(p.maintenance_limit_minor);
      if (limit === null || est > limit) throw bad(`This is above the owner's limit${limit === null ? '' : ` of ${formatMoney(limit)}`}; record the owner's approval.`);
      await db.query("update maint_requests set approval = 'within_limit', approved_by = $2, approved_at = now(), approval_note = $3, status = 'approved' where id = $1", [m.id, req.user.id, `Within the owner's limit of ${formatMoney(limit)}`]);
      await audit(db, a, m, req, 'maint.approved', `approved within the owner's limit (${formatMoney(est)} ≤ ${formatMoney(limit)})`);
    } else if (mode === 'owner') {
      const ref = txt(req.body.approval_ref, 160); if (!ref) throw bad('Record how the owner decided.');
      const ok = req.body.decision === 'approved';
      await db.query('update maint_requests set approval = $2, approval_ref = $3, approval_note = $4, approved_by = $5, approved_at = now(), status = $6 where id = $1', [m.id, ok ? 'owner_approved' : 'owner_rejected', ref, txt(req.body.note, 500), req.user.id, ok ? 'approved' : 'rejected']);
      await audit(db, a, m, req, ok ? 'maint.owner_approved' : 'maint.owner_rejected', `owner ${ok ? 'approved' : 'rejected'} ${formatMoney(est)} — ${ref}`);
    } else if (mode === 'emergency') {
      const note = txt(req.body.note, 1000); if (!note) throw bad('Give the emergency justification.');
      if (m.priority !== 'emergency') throw bad('Only emergency-priority requests can use the emergency rule.');
      if (!p.emergency_allowed) throw bad('Emergency work without prior approval is not allowed for this property.');
      if (est > Number(p.emergency_limit_minor || 0)) throw bad(`Above the emergency limit of ${formatMoney(Number(p.emergency_limit_minor || 0))}: the owner must approve.`);
      await db.query("update maint_requests set approval = 'emergency', approval_note = $2, approved_by = $3, approved_at = now(), status = 'approved' where id = $1", [m.id, note, req.user.id]);
      await audit(db, a, m, req, 'maint.emergency', `EMERGENCY — proceeding without prior owner approval (${formatMoney(est)}): ${note}`);
    } else throw bad('Unknown approval.');
  });
  mAct('step', async (db, a, m, req) => {
    const to = req.body.to;
    const ok = { in_progress: ['approved', 'assigned', 'open'], verified: ['completed'], closed: ['verified'], cancelled: ['open', 'assigned', 'awaiting_approval', 'approved', 'in_progress'] }[to];
    if (!ok || !ok.includes(m.status)) throw bad('That step is not possible now.');
    if (to === 'in_progress' && !['within_limit', 'owner_approved', 'emergency'].includes(m.approval)) throw bad('Approve the work before it starts.');
    if (to === 'cancelled' && !txt(req.body.note, 300)) throw bad('Give a reason.');
    if (to === 'verified') await db.query("update maint_requests set status = 'verified', verified_by = $2, verified_on = $3 where id = $1", [m.id, req.user.id, todayBH()]);
    else await db.query(`update maint_requests set status = $2${to === 'in_progress' ? ', started_on = coalesce(started_on, $3)' : ''} where id = $1`, to === 'in_progress' ? [m.id, to, todayBH()] : [m.id, to]);
    await audit(db, a, m, req, `maint.${to}`, `${M_STATUS[to]}${req.body.note ? ` — ${txt(req.body.note, 300)}` : ''}`);
  });
  mAct('complete', async (db, a, m, req, files) => {
    if (!['in_progress', 'approved'].includes(m.status)) throw bad('Start the work first.');
    const on = dateOrNull(req.body.completed_on); if (!on) throw bad('Enter the completion date.');
    await db.query("update maint_requests set status = 'completed', completed_on = $2, warranty_until = $3, notes = concat_ws(' · ', notes, $4::text) where id = $1", [m.id, on, dateOrNull(req.body.warranty_until), txt(req.body.note, 1000)]);
    await uploads.insert(db, { workspaceId: a.ws.id, entity: 'maint_request', entityId: m.id, files, userId: req.user.id, tag: 'after', observedOn: on });
    await audit(db, a, m, req, 'maint.completed', `completed on ${on}${files.length ? ` with ${files.length} “after” file(s)` : ''}; awaiting verification`);
  }, 'contribute', true);
  mAct('responsibility', async (db, a, m, req) => {
    const who = RESP[req.body.responsible] ? req.body.responsible : null; const note = txt(req.body.note, 500);
    if (!who || !note) throw bad('Choose who pays and record the basis.');
    await db.query('update maint_requests set responsible = $2, responsibility_note = $3 where id = $1', [m.id, who, note]);
    await audit(db, a, m, req, 'maint.responsibility', `cost responsibility: ${RESP[who]} — ${note}`);
  });

  // ---------- expenses ----------
  async function allocate(db, e, wsId) {
    await db.query('delete from expense_allocations where expense_id = $1', [e.id]);
    if (e.unit_id) { await db.query("insert into expense_allocations (expense_id, unit_id, amount_minor, basis) values ($1,$2,$3,'direct')", [e.id, e.unit_id, e.amount_minor]); return; }
    if (e.allocation === 'none') return;
    const units = (await db.query('select id, ref, area_m2 from units where workspace_id = $1 and archived_at is null order by sort, ref', [wsId])).rows;
    if (!units.length) throw bad('There are no units to share this cost across.');
    const total = Number(e.amount_minor);
    let weights;
    if (e.allocation === 'area') {
      const missing = units.filter(u => u.area_m2 === null).map(u => u.ref);
      if (missing.length) throw bad(`Cannot split by area: no area recorded for ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''}.`);
      weights = units.map(u => Math.round(Number(u.area_m2) * 100));
    } else weights = units.map(() => 1);
    const W = weights.reduce((s, w) => s + w, 0);
    // largest-remainder split: shares are whole fils and add up exactly to the expense
    const raw = weights.map(w => BigInt(total) * BigInt(w));
    let shares = raw.map(x => Number(x / BigInt(W)));
    let rest = total - shares.reduce((s, x) => s + x, 0);
    const order = raw.map((x, i) => [Number(x % BigInt(W)), i]).sort((p, q) => q[0] - p[0] || p[1] - q[1]);
    for (let k = 0; rest > 0; k++, rest--) shares[order[k % order.length][1]]++;
    const basis = e.allocation === 'area' ? 'area' : 'equal';
    for (let i = 0; i < units.length; i++) await db.query('insert into expense_allocations (expense_id, unit_id, amount_minor, basis) values ($1,$2,$3,$4)', [e.id, units[i].id, shares[i], `${basis}: ${e.allocation === 'area' ? `${Number(units[i].area_m2)} of ${W / 100} m²` : `1 of ${units.length} units`}`]);
  }

  r.get('/w/:id/expenses', async (req, res) => {
    const a = await PR.access(req, 'finance');
    const rows = (await pool.query(`select e.*, u.ref as unit_ref, m.ref as maint_ref from prop_expenses e left join units u on u.id = e.unit_id left join maint_requests m on m.id = e.maint_id
      where e.workspace_id = $1 order by e.incurred_on desc, e.created_at desc limit ${req.exportAll ? 5000 : 300}`, [a.ws.id])).rows;
    const p = await PR.profileOf(a.ws.id);
    const maint = UUID.test(req.query.maint || '') ? (await pool.query('select id, ref, title, unit_id, responsible from maint_requests where id = $1 and workspace_id = $2', [req.query.maint, a.ws.id])).rows[0] : null;
    const openMaint = (await pool.query("select id, ref, title from maint_requests where workspace_id = $1 and status not in ('cancelled','rejected') order by reported_on desc limit 100", [a.ws.id])).rows;
    const sum = k => rows.filter(k).reduce((s, e) => s + Number(e.amount_minor), 0);
    const edit = core.canEdit(a);
    res.send(page(req, a, 'Expenses', html`
      <section class="grid-cards"><div class="card"><div class="muted small">Approved, unpaid</div><div class="big">${fm(sum(e => e.status === 'approved' && e.pay_status !== 'paid'))}</div></div>
        <div class="card"><div class="muted small">Awaiting approval</div><div class="big">${fm(sum(e => e.status === 'submitted'))}</div></div>
        <div class="card"><div class="muted small">Paid (listed)</div><div class="big">${fm(sum(e => e.pay_status === 'paid'))}</div></div></section>
      <section class="panel"><h2 class="h">Property expenses</h2>
        ${rows.length ? html`<div class="table-wrap"><table><thead><tr><th>Incurred</th><th>Supplier / description</th><th>Unit or shared</th><th>Responsible / paid by</th><th class="n">Amount</th><th>Approval</th><th>Payment</th></tr></thead><tbody>
          ${rows.map(e => html`<tr><td class="small"><a href="/w/${a.ws.id}/expenses/${e.id}">${fmtDate(e.incurred_on)}</a></td><td>${e.supplier}${e.invoice_no ? ` · ${e.invoice_no}` : ''}<div class="muted small">${e.category} · ${e.description}${e.maint_ref ? ` · ${e.maint_ref}` : ''}</div></td>
            <td class="small">${e.unit_ref || (e.allocation === 'none' ? 'Building (not split)' : `Shared — split ${e.allocation === 'area' ? 'by area' : 'equally'}`)}</td><td class="small">${RESP[e.responsible]}<div class="muted">${PAID_BY[e.paid_by] || '—'}</div></td>
            <td class="n">${fm(e.amount_minor)}</td><td>${pill(e.status, e.status === 'approved' ? 'ok' : e.status === 'rejected' ? 'muted' : 'warn')}</td><td>${pill(e.pay_status, e.pay_status === 'paid' ? 'ok' : e.pay_status === 'reversed' ? 'muted' : 'warn')}</td></tr>`)}</tbody></table></div>` : html`<p class="muted">No expenses recorded.</p>`}
      </section>
      ${edit ? html`<section class="panel"><h2 class="h">Record an expense / supplier invoice</h2><form method="post" action="/w/${a.ws.id}/expenses" class="form-grid">${csrfField(req)}
        ${field({ name: 'unit_id', label: 'Unit', value: maint && maint.unit_id ? maint.unit_id : '', options: [['', 'Shared building cost'], ...(await PR.unitsOf(a.ws.id)).map(u => [u.id, u.ref])] })}
        ${field({ name: 'allocation', label: 'Shared cost: how to split across units', value: 'equal', options: [['equal', 'Equally per unit'], ['area', 'By unit area'], ['none', 'Do not split (building-level)']] })}
        ${field({ name: 'maint_id', label: 'Maintenance request', value: maint ? maint.id : '', options: [['', 'None'], ...openMaint.map(m => [m.id, `${m.ref} · ${m.title}`])] })}
        ${field({ name: 'category', label: 'Category', required: true })}${field({ name: 'description', label: 'Description', required: true, value: maint ? maint.title : '' })}
        ${field({ name: 'supplier', label: 'Supplier', required: true })}${field({ name: 'invoice_no', label: 'Invoice number' })}
        ${field({ name: 'incurred_on', label: 'Invoice / incurred date', type: 'date', required: true, value: todayBH() })}${field({ name: 'amount', label: 'Amount (BHD)', required: true })}
        ${field({ name: 'responsible', label: 'Cost responsibility', value: maint && maint.responsible !== 'undecided' ? maint.responsible : 'owner', options: Object.entries(RESP).filter(([k]) => k !== 'undecided') })}
        ${field({ name: 'paid_by', label: 'To be paid by', value: p.supplier_payer === 'owner' ? 'owner_direct' : 'saraydar_held_funds', options: Object.entries(PAID_BY) })}
        ${field({ name: 'notes', label: 'Notes', full: true })}<div class="actions full"><button class="btn primary" type="submit">Record for approval</button></div>
        <p class="muted small full">Recording → approval → payment confirmation are separate steps. Shared costs are split into unit shares when approved; no unit carries the whole shared cost.</p></form></section>` : ''}`));
  });

  r.post('/w/:id/expenses', async (req, res) => {
    const a = await PR.access(req, 'edit');
    if (!a.finance) throw new NotFound();
    const b = req.body;
    const unit = b.unit_id ? await PR.own('units', b.unit_id, a.ws.id) : null;
    const maint = b.maint_id ? await PR.own('maint_requests', b.maint_id, a.ws.id) : null;
    const v = { category: txt(b.category, 60), description: txt(b.description, 300), supplier: txt(b.supplier, 160) };
    if (!v.category || !v.description || !v.supplier) throw bad('Enter the category, description and supplier.');
    const on = dateOrNull(b.incurred_on); if (!on) throw bad('Enter the invoice date.');
    const amt = parseMoney(b.amount, 'BHD'); if (!amt || amt <= 0) throw bad('Enter the amount.');
    if (ctx.authority) await ctx.authority.checkLimit(req, 'expense', amt, 'This expense');   // authority matrix
    try {
      const id = await core.inTx(async db => {
        const id = (await db.query(`insert into prop_expenses (workspace_id, unit_id, maint_id, category, description, supplier, invoice_no, incurred_on, amount_minor, allocation, responsible, paid_by, notes, created_by)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id`, [a.ws.id, unit && unit.id, maint && maint.id, v.category, v.description, v.supplier, txt(b.invoice_no, 60), on, amt,
          unit ? 'unit' : (['equal', 'area', 'none'].includes(b.allocation) ? b.allocation : 'equal'), RESP[b.responsible] && b.responsible !== 'undecided' ? b.responsible : 'owner', PAID_BY[b.paid_by] ? b.paid_by : 'saraydar_held_funds', txt(b.notes, 500), req.user.id])).rows[0].id;
        await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'expense.recorded', entity: 'prop_expense', entityId: id, summary: `Expense recorded: ${v.supplier} ${formatMoney(amt)}${unit ? ` (unit ${unit.ref})` : ' (shared)'}`, ip: req.ip });
        await PR.touch(db, a.ws.id);
        return id;
      });
      res.redirect(`/w/${a.ws.id}/expenses/${id}?msg=created`);
    } catch (e) { if (e.code === '23505') throw bad('That supplier invoice number is already recorded for this property.'); throw e; }
  });

  r.get('/w/:id/expenses/:eid', async (req, res) => {
    const a = await PR.access(req, 'finance');
    const e = await PR.own('prop_expenses', req.params.eid, a.ws.id);
    const unit = e.unit_id ? (await pool.query('select ref from units where id = $1', [e.unit_id])).rows[0] : null;
    const maint = e.maint_id ? (await pool.query('select id, ref, title from maint_requests where id = $1', [e.maint_id])).rows[0] : null;
    const allocs = (await pool.query('select x.*, u.ref from expense_allocations x join units u on u.id = x.unit_id where x.expense_id = $1 order by u.sort, u.ref', [e.id])).rows;
    const files = await uploads.list(pool, a.ws.id, 'prop_expense', [e.id]);
    const id = a.ws.id;
    res.send(page(req, a, 'Expenses', html`<p><a href="/w/${id}/expenses">‹ Expenses</a></p>
      <section class="panel"><h2 class="h">${e.supplier}${e.invoice_no ? ` · ${e.invoice_no}` : ''} ${pill(e.status, e.status === 'approved' ? 'ok' : e.status === 'rejected' ? 'muted' : 'warn')} ${pill(`payment: ${e.pay_status}`, e.pay_status === 'paid' ? 'ok' : 'warn')}</h2>
        <dl class="details"><div><dt>Amount</dt><dd>${fm(e.amount_minor)}</dd></div><div><dt>Incurred</dt><dd>${fmtDate(e.incurred_on)}</dd></div><div><dt>Category / description</dt><dd>${e.category} · ${e.description}</dd></div>
          <div><dt>For</dt><dd>${unit ? `Unit ${unit.ref}` : e.allocation === 'none' ? 'Building (not split)' : `Shared — split ${e.allocation === 'area' ? 'by area' : 'equally'}`}${maint ? html` · <a href="/w/${id}/maintenance/${maint.id}">${maint.ref}</a>` : ''}</dd></div>
          <div><dt>Responsible</dt><dd>${RESP[e.responsible]}</dd></div><div><dt>Paid by</dt><dd>${PAID_BY[e.paid_by] || '—'}</dd></div>
          <div><dt>Payment</dt><dd>${e.pay_status === 'paid' ? `Paid ${fmtDate(e.paid_on)}${e.pay_reference ? ` · ${e.pay_reference}` : ''}` : e.pay_status}</dd></div>${e.notes ? html`<div><dt>Notes</dt><dd>${e.notes}</dd></div>` : ''}</dl>
        ${allocs.length ? html`<h3 class="h3">Unit shares</h3><div class="table-wrap"><table><thead><tr><th>Unit</th><th>Basis</th><th class="n">Share</th></tr></thead><tbody>${allocs.map(x => html`<tr><td>${x.ref}</td><td class="small">${x.basis}</td><td class="n">${fm(x.amount_minor)}</td></tr>`)}
          <tr class="total"><td>Total</td><td></td><td class="n">${fm(allocs.reduce((s, x) => s + Number(x.amount_minor), 0))}</td></tr></tbody></table></div>` : ''}
        ${files.length ? html`<h3 class="h3">Documents</h3><ul>${files.map(f => html`<li><a href="/files/${f.id}">${f.original_name}</a></li>`)}</ul>` : ''}
        <div class="actions">
          ${core.canEdit(a) && e.status === 'submitted' ? html`<form method="post" action="/w/${id}/expenses/${e.id}/decide" class="actions">${csrfField(req)}<button class="btn primary" name="decision" value="approved">Approve invoice</button><button class="btn" name="decision" value="rejected">Reject</button></form>` : ''}
          ${a.canPost && e.status === 'approved' && e.pay_status !== 'paid' ? html`<form method="post" action="/w/${id}/expenses/${e.id}/paid" class="actions">${csrfField(req)}<label class="small">Paid on <input type="date" name="paid_on" required value="${todayBH()}"></label><input name="pay_reference" placeholder="Reference" aria-label="Reference"><button class="btn" type="submit">Confirm payment</button></form>` : ''}
          ${a.canPost && e.pay_status === 'paid' ? html`<form method="post" action="/w/${id}/expenses/${e.id}/unpay" class="actions">${csrfField(req)}<input name="reason" placeholder="Reason" aria-label="Reason" required><button class="btn small" type="submit">Reverse payment</button></form>` : ''}</div>
        ${core.canContribute(a) ? html`<details class="inline-form"><summary>Attach invoice / quotation</summary><form method="post" action="/w/${id}/expenses/${e.id}/files" enctype="multipart/form-data" class="form-grid"><input type="hidden" name="_csrf" value="${req.csrfToken}">
          <label class="field"><span>Files</span><input type="file" name="files" multiple required></label><div class="actions full"><button class="btn" type="submit">Upload</button></div></form></details>` : ''}
      </section>`, e.supplier));
  });

  const eAct = (path, fn, need = 'edit', multipart = false) => r.post(`/w/:id/expenses/:eid/${path}`, ...(multipart ? [upload.array('files', 12)] : []), async (req, res) => {
    if (multipart && !core.checkCsrf(req)) throw new Forbidden('Your form expired. Reload the page and try again.');
    const a = await PR.access(req, need);
    if (!a.finance) throw new NotFound();
    const e = await PR.own('prop_expenses', req.params.eid, a.ws.id);
    const files = multipart ? await uploads.prepare(req.files, sniff) : [];
    await core.inTx(async db => { const cur = (await db.query('select * from prop_expenses where id = $1 for update', [e.id])).rows[0]; await fn(db, a, cur, req, files); await PR.touch(db, a.ws.id); });
    res.redirect(`/w/${a.ws.id}/expenses/${e.id}?msg=saved`);
  });
  const eAudit = (db, a, e, req, action, s) => core.audit(db, { actor: req.user, workspaceId: a.ws.id, action, entity: 'prop_expense', entityId: e.id, summary: `${e.supplier} ${formatMoney(Number(e.amount_minor))}: ${s}`, ip: req.ip });
  eAct('decide', async (db, a, e, req) => {
    if (e.status !== 'submitted') throw bad('Already decided.');
    const d = req.body.decision === 'approved' ? 'approved' : req.body.decision === 'rejected' ? 'rejected' : null; if (!d) throw bad('Choose approve or reject.');
    if (d === 'approved' && e.maint_id) {
      const m = (await db.query('select approval, ref from maint_requests where id = $1', [e.maint_id])).rows[0];
      if (!['within_limit', 'owner_approved', 'emergency'].includes(m.approval)) throw bad(`Maintenance ${m.ref} has not been approved; approve the work before its invoice.`);
    }
    await db.query('update prop_expenses set status = $2, approved_by = $3, approved_at = now() where id = $1', [e.id, d, req.user.id]);
    if (d === 'approved') await allocate(db, e, a.ws.id);
    await eAudit(db, a, e, req, `expense.${d}`, `invoice ${d}${d === 'approved' && !e.unit_id && e.allocation !== 'none' ? ` and split ${e.allocation === 'area' ? 'by area' : 'equally'} across units` : ''}`);
  });
  eAct('paid', async (db, a, e, req) => {
    if (!a.canPost) throw new Forbidden('Only Finance confirms payments.');
    if (e.status !== 'approved') throw bad('Approve the invoice before paying it.');
    if (e.pay_status === 'paid') throw bad('Already paid.');
    const on = dateOrNull(req.body.paid_on); if (!on) throw bad('Enter the payment date.');
    await db.query("update prop_expenses set pay_status = 'paid', paid_on = $2, pay_reference = $3, pay_confirmed_by = $4 where id = $1", [e.id, on, txt(req.body.pay_reference, 80), req.user.id]);
    await eAudit(db, a, e, req, 'expense.paid', `payment confirmed ${on} (${PAID_BY[e.paid_by] || ''})`);
  }, 'view');
  eAct('unpay', async (db, a, e, req) => {
    if (!a.canPost) throw new Forbidden('Only Finance can reverse payments.');
    const reason = txt(req.body.reason, 300); if (!reason) throw bad('Give a reason.');
    if (e.pay_status !== 'paid') throw bad('Not paid.');
    await db.query("update prop_expenses set pay_status = 'reversed', notes = concat_ws(' · ', notes, $2::text) where id = $1", [e.id, `Payment of ${e.paid_on} reversed: ${reason}`]);
    await eAudit(db, a, e, req, 'expense.payment_reversed', `payment reversed — ${reason}`);
  }, 'view');
  eAct('files', async (db, a, e, req, files) => {
    if (!files.length) throw bad('Choose files.');
    await uploads.insert(db, { workspaceId: a.ws.id, entity: 'prop_expense', entityId: e.id, files, userId: req.user.id, tag: 'invoice' });
    await eAudit(db, a, e, req, 'expense.files', `${files.length} document(s) attached`);
  }, 'contribute', true);

  // ---------- cleaning & services ----------
  r.get('/w/:id/services', async (req, res) => {
    const a = await PR.access(req);
    const today = todayBH();
    const sch = (await pool.query('select s.*, u.ref as unit_ref from service_schedules s left join units u on u.id = s.unit_id where s.workspace_id = $1 order by s.active desc, s.title', [a.ws.id])).rows;
    const tasks = (await pool.query(`select t.*, s.title, s.provider, s.checklist, s.location, u.ref as unit_ref from service_tasks t join service_schedules s on s.id = t.schedule_id left join units u on u.id = s.unit_id
      where t.workspace_id = $1 and (t.scheduled_on between $2::date - 14 and $2::date + 31 or (t.status = 'scheduled' and t.scheduled_on < $2)) order by t.scheduled_on, s.title limit 300`, [a.ws.id, today])).rows;
    const files = await uploads.list(pool, a.ws.id, 'service_task', tasks.map(t => t.id));
    const overdue = tasks.filter(t => t.status === 'scheduled' && String(t.scheduled_on) < today).length;
    const edit = core.canEdit(a), contrib = core.canContribute(a);
    res.send(page(req, a, 'Cleaning & Services', html`
      ${overdue ? html`<div class="notice warn">${overdue} service task(s) are overdue.</div>` : ''}
      <section class="panel"><h2 class="h">Tasks — last two weeks and next month</h2>
        ${tasks.length ? html`<div class="table-wrap"><table><thead><tr><th>Date</th><th>Service</th><th>Where</th><th>Provider</th><th>Status</th><th></th></tr></thead><tbody>
          ${tasks.map(t => { const od = t.status === 'scheduled' && String(t.scheduled_on) < today; const fs = files.filter(f => f.entity_id === t.id); return html`<tr><td class="small ${od ? 'err' : ''}">${fmtDate(t.scheduled_on)}</td><td>${t.title}${t.checklist ? html`<div class="muted small pre-line">${t.checklist}</div>` : ''}${t.notes ? html`<div class="small">${t.notes}</div>` : ''}${fs.length ? html`<div class="gallery">${fs.map(f => f.has_thumb ? html`<a href="/files/${f.id}"><img src="/files/${f.id}/thumb" alt="Service photo" loading="lazy"></a>` : '')}</div>` : ''}</td>
            <td class="small">${t.unit_ref || t.location || 'Common areas'}</td><td class="small">${t.provider || '—'}</td><td>${pill(od ? 'Overdue' : t.status, od ? 'bad' : t.status === 'reviewed' ? 'ok' : t.status === 'done' ? 'info' : t.status === 'scheduled' ? 'warn' : 'muted')}</td>
            <td>${contrib && t.status === 'scheduled' ? html`<details class="inline-form"><summary class="small">Record</summary><form method="post" action="/w/${a.ws.id}/services/tasks/${t.id}" enctype="multipart/form-data" class="form-grid"><input type="hidden" name="_csrf" value="${req.csrfToken}">
              ${field({ name: 'status', label: 'Result', options: [['done', 'Done'], ['missed', 'Missed'], ['cancelled', 'Cancelled']] })}${field({ name: 'completed_on', label: 'Date', type: 'date', value: today })}
              <label class="field"><span>Photos</span><input type="file" name="files" multiple accept="image/*"></label>${field({ name: 'notes', label: 'Notes', full: true })}<div class="actions full"><button class="btn small" type="submit">Save</button></div></form></details>` : ''}
              ${edit && t.status === 'done' ? html`<form method="post" action="/w/${a.ws.id}/services/tasks/${t.id}/review">${csrfField(req)}<button class="btn small" type="submit">Supervisor review</button></form>` : ''}</td></tr>`; })}</tbody></table></div>`
          : html`<p class="muted">No tasks in this window. Add a schedule below; tasks are created ahead automatically.</p>`}
      </section>
      <section class="panel"><h2 class="h">Schedules</h2>
        ${sch.length ? html`<ul class="rows">${sch.map(s => html`<li><div class="grow"><b>${s.title}</b> · ${FREQ[s.frequency]} from ${fmtDate(s.start_date)}<div class="muted small">${s.unit_ref ? `Unit ${s.unit_ref}` : s.location || 'Common areas'} · ${s.provider || 'no provider'}${a.finance && s.cost_minor !== null ? ` · ${formatMoney(Number(s.cost_minor))} per visit` : ''}</div></div>
          ${edit && s.active ? html`<form method="post" action="/w/${a.ws.id}/services/${s.id}/stop">${csrfField(req)}<button class="btn small" type="submit">Stop</button></form>` : s.active ? '' : pill('Stopped', 'muted')}</li>`)}</ul>` : html`<p class="muted">None yet.</p>`}
        ${edit ? html`<details class="inline-form"><summary>Add a schedule</summary><form method="post" action="/w/${a.ws.id}/services" class="form-grid">${csrfField(req)}
          ${field({ name: 'title', label: 'Service', required: true, hint: 'For example lobby cleaning, pest control, AC servicing.' })}${field({ name: 'frequency', label: 'Frequency', options: Object.entries(FREQ) })}
          ${field({ name: 'start_date', label: 'First date', type: 'date', required: true, value: today })}${field({ name: 'unit_id', label: 'Unit', options: await unitOpts(a.ws.id) })}${field({ name: 'location', label: 'Location (common areas)' })}
          ${field({ name: 'provider', label: 'Provider / staff' })}${a.finance ? field({ name: 'cost', label: 'Cost per visit (BHD)' }) : ''}${field({ name: 'checklist', label: 'Checklist (one per line)', type: 'textarea', full: true })}
          <div class="actions full"><button class="btn primary" type="submit">Add schedule</button></div><p class="muted small full">Tasks are generated for the next 60 days, once per date — retries never duplicate them. Costs are recorded as expenses when invoiced.</p></form></details>` : ''}
      </section>`));
  });

  r.post('/w/:id/services', async (req, res) => {
    const a = await PR.access(req, 'edit');
    const b = req.body;
    const title = txt(b.title, 160); if (!title) throw bad('Enter the service.');
    const start = dateOrNull(b.start_date); if (!start) throw bad('Enter the first date.');
    const unit = b.unit_id ? await PR.own('units', b.unit_id, a.ws.id) : null;
    await core.inTx(async db => {
      const id = (await db.query('insert into service_schedules (workspace_id, unit_id, location, title, provider, frequency, start_date, checklist, cost_minor, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id',
        [a.ws.id, unit && unit.id, txt(b.location, 120), title, txt(b.provider, 160), FREQ[b.frequency] ? b.frequency : 'weekly', start, txt(b.checklist, 2000), a.finance && String(b.cost || '').trim() ? parseMoney(b.cost, 'BHD') : null, req.user.id])).rows[0].id;
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'service.scheduled', entity: 'service_schedule', entityId: id, summary: `Service schedule: ${title} (${FREQ[b.frequency] || 'Weekly'})`, ip: req.ip });
    });
    await billing.generateServiceTasks(pool, {});
    res.redirect(`/w/${a.ws.id}/services?msg=added`);
  });
  r.post('/w/:id/services/:sid/stop', async (req, res) => {
    const a = await PR.access(req, 'edit');
    const s = await PR.own('service_schedules', req.params.sid, a.ws.id);
    await core.inTx(async db => {
      await db.query('update service_schedules set active = false where id = $1', [s.id]);
      await db.query("update service_tasks set status = 'cancelled' where schedule_id = $1 and status = 'scheduled' and scheduled_on > $2", [s.id, todayBH()]);
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'service.stopped', entity: 'service_schedule', entityId: s.id, summary: `Service schedule stopped: ${s.title}`, ip: req.ip });
    });
    res.redirect(`/w/${a.ws.id}/services?msg=saved`);
  });
  r.post('/w/:id/services/tasks/:tid', upload.array('files', 12), async (req, res) => {
    if (!core.checkCsrf(req)) throw new Forbidden('Your form expired. Reload the page and try again.');
    const a = await PR.access(req, 'contribute');
    const t = await PR.own('service_tasks', req.params.tid, a.ws.id);
    const st = ['done', 'missed', 'cancelled'].includes(req.body.status) ? req.body.status : null; if (!st) throw bad('Choose the result.');
    const files = await uploads.prepare(req.files, sniff);
    await core.inTx(async db => {
      const n = (await db.query("update service_tasks set status = $2, completed_on = $3, notes = $4 where id = $1 and status = 'scheduled'", [t.id, st, dateOrNull(req.body.completed_on) || todayBH(), txt(req.body.notes, 1000)])).rowCount;
      if (!n) throw bad('Already recorded.');
      await uploads.insert(db, { workspaceId: a.ws.id, entity: 'service_task', entityId: t.id, files, userId: req.user.id, tag: 'completion' });
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: `service.${st}`, entity: 'service_task', entityId: t.id, summary: `Service task of ${t.scheduled_on}: ${st}`, ip: req.ip });
    });
    res.redirect(`/w/${a.ws.id}/services?msg=saved`);
  });
  r.post('/w/:id/services/tasks/:tid/review', async (req, res) => {
    const a = await PR.access(req, 'edit');
    const t = await PR.own('service_tasks', req.params.tid, a.ws.id);
    await core.inTx(async db => {
      const n = (await db.query("update service_tasks set status = 'reviewed', reviewed_by = $2 where id = $1 and status = 'done'", [t.id, req.user.id])).rowCount;
      if (!n) throw bad('Only a done task can be reviewed.');
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'service.reviewed', entity: 'service_task', entityId: t.id, summary: `Service task of ${t.scheduled_on} reviewed by supervisor`, ip: req.ip });
    });
    res.redirect(`/w/${a.ws.id}/services?msg=saved`);
  });

  return { M_STATUS, RESP, PAID_BY, TAGS };
}

module.exports = { mountMaintenance, M_STATUS, RESP, PAID_BY, TAGS };
