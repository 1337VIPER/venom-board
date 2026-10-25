// Comment threads on shared boards: replies, reactions, resolving, and feedback pins on pictures.
// Viewers can comment, reply and react; nobody can change someone else's words, react for someone else,
// or resolve a thread that isn't theirs (team admins can).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { start } = require('../src/index');
const { cleanOp } = require('../src/sanitize');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'venom-board-comments-'));
const APPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'venom-board-app-'));
fs.writeFileSync(path.join(APPDIR, 'index.html'), '<!doctype html><title>Venom Board</title>');
const mail = [], discord = [];
let srv, base;
const fakeFetch = async (url, opts) => { discord.push({ url, body: JSON.parse(opts.body) }); return { ok: true, status: 204 }; };
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
const picture = (id, extra = {}) => ({ id, type: 'image', x: 400, y: 0, w: 640, h: 360, name: 'Arena paintover', ...extra });
const linkFrom = (to, kind) => mail.filter(m => m.to === to && m.text.includes('#' + kind + '=')).pop().text.match(new RegExp('#' + kind + '=([\\w-]+)'))[1];
const S = {};
const THUMB = '\u{1F44D}', HEART = '\u{2764}\u{FE0F}', EYES = '\u{1F440}';

// send a batch and wait until the server has handled it; `refused` resolves to the snapshot sent back, if any
let batches = 0;
async function send(c, ops) {
  const batch = ++batches;
  c.inbox.length = 0;
  c.send({ t: 'ops', batch, ops });
  await c.next(m => m.t === 'ack' && m.batch === batch);
  await wait(60);
  const i = c.inbox.findIndex(m => m.t === 'snapshot');
  return { refused: i >= 0, snapshot: i >= 0 ? c.inbox[i] : null };
}
const put = obj => ({ k: 'comments', op: 'put', obj });
const stored = async id => (await api('GET', `/api/projects/${S.project}`, undefined, S.vee)).data.doc.comments.find(c => c.id === id);
const notes = async token => (await api('GET', '/api/notifications', undefined, token)).data.items;

test.before(async () => {
  srv = await start({ PORT: '0', DATA_DIR: DATA, PUBLIC_URL: 'http://localhost:9', QUIET: 'true', MAIL_PER_10_MIN: '100000', RATE_SCALE: '50', MIN_FREE_DISK_MB: '0',
    DISCORD_DELAY_MS: '40', SEARCH_INDEX_DELAY_MS: '30', APP_DIR: APPDIR, MAIL_FROM: 'Venom Board <support@studio.test>' }, { mail: async m => { mail.push(m); return true; }, fetch: fakeFetch });
  base = `http://127.0.0.1:${srv.port}`;
  for (const u of ['vee', 'ada', 'nyx', 'kip', 'out']) {
    const r = await api('POST', '/api/auth/signup', { email: u + '@studio.test', username: u, password: 'correct horse', displayName: u[0].toUpperCase() + u.slice(1) });
    S[u] = r.data.token; S[u + 'Id'] = r.data.user.id;
    await api('POST', '/api/auth/verify', { token: linkFrom(u + '@studio.test', 'verify') });
  }
  S.team = (await api('POST', '/api/teams', { name: 'Night Keep' }, S.vee)).data.team.id;
  for (const [u, role] of [['ada', 'admin'], ['nyx', 'editor'], ['kip', 'viewer']]) {
    await api('POST', `/api/teams/${S.team}/invites`, { who: u, role }, S.vee);
    const inv = (await api('GET', '/api/me', undefined, S[u])).data.invites[0].id;
    await api('POST', `/api/invites/${inv}/accept`, undefined, S[u]);
  }
  S.project = (await api('POST', `/api/teams/${S.team}/projects`, { name: 'Slice', doc: { items: [card('c1', { title: 'Boss arena blockout' }), card('c2'), picture('p1')] } }, S.vee)).data.project.id;
});
test.after(async () => { await srv.close(); for (const d of [DATA, APPDIR]) fs.rmSync(d, { recursive: true, force: true }); });

