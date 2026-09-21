#!/usr/bin/env python3
import os
import random
import asyncio
from dotenv import load_dotenv
import discord
from discord.ext import commands
from discord.ui import View, Button
import nltk
from nltk.corpus import stopwords
from nltk.tokenize import word_tokenize
import re
import json
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import humanize
from webserver import keep_alive
from collections import defaultdict
import sqlite3
import logging
from discord.ext.commands.errors import CommandInvokeError
from pyowm.owm import OWM
import requests
import time
import aiohttp
import io
import mal_scraper
import math
import moment
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from urllib.parse import quote
from youtubesearchpython import VideosSearch

load_dotenv()

bot_name = "nyx"
cmd_prefix = "-"
mod_role = "."
suggestion_channel = 1014163879707811842
intents = discord.Intents.all()
intents.members = True
bot = commands.Bot(command_prefix='.', intents=intents)
client = commands.Bot(command_prefix=cmd_prefix, intents=intents)
client.remove_command('help')
slash_commands_synced = False
muted_users = []
start_time = datetime.now(timezone.utc)
games = {}
nltk.download("punkt")
nltk.download("stopwords")
database = sqlite3.connect('DATABASE_NAME.db')
cursor = database.cursor()
OPENWEATHER_API_KEY = os.getenv("OPENWEATHER_API_KEY")
WEATHER_CACHE_TTL_SECONDS = int(os.getenv("WEATHER_CACHE_TTL_SECONDS", "600"))
WEATHER_CACHE_MAX_ENTRIES = int(os.getenv("WEATHER_CACHE_MAX_ENTRIES", "100"))

if WEATHER_CACHE_TTL_SECONDS <= 0:
    raise ValueError("WEATHER_CACHE_TTL_SECONDS must be greater than zero")
if WEATHER_CACHE_MAX_ENTRIES <= 0:
    raise ValueError("WEATHER_CACHE_MAX_ENTRIES must be greater than zero")

if OPENWEATHER_API_KEY:
    owm = OWM(OPENWEATHER_API_KEY)
    obs = owm.weather_manager()
else:
    owm = None
    obs = None


@dataclass
class WeatherCacheEntry:
    location: str
    observation: object
    fetched_at: datetime
    expires_at: float


weather_cache = {}
emojis = ["👍", "👎", "❔", "🤔", "🙄", "❌"]
is_playing = set()
color = discord.Color.from_rgb(255, 0, 0) 

cursor.execute('''CREATE TABLE IF NOT EXISTS user_roles (
                    user_id INTEGER PRIMARY KEY,
                    roles TEXT
                )''')
cursor.executescript("""
CREATE TABLE IF NOT EXISTS message_activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id INTEGER NOT NULL,
    channel_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    edited_at TEXT,
    deleted_at TEXT,
    word_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS member_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    occurred_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS voice_activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id INTEGER NOT NULL,
    channel_id INTEGER,
    user_id INTEGER NOT NULL,
    joined_at TEXT NOT NULL,
    left_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_guild_user ON message_activity(guild_id, user_id);
CREATE INDEX IF NOT EXISTS idx_messages_guild_time ON message_activity(guild_id, created_at);
CREATE INDEX IF NOT EXISTS idx_member_events_guild ON member_events(guild_id, event_type);
CREATE INDEX IF NOT EXISTS idx_voice_guild_user ON voice_activity(guild_id, user_id);
""")
database.commit()

def analytics_now():
    return datetime.now(timezone.utc).isoformat()

def record_member_event(guild_id, user_id, event_type):
    cursor.execute(
        "INSERT INTO member_events (guild_id, user_id, event_type, occurred_at) VALUES (?, ?, ?, ?)",
        (guild_id, user_id, event_type, analytics_now()),
    )
    database.commit()

def record_message(message):
    content = message.content or ""
    cursor.execute(
        """INSERT INTO message_activity
        (guild_id, channel_id, user_id, content, created_at, word_count)
        VALUES (?, ?, ?, ?, ?, ?)""",
        (
            message.guild.id,
            message.channel.id,
            message.author.id,
            content,
            analytics_now(),
            len(re.findall(r"\b[\w'-]+\b", content)),
        ),
    )
    database.commit()

sniped_messages = {}

TOKEN = os.getenv("MYSTIC_DISCORD_TOKEN")
if not TOKEN:
    raise RuntimeError(
        "Missing MYSTIC_DISCORD_TOKEN. Create a separate Discord application "
        "and set its bot token in the Mystic .env file."
    )

# Load warnings data from a JSON file
def load_warnings():
    try:
        with open('warnings.json', 'r') as file:
            return json.load(file)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}

# Save warnings data to a JSON file
def save_warnings(warnings):
    with open('warnings.json', 'w') as file:
        json.dump(warnings, file, indent=4)

logging.basicConfig(level=logging.INFO)

try:
    with open('data.json', 'r') as file:
        data = json.load(file)
        whitelist = data.get('whitelist', [])
        blacklist = data.get('blacklist', [])
except FileNotFoundError:
    whitelist = []
    blacklist = []

# Function to save data to file
def save_data():
    data = {'whitelist': whitelist, 'blacklist': blacklist}
    with open('data.json', 'w') as file:
        json.dump(data, file)

@client.event
async def on_ready():
    global slash_commands_synced
    if client.user and client.user.name != bot_name:
        try:
            await client.user.edit(username=bot_name)
            logging.info("Renamed bot account to %s.", bot_name)
        except discord.HTTPException:
            logging.exception("Could not rename the bot account to %s.", bot_name)

    if not slash_commands_synced:
        slash_commands = await client.tree.sync()
        if len(slash_commands) > 100:
            raise RuntimeError("Discord allows at most 100 global slash commands.")
        slash_commands_synced = True
        logging.info("Synced %d slash commands.", len(slash_commands))

    print('\x1b[32m%s\x1b[0m' % '[SERVER] Server.js is Ready!')
    print('\x1b[37m%s\x1b[0m' % '---------------------------------------------------------')
    print('\x1b[33m%s\x1b[0m' % '[CLIENT] Connecting to the bot...')
    print('\x1b[32m%s\x1b[0m' % '[CLIENT] Bot is Ready!')
    print('\x1b[32m%s\x1b[0m' % f'[CLIENT] Client Name: {client.user.name}#{client.user.discriminator}')
    print('\x1b[37m%s\x1b[0m' % '---------------------------------------------------------')
    print('\x1b[36m%s\x1b[0m' % '[SERVER] NOTE: Your bot can shut down at any time if you close this replit project!')
    print('\x1b[36m%s\x1b[0m' % '[SERVER] Make sure to host the bot on https://uptimerobot.com')
    print('\x1b[37m%s\x1b[0m' % '---------------------------------------------------------')
    
    print('\x1b[32m%s\x1b[0m' % '[DEA] Client is online. Check your bot.')


    while True:
        stream = discord.Streaming(
            name="Bearded Sexy Brown Boys",
            url="https://www.twitch.tv/xd_alfie_dx"
        )
        await client.change_presence(status=discord.Status.dnd, activity=stream)
        await asyncio.sleep(5)

colors = {
	"main": "5D40F2",
	"blue": "010535",	
    "red": "FF0004",
    "black": "000000",
    "green": "00FF1D",
    "pink": "FF00E9",
    "yellow":"FFE900"
}

@client.hybrid_command()
async def ping(ctx):
  await ctx.send(f'Pong! `{client.latency * 1000:.0f}`ms')

colours = [discord.Colour.dark_purple()]

class CommandView(discord.ui.View):
  def __init__(self, pages, owner_id):
      super().__init__(timeout=120)
      self.pages = pages
      self.owner_id = owner_id
      self.current_page = 0
      self.message = None
      self.category_select = HelpCategorySelect(self)
      self.add_item(self.category_select)

  async def on_timeout(self):
      if self.message:
          await self.message.edit(view=None)

  async def interaction_check(self, interaction: discord.Interaction):
      if interaction.user.id != self.owner_id:
          await interaction.response.send_message(
              "Only the person who opened this help menu can use these buttons.",
              ephemeral=True,
          )
          return False
      return True

  def current_embed(self):
      title, entries = self.pages[self.current_page]
      embed = discord.Embed(
          title=f"nyx  •  {title}",
          description="Choose a category below to explore nyx's commands.\n"
                      "Commands work with `/` and the `-` prefix.",
          colour=discord.Colour.from_rgb(93, 64, 242),
      )
      command_lines = "\n".join(
          f"`{cmd_prefix}{name}`  —  {description[:120]}"
          for name, description in entries
      )
      embed.add_field(name="Available commands", value=command_lines or "No commands available.", inline=False)
      embed.set_footer(text=f"Category {self.current_page + 1} of {len(self.pages)}  •  nyx insights")
      return embed

  @discord.ui.button(label="Previous", style=discord.ButtonStyle.secondary)
  async def previous_page(self, interaction: discord.Interaction, button: discord.ui.Button):
      self.current_page = (self.current_page - 1) % len(self.pages)
      await interaction.response.edit_message(embed=self.current_embed(), view=self)

  @discord.ui.button(label="Next", style=discord.ButtonStyle.primary)
  async def next_page(self, interaction: discord.Interaction, button: discord.ui.Button):
      self.current_page = (self.current_page + 1) % len(self.pages)
      await interaction.response.edit_message(embed=self.current_embed(), view=self)

  @discord.ui.button(label="Close", style=discord.ButtonStyle.danger)
  async def close(self, interaction: discord.Interaction, button: discord.ui.Button):
      self.stop()
      await interaction.response.edit_message(view=None)

class HelpCategorySelect(discord.ui.Select):
  def __init__(self, view):
      self.help_view = view
      options = [
          discord.SelectOption(
              label=title,
              value=str(index),
              description=f"Browse {title.lower()} commands",
              emoji={"Quick start": "⚡", "Insights": "📊", "Reference": "🌐"}.get(title, "📚"),
          )
          for index, (title, _) in enumerate(view.pages)
      ]
      super().__init__(
          placeholder="Select a command category...",
          min_values=1,
          max_values=1,
          options=options[:25],
      )

  async def callback(self, interaction: discord.Interaction):
      self.help_view.current_page = int(self.values[0])
      await interaction.response.edit_message(
          embed=self.help_view.current_embed(),
          view=self.help_view,
      )

general_commands = [
  ("ping", "Pings the bot"),
  ("suggest [suggestion]", "Sends a suggestion to the configured channel"),
  ("whois [member]", "Shows information about a member"),
  ("userinfo [member]", "Shows user information"),
  ("afk [reason]", "Marks you as away"),
  ("calc [expression]", "Evaluates a basic arithmetic expression"),
]
admin_commands = [
  ("warn [member] [reason]", "Warns a member"),
  ("kick [member] [reason]", "Kicks a member"),
  ("mute [member] [time] [reason]", "Mutes a member"),
  ("ban [member] [reason]", "Bans a member"),
  ("unban [user_id]", "Unbans a user"),
  ("unmute [member]", "Unmutes a member"),
  ("tempmute [member] [time] [reason]", "Temporarily mutes a member"),
  ("warns [member]", "Shows warnings"),
  ("purge [amount]", "Deletes messages"),
  ("delete [role]", "Deletes a role"),
  ("wl [member]", "Toggles whitelist status"),
  ("bl [type] [id] [reason]", "Adds a user or guild to the blacklist"),
]
fun_commands = [
  ("mock [message]", "Mocks a message"),
  ("eball", "Answers a question randomly"),
  ("say [message]", "Sends a message"),
  ("weather [location]", "Shows the weather"),
  ("emotions", "Shows emotion commands"),
  ("youtube [query]", "Searches for a YouTube video"),
]
utility_commands = [
  ("analyse [quote]", "Analyses a quote"),
  ("uptime", "Shows bot uptime"),
  ("serverhealth", "Shows server health and configuration insights"),
  ("channelpulse [channel]", "Summarises recent activity in a channel"),
  ("randommember", "Picks a random non-bot member"),
]
insight_commands = [
  ("serverhealth", "Shows server health and configuration insights"),
  ("channelpulse [channel]", "Summarises recent activity in a channel"),
  ("randommember", "Picks a random non-bot member"),
  ("memberinsights [member]", "Shows account age, roles, and join information"),
  ("timezone [location]", "Shows the current time in a timezone"),
  ("define [word]", "Looks up a dictionary definition"),
  ("poll [question] [options]", "Creates a poll with comma-separated options"),
  ("remind [duration] [message]", "Sends you a personal reminder"),
  ("serverreport", "Shows a server summary report"),
]

