import { Client, Events, escapeMarkdown, Guild, GuildMember, Message, PermissionFlagsBits as P } from 'discord.js';
import { getSettings, ModCase } from './models.js';
import { SlidingWindow } from './security-policy.js';
import { reportError, safeAudit } from './audit.js';

type Config = Awaited<ReturnType<typeof getSettings>>;
const cached = new Map<string, { expires: number; value: Config }>();
const pendingSettings = new Map<string, Promise<Config>>();
export function invalidateSecurityConfig(guildId: string) { cached.delete(guildId); }
async function settingsFor(guildId: string) {
  const found = cached.get(guildId);
  if (found && found.expires > Date.now()) return found.value;
  const pending = pendingSettings.get(guildId);
  if (pending) return pending;
  const request = getSettings(guildId).then(value => {
    cached.set(guildId, { value, expires: Date.now() + 5_000 });
    return value;
  }).finally(() => pendingSettings.delete(guildId));
  pendingSettings.set(guildId, request);
  return request;
}
const joins = new SlidingWindow();
const messages = new SlidingWindow();
const raidUntil = new Map<string, number>();
const busy = new Set<string>();

async function autoTimeout(member: GuildMember, reason: string, guild: Guild) {
  const fresh = await guild.members.fetch({ user: member.id, force: true });
  if (fresh.user.bot || fresh.id === guild.ownerId || fresh.permissions.has([P.ManageGuild]) || fresh.permissions.has(P.ModerateMembers) || !fresh.moderatable || fresh.communicationDisabledUntilTimestamp && fresh.communicationDisabledUntilTimestamp > Date.now()) return;
  const me = await guild.members.fetchMe();
  // Persist intent before applying a punishment. If MongoDB is down, do not act.
  const record = await ModCase.create({ guildId: guild.id, targetId: fresh.id, actorId: me.id, action: 'auto-timeout', reason });
  try { await fresh.timeout(10 * 60_000, reason); }
  catch (error) { record.outcome = 'failed'; await record.save(); throw error; }
  record.outcome = 'succeeded'; await record.save();
  await safeAudit(guild, '{emoji:shield} Automatic timeout', `<@${fresh.id}> · 10 minutes\n${escapeMarkdown(reason)}\nCase: \`${record.id}\``);
}
async function onJoin(member: GuildMember) {
  if (member.user.bot) return;
  const config = await settingsFor(member.guild.id);
  if (!config.securityEnabled) return;
  const now = Date.now();
  const count = joins.hit(member.guild.id, now, config.joinWindowSeconds * 1000);
  if (count >= config.joinLimit) {
    const alreadyActive = (raidUntil.get(member.guild.id) ?? 0) > now;
    raidUntil.set(member.guild.id, now + 60_000);
    if (!alreadyActive) await safeAudit(member.guild, '{emoji:warning} Join surge detected', `${count} joins in ${config.joinWindowSeconds} seconds. New accounts joining during the next 60 seconds will receive a 10 minute timeout.\nMinimum account age: ${config.minAccountAgeHours} hours.`);
  }
  if ((raidUntil.get(member.guild.id) ?? 0) <= now || now - member.user.createdTimestamp >= config.minAccountAgeHours * 3_600_000) return;
  const key = `${member.guild.id}:${member.id}`;
  if (busy.has(key)) return;
  busy.add(key);
  try { await autoTimeout(member, 'Young account joined during an active join surge', member.guild); }
  finally { busy.delete(key); }
}
async function onMessage(message: Message) {
  if (!message.inGuild() || message.author.bot || message.webhookId || !message.member) return;
  const config = await settingsFor(message.guildId);
  if (!config.securityEnabled) return;
  const key = `${message.guildId}:${message.author.id}`;
  const count = messages.hit(key, Date.now(), 5_000);
  if (count < config.spamLimit || busy.has(key)) return;
  busy.add(key);
  try { await autoTimeout(message.member, `Message flood: ${count} messages in 5 seconds`, message.guild); }
  finally { busy.delete(key); }
}
export function installSecurity(client: Client) {
  client.on(Events.GuildMemberAdd, member => { void onJoin(member).catch(error => reportError('Join protection failed', error)); });
  client.on(Events.MessageCreate, message => { void onMessage(message).catch(error => reportError('Message protection failed', error)); });
  const cleanup = setInterval(() => {
    const now = Date.now();
    joins.prune(now, 120_000); messages.prune(now, 5_000);
    for (const [id, until] of raidUntil) if (until <= now) raidUntil.delete(id);
    for (const [id, entry] of cached) if (entry.expires <= now) cached.delete(id);
  }, 60_000);
  cleanup.unref();
  return () => clearInterval(cleanup);
}
