// Calendar feeds: a private address per person that calendar apps subscribe to. What goes in it (your own cards
// with due dates and your teams' milestones, nobody else's), that it's valid iCalendar, that live edits show up,
// that a new address replaces the old one, that turning it off stops it, and the limits on asking for it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { start } = require('../src/index');
const { escText, fold } = require('../src/ical');
const T = require('../src/totp');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'venom-board-views-'));
const APPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'venom-board-app-'));
fs.writeFileSync(path.join(APPDIR, 'index.html'), '<!doctype html><title>Venom Board</title>');
const mail = [];
let srv, base;
const wait = ms => new Promise(r => setTimeout(r, ms));

async function api(method, p, body, token, headers = {}) {
  const r = await fetch(base + p, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
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
const live = async token => { const c = await socket({ t: 'auth', token }); await c.next(m => m.t === 'ready'); return c; };
async function joined(token, project) { const c = await live(token); c.send({ t: 'join', project }); c.snapshot = await c.next(m => m.t === 'snapshot'); return c; }
const card = (id, extra = {}) => ({ id, type: 'node', kind: 'task', x: 0, y: 0, w: 240, title: 'Card ' + id, ...extra });
const linkFrom = (to, kind) => mail.filter(m => m.to === to && m.text.includes('#' + kind + '=')).pop().text.match(new RegExp('#' + kind + '=([\\w-]+)'))[1];
const S = {};

// the feed as calendar apps read it: unfolded content lines, and its events by UID
async function feed(url) {
  const r = await fetch(url.replace('http://localhost:9', base));
  const raw = Buffer.from(await r.arrayBuffer());
  const text = raw.toString('utf8');
  const lines = text.endsWith('\r\n') ? text.slice(0, -2).split('\r\n') : null;
  const unfolded = [];
  for (const l of lines || []) { if (l.startsWith(' ')) unfolded[unfolded.length - 1] += l.slice(1); else unfolded.push(l); }
  const events = new Map();
  let cur = null;
  for (const l of unfolded) {
    if (l === 'BEGIN:VEVENT') cur = {};
    else if (l === 'END:VEVENT') { events.set(cur.UID, cur); cur = null; }
    else if (cur) { const i = l.indexOf(':'); cur[l.slice(0, i)] = l.slice(i + 1); }
  }
  return { status: r.status, headers: r.headers, raw, text, lines, unfolded, events };
}
const uid = (project, c) => `${project}-${c}@localhost`;

test.before(async () => {
  srv = await start({ PORT: '0', DATA_DIR: DATA, PUBLIC_URL: 'http://localhost:9', QUIET: 'true', MAIL_PER_10_MIN: '100000', RATE_SCALE: '50', MIN_FREE_DISK_MB: '0',
    SEARCH_INDEX_DELAY_MS: '30', APP_DIR: APPDIR, MAIL_FROM: 'Venom Board <support@studio.test>' }, { mail: async m => { mail.push(m); return true; }, fetch: async () => ({ ok: true, status: 204 }) });
  base = `http://127.0.0.1:${srv.port}`;
  for (const u of ['vee', 'nyx', 'out']) {
    const r = await api('POST', '/api/auth/signup', { email: u + '@studio.test', username: u, password: 'correct horse', displayName: u[0].toUpperCase() + u.slice(1) });
    S[u] = r.data.token; S[u + 'Id'] = r.data.user.id;
    await api('POST', '/api/auth/verify', { token: linkFrom(u + '@studio.test', 'verify') });
  }
  S.team = (await api('POST', '/api/teams', { name: 'Night Keep' }, S.vee)).data.team.id;
  await api('POST', `/api/teams/${S.team}/invites`, { who: 'nyx', role: 'editor' }, S.vee);
  const inv = (await api('GET', '/api/me', undefined, S.nyx)).data.invites[0].id;
  await api('POST', `/api/invites/${inv}/accept`, undefined, S.nyx);
  const items = [
    { id: 'ph1', type: 'frame', x: -100, y: -100, w: 1200, h: 900, title: 'Vertical slice' },
    { id: 'mb1', type: 'frame', x: 1900, y: -100, w: 700, h: 600, title: 'Characters', mood: true },  // a mood board collection, not a phase
    card('c1', { title: 'Boss arena; blockout, pass 2\nwith a backslash \\ and a very long tail so the line has to be folded more than once: Café Ünïcödé 日本語 ✓ ✓ ✓', due: '2026-11-30', assignees: [S.veeId], prio: 'must', disc: 'level', est: '3d' }),
    card('c2', { title: 'Nyx only', due: '2026-11-04', assignees: [S.nyxId] }),
    card('c3', { kind: 'milestone', title: 'Vertical slice', due: '2026-12-18', x: 2000 }),
    card('c4', { title: 'No date yet', assignees: [S.veeId] }),
    card('c5', { kind: 'idea', title: 'An idea with a date', due: '2026-11-06', assignees: [S.veeId] }),
    card('c6', { title: 'Cut', prio: 'wont', due: '2026-11-07', assignees: [S.veeId] }),
    card('c7', { title: 'Finished thing', status: 'done', due: '2026-10-01', assignees: [S.veeId, S.nyxId] }),
    card('c8', { kind: 'bug', title: 'Clips through stairs', due: '2026-11-12', assignees: [S.veeId] }),
    card('c9', { title: 'Long ago', due: '2020-01-01', assignees: [S.veeId] }),
  ];
  S.project = (await api('POST', `/api/teams/${S.team}/projects`, { name: 'Slice', doc: { items } }, S.vee)).data.project.id;
  // another team vee isn't in, with a card that names vee anyway and a milestone
  S.outTeam = (await api('POST', '/api/teams', { name: 'Elsewhere' }, S.out)).data.team.id;
  S.outProject = (await api('POST', `/api/teams/${S.outTeam}/projects`, { name: 'Secret', doc: { items: [card('x1', { title: 'Not yours', due: '2026-11-05', assignees: [S.veeId] }), card('x2', { kind: 'milestone', title: 'Their launch', due: '2026-11-20' })] } }, S.out)).data.project.id;
});
test.after(async () => { await srv.close(); for (const d of [DATA, APPDIR]) fs.rmSync(d, { recursive: true, force: true }); });

test('text helpers: escaping and folding follow RFC 5545', () => {
  assert.equal(escText('a,b;c\\d\ne\r\nf\tg'), 'a\\,b\\;c\\\\d\\ne\\nf g');
  const long = 'SUMMARY:' + 'é'.repeat(50) + '日本語'.repeat(20) + '😀'.repeat(10);
  const parts = fold(long).split('\r\n');
  assert.ok(parts.length > 2);
  for (const [i, p] of parts.entries()) {
    assert.ok(Buffer.byteLength(p) <= 75, `line ${i} is ${Buffer.byteLength(p)} octets`);
    if (i) assert.ok(p.startsWith(' '));
    assert.ok(!p.includes('�'));
  }
  assert.equal(parts.map((p, i) => (i ? p.slice(1) : p)).join(''), long, 'unfolding gives the line back, no character split');
  assert.equal(fold('SHORT:line'), 'SHORT:line');
});

test('calendar feed: off until turned on, then the same address every time', async () => {
  assert.equal((await api('GET', '/api/me/calendar')).status, 401, 'signed out: nothing');
  assert.deepEqual((await api('GET', '/api/me/calendar', undefined, S.vee)).data, { feed: null });
  const on = await api('POST', '/api/me/calendar', {}, S.vee);
  assert.equal(on.status, 200);
  const f = on.data.feed;
  assert.match(f.url, /^http:\/\/localhost:9\/ical\/[A-Za-z0-9_-]{32}\.ics$/);
  assert.equal(f.webcal, f.url.replace('http:', 'webcal:'));
  assert.equal(f.lastUsed, null);
  assert.equal((await api('GET', '/api/me/calendar', undefined, S.vee)).data.feed.url, f.url, 'shown again later');
  S.veeFeed = f.url;
  // the address isn't kept in the database: only its hash
  const dbText = fs.readFileSync(path.join(DATA, 'venom-board.db')).toString('latin1') + (fs.existsSync(path.join(DATA, 'venom-board.db-wal')) ? fs.readFileSync(path.join(DATA, 'venom-board.db-wal')).toString('latin1') : '');
  assert.ok(!dbText.includes(f.url.match(/ical\/(.+)\.ics/)[1]), 'the address itself is not stored');
});

test('calendar feed: valid iCalendar with your cards and the team milestones', async () => {
  const f = await feed(S.veeFeed);
  assert.equal(f.status, 200);
  assert.equal(f.headers.get('content-type'), 'text/calendar; charset=utf-8');
  assert.equal(f.headers.get('cache-control'), 'no-store');
  assert.match(f.headers.get('x-robots-tag'), /noindex/);
  assert.equal(f.headers.get('referrer-policy'), 'no-referrer');
  assert.ok(f.lines, 'ends with CRLF');
  assert.ok(!/[^\r]\n/.test(f.text) && !/\r[^\n]/.test(f.text), 'every line ends with CRLF');
  for (const l of f.lines) assert.ok(Buffer.byteLength(l) <= 75, `line too long (${Buffer.byteLength(l)}): ${l}`);
  assert.ok(f.lines.some(l => l.startsWith(' ')), 'long lines are folded');
  assert.equal(f.unfolded[0], 'BEGIN:VCALENDAR');
  assert.equal(f.unfolded[f.unfolded.length - 1], 'END:VCALENDAR');
  for (const k of ['VERSION:2.0', 'PRODID:-//1337VIPER//Venom Board//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:Venom Board · Vee']) assert.ok(f.unfolded.includes(k), k);
  assert.equal(f.unfolded.filter(l => l === 'BEGIN:VEVENT').length, f.unfolded.filter(l => l === 'END:VEVENT').length);

  // which cards: vee's own with dates (c1, c7 done, c8 bug), the team's milestone (c3); not nyx's, undated, ideas,
  // cut cards, very old ones, or anything from a team vee isn't in
  assert.deepEqual([...f.events.keys()].sort(), ['c1', 'c3', 'c7', 'c8'].map(c => uid(S.project, c)).sort());
  const e1 = f.events.get(uid(S.project, 'c1'));
  assert.equal(e1['DTSTART;VALUE=DATE'], '20261130');
  assert.equal(e1['DTEND;VALUE=DATE'], '20261201', 'an all-day event ends the next day, across the month');
  assert.match(e1.DTSTAMP, /^\d{8}T\d{6}Z$/);
  assert.equal(e1.SUMMARY, 'Boss arena\\; blockout\\, pass 2 with a backslash \\\\ and a very long tail so the line has to be folded more than once: Café Ünïcödé 日本語 ✓ ✓ ✓');
  assert.equal(e1.URL, `http://localhost:9/app#p=${S.project}&c=c1`);
  assert.equal(e1.DESCRIPTION, `Slice · Vertical slice\\nTo do · Must · Level · estimate 3d\\nOpen it: http://localhost:9/app#p=${S.project}&c=c1`);
  assert.equal(f.events.get(uid(S.project, 'c3')).SUMMARY, '◆ Vertical slice');
  assert.equal(f.events.get(uid(S.project, 'c3')).CATEGORIES, 'Milestone');
  assert.match(f.events.get(uid(S.project, 'c3')).DESCRIPTION, /^Slice\\n/, 'the mood board collection around it is not its phase');
  assert.equal(f.events.get(uid(S.project, 'c7')).SUMMARY, '✓ Finished thing');
  assert.equal(f.events.get(uid(S.project, 'c8')).SUMMARY, 'Bug: Clips through stairs');
  assert.ok(!f.text.includes('Not yours') && !f.text.includes('Their launch') && !f.text.includes('Nyx only'));

  // the same events keep the same UIDs, and reading it is remembered for the account page
  const again = await feed(S.veeFeed);
  assert.deepEqual([...again.events.keys()].sort(), [...f.events.keys()].sort());
  assert.ok((await api('GET', '/api/me/calendar', undefined, S.vee)).data.feed.lastUsed > Date.now() - 60000);
  assert.equal((await fetch(S.veeFeed.replace('http://localhost:9', base), { method: 'HEAD' })).status, 200);
  assert.equal((await fetch(S.veeFeed.replace('http://localhost:9', base), { method: 'POST' })).status, 405);
});

test('calendar feed: only your own cards, and live edits show up', async () => {
  const on = await api('POST', '/api/me/calendar', {}, S.nyx);
  S.nyxFeed = on.data.feed.url;
  assert.notEqual(S.nyxFeed, S.veeFeed);
  let f = await feed(S.nyxFeed);
  assert.deepEqual([...f.events.keys()].sort(), ['c2', 'c3', 'c7'].map(c => uid(S.project, c)).sort(), "nyx sees nyx's cards and the milestone");
  assert.ok(f.unfolded.includes('X-WR-CALNAME:Venom Board · Nyx'));

  // nyx moves a date and takes over c8 live; both feeds follow without anyone saving
  const n = await joined(S.nyx, S.project);
  const c8 = n.snapshot.doc.items.find(o => o.id === 'c8');
  const c2 = n.snapshot.doc.items.find(o => o.id === 'c2');
  n.send({ t: 'ops', batch: 1, ops: [{ k: 'items', op: 'put', obj: { ...c8, assignees: [S.nyxId] } }, { k: 'items', op: 'put', obj: { ...c2, due: '2026-11-09' } }] });
  await n.next(m => m.t === 'ack');
  f = await feed(S.nyxFeed);
  assert.ok(f.events.has(uid(S.project, 'c8')));
  assert.equal(f.events.get(uid(S.project, 'c2'))['DTSTART;VALUE=DATE'], '20261109');
  assert.ok(!(await feed(S.veeFeed)).events.has(uid(S.project, 'c8')), 'vee no longer has it');
  n.close();

  // someone removed from the team stops seeing its cards
  assert.equal((await api('DELETE', `/api/teams/${S.team}/members/${S.nyxId}`, undefined, S.vee)).status, 200);
  f = await feed(S.nyxFeed);
  assert.equal(f.status, 200);
  assert.equal(f.events.size, 0);

  // made-up and malformed addresses get nothing
  for (const p of ['/ical/' + 'A'.repeat(32) + '.ics', '/ical/short.ics', '/ical/' + S.veeFeed.match(/ical\/(.+)\.ics/)[1] + 'x.ics', '/ical/']) {
    const r = await fetch(base + p);
    assert.equal(r.status, 404, p);
    assert.ok(!(await r.text()).includes('BEGIN:VCALENDAR'));
  }
});

test('calendar feed: a new address replaces the old one, and it turns off', async () => {
  const old = S.veeFeed;
  const next = (await api('POST', '/api/me/calendar', {}, S.vee)).data.feed.url;
  assert.notEqual(next, old);
  assert.equal((await feed(old)).status, 404, 'the old address stops working');
  assert.equal((await feed(next)).status, 200);
  assert.equal((await api('GET', '/api/me/calendar', undefined, S.vee)).data.feed.url, next);
  // the account page reads it with the site cookie; other sites can't make a new one or read it (the API's usual rules)
  const login = await api('POST', '/api/auth/login', { login: 'vee', password: 'correct horse', web: true }, null, { 'X-VB': '1' });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await api('GET', '/api/me/calendar', undefined, null, { Cookie: cookie })).data.feed.url, next);
  assert.equal((await api('POST', '/api/me/calendar', {}, null, { Cookie: cookie })).status, 401, 'no X-VB header, no cookie');
  assert.equal((await api('GET', '/api/me/calendar', undefined, null, { Cookie: cookie, Origin: 'https://evil.test' })).status, 401, 'cookies are ignored cross-origin');
  assert.equal((await api('GET', '/api/me/calendar', undefined, null, { Cookie: cookie })).data.feed.url, next, 'unchanged');
  assert.deepEqual((await api('DELETE', '/api/me/calendar', undefined, S.vee)).data, { feed: null });
  assert.equal((await feed(next)).status, 404, 'turned off');
  assert.deepEqual((await api('GET', '/api/me/calendar', undefined, S.vee)).data, { feed: null });
  // deleting an account takes its feed with it
  const url = (await api('POST', '/api/me/calendar', {}, S.out)).data.feed.url;
  assert.equal((await feed(url)).status, 200);
  assert.equal((await api('DELETE', `/api/teams/${S.outTeam}`, undefined, S.out)).status, 200);
  assert.equal((await api('DELETE', '/api/me', { password: 'correct horse' }, S.out)).status, 200);
  assert.equal((await feed(url)).status, 404);
});

