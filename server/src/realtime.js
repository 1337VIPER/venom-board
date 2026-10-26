// Live project rooms over WebSocket (/ws).
//
// The server is the single source of truth. Clients send batches of object-level operations
// (put / del / order); the server validates them, applies them in arrival order, acknowledges
// the sender and relays them to everyone else in the room. Last write wins per object.
// Previews (drag positions, typing) and presence (cursors, selections, views) are relayed, never stored.
// Anyone holding a project's share link can watch it live, read-only and without being seen.
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { cleanDoc, cleanOp, okId, COLLECTIONS, MAX_OBJECTS, REACTIONS, LOG_MAX } = require('./sanitize');
const { sessionCookie, clientIp } = require('./http');

const RANK = { viewer: 1, editor: 2, admin: 3, leader: 4 };
const PRESENT_GAP_MS = 10000;
const MAX_CLIENTS_PER_ROOM = 64;
const MAX_WATCHERS_PER_ROOM = 200;  // people watching through a share link
const MAX_WATCHERS_PER_IP = 10;
// fields newer apps added to pictures, videos and frames: an edit without one comes from an app that doesn't know it (see allowedOp)
const KEEP = { image: ['tags', 'note', 'source'], video: ['tags', 'note', 'source'], frame: ['mood'] };

