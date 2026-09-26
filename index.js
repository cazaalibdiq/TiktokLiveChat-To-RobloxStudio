// tiktok-chat-relay
// Relay server: TikTok LIVE -> HTTP polling endpoint buat Roblox Studio plugin.
// Nggak butuh login/kredensial TikTok, cukup username yang lagi live.
//
// Sign provider diatur lewat 2 env var di Railway:
//   SIGN_API_URL - base URL sign server (default: https://api.eulerstream.com)
//   SIGN_API_KEY - API key buat sign server itu
// FIX: sebelumnya cuma ngandelin tiktok-live-connector baca process.env pas
// modul-nya di-import. Sekarang SignConfig di-assign EKSPLISIT di kode +
// di-log pas boot, jadi kalau env var kebaca (atau kagak) langsung keliatan
// di Railway logs, gak perlu nebak-nebak lagi provider mana yang aktif.

const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
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

async function connectToUsername(username) {
  detachConnection();
  currentUsername = username;
  lastError = null;

  // Sign provider udah di-set eksplisit sekali di start() (lihat di bawah) -
  // gak perlu opsi apapun di sini, semua koneksi baru otomatis makein itu.
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
  // "legacy" subpath cuma export WebcastPushConnection - SignConfig ada di
  // entry point utama, jadi di-import terpisah.
  const legacyModule = await import('tiktok-live-connector/legacy');
  const mainModule = await import('tiktok-live-connector');
  WebcastPushConnection = legacyModule.WebcastPushConnection;
  const { SignConfig } = mainModule;

  // FIX UTAMA: assign eksplisit di kode, bukan cuma ngandelin
  // tiktok-live-connector baca process.env pas modul di-load. Kalau
  // SIGN_API_URL gak ke-set di Railway, ini fallback jelas ke eulerstream
  // dan KELIATAN di log - gak nebak-nebak lagi provider mana yang aktif.
  if (process.env.SIGN_API_URL) SignConfig.basePath = process.env.SIGN_API_URL;
  if (process.env.SIGN_API_KEY) SignConfig.apiKey = process.env.SIGN_API_KEY;

  console.log(`[sign-config] basePath = ${SignConfig.basePath}`);
  console.log(`[sign-config] apiKey   = ${SignConfig.apiKey ? '(set, ' + SignConfig.apiKey.length + ' chars)' : '(KOSONG - bakal kena rate limit ketat / ditolak provider)'}`);

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