test('calendar feed: turned off whenever the other ways into the account are revoked', async () => {
  const su = await api('POST', '/api/auth/signup', { email: 'pip@studio.test', username: 'pip', password: 'correct horse' });
  const tok = su.data.token;
  for (let i = 0; i < 50 && !mail.some(m => m.to === 'pip@studio.test' && m.text.includes('#verify=')); i++) await wait(20);
  await api('POST', '/api/auth/verify', { token: linkFrom('pip@studio.test', 'verify') });  // two-step sign-in needs a confirmed email
  const turnOn = async () => {
    const url = (await api('POST', '/api/me/calendar', {}, tok)).data.feed.url;
    assert.equal((await feed(url)).status, 200);
    return url;
  };
  const isOff = async (url, why) => {
    assert.equal((await feed(url)).status, 404, why);
    assert.deepEqual((await api('GET', '/api/me/calendar', undefined, tok)).data, { feed: null }, why);
  };
  // 1. changing the password
  let url = await turnOn();
  assert.equal((await api('PATCH', '/api/me', { currentPassword: 'correct horse', newPassword: 'battery staple' }, tok)).status, 200);
  await isOff(url, 'a new password turns it off');
  // 2. signing out everywhere else
  url = await turnOn();
  assert.equal((await api('POST', '/api/me/sign-out-others', {}, tok)).status, 200);
  await isOff(url, 'signing out everywhere else turns it off');
  // 3. turning on two-step sign-in
  url = await turnOn();
  const setup = (await api('POST', '/api/me/2fa/setup', { password: 'battery staple' }, tok)).data;
  assert.equal((await api('POST', '/api/me/2fa/enable', { code: T.codeAt(setup.secret, Math.floor(Date.now() / 30000)) }, tok)).status, 200);
  await isOff(url, 'turning on two-step sign-in turns it off');
  // 4. a password reset from the emailed link (it signs out every session, this one included)
  url = await turnOn();
  await api('POST', '/api/auth/forgot', { email: 'pip@studio.test' });
  for (let i = 0; i < 50 && !mail.some(m => m.to === 'pip@studio.test' && m.text.includes('#reset=')); i++) await wait(20);
  assert.equal((await api('POST', '/api/auth/reset', { token: linkFrom('pip@studio.test', 'reset'), password: 'new and improved' })).status, 200);
  assert.equal((await feed(url)).status, 404, 'a password reset turns it off');
  assert.equal((await api('GET', '/api/me/calendar', undefined, tok)).status, 401, 'and signed this session out');
});

test('calendar feed: reading it is rate limited', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'venom-board-views-rl-'));
  const s2 = await start({ PORT: '0', DATA_DIR: dir, PUBLIC_URL: 'http://localhost:9', QUIET: 'true', RATE_SCALE: '1', MIN_FREE_DISK_MB: '0', APP_DIR: APPDIR }, { mail: async () => true, fetch: async () => ({ ok: true, status: 204 }) });
  try {
    const b2 = `http://127.0.0.1:${s2.port}`;
    const r = await (await fetch(b2 + '/api/auth/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'rl@studio.test', username: 'ratel', password: 'correct horse' }) })).json();
    const url = (await (await fetch(b2 + '/api/me/calendar', { method: 'POST', headers: { Authorization: 'Bearer ' + r.token } })).json()).feed.url.replace('http://localhost:9', b2);
    const codes = [];
    for (let i = 0; i < 60; i++) codes.push((await fetch(url)).status);
    assert.ok(codes.every(c => c === 200), 'an hour of normal polling and more is fine');
    const last = await fetch(url);
    assert.equal(last.status, 429);
    assert.equal(last.headers.get('retry-after'), '900');
    assert.equal(last.headers.get('cache-control'), 'no-store');
  } finally { await s2.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
