require("dotenv").config();
const fs = require("fs");
const http = require("http");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const {
  AuditLogEvent,
  Client,
  Collection,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  PermissionsBitField,
  REST,
  Routes,
  SlashCommandBuilder,
} = require("discord.js");

const csv = (value) => new Set((value || "").split(",").map((x) => x.trim()).filter(Boolean));
const bool = (value, fallback) => value === undefined ? fallback : value.toLowerCase() === "true";
const num = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const config = {
  brandName: "zy",
  webPort: num(process.env.PORT, 3000),
  token: process.env.DISCORD_TOKEN,
  prefix: process.env.PREFIX || "!",
  devGuildId: process.env.DEV_GUILD_ID || "",
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
  new SlashCommandBuilder().setName("incident").setDescription("Show recent security incidents."),
].map((command) => command.toJSON());

function helpEmbed() {
  return new EmbedBuilder()
    .setTitle("🛡️ zy Security Center")
    .setDescription("Your server's defensive command center. zy watches for raids, anti-nuke patterns, suspicious activity, and emergency threats.")
    .setColor(0x5865f2)
    .addFields(
      {
        name: "🚀 Getting started",
        value: "`/setup` or `!setup`\nCreates the private `guardian-security` category, `guardian-logs` channel, `Guardian Quarantine` role, and protected permission rules. Safe to run again.",
      },
      {
        name: "⚡ Security controls",
        value: "`/security` or `!security` — Live protection status\n`/setup` or `!setup` — Create Guardian infrastructure\n`/backup` or `!backup` — Save a server snapshot\n`/lockdown on|off` or `!lockdown on|off` — Freeze/unfreeze server messaging\n`/quarantine @user` or `!quarantine @user` — Isolate a member\n`/allow @user` or `!allow @user` — Trust a user for this process\n`/incident` or `!incident` — View tracked incidents",
      },
      {
        name: "🔍 Automatic protection",
        value: "• Detects join raids using configurable join-rate thresholds\n• Detects dangerous audit-log bursts by executor\n• Watches channel/role creation and deletion, bans, kicks, and webhook changes\n• Bans confirmed anti-nuke executors when possible\n• Bans bots that join during a detected raid when possible\n• Quarantines human raid joins instead of mass-banning members\n• Applies the quarantine role and starts lockdown automatically\n• Logs actor, target, result, action, and reason",
      },
      {
        name: "📋 What setup creates",
        value: "A hidden security category, a private action log channel, a quarantine role, and channel denies that prevent quarantined users from viewing or speaking. Created IDs are saved to `.env`.",
      },
      {
        name: "💾 Automatic backups",
        value: "zy automatically saves the server name, icon, settings, roles, channels, permission overwrites, emojis, stickers, scheduled events, bans, and webhooks. It detects changes from Discord events and periodic integrity scans, then records the differences in the security log.",
      },
      {
        name: "🔐 Required permissions",
        value: "View Audit Log, Manage Roles, Manage Channels, Moderate Members, Send Messages, Embed Links, and the privileged intents enabled in the Developer Portal.",
      },
      {
        name: "⚙️ Configuration",
        value: "Edit `.env` for thresholds, trusted users/roles, log channel, quarantine role, lockdown behavior, targeted attacker/raid-bot bans, dry-run mode, command prefix, and the streaming presence.",
      },
      {
        name: "🧪 Safe testing",
        value: "Set `DRY_RUN=true` before testing automated responses. Guardian will report what it would do without changing roles, timeouts, or channel permissions.",
      },
    )
    .setFooter({ text: "Guardian • Defensive automation, not a replacement for secure ownership and 2FA" })
    .setTimestamp();
}

function isTrusted(member) {
  return Boolean(member && (config.allowedUsers.has(member.id) || config.ownerUsers.has(member.id) ||
    member.roles.cache.some((role) => config.trustedRoles.has(role.id))));
}

