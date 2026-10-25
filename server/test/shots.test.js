// End-to-end tests for screenshot links (/s/<id>): uploading, what's taken out of a picture first, the page and the
// picture for anyone with the link, each account's space, deleting, reports and takedowns, and deleting the account.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { start } = require('../src/index');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'venom-board-shots-'));
const APPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'venom-board-app-'));
fs.writeFileSync(path.join(APPDIR, 'index.html'), '<!doctype html><title>Venom Board</title>');
const mail = [];
let srv, base;
const S = {};

async function api(method, p, body, token, headers = {}) {
  const r = await fetch(base + p, {
    method, redirect: 'manual',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers },
    body: body === undefined ? undefined : Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body),
  });
  const buf = Buffer.from(await r.arrayBuffer()), text = buf.toString('utf8');
  let data = null; try { data = JSON.parse(text); } catch (e) { data = text; }
  return { status: r.status, data, buf, headers: r.headers };
}
const upload = (token, buf, name) => api('POST', '/api/shots' + (name ? '?name=' + encodeURIComponent(name) : ''), buf, token, { 'Content-Type': 'image/png' });
const idOf = url => url.split('/s/')[1].split('.')[0];

// a PNG: the signature, IHDR (w × h), any extra chunks, then IEND (CRCs aren't checked here)
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, data, Buffer.alloc(4)]);
}
function png(w, h, extra = []) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), ...extra, chunk('IDAT', Buffer.from('789c6360000002000154', 'hex')), chunk('IEND', Buffer.alloc(0))]);
}
// a JPEG with EXIF (turned a quarter: orientation 6, and a GPS block), a comment, a frame header (w × h) and some scan
function jpeg(w, h) {
  const tiff = Buffer.alloc(40);
  tiff.write('MM', 0, 'latin1'); tiff.writeUInt16BE(42, 2); tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(2, 8);  // two entries: orientation and a GPS pointer
  tiff.writeUInt16BE(0x0112, 10); tiff.writeUInt16BE(3, 12); tiff.writeUInt32BE(1, 14); tiff.writeUInt16BE(6, 18);
  tiff.writeUInt16BE(0x8825, 22); tiff.writeUInt16BE(4, 24); tiff.writeUInt32BE(1, 26); tiff.writeUInt32BE(38, 30);
  const exifBody = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff, Buffer.from('GPS 51.5007N 0.1246W HOME', 'latin1')]);
  const seg = (m, body) => { const l = Buffer.alloc(4); l[0] = 0xff; l[1] = m; l.writeUInt16BE(body.length + 2, 2); return Buffer.concat([l, body]); };
  const sof = Buffer.alloc(15); sof[0] = 8; sof.writeUInt16BE(h, 1); sof.writeUInt16BE(w, 3); sof[5] = 3;
  return Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')), seg(0xe1, exifBody),
    seg(0xfe, Buffer.from('taken at my house', 'latin1')), seg(0xc0, sof), seg(0xda, Buffer.alloc(10)), Buffer.from([1, 2, 3, 0xff, 0xd9])]);
}
// an extended WebP: VP8X (w × h, saying it has EXIF and XMP), EXIF, XMP and a VP8L image chunk
function webp(w, h) {
  const riffChunk = (type, data) => { const head = Buffer.alloc(8); head.write(type, 0, 'latin1'); head.writeUInt32LE(data.length, 4); return Buffer.concat([head, data, data.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]); };
  const vp8x = Buffer.alloc(10); vp8x[0] = 0x0c; vp8x.writeUIntLE(w - 1, 4, 3); vp8x.writeUIntLE(h - 1, 7, 3);
  const body = Buffer.concat([riffChunk('VP8X', vp8x), riffChunk('EXIF', Buffer.from('MM\0*GPS 51.5N home', 'latin1')), riffChunk('XMP ', Buffer.from('<x:xmpmeta>secret</x:xmpmeta>')), riffChunk('VP8L', Buffer.from([0x2f, 0, 0, 0, 0])), riffChunk('XYZW', Buffer.from('unknown secret'))]);
  const head = Buffer.alloc(12); head.write('RIFF', 0, 'latin1'); head.writeUInt32LE(4 + body.length, 4); head.write('WEBP', 8, 'latin1');
  return Buffer.concat([head, body, Buffer.from('after the RIFF: GPS home')]);
}
// a GIF (w × h) with a comment, XMP, looping, a frame, and something after its end
function gif(w, h) {
  const sub = s => { const d = Buffer.from(s, 'latin1'); return Buffer.concat([Buffer.from([d.length]), d, Buffer.from([0])]); };
  const lsd = Buffer.alloc(7); lsd.writeUInt16LE(w, 0); lsd.writeUInt16LE(h, 2); lsd[4] = 0x80;  // a 2-colour global table
  const desc = Buffer.alloc(10); desc[0] = 0x2c; desc.writeUInt16LE(w, 5); desc.writeUInt16LE(h, 7);
  return Buffer.concat([Buffer.from('GIF89a', 'latin1'), lsd, Buffer.from([0, 0, 0, 255, 255, 255]),
    Buffer.from([0x21, 0xfe]), sub('secret note from my phone'),
    Buffer.from([0x21, 0x01, 12]), Buffer.alloc(12), sub('plain text secret'),
    Buffer.from([0x21, 0xff]), sub('XMP DataXMP').subarray(0, 12), Buffer.from([0x17]), Buffer.from('<x:xmp>GPS home</x:xmp>', 'latin1'), Buffer.from([0]),
    Buffer.from([0x21, 0xff, 0x0b]), Buffer.from('NETSCAPE2.0', 'latin1'), Buffer.from([3, 1, 0, 0, 0]),
    Buffer.from([0x21, 0xf9, 4, 0, 10, 0, 0, 0]), desc, Buffer.from([2, 2, 0x4c, 0x01, 0]), Buffer.from([0x3b]), Buffer.from('after the end: GPS', 'latin1')]);
}
// a JPEG the way phones and editors make them: a thumbnail (JFXX), a multi-picture index (MPF), a colour profile,
// progressive scans with EXIF and a comment between them, and a second picture with its own EXIF after the end
function phoneJpeg(w, h) {
  const seg = (m, body) => { const d = Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1'), l = Buffer.alloc(4); l[0] = 0xff; l[1] = m; l.writeUInt16BE(d.length + 2, 2); return Buffer.concat([l, d]); };
  const sof = Buffer.alloc(15); sof[0] = 8; sof.writeUInt16BE(h, 1); sof.writeUInt16BE(w, 3); sof[5] = 3;
  const sos = Buffer.from([3, 1, 0, 2, 0, 3, 0, 0, 0x3f, 0]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xe0, 'JFIF\0\x01\x01\0\0\x01\0\x01\x01\x01JFIF-THUMB'), seg(0xe0, 'JFXX\0\x10THUMB-SECRET'), seg(0xe2, 'MPF\0MM\0*MPF-SECRET'),
    seg(0xe2, 'ICC_PROFILE\0\x01\x01colours'), seg(0xc2, sof), seg(0xc4, 'tables'), seg(0xda, sos), Buffer.from([1, 0xff, 0, 2, 0xff, 0xd0, 3]),
    seg(0xe1, 'Exif\0\0MM\0*GPS between scans'), seg(0xfe, 'comment between scans'), seg(0xc4, 'tables'), seg(0xda, sos), Buffer.from([4, 5]),
    Buffer.from([0xff, 0xd9]), Buffer.from([0xff, 0xd8]), seg(0xe1, 'Exif\0\0MM\0*GPS of the second picture'), Buffer.from([0xff, 0xd9])]);
}

