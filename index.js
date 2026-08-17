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

  const guildId = message.guild.id;

  // Fetch both guilds so each Discord client uses its own adapter.
  const controlGuild = await controlBot.guilds.fetch(guildId).catch(() => null);
  const loudGuild = await loudBot.guilds.fetch(guildId).catch(() => null);

  if (!controlGuild) {
    return message.reply("❌ Control bot is not in this server.");
  }

  if (!loudGuild) {
    return message.reply("❌ Loud bot is not in this server. Invite both bots.");
  }

  const controlChannel = await controlGuild.channels
    .fetch(voiceChannel.id)
    .catch(() => null);

  const loudChannel = await loudGuild.channels
    .fetch(voiceChannel.id)
    .catch(() => null);

  if (!controlChannel?.isVoiceBased()) {
    return message.reply("❌ Control bot cannot access that voice channel.");
  }

  if (!loudChannel?.isVoiceBased()) {
    return message.reply("❌ Loud bot cannot access that voice channel.");
  }

  // Stop old connections first.
  const oldSession = sessions.get(guildId);
  if (oldSession) {
    for (const connection of [
      oldSession.connection,
      oldSession.loudConnection
    ]) {
      if (connection) {
        try {
          connection.destroy();
        } catch {}
      }
    }
  }

  const session = getSession(guildId);
  session.channelId = voiceChannel.id;

  // IMPORTANT: every Discord client gets its own voice connection.
  session.connection = joinVoiceChannel({
    channelId: controlChannel.id,
    guildId,
    adapterCreator: controlGuild.voiceAdapterCreator,
    group: "control",
    selfDeaf: false,
    selfMute: true
  });

  session.loudConnection = joinVoiceChannel({
    channelId: loudChannel.id,
    guildId,
    adapterCreator: loudGuild.voiceAdapterCreator,
    group: "loud",
    selfDeaf: false,
    selfMute: false
  });

  try {
    await entersState(
      session.connection,
      VoiceConnectionStatus.Ready,
      20_000
    );
  } catch (error) {
    console.error("[ControlVoice]", error.message);
    try {
      session.connection.destroy();
    } catch {}
    session.connection = null;
    return message.reply("❌ Control bot voice connection failed.");
  }

  try {
    await entersState(
      session.loudConnection,
      VoiceConnectionStatus.Ready,
      20_000
    );
  } catch (error) {
    console.error("[LoudVoice]", error.message);
    try {
      session.loudConnection.destroy();
    } catch {}
    session.loudConnection = null;
    return message.reply(
      "❌ Loud bot voice connection failed. Check that the Loud bot is in the server and has Connect + Speak permission."
    );
  }

  console.log("✅ Both voice connections are READY.");
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

  // Confirm the Loud bot is actually ready before sending audio.
  try {
    await entersState(loudConnection, VoiceConnectionStatus.Ready, 5_000);
  } catch {
    return message.reply("❌ Loud bot is not ready to play audio.");
  }

  session.looping = true;
  const player = createLoopPlayer(session);

  // Audio is sent ONLY through the Loud bot connection.
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
