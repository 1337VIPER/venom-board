// End-to-end tests for boards inside a team project (tabs in the app): each extra board is a project of its own that
// belongs to the project, follows its people settings, goes when it's deleted, and shows up in live rooms and MCP tools.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const Database = require('better-sqlite3');
const { start } = require('../src/index');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'venom-board-boards-'));
const APPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'venom-board-app-'));
fs.writeFileSync(path.join(APPDIR, 'index.html'), '<!doctype html><title>Venom Board</title>');
const mail = [], posts = [];
let srv, base;
const fakeFetch = async (url, opts) => { posts.push({ url, body: JSON.parse(opts.body) }); return { ok: true, status: 204 }; };
const wait = ms => new Promise(r => setTimeout(r, ms));
const LIMIT = 12;  // projects and boards a team may have

async function api(method, p, body, token, headers = {}) {
  const r = await fetch(base + p, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers },
    body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
  });
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
      none: async (pred, ms = 300) => { await wait(ms); return !inbox.some(pred); },
      close: () => ws.close(),
    };
    ws.on('open', () => { c.send(first); resolve(c); });
    ws.on('error', reject);
  });
}
const live = async token => { const c = await socket({ t: 'auth', token }); await c.next(m => m.t === 'ready'); return c; };
async function joined(token, project) { const c = await live(token); c.send({ t: 'join', project }); c.snapshot = await c.next(m => m.t === 'snapshot'); return c; }
async function tool(token, name, args) {
  const r = await fetch(base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  return (await r.json()).result;
}
const card = (id, extra = {}) => ({ id, type: 'node', kind: 'task', x: 0, y: 0, w: 240, title: 'Card ' + id, ...extra });
const linkFrom = (to, kind) => mail.filter(m => m.to === to && m.text.includes('#' + kind + '=')).pop().text.match(new RegExp('#' + kind + '=([\\w-]+)'))[1];
const dbRows = (sql, ...args) => { const d = new Database(path.join(DATA, 'venom-board.db'), { readonly: true }); try { return d.prepare(sql).all(...args); } finally { d.close(); } };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const board = (from, name, token, doc) => api('POST', `/api/projects/${from}/boards`, { name, ...(doc ? { doc } : {}) }, token);
const S = {};

test.before(async () => {
  srv = await start({ PORT: '0', DATA_DIR: DATA, PUBLIC_URL: 'http://localhost:9', QUIET: 'true', MAIL_PER_10_MIN: '100000', RATE_SCALE: '50', MIN_FREE_DISK_MB: '0',
    DISCORD_DELAY_MS: '40', SEARCH_INDEX_DELAY_MS: '30', APP_DIR: APPDIR, LIMIT_TEAM_PROJECTS: String(LIMIT), MAIL_FROM: 'Venom Board <support@studio.test>' },
  { mail: async m => { mail.push(m); return true; }, fetch: fakeFetch });
  base = `http://127.0.0.1:${srv.port}`;
  for (const u of ['lead', 'ada', 'eddie', 'vic', 'out']) {
    const r = await api('POST', '/api/auth/signup', { email: u + '@studio.test', username: u, password: 'correct horse', displayName: u[0].toUpperCase() + u.slice(1) });
    S[u] = r.data.token; S[u + 'Id'] = r.data.user.id;
    await api('POST', '/api/auth/verify', { token: linkFrom(u + '@studio.test', 'verify') });
  }
  S.team = (await api('POST', '/api/teams', { name: 'Night Keep' }, S.lead)).data.team.id;
  for (const [u, role] of [['ada', 'admin'], ['eddie', 'editor'], ['vic', 'viewer']]) {
    await api('POST', `/api/teams/${S.team}/invites`, { who: u, role }, S.lead);
    await api('POST', `/api/invites/${(await api('GET', '/api/me', undefined, S[u])).data.invites[0].id}/accept`, undefined, S[u]);
  }
  S.steam = (await api('POST', `/api/teams/${S.team}/projects`, { name: 'Steam launch', doc: { items: [card('s1', { title: 'Boss arena blockout' })] } }, S.lead)).data.project.id;
  S.mood = (await api('POST', `/api/teams/${S.team}/projects`, { name: 'Moodboard' }, S.lead)).data.project.id;
  S.other = (await api('POST', '/api/teams', { name: 'Elsewhere' }, S.out)).data.team.id;
  S.otherProject = (await api('POST', `/api/teams/${S.other}/projects`, { name: 'Their game' }, S.out)).data.project.id;
});
test.after(async () => { await srv.close(); for (const d of [DATA, APPDIR]) fs.rmSync(d, { recursive: true, force: true }); });

test('boards: made from the project or any of its boards, they belong to the project, listed first to last', async () => {
  const vic = await live(S.vic);
  const store = await board(S.steam, 'Store page', S.eddie, { items: [card('b1', { title: 'Store page capsule' })] });
  assert.equal(store.status, 200, JSON.stringify(store.data));
  assert.deepEqual(store.data.project, { id: store.data.project.id, name: 'Store page', teamId: S.team, parentId: S.steam });
  S.store = store.data.project.id;
  assert.equal((await vic.next(m => m.t === 'team')).id, S.team, 'the team hears about it, so every app shows the new tab');
  // made from one of its boards, a board still belongs to the project (only one level)
  const trailer = await board(S.store, 'Trailer', S.lead);
  assert.equal(trailer.data.project.parentId, S.steam);
  S.trailer = trailer.data.project.id;
  const untitled = await board(S.steam, '   ', S.lead);
  assert.equal(untitled.data.project.name, 'Untitled board');
  S.untitled = untitled.data.project.id;

  // the project first, then its boards oldest first, asked from any of them
  for (const from of [S.steam, S.trailer]) {
    const r = await api('GET', `/api/projects/${from}/boards`, undefined, S.vic);
    assert.equal(r.status, 200);
    assert.equal(r.data.root, S.steam);
    assert.deepEqual(r.data.boards.map(b => b.id), [S.steam, S.store, S.trailer, S.untitled]);
    assert.deepEqual(r.data.boards.map(b => b.name), ['Steam launch', 'Store page', 'Trailer', 'Untitled board']);
    assert.ok(r.data.boards.every(b => b.createdAt > 0 && b.updatedAt > 0 && b.updatedBy === (b.id === S.store ? 'Eddie' : 'Lead')));
  }
  assert.equal((await api('GET', `/api/projects/${S.mood}/boards`, undefined, S.vic)).data.boards.length, 1, 'a project without boards is just itself');

  // the Team panel and project lists say which project each board belongs to
  for (const url of [`/api/teams/${S.team}`, `/api/teams/${S.team}/projects`]) {
    const list = (await api('GET', url, undefined, S.eddie)).data.projects;
    assert.equal(list.length, 5);
    assert.equal(list.find(p => p.id === S.steam).parentId, null);
    for (const id of [S.store, S.trailer, S.untitled]) assert.equal(list.find(p => p.id === id).parentId, S.steam, url);
    assert.ok(list.every(p => p.createdAt > 0 && p.updatedAt >= p.createdAt));
  }
  const got = await api('GET', `/api/projects/${S.store}`, undefined, S.vic);
  assert.deepEqual(got.data.project, { id: S.store, name: 'Store page', teamId: S.team, parentId: S.steam });
  assert.ok(got.data.doc.items.some(i => i.id === 'b1'), 'a board can start from a board that was sent');
  assert.equal((await api('GET', `/api/projects/${S.steam}`, undefined, S.vic)).data.project.parentId, null);

  // each board is a project of its own: renaming one reaches its room and the team
  const lead = await joined(S.lead, S.untitled);
  vic.inbox.length = 0;
  assert.equal((await api('PATCH', `/api/projects/${S.untitled}`, { name: '' }, S.eddie)).data.error, 'Give the board a name.');
  assert.equal((await api('PATCH', `/api/projects/${S.untitled}`, { name: 'Level art' }, S.eddie)).status, 200);
  assert.equal((await lead.next(m => m.t === 'renamed')).name, 'Level art');
  assert.equal((await vic.next(m => m.t === 'team')).id, S.team);

  // nobody outside the team sees or adds to them
  assert.equal((await api('GET', `/api/projects/${S.steam}/boards`, undefined, S.out)).status, 404);
  assert.equal((await board(S.steam, 'Mine now', S.out)).status, 404);
  assert.equal((await board('not an id!', 'Nope', S.lead)).status, 404);
  for (const c of [vic, lead]) c.close();
});

test('boards: an editor of the project makes them, a viewer can’t, and they count toward the team’s allowance', async () => {
  const no = await board(S.steam, 'Sneaky', S.vic);
  assert.equal(no.status, 403, 'a viewer can’t');
  // with an editor role in the project, a viewer can, from any of its boards
  await api('PUT', `/api/projects/${S.steam}/people/${S.vicId}`, { role: 'editor' }, S.ada);
  const vics = await board(S.trailer, 'Vic’s board', S.vic);
  assert.equal(vics.status, 200);
  assert.equal(vics.data.project.parentId, S.steam);
  assert.equal((await board(S.mood, 'Not here', S.vic)).status, 403, 'only in that project');
  await api('PUT', `/api/projects/${S.steam}/people/${S.vicId}`, { role: null }, S.ada);
  assert.equal((await api('DELETE', `/api/projects/${vics.data.project.id}`, undefined, S.ada)).status, 200);
  // and an editor who only views this project can't
  await api('PUT', `/api/projects/${S.steam}/people/${S.eddieId}`, { role: 'viewer' }, S.ada);
  const ed = await board(S.store, 'Nope', S.eddie);
  assert.equal(ed.status, 403);
  assert.match(ed.data.error, /in this project/);
  await api('PUT', `/api/projects/${S.steam}/people/${S.eddieId}`, { role: null }, S.ada);

  // projects and boards share one allowance
  const tiny = (await api('POST', '/api/teams', { name: 'Tiny' }, S.lead)).data.team.id;
  const first = (await api('POST', `/api/teams/${tiny}/projects`, { name: 'Jam game' }, S.lead)).data.project.id;
  for (let i = 1; i < LIMIT; i++) assert.equal((await board(first, 'Board ' + i, S.lead)).status, 200);
  const full = await board(first, 'One too many', S.lead);
  assert.equal(full.data.code, 'limit');
  assert.match(full.data.error, new RegExp(`up to ${LIMIT} projects and boards`));
  assert.equal((await api('POST', `/api/teams/${tiny}/projects`, { name: 'Another' }, S.lead)).data.code, 'limit');
  // deleting the team takes its boards with it
  assert.equal((await api('DELETE', `/api/teams/${tiny}`, undefined, S.lead)).status, 200);
  assert.equal(dbRows('SELECT id FROM projects WHERE team_id = ? OR parent_id = ?', tiny, first).length, 0);
});

test('boards: they follow the project’s people settings, set from the project or any of its boards', async () => {
  // Eddie views the project only: that counts on every board of it
  await api('PUT', `/api/projects/${S.steam}/people/${S.eddieId}`, { role: 'viewer' }, S.ada);
  assert.equal((await api('GET', `/api/projects/${S.store}`, undefined, S.eddie)).data.role, 'viewer');
  const rename = await api('PATCH', `/api/projects/${S.store}`, { name: 'Mine' }, S.eddie);
  assert.equal(rename.status, 403);
  assert.match(rename.data.error, /in this project/);
  assert.equal((await api('POST', `/api/projects/${S.store}/assets`, PNG, S.eddie, { 'Content-Type': 'image/png' })).status, 403);
  assert.equal((await api('GET', `/api/projects/${S.mood}`, undefined, S.eddie)).data.role, 'editor', 'other projects keep the team role');

  // the Team panel shows the project's settings on each board
  const forAdmin = (await api('GET', `/api/teams/${S.team}`, undefined, S.ada)).data.projects;
  for (const id of [S.steam, S.store, S.trailer]) assert.deepEqual(forAdmin.find(p => p.id === id).people, { [S.eddieId]: 'viewer' });
  assert.deepEqual(forAdmin.find(p => p.id === S.mood).people, {});
  const forEd = (await api('GET', `/api/teams/${S.team}`, undefined, S.eddie)).data.projects;
  assert.deepEqual([S.steam, S.store, S.trailer, S.mood].map(id => forEd.find(p => p.id === id).myRole), ['viewer', 'viewer', 'viewer', 'editor']);

  // live rooms use it on joining and on every batch
  const edStore = await joined(S.eddie, S.store);
  assert.equal(edStore.snapshot.role, 'viewer');
  edStore.send({ t: 'ops', batch: 1, ops: [{ k: 'items', op: 'put', obj: card('x1') }] });
  assert.equal((await edStore.next(m => m.t === 'error')).code, 'read_only');

  // set from a board, it's the project's setting
  const set = await api('PUT', `/api/projects/${S.trailer}/people/${S.vicId}`, { role: 'editor' }, S.ada);
  assert.deepEqual([set.status, set.data], [200, { role: 'editor', effective: 'editor' }]);
  assert.equal(dbRows('SELECT * FROM project_roles WHERE project_id IN (?, ?)', S.trailer, S.store).length, 0, 'nothing is kept against a board');
  assert.deepEqual(dbRows('SELECT role FROM project_roles WHERE project_id = ? AND user_id = ?', S.steam, S.vicId), [{ role: 'editor' }]);
  assert.equal((await api('GET', `/api/projects/${S.steam}`, undefined, S.vic)).data.role, 'editor');
  assert.equal((await api('GET', `/api/projects/${S.store}`, undefined, S.vic)).data.role, 'editor');
  await api('PUT', `/api/projects/${S.store}/people/${S.vicId}`, { role: null }, S.ada);
  assert.equal((await api('GET', `/api/projects/${S.trailer}`, undefined, S.vic)).data.role, 'viewer');

  // a change reaches every open board of the project at once, and nothing else
  const edRoot = await joined(S.eddie, S.steam), edTrailer = await joined(S.eddie, S.trailer), edMood = await joined(S.eddie, S.mood);
  const lead = await joined(S.lead, S.trailer);
  await api('PUT', `/api/projects/${S.store}/people/${S.eddieId}`, { role: null }, S.ada);
  for (const c of [edRoot, edStore, edTrailer]) assert.deepEqual(await c.next(m => m.t === 'role'), { t: 'role', role: 'editor', scope: 'project' });
  assert.equal((await lead.next(m => m.t === 'peer' && m.peer.uid === S.eddieId)).peer.role, 'editor');
  assert.ok(await edMood.none(m => m.t === 'role'), 'other projects are not touched');
  edTrailer.send({ t: 'ops', batch: 2, ops: [{ k: 'items', op: 'put', obj: card('x2') }] });
  assert.equal((await edTrailer.next(m => m.t === 'ack')).batch, 2);
  await api('PUT', `/api/projects/${S.steam}/people/${S.eddieId}`, { role: 'viewer' }, S.ada);
  for (const c of [edRoot, edStore, edTrailer]) assert.equal((await c.next(m => m.t === 'role')).role, 'viewer');
  edStore.send({ t: 'ops', batch: 3, ops: [{ k: 'items', op: 'put', obj: card('x3') }] });
  assert.equal((await edStore.next(m => m.t === 'error')).code, 'read_only');
  // a team role change goes through the project's setting on every board too
  await api('PATCH', `/api/teams/${S.team}/members/${S.eddieId}`, { role: 'admin' }, S.lead);
  for (const c of [edRoot, edStore, edTrailer, edMood]) assert.equal((await c.next(m => m.t === 'role')).role, 'admin');
  await api('PATCH', `/api/teams/${S.team}/members/${S.eddieId}`, { role: 'editor' }, S.lead);
  for (const c of [edRoot, edStore, edTrailer, edMood]) assert.equal((await c.next(m => m.t === 'role')).role, 'editor', 'made admin, the old setting was cleared');
  for (const c of [edRoot, edStore, edTrailer, edMood, lead]) c.close();
});

test('boards: the live snapshot says which project a board belongs to', async () => {
  const root = await joined(S.vic, S.steam), store = await joined(S.lead, S.store);
  assert.deepEqual(root.snapshot.project, { id: S.steam, name: 'Steam launch', teamId: S.team, parentId: null });
  assert.deepEqual(store.snapshot.project, { id: S.store, name: 'Store page', teamId: S.team, parentId: S.steam });
  // someone watching through a share link sees the board, not which project or team it's in
  const url = (await api('POST', `/api/projects/${S.store}/share`, undefined, S.ada)).data.url;
  const w = await socket({ t: 'watch', token: url.split('/v/')[1] });
  const snap = await w.next(m => m.t === 'snapshot');
  assert.deepEqual(snap.project, { id: S.store, name: 'Store page', teamId: '', parentId: null });
  for (const c of [root, store, w]) c.close();
});

test('boards: messages name a board with its project', async () => {
  await api('PATCH', `/api/teams/${S.team}/integrations`, { discordWebhook: 'https://discord.com/api/webhooks/1234567890/' + 'd'.repeat(40), discordEvents: ['done'] }, S.ada);
  posts.length = 0;
  const lead = await joined(S.lead, S.store);
  lead.send({ t: 'ops', batch: 1, ops: [{ k: 'items', op: 'put', obj: card('b1', { title: 'Store page capsule', status: 'done' }) }] });
  await lead.next(m => m.t === 'ack');
  await wait(150);
  assert.match(posts.pop().body.content, /finished “Store page capsule” in \*Steam launch · Store page\*/);
  // @mentions: the notification and the email
  lead.send({ t: 'ops', batch: 2, ops: [{ k: 'comments', op: 'put', obj: { id: 'c1', card: 'b1', text: 'Looks great @vic' } }] });
  await lead.next(m => m.t === 'ack');
  await wait(50);
  assert.equal((await api('GET', '/api/notifications', undefined, S.vic)).data.items[0].projectName, 'Steam launch · Store page');
  assert.match(mail.filter(m => m.to === 'vic@studio.test').pop().subject, /mentioned you in Steam launch · Store page$/);
  // and search
  const found = (await api('GET', '/api/search?q=capsule', undefined, S.vic)).data.results.find(r => r.cardId === 'b1');
  assert.deepEqual([found.projectId, found.project], [S.store, 'Steam launch · Store page']);
  lead.close();
});

test('boards: deleting one leaves the project and the others; deleting the project takes every board with it', async () => {
  const scratch = (await api('POST', `/api/teams/${S.team}/projects`, { name: 'Scratch' }, S.lead)).data.project.id;
  const a = (await board(scratch, 'A', S.lead)).data.project.id, b = (await board(scratch, 'B', S.lead)).data.project.id;
  const picA = (await api('POST', `/api/projects/${a}/assets`, PNG, S.lead, { 'Content-Type': 'image/png' })).data.id;
  const picB = (await api('POST', `/api/projects/${b}/assets`, PNG, S.lead, { 'Content-Type': 'image/png' })).data.id;
  await api('PUT', `/api/projects/${scratch}/people/${S.vicId}`, { role: 'editor' }, S.ada);
  const inRoot = await joined(S.lead, scratch), inA = await joined(S.eddie, a), inB = await joined(S.vic, b);

  // a board on its own: only admins, and only that board goes
  assert.equal((await api('DELETE', `/api/projects/${a}`, undefined, S.eddie)).status, 403);
  assert.equal((await api('DELETE', `/api/projects/${a}`, undefined, S.ada)).status, 200);
  assert.equal((await inA.next(m => m.t === 'deleted')).message, 'This board was deleted.');
  assert.ok(await inRoot.none(m => m.t === 'deleted') && await inB.none(m => m.t === 'deleted', 50), 'the project and its other board stay');
  assert.equal((await api('GET', `/api/projects/${a}`, undefined, S.lead)).status, 404);
  assert.deepEqual((await api('GET', `/api/projects/${b}/boards`, undefined, S.lead)).data.boards.map(x => x.id), [scratch, b]);
  assert.equal((await fetch(`${base}/assets/${picA}`)).status, 404);
  assert.equal((await fetch(`${base}/assets/${picB}`)).status, 200);
  await wait(100);
  assert.ok(!fs.existsSync(path.join(DATA, 'assets', picA)), 'its pictures go from the disk');

  // the project: every board goes, with its room, rows, pictures, search entries and people settings
  assert.equal((await api('DELETE', `/api/projects/${scratch}`, undefined, S.ada)).status, 200);
  assert.equal((await inRoot.next(m => m.t === 'deleted')).message, 'This project was deleted.');
  assert.equal((await inB.next(m => m.t === 'deleted')).message, 'This board was deleted.');
  for (const id of [scratch, b]) assert.equal((await api('GET', `/api/projects/${id}`, undefined, S.lead)).status, 404);
  assert.equal(dbRows('SELECT id FROM projects WHERE id IN (?, ?, ?) OR parent_id = ?', scratch, a, b, scratch).length, 0);
  assert.equal(dbRows('SELECT id FROM assets WHERE project_id IN (?, ?)', a, b).length, 0);
  assert.equal(dbRows('SELECT * FROM project_roles WHERE project_id = ?', scratch).length, 0);
  assert.equal(dbRows('SELECT * FROM card_search WHERE project_id IN (?, ?)', scratch, b).length, 0);
  await wait(100);
  assert.ok(!fs.existsSync(path.join(DATA, 'assets', picB)));
  assert.ok(!(await api('GET', `/api/teams/${S.team}`, undefined, S.lead)).data.projects.some(p => [scratch, a, b].includes(p.id)));
  // the rest of the team's projects are untouched
  assert.deepEqual((await api('GET', `/api/projects/${S.store}/boards`, undefined, S.lead)).data.boards.map(x => x.id), [S.steam, S.store, S.trailer, S.untitled]);
  for (const c of [inRoot, inA, inB]) c.close();
});

test('boards: MCP lists each board after its project with board_of, and create_project with board_of makes one', async () => {
  const tok = async u => (await api('POST', '/api/me/tokens', { name: 'Desk', password: 'correct horse' }, S[u])).data.token;
  const leadTok = await tok('lead'), vicTok = await tok('vic'), edTok = await tok('eddie');
  const listed = (await tool(leadTok, 'list_projects', {})).structuredContent.teams.find(t => t.team_id === S.team).projects;
  const at = listed.findIndex(p => p.project_id === S.steam);
  assert.deepEqual(listed.slice(at, at + 4).map(p => [p.project_id, p.board_of]), [[S.steam, undefined], [S.store, S.steam], [S.trailer, S.steam], [S.untitled, S.steam]],
    'the boards come right after their project, oldest first');
  assert.equal(listed.find(p => p.project_id === S.mood).board_of, undefined);

  // a new board from a tool, given the project or one of its boards
  const made = await tool(leadTok, 'create_project', { team_id: S.team, name: 'Audio', board_of: S.trailer });
  assert.equal(made.isError, undefined, JSON.stringify(made));
  assert.equal(made.structuredContent.board_of, S.steam);
  assert.deepEqual((await api('GET', `/api/projects/${S.steam}/boards`, undefined, S.lead)).data.boards.map(x => x.name).slice(-1), ['Audio']);
  const plain = await tool(leadTok, 'create_project', { team_id: S.team, name: 'Sequel' });
  assert.equal(plain.structuredContent.board_of, undefined, 'without board_of it is a new project');
  assert.equal((await api('GET', `/api/projects/${plain.structuredContent.project_id}`, undefined, S.lead)).data.project.parentId, null);
  // the same checks as the app: the project has to be in that team, and it takes an editor there
  assert.match((await tool(leadTok, 'create_project', { team_id: S.team, name: 'X', board_of: S.otherProject })).content[0].text, /not found/i);
  assert.equal((await tool(leadTok, 'create_project', { team_id: S.team, name: 'X', board_of: 'nope' })).isError, true);
  assert.equal((await tool(vicTok, 'create_project', { team_id: S.team, name: 'X', board_of: S.steam })).isError, true, 'a viewer can’t');

  // tools on a board use the project's people settings: made a viewer in Steam launch, Eddie only reads its boards
  const edList = (await tool(edTok, 'list_projects', {})).structuredContent.teams.find(t => t.team_id === S.team).projects;
  assert.equal(edList.find(p => p.project_id === S.store).your_role, 'editor');
  await api('PUT', `/api/projects/${S.steam}/people/${S.eddieId}`, { role: 'viewer' }, S.ada);
  const edList2 = (await tool(edTok, 'list_projects', {})).structuredContent.teams.find(t => t.team_id === S.team).projects;
  for (const id of [S.steam, S.store, S.trailer]) assert.deepEqual(['your_role', 'can_edit'].map(k => edList2.find(p => p.project_id === id)[k]), ['viewer', false]);
  const no = await tool(edTok, 'add_cards', { project_id: S.store, cards: [{ title: 'Sneaky' }] });
  assert.equal(no.isError, true);
  assert.match(no.content[0].text, /viewer in this project/);
  assert.equal((await tool(edTok, 'create_project', { team_id: S.team, name: 'X', board_of: S.store })).isError, true);
  assert.equal((await tool(edTok, 'add_cards', { project_id: S.mood, cards: [{ title: 'Fine here' }] })).isError, undefined);
});
