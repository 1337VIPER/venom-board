// End-to-end tests for players reaching the board: the playtest feedback form (/f/<token>) and the in-game bug
// reporter (POST /api/report with a project's report key): cards arriving live, screenshots, limits, the honeypot,
// keys and revocation, repeats becoming comments, and who may change what.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const WebSocket = require('ws');
const Database = require('better-sqlite3');
const { start } = require('../src/index');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'venom-board-intake-'));
const STRICT = fs.mkdtempSync(path.join(os.tmpdir(), 'venom-board-intake-strict-'));
const APPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'venom-board-app-'));
fs.writeFileSync(path.join(APPDIR, 'index.html'), '<!doctype html><title>Venom Board</title>');
const mail = [];
let srv, base;
const wait = ms => new Promise(r => setTimeout(r, ms));
const MB = 1048576, DAY = 86400000;

async function api(method, p, body, token, headers = {}) {
  const r = await fetch(base + p, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers },
    body: body === undefined ? undefined : Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await r.text();
  let data = null; try { data = JSON.parse(text); } catch (e) { data = text; }
  return { status: r.status, data, headers: r.headers };
}
function socket(first) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace('http', 'ws') + '/ws');
    const inbox = [], waiters = [];
    ws.on('message', d => {
      const m = JSON.parse(d), i = waiters.findIndex(w => w.pred(m));
      if (i >= 0) waiters.splice(i, 1)[0].resolve(m); else inbox.push(m);
    });
    const c = {
      ws, inbox,
      send: m => ws.send(JSON.stringify(m)),
      next: (pred, ms = 3000) => new Promise((res, rej) => {
        const i = inbox.findIndex(pred);
        if (i >= 0) return res(inbox.splice(i, 1)[0]);
        const w = { pred, resolve: res }; waiters.push(w);
        setTimeout(() => { const j = waiters.indexOf(w); if (j >= 0) { waiters.splice(j, 1); rej(new Error('timed out waiting for a message')); } }, ms);
      }),
      none: async (pred, ms = 300) => { await wait(ms); return !inbox.some(pred); },
      close: () => ws.close(),
    };
    ws.on('open', () => { c.send(first); resolve(c); });
    ws.on('error', reject);
  });
}
const live = async token => { const c = await socket({ t: 'auth', token }); await c.next(m => m.t === 'ready'); return c; };
async function joined(token, project) { const c = await live(token); c.send({ t: 'join', project }); c.snapshot = await c.next(m => m.t === 'snapshot'); return c; }
const card = (id, extra = {}) => ({ id, type: 'node', kind: 'task', x: 0, y: 0, w: 240, title: 'Card ' + id, ...extra });
const linkFrom = (to, kind) => mail.filter(m => m.to === to && m.text.includes('#' + kind + '=')).pop().text.match(new RegExp('#' + kind + '=([\\w-]+)'))[1];
const doc = async (project, token) => (await api('GET', `/api/projects/${project}`, undefined, token)).data.doc;
const S = {};

// a real PNG of one colour, w x h
function png(w, h, rgb = [255, 42, 79]) {
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) row.set(rgb, 1 + x * 3);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]), crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(Array.from({ length: h }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
}
// a real PNG of random pixels, w x h: as big as it looks, since noise doesn't compress
function noisy(w, h) {
  const rows = Buffer.concat(Array.from({ length: h }, () => Buffer.concat([Buffer.from([0]), crypto.randomBytes(w * 3)])));
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]), crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

// the feedback form: its page, the signed time it carries, and posting it the way a browser does
const page = async (token, ip = '10.1.0.1') => { const r = await fetch(`${base}/f/${token}`, { headers: { 'X-Real-IP': ip } }); return { status: r.status, html: await r.text(), headers: r.headers }; };
const timeOf = html => (html.match(/name="t" value="([^"]+)"/) || [])[1];
async function readyTime(token) { const t = timeOf((await page(token)).html); await wait(1600); return t; }
async function post(token, fields, { file, ip = '10.1.0.1', type = 'image/png' } = {}) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  if (file) fd.append('screenshot', new Blob([file], { type }), 'shot.png');
  const r = await fetch(`${base}/f/${token}`, { method: 'POST', body: fd, redirect: 'manual', headers: { 'X-Real-IP': ip } });
  return { status: r.status, html: await r.text(), location: r.headers.get('location') };
}
const report = (key, body, headers = {}) => api('POST', '/api/report', body, key, headers);
const nodes = d => d.items.filter(i => i.type === 'node');

