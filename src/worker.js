// Short-link redirect Worker and API.
//
//   GET /c/<code>           302 to the stored destination (public)
//   GET /q/<id>.svg?sig=…   a saved code's SVG, for <img> tags elsewhere: the
//                           signed svg_url from qr.read (no token needed)
//
// The API is a set of named methods, <domain>.<create|read|update|delete>,
// called as POST /api/<method> with a JSON body (read methods also accept
// GET /api/<method>?<params>). Anything that isn't plain CRUD hangs off the
// closest method: listing is a read without an id, the raw SVG is a read with
// format "svg".
//
//   link.create  {url, label?, author?, key?}                     admin, author*
//                (with a key, a repeat create returns the existing link, 200;
//                409 if it now asks for a different url or label)
//   link.read    {code | key, stats?, tz?, days?} -> one link (+ daily scans)
//                {author?, limit?, offset?} -> list                admin, author*
//   link.update  {code, url?, label?, new_author?, if_url?}       admin, author*
//                (if_url: 409 unless the link still points there)
//   link.delete  {code}                                           admin
//   qr.create    {name, text, svg, details?, author?, meta?, image?}  admin, author*
//   qr.read      {id, format?: "json"|"svg"} -> one design (with svg and logo)
//                {author?, link?, limit?, offset?} -> list (no svg) admin, author*
//   qr.update    {id, name?, details?, text + svg?, meta?, image?, new_author?}
//                                                                 admin, author*
//   qr.delete    {id}                                             admin, author*
//   * an author token only ever sees its own author's links and designs, and
//     what it creates is always its own; it can't move anything to another
//     author or delete links. A design it saves is only tied to a short link
//     (link_id) when that link is its own, so a design can't reveal another
//     author's destination.
//   author.create {name, adopt_existing?} -> the author with a new token  admin
//   author.read   {name} -> one author with token |
//                 {include_tokens?} -> list                         admin
//   author.update {name, new_name?, rotate_token?, adopt_existing?} admin
//   author.delete {name}                                          admin
//   spec.read    {} -> this API's specification (see spec.js); authors
//                get the part their token can use                  admin, author
//   ticket.create {links, from?, name?, parent, author?} -> {url, …} admin, author
//                a 10-minute embed ticket (see below)
//   ticket.read   {} -> what the calling ticket allows               ticket
//
// Embedding (GET /embed#t=<ticket>): the generator page, framed by a site in
// EMBED_PARENTS, makes and saves one code per ticket link and posts the
// results to the parent window. A ticket ("qrt_…") acts as its author but may
// only read its links and template code and save one code per link.
//
// Everything else is served from the static assets (see wrangler.jsonc: the
// Worker only runs for /c/* and /api/*, so the site itself stays free of
// per-request Worker invocations).
//
// Image links (/q/…) are signed with ADMIN_TOKEN over the design id and its
// author's current token hash, so rotating that author's token (or the admin
// token) revokes them.
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
const MAX_KEY_LENGTH = 100;
const MAX_STATS_DAYS = 400;
const TICKET_TTL = 600; // seconds an embed ticket lasts
const MAX_TICKET_LINKS = 25;
// Scans are counted per 15 minutes: every time zone's offset is a whole number
// of quarter hours (India +5:30, Nepal +5:45), so days split exactly anywhere.
const SLOT_SECONDS = 900;
// Slots older than this can never be shown (stats go back MAX_STATS_DAYS), so
// about one scan in PRUNE_EVERY deletes its link's expired slots.
const KEEP_SLOTS = Math.ceil(((MAX_STATS_DAYS + 2) * 86400) / SLOT_SECONDS);
const PRUNE_EVERY = 200;

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

