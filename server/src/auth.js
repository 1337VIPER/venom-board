// Passwords are hashed with scrypt; session tokens are random and only their SHA-256 is stored,
// so a copy of the database never contains a usable login.
const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  const [alg, N, r, p, saltB64, keyB64] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, { N: +N, r: +r, p: +p });
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

const newToken = () => crypto.randomBytes(32).toString('base64url');
const tokenHash = token => crypto.createHash('sha256').update(String(token)).digest('hex');
const newId = () => crypto.randomBytes(9).toString('base64url');

function sessions(db, days) {
  const insert = db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)');
  const find = db.prepare(`SELECT s.expires_at, u.id, u.email, u.username, u.display_name, u.color, u.email_verified
    FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`);
  const extend = db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?');
  const remove = db.prepare('DELETE FROM sessions WHERE token_hash = ?');
  const purge = db.prepare('DELETE FROM sessions WHERE expires_at < ?');
  const ttl = days * 86400000;
  return {
    create(userId) {
      const token = newToken(), now = Date.now();
      insert.run(tokenHash(token), userId, now, now + ttl);
      return token;
    },
    user(token) {
      if (!token) return null;
      const h = tokenHash(token), row = find.get(h), now = Date.now();
      if (!row) return null;
      if (row.expires_at < now) { remove.run(h); return null; }
      if (row.expires_at - now < ttl - 86400000) extend.run(now + ttl, h);  // sliding expiry, written at most daily
      return { id: row.id, email: row.email, emailVerified: !!row.email_verified, username: row.username, displayName: row.display_name, color: row.color };
    },
    destroy(token) { if (token) remove.run(tokenHash(token)); },
    purge() { purge.run(Date.now()); },
  };
}

// Small in-memory sliding-window limiter for sign-in, sign-up and reset requests.
function rateLimiter() {
  const hits = new Map();  // key -> { windowMs, list of times }
  // a key is forgotten only once its own window has passed, so daily limits really last a day
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.list.every(t => now - t > v.windowMs)) hits.delete(k); }, 600000).unref();
  const limit = (key, max, windowMs) => {
    const now = Date.now(), list = ((hits.get(key) || {}).list || []).filter(t => now - t < windowMs);
    hits.set(key, { windowMs, list });
    if (list.length >= max) return false;
    list.push(now);
    return true;
  };
  limit.clear = key => hits.delete(key);
  return limit;
}

module.exports = { hashPassword, verifyPassword, newToken, tokenHash, newId, sessions, rateLimiter };
