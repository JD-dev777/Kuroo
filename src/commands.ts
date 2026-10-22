import { extraModerationCommands } from './moderation-commands.js';
import { featureCommands } from './feature-commands.js';
import { ChannelType, PermissionFlagsBits as P, SlashCommandBuilder } from 'discord.js';
const moderation = (name: string, description: string, permission: bigint) => new SlashCommandBuilder().setName(name).setDescription(description)
  .setDefaultMemberPermissions(permission).setContexts(0)
  .addUserOption(o => o.setName('user').setDescription('Member to moderate').setRequired(true))
  .addStringOption(o => o.setName('reason').setDescription('Audit reason').setMaxLength(400).setRequired(true));
export const commands = [
  ...featureCommands,
  ...extraModerationCommands,
  new SlashCommandBuilder().setName('help').setDescription('Kuroo commands and security information').setContexts(0),
  new SlashCommandBuilder().setName('ping').setDescription('Check Kuroo latency').setContexts(0),
  moderation('ban', 'Ban a member', P.BanMembers),
  moderation('kick', 'Kick a member', P.KickMembers),
  moderation('warn', 'Record a warning', P.ModerateMembers),
  moderation('timeout', 'Temporarily prevent a member from interacting', P.ModerateMembers)
    .addIntegerOption(o => o.setName('minutes').setDescription('Duration (1–40320 minutes)').setMinValue(1).setMaxValue(40320).setRequired(true)),
  new SlashCommandBuilder().setName('purge').setDescription('Delete recent messages younger than 14 days').setContexts(0).setDefaultMemberPermissions(P.ManageMessages)
    .addIntegerOption(o => o.setName('count').setDescription('Number of messages (1–100)').setMinValue(1).setMaxValue(100).setRequired(true)),
  new SlashCommandBuilder().setName('cases').setDescription('View the last ten moderation records for a user').setContexts(0).setDefaultMemberPermissions(P.ModerateMembers)
    .addUserOption(o => o.setName('user').setDescription('User to look up').setRequired(true)),
  new SlashCommandBuilder().setName('security').setDescription('Configure and inspect security').setContexts(0).setDefaultMemberPermissions(P.ManageGuild)
    .addSubcommand(s => s.setName('status').setDescription('Show current protection settings'))
    .addSubcommand(s => s.setName('configure').setDescription('Update protection settings')
      .addBooleanOption(o => o.setName('enabled').setDescription('Enable automated security').setRequired(true))
      .addIntegerOption(o => o.setName('join_limit').setDescription('Joins before raid protection (3–50)').setMinValue(3).setMaxValue(50))
      .addIntegerOption(o => o.setName('join_window').setDescription('Join window in seconds (5–120)').setMinValue(5).setMaxValue(120))
      .addIntegerOption(o => o.setName('account_age').setDescription('Minimum account age in hours during raids (0–720)').setMinValue(0).setMaxValue(720))
      .addIntegerOption(o => o.setName('spam_limit').setDescription('Messages per 5 seconds before timeout (3–30)').setMinValue(3).setMaxValue(30))),
  new SlashCommandBuilder().setName('setup').setDescription('Set server channels and ticket staff').setContexts(0).setDefaultMemberPermissions(P.ManageGuild)
    .addChannelOption(o => o.setName('logs').setDescription('Private moderation log channel').addChannelTypes(ChannelType.GuildText))
    .addChannelOption(o => o.setName('ticket_category').setDescription('Category for private tickets').addChannelTypes(ChannelType.GuildCategory))
    .addRoleOption(o => o.setName('staff').setDescription('Role allowed to access tickets')),
  new SlashCommandBuilder().setName('ticket-panel').setDescription('Post the ticket opening panel in this channel').setContexts(0).setDefaultMemberPermissions(P.ManageGuild),
];
