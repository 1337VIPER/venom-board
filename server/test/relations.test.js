// "Relates to" connectors: a second kind of connector (rel: true) that only shows that two things belong together.
// It passes the sanitizer, an older app's edit can't turn it into a dependency, and MCP tools can make one, tell it
// apart and leave it out of everything about dependencies: get_board's waits_on and ready list, the schedule and
// trace_card. And the GDD mind map template, built from the app's own code, is made of them.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { start } = require('../src/index');
const { cleanDoc, cleanOp } = require('../src/sanitize');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'venom-board-relations-'));
// the app's index.html for the template tools: this repository's, or the app's next to the server's own repository
const REAL_APP = [path.resolve(__dirname, '../..'), path.resolve(__dirname, '../../../app')]
  .find(d => { try { return /function tplBuild/.test(fs.readFileSync(path.join(d, 'index.html'), 'utf8')); } catch (e) { return false; } });
const APPDIR = REAL_APP || fs.mkdtempSync(path.join(os.tmpdir(), 'venom-board-app-'));
if (!REAL_APP) fs.writeFileSync(path.join(APPDIR, 'index.html'), '<!doctype html><title>Venom Board</title>');
const mail = [];
let srv, base;
const S = {};

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
async function joined(token, project) {
  const c = await socket({ t: 'auth', token }); await c.next(m => m.t === 'ready');
  c.send({ t: 'join', project }); c.snapshot = await c.next(m => m.t === 'snapshot'); return c;
}
const verifyToken = to => mail.filter(m => m.to === to && m.text.includes('#verify=')).pop().text.match(/#verify=([\w-]+)/)[1];
async function call(name, args) {
  const r = await fetch(base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer ' + S.mcp },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  return (await r.json()).result;
}
const ok = async (name, args) => { const r = await call(name, args); assert.ok(!r.isError, `${name}: ${r.isError && r.content[0].text}`); return r.structuredContent; };
const fails = async (name, args, re) => { const r = await call(name, args); assert.equal(r.isError, true, name + ' should fail'); assert.match(r.content[0].text, re); };

test.before(async () => {
  srv = await start({ PORT: '0', DATA_DIR: DATA, PUBLIC_URL: 'http://localhost:9', QUIET: 'true', MAIL_PER_10_MIN: '100000', RATE_SCALE: '50', MIN_FREE_DISK_MB: '0', APP_DIR: APPDIR,
    MAIL_FROM: 'Venom Board <support@studio.test>' }, { mail: async m => { mail.push(m); return true; } });
  base = `http://127.0.0.1:${srv.port}`;
  for (const u of ['rhea', 'tycho']) {
    const r = await api('POST', '/api/auth/signup', { email: u + '@studio.test', username: u, password: 'correct horse', displayName: u[0].toUpperCase() + u.slice(1) });
    S[u] = r.data.token;
    await api('POST', '/api/auth/verify', { token: verifyToken(u + '@studio.test') });
  }
  S.team = (await api('POST', '/api/teams', { name: 'Mind Maps' }, S.rhea)).data.team.id;
  await api('POST', `/api/teams/${S.team}/invites`, { who: 'tycho', role: 'editor' }, S.rhea);
  const inv = (await api('GET', '/api/me', undefined, S.tycho)).data.invites[0].id;
  await api('POST', `/api/invites/${inv}/accept`, undefined, S.tycho);
  S.mcp = (await api('POST', '/api/me/tokens', { name: 'Desk', password: 'correct horse' }, S.rhea)).data.token;
});
test.after(async () => { await srv.close(); fs.rmSync(DATA, { recursive: true, force: true }); if (!REAL_APP) fs.rmSync(APPDIR, { recursive: true, force: true }); });

test('sanitizer: rel is kept as true or false and dropped when it is anything else', () => {
  const link = extra => ({ id: 'l1', type: 'link', from: { id: 'a' }, to: { id: 'b' }, ...extra });
  const one = extra => cleanDoc({ items: [], links: [link(extra)] }, {}).links[0];
  assert.equal(one({ rel: true }).rel, true);
  assert.equal(one({ rel: false }).rel, false, 'made "waits on" again');
  assert.equal('rel' in one({}), false, 'left out, it means "waits on", as on every older board');
  for (const bad of ['true', 1, null, { x: 1 }, '<img src=x>']) assert.equal('rel' in one({ rel: bad }), false, JSON.stringify(bad));
  assert.equal(cleanOp({ k: 'links', op: 'put', obj: link({ rel: true, dash: true, head: 'none' }) }, {}).obj.rel, true, 'live edits too');
});

test('live edits: a "relates to" connector reaches teammates, an older app keeps it, and false makes it "waits on" again', async () => {
  S.project = (await api('POST', `/api/teams/${S.team}/projects`, { name: 'Links', doc: { items: [] } }, S.rhea)).data.project.id;
  const [r, t] = await Promise.all([joined(S.rhea, S.project), joined(S.tycho, S.project)]);
  const next = (c, id) => c.next(m => m.t === 'ops' && m.by && m.ops.some(o => o.obj && o.obj.id === id)).then(m => m.ops.find(o => o.obj && o.obj.id === id).obj);
  const card = id => ({ id, type: 'node', kind: 'task', x: 0, y: 0, w: 240, h: 100, title: id, status: 'todo' });
  const wire = extra => ({ id: 'w1', type: 'link', from: { id: 'c1' }, to: { id: 'c2' }, color: '#f1eef2', style: 'curve', head: 'none', dash: true, flow: false, label: '', ...extra });
  t.send({ t: 'ops', batch: 1, ops: [{ k: 'items', op: 'put', obj: card('c1') }, { k: 'items', op: 'put', obj: card('c2') }, { k: 'links', op: 'put', obj: wire({ rel: true }) }] });
  let got = await next(r, 'w1');
  assert.equal(got.rel, true);
  // an app from before "relates to" restyles it: it stays "relates to"
  r.send({ t: 'ops', batch: 1, ops: [{ k: 'links', op: 'put', obj: wire({ style: 'straight' }) }] });
  got = await next(t, 'w1');
  assert.deepEqual([got.style, got.rel], ['straight', true]);
  // made "waits on" again (false), and an older app's edit after that doesn't bring "relates to" back
  t.send({ t: 'ops', batch: 2, ops: [{ k: 'links', op: 'put', obj: wire({ rel: false, head: 'end', dash: false }) }] });
  got = await next(r, 'w1');
  assert.equal(got.rel, false);
  r.send({ t: 'ops', batch: 2, ops: [{ k: 'links', op: 'put', obj: wire({ head: 'end', dash: false, label: 'next' }) }] });
  got = await next(t, 'w1');
  assert.deepEqual([got.label, got.rel], ['next', false]);
  for (const c of [r, t]) c.close();
});

test('MCP: "relates to" connectors are made, read and left out of the schedule, the ready list and trace_card', async () => {
  const proj = (await ok('create_project', { team_id: S.team, name: 'Relations' })).project_id;
  const phase = (await ok('add_phase', { project_id: proj, title: 'Build' })).phase_id;
  await ok('add_cards', { project_id: proj, phase_id: phase, cards: [{ title: 'Combat', estimate: '5d' }, { title: 'Boss fight', estimate: '3d', waits_on: ['Combat'] }, { title: 'Soundtrack', estimate: '4d' }, { title: 'Lore bible', kind: 'idea' }] });
  // link_cards still means "waits on" unless kind says otherwise
  assert.equal((await ok('link_cards', { project_id: proj, links: [{ from: 'Combat', to: 'Soundtrack', kind: 'relates_to' }] })).linked, 1);
  const added = (await ok('add_connectors', { project_id: proj, connectors: [{ from: 'Lore bible', to: 'Boss fight', kind: 'relates_to', label: 'theme' }, { from: 'Lore bible', to: 'Combat', kind: 'relates_to', dashed: false, arrowheads: 'end' }] })).added;
  await fails('add_connectors', { project_id: proj, connectors: [{ from: 'Combat', to: 'Soundtrack', kind: 'sort of' }] }, /waits_on or relates_to/);

  // get_items tells the kinds apart, and a "relates to" one looks it unless told otherwise
  let wires = (await ok('get_items', { project_id: proj, types: ['connector'] })).connectors;
  assert.deepEqual(wires.map(w => w.kind).sort(), ['relates_to', 'relates_to', 'relates_to', 'waits_on']);
  const theme = wires.find(w => w.id === added[0]), solid = wires.find(w => w.id === added[1]);
  assert.deepEqual([theme.dashed, theme.head, theme.label], [true, 'none', 'theme']);
  assert.deepEqual([solid.dashed, solid.head], [undefined, 'end'], 'arrowheads and dashed still win');

  // get_board: waits_on is dependencies only; relates_to lists the others both ways; Soundtrack is still ready
  const board = await ok('get_board', { project_id: proj }), cards = Object.fromEntries(board.phases[0].cards.map(c => [c.title, c]));
  const id = t => cards[t].id;
  assert.deepEqual(cards['Boss fight'].waits_on, [id('Combat')]);
  assert.equal(cards.Soundtrack.waits_on, undefined);
  assert.deepEqual(cards.Soundtrack.relates_to, [id('Combat')]);
  assert.deepEqual(cards.Combat.relates_to.sort(), [id('Soundtrack'), id('Lore bible')].sort());
  assert.ok(board.summary.ready_to_start.includes('Soundtrack') && !board.summary.ready_to_start.includes('Boss fight'));

  // the schedule starts Soundtrack today, in parallel with Combat; only Combat → Boss fight is on the critical path
  let plan = await ok('get_schedule', { project_id: proj });
  const row = t => plan.tasks.find(r => r.title === t);
  assert.equal(row('Soundtrack').start, row('Combat').start);
  assert.equal(plan.working_days_left, 8);
  assert.deepEqual(plan.critical_path, ['Combat', 'Boss fight']);
  // trace_card follows dependencies only
  const tr = await ok('trace_card', { project_id: proj, card_id: 'Combat' });
  assert.deepEqual(tr.waiting_on_it.map(r => r.title), ['Boss fight']);
  assert.deepEqual(tr.waits_on, []);

  // update_connectors switches the kind, with its look: Soundtrack now waits on Combat
  const sound = wires.find(w => w.kind === 'relates_to' && w.to === id('Soundtrack'));
  await ok('update_connectors', { project_id: proj, updates: [{ id: sound.id, kind: 'waits_on' }] });
  wires = (await ok('get_items', { project_id: proj, ids: [sound.id] })).connectors;
  assert.deepEqual([wires[0].kind, wires[0].dashed, wires[0].head], ['waits_on', undefined, 'end']);
  plan = await ok('get_schedule', { project_id: proj });
  assert.equal(plan.tasks.find(r => r.title === 'Soundtrack').start, plan.tasks.find(r => r.title === 'Boss fight').start, 'both start when Combat is done');
  await ok('update_connectors', { project_id: proj, updates: [{ id: sound.id, kind: 'relates_to' }] });
  assert.equal((await ok('get_board', { project_id: proj })).phases[0].cards.find(c => c.title === 'Soundtrack').waits_on, undefined);
});

test('the GDD mind map template: ideas joined by "relates to" connectors, growing outward with nothing on top of anything', { skip: !REAL_APP && 'the app\'s index.html isn\'t next to this repository' }, async () => {
  const tpls = (await ok('list_templates', {})).templates;
  assert.ok(tpls.some(t => t.key === 'gddmap' && t.name === 'GDD mind map'), 'listed');
  const proj = (await ok('create_project', { team_id: S.team, name: 'Design doc', template: 'gddmap' })).project_id;
  const items = (await ok('get_items', { project_id: proj })), cards = items.items.filter(i => i.type === 'card'), wires = items.connectors;
  assert.ok(cards.length >= 1 + 10 + 20, `a game, its branches and their details (${cards.length} cards)`);
  assert.ok(cards.every(c => c.kind === 'idea' && c.notes), 'ideas with notes');
  assert.equal(wires.length, cards.length - 1, 'a tree: every card but the game hangs off one wire');
  assert.ok(wires.every(w => w.kind === 'relates_to' && w.dashed && w.head === 'none' && w.style === 'curve'), 'dashed "relates to" curves');
  assert.ok(items.items.some(i => i.type === 'text' && /its own board/.test(i.text)), 'the note about giving a big branch its own board');
  // nothing overlaps (with room to spare), and every detail is further from the game than its branch
  const box = c => ({ x: c.x, y: c.y, w: c.w, h: 130 }), gap = (a, b) => Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w), a.y - (b.y + b.h), b.y - (a.y + a.h));
  for (let i = 0; i < cards.length; i++) for (let j = i + 1; j < cards.length; j++) assert.ok(gap(box(cards[i]), box(cards[j])) >= 20, `${cards[i].title} and ${cards[j].title} overlap`);
  const mid = c => ({ x: c.x + c.w / 2, y: c.y + 65 }), game = cards.find(c => !wires.some(w => w.to === c.id)), byId = new Map(cards.map(c => [c.id, c]));
  const far = c => Math.hypot(mid(c).x - mid(game).x, mid(c).y - mid(game).y);
  for (const w of wires) if (w.from !== game.id) assert.ok(far(byId.get(w.to)) > far(byId.get(w.from)) + 150, `${byId.get(w.to).title} grows outward`);
  // ideas stay out of the schedule and the ready list
  const plan = await ok('get_schedule', { project_id: proj });
  assert.deepEqual([plan.tasks.length, plan.critical_path.length], [0, 0]);
  assert.equal((await ok('get_board', { project_id: proj })).summary.tasks_total, 0);
  // apply_template adds it to a board too
  const t = await ok('apply_template', { project_id: proj, template: 'gddmap' });
  assert.deepEqual([t.added, t.connectors], [cards.length + 1, wires.length]);
});
