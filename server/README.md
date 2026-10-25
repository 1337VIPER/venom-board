# Run your own Venom Board server

This folder is the server behind venomboard.com's accounts and teams, for running on your own machine. It
gives your team:

- accounts, teams and roles, shared projects, live editing, comments and mentions, and version history,
- the MCP endpoint (`/mcp`) for tools that support the Model Context Protocol,
- public roadmaps, playtest feedback forms and the in-game bug reporter,
- GitHub and GitLab links, calendar feeds, and screenshot links.

It's one Node.js program with its data in SQLite, so there's no separate database to install: everything lives
in one folder you back up. It serves the Venom Board web app at `/app` from this repository.

## What you need

- A machine with **Docker** (with Docker Compose), or **Node.js 22** if you'd rather run it directly. 1 GB of
  memory is plenty for a small team.
- A **domain** (or subdomain) pointing at that machine, with ports 80 and 443 open, for HTTPS. Browsers need
  HTTPS for sign-in cookies and live connections, unless it's only for you on `localhost`.
- Optional: an **email** mailbox with SMTP, for confirming addresses, password resets and email invites. See
  [Without email](#without-email).

## Quick start with Docker

```sh
git clone https://github.com/1337VIPER/venom-board.git
cd venom-board/server
cp .env.example .env      # set DOMAIN (and email, if you have it)
docker compose up -d
```

That builds the server, starts it, and starts [Caddy](https://caddyserver.com) in front of it, which gets and
renews the HTTPS certificate for your domain by itself. After a minute or so:

1. Open `https://your-domain/account` and create your account.
2. Open `https://your-domain/app`, make a team in the Team panel, and invite your teammates by username or email.

Data lives in Docker volumes (`venom-board-data` for the server, `caddy-data` for certificates). See what the
server is doing with `docker compose logs -f venom-board`.

## Without Docker

```sh
git clone https://github.com/1337VIPER/venom-board.git
cd venom-board/server
npm ci --omit=dev
cp .env.example .env      # set PUBLIC_URL, and email if you have it
node src/index.js
```

It listens on `127.0.0.1:8787` by default. Put a reverse proxy with HTTPS in front of it (Caddy, nginx or
similar) that passes WebSocket connections through, and set `TRUST_PROXY=true` only if that proxy sets
`X-Real-IP` to the visitor's address (the server's rate limits count by address). Keep it running with
systemd, pm2 or similar. The database and pictures go in `server/data` unless you set `DATA_DIR`.

## Connecting to it

- **Web app:** `https://your-domain/app` uses your server automatically.
- **Desktop app:** in the Team panel's sign-in, choose **Use your own server** and enter `https://your-domain`.
- **Unreal, Unity and Godot panels:** put `https://your-domain` in the panel's **Server** field.
- **MCP:** make a token at `https://your-domain/account#mcp`, then point your tool at `https://your-domain/mcp`.

## Without email

Without email, accounts can't confirm their address, so they keep the limits for unconfirmed accounts (one team
led, 10 projects, 100 MB). Forgotten passwords can't be reset either, and invites by email don't arrive (invites
by username still work). Either:

- set `MAIL_LOG=on`, and each email, links included, goes to the server's log, so whoever runs the server can
  pass the links on; or
- raise `LIMIT_UNVERIFIED_TEAMS`, `LIMIT_UNVERIFIED_PROJECTS` and `LIMIT_UNVERIFIED_STORAGE_MB`.

## Settings

Everything is set in `server/.env`; [.env.example](.env.example) lists each setting with its default. The
ones you're most likely to change: `DOMAIN` (or `PUBLIC_URL`), the email settings, `TEAM_STORAGE_MB`,
`PROJECT_MAX_MB` and `VIDEO_UPLOADS`.

## Backups and updates

- **Back up** the data folder: the Docker volume `venom-board-data`, or `server/data` (or your `DATA_DIR`). It
  holds the database (`venom-board.db`) and the uploaded pictures. Stop the server first, or copy the database
  with `sqlite3 venom-board.db ".backup copy.db"`, so the copy is consistent.
- **Update** with `git pull`, then `docker compose up -d --build` (or `npm ci --omit=dev` and a restart). Update
  promptly: fixes reach venomboard.com and this folder at the same time.

## Security

Keep the server updated, and keep `server/.env` and the data folder private: the database holds your team's
boards and accounts. Report security problems privately, as [SECURITY.md](../SECURITY.md) describes, rather
than in a public issue.

## Licence

The server in this folder is licensed under the **GNU Affero General Public License v3.0** ([LICENSE](LICENSE)):
you can run it, change it and share it, and if you let others use a changed version over a network, you offer
them its source too. The Venom Board app in the rest of this repository is MIT licensed.

Venom Board is created by 1337VIPER.
