// End-to-end tests: a real server on a random port with a throwaway data folder.
// Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');
const { start } = require('../src/index');
const { cleanDoc } = require('../src/sanitize');
const T = require('../src/totp');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'venom-board-test-'));
const mail = [];
let srv, base;
// the app's index.html, next to this repository, for the template tools; MCP tools may fetch pictures from this computer here
const APP_DIR = path.resolve(__dirname, '../../../Venom Board');
const boot = async () => { srv = await start({ PORT: '0', DATA_DIR: DATA, PUBLIC_URL: 'http://localhost:9', QUIET: 'true', MAIL_PER_10_MIN: '100000', RATE_SCALE: '50', MIN_FREE_DISK_MB: '0', ADMIN_USERS: 'boss', APP_DIR, MCP_FETCH_PRIVATE: 'on' }, { mail: async m => { mail.push(m); return true; } }); base = `http://127.0.0.1:${srv.port}`; };

async function api(method, p, body, token, headers = {}) {
  const r = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body),
  });
  const text = await r.text();
  let data = null; try { data = JSON.parse(text); } catch (e) { data = text; }
  return { status: r.status, data, headers: r.headers };
}

function live(token, url = base) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url.replace('http', 'ws') + '/ws');
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
      none: async (pred, ms = 400) => { await new Promise(r => setTimeout(r, ms)); return !inbox.some(pred); },
      drain: () => { inbox.length = 0; },
      close: () => ws.close(),
    };
    ws.on('open', () => c.send({ t: 'auth', token }));
    ws.on('error', reject);
    c.next(m => m.t === 'ready').then(() => resolve(c), reject);
  });
}

const linkToken = (to, kind) => mail.filter(m => m.to === to && m.text.includes('#' + kind + '=')).pop().text.match(new RegExp('#' + kind + '=([\\w-]+)'))[1];
const confirmEmail = to => api('POST', '/api/auth/verify', { token: linkToken(to, 'verify') });

// a project shared with no board stores an empty one, which counts toward storage
const EMPTY = Buffer.byteLength(JSON.stringify(cleanDoc(undefined, { assetBase: 'http://localhost:9/assets/' })));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')  // a real 1x1 PNG (uploads are rebuilt, so broken ones are refused)
const XSS = '"><img src=x onerror=alert(1)>';
const S = {};  // shared state between steps

test.before(boot);
test.after(async () => { await srv.close(); fs.rmSync(DATA, { recursive: true, force: true }); });

test('accounts: sign up, validation, sign in', async () => {
  for (const [u, e] of [['alice', 'alice@studio.test'], ['bob', 'bob@studio.test'], ['cara', 'cara@studio.test'], ['dan', 'dan@studio.test']]) {
    const r = await api('POST', '/api/auth/signup', { email: e, username: u, password: 'correct horse', displayName: u[0].toUpperCase() + u.slice(1) });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.ok(r.data.token);
    S[u] = r.data.token; S[u + 'Id'] = r.data.user.id;
    assert.equal(r.data.user.emailVerified, false);
  }
  // everyone gets a confirmation link; a link works once
  const aliceLink = linkToken('alice@studio.test', 'verify');
  assert.equal((await api('POST', '/api/auth/verify', { token: aliceLink })).status, 200);
  assert.equal((await api('POST', '/api/auth/verify', { token: aliceLink })).status, 400);
  assert.equal((await api('POST', '/api/auth/verify', { token: 'made-up' })).status, 400);
  for (const e of ['bob@studio.test', 'cara@studio.test', 'dan@studio.test']) assert.equal((await confirmEmail(e)).status, 200);
  assert.equal((await api('GET', '/api/me', undefined, S.alice)).data.user.emailVerified, true);
  assert.equal((await api('POST', '/api/auth/verify/resend', {}, S.alice)).data.verified, true);
  assert.equal((await api('POST', '/api/auth/signup', { email: 'x@studio.test', username: 'ALICE', password: 'correct horse' })).status, 409);
  assert.equal((await api('POST', '/api/auth/signup', { email: 'y@studio.test', username: 'yves', password: 'short' })).data.code, 'password');
  assert.equal((await api('POST', '/api/auth/signup', { email: 'nope', username: 'zed', password: 'correct horse' })).data.code, 'email');
  assert.equal((await api('POST', '/api/auth/login', { login: 'ALICE@studio.test', password: 'correct horse' })).status, 200);
  assert.equal((await api('POST', '/api/auth/login', { login: 'bob', password: 'correct horse' })).status, 200);
  assert.equal((await api('POST', '/api/auth/login', { login: 'bob', password: 'wrong password' })).status, 401);
  assert.equal((await api('POST', '/api/auth/login', { login: 'ghost', password: 'whatever1' })).status, 401);
  assert.equal((await api('GET', '/api/me')).status, 401);
  assert.equal((await api('GET', '/api/me', undefined, 'not-a-token')).status, 401);
});

test('teams: create, invite by username and email, accept', async () => {
  const t = await api('POST', '/api/teams', { name: 'Night Keep Studio' }, S.alice);
  assert.equal(t.data.team.role, 'leader');
  S.team = t.data.team.id;
  assert.equal((await api('POST', `/api/teams/${S.team}/invites`, { who: 'bob', role: 'editor' }, S.alice)).status, 200);
  const caraByEmail = await api('POST', `/api/teams/${S.team}/invites`, { who: 'cara@studio.test', role: 'viewer' }, S.alice);
  assert.equal(caraByEmail.status, 200);
  assert.equal(caraByEmail.data.invite.username, null, "inviting by email doesn't reveal whose account it is");
  assert.equal((await api('POST', `/api/teams/${S.team}/invites`, { who: 'bob', role: 'viewer' }, S.alice)).data.code, 'invited');
  assert.equal((await api('POST', `/api/teams/${S.team}/invites`, { who: 'nobody_here', role: 'viewer' }, S.alice)).data.code, 'no_user');
  // someone without an account is invited by email and gets the invite once they sign up and confirm the address
  assert.equal((await api('POST', `/api/teams/${S.team}/invites`, { who: 'newbie@studio.test', role: 'viewer' }, S.alice)).status, 200);
  assert.ok(mail.some(m => m.to === 'newbie@studio.test' && /Night Keep Studio/.test(m.subject)));
  const newbie = await api('POST', '/api/auth/signup', { email: 'newbie@studio.test', username: 'newbie', password: 'correct horse' });
  assert.equal((await api('GET', '/api/me', undefined, newbie.data.token)).data.invites.length, 0, 'not until the email is confirmed');
  await confirmEmail('newbie@studio.test');
  assert.equal((await api('GET', '/api/me', undefined, newbie.data.token)).data.invites.length, 1);

  // signing up with someone else's address doesn't hand you their invites
  assert.equal((await api('POST', `/api/teams/${S.team}/invites`, { who: 'lead.artist@studio.test', role: 'editor' }, S.alice)).status, 200);
  const squatter = await api('POST', '/api/auth/signup', { email: 'lead.artist@studio.test', username: 'squatter', password: 'correct horse' });
  assert.equal((await api('GET', '/api/me', undefined, squatter.data.token)).data.invites.length, 0);
  // unconfirmed accounts can't send email invites under Venom Board's name
  const squatTeam = await api('POST', '/api/teams', { name: 'Squat' }, squatter.data.token);
  assert.equal((await api('POST', `/api/teams/${squatTeam.data.team.id}/invites`, { who: 'someone@studio.test', role: 'viewer' }, squatter.data.token)).data.code, 'verify_first');
  const artistInvite = (await api('GET', `/api/teams/${S.team}`, undefined, S.alice)).data.invites.find(i => i.email === 'lead.artist@studio.test').id;
  assert.equal((await api('POST', `/api/invites/${artistInvite}/accept`, undefined, squatter.data.token)).status, 404);
  assert.equal((await api('POST', `/api/teams/${S.team}/invites`, { who: 'lead.artist@studio.test', role: 'viewer' }, S.alice)).data.code, 'invited', 'unconfirmed accounts are not resolved by email');
  // the real owner takes the account back with a reset link from their inbox, which also confirms the address
  await api('POST', '/api/auth/forgot', { email: 'lead.artist@studio.test' });
  assert.equal((await api('POST', '/api/auth/reset', { token: linkToken('lead.artist@studio.test', 'reset'), password: 'real owner 1' })).status, 200);
  assert.equal((await api('GET', '/api/me', undefined, squatter.data.token)).status, 401, 'the squatter is signed out');
  const owner = await api('POST', '/api/auth/login', { login: 'lead.artist@studio.test', password: 'real owner 1' });
  const ownerMe = await api('GET', '/api/me', undefined, owner.data.token);
  assert.equal(ownerMe.data.user.emailVerified, true);
  assert.deepEqual(ownerMe.data.invites.map(i => i.id), [artistInvite]);
  assert.equal((await api('POST', `/api/invites/${artistInvite}/decline`, undefined, owner.data.token)).status, 200);

  const bobMe = await api('GET', '/api/me', undefined, S.bob);
  assert.equal(bobMe.data.invites.length, 1);
  const bobInvite = bobMe.data.invites[0].id;
  assert.equal((await api('POST', `/api/invites/${bobInvite}/accept`, undefined, S.dan)).status, 404, 'others cannot accept your invite');
  assert.equal((await api('POST', `/api/invites/${bobInvite}/accept`, undefined, S.bob)).data.team.role, 'editor');
  const caraInvite = (await api('GET', '/api/me', undefined, S.cara)).data.invites[0].id;
  assert.equal((await api('POST', `/api/invites/${caraInvite}/accept`, undefined, S.cara)).data.team.role, 'viewer');
  const team = await api('GET', `/api/teams/${S.team}`, undefined, S.alice);
  assert.deepEqual(team.data.members.map(m => [m.username, m.role]), [['alice', 'leader'], ['bob', 'editor'], ['cara', 'viewer']]);
});

