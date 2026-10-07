// The "MosQR model": instead of hiding the image in pad bytes (which decoders
// ignore but the QR spec says should be 0xEC/0x11), append a URL fragment
// (#...) whose characters are chosen so their bits draw the image, and make
// the link fill the symbol's capacity exactly. Browsers never send the
// fragment to the server, so the link still works, and the code stays fully
// standard. The remaining modules are matched with the error budget, as in
// art.js.
//
// Reverse-engineered from a MosQR code: https://mosqr.co/<id>?m=qr#<55 chars of [0-9a-z]>
// filling a version 8-H symbol exactly, plus 12 of 13 correctable codewords per block.

import { getLayout, numDataCodewords, MAX_VERSION } from './qr.js';
import { planArt, buildTargets, maskGrid, WANT_DARK } from './art.js';

/** RFC 3986 "unreserved" characters: safe in a fragment without escaping. */
export const FRAGMENT_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';

/** Fragment mode needs an http(s) URL that has no fragment of its own. */
export const supportsFragment = (text) => /^https?:\/\/[^\s#]+$/i.test(text.trim());

const utf8Length = (s) => new TextEncoder().encode(s).length;

/** How many fragment characters fit after `base#` in this version/ecl. */
export function fragmentRoom(base, version, ecl) {
  const cc = version <= 9 ? 8 : 16;
  return Math.floor((numDataCodewords(version, ecl) * 8 - 4 - cc) / 8) - utf8Length(base) - 1;
}

/** Smallest version >= minVersion leaving at least `minRoom` fragment characters. */
export function pickFragmentVersion(base, ecl, minVersion = 1, minRoom = 8) {
  for (let v = Math.max(1, minVersion); v <= MAX_VERSION; v++) if (fragmentRoom(base, v, ecl) >= minRoom) return v;
  return -1;
}

/**
 * Choose each fragment character so its 8 bits best match the image for one
 * mask. Characters occupy disjoint bit positions, so a per-character
 * exhaustive choice is optimal for the data region.
 */
export function fitFragment(base, layout, targets, mask, alphabet = FRAGMENT_ALPHABET) {
  const { version, ecl, size, order, dataPos } = layout;
  const cc = version <= 9 ? 8 : 16;
  const room = fragmentRoom(base, version, ecl);
  const start0 = 4 + cc + 8 * (utf8Length(base) + 1);
  const mg = maskGrid(size, mask);
  const { want, wgt } = targets;
  const codes = Array.from(alphabet, (c) => c.charCodeAt(0));
  let frag = '';
  for (let i = 0; i < room; i++) {
    const start = start0 + 8 * i;
    const mods = [];
    for (let b = 0; b < 8; b++) {
      const k = start + b;
      mods.push(order[dataPos[k >> 3] * 8 + (k & 7)]);
    }
    let bestCode = codes[0], bestScore = -Infinity;
    for (const code of codes) {
      let score = 0;
      for (let b = 0; b < 8; b++) {
        const mod = mods[b];
        if (!want[mod]) continue;
        const dark = ((code >> (7 - b)) & 1) ^ mg[mod];
        score += (dark === 1) === (want[mod] === WANT_DARK) ? wgt[mod] : -wgt[mod];
      }
      if (score > bestScore) { bestScore = score; bestCode = code; }
    }
    frag += String.fromCharCode(bestCode);
  }
  return `${base}#${frag}`;
}

/**
 * Plan a code in fragment mode. Same options as planArt, plus:
 * @param {string} o.link        http(s) URL without a fragment
 * @param {number} [o.version]   exact version (default: smallest with room >= 8)
 * @returns planArt result + {link, fragmentLength}
 */
export function planFragment(o) {
  const link = o.link.trim();
  if (!supportsFragment(link)) throw new Error('Fragment mode needs an http(s) link without a # part');
  const version = o.version ?? pickFragmentVersion(link, o.ecl, o.minVersion ?? 1);
  if (version < 0 || fragmentRoom(link, version, o.ecl) < 1) throw new Error('Link is too long for this grid size');
  const layout = getLayout(version, o.ecl);
  const targets = buildTargets(layout, o.image, o);
  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const text = fitFragment(link, layout, targets, mask, o.alphabet);
    const plan = planArt({ ...o, text, minVersion: version, masks: [mask], targets, freePadding: false });
    if (plan.version !== version) continue;
    const s = plan.stats;
    if (!best || s.matchedFraction > best.stats.matchedFraction + 1e-9 ||
        (Math.abs(s.matchedFraction - best.stats.matchedFraction) <= 1e-9 && s.penalty < best.stats.penalty)) best = plan;
  }
  return { ...best, link, fragmentLength: best.text.length - link.length - 1 };
}
