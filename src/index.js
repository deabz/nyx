require("dotenv").config();
const fs = require("fs");
const http = require("http");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const {
  AuditLogEvent,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  Collection,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  PermissionsBitField,
  REST,
  Routes,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");

const csv = (value) => new Set((value || "").split(",").map((x) => x.trim()).filter(Boolean));
const bool = (value, fallback) => value === undefined ? fallback : value.toLowerCase() === "true";
const num = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const config = {
  brandName: "zy",
  webPort: num(process.env.PORT, 3000),
  token: process.env.DISCORD_TOKEN,
  weatherApiKey: process.env.OPENWEATHER_API_KEY || "",
  suggestionChannelId: process.env.SUGGESTION_CHANNEL_ID || "",
  logChannelId: process.env.LOG_CHANNEL_ID || "",
  quarantineRoleId: process.env.QUARANTINE_ROLE_ID || "",
  allowedUsers: csv(process.env.ALLOWED_USER_IDS),
  trustedRoles: csv(process.env.TRUSTED_ROLE_IDS),
  ownerUsers: csv(process.env.OWNER_USER_IDS),
  streamingName: process.env.STREAMING_NAME || "Protecting servers from raids",
  streamingUrl: process.env.STREAMING_URL || "https://twitch.tv/a",
  presenceStatus: process.env.PRESENCE_STATUS || "invisible",
  joinThreshold: num(process.env.JOIN_RAID_THRESHOLD, 8),
  joinWindowMs: num(process.env.JOIN_RAID_WINDOW_SECONDS, 20) * 1000,
  actionWindowMs: num(process.env.ACTION_LIMIT_WINDOW_SECONDS, 10) * 1000,
  autoLockdown: bool(process.env.AUTO_LOCKDOWN, true),
  autoQuarantine: bool(process.env.AUTO_QUARANTINE, true),
  autoBanAttackers: bool(process.env.AUTO_BAN_ATTACKERS, true),
  immediateChannelDeleteBan: bool(process.env.IMMEDIATE_CHANNEL_DELETE_BAN, true),
  autoStripNukeRoles: bool(process.env.AUTO_STRIP_NUKE_ROLES, true),
  autoBanRaidBots: bool(process.env.AUTO_BAN_RAID_BOTS, true),
  autoBanMassMentioners: bool(process.env.AUTO_BAN_MASS_MENTIONERS, true),
  autoCleanupNukeArtifacts: bool(process.env.AUTO_CLEANUP_NUKE_ARTIFACTS, true),
  nukeCleanupWindowMs: num(process.env.NUKE_CLEANUP_WINDOW_SECONDS, 60) * 1000,
  autoUnlockAfterNuke: bool(process.env.AUTO_UNLOCK_AFTER_NUKE, true),
  nukeLockdownMs: num(process.env.NUKE_LOCKDOWN_SECONDS, 60) * 1000,
  massMentionWindowMs: num(process.env.MASS_MENTION_WINDOW_SECONDS, 30) * 1000,
  logDedupeWindowMs: num(process.env.LOG_DEDUPE_WINDOW_SECONDS, 5) * 1000,
  backupScanIntervalMs: num(process.env.BACKUP_SCAN_INTERVAL_SECONDS, 300) * 1000,
  backupGuildName: process.env.BACKUP_GUILD_NAME || "",
  backupGuildIconUrl: process.env.BACKUP_GUILD_ICON_URL || "",
  dryRun: bool(process.env.DRY_RUN, false),
  limits: {
    [AuditLogEvent.ChannelDelete]: num(process.env.ACTION_LIMIT_CHANNEL_DELETE, 1),
    [AuditLogEvent.ChannelCreate]: num(process.env.ACTION_LIMIT_CHANNEL_CREATE, 8),
    [AuditLogEvent.RoleDelete]: num(process.env.ACTION_LIMIT_ROLE_DELETE, 3),
    [AuditLogEvent.RoleCreate]: num(process.env.ACTION_LIMIT_ROLE_CREATE, 8),
    [AuditLogEvent.MemberBanAdd]: num(process.env.ACTION_LIMIT_BAN, 5),
    [AuditLogEvent.MemberKick]: num(process.env.ACTION_LIMIT_KICK, 5),
    [AuditLogEvent.WebhookUpdate]: num(process.env.ACTION_LIMIT_WEBHOOK_UPDATE, 3),
  },
};

const backupPath = path.resolve(__dirname, "..", "data", "guild-backups.json");
const savedBackups = fs.existsSync(backupPath) ? JSON.parse(fs.readFileSync(backupPath, "utf8")) : {};
const serverBackupPath = path.resolve(__dirname, "..", "data", "server-backups.json");
const databasePath = path.resolve(__dirname, "..", "data", "zy.sqlite");
fs.mkdirSync(path.dirname(databasePath), { recursive: true });
const database = new DatabaseSync(databasePath);
database.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS guild_backups (
    guild_id TEXT PRIMARY KEY,
    identity_json TEXT NOT NULL,
    snapshot_json TEXT,
    saved_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS message_activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    edited_at TEXT,
    deleted_at TEXT,
    word_count INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS member_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    occurred_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS voice_activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    channel_id TEXT,
    user_id TEXT NOT NULL,
    joined_at TEXT NOT NULL,
    left_at TEXT
  );
`);

function loadServerBackups() {
  const backups = {};
  for (const row of database.prepare("SELECT guild_id, snapshot_json FROM guild_backups WHERE snapshot_json IS NOT NULL").all()) {
    try {
      backups[row.guild_id] = JSON.parse(row.snapshot_json);
    } catch (error) {
      console.error(`[${row.guild_id}] Could not load SQLite server snapshot: ${error.message}`);
    }
  }
  if (Object.keys(backups).length > 0) return backups;
  if (!fs.existsSync(serverBackupPath)) return backups;
  try {
    return JSON.parse(fs.readFileSync(serverBackupPath, "utf8"));
  } catch (error) {
    console.error(`Could not load legacy server backups: ${error.message}`);
    return backups;
  }
}

function loadGuildIdentities() {
  const identities = {};
  for (const row of database.prepare("SELECT guild_id, identity_json FROM guild_backups").all()) {
    try {
      identities[row.guild_id] = JSON.parse(row.identity_json);
    } catch (error) {
      console.error(`[${row.guild_id}] Could not load SQLite identity backup: ${error.message}`);
    }
  }
  return identities;
}

const savedServerBackups = loadServerBackups();
const savedGuildIdentities = loadGuildIdentities();

if (!config.token || config.token === "PASTE_YOUR_BOT_TOKEN_HERE") {
  console.error("Missing DISCORD_TOKEN. Edit .env and paste your bot token.");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const state = {
  joins: new Map(),
  actions: new Map(),
  lockdowns: new Set(),
  incidents: new Collection(),
  massMentions: new Map(),
  guildBackups: { ...savedBackups, ...savedGuildIdentities },
  serverBackups: savedServerBackups,
  unlockTimers: new Map(),
  processedAuditEntries: new Set(),
  logBuckets: new Map(),
  backupTimers: new Map(),
  backupQueues: new Map(),
  warnings: new Map(),
  mutedUntil: new Map(),
  mimicUsers: new Set(),
  afkUsers: new Map(),
  snipes: new Map(),
};

function statusPayload() {
  return {
    name: config.brandName,
    status: client.isReady() ? "online" : "starting",
    discordUser: client.user?.tag || null,
    guilds: client.guilds.cache.size,
    uptimeSeconds: Math.floor(process.uptime()),
    lockdowns: state.lockdowns.size,
    incidents: state.incidents.size,
    enforcement: config.dryRun ? "dry-run" : "active",
    timestamp: new Date().toISOString(),
  };
}

function startStatusWebsite() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (url.pathname === "/health") {
      response.writeHead(client.isReady() ? 200 : 503, { "Content-Type": "application/json; charset=utf-8" });
      return response.end(JSON.stringify(statusPayload()));
    }
    if (url.pathname === "/api/status") {
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      return response.end(JSON.stringify(statusPayload()));
    }
    if (url.pathname !== "/") {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return response.end("Not found");
    }
    const status = statusPayload();
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>zy status</title><style>
:root{color-scheme:dark}body{margin:0;background:#080b14;color:#eef2ff;font:16px system-ui,sans-serif}
main{max-width:760px;margin:8vh auto;padding:32px}h1{font-size:48px;margin:0 0 8px}
.sub{color:#9ca8c7;margin-bottom:28px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px}
.card{background:#11182a;border:1px solid #263252;border-radius:16px;padding:20px}.label{color:#93a4ce;font-size:13px;text-transform:uppercase;letter-spacing:.08em}
.value{font-size:24px;margin-top:8px}.ok{color:#62e6a5}.warn{color:#ffd166}footer{color:#7180a3;margin-top:28px;font-size:13px}
</style></head><body><main><h1>🛡️ zy</h1><div class="sub">Discord security service status</div>
<div class="grid"><div class="card"><div class="label">Connection</div><div class="value ${status.status === "online" ? "ok" : "warn"}">${status.status}</div></div>
<div class="card"><div class="label">Protection</div><div class="value">${status.enforcement}</div></div>
<div class="card"><div class="label">Servers</div><div class="value">${status.guilds}</div></div>
<div class="card"><div class="label">Uptime</div><div class="value">${status.uptimeSeconds}s</div></div>
<div class="card"><div class="label">Lockdowns</div><div class="value">${status.lockdowns}</div></div>
<div class="card"><div class="label">Incidents</div><div class="value">${status.incidents}</div></div></div>
<footer>Live health endpoint: <code>/health</code> · Updated ${status.timestamp}</footer></main></body></html>`);
  });
  server.listen(config.webPort, "0.0.0.0", () => console.log(`zy status website listening on port ${config.webPort}`));
  server.on("error", (error) => console.error(`Status website error: ${error.message}`));
}

