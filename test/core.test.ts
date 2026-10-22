import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags, ComponentType } from 'discord.js';
import { canModerate, SlidingWindow } from '../src/security-policy.js';
import { loadEmojis, panel, parseEmojis, privatePanel, renderEmojis } from '../src/ui.js';
import { commands } from '../src/commands.js';

test('sliding windows isolate members, expire the boundary, and reset after cleanup', () => {
  const window = new SlidingWindow();
  assert.equal(window.hit('a', 0, 5000), 1);
  assert.equal(window.hit('a', 1000, 5000), 2);
  assert.equal(window.hit('b', 1000, 5000), 1);
  assert.equal(window.hit('a', 5000, 5000), 2);
  window.prune(11_000, 5000);
  assert.equal(window.hit('a', 11_000, 5000), 1);
});
test('moderation protects owner, self, bot, and equal or higher roles', () => {
  const actor = { id: 'moderator', position: 10 };
  for (const id of ['owner', 'bot', 'moderator']) assert.equal(canModerate(actor, { id, position: 1 }, 'owner', 'bot'), false);
  for (const position of [10, 11]) assert.equal(canModerate(actor, { id: 'target', position }, 'owner', 'bot'), false);
  assert.equal(canModerate(actor, { id: 'target', position: 9 }, 'owner', 'bot'), true);
  assert.equal(canModerate({ id: 'owner', position: 1 }, { id: 'target', position: 99 }, 'owner', 'bot'), true);
});
test('manual emoji configuration replaces static and animated placeholders without recursive expansion', () => {
  const map = parseEmojis({ shield: '<:shield:123456789012345678>', success: '<a:ok:123456789012345679>' });
  assert.equal(renderEmojis('{emoji:shield} {emoji:success} {emoji:missing}', map), '<:shield:123456789012345678> <a:ok:123456789012345679> {emoji:missing}');
  for (const invalid of [[], null, { shield: '<bad>' }, { shield: 3 }, { shield: '\n' }]) assert.throws(() => parseEmojis(invalid));
});
test('Components V2 responses use a container, suppress mentions, and do not mix embeds/content', () => {
  loadEmojis('./config/emojis.json');
  const payload = panel('{emoji:shield} Kuroo', 'Ready');
  assert.equal(payload.flags, MessageFlags.IsComponentsV2);
  const container = payload.components[0]!.toJSON();
  assert.equal(container.type, ComponentType.Container);
  assert.deepEqual(payload.allowedMentions.parse, []);
  assert.equal('embeds' in payload, false);
  assert.equal('content' in payload, false);
  assert.ok(privatePanel('Private', 'Reply').flags & MessageFlags.Ephemeral);
});
test('all slash commands serialize as guild-only, with explicit permissions on privileged commands', () => {
  const publicCommands = new Set(['help', 'ping']);
  for (const command of commands) {
    const json = command.toJSON();
    assert.deepEqual(json.contexts, [0]);
    if (!publicCommands.has(json.name)) assert.ok(json.default_member_permissions);
  }
});
