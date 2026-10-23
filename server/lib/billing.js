'use strict';
// Rent ledger engine: charges come from approved lease terms; invoices are built from those charges.
// Every step is idempotent: a period's charges and invoice are created at most once (unique indexes plus a
// row lock on the lease), so retries, concurrent jobs and resends never duplicate a charge or an invoice.
const rent = require('./rent');
const { addDays } = require('./fees');
const { formatMoney } = require('./money');
const docs = require('./fee-docs');

const todayBH = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bahrain' });
const num = v => v === null || v === undefined ? null : Number(v);
const fmtD = v => v ? new Date(`${String(v).slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—';

async function nextNumber(db, key) {
  const { rows } = await db.query(`insert into number_series (key, next_value) values ($1, 2)
    on conflict (key) do update set next_value = number_series.next_value + 1 returning next_value - 1 as n`, [key]);
  return rows[0].n;
}

// Charges + invoice for one lease period. Returns { invoice, created }.
async function ensurePeriod(db, { leaseId, period, origin = 'manual', actorId = null, actorLabel = null, issueOn = null }) {
  const lease = (await db.query('select * from leases where id = $1 for update', [leaseId])).rows[0];
  if (!lease) throw Object.assign(new Error('Lease not found.'), { status: 404 });
  if (!['active', 'ended', 'terminated'].includes(lease.status)) throw Object.assign(new Error('Only activated leases are billed.'), { status: 400 });
  const valid = rent.periods(lease).find(p => p.start === period.start && p.end === period.end);
  if (!valid) throw Object.assign(new Error('That period is not part of this lease.'), { status: 400 });
  const existing = (await db.query("select * from rent_invoices where lease_id = $1 and period_start = $2 and status <> 'void'", [lease.id, period.start])).rows[0];
  if (existing) return { invoice: existing, created: false };
  const steps = (await db.query('select * from lease_rent_steps where lease_id = $1 order by effective_from', [lease.id])).rows;
  const due = rent.dueDate(lease, period);
  const r = rent.rentFor(lease, steps, period);
  const label = `${fmtD(period.start)} – ${fmtD(period.end)}`;
  const ins = (key, kind, desc, amt) => db.query(`insert into rent_charges (workspace_id, lease_id, unit_id, kind, charge_key, description, period_start, period_end, due_date, amount_minor, created_by)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict do nothing`, [lease.workspace_id, lease.id, lease.unit_id, kind, key, desc, period.start, period.end, due, amt, actorId]);
  await ins('rent', 'rent', `Rent ${label}`, r.total);
  for (const c of (await db.query('select * from lease_charges where lease_id = $1 and active order by created_at', [lease.id])).rows)
    await ins(c.id, 'charge', `${c.description} ${label}`, rent.chargeFor(lease, Number(c.amount_minor), period));
  const charges = (await db.query("select * from rent_charges where lease_id = $1 and period_start = $2 and status = 'open' and invoice_id is null", [lease.id, period.start])).rows;
  const total = charges.reduce((s, c) => s + Number(c.amount_minor), 0);
  const issue = issueOn || todayBH();
  const year = issue.slice(0, 4);
  const number = `RNT-${year}-${String(await nextNumber(db, `RNT-${year}`)).padStart(5, '0')}`;
  const inv = (await db.query(`insert into rent_invoices (workspace_id, lease_id, number, period_start, period_end, issue_date, due_date, total_minor, origin, created_by)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`, [lease.workspace_id, lease.id, number, period.start, period.end, issue, due, total, origin, actorId])).rows[0];
  await db.query('update rent_charges set invoice_id = $1 where id = any($2::uuid[])', [inv.id, charges.map(c => c.id)]);
  await db.query(`insert into audit_events (actor_id, actor_label, workspace_id, action, entity, entity_id, summary) values ($1, $2, $3, 'rent.invoice_issued', 'rent_invoice', $4, $5)`,
    [actorId, actorLabel || (actorId ? 'staff' : 'scheduler'), lease.workspace_id, inv.id, `Rent invoice ${number} issued for ${lease.ref}, ${label}: ${formatMoney(total)}`]);
  return { invoice: inv, created: true };
}

// Outstanding per charge = amount − approved credits − active allocations of confirmed payments.
async function chargeState(db, where, vals) {
  return (await db.query(`select c.*,
      coalesce((select sum(amount_minor) from rent_credits r where r.charge_id = c.id), 0)::bigint as credited,
      coalesce((select sum(a.amount_minor) from tenant_allocations a where a.charge_id = c.id and a.status = 'active'), 0)::bigint as paid
    from rent_charges c where ${where} order by c.due_date, c.created_at`, vals)).rows
    .map(c => ({ ...c, amount: Number(c.amount_minor), credited: Number(c.credited), paid: Number(c.paid), outstanding: c.status === 'open' ? Number(c.amount_minor) - Number(c.credited) - Number(c.paid) : 0 }));
}

async function invoiceData(db, invoiceId) {
  const inv = (await db.query('select * from rent_invoices where id = $1', [invoiceId])).rows[0];
  if (!inv) return null;
  const lease = (await db.query('select * from leases where id = $1', [inv.lease_id])).rows[0];
  const ws = (await db.query('select * from workspaces where id = $1', [inv.workspace_id])).rows[0];
  const unit = (await db.query('select * from units where id = $1', [lease.unit_id])).rows[0];
  const tenant = (await db.query('select * from parties where id = $1', [lease.tenant_id])).rows[0];
  const owner = ws.party_id ? (await db.query('select * from parties where id = $1', [ws.party_id])).rows[0] : null;
  const prof = (await db.query('select * from property_profiles where workspace_id = $1', [ws.id])).rows[0] || {};
  const company = (await db.query('select * from company_profile where id = 1')).rows[0] || {};
  const charges = await chargeState(db, 'c.invoice_id = $1', [inv.id]);
  return { inv, lease, ws, unit, tenant, owner, prof, company, charges };
}

async function invoicePdf(db, invoiceId) {
  const d = await invoiceData(db, invoiceId);
  const { inv, lease, ws, unit, tenant, owner, prof, company, charges } = d;
  const ownerBills = (prof.billing_entity || 'owner') === 'owner' && owner;
  const outstanding = charges.reduce((s, c) => s + c.outstanding, 0);
  const buf = await docs.render({
    company, letterhead: ownerBills ? null : company.letterhead, marginTop: company.margin_top_mm, marginBottom: company.margin_bottom_mm,
    title: 'Rent invoice', number: inv.number, stamp: inv.status === 'void' ? 'VOID' : null,
    to: [tenant.name, tenant.address, tenant.email, tenant.phone],
    meta: [['Issue date', fmtD(inv.issue_date)], ['Due date', fmtD(inv.due_date)], ['Lease', lease.ref], ['Property', ws.name], ['Unit', unit.ref], ['Period', `${fmtD(inv.period_start)} – ${fmtD(inv.period_end)}`], ['Currency', inv.currency]],
    tables: [{ head: ['Description', 'Amount'], widths: [0.75, 0.25], align: ['left', 'right'], rows: charges.map(c => [c.description, docs.money(c.amount, inv.currency)]) }],
    totals: [['Total due', docs.money(Number(inv.total_minor), inv.currency), true], ...(outstanding !== Number(inv.total_minor) ? [['Outstanding', docs.money(outstanding, inv.currency), true]] : [])],
    notes: [
      ownerBills ? `Issued on behalf of the property owner, ${owner.name}, by SarayDar as managing agent.` : `Issued by ${company.legal_name || company.trade_name || 'SarayDar'}.`,
      prof.payment_instructions ? `Payment instructions: ${prof.payment_instructions}` : 'Payment instructions: please contact SarayDar.',
      `Please quote ${inv.number} with your payment. This invoice requests payment; it is not a receipt. No tax has been charged unless shown above.`
    ]
  });
  return { buf, data: d };
}

// Email the invoice PDF. Each attempt is a new outbox row referring to the same invoice; the invoice itself is never re-created.
async function deliverInvoice(pool, mailer, invoiceId, { reminder = null } = {}) {
  const { buf, data } = await invoicePdf(pool, invoiceId);
  const { inv, tenant, ws, unit } = data;
  if (!tenant.email) {
    await pool.query("insert into outbox_messages (to_address, subject, body_text, kind, status, workspace_id, ref_kind, ref_id, error) values ('—', $1, null, 'rent_invoice', 'failed', $2, 'rent_invoice', $3, 'Tenant has no email address')",
      [`Rent invoice ${inv.number}`, ws.id, inv.id]);
    return { status: 'failed', error: 'Tenant has no email address' };
  }
  const subject = reminder ? `Reminder: rent invoice ${inv.number} is overdue` : `Rent invoice ${inv.number} — ${ws.name}, unit ${unit.ref}`;
  const text = `Dear ${tenant.name},\n\n${reminder ? `This is a reminder that rent invoice ${inv.number} was due on ${fmtD(inv.due_date)} and is still outstanding.` : `Please find attached rent invoice ${inv.number} for ${ws.name}, unit ${unit.ref}, period ${fmtD(inv.period_start)} – ${fmtD(inv.period_end)}.`}\nAmount: ${formatMoney(Number(inv.total_minor))}. Due date: ${fmtD(inv.due_date)}.\n\nIf you have already paid, please ignore this message and send us the payment reference.\n\nSarayDar`;
  const r = await mailer.send({ to: tenant.email, subject, text, kind: reminder ? 'rent_reminder' : 'rent_invoice', workspaceId: ws.id, refKind: 'rent_invoice', refId: inv.id,
    attachments: [{ filename: `${inv.number}.pdf`, content: buf, contentType: 'application/pdf' }] });
  return r;
}

async function deliveryStatus(db, invoiceIds) {
  if (!invoiceIds.length) return {};
  const rows = (await db.query(`select distinct on (ref_id) ref_id, status, created_at, error, kind from outbox_messages where ref_kind = 'rent_invoice' and ref_id = any($1::text[]) and kind = 'rent_invoice' order by ref_id, id desc`, [invoiceIds])).rows;
  return Object.fromEntries(rows.map(r => [r.ref_id, r]));
}

// The background job: generate due invoices for every enabled lease, deliver them, then send reminders.
async function runBilling(pool, mailer, { today = todayBH() } = {}) {
  const c = await pool.connect();
  let runId = null;
  try {
    const got = (await c.query('select pg_try_advisory_lock(727101) as ok')).rows[0].ok;
    if (!got) { await pool.query("insert into job_runs (job, status, finished_at, summary) values ('rent_billing', 'skipped', now(), 'Another run is in progress')"); return { skipped: true }; }
    runId = (await pool.query("insert into job_runs (job) values ('rent_billing') returning id")).rows[0].id;
    const leases = (await pool.query("select * from leases where status = 'active' and auto_invoice and auto_from is not null")).rows;
    let created = 0, delivered = 0, failed = 0, reminders = 0;
    const errors = [];
    for (const l of leases) {
      for (const p of rent.periods(l)) {
        if (p.start < String(l.auto_from).slice(0, 10) || rent.issueDate(l, p) > today) continue;
        try {
          const res = await inTx(pool, db => ensurePeriod(db, { leaseId: l.id, period: p, origin: 'scheduler', issueOn: today }));
          if (res.created) {
            created++;
            if (l.delivery === 'email') { const d = await deliverInvoice(pool, mailer, res.invoice.id); if (d.status === 'sent') delivered++; else if (d.status === 'failed') failed++; }
          }
        } catch (e) { errors.push(`${l.ref} ${p.start}: ${e.message}`); }
      }
      // reminders for overdue, still-outstanding invoices
      if (l.delivery === 'email') for (const inv of (await pool.query("select * from rent_invoices where lease_id = $1 and status = 'issued' and due_date < $2", [l.id, today])).rows) {
        const ch = await chargeState(pool, 'c.invoice_id = $1', [inv.id]);
        if (ch.reduce((s, x) => s + x.outstanding, 0) <= 0) continue;
        for (const d of l.reminder_days || []) {
          if (addDays(String(inv.due_date).slice(0, 10), d) > today) continue;
          const ok = (await pool.query('insert into rent_reminders (invoice_id, day_offset) values ($1,$2) on conflict do nothing returning invoice_id', [inv.id, d])).rowCount;
          if (!ok) continue;
          const r = await deliverInvoice(pool, mailer, inv.id, { reminder: d });
          await pool.query("update rent_reminders set outbox_id = (select max(id) from outbox_messages where ref_kind = 'rent_invoice' and ref_id = $3) where invoice_id = $1 and day_offset = $2", [inv.id, d, String(inv.id)]);
          if (r) reminders++;
        }
      }
    }
    const summary = `${leases.length} lease(s) checked · ${created} invoice(s) created · ${delivered} emailed · ${failed} failed · ${reminders} reminder(s)${mailer.configured ? '' : ' · email not configured: invoices kept in the system, delivery shown as unconfigured'}`;
    await pool.query("update job_runs set status = $2, finished_at = now(), summary = $3, error = $4 where id = $1", [runId, errors.length ? 'failed' : 'ok', summary, errors.join('\n').slice(0, 2000) || null]);
    return { created, delivered, failed, reminders, errors };
  } catch (e) {
    if (runId) await pool.query("update job_runs set status = 'failed', finished_at = now(), error = $2 where id = $1", [runId, String(e.message).slice(0, 2000)]).catch(() => {});
    throw e;
  } finally {
    await c.query('select pg_advisory_unlock(727101)').catch(() => {});
    c.release();
  }
}

async function inTx(pool, fn) {
  const c = await pool.connect();
  try { await c.query('begin'); const r = await fn(c); await c.query('commit'); return r; }
  catch (e) { await c.query('rollback').catch(() => {}); throw e; }
  finally { c.release(); }
}

// Recurring service tasks: one task per schedule and date (unique), created up to `days` ahead.
// Re-running (or two runs at once) never duplicates a task.
function occurrences(start, frequency, from, until) {
  const out = [];
  const y0 = Number(start.slice(0, 4)), m0 = Number(start.slice(5, 7)), d0 = Number(start.slice(8, 10));
  for (let k = 0; k < 2000; k++) {
    let d;
    if (frequency === 'weekly' || frequency === 'fortnightly') d = addDays(start, k * (frequency === 'weekly' ? 7 : 14));
    else { const t = y0 * 12 + (m0 - 1) + k * (frequency === 'monthly' ? 1 : 3); const yy = Math.floor(t / 12), mm = t % 12 + 1; const last = new Date(Date.UTC(yy, mm, 0)).getUTCDate(); d = `${yy}-${String(mm).padStart(2, '0')}-${String(Math.min(d0, last)).padStart(2, '0')}`; }
    if (d > until) break;
    if (d >= from) out.push(d);
  }
  return out;
}
async function generateServiceTasks(pool, { today = todayBH(), days = 60 } = {}) {
  const until = addDays(today, days), from = addDays(today, -7);
  let n = 0;
  for (const s of (await pool.query('select * from service_schedules where active')).rows)
    for (const d of occurrences(String(s.start_date).slice(0, 10), s.frequency, from, until))
      n += (await pool.query('insert into service_tasks (schedule_id, workspace_id, scheduled_on) values ($1,$2,$3) on conflict do nothing', [s.id, s.workspace_id, d])).rowCount;
  return n;
}

module.exports = { occurrences, ensurePeriod, chargeState, invoicePdf, invoiceData, deliverInvoice, deliveryStatus, runBilling, generateServiceTasks, inTx, todayBH, fmtD, nextNumber };
