import { UserError } from './errors.js';
import { ButtonBuilder, ButtonInteraction, ButtonStyle, ChannelType, ChatInputCommandInteraction, PermissionFlagsBits as P } from 'discord.js';
import { getSettings, Ticket } from './models.js';
import { panel, privatePanel } from './ui.js';
import { safeAudit } from './audit.js';
export async function postTicketPanel(interaction: ChatInputCommandInteraction) {
  const settings = await getSettings(interaction.guildId!);
  if (!settings.staffRoleId || !settings.ticketCategoryId) throw new UserError('Configure a ticket category and staff role with /setup first.');
  if (!interaction.channel?.isSendable()) throw new UserError('This channel cannot receive a ticket panel.');
  await interaction.channel.send(panel('{emoji:ticket} Kuroo Support', 'Need help? Open a private ticket for the server team.', [new ButtonBuilder().setCustomId('ticket:open').setLabel('Open ticket').setStyle(ButtonStyle.Primary)]));
  await interaction.editReply(privatePanel('{emoji:success} Ticket panel posted', 'Members can now open a private support channel.'));
}
export async function handleTicket(interaction: ButtonInteraction) {
  const guild = interaction.guild!;
  const actor = await guild.members.fetch(interaction.user.id);
  const settings = await getSettings(guild.id);
  const me = await guild.members.fetchMe();
  if (interaction.customId === 'ticket:open') {
    if (!settings.ticketCategoryId || !settings.staffRoleId) throw new UserError('Tickets have not been configured.');
    const category = await guild.channels.fetch(settings.ticketCategoryId);
    const staff = await guild.roles.fetch(settings.staffRoleId);
    if (!category || category.type !== ChannelType.GuildCategory || !staff || staff.id === guild.id || staff.managed) throw new UserError('Ticket category or staff role is invalid. Ask an administrator to run /setup.');
    if (!category.permissionsFor(me)?.has([P.ManageChannels, P.ViewChannel, P.SendMessages, P.ManageRoles])) throw new UserError('Kuroo needs View Channel, Send Messages, Manage Channels, and Manage Roles in the ticket category.');
    let ticket;
    try { ticket = await Ticket.create({ guildId: guild.id, ownerId: actor.id, status: 'creating' }); }
    catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
      const existing = await Ticket.findOne({ guildId: guild.id, ownerId: actor.id, status: { $in: ['creating', 'open'] } });
      await interaction.editReply(privatePanel('{emoji:ticket} Ticket already exists', existing?.channelId ? `Your ticket: <#${existing.channelId}>` : 'Your ticket is being created. Ask an administrator if this persists.'));
      return;
    }
    let channel;
    try {
      channel = await guild.channels.create({
        name: `ticket-${actor.id}`, type: ChannelType.GuildText, parent: category.id,
        topic: `Kuroo ticket ${ticket.id}; owner ${actor.id}`,
        permissionOverwrites: [
          { id: guild.id, deny: [P.ViewChannel] },
          { id: actor.id, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory], deny: [P.MentionEveryone, P.CreatePublicThreads, P.CreatePrivateThreads] },
          { id: staff.id, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory] },
          { id: me.id, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.ManageChannels] },
        ],
        reason: `Kuroo ticket for ${actor.id}`,
      });
      ticket.channelId = channel.id;
      await ticket.save();
      await channel.send(panel('{emoji:ticket} Private support', `Welcome <@${actor.id}>. Describe your issue for the server team.\nClosing deletes this channel; Kuroo does not save a transcript.`, [new ButtonBuilder().setCustomId('ticket:close').setLabel('Close ticket').setStyle(ButtonStyle.Danger)]));
      ticket.status = 'open'; await ticket.save();
    } catch (error) {
      // Release the unique reservation only after the private channel is gone.
      if (channel) await channel.delete('Ticket setup failed');
      await ticket.deleteOne();
      throw error;
    }
    await interaction.editReply(privatePanel('{emoji:success} Ticket created', `Continue in <#${channel.id}>.`));
    await safeAudit(guild, 'Ticket opened', `<@${actor.id}> opened <#${channel.id}>.`);
    return;
  }
  const ticket = await Ticket.findOne({ guildId: guild.id, channelId: interaction.channelId, status: 'open' });
  if (!ticket) throw new UserError('This channel is not an open Kuroo ticket.');
  if (actor.id !== ticket.ownerId && !actor.permissions.has(P.ManageChannels) && !(settings.staffRoleId && actor.roles.cache.has(settings.staffRoleId))) throw new UserError('Only the ticket owner or server team can close this ticket.');
  if (interaction.customId === 'ticket:close') {
    await interaction.editReply(privatePanel('{emoji:warning} Delete this ticket?', 'This permanently deletes the channel and its messages. No transcript is saved.', [new ButtonBuilder().setCustomId(`ticket:confirm:${actor.id}`).setLabel('Delete ticket').setStyle(ButtonStyle.Danger)]));
    return;
  }
  if (interaction.customId !== `ticket:confirm:${actor.id}`) throw new UserError('This confirmation belongs to another member.');
  const channel = await guild.channels.fetch(interaction.channelId);
  if (!channel || channel.type !== ChannelType.GuildText) throw new UserError('Ticket channel unavailable.');
  // Acknowledge before deletion; the response is inside the channel being removed.
  await interaction.editReply(privatePanel('{emoji:lock} Closing ticket', 'The channel will now be deleted.'));
  await channel.delete(`Ticket closed by ${actor.id}`);
  ticket.status = 'closed'; await ticket.save();
  await safeAudit(guild, 'Ticket closed', `<@${actor.id}> closed ticket \`${ticket.id}\` owned by <@${ticket.ownerId}>.`);
}
