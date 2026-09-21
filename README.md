# nyx

nyx is a Discord.js bot for server insights and music playback. It intentionally
leaves moderation and sniping to the separate bot.

## Commands

All commands are available as slash commands:

`/help` `/ping` `/uptime` `/serverhealth` `/serverreport` `/channelpulse`
`/roleinsights` `/memberinsights` `/memberactivity` `/voiceinsights`
`/play` `/pause` `/resume` `/skip` `/stop` `/queue` `/nowplaying` `/shuffle`
`/loop` `/disconnect`

## Discord.js setup

Copy `.env.node.example` to `.env` and set `DISCORD_TOKEN` and
`DISCORD_CLIENT_ID`, then run `npm install`, `npm run deploy`, and `npm start`.
The Discord.js bot uses Discord voice connections and Discord Player's
extractor for music playback.

## Run

```powershell
python main.py
```

The bot uses the `MYSTIC_DISCORD_TOKEN` value from `.env`. Its health website
is available at `http://localhost:8080/`, with a JSON check at
`http://localhost:8080/health`.

Prefix commands use `-`; slash commands are synced automatically on startup.
Keep `.env` private and rotate the bot token if it is ever exposed.
