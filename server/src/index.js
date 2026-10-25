// Venom Board server: website, accounts, teams, shared projects and live collaboration.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { config } = require('./config');
const { openDb } = require('./db');
const A = require('./auth');
const H = require('./http');
const { cleanDoc, okId, txt } = require('./sanitize');
const { mailer, smtpReady } = require('./mail');
const { realtime, RANK } = require('./realtime');
const { collab } = require('./collab');
const { mcp } = require('./mcp');
const { projectRoles } = require('./projectroles');
const { gitlink } = require('./gitlink');
const { ical } = require('./ical');
const { intake } = require('./intake');
const { shots, stripPng, stripJpeg, stripWebp, stripGif } = require('./shots');
const T = require('./totp');
const page = require('./page');
// venomboard.com's own pages (its website, the demo tour, the owner's dashboard) sit beside the server in its private
// copy; a self-hosted server runs without them
const optional = file => { try { return require(file); } catch (e) { if (e.code === 'MODULE_NOT_FOUND' && String(e.message).includes(`'${file}'`)) return null; throw e; } };
const site = optional('./site'), demo = optional('./demo'), { admin } = optional('./admin') || {};

// One inbox can hide behind many spellings (name+tag@…, n.a.m.e@gmail.com), so invite limits count them as one.
function inboxKey(email) {
  let [local = '', domain = ''] = String(email).toLowerCase().split('@');
  local = local.split('+')[0];
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return local + '@' + domain;
}

