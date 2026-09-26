// tiktok-chat-relay
// Relay server: TikTok LIVE -> HTTP polling endpoint buat Roblox Studio plugin.
// Nggak butuh login/kredensial TikTok, cukup username yang lagi live.
// Tapi BUTUH EulerStream Sign API key (gratis, https://www.eulerstream.com) diisi
// ke env var EULER_SIGN_API_KEY di Railway, biar gak numpang di sign-server
// free-tier bareng semua pengguna tiktok-live-connector sedunia (itu penyebab
// error "Failed to sign request ... status code 403").

const express = require('express');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const MAX_BUFFER = 300; // simpen 300 event terakhir aja biar nggak makan memory

// FIX: tiktok-live-connector@2.x itu PURE ESM - baik root package maupun
// "/legacy" subpath, keduanya "type": "module", GAK ADA build CommonJS sama
// sekali. Jadi require() apapun pathnya gak akan pernah jalan.
// Satu-satunya cara load dari file CommonJS (file ini) adalah dynamic import().
// Tapi dynamic import cuma bisa dipakai di dalam async function (top-level
// await gak didukung di CommonJS) - makanya di-load sekali di start(), sebelum
// app.listen(), dan disimpen ke variable module-level ini biar semua handler
// di bawah tetep bisa akses classnya.
let WebcastPushConnection;
let SignConfig;


// ---- State global ----
let tiktokConnection = null;
let currentUsername = null;
let connected = false;
let lastError = null;
let roomId = null;

let eventBuffer = []; // { id, type, username, text, giftName, giftCount, likeCount, ts }
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
    } catch (_) {
      // abaikan, connection emang mau dibuang
    }
    tiktokConnection.removeAllListeners();
    tiktokConnection = null;
  }
  connected = false;
  roomId = null;
}

// Override sign-provider global (SignConfig) kalau SIGN_PROVIDER_HOST diisi.
// Dipanggil tiap sebelum connect (bukan cuma sekali di boot) karena constructor
// WebcastPushConnection sendiri nulis ke SignConfig.apiKey tiap kali dibuat -
// jadi ini mesti jalan PALING TERAKHIR biar gak ketiban balik ke default Euler.
function applySignProviderOverride() {
  if (process.env.SIGN_PROVIDER_HOST) {
    SignConfig.basePath = process.env.SIGN_PROVIDER_HOST;
  }
  if (process.env.SIGN_PROVIDER_API_KEY) {
    SignConfig.apiKey = process.env.SIGN_PROVIDER_API_KEY;
  }
}

async function connectToUsername(username) {
  detachConnection();
  currentUsername = username;
  lastError = null;

  tiktokConnection = new WebcastPushConnection(username, {
    enableExtendedGiftInfo: true,
    // Sign API key dari eulerstream.com. Cuma kepake kalau SIGN_PROVIDER_HOST
    // di bawah gak diisi (lihat applySignProviderOverride).
    signApiKey: process.env.EULER_SIGN_API_KEY,
  });

  // Paksa ke provider custom (kalau ada) SETELAH constructor jalan, biar menang.
  applySignProviderOverride();

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
    // repeatEnd (atau bukan repeatable) = gift beneran selesai dikirim
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

// ---- HTTP API ----

// Plugin manggil ini pas user ganti username di Settings panel
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
    lastError = err.message || String(err);
    res.status(502).json({ ok: false, error: lastError });
  }
});

// Plugin poll status buat indikator connect/disconnect
app.get('/status', (req, res) => {
  res.json({
    connected,
    username: currentUsername,
    roomId,
    error: lastError,
    bufferSize: eventBuffer.length,
  });
});

// Plugin poll ini tiap ~3 detik. Pakai ?since=<lastId> biar cuma dapet event baru.
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
  // Load package ESM-only ini sekali sebelum server nerima request apapun.
  ({ WebcastPushConnection } = await import('tiktok-live-connector/legacy'));

  app.listen(PORT, () => {
    console.log(`tiktok-chat-relay jalan di port ${PORT}`);

    // Kalau username udah di-set lewat env var, langsung auto-connect pas boot
    if (process.env.TIKTOK_USERNAME) {
      connectToUsername(process.env.TIKTOK_USERNAME).catch((err) => {
        lastError = err.message || String(err);
        console.error('Gagal auto-connect:', lastError);
      });
    }
  });
}

start().catch((err) => {
  console.error('Gagal start server:', err);
  process.exit(1);
});