const commands = [
  new SlashCommandBuilder().setName("help").setDescription("Open the complete zy command and security guide."),
  new SlashCommandBuilder().setName("security").setDescription("Show zy security status."),
  new SlashCommandBuilder().setName("setup").setDescription("Create zy security infrastructure."),
  new SlashCommandBuilder().setName("backup").setDescription("Snapshot the server name, icon, roles, channels, and permissions."),
  new SlashCommandBuilder().setName("lockdown").setDescription("Lock or unlock the server.")
    .addStringOption((o) => o.setName("mode").setDescription("Lockdown mode").setRequired(true)
      .addChoices({ name: "on", value: "on" }, { name: "off", value: "off" })),
  new SlashCommandBuilder().setName("quarantine").setDescription("Quarantine a member.")
    .addUserOption((o) => o.setName("user").setDescription("Member to quarantine").setRequired(true)),
  new SlashCommandBuilder().setName("allow").setDescription("Allow a user to bypass automated protection.")
    .addUserOption((o) => o.setName("user").setDescription("User to allow").setRequired(true)),
  new SlashCommandBuilder().setName("list").setDescription("List users allowed to use the bot."),
  new SlashCommandBuilder().setName("disallow").setDescription("Remove a user's bot access.")
    .addUserOption((o) => o.setName("user").setDescription("User to remove").setRequired(true)),
  new SlashCommandBuilder().setName("incident").setDescription("Show recent security incidents."),
  new SlashCommandBuilder().setName("ping").setDescription("Show bot latency."),
  new SlashCommandBuilder().setName("uptime").setDescription("Show bot uptime."),
  new SlashCommandBuilder().setName("urban").setDescription("Look up an Urban Dictionary definition.")
    .addStringOption((o) => o.setName("query").setDescription("Term to look up").setRequired(false)),
  new SlashCommandBuilder().setName("suggest").setDescription("Send a suggestion to the configured suggestion channel.")
    .addStringOption((o) => o.setName("suggestion").setDescription("Suggestion text").setRequired(true)),
  new SlashCommandBuilder().setName("snipe").setDescription("Show the latest deleted message in this channel."),
  new SlashCommandBuilder().setName("whois").setDescription("Show member information.")
    .addUserOption((o) => o.setName("member").setDescription("Member").setRequired(false)),
  new SlashCommandBuilder().setName("roleinfo").setDescription("Show role information.")
    .addRoleOption((o) => o.setName("role").setDescription("Role").setRequired(true)),
  new SlashCommandBuilder().setName("botinfo").setDescription("Show bot information."),
  new SlashCommandBuilder().setName("stats").setDescription("Show server statistics."),
  new SlashCommandBuilder().setName("warn").setDescription("Warn a member.")
    .addUserOption((o) => o.setName("member").setDescription("Member").setRequired(true))
    .addStringOption((o) => o.setName("reason").setDescription("Reason").setRequired(true)),
  new SlashCommandBuilder().setName("warns").setDescription("Show warnings for a member.")
    .addUserOption((o) => o.setName("member").setDescription("Member").setRequired(false)),
  new SlashCommandBuilder().setName("kick").setDescription("Kick a member.")
    .addUserOption((o) => o.setName("member").setDescription("Member").setRequired(true))
    .addStringOption((o) => o.setName("reason").setDescription("Reason").setRequired(false)),
  new SlashCommandBuilder().setName("mute").setDescription("Mute a member with the Muted role.")
    .addUserOption((o) => o.setName("member").setDescription("Member").setRequired(true))
    .addStringOption((o) => o.setName("duration").setDescription("Duration such as 10m or 2h").setRequired(false))
    .addStringOption((o) => o.setName("reason").setDescription("Reason").setRequired(false)),
  new SlashCommandBuilder().setName("muterole").setDescription("Create or select the Muted role.")
    .addStringOption((o) => o.setName("action").setDescription("Action").setRequired(true)
      .addChoices({ name: "create", value: "create" }, { name: "use", value: "use" }))
    .addStringOption((o) => o.setName("name").setDescription("Role name").setRequired(true)),
  new SlashCommandBuilder().setName("ban").setDescription("Ban a member.")
    .addUserOption((o) => o.setName("member").setDescription("Member").setRequired(true))
    .addStringOption((o) => o.setName("reason").setDescription("Reason").setRequired(false)),
  new SlashCommandBuilder().setName("unban").setDescription("Unban a user by ID.")
    .addStringOption((o) => o.setName("user_id").setDescription("User ID").setRequired(true)),
  new SlashCommandBuilder().setName("unmute").setDescription("Remove the Muted role from a member.")
    .addUserOption((o) => o.setName("member").setDescription("Member").setRequired(true)),
  new SlashCommandBuilder().setName("tempmute").setDescription("Mute a member for a number of minutes.")
    .addUserOption((o) => o.setName("member").setDescription("Member").setRequired(true))
    .addIntegerOption((o) => o.setName("minutes").setDescription("Minutes").setRequired(true).setMinValue(1).setMaxValue(7200))
    .addStringOption((o) => o.setName("reason").setDescription("Reason").setRequired(false)),
  new SlashCommandBuilder().setName("delete").setDescription("Delete a role.")
    .addRoleOption((o) => o.setName("role").setDescription("Role").setRequired(true)),
  new SlashCommandBuilder().setName("mock").setDescription("Repeat text with alternating capitalization.")
    .addStringOption((o) => o.setName("message").setDescription("Message").setRequired(true)),
  new SlashCommandBuilder().setName("eball").setDescription("Ask the eight ball a question.")
    .addStringOption((o) => o.setName("question").setDescription("Question").setRequired(false)),
  new SlashCommandBuilder().setName("say").setDescription("Send a message as the bot.")
    .addStringOption((o) => o.setName("message").setDescription("Message").setRequired(true)),
  new SlashCommandBuilder().setName("mimic").setDescription("Mimic a user's messages until stopped."),
  new SlashCommandBuilder().setName("stop").setDescription("Stop mimicking your messages."),
  new SlashCommandBuilder().setName("afk").setDescription("Set an AFK status.")
    .addStringOption((o) => o.setName("reason").setDescription("Reason").setRequired(false)),
  new SlashCommandBuilder().setName("purge").setDescription("Delete recent messages.")
    .addIntegerOption((o) => o.setName("amount").setDescription("Number of messages").setRequired(true).setMinValue(1).setMaxValue(100)),
  new SlashCommandBuilder().setName("av").setDescription("Show a member avatar.")
    .addUserOption((o) => o.setName("member").setDescription("Member").setRequired(false)),
  new SlashCommandBuilder().setName("analyse").setDescription("Analyse text statistics.")
    .addStringOption((o) => o.setName("quote").setDescription("Text to analyse").setRequired(true)),
  new SlashCommandBuilder().setName("wl").setDescription("Toggle a user in the allowlist.")
    .addUserOption((o) => o.setName("user").setDescription("User").setRequired(true)),
  new SlashCommandBuilder().setName("bl").setDescription("Add a user or guild to the blacklist.")
    .addStringOption((o) => o.setName("target_type").setDescription("Target type").setRequired(true)
      .addChoices({ name: "user", value: "user" }, { name: "guild", value: "guild" }))
    .addStringOption((o) => o.setName("target").setDescription("User or guild ID").setRequired(true))
    .addStringOption((o) => o.setName("reason").setDescription("Reason").setRequired(false)),
  new SlashCommandBuilder().setName("unbl").setDescription("Clear the legacy blacklist.")
    .addStringOption((o) => o.setName("option").setDescription("Use all").setRequired(true)
      .addChoices({ name: "all", value: "all" })),
  new SlashCommandBuilder().setName("status").setDescription("Show allowlist and blacklist status."),
  new SlashCommandBuilder().setName("secret").setDescription("Show the legacy command reference."),
  new SlashCommandBuilder().setName("weather").setDescription("Show weather for a location.")
    .addStringOption((o) => o.setName("location").setDescription("City or location").setRequired(true)),
  new SlashCommandBuilder().setName("invite").setDescription("Get an invite link for this bot."),
  new SlashCommandBuilder().setName("userinfo").setDescription("Show detailed user information.")
    .addUserOption((o) => o.setName("user").setDescription("User").setRequired(false)),
  new SlashCommandBuilder().setName("servers").setDescription("List servers the bot is in."),
  new SlashCommandBuilder().setName("inv").setDescription("Create an invite for a server.")
    .addStringOption((o) => o.setName("server").setDescription("Server ID or exact name").setRequired(true)),
  new SlashCommandBuilder().setName("calc").setDescription("Calculate a basic arithmetic expression.")
    .addStringOption((o) => o.setName("expression").setDescription("Arithmetic expression").setRequired(true)),
  new SlashCommandBuilder().setName("hug").setDescription("Send a hug image.")
    .addUserOption((o) => o.setName("user").setDescription("User").setRequired(true)),
  new SlashCommandBuilder().setName("kiss").setDescription("Send a kiss image.")
    .addUserOption((o) => o.setName("user").setDescription("User").setRequired(true)),
  new SlashCommandBuilder().setName("emotions").setDescription("Show emotion commands."),
  new SlashCommandBuilder().setName("youtube").setDescription("Search YouTube.")
    .addStringOption((o) => o.setName("query").setDescription("Search terms").setRequired(true)),
  new SlashCommandBuilder().setName("leave").setDescription("Leave a server by ID.")
    .addStringOption((o) => o.setName("server_id").setDescription("Server ID").setRequired(true)),
  new SlashCommandBuilder().setName("banlist").setDescription("Show the server ban list."),
  new SlashCommandBuilder().setName("role").setDescription("Create or delete a server role.")
    .addStringOption((o) => o.setName("action").setDescription("Action").setRequired(true)
      .addChoices({ name: "create", value: "create" }, { name: "delete", value: "delete" }))
    .addStringOption((o) => o.setName("name").setDescription("Role name").setRequired(true))
    .addStringOption((o) => o.setName("colour").setDescription("Hex colour such as #5865f2").setRequired(false))
    .addBooleanOption((o) => o.setName("mentionable").setDescription("Make mentionable").setRequired(false)),
  new SlashCommandBuilder().setName("randommember").setDescription("Pick a random non-bot member."),
  new SlashCommandBuilder().setName("memberinsights").setDescription("Show member account and role insights.")
    .addUserOption((o) => o.setName("member").setDescription("Member").setRequired(false)),
  new SlashCommandBuilder().setName("serverhealth").setDescription("Show server health and bot permissions."),
  new SlashCommandBuilder().setName("channelpulse").setDescription("Summarize recent channel activity.")
    .addChannelOption((o) => o.setName("channel").setDescription("Text channel").setRequired(false)),
  new SlashCommandBuilder().setName("serverreport").setDescription("Show a server summary report."),
  new SlashCommandBuilder().setName("roleinsights").setDescription("Show role usage insights."),
  new SlashCommandBuilder().setName("memberactivity").setDescription("Show a member's recent message activity.")
    .addUserOption((o) => o.setName("member").setDescription("Member").setRequired(false))
    .addIntegerOption((o) => o.setName("limit").setDescription("Messages to scan").setMinValue(25).setMaxValue(100).setRequired(false)),
  new SlashCommandBuilder().setName("voiceinsights").setDescription("Show current voice occupancy."),
  new SlashCommandBuilder().setName("analytics").setDescription("Show stored analytics totals."),
  new SlashCommandBuilder().setName("cloud").setDescription("Show the complete analytics dashboard."),
  new SlashCommandBuilder().setName("topmessages").setDescription("Rank members by stored messages.")
    .addIntegerOption((o) => o.setName("limit").setDescription("Number of members").setMinValue(1).setMaxValue(20).setRequired(false)),
  new SlashCommandBuilder().setName("topwords").setDescription("Rank members by stored words.")
    .addIntegerOption((o) => o.setName("limit").setDescription("Number of members").setMinValue(1).setMaxValue(20).setRequired(false)),
  new SlashCommandBuilder().setName("wordcloud").setDescription("Show the most-used stored words.")
    .addIntegerOption((o) => o.setName("limit").setDescription("Number of words").setMinValue(5).setMaxValue(30).setRequired(false)),
  new SlashCommandBuilder().setName("joins").setDescription("Show recent member joins."),
  new SlashCommandBuilder().setName("leaves").setDescription("Show recent member departures."),
  new SlashCommandBuilder().setName("voiceactivity").setDescription("Rank members by stored voice time.")
    .addIntegerOption((o) => o.setName("limit").setDescription("Number of members").setMinValue(1).setMaxValue(20).setRequired(false)),
  new SlashCommandBuilder().setName("messagechanges").setDescription("Show stored message edits and deletions.")
    .addIntegerOption((o) => o.setName("limit").setDescription("Number of changes").setMinValue(1).setMaxValue(30).setRequired(false)),
  new SlashCommandBuilder().setName("timezone").setDescription("Show the current time in a timezone.")
    .addStringOption((o) => o.setName("location").setDescription("City or IANA timezone").setRequired(true)),
  new SlashCommandBuilder().setName("define").setDescription("Look up a dictionary definition.")
    .addStringOption((o) => o.setName("word").setDescription("Word or short phrase").setRequired(true)),
  new SlashCommandBuilder().setName("poll").setDescription("Create a reaction poll.")
    .addStringOption((o) => o.setName("question").setDescription("Question").setRequired(true))
    .addStringOption((o) => o.setName("options").setDescription("Comma-separated options").setRequired(true)),
  new SlashCommandBuilder().setName("remind").setDescription("Set a personal reminder.")
    .addStringOption((o) => o.setName("duration").setDescription("10m, 2h, or 1d").setRequired(true))
    .addStringOption((o) => o.setName("message").setDescription("Reminder message").setRequired(true)),
].map((command) => command.toJSON());

const HELP_CATEGORIES = [
  {
    name: "Security",
    commands: ["security", "setup", "backup", "lockdown", "quarantine", "allow", "list", "disallow", "incident"],
  },
  {
    name: "Information",
    commands: ["ping", "uptime", "snipe", "whois", "roleinfo", "botinfo", "stats", "av", "userinfo", "serverhealth", "serverreport"],
  },
  {
    name: "Moderation",
    commands: ["warn", "warns", "kick", "mute", "muterole", "ban", "unban", "unmute", "tempmute", "delete", "purge", "role"],
  },
  {
    name: "Utility",
    commands: ["urban", "suggest", "mock", "eball", "say", "mimic", "stop", "afk", "analyse", "invite", "calc", "emotions"],
  },
  {
    name: "Entertainment",
    commands: ["hug", "kiss", "youtube", "weather", "define", "timezone", "poll", "remind"],
  },
  {
    name: "Analytics",
    commands: ["randommember", "memberinsights", "channelpulse", "roleinsights", "memberactivity", "voiceinsights", "analytics", "cloud", "topmessages", "topwords", "wordcloud", "joins", "leaves", "voiceactivity", "messagechanges"],
  },
  {
    name: "Legacy / Owner",
    commands: ["wl", "bl", "unbl", "status", "secret", "servers", "inv", "leave", "banlist"],
  },
];

function helpPages(search = "") {
  const commandMap = new Map(commands.map((command) => [command.name, command]));
  const normalizedSearch = search.trim().toLowerCase();
  const pages = [];
  for (const category of HELP_CATEGORIES) {
    const entries = category.commands
      .map((name) => commandMap.get(name))
      .filter((command) => command && (!normalizedSearch ||
        command.name.includes(normalizedSearch) || command.description.toLowerCase().includes(normalizedSearch)));
    if (entries.length) pages.push({ title: category.name, entries });
  }
  const categorized = new Set(HELP_CATEGORIES.flatMap((category) => category.commands));
  const uncategorized = commands.filter((command) =>
    !categorized.has(command.name) &&
    (!normalizedSearch || command.name.includes(normalizedSearch) || command.description.toLowerCase().includes(normalizedSearch)));
  if (uncategorized.length) pages.push({ title: "Other", entries: uncategorized });
  return pages.length ? pages : [{ title: "Search results", entries: [] }];
}

