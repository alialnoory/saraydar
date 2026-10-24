'use strict';
// Download names (owner request 2026-10-24): "Reference - Project or property name - version", e.g.
// "AGR-2026-002 - SAMAVILLA - v2.pdf". Characters that file systems reject are removed.
const clean = s => String(s == null ? '' : s).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim();
const fileName = (parts, ext) => `${parts.map(clean).filter(Boolean).join(' - ').slice(0, 150) || 'SarayDar'}.${ext}`;
// Content-Disposition with a plain-ASCII fallback and the full (Arabic-safe) name
const disposition = (name, inline = false) => `${inline ? 'inline' : 'attachment'}; filename="${name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(name)}`;
// Links that open a file in the browser carry its name as the last part of the address ("/~/<name>"), because some
// browsers (Safari on iPhone) save a viewed file under the address's last part; the router never sees that part.
const pretty = name => `/~/${encodeURIComponent(name)}`;
function stripPretty(req, res, next) {
  const q = req.url.indexOf('?'), path = q < 0 ? req.url : req.url.slice(0, q), rest = q < 0 ? '' : req.url.slice(q);
  if (path.includes('/~/')) req.url = `${path.replace(/\/~\/[^/]*$/, '') || '/'}${rest}`;     // only the address, never the query
  next();
}
const today = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
module.exports = { fileName, disposition, pretty, stripPretty, today, clean };
