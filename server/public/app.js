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
// Tab tips: "Hide tips" remembers the choice in this browser; the Help page has a link to show them again
try { if (localStorage.getItem('tips-off') === '1') document.documentElement.classList.add('tips-off'); } catch (e) { /* storage blocked */ }
document.addEventListener('click', e => {
  const h = e.target.closest('[data-hide-tips]'), s = e.target.closest('[data-show-tips]');
  if (!h && !s) return;
  try { localStorage.setItem('tips-off', h ? '1' : '0'); } catch (err) { /* storage blocked */ }
  document.documentElement.classList.toggle('tips-off', !!h);
  if (s) s.textContent = 'Tips are on';
});
// Stay where you were: after a form is sent and the page comes back (same page), return to the same scroll
// position instead of the top (owner request 2026-10-24). The "Saved" message then shows as a floating note.
document.addEventListener('submit', e => {
  if (e.defaultPrevented || (e.target.method || '').toLowerCase() !== 'post') return;
  try { sessionStorage.setItem('keep-scroll', JSON.stringify({ path: location.pathname, y: window.scrollY, t: Date.now() })); } catch (err) { /* storage blocked */ }
});
(() => {
  let k = null;
  try { k = JSON.parse(sessionStorage.getItem('keep-scroll') || 'null'); sessionStorage.removeItem('keep-scroll'); } catch (err) { return; }
  if (!k || k.path !== location.pathname || Date.now() - k.t > 60000 || !k.y) return;
  const go = () => {
    window.scrollTo(0, Math.min(k.y, document.documentElement.scrollHeight));
    const f = document.querySelector('.flash');
    if (f) { f.classList.add('flash-float'); setTimeout(() => f.classList.add('flash-out'), 3500); }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go); else go();
  window.addEventListener('load', () => window.scrollTo(0, Math.min(k.y, document.documentElement.scrollHeight)), { once: true });
})();
// Buttons that remove something ask first: data-confirm="question"
document.addEventListener('click', e => {
  const b = e.target.closest('[data-confirm]');
  if (b && !window.confirm(b.dataset.confirm)) { e.preventDefault(); e.stopImmediatePropagation(); }
}, true);
// A tick-box that hides a group of fields while ticked: data-hides="<id of the group>"
document.addEventListener('change', e => {
  const t = e.target.closest('[data-hides]'); if (!t) return;
  const g = document.getElementById(t.dataset.hides); if (g) g.hidden = t.checked;
});
// Telephone fields: a country-code picker (Bahrain +973 first) beside the number; the saved value is "+973 3333 2677".
// Numbers already stored keep their code; "Other" lets you type a full international number.
(() => {
  const CODES = [['+973', 'Bahrain'], ['+966', 'Saudi Arabia'], ['+974', 'Qatar'], ['+971', 'UAE'], ['+965', 'Kuwait'], ['+968', 'Oman'],
    ['+20', 'Egypt'], ['+962', 'Jordan'], ['+961', 'Lebanon'], ['+964', 'Iraq'], ['+91', 'India'], ['+92', 'Pakistan'], ['+63', 'Philippines'],
    ['+44', 'United Kingdom'], ['+1', 'USA / Canada'], ['', 'Other']];
  const flag = { '+973': '🇧🇭', '+966': '🇸🇦', '+974': '🇶🇦', '+971': '🇦🇪', '+965': '🇰🇼', '+968': '🇴🇲', '+20': '🇪🇬', '+962': '🇯🇴', '+961': '🇱🇧', '+964': '🇮🇶', '+91': '🇮🇳', '+92': '🇵🇰', '+63': '🇵🇭', '+44': '🇬🇧', '+1': '🇺🇸' };
  const split = v => {
    v = String(v || '').trim();
    if (!v) return ['+973', ''];
    const s = v.replace(/^00/, '+');
    const hit = CODES.filter(c => c[0] && s.replace(/\s/g, '').startsWith(c[0])).sort((a, b) => b[0].length - a[0].length)[0];
    if (hit) return [hit[0], s.replace(/\s/g, '').slice(hit[0].length)];
    if (/^\+/.test(s)) return ['', s];
    return ['+973', s];
  };
  // Bahrain numbers read as 3333 2677; other countries keep the digits as typed (spaces tidied)
  const group = (d, c) => c === '+973' ? d.replace(/\D/g, '').replace(/(\d{4})(?=\d)/g, '$1 ') : d.replace(/[^\d ]/g, '').replace(/\s+/g, ' ').trim();
  document.querySelectorAll('input[type="tel"]:not([data-cc])').forEach(real => {
    if (real.disabled || real.readOnly) return;
    real.dataset.cc = '1';
    const [code, num] = split(real.value);
    const box = document.createElement('div'); box.className = 'tel-wrap';
    const sel = document.createElement('select'); sel.setAttribute('aria-label', 'Country code'); sel.className = 'tel-cc';
    CODES.forEach(([c, n]) => { const o = document.createElement('option'); o.value = c; sel.appendChild(o); });
    // the list shows country names while open; the closed box shows just the flag and code so the number has room
    const label = full => [...sel.options].forEach((o, i) => { const [c, n] = CODES[i]; o.textContent = full ? (c ? `${flag[c] || ''} ${c}  ${n}` : 'Other: type +code') : (c ? `${flag[c] || ''} ${c}` : 'Other'); });
    label(false);
    sel.addEventListener('focus', () => label(true)); sel.addEventListener('mousedown', () => label(true));
    sel.addEventListener('blur', () => label(false));
    sel.value = code;
    const vis = real.cloneNode(); vis.removeAttribute('name'); if (real.id) { vis.id = real.id; real.id = `${real.id}-full`; } vis.value = code ? group(num, code) : num; vis.placeholder = code === '+973' ? '3333 2677' : 'Number';
    vis.setAttribute('inputmode', 'tel'); vis.dataset.cc = '1';
    real.type = 'hidden';
    real.parentNode.insertBefore(box, real); box.append(sel, vis, real);
    const sync = () => { const d = vis.value.trim(); real.value = !d ? '' : sel.value ? `${sel.value} ${group(d, sel.value)}` : d; };
    sel.addEventListener('change', () => { label(false); vis.placeholder = sel.value === '+973' ? '3333 2677' : sel.value ? 'Number' : '+code number'; sync(); });
    vis.addEventListener('input', sync);
    vis.addEventListener('blur', () => { if (sel.value) vis.value = group(vis.value, sel.value); sync(); });
    sync();
  });
})();
// Progress picker: slider + quick buttons, with the % shown beside it
document.addEventListener('input', e => {
  const r = e.target.closest('[data-progress] input[type="range"]'); if (!r) return;
  const o = r.closest('[data-progress]').querySelector('.pp-val'); if (o) o.textContent = `${r.value}%`;
});
document.addEventListener('click', e => {
  const b = e.target.closest('[data-pp]'); if (!b) return;
  const r = b.closest('[data-progress]').querySelector('input[type="range"]');
  r.value = b.dataset.pp; r.dispatchEvent(new Event('input', { bubbles: true }));
});
// Progress update: the progress picker shows only when a task is chosen, starting from the task's current %
function syncAbout(sel) {
  const box = sel.form && sel.form.querySelector('[data-task-only]'); if (!box) return;
  const opt = sel.options[sel.selectedIndex];
  box.hidden = !sel.value.startsWith('task:');
  const hint = sel.form.querySelector('[data-no-task]'); if (hint) hint.hidden = !box.hidden;
  const r = box.querySelector('input[type="range"]');
  if (r && opt && opt.dataset.progress !== undefined) { r.value = opt.dataset.progress; r.dispatchEvent(new Event('input', { bubbles: true })); }
}
document.addEventListener('change', e => { const s = e.target.closest('select[data-about]'); if (s) syncAbout(s); });
document.querySelectorAll('select[data-about]').forEach(syncAbout);
// Task form: progress and status follow each other (100% = Done, more than 0 = In progress, 0 = Not started)
document.addEventListener('input', e => {
  const r = e.target.closest('[data-progress] input[type="range"]'); if (!r || !r.form) return;
  const st = r.form.querySelector('select[name="status"]'); if (!st) return;
  const v = Number(r.value), auto = ['not_started', 'in_progress', 'done'];
  if (!auto.includes(st.value)) return;
  st.value = v === 100 ? 'done' : v > 0 ? 'in_progress' : 'not_started';
});
document.addEventListener('change', e => {
  const st = e.target.closest('select[name="status"]'); if (!st || !st.form) return;
  const r = st.form.querySelector('[data-progress] input[type="range"]'); if (!r) return;
  if (st.value === 'done' && r.value !== '100') { r.value = 100; r.dispatchEvent(new Event('input', { bubbles: true })); }
  if (st.value === 'not_started' && r.value !== '0') { r.value = 0; r.dispatchEvent(new Event('input', { bubbles: true })); }
});
// Photo uploads on phones and tablets: a "Take photo" button opens the camera directly; each photo taken is added to
// the files already chosen, and a short list shows what will be uploaded (owner request 2026-10-24).
(() => {
  const touch = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  if (!touch || typeof DataTransfer === 'undefined') return;
  document.querySelectorAll('input[type="file"]').forEach(main => {
    if (!/image/.test(main.accept || '') || main.dataset.cam) return;
    main.dataset.cam = '1';
    const cam = document.createElement('input');
    cam.type = 'file'; cam.accept = 'image/*'; cam.setAttribute('capture', 'environment'); cam.hidden = true;
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'btn small cam-btn'; btn.textContent = '📷 Take photo';
    const list = document.createElement('small'); list.className = 'cam-list muted';
    const bar = document.createElement('div'); bar.className = 'cam-bar'; bar.append(btn, list, cam);
    main.insertAdjacentElement('afterend', bar);
    const show = () => { const n = main.files.length; list.textContent = n ? `${n} file${n > 1 ? 's' : ''} ready: ${[...main.files].map(f => f.name).join(', ')}` : ''; };
    btn.addEventListener('click', () => cam.click());
    cam.addEventListener('change', () => {
      if (!cam.files.length) return;
      const dt = new DataTransfer();
      if (main.multiple) for (const f of main.files) dt.items.add(f);
      for (const f of cam.files) {
        const named = new File([f], `photo-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}-${dt.items.length + 1}.jpg`, { type: f.type || 'image/jpeg' });
        dt.items.add(named);
      }
      main.files = dt.files; cam.value = '';
      main.dispatchEvent(new Event('change', { bubbles: true }));
    });
    main.addEventListener('change', show);
  });
})();
// Opened from the home-screen icon the portal runs full screen, with no browser buttons. Files (PDF, Excel, Word,
// photos) then open in a separate viewer that has Share, Print and Done, instead of replacing the portal.
(() => {
  const standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
  if (!standalone) return;
  const isFile = a => /[?&]export=(pdf|xlsx)/.test(a.href) || /\.(pdf|xlsx|docx|csv|zip)(\/~\/[^?]*)?(\?|$)/i.test(a.href) || /\/files\/[0-9a-f-]{36}(\?|$)/i.test(a.href);
  const isPdf = a => /[?&]export=pdf/.test(a.href) || /\.pdf(\/~\/[^?]*)?(\?|$)/i.test(a.href);
  document.addEventListener('click', e => {
    const a = e.target.closest('a[href]');
    if (!a || !isFile(a) || e.defaultPrevented || a.closest('.pv-bar')) return;
    e.preventDefault();
    const u = new URL(a.href, location.href);
    if (isPdf(a) && u.origin === location.origin) { location.href = `/view?src=${encodeURIComponent(u.pathname + u.search)}`; return; }   // the portal's own viewer
    window.open(a.href, '_blank', 'noopener');
  }, true);
})();

