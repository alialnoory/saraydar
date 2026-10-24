// Renders a portal PDF page by page (pdf.js) with Back, Share / Print and Download.
import * as pdfjs from '/static/pdfjs/pdf.min.mjs';
pdfjs.GlobalWorkerOptions.workerSrc = '/static/pdfjs/pdf.worker.min.mjs';

const box = document.getElementById('pv-pages');
const src = box.dataset.src; let name = box.dataset.name || 'SarayDar.pdf';
let blob = null;

document.getElementById('pv-back').addEventListener('click', () => {
  if (history.length > 1) history.back(); else location.href = '/';
});

async function load() {
  const r = await fetch(src, { credentials: 'same-origin' });
  if (!r.ok) throw new Error(r.status === 403 ? 'You do not have access to this file.' : `The file could not be opened (${r.status}).`);
  blob = await r.blob();
  // the file's own name (from the portal) when the link did not carry one
  const cd = r.headers.get('content-disposition') || '';
  const m = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  if (m && name === 'SarayDar.pdf') { try { name = decodeURIComponent(m[1]); const el = document.querySelector('.pv-name'); if (el && el.firstChild) el.firstChild.textContent = name.replace(/\.pdf$/i, ''); document.title = name; } catch (e) { /* keep the default */ } }
  const data = new Uint8Array(await blob.arrayBuffer());
  const pdf = await pdfjs.getDocument({ data, isEvalSupported: false, standardFontDataUrl: '/static/pdfjs-fonts/' }).promise;
  box.innerHTML = '';
  const info = document.getElementById('pv-info'); if (info) info.textContent = `PDF · ${pdf.numPages} page${pdf.numPages > 1 ? 's' : ''}`;
  const width = Math.min(box.clientWidth || window.innerWidth, 1000) - 16;
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const scale = width / base.width, ratio = Math.min(window.devicePixelRatio || 1, 3);
    const vp = page.getViewport({ scale: scale * ratio });
    const c = document.createElement('canvas');
    c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
    c.style.width = `${Math.floor(vp.width / ratio)}px`; c.style.height = `${Math.floor(vp.height / ratio)}px`;
    c.className = 'pv-page';
    box.appendChild(c);
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
  }
}

document.getElementById('pv-share').addEventListener('click', async () => {
  try {
    if (!blob) blob = await (await fetch(src, { credentials: 'same-origin' })).blob();
    const file = new File([blob], name, { type: 'application/pdf' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file] }); return; }   // no title: apps like WhatsApp would send it again as a message
  } catch (e) { if (e && e.name === 'AbortError') return; }
  // no share sheet (most computers): open the PDF in the browser, which has its own print and download buttons
  window.open(src, '_blank', 'noopener');
});

load().catch(e => { box.innerHTML = ''; const p = document.createElement('p'); p.className = 'pv-msg'; p.textContent = e.message || 'The file could not be opened.'; box.appendChild(p); });
