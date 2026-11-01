'use strict';
// Zero-dependency API test. Run with: npm test
const assert = require('assert');
const http = require('http');
const server = require('../server');

let base;

async function post(path, body) {
  const r = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await r.json(); } catch { /* no body */ }
  return { status: r.status, data };
}

// Minimal SSE reader
function listen(path) {
  const events = [];
  const waiters = [];
  const ctrl = new AbortController();
  const ready = (async () => {
    const r = await fetch(base + path, { signal: ctrl.signal });
    assert.strictEqual(r.status, 200, 'SSE should open');
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const ev = /^event: (.*)$/m.exec(frame);
            const data = /^data: (.*)$/m.exec(frame);
            if (ev) {
              const rec = { event: ev[1], data: data ? JSON.parse(data[1]) : null };
              events.push(rec);
              waiters.splice(0).forEach((w) => w());
            }
          }
        }
      } catch { /* aborted */ }
    })();
  })();
  async function next(event, ms = 3000) {
    await ready;
    const t0 = Date.now();
    for (;;) {
      const i = events.findIndex((e) => e.event === event);
      if (i >= 0) return events.splice(i, 1)[0];
      if (Date.now() - t0 > ms) throw new Error(`timed out waiting for "${event}"`);
      await new Promise((res) => { waiters.push(res); setTimeout(res, 100); });
    }
  }
  return { next, close: () => ctrl.abort() };
}

function rawGet(path) {
  return new Promise((resolve, reject) => {
    const u = new URL(base);
    http.get({ host: u.hostname, port: u.port, path }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    }).on('error', reject);
  });
}

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  let passed = 0;
  const ok = (name) => { passed += 1; console.log(`  ok  ${name}`); };

  // pairing
  const created = await post('/api/create');
  assert.strictEqual(created.status, 200);
  assert.match(created.data.code, /^\d{6}$/);
  ok('create returns a six-digit code');

  const host = listen(`/api/events?code=${created.data.code}&peer=${created.data.peer}`);

  const bad = await post('/api/join', { code: '000000' === created.data.code ? '111111' : '000000' });
  assert.strictEqual(bad.status, 404);
  ok('wrong code is rejected');

  const joined = await post('/api/join', { code: created.data.code });
  assert.strictEqual(joined.status, 200);
  const guest = listen(`/api/events?code=${joined.data.code}&peer=${joined.data.peer}`);
  await host.next('paired');
  await guest.next('paired');
  ok('both sides get "paired"');

  const again = await post('/api/join', { code: created.data.code });
  assert.strictEqual(again.status, 409);
  ok('a code works only once');

  // relay both directions
  const hq = `?code=${created.data.code}&peer=${created.data.peer}`;
  const gq = `?code=${joined.data.code}&peer=${joined.data.peer}`;
  assert.strictEqual((await post('/api/send' + hq, { t: 'text', text: 'hello guest' })).status, 204);
  assert.strictEqual((await guest.next('msg')).data.text, 'hello guest');
  assert.strictEqual((await post('/api/send' + gq, { t: 'text', text: 'hello host' })).status, 204);
  assert.strictEqual((await host.next('msg')).data.text, 'hello host');
  ok('messages relay in both directions');

  const big = 'A'.repeat(300 * 1024);
  await post('/api/send' + hq, { t: 'chunk', id: 1, d: big });
  assert.strictEqual((await guest.next('msg')).data.d.length, big.length);
  ok('a 300 KB chunk relays intact');

  const tooBig = await post('/api/send' + hq, { t: 'chunk', id: 2, d: 'A'.repeat(600 * 1024) });
  assert.strictEqual(tooBig.status, 413);
  ok('oversized message is refused');

  const forged = await post(`/api/send?code=${created.data.code}&peer=nope`, { t: 'text', text: 'x' });
  assert.strictEqual(forged.status, 404);
  ok('wrong peer token is refused');

  // leaving
  await post('/api/leave' + gq);
  await host.next('closed');
  ok('leaving notifies the other device');
  const after = await post('/api/join', { code: created.data.code });
  assert.strictEqual(after.status, 404);
  ok('a closed session cannot be joined');
  host.close();
  guest.close();

  // brute-force limit
  let limited = false;
  for (let i = 0; i < 14; i++) {
    const r = await post('/api/join', { code: String(100000 + i) });
    if (r.status === 429) { limited = true; break; }
  }
  assert.ok(limited, 'rate limit should kick in');
  ok('repeated wrong codes get rate limited');

  // static
  const page = await fetch(base + '/');
  assert.strictEqual(page.status, 200);
  assert.ok((page.headers.get('content-security-policy') || '').includes("default-src 'self'"));
  ok('home page is served with a CSP');
  assert.ok([403, 404].includes(await rawGet('/..%2fserver.js')));
  ok('path traversal is blocked');

  console.log(`\n${passed} checks passed`);
  server.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('\nFAILED:', err.message);
  process.exit(1);
});
