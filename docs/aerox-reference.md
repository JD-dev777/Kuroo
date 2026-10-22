# AeroX reference and Kuroo coverage

Reference: [itsfizys/AeroX-Security-Bot](https://github.com/itsfizys/AeroX-Security-Bot), commit `115b8dd40f811a49383dce56e429e0e042187267` (inspected October 22, 2026). The reference’s README and command/event organization informed this expansion. Kuroo implements these concepts independently in TypeScript with Mongoose and shared slash/prefix command handlers. No reference source code, LMDB database files, configuration, identities, or emoji IDs were imported.

## Feature mapping

| AeroX category | Kuroo implementation | Behavior and scope |
| --- | --- | --- |
| Antinuke | `/antinuke configure`, `/antinuke status` | Audit-entry events attribute an action to its actual executor. Supports alert mode and opt-in actor bans. |
| Whitelist / multiwhitelist | `/trust feature:antinuke` | Owner/delegated-owner managed user IDs, persistent in MongoDB. Repeat add/remove for multiple users. |
| Extra owner | `/extraowner` | Only the actual server owner may appoint/remove security delegates. Delegates also need Manage Server to use the commands. |
| Channel, role, webhook, guild and integration protection | Audit protection | Monitors creation, modification, deletion, permission overwrites, dangerous role grants, kicks/prunes, bans/unbans, and bot additions. Administrator is not an exemption. |
| Recovery | `/antinuke configure recovery:true` | Recreates supported deleted channels/roles from saved snapshots; removes unauthorized new channels/roles/webhooks and bot accounts; reverses bans/unbans; removes dangerous role grants; restores selected changed fields. See limitations below. |
| Anti mass join | `/security configure` | Join window, threshold, minimum account age, and message flooding. Young accounts joining from the threshold onward receive the raid response. |
| Account-age filter / antialt | `/antiraid configure account_age_filter:true` | Applies the configured minimum account age to every human join while security is enabled. |
| Bot filter | `/antiraid configure bot_filter:true` | Blocks bot accounts unless their user ID is on `/trust feature:raid`. Bots are kicked if timeout is selected. |
| Raid action | `/antiraid configure action` | Timeout, kick, or ban. Older accounts are not punished by the young-account surge rule. |
| Automod setup/modules | `/automod configure`, `/automod rule`, `/automod limits` | Invite/link filters, mass mentions across messages, attachments, forwarded messages, caps, emoji flooding, and Discord-marked explicit media. |
| Abuse / NSFW / custom filter | `/automod filter` | Separate literal word/phrase lists. All lists start empty; configure your server’s terms and enable the corresponding rule. Includes Unicode normalization and word boundaries. This is not semantic or image-content classification. |
| Automod escalation | `/automod configure strikes:true threshold:3` | Persistent strikes after successful deletions. Response advances delete → timeout → kick → ban, starting from the configured base action. Resets after 24 hours without a recorded strike. |
| User/role/channel automod exceptions | `/trust feature:automod kind:user/role/channel` | Separate exemption lists; use the relevant Discord ID. |
| Automod history | `/automod history`, `/cases` | MongoDB action outcomes; deletion and escalation are recorded separately. |
| Verification | `/verification setup/protect/status/disable` | PNG captcha, private Components V2 challenge and modal, expiring one-use codes bound to a user and server. Explicitly protect chosen public channels/categories after setup. |
| Logging | `/logging`, `/setup logs` | Moderation actions, server audit entries, joins/leaves, and deletion metadata. Message content is not copied to logs. |
| Ban / kick / mute / unmute / unban | `/ban`, `/kick`, `/timeout`, `/untimeout`, `/unban` | Runtime permissions, hierarchy checks, reasons and case records. Timeout supports up to 28 days. |
| Purge / purgebots | `/purge`, `/purgebots` | Up to 100 recent messages, skips messages older than 14 days. |
| Role / rrole / nickname / list | `/role`, `/nickname`, `/role-members` | Individual role assignment/removal, nickname edits, role membership lookup. Cannot grant permissions the caller lacks. |
| Lock / unlock / hide / unhide and all variants | `/channel operation:... all:true/false` | Saved @everyone overwrite state; restores only changes managed by Kuroo. Server-wide operations require a member-bound, expiring confirmation. |
| Autorole | `/autorole` | Non-bot joins receive a safe role, after verification when enabled. Rechecks role safety at assignment time. |
| Help / ping / stats / userinfo / serverinfo / avatar / banner / report | Corresponding slash commands | Private Components V2 replies. Reports go to the configured moderation log with a per-user cooldown. |
| Emoji setup | `config/emojis.json` | Manual `{emoji:name}` mapping; Unicode defaults, static and animated custom emoji syntax. |

Kuroo uses slash commands, so it has no prefix command. It does not include AeroX’s monetization system, global bot-owner messaging/blacklist commands, mass role assignment, emoji importing, guild-specific bot avatars, hybrid sharding, or LMDB cache. These are not needed for the security, moderation, verification, utility, and support categories above. Deploy exactly one process per bot token.

## Audit protection operation

1. Enable Server Members Intent. Kuroo requests the Guild Moderation intent for audit-entry events.
2. Grant **View Audit Log**, configure a private log channel, and move Kuroo’s role above actors it may ban.
3. Use `/antinuke configure enabled:true mode:alert` first and inspect logged actions.
4. The owner can use `/trust feature:antinuke operation:add id:USER_ID` to exempt approved administrators/integrations. Trust is broad: a trusted executor bypasses every audit rule.
5. Select `mode:ban` to opt into actor bans. Enable `recovery:true` only after granting the required recovery permissions.

Only the actual owner, delegated security owners, Kuroo itself, and the audit trust list bypass audit protection. Commands performed through Kuroo are attributed to Kuroo by Discord and use their separate command permission checks. Normal role grants are ignored; the member-role audit rule only applies when a dangerous management/moderation role was added.

Audit events must be at most 30 seconds old and have a known executor. The bot uses the entry event’s own action/target/executor, rather than guessing from the newest audit log entry. MongoDB unique keys deduplicate audit IDs across restarts. Each executor’s actions are processed sequentially, and Discord.js handles REST rate limits. The bot does not bypass Discord rate limits.

### Recovery limits

Recovery runs after successful containment and records its own outcome. Supported deleted-channel snapshots cover text, voice, category, and announcement channels. Original channel overwrites must be present before a replacement is created. Snapshots are captured when recovery is enabled and refreshed on subsequent channel/role events. They require MongoDB to be available and can be stale or absent after an outage. A replacement has a **new ID**. Parent links, channel references, category children, role memberships, original message history, and every ordering detail cannot be reconstructed automatically.

Recovery can restore the following audit change fields only when the current value still matches that entry’s new value: guild name/description; role name/color/permissions/hoist/mentionable; channel name/topic/NSFW/slowmode. This avoids overwriting a later change to those fields. Channel overwrite changes, webhook modifications/deletions, integration modifications/deletions, kicks/prunes, guild icons/vanity and other fields do not have automatic restoration. Unsupported recovery attempts are recorded as failed for staff review. Deleted roles are recreated without assigning members. Recovery snapshots are not a backup service.

An actor at or above Kuroo cannot be banned. If containment fails, recovery does not proceed. Missing permissions, missing snapshots, or Discord failures are recorded/reported. A crash or loss of MongoDB after Discord accepts an action can leave a pending case; inspect Discord’s audit log before retrying it.

## Verification and channel access

Create a dedicated verified role without moderation/management permissions or existing private-channel access, and a public verification channel. Automatic roles are checked against the same restrictions; access to Kuroo’s own saved verification gates is permitted. `/verification setup` posts the panel, then `/verification protect channel:#general` gates that public channel. Protect a public category to affect its synced children. Categories containing the verification or log channel are rejected. Private staff channels are rejected rather than exposed to every verified member. Other role/member overwrites and Administrator can still grant access; review the server’s effective permissions. New unsynced channels require deliberate protection.

Kuroo stores the original @everyone, verified-role, and bot-member View Channel overwrite bits before editing. It preserves its own channel access. `/verification disable` restores those bits if they still match Kuroo’s values, retaining unrelated or later manual edits. It keeps the existing role, memberships, and panel; the panel becomes inactive. If restoration fails, the remaining database records let staff retry. Do not delete those records until restoration is complete.

Challenges are six characters, cryptographically randomized, expire after five minutes, and permit one answer attempt. Only a digest is stored in MongoDB. A wrong answer, expired code, or replay cannot assign a role. Existing panels work after restart; a fresh challenge replaces the old one. Image challenges are a friction mechanism and can be solved by modern automation; they are not a guarantee against bots. Staff should offer an accessible verification alternative.
