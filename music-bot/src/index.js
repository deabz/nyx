import "dotenv/config";
import {
  Client,
  EmbedBuilder,
  GatewayIntentBits,
} from "discord.js";
import { Player } from "discord-player";
import { YoutubeiExtractor } from "@discord-player/extractor";

const token = process.env.DISCORD_TOKEN;
if (!token) throw new Error("DISCORD_TOKEN is required.");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
  ],
});
const player = new Player(client);

await player.extractors.register(YoutubeiExtractor, {});

const getQueue = interaction => player.nodes.get(interaction.guildId);
const getVoiceChannel = interaction => interaction.member?.voice?.channel;

function requireVoiceChannel(interaction) {
  const channel = getVoiceChannel(interaction);
  if (!channel) throw new Error("Join a voice channel first.");
  return channel;
}

function trackEmbed(track, title = "Now playing") {
  return new EmbedBuilder()
    .setColor(0x7c3aed)
    .setTitle(title)
    .setDescription(`[${track.title}](${track.url})`)
    .addFields(
      { name: "Duration", value: track.duration || "Live", inline: true },
      { name: "Requested by", value: track.requestedBy?.toString() || "Unknown", inline: true },
    )
    .setThumbnail(track.thumbnail || null);
}

client.once("ready", readyClient => {
  console.log(`Music bot online as ${readyClient.user.tag}`);
});

player.events.on("playerStart", (queue, track) => {
  queue.metadata?.channel?.send({ embeds: [trackEmbed(track)] }).catch(() => {});
});

player.events.on("error", (queue, error) => {
  console.error("Player error:", error);
  queue.metadata?.channel?.send("Playback failed. Try another search or URL.").catch(() => {});
});

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand() || !interaction.guildId) return;

  try {
    const command = interaction.commandName;
    if (command === "play") {
      const voiceChannel = requireVoiceChannel(interaction);
      const query = interaction.options.getString("query", true);
      await interaction.deferReply();
      const result = await player.play(voiceChannel, query, {
        nodeOptions: { metadata: { channel: interaction.channel } },
      });
      await interaction.editReply({
        embeds: [trackEmbed(result.track, result.searchResult?.playlist ? "Playlist added" : "Track added")],
      });
      return;
    }

    const queue = getQueue(interaction);
    if (!queue || !queue.isPlaying()) {
      await interaction.reply("Nothing is playing right now.");
      return;
    }

    const actions = {
      pause: () => queue.node.setPaused(true),
      resume: () => queue.node.setPaused(false),
      skip: () => queue.node.skip(),
      stop: () => queue.delete(),
      shuffle: () => queue.tracks.shuffle(),
      disconnect: () => queue.delete(),
    };
    if (actions[command]) {
      await actions[command]();
      await interaction.reply(`${command[0].toUpperCase()}${command.slice(1)} complete.`);
      return;
    }
    if (command === "nowplaying") {
      await interaction.reply({ embeds: [trackEmbed(queue.currentTrack)] });
      return;
    }
    if (command === "queue") {
      const tracks = queue.tracks.toArray().slice(0, 10);
      const description = tracks.length
        ? tracks.map((track, index) => `${index + 1}. [${track.title}](${track.url})`).join("\n")
        : "No tracks are waiting.";
      await interaction.reply({
        embeds: [new EmbedBuilder().setColor(0x7c3aed).setTitle("Queue").setDescription(description)],
      });
      return;
    }
    if (command === "loop") {
      const mode = interaction.options.getString("mode", true);
      const repeatMode = { off: 0, track: 1, queue: 2 }[mode];
      queue.setRepeatMode(repeatMode);
      await interaction.reply(`Loop mode set to **${mode}**.`);
    }
  } catch (error) {
    console.error(`/${interaction.commandName} failed:`, error);
    const message = error instanceof Error ? error.message : "Something went wrong.";
    if (interaction.deferred || interaction.replied) await interaction.editReply(`❌ ${message}`);
    else await interaction.reply(`❌ ${message}`);
  }
});

client.login(token);
