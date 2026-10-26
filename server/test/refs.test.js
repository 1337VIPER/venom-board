// Reference board fields on pictures: crop (the part of the picture that shows, as fractions) and rot (quarter turns),
// and on pictures and videos their tags, a note and the web address they came from (source).
// They pass through the sanitizer whole when valid and are dropped when not, on new projects and on live edits.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { start } = require('../src/index');
const { cleanDoc, cleanOp } = require('../src/sanitize');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'venom-board-refs-'));
const APPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'venom-board-app-'));
fs.writeFileSync(path.join(APPDIR, 'index.html'), '<!doctype html><title>Venom Board</title>');
const PUBLIC = 'http://localhost:9';
const mail = [];
let srv, base;
const wait = ms => new Promise(r => setTimeout(r, ms));

async function api(method, p, body, token, headers = {}) {
  const r = await fetch(base + p, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers },
    body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
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
      close: () => ws.close(),
    };
    ws.on('open', () => { c.send(first); resolve(c); });
    ws.on('error', reject);
  });
}
const live = async token => { const c = await socket({ t: 'auth', token }); await c.next(m => m.t === 'ready'); return c; };
async function joined(token, project) { const c = await live(token); c.send({ t: 'join', project }); c.snapshot = await c.next(m => m.t === 'snapshot'); return c; }
const linkFrom = (to, kind) => mail.filter(m => m.to === to && m.text.includes('#' + kind + '=')).pop().text.match(new RegExp('#' + kind + '=([\\w-]+)'))[1];
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const S = {};
const pic = (id, extra = {}) => ({ id, type: 'image', x: 10, y: 20, w: 300, h: 200, name: 'Ref ' + id, flip: false, gray: false, src: S.src, ...extra });

test.before(async () => {
  srv = await start({ PORT: '0', DATA_DIR: DATA, PUBLIC_URL: PUBLIC, QUIET: 'true', MAIL_PER_10_MIN: '100000', RATE_SCALE: '50', MIN_FREE_DISK_MB: '0', APP_DIR: APPDIR,
    MAIL_FROM: 'Venom Board <support@studio.test>' }, { mail: async m => { mail.push(m); return true; } });
  base = `http://127.0.0.1:${srv.port}`;
  for (const u of ['vee', 'nyx']) {
    const r = await api('POST', '/api/auth/signup', { email: u + '@studio.test', username: u, password: 'correct horse', displayName: u[0].toUpperCase() + u.slice(1) });
    S[u] = r.data.token;
    await api('POST', '/api/auth/verify', { token: linkFrom(u + '@studio.test', 'verify') });
  }
  S.team = (await api('POST', '/api/teams', { name: 'Ref Keep' }, S.vee)).data.team.id;
  await api('POST', `/api/teams/${S.team}/invites`, { who: 'nyx', role: 'editor' }, S.vee);
  const inv = (await api('GET', '/api/me', undefined, S.nyx)).data.invites[0].id;
  await api('POST', `/api/invites/${inv}/accept`, undefined, S.nyx);
  S.project = (await api('POST', `/api/teams/${S.team}/projects`, { name: 'Refs', doc: { items: [] } }, S.vee)).data.project.id;
  const up = await api('POST', `/api/projects/${S.project}/assets`, PNG, S.vee, { 'Content-Type': 'image/png' });
  assert.equal(up.status, 200, JSON.stringify(up.data));
  S.src = `${PUBLIC}/assets/${up.data.id}`;
});
test.after(async () => { await srv.close(); for (const d of [DATA, APPDIR]) fs.rmSync(d, { recursive: true, force: true }); });

