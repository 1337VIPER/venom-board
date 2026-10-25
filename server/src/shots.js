// Screenshot links: a signed-in person uploads a picture (from the desktop app's screenshot tool, or any picture on a
// board) and gets a short address on this site, /s/<id>, that anyone with it can open: a page with the picture, and
// the picture itself at /s/<id>.png (or .jpg, .gif, .webp) for chats and forums that show images from a link.
//
// Links are unlisted, never guessable and never indexed: ids are 12 random characters (about 70 bits, so nobody can
// walk through them the way people did with sequential screenshot sites), pages say noindex, and the address is never
// sent on as a referrer. Before a picture is kept, it's rebuilt from only the parts needed to show it, so what it says about
// where and how it was made goes (EXIF, GPS, XMP, IPTC, comments, thumbnails, extra pictures tacked on the end). A JPEG
// keeps only which way up it goes.
//
// Each account has its own space for them (less until it confirms its email), uploads are limited per account and per
// network, and they pause before the disk fills. The owner can delete a link at any time from the app; deleting the
// account deletes them all. Anyone can report a picture from its page: the report goes to the support inbox with a
// one-click takedown.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { esc } = require('./page');
const { imageSize } = require('./mcp');

const MB = 1048576, MINUTE = 60000, HOUR = 3600000, DAY = 86400000;
const SHOT_MAX = 15 * MB;
// no 0/O, 1/I/l: an address read out or typed by hand comes out right
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz', ID_LEN = 12;
const ID = /^[2-9A-HJ-NP-Za-km-z]{12}$/;
const TYPES = [
  { mime: 'image/png', ext: 'png', test: b => b.length > 24 && b.readUInt32BE(0) === 0x89504e47 },
  { mime: 'image/jpeg', ext: 'jpg', test: b => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/gif', ext: 'gif', test: b => b.length > 6 && b.toString('latin1', 0, 4) === 'GIF8' },
  { mime: 'image/webp', ext: 'webp', test: b => b.length > 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP' },
];
const EXT = Object.fromEntries(TYPES.map(t => [t.mime, t.ext]));
// the page loads only its own picture and the site's stylesheet, runs no script, and posts only back here
const PAGE_CSP = "default-src 'none'; img-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
const PAGE_HEADERS = { 'Content-Security-Policy': PAGE_CSP, 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'no-cache' };
// control characters, and the ones that flip the direction of text (which could disguise a name), go
const CTRL = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;
const line = (v, max) => String(v ?? '').replace(CTRL, '').replace(/\s+/g, ' ').trim().slice(0, max);

function newId() {
  let id = '';
  while (id.length < ID_LEN) for (const b of crypto.randomBytes(16)) if (b < 228 && id.length < ID_LEN) id += ALPHABET[b % 57];  // 228 = 4 × 57: no bias
  return id;
}

/* ---------- taking out what a picture says about where it came from ----------
   Each picture is rebuilt from only the parts needed to show it; everything else goes, whatever it's called and
   wherever it sits (between a progressive JPEG's scans, or tacked on after the end, the way phones add motion photos,
   depth maps and second pictures with their own EXIF). A malformed file is refused rather than passed on as it is. */
// PNG: the picture, its colours and pixel size, and animation; not text, EXIF, times, content credentials or private chunks
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'cICP', 'mDCV', 'mDCv', 'cLLI', 'cLLi',
  'sBIT', 'bKGD', 'pHYs', 'hIST', 'acTL', 'fcTL', 'fdAT']);