test('team panels: everyone connected hears about projects, people and invites, in a project or not', async () => {
  // dan leads a team of his own here; nobody has a project open to start with
  const t = (await api('POST', '/api/teams', { name: 'Panel Test' }, S.dan)).data.team.id;
  const [dan, bob, cara] = await Promise.all([live(S.dan), live(S.bob), live(S.cara)]);
  const team = m => m.t === 'team' && m.id === t, invites = m => m.t === 'invites', any = m => team(m) || invites(m) || m.t === 'shared';
  const step = async (fn, ...hear) => {  // do something, then check exactly who hears about it
    for (const c of [dan, bob, cara]) c.drain();
    await fn();
    for (const [c, pred] of hear) await c.next(pred);
    for (const c of [dan, bob, cara]) assert.ok(await c.none(any, 150), 'nothing else arrives');
  };
  const ok = r => { assert.ok(r.status < 300, JSON.stringify(r.data)); return r.data; };

  // an invite by username reaches its person straight away, and the team's admins see it waiting; outsiders hear nothing
  await step(async () => ok(await api('POST', `/api/teams/${t}/invites`, { who: 'bob', role: 'editor' }, S.dan)), [bob, invites], [dan, team]);
  // accepting shows up for the leader without a restart
  const inv = ok(await api('GET', '/api/me', undefined, S.bob)).invites.find(i => i.team.id === t).id;
  await step(async () => ok(await api('POST', `/api/invites/${inv}/accept`, undefined, S.bob)), [dan, team], [bob, team]);
  // a project one member makes appears for the others, and so do renames
  let p;
  await step(async () => { p = ok(await api('POST', `/api/teams/${t}/projects`, { name: 'Level 1' }, S.bob)).project.id; }, [dan, team], [bob, team]);
  // ...including for people working in one of the team's projects
  dan.send({ t: 'join', project: p }); await dan.next(m => m.t === 'snapshot');
  bob.send({ t: 'join', project: p }); await bob.next(m => m.t === 'snapshot');
  await step(async () => { ok(await api('PATCH', `/api/projects/${p}`, { name: 'Level One' }, S.bob)); await dan.next(m => m.t === 'renamed'); await bob.next(m => m.t === 'renamed'); }, [dan, team], [bob, team]);
  // a view-only link made by one admin shows for everyone in the project, so nobody replaces it without knowing
  await step(async () => ok(await api('POST', `/api/projects/${p}/share`, undefined, S.dan)), [dan, m => m.t === 'shared'], [bob, m => m.t === 'shared']);
  // an emailed invite reaches the account that confirmed that address, and so does withdrawing it
  await step(async () => ok(await api('POST', `/api/teams/${t}/invites`, { who: 'cara@studio.test', role: 'viewer' }, S.dan)), [cara, invites], [dan, team], [bob, team]);
  const caraInv = ok(await api('GET', `/api/teams/${t}`, undefined, S.dan)).invites.find(i => i.email === 'cara@studio.test').id;
  await step(async () => ok(await api('DELETE', `/api/teams/${t}/invites/${caraInv}`, undefined, S.dan)), [cara, invites], [dan, team], [bob, team]);
  // declining clears it from the inviter's list straight away
  ok(await api('POST', `/api/teams/${t}/invites`, { who: 'cara', role: 'viewer' }, S.dan));
  const caraInv2 = ok(await api('GET', '/api/me', undefined, S.cara)).invites.find(i => i.team.id === t).id;
  await step(async () => ok(await api('POST', `/api/invites/${caraInv2}/decline`, undefined, S.cara)), [cara, invites], [dan, team], [bob, team]);
  // role changes and removals reach the person they're about, even once they're out of the team
  await step(async () => { ok(await api('PATCH', `/api/teams/${t}/members/${S.bobId}`, { role: 'viewer' }, S.dan)); await bob.next(m => m.t === 'role'); }, [dan, team], [bob, team]);
  await step(async () => { ok(await api('DELETE', `/api/teams/${t}/members/${S.bobId}`, undefined, S.dan)); await bob.next(m => m.t === 'kicked'); }, [dan, team], [bob, team]);
  // deleting the team: its projects close for whoever had them open, and the leader's other windows update
  await step(async () => { ok(await api('DELETE', `/api/teams/${t}`, undefined, S.dan)); await dan.next(m => m.t === 'deleted'); }, [dan, team]);
  for (const c of [dan, bob, cara]) c.close();
});

test('permissions: what each role may do', async () => {
  assert.equal((await api('GET', `/api/teams/${S.team}`, undefined, S.dan)).status, 404, 'outsiders cannot see the team');
  assert.equal((await api('POST', `/api/teams/${S.team}/projects`, { name: 'Nope' }, S.cara)).status, 403, 'viewers cannot create projects');
  assert.equal((await api('POST', `/api/teams/${S.team}/invites`, { who: 'dan', role: 'viewer' }, S.bob)).status, 403, 'editors cannot invite');
  assert.equal((await api('PATCH', `/api/teams/${S.team}/members/${S.caraId}`, { role: 'editor' }, S.bob)).status, 403);
  assert.equal((await api('DELETE', `/api/teams/${S.team}/members/${S.caraId}`, undefined, S.bob)).status, 403);
  assert.equal((await api('DELETE', `/api/teams/${S.team}/members/${S.aliceId}`, undefined, S.alice)).data.code, 'leader', 'the leader cannot just leave');
  // an admin may invite editors and viewers, but not other admins
  assert.equal((await api('PATCH', `/api/teams/${S.team}/members/${S.bobId}`, { role: 'admin' }, S.alice)).status, 200);
  assert.equal((await api('POST', `/api/teams/${S.team}/invites`, { who: 'dan', role: 'admin' }, S.bob)).status, 403);
  assert.equal((await api('POST', `/api/teams/${S.team}/invites`, { who: 'dan', role: 'viewer' }, S.bob)).status, 200);
  assert.equal((await api('PATCH', `/api/teams/${S.team}/members/${S.aliceId}`, { role: 'viewer' }, S.bob)).status, 403, 'admins cannot demote the leader');
  assert.equal((await api('PATCH', `/api/teams/${S.team}/members/${S.bobId}`, { role: 'editor' }, S.alice)).status, 200);
});

test('projects: create with a hostile board, sanitised on the server', async () => {
  const doc = { items: [
    { id: 'n1', type: 'node', kind: 'task', x: 10, y: 20, w: 240, title: 'Combat ' + XSS, color: XSS, prio: XSS, due: XSS },
    { id: 'bad' + XSS, type: 'node', title: 'dropped' },
    { id: 'i1', type: 'image', x: 0, y: 0, w: 10, h: 10, src: 'javascript:alert(1)' },
  ], links: [{ id: 'l1', from: { id: 'n1' }, to: { x: 5, y: 5 }, color: XSS, width: XSS }], strokes: [] };
  const r = await api('POST', `/api/teams/${S.team}/projects`, { name: 'Vertical slice', doc }, S.bob);
  assert.equal(r.status, 200);
  S.project = r.data.project.id;
  const p = await api('GET', `/api/projects/${S.project}`, undefined, S.cara);
  assert.equal(p.data.role, 'viewer');
  assert.equal(p.data.doc.items.length, 2);
  const n1 = p.data.doc.items[0];
  assert.equal(n1.color, '#f1eef2'); assert.equal(n1.prio, ''); assert.equal(n1.due, '');
  assert.equal(p.data.doc.items[1].src, undefined, 'javascript: image sources are dropped');
  assert.equal(p.data.doc.links[0].color, '#f1eef2');
  assert.equal(p.data.doc.links[0].width, 2.5);
  assert.equal((await api('GET', `/api/projects/${S.project}`, undefined, S.dan)).status, 404);
});

test('live: edits, previews, presence, read-only enforcement, role changes', async () => {
  const [a, b, c] = await Promise.all([live(S.alice), live(S.bob), live(S.cara)]);
  for (const x of [a, b, c]) x.send({ t: 'join', project: S.project });
  const snaps = await Promise.all([a, b, c].map(x => x.next(m => m.t === 'snapshot')));
  assert.equal(snaps[2].role, 'viewer');
  assert.equal(snaps[0].doc.items.length, 2);

  // an editor's change reaches everyone else, sanitised, and is acknowledged
  b.send({ t: 'ops', batch: 1, ops: [{ k: 'items', op: 'put', obj: { id: 'n2', type: 'node', kind: 'bug', x: 1, y: 2, w: 240, title: 'Clip ' + XSS, color: XSS, sev: 'crash' } }] });
  assert.equal((await b.next(m => m.t === 'ack')).batch, 1);
  for (const x of [a, c]) {
    const m = await x.next(m => m.t === 'ops');
    assert.equal(m.ops[0].obj.id, 'n2'); assert.equal(m.ops[0].obj.color, '#f1eef2'); assert.equal(m.ops[0].obj.sev, 'crash');
  }
  assert.ok(await b.none(m => m.t === 'ops'), 'the sender does not get its own edit echoed back');

  // viewers cannot edit
  c.send({ t: 'ops', batch: 7, ops: [{ k: 'items', op: 'del', id: 'n1' }] });
  assert.equal((await c.next(m => m.t === 'error')).code, 'read_only');
  assert.ok(await a.none(m => m.t === 'ops'));

  // previews and presence are relayed but not stored
  b.send({ t: 'preview', ops: [{ k: 'items', op: 'put', obj: { id: 'n2', type: 'node', x: 300, y: 2, w: 240, title: 'moving' } }] });
  assert.equal((await a.next(m => m.t === 'preview')).ops[0].obj.x, 300);
  a.send({ t: 'presence', x: 12.34, y: 56, sel: ['n1', XSS], editing: null });
  const pres = await b.next(m => m.t === 'presence');
  assert.equal(pres.peer.name, 'Alice'); assert.deepEqual(pres.peer.sel, ['n1']); assert.equal(pres.peer.x, 12.3);
  const stored = await api('GET', `/api/projects/${S.project}`, undefined, S.alice);
  assert.equal(stored.data.doc.items.find(i => i.id === 'n2').x, 1, 'the preview was not saved');

  // order and delete
  b.send({ t: 'ops', batch: 2, ops: [{ k: 'items', op: 'order', ids: ['n2', 'n1'] }, { k: 'links', op: 'del', id: 'l1' }] });
  await b.next(m => m.t === 'ack' && m.batch === 2);
  for (const x of [a, c]) assert.deepEqual((await x.next(m => m.t === 'ops')).ops.map(o => o.op), ['order', 'del']);
  const after = await api('GET', `/api/projects/${S.project}`, undefined, S.alice);
  assert.deepEqual(after.data.doc.items.map(i => i.id), ['n2', 'n1', 'i1']);
  assert.equal(after.data.doc.links.length, 0);

  // promoting the viewer takes effect live
  assert.equal((await api('PATCH', `/api/teams/${S.team}/members/${S.caraId}`, { role: 'editor' }, S.alice)).status, 200);
  assert.equal((await c.next(m => m.t === 'role')).role, 'editor');
  c.send({ t: 'ops', batch: 8, ops: [{ k: 'items', op: 'put', obj: { id: 'n3', type: 'text', x: 0, y: 0, text: 'from cara', size: 20 } }] });
  await c.next(m => m.t === 'ack' && m.batch === 8);
  assert.equal((await a.next(m => m.t === 'ops')).ops[0].obj.text, 'from cara');

  // removing a member disconnects them from the project
  assert.equal((await api('DELETE', `/api/teams/${S.team}/members/${S.bobId}`, undefined, S.alice)).status, 200);
  await b.next(m => m.t === 'kicked');
  assert.ok((await a.next(m => m.t === 'peer-leave')).cid);
  b.send({ t: 'join', project: S.project });
  assert.equal((await b.next(m => m.t === 'error')).code, 'forbidden');
  for (const x of [a, b, c]) x.close();
});

test('uploads: images only, editors only, served to anyone with the link', async () => {
  const up = await api('POST', `/api/projects/${S.project}/assets`, PNG, S.cara, { 'Content-Type': 'image/png' });
  assert.equal(up.status, 200, JSON.stringify(up.data));
  const id = up.data.id;
  S.assetId = id;
  const r = await fetch(`${base}/assets/${id}`);
  assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'image/png'); assert.equal(r.headers.get('access-control-allow-origin'), '*');
  assert.equal((await api('POST', `/api/projects/${S.project}/assets`, '<svg onload=alert(1)>', S.cara, { 'Content-Type': 'image/svg+xml' })).status, 415);
  assert.equal((await api('POST', `/api/projects/${S.project}/assets`, PNG, S.bob, { 'Content-Type': 'image/png' })).status, 404, 'removed members cannot upload');
});

