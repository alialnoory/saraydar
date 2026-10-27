'use strict';
// Phase 6 — Property Sales & Acquisition (acceptance I and the 9.14 seller and buyer flows).
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const db = require('../db');
const { createApp } = require('../app');
const matching = require('../lib/matching');
const { client } = require('./helpers');

const URL_ = process.env.TEST_DATABASE_URL;

test('matching reports matched / not matched / unknown and never guesses', () => {
  const brief = { types: 'Land', locations: 'Saar, Budaiya', budget_min_minor: 50000000, budget_max_minor: 80000000, currency: 'BHD', flexibility_pct: 5, land_min_m2: 400 };
  const m = matching.match(brief, { property_type: 'Land', location: 'Saar, block 527', asking_minor: 82000000, currency: 'BHD', land_area_m2: null, status: 'available' });
  const by = Object.fromEntries(m.criteria.map(c => [c.label, c.state]));
  assert.deepEqual(by, { 'Property type': 'match', Location: 'match', Budget: 'match', 'Land area': 'unknown', Availability: 'match' });   // 82k within 80k + 5%
  assert.equal(matching.match({ ...brief, flexibility_pct: 0 }, { property_type: 'Land', location: 'Saar', asking_minor: 82000000, currency: 'BHD', status: 'available' }).criteria.find(c => c.label === 'Budget').state, 'no');
  assert.equal(matching.match(brief, { property_type: 'Land', location: 'Saar', asking_minor: 1, currency: 'USD', status: 'available' }).criteria.find(c => c.label === 'Budget').state, 'unknown');
});

