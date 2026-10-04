// QR Code encoder (byte mode, versions 1-40, error correction L/M/Q/H).
//
// Unlike a typical QR library this one exposes the codeword layout, so the art
// layer (art.js) knows which module belongs to which codeword and block.

export const ECL = { L: 0, M: 1, Q: 2, H: 3 };
const FORMAT_BITS = [1, 0, 3, 2]; // indexed by ECL ordinal

// Error-correction codewords per block, indexed [ecl][version]
const ECC_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
// Number of error-correction blocks, indexed [ecl][version]
const NUM_BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

export const MIN_VERSION = 1;
export const MAX_VERSION = 40;

export const sizeOf = (version) => version * 4 + 17;

export function numRawDataModules(ver) {
  let r = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    r -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) r -= 36;
  }
  return r;
}

export function numDataCodewords(ver, ecl) {
  return Math.floor(numRawDataModules(ver) / 8) - ECC_PER_BLOCK[ecl][ver] * NUM_BLOCKS[ecl][ver];
}

export const eccPerBlock = (ver, ecl) => ECC_PER_BLOCK[ecl][ver];
export const numBlocks = (ver, ecl) => NUM_BLOCKS[ecl][ver];

const charCountBits = (ver) => (ver <= 9 ? 8 : 16);

/** Smallest version >= minVersion whose byte-mode capacity fits `byteLen` bytes, or -1. */
export function pickVersion(byteLen, ecl, minVersion = 1) {
  for (let v = Math.max(MIN_VERSION, minVersion); v <= MAX_VERSION; v++) {
    if (4 + charCountBits(v) + 8 * byteLen <= numDataCodewords(v, ecl) * 8) return v;
  }
  return -1;
}

// ---------------------------------------------------------------- GF(256) / Reed-Solomon

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
const gmul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

const generatorCache = new Map();
function rsGenerator(deg) {
  let g = generatorCache.get(deg);
  if (g) return g;
  g = new Uint8Array(deg);
  g[deg - 1] = 1;
  let root = 1;
  for (let i = 0; i < deg; i++) {
    for (let j = 0; j < deg; j++) {
      g[j] = gmul(g[j], root);
      if (j + 1 < deg) g[j] ^= g[j + 1];
    }
    root = gmul(root, 2);
  }
  generatorCache.set(deg, g);
  return g;
}

function rsRemainder(data, start, end, divisor) {
  const deg = divisor.length;
  const rem = new Uint8Array(deg);
  for (let i = start; i < end; i++) {
    const factor = data[i] ^ rem[0];
    rem.copyWithin(0, 1);
    rem[deg - 1] = 0;
    if (factor !== 0) for (let j = 0; j < deg; j++) rem[j] ^= gmul(divisor[j], factor);
  }
  return rem;
}

// ---------------------------------------------------------------- Layout

const layoutCache = new Map();

/**
 * Everything about a (version, ecl) pair that does not depend on the data:
 *  - fn / base: function-pattern flags and their dark values
 *  - order: zigzag list of data-module indices (y*size+x); the first
 *    rawCodewords*8 hold codeword bits (MSB first), the rest are remainder bits
 *  - dataPos[d]: position of logical data codeword d in the interleaved stream
 *  - eccPos[j][e]: position of ECC codeword e of block j
 *  - blockOf[pos]: block id of an interleaved codeword
 */