async function setup(dataDir, overrides = {}) {
  const s = await start({ PORT: '0', DATA_DIR: dataDir, PUBLIC_URL: 'http://localhost:9', QUIET: 'true', MAIL_PER_10_MIN: '100000', RATE_SCALE: '50', MIN_FREE_DISK_MB: '0',
    APP_DIR: APPDIR, MAIL_FROM: 'Venom Board <support@studio.test>', ...overrides }, { mail: async m => { mail.push(m); return true; } });
  return s;
}
async function people(prefix, list) {
  const out = {};
  for (const [i, u] of list.entries()) {
    const r = await api('POST', '/api/auth/signup', { email: `${prefix}${u}@studio.test`, username: prefix + u, password: 'correct horse', displayName: u[0].toUpperCase() + u.slice(1) }, undefined, { 'X-Real-IP': `10.9.${prefix.length}.${i}` });
    out[u] = r.data.token; out[u + 'Id'] = r.data.user.id;
    if (u !== 'una') await api('POST', '/api/auth/verify', { token: linkFrom(`${prefix}${u}@studio.test`, 'verify') });
  }
  return out;
}
async function teamWith(P, leader, roles) {
  const team = (await api('POST', '/api/teams', { name: 'Night Keep' }, P[leader])).data.team.id;
  for (const [u, role] of roles) {
    await api('POST', `/api/teams/${team}/invites`, { who: P.prefix + u, role }, P[leader]);
    const inv = (await api('GET', '/api/me', undefined, P[u])).data.invites[0].id;
    await api('POST', `/api/invites/${inv}/accept`, undefined, P[u]);
  }
  return team;
}

test.before(async () => {
  srv = await setup(DATA);
  base = `http://127.0.0.1:${srv.port}`;
  Object.assign(S, await people('', ['vee', 'nyx', 'kip', 'out', 'una']), { prefix: '' });
  S.team = await teamWith(S, 'vee', [['nyx', 'editor'], ['kip', 'viewer'], ['una', 'admin']]);
  S.project = (await api('POST', `/api/teams/${S.team}/projects`, { name: 'Slice & <Dice>', doc: { items: [card('c1', { title: 'Boss arena blockout' })] } }, S.vee)).data.project.id;
});
test.after(async () => { await srv.close(); for (const d of [DATA, STRICT, APPDIR]) fs.rmSync(d, { recursive: true, force: true }); });

test('settings: team admins turn the form on, everyone in the team sees it, nobody else', async () => {
  const at = `/api/projects/${S.project}/intake`;
  assert.equal((await api('GET', at, undefined, S.out)).status, 404);
  const none = await api('GET', at, undefined, S.kip);
  assert.equal(none.status, 200);
  assert.equal(none.data.feedback, null); assert.equal(none.data.reportKey, null);
  assert.equal(none.data.reportUrl, 'http://localhost:9/api/report');
  for (const u of ['kip', 'nyx']) {
    assert.equal((await api('POST', at + '/feedback', {}, S[u])).status, 403, u + ' cannot turn the form on');
    assert.equal((await api('POST', at + '/key', {}, S[u])).status, 403, u + ' cannot make a key');
  }
  assert.equal((await api('POST', at + '/feedback', {}, S.out)).status, 404);
  assert.equal((await api('POST', at + '/key', {}, S.out)).status, 404);
  // an admin who hasn't confirmed their email can't open a public form or make a key
  const unv = await api('POST', at + '/feedback', {}, S.una);
  assert.equal(unv.status, 403); assert.equal(unv.data.code, 'verify_first');
  assert.equal((await api('POST', at + '/key', {}, S.una)).data.code, 'verify_first');
  // the leader turns it on, and a teammate with the board open hears about it
  const n = await joined(S.nyx, S.project);
  const on = await api('POST', at + '/feedback', {}, S.vee);
  assert.equal(on.status, 200);
  assert.match(on.data.feedback.url, /^http:\/\/localhost:9\/f\/[\w-]{24}$/);
  assert.deepEqual([on.data.feedback.paused, on.data.feedback.submissions], [false, 0]);
  await n.next(m => m.t === 'shared');
  S.form = on.data.feedback.url.split('/f/')[1];
  assert.equal((await api('GET', at, undefined, S.kip)).data.feedback.url, on.data.feedback.url);
  // turning it on again keeps the same link
  assert.equal((await api('POST', at + '/feedback', {}, S.vee)).data.feedback.url, on.data.feedback.url);
  n.close();
});

