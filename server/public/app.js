// Small progressive enhancements. The portal works without JavaScript.
document.addEventListener('click', e => {
  document.querySelectorAll('details.usermenu[open]').forEach(d => { if (!d.contains(e.target)) d.removeAttribute('open'); });
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') document.querySelectorAll('details.usermenu[open]').forEach(d => d.removeAttribute('open'));
});
// prevent double submission
document.addEventListener('submit', e => {
  const b = e.target.querySelector('button[type="submit"]');
  if (b) setTimeout(() => { b.disabled = true; }, 0);
});
// Agreements: choosing an existing party fills in its details
document.addEventListener('change', e => {
  const sel = e.target.closest('[data-party-select]');
  if (!sel) return;
  let data = {};
  try { data = JSON.parse(document.getElementById('party-data').textContent); } catch (err) { return; }
  const p = data[sel.value] || {};
  document.querySelectorAll('[data-party-field]').forEach(i => { i.value = p[i.dataset.partyField] || ''; });
  const kind = document.getElementById('f-party_kind');
  if (kind) kind.value = p.kind || 'person';
});
// "Create a password for me" hides the manual password box
document.addEventListener('change', e => {
  const t = e.target.closest('[data-toggle-pw]'); if (!t) return;
  const f = t.form && t.form.querySelector('[name="password"]'); if (f) f.closest('.field').hidden = t.checked;
});
document.querySelectorAll('[data-toggle-pw]').forEach(t => { const f = t.form && t.form.querySelector('[name="password"]'); if (f && t.checked) f.closest('.field').hidden = true; });
// "Back" returns to the previous page when there is one in this tab, otherwise to the parent page
document.addEventListener('click', e => {
  const a = e.target.closest('a[data-back]');
  if (!a || e.metaKey || e.ctrlKey) return;
  if (history.length > 1 && document.referrer && new URL(document.referrer).origin === location.origin) { e.preventDefault(); history.back(); }
});
// Show a field only when another field has a given value: data-show-when="tax_mode=vat"
function syncShowWhen(form) {
  (form || document).querySelectorAll('[data-show-when]').forEach(el => {
    const [n, v] = el.dataset.showWhen.split('='); const f = el.closest('form'); const c = f && f.elements[n];
    if (!c) return; const want = v.split('|'); el.hidden = !want.includes(c.value);
  });
}
document.addEventListener('change', e => { if (e.target.form) syncShowWhen(e.target.form); });
syncShowWhen();
// Choosing an item fills related fields that are still empty (or were filled this way before):
// <select data-fill="id-of-json-script"> with {"optionValue": {"fieldName": "value"}}
document.addEventListener('change', e => {
  const s = e.target.closest('select[data-fill]'); if (!s) return;
  let map = {}; try { map = JSON.parse(document.getElementById(s.dataset.fill).textContent); } catch (err) { return; }
  const vals = map[s.value] || {};
  for (const [k, v] of Object.entries(vals)) {
    const f = s.form && s.form.elements[k]; if (!f || f.tagName === undefined) continue;
    if (f.value === '' || f.dataset.autofilled === '1') { f.value = v; f.dataset.autofilled = '1'; }
  }
});
document.addEventListener('input', e => { if (e.target.dataset) delete e.target.dataset.autofilled; });
// Guided setup: choosing the current stage sets each phase status (earlier = done, current = in progress, later = not started)
document.addEventListener('change', e => {
  const s = e.target.closest('select[data-stage-phases]'); if (!s || !s.value) return;
  let order = []; try { order = JSON.parse(s.dataset.stagePhases); } catch (err) { return; }
  const i = order.indexOf(s.value); if (i < 0) return;
  order.forEach((k, j) => { const f = s.form.elements[`ph_${k}`]; if (f) f.value = j < i ? 'done' : j === i ? 'in_progress' : 'not_started'; });
});
