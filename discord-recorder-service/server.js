'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const express = require('express');
const cors = require('cors');
const prism = require('prism-media');
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits
} = require('discord.js');
const {
  joinVoiceChannel,
  getVoiceConnection,
  entersState,
  VoiceConnectionStatus,
  EndBehaviorType
} = require('@discordjs/voice');

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const PORT = Number(process.env.PORT || 3210);
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || `http://127.0.0.1:${PORT}`).replace(/\/$/, '');
const RECORDINGS_DIR = path.resolve(process.env.RECORDINGS_DIR || path.join(__dirname, 'recordings'));
const sessions = new Map();
const requestsByIp = new Map();
const BYTES_PER_SECOND = 48000 * 2 * 2;

if (!TOKEN || !CLIENT_ID) {
  console.error('DISCORD_BOT_TOKEN en DISCORD_CLIENT_ID zijn verplicht.');
  process.exit(1);
}

const safeText = (value, fallback) => String(value || fallback).replace(/[\r\n\0]/g, ' ').trim().slice(0, 80) || fallback;
const makeId = bytes => crypto.randomBytes(bytes).toString('hex');
const makeCode = () => crypto.randomBytes(4).toString('hex').toUpperCase();
const sessionDirectory = session => path.join(RECORDINGS_DIR, session.id);

function publicSession(session) {
  return { id: session.id, joinCode: session.joinCode, title: session.title, state: session.state, createdAt: session.createdAt };
}

function rateLimit(req, res, next) {
  const now = Date.now();
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const recent = (requestsByIp.get(ip) || []).filter(timestamp => now - timestamp < 60 * 60 * 1000);
  if (recent.length >= 10) return res.status(429).json({ error: 'Te veel sessies aangemaakt' });
  recent.push(now);
  requestsByIp.set(ip, recent);
  next();
}

function wavHeader(dataBytes) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(48000, 24);
  header.writeUInt32LE(BYTES_PER_SECOND, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

async function appendSilence(filePath, bytes) {
  let remaining = Math.max(0, bytes - (bytes % 4));
  if (!remaining) return;
  const handle = await fsp.open(filePath, 'a');
  const chunk = Buffer.alloc(Math.min(BYTES_PER_SECOND, remaining));
  try {
    while (remaining > 0) {
      const size = Math.min(chunk.length, remaining);
      await handle.write(chunk, 0, size);
      remaining -= size;
    }
  } finally { await handle.close(); }
}

async function beginSpeakerRecording(session, userId) {
  if (session.state !== 'recording' || !session.consents.has(userId)) return;
  let track = session.tracks.get(userId);
  if (!track) {
    const member = await session.guild.members.fetch(userId).catch(() => null);
    track = {
      id: makeId(8),
      userId,
      displayName: safeText(member?.displayName || member?.user?.username, 'Discord-spreker'),
      rawPath: path.join(sessionDirectory(session), `${userId}.pcm`),
      wavPath: path.join(sessionDirectory(session), `${userId}.wav`),
      active: false,
      complete: false
    };
    session.tracks.set(userId, track);
  }
  if (track.active) return;
  track.active = true;
  await fsp.mkdir(sessionDirectory(session), { recursive: true });
  const existing = await fsp.stat(track.rawPath).then(stat => stat.size).catch(() => 0);
  const target = Math.floor((Date.now() - session.startedAt) / 1000 * BYTES_PER_SECOND);
  await appendSilence(track.rawPath, target - existing);
  const opus = session.connection.receiver.subscribe(userId, {
    end: { behavior: EndBehaviorType.AfterSilence, duration: 800 }
  });
  const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
  const output = fs.createWriteStream(track.rawPath, { flags: 'a' });
  pipeline(opus, decoder, output)
    .catch(error => console.error(`Opnamefout voor ${track.displayName}:`, error.message))
    .finally(() => { track.active = false; });
}

async function finalizeTrack(track, sessionDurationMs) {
  const stat = await fsp.stat(track.rawPath).catch(() => null);
  if (!stat?.size) return;
  const wantedBytes = Math.floor(sessionDurationMs / 1000 * BYTES_PER_SECOND);
  await appendSilence(track.rawPath, wantedBytes - stat.size);
  const finalStat = await fsp.stat(track.rawPath);
  await fsp.writeFile(track.wavPath, wavHeader(finalStat.size));
  await pipeline(fs.createReadStream(track.rawPath), fs.createWriteStream(track.wavPath, { flags: 'a' }));
  await fsp.rm(track.rawPath, { force: true });
  track.complete = true;
}

async function stopSession(session) {
  if (session.state !== 'recording') return;
  session.state = 'processing';
  session.connection?.destroy();
  await new Promise(resolve => setTimeout(resolve, 1000));
  const duration = Date.now() - session.startedAt;
  await Promise.all([...session.tracks.values()].map(track => finalizeTrack(track, duration).catch(error => {
    console.error(`Kon ${track.displayName} niet afronden:`, error.message);
  })));
  session.state = 'complete';
  session.completedAt = new Date().toISOString();
}

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });

