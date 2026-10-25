// Calendar feeds. Each person can turn on a private address that calendar apps (Google Calendar, Outlook, Apple
// Calendar) subscribe to: the cards assigned to them that have a due date, and the milestones with a date, in every
// team project they're in, as all-day events that link back to the card.
// The secret part of the address is made from the server's key and a random value kept for the person, so the
// account page can show it again, while the database alone (a stray backup, say) never holds a working address:
// only its hash, which is what requests are looked up by. Making a new address or turning the feed off stops the old
// one straight away, and so does anything that signs the account out everywhere else.
'use strict';
const crypto = require('crypto');

const DAY = 86400000, HOUR = 3600000;
const STATUS = {
  task: { todo: 'To do', doing: 'In progress', done: 'Done', blocked: 'Blocked' },
  bug: { todo: 'Open', doing: 'Fixing', done: 'Fixed', blocked: 'Blocked' },
  milestone: { todo: 'Upcoming', doing: 'In progress', done: 'Reached', blocked: 'At risk' },
};
const PRIO = { must: 'Must', should: 'Should', could: 'Could' };
const DISC = { code: 'Code', art: 'Art', design: 'Design', level: 'Level', audio: 'Audio', ui: 'UI/UX', vfx: 'VFX', narr: 'Narrative', qa: 'QA', tech: 'Tech / build', mkt: 'Marketing' };
const MAX_EVENTS = 1500;
const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

/* ---------- RFC 5545 text ---------- */
// TEXT values: line breaks become \n, backslashes, semicolons and commas are escaped, other control characters go
const escText = s => String(s).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ')
  .replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
// content lines are folded so none is longer than 75 octets, never inside a character
function fold(line) {
  const out = [];
  let cur = '', bytes = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch);
    if (bytes + n > 75) { out.push(cur); cur = ' '; bytes = 1; }
    cur += ch; bytes += n;
  }
  out.push(cur);
  return out.join('\r\n');
}
const dateValue = iso => iso.replace(/-/g, '');
const nextDay = iso => { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10); };
const stamp = t => new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

