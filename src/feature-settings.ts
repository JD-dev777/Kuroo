import type { CommandContext } from './command-context.js';
import { escapeMarkdown, PermissionFlagsBits as P } from 'discord.js';
import { getSettings, ModCase, Settings } from './models.js';
import { UserError } from './errors.js';
import { privatePanel } from './ui.js';
import { safeAudit } from './audit.js';
import { invalidateSecurityConfig } from './security.js';
import { safeAssignableRole } from './permissions.js';
import { saveSnapshot } from './antinuke.js';

const fields = { words: 'words', abuse: 'abuseWords', 'explicit-words': 'explicitWords' } as const;
export async function configureFeature(interaction: CommandContext) {
  const guild = interaction.guild!;
  const actor = await guild.members.fetch(interaction.user.id);
  if (!actor.permissions.has(P.ManageGuild)) throw new UserError('Manage Server permission is required.');
  const settings = await getSettings(guild.id);
  const name = interaction.commandName;
  const owner = actor.id === guild.ownerId;
  const securityOwner = owner || settings.extraOwners.includes(actor.id);
  if (name === 'extraowner' || name === 'antinuke' || name === 'trust' && interaction.options.getString('feature') === 'antinuke') {
    if (!securityOwner || name === 'extraowner' && !owner) throw new UserError('Only the server owner can appoint delegates. Audit protection and its trust list require the owner or a delegated owner.');
  }
  if (name === 'extraowner') {
    const op = interaction.options.getString('operation', true);
    const user = interaction.options.getUser('user');
    if (op !== 'list') {
      if (!user || user.bot || user.id === guild.ownerId) throw new UserError('Choose a human server member other than the owner.');
      await guild.members.fetch(user.id);
      if (op === 'add' && settings.extraOwners.length >= 10) throw new UserError('At most ten security owners may be delegated.');
      await Settings.updateOne({ guildId: guild.id }, op === 'add' ? { $addToSet: { extraOwners: user.id } } : { $pull: { extraOwners: user.id } });
    }
    const current = await getSettings(guild.id);
    await interaction.editReply(privatePanel('{emoji:owner} Delegated security owners', current.extraOwners.map(id => `<@${id}>`).join('\n') || 'None.'));
  } else if (name === 'trust') {
    const feature = interaction.options.getString('feature', true);
    const op = interaction.options.getString('operation', true);
    const kind = interaction.options.getString('kind') ?? 'user';
    if (feature !== 'automod' && kind !== 'user') throw new UserError('Audit protection and raid exceptions accept user IDs only.');
    const field = feature === 'antinuke' ? 'trustedUsers' : feature === 'raid' ? 'raidTrustedUsers' : `automod.${kind === 'role' ? 'roles' : kind === 'channel' ? 'channels' : 'users'}`;
    if (op !== 'list') {
      const id = interaction.options.getString('id');
      if (!id || !/^\d{17,20}$/.test(id) || id === guild.id) throw new UserError('Provide a valid Discord ID other than @everyone.');
      if (op === 'add') {
        if (kind === 'user') await guild.members.fetch(id);
        if (kind === 'role' && !(await guild.roles.fetch(id))) throw new UserError('Role not found.');
        if (kind === 'channel' && !(await guild.channels.fetch(id))) throw new UserError('Channel not found.');
        const existing = settings.get(field) as string[];
        if (existing.length >= 100) throw new UserError('At most 100 exceptions are allowed per list.');
      }
      await Settings.updateOne({ guildId: guild.id }, op === 'add' ? { $addToSet: { [field]: id } } : { $pull: { [field]: id } });
    }
    const current = await getSettings(guild.id);
    const ids = current.get(field) as string[];
    await interaction.editReply(privatePanel('{emoji:trust} Security exceptions', `Feature: **${feature}** · Type: **${kind}**\n${ids.map(id => `\`${id}\``).join('\n') || 'None.'}`));
  } else if (name === 'antinuke') {
    if (interaction.options.getSubcommand() === 'configure') {
      const enabled = interaction.options.getBoolean('enabled', true);
      const mode = interaction.options.getString('mode') ?? settings.antinuke!.mode;
      const recovery = interaction.options.getBoolean('recovery') ?? settings.antinuke!.recovery;
      if (enabled) {
        const me = await guild.members.fetchMe();
        const required = mode === 'ban' ? [P.ViewAuditLog, P.BanMembers] : [P.ViewAuditLog];
        if (!settings.logChannelId || !me.permissions.has(required)) throw new UserError('Set up a log channel and grant View Audit Log. Ban mode also requires Ban Members.');
        const log = await guild.channels.fetch(settings.logChannelId);
        if (!log?.isSendable() || !log.permissionsFor(me)?.has([P.ViewChannel, P.SendMessages])) throw new UserError('The log channel is unavailable or Kuroo cannot write to it.');
        if (recovery) {
          if (!me.permissions.has([P.ManageChannels, P.ManageRoles, P.ManageWebhooks, P.KickMembers])) throw new UserError('Recovery requires Manage Channels, Manage Roles, Manage Webhooks, and Kick Members.');
          await guild.channels.fetch(); await guild.roles.fetch();
          for (const channel of guild.channels.cache.values()) await saveSnapshot(channel);
          for (const role of guild.roles.cache.values()) await saveSnapshot(role);
        }
      }
      await Settings.updateOne({ guildId: guild.id }, { $set: { antinuke: { enabled, mode, recovery } } });
    }
    const current = await getSettings(guild.id);
    await interaction.editReply(privatePanel('{emoji:shield} Audit protection', `Enabled: **${current.antinuke!.enabled}**\nMode: **${current.antinuke!.mode}**\nRecovery: **${current.antinuke!.recovery}**\nOnly the owner, delegated security owners, Kuroo, and trusted users are exempt. Administrator alone does not grant an exemption. Changes made through Kuroo are attributed to Kuroo in the audit log.\nRecovery is partial and cannot restore deleted messages, original IDs, or role memberships.`));
  } else if (name === 'antiraid') {
    if (interaction.options.getSubcommand() === 'configure') {
      settings.raid!.botFilter = interaction.options.getBoolean('bot_filter') ?? settings.raid!.botFilter;
      settings.raid!.accountAgeFilter = interaction.options.getBoolean('account_age_filter') ?? settings.raid!.accountAgeFilter;
      const action = interaction.options.getString('action');
      if (action) {
        const me = await guild.members.fetchMe();
        if (!me.permissions.has(action === 'ban' ? P.BanMembers : action === 'kick' ? P.KickMembers : P.ModerateMembers)) throw new UserError('Kuroo lacks permission for that raid response.');
        settings.raid!.action = action as 'ban' | 'kick' | 'timeout';
      }
      await settings.save();
    }
    await interaction.editReply(privatePanel('{emoji:shield} Raid protection', `Enabled: **${settings.securityEnabled}** (use /security configure)\nBot filter: **${settings.raid!.botFilter}**\nAccount age filter on every join: **${settings.raid!.accountAgeFilter}**\nAction: **${settings.raid!.action}**\nBot accounts are kicked when timeout is selected. Use /trust feature:raid to allow approved bots.`));
  } else if (name === 'logging') {
    const enabled = interaction.options.getBoolean('enabled', true);
    if (enabled) {
      const channelId = interaction.options.getChannel('channel')?.id ?? settings.logChannelId;
      if (!channelId) throw new UserError('Choose a log channel.');
      const channel = await guild.channels.fetch(channelId);
      const me = await guild.members.fetchMe();
      if (!channel?.isSendable() || !channel.permissionsFor(me)?.has([P.ViewChannel, P.SendMessages])) throw new UserError('Choose a text channel where Kuroo can view and send messages.');
      settings.logChannelId = channel.id;
    } else {
      if (settings.securityEnabled || settings.antinuke?.enabled || settings.automod?.enabled) throw new UserError('Disable automated protection before turning off moderation logs.');
      settings.logChannelId = undefined;
    }
    await settings.save();
    await interaction.editReply(privatePanel('{emoji:logging} Moderation logging', enabled ? `Logs will be delivered to <#${settings.logChannelId}>.` : 'Moderation logging disabled.'));
  } else if (name === 'autorole') {
    const enabled = interaction.options.getBoolean('enabled', true);
    const role = interaction.options.getRole('role');
    if (enabled) {
      if (!role || role.id === settings.verification?.roleId) throw new UserError('Choose a role different from the verified role.');
      await safeAssignableRole(guild, role.id);
      settings.autoroleId = role.id;
    } else settings.autoroleId = undefined;
    await settings.save();
    await interaction.editReply(privatePanel('{emoji:role} Automatic role', enabled ? `New members receive <@&${role!.id}> after joining, or after verification when enabled.` : 'Automatic role assignment disabled.'));
  } else {
    const am = settings.automod!;
    const sub = interaction.options.getSubcommand();
    if (sub === 'configure') {
      const enabled = interaction.options.getBoolean('enabled', true);
      if (enabled) {
        const me = await guild.members.fetchMe();
        if (!settings.logChannelId || !me.permissions.has(P.ManageMessages)) throw new UserError('Set up moderation logs and grant Manage Messages before enabling automod.');
        const log = await guild.channels.fetch(settings.logChannelId);
        if (!log?.isSendable() || !log.permissionsFor(me)?.has([P.ViewChannel, P.SendMessages])) throw new UserError('The log channel is unavailable or Kuroo cannot write to it.');
        if (!interaction.client.options.intents.has('MessageContent')) throw new UserError('Enable MESSAGE_CONTENT_ENABLED in the environment and Message Content Intent in Discord, then restart Kuroo.');
      }
      am.enabled = enabled;
      am.action = interaction.options.getString('action') as typeof am.action | null ?? am.action;
      am.strikes = interaction.options.getBoolean('strikes') ?? am.strikes;
      am.strikeThreshold = interaction.options.getInteger('threshold') ?? am.strikeThreshold;
    } else if (sub === 'rule') {
      const rule = interaction.options.getString('name', true);
      if (interaction.options.getBoolean('enabled', true)) { if (!am.rules.includes(rule)) am.rules.push(rule); }
      else am.rules = am.rules.filter(item => item !== rule);
    } else if (sub === 'limits') {
      am.mentionLimit = interaction.options.getInteger('mentions') ?? am.mentionLimit;
      am.attachmentLimit = interaction.options.getInteger('attachments') ?? am.attachmentLimit;
      am.capsPercent = interaction.options.getInteger('caps_percent') ?? am.capsPercent;
      am.emojiLimit = interaction.options.getInteger('emojis') ?? am.emojiLimit;
    } else if (sub === 'filter') {
      const category = interaction.options.getString('category', true) as keyof typeof fields;
      const field = fields[category];
      const op = interaction.options.getString('operation', true);
      const word = interaction.options.getString('word')?.trim().normalize('NFKC').toLowerCase();
      if (op !== 'list') {
        if (!word || word.length < 2 || /[\r\n]/.test(word)) throw new UserError('Provide a word or phrase with at least two characters.');
        if (op === 'add') { if (am[field].length >= 100) throw new UserError('Each word list is limited to 100 entries.'); if (!am[field].includes(word)) am[field].push(word); }
        else am[field] = am[field].filter(value => value !== word);
        await settings.save();
      }
      await interaction.editReply(privatePanel('{emoji:filter} Word filter', am[field].map(value => escapeMarkdown(value)).join(', ').slice(0, 3000) || 'Empty. Add your server’s own terms, then enable the matching rule.'));
      return;
    } else if (sub === 'history') {
      const user = interaction.options.getUser('user', true);
      const cases = await ModCase.find({ guildId: guild.id, targetId: user.id, action: /^automod-/ }).sort({ createdAt: -1 }).limit(10);
      await interaction.editReply(privatePanel('{emoji:history} Automod history', cases.map(item => `**${item.action}** · ${item.outcome}\n${escapeMarkdown(item.reason).slice(0, 160)}`).join('\n\n') || 'No recorded violations.'));
      return;
    }
    if (sub !== 'status') await settings.save();
    await interaction.editReply(privatePanel('{emoji:shield} Automod', `Enabled: **${am.enabled}**\nBase action: **${am.action}**\nStrike escalation: **${am.strikes}**, step every ${am.strikeThreshold} violations\nRules: ${am.rules.join(', ') || 'None'}\nLimits: ${am.mentionLimit} mentions/10s · ${am.attachmentLimit} attachments · ${am.capsPercent}% caps · ${am.emojiLimit} emojis\nWord lists start empty. Add server-specific terms with /automod filter. Flood protection is configured separately with /security.`));
  }
  invalidateSecurityConfig(guild.id);
  await safeAudit(guild, 'Feature configuration accessed', `<@${actor.id}> used **${name}**.`);
}
