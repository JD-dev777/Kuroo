import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { AuditLogEvent as A } from 'discord.js';
import { filterViolation, escalatedAction, FilterConfig, MessageFacts } from '../src/automod-policy.js';
import { eligibleAudit } from '../src/antinuke.js';
import { createCaptcha, captchaDigest } from '../src/captcha.js';
const config: FilterConfig = { rules: [], words: [], abuseWords: [], explicitWords: [], mentionLimit: 5, attachmentLimit: 5, capsPercent: 75, emojiLimit: 3 };
const facts: MessageFacts = { content: 'hello', mentions: 0, everyone: false, attachments: 0, forwarded: false, explicitMedia: false };
test('audit protection ignores owner, bot, trusted executors, old events, future events, and unrelated actions', () => {
  const now = 100_000;
  const entry = { action: A.ChannelDelete, executorId: 'attacker', createdTimestamp: now };
  assert.equal(eligibleAudit(entry, 'owner', 'bot', [], now), true);
  for (const executorId of ['owner', 'bot', 'trusted', null]) assert.equal(eligibleAudit({ ...entry, executorId }, 'owner', 'bot', ['trusted'], now), false);
  for (const createdTimestamp of [now - 30_001, now + 5_001]) assert.equal(eligibleAudit({ ...entry, createdTimestamp }, 'owner', 'bot', [], now), false);
  assert.equal(eligibleAudit({ ...entry, action: A.MessageDelete }, 'owner', 'bot', [], now), false);
});
test('all supported filters detect their intended inputs and stay disabled until selected', () => {
  const examples: [string, Partial<MessageFacts>, Partial<FilterConfig>?][] = [
    ['invites', { content: 'Join discord.gg/testing' }], ['links', { content: 'https://example.test' }],
    ['mentions', { mentions: 5 }], ['mentions', { everyone: true }], ['attachments', { attachments: 5 }],
    ['forwards', { forwarded: true }], ['explicit-media', { explicitMedia: true }],
    ['caps', { content: 'THIS IS A LONG LOUD MESSAGE' }], ['emojis', { content: '🛡️🛡️🛡️' }],
    ['words', { content: 'A forbidden phrase here' }, { words: ['forbidden phrase'] }],
    ['abuse', { content: 'FORBIDDEN' }, { abuseWords: ['forbidden'] }],
    ['explicit-words', { content: 'ＦＯＲＢＩＤＤＥＮ' }, { explicitWords: ['forbidden'] }],
  ];
  for (const [rule, input, options] of examples) {
    assert.equal(filterViolation({ ...facts, ...input }, { ...config, ...options, rules: [rule] }), rule);
    assert.equal(filterViolation({ ...facts, ...input }, { ...config, ...options }), undefined);
  }
});
test('literal word filters respect boundaries and never interpret regex metacharacters', () => {
  const options = { ...config, rules: ['words'], words: ['bad', 'a+b'] };
  assert.equal(filterViolation({ ...facts, content: 'badge abb' }, options), undefined);
  assert.equal(filterViolation({ ...facts, content: 'a+b' }, options), 'words');
  assert.equal(filterViolation({ ...facts, content: '(BAD)' }, options), 'words');
  assert.equal(filterViolation({ ...facts, content: 'Hi 😀' }, { ...config, rules: ['emojis'] }), undefined);
  assert.equal(filterViolation({ ...facts, content: 'SHORT' }, { ...config, rules: ['caps'] }), undefined);
});
test('strikes escalate at explicit intervals and cap at ban', () => {
  assert.deepEqual([1, 3, 4, 6, 7, 10, 100].map(count => escalatedAction('delete', count, 3)), ['delete', 'delete', 'timeout', 'timeout', 'kick', 'ban', 'ban']);
  assert.equal(escalatedAction('timeout', 1, 3), 'timeout');
});
test('captcha emits a decodable RGB PNG and a nonce-bound normalized answer digest', () => {
  const captcha = createCaptcha();
  assert.match(captcha.answer, /^[AEFHJKMNRTXY2-9]{6}$/);
  assert.deepEqual(captcha.image.subarray(0, 8), Buffer.from([137,80,78,71,13,10,26,10]));
  const chunks: Buffer[] = [];
  for (let offset = 8; offset < captcha.image.length;) {
    const length = captcha.image.readUInt32BE(offset);
    const type = captcha.image.toString('ascii', offset + 4, offset + 8);
    const data = captcha.image.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') { assert.equal(data.readUInt32BE(0), 300); assert.equal(data.readUInt32BE(4), 90); }
    if (type === 'IDAT') chunks.push(data);
    offset += length + 12;
  }
  assert.equal(inflateSync(Buffer.concat(chunks)).length, (300 * 3 + 1) * 90);
  assert.equal(captchaDigest('nonce', captcha.answer), captchaDigest('nonce', ` ${captcha.answer.toLowerCase()} `));
  assert.notEqual(captchaDigest('nonce', captcha.answer), captchaDigest('other', captcha.answer));
});
