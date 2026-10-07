// Candidate generation shared by the Web Worker (gen-worker.js) and tests:
// plan design variants, render each in colour and black & white, score each
// with the phone-camera stress test.

import { planArt } from './art.js';
import { planFragment, supportsFragment, pickFragmentVersion } from './fragment.js';
import { pickVersion } from './qr.js';
import { buildShapes } from './render.js';
import { stressTest, minPrintMm, rateAtPrint } from './verify.js';

export const STRENGTHS = [
  { value: 0.2, label: 'Gentle' },
  { value: 0.6, label: 'Bold' },
];
// Q and H only: lower levels scanned poorly once the logo is forced in (see README).
const ECLS = [2, 3];
const GRID_STEP = 3; // the "detailed" variant is this many versions finer

/** Design variants: 2 error-correction levels x 2 grid sizes x 2 logo strengths = 8. */
export function variants(link, { minVersion = 1 } = {}) {
  const fragment = supportsFragment(link);
  const bytes = new TextEncoder().encode(link).length;
  const out = [];
  for (const ecl of ECLS) {
    const base = fragment ? pickFragmentVersion(link, ecl, minVersion, 8) : pickVersion(bytes, ecl, minVersion);
    if (base < 0) continue;
    for (const [grid, version] of [['Compact', base], ['Detailed', Math.min(40, base + GRID_STEP)]]) {
      for (const s of STRENGTHS) out.push({ ecl, version, grid, strength: s.value, strengthLabel: s.label, fragment });
    }
  }
  return out;
}

export function planVariant(link, v, image, opts = {}) {
  const common = { ...opts, ecl: v.ecl, image, strength: v.strength };
  return v.fragment
    ? planFragment({ ...common, link, version: v.version })
    : planArt({ ...common, text: link, minVersion: v.version });
}

export const SETS = [
  { set: 'color', overrides: { keepColors: true } },
  { set: 'bw', overrides: { keepColors: false, tintLight: false } },
];

/** Render + score one candidate. */
export async function scoreCandidate({ link, v, plan, set, style, decoders, print = {}, trials = 3, seed = 1 }) {
  const rendered = buildShapes(plan, style);
  const score = await stressTest(rendered, plan.text, decoders, { trials, seed });
  const distanceMm = print.distanceMm ?? 150;
  return {
    set,
    text: plan.text,
    link,
    version: plan.version,
    size: plan.size,
    ecl: 'LMQH'[plan.ecl],
    mask: plan.mask,
    grid: v.grid,
    strength: v.strength,
    strengthLabel: v.strengthLabel,
    fragmentLength: plan.fragmentLength ?? 0,
    match: plan.stats.matchedFraction,
    budgetUsed: plan.stats.budgetUsed,
    rendered,
    style,
    score: {
      reliability: score.reliability,
      byDecoder: score.byDecoder,
      ladder: score.ladder,
      minPpm: score.minPpm,
      minMm: minPrintMm(score.minPpm, rendered.total, distanceMm),
      atPrint: print.mm ? rateAtPrint(score.ladder, print.mm, rendered.total, distanceMm) : null,
    },
  };
}

/**
 * Generate every candidate, calling onCandidate as each finishes.
 * Plans are shared between the colour and black & white sets.
 */
export async function generateAll({ link, image, opts = {}, style = {}, print = {}, decoders, trials = 3, onCandidate, onStart }) {
  const vs = variants(link, opts);
  if (!vs.length) throw new Error('That link is too long for a QR code.');
  const plans = vs.map((v) => ({ v, plan: planVariant(link, v, image, opts) }));
  onStart?.(plans.length * SETS.length);
  const out = [];
  for (const { set, overrides } of SETS) {
    for (const [i, { v, plan }] of plans.entries()) {
      const c = await scoreCandidate({ link, v, plan, set, style: { ...style, ...overrides }, decoders, print, trials, seed: 1000 + i });
      c.id = `${set}-${i}`;
      out.push(c);
      await onCandidate?.(c);
    }
  }
  return out;
}
