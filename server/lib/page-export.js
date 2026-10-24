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
  const title = clean((root.querySelector('.band-title h1') || root.querySelector('main h1') || root.querySelector('title') || { text: 'SarayDar' }).text);
  const eyebrow = clean((root.querySelector('.band-title .eyebrow') || { text: '' }).text);
  const meta = clean((root.querySelector('.band-title .band-meta') || { text: '' }).text);
  const crumbs = clean((root.querySelector('.crumbs') || { text: '' }).text).replace(/\s*›\s*/g, ' › ');
  const tab = clean((root.querySelector('.tabs a[aria-current="page"]') || { text: '' }).text);
  const main = root.querySelector('main');
  const blocks = [];
  if (!main) return { title, eyebrow, meta, crumbs, tab, blocks };
  main.querySelectorAll(DROP).forEach(n => n.remove());
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
function typed(v) {
  const s = String(v ?? '').trim();
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
  for (const [k, v] of [['Page', page.tab || page.title], ['Location in the system', page.crumbs], ['Reference', page.eyebrow], ['Details', page.meta], ['Exported by', user], ['Exported at', when.toLocaleString('en-GB', { timeZone: 'Asia/Bahrain' }) + ' (Bahrain time)']]) if (v) addRow(sum, [k, v]);
  sum.addRow([]);
  let heading = page.tab || page.title;
  for (const b of page.blocks) {
    if (b.kind === 'heading') { heading = b.text; addRow(sum, [b.text], true); continue; }
    if (b.kind === 'kv') { for (const [k, v] of b.pairs) addRow(sum, [k, v]); continue; }
    if (b.kind === 'list') { for (const it of b.items) addRow(sum, ['', it]); continue; }
    if (b.kind === 'name') { const r = addRow(sum, ['', b.text]); if (r && r.getCell) r.getCell(2).font = { bold: true, size: 13 }; continue; }
    if (b.kind === 'text') { addRow(sum, ['', b.text]); continue; }
    if (b.kind === 'table') {
      const ws = wb.addWorksheet(sheetName(heading));
      addRow(sum, ['Table', `see sheet “${ws.name}”`]);
      const cols = Math.max(b.head ? b.head.length : 0, ...b.rows.map(r => r.length));
      ws.columns = Array.from({ length: cols }, (_, i) => ({ width: Math.min(60, Math.max(10, ...[(b.head || [])[i] || '', ...b.rows.map(r => r[i] || '')].map(x => String(x).split('\n')[0].length + 2))) }));
      if (b.head) { addRow(ws, b.head, true); ws.views = [{ state: 'frozen', ySplit: 1 }]; }
      for (const r of b.rows) addRow(ws, r);
    }
  }
  return wb.xlsx.writeBuffer();
}

