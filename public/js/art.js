// Turns (text, image) into a QR module matrix whose pattern depicts the image
// while still decoding to `text`.
//
// Two mechanisms make the image part of the pattern:
//
//  1. Free pad bytes. Decoders stop reading at the terminator, so every data
//     codeword after it is ignored. We set those bytes to whatever reproduces
//     the image, then compute the Reed-Solomon codes over the result. Modules
//     in those codewords match the image exactly at zero cost.
//
//  2. Error budget. For everything else (the URL itself and the ECC codewords)
//     we deliberately flip modules to match the image and let error correction
//     repair them, spending only a chosen fraction (`strength`) of each block's
//     correction capacity so real-world scanning keeps a safety margin.

import {
  getLayout, pickVersion, buildDataPrefix, addEccAndInterleave,
  maskBit, applyFormat, penaltyScore,
} from './qr.js';

export const WANT_NONE = 0;
export const WANT_DARK = 1;
export const WANT_LIGHT = 2;

const OPAQUE = 0.4; // coverage above which a module counts as "image"

export const luminance = (r, g, b) => (0.299 * r + 0.587 * g + 0.114 * b) / 255;

/**
 * Average an RGBA square image into one colour+coverage per module.
 * The image is centred in the code and covers `scale` of its width.
 */
export function sampleImage(img, size, scale) {
  const N = size * size;
  const a = new Float32Array(N);
  const R = new Float32Array(N);
  const G = new Float32Array(N);
  const B = new Float32Array(N);
  const { data, width: W, height: H } = img;
  const side = scale * size;
  const off = (size - side) / 2;
  for (let my = 0; my < size; my++) {
    for (let mx = 0; mx < size; mx++) {
      const x0 = Math.max(mx, off), x1 = Math.min(mx + 1, off + side);
      const y0 = Math.max(my, off), y1 = Math.min(my + 1, off + side);
      if (x1 <= x0 || y1 <= y0) continue;
      const cov = (x1 - x0) * (y1 - y0);
      const sx0 = ((x0 - off) / side) * W, sx1 = ((x1 - off) / side) * W;
      const sy0 = ((y0 - off) / side) * H, sy1 = ((y1 - off) / side) * H;
      const ix0 = Math.min(W - 1, Math.floor(sx0));
      const iy0 = Math.min(H - 1, Math.floor(sy0));
      const ix1 = Math.min(W, Math.max(ix0 + 1, Math.ceil(sx1)));
      const iy1 = Math.min(H, Math.max(iy0 + 1, Math.ceil(sy1)));
      let sa = 0, sr = 0, sg = 0, sb = 0, n = 0;
      for (let y = iy0; y < iy1; y++)
        for (let x = ix0; x < ix1; x++) {
          const o = (y * W + x) * 4;
          const al = data[o + 3];
          sa += al; sr += data[o] * al; sg += data[o + 1] * al; sb += data[o + 2] * al; n++;
        }
      const i = my * size + mx;
      a[i] = (sa / n / 255) * cov;
      if (sa > 0) { R[i] = sr / sa; G[i] = sg / sa; B[i] = sb / sa; }
    }
  }
  return { a, r: R, g: G, b: B };
}

/** Decide, per data module, whether the image wants it dark or light. */
function computeWants(layout, samples, { threshold, deadzone, halftone }) {
  const { size, fn } = layout;
  const N = size * size;
  const want = new Uint8Array(N);
  const wgt = new Float32Array(N);
  const hasImg = new Uint8Array(N);
  const lum = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    if (fn[i] || samples.a[i] < OPAQUE) continue;
    hasImg[i] = 1;
    lum[i] = luminance(samples.r[i], samples.g[i], samples.b[i]);
  }
  if (halftone) {
    // Floyd-Steinberg error diffusion across the module grid
    const err = new Float32Array(N);
    const shift = 0.5 - threshold;
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        if (!hasImg[i]) continue;
        const v = Math.min(1, Math.max(0, lum[i] + shift)) + err[i];
        const dark = v < 0.5;
        const e = v - (dark ? 0 : 1);
        want[i] = dark ? WANT_DARK : WANT_LIGHT;
        wgt[i] = 0.35 + 0.65 * Math.min(1, Math.abs(lum[i] + shift - 0.5) / 0.5);
        if (x + 1 < size) err[i + 1] += (e * 7) / 16;
        if (y + 1 < size) {
          if (x > 0) err[i + size - 1] += (e * 3) / 16;
          err[i + size] += (e * 5) / 16;
          if (x + 1 < size) err[i + size + 1] += e / 16;
        }
      }
  } else {
    for (let i = 0; i < N; i++) {
      if (!hasImg[i]) continue;
      const d = lum[i] - threshold;
      if (Math.abs(d) <= deadzone) continue; // mid-tones: let the data decide
      want[i] = d < 0 ? WANT_DARK : WANT_LIGHT;
      wgt[i] = 0.25 + 0.75 * Math.min(1, Math.abs(d) / 0.5);
    }
  }
  return { want, wgt, hasImg, lum };
}

