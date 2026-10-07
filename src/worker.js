// Short-link redirect Worker.
//
//   GET  /c/<code>            302 to the stored destination (public)
//   POST /api/links           create   {url, label?}            (admin)
//   GET  /api/links           list                               (admin)
//   PATCH /api/links/<code>   update   {url?, label?}            (admin)
//   DELETE /api/links/<code>  delete                             (admin)
//   POST /api/designs         save a generated QR design          (admin)
//   GET  /api/designs         list saved designs (no SVG)          (admin)
//   GET  /api/designs/<id>    one design, with its SVG             (admin)
//   PATCH /api/designs/<id>   rename / edit details                (admin)
//   DELETE /api/designs/<id>  delete                               (admin)
//
// Everything else is served from the static assets (see wrangler.jsonc: the
// Worker only runs for /c/* and /api/*, so the site itself stays free of
// per-request Worker invocations).
//
// Codes are the row id written in bijective base 36 over a-z then 0-9:
//   1 -> a, 26 -> z, 27 -> 0, 36 -> 9, 37 -> aa, 38 -> ab, ...
// so a character is added after "9" (-> "aa") and again after "99" (-> "aaa").
// Ids come from an AUTOINCREMENT column, which D1 assigns atomically, and
// they are never reused after a delete.

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const BASE = ALPHABET.length;
const MAX_CODE_LENGTH = 9; // 36^9 < 2^53, so ids stay exact
const MAX_URL_LENGTH = 2048;
const MAX_LABEL_LENGTH = 100;
const MAX_BODY_BYTES = 8 * 1024;
const MAX_DESIGN_BODY_BYTES = 1_600_000; // D1 rows top out around 2 MB
const MAX_SVG_LENGTH = 1_500_000;
const MAX_NAME_LENGTH = 100;
const MAX_DETAILS_LENGTH = 2000;
const MAX_TEXT_LENGTH = 4296; // largest QR payload
const MAX_META_LENGTH = 16 * 1024;

// ---------------------------------------------------------------- codes

/** id (1, 2, 3, ...) -> "a", "b", ..., "z", "0", ..., "9", "aa", "ab", ... */
export function encodeId(id) {
  if (!Number.isSafeInteger(id) || id < 1) throw new RangeError('id must be a positive integer');
  let code = '';
  for (let n = id; n > 0; n = Math.floor(n / BASE)) {
    n -= 1;
    code = ALPHABET[n % BASE] + code;
  }
  return code;
}

/** Inverse of encodeId; returns null for anything that is not a valid code. */
export function decodeCode(code) {
  if (typeof code !== 'string' || !/^[a-z0-9]+$/.test(code) || code.length > MAX_CODE_LENGTH) return null;
  let id = 0;
  for (const ch of code) id = id * BASE + ALPHABET.indexOf(ch) + 1;
  return id;
}

// ---------------------------------------------------------------- helpers

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });

const notFound = () =>
  new Response('Link not found', {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });

/** Constant-time string comparison (via fixed-length digests). */
async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const x = new Uint8Array(da), y = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/** @returns {Promise<Response|null>} an error response, or null when authorised */
async function requireAdmin(request, env) {
  if (!env.ADMIN_TOKEN) return json({ error: 'ADMIN_TOKEN is not configured on this Worker' }, 503);
  const m = /^Bearer\s+(.+)$/.exec(request.headers.get('Authorization') || '');
  if (!m || !(await safeEqual(m[1].trim(), env.ADMIN_TOKEN))) {
    return json({ error: 'Unauthorized' }, 401, { 'WWW-Authenticate': 'Bearer' });
  }
  return null;
}

