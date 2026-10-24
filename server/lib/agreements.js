'use strict';
// Agreement templates: placeholder discovery, value formatting, and document generation
// (PDF on the SarayDar letterhead, editable Word file, or a filled-in uploaded Word template).
const path = require('path');
const PDFDocument = require('pdfkit');
const brand = require('./pdf-brand');
const PizZip = require('pizzip');
const Docxtemplater = require('docxtemplater');
const docx = require('docx');
const { formatMoney, parseMoney } = require('./money');

const FONT_DIR = path.join(__dirname, '..', 'fonts');
const TAG = /\{\{\s*([a-zA-Z][a-zA-Z0-9_.]*)\s*\}\}/g;
const BUILTIN_PREFIX = ['company.', 'party.', 'workspace.', 'agreement.'];
const BLANK = '__________';
const isBuiltin = k => BUILTIN_PREFIX.some(p => k.startsWith(p));

function placeholders(text) { const s = new Set(); for (const m of String(text || '').matchAll(TAG)) s.add(m[1]); return [...s]; }

function docxText(buf) {
  const zip = new PizZip(buf);
  return Object.keys(zip.files).filter(f => /^word\/(document|header\d*|footer\d*)\.xml$/.test(f))
    .map(f => zip.file(f).asText().replace(/<w:p[ >][\s\S]*?<\/w:p>/g, p => p.replace(/<[^>]+>/g, '') + '\n')).join('\n');
}

function inferField(key) {
  const label = key.replace(/_/g, ' ').replace(/\b(amount|pct)\b/g, '').trim().replace(/^./, c => c.toUpperCase());
  if (/_amount$/.test(key)) return { label, type: 'money' };
  if (/_date$/.test(key) || key === 'date') return { label, type: 'date' };
  if (/_(pct|days|months|day|number|count)$/.test(key)) return { label: label + (/_pct$/.test(key) ? ' (%)' : ''), type: 'number' };
  return { label, type: /description|scope|terms|services|notes|brief/.test(key) ? 'textarea' : 'text' };
}

// Questions for a template: every placeholder that is not filled by the system, with any metadata the template defines.
function fieldsFor(tpl) {
  const text = tpl.kind === 'docx' ? docxText(tpl.docx) : tpl.body;
  const meta = tpl.fields || {};
  return placeholders(text).filter(k => !isBuiltin(k)).map(k => ({ key: k, ...inferField(k), ...(meta[k] || {}) }));
}

