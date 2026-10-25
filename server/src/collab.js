// Team features built on shared projects: who's on a board, comments and @mentions, notifications, the activity
// feed, Discord and Slack, version history, share links, search across projects and due-date reminders.
// Every feature that sends something somewhere (email, Discord) or stores something (versions, reports) has its
// own limits, so none of them can be used to flood people or fill the server.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { cleanDoc, okId, txt } = require('./sanitize');
const R = require('./roadmap');

const DISCORD_EVENTS = ['done', 'milestone', 'comment', 'restore', 'joined'];
const DISCORD_DEFAULT = ['done', 'milestone', 'restore', 'joined'];
const DISCORD_URL = /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api\/webhooks\/\d{5,30}\/[\w-]{20,200}$/;
const COALESCE = ['created', 'done', 'deleted', 'comment'];  // repeated by the same person within minutes: one line
const SLACK_URL = /^https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]{6,20}\/B[A-Z0-9]{6,20}\/[A-Za-z0-9]{16,64}$/;
const { BOTS } = require('./gitlink');  // GitHub and GitLab, as they appear in the activity feed

function collab(app) {
  const { db, cfg, log, route, fail, H, A, limit, needRole, needProject, plain, mail, getLive, diskOk, storage, secret } = app;
  const DAY = 86400000, HOUR = 3600000;
  const q = {
    members: db.prepare(`SELECT u.id, u.username, u.display_name, u.color, m.role FROM members m JOIN users u ON u.id = m.user_id
      WHERE m.team_id = ? ORDER BY u.display_name COLLATE NOCASE`),
    memberByUsername: db.prepare(`SELECT u.* FROM members m JOIN users u ON u.id = m.user_id WHERE m.team_id = ? AND u.username = ? COLLATE NOCASE`),
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    team: db.prepare('SELECT * FROM teams WHERE id = ?'),
    addNote: db.prepare('INSERT INTO notifications (id, user_id, kind, project_id, card_id, from_id, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    notes: db.prepare(`SELECT n.*, p.name AS project_name, u.display_name AS from_name, u.username AS from_username, u.color AS from_color FROM notifications n
      LEFT JOIN projects p ON p.id = n.project_id LEFT JOIN users u ON u.id = n.from_id WHERE n.user_id = ? ORDER BY n.created_at DESC LIMIT 50`),
    unread: db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read = 0'),
    readNote: db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ? AND id = ?'),
    readAll: db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ?'),
    trimNotes: db.prepare('DELETE FROM notifications WHERE user_id = ? AND id NOT IN (SELECT id FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 200)'),
    lastActivity: db.prepare('SELECT * FROM activity WHERE project_id = ? ORDER BY id DESC LIMIT 1'),
    addActivity: db.prepare('INSERT INTO activity (project_id, user_id, kind, text, card_id, count, at, by_name) VALUES (?, ?, ?, ?, ?, 1, ?, ?)'),
    bumpActivity: db.prepare('UPDATE activity SET count = count + 1, text = ?, card_id = ?, at = ? WHERE id = ?'),
    activityById: db.prepare('SELECT a.*, u.display_name AS name, u.username, u.color FROM activity a LEFT JOIN users u ON u.id = a.user_id WHERE a.id = ?'),
    activity: db.prepare(`SELECT a.*, u.display_name AS name, u.username, u.color FROM activity a LEFT JOIN users u ON u.id = a.user_id
      WHERE a.project_id = ? AND a.id < ? ORDER BY a.id DESC LIMIT 50`),
    trimActivity: db.prepare('DELETE FROM activity WHERE project_id = ? AND id NOT IN (SELECT id FROM activity WHERE project_id = ? ORDER BY id DESC LIMIT 500)'),
    addVersion: db.prepare('INSERT INTO versions (id, project_id, created_at, created_by, label, auto, size, doc) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    lastAuto: db.prepare('SELECT created_at FROM versions WHERE project_id = ? AND auto = 1 ORDER BY created_at DESC LIMIT 1'),
    autoVersions: db.prepare('SELECT id, created_at FROM versions WHERE project_id = ? AND auto = 1 ORDER BY created_at DESC'),
    namedCount: db.prepare('SELECT COUNT(*) AS n FROM versions WHERE project_id = ? AND auto = 0'),
    versions: db.prepare(`SELECT v.id, v.created_at, v.label, v.auto, v.size, u.display_name AS by_name FROM versions v LEFT JOIN users u ON u.id = v.created_by
      WHERE v.project_id = ? ORDER BY v.created_at DESC`),
    version: db.prepare('SELECT * FROM versions WHERE id = ? AND project_id = ?'),
    delVersion: db.prepare('DELETE FROM versions WHERE id = ?'),
    linkFor: db.prepare('SELECT * FROM share_links WHERE project_id = ?'),
    linkByToken: db.prepare('SELECT * FROM share_links WHERE token = ?'),
    setLink: db.prepare(`INSERT INTO share_links (project_id, token, created_by, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET token = excluded.token, created_by = excluded.created_by, created_at = excluded.created_at`),
    delLink: db.prepare('DELETE FROM share_links WHERE project_id = ?'),
    previewFor: db.prepare('SELECT * FROM previews WHERE project_id = ?'),
    setPreview: db.prepare(`INSERT INTO previews (project_id, size, mime, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET size = excluded.size, mime = excluded.mime, updated_at = excluded.updated_at`),
    delPreview: db.prepare('DELETE FROM previews WHERE project_id = ?'),
    rmPreviewFor: db.prepare('SELECT * FROM roadmap_previews WHERE project_id = ?'),
    setRmPreview: db.prepare(`INSERT INTO roadmap_previews (project_id, size, mime, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET size = excluded.size, mime = excluded.mime, updated_at = excluded.updated_at`),
    delRmPreview: db.prepare('DELETE FROM roadmap_previews WHERE project_id = ?'),
    roadmapFor: db.prepare('SELECT * FROM roadmaps WHERE project_id = ?'),
    roadmapByToken: db.prepare('SELECT * FROM roadmaps WHERE token = ?'),
    addRoadmap: db.prepare('INSERT INTO roadmaps (project_id, token, created_by, created_at, show_ideas, show_bugs, show_details, indexable) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    setRoadmap: db.prepare('UPDATE roadmaps SET show_ideas = ?, show_bugs = ?, show_details = ?, indexable = ? WHERE project_id = ?'),
    delRoadmap: db.prepare('DELETE FROM roadmaps WHERE project_id = ?'),
    listedRoadmaps: db.prepare(`SELECT r.*, p.name, p.updated_at FROM roadmaps r JOIN projects p ON p.id = r.project_id
      WHERE r.indexable = 1 AND r.created_at < ? ORDER BY p.updated_at DESC LIMIT 5000`),
    voteCounts: db.prepare('SELECT card_id, COUNT(*) AS n FROM roadmap_votes WHERE project_id = ? GROUP BY card_id'),
    cardVotes: db.prepare('SELECT COUNT(*) AS n FROM roadmap_votes WHERE project_id = ? AND card_id = ?'),
    votedBy: db.prepare('SELECT card_id FROM roadmap_votes WHERE project_id = ? AND voter = ?'),
    hasVote: db.prepare('SELECT 1 FROM roadmap_votes WHERE project_id = ? AND card_id = ? AND voter = ?'),
    addVote: db.prepare('INSERT OR IGNORE INTO roadmap_votes (project_id, card_id, voter, created_at) VALUES (?, ?, ?, ?)'),
    delVote: db.prepare('DELETE FROM roadmap_votes WHERE project_id = ? AND card_id = ? AND voter = ?'),
    delVotes: db.prepare('DELETE FROM roadmap_votes WHERE project_id = ?'),
    feedActivity: db.prepare("SELECT id, kind, text, card_id, count, at FROM activity WHERE project_id = ? AND kind IN ('done', 'milestone') ORDER BY id DESC LIMIT 200"),
    project: db.prepare('SELECT * FROM projects WHERE id = ?'),
    addReport: db.prepare('INSERT INTO reports (project_id, reason, created_at) VALUES (?, ?, ?)'),
    unindex: db.prepare('DELETE FROM card_search WHERE project_id = ?'),
    index: db.prepare('INSERT INTO card_search (project_id, card_id, title, body) VALUES (?, ?, ?, ?)'),
    indexedCount: db.prepare('SELECT COUNT(*) AS n FROM card_search'),
    allProjects: db.prepare('SELECT id, doc FROM projects'),
    search: db.prepare(`SELECT s.project_id, s.card_id, s.title, snippet(card_search, -1, char(1), char(2), '…', 12) AS snip, p.name AS project_name, t.name AS team_name
      FROM card_search s JOIN projects p ON p.id = s.project_id JOIN teams t ON t.id = p.team_id
      WHERE card_search MATCH ? AND s.project_id IN (SELECT p2.id FROM projects p2 JOIN members m ON m.team_id = p2.team_id WHERE m.user_id = ?)
      ORDER BY rank LIMIT 50`),
    setDiscord: db.prepare('UPDATE teams SET discord_webhook = ?, discord_events = ? WHERE id = ?'),
    setSlack: db.prepare('UPDATE teams SET slack_webhook = ?, slack_events = ? WHERE id = ?'),
    dueUsers: db.prepare("SELECT id, email, display_name, timezone, due_mail_day FROM users WHERE notify_due = 1 AND email_verified = 1"),
    setDueDay: db.prepare('UPDATE users SET due_mail_day = ? WHERE id = ?'),
    userProjects: db.prepare('SELECT p.id, p.name FROM projects p JOIN members m ON m.team_id = p.team_id WHERE m.user_id = ?'),
    setNotify: db.prepare('UPDATE users SET notify_mentions = ?, notify_due = ? WHERE id = ?'),
  };
  const live = () => getLive();
  // signatures in links from emails are compared without leaking timing, and anything malformed simply fails
  const sameSig = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
  const timers = [];
  const every = (ms, fn) => { const t = setInterval(() => { try { fn(); } catch (e) { log('[job]', e.stack); } }, ms); t.unref(); timers.push(t); };
  const appLink = (projectId, cardId) => `${cfg.PUBLIC_URL}/app#p=${projectId}${cardId ? '&c=' + cardId : ''}`;
  const cardTitle = c => plain((c && c.title) || 'Untitled card', 80);
  const findCard = (doc, id) => (doc && doc.items.find(o => o.id === id)) || null;

  /* ---------- who's on the board ---------- */
  const members = teamId => q.members.all(teamId).map(m => ({ id: m.id, name: m.display_name, username: m.username, color: m.color, role: m.role }));

  /* ---------- email preferences: every notification email can be turned off from a link inside it ---------- */
  const sign = (userId, kind) => crypto.createHmac('sha256', secret).update(`${userId}:${kind}`).digest('base64url').slice(0, 32);
  const offLink = (userId, kind) => `${cfg.PUBLIC_URL}/unsubscribe?u=${encodeURIComponent(userId)}&k=${kind}&t=${sign(userId, kind)}`;
  const footer = (userId, kind, what) => `\n\n---\nYou get these emails when ${what}. Turn them off: ${offLink(userId, kind)}\nor in Settings in the Venom Board app.`;
  function unsubscribe(url) {
    const u = url.searchParams.get('u') || '', k = url.searchParams.get('k') || '', t = url.searchParams.get('t') || '';
    const user = okId(u) ? q.userById.get(u) : null;
    const good = user && ['mentions', 'due'].includes(k) && sameSig(t, sign(u, k));
    if (good) q.setNotify.run(k === 'mentions' ? 0 : user.notify_mentions, k === 'due' ? 0 : user.notify_due, user.id);
    return good ? `You won't get ${k === 'mentions' ? 'emails when someone mentions you' : 'due-date reminder emails'} any more. You can turn them back on in Settings in the Venom Board app.`
      : 'That link has expired or is incomplete. You can change which emails you get in Settings in the Venom Board app.';
  }

  /* ---------- notifications ---------- */
  const noteOut = n => ({ id: n.id, kind: n.kind, projectId: n.project_id, cardId: n.card_id, text: n.text, createdAt: n.created_at, read: !!n.read,
    projectName: n.project_name || '', fromName: n.from_name || '', fromUsername: n.from_username || '', fromColor: n.from_color || '' });
  function notify(userId, kind, room, cardId, from, text) {
    const n = { id: A.newId(), kind, project_id: room.id, card_id: cardId || null, text: txt(text, 300), created_at: Date.now(), read: 0,
      project_name: room.name, from_name: from.displayName, from_username: from.username, from_color: from.color };
    q.addNote.run(n.id, userId, kind, room.id, n.card_id, from.id, n.text, n.created_at);
    q.trimNotes.run(userId, userId);
    live().notify(userId, noteOut(n));
  }
  route('GET', '/api/notifications', ctx => ({ items: q.notes.all(ctx.user.id).map(noteOut), unread: q.unread.get(ctx.user.id).n }));
  route('POST', '/api/notifications/read', async ctx => {
    const b = await H.readJson(ctx.req);
    if (b.all === true) q.readAll.run(ctx.user.id);
    else for (const id of (Array.isArray(b.ids) ? b.ids : []).filter(okId).slice(0, 100)) q.readNote.run(ctx.user.id, id);
    return { unread: q.unread.get(ctx.user.id).n };
  });

  // @username in a comment notifies that teammate, and emails them unless they've turned it off.
  // Emails are capped per person per day and per sender per hour, so mentions can't be used to spam anyone.
  function mentions(room, user, comment, card) {
    const names = [...new Set((comment.text.match(/@([A-Za-z0-9_]{3,24})/g) || []).map(s => s.slice(1).toLowerCase()))].slice(0, 10);
    const told = new Set();
    for (const name of names) {
      const m = q.memberByUsername.get(room.teamId, name);
      if (!m || m.id === user.id) continue;
      told.add(m.id);
      notify(m.id, 'mention', room, comment.card, user, comment.text);
      if (!m.notify_mentions || !m.email_verified || !limit('mention-mail:' + m.id, 12, DAY) || !limit('mention-mail-from:' + user.id + ':' + m.id, 3, HOUR)) continue;
      const from = plain(user.displayName, 40);
      mail('mention', { to: m.email, subject: `${from} mentioned you in ${plain(room.name)}`,
        text: `${from} mentioned you on “${itemTitle(card)}” in ${plain(room.name)}:\n\n${plain(comment.text, 500)}\n\nOpen it: ${appLink(room.id, comment.card)}`
          + footer(m.id, 'mentions', 'a teammate mentions you in a comment') });
    }
    return told;
  }

  /* ---------- comment threads: replies tell the person they answer ---------- */
  // A reply notifies whoever started the thread, like a mention does (and shares its email limits and setting),
  // unless they wrote the reply or were already @mentioned in it. Reactions and resolving notify nobody.
  const isMember = db.prepare('SELECT 1 FROM members WHERE team_id = ? AND user_id = ?');
  const itemTitle = c => (c && c.type === 'image' ? plain(c.name || 'Picture', 80) : cardTitle(c));
  function replied(room, user, comment, card, told) {
    const parent = comment.re ? room.doc.comments.find(c => c.id === comment.re) : null;
    if (!parent || !parent.by || parent.by === user.id || told.has(parent.by) || !isMember.get(room.teamId, parent.by)) return;
    const m = q.userById.get(parent.by);
    if (!m) return;
    notify(m.id, 'reply', room, comment.card, user, comment.text);
    if (!m.notify_mentions || !m.email_verified || !limit('mention-mail:' + m.id, 12, DAY) || !limit('mention-mail-from:' + user.id + ':' + m.id, 3, HOUR)) return;
    const from = plain(user.displayName, 40);
    mail('mention', { to: m.email, subject: `${from} replied to your comment in ${plain(room.name)}`,
      text: `${from} replied to your comment on “${itemTitle(card)}” in ${plain(room.name)}:\n\n${plain(comment.text, 500)}\n\nOpen it: ${appLink(room.id, comment.card)}`
        + footer(m.id, 'mentions', 'a teammate mentions you in a comment or replies to yours') });
  }

  /* ---------- activity feed (and the matching Discord posts) ---------- */
  const activityOut = a => ({ id: a.id, kind: a.kind, text: a.text, cardId: a.card_id, count: a.count, at: a.at, userId: a.user_id,
    name: a.name || a.by_name || (BOTS[a.user_id] || {}).displayName || 'Someone', username: a.username || '', color: a.color || (BOTS[a.user_id] || {}).color || '' });
  function describe(kind, text, count) {
    const t = `“${text}”`;
    switch (kind) {
      case 'created': return count > 1 ? `added ${count} cards` : `added ${t}`;
      case 'done': return count > 1 ? `finished ${count} tasks` : `finished ${t}`;
      case 'milestone': return `reached the milestone ${t}`;
      case 'deleted': return count > 1 ? `deleted ${count} cards` : `deleted ${t}`;
      case 'comment': return count > 1 ? `left ${count} comments` : `commented on ${t}`;
      case 'restore': return `restored the version from ${text}`;
      case 'version': return `saved a version: ${t}`;
      default: return text;
    }
  }
  function record(room, user, kind, text, cardId) {
    const now = Date.now(), last = q.lastActivity.get(room.id);
    const byName = user.guest ? txt(user.displayName, 80) : '';  // a player without an account (playtest feedback, bug reports)
    let id;
    if (last && COALESCE.includes(kind) && last.kind === kind && last.user_id === user.id && (last.by_name || '') === byName && now - last.at < 15 * 60000) { q.bumpActivity.run(text, cardId || null, now, last.id); id = last.id; }
    else { id = q.addActivity.run(room.id, user.id, kind, text, cardId || null, now, byName).lastInsertRowid; q.trimActivity.run(room.id, room.id); }
    const entry = activityOut(q.activityById.get(id));
    live().activity(room.id, entry);
    const ev = { done: 'done', milestone: 'milestone', comment: 'comment', restore: 'restore' }[kind];
    if (ev) toDiscord(room.teamId, ev, `**${md(user.displayName)}** ${md(describe(kind, text, 1))} in *${md(room.name)}*`);
    if (ev) toSlack(room.teamId, ev, `*${sk(user.displayName)}* ${sk(describe(kind, text, 1))} in _${sk(room.name)}_`);
  }
  route('GET', '/api/projects/:id/activity', ctx => {
    const { p } = needProject(ctx.params.id, ctx.user, 'viewer');
    const before = Number(ctx.url.searchParams.get('before')) || Number.MAX_SAFE_INTEGER;
    return { items: q.activity.all(p.id, before).map(activityOut) };
  });

  // what each batch of live edits means for people: activity, assignments and mentions
  function changed(room, user, changes) {
    for (const ch of changes) {
      if (ch.k === 'items') {
        const o = ch.obj, old = ch.old;
        if (ch.op === 'put' && o.type === 'node') {
          if (!old) record(room, user, 'created', cardTitle(o), o.id);
          else if (old.status !== 'done' && o.status === 'done') record(room, user, o.kind === 'milestone' ? 'milestone' : 'done', cardTitle(o), o.id);
          const before = new Set((old && old.assignees) || []);
          for (const uid of o.assignees || []) {
            if (before.has(uid) || uid === user.id || !limit('assign-note:' + user.id, 120, HOUR)) continue;
            if (q.members.all(room.teamId).some(m => m.id === uid)) notify(uid, 'assigned', room, o.id, user, o.title || 'Untitled card');
          }
        } else if (ch.op === 'del' && old && old.type === 'node') record(room, user, 'deleted', cardTitle(old), null);
      } else if (ch.k === 'comments' && ch.op === 'put' && !ch.old) {
        const card = findCard(room.doc, ch.obj.card);
        record(room, user, 'comment', itemTitle(card), ch.obj.card);
        if (!user.bot) replied(room, user, ch.obj, card, mentions(room, user, ch.obj, card));  // a commit message can't notify or email anyone
      }
    }
  }
  const commentAllowed = user => limit('comment:' + user.id, 20, 60000) && limit('comment-hour:' + user.id, 300, HOUR);

  /* ---------- Discord ---------- */
  const md = s => plain(s, 120).replace(/([\\*_~`|>#[\]()-])/g, '\\$1');
  const eventsOf = t => (!t.discord_events ? DISCORD_DEFAULT : t.discord_events === 'none' ? [] : t.discord_events.split(',').filter(e => DISCORD_EVENTS.includes(e)));
  const discordInfo = t => ({ connected: !!t.discord_webhook, hint: t.discord_webhook ? '…' + t.discord_webhook.slice(-6) : '', events: eventsOf(t) });
  const discordQueue = new Map();
  // posts are gathered for a few seconds and sent as one message, well inside Discord's own rate limits
  function toDiscord(teamId, event, line) {
    const t = q.team.get(teamId);
    if (!t || !t.discord_webhook || !eventsOf(t).includes(event)) return;
    let pending = discordQueue.get(teamId);
    if (!pending) {
      pending = { lines: [], more: 0 };
      pending.timer = setTimeout(() => { discordQueue.delete(teamId); postDiscord(teamId, pending); }, cfg.DISCORD_DELAY_MS);
      pending.timer.unref();
      discordQueue.set(teamId, pending);
    }
    if (pending.lines.length < 12) pending.lines.push(line); else pending.more++;
  }
  async function postDiscord(teamId, pending) {
    const t = q.team.get(teamId);
    if (!t || !t.discord_webhook || !limit('discord:' + teamId, 30, HOUR)) return false;
    const content = (pending.lines.join('\n') + (pending.more ? `\n…and ${pending.more} more` : '')).slice(0, 1900);
    try {
      const r = await (app.fetch || fetch)(t.discord_webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(8000),
        body: JSON.stringify({ username: 'Venom Board', content, allowed_mentions: { parse: [] }, flags: 4 }) });
      // a webhook deleted on Discord's side stops being used
      if (r.status === 401 || r.status === 404) q.setDiscord.run('', t.discord_events, t.id);
      return r.ok;
    } catch (e) { log('[discord]', e.message); return false; }
  }
  function teamEvent(teamId, event, who, what) {
    toDiscord(teamId, event, `**${md(who)}** ${md(what)}`);
    toSlack(teamId, event, `*${sk(who)}* ${sk(what)}`);
  }
  route('PATCH', '/api/teams/:id/integrations', async ctx => {
    needRole(ctx.params.id, ctx.user, 'admin');
    const b = await H.readJson(ctx.req), t = q.team.get(ctx.params.id);
    let hook = t.discord_webhook, events = eventsOf(t);
    if (b.discordWebhook !== undefined) {
      const u = txt(b.discordWebhook, 300).trim();
      if (u && !DISCORD_URL.test(u)) fail(400, 'webhook', 'That isn’t a Discord webhook link. In Discord: Server Settings → Integrations → Webhooks → New Webhook → Copy Webhook URL.');
      hook = u;
    }
    if (Array.isArray(b.discordEvents)) events = DISCORD_EVENTS.filter(e => b.discordEvents.includes(e));
    q.setDiscord.run(hook, events.length ? events.join(',') : 'none', t.id);
    live().teamChanged(t.id);  // the team's other admins see it
    return { discord: discordInfo(q.team.get(t.id)) };
  });
  route('POST', '/api/teams/:id/integrations/test', async ctx => {
    needRole(ctx.params.id, ctx.user, 'admin');
    const t = q.team.get(ctx.params.id);
    if (!t.discord_webhook) fail(400, 'webhook', 'Add a Discord webhook link first.');
    if (!limit('discord-test:' + t.id, 5, 600000)) fail(429, 'rate', 'Wait a few minutes before testing again.');
    const ok = await postDiscord(t.id, { lines: [`Venom Board is connected. Updates from *${md(t.name)}* will appear here.`], more: 0 });
    if (!ok) fail(502, 'discord', 'Discord didn’t accept the message. Check the webhook link is still there in your Discord server.');
    return { ok: true };
  });

  /* ---------- Slack ---------- */
  // The same as Discord: an incoming webhook per team (never shown back in full), the same choice of events, posts
  // gathered for a few seconds into one message, at most 30 an hour, and a webhook Slack says is gone stops being
  // used. Messages use Slack's mrkdwn; what people typed is escaped, so it can't ping a channel, link anywhere or
  // change the formatting.
  const sk = s => plain(s, 120).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/[*_~`]/g, c => ({ '*': '∗', _: 'ˍ', '~': '∼', '`': 'ˋ' }[c]));
  const slackEventsOf = t => (!t.slack_events ? DISCORD_DEFAULT : t.slack_events === 'none' ? [] : t.slack_events.split(',').filter(e => DISCORD_EVENTS.includes(e)));
  const slackInfo = t => ({ connected: !!t.slack_webhook, hint: t.slack_webhook ? '…' + t.slack_webhook.slice(-6) : '', events: slackEventsOf(t) });
  const slackQueue = new Map();
  function toSlack(teamId, event, line) {
    const t = q.team.get(teamId);
    if (!t || !t.slack_webhook || !slackEventsOf(t).includes(event)) return;
    let pending = slackQueue.get(teamId);
    if (!pending) {
      pending = { lines: [], more: 0 };
      pending.timer = setTimeout(() => { slackQueue.delete(teamId); postSlack(teamId, pending); }, cfg.DISCORD_DELAY_MS);
      pending.timer.unref();
      slackQueue.set(teamId, pending);
    }
    if (pending.lines.length < 12) pending.lines.push(line); else pending.more++;
  }
  async function postSlack(teamId, pending) {
    const t = q.team.get(teamId);
    if (!t || !t.slack_webhook || !limit('slack:' + teamId, 30, HOUR)) return false;
    const text = (pending.lines.join('\n') + (pending.more ? `\n…and ${pending.more} more` : '')).slice(0, 2900);
    try {
      const r = await (app.fetch || fetch)(t.slack_webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(8000),
        body: JSON.stringify({ text, mrkdwn: true, unfurl_links: false, unfurl_media: false }) });
      // a webhook removed, revoked or pointing at an archived channel stops being used
      if ([403, 404, 410].includes(r.status)) q.setSlack.run('', t.slack_events, t.id);
      return r.ok;
    } catch (e) { log('[slack]', e.message); return false; }
  }
  route('PATCH', '/api/teams/:id/integrations/slack', async ctx => {
    needRole(ctx.params.id, ctx.user, 'admin');
    const b = await H.readJson(ctx.req), t = q.team.get(ctx.params.id);
    let hook = t.slack_webhook, events = slackEventsOf(t);
    if (b.slackWebhook !== undefined) {
      const u = txt(b.slackWebhook, 300).trim();
      if (u && !SLACK_URL.test(u)) fail(400, 'webhook', 'That isn’t a Slack webhook link. In Slack: create an app, turn on Incoming Webhooks, add one to a channel and copy its Webhook URL (it starts with https://hooks.slack.com/services/).');
      hook = u;
    }
    if (Array.isArray(b.slackEvents)) events = DISCORD_EVENTS.filter(e => b.slackEvents.includes(e));
    q.setSlack.run(hook, events.length ? events.join(',') : 'none', t.id);
    live().teamChanged(t.id);  // the team's other admins see it
    return { slack: slackInfo(q.team.get(t.id)) };
  });
  route('POST', '/api/teams/:id/integrations/slack/test', async ctx => {
    needRole(ctx.params.id, ctx.user, 'admin');
    const t = q.team.get(ctx.params.id);
    if (!t.slack_webhook) fail(400, 'webhook', 'Add a Slack webhook link first.');
    if (!limit('slack-test:' + t.id, 5, 600000)) fail(429, 'rate', 'Wait a few minutes before testing again.');
    const ok = await postSlack(t.id, { lines: [`Venom Board is connected. Updates from _${sk(t.name)}_ will appear here.`], more: 0 });
    if (!ok) fail(502, 'slack', 'Slack didn’t accept the message. Check the webhook is still there in your Slack workspace.');
    return { ok: true };
  });

  /* ---------- version history ---------- */
  // Boards are kept compressed. An automatic version is taken before the first edit after an hour of quiet;
  // they're kept hourly for two days (48 at most) and daily for a month. Named versions are kept until someone
  // deletes them. Versions count toward the team's storage: when it's full, automatic ones are skipped and
  // named ones refused (the copy kept before a restore is always made, so a restore can be undone).
  const pack = doc => zlib.gzipSync(Buffer.from(JSON.stringify(doc)));
  const unpack = buf => cleanDoc(JSON.parse(zlib.gunzipSync(buf).toString('utf8')), { assetBase: cfg.PUBLIC_URL + '/assets/' });
  function saveVersion(project, doc, userId, label, auto, always) {
    const data = pack(doc), id = A.newId(), s = storage(project.teamId, true);
    if (!always && data.length > s.left) {
      if (auto) return null;
      fail(413, 'quota', `${s.why} Delete old versions or projects to make room.`);
    }
    q.addVersion.run(id, project.id, Date.now(), userId || null, txt(label, 80), auto ? 1 : 0, data.length, data);
    if (auto) pruneAutos(project.id);
    return id;
  }
  function pruneAutos(projectId) {
    const now = Date.now(), days = new Set();
    let recent = 0;
    for (const v of q.autoVersions.all(projectId)) {  // newest first
      const age = now - v.created_at;
      if (age <= 2 * DAY) { if (++recent > 48) q.delVersion.run(v.id); continue; }
      const day = new Date(v.created_at).toISOString().slice(0, 10);
      if (age > 31 * DAY || days.has(day)) q.delVersion.run(v.id); else days.add(day);
    }
  }
  function beforeEdit(room) {
    const last = q.lastAuto.get(room.id);
    if ((!last || Date.now() - last.created_at >= HOUR) && diskOk()) saveVersion(room, room.doc, null, '', true);
  }
  const versionOut = v => ({ id: v.id, createdAt: v.created_at, label: v.label, auto: !!v.auto, size: v.size, byName: v.by_name || '' });
  const when = t => new Date(t).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  route('GET', '/api/projects/:id/versions', ctx => {
    const { p } = needProject(ctx.params.id, ctx.user, 'viewer');
    return { items: q.versions.all(p.id).map(versionOut) };
  });
  route('GET', '/api/projects/:id/versions/:vid', ctx => {
    const { p } = needProject(ctx.params.id, ctx.user, 'viewer');
    const v = q.version.get(ctx.params.vid, p.id);
    if (!v) fail(404, 'not_found', 'That version no longer exists.');
    return { version: versionOut(v), doc: unpack(v.doc) };
  });
  route('POST', '/api/projects/:id/versions', async ctx => {
    const { p } = needProject(ctx.params.id, ctx.user, 'editor');
    const label = txt((await H.readJson(ctx.req)).label, 80).trim() || 'Saved version';
    if (q.namedCount.get(p.id).n >= cfg.LIMIT_NAMED_VERSIONS) fail(403, 'limit', `A project keeps up to ${cfg.LIMIT_NAMED_VERSIONS} named versions. Delete one you don’t need first.`);
    if (!diskOk()) fail(507, 'disk', 'The server is short on space right now. Try again later.');
    if (!limit('version:' + ctx.user.id, 30, HOUR)) fail(429, 'rate', 'That’s a lot of versions. Try again later.');
    const id = saveVersion({ id: p.id, teamId: p.team_id }, live().currentDoc(p.id), ctx.user.id, label, false);
    const room = { id: p.id, teamId: p.team_id, name: p.name };
    record(room, ctx.user, 'version', label, null);
    return { version: versionOut({ ...q.version.get(id, p.id), by_name: ctx.user.displayName }) };
  });
  route('POST', '/api/projects/:id/versions/:vid/restore', ctx => {
    const { p } = needProject(ctx.params.id, ctx.user, 'editor');
    const v = q.version.get(ctx.params.vid, p.id);
    if (!v) fail(404, 'not_found', 'That version no longer exists.');
    if (!diskOk()) fail(507, 'disk', 'The server is short on space right now. Try again later.');
    if (ctx.auth.via !== 'mcp' && live().heldElsewhere(p.id, ctx.user.id, ctx.auth.token)) fail(409, 'elsewhere', 'This board is open in another session of your account. Only one session at a time can work on a board.');
    if (!limit('restore:' + ctx.user.id, 20, HOUR)) fail(429, 'rate', 'That’s a lot of restores. Try again later.');
    // the board as it is now is kept first, so a restore can always be undone by restoring that
    if (!saveVersion({ id: p.id, teamId: p.team_id }, live().currentDoc(p.id), ctx.user.id, 'Before restoring ' + when(v.created_at), true)) {
      fail(413, 'quota', `${storage(p.team_id, true).why} Delete old versions or projects to make room, so the board as it is now can be kept before restoring.`);
    }
    live().restore(p.id, unpack(v.doc), ctx.user.id, ctx.user.displayName);
    record({ id: p.id, teamId: p.team_id, name: p.name }, ctx.user, 'restore', v.label ? `${when(v.created_at)} (${v.label})` : when(v.created_at), null);
    indexProject(p.id);
    return { ok: true };
  });
  route('DELETE', '/api/projects/:id/versions/:vid', ctx => {
    const { p } = needProject(ctx.params.id, ctx.user, 'admin');
    const v = q.version.get(ctx.params.vid, p.id);
    if (!v) fail(404, 'not_found', 'That version no longer exists.');
    q.delVersion.run(v.id);
    return { ok: true };
  });

  /* ---------- share links ---------- */
  const linkUrl = token => `${cfg.PUBLIC_URL}/v/${token}`;
  const linkProject = token => { const l = typeof token === 'string' && /^[\w-]{20,64}$/.test(token) ? q.linkByToken.get(token) : null; return l ? l.project_id : null; };
  route('GET', '/api/projects/:id/share', ctx => {
    const { p } = needProject(ctx.params.id, ctx.user, 'viewer');
    const l = q.linkFor.get(p.id), pv = q.previewFor.get(p.id);
    return { url: l ? linkUrl(l.token) : null, createdAt: l ? l.created_at : null, previewAt: pv ? pv.updated_at : null };
  });
  route('POST', '/api/projects/:id/share', ctx => {
    const { p } = needProject(ctx.params.id, ctx.user, 'admin');
    if (!limit('share:' + ctx.user.id, 30, HOUR)) fail(429, 'rate', 'Try again in a while.');
    if (q.linkFor.get(p.id)) live().linkRevoked(p.id);  // a new link replaces the old one
    const token = crypto.randomBytes(24).toString('base64url');
    q.setLink.run(p.id, token, ctx.user.id, Date.now());
    live().sharingChanged(p.id);
    return { url: linkUrl(token) };
  });
  route('DELETE', '/api/projects/:id/share', ctx => {
    const { p } = needProject(ctx.params.id, ctx.user, 'admin');
    q.delLink.run(p.id);
    live().linkRevoked(p.id);
    forgetPreview(p.id);
    live().sharingChanged(p.id);
    return { ok: true };
  });
  // anyone who can see a shared board can report it; reports go to the support inbox, a few a day at most
  route('POST', '/api/view/:token/report', async ctx => {
    const projectId = linkProject(ctx.params.token);
    if (!projectId) fail(404, 'not_found', 'This link no longer works.');
    const reason = txt((await H.readJson(ctx.req)).reason, 1000).trim();
    if (!reason) fail(400, 'reason', 'Tell us what’s wrong with this board.');
    if (!limit('report-ip:' + ctx.ip, 3, DAY) || !limit('report-all', 30, DAY)) fail(429, 'rate', `Thanks, we’ve had a lot of reports today.${cfg.SUPPORT_EMAIL ? ` Email ${cfg.SUPPORT_EMAIL} if it’s urgent.` : ''}`);
    q.addReport.run(projectId, reason, Date.now());
    const p = q.project.get(projectId);
    mail('alert', { to: cfg.ALERT_EMAIL, subject: 'A shared Venom Board board was reported',
      text: `Someone reported the shared board “${plain(p ? p.name : '?')}” (project ${projectId}).\n\nWhat they said:\n${plain(reason, 1000)}\n\nTurn its view-only link off with one click: ${takedownLink('link', projectId)}\nThe team can make a new link if it was a mistake.` });
    return { ok: true };
  }, { auth: false });

  /* ---------- preview pictures: how a shared board looks when its link is posted somewhere ---------- */
  // The app makes them (editors and above): a PNG or JPEG of a sensible size, a few updates an hour at most, counted
  // toward the team's storage. There are two, kept apart: the board itself, only while it has a view-only link
  // (anyone with that link sees the whole board anyway), and a public roadmap's own picture, which the app draws
  // from what the roadmap shows and never from the board, so a roadmap's picture can't show hidden cards, pictures,
  // notes or estimates.
  const previewDir = path.join(cfg.DATA_DIR, 'previews');
  fs.mkdirSync(previewDir, { recursive: true });
  function pictureSize(buf) {
    if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.toString('latin1', 12, 16) === 'IHDR') return { mime: 'image/png', w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
      for (let i = 2; i + 9 < buf.length;) {
        if (buf[i] !== 0xff) return null;
        const m = buf[i + 1];
        if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) { i += 2; continue; }
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { mime: 'image/jpeg', w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
        i += 2 + buf.readUInt16BE(i + 2);
      }
    }
    return null;
  }
  async function takePicture(ctx, roadmap) {
    const { p } = needProject(ctx.params.id, ctx.user, 'editor');
    if (roadmap ? !q.roadmapFor.get(p.id) : !q.linkFor.get(p.id)) fail(409, 'not_shared', roadmap ? 'This project has no public roadmap.' : 'Only projects with a view-only link have a board picture.');
    if (!limit('preview:' + p.id, 24, HOUR)) fail(429, 'rate', 'The preview picture was updated a lot just now. Try again later.');
    const buf = await H.readBody(ctx.req, 1.5 * 1048576);
    const pic = pictureSize(buf);
    if (!pic || pic.w < 200 || pic.h < 100 || pic.w > 2400 || pic.h > 2400) fail(415, 'type', 'A preview picture is a PNG or JPEG between 200 x 100 and 2400 x 2400.');
    const old = (roadmap ? q.rmPreviewFor : q.previewFor).get(p.id), s = storage(p.team_id, true);
    if (buf.length - (old ? old.size : 0) > s.left) fail(413, 'quota', s.why);
    const file = path.join(previewDir, p.id + (roadmap ? '.roadmap' : ''));
    fs.writeFileSync(file + '.tmp', buf);
    fs.renameSync(file + '.tmp', file);
    (roadmap ? q.setRmPreview : q.setPreview).run(p.id, buf.length, pic.mime, Date.now());
    return { ok: true };
  }
  route('PUT', '/api/projects/:id/preview', ctx => takePicture(ctx, false));
  route('PUT', '/api/projects/:id/roadmap/preview', ctx => takePicture(ctx, true));
  function forgetPreview(projectId) {
    q.delPreview.run(projectId);
    fs.rm(path.join(previewDir, projectId), { force: true }, () => {});
  }
  function forgetRoadmapPreview(projectId) {
    q.delRmPreview.run(projectId);
    fs.rm(path.join(previewDir, projectId + '.roadmap'), { force: true }, () => {});
  }
  // what a share link's page says about the board: its name, and its picture if it has one
  function linkMeta(token) {
    const projectId = linkProject(token), p = projectId ? q.project.get(projectId) : null;
    if (!p) return null;
    const pv = q.previewFor.get(p.id);
    return { projectId: p.id, name: p.name, preview: pv ? { dir: previewDir, file: p.id, mime: pv.mime, at: pv.updated_at } : null };
  }

  /* ---------- public roadmaps ---------- */
  // A page players can follow, at /r/<id> (roadmap.js decides what it shows). Team admins publish it, choose what
  // goes on it and stop it; players vote, one vote per card per network; anyone can report one, and the report
  // email gives the site's owner a one-click takedown. A new roadmap waits a few days before search engines are
  // told about it, so it can't be used for quick spam.
  const RM_ID = /^[A-Za-z0-9]{10}$/;
  const RM_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const newRoadmapId = () => Array.from({ length: 10 }, () => RM_CHARS[crypto.randomInt(62)]).join('');
  const LISTED_AFTER = 3 * DAY;
  const voteCounts = projectId => new Map(q.voteCounts.all(projectId).map(r => [r.card_id, r.n]));
  const voterOf = ip => crypto.createHmac('sha256', secret).update('vote:' + ip).digest('base64url').slice(0, 32);
  const flag = (v, d) => (typeof v === 'boolean' ? (v ? 1 : 0) : d ? 1 : 0);
  function roadmapOut(rm, name) {
    const url = cfg.PUBLIC_URL + R.pathOf(rm, name);
    return { url, embed: `<iframe src="${cfg.PUBLIC_URL}/r/${rm.token}/embed" title="${name.replace(/[<>&"]/g, '')} roadmap" width="100%" height="640" style="border:0;border-radius:12px" loading="lazy"></iframe>`,
      showIdeas: !!rm.show_ideas, showBugs: !!rm.show_bugs, showDetails: !!rm.show_details, indexable: !!rm.indexable, createdAt: rm.created_at, listed: !!rm.indexable && Date.now() - rm.created_at >= LISTED_AFTER };
  }
  route('GET', '/api/projects/:id/roadmap', ctx => {
    const { p } = needProject(ctx.params.id, ctx.user, 'viewer');
    const rm = q.roadmapFor.get(p.id), pv = rm ? q.rmPreviewFor.get(p.id) : null;
    return { roadmap: rm ? roadmapOut(rm, p.name) : null, votes: rm ? Object.fromEntries(voteCounts(p.id)) : {}, previewAt: pv ? pv.updated_at : null };
  });
  route('POST', '/api/projects/:id/roadmap', async ctx => {
    const { p } = needProject(ctx.params.id, ctx.user, 'admin');
    const b = await H.readJson(ctx.req);
    if (!limit('roadmap:' + ctx.user.id, 30, HOUR)) fail(429, 'rate', 'Try again in a while.');
    const rm = q.roadmapFor.get(p.id);
    if (rm) q.setRoadmap.run(flag(b.showIdeas, rm.show_ideas), flag(b.showBugs, rm.show_bugs), flag(b.showDetails, rm.show_details), flag(b.indexable, rm.indexable), p.id);
    else {
      if (!ctx.user.emailVerified) fail(403, 'verify_first', 'Confirm your email address before you publish a public roadmap. We sent you a link when you signed up.');
      q.addRoadmap.run(p.id, newRoadmapId(), ctx.user.id, Date.now(), flag(b.showIdeas, 1), flag(b.showBugs, 0), flag(b.showDetails, 1), flag(b.indexable, 1));
    }
    live().sharingChanged(p.id);
    return { roadmap: roadmapOut(q.roadmapFor.get(p.id), p.name) };
  });
  function stopRoadmap(projectId) {
    q.delRoadmap.run(projectId);
    q.delVotes.run(projectId);
    forgetRoadmapPreview(projectId);
  }
  route('DELETE', '/api/projects/:id/roadmap', ctx => {
    const { p } = needProject(ctx.params.id, ctx.user, 'admin');
    stopRoadmap(p.id);
    live().sharingChanged(p.id);
    return { ok: true };
  });
  // A board nobody has open is read from the database. Roadmap pages are public and can be busy, so the last
  // few closed boards they show are kept while unchanged (only read here, never changed).
  const closedDocs = new Map();
  function roadmapDoc(p) {
    if (live().roomState(p.id)) return live().currentDoc(p.id);
    const hit = closedDocs.get(p.id);
    if (hit && hit.at === p.updated_at) return hit.doc;
    const doc = live().currentDoc(p.id);
    closedDocs.delete(p.id); closedDocs.set(p.id, { at: p.updated_at, doc });
    if (closedDocs.size > 8) closedDocs.delete(closedDocs.keys().next().value);
    return doc;
  }
  // the public view of a roadmap, from the board as it is right now
  function roadmapData(token) {
    const rm = RM_ID.test(token || '') ? q.roadmapByToken.get(token) : null, p = rm ? q.project.get(rm.project_id) : null;
    const doc = p ? roadmapDoc(p) : null;
    return doc ? { rm, p, doc, view: R.view(doc, rm, voteCounts(p.id)) } : null;
  }
  route('POST', '/api/roadmaps/:id/vote', async ctx => {
    const d = roadmapData(ctx.params.id);
    if (!d) fail(404, 'not_found', 'This roadmap is no longer public.');
    if (!ctx.fromSite) fail(403, 'forbidden', 'Vote from the roadmap page.');
    const card = txt((await H.readJson(ctx.req)).card, 64);
    if (!okId(card) || !d.view.votable.has(card)) fail(400, 'card', 'You can’t vote for that.');
    if (!limit('vote-ip:' + ctx.ip, 60, HOUR)) fail(429, 'rate', 'That’s a lot of votes. Try again later.');
    const voter = voterOf(ctx.ip), had = !!q.hasVote.get(d.p.id, card, voter);
    if (had) q.delVote.run(d.p.id, card, voter); else q.addVote.run(d.p.id, card, voter, Date.now());
    return { voted: !had, votes: q.cardVotes.get(d.p.id, card).n };
  }, { auth: false });
  route('POST', '/api/roadmaps/:id/report', async ctx => {
    const d = roadmapData(ctx.params.id);
    if (!d) fail(404, 'not_found', 'This roadmap is no longer public.');
    const reason = txt((await H.readJson(ctx.req)).reason, 1000).trim();
    if (!reason) fail(400, 'reason', 'Tell us what’s wrong with this roadmap.');
    if (!limit('report-ip:' + ctx.ip, 3, DAY) || !limit('report-all', 30, DAY)) fail(429, 'rate', `Thanks, we’ve had a lot of reports today.${cfg.SUPPORT_EMAIL ? ` Email ${cfg.SUPPORT_EMAIL} if it’s urgent.` : ''}`);
    q.addReport.run(d.p.id, 'Roadmap: ' + reason, Date.now());
    mail('alert', { to: cfg.ALERT_EMAIL, subject: 'A public Venom Board roadmap was reported',
      text: `Someone reported the public roadmap “${plain(d.p.name)}” (${cfg.PUBLIC_URL}${R.pathOf(d.rm, d.p.name)}).\n\nWhat they said:\n${plain(reason, 1000)}\n\nTake it down with one click: ${takedownLink('roadmap', d.p.id)}\nThe team can publish it again if it was a mistake.` });
    return { ok: true };
  }, { auth: false });
  // /r/<id>[-name], /r/<id>/embed, /r/<id>/feed.xml and /r/<id>/preview, for index.js to send
  function roadmapPage(url, ip) {
    const m = url.pathname.match(/^\/r\/([A-Za-z0-9]{10})(?:-[a-z0-9-]{1,60})?(\/embed|\/feed\.xml|\/preview)?$/);
    if (!m) return null;
    const d = roadmapData(m[1]);
    if (!d) return { status: 404 };
    const pv = q.rmPreviewFor.get(d.p.id), kind = m[2] || '';  // the roadmap's own picture, never the board's
    if (kind === '/preview') return pv ? { file: { dir: previewDir, name: d.p.id + '.roadmap', mime: pv.mime } } : { status: 404 };
    if (kind === '/feed.xml') {
      const entries = q.feedActivity.all(d.p.id).filter(a => a.card_id && d.view.publicIds.has(a.card_id)).slice(0, 50).map(a => ({ id: a.id, at: a.at, card: a.card_id,
        title: (t => (a.kind === 'milestone' ? `Reached the milestone: ${t}` : a.count > 1 ? `Finished ${t} and more` : `Finished: ${t}`))(d.view.titles.get(a.card_id) || a.text) }));
      return { type: 'application/atom+xml; charset=utf-8', body: R.feed({ rm: d.rm, name: d.p.name, entries, updatedAt: d.p.updated_at }) };
    }
    const o = { rm: d.rm, name: d.p.name, view: d.view, updatedAt: d.p.updated_at, voted: new Set(q.votedBy.all(d.p.id, voterOf(ip)).map(r => r.card_id)),
      image: pv ? `${cfg.PUBLIC_URL}/r/${d.rm.token}/preview?v=${pv.updated_at}` : null, noindex: !d.rm.indexable || Date.now() - d.rm.created_at < LISTED_AFTER };
    return kind === '/embed' ? { embed: true, body: R.embed(o) } : { body: R.page(o) };
  }
  // roadmaps that asked to be found, once they've been public for a few days
  const roadmapSitemap = () => q.listedRoadmaps.all(Date.now() - LISTED_AFTER).map(r => ({ loc: cfg.PUBLIC_URL + R.pathOf(r, r.name), lastmod: r.updated_at, priority: 0.4 }));

  /* ---------- takedowns: one click from a report email, for the site's owner ---------- */
  const takedownSig = (kind, projectId) => crypto.createHmac('sha256', secret).update(`takedown:${kind}:${projectId}`).digest('base64url').slice(0, 32);
  const takedownLink = (kind, projectId) => `${cfg.PUBLIC_URL}/takedown?k=${kind}&p=${encodeURIComponent(projectId)}&t=${takedownSig(kind, projectId)}`;
  // opening the link only asks; the button (a POST) does it, so mail scanners that follow links change nothing
  function takedown(url, act) {
    const k = url.searchParams.get('k') || '', pid = url.searchParams.get('p') || '', t = url.searchParams.get('t') || '';
    const p = okId(pid) ? q.project.get(pid) : null;
    if (!p || !['roadmap', 'link'].includes(k) || !sameSig(t, takedownSig(k, pid))) return { text: 'That link is incomplete, or what it points to is already gone.' };
    const what = k === 'roadmap' ? 'public roadmap' : 'view-only link';
    if (!act) return { text: `Take down the ${what} of “${p.name}”?`, ask: true };
    if (k === 'roadmap') stopRoadmap(p.id);
    else { q.delLink.run(p.id); live().linkRevoked(p.id); forgetPreview(p.id); }
    live().sharingChanged(p.id);
    log('[takedown]', k, p.id);
    return { text: `The ${what} of “${p.name}” is down. The team can publish a new one.` };
  }

  /* ---------- search across every project you're in ---------- */
  const indexTimers = new Map();
  function indexProject(projectId, doc) {
    doc = doc || live().currentDoc(projectId);
    db.transaction(() => {
      q.unindex.run(projectId);
      if (!doc) return;
      for (const o of doc.items) {
        if (o.type === 'node') q.index.run(projectId, o.id, o.title, o.body);
        else if (o.type === 'frame') q.index.run(projectId, o.id, o.title, '');
        else if (o.type === 'text') q.index.run(projectId, o.id, o.text.slice(0, 120), o.text);
      }
    })();
  }
  function scheduleIndex(projectId) {
    if (indexTimers.has(projectId)) return;
    const t = setTimeout(() => { indexTimers.delete(projectId); try { indexProject(projectId); } catch (e) { log('[index]', e.message); } }, cfg.SEARCH_INDEX_DELAY_MS);
    t.unref();
    indexTimers.set(projectId, t);
  }
  const forgetProject = projectId => { q.unindex.run(projectId); forgetPreview(projectId); forgetRoadmapPreview(projectId); };
  if (!q.indexedCount.get().n) {
    for (const p of q.allProjects.all()) { try { indexProject(p.id, cleanDoc(JSON.parse(p.doc))); } catch (e) {} }
  }
  // every role can read a project (a role given in one project is editor or viewer), so being in the team is enough
  route('GET', '/api/search', ctx => {
    if (!limit('search:' + ctx.user.id, 60, 60000)) fail(429, 'rate', 'Searching too fast. Wait a moment.');
    const terms = (txt(ctx.url.searchParams.get('q'), 200).toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).slice(0, 8);
    if (!terms.length) return { results: [] };
    const match = terms.map(t => `"${t}"*`).join(' ');
    return { results: q.search.all(match, ctx.user.id).map(r => ({ projectId: r.project_id, cardId: r.card_id, title: r.title, snippet: r.snip, project: r.project_name, team: r.team_name })) };
  });

  /* ---------- due-date reminders ---------- */
  // Once a day, after 8 in the morning where each person lives, one email lists the cards assigned to them that
  // are due today or tomorrow, or are up to a week late. Nothing due, no email.
  function localNow(tz, now) {
    try {
      const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(now);
      const g = t => p.find(x => x.type === t).value;
      return { day: `${g('year')}-${g('month')}-${g('day')}`, hour: Number(g('hour')) };
    } catch (e) { return tz && tz !== 'UTC' ? localNow('UTC', now) : { day: now.toISOString().slice(0, 10), hour: now.getUTCHours() }; }
  }
  const shiftDay = (day, n) => { const d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  function remindDue(now = new Date()) {
    let sent = 0;
    for (const u of q.dueUsers.all()) {
      const { day, hour } = localNow(u.timezone, now);
      if (hour < 8 || u.due_mail_day === day) continue;
      q.setDueDay.run(day, u.id);
      const soon = shiftDay(day, 1), weekAgo = shiftDay(day, -7), items = [];
      for (const p of q.userProjects.all(u.id)) {
        const doc = live().currentDoc(p.id);
        if (!doc) continue;
        for (const c of doc.items) {
          if (c.type === 'node' && c.status !== 'done' && c.due && c.due <= soon && c.due >= weekAgo && (c.assignees || []).includes(u.id)) items.push({ p, c });
        }
      }
      if (!items.length || !limit('due-mail:' + u.id, 1, 20 * HOUR)) continue;
      items.sort((a, b) => a.c.due.localeCompare(b.c.due));
      const late = items.filter(i => i.c.due < day).length;
      const lines = items.slice(0, 20).map(({ p, c }) => `- ${cardTitle(c)}: ${c.due < day ? `late, was due ${c.due}` : c.due === day ? 'due today' : 'due tomorrow'} (${plain(p.name)})\n  ${appLink(p.id, c.id)}`);
      mail('due', { to: u.email, subject: late ? `${items.length} of your Venom Board tasks need attention (${late} late)` : `${items.length} of your Venom Board tasks ${items.length === 1 ? 'is' : 'are'} due soon`,
        text: `Hi ${plain(u.display_name, 40)},\n\nThese tasks are assigned to you:\n\n${lines.join('\n')}${items.length > 20 ? `\n…and ${items.length - 20} more` : ''}`
          + footer(u.id, 'due', 'tasks assigned to you are due soon') });
      sent++;
    }
    return sent;
  }
  every(15 * 60000, () => remindDue());

  /* ---------- account settings for these emails ---------- */
  return {
    hooks: { members, linkProject, changed, beforeEdit, flushed: room => scheduleIndex(room.id), commentAllowed },
    members, unsubscribe, teamEvent, md, discordInfo: t => discordInfo(t), slackInfo: t => slackInfo(t), indexProject, forgetProject, remindDue, saveVersion, linkMeta, roadmapPage, roadmapSitemap, takedown,
    close() { for (const t of timers) clearInterval(t); for (const t of indexTimers.values()) clearTimeout(t); for (const p of discordQueue.values()) clearTimeout(p.timer); for (const p of slackQueue.values()) clearTimeout(p.timer); },
  };
}

module.exports = { collab, DISCORD_EVENTS };
