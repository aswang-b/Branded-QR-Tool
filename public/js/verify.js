// Scan check: renders the code and tries to decode it at several resolutions,
// crisp and blurred (a rough stand-in for a phone camera). Decoders can be
// finicky about particular pixel sizes, so we report a pass rate rather than
// trusting a single attempt.

import { rasterize } from './render.js';

/** Area-average downscale of an RGBA image to `newW` pixels square. */
export function boxResize(img, newW) {
  const { data, width: W } = img;
  const out = new Uint8ClampedArray(newW * newW * 4);
  const k = W / newW;
  for (let y = 0; y < newW; y++) {
    const y0 = Math.floor(y * k), y1 = Math.max(y0 + 1, Math.floor((y + 1) * k));
    for (let x = 0; x < newW; x++) {
      const x0 = Math.floor(x * k), x1 = Math.max(x0 + 1, Math.floor((x + 1) * k));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1; yy++)
        for (let xx = x0; xx < x1; xx++) {
          const o = (yy * W + xx) * 4;
          r += data[o]; g += data[o + 1]; b += data[o + 2]; n++;
        }
      const o = (y * newW + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
    }
  }
  return { data: out, width: newW, height: newW };
}

const tryDecode = (jsQR, img, text) => {
  const r = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
  return !!r && r.data === text;
};

const CLEAN_PPM = [6, 7, 9, 10, 12];
const SOFT_PPM = [3, 3.5, 4, 5];

/**
 * @param jsQR  the jsQR function (global in the browser, import in Node)
 * @returns {{ok:boolean, clean:number, soft:number, cleanTotal:number, softTotal:number}}
 *   ok: decodes crisp at most scales and survives blur at most scales.
 */
export function verifyScan(rendered, text, jsQR) {
  const big = rasterize(rendered, 12);
  let clean = 0;
  for (const ppm of CLEAN_PPM) {
    const img = ppm === 12 ? big : rasterize(rendered, ppm);
    if (tryDecode(jsQR, img, text)) clean++;
  }
  let soft = 0;
  for (const ppm of SOFT_PPM) {
    if (tryDecode(jsQR, boxResize(big, Math.round(rendered.total * ppm)), text)) soft++;
  }
  return {
    ok: clean >= Math.ceil(CLEAN_PPM.length * 0.6) && soft >= Math.ceil(SOFT_PPM.length * 0.5),
    clean, soft, cleanTotal: CLEAN_PPM.length, softTotal: SOFT_PPM.length,
  };
}

// ---------------------------------------------------------------- phone-camera stress test

/** Small deterministic PRNG so scores are reproducible. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function toGray({ data, width }) {
  const g = new Float32Array(width * width);
  for (let i = 0; i < g.length; i++) g[i] = (0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]) / 255;
  return g;
}

/**
 * One simulated phone-camera frame of a printed code: the code spans
 * `ppm` camera pixels per module, rotated, slightly skewed, blurred, with
 * exposure error and sensor noise, on paper.
 */