/** A new embed ticket: "qrt_" + 32 random bytes, base64url. */
const newTicketToken = () => 'qrt_' + newAuthorToken().slice(4);

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
  if (given.startsWith('qrt_')) {
    // An embed ticket: acts as its author, limited by api() to what it covers.
    await ensureSchema(env.DB);
    const t = await env.DB.prepare('SELECT author, links, from_id, name, parent, expires_at FROM tickets WHERE token_hash = ? AND expires_at > ?')
      .bind(await sha256Hex(given), Math.floor(Date.now() / 1000)).first();
    if (!t) return unauthorized();
    return { role: 'author', author: t.author, ticket: { links: JSON.parse(t.links), from: t.from_id, name: t.name, parent: t.parent, expires_at: t.expires_at } };
  }
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
    .then(() => addColumn(db, 'links', 'updated_at INTEGER'))
    // A caller's own name for a link (link.create {key}), unique per author.
    .then(() => addColumn(db, 'links', 'client_key TEXT'))
    .then(() => db.batch([
      db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS links_key ON links (author, client_key) WHERE client_key IS NOT NULL'),
      db.prepare('CREATE INDEX IF NOT EXISTS designs_link ON designs (link_id, id)'),
      // Scans per link per UTC hour: replaced by link_hits below (whole hours
      // split days wrongly in half-hour time zones). Still read for old scans.
      db.prepare(
        `CREATE TABLE IF NOT EXISTS link_hits_hourly (
           link_id INTEGER NOT NULL,
           hour INTEGER NOT NULL,
           hits INTEGER NOT NULL DEFAULT 0,
           PRIMARY KEY (link_id, hour)
         ) WITHOUT ROWID`,
      ),
      // Scans per link per 15 minutes (slot = Unix seconds / 900), so a caller
      // can group them into days in any time zone.
      db.prepare(
        `CREATE TABLE IF NOT EXISTS link_hits (
           link_id INTEGER NOT NULL,
           slot INTEGER NOT NULL,
           hits INTEGER NOT NULL DEFAULT 0,
           PRIMARY KEY (link_id, slot)
         ) WITHOUT ROWID`,
      ),
      // Embed tickets (ticket.create): short-lived, stored by hash only.
      db.prepare(
        `CREATE TABLE IF NOT EXISTS tickets (
           token_hash TEXT PRIMARY KEY,
           author TEXT NOT NULL,
           links TEXT NOT NULL,
           from_id INTEGER,
           name TEXT NOT NULL DEFAULT '',
           parent TEXT NOT NULL,
           created_at INTEGER NOT NULL,
           expires_at INTEGER NOT NULL
         )`,
      ),
    ]))
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
    key: row.client_key ?? null,
    hits: row.hits ?? 0,
    created_at: row.created_at,
    updated_at: row.updated_at ?? row.created_at,
    last_hit: row.last_hit ?? null,
  };
}

