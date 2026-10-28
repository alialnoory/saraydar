'use strict';
const { html, raw } = require('../lib/html');
const { STATUS_LABEL } = require('./core');
// Version stamp for the stylesheet and script, so browsers fetch the new files after every update instead of a cached copy.
const ASSET_V = (() => { try { const c = require('crypto'), fs = require('fs'), p = require('path'); const h = c.createHash('sha256'); for (const f of ['app.css', 'app.js', 'pdfview.mjs', 'apple-touch-icon.png', 'icon.svg', 'favicon.ico']) h.update(fs.readFileSync(p.join(__dirname, '..', 'public', f))); return h.digest('hex').slice(0, 10); } catch { return String(Date.now()); } })();

const ROLE_LABELS = {
  super_admin: 'Super Admin', project_manager: 'Project Manager', finance: 'Finance', engineer: 'Engineer', viewer: 'Viewer',
  brokerage_agent: 'Brokerage Agent', sales_manager: 'Sales Manager', external: 'External viewer'
};

const MESSAGES = {
  saved: 'Saved.', undone: 'Your last change was undone.', redone: 'Your change was redone.', nothing_to_undo: 'There is nothing to undo.', nothing_to_redo: 'There is nothing to redo.', created: 'Created.', deleted: 'Deleted.', uploaded: 'Uploaded.', archived: 'Archived.', added: 'Added.', revoked: 'Access removed.',
  password: 'Your password has been changed.', mfa_on: 'Two-step verification is on.', mfa_off: 'Two-step verification is off.',
  reset_sent: 'If that account exists and email is configured, a reset link has been sent. Otherwise ask your administrator.',
  reset_done: 'Your password has been reset. Sign in with the new password.', signed_out: 'You have signed out.',
  sessions: 'Other sessions have been signed out.', user_created: 'User created. Send them their temporary password.',
  user_saved: 'User updated.', pw_reset: 'Temporary password set. The user must change it at next sign-in.', mfa_reset: 'Two-step verification reset.',
  roles: 'Role permissions updated.', expired: 'Your session has ended. Sign in again.',
  sent: 'Added. The client has been notified by email.', answered: 'Thank you. Your answer has been sent to SarayDar.', feedback: 'Thank you. Your feedback has been sent to SarayDar.'
};

