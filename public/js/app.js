import { toSVG, drawCanvas } from './render.js';
import { rateAtPrint } from './verify.js';
import { luminance } from './art.js';

const $ = (id) => document.getElementById(id);
const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const pct = (v) => `${Math.round(v * 100)}%`;

const SQUARE_PX = 512; // working resolution for the uploaded image
const SIZE_ROWS = [15, 20, 25, 30, 40, 60, 100];
const GOOD = 0.9; // reliability considered "phone-safe"

let source = null;      // {el, w, h, name}
let square = null;      // {data, width, height} RGBA square derived from `source`
let worker = null;
let jobId = 0;
let candidates = [];
let selected = null;
let lastPrint = { mm: 20, distanceMm: 150 };

// ------------------------------------------------------------------ admin token (shared with links/saved pages)

const store = (area) => { try { return window[area]; } catch { return null; } };
const getToken = () => store('sessionStorage')?.getItem('adminToken') || store('localStorage')?.getItem('adminToken') || '';
const setToken = (t) => store('sessionStorage')?.setItem('adminToken', t);

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { Authorization: `Bearer ${getToken()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(res.status === 401 ? 'Wrong or missing admin token.' : data.error || `Request failed (${res.status})`);
  return data;
}

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
  markStale();
}

async function loadFile(file) {
  if (!file || !file.type.startsWith('image/')) return setNote('That file is not an image.');
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    setSource(img, img.naturalWidth || SQUARE_PX, img.naturalHeight || SQUARE_PX, file.name);
  } catch {
    URL.revokeObjectURL(url);
    setNote('Could not read that image.');
  }
}

// ------------------------------------------------------------------ options

function readRequest() {
  const fg = hexToRgb($('fg').value);
  const bg = hexToRgb($('bg').value);
  return {
    link: $('text').value.trim(),
    image: square,
    opts: { imageScale: +$('imgsize').value / 100, threshold: +$('fill').value / 100, deadzone: 0.1 },
    style: {
      shape: $('shape').value,
      eyes: $('eyes').value,
      dotScale: +$('dotScale').value / 100,
      maxLum: +$('contrast').value,
      lightLum: +$('contrast').selectedOptions[0].dataset.light,
      fg,
      bg,
      tintLight: $('tintLight').checked,
      quiet: +$('quiet').value,
    },
    print: { mm: +$('printMm').value || null, distanceMm: +$('distance').value },
  };
}

function checkColors() {
  const fg = hexToRgb($('fg').value), bg = hexToRgb($('bg').value);
  const lf = luminance(...fg), lb = luminance(...bg);
  const problems = [];
  if (lf > 0.35) problems.push('the dark colour is too light');
  if (lb < 0.75) problems.push('the background is too dark');
  if (lb - lf < 0.45) problems.push('there is too little contrast between them');
  const el = $('colorWarn');
  el.hidden = !problems.length;
  el.textContent = problems.length ? `Readability: ${problems.join(', ')}. Scanners need dark pixels on a light background.` : '';
}

function syncLabels() {
  $('imgsizeOut').textContent = $('imgsize').value + '%';
  $('fillOut').textContent = $('fill').value;
  $('dotScaleOut').textContent = $('dotScale').value + '%';
  $('quietOut').textContent = $('quiet').value;
}

const setNote = (msg) => { $('decoderNote').textContent = msg; };

function markStale() {
  if (candidates.length) $('generate').textContent = 'Regenerate with new settings';
}

// ------------------------------------------------------------------ generation

function generate() {
  const req = readRequest();
  if (!req.link) return setNote('Enter a link first.');
  worker?.terminate();
  worker = new Worker(new URL('./gen-worker.js', import.meta.url), { type: 'module' });
  const my = ++jobId;
  candidates = [];
  selected = null;
  lastPrint = req.print;
  $('detail').hidden = true;
  $('cardsColor').replaceChildren();
  $('cardsBw').replaceChildren();
  $('setColor').hidden = $('setBw').hidden = true;
  $('empty').hidden = true;
  $('generate').textContent = 'Generating…';
  $('generate').disabled = true;
  $('progressWrap').hidden = false;
  $('progressBar').style.width = '0%';

  worker.onmessage = ({ data: m }) => {
    if (m.jobId !== my) return;
    if (m.type === 'decoders') setNote(`Scan test: simulated phone-camera frames decoded by ${m.names.join(', ')}.`);
    else if (m.type === 'candidate') addCandidate(m.candidate);
    else if (m.type === 'progress') $('progressBar').style.width = pct(m.done / m.total);
    else if (m.type === 'done' || m.type === 'error') {
      $('generate').disabled = false;
      $('generate').textContent = 'Generate designs';
      $('progressWrap').hidden = true;
      if (m.type === 'error') setNote(m.message);
      else finish();
    }
  };
  worker.onerror = (e) => {
    $('generate').disabled = false;
    $('generate').textContent = 'Generate designs';
    $('progressWrap').hidden = true;
    setNote(`Generator failed to start (${e.message || 'module workers unsupported?'}).`);
  };
  worker.postMessage({ type: 'generate', jobId: my, ...req });
}

/** Expected scan rate at the planned print size (0 when the code is too small to have been tested). */
const rateAtPlan = (c) => (lastPrint.mm ? c.score.atPrint ?? 0 : c.score.reliability);

/** Best-looking candidate that is still phone-safe at the planned size. */
function pickRecommended(list) {
  const safe = list.filter((c) => c.score.reliability >= GOOD && (!lastPrint.mm || rateAtPlan(c) >= 0.85));
  const pool = safe.length ? safe : list;
  return pool.reduce((best, c) => (!best || (safe.length ? c.match > best.match : c.score.reliability > best.score.reliability) ? c : best), null);
}

function sortKey(c) {
  return [-(c.recommended ? 1 : 0), -rateAtPlan(c), -c.score.reliability, -c.match];
}

function finish() {
  for (const set of ['color', 'bw']) {
    const list = candidates.filter((c) => c.set === set);
    const rec = pickRecommended(list);
    if (rec) rec.recommended = true;
    list.sort((a, b) => {
      const ka = sortKey(a), kb = sortKey(b);
      for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
      return 0;
    });
    const box = set === 'color' ? $('cardsColor') : $('cardsBw');
    box.replaceChildren(...list.map(card));
  }
  const first = candidates.find((c) => c.recommended && c.set === 'color') || candidates[0];
  if (first) select(first);
}

function addCandidate(c) {
  candidates.push(c);
  const box = c.set === 'color' ? $('cardsColor') : $('cardsBw');
  (c.set === 'color' ? $('setColor') : $('setBw')).hidden = false;
  box.append(card(c));
}

function relClass(v) {
  return v == null ? 'bad' : v >= GOOD ? 'ok' : v >= 0.75 ? 'warn' : 'bad';
}

function card(c) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'card' + (c === selected ? ' selected' : '');
  el.dataset.id = c.id;
  const cv = document.createElement('canvas');
  cv.width = cv.height = 360;
  drawCanvas(cv.getContext('2d'), c.rendered, 360);
  const s = c.score;
  const meta = document.createElement('div');
  meta.className = 'card-meta';
  const line = (label, value, cls = '') => {
    const row = document.createElement('div');
    row.className = 'kv';
    const a = document.createElement('span');
    a.textContent = label;
    const b = document.createElement('strong');
    b.textContent = value;
    if (cls) b.className = cls;
    row.append(a, b);
    return row;
  };
  if (c.recommended) {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = 'Recommended';
    meta.append(tag);
  }
  meta.append(
    line('Scan reliability', pct(s.reliability), relClass(s.reliability)),
    line('Min print size', s.minMm ? `${Math.ceil(s.minMm)} mm` : 'not reliable', s.minMm ? '' : 'bad'),
    line('Logo match', pct(c.match)),
  );
  if (lastPrint.mm) meta.append(line(`At ${lastPrint.mm} mm`, s.atPrint == null ? 'too small' : pct(s.atPrint), relClass(s.atPrint)));
  const sub = document.createElement('div');
  sub.className = 'muted small';
  sub.textContent = `${c.grid} ${c.size}×${c.size} · ECC ${c.ecl} · ${c.strengthLabel}`;
  meta.append(sub);
  el.append(cv, meta);
  el.addEventListener('click', () => select(c));
  return el;
}

function select(c) {
  selected = c;
  document.querySelectorAll('.card').forEach((el) => el.classList.toggle('selected', el.dataset.id === c.id));
  $('detail').hidden = false;
  drawCanvas($('view').getContext('2d'), c.rendered, $('view').width);
  $('detailTitle').textContent = `${c.set === 'color' ? 'Colour' : 'Black & white'} · ${c.grid} · ${c.strengthLabel}${c.recommended ? ' · Recommended' : ''}`;
  const s = c.score;
  const dl = $('detailMetrics');
  dl.replaceChildren();
  const add = (k, v) => {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    dl.append(dt, dd);
  };
  add('Scan reliability', `${pct(s.reliability)} (${Object.entries(s.byDecoder).map(([k, v]) => `${k} ${pct(v)}`).join(', ')})`);
  add('Min print size', s.minMm ? `${Math.ceil(s.minMm)} mm wide, scanned from ${lastPrint.distanceMm / 10} cm` : 'did not pass at any tested size');
  add('Logo match', pct(c.match));
  add('Grid', `${c.size}×${c.size} modules, error correction ${c.ecl}, ${pct(c.budgetUsed)} of the repair budget spent on the logo`);
  const table = $('sizeTable');
  table.replaceChildren();
  const head = document.createElement('tr');
  const body = document.createElement('tr');
  const th0 = document.createElement('th');
  th0.textContent = 'Print width';
  const td0 = document.createElement('th');
  td0.textContent = 'Scan rate';
  head.append(th0);
  body.append(td0);
  for (const mm of SIZE_ROWS) {
    const r = rateAtPrint(s.ladder, mm, c.rendered.total, lastPrint.distanceMm);
    const th = document.createElement('th');
    th.textContent = `${mm} mm`;
    const td = document.createElement('td');
    td.textContent = r == null ? '—' : pct(r);
    td.className = relClass(r);
    head.append(th);
    body.append(td);
  }
  table.append(head, body);
  $('detailText').textContent = c.text;
  $('saveMsg').textContent = '';
  $('saveToken').hidden = !!getToken();
}

// ------------------------------------------------------------------ export & save

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

const fileBase = () => ($('saveName').value.trim() || 'branded-qr').replace(/[^\w.-]+/g, '-').slice(0, 60);

function exportPng() {
  if (!selected) return;
  const px = +$('pngSize').value;
  const c = document.createElement('canvas');
  c.width = c.height = px;
  drawCanvas(c.getContext('2d'), selected.rendered, px);
  c.toBlob((b) => b && download(b, `${fileBase()}.png`), 'image/png');
}

function exportSvg() {
  if (!selected) return;
  download(new Blob([toSVG(selected.rendered)], { type: 'image/svg+xml' }), `${fileBase()}.svg`);
}

async function save(e) {
  e.preventDefault();
  if (!selected) return;
  const msg = $('saveMsg');
  if (!getToken()) {
    const t = $('saveToken').value.trim();
    if (!t) { $('saveToken').hidden = false; $('saveToken').focus(); msg.textContent = 'Enter your admin token to save.'; return; }
    setToken(t);
  }
  const c = selected;
  try {
    msg.textContent = 'Saving…';
    await api('/api/designs', {
      method: 'POST',
      body: {
        name: $('saveName').value,
        details: $('saveDetails').value,
        text: c.text,
        svg: toSVG(c.rendered),
        meta: {
          set: c.set, grid: c.grid, size: c.size, ecl: c.ecl, strength: c.strength,
          reliability: c.score.reliability, byDecoder: c.score.byDecoder, minMm: c.score.minMm,
          match: c.match, printMm: lastPrint.mm, distanceMm: lastPrint.distanceMm, atPrint: c.score.atPrint,
          style: { shape: c.style.shape, eyes: c.style.eyes, dotScale: c.style.dotScale, maxLum: c.style.maxLum },
        },
      },
    });
    msg.innerHTML = 'Saved. <a href="saved.html">See saved codes</a>';
    $('saveToken').hidden = true;
  } catch (err) {
    msg.textContent = err.message;
    if (/token/i.test(err.message)) { store('sessionStorage')?.removeItem('adminToken'); $('saveToken').hidden = false; }
  }
}

async function shorten() {
  const link = $('text').value.trim();
  if (!/^https?:\/\//i.test(link)) return setNote('Enter a full http(s) link to shorten.');
  if (/\/c\/[A-Za-z0-9]+\/?$/.test(new URL(link, location.href).pathname)) return setNote('That already looks like a short link.');
  let token = getToken();
  if (!token) {
    token = prompt('Admin token (to create a short link):') || '';
    if (!token) return;
    setToken(token.trim());
  }
  try {
    const l = await api('/api/links', { method: 'POST', body: { url: link } });
    $('text').value = l.short;
    setNote(`Short link ${l.short} → ${l.url}. You can change its destination later on the Short links page.`);
    markStale();
  } catch (err) {
    setNote(err.message);
  }
}

// ------------------------------------------------------------------ wiring

for (const id of ['imgsize', 'fill', 'dotScale', 'quiet']) $(id).addEventListener('input', () => { syncLabels(); markStale(); });
for (const id of ['text', 'shape', 'eyes', 'contrast', 'tintLight', 'printMm', 'distance']) $(id).addEventListener('input', markStale);
for (const id of ['fg', 'bg']) $(id).addEventListener('input', () => { checkColors(); markStale(); });
$('fit').addEventListener('input', () => { makeSquare(); markStale(); });
$('pick').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', (e) => loadFile(e.target.files[0]));
$('useDemo').addEventListener('click', () => setSource(demoCanvas(), SQUARE_PX, SQUARE_PX, 'Demo logo'));
$('clearImg').addEventListener('click', () => setSource(null, 0, 0, 'No image'));
$('generate').addEventListener('click', generate);
$('dlPng').addEventListener('click', exportPng);
$('dlSvg').addEventListener('click', exportSvg);
$('saveForm').addEventListener('submit', save);
$('shorten').addEventListener('click', shorten);

const drop = $('drop');
drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('file').click(); } });
for (const ev of ['dragenter', 'dragover']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); });
for (const ev of ['dragleave', 'drop']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); });
drop.addEventListener('drop', (e) => loadFile(e.dataTransfer.files[0]));
window.addEventListener('paste', (e) => {
  const f = [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith('image/'));
  if (f) loadFile(f);
});

const presetText = new URLSearchParams(location.search).get('text');
if (presetText) $('text').value = presetText;
syncLabels();
checkColors();
setSource(demoCanvas(), SQUARE_PX, SQUARE_PX, 'Demo logo');
