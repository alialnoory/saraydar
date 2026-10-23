'use strict';
// External viewer invitations (spec 5.6). Staff create the workspace first, then an authorised manager invites
// one named person to that one workspace. Links are single use, expire, and are never reported as delivered
// unless the email provider accepted the message.
const rateLimit = require('express-rate-limit');
const { hashPassword, verifyPassword } = require('../db');
const sec = require('../lib/security');
const { SECTIONS, KIND_LABEL, EXTERNAL_MEMBER_ROLES } = require('./core');
const { layout, html, raw, field, csrfField, pill, fmtDate, fmtDateTime } = require('./views');
const { MIN_PW, preToken, checkPre } = require('./auth');

const INVITE_DAYS = 7;
const EMAIL_RE = /^[^\s@]{1,80}@[^\s@]{1,120}\.[a-z]{2,24}$/i;
const UUID = /^[0-9a-f-]{36}$/i;
const VIEWER_ROLES = ['client_viewer', 'owner_viewer', 'investor_viewer', 'seller_viewer', 'buyer_viewer'];
// which viewer roles fit which kind of workspace
const ROLES_FOR = { project: ['client_viewer', 'investor_viewer'], client_project: ['client_viewer'], property: ['owner_viewer'], listing: ['seller_viewer'], request: ['buyer_viewer'] };
const GRANTS = {
  financials: 'Their own statement, invoices and receipts',
  offers: 'Offer and deal progress (no other buyers’ details)',
  download_files: 'Download attachments such as Word, Excel or DWG files',
  export: 'Save portal pages as PDF or Excel'
};
const grantsFor = kind => Object.keys(GRANTS).filter(k => k !== 'offers' || ['listing', 'request'].includes(kind));
function financialLabel(role) {
  return { investor_viewer: 'Their own contribution statement', owner_viewer: 'Owner statement', client_viewer: 'Fee invoices, receipts and statement' }[role] || 'Their own fee invoices and receipts';
}
function grantSummary(g) {
  g = g || {};
  const on = Object.keys(GRANTS).filter(k => g[k]).map(k => ({ financials: 'statements', offers: 'offers & deal', download_files: 'downloads', export: 'PDF/Excel' }[k]));
  return on.length ? `Can also see: ${on.join(', ')}` : 'Published information only';
}
const bad = m => Object.assign(new Error(m), { status: 400 });
const txt = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

