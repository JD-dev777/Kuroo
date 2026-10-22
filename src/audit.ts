import { Guild, PermissionFlagsBits as P } from 'discord.js';
import { getSettings } from './models.js';
import { panel } from './ui.js';
export async function audit(guild: Guild, title: string, body: string) {
  const settings = await getSettings(guild.id);
  if (!settings.logChannelId) return;
  const channel = await guild.channels.fetch(settings.logChannelId);
  if (!channel?.isTextBased() || !channel.isSendable()) throw new Error('Log channel is unavailable.');
  const me = guild.members.me;
  if (!me || !channel.permissionsFor(me)?.has([P.ViewChannel, P.SendMessages])) throw new Error('Cannot write to log channel.');
  await channel.send(panel(title, body));
}
// Diagnostics deliberately omit SDK error objects: request headers may hold credentials.
export function reportError(context: string, error: unknown) {
  const code = (error as { code?: unknown })?.code;
  console.error(context, { type: error instanceof Error ? error.name : 'UnknownError', code: typeof code === 'number' ? code : undefined });
}
export async function safeAudit(guild: Guild, title: string, body: string) {
  try { await audit(guild, title, body); } catch (error) { reportError('Audit delivery failed', error); }
}
