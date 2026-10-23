'use strict';
// Land & Plots: a project can sit on several plots (e.g. four villas on four plots as one project).
const crypto = require('crypto');
const multer = require('multer');
const { SECTIONS, KIND_LABEL } = require('./core');
const { layout, html, raw, pill, statusPill, csrfField, field, fmtDate, fmtDateTime } = require('./views');
const { parseMoney, formatMoney, toInput, num } = require('../lib/money');
const { sniff } = require('./workspaces');

const UUID = /^[0-9a-f-]{36}$/i;
const PLOT_SECTIONS = new Set(['dev']);
const bad = m => Object.assign(new Error(m), { status: 400 });
const txt = (v, n = 200) => { const s = String(v ?? '').trim().slice(0, n); return s || null; };
const STATUS = { owned: 'Owned', under_purchase: 'Being purchased', option: 'Option / under negotiation', client_owned: 'Owned by client', sold: 'Sold' };
const TENURE = { freehold: 'Freehold', leasehold: 'Leasehold', other: 'Other' };
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 5, fields: 30 } });
const n2 = v => v === null || v === undefined ? null : Number(v);
const fmtArea = v => v === null || v === undefined ? '—' : `${Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 })} m²`;

function mountPlots(r, ctx) {
  const { pool, core, NotFound, Forbidden } = ctx;

  async function access(req, need) {
    const a = await core.workspaceAccess(req.user, req.params.id);
    if (!a || !a.internal || !PLOT_SECTIONS.has(a.ws.section)) throw new NotFound();
    if (need === 'edit' && !core.canEdit(a)) throw new Forbidden('Only the workspace manager or an editor can change plots.');
    a.finance = core.isSuper(req.user) || a.role === 'manager' || a.role === 'editor' || await core.can(req.user, 'view:financials');
    return a;
  }
  const own = async (id, wsId) => {
    if (!UUID.test(String(id))) throw new NotFound();
    const p = (await pool.query('select * from plots where id = $1 and workspace_id = $2 and archived_at is null', [id, wsId])).rows[0];
    if (!p) throw new NotFound();
    return p;
  };
  function page(req, a, body) {
    const w = a.ws, s = SECTIONS[w.section];
    return layout(req, { title: `Land & Plots · ${w.name}`, heading: w.name, tabs: ctx.tabsFor[w.section](a, 'Land & Plots'),
      crumbs: [['Home', '/'], [s.name, `/s/${w.section}`], [w.name, `/w/${w.id}`], ['Land & Plots']],
      sub: { above: `${w.ref} · ${KIND_LABEL[w.kind]}`, below: w.location || '' }, actions: statusPill(w.status), body });
  }

  function read(body, finance) {
    const num_ = (v, label) => { if (v === undefined || v === '') return null; const x = Number(String(v).replace(/,/g, '')); if (!isFinite(x) || x < 0) throw bad(`${label} must be a positive number.`); return x; };
    const out = {
      ref: txt(body.ref, 60), title_deed: txt(body.title_deed, 80), area_m2: num_(body.area_m2, 'Area'), frontage_m: num_(body.frontage_m, 'Frontage'), depth_m: num_(body.depth_m, 'Depth'),
      location: txt(body.location, 200), tenure: TENURE[body.tenure] ? body.tenure : null, owner_text: txt(body.owner_text, 160), zoning: txt(body.zoning, 80),
      status: STATUS[body.status] ? body.status : 'owned', notes: txt(body.notes, 2000)
    };
    if (!out.ref) throw bad('Enter the plot number.');
    if (finance) { out.purchase_price_minor = parseMoney(body.purchase_price, 'BHD'); out.purchase_date = /^\d{4}-\d{2}-\d{2}$/.test(body.purchase_date || '') ? body.purchase_date : null; }
    return out;
  }
  const form = (req, a, p = {}) => html`
    ${field({ name: 'ref', label: 'Plot number', value: p.ref || '', required: true, attrs: 'maxlength="60"' })}
    ${field({ name: 'title_deed', label: 'Title deed number', value: p.title_deed || '', attrs: 'maxlength="80"' })}
    ${field({ name: 'area_m2', label: 'Area (m²)', value: p.area_m2 === undefined || p.area_m2 === null ? '' : Number(p.area_m2), type: 'number', attrs: 'min="0" step="any"' })}
    ${field({ name: 'frontage_m', label: 'Frontage (m)', value: p.frontage_m === undefined || p.frontage_m === null ? '' : Number(p.frontage_m), type: 'number', attrs: 'min="0" step="any"' })}
    ${field({ name: 'depth_m', label: 'Depth (m)', value: p.depth_m === undefined || p.depth_m === null ? '' : Number(p.depth_m), type: 'number', attrs: 'min="0" step="any"' })}
    ${field({ name: 'zoning', label: 'Zoning / classification', value: p.zoning || '', attrs: 'maxlength="80"' })}
    ${field({ name: 'tenure', label: 'Tenure', value: p.tenure || '', options: [['', 'Not yet determined'], ...Object.entries(TENURE)] })}
    ${field({ name: 'status', label: 'Status', value: p.status || 'owned', options: Object.entries(STATUS) })}
    ${field({ name: 'owner_text', label: 'Registered owner', value: p.owner_text || '', attrs: 'maxlength="160"' })}
    ${field({ name: 'location', label: 'Location / block / road', value: p.location || '', attrs: 'maxlength="200"' })}
    ${a.finance ? html`${field({ name: 'purchase_price', label: 'Purchase price (BHD)', value: toInput(n2(p.purchase_price_minor)), attrs: 'inputmode="decimal"' })}
      ${field({ name: 'purchase_date', label: 'Purchase date', type: 'date', value: p.purchase_date ? new Date(p.purchase_date).toISOString().slice(0, 10) : '' })}` : ''}
    ${field({ name: 'notes', label: 'Notes', value: p.notes || '', type: 'textarea', full: true })}`;

  r.get('/w/:id/plots', async (req, res) => {
    const a = await access(req);
    const plots = (await pool.query(`select p.*, (select count(*)::int from files f where f.entity = 'plot' and f.entity_id = p.id::text and f.archived_at is null) as docs,
        (select string_agg(u.name, ', ' order by u.sort) from dev_units u where u.plot_id = p.id) as units
      from plots p where p.workspace_id = $1 and p.archived_at is null order by p.sort, p.created_at`, [a.ws.id])).rows;
    const docs = plots.length ? (await pool.query("select id, entity_id, original_name, caption from files where entity = 'plot' and workspace_id = $1 and archived_at is null order by uploaded_at desc", [a.ws.id])).rows : [];
    const areaKnown = plots.filter(p => p.area_m2 !== null);
    const totalArea = areaKnown.reduce((s, p) => s + Number(p.area_m2), 0);
    const priceKnown = plots.filter(p => p.purchase_price_minor !== null);
    const totalPrice = priceKnown.reduce((s, p) => s + num(p.purchase_price_minor), 0);
    const edit = core.canEdit(a);
    res.send(page(req, a, html`
      <section class="grid-cards" aria-label="Land summary">
        <div class="card"><div class="muted small">Plots</div><div class="big">${plots.length}</div></div>
        <div class="card"><div class="muted small">Total land area</div><div class="big">${areaKnown.length ? fmtArea(totalArea) : '—'}</div>
          ${areaKnown.length < plots.length ? html`<div class="muted small">${plots.length - areaKnown.length} plot(s) without an area</div>` : ''}</div>
        ${a.finance ? html`<div class="card"><div class="muted small">Recorded purchase prices</div><div class="big">${priceKnown.length ? formatMoney(totalPrice) : '—'}</div>
          ${priceKnown.length < plots.length ? html`<div class="muted small">${plots.length - priceKnown.length} plot(s) without a price</div>` : ''}</div>` : ''}
      </section>
      <section class="panel"><h2 class="h">Plots in this project</h2>
        ${plots.length ? html`<div class="table-wrap"><table><thead><tr><th>Plot</th><th>Title deed</th><th class="n">Area</th><th>Frontage × depth</th><th>Status</th><th>Units</th>${a.finance ? html`<th class="n">Purchase price</th>` : ''}<th>Documents</th></tr></thead><tbody>
          ${plots.map(p => html`<tr><td><b>${p.ref}</b>${p.zoning ? html`<div class="muted small">${p.zoning}</div>` : ''}${p.owner_text ? html`<div class="muted small">Owner: ${p.owner_text}</div>` : ''}</td>
            <td>${p.title_deed || html`<span class="muted">—</span>`}</td><td class="n">${fmtArea(p.area_m2)}</td>
            <td>${p.frontage_m !== null || p.depth_m !== null ? `${p.frontage_m !== null ? Number(p.frontage_m) : '?'} × ${p.depth_m !== null ? Number(p.depth_m) : '?'} m` : '—'}</td>
            <td>${pill(STATUS[p.status], p.status === 'owned' || p.status === 'client_owned' ? 'ok' : p.status === 'sold' ? 'muted' : 'warn')}</td><td class="small">${p.units || '—'}</td>
            ${a.finance ? html`<td class="n">${p.purchase_price_minor === null ? html`<span class="muted">Not set</span>` : formatMoney(num(p.purchase_price_minor))}${p.purchase_date ? html`<div class="muted small">${fmtDate(p.purchase_date)}</div>` : ''}</td>` : ''}
            <td>${docs.filter(d => d.entity_id === p.id).map(d => html`<div class="small"><a href="/files/${d.id}">${d.caption || d.original_name}</a></div>`)}${!p.docs ? html`<span class="muted small">None</span>` : ''}</td></tr>
            ${edit ? html`<tr class="sub"><td colspan="${a.finance ? 8 : 7}"><details class="inline-form"><summary class="small">Edit plot ${p.ref} or attach documents</summary>
              <form method="post" action="/w/${a.ws.id}/plots/${p.id}" class="form-grid">${csrfField(req)}${form(req, a, p)}
                <div class="actions full"><button class="btn primary" type="submit">Save plot</button><button class="btn" type="submit" name="archive" value="1">Remove plot</button></div></form>
              <form method="post" action="/w/${a.ws.id}/plots/${p.id}/files" enctype="multipart/form-data" class="form-grid"><input type="hidden" name="_csrf" value="${req.csrfToken}">
                <label class="field" for="f-pf-${p.id}"><span>Title deed, survey or other documents</span><input id="f-pf-${p.id}" type="file" name="files" multiple required accept=".pdf,image/*,.dwg,.docx"></label>
                ${field({ name: 'caption', label: 'Description', attrs: `id="f-pc-${p.id}"` })}
                <div class="actions full"><button class="btn" type="submit">Attach</button></div></form></details></td></tr>` : ''}`)}
        </tbody></table></div>` : html`<p class="muted">No plots recorded yet. Add each plot this project is built on — for example four plots for four villas.</p>`}
      </section>
      ${edit ? html`<section class="panel"><h2 class="h">Add a plot</h2><form method="post" action="/w/${a.ws.id}/plots" class="form-grid">${csrfField(req)}${form(req, a)}
        <div class="actions full"><button class="btn primary" type="submit">Add plot</button></div></form></section>` : ''}`));
  });

  r.post('/w/:id/plots', async (req, res) => {
    const a = await access(req, 'edit');
    const p = read(req.body, a.finance);
    try {
      await core.inTx(async db => {
        const s = (await db.query('select coalesce(max(sort),-1)+1 as s from plots where workspace_id = $1', [a.ws.id])).rows[0].s;
        const id = (await db.query(`insert into plots (workspace_id, ref, title_deed, area_m2, frontage_m, depth_m, location, tenure, owner_text, zoning, status, notes, purchase_price_minor, purchase_date, sort)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning id`,
          [a.ws.id, p.ref, p.title_deed, p.area_m2, p.frontage_m, p.depth_m, p.location, p.tenure, p.owner_text, p.zoning, p.status, p.notes, p.purchase_price_minor ?? null, p.purchase_date ?? null, s])).rows[0].id;
        await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'plot.added', entity: 'plot', entityId: id, summary: `Plot ${p.ref} added`, after: p, ip: req.ip });
        await db.query('update workspaces set updated_at = now() where id = $1', [a.ws.id]);
      });
    } catch (e) { if (e.code === '23505') throw bad(`Plot ${p.ref} is already recorded in this project.`); throw e; }
    res.redirect(`/w/${a.ws.id}/plots?msg=added`);
  });

  r.post('/w/:id/plots/:pid', async (req, res) => {
    const a = await access(req, 'edit');
    const cur = await own(req.params.pid, a.ws.id);
    if (req.body.archive === '1') {
      await core.inTx(async db => {
        await db.query('update plots set archived_at = now() where id = $1', [cur.id]);
        await db.query('update dev_units set plot_id = null where plot_id = $1', [cur.id]);
        await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'plot.removed', entity: 'plot', entityId: cur.id, summary: `Plot ${cur.ref} removed (kept in history)`, ip: req.ip });
      });
      return res.redirect(`/w/${a.ws.id}/plots?msg=archived`);
    }
    const p = read(req.body, a.finance);
    try {
      await core.inTx(async db => {
        await db.query(`update plots set ref = $2, title_deed = $3, area_m2 = $4, frontage_m = $5, depth_m = $6, location = $7, tenure = $8, owner_text = $9, zoning = $10, status = $11, notes = $12
          ${a.finance ? ', purchase_price_minor = $13, purchase_date = $14' : ''} where id = $1`,
          [cur.id, p.ref, p.title_deed, p.area_m2, p.frontage_m, p.depth_m, p.location, p.tenure, p.owner_text, p.zoning, p.status, p.notes, ...(a.finance ? [p.purchase_price_minor, p.purchase_date] : [])]);
        const before = { ref: cur.ref, area_m2: n2(cur.area_m2), status: cur.status, title_deed: cur.title_deed, purchase_price_minor: n2(cur.purchase_price_minor) };
        await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'plot.updated', entity: 'plot', entityId: cur.id, summary: `Plot ${p.ref} updated`, before, after: p, ip: req.ip });
      });
    } catch (e) { if (e.code === '23505') throw bad(`Plot ${p.ref} is already recorded in this project.`); throw e; }
    res.redirect(`/w/${a.ws.id}/plots?msg=saved`);
  });

  r.post('/w/:id/plots/:pid/files', upload.array('files', 5), async (req, res) => {
    if (!core.checkCsrf(req)) throw new Forbidden('Your form expired. Reload the page and try again.');
    const a = await access(req, 'edit');
    const p = await own(req.params.pid, a.ws.id);
    const files = req.files || []; if (!files.length) throw bad('Choose a file.');
    const caption = txt(req.body.caption, 200);
    await core.inTx(async db => {
      for (const f of files) {
        const t = sniff(f.buffer, f.originalname);
        if (!t) throw Object.assign(new Error(`“${f.originalname}” is not an accepted file type.`), { status: 415 });
        const name = String(f.originalname).replace(/[/\\<>:"|?*\u0000-\u001f]/g, '_').slice(-150);
        const id = (await db.query(`insert into files (workspace_id, entity, entity_id, original_name, mime, size, sha256, data, caption, location, uploaded_by)
          values ($1,'plot',$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`, [a.ws.id, p.id, name, t.mime, f.size, crypto.createHash('sha256').update(f.buffer).digest('hex'), f.buffer, caption, `Plot ${p.ref}`, req.user.id])).rows[0].id;
        await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'file.uploaded', entity: 'file', entityId: id, summary: `Plot ${p.ref}: uploaded ${name}`, ip: req.ip });
      }
    });
    res.redirect(`/w/${a.ws.id}/plots?msg=uploaded`);
  });
}

module.exports = { mountPlots, PLOT_STATUS: STATUS };
