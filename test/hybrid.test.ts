import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ButtonBuilder, ButtonStyle, ChannelType, MessageFlags, type Guild } from 'discord.js';
import { defaultEmojis } from '../src/emoji-defaults.js';
import { buttonEmoji, loadEmojis, panel, parseEmojis, privatePanel, renderEmojis } from '../src/ui.js';
import { parsePrefix, prefixBody, resolvePrefixOptions, tokenize } from '../src/prefix-parser.js';
import { acquireCommand } from '../src/command-limit.js';
import { prefixPayload, privatePrefixReply } from '../src/prefix.js';

const id = '123456789012345678';
test('partial emoji config inherits defaults, and custom emoji serialize on buttons and text', () => {
  const directory = mkdtempSync(join(tmpdir(), 'kuroo-emoji-'));
  try {
    writeFileSync(join(directory, 'emojis.json'), JSON.stringify({ ticket: `<a:ticket:${id}>` }));
    loadEmojis(join(directory, 'emojis.json'));
    assert.equal(renderEmojis('{emoji:ticket} {emoji:prefix}'), `<a:ticket:${id}> ${defaultEmojis.prefix}`);
    const button = new ButtonBuilder().setCustomId('test').setLabel('Ticket').setStyle(ButtonStyle.Primary).setEmoji(buttonEmoji('ticket'));
    const payload = panel('{emoji:ticket} Support', 'Open', [button]).components[0]!.toJSON();
    assert.deepEqual(button.toJSON().emoji, { id, name: 'ticket', animated: true });
    assert.match(JSON.stringify(payload), /<a:ticket:/);
    assert.deepEqual(buttonEmoji('shield', { shield: `<:shield:${id}>` }), { id, name: 'shield', animated: false });
    assert.deepEqual(buttonEmoji('shield', {}), { name: defaultEmojis.shield });
  } finally { rmSync(directory, { recursive: true }); loadEmojis('./config/emojis.json'); }
});
test('emoji values reject plain text, multiple emojis, malformed custom emoji and whitespace', () => {
  for (const value of ['hello', '✅✅', ' ✅', '<:bad:1>', '<@123456789012345678>', '✅\n']) assert.throws(() => parseEmojis({ shield: value }));
  assert.deepEqual(parseEmojis(defaultEmojis), defaultEmojis);
});
test('all source emoji placeholders and button keys exist in the configurable catalogue', () => {
  const config = JSON.parse(readFileSync('config/emojis.json', 'utf8'));
  assert.deepEqual(config, defaultEmojis);
  for (const file of readdirSync('src').filter(file => file.endsWith('.ts'))) {
    const source = readFileSync(join('src', file), 'utf8');
    for (const match of source.matchAll(/\{emoji:([a-z_]+)\}|buttonEmoji\('([a-z_]+)'\)/g)) {
      assert.ok(Object.hasOwn(config, match[1] ?? match[2]!), `${file}: ${match[0]}`);
    }
  }
});
test('prefix matching supports configured and mention prefixes with a mention boundary', () => {
  assert.equal(prefixBody('?ping', '?', id), 'ping');
  assert.equal(prefixBody('!ping', '?', id), null);
  assert.equal(prefixBody(`<@${id}> ping`, '?', id), 'ping');
  assert.equal(prefixBody(`<@!${id}> help`, '?', id), 'help');
  assert.equal(prefixBody(`<@${id}>ping`, '?', id), null);
});
test('prefix parser shares command schemas, subcommands, named/positional options and quoting', () => {
  assert.deepEqual(tokenize('ban "a b" \'c d\''), ['ban', 'a b', 'c d']);
  const ban = parsePrefix(`ban <@${id}> "Repeated spam"`)!;
  assert.equal(ban.values.get('user'), id);
  assert.equal(ban.values.get('reason'), 'Repeated spam');
  const timeout = parsePrefix(`timeout --user ${id} --minutes 10 --reason "Repeated spam"`)!;
  assert.equal(timeout.values.get('minutes'), 10);
  assert.equal(parsePrefix('security')!.subcommand, 'status');
  assert.equal(parsePrefix('security configure --enabled false')!.values.get('enabled'), false);
  assert.equal(parsePrefix('unknown'), null);
  assert.equal(parsePrefix('prefix ?')!.values.get('value'), '?');
});
test('prefix parser rejects invalid choices, types, limits, mentions and duplicate or missing options', () => {
  for (const input of ['purge 101', 'purge 1.5', 'purge', 'channel erase', 'security configure maybe', 'security nonexistent', `ban <#${id}> reason`, 'ping extra', 'purge --bad 1', 'purge --count 1 --count 2', 'purge --count', 'ban "unclosed', `ban ${id} "${'x'.repeat(401)}"`, 'prefix toolongvalue']) {
    assert.throws(() => parsePrefix(input), undefined, input);
  }
});
test('prefix resolution rejects foreign roles, channels of incorrect type, and missing users', async () => {
  const guild = { client: { users: { fetch: async () => { throw new Error('not found'); } } }, roles: { fetch: async () => null }, channels: { fetch: async () => ({ id, type: ChannelType.GuildVoice }) } } as unknown as Guild;
  await assert.rejects(resolvePrefixOptions(parsePrefix(`userinfo ${id}`)!, guild), /could not be found/);
  await assert.rejects(resolvePrefixOptions(parsePrefix(`role-members ${id}`)!, guild), /does not belong/);
  await assert.rejects(resolvePrefixOptions(parsePrefix(`setup --logs ${id}`)!, guild), /wrong type/);
  const options = await resolvePrefixOptions(parsePrefix('security configure false')!, guild);
  assert.equal(options.getBoolean('enabled', true), false);
  assert.equal(options.getString('missing'), null);
  assert.throws(() => options.getString('missing', true), /Missing/);
});
test('slash and prefix share one action budget and release after failures', () => {
  const release = acquireCommand('hybrid-test');
  assert.ok(release);
  assert.equal(acquireCommand('hybrid-test'), null);
  release();
  for (let i = 0; i < 3; i++) { const done = acquireCommand('hybrid-test'); assert.ok(done); done(); }
  assert.equal(acquireCommand('hybrid-test'), null);
});
test('prefix output removes ephemeral flags, suppresses mentions and keeps sensitive results private', () => {
  const converted = prefixPayload(privatePanel('Test', '<@everyone>'));
  assert.equal(converted.flags, MessageFlags.IsComponentsV2);
  assert.deepEqual(converted.allowedMentions, { parse: [] });
  for (const name of ['cases', 'trust', 'extraowner', 'report']) assert.equal(privatePrefixReply(name, ''), true);
  assert.equal(privatePrefixReply('automod', 'history'), true);
  assert.equal(privatePrefixReply('channel', ''), false);
});
