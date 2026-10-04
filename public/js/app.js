import { planArt } from './art.js';
import { buildShapes, toSVG, drawCanvas } from './render.js';
import { verifyScan } from './verify.js';

const $ = (id) => document.getElementById(id);
const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

const SQUARE_PX = 512; // working resolution for the uploaded image
const view = $('view');
const ctx = view.getContext('2d');

let source = null;      // {el, w, h, name} decoded image, or null
let square = null;      // {data, width, height} RGBA square derived from `source`
let rendered = null;    // last shapes (for export)
let token = 0;          // cancels stale scan checks
let timer = 0;

// ------------------------------------------------------------------ image handling

function demoCanvas() {
  const c = document.createElement('canvas');
  c.width = c.height = SQUARE_PX;
  const g = c.getContext('2d');
  g.fillStyle = '#ff4b69';
  g.beginPath();
  g.roundRect(60, 60, 392, 392, 90);
  g.fill();
  g.fillStyle = '#000';
  g.font = '900 330px system-ui, "Segoe UI", Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('B', 256, 276);
  return c;
}

function makeSquare() {
  if (!source) { square = null; return; }
  const c = document.createElement('canvas');
  c.width = c.height = SQUARE_PX;
  const g = c.getContext('2d', { willReadFrequently: true });
  const { el, w, h } = source;
  if ($('fit').value === 'pad') {
    const k = Math.min(SQUARE_PX / w, SQUARE_PX / h);
    g.drawImage(el, (SQUARE_PX - w * k) / 2, (SQUARE_PX - h * k) / 2, w * k, h * k);
  } else {
    const s = Math.min(w, h);
    g.drawImage(el, (w - s) / 2, (h - s) / 2, s, s, 0, 0, SQUARE_PX, SQUARE_PX);
  }
  const d = g.getImageData(0, 0, SQUARE_PX, SQUARE_PX);
  square = { data: d.data, width: d.width, height: d.height };
}

function setSource(el, w, h, name) {
  source = el ? { el, w, h, name } : null;
  $('fileName').textContent = name;
  $('thumb').src = el ? (el.toDataURL ? el.toDataURL() : el.src) : 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
  makeSquare();
  schedule(0);
}

async function loadFile(file) {
  if (!file || !file.type.startsWith('image/')) return setStatus('That file is not an image.', 'bad');
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    setSource(img, img.naturalWidth || SQUARE_PX, img.naturalHeight || SQUARE_PX, file.name);
    // keep object URL alive: the thumbnail and canvas draws use the element
  } catch {
    URL.revokeObjectURL(url);
    setStatus('Could not read that image.', 'bad');
  }
}

function useDemo() {
  const c = demoCanvas();
  setSource(c, SQUARE_PX, SQUARE_PX, 'Demo logo');
}

// ------------------------------------------------------------------ options

function readOptions() {
  const o = {
    text: $('text').value,
    ecl: +$('ecl').value,
    minVersion: +$('detail').value,
    image: square,
    imageScale: +$('imgsize').value / 100,
    threshold: +$('fill').value / 100,
    deadzone: 0.1,
    strength: +$('strength').value / 100,
    halftone: $('halftone').checked,
  };
  const style = {
    fg: hexToRgb($('fg').value),
    bg: $('transparent').checked ? null : hexToRgb($('bg').value),
    shape: $('shape').value,
    dotScale: +$('dotScale').value / 100,
    keepColors: $('keepColors').checked,
    maxLum: +$('maxLum').value / 100,
    tintLight: $('tintLight').checked,
    quiet: +$('quiet').value,
  };
  return { o, style };
}

function syncLabels() {
  $('imgsizeOut').textContent = $('imgsize').value + '%';
  $('strengthOut').textContent = $('strength').value + '%';
  $('fillOut').textContent = $('fill').value;
  $('dotScaleOut').textContent = $('dotScale').value + '%';
  $('maxLumOut').textContent = $('maxLum').value + '%';
  $('quietOut').textContent = $('quiet').value;
  const n = +$('detail').value * 4 + 17;
  $('detailOut').textContent = `v${$('detail').value} · ${n}×${n}`;
}

function setStatus(msg, kind = '') {
  const el = $('status');
  el.textContent = msg;
  el.className = 'status ' + kind;
}

// ------------------------------------------------------------------ pipeline

function schedule(delay = 120) {
  clearTimeout(timer);
  timer = setTimeout(compute, delay);
}

