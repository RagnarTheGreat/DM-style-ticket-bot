import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Load from project root so TICKET_* and other vars work even if cwd (e.g. PM2) is not the repo root.
dotenv.config({ path: path.join(__dirname, "..", ".env") });

export const config = {
  token: process.env.DISCORD_TOKEN,
  clientId: process.env.CLIENT_ID,
  clientSecret: process.env.DISCORD_CLIENT_SECRET,
  guildId: process.env.GUILD_ID,
  ownerId: process.env.OWNER_ID,
  port: Number(process.env.PORT || 3000),
  publicBaseUrl: process.env.PUBLIC_BASE_URL || "http://localhost:3000",
  databasePath: process.env.DATABASE_PATH || "./data/tickets.sqlite",
  discordRedirectUri: process.env.DISCORD_REDIRECT_URI || `${process.env.PUBLIC_BASE_URL || "http://localhost:3000"}/auth/discord/callback`,
  authCookieSecret: process.env.AUTH_COOKIE_SECRET || process.env.DISCORD_TOKEN || "dev-secret",
  ticketWelcomeTitle: (process.env.TICKET_WELCOME_TITLE || "").trim(),
  ticketWelcomeDescription: (process.env.TICKET_WELCOME_DESCRIPTION || "").replace(/\\n/g, "\n").trim(),
  typingHintsEnabled: process.env.TICKET_TYPING_HINTS !== "0",
  typingHintCooldownMs: Number(process.env.TICKET_TYPING_COOLDOWN_MS || 8000)
};

export function assertConfig() {
  const required = ["token", "clientId", "guildId", "ownerId"];
  const missing = required.filter((k) => !config[k]);
  if (missing.length) {
    throw new Error(`Missing env keys: ${missing.join(", ")}`);
  }
}
