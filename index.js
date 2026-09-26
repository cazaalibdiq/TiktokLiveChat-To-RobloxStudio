// tiktok-chat-relay
// Relay server: TikTok LIVE -> HTTP polling endpoint buat Roblox Studio plugin.
//
// Connect langsung ke WebSocket managed tik.tools (wss://api.tik.tools),
// BUKAN lewat library `tiktok-live-connector`. Alasannya: tiktok-live-connector
// (lewat dependency tiktok-live-api-sdk) selalu manggil endpoint
// GET /webcast/rooms/{roomId}/connect ke sign provider manapun yang di-set -
// endpoint itu eksklusif Euler Stream dan TIDAK diimplementasikan tik.tools
// (cek tabel endpoint resmi mereka: https://tik.tools/docs), makanya selalu 404.
// tik.tools sendiri expose WebSocket terkelola yang sudah ngasih event JSON
// langsung (chat/gift/like/member/roomInfo), jadi gak butuh sign library sama
// sekali. Lihat: https://tik.tools/docs (Quick Start - WebSocket API).

const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const MAX_BUFFER = 300;

// Host WebSocket tik.tools. Override lewat env kalau tik.tools ganti domain.
const TIKTOOL_WS_HOST = process.env.TIKTOOL_WS_HOST || 'wss://api.tik.tools';
// API key tik.tools. 'your_api_key' = demo key publik (limit ketat: 1 WS,
// sesi 10 menit). Ganti dengan API key asli dari https://tik.tools/login.
const TIKTOOL_API_KEY = process.env.SIGN_PROVIDER_API_KEY || 'your_api_key';
// Berapa lama nunggu event 'connected'/'roomInfo' pertama sebelum dianggap gagal.
const CONNECT_TIMEOUT_MS = 15000;

let ws = null;
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

function cleanErrorMessage(msg) {
  if (!msg) return 'Unknown error';
  return String(msg);
}

function detachConnection() {
  if (ws) {
    try {
      ws.removeAllListeners();
      ws.terminate();
    } catch (_) {}
    ws = null;
  }
  connected = false;
  roomId = null;
}

function buildWsUrl(username) {
  const params = new URLSearchParams({
    uniqueId: username,
    apiKey: TIKTOOL_API_KEY,
  });
  return `${TIKTOOL_WS_HOST}?${params.toString()}`;
}

function connectToUsername(username) {
  detachConnection();
  currentUsername = username;
  lastError = null;

  return new Promise((resolve, reject) => {
    const socket = new WebSocket(buildWsUrl(username));
    ws = socket;

    let settled = false;
    let debugMsgCount = 0;
    const settleTimeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      detachConnection();
      reject(new Error('Timeout menunggu handshake WebSocket dari tik.tools (cek API key / firewall Railway)'));
    }, CONNECT_TIMEOUT_MS);

    function settleOk() {
      if (settled) return;
      settled = true;
      clearTimeout(settleTimeout);
      connected = true;
      resolve({ roomId });
    }

    function settleFail(err) {
      if (settled) return;
      settled = true;
      clearTimeout(settleTimeout);
      detachConnection();
      reject(err instanceof Error ? err : new Error(cleanErrorMessage(err)));
    }

    // Anggap "connect" berhasil begitu handshake WebSocket sukses (open),
    // JANGAN nunggu pesan 'connected'/'roomInfo' spesifik dari server -
    // tik.tools kadang baru ngirim event pertama pas ada chat/gift beneran,
    // jadi nunggu pesan itu bikin timeout padahal koneksinya sebenarnya oke.
    socket.on('open', () => {
      settleOk();
    });

    socket.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch (_) {
        return;
      }

      // Log 5 pesan pertama ke console (keliatan di Railway logs) buat bantu
      // debug format event asli dari tik.tools kalau masih ada yang aneh.
      if (debugMsgCount < 5) {
        debugMsgCount += 1;
        console.log('[tiktool-msg]', JSON.stringify(msg).slice(0, 500));
      }

      const evt = msg.event;
      const data = msg.data || {};

      switch (evt) {
        case 'connected':
        case 'roomInfo':
          if (data.roomId) roomId = data.roomId;
          settleOk();
          return;

        case 'chat':
          pushEvent({
            type: 'chat',
            username: data.user?.uniqueId || null,
            text: data.comment ?? null,
            giftName: null,
            giftCount: null,
            likeCount: null,
          });
          return;

        case 'gift':
          // giftType 1 = gift yang bisa "streak" (combo). Cuma catat pas
          // streak-nya selesai (repeatEnd) biar gak dobel-dobel per combo.
          if (data.giftType === 1 && !data.repeatEnd) return;
          pushEvent({
            type: 'gift',
            username: data.user?.uniqueId || null,
            text: null,
            giftName: data.giftName ?? null,
            giftCount: data.repeatCount || 1,
            likeCount: null,
          });
          return;

        case 'like':
          pushEvent({
            type: 'like',
            username: data.user?.uniqueId || null,
            text: null,
            giftName: null,
            giftCount: null,
            likeCount: data.likeCount ?? null,
          });
          return;

        case 'member':
          pushEvent({
            type: 'member',
            username: data.user?.uniqueId || null,
            text: 'joined',
            giftName: null,
            giftCount: null,
            likeCount: null,
          });
          return;

        case 'disconnected':
          connected = false;
          lastError = 'Stream berakhir';
          return;

        case 'error': {
          const errMsg = cleanErrorMessage(data.message || data.error || 'tik.tools mengembalikan error');
          if (!settled) {
            settleFail(new Error(errMsg));
          } else {
            connected = false;
            lastError = errMsg;
          }
          return;
        }

        default:
          // event lain (battle, social, dst) sengaja diabaikan buat relay ini.
          return;
      }
    });

    socket.on('close', (code, reasonBuf) => {
      const reason = reasonBuf ? reasonBuf.toString() : '';
      const detail = `code ${code}${reason ? `: ${reason}` : ''}`;
      if (!settled) {
        settleFail(new Error(`Koneksi ke tik.tools ditutup sebelum connect (${detail})`));
      } else {
        connected = false;
        lastError = `Koneksi terputus (${detail})`;
      }
    });

    socket.on('error', (err) => {
      if (!settled) {
        settleFail(err);
      } else {
        connected = false;
        lastError = cleanErrorMessage(err.message);
      }
    });
  });
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
    lastError = cleanErrorMessage(err.message);
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

function start() {
  console.log(`[sign-config] wsHost = ${TIKTOOL_WS_HOST}`);
  console.log(`[sign-config] apiKey = ${process.env.SIGN_PROVIDER_API_KEY ? 'set (' + TIKTOOL_API_KEY.length + ' chars)' : 'not set, using demo key (limit ketat!)'}`);

  app.listen(PORT, () => {
    console.log(`tiktok-chat-relay jalan di port ${PORT}`);

    if (process.env.TIKTOK_USERNAME) {
      connectToUsername(process.env.TIKTOK_USERNAME).catch((err) => {
        lastError = cleanErrorMessage(err.message);
        console.error('Gagal auto-connect:', lastError);
      });
    }
  });
}

start();
