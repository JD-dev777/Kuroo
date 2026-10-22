import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_CLIENT_ID: z.string().regex(/^\d{17,20}$/),
  DISCORD_GUILD_ID: z.string().regex(/^\d{17,20}$/).optional(),
  MONGODB_URI: z.string().regex(/^mongodb(?:\+srv)?:\/\//),
  MESSAGE_CONTENT_ENABLED: z.enum(['true', 'false']).default('false'),
  EMOJI_CONFIG_PATH: z.string().default('./config/emojis.json'),
});
export function readConfig() {
  const result = schema.safeParse({ ...process.env, DISCORD_GUILD_ID: process.env.DISCORD_GUILD_ID || undefined });
  if (!result.success) {
    // Report field names only: validation details can contain secrets.
    throw new Error(`Invalid environment configuration: ${result.error.issues.map(i => i.path.join('.')).join(', ')}`);
  }
  return result.data;
}
