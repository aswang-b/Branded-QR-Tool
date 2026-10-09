// Rendering of a planned QR (see art.js) into vector shapes, with three
// backends: SVG text, Canvas 2D, and a tiny software rasterizer (used for the
// scan checks so they behave identically in the browser and in Node tests).
//
// Shape records (module units, quiet zone included):
//   {t:'r', x, y, w, h, rx, c}                      rounded rectangle
//   {t:'c', cx, cy, r, c}                           circle
//   {t:'ring', x, y, w, h, rx, hx, hy, hw, hh, hrx, c}  rounded rect with a rounded hole

import { WANT_LIGHT, luminance } from './art.js';

export const DEFAULT_STYLE = {
  fg: [0, 0, 0],            // colour of dark modules outside the image
  bg: [255, 255, 255],      // background, or null for transparent
  shape: 'dots',            // 'squares' | 'rounded' | 'dots' | 'connected'
  eyes: 'square',           // finder style: 'square' | 'rounded' | 'dot'
  dotScale: 0.9,            // module fill ratio
  keepColors: true,         // tint dark modules with the image colours
  maxLum: 0.45,             // brightest allowed tinted dark module (0-1); lower = more contrast
  tintLight: false,         // also tint light modules inside the image
  lightLum: 0.86,           // tinted light modules are lightened to at least this (0-1)
  quiet: 4,                 // quiet zone, in modules
};

// Below this a module is too small a target for cheap phone cameras.
export const MIN_DOT_SCALE = 0.6;

const hex = (c) => '#' + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');

// The three corner finders (with separators and format bits) stay in the
// foreground colour; other structural modules may take the image colour.
function inFinderZone(i, size) {
  const x = i % size, y = (i / size) | 0;
  return (x < 9 && y < 9) || (x >= size - 8 && y < 9) || (x < 9 && y >= size - 8);
}

/** The 7x7 finder pattern proper (not separators/format bits). */
function inFinderCore(x, y, size) {
  return (x < 7 && y < 7) || (x >= size - 7 && y < 7) || (x < 7 && y >= size - 7);
}

function darkColor(plan, i, s) {
  if (!s.keepColors) return s.fg;
  const c = [plan.r[i], plan.g[i], plan.b[i]];
  const L = luminance(c[0], c[1], c[2]);
  if (plan.fn[i]) {
    // alignment / timing / version modules: tint only where the image is dark-ish
    if (inFinderZone(i, plan.size) || plan.alpha[i] < 0.4 || L > 0.65) return s.fg;
  } else if (!plan.hasImg[i] || plan.want[i] === WANT_LIGHT) {
    return s.fg;
  }
  if (L > s.maxLum) {
    const k = s.maxLum / L;
    return c.map((v) => v * k);
  }
  return c;
}

function lightColor(plan, i, target) {
  const c = [plan.r[i], plan.g[i], plan.b[i]];
  const L = luminance(c[0], c[1], c[2]);
  if (L >= target) return c;
  const t = (target - L) / (1 - L);
  return c.map((v) => v + (255 - v) * t);
}

function eyeShapes(cx, cy, style, color) {
  // cx, cy: top-left of the 7x7 finder, in module units (quiet zone applied)
  const out = [];
  if (style === 'rounded') {
    out.push({ t: 'ring', x: cx, y: cy, w: 7, h: 7, rx: 1.6, hx: cx + 1, hy: cy + 1, hw: 5, hh: 5, hrx: 1.0, c: color });
    out.push({ t: 'r', x: cx + 2, y: cy + 2, w: 3, h: 3, rx: 0.8, c: color });
  } else { // 'dot'
    out.push({ t: 'ring', x: cx, y: cy, w: 7, h: 7, rx: 2.2, hx: cx + 1, hy: cy + 1, hw: 5, hh: 5, hrx: 1.6, c: color });
    out.push({ t: 'c', cx: cx + 3.5, cy: cy + 3.5, r: 1.55, c: color });
  }
  return out;
}