const podcastCommand = new SlashCommandBuilder()
  .setName('podcast')
  .setDescription('Turtle Media Podcast Recorder')
  .addSubcommand(command => command.setName('start').setDescription('Start een opnamesessie in je huidige call')
    .addStringOption(option => option.setName('code').setDescription('Sessiecode uit Turtle Media').setRequired(true)))
  .addSubcommand(command => command.setName('consent').setDescription('Geef toestemming om jouw stem in deze sessie op te nemen'))
  .addSubcommand(command => command.setName('stop').setDescription('Stop de huidige opnamesessie'));

client.once('ready', async () => {
  await new REST({ version: '10' }).setToken(TOKEN).put(Routes.applicationCommands(CLIENT_ID), { body: [podcastCommand.toJSON()] });
  console.log(`Turtle Media Recorder online als ${client.user.tag}`);
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'podcast' || !interaction.guild) return;
  const action = interaction.options.getSubcommand();
  if (action === 'start') {
    const code = interaction.options.getString('code', true).trim().toUpperCase();
    const session = [...sessions.values()].find(candidate => candidate.joinCode === code && candidate.state === 'waiting');
    const member = interaction.guild.members.cache.get(interaction.user.id)
      || await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
    const voiceChannel = member?.voice?.channel;
    if (!session) return interaction.reply({ content: 'Deze sessiecode bestaat niet of is al gebruikt.', ephemeral: true });
    if (!voiceChannel) return interaction.reply({ content: 'Ga eerst in de Discord-call zitten die je wilt opnemen.', ephemeral: true });
    const activeGuildSession = [...sessions.values()].find(candidate => candidate.guildId === interaction.guild.id && candidate.state === 'recording');
    if (activeGuildSession) return interaction.reply({ content: 'Er draait al een Turtle Media-opnamesessie in deze server.', ephemeral: true });
    if (!voiceChannel.permissionsFor(interaction.guild.members.me).has([PermissionFlagsBits.Connect, PermissionFlagsBits.ViewChannel])) {
      return interaction.reply({ content: 'Ik heb geen toestemming om deze voicechannel te openen.', ephemeral: true });
    }
    const old = getVoiceConnection(interaction.guild.id);
    old?.destroy();
    session.guildId = interaction.guild.id;
    session.guild = interaction.guild;
    session.channelId = voiceChannel.id;
    session.startedBy = interaction.user.id;
    session.startedAt = Date.now();
    session.state = 'recording';
    session.connection = joinVoiceChannel({ channelId: voiceChannel.id, guildId: interaction.guild.id, adapterCreator: interaction.guild.voiceAdapterCreator, selfDeaf: false, selfMute: true });
    try { await entersState(session.connection, VoiceConnectionStatus.Ready, 15_000); }
    catch {
      session.state = 'waiting';
      session.connection.destroy();
      return interaction.reply({ content: 'Ik kon niet met de call verbinden. Controleer mijn kanaalrechten.', ephemeral: true });
    }
    session.connection.receiver.speaking.on('start', userId => beginSpeakerRecording(session, userId).catch(console.error));
    return interaction.reply({
      content: `🎙️ **${session.title}** is gestart. Ik neem uitsluitend deelnemers op die zelf \`/podcast consent\` gebruiken. Iedere spreker wordt als een apart 48 kHz-spoor bewaard. Gebruik \`/podcast stop\` om af te ronden.`
    });
  }

  const session = [...sessions.values()].find(candidate => candidate.guildId === interaction.guild.id && candidate.state === 'recording');
  if (!session) return interaction.reply({ content: 'Er draait in deze server geen Turtle Media-opnamesessie.', ephemeral: true });
  if (action === 'consent') {
    session.consents.add(interaction.user.id);
    return interaction.reply({ content: 'Je toestemming is vastgelegd. Vanaf nu wordt jouw stem als apart spoor opgenomen. Je kunt de call verlaten om de opname van jouw stem te beëindigen.', ephemeral: true });
  }
  if (action === 'stop') {
    const mayStop = session.startedBy === interaction.user.id || interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
    if (!mayStop) return interaction.reply({ content: 'Alleen de starter of iemand met Server beheren mag deze sessie stoppen.', ephemeral: true });
    await interaction.deferReply();
    await stopSession(session);
    return interaction.editReply(`✅ **${session.title}** is gestopt. ${[...session.tracks.values()].filter(track => track.complete).length} spoor/sporen staan klaar in Turtle Media Podcast Studio.`);
  }
});

