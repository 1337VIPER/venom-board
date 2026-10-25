// Time tracking, sprints and tags on shared boards: the new optional fields (a card's tracked time and tags, a
// phase frame's sprint) survive the server's cleaning, live edits and a restart, and anything malformed is
// rebuilt from valid values or dropped.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { start } = require('../src/index');
const { cleanDoc, cleanOp } = require('../src/sanitize');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'venom-board-tracking-'));
const APPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'venom-board-app-'));
fs.writeFileSync(path.join(APPDIR, 'index.html'), '<!doctype html><title>Venom Board</title>');
const mail = [];
let srv, base;
const wait = ms => new Promise(r => setTimeout(r, ms));
const boot = async () => {
  srv = await start({ PORT: '0', DATA_DIR: DATA, PUBLIC_URL: 'http://localhost:9', QUIET: 'true', MAIL_PER_10_MIN: '100000', RATE_SCALE: '50', MIN_FREE_DISK_MB: '0', APP_DIR: APPDIR },
    { mail: async m => { mail.push(m); return true; } });
  base = `http://127.0.0.1:${srv.port}`;
};

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
const frame = (id, extra = {}) => ({ id, type: 'frame', x: -100, y: -100, w: 1200, h: 800, title: 'Sprint ' + id, color: '#a66bff', ...extra });
const linkFrom = (to, kind) => mail.filter(m => m.to === to && m.text.includes('#' + kind + '=')).pop().text.match(new RegExp('#' + kind + '=([\\w-]+)'))[1];
const item = (doc, id) => doc.items.find(i => i.id === id);
const S = {};

test.before(async () => {
  await boot();
  for (const u of ['vee', 'nyx']) {
    const r = await api('POST', '/api/auth/signup', { email: u + '@studio.test', username: u, password: 'correct horse', displayName: u[0].toUpperCase() + u.slice(1) });
    S[u] = r.data.token; S[u + 'Id'] = r.data.user.id;
    await api('POST', '/api/auth/verify', { token: linkFrom(u + '@studio.test', 'verify') });
  }
  S.team = (await api('POST', '/api/teams', { name: 'Night Keep' }, S.vee)).data.team.id;
  await api('POST', `/api/teams/${S.team}/invites`, { who: 'nyx', role: 'editor' }, S.vee);
  const inv = (await api('GET', '/api/me', undefined, S.nyx)).data.invites[0].id;
  await api('POST', `/api/invites/${inv}/accept`, undefined, S.nyx);
});
test.after(async () => { await srv.close(); for (const d of [DATA, APPDIR]) fs.rmSync(d, { recursive: true, force: true }); });

test('cleaning: tracked time is whole minutes from 0 to 1,000,000, and only a number counts', () => {
  const spent = v => item(cleanDoc({ items: [card('a', { spent: v })] }), 'a').spent;
  assert.equal(spent(150), 150);
  assert.equal(spent(89.6), 90, 'rounded to a whole minute');
  assert.equal(spent(5e9), 1000000, 'capped');
  assert.equal(spent(0), undefined, 'none tracked: no field at all');
  for (const bad of [-30, '120', NaN, Infinity, null, true, [60], { m: 60 }]) assert.equal(spent(bad), undefined, `dropped: ${JSON.stringify(bad)}`);
  // cards from before tracking stay exactly as they were
  const old = item(cleanDoc({ items: [card('o')] }), 'o');
  assert.ok(!('spent' in old) && !('tags' in old));
});

test('cleaning: tags are up to 8 short lower-case words, with anything else dropped', () => {
  const tags = v => item(cleanDoc({ items: [card('a', { tags: v })] }), 'a').tags;
  assert.deepEqual(tags(['Combat', '  boss-fight ', 'ui_polish', 'кот', 'combat', 'COMBAT']), ['combat', 'boss-fight', 'ui_polish', 'кот'], 'lower case, trimmed, no repeats');
  assert.deepEqual(tags(['ok', 'two words', '<b>x</b>', 'semi;colon', '"q"', '', ' ', 'x'.repeat(25), 'y'.repeat(24), 7, null, { t: 'z' }]), ['ok', 'y'.repeat(24)]);
  assert.deepEqual(tags(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], 'eight at most');
  assert.equal(tags('combat'), undefined, 'not a list');
  assert.equal(tags(['!!!']), undefined, 'nothing valid: no field');
  // tags on any kind of card
  assert.deepEqual(item(cleanDoc({ items: [card('i', { kind: 'idea', tags: ['later'] })] }), 'i').tags, ['later']);
});

