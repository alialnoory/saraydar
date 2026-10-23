'use strict';
// Phase 7 — acceptance G (external view-only portals and invitations) and H (project-specific investors).
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const sharp = require('sharp');
const db = require('../db');
const { createApp } = require('../app');
const { client } = require('./helpers');
const { figures } = require('../portal/investors');

const URL_ = process.env.TEST_DATABASE_URL;

test('investor figures keep contributions, returns and distributions apart', () => {
  const p = { committed_minor: 50000000 };
  const tx = [
    { kind: 'contribution', status: 'confirmed', on_date: '2026-01-10', amount_minor: 10000000 },
    { kind: 'contribution', status: 'reported', on_date: '2026-01-20', amount_minor: 5000000 },
    { kind: 'capital_return', status: 'confirmed', on_date: '2026-02-01', amount_minor: 2000000 },
    { kind: 'distribution', status: 'confirmed', on_date: '2026-02-02', amount_minor: 500000 },
    { kind: 'contribution', status: 'reversed', on_date: '2026-01-05', amount_minor: 7000000 }
  ];
  const f = figures(p, tx, [{ due_on: '2026-01-31', amount_minor: 25000000 }], '2026-03-01');
  assert.equal(f.received, 10000000);            // reported and reversed transfers are not receipts
  assert.equal(f.pending, 5000000);
  assert.equal(f.net, 8000000);                  // capital returned reduces capital; the distribution does not
  assert.equal(f.distributed, 500000);
  assert.equal(f.outstanding, 40000000);
  assert.equal(f.overdue, 15000000);
});

