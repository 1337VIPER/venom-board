// Two-step sign-in: the 6-digit codes authenticator apps show (RFC 6238, SHA-1, 30-second steps),
// and one-time recovery codes for when the phone is lost.
const crypto = require('crypto');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32(buf) {
  let bits = 0, value = 0, out = '';
  for (const b of buf) {
    value = ((value << 8) | b) & 0xffff; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function unbase32(s) {
  const clean = String(s).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    value = ((value << 5) | B32.indexOf(ch)) & 0xffff; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

const newSecret = () => base32(crypto.randomBytes(20));
function codeAt(secret, step) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', unbase32(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}
// Accepts the current code or the one either side of it (phone clocks drift). Returns the step that matched,
// which the caller stores so the same code can never be used twice; 0 means no match.
function check(secret, input, lastStep = 0, now = Date.now()) {
  const c = String(input || '').replace(/[\s-]/g, '');
  if (!secret || !/^\d{6}$/.test(c)) return 0;
  const step = Math.floor(now / 30000);
  for (const s of [step - 1, step, step + 1]) {
    if (s > lastStep && crypto.timingSafeEqual(Buffer.from(codeAt(secret, s)), Buffer.from(c))) return s;
  }
  return 0;
}
const uri = (secret, account, issuer = 'Venom Board') =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&digits=6&period=30`;

// ten codes like "k7wq-2mzx", shown once; only their hashes are kept
function recoveryCodes() {
  return Array.from({ length: 10 }, () => {
    const s = base32(crypto.randomBytes(5)).toLowerCase();
    return s.slice(0, 4) + '-' + s.slice(4, 8);
  });
}
const normalizeRecovery = s => String(s || '').toLowerCase().replace(/[^a-z2-7]/g, '');

module.exports = { newSecret, codeAt, check, uri, recoveryCodes, normalizeRecovery, base32, unbase32 };