function mountInvitations(r, ctx) {
  const { pool, core, mailer, env, NotFound, Forbidden } = ctx;
  ctx.grantSummary = grantSummary;
  const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false });
  const baseUrl = req => (env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');

  async function manager(req) {
    const a = await core.workspaceAccess(req.user, req.params.id);
    if (!a || !a.internal) throw new NotFound();
    if (!core.canManageAccess(req.user, a)) throw new Forbidden('Only the workspace manager or a Super Admin can manage access.');
    return a;
  }
  const grantsFrom = (body, kind) => Object.fromEntries(grantsFor(kind).filter(k => body[k] === '1').map(k => [k, true]));

  // ---------- panels on the Access & Invitations screen ----------
  ctx.accessExtras = async (req, a, manage, members) => {
    const w = a.ws;
    const invites = (await pool.query(
      `select i.*, o.status as delivery, coalesce(nullif(u.name,''), u.email) as by
         from invitations i left join outbox_messages o on o.id = i.outbox_id left join users u on u.id = i.created_by
        where i.workspace_id = $1 order by i.created_at desc limit 50`, [w.id])).rows;
    const parties = manage ? (await pool.query("select id, name, email from parties where archived_at is null and merged_into is null order by name limit 500")).rows : [];
    const roles = ROLES_FOR[w.kind] || VIEWER_ROLES;
    const state = i => i.status === 'pending' && new Date(i.expires_at) < new Date() ? 'expired' : i.status;
    const TONE = { pending: 'warn', accepted: 'ok', expired: 'muted', revoked: 'muted', superseded: 'muted' };
    const LABEL = { pending: 'Pending', accepted: 'Accepted', expired: 'Expired', revoked: 'Revoked', superseded: 'Replaced by a newer link' };
    const delivery = i => i.status === 'superseded' ? '' : !i.outbox_id ? 'Not emailed' : { sent: 'Emailed (accepted by the mail server)', failed: 'Email failed', unconfigured: 'Not emailed — email not configured', queued: 'Queued' }[i.delivery] || i.delivery;
    const externals = (members || []).filter(m => m.kind === 'external' && !m.revoked_at);
    return html`
      <section class="panel"><h2 class="h">External invitations</h2>
        ${invites.length ? html`<div class="table-wrap"><table><thead><tr><th>Invited</th><th>Role</th><th>Status</th><th>Delivery</th><th>Sent</th><th></th></tr></thead><tbody>
          ${invites.map(i => { const st = state(i); return html`<tr class="${['revoked', 'superseded', 'expired'].includes(st) ? 'dim' : ''}">
            <td><b>${i.name}</b><div class="muted small">${i.email}</div></td>
            <td>${EXTERNAL_MEMBER_ROLES[i.role]}<div class="muted small">${grantSummary(i.grants)}</div></td>
            <td>${pill(LABEL[st], TONE[st])}<div class="muted small">${st === 'pending' ? `Expires ${fmtDateTime(i.expires_at)}` : st === 'accepted' ? `Accepted ${fmtDateTime(i.accepted_at)}` : st === 'revoked' ? `Revoked ${fmtDateTime(i.revoked_at)}` : ''}</div></td>
            <td class="small">${delivery(i)}</td>
            <td class="small">${fmtDate(i.created_at)}${i.by ? ` by ${i.by}` : ''}</td>
            <td class="nowrap">${manage && ['pending', 'expired'].includes(st) ? html`
              <form method="post" action="/w/${w.id}/invitations/${i.id}/resend" class="inline">${csrfField(req)}<button class="btn small" type="submit">Resend</button></form>
              ${st === 'pending' ? html`<form method="post" action="/w/${w.id}/invitations/${i.id}/revoke" class="inline">${csrfField(req)}<button class="btn small" type="submit">Revoke</button></form>` : ''}` : ''}</td></tr>`; })}
          </tbody></table></div>` : html`<p class="muted">No invitations yet. Nothing is sent automatically when a workspace is created.</p>`}
        <p class="muted small">Each link works once and expires after ${INVITE_DAYS} days. Resending creates a new link and the old one stops working.</p>
      </section>
      ${manage && externals.length ? html`<section class="panel"><h2 class="h">What external viewers can see</h2>
        <p class="muted small">External viewers are always view-only. They see only items marked “Published” in this ${SECTIONS[w.section].noun}. Tick anything extra they may see.</p>
        ${externals.map(m => html`<form method="post" action="/w/${w.id}/access/grants" class="grant-row">${csrfField(req)}<input type="hidden" name="user" value="${m.user_id}">
          <div class="grow"><b>${m.name || m.email}</b> <span class="muted small">${EXTERNAL_MEMBER_ROLES[m.role]}</span></div>
          ${grantsFor(w.kind).map(k => html`<label class="check small"><input type="checkbox" name="${k}" value="1" ${m.grants && m.grants[k] ? raw('checked') : ''}> ${k === 'financials' ? financialLabel(m.role) : GRANTS[k]}</label>`)}
          <button class="btn small" type="submit">Save</button>
          <a class="btn small" href="/p/${w.id}?preview=${m.role}&${grantsFor(w.kind).filter(k => m.grants && m.grants[k]).map(k => `g_${k}=1`).join('&')}${m.grants && m.grants.party_id ? `&party=${m.grants.party_id}` : ''}">Preview</a></form>`)}
      </section>` : ''}
      ${manage ? html`<section class="panel"><h2 class="h">Invite an external viewer</h2>
        <form method="post" action="/w/${w.id}/invitations" class="form-grid">${csrfField(req)}
          ${field({ name: 'party', label: 'Contact (optional)', options: [['', 'Not linked to a contact'], ...parties.map(p => [p.id, `${p.name}${p.email ? ` — ${p.email}` : ''}`])], hint: 'Required for an investor so they see only their own statement.' })}
          ${field({ name: 'role', label: 'Viewer role', required: true, options: roles.map(x => [x, EXTERNAL_MEMBER_ROLES[x]]) })}
          ${field({ name: 'name', label: 'Full name', attrs: 'maxlength="120"', hint: 'Taken from the contact when left empty.' })}
          ${field({ name: 'email', label: 'Email address', type: 'email', attrs: 'maxlength="200" autocapitalize="none"', hint: 'Taken from the contact when left empty.' })}
          <fieldset class="full"><legend>They may also see</legend>
            ${grantsFor(w.kind).map(k => html`<label class="check"><input type="checkbox" name="${k}" value="1"> ${k === 'financials' ? 'Their own statement, invoices and receipts (investors: only their own contributions)' : GRANTS[k]}</label>`)}</fieldset>
          ${field({ name: 'recipient_checked', label: 'How did you confirm this is the right person and address?', required: true, full: true, attrs: 'maxlength="300" placeholder="e.g. Confirmed by phone with Mr Ahmed on 24 Oct; matches the signed agreement"' })}
          <label class="field full check"><input type="checkbox" name="confirm" value="1" required> <span>I confirmed the email address belongs to the intended person, and they should see this ${SECTIONS[w.section].noun} only.</span></label>
          <div class="full actions"><button class="btn primary" type="submit">Create invitation</button>
            <a class="btn" href="/p/${w.id}?preview=${roles[0]}">Preview the external view</a></div>
          <p class="muted small full">The invitation gives access to this ${SECTIONS[w.section].noun} only — not to other projects or properties of the same client. ${mailer.configured ? 'It is emailed from the configured mailbox.' : 'Email is not configured, so the one-time link will be shown to you once to pass on yourself.'}</p>
        </form></section>` : ''}`;
  };

  async function createInvite(db, req, a, { name, email, partyId, role, grants, checked }) {
    const token = sec.randomToken(32);
    const inv = (await db.query(
      `insert into invitations (workspace_id, email, name, party_id, role, grants, token_hash, expires_at, recipient_checked, created_by)
       values ($1,$2,$3,$4,$5,$6,$7, now() + interval '${INVITE_DAYS} days', $8, $9) returning *`,
      [a.ws.id, email, name, partyId, role, grants, sec.sha256(token), checked, req.user.id])).rows[0];
    return { inv, token };
  }
  async function deliver(req, a, inv, token) {
    const link = `${baseUrl(req)}/invite/${token}`;
    const out = await mailer.send({ to: inv.email, kind: 'invitation', sensitive: true, workspaceId: a.ws.id, refKind: 'invitation', refId: inv.id,
      subject: `Invitation to view ${a.ws.name} — SarayDar`,
      text: `Dear ${inv.name},\n\nSarayDar Real Estate has invited you to view “${a.ws.name}” in the SarayDar Management System. Your access is view-only.\n\nOpen this link within ${INVITE_DAYS} days to activate your access:\n${link}\n\nThe link works once. If you were not expecting this invitation, please ignore this email.\n\nSarayDar Real Estate` });
    await pool.query('update invitations set outbox_id = $2 where id = $1', [inv.id, out.id]);
    return { link, status: out.status };
  }
  function resultPage(req, a, inv, { link, status }) {
    const sent = status === 'sent';
    return layout(req, { title: 'Invitation created', heading: 'Invitation created', crumbs: [['Home', '/'], [a.ws.name, `/w/${a.ws.id}`], ['Access & Invitations', `/w/${a.ws.id}/access`], ['Invitation']], body: html`
      <section class="panel narrow">
        <p><b>${inv.name}</b> (${inv.email}) — ${EXTERNAL_MEMBER_ROLES[inv.role]} for <b>${a.ws.name}</b>.</p>
        ${sent ? html`<div class="notice ok">The invitation email was accepted by the mail server. That confirms sending, not that the person has opened it.</div>`
          : html`<div class="notice warn"><b>Not emailed.</b> ${status === 'failed' ? 'The mail server refused the message.' : 'Email delivery is not configured yet.'} Copy this one-time link and send it to ${inv.name} yourself through a channel you trust. It is shown only now.</div>
            <label class="field full"><span>One-time invitation link (expires ${fmtDateTime(inv.expires_at)})</span><input class="mono" readonly value="${link}" onclick="this.select()"></label>`}
        <div class="actions"><a class="btn primary" href="/w/${a.ws.id}/access">Back to Access & Invitations</a></div>
      </section>` });
  }

  r.post('/w/:id/invitations', async (req, res) => {
    const a = await manager(req);
    const w = a.ws;
    const role = String(req.body.role || '');
    if (!(ROLES_FOR[w.kind] || VIEWER_ROLES).includes(role)) throw bad('Choose a viewer role that fits this workspace.');
    const partyId = UUID.test(String(req.body.party || '')) ? req.body.party : null;
    const party = partyId ? (await pool.query('select id, name, email from parties where id = $1 and archived_at is null', [partyId])).rows[0] : null;
    if (partyId && !party) throw bad('That contact was not found.');
    const name = txt(req.body.name, 120) || (party && party.name) || '';
    const email = (txt(req.body.email, 200) || (party && party.email) || '').toLowerCase();
    const checked = txt(req.body.recipient_checked, 300);
    if (!name) throw bad('Enter the person’s full name.');
    if (!EMAIL_RE.test(email)) throw bad('Enter a valid email address (the contact has none on file).');
    if (checked.length < 5) throw bad('Say how you confirmed this is the intended person and address.');
    if (req.body.confirm !== '1') throw bad('Tick the box to confirm the recipient.');
    if (role === 'investor_viewer' && !party) throw bad('Link an investor invitation to the investor’s contact record.');
    const existing = (await pool.query('select id, kind, active from users where lower(email) = $1', [email])).rows[0];
    if (existing && existing.kind !== 'external') throw bad('That address belongs to a SarayDar staff login. Add staff with “Add a person” instead.');
    if (existing && (await pool.query('select 1 from workspace_members where workspace_id = $1 and user_id = $2 and revoked_at is null', [w.id, existing.id])).rowCount) throw bad('That person already has access to this workspace.');
    const grants = grantsFrom(req.body, w.kind);
    if (party) grants.party_id = party.id;
    const { inv, token } = await core.inTx(async db => {
      await db.query("update invitations set status = 'superseded' where workspace_id = $1 and lower(email) = $2 and status = 'pending'", [w.id, email]);
      const out = await createInvite(db, req, a, { name, email, partyId: party && party.id, role, grants, checked });
      await core.audit(db, { actor: req.user, workspaceId: w.id, action: 'invitation.created', entity: 'invitation', entityId: out.inv.id, summary: `Invited ${name} (${email}) as ${EXTERNAL_MEMBER_ROLES[role]}`, after: { email, role, grants, recipient_checked: checked }, ip: req.ip });
      return out;
    });
    const d = await deliver(req, a, inv, token);
    await core.audit(null, { actor: req.user, workspaceId: w.id, action: `invitation.${d.status === 'sent' ? 'emailed' : 'not_emailed'}`, entity: 'invitation', entityId: inv.id, summary: d.status === 'sent' ? `Invitation emailed to ${email}` : `Invitation for ${email} not emailed (${d.status}); link shown to staff`, ip: req.ip });
    res.send(resultPage(req, a, inv, d));
  });

  r.post('/w/:id/invitations/:iid/resend', async (req, res) => {
    const a = await manager(req);
    if (!UUID.test(req.params.iid)) throw new NotFound();
    const { inv, token } = await core.inTx(async db => {
      const old = (await db.query("update invitations set status = 'superseded' where id = $1 and workspace_id = $2 and status = 'pending' returning *", [req.params.iid, a.ws.id])).rows[0];
      if (!old) throw bad('Only a pending or expired invitation can be resent.');
      const out = await createInvite(db, req, a, { name: old.name, email: old.email, partyId: old.party_id, role: old.role, grants: old.grants, checked: old.recipient_checked });
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'invitation.resent', entity: 'invitation', entityId: out.inv.id, summary: `New invitation link for ${old.email}; the previous link no longer works`, before: { invitation: old.id }, ip: req.ip });
      return out;
    });
    res.send(resultPage(req, a, inv, await deliver(req, a, inv, token)));
  });

  r.post('/w/:id/invitations/:iid/revoke', async (req, res) => {
    const a = await manager(req);
    if (!UUID.test(req.params.iid)) throw new NotFound();
    await core.inTx(async db => {
      const i = (await db.query("update invitations set status = 'revoked', revoked_at = now(), revoked_by = $3 where id = $1 and workspace_id = $2 and status = 'pending' returning email", [req.params.iid, a.ws.id, req.user.id])).rows[0];
      if (i) await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'invitation.revoked', entity: 'invitation', entityId: req.params.iid, summary: `Revoked the invitation for ${i.email}`, ip: req.ip });
    });
    res.redirect(`/w/${a.ws.id}/access?msg=revoked`);
  });

  r.post('/w/:id/access/grants', async (req, res) => {
    const a = await manager(req);
    const uid = String(req.body.user || '');
    if (!UUID.test(uid)) throw new NotFound();
    await core.inTx(async db => {
      const m = (await db.query("select m.grants from workspace_members m join users u on u.id = m.user_id where m.workspace_id = $1 and m.user_id = $2 and m.revoked_at is null and u.kind = 'external' for update", [a.ws.id, uid])).rows[0];
      if (!m) throw new NotFound();
      const next = grantsFrom(req.body, a.ws.kind);
      if (m.grants && m.grants.party_id) next.party_id = m.grants.party_id;
      await db.query('update workspace_members set grants = $3 where workspace_id = $1 and user_id = $2', [a.ws.id, uid, next]);
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'access.grants_changed', entity: 'user', entityId: uid, summary: `Changed what an external viewer can see: ${grantSummary(next)}`, before: m.grants, after: next, ip: req.ip });
    });
    res.redirect(`/w/${a.ws.id}/access?msg=saved`);
  });

  // ---------- accepting an invitation (no session needed) ----------
  async function lookup(token) {
    if (typeof token !== 'string' || token.length > 100) return null;
    return (await pool.query(
      `select i.*, w.name as ws_name, w.kind as ws_kind, w.ref as ws_ref, (i.status = 'pending' and i.expires_at > now()) as usable
         from invitations i join workspaces w on w.id = i.workspace_id where i.token_hash = $1`, [sec.sha256(token)])).rows[0] || null;
  }
  const box = (req, title, body) => layout(req, { title, bare: true, body: html`<div class="auth"><section class="panel"><h2>${title}</h2>${body}</section></div>` });
  function invitePage(req, i, user, err = '') {
    const action = `/invite/${encodeURIComponent(req.params.token)}`;
    return box(req, 'Your SarayDar invitation', html`
      <p>You have been invited to view <b>${i.ws_name}</b> (${KIND_LABEL[i.ws_kind]}) as ${EXTERNAL_MEMBER_ROLES[i.role]}. Access is view-only.</p>
      <p class="muted small">Invitation for ${i.email}</p>
      ${user ? html`<form method="post" action="${action}" class="stack">${csrfField(req)}
          <p>You already have a SarayDar login. Enter your password to add this ${KIND_LABEL[i.ws_kind].toLowerCase()} to it.</p>
          ${field({ name: 'password', label: 'Password', type: 'password', required: true, attrs: 'autocomplete="current-password"' })}
          ${err ? html`<p class="err" role="alert">${err}</p>` : ''}
          <button class="btn primary" type="submit">Accept invitation</button><a href="/forgot">Forgot your password?</a></form>`
        : html`<form method="post" action="${action}" class="stack">${csrfField(req)}
          ${field({ name: 'name', label: 'Your full name', value: i.name, required: true, attrs: 'maxlength="120" autocomplete="name"' })}
          ${field({ name: 'password', label: `Choose a password (at least ${MIN_PW} characters)`, type: 'password', required: true, attrs: 'autocomplete="new-password"' })}
          ${field({ name: 'confirm', label: 'Confirm password', type: 'password', required: true, attrs: 'autocomplete="new-password"' })}
          ${err ? html`<p class="err" role="alert">${err}</p>` : ''}
          <button class="btn primary" type="submit">Activate my access</button></form>`}`);
  }
  function unusable(req, res, i) {
    const why = !i ? 'This invitation link is not valid.'
      : i.status === 'accepted' ? 'This invitation has already been used. Sign in with the password you chose.'
      : i.status === 'superseded' ? 'A newer invitation was sent to you. Please use the most recent email or link.'
      : i.status === 'revoked' ? 'This invitation was withdrawn.' : 'This invitation has expired.';
    return res.status(400).send(box(req, 'Invitation unavailable', html`<p>${why}</p><p class="muted small">Contact SarayDar Real Estate if you need a new invitation.</p><a class="btn" href="/login">Go to sign in</a>`));
  }

  r.get('/invite/:token', limiter, async (req, res) => {
    preToken(req, res);
    const i = await lookup(req.params.token);
    if (!i || !i.usable) return unusable(req, res, i);
    const u = (await pool.query('select id, kind, active from users where lower(email) = lower($1)', [i.email])).rows[0];
    if (u && (u.kind !== 'external' || !u.active)) return res.status(400).send(box(req, 'Invitation unavailable', html`<p>This invitation cannot be used with the existing account for this address. Contact SarayDar Real Estate.</p>`));
    res.send(invitePage(req, i, u));
  });

  r.post('/invite/:token', limiter, async (req, res) => {
    preToken(req, res);
    const i = await lookup(req.params.token);
    if (!i || !i.usable) return unusable(req, res, i);
    if (!checkPre(req)) return res.status(400).send(invitePage(req, i, null, 'Your form expired. Please try again.'));
    let u = (await pool.query('select * from users where lower(email) = lower($1)', [i.email])).rows[0];
    if (u && (u.kind !== 'external' || !u.active)) return unusable(req, res, null);
    const pw = String(req.body.password || '');
    let hash = null, name = null;
    if (u) {
      if (!(await verifyPassword(pw, u.password_hash))) return res.status(400).send(invitePage(req, i, u, 'That password is not correct.'));
    } else {
      name = txt(req.body.name, 120);
      if (!name) return res.status(400).send(invitePage(req, i, null, 'Enter your full name.'));
      if (pw.length < MIN_PW) return res.status(400).send(invitePage(req, i, null, `Use at least ${MIN_PW} characters.`));
      if (pw !== String(req.body.confirm || '')) return res.status(400).send(invitePage(req, i, null, 'The passwords do not match.'));
      hash = await hashPassword(pw);
    }
    const uid = await core.inTx(async db => {
      // single use: only one request can move the invitation out of "pending"
      const ok = (await db.query("update invitations set status = 'accepted', accepted_at = now() where id = $1 and status = 'pending' and expires_at > now() returning id", [i.id])).rows[0];
      if (!ok) return null;
      let id = u && u.id;
      if (!id) {
        id = (await db.query(`insert into users (email, name, kind, system_role, role, password_hash, must_change_password, party_id)
          values ($1,$2,'external','external','viewer',$3,false,$4) returning id`, [i.email, name, hash, i.party_id])).rows[0].id;
        await core.audit(db, { actor: { id, name }, action: 'user.activated', entity: 'user', entityId: id, summary: `${name} activated an external login from an invitation`, ip: req.ip });
      } else if (i.party_id) await db.query('update users set party_id = coalesce(party_id, $2) where id = $1', [id, i.party_id]);
      await db.query('update invitations set accepted_user = $2 where id = $1', [i.id, id]);
      await db.query(`insert into workspace_members (workspace_id, user_id, role, grants, added_by) values ($1,$2,$3,$4,$5)
        on conflict (workspace_id, user_id) do update set role = excluded.role, grants = excluded.grants, added_by = excluded.added_by, added_at = now(), revoked_at = null`,
        [i.workspace_id, id, i.role, i.grants, i.created_by]);
      await core.audit(db, { actor: { id, name: name || u.name || i.email }, workspaceId: i.workspace_id, action: 'invitation.accepted', entity: 'invitation', entityId: i.id, summary: `${name || u.name || i.email} accepted the invitation (${EXTERNAL_MEMBER_ROLES[i.role]})`, ip: req.ip });
      return id;
    });
    if (!uid) return unusable(req, res, await lookup(req.params.token));
    await core.createSession(res, req, uid);
    res.redirect(`/p/${i.workspace_id}`);
  });
}

module.exports = { mountInvitations, VIEWER_ROLES, ROLES_FOR, GRANTS, grantSummary };
