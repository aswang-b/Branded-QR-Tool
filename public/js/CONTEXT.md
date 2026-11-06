# public/js/: browser modules

Up: @CLAUDE.md

## Purpose

All client code: the QR art generator (encoder → art planning → rendering → scan scoring) and
the five pages that use the API. Plain ES modules loaded straight from `public/`, no build step.

## Generator pipeline

```
app.js (form, results, save)
  └─ gen-worker.js  (Web Worker; loads ZXing-wasm + jsQR once, kept alive between runs)
       └─ generate.js  generateAll(): plan variants, render colour + B/W, score each
            ├─ qr.js        encoder exposing which module belongs to which codeword/block
            ├─ art.js       planArt(): image drawn by free pad bytes + spent error budget
            ├─ fragment.js  planFragment(): link#<chars> whose bits draw the image
            ├─ render.js    shapes → toSVG / drawCanvas / rasterize (same output everywhere)
            └─ verify.js    decode at many sizes, crisp and blurred → reliability, min print mm
```

`generate.js`, `qr.js`, `art.js`, `fragment.js`, `render.js` and `verify.js` have no DOM
dependencies and are imported by the Node tests as well, so keep them free of `document`/`window`.

`app.js` talks to the worker with `{type: 'generate', jobId}`. Messages from older jobs are
ignored, and a new job supersedes the running one.

## Pages

| Page | Module | Uses |
|------|--------|------|
| `index.html` | `app.js` | `qr.create` / `qr.update` (Replace), `qr.read` (`?edit=`), `link.create` (Shorten), `author.read` (suggestions, admin) |
| `saved.html` | `saved.js` | `qr.read`, `qr.delete`, `qr.read {format:'svg'}` via `apiText`; Edit opens `index.html?edit=` |
| `links.html` | `links.js` | `link.*`, `author.read` (suggestions) |
| `authors.html` | `authors.js` | `author.*` (admin only) |
| `api.html` | `api.js` | `spec.read`, rendered with `textContent` only |

## Generator URL parameters (for other projects)

`?text=` link · `?name=` · `?author=` · `?return=<https url>` · `?edit=<design id>`.
- `?author=` fills the field, is announced in `#returnNote`, and is never stored as the default.
- `?return=` must be https (or a localhost dev server). After Save the user gets a
  "Return to <host>" button that adds `?qr_id=<id>`. There is no automatic redirect.
- With an author token, the Author field is read-only and set to that author: the server refuses
  any other author.
- Replace sends `new_author` only when the author changed. Author tokens may not send it at all.

## Batch mode and embed (bottom of app.js)

- `?batch=d,e,f&from=<id>&name=…&return=…`: a panel with "Make N codes", which runs only on a click.
  `runBatch()` does, per link:
  1. `link.read`.
  2. `qr.read {link}`, skipping links that already have a code.
  3. `designFor()`: the template's own variant first, then a full run.
  4. `qr.create`.
- On a fatal error, `runBatch` throws with `err.results` (the codes saved so far), so the Return
  link and the parent still get them.
- `/embed#t=<ticket>` (`EMBEDDED`):
  - `useMemoryToken(ticket)` puts `auth.js` in memory-only mode.
  - With no ticket in the fragment, the page stops and never uses a stored sign-in.
  - `startEmbed()` calls `ticket.read`, then runs the batch at once.
  - It posts `qr-ready` / `qr-progress` / `qr-done` / `qr-error` (with results) and `qr-resize`
    to `ticket.parent` only.
  - The fragment stays in the URL, so a reload keeps working, and a `hashchange` reloads with the
    new ticket.

## auth.js (shared by every page)

- The token lives in `sessionStorage`, and in `localStorage` too with "Remember". Both copies are
  written and cleared together.
- `signedInAs` (the name) is empty unless typed on the API page. `whoAmI()` asks `spec.read` who
  the token is, stores the name, and caches the answer per token. The sign-in bar uses it.
- `api(method, params)` POSTs JSON. A 401 clears the token and fires `auth-change`, so forms reappear.
  In memory-only mode (embed), only the in-memory ticket is cleared.
- `bindSignIn(onSignIn, {bar, showToken})`: while signed in, the password field is hidden (mobile
  Chrome kept offering to save it). The generator uses `bar: false` and handles its inline form itself.
- `api.js` signs out only when a *typed* name doesn't match the token's real owner.

## Conventions

- Build DOM with `createElement` + `textContent`. The only `innerHTML` is fixed text in `app.js`.
- Messages are for the person using the page, and must work for admin *and* author tokens.
- Saved designs keep everything needed to regenerate them: `meta.settings` (the form) and
  `image` (the logo as a ≤300 KB PNG data URL, see `logoDataUrl()`).

## Testing

No automated browser tests. Run `npm run dev` and check by hand, ideally with both an admin token
and an author token (create one on `authors.html`). The pure modules are covered by
`test/qr`, `art`, `generate` and the SVG allowlist test in `test/worker.test.mjs`.
