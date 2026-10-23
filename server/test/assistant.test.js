'use strict';
// Section 11 — the AI assistant: honest "not configured" state, permission-limited context, no changes, staff only.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { Pool } = require('pg');
const db = require('../db');
const { createApp } = require('../app');
const { client } = require('./helpers');

const URL_ = process.env.TEST_DATABASE_URL;

test('AI assistant', { skip: !URL_ && 'set TEST_DATABASE_URL to run' }, async t => {
  const pool = new Pool({ connectionString: URL_ });
  await pool.query('drop schema public cascade; create schema public;');
  await db.migrate(pool); await db.seed(pool);
  await db.ensureAdmin(pool, { ADMIN_EMAIL: 'ali@example.com', ADMIN_PASSWORD: 'admin-pass-123' });
  // a stand-in for the provider that records what it receives
  const seen = [];
  let fail = false;
  const mock = http.createServer((req, res) => {
    let b = ''; req.on('data', d => { b += d; }); req.on('end', () => {
      seen.push({ headers: req.headers, body: JSON.parse(b) });
      res.writeHead(fail ? 529 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(fail ? { type: 'error', error: { type: 'overloaded_error' } } : { content: [{ type: 'text', text: 'Milestone "Frame complete" is due soon. Suggest checking the crane booking.' }] }));
    });
  }).listen(0);
  const plain = createApp({ pool, jwtSecret: 's'.repeat(40), corsOrigins: [], env: {} }).listen(0);
  const withAi = createApp({ pool, jwtSecret: 's'.repeat(40), corsOrigins: [], env: { ANTHROPIC_API_KEY: 'test-key', AI_API_URL: `http://127.0.0.1:${mock.address().port}` } }).listen(0);
  t.after(async () => { plain.close(); withAi.close(); mock.close(); await pool.end(); });
  const login = (c, i, p) => c.post('/login', { identifier: i, password: p }, '/login');

  const a1 = client(`http://127.0.0.1:${plain.address().port}`); await login(a1, 'ali@example.com', 'admin-pass-123');
  const ws = (await a1.post('/s/dev/new', { kind: 'project', name: 'Galali Villas', location: 'Galali' }, '/s/dev/new')).location.slice(3, 39);
  const listing = (await a1.post('/s/sales/new', { kind: 'listing', name: 'Riffa Plot', party: 'Seller Sami', location: 'Riffa' }, '/s/sales/new?kind=listing')).location.slice(3, 39);
  await pool.query("insert into tasks (workspace_id, title, status, due_date, is_milestone) values ($1, 'Frame complete', 'in_progress', current_date + 10, true)", [ws]);
  await pool.query("insert into listings (workspace_id, status, asking_minor, min_price_minor, access_notes) values ($1,'available',90000000,77777000,'SECRET-KEY 99')", [listing]);

  await t.test('without a key the tab says "not configured" and simulates nothing', async () => {
    const p = await a1.get(`/w/${ws}/assistant`);
    assert.equal(p.status, 200);
    assert.match(p.text, /not configured/); assert.match(p.text, /No answers are simulated/);
    assert.doesNotMatch(p.text, /id="f-q"/);
    assert.equal((await a1.post(`/w/${ws}/assistant`, { q: 'Hello?' }, `/w/${ws}/assistant`)).location, `/w/${ws}/assistant`);
    assert.ok((await a1.get(`/w/${ws}`)).text.includes(`/w/${ws}/assistant`));         // the tab is on every workspace
  });

  const a2 = client(`http://127.0.0.1:${withAi.port || withAi.address().port}`); await login(a2, 'ali@example.com', 'admin-pass-123');
  await t.test('with a key: context comes from this workspace only, answers are labelled, nothing changes', async () => {
    const before = (await pool.query('select count(*)::int as n from tasks')).rows[0].n;
    const r = await a2.post(`/w/${ws}/assistant`, { q: 'Which milestones are at risk?' }, `/w/${ws}/assistant`);
    assert.equal(r.status, 200);
    assert.match(r.text, /AI suggestion — not verified/); assert.match(r.text, /crane booking/);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].headers['x-api-key'], 'test-key');
    const sent = seen[0].body.messages[0].content;
    assert.match(sent, /Galali Villas/); assert.match(sent, /Frame complete/);
    assert.doesNotMatch(sent, /Riffa Plot/);                           // no other workspace
    assert.equal((await pool.query('select count(*)::int as n from tasks')).rows[0].n, before);
    assert.equal((await pool.query("select count(*)::int as n from audit_events where action = 'ai.asked'")).rows[0].n, 1);
    // listing context: public asking price only — never the confidential minimum or access notes
    await a2.post(`/w/${listing}/assistant`, { q: 'Summarise the listing' }, `/w/${listing}/assistant`);
    const s2 = seen[1].body.messages[0].content;
    assert.match(s2, /90,000\.000/); assert.doesNotMatch(s2, /77,777|SECRET-KEY/);
    // a provider error is reported honestly
    fail = true;
    const e = await a2.post(`/w/${ws}/assistant`, { q: 'Again?' }, `/w/${ws}/assistant`);
    assert.match(e.text, /AI provider returned an error \(529: overloaded_error\)/); assert.match(e.text, /Nothing was changed/);
    fail = false;
  });

  await t.test('external viewers and non-members cannot use it', async () => {
    await pool.query("insert into users (email, name, kind, system_role, role, password_hash) select 'viewer@example.com', 'V', 'external', 'external', 'viewer', password_hash from users where email = 'ali@example.com'");
    const uid = (await pool.query("select id from users where email = 'viewer@example.com'")).rows[0].id;
    await pool.query("insert into workspace_members (workspace_id, user_id, role) values ($1,$2,'client_viewer')", [ws, uid]);
    const ext = client(`http://127.0.0.1:${withAi.address().port}`); await login(ext, 'viewer@example.com', 'admin-pass-123');
    assert.equal((await ext.get(`/w/${ws}/assistant`)).location, `/p/${ws}`);
    assert.ok(!(await ext.get(`/p/${ws}`)).text.includes('assistant'));
    const tok = ext.csrfFrom((await ext.get('/account')).text);
    assert.equal((await ext.raw('POST', `/w/${ws}/assistant`, { form: { q: 'x', _csrf: tok } })).status, 403);
    assert.equal(seen.length, 3);
  });
});