function presentDesign(row, base, { withSvg = false, svgUrl = null, who = null } = {}) {
  // An author only sees the destinations of their own links.
  const linkUrl = who?.role === 'author' && row.link_author !== who.author ? null : row.link_url ?? null;
  let meta = {};
  try { meta = JSON.parse(row.meta || '{}'); } catch { /* keep {} */ }
  const out = {
    id: row.id,
    name: row.name,
    details: row.details,
    author: row.author ?? '',
    text: row.text,
    link: row.link_id ? { code: encodeId(row.link_id), short: `${base}/c/${encodeId(row.link_id)}`, url: linkUrl } : null,
    meta,
    created_at: row.created_at,
    svg_url: svgUrl,
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
    const now = Math.floor(Date.now() / 1000);
    const slot = Math.floor(now / SLOT_SECONDS);
    // One batch, one round trip: the running total plus this quarter hour's count.
    const stmts = [
      env.DB.prepare('UPDATE links SET hits = hits + 1, last_hit = ? WHERE id = ?').bind(now, id),
      env.DB.prepare('INSERT INTO link_hits (link_id, slot, hits) VALUES (?, ?, 1) ON CONFLICT (link_id, slot) DO UPDATE SET hits = hits + 1')
        .bind(id, slot),
    ];
    if (Math.random() * PRUNE_EVERY < 1) {
      const oldest = slot - KEEP_SLOTS;
      stmts.push(
        env.DB.prepare('DELETE FROM link_hits WHERE link_id = ? AND slot < ?').bind(id, oldest),
        env.DB.prepare('DELETE FROM link_hits_hourly WHERE link_id = ? AND hour < ?').bind(id, Math.floor((oldest * SLOT_SECONDS) / 3600)),
      );
    }
    ctx.waitUntil(env.DB.batch(stmts).catch((e) => console.error('hit counter failed', e)));
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

const DESIGN_COLUMNS = 'd.id, d.name, d.details, d.author, d.text, d.link_id, d.meta, d.created_at, l.url AS link_url, l.author AS link_author, a.token_hash AS author_token_hash';
const DESIGN_FROM = "designs d LEFT JOIN links l ON l.id = d.link_id LEFT JOIN authors a ON a.name = d.author AND d.author != ''";
const LINK_COLUMNS = 'id, url, label, author, created_at, updated_at, client_key, hits, last_hit';

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
    // Link keys are unique per author, so adopting links whose keys clash would fail.
    const { results: clash } = await env.DB.prepare(
      'SELECT client_key FROM links WHERE author = ?1 AND client_key IN (SELECT client_key FROM links WHERE author = ?2 AND client_key IS NOT NULL) LIMIT 5',
    ).bind(name, newName).all();
    if (clash.length) {
      throw new HttpError(409, `"${name}" and "${newName}" both have links with the key(s) ${clash.map((r) => `"${r.client_key}"`).join(', ')}. Change or delete one link of each pair first.`);
    }
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
    // A name or key taken between the checks above and this batch.
    if (/UNIQUE/i.test(String(e?.message ?? e))) throw new HttpError(409, `Could not rename to "${newName}": that name or one of its link keys was just taken. Try again.`);
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

/** The author a new link or design gets: an author token's own; the admin's choice (or none). */
const ownerFor = (p, who) =>
  who.role === 'author' ? authorScope(p, who) : parseText(p.author, 'author', MAX_AUTHOR_LENGTH, { required: false });

/** A caller-chosen key for a link: letters, digits and . _ : - only. */
function parseKey(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !new RegExp(`^[A-Za-z0-9._:-]{1,${MAX_KEY_LENGTH}}$`).test(value))
    throw new HttpError(400, `"key" must be 1-${MAX_KEY_LENGTH} characters of letters, digits and . _ : -`);
  return value;
}

const parseBool = (v, field) => {
  if (v === undefined) return false;
  if (![true, false, 'true', 'false'].includes(v)) throw new HttpError(400, `"${field}" must be true or false`);
  return v === true || v === 'true';
};

const linkByKey = (env, author, key) =>
  env.DB.prepare(`SELECT ${LINK_COLUMNS} FROM links WHERE author = ? AND client_key = ?`).bind(author, key).first();

const linkCreate = async ({ req, env, base, p, who }) => {
  const url = parseDestination(p.url, shortLinkHosts(req, env));
  const label = parseLabel(p.label);
  const author = ownerFor(p, who);
  const key = parseKey(p.key);
  // Idempotent with a key: a retried create returns the link it made the first
  // time. A create that asks for something else under the same key is refused,
  // so a caller never mistakes the old destination for the one it sent.
  const reuse = (existing) => {
    if (existing.url === url && (p.label === undefined || existing.label === label)) return json(present(existing, base), 200);
    const what = existing.url === url ? 'label' : 'url';
    return json({ error: `A link with key "${key}" already exists with a different ${what}. Use link.update to change it.`, link: present(existing, base) }, 409);
  };
  if (key) {
    const existing = await linkByKey(env, author, key);
    if (existing) return reuse(existing);
  }
  const now = Math.floor(Date.now() / 1000);
  try {
    const row = await env.DB.prepare(`INSERT INTO links (url, label, author, client_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING ${LINK_COLUMNS}`)
      .bind(url, label, author, key, now, now)
      .first();
    return json(present(row, base), 201);
  } catch (e) {
    // Two creates with the same key at once: the loser returns the winner's link.
    if (key && /UNIQUE/i.test(String(e?.message ?? e))) {
      const existing = await linkByKey(env, author, key);
      if (existing) return reuse(existing);
    }
    throw e;
  }
};

/** YYYY-MM-DD of an instant in a time zone. */
const dateIn = (fmt, ms) => fmt.format(new Date(ms));

/** Scans per day for one link over the last `days` days (today last), in time zone `tz`. */
async function linkStats(env, id, p) {
  const tz = p.tz === undefined ? 'UTC' : p.tz;
  let fmt;
  try {
    if (typeof tz !== 'string' || !tz) throw new Error();
    fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  } catch {
    throw new HttpError(400, '"tz" must be an IANA time zone, e.g. "America/New_York"');
  }
  const days = p.days === undefined ? 30 : Number(p.days);
  if (!Number.isInteger(days) || days < 1 || days > MAX_STATS_DAYS) throw new HttpError(400, `"days" must be a whole number from 1 to ${MAX_STATS_DAYS}`);
  // The last `days` calendar dates in tz, by date arithmetic (immune to DST).
  const now = Date.now();
  const [y, m, d] = dateIn(fmt, now).split('-').map(Number);
  const dates = Array.from({ length: days }, (_, i) => new Date(Date.UTC(y, m - 1, d - (days - 1 - i))).toISOString().slice(0, 10));
  const counts = new Map(dates.map((date) => [date, 0]));
  // Every slot that could fall on those dates (time zones are within ±14 h of UTC).
  const fromMs = Date.UTC(y, m - 1, d - (days - 1)) - 15 * 3600_000;
  // Scans from before link_hits sit in whole-hour buckets, placed at their hour's start.
  const { results } = await env.DB.prepare(
    `SELECT slot * ${SLOT_SECONDS} AS t, hits FROM link_hits WHERE link_id = ?1 AND slot >= ?2
     UNION ALL SELECT hour * 3600 AS t, hits FROM link_hits_hourly WHERE link_id = ?1 AND hour >= ?3`,
  ).bind(id, Math.floor(fromMs / 1000 / SLOT_SECONDS), Math.floor(fromMs / 3600_000)).all();
  for (const r of results) {
    const date = dateIn(fmt, r.t * 1000);
    if (counts.has(date)) counts.set(date, counts.get(date) + r.hits);
  }
  return { tz, days: dates.map((date) => ({ date, hits: counts.get(date) })) };
}

// Links belong to an author like designs do: an author token only reaches its own.
const linkRead = async ({ env, base, p, who }) => {
  const author = authorScope(p, who);
  const [scope, scopeArgs] = authorWhere(author);
  if (p.code !== undefined || p.key !== undefined) {
    if (p.code !== undefined && p.key !== undefined) throw new HttpError(400, 'Send "code" or "key", not both');
    const withStats = parseBool(p.stats, 'stats');
    // Keys are per author: the admin looks one up under "author" (default none).
    const row = p.code !== undefined
      ? await env.DB.prepare(`SELECT ${LINK_COLUMNS} FROM links WHERE id = ?${scope}`).bind(parseLinkCode(p.code), ...scopeArgs).first()
      : await linkByKey(env, author ?? '', parseKey(p.key));
    if (!row) return json({ error: 'Not found' }, 404);
    return json(withStats ? { ...present(row, base), stats: await linkStats(env, row.id, p) } : present(row, base));
  }
  if (p.stats !== undefined) throw new HttpError(400, '"stats" needs a "code" or "key"');
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
  sets.push('updated_at = ?'); args.push(Math.floor(Date.now() / 1000));
  // if_url: only change the link if it still points where the caller last saw it.
  let guard = ['', []];
  if (p.if_url !== undefined) {
    if (typeof p.if_url !== 'string') throw new HttpError(400, '"if_url" must be a string');
    let expected = p.if_url.trim();
    try { expected = new URL(expected).href; } catch { /* compare as given */ }
    guard = [' AND url = ?', [expected]];
  }
  const row = await env.DB.prepare(`UPDATE links SET ${sets.join(', ')} WHERE id = ?${scope}${guard[0]} RETURNING ${LINK_COLUMNS}`)
    .bind(...args, id, ...scopeArgs, ...guard[1]).first();
  if (row) return json(present(row, base));
  if (guard[0]) {
    const current = await env.DB.prepare(`SELECT ${LINK_COLUMNS} FROM links WHERE id = ?${scope}`).bind(id, ...scopeArgs).first();
    if (current) return json({ error: 'The link no longer points at if_url: someone changed it. Nothing was updated.', link: present(current, base) }, 409);
  }
  return json({ error: 'Not found' }, 404);
};

const linkDelete = async ({ env, p }) => {
  const id = parseLinkCode(p.code);
  const [res] = await env.DB.batch([
    env.DB.prepare('DELETE FROM links WHERE id = ?').bind(id),
    env.DB.prepare('DELETE FROM link_hits WHERE link_id = ?').bind(id),
    env.DB.prepare('DELETE FROM link_hits_hourly WHERE link_id = ?').bind(id),
  ]);
  return res.meta?.changes ? json({ deleted: encodeId(id) }) : json({ error: 'Not found' }, 404);
};

const fetchDesign = (db, id, author, extra = '') =>
  db.prepare(`SELECT ${DESIGN_COLUMNS}${extra} FROM ${DESIGN_FROM} WHERE d.id = ?${author === null ? '' : ' AND d.author = ?'}`)
    .bind(id, ...(author === null ? [] : [author]))
    .first();

// ---------------------------------------------------------------- signed image links

let signingKey = null; // [ADMIN_TOKEN, CryptoKey]
async function imageSig(env, id, authorTokenHash) {
  if (signingKey?.[0] !== env.ADMIN_TOKEN) {
    signingKey = [env.ADMIN_TOKEN, await crypto.subtle.importKey('raw', new TextEncoder().encode(env.ADMIN_TOKEN), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])];
  }
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', signingKey[1], new TextEncoder().encode(`qr-image:${id}:${authorTokenHash ?? ''}`)));
  return btoa(String.fromCharCode(...mac.slice(0, 16))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const svgUrlFor = async (env, base, row) => `${base}/q/${row.id}.svg?sig=${await imageSig(env, row.id, row.author_token_hash)}`;

/** A design (with its signed image link) as returned by the API. */
const designOut = async (env, base, row, opts = {}) => presentDesign(row, base, { ...opts, svgUrl: await svgUrlFor(env, base, row) });

/**
 * The short link a design's text opens, if any. For an author token, only one
 * of its own links: tying a design to another author's link would show that
 * link's destination in the reply.
 */
async function designLinkId(env, text, req, who) {
  const id = linkIdFor(text, req, env);
  if (id === null || who.role !== 'author') return id;
  return (await env.DB.prepare('SELECT 1 FROM links WHERE id = ? AND author = ?').bind(id, who.author).first()) ? id : null;
}

async function signedImage(request, env, rawId, url) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
  const sig = url.searchParams.get('sig') || '';
  if (!env.ADMIN_TOKEN || !sig || !/^[1-9][0-9]{0,15}$/.test(rawId)) return notFound();
  await ensureSchema(env.DB);
  const row = await env.DB.prepare(`SELECT d.id, d.svg, a.token_hash AS author_token_hash FROM ${DESIGN_FROM} WHERE d.id = ?`).bind(Number(rawId)).first();
  // Same answer for a missing code and a wrong or revoked signature.
  if (!row || !(await safeEqual(sig, await imageSig(env, row.id, row.author_token_hash)))) return notFound();
  return new Response(request.method === 'HEAD' ? null : row.svg, { headers: { ...SVG_HEADERS, 'Cache-Control': 'public, max-age=300' } });
}

const SVG_HEADERS = {
  'Content-Type': 'image/svg+xml; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
  // Saved SVGs are validated on save; belt and braces if one is opened directly.
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  // Other sites may show it in an <img>.
  'Cross-Origin-Resource-Policy': 'cross-origin',
};

const qrCreate = async ({ req, env, base, p, who }) => {
  const text = parseText(p.text, 'text', MAX_TEXT_LENGTH);
  const { id } = await env.DB.prepare('INSERT INTO designs (name, details, author, text, link_id, svg, meta, image, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id')
    .bind(
      parseText(p.name, 'name', MAX_NAME_LENGTH),
      parseText(p.details, 'details', MAX_DETAILS_LENGTH, { required: false }),
      ownerFor(p, who),
      text, await designLinkId(env, text, req, who), parseSvg(p.svg), parseMeta(p.meta), parseImage(p.image), Math.floor(Date.now() / 1000),
    )
    .first();
  return json(await designOut(env, base, await fetchDesign(env.DB, id, null), { who }), 201);
};

const qrRead = async ({ env, base, p, who }) => {
  const author = authorScope(p, who);
  if (p.id !== undefined) {
    const format = p.format ?? 'json';
    if (format !== 'json' && format !== 'svg') throw new HttpError(400, '"format" must be "json" or "svg"');
    const row = await fetchDesign(env.DB, parseDesignId(p.id), author, ', d.svg, d.image');
    if (!row) return json({ error: 'Not found' }, 404);
    if (format === 'json') return json(await designOut(env, base, row, { withSvg: true, who }));
    // The raw image, for another project's server to inline or serve itself.
    return new Response(row.svg, { headers: { ...SVG_HEADERS, 'Cache-Control': 'private, max-age=300' } });
  }
  const { limit, offset } = parsePage(p);
  const where = [], args = [];
  if (author !== null) { where.push('d.author = ?'); args.push(author); }
  // Codes that open one short link, e.g. every design made for a check-in link.
  if (p.link !== undefined) {
    const linkId = typeof p.link === 'string' ? decodeCode(p.link.trim().toLowerCase()) : null;
    if (linkId === null) throw new HttpError(400, '"link" must be a short code, e.g. "c"');
    where.push('d.link_id = ?'); args.push(linkId);
  }
  const { results } = await env.DB.prepare(`SELECT ${DESIGN_COLUMNS} FROM ${DESIGN_FROM}${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY d.id DESC LIMIT ? OFFSET ?`)
    .bind(...args, limit, offset)
    .all();
  return json({ designs: await Promise.all(results.map((r) => designOut(env, base, r, { who }))) });
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
    args.push(text, await designLinkId(env, text, req, who), parseSvg(p.svg));
  }
  if (p.meta !== undefined) { sets.push('meta = ?'); args.push(parseMeta(p.meta)); }
  if (p.image !== undefined) { sets.push('image = ?'); args.push(parseImage(p.image)); }
  if (!sets.length) throw new HttpError(400, 'Nothing to update: send "name", "details", "new_author", "meta", "image", or "text" + "svg"');
  const scope = author === null ? ['', []] : [' AND author = ?', [author]];
  const res = await env.DB.prepare(`UPDATE designs SET ${sets.join(', ')} WHERE id = ?${scope[0]}`).bind(...args, id, ...scope[1]).run();
  if (!res.meta?.changes) return json({ error: 'Not found' }, 404);
  return json(await designOut(env, base, await fetchDesign(env.DB, id, null), { who }));
};

