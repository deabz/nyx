# nyx

nyx is a Discord companion bot focused on server insights and lightweight
utilities. It intentionally avoids duplicating the separate moderation and
snipe bot.

## Run

```powershell
python main.py
```

The bot uses the `MYSTIC_DISCORD_TOKEN` value from `.env`. Its health website
is available at `http://localhost:8080/`, with a JSON check at
`http://localhost:8080/health`.

Prefix commands use `-`; slash commands are synced automatically on startup.
Keep `.env` private and rotate the bot token if it is ever exposed.