// hooks (all optional), supplied by the API:
//   members(teamId)                  -> [{id, name, username, color, role}] shown with the board
//   linkProject(token)               -> projectId the share link opens, or null
//   changed(room, user, changes)     -> called after a batch is applied; changes are {k, op, obj, old}
//   flushed(room)                    -> called after a room is saved
//   commentAllowed(user)             -> false when someone is posting comments too fast
//   beforeEdit(room)                 -> called before a batch changes the board (automatic versions)
//   projectRole(projectId, teamId, userId, teamRole) -> their role in that project (a team admin may set one per project)
function realtime({ server, db, sessions, cfg, log, hooks = {} }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  const perIp = new Map();  // open connections from each address: a few dozen is a studio, hundreds is someone else
  const IP_MAX = 64;
  const rooms = new Map();
  const sockets = new Set();
  const q = {
    project: db.prepare('SELECT id, team_id, name, doc, version FROM projects WHERE id = ?'),
    role: db.prepare('SELECT role FROM members WHERE team_id = ? AND user_id = ?'),
    save: db.prepare('UPDATE projects SET doc = ?, version = ?, updated_at = ?, updated_by = ?, doc_bytes = ? WHERE id = ?'),
  };
  const SAN = { assetBase: cfg.PUBLIC_URL + '/assets/' };
  const publicUser = u => ({ id: u.id, username: u.username, displayName: u.displayName, color: u.color });
  const send = (ws, msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); };
  // members get everything; share-link watchers only see the board change, never who is looking at it
  const broadcast = (room, msg, except, watchers = false) => {
    const s = JSON.stringify(msg);
    for (const c of room.clients) if (c !== except && c.readyState === 1) c.send(s);
    if (watchers) for (const c of room.watchers) if (c.readyState === 1) c.send(s);
  };
  const peerInfo = ws => ({ ...ws.presence, cid: ws.cid, uid: ws.user.id, name: ws.user.displayName, username: ws.user.username, color: ws.user.color, role: ws.role });
  const members = teamId => (hooks.members ? hooks.members(teamId) : []);

  /* ---------- rooms ---------- */
  function reindex(room, k) { const m = new Map(); room.doc[k].forEach((o, i) => m.set(o.id, i)); room.index[k] = m; }
  function measureRoom(room) {
    room.sizes = new Map(); room.bytes = 0;
    for (const k of COLLECTIONS) {
      reindex(room, k);
      for (const o of room.doc[k]) { const n = JSON.stringify(o).length; room.sizes.set(k + ':' + o.id, n); room.bytes += n; }
    }
  }
  function loadRoom(id) {
    let room = rooms.get(id);
    if (room) { clearTimeout(room.unloadT); return room; }
    const p = q.project.get(id);
    if (!p) return null;
    let doc;
    try { doc = cleanDoc(JSON.parse(p.doc), SAN); } catch (e) { doc = cleanDoc({}, SAN); }
    room = { id, teamId: p.team_id, name: p.name, doc, index: {}, holes: new Set(), version: p.version, clients: new Set(), watchers: new Set(), dirty: false, lastBy: null, unloadT: null };
    measureRoom(room);
    rooms.set(id, room);
    return room;
  }
  // closes the gaps deletes leave, once per batch instead of once per delete
  function compact(room, k) {
    if (!room.holes.has(k)) return;
    room.holes.delete(k);
    room.doc[k] = room.doc[k].filter(Boolean);
    reindex(room, k);
  }
  const getObj = (room, k, id) => { const i = room.index[k].get(id); return i === undefined ? null : room.doc[k][i]; };
  // A project's board has a size limit (images aren't counted), and it also counts toward its team's storage,
  // so nobody can grow boards until the server struggles. Changes that would go past either are refused;
  // making things smaller always works.
  const maxBytes = cfg.PROJECT_MAX_MB * 1048576;
  function applyOp(room, op, budget) {
    const arr = room.doc[op.k], index = room.index[op.k];
    if (op.op === 'put') {
      const key = op.k + ':' + op.obj.id, size = JSON.stringify(op.obj).length, old = room.sizes.get(key) || 0;
      if (size > old && room.bytes - old + size > maxBytes) return 'full';
      if (size > old && budget && size - old > budget.left) return 'quota';
      if (size > old && budget) budget.left -= size - old;
      const i = index.get(op.obj.id);
      if (i !== undefined) arr[i] = op.obj;
      else { if (arr.length >= MAX_OBJECTS) return false; index.set(op.obj.id, arr.length); arr.push(op.obj); }
      room.sizes.set(key, size); room.bytes += size - old;
      return true;
    }
    if (op.op === 'del') {
      const i = index.get(op.id);
      if (i === undefined) return false;
      room.bytes -= room.sizes.get(op.k + ':' + op.id) || 0; room.sizes.delete(op.k + ':' + op.id);
      arr[i] = null; index.delete(op.id); room.holes.add(op.k);  // closed up by compact() at the end of the batch
      return true;
    }
    if (op.op === 'order') {
      compact(room, op.k);
      const cur = room.doc[op.k], pos = new Map(op.ids.map((id, i) => [id, i]));
      const listed = cur.filter(o => pos.has(o.id)).sort((a, b) => pos.get(a.id) - pos.get(b.id));
      room.doc[op.k] = listed.concat(cur.filter(o => !pos.has(o.id)));
      reindex(room, op.k);
      return true;
    }
    return false;
  }
  function flush(room) {
    if (!room.dirty) return;
    for (const k of [...room.holes]) compact(room, k);
    room.dirty = false;
    const json = JSON.stringify(room.doc);
    q.save.run(json, room.version, Date.now(), room.lastBy, Buffer.byteLength(json), room.id);
    if (hooks.flushed) try { hooks.flushed(room); } catch (e) { log('[flushed]', e.stack); }
  }
  function maybeUnload(room) {
    if (room.clients.size || room.watchers.size) return;
    flush(room);
    clearTimeout(room.unloadT);
    room.unloadT = setTimeout(() => { if (!room.clients.size && !room.watchers.size) { flush(room); rooms.delete(room.id); } }, 60000);
    room.unloadT.unref();
  }
  const flushTimer = setInterval(() => { for (const r of rooms.values()) flush(r); }, 2000);
  flushTimer.unref();

  /* ---------- connections ---------- */
  server.on('upgrade', (req, socket, head) => {
    // nothing a client sends here may throw: this runs outside any request handler, so an error would stop the server
    let pathname = '';
    try { pathname = new URL(req.url, 'http://x').pathname; } catch (e) { /* not a valid address */ }
    if (pathname !== '/ws') { socket.destroy(); return; }
    try {
      wss.handleUpgrade(req, socket, head, ws => {
        try {
          ws.ip = clientIp(req, cfg.TRUST_PROXY);
          // the website's own pages may use their session cookie; the apps authenticate with a token message
          const token = sessionCookie(req), origin = req.headers.origin;
          if (token && origin === cfg.PUBLIC_ORIGIN) { ws.user = sessions.user(token); if (ws.user) ws.token = token; }
        } catch (e) { log('[ws upgrade]', e.message); ws.terminate(); return; }
        wss.emit('connection', ws, req);
      });
    } catch (e) { log('[ws upgrade]', e.message); socket.destroy(); }
  });

  wss.on('connection', ws => {
    if ((perIp.get(ws.ip) || 0) >= IP_MAX) { ws.close(1013, 'busy'); return; }
    perIp.set(ws.ip, (perIp.get(ws.ip) || 0) + 1);
    sockets.add(ws);
    ws.cid = crypto.randomBytes(6).toString('base64url');
    ws.alive = true; ws.presence = {}; ws.tokens = 240; ws.refill = Date.now();
    ws.on('pong', () => { ws.alive = true; });
    const authTimer = setTimeout(() => { if (!ws.user && !ws.watching) ws.close(4001, 'auth'); }, 10000);
    if (ws.user) send(ws, { t: 'ready', user: publicUser(ws.user) });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      // signing in or watching takes a few bytes: anything big before that isn't from the app
      if (!ws.user && !ws.watching && data.length > 16384) { ws.terminate(); return; }
      if (!allow(ws, data.length)) return;
      let msg;
      try { msg = JSON.parse(data); } catch (e) { return; }
      if (!msg || typeof msg !== 'object') return;
      try { handle(ws, msg); } catch (e) { log('[ws]', e.stack); send(ws, { t: 'error', code: 'server', message: 'Something went wrong on the server.' }); }
    });
    ws.on('close', () => { clearTimeout(authTimer); sockets.delete(ws); leaveRoom(ws); const n = (perIp.get(ws.ip) || 1) - 1; if (n > 0) perIp.set(ws.ip, n); else perIp.delete(ws.ip); });
  });
  const pingTimer = setInterval(() => {
    for (const ws of sockets) {
      if (!ws.alive) { ws.terminate(); continue; }
      // a session that was signed out, reset or expired doesn't keep its live connection
      if (ws.token && !sessions.user(ws.token)) { signOutSocket(ws); continue; }
      ws.alive = false; ws.ping();
    }
  }, 30000);
  pingTimer.unref();
  function signOutSocket(ws) {
    send(ws, { t: 'error', code: 'auth', message: 'You were signed out. Sign in again to keep working.' });
    leaveRoom(ws);
    ws.close(4001, 'auth');
  }

  // token bucket: bursts are fine, a flood is dropped. A message costs more the bigger it is (a 4 MB one about 129),
  // so big edits still go through but can't be sent over and over
  function allow(ws, bytes = 0) {
    const now = Date.now(), cost = 1 + bytes / 32768;
    ws.tokens = Math.min(240, ws.tokens + (now - ws.refill) * 0.08);
    ws.refill = now;
    if (ws.tokens < cost) return false;
    ws.tokens -= cost;
    return true;
  }

  function handle(ws, msg) {
    if (msg.t === 'auth') {
      if (ws.watching) return;  // a share-link watcher stays a watcher
      if (!ws.user) {
        const token = typeof msg.token === 'string' ? msg.token : '';
        ws.user = sessions.user(token);
        if (ws.user) ws.token = token;
      }
      if (!ws.user) { send(ws, { t: 'error', code: 'auth', message: 'Your session has expired. Sign in again.' }); ws.close(4001, 'auth'); return; }
      send(ws, { t: 'ready', user: publicUser(ws.user) });
      return;
    }
    if (msg.t === 'watch') { watch(ws, msg.token); return; }
    if (!ws.user) { if (!ws.watching) send(ws, { t: 'error', code: 'auth', message: 'Sign in first.' }); return; }
    switch (msg.t) {
      case 'join': join(ws, msg.project, msg.takeover === true); break;
      case 'resync': if (ws.room) sendSnapshot(ws); break;
      case 'ops': applyBatch(ws, msg); break;
      case 'preview': preview(ws, msg); break;
      case 'presence': presence(ws, msg); break;
      case 'leave': leaveRoom(ws); break;
    }
  }

  function join(ws, projectId, takeover = false) {
    leaveRoom(ws);
    const room = okId(projectId) ? loadRoom(projectId) : null;
    if (!room) { send(ws, { t: 'error', code: 'not_found', message: 'That project no longer exists.' }); return; }
    const m = q.role.get(room.teamId, ws.user.id);
    if (!m) { maybeUnload(room); send(ws, { t: 'error', code: 'forbidden', message: "You're not a member of this project's team." }); return; }
    // One session per account on a board, so one account signed in on two computers (or shared) can't work on the
    // same board from both. Opening it again elsewhere is refused unless that session asks to take it over; then
    // the other one is sent back to its own boards. Tabs of one signed-in browser are the same session.
    const others = [...room.clients].filter(c => c.user.id === ws.user.id && c.token !== ws.token);
    if (others.length && !takeover) {
      maybeUnload(room);
      send(ws, { t: 'error', code: 'forbidden', elsewhere: true, name: room.name, message: 'This board is open in another session of your account. Only one session at a time can work on a board.' });
      return;
    }
    for (const c of others) {
      send(c, { t: 'kicked', elsewhere: true, name: room.name, message: 'This board was opened in another session of your account, so it closed here. Only one session at a time can work on a board.' });
      leaveRoom(c);
    }
    if (room.clients.size >= MAX_CLIENTS_PER_ROOM) { maybeUnload(room); send(ws, { t: 'error', code: 'full', message: 'This project has too many people in it right now.' }); return; }
    ws.role = roleIn(room, ws.user.id, m.role); ws.room = room; ws.presence = {};
    room.clients.add(ws);
    sendSnapshot(ws);
    broadcast(room, { t: 'peer', peer: peerInfo(ws) }, ws);
  }
  // a share link: read-only, anonymous, and not shown to the people working on the board
  function watch(ws, token) {
    if (ws.user || ws.room) return;
    const projectId = typeof token === 'string' && hooks.linkProject ? hooks.linkProject(token) : null;
    const room = projectId ? loadRoom(projectId) : null;
    if (!room) { send(ws, { t: 'error', code: 'link', message: 'This link no longer works. Ask whoever sent it for a new one.' }); ws.close(4004, 'link'); return; }
    const fromIp = [...sockets].filter(s => s.watching && s.ip === ws.ip).length;
    if (room.watchers.size >= MAX_WATCHERS_PER_ROOM || fromIp >= MAX_WATCHERS_PER_IP) {
      maybeUnload(room); send(ws, { t: 'error', code: 'full', message: 'Too many people are watching this board right now. Try again later.' }); ws.close(4005, 'full'); return;
    }
    ws.watching = true; ws.room = room; ws.role = 'link';
    room.watchers.add(ws);
    sendSnapshot(ws);
  }
  function sendSnapshot(ws) {
    const r = ws.room;
    for (const k of [...r.holes]) compact(r, k);
    send(ws, { t: 'snapshot', project: { id: r.id, name: r.name, teamId: ws.watching ? '' : r.teamId }, role: ws.role, doc: r.doc, version: r.version,
      peers: ws.watching ? [] : [...r.clients].filter(c => c !== ws).map(peerInfo),
      members: members(r.teamId).map(m => (ws.watching ? { id: m.id, name: m.name, color: m.color } : m)) });
  }
  function leaveRoom(ws) {
    const room = ws.room;
    if (!room) return;
    ws.room = null;
    room.watchers.delete(ws);
    if (ws.watching) { room.clients.delete(ws); maybeUnload(room); return; }
    room.clients.delete(ws);
    broadcast(room, { t: 'peer-leave', cid: ws.cid });
    maybeUnload(room);
  }

  // Comments belong to whoever wrote them: only they can edit them, and they or a team admin can delete them.
  // Viewers can comment too (that's how reviewers and playtesters give feedback), but change nothing else.
  // Threads: anyone who can comment can reply and add or remove their own reactions on any comment; a thread's
  // first comment can be resolved or reopened by its author or a team admin. See commentPut.
  function allowedOp(ws, room, op, now) {
    const editor = RANK[ws.role] >= RANK.editor;
    if (op.k === 'items' && op.op === 'put' && editor && op.obj.type === 'node') {
      const old = getObj(room, 'items', op.obj.id), was = old && old.type === 'node' ? old : null, obj = { ...op.obj };
      let echo = false;
      // fields newer apps added: an edit without one comes from an app that doesn't know it, so the stored one stays
      if (obj.start === undefined && was && was.start) obj.start = was.start;
      for (const f of ['log', 'plan']) {
        if (!Array.isArray(obj[f])) { if (was && was[f] && was[f].length) obj[f] = was[f]; continue; }
        const { log, unseen } = mergeLog(was ? was[f] : null, obj[f], ws.user.id);
        if (JSON.stringify(obj[f]) !== JSON.stringify(log)) echo = true;  // the sender gets the stored card back (see `echoes`)
        if (log.length) obj[f] = log; else delete obj[f];
        if (f === 'log' && unseen) obj.spent = Math.min(1000000, (obj.spent || 0) + unseen);  // a teammate's time logged while this edit was on its way
      }
      return { ...op, obj, echo };
    }
    // the same for a picture's or video's tags, note and source, and a frame being a mood board collection: an older app
    // can move or resize a picture without wiping its tags, and can't turn a collection back into a phase
    const keep = op.k === 'items' && op.op === 'put' && editor ? KEEP[op.obj.type] : null;
    if (keep) {
      const old = getObj(room, 'items', op.obj.id), was = old && old.type === op.obj.type ? old : null, obj = { ...op.obj };
      for (const f of keep) if (obj[f] === undefined && was && was[f] !== undefined) obj[f] = was[f];
      return { ...op, obj };
    }
    if (op.k !== 'comments') return editor ? op : null;
    if (op.op === 'order') return null;
    const old = getObj(room, 'comments', op.op === 'put' ? op.obj.id : op.id);
    if (op.op === 'del') return old && (old.by === ws.user.id || RANK[ws.role] >= RANK.admin) ? op : null;
    if (!old && hooks.commentAllowed && !ws.user.bot && !hooks.commentAllowed(ws.user)) return 'rate';  // integrations have their own limits
    const obj = commentPut(ws, room, old, op.obj, now);
    return obj ? { ...op, obj } : null;
  }

  /* ---------- time logs and planned time: people add and remove only their own entries ---------- */
  // A card's time log (or its planned time) as stored after someone's edit: every entry already there stays as it was, unless it's the
  // editor's own and they changed or removed it. Nobody removes someone else's time, admins included, because an
  // edit made from a copy that hadn't seen an entry yet looks just like a removal. New entries count only as the
  // editor's own, so nobody can log time as someone else.
  // `unseen` is the minutes of other people's entries the edit didn't have (logged while it was on its way), which the
  // card's total then needs too.
  function mergeLog(stored, sent, me) {
    const before = Array.isArray(stored) ? stored : [], now = new Map((Array.isArray(sent) ? sent : []).map(e => [e.id, e]));
    const out = [];
    let unseen = 0;
    for (const e of before) {
      const s = now.get(e.id);
      if (!s) { if (e.by !== me) { out.push(e); unseen += e.mins; } continue; }  // removed: only your own
      out.push(e.by === me ? { ...s, by: me } : e);
      now.delete(e.id);
    }
    for (const s of now.values()) { if (out.length >= LOG_MAX) break; out.push({ ...s, by: me }); }
    return { log: out.slice(-LOG_MAX), unseen };
  }

  /* ---------- comment threads: replies, reactions, resolving, feedback pins ---------- */
  // Everyone's reactions except your own always come from the stored comment, so nobody can react (or take a
  // reaction away) for someone else, and two people reacting at once never undo each other.
  function mergeReact(stored, sent, me) {
    const out = {};
    for (const e of REACTIONS) {
      // the stored order stays; only your own reaction is added at the end or taken out
      const before = (stored && stored[e]) || [], want = !!(sent && Array.isArray(sent[e]) && sent[e].includes(me));
      const who = want ? (before.includes(me) ? before.slice() : [...before, me]) : before.filter(id => id !== me);
      if (who.length) out[e] = who;
    }
    return Object.keys(out).length ? out : null;
  }
  const reactSig = r => REACTIONS.map(e => ((r && r[e]) || []).slice().sort().join(',')).join('|');
  const commentSig = c => JSON.stringify([c.card, c.text, c.re || '', c.pin || null, reactSig(c.react), !!c.resolved]);
  function setReact(obj, react) { if (react) obj.react = react; else delete obj.react; }
  // The stored version of a comment put: a new comment, or the changes this person is allowed to make to one.
  function commentPut(ws, room, old, sent, now) {
    const me = ws.user.id;
    if (!old) {
      // a new comment: the server says who wrote it and when; it can't arrive resolved or with other people's reactions
      const obj = { ...sent, by: me, at: now };
      delete obj.edited; delete obj.resolved; delete obj.resolvedBy;
      setReact(obj, mergeReact(null, sent.react, me));
      // a reply hangs off the first comment of a thread on the same card (one level deep)
      if (obj.re) {
        const parent = getObj(room, 'comments', obj.re), root = parent && parent.re ? getObj(room, 'comments', parent.re) : parent;
        if (root && !root.re && root.card === obj.card) obj.re = root.id; else delete obj.re;
      }
      // feedback pins are only on pictures, and only on a thread's first comment
      if (obj.re || (obj.pin && (getObj(room, 'items', obj.card) || {}).type !== 'image')) delete obj.pin;
      return obj;
    }
    // A change to a stored comment starts from what's stored: where it is, who wrote it and what it answers never change.
    const mine = old.by === me, obj = { ...old };
    // an edit to the words changes only the words (older apps don't know about reactions or resolving, and would
    // otherwise drop them); reacting and resolving are changes of their own
    if (mine && sent.text !== old.text) { obj.text = sent.text; obj.edited = now; }
    else {
      setReact(obj, mergeReact(old.react, sent.react, me));
      if (!!sent.resolved !== !!old.resolved && !old.re && (mine || RANK[ws.role] >= RANK.admin)) {
        if (sent.resolved) { obj.resolved = now; obj.resolvedBy = me; } else { delete obj.resolved; delete obj.resolvedBy; }
      }
    }
    // nothing they're allowed to change changed: their copy is wrong (someone else's text, someone else's thread), so
    // it's refused and they get the stored board again. Putting back exactly what's stored is harmless.
    if (commentSig(obj) === commentSig(old)) return commentSig(sent) === commentSig(old) ? obj : null;
    return obj;
  }
  function applyBatch(ws, msg) {
    const room = ws.room;
    if (!room || ws.watching) return null;
    // every batch is checked against the person's role in this project as it is right now
    if (!ws.server && !freshRole(ws)) return null;
    const cleaned = (Array.isArray(msg.ops) ? msg.ops.slice(0, 5000) : []).map(raw => cleanOp(raw, SAN)).filter(Boolean);
    // reordering a collection twice in one batch is the same as doing its last reorder, so only that one runs
    const lastOrder = new Map(); cleaned.forEach((o, i) => { if (o.op === 'order') lastOrder.set(o.k, i); });
    const ops = cleaned.filter((o, i) => o.op !== 'order' || lastOrder.get(o.k) === i);
    if (RANK[ws.role] < RANK.editor && ops.some(o => o.k !== 'comments')) {
      send(ws, { t: 'error', code: 'read_only', message: 'You have view-only access to this project.', batch: msg.batch });
      return { applied: 0, readOnly: true };
    }
    // the board as it was before this edit can become an automatic version (the API decides how often)
    if (hooks.beforeEdit && ops.some(o => o.k !== 'comments')) try { hooks.beforeEdit(room); } catch (e) { log('[beforeEdit]', e.stack); }
    const applied = [], changes = [], echoes = [], now = Date.now();
    const store = hooks.storage ? hooks.storage(room.teamId) : null, budget = store ? { left: store.left } : null;
    let full = false, refused = false, rate = false, quota = false;
    for (const raw of ops) {
      const op = allowedOp(ws, room, raw, now);
      if (op === 'rate') { rate = true; continue; }
      if (!op) { refused = true; continue; }
      const old = op.op === 'order' ? null : getObj(room, op.k, op.op === 'put' ? op.obj.id : op.id);
      const r = applyOp(room, op, budget);
      if (r === 'full') { full = true; continue; }
      if (r === 'quota') { quota = true; continue; }
      if (!r) continue;
      if (op.echo) echoes.push(op);
      delete op.echo;
      applied.push(op);
      changes.push({ k: op.k, op: op.op, obj: op.obj || null, old });
    }
    for (const k of [...room.holes]) compact(room, k);
    if (applied.length) {
      room.version++; room.dirty = true; room.lastBy = ws.user.id;
      broadcast(room, { t: 'ops', ops: applied, by: ws.cid, v: room.version }, ws, true);
      if (hooks.changed) try { hooks.changed(room, ws.user, changes); } catch (e) { log('[changed]', e.stack); }
    }
    send(ws, { t: 'ack', batch: msg.batch, v: room.version });
    // comments come back to their author too (after the ack, so they're applied), with the time the server gave them
    const own = [...applied.filter(o => o.k === 'comments' && o.op === 'put'), ...echoes];
    if (own.length) send(ws, { t: 'ops', ops: own, by: '', v: room.version });
    // the sender's copy has changes the server refused, so it fetches the saved state again
    if (full) send(ws, { t: 'error', code: 'too_big', message: `This project is full: boards can be up to ${cfg.PROJECT_MAX_MB} MB, not counting images. Delete things you don't need, or start a new project.` });
    else if (quota) send(ws, { t: 'error', code: 'too_big', message: `${store.why} Delete things you don't need, or old projects and versions, to make room.` });
    else if (rate) send(ws, { t: 'error', code: 'too_big', message: "You're commenting very fast. Wait a moment and try again." });
    else if (refused) sendSnapshot(ws);
    return { applied: applied.length, full, quota, rate, refused, version: room.version };
  }
  function preview(ws, msg) {
    const room = ws.room;
    if (!room || ws.watching || RANK[ws.role] < RANK.editor) return;
    // previews carry in-progress objects (drags, typing, ink being drawn) or remove one that was cancelled
    const ops = (Array.isArray(msg.ops) ? msg.ops.slice(0, 2000) : []).map(o => cleanOp(o, SAN)).filter(o => o && o.k !== 'comments' && (o.op === 'put' || o.op === 'del'));
    if (ops.length) broadcast(room, { t: 'preview', ops, by: ws.cid }, ws);
  }
  const fin = (v, max = 1e7) => Number.isFinite(v) && Math.abs(v) < max;
  function presence(ws, msg) {
    const room = ws.room;
    if (!room || ws.watching) return;
    const p = ws.presence;
    if (Number.isFinite(msg.x) && Number.isFinite(msg.y)) { p.x = Math.round(msg.x * 10) / 10; p.y = Math.round(msg.y * 10) / 10; }
    else if (msg.x === null && msg.y === null) { delete p.x; delete p.y; }  // their pointer left the window
    if (Array.isArray(msg.sel)) p.sel = msg.sel.filter(okId).slice(0, 200);
    if (msg.editing === null || okId(msg.editing)) p.editing = msg.editing || null;
    // the part of the board they're looking at, so others can follow them
    const v = msg.view;
    if (v && typeof v === 'object' && fin(v.x) && fin(v.y) && fin(v.w) && fin(v.h) && v.w > 0 && v.h > 0) p.view = { x: Math.round(v.x), y: Math.round(v.y), w: Math.round(v.w), h: Math.round(v.h) };
    else if (v === null) delete p.view;
    // presenting moves everyone's view, so it takes an editor or above, and can't be restarted over and over
    if (msg.presenting === true && !p.presenting && RANK[ws.role] >= RANK.editor && Date.now() - (ws.presentedAt || 0) > PRESENT_GAP_MS) { p.presenting = true; ws.presentedAt = Date.now(); }
    else if (msg.presenting === false) delete p.presenting;
    broadcast(room, { t: 'presence', peer: peerInfo(ws) }, ws);
  }

  /* ---------- per-project roles ---------- */
  // someone's role in a room's project: their team role, unless a team admin gave them another one there
  const roleIn = (room, userId, teamRole) => (hooks.projectRole ? hooks.projectRole(room.id, room.teamId, userId, teamRole) : teamRole);
  // looks a connection's role up again, so a change counts from the very next batch; false if they left the team
  function freshRole(ws, scope) {
    const m = q.role.get(ws.room.teamId, ws.user.id);
    if (!m) { send(ws, { t: 'kicked', message: 'You were removed from this team.' }); leaveRoom(ws); return false; }
    const role = roleIn(ws.room, ws.user.id, m.role);
    if (role !== ws.role) changeRole(ws, role, scope !== undefined ? scope : role === m.role ? '' : 'project');
    return true;
  }
  function changeRole(ws, role, scope) {
    ws.role = role;
    if (RANK[role] < RANK.editor) delete ws.presence.presenting;
    send(ws, { t: 'role', role, ...(scope ? { scope } : {}) }); broadcast(ws.room, { t: 'peer', peer: peerInfo(ws) }, ws);
  }

  /* ---------- hooks for the REST API ---------- */
  const userSockets = (teamId, userId) => [...sockets].filter(ws => ws.user && ws.user.id === userId && ws.room && ws.room.teamId === teamId);
  const teamRooms = teamId => [...rooms.values()].filter(r => r.teamId === teamId);
  return {
    roomState(projectId) { const r = rooms.get(projectId); return r ? { doc: r.doc, version: r.version } : null; },
    // someone's account has this board open in a session other than this one (see join)
    heldElsewhere(projectId, userId, token) { const r = rooms.get(projectId); return !!r && [...r.clients].some(c => c.user.id === userId && c.token !== token); },
    // changes the server makes for someone (their MCP tools): checked, applied and shared like their own live edits
    serverBatch(projectId, user, role, ops) {
      const room = loadRoom(projectId);
      if (!room) return null;
      const ws = { user: { id: user.id, username: user.username, displayName: user.displayName, color: user.color, ...(user.bot ? { bot: true } : {}) }, role, room, presence: {}, cid: 'mcp-' + crypto.randomBytes(4).toString('hex'), server: true };
      if (user.guest) ws.user.guest = true;  // a player sending feedback or a bug report: named in the activity feed by what they gave
      const out = applyBatch(ws, { ops, batch: 0 });
      maybeUnload(room);
      return out;
    },
    // the board as it is now, whether or not anyone has it open
    currentDoc(projectId) {
      const r = rooms.get(projectId);
      if (r) return r.doc;
      const p = q.project.get(projectId);
      try { return p ? cleanDoc(JSON.parse(p.doc), SAN) : null; } catch (e) { return cleanDoc({}, SAN); }
    },
    // put an earlier version back for everyone; their open copies are replaced with it
    restore(projectId, doc, userId, byName) {
      const room = loadRoom(projectId);
      if (!room) return false;
      room.doc = cleanDoc(doc, SAN); room.holes.clear();
      measureRoom(room);
      room.version++; room.dirty = true; room.lastBy = userId;
      broadcast(room, { t: 'restored', by: byName }, null, true);
      for (const ws of [...room.clients, ...room.watchers]) sendSnapshot(ws);
      flush(room);
      maybeUnload(room);
      return true;
    },
    setRole(teamId, userId, role) {
      for (const ws of userSockets(teamId, userId)) {
        // their role in this project, which may be their own there (then it only changes if that does)
        const now = roleIn(ws.room, userId, role);
        if (now === role || now !== ws.role) changeRole(ws, now, now === role ? '' : 'project');
      }
    },
    // a team admin gave someone their own role in a project, or took it away: their open copies change straight away
    projectRoleChanged(projectId, userId) {
      const r = rooms.get(projectId);
      if (!r) return;
      for (const ws of [...r.clients]) if (ws.user.id === userId) freshRole(ws, 'project');
    },
    removeMember(teamId, userId) {
      for (const ws of userSockets(teamId, userId)) { send(ws, { t: 'kicked', message: 'You were removed from this team.' }); leaveRoom(ws); }
    },
    // who's in the team changed (or someone renamed themselves): open boards update their member lists
    membersChanged(teamId) {
      const list = members(teamId);
      for (const r of teamRooms(teamId)) {
        broadcast(r, { t: 'members', members: list });
        const pub = JSON.stringify({ t: 'members', members: list.map(m => ({ id: m.id, name: m.name, color: m.color })) });
        for (const w of r.watchers) if (w.readyState === 1) w.send(pub);
      }
    },
    renamed(projectId, name) { const r = rooms.get(projectId); if (r) { r.name = name; broadcast(r, { t: 'renamed', name }, null, true); } },
    deleted(projectId) {
      const r = rooms.get(projectId);
      if (!r) return;
      r.dirty = false;
      for (const ws of [...r.clients, ...r.watchers]) { send(ws, { t: 'deleted', message: 'This project was deleted.' }); r.clients.delete(ws); r.watchers.delete(ws); ws.room = null; }
      clearTimeout(r.unloadT);
      rooms.delete(projectId);
    },
    // a share link was turned off or replaced: whoever was watching through it stops
    linkRevoked(projectId) {
      const r = rooms.get(projectId);
      if (!r) return;
      for (const ws of [...r.watchers]) { send(ws, { t: 'error', code: 'link', message: 'This link was turned off.' }); r.watchers.delete(ws); ws.room = null; ws.close(4004, 'link'); }
      maybeUnload(r);
    },
    activity(projectId, entry) { const r = rooms.get(projectId); if (r) broadcast(r, { t: 'activity', entry }); },
    notify(userId, n) { for (const ws of sockets) if (ws.user && ws.user.id === userId) send(ws, { t: 'notify', n }); },
    // The Team panel keeps up without a restart: everyone in a team who's connected, in a project or not, hears that
    // its projects, people or invites changed and fetches it again. `also` reaches people who just left it.
    teamChanged(teamId, also = []) {
      const ids = new Set([...members(teamId).map(m => m.id), ...also]);
      for (const ws of sockets) if (ws.user && ids.has(ws.user.id)) send(ws, { t: 'team', id: teamId });
    },
    // someone's own invitations changed: one arrived or was withdrawn
    invitesChanged(userId) { for (const ws of sockets) if (ws.user && ws.user.id === userId) send(ws, { t: 'invites' }); },
    // a project's view-only link or public roadmap was made, changed or taken down: everyone in it sees the new state
    sharingChanged(projectId) { const r = rooms.get(projectId); if (r) broadcast(r, { t: 'shared' }); },
    // a new display name or colour shows on everyone's screen without reconnecting
    profileChanged(userId, profile) {
      const teams = new Set();
      for (const ws of sockets) if (ws.user && ws.user.id === userId) {
        Object.assign(ws.user, profile);
        if (ws.room) { broadcast(ws.room, { t: 'peer', peer: peerInfo(ws) }, ws); teams.add(ws.room.teamId); }
      }
      return teams;
    },
    // sign-out, password changes and resets end the matching live connections straight away
    signedOut(token) { for (const ws of [...sockets]) if (ws.token && ws.token === token) signOutSocket(ws); },
    userSignedOut(userId, keepToken) {
      for (const ws of [...sockets]) if (ws.user && ws.user.id === userId && ws.token !== keepToken) signOutSocket(ws);
    },
    stats() { return { rooms: rooms.size, sockets: sockets.size, watchers: [...rooms.values()].reduce((a, r) => a + r.watchers.size, 0) }; },
    // the accounts with the app open right now, in a project or not
    onlineUsers() { const ids = new Set(); for (const ws of sockets) if (ws.user) ids.add(ws.user.id); return ids; },
    close() {
      clearInterval(flushTimer); clearInterval(pingTimer);
      for (const r of rooms.values()) flush(r);
      for (const ws of sockets) ws.terminate();
      wss.close();
    },
  };
}

module.exports = { realtime, RANK };