const qrDelete = async ({ env, p, who }) => {
  const author = authorScope(p, who);
  const id = parseDesignId(p.id);
  const scope = author === null ? ['', []] : [' AND author = ?', [author]];
  const res = await env.DB.prepare(`DELETE FROM designs WHERE id = ?${scope[0]}`).bind(id, ...scope[1]).run();
  return res.meta?.changes ? json({ deleted: id }) : json({ error: 'Not found' }, 404);
};

// ---------------------------------------------------------------- embed tickets

/** Origins allowed to frame /embed and receive its results (EMBED_PARENTS, space-separated). */
const embedParents = (env) => (env.EMBED_PARENTS || '').split(/\s+/).filter(Boolean).map((o) => { try { return new URL(o).origin; } catch { return null; } }).filter(Boolean);

const ticketCreate = async ({ env, base, p, who }) => {
  // The ticket acts as one author: the caller's own, or (admin) the one named.
  const author = who.role === 'author' ? authorScope(p, who) : parseText(p.author ?? '', 'author', MAX_AUTHOR_LENGTH, { required: false });
  const raw = typeof p.links === 'string' ? p.links.split(',') : p.links;
  if (!Array.isArray(raw)) throw new HttpError(400, '"links" must be a list of short codes, e.g. ["d", "e"]');
  const codes = [...new Set(raw.map((c) => (typeof c === 'string' ? c.trim().toLowerCase() : '')))];
  if (!codes.length || codes.length > MAX_TICKET_LINKS || codes.some((c) => decodeCode(c) === null))
    throw new HttpError(400, `"links" must be 1-${MAX_TICKET_LINKS} short codes, e.g. ["d", "e"]`);
  const ids = codes.map(decodeCode);
  const { results } = await env.DB.prepare(`SELECT id FROM links WHERE author = ? AND id IN (${ids.map(() => '?').join(', ')})`).bind(author, ...ids).all();
  const found = new Set(results.map((r) => r.id));
  const missing = codes.filter((c) => !found.has(decodeCode(c)));
  if (missing.length) throw new HttpError(404, `Not found (or not ${author ? `"${author}"` : 'unowned'}'s): ${missing.join(', ')}`);
  let fromId = null;
  if (p.from !== undefined && p.from !== null) {
    fromId = parseDesignId(p.from);
    if (!(await fetchDesign(env.DB, fromId, author))) throw new HttpError(404, `Saved code ${fromId} not found (or not ${author ? `"${author}"` : 'unowned'}'s)`);
  }
  const name = parseText(p.name, 'name', MAX_NAME_LENGTH, { required: false });
  let parent = null;
  try { parent = typeof p.parent === 'string' ? new URL(p.parent).origin : null; } catch { /* below */ }
  const allowed = embedParents(env);
  if (!parent || !allowed.includes(parent)) throw new HttpError(400, `"parent" must be the origin of the page that frames the generator, one of: ${allowed.join(', ') || '(none configured: set EMBED_PARENTS)'}`);
  const token = newTicketToken();
  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM tickets WHERE expires_at < ?').bind(now - 86400),
    env.DB.prepare('INSERT INTO tickets (token_hash, author, links, from_id, name, parent, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(await sha256Hex(token), author, JSON.stringify(codes), fromId, name, parent, now, now + TICKET_TTL),
  ]);
  return json({ url: `${base}/embed#t=${token}`, links: codes, from: fromId, name, parent, author, expires_at: now + TICKET_TTL }, 201);
};

