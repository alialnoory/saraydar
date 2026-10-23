'use strict';
// Agreements & contracts. Needs TEST_DATABASE_URL for the integration part.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const sharp = require('sharp');
const PizZip = require('pizzip');
const docx = require('docx');
const db = require('../db');
const { createApp } = require('../app');
const sec = require('../lib/security');
const A = require('../lib/agreements');
const { client } = require('./helpers');

const URL_ = process.env.TEST_DATABASE_URL;
const SECRET = 'r'.repeat(40);
const docText = buf => new PizZip(buf).file('word/document.xml').asText().replace(/<[^>]+>/g, '');

test('template fields: built-ins filled by the system, the rest asked with sensible types', () => {
  const tpl = { kind: 'text', body: 'Hello {{party.name}} rent {{rent_amount}} from {{lease_start_date}} for {{term_months}} months, {{notes}} {{workspace.name}}', fields: { notes: { label: 'Notes', required: true } } };
  const f = A.fieldsFor(tpl);
  assert.deepEqual(f.map(x => [x.key, x.type]), [['rent_amount', 'money'], ['lease_start_date', 'date'], ['term_months', 'number'], ['notes', 'textarea']]);
  const vals = A.readValues(f, { v_rent_amount: '250', v_lease_start_date: '2026-11-01', v_term_months: '12' });
  assert.equal(vals.rent_amount, 250000);
  assert.deepEqual(A.missingRequired(f, vals).map(x => x.key), ['notes']);
  const map = A.resolve(f, vals, A.builtins({ party: { name: 'Huda' }, ws: { name: 'Tower A' } }));
  assert.equal(A.fill(tpl.body, map), 'Hello Huda rent BHD 250.000 from 1 November 2026 for 12 months, __________ Tower A');
  assert.throws(() => A.readValues(f, { v_lease_start_date: 'soon' }), /must be a date/);
});

