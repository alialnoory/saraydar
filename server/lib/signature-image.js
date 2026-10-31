'use strict';
// Signature and stamp pictures: a scan or phone photo on white paper becomes a transparent PNG, so it prints cleanly
// on the agreement (owner request 2026-10-31). A drawing from the signing pad is already transparent.
const sharp = require('sharp');

async function clean(buf, { max = 700 } = {}) {
  const img = sharp(buf, { failOn: 'none' }).rotate().resize(max, max, { fit: 'inside', withoutEnlargement: true }).ensureAlpha();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2], light = (r + g + b) / 3;
    if (light > 225) data[i + 3] = 0;                              // paper → transparent
    else if (light > 170) data[i + 3] = Math.min(data[i + 3], Math.round((225 - light) / 55 * 255));   // soft edges
  }
  return sharp(data, { raw: info }).trim({ threshold: 1 }).png().toBuffer().catch(() => sharp(data, { raw: info }).png().toBuffer());
}

// A drawing from the signing pad, sent as a data URL; must be a real PNG of reasonable size with something drawn.
async function fromDataUrl(s) {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(s || ''));
  if (!m) return null;
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length < 200 || buf.length > 600 * 1024) return null;
  const meta = await sharp(buf).metadata().catch(() => null);
  if (!meta || meta.format !== 'png') return null;
  const st = await sharp(buf).stats().catch(() => null);
  if (!st || !st.channels[3] || st.channels[3].max === 0) return null;      // nothing drawn
  return sharp(buf).trim({ threshold: 1 }).png().toBuffer().catch(() => buf);
}

module.exports = { clean, fromDataUrl };