const fmtDate = d => d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Bahrain' }) : '';
const fmtDateTime = d => d ? new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bahrain' }) : '';
const fmtSize = n => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`;

const STATUS_TONE = { active: 'ok', on_hold: 'warn', completed: 'info', archived: 'muted', sent: 'ok', queued: 'warn', unconfigured: 'muted', failed: 'bad' };
// Profile photo or initial. `u` needs id, name/email and photo_v (photo timestamp, or null).
const avatar = (u, cls = '') => u && u.photo_v
  ? html`<img class="avatar ${cls}" src="/users/${u.id}/photo?v=${u.photo_v}" alt="" width="36" height="36">`
  : html`<span class="avatar ${cls}" aria-hidden="true">${((u && (u.name || u.email)) || '?').trim().charAt(0).toUpperCase()}</span>`;
const pill = (text, tone = 'muted') => html`<span class="pill pill-${tone}">${text}</span>`;
const statusPill = s => pill(STATUS_LABEL[s] || s, STATUS_TONE[s] || 'muted');

function csrfField(req) { return html`<input type="hidden" name="_csrf" value="${req.csrfToken || ''}">`; }

const icons = {
  dev: raw('<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 21h18"/><path d="M5 21V8l7-5 7 5v13"/><path d="M9 21v-6h6v6"/></svg>'),
  cpm: raw('<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 20h20"/><path d="M6 20V10h5v10"/><path d="M11 6h9v14"/><path d="M14 10h3M14 14h3"/></svg>'),
  props: raw('<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="3" width="16" height="18" rx="1"/><path d="M8 7h2M14 7h2M8 11h2M14 11h2M8 15h2M14 15h2"/></svg>'),
  sales: raw('<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M9 15l3 3 3-3"/></svg>'),
  search: raw('<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>')
};

// the sections of each kind of record, grouped (owner request 2026-10-28: Project, Planning & Site, Finance, Files & People)
const FILES_PEOPLE = ['Files & People', ['Documents', 'Access & Invitations', 'Activity', 'Assistant']];
const PROJECT_GROUPS = [['Project', ['Client', 'Agreements', 'Setup', 'Land & Plots', 'Client Approvals']], ['Planning & Site', ['Plan', 'Master Plan', 'Progress Updates', 'Registers', 'Units & Sales']],
  ['Finance', ['Client Budget & Payments', 'Budget & Cost', 'Fee Billing', 'Investors & Funding', 'Reports']], FILES_PEOPLE];
const GROUPS_BY_KIND = {
  project: PROJECT_GROUPS, client_project: PROJECT_GROUPS,
  property: [['Property', ['Owner', 'Agreements', 'Property Setup', 'Units', 'Leases & Tenants']], ['Operations', ['Maintenance', 'Cleaning & Services', 'Unit History']],
    ['Finance', ['Rent & Collections', 'Deposits', 'Expenses', 'Owner Account', 'Fee Billing', 'Reports']], FILES_PEOPLE],
  listing: [['Listing', ['Mandate', 'Property File', 'Agreements']], ['Marketing & Buyers', ['Marketing', 'Buyers & Viewings', 'Offers & Deal']], ['Finance', ['Fee Billing', 'Expenses']], FILES_PEOPLE],
  request: [['Request', ['Mandate', 'Brief', 'Agreements']], ['Search & Offers', ['Matches & Shortlist', 'Viewings & Offers']], ['Finance', ['Fee Billing', 'Expenses']], FILES_PEOPLE],
  deal: [['Deal', ['Checklist', 'Agreements']], FILES_PEOPLE]
};
const svgI = d => raw(`<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`);
const PI = {
  pin: svgI('<path d="M12 21s-7-6-7-11a7 7 0 0114 0c0 5-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>'), stage: svgI('<path d="M3 21h18"/><path d="M5 21V9l7-5 7 5v12"/><path d="M10 21v-6h4v6"/>'),
  plus: svgI('<path d="M12 5v14"/><path d="M5 12h14"/>'), check: svgI('<circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/>'), spark: svgI('<path d="M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z"/>'),
  home: svgI('<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/>'), more: svgI('<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>'), dot: svgI('<circle cx="12" cy="12" r="4"/>')
};
const TAB_ICON = {
  Client: svgI('<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>'), Agreements: svgI('<path d="M7 3h7l5 5v13H7a2 2 0 01-2-2V5a2 2 0 012-2z"/><path d="M14 3v5h5"/><path d="M9 13h6"/><path d="M9 17h4"/>'),
  Setup: svgI('<path d="M4 6h10"/><path d="M18 6h2"/><circle cx="16" cy="6" r="2"/><path d="M4 12h4"/><path d="M12 12h8"/><circle cx="10" cy="12" r="2"/><path d="M4 18h10"/><path d="M18 18h2"/><circle cx="16" cy="18" r="2"/>'),
  'Land & Plots': svgI('<path d="M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3z"/><path d="M9 3v15"/><path d="M15 6v15"/>'), 'Client Approvals': svgI('<circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/>'),
  Plan: svgI('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18"/><path d="M8 3v4"/><path d="M16 3v4"/>'), 'Master Plan': svgI('<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>'),
  'Progress Updates': svgI('<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>'), Registers: svgI('<path d="M9 6h12"/><path d="M9 12h12"/><path d="M9 18h12"/><path d="M4 6h1"/><path d="M4 12h1"/><path d="M4 18h1"/>'),
  'Client Budget & Payments': svgI('<rect x="3" y="6" width="18" height="14" rx="3"/><path d="M3 10h18"/><path d="M16 15h2"/>'), 'Budget & Cost': svgI('<rect x="3" y="6" width="18" height="14" rx="3"/><path d="M3 10h18"/><path d="M16 15h2"/>'),
  Owner: svgI('<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>'), 'Property Setup': svgI('<path d="M4 6h10"/><path d="M18 6h2"/><circle cx="16" cy="6" r="2"/><path d="M4 12h4"/><path d="M12 12h8"/><circle cx="10" cy="12" r="2"/><path d="M4 18h10"/><path d="M18 18h2"/><circle cx="16" cy="18" r="2"/>'),
  Units: svgI('<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 7h2"/><path d="M14 7h2"/><path d="M8 11h2"/><path d="M14 11h2"/><path d="M10 21v-4h4v4"/>'), 'Leases & Tenants': svgI('<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9"/><path d="M17 6l3 3"/>'),
  Maintenance: svgI('<path d="M14.5 6.5a4 4 0 00-5.4 5.2L4 16.8V20h3.2l5.1-5.1a4 4 0 005.2-5.4l-2.5 2.5-2.6-.6-.6-2.6z"/>'), 'Cleaning & Services': svgI('<path d="M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z"/>'), 'Unit History': svgI('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  'Rent & Collections': svgI('<rect x="3" y="6" width="18" height="14" rx="3"/><path d="M3 10h18"/><path d="M16 15h2"/>'), Deposits: svgI('<rect x="3" y="5" width="18" height="15" rx="2"/><circle cx="12" cy="12.5" r="3"/><path d="M12 9.5v-1"/>'),
  Expenses: svgI('<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6"/><path d="M9 12h6"/>'), 'Owner Account': svgI('<path d="M3 7h15a3 3 0 013 3v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><path d="M3 7l12-4v4"/><circle cx="16" cy="14" r="1.2"/>'),
  Mandate: svgI('<path d="M7 3h7l5 5v13H7a2 2 0 01-2-2V5a2 2 0 012-2z"/><path d="M14 3v5h5"/><path d="M9 16l2 2 4-4"/>'), 'Property File': svgI('<path d="M3 21h18"/><path d="M5 21V9l7-5 7 5v12"/><path d="M10 21v-6h4v6"/>'),
  Marketing: svgI('<path d="M3 11v2a1 1 0 001 1h3l6 4V6L7 10H4a1 1 0 00-1 1z"/><path d="M17 9a4 4 0 010 6"/>'), 'Buyers & Viewings': svgI('<circle cx="9" cy="8" r="4"/><path d="M2 21c0-4 3-6 7-6s7 2 7 6"/><circle cx="18" cy="9" r="3"/><path d="M22 19c0-2.5-1.8-4-4-4"/>'),
  'Offers & Deal': svgI('<path d="M7 12l3 3 7-7"/><rect x="3" y="3" width="18" height="18" rx="4"/>'), Brief: svgI('<path d="M9 6h12"/><path d="M9 12h12"/><path d="M9 18h12"/><path d="M4 6h1"/><path d="M4 12h1"/><path d="M4 18h1"/>'),
  'Matches & Shortlist': svgI('<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>'), 'Viewings & Offers': svgI('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  Checklist: svgI('<path d="M9 6h12"/><path d="M9 12h12"/><path d="M9 18h12"/><path d="M3 6l1 1 2-2"/><path d="M3 12l1 1 2-2"/><path d="M3 18l1 1 2-2"/>'), 'Units & Sales': svgI('<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 7h2"/><path d="M14 7h2"/><path d="M8 11h2"/><path d="M14 11h2"/><path d="M10 21v-4h4v4"/>'),
  'Fee Billing': svgI('<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6"/><path d="M9 12h6"/>'), 'Investors & Funding': svgI('<circle cx="12" cy="12" r="9"/><path d="M12 7v10"/><path d="M15 9.5c0-1.4-1.3-2.5-3-2.5s-3 1-3 2.5 1.3 2 3 2.5 3 1.1 3 2.5-1.3 2.5-3 2.5-3-1.1-3-2.5"/>'),
  Reports: svgI('<path d="M5 20V11"/><path d="M11 20V5"/><path d="M17 20v-7"/><path d="M3 20h18"/>'), Documents: svgI('<path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>'),
  'Access & Invitations': svgI('<circle cx="9" cy="8" r="4"/><path d="M2 21c0-4 3-6 7-6s7 2 7 6"/><path d="M19 8v6"/><path d="M16 11h6"/>'), Activity: svgI('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  Assistant: svgI('<path d="M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z"/>')
};
// progress ring for the project screen; null = not available
function ring(p) {
  const C = 2 * Math.PI * 34, v = p === null || p === undefined ? 0 : Math.max(0, Math.min(100, p));
  return raw(`<svg class="mring" width="84" height="84" viewBox="0 0 84 84" role="img" aria-label="${p === null || p === undefined ? 'Progress not available' : `${Math.round(v)}% complete`}"><circle cx="42" cy="42" r="34" fill="none" stroke="#F0E7DF" stroke-width="9"/>${v > 0 ? `<circle cx="42" cy="42" r="34" fill="none" stroke="${v >= 100 ? '#2F7D4F' : '#8A5330'}" stroke-width="9" stroke-linecap="round" stroke-dasharray="${(C * v / 100).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 42 42)"/>` : ''}<text x="42" y="47.5" text-anchor="middle" font-size="16" font-weight="700" fill="#1C1612">${p === null || p === undefined ? '—' : `${Math.round(v * 10) / 10}%`}</text></svg>`);
}

function layout(req, { title, crumbs = [], heading = null, sub = null, tabs = null, actions = null, body, bare = false, noExport = false }) {
  const u = req.user;
  // Page navigation (Back / Home / Next tab) and export buttons, shown on every signed-in page.
  const home = u && u.kind === 'external' ? '/my' : '/';
  const linked = crumbs.filter(c => c[1]);
  const parent = linked.length ? linked[linked.length - 1][1] : home;
  const bodyStr = String(body || '');
  const exportable = !!u && !bare && !noExport && !(u.kind === 'external' && !req.canExport) && req.method === 'GET' && !/^\/(mfa|reset|login|forgot)/.test(req.path)
    && /<table|class="(details|stats|kv|card|rows|feed|empty|ws-grid)|<p[ >]/.test(bodyStr.replace(/<form[\s\S]*?<\/form>/g, ''));
  // Preview opens the same PDF in a new tab instead of downloading it; the file name rides at the end of the address
  // so a phone saves it under that name
  // the same name the downloaded file gets: "Reference - name - tab - date" (see page-export nameParts)
  const pdfName = () => { const DL = require('../lib/download'); const ref = sub && sub.above ? String(sub.above).split(' · ')[0] : '';
    const name = req.path === '/' ? 'SarayDar Home' : String(heading || title || 'SarayDar'); const cur = tabs ? (tabs.find(t => t[2]) || [])[0] : null;
    return DL.fileName([ref, name, cur && cur !== name ? cur : null, DL.today()], 'pdf'); };
  const previewHref = () => { const q = new URLSearchParams(req.query); q.delete('msg'); q.delete('page'); q.set('export', 'pdf'); q.set('view', '1'); return `${req.path.replace(/\/$/, '')}/~/${encodeURIComponent(pdfName())}?${q}`; };
  const exportHref = fmt => { const q = new URLSearchParams(req.query); q.delete('msg'); q.delete('page'); q.set('export', fmt); return `${req.path}?${q}`; };
  const I = {
    back: raw('<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>'),
    home: raw('<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/></svg>'),
    eye: raw('<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>'),
    file: raw('<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11"/><path d="M7 10l5 5 5-5"/><path d="M5 20h14"/></svg>'),
    undo: raw('<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>'),
    redo: raw('<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 14l5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/></svg>'),
    fwd: raw('<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>')
  };
  // one Export button with PDF and Excel inside (owner request 2026-10-28)
  const exportMenu = () => html`<details class="exportmenu"><summary class="navbtn">${I.file}Export</summary><div class="menu">
      <a href="${previewHref()}" target="_blank" rel="nofollow noopener">PDF<small>Read, share or print</small></a><a href="${exportHref('xlsx')}" rel="nofollow">Excel<small>Spreadsheet with the page's tables</small></a></div></details>`;
  const here = (() => { const q = new URLSearchParams(req.query || {}); q.delete('msg'); const s = q.toString(); return `${req.path}${s ? `?${s}` : ''}`; })();
  const us = req.undoState;
  const undoNav = us ? html`<div class="navgroup" aria-label="Undo and redo">
      <form method="post" action="/undo" class="navform"><input type="hidden" name="_csrf" value="${req.csrfToken || ''}"><input type="hidden" name="back" value="${here}"><button class="navbtn" type="submit" ${us.undo ? '' : raw('disabled')} title="${us.undo ? `Undo: ${us.undo.label}` : 'Nothing to undo'}">${I.undo}Undo</button></form>
      <form method="post" action="/redo" class="navform"><input type="hidden" name="_csrf" value="${req.csrfToken || ''}"><input type="hidden" name="back" value="${here}"><button class="navbtn" type="submit" ${us.redo ? '' : raw('disabled')} title="${us.redo ? `Redo: ${us.redo.label}` : 'Nothing to redo'}">${I.redo}Redo</button></form></div>` : '';
  const pagenav = !u || bare ? '' : html`<div class="pagenav" role="navigation" aria-label="Page navigation">
    <div class="navgroup"><a class="navbtn" href="${parent}" data-back>${I.back}Back</a><a class="navbtn" href="${home}">${I.home}Home</a></div>
    ${undoNav}
    ${exportable ? exportMenu() : ''}
  </div>`;
  // Client project pages: the modern project screen (owner request 2026-10-28; design "Saraydar Project Screen
  // Redesign"): a hero header with chips and Undo/Redo · Export · Update, the sections grouped into Project,
  // Planning & Site, Finance and Files & People, a floating Assistant button and, on phones, a bottom tab bar.
  const modern = !!(u && u.kind !== 'external' && heading && tabs && req.wsKind && GROUPS_BY_KIND[req.wsKind] && !bare);
  const P = req.projectScreen || {};
  const tabOf = l => (tabs || []).find(t => t[0] === l);
  const curTab = tabs ? (tabs.find(t => t[2]) || [])[0] : null;
  const wsBase = modern ? ((tabOf('Overview') || [])[1] || req.path) : null;
  const GR = modern ? GROUPS_BY_KIND[req.wsKind] : [];
  const groups = GR.map(([g, labels]) => [g, labels.map(tabOf).filter(Boolean)]).filter(([, t]) => t.length);
  const grouped = new Set(GR.flatMap(([, l]) => l).concat(['Overview']));
  if (modern) { const rest = (tabs || []).filter(t => !grouped.has(t[0])); if (rest.length) groups[groups.length - 1][1].push(...rest); }
  const chips = modern ? (() => {
    const below = String((sub && sub.below) || '').split(' · ').filter(Boolean);
    const loc = below.find(x => !/^Stage: /.test(x)), stage = (below.find(x => /^Stage: /.test(x)) || '').replace(/^Stage: /, '');
    return [loc ? [PI.pin, loc] : null, stage ? [PI.stage, stage] : null].filter(Boolean);
  })() : [];
  const SHORT_SECTION = { 'Clients Projects Management': 'Clients Projects', 'SarayDar Real Estate Development': 'Development', 'Property Management': 'Properties', 'Property Sales & Acquisition': 'Sales' };
  const sc = modern ? crumbs.find(c => c[1] && /^\/s\//.test(c[1])) : null;
  const sectionCrumb = sc ? [SHORT_SECTION[sc[0]] || String(sc[0]).replace(/^Clients? /, '').replace(/ Management$/, ''), sc[1]] : null;
  const modernHead = () => html`<div class="wrap mhead">
      <div class="mcrumb"><a class="mback" href="${curTab === 'Overview' ? (sectionCrumb ? sectionCrumb[1] : '/') : wsBase}" aria-label="Back">${I.back}</a>
        ${sectionCrumb ? html`<a href="${sectionCrumb[1]}">${sectionCrumb[0]}</a><span aria-hidden="true">/</span>` : ''}${curTab !== 'Overview' ? html`<a href="${wsBase}">${heading}</a><span aria-hidden="true">/</span><span>${curTab}</span>` : html`<span>${heading}</span>`}</div>
      <div class="mtitle"><div class="grow">
        ${sub && sub.above ? html`<div class="meyebrow">${sub.above}</div>` : ''}<span class="pdf-tab" hidden>${curTab}</span>
        <h1>${heading}</h1>
        <div class="mchips">${chips.map(([ic, t]) => html`<span class="mchip">${ic}${t}</span>`)}${sub && sub.badge ? html`<span class="mchip mstatus">${sub.badge}</span>` : ''}</div></div>
        <div class="mactions">${undoNav ? html`<div class="mseg">${undoNav}</div>` : ''}${exportable ? exportMenu() : ''}${P.update ? html`<a class="mbtn mprimary" href="${P.update}">${PI.plus}Update</a>` : ''}</div></div>
      ${curTab !== 'Overview' ? html`<nav class="mgroups" aria-label="Sections">${groups.map(([g, ts]) => html`<div class="mgroup"><span class="mglabel">${g}</span>${ts.map(([l, h, on]) => html`<a href="${h}" ${on ? raw('aria-current="page"') : ''}>${l}</a>`)}</div>`)}</nav>` : ''}
    </div>`;
  // every other staff page with a heading gets the same modern header (owner request 2026-10-28: "here also")
  const hero = !!(u && u.kind !== 'external' && !bare && !modern);
  const crumbLinks = crumbs.filter(c => c[1]);
  const heroHead = () => html`<div class="wrap mhead">
      ${crumbLinks.length ? html`<div class="mcrumb"><a class="mback" href="${parent}" aria-label="Back" data-back>${I.back}</a>${crumbs.map((c, i) => html`${i ? html`<span aria-hidden="true">/</span>` : ''}${c[1] ? html`<a href="${c[1]}">${c[0]}</a>` : html`<span>${c[0]}</span>`}`)}</div>` : ''}
      <div class="mtitle"><div class="grow">
        ${sub && sub.above ? html`<div class="meyebrow">${sub.above}</div>` : ''}${tabs ? html`<span class="pdf-tab" hidden>${(tabs.find(t => t[2]) || [])[0] || ''}</span>` : ''}
        <h1>${heading}</h1>
        ${sub && (sub.below || sub.badge) ? html`<div class="mchips">${sub.below ? html`<span class="mmeta">${sub.below}</span>` : ''}${sub.badge ? html`<span class="mchip mstatus">${sub.badge}</span>` : ''}</div>` : ''}</div>
        <div class="mactions">${undoNav ? html`<div class="mseg">${undoNav}</div>` : ''}${exportable ? exportMenu() : ''}${actions ? html`<div class="mpage-actions">${actions}</div>` : ''}</div></div>
      ${tabs ? html`<nav class="mgroups mgroups-flat" aria-label="Sections"><div class="mgroup">${tabs.map(([label, href, on]) => html`<a href="${href}" ${on ? raw('aria-current="page"') : ''}>${label}</a>`)}</div></nav>` : ''}
    </div>`;
  const overviewTop = () => !modern || curTab !== 'Overview' ? '' : html`
    <div class="mtop no-export">
      ${P.progress ? html`<section class="mprog" aria-label="Project progress">
        <div class="mprog-head">${ring(P.progress.pct)}<div class="grow"><span class="mlabel">MASTER PLAN</span><b class="mprog-t">Construction progress</b>
          <span class="muted">${P.progress.phase ? `Current phase: ${P.progress.phase}` : P.progress.pct === null ? 'Plan weights incomplete' : 'No stage in progress yet'}</span></div></div>
        <div class="mstats">${P.progress.stats.map(([l, v, href]) => html`<${href ? 'a' : 'div'} class="mstat" ${href ? raw(`href="${href}"`) : ''}><span>${l}</span><b>${v}</b></${href ? 'a' : 'div'}>`)}</div></section>` : ''}
      ${P.approvals ? html`<a class="mapprove" href="${P.approvals.href}"><span class="mapprove-ic">${PI.check}</span><span class="grow"><b>Client approvals</b><span>${P.approvals.n ? `${P.approvals.n} waiting for a response` : 'Nothing waiting for a response'}</span></span>${I.fwd}</a>` : ''}
    </div>
    <div class="mtiles no-export" id="sections">${groups.map(([g, ts]) => html`<section class="mtile-group"><h2>${g}</h2><div class="mtile-grid">${ts.map(([l, h]) => html`<a class="mtile" href="${h}"><span class="mtile-ic">${TAB_ICON[l] || PI.dot}</span>${l === 'Client Budget & Payments' ? 'Budget & Payments' : l === 'Access & Invitations' ? 'Access & Invites' : l}</a>`)}</div></section>`)}</div>
    ${P.latest && P.latest.length ? html`<section class="mlatest"><div class="row-between"><h2>LATEST</h2><a href="${wsBase}/updates">See all</a></div>
      ${P.latest.map((x, i) => html`<a class="mlatest-row" href="${x.href}"><span class="mdot ${i ? '' : 'on'}"></span><span><b>${x.title}</b><small>${x.meta}</small></span></a>`)}</section>` : ''}`;
  const generalBar = u && u.kind !== 'external' && !bare && !modern ? html`<nav class="mtabbar no-export" aria-label="Main"><a href="/" ${req.path === '/' ? raw('aria-current="page"') : ''}>${PI.home}Home</a><a href="/search" ${req.path === '/search' ? raw('aria-current="page"') : ''}>${svgI('<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>')}Search</a><a href="/help" ${req.path === '/help' ? raw('aria-current="page"') : ''}>${svgI('<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 015 .5c0 1.5-2.5 2-2.5 3.5"/><path d="M12 17h.01"/>')}Help</a><a href="/account" ${req.path === '/account' ? raw('aria-current="page"') : ''}>${PI.more}Account</a></nav>` : '';
  const floating = !modern ? generalBar : html`${tabOf('Assistant') && curTab !== 'Assistant' ? html`<a class="mfab no-export" href="${tabOf('Assistant')[1]}">${PI.spark}Assistant</a>` : ''}
    <nav class="mtabbar no-export" aria-label="Main"><a href="/">${PI.home}Home</a><a href="${sectionCrumb ? sectionCrumb[1] : '/'}" aria-current="page">${PI.stage}${['project', 'client_project'].includes(req.wsKind) ? 'Projects' : req.wsKind === 'property' ? 'Properties' : 'Sales'}</a>
      ${tabOf('Client Approvals') ? html`<a href="${tabOf('Client Approvals')[1]}" ${curTab === 'Client Approvals' ? raw('aria-current="page"') : ''}>${PI.check}Approvals${P.approvals && P.approvals.n ? html`<i class="mbadge">${P.approvals.n}</i>` : ''}</a>` : tabOf('Activity') ? html`<a href="${tabOf('Activity')[1]}">${TAB_ICON.Activity}Activity</a>` : ''}<a href="${wsBase}#sections">${PI.more}More</a></nav>`;
  const msg = MESSAGES[req.query && req.query.msg];
  const header = bare ? html`
    <header class="band"><div class="wrap band-row"><a class="brand" href="/"><span class="wordmark">SΛRΛYDΛR</span><span class="band-sub">Management System</span></a></div></header>`
    : html`
    <header class="band">
      <div class="wrap band-row">
        <a class="brand grow" href="${u && u.kind === 'external' ? '/my' : '/'}"><span class="wordmark">SΛRΛYDΛR</span><span class="band-sub">Management System</span></a>
        ${u && u.kind !== 'external' ? html`<form class="band-search" action="/search" method="get" role="search">
          ${icons.search}<input type="search" name="q" placeholder="Search projects, properties, clients" aria-label="Search" value="${req.path === '/search' ? (req.query.q || '') : ''}"></form>` : ''}
        ${u ? html`<details class="usermenu">
          <summary>${avatar(u)}
            <span class="who"><b>${u.name || u.email}</b><small>${ROLE_LABELS[u.system_role] || u.system_role}</small></span></summary>
          <div class="menu">
            <a href="/account">Account &amp; security</a>
            ${u.kind !== 'external' ? html`<a href="/help">Help &amp; user guide</a>` : ''}
            ${u.system_role === 'super_admin' ? html`<a href="/admin">Administration</a>` : ''}
            <form method="post" action="/logout">${csrfField(req)}<button type="submit">Sign out</button></form>
          </div></details>` : ''}
      </div>
      ${heading && modern ? modernHead() : heading && hero ? heroHead() : heading ? html`<div class="wrap band-head">
        <div class="band-top">${crumbs.length ? html`<nav class="crumbs" aria-label="Breadcrumb">${crumbs.map((c, i) => html`${i ? ' › ' : ''}${c[1] ? html`<a href="${c[1]}">${c[0]}</a>` : html`<span>${c[0]}</span>`}`)}</nav>` : html`<span></span>`}${actions ? html`<div class="page-actions">${actions}</div>` : ''}</div>
        <div class="band-title"><div class="grow">${sub && sub.above ? html`<div class="eyebrow">${sub.above}</div>` : ''}<h1>${heading}</h1>${sub && (sub.below || sub.badge) ? html`<div class="band-meta">${sub.below || ''}${sub.badge ? html` <span class="band-badge">${sub.badge}</span>` : ''}</div>` : ''}</div><div class="band-actions">${pagenav}</div></div>
        ${tabs ? html`<nav class="tabs" aria-label="Sections">${tabs.map(([label, href, on]) => html`<a href="${href}" ${on ? raw('aria-current="page"') : ''}>${label}</a>`)}</nav>` : ''}
      </div>` : ''}
    </header>`;
  return '<!doctype html>' + html`<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title ? `${title} · ` : ''}SarayDar Management System</title>
<link rel="icon" href="/static/favicon.ico?v=${ASSET_V}" sizes="any"><link rel="icon" type="image/svg+xml" href="/static/icon.svg?v=${ASSET_V}"><link rel="icon" type="image/png" sizes="32x32" href="/static/favicon-32.png?v=${ASSET_V}"><link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png?v=${ASSET_V}"><meta name="apple-mobile-web-app-title" content="SarayDar"><link rel="manifest" href="/static/manifest.webmanifest"><meta name="theme-color" content="#140D0A">
<link rel="stylesheet" href="/static/app.css?v=${ASSET_V}"><script src="/static/app.js?v=${ASSET_V}" defer></script></head>
<body class="${modern ? 'modern' : ''} ${u && u.kind !== 'external' && !bare ? 'has-tabbar' : ''}">${header}<main class="wrap main">${heading ? '' : pagenav}${msg ? html`<div class="flash" role="status">${msg}</div>` : ''}${overviewTop()}${tabs ? require('./help').tabTip(req, (tabs.find(t => t[2]) || [])[0]) : ''}${body}</main>${floating}</body></html>`;
}

