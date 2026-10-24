'use strict';
// Tab tips and the Help page.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const db = require('../db');
const { createApp } = require('../app');
const { client } = require('./helpers');
const { TAB_ORDER, tipFor } = require('../portal/help');

test('every tab of every kind of record has a tip with an example', () => {
  for (const [kind, tabs] of Object.entries(TAB_ORDER)) for (const t of tabs) {
    const tip = tipFor(kind, t);
    assert.ok(tip && tip[0] && tip[1], `${kind} › ${t}`);
  }
});

const URL_ = process.env.TEST_DATABASE_URL;
test('tips on workspace tabs; help page', { skip: !URL_ && 'set TEST_DATABASE_URL to run' }, async t => {
  const pool = new Pool({ connectionString: URL_ });
  await pool.query('drop schema public cascade; create schema public;');
  await db.migrate(pool); await db.seed(pool);
  await db.ensureAdmin(pool, { ADMIN_EMAIL: 'ali@example.com', ADMIN_PASSWORD: 'admin-pass-123' });
  const server = createApp({ pool, jwtSecret: 's'.repeat(40), corsOrigins: [], env: {} }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.close(); await pool.end(); });
  const admin = client(base); await admin.post('/login', { identifier: 'ali@example.com', password: 'admin-pass-123' }, '/login');
  const ws = (await admin.post('/s/cpm/new', { kind: 'client_project', name: 'Tip Villa', party: 'Tip Client', location: 'Saar' }, '/s/cpm/new')).location.slice(3, 39);
  await t.test('client budget tab explains whose money it is, with an example', async () => {
    const p = await admin.get(`/w/${ws}/budget`);
    assert.match(p.text, /class="tabtip no-export"/);
    assert.match(p.text, /never SarayDar money/);
    assert.match(p.text, /<b>Example:<\/b>/);
  });
  await t.test('no tips outside records; help page lists the tabs', async () => {
    assert.doesNotMatch((await admin.get('/admin/users')).text, /class="tabtip/);
    const h = await admin.get('/help');
    assert.equal(h.status, 200);
    assert.match(h.text, /Order of work for a new record/);
    assert.match(h.text, /Client Budget &amp; Payments/);
    assert.match((await admin.get('/')).text, /href="\/help"/);
  });
});
