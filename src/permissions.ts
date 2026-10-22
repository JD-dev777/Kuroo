import { Guild, GuildMember, PermissionFlagsBits as P, Role } from 'discord.js';
import { VerificationGate } from './models.js';
import { UserError } from './errors.js';
export const dangerousPermissions = P.Administrator | P.ManageGuild | P.ManageRoles | P.ManageChannels | P.ManageWebhooks | P.BanMembers | P.KickMembers | P.ModerateMembers | P.MentionEveryone | P.ManageMessages | P.ManageNicknames | P.ManageGuildExpressions | P.ManageEvents | P.ManageThreads | P.MuteMembers | P.DeafenMembers | P.MoveMembers | P.ViewAuditLog;
export function isSafeRole(role: Role) {
  return role.id !== role.guild.id && !role.managed && (role.permissions.bitfield & dangerousPermissions) === 0n;
}
export async function safeAssignableRole(guild: Guild, roleId: string) {
  const [role, me] = await Promise.all([guild.roles.fetch(roleId), guild.members.fetchMe()]);
  if (!role || !isSafeRole(role) || !me.permissions.has(P.ManageRoles) || me.roles.highest.comparePositionTo(role) <= 0) throw new UserError('Choose a role below Kuroo with no management, moderation, or everyone-mention permissions.');
  // A harmless global permission set can still have private-channel access through overwrites.
  const managedGates = new Set((await VerificationGate.find({ guildId: guild.id, roleId }).select('channelId').lean()).map(gate => gate.channelId));
  for (const channel of guild.channels.cache.values()) {
    if (channel.isThread() || managedGates.has(channel.id)) continue;
    if (!channel.permissionsFor(guild.roles.everyone)?.has(P.ViewChannel) && channel.permissionsFor(role)?.has(P.ViewChannel)) throw new UserError('This role grants private-channel access. Choose a dedicated public member role.');
  }
  return role;
}
export function protectedMember(member: GuildMember) {
  return member.id === member.guild.ownerId || member.permissions.has(P.ManageGuild) || member.permissions.has(P.ModerateMembers);
}
