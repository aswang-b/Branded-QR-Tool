# Branded QR

A self-hosted tool that makes QR codes where **your logo is part of the pattern itself**,
not a sticker placed on top. Upload any square image, enter a link, download a PNG or SVG.

- The QR maker runs 100% in the browser — images never leave the user's machine.
- Deploys to **Cloudflare Workers** (free plan): the site is served as static assets, and a tiny
  redirect Worker backs the short links (`/c/<code>`) so printed codes stay short and editable.
- Any image the browser can decode works: PNG, JPG, WebP, GIF, SVG. Non-square images are
  cropped (or padded) to a square.

## Using it

1. **Link.** Paste your link, or press **Shorten** to turn it into a `/c/<code>` short link whose
   destination you can change after printing.
2. **Image.** Drop in a square image (non-square images are cropped or padded). Logos with a
   transparent background work best: transparent areas stay an ordinary QR code.
3. **Print width and scan distance.** Used to predict whether each design scans at your size.
4. **Style** (all options keep scanner-friendly limits):

   | Option | Choices |
   |---|---|
   | Pixel shape | Dots, rounded squares, squares, connected |
   | Corner eyes | Square, rounded, round dot (always solid, never dotted) |
   | Contrast | High / Standard / Vivid: how dark logo-coloured pixels must be. Vivid keeps logo colours as bright as MosaicQR does (and tints light pixels more), at some cost to scan rate |
   | Pixel size | 70–100% (never below 60%) |
   | Dark colour, background | Warns when contrast is too low to scan |

5. **Generate designs.** You get 16 candidates, a colour set and a black & white set, each with:
   - **Scan reliability:** share of simulated phone-camera frames that decoded.
   - **Min print size:** smallest width (mm) that still scanned reliably from your chosen distance.
   - **At your print width:** expected scan rate at the size you entered.
   - **Logo match:** how much of the logo the pattern reproduces.

   The **Recommended** pick in each set is the best-looking design that is still phone-safe at
   your print size. Click any design to see a scan rate for each print width, download PNG/SVG,
   or **Save** it with a name and details (see *Saved codes*).
6. **Edit a saved code.** On *Saved codes*, **Edit** opens the code in the generator with its link,
   logo and settings, and generates fresh designs. Pick one and **Replace** the saved code, or
   **Save as new** to keep a variation alongside it. Codes saved before logos were stored open with
   the default logo; choose the original image if it differs.

**Always test the final print with a few real phones** (see *Testing scan reliability*).

## How the logo gets into the pattern

The approach was reverse-engineered from a MosQR code, which decodes to
`https://mosqr.co/<id>?m=qr#<55 random-looking characters>`:

1. **A shaping fragment.** The tool appends `#` plus characters to the link until the text fills
   the QR symbol exactly. Each character is chosen (per mask pattern) so its 8 bits draw the
   image where they land. Browsers never send the `#…` part to the server, so the link still
   works, and the code stays 100% standard. The redirect Worker answers with an explicit empty
   fragment, so the shaping characters don't follow you to the destination page.
2. **An error budget.** The remaining modules (the link itself and the error-correction
   codewords) are flipped to match the image where it matters most. Error correction repairs
   them when scanned. MosQR spends ~92% of the repair capacity this way (12 of 13 codewords per
   block); here the variants spend 20% (*Gentle*) or 60% (*Bold*), and every design's cost is
   measured rather than guessed.

For text that isn't a fragment-friendly http(s) link, the image goes into the pad bytes after
the end-of-data marker instead (decoders ignore them).

Each request produces 8 plans (error correction Q or H × compact or detailed grid × gentle or
bold), rendered in colour and in black & white. The detailed grid is 3 versions finer than the
compact one, except that short links stop at 41×41 (version 6), the largest grid with a single
alignment pattern. Logo-coloured pixels are darkened to the contrast limit. The three corner
finders stay solid so scanners can lock on. Alignment patterns are drawn as round rings with a
centre dot rather than square bullseyes (fully dotted ones broke jsQR), and timing patterns use
the pixel shape.

## Testing scan reliability

**In the tool (automatic).** Every candidate is printed to a virtual camera: rotated ±20°,
skewed, blurred, under- or over-exposed, with sensor noise, at 2.5–6 camera pixels per module.
Each frame is decoded by:

- **ZXing-C++** (WebAssembly build), the family of decoders behind many Android scanner apps;
- **jsQR**, a stricter, quirkier JavaScript decoder;
- **the phone OS's own scanner** when the browser exposes it (`BarcodeDetector` in Chrome on
  Android and macOS), so running the tool on an Android phone tests with Google's scanner.

