// End-to-end tests for the team features: members on the board, comments and mentions, notifications,
// activity, Discord, versions, share links, search, reminders, two-step sign-in, videos and the email budget.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { start } = require('../src/index');
const T = require('../src/totp');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'venom-board-collab-'));
const APPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'venom-board-app-'));
fs.writeFileSync(path.join(APPDIR, 'index.html'), '<!doctype html><title>Venom Board</title>');
const mail = [], discord = [];
let srv, base, discordStatus = 204;
const fakeFetch = async (url, opts) => { discord.push({ url, body: JSON.parse(opts.body) }); return { ok: discordStatus < 300, status: discordStatus }; };
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

test.before(async () => {
  srv = await start({ PORT: '0', DATA_DIR: DATA, PUBLIC_URL: 'http://localhost:9', QUIET: 'true', MAIL_PER_10_MIN: '100000', RATE_SCALE: '50', MIN_FREE_DISK_MB: '0',
    DISCORD_DELAY_MS: '40', SEARCH_INDEX_DELAY_MS: '30', APP_DIR: APPDIR, VIDEO_UPLOADS: 'on', MAIL_FROM: 'Venom Board <support@studio.test>' }, { mail: async m => { mail.push(m); return true; }, fetch: fakeFetch });
  base = `http://127.0.0.1:${srv.port}`;
  for (const u of ['vee', 'nyx', 'kip', 'out']) {
    const r = await api('POST', '/api/auth/signup', { email: u + '@studio.test', username: u, password: 'correct horse', displayName: u[0].toUpperCase() + u.slice(1) });
    S[u] = r.data.token; S[u + 'Id'] = r.data.user.id;
    await api('POST', '/api/auth/verify', { token: linkFrom(u + '@studio.test', 'verify') });
  }
  S.team = (await api('POST', '/api/teams', { name: 'Night Keep' }, S.vee)).data.team.id;
  for (const [u, role] of [['nyx', 'editor'], ['kip', 'viewer']]) {
    await api('POST', `/api/teams/${S.team}/invites`, { who: u, role }, S.vee);
    const inv = (await api('GET', '/api/me', undefined, S[u])).data.invites[0].id;
    await api('POST', `/api/invites/${inv}/accept`, undefined, S[u]);
  }
  S.project = (await api('POST', `/api/teams/${S.team}/projects`, { name: 'Slice', doc: { items: [card('c1', { title: 'Boss arena blockout', body: 'Greybox the café arena' })] } }, S.vee)).data.project.id;
});
test.after(async () => { await srv.close(); for (const d of [DATA, APPDIR]) fs.rmSync(d, { recursive: true, force: true }); });

test('members: boards know who is in the team and hear about changes', async () => {
  const a = await joined(S.vee, S.project);
  assert.deepEqual(a.snapshot.members.map(m => m.username).sort(), ['kip', 'nyx', 'vee']);
  assert.ok(a.snapshot.members.every(m => m.name && m.color && m.role));
  assert.equal((await api('PATCH', `/api/teams/${S.team}/members/${S.kipId}`, { role: 'editor' }, S.vee)).status, 200);
  assert.equal((await a.next(m => m.t === 'members')).members.find(m => m.username === 'kip').role, 'editor');
  await api('PATCH', `/api/teams/${S.team}/members/${S.kipId}`, { role: 'viewer' }, S.vee);
  await api('PATCH', '/api/me', { displayName: 'Nyx Prime' }, S.nyx);
  assert.ok((await a.next(m => m.t === 'members' && m.members.some(x => x.name === 'Nyx Prime'))));
  a.close();
});

test('comments: the server sets the author, viewers can comment, only authors edit', async () => {
  const [v, n, k] = await Promise.all([joined(S.vee, S.project), joined(S.nyx, S.project), joined(S.kip, S.project)]);
  // a viewer can comment (and claiming to be someone else doesn't work)
  k.send({ t: 'ops', batch: 1, ops: [{ k: 'comments', op: 'put', obj: { id: 'k1', card: 'c1', text: 'Looks great', by: S.veeId, at: 1 } }] });
  assert.equal((await k.next(m => m.t === 'ack')).batch, 1);
  const got = (await v.next(m => m.t === 'ops' && m.ops[0].k === 'comments')).ops[0].obj;
  assert.equal(got.by, S.kipId); assert.ok(got.at > Date.now() - 5000);
  assert.equal((await k.next(m => m.t === 'ops')).ops[0].obj.by, S.kipId, 'the author gets the stored version back');
  // ...but still can't change the board
  k.send({ t: 'ops', batch: 2, ops: [{ k: 'items', op: 'del', id: 'c1' }] });
  assert.equal((await k.next(m => m.t === 'error')).code, 'read_only');
  // nobody else can edit someone's comment; their copy is put right
  n.send({ t: 'ops', batch: 3, ops: [{ k: 'comments', op: 'put', obj: { id: 'k1', card: 'c1', text: 'hijacked' } }] });
  assert.equal((await n.next(m => m.t === 'snapshot')).doc.comments.find(c => c.id === 'k1').text, 'Looks great');
  // the author can edit it (marked edited), and a team admin can delete it
  k.send({ t: 'ops', batch: 4, ops: [{ k: 'comments', op: 'put', obj: { id: 'k1', card: 'c1', text: 'Looks great!' } }] });
  assert.ok((await v.next(m => m.t === 'ops' && m.ops[0].obj && m.ops[0].obj.text === 'Looks great!')).ops[0].obj.edited);
  v.send({ t: 'ops', batch: 5, ops: [{ k: 'comments', op: 'del', id: 'k1' }] });
  assert.equal((await k.next(m => m.t === 'ops' && m.ops[0].op === 'del')).ops[0].id, 'k1');
  for (const c of [v, n, k]) c.close();
});

