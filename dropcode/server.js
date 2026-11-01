'use strict';
// Dropcode server: pairs two browsers with a six-digit code and relays
// small signalling messages (and, as a fallback, file chunks) between them.
// No dependencies. Nothing is written to disk. Rooms live only in memory.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');

const CODE_TTL_MS = 10 * 60 * 1000;   // how long an unused code stays valid
const IDLE_TTL_MS = 30 * 60 * 1000;   // paired session with no traffic
const GONE_GRACE_MS = 20 * 1000;      // how long a dropped browser may reconnect
const MAX_BODY = 512 * 1024;          // largest single relayed message
const MAX_QUEUE = 4000;               // frames buffered for a peer that has not connected yet
const MAX_ROOMS = 5000;

const rooms = new Map();              // code -> room
const failures = new Map();           // ip -> { count, resetAt }

// ---------- helpers ----------

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const parts = String(xff).split(',');
    return parts[parts.length - 1].trim(); // the hop closest to us
  }
  return req.socket.remoteAddress || 'unknown';
}

function newCode() {
  for (;;) {
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    if (!rooms.has(code)) return code;
  }
}

function newToken() {
  return crypto.randomBytes(16).toString('hex');
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooBig = false;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (tooBig) {
        // keep draining so the 413 can be delivered, but never buffer it
        if (size > MAX_BODY * 16) req.destroy();
        return;
      }
      if (size > MAX_BODY) {
        tooBig = true;
        chunks.length = 0;
        reject(Object.assign(new Error('Message too large'), { status: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooBig) return;
      if (!size) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function otherRole(role) {
  return role === 'host' ? 'guest' : 'host';
}

function roleOf(room, token) {
  if (!token) return null;
  for (const role of ['host', 'guest']) {
    const p = room.peers[role];
    if (p && p.token === token) return role;
  }
  return null;
}

function push(room, role, event, data) {
  const peer = room.peers[role];
  if (!peer) return;
  const frame = `event: ${event}\ndata: ${JSON.stringify(data === undefined ? {} : data)}\n\n`;
  if (peer.res) {
    peer.res.write(frame);
  } else if (peer.queue.length < MAX_QUEUE) {
    peer.queue.push(frame);
  }
}

function closeRoom(room, event) {
  if (event) {
    for (const role of ['host', 'guest']) push(room, role, event);
  }
  for (const role of ['host', 'guest']) {
    const p = room.peers[role];
    if (p && p.res) {
      try { p.res.end(); } catch { /* already closed */ }
    }
  }
  rooms.delete(room.code);
}

function tooManyFailures(ip) {
  const now = Date.now();
  const rec = failures.get(ip);
  if (!rec || rec.resetAt < now) return false;
  return rec.count >= 10;
}

function recordFailure(ip) {
  const now = Date.now();
  const rec = failures.get(ip);
  if (!rec || rec.resetAt < now) {
    failures.set(ip, { count: 1, resetAt: now + 60 * 1000 });
  } else {
    rec.count += 1;
  }
}

// ---------- API ----------

async function handleApi(req, res, url) {
  const route = url.pathname;
  const q = url.searchParams;

  if (route === '/api/create' && req.method === 'POST') {
    if (rooms.size >= MAX_ROOMS) return sendJson(res, 503, { error: 'The server is busy. Try again in a minute.' });
    const code = newCode();
    const now = Date.now();
    const host = { token: newToken(), res: null, queue: [], goneAt: now };
    rooms.set(code, {
      code,
      createdAt: now,
      lastActive: now,
      paired: false,
      peers: { host, guest: null },
    });
    return sendJson(res, 200, { code, peer: host.token, ttl: CODE_TTL_MS / 1000 });
  }

  if (route === '/api/join' && req.method === 'POST') {
    const ip = clientIp(req);
    if (tooManyFailures(ip)) {
      return sendJson(res, 429, { error: 'Too many wrong codes. Wait a minute and try again.' });
    }
    const body = await readJson(req);
    const code = String(body.code || '').replace(/\D/g, '');
    const room = rooms.get(code);
    if (!room) {
      recordFailure(ip);
      return sendJson(res, 404, { error: "That code isn't active. Check the digits, or get a new code on the other device." });
    }
    if (room.peers.guest) {
      recordFailure(ip);
      return sendJson(res, 409, { error: 'That code has already been used. Get a new code on the other device.' });
    }
    const now = Date.now();
    room.peers.guest = { token: newToken(), res: null, queue: [], goneAt: now };
    room.paired = true;
    room.lastActive = now;
    push(room, 'host', 'paired');
    push(room, 'guest', 'paired');
    return sendJson(res, 200, { code, peer: room.peers.guest.token });
  }

  if (route === '/api/events' && req.method === 'GET') {
    const room = rooms.get(q.get('code') || '');
    const role = room ? roleOf(room, q.get('peer')) : null;
    if (!room || !role) return sendJson(res, 404, { error: 'Session not found' });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 1500\n\n');

    const peer = room.peers[role];
    if (peer.res && peer.res !== res) {
      try { peer.res.end(); } catch { /* ignore */ }
    }
    peer.res = res;
    peer.goneAt = null;
    for (const frame of peer.queue) res.write(frame);
    peer.queue = [];

    req.on('close', () => {
      if (peer.res === res) {
        peer.res = null;
        peer.goneAt = Date.now();
      }
    });
    return;
  }

  if (route === '/api/send' && req.method === 'POST') {
    const room = rooms.get(q.get('code') || '');
    const role = room ? roleOf(room, q.get('peer')) : null;
    if (!room || !role) return sendJson(res, 404, { error: 'Session not found' });
    if (!room.paired || !room.peers[otherRole(role)]) return sendJson(res, 409, { error: 'The other device has not joined yet' });
    const body = await readJson(req);
    room.lastActive = Date.now();
    push(room, otherRole(role), 'msg', body);
    res.writeHead(204, { 'Cache-Control': 'no-store' });
    return res.end();
  }

  if (route === '/api/leave' && req.method === 'POST') {
    const room = rooms.get(q.get('code') || '');
    const role = room ? roleOf(room, q.get('peer')) : null;
    if (room && role) closeRoom(room, 'closed');
    res.writeHead(204, { 'Cache-Control': 'no-store' });
    return res.end();
  }

  return sendJson(res, 404, { error: 'Not found' });
}

// ---------- static files ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "style-src 'self' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' blob: data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      ...SECURITY_HEADERS,
    });
    res.end(data);
  });
}

