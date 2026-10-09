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
bold), rendered in colour and in black & white. Logo-coloured pixels are darkened to the
contrast limit; finders, alignment and timing patterns stay solid so scanners can lock on.

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

## Short links (redirect Worker)

Printed QR codes should not contain the real destination: a long URL makes a denser, harder-to-scan
code, and you can never change it. Instead the code holds `https://yourdomain/c/<code>` and the
Worker redirects (HTTP 302) to wherever that code currently points.

- **Codes** are a counter written with `a–z` then `0–9`: `a, b, … z, 0, 1, … 9, aa, ab, … a9, ba, …`.
  A character is added after `9`, and again after `99`. Codes are never reused, even after a delete.
- **Managing links:** open `/links.html`, enter the admin token, create links, change a destination
  later, delete, and see scan counts. "QR" opens the maker with the short URL filled in.
- **API** (all need `Authorization: Bearer <ADMIN_TOKEN>`):
  `POST /api/links {url, label?}`, `GET /api/links`, `PATCH /api/links/<code> {url?, label?}`,
  `DELETE /api/links/<code>`; saved designs: `POST /api/designs {name, details?, text, svg, meta?}`,
  `GET /api/designs`, `GET|PATCH|DELETE /api/designs/<id>`. Saved SVGs containing scripts, event
  handlers or links are rejected. Only `http(s)` destinations are accepted, so the endpoint can't be
  used for `javascript:` links. Without `ADMIN_TOKEN` set, the API refuses everything.
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
