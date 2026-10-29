// Short-link redirect Worker and API.
//
//   GET /c/<code>   302 to the stored destination (public)
//
// The API is a set of named methods, <domain>.<create|read|update|delete>,
// called as POST /api/<method> with a JSON body (read methods also accept
// GET /api/<method>?<params>). Anything that isn't plain CRUD hangs off the
// closest method: listing is a read without an id, the raw SVG is a read with
// format "svg".
//
//   link.create  {url, label?, author?}                           admin
//   link.read    {code} -> one link | {author?, limit?, offset?} -> list
//                                                                 admin, author*
//   link.update  {code, url?, label?, new_author?}                admin, author*
//   link.delete  {code}                                           admin
//   qr.create    {name, text, svg, details?, author?, meta?, image?}  admin
//   qr.read      {id, format?: "json"|"svg"} -> one design (with svg and logo)
//                {author?, limit?, offset?} -> list (no svg)       admin, author*
//   qr.update    {id, name?, details?, text + svg?, meta?, image?, new_author?}
//                                                                 admin, author*
//   qr.delete    {id}                                             admin, author*
//   * an author token only ever sees its own author's links and designs; it
//     can't create them or move them to another author.
//   author.create {name, adopt_existing?} -> the author with a new token  admin
//   author.read   {name} -> one author with token |
//                 {include_tokens?} -> list                         admin
//   author.update {name, new_name?, rotate_token?, adopt_existing?} admin
//   author.delete {name}                                          admin
//   spec.read    {} -> this API's specification (see spec.js)       admin
//
// Everything else is served from the static assets (see wrangler.jsonc: the
// Worker only runs for /c/* and /api/*, so the site itself stays free of
// per-request Worker invocations).
//
// Auth: Authorization: Bearer <token>. ADMIN_TOKEN (a Wrangler secret) can do
// everything. Author tokens are made with author.create, one per author, for
// other projects' servers; each is limited to its own author as above. They
// are stored so the admin can view them again later (author.read), and can be
// rotated or revoked.
//
// Codes are the row id written in bijective base 36 over a-z then 0-9:
//   1 -> a, 26 -> z, 27 -> 0, 36 -> 9, 37 -> aa, 38 -> ab, ...
// so a character is added after "9" (-> "aa") and again after "99" (-> "aaa").
// Ids come from an AUTOINCREMENT column, which D1 assigns atomically, and
// they are never reused after a delete.

import { buildSpec } from './spec.js';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const BASE = ALPHABET.length;
const MAX_CODE_LENGTH = 9; // 36^9 < 2^53, so ids stay exact
const MAX_URL_LENGTH = 2048;
const MAX_LABEL_LENGTH = 100;
const MAX_BODY_BYTES = 8 * 1024;
const MAX_DESIGN_BODY_BYTES = 1_900_000; // D1 rows top out around 2 MB
const MAX_SVG_LENGTH = 1_500_000;
const MAX_NAME_LENGTH = 100;
const MAX_DETAILS_LENGTH = 2000;
const MAX_TEXT_LENGTH = 4296; // largest QR payload
const MAX_META_LENGTH = 16 * 1024;
const MAX_IMAGE_LENGTH = 300_000; // source logo, as a PNG data URL
const MAX_AUTHOR_LENGTH = 200;

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

const sha256Hex = async (text) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('');

/** A new author token: "qra_" + 32 random bytes, base64url. */
function newAuthorToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return 'qra_' + btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Who is calling: the admin (ADMIN_TOKEN) or an author (a token made by
 * author.create, looked up by its SHA-256 so the index holds no secrets).
 * @returns {Promise<{role: 'admin'} | {role: 'author', author: string} | Response>}
 */
