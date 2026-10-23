'use strict';
// Rent schedule maths. Pure functions on ISO dates and integer minor units.
//
// Billing calendar (documented policy):
// - Timezone: Asia/Bahrain. "Today" and all due/issue dates are Bahrain calendar days.
// - Periods follow calendar months. A lease billed every N months has periods of N calendar months starting
//   with the month the lease starts in; the first and last periods are clipped to the lease dates.
// - Rent is agreed per month. A part month is prorated by day (rent × days ÷ days in that month) when the
//   lease says "daily"; with "none" a part month is charged in full.
// - A rent change (lease_rent_steps) applies from its effective date; a period spanning the change is split.
// - Month end: a month always ends on its real last day (28–31); no 30-day convention.
// - Termination: the effective end is the termination date when one is recorded, otherwise the end date.
const { addDays, mulDiv } = require('./fees');

const ymd = d => typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10);
const monthStart = (y, m) => `${y}-${String(m).padStart(2, '0')}-01`;
const dim = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const monthEnd = (y, m) => `${y}-${String(m).padStart(2, '0')}-${String(dim(y, m)).padStart(2, '0')}`;
const addMonths = (y, m, k) => { const t = y * 12 + (m - 1) + k; return [Math.floor(t / 12), (t % 12) + 1]; };
const effectiveEnd = l => ymd(l.terminated_on || l.end_date);

function periods(lease) {
  const start = ymd(lease.start_date), end = effectiveEnd(lease);
  const n = Number(lease.frequency_months) || 1;
  let [y, m] = [Number(start.slice(0, 4)), Number(start.slice(5, 7))];
  const out = [];
  for (let guard = 0; guard < 600; guard++) {
    const ps = monthStart(y, m);
    if (ps > end) break;
    const [ey, em] = addMonths(y, m, n - 1);
    const s = ps < start ? start : ps;
    const e0 = monthEnd(ey, em), e = e0 > end ? end : e0;
    if (s <= e) out.push({ start: s, end: e });
    [y, m] = addMonths(y, m, n);
  }
  return out;
}

const stepOn = (steps, day) => { let pick = null; for (const s of steps) if (ymd(s.effective_from) <= day) pick = s; return pick; };

// Rent for one period: runs of consecutive days within the same month and the same rent step.
function rentFor(lease, steps, period) {
  const sorted = [...steps].sort((a, b) => ymd(a.effective_from).localeCompare(ymd(b.effective_from)));
  if (!sorted.length || ymd(sorted[0].effective_from) > ymd(lease.start_date)) sorted.unshift({ effective_from: ymd(lease.start_date), rent_minor: lease.rent_minor });
  const runs = [];
  for (let d = period.start; d <= period.end; d = addDays(d, 1)) {
    const st = stepOn(sorted, d); const mo = d.slice(0, 7);
    const last = runs[runs.length - 1];
    if (last && last.mo === mo && last.st === st) { last.days++; last.to = d; } else runs.push({ mo, st, days: 1, from: d, to: d });
  }
  let total = 0; const parts = [];
  const seenMonth = new Set();
  for (const r of runs) {
    const y = Number(r.mo.slice(0, 4)), m = Number(r.mo.slice(5, 7)), full = dim(y, m);
    const monthly = Number(r.st.rent_minor);
    let amt;
    if (lease.proration === 'none') { amt = seenMonth.has(r.mo) ? 0 : monthly; seenMonth.add(r.mo); }
    else amt = r.days === full ? monthly : mulDiv(monthly, r.days, full);
    total += amt; parts.push({ from: r.from, to: r.to, days: r.days, of: full, monthly, amount: amt });
  }
  return { total, parts };
}

// Recurring charges are per month too; the same proration applies.
function chargeFor(lease, monthly, period) { return rentFor({ ...lease, rent_minor: monthly }, [], period).total; }

const dueDate = (lease, period) => addDays(period.start, Number(lease.due_day_offset) || 0);
const issueDate = (lease, period) => addDays(period.start, -(Number(lease.invoice_days_before) || 0));

module.exports = { periods, rentFor, chargeFor, dueDate, issueDate, effectiveEnd, ymd };