const fmtDate = v => v ? new Date(v + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : '';
function display(field, raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (field.type === 'money') return formatMoney(Number(raw), 'BHD');
  if (field.type === 'date') return fmtDate(raw);
  return String(raw);
}

// Read submitted answers. Money is stored as minor units; required answers are checked only when generating.
function readValues(fields, body) {
  const out = {};
  for (const f of fields) {
    let v = body[`v_${f.key}`];
    v = typeof v === 'string' ? v.trim().slice(0, f.type === 'textarea' ? 6000 : 500) : '';
    if (v === '') continue;
    if (f.type === 'money') out[f.key] = parseMoney(v, 'BHD');
    else if (f.type === 'date') { if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw Object.assign(new Error(`${f.label} must be a date.`), { status: 400 }); out[f.key] = v; }
    else if (f.type === 'number') { const n = Number(v); if (!isFinite(n)) throw Object.assign(new Error(`${f.label} must be a number.`), { status: 400 }); out[f.key] = n; }
    else out[f.key] = v;
  }
  return out;
}

function builtins({ company = {}, ws = {}, party = {}, agreement = {} }) {
  const rep = party.representative ? `, represented by ${party.representative}${party.representative_title ? `, ${party.representative_title}` : ''}` : '';
  return {
    'company.legal_name': company.legal_name || company.trade_name, 'company.trade_name': company.trade_name, 'company.cr_number': company.cr_number,
    'company.address': company.address, 'company.phone': company.phone, 'company.email': company.email,
    'company.signatory_name': company.signatory_name, 'company.signatory_title': company.signatory_title,
    'workspace.name': ws.name, 'workspace.ref': ws.ref, 'workspace.location': ws.location,
    'party.name': party.name, 'party.id_number': party.id_number, 'party.address': party.address, 'party.phone': party.phone, 'party.email': party.email,
    'party.representative': party.representative, 'party.representative_title': party.representative_title,
    'party.represented_by': party.name ? rep : '', 'party.signatory': party.representative || party.name,
    'agreement.ref': agreement.ref, 'agreement.title': agreement.title, 'agreement.date': fmtDate(new Date().toISOString().slice(0, 10))
  };
}

// Final map of placeholder → printed text.
function resolve(fields, values, base) {
  const out = { ...base };
  for (const f of fields) out[f.key] = display(f, values[f.key]);
  for (const k of Object.keys(out)) if (out[k] === null || out[k] === undefined || out[k] === '') out[k] = k === 'party.represented_by' ? '' : BLANK;
  return out;
}
const missingRequired = (fields, values) => fields.filter(f => f.required && (values[f.key] === undefined || values[f.key] === null || values[f.key] === ''));
const fill = (text, map) => String(text).replace(TAG, (m, k) => map[k] ?? BLANK);

function blocks(text) {
  const out = [];
  for (const para of String(text).replace(/\r/g, '').split(/\n{2,}/)) {
    const t = para.trim(); if (!t) continue;
    if (t.startsWith('# ')) out.push({ k: 'title', t: t.slice(2) });
    else if (t.startsWith('## ')) out.push({ k: 'h', t: t.slice(3) });
    else if (t.split('\n').every(l => l.trim().startsWith('- '))) for (const l of t.split('\n')) out.push({ k: 'li', t: l.trim().slice(2) });
    else if (t.split('\n').every(l => /^\[\[sign:.*\]\]$/.test(l.trim()))) out.push({ k: 'sign', boxes: t.split('\n').map(signBox) });
    else out.push({ k: 'p', t });
  }
  return out;
}

// [[sign: Heading | Name: … | Title: … | Company stamp]] lines become signature boxes, side by side.
// Each box gets a signature space and a date; "Company stamp" adds a stamp space.
function signBox(line) {
  const parts = line.trim().replace(/^\[\[sign:/, '').replace(/\]\]$/, '').split('|').map(x => x.trim());
  const box = { title: parts[0] || 'Signed by', rows: [], stamp: false };
  for (const p of parts.slice(1)) {
    if (/^company stamp$/i.test(p)) { box.stamp = true; continue; }
    const i = p.indexOf(':');
    if (i > 0) box.rows.push([p.slice(0, i).trim(), p.slice(i + 1).trim().replace(/^_+$/, '')]);
  }
  return box;
}

// **text** in a template prints in bold (used for the parties' names).
const segments = t => String(t).split(/\*\*(.+?)\*\*/s).map((x, i) => ({ t: x, b: i % 2 === 1 })).filter(x => x.t !== '');
function richText(doc, t, opts, size = 10) {
  const segs = segments(t);
  if (!segs.length) return doc;
  segs.forEach((g, i) => doc.font(g.b ? 'bold' : 'body').fontSize(size).fillColor('#2A1C15').text(g.t, i === 0 ? { ...opts, continued: i < segs.length - 1 } : { continued: i < segs.length - 1 }));
  return doc;
}

function drawSignBoxes(doc, boxes, X, W, limit) {
  const gap = 16, perRow = 2, bw = (W - gap) / perRow;
  for (let r = 0; r < boxes.length; r += perRow) {
    const row = boxes.slice(r, r + perRow);
    const hasStamp = row.some(b => b.stamp);
    const rowsMax = Math.max(...row.map(b => b.rows.length));
    const H = 30 + rowsMax * 22 + 58 + 22 + (hasStamp ? 62 : 0) + 10;
    if (doc.y + H > limit) doc.addPage();
    const y0 = doc.y + 4;
    row.forEach((b, i) => {
      const x = X + i * (bw + gap);
      doc.save().lineWidth(0.8).strokeColor('#BFAE9F').rect(x, y0, bw, H).stroke().restore();
      doc.save().rect(x, y0, bw, 24).fill('#140D0A').restore();
      doc.font('bold').fontSize(9).fillColor('#F1E6DA').text(b.title, x + 10, y0 + 7, { width: bw - 20, height: 12, ellipsis: true });
      let y = y0 + 34;
      const line = (label, value, h = 22) => {
        doc.font('body').fontSize(8).fillColor('#6E5B50').text(label, x + 10, y + h - 14, { width: 70, lineBreak: false });
        if (value) { doc.font('bold').fontSize(9.5); const fit = Math.max(7, Math.min(9.5, 9.5 * (bw - 92) / Math.max(1, doc.widthOfString(value)))); doc.fontSize(fit).fillColor('#2A1C15').text(value, x + 80, y + h - 15, { width: bw - 90, height: 12, ellipsis: true }); }
        doc.save().lineWidth(0.6).strokeColor('#D4C2B3').moveTo(x + 78, y + h - 2).lineTo(x + bw - 10, y + h - 2).stroke().restore();
        y += h;
      };
      for (const [k, v] of b.rows) line(k, v);
      for (let k = b.rows.length; k < rowsMax; k++) y += 22;
      line('Signature', '', 58);
      line('Date', '');
      if (b.stamp) { doc.font('body').fontSize(8).fillColor('#6E5B50').text('Company stamp', x + 10, y + 6, { lineBreak: false }); doc.save().lineWidth(0.6).dash(3, { space: 3 }).strokeColor('#BFAE9F').rect(x + 78, y + 4, 90, 52).stroke().undash().restore(); y += 62; }
    });
    doc.x = X; doc.y = y0 + H + 14;
  }
}

const NOTICE = 'STARTER DRAFT — prepared from a generic template. Have it reviewed by your legal adviser before signing.';

function renderPdf({ text, ref, letterhead, company = {}, marginTop = 45, marginBottom = 30, notice = false }) {
  letterhead = null; marginTop = 14; marginBottom = 20;     // the SarayDar dark heading replaces any letterhead image (owner decision 2026-10-24)
  return new Promise((resolve, reject) => {
    const mm = v => v * 72 / 25.4;
    const doc = new PDFDocument({ size: 'A4', bufferPages: true, margins: { top: mm(marginTop), bottom: mm(marginBottom), left: mm(22), right: mm(22) }, info: { Title: ref, Author: 'SarayDar' } });
    const chunks = []; doc.on('data', c => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    doc.registerFont('body', path.join(FONT_DIR, 'ibm-plex-sans-latin-400-normal.ttf'));
    doc.registerFont('bold', path.join(FONT_DIR, 'ibm-plex-sans-latin-600-normal.ttf'));
    doc.registerFont('display', path.join(FONT_DIR, 'ibm-plex-sans-latin-600-normal.ttf'));
    const W = doc.page.width - mm(44);
    brand.band(doc, { title: 'Agreement', sub: [company.legal_name || company.trade_name, company.cr_number ? `C.R. ${company.cr_number}` : null].filter(Boolean).join(' · '), right: [[ref, { bold: true, size: 11 }]], x: mm(22), width: W });
    for (const b of blocks(text)) {
      if (b.k === 'title') {
        doc.font('display').fontSize(18).fillColor('#2A1C15').text(b.t, { align: 'center', width: W }).moveDown(0.6);
        if (notice) doc.font('bold').fontSize(8.5).fillColor('#7A4F0C').text(NOTICE, { align: 'center', width: W }).moveDown(0.8);
      } else if (b.k === 'h') { if (doc.y > doc.page.height - mm(marginBottom) - 60) doc.addPage(); doc.moveDown(0.4).font('bold').fontSize(11).fillColor('#2A1C15').text(b.t, { width: W }).moveDown(0.25); }
      else if (b.k === 'li') richText(doc, `•  ${b.t}`, { width: W, indent: 10 }).moveDown(0.15);
      else if (b.k === 'sign') drawSignBoxes(doc, b.boxes, mm(22), W, doc.page.height - mm(marginBottom));
      else richText(doc, b.t, { width: W, align: 'justify', lineGap: 1.5 }).moveDown(0.55);
    }
    brand.footer(doc, { company, ref });
    doc.end();
  });
}

async function renderDocx({ text, ref, letterhead, letterheadType, company = {}, marginTop = 45, marginBottom = 30, notice = false }) {
  letterhead = null; marginTop = 40; marginBottom = 20;     // dark SarayDar heading instead of a letterhead image
  const { Document, Packer, Paragraph, TextRun, ImageRun, Header, Footer, AlignmentType, PageNumber, ShadingType, TabStopType, Table, TableRow, TableCell, WidthType, BorderStyle, convertMillimetersToTwip } = docx;
  const runs = (t, opts = {}) => { const out = []; let first = true;
    for (const g of segments(t)) g.t.split('\n').forEach((line, i) => { out.push(new TextRun({ text: line, break: i ? 1 : 0, font: 'IBM Plex Sans', size: 20, bold: g.b, ...opts })); first = false; });
    return out; };
  const children = [];
  for (const b of blocks(text)) {
    if (b.k === 'title') {
      children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 200 }, children: [new TextRun({ text: b.t, font: 'IBM Plex Sans', size: 36, bold: true })] }));
      if (notice) children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 240 }, children: [new TextRun({ text: NOTICE, bold: true, size: 16, color: '7A4F0C' })] }));
    } else if (b.k === 'h') children.push(new Paragraph({ spacing: { before: 200, after: 80 }, keepNext: true, children: [new TextRun({ text: b.t, bold: true, font: 'IBM Plex Sans', size: 22 })] }));
    else if (b.k === 'li') children.push(new Paragraph({ bullet: { level: 0 }, children: runs(b.t) }));
    else if (b.k === 'sign') {
      const edge = { style: BorderStyle.SINGLE, size: 6, color: 'BFAE9F' };
      const field = (label, value, tall = false) => new Paragraph({ spacing: { before: tall ? 600 : 160, after: 0 }, border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: 'D4C2B3', space: 2 } },
        children: [new TextRun({ text: `${label}  `, font: 'IBM Plex Sans', size: 16, color: '6E5B50' }), new TextRun({ text: value || '', font: 'IBM Plex Sans', size: 19, bold: true })] });
      const cell = bx => new TableCell({ width: { size: 50, type: WidthType.PERCENTAGE }, borders: { top: edge, bottom: edge, left: edge, right: edge }, margins: { top: 0, bottom: 160, left: 140, right: 140 },
        children: [new Paragraph({ shading: { type: ShadingType.CLEAR, color: 'auto', fill: '140D0A' }, spacing: { before: 0, after: 80 }, children: [new TextRun({ text: bx.title, font: 'IBM Plex Sans', bold: true, size: 18, color: 'F1E6DA' })] }),
          ...bx.rows.map(([k, v]) => field(k, v)), field('Signature', '', true), field('Date', ''), ...(bx.stamp ? [field('Company stamp', '', true)] : [])] });
      for (let r = 0; r < b.boxes.length; r += 2) {
        const row = b.boxes.slice(r, r + 2);
        children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, borders: { insideVertical: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' } }, rows: [new TableRow({ cantSplit: true, children: row.map(cell).concat(row.length < 2 ? [new TableCell({ children: [new Paragraph('')], borders: { top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE } } })] : []) })] }));
        children.push(new Paragraph({ spacing: { after: 120 }, children: [] }));
      }
    }
    else children.push(new Paragraph({ alignment: AlignmentType.JUSTIFIED, spacing: { after: 120 }, children: runs(b.t) }));
  }
  const band = { type: ShadingType.CLEAR, color: 'auto', fill: '140D0A' };
  const header = new Header({ children: [
    new Paragraph({ shading: band, spacing: { before: 0, after: 0 }, indent: { left: 120, right: 120 }, children: [new TextRun({ text: ' ', size: 10 })] }),
    // left: logo, company line under it; right: the type of document, the reference under it
    new Paragraph({ shading: band, indent: { left: 120, right: 120 }, tabStops: [{ type: TabStopType.RIGHT, position: 9300 }], children: [new TextRun({ text: 'SΛRΛYDΛR', font: 'Jost', size: 30, color: 'F1E6DA', characterSpacing: 120 }), new TextRun({ text: '\tAgreement', font: 'IBM Plex Sans', bold: true, size: 32, color: 'F1E6DA' })] }),
    new Paragraph({ shading: band, spacing: { after: 0 }, indent: { left: 120, right: 120 }, tabStops: [{ type: TabStopType.RIGHT, position: 9300 }], border: { bottom: { style: 'single', size: 18, color: 'D29466', space: 0 } }, children: [new TextRun({ text: [company.legal_name || company.trade_name, company.cr_number ? `C.R. ${company.cr_number}` : null].filter(Boolean).join(' · ') || ' ', font: 'IBM Plex Sans', size: 16, color: 'B9A595' }), new TextRun({ text: `\t${ref}`, font: 'IBM Plex Sans', bold: true, size: 20, color: 'F1E6DA' })] })
  ] });
  const d = new Document({
    creator: 'SarayDar Management System', title: ref,
    sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: convertMillimetersToTwip(marginTop), bottom: convertMillimetersToTwip(marginBottom), left: convertMillimetersToTwip(22), right: convertMillimetersToTwip(22), header: convertMillimetersToTwip(8) } } },
      headers: { default: header },
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: `${ref} · page `, size: 14, color: '6E5B50' }), new TextRun({ children: [PageNumber.CURRENT], size: 14, color: '6E5B50' })] })] }) },
      children }]
  });
  return Packer.toBuffer(d);
}

function fillDocx(buf, map) {
  const zip = new PizZip(buf);
  const doc = new Docxtemplater(zip, { delimiters: { start: '{{', end: '}}' }, paragraphLoop: true, linebreaks: true, nullGetter: () => BLANK,
    parser: tag => ({ get: scope => scope[tag.trim()] }) });
  doc.render(map);
  return doc.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

module.exports = { placeholders, docxText, fieldsFor, readValues, builtins, resolve, missingRequired, fill, renderPdf, renderDocx, fillDocx, display, isBuiltin, NOTICE, BLANK };
