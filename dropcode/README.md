# Dropcode

Send files, photos and text between any two devices with a six-digit code.
No sign-in, no install, nothing to pair ahead of time.

1. On one device, open the site and choose **Get a code**.
2. On the other device, open the same site and type the code under **Have a code**.
3. Drop files, paste an image or type some text. It arrives on the other side.

## Run it

Needs Node 18 or newer. There are no packages to install.

```bash
node server.js          # http://localhost:3000
PORT=8080 node server.js
npm test                # API tests
```

To try it on your own network, open `http://<your-computer-ip>:3000` on your phone
while both are on the same Wi-Fi.

## Put it online

Dropcode needs one small always-on server so two devices can find each other.
After that, files go straight between the devices when the network allows it.

Any host that runs a long-lived Node process works: Render, Railway, Fly.io,
a small VPS. Use these settings:

- Start command: `node server.js`
- Instances: exactly one (pairing codes live in that process's memory)
- HTTPS: on (every host above gives you this; clipboard copy needs it)

Serverless platforms (Vercel, Netlify functions, Cloudflare Workers without
Durable Objects) are not a fit: they don't keep the live connection the pairing
channel uses.

## How it works

- The server hands out a random six-digit code and keeps the pairing in memory.
  A code works once, expires after 10 minutes, and wrong guesses are rate limited.
- The two browsers use the server only to swap WebRTC setup messages. Then they
  open a direct data channel and the files never touch the server.
- If a direct link can't be made (strict firewalls, some mobile networks), the
  app falls back to relaying through the server automatically. The status
  badge says which one you're on. Relayed data is passed along and never stored.
- Limits: 500 MB per file for direct transfers, 50 MB per file through the relay.
  Received files are held in the browser's memory until you tap **Save**.

Add `?relay=1` to the address to force the relay path (useful for troubleshooting).

## Files

| File | What it does |
| --- | --- |
| `server.js` | Pairing, relay, static files. No dependencies. |
| `public/index.html` | The three screens: home, waiting, transfer. |
| `public/app.js` | Pairing, WebRTC, relay fallback, transfer list. |
| `public/style.css` | The ticket design, light and dark. |
| `test/api.test.js` | Checks pairing, relay, limits and file serving. |

## Privacy notes

- Nothing is written to disk on the server and there are no accounts or logs of content.
- Anyone who has the code during its ten-minute window can join, so don't read
  it out in public. A used or expired code can't be reused.
- STUN servers from Google and Cloudflare are used to help two devices find each
  other. They see IP addresses, not your files.