function helpEmbed(page, pageIndex, totalPages, search = "") {
  const description = page.entries.length
    ? page.entries.map((command) => `\`/${command.name}\` — ${command.description}`).join("\n")
    : `No commands matched \`${search}\`.`;
  return new EmbedBuilder()
    .setTitle("🛡️ zy Security Center")
    .setDescription(search
      ? `Search results for \`${search}\``
      : "Your server's defensive command center. Commands are grouped by category.")
    .setColor(0x5865f2)
    .addFields(
      {
        name: page.title,
        value: description,
      },
    )
    .setFooter({ text: `Page ${pageIndex + 1}/${totalPages} • Use the buttons to navigate or search` })
    .setTimestamp();
}

function helpComponents(ownerId, pageIndex, totalPages) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`help:back:${ownerId}`).setLabel("Back").setStyle(ButtonStyle.Secondary).setDisabled(pageIndex === 0),
      new ButtonBuilder().setCustomId(`help:next:${ownerId}`).setLabel("Next").setStyle(ButtonStyle.Primary).setDisabled(pageIndex >= totalPages - 1),
      new ButtonBuilder().setCustomId(`help:search:${ownerId}`).setLabel("Search command").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`help:close:${ownerId}`).setLabel("Close").setStyle(ButtonStyle.Danger),
    ),
  ];
}

function helpModal(ownerId) {
  return new ModalBuilder()
    .setCustomId(`help-modal:${ownerId}`)
    .setTitle("Search slash commands")
    .addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId("query")
        .setLabel("Command name or description")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(80),
    ));
}

function isTrusted(member) {
  return Boolean(member && (config.allowedUsers.has(member.id) || config.ownerUsers.has(member.id) ||
    member.roles.cache.some((role) => config.trustedRoles.has(role.id))));
}

function canManage(member) {
  return Boolean(member && (isTrusted(member) || member.permissions.has(PermissionsBitField.Flags.Administrator)));
}

const PUBLIC_COMMANDS = new Set([
  "ping", "uptime", "urban", "suggest", "snipe", "whois", "roleinfo", "botinfo", "stats",
  "warns", "eball", "av", "analyse", "status", "weather", "invite", "userinfo", "calc",
  "hug", "kiss", "emotions", "youtube", "help", "security", "incident", "randommember",
  "memberinsights", "serverhealth", "channelpulse", "serverreport", "roleinsights",
  "memberactivity", "voiceinsights", "analytics", "cloud", "topmessages", "topwords",
  "wordcloud", "joins", "leaves", "voiceactivity", "messagechanges", "timezone", "define",
  "poll", "remind",
]);

function parseDuration(value) {
  const match = /^(\d+)([smhd])$/i.exec(String(value || "").trim());
  if (!match) return null;
  const units = { s: 1, m: 60, h: 3600, d: 86400 };
  return Number(match[1]) * units[match[2].toLowerCase()];
}

function getMutedRole(guild) {
  return guild.roles.cache.find((role) => role.name.toLowerCase() === "muted");
}

function memberEmbed(member, title) {
  const embed = new EmbedBuilder().setTitle(title).setColor(member.displayColor || 0x5865f2);
  if (member.displayAvatarURL()) embed.setThumbnail(member.displayAvatarURL());
  return embed;
}

function displayMember(member) {
  return `${member.user.tag} (${member.id})`;
}

function safeDescription(value, fallback = "None") {
  const text = String(value || fallback);
  return text.length > 4000 ? `${text.slice(0, 3997)}...` : text;
}