async function authorize(request, env, ctx) {
  if (!env.ADMIN_TOKEN) return json({ error: 'ADMIN_TOKEN is not configured on this Worker' }, 503);
  const m = /^Bearer\s+(.+)$/.exec(request.headers.get('Authorization') || '');
  const given = m ? m[1].trim() : '';
  const unauthorized = () => json({ error: 'Unauthorized' }, 401, { 'WWW-Authenticate': 'Bearer' });
  if (!given) return unauthorized();
  if (await safeEqual(given, env.ADMIN_TOKEN)) return { role: 'admin' };
  if (!given.startsWith('qra_')) return unauthorized();
  await ensureSchema(env.DB);
  const hash = await sha256Hex(given);
  const row = await env.DB.prepare('SELECT name, last_used FROM authors WHERE token_hash = ?').bind(hash).first();
  if (!row) return unauthorized();
  // Record use at most hourly: a project polling the API shouldn't cost a write per request.
  const now = Math.floor(Date.now() / 1000);
  if (!row.last_used || now - row.last_used > 3600) {
    ctx?.waitUntil(
      env.DB.prepare('UPDATE authors SET last_used = ? WHERE token_hash = ?').bind(now, hash).run()
        .catch((e) => console.error('last_used update failed', e)),
    );
  }
  return { role: 'author', author: row.name };
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

/** Hosts our short links are served from: this request's, plus PUBLIC_BASE_URL's. */
function shortLinkHosts(request, env) {
  const hosts = new Set([new URL(request.url).host]);
  if (env.PUBLIC_BASE_URL) { try { hosts.add(new URL(env.PUBLIC_BASE_URL).host); } catch { /* ignore */ } }
  return hosts;
}

function parseDestination(value, hosts) {
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
  if (hosts.has(u.host) && /^\/c(\/|$)/i.test(u.pathname)) throw new HttpError(400, '"url" must not point back at a short link');
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

// Saved SVGs come from our own renderer (render.js toSVG), so only what it
// writes is accepted: these elements and attributes, plain values, no text.
// An allowlist, because blocklists miss tricks like <img/src/onerror=…>.
const SVG_NUMBER = /^-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/;
const SVG_ELEMENTS = new Set(['svg', 'g', 'rect', 'circle', 'path']);
const SVG_ATTRIBUTES = {
  xmlns: /^http:\/\/www\.w3\.org\/2000\/svg$/,
  viewBox: /^[-\d. ,e]+$/,
  width: SVG_NUMBER, height: SVG_NUMBER, x: SVG_NUMBER, y: SVG_NUMBER, rx: SVG_NUMBER, ry: SVG_NUMBER,
  cx: SVG_NUMBER, cy: SVG_NUMBER, r: SVG_NUMBER,
  fill: /^(#[0-9a-fA-F]{3,8}|none)$/,
  'fill-rule': /^(evenodd|nonzero)$/,
  'shape-rendering': /^(auto|optimizeSpeed|crispEdges|geometricPrecision)$/,
  d: /^[MmLlHhVvAaZz\d\s,.eE+-]*$/,
};

export function parseSvg(value) {
  if (typeof value !== 'string' || value.length > MAX_SVG_LENGTH) throw new HttpError(400, `"svg" must be a string of at most ${MAX_SVG_LENGTH} characters`);
  const v = value.trim();
  const bad = (why) => new HttpError(400, `"svg" ${why}`);
  const tag = /\s*<(\/?)([A-Za-z][\w-]*)((?:\s+[\w:-]+="[^"]*")*)\s*(\/?)>/y;
  const stack = [];
  let roots = 0;
  for (let i = 0; i < v.length;) {
    tag.lastIndex = i;
    const m = tag.exec(v);
    if (!m) throw bad('may only contain the shapes the generator draws');
    i = tag.lastIndex;
    const [, close, name, attrs, selfClose] = m;
    if (!SVG_ELEMENTS.has(name)) throw bad(`must not contain <${name}>`);
    if (close) {
      if (attrs || selfClose || stack.pop() !== name) throw bad('has mismatched tags');
      continue;
    }
    if (!stack.length && (name !== 'svg' || roots++)) throw bad('must be a single <svg> document');
    if (stack.length && name === 'svg') throw bad('must not nest <svg>');
    for (const [, key, val] of attrs.matchAll(/\s+([\w:-]+)="([^"]*)"/g)) {
      if (!Object.hasOwn(SVG_ATTRIBUTES, key) || !SVG_ATTRIBUTES[key].test(val)) throw bad(`must not use the attribute ${key}="${val.slice(0, 40)}"`);
    }
    if (!selfClose) stack.push(name);
  }
  if (stack.length || !roots) throw bad('must be a single, complete <svg> document');
  return v;
}

/** The source logo, kept so a design can be regenerated: a base64 PNG data URL only. */
function parseImage(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > MAX_IMAGE_LENGTH || !/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(value))
    throw new HttpError(400, `"image" must be a PNG data URL of at most ${MAX_IMAGE_LENGTH} characters`);
  return value;
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
  const hosts = shortLinkHosts(request, env);
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
    // Added later: tables created before them get the columns here.
    .then(() => addColumn(db, 'designs', 'image TEXT'))
    .then(() => addColumn(db, 'designs', "author TEXT NOT NULL DEFAULT ''"))
    .then(() => addColumn(db, 'links', "author TEXT NOT NULL DEFAULT ''"))
    // Authors who may use the API, each with their own token. The token is kept
    // (not just its hash) because the admin wants to view it again later.
    .then(() => db.prepare(
      `CREATE TABLE IF NOT EXISTS authors (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         name TEXT NOT NULL UNIQUE,
         token TEXT NOT NULL,
         token_hash TEXT NOT NULL UNIQUE,
         created_at INTEGER NOT NULL,
         last_used INTEGER
       )`,
    ).run())
    .then(() => db.prepare('CREATE INDEX IF NOT EXISTS designs_author ON designs (author, id)').run())
    .catch((e) => {
      schemaReady = null;
      throw e;
    });
  return schemaReady;
}

function addColumn(db, table, column) {
  return db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column}`).run().catch((e) => {
    if (!/duplicate column/i.test(String(e?.message ?? e))) throw e;
  });
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
    author: row.author ?? '',
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
    author: row.author ?? '',
    text: row.text,
    link: row.link_id ? { code: encodeId(row.link_id), short: `${base}/c/${encodeId(row.link_id)}`, url: row.link_url ?? null } : null,
    meta,
    created_at: row.created_at,
  };
  if (withSvg) { out.svg = row.svg; out.image = row.image ?? null; }
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

// ---------------------------------------------------------------- API methods

const DESIGN_COLUMNS = 'd.id, d.name, d.details, d.author, d.text, d.link_id, d.meta, d.created_at, l.url AS link_url';
const LINK_COLUMNS = 'id, url, label, author, created_at, hits, last_hit';

function parsePage(p) {
  return {
    limit: Math.min(200, Math.max(1, Number(p.limit) || 100)),
    offset: Math.max(0, Number(p.offset) || 0),
  };
}

function parseLinkCode(value) {
  const id = typeof value === 'string' ? decodeCode(value.trim().toLowerCase()) : null;
  if (id === null) throw new HttpError(404, 'Not found');
  return id;
}

function parseDesignId(value) {
  const v = typeof value === 'number' ? String(value) : value;
  if (typeof v !== 'string' || !/^[1-9][0-9]{0,15}$/.test(v)) throw new HttpError(404, 'Not found');
  return Number(v);
}

/**
 * The author a qr.* call is limited to: an author token is always limited to
 * its own author (passing a different "author" is refused); the admin may
 * optionally filter by one.
 * @returns {string|null} null = all authors
 */
function authorScope(p, who) {
  if (who.role === 'author') {
    if (p.author !== undefined && p.author !== who.author) throw new HttpError(403, `This token belongs to author "${who.author}"`);
    return who.author;
  }
  return p.author === undefined ? null : parseText(p.author, 'author', MAX_AUTHOR_LENGTH, { required: false });
}

function presentAuthor(row, withToken = true) {
  return {
    name: row.name,
    ...(withToken ? { token: row.token } : {}),
    created_at: row.created_at,
    last_used: row.last_used ?? null,
    codes: row.codes ?? 0,
    links: row.links ?? 0,
  };
}

const AUTHOR_SELECT = 'SELECT a.name, a.token, a.created_at, a.last_used, (SELECT COUNT(*) FROM designs d WHERE d.author = a.name) AS codes, (SELECT COUNT(*) FROM links l WHERE l.author = a.name) AS links FROM authors a';
const parseAuthorName = (v, field = 'name') => parseText(v, field, MAX_AUTHOR_LENGTH);

/**
 * Refuse to give an author's token codes or links already labelled with that
 * name (left by a revoked author, or typed in the generator) unless the admin
 * says so with adopt_existing: true.
 */
async function guardAdoption(env, name, p) {
  if (p.adopt_existing !== undefined && typeof p.adopt_existing !== 'boolean') throw new HttpError(400, '"adopt_existing" must be true or false');
  if (p.adopt_existing) return;
  const { codes, links } = await env.DB.prepare(
    'SELECT (SELECT COUNT(*) FROM designs WHERE author = ?1) AS codes, (SELECT COUNT(*) FROM links WHERE author = ?1) AS links',
  ).bind(name).first();
  if (codes || links) {
    throw new HttpError(409, `${codes} saved code(s) and ${links} link(s) are already labelled "${name}". Send "adopt_existing": true to give them to this author's token.`);
  }
}