@client.hybrid_command()
@commands.cooldown(1, 10, commands.BucketType.user)
async def help(ctx):
  active = {
      command.name: command
      for command in client.commands
      if command.name not in DISABLED_OVERLAPPING_COMMANDS
  }
  categories = {
      "Quick start": ["help", "ping", "uptime"],
      "Insights": [
          "serverhealth", "serverreport", "channelpulse", "roleinsights",
          "memberinsights", "memberactivity", "voiceinsights",
      ],
      "Analytics": [
          "analytics", "topmessages", "topwords", "wordcloud", "voiceactivity",
          "joins", "leaves", "messagechanges",
      ],
      "Reference": ["timezone"],
  }
  pages = []
  listed = set()
  for title, names in categories.items():
      entries = []
      for name in names:
          command = active.get(name)
          if command is not None:
              entries.append(
                  (name, (command.help or command.description or "No description available.").split(".")[0])
              )
              listed.add(name)
      if entries:
          pages.append((title, entries))

  remaining = [
      (name, (command.help or command.description or "No description available.").split(".")[0])
      for name, command in sorted(active.items())
      if name not in listed
  ]
  for index in range(0, len(remaining), 10):
      pages.append((f"More commands {index // 10 + 1}", remaining[index:index + 10]))
  pages = pages or [("Commands", [("help", "Show this help menu")])]
  view = CommandView(pages, ctx.author.id)
  view.message = await ctx.send(
      embed=view.current_embed(),
      view=view,
      ephemeral=ctx.interaction is not None,
      delete_after=None if ctx.interaction is not None else 120,
  )

api_term = "https://api.urbandictionary.com/v0/define?term="
api_rand = "https://api.urbandictionary.com/v0/random"

@client.hybrid_command()
async def urban(ctx, *, query=None):
  try:
      if query is None:
          # Handle random definition logic
          response = requests.get(api_rand)
      else:
          # Handle query definition logic
          response = requests.get(api_term + query)

      results = response.json()

      if results.get("list"):
          definition = results["list"][0]
          votes = (definition.get("thumbs_up", 0) or 0) - (definition.get("thumbs_down", 0) or 0)

          # Parse 'written_on' to a datetime object
          written_on = datetime.strptime(definition['written_on'], '%Y-%m-%dT%H:%M:%S.%fZ')
          # Format timestamp
          timestamp = written_on.strftime('%Y-%m-%d %H:%M:%S UTC')

          embed = discord.Embed(title=f":book: Urban Dictionary: {definition['word']}",
                                url=definition['permalink'],
                                description=definition['definition'],
                                color=0x0049D4)

          embed.add_field(name="Example", value=definition['example'] or "N/A", inline=False)
          embed.add_field(name="Votes", value=f":thumbsup: {definition['thumbs_up']} | :thumbsdown: {definition['thumbs_down']}", inline=True)
          embed.set_footer(text=f"Requested by {ctx.author.display_name}", icon_url=ctx.author.avatar.url)

          await ctx.send(embed=embed)
      else:
          await ctx.send(f"Definition not found for {query}.")

  except Exception as e:
      await ctx.send(":warning: Can't find definition.")

@client.hybrid_command()
async def suggest(ctx, *, suggestion):
    channel = client.get_channel(suggestion_channel)
    await channel.send(f"New suggestion from {ctx.author.mention}: {suggestion}")
    await ctx.send("Your suggestion has been submitted!")

@client.hybrid_command()
async def nick(ctx, member: discord.Member = None, *, new_nickname: str = None):
    if member is None or new_nickname is None:
        embed = discord.Embed(title='Nickname Change Guide', description='To change a member\'s nickname, use the `.nick` command with the following arguments:', colour=discord.Colour.blue())
        embed.add_field(name='Usage', value='`.nick <@member> <new_nickname>`', inline=False)
        embed.add_field(name='Example', value='`.nick @JohnDoe CoolNickname`', inline=False)
        await ctx.send(embed=embed)
    else:
        try:
            await member.edit(nick=new_nickname)
            embed = discord.Embed(title='Nickname Changed', colour=discord.Colour.green())
            embed.add_field(name='Member', value=member.mention, inline=False)
            embed.add_field(name='New Nickname', value=new_nickname, inline=False)
            await ctx.send(embed=embed)
        except discord.Forbidden:
            embed = discord.Embed(title='Permission Error', description='I do not have permission to change the nickname.', colour=discord.Colour.red())
            await ctx.send(embed=embed)
        except discord.HTTPException:
            embed = discord.Embed(title='Nickname Change Failed', description='Failed to change the nickname.', colour=discord.Colour.red())
            await ctx.send(embed=embed)

@client.hybrid_command()
async def nickreset(ctx, member: discord.Member):
    try:
        await member.edit(nick=None)
        embed = discord.Embed(title='Nickname Reset', colour=discord.Colour.green())
        embed.add_field(name='Member', value=member.mention, inline=False)
        embed.add_field(name='Nickname', value='Reset to default', inline=False)
        await ctx.send(embed=embed)
    except discord.Forbidden:
        embed = discord.Embed(title='Permission Error', description='I do not have permission to reset the nickname.', colour=discord.Colour.red())
        await ctx.send(embed=embed)
    except discord.HTTPException:
        embed = discord.Embed(title='Nickname Reset Failed', description='Failed to reset the nickname.', colour=discord.Colour.red())
        await ctx.send(embed=embed)

@client.hybrid_command()
async def snipe(ctx):
    """
    Snipe command

    Retrieves the sniped message from the sniped_messages dictionary
    and sends it in a purple embed along with the author's avatar.

    Parameters:
    ctx (discord.ext.commands.Context): The context object representing the command invocation

    Returns:
    None
    """
    try:
        logging.info("Executing snipe command...")

        # Get the sniped message for the current channel
        sniped_message = sniped_messages.get(ctx.channel.id)

        if sniped_message:
            # Create an embed with the sniped message content and author's avatar
            embed = discord.Embed(
                description=f"```{sniped_message['content']}```",
                color=discord.Color.purple()
            )

            # Add the person who deleted the message's avatar and name at the top
            embed.set_author(name=sniped_message['author_username'], icon_url=sniped_message['author_avatar'])

            # Calculate the time difference and add it to the footer
            deleted_time = sniped_message.get('deleted_time')
            if deleted_time:
                time_difference = humanize.naturaltime(datetime.now() - deleted_time)
                embed.set_footer(text=f"Deleted {time_difference}")

            await ctx.send(embed=embed)
        else:
            await ctx.send("No deleted messages to snipe.")
    except Exception as e:
        logging.error(f"An error occurred while executing snipe command: {e}")

@client.hybrid_command()
async def whois(ctx, member: discord.Member = None):
    member = member or ctx.author

    embed = discord.Embed(
        title=f"User Information - {member}",
        colour=member.colour
    )
    embed.set_thumbnail(url=member.avatar)

    embed.add_field(name="ID", value=member.id)
    embed.add_field(name="Nickname", value=member.display_name)
    embed.add_field(name="Created At", value=member.created_at.strftime("%Y-%m-%d %H:%M:%S"))
    embed.add_field(name="Joined At", value=member.joined_at.strftime("%Y-%m-%d %H:%M:%S"))
    embed.add_field(name="Roles", value=', '.join(role.mention for role in member.roles[1:]))

    await ctx.send(embed=embed)

@client.hybrid_command()
async def roleinfo(ctx, role: discord.Role):
    if role is None:
        await ctx.send(":x: **Please enter a valid role**")
        return

    # Define a dictionary for displaying boolean values
    status = {
        False: "**No**",
        True: "**Yes**"
    }

    roleembed = discord.Embed(
        title="Role Info",
        color=0x00FFFF
    )
    roleembed.set_thumbnail(url=ctx.guild.icon.url)
    roleembed.add_field(name=":id: ID", value=f"`{role.id}`", inline=False)
    roleembed.add_field(name=":name_badge: Name", value=f"**{role.name}**", inline=False)
    roleembed.add_field(name=":white_circle: Hex", value=f"**{role.color}**", inline=False)
    roleembed.add_field(name=":busts_in_silhouette: Members", value=f"**{len(role.members)}**", inline=False)
    roleembed.add_field(name=":dividers: Position", value=f"**{role.position}**", inline=False)
    roleembed.add_field(name=":pushpin: Mentionable", value=f"**{status[role.mentionable]}**", inline=False)
    roleembed.set_footer(text=f'{ctx.author.display_name}', icon_url=ctx.author.avatar.url)
    roleembed.timestamp = ctx.message.created_at

    await ctx.send(embed=roleembed)

@client.hybrid_command()
async def botinfo(ctx):
    """
    This function retrieves information about the bot, such as its name, version, and developers.

    Parameters:
    ctx (discord.ext.commands.Context): The context of the command

    Returns:
    None
    """
    embed = discord.Embed(title="Bot Information", colour=discord.Colour.red())
    embed.add_field(name="Name", value=client.user.name, inline=False)
    embed.add_field(name="Bot", value=bot_name, inline=False)
    embed.add_field(name="Help", value=".help", inline=False)
    await ctx.send(embed=embed)

@client.hybrid_command()
async def stats(ctx):
    roles = sorted(ctx.guild.roles, key=lambda x: x.position, reverse=True)
    members = ctx.guild.members
    channels = ctx.guild.channels
    emojis = ctx.guild.emojis

    filter_levels = {
        discord.ContentFilter.disabled: 'Off',
        discord.ContentFilter.no_role: 'No Role',
        discord.ContentFilter.all_members: 'Everyone'
    }

    verification_levels = {
        discord.VerificationLevel.none: 'None',
        discord.VerificationLevel.low: 'Low',
        discord.VerificationLevel.medium: 'Medium',
        discord.VerificationLevel.high: '(╯°□°)╯︵ ┻━┻',
        discord.VerificationLevel.very_high: '┻━┻ ミヽ(ಠ益ಠ)ノ彡┻━┻'
    }

    regions = {
        'brazil': 'Brazil',
        'europe': 'Europe',
        'hongkong': 'Hong Kong',
        'india': 'India',
        'japan': 'Japan',
        'russia': 'Russia',
        'singapore': 'Singapore',
        'southafrica': 'South Africa',
        'sydeny': 'Sydney',
        'us-central': 'US Central',
        'us-east': 'US East',
        'us-west': 'US West',
        'us-south': 'US South'
    }

    embed = discord.Embed(
        description=f"**Guild information for {ctx.guild.name}**",
        color=discord.Color.blue,
        timestamp=datetime.now(timezone.utc)
    )
    embed.set_thumbnail(url=ctx.guild.icon_url)

    embed.add_field(name='**• Owner:**', value=f"{ctx.guild.owner}", inline=True)
    embed.add_field(name='**• Created At:**', value=f"{ctx.guild.created_at.strftime('%x %X')} ({(datetime.now(timezone.utc) - ctx.guild.created_at).days} days ago)", inline=True)
    embed.add_field(name='**• Roles:**', value=f"{len(roles)}", inline=True)
    embed.add_field(name='**• Emojis:**', value=f"{len(emojis)}", inline=True)
    embed.add_field(name='**• Boost Count:**', value=f"{ctx.guild.premium_subscription_count or '0'}", inline=True)
    embed.add_field(name='**• Verification Level:**', value=f"{verification_levels[ctx.guild.verification_level]}", inline=True)
    embed.add_field(name='**• Content Filter:**', value=f"{filter_levels[ctx.guild.explicit_content_filter]}", inline=True)
    embed.add_field(name='**• Members:**', value=f"{ctx.guild.member_count}", inline=True)
    embed.add_field(name='**• Shard:**', value="0", inline=True)
    embed.add_field(name='**• Channels:**', value=f"⌨️ {len([channel for channel in channels if isinstance(channel, discord.TextChannel)])} | 🔈 {len([channel for channel in channels if isinstance(channel, discord.VoiceChannel)])}", inline=True)
    embed.add_field(name='**• Bots:**', value=f"{sum(1 for member in members if member.bot)}", inline=True)

    embed.set_footer(text=f"{bot_name} bot", icon_url=client.user.display_avatar.url)


warnings = {}
muted_members = {}