test.before(async () => {
  srv = await start({ PORT: '0', DATA_DIR: DATA, APP_DIR: APPDIR, PUBLIC_URL: 'http://localhost:9', QUIET: 'true', MAIL_PER_10_MIN: '100000', RATE_SCALE: '50',
    MIN_FREE_DISK_MB: '0', ALERT_EMAIL: 'owner@studio.test', SHOT_STORAGE_MB: '1' }, { mail: async m => { mail.push(m); return true; } });
  base = `http://127.0.0.1:${srv.port}`;
  for (const u of ['ana', 'ben', 'cal']) {
    const r = await api('POST', '/api/auth/signup', { email: `${u}@studio.test`, username: u, password: 'correct horse', displayName: u });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    S[u] = r.data.token;
  }
  // ana and ben confirm their email; cal doesn't, so can't make links
  for (const u of ['ana', 'ben']) {
    const verify = mail.filter(m => m.to === `${u}@studio.test`).pop().text.match(/#verify=([\w-]+)/)[1];
    assert.equal((await api('POST', '/api/auth/verify', { token: verify })).status, 200);
  }
});
test.after(async () => { await srv.close(); for (const d of [DATA, APPDIR]) fs.rmSync(d, { recursive: true, force: true }); });

test('uploading gives a short link; text chunks come out of a PNG', async () => {
  const pic = Buffer.concat([png(640, 360, [chunk('tEXt', Buffer.from('Comment\0made on my secret machine', 'latin1')), chunk('pHYs', Buffer.alloc(9)),
    chunk('prVt', Buffer.from('camera serial SN-48151623')), chunk('caBX', Buffer.from('content credentials: Jane Doe'))]), Buffer.from('tacked on after the end: GPS 51.5N')]);
  assert.equal((await upload(null, pic)).status, 401);
  const unconfirmed = await upload(S.cal, pic);
  assert.equal(unconfirmed.status, 403);
  assert.equal(unconfirmed.data.code, 'verify_first');
  const r = await upload(S.ana, pic, 'Bug in the ‮menu‬\n  screen');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(r.data.url, /^http:\/\/localhost:9\/s\/[2-9A-HJ-NP-Za-km-z]{12}$/);
  assert.equal(r.data.image, r.data.url + '.png');
  assert.deepEqual([r.data.width, r.data.height, r.data.name], [640, 360, 'Bug in the menu screen']);
  assert.ok(r.data.used > 0 && r.data.max === 1048576);
  S.first = idOf(r.data.url);

  const raw = await api('GET', `/s/${S.first}.png`);
  assert.equal(raw.status, 200);
  assert.equal(raw.headers.get('content-type'), 'image/png');
  assert.equal(raw.headers.get('access-control-allow-origin'), '*');
  assert.match(raw.headers.get('content-disposition'), /^inline; filename="Bug in the menu screen.png"$/);
  assert.ok(!raw.buf.includes('secret machine'), 'the text chunk is gone');
  assert.ok(!raw.buf.includes('SN-48151623') && !raw.buf.includes('Jane Doe') && !raw.buf.includes('after the end'), 'private chunks, credentials and anything after the end go too');
  assert.ok(raw.buf.includes('pHYs') && raw.buf.includes('IDAT') && raw.buf.includes('IEND'), 'the picture itself stays');
  assert.equal(raw.buf.length, r.data.size);
  const dl = await api('GET', `/s/${S.first}/download`);
  assert.match(dl.headers.get('content-disposition'), /^attachment;/);
  // the wrong extension, a malformed id and an unknown one are all not found
  for (const p of [`/s/${S.first}.jpg`, '/s/0OIl1abcdefg', '/s/abcdefghijkm', `/s/${S.first}/nope`]) assert.equal((await api('GET', p, undefined, null, { Accept: 'text/html' })).status, 404, p);
});

test('the page shows the picture to anyone, stays out of search engines and counts views', async () => {
  const r = await api('GET', `/s/${S.first}`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^text\/html/);
  assert.equal(r.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  assert.match(r.headers.get('content-security-policy'), /script-src|default-src 'none'/);
  assert.ok(!/<script/i.test(r.data), 'the page runs no script');
  assert.ok(r.data.includes(`<meta property="og:image" content="http://localhost:9/s/${S.first}.png">`));
  assert.ok(r.data.includes('<meta name="twitter:card" content="summary_large_image">'));
  assert.ok(r.data.includes('Bug in the menu screen'));
  assert.equal((await api('HEAD', `/s/${S.first}`)).status, 200);
  await api('GET', `/s/${S.first}`);
  const list = await api('GET', '/api/shots', undefined, S.ana);
  assert.equal(list.data.shots[0].views, 2, 'two GETs, the HEAD not counted');
  assert.equal((await api('POST', `/s/${S.first}.png`, 'x', null, { 'Content-Type': 'text/plain' })).status, 405);
});

test('a JPEG loses its EXIF, comment and location but keeps which way up it goes; a WebP loses EXIF and XMP', async () => {
  const r = await upload(S.ana, jpeg(400, 300));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.image.slice(-4), '.jpg');
  assert.deepEqual([r.data.width, r.data.height], [300, 400], 'turned by its orientation');
  const raw = (await api('GET', new URL(r.data.image).pathname)).buf;
  assert.ok(!raw.includes('GPS') && !raw.includes('my house') && !raw.includes('HOME'));
  assert.ok(raw.includes('JFIF'), 'JFIF stays');
  const exif = raw.indexOf('Exif\0\0');
  assert.ok(exif > 0, 'a new EXIF block with the orientation only');
  assert.equal(raw.readUInt16BE(exif + 6 + 8), 1, 'one entry');
  assert.deepEqual([raw.readUInt16BE(exif + 6 + 10), raw.readUInt16BE(exif + 6 + 18)], [0x0112, 6]);
  assert.ok(raw.subarray(raw.length - 5).equals(Buffer.from([1, 2, 3, 0xff, 0xd9])), 'the image data is untouched');

  const w = await upload(S.ana, webp(320, 200));
  assert.equal(w.status, 200, JSON.stringify(w.data));
  assert.deepEqual([w.data.width, w.data.height], [320, 200]);
  const wr = (await api('GET', new URL(w.data.image).pathname)).buf;
  assert.ok(!wr.includes('EXIF') && !wr.includes('XMP ') && !wr.includes('secret'));
  assert.equal(wr.readUInt32LE(4), wr.length - 8, 'the RIFF size fits what is left');
  assert.equal(wr[20] & 0x0c, 0, 'the header no longer says it has EXIF or XMP');
  assert.ok(wr.includes('VP8L'));
  assert.ok(!wr.includes('XYZW') && !wr.includes('after the RIFF'), 'unknown chunks and anything after the file go');
});

test('only what shows the picture is kept: phone JPEGs and GIFs too', async () => {
  const j = await upload(S.ana, phoneJpeg(320, 240));
  assert.equal(j.status, 200, JSON.stringify(j.data));
  const jr = (await api('GET', new URL(j.data.image).pathname)).buf;
  for (const s of ['THUMB-SECRET', 'JFIF-THUMB', 'MPF-SECRET', 'GPS', 'between scans']) assert.ok(!jr.includes(s), s);
  assert.ok(jr.includes('JFIF') && jr.includes('ICC_PROFILE'), 'JFIF and the colour profile stay');
  assert.ok(jr.includes(Buffer.from([1, 0xff, 0, 2, 0xff, 0xd0, 3])) && jr.includes(Buffer.from([4, 5, 0xff, 0xd9])), 'both scans stay, stuffed bytes and restarts included');
  assert.equal(jr.indexOf(Buffer.from([0xff, 0xd8]), 2), -1, 'the second picture after the end is gone');
  assert.deepEqual([j.data.width, j.data.height], [320, 240]);

  const g = await upload(S.ana, gif(8, 6));
  assert.equal(g.status, 200, JSON.stringify(g.data));
  assert.equal(g.data.image.slice(-4), '.gif');
  const gr = (await api('GET', new URL(g.data.image).pathname)).buf;
  for (const s of ['secret note', 'plain text secret', 'XMP DataXMP', 'GPS', 'after the end']) assert.ok(!gr.includes(s), s);
  assert.ok(gr.includes('NETSCAPE2.0'), 'looping stays');
  assert.equal(gr[gr.length - 1], 0x3b);
  assert.deepEqual([g.data.width, g.data.height], [8, 6]);
  assert.equal((await upload(S.ana, gif(8, 6).subarray(0, 40))).status, 415, 'a GIF cut short');
});

test('only pictures, nothing broken, and each account has its own space', async () => {
  assert.equal((await upload(S.ana, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).status, 415);
  assert.equal((await upload(S.ana, png(10, 10).subarray(0, 40))).status, 415, 'a PNG with no end');
  assert.equal((await upload(S.ana, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]))).status, 415, 'a JPEG cut short');
  const huge = await upload(S.ana, png(20000, 20000));
  assert.equal(huge.status, 415, 'too many pixels');
  assert.equal(huge.data.code, 'too_big');
  // 1 MB each here
  const big = png(800, 600, [chunk('IDAT', Buffer.alloc(600 * 1024, 7))]);
  assert.equal((await upload(S.ben, big)).status, 200);
  const full = await upload(S.ben, big);
  assert.equal(full.status, 413);
  assert.equal(full.data.code, 'quota');
  assert.match(full.data.error, /all 1 MB/);
  const mine = await api('GET', '/api/shots', undefined, S.ben);
  assert.equal(mine.data.shots.length, 1);
  assert.equal(mine.data.max, 1048576);
  S.bens = idOf(mine.data.shots[0].url);
});