function compute() {
  syncLabels();
  const my = ++token;
  const { o, style } = readOptions();
  if (!o.text.trim()) {
    setStatus('Enter a link or some text to encode.', 'warn');
    $('info').textContent = '';
    return;
  }
  let plan;
  try {
    plan = planArt(o);
  } catch (e) {
    setStatus(e.message, 'bad');
    return;
  }
  rendered = buildShapes(plan, style);
  drawCanvas(ctx, rendered, view.width);

  const s = plan.stats;
  const parts = [`Version ${plan.version} (${plan.size}×${plan.size})`];
  if (o.image) {
    parts.push(`logo match ${Math.round(s.matchedFraction * 100)}%`);
    parts.push(`${Math.round((1 - s.budgetUsed) * 100)}% error margin left`);
  }
  $('info').textContent = parts.join(' · ');
  printReadout(plan.size + 2 * style.quiet);
  setStatus('Checking scan…');

  setTimeout(() => {
    if (my !== token) return;
    if (!window.jsQR) return setStatus('Scan check unavailable — test with your phone.', 'warn');
    const v = verifyScan(rendered, o.text, window.jsQR);
    if (my !== token) return;
    const detail = `crisp ${v.clean}/${v.cleanTotal}, blurred ${v.soft}/${v.softTotal}`;
    if (v.ok) setStatus(`✓ Scan test passed (${detail})`, 'ok');
    else if (v.clean + v.soft > 0) setStatus(`⚠ Borderline scan test (${detail}). Lower logo sharpness or raise error correction.`, 'warn');
    else setStatus('✗ Failed scan test. Lower logo sharpness, raise error correction, or enlarge the margin.', 'bad');
  }, 30);
}

async function autoTune() {
  const btn = $('tune');
  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = 'Tuning…';
  await new Promise((r) => setTimeout(r, 20));
  const { o, style } = readOptions();
  let chosen = null;
  for (let s = 75; s >= 20; s -= 10) {
    let plan;
    try { plan = planArt({ ...o, strength: s / 100 }); } catch (e) { setStatus(e.message, 'bad'); break; }
    const r = buildShapes(plan, style);
    if (window.jsQR && verifyScan(r, o.text, window.jsQR).ok) { chosen = s; break; }
    await new Promise((res) => setTimeout(res, 0));
  }
  btn.disabled = false;
  btn.textContent = prev;
  if (chosen === null) {
    $('strength').value = 20;
    compute();
    setStatus('No setting passed the scan test. Try higher error correction or a simpler image.', 'bad');
    return;
  }
  $('strength').value = chosen;
  compute();
}

// Module size at the chosen print width. Simulated phone scans (ZXing, WeChat, OpenCV)
// were run down to 0.41 mm per module; below that is untested territory.
function printReadout(totalModules) {
  const mm = +$('printMm').value;
  const out = $('printOut');
  if (!(mm > 0)) { out.textContent = ''; return; }
  const per = mm / totalModules;
  const verdict = per >= 0.45 ? 'good' : per >= 0.4 ? 'tight' : 'too small — print larger or use a coarser grid';
  out.textContent = `${per.toFixed(2)} mm per module · ${verdict}`;
  out.style.color = per >= 0.4 ? '' : 'var(--bad)';
}

function phoneSafe() {
  $('ecl').value = '3';        // High error correction
  $('strength').value = 15;    // low sharpness: spend little of the safety margin
  $('maxLum').value = 30;      // dark logo colours read more reliably
  $('quiet').value = 4;        // full quiet zone
  $('detail').value = 1;       // smallest grid that fits the link (biggest modules)
  $('shape').value = 'dots';
  $('dotScale').value = 90;
  compute();
}

// ------------------------------------------------------------------ export

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function exportPng() {
  if (!rendered) return;
  const px = +$('pngSize').value;
  const c = document.createElement('canvas');
  c.width = c.height = px;
  drawCanvas(c.getContext('2d'), rendered, px);
  c.toBlob((b) => b && download(b, 'branded-qr.png'), 'image/png');
}

function exportSvg() {
  if (!rendered) return;
  download(new Blob([toSVG(rendered)], { type: 'image/svg+xml' }), 'branded-qr.svg');
}

// ------------------------------------------------------------------ wiring

for (const id of ['text', 'ecl', 'imgsize', 'strength', 'fill', 'detail', 'shape', 'dotScale', 'fg', 'bg',
  'transparent', 'keepColors', 'tintLight', 'maxLum', 'halftone', 'quiet', 'printMm']) {
  $(id).addEventListener('input', () => schedule());
}
$('fit').addEventListener('input', () => { makeSquare(); schedule(0); });

$('pick').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', (e) => loadFile(e.target.files[0]));
$('useDemo').addEventListener('click', useDemo);
$('clearImg').addEventListener('click', () => setSource(null, 0, 0, 'No image'));
$('dlPng').addEventListener('click', exportPng);
$('dlSvg').addEventListener('click', exportSvg);
$('tune').addEventListener('click', autoTune);
$('safe').addEventListener('click', phoneSafe);

const drop = $('drop');
drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('file').click(); } });
for (const ev of ['dragenter', 'dragover']) {
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); });
}
for (const ev of ['dragleave', 'drop']) {
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); });
}
drop.addEventListener('drop', (e) => loadFile(e.dataTransfer.files[0]));
window.addEventListener('paste', (e) => {
  const f = [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith('image/'));
  if (f) loadFile(f);
});

const presetText = new URLSearchParams(location.search).get('text');
if (presetText) $('text').value = presetText;
useDemo();
