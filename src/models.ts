import mongoose, { Schema } from 'mongoose';

const settingsSchema = new Schema({
  guildId: { type: String, required: true, unique: true },
  logChannelId: String,
  ticketCategoryId: String,
  staffRoleId: String,
  securityEnabled: { type: Boolean, default: false },
  joinLimit: { type: Number, default: 8, min: 3, max: 50 },
  joinWindowSeconds: { type: Number, default: 15, min: 5, max: 120 },
  minAccountAgeHours: { type: Number, default: 24, min: 0, max: 720 },
  spamLimit: { type: Number, default: 6, min: 3, max: 30 },
}, { timestamps: true });
export const Settings = mongoose.model('Settings', settingsSchema);
const caseSchema = new Schema({
  guildId: { type: String, required: true, index: true },
  targetId: { type: String, required: true },
  actorId: { type: String, required: true },
  action: { type: String, required: true },
  reason: { type: String, required: true },
  outcome: { type: String, enum: ['pending', 'succeeded', 'failed'], default: 'pending' },
}, { timestamps: true });
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
