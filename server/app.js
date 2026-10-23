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
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'self'"], 'script-src': ["'self'"], 'style-src': ["'self'"],
        'style-src-attr': ["'unsafe-inline'"], 'font-src': ["'self'"], 'img-src': ["'self'", 'data:'],
        'connect-src': ["'self'"], 'form-action': ["'self'"], 'frame-ancestors': ["'none'"], 'object-src': ["'none'"], 'base-uri': ["'self'"]
      }
    },
    crossOriginResourcePolicy: { policy: 'same-site' },
    // "no-referrer" makes browsers send Origin: null on form posts, which the same-origin check would reject
    referrerPolicy: { policy: 'same-origin' }
  }));
  app.use('/static', express.static(path.join(__dirname, 'public'), { maxAge: '1h', index: false }));
  app.get('/healthz', (req, res) => res.json({ ok: true }));
  app.use(legacyRouter({ pool, jwtSecret, corsOrigins }));
  app.use(createPortal({ pool, secret: jwtSecret, mailer: mailer || createMailer({ pool, env }), env }));
  return app;
}

module.exports = { createApp, allowed };
