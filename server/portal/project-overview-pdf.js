'use strict';
// The project Overview as a designed, landscape PDF (owner request 2026-10-28: "more visually designed rather than
// listing, and show the pipeline with stages"). Used for "PDF" on the Overview of a development or client project
// on the construction master plan; every other page keeps the general page export. Only what this user may see.
const path = require('path');
const PDFDocument = require('pdfkit');
const sharp = require('sharp');
const brand = require('../lib/pdf-brand');
const M = require('../lib/master-plan');
const { formatMoney } = require('../lib/money');
const { KIND_LABEL } = require('./core');

const FONT_DIR = path.join(__dirname, '..', 'fonts');
const INK = '#2A1C15', MUTED = '#6E5B50', ACC = '#8E4F2B', COPPER = '#D29466', LINE = '#E6D9CD', SOFT = '#F6F0EA', TILE = '#FBF7F3';
const GREEN = '#2F7D4F', RED = '#8F2E26', GREY = '#E4DAD0';
const plain = s => String(s ?? '').replace(/[^\u0000-ɏ‐-‧‰-⁞€™²³×✓]/g, '');
const fmtD = d => d ? new Date(String(d).slice(0, 10) + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : null;
const iso = d => d ? (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)) : null;
const pct = v => v === null || v === undefined ? '—' : `${Math.round(v * 10) / 10}%`;

function mountProjectOverviewPdf(r, ctx, P) {
  const { pool, core } = ctx;

  r.get('/w/:id', async (req, res, next) => {
    if (req.query.export !== 'pdf' || !/^[0-9a-f-]{36}$/i.test(req.params.id)) return next();
    let a;
    try { a = await core.workspaceAccess(req.user, req.params.id); } catch (e) { return next(); }
    if (!a || !a.internal || !['dev', 'cpm'].includes(a.ws.section) || !ctx.masterOf || !(await ctx.masterOf(a.ws.id))) return next();
    a = await P.access(req);
    const w = a.ws;
    const m = await P.metrics(w.id);
    const c = M.compute(m.phases, m.tasks);
    const party = w.party_id ? (await pool.query('select name from parties where id = $1', [w.party_id])).rows[0] : null;
    const mgr = w.manager_id ? (await pool.query("select coalesce(nullif(name,''), email) as n from users where id = $1", [w.manager_id])).rows[0] : null;
    const bs = a.finance && !P.clientBudget(w) ? await P.budgetSummary(w.id) : null;
    const upd = (await pool.query(`select u.*, (select array_agg(f.id order by f.uploaded_at) from files f where f.entity = 'progress_update' and f.entity_id = u.id::text and f.archived_at is null and f.thumb is not null) as photos
      from progress_updates u where u.workspace_id = $1 and u.status = 'published' and u.archived_at is null order by u.observed_on desc, u.created_at desc limit 1`, [w.id])).rows[0];
    const thumbs = [];
    for (const id of ((upd && upd.photos) || []).slice(0, 3)) {
      const f = (await pool.query('select thumb from files where id = $1 and workspace_id = $2', [id, w.id])).rows[0];
      if (f && f.thumb) try { thumbs.push(await sharp(f.thumb).jpeg({ quality: 82 }).toBuffer()); } catch (e) { /* skip an unreadable thumbnail */ }
    }
    const when = new Date(), who = req.user.name || req.user.email;
    const buf = await draw({ w, m, c, party, mgr, bs, upd, thumbs, when, who, finance: a.finance, clientBudget: P.clientBudget(w) });
    await core.audit(null, { actor: req.user, workspaceId: w.id, action: 'export.pdf', entity: 'page', entityId: req.path.slice(0, 200), summary: `Exported “${w.name} · Overview” as PDF`, ip: req.ip });
    const dl = require('../lib/download');
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': dl.disposition(dl.fileName([w.ref, w.name, 'Overview', iso(when)], 'pdf'), req.query.view === '1'), 'Cache-Control': 'private, no-store' });
    res.end(buf);
  });
}

