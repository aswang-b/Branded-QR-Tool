import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
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

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  srv.on('error', reject);
});

async function startWorker(vars = {}) {
  const port = await freePort();
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-worker-'));
  // An empty env file stops a developer's local .dev.vars (e.g. ADMIN_TOKEN) leaking into tests.
  const envFile = path.join(state, 'empty.env');
  fs.writeFileSync(envFile, '');
  const args = ['dev', '--port', String(port), '--ip', '127.0.0.1', '--inspector-port', '0', '--persist-to', state, '--log-level', 'error', '--env-file', envFile,
    // The custom-domain route in wrangler.jsonc would otherwise make local requests
    // look like they came from qr.dancewithb.fun.
    '--local-upstream', `127.0.0.1:${port}`];
  // Tests must not depend on the production origin pinned in wrangler.jsonc.
  vars = { PUBLIC_BASE_URL: '', ...vars };
  for (const [k, v] of Object.entries(vars)) args.push('--var', `${k}:${v}`);
  // Run wrangler's JS entry with node: works on Windows too (no .cmd shim, spaces in paths).
  const proc = spawn(process.execPath, [path.join(ROOT, 'node_modules/wrangler/bin/wrangler.js'), ...args], {
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
      const exited = new Promise((r) => { proc.once('exit', r); setTimeout(r, 3000); });
      // On Windows, killing the node wrapper leaves workerd running: end the whole tree.
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
      else proc.kill('SIGTERM');
      await exited;
      // Best effort: Windows can hold the local D1 files a moment longer; it's a temp dir.
      try { fs.rmSync(state, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* left for the OS */ }
    },
  };
}

const TOKEN = 'test-token-123';
const API_TOKEN = 'api-key-456';
const auth = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
let w, wBase, wBare;

before(async () => {
  [w, wBase, wBare] = await Promise.all([
    startWorker({ ADMIN_TOKEN: TOKEN, API_TOKEN }),
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

// ---------------------------------------------------------------- the API: <domain>.<create|read|update|delete>

/** POST /api/<method> with JSON params (auth: the admin token unless given). */
const rpc = (method, params = {}, headers = auth, worker = w) =>
  worker.call(`/api/${method}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(params) });
const key = { Authorization: `Bearer ${API_TOKEN}` };
async function expectStatus(res, status, msg) {
  assert.equal(res.status, status, msg);
  await res.arrayBuffer();
}

test('the API requires a token', async () => {
  for (const headers of [{}, { Authorization: 'Bearer nope' }, { Authorization: TOKEN }]) {
    await expectStatus(await rpc('link.read', {}, headers), 401);
  }
  await expectStatus(await rpc('link.create', { url: 'https://a.example' }, {}), 401);
});

test('unknown methods and wrong HTTP verbs', async () => {
  for (const m of ['links', 'link.list', 'link.read.x', 'qr.image', 'nope.read', 'link.__proto__', 'constructor.read']) {
    await expectStatus(await rpc(m), 404, m);
  }
  await expectStatus(await call('/api/link.create', { headers: auth }), 405); // writes are POST only
  await expectStatus(await call('/api/link.read', { method: 'DELETE', headers: auth }), 405);
});

test('link.create: incrementing codes that redirect', async () => {
  const dests = ['https://dancewithb.fun/check-in', 'https://example.com/two?x=1&y=2', 'http://example.org/'];
  const codes = [];
  for (const [i, url] of dests.entries()) {
    const r = await rpc('link.create', { url, label: `link ${i}` });
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
    // explicit empty fragment: a QR code's shaping #fragment must not be copied onto the destination
    assert.equal(r.headers.get('Location'), new URL(dests[i]).href + '#');
    assert.match(r.headers.get('Cache-Control'), /no-store/);
    await r.arrayBuffer();
  }
});

test('link.read: hit counter, one link, and the list (also over GET)', async () => {
  for (let i = 0; i < 3; i++) await (await call('/c/a')).arrayBuffer();
  await (await call('/c/a', { method: 'HEAD' })).arrayBuffer(); // HEAD must not count
  await new Promise((r) => setTimeout(r, 300)); // hits are recorded after the response
  const { links } = await (await rpc('link.read')).json();
  assert.deepEqual(links.map((l) => l.code), ['c', 'b', 'a']);
  const a = links.find((l) => l.code === 'a');
  assert.equal(a.hits, 4); // 1 from the previous test + 3 here, HEAD not counted
  assert.ok(a.last_hit > 0);

  const one = await (await rpc('link.read', { code: 'A' })).json(); // case-insensitive
  assert.equal(one.url, 'https://dancewithb.fun/check-in');
  const viaGet = await (await call('/api/link.read?code=b', { headers: auth })).json();
  assert.equal(viaGet.code, 'b');
  const page = await (await call('/api/link.read?limit=1&offset=1', { headers: auth })).json();
  assert.deepEqual(page.links.map((l) => l.code), ['b']);
  for (const code of ['zzzz', 'a-b', '', 42]) await expectStatus(await rpc('link.read', { code }), 404, String(code));
});

test('unknown, invalid and odd-case short codes', async () => {
  for (const p of ['/c/zzzz', '/c/', '/c', '/c/a-b', '/c/aaaaaaaaaaaa']) await expectStatus(await call(p), 404, p);
  await expectStatus(await call('/c/A'), 302); // case-insensitive
  await expectStatus(await call('/c/a', { method: 'POST' }), 405);
});

test('link.update and link.delete; deleted codes are never reused', async () => {
  let r = await rpc('link.update', { code: 'b', url: 'https://example.com/changed' });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).url, 'https://example.com/changed');
  r = await call('/c/b');
  assert.equal(r.headers.get('Location'), 'https://example.com/changed#');
  await r.arrayBuffer();

  await expectStatus(await rpc('link.delete', { code: 'c' }), 200);
  await expectStatus(await call('/c/c'), 404);
  await expectStatus(await rpc('link.delete', { code: 'c' }), 404);
  await expectStatus(await rpc('link.update', { code: 'c', url: 'https://example.com/' }), 404);

  r = await rpc('link.create', { url: 'https://example.com/after-delete' });
  assert.equal((await r.json()).code, 'd'); // 'c' is not handed out again
});

test('rejects bad destinations and bodies', async () => {
  const bad = [
    { url: 'javascript:alert(1)' }, { url: 'ftp://example.com' }, { url: 'not a url' }, { url: '' }, { url: 42 },
    { url: `${w.base}/c/a` }, {}, { url: 'https://example.com/' + 'x'.repeat(2100) },
    { url: 'https://example.com', label: 'x'.repeat(101) },
  ];
  for (const body of bad) await expectStatus(await rpc('link.create', body), 400, JSON.stringify(body).slice(0, 60));
  for (const raw of ['{nope', '[]', 'null']) {
    await expectStatus(await call('/api/link.create', { method: 'POST', headers: auth, body: raw }), 400, raw);
  }
  await expectStatus(await rpc('link.update', { code: 'b' }), 400); // nothing to update
});

test('without ADMIN_TOKEN configured the API fails closed', async () => {
  for (const headers of [{}, { Authorization: 'Bearer ' }, { Authorization: 'Bearer undefined' }]) {
    await expectStatus(await rpc('link.read', {}, headers, wBare), 503);
  }
});

test('PUBLIC_BASE_URL controls the short URL that goes in the QR code', async () => {
  const r = await rpc('link.create', { url: 'https://example.com' }, auth, wBase);
  assert.equal((await r.json()).short, 'https://dancewithb.fun/c/a');
});

test('a destination with its own fragment keeps it', async () => {
  const { code } = await (await rpc('link.create', { url: 'https://example.com/app#/route' })).json();
  const r = await call(`/c/${code}`);
  assert.equal(r.headers.get('Location'), 'https://example.com/app#/route');
  await r.arrayBuffer();
});

// ---------------------------------------------------------------- saved designs (qr.*)

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#fff"/><g fill="#000"><rect x="1" y="1" width="1" height="1"/></g></svg>';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

test('qr.create, qr.read, qr.update, qr.delete', async () => {
  // a design whose text is one of our short links (with a shaping fragment) is linked to it
  const text = `${w.base}/c/a#AbC-123_xyz`;
  let r = await rpc('qr.create', { name: 'Check-in sticker', details: 'Pink, 25 mm', text, svg: SVG, meta: { reliability: 0.97, minMm: 21 } });
  assert.equal(r.status, 201);
  const saved = await r.json();
  assert.equal(saved.name, 'Check-in sticker');
  assert.equal(saved.author, '');
  assert.equal(saved.link.code, 'a');
  assert.equal(saved.link.url, 'https://dancewithb.fun/check-in');
  assert.deepEqual(saved.meta, { reliability: 0.97, minMm: 21 });
  assert.equal(saved.svg, undefined); // list/create responses stay small

  const other = await (await rpc('qr.create', { name: 'Plain text one', text: 'hello', svg: SVG })).json();
  assert.equal(other.link, null);
  assert.equal(other.details, '');

  const { designs } = await (await rpc('qr.read')).json();
  assert.deepEqual(designs.slice(0, 2).map((d) => d.id), [other.id, saved.id]);
  assert.ok(designs.every((d) => d.svg === undefined));

  assert.equal((await (await rpc('qr.read', { id: saved.id })).json()).svg, SVG);
  assert.equal((await (await call(`/api/qr.read?id=${saved.id}`, { headers: auth })).json()).svg, SVG); // GET works for reads

  const renamed = await (await rpc('qr.update', { id: saved.id, name: 'Renamed', details: 'v2' })).json();
  assert.equal(renamed.name, 'Renamed');
  assert.equal(renamed.details, 'v2');

  await expectStatus(await rpc('qr.delete', { id: other.id }), 200);
  await expectStatus(await rpc('qr.read', { id: other.id }), 404);
});

test('qr.create validates input', async () => {
  await expectStatus(await rpc('qr.create', { name: 'x', text: 'x', svg: SVG }, {}), 401);
  const bad = [
    { text: 'x', svg: SVG },                                   // no name
    { name: 'x'.repeat(101), text: 'x', svg: SVG },
    { name: 'x', svg: SVG },                                   // no text
    { name: 'x', text: 'x', svg: '<div/>' },
    { name: 'x', text: 'x', svg: SVG.replace('<rect', '<script>alert(1)</script><rect') },
    { name: 'x', text: 'x', svg: SVG.replace('<rect ', '<rect onload="alert(1)" ') },
    { name: 'x', text: 'x', svg: SVG.replace('<rect ', '<a href="javascript:alert(1)"/><rect ') },
    { name: 'x', text: 'x', svg: SVG, meta: [1, 2] },
    { name: 'x', text: 'x', svg: SVG, details: 'd'.repeat(2001) },
    { name: 'x', text: 'x', svg: SVG, author: 'a'.repeat(201) },
    { name: 'x', text: 'x', svg: SVG, image: 'data:image/svg+xml;base64,PHN2Zz4=' }, // logos are PNG only
    { name: 'x', text: 'x', svg: SVG, image: 'data:image/png;base64,<script>' },
    { name: 'x', text: 'x', svg: SVG, image: 'data:image/png;base64,' + 'A'.repeat(300_001) },
  ];
  for (const body of bad) await expectStatus(await rpc('qr.create', body), 400, JSON.stringify(body).slice(0, 80));
  for (const id of ['0', 'abc', '-1', '1.5', 0, null]) await expectStatus(await rpc('qr.read', { id }), 404, String(id));
  await expectStatus(await rpc('qr.read', { id: 1, format: 'png' }), 400);
});

test('qr.update replaces a saved code (from the editor) and keeps its logo', async () => {
  let r = await rpc('qr.create', { name: 'Sticker', text: 'https://example.com/#a', svg: SVG, image: PNG, meta: { v: 1 } });
  assert.equal(r.status, 201);
  const { id } = await r.json();
  assert.equal((await (await rpc('qr.read', { id })).json()).image, PNG);

  // text and svg must come together
  await expectStatus(await rpc('qr.update', { id, text: 'https://example.com/#b' }), 400);

  const SVG2 = SVG.replace('#000', '#e8365d');
  const text = `${w.base}/c/a#XyZ`;
  const replaced = await (await rpc('qr.update', { id, name: 'Sticker v2', text, svg: SVG2, meta: { v: 2 } })).json();
  assert.equal(replaced.name, 'Sticker v2');
  assert.equal(replaced.text, text);
  assert.equal(replaced.link.code, 'a'); // now linked to the short link
  assert.deepEqual(replaced.meta, { v: 2 });
  const full = await (await rpc('qr.read', { id })).json();
  assert.equal(full.svg, SVG2);
  assert.equal(full.image, PNG); // untouched when not sent

  // designs saved before logos were stored come back with image: null
  const old = await (await rpc('qr.create', { name: 'Old', text: 'x', svg: SVG })).json();
  assert.equal((await (await rpc('qr.read', { id: old.id })).json()).image, null);
});

test('qr.read with format "svg" returns the raw image', async () => {
  const { id } = await (await rpc('qr.create', { name: 'Image', text: 'x', svg: SVG })).json();
  let r = await rpc('qr.read', { id, format: 'svg' });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^image\/svg\+xml/);
  assert.equal(r.headers.get('access-control-allow-origin'), null); // server-to-server only
  assert.match(r.headers.get('cache-control'), /^private/);
  assert.match(r.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal(await r.text(), SVG);
  r = await call(`/api/qr.read?id=${id}&format=svg`, { headers: auth });
  assert.equal(await r.text(), SVG);
  await expectStatus(await call(`/api/qr.read?id=${id}&format=svg`), 401); // never without a token
});

test('designs: realistic generated SVGs fit', async () => {
  const big = SVG.replace('</svg>', '<g fill="#e8365d">' + '<circle cx="1.5" cy="1.5" r="0.45"/>'.repeat(20000) + '</g></svg>');
  const r = await rpc('qr.create', { name: 'Big', text: 'x', svg: big });
  assert.equal(r.status, 201, `size ${big.length}`);
  await r.arrayBuffer();
});

// ---------------------------------------------------------------- authors and the API key

test('authors: the admin sets and filters by author', async () => {
  const mine = await (await rpc('qr.create', { name: 'Mine', text: 'x', svg: SVG, author: 'alex@example.com' })).json();
  assert.equal(mine.author, 'alex@example.com');
  const theirs = await (await rpc('qr.create', { name: 'Theirs', text: 'x', svg: SVG, author: 'sam' })).json();
  const { designs } = await (await rpc('qr.read', { author: 'alex@example.com' })).json();
  assert.ok(designs.length >= 1 && designs.every((d) => d.author === 'alex@example.com'));
  assert.ok(!designs.some((d) => d.id === theirs.id));
  const moved = await (await rpc('qr.update', { id: theirs.id, new_author: 'alex@example.com' })).json();
  assert.equal(moved.author, 'alex@example.com');
});

test('the API key: one author at a time for qr.*, no creating or moving designs', async () => {
  const a = await (await rpc('qr.create', { name: 'Author A', text: 'x', svg: SVG, author: 'author-a' })).json();
  const b = await (await rpc('qr.create', { name: 'Author B', text: 'x', svg: SVG, author: 'author-b' })).json();

  // must name an author
  for (const params of [{}, { author: '' }, { author: '  ' }, { id: a.id }]) await expectStatus(await rpc('qr.read', params, key), 400, JSON.stringify(params));

  const { designs } = await (await rpc('qr.read', { author: 'author-a' }, key)).json();
  assert.deepEqual(designs.map((d) => d.id), [a.id]);
  assert.equal((await (await rpc('qr.read', { author: 'author-a', id: a.id }, key)).json()).svg, SVG);
  const img = await rpc('qr.read', { author: 'author-a', id: a.id, format: 'svg' }, key);
  assert.equal(await img.text(), SVG);

  // another author's design looks like it doesn't exist
  await expectStatus(await rpc('qr.read', { author: 'author-a', id: b.id }, key), 404);
  await expectStatus(await rpc('qr.read', { author: 'author-a', id: b.id, format: 'svg' }, key), 404);
  await expectStatus(await rpc('qr.update', { author: 'author-a', id: b.id, name: 'Hijacked' }, key), 404);
  await expectStatus(await rpc('qr.delete', { author: 'author-a', id: b.id }, key), 404);
  assert.equal((await (await rpc('qr.read', { id: b.id })).json()).name, 'Author B');

  // its own author's designs: rename, replace, delete
  const renamed = await (await rpc('qr.update', { author: 'author-a', id: a.id, name: 'A2', details: 'via API' }, key)).json();
  assert.equal(renamed.name, 'A2');
  const SVG2 = SVG.replace('#000', '#222');
  await expectStatus(await rpc('qr.update', { author: 'author-a', id: a.id, text: 'y', svg: SVG2 }, key), 200);
  await expectStatus(await rpc('qr.update', { author: 'author-a', id: a.id, new_author: 'author-b' }, key), 403);
  await expectStatus(await rpc('qr.create', { name: 'x', text: 'x', svg: SVG, author: 'author-a' }, key), 403);
  await expectStatus(await rpc('qr.delete', { author: 'author-a', id: a.id }, key), 200);
  await expectStatus(await rpc('qr.read', { id: a.id }), 404);
});

test('the API key can read links and change destinations, nothing else', async () => {
  const link = await (await rpc('link.create', { url: 'https://dancewithb.fun/check-in?events=1' })).json();

  const { links } = await (await rpc('link.read', {}, key)).json();
  assert.ok(links.some((l) => l.code === link.code));
  assert.equal((await (await rpc('link.read', { code: link.code }, key)).json()).url, 'https://dancewithb.fun/check-in?events=1');
  const r = await rpc('link.update', { code: link.code, url: 'https://dancewithb.fun/check-in?events=2' }, key);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).url, 'https://dancewithb.fun/check-in?events=2');
  const go = await call(`/c/${link.code}`);
  assert.equal(go.headers.get('location'), 'https://dancewithb.fun/check-in?events=2#');
  await go.arrayBuffer();

  await expectStatus(await rpc('link.create', { url: 'https://example.com/' }, key), 403);
  await expectStatus(await rpc('link.delete', { code: link.code }, key), 403);
  await expectStatus(await rpc('link.read', {}, { Authorization: 'Bearer api-key-457' }), 401);
  // a worker without API_TOKEN doesn't accept it (or an empty bearer)
  for (const t of [API_TOKEN, '']) await expectStatus(await rpc('link.read', {}, { Authorization: `Bearer ${t}` }, wBase), 401, JSON.stringify(t));
});
