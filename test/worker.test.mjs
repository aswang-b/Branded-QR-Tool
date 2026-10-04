import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { encodeId, decodeCode } from '../src/worker.js';

// ---------------------------------------------------------------- code sequence

test('codes run a-z, then 0-9, then gain a character', () => {
  const seq = Array.from({ length: 40 }, (_, i) => encodeId(i + 1));
  assert.deepEqual(seq.slice(0, 26), 'abcdefghijklmnopqrstuvwxyz'.split(''));
  assert.deepEqual(seq.slice(26, 36), '0123456789'.split(''));
  assert.deepEqual(seq.slice(36), ['aa', 'ab', 'ac', 'ad']);
});

test('length grows after 9 and again after 99', () => {
  assert.equal(encodeId(36), '9');
  assert.equal(encodeId(37), 'aa');
  assert.equal(encodeId(36 + 36 * 36), '99');
  assert.equal(encodeId(36 + 36 * 36 + 1), 'aaa');
  assert.equal(encodeId(72), 'a9');
  assert.equal(encodeId(73), 'ba');
});

test('encode/decode round-trip and no duplicates', () => {
  const seen = new Set();
  for (let id = 1; id <= 50000; id++) {
    const code = encodeId(id);
    assert.equal(decodeCode(code), id);
    assert.ok(!seen.has(code));
    seen.add(code);
  }
  assert.equal(decodeCode(encodeId(2 ** 40)), 2 ** 40);
});

test('decodeCode rejects junk', () => {
  for (const bad of ['', 'A', 'a-b', 'a b', '../x', 'a'.repeat(10), '%61', 'é'])
    assert.equal(decodeCode(bad), null, JSON.stringify(bad));
  assert.throws(() => encodeId(0));
  assert.throws(() => encodeId(1.5));
});

// ---------------------------------------------------------------- worker in workerd + local D1
// Runs the real thing: `wrangler dev` (workerd runtime, local D1, static assets),
// so routing between assets and the Worker is exercised too.

const ROOT = new URL('..', import.meta.url).pathname;
const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  srv.on('error', reject);
});

