import "dotenv/config";
import { REST, Routes, SlashCommandBuilder } from "discord.js";

const commands = [
  ["help", "Show nyx insights and music commands."],
  ["ping", "Check bot latency."],
  ["uptime", "Show bot uptime."],
  ["serverhealth", "Show server health and configuration."],
  ["serverreport", "Show a server summary report."],
  ["channelpulse", "Summarise recent channel activity.", option => option.addChannelTypes(0)],
  ["roleinsights", "Show the most-used server roles."],
  ["memberinsights", "Show account and server information for a member.", option => option.addUserOption(user => user.setName("member").setDescription("Member to inspect"))],
  ["memberactivity", "Show a member's recent activity.", option => option.addUserOption(user => user.setName("member").setDescription("Member to inspect"))],
  ["voiceinsights", "Show current voice-channel occupancy."],
  ["play", "Play a search or URL in your voice channel.", option => option.addStringOption(input => input.setName("query").setDescription("Song, artist, or URL").setRequired(true))],
  ["pause", "Pause the current track."],
  ["resume", "Resume the current track."],
  ["skip", "Skip to the next track."],
  ["stop", "Stop playback and clear the queue."],
  ["queue", "Show the current music queue."],
  ["nowplaying", "Show the current track."],
  ["shuffle", "Shuffle the music queue."],
  ["loop", "Set music loop mode.", option => option.addStringOption(input => input.setName("mode").setDescription("Loop mode").setRequired(true).addChoices(
    { name: "Off", value: "off" }, { name: "Track", value: "track" }, { name: "Queue", value: "queue" },
  ))],
  ["disconnect", "Leave the voice channel."],
].map(([name, description, configure]) => {
  const command = new SlashCommandBuilder().setName(name).setDescription(description);
  return (configure ? configure(command) : command).toJSON();
});

const { DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID } = process.env;
if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID) {
  throw new Error("DISCORD_TOKEN and DISCORD_CLIENT_ID are required.");
}

const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
const route = DISCORD_GUILD_ID
  ? Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID)
  : Routes.applicationCommands(DISCORD_CLIENT_ID);
await rest.put(route, { body: commands });
console.log(`Registered ${commands.length} nyx Discord.js commands.`);