const authorCreate = async ({ env, p }) => {
  const name = parseAuthorName(p.name);
  if (await env.DB.prepare('SELECT 1 FROM authors WHERE name = ?').bind(name).first()) throw new HttpError(409, `An author named "${name}" already exists`);
  await guardAdoption(env, name, p);
  const token = newAuthorToken();
  try {
    await env.DB.prepare('INSERT INTO authors (name, token, token_hash, created_at) VALUES (?, ?, ?, ?)')
      .bind(name, token, await sha256Hex(token), Math.floor(Date.now() / 1000))
      .run();
  } catch (e) {
    if (/UNIQUE/i.test(String(e?.message ?? e))) throw new HttpError(409, `An author named "${name}" already exists`);
    throw e;
  }
  return json(presentAuthor(await env.DB.prepare(`${AUTHOR_SELECT} WHERE a.name = ?`).bind(name).first()), 201);
};

const authorRead = async ({ env, p }) => {
  if (p.name !== undefined) {
    const row = await env.DB.prepare(`${AUTHOR_SELECT} WHERE a.name = ?`).bind(parseAuthorName(p.name)).first();
    return row ? json(presentAuthor(row)) : json({ error: 'Not found' }, 404);
  }
  // Tokens only on request, so a page that just needs names doesn't receive them.
  if (p.include_tokens !== undefined && ![true, false, 'true', 'false'].includes(p.include_tokens)) throw new HttpError(400, '"include_tokens" must be true or false');
  const withTokens = p.include_tokens === true || p.include_tokens === 'true';
  const { results } = await env.DB.prepare(`${AUTHOR_SELECT} ORDER BY a.name COLLATE NOCASE`).all();
  return json({ authors: results.map((r) => presentAuthor(r, withTokens)) });
};

