import { randomBytes } from 'node:crypto';
import {
  ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonInteraction, ButtonStyle, ChatInputCommandInteraction,
  MediaGalleryBuilder, MediaGalleryItemBuilder, ModalBuilder, ModalSubmitInteraction, PermissionFlagsBits as P,
  TextInputBuilder, TextInputStyle, GuildMember,
} from 'discord.js';
import { Challenge, getSettings, Settings, VerificationGate } from './models.js';
import { createCaptcha, captchaDigest } from './captcha.js';
import { panel, privatePanel } from './ui.js';
import { UserError } from './errors.js';
import { safeAssignableRole } from './permissions.js';
import { recordedAction } from './actions.js';
import { safeAudit } from './audit.js';
const configuring = new Set<string>();
export async function assignJoinRole(member: GuildMember) {
  if (member.user.bot) return;
  const settings = await getSettings(member.guild.id);
  if (!settings.autoroleId || settings.verification?.enabled) return;
  const role = await safeAssignableRole(member.guild, settings.autoroleId);
  const me = await member.guild.members.fetchMe();
  await recordedAction(member.guild, me.id, member.id, 'autorole', `Assign role ${role.id}`, () => member.roles.add(role, 'Kuroo autorole'), `autorole:${member.id}:${member.joinedTimestamp}`);
}
export async function configureVerification(interaction: ChatInputCommandInteraction) {
  const guild = interaction.guild!;
  const actor = await guild.members.fetch(interaction.user.id);
  if (!actor.permissions.has([P.ManageGuild, P.ManageChannels, P.ManageRoles])) throw new UserError('Manage Server, Manage Channels, and Manage Roles permissions are required.');
  if (configuring.has(guild.id)) throw new UserError('Verification is already being configured.');
  configuring.add(guild.id);
  try {
    const settings = await getSettings(guild.id);
    const sub = interaction.options.getSubcommand();
    if (sub === 'setup') {
      if (settings.verification?.enabled || await VerificationGate.exists({ guildId: guild.id })) throw new UserError('Disable and restore existing verification before reconfiguring.');
      const role = await safeAssignableRole(guild, interaction.options.getRole('role', true).id);
      if (settings.autoroleId === role.id) throw new UserError('The verified role must be different from the autorole.');
      const channel = await guild.channels.fetch(interaction.options.getChannel('channel', true).id);
      const me = await guild.members.fetchMe();
      if (!channel?.isSendable() || !channel.permissionsFor(guild.roles.everyone)?.has(P.ViewChannel) || !channel.permissionsFor(me)?.has([P.ViewChannel, P.SendMessages, P.AttachFiles])) throw new UserError('Choose a public text channel where Kuroo can send messages and attach files.');
      await Settings.updateOne({ guildId: guild.id }, { $set: { verification: { enabled: true, channelId: channel.id, roleId: role.id } } });
      try {
        await channel.send(panel('{emoji:shield} Verify to join', 'Complete the image challenge to receive the verified role. If you need an accessible alternative, contact server staff.', [new ButtonBuilder().setCustomId('verify:start').setLabel('Verify').setStyle(ButtonStyle.Success)]));
      } catch (error) {
        await Settings.updateOne({ guildId: guild.id }, { $set: { 'verification.enabled': false } });
        throw error;
      }
      await interaction.editReply(privatePanel('{emoji:success} Verification ready', `Panel posted in <#${channel.id}>. Use /verification protect to gate public channels or synced categories. Existing private channels keep their access rules.`));
      return;
    }
    if (sub === 'protect') {
      if (!settings.verification?.enabled || !settings.verification.roleId) throw new UserError('Set up verification first.');
      const channel = await guild.channels.fetch(interaction.options.getChannel('channel', true).id);
      const me = await guild.members.fetchMe();
      if (!channel || channel.isThread() || !('permissionOverwrites' in channel) || channel.id === settings.verification.channelId || channel.id === settings.logChannelId) throw new UserError('Choose a public channel or category other than verification and logs.');
      const verificationChannel = settings.verification.channelId ? await guild.channels.fetch(settings.verification.channelId) : null;
      const logChannel = settings.logChannelId ? await guild.channels.fetch(settings.logChannelId) : null;
      if (verificationChannel?.parentId === channel.id || logChannel?.parentId === channel.id) throw new UserError('This category contains verification or logs. Protect its other channels individually.');
      if (guild.roles.everyone.permissions.has(P.Administrator)) throw new UserError('@everyone has Administrator and cannot be gated.');
      if (!channel.permissionsFor(guild.roles.everyone)?.has(P.ViewChannel) || !channel.permissionsFor(me)?.has([P.ManageRoles, P.ViewChannel]) || !channel.permissionsFor(actor)?.has([P.ManageChannels, P.ManageRoles, P.ViewChannel])) throw new UserError('The channel must be public, and Kuroo needs Manage Roles and View Channel there.');
      const everyone = channel.permissionOverwrites.cache.get(guild.id);
      const role = channel.permissionOverwrites.cache.get(settings.verification.roleId);
      const bot = channel.permissionOverwrites.cache.get(me.id);
      const serialized = (value: typeof everyone) => value ? { allow: value.allow.bitfield.toString(), deny: value.deny.bitfield.toString() } : null;
      try { await VerificationGate.create({ guildId: guild.id, channelId: channel.id, roleId: settings.verification.roleId, botId: me.id, everyone: serialized(everyone), role: serialized(role), bot: serialized(bot) }); }
      catch (error) { if ((error as { code?: number }).code === 11000) throw new UserError('This channel is already protected.'); throw error; }
      // Persist both original overwrites before any permission changes, including partial failure.
      await channel.permissionOverwrites.edit(me.id, { ViewChannel: true }, { reason: 'Kuroo verification access' });
      await channel.permissionOverwrites.edit(settings.verification.roleId, { ViewChannel: true }, { reason: 'Kuroo verification gate' });
      await channel.permissionOverwrites.edit(guild.id, { ViewChannel: false }, { reason: 'Kuroo verification gate' });
      await interaction.editReply(privatePanel('{emoji:lock} Channel gated', `<#${channel.id}> now requires the verified role. Other role/member overrides and Administrator can still grant access; review them in Discord.`));
      return;
    }
    if (sub === 'disable') {
      const me = await guild.members.fetchMe();
      for (const gate of await VerificationGate.find({ guildId: guild.id })) {
        const channel = await guild.channels.fetch(gate.channelId).catch(error => { if (error.code === 10003) return null; throw error; });
        if (channel && !channel.isThread() && 'permissionOverwrites' in channel) {
          if (!channel.permissionsFor(me)?.has([P.ManageRoles, P.ViewChannel])) throw new UserError('Kuroo cannot restore a gated channel. Restore its access and retry.');
          // Restore just our ViewChannel bit, preserving unrelated permission edits.
          for (const [id, before] of [[guild.id, gate.everyone], [gate.roleId, gate.role], [gate.botId ?? me.id, gate.bot]] as const) {
            const current = channel.permissionOverwrites.cache.get(id);
            const expected = id === guild.id ? false : true;
            const currentBit = current?.allow.has(P.ViewChannel) ? true : current?.deny.has(P.ViewChannel) ? false : null;
            if (currentBit !== expected) continue; // Keep manual edits made since protection.
            const original = before ? (BigInt(before.allow) & P.ViewChannel) !== 0n ? true : (BigInt(before.deny) & P.ViewChannel) !== 0n ? false : null : null;
            await channel.permissionOverwrites.edit(id, { ViewChannel: original }, { reason: 'Kuroo verification disabled' });
          }
        }
        await gate.deleteOne();
      }
      await Settings.updateOne({ guildId: guild.id }, { $set: { 'verification.enabled': false } });
      await Challenge.deleteMany({ guildId: guild.id });
      await interaction.editReply(privatePanel('{emoji:success} Verification disabled', 'Gated View Channel permissions were restored. The existing verified role, memberships, and panel remain; the panel is inactive.'));
      return;
    }
    await interaction.editReply(privatePanel('{emoji:shield} Verification', `Enabled: **${settings.verification?.enabled ?? false}**\nChannel: ${settings.verification?.channelId ? `<#${settings.verification.channelId}>` : 'Unset'}\nGated channels: ${await VerificationGate.countDocuments({ guildId: guild.id })}`));
  } finally { configuring.delete(guild.id); }
}
export function verificationModal(interaction: ButtonInteraction) {
  const nonce = interaction.customId.slice('verify:enter:'.length);
  if (!/^[a-f0-9]{24}$/.test(nonce)) throw new UserError('Invalid verification control.');
  return interaction.showModal(new ModalBuilder().setCustomId(`verify:answer:${nonce}`).setTitle('Kuroo verification').addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('answer').setLabel('Enter the six image characters').setStyle(TextInputStyle.Short).setMinLength(6).setMaxLength(6).setRequired(true)),
  ));
}
export async function handleVerification(interaction: ButtonInteraction | ModalSubmitInteraction) {
  const guild = interaction.guild!;
  const settings = await getSettings(guild.id);
  if (!settings.verification?.enabled || !settings.verification.roleId) throw new UserError('Verification is disabled.');
  const member = await guild.members.fetch(interaction.user.id);
  const role = await safeAssignableRole(guild, settings.verification.roleId);
  if (member.roles.cache.has(role.id)) throw new UserError('You are already verified.');
  if (interaction.isButton()) {
    if (interaction.customId !== 'verify:start') throw new UserError('Unknown verification button.');
    const { answer, image } = createCaptcha();
    const nonce = randomBytes(12).toString('hex');
    await Challenge.findOneAndUpdate({ guildId: guild.id, userId: member.id }, { nonce, digest: captchaDigest(nonce, answer), expiresAt: new Date(Date.now() + 300_000) }, { upsert: true });
    const payload = privatePanel('{emoji:shield} Verification challenge', 'Read the image, then select Enter code. This code expires in 5 minutes; each answer attempt consumes it.', [new ButtonBuilder().setCustomId(`verify:enter:${nonce}`).setLabel('Enter code').setStyle(ButtonStyle.Primary)]);
    payload.components[0]!.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL('attachment://captcha.png')));
    await interaction.editReply({ ...payload, files: [new AttachmentBuilder(image, { name: 'captcha.png' })] });
    return;
  }
  const nonce = interaction.customId.slice('verify:answer:'.length);
  // Atomic consumption binds a single attempt to a member, guild, nonce, and expiry.
  const challenge = await Challenge.findOneAndDelete({ guildId: guild.id, userId: member.id, nonce, expiresAt: { $gt: new Date() } });
  if (!challenge || challenge.digest !== captchaDigest(nonce, interaction.fields.getTextInputValue('answer'))) throw new UserError('Incorrect or expired code. Select Verify to request another challenge.');
  await recordedAction(guild, guild.client.user.id, member.id, 'verification', `Grant verified role ${role.id}`, () => member.roles.add(role, 'Kuroo captcha completed'));
  if (settings.autoroleId) {
    const autorole = await safeAssignableRole(guild, settings.autoroleId);
    await recordedAction(guild, guild.client.user.id, member.id, 'autorole', `Assign role ${autorole.id}`, () => member.roles.add(autorole, 'Kuroo verified autorole'));
  }
  await interaction.editReply(privatePanel('{emoji:success} Verified', 'Your verified role has been assigned.'));
  await safeAudit(guild, 'Member verified', `<@${member.id}> completed the verification challenge.`);
}