function toPdf(page, { user, when }) {
  return new Promise((resolve, reject) => {
    const wide = page.blocks.some(b => b.kind === 'table' && Math.max(b.head ? b.head.length : 0, ...b.rows.map(r => r.length)) > 6);
    const doc = new PDFDocument({ size: 'A4', layout: wide ? 'landscape' : 'portrait', margin: 40, bufferPages: true, info: { Title: page.title, Author: 'SarayDar Management System' } });
    const chunks = []; doc.on('data', c => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    doc.registerFont('body', path.join(FONT_DIR, 'ibm-plex-sans-latin-400-normal.ttf'));
    doc.registerFont('bold', path.join(FONT_DIR, 'ibm-plex-sans-latin-600-normal.ttf'));
    doc.registerFont('display', path.join(FONT_DIR, 'ibm-plex-sans-latin-600-normal.ttf'));
    const INK = '#2A1C15', MUTED = '#6E5B50', ACC = '#8E4F2B', LINE = '#E0D2C6';
    const W = doc.page.width - 80, X = 40, bottom = () => doc.page.height - 50;
    const ensure = h => { if (doc.y + h > bottom()) doc.addPage(); };
    const plain = s => String(s).replace(/[^\u0000-ɏ‐-‧‰-⁞€™²³×]/g, '');   // fonts are Latin
    // the same dark heading as every SarayDar document: the page (type) on the right with the record under it
    // type = the tab (or the page) exported; under it the record's reference and name
    const lastCrumb = String(page.crumbs || '').split(' › ').filter(Boolean).pop();
    const type = page.tab && page.tab !== page.title ? page.tab : lastCrumb && lastCrumb !== page.title ? lastCrumb : 'Summary';
    const ref = [page.eyebrow ? page.eyebrow.split(' · ')[0] : '', /^Good (morning|afternoon|evening)/.test(page.title) ? '' : page.title].filter(Boolean).join(' · ');
    brand.band(doc, { title: plain(type), sub: plain(page.crumbs || ''), right: ref ? [[plain(ref), { bold: true, size: 11 }]] : [], x: X, width: W });
    doc.y = 116; doc.x = X;
    doc.font('body').fontSize(8).fillColor(MUTED).text(plain(`${[page.eyebrow, page.meta].filter(Boolean).join(' · ')}${page.eyebrow || page.meta ? '\n' : ''}Exported ${when.toLocaleString('en-GB', { timeZone: 'Asia/Bahrain' })} (Bahrain time) by ${user}. Contents match what this user could see on the page.`), { width: W });
    doc.moveDown(0.6);
    for (const b of page.blocks) {
      if (b.kind === 'heading') { ensure(40); doc.moveDown(0.4).font('display').fontSize(b.level <= 2 ? 13.5 : 11.5).fillColor(ACC).text(plain(b.text), X, doc.y, { width: W }).moveDown(0.25); continue; }
      if (b.kind === 'name') { ensure(26); doc.font('bold').fontSize(14).fillColor(INK).text(plain(b.text), X, doc.y, { width: W }).moveDown(0.35); continue; }
      if (b.kind === 'text') { ensure(20); doc.font('body').fontSize(9).fillColor(MUTED).text(plain(b.text), X, doc.y, { width: W }).moveDown(0.3); continue; }
      if (b.kind === 'list') { for (const it of b.items) { ensure(16); doc.font('body').fontSize(9).fillColor(INK).text(plain(`•  ${it.replace(/\n/g, ' · ')}`), X, doc.y, { width: W }).moveDown(0.15); } doc.moveDown(0.3); continue; }
      if (b.kind === 'kv') {
        for (const [k, v] of b.pairs) {
          const h = Math.max(doc.font('body').fontSize(9).heightOfString(plain(v) || '—', { width: W * 0.62 }), 12) + 4;
          ensure(h);
          const y = doc.y;
          doc.font('body').fontSize(9).fillColor(MUTED).text(plain(k), X, y, { width: W * 0.36 });
          doc.font('body').fontSize(9).fillColor(INK).text(plain(v) || '—', X + W * 0.38, y, { width: W * 0.62 });
          doc.y = y + h; doc.moveTo(X, doc.y - 2).lineTo(X + W, doc.y - 2).strokeColor('#EDE3DA').stroke();
        }
        doc.moveDown(0.4); continue;
      }
      if (b.kind === 'table') {
        const cols = Math.max(b.head ? b.head.length : 0, ...b.rows.map(r => r.length));
        const lens = Array.from({ length: cols }, (_, i) => Math.min(40, Math.max(4, ...[(b.head || [])[i] || '', ...b.rows.map(r => r[i] || '')].map(x => String(x).split('\n')[0].length))));
        const tot = lens.reduce((s, x) => s + x, 0);
        const widths = lens.map(l => W * l / tot);
        const fs = cols > 8 ? 7 : 8;
        const isNum = i => b.rows.length && b.rows.every(r => !r[i] || /^(BHD |USD |-)?[\d,.]+%?( m²)?$/.test(r[i]) || r[i] === '—');
        const drawRow = (cells, opts = {}) => {
          const h = Math.max(...cells.map((c, i) => doc.font(opts.bold ? 'bold' : 'body').fontSize(fs).heightOfString(plain(c || ''), { width: widths[i] - 6 }))) + 6;
          if (doc.y + h > bottom()) { doc.addPage(); if (b.head && !opts.bold) drawRow(b.head, { bold: true, head: true }); }
          const y = doc.y; let x = X;
          if (opts.head) doc.rect(X, y - 1, W, h).fill('#F3ECE5');
          cells.forEach((c, i) => { doc.font(opts.bold ? 'bold' : 'body').fontSize(fs).fillColor(opts.head ? MUTED : INK).text(plain(c || ''), x + 3, y + 2, { width: widths[i] - 6, align: !opts.head && isNum(i) ? 'right' : 'left' }); x += widths[i]; });
          doc.y = y + h; doc.moveTo(X, doc.y).lineTo(X + W, doc.y).strokeColor(opts.head ? LINE : '#EDE3DA').stroke();
        };
        ensure(40);
        if (b.head) drawRow(b.head, { bold: true, head: true });
        for (const r of b.rows) drawRow(Array.from({ length: cols }, (_, i) => r[i] || ''));
        doc.x = X; doc.moveDown(0.6);
      }
    }
    brand.footer(doc, { lines: [plain(`SarayDar Management System · ${page.title}`), plain(`Exported ${when.toLocaleString('en-GB', { timeZone: 'Asia/Bahrain' })} (Bahrain time) by ${user} · saraydar.com`)] });
    doc.end();
  });
}

const fileBase = page => (page.eyebrow.split(' · ')[0] || page.title).concat(page.tab && page.tab !== page.title ? `-${page.tab}` : '').replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'saraydar-export';

// download name: reference - name - page, e.g. "CPM-2026-001 - SAMAVILLA - Tasks & Schedule - 2026-10-24"
const nameParts = page => { const ref = page.eyebrow.split(' · ')[0]; const title = /^Good (morning|afternoon|evening)/.test(page.title) ? 'SarayDar Home' : page.title; return [ref, title, page.tab && page.tab !== page.title ? page.tab : null, require('./download').today()]; };
module.exports = { extract, toXlsx, toPdf, typed, safe, fileBase, nameParts };