function recordMessageActivity(message) {
  if (!message.guild || message.author.bot) return;
  const content = message.content || "";
  database.prepare(`
    INSERT INTO message_activity
      (guild_id, channel_id, user_id, content, created_at, word_count)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    message.guild.id,
    message.channelId,
    message.author.id,
    content,
    new Date().toISOString(),
    (content.match(/\b[\w'-]+\b/g) || []).length,
  );
}

function recordMemberEvent(member, eventType) {
  database.prepare("INSERT INTO member_events (guild_id, user_id, event_type, occurred_at) VALUES (?, ?, ?, ?)")
    .run(member.guild.id, member.id, eventType, new Date().toISOString());
}

function recordVoiceEvent(member, channelId, joinedAt, leftAt = null) {
  database.prepare("INSERT INTO voice_activity (guild_id, channel_id, user_id, joined_at, left_at) VALUES (?, ?, ?, ?, ?)")
    .run(member.guild.id, channelId, member.id, joinedAt, leftAt);
}

function updateLatestMessageChange(message, field) {
  if (!message.guild || message.author?.bot) return;
  const timestamp = new Date().toISOString();
  const column = field === "edited_at" ? "edited_at" : "deleted_at";
  database.prepare(`
    UPDATE message_activity SET ${column} = ?
    WHERE id = (
      SELECT id FROM message_activity
      WHERE guild_id = ? AND channel_id = ? AND user_id = ? AND deleted_at IS NULL
      ORDER BY id DESC LIMIT 1
    )
  `).run(timestamp, message.guild.id, message.channelId, message.author.id);
}

function analyticsGuild(interaction) {
  if (!interaction.guild) throw new Error("This command can only be used inside a server.");
  return interaction.guild;
}

async function handleAnalyticsCommand(interaction, name) {
  const guild = analyticsGuild(interaction);
  const guildId = guild.id;
  if (name === "analytics" || name === "cloud") {
    const totals = database.prepare(`
      SELECT COUNT(*) AS messages, COUNT(DISTINCT user_id) AS authors,
      COALESCE(SUM(word_count), 0) AS words FROM message_activity WHERE guild_id = ?
    `).get(guildId);
    const joins = database.prepare("SELECT COUNT(*) AS count FROM member_events WHERE guild_id = ? AND event_type = 'join'").get(guildId).count;
    const leaves = database.prepare("SELECT COUNT(*) AS count FROM member_events WHERE guild_id = ? AND event_type = 'leave'").get(guildId).count;
    const voice = database.prepare("SELECT COUNT(*) AS count FROM voice_activity WHERE guild_id = ?").get(guildId).count;
    return interaction.reply({ embeds: [new EmbedBuilder().setTitle(`${name === "cloud" ? "zy cloud" : "Stored analytics"} • ${guild.name}`).setColor(0x5865f2).addFields(
      { name: "Messages", value: String(totals.messages), inline: true }, { name: "Authors", value: String(totals.authors), inline: true },
      { name: "Words", value: String(totals.words), inline: true }, { name: "Joins", value: String(joins), inline: true },
      { name: "Leaves", value: String(leaves), inline: true }, { name: "Voice sessions", value: String(voice), inline: true },
    )] });
  }
  if (name === "topmessages" || name === "topwords") {
    const limit = interaction.options.getInteger("limit") || 10;
    const expression = name === "topmessages" ? "COUNT(*)" : "COALESCE(SUM(word_count), 0)";
    const label = name === "topmessages" ? "messages" : "words";
    const rows = database.prepare(`SELECT user_id, ${expression} AS total FROM message_activity WHERE guild_id = ? GROUP BY user_id ORDER BY total DESC LIMIT ?`).all(guildId, limit);
    return interaction.reply(rows.length ? rows.map((row, index) => `${index + 1}. <@${row.user_id}> — **${row.total}** ${label}`).join("\n") : `No stored ${label} yet.`);
  }
  if (name === "wordcloud") {
    const limit = interaction.options.getInteger("limit") || 15;
    const rows = database.prepare("SELECT content FROM message_activity WHERE guild_id = ?").all(guildId);
    const counts = new Map();
    for (const row of rows) {
      for (const word of row.content.toLowerCase().match(/[a-z][a-z'-]{2,}/g) || []) counts.set(word, (counts.get(word) || 0) + 1);
    }
    const common = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
    return interaction.reply(common.length ? common.map(([word, count], index) => `${index + 1}. \`${word}\` — **${count}**`).join("\n") : "No stored words yet.");
  }
  if (name === "joins" || name === "leaves") {
    const type = name === "joins" ? "join" : "leave";
    const rows = database.prepare("SELECT user_id, occurred_at FROM member_events WHERE guild_id = ? AND event_type = ? ORDER BY id DESC LIMIT 20").all(guildId, type);
    return interaction.reply(rows.length ? rows.map((row) => `<@${row.user_id}> — <t:${Math.floor(new Date(row.occurred_at).getTime() / 1000)}:R>`).join("\n") : `No stored ${type} events yet.`);
  }
  if (name === "voiceactivity") {
    const limit = interaction.options.getInteger("limit") || 10;
    const rows = database.prepare(`
      SELECT user_id, SUM(CASE WHEN left_at IS NULL THEN (julianday('now') - julianday(joined_at)) * 86400
      ELSE (julianday(left_at) - julianday(joined_at)) * 86400 END) AS seconds
      FROM voice_activity WHERE guild_id = ? GROUP BY user_id ORDER BY seconds DESC LIMIT ?
    `).all(guildId, limit);
    return interaction.reply(rows.length ? rows.map((row, index) => `${index + 1}. <@${row.user_id}> — **${Math.floor(row.seconds / 3600)}h ${Math.floor(row.seconds / 60) % 60}m**`).join("\n") : "No stored voice activity yet.");
  }
  const limit = interaction.options.getInteger("limit") || 15;
  const rows = database.prepare(`
    SELECT user_id, channel_id, edited_at, deleted_at FROM message_activity
    WHERE guild_id = ? AND (edited_at IS NOT NULL OR deleted_at IS NOT NULL)
    ORDER BY id DESC LIMIT ?
  `).all(guildId, limit);
  return interaction.reply(rows.length ? rows.map((row) => `<@${row.user_id}> in <#${row.channel_id}> — ${row.deleted_at ? "deleted" : "edited"}`).join("\n") : "No stored edits or deletions yet.");
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function handleLegacyInteraction(interaction) {
  const { commandName: name, guild, member, user } = interaction;
  const options = interaction.options;
  if (name === "list" || name === "disallow") {
    if (!config.ownerUsers.has(user.id)) return interaction.reply({ content: "Owner only. Add your ID to OWNER_USER_IDS.", ephemeral: true });
    if (name === "list") return interaction.reply(`Allowlisted users: ${[...config.allowedUsers].map((id) => `<@${id}>`).join(", ") || "None"}`);
    const target = options.getUser("user");
    config.allowedUsers.delete(target.id);
    return interaction.reply(`Removed ${target} from the process allowlist.`);
  }
  if (!PUBLIC_COMMANDS.has(name) && !canManage(member)) {
    return interaction.reply({ content: "You need Administrator permission or an allowlisted role/user.", ephemeral: true });
  }

  if (name === "ping") return interaction.reply(`Pong! \`${Math.round(client.ws.ping)}ms\``);
  if (name === "uptime") {
    const total = Math.floor(process.uptime());
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    return interaction.reply(`**Uptime:** ${days}d ${hours}h ${minutes}m ${seconds}s`);
  }
  if (name === "urban") {
    const query = options.getString("query");
    const url = query
      ? `https://api.urbandictionary.com/v0/define?term=${encodeURIComponent(query)}`
      : "https://api.urbandictionary.com/v0/random";
    try {
      const data = await fetchJson(url);
      const definition = data.list?.[0];
      if (!definition) return interaction.reply("Definition not found.");
      return interaction.reply({ embeds: [new EmbedBuilder().setTitle(`Urban Dictionary: ${definition.word}`).setURL(definition.permalink).setDescription(safeDescription(definition.definition)).setColor(0x0049d4).addFields({ name: "Example", value: safeDescription(definition.example) }, { name: "Votes", value: `👍 ${definition.thumbs_up || 0} | 👎 ${definition.thumbs_down || 0}` })] });
    } catch {
      return interaction.reply("Urban Dictionary is unavailable right now.");
    }
  }
  if (name === "suggest") {
    const channel = options.getChannel("channel") || (config.suggestionChannelId ? await guild.channels.fetch(config.suggestionChannelId).catch(() => null) : null);
    if (!channel?.isTextBased()) return interaction.reply({ content: "No suggestion channel is configured.", ephemeral: true });
    await channel.send(`New suggestion from ${user}: ${options.getString("suggestion")}`);
    return interaction.reply("Your suggestion has been submitted.");
  }
  if (name === "snipe") {
    const snipe = state.snipes.get(interaction.channelId);
    if (!snipe) return interaction.reply("No deleted messages to snipe.");
    return interaction.reply({ embeds: [new EmbedBuilder().setAuthor({ name: snipe.author, iconURL: snipe.avatar }).setDescription(safeDescription(`\`\`\`${snipe.content || "[attachment only]"}\`\`\``)).setColor(0x9b59b6).setTimestamp(snipe.deletedAt)] });
  }
  if (name === "whois" || name === "userinfo") {
    const targetUser = options.getUser(name === "whois" ? "member" : "user") || user;
    const target = await guild.members.fetch(targetUser.id).catch(() => null);
    if (!target) return interaction.reply({ content: "Member not found.", ephemeral: true });
    const embed = memberEmbed(target, `User Information - ${target.user.tag}`)
      .addFields(
        { name: "ID", value: target.id, inline: true },
        { name: "Nickname", value: target.nickname || "None", inline: true },
        { name: "Account created", value: `<t:${Math.floor(target.user.createdTimestamp / 1000)}:F>`, inline: false },
        { name: "Joined server", value: target.joinedTimestamp ? `<t:${Math.floor(target.joinedTimestamp / 1000)}:F>` : "Unknown", inline: false },
        { name: "Roles", value: target.roles.cache.filter((role) => role.id !== guild.id).map((role) => role.toString()).join(", ") || "None", inline: false },
        { name: "Bot", value: target.user.bot ? "Yes" : "No", inline: true },
      );
    return interaction.reply({ embeds: [embed] });
  }
  if (name === "roleinfo") {
    const role = options.getRole("role");
    return interaction.reply({ embeds: [new EmbedBuilder().setTitle("Role Info").setColor(role.color || 0x00ffff).addFields(
      { name: "ID", value: role.id, inline: true }, { name: "Name", value: role.name, inline: true },
      { name: "Members", value: String(role.members.size), inline: true }, { name: "Position", value: String(role.position), inline: true },
      { name: "Mentionable", value: role.mentionable ? "Yes" : "No", inline: true }, { name: "Managed", value: role.managed ? "Yes" : "No", inline: true },
    )] });
  }
  if (name === "botinfo") {
    return interaction.reply({ embeds: [new EmbedBuilder().setTitle("Bot Information").setColor(0xed4245).addFields(
      { name: "Name", value: client.user.tag, inline: false }, { name: "Runtime", value: "JavaScript / Node.js", inline: false },
      { name: "Servers", value: String(client.guilds.cache.size), inline: true }, { name: "Commands", value: String(commands.length), inline: true },
    )] });
  }
  if (name === "stats") {
    return interaction.reply({ embeds: [new EmbedBuilder().setTitle(`Guild information for ${guild.name}`).setColor(0x5865f2).addFields(
      { name: "Owner", value: `<@${guild.ownerId}>`, inline: true }, { name: "Members", value: String(guild.memberCount), inline: true },
      { name: "Roles", value: String(guild.roles.cache.size), inline: true }, { name: "Emojis", value: String(guild.emojis.cache.size), inline: true },
      { name: "Channels", value: String(guild.channels.cache.size), inline: true }, { name: "Boosts", value: String(guild.premiumSubscriptionCount || 0), inline: true },
      { name: "Verification", value: String(guild.verificationLevel), inline: true }, { name: "Bots", value: String(guild.members.cache.filter((m) => m.user.bot).size), inline: true },
    )] });
  }
  if (name === "randommember") {
    const members = guild.members.cache.filter((candidate) => !candidate.user.bot);
    const target = [...members.values()][Math.floor(Math.random() * members.size)];
    return interaction.reply(target ? `${target} was randomly selected.` : "No non-bot members are available.");
  }
  if (name === "memberinsights") {
    const target = await guild.members.fetch(options.getUser("member")?.id || user.id).catch(() => null);
    if (!target) return interaction.reply("Member not found.");
    return interaction.reply({ embeds: [memberEmbed(target, `Member insights: ${target.displayName}`).addFields(
      { name: "Account created", value: `<t:${Math.floor(target.user.createdTimestamp / 1000)}:F>`, inline: false },
      { name: "Joined server", value: target.joinedTimestamp ? `<t:${Math.floor(target.joinedTimestamp / 1000)}:F>` : "Unknown", inline: false },
      { name: "Roles", value: target.roles.cache.filter((role) => role.id !== guild.id).map((role) => role.toString()).join(", ") || "None", inline: false },
      { name: "Top role", value: target.roles.highest.toString(), inline: true },
    )] });
  }
  if (name === "serverhealth") {
    const me = guild.members.me;
    const permissions = ["ViewChannel", "SendMessages", "EmbedLinks", "ReadMessageHistory"];
    const missing = permissions.filter((permission) => !me?.permissions.has(PermissionsBitField.Flags[permission]));
    return interaction.reply({ embeds: [new EmbedBuilder().setTitle(`Server health: ${guild.name}`).setColor(missing.length ? 0xffa000 : 0x35d07f).addFields(
      { name: "Members", value: String(guild.memberCount), inline: true }, { name: "Channels", value: String(guild.channels.cache.size), inline: true },
      { name: "Roles", value: String(guild.roles.cache.size), inline: true }, { name: "Boost level", value: String(guild.premiumTier), inline: true },
      { name: "Bot permissions", value: missing.length ? `Missing: ${missing.join(", ")}` : "All core permissions available", inline: false },
    )] });
  }
  if (name === "channelpulse") {
    const channel = options.getChannel("channel") || interaction.channel;
    if (!channel?.isTextBased() || !channel.messages) return interaction.reply("Choose a text channel.");
    const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    if (!messages) return interaction.reply("Could not read that channel.");
    const authors = new Map();
    let attachments = 0;
    for (const message of messages.values()) {
      if (!message.author.bot) authors.set(message.author.id, (authors.get(message.author.id) || 0) + 1);
      attachments += message.attachments.size;
    }
    const top = [...authors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id, count], index) => `${index + 1}. <@${id}> — ${count}`).join("\n") || "None";
    return interaction.reply({ embeds: [new EmbedBuilder().setTitle(`Channel pulse: #${channel.name}`).setDescription("Read-only snapshot of the latest 100 messages.").addFields(
      { name: "Messages sampled", value: String(messages.size), inline: true }, { name: "Attachments", value: String(attachments), inline: true }, { name: "Top contributors", value: top, inline: false },
    )] });
  }
  if (name === "serverreport") {
    return interaction.reply({ embeds: [new EmbedBuilder().setTitle(`Server report: ${guild.name}`).addFields(
      { name: "Created", value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:F>`, inline: false },
      { name: "Members", value: String(guild.memberCount), inline: true }, { name: "Text channels", value: String(guild.channels.cache.filter((c) => c.isTextBased()).size), inline: true },
      { name: "Voice channels", value: String(guild.channels.cache.filter((c) => c.isVoiceBased()).size), inline: true }, { name: "Emojis", value: String(guild.emojis.cache.size), inline: true },
      { name: "Features", value: guild.features.slice(0, 10).join(", ") || "None", inline: false },
    )] });
  }
  if (name === "roleinsights") {
    const roles = [...guild.roles.cache.values()].filter((role) => role.id !== guild.id).sort((a, b) => b.members.size - a.members.size).slice(0, 10);
    return interaction.reply({ embeds: [new EmbedBuilder().setTitle(`Role insights: ${guild.name}`).setDescription(roles.map((role, index) => `${index + 1}. ${role} — **${role.members.size}** members`).join("\n") || "No custom roles found.").addFields(
      { name: "Total roles", value: String(guild.roles.cache.size - 1), inline: true }, { name: "Managed roles", value: String(guild.roles.cache.filter((role) => role.managed).size), inline: true },
    )] });
  }
  if (name === "memberactivity") {
    const target = options.getUser("member") || user;
    const limit = options.getInteger("limit") || 100;
    const messages = await interaction.channel.messages.fetch({ limit }).catch(() => null);
    const found = messages ? [...messages.values()].filter((message) => message.author.id === target.id) : [];
    return interaction.reply(`Messages by ${target} in this channel: **${found.length}**\\nAttachments: **${found.reduce((sum, message) => sum + message.attachments.size, 0)}**`);
  }
  if (name === "voiceinsights") {
    const channels = guild.voiceStates.cache.reduce((map, state) => {
      if (state.channel) map.set(state.channel.id, (map.get(state.channel.id) || 0) + 1);
      return map;
    }, new Map());
    return interaction.reply([...channels.entries()].map(([id, count]) => `<#${id}> — **${count}** connected`).join("\n") || "Nobody is currently in a voice channel.");
  }
  if (["analytics", "cloud", "topmessages", "topwords", "wordcloud", "joins", "leaves", "voiceactivity", "messagechanges"].includes(name)) {
    return handleAnalyticsCommand(interaction, name);
  }
  if (name === "timezone") {
    const aliases = { london: "Europe/London", "new york": "America/New_York", nyc: "America/New_York", tokyo: "Asia/Tokyo", utc: "UTC", india: "Asia/Kolkata" };
    const location = options.getString("location").trim();
    const zone = aliases[location.toLowerCase()] || location;
    try {
      const formatted = new Intl.DateTimeFormat("en-GB", { timeZone: zone, dateStyle: "full", timeStyle: "long" }).format(new Date());
      return interaction.reply(`**${location}:** ${formatted}`);
    } catch { return interaction.reply("Unknown timezone. Try `London`, `Tokyo`, `UTC`, or an IANA timezone."); }
  }
  if (name === "define") {
    const word = options.getString("word").trim();
    try {
      const data = await fetchJson(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
      const lines = (data[0]?.meanings || []).slice(0, 3).flatMap((meaning) => meaning.definitions.slice(0, 1).map((definition) => `**${meaning.partOfSpeech}** — ${definition.definition}`));
      return interaction.reply({ embeds: [new EmbedBuilder().setTitle(`Definition: ${data[0]?.word || word}`).setDescription(lines.join("\n") || "No definition returned.")] });
    } catch { return interaction.reply(`No definition found for \`${word}\`.`); }
  }
  if (name === "poll") {
    const choices = options.getString("options").split(",").map((choice) => choice.trim()).filter(Boolean);
    if (choices.length < 2 || choices.length > 10) return interaction.reply({ content: "Provide 2-10 comma-separated options.", ephemeral: true });
    const emojis = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];
    const message = await interaction.reply({ content: `**${options.getString("question")}**\n${choices.map((choice, index) => `${emojis[index]} ${choice}`).join("\n")}`, fetchReply: true });
    for (let index = 0; index < choices.length; index += 1) await message.react(emojis[index]).catch(() => {});
    return;
  }
  if (name === "remind") {
    const seconds = parseDuration(options.getString("duration"));
    if (!seconds || seconds > 30 * 86400) return interaction.reply({ content: "Use a duration such as `10m`, `2h`, or `1d` (maximum 30 days).", ephemeral: true });
    await interaction.reply(`Reminder set for **${options.getString("duration")}**.`);
    setTimeout(async () => {
      await user.send(`⏰ Reminder: ${options.getString("message")}`).catch(() => interaction.followUp(`⏰ ${user}, reminder: ${options.getString("message")}`));
    }, seconds * 1000);
    return;
  }
  if (name === "warn" || name === "warns") {
    const target = name === "warn" ? await guild.members.fetch(options.getUser("member").id).catch(() => null) : (await guild.members.fetch(options.getUser("member")?.id || user.id).catch(() => null));
    if (!target) return interaction.reply({ content: "Member not found.", ephemeral: true });
    const key = `${guild.id}:${target.id}`;
    if (name === "warns") {
      const warnings = state.warnings.get(key) || [];
      return interaction.reply(warnings.length ? `Warnings for ${target}:\\n${warnings.map((warning, index) => `${index + 1}. ${warning}`).join("\\n")}` : `${target} has no warnings.`);
    }
    const reason = options.getString("reason");
    const warnings = state.warnings.get(key) || [];
    warnings.push(reason);
    state.warnings.set(key, warnings);
    if (warnings.length >= 3) {
      const mutedRole = getMutedRole(guild);
      if (mutedRole && target.manageable) await target.roles.add(mutedRole, "Reached three warnings").catch(() => {});
    }
    return interaction.reply(`${target} has been warned. Total warnings: **${warnings.length}**.`);
  }
  if (name === "kick" || name === "ban") {
    const target = await guild.members.fetch(options.getUser("member").id).catch(() => null);
    if (!target) return interaction.reply({ content: "Member not found.", ephemeral: true });
    const reason = options.getString("reason") || "No reason provided";
    const success = name === "kick"
      ? await target.kick(reason).then(() => true).catch(() => false)
      : await target.ban({ reason, deleteMessageSeconds: 0 }).then(() => true).catch(() => false);
    return interaction.reply(success ? `${target} was ${name}ed. Reason: ${reason}` : `Could not ${name} ${target}. Check my permissions and role position.`);
  }
  if (name === "unban") {
    const userId = options.getString("user_id");
    const target = await client.users.fetch(userId).catch(() => null);
    if (!target) return interaction.reply({ content: "User not found.", ephemeral: true });
    const success = await guild.members.unban(target, "Manual unban").then(() => true).catch(() => false);
    return interaction.reply(success ? `${target.tag} was unbanned.` : "Could not unban that user. Check my permissions and the ID.");
  }
  if (name === "mute" || name === "tempmute" || name === "unmute") {
    const target = await guild.members.fetch(options.getUser("member").id).catch(() => null);
    const role = getMutedRole(guild);
    if (!target || !role) return interaction.reply({ content: target ? "Create a role named `Muted` first." : "Member not found.", ephemeral: true });
    if (name === "unmute") {
      await target.roles.remove(role, "Manual unmute").catch(() => {});
      return interaction.reply(`${target} has been unmuted.`);
    }
    const seconds = name === "tempmute" ? options.getInteger("minutes") * 60 : parseDuration(options.getString("duration"));
    if (name === "mute" && options.getString("duration") && !seconds) return interaction.reply({ content: "Use a duration like `10m`, `2h`, or `1d`.", ephemeral: true });
    await target.roles.add(role, options.getString("reason") || "Manual mute").catch(() => {});
    if (!seconds) return interaction.reply(`${target} has been muted.`);
    setTimeout(() => target.roles.remove(role, "Mute duration expired").catch(() => {}), seconds * 1000);
    return interaction.reply(`${target} has been muted for ${seconds < 3600 ? `${Math.ceil(seconds / 60)} minutes` : `${(seconds / 3600).toFixed(1)} hours`}.`);
  }
  if (name === "muterole") {
    const action = options.getString("action");
    const roleName = options.getString("name");
    if (action === "create") {
      if (guild.roles.cache.some((role) => role.name === roleName)) return interaction.reply("A role with that name already exists.");
      const role = await guild.roles.create({ name: roleName, permissions: [], reason: "Mute role setup" });
      return interaction.reply(`Created muted role ${role}. Apply channel denies to it if needed.`);
    }
    const role = guild.roles.cache.find((candidate) => candidate.name === roleName);
    return interaction.reply(role ? `Using ${role}. Rename it to \`Muted\` for mute commands.` : "Role not found.");
  }
  if (name === "delete") {
    const role = options.getRole("role");
    const success = role.editable && await role.delete("Manual role deletion").then(() => true).catch(() => false);
    return interaction.reply(success ? `Deleted **${role.name}**.` : "I cannot delete that role.");
  }
  if (name === "mock") return interaction.reply(options.getString("message").split("").map((char, index) => index % 2 ? char.toLowerCase() : char.toUpperCase()).join(""));
  if (name === "eball") return interaction.reply(["Yes.", "No.", "Maybe.", "Ask again later.", "Definitely.", "Probably not."][Math.floor(Math.random() * 6)]);
  if (name === "say") return interaction.reply({ content: options.getString("message"), allowedMentions: { parse: [] } });
  if (name === "mimic") {
    state.mimicUsers.add(user.id);
    return interaction.reply("Mimic mode enabled. Use `/stop` to disable it.");
  }
  if (name === "stop") {
    state.mimicUsers.delete(user.id);
    return interaction.reply("Mimic mode disabled.");
  }
  if (name === "afk") {
    state.afkUsers.set(user.id, options.getString("reason") || "No reason provided");
    return interaction.reply(`You are now AFK: ${state.afkUsers.get(user.id)}`);
  }
  if (name === "purge") {
    const deleted = await interaction.channel.bulkDelete(options.getInteger("amount"), true).catch(() => null);
    return interaction.reply({ content: deleted ? `Deleted ${deleted.size} messages.` : "I could not delete those messages.", ephemeral: true });
  }
  if (name === "av") {
    const target = options.getUser("member") || user;
    return interaction.reply({ embeds: [new EmbedBuilder().setTitle(`${target.tag}'s avatar`).setImage(target.displayAvatarURL({ size: 1024 })).setColor(0x5865f2)] });
  }
  if (name === "analyse") {
    const quote = options.getString("quote");
    const words = quote.match(/\b[\w'-]+\b/g) || [];
    return interaction.reply(`**Analysis**\\nWords: ${words.length}\\nCharacters: ${quote.length}\\nUppercase letters: ${(quote.match(/[A-Z]/g) || []).length}\\nLowercase letters: ${(quote.match(/[a-z]/g) || []).length}`);
  }
  if (name === "wl") {
    const target = options.getUser("user");
    if (config.allowedUsers.has(target.id)) config.allowedUsers.delete(target.id);
    else config.allowedUsers.add(target.id);
    return interaction.reply(`${target} is now ${config.allowedUsers.has(target.id) ? "allowlisted" : "removed from the allowlist"} for this process.`);
  }
  if (name === "bl" || name === "unbl" || name === "status") {
    if (!state.blacklist) state.blacklist = { users: new Map(), guilds: new Map() };
    if (name === "status") return interaction.reply(`Allowlisted users: **${config.allowedUsers.size}**\\nBlacklisted users: **${state.blacklist.users.size}**\\nBlacklisted guilds: **${state.blacklist.guilds.size}**`);
    if (name === "unbl") { state.blacklist.users.clear(); state.blacklist.guilds.clear(); return interaction.reply("Blacklist cleared."); }
    const type = options.getString("target_type");
    state.blacklist[type === "user" ? "users" : "guilds"].set(options.getString("target"), options.getString("reason") || "Not specified");
    return interaction.reply(`${type} \`${options.getString("target")}\` was added to the blacklist.`);
  }
  if (name === "secret") return interaction.reply({ embeds: [new EmbedBuilder().setTitle("zy command reference").setDescription("Use `/help` for active commands. Security automation runs automatically; destructive mass-action commands from the legacy bot are intentionally not included.").setColor(0x5865f2)] });
  if (name === "weather") {
    if (!config.weatherApiKey) return interaction.reply({ content: "Weather is not configured. Add OPENWEATHER_API_KEY to `.env`.", ephemeral: true });
    const location = options.getString("location");
    try {
      const places = await fetchJson(`https://api.openweathermap.org/geo/1.0/direct?q=${encodeURIComponent(location)}&limit=1&appid=${config.weatherApiKey}`);
      if (!places[0]) return interaction.reply("No weather location found.");
      const weather = await fetchJson(`https://api.openweathermap.org/data/2.5/weather?lat=${places[0].lat}&lon=${places[0].lon}&units=metric&appid=${config.weatherApiKey}`);
      return interaction.reply({ embeds: [new EmbedBuilder().setTitle(`Weather in ${places[0].name}`).setColor(0x00aa55).addFields(
        { name: "Status", value: weather.weather?.[0]?.description || "Unknown", inline: true },
        { name: "Temperature", value: `${weather.main.temp}°C`, inline: true },
        { name: "Humidity", value: `${weather.main.humidity}%`, inline: true },
        { name: "Wind", value: `${weather.wind?.speed || 0} m/s`, inline: true },
      )] });
    } catch {
      return interaction.reply("Weather lookup failed.");
    }
  }
  if (name === "invite") {
    const url = `https://discord.com/oauth2/authorize?client_id=${client.user.id}&scope=bot%20applications.commands&permissions=8`;
    return interaction.reply({ embeds: [new EmbedBuilder().setTitle(`Invite ${client.user.username}`).setDescription(`[Click here to invite the bot](${url})`).setColor(0x5865f2)] });
  }
  if (name === "servers") {
    if (!config.ownerUsers.has(user.id)) return interaction.reply({ content: "Owner only.", ephemeral: true });
    return interaction.reply({ content: client.guilds.cache.map((g) => `**${g.name}** — ${g.memberCount} members — \`${g.id}\``).join("\n").slice(0, 4000) || "No servers." });
  }
  if (name === "inv") {
    if (!config.ownerUsers.has(user.id)) return interaction.reply({ content: "Owner only.", ephemeral: true });
    const query = options.getString("server");
    const target = client.guilds.cache.get(query) || client.guilds.cache.find((g) => g.name === query);
    if (!target) return interaction.reply({ content: "Server not found.", ephemeral: true });
    const channel = target.channels.cache.find((c) => c.isTextBased() && c.permissionsFor(target.members.me)?.has(PermissionsBitField.Flags.CreateInstantInvite));
    const invite = await channel?.createInvite({ maxAge: 0, maxUses: 0, reason: "Owner invite command" }).catch(() => null);
    return interaction.reply(invite ? invite.url : "Could not create an invite.");
  }
  if (name === "calc") {
    const expression = options.getString("expression");
    if (!/^[0-9+*/%().\s-]+$/.test(expression)) return interaction.reply({ content: "Only basic arithmetic is allowed.", ephemeral: true });
    try { return interaction.reply(`\`\`\`${Function(`"use strict"; return (${expression})`)()}\`\`\``); } catch { return interaction.reply("Invalid expression."); }
  }
  if (name === "hug" || name === "kiss") {
    try {
      const data = await fetchJson(`https://nekos.life/api/${name}`);
      return interaction.reply({ embeds: [new EmbedBuilder().setTitle(`${user.username} ${name}ed ${options.getUser("user").username}`).setImage(data.url).setColor(name === "hug" ? 0x00ff00 : 0xff00ff)] });
    } catch { return interaction.reply("The image service is unavailable."); }
  }
  if (name === "emotions") return interaction.reply("Available commands: `/hug` and `/kiss`.");
  if (name === "youtube") return interaction.reply(`YouTube search: https://www.youtube.com/results?search_query=${encodeURIComponent(options.getString("query"))}`);
  if (name === "leave") {
    if (!config.ownerUsers.has(user.id)) return interaction.reply({ content: "Owner only.", ephemeral: true });
    const target = client.guilds.cache.get(options.getString("server_id"));
    if (!target) return interaction.reply("Server not found.");
    await target.leave();
    return interaction.reply(`Left **${target.name}**.`);
  }
  if (name === "banlist") {
    const bans = await guild.bans.fetch().catch(() => null);
    return interaction.reply(bans?.size ? `**Ban list:**\\n${[...bans.values()].slice(0, 50).map((ban) => `• ${ban.user.tag} (${ban.user.id})`).join("\n")}` : "This server has no bans.");
  }
  if (name === "role") {
    const action = options.getString("action");
    const roleName = options.getString("name");
    if (action === "delete") {
      const role = guild.roles.cache.find((candidate) => candidate.name === roleName);
      if (!role) return interaction.reply("Role not found.");
      await role.delete("Manual role deletion").catch(() => {});
      return interaction.reply(`Deleted role **${roleName}**.`);
    }
    const role = await guild.roles.create({ name: roleName, color: options.getString("colour") || undefined, mentionable: options.getBoolean("mentionable") || false, reason: "Manual role creation" }).catch(() => null);
    return interaction.reply(role ? `Created role ${role}.` : "Could not create the role.");
  }
  return false;
}

async function sendLogEmbed(guild, embed) {
  let channel = config.logChannelId ? await guild.channels.fetch(config.logChannelId).catch(() => null) : null;
  if (!channel?.isTextBased()) {
    channel = await ensureLogChannel(guild);
    if (channel) {
      console.log(`[${guild.name}] zy recreated the missing log channel (${channel.id}).`);
      await channel.send({
        embeds: [new EmbedBuilder()
          .setTitle("zy logging restored")
          .setDescription("The configured log channel was missing, so zy created a replacement and resumed logging.")
          .setColor(0x35d07f)
          .setTimestamp()],
      }).catch((error) => console.error(`[${guild.name}] Could not write log-recovery event: ${error.message}`));
    }
  }
  if (channel?.isTextBased()) {
    await channel.send({ embeds: [embed] }).catch((error) => console.error(`[${guild.name}] Log send failed: ${error.message}`));
    return true;
  }
  console.error(`[${guild.name}] zy could not create or access a log channel.`);
  return false;
}

async function log(guild, title, description, color = 0xff4654, fields = []) {
  const embed = new EmbedBuilder().setTitle(title).setDescription(description).setColor(color)
    .setTimestamp().addFields(fields);
  const key = `${guild.id}:${title}:${description}`;
  const now = Date.now();
  const existing = state.logBuckets.get(key);
  if (existing && now - existing.lastSeen < config.logDedupeWindowMs) {
    existing.count += 1;
    existing.lastSeen = now;
    if (!existing.timer) {
      existing.timer = setTimeout(async () => {
        state.logBuckets.delete(key);
        const suppressed = existing.count - 1;
        if (suppressed > 0) {
          const summary = new EmbedBuilder()
            .setTitle("zy log summary")
            .setDescription(`Repeated event was coalesced to reduce channel flooding.`)
            .setColor(0x99aab5)
            .addFields(
              { name: "Event", value: title, inline: true },
              { name: "Suppressed duplicates", value: String(suppressed), inline: true },
              { name: "Details", value: description.slice(0, 1000), inline: false },
            )
            .setTimestamp();
          await sendLogEmbed(guild, summary);
          console.log(`[${guild.name}] zy log summary: suppressed ${suppressed} duplicate "${title}" events.`);
        }
      }, config.logDedupeWindowMs);
    }
    return;
  }
  if (existing?.timer) clearTimeout(existing.timer);
  state.logBuckets.set(key, { count: 1, lastSeen: now, timer: null });
  await sendLogEmbed(guild, embed);
  console.log(`[${guild.name}] ${title}: ${description}`);
}

async function logAction(guild, action, result, actor, target = "N/A", reason = "N/A") {
  return log(guild, "zy action log", `${action}\n**Result:** ${result}`, 0x5865f2, [
    { name: "Actor", value: actor || "zy automated protection", inline: true },
    { name: "Target", value: target, inline: true },
    { name: "Reason", value: reason, inline: false },
  ]);
}

function persistEnvValue(key, value) {
  const envPath = path.resolve(__dirname, "..", ".env");
  const current = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  const line = `${key}=${value}`;
  const matcher = new RegExp(`^${key}=.*$`, "m");
  fs.writeFileSync(envPath, matcher.test(current) ? current.replace(matcher, line) : `${current.trimEnd()}\n${line}\n`);
}

async function ensureLogChannel(guild) {
  if (!guild.members.me?.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
    console.error(`[${guild.name}] Missing Manage Channels; cannot recreate the log channel.`);
    return null;
  }
  const category = guild.channels.cache.find((channel) => channel.type === 4 && channel.name === "guardian-security");
  const existing = guild.channels.cache.find((channel) =>
    channel.isTextBased() && channel.name === "guardian-logs" && (!category || channel.parentId === category.id));
  if (existing) {
    config.logChannelId = existing.id;
    persistEnvValue("LOG_CHANNEL_ID", existing.id);
    return existing;
  }
  const parent = category || await guild.channels.create({
    name: "guardian-security",
    type: 4,
    permissionOverwrites: [{ id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] }],
    reason: "zy logging recovery",
  }).catch((error) => {
    console.error(`[${guild.name}] Could not create logging category: ${error.message}`);
    return null;
  });
  if (!parent) return null;
  const channel = await guild.channels.create({
    name: "guardian-logs",
    type: 0,
    parent: parent.id,
    topic: "zy security and action audit log. Do not delete.",
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
      { id: guild.members.me.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.EmbedLinks] },
    ],
    reason: "zy logging recovery",
  }).catch((error) => {
    console.error(`[${guild.name}] Could not recreate log channel: ${error.message}`);
    return null;
  });
  if (channel) {
    config.logChannelId = channel.id;
    persistEnvValue("LOG_CHANNEL_ID", channel.id);
  }
  return channel;
}

function saveGuildBackup(guild) {
  if (state.guildBackups[guild.id]) {
    persistGuildIdentity(guild.id, state.guildBackups[guild.id]);
    return state.guildBackups[guild.id];
  }
  const backup = {
    name: config.backupGuildName || guild.name,
    iconUrl: config.backupGuildIconUrl || guild.iconURL({ extension: "png", size: 1024 }) || "",
    savedAt: new Date().toISOString(),
  };
  state.guildBackups[guild.id] = backup;
  persistGuildIdentity(guild.id, backup);
  return backup;
}

function persistGuildIdentity(guildId, identity) {
  database.prepare(`
    INSERT INTO guild_backups (guild_id, identity_json, snapshot_json, saved_at)
    VALUES (?, ?, COALESCE((SELECT snapshot_json FROM guild_backups WHERE guild_id = ?), NULL), ?)
    ON CONFLICT(guild_id) DO UPDATE SET
      identity_json = excluded.identity_json,
      saved_at = excluded.saved_at
  `).run(guildId, JSON.stringify(identity), guildId, new Date().toISOString());
}

function persistServerSnapshot(guildId, snapshot) {
  const savedAt = new Date().toISOString();
  database.prepare(`
    INSERT INTO guild_backups (guild_id, identity_json, snapshot_json, saved_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET
      snapshot_json = excluded.snapshot_json,
      saved_at = excluded.saved_at
  `).run(
    guildId,
    JSON.stringify(state.guildBackups[guildId] || {}),
    JSON.stringify(snapshot),
    savedAt,
  );
}

function describeBackupChanges(previous, current) {
  if (!previous) return ["initial automatic snapshot"];
  const changes = [];
  const fields = [
    ["name", "server name"],
    ["iconUrl", "server icon"],
    ["bannerUrl", "server banner"],
    ["splashUrl", "server splash"],
    ["discoverySplashUrl", "server discovery splash"],
    ["description", "server description"],
    ["verificationLevel", "verification level"],
    ["explicitContentFilter", "explicit content filter"],
    ["defaultMessageNotifications", "default notifications"],
    ["afkChannelId", "AFK channel"],
    ["afkTimeout", "AFK timeout"],
    ["systemChannelId", "system channel"],
    ["rulesChannelId", "rules channel"],
    ["publicUpdatesChannelId", "public updates channel"],
    ["preferredLocale", "preferred locale"],
    ["mfaLevel", "MFA level"],
    ["nsfwLevel", "NSFW level"],
    ["premiumTier", "premium tier"],
  ];
  for (const [field, label] of fields) {
    if (JSON.stringify(previous[field]) !== JSON.stringify(current[field])) changes.push(label);
  }
  for (const [field, label] of [
    ["roles", "roles"],
    ["channels", "channels and permission overwrites"],
    ["emojis", "emojis"],
    ["stickers", "stickers"],
    ["scheduledEvents", "scheduled events"],
    ["bans", "bans"],
    ["webhooks", "webhooks"],
  ]) {
    if (JSON.stringify(previous[field]) !== JSON.stringify(current[field])) changes.push(label);
  }
  return changes;
}

async function createServerBackup(guild) {
  const emojis = await guild.emojis.fetch().catch(() => new Map());
  const stickers = await guild.stickers.fetch().catch(() => new Map());
  const scheduledEvents = await guild.scheduledEvents.fetch().catch(() => new Map());
  const bans = guild.members.me.permissions.has(PermissionsBitField.Flags.BanMembers)
    ? await guild.bans.fetch().catch(() => new Map())
    : new Map();
  const webhooks = guild.members.me.permissions.has(PermissionsBitField.Flags.ManageWebhooks)
    ? await guild.fetchWebhooks().catch(() => new Map())
    : new Map();
  const backup = {
    formatVersion: 2,
    guildId: guild.id,
    name: guild.name,
    iconUrl: guild.iconURL({ extension: "png", size: 1024 }) || "",
    description: guild.description || null,
    bannerUrl: guild.bannerURL({ extension: "png", size: 2048 }) || "",
    splashUrl: guild.splashURL({ extension: "png", size: 2048 }) || "",
    discoverySplashUrl: guild.discoverySplashURL({ extension: "png", size: 2048 }) || "",
    verificationLevel: guild.verificationLevel,
    explicitContentFilter: guild.explicitContentFilter,
    defaultMessageNotifications: guild.defaultMessageNotifications,
    afkChannelId: guild.afkChannelId,
    afkTimeout: guild.afkTimeout,
    systemChannelId: guild.systemChannelId,
    rulesChannelId: guild.rulesChannelId,
    publicUpdatesChannelId: guild.publicUpdatesChannelId,
    preferredLocale: guild.preferredLocale,
    mfaLevel: guild.mfaLevel,
    nsfwLevel: guild.nsfwLevel,
    premiumTier: guild.premiumTier,
    features: [...guild.features],
    roles: guild.roles.cache.filter((role) => !role.managed && role.id !== guild.id).map((role) => ({
      id: role.id,
      name: role.name,
      color: role.hexColor,
      hoist: role.hoist,
      mentionable: role.mentionable,
      position: role.position,
      permissions: role.permissions.bitfield.toString(),
    })),
    channels: guild.channels.cache.sort((a, b) => a.position - b.position).map((channel) => ({
      id: channel.id,
      name: channel.name,
      type: channel.type,
      parentId: channel.parentId,
      position: channel.position,
      topic: "topic" in channel ? channel.topic : null,
      nsfw: "nsfw" in channel ? channel.nsfw : false,
      rateLimitPerUser: "rateLimitPerUser" in channel ? channel.rateLimitPerUser : 0,
      bitrate: "bitrate" in channel ? channel.bitrate : null,
      userLimit: "userLimit" in channel ? channel.userLimit : null,
      permissionOverwrites: channel.permissionOverwrites.cache.map((overwrite) => ({
        id: overwrite.id,
        type: overwrite.type,
        allow: overwrite.allow.bitfield.toString(),
        deny: overwrite.deny.bitfield.toString(),
      })),
    })),
    emojis: [...emojis.values()].map((emoji) => ({
      id: emoji.id,
      name: emoji.name,
      url: emoji.imageURL(),
      animated: emoji.animated,
      managed: emoji.managed,
      roles: [...emoji.roles.cache.keys()],
    })),
    stickers: [...stickers.values()].map((sticker) => ({
      id: sticker.id,
      name: sticker.name,
      description: sticker.description,
      tags: sticker.tags,
      format: sticker.format,
      type: sticker.type,
      url: sticker.url,
    })),
    scheduledEvents: [...scheduledEvents.values()].map((event) => ({
      id: event.id,
      name: event.name,
      description: event.description,
      scheduledStartAt: event.scheduledStartAt,
      scheduledEndAt: event.scheduledEndAt,
      privacyLevel: event.privacyLevel,
      status: event.status,
      entityType: event.entityType,
      entityId: event.entityId,
      channelId: event.channelId,
      entityMetadata: event.entityMetadata,
    })),
    bans: [...bans.values()].map((ban) => ({
      userId: ban.user.id,
      username: ban.user.username,
      discriminator: ban.user.discriminator,
      reason: ban.reason || null,
    })),
    webhooks: [...webhooks.values()].map((webhook) => ({
      id: webhook.id,
      name: webhook.name,
      type: webhook.type,
      channelId: webhook.channelId,
      ownerId: webhook.owner?.id || null,
    })),
    savedAt: new Date().toISOString(),
  };
  state.serverBackups[guild.id] = backup;
  persistServerSnapshot(guild.id, backup);
  return backup;
}

async function autosaveGuildSnapshot(guild, reason = "detected Discord change", announce = true) {
  if (!guild) return null;
  const previous = state.serverBackups[guild.id] || null;
  const backup = await createServerBackup(guild);
  const changes = describeBackupChanges(previous, backup);
  if (announce && previous && changes.length > 0) {
    await log(
      guild,
      "SERVER SETTINGS SNAPSHOT UPDATED",
      `Automatic backup saved after ${reason}.`,
      0x35d07f,
      [{ name: "Detected changes", value: changes.slice(0, 20).join(", "), inline: false }],
    );
  }
  return { backup, changes };
}

function scheduleGuildSnapshot(guild, reason) {
  if (!guild) return;
  const existing = state.backupTimers.get(guild.id);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(async () => {
    state.backupTimers.delete(guild.id);
    const previousQueue = state.backupQueues.get(guild.id) || Promise.resolve();
    const nextQueue = previousQueue
      .catch((error) => console.error(`[${guild.name}] Automatic backup failed: ${error.message}`))
      .then(() => autosaveGuildSnapshot(guild, reason))
      .catch((error) => console.error(`[${guild.name}] Automatic backup failed: ${error.message}`));
    state.backupQueues.set(guild.id, nextQueue);
    await nextQueue;
  }, 1500);
  state.backupTimers.set(guild.id, timer);
}

function startBackupMonitor() {
  const intervalMs = Math.max(config.backupScanIntervalMs, 30_000);
  setInterval(() => {
    for (const guild of client.guilds.cache.values()) {
      scheduleGuildSnapshot(guild, "periodic integrity scan");
    }
  }, intervalMs);
}

async function setupGuild(guild, actor) {
  saveGuildBackup(guild);
  if (!guild.members.me.permissions.has(PermissionsBitField.Flags.ManageChannels) ||
      !guild.members.me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
    throw new Error("Guardian needs Manage Channels and Manage Roles to run setup.");
  }
  let category = guild.channels.cache.find((channel) => channel.type === 4 && channel.name === "guardian-security");
  if (!category) category = await guild.channels.create({
    name: "guardian-security",
    type: 4,
    permissionOverwrites: [{ id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] }],
    reason: "Guardian setup",
  });
  let role = config.quarantineRoleId ? await guild.roles.fetch(config.quarantineRoleId).catch(() => null) : null;
  role ||= guild.roles.cache.find((candidate) => candidate.name === "Guardian Quarantine");
  if (!role) role = await guild.roles.create({
    name: "Guardian Quarantine",
    color: 0xff4654,
    hoist: false,
    mentionable: false,
    reason: "Guardian setup",
  });
  let logChannel = config.logChannelId ? await guild.channels.fetch(config.logChannelId).catch(() => null) : null;
  if (!logChannel) logChannel = guild.channels.cache.find((channel) => channel.name === "guardian-logs" && channel.parentId === category.id);
  if (!logChannel) logChannel = await guild.channels.create({
    name: "guardian-logs",
    type: 0,
    parent: category.id,
    topic: "Guardian security and action audit log. Do not delete.",
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
      { id: guild.members.me.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.EmbedLinks] },
    ],
    reason: "Guardian setup",
  });
  const protectedChannels = guild.channels.cache.filter((channel) => channel.isTextBased() && channel.id !== logChannel.id);
  for (const channel of protectedChannels.values()) {
    await channel.permissionOverwrites.edit(role, {
      ViewChannel: false,
      SendMessages: false,
      AddReactions: false,
      CreatePublicThreads: false,
      CreatePrivateThreads: false,
    }, { reason: "Guardian quarantine protection" }).catch(() => {});
  }
  config.logChannelId = logChannel.id;
  config.quarantineRoleId = role.id;
  persistEnvValue("LOG_CHANNEL_ID", logChannel.id);
  persistEnvValue("QUARANTINE_ROLE_ID", role.id);
  await logAction(guild, "Setup completed", "Created or reused Guardian category, log channel, and quarantine role.", actor?.tag || "Unknown administrator", `${logChannel.name} / ${role.name}`, "Manual setup command");
  return { category, role, logChannel };
}

