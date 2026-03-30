import {
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  PermissionsBitField
} from "discord.js";
import { nanoid } from "nanoid";
import { assertConfig, config } from "./config.js";
import { registerCommands } from "./commands.js";
import { db, statements } from "./db.js";
import { startServer } from "./server.js";

assertConfig();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageTyping,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.DirectMessageTyping,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

function isOwner(interaction) {
  return interaction.guild && interaction.guild.ownerId === interaction.user.id;
}

function canUseTicketStaffCommands(member, settings) {
  if (!member || !settings) return false;
  if (member.user.id === config.ownerId) return true;
  if (member.permissions.has(PermissionsBitField.Flags.Administrator)) return true;
  if (member.permissions.has(PermissionsBitField.Flags.ManageChannels)) return true;
  return member.roles.cache.has(settings.support_role_id);
}

function formatTicketChannelName(user) {
  const safe = user.username.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 16) || "user";
  return `ticket-${safe}-${user.discriminator === "0" ? user.id.slice(-4) : user.discriminator}`;
}

/** Staff-only ticket notes: prefix with `!sc` — not relayed to the user's DMs. Case-insensitive. */
function parseStaffOnlyMessage(content) {
  const m = String(content ?? "").match(/^!sc(?:$|\s+([\s\S]*))$/i);
  if (!m) return null;
  return (m[1] ?? "").trimEnd();
}

function sanitizeTicketChannelName(raw) {
  let s = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  s = s.slice(0, 100);
  return s;
}

async function getGuildSettings(guildId) {
  return statements.getSettings.get(guildId);
}

function resolveTranscriptBaseUrl(settings) {
  const configured = String(settings?.transcript_base_url || "").trim();
  if (!configured || configured.includes("your-domain.example.com")) {
    return String(config.publicBaseUrl || "").trim();
  }
  return configured;
}

/** Staff-only: first message in the ticket channel (no user instructions here — those go in DM). */
function buildStaffNewTicketEmbed(author) {
  return new EmbedBuilder()
    .setTitle("New Ticket Opened")
    .setDescription(`User: <@${author.id}> \`${author.id}\``)
    .setColor(0x57f287)
    .setTimestamp();
}

/** Sent to the ticket author in DM — uses TICKET_WELCOME_* from env. */
function buildUserWelcomeEmbed() {
  const title = (config.ticketWelcomeTitle || "").trim() || "Welcome";
  const desc =
    (config.ticketWelcomeDescription || "").trim() ||
    "Describe your issue in **this DM**. A staff member will reply here when they can.";
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(title)
    .setDescription(desc)
    .setFooter({ text: "Keep messaging here — this is your thread with support." });
}

async function syncTicketChannelTopic(channel, ticket) {
  const user = await client.users.fetch(ticket.user_id);
  let topic = `Ticket for ${user.tag} (${ticket.user_id})`;
  if (ticket.claimed_by) {
    const claimer = await client.users.fetch(ticket.claimed_by).catch(() => null);
    topic += claimer ? ` · Claimed by ${claimer.tag}` : ` · Claimed by user ${ticket.claimed_by}`;
  }
  await channel.setTopic(topic.slice(0, 1024)).catch(() => null);
}

const typingHintLastSent = new Map();

function canForceClaimTakeover(member) {
  if (!member) return false;
  if (member.user.id === config.ownerId) return true;
  return (
    member.permissions.has(PermissionsBitField.Flags.Administrator) ||
    member.permissions.has(PermissionsBitField.Flags.ManageChannels)
  );
}