async function readJson(request, maxBytes = MAX_BODY_BYTES) {
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > maxBytes) throw new HttpError(413, 'Request body too large');
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, 'Request body too large');
  try {
    const body = JSON.parse(text || '{}');
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw new HttpError(400, 'Body must be a JSON object');
  }
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function parseDestination(value, requestUrl) {
  if (typeof value !== 'string') throw new HttpError(400, '"url" must be a string');
  const raw = value.trim();
  if (!raw || raw.length > MAX_URL_LENGTH) throw new HttpError(400, `"url" must be 1-${MAX_URL_LENGTH} characters`);
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new HttpError(400, '"url" must be an absolute URL, e.g. https://example.com/page');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new HttpError(400, '"url" must start with http:// or https://');
  if (u.host === requestUrl.host && /^\/c(\/|$)/.test(u.pathname)) throw new HttpError(400, '"url" must not point back at a short link');
  return u.href;
}

function parseLabel(value) {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > MAX_LABEL_LENGTH) throw new HttpError(400, `"label" must be a string of at most ${MAX_LABEL_LENGTH} characters`);
  return value.trim();
}

function parseText(value, field, max, { required = true } = {}) {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string') throw new HttpError(400, `"${field}" must be a string`);
  const v = value.trim();
  if ((required && !v) || v.length > max) throw new HttpError(400, `"${field}" must be ${required ? '1' : '0'}-${max} characters`);
  return v;
}

/** Saved SVGs come from our own renderer; refuse anything that could carry script. */
function parseSvg(value) {
  if (typeof value !== 'string' || value.length > MAX_SVG_LENGTH) throw new HttpError(400, `"svg" must be a string of at most ${MAX_SVG_LENGTH} characters`);
  const v = value.trim();
  if (!/^<svg[\s>]/i.test(v) || !/<\/svg>$/i.test(v)) throw new HttpError(400, '"svg" must be a single <svg> document');
  if (/<script|<foreignObject|\son[a-z]+\s*=|javascript:|<!ENTITY|xlink:href|\shref\s*=/i.test(v)) throw new HttpError(400, '"svg" contains disallowed content');
  return v;
}

function parseMeta(value) {
  if (value === undefined) return '{}';
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, '"meta" must be an object');
  const v = JSON.stringify(value);
  if (v.length > MAX_META_LENGTH) throw new HttpError(400, '"meta" is too large');
  return v;
}

/** If the encoded text is one of our short links (fragment allowed), its id. */
function linkIdFor(text, request, env) {
  let u;
  try { u = new URL(text); } catch { return null; }
  const hosts = new Set([new URL(request.url).host]);
  if (env.PUBLIC_BASE_URL) { try { hosts.add(new URL(env.PUBLIC_BASE_URL).host); } catch { /* ignore */ } }
  const m = /^\/c\/([A-Za-z0-9]+)\/?$/.exec(u.pathname);
  return m && hosts.has(u.host) ? decodeCode(m[1].toLowerCase()) : null;
}

// ---------------------------------------------------------------- storage

let schemaReady = null;
/** Creates the tables on first use, so deploying needs no separate migration step. */
function ensureSchema(db) {
  schemaReady ??= db
    .batch([
      db.prepare(
        `CREATE TABLE IF NOT EXISTS links (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           url TEXT NOT NULL,
           label TEXT NOT NULL DEFAULT '',
           created_at INTEGER NOT NULL,
           hits INTEGER NOT NULL DEFAULT 0,
           last_hit INTEGER
         )`,
      ),
      db.prepare(
        `CREATE TABLE IF NOT EXISTS designs (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           name TEXT NOT NULL,
           details TEXT NOT NULL DEFAULT '',
           text TEXT NOT NULL,
           link_id INTEGER,
           svg TEXT NOT NULL,
           meta TEXT NOT NULL DEFAULT '{}',
           created_at INTEGER NOT NULL
         )`,
      ),
    ])
    .catch((e) => {
      schemaReady = null;
      throw e;
    });
  return schemaReady;
}

function publicBase(request, env) {
  return (env.PUBLIC_BASE_URL || new URL(request.url).origin).replace(/\/+$/, '');
}

function present(row, base) {
  const code = encodeId(row.id);
  return {
    code,
    short: `${base}/c/${code}`,
    url: row.url,
    label: row.label,
    hits: row.hits ?? 0,
    created_at: row.created_at,
    last_hit: row.last_hit ?? null,
  };
}

