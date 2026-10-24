'use strict';
// The SarayDar dark heading used on every generated PDF (owner decision 2026-10-24: the same dark band as the
// page exports, on invoices, receipts, statements, reports and agreements too; no letterhead image).
const path = require('path');
const LOGO_FONT = path.join(__dirname, '..', 'fonts', 'jost-latin-500-normal.ttf');
const BAND = '#140D0A', BAND_INK = '#F1E6DA', BAND_MUTED = '#B9A595', COPPER = '#D29466';

// The SΛRΛYDΛR wordmark in its own typeface (Jost). Jost has no Greek Λ, so each Λ is Jost's V turned upside
// down, which is the same geometric shape. size = font size in pt; returns the width drawn.
function logo(doc, x, y, { size = 20, color = BAND_INK, tracking = 0.34 } = {}) {
  if (!doc._registeredFonts || !doc._registeredFonts.sdlogo) doc.registerFont('sdlogo', LOGO_FONT);
  doc.font('sdlogo').fontSize(size).fillColor(color);
  const f = doc._font, asc = f.ascender / 1000 * size, cap = (f.capHeight || 700) / 1000 * size;
  const cy = y + asc - cap / 2;                      // middle of the capitals
  let cx = x;
  for (const ch of 'SΛRΛYDΛR') {
    const g = ch === 'Λ' ? 'V' : ch;
    const w = doc.widthOfString(g);
    if (ch === 'Λ') { doc.save(); doc.translate(0, 2 * cy).scale(1, -1); doc.text(g, cx, y, { lineBreak: false }); doc.restore(); }
    else doc.text(g, cx, y, { lineBreak: false });
    cx += w + size * tracking;
  }
  return cx - x - size * tracking;
}

// Draws the band across the top of the current page and leaves doc.y just below it.
// title: big line; sub: small line under it; right: [[text, {bold?, color?}]...] shown on the right.
function band(doc, { title, sub = '', right = [], x = 40, width }) {
  const W = width || doc.page.width - 2 * x, H = 104;
  doc.save();
  doc.rect(0, 0, doc.page.width, H).fill(BAND);
  doc.rect(0, H - 3, 96, 3).fill(COPPER);
  doc.restore();
  const rightW = right.length ? Math.min(220, W * 0.42) : 0;
  logo(doc, x, 18, { size: 20 });
  doc.font('display').fontSize(17).fillColor(BAND_INK).text(title, x, 52, { width: W - rightW - 12, height: 24, ellipsis: true });
  if (sub) doc.font('body').fontSize(8.5).fillColor(BAND_MUTED).text(sub, x, 78, { width: W - rightW - 12, height: 12, ellipsis: true });
  let ry = 24;
  for (const [t, o = {}] of right) {
    doc.font(o.bold ? 'bold' : 'body').fontSize(o.size || 10).fillColor(o.color || BAND_INK).text(t, x + W - rightW, ry, { width: rightW, align: 'right', lineBreak: false });
    ry += (o.size || 10) + 6;
  }
  doc.x = x; doc.y = H + 16;
}

// Dark footer band on every page, inset 1 cm from the left and right edges and running to the bottom edge:
// company details on the left, "ref · page n of N" on the right.
const CM = 72 / 2.54;
function footer(doc, { company = {}, ref = '', lines = null }) {
  const line1 = [company.legal_name || company.trade_name || 'SarayDar Real Estate', company.cr_number ? `C.R. ${company.cr_number}` : null, company.address].filter(Boolean).join('  ·  ');
  const line2 = [company.phone, company.email || 'info@saraydar.com', 'saraydar.com'].filter(Boolean).join('  ·  ');
  const [l1, l2] = lines || [line1, line2];
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const keep = doc.page.margins.bottom; doc.page.margins.bottom = 0;   // the footer sits below the margin; otherwise pdfkit starts an empty page
    const H = 38, x0 = CM, w0 = doc.page.width - 2 * CM, y0 = doc.page.height - H;
    doc.save(); doc.rect(x0, y0, w0, H).fill(BAND); doc.rect(x0, y0, 64, 2).fill(COPPER); doc.restore();
    const pad = 14, tx = x0 + pad, tw = w0 - 2 * pad;
    doc.font('body').fontSize(7).fillColor(BAND_INK).text(l1 || '', tx, y0 + 10, { width: tw * 0.74, height: 9, ellipsis: true });
    doc.font('body').fontSize(7).fillColor(BAND_MUTED).text(l2 || '', tx, y0 + 20, { width: tw * 0.74, height: 9, ellipsis: true });
    doc.font('body').fontSize(7.5).fillColor(BAND_INK).text(`${ref ? `${ref} · ` : ''}page ${i + 1} of ${range.count}`, tx + tw * 0.74, y0 + 15, { width: tw * 0.26, align: 'right', lineBreak: false });
    doc.page.margins.bottom = keep;
  }
}

module.exports = { band, footer, logo, BAND };
