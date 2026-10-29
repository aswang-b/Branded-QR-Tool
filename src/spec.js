// The API specification served by spec.read (admin only) and rendered on
// api.html. Who may call each method comes from the Worker's METHODS table, so
// the spec can't drift from what is enforced; keep the wording here in step
// with the handlers in worker.js.

const param = (name, type, required, desc) => ({ name, type, required, desc });

const LINK = {
  code: 'string: short code, e.g. "a" (a–z then 0–9; never reused)',
  short: 'string: full short URL that goes in a QR code, e.g. https://qr.dancewithb.fun/c/a',
  url: 'string: current destination',
  label: 'string',
  author: 'string: whose link this is ("" when none); author tokens only reach their own',
  hits: 'number: scans (GET requests to the short URL)',
  created_at: 'number: Unix seconds',
  last_hit: 'number | null: Unix seconds',
};

const DESIGN = {
  id: 'number',
  name: 'string',
  details: 'string',
  author: 'string ("" when none)',
  text: 'string: exactly what the QR code encodes (link + #shaping characters)',
  link: '{code, short, url} | null: the short link the code opens, if it is one of ours',
  meta: 'object: scores (reliability, minMm, match, …) and the generator settings used',
  created_at: 'number: Unix seconds',
  svg: 'string: the code as an SVG document (qr.read with an id only)',
  image: 'string | null: source logo as a PNG data URL (qr.read with an id only)',
};

const AUTHOR = {
  name: 'string: the author, as stored on their saved codes',
  token: 'string: their API token ("qra_…"); returned by author.create/update, author.read {name}, and author.read {include_tokens: true}',
  created_at: 'number: Unix seconds',
  last_used: 'number | null: Unix seconds the token was last used',
  codes: 'number: saved codes with this author',
  links: 'number: short links with this author',
};

// An author token is always limited to its own author; the admin may filter by one.
const AUTHOR_SCOPE = param('author', 'string', false, 'Author token: not needed (always its own author; a different one is refused with 403). Admin: optional filter.');
const ADOPT = param('adopt_existing', 'boolean', false, 'Codes or links already labelled with this name (e.g. left by a revoked author) are refused with 409 unless this is true, which hands them to this author\'s token.');

