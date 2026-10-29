import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { encodeId, decodeCode, parseSvg } from '../src/worker.js';
import { planFragment, pickFragmentVersion } from '../public/js/fragment.js';
import { buildShapes, toSVG } from '../public/js/render.js';
import { pinkLogo } from './helpers.mjs';

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

// ---------------------------------------------------------------- the API: <domain>.<create|read|update|delete>

/** POST /api/<method> with JSON params (auth: the admin token unless given). */
const rpc = (method, params = {}, headers = auth, worker = w) =>
  worker.call(`/api/${method}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(params) });
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

// ---------------------------------------------------------------- authors (admin filter)

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

// ---------------------------------------------------------------- authors and their tokens

/** Authorize an author (admin) and return their bearer header. */
async function authorKey(name) {
  const r = await rpc('author.create', { name });
  assert.equal(r.status, 201);
  const a = await r.json();
  assert.match(a.token, /^qra_[A-Za-z0-9_-]{43}$/);
  return { Authorization: `Bearer ${a.token}` };
}

test('author.create / read / update / delete: tokens stay viewable, rotate and revoke', async () => {
  let r = await rpc('author.create', { name: 'viewer@example.com' });
  const created = await r.json();
  assert.equal(created.name, 'viewer@example.com');
  assert.equal(created.codes, 0);
  assert.equal(created.last_used, null);

  // the token can be viewed again later, one author or in the list
  assert.equal((await (await rpc('author.read', { name: 'viewer@example.com' })).json()).token, created.token);
  const { authors } = await (await rpc('author.read', { include_tokens: true })).json();
  assert.equal(authors.find((a) => a.name === 'viewer@example.com').token, created.token);
  // ...but not by default, so pages that only need names never receive them
  const names = await (await rpc('author.read')).json();
  assert.ok(names.authors.length && names.authors.every((a) => a.token === undefined));
  await expectStatus(await rpc('author.read', { include_tokens: 'yes' }), 400);

  await expectStatus(await rpc('author.create', { name: 'viewer@example.com' }), 409); // names are unique
  for (const name of ['', '   ', 'x'.repeat(201), 7]) await expectStatus(await rpc('author.create', { name }), 400, String(name));

  // using the token records last_used
  const old = { Authorization: `Bearer ${created.token}` };
  await expectStatus(await rpc('qr.read', {}, old), 200);
  await new Promise((res) => setTimeout(res, 300));
  assert.ok((await (await rpc('author.read', { name: 'viewer@example.com' })).json()).last_used > 0);

  // rotating issues a new token; the old one stops working at once
  const rotated = await (await rpc('author.update', { name: 'viewer@example.com', rotate_token: true })).json();
  assert.notEqual(rotated.token, created.token);
  await expectStatus(await rpc('qr.read', {}, old), 401);
  await expectStatus(await rpc('qr.read', {}, { Authorization: `Bearer ${rotated.token}` }), 200);
  await expectStatus(await rpc('author.update', { name: 'viewer@example.com' }), 400); // nothing to change
  await expectStatus(await rpc('author.update', { name: 'nobody', rotate_token: true }), 404);

  // deleting revokes the token
  await expectStatus(await rpc('author.delete', { name: 'viewer@example.com' }), 200);
  await expectStatus(await rpc('qr.read', {}, { Authorization: `Bearer ${rotated.token}` }), 401);
  await expectStatus(await rpc('author.delete', { name: 'viewer@example.com' }), 404);
});

test('renaming an author takes their codes along, so their token still reaches them', async () => {
  const k = await authorKey('old-name');
  const { id } = await (await rpc('qr.create', { name: 'Theirs', text: 'x', svg: SVG, author: 'old-name' })).json();
  await (await rpc('author.create', { name: 'taken' })).arrayBuffer();
  await expectStatus(await rpc('author.update', { name: 'old-name', new_name: 'taken' }), 409);
  const renamed = await (await rpc('author.update', { name: 'old-name', new_name: 'new-name' })).json();
  assert.equal(renamed.name, 'new-name');
  assert.equal(renamed.codes, 1);
  assert.equal((await (await rpc('qr.read', { id })).json()).author, 'new-name');
  const { designs } = await (await rpc('qr.read', {}, k)).json(); // same token, renamed author
  assert.deepEqual(designs.map((d) => d.id), [id]);
});

test('an author token only reaches its own codes, and cannot create or move them', async () => {
  const keyA = await authorKey('author-a');
  const a = await (await rpc('qr.create', { name: 'Author A', text: 'x', svg: SVG, author: 'author-a' })).json();
  const b = await (await rpc('qr.create', { name: 'Author B', text: 'x', svg: SVG, author: 'author-b' })).json();

  const { designs } = await (await rpc('qr.read', {}, keyA)).json(); // no author param needed
  assert.deepEqual(designs.map((d) => d.id), [a.id]);
  assert.equal((await (await rpc('qr.read', { id: a.id }, keyA)).json()).svg, SVG);
  assert.equal(await (await rpc('qr.read', { id: a.id, format: 'svg' }, keyA)).text(), SVG);
  await expectStatus(await rpc('qr.read', { author: 'author-a' }, keyA), 200); // naming itself is fine
  await expectStatus(await rpc('qr.read', { author: 'author-b' }, keyA), 403); // naming another isn't

  // another author's code looks like it doesn't exist
  await expectStatus(await rpc('qr.read', { id: b.id }, keyA), 404);
  await expectStatus(await rpc('qr.read', { id: b.id, format: 'svg' }, keyA), 404);
  await expectStatus(await rpc('qr.update', { id: b.id, name: 'Hijacked' }, keyA), 404);
  await expectStatus(await rpc('qr.delete', { id: b.id }, keyA), 404);
  assert.equal((await (await rpc('qr.read', { id: b.id })).json()).name, 'Author B');

  // its own codes: rename, replace, delete
  assert.equal((await (await rpc('qr.update', { id: a.id, name: 'A2', details: 'via API' }, keyA)).json()).name, 'A2');
  await expectStatus(await rpc('qr.update', { id: a.id, text: 'y', svg: SVG.replace('#000', '#222') }, keyA), 200);
  await expectStatus(await rpc('qr.update', { id: a.id, new_author: 'author-b' }, keyA), 403);
  await expectStatus(await rpc('qr.create', { name: 'x', text: 'x', svg: SVG, author: 'author-a' }, keyA), 403);
  for (const m of ['author.create', 'author.read', 'author.update', 'author.delete', 'spec.read']) {
    await expectStatus(await rpc(m, { name: 'author-a' }, keyA), 403, m);
  }
  await expectStatus(await rpc('qr.delete', { id: a.id }, keyA), 200);
  await expectStatus(await rpc('qr.read', { id: a.id }), 404);
});

test('an author token reads and repoints only its own links, nothing else', async () => {
  const k = await authorKey('link-user');
  const link = await (await rpc('link.create', { url: 'https://dancewithb.fun/check-in?events=1', author: 'link-user' })).json();
  assert.equal(link.author, 'link-user');
  const other = await (await rpc('link.create', { url: 'https://example.com/someone-elses' })).json();

  const { links } = await (await rpc('link.read', {}, k)).json();
  assert.deepEqual(links.map((l) => l.code), [link.code]);
  // someone else's link looks like it doesn't exist, and can't be repointed
  await expectStatus(await rpc('link.read', { code: other.code }, k), 404);
  await expectStatus(await rpc('link.update', { code: other.code, url: 'https://phish.example/' }, k), 404);
  assert.equal((await (await rpc('link.read', { code: other.code })).json()).url, 'https://example.com/someone-elses');
  await expectStatus(await rpc('link.update', { code: link.code, new_author: 'someone' }, k), 403);
  await expectStatus(await rpc('link.read', { author: 'someone' }, k), 403);
  assert.equal((await (await rpc('link.read', { code: link.code }, k)).json()).url, 'https://dancewithb.fun/check-in?events=1');
  const r = await rpc('link.update', { code: link.code, url: 'https://dancewithb.fun/check-in?events=2' }, k);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).url, 'https://dancewithb.fun/check-in?events=2');
  const go = await call(`/c/${link.code}`);
  assert.equal(go.headers.get('location'), 'https://dancewithb.fun/check-in?events=2#');
  await go.arrayBuffer();

  await expectStatus(await rpc('link.create', { url: 'https://example.com/' }, k), 403);
  await expectStatus(await rpc('link.delete', { code: link.code }, k), 403);
  for (const t of ['qra_' + 'A'.repeat(43), 'qra_', 'api-key-457']) await expectStatus(await rpc('link.read', {}, { Authorization: `Bearer ${t}` }), 401, t);
  // tokens belong to one worker's database
  await expectStatus(await rpc('link.read', {}, k, wBase), 401);
});

test('spec.read: the API specification, admin only, covering every method', async () => {
  await expectStatus(await rpc('spec.read', {}, {}), 401);
  const spec = await (await call('/api/spec.read', { headers: auth })).json(); // GET works too
  const names = spec.methods.map((m) => m.name);
  assert.deepEqual(names, ['link.create', 'link.read', 'link.update', 'link.delete', 'qr.create', 'qr.read', 'qr.update', 'qr.delete',
    'author.create', 'author.read', 'author.update', 'author.delete', 'spec.read']);
  for (const m of spec.methods) {
    assert.ok(m.summary && m.returns && Array.isArray(m.params), `${m.name} is documented`);
    assert.ok(m.params.every((p) => p.name && p.type && p.desc), `${m.name} params are documented`);
  }
  // who may call what comes from the enforced method table
  const roles = Object.fromEntries(spec.methods.map((m) => [m.name, m.roles.join(',')]));
  assert.equal(roles['link.create'], 'admin');
  assert.equal(roles['qr.update'], 'admin,author');
  assert.equal(roles['author.read'], 'admin');
  assert.deepEqual(spec.methods.find((m) => m.name === 'qr.read').verbs, ['GET', 'POST']);
  assert.deepEqual(spec.methods.find((m) => m.name === 'qr.delete').verbs, ['POST']);
  assert.ok(spec.errors.some((e) => e.status === 409));
});

test('qr.* SVGs: only what the generator writes is accepted', async () => {
  const ok = [
    SVG,
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 41 41" width="1024" height="1024" shape-rendering="geometricPrecision"><g fill="#e8365d"><circle cx="4.5" cy="4.5" r="0.45"/><path fill-rule="evenodd" d="M4 4h7v7h-7ZM5 5h5v5h-5Z"/><rect x="-0.01" y="4" width="1.02" height="1.02" rx="0.3"/></g></svg>',
  ];
  for (const svg of ok) await expectStatus(await rpc('qr.create', { name: 'ok', text: 'x', svg }), 201, svg.slice(0, 60));
  const bad = [
    SVG.replace('</g>', '<img/src/onerror=alert(1)></g>'),        // slash-separated handler
    SVG.replace('</g>', '<style>*{background:url(x)}</style></g>'),
    SVG.replace('</g>', 'text outside tags</g>'),
    SVG.replace('fill="#000"', 'fill="url(javascript:alert(1))"'),
    SVG.replace('<rect ', '<rect onclick="x" '),
    SVG.replace('<rect ', '<rect style="x:y" '),
    SVG.replace('</g>', '<use href="#a"/></g>'),
    SVG.replace('</g>', '<!-- x --></g>'),
    SVG.replace('</g>', '<![CDATA[x]]></g>'),
    SVG + SVG,                                                     // two documents
    SVG.replace('</svg>', ''),                                    // unclosed
    SVG.replace('<g fill="#000">', '<g fill="#000"><svg>'),      // nested svg
    SVG.replace('xmlns="http://www.w3.org/2000/svg"', 'xmlns="http://example.com/"'),
    "<svg xmlns='http://www.w3.org/2000/svg'></svg>",              // single quotes aren't what we write
  ];
  for (const svg of bad) await expectStatus(await rpc('qr.create', { name: 'x', text: 'x', svg }), 400, svg.slice(0, 90));
  // the same rules apply when an author token replaces a code
  const k = await authorKey('svg-author');
  const { id } = await (await rpc('qr.create', { name: 'mine', text: 'x', svg: SVG, author: 'svg-author' })).json();
  await expectStatus(await rpc('qr.update', { id, text: 'y', svg: bad[0] }, k), 400);
});

test('authors cannot silently take over codes and links already carrying their name', async () => {
  await (await rpc('qr.create', { name: 'Left behind', text: 'x', svg: SVG, author: 'bob' })).arrayBuffer();
  await (await rpc('link.create', { url: 'https://example.com/bobs', author: 'bob' })).arrayBuffer();
  let r = await rpc('author.create', { name: 'bob' });
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /1 saved code\(s\) and 1 link\(s\).*adopt_existing/);
  await (await rpc('author.create', { name: 'alice' })).arrayBuffer();
  await expectStatus(await rpc('author.update', { name: 'alice', new_name: 'bob' }), 409);
  // with consent, the token gets them
  r = await rpc('author.create', { name: 'bob', adopt_existing: true });
  assert.equal(r.status, 201);
  const bob = await r.json();
  assert.equal(bob.codes, 1);
  assert.equal(bob.links, 1);
  const { designs } = await (await rpc('qr.read', {}, { Authorization: `Bearer ${bob.token}` })).json();
  assert.deepEqual(designs.map((d) => d.name), ['Left behind']);
  await expectStatus(await rpc('author.create', { name: 'carol', adopt_existing: 'yes' }), 400);
});

test('a destination may not loop back to a short link on any of our hosts', async () => {
  // wBase's PUBLIC_BASE_URL is https://dancewithb.fun: links made through 127.0.0.1 can't point there either
  for (const url of ['https://dancewithb.fun/c/a', 'https://dancewithb.fun/C/a', `${wBase.base}/c/a`]) {
    await expectStatus(await rpc('link.create', { url }, auth, wBase), 400, url);
  }
  await expectStatus(await rpc('link.create', { url: 'https://dancewithb.fun/check-in' }, auth, wBase), 201);
});

test('every SVG the generator writes passes the save-time allowlist', () => {
  const link = 'https://qr.dancewithb.fun/c/a';
  for (const version of [pickFragmentVersion(link, 3, 1, 8), 8]) {
    const plan = planFragment({ image: pinkLogo(), threshold: 0.65, deadzone: 0.1, link, ecl: 3, version, strength: 0.6 });
    for (const shape of ['dots', 'rounded', 'squares', 'connected'])
      for (const eyes of ['square', 'rounded', 'dot'])
        for (const style of [{}, { tintLight: true, maxLum: 0.56, lightLum: 0.78 }, { keepColors: false }, { bg: null }, { dotStructure: false }]) {
          const svg = toSVG(buildShapes(plan, { shape, eyes, ...style }));
          assert.doesNotThrow(() => parseSvg(svg), `v${version} ${shape}/${eyes}/${JSON.stringify(style)}`);
        }
  }
});