test('sanitizer: a valid crop and turn are kept, everything else about them is dropped', () => {
  const opts = { assetBase: PUBLIC + '/assets/' };
  const one = extra => cleanDoc({ items: [pic('p1', extra)] }, opts).items[0];
  assert.deepEqual(one({ crop: { x: 0.1, y: 0.25, w: 0.5, h: 0.5 }, rot: 90 }).crop, { x: 0.1, y: 0.25, w: 0.5, h: 0.5 });
  assert.equal(one({ rot: 270 }).rot, 270);
  assert.equal(one({ rot: 180 }).rot, 180);
  // rounding, and a frame a hair past the edge is pulled back inside
  assert.deepEqual(one({ crop: { x: 0.123456789, y: 0, w: 0.876549, h: 0.3333333 } }).crop, { x: 0.12346, y: 0, w: 0.87654, h: 0.33333 });
  assert.deepEqual(one({ crop: { x: 0.5, y: 0.5, w: 0.50005, h: 0.5 } }).crop, { x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
  // not a crop: the whole picture, outside it, too thin, not numbers, not an object
  for (const crop of [{ x: 0, y: 0, w: 1, h: 1 }, { x: -0.1, y: 0, w: 0.5, h: 0.5 }, { x: 0.6, y: 0, w: 0.6, h: 0.5 }, { x: 0, y: 0, w: 0.005, h: 0.5 },
    { x: '0.1', y: 0, w: 0.5, h: 0.5 }, { x: 0.1, y: 0, w: 0.5 }, { x: 0, y: 0, w: Infinity, h: 0.5 }, [0, 0, 0.5, 0.5], 'crop', 7, null, true])
    assert.equal(one({ crop }).crop, undefined, JSON.stringify(crop));
  for (const rot of [0, 45, -90, 360, '90', 90.5, null, { deg: 90 }]) assert.equal(one({ rot }).rot, undefined, JSON.stringify(rot));
  // extra keys inside a crop never get through, and other kinds of object don't take the fields
  const c = one({ crop: { x: 0.2, y: 0.2, w: 0.3, h: 0.3, onload: 'alert(1)', __proto__: { x: 1 } } }).crop;
  assert.deepEqual(Object.keys(c), ['x', 'y', 'w', 'h']);
  const card = cleanDoc({ items: [{ id: 'c1', type: 'node', title: 'Card', crop: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, rot: 90 }] }, opts).items[0];
  assert.equal(card.crop, undefined); assert.equal(card.rot, undefined);
  const vid = cleanDoc({ items: [{ id: 'v1', type: 'video', embed: { p: 'yt', id: 'dQw4w9WgXcQ' }, crop: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, rot: 90 }] }, opts).items[0];
  assert.equal(vid.crop, undefined); assert.equal(vid.rot, undefined);
  // a live put goes through the same cleaning
  const op = cleanOp({ k: 'items', op: 'put', obj: pic('p2', { crop: { x: 0, y: 0.5, w: 1, h: 0.5 }, rot: 90 }) }, opts);
  assert.deepEqual([op.obj.crop, op.obj.rot], [{ x: 0, y: 0.5, w: 1, h: 0.5 }, 90]);
});

test('new projects keep cropped and turned pictures', async () => {
  const doc = { items: [pic('n1', { crop: { x: 0.25, y: 0, w: 0.5, h: 1 }, rot: 90, flip: true }), pic('n2', { crop: { x: 2, y: 0, w: 0.5, h: 1 }, rot: 33 })] };
  const p = (await api('POST', `/api/teams/${S.team}/projects`, { name: 'Imported refs', doc }, S.vee)).data.project.id;
  const v = await joined(S.vee, p);
  const [a, b] = v.snapshot.doc.items;
  assert.deepEqual([a.crop, a.rot, a.flip, a.src], [{ x: 0.25, y: 0, w: 0.5, h: 1 }, 90, true, S.src]);
  assert.equal(b.crop, undefined); assert.equal(b.rot, undefined); assert.equal(b.src, S.src, 'the picture itself stays');
  v.close();
});

test('live edits: a crop and turn reach teammates and the saved board; bad values are dropped', async () => {
  const [v, n] = await Promise.all([joined(S.vee, S.project), joined(S.nyx, S.project)]);
  n.send({ t: 'ops', batch: 1, ops: [{ k: 'items', op: 'put', obj: pic('l1') }] });
  assert.equal((await n.next(m => m.t === 'ack')).batch, 1);
  await v.next(m => m.t === 'ops' && m.ops.some(o => o.obj && o.obj.id === 'l1'));
  // crop it and turn it, as the app does in one edit
  n.send({ t: 'ops', batch: 2, ops: [{ k: 'items', op: 'put', obj: pic('l1', { x: 60, y: -30, w: 100, h: 150, crop: { x: 0.25, y: 0.1, w: 0.5, h: 0.5 }, rot: 270, flip: true }) }] });
  const got = (await v.next(m => m.t === 'ops' && m.ops.some(o => o.obj && o.obj.id === 'l1'))).ops.find(o => o.obj.id === 'l1').obj;
  assert.deepEqual([got.crop, got.rot, got.flip, got.w, got.h], [{ x: 0.25, y: 0.1, w: 0.5, h: 0.5 }, 270, true, 100, 150]);
  // a hostile edit: the bad crop and turn are dropped, the rest of the picture stays
  n.send({ t: 'ops', batch: 3, ops: [{ k: 'items', op: 'put', obj: pic('l1', { crop: { x: 0.9, y: 0.9, w: 0.5, h: '<img src=x>' }, rot: '90' }) }] });
  const bad = (await v.next(m => m.t === 'ops' && m.ops.some(o => o.obj && o.obj.id === 'l1'))).ops.find(o => o.obj.id === 'l1').obj;
  assert.equal(bad.crop, undefined); assert.equal(bad.rot, undefined); assert.equal(bad.src, S.src);
  // reset the crop again, then check what a newcomer loads
  n.send({ t: 'ops', batch: 4, ops: [{ k: 'items', op: 'put', obj: pic('l1', { crop: { x: 0, y: 0.5, w: 1, h: 0.5 }, rot: 180 }) }] });
  await v.next(m => m.t === 'ops' && m.ops.some(o => o.obj && o.obj.id === 'l1' && o.obj.rot === 180));
  for (const c of [v, n]) c.close();
  await wait(300);
  const again = await joined(S.vee, S.project);
  const saved = again.snapshot.doc.items.find(i => i.id === 'l1');
  assert.deepEqual([saved.crop, saved.rot], [{ x: 0, y: 0.5, w: 1, h: 0.5 }, 180]);
  again.close();
});

test('sanitizer: tags, a note and where a reference came from, on pictures and videos', () => {
  const opts = { assetBase: PUBLIC + '/assets/' };
  const one = (extra, type = 'image') => cleanDoc({ items: [type === 'image' ? pic('t1', extra) : { id: 'v1', type: 'video', x: 0, y: 0, w: 480, h: 270, embed: { p: 'yt', id: 'dQw4w9WgXcQ' }, ...extra }] }, opts).items[0];
  for (const type of ['image', 'video']) {
    const r = one({ tags: ['Lighting', 'boss-fight', 'no spaces!', 7, 'lighting'], note: '  Rim light on the hero  ', source: ' https://www.artstation.com/artwork/abc?x=1#top ' }, type);
    assert.deepEqual([r.tags, r.note, r.source], [['lighting', 'boss-fight'], 'Rim light on the hero', 'https://www.artstation.com/artwork/abc?x=1#top'], type);
    // empty ones are kept, so an edit that clears one differs from an app that never sent it
    const e = one({ tags: [], note: '', source: '   ' }, type);
    assert.deepEqual([e.tags, e.note, e.source], [[], '', ''], type);
    const none = one({}, type);
    for (const k of ['tags', 'note', 'source']) assert.equal(k in none, false, `${type} without ${k}`);
  }
  assert.equal(one({ note: 'x'.repeat(900) }).note.length, 500);
  assert.equal(one({ tags: Array.from({ length: 12 }, (_, k) => 't' + k) }).tags.length, 8);
  // only plain http and https addresses up to 600 characters, with no spaces, control characters or logins
  for (const source of ['javascript:alert(1)', 'data:text/html,<b>hi</b>', 'ftp://files.example.com/ref.png', 'https://user:pass@example.com/ref', 'https://user@example.com/',
    'https://example.com/a b', 'https://example.com/\u0007bell', 'https://example.com/' + 'a'.repeat(600), 'not a link', '//example.com/ref', 'http://', 42, null, ['https://example.com/'], { href: 'https://example.com/' }])
    assert.equal('source' in one({ source }), false, JSON.stringify(source));
  assert.equal(one({ source: 'http://example.com/' + 'a'.repeat(581) }).source.length, 600, 'exactly 600 characters is fine');
  for (const [k, v] of [['tags', 'lighting'], ['tags', null], ['note', 42], ['note', null]]) assert.equal(k in one({ [k]: v }), false, `${k}: ${JSON.stringify(v)}`);
  // other kinds of object don't take a note or a source
  const card = cleanDoc({ items: [{ id: 'c1', type: 'node', title: 'Card', note: 'hi', source: 'https://example.com/' }] }, opts).items[0];
  assert.equal(card.note, undefined); assert.equal(card.source, undefined);
  // a live put goes through the same cleaning
  const op = cleanOp({ k: 'items', op: 'put', obj: pic('t2', { tags: ['UI'], note: 'Menu', source: 'javascript:alert(1)' }) }, opts);
  assert.deepEqual([op.obj.tags, op.obj.note, op.obj.source], [['ui'], 'Menu', undefined]);
});

test('live edits: tags, notes and sources reach teammates; an older app leaves them as they were, and empty ones clear them', async () => {
  const [v, n] = await Promise.all([joined(S.vee, S.project), joined(S.nyx, S.project)]);
  const next = (c, id) => c.next(m => m.t === 'ops' && m.by && m.ops.some(o => o.obj && o.obj.id === id)).then(m => m.ops.find(o => o.obj && o.obj.id === id).obj);
  const ref = { tags: ['lighting', 'hero'], note: 'Rim light', source: 'https://www.artstation.com/artwork/abc' };
  n.send({ t: 'ops', batch: 1, ops: [{ k: 'items', op: 'put', obj: pic('m1', ref) }] });
  let got = await next(v, 'm1');
  assert.deepEqual([got.tags, got.note, got.source], [ref.tags, ref.note, ref.source]);
  // an app from before these fields moves and resizes the picture: what it didn't send stays
  v.send({ t: 'ops', batch: 1, ops: [{ k: 'items', op: 'put', obj: pic('m1', { x: 400, w: 150, h: 100 }) }] });
  got = await next(n, 'm1');
  assert.deepEqual([got.x, got.w, got.tags, got.note, got.source], [400, 150, ref.tags, ref.note, ref.source]);
  // empty ones clear them
  n.send({ t: 'ops', batch: 2, ops: [{ k: 'items', op: 'put', obj: pic('m1', { x: 400, w: 150, h: 100, tags: [], note: '', source: '' }) }] });
  got = await next(v, 'm1');
  assert.deepEqual([got.tags, got.note, got.source], [[], '', '']);
  // videos the same way; a bad source never reaches anyone
  const vid = extra => ({ id: 'm2', type: 'video', x: 0, y: 400, w: 480, h: 270, name: 'Walk cycle', embed: { p: 'yt', id: 'dQw4w9WgXcQ' }, ...extra });
  n.send({ t: 'ops', batch: 3, ops: [{ k: 'items', op: 'put', obj: vid({ tags: ['anim'], note: 'Weight shift', source: 'https://vimeo.com/123456' }) }, { k: 'items', op: 'put', obj: pic('m3', { source: 'javascript:alert(1)' }) }] });
  const both = (await v.next(m => m.t === 'ops' && m.by && m.ops.some(o => o.obj && o.obj.id === 'm2'))).ops;
  assert.equal(both.find(o => o.obj.id === 'm2').obj.source, 'https://vimeo.com/123456');
  assert.equal('source' in both.find(o => o.obj.id === 'm3').obj, false, 'the bad source is dropped');
  v.send({ t: 'ops', batch: 2, ops: [{ k: 'items', op: 'put', obj: vid({ autoplay: true }) }] });
  got = await next(n, 'm2');
  assert.deepEqual([got.autoplay, got.tags, got.note, got.source], [true, ['anim'], 'Weight shift', 'https://vimeo.com/123456']);
  for (const c of [v, n]) c.close();
  await wait(300);
  const again = await joined(S.vee, S.project), saved = id => again.snapshot.doc.items.find(i => i.id === id);
  assert.deepEqual([saved('m1').tags, saved('m1').note, saved('m1').source], [[], '', ''], 'saved cleared');
  assert.deepEqual([saved('m2').tags, saved('m2').note, saved('m2').source], [['anim'], 'Weight shift', 'https://vimeo.com/123456'], 'saved kept');
  again.close();
});