// ---------- server ----------

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true, rooms: rooms.size });
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      return res.end();
    }
    return serveStatic(req, res, url);
  } catch (err) {
    if (!res.headersSent) sendJson(res, err.status || 500, { error: err.status ? err.message : 'Server error' });
    else res.end();
  }
});

// Housekeeping: expire codes, drop abandoned sessions, keep SSE connections alive.
setInterval(() => {
  const now = Date.now();
  for (const room of [...rooms.values()]) {
    if (!room.paired && now - room.createdAt > CODE_TTL_MS) {
      closeRoom(room, 'expired');
      continue;
    }
    if (room.paired && now - room.lastActive > IDLE_TTL_MS) {
      closeRoom(room, 'closed');
      continue;
    }
    for (const role of ['host', 'guest']) {
      const p = room.peers[role];
      if (p && !p.res && p.goneAt && now - p.goneAt > GONE_GRACE_MS) {
        closeRoom(room, 'closed');
        break;
      }
    }
  }
  for (const [ip, rec] of failures) if (rec.resetAt < now) failures.delete(ip);
}, 5000).unref();

setInterval(() => {
  for (const room of rooms.values()) {
    for (const role of ['host', 'guest']) {
      const p = room.peers[role];
      if (p && p.res) p.res.write(': keep-alive\n\n');
    }
  }
}, 15000).unref();

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`Dropcode is running on http://localhost:${PORT}`);
  });
}

module.exports = server;