const emptyState = (title, text, action = '') => html`<div class="empty"><strong>${title}</strong><p>${text}</p>${action}</div>`;

// Fields are made as easy to fill as possible (owner request 2026-10-28: "drop downs, ticks or any simplified way,
// across all the system"):
//  - list: a dropdown of the usual answers plus "Other (type it)", which opens a text box (free text is never lost).
//  - options with 2–4 short choices: tap buttons instead of a dropdown.
//  - presets: quick-pick buttons under a typed field (days, bedrooms, %). Some field names get them automatically.
//  - type 'checks': tick-boxes for `options` (strings) plus an "Other" box; posted as one newline-separated answer.
const CHX = () => require('./choices');
const NAME_HINTS = {
  bedrooms: { presets: [1, 2, 3, 4, 5, 6] }, bedrooms_min: { presets: [1, 2, 3, 4, 5, 6] }, bathrooms: { presets: [1, 2, 3, 4, 5] },
  floor: { presets: ['Ground', '1', '2', '3', '4', 'Roof'] },
  approval_days: { presets: [0, 7, 14, 21, 30] }, lead_days: { presets: [14, 30, 45, 60, 90, 120] }, buffer_days: { presets: [0, 7, 14, 21] },
  defects_months: { presets: [6, 12, 24] }, contingency_pct: { presets: [5, 10, 15] }, fee_pct: { presets: [1, 1.5, 2, 2.5, 3] },
  due_day: { presets: [1, 5, 10, 15, 25] }, notice_days: { presets: [7, 30, 60, 90] }, duration_months: { presets: [6, 12, 24, 36] },
  condition: { list: () => CHX().CONDITIONS }, lost_reason: { list: () => CHX().LOST_REASONS }, outcome: { list: () => CHX().VIEWING_OUTCOMES },
  next_action: { list: () => CHX().NEXT_ACTIONS }, category: { list: () => CHX().BUDGET_CATEGORIES },
  reason: { list: () => CHX().REASONS }, change_reason: { list: () => ['Client request', 'Correction', 'Price change', 'Market change', 'Agreed with the client', 'Agreed with the owner'] },
  occupancy: { list: () => ['Vacant', 'Owner-occupied', 'Tenanted', 'Under construction'] }, interest: { list: () => ['Full ownership', 'Share of the property', 'Leasehold rights'] },
  deposit_holder: { list: () => ['SarayDar (client account)', 'Seller', 'Developer', 'Not applicable'] }, payment_terms: { list: () => ['Cash', 'Bank finance / mortgage', 'Instalments', 'To be agreed'] },
  rent_period: { list: () => ['month', 'quarter', 'year'] }
};
const SHORT = 24;
function field({ name, label, type = 'text', value = '', required = false, hint = '', attrs = '', options = null, full = false, list = null, otherLabel = 'Other (one per line)', presets = null, buttons = 'auto', sep = null }) {
  const id = `f-${name}`;
  if (type === 'checks') {
    // sep ',': a comma-separated answer (property types, areas, features); otherwise one answer per line
    const have = String(value || '').split(sep === ',' ? /\r?\n|,\s*/ : /\r?\n/).map(x => x.trim()).filter(Boolean);
    const other = have.filter(v => !options.includes(v));
    return html`<fieldset class="field checks full"><legend>${label}</legend><input type="hidden" name="${name}__checks" value="1">${sep === ',' ? html`<input type="hidden" name="${name}__sep" value=",">` : ''}
      <div class="check-grid">${options.map(o => html`<label class="check"><input type="checkbox" name="${name}__pick" value="${o}" ${have.includes(o) ? raw('checked') : ''} ${raw(attrs)}> ${o}</label>`)}</div>
      <label class="field" for="${id}"><span class="small muted">${otherLabel}</span><textarea id="${id}" name="${name}__other" rows="2" ${raw(attrs)}>${other.join('\n')}</textarea></label>
      ${hint ? html`<small>${hint}</small>` : ''}</fieldset>`;
  }
  const hintOf = NAME_HINTS[String(name).replace(/^v_/, '')];
  if (hintOf && !options && type !== 'textarea' && type !== 'date') {
    if (!list && hintOf.list && type === 'text') list = hintOf.list();
    if (!presets && hintOf.presets) presets = hintOf.presets;
  }
  const head = html`<span>${label}${required ? html` <i class="req" aria-hidden="true">*</i>` : ''}</span>`;
  const plainAttrs = !String(attrs).replace(/\b(maxlength|autocomplete|inputmode|placeholder)="[^"]*"/g, '').trim();
  // a short choice: tap buttons
  const segOpts = options ? options.filter(([v, l]) => !(v === '' && /^Choose/.test(String(l)))) : null;
  if (options && buttons !== false && plainAttrs && segOpts.length >= 2 && segOpts.length <= (buttons === true ? 6 : 4) && segOpts.every(([, l]) => String(l).length <= SHORT)) options = segOpts;
  if (options && buttons !== false && plainAttrs && options.length >= 2 && options.length <= (buttons === true ? 6 : 4) && options.every(([, l]) => String(l).length <= SHORT)) {
    return html`<div class="field seg-field${full ? ' full' : ''}" role="radiogroup" aria-label="${label}">${head}<div class="seg">${options.map(([v, l], i) => html`<label class="seg-opt"><input type="radio" name="${name}" value="${v}" ${String(v) === String(value ?? '') ? raw('checked') : ''} ${required && i === 0 ? raw('required') : ''}><span>${l}</span></label>`)}</div>${hint ? html`<small>${hint}</small>` : ''}</div>`;
  }
  // usual answers: a dropdown with "Other (type it)"
  if (list && list.length && type === 'text' && plainAttrs) {
    const v = value === null || value === undefined ? '' : String(value);
    const known = list.map(String);
    const isOther = v !== '' && !known.includes(v);
    return html`<label class="field${full ? ' full' : ''}" for="${id}">${head}
      <select id="${id}" name="${isOther ? '' : name}" data-other="${name}" ${required ? raw('required') : ''}><option value="">Choose…</option>${known.map(o => html`<option value="${o}" ${o === v ? raw('selected') : ''}>${o}</option>`)}<option value="__other" ${isOther ? raw('selected') : ''}>Other (type it)…</option></select>
      <input class="other-in" type="text" name="${isOther ? name : `${name}__typed`}" value="${isOther ? v : ''}" placeholder="Type it here" aria-label="${label}: other" ${isOther ? '' : raw('hidden')} ${raw(attrs)}>
      ${hint ? html`<small>${hint}</small>` : ''}</label>`;
  }
  const listId = list && list.length ? `dl-${name}-${Math.random().toString(36).slice(2, 7)}` : '';
  if (listId) attrs = `${attrs} list="${listId}" autocomplete="off"`;
  const dl = listId ? html`<datalist id="${listId}">${list.map(o => html`<option value="${o}"></option>`)}</datalist>` : '';
  const ctl = options
    ? html`<select id="${id}" name="${name}" ${required ? raw('required') : ''} ${raw(attrs)}>${options.map(([v, l]) => html`<option value="${v}" ${String(v) === String(value) ? raw('selected') : ''}>${l}</option>`)}</select>`
    : type === 'textarea'
      ? html`<textarea id="${id}" name="${name}" ${required ? raw('required') : ''} ${raw(attrs)}>${value}</textarea>`
      : html`<input id="${id}" name="${name}" type="${type}" value="${value}" ${required ? raw('required') : ''} ${raw(attrs)}>`;
  const quick = presets && !options && type !== 'textarea' && !/\bdisabled\b/.test(attrs) ? html`<div class="pp-chips" data-for="${id}">${presets.map(p => html`<button type="button" class="chip" data-set="${p}">${p}</button>`)}</div>` : '';
  return html`<label class="field${full ? ' full' : ''}" for="${id}">${head}${ctl}${dl}${quick}${hint ? html`<small>${hint}</small>` : ''}</label>`;
}

