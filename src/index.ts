import { installLogging } from './logging.js';
import { installAntinuke } from './antinuke.js';
import { installAutomod } from './automod.js';
import { Client, Events, GatewayIntentBits } from 'discord.js';
import mongoose from 'mongoose';
import { readConfig } from './config.js';
import { loadEmojis } from './ui.js';
import { allModels } from './models.js';
import { installInteractions } from './interactions.js';
import { installSecurity } from './security.js';
import { reportError } from './audit.js';

const config = readConfig();
loadEmojis(config.EMOJI_CONFIG_PATH);
mongoose.set('bufferCommands', false);
await mongoose.connect(config.MONGODB_URI, { serverSelectionTimeoutMS: 10_000, autoIndex: false });
// Unique indexes must exist before accepting ticket interactions.
await Promise.all(allModels.map(model => model.createIndexes()));
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildModeration, ...(config.MESSAGE_CONTENT_ENABLED === 'true' ? [GatewayIntentBits.MessageContent] : [])],
  allowedMentions: { parse: [] },
});
installInteractions(client);
installLogging(client);
const stopSecurity = installSecurity(client);
const stopAntinuke = installAntinuke(client);
const stopAutomod = installAutomod(client);
client.once(Events.ClientReady, ready => console.info(`Kuroo ready as ${ready.user.tag}; ${ready.guilds.cache.size} servers.`));
client.on(Events.Error, error => reportError('Discord client error', error));
mongoose.connection.on('error', error => reportError('Database error', error));
mongoose.connection.on('disconnected', () => console.error('Database disconnected; commands and automated actions require persistence.'));
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true; stopSecurity(); stopAntinuke(); stopAutomod(); client.destroy();
  await mongoose.disconnect();
}
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
try { await client.login(config.DISCORD_TOKEN); }
catch (error) { reportError('Discord login failed', error); await shutdown(); process.exitCode = 1; }
