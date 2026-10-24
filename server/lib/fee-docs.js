'use strict';
// PDF documents for SarayDar's fee ledger: tax invoice / invoice, payment receipt and client statement.
// Every document carries the SarayDar dark heading (lib/pdf-brand.js); company details run along the foot of each page.
const path = require('path');
const PDFDocument = require('pdfkit');
const { formatMoney } = require('./money');
const brand = require('./pdf-brand');

const FONT_DIR = path.join(__dirname, '..', 'fonts');
const INK = '#2A1C15', MUTED = '#6E5B50', LINE = '#D9CCC1', COPPER = '#A8673D';
const mm = v => v * 72 / 25.4;
const d = v => v ? new Date(v).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Bahrain' }) : '—';

function render({ title, number, company = {}, letterhead = null, marginTop = 45, marginBottom = 30, stamp = null, meta = [], to = [], tables = [], totals = [], notes = [], images = [], toLabel = 'TO' }) {
  return new Promise((resolve, reject) => {
    letterhead = null;                                   // the dark heading replaces any letterhead image
    const top = mm(14), bottom = mm(20);
    const doc = new PDFDocument({ size: 'A4', bufferPages: true, margins: { top, bottom, left: mm(18), right: mm(18) }, info: { Title: `${title} ${number || ''}`.trim(), Author: company.trade_name || 'SarayDar' } });
    const chunks = []; doc.on('data', c => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    doc.registerFont('body', path.join(FONT_DIR, 'ibm-plex-sans-latin-400-normal.ttf'));
    doc.registerFont('bold', path.join(FONT_DIR, 'ibm-plex-sans-latin-600-normal.ttf'));
    doc.registerFont('display', path.join(FONT_DIR, 'ibm-plex-sans-latin-600-normal.ttf'));
    doc.registerFont('logo', path.join(FONT_DIR, 'jost-latin-500-normal.ttf'));      // the logo keeps its own typeface
    const bg = () => { if (letterhead) { const { x, y } = doc; doc.image(letterhead, 0, 0, { width: doc.page.width, height: doc.page.height }); doc.x = x; doc.y = y; } };
    bg(); doc.on('pageAdded', bg);
    const L = mm(18), W = doc.page.width - mm(36);
    const room = h => { if (doc.y + h > doc.page.height - bottom) doc.addPage(); };

    // heading: the dark band, with the document title on the left and its number on the right
    brand.band(doc, { title: title.toUpperCase(), sub: [company.legal_name || company.trade_name, company.cr_number ? `C.R. ${company.cr_number}` : null].filter(Boolean).join(' · '),
      right: [[number || 'DRAFT — not issued', { bold: true, size: 11 }], ...(stamp ? [[stamp, { bold: true, size: 10, color: '#F2B8A8' }]] : [])], x: L, width: W });

    // to / meta
    const yTop = doc.y;
    doc.font('bold').fontSize(8).fillColor(MUTED).text(toLabel, L, yTop);
    doc.font('body').fontSize(9.5).fillColor(INK).text(to.filter(Boolean).join('\n'), L, doc.y + 2, { width: W * 0.52 });
    const yLeft = doc.y;
    let ym = yTop;
    for (const [k, v] of meta) {
      doc.font('body').fontSize(8.5).fillColor(MUTED).text(k, L + W * 0.56, ym, { width: W * 0.2 });
      doc.font('bold').fontSize(8.5).fillColor(INK).text(String(v ?? '—'), L + W * 0.76, ym, { width: W * 0.24, align: 'right' });
      ym = Math.max(doc.y, ym + 13);
    }
    doc.y = Math.max(yLeft, ym) + 14;

    // tables: { head: [...], widths: [fractions], align: ['left'|'right'], rows: [[...]], caption }
    for (const t of tables) {
      room(50);
      if (t.caption) { doc.font('bold').fontSize(10).fillColor(INK).text(t.caption, L, doc.y); doc.y += 4; }
      const ws = t.widths.map(f => f * W);
      const drawRow = (cells, font, size, color, fill) => {
        const h = Math.max(...cells.map((c, i) => doc.font(font).fontSize(size).heightOfString(String(c ?? ''), { width: ws[i] - 8 }))) + 8;
        room(h);
        const y = doc.y;
        if (fill) doc.rect(L, y, W, h).fill(fill);
        let x = L;
        cells.forEach((c, i) => { doc.font(font).fontSize(size).fillColor(color).text(String(c ?? ''), x + 4, y + 4, { width: ws[i] - 8, align: (t.align || [])[i] || 'left' }); x += ws[i]; });
        doc.y = y + h;
        doc.moveTo(L, doc.y).lineTo(L + W, doc.y).strokeColor(LINE).lineWidth(0.5).stroke();
      };
      drawRow(t.head, 'bold', 8, MUTED, '#F4EEE8');
      if (!t.rows.length) drawRow([t.empty || 'None', ...t.head.slice(1).map(() => '')], 'body', 9, MUTED);
      for (const r of t.rows) drawRow(r, r.bold ? 'bold' : 'body', 9, INK);
      doc.y += 12;
    }

    // totals block, right-aligned
    if (totals.length) {
      room(totals.length * 16 + 10);
      for (const [k, v, strong] of totals) {
        const y = doc.y;
        doc.font(strong ? 'bold' : 'body').fontSize(strong ? 10.5 : 9.5).fillColor(INK).text(k, L + W * 0.45, y, { width: W * 0.3, align: 'right' });
        doc.font(strong ? 'bold' : 'body').fontSize(strong ? 10.5 : 9.5).text(v, L + W * 0.75, y, { width: W * 0.25, align: 'right' });
        doc.y = y + (strong ? 17 : 14);
      }
      doc.y += 8;
    }
    for (const n of notes.filter(Boolean)) { room(30); doc.font('body').fontSize(8.5).fillColor(MUTED).text(n, L, doc.y, { width: W }); doc.y += 5; }

    // photo pages: three per row with captions (images are JPEG/PNG buffers)
    if (images.length) {
      room(40); doc.font('bold').fontSize(10).fillColor(INK).text('Photos', L, doc.y); doc.y += 6;
      const gap = 10, cw = (W - 2 * gap) / 3, ch = cw * 0.75;
      images.forEach((im, i) => {
        const col = i % 3;
        if (col === 0) room(ch + 30);
        const x = L + col * (cw + gap), y = doc.y;
        try { doc.image(im.buf, x, y, { fit: [cw, ch], align: 'center', valign: 'center' }); } catch { /* unreadable image */ }
        doc.font('body').fontSize(7.5).fillColor(MUTED).text(im.caption || '', x, y + ch + 3, { width: cw, height: 20, ellipsis: true });
        if (col === 2 || i === images.length - 1) doc.y = y + ch + 26; else doc.y = y;
      });
    }

    brand.footer(doc, { company, ref: number || 'Draft', x: L, width: W });
    doc.end();
  });
}

const money = (m, c = 'BHD') => formatMoney(m, c);
module.exports = { render, money, d };
