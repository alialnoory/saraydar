'use strict';
const crypto = require('crypto');

const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');

// AES-256-GCM for secrets at rest (MFA seeds). Key derived from the app secret.
function keyFrom(secret) { return crypto.createHash('sha256').update('saraydar-at-rest:' + secret).digest(); }
function encrypt(secret, plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keyFrom(secret), iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
}
function decrypt(secret, box) {
  const [v, iv, tag, enc] = String(box).split('.');
  if (v !== 'v1') throw new Error('Unknown secret format');
  const d = crypto.createDecipheriv('aes-256-gcm', keyFrom(secret), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]).toString('utf8');
}

// ---- TOTP (RFC 6238, SHA-1, 30 s, 6 digits) ----
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const b of buf) { value = (value << 8) | b; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(s) {
  const clean = String(s).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0; const out = [];
  for (const ch of clean) { value = (value << 5) | B32.indexOf(ch); bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
const newTotpSecret = () => base32Encode(crypto.randomBytes(20));
function totpAt(secret, counter) {
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const o = h[h.length - 1] & 15;
  const code = ((h.readUInt32BE(o) & 0x7fffffff) % 1e6).toString().padStart(6, '0');
  return code;
}
function verifyTotp(secret, code, now = Date.now(), window = 1) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return false;
  const step = Math.floor(now / 30000);
  for (let w = -window; w <= window; w++) {
    if (crypto.timingSafeEqual(Buffer.from(totpAt(secret, step + w)), Buffer.from(c))) return true;
  }
  return false;
}
const otpauthUrl = (secret, account, issuer = 'SarayDar') =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

function newRecoveryCodes(n = 8) {
  const codes = Array.from({ length: n }, () => {
    const s = crypto.randomBytes(5).toString('hex').toUpperCase();
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
  return { codes, hashes: codes.map(c => sha256(c)) };
}

module.exports = { randomToken, sha256, encrypt, decrypt, newTotpSecret, totpAt, verifyTotp, otpauthUrl, newRecoveryCodes, base32Encode };
