import { test } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { AuditLogEvent as A, Guild, GuildAuditLogsEntry, ChatInputCommandInteraction, ModalSubmitInteraction, Message, PermissionsBitField, PermissionFlagsBits as P } from 'discord.js';
import { allModels, Settings, getSettings, ModCase, Challenge, Strike, ChannelState, Snapshot, VerificationGate } from '../src/models.js';
import { protectAudit } from '../src/antinuke.js';
import { recordedAction } from '../src/actions.js';
import { filterMessage } from '../src/automod.js';
import { handleVerification, configureVerification } from '../src/verification.js';
import { configureFeature } from '../src/feature-settings.js';
import { captchaDigest } from '../src/captcha.js';
import { UserError } from '../src/errors.js';
import { extraModeration } from '../src/moderation-extra.js';
import { safeAssignableRole } from '../src/permissions.js';
import { protectJoin } from '../src/security.js';

const allow = { has: () => true };
test('expanded features against a real ephemeral MongoDB', async t => {
  const server = await MongoMemoryServer.create();
  try {
    await mongoose.connect(server.getUri());
    await Promise.all(allModels.map(model => model.createIndexes()));
    await t.test('old settings receive safe defaults and all new automations begin disabled', async () => {
      await Settings.collection.insertOne({ guildId: 'legacy', securityEnabled: false });
      const settings = await getSettings('legacy');
      assert.equal(settings.antinuke!.enabled, false);
      assert.equal(settings.antinuke!.mode, 'alert');
      assert.equal(settings.automod!.enabled, false);
      assert.equal(settings.verification!.enabled, false);
      assert.deepEqual(settings.trustedUsers, []);
    });
    await t.test('audit redelivery bans once, recreates a private channel from its overwrites, and exempts trusted users', async () => {
      const guildId = 'audit-guild';
      await getSettings(guildId);
      await Settings.updateOne({ guildId }, { antinuke: { enabled: true, mode: 'ban', recovery: true }, trustedUsers: ['trusted'] });
      const overwrites = [{ id: guildId, allow: '0', deny: P.ViewChannel.toString() }];
      await Snapshot.create({ guildId, targetId: 'deleted-channel', kind: 'channel', data: { name: 'private', type: 0, permissionOverwrites: overwrites } });
      let bans = 0, restores = 0;
      const guild = {
        id: guildId, ownerId: 'owner', client: { user: { id: 'bot' } },
        members: { fetchMe: async () => ({ id: 'bot', permissions: allow }), fetch: async () => ({ bannable: true, ban: async () => { bans++; } }) },
        channels: { create: async (data: { permissionOverwrites: unknown }) => { assert.deepEqual(data.permissionOverwrites, overwrites); restores++; } },
      } as unknown as Guild;
      const entry = { id: 'event1', action: A.ChannelDelete, executorId: 'attacker', targetId: 'deleted-channel', createdTimestamp: Date.now(), changes: [] } as unknown as GuildAuditLogsEntry;
      await Promise.all([protectAudit(entry, guild), protectAudit(entry, guild)]);
      await protectAudit({ ...entry, id: 'event2', executorId: 'trusted' } as GuildAuditLogsEntry, guild);
      assert.equal(bans, 1); assert.equal(restores, 1);
      assert.equal(await ModCase.countDocuments({ guildId, outcome: 'succeeded' }), 2);
    });
    await t.test('alert mode records the event without banning and missing snapshots record recovery failure', async () => {
      const guildId = 'alert-guild';
      await getSettings(guildId);
      await Settings.updateOne({ guildId }, { 'antinuke.enabled': true });
      let bans = 0;
      const guild = { id: guildId, ownerId: 'owner', client: { user: { id: 'bot' } }, members: { fetchMe: async () => ({ id: 'bot', permissions: allow }), fetch: async () => ({ bannable: true, ban: async () => { bans++; } }) } } as unknown as Guild;
      const entry = { id: 'alert1', action: A.ChannelDelete, executorId: 'attacker', targetId: 'missing', createdTimestamp: Date.now(), changes: [] } as unknown as GuildAuditLogsEntry;
      await protectAudit(entry, guild); assert.equal(bans, 0);
      await Settings.updateOne({ guildId }, { antinuke: { enabled: true, mode: 'ban', recovery: true } });
      await assert.rejects(protectAudit({ ...entry, id: 'alert2' } as GuildAuditLogsEntry, guild), /No recovery snapshot/);
      assert.equal(bans, 1);
      assert.equal((await ModCase.findOne({ guildId, action: 'antinuke-recovery' }))!.outcome, 'failed');
    });
    await t.test('a server manager cannot alter the audit trust list or appoint security owners', async () => {
      const interaction = {
        commandName: 'trust', user: { id: 'manager' }, guild: { id: 'authority', ownerId: 'owner', members: { fetch: async () => ({ id: 'manager', permissions: allow }) } },
        options: { getString: () => 'antinuke' },
      } as unknown as ChatInputCommandInteraction;
      await assert.rejects(configureFeature(interaction), UserError);
      assert.deepEqual((await getSettings('authority')).trustedUsers, []);
      await assert.rejects(configureFeature({ ...interaction, commandName: 'extraowner' } as ChatInputCommandInteraction), UserError);
    });
    await t.test('recording failure prevents Discord mutation and preserves failed intent outcomes', async () => {
      let calls = 0;
      const guild = { id: 'actions' } as Guild;
      await assert.rejects(recordedAction(guild, '', 'target', 'test', 'reason', async () => { calls++; }));
      assert.equal(calls, 0);
      await assert.rejects(recordedAction(guild, 'bot', 'target', 'test', 'reason', async () => { throw new Error('denied'); }), /denied/);
      assert.equal((await ModCase.findOne({ guildId: guild.id }))!.outcome, 'failed');
    });
    await t.test('automod counts one strike per deleted message and does not count failed deletions or exempt roles', async () => {
      const guildId = 'filter-guild';
      await getSettings(guildId);
      await Settings.updateOne({ guildId }, { 'automod.enabled': true, 'automod.rules': ['links'], 'automod.strikes': true, 'automod.roles': ['staff'] });
      let deletes = 0;
      const member: any = { id: 'member', permissions: { has: () => false }, roles: { cache: new Map() } };
      const guild: any = { id: guildId, ownerId: 'owner', members: { fetch: async () => member, fetchMe: async () => ({ id: 'bot' }) } };
      member.guild = guild;
      const message: any = {
        id: 'message1', guildId, guild, inGuild: () => true, author: { id: member.id, bot: false }, member,
        content: 'https://example.test', channelId: 'channel', mentions: { users: new Map(), roles: new Map(), everyone: false },
        attachments: { size: 0, some: () => false }, messageSnapshots: new Map(),
        channel: { permissionsFor: () => allow }, deletable: true, delete: async () => { deletes++; },
      };
      await filterMessage(message as Message); await filterMessage(message as Message);
      assert.equal(deletes, 1); assert.equal((await Strike.findOne({ guildId, userId: member.id }))!.count, 1);
      message.id = 'message2'; message.delete = async () => { throw new Error('cannot delete'); };
      await assert.rejects(filterMessage(message as Message), /cannot delete/);
      assert.equal((await Strike.findOne({ guildId, userId: member.id }))!.count, 1);
      member.roles.cache.set('staff', {}); message.id = 'message3';
      await filterMessage(message as Message);
      assert.equal(await ModCase.countDocuments({ guildId }), 2);
    });
    await t.test('verification codes are consumed once, expire, and cannot cross member boundaries', async () => {
      const guildId = 'verify-guild';
      await getSettings(guildId);
      await Settings.updateOne({ guildId }, { verification: { enabled: true, roleId: 'verified', channelId: 'verify' } });
      let grants = 0;
      const guild: any = { id: guildId, client: { user: { id: 'bot' } } };
      const role = { id: 'verified', guild, managed: false, permissions: new PermissionsBitField() };
      const member = { id: 'member', roles: { cache: new Map(), add: async () => { grants++; } } };
      guild.roles = { fetch: async () => role };
      guild.channels = { cache: new Map() };
      guild.members = { fetch: async (id: string) => ({ ...member, id }), fetchMe: async () => ({ permissions: allow, roles: { highest: { comparePositionTo: () => 1 } } }) };
      const interaction: any = { guild, user: { id: 'member' }, isButton: () => false, customId: 'verify:answer:nonce', fields: { getTextInputValue: () => 'ABC234' }, editReply: async () => {} };
      await Challenge.create({ guildId, userId: 'member', nonce: 'nonce', digest: captchaDigest('nonce', 'ABC234'), expiresAt: new Date(Date.now() + 60_000) });
      interaction.user.id = 'other';
      await assert.rejects(handleVerification(interaction as ModalSubmitInteraction), UserError);
      assert.equal(await Challenge.countDocuments({ guildId }), 1);
      interaction.user.id = 'member';
      await handleVerification(interaction as ModalSubmitInteraction); assert.equal(grants, 1);
      await assert.rejects(handleVerification(interaction as ModalSubmitInteraction), UserError);
      await Challenge.create({ guildId, userId: 'member', nonce: 'nonce', digest: captchaDigest('nonce', 'ABC234'), expiresAt: new Date(Date.now() - 1) });
      await assert.rejects(handleVerification(interaction as ModalSubmitInteraction), UserError);
      assert.equal(grants, 1);
    });
    await t.test('automatic roles cannot grant moderation powers or unrelated private-channel access', async () => {
      const guild: any = { id: 'role-safety', roles: { everyone: { id: 'role-safety' } }, channels: { cache: new Map() }, members: { fetchMe: async () => ({ permissions: allow, roles: { highest: { comparePositionTo: () => 1 } } }) } };
      const role = { id: 'automatic-role', guild, managed: false, permissions: new PermissionsBitField(P.ManageMessages) };
      guild.roles.fetch = async () => role;
      await assert.rejects(safeAssignableRole(guild, role.id), UserError);
      role.permissions = new PermissionsBitField();
      guild.channels.cache.set('staff-secret', { id: 'staff-secret', isThread: () => false, permissionsFor: (subject: any) => ({ has: () => subject.id === role.id }) });
      await assert.rejects(safeAssignableRole(guild, role.id), /private-channel access/);
      await VerificationGate.create({ guildId: guild.id, roleId: role.id, channelId: 'staff-secret' });
      await safeAssignableRole(guild, role.id); // Access to channels explicitly gated for verification is intentional.
    });
    await t.test('verification setup requires live role/channel management authority', async () => {
      const interaction: any = { guild: { members: { fetch: async () => ({ permissions: { has: () => false } }) } }, user: { id: 'member' } };
      await assert.rejects(configureVerification(interaction), UserError);
    });
    await t.test('verification setup rolls back its enabled state when publishing the panel fails', async () => {
      const guildId = 'verify-setup';
      const guild: any = { id: guildId, roles: { everyone: { id: guildId } } };
      const role = { id: 'verified', guild, managed: false, permissions: new PermissionsBitField() };
      guild.roles.fetch = async () => role;
      guild.members = { fetch: async () => ({ permissions: allow }), fetchMe: async () => ({ permissions: allow, roles: { highest: { comparePositionTo: () => 1 } } }) };
      guild.channels = { cache: new Map(), fetch: async () => ({ id: 'verify-channel', isSendable: () => true, permissionsFor: () => allow, send: async () => { throw new Error('cannot publish'); } }) };
      const interaction: any = { guild, user: { id: 'manager' }, options: { getSubcommand: () => 'setup', getRole: () => role, getChannel: () => ({ id: 'verify-channel' }) } };
      await assert.rejects(configureVerification(interaction), /cannot publish/);
      assert.equal((await getSettings(guildId)).verification!.enabled, false);
    });
    await t.test('disabling verification restores managed bits, retains unrelated bits and manual edits, and releases snapshots', async () => {
      const guildId = 'verify-restore';
      await getSettings(guildId);
      await Settings.updateOne({ guildId }, { verification: { enabled: true, roleId: 'verified', channelId: 'verify' } });
      await VerificationGate.create({ guildId, channelId: 'gated', roleId: 'verified', botId: 'bot', everyone: null, role: null, bot: null });
      const cache = new Map([
        [guildId, { allow: new PermissionsBitField(P.AttachFiles), deny: new PermissionsBitField(P.ViewChannel) }],
        ['verified', { allow: new PermissionsBitField(), deny: new PermissionsBitField(P.ViewChannel) }], // A later manual deny must remain.
        ['bot', { allow: new PermissionsBitField(P.ViewChannel), deny: new PermissionsBitField() }],
      ]);
      const channel: any = { isThread: () => false, permissionsFor: () => allow, permissionOverwrites: { cache,
        edit: async (id: string, changes: any) => {
          const value = cache.get(id)!;
          value.allow.remove(P.ViewChannel); value.deny.remove(P.ViewChannel);
          if (changes.ViewChannel === true) value.allow.add(P.ViewChannel);
          if (changes.ViewChannel === false) value.deny.add(P.ViewChannel);
        },
      } };
      const interaction: any = { guild: { id: guildId, members: { fetch: async () => ({ permissions: allow }), fetchMe: async () => ({ id: 'bot' }) }, channels: { fetch: async () => channel } }, user: { id: 'manager' }, options: { getSubcommand: () => 'disable' }, editReply: async () => {} };
      await configureVerification(interaction);
      assert.equal(cache.get(guildId)!.deny.has(P.ViewChannel), false);
      assert.equal(cache.get(guildId)!.allow.has(P.AttachFiles), true);
      assert.equal(cache.get('verified')!.deny.has(P.ViewChannel), true);
      assert.equal(cache.get('bot')!.allow.has(P.ViewChannel), false);
      assert.equal(await VerificationGate.countDocuments({ guildId }), 0);
      assert.equal((await getSettings(guildId)).verification!.enabled, false);
    });
    await t.test('channel unlock restores the previous tri-state permission and keeps unrelated permissions', async () => {
      const cache = new Map([['channel-guild', { allow: new PermissionsBitField(P.AttachFiles), deny: new PermissionsBitField() }]]);
      const channel: any = {
        id: 'channel', isThread: () => false, permissionsFor: () => allow,
        permissionOverwrites: { cache, edit: async (id: string, update: any) => {
          const value = cache.get(id) ?? { allow: new PermissionsBitField(), deny: new PermissionsBitField() };
          for (const [key, bit] of Object.entries(update)) {
            const flag = P[key as keyof typeof P]; value.allow.remove(flag); value.deny.remove(flag);
            if (bit === true) value.allow.add(flag); if (bit === false) value.deny.add(flag);
          }
          cache.set(id, value);
        } },
      };
      let operation = 'lock';
      const interaction: any = {
        commandName: 'channel', user: { id: 'actor' },
        guild: { id: 'channel-guild', members: { fetch: async () => ({ id: 'actor', permissions: allow }), fetchMe: async () => ({ id: 'bot', permissions: allow }) }, channels: { fetch: async () => channel } },
        options: { getString: (key: string) => key === 'operation' ? operation : null, getBoolean: () => false, getChannel: () => ({ id: 'channel' }) }, editReply: async () => {},
      };
      await extraModeration(interaction); assert.equal(cache.get('channel-guild')!.deny.has(P.SendMessages), true);
      assert.equal((await ChannelState.findOne({ guildId: 'channel-guild' }))!.previous, null);
      operation = 'unlock'; await extraModeration(interaction);
      assert.equal(cache.get('channel-guild')!.deny.has(P.SendMessages), false);
      assert.equal(cache.get('channel-guild')!.allow.has(P.SendMessages), false);
      assert.equal(cache.get('channel-guild')!.allow.has(P.AttachFiles), true);
    });
    await t.test('raid bot filter respects user exceptions and kicks untrusted bots', async () => {
      let kicks = 0;
      const guildId = 'bot-raid'; await getSettings(guildId);
      await Settings.updateOne({ guildId }, { securityEnabled: true, 'raid.botFilter': true, raidTrustedUsers: ['approved'] });
      const member: any = { id: 'untrusted', user: { bot: true }, kickable: true, permissions: { has: () => false }, kick: async () => { kicks++; } };
      member.guild = { id: guildId, ownerId: 'owner', members: { fetch: async () => member, fetchMe: async () => ({ id: 'bot' }) } };
      await protectJoin(member); assert.equal(kicks, 1);
      member.id = 'approved'; await protectJoin(member); assert.equal(kicks, 1);
    });
  } finally { await mongoose.disconnect(); await server.stop(); }
});
