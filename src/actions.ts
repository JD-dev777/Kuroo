import { Guild } from 'discord.js';
import { ModCase } from './models.js';
import { safeAudit } from './audit.js';

// Each individual Discord mutation has an intent and an independently tracked outcome.
export async function recordedAction(guild: Guild, actorId: string, targetId: string, action: string, reason: string, run: () => Promise<unknown>, sourceId?: string) {
  let record;
  try { record = await ModCase.create({ guildId: guild.id, actorId, targetId, action, reason, sourceId }); }
  catch (error) { if (sourceId && (error as { code?: number }).code === 11000) return false; throw error; }
  try { await run(); }
  catch (error) { record.outcome = 'failed'; await record.save(); throw error; }
  record.outcome = 'succeeded'; await record.save();
  await safeAudit(guild, '{emoji:shield} Action recorded', `**${action}** · <@${targetId}> · Actor: <@${actorId}>\nCase: \`${record.id}\``);
  return true;
}