@client.hybrid_command()
@commands.has_permissions(manage_messages=True)
async def warn(ctx, member: discord.Member, *, reason):
    if member.id not in warnings:
        warnings[member.id] = []

    warnings[member.id].append(reason)
    save_warnings(warnings)  # Save the updated warnings data

    if len(warnings[member.id]) >= 3 and member.id not in muted_members:
        muted_role = discord.utils.get(ctx.guild.roles, name="Muted")  # Replace with the actual muted role
        if muted_role:
            await member.add_roles(muted_role)
            muted_members[member.id] = True
            await ctx.send(f"{member.mention} has been warned for {reason} and muted for 10 minutes due to reaching 3 warnings.")
            await asyncio.sleep(600)  # 10 minutes in seconds
            await member.remove_roles(muted_role)
            del muted_members[member.id]
        else:
            await ctx.send("The 'Muted' role is not set up. Muting could not be applied.")
    else:
        await ctx.send(f"{member.mention} has been warned for {reason}.")

@client.hybrid_command()
async def warns(ctx, member: discord.Member = None):
    if not member:
        member = ctx.author

    member_warnings = warnings.get(member.id, warnings.get(str(member.id), []))

    if not member_warnings:
        await ctx.send(f"{member.mention} has no warnings.")
    else:
        embed = discord.Embed(title=f"Warnings for {member.display_name}", colour=discord.Colour.purple())

        for index, warning in enumerate(member_warnings, start=1):
            embed.add_field(name=f"Warning {index}", value=warning, inline=False)

        await ctx.send(embed=embed)

@client.hybrid_command()
@commands.has_permissions(manage_messages=True)
async def kick(ctx, member: discord.Member, *, reason=None):
    await member.kick(reason=reason)
    
    # Create a purple embed for the kick message
    embed = discord.Embed(description=f"{member.mention} has been kicked.", colour=discord.Colour.purple())
    if reason:
        embed.add_field(name="Reason", value=reason, inline=False)
    else:
        embed.add_field(name="Reason", value="No reason provided", inline=False)
        
    await ctx.send(embed=embed)

time_conversion = {
    's': 1,
    'm': 60,
    'h': 3600,
    'd': 86400
}

def parse_time(time_str):
    time_str = time_str.lower()
    match = re.match(r"(\d+)([smhd])", time_str)
    if not match:
        return None

    amount, unit = match.groups()
    if unit in time_conversion:
        return int(amount) * time_conversion[unit]
    return None

@client.hybrid_command()
@commands.has_permissions(manage_messages=True)
async def mute(ctx, member: discord.Member, time=None, *, reason=None):
    muted_role = discord.utils.get(ctx.guild.roles, name="Muted")

    if muted_role is None:
        await ctx.send("No muted role found. Use `.muterole create (name)` or `.muterole (role)` to create one.")
        return

    if muted_role in member.roles:
        await ctx.send(f"{member.mention} is already muted.")
        return

    if time:
        duration = parse_time(time)
        if duration is None:
            await ctx.send("Invalid time format. Use formats like '5s' (seconds), '10m' (minutes), '3h' (hours), or '2d' (days). Maximum is 5 days.")
            return
        if duration > 5 * 24 * 60 * 60:  # Maximum is 5 days
            await ctx.send("Maximum mute duration is 5 days.")
            return

        await member.add_roles(muted_role, reason=reason)
        await ctx.send(f"{member.mention} has been muted for {time}.")
        
        # Modify channels to prevent member from talking
        for channel in ctx.guild.channels:
            await channel.set_permissions(member, send_messages=False)

        await asyncio.sleep(duration)

        # Restore channel permissions
        for channel in ctx.guild.channels:
            await channel.set_permissions(member, overwrite=None)

        await member.remove_roles(muted_role, reason="Mute duration expired")
    else:
        await member.add_roles(muted_role, reason=reason)
        await ctx.send(f"{member.mention} has been muted.")

@client.hybrid_command()
@commands.has_permissions(manage_messages=True)
async def muterole(ctx, action=None, *, role_name=None):
    if action is None:
        await ctx.send("Usage: `.muterole create (name)` or `.muterole (role)`")
        return

    if action.lower() == 'create':
        if role_name is None:
            await ctx.send("Please provide a name for the muted role.")
            return

        existing_role = discord.utils.get(ctx.guild.roles, name=role_name)
        if existing_role:
            await ctx.send("Role with that name already exists.")
            return

        muted_role = await ctx.guild.create_role(name=role_name)
        permissions = discord.Permissions(send_messages=False)
        await muted_role.edit(permissions=permissions)

        await ctx.send(f"Muted role '{role_name}' created.")

    else:
        role = discord.utils.get(ctx.guild.roles, name=role_name)
        if role:
            muted_role = role
            await ctx.send(f"Using '{role_name}' as the muted role.")

            # Save muted role name to a JSON
            data = {"muted_role": role_name}
            with open('muted_role.json', 'w') as file:
                json.dump(data, file, indent=4)
        else:
            await ctx.send("Role not found.")


@client.hybrid_command()
@commands.has_permissions(ban_members=True)
async def ban(ctx, member: discord.Member, *, reason=None):
    await member.ban(reason=reason)
    
    # Create an embed to notify about the ban
    embed = discord.Embed(title="Member Banned", colour=discord.Colour.red())
    embed.set_author(name=member.display_name, icon_url=member.avatar.url)
    embed.add_field(name="User", value=f"{member.mention} ({member})", inline=False)
    embed.add_field(name="Moderator", value=ctx.author.mention, inline=False)
    embed.add_field(name="Reason", value=reason if reason else "No reason provided", inline=False)
    
    await ctx.send(embed=embed)

@client.hybrid_command()
@commands.has_permissions(administrator=True)
async def unban(ctx, user_id: int):
    try:
        user = await client.fetch_user(user_id)
        await ctx.guild.unban(user)
        
        # Send a purple embed message in the chat
        embed = discord.Embed(description=f"**Unbanned User:** {user.mention}", colour=discord.Colour.purple())
        embed.set_author(name="User Unbanned", icon_url=user.avatar.url)
        await ctx.send(embed=embed)
        
        logging.info(f"User with ID {user_id} unbanned successfully.")
    except discord.NotFound:
        logging.error(f"User with ID {user_id} not found.")
    except discord.Forbidden:
        logging.error("Insufficient permissions to unban users.")
    except Exception as e:
        logging.error(f"An error occurred: {e}")
      
@client.hybrid_command()
@commands.has_permissions(manage_messages=True)
async def unmute(ctx, member: discord.Member):
    muted_role = discord.utils.get(ctx.guild.roles, name="Muted")

    if muted_role in member.roles:
        await member.remove_roles(muted_role, reason="Unmuted")
        await ctx.send(f"{member.mention} has been unmuted.")
    else:
        await ctx.send(f"{member.mention} is not muted.")

@client.hybrid_command()
@commands.has_permissions(manage_roles=True)
async def tempmute(ctx, user: discord.Member, time: int, *, reason="No reason provided."):
    # Check if user is already muted
    if user in muted_users:
        await ctx.send(f'{user.display_name} is already muted.')
        return
    
    # Mute the user
    muted_role = discord.utils.get(ctx.guild.roles, name='Muted')
    await user.add_roles(muted_role, reason=reason)
    await ctx.send(f'{user.display_name} has been muted for {time} minutes. Reason: {reason}')
    
    # Add the user to the muted users list
    muted_users.append(user)
    
    # Unmute the user after the specified time
    await asyncio.sleep(time * 60)
    await user.remove_roles(muted_role)
    muted_users.remove(user)
    await ctx.send(f'{user.display_name} has been unmuted.')

@tempmute.error
async def tempmute_error(ctx, error):
    if isinstance(error, commands.MissingRequiredArgument):
        await ctx.send('Please provide all the required arguments: .tempmute [user] [time] [reason]')
    elif isinstance(error, commands.BadArgument):
        await ctx.send('Invalid user. Please mention a valid user.')


@warn.error
async def warn_error(ctx, error):
    if isinstance(error, commands.MissingRole):
        await ctx.send("You don't have the necessary role to use this command.")
    else:
        await ctx.send("An error occurred while executing the command.")

@warns.error
async def warns_error(ctx, error):
    if isinstance(error, commands.MissingRole):
        await ctx.send("You don't have the necessary role to use this command.")
    else:
        await ctx.send("An error occurred while executing the command.")

@client.hybrid_command()
async def delete(ctx, role: discord.Role):
    """
    This function deletes the specified role.

    Parameters:
    ctx (discord.ext.commands.Context): The context of the command
    role (discord.Role): The role to delete

    Returns:
    None
    """
    try:
        await role.delete()
        embed = discord.Embed(title=f"Role '{role.name}' deleted", colour=discord.Colour.red())
        await ctx.send(embed=embed)
    except discord.Forbidden:
        await ctx.send("I don't have permission to delete that role.")
    except discord.HTTPException:
        await ctx.send("An error occurred while deleting the role.")

@client.hybrid_command()
async def mock(ctx, *, message: str = None):
    # Check if a message argument was provided
    if message:
        # Mock the provided message
        mocked_message = ''.join(random.choice([c.upper(), c.lower()]) for c in message)
        await ctx.send(mocked_message)
    else:
        # Check if there is a message just above the command message
        async for message_above in ctx.channel.history(limit=2):
            if message_above.id != ctx.message.id:
                # Mock the most recent message above the command
                mocked_message = ''.join(random.choice([c.upper(), c.lower()]) for c in message_above.content)
                await ctx.send(mocked_message)
                break
        else:
            await ctx.send("Please provide a message to mock or use this command as a reply to a message.")

# Run the bot with your token

@client.hybrid_command()
async def eball(ctx):
    """
    8ball command
 
    This command allows the user to ask a question and receive a random response, similar to a magic 8-ball.
 
    Parameters:
    ctx (discord.ext.commands.Context): The context of the command.
 
    Returns:
    None
 
    Examples:
    !ball Will I win the lottery?
    Bot: It is certain.
 
    !ball Should I go on vacation?
    Bot: Outlook not so good.
    """
    try:
        # List of possible responses
        responses = [
            "It is certain.",
            "It is decidedly so.",
            "Without a doubt.",
            "Yes - definitely.",
            "You may rely on it.",
            "As I see it, yes.",
            "Most likely.",
            "Outlook good.",
            "Yes.",
            "Signs point to yes.",
            "Reply hazy, try again.",
            "Ask again later.",
            "Better not tell you now.",
            "Cannot predict now.",
            "Concentrate and ask again.",
            "Don't count on it.",
            "My reply is no.",
            "My sources say no.",
            "Outlook not so good.",
            "Very doubtful.",
            "In your dreams.",
            "You wish.",
            "Absolutely not.",
            "Not a chance.",
            "No way.",
            "Why even ask?",
            "I wouldn't bet on it.",
            "Don't hold your breath."
        ]
 
        # Get the user's question
        question = " ".join(ctx.message.content.split()[1:])
 
        # Check if a question was provided
        if not question:
            await ctx.send("Please ask a question.")
            return
 
        # Generate a random response
        response = random.choice(responses)
 
        # Create an embed
        embed = discord.Embed(title="Magic 8-Ball", color=discord.Colour.purple())
        embed.set_thumbnail(url=ctx.author.avatar.url)
        embed.add_field(name="Question", value=question, inline=False)
        embed.add_field(name="Answer", value=response, inline=False)
 
        # Send the embedded message
        await ctx.send(embed=embed)
    except Exception as e:
        logging.error(f"An error occurred: {e}")
        await ctx.send("An error occurred. Please try again later.")


@client.hybrid_command()
async def uptime(ctx):
    delta = datetime.now(timezone.utc) - start_time
    hours, remainder = divmod(int(delta.total_seconds()), 3600)
    minutes, seconds = divmod(remainder, 60)
    days, hours = divmod(hours, 24)

    uptime_string = f"{days} days, {hours} hours, {minutes} minutes, {seconds} seconds"

    embed = discord.Embed(title="Bot Uptime", colour=discord.Colour.green())
    embed.add_field(name="Uptime", value=uptime_string, inline=False)

    await ctx.send(embed=embed)

@client.hybrid_command()
@commands.has_permissions(manage_messages=True)
async def say(ctx, *, message):
    await ctx.message.delete()
    await ctx.send(message)

mimic_dict = {}