export function getLayout(version, ecl) {
  const key = version * 4 + ecl;
  let L = layoutCache.get(key);
  if (L) return L;

  const size = sizeOf(version);
  const fn = new Uint8Array(size * size);
  const base = new Uint8Array(size * size);
  const setFn = (x, y, dark) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    fn[y * size + x] = 1;
    base[y * size + x] = dark ? 1 : 0;
  };

  for (let i = 0; i < size; i++) {
    setFn(6, i, i % 2 === 0);
    setFn(i, 6, i % 2 === 0);
  }
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        setFn(cx + dx, cy + dy, d !== 2 && d !== 4);
      }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);

  const alignPos = alignmentPositions(version);
  const n = alignPos.length;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++)
          setFn(alignPos[i] + dx, alignPos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }

  // Reserve format areas (values written per mask later)
  for (let i = 0; i <= 5; i++) setFn(8, i, false);
  setFn(8, 7, false);
  setFn(8, 8, false);
  setFn(7, 8, false);
  for (let i = 9; i < 15; i++) setFn(14 - i, 8, false);
  for (let i = 0; i < 8; i++) setFn(size - 1 - i, 8, false);
  for (let i = 8; i < 15; i++) setFn(8, size - 15 + i, false);
  setFn(8, size - 8, true);

  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) !== 0;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFn(a, b, dark);
      setFn(b, a, dark);
    }
  }

  // Zigzag order of data modules
  const order = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++)
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!fn[y * size + x]) order.push(y * size + x);
      }
  }

  // Block structure & interleave positions
  const raw = Math.floor(numRawDataModules(version) / 8);
  const nb = NUM_BLOCKS[ecl][version];
  const eccLen = ECC_PER_BLOCK[ecl][version];
  const numShort = nb - (raw % nb);
  const shortLen = Math.floor(raw / nb);
  const numData = raw - eccLen * nb;
  const dataPos = new Int32Array(numData);
  const eccPos = Array.from({ length: nb }, () => new Int32Array(eccLen));
  const blockOf = new Int32Array(raw);
  const blockStart = new Int32Array(nb + 1);
  const dataLen = [];
  for (let j = 0; j < nb; j++) {
    dataLen.push(shortLen - eccLen + (j < numShort ? 0 : 1));
    blockStart[j + 1] = blockStart[j] + dataLen[j];
  }
  let pos = 0;
  for (let i = 0; i <= shortLen; i++)
    for (let j = 0; j < nb; j++) {
      if (i === shortLen - eccLen && j < numShort) continue; // padding slot of short blocks
      if (i < shortLen - eccLen + (j < numShort ? 0 : 1)) dataPos[blockStart[j] + i] = pos;
      else eccPos[j][i - (shortLen - eccLen + 1)] = pos;
      blockOf[pos] = j;
      pos++;
    }

  L = {
    version, ecl, size, fn, base, order: Int32Array.from(order),
    rawCodewords: raw, numData, numBlocks: nb, eccLen, blockStart, dataLen, dataPos, eccPos, blockOf,
  };
  layoutCache.set(key, L);
  return L;
}

function alignmentPositions(ver) {
  if (ver === 1) return [];
  const n = Math.floor(ver / 7) + 2;
  const size = sizeOf(ver);
  const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
  const r = [6];
  for (let pos = size - 7; r.length < n; pos -= step) r.splice(1, 0, pos);
  return r;
}

// ---------------------------------------------------------------- Encoding

/**
 * Data codewords for byte mode up to and including the terminator and
 * byte alignment. Returns {data, prefixLen}; bytes at index >= prefixLen are
 * pad bytes (decoders stop at the terminator and ignore them), initialised to
 * the standard 0xEC/0x11 pattern.
 */
export function buildDataPrefix(bytes, version, ecl) {
  const cap = numDataCodewords(version, ecl);
  const bits = [];
  const put = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  put(0x4, 4);
  put(bytes.length, charCountBits(version));
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, cap * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const data = new Uint8Array(cap);
  for (let i = 0; i < bits.length; i++) data[i >>> 3] |= bits[i] << (7 - (i & 7));
  const prefixLen = bits.length >>> 3;
  for (let i = prefixLen, k = 0; i < cap; i++, k++) data[i] = k % 2 === 0 ? 0xec : 0x11;
  return { data, prefixLen };
}

