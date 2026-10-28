'use strict';
// Turns any rendered portal page into a PDF or an Excel workbook.
// It works from the HTML the signed-in user would see, so exports can never contain more than the page shows.
// Forms, buttons, navigation and scripts are dropped; headings, key/value details, figures, lists and tables are kept.
const path = require('path');
const brand = require('./pdf-brand');
const { parse } = require('node-html-parser');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');

const FONT_DIR = path.join(__dirname, '..', 'fonts');
const DROP = 'form, button, nav, script, style, select, input, textarea, details.inline-form, .actions, .filters, .pager, .flash, .steps-nav, .subtabs, svg, .menu, [hidden], .no-export';
const clean = s => String(s || '').replace(/ /g, ' ').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
const cellText = el => clean(el.structuredText !== undefined ? el.structuredText : el.text);
// Spreadsheet formula injection: text starting with = + - @ or control characters is kept as literal text.
const safe = v => typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;

// Reads the page into ordered blocks: { kind: 'title'|'heading'|'kv'|'table'|'list'|'text', ... }
function extract(htmlString) {
  const root = parse(htmlString, { blockTextElements: { script: false, style: false, pre: true } });
  const pick = (...sels) => { for (const q of sels) { const n = root.querySelector(q); if (n && clean(n.text)) return clean(n.text); } return ''; };
  const title = pick('.mtitle h1', '.band-title h1', 'main h1', 'title') || 'SarayDar';
  const eyebrow = pick('.meyebrow', '.band-title .eyebrow');
  const chipsEl = root.querySelector('.mtitle .mchips');
  const meta = chipsEl ? chipsEl.childNodes.map(x => clean(x.text)).filter(Boolean).join(' · ') : pick('.band-title .band-meta').replace(/\s{2,}/g, ' · ');
  const crumbs = (() => { const m = root.querySelector('.mcrumb'); if (m) return m.querySelectorAll('a:not(.mback), span:not([aria-hidden])').map(x => clean(x.text)).filter(Boolean).join(' › '); return clean((root.querySelector('.crumbs') || { text: '' }).text).replace(/\s*›\s*/g, ' › '); })();
  const tab = pick('.pdf-tab', '.mgroups a[aria-current="page"]', '.tabs a[aria-current="page"]');
  const main = root.querySelector('main');
  const blocks = [];
  if (!main) return { title, eyebrow, meta, crumbs, tab, blocks };
  main.querySelectorAll(DROP).forEach(n => n.remove());
  const esc = x => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  main.querySelectorAll('.mp-pipe li').forEach(li => {
    const name = clean((li.querySelector('.jr-label') || { text: '' }).text), st = clean((li.querySelector('.sr-only') || { text: '' }).text), v = clean((li.querySelector('.mp-ring b') || { text: '' }).text);
    li.set_content(esc(`\u27EA${st || '—'}\u27EB ${name} — ${v === '✓' ? '100%' : v}`));
  });
  main.querySelectorAll('.pill').forEach(n => { const t = clean(n.text); n.set_content(t ? ` \u27EA${t}\u27EB ` : ''); });
  // sections that only held a form leave just their heading behind: drop them
  main.querySelectorAll('section, .panel').forEach(sec => {
    const hs = sec.querySelectorAll('h1,h2,h3').map(h => clean(h.text)).join(' ');
    if (clean(sec.text) === clean(hs)) sec.remove();
  });

  const walk = node => {
    for (const el of node.childNodes) {
      if (el.nodeType !== 1) continue;
      const tag = el.tagName.toLowerCase();
      const cls = el.classList ? [...el.classList.values()] : [];
      if (/^h[1-3]$/.test(tag)) { const t = cellText(el); if (t) blocks.push({ kind: 'heading', text: t, level: Number(tag[1]) }); continue; }
      if (tag === 'table') {
        const rows = el.querySelectorAll('tr').map(tr => tr.querySelectorAll('th,td').map(c => ({ text: cellText(c), head: c.tagName.toLowerCase() === 'th' && tr.parentNode.tagName.toLowerCase() === 'thead' })));
        const head = rows.find(r => r.length && r.every(c => c.head));
        const body = rows.filter(r => r !== head && r.some(c => c.text));
        if (head || body.length) blocks.push({ kind: 'table', head: head ? head.map(c => c.text) : null, rows: body.map(r => r.map(c => c.text)) });
        continue;
      }
      if (tag === 'dl') {
        const pairs = [];
        for (const item of el.querySelectorAll('dt')) { const dd = item.nextElementSibling; pairs.push([cellText(item), dd ? cellText(dd) : '']); }
        if (pairs.length) blocks.push({ kind: 'kv', pairs });
        continue;
      }
      if ((tag === 'ul' || tag === 'ol') && !cls.includes('gallery')) {
        const items = el.querySelectorAll(':scope > li').map(cellText).filter(Boolean);
        if (items.length) blocks.push({ kind: 'list', items });
        continue;
      }
      if (cls.includes('card') && !el.querySelector('table, dl, h2')) {
        const label = cellText(el.querySelector('.muted') || { text: '' });
        const rest = cellText(el).replace(label, '').trim();
        if (label || rest) blocks.push({ kind: 'kv', pairs: [[label, rest]] });
        continue;
      }
      if (cls.includes('gallery')) { const n = el.querySelectorAll('img').length; if (n) blocks.push({ kind: 'text', text: `${n} photo(s) — view them in the portal.` }); continue; }
      if (cls.includes('client-name')) { const t = cellText(el); if (t) blocks.push({ kind: 'name', text: t }); continue; }   // a client's or owner's name: large and bold
      if (tag === 'p' || cls.includes('empty') || cls.includes('notice')) { const t = cellText(el); if (t) blocks.push({ kind: 'text', text: t }); continue; }
      if (el.childNodes.length) walk(el);
    }
  };
  walk(main);
  // merge consecutive single-pair kv blocks (indicator cards) into one
  const merged = [];
  for (const b of blocks) {
    const last = merged[merged.length - 1];
    if (b.kind === 'kv' && last && last.kind === 'kv' && b.pairs.length === 1 && last.single) last.pairs.push(...b.pairs);
    else merged.push(b.kind === 'kv' && b.pairs.length === 1 ? { ...b, single: true } : b);
  }
  return { title, eyebrow, meta, crumbs, tab, blocks: merged };
}