async function createTicketFromDm(message) {
  const guild = await client.guilds.fetch(config.guildId);
  const settings = await getGuildSettings(guild.id);
  if (!settings) {
    await message.author.send("Ticket system is not configured yet. Please contact a server admin.");
    return null;
  }

  const open = statements.findOpenTicketByUser.get(guild.id, message.author.id);
  if (open) {
    return open;
  }

  if (statements.isTicketBlacklisted.get(guild.id, message.author.id)?.ok) {
    await message.author.send(
      "You cannot open support tickets with this bot. If you think this is a mistake, contact server staff."
    );
    return null;
  }

  const channel = await guild.channels.create({
    name: formatTicketChannelName(message.author),
    type: ChannelType.GuildText,
    parent: settings.category_id,
    topic: `Ticket for ${message.author.tag} (${message.author.id})`.slice(0, 1024)
  });

  const created = statements.createTicket.run({
    guild_id: guild.id,
    user_id: message.author.id,
    channel_id: channel.id,
    channel_name: channel.name
  });
  const ticket = statements.findTicketByChannel.get(channel.id);

  try {
    await channel.send({
      content: `<@&${settings.support_role_id}> New DM ticket from <@${message.author.id}>`,
      embeds: [buildStaffNewTicketEmbed(message.author)]
    });
  } catch (error) {
    console.error("[ticket] failed to send initial channel message:", error);
    await message.author.send(
      "Your ticket was created, but staff cannot currently access/post in the ticket channel. Please tell server staff to re-run /setup and check category permissions."
    );
    return ticket || { id: Number(created.lastInsertRowid), channel_id: channel.id };
  }

  try {
    await message.author.send({ embeds: [buildUserWelcomeEmbed()] });
  } catch (error) {
    console.error("[ticket] failed to send welcome DM:", error);
    await message.author.send(
      "Your ticket was opened for staff, but I could not DM you the welcome message. Check your privacy settings (allow DMs from server members / this bot)."
    );
  }
  return ticket || { id: Number(created.lastInsertRowid), channel_id: channel.id };
}

async function storeMessage(ticketId, author, direction, content, attachments) {
  statements.addMessage.run({
    ticket_id: ticketId,
    author_id: author.id,
    author_tag: author.tag || `${author.username || "Unknown"}#0000`,
    direction: direction,
    content: content || "",
    attachments_json: JSON.stringify(attachments || [])
  });
}