test('owners list and delete their links; nobody else can', async () => {
  const list = await api('GET', '/api/shots', undefined, S.ana);
  assert.equal(list.data.shots.length, 5);
  assert.ok(list.data.shots[0].createdAt >= list.data.shots[2].createdAt, 'newest first');
  assert.ok(!list.data.shots.some(s => s.url.endsWith(S.bens)), 'only your own');
  const older = await api('GET', '/api/shots?before=' + list.data.shots[0].createdAt, undefined, S.ana);
  assert.ok(older.data.shots.every(s => s.createdAt < list.data.shots[0].createdAt));
  assert.equal((await api('DELETE', `/api/shots/${S.first}`, undefined, S.ben)).status, 404, 'not ben’s');
  const gone = await api('DELETE', `/api/shots/${S.first}`, undefined, S.ana);
  assert.equal(gone.status, 200);
  assert.equal(gone.data.count, 4);
  assert.equal((await api('GET', `/s/${S.first}`)).status, 404);
  assert.equal((await api('GET', `/s/${S.first}.png`)).status, 404);
  assert.ok(!fs.existsSync(path.join(DATA, 'shots', S.first)), 'the file is gone too');
  assert.equal((await api('DELETE', `/api/shots/${S.first}`, undefined, S.ana)).status, 404);
});

