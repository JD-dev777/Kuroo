import { ApplicationCommandOptionType as T, type Guild, type User } from 'discord.js';
import { commands } from './commands.js';
import type { CommandOptions } from './command-context.js';
import { UserError } from './errors.js';

type Option = {
  type: number; name: string; required?: boolean; options?: Option[];
  min_length?: number; max_length?: number; min_value?: number; max_value?: number;
  choices?: { name: string; value: string | number }[]; channel_types?: number[];
};
const schemas = commands.map(command => command.toJSON());
export function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let value = '', quote = '', active = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;
    if (char === '\\' && (input[i + 1] === '"' || input[i + 1] === "'" || input[i + 1] === '\\')) {
      value += input[++i]; active = true;
    } else if (quote) {
      if (char === quote) quote = ''; else value += char;
    } else if (char === '"' || char === "'") { quote = char; active = true; }
    else if (/\s/.test(char)) {
      if (active) tokens.push(value);
      value = ''; active = false;
    } else { value += char; active = true; }
  }
  if (quote) throw new UserError('Close the quoted argument.');
  if (active) tokens.push(value);
  return tokens;
}
export function prefixBody(content: string, prefix: string, botId: string): string | null {
  const mention = new RegExp(`^<@!?${botId}>(?:\\s+|$)`).exec(content);
  if (mention) return content.slice(mention[0].length).trim();
  return content.startsWith(prefix) ? content.slice(prefix.length).trim() : null;
}
export function parsePrefix(input: string) {
  const tokens = tokenize(input);
  const name = tokens.shift()?.toLowerCase();
  const schema = schemas.find(command => command.name === name);
  if (!schema) return null;
  let options: Option[] = schema.options ?? [];
  let subcommand = '';
  if (options.some(option => option.type === T.Subcommand)) {
    subcommand = tokens[0] && !tokens[0].startsWith('--') ? tokens.shift()! : 'status';
    const selected = options.find(option => option.name === subcommand && option.type === T.Subcommand);
    if (!selected) throw new UserError(`Choose a subcommand: ${options.map(option => option.name).join(', ')}.`);
    options = selected.options ?? [];
  }
  const raw = new Map<string, string>();
  let named = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    let option: Option | undefined;
    let value: string;
    if (token.startsWith('--')) {
      named = true;
      option = options.find(item => item.name === token.slice(2));
      if (!option || raw.has(option.name)) throw new UserError(`Unknown or repeated option: ${token}.`);
      value = tokens[++i] ?? '';
      if (!value || value.startsWith('--')) throw new UserError(`Supply a value for ${token}.`);
    } else {
      if (named) throw new UserError('Place positional arguments before named options, or name every option.');
      option = options.find(item => !raw.has(item.name));
      if (!option) throw new UserError('Too many arguments. Quote text containing spaces.');
      value = token;
    }
    raw.set(option.name, value);
  }
  const values = new Map<string, string | number | boolean>();
  for (const option of options) {
    const value = raw.get(option.name);
    if (value === undefined) {
      if (option.required) throw new UserError(`Missing ${option.name}. Usage: ${schema.name}${subcommand ? ` ${subcommand}` : ''} ${options.map(item => `${item.required ? '<' : '['}${item.name}${item.required ? '>' : ']'}`).join(' ')}. Use --name value or quote text with spaces.`);
      continue;
    }
    let parsed: string | number | boolean = value;
    if (option.type === T.Integer) {
      if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new UserError(`${option.name} must be an integer.`);
      parsed = Number(value);
      if (parsed < (option.min_value ?? -Infinity) || parsed > (option.max_value ?? Infinity)) throw new UserError(`${option.name} is outside the allowed range.`);
    } else if (option.type === T.Boolean) {
      if (!['true', 'false'].includes(value.toLowerCase())) throw new UserError(`${option.name} must be true or false.`);
      parsed = value.toLowerCase() === 'true';
    } else if (option.type === T.String) {
      if (value.length < (option.min_length ?? 0) || value.length > (option.max_length ?? 6000)) throw new UserError(`${option.name} has an invalid length.`);
    } else {
      const id = /^(?:<@!?(\d{17,20})>|<@&(\d{17,20})>|<#(\d{17,20})>|(\d{17,20}))$/.exec(value);
      const target = option.type === T.User ? id?.[1] ?? id?.[4] : option.type === T.Role ? id?.[2] ?? id?.[4] : id?.[3] ?? id?.[4];
      if (!target) throw new UserError(`${option.name} must be a matching mention or Discord ID.`);
      parsed = target;
    }
    if (option.choices && !option.choices.some(choice => choice.value === parsed)) throw new UserError(`${option.name}: choose ${option.choices.map(choice => choice.value).join(', ')}.`);
    values.set(option.name, parsed);
  }
  return { name: schema.name, permission: schema.default_member_permissions, subcommand, options, values };
}
export type ParsedPrefix = NonNullable<ReturnType<typeof parsePrefix>>;
export async function resolvePrefixOptions(parsed: ParsedPrefix, guild: Guild): Promise<CommandOptions> {
  const users = new Map<string, User>();
  const roles = new Map<string, { id: string }>();
  const channels = new Map<string, { id: string }>();
  for (const option of parsed.options) {
    const id = parsed.values.get(option.name);
    if (typeof id !== 'string') continue;
    if (option.type === T.User) {
      const user = await guild.client.users.fetch(id).catch(() => null);
      if (!user) throw new UserError(`User ${option.name} could not be found.`);
      users.set(option.name, user);
    } else if (option.type === T.Role) {
      const role = await guild.roles.fetch(id).catch(() => null);
      if (!role) throw new UserError(`Role ${option.name} does not belong to this server.`);
      roles.set(option.name, role);
    } else if (option.type === T.Channel) {
      const channel = await guild.channels.fetch(id).catch(() => null);
      if (!channel || (option.channel_types && !option.channel_types.includes(channel.type))) throw new UserError(`Channel ${option.name} is unavailable or has the wrong type.`);
      channels.set(option.name, channel);
    }
  }
  function getter<V>(map: ReadonlyMap<string, unknown>, kind: (value: unknown) => value is V) {
    function get(name: string, required: true): V;
    function get(name: string, required?: boolean): V | null;
    function get(name: string, required = false): V | null {
      const value = map.get(name);
      if (kind(value)) return value;
      if (required) throw new UserError(`Missing ${name}.`);
      return null;
    }
    return get;
  }
  return {
    getString: getter(parsed.values, (v): v is string => typeof v === 'string'),
    getInteger: getter(parsed.values, (v): v is number => typeof v === 'number'),
    getBoolean: getter(parsed.values, (v): v is boolean => typeof v === 'boolean'),
    getUser: getter(users, (v): v is User => !!v),
    getRole: getter(roles, (v): v is { id: string } => !!v),
    getChannel: getter(channels, (v): v is { id: string } => !!v),
    getSubcommand: () => parsed.subcommand,
  };
}
