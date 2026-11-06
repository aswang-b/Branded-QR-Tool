# Branded QR

> **Start here.** File tree and tech stack: @docs/ai-context/project-structure.md ·
> Where each topic is documented: @docs/ai-context/docs-overview.md

Self-hosted generator for branded QR codes where the logo is drawn *by the QR pattern itself*,
plus a short-link redirect service and an API other projects use. Runs on Cloudflare
(Workers static assets + one Worker + D1), live at https://qr.dancewithb.fun.

`README.md` is the user-facing guide (how the art works, the API table, deploying). This file
is for working on the code.

## Quick start

```bash
npm install
npm test              # node --test "test/*.test.mjs" (starts real `wrangler dev` instances)
npm run dev           # wrangler dev: site + Worker + local D1
npm run deploy        # wrangler deploy (needs the ADMIN_TOKEN secret set once)
```

`deploy.cmd` (Windows) pulls, stashes local edits, and deploys. There is no build step and no
bundler: `public/` is served as-is, browser code is plain ES modules.

## Architecture

| Part | Where | Runs |
|------|-------|------|
| Generator (logo → QR art, scan scoring) | `public/js/` (`app.js` + `gen-worker.js`) | Browser, in a Web Worker |
| Redirect + API Worker | `src/worker.js` | Cloudflare, only for `/c/*`, `/q/*`, `/api/*`, `/embed` |
| Batch mode (`?batch=d,e,f&from=<id>`) and embed (`/embed#t=<ticket>`) | `public/js/app.js` (bottom) | Browser |
| API spec (served by `spec.read`, shown on `api.html`) | `src/spec.js` | Worker |
| Storage | D1 `branded-qr-links` | Tables made on first request (`ensureSchema`) |

Generation is far too CPU-heavy for a Worker, so the server only **stores** SVGs the browser
made. `wrangler.jsonc` sends everything else to static assets, so normal page loads never
invoke the Worker.

Pages: `index.html` (generator), `saved.html`, `links.html`, `authors.html`, `api.html`.
Each has a `public/js/<page>.js`; all share `auth.js` (token storage, `api()` calls, sign-in bar).

## API in one paragraph

`POST /api/<domain>.<create|read|update|delete>` with a JSON body (reads also take GET).
Domains: `link`, `qr` (saved designs), `author`, `ticket`, `spec`. Two roles: the **admin**
(`ADMIN_TOKEN` secret, everything) and **authors** (`qra_…` tokens from `author.create`, limited
to their own links and designs). An **embed ticket** (`qrt_…`, from `ticket.create`) acts as its
author but is narrowed further by `checkTicket()`: only its links and template, one code per link. Roles per method live in the `METHODS` table in `worker.js`,
and `spec.js` reads that table, so docs and enforcement can't drift. Full table: `README.md` → *API*.

## Rules that must hold (security)

- **An author token only ever sees its own author's rows.** Every `link.*`/`qr.*` query goes through
  `authorScope()` / `authorWhere()`. A design is tied to a short link (`link_id`) only if that link
  is the author's own (`designLinkId()`), and `presentDesign` hides `link.url` for links the viewer
  doesn't own. New queries must keep both.
- Authors can't send `new_author`, can't delete links, can't call `author.*`.
- Saved SVGs pass an **allowlist** parser (`parseSvg`): only the elements and attributes
  `render.js toSVG` writes. If the renderer starts writing something new, extend the allowlist
  and the test `every SVG the generator writes passes the save-time allowlist`.
- `/q/<id>.svg?sig=` image links are HMAC-signed with `ADMIN_TOKEN` over the id + the author's
  token hash, so rotating a token revokes them. Missing and bad-signature cases both return 404.
- Destinations must be http(s) and must not point back at our own `/c/` links.
- Browser code builds DOM with `textContent`; never put API data into `innerHTML`.
- The generator's `?return=` link is never followed automatically: after Save the user presses
  "Return to <host>". `?author=` is shown as coming from the link and never saved as the default.
- **Embed tickets:**
  - With a ticket, `qr.create` takes name, details and logo from the ticket and its `from` code
    (`ticketFields`), and enforces one code per link inside the INSERT (`WHERE NOT EXISTS`). The SVG
    can't be verified: the Worker can't decode a QR code within its CPU limit.
  - Tickets live 10 min past their last use, 1 h at most. `author.update` and `author.delete` delete
    that author's tickets.
  - `/embed` is framable only by `EMBED_PARENTS` (CSP `frame-ancestors`), and results are posted only
    to the ticket's `parent`.
- **The embed page shares storage with the main site** (same site). `useMemoryToken()` puts
  `auth.js` in memory-only mode: it must never read, overwrite or clear the stored sign-in there.

## Data notes

- Short codes are the row id in bijective base 36 (`a…z0…9`, then `aa`). `AUTOINCREMENT`, never reused.
- Schema changes are additive in `ensureSchema()` (`CREATE … IF NOT EXISTS`, `addColumn` that
  ignores "duplicate column"). There are no migration files; deploys need no migration step.
- Scans: `links.hits` total, plus `link_hits` per 15-minute slot (`slot = unix_s / 900`) for
  per-day stats in any time zone. `link_hits_hourly` is legacy, read-only except for pruning.
  About 1 in `PRUNE_EVERY` scans deletes that link's slots older than ~402 days.
- `link.create {key}` is idempotent per author. A repeat key with a different url or label → 409.

## Conventions

- Plain JavaScript, no TypeScript, no framework, no dependencies at runtime (vendored decoders in
  `public/vendor/`). Dev deps: `wrangler`, `jsqr`, `zxing-wasm`.
- Comments explain *why* in full sentences. File headers describe the module's job.
- Errors: throw `HttpError(status, message)` in the Worker. Messages are written for a human
  reading them in the UI ("Send … to …").
- When API behaviour changes, update **three places**: the handler in `worker.js`, its entry in
  `spec.js`, and the README API table. Then add or adjust a test in `test/worker.test.mjs`.

## Testing

- `test/worker.test.mjs` boots real `wrangler dev` (workerd + local D1) on free ports with
  throwaway state, and calls it over HTTP. Helpers: `rpc(method, params, headers)`,
  `authorKey(name)`, `expectStatus`.
- `qr.test.mjs`, `art.test.mjs`, `generate.test.mjs` test the encoder, art planning and scoring in Node.
- Browser pages have no automated tests. Check UI changes by hand with `npm run dev`.

## Environment gotchas

- Developed on Windows; paths contain spaces (quote them). `python` is the Microsoft Store stub, so
  use Node for scripts.
- Tests pass an empty `--env-file` so a local `.dev.vars` can't leak into them, and override
  `PUBLIC_BASE_URL`.
