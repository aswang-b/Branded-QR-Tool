# Branded QR

A self-hosted tool that makes QR codes where **your logo is part of the pattern itself**,
not a sticker placed on top. Upload any square image, enter a link, download a PNG or SVG.

- Runs 100% in the browser — images and links never leave the user's machine.
- No backend: it deploys to **Cloudflare Workers as static assets**, which fits the free plan.
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
npm test        # encoder, art layer, rendering, scan checks (uses jsQR)
npm run dev     # serves ./public through the Workers runtime at http://localhost:8787
```

Source layout (`public/` is the whole site):

| File | Role |
|---|---|
| `js/qr.js` | QR encoder (byte mode, v1–40, L/M/Q/H) that exposes the codeword layout |
| `js/art.js` | Image → module targets, pad-byte fitting, error-budget flipping, mask choice |
| `js/render.js` | Shapes → SVG / Canvas / software raster |
| `js/verify.js` | Scan test: decodes the render at several resolutions, crisp and blurred |
| `js/app.js`, `index.html`, `css/` | The UI |
| `vendor/jsQR.js` | [jsQR](https://github.com/cozmo/jsQR) (Apache-2.0), used only for the in-page scan test |

## Deploy to Cloudflare (free)

`wrangler.jsonc` configures an assets-only Worker: there is no Worker script, so nothing runs
per request, and static asset requests are free and unlimited on the Workers free plan.

**Option A — CLI**

```sh
npm install
npx wrangler login
npm run deploy      # publishes to https://branded-qr-tool.<your-subdomain>.workers.dev
```

**Option B — Git integration**

In the Cloudflare dashboard: *Workers & Pages → Create → Import a repository*, pick this repo.
Leave the build command empty; the deploy command is `npx wrangler deploy`. Every push to the
production branch redeploys.

To use your own domain (e.g. `qr.yoursite.com`), add a custom domain to the Worker under
*Settings → Domains & Routes*. Change `name` in `wrangler.jsonc` if you want a different
`workers.dev` subdomain.

## Limitations

- Fidelity is bounded by the code's capacity: roughly the share of "free" pad bytes plus the
  error budget. Opaque, high-contrast artwork reproduces less exactly than a logo with a
  transparent background; a finer grid and lower error-correction level help.
- The scan test uses jsQR, which is stricter than modern phone cameras in some ways and quirkier
  in others. The code was also checked against ZXing-C++ and OpenCV, but a real-phone test is the
  final word.
