// GitHub and GitLab: commits and pull (merge) requests that mention a card show up on it.
//
// Every card in a team project has a short reference, VB- and eight characters, that people paste into commit
// messages and pull or merge requests ("Copy reference" on the card's right-click menu). It comes from the project
// and card ids, worked out the same way here and in the app, so cards made in the app, by MCP tools or by the server
// all have one and nothing extra is stored. Within a project every card's reference is different: in the rare case
// two cards' first eight characters match, the newer card's reference is a character or two longer.
//
// Team admins connect repositories with a webhook: one address and one secret per team (Team panel → GitHub and
// GitLab). A commit, pull request or merge request that mentions a card adds a comment to it with a link, and a pull
// or merge request is listed on the card too. "Fixes VB-…" (or closes, resolves) in a commit on the default branch,
// or a merged pull or merge request that mentions the card, marks it done. The changes go through the live path as
// "GitHub" or "GitLab", so everyone sees them at once, in the activity feed, Discord and Slack.
//
// Deliveries must be signed with the team's secret (GitHub: an X-Hub-Signature-256 HMAC of the body; GitLab: the
// X-Gitlab-Token header), compared in constant time, and anything unsigned or wrongly signed is refused before its
// body is read as JSON. Bodies are limited in size and deliveries in rate, and each delivery, commit and request is
// only acted on once, so sending one again (or to another team's address) changes nothing.
const crypto = require('crypto');
const { okGitLink } = require('./sanitize');

// who the changes are from: not accounts, so they can't sign in, be mentioned or be emailed
const BOTS = {
  'vb-github': { id: 'vb-github', username: 'github', displayName: 'GitHub', color: '#f1eef2', bot: true },
  'vb-gitlab': { id: 'vb-gitlab', username: 'gitlab', displayName: 'GitLab', color: '#ff7a1a', bot: true },
};
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';  // Crockford's base 32: no I, L, O or U to misread
const CODE_LEN = 8, CODE_MAX = 12;
const REF = /\bVB-([0-9A-Z]{8,12})\b/gi;
const CLOSES = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b\s*:?\s+((?:VB-[0-9A-Z]{8,12}\b(?:\s*(?:,|&|\band\b)\s*)?)+)/gi;
const MAX_BODY = 1048576;  // a push of many commits is a few tens of KB
const MAX_ACTIONS = 100;   // comments and changes one delivery can make
const DAY = 86400000, HOUR = 3600000;

/* ---------- card references ---------- */
// A 64-bit hash of the text in two 32-bit lanes, written as 12 base-32 characters. index.html has the same function.
function refHash(s) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  let a = h1 >>> 0, b = h2 >>> 0, out = '';
  for (let i = 0; i < CODE_MAX; i++) { out += ALPHABET[a >>> 27]; a = ((a << 5) | (b >>> 27)) >>> 0; b = (b << 5) >>> 0; }
  return out;
}
// every card's reference in a project, oldest card first: the first 8 characters of its hash, or more if an older
// card's hash starts the same way (so an older card's reference never changes)
function cardCodes(projectId, cards, hash = refHash) {
  const list = cards.map(c => ({ c, h: hash(projectId + '/' + c.id) }))
    .sort((x, y) => (x.c.createdAt || 0) - (y.c.createdAt || 0) || (x.c.id < y.c.id ? -1 : x.c.id > y.c.id ? 1 : 0));
  const taken = new Set(), byCode = new Map(), full = new Map();
  for (const { c, h } of list) {
    let n = CODE_LEN;
    while (n < CODE_MAX && taken.has(h.slice(0, n))) n++;
    for (let k = CODE_LEN; k <= CODE_MAX; k++) taken.add(h.slice(0, k));
    if (!byCode.has(h.slice(0, n))) byCode.set(h.slice(0, n), c);
    full.set(c.id, h);
  }
  return { byCode, full };
}
// the card a reference points to in one project: its exact code, or else (a code that has since got shorter
// because the older card it matched was deleted) the one card whose hash starts with it
function findCard(index, cards, token) {
  const exact = index.byCode.get(token);
  if (exact) return exact;
  const hits = cards.filter(c => (index.full.get(c.id) || '').startsWith(token));
  return hits.length === 1 ? hits[0] : null;
}
const refsIn = text => [...new Set([...String(text || '').matchAll(REF)].map(m => m[1].toUpperCase()))].slice(0, 10);
function closingRefs(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(CLOSES)) for (const r of m[1].matchAll(REF)) out.add(r[1].toUpperCase());
  return out;
}

