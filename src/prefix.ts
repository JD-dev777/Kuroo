import { Client, Events, Message, MessageFlags, type InteractionEditReplyOptions, type MessageCreateOptions } from 'discord.js';
import mongoose from 'mongoose';
import { runCommand } from './command-router.js';
import { acquireCommand } from './command-limit.js';
import { parsePrefix, prefixBody, resolvePrefixOptions } from './prefix-parser.js';
import { settingsFor } from './security.js';
import { panel } from './ui.js';
import { UserError } from './errors.js';
import { reportError } from './audit.js';

// Prefix replies are ordinary messages. Keep sensitive results out of the source channel.
export function privatePrefixReply(name: string, subcommand: string) {
  return ['cases', 'trust', 'extraowner', 'report'].includes(name) || name === 'automod' && ['history', 'filter'].includes(subcommand);
}
export function prefixPayload(options: InteractionEditReplyOptions): MessageCreateOptions {
  return { components: options.components, flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } };
}
export async function handlePrefix(message: Message) {
  if (!message.inGuild() || message.author.bot || message.webhookId || !message.client.user) return;
  // Avoid reading settings for ordinary messages when persistence is unavailable.
  if (mongoose.connection.readyState !== 1) return;
  const settings = await settingsFor(message.guildId);
  const body = prefixBody(message.content, settings.prefix ?? '!', message.client.user.id);
  if (body === null || !body) return;
  const release = acquireCommand(`${message.guildId}:${message.author.id}`);
  if (!release) {
    await message.reply(panel('{emoji:warning} Please wait', 'Finish your current action or wait a few seconds before trying again.')); return;
  }
  let response: Message | undefined;
  let sensitive = false;
  try {
    const parsed = parsePrefix(body);
    if (!parsed) return;
    const actor = await message.guild.members.fetch(message.author.id);
    if (parsed.permission && !actor.permissions.has(BigInt(parsed.permission))) throw new UserError('You do not have permission to use this command.');
    sensitive = privatePrefixReply(parsed.name, parsed.subcommand);
    if (sensitive) {
      try { response = await message.author.send(panel('{emoji:lock} Kuroo', 'Processing your command…')); }
      catch { throw new UserError('Enable direct messages from this server or use the slash command for a private reply.'); }
    }
    const options = await resolvePrefixOptions(parsed, message.guild);
    await runCommand({
      commandName: parsed.name, options, guild: message.guild, guildId: message.guildId,
      channel: message.channel, channelId: message.channelId, user: message.author, client: message.client,
      async editReply(payload) {
        const result = prefixPayload(payload);
        if (response) return response.edit({ components: result.components, flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } });
        response = await message.channel.send(result);
        return response;
      },
    });
  } catch (error) {
    if (!(error instanceof UserError)) reportError('Prefix command failed', error);
    const payload = panel('{emoji:error} Unable to complete action', error instanceof UserError ? error.message : 'The action could not be confirmed. Check permissions and moderation logs before retrying.');
    if (response) await response.edit(payload);
    else if (!sensitive) await message.reply(payload);
    // A closed DM must never cause sensitive command output to fall back to a public channel.
    else await message.reply(panel('{emoji:lock} Private reply unavailable', 'Enable direct messages from this server or use the slash command.'));
  } finally { release(); }
}
export function installPrefixCommands(client: Client) {
  client.on(Events.MessageCreate, message => { void handlePrefix(message).catch(error => reportError('Prefix dispatch failed', error)); });
}