Print-size estimates are calibrated against MosaicQR, which rates its v8 codes (57 modules
including margin) for 20 mm prints: an equivalent code passes the stress test from 4 camera
pixels per module, so the "15 cm" setting assumes 11.4 camera px per printed mm (about a 1080p
scanner frame at 13 cm). Adjust `PX_PER_MM_AT_150` in `verify.js` once real-phone tests disagree.

**In the real world (recommended before printing a batch):**

- Print a test sheet with your top 2–3 designs at the planned size **and one size smaller**.
- Scan each with the iPhone Camera app (Apple Vision), an Android camera / Google Lens
  (ML Kit), and WeChat or a third-party scanner app, at arm's length and at an angle, in dim
  light. Older and budget Android phones are the strictest.
- Every scan of a short link is counted on the *Short links* page, so a group test shows up as hits.
- For larger campaigns, a cloud device farm with camera image injection (e.g. BrowserStack App
  Automate) can feed your design to many real phones' scanner apps.

## Develop

```sh
npm install
npm test        # encoder, art + fragment layers, styles, scan simulator, generator, Worker API
npm run dev     # serves ./public through the Workers runtime at http://localhost:8787
```

Source layout (`public/` is the whole site):

| File | Role |
|---|---|
| `js/qr.js` | QR encoder (byte mode, v1–40, L/M/Q/H) that exposes the codeword layout |
| `js/art.js` | Image → module targets, pad-byte fitting, error-budget flipping, mask choice |
| `js/fragment.js` | The MosQR model: link + shaping `#fragment` that fills the symbol |
| `js/generate.js` | Plans the 8 variants, renders colour + B/W, scores each candidate |
| `js/gen-worker.js` | Runs `generate.js` in a Web Worker with all available decoders |
| `js/render.js` | Pixel shapes / eye styles → SVG, Canvas and software raster |
| `js/verify.js` | Phone-camera simulator, stress test, print-size estimates, decoder adapters |
| `js/app.js`, `index.html`, `css/` | The QR maker UI |
| `src/worker.js` | Redirect Worker + admin API (short links, saved designs) |
| `links.html`, `js/links.js` | Short-link manager |
| `saved.html`, `js/saved.js` | Saved codes |
| `vendor/jsQR.js` | [jsQR](https://github.com/cozmo/jsQR) (Apache-2.0) |
| `vendor/zxing/` | [zxing-wasm](https://github.com/Sec-ant/zxing-wasm) reader (MIT, ZXing-C++ Apache-2.0) |

## API

The full specification (params, returns, examples, errors) is on the **API** tab, behind the admin
token. It comes from `spec.read`, built from the same method table the Worker enforces.

The API is a small set of named methods, `<domain>.<create|read|update|delete>`, called as
`POST /api/<method>` with a JSON body. Read methods also accept `GET /api/<method>?<params>`. Anything
that isn't plain CRUD sits under the closest method: listing is a `read` without an id, and the raw
image is a `read` with `"format": "svg"`. Every call needs `Authorization: Bearer <token>`.

| Method | Params | Returns | Who |
|---|---|---|---|
| `link.create` | `url`, `label?` | the link (201) | admin |
| `link.read` | `code` | one link | admin, author |
| `link.read` | `limit?`, `offset?` | `{links: […]}`, newest first | admin, author |
| `link.update` | `code`, `url?`, `label?` | the link | admin, author |
| `link.delete` | `code` | `{deleted}` | admin |
| `qr.create` | `name`, `text`, `svg`, `details?`, `author?`, `meta?`, `image?` | the code (201) | admin |
| `qr.read` | `id`, `format?` | one code with `svg` and `image`; with `"format": "svg"` the raw `image/svg+xml` | admin, author* |
| `qr.read` | `author?`, `limit?`, `offset?` | `{designs: […]}` (no SVGs), newest first | admin, author* |
| `qr.update` | `id`, `name?`, `details?`, `text` + `svg`?, `meta?`, `image?`, `new_author?` | the code | admin, author* |
| `qr.delete` | `id` | `{deleted}` | admin, author* |
| `author.create` | `name` | the author with their token (201) | admin |
| `author.read` | `name?` | one author, or `{authors: […]}`, with tokens | admin |
| `author.update` | `name`, `new_name?`, `rotate_token?` | the author | admin |
| `author.delete` | `name` | `{deleted}` | admin |
| `spec.read` | | the specification | admin |

**Tokens.** `ADMIN_TOKEN` is a Wrangler secret and can do everything. **Author tokens** (`qra_…`) are
for other projects' servers: authorize an author on the **Authors** tab (or `author.create`) and they
get their own token. \* An author token only ever reaches its own author's codes (another author's
code answers 404, and naming another author is refused); it can't create codes (they are made in the
generator), move one to another author (`new_author`), or manage authors. For the admin, `author` is
an optional filter. Authors are free text, e.g. an email address or a project name, set with the
generator's Author field and shown on *Saved codes*.

