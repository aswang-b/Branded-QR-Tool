import { test } from 'node:test';
import assert from 'node:assert/strict';
import jsQR from 'jsqr';
import { numDataCodewords } from '../public/js/qr.js';
import { planArt } from '../public/js/art.js';
import { planFragment, supportsFragment, fragmentRoom, pickFragmentVersion, FRAGMENT_ALPHABET } from '../public/js/fragment.js';
import { buildShapes, rasterize, toSVG } from '../public/js/render.js';
import { stressTest, jsqrDecoder, zxingDecoder, minPrintMm, rateAtPrint, cameraPxPerMm } from '../public/js/verify.js';
import { variants, generateAll } from '../public/js/generate.js';
import { pinkLogo, zxing } from './helpers.mjs';

const LINK = 'https://dancewithb.fun/c/q2';
const LOGO = { image: pinkLogo(), threshold: 0.65, deadzone: 0.1 };

async function decoders() {
  return [zxingDecoder(await zxing()), jsqrDecoder(jsQR)];
}
async function decodeAll(rendered, ppm = 6) {
  const img = rasterize(rendered, ppm);
  const readBarcodes = await zxing();
  const z = (await readBarcodes({ ...img, colorSpace: 'srgb' }, { formats: ['QRCode'] }))[0]?.text ?? null;
  const j = jsQR(img.data, img.width, img.height)?.data ?? null;
  return { z, j };
}

// ---------------------------------------------------------------- fragment ("MosQR") mode

test('supportsFragment only accepts http(s) links without a fragment', () => {
  for (const ok of ['https://a.b/c', 'http://x.y', 'https://dancewithb.fun/c/q2?x=1']) assert.ok(supportsFragment(ok), ok);
  for (const no of ['hello', 'mailto:a@b.c', 'https://a.b/#/route', 'https://a b', 'ftp://x']) assert.ok(!supportsFragment(no), no);
});

test('fragment codes fill the symbol exactly and decode to link#fragment', async () => {
  for (const ecl of [2, 3]) {
    const version = pickFragmentVersion(LINK, ecl, 5);
    const plan = planFragment({ ...LOGO, link: LINK, ecl, version, strength: 0.4 });
    assert.equal(plan.version, version);
    assert.ok(plan.text.startsWith(LINK + '#'));
    const frag = plan.text.slice(LINK.length + 1);
    assert.equal(frag.length, fragmentRoom(LINK, version, ecl));
    assert.ok([...frag].every((c) => FRAGMENT_ALPHABET.includes(c)), frag);
    // byte mode header + payload uses all but < 8 bits of the data capacity: no pad bytes
    const bits = 4 + (version <= 9 ? 8 : 16) + 8 * plan.text.length;
    assert.ok(numDataCodewords(version, ecl) * 8 - bits < 8);
    assert.equal(plan.stats.freeBytes, 0);
    const { z, j } = await decodeAll(buildShapes(plan));
    assert.equal(z, plan.text);
    assert.equal(j, plan.text);
  }
});

test('fragment fitting draws the logo about as well as free pad bytes', () => {
  const version = pickFragmentVersion(LINK, 3, 8);
  const frag = planFragment({ ...LOGO, link: LINK, ecl: 3, version, strength: 0.2 });
  const pad = planArt({ ...LOGO, text: LINK, ecl: 3, minVersion: version, strength: 0.2 });
  const unshaped = planArt({ ...LOGO, text: LINK + '#' + 'A'.repeat(fragmentRoom(LINK, version, 3)), ecl: 3, minVersion: version, strength: 0.2, freePadding: false });
  assert.ok(frag.stats.matchedFraction > unshaped.stats.matchedFraction + 0.03, `${frag.stats.matchedFraction} vs ${unshaped.stats.matchedFraction}`);
  assert.ok(frag.stats.matchedFraction > pad.stats.matchedFraction - 0.06, `${frag.stats.matchedFraction} vs pad ${pad.stats.matchedFraction}`);
});

test('fragment mode rejects links it cannot shape', () => {
  assert.throws(() => planFragment({ link: 'not a url', ecl: 3 }), /http/);
  assert.throws(() => planFragment({ link: 'https://a.b/#x', ecl: 3 }), /http/);
  assert.throws(() => planFragment({ link: LINK, ecl: 3, version: 1 }), /too long/);
});

// ---------------------------------------------------------------- styles

