// Tests for the fixes from the security review: things a person with an account (or nothing at all) could
// previously do to take the server down, slip past its checks, or act in someone else's name.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const { start } = require('../src/index');
const { cleanOp } = require('../src/sanitize');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'venom-board-security-'));
const APPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'venom-board-app-'));
fs.writeFileSync(path.join(APPDIR, 'index.html'), '<!doctype html><title>Venom Board</title>');
const mail = [];
let srv, base;
const wait = ms => new Promise(r => setTimeout(r, ms));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

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
      send: m => ws.send(typeof m === 'string' ? m : JSON.stringify(m)),
      next: (pred, ms = 3000) => new Promise((res, rej) => {
        const i = inbox.findIndex(pred);
        if (i >= 0) return res(inbox.splice(i, 1)[0]);
        const w = { pred, resolve: res }; waiters.push(w);
        setTimeout(() => { const j = waiters.indexOf(w); if (j >= 0) { waiters.splice(j, 1); rej(new Error('timed out waiting for a message')); } }, ms);
      }),
      none: async (pred, ms = 300) => { await wait(ms); return !inbox.some(pred); },
      close: () => ws.close(),
    };
    ws.on('open', () => { if (first) c.send(first); resolve(c); });
    ws.on('error', reject);
  });
}
const live = async token => { const c = await socket({ t: 'auth', token }); await c.next(m => m.t === 'ready'); return c; };
async function joined(token, project) { const c = await live(token); c.send({ t: 'join', project }); c.snapshot = await c.next(m => m.t === 'snapshot'); return c; }
const card = (id, extra = {}) => ({ id, type: 'node', kind: 'task', x: 0, y: 0, w: 240, title: 'Card ' + id, ...extra });
const linkFrom = (to, kind) => mail.filter(m => m.to === to && m.text.includes('#' + kind + '=')).pop().text.match(new RegExp('#' + kind + '=([\\w-]+)'))[1];
const S = {};

test.before(async () => {
  srv = await start({ PORT: '0', DATA_DIR: DATA, PUBLIC_URL: 'http://localhost:9', QUIET: 'true', MAIL_PER_10_MIN: '100000', RATE_SCALE: '50', MIN_FREE_DISK_MB: '0',
    APP_DIR: APPDIR, MCP_FETCH_PRIVATE: 'on' }, { mail: async m => { mail.push(m); return true; } });
  base = `http://127.0.0.1:${srv.port}`;
  for (const u of ['vee', 'nyx']) {
    const r = await api('POST', '/api/auth/signup', { email: u + '@studio.test', username: u, password: 'correct horse', displayName: u[0].toUpperCase() + u.slice(1) });
    S[u] = r.data.token; S[u + 'Id'] = r.data.user.id;
    await api('POST', '/api/auth/verify', { token: linkFrom(u + '@studio.test', 'verify') });
  }
  S.team = (await api('POST', '/api/teams', { name: 'Night Keep' }, S.vee)).data.team.id;
  await api('POST', `/api/teams/${S.team}/invites`, { who: 'nyx', role: 'editor' }, S.vee);
  const inv = (await api('GET', '/api/me', undefined, S.nyx)).data.invites[0].id;
  await api('POST', `/api/invites/${inv}/accept`, undefined, S.nyx);
  S.project = (await api('POST', `/api/teams/${S.team}/projects`, { name: 'Slice', doc: { items: [card('c1'), card('c2')] } }, S.vee)).data.project.id;
});
test.after(async () => { await srv.close(); for (const d of [DATA, APPDIR]) fs.rmSync(d, { recursive: true, force: true }); });

test('mcp: a picture address that redirects somewhere invalid is refused, and the server keeps running', async () => {
  const bad = http.createServer((req, res) => { res.writeHead(302, { Location: 'http://[' }); res.end(); });
  await new Promise(r => bad.listen(0, '127.0.0.1', r));
  try {
    const token = (await api('POST', '/api/me/tokens', { name: 'Desk', password: 'correct horse' }, S.vee)).data.token;
    const r = await fetch(base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'add_image', arguments: { project_id: S.project, images: [{ url: `http://127.0.0.1:${bad.address().port}/pic.png` }] } } }) });
    const out = (await r.json()).result;
    assert.equal(out.isError, true);
    assert.match(out.content[0].text, /redirects somewhere invalid/);
    await wait(100);
    assert.equal((await api('GET', '/api/session')).status, 200, 'the server is still up');
  } finally { bad.close(); }
});

