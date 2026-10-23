'use strict';
const express = require('express');
const cookieParser = require('cookie-parser');
const { createCore } = require('./core');
const { mountAuth, homeFor } = require('./auth');
const { mountWorkspaces } = require('./workspaces');
const { mountProjects } = require('./projects');
const { mountProjectExports } = require('./project-exports');
const { mountAgreements } = require('./agreements');
const { mountFees } = require('./fees');
const { mountProperties } = require('./properties');
const { mountRent } = require('./rent');
const { mountMaintenance } = require('./maintenance');
const { mountOwner } = require('./owner');
const { mountSalesCases } = require('./sales-cases');
const { mountSalesCrm } = require('./sales-crm');
const { mountClients } = require('./clients');
const { mountPeople } = require('./people');
const { mountPlots } = require('./plots');
const { mountAdmin } = require('./admin');
const { mountAccount } = require('./account');
const { layout, html } = require('./views');
const pageExport = require('../lib/page-export');

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const PUBLIC_PATHS = [/^\/login$/, /^\/forgot$/, /^\/reset\/[^/]+$/, /^\/static\//, /^\/healthz$/];
const PRE_MFA_PATHS = [/^\/mfa(\/setup)?$/, /^\/logout$/];
const EXTERNAL_WRITE_OK = [/^\/logout$/, /^\/mfa(\/setup)?$/, /^\/account\/password$/, /^\/account\/sessions$/, /^\/account\/photo(\/remove)?$/];

class Forbidden extends Error { constructor(m = 'You do not have access to this.') { super(m); this.status = 403; } }
class NotFound extends Error { constructor(m = 'This page does not exist, or you do not have access to it.') { super(m); this.status = 404; } }

function createPortal({ pool, secret, mailer, env = process.env }) {
  const core = createCore({ pool });
  // Two-step verification is off unless REQUIRE_MFA=1 (owner decision 2026-10-23).
  const mfaOn = env.REQUIRE_MFA === '1';
  const r = express.Router();
  r.use(cookieParser());
  r.use(express.urlencoded({ extended: false, limit: '200kb' }));

  // who is signed in
  r.use(async (req, res, next) => {
    try {
      const s = await core.loadSession(req);
      if (s) { req.user = s.user; req.session = s.session; req.csrfToken = s.session.csrf; }
      res.set('Cache-Control', 'no-store');
      next();
    } catch (e) { next(e); }
  });

  // cross-site protection: same-origin check + per-session token on every change
  r.use((req, res, next) => {
    if (!UNSAFE.has(req.method)) return next();
    const origin = req.get('origin');
    let sameHost = true;
    if (origin) { try { sameHost = new URL(origin).host === req.get('host'); } catch (e) { sameHost = false; } }
    if (!sameHost) return next(new Forbidden('Request blocked: different origin.'));
    if (PUBLIC_PATHS.some(p => p.test(req.path))) return next();       // these check their own pre-session token
    if (!req.user) return res.redirect('/login?msg=expired');
    if (req.is('multipart/form-data')) return next();                    // checked after the upload is parsed
    if (req.body && req.body._csrf === req.session.csrf) return next();
    next(new Forbidden('Your form expired. Go back, reload the page and try again.'));
  });
  core.checkCsrf = req => !!(req.user && req.body && req.body._csrf === req.session.csrf);

  // sign-in gates
  r.use((req, res, next) => {
    if (PUBLIC_PATHS.some(p => p.test(req.path))) return next();
    const u = req.user;
    if (!u) return req.method === 'GET' ? res.redirect('/login' + (req.path !== '/' ? `?next=${encodeURIComponent(req.originalUrl)}` : '')) : res.redirect('/login');
    if (!mfaOn && /^\/mfa(\/setup)?$/.test(req.path)) return res.redirect('/');
    if (PRE_MFA_PATHS.some(p => p.test(req.path))) return next();
    if (mfaOn && u.mfa_enabled && !req.session.mfa_ok) return res.redirect('/mfa');
    if (mfaOn && core.isSuper(u) && !u.mfa_enabled) return res.redirect('/mfa/setup');
    if (u.must_change_password && req.path !== '/account/password') return res.redirect('/account/password?forced=1');
    // external viewers are read-only everywhere except their own account
    if (core.isExternal(u) && UNSAFE.has(req.method) && !EXTERNAL_WRITE_OK.some(p => p.test(req.path))) return next(new Forbidden('Your access is view-only.'));
    next();
  });

  const ctx = { pool, core, mailer, secret, env, mfaOn, Forbidden, NotFound };

  // PDF / Excel export of any page: ?export=pdf|xlsx renders the page as usual for this user, then converts it.
  r.use((req, res, next) => {
    const fmt = req.query.export;
    if (req.method !== 'GET' || !req.user || !['pdf', 'xlsx'].includes(fmt) || /^\/(mfa|reset|login|forgot|files|users)/.test(req.path)) return next();
    req.exportAll = true;
    const send = res.send.bind(res);
    res.send = body => {
      if (res.statusCode !== 200 || typeof body !== 'string' || !body.includes('<main')) return send(body);
      (async () => {
        const page = pageExport.extract(body);
        const when = new Date(), who = req.user.name || req.user.email;
        const buf = fmt === 'pdf' ? await pageExport.toPdf(page, { user: who, when }) : Buffer.from(await pageExport.toXlsx(page, { user: who, when }));
        const ws = (/^\/w\/([0-9a-f-]{36})/.exec(req.path) || [])[1] || null;
        await core.audit(null, { actor: req.user, workspaceId: ws, action: `export.${fmt}`, entity: 'page', entityId: req.path.slice(0, 200), summary: `Exported “${page.title}${page.tab && page.tab !== page.title ? ' · ' + page.tab : ''}” as ${fmt === 'pdf' ? 'PDF' : 'Excel'}`, ip: req.ip });
        res.set({ 'Content-Type': fmt === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': `attachment; filename="${pageExport.fileBase(page)}.${fmt}"`, 'Cache-Control': 'private, no-store' });
        res.end(buf);
      })().catch(next);
      return res;
    };
    next();
  });
  mountAuth(r, ctx);
  mountAccount(r, ctx);
  mountProperties(r, ctx);          // before projects: shared paths (/units, /reports) fall through for other sections
  mountRent(r, ctx);
  mountMaintenance(r, ctx);
  mountOwner(r, ctx);
  mountSalesCases(r, ctx);
  mountSalesCrm(r, ctx);
  const P = mountProjects(r, ctx);
  mountProjectExports(r, ctx, P);
  mountClients(r, ctx, mountFees(r, ctx, P));
  mountPeople(r, ctx);
  mountPlots(r, ctx);
  mountAgreements(r, ctx);
  mountWorkspaces(r, ctx);
  mountAdmin(r, ctx);

  r.use((req, res, next) => next(new NotFound()));
  r.use((err, req, res, next) => {
    const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
    if (status >= 500) console.error(err);
    const msg = err.code === 'LIMIT_FILE_SIZE' ? 'That file is larger than the 25 MB limit.' : status >= 500 ? 'Something went wrong. Try again in a moment.' : err.message;
    res.status(status).send(layout(req, { title: 'Problem', heading: status === 404 ? 'Not found' : status === 403 ? 'Not allowed' : 'Problem',
      body: html`<div class="empty"><strong>${msg}</strong><p><a href="${req.user ? homeFor(req.user) : '/login'}">Go to the start page</a></p></div>` }));
  });
  return r;
}

module.exports = { createPortal, Forbidden, NotFound };