function gitlink({ db, cfg, log, route, fail, H, limit, needRole, getLive }) {
  const q = {
    hookByTeam: db.prepare('SELECT * FROM git_hooks WHERE team_id = ?'),
    hookById: db.prepare('SELECT * FROM git_hooks WHERE hook = ?'),
    setHook: db.prepare(`INSERT INTO git_hooks (team_id, hook, secret, created_by, created_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(team_id) DO UPDATE SET secret = excluded.secret, created_by = excluded.created_by, created_at = excluded.created_at`),
    dropHook: db.prepare('DELETE FROM git_hooks WHERE team_id = ?'),
    repos: db.prepare('SELECT provider, repo, url, last_at FROM git_repos WHERE team_id = ? ORDER BY last_at DESC LIMIT 20'),
    repoCount: db.prepare('SELECT COUNT(*) AS n FROM git_repos WHERE team_id = ?'),
    seeRepo: db.prepare(`INSERT INTO git_repos (team_id, provider, repo, url, last_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(team_id, provider, repo) DO UPDATE SET url = excluded.url, last_at = excluded.last_at`),
    hasRepo: db.prepare('SELECT 1 FROM git_repos WHERE team_id = ? AND provider = ? AND repo = ?'),
    dropRepos: db.prepare('DELETE FROM git_repos WHERE team_id = ?'),
    seen: db.prepare('INSERT OR IGNORE INTO git_seen (team_id, key, at) VALUES (?, ?, ?)'),
    prune: db.prepare('DELETE FROM git_seen WHERE at < ?'),
    countSeen: db.prepare('SELECT COUNT(*) AS n FROM git_seen WHERE team_id = ?'),
    dropSeen: db.prepare('DELETE FROM git_seen WHERE team_id = ?'),
    projects: db.prepare('SELECT id, name FROM projects WHERE team_id = ? ORDER BY created_at'),
  };
  const live = () => getLive();
  const newId = () => crypto.randomBytes(9).toString('base64url');
  const sha256 = s => crypto.createHash('sha256').update(String(s)).digest();
  // what came from a repository, as plain short text: no control characters or line breaks, never empty
  const clean = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  const okUrl = u => (typeof u === 'string' && u.length <= 300 && /^https?:\/\/[^\s<>"'`\\]+$/.test(u) ? u : '');

  /* ---------- settings, for team admins ---------- */
  const urls = hook => ({ github: `${cfg.PUBLIC_URL}/api/hooks/github/${hook}`, gitlab: `${cfg.PUBLIC_URL}/api/hooks/gitlab/${hook}` });
  function info(teamId) {
    const h = q.hookByTeam.get(teamId);
    if (!h) return { connected: false, repos: [] };
    return { connected: true, ...urls(h.hook), hint: '…' + h.secret.slice(-4),
      repos: q.repos.all(teamId).map(r => ({ provider: r.provider, repo: r.repo, url: r.url, at: r.last_at })) };
  }
  // turns it on, or makes a new secret (the address stays, so only the secret needs pasting again)
  route('POST', '/api/teams/:id/git', ctx => {
    needRole(ctx.params.id, ctx.user, 'admin');
    if (!limit('git-setup:' + ctx.user.id, 20, HOUR)) fail(429, 'rate', 'That’s a lot of new secrets. Try again in a while.');
    const old = q.hookByTeam.get(ctx.params.id), secret = crypto.randomBytes(24).toString('hex');
    q.setHook.run(ctx.params.id, old ? old.hook : crypto.randomBytes(18).toString('base64url'), secret, ctx.user.id, Date.now());
    forgetDeliveries(ctx.params.id);  // deliveries signed with the old secret no longer pass the check
    live().teamChanged(ctx.params.id);
    return { git: info(ctx.params.id), secret };
  });
  // the secret, for pasting into another repository's settings (admins only, and not often)
  route('GET', '/api/teams/:id/git/secret', ctx => {
    needRole(ctx.params.id, ctx.user, 'admin');
    if (!limit('git-secret:' + ctx.user.id, 30, HOUR)) fail(429, 'rate', 'Try again in a while.');
    const h = q.hookByTeam.get(ctx.params.id);
    if (!h) fail(404, 'not_found', 'Connect GitHub or GitLab first.');
    return { secret: h.secret };
  });
  route('DELETE', '/api/teams/:id/git', ctx => {
    needRole(ctx.params.id, ctx.user, 'admin');
    q.dropHook.run(ctx.params.id); q.dropRepos.run(ctx.params.id); forgetDeliveries(ctx.params.id);
    live().teamChanged(ctx.params.id);
    return { ok: true };
  });

  /* ---------- deliveries ---------- */
  const eq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
  function signed(provider, headers, raw, secret) {
    if (provider === 'github') {
      const sig = String(headers['x-hub-signature-256'] || '');
      return /^sha256=[0-9a-f]{64}$/.test(sig) && eq(sig.slice(7), crypto.createHmac('sha256', secret).update(raw).digest('hex'));
    }
    const token = headers['x-gitlab-token'];
    return typeof token === 'string' && token.length > 0 && crypto.timingSafeEqual(sha256(token), sha256(secret));  // hashed: same time whatever the length
  }
  // Every delivery, commit and request handled is remembered for a year, so an old signed delivery can't be
  // replayed. The memory is bounded without ever forgetting early: a team keeps at most MAX_KEYS, adds at most
  // 5,000 a day, and past either its deliveries are ignored (nothing happens). A new secret empties it.
  const MAX_KEYS = 100000, keyCount = new Map();  // team id -> { n } remembered now
  let pruned = 0;
  function forgetDeliveries(teamId) { q.dropSeen.run(teamId); keyCount.delete(teamId); }
  function once(teamId, key) {
    if (Date.now() - pruned > HOUR) { pruned = Date.now(); q.prune.run(Date.now() - 365 * DAY); keyCount.clear(); }
    let c = keyCount.get(teamId);
    if (!c) { c = { n: q.countSeen.get(teamId).n }; keyCount.set(teamId, c); }
    if (c.n >= MAX_KEYS || !limit('git-keys:' + teamId, 5000, DAY)) { log('[git] delivery limit reached for team', teamId); return false; }
    const fresh = q.seen.run(teamId, key.slice(0, 400), Date.now()).changes > 0;
    if (fresh) c.n++;
    return fresh;
  }

  // GitHub's and GitLab's deliveries, in one shape: {repo, repoUrl, push: {branch, onDefault, commits}} or {repo, repoUrl, pr}
  function normalize(provider, headers, b) {
    const author = (...names) => clean(names.find(n => typeof n === 'string' && n.trim()) || 'Someone', 60);
    const commitsOf = (list, fallback) => (Array.isArray(list) ? list : []).slice(0, 50).filter(c => c && typeof c === 'object' && typeof c.id === 'string' && /^[0-9a-f]{7,64}$/i.test(c.id))
      .map(c => ({ sha: c.id.toLowerCase(), message: String(c.message || '').slice(0, 8000), url: okUrl(c.url), author: author(c.author && c.author.username, c.author && c.author.name, fallback) }));
    const branchOf = ref => (typeof ref === 'string' && ref.startsWith('refs/heads/') ? clean(ref.slice(11), 100) : '');
    if (provider === 'github') {
      const event = String(headers['x-github-event'] || ''), r = b.repository || {};
      const out = { event, repo: clean(r.full_name, 140), repoUrl: okUrl(r.html_url) };
      if (event === 'push') {
        const branch = branchOf(b.ref);
        out.push = { branch, onDefault: !!branch && branch === r.default_branch, commits: commitsOf(b.commits, b.pusher && b.pusher.name) };
      } else if (event === 'pull_request' && b.pull_request && typeof b.pull_request === 'object') {
        const p = b.pull_request, action = String(b.action || '');
        out.pr = { kind: 'pull request', mark: '#', number: Number.isInteger(p.number) ? p.number : 0, title: clean(p.title, 200), text: String(p.body || '').slice(0, 20000),
          branch: clean(p.head && p.head.ref, 200), url: okUrl(p.html_url), author: author(b.sender && b.sender.login, p.user && p.user.login),
          opened: ['opened', 'edited', 'reopened', 'ready_for_review'].includes(action), merged: action === 'closed' && p.merged === true };
      }
      return out;
    }
    const event = String(headers['x-gitlab-event'] || ''), r = b.project || {};
    const out = { event: event === 'Push Hook' ? 'push' : event === 'Merge Request Hook' ? 'merge_request' : event, repo: clean(r.path_with_namespace, 140), repoUrl: okUrl(r.web_url) };
    if (event === 'Push Hook') {
      const branch = branchOf(b.ref);
      out.push = { branch, onDefault: !!branch && branch === r.default_branch, commits: commitsOf(b.commits, b.user_username || b.user_name) };
    } else if (event === 'Merge Request Hook' && b.object_attributes && typeof b.object_attributes === 'object') {
      const m = b.object_attributes, action = String(m.action || '');
      out.pr = { kind: 'merge request', mark: '!', number: Number.isInteger(m.iid) ? m.iid : 0, title: clean(m.title, 200), text: String(m.description || '').slice(0, 20000),
        branch: clean(m.source_branch, 200), url: okUrl(m.url), author: author(b.user && b.user.username, b.user && b.user.name),
        opened: ['open', 'reopen', 'update'].includes(action), merged: action === 'merge' };
    }
    return out;
  }

  async function receive(ctx, provider) {
    const hookId = ctx.params.hook;
    // GitHub and GitLab send from a few shared addresses, so real deliveries are limited per team; deliveries to
    // unknown addresses or with wrong signatures have a much smaller allowance per sending address
    const rate = () => fail(429, 'rate', 'Too many deliveries from here. Try again later.');
    const stray = () => limit('git-stray:' + ctx.ip, 60, 600000);
    if (!limit('git-ip:' + ctx.ip, 3000, 600000)) { ctx.req.resume(); rate(); }
    const h = /^[\w-]{20,64}$/.test(hookId) ? q.hookById.get(hookId) : null;
    if (!h) { ctx.req.resume(); if (!stray()) rate(); fail(404, 'not_found', 'No Venom Board webhook at this address. Copy it again from the Team panel.'); }
    if (Number(ctx.req.headers['content-length'] || 0) > MAX_BODY) { ctx.req.resume(); fail(413, 'too_large', 'That delivery is too large.'); }
    const raw = await H.readBody(ctx.req, MAX_BODY);
    if (!signed(provider, ctx.req.headers, raw, h.secret)) {
      if (!stray()) rate();
      fail(401, 'signature', provider === 'github' ? 'Unsigned or wrongly signed. Set the webhook’s secret to the one in the Venom Board Team panel.' : 'The secret token is missing or wrong. Set it to the secret in the Venom Board Team panel.');
    }
    // only signed deliveries count toward the team's allowance, so nobody without the secret can use it up
    if (!limit('git-team:' + h.team_id, 600, HOUR)) fail(429, 'rate', 'This team has had a lot of deliveries in the last hour. Try again later.');
    let b;
    try {
      const text = raw.toString('utf8');
      b = JSON.parse(/^application\/x-www-form-urlencoded/i.test(String(ctx.req.headers['content-type'] || '')) ? new URLSearchParams(text).get('payload') || '' : text);
    } catch (e) { fail(400, 'bad_json', 'The delivery isn’t valid JSON.'); }
    if (!b || typeof b !== 'object' || Array.isArray(b)) fail(400, 'bad_json', 'The delivery isn’t a JSON object.');
    // the same delivery sent again (a redelivery, or someone replaying it) is only acted on once
    const delivery = clean(provider === 'github' ? ctx.req.headers['x-github-delivery'] : ctx.req.headers['idempotency-key'] || ctx.req.headers['x-gitlab-event-uuid'], 100);
    if (delivery && !once(h.team_id, `d:${provider}:${delivery}`)) return { ok: true, duplicate: true };
    const d = normalize(provider, ctx.req.headers, b);
    const known = d.repo ? !!q.hasRepo.get(h.team_id, provider, d.repo) : true;
    if (d.repo && (known || q.repoCount.get(h.team_id).n < 50)) q.seeRepo.run(h.team_id, provider, d.repo, d.repoUrl, Date.now());
    if (!known) live().teamChanged(h.team_id);  // admins see the new repository listed
    if (!d.push && !d.pr) return { ok: true, ignored: d.event || 'unknown' };
    return act(h.team_id, provider, d);
  }
  route('POST', '/api/hooks/github/:hook', ctx => receive(ctx, 'github'), { auth: false });
  route('POST', '/api/hooks/gitlab/:hook', ctx => receive(ctx, 'gitlab'), { auth: false });

  // what a delivery means for the team's cards: comments, links and cards marked done, one live batch per project
  function act(teamId, provider, d) {
    const bot = BOTS['vb-' + provider], projects = q.projects.all(teamId), boards = new Map(), plans = new Map();
    const board = p => {
      if (!boards.has(p.id)) { const doc = live().currentDoc(p.id), cards = doc ? doc.items.filter(i => i.type === 'node') : []; boards.set(p.id, { cards, index: cardCodes(p.id, cards) }); }
      return boards.get(p.id);
    };
    // a reference is only followed when exactly one of the team's projects has that card
    const find = token => { const hits = []; for (const p of projects) { const b = board(p), c = findCard(b.index, b.cards, token); if (c) hits.push({ p, c }); } return hits.length === 1 ? hits[0] : null; };
    const plan = p => { if (!plans.has(p.id)) plans.set(p.id, { comments: [], cards: new Map() }); return plans.get(p.id); };
    const cardNow = hit => plan(hit.p).cards.get(hit.c.id) || hit.c;
    let actions = 0, comments = 0, done = 0;
    const comment = (hit, text) => { plan(hit.p).comments.push({ k: 'comments', op: 'put', obj: { id: newId(), type: 'comment', card: hit.c.id, text: text.slice(0, 2000) } }); comments++; actions++; };
    const finish = hit => { const c = cardNow(hit); if (c.status === 'done') return false; plan(hit.p).cards.set(c.id, { ...c, status: 'done', doneAt: Date.now() }); done++; actions++; return true; };
    const link = (hit, url) => {
      const c = cardNow(hit), have = Array.isArray(c.gitLinks) ? c.gitLinks : [];
      if (!okGitLink(url) || have.includes(url) || have.length >= 10) return;
      plan(hit.p).cards.set(c.id, { ...c, gitLinks: [...have, url] });
    };
    const where = d.repo || 'a repository';

    if (d.push) {
      for (const c of d.push.commits) {
        const refs = refsIn(c.message);
        if (!refs.length) continue;
        const closing = d.push.onDefault ? closingRefs(c.message) : new Set(), short = clean(c.message.split('\n')[0], 100) || 'No message', sha = c.sha.slice(0, 7);
        for (const token of refs) {
          if (actions >= MAX_ACTIONS) break;
          const hit = find(token);
          if (!hit) continue;
          const mention = once(teamId, `c:${c.sha}:${hit.p.id}:${hit.c.id}`);
          const closes = closing.has(token) && once(teamId, `cd:${c.sha}:${hit.p.id}:${hit.c.id}`) && finish(hit);
          if (mention) comment(hit, `${c.author} committed “${short}” (${sha}) to ${where} on ${d.push.branch || 'a branch'}${closes ? ', which marks this card done' : ''}.${c.url ? '\n' + c.url : ''}`);
          else if (closes) comment(hit, `Commit ${sha} (“${short}”) reached ${d.push.branch} in ${where}, which marks this card done.${c.url ? '\n' + c.url : ''}`);
        }
      }
    }
    if (d.pr && (d.pr.opened || d.pr.merged) && d.pr.url) {
      const pr = d.pr, name = `${pr.kind} ${pr.mark}${pr.number}`;
      // the reference can be in the title, the description or the branch name
      for (const token of refsIn(`${pr.title}\n${pr.text}\n${pr.branch}`)) {
        if (actions >= MAX_ACTIONS) break;
        const hit = find(token);
        if (!hit) continue;
        link(hit, pr.url);
        if (pr.opened && once(teamId, `pr:${pr.url}:${hit.p.id}:${hit.c.id}`)) comment(hit, `${pr.author} linked this card to ${name} “${pr.title || 'Untitled'}” in ${where}.\n${pr.url}`);
        if (pr.merged && once(teamId, `pm:${pr.url}:${hit.p.id}:${hit.c.id}`)) {
          const closes = finish(hit);
          comment(hit, `${pr.author} merged ${name} “${pr.title || 'Untitled'}” in ${where}${closes ? ', which marks this card done' : ''}.\n${pr.url}`);
        }
      }
    }
    for (const [projectId, pl] of plans) {
      const ops = [...[...pl.cards.values()].map(obj => ({ k: 'items', op: 'put', obj })), ...pl.comments];
      if (!ops.length) continue;
      const r = live().serverBatch(projectId, bot, 'editor', ops);
      if (!r || r.full || r.quota) log('[git] not everything was saved in', projectId, r ? (r.full ? 'board full' : 'storage full') : 'project gone');
    }
    return { ok: true, comments, done };
  }

  return { info };
}

module.exports = { gitlink, BOTS, refHash, cardCodes, findCard, refsIn, closingRefs };