// "BHD 1,234.500" → 1234.5 with a BHD format; "45%" → 0.45; plain numbers → numbers; everything else stays text.
const untag = v => String(v ?? '').replace(/\u27EA(.*?)\u27EB/g, ' $1 ').replace(/[ \t]{2,}/g, ' ').trim();
function typed(v) {
  const s = untag(v);
  let m;
  if ((m = /^(BHD|USD|EUR|SAR|AED|KWD|OMR|GBP) (-?[\d,]+(?:\.\d+)?)$/.exec(s))) return { v: Number(m[2].replace(/,/g, '')), fmt: m[1] === 'BHD' || m[1] === 'KWD' || m[1] === 'OMR' ? `"${m[1]}" #,##0.000` : `"${m[1]}" #,##0.00` };
  if ((m = /^(-?\d+(?:\.\d+)?)%$/.exec(s))) return { v: Number(m[1]) / 100, fmt: '0.0%' };
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s) || /^-?\d+(\.\d+)?$/.test(s) && s.length < 16 && !/^0\d/.test(s)) return { v: Number(s.replace(/,/g, '')), fmt: s.includes('.') ? '#,##0.000' : '#,##0' };
  return { v: safe(s) };
}

async function toXlsx(page, { user, when }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'SarayDar Management System'; wb.created = when;
  const used = new Set();
  const sheetName = base => {
    let n = String(base || 'Table').replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 28) || 'Table'; let k = n, i = 2;
    while (used.has(k.toLowerCase())) k = `${n.slice(0, 26)} ${i++}`;
    used.add(k.toLowerCase()); return k;
  };
  const sum = wb.addWorksheet(sheetName('Summary'));
  sum.columns = [{ width: 34 }, { width: 70 }];
  const addRow = (ws, vals, bold) => { const row = ws.addRow(vals.map(v => typed(v).v)); vals.forEach((v, i) => { const t = typed(v); if (t.fmt) row.getCell(i + 1).numFmt = t.fmt; row.getCell(i + 1).alignment = { wrapText: true, vertical: 'top' }; }); if (bold) row.font = { bold: true }; return row; };
  addRow(sum, ['SarayDar Management System', page.title], true);
  for (const [k, v] of [['Page', page.tab || page.title], ['Location in the system', page.crumbs], ['Reference', page.eyebrow], ['Details', page.meta], ['Exported by', user], ['Exported at', when.toLocaleString('en-GB', { timeZone: 'Asia/Bahrain' }) + '']]) if (v) addRow(sum, [k, v]);
  sum.addRow([]);
  let heading = page.tab || page.title;
  for (const b of page.blocks) {
    if (b.kind === 'heading') { heading = b.text; addRow(sum, [b.text], true); continue; }
    if (b.kind === 'kv') { for (const [k, v] of b.pairs) addRow(sum, [untag(k), untag(v)]); continue; }
    if (b.kind === 'list') { for (const it of b.items) addRow(sum, ["", untag(it)]); continue; }
    if (b.kind === 'name') { const r = addRow(sum, ['', b.text]); if (r && r.getCell) r.getCell(2).font = { bold: true, size: 13 }; continue; }
    if (b.kind === 'text') { addRow(sum, ["", untag(b.text)]); continue; }
    if (b.kind === 'table') {
      const ws = wb.addWorksheet(sheetName(heading));
      addRow(sum, ['Table', `see sheet “${ws.name}”`]);
      const cols = Math.max(b.head ? b.head.length : 0, ...b.rows.map(r => r.length));
      ws.columns = Array.from({ length: cols }, (_, i) => ({ width: Math.min(60, Math.max(10, ...[(b.head || [])[i] || '', ...b.rows.map(r => r[i] || '')].map(x => String(x).split('\n')[0].length + 2))) }));
      if (b.head) { addRow(ws, b.head, true); ws.views = [{ state: 'frozen', ySplit: 1 }]; }
      for (const r of b.rows) addRow(ws, r);
    }
  }
  return wholeAmounts(wb).xlsx.writeBuffer();
}

