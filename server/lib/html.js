'use strict';
// Safe-by-default HTML templating: every interpolated value is escaped unless wrapped in raw().

class Raw { constructor(s) { this.s = String(s); } toString() { return this.s; } }
const raw = s => new Raw(s);

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escape = v => String(v ?? '').replace(/[&<>"']/g, c => ESC[c]);

function render(v) {
  if (v === null || v === undefined || v === false) return '';
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(render).join('');
  return escape(v);
}

function html(strings, ...values) {
  let out = '';
  strings.forEach((s, i) => { out += s; if (i < values.length) out += render(values[i]); });
  return new Raw(out);
}

module.exports = { html, raw, escape, Raw };
