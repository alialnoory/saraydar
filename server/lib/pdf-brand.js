'use strict';
// The SarayDar dark heading used on every generated PDF (owner decision 2026-10-24: the same dark band as the
// page exports, on invoices, receipts, statements, reports and agreements too; no letterhead image).
const BAND = '#140D0A', BAND_INK = '#F1E6DA', BAND_MUTED = '#B9A595', COPPER = '#D29466';

// Draws the band across the top of the current page and leaves doc.y just below it.
// title: big line; sub: small line under it; right: [[text, {bold?, color?}]...] shown on the right.
function band(doc, { title, sub = '', right = [], x = 40, width }) {
  const W = width || doc.page.width - 2 * x, H = 92;
  doc.save();
  doc.rect(0, 0, doc.page.width, H).fill(BAND);
  doc.rect(0, H - 3, 96, 3).fill(COPPER);
  doc.restore();
  const rightW = right.length ? Math.min(220, W * 0.42) : 0;
  doc.font('display').fontSize(12).fillColor(BAND_INK).text('SARAYDAR', x, 22, { characterSpacing: 5, lineBreak: false });
  doc.font('display').fontSize(19).fillColor(BAND_INK).text(title, x, 40, { width: W - rightW - 12, height: 26, ellipsis: true });
  if (sub) doc.font('body').fontSize(8.5).fillColor(BAND_MUTED).text(sub, x, 68, { width: W - rightW - 12, height: 12, ellipsis: true });
  let ry = 26;
  for (const [t, o = {}] of right) {
    doc.font(o.bold ? 'bold' : 'body').fontSize(o.size || 10).fillColor(o.color || BAND_INK).text(t, x + W - rightW, ry, { width: rightW, align: 'right', lineBreak: false });
    ry += (o.size || 10) + 6;
  }
  doc.x = x; doc.y = H + 16;
}

// One line of company details at the foot of every page, plus "ref · page n of N" on the right.
function footer(doc, { company = {}, ref = '', x = 40, width, fromBottom = 32 }) {
  const W = width || doc.page.width - 2 * x;
  const line1 = [company.legal_name || company.trade_name || 'SarayDar Real Estate', company.cr_number ? `C.R. ${company.cr_number}` : null, company.address].filter(Boolean).join('  ·  ');
  const line2 = [company.phone, company.email || 'info@saraydar.com', 'saraydar.com'].filter(Boolean).join('  ·  ');
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const keep = doc.page.margins.bottom; doc.page.margins.bottom = 0;   // the footer sits below the margin; otherwise pdfkit starts an empty page
    const y = doc.page.height - fromBottom;
    doc.moveTo(x, y - 8).lineTo(x + W, y - 8).strokeColor('#E0D2C6').lineWidth(0.6).stroke();
    doc.font('body').fontSize(7).fillColor('#6E5B50').text(line1, x, y, { width: W * 0.72, height: 9, ellipsis: true });
    doc.font('body').fontSize(7).fillColor('#6E5B50').text(line2, x, y + 9.5, { width: W * 0.72, height: 9, ellipsis: true });
    doc.font('body').fontSize(7.5).fillColor('#6E5B50').text(`${ref ? `${ref} · ` : ''}page ${i + 1} of ${range.count}`, x + W * 0.72, y, { width: W * 0.28, align: 'right', lineBreak: false });
    doc.page.margins.bottom = keep;
  }
}

module.exports = { band, footer, BAND };
