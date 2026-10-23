'use strict';
// Project-specific investors and funding (spec 6.8). An investor participates in one development project through
// a participation record. A contribution never creates an equity percentage, profit entitlement or return by
// itself: those terms are recorded only as documented. Reported transfers stay separate from confirmed receipts,
// and only a confirmed contribution receives a numbered acknowledgment. Recording a return or distribution
// records a payment already made outside the system; nothing here moves money.
const { html, raw, pill, csrfField, field, emptyState, fmtDate, fmtDateTime, layout } = require('./views');
const crypto = require('crypto');
const { parseMoney, formatMoney, toInput } = require('../lib/money');
const { todayBH } = require('../lib/billing');

const UUID = /^[0-9a-f-]{36}$/i;
const bad = m => Object.assign(new Error(m), { status: 400 });
const txt = (v, n = 300) => { const s = String(v ?? '').trim().slice(0, n); return s || null; };
const dateOrNull = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : null;
const iso = d => d ? String(d).slice(0, 10) : null;
const fm = (m, c = 'BHD') => m === null || m === undefined ? '—' : formatMoney(Number(m), c);
const TYPE = { equity: 'Equity', loan: 'Loan', profit_share: 'Profit share', other: 'Other documented arrangement', unconfirmed: 'Not yet confirmed' };
const KIND = { contribution: 'Contribution', capital_return: 'Capital returned', distribution: 'Profit distribution', adjustment: 'Adjustment' };
const ST_TONE = { reported: 'warn', confirmed: 'ok', rejected: 'muted', reversed: 'muted' };
const ST = { reported: 'Reported — not yet confirmed', confirmed: 'Confirmed', rejected: 'Rejected', reversed: 'Reversed' };

// Figures for one participation as at a date. Definitions (shown on screen):
//   received = confirmed contributions ± confirmed adjustments; capital returned and distributions kept apart;
//   outstanding commitment = committed − received (not below zero); overdue = installments due by the date − received;
//   net capital invested = received − capital returned. Distributions are profit paid out and do not reduce capital.
function figures(p, txns, insts, asOf) {
  const ok = t => t.status === 'confirmed' && iso(t.on_date) <= asOf;
  const sum = k => txns.filter(t => t.kind === k && ok(t)).reduce((s, t) => s + Number(t.amount_minor), 0);
  const received = sum('contribution') + sum('adjustment');
  const returned = sum('capital_return'), distributed = sum('distribution');
  const pending = txns.filter(t => t.kind === 'contribution' && t.status === 'reported').reduce((s, t) => s + Number(t.amount_minor), 0);
  const committed = p.committed_minor === null ? null : Number(p.committed_minor);
  const dueToDate = insts.filter(i => iso(i.due_on) <= asOf).reduce((s, i) => s + Number(i.amount_minor), 0);
  return { committed, received, returned, distributed, pending, net: received - returned,
    outstanding: committed === null ? null : Math.max(0, committed - received), dueToDate, overdue: Math.max(0, dueToDate - received) };
}

