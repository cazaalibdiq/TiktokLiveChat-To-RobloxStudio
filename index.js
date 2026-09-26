// tiktok-chat-relay
// Relay server: TikTok LIVE -> HTTP polling endpoint buat Roblox Studio plugin.

const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const MAX_BUFFER = 300;

let WebcastPushConnection;

let tiktokConnection = null;
let currentUsername = null;
let connected = false;
let lastError = null;
let roomId = null;

let eventBuffer = [];
let nextId = 1;

function pushEvent(evt) {
  evt.id = nextId++;
  evt.ts = Date.now();
  eventBuffer.push(evt);
  if (eventBuffer.length > MAX_BUFFER) {
    eventBuffer.splice(0, eventBuffer.length - MAX_BUFFER);
  }
}

function detachConnection() {
  if (tiktokConnection) {
    try {
      tiktokConnection.disconnect();
    } catch (_) {}
    tiktokConnection.removeAllListeners();
    tiktokConnection = null;
  }
  connected = false;
  roomId = null;
}

function cleanErrorMessage(msg) {
  if (!msg) return msg;
  return String(msg)
    .replace(/\[[a-zA-Z]*Euler[a-zA-Z]*\]\s*/gi, '')
    .replace(/euler\s*stream/gi, 'sign provider')
    .replace(/eulerstream/gi, 'sign provider')
    .replace(/euler/gi, 'sign provider');
}

// "Failed to retrieve Room ID from all sources" itu pesan generic yang
// nyembunyiin alasan asli tiap metode yang dicoba (HTML scrape, TikTok API,
// sign provider). Detail per-sumbernya disimpen di err.config.requestErrs.
function describeError(err) {
  const base = err && err.message ? err.message : String(err);
  const subErrors = err && err.config && Array.isArray(err.config.requestErrs)
    ? err.config.requestErrs.map((e) => (e && e.message) ? e.message : String(e))
    : [];
  const full = subErrors.length ? `${base} -> ${subErrors.join(' | ')}` : base;
  return cleanErrorMessage(full);
}

async function connectToUsername(username) {
  detachConnection();
  currentUsername = username;
  lastError = null;

  tiktokConnection = new WebcastPushConnection(username, {
    enableExtendedGiftInfo: true,
  });

  tiktokConnection.on('chat', (data) => {
    pushEvent({
      type: 'chat',
      username: data.uniqueId,
      text: data.comment,
      giftName: null,
      giftCount: null,
      likeCount: null,
    });
  });

  tiktokConnection.on('gift', (data) => {
    if (data.giftType === 1 && !data.repeatEnd) return;
    pushEvent({
      type: 'gift',
      username: data.uniqueId,
      text: null,
      giftName: data.giftName,
      giftCount: data.repeatCount || 1,
      likeCount: null,
    });
  });

  tiktokConnection.on('like', (data) => {
    pushEvent({
      type: 'like',
      username: data.uniqueId,
      text: null,
      giftName: null,
      giftCount: null,
      likeCount: data.likeCount,
    });
  });

  tiktokConnection.on('member', (data) => {
    pushEvent({
      type: 'member',
      username: data.uniqueId,
      text: 'joined',
      giftName: null,
      giftCount: null,
      likeCount: null,
    });
  });

  tiktokConnection.on('streamEnd', () => {
    connected = false;
    lastError = 'Stream berakhir';
  });

  tiktokConnection.on('disconnected', () => {
    connected = false;
  });

  const state = await tiktokConnection.connect();
  connected = true;
  roomId = state.roomId;
  return state;
}

app.post('/config', async (req, res) => {
  const { username } = req.body || {};
  if (!username || typeof username !== 'string') {
    return res.status(400).json({ ok: false, error: 'username wajib diisi' });
  }
  try {
    const state = await connectToUsername(username.trim());
    res.json({ ok: true, connected: true, username: currentUsername, roomId: state.roomId });
  } catch (err) {
    connected = false;
    lastError = describeError(err);
    res.status(502).json({ ok: false, error: lastError });
  }
});

app.get('/status', (req, res) => {
  res.json({
    connected,
    username: currentUsername,
    roomId,
    error: lastError,
    bufferSize: eventBuffer.length,
  });
});

app.get('/comments', (req, res) => {
  const since = parseInt(req.query.since, 10) || 0;
  const events = eventBuffer.filter((e) => e.id > since);
  res.json({
    connected,
    lastId: eventBuffer.length ? eventBuffer[eventBuffer.length - 1].id : since,
    events,
  });
});

app.get('/', (req, res) => {
  res.json({ ok: true, service: 'tiktok-chat-relay', connected, username: currentUsername });
});

async function start() {
  const legacyModule = await import('tiktok-live-connector/legacy');
  const mainModule = await import('tiktok-live-connector');
  WebcastPushConnection = legacyModule.WebcastPushConnection;
  const { SignConfig } = mainModule;

  SignConfig.basePath = process.env.SIGN_PROVIDER_HOST || 'https://api.tik.tools';
  SignConfig.apiKey = process.env.SIGN_PROVIDER_API_KEY || 'your_api_key';

  console.log(`[sign-config] basePath = ${SignConfig.basePath}`);
  console.log(`[sign-config] apiKey   = ${process.env.SIGN_PROVIDER_API_KEY ? 'set (' + SignConfig.apiKey.length + ' chars)' : 'not set, using demo key'}`);

  app.listen(PORT, () => {
    console.log(`tiktok-chat-relay jalan di port ${PORT}`);

    if (process.env.TIKTOK_USERNAME) {
      connectToUsername(process.env.TIKTOK_USERNAME).catch((err) => {
        lastError = describeError(err);
        console.error('Gagal auto-connect:', lastError);
      });
    }
  });
}

start().catch((err) => {
  console.error('Gagal start server:', err);
  process.exit(1);
});
