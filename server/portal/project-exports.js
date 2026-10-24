'use strict';
const DL = require('../lib/download');
// PDF and Excel exports for development projects. Read-only: generating a report never changes records.
const path = require('path');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const sharp = require('sharp');
const { html, raw, csrfField, field, fmtDate, fmtDateTime } = require('./views');
const { formatMoney, num } = require('../lib/money');
const { TASK_STATUS, REG } = require('./projects');

const FONT_DIR = path.join(__dirname, '..', 'fonts');   // TTF copies of the self-hosted fonts (PDF embedding)
const dateOrNull = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : null;
const iso = d => d ? (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)) : null;
const pct = v => v === null || v === undefined ? '—' : `${Math.round(v * 10) / 10}%`;
// Spreadsheet formula injection: text starting with = + - @ or control characters is stored as literal text.
const safe = v => typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
const fm = m => m === null || m === undefined ? '—' : formatMoney(m);

function mountProjectExports(r, ctx, P) {
  const { pool, core } = ctx;

  function period(q) {
    const from = dateOrNull(q.from), to = dateOrNull(q.to);
    if (from && to && to < from) throw Object.assign(new Error('The end date is before the start date.'), { status: 400 });
    return { from, to, label: from || to ? `${from ? fmtDate(from) : 'start'} – ${to ? fmtDate(to) : 'today'}` : 'All dates' };
  }
  async function gather(a, per) {
    const m = await P.metrics(a.ws.id);
    const vals = [a.ws.id]; let w = "workspace_id = $1 and archived_at is null and status = 'published'";
    if (per.from) { vals.push(per.from); w += ` and observed_on >= $${vals.length}`; }
    if (per.to) { vals.push(per.to); w += ` and observed_on <= $${vals.length}`; }
    const updates = (await pool.query(`select * from progress_updates where ${w} order by observed_on, created_at`, vals)).rows;
    for (const u of updates) u.files = (await pool.query("select id, original_name, caption, mime from files where entity = 'progress_update' and entity_id = $1 and workspace_id = $2 and archived_at is null order by uploaded_at", [u.id, a.ws.id])).rows;
    const regs = (await pool.query('select * from register_items where workspace_id = $1 and archived_at is null order by kind, created_at', [a.ws.id])).rows;
    const units = (await pool.query('select * from dev_units where workspace_id = $1 order by sort, name', [a.ws.id])).rows;
    const fin = a.finance && !(P.clientBudget && P.clientBudget(a.ws)) ? {
      budget: await P.budgetSummary(a.ws.id),
      commitments: (await pool.query('select * from commitments where workspace_id = $1 order by created_at', [a.ws.id])).rows,
      invoices: (await pool.query(`select * from cost_invoices where workspace_id = $1 ${per.from ? 'and (invoice_date is null or invoice_date >= $2)' : ''} order by created_at`, per.from ? [a.ws.id, per.from] : [a.ws.id])).rows,
      payments: (await pool.query('select * from cost_payments where workspace_id = $1 order by created_at', [a.ws.id])).rows.filter(p => (!per.from || !p.paid_on || iso(p.paid_on) >= per.from) && (!per.to || !p.paid_on || iso(p.paid_on) <= per.to))
    } : null;
    const phaseName = Object.fromEntries(m.phases.map(p => [p.id, p.name]));
    return { m, updates, regs, units, fin, phaseName };
  }

  r.get('/w/:id/reports', async (req, res) => {
    const a = await P.access(req);
    res.send(P.page(req, a, 'Reports', html`<section class="panel"><h2 class="h">Project report</h2>
      <form method="get" class="form-grid" action="/w/${a.ws.id}/export.pdf">
        ${field({ name: 'from', label: 'Period from', type: 'date' })}${field({ name: 'to', label: 'Period to', type: 'date' })}
        <label class="field check full"><input type="checkbox" name="photos" value="1" checked> <span>Include photos from published progress updates (PDF)</span></label>
        <div class="actions full"><button class="btn primary" type="submit">Download PDF</button>
          <button class="btn" type="submit" formaction="/w/${a.ws.id}/export.xlsx">Download Excel</button></div>
        <p class="muted small full">The period filters progress updates and payments. Tasks, budget and registers show their current state. ${a.finance ? 'Financial sheets are included because your role can see financial figures.' : 'Financial figures are left out for your role.'} Excel files list photo references; photos open only in the portal after sign-in.</p>
      </form></section>`));
  });

  r.get('/w/:id/export.xlsx', async (req, res) => {
    const a = await P.access(req);
    const per = period(req.query);
    const { m, updates, regs, units, fin, phaseName } = await gather(a, per);
    const wb = new ExcelJS.Workbook();
    wb.creator = 'SarayDar Management System'; wb.created = new Date();
    const sheet = (name, cols, rows) => {
      const s = wb.addWorksheet(name);
      s.columns = cols.map(([header, key, width, fmt]) => ({ header, key, width: width || 18, style: fmt ? { numFmt: fmt } : {} }));
      s.getRow(1).font = { bold: true }; s.views = [{ state: 'frozen', ySplit: 1 }];
      for (const row of rows) s.addRow(Object.fromEntries(Object.entries(row).map(([k, v]) => [k, safe(v)])));
      return s;
    };
    const money = '#,##0.000';
    const bhd = v => v === null || v === undefined ? null : Number(v) / 1000;
    sheet('Summary', [['Item', 'k', 34], ['Value', 'v', 60]], [
      { k: 'Project', v: a.ws.name }, { k: 'Reference', v: a.ws.ref }, { k: 'Location', v: a.ws.location || 'Not yet determined' },
      { k: 'Report period', v: per.label }, { k: 'Generated', v: fmtDateTime(new Date()) }, { k: 'Generated by', v: req.user.name || req.user.email },
      { k: 'Currency', v: 'BHD (3 decimals)' },
      { k: 'Plan baseline', v: m.pl.approved ? `v${m.pl.approved.version} approved ${fmtDate(m.pl.approved.approved_at)}` : 'Not approved' },
      { k: 'Overall progress', v: m.ov.available ? pct(m.ov.pct) : `Not available: ${m.ov.reason}` },
      { k: 'Planned progress today', v: m.planned.available ? pct(m.planned.pct) : `Not available: ${m.planned.reason}` },
      { k: 'Progress method', v: 'Σ(phase weight × phase %) ÷ Σ phase weights; phase % = weighted average of lowest-level tasks.' },
      ...(fin ? [{ k: 'Cost definitions', v: 'Committed = contracts/orders. Incurred = approved invoices + confirmed payments without invoice. Paid = confirmed payments. EAC = incurred + open commitments + forecast uncommitted.' }] : [])
    ]);
    sheet('Tasks', [['Phase', 'phase', 24], ['Task', 'title', 46], ['Owner', 'owner', 20], ['Start', 'start', 12], ['Due', 'due', 12], ['Actual start', 'as', 12], ['Actual finish', 'af', 12], ['Status', 'status', 14], ['Progress %', 'progress', 11], ['Weight', 'weight', 9], ['Milestone', 'ms', 10], ['Verified', 'ver', 10]],
      m.tasks.map(t => ({ phase: phaseName[t.phase_id] || '', title: t.title, owner: t.owner_text || '', start: iso(t.start_date), due: iso(t.due_date), as: iso(t.actual_start), af: iso(t.actual_finish), status: TASK_STATUS[t.status], progress: t.status === 'done' ? 100 : t.progress, weight: t.weight === null ? 1 : Number(t.weight), ms: t.is_milestone ? 'Yes' : '', ver: t.verified ? 'Yes' : 'Unverified' })));
    sheet('Phases', [['Phase', 'name', 30], ['Weight', 'weight', 10], ['Tasks', 'tasks', 8], ['Phase %', 'pct', 10]], m.ov.phases.map(p => ({ name: p.name, weight: p.weight, tasks: p.tasks, pct: p.pct === null ? null : Math.round(p.pct * 10) / 10 })));
    if (fin) {
      sheet('Budget', [['Category', 'cat', 20], ['Line', 'desc', 34], ['Baseline', 'o', 16, money], ['Current budget', 'r', 16, money], ['Committed', 'c', 16, money], ['Incurred', 'i', 16, money], ['Paid', 'p', 16, money], ['Open commitments', 'oc', 16, money], ['Forecast uncommitted', 'f', 18, money], ['EAC', 'e', 16, money], ['Verified', 'v', 10]],
        fin.budget.rows.map(l => ({ cat: l.category, desc: l.description, o: bhd(l.original), r: bhd(l.revised), c: bhd(l.committed), i: bhd(l.incurred), p: bhd(l.paid), oc: bhd(l.openCommit), f: bhd(l.forecast), e: bhd(l.eac), v: l.verified ? 'Yes' : 'No' })));
      sheet('Commitments', [['Counterparty', 'cp', 30], ['Reference', 'ref', 16], ['Date', 'd', 12], ['Value', 'v', 16, money], ['Status', 's', 12]], fin.commitments.map(c => ({ cp: c.counterparty, ref: c.reference || '', d: iso(c.committed_on), v: bhd(c.value_minor), s: c.status })));
      sheet('Invoices', [['Supplier', 's', 30], ['Invoice no', 'n', 16], ['Date', 'd', 12], ['Amount', 'a', 16, money], ['Status', 'st', 12]], fin.invoices.map(i => ({ s: i.supplier, n: i.invoice_no || '', d: iso(i.invoice_date), a: bhd(i.amount_minor), st: i.status })));
      sheet('Payments', [['Payee', 'p', 30], ['Payer', 'pr', 14], ['Paid on', 'd', 12], ['Reference', 'ref', 18], ['Amount', 'a', 16, money], ['Status', 's', 22]], fin.payments.map(p => ({ p: p.payee, pr: p.payer, d: iso(p.paid_on), ref: p.reference || '', a: bhd(p.amount_minor), s: p.status === 'pending' ? 'Awaiting confirmation' : p.status })));
    }
    sheet('Progress updates', [['Observed', 'd', 12], ['Title', 't', 34], ['Phase', 'ph', 22], ['Completed work', 'c', 50], ['Remaining', 'r', 40], ['Issues', 'i', 30], ['Workers', 'w', 9], ['Author', 'a', 18], ['Photo references', 'f', 50]],
      updates.map(u => ({ d: iso(u.observed_on), t: u.title, ph: phaseName[u.phase_id] || '', c: u.completed_work || '', r: u.remaining_work || '', i: u.issues || '', w: u.workforce, a: u.author_label || '', f: u.files.map(f => `${f.original_name} (file ${f.id.slice(0, 8)})`).join('; ') })));
    sheet('Registers', [['Register', 'k', 20], ['Title', 't', 44], ['Owner', 'o', 18], ['Likelihood', 'l', 12], ['Impact', 'i', 10], ['Due', 'd', 12], ['Status', 's', 14], ['Details', 'x', 50]],
      regs.map(x => ({ k: REG[x.kind].label, t: x.title, o: x.owner_text || '', l: x.likelihood || '', i: x.impact || '', d: iso(x.due_date), s: x.status, x: x.description || '' })));
    sheet('Units', [['Unit', 'n', 18], ['Type', 't', 16], ['Area m²', 'a', 10], ...(fin ? [['List price', 'p', 16, money]] : []), ['Status', 's', 14]],
      units.map(u => ({ n: u.name, t: u.unit_type || '', a: u.area_m2 === null ? null : Number(u.area_m2), ...(fin ? { p: bhd(u.list_price_minor) } : {}), s: u.status })));
    await core.audit(null, { actor: req.user, workspaceId: a.ws.id, action: 'report.excel', entity: 'report', entityId: a.ws.id, summary: `Excel report downloaded (${per.label})`, ip: req.ip });
    res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': DL.disposition(DL.fileName([a.ws.ref, a.ws.name, 'Report', DL.today()], 'xlsx')), 'Cache-Control': 'private, no-store' });
    await wb.xlsx.write(res);
    res.end();
  });

  r.get('/w/:id/export.pdf', async (req, res) => {
    const a = await P.access(req);
    const per = period(req.query);
    const { m, updates, regs, fin, phaseName } = await gather(a, per);
    const photos = req.query.photos === '1';
    const doc = new PDFDocument({ size: 'A4', margin: 48, bufferPages: true, info: { Title: `${a.ws.name} — project report`, Author: 'SarayDar Management System' } });
    doc.registerFont('body', path.join(FONT_DIR, 'ibm-plex-sans-latin-400-normal.ttf'));
    doc.registerFont('bold', path.join(FONT_DIR, 'ibm-plex-sans-latin-600-normal.ttf'));
    doc.registerFont('display', path.join(FONT_DIR, 'ibm-plex-sans-latin-600-normal.ttf'));
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': DL.disposition(DL.fileName([a.ws.ref, a.ws.name, 'Report', DL.today()], 'pdf')), 'Cache-Control': 'private, no-store' });
    doc.pipe(res);
    const W = doc.page.width - 96, INK = '#2A1C15', MUTED = '#6E5B50', ACC = '#8E4F2B', LINE = '#E0D2C6';
    const h2 = t => { if (doc.y > doc.page.height - 140) doc.addPage(); doc.moveDown(0.8).font('display').fontSize(15).fillColor(ACC).text(t).moveDown(0.3).fillColor(INK); };
    const p = (t, o = {}) => doc.font(o.bold ? 'bold' : 'body').fontSize(o.size || 10).fillColor(o.color || INK).text(t, o);
    function table(cols, rows) {
      const x0 = 48; let y = doc.y + 4;
      const widths = cols.map(c => c[1] * W);
      const rowH = cells => Math.max(...cells.map((c, i) => doc.font('body').fontSize(8.5).heightOfString(String(c ?? ''), { width: widths[i] - 6 }))) + 6;
      const header = () => { doc.font('bold').fontSize(8.5).fillColor(MUTED); let x = x0; cols.forEach((c, i) => { doc.text(c[0], x + 3, y, { width: widths[i] - 6, align: c[2] || 'left' }); x += widths[i]; }); y += 16; doc.moveTo(x0, y - 3).lineTo(x0 + W, y - 3).strokeColor(LINE).stroke(); };
      header();
      for (const row of rows) {
        const hgt = rowH(row);
        if (y + hgt > doc.page.height - 60) { doc.addPage(); y = 60; header(); }
        let x = x0; doc.font('body').fontSize(8.5).fillColor(INK);
        row.forEach((c, i) => { doc.text(String(c ?? ''), x + 3, y, { width: widths[i] - 6, align: cols[i][2] || 'left' }); x += widths[i]; });
        y += hgt; doc.moveTo(x0, y - 2).lineTo(x0 + W, y - 2).strokeColor('#EDE3DA').stroke();
      }
      doc.x = x0; doc.y = y + 4;
    }
    // cover band
    doc.rect(0, 0, doc.page.width, 120).fill('#140D0A');
    doc.font('display').fontSize(16).fillColor('#F1E6DA').text('SARAYDAR', 48, 34, { characterSpacing: 6 });
    doc.font('display').fontSize(22).text(a.ws.name, 48, 60);
    doc.font('body').fontSize(9).fillColor('#B9A595').text(`${a.ws.ref} · ${a.ws.location || 'Location not yet determined'} · Project report · ${per.label}`, 48, 92);
    doc.y = 140; doc.x = 48;
    p(`Generated ${fmtDateTime(new Date())} by ${req.user.name || req.user.email}. Currency BHD. Figures reflect records at generation time.`, { size: 8.5, color: MUTED });

    h2('Progress');
    p(`Plan baseline: ${m.pl.approved ? `v${m.pl.approved.version}, approved ${fmtDate(m.pl.approved.approved_at)}` : 'not yet approved'}`);
    p(`Overall progress: ${m.ov.available ? pct(m.ov.pct) : `not available — ${m.ov.reason}`}`, { bold: true });
    p(`Planned progress today: ${m.planned.available ? pct(m.planned.pct) : `not available — ${m.planned.reason}`}`);
    p('Method: sum of (phase weight × phase %) divided by the sum of phase weights; phase % is the weighted average of its lowest-level tasks. Photos do not change progress.', { size: 8, color: MUTED });
    table([['Phase', 0.5], ['Weight', 0.15, 'right'], ['Tasks', 0.15, 'right'], ['Phase %', 0.2, 'right']], m.ov.phases.map(x => [x.name, x.weight ?? 'not set', x.tasks, pct(x.pct)]));
    const ms = m.tasks.filter(t => t.is_milestone);
    if (ms.length) { h2('Milestones'); table([['Milestone', 0.5], ['Due', 0.2], ['Status', 0.3]], ms.map(t => [t.title, fmtDate(t.due_date) || 'not set', TASK_STATUS[t.status]])); }
    if (m.overdue.length) { h2(`Overdue tasks (${m.overdue.length})`); table([['Task', 0.5], ['Owner', 0.25], ['Due', 0.25]], m.overdue.map(t => [t.title, t.owner_text || '', fmtDate(t.due_date)])); }
    if (fin) {
      h2('Budget and cost (BHD)');
      const b = fin.budget;
      table([['Line', 0.28], ['Budget', 0.12, 'right'], ['Committed', 0.12, 'right'], ['Incurred', 0.12, 'right'], ['Paid', 0.12, 'right'], ['EAC', 0.12, 'right'], ['Variance', 0.12, 'right']],
        [...b.rows.map(l => [l.description + (l.verified ? '' : ' (unverified)'), l.revised === null ? 'not set' : formatMoney(l.revised, 'BHD', { code: false }), formatMoney(l.committed, 'BHD', { code: false }), formatMoney(l.incurred, 'BHD', { code: false }), formatMoney(l.paid, 'BHD', { code: false }), l.eac === null ? '—' : formatMoney(l.eac, 'BHD', { code: false }), l.eac === null || l.revised === null ? '—' : formatMoney(l.revised - l.eac, 'BHD', { code: false })]),
          ['Total', b.total.revised === null ? 'incomplete' : formatMoney(b.total.revised, 'BHD', { code: false }), formatMoney(b.total.committed, 'BHD', { code: false }), formatMoney(b.total.incurred, 'BHD', { code: false }), formatMoney(b.total.paid, 'BHD', { code: false }), b.total.eac === null ? 'inputs missing' : formatMoney(b.total.eac, 'BHD', { code: false }), '']]);
      p('Committed = contracts and orders. Incurred = approved invoices plus confirmed payments without an invoice. Paid = confirmed payments only. EAC = incurred + open commitments + forecast uncommitted cost.', { size: 8, color: MUTED });
      const pend = fin.payments.filter(x => x.status === 'pending');
      if (pend.length) p(`${pend.length} payment(s) totalling ${fm(pend.reduce((s, x) => s + num(x.amount_minor), 0))} are recorded but not yet confirmed and are excluded from Paid.`, { size: 8.5, color: '#7A4F0C' });
    }
    const risks = regs.filter(x => x.kind === 'risk' && x.status !== 'closed');
    if (risks.length) { h2('Open risks'); table([['Risk', 0.45], ['Likelihood', 0.15], ['Impact', 0.15], ['Owner', 0.25]], risks.map(x => [x.title, x.likelihood || '—', x.impact || '—', x.owner_text || ''])); }
    h2(`Progress updates (${per.label})`);
    if (!updates.length) p('No published updates in this period.', { color: MUTED });
    for (const u of updates) {
      if (doc.y > doc.page.height - 160) doc.addPage();
      p(`${fmtDate(u.observed_on)} · ${u.title}`, { bold: true, size: 10.5 });
      p([phaseName[u.phase_id], u.author_label, u.workforce !== null ? `${u.workforce} workers` : null].filter(Boolean).join(' · '), { size: 8.5, color: MUTED });
      if (u.completed_work) p(u.completed_work);
      if (u.remaining_work) p(`Next: ${u.remaining_work}`, { color: MUTED });
      if (u.issues) p(`Issues: ${u.issues}`, { color: '#8F2E26' });
      if (photos) {
        const imgs = u.files.filter(f => /^image\/(jpeg|png|webp)$/.test(f.mime)).slice(0, 6);
        let col = 0, rowTop = doc.y + 6; const pw = (W - 16) / 3, ph = pw * 0.72;
        for (const f of imgs) {
          const data = (await pool.query('select data from files where id = $1', [f.id])).rows[0].data;
          const jpg = await sharp(data).rotate().resize(900, 900, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 72 }).toBuffer();
          if (col === 0 && rowTop + ph + 20 > doc.page.height - 60) { doc.addPage(); rowTop = 60; }
          const x = 48 + col * (pw + 8);
          doc.image(jpg, x, rowTop, { fit: [pw, ph], align: 'center', valign: 'center' });
          if (f.caption) doc.font('body').fontSize(7.5).fillColor(MUTED).text(f.caption, x, rowTop + ph + 2, { width: pw });
          col++; if (col === 3) { col = 0; rowTop += ph + 22; }
        }
        doc.x = 48; doc.y = col === 0 ? rowTop : rowTop + ph + 22;
      }
      doc.moveDown(0.6);
    }
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const keepBottom = doc.page.margins.bottom; doc.page.margins.bottom = 0;   // the footer sits below the margin; without this pdfkit starts a new, empty page
      doc.font('body').fontSize(7.5).fillColor(MUTED).text(`SarayDar Management System · ${a.ws.ref} · page ${i + 1} of ${range.count}`, 48, doc.page.height - 36, { width: W, align: 'right', lineBreak: false });
      doc.page.margins.bottom = keepBottom;
    }
    await core.audit(null, { actor: req.user, workspaceId: a.ws.id, action: 'report.pdf', entity: 'report', entityId: a.ws.id, summary: `PDF report downloaded (${per.label})`, ip: req.ip });
    doc.end();
  });
}

module.exports = { mountProjectExports, safe };