test('images: shared boards only show pictures stored on this server', async () => {
  const own = `http://localhost:9/assets/${S.assetId}`;
  const doc = { items: [
    { id: 'p1', type: 'image', x: 0, y: 0, w: 10, h: 10, src: 'https://tracker.test/pixel.gif' },
    { id: 'p2', type: 'image', x: 0, y: 0, w: 10, h: 10, src: own },
    { id: 'p3', type: 'image', x: 0, y: 0, w: 10, h: 10, src: 'http://localhost:9/assets/../../etc/passwd' },
  ] };
  const r = await api('POST', `/api/teams/${S.team}/projects`, { name: 'Pixels', doc }, S.alice);
  const p = await api('GET', `/api/projects/${r.data.project.id}`, undefined, S.alice);
  assert.deepEqual(p.data.doc.items.map(i => i.src), [undefined, own, undefined], 'outside links are dropped, so nobody gets tracked by opening a board');
  const [a, c] = await Promise.all([live(S.alice), live(S.cara)]);
  for (const x of [a, c]) x.send({ t: 'join', project: r.data.project.id });
  await Promise.all([a, c].map(x => x.next(m => m.t === 'snapshot')));
  c.send({ t: 'ops', batch: 1, ops: [{ k: 'items', op: 'put', obj: { id: 'p4', type: 'image', x: 0, y: 0, w: 10, h: 10, src: 'https://tracker.test/live.gif' } }] });
  assert.equal((await a.next(m => m.t === 'ops')).ops[0].obj.src, undefined);
  a.close(); c.close();
});

test('sessions: sign-out and password changes end live connections', async () => {
  const login = async () => (await api('POST', '/api/auth/login', { login: 'cara', password: 'correct horse' })).data.token;
  const t1 = await login(), t2 = await login();
  const [x1, x2] = await Promise.all([live(t1), live(t2)]);
  // signing out one session closes only its own live connection
  assert.equal((await api('POST', '/api/auth/logout', undefined, t1)).status, 200);
  assert.equal((await x1.next(m => m.t === 'error')).code, 'auth');
  assert.ok(await x2.none(m => m.t === 'error'));
  // a new password signs out every other session, live ones included, and keeps the current one
  const t3 = await login();
  assert.equal((await api('PATCH', '/api/me', { currentPassword: 'correct horse', newPassword: 'cara new pass' }, t3)).status, 200);
  assert.equal((await x2.next(m => m.t === 'error')).code, 'auth');
  assert.equal((await api('GET', '/api/me', undefined, t2)).status, 401);
  assert.equal((await api('GET', '/api/me', undefined, t3)).status, 200);
  S.cara = t3;
  x1.close(); x2.close();
});

test('limits: guessing stays slow, owners keep access, emails and storage are capped', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'venom-board-limits-'));
  const sent = [];
  const s2 = await start({ PORT: '0', DATA_DIR: dir, PUBLIC_URL: 'http://localhost:9', QUIET: 'true', MAIL_PER_10_MIN: '100000', RATE_SCALE: '1', MIN_FREE_DISK_MB: '0', TEAM_STORAGE_MB: String((EMPTY + 1.5 * PNG.length) / 1048576) },
    { mail: async m => { sent.push(m); return true; } });
  const call = (method, p, body, headers = {}) => fetch(`http://127.0.0.1:${s2.port}${p}`, {
    method, headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
  }).then(async r => ({ status: r.status, data: await r.json().catch(() => null) }));
  const from = ip => ({ 'X-Real-IP': ip });
  const signIn = (password, ip, device) => call('POST', '/api/auth/login', { login: 'eve', password, ...(device ? { device } : {}) }, from(ip));
  const tokens = kind => sent.filter(m => m.to === 'eve@studio.test' && m.text.includes('#' + kind + '=')).map(m => m.text.match(new RegExp('#' + kind + '=([\\w-]+)'))[1]);
  try {
    const eve = await call('POST', '/api/auth/signup', { email: 'eve@studio.test', username: 'eve', password: 'correct horse' });
    assert.ok(eve.data.device, 'signing up remembers this device');

    // someone guessing from one network gets slowed down, but the owner can still sign in from theirs
    for (let i = 0; i < 10; i++) await signIn('wrong guess', '203.0.113.9');
    assert.equal((await signIn('correct horse', '203.0.113.9')).status, 429);
    assert.equal((await signIn('correct horse', '198.51.100.7')).status, 200);
    // guessing from many networks still hits a cap on the account...
    for (const ip of ['203.0.113.10', '203.0.113.11']) for (let i = 0; i < 9; i++) await signIn('wrong guess', ip);
    await signIn('wrong guess', '203.0.113.12');
    assert.equal((await signIn('correct horse', '192.0.2.50')).status, 429, 'new devices are held back once the account is under attack');
    // ...yet a device that has signed in before gets straight in
    const known = await signIn('correct horse', '192.0.2.51', eve.data.device);
    assert.equal(known.status, 200);
    assert.equal(known.data.device, eve.data.device);
    assert.equal((await signIn('correct horse', '192.0.2.52', 'made-up-device')).status, 429, 'an unknown device token counts for nothing');
    // a password reset (the link only reaches the owner's inbox) makes the browser that used it trusted...
    await call('POST', '/api/auth/forgot', { email: 'eve@studio.test' }, from('192.0.2.60'));
    const site = { 'Content-Type': 'application/json', 'X-VB': '1' };
    const reset = await fetch(`http://127.0.0.1:${s2.port}/api/auth/reset`, { method: 'POST', headers: site, body: JSON.stringify({ token: tokens('reset').pop(), password: 'correct horse 2' }) });
    assert.equal(reset.status, 200);
    const resetDevice = (reset.headers.get('set-cookie') || '').match(/vb_device=([^;]+)/)[1];
    const webLogin = await fetch(`http://127.0.0.1:${s2.port}/api/auth/login`, { method: 'POST', headers: { ...site, Cookie: 'vb_device=' + resetDevice, ...from('192.0.2.62') },
      body: JSON.stringify({ login: 'eve', password: 'correct horse 2', web: true }) });
    assert.equal(webLogin.status, 200);
    assert.equal(webLogin.headers.get('set-cookie').match(/vb_device=([^;]+)/)[1], resetDevice, 'it signs in as a known device');
    // ...lets new devices in again, and stops trusting devices that knew the old password
    const fresh = await signIn('correct horse 2', '192.0.2.61');
    assert.equal(fresh.status, 200);
    const old = await signIn('correct horse 2', '192.0.2.63', eve.data.device);
    assert.notEqual(old.data.device, eve.data.device, 'the old device token was revoked');

    // this team's allowance fits one small image, not two
    const auth = { Authorization: 'Bearer ' + fresh.data.token };
    const team = await call('POST', '/api/teams', { name: 'Tiny' }, auth);
    const proj = await call('POST', `/api/teams/${team.data.team.id}/projects`, { name: 'P' }, auth);
    const upload = () => call('POST', `/api/projects/${proj.data.project.id}/assets`, PNG, { ...auth, 'Content-Type': 'image/png' });
    assert.equal((await upload()).status, 200);
    const over = await upload();
    assert.equal(over.status, 413);
    assert.equal(over.data.code, 'quota');

    // email caps are kept per kind: invites someone keeps sending can't use up the owner's password resets
    assert.equal((await call('GET', '/api/me', undefined, auth)).data.user.emailVerified, true, 'the reset link confirmed the address');
    for (let i = 1; i <= 4; i++) {
      const t = await call('POST', '/api/teams', { name: 'Team ' + i }, auth);
      const inv = await call('POST', `/api/teams/${t.data.team.id}/invites`, { who: 'eve@studio.test', role: 'viewer' }, auth);
      assert.equal(inv.status, i <= 3 ? 200 : 429, `invite ${i}`);
    }
    const t5 = await call('POST', '/api/teams', { name: 'Team 5' }, auth);
    assert.equal((await call('POST', `/api/teams/${t5.data.team.id}/invites`, { who: 'Eve+other@studio.test', role: 'viewer' }, auth)).status, 429, 'another spelling of the same inbox shares its cap');
    const resetsBefore = tokens('reset').length;
    await call('POST', '/api/auth/forgot', { email: 'eve@studio.test' }, from('192.0.2.70'));
    assert.equal(tokens('reset').length, resetsBefore + 1, 'the reset still arrives');
    // someone requesting reset after reset for this address can only send a few, and every link that arrived still works
    for (const ip of ['192.0.2.71', '192.0.2.72', '192.0.2.73']) await call('POST', '/api/auth/forgot', { email: 'eve@studio.test' }, from(ip));
    assert.equal(tokens('reset').length, resetsBefore + 2, 'capped at three resets an hour');
    assert.equal((await call('POST', '/api/auth/reset', { token: tokens('reset')[resetsBefore], password: 'correct horse 3' })).status, 200, 'an earlier link still works');
    assert.equal((await call('POST', '/api/auth/reset', { token: tokens('reset')[resetsBefore + 1], password: 'not this one' })).status, 400, 'using one link cancels the rest');
    // with this hour's resets used up, a device that has signed in before still gets a link
    const knownLogin = await fetch(`http://127.0.0.1:${s2.port}/api/auth/login`, { method: 'POST', headers: { ...site, ...from('192.0.2.80') },
      body: JSON.stringify({ login: 'eve', password: 'correct horse 3', web: true }) });
    const knownCookie = 'vb_device=' + knownLogin.headers.get('set-cookie').match(/vb_device=([^;]+)/)[1];
    const resetsNow = tokens('reset').length;
    await call('POST', '/api/auth/forgot', { email: 'eve@studio.test' }, { ...from('192.0.2.81') });
    assert.equal(tokens('reset').length, resetsNow, 'a stranger asking gets nothing more this hour');
    await fetch(`http://127.0.0.1:${s2.port}/api/auth/forgot`, { method: 'POST', headers: { ...site, Cookie: knownCookie, ...from('192.0.2.82') }, body: JSON.stringify({ email: 'eve@studio.test' }) });
    assert.equal(tokens('reset').length, resetsNow + 1, 'the owner on a known device does');
    // collecting more device tokens doesn't add up to more email: known devices share one allowance per account
    for (const ip of ['192.0.2.83', '192.0.2.84', '192.0.2.85']) {
      const extra = await fetch(`http://127.0.0.1:${s2.port}/api/auth/login`, { method: 'POST', headers: { ...site, ...from(ip) },
        body: JSON.stringify({ login: 'eve', password: 'correct horse 3', web: true }) });
      const cookie = 'vb_device=' + extra.headers.get('set-cookie').match(/vb_device=([^;]+)/)[1];
      await fetch(`http://127.0.0.1:${s2.port}/api/auth/forgot`, { method: 'POST', headers: { ...site, Cookie: cookie, ...from(ip) }, body: JSON.stringify({ email: 'eve@studio.test' }) });
    }
    assert.equal(tokens('reset').length, resetsNow + 3, 'three an hour from known devices, however many there are');

    // accounts on other spellings of someone's inbox can't use up the emails that person's own account needs
    const mailTo = (to, kind) => sent.filter(m => m.to === to && m.text.includes('#' + kind + '=')).length;
    await call('POST', '/api/auth/signup', { email: 'vic@studio.test', username: 'vic', password: 'correct horse' }, from('198.51.100.20'));
    const squat = await call('POST', '/api/auth/signup', { email: 'vic+1@studio.test', username: 'vic_squat', password: 'correct horse' }, from('198.51.100.21'));
    for (const ip of ['198.51.100.30', '198.51.100.31', '198.51.100.32', '198.51.100.33', '198.51.100.34']) {
      await call('POST', '/api/auth/forgot', { email: 'vic+1@studio.test' }, from(ip));
      await call('POST', '/api/auth/verify/resend', {}, { Authorization: 'Bearer ' + squat.data.token });
    }
    await call('POST', '/api/auth/forgot', { email: 'vic@studio.test' }, from('198.51.100.40'));
    assert.equal(mailTo('vic@studio.test', 'reset'), 1, "vic's reset still arrives");
    const vic = await call('POST', '/api/auth/login', { login: 'vic', password: 'correct horse' }, from('198.51.100.41'));
    const verifiesBefore = mailTo('vic@studio.test', 'verify');
    await call('POST', '/api/auth/verify/resend', {}, { Authorization: 'Bearer ' + vic.data.token });
    assert.equal(mailTo('vic@studio.test', 'verify'), verifiesBefore + 1, "and so does vic's confirmation");

    // and piling up accounts on extra spellings never adds up to more email: they share one small allowance
    for (const n of [2, 3, 4]) {
      await call('POST', '/api/auth/signup', { email: `vic+${n}@studio.test`, username: `vic_squat${n}`, password: 'correct horse' }, from('198.51.100.5' + n));
      await call('POST', '/api/auth/forgot', { email: `vic+${n}@studio.test` }, from('198.51.100.6' + n));
    }
    const spellings = kind => sent.filter(m => /^vic\+\d@/.test(m.to) && m.text.includes('#' + kind + '=')).length;
    assert.equal(spellings('reset'), 5, 'five resets a day across every extra spelling');
    assert.equal(spellings('verify'), 5, 'and five confirmations');
    assert.equal(mailTo('vic+4@studio.test', 'reset') + mailTo('vic+4@studio.test', 'verify'), 0);
  } finally {
    await s2.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rate limits: a daily limit still holds after a quiet hour', t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const limit = require('../src/auth').rateLimiter(), DAY = 86400000;
  for (let i = 0; i < 3; i++) assert.ok(limit('k', 3, DAY));
  assert.equal(limit('k', 3, DAY), false);
  t.mock.timers.tick(2 * 3600000);  // the clean-up runs many times meanwhile
  assert.equal(limit('k', 3, DAY), false, 'not forgotten after two quiet hours');
  t.mock.timers.tick(23 * 3600000);
  assert.equal(limit('k', 3, DAY), true, 'but free again a day later');
});