test('property sales and acquisition', { skip: !URL_ && 'set TEST_DATABASE_URL to run' }, async t => {
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
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bahrain' });
  const wsOf = r => r.location.slice(3, 39);
  const pdf = async p => { const r = await admin.raw('GET', p); return r.status === 200 ? Buffer.from(await r.res.arrayBuffer()).subarray(0, 5).toString() : r.status; };
  const tomorrow10 = (() => { const d = new Date(Date.now() + 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Bahrain' }); return `${d}T10:00`; })();

  async function availableListing(name, seller, file, priceBhd, feePct = '2') {
    const ws = wsOf(await admin.post('/s/sales/new', { kind: 'listing', name, party: seller, location: file.location }, '/s/sales/new?kind=listing'));
    await admin.post(`/w/${ws}/mandate`, { scope: 'Market and sell', exclusive: 'exclusive', start_date: today, end_date: '2027-12-31', fee_type: 'percent', fee_pct: feePct, fee_base: 'final_price', fee_payer: 'Seller', fee_trigger: 'completion', tax_mode: 'none', marketing_budget: '500' }, `/w/${ws}/mandate`);
    const mid = (await q1('select id from sale_mandates where workspace_id = $1', [ws])).id;
    await admin.post(`/w/${ws}/mandate/${mid}/activate`, {}, `/w/${ws}/mandate`);
    await admin.post(`/w/${ws}/mandate/${mid}/verify`, { evidence: 'Title deed and CPR seen' }, `/w/${ws}/mandate`);
    await admin.post(`/w/${ws}/listing`, file, `/w/${ws}/listing`);
    await admin.post(`/w/${ws}/listing/verify`, { evidence: 'Survey map and deed checked' }, `/w/${ws}/listing`);
    await admin.post(`/w/${ws}/listing/price`, { asking: priceBhd, effective_on: today, reason: 'Initial price', authorization: 'Seller signed mandate' }, `/w/${ws}/listing`);
    await admin.post(`/w/${ws}/listing/status`, { to: 'ready', reason: 'Checked' }, `/w/${ws}/listing`);
    const r = await admin.post(`/w/${ws}/listing/status`, { to: 'available', reason: 'Launch' }, `/w/${ws}/listing`);
    assert.equal(r.status, 302, r.text);
    return ws;
  }

  let villa, b1, b2, offerId, dealWs;
  await t.test('seller: mandate gates activity; property file with confidential minimum; price and status history', async () => {
    villa = wsOf(await admin.post('/s/sales/new', { kind: 'listing', name: 'Saar Villa 12', party: 'Khalid Owner', location: 'Saar' }, '/s/sales/new?kind=listing'));
    // nothing can be marketed before an active, verified mandate
    assert.equal((await admin.post(`/w/${villa}/marketing`, { channel: 'Portal' }, `/w/${villa}/marketing`)).status, 400);
    await admin.post(`/w/${villa}/mandate`, { scope: 'Sell the villa', exclusive: 'exclusive', start_date: today, end_date: '2027-06-30', fee_type: 'percent', fee_pct: '2', fee_base: 'final_price', fee_payer: 'Seller', fee_trigger: 'completion', tax_mode: 'none', marketing_budget: '800' }, `/w/${villa}/mandate`);
    const mid = (await q1('select id from sale_mandates where workspace_id = $1', [villa])).id;
    await admin.post(`/w/${villa}/mandate/${mid}/activate`, {}, `/w/${villa}/mandate`);
    assert.equal((await admin.post(`/w/${villa}/marketing`, { channel: 'Portal' }, `/w/${villa}/marketing`)).status, 400);     // authority not verified yet
    await admin.post(`/w/${villa}/mandate/${mid}/verify`, { evidence: 'Title deed and CPR seen' }, `/w/${villa}/mandate`);
    await admin.post(`/w/${villa}/listing`, { property_type: 'Villa', location: 'Saar, block 527', land_area_m2: '420', built_area_m2: '380', bedrooms: '5', negotiable: 'yes', min_price: '140000', description: 'Five-bedroom villa with garden.', title_info: 'Deed 12345' }, `/w/${villa}/listing`);
    // cannot go available before verification and a price
    assert.equal((await admin.post(`/w/${villa}/listing/status`, { to: 'ready', reason: 'x' }, `/w/${villa}/listing`)).status, 400);
    await admin.post(`/w/${villa}/listing/verify`, { evidence: 'Deed and survey checked' }, `/w/${villa}/listing`);
    await admin.post(`/w/${villa}/listing/status`, { to: 'ready', reason: 'Checked' }, `/w/${villa}/listing`);
    assert.equal((await admin.post(`/w/${villa}/listing/status`, { to: 'available', reason: 'x' }, `/w/${villa}/listing`)).status, 400);   // no price yet
    await admin.post(`/w/${villa}/listing/price`, { asking: '160000', effective_on: today, reason: 'Initial', authorization: 'Mandate clause 3' }, `/w/${villa}/listing`);
    await admin.post(`/w/${villa}/listing/price`, { asking: '155000', effective_on: today, reason: 'Market feedback', authorization: 'Seller email' }, `/w/${villa}/listing`);
    assert.equal((await admin.post(`/w/${villa}/listing/status`, { to: 'available', reason: 'Launch' }, `/w/${villa}/listing`)).status, 302);
    assert.equal((await admin.post(`/w/${villa}/listing/status`, { to: 'sold', reason: 'x' }, `/w/${villa}/listing`)).status, 400);           // never by hand
    assert.equal((await q1('select count(*)::int as n from listing_prices where workspace_id = $1', [villa])).n, 2);
    const l = await q1('select * from listings where workspace_id = $1', [villa]);
    assert.equal(l.status, 'available'); assert.equal(Number(l.asking_minor), 155000000);
    // brochure is generated from public fields only
    assert.equal(await pdf(`/w/${villa}/brochure.pdf`), '%PDF-');
    // marketing: published only with evidence
    await admin.post(`/w/${villa}/marketing`, { channel: 'Property portal', reference: 'PP-889', cost: '120' }, `/w/${villa}/marketing`);
    const mk = (await q1('select id from marketing_activities where workspace_id = $1', [villa])).id;
    assert.equal((await admin.post(`/w/${villa}/marketing/${mk}`, { to: 'published', on: today }, `/w/${villa}/marketing`)).status, 400);
    assert.equal((await admin.post(`/w/${villa}/marketing/${mk}`, { to: 'published', on: today, evidence: 'Live link checked, screenshot saved' }, `/w/${villa}/marketing`)).status, 302);
  });

  await t.test('buyers: register, duplicate check, separate enquiries, follow-ups required', async () => {
    const mk = async (name, email, phone) => (await admin.post('/sales/buyers', { name, email, phone, lead_source: 'Portal', budget_max: '170000', types: 'Villa', locations: 'Saar' }, '/sales/buyers/new')).location.slice(14, 50);
    b1 = await mk('Fatima Buyer', 'fatima@example.com', '+973 3600 1111');
    b2 = await mk('Omar Buyer', 'omar@example.com', '3600 2222');
    const dup = await admin.post('/sales/buyers', { name: 'F. Buyer', email: 'FATIMA@example.com' }, '/sales/buyers/new');
    assert.equal(dup.status, 409); assert.match(dup.text, /Possible existing contact/);
    assert.equal((await admin.post(`/sales/buyers/${b1}/opportunities`, { listing_ws: villa }, `/sales/buyers/${b1}`)).status, 400);   // needs next action
    for (const b of [b1, b2]) assert.equal((await admin.post(`/sales/buyers/${b}/opportunities`, { listing_ws: villa, source: 'Portal', next_action: 'Call to arrange viewing', next_followup_on: today }, `/sales/buyers/${b}`)).status, 302);
    assert.equal((await admin.post(`/sales/buyers/${b1}/opportunities`, { listing_ws: villa, next_action: 'x', next_followup_on: today }, `/sales/buyers/${b1}`)).status, 400);   // one enquiry per buyer and property
    await admin.post(`/sales/buyers/${b1}/activities`, { kind: 'call', occurred_on: today, summary: 'Interested; wants Saturday viewing', next_followup_on: today }, `/sales/buyers/${b1}`);
    const page = await admin.get(`/w/${villa}/buyers`);
    assert.match(page.text, /2 enquiry\(ies\) from 2 unique buyer\(s\)/);
    assert.equal((await admin.get('/sales/buyers?show=all')).status, 200);
  });

  await t.test('viewings: conflicts warned, feedback recorded', async () => {
    let r = await admin.post('/sales/viewings', { listing_ws: villa, party_id: b1, starts_at: tomorrow10, minutes: '45', status: 'confirmed', back: `/w/${villa}/buyers` }, `/w/${villa}/buyers`);
    assert.equal(r.status, 302);
    r = await admin.post('/sales/viewings', { listing_ws: villa, party_id: b2, starts_at: tomorrow10, minutes: '45', back: `/w/${villa}/buyers` }, `/w/${villa}/buyers`);
    assert.equal(r.status, 400); assert.match(r.text, /overlaps/);
    assert.equal((await admin.post('/sales/viewings', { listing_ws: villa, party_id: b2, starts_at: tomorrow10, minutes: '45', accept_conflict: '1', back: `/w/${villa}/buyers` }, `/w/${villa}/buyers`)).status, 302);
    const v = (await q1('select id from viewings where party_id = $1', [b1])).id;
    assert.equal((await admin.post(`/sales/viewings/${v}`, { status: 'completed' }, `/w/${villa}/buyers`)).status, 400);   // feedback required
    await admin.post(`/sales/viewings/${v}`, { status: 'completed', feedback: 'Liked the garden; kitchen dated', owner_summary: 'Positive viewing, kitchen comment', next_followup_on: today }, `/w/${villa}/buyers`);
    assert.equal((await q1('select stage from opportunities where party_id = $1 and listing_ws = $2', [b1, villa])).stage, 'viewing_completed');
  });

  await t.test('offers: immutable versions, external decisions, acceptance is not a sale', async () => {
    let r = await admin.post('/sales/offers', { listing_ws: villa, party_id: b1, price: '140000', conditions: 'Subject to finance', valid_until: '2027-01-31' }, `/w/${villa}/offers`);
    assert.equal(r.status, 302);
    offerId = (await q1('select id from offers where party_id = $1', [b1])).id;
    r = await admin.post(`/sales/offers/${offerId}/decision`, { version: '1', decision: 'countered', decided_by_name: 'Khalid Owner', decided_on: today, evidence: 'Seller email 10:02', counter_price: '150000', counter_terms: 'Completion within 60 days' }, `/w/${villa}/offers`);
    assert.equal(r.status, 302);
    assert.equal((await admin.post(`/sales/offers/${offerId}/decision`, { version: '1', decision: 'accepted', decided_by_name: 'x', decided_on: today, evidence: 'x' }, `/w/${villa}/offers`)).status, 400);   // v1 is decided
    await admin.post(`/sales/offers/${offerId}/decision`, { version: '2', decision: 'accepted', decided_by_name: 'Fatima Buyer', decided_on: today, evidence: 'Signed acceptance letter' }, `/w/${villa}/offers`);
    const vs = (await pool.query('select version, by_side, price_minor, decision from offer_versions where offer_id = $1 order by version', [offerId])).rows;
    assert.deepEqual(vs.map(v => [v.version, v.by_side, Number(v.price_minor), v.decision]), [[1, 'buyer', 140000000, 'countered'], [2, 'seller', 150000000, 'accepted']]);
    assert.equal((await q1('select status from listings where workspace_id = $1', [villa])).status, 'under_offer');   // not sold
    // the confidential minimum never appears on buyer-facing outputs (offers carry only offered prices)
    const buyerPage = await admin.get(`/sales/buyers/${b1}`);
    assert.doesNotMatch(buyerPage.text, /140,000 confidential|confidential minimum/);
  });

  await t.test('deal: one live deal per property, checklist before completion, evidence required', async () => {
    let r = await admin.post(`/sales/offers/${offerId}/deal`, { interest: 'Whole property (villa and land)' }, `/w/${villa}/offers`);
    assert.equal(r.status, 302); dealWs = wsOf(r);
    // a second accepted offer cannot open a conflicting deal on the same property
    await admin.post('/sales/offers', { listing_ws: villa, party_id: b2, price: '152000' }, `/w/${villa}/offers`);
    const o2 = (await q1('select id from offers where party_id = $1', [b2])).id;
    await admin.post(`/sales/offers/${o2}/decision`, { version: '1', decision: 'accepted', decided_by_name: 'Khalid Owner', decided_on: today, evidence: 'Backup offer acknowledged' }, `/w/${villa}/offers`);
    r = await admin.post(`/sales/offers/${o2}/deal`, { interest: 'Whole property' }, `/w/${villa}/offers`);
    assert.equal(r.status, 400); assert.match(r.text, /already has a deal/);
    // reservation needs authorisation; completion needs the checklist closed and evidence
    assert.equal((await admin.post(`/w/${dealWs}/deal/reserve`, { reserved_until: '2026-12-31' }, `/w/${dealWs}`)).status, 400);
    await admin.post(`/w/${dealWs}/deal/reserve`, { reserved_until: '2026-12-31', reservation_ref: 'Reservation form signed by seller', deposit_holder: 'Seller\'s lawyer' }, `/w/${dealWs}`);
    assert.equal((await q1('select status from listings where workspace_id = $1', [villa])).status, 'reserved');
    r = await admin.post(`/w/${dealWs}/deal/complete`, { final_price: '148000', completed_on: today, evidence: 'Transfer recorded at Survey & Land Registration' }, `/w/${dealWs}`);
    assert.equal(r.status, 400); assert.match(r.text, /checklist/);
    for (const i of (await pool.query('select id from deal_checklist where workspace_id = $1 order by sort', [dealWs])).rows) {
      const g = await admin.get(`/w/${dealWs}/checklist`);
      const fd = new FormData(); fd.append('_csrf', admin.csrfFrom(g.text)); fd.append('status', 'done'); fd.append('notes', 'Checked');
      assert.equal((await admin.raw('POST', `/w/${dealWs}/checklist/${i.id}`, { multipart: fd })).status, 302);
    }
    assert.equal((await admin.post(`/w/${dealWs}/deal/complete`, { final_price: '148000', completed_on: today }, `/w/${dealWs}`)).status, 400);    // evidence required
    assert.equal((await admin.post(`/w/${dealWs}/deal/complete`, { final_price: '148000', completed_on: today, evidence: 'Transfer recorded at Survey & Land Registration' }, `/w/${dealWs}`)).status, 302);
    const d = await q1('select * from deals where workspace_id = $1', [dealWs]);
    assert.equal(d.status, 'completed'); assert.equal(Number(d.accepted_minor), 150000000); assert.equal(Number(d.final_minor), 148000000);
    assert.equal((await q1('select status from listings where workspace_id = $1', [villa])).status, 'sold');
    assert.equal((await q1('select stage from opportunities where party_id = $1 and listing_ws = $2', [b1, villa])).stage, 'won');
    assert.equal((await q1('select stage from opportunities where party_id = $1 and listing_ws = $2', [b2, villa])).stage, 'lost');
  });

  await t.test('commission from the mandate: calculation shown, one invoice per side, partial receipt; deal value not revenue', async () => {
    let r = await admin.post(`/w/${dealWs}/deal/commission`, { side_ws: villa }, `/w/${dealWs}`);
    assert.equal(r.status, 302);
    const inv = await q1("select * from fee_invoices where deal_ws = $1 and kind = 'commission'", [dealWs]);
    assert.equal(Number(inv.total_minor), 2960000);                                   // 2% × 148,000
    assert.match(inv.calc_note, /2% × final transaction price BHD 148,000 = BHD 2,960/);
    assert.equal(inv.workspace_id, villa);
    assert.equal((await admin.post(`/w/${dealWs}/deal/commission`, { side_ws: villa }, `/w/${dealWs}`)).status, 400);   // no duplicate
    assert.equal((await admin.post(`/w/${villa}/fees/invoices/${inv.id}/issue`, { issue_date: today }, `/w/${villa}/fees/invoices/${inv.id}`)).status, 302);
    assert.match((await q1('select number from fee_invoices where id = $1', [inv.id])).number, /^INV-\d{4}-0001$/);
    r = await admin.post(`/w/${villa}/fees/payments`, { received_on: today, amount: '1000', method: 'Bank transfer', reference: 'COMM-1', [`alloc_${inv.id}`]: '1000' }, `/w/${villa}/fees`);
    const pay = r.location.split('/')[5].slice(0, 36);
    await admin.post(`/w/${villa}/fees/payments/${pay}/receipt`, {}, `/w/${villa}/fees/payments/${pay}`);
    assert.match((await q1('select receipt_no from fee_payments where id = $1', [pay])).receipt_no, /^RCT-/);
    assert.equal(await pdf(`/w/${villa}/fees/invoices/${inv.id}/invoice.pdf`), '%PDF-');
    const fees = await admin.get(`/w/${villa}/fees`);
    assert.match(fees.text, /BHD 1,960/);                                         // outstanding after the partial payment
    const rep = await admin.get('/sales/reports');
    assert.match(rep.text, /Transaction value BHD 148,000 — not SarayDar revenue/);
    assert.equal((await admin.raw('GET', '/sales/reports?export=xlsx')).status, 200);
  });

  let req, land, ext;
  await t.test('buyer: acquisition request, brief versions, transparent matches, external option, published shortlist', async () => {
    land = await availableListing('Saar Land 3', 'Land Seller', { property_type: 'Land', location: 'Saar, block 551', land_area_m2: '600', min_price: '60000' }, '72000');
    await availableListing('Riffa Apartment', 'Apt Seller', { property_type: 'Apartment', location: 'Riffa', bedrooms: '2' }, '65000');
    req = wsOf(await admin.post('/s/sales/new', { kind: 'request', name: 'Land search — Nasser', party: 'Nasser Client', location: 'Saar' }, '/s/sales/new?kind=request'));
    await admin.post(`/w/${req}/mandate`, { scope: 'Find land in Saar', start_date: today, end_date: '2027-06-30', fee_type: 'fixed', fee_fixed: '500', fee_payer: 'Buyer', fee_trigger: 'completion', tax_mode: 'none' }, `/w/${req}/mandate`);
    const mid = (await q1('select id from sale_mandates where workspace_id = $1', [req])).id;
    await admin.post(`/w/${req}/mandate/${mid}/activate`, {}, `/w/${req}/mandate`);
    await admin.post(`/w/${req}/mandate/${mid}/verify`, { evidence: 'Client CPR and signed appointment' }, `/w/${req}/mandate`);
    await admin.post(`/w/${req}/brief`, { types: 'Land', locations: 'Saar', budget_min: '50000', budget_max: '80000', land_min_m2: '400', yield_note__unknown: '1' }, `/w/${req}/brief`);
    assert.equal((await admin.post(`/w/${req}/brief`, { types: 'Land', locations: 'Saar, Budaiya', budget_max: '85000' }, `/w/${req}/brief`)).status, 400);   // change needs a reason
    await admin.post(`/w/${req}/brief`, { types: 'Land', locations: 'Saar, Budaiya', budget_min: '50000', budget_max: '85000', land_min_m2: '400', change_reason: 'Client widened area', evidence: 'WhatsApp 3 Nov' }, `/w/${req}/brief`);
    assert.equal((await q1('select count(*)::int as n from request_briefs where workspace_id = $1', [req])).n, 2);
    const page = await admin.get(`/w/${req}/shortlist`);
    assert.match(page.text, /Saar Land 3/);
    assert.doesNotMatch(page.text, /60,000/);                                     // the seller's confidential minimum is never shown
    await admin.post(`/w/${req}/external`, { title: 'Budaiya plot (agent)', source: 'Gulf Agents', price: '78000', property_type: 'Land', location: 'Budaiya', verification: 'unverified', availability: 'available', arrangement: 'Co-broker 50/50 — letter on file' }, `/w/${req}/shortlist`);
    ext = (await q1('select id from external_opps where workspace_id = $1', [req])).id;
    await admin.post(`/w/${req}/shortlist`, { listing_ws: land, reason: 'Fits budget and area' }, `/w/${req}/shortlist`);
    await admin.post(`/w/${req}/shortlist`, { external_id: ext }, `/w/${req}/shortlist`);
    const item = (await q1('select id from shortlist_items where workspace_id = $1 and listing_ws = $2', [req, land])).id;
    assert.equal((await admin.post(`/w/${req}/shortlist/${item}`, { status: 'shared', published: '1', rank: '1' }, `/w/${req}/shortlist`)).status, 400);   // recheck first
    assert.equal((await admin.post(`/w/${req}/shortlist/${item}`, { status: 'shared', published: '1', rank: '1', rechecked_on: today, rechecked_price: '72000', client_feedback: 'Wants to view' }, `/w/${req}/shortlist`)).status, 302);
    assert.equal((await q1('select status from acq_requests where workspace_id = $1', [req])).status, 'shortlist_shared');
  });

  await t.test('buyer: offer, deal, completion and the buyer-side fee', async () => {
    let r = await admin.post('/sales/viewings', { request_ws: req, target: `l:${land}`, party_id: (await q1('select party_id from workspaces where id = $1', [req])).party_id, starts_at: tomorrow10.replace('T10', 'T16'), minutes: '30', back: `/w/${req}/offers` }, `/w/${req}/offers`);
    assert.equal(r.status, 302);
    const nasser = (await q1('select party_id from workspaces where id = $1', [req])).party_id;
    r = await admin.post('/sales/offers', { request_ws: req, party_id: nasser, target: `l:${land}`, price: '70000' }, `/w/${req}/offers`);
    assert.equal(r.status, 302);
    const o = (await q1('select id from offers where request_ws = $1', [req])).id;
    await admin.post(`/sales/offers/${o}/decision`, { version: '1', decision: 'accepted', decided_by_name: 'Land Seller', decided_on: today, evidence: 'Seller signed' }, `/w/${req}/offers`);
    const d = wsOf(await admin.post(`/sales/offers/${o}/deal`, { interest: 'Whole plot 551-12' }, `/w/${req}/offers`));
    await pool.query("update deal_checklist set status = 'not_applicable' where workspace_id = $1", [d]);
    assert.equal((await admin.post(`/w/${d}/deal/complete`, { final_price: '70000', completed_on: today, evidence: 'Deed transfer receipt 778' }, `/w/${d}`)).status, 302);
    assert.equal((await q1('select status from acq_requests where workspace_id = $1', [req])).status, 'completed');
    // both sides can bill, each from its own mandate and workspace — never twice for the same side
    assert.equal((await admin.post(`/w/${d}/deal/commission`, { side_ws: req }, `/w/${d}`)).status, 302);
    assert.equal((await admin.post(`/w/${d}/deal/commission`, { side_ws: land }, `/w/${d}`)).status, 302);
    const invs = (await pool.query("select workspace_id, total_minor from fee_invoices where deal_ws = $1 order by total_minor", [d])).rows;
    assert.deepEqual(invs.map(i => [i.workspace_id, Number(i.total_minor)]), [[req, 500000], [land, 1400000]]);
  });

  await t.test('isolation and roles', async () => {
    await admin.post('/admin/users', { name: 'Agent', email: 'agent@example.com', kind: 'internal', system_role: 'brokerage_agent', password: 'agent-temp-pass1' }, '/admin/users');
    const ag = client(base); await login(ag, 'agent@example.com', 'agent-temp-pass1');
    await ag.post('/account/password', { current: 'agent-temp-pass1', password: 'agent-own-pass-1', confirm: 'agent-own-pass-1' }, '/account/password');
    assert.equal((await ag.get(`/w/${villa}`)).status, 404);                      // not a member of that case
    assert.equal((await ag.get('/sales/buyers')).status, 200);                   // sales staff see the register
    const deals = await ag.get('/sales/deals');
    assert.doesNotMatch(deals.text, /Saar Villa 12/);                            // deals of cases they cannot open are hidden
    const rep = await ag.get('/sales/reports');
    assert.match(rep.text, /Completed sales in period<\/div><div class="big">0/);
    assert.doesNotMatch(rep.text, /SarayDar fees \(issued in period\)/);         // no financial role
    await admin.post('/admin/users', { name: 'Eng', email: 'eng5@example.com', kind: 'internal', system_role: 'engineer', password: 'eng-temp-pass-1' }, '/admin/users');
    const eng = client(base); await login(eng, 'eng5@example.com', 'eng-temp-pass-1');
    await eng.post('/account/password', { current: 'eng-temp-pass-1', password: 'eng-own-pass-1', confirm: 'eng-own-pass-1' }, '/account/password');
    assert.equal((await eng.get('/sales/buyers')).status, 403);
    assert.equal((await eng.post('/sales/offers', { listing_ws: land, party_id: b1, price: '1' }, '/')).status, 403);
  });
});
