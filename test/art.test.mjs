import { test } from 'node:test';
import assert from 'node:assert/strict';
import jsQR from 'jsqr';
import { encodePlain } from '../public/js/qr.js';
import { planArt, sampleImage } from '../public/js/art.js';
import { buildShapes, toSVG } from '../public/js/render.js';
import { verifyScan } from '../public/js/verify.js';
import { pinkLogo, bwLogo, gradient, makeImage } from './helpers.mjs';

const TEXT = 'https://danceb.com/check-in';

test('no image: identical to a standard QR code', () => {
  for (const ecl of [0, 1, 2, 3]) {
    const plan = planArt({ text: TEXT, ecl, minVersion: 8 });
    const plain = encodePlain(TEXT, ecl, 8);
    assert.equal(plan.version, plain.version);
    assert.deepEqual(Array.from(plan.dark), Array.from(plain.modules), `ecl ${ecl}`);
  }
});

test('logo codes scan at every error-correction level', () => {
  for (const [name, img, extra] of [
    ['pink', pinkLogo(), { threshold: 0.65, deadzone: 0.1 }],
    ['bw', bwLogo(), {}],
  ])
    for (const ecl of [0, 1, 2, 3]) {
      const plan = planArt({ text: TEXT, ecl, minVersion: 10, image: img, strength: 0.6, ...extra });
      const v = verifyScan(buildShapes(plan), TEXT, jsQR);
      assert.ok(v.ok, `${name} ecl ${ecl}: ${JSON.stringify(v)}`);
    }
});

test('the logo is actually drawn into the pattern', () => {
  const plan = planArt({ text: TEXT, ecl: 1, minVersion: 10, image: pinkLogo(), threshold: 0.65, deadzone: 0.1, strength: 0.6 });
  assert.ok(plan.stats.matchedFraction > 0.85, `matched ${plan.stats.matchedFraction}`);
  assert.ok(plan.stats.freeBytes > 100);
  // black face modules in the middle must be dark, white cut-out modules light
  const mid = (plan.size / 2) | 0;
  let darkCount = 0;
  for (let y = mid - 3; y <= mid + 1; y++)
    for (let x = mid - 3; x <= mid + 3; x++) if (plan.dark[y * plan.size + x]) darkCount++;
  assert.ok(darkCount > 25, `centre mostly dark (${darkCount}/35)`);
});

test('error budget is respected', () => {
  for (const strength of [0.2, 0.5, 0.8]) {
    const plan = planArt({ text: TEXT, ecl: 2, minVersion: 8, image: bwLogo(), strength });
    assert.ok(plan.stats.budgetUsed <= strength + 1e-9, `strength ${strength}: used ${plan.stats.budgetUsed}`);
  }
});

test('higher strength never matches the image worse', () => {
  let prev = 0;
  for (const strength of [0, 0.3, 0.6, 0.85]) {
    const plan = planArt({ text: TEXT, ecl: 2, minVersion: 10, image: bwLogo(), strength });
    assert.ok(plan.stats.matchedFraction >= prev - 1e-9, `strength ${strength}`);
    prev = plan.stats.matchedFraction;
  }
});

test('photo mode (halftone) still scans', () => {
  const plan = planArt({ text: TEXT, ecl: 0, minVersion: 14, image: gradient(), halftone: true, strength: 0.5 });
  const v = verifyScan(buildShapes(plan), TEXT, jsQR);
  assert.ok(v.ok, JSON.stringify(v));
});

test('long text and finer grids work', () => {
  const text = 'https://example.com/' + 'a-long-path/'.repeat(8) + '?x=1&y=2';
  const plan = planArt({ text, ecl: 1, minVersion: 12, image: pinkLogo(), threshold: 0.65, deadzone: 0.1, strength: 0.5 });
  assert.ok(verifyScan(buildShapes(plan), text, jsQR).ok);
});

test('transparent / missing image regions are left to the data', () => {
  const s = sampleImage(makeImage(32, () => [0, 0, 0, 0]), 25, 1);
  assert.ok(s.a.every((v) => v === 0));
  const half = sampleImage(pinkLogo(64), 25, 0.5);
  assert.equal(half.a[0], 0); // outside the scaled image
  assert.ok(half.a[12 * 25 + 12] > 0.9); // centre
});

test('SVG export is well-formed and contains the shapes', () => {
  const plan = planArt({ text: TEXT, ecl: 1, minVersion: 8, image: pinkLogo() });
  const r = buildShapes(plan, { bg: null });
  const svg = toSVG(r, 512);
  assert.match(svg, /^<svg [^>]*viewBox="0 0 \d+ \d+"/);
  assert.ok(!svg.includes('NaN'));
  assert.equal((svg.match(/<circle|<rect/g) || []).length, r.shapes.length);
});
