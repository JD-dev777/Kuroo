import { ChannelType, PermissionFlagsBits as P, SlashCommandBuilder } from 'discord.js';
const privileged = (name: string, description: string, permission: bigint) => new SlashCommandBuilder().setName(name).setDescription(description).setContexts(0).setDefaultMemberPermissions(permission);
export const extraModerationCommands = [
  privileged('unban', 'Unban a user by ID', P.BanMembers)
    .addStringOption(o => o.setName('id').setDescription('User ID').setRequired(true).setMinLength(17).setMaxLength(20))
    .addStringOption(o => o.setName('reason').setDescription('Audit reason').setRequired(true).setMaxLength(400)),
  privileged('untimeout', 'Remove a member timeout', P.ModerateMembers)
    .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Audit reason').setRequired(true).setMaxLength(400)),
  privileged('nickname', 'Set or clear a nickname', P.ManageNicknames)
    .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true))
    .addStringOption(o => o.setName('name').setDescription('New nickname; omit to clear').setMaxLength(32)),
  privileged('role', 'Add or remove an individual role', P.ManageRoles)
    .addStringOption(o => o.setName('operation').setDescription('Action').setRequired(true).addChoices({ name: 'Add', value: 'add' }, { name: 'Remove', value: 'remove' }))
    .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true))
    .addRoleOption(o => o.setName('role').setDescription('Role').setRequired(true)),
  privileged('channel', 'Lock, unlock, hide, or restore a channel', P.ManageChannels)
    .addStringOption(o => o.setName('operation').setDescription('Action').setRequired(true).addChoices(...['lock', 'unlock', 'hide', 'unhide'].map(value => ({ name: value, value }))))
    .addChannelOption(o => o.setName('channel').setDescription('Defaults to current channel').addChannelTypes(ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildCategory, ChannelType.GuildAnnouncement))
    .addBooleanOption(o => o.setName('all').setDescription('Apply to all text channels after confirmation')),
  privileged('purgebots', 'Remove bot messages from recent history', P.ManageMessages)
    .addIntegerOption(o => o.setName('count').setDescription('Number of recent messages to inspect (1–100)').setRequired(true).setMinValue(1).setMaxValue(100)),
  privileged('role-members', 'List members holding a role', P.ManageRoles)
    .addRoleOption(o => o.setName('role').setDescription('Role').setRequired(true)),
];
