'use strict';
// Shared portal building blocks: sections, permissions, audit, numbering, sessions.
const { randomToken, sha256 } = require('../lib/security');

const SECTIONS = {
  dev: {
    key: 'dev', name: 'SarayDar Real Estate Development', kinds: ['project'],
    create: { project: { label: 'Create New Project', prefix: 'DEV', party: null } },
    noun: 'project', empty: 'No development projects yet.'
  },
  cpm: {
    key: 'cpm', name: 'Clients Projects Management', kinds: ['client_project'],
    create: { client_project: { label: 'Create New Client Project', prefix: 'CPM', party: { label: 'Client', role: 'client' } } },
    noun: 'client project', empty: 'No client projects yet.'
  },
  props: {
    key: 'props', name: 'Clients Properties Management', kinds: ['property'],
    create: { property: { label: 'Add New Property', prefix: 'PRP', party: { label: 'Owner', role: 'owner' } } },
    noun: 'property', empty: 'No managed properties yet.'
  },
  sales: {
    key: 'sales', name: 'Property Sales & Acquisition', kinds: ['listing', 'request', 'deal'],
    create: {
      listing: { label: 'Add Property for Sale', prefix: 'SL', party: { label: 'Seller', role: 'seller' } },
      request: { label: 'Create Property Search Request', prefix: 'AR', party: { label: 'Buyer client', role: 'buyer' } }
    },
    tabs: [['listing', 'Sales Listings'], ['request', 'Acquisition Requests']],
    noun: 'case', empty: 'No sales listings or acquisition requests yet.'
  }
};
const SECTION_KEYS = Object.keys(SECTIONS);
const KIND_LABEL = { project: 'Development project', client_project: 'Client project', property: 'Property', listing: 'Sale listing', request: 'Acquisition request', deal: 'Deal' };
const STATUS_LABEL = { active: 'Active', on_hold: 'On hold', completed: 'Completed', archived: 'Archived' };

const INTERNAL_MEMBER_ROLES = { manager: 'Manager', editor: 'Editor', contributor: 'Contributor', viewer: 'Viewer' };
const EXTERNAL_MEMBER_ROLES = { client_viewer: 'Client Viewer', owner_viewer: 'Owner Viewer', investor_viewer: 'Investor Viewer', seller_viewer: 'Seller Viewer', buyer_viewer: 'Buyer Viewer', tenant: 'Tenant' };
const PERMISSIONS = {
  'create:dev': 'Create development projects',
  'create:cpm': 'Create client projects',
  'create:props': 'Add managed properties',
  'create:sales': 'Add sale listings and search requests',
  'view:financials': 'See financial figures in workspaces they belong to',
  'finance:post': 'Post invoices, receipts and payments'
};

const SESSION_COOKIE = 'sd_sid';
const SESSION_HOURS = 12;
const IDLE_MINUTES = 120;

