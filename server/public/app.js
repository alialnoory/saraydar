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