const ticketRead = async ({ who }) => {
  if (!who.ticket) throw new HttpError(400, 'ticket.read is called with a ticket ("qrt_…") as the token');
  const t = who.ticket;
  return json({ author: who.author, links: t.links, from: t.from, name: t.name, parent: t.parent, expires_at: t.expires_at });
};

const TICKET_METHODS = new Set(['ticket.read', 'spec.read', 'link.read', 'qr.read', 'qr.create']);

/** What a ticket may do beyond its author's rights: only its links, its template, one code per link. */
async function checkTicket(name, p, who, req, env) {
  const t = who.ticket;
  const deny = () => { throw new HttpError(403, `This ticket does not cover that ${name} call`); };
  const covered = (code) => typeof code === 'string' && t.links.includes(code.trim().toLowerCase());
  if (!TICKET_METHODS.has(name)) throw new HttpError(403, `A ticket cannot call ${name}`);
  if (name === 'link.read' && (p.key !== undefined || !covered(p.code))) deny();
  if (name === 'qr.read' && (p.id !== undefined ? !(t.from && String(p.id).trim() === String(t.from)) : !covered(p.link))) deny();
  if (name === 'qr.create') {
    const id = typeof p.text === 'string' ? linkIdFor(p.text.trim(), req, env) : null;
    if (id === null || !t.links.includes(encodeId(id))) deny();
    const existing = await env.DB.prepare('SELECT id FROM designs WHERE link_id = ? AND author = ? LIMIT 1').bind(id, who.author).first();
    if (existing) throw new HttpError(409, `Link ${encodeId(id)} already has a code (#${existing.id})`);
  }
}

