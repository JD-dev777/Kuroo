import {
  AuditLogEvent as A, Client, Events, Guild, GuildAuditLogsEntry, GuildBasedChannel,
  ChannelType, PermissionFlagsBits as P, Role, DMChannel,
} from 'discord.js';
import { getSettings, ModCase, Snapshot } from './models.js';
import { recordedAction } from './actions.js';
import { reportError, safeAudit } from './audit.js';
import { dangerousPermissions } from './permissions.js';

export const monitoredActions = new Set<number>([
  A.ChannelCreate, A.ChannelUpdate, A.ChannelDelete, A.ChannelOverwriteCreate, A.ChannelOverwriteUpdate, A.ChannelOverwriteDelete,
  A.RoleCreate, A.RoleUpdate, A.RoleDelete, A.MemberRoleUpdate, A.MemberBanAdd, A.MemberBanRemove, A.MemberKick, A.MemberPrune,
  A.BotAdd, A.WebhookCreate, A.WebhookUpdate, A.WebhookDelete, A.GuildUpdate, A.IntegrationCreate, A.IntegrationUpdate, A.IntegrationDelete,
]);
export function eligibleAudit(entry: { action: number; executorId: string | null; createdTimestamp: number }, ownerId: string, botId: string, trusted: readonly string[], now = Date.now()) {
  return monitoredActions.has(entry.action) && !!entry.executorId && entry.executorId !== ownerId && entry.executorId !== botId && !trusted.includes(entry.executorId) && entry.createdTimestamp <= now + 5_000 && entry.createdTimestamp >= now - 30_000;
}
export async function saveSnapshot(item: GuildBasedChannel | Role) {
  if (item instanceof Role) {
    if (item.managed || item.id === item.guild.id) return;
    await Snapshot.updateOne({ guildId: item.guild.id, targetId: item.id }, { $set: { kind: 'role', data: {
      name: item.name, color: item.color, hoist: item.hoist, mentionable: item.mentionable, permissions: item.permissions.bitfield.toString(), position: item.position,
    } } }, { upsert: true });
  } else {
    if (item.isThread() || !('permissionOverwrites' in item)) return;
    if (![ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildCategory, ChannelType.GuildAnnouncement].includes(item.type as number)) return;
    const text = 'topic' in item ? { topic: item.topic, nsfw: item.nsfw, rateLimitPerUser: item.rateLimitPerUser } : {};
    await Snapshot.updateOne({ guildId: item.guild.id, targetId: item.id }, { $set: { kind: 'channel', data: {
      name: item.name, type: item.type, parent: item.parentId, position: item.rawPosition, ...text,
      permissionOverwrites: item.permissionOverwrites.cache.map(value => ({ id: value.id, type: value.type, allow: value.allow.bitfield.toString(), deny: value.deny.bitfield.toString() })),
    } } }, { upsert: true });
  }
}
async function recover(entry: GuildAuditLogsEntry, guild: Guild) {
  const id = entry.targetId;
  if (!id) return;
  const reason = 'Kuroo: recover untrusted audit action';
  if (entry.action === A.ChannelDelete || entry.action === A.RoleDelete) {
    const snapshot = await Snapshot.findOne({ guildId: guild.id, targetId: id });
    if (!snapshot) throw new Error('No recovery snapshot exists');
    if (snapshot.kind === 'channel') {
      const data = snapshot.data;
      // Never recreate a private channel when its overwrites are unknown.
      if (!Array.isArray(data.permissionOverwrites)) throw new Error('Incomplete channel snapshot');
      const parent = data.parent ? await guild.channels.fetch(data.parent).catch(() => null) : null;
      await guild.channels.create({ ...data, parent: parent?.id ?? null, reason });
    } else {
      await guild.roles.create({ ...snapshot.data, permissions: BigInt(snapshot.data.permissions), reason });
    }
    return;
  }
  if (entry.action === A.ChannelCreate) { await guild.channels.delete(id, reason); return; }
  if (entry.action === A.RoleCreate) {
    const role = await guild.roles.fetch(id);
    if (role && !role.managed) await role.delete(reason);
    return;
  }
  if (entry.action === A.MemberBanAdd) { await guild.members.unban(id, reason); return; }
  if (entry.action === A.MemberBanRemove) {
    if (id !== guild.ownerId && id !== guild.client.user.id) await guild.members.ban(id, { reason });
    return;
  }
  if (entry.action === A.BotAdd) {
    const member = await guild.members.fetch(id);
    if (member.user.bot && member.kickable) await member.kick(reason);
    return;
  }
  if (entry.action === A.WebhookCreate) {
    const hooks = await guild.fetchWebhooks();
    const hook = hooks.get(id); if (hook) await hook.delete(reason);
    return;
  }
  if (entry.action === A.MemberRoleUpdate) {
    const added = entry.changes.find(change => change.key === '$add')?.new as { id: string }[] | undefined;
    const member = await guild.members.fetch(id);
    const roles = await guild.roles.fetch();
    const dangerous = (added ?? []).filter(value => {
      const role = roles.get(value.id);
      return role && !role.managed && (role.permissions.bitfield & dangerousPermissions) !== 0n;
    }).map(value => value.id);
    if (dangerous.length) await member.roles.remove(dangerous, reason);
    return;
  }
  if (entry.action === A.GuildUpdate) {
    const fresh = await guild.fetch();
    const update: Record<string, unknown> = {};
    for (const key of ['name', 'description'] as const) {
      const change = entry.changes.find(value => value.key === key);
      if (change && change.old !== undefined && fresh[key] === change.new) update[key] = change.old;
    }
    if (Object.keys(update).length) await fresh.edit({ ...update, reason });
    return;
  }
  if (entry.action === A.RoleUpdate) {
    const role = await guild.roles.fetch(id);
    if (!role || role.managed) return;
    const update: Record<string, unknown> = {};
    for (const key of ['name', 'hoist', 'mentionable', 'color', 'permissions'] as const) {
      const change = entry.changes.find(value => value.key === key);
      const current = key === 'permissions' ? role.permissions.bitfield.toString() : role[key];
      if (change && change.old !== undefined && String(current) === String(change.new)) update[key] = key === 'permissions' ? BigInt(String(change.old)) : change.old;
    }
    if (Object.keys(update).length) await role.edit({ ...update, reason });
    return;
  }
  if (entry.action === A.ChannelUpdate) {
    const channel = await guild.channels.fetch(id);
    if (!channel || channel.isThread()) return;
    const update: Record<string, unknown> = {};
    for (const [auditKey, field] of [['name', 'name'], ['topic', 'topic'], ['nsfw', 'nsfw'], ['rate_limit_per_user', 'rateLimitPerUser']] as const) {
      const change = entry.changes.find(value => value.key === auditKey);
      const current = (channel as unknown as Record<string, unknown>)[field];
      if (change && change.old !== undefined && current === change.new) update[field] = change.old;
    }
    if (Object.keys(update).length) await channel.edit({ ...update, reason });
    return;
  }
  throw new Error('This audit action has no automatic recovery');
}
async function processAudit(entry: GuildAuditLogsEntry, guild: Guild) {
  const config = await getSettings(guild.id);
  const trusted = [...config.trustedUsers, ...config.extraOwners];
  if (!config.antinuke?.enabled || !eligibleAudit(entry, guild.ownerId, guild.client.user.id, trusted)) return;
  if (entry.action === A.MemberRoleUpdate) {
    const added = entry.changes.find(change => change.key === '$add')?.new as { id: string }[] | undefined;
    const roles = await guild.roles.fetch();
    if (!(added ?? []).some(value => ((roles.get(value.id)?.permissions.bitfield ?? 0n) & dangerousPermissions) !== 0n)) return;
  }
  const executorId = entry.executorId!;
  const me = await guild.members.fetchMe();
  if (!me.permissions.has(P.ViewAuditLog)) return;
  if (config.antinuke.mode === 'alert') {
    let record;
    try { record = await ModCase.create({ guildId: guild.id, actorId: me.id, targetId: executorId, action: 'antinuke-alert', reason: `Audit action ${entry.action}; target ${entry.targetId}`, sourceId: `audit:${entry.id}`, outcome: 'succeeded' }); }
    catch (error) { if ((error as { code?: number }).code === 11000) return; throw error; }
    await safeAudit(guild, '{emoji:warning} Untrusted server change', `Actor: <@${executorId}>\nAction: **${A[entry.action]}**\nTarget: \`${entry.targetId ?? 'unknown'}\`\nAlert only. Case: \`${record.id}\``);
    return;
  }
  const actor = await guild.members.fetch({ user: executorId, force: true }).catch(error => { if (error.code === 10007) return null; throw error; });
  let banned = false;
  if (!actor) {
    const existing = await guild.bans.fetch(executorId).catch(error => { if (error.code === 10026) return null; throw error; });
    if (!existing?.reason?.startsWith('Kuroo: untrusted ')) return;
    try {
      await ModCase.create({ guildId: guild.id, actorId: me.id, targetId: executorId, action: 'antinuke-contained', reason: `Actor already banned; ${A[entry.action]}`, sourceId: `audit:${entry.id}`, outcome: 'succeeded' });
      banned = true;
    } catch (error) { if ((error as { code?: number }).code === 11000) return; throw error; }
  } else {
    if (!actor.bannable) {
      await safeAudit(guild, '{emoji:warning} Unable to contain actor', `<@${executorId}> performed **${A[entry.action]}**. Kuroo needs Ban Members and a higher role.`);
      return;
    }
    banned = await recordedAction(guild, me.id, executorId, 'antinuke-ban', `Untrusted ${A[entry.action]}; target ${entry.targetId}`, () => actor.ban({ reason: `Kuroo: untrusted ${A[entry.action]}` }), `audit:${entry.id}`);
  }
  if (banned && config.antinuke.recovery) {
    await recordedAction(guild, me.id, entry.targetId ?? guild.id, 'antinuke-recovery', `Recover ${A[entry.action]} from event ${entry.id}`, () => recover(entry, guild), `recovery:${entry.id}`);
  }
}
const queues = new Map<string, Promise<void>>();
export async function protectAudit(entry: GuildAuditLogsEntry, guild: Guild) {
  const key = `${guild.id}:${entry.executorId}`;
  const previous = queues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(() => processAudit(entry, guild));
  queues.set(key, current);
  try { await current; } finally { if (queues.get(key) === current) queues.delete(key); }
}
export function installAntinuke(client: Client) {
  const audit = (entry: GuildAuditLogsEntry, guild: Guild) => { void protectAudit(entry, guild).catch(error => reportError('Audit protection failed', error)); };
  const snapshot = (item: GuildBasedChannel | Role | DMChannel) => {
    if (!('guild' in item)) return;
    void getSettings(item.guild.id).then(config => { if (config.antinuke?.recovery) return saveSnapshot(item); }).catch(error => reportError('Recovery snapshot failed', error));
  };
  const channelUpdate = (_old: unknown, value: GuildBasedChannel | DMChannel) => snapshot(value);
  const roleUpdate = (_old: unknown, value: Role) => snapshot(value);
  client.on(Events.GuildAuditLogEntryCreate, audit);
  client.on(Events.ChannelCreate, snapshot); client.on(Events.ChannelDelete, snapshot); client.on(Events.ChannelUpdate, channelUpdate);
  client.on(Events.GuildRoleCreate, snapshot); client.on(Events.GuildRoleDelete, snapshot); client.on(Events.GuildRoleUpdate, roleUpdate);
  return () => {
    client.off(Events.GuildAuditLogEntryCreate, audit);
    client.off(Events.ChannelCreate, snapshot); client.off(Events.ChannelDelete, snapshot); client.off(Events.ChannelUpdate, channelUpdate);
    client.off(Events.GuildRoleCreate, snapshot); client.off(Events.GuildRoleDelete, snapshot); client.off(Events.GuildRoleUpdate, roleUpdate);
  };
}