test('feedback page: plain, strict and private, with nothing from other sites', async () => {
  const r = await page(S.form);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-security-policy'), "default-src 'none'; style-src 'self'; img-src 'self'; script-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  assert.equal(r.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.match(r.headers.get('cache-control'), /no-store/);
  assert.ok(r.html.includes('Slice &amp; &lt;Dice&gt;'), 'the project name, escaped');
  assert.doesNotMatch(r.html, /https?:\/\//, 'no addresses of other sites at all');
  assert.doesNotMatch(r.html, /<script(?![^>]*\bsrc="\/web\/feedback\.js")/, 'no inline scripts');
  assert.doesNotMatch(r.html, /\sstyle=/, 'no inline styles');
  for (const f of ['kind', 'title', 'details', 'name', 'build', 'screenshot', 'website', 't']) assert.match(r.html, new RegExp(`name="${f}"`), f);
  assert.match(r.html, /enctype="multipart\/form-data"/);
  assert.match(r.html, new RegExp(`action="/f/${S.form}"`));
  for (const f of ['/web/feedback.js', '/web/site.css']) assert.equal((await fetch(base + f)).status, 200, f);
  // an address that isn't a form says so, and nothing more
  const gone = await page('x'.repeat(24));
  assert.equal(gone.status, 404); assert.match(gone.html, /doesn’t work/);
  assert.equal((await fetch(`${base}/f/${S.form}`, { method: 'PUT' })).status, 405);
});

test('feedback: a submission lands live for a teammate as a card, with its screenshot next to it and connected', async () => {
  const n = await joined(S.nyx, S.project);
  const before = (await api('GET', `/api/teams/${S.team}`, undefined, S.vee)).data.usage.storageBytes;
  const t = await readyTime(S.form), shot = png(320, 180);
  const r = await post(S.form, { kind: 'bug', title: 'Fell through the floor', details: 'In the cave, near the <b>bridge</b>.\r\nEvery time.', name: 'Sam', build: '0.4.2', t }, { file: shot });
  assert.equal(r.status, 303);
  assert.equal(r.location, `/f/${S.form}/thanks`);
  const ops = (await n.next(m => m.t === 'ops' && m.ops.some(o => o.obj && o.obj.title === 'Fell through the floor'))).ops;
  const frame = ops.find(o => o.obj.type === 'frame').obj, c = ops.find(o => o.obj.type === 'node').obj;
  const pic = ops.find(o => o.obj.type === 'image').obj, link = ops.find(o => o.k === 'links').obj;
  assert.equal(frame.title, 'Playtest inbox');
  assert.ok(frame.x > 240, 'the inbox is made on the right of the board');
  assert.deepEqual([c.kind, c.disc, c.sev, c.status, c.nopub], ['bug', 'qa', 'major', 'todo', true]);
  assert.ok(c.body.startsWith('In the cave, near the <b>bridge</b>.\nEvery time.'), c.body);
  assert.match(c.body, /From: Sam\nBuild: 0\.4\.2\nSent: \d{4}-\d\d-\d\d \d\d:\d\d UTC/);
  assert.ok(c.x >= frame.x && c.y >= frame.y && c.x + c.w <= frame.x + frame.w && c.y + 150 <= frame.y + frame.h, 'the card sits inside the inbox');
  assert.ok(pic.src.startsWith('http://localhost:9/assets/'));
  assert.equal(pic.x, c.x + 280); assert.equal(pic.y, c.y);
  assert.equal(pic.w, 220); assert.ok(Math.abs(pic.h - 220 * 180 / 320) < 0.2, 'the screenshot keeps its shape');
  assert.ok(pic.x + pic.w <= frame.x + frame.w);
  assert.deepEqual([link.from, link.to], [{ id: c.id }, { id: pic.id }]);
  // the activity feed names the playtester
  const act = await n.next(m => m.t === 'activity' && m.entry.text === 'Fell through the floor');
  assert.equal(act.entry.name, 'Sam (playtester)'); assert.equal(act.entry.kind, 'created');
  assert.equal((await api('GET', `/api/projects/${S.project}/activity`, undefined, S.kip)).data.items[0].name, 'Sam (playtester)');
  // the screenshot is stored here, served like any picture, and counts toward the team's storage
  const img = await fetch(`${base}/assets/${pic.src.split('/assets/')[1]}`);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.ok(Buffer.from(await img.arrayBuffer()).equals(shot));
  assert.ok((await api('GET', `/api/teams/${S.team}`, undefined, S.vee)).data.usage.storageBytes >= before + shot.length);
  // the thank-you page says nothing about the board
  const thanks = await fetch(base + r.location);
  const html = await thanks.text();
  assert.equal(thanks.status, 200);
  assert.match(html, /Your feedback was sent/);
  for (const secret of ['Slice', 'Dice', 'Fell through', 'Boss arena', 'Sam', 'Playtest inbox']) assert.ok(!html.includes(secret), secret);
  // the count shows in the Team panel
  const st = (await api('GET', `/api/projects/${S.project}/intake`, undefined, S.kip)).data.feedback;
  assert.equal(st.submissions, 1); assert.ok(st.lastAt > Date.now() - 10000);
  await n.next(m => m.t === 'shared');

  // more go into the same inbox without covering what's there; ideas are idea cards
  assert.equal((await post(S.form, { kind: 'idea', title: 'A photo mode', details: 'With filters', t })).status, 303);
  assert.equal((await post(S.form, { kind: 'other', title: 'Loved the music', details: 'The cave theme especially', t })).status, 303);
  const d = await doc(S.project, S.vee);
  const inbox = d.items.filter(i => i.type === 'frame' && i.title === 'Playtest inbox');
  assert.equal(inbox.length, 1, 'one inbox');
  const idea = d.items.find(i => i.title === 'A photo mode'), other = d.items.find(i => i.title === 'Loved the music');
  assert.deepEqual([idea.kind, idea.color, idea.nopub, other.kind], ['idea', '#ffd23d', true, 'idea']);
  assert.match(other.body, /Type: something else/); assert.match(idea.body, /From: a playtester/);
  const boxes = [c, pic, idea, other].map(o => ({ x: o.x, y: o.y, w: o.w, h: o.type === 'node' ? 150 : o.h }));
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j];
    assert.ok(!(a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y), `nothing overlaps (${i}, ${j})`);
  }
  for (const o of [idea, other]) assert.ok(o.x >= inbox[0].x && o.y >= inbox[0].y && o.x + 240 <= inbox[0].x + inbox[0].w && o.y + 150 <= inbox[0].y + inbox[0].h, 'inside the inbox, which grows to fit');
  assert.equal((await api('GET', `/api/projects/${S.project}/activity`, undefined, S.kip)).data.items[0].name, 'Playtester');
  n.close();
});

