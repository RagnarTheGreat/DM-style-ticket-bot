import crypto from "node:crypto";
import express from "express";
import { config } from "./config.js";
import { statements } from "./db.js";
import { renderTranscriptHtml } from "./transcripts.js";

const COOKIE_NAME = "tb_auth";
const SESSION_TTL_SECONDS = 60 * 60 * 24;
const STATE_TTL_SECONDS = 60 * 10;

function b64urlEncode(value) {
  return Buffer.from(value).toString("base64url");
}

function b64urlDecode(value) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function signValue(value) {
  return crypto.createHmac("sha256", config.authCookieSecret).update(value).digest("hex");
}

function createSignedToken(payload) {
  const body = b64urlEncode(JSON.stringify(payload));
  return `${body}.${signValue(body)}`;
}

function parseSignedToken(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig || signValue(body) !== sig) return null;
  try {
    return JSON.parse(b64urlDecode(body));
  } catch {
    return null;
  }
}

function parseCookies(req) {
  const raw = req.headers.cookie || "";
  const out = {};
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    out[key] = decodeURIComponent(val);
  }
  return out;
}

function getAuthedUserId(req) {
  const token = parseCookies(req)[COOKIE_NAME];
  const payload = parseSignedToken(token);
  if (!payload?.userId || !payload?.exp) return null;
  if (Date.now() > payload.exp) return null;
  return String(payload.userId);
}

function setAuthCookie(res, userId) {
  const payload = { userId: String(userId), exp: Date.now() + SESSION_TTL_SECONDS * 1000 };
  const token = createSignedToken(payload);
  const secure = config.publicBaseUrl.startsWith("https://");
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SESSION_TTL_SECONDS}`
  ];
  if (secure) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function createAuthState(nextPath) {
  return createSignedToken({ nextPath, exp: Date.now() + STATE_TTL_SECONDS * 1000 });
}

function parseAuthState(stateToken) {
  const payload = parseSignedToken(stateToken);
  if (!payload?.nextPath || !payload?.exp) return null;
  if (Date.now() > payload.exp) return null;
  return payload;
}

async function fetchDiscordUser(accessToken) {
  const res = await fetch("https://discord.com/api/users/@me", {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) return null;
  return res.json();
}

async function fetchGuildMember(guildId, userId) {
  const res = await fetch(`https://discord.com/api/guilds/${guildId}/members/${userId}`, {
    headers: { Authorization: `Bot ${config.token}` }
  });
  if (!res.ok) return null;
  return res.json();
}

async function canViewTranscript(ticket, userId) {
  if (String(userId) === String(ticket.user_id)) return true;
  const settings = statements.getSettings.get(ticket.guild_id);
  if (!settings) return false;
  if (String(userId) === String(settings.owner_id)) return true;
  const member = await fetchGuildMember(ticket.guild_id, userId);
  if (!member || !Array.isArray(member.roles)) return false;
  return member.roles.includes(settings.transcript_view_role_id);
}

export function startServer({ port }) {
  const app = express();

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/auth/discord", (req, res) => {
    if (!config.clientSecret) {
      return res.status(500).send("Missing DISCORD_CLIENT_SECRET in environment.");
    }
    const next = typeof req.query.next === "string" ? req.query.next : "/";
    const nextPath = next.startsWith("/") ? next : "/";
    const state = createAuthState(nextPath);
    const authUrl = new URL("https://discord.com/api/oauth2/authorize");
    authUrl.searchParams.set("client_id", config.clientId);
    authUrl.searchParams.set("redirect_uri", config.discordRedirectUri);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", "identify");
    authUrl.searchParams.set("state", state);
    return res.redirect(authUrl.toString());
  });

  app.get("/auth/discord/callback", async (req, res) => {
    try {
      if (!config.clientSecret) {
        return res.status(500).send("Missing DISCORD_CLIENT_SECRET in environment.");
      }
      const code = typeof req.query.code === "string" ? req.query.code : null;
      const stateToken = typeof req.query.state === "string" ? req.query.state : null;
      if (!code || !stateToken) return res.status(400).send("Missing OAuth code/state.");

      const state = parseAuthState(stateToken);
      if (!state) return res.status(400).send("Invalid or expired OAuth state.");

      const body = new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: "authorization_code",
        code,
        redirect_uri: config.discordRedirectUri
      });
      const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body
      });
      if (!tokenRes.ok) return res.status(401).send("Discord OAuth token exchange failed.");

      const tokenJson = await tokenRes.json();
      const user = await fetchDiscordUser(tokenJson.access_token);
      if (!user?.id) return res.status(401).send("Discord user lookup failed.");

      setAuthCookie(res, user.id);
      return res.redirect(state.nextPath);
    } catch (error) {
      console.error("[web] oauth callback error:", error);
      return res.status(500).send("OAuth callback failed.");
    }
  });

  app.get("/transcript/:publicId/:secret", async (req, res) => {
    const userId = getAuthedUserId(req);
    if (!userId) {
      const next = encodeURIComponent(req.originalUrl || "/");
      return res.redirect(`/auth/discord?next=${next}`);
    }

    const { publicId, secret } = req.params;
    const ticket = statements.getTicketByPublic.get(publicId);
    if (!ticket || !ticket.transcript_secret || ticket.transcript_secret !== secret) {
      return res.status(404).send("Transcript not found.");
    }

    try {
      const allowed = await canViewTranscript(ticket, userId);
      if (!allowed) return res.status(403).send("You are not allowed to view this transcript.");
      const messages = statements.getTicketMessages.all(ticket.id);
      return res.status(200).send(renderTranscriptHtml(ticket, messages));
    } catch (error) {
      console.error("[web] transcript route error:", error);
      return res.status(500).send("Failed to load transcript.");
    }
  });

  app.listen(port, () => {
    console.log(`[web] transcript server listening on :${port}`);
  });
}