client.on(Events.ClientReady, async () => {
  console.log(`[bot] logged in as ${client.user.tag}`);
  await registerCommands();
  startServer({ port: config.port });
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    if (interaction.commandName === "setup") {
      if (!isOwner(interaction) && interaction.user.id !== config.ownerId) {
        await interaction.reply({ content: "Only the server owner can run this command.", flags: MessageFlags.Ephemeral });
        return;
      }

      const category = interaction.options.getChannel("category", true);
      const logChannel = interaction.options.getChannel("log_channel", true);
      const supportRole = interaction.options.getRole("support_role", true);
      const transcriptViewRole = interaction.options.getRole("transcript_view_role", true);
      const transcriptBaseUrl = interaction.options.getString("transcript_base_url") || config.publicBaseUrl;
      const me = interaction.guild.members.me;
      if (!me) {
        await interaction.reply({ content: "Could not resolve bot member in this guild.", flags: MessageFlags.Ephemeral });
        return;
      }

      const categoryPerms = category.permissionsFor(me);
      const logPerms = logChannel.permissionsFor(me);
      const missingCategory = [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.ManageChannels
      ].filter((perm) => !categoryPerms?.has(perm));
      const missingLog = [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.EmbedLinks
      ].filter((perm) => !logPerms?.has(perm));
      if (missingCategory.length || missingLog.length) {
        await interaction.reply({
          content:
            "Setup failed: bot is missing channel perms. Category needs ViewChannel, SendMessages, ManageChannels. Log channel needs ViewChannel, SendMessages, EmbedLinks.",
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      statements.upsertSettings.run({
        guild_id: interaction.guildId,
        owner_id: interaction.guild.ownerId,
        category_id: category.id,
        log_channel_id: logChannel.id,
        support_role_id: supportRole.id,
        transcript_view_role_id: transcriptViewRole.id,
        transcript_base_url: transcriptBaseUrl
      });

      await interaction.reply({
        content: "Setup saved. DM the bot to create tickets.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    if (interaction.commandName === "blacklist") {
      if (!interaction.inGuild()) {
        await interaction.reply({ content: "Use this command in a server.", flags: MessageFlags.Ephemeral });
        return;
      }
      if (!interaction.member) {
        await interaction.reply({ content: "Could not resolve your member in this server.", flags: MessageFlags.Ephemeral });
        return;
      }

      const settings = await getGuildSettings(interaction.guildId);
      if (!settings) {
        const bypass =
          interaction.user.id === config.ownerId ||
          interaction.member.permissions.has(PermissionsBitField.Flags.Administrator);
        if (!bypass) {
          await interaction.reply({
            content: "Run /setup first. After that, support can manage the blacklist.",
            flags: MessageFlags.Ephemeral
          });
          return;
        }
      } else if (!canUseTicketStaffCommands(interaction.member, settings)) {
        await interaction.reply({
          content: "You don't have permission to manage the ticket blacklist.",
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      const sub = interaction.options.getSubcommand();

      if (sub === "add") {
        const user = interaction.options.getUser("user", true);
        if (user.bot) {
          await interaction.reply({ content: "Bots cannot be blacklisted.", flags: MessageFlags.Ephemeral });
          return;
        }
        const info = statements.addTicketBlacklist.run({
          guild_id: interaction.guildId,
          user_id: user.id,
          added_by: interaction.user.id
        });
        if (info.changes === 0) {
          await interaction.reply({ content: `${user} is already blocked from opening tickets.`, flags: MessageFlags.Ephemeral });
          return;
        }
        await interaction.reply({ content: `${user} can no longer open new DM tickets.`, flags: MessageFlags.Ephemeral });
        return;
      }

      if (sub === "remove") {
        const user = interaction.options.getUser("user", true);
        const info = statements.removeTicketBlacklist.run(interaction.guildId, user.id);
        if (info.changes === 0) {
          await interaction.reply({ content: `${user} is not on the ticket blacklist.`, flags: MessageFlags.Ephemeral });
          return;
        }
        await interaction.reply({ content: `${user} can open DM tickets again.`, flags: MessageFlags.Ephemeral });
        return;
      }

      if (sub === "list") {
        const rows = statements.listTicketBlacklist.all(interaction.guildId);
        if (!rows.length) {
          await interaction.reply({ content: "No users are blocked from opening tickets.", flags: MessageFlags.Ephemeral });
          return;
        }
        const lines = rows.map((r) => `<@${r.user_id}>`).join("\n");
        await interaction.reply({
          content: `Users blocked from **new** DM tickets (max 50 shown):\n${lines}`,
          flags: MessageFlags.Ephemeral
        });
        return;
      }
    }

    if (interaction.commandName === "claim" || interaction.commandName === "unclaim") {
      const ticket = statements.findTicketByChannel.get(interaction.channelId);
      if (!ticket || ticket.status !== "open") {
        await interaction.reply({ content: "This channel is not an open ticket.", flags: MessageFlags.Ephemeral });
        return;
      }

      const settings = await getGuildSettings(ticket.guild_id);
      if (!settings) {
        await interaction.reply({ content: "Guild is missing setup.", flags: MessageFlags.Ephemeral });
        return;
      }
      if (!interaction.member || !canUseTicketStaffCommands(interaction.member, settings)) {
        await interaction.reply({
          content: "You need the support role (or Manage Channels) to use this command.",
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      const channel = interaction.channel;
      if (!channel || !channel.isTextBased() || channel.isDMBased()) {
        await interaction.reply({ content: "Use this command in a server ticket channel.", flags: MessageFlags.Ephemeral });
        return;
      }

      if (interaction.commandName === "claim") {
        const claimerId = interaction.user.id;
        if (ticket.claimed_by === claimerId) {
          await interaction.reply({ content: "You have already claimed this ticket.", flags: MessageFlags.Ephemeral });
          return;
        }
        if (ticket.claimed_by && ticket.claimed_by !== claimerId && !canForceClaimTakeover(interaction.member)) {
          await interaction.reply({
            content: `This ticket is already claimed by <@${ticket.claimed_by}>. Moderators can reassign with /claim.`,
            flags: MessageFlags.Ephemeral
          });
          return;
        }
        statements.setTicketClaimedBy.run({ id: ticket.id, claimed_by: claimerId });
        const next = statements.findTicketByChannel.get(interaction.channelId);
        await syncTicketChannelTopic(channel, next);
        await storeMessage(ticket.id, interaction.user, "system", `Ticket claimed by ${interaction.user.tag}.`, []);
        await interaction.reply({ content: `You claimed this ticket.`, flags: MessageFlags.Ephemeral });
        return;
      }

      if (!ticket.claimed_by) {
        await interaction.reply({ content: "This ticket is not claimed.", flags: MessageFlags.Ephemeral });
        return;
      }
      if (ticket.claimed_by !== interaction.user.id && !canForceClaimTakeover(interaction.member)) {
        await interaction.reply({
          content: `Only <@${ticket.claimed_by}> (or a moderator) can unclaim this ticket.`,
          flags: MessageFlags.Ephemeral
        });
        return;
      }
      statements.setTicketClaimedBy.run({ id: ticket.id, claimed_by: null });
      const next = statements.findTicketByChannel.get(interaction.channelId);
      await syncTicketChannelTopic(channel, next);
      await storeMessage(ticket.id, interaction.user, "system", `Ticket claim released by ${interaction.user.tag}.`, []);
      await interaction.reply({ content: "Claim released.", flags: MessageFlags.Ephemeral });
      return;
    }

    if (interaction.commandName === "rename") {
      const ticket = statements.findTicketByChannel.get(interaction.channelId);
      if (!ticket || ticket.status !== "open") {
        await interaction.reply({ content: "This channel is not an open ticket.", flags: MessageFlags.Ephemeral });
        return;
      }

      const settings = await getGuildSettings(ticket.guild_id);
      if (!settings) {
        await interaction.reply({ content: "Guild is missing setup.", flags: MessageFlags.Ephemeral });
        return;
      }
      if (!interaction.member || !canUseTicketStaffCommands(interaction.member, settings)) {
        await interaction.reply({
          content: "You need the support role (or Manage Channels) to rename tickets.",
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      const channel = interaction.channel;
      if (!channel || !channel.isTextBased() || channel.isDMBased()) {
        await interaction.reply({ content: "This command can only be used in a server ticket channel.", flags: MessageFlags.Ephemeral });
        return;
      }

      const requested = interaction.options.getString("name", true);
      const name = sanitizeTicketChannelName(requested);
      if (!name) {
        await interaction.reply({
          content: "That name is invalid. Use letters, numbers, and hyphens (for example: billing-refund).",
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      try {
        await channel.setName(name, `Ticket #${ticket.id} renamed by ${interaction.user.tag}`);
      } catch (error) {
        console.error("[ticket] failed to rename channel:", error);
        await interaction.reply({
          content: "Could not rename the channel. Check that the bot has Manage Channels on this channel.",
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      statements.renameTicket.run({ id: ticket.id, channel_name: name });
      await storeMessage(
        ticket.id,
        interaction.user,
        "system",
        `Ticket channel renamed to #${name} by ${interaction.user.tag}.`,
        []
      );

      await interaction.reply({ content: `Ticket renamed to **#${name}**.`, flags: MessageFlags.Ephemeral });
      return;
    }

    if (interaction.commandName === "close") {
      const ticket = statements.findTicketByChannel.get(interaction.channelId);
      if (!ticket || ticket.status !== "open") {
        await interaction.reply({ content: "This channel is not an open ticket.", flags: MessageFlags.Ephemeral });
        return;
      }

      const settings = await getGuildSettings(ticket.guild_id);
      if (!settings) {
        await interaction.reply({ content: "Guild is missing setup.", flags: MessageFlags.Ephemeral });
        return;
      }
      if (!interaction.member || !canUseTicketStaffCommands(interaction.member, settings)) {
        await interaction.reply({
          content: "You need the support role (or Manage Channels) to close tickets.",
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      const reason = interaction.options.getString("reason") || "No reason specified";
      const publicId = nanoid(12);
      const secret = nanoid(24);

      statements.closeTicket.run({
        id: ticket.id,
        close_reason: reason,
        closed_by: interaction.user.id,
        transcript_public_id: publicId,
        transcript_secret: secret
      });

      await storeMessage(
        ticket.id,
        interaction.user,
        "system",
        `Ticket closed by ${interaction.user.tag}. Reason: ${reason}`,
        []
      );

      const transcriptBaseUrl = resolveTranscriptBaseUrl(settings).replace(/\/+$/, "");
      const transcriptUrl = `${transcriptBaseUrl}/transcript/${publicId}/${secret}`;
      // Do not show transcript URL to the user/closer; keep it for the log channel (role-gated).
      await interaction.reply({ content: "Ticket closed.", flags: MessageFlags.Ephemeral });

      // Notify the ticket owner in DMs that their ticket has been closed.
      try {
        const user = await client.users.fetch(ticket.user_id);
        await user.send({
          embeds: [
            new EmbedBuilder()
              .setTitle("Your Ticket Was Closed")
              .setDescription("Your support ticket has been closed by staff.")
              .addFields({ name: "Reason", value: reason })
              .setColor(0xed4245)
              .setTimestamp()
          ]
        });
      } catch (error) {
        console.error(`[ticket] failed to DM user ${ticket.user_id} on close:`, error);
      }

      try {
        const logChannel = await client.channels.fetch(settings.log_channel_id);
        if (logChannel && logChannel.isTextBased()) {
          await logChannel.send({
            content: `<@&${settings.transcript_view_role_id}>`,
            embeds: [
              new EmbedBuilder()
                .setTitle("Ticket Closed")
                .addFields(
                  { name: "Ticket ID", value: String(ticket.id), inline: true },
                  { name: "Opened By", value: `<@${ticket.user_id}>`, inline: true },
                  { name: "Closed By", value: `<@${interaction.user.id}>`, inline: true },
                  { name: "Reason", value: reason },
                  { name: "Transcript", value: transcriptUrl }
                )
                .setColor(0xed4245)
                .setTimestamp()
            ]
          });
        }
      } catch (error) {
        console.error("[ticket] failed to send close log message:", error);
      }

      // Delete ticket channel from the support server after close is complete.
      try {
        if (interaction.channel && interaction.channel.isTextBased()) {
          await interaction.channel.delete(`Ticket #${ticket.id} closed by ${interaction.user.tag}`);
        }
      } catch (error) {
        console.error(`[ticket] failed to delete ticket channel ${ticket.channel_id}:`, error);
      }
      return;
    }
  } catch (error) {
    console.error("[interaction] unhandled error:", error);
    if (interaction.isRepliable()) {
      const payload = { content: "Command failed. Check bot permissions and try again.", flags: MessageFlags.Ephemeral };
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp(payload).catch(() => null);
      } else {
        await interaction.reply(payload).catch(() => null);
      }
    }
  }
});

client.on(Events.TypingStart, async (typing) => {
  try {
    if (!config.typingHintsEnabled) return;
    const user = typing.user;
    if (!user || user.bot) return;

    if (typing.inGuild()) {
      const channel = typing.channel;
      if (!channel?.id || !channel.isTextBased()) return;
      const ticket = statements.findTicketByChannel.get(channel.id);
      if (!ticket || ticket.status !== "open") return;
      if (user.id === ticket.user_id) return;

      const settings = await getGuildSettings(ticket.guild_id);
      if (!settings) return;

      let member = typing.member;
      if (!member && channel.guild) {
        member = await channel.guild.members.fetch(user.id).catch(() => null);
      }
      if (!member) return;
      const isStaff =
        member.roles.cache.has(settings.support_role_id) || member.user.id === config.ownerId;
      if (!isStaff) return;

      const now = Date.now();
      const throttleKey = `${ticket.id}:staff`;
      const last = typingHintLastSent.get(throttleKey) || 0;
      if (now - last < config.typingHintCooldownMs) return;
      typingHintLastSent.set(throttleKey, now);

      const dmUser = await client.users.fetch(ticket.user_id).catch(() => null);
      if (!dmUser) return;
      const dm = await dmUser.createDM();
      const msg = await dm.send({ content: "⌨️ A **staff member** is typing in your ticket…" });
      setTimeout(() => msg.delete().catch(() => {}), 5000);
      return;
    }

    const guild = await client.guilds.fetch(config.guildId).catch(() => null);
    if (!guild) return;
    const ticket = statements.findOpenTicketByUser.get(guild.id, user.id);
    if (!ticket) return;

    const now = Date.now();
    const throttleKey = `${ticket.id}:user`;
    const last = typingHintLastSent.get(throttleKey) || 0;
    if (now - last < config.typingHintCooldownMs) return;
    typingHintLastSent.set(throttleKey, now);

    const tc = await client.channels.fetch(ticket.channel_id).catch(() => null);
    if (!tc || !tc.isTextBased()) return;
    const tag = user.tag || user.username;
    const msg = await tc.send({ content: `⌨️ **${tag}** is typing in DMs…` });
    setTimeout(() => msg.delete().catch(() => {}), 5000);
  } catch (error) {
    console.error("[typing] hint error:", error);
  }
});

client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author.bot) return;

    // DM -> ticket channel relay
    if (!message.guild) {
      const ticket = (await createTicketFromDm(message)) || null;
      if (!ticket) return;

      const attachments = [...message.attachments.values()].map((a) => a.url);
      await storeMessage(ticket.id, message.author, "dm_to_staff", message.content, attachments);

      const channel = await client.channels.fetch(ticket.channel_id);
      if (channel && channel.isTextBased()) {
        await channel.send({
          embeds: [
            new EmbedBuilder()
              .setAuthor({ name: `DM from ${message.author.tag}`, iconURL: message.author.displayAvatarURL() })
              .setDescription(message.content || "*No text content*")
              .setColor(0x5865f2)
              .setFooter({ text: `User ID: ${message.author.id}` })
              .setTimestamp()
          ]
        });
        for (const a of attachments) {
          await channel.send({ content: a });
        }
        await message.react("✅").catch(() => null);
      }
      return;
    }

    // Ticket channel -> user DM relay
    const ticket = statements.findTicketByChannel.get(message.channelId);
    if (!ticket || ticket.status !== "open") return;

    const settings = await getGuildSettings(ticket.guild_id);
    if (!settings) return;
    if (!message.member?.roles?.cache?.has(settings.support_role_id) && message.author.id !== config.ownerId) return;

    const attachments = [...message.attachments.values()].map((a) => a.url);
    const staffOnlyBody = parseStaffOnlyMessage(message.content);
    if (staffOnlyBody !== null) {
      await storeMessage(ticket.id, message.author, "staff_internal", staffOnlyBody, attachments);
      return;
    }

    const user = await client.users.fetch(ticket.user_id);
    await storeMessage(ticket.id, message.author, "staff_to_dm", message.content, attachments);

    const dm = await user.createDM();
    await dm.send({
      embeds: [
        new EmbedBuilder()
          .setAuthor({ name: `Support reply from ${message.author.tag}`, iconURL: message.author.displayAvatarURL() })
          .setDescription(message.content || "*No text content*")
          .setColor(0x57f287)
          .setTimestamp()
      ]
    });
    for (const a of attachments) {
      await dm.send({ content: a });
    }
  } catch (error) {
    console.error("[message] unhandled error:", error);
  }
});

client.login(config.token);

process.on("SIGINT", () => {
  db.close();
  process.exit(0);
});
