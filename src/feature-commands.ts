import { ChannelType, PermissionFlagsBits as P, SlashCommandBuilder } from 'discord.js';
const manager = (name: string, description: string) => new SlashCommandBuilder().setName(name).setDescription(description).setContexts(0).setDefaultMemberPermissions(P.ManageGuild);
const actionChoices = ['timeout', 'kick', 'ban'].map(value => ({ name: value, value }));
export const automodRules = ['invites', 'links', 'mentions', 'attachments', 'forwards', 'abuse', 'explicit-words', 'explicit-media', 'caps', 'emojis', 'words'] as const;
export const featureCommands = [
  manager('antinuke', 'Audit-log protection; configuration restricted to owner or delegated owners')
    .addSubcommand(s => s.setName('status').setDescription('Inspect audit protection'))
    .addSubcommand(s => s.setName('configure').setDescription('Configure protection against untrusted administrators')
      .addBooleanOption(o => o.setName('enabled').setDescription('Enable protection').setRequired(true))
      .addStringOption(o => o.setName('mode').setDescription('Alert only or ban untrusted actors').addChoices({ name: 'Alert only', value: 'alert' }, { name: 'Ban actor', value: 'ban' }))
      .addBooleanOption(o => o.setName('recovery').setDescription('Attempt recovery after successfully banning the actor'))),
  manager('extraowner', 'Owner-only management of delegated security owners')
    .addStringOption(o => o.setName('operation').setDescription('Action').setRequired(true).addChoices(...['add', 'remove', 'list'].map(value => ({ name: value, value }))))
    .addUserOption(o => o.setName('user').setDescription('Member to delegate or remove')),
  manager('trust', 'Manage security exceptions')
    .addStringOption(o => o.setName('feature').setDescription('Protection module').setRequired(true).addChoices(...['antinuke', 'raid', 'automod'].map(value => ({ name: value, value }))))
    .addStringOption(o => o.setName('operation').setDescription('Action').setRequired(true).addChoices(...['add', 'remove', 'list'].map(value => ({ name: value, value }))))
    .addStringOption(o => o.setName('kind').setDescription('Exception kind; roles/channels apply only to automod').addChoices(...['user', 'role', 'channel'].map(value => ({ name: value, value }))))
    .addStringOption(o => o.setName('id').setDescription('Discord ID of the user, role, or channel').setMinLength(17).setMaxLength(20)),
  manager('antiraid', 'Configure raid modules; joins and spam thresholds use /security')
    .addSubcommand(s => s.setName('status').setDescription('Inspect raid modules'))
    .addSubcommand(s => s.setName('configure').setDescription('Update raid filters; enable with /security configure')
      .addBooleanOption(o => o.setName('bot_filter').setDescription('Block untrusted bot accounts'))
      .addBooleanOption(o => o.setName('account_age_filter').setDescription('Apply minimum account age to every join'))
      .addStringOption(o => o.setName('action').setDescription('Raid response; bots are kicked when set to timeout').addChoices(...actionChoices))),
  manager('automod', 'Configure message filtering and strike escalation')
    .addSubcommand(s => s.setName('status').setDescription('Inspect filters'))
    .addSubcommand(s => s.setName('configure').setDescription('Enable or disable filtering')
      .addBooleanOption(o => o.setName('enabled').setDescription('Enable message filters').setRequired(true))
      .addStringOption(o => o.setName('action').setDescription('Base response').addChoices({ name: 'delete', value: 'delete' }, ...actionChoices))
      .addBooleanOption(o => o.setName('strikes').setDescription('Escalate response after repeated violations'))
      .addIntegerOption(o => o.setName('threshold').setDescription('Violations per escalation step (1–20)').setMinValue(1).setMaxValue(20)))
    .addSubcommand(s => s.setName('rule').setDescription('Toggle a filter')
      .addStringOption(o => o.setName('name').setDescription('Rule').setRequired(true).addChoices(...automodRules.map(value => ({ name: value, value }))))
      .addBooleanOption(o => o.setName('enabled').setDescription('Enable rule').setRequired(true)))
    .addSubcommand(s => s.setName('limits').setDescription('Tune filter limits')
      .addIntegerOption(o => o.setName('mentions').setDescription('Mentions in 10 seconds (2–50)').setMinValue(2).setMaxValue(50))
      .addIntegerOption(o => o.setName('attachments').setDescription('Attachments per message (1–10)').setMinValue(1).setMaxValue(10))
      .addIntegerOption(o => o.setName('caps_percent').setDescription('Uppercase percent (50–100), at least 12 letters').setMinValue(50).setMaxValue(100))
      .addIntegerOption(o => o.setName('emojis').setDescription('Emojis per message (3–100)').setMinValue(3).setMaxValue(100)))
    .addSubcommand(s => s.setName('filter').setDescription('Manage custom, abusive, or explicit word filters')
      .addStringOption(o => o.setName('category').setDescription('Word list').setRequired(true).addChoices(...['words', 'abuse', 'explicit-words'].map(value => ({ name: value, value }))))
      .addStringOption(o => o.setName('operation').setDescription('Action').setRequired(true).addChoices(...['add', 'remove', 'list'].map(value => ({ name: value, value }))))
      .addStringOption(o => o.setName('word').setDescription('Literal word or phrase (not a regular expression)').setMinLength(2).setMaxLength(60)))
    .addSubcommand(s => s.setName('history').setDescription('Recent automatic moderation records')
      .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true))),
  manager('verification', 'Configure captcha onboarding')
    .addSubcommand(s => s.setName('setup').setDescription('Post verification with an existing safe verified role')
      .addChannelOption(o => o.setName('channel').setDescription('Public verification channel').addChannelTypes(ChannelType.GuildText).setRequired(true))
      .addRoleOption(o => o.setName('role').setDescription('Verified role with no server management permissions').setRequired(true)))
    .addSubcommand(s => s.setName('protect').setDescription('Gate a currently public channel or synced category')
      .addChannelOption(o => o.setName('channel').setDescription('Public channel or category').addChannelTypes(ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildCategory, ChannelType.GuildAnnouncement).setRequired(true)))
    .addSubcommand(s => s.setName('status').setDescription('Inspect verification'))
    .addSubcommand(s => s.setName('disable').setDescription('Restore gated channel access and disable verification')),
  manager('logging', 'Configure moderation log delivery')
    .addBooleanOption(o => o.setName('enabled').setDescription('Enable or disable logs').setRequired(true))
    .addChannelOption(o => o.setName('channel').setDescription('Log channel when enabling').addChannelTypes(ChannelType.GuildText)),
  manager('autorole', 'Configure a safe role assigned after join or verification')
    .addBooleanOption(o => o.setName('enabled').setDescription('Enable automatic role assignment').setRequired(true))
    .addRoleOption(o => o.setName('role').setDescription('Role without management permissions')),
  new SlashCommandBuilder().setName('report').setDescription('Send a private member report to the moderation log').setContexts(0)
    .addUserOption(o => o.setName('user').setDescription('Reported user').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Report details').setRequired(true).setMaxLength(1000)),
  ...['stats', 'serverinfo', 'userinfo', 'avatar', 'banner'].map(name => {
    const command = new SlashCommandBuilder().setName(name).setDescription(`Show ${name === 'stats' ? 'Kuroo statistics' : name}`).setContexts(0);
    if (['userinfo', 'avatar', 'banner'].includes(name)) command.addUserOption(o => o.setName('user').setDescription('Member; defaults to you'));
    return command;
  }),
];