/** @returns {{shapes: object[], total: number, bg: number[]|null}} sizes in module units */
export function buildShapes(plan, style = {}) {
  const s = { ...DEFAULT_STYLE, ...style };
  const { size, dark } = plan;
  const q = s.quiet;
  const total = size + 2 * q;
  const d = Math.max(MIN_DOT_SCALE, Math.min(1, s.dotScale));
  const shapes = [];
  const isData = (x, y) => x >= 0 && y >= 0 && x < size && y < size && dark[y * size + x] && !plan.fn[y * size + x];

  if (s.tintLight && s.keepColors) {
    for (let i = 0; i < size * size; i++) {
      if (dark[i] || plan.fn[i] || !plan.hasImg[i]) continue;
      // Black/grey logo areas would only turn grey: keep those light modules white.
      if (Math.max(plan.r[i], plan.g[i], plan.b[i]) - Math.min(plan.r[i], plan.g[i], plan.b[i]) < 40) continue;
      const x = i % size, y = (i / size) | 0;
      shapes.push({ t: 'r', x: x + q - 0.01, y: y + q - 0.01, w: 1.02, h: 1.02, rx: 0, c: lightColor(plan, i, s.lightLum) });
    }
  }

  const customEyes = s.eyes === 'rounded' || s.eyes === 'dot';
  if (customEyes) {
    for (const [fx, fy] of [[0, 0], [size - 7, 0], [0, size - 7]]) shapes.push(...eyeShapes(fx + q, fy + q, s.eyes, s.fg));
  }

  for (let i = 0; i < size * size; i++) {
    if (!dark[i]) continue;
    const x = i % size, y = (i / size) | 0;
    const px = x + q, py = y + q;
    const color = darkColor(plan, i, s);
    if (plan.fn[i]) {
      // Structural patterns stay solid, connected squares: scanners locate the
      // code by them, and dotted finders fail to detect in many decoders.
      if (customEyes && inFinderCore(x, y, size)) continue;
      shapes.push({ t: 'r', x: px - 0.01, y: py - 0.01, w: 1.02, h: 1.02, rx: 0, c: color });
      continue;
    }
    const o = (1 - d) / 2;
    if (s.shape === 'dots') {
      shapes.push({ t: 'c', cx: px + 0.5, cy: py + 0.5, r: d / 2, c: color });
    } else if (s.shape === 'connected') {
      // rounded blobs that bridge into dark right/lower neighbours
      shapes.push({ t: 'r', x: px + o, y: py + o, w: d, h: d, rx: d * 0.5, c: color });
      if (isData(x + 1, y)) shapes.push({ t: 'r', x: px + 0.5, y: py + o, w: 1, h: d, rx: 0, c: color });
      if (isData(x, y + 1)) shapes.push({ t: 'r', x: px + o, y: py + 0.5, w: d, h: 1, rx: 0, c: color });
    } else {
      const w = d >= 0.999 ? 1.02 : d; // tiny overlap hides hairline seams
      const ow = (1 - w) / 2;
      shapes.push({ t: 'r', x: px + ow, y: py + ow, w, h: w, rx: s.shape === 'rounded' ? w * 0.3 : 0, c: color });
    }
  }
  return { shapes, total, bg: s.bg };
}

const num = (v) => String(Math.round(v * 1000) / 1000);

function rrPath(x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  if (r <= 0) return `M${num(x)} ${num(y)}h${num(w)}v${num(h)}h${num(-w)}Z`;
  return `M${num(x + r)} ${num(y)}h${num(w - 2 * r)}a${num(r)} ${num(r)} 0 0 1 ${num(r)} ${num(r)}v${num(h - 2 * r)}` +
    `a${num(r)} ${num(r)} 0 0 1 ${num(-r)} ${num(r)}h${num(-(w - 2 * r))}a${num(r)} ${num(r)} 0 0 1 ${num(-r)} ${num(-r)}` +
    `v${num(-(h - 2 * r))}a${num(r)} ${num(r)} 0 0 1 ${num(r)} ${num(-r)}Z`;
}

export function toSVG({ shapes, total, bg }, pixelSize = 1024) {
  const groups = new Map();
  for (const sh of shapes) {
    const key = hex(sh.c);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(sh);
  }
  let body = '';
  for (const [color, list] of groups) {
    body += `<g fill="${color}">`;
    for (const sh of list) {
      if (sh.t === 'c') body += `<circle cx="${num(sh.cx)}" cy="${num(sh.cy)}" r="${num(sh.r)}"/>`;
      else if (sh.t === 'ring') body += `<path fill-rule="evenodd" d="${rrPath(sh.x, sh.y, sh.w, sh.h, sh.rx)}${rrPath(sh.hx, sh.hy, sh.hw, sh.hh, sh.hrx)}"/>`;
      else body += `<rect x="${num(sh.x)}" y="${num(sh.y)}" width="${num(sh.w)}" height="${num(sh.h)}"${sh.rx ? ` rx="${num(sh.rx)}"` : ''}/>`;
    }
    body += '</g>';
  }
  const bgRect = bg ? `<rect width="${total}" height="${total}" fill="${hex(bg)}"/>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${pixelSize}" height="${pixelSize}" shape-rendering="geometricPrecision">${bgRect}${body}</svg>`;
}