export function simulateShot(gray, srcW, total, ppm, rng) {
  const PAPER = 0.92;
  const outW = Math.max(24, Math.round(total * ppm * 1.5));
  const scale = srcW / (total * ppm);
  const ang = ((rng() * 2 - 1) * 20 * Math.PI) / 180;
  const shear = (rng() * 2 - 1) * 0.08;
  const cos = Math.cos(ang), sin = Math.sin(ang);
  const co = outW / 2, cs = srcW / 2;
  const sample = (x, y) => {
    if (x < 0 || y < 0 || x >= srcW - 1 || y >= srcW - 1) return PAPER;
    const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * srcW + x0;
    const top = gray[i] * (1 - fx) + gray[i + 1] * fx;
    const bot = gray[i + srcW] * (1 - fx) + gray[i + srcW + 1] * fx;
    return Math.min(PAPER + 0.03, top * (1 - fy) + bot * fy);
  };
  let img = new Float32Array(outW * outW);
  for (let oy = 0; oy < outW; oy++)
    for (let ox = 0; ox < outW; ox++) {
      let acc = 0;
      for (const [dx, dy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
        const ry = oy + dy - co, rx = ox + dx - co + shear * ry;
        acc += sample((rx * cos + ry * sin) * scale + cs, (-rx * sin + ry * cos) * scale + cs);
      }
      img[oy * outW + ox] = acc / 4;
    }
  // focus / motion blur: separable 3-tap kernel, sigma 0.4-1.1 camera px
  const sigma = 0.4 + rng() * 0.7;
  const a = Math.min(0.3, (sigma * sigma) / 2);
  for (const horizontal of [true, false]) {
    const next = new Float32Array(img.length);
    for (let y = 0; y < outW; y++)
      for (let x = 0; x < outW; x++) {
        const i = y * outW + x;
        const p = horizontal ? (x > 0 ? i - 1 : i) : (y > 0 ? i - outW : i);
        const n = horizontal ? (x < outW - 1 ? i + 1 : i) : (y < outW - 1 ? i + outW : i);
        next[i] = a * img[p] + (1 - 2 * a) * img[i] + a * img[n];
      }
    img = next;
  }
  const gain = 0.65 + rng() * 0.45, offset = -0.08 + rng() * 0.13, noise = 0.01 + rng() * 0.025;
  const out = new Uint8ClampedArray(outW * outW * 4);
  for (let i = 0; i < img.length; i++) {
    const v = (img[i] * gain + offset + (rng() + rng() - 1) * noise) * 255;
    out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = v;
    out[i * 4 + 3] = 255;
  }
  return { data: out, width: outW, height: outW };
}

export const STRESS_PPMS = [2.5, 3, 3.5, 4, 5, 6];
const PASS_RATE = 0.75;

/**
 * Decode many simulated camera frames with every decoder.
 * @param decoders [{name, decode: async (imageLike) => string|null}]
 * @returns {{ladder: {ppm:number, rate:number}[], byDecoder: Record<string, number>,
 *            reliability: number, minPpm: number|null}}
 *   reliability, byDecoder: pass rates over realistic framings (>= 3 px/module)
 *   minPpm: smallest framing from which every larger one passes >= 75%
 */
export async function stressTest(rendered, text, decoders, { ppms = STRESS_PPMS, trials = 3, seed = 1, srcPpm = 8 } = {}) {
  const src = rasterize(rendered, srcPpm);
  const gray = toGray(src);
  const rng = mulberry32(seed);
  const ladder = [];
  const REALISTIC = 3; // px/module; below this is a deliberately harsh, far-away framing
  const totals = Object.fromEntries(decoders.map((d) => [d.name, 0]));
  for (const ppm of ppms) {
    let pass = 0;
    for (let t = 0; t < trials; t++) {
      const shot = simulateShot(gray, src.width, rendered.total, ppm, rng);
      for (const d of decoders) {
        let ok = false;
        try { ok = (await d.decode(shot)) === text; } catch { ok = false; }
        if (ok) { pass++; if (ppm >= REALISTIC) totals[d.name]++; }
      }
    }
    ladder.push({ ppm, rate: pass / (trials * decoders.length) });
  }
  const realistic = ladder.filter((l) => l.ppm >= REALISTIC);
  let minPpm = null;
  for (let i = ladder.length - 1; i >= 0 && ladder[i].rate >= PASS_RATE; i--) minPpm = ladder[i].ppm;
  return {
    ladder,
    byDecoder: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, v / (trials * realistic.length)])),
    reliability: realistic.reduce((s, l) => s + l.rate, 0) / realistic.length,
    minPpm,
  };
}

/** Camera pixels per printed mm for a typical phone scanner feed (1280 px wide, ~66° FOV). */
export const cameraPxPerMm = (distanceMm = 150) => 1280 / (2 * distanceMm * Math.tan((66 * Math.PI) / 360));

/** Smallest print width (mm, incl. margin) at which the code passed the stress test. */
export const minPrintMm = (minPpm, total, distanceMm = 150) =>
  minPpm == null ? null : (total * minPpm) / cameraPxPerMm(distanceMm);

/** Expected pass rate at a given print width, interpolated from the ladder (null if smaller than tested). */
export function rateAtPrint(ladder, printMm, total, distanceMm = 150) {
  const ppm = (printMm / total) * cameraPxPerMm(distanceMm);
  if (ppm < ladder[0].ppm) return null;
  for (let i = 1; i < ladder.length; i++) {
    if (ppm <= ladder[i].ppm) {
      const a = ladder[i - 1], b = ladder[i], t = (ppm - a.ppm) / (b.ppm - a.ppm);
      return a.rate + (b.rate - a.rate) * t;
    }
  }
  return ladder[ladder.length - 1].rate;
}

// ---------------------------------------------------------------- decoder adapters

const asImageData = (img) =>
  typeof ImageData !== 'undefined' ? new ImageData(img.data, img.width, img.height) : { ...img, colorSpace: 'srgb' };

export const jsqrDecoder = (jsQR) => ({
  name: 'jsQR',
  decode: async (img) => jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' })?.data ?? null,
});

/** ZXing-C++ compiled to WebAssembly (zxing-wasm's readBarcodes). */
export const zxingDecoder = (readBarcodes) => ({
  name: 'ZXing',
  decode: async (img) =>
    (await readBarcodes(asImageData(img), { formats: ['QRCode'], tryHarder: true, maxNumberOfSymbols: 1 }))[0]?.text ?? null,
});

/** The platform's own scanner where the browser exposes it (Chrome on Android/macOS). */
export const nativeDecoder = (BarcodeDetectorCtor) => {
  const det = new BarcodeDetectorCtor({ formats: ['qr_code'] });
  return {
    name: 'Phone OS',
    decode: async (img) => (await det.detect(asImageData(img)))[0]?.rawValue ?? null,
  };
};