async function quarantine(member, reason) {
  if (!member?.manageable || !config.quarantineRoleId || !config.autoQuarantine) return false;
  if (config.dryRun) {
    await logAction(member.guild, "Quarantine member", "Dry-run: no role change made", "Guardian automated protection", member.user.tag, reason);
    return true;
  }
  const added = await member.roles.add(config.quarantineRoleId, reason).then(() => true).catch(() => false);
  await log(member.guild, "Member quarantined", `${member.user.tag} (${member.id})\n${reason}`, 0xffa000);
  await logAction(member.guild, "Quarantine member", added ? "Role added" : "Failed to add role", "Guardian automated protection", member.user.tag, reason);
  return added;
}

async function stripNukeRoles(member, reason) {
  if (!config.autoStripNukeRoles || !member?.manageable) return 0;
  const dangerous = [
    PermissionsBitField.Flags.Administrator,
    PermissionsBitField.Flags.ManageGuild,
    PermissionsBitField.Flags.ManageChannels,
    PermissionsBitField.Flags.ManageRoles,
    PermissionsBitField.Flags.BanMembers,
    PermissionsBitField.Flags.KickMembers,
    PermissionsBitField.Flags.ManageWebhooks,
    PermissionsBitField.Flags.ManageMessages,
    PermissionsBitField.Flags.MentionEveryone,
    PermissionsBitField.Flags.ModerateMembers,
  ];
  const roles = member.roles.cache.filter((role) => role.id !== member.guild.id &&
    !role.managed && role.editable && dangerous.some((permission) => role.permissions.has(permission)));
  let removed = 0;
  for (const role of roles.values()) {
    const success = config.dryRun
      ? true
      : await member.roles.remove(role, reason).then(() => true).catch(() => false);
    if (success) removed += 1;
  }
  await logAction(member.guild, "Strip dangerous roles", config.dryRun ? `Dry-run: ${removed} roles identified` : `${removed} roles removed`, "Guardian", member.user.tag, reason);
  return removed;
}

