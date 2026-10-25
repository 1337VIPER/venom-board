// Every board object that reaches the server (new projects, live edits) is rebuilt from validated
// fields. This mirrors the app's own loader so a hostile teammate can't push markup to others.
const BONE = '#f1eef2';
const KINDS = ['task', 'milestone', 'bug', 'idea'];
const STATUS = ['todo', 'doing', 'blocked', 'done'];
const DISC = ['code', 'art', 'design', 'level', 'audio', 'ui', 'vfx', 'narr', 'qa', 'tech', 'mkt'];
const PRIO = ['must', 'should', 'could', 'wont'];
const SEV = ['crash', 'major', 'minor', 'polish'];
const MAX_OBJECTS = 20000;
const MAX_POINTS = 40000;

const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const txt = (v, max) => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, max);
const okId = v => typeof v === 'string' && /^[\w-]{1,64}$/.test(v);
const okColor = c => typeof c === 'string' && /^#[0-9a-f]{3,8}$/i.test(c);
const oneOf = (v, list, d) => (list.includes(v) ? v : d);
const colorOr = (c, d) => (okColor(c) ? c : d);
const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const okTime = v => Number.isFinite(v) && v > 1.5e12 && v < 4e12;  // a millisecond timestamp between 2017 and 2096
const ids = (v, max) => [...new Set((Array.isArray(v) ? v : []).filter(okId))].slice(0, max);

// Time tracking, tags and sprints (all optional). A card's tracked time is whole minutes; tags are up to 8 short
// lower-case words; a sprint is a phase frame's first and last day (real dates, up to a year apart) and the days of
// work each teammate (or "all", the whole board) can give it.
const SPENT_MAX = 1000000;
const TAG_RE = /^[\p{L}\p{N}_-]{1,24}$/u;
const cleanSpent = v => (typeof v === 'number' && Number.isFinite(v) ? Math.round(clamp(v, 0, SPENT_MAX)) : 0);
// A card's time log: up to 500 entries, each who logged it (an account id; empty from a board made on someone's
// computer), when they started, whole minutes (up to a day) and a short note. Who may add or remove entries in a
// live project is checked when an edit arrives (realtime.js).
const LOG_MAX = 500, ENTRY_MAX = 1440;
function cleanLog(v) {
  const out = [], seen = new Set();
  for (const e of Array.isArray(v) ? v.slice(-LOG_MAX * 2) : []) {
    if (!e || typeof e !== 'object' || !okId(e.id) || seen.has(e.id) || !okTime(e.at)) continue;
    const mins = Math.round(Number(e.mins));
    if (!(mins >= 1 && mins <= ENTRY_MAX)) continue;
    const x = { id: e.id, by: okId(e.by) ? e.by : '', at: e.at, mins }, note = txt(e.note, 200).trim();
    if (note) x.note = note;
    seen.add(e.id); out.push(x);
  }
  return out.slice(-LOG_MAX);
}
function cleanTags(v) {
  const out = [];
  for (const t of Array.isArray(v) ? v.slice(0, 64) : []) {
    if (typeof t !== 'string') continue;
    const s = t.trim().toLowerCase();
    if (TAG_RE.test(s) && !out.includes(s)) out.push(s);
    if (out.length === 8) break;
  }
  return out;
}
const realDay = s => {
  if (typeof s !== 'string' || !/^20\d\d-\d\d-\d\d$/.test(s)) return false;
  const t = Date.parse(s + 'T00:00:00Z');
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
};
function cleanSprint(s) {
  if (!s || typeof s !== 'object' || !realDay(s.start) || !realDay(s.end) || s.end < s.start) return null;
  if ((Date.parse(s.end) - Date.parse(s.start)) / 864e5 > 366) return null;
  const out = { start: s.start, end: s.end }, cap = {};
  if (s.cap && typeof s.cap === 'object' && !Array.isArray(s.cap)) {
    let n = 0;
    for (const k of Object.keys(s.cap)) {
      const v = s.cap[k];
      if (k === '__proto__' || !okId(k) || typeof v !== 'number' || !(v >= 0 && v <= 365)) continue;
      cap[k] = Math.round(v * 10) / 10;
      if (++n === 50) break;
    }
  }
  if (Object.keys(cap).length) out.cap = cap;
  return out;
}