test('feedback: the honeypot, the time check, validation and size limits', async () => {
  const count = async () => nodes(await doc(S.project, S.vee)).length;
  const sent = async () => (await api('GET', `/api/projects/${S.project}/intake`, undefined, S.vee)).data.feedback.submissions;
  const was = await count(), wasSent = await sent(), t = await readyTime(S.form);
  const ok = { kind: 'bug', title: 'Valid', details: 'Fine', t };
  // bots are told it worked, and nothing happens
  for (const fields of [{ ...ok, website: 'http://spam.example' }, { ...ok, t: undefined }, { ...ok, t: 'lsx1abcd.forged' }, { ...ok, t: timeOf((await page(S.form)).html) }]) {
    if (fields.t === undefined) delete fields.t;
    const r = await post(S.form, fields);
    assert.equal(r.status, 303); assert.equal(r.location, `/f/${S.form}/thanks`);
  }
  // a page left open for days asks to be checked and sent again, keeping what was written
  const secret = fs.readFileSync(path.join(DATA, 'secret.key'), 'utf8').trim(), old = (Date.now() - 2 * DAY).toString(36);
  const stale = await post(S.form, { ...ok, details: 'Kept <i>text</i>', t: `${old}.${crypto.createHmac('sha256', secret).update(`feedback:${S.form}:${old}`).digest('base64url').slice(0, 24)}` });
  assert.equal(stale.status, 400); assert.match(stale.html, /open a long time/); assert.match(stale.html, /Kept &lt;i&gt;text&lt;\/i&gt;/);
  // everything is checked on the server, and what was typed comes back to fix
  const bad = [
    [{ ...ok, title: '  ' }, 400, /Give it a short title/],
    [{ ...ok, details: '' }, 400, /Add some details/],
    [{ ...ok, title: 'x'.repeat(121) }, 400, /Keep the title to 120/],
    [{ ...ok, details: 'y'.repeat(4001) }, 400, /up to 4,000 characters/],
    [{ ...ok, build: 'z'.repeat(61) }, 400, /build or version to 60/],
    [{ ...ok, kind: 'constructor' }, 400, /Choose what it is/],
    [{ ...ok, kind: 'feature' }, 400, /Choose what it is/],
  ];
  for (const [fields, status, msg] of bad) {
    const r = await post(S.form, { ...fields, name: '<script>alert(1)</script>' });
    assert.equal(r.status, status, JSON.stringify(fields).slice(0, 60)); assert.match(r.html, msg);
    assert.ok(!r.html.includes('<script>alert'), 'what was typed comes back escaped');
    assert.match(r.html, /value="&lt;script&gt;alert\(1\)&lt;\/script&gt;"/);
  }
  // screenshots: pictures only, up to 5 MB
  assert.match((await post(S.form, ok, { file: GIF, type: 'image/gif' })).html, /PNG, JPEG or WebP/);
  assert.match((await post(S.form, ok, { file: Buffer.from('not a picture at all, just words'), type: 'image/png' })).html, /PNG, JPEG or WebP/);
  const huge = await post(S.form, { ...ok, details: 'Still here' }, { file: Buffer.concat([png(4, 4), Buffer.alloc(5 * MB)]) });
  assert.equal(huge.status, 413); assert.match(huge.html, /bigger than 5 MB/); assert.match(huge.html, /Still here/);
  const whole = await post(S.form, ok, { file: Buffer.concat([png(4, 4), Buffer.alloc(6 * MB)]) });
  assert.equal(whole.status, 413); assert.match(whole.html, /too big to send/);
  // only the form itself can post
  const plain = await fetch(`${base}/f/${S.form}`, { method: 'POST', body: new URLSearchParams(ok), headers: { 'X-Real-IP': '10.1.0.1' } });
  assert.equal(plain.status, 415);
  assert.equal(await count(), was, 'none of these made a card');
  assert.equal(await sent(), wasSent);
});