test('cleaning: a sprint needs real dates in order, and capacity per person is checked', () => {
  const sprint = v => item(cleanDoc({ items: [frame('f', { sprint: v })] }), 'f').sprint;
  assert.deepEqual(sprint({ start: '2026-10-05', end: '2026-10-16' }), { start: '2026-10-05', end: '2026-10-16' });
  assert.deepEqual(sprint({ start: '2026-10-05', end: '2026-10-05', cap: { all: 4 } }), { start: '2026-10-05', end: '2026-10-05', cap: { all: 4 } }, 'one day is fine');
  for (const bad of [
    { start: '2026-02-30', end: '2026-03-04' }, // no such day
    { start: '2026-10-16', end: '2026-10-05' }, // ends before it starts
    { start: '2026-01-01', end: '2027-01-03' }, // more than a year
    { start: '2026-10-05' }, { end: '2026-10-05' }, { start: '05/10/2026', end: '16/10/2026' }, { start: '1999-01-01', end: '1999-01-02' },
    { start: 20261005, end: 20261016 }, '2026-10-05', ['2026-10-05', '2026-10-16'], null,
  ]) assert.equal(sprint(bad), undefined, `dropped: ${JSON.stringify(bad)}`);
  // capacity: ids or "all", 0 to 365 days (to a tenth), at most 50 people
  const cap = JSON.parse('{"all": 10, "u-1": 4.44, "u2": 0, "__proto__": 3, "bad id": 2, "neg": -1, "big": 366, "str": "5", "nan": null, "arr": [1]}');
  assert.deepEqual(sprint({ start: '2026-10-05', end: '2026-10-16', cap }).cap, { all: 10, 'u-1': 4.4, u2: 0 });
  assert.equal(Object.getPrototypeOf(sprint({ start: '2026-10-05', end: '2026-10-16', cap }).cap), Object.prototype);
  const many = {}; for (let i = 0; i < 80; i++) many['p' + i] = 1;
  assert.equal(Object.keys(sprint({ start: '2026-10-05', end: '2026-10-16', cap: many }).cap).length, 50);
  assert.deepEqual(sprint({ start: '2026-10-05', end: '2026-10-16', cap: [3, 4] }), { start: '2026-10-05', end: '2026-10-16' }, 'a list is not capacity');
  assert.deepEqual(sprint({ start: '2026-10-05', end: '2026-10-16', cap: {}, extra: '<script>' }), { start: '2026-10-05', end: '2026-10-16' }, 'only known fields');
  // a frame without a sprint, and a card that claims one, stay plain
  assert.ok(!('sprint' in item(cleanDoc({ items: [frame('p')] }), 'p')));
  assert.ok(!('sprint' in item(cleanDoc({ items: [card('c', { sprint: { start: '2026-10-05', end: '2026-10-16' } })] }), 'c')));
  // live edits go through the same cleaning
  const op = cleanOp({ k: 'items', op: 'put', obj: frame('f', { sprint: { start: '2026-10-05', end: '2026-10-16', cap: { all: 999 } } }) });
  assert.deepEqual(op.obj.sprint, { start: '2026-10-05', end: '2026-10-16' });
});

test('shared boards: new projects keep tracked time, tags and sprints, and clean the rest', async () => {
  const doc = { items: [
    frame('s1', { sprint: { start: '2026-10-05', end: '2026-10-16', cap: { [S.veeId]: 6, [S.nyxId]: 4.5 } } }),
    frame('s2', { sprint: { start: '2026-10-16', end: '2026-10-05' } }),
    card('c1', { spent: 150, tags: ['Combat', 'boss-fight'], est: '1d', assignees: [S.veeId] }),
    card('c2', { spent: -1, tags: ['<img src=x onerror=alert(1)>', 'ok'] }),
  ] };
  const r = await api('POST', `/api/teams/${S.team}/projects`, { name: 'Sprint board', doc }, S.vee);
  assert.equal(r.status, 200);
  S.project = r.data.project.id;
  const got = (await api('GET', `/api/projects/${S.project}`, undefined, S.nyx)).data.doc;
  assert.deepEqual(item(got, 's1').sprint, { start: '2026-10-05', end: '2026-10-16', cap: { [S.veeId]: 6, [S.nyxId]: 4.5 } });
  assert.ok(!('sprint' in item(got, 's2')), 'a sprint that ends before it starts is dropped, the frame stays');
  assert.equal(item(got, 'c1').spent, 150);
  assert.deepEqual(item(got, 'c1').tags, ['combat', 'boss-fight']);
  assert.ok(!('spent' in item(got, 'c2')));
  assert.deepEqual(item(got, 'c2').tags, ['ok']);
});

