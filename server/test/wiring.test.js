// Collapsed phases on shared boards: a frame's `collapsed: true` survives new projects, live edits, reloads and
// versions, and anything else in that field is dropped. Mood board collections too: a frame's `mood` (true or false).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { start } = require('../src/index');
const { cleanDoc, cleanOp } = require('../src/sanitize');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'venom-board-wiring-'));
const APPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'venom-board-app-'));
fs.writeFileSync(path.join(APPDIR, 'index.html'), '<!doctype html><title>Venom Board</title>');
const mail = [];
let srv, base;

async function api(method, p, body, token) {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let data = null; try { data = JSON.parse(text); } catch (e) { data = text; }
  return { status: r.status, data };
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
const frame = (id, extra = {}) => ({ id, type: 'frame', x: 0, y: 0, w: 900, h: 600, title: 'Phase ' + id, color: '#a66bff', ...extra });
const card = (id, extra = {}) => ({ id, type: 'node', kind: 'task', x: 40, y: 60, w: 240, title: 'Card ' + id, ...extra });
const S = {};

test.before(async () => {
  srv = await start({ PORT: '0', DATA_DIR: DATA, PUBLIC_URL: 'http://localhost:9', QUIET: 'true', MAIL_PER_10_MIN: '100000', RATE_SCALE: '50', MIN_FREE_DISK_MB: '0', APP_DIR: APPDIR,
    MAIL_FROM: 'Venom Board <support@studio.test>' }, { mail: async m => { mail.push(m); return true; } });
  base = `http://127.0.0.1:${srv.port}`;
  for (const u of ['vee', 'nyx', 'kip']) {
    const r = await api('POST', '/api/auth/signup', { email: u + '@studio.test', username: u, password: 'correct horse', displayName: u[0].toUpperCase() + u.slice(1) });
    S[u] = r.data.token;
    await api('POST', '/api/auth/verify', { token: linkFrom(u + '@studio.test', 'verify') });
  }
  S.team = (await api('POST', '/api/teams', { name: 'Night Keep' }, S.vee)).data.team.id;
  for (const [u, role] of [['nyx', 'editor'], ['kip', 'viewer']]) {
    await api('POST', `/api/teams/${S.team}/invites`, { who: u, role }, S.vee);
    const inv = (await api('GET', '/api/me', undefined, S[u])).data.invites[0].id;
    await api('POST', `/api/invites/${inv}/accept`, undefined, S[u]);
  }
});
test.after(async () => { await srv.close(); for (const d of [DATA, APPDIR]) fs.rmSync(d, { recursive: true, force: true }); });

test('sanitize: only a frame keeps collapsed, and only when it is exactly true', () => {
  const d = cleanDoc({ items: [frame('a', { collapsed: true }), frame('b', { collapsed: 'yes' }), frame('c', { collapsed: 1 }), frame('d', { collapsed: { x: 1 } }), frame('e'), card('n', { collapsed: true }),
    { id: 't', type: 'text', x: 0, y: 0, text: 'hi', collapsed: true }] });
  const by = id => d.items.find(i => i.id === id);
  assert.equal(by('a').collapsed, true);
  for (const id of ['b', 'c', 'd', 'e', 'n', 't']) assert.equal('collapsed' in by(id), false, id + ' has no collapsed field');
  assert.equal(by('a').w, 900, 'a collapsed frame keeps its full size, so expanding restores it');
  assert.equal(cleanOp({ k: 'items', op: 'put', obj: frame('f', { collapsed: true }) }).obj.collapsed, true);
  assert.equal('collapsed' in cleanOp({ k: 'items', op: 'put', obj: frame('g', { collapsed: 'true' }) }).obj, false);
});

test('new projects keep collapsed phases', async () => {
  const r = await api('POST', `/api/teams/${S.team}/projects`, { name: 'Folded', doc: { items: [frame('p1', { collapsed: true }), frame('p2', { collapsed: 'nope' }), card('c1')] } }, S.vee);
  assert.equal(r.status, 200);
  S.project = r.data.project.id;
  const doc = (await api('GET', `/api/projects/${S.project}`, undefined, S.kip)).data.doc;
  assert.equal(doc.items.find(i => i.id === 'p1').collapsed, true);
  assert.equal('collapsed' in doc.items.find(i => i.id === 'p2'), false);
});

test('live: collapsing and expanding reach everyone, survive a reload and versions; hostile values are dropped', async () => {
  const v = await joined(S.vee, S.project), n = await joined(S.nyx, S.project);
  assert.equal(n.snapshot.doc.items.find(i => i.id === 'p1').collapsed, true, 'joining sees the phase collapsed');
  // Nyx expands p1 and collapses p2 (with junk beside it)
  n.send({ t: 'ops', batch: 1, ops: [{ k: 'items', op: 'put', obj: frame('p1') }, { k: 'items', op: 'put', obj: frame('p2', { collapsed: true, evil: '<img src=x onerror=alert(1)>' }) }] });
  await n.next(m => m.t === 'ack');
  const seen = await v.next(m => m.t === 'ops');
  const p1 = seen.ops.find(o => o.obj && o.obj.id === 'p1').obj, p2 = seen.ops.find(o => o.obj && o.obj.id === 'p2').obj;
  assert.equal('collapsed' in p1, false, 'expanding reaches Vee');
  assert.equal(p2.collapsed, true, 'collapsing reaches Vee');
  assert.equal('evil' in p2, false, 'unknown fields are dropped');
  // a viewer can't collapse anything
  const k = await joined(S.kip, S.project);
  k.send({ t: 'ops', batch: 1, ops: [{ k: 'items', op: 'put', obj: frame('p1', { collapsed: true }) }] });
  await k.next(m => m.t === 'error' || m.t === 'ack');
  const doc = (await api('GET', `/api/projects/${S.project}`, undefined, S.kip)).data.doc;
  assert.equal('collapsed' in doc.items.find(i => i.id === 'p1'), false, 'a viewer\'s change is refused');
  assert.equal(doc.items.find(i => i.id === 'p2').collapsed, true, 'the server\'s copy has p2 collapsed');
  // a named version keeps it
  const named = await api('POST', `/api/projects/${S.project}/versions`, { label: 'Folded phase' }, S.nyx);
  const old = (await api('GET', `/api/projects/${S.project}/versions/${named.data.version.id}`, undefined, S.kip)).data;
  assert.equal(old.doc.items.find(i => i.id === 'p2').collapsed, true, 'versions keep collapsed phases');
  v.close(); n.close(); k.close();
  // everyone gone: the room is saved and a fresh join reads it back
  await new Promise(r => setTimeout(r, 300));
  const again = await joined(S.vee, S.project);
  assert.equal(again.snapshot.doc.items.find(i => i.id === 'p2').collapsed, true, 'still collapsed after everyone left and came back');
  again.close();
});

test('sanitize: a frame keeps mood when it is exactly true or false, and nothing else has it', () => {
  const d = cleanDoc({ items: [frame('a', { mood: true }), frame('b', { mood: false }), frame('c', { mood: 'true' }), frame('d', { mood: 1 }), frame('e', { mood: null }), frame('f'), card('n', { mood: true }),
    { id: 't', type: 'text', x: 0, y: 0, text: 'hi', mood: true }] });
  const by = id => d.items.find(i => i.id === id);
  assert.equal(by('a').mood, true);
  assert.equal(by('b').mood, false, 'false is kept: a collection made a phase again');
  for (const id of ['c', 'd', 'e', 'f', 'n', 't']) assert.equal('mood' in by(id), false, id + ' has no mood field');
  assert.equal(cleanOp({ k: 'items', op: 'put', obj: frame('g', { mood: true }) }).obj.mood, true);
  assert.equal('mood' in cleanOp({ k: 'items', op: 'put', obj: frame('h', { mood: { on: true } }) }).obj, false);
});

test('live: a mood board collection stays one when an older app moves it, and making it a phase again sticks', async () => {
  const v = await joined(S.vee, S.project), n = await joined(S.nyx, S.project);
  const next = c => c.next(m => m.t === 'ops' && m.by && m.ops.some(o => o.obj && o.obj.id === 'mb')).then(m => m.ops.find(o => o.obj && o.obj.id === 'mb').obj);
  n.send({ t: 'ops', batch: 1, ops: [{ k: 'items', op: 'put', obj: frame('mb', { x: 2000, title: 'Characters', mood: true }) }] });
  assert.equal((await next(v)).mood, true);
  // an app from before mood boards moves it: it stays a collection
  v.send({ t: 'ops', batch: 1, ops: [{ k: 'items', op: 'put', obj: frame('mb', { x: 2400, title: 'Characters' }) }] });
  let got = await next(n);
  assert.deepEqual([got.x, got.mood], [2400, true]);
  // made a phase again (false, not left out), and an older app's edit keeps it one
  n.send({ t: 'ops', batch: 2, ops: [{ k: 'items', op: 'put', obj: frame('mb', { x: 2400, title: 'Characters', mood: false }) }] });
  assert.equal((await next(v)).mood, false);
  v.send({ t: 'ops', batch: 2, ops: [{ k: 'items', op: 'put', obj: frame('mb', { x: 2500, title: 'Characters' }) }] });
  got = await next(n);
  assert.deepEqual([got.x, got.mood], [2500, false]);
  v.close(); n.close();
  await new Promise(r => setTimeout(r, 300));
  const again = await joined(S.vee, S.project);
  assert.equal(again.snapshot.doc.items.find(i => i.id === 'mb').mood, false, 'saved as a phase');
  again.close();
});
