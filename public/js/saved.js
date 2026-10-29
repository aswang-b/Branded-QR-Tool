import { api, apiText, getToken, bindSignIn } from './auth.js';

const $ = (id) => document.getElementById(id);
const pct = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`);


const setMsg = (text, kind = '') => { $('msg').textContent = text; $('msg').className = 'status ' + kind; };

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

const fileBase = (d) => d.name.replace(/[^\w.-]+/g, '-').slice(0, 60) || 'branded-qr';

async function pngFromSvg(svg, px) {
  // SVGs are only ever loaded through <img>, which never runs scripts
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    // load event, not img.decode(): decode() can stall until the page paints
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('Could not render that design.'));
      i.src = url;
    });
    const c = document.createElement('canvas');
    c.width = c.height = px;
    c.getContext('2d').drawImage(img, 0, 0, px, px);
    return await new Promise((r) => c.toBlob(r, 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function copy(text, done) {
  try {
    await navigator.clipboard.writeText(text);
    setMsg(done, 'ok');
  } catch {
    prompt('Copy this:', text);
  }
}

// Thumbnails load as their cards come into view, a few screens ahead at most
// (all at once where IntersectionObserver is missing).
const thumbs = 'IntersectionObserver' in window
  ? new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      thumbs.unobserve(e.target);
      e.target._load?.();
    }
  }, { rootMargin: '600px 0px' })
  : { observe: (img) => queueMicrotask(() => img._load?.()), unobserve() {}, disconnect() {} };

function render(designs) {
  thumbs.disconnect();
  const list = $('list');
  list.replaceChildren();
  for (const d of designs) {
    const card = el('article', 'panel saved');
    const img = el('img', 'saved-img');
    img.alt = d.name;
    img.width = img.height = 200;
    const info = el('div', 'saved-info');
    const title = el('h2', null, d.name);
    info.append(title);
    if (d.details) info.append(el('p', 'saved-details', d.details));
    const m = d.meta || {};
    const facts = el('dl', 'metrics');
    const fact = (k, v) => facts.append(el('dt', null, k), el('dd', null, v));
    fact('Scan reliability', pct(m.reliability));
    fact('Min print size', m.minMm ? `${Math.ceil(m.minMm)} mm` : '—');
    fact('Logo match', pct(m.match));
    if (m.printMm) fact(`At ${m.printMm} mm`, pct(m.atPrint));
    if (d.link) fact('Short link', `/c/${d.link.code} → ${d.link.url ?? '(deleted)'}`);
    fact('Saved', new Date(d.created_at * 1000).toLocaleString());
    if (d.author) fact('Author', d.author);
    info.append(facts, el('p', 'hint mono', d.text));

    let svg = null;
    // Just the SVG (not the stored logo), fetched once the card scrolls into view.
    const getSvg = async () => (svg ??= await apiText('qr.read', { id: d.id, format: 'svg' }));
    thumbs.observe(img);
    img._load = () => getSvg().then((s) => {
      const url = URL.createObjectURL(new Blob([s], { type: 'image/svg+xml' }));
      img.addEventListener('load', () => URL.revokeObjectURL(url), { once: true });
      img.addEventListener('error', () => URL.revokeObjectURL(url), { once: true });
      img.src = url;
    }).catch(() => {});

    const actions = el('div', 'actions');
    const btn = (label, fn, cls = '') => {
      const b = el('button', cls, label);
      b.type = 'button';
      b.addEventListener('click', async () => { try { await fn(); } catch (e) { setMsg(e.message, 'bad'); } });
      return b;
    };
    actions.append(
      btn('PNG', async () => download(await pngFromSvg(await getSvg(), 2048), `${fileBase(d)}.png`), 'primary'),
      btn('SVG', async () => download(new Blob([await getSvg()], { type: 'image/svg+xml' }), `${fileBase(d)}.svg`)),
      btn('Copy id', async () => copy(String(d.id), `Copied id ${d.id}: other projects fetch the image with qr.read {id: ${d.id}, format: "svg"}.`)),
      // Opens the code in the generator: same link, logo and settings, ready to
      // regenerate and replace this code or save a variation as a new one.
      btn('Edit', async () => { location.href = `index.html?edit=${d.id}`; }),
      btn('Delete', async () => {
        if (!confirm(`Delete "${d.name}"? This removes the saved design only; any short link keeps working.`)) return;
        await api('qr.delete', { id: d.id });
        await load();
      }),
    );
    info.append(actions);
    card.append(img, info);
    list.append(card);
  }
  setMsg(designs.length ? '' : 'No saved codes yet. Generate one on the Make page and press Save.');
}

async function load() {
  if (!getToken()) return setMsg('Enter your admin token to see saved codes.', 'warn');
  try {
    setMsg('Loading…');
    const author = $('author').value.trim();
    render((await api('qr.read', { limit: 200, ...(author ? { author } : {}) })).designs);
  } catch (e) {
    $('list').replaceChildren();
    setMsg(e.message, 'bad');
  }
}

$('author').value = new URLSearchParams(location.search).get('author') || '';
$('author').addEventListener('change', () => {
  const u = new URL(location.href);
  if ($('author').value.trim()) u.searchParams.set('author', $('author').value.trim()); else u.searchParams.delete('author');
  history.replaceState(null, '', u);
  load();
});

bindSignIn(() => load());
load();
