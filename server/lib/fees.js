'use strict';
// SarayDar management-fee calculations. Pure functions on integer minor units (BHD: 3 decimals) and
// ISO dates (YYYY-MM-DD). No floating-point money: proration and tax use integer arithmetic with
// round-half-up on the final division only.
const { formatMoney } = require('./money');

const pad = n => String(n).padStart(2, '0');
const isoOf = d => d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();          // m is 1-12
const monthOf = ym => {
  const m = /^(\d{4})-(\d{2})$/.exec(String(ym || ''));
  if (!m || +m[2] < 1 || +m[2] > 12) return null;
  const y = +m[1], mo = +m[2];
  return { start: `${y}-${pad(mo)}-01`, end: `${y}-${pad(mo)}-${pad(daysInMonth(y, mo))}`, days: daysInMonth(y, mo), label: new Date(Date.UTC(y, mo - 1, 1)).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }) };
};
// a * b / c rounded half up, all integers (BigInt keeps it exact for any realistic amount)
const mulDiv = (a, b, c) => { const n = BigInt(a) * BigInt(b), d = BigInt(c); return Number((n * 2n + d) / (2n * d)); };

// The terms version in force on a given day: the latest version (active or superseded) whose
// effective date has started; it applies only between that version's start and end dates.
function termsOn(versions, day) {
  const usable = versions.filter(v => ['active', 'superseded'].includes(v.status)).sort((a, b) => a.version - b.version);
  let pick = null;
  for (const v of usable) if (isoOf(v.effective_from) <= day) pick = v;
  if (!pick) return null;
  if (day < isoOf(pick.start_date) || (pick.end_date && day > isoOf(pick.end_date))) return null;
  return pick;
}

// Fee lines for one calendar month. Consecutive days under the same terms version form one line.
// proration 'daily': fee × covered days ÷ days in month. 'none': the full monthly fee when the
// version covers the first covered day of the month (one full fee per month).
function monthlyLines(versions, ym) {
  const mo = monthOf(ym);
  if (!mo) throw Object.assign(new Error('Choose a valid billing month.'), { status: 400 });
  const runs = [];
  for (let d = mo.start; d <= mo.end; d = addDays(d, 1)) {
    const v = termsOn(versions, d);
    const last = runs[runs.length - 1];
    if (v && last && last.v.id === v.id && addDays(last.to, 1) === d) last.to = d;
    else if (v) runs.push({ v, from: d, to: d });
  }
  if (!runs.length) return { month: mo, lines: [], covered: 0, reason: 'No active management-agreement terms cover this month.' };
  const lines = [];
  const covered = runs.reduce((s, r) => s + (Date.parse(r.to) - Date.parse(r.from)) / 864e5 + 1, 0);
  if (runs[0].v.proration === 'none') {
    const v = runs[0].v;
    lines.push({ kind: 'fee', description: `Project management fee — ${mo.label}`, amount: Number(v.monthly_fee_minor), terms: v });
  } else {
    for (const r of runs) {
      const days = (Date.parse(r.to) - Date.parse(r.from)) / 864e5 + 1;
      const fee = Number(r.v.monthly_fee_minor);
      const full = days === mo.days;
      lines.push({ kind: 'fee', terms: r.v, amount: full ? fee : mulDiv(fee, days, mo.days),
        description: full ? `Project management fee — ${mo.label}` : `Project management fee — ${fmtShort(r.from)} to ${fmtShort(r.to)} (${days} of ${mo.days} days at ${formatMoney(fee, r.v.currency)} per month)` });
    }
  }
  return { month: mo, lines, covered, terms: runs[runs.length - 1].v };
}
const fmtShort = iso => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

function taxOf(subtotal, mode, bp) {
  if (mode !== 'rate') return 0;
  if (subtotal <= 0) return 0;
  return mulDiv(subtotal, bp || 0, 10000);
}
function totals(lines, mode, bp) {
  const subtotal = lines.reduce((s, l) => s + Number(l.amount_minor ?? l.amount), 0);
  const tax = taxOf(subtotal, mode, bp);
  return { subtotal, tax, total: subtotal + tax };
}
const pctLabel = bp => `${(bp / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;

module.exports = { monthOf, monthlyLines, termsOn, taxOf, totals, addDays, mulDiv, pctLabel, isoOf };
