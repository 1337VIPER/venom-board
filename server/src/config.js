// Server settings. Values come from environment variables or server/.env (KEY=value lines).
const fs = require('fs');
const path = require('path');

// the folder holding server/: venomboard.com's private repository (with web/ beside it), or the app's own
// repository for a self-hosted server (with the app's index.html beside it and the pages in server/web/)
const ROOT = path.resolve(__dirname, '..', '..');

function loadEnvFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return; }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
loadEnvFile(path.join(ROOT, 'server', '.env'));

function config(overrides = {}) {
  const env = { ...process.env, ...overrides };
  const publicUrl = String(env.PUBLIC_URL || `http://localhost:${env.PORT || 8787}`).replace(/\/+$/, '');
  const host = env.HOST || '127.0.0.1';
  return {
    ROOT,
    PORT: Number(env.PORT ?? 8787),
    HOST: host,
    PUBLIC_URL: publicUrl,
    PUBLIC_ORIGIN: new URL(publicUrl).origin,
    DATA_DIR: path.resolve(env.DATA_DIR || path.join(ROOT, 'server', 'data')),
    // the public Venom Board app (index.html, docs/, assets/), served at /app: this repository when it's the app's own,
    // otherwise a checkout of the app repo beside it
    APP_DIR: path.resolve(env.APP_DIR || (fs.existsSync(path.join(ROOT, 'index.html')) ? ROOT : path.join(ROOT, '..', 'venom-board'))),
    // the account page, the playtest form and the other pages' scripts and styles
    WEB_DIR: path.resolve(env.WEB_DIR || (fs.existsSync(path.join(ROOT, 'web')) ? path.join(ROOT, 'web') : path.join(ROOT, 'server', 'web'))),
    SECURE_COOKIES: publicUrl.startsWith('https://'),
    SMTP_HOST: env.SMTP_HOST || '',
    SMTP_PORT: Number(env.SMTP_PORT || 587),
    SMTP_USER: env.SMTP_USER || '',
    SMTP_PASS: env.SMTP_PASS || '',
    RESEND_API_KEY: env.RESEND_API_KEY || '',
    MAIL_FROM: env.MAIL_FROM || `Venom Board <no-reply@${new URL(publicUrl).hostname}>`,
    MAIL_REPLY_TO: env.MAIL_REPLY_TO || '',
    MAIL_LOG: env.MAIL_LOG || 'off',  // 'on' writes emails (with their links) to the log when no email is set up
    SESSION_DAYS: Number(env.SESSION_DAYS || 30),
    // How much each account and team may have, so nobody can fill the server or flood it with spam.
    // Accounts that haven't confirmed their email get a trial-sized allowance until they do.
    LIMIT_TEAMS_LED: Number(env.LIMIT_TEAMS_LED || 10),
    LIMIT_TEAMS_JOINED: Number(env.LIMIT_TEAMS_JOINED || 30),      // teams an account is in, led or not
    LIMIT_TEAM_PROJECTS: Number(env.LIMIT_TEAM_PROJECTS || 100),
    LIMIT_TEAM_MEMBERS: Number(env.LIMIT_TEAM_MEMBERS || 50),      // members plus invites still waiting
    LIMIT_UNVERIFIED_TEAMS: Number(env.LIMIT_UNVERIFIED_TEAMS || 1),
    LIMIT_UNVERIFIED_PROJECTS: Number(env.LIMIT_UNVERIFIED_PROJECTS || 10),
    PROJECT_MAX_MB: Number(env.PROJECT_MAX_MB || 10),              // size of one project's board, images not included
    // Storage counts everything a team keeps on the server: images, boards and their version history.
    TEAM_STORAGE_MB: Number(env.TEAM_STORAGE_MB || 500),           // per team
    LEADER_STORAGE_MB: Number(env.LEADER_STORAGE_MB || 1024),      // across all the teams one account leads
    LIMIT_UNVERIFIED_STORAGE_MB: Number(env.LIMIT_UNVERIFIED_STORAGE_MB || 100),  // both, until the leader confirms their email
    // Uploading video files to team projects. Off by default: Cloudflare's free plan doesn't allow serving video
    // through it, so only turn this on with media served some other way. YouTube and Vimeo links always work.
    VIDEO_UPLOADS: env.VIDEO_UPLOADS === 'on',
    INTAKE_SHOTS_PER_SENDER: Number(env.INTAKE_SHOTS_PER_SENDER || 10),  // players' screenshots kept per network, per project, per day
    INTAKE_SHOT_MB_PER_DAY: Number(env.INTAKE_SHOT_MB_PER_DAY || 50),    // and in all for a project per day
    VIDEO_MAX_MB: Number(env.VIDEO_MAX_MB || 25),                  // one uploaded video (counts toward storage)
    // Screenshot links (/s/<id>): each account's space for them (only accounts that confirmed their email make them). 'off' stops new
    // uploads; links already made keep working until their owners delete them.
    SHOTS: env.SHOTS || 'on',
    // the Bluesky account venomboard.com belongs to, served at /.well-known/atproto-did so it can use the domain as its handle
    BLUESKY_DID: env.BLUESKY_DID || '',  // a Bluesky handle this address proves it owns (/.well-known/atproto-did)
    SHOT_STORAGE_MB: Number(env.SHOT_STORAGE_MB || 500),
    // MCP tools may fetch pictures from public web addresses only; tests turn this on to fetch from this computer
    MCP_FETCH_PRIVATE: env.MCP_FETCH_PRIVATE === 'on',
    LIMIT_NAMED_VERSIONS: Number(env.LIMIT_NAMED_VERSIONS || 30),  // per project; automatic versions are thinned out by age
    // emails a day, all kinds together: keep it under the mailbox provider's own sending limit
    MAIL_DAILY_LIMIT: Number(env.MAIL_DAILY_LIMIT || 800),        // most mailboxes allow about 1,000 a day
    MAIL_PER_10_MIN: Number(env.MAIL_PER_10_MIN || 40),            // ...and 50 in any 10 minutes; extra emails wait in line
    // where warnings go (disk filling up, the email budget running low, reported boards): the sending mailbox by default
    // who people write to when something's urgent (shown in a few messages); empty hides those lines
    SUPPORT_EMAIL: env.SUPPORT_EMAIL || env.MAIL_REPLY_TO || '',
    ALERT_EMAIL: env.ALERT_EMAIL || ((env.MAIL_FROM || '').match(/<([^>]+)>/) || [])[1] || env.MAIL_FROM || '',
    ALERT_FREE_DISK_MB: Number(env.ALERT_FREE_DISK_MB || 6144),
    DISCORD_DELAY_MS: Number(env.DISCORD_DELAY_MS || 8000),        // posts are gathered this long and sent as one
    SEARCH_INDEX_DELAY_MS: Number(env.SEARCH_INDEX_DELAY_MS || 10000),
    INDEXNOW: env.INDEXNOW || 'on',                                // 'off' stops telling search engines about new pages
    // the owner's dashboard at /admin: the usernames that may open it (comma-separated; nobody if empty), and
    // whether they need two-step sign-in on to do so
    ADMIN_USERS: env.ADMIN_USERS || '',
    ADMIN_REQUIRE_2FA: env.ADMIN_REQUIRE_2FA || 'on',
    // 'on' counts website visits for the dashboard (no cookies; nothing that identifies anyone is kept)
    VISIT_STATS: env.VISIT_STATS || 'off',
    GITHUB_REPO: env.GITHUB_REPO || '1337VIPER/venom-board',      // where the dashboard reads download counts
    MIN_FREE_DISK_MB: Number(env.MIN_FREE_DISK_MB || 2048), // uploads stop before the disk gets this full
    // behind Caddy the visitor's address arrives in X-Real-IP. That header is only believed while Node listens
    // on localhost, where nothing but Caddy can reach it; exposed directly, anyone could fake it.
    TRUST_PROXY: env.TRUST_PROXY !== undefined ? env.TRUST_PROXY === 'true' : ['127.0.0.1', '::1', 'localhost'].includes(host),
    RATE_SCALE: Number(env.RATE_SCALE || 1),     // multiplies every rate limit (tests raise it)
    QUIET: env.QUIET === 'true',
  };
}

module.exports = { config };
