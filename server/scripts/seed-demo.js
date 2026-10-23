'use strict';
// Demonstration data — every record is named "DEMO …" so it can never be mistaken for real business.
// It is created through the portal's own forms (same validation and audit trail as real work).
// Refuses to run unless the database name contains "demo" or DEMO_SEED=yes is set, and never with NODE_ENV=production.
//   DATABASE_URL=postgres://.../saraydar_demo ADMIN_EMAIL=… ADMIN_PASSWORD=… node scripts/seed-demo.js
const { Pool } = require('pg');
const sharp = require('sharp');
const db = require('../db');
const { createApp } = require('../app');
const { client } = require('../test/helpers');

(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Set DATABASE_URL.');
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to load demonstration data with NODE_ENV=production.');
  if (!/demo/i.test(new URL(url).pathname) && process.env.DEMO_SEED !== 'yes') throw new Error('Use a database whose name contains "demo", or set DEMO_SEED=yes to confirm this is not production.');
  const email = process.env.ADMIN_EMAIL, password = process.env.ADMIN_PASSWORD;
  if (!email || !password) throw new Error('Set ADMIN_EMAIL and ADMIN_PASSWORD (the Super Admin to act as).');
  const pool = new Pool({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false } });
  await db.migrate(pool); await db.seed(pool); await db.ensureAdmin(pool, { ADMIN_EMAIL: email, ADMIN_PASSWORD: password });
  if ((await pool.query("select count(*)::int as n from workspaces where name like 'DEMO %'")).rows[0].n) { console.log('Demonstration data is already loaded.'); await pool.end(); return; }
  const server = createApp({ pool, jwtSecret: 'demo-seed-'.repeat(5), corsOrigins: [], env: {} }).listen(0);
  const c = client(`http://127.0.0.1:${server.address().port}`);
  const r0 = await c.post('/login', { identifier: email, password }, '/login');
  if (r0.status !== 302) throw new Error('Could not sign in as the Super Admin.');
  const ws = r => { if (!r.location || !r.location.startsWith('/w/')) throw new Error(`Unexpected response ${r.status}: ${r.text.slice(0, 200)}`); return r.location.slice(3, 39); };
  const q1 = async (sql, v) => (await pool.query(sql, v)).rows[0];
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bahrain' });
  const photo = colour => sharp({ create: { width: 1200, height: 800, channels: 3, background: colour } }).jpeg().toBuffer();
  async function upload(path, page, fields, files) {
    const pg = await c.get(page);
    const fd = new FormData(); fd.append('_csrf', c.csrfFrom(pg.text));
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    for (const [k, name, buf] of files) fd.append(k, new Blob([buf]), name);
    return c.raw('POST', path, { multipart: fd });
  }

  // Development projects, with investors and a published update
  const d1 = ws(await c.post('/s/dev/new', { kind: 'project', name: 'DEMO Hidd Townhouses', location: 'Hidd' }, '/s/dev/new'));
  ws(await c.post('/s/dev/new', { kind: 'project', name: 'DEMO Diyar Villas', location: 'Diyar Al Muharraq' }, '/s/dev/new'));
  await upload(`/w/${d1}/updates`, `/w/${d1}/updates/new`, { title: 'DEMO — foundations complete', observed_on: today, status: 'published', external_visible: '1', completed_work: 'Foundations for townhouses 1–4 poured and cured.', remaining_work: 'Ground-floor columns next week.' },
    [['photos', 'demo-site-1.jpg', await photo('#8e4f2b')], ['photos', 'demo-site-2.jpg', await photo('#5e6b4f')]]);
  const ir = await c.post(`/w/${d1}/investors`, { new_name: 'DEMO Investor Co.', new_kind: 'company', new_email: 'demo.investor@example.com', participation: 'unconfirmed', currency: 'BHD', committed: '40000', agreement_ref: 'DEMO-IA-1' }, `/w/${d1}/investors`);
  const inv = ir.location.split('/')[4].split('?')[0];
  await c.post(`/w/${d1}/investors/${inv}/txns`, { kind: 'contribution', on_date: today, amount: '15000', method: 'Bank transfer', reference: 'DEMO-TR-1' }, `/w/${d1}/investors/${inv}`);

  // Client projects
  ws(await c.post('/s/cpm/new', { kind: 'client_project', name: 'DEMO Client Villa — Saar', party: 'DEMO Client Family', location: 'Saar' }, '/s/cpm/new'));
  ws(await c.post('/s/cpm/new', { kind: 'client_project', name: 'DEMO Client Office Fit-out', party: 'DEMO Client Company', location: 'Seef' }, '/s/cpm/new'));

  // Properties with units
  for (const [name, loc] of [['DEMO Seef Residence', 'Seef'], ['DEMO Juffair Building', 'Juffair']]) {
    const p = ws(await c.post('/s/props/new', { kind: 'property', name, party: 'DEMO Property Owner', location: loc }, '/s/props/new'));
    for (const ref of ['11', '12', '13', '14']) await c.post(`/w/${p}/units`, { ref, unit_type: '2 bedroom apartment', bedrooms: '2', area_m2: '110' }, `/w/${p}/units`);
  }

  // Sales listings and acquisition requests (mandates, verified file, price)
  for (const [name, type, price] of [['DEMO Amwaj Villa 7', 'Villa', '250000'], ['DEMO Saar Plot 551', 'Land', '72000']]) {
    const l = ws(await c.post('/s/sales/new', { kind: 'listing', name, party: 'DEMO Seller', location: 'Bahrain' }, '/s/sales/new?kind=listing'));
    await c.post(`/w/${l}/mandate`, { scope: 'Market and sell (demonstration)', exclusive: 'exclusive', start_date: today, end_date: '2027-12-31', fee_type: 'percent', fee_pct: '2', fee_base: 'final_price', fee_payer: 'Seller', fee_trigger: 'completion', tax_mode: 'none', marketing_budget: '500' }, `/w/${l}/mandate`);
    const mid = (await q1('select id from sale_mandates where workspace_id = $1', [l])).id;
    await c.post(`/w/${l}/mandate/${mid}/activate`, {}, `/w/${l}/mandate`);
    await c.post(`/w/${l}/mandate/${mid}/verify`, { evidence: 'DEMO — no real documents' }, `/w/${l}/mandate`);
    await c.post(`/w/${l}/listing`, { property_type: type, location: 'Bahrain (demonstration)', description: 'Demonstration listing — not a real property.' }, `/w/${l}/listing`);
    await c.post(`/w/${l}/listing/verify`, { evidence: 'DEMO' }, `/w/${l}/listing`);
    await c.post(`/w/${l}/listing/price`, { asking: price, effective_on: today, reason: 'Initial price (demo)', authorization: 'DEMO' }, `/w/${l}/listing`);
  }
  for (const name of ['DEMO Family home search', 'DEMO Investor land search']) ws(await c.post('/s/sales/new', { kind: 'request', name, party: 'DEMO Buyer', location: 'Saar' }, '/s/sales/new?kind=request'));

  server.close(); await pool.end();
  console.log('Demonstration data loaded: 2 development projects (one with an investor and a published update), 2 client projects, 2 properties, 2 listings and 2 search requests — all named "DEMO …".');
})().catch(e => { console.error(e.message); process.exit(1); });
