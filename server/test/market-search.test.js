'use strict';
// AI market search for acquisition requests: only the brief's criteria are sent, results are links to review,
// nothing is shortlisted automatically, and an added result becomes an unverified external opportunity.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { Pool } = require('pg');
const db = require('../db');
const { createApp } = require('../app');
const { client } = require('./helpers');
const { parseResults } = require('../portal/market-search');

const URL_ = process.env.TEST_DATABASE_URL;

test('result parsing keeps only real links and drops duplicates', () => {
  const r = parseResults('Here: <results>[{"title":"Villa in Saar","url":"https://example.bh/v/1","price_bhd":"185,000","bedrooms":4},{"title":"dup","url":"https://example.bh/v/1"},{"title":"bad","url":"javascript:alert(1)"},{"title":"no link"}]</results>');
  assert.equal(r.length, 1);
  assert.equal(r[0].price_bhd, 185000); assert.equal(r[0].source, 'example.bh'); assert.equal(r[0].bedrooms, 4);
  assert.throws(() => parseResults('nothing here'));
});

test('AI market search', { skip: !URL_ && 'set TEST_DATABASE_URL to run' }, async t => {
  const pool = new Pool({ connectionString: URL_ });
  await pool.query('drop schema public cascade; create schema public;');
  await db.migrate(pool); await db.seed(pool);
  await db.ensureAdmin(pool, { ADMIN_EMAIL: 'ali@example.com', ADMIN_PASSWORD: 'admin-pass-123' });
  const seen = [];
  const mock = http.createServer((req, res) => {
    let b = ''; req.on('data', d => { b += d; }); req.on('end', () => {
      seen.push(JSON.parse(b));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: '<results>[{"title":"4-bed villa, Saar","url":"https://portal.example/listing/77","source":"Example Portal","location":"Saar","property_type":"Villa","price_bhd":180000,"bedrooms":4,"built_area_m2":420,"fit":"Within budget and area."}]</results>' }] }));
    });
  }).listen(0);
  const plain = createApp({ pool, jwtSecret: 's'.repeat(40), corsOrigins: [], env: {} }).listen(0);
  const withAi = createApp({ pool, jwtSecret: 's'.repeat(40), corsOrigins: [], env: { ANTHROPIC_API_KEY: 'test-key', AI_API_URL: `http://127.0.0.1:${mock.address().port}` } }).listen(0);
  t.after(async () => { plain.close(); withAi.close(); mock.close(); await pool.end(); });
  const login = (c, i, p) => c.post('/login', { identifier: i, password: p }, '/login');
  const today = new Date().toISOString().slice(0, 10);

  const a1 = client(`http://127.0.0.1:${plain.address().port}`); await login(a1, 'ali@example.com', 'admin-pass-123');
  const req = (await a1.post('/s/sales/new', { kind: 'request', name: 'Villa search — Huda', party: 'Huda Secret-Client', location: 'Saar' }, '/s/sales/new?kind=request')).location.slice(3, 39);

  await t.test('without a key it says so; without a brief it asks for one', async () => {
    const p = await a1.get(`/w/${req}/shortlist`);
    assert.match(p.text, /Search the market/); assert.match(p.text, /Not configured/);
  });

  const a2 = client(`http://127.0.0.1:${withAi.address().port}`); await login(a2, 'ali@example.com', 'admin-pass-123');
  await t.test('with a key: only the criteria are sent, results are listed, adding one creates an unverified opportunity', async () => {
    assert.match((await a2.get(`/w/${req}/shortlist`)).text, /Record the brief first/);
    await a2.post(`/w/${req}/brief`, { types: 'Villa', locations: 'Saar, Budaiya', budget_min: '150,000', budget_max: '200,000', bedrooms_min: '4', notes: 'PRIVATE-NOTE' }, `/w/${req}/brief`);
    const r = await a2.post(`/w/${req}/market-search`, {}, `/w/${req}/shortlist`);
    assert.equal(r.status, 302);
    await withAi_wait(pool, req);
    assert.equal(seen.length, 1);
    const sent = JSON.stringify(seen[0]);
    assert.match(sent, /Villa/); assert.match(sent, /Saar, Budaiya/); assert.match(sent, /BHD 150,000 to BHD 200,000/); assert.match(sent, /web_search/);
    assert.doesNotMatch(sent, /Huda|Secret-Client|PRIVATE-NOTE/);                    // no client identity or notes
    const page = await a2.get(`/w/${req}/shortlist`);
    assert.match(page.text, /4-bed villa, Saar/); assert.match(page.text, /https:\/\/portal\.example\/listing\/77/); assert.match(page.text, /BHD 180,000/);
    assert.equal((await pool.query('select count(*)::int as n from shortlist_items')).rows[0].n, 0);   // nothing shortlisted automatically
    const sid = (await pool.query('select id from market_searches where workspace_id = $1', [req])).rows[0].id;
    await a2.post(`/w/${req}/market-search/${sid}/add`, { n: '0' }, `/w/${req}/shortlist`);
    await a2.post(`/w/${req}/market-search/${sid}/add`, { n: '0' }, `/w/${req}/shortlist`);       // twice: still one
    const ex = (await pool.query('select * from external_opps where workspace_id = $1', [req])).rows;
    assert.equal(ex.length, 1);
    assert.equal(ex[0].verification, 'unverified'); assert.equal(Number(ex[0].price_minor), 180000000); assert.match(ex[0].notes, /portal\.example\/listing\/77/);
    assert.match((await a2.get(`/w/${req}/shortlist`)).text, /Added/);
  });
});

async function withAi_wait(pool, ws) {
  for (let i = 0; i < 50; i++) {
    const s = (await pool.query('select status from market_searches where workspace_id = $1', [ws])).rows[0];
    if (s && s.status !== 'running') return s;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('search did not finish');
}