Author tokens are stored so you can **view and copy them again later** on the Authors tab, which
also rotates (new token, the old one stops at once), renames (their codes move with them) and revokes
them. Because they are stored readable, anyone with read access to the D1 database can see them; rotate
any you suspect leaked. The Authors tab also shows **your admin token**: the copy saved in that browser
when you signed in (the server never sends the secret). Lost it? Set a new one with
`npx wrangler secret put ADMIN_TOKEN`.

Errors are `{"error": "…"}` with status 400 (bad params), 401 (missing, wrong or revoked token), 403
(the token can't do that), 404 (unknown method, or nothing with that id/code/name), 405 (wrong HTTP
verb), 409 (author name taken), or 503 (`ADMIN_TOKEN` not configured: the API fails closed). `image`
is the source logo as a PNG data URL (at most 300 kB), kept so the editor can regenerate the code.
SVGs containing scripts, event handlers or links are rejected, and only `http(s)` destinations are
accepted. Keep tokens in server-side secrets, never in browser code.

### Using codes from other projects

Generating a code (planning, rendering, scan-scoring) takes seconds of CPU, far more than a free
Worker request allows, so codes are made in the generator and other projects use them through the API
with their author token:

- **Show the author's codes:** `qr.read {}` lists them; `qr.read {id, format: "svg"}` returns one as
  an SVG for the other project's server to inline or serve from its own pages (a plain `<img>` tag
  can't send the token). Responses may be cached for up to 5 minutes.
- **Edit them:** `qr.update {id, name, details}` renames; `qr.delete {id}` deletes.
- **Change what a printed code opens:** point the code at a short link and update the link when the
  destination should change, e.g. when a new class's check-in link is generated:

  ```
  POST https://qr.dancewithb.fun/api/link.update
  Authorization: Bearer <author token>
  Content-Type: application/json

  {"code": "a", "url": "https://dancewithb.fun/check-in?events=…"}
  ```

## Short links (redirect Worker)

Printed QR codes should not contain the real destination: a long URL makes a denser, harder-to-scan
code, and you can never change it. Instead the code holds `https://yourdomain/c/<code>` and the
Worker redirects (HTTP 302) to wherever that code currently points.

- **Codes** are a counter written with `a–z` then `0–9`: `a, b, … z, 0, 1, … 9, aa, ab, … a9, ba, …`.
  A character is added after `9`, and again after `99`. Codes are never reused, even after a delete.
- **Managing links:** open `/links.html`, enter the admin token, create links, change a destination
  later, delete, and see scan counts. "QR" opens the maker with the short URL filled in.
- **API:** `link.create`, `link.read`, `link.update`, `link.delete` (see *API*).
- **Storage** is one D1 table, created automatically on first use. Each scan costs one read and one
  write; the free plan allows on the order of 100k writes/day (check Cloudflare's current limits).

## Deploy to Cloudflare (free)

`wrangler.jsonc` runs the Worker only for `/c/*` and `/api/*`; everything else is served from
static assets without invoking the Worker.

```sh
npm install
npx wrangler login
npm run deploy                       # also creates the D1 database and binds it as DB
npx wrangler secret put ADMIN_TOKEN  # choose a long random string; it's your login for /links.html
```

Then:

1. **Use your own domain.** `wrangler.jsonc` attaches the custom domain `qr.dancewithb.fun` on
   deploy (the domain's DNS must be on Cloudflare). Use a subdomain: attaching the bare domain
   would replace whatever site already lives there. Printed codes should use this permanent
   domain, not `*.workers.dev`.
2. **Pin the domain into QR codes.** `PUBLIC_BASE_URL` in `wrangler.jsonc` is set to
   `"https://qr.dancewithb.fun"`; change both together if you move it. Short links are then always reported with that origin,
   even if you manage them from another address.
3. Open `https://yourdomain/links.html`, sign in, create a link, and click **QR**.

*Git integration* works too: *Workers & Pages → Create → Import a repository*, empty build command,
deploy command `npx wrangler deploy`; set `ADMIN_TOKEN` under *Settings → Variables and Secrets*.

For local development create `.dev.vars` containing `ADMIN_TOKEN=anything` and run `npm run dev`
(local D1 is simulated; nothing touches production).

## Limitations

- The scan simulator is a model, not a phone. It ranks designs well, but always confirm the
  final print on real devices.
- Logo detail is bounded by the code's capacity (shaping characters plus the error budget). Bold,
  simple, high-contrast logos with transparent backgrounds reproduce best.
- Shaping fragments are appended to web links. Destinations that use `#` routing should go through
  a short link (the redirect drops the fragment).
- Generation runs in a module Web Worker (all current browsers; Safari 15+).
