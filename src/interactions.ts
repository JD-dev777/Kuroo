import { Client, Events, Interaction } from 'discord.js';
import mongoose from 'mongoose';
import { handleVerification, verificationModal } from './verification.js';
import { confirmBulkChannel } from './moderation-extra.js';
import { handleTicket } from './tickets.js';
import { privatePanel } from './ui.js';
import { reportError } from './audit.js';
import { UserError } from './errors.js';
import { runCommand } from './command-router.js';
import { acquireCommand } from './command-limit.js';
async function handle(interaction: Interaction) {
  if (!interaction.isChatInputCommand() && !interaction.isButton() && !interaction.isModalSubmit()) return;
  if (!interaction.inGuild() || !interaction.guild) {
    await interaction.reply(privatePanel('{emoji:error} Server only', 'Use Kuroo inside a server.')); return;
  }
  const key = `${interaction.guildId}:${interaction.user.id}`;
  const release = acquireCommand(key);
  if (!release) {
    await interaction.reply(privatePanel('{emoji:warning} Please wait', 'Finish your current action or wait a few seconds before trying again.')); return;
  }
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
    await runCommand(interaction);
  } catch (error) {
    if (!(error instanceof UserError)) reportError('Interaction failed', error);
    const response = privatePanel('{emoji:error} Unable to complete action', error instanceof UserError ? error.message : 'The action could not be confirmed. Check permissions and moderation logs before retrying.');
    try {
      if (interaction.deferred || interaction.replied) await interaction.editReply(response);
      else await interaction.reply(response);
    } catch (replyError) { reportError('Error response failed', replyError); }
  } finally { release(); }
}
export function installInteractions(client: Client) {
  client.on(Events.InteractionCreate, interaction => { void handle(interaction).catch(error => reportError('Interaction dispatch failed', error)); });
}
