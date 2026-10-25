// Players straight to the board, for team projects: a playtest feedback form at /f/<token> that a team admin turns
// on, and an in-game bug reporter (POST /api/report with the project's report key, "Authorization: Bearer vbr_…").
//
// What players send becomes cards through the live path, as if a teammate had added them: a bug or idea card in its
// own frame ("Playtest inbox" or "Bug reports", made on the right of the board when it isn't there), with any
// screenshot placed next to it and connected to it. Everyone with the board open sees it arrive, the activity feed
// names the player, and the cards stay off the public roadmap until the team shows them.
//
// Both are open to anyone (a report key ships inside a game, so in practice it's public), so everything is checked
// and limited: the form has a hidden honeypot field and a signed time check, there are limits per network, per
// project and per key, every field has a size, screenshots must really be PNG, JPEG or WebP and count toward the
// team's storage, and an admin can pause or turn off the form, give it a new address, or revoke the key at any time.
// The public pages show the form and a thank-you, never anything from the board.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { esc } = require('./page');
const { imageSize } = require('./mcp');

const MB = 1048576, MINUTE = 60000, HOUR = 3600000, DAY = 86400000;
const SHOT_MAX = 5 * MB;                  // one screenshot
const FORM_MAX = SHOT_MAX + 128 * 1024;   // a whole form: the screenshot and the words
const REPORT_MAX = 8e6;                   // one bug report as JSON: a screenshot in base64, a log and the rest
const LOG_MAX = 65536;                    // characters of log a report may carry
const TITLE_MAX = 120, DETAILS_MAX = 4000, NAME_MAX = 40, BUILD_MAX = 60;
const NOTES_MAX = 8000;                   // a card's notes (sanitize.js keeps this many)
// A card shows its notes in full on the board, so only the end of a log goes on it: enough to see what happened
// last, without turning the card into a column thousands of pixels tall.
const LOG_LINES = 25, LOG_CHARS = 1200;
const REPEAT_COMMENTS = 100;              // "reported again" comments one card gets at most
const KINDS = {
  bug: { kind: 'bug', color: '#ff7a1a', label: 'Bug' },
  idea: { kind: 'idea', color: '#ffd23d', label: 'Idea' },
  other: { kind: 'idea', color: '#ffd23d', label: 'Something else' },
};
const SEVERITY = { crash: 'crash', critical: 'crash', blocker: 'crash', fatal: 'crash', major: 'major', high: 'major',
  minor: 'minor', medium: 'minor', normal: 'minor', low: 'minor', polish: 'polish', cosmetic: 'polish', trivial: 'polish' };
const SHOT_TYPES = [
  { mime: 'image/png', test: b => b.length > 24 && b.readUInt32BE(0) === 0x89504e47 },
  { mime: 'image/jpeg', test: b => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/webp', test: b => b.length > 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP' },
];
const INBOX = { title: 'Playtest inbox', color: '#2fd6ff' }, BUGS = { title: 'Bug reports', color: '#ff2a4f' };
// the form's pages load nothing from anywhere else, run only our own script, and post only back here
const PAGE_CSP = "default-src 'none'; style-src 'self'; img-src 'self'; script-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
const PAGE_HEADERS = { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': PAGE_CSP, 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'no-store' };

// control characters, and the ones that flip the direction of text (which could disguise what a card says), go
const CTRL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;
const line = (v, max) => String(v ?? '').replace(CTRL, '').replace(/\s+/g, ' ').trim().slice(0, max);
const para = (v, max) => String(v ?? '').replace(/\r\n?/g, '\n').replace(CTRL, '').replace(/[ \t]+\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim().slice(0, max);
// a name a player gives is shown as plain words, never as a link
const nameOf = v => line(String(v ?? '').replace(/(https?:\/\/|www\.)\S*/gi, ''), NAME_MAX);
const when = t => new Date(t).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
const newId = () => crypto.randomBytes(9).toString('base64url');
const rd = v => Math.round(v * 10) / 10;
// two titles are the same bug when only case, spacing and punctuation differ
const titleKey = t => t.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().slice(0, 200);
const sameSig = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

// the parts of a multipart/form-data body (what a browser sends for a form with a file), or null if it's malformed
function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]{1,70})"|([^;\s]{1,70}))/i.exec(contentType || '');
  if (!m) return null;
  const dash = Buffer.from('--' + (m[1] || m[2])), next = Buffer.from('\r\n--' + (m[1] || m[2]));
  const parts = [];
  let pos = buf.indexOf(dash);
  if (pos < 0) return null;
  pos += dash.length;
  for (let n = 0; n < 20; n++) {
    if (buf[pos] === 45 && buf[pos + 1] === 45) return parts;  // the closing boundary
    if (buf[pos] !== 13 || buf[pos + 1] !== 10) return null;
    const headEnd = buf.indexOf('\r\n\r\n', pos + 2);
    if (headEnd < 0 || headEnd - pos > 2000) return null;
    const head = buf.toString('utf8', pos + 2, headEnd), end = buf.indexOf(next, headEnd + 4);
    if (end < 0) return null;
    const disp = /^content-disposition:\s*form-data\s*;(.*)$/im.exec(head);
    const name = disp && /\bname="([^"]{1,40})"/i.exec(disp[1]), file = disp && /\bfilename="([^"]*)"/i.exec(disp[1]);
    if (name) parts.push({ name: name[1], filename: file ? file[1] : null, body: buf.subarray(headEnd + 4, end) });
    pos = end + next.length;
  }
  return null;  // more parts than this form has
}

