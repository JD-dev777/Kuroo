import type { ChatInputCommandInteraction, InteractionEditReplyOptions, User } from 'discord.js';

type Getter<T> = { (name: string, required: true): T; (name: string, required?: boolean): T | null };
export interface CommandOptions {
  getString: Getter<string>;
  getInteger: Getter<number>;
  getBoolean: Getter<boolean>;
  getUser: Getter<User>;
  getRole: Getter<{ id: string }>;
  getChannel: Getter<{ id: string }>;
  getSubcommand(): string;
}
export type CommandContext = Pick<ChatInputCommandInteraction,
  'commandName' | 'guild' | 'guildId' | 'channel' | 'channelId' | 'user' | 'client'> & {
  options: CommandOptions;
  editReply(options: InteractionEditReplyOptions): Promise<unknown>;
};
