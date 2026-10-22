import {
  ButtonBuilder, ButtonInteraction, ButtonStyle, ChannelType, ChatInputCommandInteraction, Guild,
  GuildMember, PermissionFlagsBits as P, Role,
} from 'discord.js';
import { UserError } from './errors.js';
import { canModerate } from './security-policy.js';
import { recordedAction } from './actions.js';
import { ChannelState } from './models.js';
import { privatePanel } from './ui.js';
export const extraModerationPermissions: Record<string, bigint> = {
  unban: P.BanMembers, untimeout: P.ModerateMembers, nickname: P.ManageNicknames, role: P.ManageRoles,
  channel: P.ManageChannels, purgebots: P.ManageMessages, 'role-members': P.ManageRoles,
};
async function manageableMember(guild: Guild, actor: GuildMember, targetId: string) {
  const [target, me] = await Promise.all([guild.members.fetch({ user: targetId, force: true }), guild.members.fetchMe()]);
  if (!canModerate({ id: actor.id, position: actor.roles.highest.position }, { id: target.id, position: target.roles.highest.position }, guild.ownerId, me.id) || me.roles.highest.comparePositionTo(target.roles.highest) <= 0) throw new UserError('Member ownership or role hierarchy prevents this action.');
  return target;
}
function checkRole(actor: GuildMember, me: GuildMember, role: Role, grant: boolean) {
  if (role.managed || role.id === role.guild.id || me.roles.highest.comparePositionTo(role) <= 0 || actor.id !== role.guild.ownerId && actor.roles.highest.comparePositionTo(role) <= 0) throw new UserError('Choose an unmanaged role below both you and Kuroo.');
  if (grant && !actor.permissions.has(role.permissions)) throw new UserError('You cannot grant permissions you do not have.');
}
async function channelMutation(interaction: ChatInputCommandInteraction | ButtonInteraction, operation: string, channelId: string, reason: string) {
  const guild = interaction.guild!;
  const [actor, me, channel] = await Promise.all([guild.members.fetch(interaction.user.id), guild.members.fetchMe(), guild.channels.fetch(channelId)]);
  if (!actor.permissions.has(P.ManageChannels) || !channel || channel.isThread() || !('permissionOverwrites' in channel) || !channel.permissionsFor(actor)?.has([P.ManageChannels, P.ManageRoles]) || !channel.permissionsFor(me)?.has([P.ViewChannel, P.ManageChannels, P.ManageRoles])) throw new UserError('Both you and Kuroo need Manage Channels and Manage Roles in the target channel.');
  const permission = operation === 'lock' || operation === 'unlock' ? 'SendMessages' : 'ViewChannel';
  const flag = P[permission];
  const overwrite = channel.permissionOverwrites.cache.get(guild.id);
  const previous = overwrite?.allow.has(flag) ? true : overwrite?.deny.has(flag) ? false : null;
  const restoring = operation === 'unlock' || operation === 'unhide';
  if (restoring) {
    const saved = await ChannelState.findOne({ guildId: guild.id, channelId, permission });
    if (!saved) throw new UserError('Kuroo has no saved state for this channel. Change its permissions manually if needed.');
    if (previous !== false) throw new UserError('Another permission change replaced Kuroo’s setting. Review it manually.');
    await recordedAction(guild, actor.id, channelId, operation, reason, () => channel.permissionOverwrites.edit(guild.id, { [permission]: saved.previous }, { reason }));
    if (permission === 'ViewChannel') {
      const botOverwrite = channel.permissionOverwrites.cache.get(me.id);
      if (botOverwrite?.allow.has(P.ViewChannel)) await channel.permissionOverwrites.edit(me.id, { ViewChannel: saved.botPrevious }, { reason });
    }
    await saved.deleteOne();
  } else {
    if (previous === false) throw new UserError('That permission is already denied.');
    await ChannelState.updateOne({ guildId: guild.id, channelId, permission }, { $setOnInsert: { previous, botPrevious: channel.permissionOverwrites.cache.get(me.id)?.allow.has(P.ViewChannel) ? true : channel.permissionOverwrites.cache.get(me.id)?.deny.has(P.ViewChannel) ? false : null } }, { upsert: true });
    await recordedAction(guild, actor.id, channelId, operation, reason, async () => {
      if (permission === 'ViewChannel') await channel.permissionOverwrites.edit(me.id, { ViewChannel: true }, { reason });
      await channel.permissionOverwrites.edit(guild.id, { [permission]: false }, { reason });
    });
  }
}
export async function confirmBulkChannel(interaction: ButtonInteraction) {
  const [, , actorId, operation, at] = interaction.customId.split(':');
  if (actorId !== interaction.user.id || !['lock', 'unlock', 'hide', 'unhide'].includes(operation!) || !at || !/^\d{13}$/.test(at) || Date.now() - Number(at) > 60_000 || Number(at) > Date.now()) throw new UserError('This confirmation is invalid or expired.');
  const guild = interaction.guild!;
  const actor = await guild.members.fetch(actorId);
  if (!actor.permissions.has([P.ManageChannels, P.ManageRoles])) throw new UserError('Manage Channels and Manage Roles are required.');
  const channels = await guild.channels.fetch();
  let completed = 0, skipped = 0;
  for (const channel of channels.values()) {
    if (!channel || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type as number)) continue;
    try { await channelMutation(interaction, operation!, channel.id, `Kuroo bulk ${operation} by ${actor.id}`); completed++; }
    catch (error) { if (error instanceof UserError) skipped++; else throw error; }
  }
  await interaction.editReply(privatePanel('Channel operation complete', `Updated ${completed} text channels. Skipped ${skipped} channels already in that state or without permission/saved state. Review explicit role and member overrides in Discord.`));
}
export async function extraModeration(interaction: ChatInputCommandInteraction) {
  const guild = interaction.guild!;
  const name = interaction.commandName;
  const [actor, me] = await Promise.all([guild.members.fetch(interaction.user.id), guild.members.fetchMe()]);
  const permission = extraModerationPermissions[name];
  if (!permission || !actor.permissions.has(permission) || !me.permissions.has(permission)) throw new UserError('You or Kuroo lack the required permission.');
  if (name === 'channel') {
    const operation = interaction.options.getString('operation', true);
    if (interaction.options.getBoolean('all')) {
      await interaction.editReply(privatePanel('{emoji:warning} Apply to all text channels?', `Operation: **${operation}**. Explicit role/member overrides can still grant access. Only settings previously changed by Kuroo can be restored.`, [new ButtonBuilder().setCustomId(`channel:confirm:${actor.id}:${operation}:${Date.now()}`).setLabel('Confirm server-wide change').setStyle(ButtonStyle.Danger)]));
      return;
    }
    await channelMutation(interaction, operation, interaction.options.getChannel('channel')?.id ?? interaction.channelId, `Kuroo ${operation} by ${actor.id}`);
    await interaction.editReply(privatePanel('{emoji:success} Channel updated', 'The @everyone permission was updated. Review explicit role/member overrides in Discord.'));
    return;
  }
  const reason = interaction.options.getString('reason') ?? `Kuroo ${name} by ${actor.id}`;
  if (name === 'unban') {
    const id = interaction.options.getString('id', true);
    if (!/^\d{17,20}$/.test(id)) throw new UserError('Provide a valid user ID.');
    await recordedAction(guild, actor.id, id, name, reason, () => guild.members.unban(id, reason));
  } else if (name === 'role-members') {
    const role = await guild.roles.fetch(interaction.options.getRole('role', true).id);
    if (!role) throw new UserError('Role not found.');
    await guild.members.fetch();
    const ids = role.members.map(member => `<@${member.id}>`);
    await interaction.editReply(privatePanel('Role members', `${ids.slice(0, 80).join('\n') || 'No members.'}\nTotal: ${ids.length}${ids.length > 80 ? ' (first 80 shown)' : ''}`));
    return;
  } else if (name === 'purgebots') {
    const channel = interaction.channel;
    if (!channel || !('bulkDelete' in channel) || !channel.permissionsFor(actor)?.has(P.ManageMessages) || !channel.permissionsFor(me)?.has([P.ManageMessages, P.ReadMessageHistory])) throw new UserError('Missing message management permissions.');
    const messages = await channel.messages.fetch({ limit: interaction.options.getInteger('count', true) });
    const bots = messages.filter(message => message.author.bot);
    let deleted = 0;
    await recordedAction(guild, actor.id, channel.id, name, reason, async () => { deleted = (await channel.bulkDelete(bots, true)).size; });
    await interaction.editReply(privatePanel('Bot messages removed', `Deleted ${deleted} bot messages younger than 14 days.`));
    return;
  } else {
    const user = interaction.options.getUser('user', true);
    const target = await manageableMember(guild, actor, user.id);
    if (name === 'untimeout') {
      if (!target.moderatable) throw new UserError('This member cannot be moderated.');
      await recordedAction(guild, actor.id, target.id, name, reason, () => target.timeout(null, reason));
    } else if (name === 'nickname') {
      if (!target.manageable) throw new UserError('This member cannot be managed.');
      await recordedAction(guild, actor.id, target.id, name, reason, () => target.setNickname(interaction.options.getString('name'), reason));
    } else if (name === 'role') {
      const role = await guild.roles.fetch(interaction.options.getRole('role', true).id);
      if (!role) throw new UserError('Role not found.');
      const grant = interaction.options.getString('operation', true) === 'add';
      checkRole(actor, me, role, grant);
      await recordedAction(guild, actor.id, target.id, grant ? 'role-add' : 'role-remove', `${reason}; role ${role.id}`, () => grant ? target.roles.add(role, reason) : target.roles.remove(role, reason));
    }
  }
  await interaction.editReply(privatePanel('{emoji:success} Moderation complete', `Action: **${name}**. A moderation case was recorded.`));
}