test('cleaning: thread fields are optional and rebuilt from checked values', () => {
  const c = o => (cleanOp({ k: 'comments', op: 'put', obj: { id: 'x1', card: 'c1', text: 'hi', ...o } }) || {}).obj;
  assert.deepEqual(Object.keys(c({})).sort(), ['at', 'by', 'card', 'id', 'text', 'type'], 'a plain comment stays as it was');
  assert.equal(c({ re: 'x1' }).re, undefined, "a comment can't answer itself");
  assert.equal(c({ re: '<b>' }).re, undefined);
  assert.deepEqual(c({ react: { [THUMB]: ['u1', 'u1', 'not an id!', 7], ':)': ['u2'], [HEART]: [] } }).react, { [THUMB]: ['u1'] }, 'known reactions, real ids, no repeats');
  assert.equal(c({ react: { [THUMB]: Array.from({ length: 500 }, (_, i) => 'u' + i) } }).react[THUMB].length, 100, 'capped');
  assert.equal(c({ react: [THUMB] }).react, undefined);
  assert.deepEqual(c({ pin: { x: 1.7, y: '-3' } }).pin, { x: 1, y: 0 }, 'pins stay on the picture');
  assert.deepEqual(c({ pin: { x: 0.123456789, y: 0.5 } }).pin, { x: 0.1235, y: 0.5 });
  assert.equal(c({ pin: { x: 'left', y: 0 } }).pin, undefined);
  assert.equal(c({ pin: { x: 0.5, y: 0.5 }, re: 'r1' }).pin, undefined, 'replies have no pin');
  const r = c({ resolved: 1.8e12, resolvedBy: 'u1' });
  assert.deepEqual([r.resolved, r.resolvedBy], [1.8e12, 'u1']);
  assert.equal(c({ resolved: 5 }).resolved, undefined);
  assert.equal(c({ resolved: 1.8e12, re: 'r1' }).resolved, undefined, 'only a thread is resolved, not a reply');
});

