# Branded QR

A self-hosted tool that makes QR codes where **your logo is part of the pattern itself**,
not a sticker placed on top. Upload any square image, enter a link, download a PNG or SVG.

- The QR maker runs 100% in the browser — images never leave the user's machine.
- Deploys to **Cloudflare Workers** (free plan): the site is served as static assets, and a tiny
  redirect Worker backs the short links (`/c/<code>`) so printed codes stay short and editable.
- Any image the browser can decode works: PNG, JPG, WebP, GIF, SVG. Non-square images are
  cropped (or padded) to a square.

## Using it

1. Enter the link or text.
2. Drop in an image. Logos with a transparent background work best: transparent areas are left
   as an ordinary QR code, opaque areas become the logo.
3. Tune it and watch the **scan test** badge:

   | Control | Effect |
   |---|---|
   | Logo sharpness | How much of the code's error-correction capacity is spent matching the logo. Higher = crisper logo, thinner safety margin. |
   | Logo fill | Luminance cut-off. Raise it so mid-tone colours (e.g. a pink) become solid; lower it to leave them sparse. |
   | Grid detail | Minimum QR version. A finer grid shows more logo detail but needs a larger print size. |
   | Error correction | Low = sharpest logo, High = most robust. Medium is a good default. |
   | Photo mode | Dithers shades into dots, for photographs rather than logos. |
   | **Auto-tune** | Finds the sharpest setting that still passes the scan test. |

4. Download PNG or SVG. **Always test the final code with a phone before printing**, and print it
   big enough (rule of thumb: the scanning distance should be at most ~10× the code's width).

Tips: shorter links give a larger, clearer logo (consider a short redirect such as
`yoursite.com/in`); bold, simple, high-contrast logos work best.

## How the logo gets into the pattern

A QR code is a grid of data modules. This tool encodes your link normally, then makes the data
modules *depict* the image, in two ways:

1. **Free pad bytes.** Decoders stop reading at the end-of-data marker and ignore every codeword
   after it. Those bytes are set to whatever reproduces the image, and the Reed-Solomon codes are
   recomputed over them. Modules there match the image exactly, at no cost.
2. **Error budget.** The remaining modules (the link itself and the error-correction codewords)
   are flipped to match the image where it matters most, deliberately creating errors that the
   code's built-in error correction repairs. Only a chosen share of each block's capacity is used
   (the *Logo sharpness* slider), so real-world scuffs, glare, and blur still decode.

Dark modules inside the logo take the logo's colours (darkened enough to read as "dark" to a
scanner), and the three corner finder patterns stay solid black, since dotted finders fail to
detect in many decoders. The mask pattern that fits the image best is chosen out of the 8
allowed by the spec.

## Develop

```sh
npm install
npm test        # encoder, art layer, scan checks (jsQR), and the Worker (runs wrangler dev)
npm run dev     # serves ./public through the Workers runtime at http://localhost:8787
```

Source layout (`public/` is the whole site):

| File | Role |
|---|---|
| `js/qr.js` | QR encoder (byte mode, v1–40, L/M/Q/H) that exposes the codeword layout |
| `js/art.js` | Image → module targets, pad-byte fitting, error-budget flipping, mask choice |
| `js/render.js` | Shapes → SVG / Canvas / software raster |
| `js/verify.js` | Scan test: decodes the render at several resolutions, crisp and blurred |
| `js/app.js`, `index.html`, `css/` | The QR maker UI |
| `src/worker.js` | Redirect Worker + admin API |
| `links.html`, `js/links.js` | Short-link manager UI |
| `vendor/jsQR.js` | [jsQR](https://github.com/cozmo/jsQR) (Apache-2.0), used only for the in-page scan test |

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
  `DELETE /api/links/<code>`. Only `http(s)` destinations are accepted, so the endpoint can't be
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

1. **Use your own domain.** In the Cloudflare dashboard, open the Worker → *Settings → Domains &
   Routes → Add → Custom domain* (the domain's DNS must be on Cloudflare). Printed codes should
   use this permanent domain, not `*.workers.dev`.
2. **Pin the domain into QR codes.** Set `PUBLIC_BASE_URL` in `wrangler.jsonc` to e.g.
   `"https://dancewithb.fun"` and redeploy. Short links are then always reported with that origin,
   even if you manage them from another address.
3. Open `https://yourdomain/links.html`, sign in, create a link, and click **QR**.

*Git integration* works too: *Workers & Pages → Create → Import a repository*, empty build command,
deploy command `npx wrangler deploy`; set `ADMIN_TOKEN` under *Settings → Variables and Secrets*.

For local development create `.dev.vars` containing `ADMIN_TOKEN=anything` and run `npm run dev`
(local D1 is simulated; nothing touches production).

## Limitations

- Fidelity is bounded by the code's capacity: roughly the share of "free" pad bytes plus the
  error budget. Opaque, high-contrast artwork reproduces less exactly than a logo with a
  transparent background; a finer grid and lower error-correction level help.
- The scan test uses jsQR, which is stricter than modern phone cameras in some ways and quirkier
  in others. The code was also checked against ZXing-C++ and OpenCV, but a real-phone test is the
  final word.
