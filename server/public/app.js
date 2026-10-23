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