test('feedback: pausing, a new link and turning it off, by team admins only', async () => {
  const at = `/api/projects/${S.project}/intake/feedback`;
  assert.equal((await api('POST', at, { paused: true }, S.nyx)).status, 403);
  assert.equal((await api('DELETE', at, undefined, S.nyx)).status, 403);
  const t = await readyTime(S.form);
  assert.equal((await api('POST', at, { paused: true }, S.vee)).data.feedback.paused, true);
  const paused = await page(S.form);
  assert.equal(paused.status, 200); assert.match(paused.html, /Feedback is paused/); assert.doesNotMatch(paused.html, /<form/);
  const was = nodes(await doc(S.project, S.vee)).length;
  const held = await post(S.form, { kind: 'idea', title: 'While paused', details: 'Kept for later', t });
  assert.equal(held.status, 409); assert.match(held.html, /paused/); assert.match(held.html, /Kept for later/);
  assert.equal(nodes(await doc(S.project, S.vee)).length, was);
  assert.equal((await api('POST', at, { paused: false }, S.vee)).data.feedback.paused, false);
  assert.equal((await post(S.form, { kind: 'idea', title: 'After the pause', details: 'Sent', t })).status, 303);
  // a new link: the old one stops working at once
  const fresh = (await api('POST', at, { newLink: true }, S.vee)).data.feedback.url.split('/f/')[1];
  assert.notEqual(fresh, S.form);
  assert.equal((await page(S.form)).status, 404);
  assert.equal((await post(S.form, { kind: 'idea', title: 'Old link', details: 'x', t })).status, 404);
  const t2 = await readyTime(fresh);
  assert.equal((await post(fresh, { kind: 'idea', title: 'New link', details: 'x', t: t2 })).status, 303);
  assert.equal((await post(fresh, { kind: 'idea', title: 'Old time', details: 'x', t })).location, `/f/${fresh}/thanks`, 'a time from the old link is a bot sign');
  assert.ok(!nodes(await doc(S.project, S.vee)).some(c => c.title === 'Old time'));
  // turned off: the page is gone, and so is the setting
  assert.equal((await api('DELETE', at, undefined, S.vee)).data.feedback, null);
  assert.equal((await page(fresh)).status, 404);
  S.form = (await api('POST', at, {}, S.vee)).data.feedback.url.split('/f/')[1];
});

test('bug reporter: admins make a key, shown once and stored only as a hash', async () => {
  const r = await api('POST', `/api/projects/${S.project}/intake/key`, {}, S.vee);
  assert.equal(r.status, 200);
  assert.match(r.data.key, /^vbr_[\w-]{43}$/);
  assert.equal(r.data.reportKey.hint, r.data.key.slice(-4));
  assert.deepEqual([r.data.reportKey.reports, r.data.reportKey.lastUsed], [0, null]);
  S.key = r.data.key;
  const seen = await api('GET', `/api/projects/${S.project}/intake`, undefined, S.vee);
  assert.ok(!JSON.stringify(seen.data).includes(S.key.slice(4, 20)), 'never shown again');
  const db = new Database(path.join(DATA, 'venom-board.db'), { readonly: true });
  const rows = db.prepare('SELECT * FROM report_keys').all();
  db.close();
  assert.equal(rows.length, 1);
  assert.ok(!JSON.stringify(rows).includes(S.key.slice(4, 20)), 'the key itself is not kept');
  assert.equal(rows[0].key_hash, crypto.createHash('sha256').update(S.key).digest('hex'));
});