const authorUpdate = async ({ env, p }) => {
  const name = parseAuthorName(p.name);
  if (!(await env.DB.prepare('SELECT 1 FROM authors WHERE name = ?').bind(name).first())) return json({ error: 'Not found' }, 404);
  const newName = p.new_name === undefined ? name : parseAuthorName(p.new_name, 'new_name');
  if (p.rotate_token !== undefined && typeof p.rotate_token !== 'boolean') throw new HttpError(400, '"rotate_token" must be true or false');
  if (newName === name && !p.rotate_token) throw new HttpError(400, 'Nothing to update: send "new_name" and/or "rotate_token": true');
  if (newName !== name) {
    if (await env.DB.prepare('SELECT 1 FROM authors WHERE name = ?').bind(newName).first()) throw new HttpError(409, `An author named "${newName}" already exists`);
    await guardAdoption(env, newName, p);
  }
  const stmts = [];
  if (p.rotate_token) {
    const token = newAuthorToken();
    stmts.push(env.DB.prepare('UPDATE authors SET token = ?, token_hash = ?, last_used = NULL WHERE name = ?').bind(token, await sha256Hex(token), name));
  }
  if (newName !== name) {
    // The author's codes and links move with the rename, so the token keeps reaching them.
    stmts.push(env.DB.prepare('UPDATE authors SET name = ? WHERE name = ?').bind(newName, name));
    stmts.push(env.DB.prepare('UPDATE designs SET author = ? WHERE author = ?').bind(newName, name));
    stmts.push(env.DB.prepare('UPDATE links SET author = ? WHERE author = ?').bind(newName, name));
  }
  try {
    await env.DB.batch(stmts);
  } catch (e) {
    if (/UNIQUE/i.test(String(e?.message ?? e))) throw new HttpError(409, `An author named "${newName}" already exists`);
    throw e;
  }
  return json(presentAuthor(await env.DB.prepare(`${AUTHOR_SELECT} WHERE a.name = ?`).bind(newName).first()));
};