test('allowances: teams, projects, people and board size are capped', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'venom-board-allowances-'));
  const sent = [];
  const s3 = await start({ PORT: '0', DATA_DIR: dir, PUBLIC_URL: 'http://localhost:9', QUIET: 'true', MAIL_PER_10_MIN: '100000', RATE_SCALE: '50', MIN_FREE_DISK_MB: '0',
    LIMIT_TEAMS_LED: '2', LIMIT_TEAMS_JOINED: '3', LIMIT_TEAM_PROJECTS: '3', LIMIT_TEAM_MEMBERS: '3', LIMIT_UNVERIFIED_TEAMS: '1', LIMIT_UNVERIFIED_PROJECTS: '2',
    PROJECT_MAX_MB: '0.02', TEAM_STORAGE_MB: '10', LEADER_STORAGE_MB: '10' }, { mail: async m => { sent.push(m); return true; } });
  const url = `http://127.0.0.1:${s3.port}`;
  const call = (method, p, body, token, headers = {}) => fetch(url + p, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers },
    body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
  }).then(async r => ({ status: r.status, data: await r.json().catch(() => null) }));
  const signup = async u => (await call('POST', '/api/auth/signup', { email: u + '@studio.test', username: u, password: 'correct horse' })).data.token;
  const confirm = to => call('POST', '/api/auth/verify', { token: sent.filter(m => m.to === to && m.text.includes('#verify=')).pop().text.match(/#verify=([\w-]+)/)[1] });
  const team = async (name, token) => call('POST', '/api/teams', { name }, token);
  const project = (teamId, token, doc) => call('POST', `/api/teams/${teamId}/projects`, { name: 'P', doc }, token);
  const card = (id, n) => ({ id, type: 'node', kind: 'task', x: n * 300, y: 0, w: 240, title: 'Card ' + id, body: 'x'.repeat(3900) });
  try {
    // until the email is confirmed, an account gets a trial-sized allowance
    const ana = await signup('ana');
    const me = (await call('GET', '/api/me', undefined, ana)).data;
    assert.deepEqual([me.limits.teamsLed, me.limits.projectsUntilConfirmed], [1, 2]);
    const a1 = (await team('A1', ana)).data.team.id;
    assert.equal((await team('A2', ana)).data.code, 'verify_first');
    for (let i = 0; i < 2; i++) assert.equal((await project(a1, ana)).status, 200);
    assert.equal((await project(a1, ana)).data.code, 'verify_first');
    // confirmed, it gets the full allowance, which is still finite
    await confirm('ana@studio.test');
    assert.equal((await call('GET', '/api/me', undefined, ana)).data.limits.projectsUntilConfirmed, null);
    const a2 = (await team('A2', ana)).data.team.id;
    assert.equal((await team('A3', ana)).data.code, 'limit', 'one account leads a limited number of teams');
    assert.equal((await project(a1, ana)).status, 200);
    assert.equal((await project(a1, ana)).data.code, 'limit', 'and each team has a limited number of projects');
    const detail = (await call('GET', `/api/teams/${a1}`, undefined, ana)).data;
    assert.deepEqual([detail.projects.length, detail.limits.projects], [3, 3]);

    // a team holds a limited number of people, counting invites that are still waiting
    const [ben, cal, dee] = [await signup('ben'), await signup('cal'), await signup('dee')];
    assert.equal((await call('POST', `/api/teams/${a2}/invites`, { who: 'ben', role: 'editor' }, ana)).status, 200);
    assert.equal((await call('POST', `/api/teams/${a2}/invites`, { who: 'cal', role: 'editor' }, ana)).status, 200);
    assert.equal((await call('POST', `/api/teams/${a2}/invites`, { who: 'dee', role: 'editor' }, ana)).data.code, 'limit');
    const accept = async (token, teamName) => call('POST', `/api/invites/${(await call('GET', '/api/me', undefined, token)).data.invites.find(i => i.team.name === teamName).id}/accept`, undefined, token);
    assert.equal((await accept(ben, 'A2')).status, 200);

    // and one account can only be in so many teams
    await team('B1', ben);
    assert.equal((await call('POST', `/api/teams/${a1}/invites`, { who: 'ben', role: 'viewer' }, ana)).status, 200);
    assert.equal((await accept(ben, 'A1')).status, 200);
    const d1 = (await team('D1', dee)).data.team.id;
    assert.equal((await call('POST', `/api/teams/${d1}/invites`, { who: 'ben', role: 'viewer' }, dee)).status, 200);
    assert.equal((await accept(ben, 'D1')).data.code, 'limit', 'ben is already in three teams');
    assert.ok(cal);

    // a board has a size limit, both when it's shared and while it's edited live
    assert.equal((await project(d1, dee, { items: [0, 1, 2, 3, 4, 5, 6].map(n => card('c' + n, n)) })).data.code, 'too_big');
    const small = (await project(d1, dee, { items: [card('s0', 0)] })).data.project.id;
    const ws = await live(dee, url);
    ws.send({ t: 'join', project: small });
    await ws.next(m => m.t === 'snapshot');
    ws.send({ t: 'ops', batch: 1, ops: [1, 2, 3, 4, 5, 6, 7, 8].map(n => ({ k: 'items', op: 'put', obj: card('s' + n, n) })) });
    await ws.next(m => m.t === 'ack' && m.batch === 1);
    assert.equal((await ws.next(m => m.t === 'error')).code, 'too_big');
    const stored = (await call('GET', `/api/projects/${small}`, undefined, dee)).data.doc;
    assert.ok(JSON.stringify(stored).length <= 0.02 * 1048576, 'the board stayed within its limit');
    assert.ok(stored.items.length > 1 && stored.items.length < 9, 'changes that fit went through, the rest were refused');
    ws.send({ t: 'ops', batch: 2, ops: [{ k: 'items', op: 'del', id: 's1' }, { k: 'items', op: 'put', obj: { ...card('s0', 0), body: 'shorter' } }] });
    await ws.next(m => m.t === 'ack' && m.batch === 2);
    assert.ok(await ws.none(m => m.t === 'error'), 'making a full board smaller always works');
    ws.close();

    // the Team panel's storage figure counts the boards and the pictures
    const upload = (p, token) => call('POST', `/api/projects/${p}/assets`, PNG, token, { 'Content-Type': 'image/png' });
    assert.equal((await upload(detail.projects[0].id, ana)).status, 200);
    assert.equal((await call('GET', `/api/teams/${a1}`, undefined, ana)).data.usage.storageBytes, 3 * EMPTY + PNG.length);
  } finally {
    await s3.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('storage: pictures, boards and their history all count, so nothing can fill the server', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'venom-board-storage-'));
  const sent = [], KB = 1024, MB = 1048576;
  const s4 = await start({ PORT: '0', DATA_DIR: dir, PUBLIC_URL: 'http://localhost:9', QUIET: 'true', MAIL_PER_10_MIN: '100000', RATE_SCALE: '50', MIN_FREE_DISK_MB: '0',
    PROJECT_MAX_MB: String(40 * KB / MB), TEAM_STORAGE_MB: String(60 * KB / MB), LEADER_STORAGE_MB: String(100 * KB / MB), LIMIT_UNVERIFIED_STORAGE_MB: String(20 * KB / MB) },
  { mail: async m => { sent.push(m); return true; } });
  const url = `http://127.0.0.1:${s4.port}`;
  const call = (method, p, body, token) => fetch(url + p, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async r => ({ status: r.status, data: await r.json().catch(() => null) }));
  const signup = async u => (await call('POST', '/api/auth/signup', { email: u + '@studio.test', username: u, password: 'correct horse' })).data.token;
  const confirm = to => call('POST', '/api/auth/verify', { token: sent.filter(m => m.to === to && m.text.includes('#verify=')).pop().text.match(/#verify=([\w-]+)/)[1] });
  const team = async (name, token) => (await call('POST', '/api/teams', { name }, token)).data.team.id;
  const project = (teamId, token, cards) => call('POST', `/api/teams/${teamId}/projects`, { name: 'P', doc: { items: cards } }, token);
  // about 4 KB each, and random, so compressed versions are nearly as big as the board
  const card = n => ({ id: 'r' + n + crypto.randomBytes(4).toString('hex'), type: 'node', kind: 'task', x: n * 300, y: 0, w: 240, title: 'Card', body: crypto.randomBytes(2900).toString('base64') });
  const used = async (teamId, token) => (await call('GET', `/api/teams/${teamId}`, undefined, token)).data.usage.storageBytes;
  try {
    const sam = await signup('sam');
    await confirm('sam@studio.test');
    const t1 = await team('T1', sam);
    // a shared board counts as soon as it's stored
    const p1 = (await project(t1, sam, [0, 1, 2, 3].map(card))).data.project.id;
    const board = await used(t1, sam);
    assert.ok(board > 15 * KB && board < 18 * KB, 'the board counts');
    // so do named versions, until the team's storage is full
    let saved = 0, res;
    while ((res = await call('POST', `/api/projects/${p1}/versions`, { label: 'v' + saved }, sam)).status === 200) saved++;
    assert.deepEqual([res.status, res.data.code], [413, 'quota']);
    assert.match(res.data.error || res.data.message || '', /storage/);
    assert.ok(saved >= 2 && saved <= 4, `versions fit until the storage was full (${saved})`);
    assert.ok(await used(t1, sam) <= 60 * KB);

    // live edits that would grow a board past it are refused with the reason; making it smaller always works
    const ws = await live(sam, url);
    ws.send({ t: 'join', project: p1 });
    await ws.next(m => m.t === 'snapshot');
    const more = [4, 5, 6, 7, 8].map(card);
    ws.send({ t: 'ops', batch: 1, ops: more.map(obj => ({ k: 'items', op: 'put', obj })) });
    await ws.next(m => m.t === 'ack' && m.batch === 1);
    const err = await ws.next(m => m.t === 'error');
    assert.equal(err.code, 'too_big');
    assert.match(err.message, /storage/);
    ws.send({ t: 'ops', batch: 2, ops: [{ k: 'items', op: 'del', id: more[0].id }] });
    await ws.next(m => m.t === 'ack' && m.batch === 2);
    assert.ok(await ws.none(m => m.t === 'error'), 'deleting works on a full team');
    ws.close();

    // all the teams one account leads share an allowance, so making another team doesn't add room
    const t2 = await team('T2', sam);
    let made = 0;
    while ((res = await project(t2, sam, [0, 1, 2, 3].map(card))).status === 200) made++;
    assert.deepEqual([res.status, res.data.code], [413, 'quota']);
    assert.match(res.data.error || res.data.message || '', /leader runs/);
    assert.ok(made >= 1 && made <= 3, `projects fit until the leader's storage was full (${made})`);

    // an account that hasn't confirmed its email gets less
    const una = await signup('una');
    assert.equal((await call('GET', '/api/me', undefined, una)).data.limits.teamStorageMB, 20 * KB / MB);
    const u1 = await team('U1', una);
    assert.equal((await project(u1, una, [0, 1, 2, 3].map(card))).status, 200);
    assert.equal((await project(u1, una, [0, 1, 2, 3].map(card))).data.code, 'quota');

    // a restore keeps the board as it was first, so it can be undone: with no room left for that copy it's refused,
    // so restoring over and over can't grow past the storage limit
    const versions = (await call('GET', `/api/projects/${p1}/versions`, undefined, sam)).data.items;
    const restored = await call('POST', `/api/projects/${p1}/versions/${versions[0].id}/restore`, undefined, sam);
    assert.deepEqual([restored.status, restored.data.code], [413, 'quota']);
    const after = (await call('GET', `/api/projects/${p1}/versions`, undefined, sam)).data.items;
    assert.equal(after.length, versions.length, 'nothing was added');
    assert.equal(after.filter(v => !v.auto).length, saved);
  } finally {
    await s4.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('browser security: CORS for apps, cookies only from our own pages', async () => {
  const pre = await fetch(`${base}/api/me`, { method: 'OPTIONS', headers: { Origin: 'null', 'Access-Control-Request-Headers': 'authorization' } });
  assert.equal(pre.status, 204); assert.equal(pre.headers.get('access-control-allow-origin'), '*');
  assert.equal(pre.headers.get('access-control-allow-credentials'), null);
  // login CSRF: another site can't sign a visitor into an account
  const creds = JSON.stringify({ login: 'alice', password: 'correct horse', web: true });
  assert.equal((await api('POST', '/api/auth/login', creds, null, { 'Content-Type': 'text/plain' })).status, 415, 'form-style posts are refused');
  assert.equal((await api('POST', '/api/auth/login', creds)).status, 403, 'no X-VB header, no cookie');
  const evil = await api('POST', '/api/auth/login', creds, null, { 'X-VB': '1', Origin: 'https://evil.test' });
  assert.equal(evil.status, 403, 'no cookie for other origins');
  assert.equal(evil.headers.get('set-cookie'), null);
  const login = await api('POST', '/api/auth/login', creds, null, { 'X-VB': '1' });
  assert.equal(login.status, 200);
  assert.equal(login.data.token, undefined, 'the website never sees the token');
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
  assert.match(login.headers.get('set-cookie'), /vb_device=[\w%-]+; Path=\/api\/auth; HttpOnly/, 'the device cookie only goes to the sign-in endpoints');
  assert.equal((await api('GET', '/api/me', undefined, null, { Cookie: cookie })).status, 200);
  assert.equal((await api('POST', '/api/teams', { name: 'CSRF' }, null, { Cookie: cookie })).status, 401, 'no X-VB header, no cookie auth');
  assert.equal((await api('GET', '/api/me', undefined, null, { Cookie: cookie, Origin: 'https://evil.test' })).status, 401, 'cookies are ignored cross-origin');
  assert.equal((await api('POST', '/api/teams', { name: 'Side project' }, null, { Cookie: cookie, 'X-VB': '1' })).status, 200);
  assert.equal((await api('POST', '/api/auth/logout', undefined, null, { Cookie: cookie })).status, 403, 'no forced sign-out from other sites');
  assert.equal((await api('GET', '/api/me', undefined, null, { Cookie: cookie })).status, 200, 'still signed in');
  const page = await fetch(`${base}/account`);
  assert.match(page.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
  assert.equal((await fetch(`${base}/web/../server/src/index.js`)).status, 404);
  assert.equal((await fetch(`${base}/docs/..%2f..%2fserver%2fsrc%2findex.js`)).status, 404);
});

test('addresses: session check, trailing slashes, friendly redirects and a real 404 page', async () => {
  // signed-out visitors get a normal answer, not an error
  const out = await api('GET', '/api/session');
  assert.equal(out.status, 200); assert.equal(out.data.user, null);
  const me = await api('GET', '/api/session', undefined, S.alice);
  assert.equal(me.data.user.username, 'alice');
  // a trailing slash on an API path works like the path itself
  assert.equal((await api('GET', '/api/me/', undefined, S.alice)).status, 200);
  assert.equal((await api('GET', '/api/me/')).status, 401);
  // addresses people type lead to the right page
  for (const [from, to] of [['/account/', '/account'], ['/app/', '/app'], ['/login', '/account#signin'], ['/SignUp', '/account#signup'], ['/index.html', '/']]) {
    const r = await fetch(base + from, { redirect: 'manual' });
    assert.equal(r.status, 301, from); assert.equal(r.headers.get('location'), to, from);
  }
  assert.equal((await fetch(base + '/account/?x=1', { redirect: 'manual' })).headers.get('location'), '/account?x=1');
  // unknown pages: a styled page for browsers, plain text for everything else
  const page = await fetch(base + '/no-such-page', { headers: { Accept: 'text/html' } });
  assert.equal(page.status, 404);
  assert.match(await page.text(), /doesn't exist/);
  assert.match(page.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
  const plain = await fetch(base + '/no-such-page');
  assert.equal(plain.status, 404); assert.equal(await plain.text(), 'Not found');
});

test('password reset signs you out everywhere', async () => {
  assert.equal((await api('POST', '/api/auth/forgot', { email: 'nobody@studio.test' })).status, 200, 'unknown emails get the same answer');
  await api('POST', '/api/auth/forgot', { email: 'dan@studio.test' });
  const token = linkToken('dan@studio.test', 'reset');
  const danLive = await live(S.dan);
  assert.equal((await api('POST', '/api/auth/reset', { token, password: 'new password 1' })).status, 200);
  assert.equal((await api('GET', '/api/me', undefined, S.dan)).status, 401, 'old sessions are revoked');
  assert.equal((await danLive.next(m => m.t === 'error')).code, 'auth', 'and so are their live connections');
  danLive.close();
  assert.equal((await api('POST', '/api/auth/reset', { token, password: 'again again' })).status, 400, 'links work once');
  const relog = await api('POST', '/api/auth/login', { login: 'dan', password: 'new password 1' });
  assert.equal(relog.status, 200);
  S.dan = relog.data.token;
});

test('leadership transfer, project deletion and persistence across a restart', async () => {
  assert.equal((await api('POST', `/api/teams/${S.team}/transfer`, { userId: S.caraId }, S.alice)).status, 200);
  const t = await api('GET', `/api/teams/${S.team}`, undefined, S.alice);
  assert.deepEqual(t.data.members.slice(0, 2).map(m => [m.username, m.role]), [['cara', 'leader'], ['alice', 'admin']]);

  const keep = await api('POST', `/api/teams/${S.team}/projects`, { name: 'Keeper' }, S.alice);
  const a = await live(S.alice);
  a.send({ t: 'join', project: keep.data.project.id });
  await a.next(m => m.t === 'snapshot');
  a.send({ t: 'ops', batch: 1, ops: [{ k: 'items', op: 'put', obj: { id: 'k1', type: 'frame', x: 0, y: 0, w: 600, h: 400, title: 'Survives restarts', color: '#3dff8b' } }] });
  await a.next(m => m.t === 'ack');
  a.send({ t: 'join', project: S.project });
  await a.next(m => m.t === 'snapshot');
  assert.equal((await api('DELETE', `/api/projects/${S.project}`, undefined, S.alice)).status, 200);
  assert.equal((await a.next(m => m.t === 'deleted')).t, 'deleted');
  a.close();

  await srv.close();
  await boot();
  const back = await api('GET', `/api/projects/${keep.data.project.id}`, undefined, S.alice);
  assert.equal(back.data.doc.items[0].title, 'Survives restarts');
  assert.equal((await api('GET', `/api/projects/${S.project}`, undefined, S.alice)).status, 404);
  S.keeper = keep.data.project.id;
});

test('account settings: profile changes show live, other sign-ins end, accounts can be deleted', async () => {
  // a new name or colour reaches everyone in the project straight away
  const [a, c] = await Promise.all([live(S.alice), live(S.cara)]);
  for (const x of [a, c]) x.send({ t: 'join', project: S.keeper });
  await Promise.all([a, c].map(x => x.next(m => m.t === 'snapshot')));
  const me = await api('GET', '/api/me', undefined, S.alice);
  assert.ok(me.data.colors.includes(me.data.user.color));
  assert.equal((await api('PATCH', '/api/me', { color: 'red; background:url(x)' }, S.alice)).data.code, 'color');
  assert.equal((await api('PATCH', '/api/me', { displayName: 'Alice V', color: '#a66bff' }, S.alice)).status, 200);
  assert.equal((await c.next(m => m.t === 'peer' && m.peer.name === 'Alice V')).peer.color, '#a66bff');
  // a wrong current password changes nothing at all
  assert.equal((await api('PATCH', '/api/me', { displayName: 'Hacked', currentPassword: 'nope', newPassword: 'whatever123' }, S.alice)).data.code, 'bad_password');
  assert.equal((await api('GET', '/api/me', undefined, S.alice)).data.user.displayName, 'Alice V');
  a.close(); c.close();

  // signing out everywhere else keeps this sign-in and ends the others, live connections included
  const login = async () => (await api('POST', '/api/auth/login', { login: 'dan', password: 'new password 1' })).data.token;
  const d1 = await login(), d2 = await login(), d2Live = await live(d2);
  assert.equal((await api('GET', '/api/me', undefined, d1)).data.sessions.others, 2);
  const out = await api('POST', '/api/me/sign-out-others', undefined, d1);
  assert.equal(out.data.signedOut, 2);
  assert.equal((await d2Live.next(m => m.t === 'error')).code, 'auth');
  d2Live.close();
  for (const t of [d2, S.dan]) assert.equal((await api('GET', '/api/me', undefined, t)).status, 401);
  assert.equal((await api('GET', '/api/me', undefined, d1)).data.sessions.others, 0);
  S.dan = d1;

  // a team with other people in it never disappears from under them
  assert.equal((await api('DELETE', '/api/me', { password: 'cara new pass' }, S.cara)).data.code, 'leads_team');
  assert.equal((await api('DELETE', '/api/me', { password: 'wrong' }, S.alice)).data.code, 'bad_password');
  assert.equal((await api('GET', '/api/me', undefined, S.cara)).status, 200);

  // deleting takes the teams only they were in, with their projects and images, and their place in other teams
  const erin = (await api('POST', '/api/auth/signup', { email: 'erin@studio.test', username: 'erin', password: 'correct horse' })).data;
  const solo = (await api('POST', '/api/teams', { name: 'Solo' }, erin.token)).data.team.id;
  const mine = (await api('POST', `/api/teams/${solo}/projects`, { name: 'Mine' }, erin.token)).data.project.id;
  const img = (await api('POST', `/api/projects/${mine}/assets`, PNG, erin.token, { 'Content-Type': 'image/png' })).data.id;
  assert.equal((await api('POST', `/api/teams/${S.team}/invites`, { who: 'erin', role: 'editor' }, S.alice)).status, 200);
  const inv = (await api('GET', '/api/me', undefined, erin.token)).data.invites[0].id;
  assert.equal((await api('POST', `/api/invites/${inv}/accept`, undefined, erin.token)).status, 200);
  const erinLive = await live(erin.token);
  assert.equal((await api('DELETE', '/api/me', { password: 'correct horse' }, erin.token)).status, 200);
  assert.equal((await erinLive.next(m => m.t === 'error')).code, 'auth');
  erinLive.close();
  assert.equal((await api('GET', '/api/me', undefined, erin.token)).status, 401);
  assert.equal((await api('POST', '/api/auth/login', { login: 'erin', password: 'correct horse' })).status, 401);
  assert.equal((await fetch(`${base}/assets/${img}`)).status, 404);
  await new Promise(r => setTimeout(r, 100));
  assert.ok(!fs.existsSync(path.join(DATA, 'assets', img)), 'the image file is removed from disk');
  assert.ok(!(await api('GET', `/api/teams/${S.team}`, undefined, S.alice)).data.members.some(m => m.username === 'erin'));
  assert.equal((await api('POST', '/api/auth/signup', { email: 'erin@studio.test', username: 'erin', password: 'correct horse' })).status, 200, 'the name and email are free again');
});

// signs in the way the website does, and returns its session cookie
async function webSignIn(url, login, password) {
  const r = await fetch(url + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-VB': '1' }, body: JSON.stringify({ login, password, web: true }) });
  assert.equal(r.status, 200);
  return 'vb_session=' + r.headers.getSetCookie().find(c => c.startsWith('vb_session=')).split(';')[0].slice('vb_session='.length);
}

test('mcp: access tokens, tools that read and map out a board, live for the team', async () => {
  const signup = async u => { const r = await api('POST', '/api/auth/signup', { email: u + '@studio.test', username: u, password: 'correct horse', displayName: u[0].toUpperCase() + u.slice(1) }); await confirmEmail(u + '@studio.test'); return r.data; };
  const maker = await signup('maker'), watcher = await signup('watcher');
  const call = async (token, method, params, extra = {}) => {
    const r = await fetch(base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...extra },
      body: JSON.stringify(method.startsWith('notifications/') ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: 7, method, params }) });
    return { status: r.status, data: r.status === 202 ? null : await r.json() };
  };
  const tool = async (token, name, args) => (await call(token, 'tools/call', { name, arguments: args })).data.result;

  // tokens take the password, and only open /mcp
  assert.equal((await call(null, 'initialize', {})).status, 401);
  assert.equal((await api('POST', '/api/me/tokens', { name: 'Desk', password: 'wrong one' }, maker.token)).data.code, 'bad_password');
  const made = await api('POST', '/api/me/tokens', { name: 'Desk', password: 'correct horse' }, maker.token);
  const token = made.data.token;
  assert.match(token, /^vbt_[\w-]{40,}$/);
  assert.equal(made.data.endpoint, 'http://localhost:9/mcp');
  assert.equal((await api('GET', '/api/me', undefined, token)).status, 401, 'a token is not a sign-in');
  const listed = (await api('GET', '/api/me/tokens', undefined, maker.token)).data.tokens;
  assert.deepEqual(listed.map(t => t.name), ['Desk']);
  assert.ok(!JSON.stringify(listed).includes(token.slice(4)), 'the token itself is never shown again');

  // the protocol
  const init = await call(token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.status, 200);
  assert.equal(init.data.result.protocolVersion, '2025-06-18');
  assert.equal(init.data.result.serverInfo.name, 'venom-board');
  assert.ok(init.data.result.capabilities.tools);
  assert.equal((await call(token, 'notifications/initialized', {})).status, 202);
  assert.equal((await fetch(base + '/mcp', { headers: { Authorization: 'Bearer ' + token, Accept: 'text/event-stream' } })).status, 405, 'no server-sent stream');
  assert.equal((await call(token, 'ping', {}, { Origin: 'https://evil.test' })).status, 403, 'web pages may not call it');
  assert.equal((await call(token, 'ping', {}, { 'MCP-Protocol-Version': '1999-01-01' })).status, 400);
  const names = (await call(token, 'tools/list', {})).data.result.tools.map(t => t.name);
  for (const n of ['list_projects', 'get_board', 'get_items', 'get_schedule', 'create_project', 'add_phase', 'add_cards', 'update_cards', 'link_cards', 'add_text', 'add_frames', 'add_image', 'add_video', 'add_drawing',
    'add_connectors', 'add_jam_clock', 'update_items', 'replace_media', 'move_items', 'arrange_items', 'duplicate_items', 'delete_items', 'add_comment', 'apply_template', 'save_version', 'restore_version']) assert.ok(names.includes(n), n);
  assert.equal((await call(token, 'nope/nothing', {})).data.error.code, -32601);

  // a team, with a teammate who can only view
  const team = (await api('POST', '/api/teams', { name: 'MCP Studio' }, maker.token)).data.team.id;
  await api('POST', `/api/teams/${team}/invites`, { who: 'watcher', role: 'viewer' }, maker.token);
  const inv = (await api('GET', '/api/me', undefined, watcher.token)).data.invites.find(i => i.team.id === team).id;
  await api('POST', `/api/invites/${inv}/accept`, undefined, watcher.token);
  const teams = (await tool(token, 'list_projects', {})).structuredContent.teams;
  assert.ok(teams.some(t => t.team_id === team && t.can_edit && t.your_role === 'leader'));

  // mapping out a project, live for the teammate who has it open
  const proj = (await tool(token, 'create_project', { team_id: team, name: 'Night Keep: vertical slice' })).structuredContent.project_id;
  const w = await live(watcher.token);
  w.send({ t: 'join', project: proj });
  await w.next(m => m.t === 'snapshot');
  const pre = (await tool(token, 'add_phase', { project_id: proj, title: '01 · Pre-production' })).structuredContent.phase_id;
  const proto = (await tool(token, 'add_phase', { project_id: proj, title: '02 · Prototype' })).structuredContent.phase_id;
  const ops = await w.next(m => m.t === 'ops');
  assert.equal(ops.ops[0].obj.title, '01 · Pre-production', 'the teammate sees it appear');
  const added = await tool(token, 'add_cards', { project_id: proj, phase_id: pre, cards: [
    { title: 'Core pillars', discipline: 'design', priority: 'must', estimate: '3d' },
    { title: 'Tech stack', discipline: 'tech', estimate: '1d' }] });
  assert.equal(added.structuredContent.added.length, 2);
  const added2 = await tool(token, 'add_cards', { project_id: proj, phase_id: proto, cards: [
    { title: 'Character controller', discipline: 'code', priority: 'must', estimate: '5d', waits_on: ['Core pillars', 'Tech stack'] },
    { title: 'Combat prototype', discipline: 'code', estimate: '1w', waits_on: ['Character controller'], notes: '[ ] Light attack\n[ ] Parry' },
    { title: 'Vertical slice', kind: 'milestone', due: '2030-01-15', waits_on: ['Combat prototype'] },
    { title: 'Camera clips through walls', kind: 'bug', severity: 'major' }] });
  assert.equal(added2.structuredContent.links, 4);
  const board = (await tool(token, 'get_board', { project_id: proj })).structuredContent;
  assert.deepEqual(board.phases.map(p => [p.title, p.cards.length]), [['01 · Pre-production', 2], ['02 · Prototype', 4]]);
  const cc = board.phases[1].cards.find(c => c.title === 'Character controller');
  assert.equal(cc.waits_on.length, 2);
  assert.equal(cc.discipline, 'code');
  assert.equal(board.phases[1].cards.find(c => c.title === 'Camera clips through walls').kind, 'bug');
  const plan = (await tool(token, 'get_schedule', { project_id: proj })).structuredContent;
  assert.deepEqual(plan.critical_path, ['Core pillars', 'Character controller', 'Combat prototype'], 'the chain that decides the finish date');
  assert.equal(plan.working_days_left, 13);
  assert.match(plan.finishes_around, /^\d{4}-\d{2}-\d{2}$/);
  // changes, links, comments and mistakes
  const upd = await tool(token, 'update_cards', { project_id: proj, updates: [{ card_id: 'Core pillars', status: 'done' }, { card_id: 'Tech stack', status: 'doing' }] });
  assert.deepEqual(upd.structuredContent.updated.map(u => u.status), ['done', 'doing']);
  assert.equal((await tool(token, 'link_cards', { project_id: proj, links: [{ from: 'Camera clips through walls', to: 'Vertical slice' }] })).structuredContent.linked, 1);
  assert.equal((await tool(token, 'add_comment', { project_id: proj, card_id: 'Combat prototype', text: 'Parry window feels short @watcher' })).structuredContent.commented, true);
  const bad = await tool(token, 'update_cards', { project_id: proj, updates: [{ card_id: 'Core pillars', status: 'finished-ish' }] });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /Unknown status/);
  assert.match((await tool(token, 'get_board', { project_id: 'nope' })).content[0].text, /list_projects/);
  // a viewer's token can read and comment, not change the board
  const wt = (await api('POST', '/api/me/tokens', { name: 'Laptop', password: 'correct horse' }, watcher.token)).data.token;
  assert.equal((await tool(wt, 'get_board', { project_id: proj })).structuredContent.your_role, 'viewer');
  const denied = await tool(wt, 'add_phase', { project_id: proj, title: 'Nope' });
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /viewer/);
  assert.equal((await tool(wt, 'add_comment', { project_id: proj, card_id: 'Vertical slice', text: 'Looks good' })).structuredContent.commented, true);
  // deleting, and what the activity feed recorded
  const del = await tool(token, 'delete_items', { project_id: proj, ids: [board.phases[1].cards.find(c => c.title === 'Camera clips through walls').id] });
  assert.equal(del.structuredContent.deleted, 2, 'the card and its arrow');
  const feed = await api('GET', `/api/projects/${proj}/activity`, undefined, maker.token);
  assert.ok(feed.data.items.length >= 1, "the changes show in the activity feed");
  w.close();
  // revoking: one token, then all of them when other sign-ins end
  await api('DELETE', `/api/me/tokens/${made.data.id}`, undefined, maker.token);
  assert.equal((await call(token, 'ping', {})).status, 401);
  assert.equal((await call(wt, 'ping', {})).status, 200);
  await api('POST', '/api/me/sign-out-others', {}, watcher.token);
  assert.equal((await call(wt, 'ping', {})).status, 401, 'ending other sign-ins ends tokens too');
});

test('mcp: every board tool: text, frames, pictures, videos, ink, connectors, layout, templates and versions', async () => {
  const http = require('http');
  const { imageSize, privateIp, parseVideoLink } = require('../src/mcp');
  const signup = async u => { const r = await api('POST', '/api/auth/signup', { email: u + '@studio.test', username: u, password: 'correct horse', displayName: u[0].toUpperCase() + u.slice(1) }); await confirmEmail(u + '@studio.test'); return r.data; };
  const art = await signup('artlead'), mate = await signup('animator');
  const token = (await api('POST', '/api/me/tokens', { name: 'Desk', password: 'correct horse' }, art.token)).data.token;
  const call = async (name, args) => {
    const r = await fetch(base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer ' + token }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    return (await r.json()).result;
  };
  const ok = async (name, args) => { const r = await call(name, args); assert.ok(!r.isError, `${name}: ${r.isError && r.content[0].text}`); return r.structuredContent || r; };
  const fails = async (name, args, re) => { const r = await call(name, args); assert.equal(r.isError, true, name + ' should fail'); assert.match(r.content[0].text, re); };

  // the pure helpers: picture sizes, private addresses, video links
  const wide = Buffer.from(PNG); wide.writeUInt32BE(800, 16); wide.writeUInt32BE(400, 20);
  assert.deepEqual(imageSize(wide), { w: 800, h: 400 });
  assert.deepEqual(imageSize(Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x40, 0x01, 0xf0, 0x00])), { w: 320, h: 240 });
  for (const ip of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '192.168.0.4', '172.20.0.1', '::1', '::ffff:127.0.0.1', 'fd00::1', '100.64.0.1']) assert.ok(privateIp(ip), ip);
  for (const ip of ['1.1.1.1', '104.16.0.1', '2606:4700::1']) assert.ok(!privateIp(ip), ip);
  assert.deepEqual(parseVideoLink('https://youtu.be/dQw4w9WgXcQ?t=3'), { p: 'yt', id: 'dQw4w9WgXcQ' });
  assert.deepEqual(parseVideoLink('https://vimeo.com/76979871'), { p: 'vimeo', id: '76979871' });

  const team = (await api('POST', '/api/teams', { name: 'Art Dept' }, art.token)).data.team.id;
  await api('POST', `/api/teams/${team}/invites`, { who: 'animator', role: 'editor' }, art.token);
  const inv = (await api('GET', '/api/me', undefined, mate.token)).data.invites.find(i => i.team.id === team).id;
  await api('POST', `/api/invites/${inv}/accept`, undefined, mate.token);

  // templates come from the app's own builder
  const tpls = (await ok('list_templates', {})).templates;
  const haveApp = fs.existsSync(path.join(APP_DIR, 'index.html'));
  if (haveApp) {
    assert.ok(tpls.length >= 12 && tpls.some(t => t.key === 'roadmap') && tpls.some(t => t.key === 'jam'), 'every template');
    const made = await ok('create_project', { team_id: team, name: 'From a template', template: 'sprint' });
    assert.ok(made.objects > 5);
    assert.ok((await ok('get_board', { project_id: made.project_id })).phases.length >= 4, 'the sprint columns');
  }
  const proj = (await ok('create_project', { team_id: team, name: 'Moodboard' })).project_id;
  assert.equal((await ok('rename_project', { project_id: proj, name: 'Night Keep moodboard' })).renamed, true);
  assert.ok((await ok('list_projects', {})).teams.find(t => t.team_id === team).projects.some(p => p.name === 'Night Keep moodboard'));

  // text and frames, live for a teammate
  const w = await live(mate.token);
  w.send({ t: 'join', project: proj });
  await w.next(m => m.t === 'snapshot');
  const texts = (await ok('add_text', { project_id: proj, texts: [{ text: 'Night Keep', size: 96, color: 'red', x: 0, y: -200 }, { text: 'Characters\nand creatures', size: 24 }] })).added;
  assert.equal((await w.next(m => m.t === 'ops')).ops[0].obj.text, 'Night Keep', 'the teammate sees it');
  await fails('add_text', { project_id: proj, texts: [{ text: 'x', color: 'blurple' }] }, /Colours look like/);

  // pictures: from a web address, from base64 data and from a file sent to an upload address
  const pics = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(wide); });
  await new Promise(r => pics.listen(0, '127.0.0.1', r));
  const fromUrl = (await ok('add_image', { project_id: proj, images: [{ url: `http://127.0.0.1:${pics.address().port}/castle.png`, x: 0, y: 0 }] })).added[0];
  pics.close();
  assert.deepEqual([fromUrl.w, fromUrl.h, fromUrl.name], [640, 320, 'castle.png'], 'natural shape, at most 640 wide');
  const fromData = (await ok('add_image', { project_id: proj, images: [{ data: 'data:image/png;base64,' + wide.toString('base64'), width: 200, name: 'Palette', gray: true }] })).added[0];
  assert.deepEqual([fromData.w, fromData.h], [200, 100]);
  await fails('add_image', { project_id: proj, images: [{ data: Buffer.from('not a picture').toString('base64') }] }, /PNG, JPEG, GIF or WebP/);
  const up = await ok('get_upload_url', { project_id: proj });
  assert.match(up.how, /curl/);
  const sent = await (await fetch(up.upload_url.replace('http://localhost:9', base), { method: 'PUT', body: wide })).json();
  assert.equal(sent.kind, 'image');
  assert.deepEqual([sent.width, sent.height], [800, 400]);
  assert.equal((await fetch(up.upload_url.replace('http://localhost:9', base), { method: 'PUT', body: wide })).status, 404, 'an upload address works once');
  const fromFile = (await ok('add_image', { project_id: proj, images: [{ upload_id: sent.upload_id, width: 400, flip: true }] })).added[0];
  const seen = await call('view_image', { project_id: proj, image_id: fromFile.id });
  assert.equal(seen.content[0].type, 'image');
  assert.equal(Buffer.from(seen.content[0].data, 'base64').length, wide.length);

  // videos: YouTube and Vimeo links, never video files while the server doesn't keep them
  const vids = (await ok('add_video', { project_id: proj, videos: [{ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', name: 'Reference walk cycle' }, { url: 'https://vimeo.com/76979871', width: 320, autoplay: true }] })).added;
  assert.deepEqual(vids.map(v => [v.plays_from, v.w, v.h]), [['YouTube', 480, 270], ['Vimeo', 320, 180]]);
  await fails('add_video', { project_id: proj, videos: [{ url: 'https://example.com/clip.mp4' }] }, /YouTube or Vimeo/);

  // frames around things, ink, connectors and a jam clock
  const frame = (await ok('add_frames', { project_id: proj, frames: [{ title: 'Castle refs', color: 'purple', around: [fromUrl.id, fromData.id] }] })).added[0];
  assert.ok(frame.x < fromUrl.x && frame.w > 640, 'it wraps the pictures');
  const ink = await ok('add_drawing', { project_id: proj, strokes: [{ shape: 'ellipse', x: 10, y: 10, w: 200, h: 100, color: 'yellow' }, { shape: 'arrow', points: [{ x: 700, y: 50 }, { x: 600, y: 120 }] },
    { tool: 'highlighter', points: [{ x: 0, y: 340 }, { x: 300, y: 342 }] }] });
  assert.equal(ink.drawn, 5, 'an ellipse, an arrow with a two-stroke head, a highlight');
  const conn = (await ok('add_connectors', { project_id: proj, connectors: [{ from: texts[0].id, to: fromUrl.id, style: 'elbow', dashed: true, label: 'mood', color: 'cyan' }, { from: fromData.id, to: { x: 900, y: 900 }, arrowheads: 'both', flow: true }] })).added;
  await ok('update_connectors', { project_id: proj, updates: [{ id: conn[0], style: 'straight', width: 5, label: 'tone' }] });
  const wire = (await ok('add_connectors', { project_id: proj, connectors: [{ from: texts[0].id, to: texts[1].id, style: 'circuit', via: [{ x: 300, y: -100 }, { x: 300, y: 40 }] }] })).added[0];
  const wired = (await ok('get_items', { project_id: proj, types: ['connector'] })).connectors.find(c => c.id === wire);
  assert.deepEqual([wired.style, wired.via], ['circuit', [{ x: 300, y: -100 }, { x: 300, y: 40 }]], 'circuit style and reroute points are kept');
  await fails('update_connectors', { project_id: proj, updates: [{ id: wire, via: [{ x: 'left' }] }] }, /reroute point/);
  await ok('update_connectors', { project_id: proj, updates: [{ id: wire, via: [] }] });
  assert.equal((await ok('get_items', { project_id: proj, types: ['connector'] })).connectors.find(c => c.id === wire).via, undefined, 'straightened');
  await ok('delete_items', { project_id: proj, ids: [wire] });
  const jam = await ok('add_jam_clock', { project_id: proj, deadline: '2030-11-22T18:00:00Z', theme: 'Keep the light', people: 3 });
  await fails('add_jam_clock', { project_id: proj, deadline: 'next friday' }, /date and time/);

  // reading it all back
  const all = await ok('get_items', { project_id: proj });
  const by = id => all.items.find(i => i.id === id);
  assert.deepEqual([by(texts[0].id).type, by(texts[0].id).size, by(texts[0].id).color], ['text', 96, '#ff2a4f']);
  assert.equal(by(fromData.id).gray, true);
  assert.equal(by(fromFile.id).flip, true);
  assert.match(by(vids[0].id).source, /youtube\.com\/watch\?v=dQw4w9WgXcQ/);
  assert.equal(by(jam.jam_clock_id).deadline, '2030-11-22T18:00:00.000Z');
  const c0 = all.connectors.find(c => c.id === conn[0]);
  assert.deepEqual([c0.style, c0.width, c0.label, c0.dashed], ['straight', 5, 'tone', true]);
  assert.deepEqual(all.connectors.find(c => c.id === conn[1]).to, { x: 900, y: 900 });
  assert.equal(all.strokes.length, 5);
  assert.equal((await ok('get_items', { project_id: proj, types: ['image'] })).items.length, 3);
  assert.equal((await ok('get_items', { project_id: proj, types: ['stroke'], area: { x: 680, y: 40, w: 30, h: 20 } })).strokes.length, 1, 'only the arrow line reaches there');

  // changing, moving, arranging, stacking, copying and deleting
  await ok('update_items', { project_id: proj, updates: [{ id: texts[1].id, text: 'Creatures', size: 40, color: '#3dff8b' }, { id: frame.id, title: 'Castle', locked: true }, { id: vids[1].id, loop: false }, { id: jam.jam_clock_id, theme: 'Embers' }] });
  const moved = await ok('move_items', { project_id: proj, ids: [frame.id], dx: 1000, dy: 0 });
  assert.ok(moved.moved >= 4, 'the frame, its pictures, the ink on them and a connector end');
  const after = await ok('get_items', { project_id: proj, ids: [fromUrl.id, frame.id, texts[1].id, vids[1].id, jam.jam_clock_id] });
  const ai = id => after.items.find(i => i.id === id);
  assert.equal(ai(fromUrl.id).x, fromUrl.x + 1000, 'the frame carried its picture');
  assert.deepEqual([ai(frame.id).locked, ai(frame.id).title, ai(texts[1].id).text, ai(texts[1].id).size, ai(vids[1].id).loop, ai(jam.jam_clock_id).theme], [true, 'Castle', 'Creatures', 40, false, 'Embers']);
  await ok('arrange_items', { project_id: proj, ids: [vids[0].id, vids[1].id, fromFile.id], mode: 'row', gap: 20 });
  const row = (await ok('get_items', { project_id: proj, ids: [vids[0].id, vids[1].id, fromFile.id] })).items;
  assert.equal(new Set(row.map(i => i.y)).size, 1, 'one row');
  assert.equal(row.find(i => i.id === vids[1].id).x, row.find(i => i.id === vids[0].id).x + 480 + 20);
  await ok('reorder_items', { project_id: proj, ids: [texts[0].id], to: 'back' });
  assert.equal((await ok('get_items', { project_id: proj })).items[0].id, texts[0].id, 'sent to the back');
  const copy = await ok('duplicate_items', { project_id: proj, ids: [texts[0].id, fromUrl.id], dy: 600 });
  assert.equal(copy.copies.length, 2);
  assert.equal((await ok('get_items', { project_id: proj, types: ['connector'] })).connectors.length, 3, 'the connector between them was copied too');
  const del = await ok('delete_items', { project_id: proj, ids: [copy.copies[1].id, ink.ids[0]] });
  assert.equal(del.deleted, 3, 'the copied picture, the copied connector to it and the ellipse');

  // planning bits: assignees by username, tracing, comments, activity, team
  const phase = await ok('add_phase', { project_id: proj, title: 'Art pass' });
  await ok('add_cards', { project_id: proj, phase_id: phase.phase_id, cards: [{ title: 'Paint castle keyart', discipline: 'art', estimate: '3d', assignees: ['animator'] }, { title: 'Animate the keeper', waits_on: ['Paint castle keyart'], assignees: ['@artlead', 'Animator'] }] });
  await fails('update_cards', { project_id: proj, updates: [{ card_id: 'Animate the keeper', assignees: ['nobody'] }] }, /get_team/);
  const cards = (await ok('get_items', { project_id: proj, types: ['card'] })).items;
  assert.deepEqual(cards.find(c => c.title === 'Animate the keeper').assignees.sort(), ['Animator', 'Artlead']);
  assert.equal(cards.find(c => c.title === 'Paint castle keyart').color, '#a66bff', 'art colour');
  await ok('update_cards', { project_id: proj, updates: [{ card_id: 'Paint castle keyart', color: 'pink' }] });
  await ok('update_cards', { project_id: proj, updates: [{ card_id: 'Paint castle keyart', status: 'doing' }] });
  assert.equal((await ok('get_items', { project_id: proj, types: ['card'] })).items.find(c => c.title === 'Paint castle keyart').color, '#ff4fd8', 'a chosen colour stays');
  const tr = await ok('trace_card', { project_id: proj, card_id: 'Animate the keeper' });
  assert.deepEqual(tr.waits_on.map(r => r.title), ['Paint castle keyart']);
  assert.equal(tr.unfinished_before_it, 1);
  assert.deepEqual((await ok('get_board', { project_id: proj })).summary.ready_to_start, ['Paint castle keyart']);
  await ok('add_comment', { project_id: proj, card_id: 'Animate the keeper', text: 'Reference the walk cycle video' });
  assert.equal((await ok('get_comments', { project_id: proj, card_id: 'Animate the keeper' })).comments[0].by, 'Artlead');
  assert.ok((await ok('get_activity', { project_id: proj })).activity.some(e => /added “Animate the keeper”/.test(e.what)));
  assert.deepEqual((await ok('get_team', { project_id: proj })).members.map(m => m.username).sort(), ['animator', 'artlead']);
  assert.ok(Array.isArray((await ok('search', { query: 'keyart' })).results));

  // version history: save, change, restore
  const saved = await ok('save_version', { project_id: proj, label: 'Before the cut' });
  await ok('delete_items', { project_id: proj, ids: [fromFile.id] });
  assert.ok((await ok('list_versions', { project_id: proj })).versions.some(v => v.version_id === saved.version_id && v.label === 'Before the cut'));
  await ok('restore_version', { project_id: proj, version_id: saved.version_id });
  assert.equal((await ok('get_items', { project_id: proj, ids: [fromFile.id] })).items.length, 1, 'the picture is back');

  // replacing: a picture for another (same id, its shape), a picture for a YouTube video (a new id, connectors follow, same place in the stack)
  const tall = Buffer.from(PNG); tall.writeUInt32BE(300, 16); tall.writeUInt32BE(600, 20);
  const r1 = await ok('replace_media', { project_id: proj, id: fromData.id, data: tall.toString('base64'), name: 'Tall palette' });
  assert.deepEqual([r1.id, r1.type, r1.w, r1.h, r1.name], [fromData.id, 'image', 200, 400, 'Tall palette']);
  const r1b = (await ok('get_items', { project_id: proj, ids: [fromData.id] })).items[0];
  assert.equal(r1b.gray, true, 'its greyscale setting stays');
  assert.equal(r1b.y, fromData.y - 150, 'it keeps its centre');
  const stack = (await ok('get_items', { project_id: proj })).items.map(i => i.id);
  const r2 = await ok('replace_media', { project_id: proj, id: fromUrl.id, url: 'https://youtu.be/dQw4w9WgXcQ' });
  assert.notEqual(r2.id, fromUrl.id);
  assert.deepEqual([r2.type, r2.plays_from, r2.w, r2.h], ['video', 'YouTube', 640, 360]);
  const swapped = await ok('get_items', { project_id: proj });
  assert.equal(swapped.items.map(i => i.id).indexOf(r2.id), stack.indexOf(fromUrl.id), 'the same place in the stack');
  assert.ok(!swapped.items.some(i => i.id === fromUrl.id), 'the picture is gone');
  assert.ok(swapped.connectors.some(c => c.to === r2.id), 'the connector to it followed');
  const r3 = await ok('replace_media', { project_id: proj, id: r2.id, upload_id: sent.upload_id, keep_size: true });
  assert.deepEqual([r3.type, r3.w, r3.h], ['image', 640, 360], 'back to a picture, at the exact size asked');
  await fails('replace_media', { project_id: proj, id: texts[0].id, url: 'https://youtu.be/dQw4w9WgXcQ' }, /No picture or video/);
  await fails('replace_media', { project_id: proj, id: r3.id, url: 'https://example.com/clip.mp4' }, /YouTube or Vimeo/);

  // templates go in free space on an existing board
  if (haveApp) {
    const t = await ok('apply_template', { project_id: proj, template: 'moodboard' });
    assert.ok(t.added > 5);
    assert.ok((await ok('get_items', { project_id: proj, types: ['frame'] })).items.filter(f => f.x >= t.area.x).length >= 4, 'its frames, to the right of the board');
    await fails('apply_template', { project_id: proj, template: 'nope' }, /list_templates/);
  }
  w.close();
});

test('sign-up limits: mistakes in the form use a generous allowance, accounts made use the strict one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'venom-board-signup-'));
  const s2 = await start({ PORT: '0', DATA_DIR: dir, PUBLIC_URL: 'http://localhost:9', QUIET: 'true', RATE_SCALE: '1', MIN_FREE_DISK_MB: '0' }, { mail: async () => true });
  const su = (body, ip = '203.0.113.50') => fetch(`http://127.0.0.1:${s2.port}/api/auth/signup`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Real-IP': ip }, body: JSON.stringify(body) })
    .then(async r => ({ status: r.status, data: await r.json() }));
  try {
    // a dozen mistakes in a row don't lock anyone out
    for (let i = 0; i < 4; i++) {
      assert.equal((await su({ email: 'not-an-email', username: 'sam', password: 'correct horse' })).status, 400);
      assert.equal((await su({ email: 'sam@studio.test', username: 's', password: 'correct horse' })).status, 400);
      assert.equal((await su({ email: 'sam@studio.test', username: 'sam', password: 'short' })).status, 400);
    }
    assert.equal((await su({ email: 'sam@studio.test', username: 'sam', password: 'correct horse' })).status, 200);
    assert.equal((await su({ email: 'sam2@studio.test', username: 'sam', password: 'correct horse' })).data.code, 'username_taken');
    // ten new accounts from one network in ten minutes, then a pause; other networks carry on
    for (let i = 1; i < 10; i++) assert.equal((await su({ email: `p${i}@studio.test`, username: `player${i}`, password: 'correct horse' })).status, 200, 'account ' + i);
    assert.equal((await su({ email: 'p10@studio.test', username: 'player10', password: 'correct horse' })).status, 429);
    // once paused, an address with an account and one without get the same answer, so nothing can be looked up
    const known = await su({ email: 'sam@studio.test', username: 'fresh1', password: 'correct horse' });
    const unknown = await su({ email: 'nobody@studio.test', username: 'fresh2', password: 'correct horse' });
    assert.deepEqual([known.status, known.data.code, known.data.error], [unknown.status, unknown.data.code, unknown.data.error]);
    assert.equal((await su({ email: 'p10@studio.test', username: 'player10', password: 'correct horse' }, '198.51.100.20')).status, 200);
    assert.equal((await su({ email: 'sam@studio.test', username: 'fresh3', password: 'correct horse' }, '198.51.100.21')).data.code, 'email_taken');
  } finally { await s2.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