function stripPng(b) {
  const out = [b.subarray(0, 8)];
  for (let i = 8; i + 12 <= b.length;) {
    const len = b.readUInt32BE(i), type = b.toString('latin1', i + 4, i + 8), end = i + 12 + len;
    if (len > 0x7fffffff || end > b.length) return null;
    if (PNG_KEEP.has(type)) out.push(b.subarray(i, end));
    if (type === 'IEND') return Buffer.concat(out);  // anything after the end goes too
    i = end;
  }
  return null;  // no end: a broken file
}
// which way up a JPEG goes (1 to 8), from its EXIF
function orientation(b, t, end) {
  try {
    const le = b.toString('latin1', t, t + 2) === 'II', u16 = o => (le ? b.readUInt16LE(o) : b.readUInt16BE(o)), u32 = o => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
    const ifd = t + u32(t + 4), n = u16(ifd);
    for (let k = 0; k < n && ifd + 14 + k * 12 <= end; k++) {
      const e = ifd + 2 + k * 12;
      if (u16(e) === 0x0112) { const v = u16(e + 8); return v >= 1 && v <= 8 ? v : 1; }
    }
  } catch (e) { /* a broken EXIF block says nothing */ }
  return 1;
}
// the smallest EXIF there is: a big-endian TIFF header and one entry, the orientation
const orientationExif = v => Buffer.from([0xff, 0xe1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0, 0, 0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8,
  0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, v, 0, 0, 0, 0, 0, 0]);
const EOI = Buffer.from([0xff, 0xd9]);
// JPEG: frame, scan, table and restart segments, JFIF, a colour profile and Adobe's colour transform; not EXIF, XMP, IPTC,
// comments, thumbnails (JFXX), multi-picture indexes (MPF) or anything after the end of the image
function stripJpeg(b) {
  const out = [Buffer.from([0xff, 0xd8])];
  let orient = 1;
  for (let i = 2; ;) {
    if (i + 2 > b.length || b[i] !== 0xff) return null;  // no end of image
    const m = b[i + 1];
    if (m === 0xff) { i++; continue; }  // padding before a marker
    if (m === 0xd9) { out.push(EOI); break; }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }  // a stray standalone marker
    if (i + 4 > b.length) return null;
    const end = i + 2 + b.readUInt16BE(i + 2);
    if (end > b.length || end < i + 4) return null;
    const says = s => b.toString('latin1', i + 4, i + 4 + s.length) === s;
    if (m === 0xe1 && says('Exif\0\0')) orient = orientation(b, i + 10, end);
    if ((m >= 0xc0 && m <= 0xcf && m !== 0xc8) || m === 0xda || m === 0xdb || m === 0xdc || m === 0xdd
      || (m === 0xe2 && says('ICC_PROFILE\0')) || (m === 0xee && says('Adobe'))) out.push(b.subarray(i, end));
    // the JFIF header can carry a small picture of its own: kept without it
    else if (m === 0xe0 && says('JFIF\0') && end >= i + 16) out.push(Buffer.concat([Buffer.from([0xff, 0xe0, 0, 16]), b.subarray(i + 4, i + 16), Buffer.from([0, 0])]));
    i = end;
    if (m === 0xda) {
      // a scan's coded data runs to the next marker that isn't a restart (a coded 0xFF is followed by 0x00)
      let j = i;
      while (j + 1 < b.length && !(b[j] === 0xff && b[j + 1] !== 0 && !(b[j + 1] >= 0xd0 && b[j + 1] <= 0xd7))) j++;
      if (j + 1 >= b.length) { out.push(b.subarray(i, b.length), EOI); break; }  // cut short: it ends here
      out.push(b.subarray(i, j));
      i = j;
    }
  }
  if (orient !== 1) out.splice(out.length > 1 && out[1][1] === 0xe0 ? 2 : 1, 0, orientationExif(orient));  // after JFIF, if there is one
  return Buffer.concat(out);
}
// WebP: the picture, its alpha, animation and colour profile; not EXIF, XMP, unknown chunks or anything after the file
const WEBP_KEEP = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF', 'ICCP']);
function stripWebp(b) {
  const stop = Math.min(b.length, 8 + b.readUInt32LE(4)), out = [];
  for (let i = 12; i + 8 <= stop;) {
    const type = b.toString('latin1', i, i + 4), len = b.readUInt32LE(i + 4);
    if (i + 8 + len > stop) return null;
    const end = Math.min(stop, i + 8 + len + (len & 1));  // chunks are padded to an even length
    if (WEBP_KEEP.has(type)) out.push(b.subarray(i, end));
    i = end;
  }
  if (!out.length) return null;
  const body = Buffer.concat(out), head = Buffer.from(b.subarray(0, 12));
  head.writeUInt32LE(4 + body.length, 4);
  const res = Buffer.concat([head, body]);
  if (res.toString('latin1', 12, 16) === 'VP8X') res[20] &= ~0x0c;  // the flags no longer promise EXIF (0x08) or XMP (0x04)
  return res;
}
// GIF: the picture, its frames and timing, and looping; not comments, XMP or other application data, or anything after it
function stripGif(b) {
  if (b.length < 14) return null;
  const table = flags => (flags & 0x80 ? 3 * (2 << (flags & 7)) : 0);
  // a run of data sub-blocks ends with an empty one; where it ends, or -1
  const blocks = j => { while (j < b.length) { if (b[j] === 0) return j + 1; j += 1 + b[j]; } return -1; };
  let i = 13 + table(b[10]);
  const out = [b.subarray(0, i)];
  while (i < b.length) {
    if (b[i] === 0x3b) { out.push(Buffer.from([0x3b])); return Buffer.concat(out); }
    let end;
    if (b[i] === 0x21) {
      const label = b[i + 1], app = label === 0xff && b[i + 2] === 11 ? b.toString('latin1', i + 3, i + 14) : '';
      end = blocks(i + 2);
      if (end < 0) return null;
      if (label === 0xf9 || app === 'NETSCAPE2.0' || app === 'ANIMEXTS1.0') out.push(b.subarray(i, end));
    } else if (b[i] === 0x2c) {
      if (i + 11 > b.length) return null;
      end = blocks(i + 10 + table(b[i + 9]) + 1);  // the image descriptor, its colour table and the LZW code size
      if (end < 0) return null;
      out.push(b.subarray(i, end));
    } else return null;
    i = end;
  }
  return null;  // no trailer: a broken file
}
function clean(buf, type) {
  return { png: stripPng, jpg: stripJpeg, webp: stripWebp, gif: stripGif }[type.ext](buf);
}

