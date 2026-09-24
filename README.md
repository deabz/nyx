# zy

A defensive Discord.js anti-raid and anti-nuke bot. It monitors join bursts and audit-log activity, automatically quarantines suspicious members, can lock down text channels, posts incident logs, and exposes every core action through both slash commands and prefix commands.

## Setup

1. Install Node.js LTS (already installed by the setup assistant).
2. Open `.env` and replace `PASTE_YOUR_BOT_TOKEN_HERE` with your bot token.
3. In the Discord Developer Portal, enable **Server Members Intent**, **Message Content Intent**, and **Guild Members Intent**.
4. Invite the bot with the `bot` and `applications.commands` scopes and permissions including View Audit Log, Manage Roles, Moderate Members, Manage Channels, Send Messages, Embed Links, and Manage Webhooks if you want webhook activity monitored.
5. Run `npm install`, then `npm start`.

## Website and 24/7 hosting

zy includes a small status website and health endpoint. Open `http://localhost:3000/` locally, or use `/health` for a hosting monitor. Set `PORT` in `.env` if your host provides a port.

For 24/7 uptime, deploy the project to an always-on Node host such as Render, Railway, Fly.io, or a VPS. `render.yaml` is included for Render. Set `DISCORD_TOKEN` and the rest of your environment variables as host secrets; never commit `.env`. On Render, use the `/health` health-check path and an always-on paid instance—free services may sleep and cannot guarantee continuous Discord monitoring.

Set `DEV_GUILD_ID` while testing for instant slash-command updates. Leave it empty for global commands. Run `/setup` or `!setup` once in each server as an Administrator. Setup creates the `guardian-security` category, private `guardian-logs` channel, and `Guardian Quarantine` role, applies quarantine denies to text channels, and saves the created IDs into `.env`. Keep `DRY_RUN=true` while testing if you want alerts without changing permissions or timing out users.

The bot uses an **Invisible** presence while it continues operating, so members see it as offline. Change `PRESENCE_STATUS` to `online`, `idle`, `dnd`, or `invisible` if needed; `STREAMING_NAME` and `STREAMING_URL` customize the activity.

## Commands

Slash and prefix forms are equivalent:

- `/security` or `!security`
- `/help` or `!help`
- `/setup` or `!setup`
- `/backup` or `!backup`
- `/lockdown on|off` or `!lockdown on|off`
- `/quarantine @user` or `!quarantine @user`
- `/allow @user` or `!allow @user`
- `/incident` or `!incident`

The log channel receives structured records for setup, lockdowns, quarantines, timeouts, allowlist changes, raid detections, and anti-nuke responses, including actor, target, result, and reason.

Confirmed anti-nuke executors can be automatically banned with `AUTO_BAN_ATTACKERS=true`, and bots joining during a detected raid or lockdown can be blocked with `AUTO_BAN_RAID_BOTS=true`. Guardian deliberately does not mass-ban all raid members: human joins are quarantined and the server is locked down to avoid irreversible false positives.

Channel deletion protection defaults to `ACTION_LIMIT_CHANNEL_DELETE=1`: the first confirmed unauthorized channel deletion triggers the anti-nuke response immediately. The executor must not be allowlisted, and the bot's role must be above the executor's role for Discord to allow the ban.

With `IMMEDIATE_CHANNEL_DELETE_BAN=true`, a non-trusted bot is banned on the first confirmed channel deletion, independent of the rolling action counter. Duplicate delivery of the same Discord audit-log entry is ignored.

Confirmed anti-nuke bots are banned when possible. Confirmed human attackers are quarantined, timed out, and have manageable roles containing dangerous permissions removed (`Administrator`, channel/role management, bans, kicks, webhooks, messages, mentions, or moderation). Trusted users and trusted roles are exempt.

After a confirmed anti-nuke response, lockdown automatically releases after `NUKE_LOCKDOWN_SECONDS` (60 seconds by default) when `AUTO_UNLOCK_AFTER_NUKE=true`. Set it to `false` if you want lockdown to remain until an administrator runs `/lockdown off`.

Mass-mention containment detects unauthorized `@everyone`/`@here` messages, deletes the triggering message, locks down the server, deletes guild webhooks, optionally bans the responsible member, and restores the saved server identity. Guardian snapshots each guild's name/icon in `data/guild-backups.json` while online; you can override it with `BACKUP_GUILD_NAME` and `BACKUP_GUILD_ICON_URL`. It does **not** purge all server history. Grant Manage Webhooks and Manage Guild if you want those recovery actions enabled.

Important limitation: Discord removes a bot's ability to act after the bot is banned or kicked. Guardian therefore cannot rename a server after its own removal; it saves the identity beforehand and restores it during an active containment event.

`/backup` creates a local snapshot in `data/zy.sqlite` containing all recoverable server data: identity/settings, roles, channels/categories and permission overwrites, emojis, stickers, scheduled events, bans, and webhook metadata. Webhook tokens and other secrets are never stored. The SQLite database uses WAL journaling and survives bot restarts and normal process crashes. It is non-destructive. Discord does not provide a complete export of message history, member passwords/tokens, or every managed integration, so those cannot be backed up by a bot.

The same snapshot is also created automatically at startup and after Discord reports guild, channel, role, emoji, sticker, scheduled-event, ban, or webhook changes. A periodic integrity scan (configured by `BACKUP_SCAN_INTERVAL_SECONDS`, five minutes by default) catches changes whose gateway event was missed. Snapshots are briefly debounced so a burst of related changes is saved once, and detected differences are written to the security log channel. The original guild name and icon remain separately preserved for identity restoration. Legacy JSON backups are read once as a migration fallback.

When a nuke is confirmed, `AUTO_CLEANUP_NUKE_ARTIFACTS=true` removes only channels and roles created by the confirmed attacker within `NUKE_CLEANUP_WINDOW_SECONDS` (60 seconds by default). Guardian preserves `@everyone`, managed roles, the quarantine role, and Guardian's own security category/log channel.

Logging coalesces identical repeated events for `LOG_DEDUPE_WINDOW_SECONDS` (5 seconds by default). The first event is logged immediately, and a summary reports the number of duplicate events suppressed so the log channel stays readable without hiding activity.


No bot can guarantee protection against every compromise: keep ownership secure, require 2FA for moderators, minimize bot permissions, and never share the token.
