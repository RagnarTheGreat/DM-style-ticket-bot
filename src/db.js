import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { config } from "./config.js";

const dbDir = path.dirname(config.databasePath);
fs.mkdirSync(dbDir, { recursive: true });

export const db = new Database(config.databasePath);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.pragma("temp_store = MEMORY");

db.exec(`
CREATE TABLE IF NOT EXISTS guild_settings (
  guild_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  category_id TEXT NOT NULL,
  log_channel_id TEXT NOT NULL,
  support_role_id TEXT NOT NULL,
  transcript_view_role_id TEXT NOT NULL,
  transcript_base_url TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  channel_id TEXT NOT NULL UNIQUE,
  channel_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','closed')) DEFAULT 'open',
  close_reason TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  closed_at INTEGER,
  closed_by TEXT,
  claimed_by TEXT,
  transcript_public_id TEXT,
  transcript_secret TEXT
);

CREATE INDEX IF NOT EXISTS idx_tickets_user_status ON tickets(user_id, status);
CREATE INDEX IF NOT EXISTS idx_tickets_guild_status ON tickets(guild_id, status);

CREATE TABLE IF NOT EXISTS ticket_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL,
  author_id TEXT NOT NULL,
  author_tag TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('dm_to_staff','staff_to_dm','system','staff_internal')),
  content TEXT,
  attachments_json TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ticket_messages_ticket ON ticket_messages(ticket_id, created_at);

CREATE TABLE IF NOT EXISTS ticket_blacklist (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  added_by TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (guild_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_ticket_blacklist_guild ON ticket_blacklist(guild_id);
`);

{
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'ticket_messages'").get();
  if (row?.sql && !row.sql.includes("staff_internal")) {
    db.exec(`
      CREATE TABLE ticket_messages_migrated (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id INTEGER NOT NULL,
        author_id TEXT NOT NULL,
        author_tag TEXT NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('dm_to_staff','staff_to_dm','system','staff_internal')),
        content TEXT,
        attachments_json TEXT,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
      );
      INSERT INTO ticket_messages_migrated SELECT * FROM ticket_messages;
      DROP TABLE ticket_messages;
      ALTER TABLE ticket_messages_migrated RENAME TO ticket_messages;
      CREATE INDEX IF NOT EXISTS idx_ticket_messages_ticket ON ticket_messages(ticket_id, created_at);
    `);
  }
}

{
  const cols = db.prepare("PRAGMA table_info(tickets)").all();
  const hasClaimed = cols.some((c) => c.name === "claimed_by");
  if (!hasClaimed) {
    db.exec(`ALTER TABLE tickets ADD COLUMN claimed_by TEXT;`);
  }
}

export const statements = {
  getSettings: db.prepare("SELECT * FROM guild_settings WHERE guild_id = ?"),
  upsertSettings: db.prepare(`
    INSERT INTO guild_settings (guild_id, owner_id, category_id, log_channel_id, support_role_id, transcript_view_role_id, transcript_base_url)
    VALUES (@guild_id, @owner_id, @category_id, @log_channel_id, @support_role_id, @transcript_view_role_id, @transcript_base_url)
    ON CONFLICT(guild_id) DO UPDATE SET
      owner_id = excluded.owner_id,
      category_id = excluded.category_id,
      log_channel_id = excluded.log_channel_id,
      support_role_id = excluded.support_role_id,
      transcript_view_role_id = excluded.transcript_view_role_id,
      transcript_base_url = excluded.transcript_base_url
  `),
  findOpenTicketByUser: db.prepare("SELECT * FROM tickets WHERE guild_id = ? AND user_id = ? AND status = 'open' LIMIT 1"),
  findTicketByChannel: db.prepare("SELECT * FROM tickets WHERE channel_id = ? LIMIT 1"),
  createTicket: db.prepare(`
    INSERT INTO tickets (guild_id, user_id, channel_id, channel_name, status)
    VALUES (@guild_id, @user_id, @channel_id, @channel_name, 'open')
  `),
  closeTicket: db.prepare(`
    UPDATE tickets
    SET status = 'closed', close_reason = @close_reason, closed_at = strftime('%s','now'), closed_by = @closed_by,
        transcript_public_id = @transcript_public_id, transcript_secret = @transcript_secret
    WHERE id = @id
  `),
  renameTicket: db.prepare(`
    UPDATE tickets SET channel_name = @channel_name WHERE id = @id AND status = 'open'
  `),
  setTicketClaimedBy: db.prepare(`
    UPDATE tickets SET claimed_by = @claimed_by WHERE id = @id AND status = 'open'
  `),
  isTicketBlacklisted: db.prepare(
    "SELECT 1 AS ok FROM ticket_blacklist WHERE guild_id = ? AND user_id = ? LIMIT 1"
  ),
  addTicketBlacklist: db.prepare(`
    INSERT OR IGNORE INTO ticket_blacklist (guild_id, user_id, added_by) VALUES (@guild_id, @user_id, @added_by)
  `),
  removeTicketBlacklist: db.prepare("DELETE FROM ticket_blacklist WHERE guild_id = ? AND user_id = ?"),
  listTicketBlacklist: db.prepare(
    "SELECT user_id, added_by, created_at FROM ticket_blacklist WHERE guild_id = ? ORDER BY created_at DESC LIMIT 50"
  ),
  addMessage: db.prepare(`
    INSERT INTO ticket_messages (ticket_id, author_id, author_tag, direction, content, attachments_json)
    VALUES (@ticket_id, @author_id, @author_tag, @direction, @content, @attachments_json)
  `),
  getTicketMessages: db.prepare("SELECT * FROM ticket_messages WHERE ticket_id = ? ORDER BY created_at ASC"),
  getTicketByPublic: db.prepare("SELECT * FROM tickets WHERE transcript_public_id = ? LIMIT 1")
};
