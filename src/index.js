import "dotenv/config";
import http from "node:http";
import {
  Client, EmbedBuilder, GatewayIntentBits, PermissionFlagsBits,
} from "discord.js";
import { Player } from "discord-player";
import { YoutubeiExtractor } from "@discord-player/extractor";

const token = process.env.DISCORD_TOKEN;
if (!token) throw new Error("DISCORD_TOKEN is required.");
const startedAt = Date.now();
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMembers],
});
const player = new Player(client);
await player.extractors.register(YoutubeiExtractor, {});

const embed = (title, description, colour = 0x7c3aed) =>
  new EmbedBuilder().setColor(colour).setTitle(title).setDescription(description);
const guildOnly = interaction => {
  if (!interaction.guild) throw new Error("This command can only be used in a server.");
  return interaction.guild;
};
const voiceChannel = interaction => {
  const channel = interaction.member?.voice?.channel;
  if (!channel) throw new Error("Join a voice channel first.");
  return channel;
};
const trackEmbed = (track, title = "Now playing") => embed(
  title, `[${track.title}](${track.url})`,
).addFields(
  { name: "Duration", value: track.duration || "Live", inline: true },
  { name: "Requested by", value: track.requestedBy?.toString() || "Unknown", inline: true },
);

function insightCommands(guild) {
  const memberCount = guild.memberCount || guild.members.cache.size;
  return [
    ["serverhealth", `**Members:** ${memberCount}\n**Channels:** ${guild.channels.cache.size}\n**Roles:** ${guild.roles.cache.size}\n**Boost level:** ${guild.premiumTier}`],
    ["serverreport", `Created ${guild.createdAt.toLocaleDateString()}\n${memberCount} members • ${guild.channels.cache.size} channels • ${guild.emojis.cache.size} emojis`],
  ];
}

