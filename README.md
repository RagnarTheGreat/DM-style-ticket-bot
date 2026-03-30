# DM Modmail–style Ticket Bot

Self-hosted **Discord** bot: users **DM the bot** to open support; staff work in a **normal text channel** in your server. Messages relay both ways. Closing a ticket generates a **web transcript** (Discord OAuth + secret URL).

**Repository:** [github.com/RagnarTheGreat/DM-style-ticket-bot](https://github.com/RagnarTheGreat/DM-style-ticket-bot)

**Stack:** Node.js 20+ · [discord.js](https://discord.js.org/) v14 · SQLite ([better-sqlite3](https://github.com/WiseLibs/better-sqlite3)) · [Express](https://expressjs.com/)

---

## Table of contents

- [Features](#features)
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Environment variables](#environment-variables)
- [Discord app setup](#discord-app-setup)
- [Domain & HTTPS (your own URL)](#domain--https-your-own-url)
- [Multi-server setup (public + support)](#multi-server-setup-public--support)
- [Slash commands](#slash-commands)
- [Transcripts & privacy](#transcripts--privacy)
- [Production](#production)
- [Project layout](#project-layout)
- [Troubleshooting](#troubleshooting)
- [License](#license)

---

## Features

| | |
|---|---|
| **DM-first** | Users open tickets by messaging the bot (they must [share a server](https://support.discord.com/hc/en-us/articles/360002293851-Discord-Rate-Limits) with the bot so DMs work, per Discord rules). |
| **One open ticket per user** | Reuses the same ticket channel if they DM again while open. |
| **SQLite** | Local storage with WAL; back up `DATABASE_PATH`. |
| **Web transcripts** | HTML pages; links use `/transcript/:publicId/:secret`. Login via Discord OAuth (`identify`). |
| **Staff notes** | Lines starting with **`!sc`** in the ticket channel are **not** sent to the user; stored as internal transcript lines. |
| **Blacklist** | `/blacklist add \| remove \| list` — block **new** DM tickets (after `/setup`). |
| **Claim / unclaim** | `/claim` · `/unclaim` — optional ownership; topic updates. |
| **Typing hints** | Optional throttled hints (user ↔ staff directions). Set `TICKET_TYPING_HINTS=0` to disable. |
| **Welcome DM** | Optional `TICKET_WELCOME_TITLE` / `TICKET_WELCOME_DESCRIPTION` sent to the user when a ticket opens. |
| **Delivered hint** | Bot reacts with a green check (✅) on the user’s DM when the message was relayed to the ticket channel. |

---

## How it works

1. After **`/setup`**, a user **DMs the bot**.
2. A **ticket channel** is created under your category; your **support role** is pinged.
3. **Staff reply in-channel** → the user gets the message in **DM**.
4. **User DMs** → show in the ticket channel (embeds + attachments).
5. **`/close`** closes the ticket, notifies the user, posts a log embed with transcript link, and **deletes** the channel.

---

## Requirements

- **Node.js** ≥ 20.10
- A Discord **application** (bot token + OAuth2 **client secret** for transcript pages)
- **Privileged intent:** **Message Content** (Developer Portal → Bot)
- For typing hints: **Direct Message Typing** + **Guild Message Typing** (enable alongside other gateway intents your dashboard shows)
- One **`GUILD_ID`** in `.env` — the server where ticket channels are created ([multi-server](#multi-server-setup-public--support) notes below)

---

## Quick start

```bash
git clone https://github.com/RagnarTheGreat/DM-style-ticket-bot.git
cd DM-style-ticket-bot
npm install
cp .env.example .env
```

Edit `.env` (see [Environment variables](#environment-variables)), then:

```bash
npm run start
```

Complete [Discord app setup](#discord-app-setup), invite the bot with **`bot`** + **`applications.commands`**, run **`/setup`** in your ticket server.

> **Security:** Never commit `.env` or real tokens. Add `.env` to `.gitignore` (default for most Node projects).

---

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DISCORD_TOKEN` | Yes | Bot token |
| `CLIENT_ID` | Yes | Application (client) ID |
| `GUILD_ID` | Yes | Server ID where tickets and `/setup` live |
| `OWNER_ID` | Yes | Your user ID (for `/setup` and permission bypasses) |
| `DISCORD_CLIENT_SECRET` | Yes* | OAuth2 secret — *required for transcript login* |
| `PUBLIC_BASE_URL` | Recommended | Public `https://` URL of this app (transcript links, OAuth) |
| `DISCORD_REDIRECT_URI` | Recommended | e.g. `https://your.domain/auth/discord/callback` — must match the Developer Portal |
| `PORT` | No | HTTP port (default `3000`) |
| `DATABASE_PATH` | No | SQLite path (default `./data/tickets.sqlite`) |
| `AUTH_COOKIE_SECRET` | No | Cookie signing secret (set in production; do not rely on the default) |
| `TICKET_WELCOME_TITLE` | No | Welcome **DM** title when a ticket opens |
| `TICKET_WELCOME_DESCRIPTION` | No | Welcome **DM** body (`\n` → newline) |
| `TICKET_TYPING_HINTS` | No | `0` disables typing hints |
| `TICKET_TYPING_COOLDOWN_MS` | No | Min ms between hints per ticket per direction (default `8000`) |

---

## Discord app setup

1. [Discord Developer Portal](https://discord.com/developers/applications) → your app → **Bot** → copy token; enable **Message Content Intent** (and other intents your build uses).
2. **OAuth2** → **Redirects** → add exactly:  
   `https://YOUR_DOMAIN/auth/discord/callback` (same as `DISCORD_REDIRECT_URI`).
3. **OAuth2** → copy **Client ID** and **Client Secret** into `.env`.
4. Build an invite URL with scopes **`bot`** and **`applications.commands`**, and permissions such as: View Channels, Send Messages, Read Message History, Embed Links, Attach Files, **Manage Channels**.
5. Slash commands register against **`GUILD_ID`** on startup — restart the bot after changing env or command code.

---

## Domain & HTTPS (your own URL)

Transcript links and Discord OAuth need a **public HTTPS URL** that points at this app (the Express server on `PORT`). Localhost alone is not enough for other people to open transcripts.

### 1. Point your domain at the server

- In your DNS provider, create an **A** record (or **AAAA** for IPv6) from your hostname (e.g. `tickets.example.com`) to your VPS IP, or use a **CNAME** if your host gives you one (e.g. some PaaS).
- Wait for DNS to propagate (often minutes, sometimes up to 48h).

### 2. TLS (HTTPS)

- Use **Nginx** or **Caddy** with **Let’s Encrypt**, or put the host behind **Cloudflare** (proxy + “Full (strict)” SSL), or use **Cloudflare Tunnel** if you don’t want to open ports on the machine.
- Browsers and Discord OAuth require **HTTPS** for production; don’t use plain `http://` for `PUBLIC_BASE_URL` on the public internet.

### 3. Reverse proxy to Node

- The bot listens on **`PORT`** (default `3000`). Configure your proxy so **HTTPS** traffic to `https://tickets.example.com` is forwarded to `http://127.0.0.1:3000` (or whatever `PORT` you set).
- Keep **WebSocket** not needed for this app — plain HTTP proxy for `/`, `/auth/*`, `/transcript/*`, `/health` is enough.

### 4. Environment variables (must match)

Set in `.env`:

```env
PUBLIC_BASE_URL=https://tickets.example.com
DISCORD_REDIRECT_URI=https://tickets.example.com/auth/discord/callback
PORT=3000
```

- **No trailing slash** on `PUBLIC_BASE_URL` (the code normalizes transcript URLs).
- `DISCORD_REDIRECT_URI` must be **exactly** the same string you add in the Discord Developer Portal → **OAuth2** → **Redirects**.

### 5. Discord Developer Portal

- **OAuth2** → **Redirects** → add: `https://tickets.example.com/auth/discord/callback` (your real domain).
- Save changes. If login fails, compare the URI **character-for-character** with `.env`.

### 6. Optional: `/setup` transcript base URL

If you use a different public URL than `PUBLIC_BASE_URL`, you can pass **`transcript_base_url`** in `/setup` so log embeds use the right domain; otherwise the bot falls back to `PUBLIC_BASE_URL`.

### 7. Restart

Restart the bot after changing `.env` so transcript links and cookies use the new host.

---

## Multi-server setup (public + support)

Use a **community server** (users) and a **support server** (staff). Set **`GUILD_ID` to the support server** — that is where ticket channels and **`/setup`** live.

| Piece | Role |
|-------|------|
| **Public server** | Users share this server with the bot so they can **DM** it. They do **not** need to join the support server. |
| **Support server** (`GUILD_ID`) | Ticket category, log channel, roles, and all staff slash commands in ticket channels. |
| **Bot** | Invite the **same** bot to **both** servers; it needs **Manage Channels** (and related perms) in the **support** server. |

**Limits:** This project does **not** route tickets to different guilds per user. Every ticket uses the guild in `GUILD_ID`. Separate products or brands usually mean **separate deployments** (or fork + multi-guild code).

---

## Slash commands

| Command | Notes |
|---------|--------|
| `/setup` | Owner / `OWNER_ID`; sets category, log channel, support + transcript roles. |
| `/close` | Support / mods (see code); optional reason; transcript + log. |
| `/rename` | Rename ticket channel. |
| `/claim` · `/unclaim` | Claim handling. |
| `/blacklist` | `add` / `remove` / `list` — block new DM tickets. |

---

## Transcripts & privacy

- URLs look like `/transcript/:publicId/:secret`.
- Viewing requires **Discord login** and authorization (ticket author, guild owner, or transcript-view role).
- Use **HTTPS** in production; protect `AUTH_COOKIE_SECRET`.
- Keep transcript links inside a **staff-only** log channel.

---

## Production

- Run under **PM2**, **systemd**, or **Docker** so the process stays up.
- Put **Nginx**, **Caddy**, or **Cloudflare Tunnel** in front of `PORT` for HTTPS and your public domain.
- **Back up** the SQLite file on a schedule.
- Restart after `.env` or command changes so guild commands refresh.

---

## Project layout

```
src/
  index.js       # Bot: relays, commands, typing hints
  commands.js    # Slash commands + registration
  db.js          # SQLite schema
  server.js      # Express: OAuth, transcripts, /health
  transcripts.js # HTML transcripts
  config.js      # Environment
```

---

## Troubleshooting

| Issue | What to check |
|-------|----------------|
| No message content from users | Message Content intent enabled |
| Slash commands missing | `applications.commands` invite; correct `GUILD_ID`; bot restarted |
| Transcript login fails | Redirect URI matches portal; `CLIENT_SECRET`; `PUBLIC_BASE_URL` |
| Transcript page error | Server logs; DB file path; Node / `Intl` (see `transcripts.js`) |

---

## License

Add a `LICENSE` file to your repo (e.g. MIT) if you want a standard open-source license. This project does not ship a license by default.

---

## Contributing

Issues and pull requests are welcome. For larger changes, open an issue first to align on scope.