async function setLockdown(guild, enabled, reason) {
  if (enabled) state.lockdowns.add(guild.id); else state.lockdowns.delete(guild.id);
  if (!config.dryRun) {
    const channels = guild.channels.cache.filter((channel) => channel.isTextBased() && channel.permissionsFor(guild.roles.everyone)?.has(PermissionsBitField.Flags.SendMessages));
    for (const channel of channels.values()) {
      await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: enabled ? false : null }, { reason }).catch(() => {});
    }
  }
  await log(guild, enabled ? "SERVER LOCKDOWN ENABLED" : "Server lockdown disabled", reason, enabled ? 0xff0000 : 0x35d07f);
  await logAction(guild, enabled ? "Enable lockdown" : "Disable lockdown", config.dryRun ? "Dry-run: no permission changes made" : "Completed", "Guardian", guild.name, reason);
}

function scheduleNukeUnlock(guild) {
  if (!config.autoUnlockAfterNuke || config.nukeLockdownMs <= 0) return;
  const existing = state.unlockTimers.get(guild.id);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(async () => {
    state.unlockTimers.delete(guild.id);
    if (!state.lockdowns.has(guild.id)) return;
    await setLockdown(guild, false, `Automatic unlock after ${config.nukeLockdownMs / 1000}s anti-nuke containment`);
    await logAction(guild, "Automatic nuke lockdown release", "Server unlocked after containment cooldown", "Guardian", guild.name, "Configured AUTO_UNLOCK_AFTER_NUKE");
  }, config.nukeLockdownMs);
  state.unlockTimers.set(guild.id, timer);
}