test('bug reporter: a report becomes a bug card live, with its severity, the log at the end and the screenshot', async () => {
  const n = await joined(S.nyx, S.project);
  const log = Array.from({ length: 4000 }, (_, i) => `[${i}] tick ok`).join('\r\n'), shot = png(200, 400, [47, 214, 255]);
  const r = await report(S.key, { title: 'Crash when opening the map', description: 'Pressed M during the boss fight.', severity: 'crash', version: '1.0.0', platform: 'Windows 11', reporter: 'Ana', log, screenshot: shot.toString('base64') });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { ok: true, status: 'created' });
  const ops = (await n.next(m => m.t === 'ops' && m.ops.some(o => o.obj && o.obj.title === 'Crash when opening the map'))).ops;
  const frame = ops.find(o => o.obj.type === 'frame').obj, c = ops.find(o => o.obj.type === 'node').obj, pic = ops.find(o => o.obj.type === 'image').obj, link = ops.find(o => o.k === 'links').obj;
  assert.equal(frame.title, 'Bug reports');
  assert.deepEqual([c.kind, c.sev, c.disc, c.status, c.nopub], ['bug', 'crash', 'qa', 'todo', true]);
  assert.ok(c.body.startsWith('Pressed M during the boss fight.\n\nVersion: 1.0.0\nPlatform: Windows 11\nFrom: Ana\nReported: '), c.body.slice(0, 200));
  assert.ok(c.body.length <= 8000, 'the notes fit');
  assert.ok(c.body.endsWith('[3999] tick ok'), 'the end of the log is kept');
  assert.match(c.body, /\n\nLog \(the last 25 lines\):\n…\n\[3975\] tick ok\n/, 'only its last lines, so the card stays readable');
  assert.ok(!c.body.includes('\r'));
  assert.deepEqual([link.from, link.to], [{ id: c.id }, { id: pic.id }]);
  assert.ok(Math.abs(pic.w / pic.h - 0.5) < 0.01 && pic.h <= 240, 'a tall screenshot is fitted to the slot');
  // its own frame, clear of the playtest inbox
  const d = await doc(S.project, S.vee), inbox = d.items.find(i => i.type === 'frame' && i.title === 'Playtest inbox');
  assert.ok(frame.x >= inbox.x + inbox.w || frame.y >= inbox.y + inbox.h, 'the frames do not overlap');
  const act = await n.next(m => m.t === 'activity' && m.entry.text === 'Crash when opening the map');
  assert.equal(act.entry.name, 'Ana (bug reporter)');
  const st = (await api('GET', `/api/projects/${S.project}/intake`, undefined, S.kip)).data.reportKey;
  assert.equal(st.reports, 1); assert.ok(st.lastUsed > Date.now() - 10000);
  // a data: address works as well as plain base64, and a short log is kept whole
  const r2 = await report(S.key, { title: 'Texture flicker', severity: 'Cosmetic', log: 'one\ntwo', screenshot: 'data:image/png;base64,' + png(8, 8).toString('base64') });
  assert.equal(r2.data.status, 'created');
  const c2 = nodes(await doc(S.project, S.vee)).find(x => x.title === 'Texture flicker');
  assert.equal(c2.sev, 'polish'); assert.ok(c2.body.endsWith('Log:\none\ntwo')); assert.match(c2.body, /From: the in-game bug reporter/);
  n.close();
});

test('bug reporter: the same bug again within a day is a comment on its card, not a new card', async () => {
  const n = await joined(S.nyx, S.project);
  const cards = async () => nodes(await doc(S.project, S.vee)).filter(c => /opening the map/i.test(c.title));
  const first = (await cards())[0];
  const r = await report(S.key, { title: '  crash when OPENING the map!! ', version: '1.0.1', platform: 'Linux', reporter: '@nyx', description: 'Again, @kip watch this' });
  assert.deepEqual(r.data, { ok: true, status: 'repeat', reports: 2 });
  const cm = (await n.next(m => m.t === 'ops' && m.ops[0].k === 'comments')).ops[0].obj;
  assert.equal(cm.card, first.id);
  assert.equal(cm.by, 'vb-bugs-' + S.project);
  assert.equal(cm.text, 'Reported again: version 1.0.1, platform Linux, from ＠nyx.\nAgain, ＠kip watch this');
  assert.equal((await cards()).length, 1, 'no new card');
  await wait(100);
  for (const u of ['nyx', 'kip']) assert.ok(!(await api('GET', '/api/notifications', undefined, S[u])).data.items.some(x => x.kind === 'mention'), 'nobody is mentioned by a report');
  assert.equal((await api('GET', `/api/projects/${S.project}/activity`, undefined, S.vee)).data.items[0].name, '@nyx (bug reporter)');
  // once the card is gone, the next report is a new card
  n.send({ t: 'ops', batch: 1, ops: [{ k: 'items', op: 'del', id: first.id }] });
  await n.next(m => m.t === 'ack');
  assert.equal((await report(S.key, { title: 'Crash when opening the map' })).data.status, 'created');
  // and a day later too
  const db = new Database(path.join(DATA, 'venom-board.db'));
  db.pragma('busy_timeout = 5000');
  db.prepare('UPDATE report_titles SET last_at = ? WHERE project_id = ?').run(Date.now() - DAY - 60000, S.project);
  db.close();
  assert.equal((await report(S.key, { title: 'Crash when opening the map' })).data.status, 'created');
  assert.equal((await cards()).length, 2);
  n.close();
});

