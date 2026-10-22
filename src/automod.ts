import { Client, Events, Message, PermissionFlagsBits as P } from 'discord.js';
import { getSettings, ModCase, Strike } from './models.js';
import { escalatedAction, filterViolation } from './automod-policy.js';
import { recordedAction } from './actions.js';
import { reportError } from './audit.js';
import { protectedMember } from './permissions.js';
import { SlidingWindow } from './security-policy.js';
const busy = new Set<string>();
const mentions = new SlidingWindow();
async function incrementStrike(guildId: string, userId: string) {
  await Strike.deleteOne({ guildId, userId, expiresAt: { $lte: new Date() } });
  const update = { $inc: { count: 1 }, $set: { expiresAt: new Date(Date.now() + 86_400_000) } };
  try { return (await Strike.findOneAndUpdate({ guildId, userId }, update, { upsert: true, returnDocument: 'after' }))!.count!; }
  catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
    return (await Strike.findOneAndUpdate({ guildId, userId }, update, { returnDocument: 'after' }))!.count!;
  }
}
export async function filterMessage(message: Message) {
  if (!message.inGuild() || message.author.bot || message.webhookId || !message.member) return;
  const config = await getSettings(message.guildId);
  const am = config.automod;
  if (!am?.enabled || am.users.includes(message.author.id) || am.channels.includes(message.channelId)) return;
  const member = await message.guild.members.fetch({ user: message.author.id, force: true });
  if (protectedMember(member) || am.roles.some(id => member.roles.cache.has(id))) return;
  let mentionCount = message.mentions.users.size + message.mentions.roles.size;
  if (am.rules.includes('mentions')) {
    const addedMentions = Math.min(mentionCount, am.mentionLimit);
    for (let index = 0; index < addedMentions; index++) mentionCount = mentions.hit(`${message.guildId}:${member.id}`, Date.now(), 10_000);
  }
  const violation = filterViolation({
    content: message.content, mentions: mentionCount, everyone: message.mentions.everyone,
    attachments: message.attachments.size, forwarded: message.messageSnapshots.size > 0,
    explicitMedia: message.attachments.some(item => (item.flags.bitfield & 16) !== 0),
  }, am);
  if (!violation) return;
  const me = await message.guild.members.fetchMe();
  if (!message.channel.permissionsFor(me)?.has([P.ViewChannel, P.ManageMessages]) || !message.deletable) return;
  const key = `${message.guildId}:${member.id}`;
  if (busy.has(key)) return;
  busy.add(key);
  try {
    // Deduplicate creates/edits and gateway redelivery before counting a strike.
    const removed = await recordedAction(message.guild, me.id, member.id, `automod-delete:${violation}`, `Message ${message.id} in ${message.channelId}`, () => message.delete(), `automod:${message.id}`);
    if (!removed) return;
    const count = am.strikes ? await incrementStrike(message.guildId, member.id) : 1;
    const action = am.strikes ? escalatedAction(am.action, count, am.strikeThreshold) : am.action;
    if (action === 'delete') return;
    // Record a separate action so a failed timeout never claims the deletion failed.
    if (action === 'timeout' && !member.moderatable || action === 'kick' && !member.kickable || action === 'ban' && !member.bannable) {
      await ModCase.create({ guildId: message.guildId, actorId: me.id, targetId: member.id, action: `automod-${action}`, reason: 'Required permission or role hierarchy prevents escalation', outcome: 'failed' });
      return;
    }
    await recordedAction(message.guild, me.id, member.id, `automod-${action}`, `Rule ${violation}; strike ${count}`, async () => {
      if (action === 'timeout') await member.timeout(600_000, `Kuroo automod: ${violation}`);
      if (action === 'kick') await member.kick(`Kuroo automod: ${violation}`);
      if (action === 'ban') await member.ban({ reason: `Kuroo automod: ${violation}` });
    });
  } finally { busy.delete(key); }
}
export function installAutomod(client: Client) {
  const create = (message: Message) => { void filterMessage(message).catch(error => reportError('Automod failed', error)); };
  const update = (_old: unknown, message: Message | { partial: true }) => { if (!message.partial) create(message as Message); };
  client.on(Events.MessageCreate, create);
  client.on(Events.MessageUpdate, update);
  const timer = setInterval(() => mentions.prune(Date.now(), 10_000), 30_000); timer.unref();
  return () => { clearInterval(timer); client.off(Events.MessageCreate, create); client.off(Events.MessageUpdate, update); };
}
