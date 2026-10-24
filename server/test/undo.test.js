'use strict';
// Undo / redo of a person's own edits.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const db = require('../db');
const { createApp } = require('../app');
const { client } = require('./helpers');

const URL_ = process.env.TEST_DATABASE_URL;

test('undo and redo', { skip: !URL_ && 'set TEST_DATABASE_URL to run' }, async t => {
  const pool = new Pool({ connectionString: URL_ });
  await pool.query('drop schema public cascade; create schema public;');
  await db.migrate(pool); await db.seed(pool);
  await db.ensureAdmin(pool, { ADMIN_EMAIL: 'ali@example.com', ADMIN_PASSWORD: 'admin-pass-123' });
  const server = createApp({ pool, jwtSecret: 's'.repeat(40), corsOrigins: [], env: {} }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.close(); await pool.end(); });
  const login = (c, i, p) => c.post('/login', { identifier: i, password: p }, '/login');
  const admin = client(base); await login(admin, 'ali@example.com', 'admin-pass-123');
  const name = async id => (await pool.query('select name, location from workspaces where id = $1', [id])).rows[0];
  const ws = (await admin.post('/s/dev/new', { kind: 'project', name: 'Busaiteen Villas', location: 'Busaiteen' }, '/s/dev/new')).location.slice(3, 39);

  await t.test('nothing to undo at first; buttons are shown disabled', async () => {
    const p = await admin.get(`/w/${ws}`);
    assert.match(p.text, /action="\/undo"/); assert.match(p.text, /title="Nothing to undo"/);
    assert.match((await admin.post('/undo', { back: `/w/${ws}` }, `/w/${ws}`)).location, /msg=nothing_to_undo/);
  });

  await t.test('an edit can be undone and redone, returning to the same page', async () => {
    await admin.post(`/w/${ws}/edit`, { name: 'Busaiteen Villas Phase 2', location: 'Busaiteen, block 228', stage: '', manager: '', status: 'active' }, `/w/${ws}`);
    assert.equal((await name(ws)).name, 'Busaiteen Villas Phase 2');
    const p = await admin.get(`/w/${ws}`);
    assert.match(p.text, /title="Undo: Edited Busaiteen Villas \(name, location\)"/);
    const u = await admin.post('/undo', { back: `/w/${ws}` }, `/w/${ws}`);
    assert.equal(u.location, `/w/${ws}?msg=undone`);
    assert.deepEqual(await name(ws), { name: 'Busaiteen Villas', location: 'Busaiteen' });
    assert.equal((await admin.post('/redo', { back: `/w/${ws}` }, `/w/${ws}`)).location, `/w/${ws}?msg=redone`);
    assert.deepEqual(await name(ws), { name: 'Busaiteen Villas Phase 2', location: 'Busaiteen, block 228' });
    assert.equal((await pool.query("select count(*)::int as n from audit_events where action in ('edit.undo','edit.redo')")).rows[0].n, 2);
  });

  await t.test('a record changed again since cannot be undone blindly', async () => {
    await pool.query("update workspaces set name = 'Changed by someone else' where id = $1", [ws]);
    const r = await admin.post('/undo', { back: `/w/${ws}` }, `/w/${ws}`);
    assert.equal(r.status, 409);
    assert.equal((await name(ws)).name, 'Changed by someone else');
  });

  await t.test('a new edit clears the redo chain', async () => {
    await pool.query("update workspaces set name = 'Busaiteen Villas Phase 2' where id = $1", [ws]);
    await admin.post('/undo', { back: `/w/${ws}` }, `/w/${ws}`);               // back to "Busaiteen Villas"
    await admin.post(`/w/${ws}/edit`, { name: 'Busaiteen Townhouses', location: 'Busaiteen', stage: '', manager: '', status: 'active' }, `/w/${ws}`);
    assert.match((await admin.post('/redo', { back: `/w/${ws}` }, `/w/${ws}`)).location, /msg=nothing_to_redo/);
    assert.equal((await name(ws)).name, 'Busaiteen Townhouses');
  });
});