/** Append Reed-Solomon ECC to `data` (length numData) and interleave. */
export function addEccAndInterleave(layout, data) {
  const out = new Uint8Array(layout.rawCodewords);
  const divisor = rsGenerator(layout.eccLen);
  for (let j = 0; j < layout.numBlocks; j++) {
    const s = layout.blockStart[j];
    const e = layout.blockStart[j + 1];
    for (let i = s; i < e; i++) out[layout.dataPos[i]] = data[i];
    const ecc = rsRemainder(data, s, e, divisor);
    for (let i = 0; i < layout.eccLen; i++) out[layout.eccPos[j][i]] = ecc[i];
  }
  return out;
}

export function maskBit(mask, x, y) {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return ((((x * y) % 2) + ((x * y) % 3)) % 2) === 0;
    default: return ((((x + y) % 2) + ((x * y) % 3)) % 2) === 0;
  }
}

/** Write the 15 format bits (and the always-dark module) into `matrix`. */
export function applyFormat(matrix, layout, mask) {
  const { size, ecl } = layout;
  const data = (FORMAT_BITS[ecl] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const bit = (i) => (bits >>> i) & 1;
  const set = (x, y, v) => { matrix[y * size + x] = v; };
  for (let i = 0; i <= 5; i++) set(8, i, bit(i));
  set(8, 7, bit(6));
  set(8, 8, bit(7));
  set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
  set(8, size - 8, 1);
}

/** Standard QR penalty score (lower is better); used to pick a mask. */
export function penaltyScore(m, size) {
  let score = 0;
  const at = (x, y) => m[y * size + x];
  for (let pass = 0; pass < 2; pass++) {
    for (let a = 0; a < size; a++) {
      let run = 1;
      let prev = pass ? at(a, 0) : at(0, a);
      for (let b = 1; b < size; b++) {
        const v = pass ? at(a, b) : at(b, a);
        if (v === prev) {
          run++;
          if (run === 5) score += 3;
          else if (run > 5) score += 1;
        } else run = 1;
        prev = v;
      }
      // finder-like 1:1:3:1:1 patterns with 4 light modules on either side
      const line = [];
      for (let b = 0; b < size; b++) line.push(pass ? at(a, b) : at(b, a));
      for (let b = 0; b + 11 <= size; b++) {
        const w = line.slice(b, b + 11).join('');
        if (w === '10111010000' || w === '00001011101') score += 40;
      }
    }
  }
  for (let y = 0; y < size - 1; y++)
    for (let x = 0; x < size - 1; x++) {
      const v = at(x, y);
      if (v === at(x + 1, y) && v === at(x, y + 1) && v === at(x + 1, y + 1)) score += 3;
    }
  let dark = 0;
  for (let i = 0; i < size * size; i++) dark += m[i];
  const total = size * size;
  score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return score;
}

/**
 * Plain (un-styled) QR encoding. Returns {version, size, modules, mask}.
 */
export function encodePlain(text, ecl = ECL.M, minVersion = 1) {
  const bytes = new TextEncoder().encode(text);
  const version = pickVersion(bytes.length, ecl, minVersion);
  if (version < 0) throw new Error('Text is too long for a QR code');
  const layout = getLayout(version, ecl);
  const { data } = buildDataPrefix(bytes, version, ecl);
  const cw = addEccAndInterleave(layout, data);
  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const m = new Uint8Array(layout.base);
    for (let i = 0; i < layout.rawCodewords * 8; i++) {
      const idx = layout.order[i];
      const bit = (cw[i >>> 3] >>> (7 - (i & 7))) & 1;
      m[idx] = bit ^ (maskBit(mask, idx % layout.size, (idx / layout.size) | 0) ? 1 : 0);
    }
    applyFormat(m, layout, mask);
    const p = penaltyScore(m, layout.size);
    if (!best || p < best.p) best = { p, m, mask };
  }
  return { version, size: layout.size, modules: best.m, mask: best.mask };
}