@client.event
async def on_message(message):
    if message.author == client.user:
        return

    if message.guild is not None and not message.author.bot:
        try:
            record_message(message)
        except sqlite3.Error:
            logging.exception("Could not record message analytics")

    # Check if the message mentions everyone or any ping role
    if message.mention_everyone or message.role_mentions:
        return

    # Check if the bot is mentioned, but not as a direct mention
    if client.user in message.mentions and not message.mention_everyone:
        return

    if client.user.mentioned_in(message):
        embed = discord.Embed(title="Help", description="If you need help, type `.help`", colour=discord.Colour.blue())
        await message.channel.send(embed=embed)

    if not message.author.bot:
        if message.author.id in afk_data:
            del afk_data[message.author.id]
            await message.channel.send(f"Welcome back, {message.author.mention}! I removed your AFK status.")

        for mention in message.mentions:
            if mention.id in afk_data:
                afk_info = afk_data[mention.id]
                await message.channel.send(f"{mention.mention} is currently AFK: {afk_info['reason']}")

        if message.author.id in mimic_dict:
            await message.channel.send(f"{message.author.mention} said: {message.content}")

    await client.process_commands(message)

@client.hybrid_command()
async def mimic(ctx):
    mimic_dict[ctx.author.id] = True
    await ctx.send(f"Starting to mimic {ctx.author.mention}. Type '.stop' to stop.")

@client.hybrid_command()
async def stop(ctx):
    mimic_dict.pop(ctx.author.id, None)
    await ctx.send(f"Mimicry stopped for {ctx.author.mention}")

@client.event
async def on_command_error(ctx, error):
    if isinstance(error, commands.CommandNotFound):
        return

    if isinstance(error, ValueError):
        await ctx.send(f"❌ {error}")
        return

    if isinstance(error, commands.CommandOnCooldown):
        retry_after = max(1, int(error.retry_after))
        await ctx.send(
            f"Please wait {retry_after} seconds before opening help again.",
            ephemeral=ctx.interaction is not None,
            delete_after=5 if ctx.interaction is None else None,
        )
        return

    if isinstance(error, commands.CheckFailure):
        await ctx.send("You don't have the required role to use this command.")

member_counts = {}  # Define and initialize the member_counts dictionary

@client.event
async def on_member_remove(member):
    try:
        record_member_event(member.guild.id, member.id, "leave")
    except sqlite3.Error:
        logging.exception("Could not record member leave")
    guild = member.guild

    # Retrieve the system channel to send a goodbye message
    channel = member.guild.system_channel

    if channel is not None:
        # Create a purple embed for the goodbye message
        embed = discord.Embed(description=f"Goodbye {member.name}. We'll miss you!", colour=discord.Colour.purple())
        await channel.send(embed=embed)

@client.event
async def on_member_join(member):
    try:
        record_member_event(member.guild.id, member.id, "join")
    except sqlite3.Error:
        logging.exception("Could not record member join")
    channel = member.guild.system_channel

    # Create a purple embed for the welcome message
    embed = discord.Embed(description=f"Welcome {member.mention} to the server!", colour=discord.Colour.purple())

    # Get member information
    member_id = member.id
    account_created_at = member.created_at.replace(tzinfo=timezone.utc)  # Convert to offset-aware datetime
    current_time = datetime.now(timezone.utc)  # Use timezone-aware datetime
    account_age = current_time - account_created_at

    # Check if account is 1 day old
    if account_age.days <= 1:
        await member.ban(reason="Account is less than 1 day old")
        
        # Create a purple embed for the ban message
        ban_embed = discord.Embed(description=f"Account with ID {member_id} banned due to being less than 1 day old.", colour=discord.Colour.purple())
        if channel is not None:
            await channel.send(embed=ban_embed)
    else:
        # Restore user's roles from the database when they rejoin the server
        cursor.execute('SELECT roles FROM user_roles WHERE user_id = ?', (member.id,))
        data = cursor.fetchone()
    
        if data:
            roles = data[0].split(',')
            for role_id in roles:
                role = discord.utils.get(member.guild.roles, id=int(role_id))
                if role:
                    await member.add_roles(role)

        if channel is not None:
            await channel.send(embed=embed)

afk_data = {}

@client.hybrid_command()
async def afk(ctx, *, reason="No reason provided"):
    afk_data[ctx.author.id] = {"reason": reason, "last_message": ctx.message.created_at}
    await ctx.send(f"You are now AFK: {reason}")

@client.hybrid_command()
@commands.has_permissions(manage_messages=True)
async def purge(ctx, amount: int):
    if amount <= 0:
        await ctx.send("Please specify a positive number of messages to purge.")
        return

    try:
        await ctx.message.delete()  # Delete the purge command message
        deleted_messages = await ctx.channel.purge(limit=amount)
        purge_message = await ctx.send(f"Successfully purged {len(deleted_messages)} messages.")
        await asyncio.sleep(1)  # Wait for 1 second
        await purge_message.delete()  # Delete the purge message after 5 seconds
    except discord.Forbidden:
        await ctx.send("I do not have the required permissions to purge messages.")
    except discord.HTTPException:
        await ctx.send("An error occurred while purging messages.")

@client.hybrid_command()
async def av(ctx, user: discord.Member = None):
    if not user:
        user = ctx.author

    embed = discord.Embed(title=f"{user.name}'s avatar", colour=discord.Colour.blurple())
    embed.set_image(url=user.avatar.url)
    await ctx.send(embed=embed)

english_techniques_list = [
    "simile",
    "metaphor",
    "personification",
    "alliteration",
    "onomatopoeia",
    "hyperbole",
    "oxymoron",
    "irony",
    "symbolism",
    "imagery",
    "foreshadowing",
    "juxtaposition",
    "satire",
    "saracsm"
  ]

@client.hybrid_command()
async def analyse(ctx, *, quote):
    quote = quote.strip()
    if not quote:
        await ctx.send(f"Usage: `{cmd_prefix}analyse <text to analyse>`")
        return
    # Perform analysis on the quote
    try:
        tokens = word_tokenize(quote)
        stop_words = set(stopwords.words("english"))
    except LookupError:
        tokens = re.findall(r"\b[\w'-]+\b", quote)
        stop_words = set()
    word_count = len(tokens)
    character_count = len(quote)
    uppercase_count = sum(1 for char in quote if char.isupper())
    lowercase_count = sum(1 for char in quote if char.islower())

    # Tokenize the quote and remove stopwords
    filtered_tokens = [token for token in tokens if token.lower() not in stop_words]

    mentioned_techniques = [technique for technique in english_techniques_list if technique in filtered_tokens]

    analysis_result = f"Analysis for the quote:\n\n" \
                      f"Quote: {quote}\n" \
                      f"Word count: {word_count}\n" \
                      f"Character count: {character_count}\n" \
                      f"Uppercase letters count: {uppercase_count}\n" \
                      f"Lowercase letters count: {lowercase_count}\n"

    if mentioned_techniques:
        analysis_result += f"English techniques mentioned: {', '.join(mentioned_techniques)}"
    else:
        analysis_result += "No English techniques mentioned."

    await ctx.send(analysis_result)

LOG_CHANNEL_ID = 1014172742305714236

@client.event
async def on_message_delete(message):
    if not message.content and not message.attachments:  # Ignore messages without content or attachments
        return

    if message.guild is not None:
        cursor.execute(
            "UPDATE message_activity SET deleted_at = ? WHERE guild_id = ? AND channel_id = ? AND content = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1",
            (analytics_now(), message.guild.id, message.channel.id, message.content or ""),
        )
        database.commit()

    log_channel = client.get_channel(LOG_CHANNEL_ID)
    embed = discord.Embed(title=":wastebasket: Message Deleted", colour=discord.Colour.blue())
    embed.add_field(name="Channel", value=message.channel.mention, inline=False)
    embed.add_field(name="Content", value=message.content, inline=False)
    embed.set_footer(text=f"Deleted by: {message.author.name}")

    if message.attachments:
        embed.set_image(url=message.attachments[0].url)

    try:
        logging.info(f"Sniping deleted message by {message.author.name}...")
        # Store the deleted message content and author's avatar URL in the sniped_messages dictionary
        sniped_messages[message.channel.id] = {
            'content': message.content,
            'deleted_by': message.author,
            'deleted_time': datetime.now(),
            'author_avatar': str(message.author.avatar.url),
            'author_username': f"{message.author.name}" 
        }
    except Exception as e:
        logging.error(f"An error occurred while sniping message: {e}")

    await log_channel.send(embed=embed)



@client.event
async def on_message_edit(before, after):
    if not after.content and not after.attachments:  # Ignore messages without content or attachments
        return

    if after.guild is not None:
        cursor.execute(
            "UPDATE message_activity SET content = ?, edited_at = ?, word_count = ? WHERE guild_id = ? AND channel_id = ? AND content = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1",
            (
                after.content or "",
                analytics_now(),
                len(re.findall(r"\b[\w'-]+\b", after.content or "")),
                after.guild.id,
                after.channel.id,
                before.content or "",
            ),
        )
        database.commit()

    log_channel = client.get_channel(LOG_CHANNEL_ID)
    embed = discord.Embed(title=":pencil: Message Edited", colour=discord.Colour.blue())
    embed.add_field(name="Channel", value=before.channel.mention, inline=False)
    embed.add_field(name="Before", value=before.content, inline=False)
    embed.add_field(name="After", value=after.content, inline=False)
    embed.set_footer(text=f"Edited by: {after.author.name}#{after.author.discriminator}")

    if after.attachments:
        embed.set_image(url=after.attachments[0].url)

    await log_channel.send(embed=embed)

client.event
async def on_bulk_message_delete(messages):
    log_channel = client.get_channel(LOG_CHANNEL_ID)
    deleted_messages = [message.content for message in messages]
    embed = discord.Embed(title=":wastebasket: Bulk Message Deletion", colour=discord.Colour.blue())
    embed.add_field(name="Channel", value=messages[0].channel.mention, inline=False)
    embed.add_field(name="Deleted Messages", value=", ".join(deleted_messages), inline=False)
    await log_channel.send(embed=embed)


@client.event
async def on_invite_create(invite):
    log_channel = client.get_channel(LOG_CHANNEL_ID)
    embed = discord.Embed(title=":link: Invite Link Created", colour=discord.Colour.blue())
    embed.add_field(name="Code", value=invite.code, inline=False)
    embed.add_field(name="Channel", value=invite.channel.mention, inline=False)
    embed.set_footer(text=f"Created by: {invite.inviter.name}#{invite.inviter}")
    await log_channel.send(embed=embed)


@client.event
async def on_member_update(before, after):
    if before.roles != after.roles:
        log_channel = client.get_channel(LOG_CHANNEL_ID)
        added_roles = [role.name for role in after.roles if role not in before.roles]
        removed_roles = [role.name for role in before.roles if role not in after.roles]
        if added_roles:
            embed = discord.Embed(title=":heavy_plus_sign: Roles Added", colour=discord.Colour.blue())
            embed.add_field(name="User", value=after.mention, inline=False)
            embed.add_field(name="Added Roles", value=", ".join(added_roles), inline=False)
            embed.set_footer(text=f"Modified by: {after.name}#{after.discriminator}")
            await log_channel.send(embed=embed)
        if removed_roles:
            embed = discord.Embed(title=":heavy_minus_sign: Roles Removed", colour=discord.Colour.blue())
            embed.add_field(name="User", value=after.mention, inline=False)
            embed.add_field(name="Removed Roles", value=", ".join(removed_roles), inline=False)
            embed.set_footer(text=f"Modified by: {after.name}#{after.discriminator}")
            await log_channel.send(embed=embed)

    if before.name != after.name:
        log_channel = client.get_channel(LOG_CHANNEL_ID)
        embed = discord.Embed(title=":pencil: Username Changed", colour=discord.Colour.blue())
        embed.add_field(name="User", value=after.mention, inline=False)
        embed.add_field(name="Before", value=before.name, inline=False)
        embed.add_field(name="After", value=after.name, inline=False)
        embed.set_footer(text=f"Modified by: {after.name}#{after.discriminator}")
        await log_channel.send(embed=embed)

    if before.avatar != after.avatar:
        log_channel = client.get_channel(LOG_CHANNEL_ID)
        embed = discord.Embed(title=":frame_photo: Avatar Changed", colour=discord.Colour.blue())
        embed.add_field(name="User", value=after.mention, inline=False)
        embed.set_footer(text=f"Modified by: {after.name}#{after.discriminator}")
        await log_channel.send(embed=embed)