// Shared boards only show pictures stored on this server. A link to anywhere else would make every
// teammate's browser fetch it, telling that site their address whenever they open the board.
const okImageSrc = (src, base) => typeof src === 'string' && !!base && src.startsWith(base) && /^[\w-]{20,64}$/.test(src.slice(base.length));

/* ---------- GitHub and GitLab links on cards ---------- */
// Pull requests, merge requests and issues a card links to: plain https addresses on github.com or gitlab.com
// only (no other hosts, logins, queries or odd characters), ten at most.
const GIT_LINK = /^https:\/\/(?:www\.)?(?:github\.com|gitlab\.com)\/[A-Za-z0-9._~/-]{1,250}(?:#[A-Za-z0-9_-]{1,80})?$/;
const okGitLink = u => typeof u === 'string' && u.length <= 300 && GIT_LINK.test(u) && !/(^|\/)\.\.?(\/|#|$)/.test(u.slice(8));
const gitLinks = v => [...new Set((Array.isArray(v) ? v : []).filter(okGitLink))].slice(0, 10);
// A picture's crop: x, y, w, h as fractions of the whole picture, inside it and not too thin. The whole picture is no crop.
function cleanCrop(c) {
  if (!c || typeof c !== 'object' || ![c.x, c.y, c.w, c.h].every(v => typeof v === 'number' && Number.isFinite(v))) return null;
  if (c.x < 0 || c.y < 0 || c.w <= 0.01 || c.h <= 0.01 || c.x + c.w > 1.0001 || c.y + c.h > 1.0001) return null;
  const k = v => Math.round(v * 1e5) / 1e5, out = { x: k(c.x), y: k(c.y) };
  out.w = Math.min(k(c.w), k(1 - out.x)); out.h = Math.min(k(c.h), k(1 - out.y));
  return out.w > 0.01 && out.h > 0.01 && (out.x > 0 || out.y > 0 || out.w < 1 || out.h < 1) ? out : null;
}

function cleanItem(i, opts = {}) {
  if (!i || typeof i !== 'object' || !okId(i.id)) return null;
  const base = { id: i.id, type: i.type, x: num(i.x), y: num(i.y), w: Math.max(0, num(i.w, 100)), h: Math.max(0, num(i.h, 100)) };
  if (i.locked) base.locked = true;
  switch (i.type) {
    case 'node': {
      const kind = oneOf(i.kind, KINDS, 'task');
      const n = { ...base, kind, title: txt(i.title, 500), body: txt(i.body, 8000), status: oneOf(i.status, STATUS, 'todo'), color: colorOr(i.color, BONE),
        disc: oneOf(i.disc, DISC, ''), prio: oneOf(i.prio, PRIO, ''), est: txt(i.est, 12), due: isDate(i.due) ? i.due : '' };
      if (kind === 'bug') n.sev = oneOf(i.sev, SEV, 'major');
      const who = ids(i.assignees, 8);
      if (who.length) n.assignees = who;
      if (okTime(i.createdAt)) n.createdAt = i.createdAt;  // when it was added and finished, for the burndown chart
      if (okTime(i.doneAt) && n.status === 'done') n.doneAt = i.doneAt;
      if (i.nopub === true) n.nopub = true;  // hidden from the project's public roadmap
      const spent = cleanSpent(i.spent), tags = cleanTags(i.tags);
      if (spent) n.spent = spent;  // tracked time, in minutes
      if (Array.isArray(i.log)) n.log = cleanLog(i.log);  // who tracked it, and when (kept even when empty: an edit that empties it differs from one that never had it)
      if (Array.isArray(i.plan)) n.plan = cleanLog(i.plan);  // time people planned for it, the same shape (and it can be ahead)
      if (typeof i.start === 'string') n.start = isDate(i.start) ? i.start : '';  // not before this day ('' clears it)
      if (tags.length) n.tags = tags;
      const gl = gitLinks(i.gitLinks);
      if (gl.length) n.gitLinks = gl;  // linked pull requests, merge requests and issues
      return n;
    }
    case 'text': return { ...base, text: txt(i.text, 4000), size: clamp(num(i.size, 32), 4, 800), color: colorOr(i.color, BONE) };
    case 'frame': {
      const f = { ...base, title: txt(i.title, 200), color: colorOr(i.color, '#a66bff') }, sp = cleanSprint(i.sprint);
      if (sp) f.sprint = sp;  // a phase used as a sprint
      if (i.collapsed === true) f.collapsed = true;  // folded down to its title bar
      return f;
    }
    case 'jam': {  // a game jam's clock: deadline, theme and a scope check
      if (!okTime(i.end)) return null;
      const j = { ...base, w: clamp(num(i.w, 360), 280, 720), title: txt(i.title, 80), theme: txt(i.theme, 120), end: i.end, people: clamp(Math.round(num(i.people, 1)), 1, 50), color: colorOr(i.color, '#ff2a4f') };
      if (okTime(i.reveal)) j.reveal = i.reveal;
      return j;
    }
    case 'image': {
      const img = { ...base, name: txt(i.name, 200), flip: !!i.flip, gray: !!i.gray };
      // shared boards reference files uploaded to this server; inline data and outside links are dropped
      if (okImageSrc(i.src, opts.assetBase)) img.src = i.src;
      const crop = cleanCrop(i.crop); if (crop) img.crop = crop;  // the part of the picture that shows
      if (i.rot === 90 || i.rot === 180 || i.rot === 270) img.rot = i.rot;  // quarter turns, clockwise
      return img;
    }
    case 'video': {
      // a YouTube or Vimeo video (played from their site, only when someone clicks it) or a file stored here
      const vid = { ...base, name: txt(i.name, 200), loop: i.loop !== false, autoplay: !!i.autoplay }, e = i.embed;
      if (e && typeof e === 'object' && ((e.p === 'yt' && /^[\w-]{11}$/.test(e.id)) || (e.p === 'vimeo' && /^\d{5,12}$/.test(e.id)))) vid.embed = { p: e.p, id: e.id };
      else if (okImageSrc(i.src, opts.assetBase)) vid.src = i.src;
      return vid;
    }
  }
  return null;
}
function cleanEnd(e) {
  if (!e || typeof e !== 'object') return null;
  if (e.id !== undefined) return okId(e.id) ? { id: e.id } : null;
  return { x: num(e.x), y: num(e.y) };
}
function cleanLink(l) {
  if (!l || typeof l !== 'object' || !okId(l.id)) return null;
  const from = cleanEnd(l.from), to = cleanEnd(l.to);
  if (!from || !to) return null;
  const out = { id: l.id, type: 'link', from, to, color: colorOr(l.color, BONE), style: oneOf(l.style, ['curve', 'straight', 'elbow', 'circuit'], 'curve'),
    head: oneOf(l.head, ['end', 'both', 'none'], 'end'), dash: !!l.dash, flow: !!l.flow, label: txt(l.label, 60) };
  if (l.width !== undefined) out.width = clamp(num(l.width, 2.5), 1, 12);
  // reroute points the wire runs through
  const via = (Array.isArray(l.via) ? l.via : []).slice(0, 24).filter(k => k && Number.isFinite(Number(k.x)) && Number.isFinite(Number(k.y)) && Math.abs(k.x) < 1e7 && Math.abs(k.y) < 1e7).map(k => ({ x: num(k.x), y: num(k.y) }));
  if (via.length) out.via = via;
  return out;
}
function cleanStroke(s) {
  if (!s || typeof s !== 'object' || !okId(s.id) || !Array.isArray(s.pts)) return null;
  const pts = s.pts.slice(0, MAX_POINTS).map(Number).filter(Number.isFinite);
  if (pts.length % 2) pts.pop();
  if (pts.length < 2) return null;
  return { id: s.id, type: 'stroke', kind: s.kind === 'hl' ? 'hl' : 'pen', color: colorOr(s.color, BONE), size: clamp(num(s.size, 4), 0.05, 500), pts };
}

// A comment on a card. Who wrote it and when are set by the server from the connection, never taken from the client.
function cleanComment(c) {
  if (!c || typeof c !== 'object' || !okId(c.id) || !okId(c.card)) return null;
  const text = txt(c.text, 2000).trim();
  if (!text) return null;
  const out = { id: c.id, type: 'comment', card: c.card, by: okId(c.by) ? c.by : '', at: okTime(c.at) ? c.at : 0, text };
  if (okTime(c.edited)) out.edited = c.edited;
  Object.assign(out, cleanThread(c));
  return out;
}

/* ---------- comment threads: replies, reactions, resolving, feedback pins ---------- */
// Optional fields, each rebuilt from validated values. Who may change them is decided in realtime.js.
const REACTIONS = ['\u{1F44D}', '\u{2764}\u{FE0F}', '\u{1F389}', '\u{1F602}', '\u{1F440}', '\u{2705}'];  // thumbs up, heart, party, laughing, eyes, tick
const MAX_REACTORS = 100;
function cleanReact(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  const out = {};
  for (const e of REACTIONS) { const who = ids(r[e], MAX_REACTORS); if (who.length) out[e] = who; }
  return Object.keys(out).length ? out : null;
}
function cleanThread(c) {
  const out = {};
  // a reply names the comment it answers; replies don't carry a pin or a resolved state (their thread's first comment does)
  if (okId(c.re) && c.re !== c.id) out.re = c.re;
  const react = cleanReact(c.react);
  if (react) out.react = react;
  if (!out.re && okTime(c.resolved)) { out.resolved = c.resolved; out.resolvedBy = okId(c.resolvedBy) ? c.resolvedBy : ''; }
  // a feedback pin: where on the picture it points, as fractions of its width and height
  const p = c.pin;
  if (!out.re && p && typeof p === 'object' && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y))) {
    const f = v => Math.round(clamp(Number(v), 0, 1) * 10000) / 10000;
    out.pin = { x: f(p.x), y: f(p.y) };
  }
  return out;
}

