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

// For qr.* the API key must name an author; the admin may use it as a filter.
const AUTHOR_SCOPE = param('author', 'string', 'API key', 'API key: required on every call; only that author\'s codes are visible (others answer 404). Admin: optional filter.');

export const METHOD_DOCS = {
  'link.create': {
    summary: 'Create a short link.',
    params: [
      param('url', 'string', true, 'Destination: an absolute http(s) URL, up to 2048 characters. Must not point at another short link.'),
      param('label', 'string', false, 'A note for yourself, up to 100 characters.'),
    ],
    returns: 'The link (status 201).',
    example: { url: 'https://dancewithb.fun/check-in', label: 'Class check-in' },
  },
  'link.read': {
    summary: 'Read one short link, or list them.',
    params: [
      param('code', 'string', false, 'With a code: that one link (case-insensitive). Without: the list.'),
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
      param('url', 'string', false, 'New destination (same rules as link.create).'),
      param('label', 'string', false, 'New label, up to 100 characters.'),
    ],
    returns: 'The updated link.',
    notes: 'Send at least one of url or label.',
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
      param('svg', 'string', true, 'A single <svg> document, up to 1.5 MB. Scripts, event handlers and links are rejected.'),
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
    example: { author: 'alex@example.com', id: 12, format: 'svg' },
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
      param('new_author', 'string', false, 'Admin only: move the code to this author. The API key gets 403.'),
    ],
    returns: 'The updated code without svg/image.',
    notes: 'Send at least one field to change. The code keeps its id, so anything referring to it stays valid.',
    example: { author: 'alex@example.com', id: 12, name: 'Check-in sticker v2' },
  },
  'qr.delete': {
    summary: 'Delete a saved code. Short links it used keep working.',
    params: [param('id', 'number', true, 'The code to delete.'), AUTHOR_SCOPE],
    returns: '{deleted: id}.',
    example: { author: 'alex@example.com', id: 12 },
  },
  'spec.read': {
    summary: 'This specification, as JSON.',
    params: [],
    returns: 'The specification.',
    example: {},
  },
};

export const ERRORS = [
  { status: 400, meaning: 'Bad or missing params (the message says which). Also: the API key called qr.* without an author.' },
  { status: 401, meaning: 'Missing or wrong token.' },
  { status: 403, meaning: 'The token is valid but may not do this (e.g. the API key calling link.create, or setting new_author).' },
  { status: 404, meaning: 'Unknown method, or no link/code with that code/id (for the API key, also another author\'s code).' },
  { status: 405, meaning: 'Wrong HTTP verb: writes are POST only; reads take GET or POST.' },
  { status: 413, meaning: 'Request body too large.' },
  { status: 503, meaning: 'ADMIN_TOKEN is not configured: the API refuses everything.' },
];

export const ROLE_DOCS = {
  admin: 'ADMIN_TOKEN: everything, including the generator, Saved codes and Short links pages.',
  api: 'API_TOKEN: for other projects\' servers. Reads and repoints short links; lists, fetches, edits and deletes one author\'s saved codes per call. Cannot create links or codes, delete links, move codes between authors, or see other authors\' codes.',
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
    objects: { link: LINK, design: DESIGN },
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