test('bug reporter: clear JSON errors for anything wrong', async () => {
  const k = S.key, err = async (r, status, code) => { assert.equal(r.status, status, JSON.stringify(r.data)); assert.equal(r.data.code, code); assert.ok(r.data.error.length > 10, 'says what to do'); };
  await err(await report(undefined, { title: 'x' }), 401, 'no_key');
  await err(await report('nonsense', { title: 'x' }), 401, 'bad_key');
  await err(await report('vbr_' + crypto.randomBytes(32).toString('base64url'), { title: 'x' }), 401, 'bad_key');
  await err(await report(S.vee, { title: 'x' }), 401, 'bad_key');  // a sign-in token is not a report key
  await err(await report(k, 'title=x', { 'Content-Type': 'text/plain' }), 415, 'type');
  await err(await report(k, '{"title": '), 400, 'bad_json');
  await err(await report(k, '[{"title": "x"}]'), 400, 'bad_json');
  await err(await report(k, {}), 400, 'title');
  await err(await report(k, { title: '   ' }), 400, 'title');
  await err(await report(k, { title: { a: 1 } }), 400, 'bad_field');
  await err(await report(k, { title: 'x', version: ['1'] }), 400, 'bad_field');
  await err(await report(k, { title: 'x', severity: 'urgent' }), 400, 'severity');
  await err(await report(k, { title: 'x', severity: 'constructor' }), 400, 'severity');
  await err(await report(k, { title: 'x', log: 'l'.repeat(65537) }), 413, 'log_too_big');
  await err(await report(k, { title: 'x', screenshot: 'not base64 at all!' }), 400, 'screenshot');
  await err(await report(k, { title: 'x', screenshot: 42 }), 400, 'screenshot');
  await err(await report(k, { title: 'x', screenshot: GIF.toString('base64') }), 415, 'screenshot_type');
  await err(await report(k, { title: 'x', screenshot: Buffer.concat([png(4, 4), Buffer.alloc(5 * MB)]).toString('base64') }), 413, 'screenshot_too_big');
  await err(await report(k, Buffer.alloc(8e6 + 10, 32)), 413, 'too_large');
  // long titles and descriptions are cut, not refused; numbers are fine as text
  const long = await report(k, { title: 'T'.repeat(300), description: 'D'.repeat(9000), version: 2.5 });
  assert.equal(long.data.status, 'created');
  const c = nodes(await doc(S.project, S.vee)).find(x => x.title.startsWith('TTT'));
  assert.equal(c.title.length, 120); assert.match(c.body, /^D{4000}\n\nVersion: 2\.5\n/);
  // games in a browser can call it too
  const pre = await fetch(base + '/api/report', { method: 'OPTIONS', headers: { Origin: 'https://game.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, content-type' } });
  assert.equal(pre.status, 204); assert.match(pre.headers.get('access-control-allow-headers'), /Authorization/);
  const cross = await report(k, { title: 'From a web build' }, { Origin: 'https://game.example' });
  assert.equal(cross.status, 200); assert.equal(cross.headers.get('access-control-allow-origin'), '*');
  // a card with long notes is drawn tall, and the next one goes clear of it
  const next = nodes(await doc(S.project, S.vee)).find(x => x.title === 'From a web build');
  assert.ok(next.x !== c.x || next.y >= c.y + 2400, `clear of the tall card (${c.x},${c.y} then ${next.x},${next.y})`);
});

test('bug reporter: revoking stops the key at once, and a new key replaces the old one', async () => {
  const at = `/api/projects/${S.project}/intake/key`;
  assert.equal((await api('DELETE', at, undefined, S.nyx)).status, 403);
  assert.equal((await api('DELETE', at, undefined, S.out)).status, 404);
  const k2 = (await api('POST', at, {}, S.vee)).data.key;
  assert.notEqual(k2, S.key);
  assert.equal((await report(S.key, { title: 'Old key' })).data.code, 'bad_key');
  assert.equal((await report(k2, { title: 'New key' })).status, 200);
  const off = await api('DELETE', at, undefined, S.vee);
  assert.equal(off.data.reportKey, null);
  assert.equal((await report(k2, { title: 'Revoked' })).data.code, 'bad_key');
  assert.ok(!nodes(await doc(S.project, S.vee)).some(c => ['Old key', 'Revoked'].includes(c.title)));
});

test('deleting a project takes its form and key with it', async () => {
  const p = (await api('POST', `/api/teams/${S.team}/projects`, { name: 'Short-lived' }, S.vee)).data.project.id;
  const form = (await api('POST', `/api/projects/${p}/intake/feedback`, {}, S.vee)).data.feedback.url.split('/f/')[1];
  const key = (await api('POST', `/api/projects/${p}/intake/key`, {}, S.vee)).data.key;
  assert.equal((await page(form)).status, 200);
  assert.equal((await report(key, { title: 'Before' })).status, 200);
  assert.equal((await api('DELETE', `/api/projects/${p}`, undefined, S.vee)).status, 200);
  assert.equal((await page(form)).status, 404);
  assert.equal((await report(key, { title: 'After' })).data.code, 'bad_key');
});