const CLEAN = { items: cleanItem, links: cleanLink, strokes: cleanStroke, comments: cleanComment };
const COLLECTIONS = Object.keys(CLEAN);

// opts.assetBase is this server's image address prefix, e.g. https://venomboard.com/assets/
function cleanDoc(d, opts = {}) {
  d = d && typeof d === 'object' ? d : {};
  const out = {};
  for (const k of COLLECTIONS) out[k] = (Array.isArray(d[k]) ? d[k] : []).slice(0, MAX_OBJECTS).map(o => CLEAN[k](o, opts)).filter(Boolean);
  return out;
}

// A live edit: put (create or replace one object), del (remove by id) or order (z-order of a collection).
function cleanOp(op, opts = {}) {
  if (!op || typeof op !== 'object' || !Object.hasOwn(CLEAN, op.k)) return null;  // not constructor, toString or __proto__
  if (op.op === 'put') { const obj = CLEAN[op.k](op.obj, opts); return obj ? { k: op.k, op: 'put', obj } : null; }
  if (op.op === 'del') return okId(op.id) ? { k: op.k, op: 'del', id: op.id } : null;
  if (op.op === 'order') return Array.isArray(op.ids) ? { k: op.k, op: 'order', ids: op.ids.slice(0, MAX_OBJECTS).filter(okId) } : null;
  return null;
}

module.exports = { cleanDoc, cleanOp, okId, txt, COLLECTIONS, MAX_OBJECTS, REACTIONS, okGitLink, LOG_MAX };
