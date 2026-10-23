'use strict';
// Transparent matching of a buyer brief against a property. Every criterion is reported as matched, not matched
// or unknown (when either side has not recorded it). No score is calculated and nothing is guessed.
const { formatMoney } = require('./money');

const list = s => String(s || '').split(/[,;\n]/).map(x => x.trim().toLowerCase()).filter(Boolean);
const n = v => v === null || v === undefined || v === '' ? null : Number(v);

function match(brief, p) {
  const out = [];
  const add = (label, state, detail) => out.push({ label, state, detail });
  // type
  const types = list(brief.types);
  if (!types.length) add('Property type', 'unknown', 'Not in the brief');
  else if (!p.property_type) add('Property type', 'unknown', 'Not recorded for the property');
  else add('Property type', types.some(t => String(p.property_type).toLowerCase().includes(t) || t.includes(String(p.property_type).toLowerCase())) ? 'match' : 'no', `${p.property_type} vs ${types.join(', ')}`);
  // location
  const locs = list(brief.locations);
  if (!locs.length) add('Location', 'unknown', 'Not in the brief');
  else if (!p.location) add('Location', 'unknown', 'Not recorded for the property');
  else add('Location', locs.some(l => String(p.location).toLowerCase().includes(l)) ? 'match' : 'no', `${p.location} vs ${locs.join(', ')}`);
  // budget (same currency only; flexibility applied to the maximum)
  const price = n(p.price_minor ?? p.asking_minor), bmin = n(brief.budget_min_minor), bmax = n(brief.budget_max_minor);
  if (bmin === null && bmax === null) add('Budget', 'unknown', 'Not in the brief');
  else if (price === null) add('Budget', 'unknown', 'No price recorded');
  else if ((p.currency || 'BHD') !== (brief.currency || 'BHD')) add('Budget', 'unknown', `Different currency (${p.currency} vs ${brief.currency}); no conversion applied`);
  else {
    const flex = n(brief.flexibility_pct) || 0;
    const top = bmax === null ? null : Math.round(bmax * (1 + flex / 100));
    const ok = (bmin === null || price >= bmin) && (top === null || price <= top);
    add('Budget', ok ? 'match' : 'no', `${formatMoney(price, p.currency)} vs ${bmin === null ? '—' : formatMoney(bmin)} to ${bmax === null ? '—' : formatMoney(bmax)}${flex ? ` (+${flex}% flexibility)` : ''}`);
  }
  // areas
  for (const [label, min, max, val] of [['Land area', brief.land_min_m2, brief.land_max_m2, p.land_area_m2], ['Built-up area', brief.built_min_m2, brief.built_max_m2, p.built_area_m2]]) {
    if (n(min) === null && n(max) === null) continue;
    if (n(val) === null) { add(label, 'unknown', 'Not recorded for the property'); continue; }
    add(label, (n(min) === null || n(val) >= n(min)) && (n(max) === null || n(val) <= n(max)) ? 'match' : 'no', `${n(val)} m² vs ${n(min) !== null && n(max) !== null ? `${n(min)}–${n(max)} m²` : n(min) !== null ? `at least ${n(min)} m²` : `at most ${n(max)} m²`}`);
  }
  if (n(brief.bedrooms_min) !== null) {
    if (n(p.bedrooms) === null) add('Bedrooms', 'unknown', 'Not recorded for the property');
    else add('Bedrooms', n(p.bedrooms) >= n(brief.bedrooms_min) ? 'match' : 'no', `${p.bedrooms} vs at least ${brief.bedrooms_min}`);
  }
  // availability
  const st = p.status || p.availability;
  add('Availability', ['available', 'ready'].includes(st) ? 'match' : st === 'unknown' || !st ? 'unknown' : 'no', st ? String(st).replace('_', ' ') : 'Not recorded');
  // exclusions: flag only an explicit word hit, never a guess
  for (const x of list(brief.exclusions)) {
    const hay = `${p.property_type || ''} ${p.location || ''} ${p.features || ''} ${p.description || ''}`.toLowerCase();
    if (x.length > 2 && hay.includes(x)) add('Exclusion', 'no', `Mentions “${x}”`);
  }
  const counts = { match: out.filter(x => x.state === 'match').length, no: out.filter(x => x.state === 'no').length, unknown: out.filter(x => x.state === 'unknown').length };
  return { criteria: out, counts, eligible: counts.no === 0 };
}

module.exports = { match, list };
