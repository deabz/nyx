import "dotenv/config";
import { REST, Routes, SlashCommandBuilder } from "discord.js";

const commands = [
  new SlashCommandBuilder().setName("play").setDescription("Play a search or URL in your voice channel.")
    .addStringOption(option => option.setName("query").setDescription("Song, artist, or URL").setRequired(true)),
  new SlashCommandBuilder().setName("pause").setDescription("Pause the current track."),
  new SlashCommandBuilder().setName("resume").setDescription("Resume the current track."),
  new SlashCommandBuilder().setName("skip").setDescription("Skip to the next track."),
  new SlashCommandBuilder().setName("stop").setDescription("Stop playback and clear the queue."),
  new SlashCommandBuilder().setName("queue").setDescription("Show the current queue."),
  new SlashCommandBuilder().setName("nowplaying").setDescription("Show the current track."),
  new SlashCommandBuilder().setName("shuffle").setDescription("Shuffle the queue."),
  new SlashCommandBuilder().setName("loop").setDescription("Set loop mode.")
    .addStringOption(option => option.setName("mode").setDescription("Loop mode").setRequired(true)
      .addChoices(
        { name: "Off", value: "off" },
        { name: "Track", value: "track" },
        { name: "Queue", value: "queue" },
      )),
  new SlashCommandBuilder().setName("disconnect").setDescription("Leave the voice channel."),
].map(command => command.toJSON());

const { DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID } = process.env;
if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID) {
  throw new Error("DISCORD_TOKEN and DISCORD_CLIENT_ID are required.");
}

const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
const route = DISCORD_GUILD_ID
  ? Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID)
  : Routes.applicationCommands(DISCORD_CLIENT_ID);

await rest.put(route, { body: commands });
console.log(`Registered ${commands.length} music commands.`);