test('time logs: entries belong to whoever logged them; nobody logs or deletes time as someone else', async () => {
  const [v, n] = await Promise.all([joined(S.vee, S.project), joined(S.nyx, S.project)]);
  const t0 = Date.now() - 3600e3, put = (c, batch, extra) => c.send({ t: 'ops', batch, ops: [{ k: 'items', op: 'put', obj: card('c1', { title: 'Boss arena blockout', ...extra }) }] });
  const next = c => c.next(m => m.t === 'ops' && m.by && m.ops[0].k === 'items' && m.ops[0].obj.id === 'c1').then(m => m.ops[0].obj);  // a teammate's edit, not our own coming back
  // Nyx logs 30 minutes and tries to pass a second entry off as Vee's; broken entries are dropped
  put(n, 1, { spent: 75, log: [{ id: 'e1', by: S.nyxId, at: t0, mins: 30, note: 'greybox' }, { id: 'e2', by: S.veeId, at: t0, mins: 45 }, { id: 'bad', at: 5, mins: 10 }, { id: 'big', at: t0, mins: 5000 }] });
  let got = await next(v);
  assert.deepEqual(got.log.map(e => [e.id, e.by, e.mins]), [['e1', S.nyxId, 30], ['e2', S.nyxId, 45]], 'new entries are always the editor’s own');
  assert.equal(got.log[0].note, 'greybox');
  // Vee logs 20 minutes on top
  put(v, 2, { spent: 95, log: [...got.log, { id: 'e3', by: S.veeId, at: t0, mins: 20 }] });
  got = await next(n);
  assert.deepEqual(got.log.map(e => e.id), ['e1', 'e2', 'e3']);
  // Nyx can remove their own entry, but can't remove or change Vee's
  put(n, 3, { spent: 50, log: [{ id: 'e1', by: S.nyxId, at: t0, mins: 30 }, { id: 'e3', by: S.veeId, at: t0, mins: 600 }] });
  got = await next(v);
  assert.deepEqual(got.log.map(e => [e.id, e.mins]), [['e1', 30], ['e3', 20]], 'e2 (Nyx’s) went; e3 (Vee’s) is as it was');
  put(n, 4, { spent: 30, log: [{ id: 'e1', by: S.nyxId, at: t0, mins: 30 }] });
  got = await next(v);
  assert.deepEqual(got.log.map(e => e.id), ['e1', 'e3'], 'leaving Vee’s entry out doesn’t delete it');
  assert.equal(got.spent, 50, 'and Vee’s 20 minutes stay in the total');
  // not even the team leader removes someone else's time: a copy that hasn't seen an entry keeps it, and adds to the total
  put(v, 5, { spent: 40, log: [{ id: 'e3', by: S.veeId, at: t0, mins: 20 }, { id: 'e4', by: S.veeId, at: t0, mins: 20 }] });
  got = await next(n);
  assert.deepEqual(got.log.map(e => [e.id, e.by]), [['e1', S.nyxId], ['e3', S.veeId], ['e4', S.veeId]]);
  assert.equal(got.spent, 70);
  const back = (await v.next(m => m.t === 'ops' && m.by === '' && m.ops[0].obj && m.ops[0].obj.id === 'c1')).ops[0].obj;
  assert.deepEqual(back.log.map(e => e.id), ['e1', 'e3', 'e4'], 'and Vee gets the stored card back, with Nyx’s entry');
  // an app from before time logs sends the card without one: the log stays as it was
  put(n, 6, { spent: 70, title: 'Boss arena blockout (v2)' });
  got = await next(v);
  assert.equal(got.title, 'Boss arena blockout (v2)');
  assert.deepEqual(got.log.map(e => e.id), ['e1', 'e3', 'e4'], 'an edit that knows nothing of logs keeps them');
  // and emptying your own log (an empty list) removes your entries
  put(n, 7, { spent: 40, log: [{ id: 'e3', by: S.veeId, at: t0, mins: 20 }, { id: 'e4', by: S.veeId, at: t0, mins: 20 }] });
  got = await next(v);
  assert.deepEqual(got.log.map(e => e.id), ['e3', 'e4'], 'Nyx removed their last entry');
  for (const c of [v, n]) c.close();
});

test('planned time and start dates: plans belong to whoever made them, and a start date stays until it is cleared', async () => {
  const [v, n] = await Promise.all([joined(S.vee, S.project), joined(S.nyx, S.project)]);
  const ahead = Date.now() + 86400e3, put = (c, batch, extra) => c.send({ t: 'ops', batch, ops: [{ k: 'items', op: 'put', obj: card('c2', { title: 'Lighting pass', ...extra }) }] });
  const next = c => c.next(m => m.t === 'ops' && m.by && m.ops[0].k === 'items' && m.ops[0].obj.id === 'c2').then(m => m.ops[0].obj);
  // Nyx plans two hours tomorrow (planned time can be ahead) and sets a start date; a block passed off as Vee's is Nyx's
  put(n, 1, { start: '2030-01-07', plan: [{ id: 'p1', by: S.nyxId, at: ahead, mins: 120, note: 'fog' }, { id: 'p2', by: S.veeId, at: ahead, mins: 60 }] });
  let got = await next(v);
  assert.deepEqual(got.plan.map(e => [e.id, e.by, e.mins]), [['p1', S.nyxId, 120], ['p2', S.nyxId, 60]], 'new planned blocks are the editor’s own');
  assert.equal(got.plan[0].note, 'fog');
  assert.equal(got.start, '2030-01-07');
  assert.ok(!got.spent, 'planned time isn’t tracked time');
  // Vee plans an hour; Nyx moves their own block and drops one, and a copy without Vee's block doesn't remove it
  put(v, 2, { start: '2030-01-07', plan: [...got.plan, { id: 'p3', by: S.veeId, at: ahead, mins: 60 }] });
  got = await next(n);
  assert.deepEqual(got.plan.map(e => e.id), ['p1', 'p2', 'p3']);
  put(n, 3, { start: '2030-01-07', plan: [{ id: 'p1', by: S.nyxId, at: ahead + 3600e3, mins: 90 }] });
  got = await next(v);
  assert.deepEqual(got.plan.map(e => [e.id, e.mins]), [['p1', 90], ['p3', 60]], 'p1 changed and p2 went (Nyx’s); p3 (Vee’s) is as it was');
  const back = (await n.next(m => m.t === 'ops' && m.by === '' && m.ops[0].obj && m.ops[0].obj.id === 'c2' && (m.ops[0].obj.plan || []).some(e => e.id === 'p1' && e.mins === 90))).ops[0].obj;  // the echo of that edit
  assert.deepEqual(back.plan.map(e => e.id), ['p1', 'p3'], 'and Nyx gets the stored card back, with Vee’s block');
  // an app from before start dates and planned time sends neither: both stay
  put(n, 4, { title: 'Lighting pass (v2)' });
  got = await next(v);
  assert.equal(got.title, 'Lighting pass (v2)');
  assert.equal(got.start, '2030-01-07', 'an edit that knows nothing of start dates keeps it');
  assert.deepEqual(got.plan.map(e => e.id), ['p1', 'p3'], 'and keeps the planned time');
  // a start date that isn't a date is dropped, a new one replaces it, and an empty one clears it
  put(v, 5, { start: 'soon', plan: got.plan });
  got = await next(n);
  assert.ok(!got.start, 'a start date that isn’t a date: ' + got.start);
  put(v, 6, { start: '2030-02-01', plan: got.plan });
  got = await next(n);
  assert.equal(got.start, '2030-02-01');
  put(v, 7, { start: '', plan: got.plan });
  got = await next(n);
  assert.ok(!got.start, 'an empty start date clears it');
  for (const c of [v, n]) c.close();
});

