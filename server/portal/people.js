'use strict';
// People: profile photos, and creating sign-in accounts (from Administration or straight from a workspace's Access tab).
const crypto = require('crypto');
const multer = require('multer');
const sharp = require('sharp');
const { hashPassword } = require('../db');
const { INTERNAL_MEMBER_ROLES, EXTERNAL_MEMBER_ROLES } = require('./core');
const { MIN_PW } = require('./auth');
const { layout, html, raw, csrfField, field, ROLE_LABELS } = require('./views');
const { sniff } = require('./workspaces');

const UUID = /^[0-9a-f-]{36}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_RE = /^[a-z0-9._-]{3,40}$/;
const bad = m => Object.assign(new Error(m), { status: 400 });
const txt = (v, n = 200) => { const s = String(v ?? '').trim().slice(0, n); return s || null; };
const upload = require('./choices').withChoices(multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1, fields: 40 } }));

// 14 characters, no look-alikes (0/O, 1/l/I), always letters + digits + a symbol.
function generatePassword() {
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!#%+=?@'];
  const all = sets.join('');
  const pick = s => s[crypto.randomInt(s.length)];
  const chars = [...sets.map(pick), ...Array.from({ length: 10 }, () => pick(all))];
  for (let i = chars.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
  return chars.join('');
}

// Shared account creation. Returns { id, password } — the password is shown once to the administrator, never stored in clear.
async function createUser(db, core, actor, body, ip, roles) {
  const name = txt(body.name, 120);
  const email = String(body.email || '').trim().toLowerCase();
  const username = String(body.username || '').trim().toLowerCase() || null;
  const kind = body.kind === 'external' ? 'external' : 'internal';
  const phone = txt(body.phone, 40), jobTitle = txt(body.job_title, 80);
  const auto = body.auto_password === '1' || !body.password;
  const password = auto ? generatePassword() : String(body.password || '');
  let role = 'external';
  if (kind === 'internal') { role = String(body.system_role || 'viewer'); if (!roles.includes(role)) throw bad('Choose a staff role.'); }
  if (!name) throw bad('Enter the full name.');
  if (!EMAIL_RE.test(email)) throw bad('Enter a valid email address.');
  if (username && !USERNAME_RE.test(username)) throw bad('The username can use 3–40 lower-case letters, numbers, dot, dash or underscore.');
  if (phone && !/^[+()\d\s-]{6,40}$/.test(phone)) throw bad('Enter the phone number with digits only (and +, spaces or dashes).');
  if (password.length < MIN_PW) throw bad(`The temporary password needs at least ${MIN_PW} characters.`);
  const legacyRole = role === 'super_admin' ? 'admin' : role === 'project_manager' ? 'editor' : role === 'engineer' ? 'site' : 'viewer';
  try {
    const id = (await db.query(
      `insert into users (email, username, name, kind, system_role, role, password_hash, must_change_password, phone, job_title) values ($1,$2,$3,$4,$5,$6,$7,true,$8,$9) returning id`,
      [email, username, name, kind, role, legacyRole, await hashPassword(password), phone, jobTitle])).rows[0].id;
    await core.audit(db, { actor, action: 'user.created', entity: 'user', entityId: id, summary: `Added ${kind === 'external' ? 'external viewer' : ROLE_LABELS[role]} ${name}`, after: { email, username, kind, role, phone, job_title: jobTitle }, ip });
    return { id, password, email, username, name, kind, role };
  } catch (e) {
    if (e.code === '23505') throw bad('A user with that email or username already exists.');
    throw e;
  }
}

function credentialsPage(req, u, { next, nextLabel, emailed }) {
  const base = (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  return layout(req, { title: 'Login created', heading: 'Login created', body: html`<section class="panel narrow">
    <p>Give these details to <b>${u.name}</b> privately (in person, by phone or a private message). The password is shown only now.</p>
    <dl class="details">
      <div><dt>Sign-in address</dt><dd class="mono">${base}/login</dd></div>
      <div><dt>Username</dt><dd class="mono">${u.username || u.email}</dd></div>
      <div><dt>Temporary password</dt><dd class="mono creds">${u.password}</dd></div>
      <div><dt>Account type</dt><dd>${u.kind === 'external' ? 'External viewer (view only)' : ROLE_LABELS[u.role]}</dd></div>
    </dl>
    <p class="muted small">They must choose their own password at first sign-in.${emailed ? ' A welcome email with the sign-in address and username (not the password) was placed in the outbox.' : ''}</p>
    <a class="btn primary" href="${next}">${nextLabel}</a></section>` });
}

const userFormFields = (roles, { kindDefault = 'internal', withKind = true } = {}) => html`
  ${field({ name: 'name', label: 'Full name', required: true, attrs: 'maxlength="120" autocomplete="off"' })}
  ${field({ name: 'email', label: 'Email', type: 'email', required: true, attrs: 'maxlength="200" autocomplete="off"' })}
  ${field({ name: 'username', label: 'Username (optional)', attrs: 'maxlength="40" autocomplete="off" autocapitalize="none"', hint: 'They can also sign in with their email.' })}
  ${field({ name: 'phone', label: 'Mobile number', type: 'tel', attrs: 'maxlength="40" autocomplete="off"' })}
  ${field({ name: 'job_title', label: 'Job title / company', attrs: 'maxlength="80"' })}
  ${withKind ? field({ name: 'kind', label: 'Type', value: kindDefault, options: [['internal', 'SarayDar staff'], ['external', 'External viewer (client, owner, investor, seller, buyer)']] }) : ''}
  ${field({ name: 'system_role', label: 'Staff role', value: 'viewer', options: roles, hint: 'For staff only. External viewers get their access per workspace.' })}
  <label class="field check full"><input type="checkbox" name="auto_password" value="1" checked data-toggle-pw> <span>Create a strong temporary password for me</span></label>
  ${field({ name: 'password', label: `Or type a temporary password (${MIN_PW}+ characters)`, attrs: 'autocomplete="new-password"' })}
  <label class="field check full"><input type="checkbox" name="send_welcome" value="1"> <span>Email them the sign-in address and username (needs email set up; the password is never emailed)</span></label>`;

function mountPeople(r, ctx) {
  const { pool, core, mailer, NotFound, Forbidden } = ctx;
  const staffRoles = async () => (await pool.query("select key, label from roles where kind = 'internal' order by label")).rows.map(x => [x.key, x.label]);
  ctx.userFormFields = userFormFields; ctx.staffRoles = staffRoles;

  async function welcome(req, u, wsName) {
    const base = (ctx.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    await mailer.send({ to: u.email, kind: 'welcome', subject: 'Your SarayDar Management System login',
      text: `Hello ${u.name},\n\nAn account has been created for you on the SarayDar Management System${wsName ? ` with access to ${wsName}` : ''}.\n\nSign in at: ${base}/login\nUsername: ${u.username || u.email}\n\nYour temporary password will be given to you separately. You will be asked to choose your own password at first sign-in.\n\nSarayDar` });
  }

  // ---------- creating logins ----------
  r.post('/admin/users', async (req, res) => {
    if (!core.isSuper(req.user)) throw new NotFound();
    const roles = (await staffRoles()).map(x => x[0]);
    const u = await core.inTx(db => createUser(db, core, req.user, req.body, req.ip, roles));
    if (req.body.send_welcome === '1') await welcome(req, u);
    res.send(credentialsPage(req, u, { next: `/admin/users/${u.id}`, nextLabel: 'Open the user', emailed: req.body.send_welcome === '1' }));
  });

  r.post('/w/:id/access/new', async (req, res) => {
    const a = await core.workspaceAccess(req.user, req.params.id);
    if (!a || !a.internal) throw new NotFound();
    if (!core.isSuper(req.user)) throw new Forbidden('Only the Super Admin can create new logins. Ask them, or add someone who already has a login.');
    const roles = (await staffRoles()).map(x => x[0]);
    const kind = req.body.kind === 'external' ? 'external' : 'internal';
    const wsRole = String(req.body.ws_role || '');
    const ok = kind === 'external' ? wsRole in EXTERNAL_MEMBER_ROLES : wsRole in INTERNAL_MEMBER_ROLES;
    if (!ok) throw bad(kind === 'external' ? 'Choose the viewer type for this workspace.' : 'Choose a staff role for this workspace.');
    const grants = kind === 'external' && req.body.download_files ? { download_files: true } : {};
    const u = await core.inTx(async db => {
      const nu = await createUser(db, core, req.user, req.body, req.ip, roles);
      await db.query('insert into workspace_members (workspace_id, user_id, role, grants, added_by) values ($1,$2,$3,$4,$5)', [a.ws.id, nu.id, wsRole, grants, req.user.id]);
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'access.granted', entity: 'user', entityId: nu.id, summary: `Created login for ${nu.name} and gave ${INTERNAL_MEMBER_ROLES[wsRole] || EXTERNAL_MEMBER_ROLES[wsRole]} access`, after: { role: wsRole, grants }, ip: req.ip });
      return nu;
    });
    if (req.body.send_welcome === '1') await welcome(req, u, a.ws.name);
    res.send(credentialsPage(req, u, { next: `/w/${a.ws.id}/access?msg=added`, nextLabel: 'Back to Access & Invitations', emailed: req.body.send_welcome === '1' }));
  });

  // ---------- photos ----------
  r.get('/users/:uid/photo', async (req, res) => {
    if (!UUID.test(req.params.uid)) throw new NotFound();
    if (core.isExternal(req.user) && req.params.uid !== req.user.id) throw new NotFound();
    const p = (await pool.query('select mime, data from user_photos where user_id = $1', [req.params.uid])).rows[0];
    if (!p) throw new NotFound();
    res.set({ 'Content-Type': p.mime, 'Cache-Control': 'private, max-age=86400' });
    res.end(p.data);
  });

  async function savePhoto(req, userId) {
    if (!core.checkCsrf(req)) throw new Forbidden('Your form expired. Reload the page and try again.');
    const f = req.file; if (!f) throw bad('Choose a photo.');
    const t = sniff(f.buffer, f.originalname);
    if (!t || !t.image) throw bad('The photo must be a JPG, PNG or WebP image.');
    let data;
    try { data = await sharp(f.buffer).rotate().resize(256, 256, { fit: 'cover', position: 'attention' }).webp({ quality: 82 }).toBuffer(); }
    catch (e) { throw bad('That image could not be read.'); }
    await core.inTx(async db => {
      await db.query(`insert into user_photos (user_id, mime, data) values ($1, 'image/webp', $2)
        on conflict (user_id) do update set data = excluded.data, mime = excluded.mime, updated_at = now()`, [userId, data]);
      await core.audit(db, { actor: req.user, action: 'user.photo_set', entity: 'user', entityId: userId, summary: 'Profile photo updated', ip: req.ip });
    });
  }
  async function removePhoto(req, userId) {
    await core.inTx(async db => {
      await db.query('delete from user_photos where user_id = $1', [userId]);
      await core.audit(db, { actor: req.user, action: 'user.photo_removed', entity: 'user', entityId: userId, summary: 'Profile photo removed', ip: req.ip });
    });
  }
  r.post('/account/photo', upload.single('photo'), async (req, res) => { await savePhoto(req, req.user.id); res.redirect('/account?msg=saved'); });
  r.post('/account/photo/remove', async (req, res) => { await removePhoto(req, req.user.id); res.redirect('/account?msg=saved'); });
  r.post('/admin/users/:uid/photo', upload.single('photo'), async (req, res) => {
    if (!core.isSuper(req.user) || !UUID.test(req.params.uid)) throw new NotFound();
    if (!(await pool.query('select 1 from users where id = $1', [req.params.uid])).rowCount) throw new NotFound();
    if (req.body.remove === '1') { if (!core.checkCsrf(req)) throw new Forbidden(); await removePhoto(req, req.params.uid); }
    else await savePhoto(req, req.params.uid);
    res.redirect(`/admin/users/${req.params.uid}?msg=user_saved`);
  });
}

// Photo upload form used on Account and on the admin user page.
const photoForm = (req, action, u, removeAction) => html`<div class="photo-row">
  ${u.photo_v ? html`<img class="avatar big-avatar" src="/users/${u.id}/photo?v=${u.photo_v}" alt="Profile photo of ${u.name || u.email}">` : html`<span class="avatar big-avatar" aria-hidden="true">${(u.name || u.email || '?').charAt(0).toUpperCase()}</span>`}
  <form method="post" action="${action}" enctype="multipart/form-data" class="stack"><input type="hidden" name="_csrf" value="${req.csrfToken}">
    <label class="field" for="f-photo-${u.id}"><span>Profile photo</span><input id="f-photo-${u.id}" type="file" name="photo" accept="image/jpeg,image/png,image/webp" required><small>JPG, PNG or WebP, up to 8 MB. Cropped to a square.</small></label>
    <div class="actions"><button class="btn" type="submit">Upload photo</button></div></form>
  ${u.photo_v ? html`<form method="post" action="${removeAction}" ${removeAction.includes('/admin/') ? raw('enctype="multipart/form-data"') : ''}><input type="hidden" name="_csrf" value="${req.csrfToken}">${removeAction.includes('/admin/') ? html`<input type="hidden" name="remove" value="1">` : ''}<button class="link" type="submit">Remove photo</button></form>` : ''}
</div>`;

module.exports = { mountPeople, createUser, generatePassword, photoForm, userFormFields };