// Progress picker: a slider with quick buttons (0, 10, 25, 50, 75, 90, 100 %) instead of typing a number.
function progressField({ name, label = 'Progress', value = 0, disabled = false, hint = '', full = true }) {
  const v = Math.max(0, Math.min(100, Number(value) || 0));
  return html`<div class="field progress-field${full ? ' full' : ''}" data-progress><span>${label}</span>
    <div class="pp-row"><input type="range" name="${name}" min="0" max="100" step="5" value="${v}" aria-label="${label}" ${disabled ? raw('disabled') : ''}><output class="pp-val">${v}%</output></div>
    ${disabled ? '' : html`<div class="pp-chips">${[0, 10, 25, 50, 75, 90, 100].map(n => html`<button type="button" class="chip" data-pp="${n}">${n === 100 ? 'Done 100%' : `${n}%`}</button>`)}</div>`}
    ${hint ? html`<small>${hint}</small>` : ''}</div>`;
}

function pager(req, total, page, per) {
  const pages = Math.max(1, Math.ceil(total / per));
  if (pages <= 1) return '';
  const link = p => { const q = new URLSearchParams(req.query); q.set('page', p); q.delete('msg'); return `?${q}`; };
  return html`<nav class="pager" aria-label="Pages">${page > 1 ? html`<a class="btn" href="${link(page - 1)}">Previous</a>` : ''}<span>Page ${page} of ${pages} · ${total} total</span>${page < pages ? html`<a class="btn" href="${link(page + 1)}">Next</a>` : ''}</nav>`;
}