/** The generator page for iframes: index.html, frameable only by EMBED_PARENTS. */
async function embedPage(request, env) {
  if (!env.ASSETS || (request.method !== 'GET' && request.method !== 'HEAD')) return notFound();
  const page = await env.ASSETS.fetch(new Request(new URL('/', request.url), { method: request.method }));
  const res = new Response(page.body, page);
  const parents = embedParents(env);
  res.headers.set('Content-Security-Policy', `frame-ancestors ${parents.length ? parents.join(' ') : "'none'"}`);
  res.headers.set('Referrer-Policy', 'no-referrer');
  res.headers.set('Cache-Control', 'no-store');
  return res;
}

/** read: callable with GET; big: accepts design-sized bodies. */
const METHODS = {
  'link.create': { roles: ['admin', 'author'], run: linkCreate },
  'link.read': { roles: ['admin', 'author'], read: true, run: linkRead },
  'link.update': { roles: ['admin', 'author'], run: linkUpdate },
  'link.delete': { roles: ['admin'], run: linkDelete },
  'qr.create': { roles: ['admin', 'author'], big: true, run: qrCreate },
  'qr.read': { roles: ['admin', 'author'], read: true, run: qrRead },
  'qr.update': { roles: ['admin', 'author'], big: true, run: qrUpdate },
  'qr.delete': { roles: ['admin', 'author'], run: qrDelete },
  'author.create': { roles: ['admin'], run: authorCreate },
  'author.read': { roles: ['admin'], read: true, run: authorRead },
  'author.update': { roles: ['admin'], run: authorUpdate },
  'author.delete': { roles: ['admin'], run: authorDelete },
  'ticket.create': { roles: ['admin', 'author'], run: ticketCreate },
  'ticket.read': { roles: ['author'], read: true, run: ticketRead },
  'spec.read': { roles: ['admin', 'author'], read: true, run: ({ base, who }) => json(buildSpec(METHODS, base, who)) },
};

