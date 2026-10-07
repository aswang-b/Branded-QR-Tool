import zlib from 'node:zlib';
import fs from 'node:fs';

/** RGBA square canvas helper for synthetic test images. */
export function makeImage(w, paint) {
  const data = new Uint8ClampedArray(w * w * 4);
  for (let y = 0; y < w; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = paint(x / w, y / w);
      const o = (y * w + x) * 4;
      data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = a;
    }
  return { data, width: w, height: w };
}

const inRound = (u, v, x0, y0, x1, y1, r) => {
  if (u < x0 || u > x1 || v < y0 || v > y1) return false;
  const cx = Math.min(Math.max(u, x0 + r), x1 - r), cy = Math.min(Math.max(v, y0 + r), y1 - r);
  return (u - cx) ** 2 + (v - cy) ** 2 <= r * r;
};

/** Pink rounded tile with a black "face" and white cut-out, transparent outside (like the sample). */
export const pinkLogo = (w = 256) => makeImage(w, (u, v) => {
  if (!inRound(u, v, 0.15, 0.15, 0.85, 0.85, 0.2)) return [0, 0, 0, 0];
  if ((u - 0.5) ** 2 + (v - 0.45) ** 2 < 0.03) return [0, 0, 0, 255];
  if (inRound(u, v, 0.3, 0.68, 0.7, 0.76, 0.03)) return [255, 255, 255, 255];
  return [255, 75, 105, 255];
});

/** Bold black ring + bar on opaque white. */
export const bwLogo = (w = 256) => makeImage(w, (u, v) => {
  const d = Math.hypot(u - 0.5, v - 0.42);
  if (d < 0.3 && d > 0.17) return [0, 0, 0, 255];
  if (inRound(u, v, 0.25, 0.78, 0.75, 0.88, 0.04)) return [0, 0, 0, 255];
  return [255, 255, 255, 255];
});

/** Soft radial photo-like gradient (for halftone mode). */
export const gradient = (w = 256) => makeImage(w, (u, v) => {
  const d = Math.hypot(u - 0.5, v - 0.5) * 1.6;
  const l = Math.max(0, Math.min(255, 255 * (1 - d)));
  return [l, l * 0.8, l * 0.6, 255];
});

function crc32(buf) {
  let c, crc = ~0;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return ~crc >>> 0;
}
export function writePng(path, { data, width, height }) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    Buffer.from(data.buffer, data.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  const chunk = (type, body) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
    const td = Buffer.concat([Buffer.from(type), body]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  fs.writeFileSync(path, Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]));
}

/** ZXing-C++ (WebAssembly) set up to load its wasm from node_modules, as the browser loads it from /vendor. */
let zxingReady = null;
export async function zxing() {
  zxingReady ??= (async () => {
    const { readBarcodes, prepareZXingModule } = await import('zxing-wasm/reader');
    const w = fs.readFileSync(new URL('../node_modules/zxing-wasm/dist/reader/zxing_reader.wasm', import.meta.url));
    prepareZXingModule({ overrides: { wasmBinary: w.buffer.slice(w.byteOffset, w.byteOffset + w.byteLength) }, fireImmediately: true });
    return readBarcodes;
  })();
  return zxingReady;
}