test('live: names inherited from Object are never collections', async () => {
  for (const k of ['constructor', 'toString', '__proto__', 'valueOf', 'hasOwnProperty']) {
    assert.equal(cleanOp({ k, op: 'put', obj: { id: 'x1', title: '<img onerror=alert(1)>' } }), null, k);
    assert.equal(cleanOp({ k, op: 'order', ids: [] }), null, k);
  }
  const [v, n] = await Promise.all([joined(S.vee, S.project), joined(S.nyx, S.project)]);
  try {
    // a preview under a made-up collection reaches nobody
    n.send({ t: 'preview', ops: [{ k: 'constructor', op: 'put', obj: { id: 'x1', title: '<img onerror=alert(1)>' } }] });
    assert.ok(await v.none(m => m.t === 'preview', 300), 'nothing was relayed');
    // a batch with one: the real change goes through, is counted and reaches the team
    n.send({ t: 'ops', batch: 1, ops: [{ k: 'items', op: 'del', id: 'c2' }, { k: 'constructor', op: 'order', ids: [] }] });
    const ack = await n.next(m => m.t === 'ack' && m.batch === 1);
    const seen = await v.next(m => m.t === 'ops' && m.by);
    assert.equal(seen.ops.length, 1); assert.equal(seen.ops[0].id, 'c2');
    assert.equal(seen.v, ack.v);
  } finally { v.close(); n.close(); }
});

test('live: a full time log takes no more entries, instead of pushing a teammate\'s off it', async () => {
  const [v, n] = await Promise.all([joined(S.vee, S.project), joined(S.nyx, S.project)]);
  try {
    const at = Date.now() - 3600e3;
    v.send({ t: 'ops', batch: 1, ops: [{ k: 'items', op: 'put', obj: card('c1', { log: [{ id: 'mine', by: S.veeId, at, mins: 30 }], spent: 30 }) }] });
    await v.next(m => m.t === 'ack' && m.batch === 1);
    const flood = Array.from({ length: 600 }, (_, i) => ({ id: 'f' + i, by: S.nyxId, at, mins: 1 }));
    n.send({ t: 'ops', batch: 1, ops: [{ k: 'items', op: 'put', obj: card('c1', { log: [{ id: 'mine', by: S.veeId, at, mins: 30 }, ...flood], spent: 630 }) }] });
    await n.next(m => m.t === 'ack' && m.batch === 1);
    const got = (await v.next(m => m.t === 'ops' && m.by)).ops[0].obj;
    assert.ok(got.log.some(e => e.id === 'mine' && e.by === S.veeId), 'Vee\'s entry is still there');
    assert.ok(got.log.length <= 500);
  } finally { v.close(); n.close(); }
});

test('projects: time on a new project\'s cards is its creator\'s own', async () => {
  const at = Date.now() - 3600e3;
  const p = (await api('POST', `/api/teams/${S.team}/projects`, { name: 'Imported', doc: { items: [card('t1', { log: [{ id: 'e1', by: S.veeId, at, mins: 1440 }], plan: [{ id: 'p1', by: S.veeId, at: at + 864e5, mins: 60 }] })] } }, S.nyx)).data.project.id;
  const c = (await api('GET', `/api/projects/${p}`, undefined, S.vee)).data.doc.items.find(i => i.id === 't1');
  assert.deepEqual([c.log[0].by, c.plan[0].by], [S.nyxId, S.nyxId], 'nobody can log or plan time in a teammate\'s name');
});

test('sockets: anything big before signing in closes the connection', async () => {
  const c = await socket(null);
  const closed = new Promise(r => c.ws.on('close', r));
  c.send(JSON.stringify({ t: 'auth', token: 'x'.repeat(40000) }));
  await Promise.race([closed, wait(2000).then(() => { throw new Error('the connection stayed open'); })]);
});

test('pages: a page under /web/ is never sent as a bare file', async () => {
  for (const p of ['/web/account.html', '/web/account.html/', '/web/account.html%2f', '/web/account.htm']) {
    const r = await fetch(base + p);
    assert.equal(r.status, 404, p);
  }
});

test('uploads: pictures lose their hidden data before anyone else can see them', async () => {
  // a JPEG with an EXIF block (where location and camera details live) after its start
  const exif = Buffer.concat([Buffer.from([0xff, 0xe1, 0x00, 0x17]), Buffer.from('Exif\0\0GPS-secret-here', 'latin1')]);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), exif, Buffer.from([0xff, 0xdb, 0x00, 0x43, 0x00]), Buffer.alloc(64, 1),
    Buffer.from([0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00]), Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]), Buffer.from([0x12, 0x34]), Buffer.from([0xff, 0xd9])]);
  const up = await api('POST', `/api/projects/${S.project}/assets`, jpeg, S.vee, { 'Content-Type': 'image/jpeg' });
  assert.equal(up.status, 200, JSON.stringify(up.data));
  const stored = Buffer.from(await (await fetch(up.data.url.replace('http://localhost:9', base))).arrayBuffer());
  assert.ok(!stored.includes(Buffer.from('GPS-secret-here', 'latin1')), 'the EXIF block is gone');
  // and a PNG that's broken inside is refused, not stored as it came
  const broken = Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(64)]);
  assert.equal((await api('POST', `/api/projects/${S.project}/assets`, broken, S.vee, { 'Content-Type': 'image/png' })).status, 415);
});
