'use strict';
// Money as integer minor units. BHD has 3 decimals. Never use floating point for amounts.
const DECIMALS = { BHD: 3, KWD: 3, OMR: 3, USD: 2, EUR: 2, GBP: 2, SAR: 2, AED: 2 };
const CURRENCIES = Object.keys(DECIMALS);
const dp = c => DECIMALS[c] ?? 2;

// "12,345.5" → 12345500 (BHD). Returns null for empty input, throws on invalid input.
function parseMoney(input, currency = 'BHD') {
  if (input === null || input === undefined) return null;
  const s = String(input).replace(/[,\s]/g, '').replace(/^(BHD|BD)/i, '');
  if (s === '') return null;
  const d = dp(currency);
  const m = /^(-)?(\d{1,13})(?:\.(\d+))?$/.exec(s);
  if (!m) throw Object.assign(new Error(`“${input}” is not a valid amount.`), { status: 400 });
  const frac = m[3] || '';
  if (frac.length > d) throw Object.assign(new Error(`${currency} amounts have at most ${d} decimal places.`), { status: 400 });
  const minor = Number(m[2]) * 10 ** d + Number(frac.padEnd(d, '0') || 0);
  if (!Number.isSafeInteger(minor)) throw Object.assign(new Error('That amount is too large.'), { status: 400 });
  return m[1] ? -minor : minor;
}

function formatMoney(minor, currency = 'BHD', { code = true } = {}) {
  if (minor === null || minor === undefined || minor === '') return '';
  const n = typeof minor === 'string' ? Number(minor) : minor;
  const d = dp(currency);
  const neg = n < 0, abs = Math.abs(n);
  const whole = Math.floor(abs / 10 ** d), frac = abs % 10 ** d;
  // Whole amounts without decimals ("80,000"); fils only when there are any, without trailing zeros ("1,500.25").
  const s = whole.toLocaleString('en-US') + (d && frac ? '.' + String(frac).padStart(d, '0').replace(/0+$/, '') : '');
  return `${code ? currency + ' ' : ''}${neg ? '-' : ''}${s}`;
}
// The value shown in a form field: thousands separated, no trailing zero decimals ("80,000", "1,500.25").
const toInput = (minor, currency = 'BHD') => minor === null || minor === undefined || minor === '' ? '' : formatMoney(minor, currency, { code: false });
const num = v => v === null || v === undefined ? null : Number(v);

module.exports = { parseMoney, formatMoney, toInput, num, CURRENCIES, dp };
