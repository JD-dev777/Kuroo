import { AuditLogEvent, Client, Events } from 'discord.js';
import { safeAudit } from './audit.js';
export function installLogging(client: Client) {
  // Keep logs metadata-only: member message contents are not copied to logs.
  client.on(Events.GuildAuditLogEntryCreate, (entry, guild) => {
    if (entry.executorId === client.user?.id) return;
    void safeAudit(guild, 'Server audit event', `Action: **${AuditLogEvent[entry.action] ?? entry.action}**\nActor: ${entry.executorId ? `<@${entry.executorId}>` : 'Unknown'}\nTarget: \`${entry.targetId ?? 'unknown'}\`\nEvent: \`${entry.id}\``);
  });
  client.on(Events.GuildMemberAdd, member => { void safeAudit(member.guild, 'Member joined', `<@${member.id}> · Account created <t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`); });
  client.on(Events.GuildMemberRemove, member => { void safeAudit(member.guild, 'Member left', `Member ID: \`${member.id}\``); });
  client.on(Events.MessageDelete, message => {
    if (!message.guild || message.channelId === message.guild.systemChannelId && message.author?.bot) return;
    void safeAudit(message.guild, 'Message deleted', `Channel: <#${message.channelId}>\nMessage: \`${message.id}\`\nAuthor: ${message.author ? `<@${message.author.id}>` : 'Unavailable from cache'}`);
  });
  client.on(Events.MessageBulkDelete, (messages, channel) => { if ('guild' in channel) void safeAudit(channel.guild, 'Messages deleted', `${messages.size} messages in <#${channel.id}>.`); });
}
