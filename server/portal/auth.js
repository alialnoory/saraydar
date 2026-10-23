'use strict';
const QRCode = require('qrcode');
const rateLimit = require('express-rate-limit');
const { hashPassword, verifyPassword } = require('../db');
const sec = require('../lib/security');
const { layout, html, raw, field, csrfField } = require('./views');

const MIN_PW = 10;
const DUMMY = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(64).toString('base64');
const PRE_CSRF = 'sd_pre';

function safeNext(n) { return typeof n === 'string' && /^\/(?!\/)[\w\-./?=&%]*$/.test(n) && !n.startsWith('/login') ? n : null; }
const homeFor = u => u.kind === 'external' ? '/my' : '/';

function mountAuth(r, { pool, core, mailer, secret, env }) {
  const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false,
    handler: (req, res) => res.status(429).send(layout(req, { title: 'Too many attempts', bare: true, body: html`<div class="auth"><section class="panel"><h2>Too many attempts</h2><p>Wait a few minutes and try again.</p></section></div>` })) });

  // anonymous forms use a double-submit token
  function preToken(req, res) {
    let t = req.cookies[PRE_CSRF];
    if (!t || t.length > 100) { t = sec.randomToken(18); res.cookie(PRE_CSRF, t, { httpOnly: true, secure: req.secure, sameSite: 'strict', path: '/' }); }
    req.csrfToken = t;
    return t;
  }
  function checkPre(req) {
    const t = req.cookies[PRE_CSRF];
    return t && typeof req.body._csrf === 'string' && t === req.body._csrf;
  }
  const box = (req, title, body, sub = '') => layout(req, { title, bare: true, body: html`<div class="auth"><section class="panel">
      <h2>${title}</h2>${sub ? html`<p class="muted">${sub}</p>` : ''}${body}</section></div>` });

  // ---------- sign in ----------
  const loginPage = (req, err = '', ident = '') => box(req, 'Sign in', html`
    <form method="post" action="/login" class="stack" novalidate>${csrfField(req)}
      <input type="hidden" name="next" value="${req.query.next || req.body?.next || ''}">
      ${field({ name: 'identifier', label: 'Username or email', value: ident, required: true, attrs: 'autocomplete="username" autocapitalize="none"' })}
      ${field({ name: 'password', label: 'Password', type: 'password', required: true, attrs: 'autocomplete="current-password"' })}
      ${err ? html`<p class="err" role="alert">${err}</p>` : ''}
      <button class="btn primary" type="submit">Sign in</button>
      <a href="/forgot">Forgot your password?</a>
    </form>`, 'SarayDar Management System');

  r.get('/login', (req, res) => {
    if (req.user && req.session.mfa_ok !== false) return res.redirect(homeFor(req.user));
    preToken(req, res);
    res.send(loginPage(req));
  });

  r.post('/login', limiter, async (req, res) => {
    preToken(req, res);
    if (!checkPre(req)) return res.status(400).send(loginPage(req, 'Your form expired. Please try again.'));
    const ident = String(req.body.identifier || '').trim().toLowerCase().slice(0, 200);
    const password = String(req.body.password || '');
    const generic = 'Username or password is incorrect.';
    if (!ident || !password) return res.status(400).send(loginPage(req, 'Enter your username or email and password.', ident));
    const u = (await pool.query('select * from users where lower(email) = $1 or lower(username) = $1 limit 1', [ident])).rows[0];
    if (u && u.locked_until && new Date(u.locked_until) > new Date()) {
      await verifyPassword(password, DUMMY);
      return res.status(401).send(loginPage(req, 'Too many failed attempts. Try again in 15 minutes or ask your administrator.', ident));
    }
    const ok = await verifyPassword(password, u ? u.password_hash : DUMMY);
    if (!u || !ok || !u.active) {
      if (u) {
        await pool.query(`update users set failed_logins = failed_logins + 1,
          locked_until = case when failed_logins + 1 >= 10 then now() + interval '15 minutes' else locked_until end where id = $1`, [u.id]);
        await core.audit(null, { actor: u, action: 'login.failed', entity: 'user', entityId: u.id, ip: req.ip });
      }
      return res.status(401).send(loginPage(req, generic, ident));
    }
    await pool.query('update users set failed_logins = 0, locked_until = null, last_login_at = now() where id = $1', [u.id]);
    await pool.query('delete from sessions where expires_at < now()');
    await core.createSession(res, req, u.id);
    await core.audit(null, { actor: u, action: 'login', entity: 'user', entityId: u.id, ip: req.ip });
    const next = safeNext(req.body.next);
    if (u.mfa_enabled) return res.redirect('/mfa' + (next ? `?next=${encodeURIComponent(next)}` : ''));
    if (core.isSuper(u)) return res.redirect('/mfa/setup');
    if (u.must_change_password) return res.redirect('/account/password?forced=1');
    res.redirect(next || homeFor(u));
  });

  r.post('/logout', async (req, res) => {
    if (req.user) await core.audit(null, { actor: req.user, action: 'logout', entity: 'user', entityId: req.user.id, ip: req.ip });
    await core.endSession(req, res);
    res.redirect('/login?msg=signed_out');
  });

  // ---------- two-step verification ----------
  r.get('/mfa', (req, res) => {
    if (!req.user) return res.redirect('/login');
    if (!req.user.mfa_enabled) return res.redirect('/mfa/setup');
    res.send(box(req, 'Two-step verification', html`
      <form method="post" action="/mfa" class="stack">${csrfField(req)}<input type="hidden" name="next" value="${req.query.next || ''}">
        ${field({ name: 'code', label: 'Code from your authenticator app, or a recovery code', required: true, attrs: 'autocomplete="one-time-code" inputmode="text" autofocus' })}
        ${req.query.err ? html`<p class="err" role="alert">That code is not valid. Try the current code.</p>` : ''}
        <button class="btn primary" type="submit">Verify</button></form>
      <form method="post" action="/logout">${csrfField(req)}<button class="link" type="submit">Use a different account</button></form>`));
  });

  r.post('/mfa', limiter, async (req, res) => {
    const u = req.user;
    if (!u || !u.mfa_enabled) return res.redirect('/login');
    const code = String(req.body.code || '').trim().toUpperCase();
    let ok = false;
    try { ok = sec.verifyTotp(sec.decrypt(secret, u.mfa_secret), code); } catch (e) { ok = false; }
    if (!ok && /^[0-9A-F]{5}-[0-9A-F]{5}$/.test(code)) {
      const h = sec.sha256(code);
      const list = u.mfa_recovery || [];
      if (list.includes(h)) {
        ok = true;
        await pool.query('update users set mfa_recovery = $2 where id = $1', [u.id, JSON.stringify(list.filter(x => x !== h))]);
        await core.audit(null, { actor: u, action: 'mfa.recovery_code_used', entity: 'user', entityId: u.id, ip: req.ip });
      }
    }
    if (!ok) {
      await core.audit(null, { actor: u, action: 'mfa.failed', entity: 'user', entityId: u.id, ip: req.ip });
      return res.redirect('/mfa?err=1' + (req.body.next ? `&next=${encodeURIComponent(req.body.next)}` : ''));
    }
    await pool.query('update sessions set mfa_ok = true where id = $1', [req.session.id]);
    if (u.must_change_password) return res.redirect('/account/password?forced=1');
    res.redirect(safeNext(req.body.next) || homeFor(u));
  });

  r.get('/mfa/setup', async (req, res) => {
    const u = req.user;
    if (!u) return res.redirect('/login');
    if (u.mfa_enabled && !req.session.mfa_ok) return res.redirect('/mfa');
    if (u.mfa_enabled) return res.redirect('/account');
    let s = null;
    try { if (u.mfa_secret) s = sec.decrypt(secret, u.mfa_secret); } catch (e) { s = null; }
    if (!s) {
      s = sec.newTotpSecret();
      await pool.query('update users set mfa_secret = $2 where id = $1', [u.id, sec.encrypt(secret, s)]);
    }
    const svg = await QRCode.toString(sec.otpauthUrl(s, u.email || u.username), { type: 'svg', margin: 1, width: 200 });
    const forced = core.isSuper(u);
    res.send(box(req, 'Set up two-step verification', html`
      ${forced ? html`<p class="notice">Super Admin accounts must use two-step verification.</p>` : ''}
      <ol class="steps"><li>Open an authenticator app (Microsoft Authenticator, Google Authenticator or similar).</li>
        <li>Scan this code, or enter the key below.</li><li>Type the 6-digit code it shows.</li></ol>
      <div class="qr">${raw(svg)}</div>
      <p class="mono key">${s.replace(/(.{4})/g, '$1 ').trim()}</p>
      <form method="post" action="/mfa/setup" class="stack">${csrfField(req)}
        ${field({ name: 'code', label: '6-digit code', required: true, attrs: 'autocomplete="one-time-code" inputmode="numeric" pattern="[0-9 ]*"' })}
        ${req.query.err ? html`<p class="err" role="alert">That code did not match. Check the time on your phone and try again.</p>` : ''}
        <button class="btn primary" type="submit">Turn on</button></form>
      ${!forced ? html`<a href="/account">Not now</a>` : html`<form method="post" action="/logout">${csrfField(req)}<button class="link" type="submit">Sign out</button></form>`}`));
  });

  r.post('/mfa/setup', limiter, async (req, res) => {
    const u = req.user;
    if (!u) return res.redirect('/login');
    if (u.mfa_enabled) return res.redirect('/account');
    let s; try { s = sec.decrypt(secret, u.mfa_secret); } catch (e) { return res.redirect('/mfa/setup'); }
    if (!sec.verifyTotp(s, req.body.code)) return res.redirect('/mfa/setup?err=1');
    const { codes, hashes } = sec.newRecoveryCodes();
    await pool.query('update users set mfa_enabled = true, mfa_recovery = $2 where id = $1', [u.id, JSON.stringify(hashes)]);
    await pool.query('update sessions set mfa_ok = true where id = $1', [req.session.id]);
    await core.audit(null, { actor: u, action: 'mfa.enabled', entity: 'user', entityId: u.id, ip: req.ip });
    res.send(box(req, 'Save your recovery codes', html`
      <p>Each code works once if you lose your phone. Store them somewhere safe. They will not be shown again.</p>
      <ul class="codes mono">${codes.map(c => html`<li>${c}</li>`)}</ul>
      <a class="btn primary" href="${u.must_change_password ? '/account/password?forced=1' : homeFor(u)}">I have saved them</a>`));
  });

  // ---------- password recovery ----------
  r.get('/forgot', (req, res) => {
    preToken(req, res);
    res.send(box(req, 'Reset your password', html`
      <form method="post" action="/forgot" class="stack">${csrfField(req)}
        ${field({ name: 'identifier', label: 'Username or email', required: true, attrs: 'autocomplete="username"' })}
        <button class="btn primary" type="submit">Send reset link</button><a href="/login">Back to sign in</a></form>`,
      'We will email a link that works once and expires in 30 minutes.'));
  });

  r.post('/forgot', limiter, async (req, res) => {
    preToken(req, res);
    if (!checkPre(req)) return res.redirect('/forgot');
    const ident = String(req.body.identifier || '').trim().toLowerCase().slice(0, 200);
    const u = ident && (await pool.query('select * from users where (lower(email) = $1 or lower(username) = $1) and active', [ident])).rows[0];
    if (u && u.email) {
      const token = sec.randomToken(32);
      await pool.query("insert into password_resets (token_hash, user_id, expires_at) values ($1,$2, now() + interval '30 minutes')", [sec.sha256(token), u.id]);
      const base = (env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
      await mailer.send({ to: u.email, kind: 'password_reset', sensitive: true, subject: 'Reset your SarayDar password',
        text: `A password reset was requested for your SarayDar Management System account.\n\nOpen this link within 30 minutes to choose a new password:\n${base}/reset/${token}\n\nIf you did not ask for this, ignore this email.` });
      await core.audit(null, { actor: u, action: 'password.reset_requested', entity: 'user', entityId: u.id, ip: req.ip });
    }
    res.redirect('/login?msg=reset_sent');
  });

  async function validReset(token) {
    if (typeof token !== 'string' || token.length > 100) return null;
    return (await pool.query('select * from password_resets where token_hash = $1 and used_at is null and expires_at > now()', [sec.sha256(token)])).rows[0] || null;
  }

  r.get('/reset/:token', async (req, res) => {
    preToken(req, res);
    const ok = await validReset(req.params.token);
    if (!ok) return res.status(400).send(box(req, 'Link expired', html`<p>This reset link has expired or was already used.</p><a class="btn" href="/forgot">Request a new link</a>`));
    res.send(box(req, 'Choose a new password', html`
      <form method="post" action="${'/reset/' + req.params.token}" class="stack">${csrfField(req)}
        ${field({ name: 'password', label: `New password (at least ${MIN_PW} characters)`, type: 'password', required: true, attrs: 'autocomplete="new-password"' })}
        ${field({ name: 'confirm', label: 'Confirm new password', type: 'password', required: true, attrs: 'autocomplete="new-password"' })}
        ${req.query.err ? html`<p class="err" role="alert">${req.query.err === 'match' ? 'The passwords do not match.' : `Use at least ${MIN_PW} characters.`}</p>` : ''}
        <button class="btn primary" type="submit">Save password</button></form>`));
  });

  r.post('/reset/:token', limiter, async (req, res) => {
    preToken(req, res);
    if (!checkPre(req)) return res.redirect(`/reset/${encodeURIComponent(req.params.token)}`);
    const pw = String(req.body.password || ''), pw2 = String(req.body.confirm || '');
    if (pw.length < MIN_PW) return res.redirect(`/reset/${encodeURIComponent(req.params.token)}?err=short`);
    if (pw !== pw2) return res.redirect(`/reset/${encodeURIComponent(req.params.token)}?err=match`);
    const hash = await hashPassword(pw);
    const done = await core.inTx(async c => {
      const row = (await c.query('update password_resets set used_at = now() where token_hash = $1 and used_at is null and expires_at > now() returning user_id', [sec.sha256(req.params.token)])).rows[0];
      if (!row) return false;
      await c.query('update users set password_hash = $2, token_version = token_version + 1, failed_logins = 0, locked_until = null, must_change_password = false where id = $1', [row.user_id, hash]);
      await core.endAllSessions(c, row.user_id);
      await core.audit(c, { actor: { id: row.user_id, name: 'password reset' }, action: 'password.reset', entity: 'user', entityId: row.user_id, ip: req.ip });
      return true;
    });
    if (!done) return res.redirect(`/reset/${encodeURIComponent(req.params.token)}`);
    res.redirect('/login?msg=reset_done');
  });
}

module.exports = { mountAuth, MIN_PW, safeNext, homeFor };
