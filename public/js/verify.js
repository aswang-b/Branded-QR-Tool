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