test('external portals, invitations and investors', { skip: !URL_ && 'set TEST_DATABASE_URL to run' }, async t => {
  const pool = new Pool({ connectionString: URL_ });
  await pool.query('drop schema public cascade; create schema public;');
  await db.migrate(pool); await db.seed(pool);
  await db.ensureAdmin(pool, { ADMIN_EMAIL: 'ali@example.com', ADMIN_PASSWORD: 'admin-pass-123' });
  const server = createApp({ pool, jwtSecret: 's'.repeat(40), corsOrigins: [], env: {} }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.close(); await pool.end(); });
  const login = (c, i, p) => c.post('/login', { identifier: i, password: p }, '/login');
  const admin = client(base); await login(admin, 'ali@example.com', 'admin-pass-123');
  const q1 = async (sql, v = []) => (await pool.query(sql, v)).rows[0];
  const n = async (sql, v = []) => (await pool.query(sql, v)).rows[0].n;
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bahrain' });
  const wsOf = r => r.location.slice(3, 39);
  const tokenOf = text => (/\/invite\/([\w-]{20,})/.exec(text) || [])[1];
  const png = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#8e4f2b' } }).png().toBuffer();
  async function upload(c, path, page, fields, files) {
    const pg = await c.get(page);
    const fd = new FormData(); fd.append('_csrf', c.csrfFrom(pg.text));
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    for (const [k, name] of files) fd.append(k, new Blob([png]), name);
    return c.raw('POST', path, { multipart: fd });
  }

  let hidd, diyar, alphaParty, betaParty, alphaHidd, betaHidd, alphaDiyar;
  await t.test('H: two investors in one project, one also in a second project; no automatic equity', async () => {
    hidd = wsOf(await admin.post('/s/dev/new', { kind: 'project', name: 'Hidd Villas', location: 'Hidd' }, '/s/dev/new'));
    diyar = wsOf(await admin.post('/s/dev/new', { kind: 'project', name: 'Diyar Villas', location: 'Diyar' }, '/s/dev/new'));
    const r1 = await admin.post(`/w/${hidd}/investors`, { new_name: 'Alpha Investments WLL', new_kind: 'company', new_email: 'alpha@example.com', participation: 'unconfirmed', currency: 'BHD', committed: '50000', agreement_ref: 'IA-01' }, `/w/${hidd}/investors`);
    assert.equal(r1.status, 302, r1.text.slice(0, 300));
    alphaHidd = r1.location.split('/')[4].split('?')[0];
    alphaParty = (await q1("select id from parties where name = 'Alpha Investments WLL'")).id;
    betaHidd = (await admin.post(`/w/${hidd}/investors`, { new_name: 'Beta Holding', new_kind: 'company', participation: 'loan', currency: 'BHD', committed: '30000' }, `/w/${hidd}/investors`)).location.split('/')[4].split('?')[0];
    betaParty = (await q1("select id from parties where name = 'Beta Holding'")).id;
    alphaDiyar = (await admin.post(`/w/${diyar}/investors`, { party: alphaParty, participation: 'unconfirmed', currency: 'BHD', committed: '20000', agreement_ref: 'IA-02' }, `/w/${diyar}/investors`)).location.split('/')[4].split('?')[0];
    const a = await q1('select * from investor_participations where id = $1', [alphaHidd]);
    assert.equal(a.participation, 'unconfirmed'); assert.equal(a.ownership_terms, null); assert.equal(a.profit_terms, null); assert.equal(a.terms_confirmed, false);
    assert.equal(Number(a.committed_minor), 50000000);
    assert.equal(await n('select count(*)::int as n from investor_participations where party_id = $1', [alphaParty]), 2);
    const tab = await admin.get(`/w/${hidd}/investors`);
    assert.ok(tab.text.includes('Alpha Investments WLL') && tab.text.includes('Beta Holding') && tab.text.includes('BHD 80,000.000'));
    assert.ok(!(await admin.get(`/w/${diyar}/investors`)).text.includes(`/investors/${betaHidd}`));
    const profile = await admin.get(`/investors/${alphaParty}`);
    assert.ok(profile.text.includes('Hidd Villas') && profile.text.includes('Diyar Villas'));
  });

  await t.test('H: reported vs confirmed contributions, acknowledgment, duplicates, returns and distributions', async () => {
    const add = (pid, form) => admin.post(`/w/${hidd}/investors/${pid}/txns`, { on_date: today, method: 'Bank transfer', ...form }, `/w/${hidd}/investors/${pid}`);
    assert.equal((await add(alphaHidd, { kind: 'contribution', amount: '10000', reference: 'TR-001' })).status, 302);
    let t1 = await q1('select * from investor_txns where participation_id = $1', [alphaHidd]);
    assert.equal(t1.status, 'reported'); assert.equal(t1.ack_no, null);
    assert.equal((await add(alphaHidd, { kind: 'contribution', amount: '10000', reference: 'tr-001' })).status, 400);       // duplicate reference
    assert.equal((await admin.post(`/w/${hidd}/investors/${alphaHidd}/txns/${t1.id}/confirm`, {}, `/w/${hidd}/investors/${alphaHidd}`)).status, 302);
    t1 = await q1('select * from investor_txns where id = $1', [t1.id]);
    assert.equal(t1.status, 'confirmed'); assert.match(t1.ack_no, /^ACK-\d{4}-0001$/);
    assert.equal((await admin.get(`/w/${hidd}/investors/${alphaHidd}/ack/${t1.id}`)).status, 200);
    await add(betaHidd, { kind: 'contribution', amount: '7500', reference: 'BETA-1' });
    const tb = await q1('select id from investor_txns where participation_id = $1', [betaHidd]);
    await admin.post(`/w/${hidd}/investors/${betaHidd}/txns/${tb.id}/confirm`, {}, `/w/${hidd}/investors/${betaHidd}`);
    // returns and distributions need an approval; a distribution needs confirmed profit terms
    assert.equal((await add(alphaHidd, { kind: 'capital_return', amount: '2000', reference: 'RET-1' })).status, 400);
    assert.equal((await add(alphaHidd, { kind: 'capital_return', amount: '20000', reference: 'RET-1', approval_ref: 'Board minute 4/2026' })).status, 400);   // above net capital
    assert.equal((await add(alphaHidd, { kind: 'capital_return', amount: '2000', reference: 'RET-1', approval_ref: 'Board minute 4/2026' })).status, 302);
    assert.equal((await add(alphaHidd, { kind: 'distribution', amount: '500', reference: 'DIST-1', approval_ref: 'Board minute 5/2026' })).status, 400);
    await admin.post(`/w/${hidd}/investors/${alphaHidd}/terms`, { participation: 'profit_share', committed: '50000', status: 'active', agreement_ref: 'IA-01', profit_terms: '20% of net profit on completion', terms_confirmed: '1', change_reason: 'Signed agreement IA-01 reviewed' }, `/w/${hidd}/investors/${alphaHidd}`);
    assert.equal((await add(alphaHidd, { kind: 'distribution', amount: '500', reference: 'DIST-1', approval_ref: 'Board minute 5/2026' })).status, 302);
    const st = await admin.get(`/w/${hidd}/investors/${alphaHidd}`);
    for (const s of ['BHD 10,000.000', 'BHD 8,000.000', 'BHD 500.000', 'BHD 40,000.000', 'Board minute 5/2026']) assert.ok(st.text.includes(s), s);
    const audit = await n("select count(*)::int as n from audit_events where workspace_id = $1 and action like 'investor.%'", [hidd]);
    assert.ok(audit >= 8);
    // Finance-only actions are refused to a project contributor
    assert.equal((await admin.raw('POST', `/w/${diyar}/investors/${alphaHidd}/txns/${t1.id}/reverse`, { form: { reason: 'x', _csrf: admin.csrfFrom(st.text) } })).status, 404);   // wrong project
  });

  let invLink;
  await t.test('G: invitations need a checked recipient, are not emailed without a provider, resend replaces the link', async () => {
    const page = `/w/${hidd}/access`;
    const acc = await admin.get(page);
    assert.ok(acc.text.includes('Invite an external viewer') && acc.text.includes('Email is not configured'));
    assert.equal((await admin.post(`/w/${hidd}/invitations`, { role: 'investor_viewer', party: alphaParty, confirm: '1' }, page)).status, 400);                       // no verification note
    assert.equal((await admin.post(`/w/${hidd}/invitations`, { role: 'owner_viewer', party: alphaParty, recipient_checked: 'Phoned Mr A', confirm: '1' }, page)).status, 400);   // wrong role for a project
    assert.equal((await admin.post(`/w/${hidd}/invitations`, { role: 'investor_viewer', name: 'X', email: 'x@example.com', recipient_checked: 'Phoned Mr A', confirm: '1' }, page)).status, 400);   // investor must be linked
    assert.equal((await admin.post(`/w/${hidd}/invitations`, { role: 'investor_viewer', party: alphaParty, recipient_checked: 'Phoned', email: 'ali@example.com', confirm: '1' }, page)).status, 400);   // staff address
    const r = await admin.post(`/w/${hidd}/invitations`, { role: 'investor_viewer', party: alphaParty, name: 'Ahmed Alpha', recipient_checked: 'Confirmed by phone with Ahmed; matches agreement IA-01', confirm: '1', financials: '1' }, page);
    assert.equal(r.status, 200);
    assert.match(r.text, /Not emailed/); assert.doesNotMatch(r.text, /was accepted by the mail server/);
    const first = tokenOf(r.text); assert.ok(first);
    const inv = await q1("select i.*, o.status as delivery from invitations i join outbox_messages o on o.id = i.outbox_id where i.email = 'alpha@example.com'");
    assert.equal(inv.delivery, 'unconfigured'); assert.equal(inv.status, 'pending'); assert.notEqual(inv.token_hash, first);
    assert.deepEqual(inv.grants, { financials: true, party_id: alphaParty });
    assert.equal(await n("select count(*)::int as n from workspace_members where workspace_id = $1 and role = 'investor_viewer'", [hidd]), 0);   // no access before acceptance
    const rs = await admin.post(`/w/${hidd}/invitations/${inv.id}/resend`, {}, page);
    invLink = tokenOf(rs.text);
    assert.ok(invLink && invLink !== first);
    const anon = client(base);
    const old = await anon.get(`/invite/${first}`);
    assert.equal(old.status, 400); assert.match(old.text, /newer invitation/);
    assert.equal((await anon.get(`/invite/${invLink}`)).status, 200);
    // expired and revoked links
    const e = await admin.post(`/w/${diyar}/invitations`, { role: 'client_viewer', name: 'Late Larry', email: 'larry@example.com', recipient_checked: 'Email from his company domain', confirm: '1' }, `/w/${diyar}/access`);
    const et = tokenOf(e.text);
    await pool.query("update invitations set expires_at = now() - interval '1 minute' where email = 'larry@example.com'");
    assert.match((await anon.get(`/invite/${et}`)).text, /expired/);
    const v = await admin.post(`/w/${diyar}/invitations`, { role: 'client_viewer', name: 'Rev Rita', email: 'rita@example.com', recipient_checked: 'Met in person', confirm: '1' }, `/w/${diyar}/access`);
    const vt = tokenOf(v.text);
    await admin.post(`/w/${diyar}/invitations/${(await q1("select id from invitations where email = 'rita@example.com'")).id}/revoke`, {}, `/w/${diyar}/access`);
    assert.match((await anon.get(`/invite/${vt}`)).text, /withdrawn/);
    const list = await admin.get(`/w/${diyar}/access`);
    assert.ok(list.text.includes('Expired') && list.text.includes('Revoked'));
  });

  let inv;          // the investor's browser
  let pubPhoto, intPhoto, pubDoc, intDoc;
  await t.test('H/G: the investor activates once and sees only published progress and their own statement', async () => {
    // published updates: one shown externally (with a photo), one staff-only, one external draft
    const mk = (fields, files = []) => upload(admin, `/w/${hidd}/updates`, `/w/${hidd}/updates/new`, { observed_on: today, ...fields }, files);
    await mk({ title: 'Ground slab poured', status: 'published', external_visible: '1', completed_work: 'Slab for villas 1-2', issues: 'SECRET-ISSUE crane delay' }, [['photos', 'slab.png']]);
    await mk({ title: 'Staff-only snag list', status: 'published', completed_work: 'Internal' }, [['photos', 'snag.png']]);
    await mk({ title: 'Draft for client', status: 'draft', external_visible: '1' });
    pubPhoto = (await q1("select f.id from files f join progress_updates u on u.id::text = f.entity_id where u.title = 'Ground slab poured'")).id;
    intPhoto = (await q1("select f.id from files f join progress_updates u on u.id::text = f.entity_id where u.title = 'Staff-only snag list'")).id;
    await upload(admin, `/w/${hidd}/files`, `/w/${hidd}/documents`, { visibility: 'published', caption: 'Site plan' }, [['files', 'site-plan.png']]);
    await upload(admin, `/w/${hidd}/files`, `/w/${hidd}/documents`, { visibility: 'internal' }, [['files', 'bank-statement.png']]);
    pubDoc = (await q1("select id from files where original_name = 'site-plan.png'")).id;
    intDoc = (await q1("select id from files where original_name = 'bank-statement.png'")).id;

    inv = client(base);
    const g = await inv.get(`/invite/${invLink}`);
    assert.match(g.text, /Hidd Villas/);
    assert.equal((await inv.post(`/invite/${invLink}`, { name: 'Ahmed Alpha', password: 'short', confirm: 'short' }, `/invite/${invLink}`)).status, 400);
    const acc = await inv.post(`/invite/${invLink}`, { name: 'Ahmed Alpha', password: 'alpha-pass-123', confirm: 'alpha-pass-123' }, `/invite/${invLink}`);
    assert.equal(acc.location, `/p/${hidd}`);
    const again = await client(base).get(`/invite/${invLink}`);
    assert.equal(again.status, 400); assert.match(again.text, /already been used/);
    const u = await q1("select * from users where email = 'alpha@example.com'");
    assert.equal(u.kind, 'external'); assert.equal(u.party_id, alphaParty); assert.equal(u.must_change_password, false);

    const my = await inv.get('/my');
    assert.ok(my.text.includes('Hidd Villas')); assert.ok(!my.text.includes('Diyar Villas'));
    const ov = await inv.get(`/p/${hidd}`);
    assert.equal(ov.status, 200);
    assert.ok(ov.text.includes('Ground slab poured')); assert.ok(!ov.text.includes('Staff-only snag list')); assert.ok(!ov.text.includes('Draft for client'));
    assert.ok(!ov.text.includes('SECRET-ISSUE'));
    assert.ok(!ov.text.includes('Access &amp; Invitations') && !ov.text.includes('Budget'));
    const prog = await inv.get(`/p/${hidd}/progress`);
    assert.ok(prog.text.includes('Slab for villas 1-2') && !prog.text.includes('SECRET-ISSUE'));
    assert.equal((await inv.raw('GET', `/files/${pubPhoto}/thumb`)).status, 200);
    assert.equal((await inv.raw('GET', `/files/${pubPhoto}`)).status, 200);
    assert.equal((await inv.raw('GET', `/files/${intPhoto}/thumb`)).status, 404);
    assert.equal((await inv.raw('GET', `/files/${pubDoc}`)).status, 200);
    assert.equal((await inv.raw('GET', `/files/${intDoc}`)).status, 404);
    const docs = await inv.get(`/p/${hidd}/documents`);
    assert.ok(docs.text.includes('site-plan.png') && !docs.text.includes('bank-statement.png'));

    const st = await inv.get(`/p/${hidd}/statement`);
    assert.equal(st.status, 200);
    for (const s of ['Alpha Investments WLL', 'BHD 10,000.000', 'BHD 8,000.000', 'BHD 500.000']) assert.ok(st.text.includes(s), s);
    assert.ok(!st.text.includes('Beta Holding') && !st.text.includes('7,500'));
    assert.ok(!st.text.includes('BHD 20,000.000'));                         // the Diyar participation is not shown
    // the second project, staff pages, investor profiles and other workspaces are unreachable
    assert.equal((await inv.get(`/p/${diyar}`)).status, 404);
    assert.equal((await inv.get(`/w/${diyar}/investors`)).location, `/p/${diyar}`);
    assert.equal((await inv.get(`/w/${hidd}/investors`)).location, `/p/${hidd}`);
    assert.equal((await inv.get(`/investors/${alphaParty}`)).status, 404);
    assert.equal((await inv.get('/s/dev')).location, '/my');
    assert.equal((await inv.get('/search?q=Diyar')).location, '/my');
    assert.equal((await inv.get('/admin/outbox')).status, 404);
    assert.equal((await inv.get(`/p/${hidd}/budget`)).status, 404);
    // no export without the separate grant
    assert.equal((await inv.raw('GET', `/p/${hidd}/statement?export=pdf`)).status, 403);
    assert.doesNotMatch(st.text, /export=pdf/);
  });

  await t.test('G: view-only — every write is refused and nothing changes', async () => {
    const tok = inv.csrfFrom((await inv.get('/account')).text);
    const before = await q1('select (select count(*) from investor_txns) as t, (select count(*) from progress_updates) as u, (select count(*) from files) as f, (select count(*) from workspace_members) as m');
    const tx = await q1('select id from investor_txns where participation_id = $1 limit 1', [alphaHidd]);
    for (const [path, form] of [
      [`/w/${hidd}/investors/${alphaHidd}/txns`, { kind: 'contribution', amount: '1', reference: 'x', on_date: today }],
      [`/w/${hidd}/investors/${alphaHidd}/txns/${tx.id}/confirm`, {}], [`/w/${hidd}/invitations`, { role: 'investor_viewer', party: alphaParty }],
      [`/w/${hidd}/access/grants`, { user: (await q1("select id from users where email = 'alpha@example.com'")).id, export: '1' }],
      [`/w/${hidd}/updates/x/external`, { on: '1' }], [`/w/${hidd}/edit`, { name: 'x' }], [`/p/${hidd}`, {}]]) {
      assert.equal((await inv.raw('POST', path, { form: { ...form, _csrf: tok } })).status, 403, path);
    }
    const after = await q1('select (select count(*) from investor_txns) as t, (select count(*) from progress_updates) as u, (select count(*) from files) as f, (select count(*) from workspace_members) as m');
    assert.deepEqual(after, before);
  });

  await t.test('G: export is a separate grant; staff can preview; revocation is immediate and keeps history', async () => {
    const uid = (await q1("select id from users where email = 'alpha@example.com'")).id;
    await admin.post(`/w/${hidd}/access/grants`, { user: uid, financials: '1', export: '1' }, `/w/${hidd}/access`);
    assert.deepEqual((await q1('select grants from workspace_members where workspace_id = $1 and user_id = $2', [hidd, uid])).grants, { financials: true, export: true, party_id: alphaParty });
    const pdf = await inv.raw('GET', `/p/${hidd}/statement?export=pdf`);
    assert.equal(pdf.status, 200);
    assert.equal(Buffer.from(await pdf.res.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
    assert.equal(await n("select count(*)::int as n from audit_events where action = 'export.pdf' and actor_id = $1", [uid]), 1);
    // staff preview of exactly what an investor sees
    const pv = await admin.get(`/p/${hidd}/statement?preview=investor_viewer&g_financials=1&party=${betaParty}`);
    assert.equal(pv.status, 200);
    assert.ok(pv.text.includes('Preview as Investor Viewer') && pv.text.includes('Beta Holding') && !pv.text.includes('Alpha Investments'));
    // revoke
    await admin.post(`/w/${hidd}/access/revoke`, { user: uid }, `/w/${hidd}/access`);
    assert.equal((await inv.get(`/p/${hidd}`)).status, 404);
    assert.equal((await inv.raw('GET', `/files/${pubPhoto}`)).status, 404);
    assert.ok(!(await inv.get('/my')).text.includes('Hidd Villas'));
    assert.equal(await n('select count(*)::int as n from investor_txns where participation_id = $1', [alphaHidd]), 3);       // history kept
    assert.ok((await admin.get(`/w/${hidd}/investors/${alphaHidd}`)).text.includes('Removed'));
  });

  await t.test('G: one external account with several assigned workspaces across sections, each published-only', async () => {
    const cpm = wsOf(await admin.post('/s/cpm/new', { kind: 'client_project', name: 'Client Villa Saar', party: 'Noor Family', location: 'Saar' }, '/s/cpm/new'));
    const prop = wsOf(await admin.post('/s/props/new', { kind: 'property', name: 'Seef Tower', party: 'Noor Family', location: 'Seef' }, '/s/props/new'));
    const listing = wsOf(await admin.post('/s/sales/new', { kind: 'listing', name: 'Amwaj Villa 7', party: 'Noor Family', location: 'Amwaj' }, '/s/sales/new?kind=listing'));
    const request = wsOf(await admin.post('/s/sales/new', { kind: 'request', name: 'Noor family home search', party: 'Noor Family', location: 'Saar' }, '/s/sales/new?kind=request'));
    const other = wsOf(await admin.post('/s/props/new', { kind: 'property', name: 'Unrelated Building', party: 'Someone Else', location: 'Juffair' }, '/s/props/new'));
    const noor = (await q1("select id from parties where name = 'Noor Family'")).id;
    // records: some published/visible, some not
    await pool.query("insert into client_approvals (workspace_id, subject, title, requested_on, status, client_visible) values ($1,'budget','Approved budget v2',$2,'approved',true), ($1,'budget','HIDDEN-APPROVAL',$2,'requested',false)", [cpm, today]);
    await pool.query("insert into units (workspace_id, ref, unit_type, status) values ($1,'101','2BR','occupied'), ($1,'102','2BR','available')", [prop]);
    await pool.query("insert into maint_requests (workspace_id, ref, category, title, reported_on, owner_visible) values ($1,'MR-1','AC','Lobby AC repair',$2,true), ($1,'MR-2','Other','HIDDEN-MAINT',$2,false)", [prop, today]);
    await pool.query("insert into listings (workspace_id, status, description, asking_minor, min_price_minor, access_notes) values ($1,'available','Sea-facing villa',250000000,199999000,'SECRET-KEYBOX 4411') on conflict (workspace_id) do update set status = excluded.status, description = excluded.description, asking_minor = excluded.asking_minor, min_price_minor = excluded.min_price_minor, access_notes = excluded.access_notes", [listing]);
    await pool.query("insert into files (workspace_id, entity, entity_id, tag, original_name, mime, size, sha256, data, thumb) values ($1,'listing',$3,'published','front.png','image/png',1,'a',$2,$2), ($1,'listing',$3,'internal','title-deed.png','image/png',1,'b',$2,$2)", [listing, png, listing]);
    await pool.query("insert into marketing_activities (workspace_id, channel, status, published_on, cost_minor) values ($1,'Property portal','published',$2, 99000), ($1,'HIDDEN-CHANNEL','planned',null,null)", [listing, today]);
    await pool.query("insert into request_briefs (workspace_id, version, types, locations, budget_max_minor) values ($1,1,'Villa','Saar, Janabiya',300000000)", [request]);
    await pool.query("insert into shortlist_items (workspace_id, listing_ws, rank, reason, internal_notes, published, status) values ($1,$2,1,'Matches budget and area','SECRET-NOTE seller will drop',true,'shared')", [request, listing]);
    const extOpp = (await q1("insert into external_opps (workspace_id, title, source, location, price_minor, arrangement) values ($1,'UNPUBLISHED-OPTION','Gulf Agents','Janabiya',1,'Co-broker 50/50') returning id", [request])).id;
    await pool.query("insert into shortlist_items (workspace_id, external_id, rank, published, status) values ($1,$2,2,false,'proposed')", [request, extOpp]);

    const invite = async (ws, role, extra = {}) => {
      const r = await admin.post(`/w/${ws}/invitations`, { role, party: noor, name: 'Noor Hassan', email: 'noor@example.com', recipient_checked: 'Known client; confirmed by phone', confirm: '1', ...extra }, `/w/${ws}/access`);
      assert.equal(r.status, 200, r.text.slice(0, 400));
      return tokenOf(r.text);
    };
    const noorC = client(base);
    const t1 = await invite(cpm, 'client_viewer', { financials: '1' });
    assert.equal((await noorC.post(`/invite/${t1}`, { name: 'Noor Hassan', password: 'noor-pass-123', confirm: 'noor-pass-123' }, `/invite/${t1}`)).location, `/p/${cpm}`);
    // further invitations are accepted with the existing password
    for (const [ws, role] of [[prop, 'owner_viewer'], [listing, 'seller_viewer'], [request, 'buyer_viewer']]) {
      const tk = await invite(ws, role);
      const g = await noorC.get(`/invite/${tk}`);
      assert.match(g.text, /already have a SarayDar login/);
      assert.equal((await noorC.post(`/invite/${tk}`, { password: 'wrong-password' }, `/invite/${tk}`)).status, 400);
      assert.equal((await noorC.post(`/invite/${tk}`, { password: 'noor-pass-123' }, `/invite/${tk}`)).location, `/p/${ws}`);
    }
    const my = await noorC.get('/my');
    for (const s of ['Client Villa Saar', 'Seef Tower', 'Amwaj Villa 7', 'Noor family home search', 'Projects', 'Properties', 'Sales &amp; Acquisitions']) assert.ok(my.text.includes(s), s);
    assert.ok(!my.text.includes('Unrelated Building') && !my.text.includes('Hidd Villas'));
    assert.ok((await noorC.get('/my?q=seef')).text.includes('Seef Tower'));
    assert.ok(!(await noorC.get('/my?q=seef')).text.includes('Amwaj'));
    assert.equal((await noorC.get(`/p/${other}`)).status, 404);

    const ap = await noorC.get(`/p/${cpm}/approvals`);
    assert.ok(ap.text.includes('Approved budget v2') && !ap.text.includes('HIDDEN-APPROVAL'));
    assert.equal((await noorC.get(`/p/${cpm}/statement`)).status, 200);
    assert.equal((await noorC.get(`/p/${prop}/statement`)).status, 404);          // owner statement not granted
    const un = await noorC.get(`/p/${prop}/units`);
    assert.ok(un.text.includes('101') && un.text.includes('Occupied'));
    const mt = await noorC.get(`/p/${prop}/maintenance`);
    assert.ok(mt.text.includes('Lobby AC repair') && !mt.text.includes('HIDDEN-MAINT'));
    const lv = await noorC.get(`/p/${listing}`);
    assert.ok(lv.text.includes('Sea-facing villa') && lv.text.includes('BHD 250,000.000'));
    assert.ok(!lv.text.includes('199,999') && !lv.text.includes('SECRET-KEYBOX') && !lv.text.includes('title-deed'));
    const mk = await noorC.get(`/p/${listing}/activity`);
    assert.ok(mk.text.includes('Property portal') && !mk.text.includes('HIDDEN-CHANNEL') && !mk.text.includes('99.000'));
    assert.equal((await noorC.get(`/p/${listing}/offers`)).status, 404);         // offers need their own grant
    const front = (await q1("select id from files where original_name = 'front.png'")).id;
    const deed = (await q1("select id from files where original_name = 'title-deed.png'")).id;
    assert.equal((await noorC.raw('GET', `/files/${front}/thumb`)).status, 200);
    assert.equal((await noorC.raw('GET', `/files/${deed}/thumb`)).status, 404);
    const sl = await noorC.get(`/p/${request}/shortlist`);
    assert.ok(sl.text.includes('Amwaj Villa 7') && sl.text.includes('Matches budget and area'));
    assert.ok(!sl.text.includes('SECRET-NOTE') && !sl.text.includes('UNPUBLISHED-OPTION') && !sl.text.includes('Co-broker') && !sl.text.includes('199,999'));
    const crit = await noorC.get(`/p/${request}`);
    assert.ok(crit.text.includes('Saar, Janabiya'));
    // a different buyer who is not on that shortlist cannot open the listing photo
    const stranger = client(base);
    const st = await admin.post(`/w/${other}/invitations`, { role: 'owner_viewer', name: 'Stranger', email: 'stranger@example.com', recipient_checked: 'Phone', confirm: '1' }, `/w/${other}/access`);
    const stk = tokenOf(st.text);
    await stranger.post(`/invite/${stk}`, { name: 'Stranger', password: 'stranger-pass-1', confirm: 'stranger-pass-1' }, `/invite/${stk}`);
    assert.equal((await stranger.raw('GET', `/files/${front}/thumb`)).status, 404);
    assert.equal((await stranger.get(`/p/${listing}`)).status, 404);
    // a tenant-only or unassigned path never shows up in search or staff dashboards
    assert.equal((await noorC.get('/')).location, '/my');
  });
});