async function startWorker(vars = {}) {
  const port = await freePort();
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-worker-'));
  const args = ['dev', '--port', String(port), '--ip', '127.0.0.1', '--inspector-port', '0', '--persist-to', state, '--log-level', 'error'];
  for (const [k, v] of Object.entries(vars)) args.push('--var', `${k}:${v}`);
  const proc = spawn(path.join(ROOT, 'node_modules/.bin/wrangler'), args, {
    cwd: ROOT, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1', NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  proc.stdout.on('data', (d) => (log += d));
  proc.stderr.on('data', (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`wrangler dev exited early:\n${log}`);
    try { const r = await fetch(base + '/', { redirect: 'manual' }); await r.arrayBuffer(); if (r.status === 200) break; } catch { /* not up yet */ }
    if (Date.now() > deadline) { proc.kill(); throw new Error(`wrangler dev did not start:\n${log}`); }
    await new Promise((r) => setTimeout(r, 250));
  }
  return {
    base,
    call: (p, init) => fetch(base + p, { redirect: 'manual', ...init }),
    async stop() {
      proc.kill('SIGTERM');
      await new Promise((r) => { proc.once('exit', r); setTimeout(r, 3000); });
      fs.rmSync(state, { recursive: true, force: true });
    },
  };
}

const TOKEN = 'test-token-123';
const auth = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
let w, wBase, wBare;

before(async () => {
  [w, wBase, wBare] = await Promise.all([
    startWorker({ ADMIN_TOKEN: TOKEN }),
    startWorker({ ADMIN_TOKEN: TOKEN, PUBLIC_BASE_URL: 'https://dancewithb.fun/' }),
    startWorker({}),
  ]);
});
after(async () => { await Promise.all([w, wBase, wBare].map((x) => x?.stop())); });

const call = (p, init) => w.call(p, init);

test('static site is still served (not through the redirect logic)', async () => {
  const r = await call('/');
  assert.equal(r.status, 200);
  assert.match(await r.text(), /Branded QR/);
  const js = await call('/js/app.js');
  assert.equal(js.status, 200);
  await js.arrayBuffer();
});

test('admin API requires the token', async () => {
  for (const headers of [{}, { Authorization: 'Bearer nope' }, { Authorization: TOKEN }]) {
    const r = await call('/api/links', { headers });
    assert.equal(r.status, 401);
    await r.arrayBuffer();
  }
  const r = await call('/api/links', { method: 'POST', body: JSON.stringify({ url: 'https://a.example' }) });
  assert.equal(r.status, 401);
  await r.arrayBuffer();
});

test('creates links with incrementing codes and redirects to them', async () => {
  const dests = ['https://dancewithb.fun/check-in', 'https://example.com/two?x=1&y=2', 'http://example.org/'];
  const codes = [];
  for (const [i, url] of dests.entries()) {
    const r = await call('/api/links', { method: 'POST', headers: auth, body: JSON.stringify({ url, label: `link ${i}` }) });
    assert.equal(r.status, 201);
    const body = await r.json();
    codes.push(body.code);
    assert.equal(body.short, `${w.base}/c/${body.code}`);
    assert.equal(body.label, `link ${i}`);
  }
  assert.deepEqual(codes, ['a', 'b', 'c']);
  for (const [i, code] of codes.entries()) {
    const r = await call(`/c/${code}`);
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('Location'), new URL(dests[i]).href);
    assert.match(r.headers.get('Cache-Control'), /no-store/);
    await r.arrayBuffer();
  }
});

test('hit counter and listing', async () => {
  for (let i = 0; i < 3; i++) await (await call('/c/a')).arrayBuffer();
  await (await call('/c/a', { method: 'HEAD' })).arrayBuffer(); // HEAD must not count
  await new Promise((r) => setTimeout(r, 300)); // hits are recorded after the response
  const r = await call('/api/links', { headers: auth });
  const { links } = await r.json();
  assert.deepEqual(links.map((l) => l.code), ['c', 'b', 'a']);
  const a = links.find((l) => l.code === 'a');
  assert.equal(a.hits, 4); // 1 from the previous test + 3 here, HEAD not counted
  assert.ok(a.last_hit > 0);
});

test('unknown, invalid and odd-case codes', async () => {
  for (const p of ['/c/zzzz', '/c/', '/c', '/c/a-b', '/c/aaaaaaaaaaaa']) {
    const r = await call(p);
    assert.equal(r.status, 404, p);
    await r.arrayBuffer();
  }
  const r = await call('/c/A'); // case-insensitive
  assert.equal(r.status, 302);
  await r.arrayBuffer();
  const post = await call('/c/a', { method: 'POST' });
  assert.equal(post.status, 405);
  await post.arrayBuffer();
});

test('update and delete; deleted codes are never reused', async () => {
  let r = await call('/api/links/b', { method: 'PATCH', headers: auth, body: JSON.stringify({ url: 'https://example.com/changed' }) });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).url, 'https://example.com/changed');
  r = await call('/c/b');
  assert.equal(r.headers.get('Location'), 'https://example.com/changed');
  await r.arrayBuffer();

  r = await call('/api/links/c', { method: 'DELETE', headers: auth });
  assert.equal(r.status, 200);
  await r.arrayBuffer();
  r = await call('/c/c');
  assert.equal(r.status, 404);
  await r.arrayBuffer();
  r = await call('/api/links/c', { method: 'DELETE', headers: auth });
  assert.equal(r.status, 404);
  await r.arrayBuffer();

  r = await call('/api/links', { method: 'POST', headers: auth, body: JSON.stringify({ url: 'https://example.com/after-delete' }) });
  assert.equal((await r.json()).code, 'd'); // 'c' is not handed out again
});

test('rejects bad destinations and bodies', async () => {
  const bad = [
    { url: 'javascript:alert(1)' }, { url: 'ftp://example.com' }, { url: 'not a url' }, { url: '' }, { url: 42 },
    { url: `${w.base}/c/a` }, {}, { url: 'https://example.com/' + 'x'.repeat(2100) },
    { url: 'https://example.com', label: 'x'.repeat(101) },
  ];
  for (const body of bad) {
    const r = await call('/api/links', { method: 'POST', headers: auth, body: JSON.stringify(body) });
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 60));
    await r.arrayBuffer();
  }
  for (const raw of ['{nope', '[]', 'null']) {
    const r = await call('/api/links', { method: 'POST', headers: auth, body: raw });
    assert.equal(r.status, 400, raw);
    await r.arrayBuffer();
  }
  const r = await call('/api/links/b', { method: 'PATCH', headers: auth, body: '{}' });
  assert.equal(r.status, 400);
  await r.arrayBuffer();
});

test('without ADMIN_TOKEN configured the API fails closed', async () => {
  for (const headers of [{}, { Authorization: 'Bearer ' }, { Authorization: 'Bearer undefined' }]) {
    const r = await wBare.call('/api/links', { headers });
    assert.equal(r.status, 503);
    await r.arrayBuffer();
  }
});

test('PUBLIC_BASE_URL controls the short URL that goes in the QR code', async () => {
  const r = await wBase.call('/api/links', { method: 'POST', headers: auth, body: JSON.stringify({ url: 'https://example.com' }) });
  assert.equal((await r.json()).short, 'https://dancewithb.fun/c/a');
});