test('agreements', { skip: !URL_ && 'set TEST_DATABASE_URL to run' }, async t => {
  const pool = new Pool({ connectionString: URL_ });
  await pool.query('drop schema public cascade; create schema public;');
  await db.migrate(pool); await db.seed(pool);
  await db.ensureAdmin(pool, { ADMIN_EMAIL: 'ali@example.com', ADMIN_PASSWORD: 'admin-pass-123' });
  const server = createApp({ pool, jwtSecret: SECRET, corsOrigins: [], env: { REQUIRE_MFA: '1' } }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.close(); await pool.end(); });
  const login = (c, i, p) => c.post('/login', { identifier: i, password: p }, '/login');
  const admin = client(base);
  await login(admin, 'ali@example.com', 'admin-pass-123');
  await admin.get('/mfa/setup');
  const s = (await pool.query("select mfa_secret from users where email = 'ali@example.com'")).rows[0].mfa_secret;
  await admin.post('/mfa/setup', { code: sec.totpAt(sec.decrypt(SECRET, s), Math.floor(Date.now() / 30000)) });
  const mk = async (email, role, pw) => {
    await admin.post('/admin/users', { name: email.split('@')[0], email, kind: 'internal', system_role: role, password: 'temp-pass-123' }, '/admin/users');
    const c = client(base); await login(c, email, 'temp-pass-123');
    await c.post('/account/password', { current: 'temp-pass-123', password: pw, confirm: pw }, '/account/password');
    return c;
  };
  const pm = await mk('pm@example.com', 'project_manager', 'pm-password-1');
  const eng = await mk('eng@example.com', 'engineer', 'eng-password-1');
  const upload = async (c, path, page, fields, file) => {
    const p = await c.get(page); const fd = new FormData(); fd.append('_csrf', c.csrfFrom(p.text));
    for (const [k, v] of Object.entries(fields)) for (const x of [].concat(v)) fd.append(k, x);
    if (file) fd.append(file.name, new Blob([file.data]), file.filename);
    return c.raw('POST', path, { multipart: fd });
  };

  let prop, other, agr;
  await t.test('company details and A4 letterhead', async () => {
    await admin.post('/admin/agreements/company', { legal_name: 'SarayDar Real Estate W.L.L.', trade_name: 'SarayDar', cr_number: '12345-1', address: 'Manama, Bahrain', phone: '', email: 'info@saraydar.com', signatory_name: 'Ali Alnoory', signatory_title: 'Managing Director' }, '/admin/agreements');
    const wide = await sharp({ create: { width: 800, height: 400, channels: 3, background: '#fff' } }).png().toBuffer();
    assert.equal((await upload(admin, '/admin/agreements/letterhead', '/admin/agreements', { margin_top_mm: '45', margin_bottom_mm: '30' }, { name: 'file', data: wide, filename: 'lh.png' })).status, 400);
    const a4 = await sharp({ create: { width: 1240, height: 1754, channels: 3, background: '#f6efe8' } }).composite([{ input: Buffer.from('<svg width="1240" height="200"><rect width="1240" height="200" fill="#140D0A"/></svg>'), top: 0, left: 0 }]).png().toBuffer();
    assert.equal((await upload(admin, '/admin/agreements/letterhead', '/admin/agreements', { margin_top_mm: '40', margin_bottom_mm: '25' }, { name: 'file', data: a4, filename: 'letterhead.png' })).location, '/admin/agreements?msg=saved');
    assert.ok((await pool.query('select letterhead is not null as ok from company_profile')).rows[0].ok);
    assert.equal((await pm.get('/admin/agreements')).status, 404);
  });

  await t.test('starter templates appear per section', async () => {
    prop = (await pm.post('/s/props/new', { kind: 'property', name: 'Juffair Building 112', party: 'Al Reem Real Estate', location: 'Juffair' }, '/s/props/new')).location.slice(3, 39);
    other = (await pm.post('/s/props/new', { kind: 'property', name: 'Other Building' }, '/s/props/new')).location.slice(3, 39);
    const list = await pm.get(`/w/${prop}/agreements`);
    assert.match(list.text, /Residential Lease Agreement/);
    assert.match(list.text, /Property Management Agreement/);
    assert.doesNotMatch(list.text, /Subcontract Agreement/);       // not offered for property management
    assert.equal((await eng.get(`/w/${prop}/agreements`)).status, 404);
  });

  await t.test('prepare a lease: party details asked, required terms enforced, PDF and Word generated', async () => {
    const tpl = (await pool.query("select id from agreement_templates where key = 'lease_residential'")).rows[0].id;
    const form = await pm.get(`/w/${prop}/agreements/new?template=${tpl}`);
    assert.match(form.text, /Tenant/);
    assert.match(form.text, /Monthly rent/);
    const r = await pm.post(`/w/${prop}/agreements`, { template: tpl, title: 'Lease — Apartment 13', party_id: '', party_kind: 'person', p_name: 'Huda Ahmed', p_id_number: '880101234', p_address: 'Riffa', p_phone: '+973 3300 0000', p_email: 'huda@example.com',
      v_unit: 'Apartment 13', v_rent_amount: '250', v_landlord_name: 'Al Reem Real Estate', v_agreement_date: '2026-11-01' }, `/w/${prop}/agreements/new?template=${tpl}`);
    assert.match(r.location, new RegExp(`^/w/${prop}/agreements/[0-9a-f-]{36}\\?msg=created$`));
    agr = r.location.split('/')[4].split('?')[0];
    const ref = (await pool.query('select ref from agreements where id = $1', [agr])).rows[0].ref;
    assert.match(ref, /^AGR-\d{4}-001$/);
    assert.equal((await pm.post(`/w/${prop}/agreements/${agr}/generate`, {}, `/w/${prop}/agreements/${agr}`)).status, 400);   // lease dates, due day missing
    const page = await pm.get(`/w/${prop}/agreements/${agr}`);
    assert.match(page.text, /To generate: .*Lease start/);
    const party = (await pool.query("select id from parties where name = 'Huda Ahmed'")).rows[0].id;
    await pm.post(`/w/${prop}/agreements/${agr}`, { title: 'Lease — Apartment 13', party_id: party, party_kind: 'person', p_name: 'Huda Ahmed', p_id_number: '880101234', p_address: 'Riffa', p_phone: '', p_email: 'huda@example.com',
      v_unit: 'Apartment 13', v_rent_amount: '250', v_landlord_name: 'Al Reem Real Estate', v_agreement_date: '2026-11-01', v_lease_start_date: '2026-11-01', v_lease_end_date: '2027-10-31', v_due_day: '1', v_deposit_amount: '250' }, `/w/${prop}/agreements/${agr}/edit`);
    assert.equal((await pm.post(`/w/${prop}/agreements/${agr}/generate`, {}, `/w/${prop}/agreements/${agr}`)).location, `/w/${prop}/agreements/${agr}?msg=created#v1`);
    const pdf = await pm.raw('GET', `/w/${prop}/agreements/${agr}/v/1.pdf`);
    assert.equal(pdf.status, 200);
    const pb = Buffer.from(await pdf.res.arrayBuffer());
    assert.equal(pb.subarray(0, 5).toString(), '%PDF-');
    const w = await pm.raw('GET', `/w/${prop}/agreements/${agr}/v/1.docx`);
    const text = docText(Buffer.from(await w.res.arrayBuffer()));
    for (const s of ['Residential Lease Agreement', 'Huda Ahmed', '880101234', 'BHD 250.000', '1 November 2026', 'Juffair Building 112', 'SarayDar Real Estate W.L.L.', 'STARTER DRAFT']) assert.ok(text.includes(s), s);
    assert.ok(text.includes('__________'));                      // optional blanks left for hand completion, never invented
    assert.equal((await pm.raw('GET', `/w/${other}/agreements/${agr}/v/1.pdf`)).status, 404);   // another workspace's URL
  });

  await t.test('issue, record the signed copy, then the agreement is locked', async () => {
    await pm.post(`/w/${prop}/agreements/${agr}/status`, { status: 'issued' }, `/w/${prop}/agreements/${agr}`);
    const pdf = Buffer.from('%PDF-1.4\n% signed copy\n');
    const r = await upload(pm, `/w/${prop}/agreements/${agr}/signed`, `/w/${prop}/agreements/${agr}`, { signed_on: '2026-11-02' }, { name: 'file', data: pdf, filename: 'signed.pdf' });
    assert.equal(r.location, `/w/${prop}/agreements/${agr}?msg=saved`);
    const g = (await pool.query('select status, signed_on from agreements where id = $1', [agr])).rows[0];
    assert.equal(g.status, 'signed');
    assert.equal((await pm.post(`/w/${prop}/agreements/${agr}/generate`, {}, `/w/${prop}/agreements/${agr}`)).status, 400);
    assert.equal((await pm.get(`/w/${prop}/agreements/${agr}/edit`)).status, 400);
    const acts = (await pool.query("select action from audit_events where entity_id = $1 order by id", [agr])).rows.map(x => x.action);
    for (const a of ['agreement.created', 'agreement.updated', 'agreement.generated', 'agreement.issued', 'agreement.signed']) assert.ok(acts.includes(a), a);
  });

  await t.test('your own Word template: fields detected and filled, formatting kept', async () => {
    const d = new docx.Document({ sections: [{ children: [
      new docx.Paragraph({ children: [new docx.TextRun({ text: 'MAINTENANCE ORDER {{agreement.ref}}', bold: true })] }),
      new docx.Paragraph({ children: [new docx.TextRun('Contractor: {{party.name}}, property {{workspace.name}}. Price {{price_amount}} by {{finish_date}}.')] })] }] });
    const buf = await docx.Packer.toBuffer(d);
    const r = await upload(admin, '/admin/agreements/templates', '/admin/agreements', { name: 'SarayDar Maintenance Order', category: 'Service contract', counterparty: 'Contractor', sections: ['props'] }, { name: 'file', data: buf, filename: 'order.docx' });
    assert.match(r.location, /^\/admin\/agreements\/templates\/[0-9a-f-]{36}\?msg=created$/);
    const tid = r.location.split('/')[4].split('?')[0];
    const tp = await admin.get(`/admin/agreements/templates/${tid}`);
    assert.match(tp.text, /Price <span[^>]*>\(money/);
    assert.match(tp.text, /Finish date <span[^>]*>\(date/);
    const c = await pm.post(`/w/${prop}/agreements`, { template: tid, title: 'Order 1', party_id: '', party_kind: 'company', p_name: 'Gulf Maintenance Co.', v_price_amount: '1,250.5', v_finish_date: '2026-12-15' }, `/w/${prop}/agreements/new?template=${tid}`);
    const id = c.location.split('/')[4].split('?')[0];
    await pm.post(`/w/${prop}/agreements/${id}/generate`, {}, `/w/${prop}/agreements/${id}`);
    const out = await pm.raw('GET', `/w/${prop}/agreements/${id}/v/1.docx`);
    const text = docText(Buffer.from(await out.res.arrayBuffer()));
    assert.ok(text.includes('Gulf Maintenance Co.') && text.includes('BHD 1,250.500') && text.includes('15 December 2026') && text.includes('Juffair Building 112'));
    assert.equal((await pm.raw('GET', `/w/${prop}/agreements/${id}/v/1.pdf`)).status, 404);    // Word templates produce Word only
    const bad = await upload(admin, '/admin/agreements/templates', '/admin/agreements', { name: 'x', category: 'x', counterparty: 'x', sections: ['props'] }, { name: 'file', data: Buffer.from('not a docx'), filename: 'x.docx' });
    assert.equal(bad.status, 400);
  });

  await t.test('company copy of a starter: editable, versioned, no review notice', async () => {
    const tpl = (await pool.query("select id from agreement_templates where key = 'maintenance_contract'")).rows[0].id;
    const d = await admin.post(`/admin/agreements/templates/${tpl}/duplicate`, {}, `/admin/agreements/templates/${tpl}`);
    const copy = d.location.split('/')[4].split('?')[0];
    assert.equal((await admin.post(`/admin/agreements/templates/${tpl}`, { body: 'x' }, `/admin/agreements/templates/${tpl}`)).status, 400);   // starters are read-only
    const cur = (await pool.query('select body from agreement_templates where id = $1', [copy])).rows[0].body;
    await admin.post(`/admin/agreements/templates/${copy}`, { name: 'Maintenance Contract (SarayDar)', counterparty: 'Service provider', sections: 'props', body: cur.replace('## Records', '## Records and reports') }, `/admin/agreements/templates/${copy}`);
    assert.equal((await pool.query('select version from agreement_templates where id = $1', [copy])).rows[0].version, 2);
    const c = await pm.post(`/w/${prop}/agreements`, { template: copy, title: 'Cleaning', party_id: '', party_kind: 'company', p_name: 'Clean Co', v_services: 'Weekly cleaning', v_fee_amount: '300', v_start_date: '2026-11-01', v_agreement_date: '2026-11-01' }, `/w/${prop}/agreements/new?template=${copy}`);
    const id = c.location.split('/')[4].split('?')[0];
    await pm.post(`/w/${prop}/agreements/${id}/generate`, {}, `/w/${prop}/agreements/${id}`);
    const text = docText(Buffer.from(await (await pm.raw('GET', `/w/${prop}/agreements/${id}/v/1.docx`)).res.arrayBuffer()));
    assert.ok(text.includes('Records and reports'));
    assert.ok(!text.includes('STARTER DRAFT'));
  });
});