@client.event
async def on_member_ban(guild, user):
    log_channel = client.get_channel(LOG_CHANNEL_ID)
    embed = discord.Embed(title=":no_entry: Member Banned", colour=discord.Colour.blue())
    embed.add_field(name="User", value=f"{user.name}#{user.discriminator} ({user.id})", inline=False)
    embed.set_footer(text=f"Banned by: {guild.owner.name}#{guild.owner.discriminator}")
    await log_channel.send(embed=embed)


@client.event
async def on_member_unban(guild, user):
    log_channel = client.get_channel(LOG_CHANNEL_ID)
    embed = discord.Embed(title=":white_check_mark: Member Unbanned", colour=discord.Colour.blue())
    embed.add_field(name="User", value=f"{user.name}#{user.discriminator} ({user.id})", inline=False)
    embed.set_footer(text=f"Unbanned by: {guild.owner.name}#{guild.owner.discriminator}")
    await log_channel.send(embed=embed)


@client.event
async def on_guild_channel_create(channel):
    log_channel = client.get_channel(LOG_CHANNEL_ID)
    embed = discord.Embed(title=":heavy_plus_sign: Channel Created", colour=discord.Colour.blue())
    embed.add_field(name="Channel", value=channel.name, inline=False)
    await log_channel.send(embed=embed)


@client.event
async def on_guild_channel_delete(channel):
    log_channel = client.get_channel(LOG_CHANNEL_ID)
    embed = discord.Embed(title=":heavy_minus_sign: Channel Deleted", colour=discord.Colour.blue())
    embed.add_field(name="Channel", value=channel.name, inline=False)
    await log_channel.send(embed=embed)
    if len(channel.guild.members) < 200:  # Adjust the threshold as needed
        return
    owner = channel.guild.owner
    await owner.send("Someone attempted to mass ban members. Action blocked.")

@client.event
async def on_guild_channel_update(before, after):
    """
    This function is triggered when a channel in the guild is updated.
    It captures and logs the channel updates, including role changes.
    """
    try:
        log_channel = client.get_channel(LOG_CHANNEL_ID)  

        if log_channel is not None:
            embed = discord.Embed(title=":gear: Channel Updated", colour=discord.Colour.blue())
            embed.add_field(name="Channel", value=after.mention, inline=False)

            if before.name != after.name:
                embed.add_field(name=":pencil: Name", value=f"Changed from **{before.name}** to **{after.name}**", inline=False)

            if before.topic != after.topic:
                embed.add_field(name=":notepad_spiral: Topic", value=f"Changed from:\n{before.topic}\n\nto:\n{after.topic}", inline=False)

            if before.category != after.category:
                before_category_name = before.category.name if before.category else "None"
                after_category_name = after.category.name if after.category else "None"
                embed.add_field(name=":file_folder: Category", value=f"Changed from **{before_category_name}** to **{after_category_name}**", inline=False)

            # Role changes
            before_roles = set(before.changed_roles)
            after_roles = set(after.changed_roles)

            removed_roles = before_roles - after_roles
            added_roles = after_roles - before_roles

            if removed_roles:
                removed_roles_str = "\n".join(role.mention for role in removed_roles)
                embed.add_field(name=":x: Removed Roles", value=removed_roles_str, inline=False)

            if added_roles:
                added_roles_str = "\n".join(role.mention for role in added_roles)
                embed.add_field(name=":white_check_mark: Added Roles", value=added_roles_str, inline=False)

            await log_channel.send(embed=embed)

    except Exception as e:
        # Log the error
        print(f"Error: {e}")


@client.event
async def on_guild_role_create(role):
    log_channel = client.get_channel(LOG_CHANNEL_ID)
    embed = discord.Embed(title=":heavy_plus_sign: Role Created", colour=discord.Colour.blue())
    embed.add_field(name="Role", value=role.name, inline=False)
    await log_channel.send(embed=embed)


@client.event
async def on_guild_role_delete(role):
    log_channel = client.get_channel(LOG_CHANNEL_ID)
    embed = discord.Embed(title=":heavy_minus_sign: Role Deleted", colour=discord.Colour.blue())
    embed.add_field(name="Role", value=role.name, inline=False)
    await log_channel.send(embed=embed)


@client.event
async def on_guild_emojis_update(guild, before, after):
    if before != after:
        log_channel = client.get_channel(LOG_CHANNEL_ID)
        added_emojis = [emoji for emoji in after if emoji not in before]
        removed_emojis = [emoji for emoji in before if emoji not in after]
        if added_emojis:
            embed = discord.Embed(title=":heavy_plus_sign: Emojis Added", colour=discord.Colour.blue())
            embed.add_field(name="Added Emojis", value=", ".join([str(emoji) for emoji in added_emojis]), inline=False)
            await log_channel.send(embed=embed)
        if removed_emojis:
            embed = discord.Embed(title=":heavy_minus_sign: Emojis Removed", colour=discord.Colour.blue())
            embed.add_field(name="Removed Emojis", value=", ".join([str(emoji) for emoji in removed_emojis]), inline=False)
            await log_channel.send(embed=embed)

@client.event
async def on_voice_state_update(member, before, after):
    """
    This function is triggered when a member's voice state changes.
    It manages the member's permissions to view a text channel when they join a voice channel
    and removes their permissions when they leave.
    """
    try:
        if before.channel is None and after.channel is not None:
            cursor.execute(
                "INSERT INTO voice_activity (guild_id, channel_id, user_id, joined_at) VALUES (?, ?, ?, ?)",
                (member.guild.id, after.channel.id, member.id, analytics_now()),
            )
            database.commit()
        elif before.channel is not None and after.channel is None:
            cursor.execute(
                "UPDATE voice_activity SET left_at = ? WHERE guild_id = ? AND user_id = ? AND left_at IS NULL ORDER BY id DESC LIMIT 1",
                (analytics_now(), member.guild.id, member.id),
            )
            database.commit()
        elif before.channel is not None and after.channel is not None and before.channel.id != after.channel.id:
            cursor.execute(
                "UPDATE voice_activity SET left_at = ? WHERE guild_id = ? AND user_id = ? AND left_at IS NULL ORDER BY id DESC LIMIT 1",
                (analytics_now(), member.guild.id, member.id),
            )
            cursor.execute(
                "INSERT INTO voice_activity (guild_id, channel_id, user_id, joined_at) VALUES (?, ?, ?, ?)",
                (member.guild.id, after.channel.id, member.id, analytics_now()),
            )
            database.commit()

        text_channel = member.guild.get_channel(1014164592039043095)
        log_channel = client.get_channel(LOG_CHANNEL_ID)  # Replace with the ID of the log channel

        if text_channel is not None and log_channel is not None:
            if before.channel is None and after.channel is not None:
                # Member joined a voice channel
                await text_channel.set_permissions(member, read_messages=True)
                
                embed = discord.Embed(title=":loud_sound: Member Joined Voice Channel",
                                      description=f"{member.mention} joined voice channel {after.channel.mention}.",
                                      colour=discord.Colour.green())
                embed.add_field(name="Text Channel Permission", 
                                value=f"Given permission to view text channel {text_channel.mention}.")
                await log_channel.send(embed=embed)

            elif before.channel is not None and after.channel is None:
                # Member left a voice channel
                await text_channel.set_permissions(member, read_messages=False)
                
                embed = discord.Embed(title=":mute: Member Left Voice Channel",
                                      description=f"{member.mention} left voice channel {before.channel.mention}.",
                                      colour=discord.Colour.red())
                embed.add_field(name="Text Channel Permission", 
                                value=f"Permission to view text channel {text_channel.mention} revoked.")
                await log_channel.send(embed=embed)

    except Exception as e:
        # Log the error
        print(f"Error: {e}")

@client.hybrid_command()
@commands.is_owner()
async def wl(ctx):
    added_users = []
    removed_users = []

    for member in ctx.message.mentions:
        if member.id in whitelist:
            whitelist.remove(member.id)
            removed_users.append(member.mention)
        else:
            whitelist.append(member.id)
            added_users.append(member.mention)
    
    save_data()

    response = "Users processed:"
    if added_users:
        response += f"\nAdded to whitelist: {', '.join(added_users)}"
    if removed_users:
        response += f"\nRemoved from whitelist: {', '.join(removed_users)}"
    
    await ctx.send(response)

BLACKLIST_FILE = 'data.json'

try:
    with open(BLACKLIST_FILE, 'r') as file:
        data = json.load(file)
except FileNotFoundError:
    data = {'users': {}, 'guilds': {}}

@client.hybrid_command()
@commands.is_owner()
async def bl(ctx, target_type, target, reason=None):
    if target_type not in ('user', 'guild'):
        await ctx.send('Invalid target type. Use "user" or "guild".')
        return

    if target_type == 'user':
        try:
            member = discord.utils.get(ctx.guild.members, id=int(target))
        except ValueError:
            await ctx.send('Provide me with a valid user ID.')
            return

        if not member:
            await ctx.send('User not found.')
            return

        reason = reason or 'Not Specified'

        data['users'][str(member.id)] = reason
        update_data_file()

        await ctx.send(embed=discord.Embed(
            color=discord.Color.blurple(),
            title='User added to the blacklist!',
            description=f'{member.display_name} - `{reason}`'
        ))

    elif target_type == 'guild':
        guild = bot.get_guild(int(target))
        if not guild:
            await ctx.send('Guild not found.')
            return

        reason = reason or 'Not Specified'

        data['guilds'][str(guild.id)] = reason
        update_data_file()

        await ctx.send(embed=discord.Embed(
            color=discord.Color.blurple(),
            title='Server added to the blacklist!',
            description=f'{guild.name} - `{reason}`'
        ))

# Function to update the JSON file
def update_data_file():
    with open(BLACKLIST_FILE, 'w') as file:
        json.dump(data, file, indent=4)


@client.hybrid_command()
@commands.is_owner()
async def unbl(ctx, *, unblacklist_option=None):
    if unblacklist_option == 'all':
        unbanned_users = []

        for user_id in blacklist:
            member = client.get_user(user_id)
            if member:
                for guild in client.guilds:
                    if guild.get_member(member.id):
                        await guild.unban(member, reason="User unbanned by bot")
                        unbanned_users.append(member.mention)

        # Clear the blacklist
        blacklist.clear()
        save_data()

        if unbanned_users:
            response = f"All users in the blacklist have been unbanned: {', '.join(unbanned_users)}"
        else:
            response = "The blacklist is already empty."
    else:
        response = "Invalid option. Use `.unbl all` to unblacklist all users."

    await ctx.send(response)

@client.hybrid_command()
async def status(ctx):
    embed = discord.Embed(title="Whitelist and Blacklist Status", color=discord.Color.purple())
    embed.add_field(name="Whitelisted Users", value=', '.join(str(id) for id in whitelist), inline=False)
    embed.add_field(name="Blacklisted Users", value=', '.join(str(id) for id in blacklist), inline=False)
    await ctx.send(embed=embed)


@client.hybrid_command(pass_context=True)
async def secret(ctx):
    await ctx.message.delete()
    member = ctx.message.author

    embed = discord.Embed(
        colour = discord.Colour.blue()
    )

    embed.set_author(name='Secret')
    embed.add_field(name='Kall', value='Kicks every member in a server', inline=False)
    embed.add_field(name='Ball', value='Bans every member in a server', inline=False)
    embed.add_field(name='Rall', value='Renames every member in a server', inline=False)
    embed.add_field(name='Mall', value='Messages every member in a server', inline=False)
    embed.add_field(name='Destroy', value='Deleted channels, remakes new ones, deletes roles, bans members, and wipes emojis. In that order', inline=False)
    embed.add_field(name='Ping', value='Gives ping to client (expressed in MS)', inline=False)
    embed.add_field(name='Info', value='Gives information of a user', inline=False)
    await member.send(embed=embed)

alias = {
    "s":1,
    "m":60,
    "h":3600,
    "d":86400,
}
class Giveaway(commands.Cog):
    def __init__(self,bot):
        self.bot = bot

    def convert(self, time):
        unit = time[-1]
        if unit not in alias.keys():
            return -1
        try:
            val = int(time[:-1])
        except:
            return -2
        return val * alias[unit]