async function api(request, env, url, ctx) {
  const name = /^\/api\/([a-z]+\.[a-z]+)\/?$/.exec(url.pathname)?.[1];
  const method = name && Object.hasOwn(METHODS, name) ? METHODS[name] : null;
  if (!method) return json({ error: `Unknown method. Use one of: ${Object.keys(METHODS).join(', ')}` }, 404);
  const verbs = method.read ? 'GET, POST' : 'POST';
  if (request.method !== 'POST' && !(method.read && request.method === 'GET')) return json({ error: `${name} takes ${verbs}` }, 405, { Allow: verbs });
  const who = await authorize(request, env, ctx);
  if (who instanceof Response) return who;
  if (!method.roles.includes(who.role)) return json({ error: `This token cannot call ${name}` }, 403);
  const p = request.method === 'GET'
    ? Object.fromEntries(url.searchParams)
    : await readJson(request, method.big ? MAX_DESIGN_BODY_BYTES : MAX_BODY_BYTES);
  await ensureSchema(env.DB);
  if (who.ticket) await checkTicket(name, p, who, request, env);
  else if (name === 'ticket.read') throw new HttpError(400, 'ticket.read is called with a ticket ("qrt_…") as the token');
  return method.run({ req: request, env, url, base: publicBase(request, env), p, who });
}

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const short = /^\/c\/([A-Za-z0-9]+)\/?$/.exec(url.pathname);
      if (short) return await redirect(request, env, ctx, short[1]);
      if (url.pathname.startsWith('/c/') || url.pathname === '/c') return notFound();
      const image = /^\/q\/([0-9]+)\.svg$/.exec(url.pathname);
      if (image) return await signedImage(request, env, image[1], url);
      if (url.pathname.startsWith('/q/')) return notFound();
      if (url.pathname === '/embed' || url.pathname === '/embed/') return await embedPage(request, env);
      if (url.pathname.startsWith('/api/')) return await api(request, env, url, ctx);
      return env.ASSETS ? env.ASSETS.fetch(request) : notFound();
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: 'Internal error' }, 500);
    }
  },
};