test('every pixel shape and eye style decodes', async () => {
  const plan = planFragment({ ...LOGO, link: LINK, ecl: 2, version: pickFragmentVersion(LINK, 2, 5), strength: 0.4 });
  for (const shape of ['squares', 'rounded', 'dots', 'connected'])
    for (const eyes of ['square', 'rounded', 'dot'])
      for (const keepColors of [true, false]) {
        const r = buildShapes(plan, { shape, eyes, keepColors, dotScale: 0.8 });
        const { z, j } = await decodeAll(r);
        assert.equal(z, plan.text, `${shape}/${eyes}/${keepColors} (ZXing)`);
        assert.equal(j, plan.text, `${shape}/${eyes}/${keepColors} (jsQR)`);
        const svg = toSVG(r);
        assert.ok(!svg.includes('NaN'));
        assert.equal((svg.match(/<circle|<rect|<path/g) || []).length, r.shapes.length + 1); // + background
      }
});

test('module size cannot go below the legibility floor', () => {
  const plan = planArt({ text: LINK, ecl: 1 });
  const r = buildShapes(plan, { shape: 'dots', dotScale: 0.1 });
  assert.ok(r.shapes.filter((s) => s.t === 'c').every((s) => s.r >= 0.3 - 1e-9));
});

// ---------------------------------------------------------------- stress test & sizing

test('stress test: plain codes are reliable, over-forced ones are not', async () => {
  const ds = await decoders();
  const plain = planArt({ text: LINK, ecl: 3, minVersion: 5 });
  const forced = planFragment({ ...LOGO, link: LINK, ecl: 3, version: 8, strength: 1 });
  const a = await stressTest(buildShapes(plain, { shape: 'squares' }), plain.text, ds, { trials: 2 });
  const b = await stressTest(buildShapes(forced, { shape: 'squares', maxLum: 0.5 }), forced.text, ds, { trials: 2 });
  assert.ok(a.reliability >= 0.9, `plain ${a.reliability}`);
  assert.ok(b.reliability < a.reliability, `forced ${b.reliability} vs plain ${a.reliability}`);
  assert.ok(a.minPpm !== null && a.minPpm <= 3);
  assert.equal(a.ladder.length, 6);
  assert.deepEqual(Object.keys(a.byDecoder), ['ZXing', 'jsQR']);
});

test('print-size helpers', () => {
  // MosaicQR baseline: a 57-module code passing from 4 px/module rates 20 mm
  assert.ok(Math.abs(minPrintMm(4, 57, 150) - 20) < 0.1);
  assert.ok(cameraPxPerMm(300) < cameraPxPerMm(150));
  const total = 41;
  assert.ok(minPrintMm(3, total, 150) < minPrintMm(4, total, 150));
  assert.equal(minPrintMm(null, total), null);
  const ladder = [2.5, 3, 3.5, 4, 5, 6].map((ppm, i) => ({ ppm, rate: i / 5 }));
  assert.equal(rateAtPrint(ladder, 5, total), null); // smaller than anything tested
  assert.equal(rateAtPrint(ladder, 500, total), 1);
  const mid = rateAtPrint(ladder, (3.25 * total) / cameraPxPerMm(150), total);
  assert.ok(Math.abs(mid - 0.3) < 1e-6, mid);
});

// ---------------------------------------------------------------- the generator

test('variants: 2 error-correction levels x 2 grids x 2 strengths', () => {
  const vs = variants(LINK);
  assert.equal(vs.length, 8);
  assert.ok(vs.every((v) => v.fragment));
  assert.deepEqual([...new Set(vs.map((v) => v.ecl))], [2, 3]);
  const plain = variants('just some text');
  assert.equal(plain.length, 8);
  assert.ok(plain.every((v) => !v.fragment));
});

test('generateAll: 16 scored candidates, colour and black & white', async () => {
  const seen = [];
  const all = await generateAll({
    link: LINK, ...LOGO, opts: { threshold: 0.65, deadzone: 0.1 }, style: { shape: 'dots' },
    print: { mm: 25, distanceMm: 150 }, decoders: await decoders(), trials: 1, onCandidate: (c) => seen.push(c.id),
  });
  assert.equal(all.length, 16);
  assert.equal(seen.length, 16);
  assert.equal(all.filter((c) => c.set === 'color').length, 8);
  assert.equal(all.filter((c) => c.set === 'bw').length, 8);
  for (const c of all) {
    assert.ok(c.text.startsWith(LINK + '#'));
    assert.ok(c.score.reliability >= 0 && c.score.reliability <= 1);
    assert.ok(c.match > 0.5 && c.match <= 1);
    assert.ok(c.score.minMm === null || c.score.minMm > 5);
    if (c.set === 'bw') assert.ok(c.rendered.shapes.every((s) => s.c.every((v) => v === 0)), 'black & white set uses only black');
  }
  // most candidates should be phone-safe; the generator only offers robust levels
  assert.ok(all.filter((c) => c.score.reliability >= 0.75).length >= 12);
});
