// Venom Board as a Model Context Protocol (MCP) server at /mcp, so assistants and other tools that speak MCP can
// work on a team's boards the way a person does in the app: plan with phases, cards, dependencies and the
// schedule, and lay out the board itself with text, frames, pictures, GIFs, videos, ink, connectors and templates.
//
// Transport: Streamable HTTP. Every JSON-RPC message is a POST answered with one JSON object (no server-sent
// streams, no sessions), which every client supports. GET and DELETE answer 405.
//
// Access: a personal access token (Settings on the website), sent as "Authorization: Bearer vbt_…". It acts as
// its owner with their role in each team, so viewers can read and comment but not edit. Tokens only work here,
// never on the rest of the API, and changing the password or ending other sign-ins revokes them. Team membership,
// sharing and publishing, Discord, and deleting projects, teams or versions stay in the app: a leaked token can't
// invite anyone, make a board public or destroy work that version history can't bring back.
//
// Edits go through the same live path as someone working in the app: they're checked and cleaned, saved, shown
// to everyone with the project open, written to the activity feed, and the board is kept in version history
// before a burst of changes, so anything can be undone from there.
const crypto = require('crypto');
const { cardCodes } = require('./gitlink');
const { okGitLink, okSource } = require('./sanitize');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const dns = require('dns').promises;
const net = require('net');
const http = require('http');
const https = require('https');

const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const KINDS = ['task', 'milestone', 'bug', 'idea'];
const STATUS = { todo: 'todo', 'to do': 'todo', open: 'todo', doing: 'doing', 'in progress': 'doing', progress: 'doing', blocked: 'blocked', done: 'done', finished: 'done', complete: 'done' };
const PRIO = { must: 'must', should: 'should', could: 'could', wont: 'wont', "won't": 'wont' };
const DISC = { code: 'code', programming: 'code', art: 'art', design: 'design', level: 'level', 'level design': 'level', audio: 'audio', sound: 'audio', ui: 'ui', 'ui/ux': 'ui', ux: 'ui',
  vfx: 'vfx', narr: 'narr', narrative: 'narr', writing: 'narr', qa: 'qa', testing: 'qa', tech: 'tech', 'tech/build': 'tech', 'tech / build': 'tech', build: 'tech', mkt: 'mkt', marketing: 'mkt' };
const DISC_COLOR = { code: '#2fd6ff', art: '#a66bff', design: '#ff2a4f', level: '#3dff8b', audio: '#ffd23d', ui: '#ff7a1a', vfx: '#ff4fd8', narr: '#c4b0ff', qa: '#7dffd0', tech: '#8fa3ff', mkt: '#ffa3b5' };
const PHASE_COLORS = ['#a66bff', '#2fd6ff', '#ff7a1a', '#3dff8b', '#ffd23d', '#ff4fd8'];
const BONE = '#f1eef2';
// the app's palette by name, so a tool can say "red" as well as #ff2a4f
const NAMED = { bone: BONE, white: BONE, red: '#ff2a4f', green: '#3dff8b', cyan: '#2fd6ff', blue: '#8fa3ff', yellow: '#ffd23d', orange: '#ff7a1a', purple: '#a66bff', violet: '#a66bff',
  ultraviolet: '#a66bff', pink: '#ff4fd8', mint: '#7dffd0', lavender: '#c4b0ff', rose: '#ffa3b5', grey: '#9d99aa', gray: '#9d99aa', ink: '#0b0b10', black: '#0b0b10' };
// what the server needs from the app's own template builder in index.html, so templates come out exactly as in the app
const TPL_PARTS = ['rd', 'BONE', 'PEN', 'DISC', 'DISC_MAP', 'SEV', 'SEV_MAP', 'pad2', 'isoDay', 'addDays', 'unionBox', 'cardObj', 'TEMPLATES', 'tplBuild'];
const newId = () => crypto.randomBytes(9).toString('base64url');
const str = (v, max) => (typeof v === 'string' ? v : v == null ? '' : String(v)).trim().slice(0, max);
const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const fin = v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e7;
const rd = v => Math.round(v * 10) / 10;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function estDays(s) {
  const m = String(s || '').trim().match(/^(\d+(?:\.\d+)?)\s*(h|hr|hrs|hours?|d|days?|w|wk|wks|weeks?)?$/i);
  if (!m) return 0;
  const v = parseFloat(m[1]), u = (m[2] || 'd')[0].toLowerCase();
  return u === 'h' ? v / 8 : u === 'w' ? v * 5 : v;
}

class ToolError extends Error {}
const oops = msg => { throw new ToolError(msg); };
const colorArg = (c, d) => {
  if (c === undefined || c === null || c === '') return d;
  const n = NAMED[String(c).toLowerCase()];
  if (n) return n;
  if (typeof c === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(c)) return c.toLowerCase();
  oops(`Colours look like #ff2a4f or a name (${Object.keys(NAMED).slice(0, 12).join(', ')}…), not "${c}".`);
};
const when = (v, what) => {  // a date and time a person or tool wrote, as milliseconds
  const t = typeof v === 'number' ? v : Date.parse(String(v));
  if (!Number.isFinite(t) || t < 1.5e12 || t > 4e12) oops(`Couldn't read the ${what} "${v}". Use a date and time like 2026-11-20T18:00:00Z.`);
  return t;
};

