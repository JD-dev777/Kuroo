import type { CommandContext } from './command-context.js';
import { UserError } from './errors.js';
import { escapeMarkdown, PermissionFlagsBits as P } from 'discord.js';
import { ModCase } from './models.js';
import { canModerate } from './security-policy.js';
import { privatePanel } from './ui.js';
import { safeAudit } from './audit.js';
export const moderationPermissions: Record<string, bigint> = { ban: P.BanMembers, kick: P.KickMembers, timeout: P.ModerateMembers, warn: P.ModerateMembers, purge: P.ManageMessages, cases: P.ModerateMembers };
export async function moderate(interaction: CommandContext) {
  const guild = interaction.guild!;
  const command = interaction.commandName;
  const actor = await guild.members.fetch(interaction.user.id);
  const permission = moderationPermissions[command];
  if (!permission || !actor.permissions.has(permission)) throw new UserError('You do not have permission to use this command.');
  if (command === 'cases') {
    const user = interaction.options.getUser('user', true);
    const records = await ModCase.find({ guildId: guild.id, targetId: user.id }).sort({ createdAt: -1 }).limit(10).lean();
    await interaction.editReply(privatePanel('{emoji:history} Moderation history', records.length ? records.map(record => `**${record.action}** · ${record.outcome} · <@${record.actorId}>\n${escapeMarkdown(record.reason).slice(0, 160)}${record.reason.length > 80 ? '…' : ''}`).join('\n\n') : 'No records for this user.'));
    return;
  }
  const me = await guild.members.fetchMe();
  if (!me.permissions.has(permission)) throw new UserError('Kuroo is missing the required moderation permission.');
  if (command === 'purge') {
    const channel = interaction.channel;
    if (!channel || !('bulkDelete' in channel) || !channel.permissionsFor(actor)?.has(P.ManageMessages) || !channel.permissionsFor(me)?.has([P.ViewChannel, P.ReadMessageHistory, P.ManageMessages])) throw new UserError('Missing channel permissions to delete messages.');
    const count = interaction.options.getInteger('count', true);
    const record = await ModCase.create({ guildId: guild.id, actorId: actor.id, targetId: channel.id, action: 'purge', reason: `Requested ${count} recent messages` });
    try {
      const deleted = await channel.bulkDelete(count, true);
      record.outcome = 'succeeded'; await record.save();
      await interaction.editReply(privatePanel('{emoji:success} Messages removed', `Deleted ${deleted.size} messages. Messages older than 14 days are skipped.`));
      await safeAudit(guild, 'Messages purged', `<@${actor.id}> deleted ${deleted.size} messages in <#${channel.id}>. Case: ${record.id}`);
    } catch (error) {
      // A failed final persistence or reply must not relabel a completed Discord action.
      if (record.outcome === 'pending') { record.outcome = 'failed'; await record.save(); }
      throw error;
    }
    return;
  }
  const user = interaction.options.getUser('user', true);
  const target = await guild.members.fetch(user.id).catch(() => null);
  if (!target) throw new UserError('The target must be a current server member.');
  if (!canModerate({ id: actor.id, position: actor.roles.highest.position }, { id: target.id, position: target.roles.highest.position }, guild.ownerId, me.id)) throw new UserError('You cannot moderate this member due to role hierarchy or ownership.');
  if (me.roles.highest.comparePositionTo(target.roles.highest) <= 0) throw new UserError('Move Kuroo’s role above the target member’s highest role.');
  if (command === 'timeout' && !target.moderatable) throw new UserError('This member cannot be timed out.');
  if (command === 'kick' && !target.kickable) throw new UserError('This member cannot be kicked.');
  if (command === 'ban' && !target.bannable) throw new UserError('This member cannot be banned.');
  const reason = interaction.options.getString('reason', true);
  const minutes = command === 'timeout' ? interaction.options.getInteger('minutes', true) : undefined;
  const record = await ModCase.create({ guildId: guild.id, targetId: target.id, actorId: actor.id, action: command, reason: minutes ? `${reason} (${minutes} minutes)` : reason });
  const auditReason = `${actor.id}: ${reason}`;
  try {
    if (command === 'ban') await target.ban({ reason: auditReason });
    if (command === 'kick') await target.kick(auditReason);
    if (command === 'timeout') await target.timeout(minutes! * 60_000, auditReason);
  } catch (error) { record.outcome = 'failed'; await record.save(); throw error; }
  record.outcome = 'succeeded'; await record.save();
  await interaction.editReply(privatePanel('{emoji:success} Moderation complete', `Action: **${command}**\nMember: <@${target.id}>\nReason: ${escapeMarkdown(record.reason)}\nCase: \`${record.id}\``));
  await safeAudit(guild, 'Moderation action', `**${command}** · <@${target.id}> · Moderator: <@${actor.id}>\n${escapeMarkdown(record.reason)}\nCase: \`${record.id}\``);
}