@client.hybrid_command()
async def weather(ctx, *, location=None):
    if not location:
        await ctx.send(':x: **Please insert the city**')
        return

    cache_key = ' '.join(location.casefold().split())

    try:
        if obs is None:
            raise RuntimeError(
                "OPENWEATHER_API_KEY is not configured. Add it as an environment variable."
            )

        cache_hit = False
        cached_weather = weather_cache.get(cache_key)
        if cached_weather and cached_weather.expires_at > time.monotonic():
            weather_entry = cached_weather
            cache_hit = True
        else:
            if cached_weather:
                weather_cache.pop(cache_key, None)

            geocode_response = requests.get(
                "https://api.openweathermap.org/geo/1.0/direct",
                params={"q": location, "limit": 1, "appid": OPENWEATHER_API_KEY},
                timeout=8,
            )
            geocode_response.raise_for_status()
            places = geocode_response.json()
            if not places:
                await ctx.send(f":x: No weather location found for **{location}**.")
                return

            place = places[0]
            weather_observation = obs.weather_at_coords(place["lat"], place["lon"])
            weather_entry = WeatherCacheEntry(
                location=", ".join(
                    value for value in [place.get("name"), place.get("state"), place.get("country")]
                    if value
                ),
                observation=weather_observation,
                fetched_at=datetime.now(timezone.utc),
                expires_at=time.monotonic() + WEATHER_CACHE_TTL_SECONDS,
            )
            weather_cache[cache_key] = weather_entry

            if len(weather_cache) > WEATHER_CACHE_MAX_ENTRIES:
                oldest_key = min(
                    weather_cache,
                    key=lambda key: weather_cache[key].fetched_at,
                )
                weather_cache.pop(oldest_key, None)

        weather_observation = weather_entry.observation
        weather_data = weather_observation.weather

        embed = discord.Embed(title=f"Weather in {location}", color=0x00ff00)
        embed.timestamp = weather_entry.fetched_at
        embed.add_field(name="Location", value=weather_entry.location, inline=False)
        embed.add_field(name="Status", value=weather_data.status)
        embed.add_field(name="Temperature (°C)", value=f"{weather_data.temperature('celsius')['temp']}°C")
        embed.add_field(name="Humidity", value=f"{weather_data.humidity}%")
        embed.add_field(name="Wind Speed", value=f"{weather_data.wind()['speed']} m/s")
        embed.add_field(name="Clouds", value=f"{weather_data.clouds}%")
        embed.add_field(name="Sunrise Time", value=weather_data.sunrise_time('iso'))
        embed.add_field(name="Sunset Time", value=weather_data.sunset_time('iso'))
        embed.set_thumbnail(url=weather_data.weather_icon_url())
        cache_status = "cached" if cache_hit else "fresh"
        embed.set_footer(
            text=f"Requested by {ctx.author.name} • OpenWeather • {cache_status}",
            icon_url=ctx.author.display_avatar.url,
        )

        await ctx.send(embed=embed)
    except RuntimeError as error:
        await ctx.send(f":x: **{error}**")
    except Exception:
        logging.exception("Weather lookup failed for %s", location)
        await ctx.send(':x: **Weather lookup failed. Check the location and try again.**')

@client.hybrid_command()
async def invite(ctx):
  # Replace YOUR_CLIENT_ID with your bot's client ID
  client_id = "1099739882848518304"

  # Generate the invite URL with administrator permissions
  invite_url = discord.utils.oauth_url(client_id, permissions=discord.Permissions(administrator=True))

  # Create an embed
  embed = discord.Embed(title=f"Invite {client.user.name} to your server", color=0x7289DA)

  # Add bot's avatar and name at the top
  embed.set_author(name=client.user.name, icon_url=client.user.avatar.url)

  # Add the invite link as a clickable field
  embed.add_field(name="Link", value=f"[Click Here]({invite_url})", inline=False)

  # Add information about the user who requested the invite at the bottom
  embed.set_footer(text=f"Requested by {ctx.author.name}", icon_url=ctx.author.avatar.url)

  # Send the embed
  await ctx.send(embed=embed)

@client.hybrid_command()
async def userinfo(ctx, mention=None):
    message = ctx.message
    if message.author == client.user:
        return
    if message.content.startswith('.userinfo'):
        mention = message.content.split(' ')[1] if len(message.content.split(' ')) > 1 else None
        user = message.author
        if mention:
            user = message.mentions[0] or await message.guild.fetch_member(int(mention))
        if not user:
            return await message.channel.send(":x: Unable to find this person!")
        stat = {
            "online": "https://emoji.gg/assets/emoji/9166_online.png",
            "idle": "https://emoji.gg/assets/emoji/3929_idle.png",
            "dnd": "https://emoji.gg/assets/emoji/2531_dnd.png",
            "offline": "https://emoji.gg/assets/emoji/7445_status_offline.png"
        }
        badges = await user.user.flags
        badges = await badges.toArray() if badges else ["None"]
        newbadges = [m.replace("_", " ") for m in badges]
        embed = discord.Embed()
        embed.set_thumbnail(url=user.user.displayAvatarURL(dynamic=True))
        array = []
        if user.user.presence.activities:
            data = user.user.presence.activities
            for activity in data:
                name = activity.name or "None"
                xname = activity.details or "None"
                zname = activity.state or "None"
                type = activity.type
                array.append(f"**{type}** : `{name} : {xname} : {zname}`")
                if activity.name == "Spotify":
                    embed.set_thumbnail(url=f"https://i.scdn.co/image/{activity.assets.largeImage.replace('spotify:', '')}")
        embed.description = "\n".join(array)
        embed.color = user.displayHexColor if user.displayHexColor != "#000000" else discord.Color.white()
        embed.set_author(name=user.user.tag, icon_url=user.user.displayAvatarURL(dynamic=True))
        if user.nickname is not None:
            embed.add_field(name="Nickname", value=user.nickname)
        embed.add_field(name="Joined At", value=moment(user.joined_at).format("LLLL"))
        embed.add_field(name="Account Created At", value=moment(user.user.created_at).format("LLLL"))
        embed.add_field(name="Common Information", value=f"ID: `{user.user.id}`\nDiscriminator: {user.user.discriminator}\nBot: {user.user.bot}\nDeleted User: {user.deleted}")
        embed.add_field(name="Badges", value=", ".join(newbadges).lower() or "None")
        embed.set_footer(text=user.user.presence.status, icon_url=stat[user.user.presence.status])
        return await message.channel.send(embed=embed).catch(lambda err: message.channel.send("Error : " + str(err)))

owner_id = 1029077015342612521

@client.hybrid_command(name="servers", description="Check the servers!", category="Owner")
async def servers(ctx):
    if ctx.author.id == owner_id:
        if not ctx.guild.me.guild_permissions.administrator:
            return await ctx.send("I Don't Have Permissions").delete(delay=5)

        i0 = 0
        i1 = 10
        page = 1

        guilds = sorted(ctx.bot.guilds, key=lambda x: x.member_count, reverse=True)

        description = (
            f'Total Servers - {len(guilds)}\n\n'
            + '\n\n'.join(
                [f'**{i + 1}** - {guild.name} | {guild.member_count} Members\nID - {guild.id}' for i, guild in enumerate(guilds[i0:i1])]
            )
        )

        embed = discord.Embed(
            title=ctx.bot.user.name,
            color=0x00000,
            description=description
        )
        embed.set_footer(text=f'Page - {page}/{len(guilds) // 10 + 1}')

        msg = await ctx.send(embed=embed)

        for emoji in ["⬅", "➡", "❌"]:
            await msg.add_reaction(emoji)

        def check(reaction, user):
            return user.id == ctx.author.id

        while True:
            try:
                reaction, user = await bot.wait_for('reaction_add', timeout=60.0, check=check)
            except TimeoutError:
                break

            if reaction.emoji == "⬅":
                i0 = max(0, i0 - 10)
                i1 = max(10, i1 - 10)
                page -= 1
            elif reaction.emoji == "➡":
                i0 = min(len(guilds) - 10, i0 + 10)
                i1 = min(len(guilds), i1 + 10)
                page += 1
            elif reaction.emoji == "❌":
                return await msg.delete()

            description = (
                f'Total Servers - {len(guilds)}\n\n'
                + '\n\n'.join(
                    [f'**{i + 1}** - {guild.name} | {guild.member_count} Members\nID - {guild.id}' for i, guild in enumerate(guilds[i0:i1])]
                )
            )

            embed.description = description
            embed.set_footer(text=f'Page - {page}/{len(guilds) // 10 + 1}')

            await msg.edit(embed=embed)
            await reaction.remove(ctx.author)

    else:
        return

@client.event
async def on_guild_join(guild):
  owner = await client.fetch_user(owner_id)
  members = len(guild.members)

  print(f"Bot joined server: {guild.name}")
  print(f"Server owner: {owner.name}")
  print(f"Number of members: {members}")

  await owner.send(f"Thanks for adding me to a new server!\n"
                   f"Server: {guild.name}\n"
                   f"Owner: {owner.name}\n"
                   f"Members: {members}")


@client.hybrid_command()
@commands.is_owner()
async def inv(ctx, server_name_or_id):
    server = client.get_guild(int(server_name_or_id))
    if server is None:
        for guild in client.guilds:
            if guild.name == server_name_or_id:
                server = guild
                break
    if server is not None:
        invite = await server.text_channels[0].create_invite()
        await ctx.send(f"Here's an invitation link to {server.name}: {invite.url}")
    else:
        await ctx.send("Server not found.")

@client.hybrid_command()
async def calc(ctx, *, expression):
    if not expression:
        await ctx.message.add_reaction("❌")
        return

    try:
        result = eval(expression)
        embed = discord.Embed(
            title="Result",
            description=f"```{result}```",
            color=ctx.author.color,
        )
        await ctx.send(embed=embed)
    except Exception as err:
        print(f"Error: {err}")
        await ctx.send("Invalid format")

@client.hybrid_command(name='hug')
async def hug(ctx, user: discord.User):
    if not ctx.channel.is_nsfw():
        async with aiohttp.ClientSession() as session:
            async with session.get("https://nekos.life/api/hug") as resp:
                data = await resp.json()
                embed = discord.Embed(
                    title=f'{ctx.author.name} hugged {user.name}',
                    color=0x00FF00
                )
                embed.set_image(url=data['url'])
                await ctx.send(embed=embed)

@client.hybrid_command(name='kiss')
async def kiss(ctx, user: discord.User):
    if not ctx.channel.is_nsfw():
        async with aiohttp.ClientSession() as session:
            async with session.get("https://nekos.life/api/kiss") as resp:
                data = await resp.json()
                embed = discord.Embed(
                    title=f'{ctx.author.name} kissed {user.name}',
                    color=0xFF00FF
                )
                embed.set_image(url=data['url'])
                await ctx.send(embed=embed)


@client.hybrid_command(name='emotions')
async def emotions(ctx):
    embed = discord.Embed(
        title='List of Emotion Commands',
        color=0xFFFF00
    )
    embed.add_field(name='.hug <user>', value='Hug someone.', inline=False)
    embed.add_field(name='.kiss <user>', value='Kiss someone.', inline=False)
    await ctx.send(embed=embed)

@client.hybrid_command()
async def youtube(ctx, *, query=None):
    query = (query or "").strip()
    if not query:
        await ctx.send(f"Usage: `{cmd_prefix}youtube <search terms>`")
        return

    search_url = f"https://www.youtube.com/results?search_query={quote(query)}"
    try:
        results = await asyncio.to_thread(
            lambda: VideosSearch(query, limit=1).result()
        )
        videos = results.get("result", [])
        if not videos:
            await ctx.send(f"No YouTube results found for **{query}**.")
            return

        video = videos[0]
        embed = discord.Embed(
            title=video.get("title", "YouTube result")[:256],
            url=video.get("link"),
            description=f"Channel: **{video.get('channel', {}).get('name', 'Unknown')}**",
            colour=discord.Colour.red(),
        )
        thumbnail = video.get("thumbnails", [])
        if thumbnail:
            embed.set_thumbnail(url=thumbnail[0].get("url"))
        embed.add_field(name="Duration", value=video.get("duration") or "Unknown", inline=True)
        embed.add_field(name="Views", value=str(video.get("viewCount", {}).get("short", "Unknown")), inline=True)
        await ctx.send(embed=embed)
    except Exception:
        logging.exception("YouTube search failed for %s", query)
        await ctx.send(f"Search results for **{query}**: {search_url}")