// The PDF of a page, in the SarayDar report style (owner request 2026-10-28: "all the reports should look modern and
// professional"): the dark band, a title block, indicator tiles, panels of details, tables with a tinted header,
// zebra rows, status tags and progress bars, copper section markers, and the dark footer.
const TONES = {
  ok: ['#E3EFE6', '#24573A'], warn: ['#F6EBD6', '#7A4F0C'], bad: ['#F6E1DE', '#8F2E26'], info: ['#E2EBF2', '#2C506B'], muted: ['#ECE9E6', '#5F5650']
};
const toneOf = t => {
  const s = String(t).toLowerCase();
  if (/^(completed?|done|active|approved|paid|signed|published|obtained|verified|delivered|closed|issued|ok|on track|available|reviewed|selected|won|valid|confirmed|record complete)/.test(s)) return 'ok';
  if (/(overdue|rejected|blocks|late|past due|on hold|cancel|failed|bad|lost|expired|withdrawn|void|fell through|high)/.test(s)) return 'bad';
  if (/(progress|draft|pending|check|requested|proposed|shared|partly|unverified|suggested|planned|tentative|open|waiting|medium)/.test(s)) return 'warn';
  if (/(note|info|milestone|new)/.test(s)) return 'info';
  return 'muted';
};
const TAG = /⟪(.*?)⟫/g;

