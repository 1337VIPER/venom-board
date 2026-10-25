// End-to-end tests for the team operations features: per-project roles (REST, live rooms, MCP tools), GitHub and
// GitLab webhooks (signatures, replays, size and rate limits, what they change on cards), card links, and Slack.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const Database = require('better-sqlite3');
const { start } = require('../src/index');
const { cardCodes, findCard, refHash, refsIn, closingRefs } = require('../src/gitlink');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'venom-board-teamops-'));
const APPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'venom-board-app-'));
fs.writeFileSync(path.join(APPDIR, 'index.html'), '<!doctype html><title>Venom Board</title>');
const mail = [], posts = [];
let srv, base, chatStatus = 204;
const fakeFetch = async (url, opts) => { posts.push({ url, body: JSON.parse(opts.body) }); return { ok: chatStatus < 300, status: chatStatus }; };
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
const S = {};
const USER = { lead: 'lead', ada: 'ada', ed: 'eddie', vic: 'vic', out: 'out' };  // usernames (at least 3 characters)

// MCP tools as a token holder
async function tool(token, name, args) {
  const r = await fetch(base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  return (await r.json()).result;
}
// a webhook delivery: GitHub signs the body with the secret, GitLab sends the secret as a token
const sign = (secret, body) => 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
async function deliver(url, payload, headers = {}) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload));
  const r = await fetch(url.replace('http://localhost:9', base), { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
  const text = await r.text();
  let data = null; try { data = JSON.parse(text); } catch (e) { data = text; }
  return { status: r.status, data };
}
const github = (url, secret, event, payload, extra = {}) => {
  const body = Buffer.from(JSON.stringify(payload));
  return deliver(url, body, { 'X-GitHub-Event': event, 'X-GitHub-Delivery': crypto.randomUUID(), ...(secret ? { 'X-Hub-Signature-256': sign(secret, body) } : {}), ...extra });
};
const gitlab = (url, secret, event, payload, extra = {}) => deliver(url, payload, { 'X-Gitlab-Event': event, 'X-Gitlab-Event-UUID': crypto.randomUUID(), ...(secret ? { 'X-Gitlab-Token': secret } : {}), ...extra });
const sha = () => crypto.randomBytes(20).toString('hex');
const doc = async (project, token = S.lead) => (await api('GET', `/api/projects/${project}`, undefined, token)).data.doc;
const refOf = async (project, cardId, token) => { const cards = (await doc(project, token)).items.filter(i => i.type === 'node'); for (const [code, c] of cardCodes(project, cards).byCode) if (c.id === cardId) return 'VB-' + code; return null; };
const dbRows = (sql, ...args) => { const d = new Database(path.join(DATA, 'venom-board.db'), { readonly: true }); try { return d.prepare(sql).all(...args); } finally { d.close(); } };

test.before(async () => {
  srv = await start({ PORT: '0', DATA_DIR: DATA, PUBLIC_URL: 'http://localhost:9', QUIET: 'true', MAIL_PER_10_MIN: '100000', RATE_SCALE: '50', MIN_FREE_DISK_MB: '0',
    DISCORD_DELAY_MS: '40', SEARCH_INDEX_DELAY_MS: '30', APP_DIR: APPDIR, MAIL_FROM: 'Venom Board <support@studio.test>' }, { mail: async m => { mail.push(m); return true; }, fetch: fakeFetch });
  base = `http://127.0.0.1:${srv.port}`;
  for (const u of ['lead', 'ada', 'ed', 'vic', 'out']) {
    const r = await api('POST', '/api/auth/signup', { email: u + '@studio.test', username: USER[u], password: 'correct horse', displayName: u[0].toUpperCase() + u.slice(1) });
    S[u] = r.data.token; S[u + 'Id'] = r.data.user.id;
    await api('POST', '/api/auth/verify', { token: linkFrom(u + '@studio.test', 'verify') });
  }
  S.team = (await api('POST', '/api/teams', { name: 'Night Keep' }, S.lead)).data.team.id;
  for (const [u, role] of [['ada', 'admin'], ['ed', 'editor'], ['vic', 'viewer']]) {
    await api('POST', `/api/teams/${S.team}/invites`, { who: USER[u], role }, S.lead);
    const inv = (await api('GET', '/api/me', undefined, S[u])).data.invites[0].id;
    await api('POST', `/api/invites/${inv}/accept`, undefined, S[u]);
  }
  const t0 = Date.now() - 100000;
  S.steam = (await api('POST', `/api/teams/${S.team}/projects`, { name: 'Steam launch', doc: { items: [
    card('s1', { title: 'Boss arena blockout', createdAt: t0 }), card('s2', { title: 'Store page capsule', createdAt: t0 + 1 }), card('s3', { title: 'Trailer cut', createdAt: t0 + 2 })] } }, S.lead)).data.project.id;
  S.mood = (await api('POST', `/api/teams/${S.team}/projects`, { name: 'Moodboard', doc: { items: [card('m1', { title: 'Swamp palette' })] } }, S.lead)).data.project.id;
  S.other = (await api('POST', '/api/teams', { name: 'Elsewhere' }, S.out)).data.team.id;
  S.otherProject = (await api('POST', `/api/teams/${S.other}/projects`, { name: 'Their game', doc: { items: [card('o1', { title: 'Not yours' })] } }, S.out)).data.project.id;
});
test.after(async () => { await srv.close(); for (const d of [DATA, APPDIR]) fs.rmSync(d, { recursive: true, force: true }); });

/* ---------- per-project roles ---------- */

test('project roles: only team admins set them, only for editors and viewers, only editor or viewer', async () => {
  const put = (project, userId, role, token) => api('PUT', `/api/projects/${project}/people/${userId}`, { role }, token);
  assert.equal((await put(S.steam, S.vicId, 'editor', S.ed)).status, 403, 'editors cannot');
  assert.equal((await put(S.steam, S.edId, 'viewer', S.vic)).status, 403, 'viewers cannot');
  assert.equal((await put(S.steam, S.edId, 'viewer', S.out)).status, 404, 'outsiders do not even see the project');
  assert.equal((await put(S.steam, S.adaId, 'viewer', S.lead)).data.code, 'admin', 'admins are never overridden');
  assert.equal((await put(S.steam, S.leadId, 'viewer', S.ada)).data.code, 'admin', 'nor is the leader');
  assert.equal((await put(S.steam, S.edId, 'admin', S.lead)).data.code, 'role', 'an override cannot make anyone an admin');
  assert.equal((await put(S.steam, S.edId, 'leader', S.lead)).data.code, 'role');
  assert.equal((await put(S.steam, S.outId, 'editor', S.lead)).status, 404, 'only people in the team');
  assert.equal((await put(S.steam, 'not an id!', 'editor', S.lead)).status, 404);
  const set = await put(S.steam, S.edId, 'viewer', S.ada);
  assert.equal(set.status, 200);
  assert.deepEqual(set.data, { role: 'viewer', effective: 'viewer' });
  assert.deepEqual((await put(S.mood, S.vicId, 'editor', S.ada)).data, { role: 'editor', effective: 'editor' });
});

test('project roles: every REST route uses the role in that project', async () => {
  // Ed is an editor in the team but views Steam launch only; Vic is a viewer who may edit Moodboard
  assert.equal((await api('GET', `/api/projects/${S.steam}`, undefined, S.ed)).data.role, 'viewer');
  assert.equal((await api('GET', `/api/projects/${S.mood}`, undefined, S.ed)).data.role, 'editor');
  assert.equal((await api('GET', `/api/projects/${S.mood}`, undefined, S.vic)).data.role, 'editor');
  assert.equal((await api('GET', `/api/projects/${S.steam}`, undefined, S.vic)).data.role, 'viewer');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const checks = [
    ['PATCH', p => `/api/projects/${p}`, { name: 'Renamed' }],
    ['POST', p => `/api/projects/${p}/versions`, { label: 'Mine' }],
    ['POST', p => `/api/projects/${p}/assets`, png],
    ['PUT', p => `/api/projects/${p}/preview`, png],
  ];
  for (const [method, url, body] of checks) {
    const no = await api(method, url(S.steam), body, S.ed, Buffer.isBuffer(body) ? { 'Content-Type': 'image/png' } : {});
    assert.equal(no.status, 403, `${method} ${url('p')} is refused to a viewer in this project`);
    assert.match(no.data.error, /in this project/);
    assert.equal((await api(method, url(S.steam), body, S.vic, Buffer.isBuffer(body) ? { 'Content-Type': 'image/png' } : {})).status, 403);
  }
  // in Moodboard, Vic can do what editors do
  assert.equal((await api('PATCH', `/api/projects/${S.mood}`, { name: 'Moodboard' }, S.vic)).status, 200);
  const v = await api('POST', `/api/projects/${S.mood}/versions`, { label: 'Vic was here' }, S.vic);
  assert.equal(v.status, 200);
  assert.equal((await api('POST', `/api/projects/${S.mood}/assets`, png, S.vic, { 'Content-Type': 'image/png' })).status, 200);
  assert.equal((await api('POST', `/api/projects/${S.mood}/versions/${v.data.version.id}/restore`, undefined, S.vic)).status, 200);
  assert.equal((await api('POST', `/api/projects/${S.steam}/versions/${v.data.version.id}/restore`, undefined, S.ed)).status, 403);
  // ...but never what admins do: share links, roadmaps, deleting versions or the project
  assert.equal((await api('POST', `/api/projects/${S.mood}/share`, undefined, S.vic)).status, 403);
  assert.equal((await api('POST', `/api/projects/${S.mood}/roadmap`, {}, S.vic)).status, 403);
  assert.equal((await api('DELETE', `/api/projects/${S.mood}/versions/${v.data.version.id}`, undefined, S.vic)).status, 403);
  assert.equal((await api('DELETE', `/api/projects/${S.mood}`, undefined, S.vic)).status, 403);
  // reading stays open to both: activity, versions, share link state, roadmap, search
  for (const p of [`/api/projects/${S.steam}/activity`, `/api/projects/${S.steam}/versions`, `/api/projects/${S.steam}/share`, `/api/projects/${S.steam}/roadmap`]) {
    assert.equal((await api('GET', p, undefined, S.ed)).status, 200, p);
  }
  await wait(80);
  assert.ok((await api('GET', '/api/search?q=boss', undefined, S.ed)).data.results.some(r => r.cardId === 's1'), 'a viewer in a project still finds its cards');
  assert.ok(!(await api('GET', '/api/search?q=boss', undefined, S.out)).data.results.length, 'nobody outside the team does');
});

test('project roles: the Team panel shows them (all of them to admins, your own to you)', async () => {
  const forAdmin = (await api('GET', `/api/teams/${S.team}`, undefined, S.ada)).data.projects;
  assert.deepEqual(forAdmin.find(p => p.id === S.steam).people, { [S.edId]: 'viewer' });
  assert.deepEqual(forAdmin.find(p => p.id === S.mood).people, { [S.vicId]: 'editor' });
  assert.equal(forAdmin.find(p => p.id === S.steam).myRole, 'admin');
  const forEd = (await api('GET', `/api/teams/${S.team}`, undefined, S.ed)).data.projects;
  assert.equal(forEd.find(p => p.id === S.steam).myRole, 'viewer');
  assert.equal(forEd.find(p => p.id === S.mood).myRole, 'editor');
  assert.ok(forEd.every(p => p.people === undefined), 'other people’s project roles are for admins');
  const forVic = (await api('GET', `/api/teams/${S.team}`, undefined, S.vic)).data.projects;
  assert.equal(forVic.find(p => p.id === S.mood).myRole, 'editor');
  assert.equal(forVic.find(p => p.id === S.steam).myRole, 'viewer');
});

test('project roles: live rooms check them on joining and on every batch, and a change reaches open boards at once', async () => {
  const lead = await joined(S.lead, S.steam);
  const ed = await joined(S.ed, S.steam), edMood = await joined(S.ed, S.mood);
  assert.equal(ed.snapshot.role, 'viewer', 'joining uses the role in this project');
  assert.equal(edMood.snapshot.role, 'editor');
  ed.send({ t: 'ops', batch: 1, ops: [{ k: 'items', op: 'put', obj: card('x1') }] });
  assert.equal((await ed.next(m => m.t === 'error')).code, 'read_only');
  // viewers in a project can still comment
  ed.send({ t: 'ops', batch: 2, ops: [{ k: 'comments', op: 'put', obj: { id: 'ec1', card: 's1', text: 'Looks good' } }] });
  assert.equal((await ed.next(m => m.t === 'ack')).batch, 2);
  assert.ok((await lead.next(m => m.t === 'ops' && m.ops[0].k === 'comments')).ops[0].obj.by === S.edId);

  // the override goes: Ed is an editor again, live, and the room hears it
  await api('PUT', `/api/projects/${S.steam}/people/${S.edId}`, { role: null }, S.ada);
  assert.deepEqual(await ed.next(m => m.t === 'role'), { t: 'role', role: 'editor', scope: 'project' });
  assert.equal((await lead.next(m => m.t === 'peer' && m.peer.uid === S.edId && m.peer.role === 'editor')).peer.role, 'editor');
  ed.send({ t: 'ops', batch: 3, ops: [{ k: 'items', op: 'put', obj: card('x2') }] });
  assert.equal((await ed.next(m => m.t === 'ack')).batch, 3);
  assert.ok(await edMood.none(m => m.t === 'role'), 'other projects are not touched');

  // presenting stops when they're made a viewer in the project, and their very next batch is refused
  ed.send({ t: 'presence', presenting: true });
  assert.equal((await lead.next(m => m.t === 'presence' && m.peer.uid === S.edId)).peer.presenting, true);
  assert.equal((await api('PUT', `/api/projects/${S.steam}/people/${S.edId}`, { role: 'viewer' }, S.ada)).status, 200);
  ed.send({ t: 'ops', batch: 4, ops: [{ k: 'items', op: 'put', obj: card('x3') }] });  // sent before reading the role message
  assert.equal((await ed.next(m => m.t === 'error')).code, 'read_only', 'the downgrade counts from the very next batch');
  assert.equal((await ed.next(m => m.t === 'role')).role, 'viewer');
  assert.equal((await lead.next(m => m.t === 'peer' && m.peer.uid === S.edId && m.peer.role === 'viewer')).peer.presenting, undefined);
  assert.ok(!(await doc(S.steam)).items.some(i => i.id === 'x3'), 'nothing from the refused batch was saved');
  ed.send({ t: 'preview', ops: [{ k: 'items', op: 'put', obj: card('x4') }] });
  assert.ok(await lead.none(m => m.t === 'preview'), 'nor are previews passed on');

  // a team role change keeps a project role: with an editor role in Moodboard, Ed made a team viewer can still edit it
  await api('PUT', `/api/projects/${S.mood}/people/${S.edId}`, { role: 'editor' }, S.ada);
  assert.ok(await edMood.none(m => m.t === 'role', 150), 'nothing to tell when their role there is the same');
  await api('PATCH', `/api/teams/${S.team}/members/${S.edId}`, { role: 'viewer' }, S.lead);
  assert.equal((await ed.next(m => m.t === 'role')).role, 'viewer', 'Steam launch hears the team change');
  assert.ok(await edMood.none(m => m.t === 'role'), 'Moodboard keeps their own role there');
  edMood.send({ t: 'ops', batch: 6, ops: [{ k: 'items', op: 'put', obj: card('x6') }] });
  assert.equal((await edMood.next(m => m.t === 'ack')).batch, 6, 'their own role in Moodboard still lets them edit');
  assert.equal((await api('GET', `/api/projects/${S.mood}`, undefined, S.ed)).data.role, 'editor');
  // taking it away there makes them a viewer straight away
  await api('PUT', `/api/projects/${S.mood}/people/${S.edId}`, { role: null }, S.ada);
  assert.deepEqual(await edMood.next(m => m.t === 'role'), { t: 'role', role: 'viewer', scope: 'project' });
  edMood.send({ t: 'ops', batch: 7, ops: [{ k: 'items', op: 'put', obj: card('x7') }] });
  assert.equal((await edMood.next(m => m.t === 'error')).code, 'read_only');
  // made a team admin, project roles stop applying (and are cleared, so they don't come back later)
  await api('PATCH', `/api/teams/${S.team}/members/${S.edId}`, { role: 'admin' }, S.lead);
  assert.equal((await ed.next(m => m.t === 'role')).role, 'admin');
  assert.equal(dbRows('SELECT * FROM project_roles WHERE user_id = ?', S.edId).length, 0);
  await api('PATCH', `/api/teams/${S.team}/members/${S.edId}`, { role: 'editor' }, S.lead);
  assert.equal((await ed.next(m => m.t === 'role')).role, 'editor');
  assert.equal((await api('GET', `/api/projects/${S.steam}`, undefined, S.ed)).data.role, 'editor');
  // back to the setup the other tests use
  await api('PUT', `/api/projects/${S.steam}/people/${S.edId}`, { role: 'viewer' }, S.ada);
  assert.equal((await ed.next(m => m.t === 'role')).role, 'viewer');
  // joining again uses it too
  const ed2 = await joined(S.ed, S.steam);
  assert.equal(ed2.snapshot.role, 'viewer');
  const vic = await joined(S.vic, S.mood);
  assert.equal(vic.snapshot.role, 'editor');
  vic.send({ t: 'ops', batch: 7, ops: [{ k: 'items', op: 'put', obj: card('v1', { title: 'Vic’s card' }) }] });
  assert.equal((await vic.next(m => m.t === 'ack')).batch, 7);
  for (const c of [lead, ed, edMood, ed2, vic]) c.close();
});

test('project roles: MCP tools use the role in each project', async () => {
  const edToken = (await api('POST', '/api/me/tokens', { name: 'Desk', password: 'correct horse' }, S.ed)).data.token;
  const vicToken = (await api('POST', '/api/me/tokens', { name: 'Desk', password: 'correct horse' }, S.vic)).data.token;
  const listed = (await tool(edToken, 'list_projects', {})).structuredContent.teams.find(t => t.team_id === S.team);
  assert.equal(listed.your_role, 'editor', 'the team role is still shown for the team');
  assert.deepEqual(['your_role', 'can_edit'].map(k => listed.projects.find(p => p.project_id === S.steam)[k]), ['viewer', false]);
  assert.deepEqual(['your_role', 'can_edit'].map(k => listed.projects.find(p => p.project_id === S.mood)[k]), ['editor', true]);
  const vicList = (await tool(vicToken, 'list_projects', {})).structuredContent.teams.find(t => t.team_id === S.team);
  assert.deepEqual(['your_role', 'can_edit'].map(k => vicList.projects.find(p => p.project_id === S.mood)[k]), ['editor', true]);

  const no = await tool(edToken, 'add_cards', { project_id: S.steam, cards: [{ title: 'Sneaky' }] });
  assert.equal(no.isError, true);
  assert.match(no.content[0].text, /viewer in this project/);
  assert.equal((await tool(edToken, 'update_cards', { project_id: S.steam, cards: [{ id: 's1', status: 'done' }] })).isError, true);
  assert.equal((await tool(edToken, 'save_version', { project_id: S.steam, label: 'x' })).isError, true);
  assert.equal((await tool(edToken, 'get_board', { project_id: S.steam })).structuredContent.your_role, 'viewer');
  assert.equal((await tool(edToken, 'add_comment', { project_id: S.steam, card_id: 's1', text: 'Reads fine' })).isError, undefined, 'viewers can comment');
  assert.equal((await tool(edToken, 'add_cards', { project_id: S.mood, cards: [{ title: 'Fine here' }] })).isError, undefined);
  assert.equal((await tool(vicToken, 'add_cards', { project_id: S.mood, cards: [{ title: 'Vic via a tool' }] })).isError, undefined, 'a viewer with an editor role here can');
  assert.equal((await tool(vicToken, 'add_cards', { project_id: S.steam, cards: [{ title: 'No' }] })).isError, true);
  assert.ok(!(await doc(S.steam)).items.some(i => i.title === 'Sneaky' || i.title === 'No'));
  assert.ok((await doc(S.mood)).items.some(i => i.title === 'Vic via a tool'));
});

test('project roles: leaving the team or deleting the project removes them', async () => {
  const extra = (await api('POST', `/api/teams/${S.team}/projects`, { name: 'Scratch' }, S.lead)).data.project.id;
  await api('PUT', `/api/projects/${extra}/people/${S.vicId}`, { role: 'editor' }, S.ada);
  await api('PUT', `/api/projects/${extra}/people/${S.edId}`, { role: 'viewer' }, S.ada);
  assert.equal(dbRows('SELECT * FROM project_roles WHERE project_id = ?', extra).length, 2);
  assert.equal((await api('DELETE', `/api/projects/${extra}`, undefined, S.ada)).status, 200);
  assert.equal(dbRows('SELECT * FROM project_roles WHERE project_id = ?', extra).length, 0, 'deleting the project removes them');
  // Vic is removed from the team and invited back: Moodboard is view-only again
  const vic = await joined(S.vic, S.mood);
  assert.equal(vic.snapshot.role, 'editor');
  assert.equal((await api('DELETE', `/api/teams/${S.team}/members/${S.vicId}`, undefined, S.ada)).status, 200);
  assert.equal((await vic.next(m => m.t === 'kicked')).t, 'kicked');
  assert.equal(dbRows('SELECT * FROM project_roles WHERE user_id = ?', S.vicId).length, 0, 'removing them from the team removes them');
  await api('POST', `/api/teams/${S.team}/invites`, { who: 'vic', role: 'viewer' }, S.lead);
  await api('POST', `/api/invites/${(await api('GET', '/api/me', undefined, S.vic)).data.invites[0].id}/accept`, undefined, S.vic);
  assert.equal((await api('GET', `/api/projects/${S.mood}`, undefined, S.vic)).data.role, 'viewer');
  vic.close();
});

/* ---------- GitHub and GitLab ---------- */

test('card references: one per card in a project, from the ids, the same for app-made and server-made ids', () => {
  const ids = ['s1', 'k3j2h1a9x8abc', 'Zx9_-Qp0aB1c', 'a'.repeat(64)];
  const { byCode, full } = cardCodes('proj', ids.map(id => ({ id })));
  assert.equal(byCode.size, ids.length);
  for (const [code] of byCode) assert.match(code, /^[0-9A-HJKMNP-TV-Z]{8}$/);
  assert.notEqual(cardCodes('other', [{ id: 's1' }]).full.get('s1'), full.get('s1'), 'the same card id in another project has another reference');
  assert.equal(refHash('proj/s1'), refHash('proj/s1'));
  // two cards whose first eight characters match: the older keeps its reference, the newer gets a longer one
  const fake = s => (s.endsWith('/old') ? 'ABCDEFGH1234' : s.endsWith('/new') ? 'ABCDEFGH5678' : refHash(s));
  const clash = cardCodes('p', [{ id: 'new', createdAt: 2e12 }, { id: 'old', createdAt: 1.9e12 }], fake);
  assert.equal(clash.byCode.get('ABCDEFGH').id, 'old');
  assert.equal(clash.byCode.get('ABCDEFGH5').id, 'new');
  const cards = [{ id: 'new', createdAt: 2e12 }];
  assert.equal(findCard(cardCodes('p', cards, fake), cards, 'ABCDEFGH5').id, 'new', 'a longer reference still works once the older card is gone');
  // what's read from commit messages
  assert.deepEqual(refsIn('Arena polish, see vb-7k2qx9md and VB-7K2QX9MD, not VB-123 or XVB-7K2QX9MD'), ['7K2QX9MD']);
  assert.deepEqual([...closingRefs('Fixes VB-AAAAAAAA, VB-BBBBBBBB and VB-CCCCCCCC. Mentions VB-DDDDDDDD. resolves: vb-eeeeeeee')], ['AAAAAAAA', 'BBBBBBBB', 'CCCCCCCC', 'EEEEEEEE']);
  assert.deepEqual([...closingRefs('prefix VB-AAAAAAAA fixes nothing')], []);
});

test('github: setup is for admins, the secret is never in the team details, and needs a signature', async () => {
  assert.equal((await api('POST', `/api/teams/${S.team}/git`, undefined, S.ed)).status, 403, 'editors cannot');
  const made = await api('POST', `/api/teams/${S.team}/git`, undefined, S.ada);
  assert.equal(made.status, 200);
  S.git = made.data.git; S.secret = made.data.secret;
  assert.match(S.secret, /^[0-9a-f]{48}$/);
  assert.match(S.git.github, /^http:\/\/localhost:9\/api\/hooks\/github\/[\w-]{20,}$/);
  assert.equal(S.git.gitlab, S.git.github.replace('/github/', '/gitlab/'));
  const detail = await api('GET', `/api/teams/${S.team}`, undefined, S.ada);
  assert.equal(detail.data.integrations.git.connected, true);
  assert.ok(!JSON.stringify(detail.data).includes(S.secret), 'the secret is not in the team details');
  assert.equal(detail.data.integrations.git.hint, '…' + S.secret.slice(-4));
  assert.equal((await api('GET', `/api/teams/${S.team}`, undefined, S.ed)).data.integrations, undefined);
  assert.equal((await api('GET', `/api/teams/${S.team}/git/secret`, undefined, S.ed)).status, 403);
  assert.equal((await api('GET', `/api/teams/${S.team}/git/secret`, undefined, S.ada)).data.secret, S.secret);

  const push = { ref: 'refs/heads/main', repository: { full_name: 'nightkeep/game', html_url: 'https://github.com/nightkeep/game', default_branch: 'main' }, commits: [] };
  // nothing unsigned or wrongly signed gets in
  assert.equal((await github(S.git.github, null, 'push', push)).status, 401, 'unsigned');
  assert.equal((await github(S.git.github, 'wrong secret', 'push', push)).status, 401, 'wrong secret');
  assert.equal((await github(S.git.github, null, 'push', push, { 'X-Hub-Signature-256': 'sha256=' + 'z'.repeat(64) })).status, 401, 'malformed');
  assert.equal((await github(S.git.github, null, 'push', push, { 'X-Hub-Signature-256': 'sha256=' })).status, 401, 'empty');
  const body = Buffer.from(JSON.stringify(push));
  const sha1 = 'sha1=' + crypto.createHmac('sha1', S.secret).update(body).digest('hex');
  assert.equal((await deliver(S.git.github, body, { 'X-GitHub-Event': 'push', 'X-Hub-Signature': sha1 })).status, 401, 'the old SHA-1 signature alone is not enough');
  // a signature for one body doesn't cover another
  const signedOther = sign(S.secret, Buffer.from(JSON.stringify({ ...push, ref: 'refs/heads/dev' })));
  assert.equal((await deliver(S.git.github, body, { 'X-GitHub-Event': 'push', 'X-Hub-Signature-256': signedOther })).status, 401);
  // GitLab's token
  assert.equal((await gitlab(S.git.gitlab, null, 'Push Hook', {})).status, 401, 'no token');
  assert.equal((await gitlab(S.git.gitlab, 'wrong', 'Push Hook', {})).status, 401, 'wrong token');
  assert.equal((await gitlab(S.git.gitlab, S.secret + 'x', 'Push Hook', {})).status, 401, 'almost right');
  // a GitHub signature at the GitLab address, and the GitLab token at the GitHub address, don't count
  assert.equal((await deliver(S.git.gitlab, body, { 'X-Gitlab-Event': 'Push Hook', 'X-Hub-Signature-256': sign(S.secret, body) })).status, 401);
  assert.equal((await deliver(S.git.github, body, { 'X-GitHub-Event': 'push', 'X-Gitlab-Token': S.secret })).status, 401);
  // unknown addresses, and big bodies
  assert.equal((await github(S.git.github.replace(/[\w-]+$/, 'x'.repeat(24)), S.secret, 'push', push)).status, 404);
  const huge = Buffer.from(JSON.stringify({ ...push, padding: 'x'.repeat(1100000) }));
  assert.equal((await deliver(S.git.github, huge, { 'X-GitHub-Event': 'push', 'X-Hub-Signature-256': sign(S.secret, huge) })).status, 413, 'bodies are limited in size');
  // a signed body that isn't JSON
  const junk = Buffer.from('not json');
  assert.equal((await deliver(S.git.github, junk, { 'X-GitHub-Event': 'push', 'X-Hub-Signature-256': sign(S.secret, junk) })).status, 400);
  // the ping GitHub sends when the webhook is made lists the repository for admins
  const ping = await github(S.git.github, S.secret, 'ping', { zen: 'Keep it logically awesome.', repository: push.repository });
  assert.deepEqual([ping.status, ping.data.ignored], [200, 'ping']);
  assert.deepEqual((await api('GET', `/api/teams/${S.team}`, undefined, S.ada)).data.integrations.git.repos.map(r => [r.provider, r.repo]), [['github', 'nightkeep/game']]);
});

test('github: commits and pull requests comment on cards, link them and mark them done, once', async () => {
  // Discord and Slack hear about cards finished
  await api('PATCH', `/api/teams/${S.team}/integrations`, { discordWebhook: 'https://discord.com/api/webhooks/1234567890/' + 'd'.repeat(40), discordEvents: ['done'] }, S.ada);
  await api('PATCH', `/api/teams/${S.team}/integrations/slack`, { slackWebhook: 'https://hooks.slack.com/services/T0123ABCD/B0123ABCD/' + 's'.repeat(24), slackEvents: ['done'] }, S.ada);
  posts.length = 0;
  const repo = { full_name: 'nightkeep/game', html_url: 'https://github.com/nightkeep/game', default_branch: 'main' };
  const r1 = await refOf(S.steam, 's1'), r2 = await refOf(S.steam, 's2'), r3 = await refOf(S.steam, 's3');
  assert.match(r1, /^VB-[0-9A-Z]{8}$/);
  const lead = await joined(S.lead, S.steam);
  const commit = (message, id = sha(), who = 'ada-codes') => ({ id, message, url: `https://github.com/nightkeep/game/commit/${id}`, author: { name: 'Ada L', username: who } });

  // a commit on a branch mentioning a card: a comment with who, what and a link; nothing marked done
  const c1 = commit(`Block out the arena (fixes ${r1})\n\nLonger description that isn't shown. @lead`);
  const feature = await github(S.git.github, S.secret, 'push', { ref: 'refs/heads/arena', repository: repo, commits: [c1] });
  assert.deepEqual([feature.status, feature.data.comments, feature.data.done], [200, 1, 0]);
  const live1 = await lead.next(m => m.t === 'ops' && m.ops.some(o => o.k === 'comments'));
  const cm = live1.ops.find(o => o.k === 'comments').obj;
  assert.equal(cm.by, 'vb-github'); assert.equal(cm.card, 's1');
  assert.equal(cm.text, `ada-codes committed “Block out the arena (fixes ${r1})” (${c1.id.slice(0, 7)}) to nightkeep/game on arena.\n${c1.url}`);
  assert.equal((await doc(S.steam)).items.find(i => i.id === 's1').status, 'todo', 'fixes on a branch does not finish it');
  assert.ok(!(await api('GET', '/api/notifications', undefined, S.lead)).data.items.some(n => n.kind === 'mention'), 'commit messages cannot mention anyone');
  const act = (await api('GET', `/api/projects/${S.steam}/activity`, undefined, S.lead)).data.items[0];
  assert.deepEqual([act.name, act.kind, act.cardId], ['GitHub', 'comment', 's1'], 'it shows in the activity feed as GitHub');

  // the same commit reaching main finishes the card (and says so once)
  const onMain = await github(S.git.github, S.secret, 'push', { ref: 'refs/heads/main', repository: repo, commits: [c1, commit('Unrelated tidy-up')] });
  assert.deepEqual([onMain.data.comments, onMain.data.done], [1, 1]);
  const s1 = (await doc(S.steam)).items.find(i => i.id === 's1');
  assert.equal(s1.status, 'done'); assert.ok(s1.doneAt > Date.now() - 10000);
  assert.match((await doc(S.steam)).comments.filter(c => c.card === 's1').pop().text, /reached main in nightkeep\/game, which marks this card done/);
  await wait(150);
  const discord = posts.find(p => p.url.includes('discord.com')), slack = posts.find(p => p.url.includes('hooks.slack.com'));
  assert.match(discord.body.content, /\*\*GitHub\*\* finished “Boss arena blockout” in \*Steam launch\*/);
  assert.match(slack.body.text, /^\*GitHub\* finished “Boss arena blockout” in _Steam launch_$/m);
  // the same push delivered again changes nothing
  const again = await github(S.git.github, S.secret, 'push', { ref: 'refs/heads/main', repository: repo, commits: [c1] });
  assert.deepEqual([again.data.comments, again.data.done], [0, 0]);

  // a pull request: linked on the card and commented on; merged, it finishes the card
  const pr = { number: 12, title: 'Store page capsule art', body: `Implements ${r2.toLowerCase()}`, html_url: 'https://github.com/nightkeep/game/pull/12', merged: false, user: { login: 'ada-codes' }, head: { ref: 'capsule' } };
  const opened = await github(S.git.github, S.secret, 'pull_request', { action: 'opened', pull_request: pr, repository: repo, sender: { login: 'ada-codes' } });
  assert.deepEqual([opened.data.comments, opened.data.done], [1, 0]);
  let s2 = (await doc(S.steam)).items.find(i => i.id === 's2');
  assert.deepEqual(s2.gitLinks, [pr.html_url]);
  assert.equal(s2.status, 'todo');
  assert.equal((await doc(S.steam)).comments.filter(c => c.card === 's2').pop().text, `ada-codes linked this card to pull request #12 “Store page capsule art” in nightkeep/game.\n${pr.html_url}`);
  const edited = await github(S.git.github, S.secret, 'pull_request', { action: 'edited', pull_request: pr, repository: repo, sender: { login: 'ada-codes' } });
  assert.equal(edited.data.comments, 0, 'edits do not repeat it');
  const synced = await github(S.git.github, S.secret, 'pull_request', { action: 'synchronize', pull_request: pr, repository: repo, sender: { login: 'ada-codes' } });
  assert.equal(synced.data.comments, 0);
  // closed without merging: nothing
  const closed = await github(S.git.github, S.secret, 'pull_request', { action: 'closed', pull_request: pr, repository: repo, sender: { login: 'ada-codes' } });
  assert.deepEqual([closed.data.comments, closed.data.done], [0, 0]);
  const merged = await github(S.git.github, S.secret, 'pull_request', { action: 'closed', pull_request: { ...pr, merged: true }, repository: repo, sender: { login: 'lead-dev' } });
  assert.deepEqual([merged.data.comments, merged.data.done], [1, 1]);
  s2 = (await doc(S.steam)).items.find(i => i.id === 's2');
  assert.equal(s2.status, 'done');
  assert.deepEqual(s2.gitLinks, [pr.html_url], 'listed once');
  assert.match((await doc(S.steam)).comments.filter(c => c.card === 's2').pop().text, /^lead-dev merged pull request #12 .* which marks this card done\./);
  const remerged = await github(S.git.github, S.secret, 'pull_request', { action: 'closed', pull_request: { ...pr, merged: true }, repository: repo, sender: { login: 'lead-dev' } });
  assert.deepEqual([remerged.data.comments, remerged.data.done], [0, 0]);

  // the reference can be in a branch name, and only cards in this team are ever touched
  const branchPr = { ...pr, number: 13, title: 'Trailer', body: '', html_url: 'https://github.com/nightkeep/game/pull/13', head: { ref: `feature/${r3.toLowerCase()}-trailer` } };
  assert.equal((await github(S.git.github, S.secret, 'pull_request', { action: 'opened', pull_request: branchPr, repository: repo })).data.comments, 1);
  const theirs = await refOf(S.otherProject, 'o1', S.out);
  const outside = await github(S.git.github, S.secret, 'push', { ref: 'refs/heads/main', repository: repo, commits: [commit(`Fixes ${theirs} and VB-00000000`)] });
  assert.deepEqual([outside.data.comments, outside.data.done], [0, 0]);
  assert.equal((await doc(S.otherProject, S.out)).items[0].status, 'todo');
  lead.close();
});

test('github: a delivery for another team, or one sent again, changes nothing', async () => {
  // the other team connects its own repository
  const theirs = await api('POST', `/api/teams/${S.other}/git`, undefined, S.out);
  assert.notEqual(theirs.data.secret, S.secret);
  assert.notEqual(theirs.data.git.github, S.git.github);
  const repo = { full_name: 'elsewhere/game', html_url: 'https://github.com/elsewhere/game', default_branch: 'main' };
  const target = await refOf(S.steam, 's3');
  const id = sha();
  const payload = { ref: 'refs/heads/main', repository: repo, commits: [{ id, message: `Fixes ${target}`, url: `https://github.com/elsewhere/game/commit/${id}`, author: { name: 'Out' } }] };
  const body = Buffer.from(JSON.stringify(payload)), headers = { 'X-GitHub-Event': 'push', 'X-GitHub-Delivery': crypto.randomUUID(), 'X-Hub-Signature-256': sign(theirs.data.secret, body) };
  // properly signed for their webhook: it only reaches their own projects, where the card isn't
  assert.deepEqual((await deliver(theirs.data.git.github, body, headers)).data, { ok: true, comments: 0, done: 0 });
  // the same signed delivery replayed at our address is refused
  assert.equal((await deliver(S.git.github, body, headers)).status, 401);
  assert.equal((await doc(S.steam)).items.find(i => i.id === 's3').status, 'todo');
  // and a real delivery of ours sent twice (same delivery id) only counts once
  const mine = Buffer.from(JSON.stringify({ ...payload, repository: { full_name: 'nightkeep/game', default_branch: 'main' }, commits: [{ ...payload.commits[0], id: sha(), message: `Mentions ${target}` }] }));
  const h = { 'X-GitHub-Event': 'push', 'X-GitHub-Delivery': crypto.randomUUID(), 'X-Hub-Signature-256': sign(S.secret, mine) };
  assert.equal((await deliver(S.git.github, mine, h)).data.comments, 1);
  assert.deepEqual((await deliver(S.git.github, mine, h)).data, { ok: true, duplicate: true });
  // a new secret: the old one stops working at once, the address stays the same
  const rotated = await api('POST', `/api/teams/${S.team}/git`, undefined, S.ada);
  assert.equal(rotated.data.git.github, S.git.github);
  const stale = await github(S.git.github, S.secret, 'ping', { repository: repo });
  assert.equal(stale.status, 401);
  S.secret = rotated.data.secret;
  // the new secret also cleared what was remembered about earlier deliveries, which is safe: they can't pass the check any more
  assert.equal((await deliver(S.git.github, mine, h)).status, 401);
  assert.equal((await github(S.git.github, S.secret, 'ping', { repository: { full_name: 'nightkeep/game' } })).status, 200);
  // turned off: the address is gone
  assert.equal((await api('DELETE', `/api/teams/${S.other}/git`, undefined, S.ed)).status, 404, 'not their team');
  assert.equal((await api('DELETE', `/api/teams/${S.other}/git`, undefined, S.out)).status, 200);
  assert.equal((await deliver(theirs.data.git.github, body, { ...headers, 'X-GitHub-Delivery': crypto.randomUUID() })).status, 404);
});

test('gitlab: pushes and merge requests, with the secret token', async () => {
  const project = { path_with_namespace: 'nightkeep/tools', web_url: 'https://gitlab.com/nightkeep/tools', default_branch: 'main' };
  const ref = await refOf(S.mood, 'm1');
  const lead = await joined(S.lead, S.mood);
  const id = sha();
  const push = await gitlab(S.git.gitlab, S.secret, 'Push Hook', { object_kind: 'push', ref: 'refs/heads/main', user_username: 'ada', project,
    commits: [{ id, message: `Closes ${ref}: swamp palette done`, url: `https://gitlab.com/nightkeep/tools/-/commit/${id}`, author: { name: 'Ada L' } }] });
  assert.deepEqual([push.status, push.data.comments, push.data.done], [200, 1, 1]);
  const ops = (await lead.next(m => m.t === 'ops' && m.ops.some(o => o.k === 'comments'))).ops;
  assert.equal(ops.find(o => o.k === 'comments').obj.by, 'vb-gitlab');
  assert.equal(ops.find(o => o.k === 'items').obj.status, 'done');
  assert.equal((await api('GET', `/api/projects/${S.mood}/activity`, undefined, S.lead)).data.items.find(a => a.kind === 'done').name, 'GitLab');
  // a merge request: opened links and comments; merged finishes (the card is reopened first)
  const reopened = { ...(await doc(S.mood)).items.find(i => i.id === 'm1'), status: 'doing' };
  lead.send({ t: 'ops', batch: 1, ops: [{ k: 'items', op: 'put', obj: reopened }] });
  await lead.next(m => m.t === 'ack');
  const mr = { iid: 7, title: `Palette tweaks ${ref}`, description: '', url: 'https://gitlab.com/nightkeep/tools/-/merge_requests/7', source_branch: 'palette', action: 'open' };
  const open = await gitlab(S.git.gitlab, S.secret, 'Merge Request Hook', { object_kind: 'merge_request', user: { username: 'ada', name: 'Ada L' }, project, object_attributes: mr });
  assert.deepEqual([open.data.comments, open.data.done], [1, 0]);
  assert.match((await doc(S.mood)).comments.pop().text, /^ada linked this card to merge request !7 “Palette tweaks/);
  const merge = await gitlab(S.git.gitlab, S.secret, 'Merge Request Hook', { object_kind: 'merge_request', user: { username: 'ada' }, project, object_attributes: { ...mr, action: 'merge', state: 'merged' } });
  assert.deepEqual([merge.data.comments, merge.data.done], [1, 1]);
  const m1 = (await doc(S.mood)).items.find(i => i.id === 'm1');
  assert.equal(m1.status, 'done');
  assert.deepEqual(m1.gitLinks, [mr.url]);
  // other events are accepted and ignored
  assert.deepEqual((await gitlab(S.git.gitlab, S.secret, 'Pipeline Hook', { project })).data, { ok: true, ignored: 'Pipeline Hook' });
  assert.deepEqual((await api('GET', `/api/teams/${S.team}`, undefined, S.ada)).data.integrations.git.repos.map(r => r.provider + ':' + r.repo).sort(), ['github:nightkeep/game', 'gitlab:nightkeep/tools']);
  lead.close();
});

test('card links: only https links to github.com or gitlab.com, ten at most, from anyone', async () => {
  const ed = await joined(S.ed, S.mood);
  const good = ['https://github.com/nightkeep/game/pull/1', 'https://gitlab.com/nightkeep/tools/-/issues/3', 'https://github.com/nightkeep/game/issues/2#issuecomment-99'];
  const bad = ['javascript:alert(1)', 'http://github.com/a/b/pull/1', 'https://github.com.evil.test/a', 'https://evil.test/github.com/a', 'https://github.com@evil.test/a',
    'https://github.com/a/b?x=1', 'https://github.com/a/b"onmouseover="x', 'https://github.com/a/../../b', 'https://gitlab.example.com/a/b', 42, null, { href: 'https://github.com/a' }];
  const many = Array.from({ length: 14 }, (_, i) => `https://github.com/nightkeep/game/pull/${100 + i}`);
  ed.send({ t: 'ops', batch: 1, ops: [{ k: 'items', op: 'put', obj: card('gl1', { gitLinks: [...good, ...bad, good[0]] }) }, { k: 'items', op: 'put', obj: card('gl2', { gitLinks: many }) },
    { k: 'items', op: 'put', obj: card('gl3', { gitLinks: 'https://github.com/a/b/pull/1' }) }] });
  await ed.next(m => m.t === 'ack');
  const items = (await doc(S.mood)).items;
  assert.deepEqual(items.find(i => i.id === 'gl1').gitLinks, good);
  assert.deepEqual(items.find(i => i.id === 'gl2').gitLinks, many.slice(0, 10));
  assert.equal(items.find(i => i.id === 'gl3').gitLinks, undefined);
  ed.close();
});

/* ---------- Slack ---------- */

test('slack: only real webhook links, admins only, never shown back, a test message', async () => {
  const set = (body, token) => api('PATCH', `/api/teams/${S.team}/integrations/slack`, body, token);
  for (const u of ['https://hooks.slack.com.evil.test/services/T0123ABCD/B0123ABCD/xxxxxxxxxxxxxxxxxxxxxxxx', 'http://hooks.slack.com/services/T0123ABCD/B0123ABCD/xxxxxxxxxxxxxxxxxxxxxxxx',
    'https://evil.test/hooks.slack.com/services/T0123ABCD/B0123ABCD/xxxxxxxxxxxxxxxxxxxxxxxx', 'https://hooks.slack.com/workflows/T0123ABCD/x', 'https://discord.com/api/webhooks/1234567890/' + 'x'.repeat(40)]) {
    assert.equal((await set({ slackWebhook: u }, S.ada)).data.code, 'webhook', u);
  }
  const hook = 'https://hooks.slack.com/services/T0123ABCD/B4567EFGH/' + 'abcDEF123456'.repeat(2);
  assert.equal((await set({ slackWebhook: hook }, S.ed)).status, 403, 'editors cannot');
  const ok = await set({ slackWebhook: hook, slackEvents: ['done', 'comment', 'joined', 'nonsense'] }, S.ada);
  assert.deepEqual(ok.data.slack, { connected: true, hint: '…' + hook.slice(-6), events: ['done', 'comment', 'joined'] });
  const detail = await api('GET', `/api/teams/${S.team}`, undefined, S.ada);
  assert.equal(detail.data.integrations.slack.connected, true);
  assert.ok(!JSON.stringify(detail.data).includes(hook), 'the webhook is never shown back in full');
  assert.equal((await api('POST', `/api/teams/${S.team}/integrations/slack/test`, undefined, S.ed)).status, 403);
  posts.length = 0;
  assert.equal((await api('POST', `/api/teams/${S.team}/integrations/slack/test`, undefined, S.ada)).status, 200);
  assert.equal(posts[0].url, hook);
  assert.match(posts[0].body.text, /Venom Board is connected\. Updates from _Night Keep_ will appear here\./);
  assert.deepEqual([posts[0].body.mrkdwn, posts[0].body.unfurl_links], [true, false]);
});

test('slack: chosen events, gathered into one message, with what people typed escaped', async () => {
  const hook = 'https://hooks.slack.com/services/T0123ABCD/B4567EFGH/' + 'abcDEF123456'.repeat(2);
  await api('PATCH', `/api/teams/${S.team}/integrations/slack`, { slackEvents: ['done', 'joined'] }, S.ada);
  await wait(100);  // anything earlier tests queued has gone out
  posts.length = 0;
  const ed = await joined(S.ed, S.mood);
  const nasty = '<!channel> *free* _stuff_ ~now~ `code` & <https://evil.test|click>';
  ed.send({ t: 'ops', batch: 1, ops: [{ k: 'items', op: 'put', obj: card('sl1', { title: nasty }) }, { k: 'items', op: 'put', obj: card('sl2', { title: 'Plain one' }) }] });
  await ed.next(m => m.t === 'ack');
  ed.send({ t: 'ops', batch: 2, ops: [{ k: 'items', op: 'put', obj: card('sl1', { title: nasty, status: 'done' }) }, { k: 'items', op: 'put', obj: card('sl2', { title: 'Plain one', status: 'done' }) }] });
  await ed.next(m => m.t === 'ack');
  ed.send({ t: 'ops', batch: 3, ops: [{ k: 'comments', op: 'put', obj: { id: 'slc', card: 'sl2', text: 'comments are not chosen' } }] });
  await ed.next(m => m.t === 'ack');
  await wait(150);
  const out = posts.filter(p => p.url === hook);
  assert.equal(out.length, 1, 'one message for the burst');
  const text = out[0].body.text;
  assert.equal(text.split('\n').length, 2, 'two finished cards, no comment: ' + text);
  assert.ok(!/<!channel>|<https?:/.test(text), 'no channel pings or links from card titles');
  assert.match(text, /&lt;!channel&gt;/);
  assert.match(text, /&amp;/);
  assert.ok(!/\*free\*|_stuff_|~now~|`code`/.test(text), 'formatting characters people typed are neutralised');
  assert.match(text, /^\*Ed\* finished “.*” in _Moodboard_$/m);
  // joining the team
  posts.length = 0;
  await api('POST', `/api/teams/${S.team}/invites`, { who: 'out', role: 'viewer' }, S.lead);
  await api('POST', `/api/invites/${(await api('GET', '/api/me', undefined, S.out)).data.invites[0].id}/accept`, undefined, S.out);
  await wait(150);
  assert.match(posts.find(p => p.url === hook).body.text, /^\*Out\* joined the team$/);
  ed.close();
});

test('slack: a webhook Slack says is gone stops being used', async () => {
  const ed = await joined(S.ed, S.mood);
  chatStatus = 404;
  ed.send({ t: 'ops', batch: 1, ops: [{ k: 'items', op: 'put', obj: card('sl3') }] });
  await ed.next(m => m.t === 'ack');
  ed.send({ t: 'ops', batch: 2, ops: [{ k: 'items', op: 'put', obj: card('sl3', { status: 'done' }) }] });
  await ed.next(m => m.t === 'ack');
  await wait(150);
  chatStatus = 204;
  assert.equal((await api('GET', `/api/teams/${S.team}`, undefined, S.ada)).data.integrations.slack.connected, false);
  ed.close();
});

/* ---------- rate limits, on a server with the real limits ---------- */

test('webhooks: deliveries are limited in rate', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'venom-board-teamops-rate-'));
  const strict = await start({ PORT: '0', DATA_DIR: data, PUBLIC_URL: 'http://localhost:9', QUIET: 'true', RATE_SCALE: '1', MIN_FREE_DISK_MB: '0', APP_DIR: APPDIR }, { mail: async () => true, fetch: fakeFetch });
  const at = `http://127.0.0.1:${strict.port}`;
  const post = (url, body, headers = {}) => fetch(url.replace('http://localhost:9', at), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': 'push', ...headers }, body }).then(r => r.status);
  try {
    const me = await (await fetch(at + '/api/auth/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'r@studio.test', username: 'rate', password: 'correct horse' }) })).json();
    const auth = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + me.token };
    const teamId = (await (await fetch(at + '/api/teams', { method: 'POST', headers: auth, body: JSON.stringify({ name: 'Rate' }) })).json()).team.id;
    const hook = await (await fetch(`${at}/api/teams/${teamId}/git`, { method: 'POST', headers: auth })).json();
    // unknown addresses and wrong signatures from one address soon get turned away
    const codes = [];
    for (let i = 0; i < 40; i++) codes.push(await post(`${at}/api/hooks/github/${'n'.repeat(24)}`, '{}'));
    for (let i = 0; i < 40; i++) codes.push(await post(hook.git.github, '{}', { 'X-Hub-Signature-256': 'sha256=' + '0'.repeat(64) }));
    assert.deepEqual([codes[0], codes[40]], [404, 401]);
    assert.equal(codes[codes.length - 1], 429, 'a flood of bad deliveries is turned away');
    // ...while properly signed deliveries still get through, up to the team's own hourly allowance
    const ok = [];
    const body = JSON.stringify({ zen: 'x', repository: { full_name: 'rate/repo' } });
    for (let i = 0; i < 601; i++) ok.push(await post(hook.git.github, body, { 'X-GitHub-Event': 'ping', 'X-Hub-Signature-256': sign(hook.secret, Buffer.from(body)) }));
    assert.equal(ok[0], 200);
    assert.equal(ok.filter(s => s === 200).length, 600, 'only signed deliveries count toward the team’s allowance');
    assert.equal(ok[ok.length - 1], 429);
  } finally { await strict.close(); fs.rmSync(data, { recursive: true, force: true }); }
});
