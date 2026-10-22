import { EventEmitter } from 'node:events';
import { setTimeout } from 'node:timers/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Client, Events, ButtonInteraction, ChannelType, ChatInputCommandInteraction, PermissionFlagsBits as P } from 'discord.js';
import { Settings, Ticket, ModCase, getSettings } from '../src/models.js';
import { moderate } from '../src/moderation.js';
import { handleTicket } from '../src/tickets.js';
import { installSecurity } from '../src/security.js';
import { UserError } from '../src/errors.js';

test('MongoDB persistence and moderation/ticket boundaries', async t => {
  const server = await MongoMemoryServer.create();
  try {
    await mongoose.connect(server.getUri());
    await Promise.all([Settings.createIndexes(), Ticket.createIndexes(), ModCase.createIndexes()]);
    await t.test('concurrent first settings reads share one document with protection disabled', async () => {
      const settings = await Promise.all(Array.from({ length: 10 }, () => getSettings('guild')));
      assert.equal(new Set(settings.map(item => item.id)).size, 1);
      assert.equal(settings[0]!.securityEnabled, false);
    });
    await t.test('ticket reservation rejects concurrent duplicates and permits reopening after close', async () => {
      const attempts = await Promise.allSettled(Array.from({ length: 5 }, () => Ticket.create({ guildId: 'g', ownerId: 'u', status: 'creating' })));
      assert.equal(attempts.filter(item => item.status === 'fulfilled').length, 1);
      await Ticket.updateOne({ guildId: 'g', ownerId: 'u' }, { status: 'closed' });
      await Ticket.create({ guildId: 'g', ownerId: 'u', status: 'open' });
      assert.equal(await Ticket.countDocuments({ guildId: 'g', ownerId: 'u' }), 2);
    });
    await t.test('runtime moderation denies a caller even when command is already visible', async () => {
      const interaction = { commandName: 'ban', guild: { members: { fetch: async () => ({ permissions: { has: () => false } }) } }, user: { id: 'actor' } };
      await assert.rejects(moderate(interaction as unknown as ChatInputCommandInteraction), UserError);
      assert.equal(await ModCase.countDocuments(), 0);
    });
    await t.test('failed Discord moderation is persisted as failed, with no success reply', async () => {
      const actor = { id: 'actor', roles: { highest: { position: 10 } }, permissions: { has: () => true } };
      const target = { id: 'target', roles: { highest: { position: 1 } }, bannable: true, ban: async () => { throw new Error('Discord denied'); } };
      const me = { id: 'bot', permissions: { has: () => true }, roles: { highest: { comparePositionTo: () => 1 } } };
      const interaction = {
        commandName: 'ban', user: { id: 'actor' },
        guild: { id: 'mod-guild', ownerId: 'owner', members: { fetch: async (id: string) => id === 'actor' ? actor : target, fetchMe: async () => me } },
        options: { getUser: () => ({ id: 'target' }), getString: () => 'Test reason' },
        editReply: async () => assert.fail('must not acknowledge success'),
      };
      await assert.rejects(moderate(interaction as unknown as ChatInputCommandInteraction), /Discord denied/);
      assert.equal((await ModCase.findOne({ guildId: 'mod-guild' }))!.outcome, 'failed');
    });
    await t.test('message flood applies exactly one audited timeout at the configured threshold', async () => {
      const guildId = 'spam-guild';
      await getSettings(guildId);
      await Settings.updateOne({ guildId }, { securityEnabled: true, spamLimit: 3 });
      let actions = 0;
      const member = {
        id: 'spammer', user: { bot: false }, moderatable: true,
        permissions: { has: () => false }, communicationDisabledUntilTimestamp: null as number | null,
        timeout: async (duration: number) => { assert.equal(duration, 600_000); actions++; member.communicationDisabledUntilTimestamp = Date.now() + duration; },
      };
      const guild = { id: guildId, ownerId: 'owner', members: { fetch: async () => member, fetchMe: async () => ({ id: 'bot' }) } };
      const client = new EventEmitter();
      const stop = installSecurity(client as unknown as Client);
      try {
        for (let index = 0; index < 8; index++) client.emit(Events.MessageCreate, { inGuild: () => true, author: { id: member.id, bot: false }, member, guild, guildId });
        for (let retry = 0; retry < 100; retry++) {
          if (await ModCase.exists({ guildId, outcome: 'succeeded' })) break;
          await setTimeout(10);
        }
        const records = await ModCase.find({ guildId });
        assert.equal(records.length, 1);
        assert.equal(records[0]!.outcome, 'succeeded');
        assert.equal(actions, 1);
      } finally { stop(); }
    });
    await t.test('join surge only times out young accounts from the threshold onward', async () => {
      const guildId = 'raid-guild';
      await getSettings(guildId);
      await Settings.updateOne({ guildId }, { securityEnabled: true, joinLimit: 3 });
      const timedOut: string[] = [];
      const members = new Map<string, unknown>();
      const guild = { id: guildId, ownerId: 'owner', members: { fetch: async (options: { user: string }) => members.get(options.user), fetchMe: async () => ({ id: 'bot' }) } };
      const client = new EventEmitter();
      const stop = installSecurity(client as unknown as Client);
      try {
        for (let index = 0; index < 4; index++) {
          const id = `joiner-${index}`;
          const member = {
            id, guild, user: { bot: false, createdTimestamp: index === 3 ? Date.now() - 48 * 3_600_000 : Date.now() },
            moderatable: true, permissions: { has: () => false },
            timeout: async () => { timedOut.push(id); },
          };
          members.set(id, member);
          client.emit(Events.GuildMemberAdd, member);
        }
        for (let retry = 0; retry < 100; retry++) {
          if (await ModCase.exists({ guildId, outcome: 'succeeded' })) break;
          await setTimeout(10);
        }
        assert.deepEqual(timedOut, ['joiner-2']);
        assert.equal(await ModCase.countDocuments({ guildId, outcome: 'succeeded' }), 1);
      } finally { stop(); }
    });
    await t.test('ticket creation denies everyone, allows only owner/staff/bot, and releases failed reservations', async () => {
      await getSettings('ticket-guild');
      await Settings.updateOne({ guildId: 'ticket-guild' }, { staffRoleId: 'staff', ticketCategoryId: 'category' });
      let deleted = false;
      let overwrites: Array<{ id: string; deny?: bigint[]; allow?: bigint[] }> = [];
      const interaction = {
        customId: 'ticket:open', user: { id: 'member' }, guild: {
          id: 'ticket-guild', members: { fetch: async () => ({ id: 'member' }), fetchMe: async () => ({ id: 'bot' }) },
          roles: { fetch: async () => ({ id: 'staff', managed: false }) },
          channels: {
            fetch: async () => ({ id: 'category', type: ChannelType.GuildCategory, permissionsFor: () => ({ has: () => true }) }),
            create: async (options: { permissionOverwrites: typeof overwrites }) => {
              overwrites = options.permissionOverwrites;
              return { id: 'channel', send: async () => { throw new Error('send failed'); }, delete: async () => { deleted = true; } };
            },
          },
        },
      };
      await assert.rejects(handleTicket(interaction as unknown as ButtonInteraction), /send failed/);
      assert.equal(deleted, true);
      assert.deepEqual(overwrites.map(item => item.id), ['ticket-guild', 'member', 'staff', 'bot']);
      assert.deepEqual(overwrites[0]!.deny, [P.ViewChannel]);
      assert.equal(await Ticket.countDocuments({ guildId: 'ticket-guild', ownerId: 'member' }), 0);
    });
  } finally { await mongoose.disconnect(); await server.stop(); }
});