async function removeGuildWebhooks(guild, reason) {
  if (!guild.members.me.permissions.has(PermissionsBitField.Flags.ManageWebhooks)) {
    await logAction(guild, "Delete guild webhooks", "Skipped: missing Manage Webhooks permission", "Guardian", guild.name, reason);
    return 0;
  }
  const webhooks = await guild.fetchWebhooks().catch(() => null);
  if (!webhooks) return 0;
  let deleted = 0;
  for (const webhook of webhooks.values()) {
    const removed = config.dryRun ? true : await webhook.delete(reason).then(() => true).catch(() => false);
    if (removed) deleted += 1;
  }
  await logAction(guild, "Delete guild webhooks", config.dryRun ? `Dry-run: ${deleted} would be deleted` : `${deleted} deleted`, "Guardian", guild.name, reason);
  return deleted;
}

async function restoreGuildIdentity(guild, reason) {
  const backup = state.guildBackups[guild.id] || saveGuildBackup(guild);
  if (!backup.name && !backup.iconUrl) {
    await logAction(guild, "Restore server identity", "Skipped: backup identity is not configured", "Guardian", guild.name, reason);
    return false;
  }
  if (!guild.members.me.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
    await logAction(guild, "Restore server identity", "Skipped: missing Manage Guild permission", "Guardian", guild.name, reason);
    return false;
  }
  if (config.dryRun) {
    await logAction(guild, "Restore server identity", "Dry-run: no changes made", "Guardian", guild.name, reason);
    return true;
  }
  const changes = {};
  if (backup.name) changes.name = backup.name;
  if (backup.iconUrl) changes.icon = backup.iconUrl;
  const restored = await guild.edit(changes, reason).then(() => true).catch(() => false);
  await logAction(guild, "Restore server identity", restored ? "Completed" : "Failed", "Guardian", guild.name, reason);
  return restored;
}

async function cleanupNukeArtifacts(guild, executorId) {
  if (!config.autoCleanupNukeArtifacts) return;
  const cutoff = Date.now() - config.nukeCleanupWindowMs;
  let deletedChannels = 0;
  let deletedRoles = 0;
  const skipChannelIds = new Set([config.logChannelId]);
  const securityCategory = guild.channels.cache.find((channel) => channel.type === 4 && channel.name === "guardian-security");
  if (securityCategory) skipChannelIds.add(securityCategory.id);

  if (guild.members.me.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
    const channelLogs = await guild.fetchAuditLogs({ type: AuditLogEvent.ChannelCreate, limit: 100 }).catch(() => null);
    for (const entry of channelLogs?.entries.values() || []) {
      if (entry.executor?.id !== executorId || entry.createdTimestamp < cutoff || !entry.targetId || skipChannelIds.has(entry.targetId)) continue;
      const channel = guild.channels.cache.get(entry.targetId);
      if (!channel) continue;
      const removed = config.dryRun ? true : await channel.delete("Guardian nuke cleanup: attacker-created channel").then(() => true).catch(() => false);
      if (removed) deletedChannels += 1;
    }
  }

  if (guild.members.me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
    const roleLogs = await guild.fetchAuditLogs({ type: AuditLogEvent.RoleCreate, limit: 100 }).catch(() => null);
    for (const entry of roleLogs?.entries.values() || []) {
      if (entry.executor?.id !== executorId || entry.createdTimestamp < cutoff || !entry.targetId || entry.targetId === guild.id || entry.targetId === config.quarantineRoleId) continue;
      const role = guild.roles.cache.get(entry.targetId);
      if (!role || role.managed) continue;
      const removed = config.dryRun ? true : await role.delete("Guardian nuke cleanup: attacker-created role").then(() => true).catch(() => false);
      if (removed) deletedRoles += 1;
    }
  }
  await logAction(guild, "Clean attacker-created nuke artifacts", config.dryRun ? `Dry-run: ${deletedChannels} channels and ${deletedRoles} roles identified` : `${deletedChannels} channels and ${deletedRoles} roles deleted`, "Guardian", executorId, `Created by attacker within ${config.nukeCleanupWindowMs / 1000}s`);
}

async function handleMassMention(message) {
  if (!message.guild || !message.mentions.everyone || message.author.bot || isTrusted(message.member)) return false;
  const now = Date.now();
  const recent = (state.massMentions.get(message.guild.id) || []).filter((time) => now - time < config.massMentionWindowMs);
  recent.push(now);
  state.massMentions.set(message.guild.id, recent);
  const reason = `${recent.length} mass mention(s) in ${config.massMentionWindowMs / 1000}s`;
  state.incidents.set(`${message.guild.id}:mention:${now}`, { type: "mass-mention", count: recent.length });
  if (!config.dryRun) await message.delete().catch(() => {});
  await logAction(message.guild, "Block mass mention", config.dryRun ? "Dry-run: message retained" : "Triggering message deleted", message.author.tag, message.channel.name, reason);
  if (config.autoLockdown) await setLockdown(message.guild, true, `Mass mention abuse by ${message.author.tag}`);
  await removeGuildWebhooks(message.guild, "Mass mention containment");
  await restoreGuildIdentity(message.guild, "Mass mention containment");
  const member = message.member;
  if (config.autoBanMassMentioners && member?.bannable) {
    const banned = config.dryRun ? true : await member.ban({ deleteMessageSeconds: 0, reason: "Guardian mass mention abuse" }).then(() => true).catch(() => false);
    await logAction(message.guild, "Ban mass mentioner", config.dryRun ? "Dry-run: no ban made" : (banned ? "Completed" : "Failed"), "Guardian", message.author.tag, reason);
  } else {
    await quarantine(member, "Mass mention abuse detected.");
  }
  return true;
}

function recordAction(guildId, executorId, action) {
  const key = `${guildId}:${executorId}:${action}`;
  const now = Date.now();
  const recent = (state.actions.get(key) || []).filter((time) => now - time < config.actionWindowMs);
  recent.push(now);
  state.actions.set(key, recent);
  return recent.length;
}