// PDF links open a preview in a new tab (the browser's viewer has download and print), never a straight download.
// The home-screen app uses the portal's own viewer instead (above).
(() => {
  const standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
  if (standalone) return;
  document.addEventListener('click', e => {
    const a = e.target.closest('a[href]');
    if (!a || a.hasAttribute('download') || e.defaultPrevented || e.metaKey || e.ctrlKey) return;
    const u = new URL(a.href, location.href);
    if (u.origin !== location.origin || !/\.pdf$/i.test(u.pathname.replace(/\/~\/[^/]*$/, '')) || u.searchParams.get('view') === '1') return;
    e.preventDefault();
    u.searchParams.set('view', '1');
    window.open(u.toString(), '_blank', 'noopener');
  });
})();

// Forms that produce a PDF (e.g. the project report) preview it the same way instead of downloading.
document.addEventListener('submit', e => {
  const f = e.target;
  if ((f.method || 'get').toLowerCase() !== 'get' || e.defaultPrevented) return;
  const action = (e.submitter && e.submitter.getAttribute('formaction')) || f.getAttribute('action') || location.pathname;
  const u = new URL(action, location.href);
  if (u.origin !== location.origin || !/\.pdf$/i.test(u.pathname)) return;
  e.preventDefault();
  for (const [k, v] of new FormData(f)) if (typeof v === 'string') u.searchParams.append(k, v);
  u.searchParams.set('view', '1');
  const standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
  if (standalone) location.href = `/view?src=${encodeURIComponent(u.pathname + u.search)}`;
  else window.open(u.toString(), '_blank', 'noopener');
});
