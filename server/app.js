'use strict';
// Composes the whole service: security headers, static assets, the legacy tracker API (/api) and the portal.
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const { legacyRouter, allowed } = require('./legacy');
const { createPortal } = require('./portal');
const { createMailer } = require('./lib/mailer');

function createApp({ pool, jwtSecret, corsOrigins = [], mailer, env = process.env }) {
  const app = express();
  // proxies in front of the app: Render's own (1); with the Netlify front door there are two (TRUST_PROXY_HOPS=2),
  // so the visitor's address (used for sign-in rate limits and the audit log) is read correctly
  const hops = parseInt(env.TRUST_PROXY_HOPS, 10);
  app.set('trust proxy', hops >= 1 && hops <= 5 ? hops : 1);
  app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'self'"], 'script-src': ["'self'"], 'style-src': ["'self'"],
        'style-src-attr': ["'unsafe-inline'"], 'font-src': ["'self'", 'data:'], 'img-src': ["'self'", 'data:'],
        'connect-src': ["'self'"], 'form-action': ["'self'"], 'frame-ancestors': ["'none'"], 'object-src': ["'none'"], 'base-uri': ["'self'"]
      }
    },
    crossOriginResourcePolicy: { policy: 'same-site' },
    // "no-referrer" makes browsers send Origin: null on form posts, which the same-origin check would reject
    referrerPolicy: { policy: 'same-origin' }
  }));
  // browsers also ask for /favicon.ico directly (before any page has loaded)
  // iPhone and iPad look for the home-screen icon at these fixed addresses as well as the one named in the page
  for (const n of ['/apple-touch-icon.png', '/apple-touch-icon-precomposed.png', '/apple-touch-icon-180x180.png', '/apple-touch-icon-120x120.png'])
    app.get(n, (req, res) => res.set('Cache-Control', 'public, max-age=300').sendFile(path.join(__dirname, 'public', 'apple-touch-icon.png')));
  app.get('/favicon.ico', (req, res) => res.set('Cache-Control', 'public, max-age=3600').sendFile(path.join(__dirname, 'public', 'favicon.ico')));
  // PDF viewer library (pdf.js) for the in-portal PDF viewer used on phones
  app.use('/static/pdfjs', express.static(path.join(__dirname, 'node_modules', 'pdfjs-dist', 'legacy', 'build'), { maxAge: '7d', index: false }));
  app.use('/static/pdfjs-fonts', express.static(path.join(__dirname, 'node_modules', 'pdfjs-dist', 'standard_fonts'), { maxAge: '7d', index: false }));
  app.use('/static', express.static(path.join(__dirname, 'public'), { maxAge: '1h', index: false }));
  app.get('/favicon.ico', (req, res) => res.status(204).end());
  app.get('/healthz', (req, res) => res.json({ ok: true }));
  app.use(legacyRouter({ pool, jwtSecret, corsOrigins }));
  app.use(createPortal({ pool, secret: jwtSecret, mailer: mailer || createMailer({ pool, env }), env }));
  return app;
}

module.exports = { createApp, allowed };
