'use strict';
const { html, raw } = require('../lib/html');
const { STATUS_LABEL } = require('./core');

const ROLE_LABELS = {
  super_admin: 'Super Admin', project_manager: 'Project Manager', finance: 'Finance', engineer: 'Engineer', viewer: 'Viewer',
  brokerage_agent: 'Brokerage Agent', sales_manager: 'Sales Manager', external: 'External viewer'
};

const MESSAGES = {
  saved: 'Saved.', created: 'Created.', uploaded: 'Uploaded.', archived: 'Archived.', added: 'Added.', revoked: 'Access removed.',
  password: 'Your password has been changed.', mfa_on: 'Two-step verification is on.', mfa_off: 'Two-step verification is off.',
  reset_sent: 'If that account exists and email is configured, a reset link has been sent. Otherwise ask your administrator.',
  reset_done: 'Your password has been reset. Sign in with the new password.', signed_out: 'You have signed out.',
  sessions: 'Other sessions have been signed out.', user_created: 'User created. Send them their temporary password.',
  user_saved: 'User updated.', pw_reset: 'Temporary password set. The user must change it at next sign-in.', mfa_reset: 'Two-step verification reset.',
  roles: 'Role permissions updated.', expired: 'Your session has ended. Sign in again.'
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

function layout(req, { title, crumbs = [], heading = null, sub = null, tabs = null, actions = null, body, bare = false }) {
  const u = req.user;
  const msg = MESSAGES[req.query && req.query.msg];
  const header = bare ? html`
    <header class="band"><div class="wrap band-row"><a class="wordmark" href="/">SΛRΛYDΛR</a><span class="band-sub">Management System</span></div></header>`
    : html`
    <header class="band">
      <div class="wrap band-row">
        <a class="wordmark" href="${u && u.kind === 'external' ? '/my' : '/'}">SΛRΛYDΛR</a>
        <span class="band-sub grow">Management System</span>
        ${u && u.kind !== 'external' ? html`<form class="band-search" action="/search" method="get" role="search">
          ${icons.search}<input type="search" name="q" placeholder="Search projects, properties, clients" aria-label="Search" value="${req.path === '/search' ? (req.query.q || '') : ''}"></form>` : ''}
        ${u ? html`<details class="usermenu">
          <summary>${avatar(u)}
            <span class="who"><b>${u.name || u.email}</b><small>${ROLE_LABELS[u.system_role] || u.system_role}</small></span></summary>
          <div class="menu">
            <a href="/account">Account &amp; security</a>
            ${u.system_role === 'super_admin' ? html`<a href="/admin">Administration</a>` : ''}
            <form method="post" action="/logout">${csrfField(req)}<button type="submit">Sign out</button></form>
          </div></details>` : ''}
      </div>
      ${heading ? html`<div class="wrap band-head">
        ${crumbs.length ? html`<nav class="crumbs" aria-label="Breadcrumb">${crumbs.map((c, i) => html`${i ? ' › ' : ''}${c[1] ? html`<a href="${c[1]}">${c[0]}</a>` : html`<span>${c[0]}</span>`}`)}</nav>` : ''}
        <div class="band-title"><div class="grow">${sub && sub.above ? html`<div class="eyebrow">${sub.above}</div>` : ''}<h1>${heading}</h1>${sub && sub.below ? html`<div class="band-meta">${sub.below}</div>` : ''}</div>${actions || ''}</div>
        ${tabs ? html`<nav class="tabs" aria-label="Sections">${tabs.map(([label, href, on]) => html`<a href="${href}" ${on ? raw('aria-current="page"') : ''}>${label}</a>`)}</nav>` : ''}
      </div>` : ''}
    </header>`;
  return '<!doctype html>' + html`<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title ? `${title} · ` : ''}SarayDar Management System</title>
<link rel="stylesheet" href="/static/app.css"><script src="/static/app.js" defer></script></head>
<body>${header}<main class="wrap main">${msg ? html`<div class="flash" role="status">${msg}</div>` : ''}${body}</main></body></html>`;
}

const emptyState = (title, text, action = '') => html`<div class="empty"><strong>${title}</strong><p>${text}</p>${action}</div>`;

function field({ name, label, type = 'text', value = '', required = false, hint = '', attrs = '', options = null, full = false }) {
  const id = `f-${name}`;
  const ctl = options
    ? html`<select id="${id}" name="${name}" ${required ? raw('required') : ''} ${raw(attrs)}>${options.map(([v, l]) => html`<option value="${v}" ${String(v) === String(value) ? raw('selected') : ''}>${l}</option>`)}</select>`
    : type === 'textarea'
      ? html`<textarea id="${id}" name="${name}" ${required ? raw('required') : ''} ${raw(attrs)}>${value}</textarea>`
      : html`<input id="${id}" name="${name}" type="${type}" value="${value}" ${required ? raw('required') : ''} ${raw(attrs)}>`;
  return html`<label class="field${full ? ' full' : ''}" for="${id}"><span>${label}${required ? html` <i class="req" aria-hidden="true">*</i>` : ''}</span>${ctl}${hint ? html`<small>${hint}</small>` : ''}</label>`;
}

function pager(req, total, page, per) {
  const pages = Math.max(1, Math.ceil(total / per));
  if (pages <= 1) return '';
  const link = p => { const q = new URLSearchParams(req.query); q.set('page', p); q.delete('msg'); return `?${q}`; };
  return html`<nav class="pager" aria-label="Pages">${page > 1 ? html`<a class="btn" href="${link(page - 1)}">Previous</a>` : ''}<span>Page ${page} of ${pages} · ${total} total</span>${page < pages ? html`<a class="btn" href="${link(page + 1)}">Next</a>` : ''}</nav>`;
}

module.exports = { avatar, layout, html, raw, pill, statusPill, csrfField, emptyState, field, pager, icons, fmtDate, fmtDateTime, fmtSize, ROLE_LABELS, MESSAGES };
