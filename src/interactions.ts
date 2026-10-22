import { configureFeature } from './feature-settings.js';
import { configureVerification, handleVerification, verificationModal } from './verification.js';
import { extraModeration, extraModerationPermissions, confirmBulkChannel } from './moderation-extra.js';
import { utility } from './utilities.js';
import { ChatInputCommandInteraction, Client, Events, Interaction, PermissionFlagsBits as P, ChannelType } from 'discord.js';
import mongoose from 'mongoose';
import { getSettings } from './models.js';
import { moderate, moderationPermissions } from './moderation.js';
import { handleTicket, postTicketPanel } from './tickets.js';
import { privatePanel } from './ui.js';
import { invalidateSecurityConfig } from './security.js';
import { reportError, safeAudit } from './audit.js';
import { UserError } from './errors.js';
import { SlidingWindow } from './security-policy.js';

const cooldown = new SlidingWindow();
const inFlight = new Set<string>();
const cleanup = setInterval(() => cooldown.prune(Date.now(), 10_000), 30_000);
cleanup.unref();

async function configure(interaction: ChatInputCommandInteraction) {
  const guild = interaction.guild!;
  const actor = await guild.members.fetch(interaction.user.id);
  if (!actor.permissions.has(P.ManageGuild)) throw new UserError('Manage Server permission is required.');
  if (interaction.commandName === 'ticket-panel') return postTicketPanel(interaction);
  const settings = await getSettings(guild.id);
  if (interaction.commandName === 'setup') {
    const logs = interaction.options.getChannel('logs');
    const category = interaction.options.getChannel('ticket_category');
    const staff = interaction.options.getRole('staff');
    if (!logs && !category && !staff) throw new UserError('Choose at least one setting to update.');
    const me = await guild.members.fetchMe();
    if (logs) {
      const channel = await guild.channels.fetch(logs.id);
      if (!channel || channel.type !== ChannelType.GuildText || !channel.permissionsFor(me)?.has([P.ViewChannel, P.SendMessages])) throw new UserError('Kuroo needs View Channel and Send Messages in the log channel.');
      settings.logChannelId = channel.id;
    }
    if (category) {
      const channel = await guild.channels.fetch(category.id);
      if (!channel || channel.type !== ChannelType.GuildCategory || !channel.permissionsFor(me)?.has([P.ViewChannel, P.SendMessages, P.ManageChannels, P.ManageRoles])) throw new UserError('Kuroo needs View Channel, Send Messages, Manage Channels, and Manage Roles in the category.');
      settings.ticketCategoryId = channel.id;
    }
    if (staff) {
      const role = await guild.roles.fetch(staff.id);
      if (!role || role.id === guild.id || role.managed || me.roles.highest.comparePositionTo(role) <= 0) throw new UserError('Choose a staff role below Kuroo, other than @everyone or an integration role.');
      settings.staffRoleId = role.id;
    }
    await settings.save(); invalidateSecurityConfig(guild.id);
    await interaction.editReply(privatePanel('{emoji:success} Server configured', `Logs: ${settings.logChannelId ? `<#${settings.logChannelId}>` : 'Not configured'}\nTicket category: ${settings.ticketCategoryId ? `<#${settings.ticketCategoryId}>` : 'Not configured'}\nTicket staff: ${settings.staffRoleId ? `<@&${settings.staffRoleId}>` : 'Not configured'}`));
    await safeAudit(guild, 'Configuration updated', `<@${actor.id}> updated server channels or ticket staff.`);
    return;
  }
  if (interaction.options.getSubcommand() === 'configure') {
    const enabled = interaction.options.getBoolean('enabled', true);
    if (enabled) {
      const me = await guild.members.fetchMe();
      if (!settings.logChannelId) throw new UserError('Configure a private log channel with /setup before enabling security.');
      if (!me.permissions.has(P.ModerateMembers)) throw new UserError('Kuroo needs Moderate Members to enable security.');
      const channel = await guild.channels.fetch(settings.logChannelId);
      if (!channel?.isTextBased() || !channel.permissionsFor(me)?.has([P.ViewChannel, P.SendMessages])) throw new UserError('The configured log channel is unavailable or missing permissions.');
    }
    settings.securityEnabled = enabled;
    settings.joinLimit = interaction.options.getInteger('join_limit') ?? settings.joinLimit;
    settings.joinWindowSeconds = interaction.options.getInteger('join_window') ?? settings.joinWindowSeconds;
    settings.minAccountAgeHours = interaction.options.getInteger('account_age') ?? settings.minAccountAgeHours;
    settings.spamLimit = interaction.options.getInteger('spam_limit') ?? settings.spamLimit;
    await settings.save(); invalidateSecurityConfig(guild.id);
    await safeAudit(guild, 'Security configuration updated', `<@${actor.id}> set protection to **${enabled ? 'enabled' : 'disabled'}**.`);
  }
  await interaction.editReply(privatePanel('{emoji:shield} Kuroo Security', `Protection: **${settings.securityEnabled ? 'Enabled' : 'Disabled'}**\nJoin surge: ${settings.joinLimit} joins / ${settings.joinWindowSeconds}s\nMinimum account age during a surge: ${settings.minAccountAgeHours}h\nSpam threshold: ${settings.spamLimit} messages / 5s\nRaid action: ${settings.raid?.action ?? 'timeout'} (10 minutes for timeout). Message floods: 10 minute timeout.\nServer managers and moderators are exempt. Requires Kuroo’s role above the target.`));
}
async function handle(interaction: Interaction) {
  if (!interaction.isChatInputCommand() && !interaction.isButton() && !interaction.isModalSubmit()) return;
  if (!interaction.inGuild() || !interaction.guild) {
    await interaction.reply(privatePanel('{emoji:error} Server only', 'Use Kuroo inside a server.')); return;
  }
  const key = `${interaction.guildId}:${interaction.user.id}`;
  if (cooldown.hit(key, Date.now(), 10_000) > 5 || inFlight.has(key)) {
    await interaction.reply(privatePanel('{emoji:warning} Please wait', 'Finish your current action or wait a few seconds before trying again.')); return;
  }
  inFlight.add(key);
  try {
    if (interaction.isButton() && interaction.customId.startsWith('verify:enter:')) { await verificationModal(interaction); return; }
    await interaction.deferReply({ flags: 64 });
    if (mongoose.connection.readyState !== 1) throw new UserError('The database is unavailable. Please try again later.');
    if (interaction.isModalSubmit()) {
      if (!/^verify:answer:[a-f0-9]{24}$/.test(interaction.customId)) throw new UserError('Unknown form.');
      await handleVerification(interaction); return;
    }
    if (interaction.isButton()) {
      if (interaction.customId === 'verify:start') { await handleVerification(interaction); return; }
      if (interaction.customId.startsWith('channel:confirm:')) { await confirmBulkChannel(interaction); return; }
      if (!/^ticket:(open|close|confirm:\d{17,20})$/.test(interaction.customId)) throw new UserError('Unknown control.');
      await handleTicket(interaction); return;
    }
    const command = interaction.commandName;
    if (extraModerationPermissions[command]) { await extraModeration(interaction); return; }
    if (['antinuke', 'extraowner', 'trust', 'antiraid', 'automod', 'autorole', 'logging'].includes(command)) { await configureFeature(interaction); return; }
    if (command === 'verification') { await configureVerification(interaction); return; }
    if (['stats', 'serverinfo', 'userinfo', 'avatar', 'banner', 'report'].includes(command)) { await utility(interaction); return; }
    if (moderationPermissions[command]) { await moderate(interaction); return; }
    if (['setup', 'security', 'ticket-panel'].includes(command)) { await configure(interaction); return; }
    if (command === 'ping') {
      await interaction.editReply(privatePanel('{emoji:success} Kuroo is online', `Gateway latency: ${Math.max(0, Math.round(interaction.client.ws.ping))}ms\nDatabase: connected`)); return;
    }
    if (command !== 'help') throw new UserError('Unknown command. Update command registration.');
    await interaction.editReply(privatePanel('{emoji:shield} Kuroo', '**Moderation**\n`/ban` · `/unban` · `/kick` · `/timeout` · `/untimeout` · `/warn` · `/purge` · `/purgebots` · `/cases` · `/nickname` · `/role` · `/role-members` · `/channel`\n\n**Security & setup**\n`/setup` · `/security` · `/antinuke` · `/antiraid` · `/trust` · `/extraowner` · `/automod`\n\n**Community**\n`/verification` · `/autorole` · `/report` · `/ticket-panel` — publish a private ticket launcher\n\n**Utilities**\n`/ping` · `/stats` · `/serverinfo` · `/userinfo` · `/avatar` · `/banner` · `/help`\n\nAll actions check your current permissions. Automated security must be enabled by a server manager.'));
  } catch (error) {
    if (!(error instanceof UserError)) reportError('Interaction failed', error);
    const response = privatePanel('{emoji:error} Unable to complete action', error instanceof UserError ? error.message : 'The action could not be confirmed. Check permissions and moderation logs before retrying.');
    try {
      if (interaction.deferred || interaction.replied) await interaction.editReply(response);
      else await interaction.reply(response);
    } catch (replyError) { reportError('Error response failed', replyError); }
  } finally { inFlight.delete(key); }
}
export function installInteractions(client: Client) {
  client.on(Events.InteractionCreate, interaction => { void handle(interaction).catch(error => reportError('Interaction dispatch failed', error)); });
}
