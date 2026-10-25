// Minimal HTTP helpers: JSON bodies with size limits, cookies, errors and safe static files.
const fs = require('fs');
const path = require('path');

class HttpError extends Error {
  constructor(status, code, message) { super(message || code); this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new HttpError(status, code, message); };

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > maxBytes) { reject(new HttpError(413, 'too_large', 'That request is too large.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req, maxBytes = 1e6) {
  const buf = await readBody(req, maxBytes);
  if (!buf.length) return {};
  // HTML forms can't send this content type, so a hostile page can't post here without a CORS preflight
  if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) throw new HttpError(415, 'type', 'Send the request body as JSON.');
  try { const v = JSON.parse(buf.toString('utf8')); return v && typeof v === 'object' ? v : {}; }
  catch (e) { throw new HttpError(400, 'bad_json', 'The request body is not valid JSON.'); }
}

function sendJson(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const v = safeDecode(part.slice(i + 1).trim());
    if (v !== null) out[part.slice(0, i).trim()] = v;  // a malformed cookie is skipped, never fatal
  }
  return out;
}
// decodeURIComponent throws on malformed escapes (%E0%A4%A); anything from a request goes through this instead
function safeDecode(s) { try { return decodeURIComponent(s); } catch (e) { return null; } }
// The session cookie: on https it carries the __Host- prefix, so another subdomain can't set or shadow it. One set
// under the old name keeps working until it runs out, and signing in or out clears it.
const sessionName = secure => (secure ? '__Host-vb_session' : 'vb_session');
const sessionCookie = req => { const c = parseCookies(req); return c['__Host-vb_session'] || c.vb_session; };
const oldSessionGone = secure => (secure ? [cookie('vb_session', '', { maxAge: 0, secure })] : []);
function cookie(name, value, { maxAge, secure, path = '/' }) {
  return `${name}=${encodeURIComponent(value)}; Path=${path}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}${maxAge !== undefined ? `; Max-Age=${maxAge}` : ''}`;
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8',
};

// Serve a file from inside `root` only; anything resolving outside it is a 404. Given the request, a single
// byte range is honoured (videos need it to seek, and Safari to play at all).
function serveFile(res, root, rel, headers = {}, status = 200, req = null) {
  const full = path.resolve(root, '.' + path.sep + rel);
  if (!full.startsWith(path.resolve(root) + path.sep) && full !== path.resolve(root)) return false;
  let stat;
  try { stat = fs.statSync(full); } catch (e) { return false; }
  if (!stat.isFile()) return false;
  const base = { 'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', ...headers };
  const range = req && status === 200 ? /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || '').trim()) : null;
  if (range && (range[1] || range[2])) {
    const size = stat.size;
    let start = range[1] === '' ? Math.max(0, size - Number(range[2])) : Number(range[1]);
    let end = range[1] === '' || range[2] === '' ? size - 1 : Math.min(Number(range[2]), size - 1);
    if (!(start <= end && start < size)) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return true; }
    res.writeHead(206, { ...base, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') res.end(); else fs.createReadStream(full, { start, end }).pipe(res);
    return true;
  }
  res.writeHead(status, { ...base, 'Content-Length': stat.size, ...(req ? { 'Accept-Ranges': 'bytes' } : {}) });
  if (req && req.method === 'HEAD') res.end(); else fs.createReadStream(full).pipe(res);
  return true;
}

function clientIp(req, trustProxy) {
  if (trustProxy) {
    // Caddy sets X-Real-IP to the visitor's address; behind Cloudflare it takes it from CF-Connecting-IP,
    // trusting that header only on connections that really come from Cloudflare
    const real = req.headers['x-real-ip'];
    if (real) return netKey(String(real).trim());
  }
  return netKey(String(req.socket.remoteAddress || '').trim());
}
// The address limits count: an IPv4 address as it is, an IPv6 one as its /64, because a single IPv6 visitor
// usually has a whole /64 and could otherwise get fresh limits from every address in it.
function netKey(ip) {
  const s = String(ip).replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');
  if (!s.includes(':')) return s;
  const [a, b = ''] = s.split('::'), head = a ? a.split(':') : [], tail = b ? b.split(':') : [];
  const groups = s.includes('::') ? [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail] : head;
  return groups.slice(0, 4).map(x => (parseInt(x, 16) || 0).toString(16)).join(':') + '::/64';
}

module.exports = { HttpError, fail, readBody, readJson, sendJson, parseCookies, cookie, serveFile, clientIp, netKey, safeDecode , sessionName, sessionCookie, oldSessionGone };