function canManage(member) {
  return Boolean(member && (isTrusted(member) || member.permissions.has(PermissionsBitField.Flags.Administrator)));
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
  const targetGuild = config.devGuildId ? client.guilds.cache.get(config.devGuildId) : null;
  if (config.devGuildId && !targetGuild) {
    console.error(`DEV_GUILD_ID ${config.devGuildId} is not available to this bot. Falling back to global slash commands.`);
  }
  const useGuild = Boolean(targetGuild);
  const route = useGuild
    ? Routes.applicationGuildCommands(client.user.id, config.devGuildId)
    : Routes.applicationCommands(client.user.id);
  await rest.put(route, { body: commands });
  console.log(`Registered ${commands.length} slash commands ${useGuild ? `in ${config.devGuildId}` : "globally"}.`);
}

async function handleCommand(message, name, args) {
  if (!message.guild) return;
  if (name === "help") return message.reply({ embeds: [helpEmbed()] });
  if (name === "security") {
    return message.reply(`zy is active. Lockdown: **${state.lockdowns.has(message.guild.id) ? "ON" : "OFF"}** | Dry run: **${config.dryRun ? "ON" : "OFF"}**`);
  }
  if (!canManage(message.member)) return message.reply("You need Administrator permission or an allowlisted role/user.");
  if (name === "setup") {
    try {
      const result = await setupGuild(message.guild, message.author);
      return message.reply(`Setup complete: ${result.logChannel} and ${result.role} are ready.`);
    } catch (error) {
      await logAction(message.guild, "Setup", "Failed", message.author.tag, message.guild.name, error.message);
      return message.reply(`Setup failed: ${error.message}`);
    }
  }
  if (name === "backup") {
    try {
      const backup = await createServerBackup(message.guild);
      await logAction(message.guild, "Create server backup", "Completed", message.author.tag, message.guild.name, `${backup.roles.length} roles and ${backup.channels.length} channels saved`);
      return message.reply(`Backup saved: **${backup.roles.length} roles** and **${backup.channels.length} channels**.`);
    } catch (error) {
      await logAction(message.guild, "Create server backup", "Failed", message.author.tag, message.guild.name, error.message);
      return message.reply(`Backup failed: ${error.message}`);
    }
  }
  if (name === "lockdown") return setLockdown(message.guild, args[0] !== "off", `Manual command by ${message.author.tag}`);
  if (name === "allow") {
    config.allowedUsers.add(args[0]?.replace(/[<@!>]/g, "") || "");
    await logAction(message.guild, "Allow user", "Added for current process", message.author.tag, args[0] || "Unknown user", "Manual allow command");
    return message.reply("User added to this process's allowlist. Add them to ALLOWED_USER_IDS in .env to persist it.");
  }
  if (name === "quarantine") {
    const member = message.mentions.members.first() || await message.guild.members.fetch(args[0]).catch(() => null);
    if (member) await logAction(message.guild, "Manual quarantine", "Requested", message.author.tag, member.user.tag, "Manual command");
    return member ? quarantine(member, `Manual command by ${message.author.tag}`) : message.reply("Member not found.");
  }
  if (name === "incident") return message.reply(`Tracked incidents: **${state.incidents.size}**`);
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
    if (config.devGuildId) {
      console.error(`Check that DEV_GUILD_ID (${config.devGuildId}) is a server where this bot is installed, or clear DEV_GUILD_ID in .env.`);
    }
    console.log("The bot will continue running with prefix commands.");
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

client.on(Events.GuildAuditLogEntryCreate, async (entry, guild) => {
  await inspectAudit(guild, entry.action, entry.action === AuditLogEvent.ChannelDelete ? "channel deletion" : "dangerous activity");
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || !interaction.guild) return;
  const member = interaction.member;
  if (interaction.commandName === "help") return interaction.reply({ embeds: [helpEmbed()], ephemeral: true });
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
});

client.on(Events.MessageCreate, async (message) => {
  if (await handleMassMention(message)) return;
  if (message.author.bot || !message.content.startsWith(config.prefix)) return;
  const [name, ...args] = message.content.slice(config.prefix.length).trim().split(/\s+/);
  if (name) await handleCommand(message, name.toLowerCase(), args);
});

process.on("unhandledRejection", (error) => console.error("Unhandled rejection:", error));
startStatusWebsite();
startBackupMonitor();
client.login(config.token);
