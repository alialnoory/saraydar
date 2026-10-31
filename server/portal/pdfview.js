'use strict';
// In-portal PDF viewer (owner request 2026-10-24). On an iPhone, the portal opened from the home-screen icon shows a
// PDF with no buttons at all; this page shows the pages with Back, Download (owner request 2026-10-31: save on the
// computer or phone) and Share / Print.
const { html, ASSET_V } = require('./views');

function mountPdfView(r) {
  r.get('/view', (req, res) => {
    const src = String(req.query.src || '');
    // only files of this portal, never another site
    if (!/^\/(?!\/)[^\s]*$/.test(src) || /^\/view\b/.test(src)) return res.status(400).send('Bad file address.');
    const name = (() => { const m = /\/~\/([^?]+)/.exec(src); try { return m ? decodeURIComponent(m[1]) : 'SarayDar.pdf'; } catch (e) { return 'SarayDar.pdf'; } })();
    res.set('Cache-Control', 'no-store');
    res.send('<!doctype html>' + html`<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${name}</title><link rel="stylesheet" href="/static/app.css?v=${ASSET_V}"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><meta name="theme-color" content="#FFFFFF"></head>
<body class="pdfview"><header class="pv-bar">
  <div class="pv-row">
    <button type="button" class="pv-btn pv-main" id="pv-back" aria-label="Back"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>Back</button>
    <div class="pv-actions">
      <button type="button" class="pv-btn pv-main" id="pv-download"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M5 21h14"/></svg>Download</button>
      <button type="button" class="pv-btn pv-main" id="pv-share"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M12 15V3"/><path d="M7 8l5-5 5 5"/><path d="M5 12v8h14v-8"/></svg>Share / Print</button>
    </div>
  </div>
  <div class="pv-name">${name.replace(/\.pdf$/i, '')}<span class="pv-info" id="pv-info">PDF</span></div>
</header>
<main id="pv-pages" data-src="${src}" data-name="${name}"><p class="pv-msg">Opening…</p></main>
<script type="module" src="/static/pdfview.mjs?v=${ASSET_V}"></script></body></html>`);
  });
}

module.exports = { mountPdfView };