function createCore({ pool }) {
  async function audit(db, { actor, workspaceId = null, action, entity = null, entityId = null, summary = null, before = null, after = null, ip = null }) {
    await (db || pool).query(
      `insert into audit_events (actor_id, actor_label, workspace_id, action, entity, entity_id, summary, before, after, ip)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [actor ? actor.id : null, actor ? (actor.name || actor.email) : 'system', workspaceId, action, entity, entityId && String(entityId), summary, before, after, ip]);
  }

  async function inTx(fn) {
    const c = await pool.connect();
    try { await c.query('begin'); const r = await fn(c); await c.query('commit'); return r; }
    catch (e) { await c.query('rollback').catch(() => {}); throw e; }
    finally { c.release(); }
  }

  async function nextNumber(db, key) {
    const { rows } = await db.query(
      `insert into number_series (key, next_value) values ($1, 2)
       on conflict (key) do update set next_value = number_series.next_value + 1
       returning next_value - 1 as n`, [key]);
    return rows[0].n;
  }

  // ---- permissions ----
  async function loadPermissions(user) {
    if (!user) return [];
    if (user._perms) return user._perms;
    const { rows } = await pool.query('select permissions from roles where key = $1', [user.system_role]);
    user._perms = rows[0] ? rows[0].permissions : [];
    return user._perms;
  }
  const isSuper = u => !!u && u.system_role === 'super_admin' && u.kind === 'internal';
  const isExternal = u => !!u && u.kind === 'external';
  async function can(user, perm) {
    if (!user || isExternal(user)) return false;
    const p = await loadPermissions(user);
    return p.includes('*') || p.includes(perm);
  }

  // Access to one workspace: { role, internal } or null. Never trust a client-supplied ID beyond lookup.
  async function workspaceAccess(user, wsId) {
    if (!user || !/^[0-9a-f-]{36}$/i.test(String(wsId))) return null;
    const ws = (await pool.query('select * from workspaces where id = $1', [wsId])).rows[0];
    if (!ws) return null;
    if (isSuper(user)) return { ws, role: 'manager', internal: true };
    const m = (await pool.query(
      'select role, grants from workspace_members where workspace_id = $1 and user_id = $2 and revoked_at is null', [wsId, user.id])).rows[0];
    if (!m) return null;
    const internal = !isExternal(user) && m.role in INTERNAL_MEMBER_ROLES;
    if (isExternal(user) && !(m.role in EXTERNAL_MEMBER_ROLES)) return null;
    return { ws, role: m.role, grants: m.grants || {}, internal };
  }
  const canEdit = a => !!a && a.internal && (a.role === 'manager' || a.role === 'editor');
  const canContribute = a => !!a && a.internal && ['manager', 'editor', 'contributor'].includes(a.role);
  const canManageAccess = (user, a) => isSuper(user) || (!!a && a.internal && a.role === 'manager');

  // SQL fragment restricting workspaces to what the user may see. $1 must be the user id.
  const visibleWhere = user => isSuper(user)
    ? '($1::uuid is not null)'
    : `exists (select 1 from workspace_members m where m.workspace_id = w.id and m.user_id = $1 and m.revoked_at is null)`;

  // ---- sessions ----
  async function createSession(res, req, userId) {
    const token = randomToken(32);
    const csrf = randomToken(24);
    await pool.query(
      `insert into sessions (id, user_id, csrf, expires_at, ip, user_agent) values ($1,$2,$3, now() + interval '${SESSION_HOURS} hours', $4, $5)`,
      [sha256(token), userId, csrf, req.ip, String(req.get('user-agent') || '').slice(0, 300)]);
    res.cookie(SESSION_COOKIE, token, { httpOnly: true, secure: req.secure, sameSite: 'lax', path: '/', maxAge: SESSION_HOURS * 3600 * 1000 });
    return { id: sha256(token), csrf, mfa_ok: false };
  }
  async function loadSession(req) {
    const token = req.cookies && req.cookies[SESSION_COOKIE];
    if (!token || typeof token !== 'string' || token.length > 200) return null;
    const { rows } = await pool.query(
      `select s.id as sid, s.csrf, s.mfa_ok, s.last_seen_at, u.*,
              (select extract(epoch from p.updated_at)::bigint from user_photos p where p.user_id = u.id) as photo_v
         from sessions s join users u on u.id = s.user_id
        where s.id = $1 and s.expires_at > now() and s.last_seen_at > now() - interval '${IDLE_MINUTES} minutes' and u.active`,
      [sha256(token)]);
    if (!rows[0]) return null;
    const r = rows[0];
    if (Date.now() - new Date(r.last_seen_at).getTime() > 60_000) pool.query('update sessions set last_seen_at = now() where id = $1', [r.sid]).catch(() => {});
    const session = { id: r.sid, csrf: r.csrf, mfa_ok: r.mfa_ok };
    for (const k of ['sid', 'csrf', 'mfa_ok', 'last_seen_at']) delete r[k];
    return { session, user: r };
  }
  async function endSession(req, res) {
    const token = req.cookies && req.cookies[SESSION_COOKIE];
    if (token) await pool.query('delete from sessions where id = $1', [sha256(token)]);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
  }
  const endAllSessions = (db, userId, exceptId = null) =>
    (db || pool).query('delete from sessions where user_id = $1 and ($2::text is null or id <> $2)', [userId, exceptId]);

  return {
    audit, inTx, nextNumber, loadPermissions, isSuper, isExternal, can, workspaceAccess, canEdit, canContribute, canManageAccess,
    visibleWhere, createSession, loadSession, endSession, endAllSessions
  };
}

module.exports = {
  createCore, SECTIONS, SECTION_KEYS, KIND_LABEL, STATUS_LABEL, INTERNAL_MEMBER_ROLES, EXTERNAL_MEMBER_ROLES, PERMISSIONS,
  SESSION_COOKIE
};