test('presenting: editors and up only, not over and over, and nobody passes for someone else', async () => {
  const [v, n, k] = await Promise.all([joined(S.vee, S.project), joined(S.nyx, S.project), joined(S.kip, S.project)]);
  const peer = (c, uid, t = 'presence') => c.next(m => m.t === t && m.peer.uid === uid).then(m => m.peer);
  // a viewer can't make everyone follow them, and nothing they send changes who they are
  k.send({ t: 'presence', presenting: true, name: 'Vee', username: 'vee', uid: S.veeId, role: 'leader', x: 5, y: 5 });
  const pk = await peer(v, S.kipId);
  assert.equal(pk.presenting, undefined);
  assert.deepEqual([pk.name, pk.username, pk.role], ['Kip', 'kip', 'viewer']);
  // an editor can present
  n.send({ t: 'presence', presenting: true });
  assert.equal((await peer(v, S.nyxId)).presenting, true);
  // made a viewer while presenting: it stops for everyone
  await api('PATCH', `/api/teams/${S.team}/members/${S.nyxId}`, { role: 'viewer' }, S.vee);
  assert.equal((await peer(v, S.nyxId, 'peer')).presenting, undefined);
  await api('PATCH', `/api/teams/${S.team}/members/${S.nyxId}`, { role: 'editor' }, S.vee);
  await peer(v, S.nyxId, 'peer');
  // and starting again straight away doesn't take everyone's view again
  n.send({ t: 'presence', presenting: true });
  assert.equal((await peer(v, S.nyxId)).presenting, undefined);
  for (const c of [v, n, k]) c.close();
});

