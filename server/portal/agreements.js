'use strict';
const DL = require('../lib/download');
// Agreements & contracts for every section: templates (starter drafts, in-system text templates, uploaded Word templates),
// SarayDar letterhead, per-workspace agreements with the external party's details, generated versions and signed copies.
const crypto = require('crypto');
const multer = require('multer');
const sharp = require('sharp');
const { SECTIONS, KIND_LABEL } = require('./core');
const { layout, html, raw, pill, statusPill, csrfField, emptyState, field, fmtDate, fmtDateTime } = require('./views');
const A = require('../lib/agreements');
const { STARTERS } = require('../lib/agreement-starters');
const { toInput } = require('../lib/money');
const { sniff } = require('./workspaces');

const UUID = /^[0-9a-f-]{36}$/i;
const bad = m => Object.assign(new Error(m), { status: 400 });
const txt = (v, n = 300) => { const s = String(v ?? '').trim().slice(0, n); return s || null; };
const STATUS = { draft: ['Draft', 'muted'], issued: ['Issued for signature', 'warn'], signed: ['Signed', 'ok'], cancelled: ['Cancelled', 'muted'] };
const upload = require('./choices').withChoices(multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 1, fields: 80 } }));
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bahrain' });
const PARTY_FIELDS = [['name', 'Full name / company name', true], ['id_number', 'CPR / CR / passport number'], ['address', 'Address'], ['phone', 'Telephone'], ['email', 'Email'], ['representative', 'Represented by (for companies)'], ['representative_title', 'Representative title'], ['representative_cpr', 'Representative CPR number']];

