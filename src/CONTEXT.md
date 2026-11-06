# src/: the Worker

Up: @CLAUDE.md

## Purpose

One Cloudflare Worker that serves short-link redirects, signed SVG image links, and the JSON API.
Static pages never reach it (see `run_worker_first` in `wrangler.jsonc`).

## Key files

| File | Role |
|------|------|
| `worker.js` | Everything server-side: codes, auth, validation, D1 schema, routes, API handlers |
| `spec.js` | `buildSpec(METHODS, base, who)`: the API description for `spec.read`, cut down for authors |

## Layout of worker.js (top to bottom)

1. Header comment: the method table with roles. Keep it current.
2. Limits (`MAX_*`, `SLOT_SECONDS`, `KEEP_SLOTS`, `PRUNE_EVERY`).
3. `encodeId` / `decodeCode`: bijective base 36 over `a-z0-9`.
4. Helpers: `json`, `safeEqual` (constant time), `authorize`, `readJson`, `HttpError`.
5. Parsers: `parseDestination`, `parseLabel`, `parseText`, `parseSvg` (allowlist), `parseImage`,
   `parseMeta`, `parseKey`, `parseBool`, `linkIdFor`.
6. `ensureSchema()`: additive, runs once per isolate, retried if it fails.
7. `present` / `presentDesign` / `presentAuthor`: the only shapes sent out.
8. Routes: `redirect`, `signedImage`, then the API handlers, then `METHODS` and `api()`.

## Auth and roles

- `authorize()` → `{role: 'admin'}` (matches `ADMIN_TOKEN`) or `{role: 'author', author}` (a `qra_`
  token found by its SHA-256 in `authors.token_hash`). `last_used` is written at most hourly.
- `METHODS[name].roles` decides who may call a method. `api()` refuses others with 403.
- Inside handlers:
  - `authorScope(p, who)`: an author is pinned to itself (a different `author` param → 403); the
    admin may filter by `author` or see all (`null`).
  - `authorWhere(author)` turns that into SQL.
  - `ownerFor(p, who)`: who a new row belongs to.
  - `designLinkId(env, text, req, who)`: the `link_id` for a design. For authors, only their own links.
  - `presentDesign(..., {who})`: nulls `link.url` when the viewer is an author who doesn't own the link.

## Embed tickets (`ticket.*`, `/embed`)

- `ticket.create` (admin or author, called from the other project's *server*) stores a ticket by
  hash: author (via `ownerFor`), links (each must be the author's, checked with `authorWhere`), an
  optional `from` design, a name template, and `parent` (must be in `EMBED_PARENTS`). It returns
  `…/embed#t=qrt_…`.
- `authorize()` turns a live `qrt_` token into `{role:'author', author, ticket}`.
  - Expiry slides: `expires_at` moves to `now + TICKET_TTL`, capped at `created_at + TICKET_MAX_LIFE`,
    and is written at most once a minute.
- `api()` calls `checkTicket()` before the handler:
  - Only `ticket.read`, `spec.read`, `link.read {code}`, `qr.read {link}` / `{id: from}` and
    `qr.create` for a covered link.
  - A link that already has a code → 409.
- `qrCreate` with a ticket:
  - Name, details and logo come from `ticketFields()` (`batchName(template, code)`, the `from`
    code's details and image).
  - The INSERT is conditional (`… SELECT … WHERE NOT EXISTS`), so simultaneous saves can't
    duplicate a code.
- `authorUpdate` / `authorDelete` delete the author's tickets (rotate, rename, revoke).
- `/embed` serves `index.html` with `frame-ancestors <EMBED_PARENTS>`, no `X-Frame-Options`, and
  `no-store`. `/embed/` gets a 308 to `/embed`, because the page's asset paths are relative.
- `ticket.read` is open to every role, and answers 400 to anyone without a ticket.

## Adding or changing an API method

1. Write the handler `async ({ req, env, base, p, who }) => Response`. Validate every field with a
   `parse*` helper and throw `HttpError` for bad input.
2. Scope every query to `authorScope` unless the method is admin-only.
3. Register it in `METHODS` (`roles`, `read: true` for GET support, `big: true` for design-sized bodies).
4. Describe it in `spec.js` (`summary`, `params`, `returns`, `example`), the header comment, and the README.
5. Test it in `test/worker.test.mjs`, including an author token trying to reach another author's rows.

## Scans

- `redirect()` answers first and counts in `ctx.waitUntil`, as one D1 batch:
  `links.hits/last_hit` plus an upsert into `link_hits (link_id, slot)` with `slot = floor(s/900)`.
- About one scan in `PRUNE_EVERY` (200) also deletes that link's slots older than `KEEP_SLOTS`
  (~402 days) from `link_hits` and the legacy `link_hits_hourly`.
- `linkStats()` builds the last N calendar dates in the caller's `tz` and adds up slots from both
  tables (legacy hours count at the start of their hour). Quarter-hour slots split days exactly in
  every time zone.
- The redirect appends `#` when the destination has no fragment, so the QR's shaping fragment
  doesn't leak onto the destination page. It is 302 + `no-store`, because destinations can change.

## Behaviours callers rely on

- `link.create {key}`: same key + same url (and label, if sent) → 200 with the existing link.
  A different url or label → 409 `{error, link}`. Concurrent creates resolve to one row.
- `link.update {if_url}`: 409 with the current link if it moved meanwhile.
- `author.update {new_name}` moves the author's designs and links. A key both names use → 409
  naming the keys, before anything changes.
- `author.*` and `adopt_existing`: rows already carrying a name aren't handed to a new token
  without consent.
- Image signatures change when the author's token rotates or `ADMIN_TOKEN` changes.

## Pitfalls

- D1 `batch()` is atomic. Use it when statements must succeed together (rename, delete + stats).
- Don't widen `parseSvg` with a blocklist. Add exact attributes and value patterns only.
- `schemaReady` is module state, so it persists across requests in one isolate. New tables go
  inside the `ensureSchema()` chain.