function presentDesign(row, base, { withSvg = false } = {}) {
  let meta = {};
  try { meta = JSON.parse(row.meta || '{}'); } catch { /* keep {} */ }
  const out = {
    id: row.id,
    name: row.name,
    details: row.details,
    text: row.text,
    link: row.link_id ? { code: encodeId(row.link_id), short: `${base}/c/${encodeId(row.link_id)}`, url: row.link_url ?? null } : null,
    meta,
    created_at: row.created_at,
  };
  if (withSvg) out.svg = row.svg;
  return out;
}

// ---------------------------------------------------------------- routes

async function redirect(request, env, ctx, rawCode) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
  const id = decodeCode(rawCode.toLowerCase());
  if (id === null) return notFound();
  await ensureSchema(env.DB);
  const row = await env.DB.prepare('SELECT url FROM links WHERE id = ?').bind(id).first();
  if (!row) return notFound();
  if (request.method === 'GET') {
    ctx.waitUntil(
      env.DB.prepare('UPDATE links SET hits = hits + 1, last_hit = ? WHERE id = ?')
        .bind(Math.floor(Date.now() / 1000), id)
        .run()
        .catch((e) => console.error('hit counter failed', e)),
    );
  }
  // 302 (not 301): destinations can be edited later, so browsers must not cache it.
  // Browsers copy the request's #fragment onto a redirect target that has none;
  // QR codes use the fragment to shape their pattern, so give the target an
  // explicit (empty) fragment to stop that junk reaching the destination page.
  const location = row.url.includes('#') ? row.url : `${row.url}#`;
  return new Response(null, {
    status: 302,
    headers: { Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
  });
}

async function designsApi(request, env, url, base, rawId) {
  const db = env.DB;
  const select = `SELECT d.id, d.name, d.details, d.text, d.link_id, d.meta, d.created_at, l.url AS link_url %SVG%
                  FROM designs d LEFT JOIN links l ON l.id = d.link_id`;
  if (rawId === undefined) {
    if (request.method === 'POST') {
      const body = await readJson(request, MAX_DESIGN_BODY_BYTES);
      const name = parseText(body.name, 'name', MAX_NAME_LENGTH);
      const details = parseText(body.details, 'details', MAX_DETAILS_LENGTH, { required: false });
      const text = parseText(body.text, 'text', MAX_TEXT_LENGTH);
      const svg = parseSvg(body.svg);
      const meta = parseMeta(body.meta);
      const { id } = await db.prepare('INSERT INTO designs (name, details, text, link_id, svg, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id')
        .bind(name, details, text, linkIdFor(text, request, env), svg, meta, Math.floor(Date.now() / 1000))
        .first();
      const row = await db.prepare(`${select.replace('%SVG%', '')} WHERE d.id = ?`).bind(id).first();
      return json(presentDesign(row, base), 201);
    }
    if (request.method === 'GET') {
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 100));
      const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
      const { results } = await db.prepare(`${select.replace('%SVG%', '')} ORDER BY d.id DESC LIMIT ? OFFSET ?`).bind(limit, offset).all();
      return json({ designs: results.map((r) => presentDesign(r, base)) });
    }
    return json({ error: 'Method not allowed' }, 405, { Allow: 'GET, POST' });
  }

  const id = /^[1-9][0-9]{0,15}$/.test(rawId) ? Number(rawId) : null;
  if (!id) return json({ error: 'Not found' }, 404);
  if (request.method === 'GET') {
    const row = await db.prepare(`${select.replace('%SVG%', ', d.svg')} WHERE d.id = ?`).bind(id).first();
    return row ? json(presentDesign(row, base, { withSvg: true })) : json({ error: 'Not found' }, 404);
  }
  if (request.method === 'PATCH') {
    const body = await readJson(request);
    const sets = [];
    const args = [];
    if (body.name !== undefined) { sets.push('name = ?'); args.push(parseText(body.name, 'name', MAX_NAME_LENGTH)); }
    if (body.details !== undefined) { sets.push('details = ?'); args.push(parseText(body.details, 'details', MAX_DETAILS_LENGTH, { required: false })); }
    if (!sets.length) throw new HttpError(400, 'Nothing to update: send "name" and/or "details"');
    const res = await db.prepare(`UPDATE designs SET ${sets.join(', ')} WHERE id = ?`).bind(...args, id).run();
    if (!res.meta?.changes) return json({ error: 'Not found' }, 404);
    const row = await db.prepare(`${select.replace('%SVG%', '')} WHERE d.id = ?`).bind(id).first();
    return json(presentDesign(row, base));
  }
  if (request.method === 'DELETE') {
    const res = await db.prepare('DELETE FROM designs WHERE id = ?').bind(id).run();
    return res.meta?.changes ? json({ deleted: id }) : json({ error: 'Not found' }, 404);
  }
  return json({ error: 'Method not allowed' }, 405, { Allow: 'GET, PATCH, DELETE' });
}