async function inspectAudit(guild, actionType, targetName) {
  const limit = config.limits[actionType];
  if (!limit && !(actionType === AuditLogEvent.ChannelDelete && config.immediateChannelDeleteBan)) return;
  const logs = await guild.fetchAuditLogs({ type: actionType, limit: 1 }).catch(() => null);
  const entry = logs?.entries.first();
  if (!entry || Date.now() - entry.createdTimestamp > 15000 || !entry.executor) return;
  if (entry.id && state.processedAuditEntries.has(entry.id)) return;
  if (entry.id) state.processedAuditEntries.add(entry.id);
  if (config.allowedUsers.has(entry.executor.id)) return;
  const count = recordAction(guild.id, entry.executor.id, actionType);
  const immediateBotChannelDelete = actionType === AuditLogEvent.ChannelDelete && config.immediateChannelDeleteBan;
  if (count < limit && !immediateBotChannelDelete) return;
  const member = await guild.members.fetch(entry.executor.id).catch(() => null);
  if (member && !isTrusted(member)) {
    if (member.user.bot) {
      if (config.autoBanAttackers && member.bannable) {
        const banned = config.dryRun
          ? true
          : await member.ban({ deleteMessageSeconds: 0, reason: `Guardian anti-nuke bot: ${targetName}` }).then(() => true).catch(() => false);
        await logAction(guild, immediateBotChannelDelete ? "Immediate ban: bot deleted a channel" : "Ban anti-nuke bot", config.dryRun ? "Dry-run: no ban made" : (banned ? "Completed" : "Failed"), "Guardian", member.user.tag, immediateBotChannelDelete ? "First confirmed channel deletion" : `Exceeded ${targetName} limit`);
      } else {
        await logAction(guild, "Ban anti-nuke bot", "Skipped: not bannable or disabled", "Guardian", member.user.tag, `Exceeded ${targetName} limit`);
      }
    } else {
      if (!config.dryRun && member.moderatable) {
      const timedOut = await member.timeout(24 * 60 * 60 * 1000, `Guardian anti-nuke: ${targetName}`).then(() => true).catch(() => false);
      await logAction(guild, "Timeout suspected attacker", timedOut ? "Completed" : "Failed", "Guardian", member.user.tag, `Exceeded ${targetName} limit`);
      }
      await stripNukeRoles(member, `Guardian anti-nuke: ${targetName}`);
      await quarantine(member, `Exceeded ${targetName} action limit (${count}/${limit}).`);
    }
  }
  await log(guild, "ANTI-NUKE ACTION", `${entry.executor.tag} exceeded the ${targetName} limit.`, 0xff0000, [
    { name: "Action", value: String(actionType), inline: true },
    { name: "Count", value: `${count}/${limit}`, inline: true },
  ]);
  await cleanupNukeArtifacts(guild, entry.executor.id);
  if (config.autoLockdown) {
    await setLockdown(guild, true, `Automated anti-nuke response to ${entry.executor.tag}`);
    scheduleNukeUnlock(guild);
  }
}

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(config.token);
  const route = Routes.applicationCommands(client.user.id);
  await rest.put(route, { body: commands });
  console.log(`Registered ${commands.length} global slash commands.`);
}

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);
  for (const guild of client.guilds.cache.values()) {
    saveGuildBackup(guild);
    try {
      await autosaveGuildSnapshot(guild, "bot startup", false);
    } catch (error) {
      console.error(`[${guild.name}] Initial automatic backup failed: ${error.message}`);
    }
  }
  client.user.setPresence({
    activities: [{ name: config.streamingName, type: 1, url: config.streamingUrl }],
    status: config.presenceStatus,
  });
  console.log(`Presence set to ${config.presenceStatus}: Streaming ${config.streamingName} at ${config.streamingUrl}`);
  try {
    await registerCommands();
  } catch (error) {
    console.error(`Slash-command registration failed: ${error.code || error.message}`);
    console.error("Slash commands may be unavailable until registration succeeds.");
  }
});

client.on(Events.GuildCreate, (guild) => {
  saveGuildBackup(guild);
  scheduleGuildSnapshot(guild, "bot joined the server");
});

client.on(Events.GuildUpdate, (oldGuild, newGuild) => {
  scheduleGuildSnapshot(newGuild, "guild settings or identity change");
});

for (const eventName of [
  Events.ChannelCreate,
  Events.ChannelDelete,
  Events.ChannelUpdate,
  Events.GuildRoleCreate,
  Events.GuildRoleDelete,
  Events.GuildRoleUpdate,
  Events.GuildEmojiCreate,
  Events.GuildEmojiDelete,
  Events.GuildEmojiUpdate,
  Events.GuildStickerCreate,
  Events.GuildStickerDelete,
  Events.GuildStickerUpdate,
  Events.GuildScheduledEventCreate,
  Events.GuildScheduledEventDelete,
  Events.GuildScheduledEventUpdate,
  Events.WebhooksUpdate,
  Events.GuildBanAdd,
  Events.GuildBanRemove,
]) {
  client.on(eventName, (resource) => {
    const guild = resource?.guild || resource;
    if (guild?.id) scheduleGuildSnapshot(guild, `${eventName} event`);
  });
}

client.on(Events.GuildMemberAdd, async (member) => {
  recordMemberEvent(member, "join");
  const now = Date.now();
  const joins = (state.joins.get(member.guild.id) || []).filter((time) => now - time < config.joinWindowMs);
  joins.push(now);
  state.joins.set(member.guild.id, joins);
  if (joins.length >= config.joinThreshold) {
    state.incidents.set(`${member.guild.id}:${now}`, { type: "raid", count: joins.length });
    if (config.autoLockdown) await setLockdown(member.guild, true, `${joins.length} joins detected in ${config.joinWindowMs / 1000}s`);
    await quarantine(member, "Join-raid protection triggered.");
    await log(member.guild, "JOIN RAID DETECTED", `${joins.length} members joined in a short window.`, 0xff0000);
    await logAction(member.guild, "Detect join raid", "Lockdown and quarantine response started", "Guardian automated protection", member.user.tag, `${joins.length} joins in ${config.joinWindowMs / 1000}s`);
    if (member.user.bot && config.autoBanRaidBots && member.bannable) {
      const banned = config.dryRun
        ? true
        : await member.ban({ deleteMessageSeconds: 0, reason: "Guardian raid protection: bot joined during detected raid" }).then(() => true).catch(() => false);
      await logAction(member.guild, "Ban raid bot", config.dryRun ? "Dry-run: no ban made" : (banned ? "Completed" : "Failed"), "Guardian automated protection", member.user.tag, "Bot joined during detected raid");
    }
  }
  if (state.lockdowns.has(member.guild.id)) {
    if (member.user.bot && config.autoBanRaidBots && member.bannable) {
      const banned = config.dryRun
        ? true
        : await member.ban({ deleteMessageSeconds: 0, reason: "Guardian lockdown: bot join blocked" }).then(() => true).catch(() => false);
      await logAction(member.guild, "Block bot during lockdown", config.dryRun ? "Dry-run: no ban made" : (banned ? "Completed" : "Failed"), "Guardian automated protection", member.user.tag, "Bot joined while server was locked down");
    } else {
      await quarantine(member, "Server is in lockdown.");
    }
  }
});

client.on(Events.GuildMemberRemove, (member) => {
  recordMemberEvent(member, "leave");
});

client.on(Events.VoiceStateUpdate, (member, before, after) => {
  const now = new Date().toISOString();
  if (!before.channelId && after.channelId) recordVoiceEvent(member, after.channelId, now);
  if (before.channelId && !after.channelId) {
    database.prepare("UPDATE voice_activity SET left_at = ? WHERE id = (SELECT id FROM voice_activity WHERE guild_id = ? AND user_id = ? AND left_at IS NULL ORDER BY id DESC LIMIT 1)")
      .run(now, member.guild.id, member.id);
  }
  if (before.channelId && after.channelId && before.channelId !== after.channelId) {
    database.prepare("UPDATE voice_activity SET left_at = ? WHERE id = (SELECT id FROM voice_activity WHERE guild_id = ? AND user_id = ? AND left_at IS NULL ORDER BY id DESC LIMIT 1)")
      .run(now, member.guild.id, member.id);
    recordVoiceEvent(member, after.channelId, now);
  }
});

client.on(Events.GuildAuditLogEntryCreate, async (entry, guild) => {
  await inspectAudit(guild, entry.action, entry.action === AuditLogEvent.ChannelDelete ? "channel deletion" : "dangerous activity");
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isButton() && interaction.customId.startsWith("help:")) {
    const [, action, ownerId] = interaction.customId.split(":");
    if (interaction.user.id !== ownerId) {
      return interaction.reply({ content: "Only the person who opened this help menu can use these buttons.", ephemeral: true });
    }
    if (action === "close") {
      return interaction.update({ content: "Help closed.", embeds: [], components: [] });
    }
    if (action === "search") return interaction.showModal(helpModal(ownerId));
    const currentPage = Number(interaction.message.embeds[0]?.footer?.text.match(/Page (\d+)\/(\d+)/)?.[1] || 1) - 1;
    const totalPages = helpPages().length;
    const nextPage = Math.max(0, Math.min(totalPages - 1, currentPage + (action === "next" ? 1 : -1)));
    const pages = helpPages();
    return interaction.update({
      embeds: [helpEmbed(pages[nextPage], nextPage, pages.length)],
      components: helpComponents(ownerId, nextPage, pages.length),
    });
  }
  if (interaction.isModalSubmit() && interaction.customId.startsWith("help-modal:")) {
    const ownerId = interaction.customId.split(":")[1];
    if (interaction.user.id !== ownerId) {
      return interaction.reply({ content: "Only the person who opened this help menu can search it.", ephemeral: true });
    }
    const search = interaction.fields.getTextInputValue("query");
    const pages = helpPages(search);
    return interaction.reply({
      embeds: [helpEmbed(pages[0], 0, pages.length, search)],
      components: helpComponents(ownerId, 0, pages.length),
      ephemeral: true,
    });
  }
  if (!interaction.isChatInputCommand() || !interaction.guild) return;
  const member = interaction.member;
  if (interaction.commandName === "help") {
    const pages = helpPages();
    return interaction.reply({
      embeds: [helpEmbed(pages[0], 0, pages.length)],
      components: helpComponents(interaction.user.id, 0, pages.length),
      ephemeral: true,
    });
  }
  if (interaction.commandName === "security") {
    return interaction.reply(`zy is active. Lockdown: **${state.lockdowns.has(interaction.guild.id) ? "ON" : "OFF"}** | Dry run: **${config.dryRun ? "ON" : "OFF"}`);
  }
  if (!canManage(member)) return interaction.reply({ content: "You need Administrator permission or an allowlisted role/user.", ephemeral: true });
  if (interaction.commandName === "setup") {
    try {
      const result = await setupGuild(interaction.guild, interaction.user);
      return interaction.reply(`Setup complete: ${result.logChannel} and ${result.role} are ready.`);
    } catch (error) {
      await logAction(interaction.guild, "Setup", "Failed", interaction.user.tag, interaction.guild.name, error.message);
      return interaction.reply({ content: `Setup failed: ${error.message}`, ephemeral: true });
    }
  }
  if (interaction.commandName === "backup") {
    try {
      const backup = await createServerBackup(interaction.guild);
      await logAction(interaction.guild, "Create server backup", "Completed", interaction.user.tag, interaction.guild.name, `${backup.roles.length} roles and ${backup.channels.length} channels saved`);
      return interaction.reply(`Backup saved: **${backup.roles.length} roles** and **${backup.channels.length} channels**.`);
    } catch (error) {
      await logAction(interaction.guild, "Create server backup", "Failed", interaction.user.tag, interaction.guild.name, error.message);
      return interaction.reply({ content: `Backup failed: ${error.message}`, ephemeral: true });
    }
  }
  if (interaction.commandName === "lockdown") {
    await setLockdown(interaction.guild, interaction.options.getString("mode") === "on", `Manual command by ${interaction.user.tag}`);
    return interaction.reply("Done.");
  }
  if (interaction.commandName === "quarantine") {
    const target = await interaction.guild.members.fetch(interaction.options.getUser("user").id).catch(() => null);
    if (target) await logAction(interaction.guild, "Manual quarantine", "Requested", interaction.user.tag, target.user.tag, "Manual command");
    await quarantine(target, `Manual command by ${interaction.user.tag}`);
    return interaction.reply(target ? "Member quarantined." : "Member not found.");
  }
  if (interaction.commandName === "allow") {
    config.allowedUsers.add(interaction.options.getUser("user").id);
    return interaction.reply("User allowlisted for this process. Persist it in .env.");
  }
  if (interaction.commandName === "incident") return interaction.reply(`Tracked incidents: **${state.incidents.size}**`);
  return handleLegacyInteraction(interaction).catch(async (error) => {
    console.error(`Command /${interaction.commandName} failed:`, error);
    const message = { content: "This command could not be completed.", ephemeral: true };
    if (interaction.replied || interaction.deferred) return interaction.followUp(message);
    return interaction.reply(message);
  });
});

client.on(Events.MessageCreate, async (message) => {
  await handleMassMention(message);
  if (message.author.bot) return;
  try {
    recordMessageActivity(message);
  } catch (error) {
    console.error("Could not record message analytics:", error.message);
  }
  if (state.afkUsers.has(message.author.id)) {
    state.afkUsers.delete(message.author.id);
    await message.channel.send(`Welcome back, ${message.author}! Your AFK status was removed.`);
  }
  for (const mention of message.mentions.users.values()) {
    const reason = state.afkUsers.get(mention.id);
    if (reason) await message.channel.send(`${mention} is currently AFK: ${reason}`);
  }
  if (state.mimicUsers.has(message.author.id)) {
    await message.channel.send(`${message.author} said: ${message.content}`, { allowedMentions: { parse: [] } });
  }
});

client.on(Events.MessageDelete, (message) => {
  if (!message.guild || message.author?.bot) return;
  try { updateLatestMessageChange(message, "deleted_at"); } catch (error) { console.error("Could not record message deletion:", error.message); }
  state.snipes.set(message.channelId, {
    content: message.content,
    author: message.author?.tag || "Unknown user",
    avatar: message.author?.displayAvatarURL() || undefined,
    deletedAt: new Date(),
  });
});

client.on(Events.MessageUpdate, (before, after) => {
  if (!after.guild || after.author?.bot) return;
  try { updateLatestMessageChange(after, "edited_at"); } catch (error) { console.error("Could not record message edit:", error.message); }
});

process.on("unhandledRejection", (error) => console.error("Unhandled rejection:", error));
startStatusWebsite();
startBackupMonitor();
client.login(config.token);