// A request body up to max bytes, or { tooBig } past that. A bigger body is read and dropped (up to a point), so the
// sender's browser gets the answer instead of a broken connection.
function readUpTo(req, max) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length'] || 0) > max) { resolve({ tooBig: true }); return; }  // Node drops the body after the answer
    const chunks = []; let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size <= max) chunks.push(c);
      else { chunks.length = 0; if (size > 8 * max) req.destroy(); }
    });
    req.on('end', () => resolve(size > max ? { tooBig: true } : { buf: Buffer.concat(chunks) }));
    req.on('close', () => resolve({ tooBig: true }));  // cut off: whatever is answered goes nowhere
    req.on('error', reject);
  });
}

function intake({ db, cfg, log, route, fail, H, A, limit, needProject, live, storeAsset, secret }) {
  const q = {
    link: db.prepare('SELECT * FROM feedback_links WHERE project_id = ?'),
    linkByToken: db.prepare('SELECT f.*, p.name, p.team_id FROM feedback_links f JOIN projects p ON p.id = f.project_id WHERE f.token = ?'),
    addLink: db.prepare('INSERT INTO feedback_links (project_id, token, paused, created_by, created_at) VALUES (?, ?, 0, ?, ?)'),
    setPaused: db.prepare('UPDATE feedback_links SET paused = ? WHERE project_id = ?'),
    setToken: db.prepare('UPDATE feedback_links SET token = ? WHERE project_id = ?'),
    delLink: db.prepare('DELETE FROM feedback_links WHERE project_id = ?'),
    sent: db.prepare('UPDATE feedback_links SET submissions = submissions + 1, last_at = ? WHERE project_id = ?'),
    key: db.prepare('SELECT * FROM report_keys WHERE project_id = ?'),
    keyByHash: db.prepare('SELECT k.project_id, p.name, p.team_id FROM report_keys k JOIN projects p ON p.id = k.project_id WHERE k.key_hash = ?'),
    setKey: db.prepare(`INSERT INTO report_keys (project_id, key_hash, hint, created_by, created_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET key_hash = excluded.key_hash, hint = excluded.hint, created_by = excluded.created_by, created_at = excluded.created_at, last_used = 0, reports = 0`),
    delKey: db.prepare('DELETE FROM report_keys WHERE project_id = ?'),
    usedKey: db.prepare('UPDATE report_keys SET reports = reports + 1, last_used = ? WHERE project_id = ?'),
    seen: db.prepare('SELECT * FROM report_titles WHERE project_id = ? AND title_key = ?'),
    setSeen: db.prepare(`INSERT INTO report_titles (project_id, title_key, card_id, last_at, count, comments) VALUES (?, ?, ?, ?, 1, 0)
      ON CONFLICT(project_id, title_key) DO UPDATE SET card_id = excluded.card_id, last_at = excluded.last_at, count = 1, comments = 0`),
    again: db.prepare('UPDATE report_titles SET last_at = ?, count = count + 1, comments = comments + ? WHERE project_id = ? AND title_key = ?'),
    forgetSeen: db.prepare('DELETE FROM report_titles WHERE last_at < ?'),
    dropAsset: db.prepare('DELETE FROM assets WHERE id = ?'),
  };
  const assetDir = path.join(cfg.DATA_DIR, 'assets');
  const linkUrl = token => `${cfg.PUBLIC_URL}/f/${token}`;
  const newToken = () => crypto.randomBytes(18).toString('base64url');

  /* ---------- settings, for the Team panel ---------- */
  function stateOf(p) {
    const f = q.link.get(p.id), k = q.key.get(p.id);
    return {
      feedback: f ? { url: linkUrl(f.token), paused: !!f.paused, submissions: f.submissions, lastAt: f.last_at || null, createdAt: f.created_at } : null,
      reportKey: k ? { hint: k.hint, createdAt: k.created_at, lastUsed: k.last_used || null, reports: k.reports } : null,
      reportUrl: cfg.PUBLIC_URL + '/api/report',
    };
  }
  const changed = p => live().sharingChanged(p.id);  // everyone with the board open sees the new settings and counts
  function adminOf(ctx) {
    const { p } = needProject(ctx.params.id, ctx.user, 'admin');
    if (!limit('intake-admin:' + ctx.user.id, 60, HOUR)) fail(429, 'rate', 'Try again in a while.');
    return p;
  }
  route('GET', '/api/projects/:id/intake', ctx => stateOf(needProject(ctx.params.id, ctx.user, 'viewer').p));
  // turns the form on (when it's off), pauses or resumes it ({paused}), or gives it a new address ({newLink: true})
  route('POST', '/api/projects/:id/intake/feedback', async ctx => {
    const p = adminOf(ctx), b = await H.readJson(ctx.req);
    if (!q.link.get(p.id)) {
      if (!ctx.user.emailVerified) fail(403, 'verify_first', 'Confirm your email address before you turn on a feedback form. We sent you a link when you signed up.');
      q.addLink.run(p.id, newToken(), ctx.user.id, Date.now());
      log('[intake] feedback form on for project', p.id);
    } else if (b.newLink === true) q.setToken.run(newToken(), p.id);
    if (typeof b.paused === 'boolean') q.setPaused.run(b.paused ? 1 : 0, p.id);
    changed(p);
    return stateOf(p);
  });
  route('DELETE', '/api/projects/:id/intake/feedback', ctx => { const p = adminOf(ctx); q.delLink.run(p.id); changed(p); return stateOf(p); });
  // a new report key replaces the old one; it's shown this once and only its hash is kept
  route('POST', '/api/projects/:id/intake/key', ctx => {
    const p = adminOf(ctx);
    if (!ctx.user.emailVerified) fail(403, 'verify_first', 'Confirm your email address before you make a report key. We sent you a link when you signed up.');
    const key = 'vbr_' + crypto.randomBytes(32).toString('base64url');
    q.setKey.run(p.id, A.tokenHash(key), key.slice(-4), ctx.user.id, Date.now());
    log('[intake] report key made for project', p.id);
    changed(p);
    return { ...stateOf(p), key };
  });
  route('DELETE', '/api/projects/:id/intake/key', ctx => { const p = adminOf(ctx); q.delKey.run(p.id); changed(p); return stateOf(p); });

  /* ---------- onto the board ---------- */
  // Players act as a stand-in for the project (never a real account), named by what they gave. The stand-in is
  // per project, so one busy game can't use up another's allowances.
  const player = (p, name) => ({ id: 'vb-play-' + p.id, username: '', displayName: name ? `${name} (playtester)` : 'Playtester', color: '#ffd23d', guest: true });
  const reporter = (p, name) => ({ id: 'vb-bugs-' + p.id, username: '', displayName: name ? `${name} (bug reporter)` : 'Bug reporter', color: '#ff7a1a', guest: true });
  const put = (k, obj) => ({ k, op: 'put', obj });
  // how tall a card is drawn: cards grow with their title and notes (a little generous, so nothing overlaps)
  const wrapped = (s, per) => String(s || '').split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / per)), 0);
  const cardH = o => { const inner = Math.max(60, (o.w || 240) - 30); return Math.max(o.h || 100, Math.round(85 + wrapped(o.title || ' ', inner / 9.5) * 20 + (o.body ? 4 + wrapped(o.body, inner / 7) * 18.5 : 0))); };
  const boxOf = o => (o.type === 'frame' ? { x: o.x, y: o.y - 40, w: o.w, h: o.h + 40 } : { x: o.x, y: o.y, w: o.w || 240, h: o.type === 'node' ? cardH(o) : o.h || 100 });
  const strokeBox = s => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (let i = 0; i < s.pts.length; i += 2) { x0 = Math.min(x0, s.pts[i]); x1 = Math.max(x1, s.pts[i]); y0 = Math.min(y0, s.pts[i + 1]); y1 = Math.max(y1, s.pts[i + 1]); } return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }; };
  const hit = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  // each card and its screenshot take a slot: two to a row inside the frame, in the first free one (a tall card
  // takes the room of several rows)
  const SLOT = { w: 520, h: 240, gap: 40, pad: 40, top: 50 };
  function placeIn(doc, inbox, need) {
    let frame = doc.items.find(i => i.type === 'frame' && i.title.trim().toLowerCase() === inbox.title.toLowerCase()), grown = false;
    if (!frame) {  // on the right of everything on the board, level with its top
      const boxes = [...doc.items.map(boxOf), ...doc.strokes.map(strokeBox)];
      const right = boxes.reduce((m, b) => Math.max(m, b.x + b.w), -Infinity), top = boxes.reduce((m, b) => Math.min(m, b.y), Infinity);
      frame = { id: newId(), type: 'frame', x: boxes.length ? rd(right + 200) : 0, y: boxes.length ? rd(top + 40) : 0, w: SLOT.pad * 2 + SLOT.w * 2 + SLOT.gap, h: SLOT.top + SLOT.h + SLOT.pad, title: inbox.title, color: inbox.color };
      grown = true;
    }
    if (frame.w < SLOT.pad * 2 + SLOT.w) { frame = { ...frame, w: SLOT.pad * 2 + SLOT.w }; grown = true; }
    const cols = Math.max(1, Math.floor((frame.w - SLOT.pad * 2 + SLOT.gap) / (SLOT.w + SLOT.gap)));
    const taken = doc.items.filter(i => i.type !== 'frame' && hit(boxOf(i), frame)).map(boxOf);
    let spot = null;
    for (let r = 0; !spot; r++) for (let c = 0; c < cols && !spot; c++) {
      const s = { x: rd(frame.x + SLOT.pad + c * (SLOT.w + SLOT.gap)), y: rd(frame.y + SLOT.top + r * (SLOT.h + SLOT.gap)), w: SLOT.w, h: Math.max(SLOT.h, need) };
      if (!taken.some(t => hit(t, s))) spot = s;
    }
    if (spot.y + spot.h + SLOT.pad > frame.y + frame.h) { frame = { ...frame, h: rd(spot.y + spot.h + SLOT.pad - frame.y) }; grown = true; }
    return { frame, grown, spot };
  }
  function dropAsset(id) { q.dropAsset.run(id); fs.rm(path.join(assetDir, id), { force: true }, () => {}); }
  // A card (and its screenshot, connected to it) in the inbox frame, through the live path. A screenshot there's no
  // room to keep doesn't lose what the player wrote: the card says one came.
  // screenshot megabytes each project has taken today, so a busy day can't fill the team's storage
  const SHOT_BUDGET = cfg.INTAKE_SHOT_MB_PER_DAY * MB, shotBytes = new Map();
  const textBytes = new Map(), TEXT_BUDGET = 1048576;  // project|day -> characters of reports taken that day
  function addCard(p, who, inbox, card, shot, ip) {
    const doc = live().currentDoc(p.id);
    if (!doc) fail(404, 'not_found', 'This project no longer exists.');
    // A game's report key and the feedback form are public, so they can't fill the board: past 70% of a board's
    // size, or a day's worth of text, new reports wait until the team makes room.
    const day = new Date().toISOString().slice(0, 10), tk = p.id + '|' + day, said = textBytes.get(tk) || 0, text = String(card.body || '').length + String(card.title || '').length;
    if (said + text > TEXT_BUDGET || JSON.stringify(doc).length > cfg.PROJECT_MAX_MB * 1048576 * 0.7) fail(507, 'full', 'This project’s board is full of reports for now.');
    textBytes.set(tk, said + text);
    if (textBytes.size > 5000) for (const k of textBytes.keys()) if (!k.endsWith(day)) textBytes.delete(k);
    let asset = null;
    if (shot) {
      // Players' screenshots count toward the team's storage. Each sender keeps a few a day per project, and the
      // project takes a set number of megabytes a day, so one sender can't use up what other players can send.
      try {
        const day = new Date().toISOString().slice(0, 10), key = p.id + '|' + day, used = shotBytes.get(key) || 0;
        if (!limit('intake-shot-ip:' + p.id + ':' + (ip || ''), cfg.INTAKE_SHOTS_PER_SENDER, DAY) || used + shot.buf.length > SHOT_BUDGET) fail(429, 'shots', 'Enough screenshots for today.');
        asset = storeAsset({ id: who.id }, { id: p.id, team_id: p.team_id }, shot.buf);
        shotBytes.set(key, used + shot.buf.length);
        if (shotBytes.size > 5000) for (const k of shotBytes.keys()) if (!k.endsWith(day)) shotBytes.delete(k);
      }
      catch (e) {
        if (!(e instanceof H.HttpError)) throw e;
        const said = '\n\nA screenshot came with this, but there was no room to keep it.';
        card.body = card.body.slice(0, NOTES_MAX - said.length) + said;
        log('[intake] screenshot not kept for project', p.id, e.code);
      }
    }
    const c = { id: newId(), type: 'node', x: 0, y: 0, w: 240, h: 100, status: 'todo', prio: '', est: '', due: '', disc: '', ...card, createdAt: Date.now(), nopub: true };
    const fit = asset ? Math.min(220 / shot.size.w, SLOT.h / shot.size.h) : 0;
    const { frame, grown, spot } = placeIn(doc, inbox, Math.max(cardH(c), asset ? shot.size.h * fit : 0));
    Object.assign(c, { x: spot.x, y: spot.y });
    const ops = grown ? [put('items', frame)] : [];
    ops.push(put('items', c));
    let pic = null;
    if (asset) {
      pic = { id: newId(), type: 'image', x: rd(spot.x + 280), y: spot.y, w: rd(shot.size.w * fit), h: rd(shot.size.h * fit), src: asset.url, name: 'Screenshot', flip: false, gray: false };
      ops.push(put('items', pic), put('links', { id: newId(), type: 'link', from: { id: c.id }, to: { id: pic.id }, color: '#9d99aa', style: 'straight', head: 'none', dash: true, flow: false, label: '' }));
    }
    const r = live().serverBatch(p.id, who, 'editor', ops), now = live().currentDoc(p.id);
    if (!r) { if (asset) dropAsset(asset.id); fail(404, 'not_found', 'This project no longer exists.'); }
    const made = !!now && now.items.some(i => i.id === c.id);
    if (asset && !(made && now.items.some(i => i.id === pic.id))) dropAsset(asset.id);
    if (!made) {
      if (r.quota) fail(507, 'quota', 'This project’s team has no storage left, so nothing more can be added to its board right now.');
      fail(507, 'board_full', 'This project’s board is full, so nothing more can be added to it right now.');
    }
    return c;
  }
  function addComment(p, who, cardId, text) {
    const r = live().serverBatch(p.id, who, 'editor', [put('comments', { id: newId(), type: 'comment', card: cardId, by: who.id, at: Date.now(), text })]);
    return !!(r && r.applied);
  }
  // a screenshot's bytes: really a PNG, JPEG or WebP with a sensible size
  function screenshot(buf, field) {
    if (buf.length > SHOT_MAX) fail(413, 'screenshot_too_big', `${field} can be up to 5 MB.`);
    const type = SHOT_TYPES.find(t => t.test(buf)), size = type ? imageSize(buf) : null;
    if (!size || !(size.w > 0 && size.h > 0) || size.w > 20000 || size.h > 20000) fail(415, 'screenshot_type', `${field} must be a PNG, JPEG or WebP picture.`);
    return { buf, size, mime: type.mime };
  }

  /* ---------- the playtest feedback form: /f/<token> ---------- */
  // The form carries the time it was shown, signed, so a reply within a moment (a bot) or from a stale copy is spotted.
  const stamp = (token, at) => crypto.createHmac('sha256', secret).update(`feedback:${token}:${at}`).digest('base64url').slice(0, 24);
  const timeField = token => { const at = Date.now().toString(36); return `${at}.${stamp(token, at)}`; };
  function timeCheck(token, v) {
    const [at = '', sig = ''] = String(v || '').split('.'), t = parseInt(at, 36);
    if (!/^[0-9a-z]{6,12}$/.test(at) || !sameSig(sig, stamp(token, at))) return 'bot';
    const age = Date.now() - t;
    if (age < 1500) return 'bot';  // nobody reads and fills in a form that fast
    return age > DAY ? 'stale' : 'ok';
  }
  const send = (res, status, html, extra = {}) => { res.writeHead(status, { ...PAGE_HEADERS, ...extra }); res.end(html); };
  const shell = (title, body, script) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#060609">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/web/site.css">${script ? '\n<script src="/web/feedback.js" defer></script>' : ''}
