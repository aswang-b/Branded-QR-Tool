import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import jsQR from 'jsqr';
import { encodePlain, pickVersion, eccPerBlock, numBlocks, numDataCodewords } from '../public/js/qr.js';
import { buildShapes, rasterize } from '../public/js/render.js';

// A plain, un-styled render of a module matrix
const plainShapes = (res) => {
  const shapes = [];
  for (let i = 0; i < res.size * res.size; i++)
    if (res.modules[i]) shapes.push({ t: 'r', x: 4 + (i % res.size), y: 4 + ((i / res.size) | 0), w: 1, h: 1, rx: 0, c: [0, 0, 0] });
  return { shapes, total: res.size + 8, bg: null };
};

test('version/ECC tables match the ones inside jsQR', () => {
  const src = fs.readFileSync(new URL('../node_modules/jsqr/dist/jsQR.js', import.meta.url), 'utf8');
  const start = src.indexOf('exports.VERSIONS = [');
  const end = src.indexOf('/***/ })', start);
  const VERSIONS = eval('(function(){var exports={};' + src.slice(start, end) + ';return exports.VERSIONS})()');
  assert.equal(VERSIONS.length, 40);
  for (const v of VERSIONS)
    v.errorCorrectionLevels.forEach((lvl, ecl) => {
      const blocks = lvl.ecBlocks.reduce((a, b) => a + b.numBlocks, 0);
      const data = lvl.ecBlocks.reduce((a, b) => a + b.numBlocks * b.dataCodewordsPerBlock, 0);
      const where = `v${v.versionNumber} ecl${ecl}`;
      assert.equal(eccPerBlock(v.versionNumber, ecl), lvl.ecCodewordsPerBlock, where);
      assert.equal(numBlocks(v.versionNumber, ecl), blocks, where);
      assert.equal(numDataCodewords(v.versionNumber, ecl), data, where);
    });
});

test('plain codes decode across versions and error-correction levels', () => {
  // v23-L is skipped: a known finder-detection quirk of jsQR (OpenCV decodes it fine)
  for (const ecl of [0, 1, 2, 3])
    for (const v of [1, 2, 6, 7, 10, 15, 22, 27, 32, 40]) {
      if (ecl === 0 && v === 23) continue;
      let len = 1;
      while (pickVersion(len + 1, ecl, v) === v) len++;
      const text = Array.from({ length: len }, (_, i) => String.fromCharCode(97 + ((i * 7 + v) % 26))).join('');
      const res = encodePlain(text, ecl, v);
      assert.equal(res.version, v);
      const img = rasterize(plainShapes(res), v > 20 ? 3 : 5);
      const out = jsQR(img.data, img.width, img.height);
      assert.equal(out?.data, text, `ecl ${ecl} version ${v}`);
    }
});

test('UTF-8 text round-trips', () => {
  const text = 'Dance with B 💃 — café';
  const res = encodePlain(text, 1, 3);
  const img = rasterize(plainShapes(res), 6);
  assert.equal(jsQR(img.data, img.width, img.height)?.data, text);
});

test('rejects text that cannot fit', () => {
  assert.throws(() => encodePlain('x'.repeat(5000), 3), /too long/);
});
