// Rendering of a planned QR (see art.js) into vector shapes, with three
// backends: SVG text, Canvas 2D, and a tiny software rasterizer (used for the
// scan check so it behaves identically in the browser and in Node tests).

import { WANT_LIGHT, luminance } from './art.js';

export const DEFAULT_STYLE = {
  fg: [0, 0, 0],            // colour of dark modules outside the image
  bg: [255, 255, 255],      // background, or null for transparent
  shape: 'dots',            // 'dots' | 'squares' | 'rounded'
  dotScale: 0.9,            // module fill ratio
  keepColors: true,         // tint dark modules with the image colours
  maxLum: 0.45,             // darkest-enough limit for tinted dark modules (0-1)
  tintLight: false,         // also tint light modules inside the image
  quiet: 4,                 // quiet zone, in modules
};

const hex = (c) => '#' + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');

// The three corner finders (with separators and format bits) stay in the
// foreground colour; other structural modules may take the image colour.
function inFinderZone(i, size) {
  const x = i % size, y = (i / size) | 0;
  return (x < 9 && y < 9) || (x >= size - 8 && y < 9) || (x < 9 && y >= size - 8);
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

function lightColor(plan, i) {
  const c = [plan.r[i], plan.g[i], plan.b[i]];
  const L = luminance(c[0], c[1], c[2]);
  const target = 0.86;
  if (L >= target) return c;
  const t = (target - L) / (1 - L);
  return c.map((v) => v + (255 - v) * t);
}

/** @returns {{shapes: object[], total: number, bg: number[]|null}} sizes in module units */
export function buildShapes(plan, style = {}) {
  const s = { ...DEFAULT_STYLE, ...style };
  const { size, dark } = plan;
  const total = size + 2 * s.quiet;
  const shapes = [];
  const place = (x, y, color, structural) => {
    const px = x + s.quiet, py = y + s.quiet;
    // Finder/alignment/timing patterns stay solid squares: scanners locate the
    // code by them, and dotted finders fail to detect in many decoders.
    if (structural) {
      shapes.push({ t: 'r', x: px - 0.01, y: py - 0.01, w: 1.02, h: 1.02, rx: 0, c: color });
      return;
    }
    const d = Math.max(0.05, Math.min(1.02, s.dotScale));
    if (s.shape === 'dots') {
      shapes.push({ t: 'c', cx: px + 0.5, cy: py + 0.5, r: d / 2, c: color });
    } else {
      const w = d >= 0.999 ? 1.02 : d; // tiny overlap hides hairline seams
      const o = (1 - w) / 2;
      shapes.push({ t: 'r', x: px + o, y: py + o, w, h: w, rx: s.shape === 'rounded' ? w * 0.3 : 0, c: color });
    }
  };

  if (s.tintLight && s.keepColors) {
    for (let i = 0; i < size * size; i++) {
      if (dark[i] || plan.fn[i] || !plan.hasImg[i]) continue;
      const x = i % size, y = (i / size) | 0;
      shapes.push({ t: 'r', x: x + s.quiet - 0.01, y: y + s.quiet - 0.01, w: 1.02, h: 1.02, rx: 0, c: lightColor(plan, i) });
    }
  }
  for (let i = 0; i < size * size; i++) {
    if (!dark[i]) continue;
    place(i % size, (i / size) | 0, darkColor(plan, i, s), !!plan.fn[i]);
  }
  return { shapes, total, bg: s.bg };
}

const num = (v) => String(Math.round(v * 1000) / 1000);

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
      body += sh.t === 'c'
        ? `<circle cx="${num(sh.cx)}" cy="${num(sh.cy)}" r="${num(sh.r)}"/>`
        : `<rect x="${num(sh.x)}" y="${num(sh.y)}" width="${num(sh.w)}" height="${num(sh.h)}"${sh.rx ? ` rx="${num(sh.rx)}"` : ''}/>`;
    }
    body += '</g>';
  }
  const bgRect = bg ? `<rect width="${total}" height="${total}" fill="${hex(bg)}"/>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${pixelSize}" height="${pixelSize}" shape-rendering="geometricPrecision">${bgRect}${body}</svg>`;
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
    if (sh.t === 'c') {
      ctx.beginPath();
      ctx.arc(sh.cx * k, sh.cy * k, sh.r * k, 0, Math.PI * 2);
      ctx.fill();
    } else if (sh.rx && ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(sh.x * k, sh.y * k, sh.w * k, sh.h * k, sh.rx * k);
      ctx.fill();
    } else {
      ctx.fillRect(sh.x * k, sh.y * k, sh.w * k, sh.h * k);
    }
  }
}

/** Software rasterizer: returns {data: RGBA, width, height}. */
export function rasterize({ shapes, total, bg }, ppm = 8) {
  const W = Math.round(total * ppm);
  const data = new Uint8ClampedArray(W * W * 4);
  const b = bg || [255, 255, 255];
  for (let i = 0; i < W * W; i++) {
    data[i * 4] = b[0]; data[i * 4 + 1] = b[1]; data[i * 4 + 2] = b[2]; data[i * 4 + 3] = 255;
  }
  for (const sh of shapes) {
    const [r, g, bl] = sh.c;
    if (sh.t === 'c') {
      const cx = sh.cx * ppm, cy = sh.cy * ppm, rad = sh.r * ppm;
      for (let y = Math.max(0, Math.floor(cy - rad)); y <= Math.min(W - 1, Math.ceil(cy + rad)); y++)
        for (let x = Math.max(0, Math.floor(cx - rad)); x <= Math.min(W - 1, Math.ceil(cx + rad)); x++) {
          const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
          if (dx * dx + dy * dy <= rad * rad) {
            const o = (y * W + x) * 4;
            data[o] = r; data[o + 1] = g; data[o + 2] = bl;
          }
        }
    } else {
      const x0 = Math.round(sh.x * ppm), x1 = Math.round((sh.x + sh.w) * ppm);
      const y0 = Math.round(sh.y * ppm), y1 = Math.round((sh.y + sh.h) * ppm);
      for (let y = Math.max(0, y0); y < Math.min(W, y1); y++)
        for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) {
          const o = (y * W + x) * 4;
          data[o] = r; data[o + 1] = g; data[o + 2] = bl;
        }
    }
  }
  return { data, width: W, height: W };
}
