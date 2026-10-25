// Tests for the MCP tools that the game engine editor panels (Godot, Unity, Unreal) use: my_tasks lists the
// unfinished cards assigned to you across every team project, and set_card_status moves one card along.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { start } = require('../src/index');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'venom-board-engines-'));
const APPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'venom-board-app-'));
fs.writeFileSync(path.join(APPDIR, 'index.html'), '<!doctype html><title>Venom Board</title>');
const mail = [];
let srv, base;

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
async function joined(token, project) {
  const c = await socket({ t: 'auth', token }); await c.next(m => m.t === 'ready');
  c.send({ t: 'join', project }); c.snapshot = await c.next(m => m.t === 'snapshot'); return c;
}
const linkFrom = (to, kind) => mail.filter(m => m.to === to && m.text.includes('#' + kind + '=')).pop().text.match(new RegExp('#' + kind + '=([\\w-]+)'))[1];
// one JSON-RPC call to /mcp, the way the editor panels send it
async function rpc(token, method, params, headers = {}) {
  const r = await fetch(base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return { status: r.status, data: await r.json() };
}
const tool = async (token, name, args = {}) => (await rpc(token, 'tools/call', { name, arguments: args })).data.result;
const card = (id, extra = {}) => ({ id, type: 'node', kind: 'task', x: 0, y: 0, w: 240, h: 100, title: 'Card ' + id, status: 'todo', ...extra });
const S = {};

test.before(async () => {
  srv = await start({ PORT: '0', DATA_DIR: DATA, PUBLIC_URL: 'http://localhost:9', QUIET: 'true', MAIL_PER_10_MIN: '100000', RATE_SCALE: '50', MIN_FREE_DISK_MB: '0', APP_DIR: APPDIR },
    { mail: async m => { mail.push(m); return true; } });
  base = `http://127.0.0.1:${srv.port}`;
  for (const u of ['vee', 'nyx', 'kip', 'out']) {
    const r = await api('POST', '/api/auth/signup', { email: u + '@studio.test', username: u, password: 'correct horse', displayName: u[0].toUpperCase() + u.slice(1) });
    S[u] = r.data.token; S[u + 'Id'] = r.data.user.id;
    await api('POST', '/api/auth/verify', { token: linkFrom(u + '@studio.test', 'verify') });
  }
  const join = async (team, who, role, by) => {
    await api('POST', `/api/teams/${team}/invites`, { who, role }, by);
    const inv = (await api('GET', '/api/me', undefined, S[who])).data.invites.find(i => i.team.id === team).id;
    await api('POST', `/api/invites/${inv}/accept`, undefined, S[who]);
  };
  // vee leads "Night Keep" (nyx edits, kip views) and is only a viewer in nyx's "Side Quest"
  S.team = (await api('POST', '/api/teams', { name: 'Night Keep' }, S.vee)).data.team.id;
  await join(S.team, 'nyx', 'editor', S.vee);
  await join(S.team, 'kip', 'viewer', S.vee);
  S.side = (await api('POST', '/api/teams', { name: 'Side Quest' }, S.nyx)).data.team.id;
  await join(S.side, 'vee', 'viewer', S.nyx);
  S.outTeam = (await api('POST', '/api/teams', { name: 'Elsewhere' }, S.out)).data.team.id;
  const mine = [S.veeId];
  S.slice = (await api('POST', `/api/teams/${S.team}/projects`, { name: 'Slice', doc: { items: [
    { id: 'ph1', type: 'frame', x: 0, y: 0, w: 600, h: 760, title: '01 · Prototype', color: '#a66bff' },
    card('late', { title: 'Boss arena blockout', x: 40, y: 70, disc: 'level', prio: 'should', est: '2d', due: '2026-01-10', assignees: mine }),
    card('soon', { title: 'Parry timing', x: 320, y: 70, disc: 'code', prio: 'could', due: '2026-01-20', assignees: [S.veeId, S.nyxId], status: 'doing' }),
    card('must', { title: 'Save system', x: 900, y: 0, disc: 'code', prio: 'must', due: '2026-01-20', assignees: mine }),
    card('nodue', { title: 'Footstep sounds', x: 900, y: 200, disc: 'audio', assignees: mine }),
    card('crash', { title: 'Crash on load', kind: 'bug', sev: 'crash', x: 900, y: 400, color: '#ff7a1a', assignees: mine, status: 'blocked' }),
    card('fin', { title: 'Title screen', x: 900, y: 600, status: 'done', due: '2026-01-01', assignees: mine }),
    card('theirs', { title: 'Rig the knight', x: 1200, y: 0, disc: 'art', assignees: [S.nyxId] }),
    card('free', { title: 'Write the intro', x: 1200, y: 200, disc: 'narr', prio: 'must' }),
  ] } }, S.vee)).data.project.id;
  S.quest = (await api('POST', `/api/teams/${S.side}/projects`, { name: 'Quest log', doc: { items: [
    card('q1', { title: 'Quest journal UI', disc: 'ui', due: '2026-01-15', assignees: mine }),
  ] } }, S.nyx)).data.project.id;
  S.away = (await api('POST', `/api/teams/${S.outTeam}/projects`, { name: 'Hidden', doc: { items: [card('h1', { title: 'Not yours to see', assignees: [S.outId] })] } }, S.out)).data.project.id;
  const tok = async u => (await api('POST', '/api/me/tokens', { name: 'Editor panel', password: 'correct horse' }, S[u])).data.token;
  S.veeTok = await tok('vee'); S.kipTok = await tok('kip'); S.outTok = await tok('out');
});
test.after(async () => { await srv.close(); for (const d of [DATA, APPDIR]) fs.rmSync(d, { recursive: true, force: true }); });

test('engines: the new tools are listed next to the old ones', async () => {
  const r = await rpc(S.veeTok, 'tools/list', {});
  assert.equal(r.status, 200);
  const tools = r.data.result.tools, names = tools.map(t => t.name);
  for (const n of ['my_tasks', 'set_card_status', 'list_projects', 'get_board', 'update_cards', 'add_comment']) assert.ok(names.includes(n), n);
  const my = tools.find(t => t.name === 'my_tasks');
  assert.equal(my.annotations.readOnlyHint, true);
  assert.deepEqual(my.inputSchema.required, []);
  assert.deepEqual(tools.find(t => t.name === 'set_card_status').inputSchema.required, ['project_id', 'card_id', 'status']);
  assert.ok(!('run' in my), 'only the description goes out');
});

test('engines: my_tasks lists your unfinished cards across every team, soonest due first, then by priority', async () => {
  const r = await tool(S.veeTok, 'my_tasks', { today: '2026-01-15' });
  assert.ok(!r.isError, JSON.stringify(r));
  const out = r.structuredContent;
  assert.equal(out.today, '2026-01-15');
  assert.equal(out.you, 'vee');
  assert.deepEqual(out.tasks.map(t => t.card_id), ['late', 'q1', 'must', 'soon', 'crash', 'nodue'],
    'due dates first (same day: must before could), then cards with no due date (blocked before to do); done cards, other people\'s and unassigned cards left out');
  assert.equal(out.total, 6);
  const late = out.tasks[0];
  assert.deepEqual(late, { project_id: S.slice, project: 'Slice', team: 'Night Keep', can_edit: true, card_id: 'late', title: 'Boss arena blockout', kind: 'task', status: 'todo',
    priority: 'should', discipline: 'level', estimate: '2d', due: '2026-01-10', due_in_days: -5, overdue: true, severity: '', phase: '01 · Prototype', color: '#3dff8b',
    assigned_to_you: true, assignees: ['Vee'], link: `http://localhost:9/app#p=${S.slice}&c=late` });
  const q1 = out.tasks.find(t => t.card_id === 'q1');
  assert.equal(q1.team, 'Side Quest');
  assert.equal(q1.can_edit, false, 'vee only views that team, so the panel can grey out the status buttons');
  assert.equal(q1.due_in_days, 0);
  assert.equal(q1.overdue, false, 'due today is not overdue');
  const soon = out.tasks.find(t => t.card_id === 'soon');
  assert.deepEqual(soon.assignees, ['Vee', 'Nyx']);
  assert.equal(soon.status, 'doing');
  assert.equal(soon.due_in_days, 5);
  const nodue = out.tasks.find(t => t.card_id === 'nodue');
  assert.equal(nodue.due, '');
  assert.equal(nodue.due_in_days, null);
  assert.equal(nodue.overdue, false);
  assert.equal(nodue.phase, '', 'outside every phase');
  const crash = out.tasks.find(t => t.card_id === 'crash');
  assert.equal(crash.kind, 'bug');
  assert.equal(crash.severity, 'crash');
  assert.equal(crash.color, '#ff7a1a', 'a card with no discipline keeps its own colour');
  // every row has every field, so small clients can read them without checks
  const keys = Object.keys(late).sort().join();
  assert.ok(out.tasks.every(t => Object.keys(t).sort().join() === keys));
  // the projects you can open, with how many tasks each holds for you (for a project filter)
  assert.deepEqual(out.projects.map(p => [p.team, p.project, p.tasks, p.can_edit]), [['Night Keep', 'Slice', 5, true], ['Side Quest', 'Quest log', 1, false]]);
  assert.ok(!JSON.stringify(out).includes('Not yours to see'), 'nothing from teams you are not in');
});

test('engines: my_tasks for one project, with the cards nobody has taken yet', async () => {
  const one = (await tool(S.veeTok, 'my_tasks', { project_id: S.quest, today: '2026-01-15' })).structuredContent;
  assert.deepEqual(one.tasks.map(t => t.card_id), ['q1']);
  assert.deepEqual(one.projects.map(p => p.project), ['Quest log']);
  const open = (await tool(S.veeTok, 'my_tasks', { project_id: S.slice, include_unassigned_in_project: true, today: '2026-01-15' })).structuredContent;
  assert.deepEqual(open.tasks.map(t => t.card_id), ['late', 'must', 'soon', 'free', 'crash', 'nodue'], 'no due date: must before the rest');
  const free = open.tasks.find(t => t.card_id === 'free');
  assert.equal(free.assigned_to_you, false);
  assert.deepEqual(free.assignees, []);
  assert.ok(!open.tasks.some(t => t.card_id === 'theirs'), 'cards assigned to someone else stay out');
  // mistakes get plain answers
  const noProject = await tool(S.veeTok, 'my_tasks', { include_unassigned_in_project: true });
  assert.equal(noProject.isError, true);
  assert.match(noProject.content[0].text, /needs a project_id/);
  assert.match((await tool(S.veeTok, 'my_tasks', { project_id: S.away })).content[0].text, /No project/);
  assert.match((await tool(S.veeTok, 'my_tasks', { today: '15/01/2026' })).content[0].text, /today looks like/);
  // someone in another team sees only their own
  const other = (await tool(S.outTok, 'my_tasks', {})).structuredContent;
  assert.deepEqual(other.tasks.map(t => t.card_id), ['h1']);
});

test('engines: today comes from your time zone when the editor does not send it', async () => {
  await api('PATCH', '/api/me', { timezone: 'Pacific/Kiritimati' }, S.vee);
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Kiritimati', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const g = t => p.find(x => x.type === t).value, want = `${g('year')}-${g('month')}-${g('day')}`;
  assert.equal((await tool(S.veeTok, 'my_tasks', {})).structuredContent.today, want);
  await api('PATCH', '/api/me', { timezone: '' }, S.vee);
  assert.equal((await tool(S.veeTok, 'my_tasks', {})).structuredContent.today, new Date().toISOString().slice(0, 10));
});

test('engines: set_card_status moves a card for everyone, and only editors can', async () => {
  const mate = await joined(S.nyx, S.slice);
  const r = await tool(S.veeTok, 'set_card_status', { project_id: S.slice, card_id: 'late', status: 'doing', today: '2026-01-15' });
  assert.ok(!r.isError, JSON.stringify(r));
  assert.equal(r.structuredContent.changed, true);
  assert.equal(r.structuredContent.previous_status, 'todo');
  assert.equal(r.structuredContent.task.status, 'doing');
  assert.equal(r.structuredContent.task.card_id, 'late');
  assert.equal(r.structuredContent.task.overdue, true);
  assert.equal(r.structuredContent.task.link, `http://localhost:9/app#p=${S.slice}&c=late`);
  const seen = await mate.next(m => m.t === 'ops');
  const moved = seen.ops.find(o => o.obj && o.obj.id === 'late').obj;
  assert.equal(moved.status, 'doing', 'a teammate with the board open sees it move');
  const before = mate.snapshot.doc.items.find(i => i.id === 'late');
  assert.deepEqual({ ...moved, status: before.status }, before, 'nothing else about the card changes');
  // the same status again is fine and changes nothing
  const again = await tool(S.veeTok, 'set_card_status', { project_id: S.slice, card_id: 'late', status: 'doing' });
  assert.equal(again.structuredContent.changed, false);
  // finished: it leaves my_tasks, shows in the activity feed, and gets a finish time for the burndown
  const done = await tool(S.veeTok, 'set_card_status', { project_id: S.slice, card_id: 'Boss arena blockout', status: 'done' });
  assert.equal(done.structuredContent.task.status, 'done');
  assert.equal(done.structuredContent.task.overdue, false);
  const fin = (await mate.next(m => m.t === 'ops')).ops.find(o => o.obj && o.obj.id === 'late').obj;
  assert.ok(fin.doneAt > 0);
  assert.ok(!(await tool(S.veeTok, 'my_tasks', {})).structuredContent.tasks.some(t => t.card_id === 'late'));
  await new Promise(res => setTimeout(res, 100));
  const feed = (await api('GET', `/api/projects/${S.slice}/activity`, undefined, S.vee)).data.items;
  assert.ok(feed.some(e => e.kind === 'done' && e.text === 'Boss arena blockout'), JSON.stringify(feed));
  mate.close();
  // permissions stay as they are: viewers can't change the board, even their own cards
  const viewer = await tool(S.kipTok, 'set_card_status', { project_id: S.slice, card_id: 'free', status: 'doing' });
  assert.equal(viewer.isError, true);
  assert.match(viewer.content[0].text, /viewer/);
  const sideQuest = await tool(S.veeTok, 'set_card_status', { project_id: S.quest, card_id: 'q1', status: 'done' });
  assert.equal(sideQuest.isError, true, 'vee only views Side Quest');
  assert.match((await tool(S.outTok, 'set_card_status', { project_id: S.slice, card_id: 'free', status: 'done' })).content[0].text, /No project/);
  // and mistakes
  assert.match((await tool(S.veeTok, 'set_card_status', { project_id: S.slice, card_id: 'free', status: 'shipped' })).content[0].text, /Unknown status/);
  assert.match((await tool(S.veeTok, 'set_card_status', { project_id: S.slice, card_id: 'nope', status: 'done' })).content[0].text, /No card/);
  assert.match((await tool(S.veeTok, 'set_card_status', { project_id: S.slice, card_id: 'free' })).content[0].text, /Give a status/);
});

test('engines: what an editor panel sees when the token is wrong or missing', async () => {
  for (const t of [null, 'vbt_' + 'x'.repeat(43), 'not-a-token']) {
    const r = await rpc(t, 'tools/call', { name: 'my_tasks', arguments: {} });
    assert.equal(r.status, 401);
    assert.equal(r.data.error.code, -32001);
    assert.match(r.data.error.message, /access token/);
  }
  const unknown = await rpc(S.veeTok, 'tools/call', { name: 'my_taskz', arguments: {} });
  assert.equal(unknown.status, 200);
  assert.equal(unknown.data.error.code, -32602);
});
