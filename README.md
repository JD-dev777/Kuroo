# Kuroo

A Discord bot built with TypeScript, discord.js, MongoDB, and **Components V2**. Kuroo includes audit protection, raid defense, automod, verification, moderation, utilities, and private support tickets. See the [AeroX reference and feature guide](docs/aerox-reference.md) for command mappings and behavior.

## Features

- Audit-log protection with owner-managed trust lists, alert/ban modes, and optional partial recovery.
- Message filters with persistent strike escalation and user/role/channel exemptions.
- PNG captcha verification, persistent channel access snapshots, and safe automatic roles.
- Join surge detection and message flood protection with configurable thresholds and automatic 10 minute timeouts.
- Ban, kick, timeout, warnings, recent message cleanup, and moderation history.
- MongoDB settings, moderation records, and ticket reservations with unique indexes.
- Private support channels with staff access and a confirmation before deletion.
- Components V2 containers, text displays, and buttons. Bot replies suppress mentions.
- Manual custom emoji mapping through `{emoji:name}` placeholders, with Unicode defaults.
- Live permission checks, role hierarchy checks, shared per-user action limits, and private slash-command responses.

## Requirements

- Node.js 24 or newer and npm.
- MongoDB 7 or newer (local installation or Atlas); the database user needs permission to create collections and indexes.
- A Discord application and bot from the [Developer Portal](https://discord.com/developers/applications).

## Setup

```sh
npm ci
cp .env.example .env
```

Fill in `.env` with the bot token, application ID, and MongoDB URI. Set `DISCORD_GUILD_ID` to a test server for immediate command registration; omit it when deploying global commands. Global command updates can take time to propagate. Remove old guild commands separately when switching to global registration to avoid duplicates. Never commit `.env` or tokens.

Enable **Server Members Intent** in the Developer Portal. Basic spam protection does not need Message Content Intent. For prefix commands and content-based automod, enable **Message Content Intent** in the portal and set `MESSAGE_CONTENT_ENABLED=true` in `.env`, then restart. The gateway also requests Guild Moderation events for audit protection.

Install the bot with the `bot` and `applications.commands` scopes. Grant these permissions where the corresponding features are used:

- View Channels, Send Messages, Read Message History
- Moderate Members, Kick Members, Ban Members, Manage Messages
- View Audit Log for audit protection and audit event logging
- Attach Files for captcha verification
- Manage Channels and Manage Roles (for ticket permission overwrites)
- Use External Emojis if configured emojis come from another accessible server

Place Kuroo’s role above members it should moderate and above the configured ticket staff role. Administrator permission is unnecessary. Privileged commands are restricted by default and recheck current member permissions when executed.

```sh
npm run deploy
npm run build
npm start
```

For development: `npm run dev`. Run exactly one Kuroo process for each bot token. Rate limits and join/spam windows are local to the process and reset on restart; MongoDB records and settings persist.

## Server configuration

1. Create a private moderation log channel.
2. Run `/setup logs:#mod-logs ticket_category:Support staff:@Support`.
3. Run `/security configure enabled:true` to opt into automatic moderation.
4. Run `/ticket-panel` in a public support channel.
5. Configure `/antinuke` in alert mode, `/automod`, and `/verification` as described in the [feature guide](docs/aerox-reference.md). All new automations start disabled. Re-run `npm run deploy` when updating commands.
6. Inspect `/security status` and test permissions in a staging server before wider use.

Default security settings: 8 joins within 15 seconds activates a 60 second surge window. Accounts younger than 24 hours joining from the threshold onward receive the configured raid response (default: 10 minute timeout). Every further qualifying join extends the surge window. Message flood protection times out a member at 6 messages within 5 seconds across channels. Earlier joins are not retrospectively timed out. Accounts older than the configured minimum are unaffected by join protection. Server managers, moderators, owners, and members the bot cannot moderate are exempt from raid timeouts and automod; audit protection has its own stricter trust list. Bot accounts are exempt from spam timeouts. The optional raid bot filter can kick or ban untrusted bots; approve them with `/trust feature:raid`.

The bot must have a functioning database to act; it records moderation intent before applying a timeout, kick, ban, or purge. Cases track `pending`, `succeeded`, and `failed`. A crash or database failure during a Discord action can leave a pending case; check Discord’s audit log before retrying. Log delivery failures are recorded on stderr without undoing an already completed action. Settings may take up to five seconds to refresh for automated protection.

## Commands

| Command | Required member permission | Purpose |
| --- | --- | --- |
| `/help`, `/ping` | Everyone | Command guide and connection status |
| `/ban`, `/kick` | Ban Members / Kick Members | Remove a current member with an audit reason |
| `/timeout` | Moderate Members | Timeout for 1–40320 minutes |
| `/warn` | Moderate Members | Record a warning; does not DM or punish the member |
| `/cases` | Moderate Members | Last ten records with reason excerpts |
| `/purge` | Manage Messages | Delete up to 100 recent messages younger than 14 days |
| `/setup` | Manage Server | Configure logs, ticket category, and staff role |
| `/security status`, `/security configure` | Manage Server | Inspect or update automated protection |
| `/ticket-panel` | Manage Server | Post a persistent ticket opening button |

Ticket owners, configured staff, and members with Manage Channels can close tickets. Server administrators can access private channels through Discord’s permission model. Closing permanently deletes the channel; transcripts are not stored. Ticket channel overwrites are explicitly set and do not inherit category access. Messages support text by default; grant other ticket permissions deliberately.

A crash during ticket creation can leave a `creating` reservation, or an open record whose channel was manually deleted. An administrator should inspect the channel and matching `tickets` database document before changing its status to `closed`; never release a reservation while its private channel still needs attention. Repost ticket panels with `/ticket-panel` if deleted. Buttons on existing panels survive restarts.

For the expanded security, automod, verification, moderation, logging, and utility commands, see the [full feature guide](docs/aerox-reference.md). Channel operations need both Manage Channels and Manage Roles and preserve original @everyone settings for restoration.

## Prefix and hybrid commands

Every slash command also works with a server prefix or a bot mention when `MESSAGE_CONTENT_ENABLED=true` and **Message Content Intent** is enabled in the Developer Portal. Restart after enabling it. Prefix support is off by default; slash commands remain available.

The default prefix is `!`. Server managers can view or change it with `/prefix [value]` or `!prefix ?`. Prefixes are stored per server in MongoDB and accept 1–8 letters, numbers, or the punctuation listed by `/prefix`.

```text
!help
!ping
!ban @member "Repeated spam"
!timeout --user @member --minutes 10 --reason "Repeated spam"
!security configure --enabled true --spam_limit 5
!channel --operation lock --all true
@Kuroo serverinfo
```

Use the slash command's option order for positional arguments, or `--name value` for named arguments. Put positional arguments before named options. Quote text containing spaces; booleans accept `true` or `false`. User, role, and channel arguments accept matching mentions or IDs. Omitting a subcommand selects `status` where available. Arguments, choices, limits, current permissions, role hierarchy, and action cooldowns are shared with slash commands. Run `npm run deploy` after this update to register `/prefix`.

Prefix invocations are visible in the source channel. Ordinary responses and channel confirmation buttons are public. Moderation history, trust lists, delegated owners, reports, and automod history/filter results are sent by DM; if DMs are closed, the command stops without exposing results. Use `/report` for a private submission because a prefix report's input is public. Slash replies and verification challenges remain private. Prefix commands do not bypass automod or flood protection.

## Custom emojis

Edit `config/emojis.json` (or set `EMOJI_CONFIG_PATH`) and restart:

```json
{
  "shield": "<:kuroo_shield:123456789012345678>",
  "success": "<a:kuroo_success:123456789012345679>",
  "error": "❌",
  "warning": "⚠️",
  "ticket": "🎫",
  "lock": "🔒",
  "wave": "👋"
}
```

Use actual emoji IDs from a server accessible to Kuroo. `{emoji:shield}` and `{emoji:success}` in bot UI strings are replaced at render time. Unknown placeholders remain visible to make missing configuration discoverable. This mapping changes Kuroo’s UI; it does not rewrite member messages. Invalid configuration stops startup. The 32-key catalogue covers panels, help categories, and action buttons. Buttons use the same configured custom emoji (static or animated) alongside readable labels. Partial configuration files inherit Unicode defaults for omitted keys. Each value must be one Unicode emoji or valid Discord custom emoji markup; invalid entries stop startup.

## Validation and operations

```sh
npm run check
npm test
npm run build
npm audit --omit=dev
```

Tests cover prefix parsing and persistence, shared permissions and cooldowns, private prefix delivery, emoji buttons and rendering, Components V2 payloads, command registration schemas, MongoDB indexes, concurrent ticket reservations, failed moderation persistence, and ticket cleanup. Database tests use an ephemeral real MongoDB process through `mongodb-memory-server` and may download its binary on first run. No Discord token is needed for tests. Live Discord gateway, permission behavior, and rendering still require a test server.

Use a process supervisor for production and keep secrets in a secret manager or protected environment file. Back up MongoDB and restrict its network access. The bot logs only limited error metadata. Optional audit protection can contain untrusted administrators below Kuroo and perform partial restoration; see the recovery limits in the feature guide. It does not guarantee prevention of server destruction, restore deleted message history, classify image content itself, or coordinate rate limits across processes. Discord timeouts cannot affect administrators or members above Kuroo. Tune thresholds to your community; legitimate bursts can trigger protection.

Changes to the ticket staff role or category apply to new tickets. Review existing channel overwrites when rotating staff access.