test('anyone can report a picture; the email’s takedown asks first, then deletes it', async () => {
  const id = S.bens;
  const empty = await api('POST', `/s/${id}/report`, 'reason=', null, { 'Content-Type': 'application/x-www-form-urlencoded' });
  assert.equal(empty.status, 400);
  const r = await api('POST', `/s/${id}/report`, 'reason=' + encodeURIComponent('Not mine, posted without asking https://evil.test'), null, { 'Content-Type': 'application/x-www-form-urlencoded' });
  assert.equal(r.status, 200);
  const m = mail.filter(x => x.to === 'owner@studio.test').pop();
  assert.ok(m && m.text.includes(`/s/${id}`) && m.text.includes('Not mine, posted without asking'));
  assert.ok(!m.text.includes('evil.test'), 'links in a report are dropped');
  const link = m.text.match(/(\/s\/\w+\/takedown\?t=[\w-]+)/)[1];
  assert.equal((await api('GET', link.replace(/t=[\w-]+/, 't=wrong'))).status, 403);
  const ask = await api('GET', link);
  assert.equal(ask.status, 200);
  assert.match(ask.data, /<form method="post"/);
  assert.equal((await api('GET', `/s/${id}`)).status, 200, 'asking changes nothing');
  assert.equal((await api('POST', link, '', null, { 'Content-Type': 'application/x-www-form-urlencoded' })).status, 200);
  assert.equal((await api('GET', `/s/${id}`)).status, 404);
});

test('deleting the account deletes its screenshot links', async () => {
  const r = await upload(S.ben, png(20, 20));
  const id = idOf(r.data.url);
  assert.ok(fs.existsSync(path.join(DATA, 'shots', id)));
  assert.equal((await api('DELETE', '/api/me', { password: 'correct horse' }, S.ben)).status, 200);
  assert.equal((await api('GET', `/s/${id}`)).status, 404);
  await new Promise(res => setTimeout(res, 100));  // files go in the background
  assert.ok(!fs.existsSync(path.join(DATA, 'shots', id)));
});