test('mentions and assignments: notifications, emails that respect settings, unsubscribe links', async () => {
  const n = await joined(S.nyx, S.project), v = await live(S.vee);
  n.send({ t: 'ops', batch: 1, ops: [{ k: 'comments', op: 'put', obj: { id: 'm1', card: 'c1', text: 'Hey @vee and @OUT, can you check this? @nobody' } }] });
  const pushed = await v.next(m => m.t === 'notify');
  assert.equal(pushed.n.kind, 'mention'); assert.equal(pushed.n.fromName, 'Nyx Prime'); assert.equal(pushed.n.cardId, 'c1');
  const email = mail.filter(m => m.to === 'vee@studio.test' && /mentioned you/.test(m.subject)).pop();
  assert.ok(email, 'a mention email went out');
  assert.match(email.text, /#p=[\w-]+&c=c1/);
  assert.ok(!mail.some(m => m.to === 'out@studio.test' && /mentioned/.test(m.subject)), 'people outside the team are never emailed');
  const notes = (await api('GET', '/api/notifications', undefined, S.vee)).data;
  assert.equal(notes.unread, 1);
  assert.equal((await api('POST', '/api/notifications/read', { all: true }, S.vee)).data.unread, 0);

  // assigning someone notifies them in the app
  n.send({ t: 'ops', batch: 2, ops: [{ k: 'items', op: 'put', obj: card('c1', { title: 'Boss arena blockout', body: 'Greybox the café arena', assignees: [S.veeId, S.nyxId] }) }] });
  assert.equal((await v.next(m => m.t === 'notify')).n.kind, 'assigned');

  // the unsubscribe link only asks when opened; the button turns mention emails off
  const link = email.text.match(/(http:\/\/localhost:9\/unsubscribe\?\S+)/)[1].replace('http://localhost:9', '');
  const page = await fetch(base + link);
  assert.match(await page.text(), /Turn them off/);
  assert.equal((await api('GET', '/api/me', undefined, S.vee)).data.notify.mentions, true, 'opening the link changed nothing');
  await fetch(base + link, { method: 'POST' });
  assert.equal((await api('GET', '/api/me', undefined, S.vee)).data.notify.mentions, false);
  const before = mail.length;
  n.send({ t: 'ops', batch: 3, ops: [{ k: 'comments', op: 'put', obj: { id: 'm2', card: 'c1', text: '@vee again' } }] });
  await v.next(m => m.t === 'notify');
  assert.equal(mail.slice(before).filter(m => m.to === 'vee@studio.test').length, 0, 'no email once turned off');
  assert.equal((await fetch(base + link.replace(/t=[^&]+/, 't=forged'), { method: 'POST' })).status, 200);
  await api('PATCH', '/api/me', { notifyMentions: true }, S.vee);
  n.close(); v.close();
});

test('activity: what happened, gathered into readable lines, live', async () => {
  const v = await joined(S.vee, S.project), n = await joined(S.nyx, S.project);
  n.send({ t: 'ops', batch: 1, ops: [card('a1'), card('a2'), card('a3')].map(obj => ({ k: 'items', op: 'put', obj })) });
  await n.next(m => m.t === 'ack');
  n.send({ t: 'ops', batch: 2, ops: [{ k: 'items', op: 'put', obj: card('ms', { kind: 'milestone', title: 'Vertical slice' }) }] });
  await n.next(m => m.t === 'ack');
  // a card that's created already finished is "added"; finishing one is news
  n.send({ t: 'ops', batch: 3, ops: [{ k: 'items', op: 'put', obj: card('a1', { status: 'done' }) }, { k: 'items', op: 'put', obj: card('ms', { kind: 'milestone', title: 'Vertical slice', status: 'done' }) }] });
  await n.next(m => m.t === 'ack');
  const items = (await api('GET', `/api/projects/${S.project}/activity`, undefined, S.kip)).data.items;
  const created = items.find(i => i.kind === 'created' && i.count >= 3);
  assert.ok(created, 'three new cards make one line'); assert.match(created.color, /^#[0-9a-f]{6}$/);
  assert.ok(items.some(i => i.kind === 'done' && i.text === 'Card a1'));
  assert.ok(items.some(i => i.kind === 'milestone' && i.text === 'Vertical slice'));
  assert.ok(await v.next(m => m.t === 'activity' && m.entry.kind === 'milestone'));
  v.close(); n.close();
});

test('discord: only real webhook links, chosen events, no pings, and it stops when the webhook is gone', async () => {
  assert.equal((await api('PATCH', `/api/teams/${S.team}/integrations`, { discordWebhook: 'https://evil.test/api/webhooks/1/x' }, S.vee)).data.code, 'webhook');
  assert.equal((await api('PATCH', `/api/teams/${S.team}/integrations`, { discordWebhook: 'https://discord.com/api/webhooks/123456/abc' }, S.nyx)).status, 403, 'editors cannot');
  const hook = 'https://discord.com/api/webhooks/1234567890/' + 'x'.repeat(40);
  const set = await api('PATCH', `/api/teams/${S.team}/integrations`, { discordWebhook: hook, discordEvents: ['done', 'milestone'] }, S.vee);
  assert.deepEqual(set.data.discord, { connected: true, hint: '…xxxxxx', events: ['done', 'milestone'] });
  assert.equal((await api('GET', `/api/teams/${S.team}`, undefined, S.vee)).data.integrations.discord.connected, true);
  assert.equal((await api('GET', `/api/teams/${S.team}`, undefined, S.nyx)).data.integrations, undefined, 'only admins see it');
  assert.equal((await api('POST', `/api/teams/${S.team}/integrations/test`, undefined, S.vee)).status, 200);
  assert.match(discord.pop().body.content, /connected/);

  const n = await joined(S.nyx, S.project);
  n.send({ t: 'ops', batch: 1, ops: [{ k: 'items', op: 'put', obj: card('d1', { title: '@everyone *free nitro*' }) }, { k: 'items', op: 'put', obj: card('d2') }] });
  await n.next(m => m.t === 'ack');
  n.send({ t: 'ops', batch: 4, ops: [{ k: 'items', op: 'put', obj: card('d1', { title: '@everyone *free nitro*', status: 'done' }) }, { k: 'items', op: 'put', obj: card('d2', { status: 'done' }) }] });
  await n.next(m => m.t === 'ack');
  await wait(150);
  const post = discord.pop();
  assert.equal(post.url, hook);
  assert.deepEqual(post.body.allowed_mentions, { parse: [] });
  assert.equal(post.body.content.split('\n').length, 2, 'two events, one message');
  assert.match(post.body.content, /\\\*free nitro\\\*/, 'markdown in titles is escaped');
  // comments aren't one of the chosen events
  n.send({ t: 'ops', batch: 2, ops: [{ k: 'comments', op: 'put', obj: { id: 'dc', card: 'd2', text: 'nice' } }] });
  await n.next(m => m.t === 'ack'); await wait(150);
  assert.equal(discord.length, 0);
  // Discord says the webhook is gone: it's switched off
  discordStatus = 404;
  n.send({ t: 'ops', batch: 3, ops: [{ k: 'items', op: 'put', obj: card('d3') }] });
  await n.next(m => m.t === 'ack');
  n.send({ t: 'ops', batch: 5, ops: [{ k: 'items', op: 'put', obj: card('d3', { status: 'done' }) }] });
  await n.next(m => m.t === 'ack'); await wait(150);
  assert.equal((await api('GET', `/api/teams/${S.team}`, undefined, S.vee)).data.integrations.discord.connected, false);
  discordStatus = 204; discord.length = 0;
  n.close();
});

test('versions: automatic and named versions, restore for everyone, and undoing a restore', async () => {
  const v = await joined(S.vee, S.project), n = await joined(S.nyx, S.project);
  const autos = (await api('GET', `/api/projects/${S.project}/versions`, undefined, S.kip)).data.items.filter(x => x.auto);
  assert.ok(autos.length >= 1, 'the first edit kept the board as it was');
  const named = await api('POST', `/api/projects/${S.project}/versions`, { label: 'Before the boss rework' }, S.nyx);
  assert.equal(named.data.version.label, 'Before the boss rework');
  assert.equal((await api('POST', `/api/projects/${S.project}/versions`, { label: 'x' }, S.kip)).status, 403, 'viewers cannot');
  n.send({ t: 'ops', batch: 1, ops: [{ k: 'items', op: 'del', id: 'c1' }] });
  await n.next(m => m.t === 'ack');
  const old = (await api('GET', `/api/projects/${S.project}/versions/${named.data.version.id}`, undefined, S.kip)).data;
  assert.ok(old.doc.items.some(i => i.id === 'c1'));
  assert.equal((await api('POST', `/api/projects/${S.project}/versions/${named.data.version.id}/restore`, undefined, S.nyx)).status, 200);
  assert.equal((await v.next(m => m.t === 'restored')).by, 'Nyx Prime');
  assert.ok((await v.next(m => m.t === 'snapshot')).doc.items.some(i => i.id === 'c1'), 'everyone gets the restored board');
  const list = (await api('GET', `/api/projects/${S.project}/versions`, undefined, S.vee)).data.items;
  assert.ok(list.some(x => /^Before restoring/.test(x.label)), 'the board before the restore was kept too');
  assert.equal((await api('DELETE', `/api/projects/${S.project}/versions/${named.data.version.id}`, undefined, S.nyx)).status, 403, 'only admins delete versions');
  assert.equal((await api('DELETE', `/api/projects/${S.project}/versions/${named.data.version.id}`, undefined, S.vee)).status, 200);
  v.close(); n.close();
});

test('share links: read-only watching without an account, unseen, and turned off instantly', async () => {
  assert.equal((await api('POST', `/api/projects/${S.project}/share`, undefined, S.nyx)).status, 403, 'only admins make links');
  const url = (await api('POST', `/api/projects/${S.project}/share`, undefined, S.vee)).data.url;
  const token = url.split('/v/')[1];
  assert.equal((await api('GET', `/api/projects/${S.project}/share`, undefined, S.kip)).data.url, url);
  const page = await fetch(`${base}/v/${token}`);
  assert.equal(page.status, 200); assert.match(page.headers.get('x-robots-tag'), /noindex/); assert.equal(page.headers.get('referrer-policy'), 'no-referrer');

  const w = await socket({ t: 'watch', token });
  const snap = await w.next(m => m.t === 'snapshot');
  assert.equal(snap.role, 'link'); assert.deepEqual(snap.peers, []); assert.equal(snap.project.teamId, '');
  assert.ok(snap.members.every(m => !m.username && !m.role), 'watchers only see display names');
  const n = await joined(S.nyx, S.project);
  assert.ok(!n.snapshot.peers.length || n.snapshot.peers.every(p => p.uid), 'watchers are not listed as people');
  n.send({ t: 'ops', batch: 1, ops: [{ k: 'items', op: 'put', obj: card('w1') }] });
  assert.equal((await w.next(m => m.t === 'ops')).ops[0].obj.id, 'w1', 'they see edits live');
  n.send({ t: 'presence', x: 1, y: 2 });
  assert.ok(await w.none(m => m.t === 'presence'), 'but never anyone’s cursor');
  w.send({ t: 'ops', batch: 9, ops: [{ k: 'items', op: 'del', id: 'w1' }] });
  assert.ok(await n.none(m => m.t === 'ops'), 'and cannot change anything');
  // reports reach the support inbox
  assert.equal((await api('POST', `/api/view/${token}/report`, { reason: 'spam' })).status, 200);
  assert.ok(mail.some(m => m.to === 'support@studio.test' && /reported/.test(m.subject)));
  // a new link replaces the old one, which stops working at once
  const again = (await api('POST', `/api/projects/${S.project}/share`, undefined, S.vee)).data.url;
  assert.notEqual(again, url);
  assert.equal((await w.next(m => m.t === 'error')).code, 'link');
  const stale = await socket({ t: 'watch', token });
  assert.equal((await stale.next(m => m.t === 'error')).code, 'link');
  assert.equal((await api('DELETE', `/api/projects/${S.project}/share`, undefined, S.vee)).status, 200);
  assert.equal((await api('GET', `/api/projects/${S.project}/share`, undefined, S.vee)).data.url, null);
  n.close();
});

test('link previews: a posted share link shows the board’s name and picture', async () => {
  // just enough of a PNG for its size to be read: signature, then the IHDR chunk with width and height
  const png = (w, h) => { const b = Buffer.alloc(64); Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(b); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b; };
  const put = (token, body) => fetch(`${base}/api/projects/${S.project}/preview`, { method: 'PUT', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'image/png' }, body });
  assert.equal((await put(S.vee, png(1200, 630))).status, 409, 'only shared projects have one');
  const p2 = (await api('POST', `/api/teams/${S.team}/projects`, { name: 'Boss "rush" $& <plan>' }, S.vee)).data.project.id;
  const token = (await api('POST', `/api/projects/${p2}/share`, undefined, S.vee)).data.url.split('/v/')[1];
  const put2 = (who, body) => fetch(`${base}/api/projects/${p2}/preview`, { method: 'PUT', headers: { Authorization: 'Bearer ' + who, 'Content-Type': 'image/png' }, body });
  // before there's a picture the page still names the board, and falls back to the site's banner
  let html = await (await fetch(`${base}/v/${token}`)).text();
  assert.match(html, /<meta property="og:title" content="Boss &quot;rush&quot; \$&amp; &lt;plan&gt; · Venom Board">/, 'the name is escaped');
  assert.match(html, /<title>Boss &quot;rush&quot; \$&amp; &lt;plan&gt; · Venom Board<\/title>/);
  assert.match(html, /og:image" content="http:\/\/localhost:9\/docs\/banner\.png"/);
  assert.equal((await put2(S.kip, png(1200, 630))).status, 403, 'viewers can’t set it');
  assert.equal((await put2(S.vee, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).status, 415, 'only PNG or JPEG');
  assert.equal((await put2(S.vee, png(5000, 5000))).status, 415, 'of a sensible size');
  const pic = png(1200, 630);
  assert.equal((await put2(S.nyx, pic)).status, 200, 'editors can');
  const { previewAt } = (await api('GET', `/api/projects/${p2}/share`, undefined, S.vee)).data;
  assert.ok(previewAt > Date.now() - 10000);
  html = await (await fetch(`${base}/v/${token}`)).text();
  assert.match(html, new RegExp(`og:image" content="http://localhost:9/v/${token}/preview\\?v=${previewAt}"`));
  assert.match(html, /<meta name="twitter:card" content="summary_large_image">/);
  const img = await fetch(`${base}/v/${token}/preview?v=${previewAt}`);
  assert.equal(img.status, 200); assert.equal(img.headers.get('content-type'), 'image/png');
  assert.ok(Buffer.from(await img.arrayBuffer()).equals(pic));
  // turning the link off takes the picture with it
  await api('DELETE', `/api/projects/${p2}/share`, undefined, S.vee);
  assert.equal((await fetch(`${base}/v/${token}/preview`)).status, 404);
  await api('DELETE', `/api/projects/${p2}`, undefined, S.vee);
});

test('public roadmaps: only what players should see, votes, feed, embed, reports and one-click takedowns', async () => {
  const items = [
    { id: 'f1', type: 'frame', x: 0, y: 0, w: 1200, h: 900, title: 'Alpha', color: '#ff2a4f' },
    card('r1', { x: 40, y: 40, title: 'Boss fight', status: 'doing', disc: 'code', body: 'Phase two\n[x] Arena\n[ ] Music', assignees: [S.nyxId] }),
    card('r2', { x: 40, y: 240, title: 'Secret plan', nopub: true }),
    card('r3', { x: 40, y: 440, title: 'Cut feature', prio: 'wont' }),
    card('r4', { x: 340, y: 40, title: 'Crash on load', kind: 'bug', sev: 'crash' }),
    card('r5', { x: 340, y: 240, title: 'Photo mode', kind: 'idea' }),
    card('r6', { x: 340, y: 440, title: 'Alpha build', kind: 'milestone', due: '2030-01-01' }),
    card('r7', { x: 640, y: 40, title: 'Title screen', status: 'done', doneAt: Date.now() - 1000 }),
    card('r8', { x: 640, y: 240, title: '<script>alert(1)</script>', body: '<img src=x onerror=alert(2)>' }),
  ];
  const pid = (await api('POST', `/api/teams/${S.team}/projects`, { name: 'Night Keep: Dawn', doc: { items } }, S.vee)).data.project.id;
  assert.equal((await api('GET', `/api/projects/${pid}`, undefined, S.vee)).data.doc.items.find(i => i.id === 'r2').nopub, true, 'hidden cards stay hidden');
  assert.equal((await api('POST', `/api/projects/${pid}/roadmap`, {}, S.nyx)).status, 403, 'only admins publish');
  const rm = (await api('POST', `/api/projects/${pid}/roadmap`, {}, S.vee)).data.roadmap;
  assert.match(rm.url, /^http:\/\/localhost:9\/r\/[A-Za-z0-9]{10}-night-keep-dawn$/);
  assert.match(rm.embed, /<iframe src="http:\/\/localhost:9\/r\/[A-Za-z0-9]{10}\/embed"/);
  const id = rm.url.match(/\/r\/([A-Za-z0-9]{10})/)[1];
  const page = (ip = '203.0.113.5', p = `/r/${id}`) => fetch(base + p, { headers: { 'X-Real-IP': ip } }).then(async r => ({ status: r.status, headers: r.headers, text: await r.text() }));

  // what players see: phases, planned, in progress, done, ideas and milestones; never hidden or cut cards, bugs
  // (unless asked for), people or anything a card's text could inject
  let pg = await page();
  assert.equal(pg.status, 200);
  for (const t of ['Boss fight', 'Title screen', 'Photo mode', 'Alpha build', 'Phase two', '1/2 steps done', '>Alpha<']) assert.ok(pg.text.includes(t), t);
  for (const t of ['Secret plan', 'Cut feature', 'Crash on load', '<script>alert(1)', '<img src=x', 'Nyx']) assert.ok(!pg.text.includes(t), 'not ' + t);
  assert.ok(pg.text.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.match(pg.text, /<meta name="robots" content="noindex">/, 'new roadmaps wait before search engines hear of them');
  assert.match(pg.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await page('203.0.113.5', `/r/${id}-any-old-name`)).status, 200, 'an old name in the address still works');

  // one vote per card per network; pressing again takes it back
  const vote = (c, ip = '203.0.113.5') => fetch(`${base}/api/roadmaps/${id}/vote`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-VB': '1', 'X-Real-IP': ip }, body: JSON.stringify({ card: c }) }).then(async r => ({ status: r.status, data: await r.json() }));
  assert.deepEqual((await vote('r1')).data, { voted: true, votes: 1 });
  assert.deepEqual((await vote('r1')).data, { voted: false, votes: 0 });
  await vote('r1'); assert.equal((await vote('r1', '198.51.100.9')).data.votes, 2);
  for (const c of ['r2', 'r6', 'r7', 'nope']) assert.equal((await vote(c)).status, 400, 'no votes for hidden, milestone, done or missing cards: ' + c);
  assert.match((await page()).text, /data-card="r1" aria-pressed="true"/, 'your own vote shows as yours');
  assert.match((await page('192.0.2.77')).text, /data-card="r1" aria-pressed="false"/);
  assert.deepEqual((await api('GET', `/api/projects/${pid}/roadmap`, undefined, S.kip)).data.votes, { r1: 2 }, 'the team sees the votes');

  // the team chooses what goes on it
  await api('POST', `/api/projects/${pid}/roadmap`, { showBugs: true, showIdeas: false }, S.vee);
  pg = await page();
  assert.ok(pg.text.includes('Crash on load') && !pg.text.includes('Photo mode'));

  // finished work reaches the feed; the embed can be framed by other sites
  const n = await joined(S.nyx, pid);
  n.send({ t: 'ops', batch: 1, ops: [{ k: 'items', op: 'put', obj: { ...items[1], status: 'done', doneAt: Date.now() } }] });
  await n.next(m => m.t === 'ack');
  n.close();
  const feedXml = await (await fetch(`${base}/r/${id}/feed.xml`)).text();
  assert.match(feedXml, /<title>Finished: Boss fight<\/title>/);
  assert.ok(!feedXml.includes('Secret plan'));
  const emb = await fetch(`${base}/r/${id}/embed`);
  assert.equal(emb.status, 200);
  assert.match(emb.headers.get('content-security-policy'), /frame-ancestors \*/);
  assert.equal(emb.headers.get('x-frame-options'), null);

  // a roadmap has its own picture, drawn from what the roadmap shows; the board's picture (made for a view-only
  // link, whose viewers see everything) is never served for the roadmap
  const png = (w, h, mark) => { const b = Buffer.alloc(64); Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(b); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); b[40] = mark; return b; };
  const putPic = (p, pic) => fetch(`${base}/api/projects/${pid}${p}`, { method: 'PUT', headers: { Authorization: 'Bearer ' + S.vee, 'Content-Type': 'image/png' }, body: pic });
  assert.equal((await putPic('/preview', png(1200, 630, 1))).status, 409, 'no board picture without a view-only link');
  const roadPic = png(1200, 630, 2);
  assert.equal((await putPic('/roadmap/preview', roadPic)).status, 200);
  assert.ok((await api('GET', `/api/projects/${pid}/roadmap`, undefined, S.vee)).data.previewAt > 0);
  await api('POST', `/api/projects/${pid}/share`, undefined, S.vee);
  assert.equal((await putPic('/preview', png(1200, 630, 3))).status, 200, 'with a link, the board gets its own picture');
  assert.match((await page()).text, new RegExp(`og:image" content="http://localhost:9/r/${id}/preview\\?v=\\d+"`));
  const served = await fetch(`${base}/r/${id}/preview`);
  assert.equal(served.status, 200);
  assert.ok(Buffer.from(await served.arrayBuffer()).equals(roadPic), 'the roadmap serves its own picture, not the board');
  await api('DELETE', `/api/projects/${pid}/share`, undefined, S.vee);
  assert.equal((await fetch(`${base}/r/${id}/preview`)).status, 200, 'turning the link off leaves the roadmap picture');

  // anyone can report one; the email has a one-click takedown, which asks before it acts
  const rep = await fetch(`${base}/api/roadmaps/${id}/report`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Real-IP': '203.0.113.200' }, body: JSON.stringify({ reason: 'spam' }) });
  assert.equal(rep.status, 200);
  const link = mail.filter(m => /roadmap was reported/.test(m.subject)).pop().text.match(/(http:\/\/localhost:9\/takedown\?\S+)/)[1].replace('http://localhost:9', base);
  assert.match(await (await fetch(link)).text(), /Take it down/);
  assert.equal((await page()).status, 200, 'opening the link changed nothing');
  assert.equal((await fetch(link.replace(/t=[\w-]+/, 't=forged'), { method: 'POST' })).status, 200);
  assert.equal((await page()).status, 200, 'a forged link does nothing');
  assert.match(await (await fetch(link, { method: 'POST' })).text(), /is down/);
  assert.equal((await page()).status, 404);
  assert.equal((await api('GET', `/api/projects/${pid}/roadmap`, undefined, S.vee)).data.roadmap, null);
  assert.equal((await fetch(`${base}/r/${id}/preview`)).status, 404, 'its picture went with it');
  await api('DELETE', `/api/projects/${pid}`, undefined, S.vee);
});

test('public roadmaps need a confirmed email', async () => {
  const r = await api('POST', '/api/auth/signup', { email: 'zed@studio.test', username: 'zedzed', password: 'correct horse' });
  const t = (await api('POST', '/api/teams', { name: 'Zed team' }, r.data.token)).data.team.id;
  const p = (await api('POST', `/api/teams/${t}/projects`, { name: 'Z' }, r.data.token)).data.project.id;
  const res = await api('POST', `/api/projects/${p}/roadmap`, {}, r.data.token);
  assert.deepEqual([res.status, res.data.code], [403, 'verify_first']);
});

test('search: every project you are in, prefixes and accents, nobody else’s', async () => {
  await wait(80);
  const r = (await api('GET', '/api/search?q=' + encodeURIComponent('boss cafe'), undefined, S.kip)).data.results;
  assert.equal(r[0].cardId, 'c1'); assert.equal(r[0].project, 'Slice'); assert.equal(r[0].team, 'Night Keep');
  assert.match(r[0].snippet, /\u0001Boss\u0002/);
  assert.match((await api('GET', '/api/search?q=cafe', undefined, S.kip)).data.results[0].snippet, /\u0001café\u0002/, 'accents don’t matter');
  assert.equal((await api('GET', '/api/search?q=arena', undefined, S.out)).data.results.length, 0, 'outsiders find nothing');
  const n = await joined(S.nyx, S.project);
  n.send({ t: 'ops', batch: 1, ops: [{ k: 'items', op: 'put', obj: card('s1', { title: 'Lighting pass for crypts' }) }] });
  await n.next(m => m.t === 'ack');
  await wait(2200);  // saved, then indexed shortly after
  assert.equal((await api('GET', '/api/search?q=crypt', undefined, S.vee)).data.results[0].cardId, 's1');
  assert.equal((await api('GET', '/api/search?q=%22%20OR%20*', undefined, S.vee)).status, 200, 'search syntax is never passed through');
  n.close();
});

test('reminders: one morning email per person about their own cards due soon', async () => {
  await api('PATCH', '/api/me', { timezone: 'Asia/Tokyo' }, S.kip);
  assert.equal((await api('PATCH', '/api/me', { timezone: 'Mars/Olympus' }, S.kip)).data.code, 'timezone');
  const n = await joined(S.nyx, S.project);
  // 09:30 in Tokyo is 00:30 UTC
  const now = new Date('2030-03-10T00:30:00Z');
  n.send({ t: 'ops', batch: 1, ops: [
    { k: 'items', op: 'put', obj: card('r1', { title: 'Due today', due: '2030-03-10', assignees: [S.kipId] }) },
    { k: 'items', op: 'put', obj: card('r2', { title: 'Late', due: '2030-03-07', assignees: [S.kipId] }) },
    { k: 'items', op: 'put', obj: card('r3', { title: 'Someone else', due: '2030-03-10', assignees: [S.nyxId] }) },
    { k: 'items', op: 'put', obj: card('r4', { title: 'Finished', due: '2030-03-10', status: 'done', assignees: [S.kipId] }) },
    { k: 'items', op: 'put', obj: card('r5', { title: 'Next month', due: '2030-04-10', assignees: [S.kipId] }) }] });
  await n.next(m => m.t === 'ack');
  const before = mail.length;
  srv.remindDue(new Date('2030-03-09T22:00:00Z'));  // 07:00 in Tokyo: too early
  await wait(30);
  assert.equal(mail.slice(before).filter(m => m.to === 'kip@studio.test').length, 0);
  srv.remindDue(now); await wait(30);
  const sent = mail.slice(before).filter(m => m.to === 'kip@studio.test');
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /2 of your Venom Board tasks need attention \(1 late\)/);
  assert.match(sent[0].text, /Due today: due today/); assert.match(sent[0].text, /Late: late, was due 2030-03-07/);
  assert.doesNotMatch(sent[0].text, /Someone else|Finished|Next month/);
  assert.match(sent[0].text, /unsubscribe\?u=/);
  srv.remindDue(new Date('2030-03-10T05:00:00Z')); await wait(30);
  assert.equal(mail.slice(before).filter(m => m.to === 'kip@studio.test').length, 1, 'once a day');
  n.close();
});

test('two-step sign-in: setup, codes, recovery codes, and nothing gets in without them', async () => {
  const login = () => api('POST', '/api/auth/login', { login: 'nyx', password: 'correct horse' });
  assert.equal((await api('POST', '/api/me/2fa/setup', { password: 'wrong' }, S.nyx)).data.code, 'bad_password');
  const setup = (await api('POST', '/api/me/2fa/setup', { password: 'correct horse' }, S.nyx)).data;
  assert.match(setup.uri, /^otpauth:\/\/totp\/Venom%20Board:nyx\?secret=/);
  assert.equal((await api('POST', '/api/me/2fa/enable', { code: '000000' }, S.nyx)).data.code, 'bad_code');
  const other = (await login()).data.token;
  const on = await api('POST', '/api/me/2fa/enable', { code: T.codeAt(setup.secret, Math.floor(Date.now() / 30000)) }, S.nyx);
  assert.equal(on.data.recoveryCodes.length, 10);
  assert.equal((await api('GET', '/api/me', undefined, other)).status, 401, 'other sign-ins end when it is turned on');
  assert.deepEqual((await api('GET', '/api/me', undefined, S.nyx)).data.security, { twoFactor: true, recoveryLeft: 10 });

  // the password alone gets a ticket, not a session
  const first = (await login()).data;
  assert.equal(first.twoFactor, true); assert.equal(first.token, undefined);
  assert.equal((await api('POST', '/api/auth/2fa', { ticket: first.ticket, code: '123456' })).data.code, 'bad_code');
  const code = T.codeAt(setup.secret, Math.floor(Date.now() / 30000) + 1);
  const ok = await api('POST', '/api/auth/2fa', { ticket: first.ticket, code });
  assert.ok(ok.data.token);
  // the same code never works twice
  assert.equal((await api('POST', '/api/auth/2fa', { ticket: (await login()).data.ticket, code })).data.code, 'bad_code');
  // a recovery code works once
  const rc = on.data.recoveryCodes[0];
  assert.ok((await api('POST', '/api/auth/2fa', { ticket: (await login()).data.ticket, code: rc.toUpperCase() })).data.token);
  assert.equal((await api('POST', '/api/auth/2fa', { ticket: (await login()).data.ticket, code: rc })).data.code, 'bad_code');
  // five wrong codes and the ticket is gone
  const t = (await login()).data.ticket;
  for (let i = 0; i < 5; i++) await api('POST', '/api/auth/2fa', { ticket: t, code: '111111' });
  assert.equal((await api('POST', '/api/auth/2fa', { ticket: t, code: T.codeAt(setup.secret, Math.floor(Date.now() / 30000)) })).status, 429);
  // turning it off takes the password and a code
  S.nyx = ok.data.token;
  assert.equal((await api('POST', '/api/me/2fa/disable', { password: 'correct horse', code: '000000' }, S.nyx)).data.code, 'bad_code');
  assert.equal((await api('POST', '/api/me/2fa/disable', { password: 'correct horse', code: on.data.recoveryCodes[1] }, S.nyx)).status, 200);
  assert.ok((await login()).data.token, 'back to password-only');
});

test('videos: short MP4 and WebM clips upload, play and seek; look-alike images are refused', async () => {
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(4000, 7)]);
  const up = await api('POST', `/api/projects/${S.project}/assets`, mp4, S.vee, { 'Content-Type': 'video/mp4' });
  assert.equal(up.status, 200, JSON.stringify(up.data));
  const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.alloc(100)]);
  assert.equal((await api('POST', `/api/projects/${S.project}/assets`, heic, S.vee, { 'Content-Type': 'image/heic' })).status, 415);
  const full = await fetch(`${base}/assets/${up.data.id}`);
  assert.equal(full.headers.get('content-type'), 'video/mp4'); assert.equal(full.headers.get('accept-ranges'), 'bytes');
  assert.match(full.headers.get('cache-control'), /private/, 'videos stay out of the CDN cache');
  const part = await fetch(`${base}/assets/${up.data.id}`, { headers: { Range: 'bytes=100-199' } });
  assert.equal(part.status, 206); assert.equal(part.headers.get('content-range'), `bytes 100-199/${mp4.length}`);
  assert.equal((await part.arrayBuffer()).byteLength, 100);
  assert.equal((await fetch(`${base}/assets/${up.data.id}`, { headers: { Range: `bytes=${mp4.length + 5}-` } })).status, 416);
});

