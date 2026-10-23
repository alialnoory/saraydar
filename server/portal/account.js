'use strict';
const { hashPassword, verifyPassword } = require('../db');
const sec = require('../lib/security');
const { MIN_PW, homeFor } = require('./auth');
const { layout, html, pill, csrfField, field, fmtDateTime, ROLE_LABELS } = require('./views');
const { photoForm } = require('./people');

function mountAccount(r, ctx) {
  const { pool, core, secret } = ctx;
  r.get('/account', async (req, res) => {
    const u = req.user;
    const sessions = (await pool.query('select id, created_at, last_seen_at, ip, user_agent from sessions where user_id = $1 and expires_at > now() order by last_seen_at desc', [u.id])).rows;
    res.send(layout(req, { title: 'Account', heading: 'Account & security', crumbs: [[u.kind === 'external' ? 'My Workspaces' : 'Home', homeFor(u)], ['Account']], body: html`
      <div class="split">
        <section class="panel grow1"><h2 class="h">Photo</h2>${photoForm(req, '/account/photo', u, '/account/photo/remove')}</section>
        <section class="panel grow1"><h2 class="h">Profile</h2>
          <dl class="details"><div><dt>Name</dt><dd>${u.name || '—'}</dd></div><div><dt>Email</dt><dd>${u.email}</dd></div>
            <div><dt>Username</dt><dd>${u.username || '—'}</dd></div><div><dt>Mobile</dt><dd>${u.phone || '—'}</dd></div><div><dt>Job title</dt><dd>${u.job_title || '—'}</dd></div><div><dt>Role</dt><dd>${ROLE_LABELS[u.system_role] || u.system_role}</dd></div></dl>
          <a class="btn" href="/account/password">Change password</a></section>
        ${ctx.mfaOn ? html`<section class="panel grow1"><h2 class="h">Two-step verification</h2>
          ${u.mfa_enabled ? html`<p>${pill('On', 'ok')} ${(u.mfa_recovery || []).length} recovery codes left.</p>
            <form method="post" action="/account/mfa/recovery">${csrfField(req)}<button class="btn" type="submit">Make new recovery codes</button></form>
            ${core.isSuper(u) ? html`<p class="muted small">Required for Super Admin accounts.</p>` : html`<form method="post" action="/account/mfa/disable" class="stack">${csrfField(req)}
              ${field({ name: 'password', label: 'Current password to turn it off', type: 'password', attrs: 'autocomplete="current-password"' })}<button class="btn" type="submit">Turn off</button></form>`}`
            : html`<p>${pill('Off', 'muted')} Adds a code from your phone at every sign-in.</p><a class="btn primary" href="/mfa/setup">Turn on</a>`}
        </section>` : ''}
      </div>
      <section class="panel"><h2 class="h">Where you are signed in</h2>
        <ul class="rows">${sessions.map(s => html`<li><div class="grow"><b>${s.id === req.session.id ? 'This device' : (s.user_agent || 'Unknown device').slice(0, 80)}</b><div class="muted small">Last active ${fmtDateTime(s.last_seen_at)} · ${s.ip || ''}</div></div></li>`)}</ul>
        ${sessions.length > 1 ? html`<form method="post" action="/account/sessions">${csrfField(req)}<button class="btn" type="submit">Sign out everywhere else</button></form>` : ''}
      </section>` }));
  });

  r.get('/account/password', (req, res) => {
    const forced = !!req.user.must_change_password;
    res.send(layout(req, { title: 'Change password', heading: forced ? 'Choose your own password' : 'Change password', body: html`
      <section class="panel narrow">${forced ? html`<p class="notice">You signed in with a temporary password. Choose your own to continue.</p>` : ''}
        <form method="post" action="/account/password" class="stack">${csrfField(req)}
          ${field({ name: 'current', label: forced ? 'Temporary password' : 'Current password', type: 'password', required: true, attrs: 'autocomplete="current-password"' })}
          ${field({ name: 'password', label: `New password (at least ${MIN_PW} characters)`, type: 'password', required: true, attrs: 'autocomplete="new-password"' })}
          ${field({ name: 'confirm', label: 'Confirm new password', type: 'password', required: true, attrs: 'autocomplete="new-password"' })}
          ${req.query.err ? html`<p class="err" role="alert">${{ current: 'The current password is not correct.', short: `Use at least ${MIN_PW} characters.`, match: 'The new passwords do not match.', same: 'Choose a password different from the temporary one.' }[req.query.err] || 'Try again.'}</p>` : ''}
          <button class="btn primary" type="submit">Save password</button></form></section>` }));
  });

  r.post('/account/password', async (req, res) => {
    const u = req.user;
    const cur = String(req.body.current || ''), pw = String(req.body.password || ''), pw2 = String(req.body.confirm || '');
    if (!(await verifyPassword(cur, u.password_hash))) return res.redirect('/account/password?err=current');
    if (pw.length < MIN_PW) return res.redirect('/account/password?err=short');
    if (pw !== pw2) return res.redirect('/account/password?err=match');
    if (pw === cur) return res.redirect('/account/password?err=same');
    await core.inTx(async db => {
      await db.query('update users set password_hash = $2, must_change_password = false, token_version = token_version + 1 where id = $1', [u.id, await hashPassword(pw)]);
      await core.endAllSessions(db, u.id, req.session.id);
      await core.audit(db, { actor: u, action: 'password.changed', entity: 'user', entityId: u.id, ip: req.ip });
    });
    res.redirect(homeFor(u) + '?msg=password');
  });

  r.post('/account/sessions', async (req, res) => {
    await core.endAllSessions(null, req.user.id, req.session.id);
    await core.audit(null, { actor: req.user, action: 'sessions.revoked', entity: 'user', entityId: req.user.id, ip: req.ip });
    res.redirect('/account?msg=sessions');
  });

  r.post('/account/mfa/disable', async (req, res) => {
    const u = req.user;
    if (core.isSuper(u)) return res.redirect('/account');
    if (!(await verifyPassword(String(req.body.password || ''), u.password_hash))) return res.redirect('/account');
    await pool.query("update users set mfa_enabled = false, mfa_secret = null, mfa_recovery = '[]' where id = $1", [u.id]);
    await core.audit(null, { actor: u, action: 'mfa.disabled', entity: 'user', entityId: u.id, ip: req.ip });
    res.redirect('/account?msg=mfa_off');
  });

  r.post('/account/mfa/recovery', async (req, res) => {
    const u = req.user;
    if (!u.mfa_enabled) return res.redirect('/account');
    const { codes, hashes } = sec.newRecoveryCodes();
    await pool.query('update users set mfa_recovery = $2 where id = $1', [u.id, JSON.stringify(hashes)]);
    await core.audit(null, { actor: u, action: 'mfa.recovery_regenerated', entity: 'user', entityId: u.id, ip: req.ip });
    res.send(layout(req, { title: 'Recovery codes', heading: 'New recovery codes', body: html`<section class="panel narrow">
      <p>Your old codes no longer work. Each new code works once.</p><ul class="codes mono">${codes.map(c => html`<li>${c}</li>`)}</ul>
      <a class="btn primary" href="/account">Done</a></section>` }));
  });
}

module.exports = { mountAccount };