/* ---------- pictures: their size, and fetching them from the web ---------- */
// width and height from a PNG, JPEG, GIF or WebP header (JPEGs turned by their EXIF orientation come out turned)
function imageSize(b) {
  try {
    if (b.readUInt32BE(0) === 0x89504e47) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
    if (b.toString('latin1', 0, 4) === 'GIF8') return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
    if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
      const c = b.toString('latin1', 12, 16);
      if (c === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
      if (c === 'VP8L') return { w: 1 + (((b[22] & 0x3f) << 8) | b[21]), h: 1 + (((b[24] & 0xf) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6)) };
      if (c === 'VP8X') return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
    }
    if (b[0] === 0xff && b[1] === 0xd8) {
      let i = 2, turn = false;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) { i++; continue; }
        const m = b[i + 1], len = b.readUInt16BE(i + 2);
        if (m === 0xe1 && b.toString('latin1', i + 4, i + 10) === 'Exif\0\0') turn = exifTurned(b, i + 10);
        if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(m)) {
          const h = b.readUInt16BE(i + 5), w = b.readUInt16BE(i + 7);
          return turn ? { w: h, h: w } : { w, h };
        }
        i += 2 + len;
      }
    }
  } catch (e) { /* a broken header: the caller picks a size */ }
  return null;
}
function exifTurned(b, t) {
  const le = b.toString('latin1', t, t + 2) === 'II', u16 = o => (le ? b.readUInt16LE(o) : b.readUInt16BE(o)), u32 = o => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
  const ifd = t + u32(t + 4), n = u16(ifd);
  for (let k = 0; k < n; k++) { const e = ifd + 2 + k * 12; if (u16(e) === 0x0112) return u16(e + 8) >= 5; }
  return false;
}
// addresses inside a private network (this server, its neighbours, cloud metadata) are never fetched
function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
  }
  const s = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (s === '::' || s === '::1') return true;
  const v4 = s.match(/^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) return privateIp(v4[1]);
  const hx = s.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hx) { const a = parseInt(hx[1], 16), b = parseInt(hx[2], 16); return privateIp(`${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`); }
  if (s.startsWith('::')) return true;  // IPv4-compatible, mapped or translated forms the patterns above don't spell out
  return /^(fc|fd|fe[89a-f]|ff)/.test(s) || /^(64:ff9b:|100::|2001:db8|2001:0?:|2002:)/.test(s);
}
function parseVideoLink(s) {
  let m = String(s).trim().match(/^https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?(?:[^#\s]*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/|youtube-nocookie\.com\/embed\/)([\w-]{11})(?:[?&#][^\s]*)?$/i);
  if (m) return { p: 'yt', id: m[1] };
  m = String(s).trim().match(/^https?:\/\/(?:www\.|player\.)?vimeo\.com\/(?:video\/)?(\d{5,12})(?:[/?#][^\s]*)?$/i);
  return m ? { p: 'vimeo', id: m[1] } : null;
}

function mcp({ db, cfg, log, route, fail, H, A, limit, RANK, live, roleOf, projectRole, makeProject, members, version, passwordOk, storeAsset, assetInfo, assetPath, uploadMax, callRoute }) {
  const q = {
    alive: db.prepare('SELECT 1 FROM api_tokens WHERE id = ?'),
    insert: db.prepare('INSERT INTO api_tokens (id, token_hash, user_id, name, created_at, last_used) VALUES (?, ?, ?, ?, ?, 0)'),
    list: db.prepare('SELECT id, name, created_at, last_used FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC'),
    count: db.prepare('SELECT COUNT(*) AS n FROM api_tokens WHERE user_id = ?'),
    drop: db.prepare('DELETE FROM api_tokens WHERE id = ? AND user_id = ?'),
    dropAll: db.prepare('DELETE FROM api_tokens WHERE user_id = ?'),
    find: db.prepare(`SELECT t.id AS token_id, t.last_used, u.id, u.username, u.display_name, u.color, u.email, u.email_verified
      FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?`),
    used: db.prepare('UPDATE api_tokens SET last_used = ? WHERE id = ?'),
    teams: db.prepare('SELECT t.id, t.name, m.role FROM members m JOIN teams t ON t.id = m.team_id WHERE m.user_id = ? ORDER BY t.name COLLATE NOCASE'),
    projects: db.prepare('SELECT id, name, updated_at FROM projects WHERE team_id = ? ORDER BY updated_at DESC'),
    project: db.prepare('SELECT id, team_id, name FROM projects WHERE id = ?'),
    team: db.prepare('SELECT name FROM teams WHERE id = ?'),
    timezone: db.prepare('SELECT timezone FROM users WHERE id = ?'),
  };

  /* ---------- tokens, managed from the website ---------- */
  const tokenOut = t => ({ id: t.id, name: t.name, createdAt: t.created_at, lastUsed: t.last_used || null });
  route('GET', '/api/me/tokens', ctx => ({ tokens: q.list.all(ctx.user.id).map(tokenOut), endpoint: cfg.PUBLIC_URL + '/mcp' }));
  route('POST', '/api/me/tokens', async ctx => {
    const b = await H.readJson(ctx.req), name = str(b.name, 60) || 'MCP client';
    await passwordOk(ctx.user.id, typeof b.password === 'string' ? b.password : '');  // a token is long-lived access, so it takes the password
    if (q.count.get(ctx.user.id).n >= 10) fail(403, 'limit', 'You can have up to 10 tokens. Revoke one you don’t use first.');
    if (!limit('token-create:' + ctx.user.id, 20, 86400000)) fail(429, 'rate', 'That’s a lot of new tokens today. Try again tomorrow.');
    const token = 'vbt_' + crypto.randomBytes(32).toString('base64url'), id = newId();
    q.insert.run(id, A.tokenHash(token), ctx.user.id, name, Date.now());
    log('[mcp] token created by', ctx.user.username);
    return { token, id, name, endpoint: cfg.PUBLIC_URL + '/mcp' };
  });
  route('DELETE', '/api/me/tokens/:id', ctx => { q.drop.run(ctx.params.id, ctx.user.id); return { ok: true }; });

  /* ---------- reading and changing boards ---------- */
  function project(user, id, min) {
    const p = typeof id === 'string' && /^[\w-]{1,64}$/.test(id) ? q.project.get(id) : null;
    // their role in this project: a team admin may have given them one here that differs from their team role
    const role = p ? (projectRole ? projectRole(p, user.id) : roleOf(p.team_id, user.id)) : null;
    if (!p || !role) oops(`No project with id "${id}" that you can open. Use list_projects to see them.`);
    if (RANK[role] < RANK[min]) oops(`You're a ${role} in this project, so you can't ${min === 'editor' ? 'change its board' : 'do that'}. A team admin can change your role.`);
    return { p, role, doc: live().currentDoc(p.id) };
  }
  const boxOf = o => ({ x: o.x, y: o.y, w: o.w || 240, h: o.h || 100 });
  const inside = (o, f) => { const c = { x: o.x + (o.w || 240) / 2, y: o.y + (o.h || 100) / 2 }; return c.x >= f.x && c.x <= f.x + f.w && c.y >= f.y && c.y <= f.y + f.h; };
  const strokeBox = s => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (let i = 0; i < s.pts.length; i += 2) { x0 = Math.min(x0, s.pts[i]); x1 = Math.max(x1, s.pts[i]); y0 = Math.min(y0, s.pts[i + 1]); y1 = Math.max(y1, s.pts[i + 1]); } return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }; };
  const outer = o => (o.type === 'frame' ? { x: o.x, y: o.y - 40, w: o.w, h: o.h + 40 } : { x: o.x, y: o.y, w: Math.max(o.w || 0, 10), h: Math.max(o.h || 0, 10) });
  const union = boxes => { const b = boxes.filter(Boolean); if (!b.length) return null; const x0 = Math.min(...b.map(o => o.x)), y0 = Math.min(...b.map(o => o.y)); return { x: x0, y: y0, w: Math.max(...b.map(o => o.x + o.w)) - x0, h: Math.max(...b.map(o => o.y + o.h)) - y0 }; };
  const contentBox = doc => union([...doc.items.map(outer), ...doc.strokes.map(strokeBox)]);
  // new things without a position go in free space to the right of everything, in rows
  function placer(doc, at) {
    const b = contentBox(doc), x0 = at && fin(at.x) ? at.x : b ? rd(b.x + b.w + 160) : 0, y0 = at && fin(at.y) ? at.y : b ? rd(b.y) : 0;
    let x = x0, y = y0, rowH = 0;
    return (w, h) => { if (x > x0 && x + w > x0 + 2400) { x = x0; y += rowH + 60; rowH = 0; } const spot = { x: rd(x), y: rd(y) }; x += w + 60; rowH = Math.max(rowH, h); return spot; };
  }
  function apply(user, role, projectId, ops) {
    if (!ops.length) return { applied: 0 };
    const r = live().serverBatch(projectId, user, role, ops);
    if (!r) oops('That project no longer exists.');
    if (r.readOnly) oops("You can only read and comment on this project's board.");
    if (r.full) oops(`The board is full: boards can be up to ${cfg.PROJECT_MAX_MB} MB, not counting images.`);
    if (r.quota) oops('This team has used all its storage. Delete old projects or versions to make room.');
    return r;
  }
  const put = (k, obj) => ({ k, op: 'put', obj });
  function findObj(doc, id) {
    for (const k of ['items', 'links', 'strokes', 'comments']) { const o = doc[k].find(x => x.id === id); if (o) return { k, o }; }
    return null;
  }
  // a card by id or exact title (and cards made earlier in the same call); any other object by id
  function resolveCard(doc, ref, made) {
    if (made && made.has(String(ref).toLowerCase())) return made.get(String(ref).toLowerCase());
    const byId = doc.items.find(i => i.type === 'node' && i.id === ref);
    if (byId) return byId.id;
    const byTitle = doc.items.filter(i => i.type === 'node' && i.title.toLowerCase() === String(ref).toLowerCase());
    if (byTitle.length === 1) return byTitle[0].id;
    oops(byTitle.length > 1 ? `More than one card is called "${ref}". Use its id instead.` : `No card "${ref}" on this board.`);
  }
  const commentTarget = (doc, ref) => (doc.items.some(i => i.id === ref && i.type === 'image') ? ref : resolveCard(doc, ref));
  const resolveItem = (doc, ref, made) => (doc.items.some(i => i.id === ref) ? ref : resolveCard(doc, ref, made));
  function people(teamId, refs) {
    const all = members(teamId);
    return [...new Set((Array.isArray(refs) ? refs : [refs]).slice(0, 8).map(r => {
      const s = String(r).replace(/^@/, '').toLowerCase();
      const m = all.find(x => x.id === r || x.username.toLowerCase() === s) || (all.filter(x => x.name.toLowerCase() === s).length === 1 && all.find(x => x.name.toLowerCase() === s));
      if (!m) oops(`No one called "${r}" in this team. get_team lists the people you can assign.`);
      return m.id;
    }))];
  }
  // teammates by name; integrations and players by the names the app shows them with
  const AUTHORS = { 'vb-github': 'GitHub', 'vb-gitlab': 'GitLab' };
  const nameOf = all => id => (all.find(m => m.id === id) || {}).name || AUTHORS[id] || (/^vb-play-/.test(id) ? 'Playtester' : /^vb-bugs-/.test(id) ? 'Bug reporter' : 'former member');
  function describe(doc, all, projectId) {
    const frames = doc.items.filter(i => i.type === 'frame' && !i.mood), cards = doc.items.filter(i => i.type === 'node'), name = nameOf(all), ref = refsFor(projectId, doc);
    const phaseOf = c => { const f = frames.find(fr => inside(c, fr)); return f ? f.id : null; };
    const incoming = new Map();
    for (const l of doc.links) if (l.from.id && l.to.id) { if (!incoming.has(l.to.id)) incoming.set(l.to.id, []); incoming.get(l.to.id).push(l.from.id); }
    const byId = new Map(cards.map(c => [c.id, c]));
    const card = c => {
      const o = { id: c.id, kind: c.kind || 'task', title: c.title, status: c.status };
      if (c.prio) o.priority = c.prio;
      if (c.disc) o.discipline = c.disc;
      if (c.est) o.estimate = c.est;
      if (c.due) o.due = c.due;
      if (c.kind === 'bug' && c.sev) o.severity = c.sev;
      if (c.body) o.notes = c.body.length > 600 ? c.body.slice(0, 600) + '…' : c.body;
      if (c.assignees && c.assignees.length) o.assignees = c.assignees.map(name);
      if (c.tags && c.tags.length) o.tags = c.tags;
      if (c.spent) o.tracked = fmtMinutes(c.spent);
      if (ref(c.id)) o.reference = ref(c.id);
      const w = incoming.get(c.id);
      if (w && w.length) o.waits_on = w;
      const n = doc.comments.filter(m => m.card === c.id).length;
      if (n) o.comments = n;
      return o;
    };
    const work = cards.filter(c => c.kind !== 'idea' && c.kind !== 'milestone');
    const done = work.filter(c => c.status === 'done').length, today = new Date().toISOString().slice(0, 10);
    const ready = work.filter(c => c.status !== 'done' && (incoming.get(c.id) || []).every(id => !byId.has(id) || byId.get(id).status === 'done'));
    return {
      summary: { cards: cards.length, tasks_done: done, tasks_total: work.length, percent_done: work.length ? Math.round(done / work.length * 100) : 0,
        blocked: work.filter(c => c.status === 'blocked').length, open_bugs: cards.filter(c => c.kind === 'bug' && c.status !== 'done').length,
        ready_to_start: ready.map(c => c.title).slice(0, 50), overdue: cards.filter(c => c.due && c.due < today && c.status !== 'done').map(c => `${c.title} (due ${c.due})`).slice(0, 50),
        milestones: cards.filter(c => c.kind === 'milestone').map(c => ({ title: c.title, due: c.due || null, status: c.status })) },
      phases: frames.sort((a, b) => a.x - b.x || a.y - b.y).map(f => ({ id: f.id, title: f.title, ...(f.sprint ? { sprint: sprintOut(f.sprint, name) } : {}), ...(f.collapsed ? { collapsed: true } : {}),
        cards: cards.filter(c => phaseOf(c) === f.id).map(card) })),
      unphased_cards: cards.filter(c => !phaseOf(c)).map(card),
      other: { text: doc.items.filter(i => i.type === 'text').length, images: doc.items.filter(i => i.type === 'image').length, videos: doc.items.filter(i => i.type === 'video').length,
        mood_boards: doc.items.filter(i => i.type === 'frame' && i.mood).length, jam_clocks: doc.items.filter(i => i.type === 'jam').length, connectors: doc.links.length, ink_strokes: doc.strokes.length, comments: doc.comments.length,
        note: 'get_items lists every object with its position and size.' },
    };
  }
  // every object as a tool sees it: friendly names, positions and sizes
  // a sprint from a tool: dates, and capacity by username (or "everyone"), checked like the app does
  function sprintIn(v, teamId) {
    if (v === null || v === false) return null;
    if (!v || !isDate(v.start) || !isDate(v.end) || v.end < v.start) oops('A sprint needs start and end dates like 2026-11-02, the end not before the start.');
    if ((Date.parse(v.end) - Date.parse(v.start)) / 86400000 > 366) oops('A sprint can be up to a year long.');
    const sp = { start: v.start, end: v.end }, cap = v.capacity_days;
    if (cap && typeof cap === 'object') {
      const out = {};
      for (const [who, days] of Object.entries(cap).slice(0, 50)) {
        const d = Number(days);
        if (!(d >= 0 && d <= 365)) oops(`Capacity is 0 to 365 days, not "${days}".`);
        out[/^(everyone|all)$/i.test(who) ? 'all' : people(teamId, [who])[0]] = Math.round(d * 10) / 10;
      }
      if (Object.keys(out).length) sp.cap = out;
    }
    return sp;
  }
  // a picture's crop and quarter turn, keeping its centre and the scale it shows at, like the app
  function turnAndCrop(o, u) {
    const c0 = o.crop || { x: 0, y: 0, w: 1, h: 1 }, r0 = o.rot || 0;
    let c1 = c0, r1 = r0;
    if (u.crop !== undefined) {
      const c = u.crop;
      if (c === null) c1 = { x: 0, y: 0, w: 1, h: 1 };
      else if (!c || ![c.x, c.y, c.w, c.h].every(fin) || c.x < 0 || c.y < 0 || c.w <= 0.01 || c.h <= 0.01 || c.x + c.w > 1.0001 || c.y + c.h > 1.0001) oops('A crop is {"x", "y", "w", "h"} as fractions of the whole picture: inside 0..1, w and h over 0.01.');
      else c1 = { x: c.x, y: c.y, w: Math.min(c.w, 1 - c.x), h: Math.min(c.h, 1 - c.y) };
    }
    if (u.rotate !== undefined) { r1 = Number(u.rotate); if (![0, 90, 180, 270].includes(r1)) oops('rotate is 0, 90, 180 or 270.'); }
    const side = r => r === 90 || r === 270, W0 = side(r0) ? o.h : o.w, H0 = side(r0) ? o.w : o.h;  // the crop's size before turning
    const W1 = W0 * c1.w / c0.w, H1 = H0 * c1.h / c0.h, w = side(r1) ? H1 : W1, h = side(r1) ? W1 : H1, cx = o.x + o.w / 2, cy = o.y + o.h / 2;
    Object.assign(o, { x: rd(cx - w / 2), y: rd(cy - h / 2), w: rd(w), h: rd(h) });
    if (c1.x > 0 || c1.y > 0 || c1.w < 1 || c1.h < 1) o.crop = c1; else delete o.crop;
    if (r1) o.rot = r1; else delete o.rot;
  }
  // tags as a tool writes them: lower case, spaces become -, up to 8
  function tagsIn(v, what) {
    const tags = [...new Set((Array.isArray(v) ? v : [v]).map(t => String(t).trim().toLowerCase().replace(/\s+/g, '-')).filter(Boolean))];
    const bad = tags.find(t => !/^[\p{L}\p{N}_-]{1,24}$/u.test(t));
    if (bad) oops(`Tags are 1-24 letters, digits, - or _, not "${bad}".`);
    if (tags.length > 8) oops(`${what} can have up to 8 tags.`);
    return tags;
  }
  // a reference picture's or video's tags, note and the address it came from, checked like the app does. An empty one
  // is kept as empty (not left out), or the live path would keep the old one for an app that doesn't know them.
  function refIn(o, u) {
    if (u.tags !== undefined) o.tags = tagsIn(u.tags, 'A picture or video');
    if (u.note !== undefined) o.note = str(u.note, 500);
    if (u.source !== undefined) {
      const s = str(u.source, 601);
      if (s && !okSource(s)) oops(`A source is a plain http or https web address (up to 600 characters, no spaces or logins), not "${str(u.source, 80)}".`);
      o.source = s;
    }
    return o;
  }
  const refOut = (o, i, src = 'source') => { if (i.tags && i.tags.length) o.tags = i.tags; if (i.note) o.note = i.note; if (i.source) o[src] = i.source; };
  // a card's reference for commits and pull requests (VB-…), when the project can have them
  function refsFor(projectId, doc) {
    if (!projectId) return () => null;
    const { byCode } = cardCodes(projectId, doc.items.filter(i => i.type === 'node')), out = new Map();
    for (const [code, c] of byCode) out.set(c.id, 'VB-' + code);
    return id => out.get(id) || null;
  }
  const fmtMinutes = m => (m >= 60 ? `${Math.round(m / 6) / 10}h` : `${m}m`);
  const sprintOut = (sp, name) => ({ start: sp.start, end: sp.end, ...(sp.cap ? { capacity_days: Object.fromEntries(Object.entries(sp.cap).map(([k, v]) => [k === 'all' ? 'everyone' : name(k), v])) } : {}) });
  function itemOut(i, name, ref = () => null) {
    const o = { id: i.id, type: i.type === 'node' ? 'card' : i.type, x: i.x, y: i.y, w: i.w, h: i.h };
    if (i.locked) o.locked = true;
    switch (i.type) {
      case 'node':
        Object.assign(o, { kind: i.kind || 'task', title: i.title, status: i.status, color: i.color });
        if (i.prio) o.priority = i.prio;
        if (i.disc) o.discipline = i.disc;
        if (i.est) o.estimate = i.est;
        if (i.due) o.due = i.due;
        if (i.start) o.starts = i.start;
        if (i.sev) o.severity = i.sev;
        if (i.body) o.notes = i.body.length > 2000 ? i.body.slice(0, 2000) + '…' : i.body;
        if (i.assignees && i.assignees.length) o.assignees = i.assignees.map(name);
        if (i.nopub) o.hidden_from_roadmap = true;
        if (i.tags && i.tags.length) o.tags = i.tags;
        if (i.spent) { o.tracked = fmtMinutes(i.spent); o.tracked_minutes = i.spent; }
        if (i.gitLinks && i.gitLinks.length) o.git_links = i.gitLinks;
        if (ref(i.id)) o.reference = ref(i.id);
        break;
      case 'text': Object.assign(o, { text: i.text, size: i.size, color: i.color }); break;
      case 'frame': Object.assign(o, { title: i.title, color: i.color }); if (i.collapsed) o.collapsed = true; if (i.sprint) o.sprint = sprintOut(i.sprint, name); if (i.mood) o.mood = true; break;
      case 'image': Object.assign(o, { name: i.name, has_picture: !!i.src }); if (i.flip) o.flip = true; if (i.gray) o.gray = true; if (i.crop) o.crop = i.crop; if (i.rot) o.rotate = i.rot; refOut(o, i); break;
      // a video's source is where it plays from, so the address it came from is its source_link
      case 'video': Object.assign(o, { name: i.name, loop: i.loop, autoplay: i.autoplay }, i.embed ? { source: i.embed.p === 'yt' ? `https://www.youtube.com/watch?v=${i.embed.id}` : `https://vimeo.com/${i.embed.id}` } : { source: i.src ? 'file on this server' : 'missing' }); refOut(o, i, 'source_link'); break;
      case 'jam': Object.assign(o, { title: i.title, theme: i.theme, deadline: new Date(i.end).toISOString(), people: i.people, color: i.color }); if (i.reveal) o.theme_revealed_at = new Date(i.reveal).toISOString(); break;
    }
    return o;
  }
  const linkOut = l => ({ id: l.id, from: l.from.id ? l.from.id : { x: l.from.x, y: l.from.y }, to: l.to.id ? l.to.id : { x: l.to.x, y: l.to.y }, style: l.style, head: l.head, color: l.color,
    ...(l.label ? { label: l.label } : {}), ...(l.dash ? { dashed: true } : {}), ...(l.flow ? { flow: true } : {}), ...(l.width ? { width: l.width } : {}), ...(l.via ? { via: l.via } : {}) });
  // the timeline: working days from today, each card after what it waits on, the chain with no slack is critical
  function schedule(doc) {
    const nodes = doc.items.filter(n => n.type === 'node' && n.kind !== 'idea' && n.prio !== 'wont');
    const byId = new Map(nodes.map(n => [n.id, n])), preds = new Map(nodes.map(n => [n.id, []])), succs = new Map(nodes.map(n => [n.id, []]));
    // a wire's ends as cards: a phase stands for the cards in it, so a wire between phases makes the second wait on the first
    // (a mood board collection isn't a phase, so a wire to one changes nothing)
    const all = new Map(doc.items.map(i => [i.id, i])), inPhase = new Map();
    const ends = e => { const o = e && e.id ? all.get(e.id) : null; if (!o) return []; if (o.type === 'node') return byId.has(o.id) ? [o] : [];
      if (o.type !== 'frame' || o.mood) return []; if (!inPhase.has(o.id)) inPhase.set(o.id, nodes.filter(n => inside(n, o))); return inPhase.get(o.id); };
    for (const l of doc.links) {
      if (!l.from.id || !l.to.id || l.from.id === l.to.id) continue;
      for (const b of ends(l.to)) for (const a of ends(l.from)) if (a.id !== b.id && !preds.get(b.id).includes(a.id)) { preds.get(b.id).push(a.id); succs.get(a.id).push(b.id); }
    }
    // working days from today to a date (its start date): the schedule doesn't start a card before it
    const offsetTo = day => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); while ([0, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() + 1); let n = 0;
      for (let i = 0; d.toISOString().slice(0, 10) < day && i < 4000; i++) { d.setUTCDate(d.getUTCDate() + 1); if (![0, 6].includes(d.getUTCDay())) n++; } return n; };
    const order = [], state = new Map();
    const visit = id => { if (state.get(id)) return; state.set(id, 1); for (const p of preds.get(id)) visit(p); state.set(id, 2); order.push(id); };
    for (const n of nodes) visit(n.id);
    const S = new Map(), dur = n => (n.kind === 'milestone' ? 0 : Math.max(0.5, estDays(n.est) || 1));
    for (const id of order) {
      const n = byId.get(id);
      if (n.status === 'done') { S.set(id, { n, done: true }); continue; }
      let es = isDate(n.start) ? offsetTo(n.start) : 0;
      for (const p of preds.get(id)) { const ps = S.get(p); if (ps && !ps.done) es = Math.max(es, ps.ef); }
      S.set(id, { n, d: dur(n), es, ef: es + dur(n) });
    }
    const liveS = [...S.values()].filter(s => !s.done), end = Math.max(0, ...liveS.map(s => s.ef));
    for (const id of [...order].reverse()) {
      const s = S.get(id); if (s.done) continue;
      let lf = end;
      for (const c of succs.get(id)) { const cs = S.get(c); if (cs && !cs.done) lf = Math.min(lf, cs.ls); }
      s.ls = lf - s.d; s.slack = s.ls - s.es;
    }
    const workday = offset => {  // the date `offset` working days from today
      const d = new Date(); d.setUTCHours(0, 0, 0, 0);
      while ([0, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() + 1);
      for (let n = Math.floor(offset); n > 0;) { d.setUTCDate(d.getUTCDate() + 1); if (![0, 6].includes(d.getUTCDay())) n--; }
      return d.toISOString().slice(0, 10);
    };
    const rows = liveS.sort((a, b) => a.es - b.es).map(s => ({ id: s.n.id, title: s.n.title, kind: s.n.kind || 'task', start: workday(s.es), finish: workday(Math.max(s.es, Math.ceil(s.ef) - 1)),
      working_days: Math.round(s.d * 10) / 10, slack_days: Math.round(s.slack * 10) / 10, critical: s.slack < 0.01,
      ...(isDate(s.n.due) ? { due: s.n.due, late: workday(Math.max(s.es, Math.ceil(s.ef) - 1)) > s.n.due } : {}) }));
    return { working_days_left: Math.ceil(end), finishes_around: liveS.length ? workday(Math.max(0, Math.ceil(end) - 1)) : null,
      critical_path: rows.filter(r => r.critical && r.kind !== 'milestone').map(r => r.title), late: rows.filter(r => r.late).map(r => r.title), tasks: rows.slice(0, 300),
      note: 'Working days only. Estimates in days; a card with no estimate counts as one day. Arrows mean "waits on", and an arrow between phases makes everything in the second wait on the first. A card with a start date doesn\'t start before it.' };
  }
  // a card built the way the app builds one
  function cardFrom(input, x, y, existing, teamId) {
    const kind = KINDS.includes(String(input.kind || '').toLowerCase()) ? String(input.kind).toLowerCase() : existing ? existing.kind || 'task' : 'task';
    const c = existing ? { ...existing } : { id: newId(), type: 'node', kind, x, y, w: kind === 'idea' ? 220 : kind === 'milestone' ? 250 : 240, h: 100, title: 'New task', body: '', status: 'todo', color: BONE, disc: '', prio: '', est: '', due: '', createdAt: Date.now() };
    const kindChanged = existing && existing.kind !== kind;
    c.kind = kind;
    if (input.title !== undefined) c.title = str(input.title, 500) || c.title;
    if (input.notes !== undefined) c.body = str(input.notes, 8000);
    if (input.status !== undefined) { const s = STATUS[String(input.status).toLowerCase()]; if (!s) oops(`Unknown status "${input.status}". Use todo, doing, blocked or done.`); if (s === 'done' && c.status !== 'done') c.doneAt = Date.now(); c.status = s; }
    if (input.priority !== undefined) { const p = input.priority === '' || input.priority === null ? '' : PRIO[String(input.priority).toLowerCase()]; if (p === undefined) oops(`Unknown priority "${input.priority}". Use must, should, could or wont.`); c.prio = p; }
    if (input.discipline !== undefined) { const d = input.discipline === '' || input.discipline === null ? '' : DISC[String(input.discipline).toLowerCase()]; if (d === undefined) oops(`Unknown discipline "${input.discipline}". Use one of: ${Object.keys(DISC_COLOR).join(', ')}.`); c.disc = d; }
    if (input.estimate !== undefined) { const e = str(input.estimate, 12); if (e && !estDays(e)) oops(`Couldn't read the estimate "${input.estimate}". Use hours, days or weeks, like 4h, 2d or 1w.`); c.est = e; }
    if (input.due !== undefined) { if (input.due && !isDate(input.due)) oops(`Due dates look like 2026-11-30, not "${input.due}".`); c.due = input.due || ''; }
    if (input.starts !== undefined) { if (input.starts && !isDate(input.starts)) oops(`Start dates look like 2026-11-30, not "${input.starts}".`); c.start = input.starts || ''; }
    if (input.severity !== undefined && kind === 'bug') c.sev = ['crash', 'major', 'minor', 'polish'].includes(input.severity) ? input.severity : 'major';
    if (input.assignees !== undefined) { const who = input.assignees && input.assignees.length ? people(teamId, input.assignees) : []; if (who.length) c.assignees = who; else delete c.assignees; }
    if (input.hide_from_roadmap !== undefined) { if (input.hide_from_roadmap) c.nopub = true; else delete c.nopub; }
    if (input.tags !== undefined) { const tags = tagsIn(input.tags, 'A card'); if (tags.length) c.tags = tags; else delete c.tags; }
    if (input.tracked_minutes !== undefined) { const m = Math.round(Number(input.tracked_minutes)); if (!(m >= 0 && m <= 1e6)) oops('tracked_minutes is a whole number of minutes, 0 to 1,000,000.'); if (m) c.spent = m; else delete c.spent; }
    if (input.git_links !== undefined) {
      const links = [...new Set(Array.isArray(input.git_links) ? input.git_links : [input.git_links])];
      const bad = links.find(u => !okGitLink(u));
      if (bad) oops(`Linked pull requests and issues are https addresses on github.com or gitlab.com, not "${bad}".`);
      if (links.length > 10) oops('A card can link up to 10 pull requests and issues.');
      if (links.length) c.gitLinks = links; else delete c.gitLinks;
    }
    for (const k of ['x', 'y']) if (fin(input[k])) c[k] = rd(input[k]);
    if (fin(input.w) && input.w > 0) c.w = rd(input.w);
    if (input.locked !== undefined) { if (input.locked) c.locked = true; else delete c.locked; }
    // the colour follows the kind of card and a task's discipline, unless one is given
    if (input.color !== undefined) c.color = colorArg(input.color, c.color);
    else if (!existing || kindChanged || input.discipline !== undefined) {
      if (kind === 'bug') { c.color = '#ff7a1a'; if (!c.disc) c.disc = 'qa'; if (!c.sev) c.sev = 'major'; }
      else if (kind === 'idea') c.color = '#ffd23d';
      else if (kind === 'milestone') c.color = BONE;
      else c.color = c.disc ? DISC_COLOR[c.disc] : (existing && !kindChanged ? existing.color : BONE);
    }
    if (kind === 'bug' && !c.sev) c.sev = 'major';
    if (kind !== 'bug') delete c.sev;
    return c;
  }
  // where the next cards go inside a phase: two columns, below what's there, growing the frame to fit
  function slotsIn(frame, doc, n) {
    const taken = doc.items.filter(i => i.type === 'node' && inside(i, frame)).map(boxOf);
    const out = [];
    for (let r = 0; out.length < n && r < 400; r++) for (let c = 0; c < 2 && out.length < n; c++) {
      const x = frame.x + 40 + c * 280, y = frame.y + 70 + r * 190;
      if (!taken.some(t => t.x < x + 240 && t.x + t.w > x && t.y < y + 150 && t.y + t.h > y)) { out.push({ x, y }); taken.push({ x, y, w: 240, h: 150 }); }
    }
    const bottom = Math.max(...out.map(s => s.y + 190), frame.y + frame.h);
    return { slots: out, height: bottom - frame.y };
  }
  const STYLE = { curved: 'curve', curve: 'curve', tendril: 'curve', straight: 'straight', elbow: 'elbow', circuit: 'circuit' };
  const HEAD = { end: 'end', both: 'both', none: 'none' };
  function linkFrom(input, from, to, existing) {
    const l = existing ? { ...existing } : { id: newId(), type: 'link', from, to, color: BONE, style: 'curve', head: 'end', dash: false, flow: false, label: '' };
    if (input.style !== undefined) l.style = STYLE[input.style] || oops(`Connector styles are curved, straight, elbow or circuit, not "${input.style}".`);
    if (input.via !== undefined) {
      const via = (Array.isArray(input.via) ? input.via : oops('via is a list of points like {"x": 100, "y": 200}.')).slice(0, 24).map(k => (k && fin(k.x) && fin(k.y) ? { x: rd(k.x), y: rd(k.y) } : oops('Each reroute point looks like {"x": 100, "y": 200}.')));
      if (via.length) l.via = via; else delete l.via;
    }
    if (input.arrowheads !== undefined) l.head = HEAD[input.arrowheads] || oops(`Arrowheads are end, both or none, not "${input.arrowheads}".`);
    if (input.dashed !== undefined) l.dash = !!input.dashed;
    if (input.flow !== undefined) l.flow = !!input.flow;
    if (input.label !== undefined) l.label = str(input.label, 60);
    if (input.color !== undefined) l.color = colorArg(input.color, l.color);
    if (input.width !== undefined) l.width = clamp(Number(input.width) || 2.5, 1, 12);
    return l;
  }
  const end = (doc, v, made) => (v && typeof v === 'object' ? (fin(v.x) && fin(v.y) ? { x: rd(v.x), y: rd(v.y) } : oops('A connector end is an object id, a card title or a point like {"x": 100, "y": 200}.')) : { id: resolveItem(doc, v, made) });

  /* ---------- pictures and videos ---------- */
  // fetches a picture or video from a public web address, never from inside a private network
  async function fetchPublic(raw, max, hops = 0) {
    let u;
    try { u = new URL(String(raw)); } catch (e) { oops(`"${raw}" isn't a web address.`); }
    if (!/^https?:$/.test(u.protocol) || u.username || u.password) oops('Only plain http and https addresses can be fetched.');
    if (u.port && !['80', '443', '8080', '8443'].includes(u.port) && !cfg.MCP_FETCH_PRIVATE) oops('That address uses a port that isn\'t fetched.');
    const bare = u.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(bare) && !cfg.MCP_FETCH_PRIVATE && privateIp(bare)) oops('That address is inside a private network, so it can\'t be fetched.');
    const addrs = await dns.lookup(bare, { all: true }).catch(() => oops(`Couldn't find ${u.hostname}.`));
    if (!addrs.length || (!cfg.MCP_FETCH_PRIVATE && addrs.some(a => privateIp(a.address)))) oops('That address is inside a private network, so it can\'t be fetched.');
    const pick = addrs[0];
    return new Promise((resolve, reject) => {
      const lookup = (host, o, cb) => (o && o.all ? cb(null, [{ address: pick.address, family: pick.family }]) : cb(null, pick.address, pick.family));
      const req = (u.protocol === 'https:' ? https : http).request(u, { method: 'GET', lookup, timeout: 15000, signal: AbortSignal.timeout(30000), headers: { 'User-Agent': `VenomBoard/1 (+${cfg.PUBLIC_URL})`, Accept: 'image/*,video/*;q=0.9,*/*;q=0.5' } }, res => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          if (hops >= 4) return reject(new ToolError('That address redirects too many times.'));
          let next;  // this runs outside any request handler: an address the parser rejects must not throw here
          try { next = new URL(res.headers.location, u).href; } catch (e) { return reject(new ToolError('That address redirects somewhere invalid.')); }
          return resolve(fetchPublic(next, max, hops + 1));
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new ToolError(`That address answered ${res.statusCode}, not a picture.`)); }
        if (Number(res.headers['content-length'] || 0) > max) { res.destroy(); return reject(new ToolError(`That file is bigger than ${Math.round(max / 1048576)} MB.`)); }
        const chunks = []; let size = 0;
        res.on('data', c => { size += c.length; if (size > max) { res.destroy(); reject(new ToolError(`That file is bigger than ${Math.round(max / 1048576)} MB.`)); } else chunks.push(c); });
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', () => reject(new ToolError('The download broke off. Try again.')));
        res.on('close', () => { if (!res.complete) reject(new ToolError('The download broke off. Try again.')); });
      });
      req.on('timeout', () => req.destroy(new ToolError('That site took too long to answer.')));
      req.on('error', e => reject(e instanceof ToolError ? e : e.name === 'TimeoutError' || e.name === 'AbortError' ? new ToolError('That download took too long.') : new ToolError(`Couldn't download that (${e.code || e.message}).`)));
      req.end();
    });
  }
  const fetching = new Map();
  let fetchingAll = 0;
  async function fetchFor(user, url, max) {
    const n = fetching.get(user.id) || 0;
    if (n >= 2 || fetchingAll >= 16) oops('Other pictures are still downloading. Try again in a moment.');
    if (!limit('mcp-fetch:' + user.id, 60, 3600000)) oops('That\'s a lot of downloads this hour. Try again later.');
    fetching.set(user.id, n + 1); fetchingAll++;
    try { return await fetchPublic(url, max); }
    finally { fetchingAll--; const k = (fetching.get(user.id) || 1) - 1; if (k) fetching.set(user.id, k); else fetching.delete(user.id); }
  }
  // one-time addresses a tool's shell can send a local file to (curl --data-binary), for pictures on the user's computer
  const tickets = new Map();
  const sweep = () => { const now = Date.now(); for (const [k, t] of tickets) if (t.exp < now) tickets.delete(k); };
  // the bytes behind a picture or video someone gives: a web address, base64 data, or an upload_id
  async function mediaBytes(user, p, m) {
    if (m.upload_id) {
      const a = assetInfo(String(m.upload_id));
      if (!a || a.project_id !== p.id) oops(`No upload "${m.upload_id}" in this project. get_upload_url makes one.`);
      return { asset: a, buf: fs.readFileSync(assetPath(a.id)) };
    }
    let buf;
    if (m.data) {
      const b64 = String(m.data).replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
      if (!/^[A-Za-z0-9+/_-]+=*$/.test(b64)) oops('data must be base64 (or a data: URL).');
      buf = Buffer.from(b64, 'base64');
    } else if (m.url) buf = await fetchFor(user, m.url, cfg.VIDEO_UPLOADS ? uploadMax() : 15 * 1048576);
    else oops('Give a url, base64 data or an upload_id.');
    const a = storeAsset(user, p, buf);
    return { asset: { id: a.id, mime: a.mime }, buf };
  }
  function sized(input, natural, maxSide) {
    const ar = natural && natural.w > 0 && natural.h > 0 ? natural.h / natural.w : 9 / 16;
    let w = fin(input.width) && input.width > 0 ? input.width : natural ? natural.w : 480;
    if (!fin(input.width) && natural && Math.max(natural.w, natural.h) > maxSide) w = natural.w >= natural.h ? maxSide : maxSide / ar;
    w = clamp(w, 16, 8000);
    return { w: rd(w), h: rd(fin(input.height) && input.height > 0 ? input.height : w * ar) };
  }

  /* ---------- templates, built by the app's own code ---------- */
  let tplCache = null;
  function templates() {
    const file = path.join(cfg.APP_DIR, 'index.html');
    let st;
    try { st = fs.statSync(file); } catch (e) { return { list: [], build: () => null }; }
    if (tplCache && tplCache.mtime === st.mtimeMs) return tplCache;
    try {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      const grab = name => {
        const i = lines.findIndex(l => new RegExp(`^(const|let|function) ${name}\\b`).test(l));
        if (i < 0) throw new Error('index.html has no ' + name);
        if (/^function /.test(lines[i]) || /[[{(]\s*$/.test(lines[i])) { const j = lines.findIndex((x, k) => k > i && /^[}\]]\)?;?\s*$/.test(x)); return lines.slice(i, j + 1).join('\n'); }
        return lines[i];
      };
      const box = vm.createContext({ uid: newId, opts: { node: { color: BONE } } });
      vm.runInContext(TPL_PARTS.map(grab).join('\n') + '\nthis.list = JSON.stringify(TEMPLATES); this.make = k => JSON.stringify(tplBuild(k) || null);', box, { timeout: 1000 });
      tplCache = { mtime: st.mtimeMs, list: JSON.parse(box.list).map(([key, name, about]) => ({ key, name, about })),
        build: key => JSON.parse(vm.runInContext(`make(${JSON.stringify(key)})`, box, { timeout: 1000 })) };
    } catch (e) { log('[mcp] templates unavailable:', e.message); tplCache = { mtime: st.mtimeMs, list: [], build: () => null }; }
    return tplCache;
  }
  function templateDoc(key) {
    const t = templates(), found = t.list.find(x => x.key === key || x.name.toLowerCase() === String(key).toLowerCase());
    if (!found) oops(t.list.length ? `No template "${key}". list_templates shows them: ${t.list.map(x => x.key).join(', ')}.` : 'Templates aren\'t available on this server right now.');
    const d = t.build(found.key) || oops('That template couldn\'t be built.');
    return { name: found.name, items: d.items || [], links: d.links || [], strokes: d.strokes || [] };
  }

  /* ---------- your tasks, for panels in game engine editors (Godot, Unity, Unreal) ---------- */
  // one flat row per card, every field always there (empty when unset), so small clients can read it simply
  const PRIO_ORDER = { must: 0, should: 1, could: 2, '': 3, wont: 4 };
  const STATUS_ORDER = { doing: 0, blocked: 1, todo: 2, done: 3 };
  const MY_TASKS_MAX = 500, MY_TASKS_PROJECTS = 300;
  // today where the person is: the day their editor sends, else their time zone from the website, else UTC
  function todayFor(user, given) {
    if (isDate(given)) return given;
    const tz = (q.timezone.get(user.id) || {}).timezone || 'UTC';
    try {
      const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()), g = t => p.find(x => x.type === t).value;
      return `${g('year')}-${g('month')}-${g('day')}`;
    } catch (e) { return new Date().toISOString().slice(0, 10); }
  }
  const dayDiff = (from, to) => Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000);
  function taskOut(user, ctx, c, today) {
    const due = isDate(c.due) ? c.due : '', who = c.assignees || [];
    const phase = ctx.frames.find(f => inside(c, f));
    return { project_id: ctx.p.id, project: ctx.p.name, team: ctx.team, can_edit: RANK[ctx.role] >= RANK.editor,
      card_id: c.id, title: c.title, kind: c.kind || 'task', status: c.status || 'todo', priority: c.prio || '', discipline: c.disc || '',
      estimate: c.est || '', due, due_in_days: due ? dayDiff(today, due) : null, overdue: !!due && due < today && c.status !== 'done',
      severity: c.kind === 'bug' ? c.sev || 'major' : '', phase: phase ? phase.title : '', color: (c.disc && DISC_COLOR[c.disc]) || c.color || BONE,
      assigned_to_you: who.includes(user.id), assignees: who.map(ctx.name), link: `${cfg.PUBLIC_URL}/app#p=${encodeURIComponent(ctx.p.id)}&c=${encodeURIComponent(c.id)}` };
  }
  const projectCtx = (p, role, teamName, doc) => ({ p, role, team: teamName, doc, frames: doc.items.filter(i => i.type === 'frame' && !i.mood), name: nameOf(members(p.team_id)) });  // phases, not mood board collections
  const rank = (table, v) => (table[v] === undefined ? 9 : table[v]);
  const taskOrder = (a, b) => (a.due ? 0 : 1) - (b.due ? 0 : 1) || a.due.localeCompare(b.due) || rank(PRIO_ORDER, a.priority) - rank(PRIO_ORDER, b.priority)
    || rank(STATUS_ORDER, a.status) - rank(STATUS_ORDER, b.status) || a.project.localeCompare(b.project) || a.title.localeCompare(b.title);
  function myTasks(user, a) {
    if (a.include_unassigned_in_project && !a.project_id) oops('include_unassigned_in_project needs a project_id: unassigned cards are listed for one project at a time.');
    if (a.today !== undefined && a.today !== '' && !isDate(a.today)) oops(`today looks like 2026-11-30, not "${a.today}".`);
    if (!limit('mcp-my-tasks:' + user.id, 30, 60000)) oops('That\'s a lot of refreshes in a minute. Wait a little and try again.');
    const today = todayFor(user, a.today), places = [];
    if (a.project_id) {
      const { p, role, doc } = project(user, a.project_id, 'viewer');
      places.push({ p, role, team: (q.team.get(p.team_id) || {}).name || '', doc });
    } else {
      for (const t of q.teams.all(user.id)) for (const p of q.projects.all(t.id)) places.push({ p: { ...p, team_id: t.id }, role: projectRole ? projectRole({ id: p.id, team_id: t.id }, user.id) : t.role, team: t.name });  // the role in that project
      places.sort((x, y) => y.p.updated_at - x.p.updated_at).splice(MY_TASKS_PROJECTS);  // the most recently edited, for people in very many teams
    }
    const rows = [], projects = [];
    for (const pl of places) {
      const doc = pl.doc || live().currentDoc(pl.p.id);
      if (!doc) continue;
      const ctx = projectCtx(pl.p, pl.role, pl.team, doc);
      const mine = doc.items.filter(c => c.type === 'node' && c.status !== 'done'
        && ((c.assignees || []).includes(user.id) || (a.include_unassigned_in_project && !(c.assignees || []).length)));
      for (const c of mine) rows.push(taskOut(user, ctx, c, today));
      projects.push({ project_id: pl.p.id, project: pl.p.name, team: pl.team, can_edit: RANK[pl.role] >= RANK.editor, tasks: mine.length });
    }
    rows.sort(taskOrder);
    projects.sort((x, y) => x.team.localeCompare(y.team) || x.project.localeCompare(y.project));
    return { today, you: user.username, total: rows.length, ...(rows.length > MY_TASKS_MAX ? { note: `Showing the first ${MY_TASKS_MAX}. Pick one project with project_id to see the rest.` } : {}),
      tasks: rows.slice(0, MY_TASKS_MAX), projects };
  }

  /* ---------- the tools ---------- */
  const obj =(props, required = []) => ({ type: 'object', properties: props, required, additionalProperties: false });
  const S = d => ({ type: 'string', description: d });
  const N = d => ({ type: 'number', description: d });
  const B = d => ({ type: 'boolean', description: d });
  const PID = S('From list_projects.');
  const COLOR = S('A colour: #ff2a4f or a name like red, green, cyan, yellow, orange, purple, pink, bone, grey or ink.');
  const POINT = { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'], additionalProperties: false };
  const ENDREF = { anyOf: [{ type: 'string', description: 'An object id, or a card\'s exact title.' }, POINT] };
  const cardProps = {
    title: S('Short card title.'), kind: { type: 'string', enum: KINDS, description: 'task (default), milestone, bug or idea.' },
    status: { type: 'string', enum: ['todo', 'doing', 'blocked', 'done'] }, priority: { type: 'string', enum: ['must', 'should', 'could', 'wont', ''], description: 'MoSCoW priority.' },
    discipline: { type: 'string', enum: [...Object.keys(DISC_COLOR), ''], description: 'code, art, design, level, audio, ui, vfx, narr (narrative), qa, tech (tech/build) or mkt (marketing).' },
    estimate: S('Work estimate like 4h, 2d or 1w (working days).'), due: S('Due date, YYYY-MM-DD.'), starts: S('Start no earlier than this day, YYYY-MM-DD: the schedule waits for it. An empty string clears it.'), notes: S('Card body. Lines starting with "[ ] " become a checklist ("[x] " is ticked).'),
    severity: { type: 'string', enum: ['crash', 'major', 'minor', 'polish'], description: 'Bugs only.' },
    assignees: { type: 'array', items: { type: 'string' }, maxItems: 8, description: 'Usernames (or names) of teammates; get_team lists them. An empty list unassigns.' },
    color: COLOR, hide_from_roadmap: B('Keep this card off the project\'s public roadmap.'),
    tags: { type: 'array', items: { type: 'string' }, maxItems: 8, description: 'Tags like "ui" or "boss-fight" (1-24 letters, digits, - or _). An empty list removes them.' },
    tracked_minutes: N('Time tracked on the card, in minutes (the app\'s timer adds to it).'),
    git_links: { type: 'array', items: { type: 'string' }, maxItems: 10, description: 'Linked pull requests, merge requests or issues: https addresses on github.com or gitlab.com.' },
  };
  // what a reference picture or video can carry
  const refProps = { tags: { type: 'array', items: { type: 'string' }, maxItems: 8, description: 'Tags like "lighting" or "boss-fight" (1-24 letters, digits, - or _). An empty list removes them.' },
    note: S('A short note about the reference, up to 500 characters.'), source: S('Where it came from: a plain http or https web address, shown as a link people click (never fetched). An empty string clears it.') };
  const MOOD = 'true makes it a mood board collection for reference pictures instead of a project phase (kept out of the schedule)';
  const linkProps = { style: { type: 'string', enum: ['curved', 'straight', 'elbow', 'circuit'], description: 'curved (the default tendril), straight, elbow (right angles) or circuit (straight runs with 45° bends, like Electric Nodes in Unreal).' },
    via: { type: 'array', items: POINT, maxItems: 24, description: 'Reroute points the wire runs through, in order, to route it tidily. An empty list removes them.' }, arrowheads: { type: 'string', enum: ['end', 'both', 'none'] }, dashed: B('Dashed line.'),
    flow: B('Animated flow along the line.'), label: S('Short label on the line.'), color: COLOR, width: N('Line width, 1 to 12 (default 2.5).') };
  const geo = { x: N('Left edge on the board (x grows to the right).'), y: N('Top edge on the board (y grows downward).') };
  const TOOLS = [
    /* reading */
    { name: 'list_projects', title: 'List projects', description: 'Lists the teams you are in, your role in each, and their projects (ids, names, last edited, and your role and whether you can edit in each, since a team admin can give you a different role in one project). Start here to find a project_id.',
      inputSchema: obj({}), annotations: { readOnlyHint: true },
      run: user => {
        const teams = q.teams.all(user.id).map(t => ({ team_id: t.id, team: t.name, your_role: t.role, can_edit: RANK[t.role] >= RANK.editor,
          projects: q.projects.all(t.id).map(p => {
            // a team admin may have given you a different role in one project
            const role = projectRole ? projectRole({ id: p.id, team_id: t.id }, user.id) : t.role;
            return { project_id: p.id, name: p.name, last_edited: new Date(p.updated_at).toISOString(), your_role: role, can_edit: RANK[role] >= RANK.editor };
          }) }));
        return teams.length ? { teams } : { teams, note: 'You are not in a team yet, and tools work on team boards. Create a team in the Venom Board app (the Team panel) or accept an invite, then call list_projects again.' };
      } },
    { name: 'get_board', title: 'Read a board (planning)', description: 'Reads a project board for planning: phases (frames, not mood board collections) in order with the cards inside each, cards outside any phase, and progress: percent done, what is ready to start, overdue cards and milestones. Cards list kind, status, priority, discipline, estimate, due date, notes, assignees and the ids of cards they wait on. Use get_items for positions, sizes and every other kind of object.',
      inputSchema: obj({ project_id: PID }, ['project_id']), annotations: { readOnlyHint: true },
      run: (user, a) => { const { p, role, doc } = project(user, a.project_id, 'viewer'); return { project_id: p.id, name: p.name, your_role: role, ...describe(doc, members(p.team_id), p.id) }; } },
    { name: 'get_items', title: 'Read every object (layout)', description: 'Lists the objects on a board with their positions and sizes: cards, text, frames, pictures, GIFs, videos, jam clocks, connectors and ink strokes, plus the area the board covers. Filter by type, by ids or by an area. Board units: x grows right, y grows down; a card is about 240×100. A frame with mood: true is a mood board collection; pictures and videos show their tags, note and the address they came from (source, or source_link on a video, whose source is where it plays from).',
      inputSchema: obj({ project_id: PID, types: { type: 'array', items: { type: 'string', enum: ['card', 'text', 'frame', 'image', 'video', 'jam', 'connector', 'stroke'] } },
        ids: { type: 'array', items: { type: 'string' }, maxItems: 500 }, area: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } }, required: ['x', 'y', 'w', 'h'], additionalProperties: false, description: 'Only objects that overlap this area.' },
        include_points: B('Include every ink stroke\'s points (big).'), limit: N('Up to this many objects (default 500, at most 2000).') }, ['project_id']), annotations: { readOnlyHint: true },
      run: (user, a) => {
        const { p, doc } = project(user, a.project_id, 'viewer'), name = nameOf(members(p.team_id)), max = clamp(Math.round(Number(a.limit) || 500), 1, 2000);
        const want = Array.isArray(a.types) && a.types.length ? new Set(a.types) : null, ids = Array.isArray(a.ids) && a.ids.length ? new Set(a.ids) : null;
        const ar = a.area && fin(a.area.x) && fin(a.area.y) && fin(a.area.w) && fin(a.area.h) ? a.area : null;
        const hit = b => !ar || (b.x < ar.x + ar.w && b.x + b.w > ar.x && b.y < ar.y + ar.h && b.y + b.h > ar.y);
        const ok = (type, id, b) => (!want || want.has(type)) && (!ids || ids.has(id)) && hit(b);
        const ref = refsFor(p.id, doc), items = doc.items.filter(i => ok(i.type === 'node' ? 'card' : i.type, i.id, outer(i))).map(i => itemOut(i, name, ref));
        const links = doc.links.filter(l => (!want || want.has('connector')) && (!ids || ids.has(l.id)) && !ar).map(linkOut);
        const strokes = doc.strokes.filter(s => ok('stroke', s.id, strokeBox(s))).map(s => { const b = strokeBox(s); return { id: s.id, kind: s.kind === 'hl' ? 'highlighter' : 'pen', color: s.color, size: s.size, x: rd(b.x), y: rd(b.y), w: rd(b.w), h: rd(b.h), points: a.include_points ? s.pts : s.pts.length / 2 }; });
        const all = [...items, ...links, ...strokes], b = contentBox(doc);
        return { project_id: p.id, board_area: b ? { x: rd(b.x), y: rd(b.y), w: rd(b.w), h: rd(b.h) } : null, total: all.length, ...(all.length > max ? { note: `Showing the first ${max}. Narrow it with types, ids or area.` } : {}),
          items: items.slice(0, max), connectors: links.slice(0, Math.max(0, max - items.length)), strokes: strokes.slice(0, Math.max(0, max - items.length - links.length)) };
      } },
    { name: 'get_schedule', title: 'Schedule and critical path', description: 'Schedules every unfinished task in working days from today, from its estimate and what it waits on, like the app\'s Timeline: the finish date, the critical path (the chain that decides it), slack per task and tasks that will miss their due date.',
      inputSchema: obj({ project_id: PID }, ['project_id']), annotations: { readOnlyHint: true },
      run: (user, a) => { const { p, doc } = project(user, a.project_id, 'viewer'); return { project_id: p.id, name: p.name, ...schedule(doc) }; } },
    { name: 'trace_card', title: 'Trace a card\'s dependencies', description: 'Like Trace in the app: everything a card waits on (all the way back) and everything that waits on it (all the way forward), with status, so you can see what blocks it and what it unblocks.',
      inputSchema: obj({ project_id: PID, card_id: S('Card id or exact title.') }, ['project_id', 'card_id']), annotations: { readOnlyHint: true },
      run: (user, a) => {
        const { doc } = project(user, a.project_id, 'viewer'), id = resolveCard(doc, a.card_id), byId = new Map(doc.items.filter(i => i.type === 'node').map(c => [c.id, c]));
        const walk = (start, dir) => { const seen = new Set(), out = [], todo = [start]; while (todo.length) { const cur = todo.shift(); for (const l of doc.links) { const [f, t] = dir === 'up' ? [l.to.id, l.from.id] : [l.from.id, l.to.id]; if (f === cur && t && byId.has(t) && !seen.has(t) && t !== start) { seen.add(t); out.push(t); todo.push(t); } } } return out; };
        const row = i => { const c = byId.get(i); return { id: i, title: c.title, kind: c.kind || 'task', status: c.status }; };
        const up = walk(id, 'up').map(row), down = walk(id, 'down').map(row);
        return { card: row(id), waits_on: up, unfinished_before_it: up.filter(r => r.status !== 'done').length, waiting_on_it: down };
      } },
    { name: 'get_comments', title: 'Read comments', description: 'Reads the comments on a card or picture (or the latest on the whole board): who wrote them and when, replies, reactions, resolved threads and feedback pins on pictures.',
      inputSchema: obj({ project_id: PID, card_id: S('Optional: a card id or exact title, or a picture id. Leave out for the latest comments on the board.') }, ['project_id']), annotations: { readOnlyHint: true },
      run: (user, a) => {
        const { p, doc } = project(user, a.project_id, 'viewer'), name = nameOf(members(p.team_id)), card = a.card_id ? commentTarget(doc, a.card_id) : null;
        const titles = new Map(doc.items.filter(i => i.type === 'node' || i.type === 'image').map(c => [c.id, c.title || c.name || 'Picture']));
        return { comments: doc.comments.filter(c => !card || c.card === card).sort((x, y) => x.at - y.at).slice(-200).map(c => ({ id: c.id, card: titles.get(c.card) || c.card, card_id: c.card, by: name(c.by), at: new Date(c.at).toISOString(), text: c.text,
          ...(c.edited ? { edited: true } : {}), ...(c.re ? { reply_to: c.re } : {}), ...(c.pin ? { pin: c.pin } : {}),
          ...(c.react ? { reactions: Object.fromEntries(Object.entries(c.react).map(([e, ids]) => [e, ids.map(name)])) } : {}),
          ...(c.resolved ? { resolved: new Date(c.resolved).toISOString(), resolved_by: name(c.resolvedBy) } : {}) })) };
      } },
    { name: 'get_activity', title: 'Recent activity', description: 'The project\'s activity feed: who added, finished, deleted or commented on what, newest first.',
      inputSchema: obj({ project_id: PID }, ['project_id']), annotations: { readOnlyHint: true },
      run: async (user, a) => {
        const { p } = project(user, a.project_id, 'viewer'), r = await callRoute('GET', `/api/projects/${p.id}/activity`, user);
        const said = e => ({ created: `added “${e.text}”`, done: `finished “${e.text}”`, milestone: `reached “${e.text}”`, deleted: `deleted “${e.text}”`, restore: `restored the version from ${e.text}`, version: `saved a version: “${e.text}”`,
          comment: e.count > 1 ? `left ${e.count} comments` : `commented on “${e.text}”` }[e.kind] || e.text);
        return { activity: r.items.slice(0, 100).map(e => ({ who: e.name, what: said(e), at: new Date(e.at).toISOString(), ...(e.cardId ? { card_id: e.cardId } : {}) })) };
      } },
    { name: 'search', title: 'Search', description: 'Searches card titles and notes, phase names and text on every team board you can open, like Search everything in the app.',
      inputSchema: obj({ query: S('Words to find.') }, ['query']), annotations: { readOnlyHint: true },
      run: async (user, a) => ({ results: (await callRoute('GET', '/api/search', user, undefined, '?q=' + encodeURIComponent(str(a.query, 200)))).results.slice(0, 50).map(r => ({ project_id: r.projectId, project: r.project, team: r.team, id: r.cardId, title: r.title, snippet: r.snippet })) }) },
    { name: 'get_team', title: 'Team members', description: 'The people in a project\'s team with their usernames and roles, for assigning cards and @mentions.',
      inputSchema: obj({ project_id: PID }, ['project_id']), annotations: { readOnlyHint: true },
      run: (user, a) => { const { p } = project(user, a.project_id, 'viewer'); return { members: members(p.team_id).map(m => ({ username: m.username, name: m.name, role: m.role, ...(m.id === user.id ? { you: true } : {}) })) }; } },
    { name: 'list_templates', title: 'List templates', description: 'The app\'s ready-made boards (game roadmap, sprint board, bug triage, game jam and more) for create_project or apply_template.',
      inputSchema: obj({}), annotations: { readOnlyHint: true },
      run: () => ({ templates: templates().list }) },
    { name: 'list_versions', title: 'List versions', description: 'The project\'s version history: automatic versions kept before bursts of editing and versions people named, newest first.',
      inputSchema: obj({ project_id: PID }, ['project_id']), annotations: { readOnlyHint: true },
      run: async (user, a) => { const { p } = project(user, a.project_id, 'viewer'); const r = await callRoute('GET', `/api/projects/${p.id}/versions`, user); return { versions: r.items.slice(0, 100).map(v => ({ version_id: v.id, at: new Date(v.createdAt).toISOString(), label: v.label || null, automatic: v.auto, by: v.byName || null })) }; } },
    { name: 'view_image', title: 'Look at a picture', description: 'Returns a picture from the board so you can see it (references, concept art, screenshots). Up to 4 MB.',
      inputSchema: obj({ project_id: PID, image_id: S('A picture\'s id, from get_items.') }, ['project_id', 'image_id']), annotations: { readOnlyHint: true },
      run: (user, a) => {
        const { p, doc } = project(user, a.project_id, 'viewer'), it = doc.items.find(i => i.id === a.image_id && i.type === 'image') || oops(`No picture "${a.image_id}" on this board.`);
        const asset = it.src ? assetInfo(it.src.split('/').pop()) : null, home = asset ? q.project.get(asset.project_id) : null;
        if (!asset || !home || home.team_id !== p.team_id) oops('That picture isn\'t stored here.');
        if (asset.size > 4 * 1048576) oops('That picture is over 4 MB, too big to send.');
        return { _content: [{ type: 'image', data: fs.readFileSync(assetPath(asset.id)).toString('base64'), mimeType: asset.mime }, { type: 'text', text: `${it.name || 'Picture'}, ${it.w}×${it.h} on the board.` }] };
      } },

    /* projects */
    { name: 'create_project', title: 'Create a project', description: 'Creates a new project board in one of your teams (you need to be an editor or above), empty or from a template (list_templates).',
      inputSchema: obj({ team_id: S('From list_projects.'), name: S('Project name, e.g. "Night Keep: vertical slice".'), template: S('Optional template key, e.g. roadmap, sprint, bugs, jam.') }, ['team_id', 'name']),
      run: async (user, a) => {
        const t = a.template ? templateDoc(a.template) : null;
        const r = await makeProject(user, str(a.team_id, 64), str(a.name, 80), t ? { items: t.items, links: t.links, strokes: t.strokes, comments: [] } : {});
        return { project_id: r.id, name: r.name, team_id: r.teamId, ...(t ? { template: t.name, objects: t.items.length + t.links.length } : {}), next: t ? 'Read it with get_board, then change it.' : 'Add phases with add_phase, then cards with add_cards.' };
      } },
    { name: 'rename_project', title: 'Rename a project', description: 'Renames a project.',
      inputSchema: obj({ project_id: PID, name: S('The new name.') }, ['project_id', 'name']),
      run: async (user, a) => { const { p } = project(user, a.project_id, 'editor'); await callRoute('PATCH', `/api/projects/${p.id}`, user, { name: str(a.name, 80) }); return { renamed: true, name: str(a.name, 80) }; } },
    { name: 'apply_template', title: 'Add a template to a board', description: 'Adds one of the app\'s templates (list_templates) to an existing board, in free space or at x, y.',
      inputSchema: obj({ project_id: PID, template: S('Template key, e.g. roadmap or moodboard.'), ...geo }, ['project_id', 'template']),
      run: (user, a) => {
        const { p, role, doc } = project(user, a.project_id, 'editor'), t = templateDoc(a.template);
        const b = union(t.items.map(outer)) || { x: 0, y: 0, w: 0, h: 0 }, at = placer(doc, a)(b.w, b.h), dx = at.x - b.x, dy = at.y - b.y;
        const ops = [...t.items.map(i => put('items', { ...i, x: rd(i.x + dx), y: rd(i.y + dy) })), ...t.links.map(l => put('links', l)), ...t.strokes.map(s => put('strokes', { ...s, pts: s.pts.map((v, k) => rd(v + (k % 2 ? dy : dx))) }))];
        apply(user, role, p.id, ops);
        return { template: t.name, added: t.items.length, connectors: t.links.length, area: { x: rd(at.x), y: rd(at.y), w: rd(b.w), h: rd(b.h) } };
      } },

    /* planning */
    { name: 'add_phase', title: 'Add a phase', description: 'Adds a phase (a frame that holds cards, like "Pre-production" or "Alpha") to the right of the existing phases. Cards added to it go inside it.',
      inputSchema: obj({ project_id: PID, title: S('Phase name, e.g. "02 · Prototype".'), color: COLOR }, ['project_id', 'title']),
      run: (user, a) => {
        const { p, role, doc } = project(user, a.project_id, 'editor'), frames = doc.items.filter(i => i.type === 'frame'), phases = frames.filter(f => !f.mood), row = phases.length ? phases : frames;
        // in line with the phases and to the right of every frame, so it never lands on a mood board collection
        const right = frames.length ? Math.max(...frames.map(f => f.x + f.w)) + 80 : 0, top = row.length ? Math.min(...row.map(f => f.y)) : 0;
        const fr = { id: newId(), type: 'frame', x: right, y: top, w: 600, h: 760, title: str(a.title, 200) || 'New phase', color: colorArg(a.color, PHASE_COLORS[phases.length % PHASE_COLORS.length]) };
        apply(user, role, p.id, [put('items', fr)]);
        return { phase_id: fr.id, title: fr.title };
      } },
    { name: 'add_cards', title: 'Add cards', description: 'Adds up to 100 cards: inside a phase if you give phase_id (the phase grows to fit), at x, y if you give them, otherwise in free space. Each card can wait on other cards: give their ids, or the titles of cards on the board or in this same call, and arrows are drawn so the Timeline knows the order.',
      inputSchema: obj({ project_id: PID, phase_id: S('Optional: the phase to put the cards in (from get_board or add_phase), or a mood board collection\'s id from get_items.'),
        cards: { type: 'array', minItems: 1, maxItems: 100, items: obj({ ...cardProps, ...geo, waits_on: { type: 'array', items: { type: 'string' }, description: 'Ids or titles of cards this one waits on.' } }, ['title']) } }, ['project_id', 'cards']),
      run: (user, a) => {
        const { p, role, doc } = project(user, a.project_id, 'editor');
        const list = Array.isArray(a.cards) ? a.cards.slice(0, 100) : oops('cards must be a list.');
        let slots, frameOp = null;
        if (a.phase_id) {
          const fr = doc.items.find(i => i.type === 'frame' && i.id === a.phase_id) || oops(`No phase "${a.phase_id}" on this board. get_board lists them.`);
          const r = slotsIn(fr, doc, list.length);
          slots = r.slots;
          if (r.height > fr.h) frameOp = put('items', { ...fr, h: r.height });
        } else { const next = placer(doc); slots = list.map(() => next(240, 130)); }
        const made = new Map(), ops = [], created = [];
        list.forEach((c, i) => {
          if (!c || typeof c !== 'object') oops('Each card needs at least a title.');
          const card = cardFrom(c, slots[i].x, slots[i].y, null, p.team_id);
          made.set(card.title.toLowerCase(), card.id); created.push({ id: card.id, title: card.title });
          ops.push(put('items', card));
        });
        list.forEach((c, i) => { for (const w of Array.isArray(c.waits_on) ? c.waits_on.slice(0, 20) : []) ops.push(put('links', linkFrom({}, { id: resolveCard(doc, w, made) }, { id: created[i].id }))); });
        if (frameOp) ops.unshift(frameOp);
        const r = apply(user, role, p.id, ops);
        return { added: created, links: ops.filter(o => o.k === 'links').length, applied: r.applied };
      } },
    { name: 'update_cards', title: 'Update cards', description: 'Changes cards: title, kind, status, priority, discipline, estimate, due date, notes, severity, assignees, colour, position or roadmap visibility. Only the fields you give change. Set status "done" when work is finished.',
      inputSchema: obj({ project_id: PID, updates: { type: 'array', minItems: 1, maxItems: 200, items: obj({ card_id: S('Card id (or its exact title).'), ...cardProps, ...geo, locked: B('Lock it in place.') }, ['card_id']) } }, ['project_id', 'updates']),
      run: (user, a) => {
        const { p, role, doc } = project(user, a.project_id, 'editor');
        const ops = (Array.isArray(a.updates) ? a.updates.slice(0, 200) : oops('updates must be a list.')).map(u => {
          const id = resolveCard(doc, u.card_id), old = doc.items.find(i => i.id === id);
          return put('items', cardFrom(u, old.x, old.y, old, p.team_id));
        });
        apply(user, role, p.id, ops);
        return { updated: ops.map(o => ({ id: o.obj.id, title: o.obj.title, status: o.obj.status })) };
      } },
    { name: 'link_cards', title: 'Link cards', description: 'Draws dependency arrows: each link means the "to" card waits on the "from" card. Use card ids or exact titles. add_connectors draws any other kind of line.',
      inputSchema: obj({ project_id: PID, links: { type: 'array', minItems: 1, maxItems: 200, items: obj({ from: S('The card that comes first.'), to: S('The card that waits on it.'), label: S('Optional short label.') }, ['from', 'to']) } }, ['project_id', 'links']),
      run: (user, a) => {
        const { p, role, doc } = project(user, a.project_id, 'editor');
        const ops = (Array.isArray(a.links) ? a.links.slice(0, 200) : oops('links must be a list.')).map(l => put('links', linkFrom({ label: l.label }, { id: resolveCard(doc, l.from) }, { id: resolveCard(doc, l.to) })));
        apply(user, role, p.id, ops);
        return { linked: ops.length };
      } },

    /* laying out the board */
    { name: 'add_text', title: 'Add text', description: 'Adds text labels: titles, headings, notes or callouts. Size is the font size in board units (the app\'s default is 32; 18 for small notes, 64+ for big titles).',
      inputSchema: obj({ project_id: PID, texts: { type: 'array', minItems: 1, maxItems: 100, items: obj({ text: S('The words, up to 4,000 characters. New lines are kept.'), size: N('Font size, 4 to 800.'), color: COLOR, ...geo }, ['text']) } }, ['project_id', 'texts']),
      run: (user, a) => {
        const { p, role, doc } = project(user, a.project_id, 'editor'), next = placer(doc);
        const made = a.texts.slice(0, 100).map(t => {
          const size = clamp(Number(t.size) || 32, 4, 800), text = String(t.text || '').slice(0, 4000) || oops('A text needs words.');
          const lines = text.split('\n'), w = Math.max(...lines.map(l => l.length)) * size * 0.55, h = lines.length * size * 1.25;
          const at = fin(t.x) && fin(t.y) ? { x: rd(t.x), y: rd(t.y) } : next(w, h);
          return { id: newId(), type: 'text', x: at.x, y: at.y, w: 10, h: 10, text, size, color: colorArg(t.color, BONE) };
        });
        apply(user, role, p.id, made.map(o => put('items', o)));
        return { added: made.map(o => ({ id: o.id, text: o.text.slice(0, 60), x: o.x, y: o.y })) };
      } },
    { name: 'add_frames', title: 'Add frames', description: 'Adds frames: titled areas that group things and carry them when moved (phases are frames; mood: true makes a mood board collection instead). Give x, y, w, h, or "around" a list of object ids to wrap them with some room.',
      inputSchema: obj({ project_id: PID, frames: { type: 'array', minItems: 1, maxItems: 50, items: obj({ title: S('Frame title.'), color: COLOR, ...geo, w: N('Width.'), h: N('Height.'),
        around: { type: 'array', items: { type: 'string' }, description: 'Ids of objects to wrap.' }, padding: N('Room around wrapped objects (default 40).'), mood: B(MOOD + '.') }, ['title']) } }, ['project_id', 'frames']),
      run: (user, a) => {
        const { p, role, doc } = project(user, a.project_id, 'editor'), next = placer(doc), count = doc.items.filter(i => i.type === 'frame').length;
        const made = a.frames.slice(0, 50).map((f, n) => {
          let box;
          if (Array.isArray(f.around) && f.around.length) {
            const objs = f.around.map(id => findObj(doc, id) || oops(`No object "${id}" on this board.`)).map(({ k, o }) => (k === 'strokes' ? strokeBox(o) : k === 'items' ? outer(o) : oops('Frames wrap cards, text, pictures, videos, frames and ink.')));
            const b = union(objs), pad = fin(f.padding) ? clamp(f.padding, 0, 400) : 40;
            box = { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 };
          } else {
            const w = fin(f.w) && f.w > 40 ? f.w : 600, h = fin(f.h) && f.h > 40 ? f.h : 400;
            box = { ...(fin(f.x) && fin(f.y) ? { x: f.x, y: f.y } : next(w, h + 40)), w, h };
            if (!(fin(f.x) && fin(f.y))) box.y += 40;  // room for the title above it
          }
          return { id: newId(), type: 'frame', x: rd(box.x), y: rd(box.y), w: rd(box.w), h: rd(box.h), title: str(f.title, 200), color: colorArg(f.color, PHASE_COLORS[(count + n) % PHASE_COLORS.length]), ...(f.mood === true ? { mood: true } : {}) };
        });
        apply(user, role, p.id, made.map(o => put('items', o)));
        return { added: made.map(o => ({ id: o.id, title: o.title, x: o.x, y: o.y, w: o.w, h: o.h, ...(o.mood ? { mood: true } : {}) })) };
      } },
    { name: 'get_upload_url', title: 'Upload a local file', description: 'For pictures or videos on the user\'s computer: returns a one-time address (valid 10 minutes) to send the file to with curl, then an upload_id for add_image or add_video. PNG, JPEG, GIF or WebP up to 15 MB; MP4 or WebM if this server takes video files.',
      inputSchema: obj({ project_id: PID }, ['project_id']),
      run: (user, a) => {
        const { p } = project(user, a.project_id, 'editor');
        if (!limit('mcp-ticket:' + user.id, 120, 3600000)) oops('That\'s a lot of uploads this hour. Try again later.');
        sweep();
        const ticket = crypto.randomBytes(24).toString('base64url'), url = `${cfg.PUBLIC_URL}/mcp/upload/${ticket}`;
        tickets.set(ticket, { user, projectId: p.id, exp: Date.now() + 600000 });
        return { upload_url: url, expires_in_seconds: 600, how: `Send the file's bytes in the body: curl -sS -X PUT --data-binary @"path/to/file.png" ${url}  (on Windows PowerShell write curl.exe). The answer has an upload_id.` };
      } },
    { name: 'add_image', title: 'Add pictures', description: 'Adds pictures or GIFs (GIFs animate on the board) from a web address, base64 data, or an upload_id from get_upload_url. They keep their shape; give width to size them (default: natural size up to 640 on the longest side).',
      inputSchema: obj({ project_id: PID, images: { type: 'array', minItems: 1, maxItems: 20, items: obj({ url: S('A public web address of a PNG, JPEG, GIF or WebP.'), data: S('Base64 picture data (small pictures only).'), upload_id: S('From get_upload_url.'),
        name: S('A name for it.'), width: N('Width on the board.'), height: N('Height (normally left out to keep its shape).'), flip: B('Mirror it.'), gray: B('Show it in greyscale.'), ...refProps, ...geo }) } }, ['project_id', 'images']),
      run: async (user, a) => {
        const { p, role, doc } = project(user, a.project_id, 'editor'), next = placer(doc), made = [];
        for (const m of a.images.slice(0, 20)) {
          const ref = refIn({}, m);  // checked before anything is downloaded
          const { asset, buf } = await mediaBytes(user, p, m);
          if (!asset.mime.startsWith('image/')) oops('That file is a video. Use add_video for it.');
          const size = sized(m, imageSize(buf), 640), at = fin(m.x) && fin(m.y) ? { x: rd(m.x), y: rd(m.y) } : next(size.w, size.h);
          made.push({ id: newId(), type: 'image', ...at, ...size, src: `${cfg.PUBLIC_URL}/assets/${asset.id}`, name: str(m.name || (m.url ? String(m.url).split('/').pop().split('?')[0] : '') || 'Picture', 200), flip: !!m.flip, gray: !!m.gray, ...ref });
        }
        apply(user, role, p.id, made.map(o => put('items', o)));
        return { added: made.map(o => ({ id: o.id, name: o.name, x: o.x, y: o.y, w: o.w, h: o.h })) };
      } },
    { name: 'add_video', title: 'Add videos', description: 'Adds videos: YouTube or Vimeo links (they play from there when someone clicks them), or video files (url or upload_id) if this server takes them. Default size 480 wide, 16:9.',
      inputSchema: obj({ project_id: PID, videos: { type: 'array', minItems: 1, maxItems: 20, items: obj({ url: S('A YouTube or Vimeo link, or a public address of an MP4 or WebM file.'), upload_id: S('From get_upload_url.'),
        name: S('A name for it.'), width: N('Width on the board (default 480).'), height: N('Height (default keeps 16:9).'), loop: B('Loop it (default true).'), autoplay: B('Play when shown (default false).'), ...refProps, ...geo }) } }, ['project_id', 'videos']),
      run: async (user, a) => {
        const { p, role, doc } = project(user, a.project_id, 'editor'), next = placer(doc), made = [];
        for (const v of a.videos.slice(0, 20)) {
          const embed = v.url && !v.upload_id ? parseVideoLink(v.url) : null, base = refIn({ name: str(v.name || v.url || 'Video', 200), loop: v.loop !== false, autoplay: !!v.autoplay }, v);
          let src = null;
          if (!embed) {
            if (!cfg.VIDEO_UPLOADS && !v.upload_id) oops('This server doesn\'t keep video files for team boards. Use a YouTube or Vimeo link instead.');
            const { asset } = await mediaBytes(user, p, v);
            if (!asset.mime.startsWith('video/')) oops('That file is a picture. Use add_image for it.');
            src = `${cfg.PUBLIC_URL}/assets/${asset.id}`;
          }
          const size = sized({ width: fin(v.width) ? v.width : 480, height: v.height }, null, 480), at = fin(v.x) && fin(v.y) ? { x: rd(v.x), y: rd(v.y) } : next(size.w, size.h);
          made.push({ id: newId(), type: 'video', ...at, ...size, ...base, ...(embed ? { embed } : { src }) });
        }
        apply(user, role, p.id, made.map(o => put('items', o)));
        return { added: made.map(o => ({ id: o.id, name: o.name, x: o.x, y: o.y, w: o.w, h: o.h, ...(o.embed ? { plays_from: o.embed.p === 'yt' ? 'YouTube' : 'Vimeo' } : {}) })) };
      } },
    { name: 'replace_media', title: 'Replace a picture or video', description: 'Swaps what a picture or video shows for another one, like Replace in the app: a picture (web address, base64 data or upload_id), a YouTube or Vimeo link, or a video file. It keeps its place, width, connectors, settings (flip, greyscale, loop), tags, note and source, and takes the new shape. A picture can become a video and back.',
      inputSchema: obj({ project_id: PID, id: S('The picture or video to replace, from get_items.'), url: S('A picture\'s web address, a YouTube or Vimeo link, or a video file\'s address.'), data: S('Base64 picture data (small pictures only).'),
        upload_id: S('From get_upload_url.'), name: S('A new name (default: from the source).'), keep_size: B('Keep its exact width and height instead of taking the new shape.') }, ['project_id', 'id']),
      run: async (user, a) => {
        const { p, role, doc } = project(user, a.project_id, 'editor'), i = doc.items.findIndex(o => o.id === a.id), it = doc.items[i];
        if (!it || (it.type !== 'image' && it.type !== 'video')) oops(`No picture or video "${a.id}" on this board. get_items lists them with types image and video.`);
        let ref, video, natural = null;
        const embed = a.url && !a.upload_id && !a.data ? parseVideoLink(a.url) : null;
        if (embed) { ref = { embed }; video = true; natural = { w: 16, h: 9 }; }
        else {
          if (a.url && !a.upload_id && !a.data && /\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(a.url) && !cfg.VIDEO_UPLOADS) oops('This server doesn\'t keep video files for team boards. Use a YouTube or Vimeo link instead.');
          const { asset, buf } = await mediaBytes(user, p, a);
          video = asset.mime.startsWith('video/');
          ref = { src: `${cfg.PUBLIC_URL}/assets/${asset.id}` };
          natural = video ? { w: 16, h: 9 } : imageSize(buf);
        }
        const type = video ? 'video' : 'image', turn = type === 'image' && it.type === 'image' && it.rot ? it.rot : 0, side = turn === 90 || turn === 270;
        const ar = natural && natural.w > 0 && natural.h > 0 ? natural.h / natural.w : 9 / 16, w = it.w, h = a.keep_size ? it.h : rd(w * (side ? 1 / ar : ar));  // a turned picture keeps its turn
        // the same kind keeps its id; a new kind gets a new one (with its connectors and place in the stack), so every copy of the app draws it right
        const next = { id: type === it.type ? it.id : newId(), type, x: it.x, y: rd(it.y + it.h / 2 - h / 2), w, h, ...ref,
          name: str(a.name || (embed ? a.url : a.url ? String(a.url).split('/').pop().split('?')[0] : '') || it.name || (video ? 'Video' : 'Picture'), 200) };
        if (it.locked) next.locked = true;
        for (const k of ['tags', 'note', 'source']) if (it[k] !== undefined) next[k] = it[k];  // what the team wrote about the reference stays with it
        if (type === 'image') Object.assign(next, { flip: it.type === 'image' && !!it.flip, gray: it.type === 'image' && !!it.gray }, turn ? { rot: turn } : {});
        else Object.assign(next, { loop: it.type === 'video' ? it.loop !== false : true, autoplay: it.type === 'video' && !!it.autoplay });
        const ops = [put('items', next)];
        if (next.id !== it.id) {
          ops.push({ k: 'items', op: 'del', id: it.id });
          for (const l of doc.links) if (l.from.id === it.id || l.to.id === it.id) ops.push(put('links', { ...l, from: l.from.id === it.id ? { id: next.id } : l.from, to: l.to.id === it.id ? { id: next.id } : l.to }));
          ops.push({ k: 'items', op: 'order', ids: doc.items.map(o => (o.id === it.id ? next.id : o.id)) });
        }
        apply(user, role, p.id, ops);
        return { id: next.id, type, name: next.name, x: next.x, y: next.y, w: next.w, h: next.h, ...(next.id !== it.id ? { note: `It became a ${type}, so it has a new id.` } : {}), ...(embed ? { plays_from: embed.p === 'yt' ? 'YouTube' : 'Vimeo' } : {}) };
      } },
    { name: 'add_drawing', title: 'Draw with the marker or highlighter', description: 'Draws ink on the board like the marker and highlighter: freehand lines through points, or shapes (line, arrow, rectangle, ellipse) drawn as ink. Ink drawn over a card or picture moves with it. Size is the line thickness (marker 3-6, highlighter 16-30).',
      inputSchema: obj({ project_id: PID, strokes: { type: 'array', minItems: 1, maxItems: 100, items: obj({ tool: { type: 'string', enum: ['marker', 'highlighter'], description: 'Default marker.' },
        shape: { type: 'string', enum: ['freehand', 'line', 'arrow', 'rectangle', 'ellipse'], description: 'Default freehand (through points).' },
        points: { type: 'array', items: POINT, maxItems: 5000, description: 'For freehand: the points the line goes through, in order. For line and arrow: start and end.' },
        x: N('For rectangle and ellipse: left.'), y: N('For rectangle and ellipse: top.'), w: N('Width.'), h: N('Height.'), color: COLOR, size: N('Thickness.') }) } }, ['project_id', 'strokes']),
      run: (user, a) => {
        const { p, role, doc } = project(user, a.project_id, 'editor'), made = [];
        for (const s of a.strokes.slice(0, 100)) {
          const hl = s.tool === 'highlighter', base = { type: 'stroke', kind: hl ? 'hl' : 'pen', color: colorArg(s.color, hl ? '#ffd23d' : '#ff2a4f'), size: clamp(Number(s.size) || (hl ? 20 : 4), 0.5, 200) };
          const pts = (Array.isArray(s.points) ? s.points : []).filter(q2 => q2 && fin(q2.x) && fin(q2.y)).map(q2 => [rd(q2.x), rd(q2.y)]);
          const shape = s.shape || 'freehand', flat = list => list.flat();
          if (shape === 'rectangle' || shape === 'ellipse') {
            if (![s.x, s.y, s.w, s.h].every(fin)) oops(`A ${shape} needs x, y, w and h.`);
            const loop = shape === 'rectangle' ? [[s.x, s.y], [s.x + s.w, s.y], [s.x + s.w, s.y + s.h], [s.x, s.y + s.h], [s.x, s.y]]
              : Array.from({ length: 49 }, (_, k) => [s.x + s.w / 2 + Math.cos(k / 48 * Math.PI * 2) * s.w / 2, s.y + s.h / 2 + Math.sin(k / 48 * Math.PI * 2) * s.h / 2]);
            made.push({ ...base, id: newId(), pts: flat(loop.map(([x, y]) => [rd(x), rd(y)])) });
          } else {
            if (pts.length < 2) oops(`A ${shape} needs at least two points.`);
            const line = shape === 'freehand' ? pts : [pts[0], pts[pts.length - 1]];
            made.push({ ...base, id: newId(), pts: flat(line) });
            if (shape === 'arrow') {  // two short strokes for the head, like the app's own drawn arrows
              const [[x0, y0], [x1, y1]] = line, ang = Math.atan2(y1 - y0, x1 - x0), len = clamp(Math.hypot(x1 - x0, y1 - y0) * 0.2, base.size * 3, 60);
              for (const t of [-0.5, 0.5]) made.push({ ...base, id: newId(), pts: [rd(x1 - Math.cos(ang + t) * len), rd(y1 - Math.sin(ang + t) * len), x1, y1] });
            }
          }
        }
        apply(user, role, p.id, made.map(o => put('strokes', o)));
        return { drawn: made.length, ids: made.map(o => o.id) };
      } },
    { name: 'add_connectors', title: 'Add connectors', description: 'Draws connector lines between objects (cards, pictures, text, frames…) or free points, with a style (curved, straight, elbow, or circuit: straight runs with 45° bends), reroute points to route them tidily, arrowheads, dashes, an animated flow and a label. Between cards, an arrow means "waits on" for the schedule.',
      inputSchema: obj({ project_id: PID, connectors: { type: 'array', minItems: 1, maxItems: 200, items: obj({ from: ENDREF, to: ENDREF, ...linkProps }, ['from', 'to']) } }, ['project_id', 'connectors']),
      run: (user, a) => {
        const { p, role, doc } = project(user, a.project_id, 'editor');
        const made = a.connectors.slice(0, 200).map(c => linkFrom(c, end(doc, c.from), end(doc, c.to)));
        apply(user, role, p.id, made.map(o => put('links', o)));
        return { added: made.map(o => o.id) };
      } },
    { name: 'add_jam_clock', title: 'Add a game jam clock', description: 'Adds the game jam clock: a countdown to the deadline (shown in the top bar too), the theme or when it\'s revealed, and a scope check of the work left against the time.',
      inputSchema: obj({ project_id: PID, deadline: S('Submission deadline, e.g. 2026-11-22T18:00:00Z.'), title: S('Jam name (default "Game jam").'), theme: S('The theme, if known.'),
        theme_revealed_at: S('When the theme is revealed, if later.'), people: N('People on the team (1-50).'), color: COLOR, ...geo }, ['project_id', 'deadline']),
      run: (user, a) => {
        const { p, role, doc } = project(user, a.project_id, 'editor'), at = fin(a.x) && fin(a.y) ? { x: rd(a.x), y: rd(a.y) } : placer(doc)(360, 220);
        const j = { id: newId(), type: 'jam', ...at, w: 360, h: 220, title: str(a.title, 80) || 'Game jam', theme: str(a.theme, 120), end: when(a.deadline, 'deadline'), people: clamp(Math.round(Number(a.people) || 1), 1, 50), color: colorArg(a.color, '#ff2a4f') };
        if (a.theme_revealed_at) j.reveal = when(a.theme_revealed_at, 'reveal time');
        apply(user, role, p.id, [put('items', j)]);
        return { jam_clock_id: j.id, deadline: new Date(j.end).toISOString() };
      } },

    /* changing anything */
    { name: 'update_items', title: 'Change objects', description: 'Changes any objects by id: position, size, lock, and what each kind has: text (text, size, color), frames (title, color, collapsed, sprint, mood), pictures (name, flip, gray, crop, rotate, tags, note, source), videos (name, loop, autoplay, tags, note, source), jam clocks (title, theme, deadline, people, color), cards (same fields as update_cards). Only the fields you give change.',
      inputSchema: obj({ project_id: PID, updates: { type: 'array', minItems: 1, maxItems: 300, items: { type: 'object', properties: { id: S('Object id.'), ...geo, w: N('Width.'), h: N('Height.'), locked: B('Lock it in place.'),
        text: S('Text: the words.'), size: N('Text: font size.'), color: COLOR, title: S('Frame, card or jam clock title.'), name: S('Picture or video name.'), flip: B('Picture: mirrored.'), gray: B('Picture: greyscale.'),
        crop: { anyOf: [{ type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } }, required: ['x', 'y', 'w', 'h'], additionalProperties: false }, { type: 'null' }], description: 'Picture: the part to show, as fractions of the whole picture (x, y from its top left; w, h > 0.01). null shows it all.' },
        rotate: { type: 'number', enum: [0, 90, 180, 270], description: 'Picture: turned clockwise by this many degrees.' },
        collapsed: B('Phase: folded down to its title bar, hiding what\'s inside.'),
        sprint: { anyOf: [{ type: 'object', properties: { start: { type: 'string' }, end: { type: 'string' }, capacity_days: { type: 'object', additionalProperties: { type: 'number' } } }, required: ['start', 'end'], additionalProperties: false }, { type: 'null' }],
          description: 'Phase: make it a sprint from start to end (YYYY-MM-DD), with optional capacity in days per teammate username (or "everyone"). null turns it back into a plain phase.' },
        mood: B(`Frame: ${MOOD}; false makes it a phase again.`),
        tags: { ...refProps.tags, description: 'Picture, video or card: tags like "lighting" or "boss-fight" (1-24 letters, digits, - or _). An empty list removes them.' },
        note: S('Picture or video: a short note about the reference, up to 500 characters.'), source: S('Picture or video: where it came from, a plain http or https web address shown as a link people click (never fetched). An empty string clears it.'),
        loop: B('Video: loop.'), autoplay: B('Video: play when shown.'), theme: S('Jam clock: theme.'), deadline: S('Jam clock: deadline.'), people: N('Jam clock: people.') }, required: ['id'], additionalProperties: true } } }, ['project_id', 'updates']),
      run: (user, a) => {
        const { p, role, doc } = project(user, a.project_id, 'editor');
        const ops = a.updates.slice(0, 300).map(u => {
          const old = doc.items.find(i => i.id === u.id) || (doc.links.some(l => l.id === u.id) ? oops(`"${u.id}" is a connector: use update_connectors.`) : oops(`No object "${u.id}" on this board.`));
          if (old.type === 'node') return put('items', cardFrom(u, old.x, old.y, old, p.team_id));
          const o = { ...old };
          for (const k of ['x', 'y']) if (fin(u[k])) o[k] = rd(u[k]);
          for (const k of ['w', 'h']) if (fin(u[k]) && u[k] > 0) o[k] = rd(u[k]);
          if (u.locked !== undefined) { if (u.locked) o.locked = true; else delete o.locked; }
          if (u.color !== undefined && ['text', 'frame', 'jam'].includes(o.type)) o.color = colorArg(u.color, o.color);
          if (o.type === 'text') { if (u.text !== undefined) o.text = String(u.text).slice(0, 4000); if (fin(u.size)) o.size = clamp(u.size, 4, 800); }
          if (o.type === 'frame') {
            if (u.title !== undefined) o.title = str(u.title, 200);
            if (u.collapsed !== undefined) { if (u.collapsed) o.collapsed = true; else delete o.collapsed; }
            if (u.sprint !== undefined) o.sprint = sprintIn(u.sprint, p.team_id);
            if (!o.sprint) delete o.sprint;
            if (u.mood !== undefined) o.mood = !!u.mood;  // false, not left out, or the live path would keep it a collection
          }
          if (o.type === 'image') {
            if (u.name !== undefined) o.name = str(u.name, 200); if (u.flip !== undefined) o.flip = !!u.flip; if (u.gray !== undefined) o.gray = !!u.gray;
            if (u.crop !== undefined || u.rotate !== undefined) turnAndCrop(o, u);
          }
          if (o.type === 'video') { if (u.name !== undefined) o.name = str(u.name, 200); if (u.loop !== undefined) o.loop = !!u.loop; if (u.autoplay !== undefined) o.autoplay = !!u.autoplay; }
          if (o.type === 'image' || o.type === 'video') refIn(o, u);
          if (o.type === 'jam') { if (u.title !== undefined) o.title = str(u.title, 80); if (u.theme !== undefined) o.theme = str(u.theme, 120); if (u.deadline !== undefined) o.end = when(u.deadline, 'deadline'); if (fin(u.people)) o.people = clamp(Math.round(u.people), 1, 50); }
          return put('items', o);
        });
        apply(user, role, p.id, ops);
        return { updated: ops.length };
      } },
    { name: 'update_connectors', title: 'Change connectors', description: 'Changes connector lines by id: style (curved, straight, elbow or circuit), reroute points, arrowheads, dashes, flow, label, colour, width, or what they join.',
      inputSchema: obj({ project_id: PID, updates: { type: 'array', minItems: 1, maxItems: 200, items: obj({ id: S('Connector id.'), from: ENDREF, to: ENDREF, ...linkProps }, ['id']) } }, ['project_id', 'updates']),
      run: (user, a) => {
        const { p, role, doc } = project(user, a.project_id, 'editor');
        const ops = a.updates.slice(0, 200).map(u => {
          const old = doc.links.find(l => l.id === u.id) || oops(`No connector "${u.id}" on this board.`);
          const l = linkFrom(u, old.from, old.to, old);
          if (u.from !== undefined) l.from = end(doc, u.from);
          if (u.to !== undefined) l.to = end(doc, u.to);
          return put('links', l);
        });
        apply(user, role, p.id, ops);
        return { updated: ops.length };
      } },
    { name: 'move_items', title: 'Move objects', description: 'Moves objects by dx, dy. Moving a frame carries what\'s inside it, as in the app, and ink and connector ends go along.',
      inputSchema: obj({ project_id: PID, ids: { type: 'array', minItems: 1, maxItems: 500, items: { type: 'string' } }, dx: N('Right (negative: left).'), dy: N('Down (negative: up).') }, ['project_id', 'ids', 'dx', 'dy']),
      run: (user, a) => {
        const { p, role, doc } = project(user, a.project_id, 'editor'), dx = Number(a.dx) || 0, dy = Number(a.dy) || 0, ids = new Set(a.ids.slice(0, 500));
        for (const f of doc.items.filter(i => i.type === 'frame' && ids.has(i.id))) for (const i of doc.items) if (i.id !== f.id && i.type !== 'frame' && inside(i, f)) ids.add(i.id);
        const boxes = doc.items.filter(i => ids.has(i.id)).map(outer), inAny = pt => boxes.some(b => pt.x >= b.x && pt.x <= b.x + b.w && pt.y >= b.y && pt.y <= b.y + b.h);
        const ops = doc.items.filter(i => ids.has(i.id)).map(i => put('items', { ...i, x: rd(i.x + dx), y: rd(i.y + dy) }));
        for (const s of doc.strokes) { const b = strokeBox(s); if (ids.has(s.id) || inAny({ x: b.x + b.w / 2, y: b.y + b.h / 2 })) ops.push(put('strokes', { ...s, pts: s.pts.map((v, k) => rd(v + (k % 2 ? dy : dx))) })); }
        for (const l of doc.links) {
          const mv = e => (e.id === undefined && inAny(e) ? { x: rd(e.x + dx), y: rd(e.y + dy) } : e), f = mv(l.from), t = mv(l.to), knots = l.via && ids.has(l.from.id) && ids.has(l.to.id);
          if (f !== l.from || t !== l.to || knots) ops.push(put('links', { ...l, from: f, to: t, ...(knots ? { via: l.via.map(k => ({ x: rd(k.x + dx), y: rd(k.y + dy) })) } : {}) }));
        }
        if (!ops.length) oops('None of those ids are on this board.');
        apply(user, role, p.id, ops);
        return { moved: ops.length };
      } },
    { name: 'arrange_items', title: 'Align, distribute or pack', description: 'Arranges objects like the app\'s align, distribute and pack: align their edges or centres, spread them evenly, or pack them into a grid, row or column with a gap.',
      inputSchema: obj({ project_id: PID, ids: { type: 'array', minItems: 2, maxItems: 500, items: { type: 'string' } },
        mode: { type: 'string', enum: ['align_left', 'align_center', 'align_right', 'align_top', 'align_middle', 'align_bottom', 'distribute_horizontally', 'distribute_vertically', 'grid', 'row', 'column'] },
        gap: N('Space between objects for grid, row and column (default 40).'), columns: N('Columns for grid (default: about square).') }, ['project_id', 'ids', 'mode']),
      run: (user, a) => {
        const { p, role, doc } = project(user, a.project_id, 'editor'), list = a.ids.map(id => doc.items.find(i => i.id === id) || oops(`No object "${id}" on this board.`));
        const b = union(list.map(outer)), gap = fin(a.gap) ? clamp(a.gap, 0, 2000) : 40, pos = new Map(list.map(i => [i.id, { x: i.x, y: i.y }]));
        const W = i => Math.max(i.w || 0, 10), Hh = i => Math.max(i.h || 0, 10);
        switch (a.mode) {
          case 'align_left': list.forEach(i => (pos.get(i.id).x = b.x)); break;
          case 'align_center': list.forEach(i => (pos.get(i.id).x = b.x + b.w / 2 - W(i) / 2)); break;
          case 'align_right': list.forEach(i => (pos.get(i.id).x = b.x + b.w - W(i))); break;
          case 'align_top': list.forEach(i => (pos.get(i.id).y = b.y)); break;
          case 'align_middle': list.forEach(i => (pos.get(i.id).y = b.y + b.h / 2 - Hh(i) / 2)); break;
          case 'align_bottom': list.forEach(i => (pos.get(i.id).y = b.y + b.h - Hh(i))); break;
          case 'distribute_horizontally': case 'distribute_vertically': {
            const hz = a.mode === 'distribute_horizontally', s = [...list].sort((m, n) => (hz ? m.x - n.x : m.y - n.y)), total = s.reduce((t, i) => t + (hz ? W(i) : Hh(i)), 0), space = ((hz ? b.w : b.h) - total) / (s.length - 1);
            let at = hz ? b.x : b.y;
            for (const i of s) { pos.get(i.id)[hz ? 'x' : 'y'] = at; at += (hz ? W(i) : Hh(i)) + space; }
            break;
          }
          default: {
            const cols = a.mode === 'row' ? list.length : a.mode === 'column' ? 1 : clamp(Math.round(Number(a.columns) || Math.ceil(Math.sqrt(list.length))), 1, list.length);
            let x = b.x, y = b.y, rowH = 0;
            list.forEach((i, n) => { if (n && n % cols === 0) { x = b.x; y += rowH + gap; rowH = 0; } pos.set(i.id, { x, y }); x += W(i) + gap; rowH = Math.max(rowH, Hh(i)); });
          }
        }
        const ops = list.map(i => put('items', { ...i, x: rd(pos.get(i.id).x), y: rd(pos.get(i.id).y) }));
        apply(user, role, p.id, ops);
        return { arranged: ops.length };
      } },
    { name: 'reorder_items', title: 'Bring to front or send to back', description: 'Puts objects in front of or behind the others, like bring to front and send to back.',
      inputSchema: obj({ project_id: PID, ids: { type: 'array', minItems: 1, maxItems: 500, items: { type: 'string' } }, to: { type: 'string', enum: ['front', 'back'] } }, ['project_id', 'ids', 'to']),
      run: (user, a) => {
        const { p, role, doc } = project(user, a.project_id, 'editor'), ids = new Set(a.ids), moving = doc.items.filter(i => ids.has(i.id)).map(i => i.id), rest = doc.items.filter(i => !ids.has(i.id)).map(i => i.id);
        if (!moving.length) oops('None of those ids are on this board.');
        apply(user, role, p.id, [{ k: 'items', op: 'order', ids: a.to === 'back' ? [...moving, ...rest] : [...rest, ...moving] }]);
        return { reordered: moving.length };
      } },
    { name: 'duplicate_items', title: 'Duplicate objects', description: 'Copies objects (and the connectors and ink between them) next to the originals, or offset by dx, dy.',
      inputSchema: obj({ project_id: PID, ids: { type: 'array', minItems: 1, maxItems: 500, items: { type: 'string' } }, dx: N('Offset right (default: just right of the originals).'), dy: N('Offset down (default 0).') }, ['project_id', 'ids']),
      run: (user, a) => {
        const { p, role, doc } = project(user, a.project_id, 'editor'), ids = new Set(a.ids.slice(0, 500)), items = doc.items.filter(i => ids.has(i.id)), strokes = doc.strokes.filter(s => ids.has(s.id));
        if (!items.length && !strokes.length) oops('None of those ids are on this board.');
        const b = union([...items.map(outer), ...strokes.map(strokeBox)]), dx = fin(a.dx) ? a.dx : rd(b.w + 80), dy = fin(a.dy) ? a.dy : 0, map = new Map();
        const ops = items.map(i => { const c = { ...i, id: newId(), x: rd(i.x + dx), y: rd(i.y + dy) }; if (c.type === 'node') { c.createdAt = Date.now(); delete c.doneAt; } map.set(i.id, c.id); return put('items', c); });
        for (const s of strokes) ops.push(put('strokes', { ...s, id: newId(), pts: s.pts.map((v, k) => rd(v + (k % 2 ? dy : dx))) }));
        for (const l of doc.links) if (map.has(l.from.id) && map.has(l.to.id)) ops.push(put('links', { ...l, id: newId(), from: { id: map.get(l.from.id) }, to: { id: map.get(l.to.id) }, ...(l.via ? { via: l.via.map(k => ({ x: rd(k.x + dx), y: rd(k.y + dy) })) } : {}) }));
        apply(user, role, p.id, ops);
        return { copies: [...map.entries()].map(([from, id]) => ({ from, id })), offset: { dx, dy } };
      } },
    { name: 'delete_items', title: 'Delete objects', description: 'Deletes objects by id: cards, text, frames, pictures, videos, jam clocks, connectors, ink strokes or your comments. Deleting a frame leaves what was inside it. Connectors to deleted objects go too. The board before the change stays in version history.',
      inputSchema: obj({ project_id: PID, ids: { type: 'array', minItems: 1, maxItems: 500, items: { type: 'string' } } }, ['project_id', 'ids']), annotations: { destructiveHint: true },
      run: (user, a) => {
        const { p, role, doc } = project(user, a.project_id, 'viewer'), ids = new Set((Array.isArray(a.ids) ? a.ids : []).slice(0, 500).map(String));
        const ops = [];
        for (const i of doc.items) if (ids.has(i.id)) ops.push({ k: 'items', op: 'del', id: i.id });
        for (const l of doc.links) if (ids.has(l.id) || ids.has(l.from.id) || ids.has(l.to.id)) ops.push({ k: 'links', op: 'del', id: l.id });
        for (const s of doc.strokes) if (ids.has(s.id)) ops.push({ k: 'strokes', op: 'del', id: s.id });
        for (const c of doc.comments) if (ids.has(c.id)) ops.push({ k: 'comments', op: 'del', id: c.id });
        if (!ops.length) oops('None of those ids are on this board.');
        if (RANK[role] < RANK.editor && ops.some(o => o.k !== 'comments')) oops(`You're a ${role} in this project's team, so you can only delete your own comments.`);
        const r = apply(user, role, p.id, ops);
        return { deleted: r.applied, ...(r.applied < ops.length ? { note: 'Some comments weren\'t yours to delete.' } : {}) };
      } },
    { name: 'add_comment', title: 'Comment on a card or picture', description: 'Adds a comment to a card or picture, shown in its comment panel and the activity feed as written by you. Reply to a comment with reply_to, or drop a numbered feedback pin on a spot of a picture with pin. Mention teammates with @username to notify them.',
      inputSchema: obj({ project_id: PID, card_id: S('A card id or exact title, or a picture id.'), text: S('The comment, up to 2,000 characters.'), reply_to: S('Optional: the id of the comment this answers (from get_comments).'),
        pin: { ...POINT, description: 'Optional, pictures only: where the pin goes, as fractions of the picture (0..1 from its top left).' } }, ['project_id', 'card_id', 'text']),
      run: (user, a) => {
        const { p, role, doc } = project(user, a.project_id, 'viewer'), card = commentTarget(doc, a.card_id), text = str(a.text, 2000);
        if (!text) oops('The comment is empty.');
        const c = { id: newId(), type: 'comment', card, by: user.id, at: Date.now(), text };
        if (a.reply_to) { const parent = doc.comments.find(m => m.id === a.reply_to); if (!parent || parent.card !== card) oops(`No comment "${a.reply_to}" on that ${doc.items.find(i => i.id === card).type === 'image' ? 'picture' : 'card'}.`); c.re = parent.re || parent.id; }
        else if (a.pin) {
          if (doc.items.find(i => i.id === card).type !== 'image') oops('Feedback pins go on pictures.');
          if (!(fin(a.pin.x) && fin(a.pin.y) && a.pin.x >= 0 && a.pin.x <= 1 && a.pin.y >= 0 && a.pin.y <= 1)) oops('A pin is {"x": 0..1, "y": 0..1}, fractions of the picture.');
          c.pin = { x: a.pin.x, y: a.pin.y };
        }
        const r = apply(user, role, p.id, [put('comments', c)]);
        if (r.rate) oops("You're commenting very fast. Wait a moment and try again.");
        return { commented: true, comment_id: c.id, ...(c.re ? { reply_to: c.re } : {}) };
      } },
    { name: 'resolve_thread', title: 'Resolve a comment thread', description: 'Resolves (or reopens) a comment thread: the thread\'s first comment, from get_comments. Its author or a team admin can do this; resolved threads fold away in the app.',
      inputSchema: obj({ project_id: PID, comment_id: S('The first comment of the thread.'), resolved: B('true to resolve (the default), false to reopen.') }, ['project_id', 'comment_id']),
      run: (user, a) => {
        const { p, role, doc } = project(user, a.project_id, 'viewer'), c = doc.comments.find(m => m.id === a.comment_id) || oops(`No comment "${a.comment_id}" on this board.`);
        if (c.re) oops('That comment is a reply. Resolve the thread from its first comment.');
        const want = a.resolved !== false;
        if (!!c.resolved === want) return { resolved: want, changed: false };
        const r = apply(user, role, p.id, [put('comments', { ...c, ...(want ? { resolved: Date.now(), resolvedBy: user.id } : { resolved: 0, resolvedBy: '' }) })]);
        if (!r.applied) oops('Only the person who started the thread or a team admin can resolve or reopen it.');
        return { resolved: want, changed: true };
      } },

    /* version history */
    { name: 'save_version', title: 'Save a version', description: 'Saves the board as it is now as a named version in its history, e.g. before a big change.',
      inputSchema: obj({ project_id: PID, label: S('A name, e.g. "Before the scope cut".') }, ['project_id', 'label']),
      run: async (user, a) => { const { p } = project(user, a.project_id, 'editor'); const r = await callRoute('POST', `/api/projects/${p.id}/versions`, user, { label: str(a.label, 80) }); return { version_id: r.version.id, label: r.version.label }; } },
    { name: 'restore_version', title: 'Restore a version', description: 'Puts the board back as it was in a version from list_versions, for everyone. The board as it is now is kept as a version first, so this can be undone.',
      inputSchema: obj({ project_id: PID, version_id: S('From list_versions.') }, ['project_id', 'version_id']), annotations: { destructiveHint: true },
      run: async (user, a) => { const { p } = project(user, a.project_id, 'editor'); await callRoute('POST', `/api/projects/${p.id}/versions/${encodeURIComponent(str(a.version_id, 64))}/restore`, user); return { restored: true, note: 'The board before the restore was kept as a version.' }; } },

    /* your tasks (the Godot, Unity and Unreal editor panels use these) */
    { name: 'my_tasks', title: 'My tasks', description: 'Lists the unfinished cards assigned to you across every team project you can open, soonest due first (cards with no due date last), then by priority. Each row has the project, card id, title, kind, status, priority, discipline, estimate, due date, days until due, an overdue flag, the phase it sits in and a link that opens the card. Give project_id for one project, and include_unassigned_in_project to add that project\'s cards nobody has taken yet.',
      inputSchema: obj({ project_id: S('Optional: only this project (from list_projects).'), include_unassigned_in_project: B('With project_id: also list that project\'s unfinished cards that nobody is assigned to.'),
        today: S('Optional: today\'s date where you are, YYYY-MM-DD, for due_in_days and overdue (default: your time zone on the website, else UTC).') }), annotations: { readOnlyHint: true },
      run: (user, a) => myTasks(user, a) },
    { name: 'set_card_status', title: 'Set a card\'s status', description: 'Moves one card to todo, doing, blocked or done, as ticking it off in the app does, and returns the card as my_tasks lists it. update_cards changes more fields at once.',
      inputSchema: obj({ project_id: PID, card_id: S('Card id (or its exact title).'), status: { type: 'string', enum: ['todo', 'doing', 'blocked', 'done'] },
        today: S('Optional: today\'s date where you are, YYYY-MM-DD, as for my_tasks.') }, ['project_id', 'card_id', 'status']),
      run: (user, a) => {
        const { p, role, doc } = project(user, a.project_id, 'editor'), id = resolveCard(doc, a.card_id), old = doc.items.find(i => i.id === id);
        if (a.status === undefined || a.status === null || a.status === '') oops('Give a status: todo, doing, blocked or done.');
        const card = cardFrom({ status: a.status }, old.x, old.y, old, p.team_id), changed = card.status !== old.status;
        if (changed) apply(user, role, p.id, [put('items', card)]);
        const ctx = projectCtx(p, role, (q.team.get(p.team_id) || {}).name || '', doc);
        return { changed, previous_status: old.status, task: taskOut(user, ctx, card, todayFor(user, a.today)) };
      } },
  ];
  const listed = TOOLS.map(({ run, ...t }) => t);

  /* ---------- the endpoint ---------- */
  const INSTRUCTIONS = 'Venom Board is a planning board and reference board for game development, on an infinite canvas. A team has projects; a project board holds cards (tasks, bugs, milestones, ideas with status, MoSCoW priority, discipline, estimate, due date, assignees), phases (frames, ordered left to right, that hold cards), text, pictures and GIFs, YouTube/Vimeo videos, ink (marker and highlighter), connectors and a game jam clock. Arrows between cards mean "waits on" and drive the schedule and critical path. Board units: x grows right, y grows down; a card is about 240×100 and a phase 600 wide. Start with list_projects. Use get_board to plan and get_items to see the layout before placing things; new things without a position go in free space to the right. For pictures on the user\'s computer, use get_upload_url and send the file with curl; replace_media swaps a picture or video for another. Templates (list_templates) give a quick start. Cards can carry tags, tracked time and linked pull requests (their reference, VB-…, in a commit message links them); phases can be sprints or collapsed; a frame can instead be a mood board collection of references, kept out of the phases and schedule; pictures can be cropped and turned, and pictures and videos can carry tags, a note and the web address they came from; comments have replies, reactions, resolved threads and feedback pins on pictures; my_tasks lists what is assigned to you everywhere. Everything you change appears live to the team, and the board is kept in version history before a burst of changes, so save_version before big changes and restore_version undoes them.';
  function userFor(req) {
    const h = String(req.headers.authorization || ''), token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
    if (!/^vbt_[\w-]{20,80}$/.test(token)) return null;
    const r = q.find.get(A.tokenHash(token));
    if (!r) return null;
    if (Date.now() - r.last_used > 60000) q.used.run(Date.now(), r.token_id);
    return { id: r.id, username: r.username, displayName: r.display_name, color: r.color, email: r.email, emailVerified: !!r.email_verified, tokenId: r.token_id };
  }
  const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } });
  async function answer(user, m) {
    if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') return m && m.id !== undefined ? rpcError(m.id, -32600, 'Invalid request') : null;
    if (m.id === undefined || m.id === null) return null;  // a notification (initialized, cancelled…): nothing to answer
    const p = m.params && typeof m.params === 'object' ? m.params : {};
    switch (m.method) {
      case 'initialize': {
        const v = PROTOCOLS.includes(p.protocolVersion) ? p.protocolVersion : PROTOCOLS[0];
        return { jsonrpc: '2.0', id: m.id, result: { protocolVersion: v, capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'venom-board', title: 'Venom Board', version }, instructions: INSTRUCTIONS } };
      }
      case 'ping': return { jsonrpc: '2.0', id: m.id, result: {} };
      case 'tools/list': return { jsonrpc: '2.0', id: m.id, result: { tools: listed } };
      case 'tools/call': {
        const tool = TOOLS.find(t => t.name === p.name);
        if (!tool) return rpcError(m.id, -32602, `Unknown tool "${p.name}".`);
        if (!limit('mcp-call:' + user.id, 120, 60000)) return { jsonrpc: '2.0', id: m.id, result: { isError: true, content: [{ type: 'text', text: 'Too many calls in a minute. Wait a little and try again.' }] } };
        try {
          const out = await tool.run(user, p.arguments && typeof p.arguments === 'object' ? p.arguments : {});
          if (out && out._content) return { jsonrpc: '2.0', id: m.id, result: { content: out._content } };
          return { jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: JSON.stringify(out, null, 1) }], structuredContent: out } };
        } catch (e) {
          const known = e instanceof ToolError || e instanceof H.HttpError || e instanceof TypeError && /Cannot read|is not iterable|slice is not a function|map is not a function/.test(e.message);
          const text = e instanceof ToolError || e instanceof H.HttpError ? e.message : known ? 'Some arguments are missing or the wrong shape. Check the tool\'s input schema.' : 'Something went wrong on the server.';
          if (!(e instanceof ToolError) && !(e instanceof H.HttpError)) log('[mcp]', p.name, e.stack);
          return { jsonrpc: '2.0', id: m.id, result: { isError: true, content: [{ type: 'text', text }] } };
        }
      }
      default: return rpcError(m.id, -32601, `Method not found: ${m.method}`);
    }
  }
  async function handle(req, res) {
    const send = (status, body, extra = {}) => { res.writeHead(status, { 'Cache-Control': 'no-store', ...extra, ...(body ? { 'Content-Type': 'application/json' } : {}) }); res.end(body ? JSON.stringify(body) : undefined); };
    // web pages may not call it (DNS-rebinding guard); MCP clients don't send an Origin, or send this site's
    if (req.headers.origin && req.headers.origin !== cfg.PUBLIC_ORIGIN) return send(403, rpcError(null, -32000, 'Requests from web pages are not allowed.'));
    if (req.method !== 'POST') return send(405, null, { Allow: 'POST' });
    const v = req.headers['mcp-protocol-version'];
    if (v && !PROTOCOLS.includes(v)) return send(400, rpcError(null, -32000, `Unsupported MCP protocol version ${v}.`));
    const user = userFor(req);
    if (!user) return send(401, rpcError(null, -32001, 'Add a Venom Board access token: Authorization: Bearer vbt_… (create one in your account settings at ' + cfg.PUBLIC_URL + '/account).'), { 'WWW-Authenticate': 'Bearer realm="Venom Board"' });
    if (!limit('mcp:' + user.id, 600, 60000)) return send(429, rpcError(null, -32000, 'Too many requests. Wait a minute.'));
    // big requests are read one at a time per person, so a few can't use up the server's memory
    const big = Number(req.headers['content-length'] || 0) > 1048576 || !req.headers['content-length'];
    if (big && reading.has(user.id)) return send(429, rpcError(null, -32000, 'Another large request is still being read. Try again in a moment.'));
    let body;
    // room for a picture sent as base64 in a tool call
    if (big) reading.add(user.id);
    try { body = JSON.parse((await H.readBody(req, Math.ceil(uploadMax() * 1.4) + 1048576).finally(() => { if (big) reading.delete(user.id); })).toString('utf8')); } catch (e) { return send(e.status === 413 ? 413 : 400, rpcError(null, -32700, e.status === 413 ? 'That request is too large.' : 'Parse error')); }
    if (Array.isArray(body)) {  // older clients may batch
      const out = (await Promise.all(body.slice(0, 50).map(m => answer(user, m)))).filter(Boolean);
      return out.length ? send(200, out) : send(202);
    }
    const out = await answer(user, body);
    return out ? send(200, out) : send(202);
  }
  const reading = new Set();  // people whose large /mcp request is being read
  // a file sent to a one-time address from get_upload_url
  async function upload(req, res, url) {
    const send = (status, body) => { res.writeHead(status, { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.headers.origin) return send(403, { error: 'Requests from web pages are not allowed.' });
    if (req.method !== 'PUT' && req.method !== 'POST') return send(405, { error: 'Send the file with PUT.' });
    sweep();
    const key = url.pathname.slice('/mcp/upload/'.length), t = tickets.get(key);
    if (!t) { req.resume(); return send(404, { error: 'That upload address has expired or was used. get_upload_url makes a new one.' }); }
    tickets.delete(key);
    if (t.user.tokenId && !q.alive.get(t.user.tokenId)) { req.resume(); return send(404, { error: 'The token that made this upload address was revoked.' }); }
    try {
      const { p } = project(t.user, t.projectId, 'editor');
      if (reading.has(t.user.id)) { req.resume(); return send(429, { error: 'Another upload is still going. Try again in a moment.' }); }
      reading.add(t.user.id);
      const buf = await H.readBody(req, uploadMax()).finally(() => reading.delete(t.user.id));
      const a = storeAsset(t.user, p, buf), size = a.mime.startsWith('image/') ? imageSize(buf) : null;
      return send(200, { upload_id: a.id, kind: a.mime.startsWith('video/') ? 'video' : 'image', mime: a.mime, bytes: buf.length, ...(size ? { width: size.w, height: size.h } : {}), next: a.mime.startsWith('video/') ? 'add_video with this upload_id' : 'add_image with this upload_id' });
    } catch (e) {
      if (!(e instanceof ToolError) && !(e instanceof H.HttpError)) log('[mcp upload]', e.stack);
      return send(e.status || 400, { error: e instanceof ToolError || e instanceof H.HttpError ? e.message : 'Something went wrong on the server.' });
    }
  }

  return { handle, upload, revokeAll: userId => q.dropAll.run(userId), imageSize };
}

module.exports = { mcp, imageSize, privateIp, parseVideoLink };