test('videos are refused when the server has video uploads turned off (the default)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'venom-board-novideo-'));
  const s4 = await start({ PORT: '0', DATA_DIR: dir, PUBLIC_URL: 'http://localhost:9', QUIET: 'true', MAIL_PER_10_MIN: '100000', RATE_SCALE: '50', MIN_FREE_DISK_MB: '0' }, { mail: async () => true });
  const call = (p, body, token, type = 'application/json') => fetch(`http://127.0.0.1:${s4.port}${p}`, { method: 'POST', headers: { 'Content-Type': type, ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: Buffer.isBuffer(body) ? body : JSON.stringify(body) }).then(async r => ({ status: r.status, data: await r.json() }));
  try {
    const u = (await call('/api/auth/signup', { email: 'v@studio.test', username: 'vid', password: 'correct horse' })).data.token;
    const team = (await call('/api/teams', { name: 'T' }, u)).data.team.id;
    const proj = (await call(`/api/teams/${team}/projects`, { name: 'P' }, u)).data.project.id;
    const r = await call(`/api/projects/${proj}/assets`, Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(100)]), u, 'video/mp4');
    assert.deepEqual([r.status, r.data.code], [403, 'video_off']);
  } finally { await s4.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('email pace: no more than the mailbox allows in ten minutes; the rest wait their turn', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'venom-board-mailpace-'));
  const sent = [];
  const s3 = await start({ PORT: '0', DATA_DIR: dir, PUBLIC_URL: 'http://localhost:9', QUIET: 'true', RATE_SCALE: '50', MIN_FREE_DISK_MB: '0', MAIL_PER_10_MIN: '2' },
    { mail: async m => { sent.push(m); return true; } });
  try {
    for (const u of ['pace1', 'pace2', 'pace3', 'pace4']) {
      await fetch(`http://127.0.0.1:${s3.port}/api/auth/signup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: u + '@studio.test', username: u, password: 'correct horse' }) });
    }
    await wait(100);
    assert.equal(sent.length, 2, 'two went out; two are waiting for the next ten minutes');
  } finally { await s3.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('email budget: notifications pause at three quarters, sign-in emails keep going, the owner is told', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'venom-board-mailcap-'));
  const sent = [];
  const s2 = await start({ PORT: '0', DATA_DIR: dir, PUBLIC_URL: 'http://localhost:9', QUIET: 'true', MAIL_PER_10_MIN: '100000', RATE_SCALE: '50', MIN_FREE_DISK_MB: '0', MAIL_DAILY_LIMIT: '8', MAIL_FROM: 'VB <owner@studio.test>' },
    { mail: async m => { sent.push(m); return true; } });
  const call = (p, body, token) => fetch(`http://127.0.0.1:${s2.port}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) }).then(r => r.json());
  try {
    const lead = await call('/api/auth/signup', { email: 'lead@studio.test', username: 'lead', password: 'correct horse' });
    await call('/api/auth/verify', { token: sent[0].text.match(/#verify=([\w-]+)/)[1] });
    const team = (await call('/api/teams', { name: 'T' }, lead.token)).team.id;
    for (let i = 0; i < 8; i++) await call(`/api/teams/${team}/invites`, { who: `guest${i}@elsewhere.test`, role: 'viewer' }, lead.token);
    const invites = sent.filter(m => /invited you/.test(m.subject)).length;
    assert.equal(invites, 5, 'invites stop at three quarters of the day’s 8: 1 confirmation + 5 invites');
    assert.ok(sent.some(m => m.to === 'owner@studio.test' && /three quarters/.test(m.subject)), 'the owner hears about it');
    await call('/api/auth/forgot', { email: 'lead@studio.test' });
    assert.ok(sent.some(m => /Reset your/.test(m.subject)), 'a password reset still goes out');
  } finally { await s2.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('one session per account on a board: a second session is refused until it takes over', async () => {
  const p = (await api('POST', `/api/teams/${S.team}/projects`, { name: 'Solo seat', doc: { items: [card('s1')] } }, S.vee)).data.project.id;
  const second = (await api('POST', '/api/auth/login', { login: 'vee', password: 'correct horse' })).data.token;
  assert.ok(second && second !== S.vee);
  const a = await joined(S.vee, p);
  const tab = await joined(S.vee, p);  // another tab of the same signed-in browser is the same session
  const b = await live(second);
  b.send({ t: 'join', project: p });
  const refused = await b.next(m => m.t === 'error');
  assert.equal(refused.code, 'forbidden'); assert.equal(refused.elsewhere, true); assert.equal(refused.name, 'Solo seat');
  assert.ok(await b.none(m => m.t === 'snapshot'));
  // while the other session has it, this one can't restore versions over it either
  const v = (await api('POST', `/api/projects/${p}/versions`, { label: 'before' }, S.vee)).data.version.id;
  assert.equal((await api('POST', `/api/projects/${p}/versions/${v}/restore`, undefined, second)).status, 409);
  // taking it over moves the board: the other session's windows are sent back to their own boards
  b.send({ t: 'join', project: p, takeover: true });
  await b.next(m => m.t === 'snapshot');
  for (const c of [a, tab]) { const k = await c.next(m => m.t === 'kicked'); assert.equal(k.elsewhere, true); }
  a.send({ t: 'ops', batch: 1, ops: [{ k: 'items', op: 'put', obj: card('s2') }] });
  assert.ok(await a.none(m => m.t === 'ack'));
  assert.equal((await api('POST', `/api/projects/${p}/versions/${v}/restore`, undefined, S.vee)).status, 409);
  assert.equal((await api('POST', `/api/projects/${p}/versions/${v}/restore`, undefined, second)).status, 200);
  // once it's closed there, the first session can open it again without taking anything over
  b.close(); await wait(150);
  const again = await joined(S.vee, p);
  assert.ok(again.snapshot.doc.items.length >= 1);
  // other people in the team are never affected
  const nyx = await joined(S.nyx, p);
  assert.ok(await again.none(m => m.t === 'kicked'));
  for (const c of [a, tab, again, nyx]) c.close();
});

test('hardening: malformed requests never stop the server, and watchers stay watchers', async () => {
  // a cookie with a broken escape on the live connection used to throw outside any handler
  await new Promise(res => { const ws = new WebSocket(base.replace('http', 'ws') + '/ws', { headers: { Cookie: 'x=%E0%A4%A' } }); ws.on('open', () => { ws.close(); res(); }); ws.on('error', res); });
  assert.equal((await api('GET', '/api/health')).status, 200);
  assert.equal((await fetch(base + '/web/%E0%A4%A')).status, 404);
  assert.equal((await fetch(base + '/web/account.html')).status, 404, 'pages only come through their own routes');
  // a share-link watcher can't sign in on the same connection and turn into a hidden member
  const link = (await api('POST', `/api/projects/${S.project}/share`, undefined, S.vee)).data;
  const token = (link.url || link.link || '').split('/').pop();
  const w = await socket({ t: 'watch', token });
  await w.next(m => m.t === 'snapshot');
  w.send({ t: 'auth', token: S.kip });
  assert.ok(await w.none(m => m.t === 'ready'));
  w.send({ t: 'join', project: S.project });
  const watcher = await joined(S.vee, S.project);
  assert.ok(!watcher.snapshot.peers.some(p => p.uid === S.kipId), 'the watcher never shows up as a member');
  w.close(); watcher.close();
});

test('hardening: two-step sign-in needs a current code to change, and odd email spellings are refused', async () => {
  const r = await api('POST', '/api/auth/signup', { email: 'tess@studio.test', username: 'tess', password: 'correct horse' });
  const tok = r.data.token;
  for (let i = 0; i < 50 && !mail.some(m => m.to === 'tess@studio.test' && m.text.includes('#verify=')); i++) await wait(20);
  await api('POST', '/api/auth/verify', { token: linkFrom('tess@studio.test', 'verify') });
  const setup = (await api('POST', '/api/me/2fa/setup', { password: 'correct horse' }, tok)).data;
  assert.equal((await api('POST', '/api/me/2fa/enable', { code: T.codeAt(setup.secret, Math.floor(Date.now() / 30000)) }, tok)).status, 200);
  assert.equal((await api('POST', '/api/me/2fa/setup', { password: 'correct horse' }, tok)).data.code, 'on', 'it can\'t be replaced while on');
  assert.equal((await api('POST', '/api/me/2fa/recovery', { password: 'correct horse' }, tok)).data.code, 'need_code');
  assert.equal((await api('POST', '/api/me/2fa/recovery', { password: 'correct horse', code: T.codeAt(setup.secret, Math.floor(Date.now() / 30000) + 1) }, tok)).status, 200);
  // an address with mail-syntax extras is refused rather than stored as a second spelling of someone's inbox
  assert.equal((await api('POST', '/api/auth/signup', { email: '(1)tess@studio.test', username: 'tess2', password: 'correct horse' })).data.code, 'email');
});