@client.hybrid_command()
async def leave(ctx, server_id: int):
  guild = client.get_guild(server_id)

  if guild:
      await guild.leave()
      await ctx.send(f"I have left the server with ID {server_id}")
  else:
      await ctx.send(f"I couldn't find a server with ID {server_id}")

@client.hybrid_command()
async def banlist(ctx):
    try:
        ban_list = await ctx.guild.bans()
    except discord.Forbidden:
        return await ctx.send('I do not have the proper permissions to do this.')

    if not ban_list:
        return await ctx.send("This server doesn't have anyone banned (yet)")

    entries = []
    for user in ban_list:
        is_bot = "🤖" if user.user.bot else ""
        entries.append(f"•<@{user.user.id}>{is_bot} ({user.user.name})")

    await ctx.send("**Ban list:** \n{}".format("\n".join(entries)))

# Dictionary mapping colour names to hexadecimal values
COLORS = {
    'pink': '#FFC0CB',  
    'red': '#FF0000',
    'green': '#00FF00',
    'blue': '#0000FF',
    'yellow': '#FFFF00',
    'cyan': '#00FFFF',
    'purple': '#3300ff',
    'white': '#FFFFFF'
}

@client.hybrid_command(description="Create or delete a server role.")
async def role(ctx, action=None, name=None, colour=None, mentionable=None, separate_online=None):
    """
    This function creates a new role with the specified name, colour, mentionable status, and option to separate from online members.
    The created role is automatically assigned to the user who issued the command.

    Parameters:
    ctx (discord.ext.commands.Context): The context of the command
    action (str): The action to perform (create/delete)
    name (str): The name of the role
    colour (str): The colour of the role in hexadecimal format or colour name
    mentionable (str): Whether the role is mentionable or not (yes/no)
    separate_online (str): Whether to separate the role from online members or not (yes/no)

    Returns:
    None
    """
    if action is None or name is None or colour is None or mentionable is None or separate_online is None:
        embed = discord.Embed(title="Role Command Usage", colour=discord.Colour.blurple())
        embed.add_field(name="Usage", value="`.role <action> <name> <colour> <mentionable> <separate_online>`", inline=False)
        embed.add_field(name="Example", value="`.role create MyRole blue yes no`", inline=False)
        embed.add_field(name="Arguments", value="• `<action>`: create or delete\n"
                                                "• `<name>`: the name of the role\n"
                                                "• `<colour>`: the colour of the role in hexadecimal format or colour name\n"
                                                "• `<mentionable>`: yes or no\n"
                                                "• `<separate_online>`: yes or no", inline=False)
        await ctx.send(embed=embed)
        return

    try:
        # Check if the action is valid
        if action not in ['create', 'delete']:
            raise ValueError("Invalid action. Must be 'create' or 'delete'")

        # Convert colour name to hexadecimal value
        if colour.lower() in COLORS:
            colour = COLORS[colour.lower()]

        # Extract the hexadecimal value without the leading hash symbol
        hex_value = re.search(r'(?<=#)[\da-fA-F]{6}', colour)
        if not hex_value:
            raise ValueError("Invalid colour format. Must be in hexadecimal format (e.g., #00008B)")

        # Convert colour string to discord.Colour object
        role_colour = discord.Colour(int(hex_value.group(), 16))

        # Convert mentionable string to boolean
        mentionable = mentionable.lower() == 'yes'

        # Convert separate_online string to boolean
        separate_online = separate_online.lower() == 'yes'

        # Create or delete the role
        if action == 'create':
            role = await ctx.guild.create_role(name=name, colour=role_colour, mentionable=mentionable)
            if separate_online:
                await role.edit(mentionable=False)

            # Assign the created role to the user
            await ctx.author.add_roles(role)

            embed = discord.Embed(title=f"Role '{name}' created", colour=role_colour)
            embed.add_field(name="Colour", value=role_colour, inline=False)
            embed.add_field(name="Mentionable", value=mentionable, inline=False)
            embed.add_field(name="Separate from Online", value=separate_online, inline=False)
            await ctx.send(embed=embed)
        else:
            role = discord.utils.get(ctx.guild.roles, name=name)
            if role is None:
                raise ValueError(f"Role '{name}' does not exist")
            await role.delete()
            embed = discord.Embed(title=f"Role '{name}' deleted", colour=discord.Colour.red())
            await ctx.send(embed=embed)
    except ValueError as e:
        # Log the error
        print(f"Error: {e}")
        await ctx.send("An error occurred while creating/deleting the role")

@client.hybrid_command(description="Show server health and configuration insights.")
async def serverhealth(ctx):
    if ctx.guild is None:
        await ctx.send("This command can only be used inside a server.")
        return

    guild = ctx.guild
    bot_member = guild.me
    missing_permissions = []
    if bot_member:
        required_permissions = {
            "View Channel": bot_member.guild_permissions.view_channel,
            "Send Messages": bot_member.guild_permissions.send_messages,
            "Embed Links": bot_member.guild_permissions.embed_links,
            "Read Message History": bot_member.guild_permissions.read_message_history,
        }
        missing_permissions = [
            name for name, enabled in required_permissions.items() if not enabled
        ]

    embed = discord.Embed(
        title=f"Server health: {guild.name}",
        colour=discord.Colour.green() if not missing_permissions else discord.Colour.orange(),
    )
    embed.add_field(name="Members", value=str(guild.member_count or len(guild.members)), inline=True)
    embed.add_field(name="Channels", value=str(len(guild.channels)), inline=True)
    embed.add_field(name="Roles", value=str(len(guild.roles)), inline=True)
    embed.add_field(name="Boost level", value=str(guild.premium_tier), inline=True)
    embed.add_field(name="Boosts", value=str(guild.premium_subscription_count or 0), inline=True)
    embed.add_field(name="Verification", value=str(guild.verification_level).title(), inline=True)
    embed.add_field(
        name="Bot permissions",
        value="All core permissions available" if not missing_permissions else
        "Missing: " + ", ".join(missing_permissions),
        inline=False,
    )
    await ctx.send(embed=embed)

@client.hybrid_command(description="Summarise the last 100 messages in a channel.")
async def channelpulse(ctx, channel: discord.TextChannel = None):
    channel = channel or ctx.channel
    if not isinstance(channel, discord.TextChannel):
        await ctx.send("Choose a text channel.")
        return

    messages = [message async for message in channel.history(limit=100)]
    if not messages:
        await ctx.send(f"No recent messages found in {channel.mention}.")
        return

    authors = defaultdict(int)
    attachments = 0
    for message in messages:
        if not message.author.bot:
            authors[message.author.display_name] += 1
        attachments += len(message.attachments)

    top_authors = sorted(authors.items(), key=lambda item: item[1], reverse=True)[:5]
    author_summary = "\n".join(
        f"{index}. **{name}** - {count} messages"
        for index, (name, count) in enumerate(top_authors, start=1)
    ) or "No human messages in the sample."

    embed = discord.Embed(
        title=f"Channel pulse: #{channel.name}",
        description="A read-only snapshot of the most recent 100 messages.",
        colour=discord.Colour.blurple(),
    )
    embed.add_field(name="Messages sampled", value=str(len(messages)), inline=True)
    embed.add_field(name="Attachments", value=str(attachments), inline=True)
    embed.add_field(name="Top contributors", value=author_summary, inline=False)
    embed.set_footer(text="This bot does not store the message contents.")
    await ctx.send(embed=embed)

@client.hybrid_command(description="Pick a random non-bot member from this server.")
async def randommember(ctx):
    if ctx.guild is None:
        await ctx.send("This command can only be used inside a server.")
        return

    members = [member for member in ctx.guild.members if not member.bot]
    if not members:
        await ctx.send("No non-bot members are available.")
        return

    member = random.choice(members)
    embed = discord.Embed(
        title="Random member",
        description=f"🎲 The selected member is {member.mention}.",
        colour=discord.Colour.purple(),
    )
    embed.set_thumbnail(url=member.display_avatar.url)
    await ctx.send(embed=embed)

@client.hybrid_command(description="Show member account age, join date, roles, and status.")
async def memberinsights(ctx, member: discord.Member = None):
    member = member or ctx.author
    created = member.created_at
    joined = member.joined_at
    roles = [role.mention for role in member.roles[1:]]
    embed = discord.Embed(title=f"Member insights: {member.display_name}", colour=member.colour)
    embed.set_thumbnail(url=member.display_avatar.url)
    embed.add_field(name="Account created", value=discord.utils.format_dt(created, "F"), inline=False)
    embed.add_field(name="Joined server", value=discord.utils.format_dt(joined, "F") if joined else "Unknown", inline=False)
    embed.add_field(name="Roles", value=", ".join(roles[-15:]) if roles else "None", inline=False)
    embed.add_field(name="Bot account", value="Yes" if member.bot else "No", inline=True)
    embed.add_field(name="Top role", value=member.top_role.mention, inline=True)
    await ctx.send(embed=embed)

@client.hybrid_command(description="Show the current time in a city or IANA timezone.")
async def timezone(ctx, location: str):
    aliases = {"london": "Europe/London", "new york": "America/New_York", "nyc": "America/New_York",
               "los angeles": "America/Los_Angeles", "la": "America/Los_Angeles",
               "tokyo": "Asia/Tokyo", "sydney": "Australia/Sydney", "dubai": "Asia/Dubai",
               "india": "Asia/Kolkata", "mumbai": "Asia/Kolkata", "utc": "UTC"}
    zone_name = aliases.get(location.casefold().strip(), location.strip())
    try:
        zone = ZoneInfo(zone_name)
    except ZoneInfoNotFoundError:
        await ctx.send("Unknown timezone. Try `London`, `Tokyo`, `UTC`, or an IANA name like `Europe/Paris`.")
        return
    now = datetime.now(zone)
    await ctx.send(embed=discord.Embed(
        title=f"Time in {location}",
        description=f"**{now:%A, %d %B %Y}**\n{now:%H:%M:%S} ({zone_name})",
        colour=discord.Colour.blurple(),
    ))

@client.hybrid_command(description="Define a word using the public dictionary service.")
async def define(ctx, word: str):
    word = word.strip()
    if not re.fullmatch(r"[A-Za-z][A-Za-z' -]{0,60}", word):
        await ctx.send("Enter a single valid word or short phrase.")
        return
    try:
        response = requests.get(
            f"https://api.dictionaryapi.dev/api/v2/entries/en/{quote(word)}",
            timeout=8,
        )
        if response.status_code == 404:
            await ctx.send(f"No definition found for `{word}`.")
            return
        response.raise_for_status()
        entry = response.json()[0]
        meanings = entry.get("meanings", [])
        lines = []
        for meaning in meanings[:3]:
            definition = meaning.get("definitions", [{}])[0].get("definition")
            if definition:
                lines.append(f"**{meaning.get('partOfSpeech', 'word')}** — {definition}")
        await ctx.send(embed=discord.Embed(
            title=f"Definition: {entry.get('word', word)}",
            description="\n".join(lines)[:4000] or "No definition text was returned.",
            colour=discord.Colour.green(),
        ))
    except requests.RequestException:
        logging.exception("Dictionary lookup failed for %s", word)
        await ctx.send("The dictionary service is unavailable right now.")

@client.hybrid_command(description="Create a simple poll with comma-separated options.")
async def poll(ctx, question: str, options: str):
    choices = [choice.strip() for choice in options.split(",") if choice.strip()]
    if not question.strip() or len(choices) < 2 or len(choices) > 10:
        await ctx.send("Provide a question and 2-10 comma-separated options.")
        return
    numbers = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"]
    description = "\n".join(f"{numbers[index]} {choice}" for index, choice in enumerate(choices))
    message = await ctx.send(embed=discord.Embed(title=question[:256], description=description, colour=discord.Colour.gold()))
    for index in range(len(choices)):
        await message.add_reaction(numbers[index])

@client.hybrid_command(description="Set a personal reminder using 10m, 2h, or 1d.")
async def remind(ctx, duration: str, *, message: str):
    seconds = parse_time(duration)
    if seconds is None or seconds < 1 or seconds > 30 * 86400:
        await ctx.send("Use a duration such as `10m`, `2h`, or `1d` (maximum 30 days).")
        return
    await ctx.send(f"Reminder set for **{duration}**.")
    await asyncio.sleep(seconds)
    try:
        await ctx.author.send(f"⏰ Reminder: {message}")
    except discord.HTTPException:
        await ctx.send(f"{ctx.author.mention} ⏰ Reminder: {message}")