const app = express();
app.set('trust proxy', 1);
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '32kb' }));
app.get('/v1/health', (_req, res) => res.json({ ok: client.isReady(), service: 'turtle-media-recorder' }));
app.post('/v1/sessions', rateLimit, async (req, res) => {
  const session = {
    id: makeId(16),
    joinCode: makeCode(),
    title: safeText(req.body?.title, 'Turtle Media Podcast'),
    state: 'waiting',
    createdAt: new Date().toISOString(),
    consents: new Set(),
    tracks: new Map()
  };
  sessions.set(session.id, session);
  await fsp.mkdir(sessionDirectory(session), { recursive: true });
  res.status(201).json(publicSession(session));
});
app.get('/v1/sessions/:id/tracks', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Sessie niet gevonden' });
  const tracks = [...session.tracks.values()].filter(track => track.complete).map(track => ({
    id: track.id,
    displayName: track.displayName,
    fileName: `${track.displayName}.wav`,
    downloadUrl: `${PUBLIC_BASE_URL}/v1/sessions/${session.id}/tracks/${track.id}`
  }));
  res.json({ state: session.state, tracks });
});
app.get('/v1/sessions/:id/tracks/:trackId', (req, res) => {
  const session = sessions.get(req.params.id);
  const track = session && [...session.tracks.values()].find(candidate => candidate.id === req.params.trackId && candidate.complete);
  if (!track) return res.status(404).json({ error: 'Spoor niet gevonden' });
  res.download(track.wavPath, `${track.displayName.replace(/[^a-z0-9_-]+/gi, '-') || 'discord-spreker'}.wav`);
});

setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [id, session] of sessions) {
    if (new Date(session.createdAt).getTime() < cutoff && session.state !== 'recording') sessions.delete(id);
  }
}, 60 * 60 * 1000).unref();

Promise.all([
  fsp.mkdir(RECORDINGS_DIR, { recursive: true }),
  client.login(TOKEN),
  new Promise(resolve => app.listen(PORT, '0.0.0.0', resolve))
]).then(() => console.log(`Recorder-API luistert op poort ${PORT}`)).catch(error => {
  console.error(error);
  process.exit(1);
});