function canvasRR(ctx, x, y, w, h, r) {
  if (r > 0 && ctx.roundRect) ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
  else ctx.rect(x, y, w, h);
}

export function drawCanvas(ctx, { shapes, total, bg }, px) {
  const k = px / total;
  ctx.clearRect(0, 0, px, px);
  if (bg) {
    ctx.fillStyle = hex(bg);
    ctx.fillRect(0, 0, px, px);
  }
  for (const sh of shapes) {
    ctx.fillStyle = hex(sh.c);
    ctx.beginPath();
    if (sh.t === 'c') {
      ctx.arc(sh.cx * k, sh.cy * k, sh.r * k, 0, Math.PI * 2);
      ctx.fill();
    } else if (sh.t === 'ring') {
      canvasRR(ctx, sh.x * k, sh.y * k, sh.w * k, sh.h * k, sh.rx * k);
      canvasRR(ctx, sh.hx * k, sh.hy * k, sh.hw * k, sh.hh * k, sh.hrx * k);
      ctx.fill('evenodd');
    } else {
      canvasRR(ctx, sh.x * k, sh.y * k, sh.w * k, sh.h * k, sh.rx * k);
      ctx.fill();
    }
  }
}

/** Is (u, v) inside the rounded rectangle? */
function inRR(u, v, x, y, w, h, r) {
  if (u < x || v < y || u > x + w || v > y + h) return false;
  if (r <= 0) return true;
  r = Math.min(r, w / 2, h / 2);
  const dx = Math.max(x + r - u, 0, u - (x + w - r));
  const dy = Math.max(y + r - v, 0, v - (y + h - r));
  return dx * dx + dy * dy <= r * r;
}

/** Software rasterizer: returns {data: RGBA, width, height}. Samples pixel centres. */
export function rasterize({ shapes, total, bg }, ppm = 8) {
  const W = Math.round(total * ppm);
  const data = new Uint8ClampedArray(W * W * 4);
  const b = bg || [255, 255, 255];
  for (let i = 0; i < W * W; i++) {
    data[i * 4] = b[0]; data[i * 4 + 1] = b[1]; data[i * 4 + 2] = b[2]; data[i * 4 + 3] = 255;
  }
  const s = W / total;
  for (const sh of shapes) {
    const [r, g, bl] = sh.c;
    let x0, y0, x1, y1, inside;
    if (sh.t === 'c') {
      const cx = sh.cx * s, cy = sh.cy * s, rad = sh.r * s;
      x0 = cx - rad; x1 = cx + rad; y0 = cy - rad; y1 = cy + rad;
      inside = (u, v) => (u - cx) ** 2 + (v - cy) ** 2 <= rad * rad;
    } else if (sh.t === 'ring') {
      x0 = sh.x * s; y0 = sh.y * s; x1 = (sh.x + sh.w) * s; y1 = (sh.y + sh.h) * s;
      inside = (u, v) => inRR(u, v, sh.x * s, sh.y * s, sh.w * s, sh.h * s, sh.rx * s) &&
        !inRR(u, v, sh.hx * s, sh.hy * s, sh.hw * s, sh.hh * s, sh.hrx * s);
    } else {
      x0 = sh.x * s; y0 = sh.y * s; x1 = (sh.x + sh.w) * s; y1 = (sh.y + sh.h) * s;
      const rx = (sh.rx || 0) * s;
      inside = rx > 0 ? (u, v) => inRR(u, v, x0, y0, x1 - x0, y1 - y0, rx) : (u, v) => u >= x0 && u < x1 && v >= y0 && v < y1;
    }
    for (let y = Math.max(0, Math.floor(y0)); y <= Math.min(W - 1, Math.ceil(y1)); y++)
      for (let x = Math.max(0, Math.floor(x0)); x <= Math.min(W - 1, Math.ceil(x1)); x++) {
        if (!inside(x + 0.5, y + 0.5)) continue;
        const o = (y * W + x) * 4;
        data[o] = r; data[o + 1] = g; data[o + 2] = bl;
      }
  }
  return { data, width: W, height: W };
}