const COLORS = ['#ff2a4f', '#3dff8b', '#2fd6ff', '#ffd23d', '#ff7a1a', '#a66bff', '#ff4fd8', '#7dffd0', '#8fa3ff'];
const USERNAME = /^[A-Za-z0-9_]{3,24}$/;
const EMAIL = /^[^\s@<>()[\]\\,;:"]{1,64}@[^\s@<>()[\]\\,;:"]{1,190}\.[^\s@<>()[\]\\,;:".]{2,24}$/;
const ROLE_LABEL = { leader: 'team leader', admin: 'team admin', editor: 'editor', viewer: 'viewer' };
const IMAGE_TYPES = [
  { mime: 'image/png', test: b => b.length > 8 && b.readUInt32BE(0) === 0x89504e47 },
  { mime: 'image/jpeg', test: b => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/gif', test: b => b.length > 6 && b.toString('latin1', 0, 4) === 'GIF8' },
  { mime: 'image/webp', test: b => b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP' },
];
const VIDEO_TYPES = [
  // MP4 and QuickTime files start with an "ftyp" box; still-image formats that use it too (HEIC, AVIF) are left out
  { mime: 'video/mp4', test: b => b.length > 12 && b.toString('latin1', 4, 8) === 'ftyp' && !/^(heic|heix|hevc|heim|heis|mif1|msf1|avif|avis|crx )/.test(b.toString('latin1', 8, 12)) },
  { mime: 'video/webm', test: b => b.length > 4 && b.readUInt32BE(0) === 0x1a45dfa3 },
];
const hostOf = u => { try { return new URL(u).host; } catch (e) { return String(u); } };
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// a plain page in the site's style, for links opened from emails
const simplePage = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Venom Board</title><link rel="icon" href="/favicon.svg"><link rel="stylesheet" href="/web/site.css"></head>
<body><main class="wrap" style="max-width:640px;padding:96px 20px"><h1 style="font-size:28px">${esc(title)}</h1>${body}
<p style="margin-top:28px"><a class="btn" href="/">Back to Venom Board</a></p></main></body></html>`;

async function start(overrides = {}, hooks = {}) {
  const cfg = config(overrides);
  const log = cfg.QUIET ? () => {} : (...a) => console.log(new Date().toISOString(), ...a);
  const db = openDb(cfg.DATA_DIR);
  const sessions = A.sessions(db, cfg.SESSION_DAYS);
  const limiter = A.rateLimiter();
  const limit = (key, max, windowMs) => limiter(key, max * cfg.RATE_SCALE, windowMs);
  const deliver = hooks.mail || mailer(cfg, log);
  // a random key made on first start and kept with the data: it signs the links in notification emails
  const secretFile = path.join(cfg.DATA_DIR, 'secret.key');
  if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  const secret = fs.readFileSync(secretFile, 'utf8').trim();
  // Every email counts toward a daily total kept under the mailbox provider's sending limit (MAIL_DAILY_LIMIT).
  // Sign-in emails (confirmations, password resets) and alerts may use all of it; invites and notifications stop
  // at three quarters, so they can never crowd out the emails people need to get into their accounts.
  const mailDay = { get: db.prepare('SELECT sent FROM mail_days WHERE day = ?'), bump: db.prepare('INSERT INTO mail_days (day, sent) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET sent = sent + 1') };
  let mailAlertDay = '';
  function mail(kind, msg) {
    const day = new Date().toISOString().slice(0, 10), sent = (mailDay.get.get(day) || { sent: 0 }).sent;
    const soft = Math.floor(cfg.MAIL_DAILY_LIMIT * 0.75);
    const cap = kind === 'account' || kind === 'alert' ? cfg.MAIL_DAILY_LIMIT : kind === 'verify' ? Math.floor(cfg.MAIL_DAILY_LIMIT / 2) : soft;
    if (!msg.to || sent >= cap) { log(`[mail] not sent (${kind}${msg.to ? ', daily limit reached' : ', no address'}): ${msg.subject}`); return Promise.resolve(false); }
    mailDay.bump.run(day);
    const out = send(msg, kind === 'account' || kind === 'alert');
    if (sent + 1 >= soft && mailAlertDay !== day && kind !== 'alert') {
      mailAlertDay = day;
      mail('alert', { to: cfg.ALERT_EMAIL, subject: 'Venom Board: three quarters of today’s emails are used',
        text: `${sent + 1} of today's ${cfg.MAIL_DAILY_LIMIT} emails have gone out (UTC day ${day}). Notifications and invites pause for the rest of the day; sign-in emails keep going.\n\nIf this keeps happening with normal use, raise MAIL_DAILY_LIMIT in server/.env (staying under your mailbox provider's limit), or move email to a sending service.` });
    }
    return out;
  }
  // The mailbox also limits how fast mail goes out (MAIL_PER_10_MIN), so emails are sent one at a time and any
  // beyond the limit wait their turn. Sign-in emails and alerts go to the front of the line.
  const outbox = [], recent = [];
  let busy = false, outboxTimer = null;
  function send(msg, urgent) {
    return new Promise(resolve => {
      if (outbox.length >= 2000 && !urgent) { log(`[mail] outbox full, not sent: ${msg.subject}`); resolve(false); return; }
      const job = { msg, resolve, urgent };
      if (urgent) { const i = outbox.findIndex(j => !j.urgent); outbox.splice(i < 0 ? outbox.length : i, 0, job); } else outbox.push(job);
      pump();
    });
  }
  function pump() {
    if (busy || !outbox.length) return;
    const now = Date.now();
    while (recent.length && now - recent[0] >= 600000) recent.shift();
    if (recent.length >= cfg.MAIL_PER_10_MIN) {
      if (!outboxTimer) { outboxTimer = setTimeout(() => { outboxTimer = null; pump(); }, 600000 - (now - recent[0]) + 50); outboxTimer.unref(); }
      return;
    }
    const job = outbox.shift();
    recent.push(now); busy = true;
    Promise.resolve().then(() => deliver(job.msg)).then(ok => job.resolve(ok), () => job.resolve(false)).finally(() => { busy = false; pump(); });
  }
  // Email caps have two jobs: no inbox can be flooded, and no owner can be cut off from the emails they need.
  //  - Each account has its own reset and confirmation allowance, which nothing done to other accounts touches.
  //  - Accounts on extra spellings of one inbox (name+1@…, n.a.m.e@gmail.com) share a single small daily
  //    allowance, so making more of them never means more email. The inbox's own account is exempt: the one
  //    that's confirmed, uses the plain spelling, or was registered on that inbox first.
  //  - Requests aimed at your own account only ever send you working links (earlier links stay valid), and
  //    past the daily cap a reset still goes out every 6 hours, so the owner can always get back in.
  //  - Invites are capped per inbox, since the sender chooses who they go to.
  const DAY = 86400000, HOUR = 3600000, MB = 1048576;
  const inboxOwner = u => !!u.email_verified || inboxKey(u.email) === String(u.email).toLowerCase() || (q.oldestOnInbox.get(u.inbox) || {}).id === u.id;
  const sharedInbox = (kind, u) => inboxOwner(u) || limit(`mail-${kind}-inbox:` + u.inbox, 5, DAY);
  const resetQuota = u =>
    limit('mail-reset:' + u.id, 3, HOUR) && (limit('mail-reset-day:' + u.id, 6, DAY) || limit('mail-reset-slow:' + u.id, 1, 6 * HOUR))
    && sharedInbox('reset', u)
    && (limit('mail-all-reset', 200, HOUR) || limit('mail-reset-first:' + u.id, 1, HOUR));  // a site-wide flood can't block recovery
  // Resets asked for from a device that has signed in to the account draw on a separate allowance for the
  // account (not per device), which strangers can't touch, so the owner can always get a link but holding
  // many device tokens doesn't mean more email.
  const knownDeviceResetQuota = u =>
    limit('mail-reset-known:' + u.id, 3, HOUR) && limit('mail-reset-known-day:' + u.id, 6, DAY) && sharedInbox('reset', u);
  // the confirmation sent at sign-up counts toward the site-wide ceiling; a resend the account asks for itself doesn't
  const verifyQuota = (u, requested) =>
    limit('mail-verify:' + u.id, 3, HOUR) && limit('mail-verify-day:' + u.id, 6, DAY)
    && sharedInbox('verify', u)
    && (requested ? limit('mail-verify-all', 100, HOUR) : limit('mail-all', 300, HOUR));
  const inviteQuota = to => limit('mail-invite:' + inboxKey(to), 3, DAY) && limit('mail-all', 300, HOUR);
  // names people choose go into emails as plain words, never as links someone could be lured into clicking
  const plain = (s, max = 60) => String(s).replace(/\s+/g, ' ').replace(/(https?:\/\/|www\.)\S*/gi, '').trim().slice(0, max) || 'A teammate';
  const SAN = { assetBase: cfg.PUBLIC_URL + '/assets/' };
  const assetDir = path.join(cfg.DATA_DIR, 'assets');
  const diskFree = () => { try { const s = fs.statfsSync(assetDir); return s.bavail * s.bsize; } catch (e) { return Infinity; } };
  const diskOk = () => diskFree() > cfg.MIN_FREE_DISK_MB * MB;
  const dummyHash = await A.hashPassword(A.newToken());  // keeps sign-in timing the same for unknown accounts
  const { fail } = H;
  let live;

  const q = {
    userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
    verifiedByEmail: db.prepare('SELECT id FROM users WHERE email = ? AND email_verified = 1'),
    userByUsername: db.prepare('SELECT * FROM users WHERE username = ?'),
    userByLogin: db.prepare('SELECT * FROM users WHERE email = ? OR username = ?'),
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    insertUser: db.prepare('INSERT INTO users (id, email, username, display_name, pass_hash, color, created_at, inbox) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    setInbox: db.prepare('UPDATE users SET inbox = ? WHERE id = ?'),
    oldestOnInbox: db.prepare('SELECT id FROM users WHERE inbox = ? ORDER BY created_at, id LIMIT 1'),
    setDisplayName: db.prepare('UPDATE users SET display_name = ? WHERE id = ?'),
    setColor: db.prepare('UPDATE users SET color = ? WHERE id = ?'),
    setPassword: db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?'),
    deleteUser: db.prepare('DELETE FROM users WHERE id = ?'),
    dropSessions: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
    dropOtherSessions: db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?'),
    countOtherSessions: db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND token_hash != ? AND expires_at > ?'),
    insertReset: db.prepare('INSERT INTO resets (token_hash, user_id, expires_at) VALUES (?, ?, ?)'),
    findReset: db.prepare('SELECT * FROM resets WHERE token_hash = ?'),
    dropReset: db.prepare('DELETE FROM resets WHERE token_hash = ? OR expires_at < ?'),
    dropUserResets: db.prepare('DELETE FROM resets WHERE user_id = ?'),
    insertVerify: db.prepare('INSERT INTO verifies (token_hash, user_id, expires_at) VALUES (?, ?, ?)'),
    findVerify: db.prepare('SELECT * FROM verifies WHERE token_hash = ?'),
    dropVerifies: db.prepare('DELETE FROM verifies WHERE user_id = ? OR expires_at < ?'),
    dropExpiredVerifies: db.prepare('DELETE FROM verifies WHERE expires_at < ?'),
    insertDevice: db.prepare('INSERT INTO devices (token_hash, user_id, created_at, last_used) VALUES (?, ?, ?, ?)'),
    findDevice: db.prepare('SELECT * FROM devices WHERE token_hash = ?'),
    touchDevice: db.prepare('UPDATE devices SET last_used = ? WHERE token_hash = ?'),
    purgeDevices: db.prepare('DELETE FROM devices WHERE last_used < ?'),
    dropDevices: db.prepare('DELETE FROM devices WHERE user_id = ?'),
    trimDevices: db.prepare(`DELETE FROM devices WHERE user_id = ? AND token_hash NOT IN
      (SELECT token_hash FROM devices WHERE user_id = ? ORDER BY last_used DESC LIMIT 20)`),
    setVerified: db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?'),
    teamsFor: db.prepare(`SELECT t.id, t.name, m.role,
        (SELECT COUNT(*) FROM members x WHERE x.team_id = t.id) AS members,
        (SELECT COUNT(*) FROM projects p WHERE p.team_id = t.id) AS projects
      FROM members m JOIN teams t ON t.id = m.team_id WHERE m.user_id = ? ORDER BY t.name COLLATE NOCASE`),
    invitesFor: db.prepare(`SELECT i.id, i.role, i.created_at, t.id AS team_id, t.name AS team_name, u.display_name AS from_name
      FROM invites i JOIN teams t ON t.id = i.team_id LEFT JOIN users u ON u.id = i.invited_by
      WHERE (i.user_id = ? OR (i.user_id IS NULL AND i.email = ?))
        AND NOT EXISTS (SELECT 1 FROM members m WHERE m.team_id = i.team_id AND m.user_id = ?) ORDER BY i.created_at DESC`),
    role: db.prepare('SELECT role FROM members WHERE team_id = ? AND user_id = ?'),
    team: db.prepare('SELECT * FROM teams WHERE id = ?'),
    insertTeam: db.prepare('INSERT INTO teams (id, name, created_by, created_at) VALUES (?, ?, ?, ?)'),
    renameTeam: db.prepare('UPDATE teams SET name = ? WHERE id = ?'),
    deleteTeam: db.prepare('DELETE FROM teams WHERE id = ?'),
    members: db.prepare(`SELECT u.id, u.username, u.display_name, u.color, m.role, m.joined_at FROM members m JOIN users u ON u.id = m.user_id
      WHERE m.team_id = ? ORDER BY CASE m.role WHEN 'leader' THEN 0 WHEN 'admin' THEN 1 WHEN 'editor' THEN 2 ELSE 3 END, u.display_name COLLATE NOCASE`),
    insertMember: db.prepare('INSERT OR IGNORE INTO members (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)'),
    setRole: db.prepare('UPDATE members SET role = ? WHERE team_id = ? AND user_id = ?'),
    removeMember: db.prepare('DELETE FROM members WHERE team_id = ? AND user_id = ?'),
    teamInvites: db.prepare(`SELECT i.id, i.role, i.email, i.created_at, u.username, u.display_name FROM invites i
      LEFT JOIN users u ON u.id = i.user_id WHERE i.team_id = ? ORDER BY i.created_at DESC`),
    pendingInvite: db.prepare('SELECT id FROM invites WHERE team_id = ? AND (user_id = ? OR email = ?)'),
    invitesTo: db.prepare('SELECT user_id, email FROM invites WHERE team_id = ?'),
    insertInvite: db.prepare('INSERT INTO invites (id, team_id, user_id, email, role, invited_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    dropInvitesBy: db.prepare('DELETE FROM invites WHERE team_id = ? AND invited_by = ?'),
    invite: db.prepare('SELECT * FROM invites WHERE id = ?'),
    deleteInvite: db.prepare('DELETE FROM invites WHERE id = ?'),
    projects: db.prepare(`SELECT p.id, p.name, p.updated_at, u.display_name AS updated_by FROM projects p
      LEFT JOIN users u ON u.id = p.updated_by WHERE p.team_id = ? ORDER BY p.updated_at DESC`),
    teamProjectIds: db.prepare('SELECT id FROM projects WHERE team_id = ?'),
    project: db.prepare('SELECT * FROM projects WHERE id = ?'),
    insertProject: db.prepare('INSERT INTO projects (id, team_id, name, doc, version, created_by, created_at, updated_at, updated_by, doc_bytes) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?)'),
    renameProject: db.prepare('UPDATE projects SET name = ? WHERE id = ?'),
    deleteProject: db.prepare('DELETE FROM projects WHERE id = ?'),
    insertAsset: db.prepare('INSERT INTO assets (id, project_id, mime, size, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
    asset: db.prepare('SELECT * FROM assets WHERE id = ?'),
    projectAssets: db.prepare('SELECT id FROM assets WHERE project_id = ?'),
    teamAssetBytes: db.prepare('SELECT COALESCE(SUM(a.size), 0) AS bytes FROM assets a JOIN projects p ON p.id = a.project_id WHERE p.team_id = ?'),
    leaderAssetBytes: db.prepare(`SELECT COALESCE(SUM(a.size), 0) AS bytes FROM assets a JOIN projects p ON p.id = a.project_id
      JOIN members m ON m.team_id = p.team_id AND m.role = 'leader' WHERE m.user_id = ?`),
    // everything a team keeps: images, boards and their version history
    teamStorage: db.prepare(`SELECT
        (SELECT COALESCE(SUM(a.size), 0) FROM assets a JOIN projects p ON p.id = a.project_id WHERE p.team_id = @team)
      + (SELECT COALESCE(SUM(v.size), 0) FROM versions v JOIN projects p ON p.id = v.project_id WHERE p.team_id = @team)
      + (SELECT COALESCE(SUM(doc_bytes), 0) FROM projects WHERE team_id = @team)
      + (SELECT COALESCE(SUM(pv.size), 0) FROM previews pv JOIN projects p ON p.id = pv.project_id WHERE p.team_id = @team)
      + (SELECT COALESCE(SUM(rp.size), 0) FROM roadmap_previews rp JOIN projects p ON p.id = rp.project_id WHERE p.team_id = @team) AS bytes`),
    leaderStorage: db.prepare(`WITH led AS (SELECT team_id FROM members WHERE user_id = @user AND role = 'leader') SELECT
        (SELECT COALESCE(SUM(a.size), 0) FROM assets a JOIN projects p ON p.id = a.project_id WHERE p.team_id IN led)
      + (SELECT COALESCE(SUM(v.size), 0) FROM versions v JOIN projects p ON p.id = v.project_id WHERE p.team_id IN led)
      + (SELECT COALESCE(SUM(doc_bytes), 0) FROM projects WHERE team_id IN led)
      + (SELECT COALESCE(SUM(pv.size), 0) FROM previews pv JOIN projects p ON p.id = pv.project_id WHERE p.team_id IN led)
      + (SELECT COALESCE(SUM(rp.size), 0) FROM roadmap_previews rp JOIN projects p ON p.id = rp.project_id WHERE p.team_id IN led) AS bytes`),
    teamLeader: db.prepare("SELECT user_id FROM members WHERE team_id = ? AND role = 'leader'"),
    memberCount: db.prepare('SELECT COUNT(*) AS n FROM members WHERE team_id = ?'),
    inviteCount: db.prepare('SELECT COUNT(*) AS n FROM invites WHERE team_id = ?'),
    projectCount: db.prepare('SELECT COUNT(*) AS n FROM projects WHERE team_id = ?'),
    projectsMadeBy: db.prepare('SELECT COUNT(*) AS n FROM projects WHERE created_by = ?'),
    setTotpPending: db.prepare('UPDATE users SET totp_pending = ? WHERE id = ?'),
    enableTotp: db.prepare("UPDATE users SET totp_secret = totp_pending, totp_pending = '', totp_last = ? WHERE id = ?"),
    disableTotp: db.prepare("UPDATE users SET totp_secret = '', totp_pending = '', totp_last = 0 WHERE id = ?"),
    setTotpLast: db.prepare('UPDATE users SET totp_last = ? WHERE id = ?'),
    addRecovery: db.prepare('INSERT OR IGNORE INTO recovery_codes (user_id, code_hash) VALUES (?, ?)'),
    useRecovery: db.prepare('DELETE FROM recovery_codes WHERE user_id = ? AND code_hash = ?'),
    dropRecovery: db.prepare('DELETE FROM recovery_codes WHERE user_id = ?'),
    recoveryLeft: db.prepare('SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ?'),
    setPrefs: db.prepare('UPDATE users SET notify_mentions = ?, notify_due = ?, timezone = ? WHERE id = ?'),
  };

  for (const u of db.prepare('SELECT id, email FROM users WHERE inbox IS NULL').all()) q.setInbox.run(inboxKey(u.email), u.id);

  const publicUser = u => ({ id: u.id, username: u.username, displayName: u.display_name ?? u.displayName, color: u.color, email: u.email, emailVerified: !!(u.email_verified ?? u.emailVerified) });
  const roleOf = (teamId, userId) => (q.role.get(teamId, userId) || {}).role || null;
  // What each account and team may have (see config). An account that hasn't confirmed its email gets a
  // trial-sized allowance, so throwaway sign-ups can't be used to fill the server or spread spam.
  const allowance = u => ({
    teamsLed: u.emailVerified ? cfg.LIMIT_TEAMS_LED : Math.min(cfg.LIMIT_UNVERIFIED_TEAMS, cfg.LIMIT_TEAMS_LED),
    teamsJoined: cfg.LIMIT_TEAMS_JOINED,
    projectsPerTeam: cfg.LIMIT_TEAM_PROJECTS,
    membersPerTeam: cfg.LIMIT_TEAM_MEMBERS,
    projectsUntilConfirmed: u.emailVerified ? null : cfg.LIMIT_UNVERIFIED_PROJECTS,
    projectMB: cfg.PROJECT_MAX_MB,
    teamStorageMB: u.emailVerified ? cfg.TEAM_STORAGE_MB : Math.min(cfg.TEAM_STORAGE_MB, cfg.LIMIT_UNVERIFIED_STORAGE_MB),
    leaderStorageMB: u.emailVerified ? cfg.LEADER_STORAGE_MB : Math.min(cfg.LEADER_STORAGE_MB, cfg.LIMIT_UNVERIFIED_STORAGE_MB),
  });
  // Everything a team keeps on the server counts toward its storage: images, boards and their version history.
  // Each team has an allowance, and so do all the teams one account leads together (less until that account
  // confirms its email), so nobody can fill the server by making more teams or projects. When the disk itself
  // runs low, nothing grows until there's room again. Live editing asks often, so answers are kept a few seconds.
  const storageSeen = new Map();
  function storage(teamId, fresh) {
    const seen = storageSeen.get(teamId);
    if (seen && !fresh && Date.now() - seen.at < 5000) return seen;
    const leader = q.teamLeader.get(teamId), lu = leader ? q.userById.get(leader.user_id) : null;
    const verified = !!(lu && lu.email_verified);
    const teamMax = (verified ? cfg.TEAM_STORAGE_MB : Math.min(cfg.TEAM_STORAGE_MB, cfg.LIMIT_UNVERIFIED_STORAGE_MB)) * MB;
    const leaderMax = (verified ? cfg.LEADER_STORAGE_MB : Math.min(cfg.LEADER_STORAGE_MB, cfg.LIMIT_UNVERIFIED_STORAGE_MB)) * MB;
    const team = q.teamStorage.get({ team: teamId }).bytes, led = leader ? q.leaderStorage.get({ user: leader.user_id }).bytes : team;
    const mb = n => Math.round(n / MB * 10) / 10;
    let left = teamMax - team, why = `This team has used all ${mb(teamMax)} MB of its storage (images, boards and their history).`;
    if (leaderMax - led < left) { left = leaderMax - led; why = `The teams this team’s leader runs have used all ${mb(leaderMax)} MB of their shared storage (images, boards and their history).`; }
    if (!diskOk()) { left = Math.min(left, 0); why = 'The server is short on space right now. Try again later.'; }
    const out = { at: Date.now(), team, teamMax, left, why };
    storageSeen.set(teamId, out);
    return out;
  }
  const teamFull = teamId => q.memberCount.get(teamId).n + q.inviteCount.get(teamId).n >= cfg.LIMIT_TEAM_MEMBERS;
  function needRole(teamId, user, min) {
    const role = okId(teamId) ? roleOf(teamId, user.id) : null;
    if (!role) fail(404, 'not_found', 'Team not found.');
    if (RANK[role] < RANK[min]) fail(403, 'forbidden', `Only a ${ROLE_LABEL[min]} or higher can do that.`);
    return role;
  }
  function needProject(projectId, user, min) {
    const p = okId(projectId) ? q.project.get(projectId) : null;
    if (!p) fail(404, 'not_found', 'Project not found.');
    // a teammate can have a different role in one project than in the team (projectroles.js)
    const teamRole = needRole(p.team_id, user, 'viewer'), role = PR.effective(p.id, p.team_id, user.id, teamRole);
    if (RANK[role] < RANK[min]) fail(403, 'forbidden', `Only a ${ROLE_LABEL[min]} or higher can do that${role !== teamRole ? ' in this project' : ''}.`);
    return { p, role };
  }
  // leaders grant admin and below; admins grant editor and viewer
  const canGrant = (actor, role) => (actor === 'leader' ? ['admin', 'editor', 'viewer'] : actor === 'admin' ? ['editor', 'viewer'] : []).includes(role);
  const canManage = (actor, target) => (actor === 'leader' ? target !== 'leader' : actor === 'admin' ? RANK[target] < RANK.admin : false);
  const removeAssetFiles = projectId => {
    for (const a of q.projectAssets.all(projectId)) fs.rm(path.join(assetDir, a.id), { force: true }, () => {});
  };
  // Invites sent to an email address only show up for an account that has proved it owns that address.
  // They stay addressed to the email (never resolved to an account), so whoever sent one can't learn
  // which account, if any, the address belongs to.
  async function sendVerify(u, welcome) {
    if (!verifyQuota(u, !welcome)) return false;  // links already sent keep working
    const token = A.newToken();
    q.dropExpiredVerifies.run(Date.now());
    q.insertVerify.run(A.tokenHash(token), u.id, Date.now() + 7 * 86400000);
    return mail('verify', { to: u.email, subject: welcome ? 'Welcome to Venom Board: confirm your email' : 'Confirm your Venom Board email',
      text: `Hi ${plain(u.display_name, 40)},\n\n${welcome ? 'Thanks for making a Venom Board account. ' : ''}Confirm this email address so team invites sent to it can reach you:\n${cfg.PUBLIC_URL}/account#verify=${token}\n\nThe link works for 7 days. If you didn't make this account, you can ignore this email.` });
  }
  function markVerified(userId) {
    const u = q.userById.get(userId);
    if (!u) return;
    db.transaction(() => { q.setVerified.run(u.id); q.dropVerifies.run(u.id, Date.now()); })();
    live.invitesChanged(u.id);  // invites sent to the address show up now
  }

  function signedIn(ctx, userId, web) {
    // the site cookie is only handed out to our own pages, so another site can't sign a visitor into an account
    if (web && !ctx.fromSite) fail(403, 'forbidden', 'Sign in from the Venom Board website.');
    const token = sessions.create(userId), u = q.userById.get(userId);
    if (web) ctx.headers['Set-Cookie'] = [H.cookie(H.sessionName(cfg.SECURE_COOKIES), token, { maxAge: cfg.SESSION_DAYS * 86400, secure: cfg.SECURE_COOKIES }), ...H.oldSessionGone(cfg.SECURE_COOKIES)];
    return web ? { user: publicUser(u) } : { token, user: publicUser(u) };
  }
  // hands this device its token for the account (a new one unless it already has one): a cookie scoped to
  // the sign-in endpoints for the website, a field in the answer for the apps
  // Device tokens are revoked whenever the password is reset or changed, and an account keeps at most 20.
  function rememberDevice(ctx, out, userId, web, existing) {
    let dev = existing;
    if (!dev) {
      dev = A.newToken();
      q.insertDevice.run(A.tokenHash(dev), userId, Date.now(), Date.now());
      q.trimDevices.run(userId, userId);
    }
    if (web) {
      const c = H.cookie('vb_device', dev, { maxAge: 400 * 86400, secure: cfg.SECURE_COOKIES, path: '/api/auth' }), prev = ctx.headers['Set-Cookie'];
      ctx.headers['Set-Cookie'] = prev ? [].concat(prev, c) : c;
    } else out.device = dev;
    return out;
  }

  /* ---------- routes ---------- */
  const routes = [];
  const route = (method, pattern, handler, opts = {}) =>
    routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[\\w-]+)') + '$'), handler, opts });
  const PR = projectRoles({ db, route, fail, H, limit, needProject, getLive: () => live });
  const C = collab({ db, cfg, log, route, fail, H, A, limit, needRole, needProject, plain, mail, getLive: () => live, diskOk, storage, secret, fetch: hooks.fetch });
  const G = gitlink({ db, cfg, log, route, fail, H, A, limit, needRole, plain, getLive: () => live });
  const M = mcp({ db, cfg, log, route, fail, H, A, limit, RANK, live: () => live, roleOf, projectRole: (p, userId) => PR.effective(p.id, p.team_id, userId), makeProject: (...a) => makeProject(...a), members: C.members,
    storeAsset: (...a) => storeAsset(...a), assetInfo: id => q.asset.get(id), assetPath: id => path.join(assetDir, id), uploadMax: () => UPLOAD_MAX,
    callRoute: (...a) => callRoute(...a),
    version: require('../package.json').version, passwordOk: async (userId, password) => checkPassword(q.userById.get(userId), password, 'That password is wrong.') });
  const CAL = ical({ db, cfg, route, fail, A, limit, secret, live: () => live });  // private calendar feeds
  const ADM = !admin ? { watch() {}, pageAccess: () => 'none', close() {} } : admin({ db, cfg, log, route, fail, H, sessions, live: () => live, teamBytes: id => storage(id).team, diskFree, limit, fetch: hooks.fetch });
  // playtest feedback forms (/f/<token>) and the in-game bug reporter (/api/report)
  const IN = intake({ db, cfg, log, route, fail, H, A, limit, needProject, live: () => live, storeAsset: (...a) => storeAsset(...a), secret });
  // screenshot links (/s/<id>) from the apps' screenshot tool
  const SH = shots({ db, cfg, log, route, fail, H, limit, mail, plain, secret, diskFree, sendHtml: (...a) => sendHtml(...a), simplePage });

  // Two-step sign-in. After a correct password, an account that has it on gets a ticket valid for five minutes
  // and five tries, and only a code from the authenticator app (or a one-time recovery code) turns it into a session.
  const tickets = new Map();
  function secondFactor(u, code) {
    const step = T.check(u.totp_secret, code, u.totp_last);
    if (step) { q.setTotpLast.run(step, u.id); return true; }
    const rc = T.normalizeRecovery(code);
    return rc.length === 8 && q.useRecovery.run(u.id, A.tokenHash(rc)).changes > 0;
  }

  route('GET', '/api/health', () => ({ ok: true }), { auth: false });

  // Who's signed in, if anyone. Pages ask this first, so a signed-out visitor isn't answered with an error
  // (a 401 shows up red in the browser console and looks like something broke).
  route('GET', '/api/session', ctx => ({ user: ctx.user ? publicUser(ctx.user) : null }), { auth: false });

  // Sign-up limits count what matters. Mistakes in the form (a typo, a taken username, a short password) only use
  // a generous allowance of tries; usernames are public, so a taken one is checked first and costs nothing more.
  // Every request that gets as far as the email check uses a tighter allowance, whatever the answer, so the form
  // can't be used to find out which addresses have accounts. The strictest limits count accounts actually made.
  route('POST', '/api/auth/signup', async ctx => {
    if (!limit('signup-try:' + ctx.ip, 60, 600000)) fail(429, 'rate', 'That’s a lot of tries in a short time. Wait a few minutes, then try again.');
    const b = await H.readJson(ctx.req);
    const email = txt(b.email, 254).trim(), username = txt(b.username, 24).trim(), password = txt(b.password, 200);
    const displayName = txt(b.displayName, 40).trim() || username;
    if (!EMAIL.test(email)) fail(400, 'email', 'Enter a valid email address.');
    if (!USERNAME.test(username)) fail(400, 'username', 'Usernames are 3–24 characters: letters, numbers or underscores.');
    if (password.length < 8) fail(400, 'password', 'Use at least 8 characters for your password.');
    if (q.userByUsername.get(username)) fail(409, 'username_taken', 'That username is taken.');
    if (!limit('signup-check:' + ctx.ip, 10, 600000)) fail(429, 'rate', 'That’s a lot of tries in a short time. Wait a few minutes, then try again.');
    if (q.userByEmail.get(email)) fail(409, 'email_taken', 'An account with that email already exists. Sign in, or use “Forgot password” if you can’t.');
    if (!limit('signup:' + ctx.ip, 10, 600000) || !limit('signup-day:' + ctx.ip, 50, DAY)) fail(429, 'rate', 'Too many new accounts from this network. Try again later.');
    const id = A.newId(), hash = await A.hashPassword(password);
    try { q.insertUser.run(id, email, username, displayName, hash, COLORS[Math.floor(Math.random() * COLORS.length)], Date.now(), inboxKey(email)); }
    catch (e) { fail(409, 'taken', 'That email or username was just taken. Try another.'); }
    sendVerify(q.userById.get(id), true).catch(e => log('[mail]', e.message));  // sent in the background
    log('[auth] new account', username);
    return rememberDevice(ctx, signedIn(ctx, id, b.web === true), id, b.web === true, null);
  }, { auth: false });

  route('POST', '/api/auth/login', async ctx => {
    const b = await H.readJson(ctx.req);
    const login = txt(b.login, 254).trim(), password = txt(b.password, 200), web = b.web === true;
    const u = q.userByLogin.get(login, login), acct = u ? u.id : login.toLowerCase();
    // A device that has signed in to this account before carries a device token. Attempts from it are only
    // limited per device, so however hard strangers hammer the account, its owner can still get in.
    // Everyone else is limited per network, per account from each network, and per account overall, which
    // keeps guessing slow even from many addresses. A password reset clears the per-account block.
    const deviceToken = web ? (ctx.fromSite ? H.parseCookies(ctx.req).vb_device || '' : '') : txt(b.device, 200);
    const device = deviceToken && u ? q.findDevice.get(A.tokenHash(deviceToken)) : null;
    const trusted = !!(device && device.user_id === u.id);
    const allowed = trusted
      ? limit('login-dev:' + device.token_hash, 10, 600000)
      : limit('login-ip:' + ctx.ip, 30, 600000) && limit('login:' + acct + '|' + ctx.ip, 10, 600000) && limit('login-acct:' + acct, 30, 3600000);
    if (!allowed) fail(429, 'rate', 'Too many sign-in attempts. Wait a while and try again, or reset your password.');
    const ok = await A.verifyPassword(password, u ? u.pass_hash : dummyHash);
    if (!u || !ok) fail(401, 'bad_login', "That email or username and password don't match.");
    if (trusted) q.touchDevice.run(Date.now(), device.token_hash);
    if (u.totp_secret) {
      const ticket = A.newToken();
      tickets.set(A.tokenHash(ticket), { userId: u.id, pass: u.pass_hash, web, device: trusted ? deviceToken : null, expires: Date.now() + 5 * 60000, tries: 0 });
      return { twoFactor: true, ticket };
    }
    return rememberDevice(ctx, signedIn(ctx, u.id, web), u.id, web, trusted ? deviceToken : null);
  }, { auth: false });

  route('POST', '/api/auth/2fa', async ctx => {
    const b = await H.readJson(ctx.req), key = A.tokenHash(txt(b.ticket, 200)), t = tickets.get(key);
    if (!t || t.expires < Date.now()) { tickets.delete(key); fail(400, 'expired', 'That took too long. Sign in again.'); }
    if (++t.tries > 5) { tickets.delete(key); fail(429, 'rate', 'Too many wrong codes. Sign in again.'); }
    if (!limit('2fa:' + t.userId, 10, 15 * 60000)) fail(429, 'rate', 'Too many wrong codes. Wait a few minutes, then sign in again.');
    if (!limit('2fa-day:' + t.userId + (t.device ? ':device' : ''), t.device ? 60 : 30, DAY)) fail(429, 'rate', 'Too many wrong codes today. Try again tomorrow, or from a device you’ve signed in on before.');
    const u = q.userById.get(t.userId);
    if (!u || !u.totp_secret || u.pass_hash !== t.pass || !secondFactor(u, b.code)) fail(401, 'bad_code', 'That code didn’t work. Use the newest code in your authenticator app, or one of your recovery codes.');
    tickets.delete(key);
    return rememberDevice(ctx, signedIn(ctx, u.id, t.web), u.id, t.web, t.device);
  }, { auth: false });

  route('POST', '/api/auth/logout', ctx => {
    if (ctx.auth.via === 'cookie' && !ctx.fromSite) fail(403, 'forbidden', 'Sign out from the Venom Board website.');
    sessions.destroy(ctx.auth.token);
    if (ctx.auth.token) live.signedOut(ctx.auth.token);
    ctx.headers['Set-Cookie'] = [H.cookie(H.sessionName(cfg.SECURE_COOKIES), '', { maxAge: 0, secure: cfg.SECURE_COOKIES }), ...H.oldSessionGone(cfg.SECURE_COOKIES)];
    return { ok: true };
  }, { auth: false });

  route('POST', '/api/auth/forgot', async ctx => {
    if (!limit('forgot:' + ctx.ip, 5, 600000)) fail(429, 'rate', 'Too many reset requests. Try again later.');
    const b = await H.readJson(ctx.req);
    const u = q.userByEmail.get(txt(b.email, 254).trim());
    // Someone else can keep requesting resets for an address, but that can't lock its owner out:
    //  - a device that has signed in to the account before uses an allowance strangers can't use up;
    //  - links work for 24 hours and earlier ones stay valid, so whenever the account's allowance is used up,
    //    a link sent within the last day is already in the owner's inbox and still works.
    const deviceToken = ctx.fromSite ? H.parseCookies(ctx.req).vb_device || '' : txt(b.device, 200);
    const device = deviceToken && u ? q.findDevice.get(A.tokenHash(deviceToken)) : null;
    const known = !!(device && device.user_id === u.id);
    if (u && (known ? knownDeviceResetQuota(u) : resetQuota(u))) {
      const token = A.newToken();
      q.dropReset.run('', Date.now());
      q.insertReset.run(A.tokenHash(token), u.id, Date.now() + DAY);
      mail('account', { to: u.email, subject: 'Reset your Venom Board password',
        text: `Hi ${plain(u.display_name, 40)},\n\nUse this link within the next 24 hours to choose a new password:\n${cfg.PUBLIC_URL}/account#reset=${token}\n\nIf you didn't ask for this, you can ignore this email; your password stays the same.` });
    }
    return { ok: true };  // same answer, and the same speed, either way (mail goes out in the background), so emails can't be probed
  }, { auth: false });

  route('POST', '/api/auth/reset', async ctx => {
    const b = await H.readJson(ctx.req);
    const password = txt(b.password, 200), h = A.tokenHash(txt(b.token, 200));
    const r = q.findReset.get(h);
    if (!r || r.expires_at < Date.now()) fail(400, 'expired', 'That reset link has expired. Ask for a new one.');
    if (password.length < 8) fail(400, 'password', 'Use at least 8 characters for your password.');
    q.setPassword.run(await A.hashPassword(password), r.user_id);
    q.dropUserResets.run(r.user_id);  // every other outstanding link stops working too
    q.dropSessions.run(r.user_id);  // sign out everywhere, including open live connections
    M.revokeAll(r.user_id);  // and MCP access tokens
    CAL.revokeAll(r.user_id);  // and the calendar feed address
    live.userSignedOut(r.user_id);
    q.dropDevices.run(r.user_id);  // devices that knew the old password are no longer trusted
    limiter.clear('login-acct:' + r.user_id);
    markVerified(r.user_id);  // the link came from their inbox, so the address is theirs
    // The browser that used the link becomes a trusted device, so its owner can sign in straight away even
    // if someone keeps hammering the account. Only our own pages get the cookie.
    return ctx.fromSite ? rememberDevice(ctx, { ok: true }, r.user_id, true, null) : { ok: true };
  }, { auth: false });

  route('POST', '/api/auth/verify', async ctx => {
    if (!limit('verify-ip:' + ctx.ip, 30, 600000)) fail(429, 'rate', 'Too many attempts. Try again in a few minutes.');
    const v = q.findVerify.get(A.tokenHash(txt((await H.readJson(ctx.req)).token, 200)));
    if (!v || v.expires_at < Date.now()) fail(400, 'expired', 'That confirmation link has expired or was already used. Sign in and send a new one.');
    markVerified(v.user_id);
    return { ok: true };
  }, { auth: false });

  route('POST', '/api/auth/verify/resend', async ctx => {
    const u = q.userById.get(ctx.user.id);
    if (u.email_verified) return { ok: true, verified: true };
    if (!limit('verify:' + u.id, 5, 3600000)) fail(429, 'rate', 'We already sent a few. Check your spam folder, or try again in an hour.');
    sendVerify(u, false).catch(e => log('[mail]', e.message));
    return { ok: true };
  });

  route('GET', '/api/me', ctx => {
    const u = ctx.user;
    return {
      user: { ...u },
      teams: q.teamsFor.all(u.id),
      invites: q.invitesFor.all(u.id, u.emailVerified ? u.email : '', u.id).map(i => ({ id: i.id, role: i.role, createdAt: i.created_at, team: { id: i.team_id, name: i.team_name }, from: i.from_name })),
      sessions: { others: q.countOtherSessions.get(u.id, A.tokenHash(ctx.auth.token), Date.now()).n },
      colors: COLORS,
      limits: allowance(u),
      ...(full => ({
        security: { twoFactor: !!full.totp_secret, recoveryLeft: q.recoveryLeft.get(u.id).n },
        notify: { mentions: !!full.notify_mentions, due: !!full.notify_due, timezone: full.timezone },
      }))(q.userById.get(u.id)),
    };
  });

  // Anything that asks for the account's password is limited per account, so a stolen session can't be
  // used to guess the password and take the account over for good.
  async function checkPassword(u, password, wrong) {
    if (!limit('password:' + u.id, 10, HOUR)) fail(429, 'rate', 'Too many password attempts. Wait a while and try again.');
    if (!(await A.verifyPassword(txt(password, 200), u.pass_hash))) fail(400, 'bad_password', wrong);
  }

  route('PATCH', '/api/me', async ctx => {
    const b = await H.readJson(ctx.req), u = q.userById.get(ctx.user.id);
    // everything is checked before anything is saved, so a wrong password doesn't leave half the changes made
    const name = b.displayName === undefined ? null : txt(b.displayName, 40).trim();
    if (name === '') fail(400, 'name', 'Display name can’t be empty.');
    if (b.color !== undefined && !COLORS.includes(b.color)) fail(400, 'color', 'Pick one of the colours shown.');
    let tz = u.timezone;
    if (b.timezone !== undefined) {
      tz = txt(b.timezone, 64);
      try { new Intl.DateTimeFormat('en', { timeZone: tz || 'UTC' }); } catch (e) { fail(400, 'timezone', 'Unknown time zone.'); }
    }
    if (b.newPassword !== undefined) {
      await checkPassword(u, b.currentPassword, 'Your current password is wrong.');
      if (txt(b.newPassword, 200).length < 8) fail(400, 'password', 'Use at least 8 characters for your new password.');
    }
    if (name !== null) q.setDisplayName.run(name, u.id);
    if (b.color !== undefined) q.setColor.run(b.color, u.id);
    if (b.notifyMentions !== undefined || b.notifyDue !== undefined || b.timezone !== undefined) {
      q.setPrefs.run(b.notifyMentions === undefined ? u.notify_mentions : b.notifyMentions ? 1 : 0, b.notifyDue === undefined ? u.notify_due : b.notifyDue ? 1 : 0, tz, u.id);
    }
    if (b.newPassword !== undefined) {
      q.setPassword.run(await A.hashPassword(txt(b.newPassword, 200)), u.id);
      // a new password signs out every other device, so a stolen session stops working
      q.dropOtherSessions.run(u.id, A.tokenHash(ctx.auth.token));
      M.revokeAll(u.id);
      CAL.revokeAll(u.id);
      q.dropDevices.run(u.id);
      q.dropUserResets.run(u.id);
      live.userSignedOut(u.id, ctx.auth.token);
    }
    const now = q.userById.get(u.id);
    if (name !== null || b.color !== undefined) {  // teammates see it straight away, in the board and its member list
      live.profileChanged(u.id, { displayName: now.display_name, color: now.color });
      for (const t of q.teamsFor.all(u.id)) { live.membersChanged(t.id); live.teamChanged(t.id); }
    }
    return { user: publicUser(now) };
  });

  route('POST', '/api/me/2fa/setup', async ctx => {
    const b = await H.readJson(ctx.req), u = q.userById.get(ctx.user.id);
    await checkPassword(u, b.password, 'That password is wrong.');
    if (u.totp_secret) fail(409, 'on', 'Two-step sign-in is already on. Turn it off first.');
    if (!u.email_verified) fail(403, 'verify_first', 'Confirm your email address before turning on two-step sign-in.');
    const secretKey = T.newSecret();
    q.setTotpPending.run(secretKey, u.id);
    return { secret: secretKey, uri: T.uri(secretKey, u.username) };
  });
  route('POST', '/api/me/2fa/enable', async ctx => {
    const b = await H.readJson(ctx.req), u = q.userById.get(ctx.user.id);
    if (u.totp_secret) fail(409, 'on', 'Two-step sign-in is already on. Turn it off first.');
    if (!u.totp_pending) fail(400, 'setup', 'Start setting up two-step sign-in again.');
    if (!limit('2fa:' + u.id, 10, 15 * 60000)) fail(429, 'rate', 'Too many tries. Wait a few minutes.');
    const step = T.check(u.totp_pending, b.code, 0);
    if (!step) fail(400, 'bad_code', 'That code didn’t work. Check your phone sets its clock automatically, then type the newest code.');
    const codes = T.recoveryCodes();
    db.transaction(() => { q.enableTotp.run(step, u.id); q.dropRecovery.run(u.id); for (const c of codes) q.addRecovery.run(u.id, A.tokenHash(T.normalizeRecovery(c))); })();
    // anyone signed in before it was turned on is signed out, so a stolen session doesn't survive it
    q.dropOtherSessions.run(u.id, A.tokenHash(ctx.auth.token));
    M.revokeAll(u.id);
    CAL.revokeAll(u.id);
    live.userSignedOut(u.id, ctx.auth.token);
    return { recoveryCodes: codes };
  });
  route('POST', '/api/me/2fa/disable', async ctx => {
    const b = await H.readJson(ctx.req), u = q.userById.get(ctx.user.id);
    await checkPassword(u, b.password, 'That password is wrong.');
    if (u.totp_secret && !secondFactor(u, b.code)) fail(400, 'bad_code', 'That code didn’t work.');
    db.transaction(() => { q.disableTotp.run(u.id); q.dropRecovery.run(u.id); })();
    return { ok: true };
  });
  route('POST', '/api/me/2fa/recovery', async ctx => {
    const b = await H.readJson(ctx.req), u = q.userById.get(ctx.user.id);
    if (!u.totp_secret) fail(400, 'off', 'Two-step sign-in is off.');
    await checkPassword(u, b.password, 'That password is wrong.');
    if (!secondFactor(u, b.code)) fail(400, b.code ? 'bad_code' : 'need_code', b.code ? 'That code didn’t work.' : 'Enter a code from your authenticator app too. If you aren’t asked for one, update the app or use ' + hostOf(cfg.PUBLIC_URL) + '/account.');
    const codes = T.recoveryCodes();
    db.transaction(() => { q.dropRecovery.run(u.id); for (const c of codes) q.addRecovery.run(u.id, A.tokenHash(T.normalizeRecovery(c))); })();
    return { recoveryCodes: codes };
  });

  route('POST', '/api/me/sign-out-others', ctx => {
    const keep = A.tokenHash(ctx.auth.token), n = q.countOtherSessions.get(ctx.user.id, keep, Date.now()).n;
    q.dropOtherSessions.run(ctx.user.id, keep);
    M.revokeAll(ctx.user.id);
    CAL.revokeAll(ctx.user.id);
    live.userSignedOut(ctx.user.id, ctx.auth.token);
    return { ok: true, signedOut: n };
  });

  // Deleting an account also deletes the teams only its owner was in. A team with other people in it never
  // disappears from under them: its leader hands it over or deletes it first.
  route('DELETE', '/api/me', async ctx => {
    const b = await H.readJson(ctx.req), u = q.userById.get(ctx.user.id);
    await checkPassword(u, b.password, 'That password is wrong.');
    if (u.totp_secret && !secondFactor(u, b.code)) fail(400, b.code ? 'bad_code' : 'need_code', b.code ? 'That code didn’t work.' : 'Enter a code from your authenticator app too.');
    const mine = q.teamsFor.all(u.id), led = mine.filter(t => t.role === 'leader'), shared = led.filter(t => t.members > 1);
    if (shared.length) {
      const one = shared.length === 1, names = shared.map(t => `“${t.name}”`).join(', ');
      fail(409, 'leads_team', `You lead ${names}, which ${one ? 'has' : 'have'} other people in ${one ? 'it' : 'them'}. Hand ${one ? 'it' : 'them'} to someone else or delete ${one ? 'it' : 'them'} first.`);
    }
    const projectIds = led.flatMap(t => q.teamProjectIds.all(t.id).map(p => p.id));
    const files = projectIds.flatMap(id => q.projectAssets.all(id).map(a => a.id)), shotFiles = SH.filesOf(u.id);
    for (const id of projectIds) live.deleted(id);
    live.userSignedOut(u.id);
    db.transaction(() => { for (const t of led) q.deleteTeam.run(t.id); q.deleteUser.run(u.id); })();  // sessions, devices, memberships and screenshot links go with it
    for (const f of files) fs.rm(path.join(assetDir, f), { force: true }, () => {});
    SH.removeFiles(shotFiles);
    for (const id of projectIds) C.forgetProject(id);
    for (const t of mine) if (t.role !== 'leader') { live.membersChanged(t.id); live.teamChanged(t.id); }
    if (ctx.auth.via === 'cookie') ctx.headers['Set-Cookie'] = [H.cookie(H.sessionName(cfg.SECURE_COOKIES), '', { maxAge: 0, secure: cfg.SECURE_COOKIES }), ...H.oldSessionGone(cfg.SECURE_COOKIES)];
    log('[auth] account deleted', u.username);
    return { ok: true };
  });

  route('POST', '/api/teams', async ctx => {
    const b = await H.readJson(ctx.req), name = txt(b.name, 60).trim();
    if (!name) fail(400, 'name', 'Give your team a name.');
    const mine = q.teamsFor.all(ctx.user.id), max = allowance(ctx.user).teamsLed;
    if (mine.filter(t => t.role === 'leader').length >= max) {
      if (!ctx.user.emailVerified) fail(403, 'verify_first', `Confirm your email address to create more than ${max === 1 ? 'one team' : max + ' teams'}. We sent you a link when you signed up.`);
      fail(403, 'limit', `You can lead up to ${max} teams. Delete one you don’t use, or hand it to a teammate.`);
    }
    if (mine.length >= cfg.LIMIT_TEAMS_JOINED) fail(403, 'limit', `You’re in ${mine.length} teams, the most one account can be in. Leave one first.`);
    if (!limit('team-create:' + ctx.user.id, 10, DAY)) fail(429, 'rate', 'You’ve made a lot of teams today. Try again tomorrow.');
    const id = A.newId(), now = Date.now();
    db.transaction(() => { q.insertTeam.run(id, name, ctx.user.id, now); q.insertMember.run(id, ctx.user.id, 'leader', now); })();
    live.teamChanged(id);  // the leader's other devices
    return { team: { id, name, role: 'leader' } };
  });

  route('GET', '/api/teams/:id', ctx => {
    const role = needRole(ctx.params.id, ctx.user, 'viewer'), t = q.team.get(ctx.params.id);
    return {
      team: { id: t.id, name: t.name, createdAt: t.created_at }, role,
      members: q.members.all(t.id).map(m => ({ id: m.id, username: m.username, displayName: m.display_name, color: m.color, role: m.role, joinedAt: m.joined_at })),
      invites: RANK[role] >= RANK.admin ? q.teamInvites.all(t.id).map(i => ({ id: i.id, role: i.role, email: i.email, username: i.username, displayName: i.display_name, createdAt: i.created_at })) : [],
      projects: q.projects.all(t.id).map((roles => p => ({ id: p.id, name: p.name, updatedAt: p.updated_at, updatedBy: p.updated_by, ...roles(p.id) }))(PR.teamInfo(t.id, ctx.user.id, role))),
      usage: { storageBytes: storage(t.id, true).team, waitingInvites: q.inviteCount.get(t.id).n },
      integrations: RANK[role] >= RANK.admin ? { discord: C.discordInfo(t), slack: C.slackInfo(t), git: G.info(t.id) } : undefined,
      limits: { projects: cfg.LIMIT_TEAM_PROJECTS, members: cfg.LIMIT_TEAM_MEMBERS, storageMB: Math.round(storage(t.id).teamMax / MB * 10) / 10 },
    };
  });

  route('PATCH', '/api/teams/:id', async ctx => {
    needRole(ctx.params.id, ctx.user, 'admin');
    const name = txt((await H.readJson(ctx.req)).name, 60).trim();
    if (!name) fail(400, 'name', 'Give your team a name.');
    q.renameTeam.run(name, ctx.params.id);
    live.teamChanged(ctx.params.id);
    return { ok: true };
  });

  route('DELETE', '/api/teams/:id', ctx => {
    needRole(ctx.params.id, ctx.user, 'leader');
    const was = q.members.all(ctx.params.id).map(m => m.id), invited = q.invitesTo.all(ctx.params.id);
    for (const p of q.teamProjectIds.all(ctx.params.id)) { live.deleted(p.id); removeAssetFiles(p.id); C.forgetProject(p.id); }
    q.deleteTeam.run(ctx.params.id);
    live.teamChanged(ctx.params.id, was);
    for (const inv of invited) inviteChanged(inv);
    return { ok: true };
  });

  // whoever an invite is for hears when it arrives or goes away, so their Team panel keeps up
  // (an emailed invite reaches the account that has confirmed that address, if there is one)
  function inviteChanged(inv) {
    const id = inv.user_id || (inv.email ? (q.verifiedByEmail.get(inv.email) || {}).id : null);
    if (id) live.invitesChanged(id);
  }
  route('POST', '/api/teams/:id/invites', async ctx => {
    const teamId = ctx.params.id, actor = needRole(teamId, ctx.user, 'admin');
    const b = await H.readJson(ctx.req), who = txt(b.who, 254).trim(), role = txt(b.role, 10);
    if (!canGrant(actor, role)) fail(403, 'forbidden', actor === 'admin' ? 'Team admins can invite editors and viewers.' : 'Choose admin, editor or viewer.');
    if (!limit('invite:' + ctx.user.id, 60, 3600000)) fail(429, 'rate', 'That’s a lot of invites. Try again later.');
    // email invites stay addressed to the email and never reveal whether it belongs to an account
    const byEmail = EMAIL.test(who), target = byEmail ? null : q.userByUsername.get(who);
    if (!byEmail && !target) fail(404, 'no_user', `No account is called “${who}”. Invite them by email instead.`);
    if (target && roleOf(teamId, target.id)) fail(409, 'member', `${target.display_name} is already in this team.`);
    if (q.pendingInvite.get(teamId, target ? target.id : '', byEmail ? who : '')) fail(409, 'invited', 'They already have an invite waiting.');
    if (teamFull(teamId)) fail(403, 'limit', `Teams can have up to ${cfg.LIMIT_TEAM_MEMBERS} people, counting invites that are still waiting. Remove someone or withdraw an invite first.`);
    if (byEmail) {
      // emails go out under Venom Board's name, so only confirmed accounts can send them, and not many
      if (!ctx.user.emailVerified) fail(403, 'verify_first', 'Confirm your own email address before inviting people by email.');
      // capped per account and per sending inbox, so a pile of accounts on one inbox doesn't multiply the allowance
      if (!limit('invite-mail:' + ctx.user.id, 20, 86400000) || !limit('invite-mail-inbox:' + inboxKey(ctx.user.email), 20, 86400000)
        || !inviteQuota(who)) fail(429, 'mail_limit', 'No more email invites can go out right now. Try again tomorrow, or invite by username.');
    }
    const id = A.newId();
    q.insertInvite.run(id, teamId, target ? target.id : null, byEmail ? who : null, role, ctx.user.id, Date.now());
    live.teamChanged(teamId);
    inviteChanged({ user_id: target ? target.id : null, email: byEmail ? who : null });
    if (byEmail) {
      const team = q.team.get(teamId), from = plain(ctx.user.displayName, 40), teamName = plain(team.name);
      mail('invite', { to: who, subject: `${from} invited you to ${teamName} on Venom Board`,
        text: `${from} invited you to join the team “${teamName}” as ${{ admin: 'a team admin', editor: 'an editor', viewer: 'a viewer' }[role]} on Venom Board.\n\nCreate your free account with this email address (or sign in if you have one), confirm the address, and the invite will be waiting:\n${cfg.PUBLIC_URL}/account#signup\n\nIf you don't know this person, you can ignore this email.` });
    }
    return { invite: { id, role, username: target ? target.username : null, email: byEmail ? who : null } };
  });

  route('DELETE', '/api/teams/:id/invites/:inviteId', ctx => {
    needRole(ctx.params.id, ctx.user, 'admin');
    const inv = q.invite.get(ctx.params.inviteId);
    if (!inv || inv.team_id !== ctx.params.id) fail(404, 'not_found', 'Invite not found.');
    q.deleteInvite.run(inv.id);
    live.teamChanged(inv.team_id);
    inviteChanged(inv);
    return { ok: true };
  });

  const myInvite = (id, user) => {
    const inv = okId(id) ? q.invite.get(id) : null;
    if (!inv || !(inv.user_id === user.id || (!inv.user_id && inv.email && user.emailVerified && inv.email.toLowerCase() === user.email.toLowerCase()))) fail(404, 'not_found', 'Invite not found.');
    return inv;
  };
  route('POST', '/api/invites/:id/accept', ctx => {
    const inv = myInvite(ctx.params.id, ctx.user), team = q.team.get(inv.team_id);
    if (q.teamsFor.all(ctx.user.id).length >= cfg.LIMIT_TEAMS_JOINED) fail(403, 'limit', `You’re already in ${cfg.LIMIT_TEAMS_JOINED} teams, the most one account can be in. Leave one first.`);
    if (q.memberCount.get(inv.team_id).n >= cfg.LIMIT_TEAM_MEMBERS) fail(403, 'limit', `${team.name} is full. Ask its leader to make room.`);
    db.transaction(() => { q.insertMember.run(inv.team_id, ctx.user.id, inv.role, Date.now()); q.deleteInvite.run(inv.id); })();
    live.membersChanged(inv.team_id);
    live.teamChanged(inv.team_id);
    C.teamEvent(inv.team_id, 'joined', ctx.user.displayName, 'joined the team');
    return { team: { id: team.id, name: team.name, role: roleOf(team.id, ctx.user.id) } };
  });
  route('POST', '/api/invites/:id/decline', ctx => {
    const inv = myInvite(ctx.params.id, ctx.user);
    q.deleteInvite.run(inv.id);
    live.teamChanged(inv.team_id);
    live.invitesChanged(ctx.user.id);
    return { ok: true };
  });

  route('PATCH', '/api/teams/:id/members/:userId', async ctx => {
    const teamId = ctx.params.id, actor = needRole(teamId, ctx.user, 'admin'), target = roleOf(teamId, ctx.params.userId);
    const role = txt((await H.readJson(ctx.req)).role, 10);
    if (!target) fail(404, 'not_found', 'That person isn’t in this team.');
    if (ctx.params.userId === ctx.user.id) fail(400, 'self', 'You can’t change your own role.');
    if (!canManage(actor, target) || !canGrant(actor, role)) fail(403, 'forbidden', 'You can’t give that role.');
    q.setRole.run(role, teamId, ctx.params.userId);
    if (RANK[role] < RANK.admin) q.dropInvitesBy.run(teamId, ctx.params.userId);
    if (RANK[role] >= RANK.admin) PR.forgetMember(teamId, ctx.params.userId);  // admins have their team role everywhere
    live.setRole(teamId, ctx.params.userId, role);
    live.membersChanged(teamId);
    live.teamChanged(teamId);
    return { ok: true };
  });

  route('DELETE', '/api/teams/:id/members/:userId', ctx => {
    const teamId = ctx.params.id, actor = needRole(teamId, ctx.user, 'viewer'), target = roleOf(teamId, ctx.params.userId);
    if (!target) fail(404, 'not_found', 'That person isn’t in this team.');
    if (ctx.params.userId === ctx.user.id) {
      if (actor === 'leader') fail(400, 'leader', 'Hand the team to someone else before leaving, or delete it.');
    } else if (!canManage(actor, target)) fail(403, 'forbidden', 'You can’t remove that member.');
    q.removeMember.run(teamId, ctx.params.userId);
    q.dropInvitesBy.run(teamId, ctx.params.userId);
    live.removeMember(teamId, ctx.params.userId);
    live.membersChanged(teamId);
    live.teamChanged(teamId, [ctx.params.userId]);
    return { ok: true };
  });

  route('POST', '/api/teams/:id/transfer', async ctx => {
    const teamId = ctx.params.id;
    needRole(teamId, ctx.user, 'leader');
    const userId = txt((await H.readJson(ctx.req)).userId, 64);
    if (!roleOf(teamId, userId) || userId === ctx.user.id) fail(404, 'not_found', 'Choose another member of this team.');
    db.transaction(() => { q.setRole.run('leader', teamId, userId); q.setRole.run('admin', teamId, ctx.user.id); PR.forgetMember(teamId, userId); })();
    live.setRole(teamId, userId, 'leader'); live.setRole(teamId, ctx.user.id, 'admin');
    live.membersChanged(teamId);
    live.teamChanged(teamId);
    return { ok: true };
  });

  route('GET', '/api/teams/:id/projects', ctx => {
    needRole(ctx.params.id, ctx.user, 'viewer');
    return { projects: q.projects.all(ctx.params.id).map(p => ({ id: p.id, name: p.name, updatedAt: p.updated_at, updatedBy: p.updated_by })) };
  });

  // a new team project, from the app or an MCP tool, within the team's and its maker's allowances
  async function makeProject(user, teamId, rawName, rawDoc) {
    needRole(teamId, user, 'editor');
    const name = txt(rawName, 80).trim() || 'Untitled project';
    if (q.projectCount.get(teamId).n >= cfg.LIMIT_TEAM_PROJECTS) fail(403, 'limit', `Teams can have up to ${cfg.LIMIT_TEAM_PROJECTS} projects. Delete one you’ve finished with first.`);
    if (!user.emailVerified && q.projectsMadeBy.get(user.id).n >= cfg.LIMIT_UNVERIFIED_PROJECTS) {
      fail(403, 'verify_first', `Confirm your email address to make more than ${cfg.LIMIT_UNVERIFIED_PROJECTS} projects. We sent you a link when you signed up.`);
    }
    const clean = cleanDoc(rawDoc, SAN);
    for (const c of clean.comments) { c.by = user.id; delete c.react; if (c.resolved) c.resolvedBy = user.id; }
    for (const n of clean.items) for (const f of ['log', 'plan']) if (n.type === 'node' && Array.isArray(n[f])) n[f] = n[f].map(e => ({ ...e, by: user.id }));
    const doc = JSON.stringify(clean);
    if (doc.length > cfg.PROJECT_MAX_MB * MB) fail(413, 'too_big', `That board is too big to share. Boards can be up to ${cfg.PROJECT_MAX_MB} MB, not counting images.`);
    const s = storage(teamId, true);
    if (Buffer.byteLength(doc) > s.left) fail(413, 'quota', `${s.why} Delete old projects or versions to make room.`);
    if (!limit('project-create:' + user.id, 30, HOUR)) fail(429, 'rate', 'You’ve made a lot of projects in the last hour. Try again later.');
    const id = A.newId(), now = Date.now();
    q.insertProject.run(id, teamId, name, doc, user.id, now, now, user.id, Buffer.byteLength(doc));
    C.indexProject(id, clean);
    live.teamChanged(teamId);
    return { id, name, teamId };
  }
  const sendingBoard = new Set();  // people whose board is being read: one at a time, so a few can't use up the memory
  route('POST', '/api/teams/:id/projects', async ctx => {
    needRole(ctx.params.id, ctx.user, 'editor');
    if (Number(ctx.req.headers['content-length'] || 0) > 16e6) fail(413, 'too_big', `That board is too big to share. Boards can be up to ${cfg.PROJECT_MAX_MB} MB, not counting images.`);
    if (sendingBoard.has(ctx.user.id)) fail(429, 'busy', 'Another board is still being sent. Try again in a moment.');
    sendingBoard.add(ctx.user.id);
    let b;
    try { b = await H.readJson(ctx.req, 16e6); } finally { sendingBoard.delete(ctx.user.id); }
    return { project: await makeProject(ctx.user, ctx.params.id, b.name, b.doc) };
  });

  route('GET', '/api/projects/:id', ctx => {
    const { p, role } = needProject(ctx.params.id, ctx.user, 'viewer');
    const state = live.roomState(p.id);
    return { project: { id: p.id, name: p.name, teamId: p.team_id }, role, doc: state ? state.doc : JSON.parse(p.doc), version: state ? state.version : p.version };
  });

  route('PATCH', '/api/projects/:id', async ctx => {
    const { p } = needProject(ctx.params.id, ctx.user, 'editor');
    const name = txt((await H.readJson(ctx.req)).name, 80).trim();
    if (!name) fail(400, 'name', 'Give the project a name.');
    q.renameProject.run(name, p.id);
    live.renamed(p.id, name);
    live.teamChanged(p.team_id);
    return { ok: true };
  });

  route('DELETE', '/api/projects/:id', ctx => {
    const { p } = needProject(ctx.params.id, ctx.user, 'admin');
    live.deleted(p.id);
    removeAssetFiles(p.id);
    q.deleteProject.run(p.id);
    C.forgetProject(p.id);
    live.teamChanged(p.team_id);
    return { ok: true };
  });

  // a picture or video for a project, from the app or an MCP tool: checked, counted toward storage and kept here
  const UPLOAD_MAX = Math.max(15, cfg.VIDEO_MAX_MB) * MB;
  function storeAsset(user, p, buf) {
    if (!limit('upload:' + user.id, 300, 3600000)) fail(429, 'rate', 'Upload limit reached. Try again later.');
    const type = IMAGE_TYPES.find(t => t.test(buf)) || VIDEO_TYPES.find(t => t.test(buf));
    if (!type) fail(415, 'type', 'Upload a PNG, JPEG, GIF or WebP image, or an MP4 or WebM video.');
    const isVideo = type.mime.startsWith('video/');
    if (isVideo && !cfg.VIDEO_UPLOADS) fail(403, 'video_off', 'Video files can’t be shared in team projects. Paste a YouTube or Vimeo link instead, or keep the video on a board on your computer.');
    if (isVideo && buf.length > cfg.VIDEO_MAX_MB * MB) fail(413, 'too_large', `Videos can be up to ${cfg.VIDEO_MAX_MB} MB. Trim it or export it smaller.`);
    if (!isVideo && buf.length > 15 * MB) fail(413, 'too_large', 'Images can be up to 15 MB.');
    // a picture's hidden data (where it was taken, the camera, thumbnails) is taken out before anyone else can see it
    const strip = { 'image/png': stripPng, 'image/jpeg': stripJpeg, 'image/webp': stripWebp, 'image/gif': stripGif }[type.mime];
    if (strip) { let clean = null; try { clean = strip(buf); } catch (e) { /* unreadable */ } if (!clean) fail(415, 'type', 'That picture couldn’t be read. Save it again as a PNG or JPEG and try once more.'); buf = clean; }
    // uploads count toward the team's storage (and its leader's), and pause before the disk fills up
    const s = storage(p.team_id, true);
    if (buf.length > s.left) fail(413, 'quota', `${s.why} Deleting old projects or versions frees it up.`);
    if (diskFree() - buf.length < cfg.MIN_FREE_DISK_MB * 1048576) fail(507, 'disk', 'The server is short on space for images right now. Try again later.');
    const id = require('crypto').randomBytes(24).toString('base64url');
    fs.writeFileSync(path.join(assetDir, id), buf);
    q.insertAsset.run(id, p.id, type.mime, buf.length, user.id, Date.now());
    return { id, url: `${cfg.PUBLIC_URL}/assets/${id}`, mime: type.mime };
  }
  const uploading = new Set();
  route('POST', '/api/projects/:id/assets', async ctx => {
    const { p } = needProject(ctx.params.id, ctx.user, 'editor');
    if (Number(ctx.req.headers['content-length'] || 0) > UPLOAD_MAX) fail(413, 'too_large', 'That file is too large.');
    if (uploading.has(ctx.user.id)) fail(429, 'busy', 'Another upload is still going. Try again in a moment.');
    uploading.add(ctx.user.id);
    try { const a = storeAsset(ctx.user, p, await H.readBody(ctx.req, UPLOAD_MAX)); return { id: a.id, url: a.url }; }
    finally { uploading.delete(ctx.user.id); }
  });

  // runs an API route as someone, for MCP tools, with the route's own permission checks and limits
  async function callRoute(method, pathname, user, body, search = '') {
    const r = matchRoute(method, pathname);
    if (!r) throw new Error(`no route ${method} ${pathname}`);
    const data = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
    const req = require('stream').Readable.from([data]);
    req.headers = { 'content-type': 'application/json', 'content-length': String(data.length) };
    req.method = method;
    const url = new URL(pathname + search, cfg.PUBLIC_URL);
    return r.handler({ req, res: null, url, params: r.params, ip: 'mcp', auth: { via: 'mcp', user, token: null }, user, headers: {}, fromSite: false });
  }

  function matchRoute(method, pathname) {
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = pathname.match(r.re);
      if (m) return { ...r, params: m.groups || {} };
    }
    return null;
  }

  /* ---------- request handling ---------- */
  const ROOT = cfg.ROOT;
  const SITE_CSP = "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
  // the app may play videos from this server or the visitor's own files, and YouTube or Vimeo players when clicked
  const APP_CSP = "default-src 'self'; img-src 'self' data: blob: https: http:; media-src 'self' data: blob:; frame-src https://www.youtube-nocookie.com https://player.vimeo.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; connect-src 'self' https: wss: ws:; frame-ancestors 'none'; base-uri 'none'";
  const pageHeaders = csp => ({ 'Content-Security-Policy': csp, 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'Cache-Control': 'no-cache' });
  const WEB = cfg.WEB_DIR, APP = cfg.APP_DIR;
  const PAGES = { '/': [WEB, 'index.html', SITE_CSP], '/account': [WEB, 'account.html', SITE_CSP], '/app': [APP, 'index.html', APP_CSP] };
  // addresses people type or tools add (a trailing slash, /login) lead to the right page instead of a 404
  const REDIRECTS = {
    '/index.html': '/', '/account/': '/account', '/app/': '/app', '/app/index.html': '/app',
    '/login': '/account#signin', '/signin': '/account#signin', '/sign-in': '/account#signin',
    '/signup': '/account#signup', '/sign-up': '/account#signup', '/register': '/account#signup',
    '/forgot': '/account#forgot', ...(site ? site.REDIRECTS : {}),
  };
  const OUT_LINKS = site ? site.outLinks(cfg) : {};  // the website's short addresses (its community server)
  page.setBase(cfg.PUBLIC_URL);
  const SITE_UPDATED = Date.now();  // the website changes with deploys, which restart the server
  const sitemapExtra = () => C.roadmapSitemap();
  // IndexNow tells Bing (and the other search engines that use it) about new pages straight away, without an
  // account. The key comes from the server's secret and is served at /<key>.txt to show the site is ours. New
  // addresses go out a minute after start and then every six hours; test and local servers send nothing.
  const INDEXNOW_KEY = crypto.createHmac('sha256', secret).update('indexnow').digest('hex').slice(0, 32);
  const indexNowFile = path.join(cfg.DATA_DIR, 'indexnow.json');
  async function indexNow() {
    if (!site || !/^https:\/\//.test(cfg.PUBLIC_URL) || cfg.INDEXNOW === 'off') return;
    let sent = [];
    try { sent = JSON.parse(fs.readFileSync(indexNowFile, 'utf8')).sent || []; } catch (e) { /* nothing sent yet */ }
    const fresh = site.urls().concat(sitemapExtra().map(u => u.loc)).filter(u => !sent.includes(u)).slice(0, 5000);
    if (!fresh.length) return;
    try {
      const r = await (hooks.fetch || fetch)('https://api.indexnow.org/indexnow', { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ host: new URL(cfg.PUBLIC_URL).host, key: INDEXNOW_KEY, keyLocation: `${cfg.PUBLIC_URL}/${INDEXNOW_KEY}.txt`, urlList: fresh }) });
      if (r.ok || r.status === 202) { fs.writeFileSync(indexNowFile, JSON.stringify({ sent: [...new Set(sent.concat(fresh))], at: Date.now() })); log('[indexnow] sent', fresh.length, 'addresses'); }
      else log('[indexnow] answered', r.status);
    } catch (e) { log('[indexnow]', e.message); }
  }
  const indexNowTimers = site ? [setTimeout(indexNow, 60000), setInterval(indexNow, 6 * HOUR)] : [];
  for (const t of indexNowTimers) t.unref();
  // The site's stylesheet and scripts carry a version from their contents in their address, so a deploy reaches
  // everyone at once instead of waiting for caches (Cloudflare's included) to let go of the old files.
  const assetVers = new Map();
  function assetVer(rel) {
    const f = path.join(WEB, rel);
    let st;
    try { st = fs.statSync(f); } catch (e) { return null; }
    const known = assetVers.get(rel);
    if (known && known.at === st.mtimeMs) return known.v;
    const v = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 10);
    assetVers.set(rel, { at: st.mtimeMs, v });
    return v;
  }
  const versioned = html => html.replace(/((?:href|src)=")\/web\/([\w.-]+\.(?:css|js))"/g, (m, attr, rel) => { const v = assetVer(rel); return v ? `${attr}/web/${rel}?v=${v}"` : m; });
  const sendHtml = (res, status, html, headers) => { res.writeHead(status, { ...headers, 'Content-Type': 'text/html; charset=utf-8' }); res.end(versioned(html)); };
  const webPage = (res, file, status = 200) => {
    let html;
    try { html = fs.readFileSync(path.join(WEB, file), 'utf8'); } catch (e) { return false; }
    html = html.replace('data-support=""', () => `data-support="${esc(cfg.SUPPORT_EMAIL)}"`);  // who to write to, from the settings
    sendHtml(res, status, html, pageHeaders(SITE_CSP));
    return true;
  };
  const sitePage = { ...pageHeaders(SITE_CSP), 'Cache-Control': 'public, max-age=300' };
  // The app's page, read again whenever it changes. A share link's copy also says what the board is, so a link
  // posted on Discord, Reddit or X shows the board's name and picture.
  let appCache = { at: 0, html: '' };
  function appHtml() {
    const f = path.join(APP, 'index.html');
    let st;
    try { st = fs.statSync(f); } catch (e) { return null; }
    if (st.mtimeMs !== appCache.at) appCache = { at: st.mtimeMs, html: fs.readFileSync(f, 'utf8') };
    return appCache.html;
  }
  function describedApp(m, pagePath) {
    const html = appHtml();
    if (!html || !m) return html;
    const title = `${m.name} · Venom Board`, desc = 'A live game plan made with Venom Board. Open the link to watch it change in real time.';
    const image = m.preview ? `${cfg.PUBLIC_URL}${pagePath}/preview?v=${m.preview.at}` : `${cfg.PUBLIC_URL}/docs/banner.png`;
    const tags = ['<meta property="og:type" content="website">', '<meta property="og:site_name" content="Venom Board">', `<meta property="og:title" content="${esc(title)}">`,
      `<meta property="og:description" content="${esc(desc)}">`, `<meta name="description" content="${esc(desc)}">`, `<meta property="og:image" content="${esc(image)}">`,
      ...(m.preview ? ['<meta property="og:image:width" content="1200">', '<meta property="og:image:height" content="630">'] : []), '<meta name="twitter:card" content="summary_large_image">'].join('\n');
    const head = `<title>${esc(title)}</title>\n${tags}`;
    if (html.includes('<title>Venom Board</title>')) return html.replace('<title>Venom Board</title>', () => head);
    return html.includes('</head>') ? html.replace('</head>', () => head + '\n</head>') : head + html;
  }

  function authenticate(req) {
    const h = String(req.headers.authorization || '');
    if (h.startsWith('Bearer ')) { const token = h.slice(7).trim(); return { user: sessions.user(token), token, via: 'bearer' }; }
    const token = H.sessionCookie(req);
    return token ? { user: sessions.user(token), token, via: 'cookie' } : { user: null };
  }

  async function handle(req, res) {
    const url = new URL(req.url, cfg.PUBLIC_URL);
    const origin = req.headers.origin, crossOrigin = !!origin && origin !== cfg.PUBLIC_ORIGIN;

    if (url.pathname === '/mcp' || url.pathname === '/mcp/' || url.pathname.startsWith('/mcp/upload/')) {
      try { await (url.pathname.startsWith('/mcp/upload/') ? M.upload(req, res, url) : M.handle(req, res)); } catch (e) { log('[mcp]', e.stack); if (!res.headersSent) { res.writeHead(500); res.end(); } }
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      // the desktop app and local copies call from other origins with a bearer token, never cookies
      const cors = crossOrigin ? { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-VB', 'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS', 'Access-Control-Max-Age': '600' } : {};
      if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
      try {
        const r = matchRoute(req.method, url.pathname.replace(/(.)\/+$/, '$1'));  // /api/me/ works like /api/me
        if (!r) fail(404, 'not_found', 'No such endpoint.');
        const auth = authenticate(req);
        // cookies only count on requests from our own pages that carry the X-VB header (blocks CSRF)
        if (auth.via === 'cookie' && (crossOrigin || (req.method !== 'GET' && req.headers['x-vb'] !== '1'))) auth.user = null;
        if (r.opts.auth !== false && !auth.user) fail(401, 'unauthorized', 'Please sign in.');
        const ctx = { req, res, url, params: r.params, ip: H.clientIp(req, cfg.TRUST_PROXY), auth, user: auth.user, headers: { ...cors },
          fromSite: !crossOrigin && req.headers['x-vb'] === '1' };
        const out = await r.handler(ctx);
        H.sendJson(res, 200, out || { ok: true }, ctx.headers);
      } catch (e) {
        if (!(e instanceof H.HttpError)) log('[api]', req.method, url.pathname, e.stack);
        const status = e.status || 500;
        if (!res.headersSent) H.sendJson(res, status, { error: status === 500 ? 'Something went wrong on the server.' : e.message, code: e.code || 'server' }, cors);
      }
      return;
    }

    // a private calendar feed (/ical/<address>.ics) for calendar apps, which can't sign in
    if (url.pathname.startsWith('/ical/') && CAL.serve(req, res, url, H.clientIp(req, cfg.TRUST_PROXY))) return;
    ADM.watch(req, res, url.pathname);  // counts the page for the owner's dashboard if visit stats are on
    if (req.method === 'POST' && url.pathname === '/takedown') {
      req.resume();
      res.writeHead(200, { ...pageHeaders(SITE_CSP), 'Content-Type': 'text/html; charset=utf-8', 'Referrer-Policy': 'no-referrer' });
      res.end(simplePage('Take down', `<p>${esc(C.takedown(url, true).text)}</p>`));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/unsubscribe') {
      req.resume();
      res.writeHead(200, { ...pageHeaders(SITE_CSP), 'Content-Type': 'text/html; charset=utf-8', 'Referrer-Policy': 'no-referrer' });
      res.end(simplePage('Email settings', `<p>${esc(C.unsubscribe(url))}</p>`));
      return;
    }
    if (url.pathname.startsWith('/f/') && await IN.page(req, res, url, H.clientIp(req, cfg.TRUST_PROXY))) return;  // playtest feedback forms
    if (url.pathname.startsWith('/s/') && await SH.page(req, res, url, H.clientIp(req, cfg.TRUST_PROXY))) return;  // screenshot links
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
    const assetMatch = url.pathname.match(/^\/assets\/([\w-]{20,64})$/);
    if (assetMatch) {
      const a = q.asset.get(assetMatch[1]);
      const video = !!a && a.mime.startsWith('video/');
      if (a && H.serveFile(res, assetDir, a.id, { 'Content-Type': a.mime, 'Cache-Control': video ? 'private, max-age=86400' : 'public, max-age=31536000, immutable',
        'Access-Control-Allow-Origin': '*', 'Content-Security-Policy': "default-src 'none'" }, 200, req)) return;
    } else if (OUT_LINKS[url.pathname.toLowerCase().replace(/\/$/, '')]) {
      res.writeHead(302, { Location: OUT_LINKS[url.pathname.toLowerCase().replace(/\/$/, '')], 'Cache-Control': 'public, max-age=300' });
      res.end();
      return;
    } else if (REDIRECTS[url.pathname.toLowerCase()]) {
      const [to, hash] = REDIRECTS[url.pathname.toLowerCase()].split('#');
      res.writeHead(301, { Location: to + url.search + (hash ? '#' + hash : ''), 'Cache-Control': 'public, max-age=3600' });
      res.end();
      return;
    } else if (/^\/v\/[\w-]{20,64}\/preview$/.test(url.pathname)) {
      const m = C.linkMeta(url.pathname.split('/')[2]);
      if (m && m.preview && H.serveFile(res, m.preview.dir, m.preview.file, { 'Content-Type': m.preview.mime, 'Cache-Control': 'public, max-age=300', 'Content-Security-Policy': "default-src 'none'" })) return;
    } else if (/^\/v\/[\w-]{20,64}$/.test(url.pathname)) {
      // a share link opens the app read-only; the address stays out of search engines and other sites' logs
      const html = describedApp(C.linkMeta(url.pathname.slice(3)), url.pathname);
      if (html) { sendHtml(res, 200, html, { ...pageHeaders(APP_CSP), 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' }); return; }
    } else if (url.pathname === '/takedown') {
      const t = C.takedown(url, false);
      res.writeHead(200, { ...pageHeaders(SITE_CSP), 'Content-Type': 'text/html; charset=utf-8', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex' });
      res.end(simplePage('Take down', `<p>${esc(t.text)}</p>${t.ask ? `<form method="post" action="${esc('/takedown' + url.search)}"><button class="btn red" type="submit">Take it down</button></form>` : ''}`));
      return;
    } else if (url.pathname.startsWith('/r/')) {
      // public roadmaps: the page, an embed other sites may frame, an RSS feed and the preview picture
      const ip = H.clientIp(req, cfg.TRUST_PROXY);
      if (!limit('roadmap-page:' + ip, 120, 60000)) { res.writeHead(429, { 'Retry-After': '60', 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Too many requests. Try again in a minute.'); return; }
      const r = C.roadmapPage(url, ip);
      if (r && r.file && H.serveFile(res, r.file.dir, r.file.name, { 'Content-Type': r.file.mime, 'Cache-Control': 'public, max-age=300', 'Content-Security-Policy': "default-src 'none'" })) return;
      if (r && r.type) { res.writeHead(200, { 'Content-Type': r.type, 'Cache-Control': 'public, max-age=300' }); res.end(r.body); return; }
      if (r && r.body) {
        sendHtml(res, 200, r.body, r.embed ? { 'Content-Security-Policy': SITE_CSP.replace("frame-ancestors 'none'", 'frame-ancestors *'), 'Referrer-Policy': 'strict-origin-when-cross-origin', 'Cache-Control': 'no-cache' } : pageHeaders(SITE_CSP));
        return;
      }
    } else if (url.pathname === '/unsubscribe') {
      // opening the link only asks; the button does it, so email scanners that follow links change nothing
      const action = '/unsubscribe' + url.search;
      res.writeHead(200, { ...pageHeaders(SITE_CSP), 'Content-Type': 'text/html; charset=utf-8', 'Referrer-Policy': 'no-referrer' });
      res.end(simplePage('Email settings', `<p>Stop getting ${url.searchParams.get('k') === 'due' ? 'due-date reminder emails' : 'emails when someone mentions you'}?</p>
<form method="post" action="${esc(action)}"><button class="btn red" type="submit">Turn them off</button></form>`));
      return;
    } else if (site && url.pathname === `/${INDEXNOW_KEY}.txt`) {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=86400' });
      res.end(INDEXNOW_KEY);
      return;
    } else if (url.pathname === '/.well-known/atproto-did' && (cfg.BLUESKY_DID || (site && site.BLUESKY_DID))) {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600', 'Access-Control-Allow-Origin': '*' });
      res.end(cfg.BLUESKY_DID || site.BLUESKY_DID);
      return;
    } else if (site && url.pathname === '/robots.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
      res.end(site.robots());
      return;
    } else if (site && url.pathname === '/sitemap.xml') {
      res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
      res.end(site.sitemap(SITE_UPDATED, sitemapExtra()));
      return;
    } else if (site && (url.pathname === '/privacy' || url.pathname === '/terms')) {
      const privacy = url.pathname === '/privacy';
      let text = null;
      try { text = fs.readFileSync(path.join(WEB, 'legal', privacy ? 'privacy.md' : 'terms.md'), 'utf8'); } catch (e) { /* falls through to the 404 page */ }
      if (text) {
        sendHtml(res, 200, site.legalPage(privacy ? 'Privacy policy' : 'Terms of use', privacy ? 'What venomboard.com and the Venom Board apps collect, why, and what you can do about it.' : 'The terms for using the Venom Board service at venomboard.com.', url.pathname, text), sitePage);
        return;
      }
    } else if (site && url.pathname === '/templates') {
      sendHtml(res, 200, site.templatesPage(), sitePage);
      return;
    } else if (demo && url.pathname === '/demo') {
      sendHtml(res, 200, demo.page(), sitePage);
      return;
    } else if (site && /^\/(templates|alternatives)\/[a-z0-9-]{2,60}$/.test(url.pathname)) {
      const [, kind, slug] = url.pathname.split('/');
      const html = kind === 'templates' ? site.templatePage(slug) : site.alternativePage(slug);
      if (html) { sendHtml(res, 200, html, sitePage); return; }
    } else if (admin && (url.pathname === '/admin' || url.pathname === '/admin/app.js')) {
      // the owner's dashboard: everyone else gets the ordinary 404 below
      const access = ADM.pageAccess(req), headers = { ...pageHeaders(SITE_CSP), 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' };
      if (access === 'two_step' && url.pathname === '/admin') {
        res.writeHead(403, { ...headers, 'Content-Type': 'text/html; charset=utf-8' });
        res.end(simplePage('Dashboard', '<p>The dashboard shows everyone\u2019s account details, so it needs two-step sign-in. Turn it on in the app under <b>Settings \u2192 Account \u2192 Two-step sign-in</b>, then come back here.</p>'));
        return;
      }
      if (access === 'ok' && H.serveFile(res, path.join(ROOT, 'server', 'admin'), url.pathname === '/admin' ? 'index.html' : 'app.js', headers)) return;
    } else if (url.pathname === '/' && !site) {
      res.writeHead(302, { Location: '/app' });  // a self-hosted server has no website: its home is the app
      res.end();
      return;
    } else if (PAGES[url.pathname]) {
      const [dir, file, csp] = PAGES[url.pathname];
      if (dir === WEB ? webPage(res, file) : H.serveFile(res, dir, file, pageHeaders(csp))) return;
    } else if (url.pathname.startsWith('/web/')) {
      // a versioned address never changes, so it can be kept for good
      const rel = H.safeDecode(url.pathname.slice(5));
      if (rel && !/[\\/]$/.test(rel) && !/\.html?$/i.test(rel) && H.serveFile(res, WEB, rel, { 'Cache-Control': /^\?v=\w+$/.test(url.search) ? 'public, max-age=31536000, immutable' : 'public, max-age=600' })) return;
    } else if (url.pathname.startsWith('/docs/')) {
      const rel = H.safeDecode(url.pathname.slice(6));
      if (rel && H.serveFile(res, path.join(APP, 'docs'), rel, { 'Cache-Control': 'public, max-age=86400' })) return;
    } else if (url.pathname === '/favicon.svg') {
      if (H.serveFile(res, path.join(APP, 'assets'), 'icon.svg', { 'Cache-Control': 'public, max-age=86400' })) return;
    }
    // a browser gets a proper page with the site's look; anything else gets plain text
    if (/text\/html/.test(String(req.headers.accept || '')) && webPage(res, '404.html', 404)) return;
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(e => { log('[http]', e.stack); try { res.writeHead(500); res.end(); } catch (_) {} });
  });
  server.requestTimeout = 120000;
  live = realtime({ server, db, sessions, cfg, log, hooks: { ...C.hooks, storage: teamId => storage(teamId), projectRole: PR.effective } });
  // the owner hears about it by email (once a day) well before the disk is full enough for uploads to stop
  let diskAlertDay = '';
  function checkDisk() {
    const free = diskFree(), day = new Date().toISOString().slice(0, 10);
    if (!Number.isFinite(free) || free >= cfg.ALERT_FREE_DISK_MB * MB || diskAlertDay === day) return;
    diskAlertDay = day;
    mail('alert', { to: cfg.ALERT_EMAIL, subject: 'Venom Board: the server disk is getting full',
      text: `Only ${Math.round(free / MB)} MB is free on the server. Uploads stop at ${cfg.MIN_FREE_DISK_MB} MB free.\n\nAdd space (a bigger disk or server), or lower TEAM_STORAGE_MB and LEADER_STORAGE_MB in server/.env.` });
  }
  const purgeTimer = setInterval(() => {
    sessions.purge(); q.purgeDevices.run(Date.now() - 400 * 86400000);
    for (const [k, t] of tickets) if (t.expires < Date.now()) tickets.delete(k);
    checkDisk();
  }, 3600000);
  checkDisk();
  purgeTimer.unref();

  return new Promise(resolve => {
    server.listen(cfg.PORT, cfg.HOST, () => {
      const port = server.address().port;
      log(`Venom Board server listening on ${cfg.HOST}:${port}, public address ${cfg.PUBLIC_URL}`);
      if (smtpReady(cfg)) log(`Sending email through ${cfg.SMTP_HOST}:${cfg.SMTP_PORT} as ${cfg.MAIL_FROM}`);
      else if (cfg.SMTP_HOST) log('SMTP_PASS is empty: no emails are sent until you add the mailbox password to server/.env.');
      else if (!cfg.RESEND_API_KEY) log(cfg.SECURE_COOKIES ? 'No email settings: emails are not being sent.' : 'No email settings: emails are printed to this log (local development).');
      resolve({
        port, cfg,
        remindDue: now => C.remindDue(now),  // lets tests run the reminder job at a chosen time
        close: () => new Promise(done => {
          clearInterval(purgeTimer); clearTimeout(outboxTimer);
          C.close();
          ADM.close();
          live.close();
          server.closeAllConnections();
          server.close(() => { db.close(); done(); });
        }),
      });
    });
  });
}

if (require.main === module) {
  start().then(s => {
    const stop = () => s.close().then(() => process.exit(0));
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  }).catch(e => { console.error(e); process.exit(1); });
}

module.exports = { start };
