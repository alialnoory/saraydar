'use strict';
// In-portal PDF viewer (owner request 2026-10-24). On an iPhone, the portal opened from the home-screen icon shows a
// PDF with no buttons at all; this page shows the pages with Back, Share / Print and Download.
const { html } = require('./views');

function mountPdfView(r) {
  r.get('/view', (req, res) => {
    const src = String(req.query.src || '');
    // only files of this portal, never another site
    if (!/^\/(?!\/)[^\s]*$/.test(src) || /^\/view\b/.test(src)) return res.status(400).send('Bad file address.');
    const name = (() => { const m = /\/~\/([^?]+)/.exec(src); try { return m ? decodeURIComponent(m[1]) : 'SarayDar.pdf'; } catch (e) { return 'SarayDar.pdf'; } })();
    res.set('Cache-Control', 'no-store');
    res.send('<!doctype html>' + html`<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${name}</title><link rel="stylesheet" href="/static/app.css"><link rel="apple-touch-icon" href="/apple-touch-icon.png"></head>
<body class="pdfview"><header class="pv-bar">
  <button type="button" class="pv-btn" id="pv-back" aria-label="Back">‹ Back</button>
  <span class="pv-name" title="${name}">${name}</span>
  <button type="button" class="pv-btn pv-main" id="pv-share">Share / Print</button>
  <a class="pv-btn" id="pv-dl" href="${src}" download="${name}">Download</a>
</header>
<main id="pv-pages" data-src="${src}" data-name="${name}"><p class="pv-msg">Opening…</p></main>
<script type="module" src="/static/pdfview.mjs"></script></body></html>`);
  });
}

module.exports = { mountPdfView };