function toPdf(page, { user, when }) {
  return new Promise((resolve, reject) => {
    const wide = page.blocks.some(b => b.kind === 'table' && Math.max(b.head ? b.head.length : 0, ...b.rows.map(r => r.length)) > 6);
    const doc = new PDFDocument({ size: 'A4', layout: wide ? 'landscape' : 'portrait', margin: 40, bufferPages: true, info: { Title: page.title, Author: 'SarayDar Management System' } });
    const chunks = []; doc.on('data', c => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    doc.registerFont('body', path.join(FONT_DIR, 'ibm-plex-sans-latin-400-normal.ttf'));
    doc.registerFont('medium', path.join(FONT_DIR, 'ibm-plex-sans-latin-500-normal.ttf'));
    doc.registerFont('bold', path.join(FONT_DIR, 'ibm-plex-sans-latin-600-normal.ttf'));
    doc.registerFont('display', path.join(FONT_DIR, 'ibm-plex-sans-latin-600-normal.ttf'));
    const INK = '#2A1C15', MUTED = '#6E5B50', ACC = '#8E4F2B', COPPER = '#D29466', LINE = '#E6D9CD', HEAD = '#F3ECE5', ZEBRA = '#FBF8F5', TILE = '#FBF7F3';
    const X = 40, W = doc.page.width - 80, bottom = () => doc.page.height - 58;
    const ensure = h => { if (doc.y + h > bottom()) { doc.addPage(); doc.y = 40; } };
    const plain = s => String(s ?? '').replace(TAG, ' $1 ').replace(/[^\u0000-ɏ‐-‧‰-⁞€™²³×✓]/g, '').replace(/[ \t]{2,}/g, ' ').trim();
    const tagsOf = s => { const out = []; String(s ?? '').replace(TAG, (_, t) => { out.push(t); return ''; }); return out; };
    const noTags = s => plain(String(s ?? '').replace(TAG, ''));
    const tag = (t, x, y, size = 7.5) => {
      const [bg, fg] = TONES[toneOf(t)];
      doc.font('bold').fontSize(size); const w = doc.widthOfString(plain(t)) + 12, h = size + 6;
      doc.save().roundedRect(x, y, w, h, h / 2).fill(bg).restore();
      doc.fillColor(fg).text(plain(t), x + 6, y + 2.6, { lineBreak: false });
      return w;
    };

    // ---- band and title block ----
    const lastCrumb = String(page.crumbs || '').split(' › ').filter(Boolean).pop();
    const type = page.tab && page.tab !== page.title ? page.tab : lastCrumb && lastCrumb !== page.title ? lastCrumb : /^Good (morning|afternoon|evening)/.test(page.title) ? 'Home' : 'Report';
    const refNo = page.eyebrow ? page.eyebrow.split(' · ')[0] : '';
    const home = /^Good (morning|afternoon|evening)/.test(page.title);
    brand.band(doc, { title: plain(type), sub: plain(page.crumbs || ''), right: home ? [] : [[plain([refNo, page.title].filter(Boolean).join(' · ')), { bold: true, size: 11 }]], x: X, width: W });
    let y = 122;
    doc.font('display').fontSize(20).fillColor(INK).text(plain(page.title), X, y, { width: W * 0.72 });
    y = doc.y + 2;
    const sub = [page.eyebrow, page.meta].filter(Boolean).map(plain).join('  ·  ');
    if (sub) { doc.font('body').fontSize(9).fillColor(MUTED).text(sub, X, y, { width: W * 0.72 }); y = doc.y; }
    doc.font('body').fontSize(7.5).fillColor(MUTED).text(plain(`Exported ${when.toLocaleString('en-GB', { timeZone: 'Asia/Bahrain', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}\nby ${user}`), X + W * 0.72, 126, { width: W * 0.28, align: 'right' });
    doc.save().moveTo(X, Math.max(y, doc.y) + 10).lineTo(X + W, Math.max(y, doc.y) + 10).lineWidth(0.8).strokeColor(LINE).stroke().restore();
    doc.y = Math.max(y, doc.y) + 22; doc.x = X;

    // ---- blocks ----
    for (let bi = 0; bi < page.blocks.length; bi++) {
      const b = page.blocks[bi];
      if (b.kind === 'heading') {
        const nx = page.blocks[bi + 1];
        if (!nx || (nx.kind === 'heading' && nx.level <= b.level)) continue;   // a heading with nothing under it
        ensure(46);
        if (b.level <= 2) {
          doc.y += 6;
          const hy = doc.y;
          doc.save().roundedRect(X, hy + 3, 4, 13, 2).fill(COPPER).restore();
          doc.font('display').fontSize(13).fillColor(INK).text(plain(b.text), X + 12, hy, { width: W - 12 });
          doc.y += 6;
        } else { doc.y += 2; doc.font('bold').fontSize(10).fillColor(ACC).text(plain(b.text).toUpperCase(), X, doc.y, { width: W, characterSpacing: 0.5 }); doc.y += 4; }
        continue;
      }
      if (b.kind === 'name') { ensure(28); doc.font('display').fontSize(15).fillColor(INK).text(plain(b.text), X, doc.y, { width: W }); doc.y += 6; continue; }
      if (b.kind === 'text') {
        const ts = tagsOf(b.text), t = noTags(b.text).replace(/^[·•|\-–\s]+|[·•|\-–\s]+$/g, '');
        if (!ts.length && !t) continue;
        ensure(18);
        let tx = X; const ty = doc.y;
        for (const g of ts) tx += tag(g, tx, ty) + 5;
        if (t) doc.font('body').fontSize(9).fillColor(MUTED).text(t, tx === X ? X : tx + 2, ty + (ts.length ? 1 : 0), { width: W - (tx - X) - 2 });
        doc.y = Math.max(doc.y, ty + (ts.length ? 15 : 0)) + 5; continue;
      }
      if (b.kind === 'list') {
        for (const it of b.items) {
          const ts = tagsOf(it), t = noTags(it).replace(/\n/g, ' · ');
          const h = Math.max(14, doc.font('body').fontSize(9).heightOfString(t || ' ', { width: W - 16 - ts.length * 70 }) + 4);
          ensure(h);
          const ly = doc.y;
          doc.save().circle(X + 4, ly + 6, 2.2).fill(COPPER).restore();
          let tx = X + 14;
          for (const g of ts) tx += tag(g, tx, ly) + 5;
          doc.font('body').fontSize(9).fillColor(INK).text(t, tx + (ts.length ? 2 : 0), ly + (ts.length ? 1.5 : 0), { width: X + W - tx - 2 });
          doc.y = Math.max(doc.y, ly + h) + 3;
        }
        doc.y += 6; continue;
      }
      if (b.kind === 'kv' && b.single && b.pairs.length >= 2 && b.pairs.length <= 8) {
        // indicator cards → tiles
        const max = wide ? 6 : 5, per = b.pairs.length <= max ? b.pairs.length : Math.ceil(b.pairs.length / 2), gap = 10, tw = (W - (per - 1) * gap) / per;
        for (let i = 0; i < b.pairs.length; i += per) {
          const row = b.pairs.slice(i, i + per);
          const kh = Math.max(...row.map(([k]) => doc.font('bold').fontSize(7).heightOfString(plain(k).toUpperCase(), { width: tw - 20, characterSpacing: 0.4 })));
          const two = kh > 10, th = two ? 64 : 56, off = two ? 8 : 0;
          ensure(th + 8);
          const ty = doc.y;
          row.forEach(([k, v], j) => {
            const tx = X + j * (tw + gap);
            doc.save().roundedRect(tx, ty, tw, th, 8).fill(TILE).restore();
            doc.save().roundedRect(tx, ty, tw, th, 8).lineWidth(0.7).strokeColor(LINE).stroke().restore();
            doc.font('bold').fontSize(7).fillColor(MUTED).text(plain(k).toUpperCase(), tx + 10, ty + 9, { width: tw - 20, height: two ? 18 : 9, ellipsis: true, characterSpacing: 0.4 });
            const lines = noTags(v).split('\n').filter(Boolean);
            doc.font('display').fontSize(13).fillColor(INK).text(lines[0] || '—', tx + 10, ty + 21 + off, { width: tw - 20, height: 17, ellipsis: true });
            if (lines.length > 1) doc.font('body').fontSize(7.5).fillColor(MUTED).text(lines.slice(1).join(' · '), tx + 10, ty + 39 + off, { width: tw - 20, height: 10, ellipsis: true });
          });
          doc.y = ty + th + 10;
        }
        continue;
      }
      if (b.kind === 'kv') {
        // details: a light panel of label / value rows
        const rows = b.pairs.map(([k, v]) => [plain(k), v]);
        const hOf = v => Math.max(doc.font('body').fontSize(9).heightOfString(noTags(v) || '—', { width: W * 0.6 - 16 }), 11) + 9;
        let i = 0;
        while (i < rows.length) {
          ensure(hOf(rows[i][1]) + 10);
          let n = 0, hh = 0; const room = bottom() - doc.y - 8;
          while (i + n < rows.length && hh + hOf(rows[i + n][1]) <= room) { hh += hOf(rows[i + n][1]); n++; }
          if (!n) { n = 1; hh = hOf(rows[i][1]); }
          const py = doc.y;
          doc.save().roundedRect(X, py, W, hh + 8, 8).fill(TILE).restore();
          doc.save().roundedRect(X, py, W, hh + 8, 8).lineWidth(0.7).strokeColor(LINE).stroke().restore();
          let ry = py + 4;
          rows.slice(i, i + n).forEach(([k, v], j) => {
            const h = hOf(v);
            if (j) doc.save().moveTo(X + 12, ry).lineTo(X + W - 12, ry).lineWidth(0.5).strokeColor('#EEE4DA').stroke().restore();
            doc.font('body').fontSize(8.5).fillColor(MUTED).text(k, X + 12, ry + 4.5, { width: W * 0.36 });
            const ts = tagsOf(v); let vx = X + W * 0.4;
            for (const g of ts) vx += tag(g, vx, ry + 3.5) + 5;
            const t = noTags(v);
            if (t || !ts.length) doc.font('medium').fontSize(9).fillColor(INK).text(t || '—', vx, ry + 4.5, { width: X + W - 12 - vx });
            ry += h;
          });
          doc.y = py + hh + 16; i += n;
        }
        continue;
      }
      if (b.kind === 'table') {
        const cols = Math.max(b.head ? b.head.length : 0, ...b.rows.map(r => r.length));
        const head = b.head || [];
        const isNum = i => b.rows.some(r => /\d/.test(noTags(r[i] || ''))) && b.rows.every(r => !r[i] || /^(BHD |USD |-)?[\d,.]+%?( m²)?$/.test(noTags(r[i])) || /^[—–-]$/.test(noTags(r[i])));
        const isPct = i => /%|progress|complete/i.test(head[i] || '') && b.rows.some(r => /^\d+(\.\d+)?%?$/.test(noTags(r[i] || '')));
        const lens = Array.from({ length: cols }, (_, i) => isPct(i) ? 16 : Math.min(40, Math.max(5, Math.max(0, ...String(head[i] || '').split(/\s+/).map(w => w.length)) + 2, ...b.rows.map(r => r[i] || '').map(x => Math.max(...noTags(x).split('\n').map(l => l.length)) + tagsOf(x).reduce((n, g) => n + g.length + 4, 0)))));
        const tot = lens.reduce((s2, x) => s2 + x, 0);
        const widths = lens.map(l => W * l / tot);
        const fs = cols > 8 ? 7 : 8;
        const pad = 6;
        const drawHead = () => {
          if (!b.head) return;
          const h = Math.max(...head.map((c, i) => doc.font('bold').fontSize(7).heightOfString(plain(c).toUpperCase(), { width: widths[i] - 2 * pad }))) + 10;
          const hy = doc.y;
          doc.save().roundedRect(X, hy, W, h, 6).fill(HEAD).restore();
          let x = X;
          head.forEach((c, i) => { doc.font('bold').fontSize(7).fillColor(MUTED).text(plain(c).toUpperCase(), x + pad, hy + 5, { width: widths[i] - 2 * pad, align: isNum(i) && !isPct(i) ? 'right' : 'left', characterSpacing: 0.3 }); x += widths[i]; });
          doc.y = hy + h;
        };
        const cellH = (c, i) => isPct(i) ? 12 : tagsOf(c).length && !noTags(c) ? 12 : doc.font('body').fontSize(fs).heightOfString(noTags(c) || ' ', { width: widths[i] - 2 * pad - tagsOf(c).length * 40 });
        ensure(48);
        drawHead();
        b.rows.forEach((r, ri) => {
          const cells = Array.from({ length: cols }, (_, i) => r[i] || '');
          const h = Math.max(...cells.map(cellH)) + 9;
          if (doc.y + h > bottom()) { doc.addPage(); doc.y = 40; drawHead(); }
          const ry = doc.y;
          if (ri % 2) doc.save().rect(X, ry, W, h).fill(ZEBRA).restore();
          let x = X;
          cells.forEach((c, i) => {
            const ts = tagsOf(c), t = noTags(c), cw = widths[i] - 2 * pad;
            if (isPct(i) && /^\d+(\.\d+)?%?$/.test(t)) {
              const v = Math.max(0, Math.min(100, parseFloat(t))), bw = Math.max(20, cw - 30);
              doc.save().roundedRect(x + pad, ry + h / 2 - 2.5, bw, 5, 2.5).fill('#E9DFD6').restore();
              if (v > 0) doc.save().roundedRect(x + pad, ry + h / 2 - 2.5, Math.max(5, bw * v / 100), 5, 2.5).fill(v >= 100 ? '#2F7D4F' : COPPER).restore();
              doc.font('bold').fontSize(fs).fillColor(v >= 100 ? '#2F7D4F' : INK).text(`${Math.round(v * 10) / 10}%`, x + pad + bw + 3, ry + h / 2 - fs / 2 - 1, { width: cw - bw - 3, align: 'right', lineBreak: false });
            } else {
              let tx = x + pad;
              for (const g of ts) tx += tag(g, tx, ry + 4, 7) + 4;
              if (t) doc.font(i === 0 ? 'medium' : 'body').fontSize(fs).fillColor(INK).text(t, tx, ry + 4.5, { width: x + widths[i] - pad - tx, align: !ts.length && isNum(i) ? 'right' : 'left' });
            }
            x += widths[i];
          });
          doc.save().moveTo(X, ry + h).lineTo(X + W, ry + h).lineWidth(0.5).strokeColor('#EEE4DA').stroke().restore();
          doc.y = ry + h;
        });
        doc.x = X; doc.y += 14;
      }
    }
    brand.footer(doc, { lines: [plain(`SarayDar Management System · ${[refNo, page.title].filter(Boolean).join(' · ')}`), plain(`Exported ${when.toLocaleString('en-GB', { timeZone: 'Asia/Bahrain' })} by ${user} · contents match what this user could see · saraydar.com`)] });
    doc.end();
  });
}

const fileBase = page => (page.eyebrow.split(' · ')[0] || page.title).concat(page.tab && page.tab !== page.title ? `-${page.tab}` : '').replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'saraydar-export';

// download name: reference - name - page, e.g. "CPM-2026-001 - SAMAVILLA - Tasks & Schedule - 2026-10-24"
const nameParts = page => { const ref = page.eyebrow.split(' · ')[0]; const title = /^Good (morning|afternoon|evening)/.test(page.title) ? 'SarayDar Home' : page.title; return [ref, title, page.tab && page.tab !== page.title ? page.tab : null, require('./download').today()]; };

// Whole amounts show without decimals ("80,000"); cells with fils keep them.
function wholeAmounts(wb) {
  wb.eachSheet(ws => ws.eachRow(r => r.eachCell(c => { const f = c.numFmt; if (f && f.includes('0.000') && typeof c.value === 'number' && Number.isInteger(c.value)) c.numFmt = f.replace('0.000', '0'); })));
  return wb;
}

module.exports = { wholeAmounts, extract, toXlsx, toPdf, typed, safe, fileBase, nameParts };
