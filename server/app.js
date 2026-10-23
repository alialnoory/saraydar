'use strict';
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { COLLECTIONS, ROLES, hashPassword, verifyPassword } = require('./db');

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SITE_TASK_FIELDS = ['status', 'progress', 'notes'];
const TOKEN_HOURS = 12;

class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}
const fail = (status, message, code) => { throw new HttpError(status, message, code); };

// What each role may do with records
function allowed(role, coll, action) {
  if (role === 'admin' || role === 'editor') return true;
  if (role === 'site') {
    if (coll === 'log') return action === 'create' || action === 'update';
    if (coll === 'tasks') return action === 'update';
  }
  return false;
}

const isObject = v => v && typeof v === 'object' && !Array.isArray(v);
const publicUser = u => ({ id: u.id, email: u.email, name: u.name, role: u.role, active: u.active, created_at: u.created_at });

function summarise(coll, id, data) {
  const d = data || {};
  const text = d.title || d.item || d.risk || d.unit || d.name || d.payee || (d.work ? String(d.work).slice(0, 70) : '') || id;
  return String(text);
}

function changedFields(a, b) {
  const out = [];
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of keys) {
    if (k === 'updatedAt') continue;
    if (JSON.stringify((a || {})[k]) !== JSON.stringify((b || {})[k])) out.push(k);
  }
  return out;
}