export const METHOD_DOCS = {
  'link.create': {
    summary: 'Create a short link.',
    params: [
      param('url', 'string', true, 'Destination: an absolute http(s) URL, up to 2048 characters. Must not point at another short link.'),
      param('label', 'string', false, 'A note for yourself, up to 100 characters.'),
      param('author', 'string', false, 'Whose link this is, up to 200 characters. That author\'s token can then read and repoint it.'),
    ],
    returns: 'The link (status 201).',
    example: { url: 'https://dancewithb.fun/check-in', label: 'Class check-in' },
  },
  'link.read': {
    summary: 'Read one short link, or list them.',
    params: [
      param('code', 'string', false, 'With a code: that one link (case-insensitive). Without: the list.'),
      AUTHOR_SCOPE,
      param('limit', 'number', false, 'List only: 1–200, default 100.'),
      param('offset', 'number', false, 'List only: how many to skip, default 0.'),
    ],
    returns: 'One link, or {links: [link, …]}, newest first.',
    example: { code: 'a' },
  },
  'link.update': {
    summary: 'Change where a short link goes, or its label. Printed codes follow immediately.',
    params: [
      param('code', 'string', true, 'The link to change.'),
      AUTHOR_SCOPE,
      param('url', 'string', false, 'New destination (same rules as link.create).'),
      param('label', 'string', false, 'New label, up to 100 characters.'),
      param('new_author', 'string', false, 'Admin only: give the link to this author. An author token gets 403.'),
    ],
    returns: 'The updated link.',
    notes: 'Send at least one of url, label or new_author.',
    example: { code: 'a', url: 'https://dancewithb.fun/check-in?events=…' },
  },
  'link.delete': {
    summary: 'Delete a short link. Its code then answers 404 and is never handed out again.',
    params: [param('code', 'string', true, 'The link to delete.')],
    returns: '{deleted: code}.',
    example: { code: 'a' },
  },
  'qr.create': {
    summary: 'Save a QR code design (the generator does this when you press Save).',
    params: [
      param('name', 'string', true, '1–100 characters.'),
      param('text', 'string', true, 'What the code encodes, up to 4296 characters.'),
      param('svg', 'string', true, 'A single <svg> document as the generator writes it, up to 1.5 MB: only svg/g/rect/circle/path elements with plain shape and colour attributes; anything else is rejected.'),
      param('details', 'string', false, 'Up to 2000 characters.'),
      param('author', 'string', false, 'Whose code this is, up to 200 characters (e.g. an email or project name).'),
      param('meta', 'object', false, 'Scores and generator settings, up to 16 KB as JSON.'),
      param('image', 'string', false, 'Source logo as a PNG data URL (data:image/png;base64,…), up to 300 kB, so the code can be regenerated.'),
    ],
    returns: 'The code without svg/image (status 201).',
    example: { name: 'Check-in sticker', author: 'alex@example.com', text: 'https://qr.dancewithb.fun/c/a#…', svg: '<svg …>…</svg>' },
  },
  'qr.read': {
    summary: 'Read one saved code (as JSON or as the raw SVG image), or list codes.',
    params: [
      param('id', 'number', false, 'With an id: that one code, including svg and image. Without: the list (no SVGs).'),
      param('format', '"json" | "svg"', false, 'With an id: "svg" returns the raw image (Content-Type image/svg+xml) instead of JSON. Default "json".'),
      AUTHOR_SCOPE,
      param('limit', 'number', false, 'List only: 1–200, default 100.'),
      param('offset', 'number', false, 'List only: how many to skip, default 0.'),
    ],
    returns: 'One code, the raw SVG (format "svg"; may be cached privately for up to 5 minutes), or {designs: [code, …]}, newest first.',
    example: { id: 12, format: 'svg' },
  },
  'qr.update': {
    summary: 'Rename a saved code, edit its details, replace the code itself, or (admin) move it to another author.',
    params: [
      param('id', 'number', true, 'The code to change.'),
      AUTHOR_SCOPE,
      param('name', 'string', false, '1–100 characters.'),
      param('details', 'string', false, 'Up to 2000 characters.'),
      param('text', 'string', false, 'Replacement encoded text. Must come with svg.'),
      param('svg', 'string', false, 'Replacement SVG (same rules as qr.create). Must come with text.'),
      param('meta', 'object', false, 'Replaces the stored meta.'),
      param('image', 'string', false, 'Replaces the stored logo (PNG data URL).'),
      param('new_author', 'string', false, 'Admin only: move the code to this author. An author token gets 403.'),
    ],
    returns: 'The updated code without svg/image.',
    notes: 'Send at least one field to change. The code keeps its id, so anything referring to it stays valid.',
    example: { id: 12, name: 'Check-in sticker v2' },
  },
  'qr.delete': {
    summary: 'Delete a saved code. Short links it used keep working.',
    params: [param('id', 'number', true, 'The code to delete.'), AUTHOR_SCOPE],
    returns: '{deleted: id}.',
    example: { id: 12 },
  },
  'author.create': {
    summary: 'Authorize an author: creates their API token, limited to their own saved codes.',
    params: [param('name', 'string', true, 'The author, 1–200 characters, exactly as on their saved codes (e.g. an email or project name). Must be unique.'), ADOPT],
    returns: 'The author, including the token (status 201; 409 if the name exists or is already on codes/links without adopt_existing).',
    example: { name: 'alex@example.com' },
  },
  'author.read': {
    summary: 'Read one author with their token, or list all authors.',
    params: [
      param('name', 'string', false, 'With a name: that author, including the token. Without: all authors, by name.'),
      param('include_tokens', 'boolean', false, 'List only: include each author\'s token. Default false.'),
    ],
    returns: 'One author, or {authors: [author, …]} (tokens only with include_tokens).',
    example: { name: 'alex@example.com' },
  },
  'author.update': {
    summary: 'Rename an author (their saved codes move with them) and/or rotate their token.',
    params: [
      param('name', 'string', true, 'The author to change.'),
      param('new_name', 'string', false, 'New name; their saved codes and links are relabelled to match.'),
      param('rotate_token', 'boolean', false, 'true: issue a new token. The old one stops working at once.'),
      ADOPT,
    ],
    returns: 'The updated author, including the (new) token.',
    notes: 'Send new_name and/or rotate_token: true.',
    example: { name: 'alex@example.com', rotate_token: true },
  },
  'author.delete': {
    summary: 'Revoke an author: their token stops working. Their saved codes stay, still labelled with their name.',
    params: [param('name', 'string', true, 'The author to remove.')],
    returns: '{deleted: name}.',
    example: { name: 'alex@example.com' },
  },
  'spec.read': {
    summary: 'This specification, as JSON.',
    params: [],
    returns: 'The specification.',
    example: {},
  },
};

export const ERRORS = [
  { status: 400, meaning: 'Bad or missing params (the message says which).' },
  { status: 401, meaning: 'Missing, wrong or revoked token.' },
  { status: 403, meaning: 'The token is valid but may not do this (e.g. an author token calling link.create, naming another author, or setting new_author).' },
  { status: 404, meaning: 'Unknown method, or nothing with that code/id/name (for an author token, also another author\'s code).' },
  { status: 405, meaning: 'Wrong HTTP verb: writes are POST only; reads take GET or POST.' },
  { status: 409, meaning: 'An author with that name already exists, or codes/links already carry the name (send adopt_existing: true).' },
  { status: 413, meaning: 'Request body too large.' },
  { status: 503, meaning: 'ADMIN_TOKEN is not configured: the API refuses everything.' },
];

export const ROLE_DOCS = {
  admin: 'ADMIN_TOKEN (a Wrangler secret): everything, including the site\'s pages and managing authors.',
  author: 'Author token ("qra_…", made with author.create): for other projects\' servers. Reads and repoints its own author\'s short links; lists, fetches, edits and deletes its own author\'s saved codes. Cannot create links or codes, delete links, move anything between authors, reach other authors\' links or codes, or manage authors.',
};

/**
 * The full specification, given the Worker's method table.
 * @param {Record<string, {roles: string[], read?: boolean}>} methods
 */
export function buildSpec(methods, base) {
  return {
    base: `${base}/api/<method>`,
    transport: 'POST /api/<method> with a JSON object body. Methods marked "read" also accept GET /api/<method>?<params> (values arrive as strings).',
    auth: 'Authorization: Bearer <token> on every call.',
    roles: ROLE_DOCS,
    objects: { link: LINK, design: DESIGN, author: AUTHOR },
    methods: Object.entries(methods).map(([name, m]) => ({
      name,
      verbs: m.read ? ['GET', 'POST'] : ['POST'],
      roles: m.roles,
      ...METHOD_DOCS[name],
    })),
    errors: ERRORS,
    errorBody: '{"error": "message"}',
  };
}
