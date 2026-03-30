import { REST, Routes, SlashCommandBuilder, PermissionFlagsBits } from "discord.js";
import { config } from "./config.js";

export const setupCommand = new SlashCommandBuilder()
  .setName("setup")
  .setDescription("Owner-only bot setup for ticket channels and logs.")
  .addChannelOption((o) => o.setName("category").setDescription("Ticket category channel").setRequired(true))
  .addChannelOption((o) => o.setName("log_channel").setDescription("Channel where closure logs are posted").setRequired(true))
  .addRoleOption((o) => o.setName("support_role").setDescription("Support role pinged for new tickets").setRequired(true))
  .addRoleOption((o) =>
    o.setName("transcript_view_role").setDescription("Role allowed to see transcript links in log channel").setRequired(true)
  )
  .addStringOption((o) =>
    o.setName("transcript_base_url").setDescription("Public URL used in transcript links").setRequired(false)
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

export const closeCommand = new SlashCommandBuilder()
  .setName("close")
  .setDescription("Close this ticket.")
  .addStringOption((o) => o.setName("reason").setDescription("Reason for closing").setRequired(false))
  .setDefaultMemberPermissions(null);

export const renameCommand = new SlashCommandBuilder()
  .setName("rename")
  .setDescription("Rename this ticket channel.")
  .addStringOption((o) =>
    o.setName("name").setDescription("New channel name (letters, numbers, hyphens)").setRequired(true).setMaxLength(100)
  )
  .setDefaultMemberPermissions(null);

export const claimCommand = new SlashCommandBuilder()
  .setName("claim")
  .setDescription("Claim this ticket (shows who is handling it).")
  .setDefaultMemberPermissions(null);

export const unclaimCommand = new SlashCommandBuilder()
  .setName("unclaim")
  .setDescription("Release your claim on this ticket.")
  .setDefaultMemberPermissions(null);

export const blacklistCommand = new SlashCommandBuilder()
  .setName("blacklist")
  .setDescription("Block or unblock users from opening new tickets via DM.")
  .setDefaultMemberPermissions(null)
  .addSubcommand((sc) =>
    sc
      .setName("add")
      .setDescription("Prevent a user from creating new DM tickets.")
      .addUserOption((o) => o.setName("user").setDescription("User to block").setRequired(true))
  )
  .addSubcommand((sc) =>
    sc
      .setName("remove")
      .setDescription("Allow a user to create DM tickets again.")
      .addUserOption((o) => o.setName("user").setDescription("User to unblock").setRequired(true))
  )
  .addSubcommand((sc) => sc.setName("list").setDescription("List users blocked from opening tickets."));

export async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(config.token);
  const body = [
    setupCommand.toJSON(),
    blacklistCommand.toJSON(),
    claimCommand.toJSON(),
    unclaimCommand.toJSON(),
    renameCommand.toJSON(),
    closeCommand.toJSON()
  ];
  await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), { body });
  console.log("[bot] commands registered.");
}