client.once("ready", ready => console.log(`nyx Discord.js online as ${ready.user.tag}`));
player.events.on("playerStart", (queue, track) => queue.metadata?.channel?.send({ embeds: [trackEmbed(track)] }).catch(() => {}));
player.events.on("error", (queue, error) => {
  console.error("Player error:", error);
  queue.metadata?.channel?.send("Playback failed. Try another search or URL.").catch(() => {});
});

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand() || !interaction.guildId) return;
  try {
    const { commandName } = interaction;
    if (commandName === "help") {
      const lines = [
        "**Insights**\n`/serverhealth` `/serverreport` `/channelpulse` `/roleinsights` `/memberinsights` `/memberactivity` `/voiceinsights`",
        "**Status**\n`/ping` `/uptime`",
        "**Music**\n`/play` `/pause` `/resume` `/skip` `/stop` `/queue` `/nowplaying` `/shuffle` `/loop` `/disconnect`",
      ];
      await interaction.reply({ embeds: [embed("nyx • insights + music", lines.join("\n\n"))], ephemeral: true });
      return;
    }
    if (commandName === "ping") {
      await interaction.reply(`Pong! \`${Math.round(client.ws.ping)}ms\``);
      return;
    }
    if (commandName === "uptime") {
      const seconds = Math.floor((Date.now() - startedAt) / 1000);
      await interaction.reply({ embeds: [embed("nyx uptime", `${Math.floor(seconds / 86400)}d ${Math.floor(seconds / 3600) % 24}h ${Math.floor(seconds / 60) % 60}m ${seconds % 60}s`)] });
      return;
    }
    if (["serverhealth", "serverreport"].includes(commandName)) {
      const guild = guildOnly(interaction);
      await interaction.reply({ embeds: [embed(...insightCommands(guild).find(([name]) => name === commandName))] });
      return;
    }
    const guild = guildOnly(interaction);
    if (commandName === "channelpulse") {
      const channel = interaction.channel;
      if (!channel?.isTextBased()) throw new Error("Use this command in a text channel.");
      const messages = await channel.messages.fetch({ limit: 100 });
      const authors = new Map();
      for (const message of messages.values()) if (!message.author.bot) authors.set(message.author.id, (authors.get(message.author.id) || 0) + 1);
      const top = [...authors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id, count], i) => `${i + 1}. <@${id}> — ${count}`).join("\n") || "No human messages.";
      await interaction.reply({ embeds: [embed(`Channel pulse • #${channel.name}`, `**Messages sampled:** ${messages.size}\n**Top contributors:**\n${top}`)] });
      return;
    }
    if (commandName === "roleinsights") {
      const roles = guild.roles.cache.filter(role => !role.managed && role.id !== guild.id).sort((a, b) => b.members.size - a.members.size).first(10);
      await interaction.reply({ embeds: [embed("Role insights", roles.map((role, i) => `${i + 1}. ${role} — ${role.members.size} members`).join("\n") || "No custom roles.") ] });
      return;
    }
    if (["memberinsights", "memberactivity"].includes(commandName)) {
      const member = interaction.options.getMember("member") || interaction.member;
      if (commandName === "memberinsights") {
        await interaction.reply({ embeds: [embed(`Member insights • ${member.displayName}`, `**Created:** <t:${Math.floor(member.user.createdTimestamp / 1000)}:F>\n**Joined:** ${member.joinedTimestamp ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:F>` : "Unknown"}\n**Roles:** ${member.roles.cache.filter(role => role.id !== guild.id).size}`)] });
      } else {
        const messages = interaction.channel?.isTextBased() ? await interaction.channel.messages.fetch({ limit: 100 }) : new Map();
        const count = [...messages.values()].filter(message => message.author.id === member.id).length;
        await interaction.reply({ embeds: [embed(`Member activity • ${member.displayName}`, `${member} has **${count}** messages in the last 100 messages sampled.`)] });
      }
      return;
    }
    if (commandName === "voiceinsights") {
      const channels = guild.channels.cache.filter(channel => channel.isVoiceBased() && channel.members.size);
      await interaction.reply({ embeds: [embed("Voice insights", channels.map(channel => `${channel} — ${channel.members.size} connected`).join("\n") || "Nobody is in voice channels.")] });
      return;
    }
    const queue = player.nodes.get(interaction.guildId);
    if (commandName === "play") {
      const query = interaction.options.getString("query", true);
      await interaction.deferReply();
      const result = await player.play(voiceChannel(interaction), query, { nodeOptions: { metadata: { channel: interaction.channel } } });
      await interaction.editReply({ embeds: [trackEmbed(result.track, "Track added")] });
      return;
    }
    if (!queue || !queue.isPlaying()) throw new Error("Nothing is playing right now.");
    if (commandName === "pause") queue.node.setPaused(true);
    else if (commandName === "resume") queue.node.setPaused(false);
    else if (commandName === "skip") await queue.node.skip();
    else if (commandName === "stop" || commandName === "disconnect") await queue.delete();
    else if (commandName === "shuffle") queue.tracks.shuffle();
    else if (commandName === "nowplaying") {
      await interaction.reply({ embeds: [trackEmbed(queue.currentTrack)] });
      return;
    } else if (commandName === "queue") {
      const tracks = queue.tracks.toArray().slice(0, 10);
      await interaction.reply({ embeds: [embed("Queue", tracks.map((track, i) => `${i + 1}. [${track.title}](${track.url})`).join("\n") || "No tracks waiting.")] });
      return;
    } else if (commandName === "loop") {
      const mode = interaction.options.getString("mode", true);
      queue.setRepeatMode({ off: 0, track: 1, queue: 2 }[mode]);
      await interaction.reply(`Loop mode set to **${mode}**.`);
      return;
    }
    await interaction.reply(`${commandName} complete.`);
  } catch (error) {
    console.error(`/${interaction.commandName} failed:`, error);
    const message = error instanceof Error ? error.message : "Something went wrong.";
    if (interaction.deferred || interaction.replied) await interaction.editReply(`❌ ${message}`);
    else await interaction.reply(`❌ ${message}`);
  }
});

http.createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ bot: "nyx", status: "online" }));
    return;
  }
  response.writeHead(200, { "content-type": "text/html" });
  response.end("<h1>nyx</h1><p>Discord.js insights and music bot online.</p>");
}).listen(Number(process.env.PORT || 8080));

await client.login(token);