function shots({ db, cfg, log, route, fail, H, limit, mail, plain, secret, diskFree, sendHtml, simplePage }) {
  const dir = path.join(cfg.DATA_DIR, 'shots');
  fs.mkdirSync(dir, { recursive: true });
  const q = {
    insert: db.prepare('INSERT INTO shots (id, user_id, mime, size, width, height, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    get: db.prepare('SELECT * FROM shots WHERE id = ?'),
    mine: db.prepare('SELECT * FROM shots WHERE user_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?'),
    used: db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM shots WHERE user_id = ?'),
    ids: db.prepare('SELECT id FROM shots WHERE user_id = ?'),
    drop: db.prepare('DELETE FROM shots WHERE id = ?'),
    viewed: db.prepare('UPDATE shots SET views = views + 1 WHERE id = ?'),
  };
  const pageUrl = id => `${cfg.PUBLIC_URL}/s/${id}`;
  const imageUrl = s => `${cfg.PUBLIC_URL}/s/${s.id}.${EXT[s.mime]}`;
  const usage = u => { const r = q.used.get(u.id); return { used: r.bytes, max: cfg.SHOT_STORAGE_MB * MB, count: r.n }; };
  const pub = s => ({ id: s.id, url: pageUrl(s.id), image: imageUrl(s), name: s.name, width: s.width, height: s.height, size: s.size, views: s.views, createdAt: s.created_at });
  const removeFile = id => fs.rm(path.join(dir, id), { force: true }, () => {});
  const takedownSig = id => crypto.createHmac('sha256', secret).update('shot-takedown:' + id).digest('base64url').slice(0, 32);
  const sameSig = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

  /* ---------- the API, for the apps ---------- */
  // the picture is the request body as it is (Content-Type image/…); ?name= gives it a title for its page
  const uploading = new Set();
  route('POST', '/api/shots', async ctx => {
    const u = ctx.user;
    if (cfg.SHOTS === 'off') fail(403, 'off', 'Screenshot links are switched off on this server.');
    // public pictures on venomboard.com: only from accounts with a confirmed email, so throwaway accounts can't host them
    if (!u.emailVerified) fail(403, 'verify_first', 'Confirm your email address to make screenshot links. We sent you a link when you signed up.');
    if (Number(ctx.req.headers['content-length'] || 0) > SHOT_MAX) fail(413, 'too_large', 'Pictures can be up to 15 MB.');
    if (!limit('shot:' + u.id, 60, HOUR) || !limit('shot-day:' + u.id, 300, DAY) || !limit('shot-ip:' + ctx.ip, 120, HOUR)) fail(429, 'rate', 'That’s a lot of screenshot links in a short time. Try again later.');
    if (uploading.has(u.id)) fail(429, 'busy', 'Another upload is still going. Try again in a moment.');
    uploading.add(u.id);
    try {
      const raw = await H.readBody(ctx.req, SHOT_MAX);
      const type = TYPES.find(t => t.test(raw));
      if (!type) fail(415, 'type', 'Upload a PNG, JPEG, GIF or WebP picture.');
      const buf = clean(raw, type);
      if (!buf) fail(415, 'broken', 'That picture looks damaged. Save it again and try once more.');
      const size = imageSize(buf);
      if (!size || !(size.w > 0 && size.h > 0)) fail(415, 'broken', 'That picture looks damaged. Save it again and try once more.');
      if (size.w > 16384 || size.h > 16384 || size.w * size.h > 100e6) fail(415, 'too_big', 'That picture is too large: up to 16384 pixels a side.');
      const have = usage(u);
      if (have.used + buf.length > have.max) {
        fail(413, 'quota', `Your screenshot links use all ${Math.round(have.max / MB)} MB of your space. Delete some you don’t need any more, in Settings → Account → Screenshot links.`);
      }
      if (diskFree() - buf.length < cfg.MIN_FREE_DISK_MB * MB) fail(507, 'disk', 'The server is short on space for pictures right now. Try again later.');
      let id = newId();
      while (q.get.get(id)) id = newId();
      fs.writeFileSync(path.join(dir, id), buf);
      const name = line(ctx.url.searchParams.get('name'), 100);
      const now = Date.now();
      try { q.insert.run(id, u.id, type.mime, buf.length, size.w, size.h, name, now); } catch (e) { removeFile(id); throw e; }
      const after = usage(u);
      return { ...pub({ id, mime: type.mime, size: buf.length, width: size.w, height: size.h, name, views: 0, created_at: now }), used: after.used, max: after.max };
    } finally { uploading.delete(u.id); }
  });
  // newest first; ?before=<createdAt> for the next page
  route('GET', '/api/shots', ctx => {
    const before = Number(ctx.url.searchParams.get('before')) || Date.now() + DAY;
    const rows = q.mine.all(ctx.user.id, before, 61), more = rows.length > 60;
    return { shots: rows.slice(0, 60).map(pub), more, ...usage(ctx.user) };
  });
  route('DELETE', '/api/shots/:id', ctx => {
    const s = ID.test(ctx.params.id) ? q.get.get(ctx.params.id) : null;
    if (!s || s.user_id !== ctx.user.id) fail(404, 'not_found', 'That screenshot link is already gone.');
    q.drop.run(s.id);
    removeFile(s.id);
    return { ok: true, ...usage(ctx.user) };
  });

  /* ---------- the pages, for anyone with the link ---------- */
  const bodyOf = s => {
    const title = s.name || 'Screenshot', when = new Date(s.created_at).toISOString().slice(0, 10);
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Venom Board</title>
<meta name="robots" content="noindex, nofollow">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Venom Board">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="A screenshot shared with Venom Board">
<meta property="og:image" content="${esc(imageUrl(s))}">
<meta property="og:image:width" content="${s.width}">
<meta property="og:image:height" content="${s.height}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${esc(imageUrl(s))}">
<meta name="theme-color" content="#060609">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Unbounded:wght@800&family=Manrope:wght@600;800&display=swap">
<link rel="stylesheet" href="/web/site.css">
<style>
  body{min-height:100vh;display:flex;flex-direction:column}
  .shot-top{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 20px}
  .shot-pic{flex:1;display:flex;align-items:center;justify-content:center;padding:8px 20px}
  .shot-pic a{display:block;line-height:0}
  .shot-pic img{max-width:100%;max-height:calc(100vh - 170px);border-radius:10px;border:1px solid var(--line-2);background:#111;box-shadow:0 30px 80px -30px #000}
  .shot-foot{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:10px 18px;padding:14px 20px 22px;color:var(--bone-dim);font-size:14px}
  .shot-foot b{color:var(--bone)}
  .shot-foot details{width:100%;max-width:460px}
  .shot-foot summary{cursor:pointer;text-align:center;color:var(--bone-faint)}
  .shot-foot textarea{width:100%;min-height:80px;margin:10px 0;box-sizing:border-box;border-radius:10px;border:1px solid var(--line-2);background:var(--hide);color:var(--bone);font:500 14px var(--font-ui);padding:10px}
</style>
</head>
<body>
<header class="shot-top"><a class="brand" href="/"><img src="/favicon.svg" alt=""><span class="word">VENOM<em>/</em>BOARD</span></a><a class="btn small" href="/#download">Get the screenshot app</a></header>
<main class="shot-pic"><a href="/s/${s.id}.${EXT[s.mime]}" title="Open the full-size picture"><img src="/s/${s.id}.${EXT[s.mime]}" width="${s.width}" height="${s.height}" alt="${esc(title)}"></a></main>
<footer class="shot-foot">
  <span><b>${esc(title)}</b> · ${s.width} × ${s.height} · ${when}</span>
  <a class="btn small" href="/s/${s.id}.${EXT[s.mime]}">Open full size</a>
  <a class="btn small" href="/s/${s.id}/download">Download</a>
  <details><summary>Report this picture</summary>
    <form method="post" action="/s/${s.id}/report"><textarea name="reason" maxlength="1000" required placeholder="What’s wrong with it?"></textarea><button class="btn small danger" type="submit">Send report</button></form>
  </details>
</footer>
</body>
</html>`;
  };
  const say = (res, status, title, text, extra = '') => sendHtml(res, status, simplePage(title, `<p>${esc(text)}</p>${extra}`), PAGE_HEADERS);
  // a small urlencoded form body (the report form)
  const formBody = req => H.readBody(req, 8192).then(b => new URLSearchParams(b.toString('utf8')), () => new URLSearchParams());

  async function page(req, res, url, ip) {
    const m = /^\/s\/([A-Za-z0-9]{12})(?:\.(png|jpg|gif|webp)|\/(download|report|takedown))?$/.exec(url.pathname);
    if (!m) return false;
    if (!limit('shot-page:' + ip, 240, MINUTE)) { res.writeHead(429, { 'Retry-After': '60', 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Too many requests. Try again in a minute.'); return true; }
    const s = ID.test(m[1]) ? q.get.get(m[1]) : null, act = m[3];
    const post = req.method === 'POST';
    if (post && act !== 'report' && act !== 'takedown') { req.resume(); res.writeHead(405); res.end(); return true; }
    if (!post && req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return true; }
    if (!s || (m[2] && m[2] !== EXT[s.mime])) {
      if (post) req.resume();
      say(res, 404, 'Screenshot not found', 'This screenshot link doesn’t work. Its owner may have deleted it.');
      return true;
    }
    if (m[2] || act === 'download') {
      const file = `${(s.name || 'Screenshot').replace(/[^\w .-]+/g, '').trim().slice(0, 80) || 'Screenshot'}.${EXT[s.mime]}`;
      // kept briefly by browsers, but never by Cloudflare, so a deleted picture stops working there straight away
      return H.serveFile(res, dir, s.id, { 'Content-Type': s.mime, 'Cache-Control': 'public, max-age=300', 'CDN-Cache-Control': 'no-store', 'Cloudflare-CDN-Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'", 'X-Robots-Tag': 'noindex',
        'Access-Control-Allow-Origin': '*', 'Content-Disposition': `${act === 'download' ? 'attachment' : 'inline'}; filename="${file}"` }, 200, req) || (say(res, 404, 'Screenshot not found', 'This screenshot is missing.'), true);
    }
    if (act === 'report') {
      if (!post) { say(res, 200, 'Report this picture', 'Use the Report link under the picture to tell us what’s wrong with it.', `<p><a class="btn" href="/s/${s.id}">Back to the picture</a></p>`); return true; }
      const said = line((await formBody(req)).get('reason'), 1000);
      if (!said) { say(res, 400, 'Report this picture', 'Tell us what’s wrong with the picture.'); return true; }
      const reason = plain(said, 1000);  // as plain words: no links in the email
      if (!limit('shot-report-ip:' + ip, 3, DAY) || !limit('shot-report:' + s.id, 5, DAY) || !limit('shot-report-all', 300, DAY)) { log('[report] screenshot', s.id, 'over the day’s limit:', reason.slice(0, 300)); say(res, 429, 'Thanks', 'We’ve had a lot of reports today. Email support@venomboard.com if it’s urgent.'); return true; }
      mail('alert', { to: cfg.ALERT_EMAIL, subject: 'A Venom Board screenshot link was reported',
        text: `Someone reported the screenshot ${pageUrl(s.id)} (uploaded by account ${s.user_id}).\n\nWhat they said:\n${reason}\n\nTake it down with one click: ${pageUrl(s.id)}/takedown?t=${takedownSig(s.id)}` });
      say(res, 200, 'Thanks for the report', 'We’ll take a look at it.');
      return true;
    }
    if (act === 'takedown') {
      // opening the link only asks; the button (a POST) does it, so mail scanners that follow links change nothing
      const t = url.searchParams.get('t') || '';
      if (post) req.resume();
      if (!sameSig(t, takedownSig(s.id))) { say(res, 403, 'Take down', 'That link is incomplete.'); return true; }
      if (!post) { say(res, 200, 'Take down', 'Delete this screenshot link for good?', `<form method="post" action="/s/${s.id}/takedown?t=${esc(t)}"><button class="btn red" type="submit">Delete it</button></form>`); return true; }
      q.drop.run(s.id);
      removeFile(s.id);
      log('[takedown] shot', s.id);
      say(res, 200, 'Taken down', 'The screenshot link is deleted.');
      return true;
    }
    if (req.method === 'GET') q.viewed.run(s.id);
    if (req.method === 'HEAD') { res.writeHead(200, { ...PAGE_HEADERS, 'Content-Type': 'text/html; charset=utf-8' }); res.end(); return true; }
    sendHtml(res, 200, bodyOf(s), PAGE_HEADERS);
    return true;
  }

  // an account being deleted takes its screenshot links with it: the rows go with the account, the files here
  const filesOf = userId => q.ids.all(userId).map(r => r.id);
  const removeFiles = ids => { for (const id of ids) removeFile(id); };
  return { page, filesOf, removeFiles };
}

module.exports = { shots, stripPng, stripJpeg, stripWebp, stripGif, newId };