</head>
<body class="fb-body">
<main class="fb-wrap">
${body}
<p class="fb-made"><a class="rm-made" href="/?from=feedback">Made with <b>VENOM<em>/</em>BOARD</b></a></p>
</main>
</body>
</html>`;
  const note = (title, text, extra = '') => shell(`${title} · Venom Board`, `<div class="panel fb-done"><h1>${esc(title)}</h1><p class="lead">${esc(text)}</p>${extra}</div>`);
  const gonePage = () => note('This feedback link doesn’t work', 'It may have been turned off or replaced. Ask the team for the new one.');
  function formPage(link, v = {}, error = '') {
    const kind = Object.hasOwn(KINDS, v.kind) ? v.kind : 'bug';
    const val = (k, max) => esc(String(v[k] || '').slice(0, max));
    const kinds = Object.entries(KINDS).map(([k, o]) => `<label class="fb-k fb-k-${k}"><input type="radio" name="kind" value="${k}"${k === kind ? ' checked' : ''}><span><i aria-hidden="true"></i>${esc(o.label)}</span></label>`).join('');
    const body = `<header class="fb-head"><span class="kicker">Playtest feedback</span><h1>${esc(link.name)}</h1>
<p class="lead">Found a bug, or have an idea? Tell the team here. It goes straight to them.</p></header>
<form class="panel fb-form" method="post" action="/f/${esc(link.token)}" enctype="multipart/form-data" accept-charset="utf-8">
${error ? `<p class="fb-err" role="alert">${esc(error)}</p>\n` : ''}<fieldset class="fb-kinds"><legend>What is it?</legend><div class="fb-seg">${kinds}</div></fieldset>
<div class="field"><label for="fb-title">Short title</label><input class="input" id="fb-title" name="title" maxlength="${TITLE_MAX}" required autocomplete="off" placeholder="e.g. Fell through the floor in the cave" value="${val('title', TITLE_MAX * 2)}"></div>
<div class="field"><label for="fb-details">Details</label><textarea class="input" id="fb-details" name="details" maxlength="${DETAILS_MAX}" rows="6" required placeholder="What happened, and what did you expect? Steps that make it happen again help a lot.">${val('details', DETAILS_MAX * 2)}</textarea></div>
<div class="fb-two">
<div class="field"><label for="fb-name">Your name <em>optional</em></label><input class="input" id="fb-name" name="name" maxlength="${NAME_MAX}" autocomplete="nickname" value="${val('name', NAME_MAX * 2)}"></div>
<div class="field"><label for="fb-build">Build or version <em>optional</em></label><input class="input" id="fb-build" name="build" maxlength="${BUILD_MAX}" autocomplete="off" placeholder="e.g. 0.4.2" value="${val('build', BUILD_MAX * 2)}"></div>
</div>
<div class="field"><label for="fb-shot">Screenshot <em>optional · PNG, JPEG or WebP, up to 5 MB</em></label><input class="input fb-file" id="fb-shot" type="file" name="screenshot" accept="image/png,image/jpeg,image/webp"></div>
<div class="fb-hp" aria-hidden="true"><label for="fb-website">Leave this empty</label><input id="fb-website" name="website" tabindex="-1" autocomplete="off"></div>
<input type="hidden" name="t" value="${esc(timeField(link.token))}">
<div class="fb-send"><button class="btn red big" type="submit">Send feedback</button></div>
<p class="fb-note">What you send goes to the team making this game. Please don’t include passwords or other private details.</p>
</form>`;
    return shell(`Feedback for ${link.name} · Venom Board`, body, true);
  }
  // what the player wrote, checked; the error to show if something's wrong
  function readForm(parts) {
    const field = name => { const p = parts.find(x => x.name === name && x.filename === null); return p ? p.body.toString('utf8') : ''; };
    const v = { kind: field('kind'), title: line(field('title'), 1000), details: para(field('details'), 20000), name: nameOf(field('name')), build: line(field('build'), 200), website: field('website'), t: field('t') };
    const file = parts.find(x => x.name === 'screenshot' && x.filename !== null && x.body.length);
    let error = '';
    if (!Object.hasOwn(KINDS, v.kind)) error = 'Choose what it is: a bug, an idea or something else.';
    else if (!v.title) error = 'Give it a short title.';
    else if (v.title.length > TITLE_MAX) error = `Keep the title to ${TITLE_MAX} characters. The details can say more.`;
    else if (!v.details) error = 'Add some details: what happened, and what you expected.';
    else if (v.details.length > DETAILS_MAX) error = `The details can be up to ${DETAILS_MAX.toLocaleString('en-GB')} characters.`;
    else if (v.build.length > BUILD_MAX) error = `Keep the build or version to ${BUILD_MAX} characters.`;
    let shot = null, status = 400;
    if (!error && file) {
      try { shot = screenshot(file.body, 'The screenshot'); }
      catch (e) {
        if (!(e instanceof H.HttpError)) throw e;
        status = e.status;
        error = e.status === 413 ? 'That screenshot is bigger than 5 MB. Pick a smaller one, or crop it.' : 'The screenshot has to be a PNG, JPEG or WebP picture.';
      }
    }
    return { v, shot, error, status };
  }
  async function submit(req, res, link, ip) {
    const back = (status, v, error) => send(res, status, formPage(link, v, error));
    const thanks = () => { res.writeHead(303, { Location: `/f/${link.token}/thanks`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); res.end(); };
    if (!/^multipart\/form-data\b/i.test(String(req.headers['content-type'] || ''))) { req.resume(); return back(415, {}, 'Send the form from this page.'); }
    const got = await readUpTo(req, FORM_MAX);
    if (got.tooBig) return back(413, {}, 'That was too big to send, so nothing was sent: screenshots can be up to 5 MB. Pick a smaller one and try again.');
    const parts = parseMultipart(got.buf, req.headers['content-type']);
    if (!parts) return back(400, {}, 'That didn’t come through properly. Try sending it again.');
    const { v, shot, error, status } = readForm(parts);
    // bots fill in the hidden field, or answer before a person could have read the form: they're told it worked
    const time = timeCheck(link.token, v.t);
    if (v.website || time === 'bot') { log('[intake] dropped a bot-like feedback form for project', link.project_id); return thanks(); }
    if (!limit('fb-try:' + ip, 30, 10 * MINUTE)) return back(429, v, 'That’s a lot of tries in a short time. Wait a few minutes, then send it again.');
    if (time === 'stale') return back(400, v, 'This page was open a long time. Check what you wrote, then send it again.');
    if (link.paused) return back(409, v, 'The team has paused feedback for now, so this wasn’t sent. Try again later.');
    if (error) return back(status, v, error);
    if (!limit('fb-ip:' + ip, 10, 10 * MINUTE) || !limit('fb-ip-day:' + ip, 60, DAY)) return back(429, v, 'You’ve sent a lot of feedback in a short time. Wait a while, then send this again.');
    if (!limit('fb-project:' + link.project_id, 60, HOUR) || !limit('fb-project-day:' + link.project_id, 400, DAY)) return back(429, v, 'This game is getting a lot of feedback right now. Try again in a while.');
    const k = KINDS[v.kind], p = { id: link.project_id, team_id: link.team_id };
    const meta = [v.kind === 'other' ? 'Type: something else' : '', `From: ${v.name || 'a playtester'}`, v.build ? `Build: ${v.build}` : '', `Sent: ${when(Date.now())}, with the playtest feedback form`].filter(Boolean).join('\n');
    try {
      addCard(p, player(p, v.name), INBOX, { kind: k.kind, color: k.color, disc: k.kind === 'bug' ? 'qa' : '', title: v.title, body: `${v.details}\n\n${meta}`.slice(0, NOTES_MAX) }, shot, ip);
    } catch (e) {
      if (!(e instanceof H.HttpError)) throw e;
      return back(e.status, v, 'The team can’t take feedback right now, so this wasn’t sent. Try again later.');
    }
    q.sent.run(Date.now(), link.project_id);
    changed(p);
    return thanks();
  }
  // /f/<token> (the form, or a post from it) and /f/<token>/thanks; anything else isn't ours
  async function page(req, res, url, ip) {
    const m = url.pathname.match(/^\/f\/([\w-]{20,64})(\/thanks)?$/);
    if (!m) return false;
    const get = req.method === 'GET' || req.method === 'HEAD';
    if (m[2]) {  // the same for every link: it says nothing about the board, or whether the link still works
      if (!get) { req.resume(); res.writeHead(405, { Allow: 'GET' }); res.end(); return true; }
      send(res, 200, note('Thanks', 'Your feedback was sent to the team.', `<p><a class="btn" href="/f/${esc(m[1])}">Send something else</a></p>`));
      return true;
    }
    if (!get && req.method !== 'POST') { req.resume(); res.writeHead(405, { Allow: 'GET, POST' }); res.end(); return true; }
    const link = q.linkByToken.get(m[1]);
    if (!link) { req.resume(); send(res, 404, gonePage()); return true; }
    if (req.method === 'POST') { await submit(req, res, link, ip); return true; }
    if (link.paused) send(res, 200, note('Feedback is paused', 'The team isn’t taking feedback here right now. Try again later.'));
    else send(res, 200, formPage(link));
    return true;
  }

  /* ---------- the in-game bug reporter: POST /api/report ---------- */
  // A JSON field that should be words: missing is empty, numbers are fine, anything else is a clear error.
  function words(b, name) {
    const v = b[name];
    if (v === undefined || v === null) return '';
    if (typeof v !== 'string' && typeof v !== 'number') fail(400, 'bad_field', `${name} must be text.`);
    return String(v);
  }
  route('POST', '/api/report', async ctx => {
    const h = String(ctx.req.headers.authorization || ''), raw = /^Bearer\s+/i.test(h) ? h.replace(/^Bearer\s+/i, '').trim() : '';
    if (!raw) fail(401, 'no_key', 'Send the project’s report key in a header: Authorization: Bearer vbr_…');
    const k = /^vbr_[\w-]{20,80}$/.test(raw) ? q.keyByHash.get(A.tokenHash(raw)) : null;
    if (!k) fail(401, 'bad_key', 'That report key doesn’t work. It may have been revoked or replaced: ask a team admin for the current one.');
    if (!limit('report-key:' + k.project_id, 10, MINUTE) || !limit('report-key-hour:' + k.project_id, 120, HOUR) || !limit('report-key-day:' + k.project_id, 1000, DAY)) {
      fail(429, 'rate', 'This game has sent a lot of reports just now. Wait a minute, then try again.');
    }
    if (!limit('report-ip:' + k.project_id + ':' + ctx.ip, 60, HOUR)) fail(429, 'rate', 'This player has sent a lot of reports this hour. Try again later.');
    if (Number(ctx.req.headers['content-length'] || 0) > REPORT_MAX) fail(413, 'too_large', 'A report can be up to 8 MB: a screenshot up to 5 MB, a log up to 65,536 characters and the text.');
    const b = await H.readJson(ctx.req, REPORT_MAX);
    if (Array.isArray(b)) fail(400, 'bad_json', 'Send one report as a JSON object.');
    const title = line(words(b, 'title'), 1000).slice(0, TITLE_MAX);
    if (!title) fail(400, 'title', 'title is missing: a short line saying what went wrong (up to 120 characters).');
    const description = para(words(b, 'description'), 20000).slice(0, DETAILS_MAX);
    const sevIn = line(words(b, 'severity'), 40).toLowerCase(), sev = !sevIn ? 'major' : Object.hasOwn(SEVERITY, sevIn) ? SEVERITY[sevIn] : '';
    if (!sev) fail(400, 'severity', 'severity is one of crash, major, minor or polish.');
    const version = line(words(b, 'version'), BUILD_MAX), platform = line(words(b, 'platform'), BUILD_MAX), name = nameOf(words(b, 'reporter'));
    const logIn = words(b, 'log');
    if (logIn.length > LOG_MAX) fail(413, 'log_too_big', `log can be up to ${LOG_MAX.toLocaleString('en-GB')} characters. Send the end of your log file.`);
    let shot = null;
    if (b.screenshot !== undefined && b.screenshot !== null && b.screenshot !== '') {
      if (typeof b.screenshot !== 'string') fail(400, 'screenshot', 'screenshot must be base64 text.');
      const b64 = b.screenshot.replace(/^data:image\/[\w.+-]+;base64,/i, '').replace(/\s+/g, '');
      if (b64.length > Math.ceil(SHOT_MAX / 3) * 4 + 4) fail(413, 'screenshot_too_big', 'screenshot can be up to 5 MB.');
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) && !/^[A-Za-z0-9_-]*={0,2}$/.test(b64)) fail(400, 'screenshot', 'screenshot isn’t valid base64.');
      shot = screenshot(Buffer.from(b64, 'base64'), 'screenshot');
    }
    const p = { id: k.project_id, team_id: k.team_id }, who = reporter(p, name), now = Date.now(), key = titleKey(title);
    // the same bug again within a day: a comment on its card, not another card
    const seen = key ? q.seen.get(p.id, key) : null, doc = live().currentDoc(p.id);
    if (seen && now - seen.last_at < DAY && doc && doc.items.some(i => i.id === seen.card_id && i.type === 'node')) {
      const said = [version && `version ${version}`, platform && `platform ${platform}`, name && `from ${name}`].filter(Boolean).join(', ');
      const text = (`Reported again${said ? ': ' + said : ''}.` + (description ? '\n' + description.slice(0, 1500) : '')).replace(/@/g, '＠');  // never a mention
      const commented = seen.comments < REPEAT_COMMENTS && addComment(p, who, seen.card_id, text);
      q.again.run(now, commented ? 1 : 0, p.id, key);
      q.usedKey.run(now, p.id);
      live().sharingChanged(p.id);
      return { ok: true, status: 'repeat', reports: seen.count + 1 };
    }
    const meta = [version && `Version: ${version}`, platform && `Platform: ${platform}`, `From: ${name || 'the in-game bug reporter'}`, `Reported: ${when(now)}`].filter(Boolean).join('\n');
    let body = (description ? description + '\n\n' : '') + meta;
    const logText = para(logIn, LOG_MAX);
    if (logText) {  // the log goes at the end, cut from the front to fit (its last lines matter most)
      let tail = logText.split('\n').slice(-LOG_LINES).join('\n');
      if (tail.length > LOG_CHARS) { tail = tail.slice(-LOG_CHARS); const nl = tail.indexOf('\n'); if (nl >= 0 && nl < 300) tail = tail.slice(nl + 1); }
      const n = tail.split('\n').length;
      body += tail.length < logText.length ? `\n\nLog (the last ${n === 1 ? 'line' : n + ' lines'}):\n…\n${tail}` : `\n\nLog:\n${tail}`;
    }
    const card = addCard(p, who, BUGS, { kind: 'bug', sev, color: '#ff7a1a', disc: 'qa', title, body: body.slice(0, NOTES_MAX) }, shot, ctx.ip);
    if (key) { q.forgetSeen.run(now - DAY); q.setSeen.run(p.id, key, card.id, now); }
    q.usedKey.run(now, p.id);
    live().sharingChanged(p.id);
    return { ok: true, status: 'created' };
  }, { auth: false });

  return { page };
}

module.exports = { intake, parseMultipart };