function mountInvestors(r, ctx, P) {
  const { pool, core, NotFound, Forbidden } = ctx;

  async function access(req, need = 'view') {
    const a = await P.access(req, need === 'post' ? 'view' : need);
    if (a.ws.section !== 'dev' || !a.finance) throw new NotFound();
    a.canPost = core.isSuper(req.user) || await core.can(req.user, 'finance:post');
    if (need === 'post' && !a.canPost) throw new Forbidden('Only Finance can confirm or post investor transactions.');
    return a;
  }
  const page = (req, a, body) => P.page(req, a, 'Investors & Funding', body);
  async function load(wsId, partyId = null) {
    const parts = (await pool.query(`select p.*, y.name as investor, y.kind as investor_kind, y.email, y.phone, y.representative, ag.ref as agreement_no
        from investor_participations p join parties y on y.id = p.party_id left join agreements ag on ag.id = p.agreement_id
       where p.workspace_id = $1 ${partyId ? 'and p.party_id = $2' : ''} order by p.created_at`, partyId ? [wsId, partyId] : [wsId])).rows;
    const ids = parts.map(p => p.id);
    const txns = ids.length ? (await pool.query(`select t.*, coalesce(nullif(u.name,''), u.email) as recorder, coalesce(nullif(c.name,''), c.email) as confirmer
        from investor_txns t left join users u on u.id = t.recorded_by left join users c on c.id = t.confirmed_by where t.participation_id = any($1) order by t.on_date, t.recorded_at`, [ids])).rows : [];
    const insts = ids.length ? (await pool.query('select * from investor_installments where participation_id = any($1) order by due_on', [ids])).rows : [];
    for (const p of parts) { p.txns = txns.filter(t => t.participation_id === p.id); p.insts = insts.filter(i => i.participation_id === p.id); }
    return parts;
  }
  const ownPart = async (id, wsId) => {
    if (!UUID.test(String(id))) throw new NotFound();
    const p = (await pool.query('select * from investor_participations where id = $1 and workspace_id = $2', [id, wsId])).rows[0];
    if (!p) throw new NotFound();
    return p;
  };

  // ---------- statement (shared by staff, the PDF/Excel export and the investor portal) ----------
  function statementOf(p, from, to) {
    const lines = [];
    const OUT = new Set(['capital_return', 'distribution']);
    for (const t of p.txns) {
      if (!['confirmed', 'reversed'].includes(t.status)) continue;
      const amt = Number(t.amount_minor);
      const cap = t.kind === 'distribution' ? 0 : OUT.has(t.kind) ? -amt : amt;     // effect on net capital
      const io = OUT.has(t.kind) ? { pin: 0, pout: amt } : amt >= 0 ? { pin: amt, pout: 0 } : { pin: 0, pout: -amt };
      lines.push({ date: iso(t.on_date), text: `${KIND[t.kind]}${t.ack_no ? ` — acknowledgment ${t.ack_no}` : ''}${t.reference ? ` · ref ${t.reference}` : ''}${t.method ? ` · ${t.method}` : ''}`, cap, ...io });
      if (t.status === 'reversed') lines.push({ date: iso(t.on_date), text: `Reversal of ${KIND[t.kind].toLowerCase()}: ${t.reverse_reason || ''}`, cap: -cap, pin: io.pout, pout: io.pin });
    }
    lines.sort((x, y) => x.date.localeCompare(y.date));
    let opening = 0; const rows = [];
    for (const l of lines) { if (from && l.date < from) opening += l.cap; else if (!to || l.date <= to) rows.push(l); }
    let bal = opening; for (const l of rows) { bal += l.cap; l.balance = bal; }
    return { opening, rows, closing: bal };
  }
  function statementHtml(p, per, { external }) {
    const f = figures(p, p.txns, p.insts, per.to);
    const st = statementOf(p, per.from, per.to);
    return html`<section class="panel"><h2 class="h">${p.investor} · ${p.ref}</h2>
      <dl class="details"><div><dt>Participation</dt><dd>${TYPE[p.participation]}${p.terms_confirmed ? '' : html` <span class="muted small">(terms not yet confirmed)</span>`}</dd></div>
        <div><dt>Agreement</dt><dd>${p.agreement_ref || p.agreement_no || html`<span class="muted">Not recorded</span>`}</dd></div>
        ${p.ownership_terms ? html`<div><dt>Ownership / funding share</dt><dd>${p.ownership_terms}</dd></div>` : ''}
        ${p.profit_terms ? html`<div><dt>Profit-sharing terms</dt><dd>${p.profit_terms}</dd></div>` : ''}
        ${p.return_terms ? html`<div><dt>Capital return terms</dt><dd>${p.return_terms}</dd></div>` : ''}</dl>
      <dl class="stats inline">
        <div><dt>Agreed contribution</dt><dd>${f.committed === null ? 'Not recorded' : fm(f.committed, p.currency)}</dd></div>
        <div><dt>Received (confirmed)</dt><dd>${fm(f.received, p.currency)}</dd></div>
        <div><dt>Outstanding commitment</dt><dd>${f.outstanding === null ? '—' : fm(f.outstanding, p.currency)}</dd></div>
        <div><dt>Overdue at ${fmtDate(per.to)}</dt><dd class="${f.overdue ? 'err' : ''}">${fm(f.overdue, p.currency)}</dd></div>
        <div><dt>Capital returned</dt><dd>${fm(f.returned, p.currency)}</dd></div>
        <div><dt>Profit distributed</dt><dd>${fm(f.distributed, p.currency)}</dd></div>
        <div><dt>Net capital invested</dt><dd>${fm(f.net, p.currency)}</dd></div>
        ${f.pending ? html`<div><dt>Reported, awaiting confirmation</dt><dd>${fm(f.pending, p.currency)}</dd></div>` : ''}</dl>
      <h3 class="h3">Statement ${per.label}</h3>
      <div class="table-wrap"><table><thead><tr><th>Date</th><th>Details</th><th class="n">Paid in</th><th class="n">Paid out</th><th class="n">Net capital</th></tr></thead><tbody>
        <tr><td></td><td><b>Opening net capital</b></td><td></td><td></td><td class="n">${fm(st.opening, p.currency)}</td></tr>
        ${st.rows.map(l => html`<tr><td class="small">${fmtDate(l.date)}</td><td class="small">${l.text}</td><td class="n">${l.pin ? fm(l.pin, p.currency) : ''}</td><td class="n">${l.pout ? fm(l.pout, p.currency) : ''}</td><td class="n">${fm(l.balance, p.currency)}</td></tr>`)}
        <tr class="total"><td></td><td>Closing net capital</td><td></td><td></td><td class="n">${fm(st.closing, p.currency)}</td></tr></tbody></table></div>
      ${p.insts.length ? html`<h3 class="h3">Agreed payment schedule</h3><div class="table-wrap"><table><thead><tr><th>Due</th><th class="n">Amount</th><th>Note</th></tr></thead><tbody>
        ${p.insts.map(i => html`<tr><td>${fmtDate(i.due_on)}</td><td class="n">${fm(i.amount_minor, p.currency)}</td><td class="small">${i.note || ''}</td></tr>`)}</tbody></table></div>` : ''}
      <p class="muted small">Net capital = confirmed contributions and adjustments less capital returned. Profit distributions are shown as paid out but do not reduce capital. Only confirmed receipts are included; transfers reported but not yet confirmed are listed separately.${external ? ' Figures are recorded by SarayDar; they are not a forecast or a promise of returns.' : ''}</p>
    </section>`;
  }
  const periodFrom = q => {
    const from = dateOrNull(q.from), to = dateOrNull(q.to) || todayBH();
    if (from && to < from) throw bad('The end date is before the start date.');
    return { from, to, label: `${from ? fmtDate(from) : 'from the start'} to ${fmtDate(to)}` };
  };
  const periodForm = (per, hidden = '') => html`<form class="filters" method="get">${raw(hidden)}<label class="small">From <input type="date" name="from" value="${per.from || ''}"></label><label class="small">To <input type="date" name="to" value="${per.to}"></label><button class="btn" type="submit">Apply</button></form>`;

  // used by the investor portal: only this investor's participations in this project
  ctx.investorStatement = async (req, ws, partyId, { qs = '' } = {}) => {
    const per = periodFrom(req.query);
    const parts = await load(ws.id, partyId);
    const hidden = qs ? [...new URLSearchParams(qs.slice(1))].map(([k, v]) => `<input type="hidden" name="${k.replace(/[^\w]/g, '')}" value="${String(v).replace(/[^\w-]/g, '')}">`).join('') : '';
    return parts.length ? html`${periodForm(per, hidden)}${parts.map(p => statementHtml(p, per, { external: true }))}`
      : emptyState('No investment recorded', 'SarayDar has not recorded a participation for you in this project.');
  };

  // ---------- the Investors & Funding tab ----------
  r.get('/w/:id/investors', async (req, res) => {
    const a = await access(req);
    const parts = await load(a.ws.id);
    const today = todayBH();
    const parties = (await pool.query("select id, name from parties where archived_at is null and merged_into is null order by name limit 1000")).rows;
    const agreements = (await pool.query('select id, ref, title from agreements where workspace_id = $1 order by created_at desc', [a.ws.id]).catch(() => ({ rows: [] }))).rows;
    const rows = parts.map(p => ({ p, f: figures(p, p.txns, p.insts, today) }));
    const tot = k => rows.filter(x => x.p.currency === 'BHD' && x.p.status !== 'withdrawn').reduce((s, x) => s + (x.f[k] || 0), 0);
    const pending = parts.flatMap(p => p.txns.filter(t => t.status === 'reported').map(t => ({ ...t, p })));
    const id = a.ws.id;
    res.send(page(req, a, html`
      <section class="grid-cards" aria-label="Funding summary">
        <div class="card"><div class="muted small">Committed by investors</div><div class="big">${fm(tot('committed'))}</div><div class="muted small">${parts.filter(p => p.status !== 'withdrawn').length} participation(s)</div></div>
        <div class="card"><div class="muted small">Received (confirmed)</div><div class="big">${fm(tot('received'))}</div><div class="muted small">Pending confirmation ${fm(tot('pending'))}</div></div>
        <div class="card"><div class="muted small">Outstanding commitments</div><div class="big">${fm(tot('outstanding'))}</div><div class="muted small ${tot('overdue') ? 'err' : ''}">Overdue ${fm(tot('overdue'))}</div></div>
        <div class="card"><div class="muted small">Returned / distributed</div><div class="big">${fm(tot('returned'))}</div><div class="muted small">Distributions ${fm(tot('distributed'))}</div></div>
      </section>
      <div class="notice info">Investor money is project financing. It is not sale revenue, not a SarayDar fee and does not reduce construction cost. SarayDar's own funding is whatever the project needs beyond confirmed investor money; it is not derived here. Totals above are in BHD.</div>
      <section class="panel"><h2 class="h">Funding by source</h2>${rows.length ? html`<div class="table-wrap"><table><thead><tr><th>Investor</th><th>Type</th><th class="n">Committed</th><th class="n">Received</th><th class="n">Remaining</th><th class="n">Overdue</th><th class="n">Net capital</th><th></th></tr></thead><tbody>
        ${rows.map(({ p, f }) => html`<tr class="${p.status === 'withdrawn' ? 'dim' : ''}"><td><a href="/w/${id}/investors/${p.id}"><b>${p.investor}</b></a><div class="muted small">${p.ref}${p.status !== 'active' ? ` · ${p.status}` : ''}</div></td><td class="small">${TYPE[p.participation]}</td>
          <td class="n">${fm(f.committed, p.currency)}</td><td class="n">${fm(f.received, p.currency)}</td><td class="n">${fm(f.outstanding, p.currency)}</td><td class="n ${f.overdue ? 'err' : ''}">${fm(f.overdue, p.currency)}</td><td class="n">${fm(f.net, p.currency)}</td>
          <td><a class="btn small" href="/w/${id}/investors/${p.id}">Open</a></td></tr>`)}
        </tbody></table></div>` : emptyState('No investors recorded', 'This project is treated as funded by SarayDar until an investor participation is recorded.')}</section>
      ${pending.length ? html`<section class="panel"><h2 class="h">Reported transfers awaiting confirmation</h2><ul class="rows">${pending.map(t => html`<li><div class="grow"><b>${t.p.investor}</b> · ${KIND[t.kind]} ${fm(t.amount_minor, t.currency)}<div class="muted small">${fmtDate(t.on_date)} · ref ${t.reference || '—'} · recorded by ${t.recorder || '—'}</div></div><a class="btn small" href="/w/${id}/investors/${t.participation_id}">Review</a></li>`)}</ul></section>` : ''}
      ${core.canEdit(a) ? html`<details class="panel inline-form"><summary>Add an investor participation</summary>
        <form method="post" action="/w/${id}/investors" class="form-grid">${csrfField(req)}
          ${field({ name: 'party', label: 'Investor (existing contact)', options: [['', 'New investor — enter below'], ...parties.map(x => [x.id, x.name])] })}
          ${field({ name: 'new_name', label: 'New investor name', attrs: 'maxlength="160"' })}
          ${field({ name: 'new_kind', label: 'Individual or company', options: [['person', 'Individual'], ['company', 'Company']] })}
          ${field({ name: 'new_email', label: 'Email', type: 'email' })}${field({ name: 'new_phone', label: 'Phone' })}${field({ name: 'new_rep', label: 'Authorised representative' })}
          ${field({ name: 'participation', label: 'Participation type', options: Object.entries(TYPE), value: 'unconfirmed' })}
          ${field({ name: 'currency', label: 'Currency', options: [['BHD', 'BHD'], ['USD', 'USD'], ['SAR', 'SAR'], ['AED', 'AED']] })}
          ${field({ name: 'committed', label: 'Agreed contribution', hint: 'Leave empty if not yet agreed.' })}
          ${field({ name: 'agreement_ref', label: 'Agreement reference' })}
          ${agreements.length ? field({ name: 'agreement_id', label: 'Linked agreement in this project', options: [['', 'None'], ...agreements.map(g => [g.id, `${g.ref || ''} ${g.title || ''}`])] }) : ''}
          ${field({ name: 'start_date', label: 'Start date', type: 'date' })}${field({ name: 'end_date', label: 'End date', type: 'date' })}
          ${field({ name: 'ownership_terms', label: 'Ownership / funding share (as documented)', type: 'textarea', full: true })}
          ${field({ name: 'profit_terms', label: 'Profit-sharing terms (as documented)', type: 'textarea', full: true })}
          ${field({ name: 'return_terms', label: 'Capital return terms (as documented)', type: 'textarea', full: true })}
          <label class="field full check"><input type="checkbox" name="terms_confirmed" value="1"> <span>The terms above match the signed agreement</span></label>
          <div class="actions full"><button class="btn primary" type="submit">Add participation</button></div>
          <p class="muted small full">A contribution does not create an ownership percentage or a right to profit. Record those only as stated in the agreement. Being an investor does not give portal access; invite them separately from Access & Invitations.</p>
        </form></details>` : ''}`));
  });

  r.post('/w/:id/investors', async (req, res) => {
    const a = await access(req, 'edit');
    const cur = ['BHD', 'USD', 'SAR', 'AED'].includes(req.body.currency) ? req.body.currency : 'BHD';
    const committed = txt(req.body.committed, 30) ? parseMoney(req.body.committed, cur) : null;
    if (txt(req.body.committed, 30) && (committed === null || committed < 0)) throw bad('Enter the agreed contribution as an amount, or leave it empty.');
    const participation = Object.keys(TYPE).includes(req.body.participation) ? req.body.participation : 'unconfirmed';
    const start = dateOrNull(req.body.start_date), end = dateOrNull(req.body.end_date);
    if (start && end && end < start) throw bad('The end date is before the start date.');
    const agreementId = UUID.test(String(req.body.agreement_id || '')) ? req.body.agreement_id : null;
    const id = await core.inTx(async db => {
      let partyId = UUID.test(String(req.body.party || '')) ? req.body.party : null;
      if (partyId) {
        if (!(await db.query('select 1 from parties where id = $1 and archived_at is null', [partyId])).rowCount) throw bad('That contact was not found.');
        await db.query("update parties set roles = array(select distinct unnest(roles || '{investor}'::text[])) where id = $1", [partyId]);
      } else {
        const name = txt(req.body.new_name, 160); if (!name) throw bad('Choose an investor or enter a new investor name.');
        partyId = (await db.query(`insert into parties (kind, name, email, phone, representative, roles, created_by) values ($1,$2,$3,$4,$5,'{investor}',$6) returning id`,
          [req.body.new_kind === 'company' ? 'company' : 'person', name, txt(req.body.new_email, 200), txt(req.body.new_phone, 40), txt(req.body.new_rep, 160), req.user.id])).rows[0].id;
      }
      if (agreementId && !(await db.query('select 1 from agreements where id = $1 and workspace_id = $2', [agreementId, a.ws.id])).rowCount) throw bad('That agreement is not in this project.');
      const ref = `INV-${a.ws.ref}-${String(await core.nextNumber(db, `investor:${a.ws.id}`)).padStart(2, '0')}`;
      const pid = (await db.query(`insert into investor_participations (workspace_id, party_id, ref, agreement_ref, agreement_id, participation, currency, committed_minor, start_date, end_date, ownership_terms, profit_terms, return_terms, terms_confirmed, created_by)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning id`,
        [a.ws.id, partyId, ref, txt(req.body.agreement_ref, 120), agreementId, participation, cur, committed, start, end, txt(req.body.ownership_terms, 2000), txt(req.body.profit_terms, 2000), txt(req.body.return_terms, 2000), req.body.terms_confirmed === '1', req.user.id])).rows[0].id;
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'investor.participation_added', entity: 'investor_participation', entityId: pid, summary: `Investor participation ${ref} added${committed !== null ? ` — agreed ${formatMoney(committed, cur)}` : ''}`, after: { party: partyId, participation, committed, currency: cur }, ip: req.ip });
      return pid;
    });
    res.redirect(`/w/${a.ws.id}/investors/${id}?msg=created`);
  });

  r.get('/w/:id/investors/:pid', async (req, res) => {
    const a = await access(req);
    await ownPart(req.params.pid, a.ws.id);
    const p = (await load(a.ws.id)).find(x => x.id === req.params.pid);
    const per = periodFrom(req.query);
    const id = a.ws.id, edit = core.canEdit(a);
    const log = (await pool.query("select at, summary, actor_label from audit_events where workspace_id = $1 and (entity_id = $2 or entity_id in (select id::text from investor_txns where participation_id = $3)) order by id desc limit 50", [id, p.id, p.id])).rows;
    const portal = (await pool.query(`select u.name, u.email, m.revoked_at, u.active from workspace_members m join users u on u.id = m.user_id where m.workspace_id = $1 and m.role = 'investor_viewer' and m.grants->>'party_id' = $2`, [id, p.party_id])).rows;
    res.send(page(req, a, html`<p><a href="/w/${id}/investors">‹ Investors & Funding</a> · <a href="/investors/${p.party_id}">Investor profile</a></p>
      ${periodForm(per)}
      ${statementHtml(p, per, { external: false })}
      <section class="panel"><h2 class="h">All transactions</h2>${p.txns.length ? html`<div class="table-wrap"><table><thead><tr><th>Date</th><th>Type</th><th class="n">Amount</th><th>Reference / evidence</th><th>Status</th><th>Recorded</th><th></th></tr></thead><tbody>
        ${p.txns.map(t => html`<tr><td class="small">${fmtDate(t.on_date)}</td><td>${KIND[t.kind]}${t.ack_no ? html`<div class="mono small">${t.ack_no}</div>` : ''}</td><td class="n">${fm(t.amount_minor, t.currency)}</td>
          <td class="small">${t.method || ''}${t.reference ? ` · ${t.reference}` : ''}${t.evidence ? html`<div class="muted">${t.evidence}</div>` : ''}${t.approval_ref ? html`<div class="muted">Approval: ${t.approval_ref}</div>` : ''}${t.reverse_reason ? html`<div class="muted">${t.reverse_reason}</div>` : ''}</td>
          <td>${pill(ST[t.status], ST_TONE[t.status])}</td><td class="small">${t.recorder || '—'} · ${fmtDateTime(t.recorded_at)}${t.confirmer ? html`<div>Confirmed by ${t.confirmer}</div>` : ''}</td>
          <td class="nowrap">${a.canPost && t.status === 'reported' ? html`<form method="post" action="/w/${id}/investors/${p.id}/txns/${t.id}/confirm" class="inline">${csrfField(req)}<button class="btn small primary" type="submit">Confirm received</button></form>
            <details class="inline-form"><summary class="small">Reject</summary><form method="post" action="/w/${id}/investors/${p.id}/txns/${t.id}/reject" class="actions">${csrfField(req)}<input name="reason" placeholder="Reason" aria-label="Reason" required><button class="btn small" type="submit">Reject</button></form></details>` : ''}
            ${a.canPost && t.status === 'confirmed' ? html`<details class="inline-form"><summary class="small">Reverse</summary><form method="post" action="/w/${id}/investors/${p.id}/txns/${t.id}/reverse" class="actions">${csrfField(req)}<input name="reason" placeholder="Reason" aria-label="Reason" required><button class="btn small" type="submit">Reverse</button></form></details>` : ''}
            ${t.ack_no && t.status === 'confirmed' ? html`<a class="btn small" href="/w/${id}/investors/${p.id}/ack/${t.id}">Acknowledgment</a>` : ''}</td></tr>`)}
        </tbody></table></div>` : html`<p class="muted">No transactions yet.</p>`}</section>
      <div class="split">
        ${core.canContribute(a) ? html`<form method="post" action="/w/${id}/investors/${p.id}/txns" class="panel grow1 form-grid">${csrfField(req)}<h3 class="h3 full">Record a transfer reported by the investor</h3><input type="hidden" name="kind" value="contribution"><input type="hidden" name="idem" value="${crypto.randomUUID()}">
          ${field({ name: 'on_date', label: 'Transfer date', type: 'date', required: true, value: todayBH() })}${field({ name: 'amount', label: `Amount (${p.currency})`, required: true })}
          ${field({ name: 'method', label: 'Method', options: [['Bank transfer', 'Bank transfer'], ['Cheque', 'Cheque'], ['Cash', 'Cash'], ['Other', 'Other']] })}${field({ name: 'reference', label: 'Bank / payment reference', required: true })}
          ${field({ name: 'evidence', label: 'Evidence', hint: 'For example: bank advice of 3 Nov in Documents', full: true })}
          <div class="actions full"><button class="btn" type="submit">Record as reported</button></div><p class="muted small full">It counts as received only after Finance confirms it against the bank statement.</p></form>` : ''}
        ${a.canPost ? html`<form method="post" action="/w/${id}/investors/${p.id}/txns" class="panel grow1 form-grid">${csrfField(req)}<h3 class="h3 full">Record a return, distribution or adjustment</h3><input type="hidden" name="idem" value="${crypto.randomUUID()}">
          ${field({ name: 'kind', label: 'Type', options: [['capital_return', 'Capital returned to the investor'], ['distribution', 'Profit distribution paid'], ['adjustment', 'Adjustment (+ or −)']] })}
          ${field({ name: 'on_date', label: 'Payment date', type: 'date', required: true, value: todayBH() })}${field({ name: 'amount', label: `Amount (${p.currency})`, required: true, hint: 'Adjustments may be negative.' })}
          ${field({ name: 'reference', label: 'Bank reference', required: true })}${field({ name: 'approval_ref', label: 'Approval (who approved, when, document)', required: true, full: true })}
          ${field({ name: 'evidence', label: 'Evidence / reason', full: true })}
          <div class="actions full"><button class="btn" type="submit">Record</button></div><p class="muted small full">Records a payment already made by bank. The system does not make payments. ${p.terms_confirmed && p.profit_terms ? '' : 'Profit distributions need confirmed profit-sharing terms first.'}</p></form>` : ''}
      </div>
      ${edit ? html`<div class="split">
        <form method="post" action="/w/${id}/investors/${p.id}/installments" class="panel grow1 form-grid">${csrfField(req)}<h3 class="h3 full">Add an agreed installment</h3>
          ${field({ name: 'due_on', label: 'Due date', type: 'date', required: true })}${field({ name: 'amount', label: `Amount (${p.currency})`, required: true })}${field({ name: 'note', label: 'Note', full: true })}
          <div class="actions full"><button class="btn" type="submit">Add installment</button></div></form>
        <form method="post" action="/w/${id}/investors/${p.id}/terms" class="panel grow1 form-grid">${csrfField(req)}<h3 class="h3 full">Terms and status</h3>
          ${field({ name: 'participation', label: 'Participation type', options: Object.entries(TYPE), value: p.participation })}
          ${field({ name: 'committed', label: `Agreed contribution (${p.currency})`, value: toInput(p.committed_minor === null ? null : Number(p.committed_minor), p.currency) })}
          ${field({ name: 'status', label: 'Status', options: [['active', 'Active'], ['completed', 'Completed'], ['withdrawn', 'Withdrawn']], value: p.status })}
          ${field({ name: 'agreement_ref', label: 'Agreement reference', value: p.agreement_ref || '' })}
          ${field({ name: 'ownership_terms', label: 'Ownership / funding share', type: 'textarea', value: p.ownership_terms || '', full: true })}
          ${field({ name: 'profit_terms', label: 'Profit-sharing terms', type: 'textarea', value: p.profit_terms || '', full: true })}
          ${field({ name: 'return_terms', label: 'Capital return terms', type: 'textarea', value: p.return_terms || '', full: true })}
          <label class="field full check"><input type="checkbox" name="terms_confirmed" value="1" ${p.terms_confirmed ? raw('checked') : ''}> <span>Terms match the signed agreement</span></label>
          ${field({ name: 'change_reason', label: 'Reason for the change (approval reference)', required: true, full: true })}
          <div class="actions full"><button class="btn" type="submit">Save terms</button></div></form>
      </div>` : ''}
      <section class="panel"><h2 class="h">Portal access</h2>${portal.length ? html`<ul class="rows">${portal.map(u => html`<li><div class="grow"><b>${u.name || u.email}</b><div class="muted small">${u.email}</div></div>${u.revoked_at ? pill('Removed', 'muted') : !u.active ? pill('Deactivated', 'muted') : pill('Can view this project', 'ok')}</li>`)}</ul>`
        : html`<p class="muted">No portal account. The investment record does not depend on one.</p>`}<a class="btn small" href="/w/${id}/access">Access & Invitations</a></section>
      <section class="panel"><h2 class="h">History</h2>${log.length ? html`<ol class="feed">${log.map(e => html`<li><b>${e.summary}</b><div class="muted small">${e.actor_label} · ${fmtDateTime(e.at)}</div></li>`)}</ol>` : ''}</section>`));
  });

  r.post('/w/:id/investors/:pid/installments', async (req, res) => {
    const a = await access(req, 'edit');
    const p = await ownPart(req.params.pid, a.ws.id);
    const due = dateOrNull(req.body.due_on); if (!due) throw bad('Enter the due date.');
    const amt = parseMoney(req.body.amount, p.currency); if (!amt || amt <= 0) throw bad('Enter the amount.');
    await core.inTx(async db => {
      const id = (await db.query('insert into investor_installments (participation_id, due_on, amount_minor, note) values ($1,$2,$3,$4) returning id', [p.id, due, amt, txt(req.body.note, 200)])).rows[0].id;
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'investor.installment_added', entity: 'investor_participation', entityId: p.id, summary: `${p.ref}: installment of ${formatMoney(amt, p.currency)} due ${fmtDate(due)}`, after: { id, due, amt }, ip: req.ip });
    });
    res.redirect(`/w/${a.ws.id}/investors/${p.id}?msg=saved`);
  });

  r.post('/w/:id/investors/:pid/terms', async (req, res) => {
    const a = await access(req, 'edit');
    const p = await ownPart(req.params.pid, a.ws.id);
    const reason = txt(req.body.change_reason, 300); if (!reason) throw bad('Give the reason or approval reference for the change.');
    const committed = txt(req.body.committed, 30) ? parseMoney(req.body.committed, p.currency) : null;
    if (txt(req.body.committed, 30) && (committed === null || committed < 0)) throw bad('Enter the agreed contribution as an amount.');
    const after = { participation: Object.keys(TYPE).includes(req.body.participation) ? req.body.participation : p.participation, committed_minor: committed,
      status: ['active', 'completed', 'withdrawn'].includes(req.body.status) ? req.body.status : p.status, agreement_ref: txt(req.body.agreement_ref, 120),
      ownership_terms: txt(req.body.ownership_terms, 2000), profit_terms: txt(req.body.profit_terms, 2000), return_terms: txt(req.body.return_terms, 2000), terms_confirmed: req.body.terms_confirmed === '1' };
    const before = Object.fromEntries(Object.keys(after).map(k => [k, k === 'committed_minor' && p[k] !== null ? Number(p[k]) : p[k]]));
    const changed = Object.keys(after).filter(k => String(after[k] ?? '') !== String(before[k] ?? ''));
    if (!changed.length) return res.redirect(`/w/${a.ws.id}/investors/${p.id}`);
    await core.inTx(async db => {
      await db.query(`update investor_participations set participation = $2, committed_minor = $3, status = $4, agreement_ref = $5, ownership_terms = $6, profit_terms = $7, return_terms = $8, terms_confirmed = $9 where id = $1`,
        [p.id, after.participation, after.committed_minor, after.status, after.agreement_ref, after.ownership_terms, after.profit_terms, after.return_terms, after.terms_confirmed]);
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'investor.terms_changed', entity: 'investor_participation', entityId: p.id, summary: `${p.ref}: changed ${changed.join(', ')} — ${reason}`,
        before: Object.fromEntries(changed.map(k => [k, before[k]])), after: Object.fromEntries(changed.map(k => [k, after[k]])), ip: req.ip });
    });
    res.redirect(`/w/${a.ws.id}/investors/${p.id}?msg=saved`);
  });

  r.post('/w/:id/investors/:pid/txns', async (req, res) => {
    const kind = Object.keys(KIND).includes(req.body.kind) ? req.body.kind : null; if (!kind) throw bad('Choose the type.');
    const a = await access(req, kind === 'contribution' ? 'contribute' : 'post');
    const p = await ownPart(req.params.pid, a.ws.id);
    if (p.status === 'withdrawn') throw bad('This participation is withdrawn.');
    const on = dateOrNull(req.body.on_date); if (!on) throw bad('Enter the date.');
    if (on > todayBH()) throw bad('The date cannot be in the future.');
    const neg = kind === 'adjustment' && /^\s*-/.test(String(req.body.amount || ''));
    const amt = parseMoney(String(req.body.amount || '').replace(/^\s*-/, ''), p.currency);
    if (!amt || amt <= 0) throw bad('Enter the amount.');
    const ref = txt(req.body.reference, 80); if (!ref) throw bad('Enter the payment reference.');
    const approval = txt(req.body.approval_ref, 300);
    if (kind !== 'contribution' && !approval) throw bad('Record who approved this and where the approval is documented.');
    if (kind === 'distribution' && !(p.terms_confirmed && p.profit_terms)) throw bad('Record and confirm the profit-sharing terms from the agreement before recording a distribution.');
    const idem = txt(req.body.idem, 80);
    const id = await core.inTx(async db => {
      await db.query('select id from investor_participations where id = $1 for update', [p.id]);
      if (kind === 'capital_return') {
        const parts = await load(a.ws.id, p.party_id);
        const f = figures(parts.find(x => x.id === p.id) || { committed_minor: null }, (parts.find(x => x.id === p.id) || {}).txns || [], [], todayBH());
        if (amt > f.net) throw bad(`Capital returned cannot exceed the net capital invested (${formatMoney(f.net, p.currency)}).`);
      }
      const status = kind === 'contribution' ? 'reported' : 'confirmed';
      let row;
      try {
        row = (await db.query(`insert into investor_txns (participation_id, workspace_id, kind, status, on_date, amount_minor, currency, method, reference, evidence, approval_ref, idem_key, recorded_by, confirmed_by, confirmed_at)
            values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning id`,
          [p.id, a.ws.id, kind, status, on, neg ? -amt : amt, p.currency, txt(req.body.method, 40), ref, txt(req.body.evidence, 300), approval, idem, req.user.id, status === 'confirmed' ? req.user.id : null, status === 'confirmed' ? new Date() : null])).rows[0];
      } catch (e) {
        if (e.code === '23505') throw bad(e.constraint === 'investor_txns_idem_key_key' ? 'This form was already submitted.' : `A ${KIND[kind].toLowerCase()} with reference “${ref}” is already recorded for this investor.`);
        throw e;
      }
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: `investor.${kind}_${status}`, entity: 'investor_txn', entityId: row.id,
        summary: `${p.ref}: ${KIND[kind]} ${formatMoney(neg ? -amt : amt, p.currency)} ${status === 'reported' ? 'reported (awaiting confirmation)' : `recorded — approval: ${approval}`}`, after: { on, amount: neg ? -amt : amt, ref, approval }, ip: req.ip });
      return row.id;
    });
    res.redirect(`/w/${a.ws.id}/investors/${p.id}?msg=saved#${id}`);
  });

  r.post('/w/:id/investors/:pid/txns/:tid/:act', async (req, res) => {
    if (!['confirm', 'reject', 'reverse'].includes(req.params.act)) throw new NotFound();
    const a = await access(req, 'post');
    const p = await ownPart(req.params.pid, a.ws.id);
    if (!UUID.test(req.params.tid)) throw new NotFound();
    const act = req.params.act;
    const reason = txt(req.body.reason, 300);
    if (act !== 'confirm' && !reason) throw bad('Give a reason.');
    await core.inTx(async db => {
      const t = (await db.query('select * from investor_txns where id = $1 and participation_id = $2 for update', [req.params.tid, p.id])).rows[0];
      if (!t) throw new NotFound();
      if (act === 'confirm') {
        if (t.status !== 'reported') throw bad('Only a reported transfer can be confirmed.');
        const ack = `ACK-${new Date().getFullYear()}-${String(await core.nextNumber(db, 'investor_ack')).padStart(4, '0')}`;
        await db.query("update investor_txns set status = 'confirmed', confirmed_by = $2, confirmed_at = now(), ack_no = case when kind = 'contribution' then $3 else ack_no end where id = $1", [t.id, req.user.id, ack]);
        await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'investor.contribution_confirmed', entity: 'investor_txn', entityId: t.id, summary: `${p.ref}: contribution of ${formatMoney(Number(t.amount_minor), t.currency)} confirmed — acknowledgment ${ack}`, ip: req.ip });
      } else if (act === 'reject') {
        if (t.status !== 'reported') throw bad('Only a reported transfer can be rejected.');
        await db.query("update investor_txns set status = 'rejected', reverse_reason = $2 where id = $1", [t.id, reason]);
        await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'investor.txn_rejected', entity: 'investor_txn', entityId: t.id, summary: `${p.ref}: reported ${KIND[t.kind].toLowerCase()} rejected — ${reason}`, ip: req.ip });
      } else {
        if (t.status !== 'confirmed') throw bad('Only a confirmed transaction can be reversed.');
        await db.query("update investor_txns set status = 'reversed', reverse_reason = $2 where id = $1", [t.id, reason]);
        await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'investor.txn_reversed', entity: 'investor_txn', entityId: t.id, summary: `${p.ref}: ${KIND[t.kind].toLowerCase()} of ${formatMoney(Number(t.amount_minor), t.currency)} reversed — ${reason}`, ip: req.ip });
      }
    });
    res.redirect(`/w/${a.ws.id}/investors/${p.id}?msg=saved`);
  });

  // contribution acknowledgment (a page; save as PDF with the export button)
  r.get('/w/:id/investors/:pid/ack/:tid', async (req, res) => {
    const a = await access(req);
    const p = await ownPart(req.params.pid, a.ws.id);
    if (!UUID.test(req.params.tid)) throw new NotFound();
    const t = (await pool.query("select t.*, coalesce(nullif(u.name,''), u.email) as confirmer from investor_txns t left join users u on u.id = t.confirmed_by where t.id = $1 and t.participation_id = $2 and t.ack_no is not null", [req.params.tid, p.id])).rows[0];
    if (!t) throw new NotFound();
    const inv = (await pool.query('select name from parties where id = $1', [p.party_id])).rows[0];
    res.send(page(req, a, html`<p><a href="/w/${a.ws.id}/investors/${p.id}">‹ ${p.ref}</a></p>
      <section class="panel narrow"><h2 class="h">Contribution acknowledgment ${t.ack_no}</h2>
        <dl class="details"><div><dt>Investor</dt><dd>${inv.name}</dd></div><div><dt>Project</dt><dd>${a.ws.name} (${a.ws.ref})</dd></div><div><dt>Participation</dt><dd>${p.ref}${p.agreement_ref ? ` · agreement ${p.agreement_ref}` : ''}</dd></div>
          <div><dt>Amount received</dt><dd><b>${fm(t.amount_minor, t.currency)}</b></dd></div><div><dt>Date received</dt><dd>${fmtDate(t.on_date)}</dd></div><div><dt>Method / reference</dt><dd>${t.method || ''} ${t.reference || ''}</dd></div>
          <div><dt>Confirmed</dt><dd>${fmtDateTime(t.confirmed_at)} by ${t.confirmer || '—'}</dd></div>${t.status === 'reversed' ? html`<div><dt>Status</dt><dd class="err">Reversed: ${t.reverse_reason}</dd></div>` : ''}</dl>
        <p class="muted small">This acknowledges receipt of a capital contribution to the project named above. It is not a sales invoice or rent receipt, and it does not by itself create any ownership percentage or right to profit.</p></section>`));
  });

  // ---------- investor profiles (staff) ----------
  async function visibleProjects(user) {
    return (await pool.query(`select w.id from workspaces w where w.section = 'dev' and ${core.visibleWhere(user)}`, [user.id])).rows.map(x => x.id);
  }
  r.get('/investors/:pid', async (req, res) => {
    if (core.isExternal(req.user)) throw new NotFound();
    if (!UUID.test(req.params.pid)) throw new NotFound();
    const fin = core.isSuper(req.user) || await core.can(req.user, 'view:financials');
    const y = (await pool.query('select * from parties where id = $1', [req.params.pid])).rows[0];
    if (!y) throw new NotFound();
    const ids = await visibleProjects(req.user);
    const parts = (await pool.query(`select p.*, w.name as ws_name, w.ref as ws_ref, w.id as ws_id from investor_participations p join workspaces w on w.id = p.workspace_id where p.party_id = $1 and p.workspace_id = any($2) order by p.created_at`, [y.id, ids])).rows;
    if (!parts.length && !core.isSuper(req.user)) throw new NotFound();
    const rows = [];
    for (const p of parts) { const full = (await load(p.workspace_id, y.id)).find(x => x.id === p.id); rows.push({ p, f: figures(full, full.txns, full.insts, todayBH()) }); }
    res.send(layout(req, { title: y.name, heading: y.name, crumbs: [['Home', '/'], ['Investors'], [y.name]], sub: { above: `Investor · ${y.kind === 'company' ? 'Company' : 'Individual'}` }, body: html`
      <section class="panel"><h2 class="h">Contact</h2><dl class="details"><div><dt>Email</dt><dd>${y.email || '—'}</dd></div><div><dt>Phone</dt><dd>${y.phone || '—'}</dd></div><div><dt>Authorised representative</dt><dd>${y.representative || '—'}</dd></div>${y.id_number ? html`<div><dt>Reference / ID</dt><dd>${y.id_number}</dd></div>` : ''}</dl></section>
      <section class="panel"><h2 class="h">Project participations</h2>${rows.length ? html`<div class="table-wrap"><table><thead><tr><th>Project</th><th>Participation</th><th>Type</th>${fin ? html`<th class="n">Committed</th><th class="n">Received</th><th class="n">Net capital</th>` : ''}<th>Status</th></tr></thead><tbody>
        ${rows.map(({ p, f }) => html`<tr><td><a href="/w/${p.ws_id}/investors/${p.id}">${p.ws_name}</a><div class="muted small">${p.ws_ref}</div></td><td class="mono small">${p.ref}</td><td class="small">${TYPE[p.participation]}</td>
          ${fin ? html`<td class="n">${fm(f.committed, p.currency)}</td><td class="n">${fm(f.received, p.currency)}</td><td class="n">${fm(f.net, p.currency)}</td>` : ''}<td>${p.status}</td></tr>`)}</tbody></table></div>` : html`<p class="muted">No participations in projects you can see.</p>`}
        <p class="muted small">Each participation is separate: being an investor in one project gives no rights or visibility in another.</p></section>` }));
  });
}

module.exports = { mountInvestors, figures };
