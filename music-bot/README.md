# nyx music

Separate Discord music bot for `/play`, `/pause`, `/resume`, `/skip`,
`/stop`, `/queue`, `/nowplaying`, `/shuffle`, `/loop`, and `/disconnect`.
This does not modify the insights-only nyx bot.

## Setup

1. Create a separate Discord application and bot token.
2. Copy `.env.example` to `.env` and fill in `DISCORD_TOKEN` and
   `DISCORD_CLIENT_ID`. Set `DISCORD_GUILD_ID` while testing for immediate
   command updates.
3. Install Node.js 20 or newer.
4. Run:

```powershell
npm install
npm run deploy
npm start
```

Invite the bot with the `bot` and `applications.commands` scopes and the
`Connect`, `Speak`, and `View Channel` permissions. The bot uses Discord
voice connections and YouTube search through Discord Player's extractor;
source availability can change, so use content you are allowed to play.

Run this as a separate persistent service. Do not put its token in the nyx
insights `.env`.
