import { REST, Routes } from 'discord.js';
import { readConfig } from './config.js';
import { commands } from './commands.js';
const config = readConfig();
await new REST().setToken(config.DISCORD_TOKEN).put(
  config.DISCORD_GUILD_ID ? Routes.applicationGuildCommands(config.DISCORD_CLIENT_ID, config.DISCORD_GUILD_ID) : Routes.applicationCommands(config.DISCORD_CLIENT_ID),
  { body: commands.map(command => command.toJSON()) },
);
console.info(`Registered ${commands.length} Kuroo commands (${config.DISCORD_GUILD_ID ? 'guild' : 'global'}).`);
