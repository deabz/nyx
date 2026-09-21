# nyx

nyx is an insights-only Discord bot for understanding server health, activity,
members, roles, and voice usage. It intentionally leaves moderation, sniping,
entertainment, and general utility commands to the separate bot.

## Commands

All commands are available as slash commands:

`/help` `/ping` `/uptime` `/serverhealth` `/serverreport`
`/channelpulse` `/roleinsights` `/memberinsights` `/memberactivity`
`/voiceinsights` `/analytics` `/topmessages` `/topwords` `/wordcloud`
`/voiceactivity` `/joins` `/leaves` `/messagechanges` `/timezone`

Analytics are stored per server in the local SQLite database. The bot records
message counts and words, edits, deletions, member joins and leaves, and voice
sessions. Use `/analytics` for totals, then the focused commands for rankings
and history. Message content is stored locally to calculate word statistics.

## Run

```powershell
python main.py
```

The bot uses the `MYSTIC_DISCORD_TOKEN` value from `.env`. Its health website
is available at `http://localhost:8080/`, with a JSON check at
`http://localhost:8080/health`.

Prefix commands use `-`; slash commands are synced automatically on startup.
The help menu uses discord.py UI components: a category dropdown plus
Previous, Next, and Close buttons. Keep `.env` private and rotate the bot
token if it is ever exposed.