const authorDelete = async ({ env, p }) => {
  const name = parseAuthorName(p.name);
  const res = await env.DB.prepare('DELETE FROM authors WHERE name = ?').bind(name).run();
  // Their saved codes stay (still labelled with the name); only the token stops working.
  return res.meta?.changes ? json({ deleted: name }) : json({ error: 'Not found' }, 404);
};

/** SQL to limit a query to one author (or nothing, for all). */
const authorWhere = (author, column = 'author') => (author === null ? ['', []] : [` AND ${column} = ?`, [author]]);

const linkCreate = async ({ req, env, base, p }) => {
  const row = await env.DB.prepare(`INSERT INTO links (url, label, author, created_at) VALUES (?, ?, ?, ?) RETURNING ${LINK_COLUMNS}`)
    .bind(
      parseDestination(p.url, shortLinkHosts(req, env)), parseLabel(p.label),
      parseText(p.author, 'author', MAX_AUTHOR_LENGTH, { required: false }), Math.floor(Date.now() / 1000),
    )
    .first();
  return json(present(row, base), 201);
};

// Links belong to an author like designs do: an author token only reaches its own.
const linkRead = async ({ env, base, p, who }) => {
  const [scope, scopeArgs] = authorWhere(authorScope(p, who));
  if (p.code !== undefined) {
    const row = await env.DB.prepare(`SELECT ${LINK_COLUMNS} FROM links WHERE id = ?${scope}`).bind(parseLinkCode(p.code), ...scopeArgs).first();
    return row ? json(present(row, base)) : json({ error: 'Not found' }, 404);
  }
  const { limit, offset } = parsePage(p);
  const { results } = await env.DB.prepare(`SELECT ${LINK_COLUMNS} FROM links WHERE 1 = 1${scope} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .bind(...scopeArgs, limit, offset)
    .all();
  return json({ links: results.map((r) => present(r, base)) });
};

const linkUpdate = async ({ req, env, base, p, who }) => {
  const [scope, scopeArgs] = authorWhere(authorScope(p, who));
  const id = parseLinkCode(p.code);
  const sets = [];
  const args = [];
  if (p.url !== undefined) { sets.push('url = ?'); args.push(parseDestination(p.url, shortLinkHosts(req, env))); }
  if (p.label !== undefined) { sets.push('label = ?'); args.push(parseLabel(p.label)); }
  if (p.new_author !== undefined) {
    if (who.role === 'author') throw new HttpError(403, 'An author token cannot change a link\'s author');
    sets.push('author = ?'); args.push(parseText(p.new_author, 'new_author', MAX_AUTHOR_LENGTH, { required: false }));
  }
  if (!sets.length) throw new HttpError(400, 'Nothing to update: send "url", "label" and/or "new_author"');
  const row = await env.DB.prepare(`UPDATE links SET ${sets.join(', ')} WHERE id = ?${scope} RETURNING ${LINK_COLUMNS}`).bind(...args, id, ...scopeArgs).first();
  return row ? json(present(row, base)) : json({ error: 'Not found' }, 404);
};

const linkDelete = async ({ env, p }) => {
  const id = parseLinkCode(p.code);
  const res = await env.DB.prepare('DELETE FROM links WHERE id = ?').bind(id).run();
  return res.meta?.changes ? json({ deleted: encodeId(id) }) : json({ error: 'Not found' }, 404);
};

const fetchDesign = (db, id, author, extra = '') =>
  db.prepare(`SELECT ${DESIGN_COLUMNS}${extra} FROM designs d LEFT JOIN links l ON l.id = d.link_id WHERE d.id = ?${author === null ? '' : ' AND d.author = ?'}`)
    .bind(id, ...(author === null ? [] : [author]))
    .first();

const qrCreate = async ({ req, env, base, p }) => {
  const text = parseText(p.text, 'text', MAX_TEXT_LENGTH);
  const { id } = await env.DB.prepare('INSERT INTO designs (name, details, author, text, link_id, svg, meta, image, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id')
    .bind(
      parseText(p.name, 'name', MAX_NAME_LENGTH),
      parseText(p.details, 'details', MAX_DETAILS_LENGTH, { required: false }),
      parseText(p.author, 'author', MAX_AUTHOR_LENGTH, { required: false }),
      text, linkIdFor(text, req, env), parseSvg(p.svg), parseMeta(p.meta), parseImage(p.image), Math.floor(Date.now() / 1000),
    )
    .first();
  return json(presentDesign(await fetchDesign(env.DB, id, null), base), 201);
};

const qrRead = async ({ env, base, p, who }) => {
  const author = authorScope(p, who);
  if (p.id !== undefined) {
    const format = p.format ?? 'json';
    if (format !== 'json' && format !== 'svg') throw new HttpError(400, '"format" must be "json" or "svg"');
    const row = await fetchDesign(env.DB, parseDesignId(p.id), author, ', d.svg, d.image');
    if (!row) return json({ error: 'Not found' }, 404);
    if (format === 'json') return json(presentDesign(row, base, { withSvg: true }));
    // The raw image, for another project's server to inline or serve itself.
    return new Response(row.svg, {
      headers: {
        'Content-Type': 'image/svg+xml; charset=utf-8',
        'Cache-Control': 'private, max-age=300',
        'X-Content-Type-Options': 'nosniff',
        // Saved SVGs are validated on save; belt and braces if one is opened directly.
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      },
    });
  }
  const { limit, offset } = parsePage(p);
  const where = author === null ? '' : ' WHERE d.author = ?';
  const { results } = await env.DB.prepare(`SELECT ${DESIGN_COLUMNS} FROM designs d LEFT JOIN links l ON l.id = d.link_id${where} ORDER BY d.id DESC LIMIT ? OFFSET ?`)
    .bind(...(author === null ? [] : [author]), limit, offset)
    .all();
  return json({ designs: results.map((r) => presentDesign(r, base)) });
};

const qrUpdate = async ({ req, env, base, p, who }) => {
  const author = authorScope(p, who);
  const id = parseDesignId(p.id);
  const sets = [];
  const args = [];
  if (p.name !== undefined) { sets.push('name = ?'); args.push(parseText(p.name, 'name', MAX_NAME_LENGTH)); }
  if (p.details !== undefined) { sets.push('details = ?'); args.push(parseText(p.details, 'details', MAX_DETAILS_LENGTH, { required: false })); }
  if (p.new_author !== undefined) {
    // Moving a design to another author would take it out of the key's reach.
    if (who.role === 'author') throw new HttpError(403, 'An author token cannot change a design\'s author');
    sets.push('author = ?'); args.push(parseText(p.new_author, 'new_author', MAX_AUTHOR_LENGTH, { required: false }));
  }
  // Replacing the code itself (from the editor) sends text and svg together.
  if ((p.text === undefined) !== (p.svg === undefined)) throw new HttpError(400, 'Send "text" and "svg" together to replace the code');
  if (p.text !== undefined) {
    const text = parseText(p.text, 'text', MAX_TEXT_LENGTH);
    sets.push('text = ?', 'link_id = ?', 'svg = ?');
    args.push(text, linkIdFor(text, req, env), parseSvg(p.svg));
  }
  if (p.meta !== undefined) { sets.push('meta = ?'); args.push(parseMeta(p.meta)); }
  if (p.image !== undefined) { sets.push('image = ?'); args.push(parseImage(p.image)); }
  if (!sets.length) throw new HttpError(400, 'Nothing to update: send "name", "details", "new_author", "meta", "image", or "text" + "svg"');
  const scope = author === null ? ['', []] : [' AND author = ?', [author]];
  const res = await env.DB.prepare(`UPDATE designs SET ${sets.join(', ')} WHERE id = ?${scope[0]}`).bind(...args, id, ...scope[1]).run();
  if (!res.meta?.changes) return json({ error: 'Not found' }, 404);
  return json(presentDesign(await fetchDesign(env.DB, id, null), base));
};

const qrDelete = async ({ env, p, who }) => {
  const author = authorScope(p, who);
  const id = parseDesignId(p.id);
  const scope = author === null ? ['', []] : [' AND author = ?', [author]];
  const res = await env.DB.prepare(`DELETE FROM designs WHERE id = ?${scope[0]}`).bind(id, ...scope[1]).run();
  return res.meta?.changes ? json({ deleted: id }) : json({ error: 'Not found' }, 404);
};

/** read: callable with GET; big: accepts design-sized bodies. */
const METHODS = {
  'link.create': { roles: ['admin'], run: linkCreate },
  'link.read': { roles: ['admin', 'author'], read: true, run: linkRead },
  'link.update': { roles: ['admin', 'author'], run: linkUpdate },
  'link.delete': { roles: ['admin'], run: linkDelete },
  'qr.create': { roles: ['admin'], big: true, run: qrCreate },
  'qr.read': { roles: ['admin', 'author'], read: true, run: qrRead },
  'qr.update': { roles: ['admin', 'author'], big: true, run: qrUpdate },
  'qr.delete': { roles: ['admin', 'author'], run: qrDelete },
  'author.create': { roles: ['admin'], run: authorCreate },
  'author.read': { roles: ['admin'], read: true, run: authorRead },
  'author.update': { roles: ['admin'], run: authorUpdate },
  'author.delete': { roles: ['admin'], run: authorDelete },
  'spec.read': { roles: ['admin'], read: true, run: ({ base }) => json(buildSpec(METHODS, base)) },
};

async function api(request, env, url, ctx) {
  const name = /^\/api\/([a-z]+\.[a-z]+)\/?$/.exec(url.pathname)?.[1];
  const method = name && Object.hasOwn(METHODS, name) ? METHODS[name] : null;
  if (!method) return json({ error: `Unknown method. Use one of: ${Object.keys(METHODS).join(', ')}` }, 404);
  const verbs = method.read ? 'GET, POST' : 'POST';
  if (request.method !== 'POST' && !(method.read && request.method === 'GET')) return json({ error: `${name} takes ${verbs}` }, 405, { Allow: verbs });
  const who = await authorize(request, env, ctx);
  if (who instanceof Response) return who;
  if (!method.roles.includes(who.role)) return json({ error: `An author token cannot call ${name}` }, 403);
  const p = request.method === 'GET'
    ? Object.fromEntries(url.searchParams)
    : await readJson(request, method.big ? MAX_DESIGN_BODY_BYTES : MAX_BODY_BYTES);
  await ensureSchema(env.DB);
  return method.run({ req: request, env, url, base: publicBase(request, env), p, who });
}

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const short = /^\/c\/([A-Za-z0-9]+)\/?$/.exec(url.pathname);
      if (short) return await redirect(request, env, ctx, short[1]);
      if (url.pathname.startsWith('/c/') || url.pathname === '/c') return notFound();
      if (url.pathname.startsWith('/api/')) return await api(request, env, url, ctx);
      return env.ASSETS ? env.ASSETS.fetch(request) : notFound();
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: 'Internal error' }, 500);
    }
  },
};