function draw({ w, m, c, party, mgr, bs, upd, thumbs, when, who, finance, clientBudget }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 28, bufferPages: true, info: { Title: `${w.ref} ${w.name} Overview`, Author: 'SarayDar Management System' } });
    const chunks = []; doc.on('data', x => chunks.push(x)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    doc.registerFont('body', path.join(FONT_DIR, 'ibm-plex-sans-latin-400-normal.ttf'));
    doc.registerFont('medium', path.join(FONT_DIR, 'ibm-plex-sans-latin-500-normal.ttf'));
    doc.registerFont('bold', path.join(FONT_DIR, 'ibm-plex-sans-latin-600-normal.ttf'));
    doc.registerFont('display', path.join(FONT_DIR, 'ibm-plex-sans-latin-600-normal.ttf'));
    const X = 28, W = doc.page.width - 56, PH = doc.page.height;
    brand.band(doc, { title: 'Project overview', sub: plain(`${w.section === 'cpm' ? 'Clients Projects Management' : 'SarayDar Real Estate Development'} › ${w.name}`), right: [[plain(`${w.ref} · ${w.name}`), { bold: true, size: 11 }]], x: X, width: W });
    const T = (t, x, y, o = {}) => doc.font(o.font || 'body').fontSize(o.size || 9).fillColor(o.color || INK).text(plain(t), x, y, { lineBreak: o.wrap !== false ? undefined : false, width: o.width, align: o.align, height: o.height, ellipsis: o.ellipsis, lineGap: o.lineGap });
    const box = (x, y, bw, bh, fill = TILE) => { doc.save().roundedRect(x, y, bw, bh, 8).fill(fill).restore(); doc.save().roundedRect(x, y, bw, bh, 8).lineWidth(0.8).strokeColor(LINE).stroke().restore(); };
    const bar = (x, y, bw, v, color = COPPER, h = 6) => { doc.save().roundedRect(x, y, bw, h, h / 2).fill(GREY).restore(); if (v > 0) doc.save().roundedRect(x, y, Math.max(h, bw * Math.min(100, v) / 100), h, h / 2).fill(color).restore(); };

    // ---- the project ----
    let y = 116;
    T(w.name, X, y, { font: 'display', size: 19, width: W * 0.7, wrap: false, ellipsis: true });
    const facts = [KIND_LABEL[w.kind], party ? `Client: ${party.name}` : null, w.location, mgr ? `Manager: ${mgr.n}` : null, w.stage ? `Stage: ${w.stage}` : null].filter(Boolean).join('   ·   ');
    T(facts, X, y + 25, { size: 9, color: MUTED, width: W * 0.78, wrap: false, ellipsis: true });
    const st = { active: 'Active', on_hold: 'On hold', completed: 'Completed', archived: 'Archived' }[w.status] || w.status;
    doc.font('bold').fontSize(9); const sw = doc.widthOfString(st) + 20;
    doc.save().roundedRect(X + W - sw, y + 4, sw, 20, 10).fill(w.status === 'active' ? '#E3EFE6' : SOFT).restore();
    T(st, X + W - sw, y + 9.5, { font: 'bold', size: 9, color: w.status === 'active' ? GREEN : MUTED, width: sw, align: 'center' });

    // ---- indicator tiles ----
    y = 162;
    const gap = 12, tw = (W - 3 * gap) / 4, th = 74;
    const tiles = [];
    tiles.push({ label: 'Overall progress', value: c.valid ? pct(c.pct) : 'Not available', bar: c.valid ? c.pct : null, sub: c.valid ? 'Weighted by the master plan' : 'Plan weights are incomplete' });
    tiles.push({ label: 'Stages', value: `${c.stages.filter(s => s.status === 'done').length} of ${c.stages.length} completed`, sub: `${c.stages.filter(s => s.status === 'in_progress').length} in progress · ${c.stages.filter(s => s.status === 'on_hold').length} on hold` });   // owner removed "construction to handover" (2026-10-28)
    const n = s => m.tasks.filter(t => s.includes(t.status)).length;
    tiles.push({ label: 'Tasks', value: `${n(['done'])} of ${m.tasks.length} done`, sub: `${n(['in_progress'])} in progress · ${m.overdue.length} overdue${n(['on_hold', 'blocked']) ? ` · ${n(['on_hold', 'blocked'])} on hold` : ''}`, alert: m.overdue.length > 0 });
    if (bs && bs.total) tiles.push({ label: w.section === 'cpm' ? 'Client budget' : 'Budget', value: bs.total.revised === null ? 'Not set' : formatMoney(bs.total.revised), sub: `Committed ${formatMoney(bs.total.committed)} · Paid ${formatMoney(bs.total.paid)}` });
    else tiles.push({ label: 'Open risks', value: String(m.risks.open), sub: `${m.risks.high} with high impact`, alert: m.risks.high > 0 });
    tiles.forEach((t, i) => {
      const x = X + i * (tw + gap);
      box(x, y, tw, th);
      T(t.label.toUpperCase(), x + 14, y + 12, { font: 'bold', size: 7.5, color: MUTED, width: tw - 28, characterSpacing: 0.4 });
      T(t.value, x + 14, y + 25, { font: 'display', size: 17, color: INK, width: tw - 28, wrap: false, ellipsis: true });
      if (t.bar !== undefined && t.bar !== null) bar(x + 14, y + 50, tw - 28, t.bar);
      T(t.sub, x + 14, y + (t.bar !== undefined && t.bar !== null ? 59 : 52), { size: 7.5, color: t.alert ? RED : MUTED, width: tw - 28, wrap: false, ellipsis: true });
    });

    // ---- the stage pipeline ----
    y = 250;
    const ph = 98;
    box(X, y, W, ph, '#FFFFFF');
    T('CONSTRUCTION STAGES', X + 16, y + 12, { font: 'bold', size: 8, color: ACC });
    const active = c.stages.filter(s => s.status === 'in_progress').map(s => s.name);
    T(active.length ? `In progress: ${active.join(', ')}` : c.stages.length && c.stages.every(s => s.status === 'done') ? 'All stages completed' : 'No stage in progress yet', X + 160, y + 12, { size: 8, color: MUTED, width: W - 176, align: 'right', wrap: false, ellipsis: true });
    const N = c.stages.length || 1, slot = (W - 32) / N, cy = y + 46, R = 15;
    c.stages.forEach((s, i) => {
      const cx = X + 16 + slot * i + slot / 2;
      if (i > 0) {
        const prev = c.stages[i - 1];
        doc.save().moveTo(cx - slot + R + 3, cy).lineTo(cx - R - 3, cy).lineWidth(3).strokeColor(prev.status === 'done' ? (s.status === 'done' ? GREEN : s.status === 'in_progress' ? GREEN : GREY) : GREY).stroke().restore();
      }
      const p = s.pct === null ? 0 : Math.round(s.pct);
      if (s.status === 'done') {
        doc.save().circle(cx, cy, R).fill(GREEN).restore();
        doc.save().moveTo(cx - 6, cy + 0.5).lineTo(cx - 1.5, cy + 5).lineTo(cx + 6.5, cy - 4.5).lineWidth(2.2).lineCap('round').lineJoin('round').strokeColor('#FFFFFF').stroke().restore();
      } else {
        const col = s.status === 'on_hold' ? RED : s.status === 'in_progress' ? ACC : '#CBBBAE';
        doc.save().circle(cx, cy, R - 1.5).lineWidth(3).strokeColor(GREY).stroke().restore();
        if (p > 0) {
          const a0 = -Math.PI / 2, a1 = a0 + 2 * Math.PI * Math.min(p, 99.9) / 100, rr = R - 1.5;
          const large = a1 - a0 > Math.PI ? 1 : 0;
          doc.save().path(`M ${cx + rr * Math.cos(a0)} ${cy + rr * Math.sin(a0)} A ${rr} ${rr} 0 ${large} 1 ${cx + rr * Math.cos(a1)} ${cy + rr * Math.sin(a1)}`).lineWidth(3).lineCap('round').strokeColor(col).stroke().restore();
        }
        T(`${p}%`, cx - R, cy - 4.2, { font: 'bold', size: 7.5, color: s.status === 'not_started' ? MUTED : col, width: 2 * R, align: 'center' });
      }
      T(s.name, cx - slot / 2 + 3, cy + R + 7, { font: s.status === 'in_progress' ? 'bold' : 'body', size: 7.5, color: s.status === 'in_progress' ? ACC : s.status === 'not_started' ? MUTED : INK, width: slot - 6, align: 'center', height: 20, lineGap: -0.5 });
    });

    // ---- two columns: stage table | milestone and latest update ----
    y = 360;
    const lw = W * 0.6, rx = X + lw + 14, rw = W - lw - 14, bottom = PH - 52;
    box(X, y, lw, bottom - y, '#FFFFFF');
    const cols = [{ t: 'Stage', w: 0.33 }, { t: 'Weight', w: 0.09, r: true }, { t: 'Planned', w: 0.24 }, { t: 'Progress', w: 0.24 }, { t: '%', w: 0.1, r: true }];
    let cx0 = X + 14; const iw = lw - 28;
    cols.forEach(cl => { T(cl.t.toUpperCase(), cx0, y + 11, { font: 'bold', size: 7, color: MUTED, width: cl.w * iw - 6, align: cl.r ? 'right' : 'left' }); cx0 += cl.w * iw; });
    doc.save().moveTo(X + 14, y + 23).lineTo(X + lw - 14, y + 23).lineWidth(0.6).strokeColor(LINE).stroke().restore();
    const rowH = Math.min(16.5, (bottom - y - 32) / Math.max(1, c.stages.length));
    c.stages.forEach((s, i) => {
      const ry = y + 28 + i * rowH; let x = X + 14;
      const ph = m.phases.find(p => p.id === s.id) || {};
      const ts = m.tasks.filter(t => t.phase_id === s.id);
      const ps = iso(ph.planned_start) || ts.map(t => iso(t.start_date)).filter(Boolean).sort()[0], pe = iso(ph.planned_end) || ts.map(t => iso(t.due_date)).filter(Boolean).sort().slice(-1)[0];
      const col = s.status === 'done' ? GREEN : s.status === 'on_hold' ? RED : COPPER;
      doc.save().circle(x + 3, ry + 4.5, 2.6).fill(s.status === 'not_started' ? '#CBBBAE' : col).restore();
      T(s.name, x + 10, ry, { size: 8, width: cols[0].w * iw - 16, wrap: false, ellipsis: true, font: s.status === 'in_progress' ? 'medium' : 'body' }); x += cols[0].w * iw;
      T(s.weight === null ? '—' : `${s.weight}%`, x, ry, { size: 8, color: MUTED, width: cols[1].w * iw - 6, align: 'right' }); x += cols[1].w * iw;
      T(ps || pe ? `${fmtD(ps) || '—'} – ${fmtD(pe) || '…'}` : 'Not scheduled', x + 6, ry, { size: 7.5, color: MUTED, width: cols[2].w * iw - 8, wrap: false, ellipsis: true }); x += cols[2].w * iw;
      bar(x + 4, ry + 2.5, cols[3].w * iw - 12, s.pct || 0, col, 5); x += cols[3].w * iw;
      T(s.pct === null ? '—' : `${Math.round(s.pct)}%`, x, ry, { font: 'bold', size: 8, color: s.status === 'done' ? GREEN : INK, width: cols[4].w * iw - 2, align: 'right' });
    });

    // right column: next milestone, then the latest published update with photos
    const mh = 64;
    box(rx, y, rw, mh);
    T('NEXT MILESTONE', rx + 14, y + 11, { font: 'bold', size: 7.5, color: MUTED });
    T(m.next ? m.next.title : 'No open milestone', rx + 14, y + 24, { font: 'bold', size: 10, width: rw - 28, height: 26, ellipsis: true });
    T(m.next ? (m.next.due_date ? `Due ${fmtD(m.next.due_date)}` : 'Due date not yet set') + (m.next.owner_text ? ` · ${m.next.owner_text}` : '') : '', rx + 14, y + 48, { size: 7.5, color: MUTED, width: rw - 28, wrap: false, ellipsis: true });
    const uy = y + mh + 10, uh = bottom - uy;
    box(rx, uy, rw, uh);
    T('LATEST PUBLISHED UPDATE', rx + 14, uy + 11, { font: 'bold', size: 7.5, color: MUTED });
    if (upd) {
      T(upd.title, rx + 14, uy + 24, { font: 'bold', size: 9.5, width: rw - 28, wrap: false, ellipsis: true });
      T(`Observed ${fmtD(upd.observed_on)}${upd.author_label ? ` · ${upd.author_label}` : ''}${upd.reported_progress !== null && upd.reported_progress !== undefined ? ` · ${upd.reported_progress}%` : ''}`, rx + 14, uy + 38, { size: 7.5, color: MUTED, width: rw - 28, wrap: false, ellipsis: true });
      const ph2 = thumbs.length ? 62 : 0;
      const textH = uh - 54 - (ph2 ? ph2 + 8 : 0) - 8;
      if (upd.completed_work && textH > 12) T(upd.completed_work, rx + 14, uy + 52, { size: 8, width: rw - 28, height: textH, ellipsis: true });
      if (thumbs.length) {
        const g = 6, tw2 = (rw - 28 - g * 2) / 3;
        thumbs.forEach((b, i) => { const tx = rx + 14 + i * (tw2 + g), ty = uy + uh - ph2 - 10; doc.save().roundedRect(tx, ty, tw2, ph2, 5).clip(); try { doc.image(b, tx, ty, { cover: [tw2, ph2], align: 'center', valign: 'center' }); } catch (e) { /* skip */ } doc.restore(); });
      }
    } else T('No published updates yet.', rx + 14, uy + 26, { size: 8.5, color: MUTED, width: rw - 28 });

    brand.footer(doc, { lines: [plain(`SarayDar Management System · ${w.ref} · ${w.name}`), plain(`Exported ${when.toLocaleString('en-GB', { timeZone: 'Asia/Bahrain' })} by ${who} · weights and durations are suggested defaults, not a contract payment schedule`)] });
    doc.end();
  });
}

module.exports = { mountProjectOverviewPdf };