test('limits: per network, per project and per key, and screenshots need room in the team storage', async () => {
  const strict = await setup(STRICT, { RATE_SCALE: '1', TEAM_STORAGE_MB: '0.3' });
  const mainBase = base;
  base = `http://127.0.0.1:${strict.port}`;
  try {
    const P = Object.assign(await people('s', ['vee', 'nyx']), { prefix: 's' });
    const team = await teamWith(P, 'vee', [['nyx', 'editor']]);
    const proj = (await api('POST', `/api/teams/${team}/projects`, { name: 'Strict' }, P.vee)).data.project.id;
    const form = (await api('POST', `/api/projects/${proj}/intake/feedback`, {}, P.vee)).data.feedback.url.split('/f/')[1];
    const t = await readyTime(form);
    const send = (i, ip) => post(form, { kind: 'idea', title: 'Idea ' + i, details: 'More', t }, { ip });
    // one network: ten in ten minutes
    for (let i = 0; i < 10; i++) assert.equal((await send(i, '10.2.0.1')).status, 303, 'idea ' + i);
    const ip = await send(10, '10.2.0.1');
    assert.equal(ip.status, 429); assert.match(ip.html, /a lot of feedback in a short time/); assert.match(ip.html, /Idea 10/);
    // one project: sixty an hour, from anywhere
    let i = 11;
    for (let net = 2; i < 61; net++) for (let k = 0; k < 10 && i < 61; k++, i++) assert.equal((await send(i, `10.2.0.${net}`)).status, 303, 'idea ' + i);
    const proj429 = await send(i, '10.2.9.9');
    assert.equal(proj429.status, 429); assert.match(proj429.html, /getting a lot of feedback/);
    assert.equal(nodes(await doc(proj, P.vee)).length, 60);
    assert.equal((await api('GET', `/api/projects/${proj}/intake`, undefined, P.nyx)).data.feedback.submissions, 60);

    // a key: ten reports a minute
    const proj2 = (await api('POST', `/api/teams/${team}/projects`, { name: 'Strict too' }, P.vee)).data.project.id;
    const key = (await api('POST', `/api/projects/${proj2}/intake/key`, {}, P.vee)).data.key;
    for (let j = 0; j < 10; j++) assert.equal((await report(key, { title: 'Report ' + j })).status, 200, 'report ' + j);
    const rate = await report(key, { title: 'One too many' });
    assert.equal(rate.status, 429); assert.equal(rate.data.code, 'rate');

    // the team's storage is nearly full: what the player wrote still arrives, and the card says a screenshot came
    const proj3 = (await api('POST', `/api/teams/${team}/projects`, { name: 'Full' }, P.vee)).data.project.id;
    const form3 = (await api('POST', `/api/projects/${proj3}/intake/feedback`, {}, P.vee)).data.feedback.url.split('/f/')[1];
    const t3 = await readyTime(form3);
    const big = noisy(400, 400);  // about 480 KB that doesn't compress
    assert.equal((await post(form3, { kind: 'bug', title: 'With a big screenshot', details: 'See picture', t: t3 }, { file: big, ip: '10.3.0.1' })).status, 303);
    const d = await doc(proj3, P.vee);
    const c = nodes(d).find(x => x.title === 'With a big screenshot');
    assert.match(c.body, /A screenshot came with this, but there was no room to keep it\.$/);
    assert.ok(!d.items.some(x => x.type === 'image'), 'no picture was added');
    const db = new Database(path.join(STRICT, 'venom-board.db'), { readonly: true });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM assets WHERE project_id = ?').get(proj3).n, 0, 'nothing stored for it');
    db.close();
  } finally {
    base = mainBase;
    await strict.close();
  }
});

test('screenshots: one sender past their daily share still gets the report through, and other players keep theirs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'venom-board-intake-shots-'));
  const strict = await setup(dir, { RATE_SCALE: '1', INTAKE_SHOTS_PER_SENDER: '2' });
  const mainBase = base;
  base = `http://127.0.0.1:${strict.port}`;
  try {
    const P = Object.assign(await people('x', ['cam']), { prefix: 'x' });
    const team = await teamWith(P, 'cam', []);
    const proj = (await api('POST', `/api/teams/${team}/projects`, { name: 'Shots' }, P.cam)).data.project.id;
    const key = (await api('POST', `/api/projects/${proj}/intake/key`, {}, P.cam)).data.key;
    const shot = 'data:image/png;base64,' + png(8, 8).toString('base64');
    for (let i = 0; i < 2; i++) assert.equal((await report(key, { title: 'Shot ' + i, screenshot: shot }, { 'X-Real-IP': '10.7.0.1' })).status, 200);
    assert.equal((await report(key, { title: 'Shot 2', screenshot: shot }, { 'X-Real-IP': '10.7.0.1' })).status, 200, 'the report itself still arrives');
    assert.equal((await report(key, { title: 'Someone else', screenshot: shot }, { 'X-Real-IP': '10.7.0.2' })).status, 200);
    const d = await doc(proj, P.cam);
    assert.match(nodes(d).find(x => x.title === 'Shot 2').body, /no room to keep it/);
    assert.ok(!/no room/.test(nodes(d).find(x => x.title === 'Someone else').body), "another player's screenshot is kept");
    assert.equal(d.items.filter(x => x.type === 'image').length, 3);
  } finally {
    base = mainBase;
    await strict.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
