const $ = (id) => document.getElementById(id);
const pct = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`);

const store = (area) => { try { return window[area]; } catch { return null; } };
let token = store('sessionStorage')?.getItem('adminToken') || store('localStorage')?.getItem('adminToken') || '';
$('token').value = token;
$('remember').checked = !!store('localStorage')?.getItem('adminToken');

const setMsg = (text, kind = '') => { $('msg').textContent = text; $('msg').className = 'status ' + kind; };

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(res.status === 401 ? 'Wrong admin token.' : data.error || `Request failed (${res.status})`);
  return data;
}

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
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = c.height = px;
    c.getContext('2d').drawImage(img, 0, 0, px, px);
    return await new Promise((r) => c.toBlob(r, 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}

function render(designs) {
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
    info.append(facts, el('p', 'hint mono', d.text));

    let svg = null;
    const getSvg = async () => (svg ??= (await api(`/api/designs/${d.id}`)).svg);
    getSvg().then((s) => { img.src = URL.createObjectURL(new Blob([s], { type: 'image/svg+xml' })); }).catch(() => {});

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
      btn('Edit', async () => {
        const name = prompt('Name', d.name);
        if (name === null) return;
        const details = prompt('Details', d.details);
        if (details === null) return;
        await api(`/api/designs/${d.id}`, { method: 'PATCH', body: { name, details } });
        await load();
      }),
      btn('Delete', async () => {
        if (!confirm(`Delete "${d.name}"? This removes the saved design only; any short link keeps working.`)) return;
        await api(`/api/designs/${d.id}`, { method: 'DELETE' });
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
  if (!token) return setMsg('Enter your admin token to see saved codes.', 'warn');
  try {
    setMsg('Loading…');
    render((await api('/api/designs?limit=200')).designs);
  } catch (e) {
    $('list').replaceChildren();
    setMsg(e.message, 'bad');
  }
}

$('token').addEventListener('change', () => {
  token = $('token').value.trim();
  store('sessionStorage')?.setItem('adminToken', token);
  if ($('remember').checked) store('localStorage')?.setItem('adminToken', token);
  load();
});
$('remember').addEventListener('change', () => {
  if ($('remember').checked) store('localStorage')?.setItem('adminToken', token);
  else store('localStorage')?.removeItem('adminToken');
});

load();
