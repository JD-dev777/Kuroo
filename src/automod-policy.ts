export interface FilterConfig {
  rules: readonly string[]; words: readonly string[]; abuseWords: readonly string[]; explicitWords: readonly string[];
  mentionLimit: number; attachmentLimit: number; capsPercent: number; emojiLimit: number;
}
export interface MessageFacts {
  content: string; mentions: number; everyone: boolean; attachments: number; forwarded: boolean; explicitMedia: boolean;
}
function containsWord(content: string, words: readonly string[]) {
  const normalized = content.normalize('NFKC').toLocaleLowerCase('en-US');
  return words.some(word => {
    const literal = word.normalize('NFKC').toLocaleLowerCase('en-US').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|[^\\p{L}\\p{N}_])${literal}(?=$|[^\\p{L}\\p{N}_])`, 'u').test(normalized);
  });
}
export function filterViolation(facts: MessageFacts, config: FilterConfig): string | undefined {
  const enabled = new Set(config.rules);
  if (enabled.has('invites') && /(?:discord\.gg|discord(?:app)?\.com\/invite)\/[\w-]+/i.test(facts.content)) return 'invites';
  if (enabled.has('links') && /(?:https?:\/\/|www\.)\S+/i.test(facts.content)) return 'links';
  if (enabled.has('mentions') && (facts.everyone || facts.mentions >= config.mentionLimit)) return 'mentions';
  if (enabled.has('attachments') && facts.attachments >= config.attachmentLimit) return 'attachments';
  if (enabled.has('forwards') && facts.forwarded) return 'forwards';
  if (enabled.has('explicit-media') && facts.explicitMedia) return 'explicit-media';
  for (const [rule, words] of [['words', config.words], ['abuse', config.abuseWords], ['explicit-words', config.explicitWords]] as const) {
    if (enabled.has(rule) && containsWord(facts.content, words)) return rule;
  }
  const letters = facts.content.match(/[a-z]/gi) ?? [];
  if (enabled.has('caps') && letters.length >= 12 && letters.filter(char => char === char.toUpperCase()).length / letters.length * 100 >= config.capsPercent) return 'caps';
  const emojis = facts.content.match(/<a?:\w+:\d+>|\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?)*|[\p{Regional_Indicator}]{2}/gu) ?? [];
  if (enabled.has('emojis') && emojis.length >= config.emojiLimit) return 'emojis';
}
export function escalatedAction(base: string, count: number, threshold: number) {
  const actions = ['delete', 'timeout', 'kick', 'ban'];
  return actions[Math.min(3, Math.max(0, actions.indexOf(base)) + Math.floor(Math.max(0, count - 1) / threshold))]!;
}