test('live edits: teammates see tracked time, tags and sprints as they change; bad values never reach them', async () => {
  const a = await joined(S.vee, S.project), b = await joined(S.nyx, S.project);
  assert.equal(item(b.snapshot.doc, 'c1').spent, 150, 'the snapshot carries the fields');
  assert.deepEqual(item(b.snapshot.doc, 's1').sprint.start, '2026-10-05');

  // a timer stopped: 25 more minutes on the card; and two tags
  const c1 = item(a.snapshot.doc, 'c1');
  a.send({ t: 'ops', batch: 1, ops: [{ k: 'items', op: 'put', obj: { ...c1, spent: 175, tags: ['combat', 'boss-fight', 'audio'] } }] });
  assert.equal((await a.next(m => m.t === 'ack')).batch, 1);
  let got = (await b.next(m => m.t === 'ops')).ops[0].obj;
  assert.equal(got.spent, 175);
  assert.deepEqual(got.tags, ['combat', 'boss-fight', 'audio']);

  // a phase made into a sprint, with capacity per person
  a.send({ t: 'ops', batch: 2, ops: [{ k: 'items', op: 'put', obj: frame('s3', { sprint: { start: '2026-10-19', end: '2026-10-30', cap: { [S.veeId]: 8, all: 12 } } }) }] });
  await a.next(m => m.t === 'ack' && m.batch === 2);
  got = (await b.next(m => m.t === 'ops')).ops[0].obj;
  assert.deepEqual(got.sprint, { start: '2026-10-19', end: '2026-10-30', cap: { [S.veeId]: 8, all: 12 } });

  // a hostile teammate: everything rebuilt from valid values or dropped
  b.send({ t: 'ops', batch: 3, ops: [
    { k: 'items', op: 'put', obj: { ...c1, spent: 'lots', tags: ['ok', '"><script>', 'a b', 'z'.repeat(40), 'OK'] } },
    { k: 'items', op: 'put', obj: frame('s4', { sprint: { start: '2026-13-01', end: '2026-14-01' } }) },
    { k: 'items', op: 'put', obj: frame('s5', { sprint: { start: '2026-10-05', end: '2026-10-16', cap: { all: -4, 'x"y': 3, [S.nyxId]: 1e9 }, note: 'hi' } }) },
  ] });
  await b.next(m => m.t === 'ack' && m.batch === 3);
  const ops = (await a.next(m => m.t === 'ops' && m.ops.length === 3)).ops;
  assert.ok(!('spent' in ops[0].obj), 'tracked time that is not a number is dropped');
  assert.deepEqual(ops[0].obj.tags, ['ok']);
  assert.ok(!('sprint' in ops[1].obj));
  assert.deepEqual(ops[2].obj.sprint, { start: '2026-10-05', end: '2026-10-16' });

  // tags cleared and tracked time reset: the fields go away
  a.send({ t: 'ops', batch: 4, ops: [{ k: 'items', op: 'put', obj: { ...c1, spent: 0, tags: [] } }] });
  await a.next(m => m.t === 'ack' && m.batch === 4);
  got = (await b.next(m => m.t === 'ops')).ops[0].obj;
  assert.ok(!('spent' in got) && !('tags' in got));

  // and back again, for the restart check
  a.send({ t: 'ops', batch: 5, ops: [{ k: 'items', op: 'put', obj: { ...c1, spent: 200, tags: ['polish'] } }] });
  await a.next(m => m.t === 'ack' && m.batch === 5);
  a.close(); b.close();
});

test('saved: the fields are still there after the server restarts', async () => {
  await wait(2500);  // rooms are written to disk every two seconds
  await srv.close();
  await boot();
  const doc = (await api('GET', `/api/projects/${S.project}`, undefined, S.vee)).data.doc;
  assert.equal(item(doc, 'c1').spent, 200);
  assert.deepEqual(item(doc, 'c1').tags, ['polish']);
  assert.deepEqual(item(doc, 's1').sprint.cap, { [S.veeId]: 6, [S.nyxId]: 4.5 });
  assert.deepEqual(item(doc, 's3').sprint, { start: '2026-10-19', end: '2026-10-30', cap: { [S.veeId]: 8, all: 12 } });
  assert.ok(!('sprint' in item(doc, 's4')));
  const c = await joined(S.nyx, S.project);
  assert.deepEqual(item(c.snapshot.doc, 'c1').tags, ['polish']);
  c.close();
});