function mountAgreements(r, ctx) {
  const { pool, core, NotFound, Forbidden } = ctx;

  let seeded = null;
  const ensureStarters = () => seeded || (seeded = (async () => {
    for (const s of STARTERS) {
      await pool.query(`insert into agreement_templates (key, name, sections, category, counterparty, kind, body, fields, starter)
        values ($1,$2,$3,$4,$5,'text',$6,$7,true) on conflict (key) do update set body = excluded.body, fields = excluded.fields, name = excluded.name, sections = excluded.sections, counterparty = excluded.counterparty
        where agreement_templates.starter`, [s.key, s.name, s.sections, s.category, s.counterparty, s.body, s.fields]);
    }
  })().catch(e => { seeded = null; throw e; }));
  ctx.ensureStarters = ensureStarters;

  const company = async () => (await pool.query('select * from company_profile where id = 1')).rows[0] || {};

  async function access(req, need) {
    const a = await core.workspaceAccess(req.user, req.params.id);
    if (!a || !a.internal) throw new NotFound();
    if (need === 'edit' && !core.canEdit(a)) throw new Forbidden('Only the workspace manager or an editor can prepare agreements.');
    return a;
  }
  const loadAgreement = async (a, aid) => {
    if (!UUID.test(String(aid))) throw new NotFound();
    const g = (await pool.query('select * from agreements where id = $1 and workspace_id = $2', [aid, a.ws.id])).rows[0];
    if (!g) throw new NotFound();
    return g;
  };
  const loadTemplate = async id => {
    if (!UUID.test(String(id))) throw new NotFound();
    const t = (await pool.query('select * from agreement_templates where id = $1', [id])).rows[0];
    if (!t) throw new NotFound();
    return t;
  };

  function page(req, a, body) {
    const w = a.ws, s = SECTIONS[w.section];
    const tabs = ctx.tabsFor && ctx.tabsFor[w.section] ? ctx.tabsFor[w.section](a, 'Agreements')
      : [['Overview', `/w/${w.id}`], ['Agreements', `/w/${w.id}/agreements`], ['Documents', `/w/${w.id}/documents`], ['Access & Invitations', `/w/${w.id}/access`], ['Activity', `/w/${w.id}/activity`]].map(([l, h]) => [l, h, l === 'Agreements']);
    return layout(req, { title: `Agreements · ${w.name}`, heading: w.name, tabs, crumbs: [['Home', '/'], [s.name, `/s/${w.section}`], [w.name, `/w/${w.id}`], ['Agreements']],
      sub: { above: `${w.ref} · ${KIND_LABEL[w.kind]}`, below: w.location || '', badge: statusPill(w.status) }, body });
  }

  // ---------- list ----------
  r.get('/w/:id/agreements', async (req, res) => {
    const a = await access(req);
    await ensureStarters();
    const rows = (await pool.query(`select g.*, t.name as tpl, p.name as party_name, (select max(version) from agreement_versions v where v.agreement_id = g.id) as v
      from agreements g join agreement_templates t on t.id = g.template_id left join parties p on p.id = g.party_id where g.workspace_id = $1 order by g.created_at desc`, [a.ws.id])).rows;
    const tpls = (await pool.query('select id, name, category, counterparty, starter, kind from agreement_templates where active and $1 = any(sections) order by starter, category, name', [a.ws.section])).rows;
    const edit = core.canEdit(a);
    const termsBlock = ctx.mgmtTermsBlock ? await ctx.mgmtTermsBlock(req) : '';
    res.send(page(req, a, html`${termsBlock}
      <section class="panel"><h2 class="h">${termsBlock ? 'All agreements & contracts' : 'Agreements & contracts'}</h2>
        ${rows.length ? html`<div class="table-wrap"><table><thead><tr><th>Reference</th><th>Agreement</th><th>Other party</th><th>Status</th><th>Versions</th><th>Updated</th></tr></thead><tbody>
          ${rows.map(g => html`<tr><td class="mono">${g.ref}</td><td><a href="/w/${a.ws.id}/agreements/${g.id}"><b>${g.title}</b></a><div class="muted small">${g.tpl}</div></td><td>${g.party_name || html`<span class="muted">Not set</span>`}</td>
            <td>${pill(STATUS[g.status][0], STATUS[g.status][1])}</td><td>${g.v || 0}</td><td class="small">${fmtDate(g.updated_at)}</td></tr>`)}</tbody></table></div>`
          : html`<p class="muted">No agreements for this ${SECTIONS[a.ws.section].noun} yet.</p>`}
      </section>
      ${edit ? html`<section class="panel"><h2 class="h">Prepare a new agreement</h2>
        <p class="muted">The system fills in this ${SECTIONS[a.ws.section].noun}'s details and SarayDar's company details, then asks for the other party and the remaining terms.</p>
        <ul class="rows">${tpls.map(t => html`<li><div class="grow"><b>${t.name}</b><div class="muted small">${t.category} · with ${t.counterparty}${t.kind === 'docx' ? ' · your Word template' : t.starter ? ' · starter draft, needs legal review' : ' · company template'}</div></div>
          <a class="btn" href="/w/${a.ws.id}/agreements/new?template=${t.id}">Use</a></li>`)}</ul>
        ${core.isSuper(req.user) ? html`<p class="small"><a href="/admin/agreements">Manage templates and letterhead</a></p>` : ''}</section>` : ''}`));
  });

  // Answers left empty are taken from the management terms recorded on the Agreements tab (in force, else the draft),
  // so the agreement and the billing terms say the same thing. Typed answers always win.
  async function withTerms(wsId, fields, values = {}) {
    const t = (await pool.query("select * from mgmt_terms where workspace_id = $1 and status in ('active','draft') order by (status = 'draft') desc, version desc limit 1", [wsId])).rows[0];
    if (!t) return { values, filled: [] };
    const iso = d => d ? String(d instanceof Date ? d.toISOString() : d).slice(0, 10) : null;
    let months = null;
    if (t.start_date && t.end_date) { const s0 = new Date(iso(t.start_date)), e0 = new Date(iso(t.end_date)); e0.setUTCDate(e0.getUTCDate() + 1); months = Math.round((e0 - s0) / (30.4375 * 864e5)); }
    const from = { services: t.scope, scope: t.scope, exclusions: t.exclusions, monthly_fee_amount: t.monthly_fee_minor === null ? null : Number(t.monthly_fee_minor), monthly_fee: t.monthly_fee_minor === null ? null : Number(t.monthly_fee_minor),
      start_date: iso(t.start_date), end_date: iso(t.end_date), duration_months: months, payment_days: t.payment_terms_days, approvers: A.approversOf((await pool.query('select p.* from workspaces w join parties p on p.id = w.party_id where w.id = $1', [wsId])).rows[0] || {}).join(' and ') || t.client_approvers,
      notices_days: t.notice_days, agreement_date: iso(t.signed_on),
      billing_timing: t.billing_timing === 'advance' ? `in advance, at the start of each month${t.proration === 'daily' ? ' (part months charged by the day)' : ''}` : t.billing_timing === 'arrears' ? `in arrears, after the end of each month${t.proration === 'daily' ? ' (part months charged by the day)' : ''}` : null };
    const prof = (await pool.query('select * from property_profiles where workspace_id = $1', [wsId])).rows[0];
    if (prof) {
      const who = { saraydar: 'SarayDar', owner: 'the Owner', other: 'another party' };
      from.rent_collection = `Rent is collected by ${who[prof.rent_collector] || prof.rent_collector}. Tenant deposits are held by ${who[prof.deposit_holder] || prof.deposit_holder}. Suppliers are paid by ${who[prof.supplier_payer] || prof.supplier_payer}.${prof.payment_instructions ? ` ${prof.payment_instructions}` : ''}`;
      from.spending_limit_amount = prof.maintenance_limit_minor === null || prof.maintenance_limit_minor === undefined ? null : Number(prof.maintenance_limit_minor);
      from.fee_deduction = prof.fee_deduction_allowed ? 'allowed, with each deduction shown on the owner statement' : 'not allowed; fees are invoiced to the Owner';
      if (prof.reporting_prefs) from.reporting = prof.reporting_prefs;
    }
    const out = { ...values }, filled = [];
    for (const f of fields) {
      const v = from[f.key];
      if ((out[f.key] === undefined || out[f.key] === null || out[f.key] === '') && v !== undefined && v !== null && v !== '') { out[f.key] = v; filled.push(f.key); }
    }
    return { values: out, filled };
  }
  ctx.agreementTerms = withTerms;

  // ---------- form (new / edit) ----------
  async function form(req, res, a, tpl, g = null, err = '') {
    const fields = A.fieldsFor(tpl);
    const values = (await withTerms(a.ws.id, fields, g ? g.values : {})).values;
    const party = g && g.party_id ? (await pool.query('select * from parties where id = $1', [g.party_id])).rows[0] : null;
    const parties = (await pool.query('select id, name, kind, salutation, id_number, address, phone, email, representative, representative_title, representative_cpr from parties where archived_at is null order by name limit 1000')).rows;
    const co = await company();
    const coMissing = ['legal_name', 'cr_number', 'address', 'signatory_name'].filter(k => !co[k]);
    const dflt = f => f.default === 'today' ? today() : f.default;
    const val = f => values[f.key] !== undefined ? (f.type === 'money' ? toInput(values[f.key]) : values[f.key]) : (g ? '' : dflt(f) ?? '');
    res.status(err ? 400 : 200).send(page(req, a, html`<p><a href="/w/${a.ws.id}/agreements">‹ Agreements</a></p>
      <form method="post" action="${g ? `/w/${a.ws.id}/agreements/${g.id}` : `/w/${a.ws.id}/agreements`}" class="stack">${csrfField(req)}<input type="hidden" name="template" value="${tpl.id}">
        <section class="panel form-grid" style="width:100%"><h2 class="h full">${tpl.name}</h2>
          ${tpl.starter ? html`<p class="notice full">Starter draft: a generic working text, not checked against any law. Have the final document reviewed by your legal adviser.</p>` : ''}
          ${field({ name: 'title', label: 'Agreement title', value: g ? g.title : `${tpl.name} — ${a.ws.name}`, required: true, full: true })}
          <div class="full muted small">Filled automatically: ${a.ws.name} (${a.ws.ref})${a.ws.location ? `, ${a.ws.location}` : ''}; SarayDar company details; agreement reference and date.
            ${coMissing.length ? html`<span class="err"> Company details missing: ${coMissing.join(', ').replace(/_/g, ' ')}${core.isSuper(req.user) ? html` — <a href="/admin/agreements">add them</a>` : ' — ask the Super Admin'}.</span>` : ''}</div></section>
        <section class="panel form-grid" style="width:100%"><h2 class="h full">${tpl.counterparty}</h2>
          ${field({ name: 'party_id', label: `Existing ${tpl.counterparty.toLowerCase()}`, value: party ? party.id : '', options: [['', `New ${tpl.counterparty.toLowerCase()}`], ...parties.map(p => [p.id, p.name])], attrs: 'data-party-select', full: true })}
          ${field({ name: 'party_kind', label: 'Type', value: party ? party.kind : 'person', options: [['person', 'Individual'], ['company', 'Company']] })}
          ${field({ name: 'p_salutation', label: 'Title (individuals)', value: party ? party.salutation || '' : '', options: [['', 'None'], ...['Mr.', 'Mrs.', 'Ms.', 'Dr.', 'Eng.'].map(x => [x, x])], buttons: false, attrs: 'data-party-field="salutation"', hint: 'Printed before the name. Companies always get “M/s.”' })}
          ${PARTY_FIELDS.map(([k, l, req2]) => field({ name: `p_${k}`, label: l, type: k === 'phone' ? 'tel' : k === 'email' ? 'email' : 'text', value: party ? party[k] || '' : '', attrs: `data-party-field="${k}" maxlength="200"`, hint: req2 ? 'Required to generate the document.' : '' }))}
          <script type="application/json" id="party-data">${raw(JSON.stringify(Object.fromEntries(parties.map(p => [p.id, p]))).replace(/</g, '\\u003c'))}</script>
          <p class="muted small full">Choosing an existing name fills these fields. Changes you make here update that person's or company's record.</p></section>
        <section class="panel form-grid" style="width:100%"><h2 class="h full">Terms</h2>
          ${fields.length ? fields.map(f => field({ name: `v_${f.key}`, label: f.label, type: f.type === 'money' ? 'text' : f.type, value: val(f), required: !!f.required, hint: [f.type === 'money' ? 'BHD' : '', f.hint || ''].filter(Boolean).join(' · '),
            attrs: f.type === 'money' ? 'inputmode="decimal" data-money' : f.type === 'number' ? 'step="any"' : '', full: f.type === 'textarea' })) : html`<p class="muted full">This template has no other questions.</p>`}
          ${err ? html`<p class="err full" role="alert">${err}</p>` : ''}
          <div class="actions full"><button class="btn primary" type="submit">${g ? 'Save changes' : 'Save draft'}</button><span class="muted small">You can save with blanks and generate the document when everything required is filled.</span></div>
        </section></form>`));
  }

  r.get('/w/:id/agreements/new', async (req, res) => {
    const a = await access(req, 'edit');
    await ensureStarters();
    const tpl = await loadTemplate(req.query.template);
    if (!tpl.active || !tpl.sections.includes(a.ws.section)) throw new NotFound();
    await form(req, res, a, tpl);
  });

  async function saveParty(db, req, tplCounterparty, existingId) {
    const p = Object.fromEntries(PARTY_FIELDS.map(([k]) => [k, txt(req.body[`p_${k}`], 200)]));
    const kind = req.body.party_kind === 'company' ? 'company' : 'person';
    const sal = kind === 'person' && ['Mr.', 'Mrs.', 'Ms.', 'Dr.', 'Eng.'].includes(req.body.p_salutation) ? req.body.p_salutation : null;
    let id = UUID.test(String(req.body.party_id || '')) ? req.body.party_id : existingId || null;
    if (id) {
      const cur = (await db.query('select * from parties where id = $1', [id])).rows[0];
      if (!cur) throw bad('That party no longer exists.');
      if (p.name) await db.query('update parties set name = $2, kind = $3, id_number = $4, address = $5, phone = $6, email = $7, representative = $8, representative_title = $9, representative_cpr = $10, salutation = $11 where id = $1',
        [id, p.name, kind, p.id_number, p.address, p.phone, p.email, p.representative, p.representative_title, p.representative_cpr, sal]);
      return id;
    }
    if (!p.name) return null;
    const role = { 'project owner': 'client' }[tplCounterparty.toLowerCase()] || tplCounterparty.toLowerCase();   // a Project Owner is a client in the client register
    return (await db.query('insert into parties (name, kind, id_number, address, phone, email, representative, representative_title, representative_cpr, roles, created_by, salutation) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id',
      [p.name, kind, p.id_number, p.address, p.phone, p.email, p.representative, p.representative_title, p.representative_cpr, [role], req.user.id, sal])).rows[0].id;
  }

  r.post('/w/:id/agreements', async (req, res) => {
    const a = await access(req, 'edit');
    const tpl = await loadTemplate(req.body.template);
    if (!tpl.active || !tpl.sections.includes(a.ws.section)) throw new NotFound();
    const fields = A.fieldsFor(tpl);
    let values;
    try { values = A.readValues(fields, req.body); } catch (e) { return form(req, res, a, tpl, null, e.message); }
    const title = txt(req.body.title, 200) || tpl.name;
    const id = await core.inTx(async db => {
      const partyId = await saveParty(db, req, tpl.counterparty, null);
      const year = new Date().toLocaleString('en-GB', { year: 'numeric', timeZone: 'Asia/Bahrain' });
      const ref = `AGR-${year}-${String(await core.nextNumber(db, `AGR-${year}`)).padStart(3, '0')}`;
      const g = (await db.query('insert into agreements (workspace_id, template_id, ref, title, party_id, values, created_by) values ($1,$2,$3,$4,$5,$6,$7) returning id', [a.ws.id, tpl.id, ref, title, partyId, values, req.user.id])).rows[0];
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'agreement.created', entity: 'agreement', entityId: g.id, summary: `Agreement ${ref} drafted: ${title}`, ip: req.ip });
      return g.id;
    });
    res.redirect(`/w/${a.ws.id}/agreements/${id}?msg=created`);
  });

  r.get('/w/:id/agreements/:aid/edit', async (req, res) => {
    const a = await access(req, 'edit');
    const g = await loadAgreement(a, req.params.aid);
    if (['signed', 'cancelled'].includes(g.status)) throw bad('Signed or cancelled agreements cannot be changed.');
    await form(req, res, a, await loadTemplate(g.template_id), g);
  });

  r.post('/w/:id/agreements/:aid', async (req, res) => {
    const a = await access(req, 'edit');
    const g = await loadAgreement(a, req.params.aid);
    if (['signed', 'cancelled'].includes(g.status)) throw bad('Signed or cancelled agreements cannot be changed.');
    const tpl = await loadTemplate(g.template_id);
    let values;
    try { values = A.readValues(A.fieldsFor(tpl), req.body); } catch (e) { return form(req, res, a, tpl, g, e.message); }
    await core.inTx(async db => {
      const partyId = await saveParty(db, req, tpl.counterparty, g.party_id);
      await db.query("update agreements set title = $2, values = $3, party_id = $4, status = 'draft', updated_at = now() where id = $1", [g.id, txt(req.body.title, 200) || g.title, values, partyId]);
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'agreement.updated', entity: 'agreement', entityId: g.id, summary: `Agreement ${g.ref} edited`, before: g.values, after: values, ip: req.ip });
    });
    res.redirect(`/w/${a.ws.id}/agreements/${g.id}?msg=saved`);
  });

  // ---------- one agreement ----------
  r.get('/w/:id/agreements/:aid', async (req, res) => {
    const a = await access(req);
    const g = await loadAgreement(a, req.params.aid);
    const tpl = await loadTemplate(g.template_id);
    const fields = A.fieldsFor(tpl);
    const party = g.party_id ? (await pool.query('select * from parties where id = $1', [g.party_id])).rows[0] : null;
    const versions = (await pool.query(`select v.id, v.version, v.template_version, v.created_at, v.pdf is not null as has_pdf, v.docx is not null as has_docx, coalesce(nullif(u.name,''), u.email) as who
      from agreement_versions v left join users u on u.id = v.created_by where v.agreement_id = $1 order by v.version desc`, [g.id])).rows;
    const signed = (await pool.query("select id, original_name, uploaded_at from files where entity = 'agreement' and entity_id = $1 and workspace_id = $2 and archived_at is null order by uploaded_at desc", [g.id, a.ws.id])).rows;
    const wt = await withTerms(a.ws.id, fields, g.values);
    const open0 = !['signed', 'cancelled'].includes(g.status);
    if (open0) g.values = wt.values;                      // a signed agreement shows exactly what was signed
    const fromTerms = open0 ? new Set(wt.filled) : new Set();
    const missing = A.missingRequired(fields, g.values);
    const partyMissing = !party || !party.name;
    const edit = core.canEdit(a);
    const open = !['signed', 'cancelled'].includes(g.status);
    res.send(page(req, a, html`<p><a href="/w/${a.ws.id}/agreements">‹ Agreements</a></p>
      <section class="panel"><div class="row-between"><div><div class="mono small">${g.ref}</div><h2 class="h">${g.title}</h2></div>${pill(STATUS[g.status][0], STATUS[g.status][1])}</div>
        <p class="muted small">${tpl.name}${tpl.starter ? ' · starter draft (legal review required)' : ''} · created ${fmtDateTime(g.created_at)}${g.signed_on ? ` · signed ${fmtDate(g.signed_on)}` : ''}${g.cancel_reason ? ` · cancelled: ${g.cancel_reason}` : ''}</p>
        <div class="split">
          <div class="grow1"><h3 class="h3">${tpl.counterparty}</h3>${party ? html`<dl class="details">${PARTY_FIELDS.map(([k, l]) => html`<div><dt>${l}</dt><dd>${party[k] || html`<span class="muted">—</span>`}</dd></div>`)}</dl>` : html`<p class="err">Not set yet.</p>`}</div>
          <div class="grow1"><h3 class="h3">Terms</h3><dl class="details">${fields.map(f => html`<div><dt>${f.label}${f.required ? ' *' : ''}</dt><dd class="pre-line">${A.display(f, g.values[f.key]) ?? html`<span class="${f.required ? 'err' : 'muted'}">${f.required ? 'Required' : 'Left blank'}</span>`}${fromTerms.has(f.key) ? html`<div class="muted small">From the management terms</div>` : ''}</dd></div>`)}</dl></div>
        </div>
        ${edit && open ? html`<div class="actions"><a class="btn" href="/w/${a.ws.id}/agreements/${g.id}/edit">Edit details</a>
          ${missing.length || partyMissing ? html`<span class="err small">To generate: ${[partyMissing ? `${tpl.counterparty} name` : null, ...missing.map(f => f.label)].filter(Boolean).join(', ')}</span>`
            : html`<form method="post" action="/w/${a.ws.id}/agreements/${g.id}/generate">${csrfField(req)}<button class="btn primary" type="submit">Generate document${versions.length ? ` (version ${versions.length + 1})` : ''}</button></form>`}</div>` : ''}
      </section>
      <section class="panel"><h2 class="h">Generated versions</h2>
        ${versions.length ? html`<ul class="rows">${versions.map(v => html`<li><div class="grow"><b>Version ${v.version}</b><div class="muted small">${fmtDateTime(v.created_at)} · ${v.who || ''} · template v${v.template_version}</div></div>
          ${v.has_pdf ? html`<a class="btn small primary" href="/w/${a.ws.id}/agreements/${g.id}/v/${v.version}.pdf${DL.pretty(DL.fileName([g.ref, a.ws.name, `v${v.version}`], 'pdf'))}?view=1" target="_blank" rel="noopener">Preview</a><a class="btn small" href="/w/${a.ws.id}/agreements/${g.id}/v/${v.version}.pdf">PDF</a>` : ''}${v.has_docx ? html`<a class="btn small" href="/w/${a.ws.id}/agreements/${g.id}/v/${v.version}.docx">Word</a>` : ''}${g.status === 'draft' && v.version !== versions[0].version && core.canEdit(a) ? html`<form method="post" action="/w/${a.ws.id}/agreements/${g.id}/v/${v.version}/delete" class="inline">${csrfField(req)}<input type="hidden" name="back" value="/w/${a.ws.id}/agreements/${g.id}"><button class="btn small danger-link" type="submit" data-confirm="Delete version ${v.version}? This cannot be undone.">Delete</button></form>` : ''}</li>`)}</ul>`
          : html`<p class="muted">Nothing generated yet.</p>`}
        ${tpl.kind === 'docx' ? html`<p class="muted small">This is your Word template filled in. Its letterhead is whatever your Word file contains. For a PDF, open it in Word and save as PDF.</p>` : ''}
      </section>
      ${edit && open && versions.length ? html`<section class="panel"><h2 class="h">Signature</h2>
        ${g.status === 'draft' ? html`<form method="post" action="/w/${a.ws.id}/agreements/${g.id}/status">${csrfField(req)}<input type="hidden" name="status" value="issued"><button class="btn" type="submit">Mark as issued for signature</button></form>` : ''}
        <form method="post" action="/w/${a.ws.id}/agreements/${g.id}/signed" enctype="multipart/form-data" class="form-grid"><input type="hidden" name="_csrf" value="${req.csrfToken}">
          ${field({ name: 'signed_on', label: 'Signed on', type: 'date', required: true })}
          <label class="field" for="f-signed"><span>Signed copy (PDF or photo) <i class="req">*</i></span><input id="f-signed" type="file" name="file" required accept=".pdf,image/*"></label>
          <div class="actions full"><button class="btn primary" type="submit">Record signed agreement</button></div></form></section>` : ''}
      ${signed.length ? html`<section class="panel"><h2 class="h">Signed copy</h2><ul class="rows">${signed.map(f => html`<li><a class="grow" href="/files/${f.id}">${f.original_name}</a><span class="muted small">${fmtDateTime(f.uploaded_at)}</span></li>`)}</ul></section>` : ''}
      ${edit && open ? html`<details class="inline-form"><summary>Cancel this agreement</summary><form method="post" action="/w/${a.ws.id}/agreements/${g.id}/status" class="stack">${csrfField(req)}<input type="hidden" name="status" value="cancelled">
        ${field({ name: 'reason', label: 'Reason', required: true })}<button class="btn" type="submit">Cancel agreement</button></form></details>` : ''}`));
  });

  async function generateVersion(req, a, g) {
    if (['signed', 'cancelled'].includes(g.status)) throw bad('Signed or cancelled agreements cannot be regenerated.');
    const tpl = await loadTemplate(g.template_id);
    const fields = A.fieldsFor(tpl);
    const party = g.party_id ? (await pool.query('select * from parties where id = $1', [g.party_id])).rows[0] : null;
    if (!party || !party.name) throw bad(`Enter the ${tpl.counterparty.toLowerCase()}'s name first.`);
    g.values = (await withTerms(a.ws.id, fields, g.values)).values;
    for (const f of fields) if ((g.values[f.key] === undefined || g.values[f.key] === '') && f.default) g.values[f.key] = f.default === 'today' ? new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bahrain' }) : f.default;
    const miss = A.missingRequired(fields, g.values);
    if (miss.length) throw bad(`Fill in: ${miss.map(f => f.label).join(', ')}.`);
    const co = await company();
    const map = A.resolve(fields, g.values, A.builtins({ company: co, ws: a.ws, party, agreement: g, counterparty: tpl.counterparty }));
    let pdf = null, docxBuf = null;
    if (tpl.kind === 'docx') docxBuf = A.fillDocx(tpl.docx, map);
    else {
      const text = A.fill(tpl.body, map);
      pdf = await A.renderPdf({ text, ref: g.ref, company: co, notice: tpl.starter });
      docxBuf = await A.renderDocx({ text, ref: g.ref, company: co, notice: tpl.starter });
    }
    return core.inTx(async db => {
      await db.query('select id from agreements where id = $1 for update', [g.id]);
      const n = (await db.query('select coalesce(max(version),0)+1 as n from agreement_versions where agreement_id = $1', [g.id])).rows[0].n;
      await db.query('insert into agreement_versions (agreement_id, version, template_version, values, pdf, docx, created_by) values ($1,$2,$3,$4,$5,$6,$7)', [g.id, n, tpl.version, { ...g.values, _party: party }, pdf, docxBuf, req.user.id]);
      await db.query('update agreements set updated_at = now() where id = $1', [g.id]);
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'agreement.generated', entity: 'agreement', entityId: g.id, summary: `Agreement ${g.ref} version ${n} generated`, ip: req.ip });
      return n;
    });
  }

  r.post('/w/:id/agreements/:aid/generate', async (req, res) => {
    const a = await access(req, 'edit');
    const g = await loadAgreement(a, req.params.aid);
    const v = await generateVersion(req, a, g);
    res.redirect(`/w/${a.ws.id}/agreements/${g.id}?msg=created#v${v}`);
  });

  // ---------- the management agreement made from the terms (top of the Agreements tab) ----------
  const MGMT_TEMPLATE = { cpm: 'pm_services', props: 'property_management' };
  ctx.mgmtAgreement = {
    // the agreement linked to this workspace's management terms (open one first, else the latest)
    async current(wsId, section) {
      const key = MGMT_TEMPLATE[section]; if (!key) return null;
      const g = (await pool.query(`select g.*, (select max(version) from agreement_versions v where v.agreement_id = g.id) as last_version
          from agreements g join agreement_templates t on t.id = g.template_id where g.workspace_id = $1 and t.key = $2
          order by (g.status in ('draft','issued')) desc, g.created_at desc limit 1`, [wsId, key])).rows[0];
      if (!g) return null;
      g.versions = (await pool.query('select version, created_at, pdf is not null as has_pdf, docx is not null as has_docx from agreement_versions where agreement_id = $1 order by version desc', [g.id])).rows;
      return g;
    },
    // what the terms still lack before the agreement can be written (required answers that are empty)
    async missing(a) {
      await ensureStarters();
      const key = MGMT_TEMPLATE[a.ws.section]; if (!key) return [];
      const tpl = (await pool.query('select * from agreement_templates where key = $1 and active order by version desc limit 1', [key])).rows[0];
      if (!tpl) return [];
      const fields = A.fieldsFor(tpl);
      const vals = (await withTerms(a.ws.id, fields, {})).values;
      for (const f of fields) if ((vals[f.key] === undefined || vals[f.key] === '') && f.default) vals[f.key] = f.default;
      const WHERE = { services: 'SarayDar management scope', monthly_fee_amount: 'Monthly fee', start_date: 'Agreement start', rent_collection: 'Property Setup (who collects rent and holds deposits)' };
      return A.missingRequired(fields, vals).map(f => WHERE[f.key] || f.label);
    },
    // create the agreement if needed (or a new one after a signed one), then generate a version from the terms
    async generate(req, a) {
      await ensureStarters();
      const key = MGMT_TEMPLATE[a.ws.section]; if (!key) throw bad('No management agreement for this kind of workspace.');
      const tpl = (await pool.query('select * from agreement_templates where key = $1 and active order by version desc limit 1', [key])).rows[0];
      if (!tpl) throw bad('The management agreement template is not available.');
      if (!a.ws.party_id) throw bad(`Link the ${a.ws.section === 'props' ? 'owner' : 'client'} first.`);
      let g = await this.current(a.ws.id, a.ws.section);
      if (!g || ['signed', 'cancelled'].includes(g.status)) {
        const id = await core.inTx(async db => {
          const year = new Date().toLocaleString('en-GB', { year: 'numeric', timeZone: 'Asia/Bahrain' });
          const ref = `AGR-${year}-${String(await core.nextNumber(db, `AGR-${year}`)).padStart(3, '0')}`;
          const row = (await db.query('insert into agreements (workspace_id, template_id, ref, title, party_id, values, created_by) values ($1,$2,$3,$4,$5,$6,$7) returning id', [a.ws.id, tpl.id, ref, tpl.name, a.ws.party_id, {}, req.user.id])).rows[0];
          await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'agreement.created', entity: 'agreement', entityId: row.id, summary: `Agreement ${ref} drafted from the management terms`, ip: req.ip });
          return row.id;
        });
        g = (await pool.query('select * from agreements where id = $1', [id])).rows[0];
      } else if (g.party_id !== a.ws.party_id) await pool.query('update agreements set party_id = $2 where id = $1', [g.id, a.ws.party_id]);
      g.party_id = a.ws.party_id;
      const v = await generateVersion(req, a, g);
      // the terms point at this agreement
      await pool.query("update mgmt_terms set agreement_ref = $2 where workspace_id = $1 and status in ('draft','active') and coalesce(agreement_ref, '') <> $2", [a.ws.id, g.ref]);
      return { g, v };
    }
  };

  // Delete a version that is not needed (owner request 2026-10-24). Only while the agreement is a draft, never the
  // latest version, and the deletion is kept in the activity log. Issued and signed agreements keep every version.
  r.post('/w/:id/agreements/:aid/v/:n/delete', async (req, res) => {
    const a = await access(req, 'edit');
    const g = await loadAgreement(a, req.params.aid);
    const n = Number(req.params.n);
    if (!Number.isInteger(n) || n < 1) throw new NotFound();
    if (g.status !== 'draft') throw bad('Versions of an issued or signed agreement are kept as they are.');
    await core.inTx(async db => {
      const latest = (await db.query('select max(version) as m from agreement_versions where agreement_id = $1', [g.id])).rows[0].m;
      if (n === latest) throw bad('The latest version cannot be deleted. Generate a new one first if it is wrong.');
      const del = await db.query('delete from agreement_versions where agreement_id = $1 and version = $2', [g.id, n]);
      if (!del.rowCount) throw new NotFound();
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'agreement.version_deleted', entity: 'agreement', entityId: g.id, summary: `${g.ref} version ${n} deleted`, ip: req.ip });
    });
    const back = String(req.body.back || '');
    res.redirect(`${/^\/w\/[0-9a-f-]{36}\/(agreements|client)(\/[0-9a-f-]{36})?$/.test(back) ? back : `/w/${a.ws.id}/agreements/${g.id}`}?msg=deleted`);
  });

  r.get('/w/:id/agreements/:aid/v/:file', async (req, res) => {
    const a = await access(req);
    const g = await loadAgreement(a, req.params.aid);
    const m = /^(\d+)\.(pdf|docx)$/.exec(req.params.file); if (!m) throw new NotFound();
    const v = (await pool.query(`select ${m[2]} as data from agreement_versions where agreement_id = $1 and version = $2`, [g.id, Number(m[1])])).rows[0];
    if (!v || !v.data) throw new NotFound();
    const view = m[2] === 'pdf' && req.query.view === '1';     // Preview: open in the browser instead of downloading
    await core.audit(null, { actor: req.user, workspaceId: a.ws.id, action: view ? 'agreement.previewed' : 'agreement.downloaded', entity: 'agreement', entityId: g.id, summary: `${g.ref} v${m[1]} ${m[2].toUpperCase()} ${view ? 'previewed' : 'downloaded'}`, ip: req.ip });
    res.set({ 'Content-Type': m[2] === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Disposition': DL.disposition(DL.fileName([g.ref, a.ws.name, `v${m[1]}`], m[2]), view), 'Cache-Control': 'private, no-store' });
    res.end(v.data);
  });

  r.post('/w/:id/agreements/:aid/status', async (req, res) => {
    const a = await access(req, 'edit');
    const g = await loadAgreement(a, req.params.aid);
    const to = req.body.status;
    if (!['issued', 'cancelled'].includes(to) || ['signed', 'cancelled'].includes(g.status)) throw bad('That change is not possible.');
    if (to === 'issued' && !(await pool.query('select 1 from agreement_versions where agreement_id = $1', [g.id])).rowCount) throw bad('Generate the document first.');
    const reason = to === 'cancelled' ? txt(req.body.reason, 300) : null;
    if (to === 'cancelled' && !reason) throw bad('Give a reason.');
    await core.inTx(async db => {
      await db.query('update agreements set status = $2, cancel_reason = $3, updated_at = now() where id = $1', [g.id, to, reason]);
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: `agreement.${to}`, entity: 'agreement', entityId: g.id, summary: `Agreement ${g.ref} ${to === 'issued' ? 'issued for signature' : `cancelled: ${reason}`}`, ip: req.ip });
    });
    res.redirect(`/w/${a.ws.id}/agreements/${g.id}?msg=saved`);
  });

  r.post('/w/:id/agreements/:aid/signed', upload.single('file'), async (req, res) => {
    if (!core.checkCsrf(req)) throw new Forbidden('Your form expired. Reload the page and try again.');
    const a = await access(req, 'edit');
    const g = await loadAgreement(a, req.params.aid);
    if (['signed', 'cancelled'].includes(g.status)) throw bad('This agreement is already closed.');
    const on = /^\d{4}-\d{2}-\d{2}$/.test(req.body.signed_on || '') ? req.body.signed_on : null;
    if (!on) throw bad('Enter the signing date.');
    const f = req.file; if (!f) throw bad('Attach the signed copy.');
    const t = sniff(f.buffer, f.originalname);
    if (!t || !(t.mime === 'application/pdf' || t.image || t.mime === 'image/heic')) throw bad('The signed copy must be a PDF or a photo.');
    const thumb = t.image ? await sharp(f.buffer).rotate().resize(480, 480, { fit: 'inside' }).webp({ quality: 74 }).toBuffer() : null;
    await core.inTx(async db => {
      await db.query(`insert into files (workspace_id, entity, entity_id, original_name, mime, size, sha256, data, thumb, caption, uploaded_by) values ($1,'agreement',$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [a.ws.id, g.id, `${g.ref}-signed${t.mime === 'application/pdf' ? '.pdf' : '.' + t.mime.split('/')[1]}`, t.mime, f.size, crypto.createHash('sha256').update(f.buffer).digest('hex'), f.buffer, thumb, `Signed ${g.ref}`, req.user.id]);
      await db.query("update agreements set status = 'signed', signed_on = $2, updated_at = now() where id = $1", [g.id, on]);
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'agreement.signed', entity: 'agreement', entityId: g.id, summary: `Agreement ${g.ref} signed on ${on}; signed copy stored`, ip: req.ip });
    });
    res.redirect(`/w/${a.ws.id}/agreements/${g.id}?msg=saved`);
  });

  // ---------- administration: company details, letterhead, templates ----------
  const adminOnly = (req) => { if (!core.isSuper(req.user) && req.adminArea !== 'admin.templates') throw new NotFound(); };
  const adminTabs = [['Users', '/admin/users'], ['Roles', '/admin/roles'], ['Agreements', '/admin/agreements'], ['Master template', '/admin/master-plan'], ['Outbox', '/admin/outbox'], ['Audit log', '/admin/audit'], ['System', '/admin/system']];
  const adminPage = (req, body) => layout(req, { title: 'Agreements', heading: 'Administration', crumbs: [['Home', '/'], ['Administration']], tabs: adminTabs.map(([l, h]) => [l, h, l === 'Agreements']), body });
  const SECTION_OPTS = Object.values(SECTIONS).map(s => [s.key, s.name]);

  r.get('/admin/agreements', async (req, res) => {
    adminOnly(req); await ensureStarters();
    const co = await company();
    const tpls = (await pool.query('select t.*, (select count(*)::int from agreements g where g.template_id = t.id) as used from agreement_templates t order by t.starter, t.category, t.name')).rows;
    res.send(adminPage(req, html`
      <div class="split">
        <section class="panel grow1"><h2 class="h">Company details used in agreements</h2>
          <form method="post" action="/admin/agreements/company" class="form-grid">${csrfField(req)}
            ${[['legal_name', 'Legal name'], ['trade_name', 'Trade name'], ['cr_number', 'Commercial registration (CR)'], ['vat_number', 'VAT registration number (leave empty while not charging VAT)'], ['address', 'Address'], ['phone', 'Telephone'], ['email', 'Email'], ['signatory_name', 'Authorised signatory'], ['signatory_title', 'Signatory title']]
              .map(([k, l]) => field({ name: k, label: l, type: k === 'phone' ? 'tel' : 'text', value: co[k] || '' }))}
            <div class="actions full"><button class="btn primary" type="submit">Save</button></div></form></section>
        <section class="panel grow1"><h2 class="h">Letterhead</h2>
          <div class="notice info">Generated PDFs and Word files use the SarayDar dark heading, with the company details above in the footer of every page (owner decision, 24 Oct 2026). An uploaded letterhead image is kept here but not printed.</div>
          ${co.letterhead ? html`<img class="letterhead-preview" src="/admin/agreements/letterhead" alt="Current letterhead"><p class="muted small">${co.letterhead_name || ''}</p>` : html`<p class="muted">No letterhead yet. Documents are generated on plain paper.</p>`}
          <form method="post" action="/admin/agreements/letterhead" enctype="multipart/form-data" class="form-grid"><input type="hidden" name="_csrf" value="${req.csrfToken}">
            <label class="field full" for="f-lh"><span>Letterhead page (A4, PNG or JPG)</span><input id="f-lh" type="file" name="file" accept="image/png,image/jpeg"><small>Export the letterhead page from Word or your designer as an A4 image (about 2480 × 3508 px). It is placed behind every page.</small></label>
            ${field({ name: 'margin_top_mm', label: 'Space for the header (mm)', type: 'number', value: co.margin_top_mm, attrs: 'min="5" max="120"' })}
            ${field({ name: 'margin_bottom_mm', label: 'Space for the footer (mm)', type: 'number', value: co.margin_bottom_mm, attrs: 'min="5" max="120"' })}
            <div class="actions full"><button class="btn primary" type="submit">Save letterhead</button>${co.letterhead ? html`<button class="btn" type="submit" name="remove" value="1">Remove</button>` : ''}</div></form></section>
      </div>
      <section class="panel"><h2 class="h">Templates</h2>
        <div class="table-wrap"><table><thead><tr><th>Template</th><th>Sections</th><th>Type</th><th>Other party</th><th>Used</th><th>Status</th></tr></thead><tbody>
          ${tpls.map(t => html`<tr><td><a href="/admin/agreements/templates/${t.id}"><b>${t.name}</b></a><div class="muted small">${t.category} · v${t.version}</div></td><td class="small">${t.sections.map(s => SECTIONS[s] ? SECTIONS[s].name : s).join(', ')}</td>
            <td>${t.kind === 'docx' ? 'Word template' : t.starter ? 'Starter draft' : 'Company template'}</td><td>${t.counterparty}</td><td>${t.used}</td><td>${t.active ? pill('Active', 'ok') : pill('Hidden', 'muted')}</td></tr>`)}</tbody></table></div>
        <p class="muted small">Starter drafts are generic and carry a legal-review notice on every page. To adapt one, open it and choose “Make a company copy”, then edit the wording; company copies print without the notice.</p></section>
      <section class="panel"><h2 class="h">Upload a Word template</h2>
        <form method="post" action="/admin/agreements/templates" enctype="multipart/form-data" class="form-grid"><input type="hidden" name="_csrf" value="${req.csrfToken}">
          ${field({ name: 'name', label: 'Template name', required: true })}${field({ name: 'category', label: 'Category', required: true, hint: 'e.g. Lease, Subcontract, Mandate' })}
          ${field({ name: 'counterparty', label: 'Other party is called', required: true, hint: 'e.g. Tenant, Subcontractor, Seller' })}
          <fieldset class="full deps"><legend>Sections</legend>${SECTION_OPTS.map(([k, l]) => html`<label class="check small"><input type="checkbox" name="sections" value="${k}"> ${l}</label>`)}</fieldset>
          <label class="field full" for="f-docx"><span>Word file (.docx) <i class="req">*</i></span><input id="f-docx" type="file" name="file" required accept=".docx"><small>Write fields in double curly brackets, e.g. {{tenant_name}}, {{rent_amount}}, {{lease_start_date}}. Names ending in _amount are asked as money, _date as dates. Built-in fields: {{party.name}}, {{party.id_number}}, {{party.address}}, {{workspace.name}}, {{workspace.location}}, {{company.legal_name}}, {{agreement.ref}}, {{agreement.date}}.</small></label>
          <div class="actions full"><button class="btn primary" type="submit">Upload template</button></div></form></section>`));
  });

  r.post('/admin/agreements/company', async (req, res) => {
    adminOnly(req);
    const keys = ['legal_name', 'trade_name', 'cr_number', 'vat_number', 'address', 'phone', 'email', 'signatory_name', 'signatory_title'];
    const vals = keys.map(k => txt(req.body[k], 300));
    await core.inTx(async db => {
      await db.query(`update company_profile set ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')}, updated_by = $${keys.length + 1}, updated_at = now() where id = 1`, [...vals, req.user.id]);
      await core.audit(db, { actor: req.user, action: 'company.updated', entity: 'company_profile', entityId: '1', summary: 'Company details for agreements updated', after: Object.fromEntries(keys.map((k, i) => [k, vals[i]])), ip: req.ip });
    });
    res.redirect('/admin/agreements?msg=saved');
  });

  r.post('/admin/agreements/letterhead', upload.single('file'), async (req, res) => {
    adminOnly(req);
    if (!core.checkCsrf(req)) throw new Forbidden('Your form expired. Reload the page and try again.');
    const top = parseInt(req.body.margin_top_mm, 10), bottom = parseInt(req.body.margin_bottom_mm, 10);
    if (!(top >= 5 && top <= 120 && bottom >= 5 && bottom <= 120)) throw bad('Margins must be between 5 and 120 mm.');
    let lh = undefined;
    if (req.body.remove === '1') lh = null;
    else if (req.file) {
      const t = sniff(req.file.buffer, req.file.originalname);
      if (!t || !['image/png', 'image/jpeg'].includes(t.mime)) throw bad('The letterhead must be a PNG or JPG image.');
      const meta = await sharp(req.file.buffer).metadata();
      const ratio = meta.height / meta.width;
      if (ratio < 1.3 || ratio > 1.5) throw bad(`The image should have A4 proportions (portrait, about 1 : 1.41). This one is ${meta.width} × ${meta.height}.`);
      lh = { data: req.file.buffer, mime: t.mime, name: String(req.file.originalname).slice(-120) };
    }
    await core.inTx(async db => {
      if (lh === null) await db.query('update company_profile set letterhead = null, letterhead_mime = null, letterhead_name = null where id = 1');
      else if (lh) await db.query('update company_profile set letterhead = $1, letterhead_mime = $2, letterhead_name = $3 where id = 1', [lh.data, lh.mime, lh.name]);
      await db.query('update company_profile set margin_top_mm = $1, margin_bottom_mm = $2, updated_by = $3, updated_at = now() where id = 1', [top, bottom, req.user.id]);
      await core.audit(db, { actor: req.user, action: 'company.letterhead', entity: 'company_profile', entityId: '1', summary: lh === null ? 'Letterhead removed' : lh ? `Letterhead uploaded: ${lh.name}` : 'Letterhead margins changed', ip: req.ip });
    });
    res.redirect('/admin/agreements?msg=saved');
  });

  r.get('/admin/agreements/letterhead', async (req, res) => {
    adminOnly(req);
    const co = await company(); if (!co.letterhead) throw new NotFound();
    res.set({ 'Content-Type': co.letterhead_mime, 'Cache-Control': 'private, no-store' }); res.end(co.letterhead);
  });

  r.post('/admin/agreements/templates', upload.single('file'), async (req, res) => {
    adminOnly(req);
    if (!core.checkCsrf(req)) throw new Forbidden('Your form expired. Reload the page and try again.');
    const name = txt(req.body.name, 120), category = txt(req.body.category, 60), counterparty = txt(req.body.counterparty, 60);
    const sections = [].concat(req.body.sections || []).filter(s => SECTIONS[s]);
    if (!name || !category || !counterparty) throw bad('Enter the name, category and what the other party is called.');
    if (!sections.length) throw bad('Choose at least one section.');
    const f = req.file; if (!f) throw bad('Attach the Word file.');
    if (!/\.docx$/i.test(f.originalname) || f.buffer.subarray(0, 4).toString('hex') !== '504b0304') throw bad('Upload a .docx Word file.');
    let fields;
    try { fields = A.fieldsFor({ kind: 'docx', docx: f.buffer, fields: {} }); A.fillDocx(f.buffer, {}); }
    catch (e) { throw bad(`The Word file could not be read as a template: ${String(e.message).slice(0, 160)}. Check that each {{field}} is typed in one go without formatting changes inside the brackets.`); }
    const id = await core.inTx(async db => {
      const t = (await db.query("insert into agreement_templates (name, sections, category, counterparty, kind, docx, docx_name, created_by) values ($1,$2,$3,$4,'docx',$5,$6,$7) returning id",
        [name, sections, category, counterparty, f.buffer, String(f.originalname).slice(-120), req.user.id])).rows[0].id;
      await core.audit(db, { actor: req.user, action: 'template.uploaded', entity: 'agreement_template', entityId: t, summary: `Word template uploaded: ${name} (${fields.length} questions)`, ip: req.ip });
      return t;
    });
    res.redirect(`/admin/agreements/templates/${id}?msg=created`);
  });

  r.get('/admin/agreements/templates/:tid', async (req, res) => {
    adminOnly(req);
    const t = await loadTemplate(req.params.tid);
    const fields = A.fieldsFor(t);
    const editable = t.kind === 'text' && !t.starter;
    res.send(adminPage(req, html`<p><a href="/admin/agreements">‹ Agreements</a></p>
      <section class="panel"><div class="row-between"><h2 class="h">${t.name}</h2>${t.active ? pill('Active', 'ok') : pill('Hidden', 'muted')}</div>
        <p class="muted">${t.kind === 'docx' ? `Word template · ${t.docx_name || ''}` : t.starter ? 'Starter draft (read-only)' : 'Company template'} · version ${t.version} · other party: ${t.counterparty}</p>
        <h3 class="h3">Questions asked when preparing an agreement</h3>
        ${fields.length ? html`<ul>${fields.map(f => html`<li>${f.label} <span class="muted small">(${f.type}${f.required ? ', required' : ''}) · {{${f.key}}}</span></li>`)}</ul>` : html`<p class="muted">None besides the other party's details.</p>`}
        <div class="actions">
          ${t.kind === 'text' ? html`<form method="post" action="/admin/agreements/templates/${t.id}/duplicate">${csrfField(req)}<button class="btn" type="submit">Make a company copy</button></form>` : html`<a class="btn" href="/admin/agreements/templates/${t.id}/download">Download Word file</a>`}
          <form method="post" action="/admin/agreements/templates/${t.id}/active">${csrfField(req)}<button class="btn" type="submit">${t.active ? 'Hide from staff' : 'Make available'}</button></form></div>
      </section>
      ${t.kind === 'text' ? html`<section class="panel"><h2 class="h">${editable ? 'Edit wording' : 'Wording'}</h2>
        <form method="post" action="/admin/agreements/templates/${t.id}" class="form-grid">${csrfField(req)}
          ${editable ? html`${field({ name: 'name', label: 'Name', value: t.name, required: true })}${field({ name: 'counterparty', label: 'Other party is called', value: t.counterparty, required: true })}
            <fieldset class="full deps"><legend>Sections</legend>${SECTION_OPTS.map(([k, l]) => html`<label class="check small"><input type="checkbox" name="sections" value="${k}" ${t.sections.includes(k) ? raw('checked') : ''}> ${l}</label>`)}</fieldset>` : ''}
          <label class="field full" for="f-body"><span>Text</span><textarea id="f-body" name="body" rows="28" class="mono" ${editable ? '' : raw('readonly')}>${t.body}</textarea>
            <small># Title · ## Clause heading · blank line for a new paragraph · - bullet · {{field_name}} for a question (_amount = money, _date = date).</small></label>
          ${editable ? html`<div class="actions full"><button class="btn primary" type="submit">Save as version ${t.version + 1}</button></div>` : ''}</form></section>` : ''}`));
  });

  r.post('/admin/agreements/templates/:tid', async (req, res) => {
    adminOnly(req);
    const t = await loadTemplate(req.params.tid);
    if (t.kind !== 'text' || t.starter) throw bad('Only company text templates can be edited. Make a company copy first.');
    const body = String(req.body.body || '').slice(0, 60000);
    if (!body.trim()) throw bad('The template text is empty.');
    const name = txt(req.body.name, 120) || t.name, counterparty = txt(req.body.counterparty, 60) || t.counterparty;
    const sections = [].concat(req.body.sections || []).filter(s => SECTIONS[s]);
    if (!sections.length) throw bad('Choose at least one section.');
    await core.inTx(async db => {
      await db.query('update agreement_templates set body = $2, name = $3, counterparty = $4, sections = $5, version = version + 1, updated_at = now() where id = $1', [t.id, body, name, counterparty, sections]);
      await core.audit(db, { actor: req.user, action: 'template.updated', entity: 'agreement_template', entityId: t.id, summary: `Template ${name} saved as version ${t.version + 1}`, ip: req.ip });
    });
    res.redirect(`/admin/agreements/templates/${t.id}?msg=saved`);
  });

  r.post('/admin/agreements/templates/:tid/duplicate', async (req, res) => {
    adminOnly(req);
    const t = await loadTemplate(req.params.tid);
    if (t.kind !== 'text') throw bad('Word templates are changed by uploading a new file.');
    const id = await core.inTx(async db => {
      const n = (await db.query("insert into agreement_templates (name, sections, category, counterparty, kind, body, fields, created_by) values ($1,$2,$3,$4,'text',$5,$6,$7) returning id",
        [`${t.name} (SarayDar)`, t.sections, t.category, t.counterparty, t.body, t.fields, req.user.id])).rows[0].id;
      await core.audit(db, { actor: req.user, action: 'template.copied', entity: 'agreement_template', entityId: n, summary: `Company copy made of ${t.name}`, ip: req.ip });
      return n;
    });
    res.redirect(`/admin/agreements/templates/${id}?msg=created`);
  });

  r.post('/admin/agreements/templates/:tid/active', async (req, res) => {
    adminOnly(req);
    const t = await loadTemplate(req.params.tid);
    await core.inTx(async db => {
      await db.query('update agreement_templates set active = not active, updated_at = now() where id = $1', [t.id]);
      await core.audit(db, { actor: req.user, action: t.active ? 'template.hidden' : 'template.activated', entity: 'agreement_template', entityId: t.id, summary: `${t.name} ${t.active ? 'hidden' : 'made available'}`, ip: req.ip });
    });
    res.redirect(`/admin/agreements/templates/${t.id}?msg=saved`);
  });

  r.get('/admin/agreements/templates/:tid/download', async (req, res) => {
    adminOnly(req);
    const t = await loadTemplate(req.params.tid);
    if (t.kind !== 'docx') throw new NotFound();
    res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'Content-Disposition': `attachment; filename="${(t.docx_name || 'template.docx').replace(/"/g, '')}"` });
    res.end(t.docx);
  });
}

module.exports = { mountAgreements };
