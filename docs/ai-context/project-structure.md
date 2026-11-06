# Project structure

Back to @CLAUDE.md · Doc map: @docs/ai-context/docs-overview.md

## Tech stack

| Layer | Choice |
|-------|--------|
| Hosting | Cloudflare Workers with static assets (`wrangler.jsonc`), custom domain `qr.dancewithb.fun` |
| Server | One Worker, `src/worker.js` (ES module), runs only for `/c/*`, `/q/*`, `/api/*`, `/embed` |
| Database | Cloudflare D1 (SQLite), binding `DB`, database `branded-qr-links` |
| Secrets / vars | `ADMIN_TOKEN` (secret), `PUBLIC_BASE_URL` (origin printed in short links), `EMBED_PARENTS` (origins allowed to frame `/embed`) |
| Browser | Plain HTML + CSS + ES modules, no build step, no framework |
| QR decoding (scan scoring) | Vendored ZXing (WebAssembly) and jsQR in `public/vendor/` |
| Tests | `node --test`, worker tests drive a real `wrangler dev` |
| Tooling | `wrangler` 4, Node (ESM, `"type": "module"`) |

## File tree

```
Branded QR/
├── CLAUDE.md                 entry point for working on the code
├── README.md                 user guide: how it works, API table, deploy, limitations
├── package.json              scripts: dev, deploy, test
├── wrangler.jsonc            Worker, assets routing (run_worker_first), D1, vars
├── deploy.cmd                Windows: pull, stash local edits, deploy
├── docs/ai-context/          this file + docs-overview.md
├── src/
│   ├── CONTEXT.md            the Worker: routes, roles, storage, invariants
│   ├── worker.js             redirect (/c), signed images (/q), API (/api), D1 schema
│   └── spec.js               API spec served by spec.read and rendered by api.html
├── public/                   static site (served directly by Cloudflare)
│   ├── _headers              security headers for static assets
│   ├── .assetsignore         keeps CONTEXT.md files out of the deployed site
│   ├── index.html            the generator (also batch mode, and /embed)
│   ├── saved.html            saved codes (qr.*)
│   ├── links.html            short links (link.*)
│   ├── authors.html          author tokens (author.*, admin only)
│   ├── api.html              API guide for the signed-in token
│   ├── css/style.css         all styles
│   ├── vendor/               jsQR.js, zxing/ (reader + wasm)
│   └── js/
│       ├── CONTEXT.md        browser modules: generator pipeline and pages
│       ├── app.js            generator page: inputs, results, export, save, edit, batch, embed
│       ├── gen-worker.js     Web Worker: runs generate.js with the decoders
│       ├── generate.js       plan variants, render, score (shared with tests)
│       ├── qr.js             QR encoder exposing the codeword layout
│       ├── art.js            image → module matrix (pad bytes + error budget)
│       ├── fragment.js       "#fragment" variant: characters chosen to draw the image
│       ├── render.js         shapes → SVG, Canvas, software rasterizer
│       ├── verify.js         simulated phone-camera scan test
│       ├── auth.js           token storage, api()/apiText(), sign-in bar, whoAmI()
│       ├── saved.js          saved-codes page
│       ├── links.js          short-links page
│       ├── authors.js        authors page
│       └── api.js            API guide page
└── test/
    ├── helpers.mjs           synthetic logos, PNG writer
    ├── qr.test.mjs           encoder
    ├── art.test.mjs          art planning
    ├── generate.test.mjs     end-to-end generation and scoring
    └── worker.test.mjs       Worker + D1 over HTTP (real wrangler dev)
```

## Request routing

| Path | Handled by |
|------|-----------|
| `/c/<code>` | `redirect()`: 302 to the destination, counts the scan |
| `/q/<id>.svg?sig=…` | `signedImage()`: a saved SVG for `<img>` tags, no token |
| `/embed` (`/embed/` → 308) | `embedPage()`: index.html, framable only by `EMBED_PARENTS` |
| `/api/<method>` | `api()`: auth, role check, body parsing, then the `METHODS` handler |
| anything else | static assets from `public/` (the Worker is not invoked) |

## D1 tables (created by `ensureSchema()`)

| Table | Holds |
|-------|-------|
| `links` | short links: url, label, author, client_key, hits, last_hit, timestamps |
| `designs` | saved codes: name, details, author, text, link_id, svg, meta (JSON), image (PNG data URL) |
| `authors` | name, token, token_hash (lookup), created_at, last_used |
| `link_hits` | scans per link per 15-minute slot |
| `link_hits_hourly` | legacy hourly scan counts (still read by stats, pruned) |
| `tickets` | embed tickets by hash: author, links, from_id, name, parent, created_at, expires_at |
