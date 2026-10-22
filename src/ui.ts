import { readFileSync } from 'node:fs';
import { ActionRowBuilder, ButtonBuilder, ContainerBuilder, MessageFlags, TextDisplayBuilder } from 'discord.js';

export type EmojiMap = Record<string, string>;
export function parseEmojis(raw: unknown): EmojiMap {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Emoji configuration must be an object.');
  const entries = Object.entries(raw);
  for (const [key, value] of entries) {
    if (!/^[a-z][a-z0-9_]*$/.test(key) || typeof value !== 'string' || value.length === 0 || value.length > 64 || /[\r\n]/.test(value)) {
      throw new Error(`Invalid emoji configuration entry: ${key}`);
    }
    if (value.startsWith('<') && !/^<a?:\w{2,32}:\d{17,20}>$/.test(value)) throw new Error(`Invalid custom emoji: ${key}`);
  }
  return Object.fromEntries(entries);
}
let emojis: EmojiMap = {};
export function loadEmojis(path: string) { emojis = parseEmojis(JSON.parse(readFileSync(path, 'utf8'))); }
export function renderEmojis(text: string, map: EmojiMap = emojis) {
  return text.replace(/\{emoji:([a-z][a-z0-9_]*)\}/g, (placeholder, key: string) => map[key] ?? placeholder);
}
export function panel(title: string, body: string, buttons: ButtonBuilder[] = []) {
  const container = new ContainerBuilder().setAccentColor(0x9b59b6)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(renderEmojis(`## ${title}\n${body}`)));
  if (buttons.length) container.addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons));
  return { components: [container], flags: MessageFlags.IsComponentsV2 as const, allowedMentions: { parse: [] as never[] } };
}
export function privatePanel(title: string, body: string, buttons: ButtonBuilder[] = []) {
  const result = panel(title, body, buttons);
  return { ...result, flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral };
}