function ical(app) {
  const { db, cfg, route, fail, A, limit, secret, live } = app;
  const q = {
    get: db.prepare('SELECT * FROM calendar_feeds WHERE user_id = ?'),
    byHash: db.prepare('SELECT f.*, u.display_name FROM calendar_feeds f JOIN users u ON u.id = f.user_id WHERE f.token_hash = ?'),
    set: db.prepare(`INSERT INTO calendar_feeds (user_id, nonce, token_hash, created_at, last_used) VALUES (?, ?, ?, ?, 0)
      ON CONFLICT(user_id) DO UPDATE SET nonce = excluded.nonce, token_hash = excluded.token_hash, created_at = excluded.created_at, last_used = 0`),
    drop: db.prepare('DELETE FROM calendar_feeds WHERE user_id = ?'),
    used: db.prepare('UPDATE calendar_feeds SET last_used = ? WHERE user_id = ?'),
    projects: db.prepare(`SELECT p.id, p.name, p.updated_at FROM projects p JOIN members m ON m.team_id = p.team_id
      WHERE m.user_id = ? ORDER BY p.name COLLATE NOCASE`),
  };
  const host = new URL(cfg.PUBLIC_URL).hostname;
  const tokenFor = (userId, nonce) => crypto.createHmac('sha256', secret).update(`calendar-feed\n${userId}\n${nonce}`).digest('base64url').slice(0, 32);
  const feedOut = row => {
    if (!row) return null;
    const url = `${cfg.PUBLIC_URL}/ical/${tokenFor(row.user_id, row.nonce)}.ics`;
    return { url, webcal: url.replace(/^https?:/, 'webcal:'), createdAt: row.created_at, lastUsed: row.last_used || null };
  };

  /* ---------- turning it on, making a new address, turning it off (signed in) ---------- */
  route('GET', '/api/me/calendar', ctx => ({ feed: feedOut(q.get.get(ctx.user.id)) }));
  route('POST', '/api/me/calendar', ctx => {
    if (!limit('calendar-feed:' + ctx.user.id, 20, DAY)) fail(429, 'rate', 'That’s a lot of new calendar addresses today. Try again tomorrow.');
    const nonce = crypto.randomBytes(18).toString('base64url');
    q.set.run(ctx.user.id, nonce, A.tokenHash(tokenFor(ctx.user.id, nonce)), Date.now());
    return { feed: feedOut(q.get.get(ctx.user.id)) };
  });
  route('DELETE', '/api/me/calendar', ctx => { q.drop.run(ctx.user.id); return { feed: null }; });

  /* ---------- the feed ---------- */
  const phaseOf = (c, frames) => {
    const x = c.x + (c.w || 240) / 2, y = c.y + (c.h || 100) / 2;
    const f = frames.find(o => x >= o.x && x <= o.x + o.w && y >= o.y && y <= o.y + o.h);
    return f ? f.title : '';
  };
  function build(row, now) {
    const since = new Date(now - 366 * DAY).toISOString().slice(0, 10), found = [];
    for (const p of q.projects.all(row.user_id)) {
      const doc = live().currentDoc(p.id);
      if (!doc) continue;
      const frames = doc.items.filter(o => o.type === 'frame');
      for (const c of doc.items) {
        if (c.type !== 'node' || !isDate(c.due) || c.due < since || c.kind === 'idea' || c.prio === 'wont') continue;
        // your own cards, and the team's milestones (the dates everyone works toward)
        if (c.kind !== 'milestone' && !(Array.isArray(c.assignees) && c.assignees.includes(row.user_id))) continue;
        found.push({ p, c, phase: phaseOf(c, frames) });
      }
    }
    found.sort((a, b) => a.c.due.localeCompare(b.c.due) || a.p.name.localeCompare(b.p.name));
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//1337VIPER//Venom Board//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
      `X-WR-CALNAME:${escText('Venom Board · ' + String(row.display_name || '').slice(0, 40))}`,
      `X-WR-CALDESC:${escText('Cards assigned to you and milestones from your team projects on Venom Board')}`,
      'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H'];
    const at = stamp(now);
    for (const { p, c, phase } of found.slice(-MAX_EVENTS)) {
      const k = STATUS[c.kind] ? c.kind : 'task', done = c.status === 'done';
      const title = String(c.title || '').replace(/\s+/g, ' ').trim().slice(0, 200) || 'Untitled card';
      const link = `${cfg.PUBLIC_URL}/app#p=${p.id}&c=${c.id}`;
      const facts = [k === 'milestone' ? 'Milestone' : k === 'bug' ? 'Bug' : '', STATUS[k][c.status] || STATUS[k].todo, PRIO[c.prio] || '', DISC[c.disc] || '', k !== 'milestone' && c.est ? 'estimate ' + c.est : ''].filter(Boolean);
      lines.push('BEGIN:VEVENT', `UID:${p.id}-${c.id}@${host}`, `DTSTAMP:${at}`, `LAST-MODIFIED:${stamp(p.updated_at || now)}`,
        `DTSTART;VALUE=DATE:${dateValue(c.due)}`, `DTEND;VALUE=DATE:${dateValue(nextDay(c.due))}`,
        `SUMMARY:${escText((done ? '✓ ' : '') + (k === 'milestone' ? '◆ ' : k === 'bug' ? 'Bug: ' : '') + title)}`,
        `DESCRIPTION:${escText([String(p.name).slice(0, 80) + (phase ? ' · ' + String(phase).slice(0, 80) : ''), facts.join(' · '), 'Open it: ' + link].join('\n'))}`,
        `URL:${link}`, `CATEGORIES:${k === 'milestone' ? 'Milestone' : k === 'bug' ? 'Bug' : 'Task'}`, 'TRANSP:TRANSPARENT', 'END:VEVENT');
    }
    lines.push('END:VCALENDAR');
    return lines.map(fold).join('\r\n') + '\r\n';
  }

  // GET /ical/<address>.ics: public (calendar apps can't sign in), so the address is the only key, and it's rate limited
  function serve(req, res, url, ip) {
    const m = url.pathname.match(/^\/ical\/([A-Za-z0-9_-]{32})\.ics$/);
    if (!m) return false;
    const headers = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'" };
    const send = (status, type, body, extra = {}) => { res.writeHead(status, { ...headers, 'Content-Type': type, ...extra }); res.end(req.method === 'HEAD' ? undefined : body); return true; };
    const plainText = (status, text, extra) => send(status, 'text/plain; charset=utf-8', text, extra);
    if (req.method !== 'GET' && req.method !== 'HEAD') return plainText(405, 'Calendar apps read this address with GET.', { Allow: 'GET, HEAD' });
    if (!limit('ical-ip:' + ip, 240, HOUR)) return plainText(429, 'Too many requests. Try again later.', { 'Retry-After': '900' });
    const row = q.byHash.get(A.tokenHash(m[1]));
    if (!row) return plainText(404, 'This calendar address was turned off or replaced. Get the current one from your account page.');
    if (!limit('ical:' + row.user_id, 60, HOUR)) return plainText(429, 'This calendar was asked for too often. Try again later.', { 'Retry-After': '900' });
    const now = Date.now();
    if (now - (row.last_used || 0) > 10 * 60000) q.used.run(now, row.user_id);
    return send(200, 'text/calendar; charset=utf-8', build(row, now), { 'Content-Disposition': 'inline; filename="venom-board.ics"' });
  }

  // whatever revokes the other ways into an account (a password change or reset, turning on two-step sign-in,
  // signing out everywhere else) turns the feed off too; deleting the account removes it with the account's rows
  return { serve, revokeAll: userId => q.drop.run(userId) };
}

module.exports = { ical, escText, fold };
