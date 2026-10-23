'use strict';
const { hashPassword } = require('../db');
const { PERMISSIONS } = require('./core');
const { MIN_PW } = require('./auth');
const { layout, html, raw, pill, statusPill, csrfField, field, pager, emptyState, fmtDate, fmtDateTime, ROLE_LABELS } = require('./views');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_RE = /^[a-z0-9._-]{3,40}$/;
const UUID = /^[0-9a-f-]{36}$/i;
const PER = 30;
const bad = m => Object.assign(new Error(m), { status: 400 });

function mountAdmin(r, { pool, core, mailer, env, Forbidden, NotFound }) {
  r.use('/admin', (req, res, next) => core.isSuper(req.user) ? next() : next(new NotFound()));

  const adminTabs = cur => [['Users', '/admin/users', cur === 'users'], ['Roles', '/admin/roles', cur === 'roles'], ['Outbox', '/admin/outbox', cur === 'outbox'], ['Audit log', '/admin/audit', cur === 'audit'], ['System', '/admin/system', cur === 'system']];
  const page = (req, cur, title, body) => layout(req, { title, heading: 'Administration', crumbs: [['Home', '/'], ['Administration']], tabs: adminTabs(cur), body });

  r.get('/admin', (req, res) => res.redirect('/admin/users'));

  // ---------- users ----------
  async function roleOptions(kind) {
    return (await pool.query('select key, label from roles where kind = $1 order by label', [kind])).rows.map(x => [x.key, x.label]);
  }

  r.get('/admin/users', async (req, res) => {
    const users = (await pool.query(
      `select u.*, (select count(*)::int from workspace_members m where m.user_id = u.id and m.revoked_at is null) as ws
         from users u order by u.kind, u.active desc, coalesce(nullif(u.name,''), u.email)`)).rows;
    const roles = await roleOptions('internal');
    res.send(page(req, 'users', 'Users', html`
      <section class="panel"><h2 class="h">Users</h2>
        <div class="table-wrap"><table><thead><tr><th>Name</th><th>Sign-in</th><th>Type</th><th>Role</th><th>Two-step</th><th>Workspaces</th><th>Last sign-in</th><th>Status</th></tr></thead><tbody>
        ${users.map(u => html`<tr class="${u.active ? '' : 'dim'}"><td><a href="/admin/users/${u.id}"><b>${u.name || '—'}</b></a></td>
          <td>${u.email}${u.username ? html`<div class="muted small">${u.username}</div>` : ''}</td><td>${u.kind === 'external' ? 'External' : 'Staff'}</td>
          <td>${ROLE_LABELS[u.system_role] || u.system_role}</td><td>${u.mfa_enabled ? pill('On', 'ok') : pill('Off', 'muted')}</td>
          <td>${u.system_role === 'super_admin' ? 'All' : u.ws}</td><td class="small">${u.last_login_at ? fmtDateTime(u.last_login_at) : 'Never'}</td>
          <td>${u.active ? (u.locked_until && new Date(u.locked_until) > new Date() ? pill('Locked', 'bad') : pill('Active', 'ok')) : pill('Deactivated', 'muted')}</td></tr>`)}
        </tbody></table></div></section>
      <section class="panel"><h2 class="h">Add a user</h2>
        <form method="post" action="/admin/users" class="form-grid">${csrfField(req)}
          ${field({ name: 'name', label: 'Full name', required: true, attrs: 'maxlength="120"' })}
          ${field({ name: 'email', label: 'Email', type: 'email', required: true, attrs: 'maxlength="200" autocomplete="off"' })}
          ${field({ name: 'username', label: 'Username (optional)', attrs: 'maxlength="40" autocomplete="off" autocapitalize="none"', hint: 'Lower-case letters, numbers, dot, dash or underscore. They can also sign in with their email.' })}
          ${field({ name: 'kind', label: 'Type', value: 'internal', options: [['internal', 'SarayDar staff'], ['external', 'External viewer (client, owner, investor, seller, buyer)']] })}
          ${field({ name: 'system_role', label: 'Staff role', value: 'viewer', options: roles, hint: 'Ignored for external viewers. Their access is set per workspace.' })}
          ${field({ name: 'password', label: `Temporary password (${MIN_PW}+ characters)`, required: true, attrs: 'autocomplete="new-password"', hint: 'They must change it at first sign-in.' })}
          <div class="full actions"><button class="btn primary" type="submit">Add user</button></div>
        </form></section>`));
  });

  r.post('/admin/users', async (req, res) => {
    const name = String(req.body.name || '').trim().slice(0, 120);
    const email = String(req.body.email || '').trim().toLowerCase();
    const username = String(req.body.username || '').trim().toLowerCase() || null;
    const kind = req.body.kind === 'external' ? 'external' : 'internal';
    const pw = String(req.body.password || '');
    let role = 'external';
    if (kind === 'internal') {
      role = String(req.body.system_role || 'viewer');
      if (!(await roleOptions('internal')).some(([k]) => k === role)) throw bad('Choose a staff role.');
    }
    if (!name) throw bad('Enter the full name.');
    if (!EMAIL_RE.test(email)) throw bad('Enter a valid email address.');
    if (username && !USERNAME_RE.test(username)) throw bad('The username can use 3–40 lower-case letters, numbers, dot, dash or underscore.');
    if (pw.length < MIN_PW) throw bad(`The temporary password needs at least ${MIN_PW} characters.`);
    const legacyRole = role === 'super_admin' ? 'admin' : role === 'project_manager' ? 'editor' : role === 'engineer' ? 'site' : 'viewer';
    try {
      await core.inTx(async db => {
        const u = (await db.query(
          `insert into users (email, username, name, kind, system_role, role, password_hash, must_change_password) values ($1,$2,$3,$4,$5,$6,$7,true) returning id`,
          [email, username, name, kind, role, legacyRole, await hashPassword(pw)])).rows[0];
        await core.audit(db, { actor: req.user, action: 'user.created', entity: 'user', entityId: u.id, summary: `Added ${kind === 'external' ? 'external viewer' : ROLE_LABELS[role]} ${name}`, after: { email, username, kind, role }, ip: req.ip });
      });
    } catch (e) {
      if (e.code === '23505') throw bad('A user with that email or username already exists.');
      throw e;
    }
    res.redirect('/admin/users?msg=user_created');
  });

  async function loadUser(id) {
    if (!UUID.test(id)) throw new NotFound();
    const u = (await pool.query('select * from users where id = $1', [id])).rows[0];
    if (!u) throw new NotFound();
    return u;
  }

  r.get('/admin/users/:id', async (req, res) => {
    const u = await loadUser(req.params.id);
    const own = u.id === req.user.id;
    const ws = (await pool.query(
      `select w.id, w.name, w.ref, m.role from workspace_members m join workspaces w on w.id = m.workspace_id where m.user_id = $1 and m.revoked_at is null order by w.name`, [u.id])).rows;
    const roles = await roleOptions('internal');
    res.send(page(req, 'users', u.name || u.email, html`
      <p><a href="/admin/users">‹ All users</a></p>
      <div class="split">
        <section class="panel grow1"><h2 class="h">${u.name || u.email}</h2>
          <form method="post" action="/admin/users/${u.id}" class="form-grid">${csrfField(req)}
            ${field({ name: 'name', label: 'Full name', value: u.name, required: true, attrs: 'maxlength="120"' })}
            ${field({ name: 'username', label: 'Username', value: u.username || '', attrs: 'maxlength="40" autocapitalize="none"' })}
            ${u.kind === 'internal' ? field({ name: 'system_role', label: 'Staff role', value: u.system_role, options: roles, attrs: own ? 'disabled' : '' }) : html`<p class="full muted">External viewer · access is set per workspace.</p>`}
            ${field({ name: 'active', label: 'Account', value: u.active ? '1' : '0', options: [['1', 'Active'], ['0', 'Deactivated']], attrs: own ? 'disabled' : '' })}
            <div class="full actions"><button class="btn primary" type="submit">Save</button></div>
            ${own ? html`<p class="muted small full">You cannot change your own role or deactivate yourself.</p>` : ''}
          </form></section>
        <section class="panel grow1"><h2 class="h">Security</h2>
          <p>Email: <b>${u.email}</b><br>Two-step verification: ${u.mfa_enabled ? 'on' : 'off'}<br>Last sign-in: ${u.last_login_at ? fmtDateTime(u.last_login_at) : 'never'}</p>
          <form method="post" action="/admin/users/${u.id}/password" class="stack">${csrfField(req)}
            ${field({ name: 'password', label: `New temporary password (${MIN_PW}+ characters)`, attrs: 'autocomplete="new-password"' })}
            <button class="btn" type="submit">Set temporary password</button>
            <small class="muted">Signs them out everywhere. They must choose a new password at next sign-in.</small></form>
          ${u.mfa_enabled && !own ? html`<form method="post" action="/admin/users/${u.id}/mfa-reset">${csrfField(req)}<button class="btn" type="submit">Reset two-step verification</button></form>` : ''}
        </section>
      </div>
      <section class="panel"><h2 class="h">Workspaces</h2>
        ${u.system_role === 'super_admin' ? html`<p class="muted">Super Admins can open every workspace.</p>`
          : ws.length ? html`<ul class="rows">${ws.map(w => html`<li><a class="grow" href="/w/${w.id}">${w.name}</a><span class="mono small">${w.ref}</span><span>${w.role}</span></li>`)}</ul>`
          : html`<p class="muted">Not added to any workspace yet. Add them from a workspace's Access &amp; Invitations tab.</p>`}
      </section>`));
  });

  r.post('/admin/users/:id', async (req, res) => {
    const u = await loadUser(req.params.id);
    const own = u.id === req.user.id;
    const name = String(req.body.name || '').trim().slice(0, 120);
    const username = String(req.body.username || '').trim().toLowerCase() || null;
    if (!name) throw bad('Enter the full name.');
    if (username && !USERNAME_RE.test(username)) throw bad('The username can use 3–40 lower-case letters, numbers, dot, dash or underscore.');
    let role = u.system_role, active = u.active;
    if (!own) {
      if (u.kind === 'internal' && req.body.system_role) {
        if (!(await roleOptions('internal')).some(([k]) => k === req.body.system_role)) throw bad('Choose a staff role.');
        role = req.body.system_role;
      }
      if (req.body.active === '0' || req.body.active === '1') active = req.body.active === '1';
    }
    const before = { name: u.name, username: u.username, system_role: u.system_role, active: u.active };
    const after = { name, username, system_role: role, active };
    try {
      await core.inTx(async db => {
        await db.query('update users set name = $2, username = $3, system_role = $4, active = $5, token_version = token_version + case when $5 then 0 else 1 end where id = $1', [u.id, name, username, role, active]);
        if (!active) await core.endAllSessions(db, u.id);
        await core.audit(db, { actor: req.user, action: active ? 'user.updated' : 'user.deactivated', entity: 'user', entityId: u.id, summary: `Updated ${name}`, before, after, ip: req.ip });
      });
    } catch (e) { if (e.code === '23505') throw bad('That username is already taken.'); throw e; }
    res.redirect(`/admin/users/${u.id}?msg=user_saved`);
  });

  r.post('/admin/users/:id/password', async (req, res) => {
    const u = await loadUser(req.params.id);
    const pw = String(req.body.password || '');
    if (pw.length < MIN_PW) throw bad(`The temporary password needs at least ${MIN_PW} characters.`);
    await core.inTx(async db => {
      await db.query('update users set password_hash = $2, must_change_password = true, token_version = token_version + 1, failed_logins = 0, locked_until = null where id = $1', [u.id, await hashPassword(pw)]);
      await core.endAllSessions(db, u.id, u.id === req.user.id ? req.session.id : null);
      await core.audit(db, { actor: req.user, action: 'user.password_set', entity: 'user', entityId: u.id, summary: `Set a temporary password for ${u.name || u.email}`, ip: req.ip });
    });
    res.redirect(`/admin/users/${u.id}?msg=pw_reset`);
  });

  r.post('/admin/users/:id/mfa-reset', async (req, res) => {
    const u = await loadUser(req.params.id);
    if (u.id === req.user.id) throw bad('Use Account & security to change your own two-step verification.');
    await core.inTx(async db => {
      await db.query("update users set mfa_enabled = false, mfa_secret = null, mfa_recovery = '[]' where id = $1", [u.id]);
      await core.endAllSessions(db, u.id);
      await core.audit(db, { actor: req.user, action: 'user.mfa_reset', entity: 'user', entityId: u.id, summary: `Reset two-step verification for ${u.name || u.email}`, ip: req.ip });
    });
    res.redirect(`/admin/users/${u.id}?msg=mfa_reset`);
  });

  // ---------- roles ----------
  r.get('/admin/roles', async (req, res) => {
    const roles = (await pool.query("select * from roles where kind = 'internal' and key <> 'super_admin' order by label")).rows;
    res.send(page(req, 'roles', 'Roles', html`<section class="panel"><h2 class="h">What each staff role can do</h2>
      <p class="muted">Everyone can open the workspaces they are added to. These switches add section-wide abilities. Super Admin can do everything and cannot be changed.</p>
      <form method="post" action="/admin/roles">${csrfField(req)}
        <div class="table-wrap"><table><thead><tr><th>Ability</th>${roles.map(r2 => html`<th class="c">${r2.label}</th>`)}</tr></thead><tbody>
          ${Object.entries(PERMISSIONS).map(([p, label]) => html`<tr><td>${label}</td>${roles.map(r2 => html`<td class="c"><input type="checkbox" aria-label="${r2.label}: ${label}" name="${r2.key}" value="${p}" ${r2.permissions.includes(p) ? raw('checked') : ''}></td>`)}</tr>`)}
        </tbody></table></div>
        <div class="actions"><button class="btn primary" type="submit">Save</button></div></form></section>`));
  });

  r.post('/admin/roles', async (req, res) => {
    const roles = (await pool.query("select * from roles where kind = 'internal' and key <> 'super_admin'")).rows;
    await core.inTx(async db => {
      for (const role of roles) {
        let v = req.body[role.key]; v = Array.isArray(v) ? v : v ? [v] : [];
        const next = v.filter(p => p in PERMISSIONS).sort();
        const prev = [...role.permissions].sort();
        if (JSON.stringify(next) === JSON.stringify(prev)) continue;
        await db.query('update roles set permissions = $2 where key = $1', [role.key, next]);
        await core.audit(db, { actor: req.user, action: 'role.permissions_changed', entity: 'role', entityId: role.key, summary: `Changed ${role.label} permissions`, before: { permissions: prev }, after: { permissions: next }, ip: req.ip });
      }
    });
    res.redirect('/admin/roles?msg=roles');
  });

  // ---------- outbox ----------
  r.get('/admin/outbox', async (req, res) => {
    const p = Math.max(1, parseInt(req.query.page, 10) || 1);
    const total = (await pool.query('select count(*)::int as n from outbox_messages')).rows[0].n;
    const rows = (await pool.query(`select * from outbox_messages order by id desc limit ${PER} offset ${(p - 1) * PER}`)).rows;
    res.send(page(req, 'outbox', 'Outbox', html`<section class="panel"><h2 class="h">Outbox</h2>
      <p class="muted">Every email the system creates is listed here. “Not configured” means no SMTP account is set up, so nothing was sent. Password-reset contents are never shown.</p>
      ${rows.length ? html`<div class="table-wrap"><table><thead><tr><th>Created</th><th>To</th><th>Subject</th><th>Type</th><th>Status</th></tr></thead><tbody>
        ${rows.map(m => html`<tr><td class="small">${fmtDateTime(m.created_at)}</td><td>${m.to_address}</td>
          <td>${m.subject}${!m.sensitive && m.body_text ? html`<details><summary class="small">Show text</summary><pre class="pre">${m.body_text}</pre></details>` : ''}</td>
          <td class="small">${m.kind}</td><td>${statusPill(m.status === 'unconfigured' ? 'unconfigured' : m.status)}${m.error ? html`<div class="small err">${m.error}</div>` : ''}</td></tr>`)}
        </tbody></table></div>${pager(req, total, p, PER)}` : html`<p class="muted">No emails yet.</p>`}</section>`));
  });

  // ---------- audit ----------
  r.get('/admin/audit', async (req, res) => {
    const p = Math.max(1, parseInt(req.query.page, 10) || 1);
    const q = String(req.query.q || '').trim().slice(0, 80);
    const vals = []; let where = 'true';
    if (q) { vals.push(`%${q.replace(/[%_\\]/g, '\\$&')}%`); where = `(e.action ilike $1 or coalesce(e.summary,'') ilike $1 or coalesce(e.actor_label,'') ilike $1)`; }
    const total = (await pool.query(`select count(*)::int as n from audit_events e where ${where}`, vals)).rows[0].n;
    const rows = (await pool.query(`select e.*, w.name as ws_name from audit_events e left join workspaces w on w.id = e.workspace_id where ${where} order by e.id desc limit ${PER} offset ${(p - 1) * PER}`, vals)).rows;
    res.send(page(req, 'audit', 'Audit log', html`<section class="panel"><h2 class="h">Audit log</h2>
      <form class="filters" method="get"><label class="searchbox"><input type="search" name="q" value="${q}" placeholder="Filter by action, person or text" aria-label="Filter"></label><button class="btn" type="submit">Filter</button></form>
      <p class="muted small">The log is append-only: the database refuses edits and deletions.</p>
      <div class="table-wrap"><table><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Workspace</th><th>Details</th><th>IP</th></tr></thead><tbody>
        ${rows.map(e => html`<tr><td class="small">${fmtDateTime(e.at)}</td><td>${e.actor_label}</td><td class="mono small">${e.action}</td>
          <td>${e.ws_name ? html`<a href="/w/${e.workspace_id}">${e.ws_name}</a>` : '—'}</td><td>${e.summary || ''}${e.before || e.after ? html`<details><summary class="small">Changes</summary><pre class="pre">${JSON.stringify({ before: e.before, after: e.after }, null, 1)}</pre></details>` : ''}</td><td class="small mono">${e.ip || ''}</td></tr>`)}
      </tbody></table></div>${pager(req, total, p, PER)}</section>`));
  });

  // ---------- system ----------
  r.get('/admin/system', async (req, res) => {
    const db = (await pool.query("select pg_size_pretty(pg_database_size(current_database())) as size, (select count(*)::int from files) as files, (select coalesce(sum(size),0)::bigint from files) as bytes, (select max(name) from schema_migrations) as mig")).rows[0];
    res.send(page(req, 'system', 'System', html`<section class="panel"><h2 class="h">System</h2>
      <dl class="details">
        <div><dt>Email delivery</dt><dd>${mailer.configured ? html`${pill('Configured', 'ok')} ${mailer.describe()}` : html`${pill('Not configured', 'warn')} Emails are kept in the Outbox and not sent.`}</dd></div>
        <div><dt>File storage</dt><dd>Database · ${db.files} files · ${(Number(db.bytes) / 1048576).toFixed(1)} MB</dd></div>
        <div><dt>Database size</dt><dd>${db.size}</dd></div>
        <div><dt>Schema version</dt><dd class="mono">${db.mig}</dd></div>
        <div><dt>Time zone</dt><dd>Asia/Bahrain</dd></div>
        <div><dt>Payment gateway</dt><dd>Not part of this release</dd></div>
        <div><dt>AI assistant</dt><dd>${env.ANTHROPIC_API_KEY ? 'Key present (assistant arrives in Phase 7)' : 'Not configured'}</dd></div>
      </dl></section>
      <section class="panel"><h2 class="h">Set up Outlook email</h2>
        <p>In Render › saraydar-api › Environment add:</p>
        <ul class="mono small"><li>SMTP_HOST = smtp.office365.com</li><li>SMTP_PORT = 587</li><li>SMTP_USER = info@saraydar.com</li><li>SMTP_PASS = the mailbox password or app password</li><li>MAIL_FROM = SarayDar &lt;info@saraydar.com&gt;</li><li>APP_URL = https://portal.saraydar.com</li></ul>
        <p class="muted small">Microsoft 365 must have “Authenticated SMTP” enabled for the info@ mailbox (Microsoft 365 admin centre › Users › info@ › Mail › Manage email apps). If the account uses two-step sign-in, create an app password.</p>
      </section>`));
  });
}

module.exports = { mountAdmin };