test('replies: one level deep, on the same card, and they tell the person they answer', async () => {
  const [n, k] = await Promise.all([joined(S.nyx, S.project), joined(S.kip, S.project)]);
  assert.equal((await send(n, [put({ id: 'r0', card: 'c1', text: 'Is the arena too big?' })])).refused, false);
  // a viewer can reply; the thread's author hears about it (in the app and by email)
  assert.equal((await send(k, [put({ id: 'r1', card: 'c1', re: 'r0', text: 'A little, yes', pin: { x: 0.5, y: 0.5 }, resolved: 1.8e12 })])).refused, false);
  const r1 = await stored('r1');
  assert.deepEqual([r1.re, r1.by, r1.pin, r1.resolved], ['r0', S.kipId, undefined, undefined], 'a reply carries no pin or resolved state');
  const note = (await notes(S.nyx)).find(x => x.kind === 'reply');
  assert.ok(note, 'the thread author got a notification');
  assert.deepEqual([note.cardId, note.fromName, note.text], ['c1', 'Kip', 'A little, yes']);
  const email = mail.filter(m => m.to === 'nyx@studio.test' && /replied to your comment/.test(m.subject)).pop();
  assert.ok(email, 'and an email');
  assert.match(email.text, /Boss arena blockout/); assert.match(email.text, /#p=[\w-]+&c=c1/); assert.match(email.text, /unsubscribe/);
  // replying to a reply joins the same thread
  await send(n, [put({ id: 'r2', card: 'c1', re: 'r1', text: 'Agreed, trim it' })]);
  assert.equal((await stored('r2')).re, 'r0');
  // a reply can't hang off a comment on another card, or one that doesn't exist: it starts its own thread
  await send(k, [put({ id: 'r3', card: 'c2', re: 'r0', text: 'Wrong card' }), put({ id: 'r4', card: 'c1', re: 'nope', text: 'Lost' })]);
  assert.equal((await stored('r3')).re, undefined); assert.equal((await stored('r4')).re, undefined);
  // what a reply answers never changes afterwards
  await send(k, [put({ id: 'r1', card: 'c1', re: 'r4', text: 'A little, yes!' })]);
  assert.deepEqual([(await stored('r1')).re, (await stored('r1')).text], ['r0', 'A little, yes!']);
  // replying in your own thread notifies nobody; @mentioning the author in a reply notifies them once
  const before = (await notes(S.nyx)).length;
  await send(n, [put({ id: 'r5', card: 'c1', re: 'r0', text: 'Noted' })]);
  await send(k, [put({ id: 'r6', card: 'c1', re: 'r0', text: '@nyx see the paintover' })]);
  const after = await notes(S.nyx);
  assert.equal(after.length, before + 1);
  assert.equal(after[0].kind, 'mention');
  // a reply is still a new comment in the activity feed
  const act = (await api('GET', `/api/projects/${S.project}/activity`, undefined, S.vee)).data.items;
  assert.ok(act.some(a => a.kind === 'comment'));
  for (const c of [n, k]) c.close();
});

test('reactions: your own only, never in anyone else\'s name, and they notify nobody', async () => {
  const hook = 'https://discord.com/api/webhooks/1234567890/' + 'x'.repeat(40);
  await api('PATCH', `/api/teams/${S.team}/integrations`, { discordWebhook: hook, discordEvents: ['comment'] }, S.vee);
  const [n, k, a] = await Promise.all([joined(S.nyx, S.project), joined(S.kip, S.project), joined(S.ada, S.project)]);
  await send(n, [put({ id: 'x0', card: 'c2', text: 'Ship it?' })]);
  await wait(120); discord.length = 0;
  const actBefore = (await api('GET', `/api/projects/${S.project}/activity`, undefined, S.vee)).data.items[0];
  const notesBefore = (await notes(S.nyx)).length;
  const base0 = await stored('x0');
  // a viewer reacts to someone else's comment; everyone sees it
  assert.equal((await send(k, [put({ ...base0, react: { [THUMB]: [S.kipId], 'not one': [S.kipId] } })])).refused, false);
  assert.deepEqual((await n.next(m => m.t === 'ops' && m.ops[0].obj && m.ops[0].obj.react)).ops[0].obj.react, { [THUMB]: [S.kipId] });
  // two people reacting at once from the same starting copy: both count
  await Promise.all([send(a, [put({ ...base0, react: { [THUMB]: [S.adaId] } })]), send(n, [put({ ...base0, react: { [HEART]: [S.nyxId] } })])]);
  assert.deepEqual((await stored('x0')).react, { [THUMB]: [S.kipId, S.adaId], [HEART]: [S.nyxId] });
  // reacting for someone else is refused, and so is taking their reaction away
  const now = await stored('x0');
  const forged = await send(k, [put({ ...now, react: { ...now.react, [EYES]: [S.veeId] } })]);
  assert.equal(forged.refused, true, 'a reaction in someone else\'s name is refused');
  assert.equal(forged.snapshot.doc.comments.find(c => c.id === 'x0').react[EYES], undefined);
  assert.equal((await send(k, [put({ ...now, react: { [THUMB]: [S.kipId] } })])).refused, true, 'removing others\' reactions changes nothing, so it\'s refused');
  // a stale copy can show other people's reactions wrongly: their part is ignored and the sender's own still counts
  assert.equal((await send(k, [put({ ...now, react: { ...now.react, [EYES]: [S.kipId, S.veeId] } })])).refused, false, 'a real reaction alongside a wrong one goes through');
  assert.deepEqual((await stored('x0')).react[EYES], [S.kipId], 'only the sender\'s own reaction counts');
  await send(k, [put({ ...(await stored('x0')), react: { ...now.react } })]);
  assert.deepEqual((await stored('x0')).react, now.react, 'and taking it back leaves everyone else\'s');
  // a reaction on someone else's comment can't carry an edit to their words
  assert.equal((await send(k, [put({ ...now, text: 'Never ship it', react: { ...now.react, [EYES]: [S.kipId] } })])).refused, false);
  const x0 = await stored('x0');
  assert.equal(x0.text, 'Ship it?'); assert.deepEqual(x0.react[EYES], [S.kipId]); assert.equal(x0.edited, undefined);
  // taking your own reaction back
  await send(k, [put({ ...x0, react: { [THUMB]: [S.adaId], [HEART]: [S.nyxId] } })]);
  assert.deepEqual((await stored('x0')).react, { [THUMB]: [S.adaId], [HEART]: [S.nyxId] });
  // none of that made activity, notifications or Discord posts
  await wait(150);
  const act = (await api('GET', `/api/projects/${S.project}/activity`, undefined, S.vee)).data.items;
  assert.equal(act[0].id, actBefore.id, 'reactions are not activity');
  assert.equal(act[0].count, actBefore.count);
  assert.equal((await notes(S.nyx)).length, notesBefore, 'reactions notify nobody');
  assert.equal(discord.length, 0, 'or reach Discord');
  // the author editing from a copy without the latest reactions from others keeps them
  await send(n, [put({ ...base0, text: 'Ship it on Friday?', react: { [HEART]: [S.nyxId] } })]);
  const edited = await stored('x0');
  assert.equal(edited.text, 'Ship it on Friday?'); assert.ok(edited.edited);
  assert.deepEqual(edited.react, { [THUMB]: [S.adaId], [HEART]: [S.nyxId] });
  // ...but the author can't react for anyone else either
  assert.equal((await send(n, [put({ ...edited, react: { ...edited.react, [EYES]: [S.veeId] } })])).refused, true);
  // a brand-new comment can't arrive with other people's reactions
  await send(k, [put({ id: 'x1', card: 'c2', text: 'Me too', react: { [THUMB]: [S.kipId, S.veeId] } })]);
  assert.deepEqual((await stored('x1')).react, { [THUMB]: [S.kipId] });
  // new comments still reach Discord
  await wait(150);
  assert.equal(discord.length, 1);
  assert.match(discord[0].body.content, /commented on/);
  await api('PATCH', `/api/teams/${S.team}/integrations`, { discordWebhook: '' }, S.vee);
  discord.length = 0;
  for (const c of [n, k, a]) c.close();
});

test('resolving: the thread\'s author or a team admin, stamped by the server', async () => {
  const [n, k, a, v] = await Promise.all([joined(S.nyx, S.project), joined(S.kip, S.project), joined(S.ada, S.project), joined(S.vee, S.project)]);
  await send(k, [put({ id: 's0', card: 'c2', text: 'The door clips through the wall' })]);
  await send(n, [put({ id: 's1', card: 'c2', re: 's0', text: 'Fixed in the last build' })]);
  const s0 = await stored('s0');
  // an editor who didn't start the thread can't resolve it, and nobody resolves a reply
  assert.equal((await send(n, [put({ ...s0, resolved: Date.now(), resolvedBy: S.nyxId })])).refused, true);
  assert.equal((await stored('s0')).resolved, undefined);
  const s1 = await stored('s1');
  await send(n, [put({ ...s1, resolved: Date.now() })]);
  assert.equal((await stored('s1')).resolved, undefined);
  // the viewer who started it can; the time and who are the server's, not what was sent
  assert.equal((await send(k, [put({ ...s0, resolved: 1.6e12, resolvedBy: S.veeId })])).refused, false);
  const done = await stored('s0');
  assert.ok(done.resolved > Date.now() - 5000); assert.equal(done.resolvedBy, S.kipId);
  assert.ok((await v.next(m => m.t === 'ops' && m.ops[0].obj && m.ops[0].obj.id === 's0' && m.ops[0].obj.resolved)), 'everyone sees it resolved');
  // resolving again from a stale copy is harmless; editing its text keeps it resolved
  assert.equal((await send(a, [put({ ...s0, resolved: Date.now() })])).refused, false);
  assert.equal((await stored('s0')).resolvedBy, S.kipId);
  await send(k, [put({ ...done, text: 'The door clipped through the wall' })]);
  assert.ok((await stored('s0')).resolved);
  // an older app that doesn't know about threads edits the words without reopening it or dropping reactions
  await send(n, [put({ ...(await stored('s0')), react: { [THUMB]: [S.nyxId] } })]);
  await send(k, [put({ id: 's0', type: 'comment', card: 'c2', text: 'The door clipped through the wall again' })]);
  const old = await stored('s0');
  assert.deepEqual([old.text, !!old.resolved, old.react], ['The door clipped through the wall again', true, { [THUMB]: [S.nyxId] }]);
  // an editor still can't reopen it; a team admin can, and resolve it again
  assert.equal((await send(n, [put({ ...(await stored('s0')), resolved: undefined, resolvedBy: undefined })])).refused, true);
  const cur = await stored('s0');
  delete cur.resolved; delete cur.resolvedBy;
  assert.equal((await send(a, [put(cur)])).refused, false);
  assert.equal((await stored('s0')).resolved, undefined);
  await send(a, [put({ ...cur, resolved: Date.now() })]);
  assert.equal((await stored('s0')).resolvedBy, S.adaId);
  // a new comment can't start out resolved
  await send(k, [put({ id: 's2', card: 'c2', text: 'Another one', resolved: Date.now(), resolvedBy: S.kipId })]);
  assert.equal((await stored('s2')).resolved, undefined);
  // and people who aren't in the team can't touch anything
  const o = await live(S.out);
  o.send({ t: 'join', project: S.project });
  assert.equal((await o.next(m => m.t === 'error')).code, 'forbidden');
  for (const c of [n, k, a, v, o]) c.close();
});

test('feedback pins: numbered comments on a spot of a picture, with mentions, that outlive the picture', async () => {
  const [n, k] = await Promise.all([joined(S.nyx, S.project), joined(S.kip, S.project)]);
  // a viewer drops a pin on a picture, mentioning a teammate
  assert.equal((await send(k, [put({ id: 'p-a', card: 'p1', text: 'Lighting is flat here @nyx', pin: { x: 0.25, y: 0.6 } })])).refused, false);
  const got = (await n.next(m => m.t === 'ops' && m.ops[0].obj && m.ops[0].obj.id === 'p-a')).ops[0].obj;
  assert.deepEqual([got.card, got.pin, got.by], ['p1', { x: 0.25, y: 0.6 }, S.kipId]);
  const note = (await notes(S.nyx)).find(x => x.kind === 'mention' && x.cardId === 'p1');
  assert.ok(note, 'mentions on pictures notify like on cards');
  const email = mail.filter(m => m.to === 'nyx@studio.test' && /mentioned you/.test(m.subject)).pop();
  assert.match(email.text, /Arena paintover/, 'the email names the picture');
  const act = (await api('GET', `/api/projects/${S.project}/activity`, undefined, S.vee)).data.items[0];
  assert.deepEqual([act.kind, act.text, act.cardId], ['comment', 'Arena paintover', 'p1']);
  // replies in a pin's thread, and the author can't move the pin by editing
  await send(n, [put({ id: 'p-b', card: 'p1', re: 'p-a', text: 'Will relight', pin: { x: 0.9, y: 0.9 } })]);
  assert.equal((await stored('p-b')).pin, undefined);
  await send(k, [put({ ...(await stored('p-a')), text: 'Lighting is flat here', pin: { x: 0.9, y: 0.1 } })]);
  assert.deepEqual((await stored('p-a')).pin, { x: 0.25, y: 0.6 });
  // pins only go on pictures; a comment on a card with a pin is just a comment
  await send(n, [put({ id: 'p-c', card: 'c1', text: 'Not a picture', pin: { x: 0.5, y: 0.5 } })]);
  assert.equal((await stored('p-c')).pin, undefined);
  // a second pin, resolved by its author
  await send(n, [put({ id: 'p-d', card: 'p1', text: 'Crop the left edge', pin: { x: 0.05, y: 0.5 } })]);
  await send(n, [put({ ...(await stored('p-d')), resolved: Date.now() })]);
  assert.ok((await stored('p-d')).resolved);
  // reacting to a pin works like any comment
  await send(n, [put({ ...(await stored('p-a')), react: { [THUMB]: [S.nyxId] } })]);
  assert.deepEqual((await stored('p-a')).react, { [THUMB]: [S.nyxId] });
  // deleting the picture leaves its comments; they come back with it
  const pic = (await api('GET', `/api/projects/${S.project}`, undefined, S.vee)).data.doc.items.find(i => i.id === 'p1');
  assert.equal((await send(n, [{ k: 'items', op: 'del', id: 'p1' }])).refused, false);
  const doc = (await api('GET', `/api/projects/${S.project}`, undefined, S.vee)).data.doc;
  assert.ok(!doc.items.some(i => i.id === 'p1'));
  assert.deepEqual(doc.comments.filter(c => c.card === 'p1').map(c => c.id).sort(), ['p-a', 'p-b', 'p-d']);
  // a pin can't be dropped on a picture that isn't there any more
  await send(k, [put({ id: 'p-e', card: 'p1', text: 'Gone?', pin: { x: 0.5, y: 0.5 } })]);
  assert.equal((await stored('p-e')).pin, undefined);
  await send(n, [{ k: 'items', op: 'put', obj: pic }]);
  const back = await joined(S.vee, S.project);
  assert.deepEqual(back.snapshot.doc.comments.find(c => c.id === 'p-a').pin, { x: 0.25, y: 0.6 });
  for (const c of [n, k, back]) c.close();
});

test('deleting: authors their own comments, admins anyone\'s, replies stay', async () => {
  const [n, k, a] = await Promise.all([joined(S.nyx, S.project), joined(S.kip, S.project), joined(S.ada, S.project)]);
  await send(n, [put({ id: 'd0', card: 'c1', text: 'Thread' })]);
  await send(k, [put({ id: 'd1', card: 'c1', re: 'd0', text: 'Reply' })]);
  assert.equal((await send(k, [{ k: 'comments', op: 'del', id: 'd0' }])).refused, true, 'not yours');
  assert.equal((await send(a, [{ k: 'comments', op: 'del', id: 'd0' }])).refused, false, 'admins can');
  assert.equal(await stored('d0'), undefined);
  assert.equal((await stored('d1')).re, 'd0', 'the reply stays (the app shows it on its own)');
  for (const c of [n, k, a]) c.close();
});