/**
 * @param {object} o
 * @param {string} o.text
 * @param {number} o.ecl            0..3 (L,M,Q,H)
 * @param {number} [o.minVersion]   raise for a finer grid (more image detail)
 * @param {{data:Uint8ClampedArray,width:number,height:number}|null} [o.image] square RGBA
 * @param {number} [o.imageScale]   fraction of the code the image spans (0.2-1)
 * @param {number} [o.threshold]    luminance split between dark and light (0-1)
 * @param {number} [o.deadzone]     mid-tone band left to the data (no-halftone mode)
 * @param {number} [o.strength]     share of each block's ECC capacity to spend (0-1)
 * @param {boolean} [o.halftone]    dither photos into dark/light modules
 */
export function planArt(o) {
  const {
    text, ecl, minVersion = 1, image = null, imageScale = 1,
    threshold = 0.5, deadzone = 0.15, strength = 0.6, halftone = false,
  } = o;
  const bytes = new TextEncoder().encode(text);
  const version = pickVersion(bytes.length, ecl, minVersion);
  if (version < 0) throw new Error('Text is too long for a QR code');
  const layout = getLayout(version, ecl);
  const { size, order, rawCodewords: raw } = layout;
  const N = size * size;

  const samples = image
    ? sampleImage(image, size, imageScale)
    : { a: new Float32Array(N), r: new Float32Array(N), g: new Float32Array(N), b: new Float32Array(N) };
  const { want, wgt, hasImg, lum } = computeWants(layout, samples, { threshold, deadzone, halftone });

  const { data: prefixData, prefixLen } = buildDataPrefix(bytes, version, ecl);
  const tCap = Math.floor(layout.eccLen / 2);
  const budget = Math.floor(tCap * strength);

  // mask bit per module, per mask
  const maskGrids = [];
  for (let m = 0; m < 8; m++) {
    const g = new Uint8Array(N);
    for (let i = 0; i < N; i++) g[i] = maskBit(m, i % size, (i / size) | 0) ? 1 : 0;
    maskGrids.push(g);
  }

  let totalWeight = 0;
  for (let i = 0; i < N; i++) if (want[i]) totalWeight += wgt[i];

  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const mg = maskGrids[mask];

    // 1. free pad bytes carry the image
    const data = prefixData.slice();
    for (let d = prefixLen; d < layout.numData; d++) {
      const padByte = (d - prefixLen) % 2 === 0 ? 0xec : 0x11;
      const p = layout.dataPos[d];
      let byte = 0;
      for (let b = 0; b < 8; b++) {
        const mod = order[p * 8 + b];
        const w = want[mod];
        const bit = w ? (w === WANT_DARK ? 1 : 0) ^ mg[mod] : (padByte >> (7 - b)) & 1;
        byte = (byte << 1) | bit;
      }
      data[d] = byte;
    }
    const cw = addEccAndInterleave(layout, data);

    // 2. lay out modules
    const m = new Uint8Array(layout.base);
    for (let i = 0; i < raw * 8; i++) {
      const mod = order[i];
      m[mod] = ((cw[i >>> 3] >>> (7 - (i & 7))) & 1) ^ mg[mod];
    }
    for (let i = raw * 8; i < order.length; i++) {
      const mod = order[i]; // remainder bits are ignored by decoders: free
      m[mod] = want[mod] ? (want[mod] === WANT_DARK ? 1 : 0) : mg[mod];
    }

    // 3. spend the error budget on the heaviest mismatching codewords per block
    const cwWeight = new Float32Array(raw);
    for (let i = 0; i < raw * 8; i++) {
      const mod = order[i];
      if (want[mod] && (m[mod] ? WANT_DARK : WANT_LIGHT) !== want[mod]) cwWeight[i >>> 3] += wgt[mod];
    }
    const perBlock = Array.from({ length: layout.numBlocks }, () => []);
    for (let p = 0; p < raw; p++) if (cwWeight[p] > 0) perBlock[layout.blockOf[p]].push(p);
    let cost = 0;
    const used = new Int32Array(layout.numBlocks);
    perBlock.forEach((list, j) => {
      list.sort((x, y) => cwWeight[y] - cwWeight[x]);
      list.forEach((p, k) => {
        if (k < budget) {
          used[j]++;
          for (let b = 0; b < 8; b++) {
            const mod = order[p * 8 + b];
            if (want[mod] && (m[mod] ? WANT_DARK : WANT_LIGHT) !== want[mod]) m[mod] ^= 1;
          }
        } else cost += cwWeight[p];
      });
    });

    applyFormat(m, layout, mask);
    const pen = penaltyScore(m, size);
    if (!best || cost < best.cost - 1e-6 || (Math.abs(cost - best.cost) <= 1e-6 && pen < best.pen)) {
      best = { mask, m, cost, pen, used };
    }
  }

  let wantCount = 0, matchCount = 0;
  for (let i = 0; i < N; i++)
    if (want[i]) {
      wantCount++;
      if ((best.m[i] ? WANT_DARK : WANT_LIGHT) === want[i]) matchCount++;
    }
  const maxUsed = Math.max(...best.used);

  return {
    version, size, ecl, mask: best.mask,
    dark: best.m, fn: layout.fn,
    want, hasImg, lum, alpha: samples.a, r: samples.r, g: samples.g, b: samples.b,
    stats: {
      freeBytes: layout.numData - prefixLen,
      dataBytes: layout.numData,
      matchedFraction: totalWeight ? 1 - best.cost / totalWeight : 1,
      matchedModules: matchCount,
      wantedModules: wantCount,
      budgetUsed: tCap ? maxUsed / tCap : 0,
      errorCapacity: tCap,
    },
  };
}
