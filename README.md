# tiktok-chat-relay

Server kecil yang connect ke TikTok LIVE (pakai `tiktok-live-connector`, gak butuh API key/login) terus expose 3 endpoint HTTP yang bakal di-poll sama plugin Roblox Studio kamu.

## Endpoint

- `POST /config` — body `{ "username": "namatiktok" }` → connect/reconnect ke live username itu. Dipanggil plugin tiap lo ganti username di Settings panel.
- `GET /status` — `{ connected, username, roomId, error, bufferSize }`
- `GET /comments?since=<lastId>` — balikin event baru aja (chat/gift/like/member) sejak id terakhir yang plugin punya. Response: `{ connected, lastId, events: [...] }`, tiap event: `{ id, type, username, text, giftName, giftCount, likeCount, ts }`

## Jalanin lokal (buat tes dulu sebelum deploy)

```bash
npm install
TIKTOK_USERNAME=usernamekamu npm start
```

Buka `http://localhost:3000/status` di browser buat cek udah connect apa belum.

## Deploy gratis ke Render.com

1. Push folder ini ke repo GitHub baru (private juga boleh).
2. Di [render.com](https://render.com) → New → Web Service → connect repo itu.
3. Isi:
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Instance Type: **Free**
4. (Opsional) Environment Variable `TIKTOK_USERNAME` = usernamekamu, biar server auto-connect pas boot tanpa nunggu plugin kirim `/config` dulu.
5. Deploy. Render bakal kasih URL kayak `https://tiktok-chat-relay-xxxx.onrender.com` — ini yang lo masukin ke `CONFIG.SERVER_URL` di plugin Studio.

### Biar gak auto-sleep (free tier Render tidur kalau 15 menit gak ada trafik)

Daftar gratis di [cron-job.org](https://cron-job.org) atau [UptimeRobot](https://uptimerobot.com), bikin job yang hit `GET https://<url-render-kamu>.onrender.com/status` tiap 10 menit. Selama ping itu jalan, koneksi TikTok live-nya gak keputus.

## Catatan

- `tiktok-live-connector` itu reverse-engineered, bukan API resmi TikTok — kadang bisa putus sendiri kalau TikTok ubah sesuatu di sisi mereka. `disconnected`/`streamEnd` udah di-handle, plugin tinggal baca `/status` buat nunjukin indikator connect/gagal.
- Server ini cuma nyimpen 300 event terakhir di memory (bukan database) — cukup buat live chat display, restart server = buffer reset.
