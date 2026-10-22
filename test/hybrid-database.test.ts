import { test } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MessageFlags, type Message } from 'discord.js';
import { getSettings, Settings, ModCase } from '../src/models.js';
import { handlePrefix } from '../src/prefix.js';
import { invalidateSecurityConfig } from '../src/security.js';

function contents(payload: unknown) { return JSON.stringify(payload); }
test('hybrid gateway and MongoDB settings integration', async t => {
  const server = await MongoMemoryServer.create();
  try {
    await mongoose.connect(server.getUri());
    await Settings.createIndexes();
    let serial = 0;
    function fixture(content: string, allowed = true, closedDm = false) {
      const guildId = `hybrid-${++serial}`;
      const publicReplies: unknown[] = [], dmReplies: unknown[] = [];
      const response = (destination: unknown[]) => ({ edit: async (payload: unknown) => { destination.push(payload); return response(destination); } });
      const actor = { id: 'actor', permissions: { has: () => allowed } };
      const guild = { id: guildId, members: { fetch: async () => actor } };
      const message = {
        content, inGuild: () => true, webhookId: null, guildId, guild, channelId: 'source',
        channel: { send: async (payload: unknown) => { publicReplies.push(payload); return response(publicReplies); } },
        author: { id: 'actor', bot: false, send: async (payload: unknown) => {
          if (closedDm) throw new Error('DM closed');
          dmReplies.push(payload); return response(dmReplies);
        } },
        client: { user: { id: '123456789012345678' }, ws: { ping: 12 } },
        reply: async (payload: unknown) => { publicReplies.push(payload); return response(publicReplies); },
      } as unknown as Message;
      return { message, guildId, publicReplies, dmReplies };
    }
    await t.test('default prefix runs the same ping handler and strips ephemeral flags', async () => {
      const f = fixture('!ping');
      await handlePrefix(f.message);
      assert.equal(f.publicReplies.length, 1);
      assert.match(contents(f.publicReplies), /Kuroo is online/);
      assert.equal((f.publicReplies[0] as { flags: number }).flags, MessageFlags.IsComponentsV2);
      assert.equal((await getSettings(f.guildId)).prefix, '!');
    });
    await t.test('manager changes prefix and the new prefix works immediately', async () => {
      const f = fixture('!prefix ?');
      await handlePrefix(f.message);
      assert.equal((await getSettings(f.guildId)).prefix, '?');
      f.message.content = '?ping';
      await handlePrefix(f.message);
      assert.match(contents(f.publicReplies.at(-1)), /Kuroo is online/);
      const before = f.publicReplies.length;
      f.message.content = '!ping';
      await handlePrefix(f.message);
      assert.equal(f.publicReplies.length, before);
    });
    await t.test('unauthorized prefix changes do not mutate persisted settings', async () => {
      const f = fixture('!prefix ?', false);
      await handlePrefix(f.message);
      assert.equal((await getSettings(f.guildId)).prefix, '!');
      assert.match(contents(f.publicReplies), /permission/);
    });
    await t.test('invalid prefixes are rejected by both the handler and MongoDB schema', async () => {
      const f = fixture('!prefix "two words"');
      await handlePrefix(f.message);
      assert.equal((await getSettings(f.guildId)).prefix, '!');
      for (const value of ['/', '@everyone', '`', 'two words', '<@123>']) {
        const settings = await getSettings(f.guildId);
        settings.prefix = value;
        await assert.rejects(settings.validate());
      }
    });
    await t.test('closed DMs abort sensitive commands without public results or side effects', async () => {
      const f = fixture('!extraowner list', true, true);
      await handlePrefix(f.message);
      assert.equal(f.dmReplies.length, 0);
      assert.match(contents(f.publicReplies), /Private reply unavailable/);
      assert.doesNotMatch(contents(f.publicReplies), /Delegated security owners/);
      assert.deepEqual((await getSettings(f.guildId)).extraOwners, []);
    });
    await t.test('sensitive handler results stay in DM even when the handler denies access', async () => {
      const f = fixture('!extraowner list');
      await handlePrefix(f.message);
      assert.equal(f.publicReplies.length, 0);
      assert.equal(f.dmReplies.length, 2);
      assert.match(contents(f.dmReplies.at(-1)), /owner/i);
    });
    await t.test('moderation history is delivered only to DM after permission checks', async () => {
      const f = fixture('!cases 123456789012345679');
      await ModCase.create({ guildId: f.guildId, targetId: '123456789012345679', actorId: 'staff', action: 'warn', reason: 'Private case details', outcome: 'succeeded' });
      Object.assign(f.message.guild!, { client: { users: { fetch: async () => ({ id: '123456789012345679' }) } } });
      await handlePrefix(f.message);
      assert.equal(f.publicReplies.length, 0);
      assert.match(contents(f.dmReplies.at(-1)), /Private case details/);
    });
    await t.test('bulk channel confirmation is sent to the original server channel', async () => {
      const f = fixture('!channel --operation lock --all true');
      Object.assign(f.message.guild!.members, { fetchMe: async () => ({ permissions: { has: () => true } }) });
      await handlePrefix(f.message);
      assert.equal(f.dmReplies.length, 0);
      assert.match(contents(f.publicReplies), /channel:confirm:actor:lock:/);
      assert.equal((f.publicReplies[0] as { flags: number }).flags, MessageFlags.IsComponentsV2);
    });
    await t.test('bots, webhooks, non-guild messages and other prefixes are ignored', async () => {
      for (const ignored of ['bot', 'webhook', 'dm', 'other']) {
        const f = fixture(ignored === 'other' ? '?ping' : '!ping');
        if (ignored === 'bot') f.message.author.bot = true;
        if (ignored === 'webhook') Object.assign(f.message, { webhookId: 'webhook' });
        if (ignored === 'dm') Object.assign(f.message, { inGuild: () => false });
        await handlePrefix(f.message);
        assert.equal(f.publicReplies.length, 0);
      }
    });
    await t.test('legacy documents without a prefix read as the default', async () => {
      await Settings.collection.insertOne({ guildId: 'legacy-hybrid' });
      invalidateSecurityConfig('legacy-hybrid');
      assert.equal((await getSettings('legacy-hybrid')).prefix, '!');
    });
  } finally { await mongoose.disconnect(); await server.stop(); }
});