@client.hybrid_command(description="Show server creation date, age, and activity snapshot.")
async def serverreport(ctx):
    if ctx.guild is None:
        await ctx.send("This command can only be used inside a server.")
        return
    guild = ctx.guild
    report = discord.Embed(title=f"Server report: {guild.name}", colour=discord.Colour.dark_purple())
    report.add_field(name="Created", value=discord.utils.format_dt(guild.created_at, "F"), inline=False)
    report.add_field(name="Server age", value=f"{(datetime.now(timezone.utc) - guild.created_at).days} days", inline=True)
    report.add_field(name="Members", value=str(guild.member_count or len(guild.members)), inline=True)
    report.add_field(name="Text channels", value=str(sum(isinstance(c, discord.TextChannel) for c in guild.channels)), inline=True)
    report.add_field(name="Voice channels", value=str(sum(isinstance(c, discord.VoiceChannel) for c in guild.channels)), inline=True)
    report.add_field(name="Emojis", value=str(len(guild.emojis)), inline=True)
    report.add_field(name="Features", value=", ".join(guild.features[:10]) or "None", inline=False)
    await ctx.send(embed=report)

@client.hybrid_command(description="Show the most-used roles and their member counts.")
async def roleinsights(ctx):
    if ctx.guild is None:
        await ctx.send("This command can only be used inside a server.")
        return

    roles = sorted(
        (role for role in ctx.guild.roles if role != ctx.guild.default_role),
        key=lambda role: len(role.members),
        reverse=True,
    )
    top_roles = roles[:10]
    summary = "\n".join(
        f"{index}. {role.mention} — **{len(role.members)}** members"
        for index, role in enumerate(top_roles, start=1)
    ) or "No custom roles found."
    embed = discord.Embed(
        title=f"Role insights: {ctx.guild.name}",
        description=summary,
        colour=discord.Colour.blurple(),
    )
    embed.add_field(name="Total roles", value=str(len(roles)), inline=True)
    embed.add_field(
        name="Managed roles",
        value=str(sum(role.managed for role in roles)),
        inline=True,
    )
    await ctx.send(embed=embed)

@client.hybrid_command(description="Show a member's recent message activity in this channel.")
async def memberactivity(ctx, member: discord.Member = None, limit: int = 100):
    if ctx.guild is None:
        await ctx.send("This command can only be used inside a server.")
        return
    member = member or ctx.author
    limit = max(25, min(limit, 500))
    if not isinstance(ctx.channel, discord.TextChannel):
        await ctx.send("Use this command in a text channel.")
        return

    messages = [
        message async for message in ctx.channel.history(limit=limit)
        if message.author.id == member.id
    ]
    embed = discord.Embed(
        title=f"Member activity: {member.display_name}",
        description=f"Messages by {member.mention} in {ctx.channel.mention}.",
        colour=member.colour,
    )
    embed.add_field(name="Messages sampled", value=str(limit), inline=True)
    embed.add_field(name="Messages found", value=str(len(messages)), inline=True)
    embed.add_field(
        name="Attachments",
        value=str(sum(len(message.attachments) for message in messages)),
        inline=True,
    )
    embed.set_thumbnail(url=member.display_avatar.url)
    await ctx.send(embed=embed)

@client.hybrid_command(description="Show the server's current voice-channel occupancy.")
async def voiceinsights(ctx):
    if ctx.guild is None:
        await ctx.send("This command can only be used inside a server.")
        return

    channels = [
        channel for channel in ctx.guild.voice_channels
        if channel.members
    ]
    occupancy = sum(len(channel.members) for channel in channels)
    summary = "\n".join(
        f"{channel.mention} — **{len(channel.members)}** connected"
        for channel in sorted(channels, key=lambda item: len(item.members), reverse=True)
    ) or "Nobody is currently in a voice channel."
    embed = discord.Embed(
        title=f"Voice insights: {ctx.guild.name}",
        description=summary,
        colour=discord.Colour.blurple(),
    )
    embed.add_field(name="Active channels", value=str(len(channels)), inline=True)
    embed.add_field(name="Members connected", value=str(occupancy), inline=True)
    await ctx.send(embed=embed)

def analytics_guild(ctx):
    if ctx.guild is None:
        raise ValueError("This command can only be used inside a server.")
    return ctx.guild

@client.hybrid_command(description="Show stored analytics totals for this server.")
async def analytics(ctx):
    guild = analytics_guild(ctx)
    cursor.execute(
        """SELECT COUNT(*), COUNT(DISTINCT user_id), COALESCE(SUM(word_count), 0)
        FROM message_activity WHERE guild_id = ?""",
        (guild.id,),
    )
    messages, authors, words = cursor.fetchone()
    cursor.execute(
        "SELECT COUNT(*) FROM member_events WHERE guild_id = ? AND event_type = 'join'",
        (guild.id,),
    )
    joins = cursor.fetchone()[0]
    cursor.execute(
        "SELECT COUNT(*) FROM member_events WHERE guild_id = ? AND event_type = 'leave'",
        (guild.id,),
    )
    leaves = cursor.fetchone()[0]
    cursor.execute("SELECT COUNT(*) FROM voice_activity WHERE guild_id = ?", (guild.id,))
    voice_sessions = cursor.fetchone()[0]
    embed = discord.Embed(title=f"Stored analytics • {guild.name}", colour=discord.Colour.blurple())
    embed.add_field(name="Messages", value=f"{messages:,}", inline=True)
    embed.add_field(name="Authors", value=f"{authors:,}", inline=True)
    embed.add_field(name="Words", value=f"{words:,}", inline=True)
    embed.add_field(name="Joins", value=f"{joins:,}", inline=True)
    embed.add_field(name="Leaves", value=f"{leaves:,}", inline=True)
    embed.add_field(name="Voice sessions", value=f"{voice_sessions:,}", inline=True)
    embed.set_footer(text="Data is stored locally in the bot's SQLite database.")
    await ctx.send(embed=embed)

@client.hybrid_command(description="Rank members by total stored messages.")
async def topmessages(ctx, limit: int = 10):
    guild = analytics_guild(ctx)
    limit = max(1, min(limit, 20))
    cursor.execute(
        """SELECT user_id, COUNT(*) AS total FROM message_activity
        WHERE guild_id = ? GROUP BY user_id ORDER BY total DESC LIMIT ?""",
        (guild.id, limit),
    )
    rows = cursor.fetchall()
    lines = "\n".join(
        f"{index}. <@{user_id}> — **{total:,}** messages"
        for index, (user_id, total) in enumerate(rows, 1)
    ) or "No stored messages yet."
    await ctx.send(embed=discord.Embed(
        title=f"Top message authors • {guild.name}",
        description=lines,
        colour=discord.Colour.blurple(),
    ))

@client.hybrid_command(description="Rank members by total stored words.")
async def topwords(ctx, limit: int = 10):
    guild = analytics_guild(ctx)
    limit = max(1, min(limit, 20))
    cursor.execute(
        """SELECT user_id, COALESCE(SUM(word_count), 0) AS total FROM message_activity
        WHERE guild_id = ? GROUP BY user_id ORDER BY total DESC LIMIT ?""",
        (guild.id, limit),
    )
    rows = cursor.fetchall()
    lines = "\n".join(
        f"{index}. <@{user_id}> — **{total:,}** words"
        for index, (user_id, total) in enumerate(rows, 1)
    ) or "No stored words yet."
    await ctx.send(embed=discord.Embed(
        title=f"Top word counts • {guild.name}",
        description=lines,
        colour=discord.Colour.blurple(),
    ))

@client.hybrid_command(description="Show the most-used words stored for this server.")
async def wordcloud(ctx, limit: int = 15):
    guild = analytics_guild(ctx)
    limit = max(5, min(limit, 30))
    try:
        ignored_words = set(stopwords.words("english"))
    except LookupError:
        ignored_words = set()
    cursor.execute("SELECT content FROM message_activity WHERE guild_id = ?", (guild.id,))
    counts = defaultdict(int)
    for (content,) in cursor.fetchall():
        for word in re.findall(r"[A-Za-z][A-Za-z'-]{2,}", content.casefold()):
            if word not in ignored_words:
                counts[word] += 1
    common = sorted(counts.items(), key=lambda item: item[1], reverse=True)[:limit]
    description = "\n".join(
        f"{index}. `{word}` — **{count:,}**"
        for index, (word, count) in enumerate(common, 1)
    ) or "No words stored yet."
    await ctx.send(embed=discord.Embed(
        title=f"Most-used words • {guild.name}",
        description=description,
        colour=discord.Colour.blurple(),
    ))

async def member_event_report(ctx, event_type, title):
    guild = analytics_guild(ctx)
    cursor.execute(
        """SELECT user_id, occurred_at FROM member_events
        WHERE guild_id = ? AND event_type = ? ORDER BY id DESC LIMIT 20""",
        (guild.id, event_type),
    )
    rows = cursor.fetchall()
    lines = "\n".join(
        f"<@{user_id}> — <t:{int(datetime.fromisoformat(occurred_at).timestamp())}:R>"
        for user_id, occurred_at in rows
    ) or f"No stored {event_type} events yet."
    await ctx.send(embed=discord.Embed(title=f"{title} • {guild.name}", description=lines, colour=discord.Colour.blurple()))

@client.hybrid_command(description="Show the latest member joins.")
async def joins(ctx):
    await member_event_report(ctx, "join", "Recent joins")

@client.hybrid_command(description="Show the latest member leaves.")
async def leaves(ctx):
    await member_event_report(ctx, "leave", "Recent leaves")

@client.hybrid_command(description="Rank members by stored voice-channel time.")
async def voiceactivity(ctx, limit: int = 10):
    guild = analytics_guild(ctx)
    limit = max(1, min(limit, 20))
    cursor.execute(
        """SELECT user_id, SUM(
            CASE WHEN left_at IS NULL THEN
                (julianday('now') - julianday(joined_at)) * 86400
            ELSE (julianday(left_at) - julianday(joined_at)) * 86400 END
        ) AS seconds
        FROM voice_activity WHERE guild_id = ? GROUP BY user_id
        ORDER BY seconds DESC LIMIT ?""",
        (guild.id, limit),
    )
    rows = cursor.fetchall()
    lines = "\n".join(
        f"{index}. <@{user_id}> — **{int(seconds // 3600)}h {int(seconds // 60) % 60}m**"
        for index, (user_id, seconds) in enumerate(rows, 1)
    ) or "No stored voice activity yet."
    await ctx.send(embed=discord.Embed(title=f"Voice activity • {guild.name}", description=lines, colour=discord.Colour.blurple()))

@client.hybrid_command(description="Show stored message edits and deletions.")
async def messagechanges(ctx, limit: int = 15):
    guild = analytics_guild(ctx)
    limit = max(1, min(limit, 30))
    cursor.execute(
        """SELECT user_id, channel_id, edited_at, deleted_at FROM message_activity
        WHERE guild_id = ? AND (edited_at IS NOT NULL OR deleted_at IS NOT NULL)
        ORDER BY COALESCE(deleted_at, edited_at) DESC LIMIT ?""",
        (guild.id, limit),
    )
    rows = cursor.fetchall()
    lines = "\n".join(
        f"<@{user_id}> in <#{channel_id}> — {'deleted' if deleted_at else 'edited'}"
        for user_id, channel_id, edited_at, deleted_at in rows
    ) or "No stored edits or deletions yet."
    await ctx.send(embed=discord.Embed(title=f"Message changes • {guild.name}", description=lines, colour=discord.Colour.blurple()))


def setup(client):
    client.add_command(servers)

# nyx is an insights-only bot. The separate bot remains responsible for
# moderation, sniping, entertainment, and general utility commands.
INSIGHTS_ONLY_COMMANDS = {
    "help", "ping", "uptime", "serverhealth", "serverreport", "channelpulse",
    "roleinsights", "memberinsights", "memberactivity", "voiceinsights",
    "timezone", "analytics", "topmessages", "topwords", "wordcloud",
    "voiceactivity", "joins", "leaves", "messagechanges",
}

DISABLED_OVERLAPPING_COMMANDS = {
    command.name for command in client.commands
    if command.name not in INSIGHTS_ONLY_COMMANDS
}

for command_name in DISABLED_OVERLAPPING_COMMANDS:
    client.remove_command(command_name)
    client.tree.remove_command(command_name)

keep_alive()

client.run(TOKEN)
