import mongoose, { Schema } from 'mongoose';

const settingsSchema = new Schema({
  guildId: { type: String, required: true, unique: true },
  prefix: { type: String, default: '!', match: /^[a-zA-Z0-9!?.$%&*+=:;,_~-]{1,8}$/ },
  logChannelId: String,
  ticketCategoryId: String,
  staffRoleId: String,
  securityEnabled: { type: Boolean, default: false },
  joinLimit: { type: Number, default: 8, min: 3, max: 50 },
  joinWindowSeconds: { type: Number, default: 15, min: 5, max: 120 },
  minAccountAgeHours: { type: Number, default: 24, min: 0, max: 720 },
  antinuke: {
    enabled: { type: Boolean, default: false },
    mode: { type: String, enum: ['alert', 'ban'], default: 'alert' },
    recovery: { type: Boolean, default: false },
  },
  extraOwners: { type: [String], default: [] },
  trustedUsers: { type: [String], default: [] },
  raidTrustedUsers: { type: [String], default: [] },
  raid: {
    botFilter: { type: Boolean, default: false },
    accountAgeFilter: { type: Boolean, default: false },
    action: { type: String, enum: ['timeout', 'kick', 'ban'], default: 'timeout' },
  },
  automod: {
    enabled: { type: Boolean, default: false },
    action: { type: String, enum: ['delete', 'timeout', 'kick', 'ban'], default: 'delete' },
    strikes: { type: Boolean, default: false },
    strikeThreshold: { type: Number, default: 3, min: 1, max: 20 },
    rules: { type: [String], default: ['invites', 'mentions', 'attachments', 'forwards', 'explicit-media'] },
    mentionLimit: { type: Number, default: 5, min: 2, max: 50 },
    attachmentLimit: { type: Number, default: 5, min: 1, max: 10 },
    capsPercent: { type: Number, default: 75, min: 50, max: 100 },
    emojiLimit: { type: Number, default: 10, min: 3, max: 100 },
    words: { type: [String], default: [] },
    abuseWords: { type: [String], default: [] },
    explicitWords: { type: [String], default: [] },
    users: { type: [String], default: [] },
    roles: { type: [String], default: [] },
    channels: { type: [String], default: [] },
  },
  verification: { enabled: { type: Boolean, default: false }, channelId: String, roleId: String },
  autoroleId: String,
  spamLimit: { type: Number, default: 6, min: 3, max: 30 },
}, { timestamps: true });
export const Settings = mongoose.model('Settings', settingsSchema);
const caseSchema = new Schema({
  guildId: { type: String, required: true, index: true },
  targetId: { type: String, required: true },
  actorId: { type: String, required: true },
  action: { type: String, required: true },
  reason: { type: String, required: true },
  sourceId: String,
  outcome: { type: String, enum: ['pending', 'succeeded', 'failed'], default: 'pending' },
}, { timestamps: true });
caseSchema.index({ guildId: 1, sourceId: 1 }, { unique: true, partialFilterExpression: { sourceId: { $type: 'string' } } });
export const ModCase = mongoose.model('ModCase', caseSchema);
const ticketSchema = new Schema({
  guildId: { type: String, required: true },
  ownerId: { type: String, required: true },
  channelId: String,
  status: { type: String, enum: ['creating', 'open', 'closed'], required: true },
}, { timestamps: true });
// One active ticket per user, including the channel creation window.
ticketSchema.index({ guildId: 1, ownerId: 1 }, { unique: true, partialFilterExpression: { status: { $in: ['creating', 'open'] } } });
export const Ticket = mongoose.model('Ticket', ticketSchema);
export async function getSettings(guildId: string) {
  // Avoid duplicate-key races when two first events arrive together.
  try { return await Settings.findOneAndUpdate({ guildId }, { $setOnInsert: { guildId } }, { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }); }
  catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
    return Settings.findOne({ guildId }).orFail();
  }
}

const strikeSchema = new Schema({
  guildId: { type: String, required: true }, userId: { type: String, required: true },
  count: { type: Number, default: 0 }, expiresAt: { type: Date, required: true },
});
strikeSchema.index({ guildId: 1, userId: 1 }, { unique: true });
strikeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const Strike = mongoose.model('Strike', strikeSchema);
const challengeSchema = new Schema({
  guildId: { type: String, required: true }, userId: { type: String, required: true },
  nonce: { type: String, required: true }, digest: { type: String, required: true },
  expiresAt: { type: Date, required: true },
});
challengeSchema.index({ guildId: 1, userId: 1 }, { unique: true });
challengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const Challenge = mongoose.model('Challenge', challengeSchema);
const snapshotSchema = new Schema({
  guildId: { type: String, required: true }, targetId: { type: String, required: true },
  kind: { type: String, enum: ['channel', 'role'], required: true },
  data: { type: Schema.Types.Mixed, required: true },
}, { timestamps: true });
snapshotSchema.index({ guildId: 1, targetId: 1 }, { unique: true });
export const Snapshot = mongoose.model('Snapshot', snapshotSchema);
const gateSchema = new Schema({
  guildId: { type: String, required: true }, channelId: { type: String, required: true },
  roleId: { type: String, required: true }, botId: String, everyone: Schema.Types.Mixed, role: Schema.Types.Mixed, bot: Schema.Types.Mixed,
});
gateSchema.index({ guildId: 1, channelId: 1 }, { unique: true });
export const VerificationGate = mongoose.model('VerificationGate', gateSchema);
const channelStateSchema = new Schema({
  guildId: { type: String, required: true }, channelId: { type: String, required: true },
  permission: { type: String, enum: ['SendMessages', 'ViewChannel'], required: true },
  previous: { type: Boolean, default: null },
  botPrevious: { type: Boolean, default: null },
});
channelStateSchema.index({ guildId: 1, channelId: 1, permission: 1 }, { unique: true });
export const ChannelState = mongoose.model('ChannelState', channelStateSchema);
export const allModels = [Settings, ModCase, Ticket, Strike, Challenge, Snapshot, VerificationGate, ChannelState];
