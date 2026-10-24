'use strict';
// Microsoft 365 (Graph) delivery: token, sendMail call, attachments, honest failure status.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createMailer, graphConfig } = require('../lib/mailer');

function fakePool() {
  const rows = new Map(); let n = 0;
  return { rows, query: async (sql, v) => {
    if (/^\s*insert into outbox_messages/.test(sql)) { const id = ++n; rows.set(id, { status: v[5] }); return { rows: [{ id }] }; }
    if (/status = 'sent'/.test(sql)) { rows.get(v[0]).status = 'sent'; rows.get(v[0]).provider = v[1]; return { rows: [] }; }
    if (/status = 'failed'/.test(sql)) { rows.get(v[0]).status = 'failed'; rows.get(v[0]).error = v[1]; return { rows: [] }; }
    return { rows: [] };
  } };
}

test('Microsoft Graph delivery', async t => {
  const calls = [];
  let mode = 'ok';
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', d => { b += d; }); req.on('end', () => {
      calls.push({ url: req.url, auth: req.headers.authorization, body: b });
      if (req.url.endsWith('/oauth2/v2.0/token')) {
        const p = new URLSearchParams(b);
        if (p.get('client_secret') !== 'good-secret') { res.writeHead(401, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'invalid_client' })); }
        res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ access_token: 'tok-1', expires_in: 3600 }));
      }
      if (mode === 'forbidden') { res.writeHead(403, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { code: 'ErrorAccessDenied' } })); }
      res.writeHead(202, { 'request-id': 'req-123' }); res.end();
    });
  }).listen(0);
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}`;
  const env = { MS_TENANT_ID: 'tenant-1', MS_CLIENT_ID: 'client-1', MS_CLIENT_SECRET: 'good-secret', MAIL_FROM: 'SarayDar <info@saraydar.com>', MS_LOGIN_URL: base, MS_GRAPH_URL: base };

  assert.deepEqual([graphConfig(env).address, graphConfig(env).name], ['info@saraydar.com', 'SarayDar']);
  assert.equal(graphConfig({ ...env, MS_CLIENT_SECRET: '' }), null);

  const pool = fakePool();
  const m = createMailer({ pool, env });
  assert.equal(m.configured, true); assert.equal(m.provider, 'graph');
  assert.match(m.describe(), /Microsoft 365 \(Graph\) as info@saraydar\.com/);
  const r1 = await m.send({ to: 'tenant@example.com', subject: 'Invoice RNT-1', text: 'Hello', kind: 'rent_invoice', attachments: [{ filename: 'RNT-1.pdf', content: Buffer.from('%PDF-1.4'), contentType: 'application/pdf' }] });
  assert.equal(r1.status, 'sent'); assert.equal(pool.rows.get(r1.id).provider, 'req-123');
  const send = calls.find(c => c.url.includes('/sendMail'));
  assert.equal(send.url, '/v1.0/users/info%40saraydar.com/sendMail'); assert.equal(send.auth, 'Bearer tok-1');
  const msg = JSON.parse(send.body).message;
  assert.equal(msg.toRecipients[0].emailAddress.address, 'tenant@example.com');
  assert.equal(msg.attachments[0].name, 'RNT-1.pdf'); assert.equal(Buffer.from(msg.attachments[0].contentBytes, 'base64').toString(), '%PDF-1.4');
  // the token is reused
  await m.send({ to: 'a@example.com', subject: 's', text: 't', kind: 'test' });
  assert.equal(calls.filter(c => c.url.endsWith('/token')).length, 1);
  // refusals are recorded as failed, never as sent
  mode = 'forbidden';
  const r2 = await m.send({ to: 'a@example.com', subject: 's', text: 't', kind: 'test' });
  assert.equal(r2.status, 'failed'); assert.match(pool.rows.get(r2.id).error, /403: ErrorAccessDenied/);
  const bad = createMailer({ pool, env: { ...env, MS_CLIENT_SECRET: 'wrong' } });
  const r3 = await bad.send({ to: 'a@example.com', subject: 's', text: 't', kind: 'test' });
  assert.equal(r3.status, 'failed'); assert.match(r3.error, /sign-in failed \(401: invalid_client\)/);
  // not configured: kept in the Outbox as unconfigured
  const none = createMailer({ pool, env: {} });
  assert.equal((await none.send({ to: 'a@example.com', subject: 's', text: 't', kind: 'test' })).status, 'unconfigured');
});