async function api(request, env, url) {
  const denied = await requireAdmin(request, env);
  if (denied) return denied;
  await ensureSchema(env.DB);
  const base = publicBase(request, env);
  const d = /^\/api\/designs(?:\/([^/]+))?\/?$/.exec(url.pathname);
  if (d) return designsApi(request, env, url, base, d[1]);
  const m = /^\/api\/links(?:\/([A-Za-z0-9]+))?\/?$/.exec(url.pathname);
  if (!m) return json({ error: 'Not found' }, 404);
  const code = m[1];

  if (!code) {
    if (request.method === 'POST') {
      const body = await readJson(request);
      const dest = parseDestination(body.url, url);
      const label = parseLabel(body.label);
      const row = await env.DB.prepare('INSERT INTO links (url, label, created_at) VALUES (?, ?, ?) RETURNING id, url, label, created_at, hits, last_hit')
        .bind(dest, label, Math.floor(Date.now() / 1000))
        .first();
      return json(present(row, base), 201);
    }
    if (request.method === 'GET') {
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 100));
      const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
      const { results } = await env.DB.prepare('SELECT id, url, label, created_at, hits, last_hit FROM links ORDER BY id DESC LIMIT ? OFFSET ?')
        .bind(limit, offset)
        .all();
      return json({ links: results.map((r) => present(r, base)) });
    }
    return json({ error: 'Method not allowed' }, 405, { Allow: 'GET, POST' });
  }

  const id = decodeCode(code.toLowerCase());
  if (id === null) return json({ error: 'Not found' }, 404);

  if (request.method === 'PATCH') {
    const body = await readJson(request);
    const sets = [];
    const args = [];
    if (body.url !== undefined) { sets.push('url = ?'); args.push(parseDestination(body.url, url)); }
    if (body.label !== undefined) { sets.push('label = ?'); args.push(parseLabel(body.label)); }
    if (!sets.length) throw new HttpError(400, 'Nothing to update: send "url" and/or "label"');
    const row = await env.DB.prepare(`UPDATE links SET ${sets.join(', ')} WHERE id = ? RETURNING id, url, label, created_at, hits, last_hit`)
      .bind(...args, id)
      .first();
    return row ? json(present(row, base)) : json({ error: 'Not found' }, 404);
  }
  if (request.method === 'DELETE') {
    const res = await env.DB.prepare('DELETE FROM links WHERE id = ?').bind(id).run();
    return res.meta?.changes ? json({ deleted: encodeId(id) }) : json({ error: 'Not found' }, 404);
  }
  return json({ error: 'Method not allowed' }, 405, { Allow: 'PATCH, DELETE' });
}

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const short = /^\/c\/([A-Za-z0-9]+)\/?$/.exec(url.pathname);
      if (short) return await redirect(request, env, ctx, short[1]);
      if (url.pathname.startsWith('/c/') || url.pathname === '/c') return notFound();
      if (url.pathname.startsWith('/api/')) return await api(request, env, url);
      return env.ASSETS ? env.ASSETS.fetch(request) : notFound();
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: 'Internal error' }, 500);
    }
  },
};