// Cards for people and records in lists (clients, buyers), in the style of the section cards (owner request 2026-10-27).
const initialsOf = n => String(n || '?').trim().split(/\s+/).filter(w => /^[A-Za-z0-9\u0600-\u06FF]/.test(w)).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?';
const CI = {
  phone: raw('<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/></svg>'),
  mail: raw('<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>'),
  person: raw('<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>'),
  pin: raw('<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>'),
  go: raw('<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>')
};
// o: { href, name, sub, tone ('cpm'|'sales'|...), chips: [[text, tone]], lines: [[icon, text]], stats: [[value, label, tone]], highlight: [label, value], foot }
function personCard(o) {
  const lines = (o.lines || []).filter(l => l && l[1]);
  return html`<li><a class="ws-tile wt pc" href="${o.href}">
    <div class="pc-head wt-${o.tone || 'cpm'}"><span class="pc-avatar">${initialsOf(o.name)}</span><span class="pc-title"><b>${o.name}</b>${o.sub ? html`<small>${o.sub}</small>` : ''}</span>${o.badge || ''}</div>
    <div class="wt-body">
      ${lines.length ? html`<div class="pc-lines">${lines.map(([i, t]) => html`<span>${CI[i] || ''}${t}</span>`)}</div>` : ''}
      ${o.highlight ? html`<div class="wt-price"><span>${o.highlight[0]}</span><b>${o.highlight[1]}</b></div>` : ''}
      ${o.chips && o.chips.filter(Boolean).length ? html`<div class="wt-chips">${o.chips.filter(Boolean).map(([t, tone]) => html`<span class="wt-chip ${tone || ''}">${t}</span>`)}</div>` : ''}
      ${o.stats && o.stats.length ? html`<div class="wt-stats" style="grid-template-columns:repeat(${o.stats.length}, minmax(0, 1fr))">${o.stats.map(([v, l, tone]) => html`<div class="${tone ? `wt-${tone}` : ''}"><b class="${String(v).length > 7 ? 'wt-small' : ''}">${v}</b><span>${l}</span></div>`)}</div>` : ''}
    </div>
    <div class="wt-foot"><span>${o.foot || ''}</span><span class="ws-tile-go" aria-hidden="true">${CI.go}</span></div></a></li>`;
}

module.exports = { personCard, initialsOf, ASSET_V, avatar, layout, html, raw, pill, statusPill, csrfField, emptyState, field, progressField, pager, icons, fmtDate, fmtDateTime, fmtSize, ROLE_LABELS, MESSAGES };
