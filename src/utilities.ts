import type { CommandContext } from './command-context.js';
import { escapeMarkdown } from 'discord.js';
import { audit } from './audit.js';
import { ModCase } from './models.js';
import { privatePanel } from './ui.js';
import { UserError } from './errors.js';
const reportCooldown = new Map<string, number>();
export async function utility(interaction: CommandContext) {
  const guild = interaction.guild!;
  const name = interaction.commandName;
  if (name === 'report') {
    const now = Date.now();
    for (const [key, until] of reportCooldown) if (until <= now) reportCooldown.delete(key);
    const key = `${guild.id}:${interaction.user.id}`;
    if ((reportCooldown.get(key) ?? 0) > now) throw new UserError('You can submit one report every five minutes.');
    const user = interaction.options.getUser('user', true);
    if (user.id === interaction.user.id) throw new UserError('You cannot report yourself.');
    const reason = interaction.options.getString('reason', true);
    reportCooldown.set(key, now + 300_000);
    // audit must deliver successfully; never tell the member a report was sent if it was dropped.
    const delivered = await audit(guild, '{emoji:report} Member report', `Reporter: <@${interaction.user.id}>\nReported: <@${user.id}>\nChannel: <#${interaction.channelId}>\n${escapeMarkdown(reason)}`);
    if (!delivered) { reportCooldown.delete(key); throw new UserError('No moderation log is configured. Contact server staff directly.'); }
    await interaction.editReply(privatePanel('{emoji:success} Report sent', 'The moderation team received your report.'));
    return;
  }
  if (name === 'stats') {
    await interaction.editReply(privatePanel('{emoji:stats} Kuroo statistics', `Servers: ${interaction.client.guilds.cache.size}\nUptime: ${Math.floor((interaction.client.uptime ?? 0) / 1000)}s\nGateway latency: ${Math.max(0, Math.round(interaction.client.ws.ping))}ms\nServer moderation records: ${await ModCase.countDocuments({ guildId: guild.id })}`));
    return;
  }
  if (name === 'serverinfo') {
    const fresh = await guild.fetch();
    await interaction.editReply(privatePanel('{emoji:server} Server information', `Name: **${escapeMarkdown(fresh.name)}**\nID: \`${fresh.id}\`\nOwner: <@${fresh.ownerId}>\nMembers: ${fresh.memberCount}\nChannels: ${fresh.channels.cache.size}\nRoles: ${fresh.roles.cache.size}\nCreated: <t:${Math.floor(fresh.createdTimestamp / 1000)}:F>`));
    return;
  }
  const user = await (interaction.options.getUser('user') ?? interaction.user).fetch(true);
  if (name === 'avatar' || name === 'banner') {
    const url = name === 'avatar' ? user.displayAvatarURL({ size: 1024 }) : user.bannerURL({ size: 1024 });
    await interaction.editReply(privatePanel(name === 'avatar' ? '{emoji:avatar} User avatar' : '{emoji:banner} User banner', url ? `[Open image](${url})` : 'This user has no custom banner.'));
    return;
  }
  const member = await guild.members.fetch(user.id).catch(() => null);
  await interaction.editReply(privatePanel('{emoji:user} User information', `User: <@${user.id}>\nID: \`${user.id}\`\nBot: ${user.bot}\nCreated: <t:${Math.floor(user.createdTimestamp / 1000)}:F>\nJoined: ${member?.joinedTimestamp ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:F>` : 'Not a current member'}`));
}
