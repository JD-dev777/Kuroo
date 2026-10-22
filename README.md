# Kuroo

A Discord bot built with TypeScript, discord.js, MongoDB, and **Components V2**. Kuroo focuses on server security, moderation, and private support tickets.

## Features

- Join surge detection and message flood protection with configurable thresholds and automatic 10 minute timeouts.
- Ban, kick, timeout, warnings, recent message cleanup, and moderation history.
- MongoDB settings, moderation records, and ticket reservations with unique indexes.
- Private support channels with staff access and a confirmation before deletion.
- Components V2 containers, text displays, and buttons. Bot replies suppress mentions.
- Manual custom emoji mapping through `{emoji:name}` placeholders, with Unicode defaults.
- Live permission checks, role hierarchy checks, per-user interaction limits, and private command responses.

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

Enable **Server Members Intent** in the Developer Portal. Message Content Intent is not needed: spam protection counts messages without reading their contents.

Install the bot with the `bot` and `applications.commands` scopes. Grant these permissions where the corresponding features are used:

- View Channels, Send Messages, Read Message History
- Moderate Members, Kick Members, Ban Members, Manage Messages
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
5. Inspect `/security status` and test permissions in a staging server before wider use.

Default security settings: 8 joins within 15 seconds activates a 60 second surge window. Accounts younger than 24 hours joining from the threshold onward receive a 10 minute timeout. Every further qualifying join extends the surge window. Message flood protection times out a member at 6 messages within 5 seconds across channels. Earlier joins are not retrospectively timed out. Accounts older than the configured minimum are unaffected by join protection. Bot accounts, server managers, moderators, owners, and members the bot cannot moderate are exempt from automatic timeouts.

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

Use actual emoji IDs from a server accessible to Kuroo. `{emoji:shield}` and `{emoji:success}` in bot UI strings are replaced at render time. Unknown placeholders remain visible to make missing configuration discoverable. This mapping changes Kuroo’s UI; it does not rewrite member messages. Invalid configuration stops startup. The configured emoji appears in Components V2 text; action buttons use text labels.

## Validation and operations

```sh
npm run check
npm test
npm run build
npm audit --omit=dev
```

Tests cover permission boundaries, emoji rendering, Components V2 payloads, command registration schemas, MongoDB indexes, concurrent ticket reservations, failed moderation persistence, and ticket cleanup. Database tests use an ephemeral real MongoDB process through `mongodb-memory-server` and may download its binary on first run. No Discord token is needed for tests. Live Discord gateway, permission behavior, and rendering still require a test server.

Use a process supervisor for production and keep secrets in a secret manager or protected environment file. Back up MongoDB and restrict its network access. The bot logs only limited error metadata. It does not provide malicious administrator recovery, deleted channel restoration, anti-nuke guarantees, content-based automod, or distributed rate limiting. Discord timeouts cannot affect administrators or members above Kuroo. Tune thresholds to your community; legitimate bursts can trigger protection.

Changes to the ticket staff role or category apply to new tickets. Review existing channel overwrites when rotating staff access.