function createApp({ pool, jwtSecret, corsOrigins = [] }) {
  if (!jwtSecret || jwtSecret.length < 32) throw new Error('JWT_SECRET must be at least 32 characters');
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({
    origin(origin, cb) { cb(null, !origin || corsOrigins.includes(origin)); },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 600
  }));
  app.use(express.json({ limit: '100kb' }));

  const dummyHash = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(64).toString('base64');
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false,
    message: { error: 'Too many sign-in attempts. Try again in a few minutes.' }
  });

  const signToken = u => jwt.sign({ sub: u.id, tv: u.token_version }, jwtSecret, { algorithm: 'HS256', expiresIn: `${TOKEN_HOURS}h` });

  async function auth(req, res, next) {
    const m = /^Bearer (.+)$/.exec(req.get('authorization') || '');
    if (!m) return res.status(401).json({ error: 'Sign in required.', code: 'auth' });
    let payload;
    try { payload = jwt.verify(m[1], jwtSecret, { algorithms: ['HS256'] }); }
    catch (e) { return res.status(401).json({ error: 'Your session has ended. Sign in again.', code: 'auth' }); }
    const { rows } = await pool.query('select id, email, name, role, active, token_version, created_at from users where id = $1', [payload.sub]);
    const u = rows[0];
    if (!u || !u.active || u.token_version !== payload.tv) return res.status(401).json({ error: 'Your session has ended. Sign in again.', code: 'auth' });
    req.user = u;
    next();
  }
  const requireRole = (...roles) => (req, res, next) => roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'Your role does not allow this.' });

  app.get('/', (req, res) => res.json({ service: 'saraydar-api', ok: true }));
  app.get('/api/health', async (req, res) => { await pool.query('select 1'); res.json({ ok: true }); });

  // ---- sign in ----
  app.post('/api/auth/login', loginLimiter, async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (!email || !password) fail(400, 'Enter your email and password.');
    const { rows } = await pool.query('select * from users where lower(email) = $1', [email]);
    const u = rows[0];
    const ok = await verifyPassword(password, u ? u.password_hash : dummyHash);
    if (!u || !ok || !u.active) fail(401, 'Email or password is incorrect.');
    res.json({ token: signToken(u), user: publicUser(u) });
  });

  app.get('/api/auth/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));

  app.post('/api/auth/password', auth, async (req, res) => {
    const current = String(req.body?.current || ''), next = String(req.body?.next || '');
    if (next.length < 8) fail(400, 'Use at least 8 characters for the new password.');
    const { rows } = await pool.query('select * from users where id = $1', [req.user.id]);
    if (!(await verifyPassword(current, rows[0].password_hash))) fail(400, 'Your current password is incorrect.');
    const upd = await pool.query(
      'update users set password_hash = $2, token_version = token_version + 1 where id = $1 returning id, token_version',
      [req.user.id, await hashPassword(next)]
    );
    res.json({ token: signToken(upd.rows[0]) });
  });

  // ---- records ----
  app.get('/api/records', auth, async (req, res) => {
    const { rows } = await pool.query('select collection, id, data from records');
    const out = Object.fromEntries(COLLECTIONS.map(c => [c, []]));
    for (const r of rows) out[r.collection].push({ id: r.id, ...r.data });
    res.json(out);
  });

  function checkColl(req) {
    const coll = req.params.collection;
    if (!COLLECTIONS.includes(coll)) fail(404, 'Unknown section.');
    return coll;
  }
  function cleanBody(req) {
    if (!isObject(req.body)) fail(400, 'Send the record as a JSON object.');
    const { id, ...data } = req.body;
    return data;
  }
  async function writeHistory(client, coll, id, action, oldData, newData, user) {
    await client.query(
      'insert into record_history (collection, id, action, old_data, new_data, changed_by, changed_by_email) values ($1,$2,$3,$4,$5,$6,$7)',
      [coll, id, action, oldData, newData, user.id, user.email]
    );
  }
  async function inTx(fn) {
    const client = await pool.connect();
    try { await client.query('begin'); const out = await fn(client); await client.query('commit'); return out; }
    catch (e) { await client.query('rollback').catch(() => {}); throw e; }
    finally { client.release(); }
  }

  app.post('/api/records/:collection', auth, async (req, res) => {
    const coll = checkColl(req);
    if (!allowed(req.user.role, coll, 'create')) fail(403, 'Your role does not allow adding here.');
    if (coll === 'meta') fail(400, 'Project details are edited, not added.');
    const data = cleanBody(req);
    const id = crypto.randomUUID();
    await inTx(async c => {
      await c.query('insert into records (collection, id, data, updated_by) values ($1,$2,$3,$4)', [coll, id, data, req.user.id]);
      await writeHistory(c, coll, id, 'create', null, data, req.user);
    });
    res.status(201).json({ id });
  });

  app.put('/api/records/:collection/:id', auth, async (req, res) => {
    const coll = checkColl(req), id = req.params.id;
    if (!ID_RE.test(id)) fail(400, 'Invalid record id.');
    if (!allowed(req.user.role, coll, 'update')) fail(403, 'Your role does not allow changing this.');
    let data = cleanBody(req);
    await inTx(async c => {
      const cur = await c.query('select data from records where collection = $1 and id = $2 for update', [coll, id]);
      if (!cur.rowCount && !(coll === 'meta' && id === 'project')) fail(404, 'That record no longer exists.');
      const old = cur.rowCount ? cur.rows[0].data : null;
      if (req.user.role === 'site' && coll === 'tasks') {
        data = { ...old };
        for (const k of SITE_TASK_FIELDS) if (k in req.body) data[k] = req.body[k];
      }
      await c.query(
        `insert into records (collection, id, data, updated_by) values ($1,$2,$3,$4)
         on conflict (collection, id) do update set data = excluded.data, updated_at = now(), updated_by = excluded.updated_by`,
        [coll, id, data, req.user.id]
      );
      await writeHistory(c, coll, id, old ? 'update' : 'create', old, data, req.user);
    });
    res.json({ id });
  });

  app.delete('/api/records/:collection/:id', auth, async (req, res) => {
    const coll = checkColl(req), id = req.params.id;
    if (!allowed(req.user.role, coll, 'delete')) fail(403, 'Your role does not allow deleting.');
    if (coll === 'meta') fail(400, 'Project details cannot be deleted.');
    await inTx(async c => {
      const r = await c.query('delete from records where collection = $1 and id = $2 returning data', [coll, id]);
      if (r.rowCount) await writeHistory(c, coll, id, 'delete', r.rows[0].data, null, req.user);
    });
    res.json({ ok: true });
  });

  // ---- change history ----
  app.get('/api/history', auth, requireRole('admin', 'editor'), async (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 500);
    const { rows } = await pool.query(
      `select h.history_id, h.collection, h.id, h.action, h.old_data, h.new_data, h.changed_at,
              coalesce(u.name, '') as name, coalesce(u.email, h.changed_by_email, '') as email
         from record_history h left join users u on u.id = h.changed_by
        order by h.history_id desc limit $1`, [limit]);
    res.json(rows.map(h => ({
      id: h.history_id, when: h.changed_at, who: h.name || h.email, email: h.email,
      collection: h.collection, record: h.id, action: h.action,
      summary: summarise(h.collection, h.id, h.new_data || h.old_data),
      fields: h.action === 'update' ? changedFields(h.old_data, h.new_data) : []
    })));
  });

  // ---- users (administrators) ----
  app.get('/api/users', auth, requireRole('admin'), async (req, res) => {
    const { rows } = await pool.query('select id, email, name, role, active, created_at from users order by created_at');
    res.json(rows);
  });

  app.post('/api/users', auth, requireRole('admin'), async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const name = String(req.body?.name || '').trim().slice(0, 120);
    const role = String(req.body?.role || 'viewer');
    const password = String(req.body?.password || '');
    if (!EMAIL_RE.test(email)) fail(400, 'Enter a valid email address.');
    if (!ROLES.includes(role)) fail(400, 'Choose a role.');
    if (password.length < 8) fail(400, 'The temporary password needs at least 8 characters.');
    try {
      const { rows } = await pool.query(
        'insert into users (email, name, role, password_hash) values ($1,$2,$3,$4) returning id, email, name, role, active, created_at',
        [email, name, role, await hashPassword(password)]
      );
      res.status(201).json(rows[0]);
    } catch (e) {
      if (e.code === '23505') fail(409, 'A user with that email already exists.');
      throw e;
    }
  });

  app.patch('/api/users/:id', auth, requireRole('admin'), async (req, res) => {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) fail(400, 'Invalid user.');
    const cur = (await pool.query('select * from users where id = $1', [req.params.id])).rows[0];
    if (!cur) fail(404, 'User not found.');
    const sets = [], vals = [req.params.id];
    const add = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    const own = cur.id === req.user.id;
    if ('role' in req.body) {
      if (!ROLES.includes(req.body.role)) fail(400, 'Choose a role.');
      if (own && req.body.role !== cur.role) fail(400, 'You cannot change your own role.');
      add('role', req.body.role);
    }
    if ('active' in req.body) {
      if (own && !req.body.active) fail(400, 'You cannot deactivate yourself.');
      add('active', !!req.body.active);
      if (!req.body.active) sets.push('token_version = token_version + 1');
    }
    if ('name' in req.body) add('name', String(req.body.name || '').trim().slice(0, 120));
    if ('password' in req.body) {
      const pw = String(req.body.password || '');
      if (pw.length < 8) fail(400, 'The new password needs at least 8 characters.');
      add('password_hash', await hashPassword(pw));
      sets.push('token_version = token_version + 1');
    }
    if (!sets.length) fail(400, 'Nothing to change.');
    const { rows } = await pool.query(`update users set ${sets.join(', ')} where id = $1 returning id, email, name, role, active, created_at`, vals);
    res.json(rows[0]);
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request.' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That is too large to save.' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Try again.' });
  });

  return app;
}

module.exports = { createApp, allowed };
