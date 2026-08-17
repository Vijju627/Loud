require("dotenv").config();

const path = require("path");
const fs = require("fs");
const {
  Client,
  GatewayIntentBits,
  Events
} = require("discord.js");
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
  entersState
} = require("@discordjs/voice");
const ffmpegPath = require("ffmpeg-static");

if (ffmpegPath) {
  process.env.FFMPEG_PATH = ffmpegPath;
}

const CONTROL_TOKEN = process.env.CONTROL_TOKEN;
const LOUD_TOKEN = process.env.LOUD_TOKEN;
const OWNER_ID = process.env.OWNER_ID;
const AUDIO_FILE = process.env.AUDIO_FILE || "sound.mp3";

if (!CONTROL_TOKEN || !LOUD_TOKEN || !OWNER_ID) {
  console.error("Missing CONTROL_TOKEN, LOUD_TOKEN or OWNER_ID in .env");
  process.exit(1);
}

const audioPath = path.resolve(process.cwd(), AUDIO_FILE);

const controlBot = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const loudBot = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates
  ]
});

const sessions = new Map();

function isOwner(message) {
  return message.author?.id === OWNER_ID;
}

function getSession(guildId) {
  if (!sessions.has(guildId)) {
    sessions.set(guildId, {
      connection: null,
      player: null,
      looping: false,
      channelId: null
    });
  }
  return sessions.get(guildId);
}

function createLoopPlayer(session) {
  if (!session.player) {
    session.player = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Play
      }
    });

    session.player.on("error", (error) => {
      console.error("[AudioPlayer]", error.message);
      if (session.looping) {
        setTimeout(() => {
          if (session.looping) playOnce(session);
        }, 250);
      }
    });

    session.player.on(AudioPlayerStatus.Idle, () => {
      if (session.looping) {
        playOnce(session);
      }
    });
  }

  return session.player;
}

function playOnce(session) {
  if (!session.looping) return;

  if (!fs.existsSync(audioPath)) {
    console.error(`Audio file not found: ${audioPath}`);
    session.looping = false;
    return;
  }

  try {
    const resource = createAudioResource(audioPath);
    session.player.play(resource);
  } catch (error) {
    console.error("[AudioResource]", error);
    if (session.looping) {
      setTimeout(() => playOnce(session), 500);
    }
  }
}

async function joinBothBots(message) {
  const voiceChannel = message.member?.voice?.channel;

  if (!voiceChannel) {
    return message.reply("❌ First join a voice channel.");
  }

  if (!voiceChannel.joinable) {
    return message.reply("❌ I cannot join that voice channel.");
  }

  const guildId = message.guild.id;
  const session = getSession(guildId);

  // Both clients join the same VC.
  // The control bot joins but does not play audio.
  if (session.connection) {
    try {
      session.connection.destroy();
    } catch {}
    session.connection = null;
  }

  session.connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId,
    adapterCreator: message.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false
  });

  session.channelId = voiceChannel.id;

  // Wait until the loud bot's connection is ready.
  try {
    await entersState(session.connection, VoiceConnectionStatus.Ready, 15_000);
  } catch {
    console.error("Voice connection did not become ready.");
  }

  // The second bot joins by creating its own voice connection.
  const loudGuild = await loudBot.guilds.fetch(guildId).catch(() => null);
  if (!loudGuild) {
    return message.reply(
      "⚠️ Control bot joined, but the Loud bot is not in this server. Invite both bots to the server."
    );
  }

  const loudChannel = await loudGuild.channels.fetch(voiceChannel.id).catch(() => null);
  if (!loudChannel || !loudChannel.isVoiceBased()) {
    return message.reply("❌ Loud bot could not access that voice channel.");
  }

  const loudConnection = joinVoiceChannel({
    channelId: loudChannel.id,
    guildId,
    adapterCreator: loudGuild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false
  });

  session.loudConnection = loudConnection;

  try {
    await entersState(loudConnection, VoiceConnectionStatus.Ready, 15_000);
  } catch {
    console.error("Loud bot voice connection did not become ready.");
  }

  return message.reply("✅ Both bots joined your VC.");
}

function stopSession(guildId) {
  const session = sessions.get(guildId);
  if (!session) return false;

  session.looping = false;

  if (session.player) {
    try {
      session.player.stop(true);
    } catch {}
  }

  for (const connection of [session.connection, session.loudConnection]) {
    if (connection) {
      try {
        connection.destroy();
      } catch {}
    }
  }

  sessions.delete(guildId);
  return true;
}

async function startPlayback(message) {
  const voiceChannel = message.member?.voice?.channel;

  if (!voiceChannel) {
    return message.reply("❌ First join a voice channel.");
  }

  if (!fs.existsSync(audioPath)) {
    return message.reply(
      `❌ Audio file not found. Put your sound file at: \`${AUDIO_FILE}\``
    );
  }

  const guildId = message.guild.id;
  const session = getSession(guildId);

  // Make sure both bots are in the caller's VC before playback.
  await joinBothBots(message);

  const loudConnection = session.loudConnection;
  if (!loudConnection) {
    return message.reply("❌ Loud bot voice connection is unavailable.");
  }

  session.looping = true;
  const player = createLoopPlayer(session);

  // The player is subscribed only to the Loud bot connection.
  loudConnection.subscribe(player);

  playOnce(session);

  return message.reply(`🔊 Playing \`${AUDIO_FILE}\` on loop. Use \`.stopall\` to stop.`);
}

controlBot.once(Events.ClientReady, (client) => {
  console.log(`Control bot logged in as ${client.user.tag}`);
});

loudBot.once(Events.ClientReady, (client) => {
  console.log(`Loud bot logged in as ${client.user.tag}`);
});

controlBot.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild) return;
  if (!isOwner(message)) return;

  const command = message.content.trim().toLowerCase();

  try {
    if (command === ".join") {
      await joinBothBots(message);
      return;
    }

    if (command === ".playrec") {
      await startPlayback(message);
      return;
    }

    if (command === ".stopall") {
      const stopped = stopSession(message.guild.id);
      await message.reply(
        stopped ? "⏹️ Recording stopped and both bots left VC." : "ℹ️ Nothing is playing."
      );
    }
  } catch (error) {
    console.error(error);
    await message.reply("❌ Something went wrong. Check the console.");
  }
});

async function login() {
  await Promise.all([
    controlBot.login(CONTROL_TOKEN),
    loudBot.login(LOUD_TOKEN)
  ]);
}

process.on("SIGINT", () => {
  for (const guildId of sessions.keys()) stopSession(guildId);
  controlBot.destroy();
  loudBot.destroy();
  process.exit(0);
});

process.on("SIGTERM", () => {
  for (const guildId of sessions.keys()) stopSession(guildId);
  controlBot.destroy();
  loudBot.destroy();
  process.exit(0);
});

login().catch((error) => {
  console.error("Login failed:", error);
  process.exit(1);
});
