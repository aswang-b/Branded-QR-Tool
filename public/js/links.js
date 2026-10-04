const $ = (id) => document.getElementById(id);

const store = (area) => { try { return window[area]; } catch { return null; } };
let token = store('sessionStorage')?.getItem('adminToken') || store('localStorage')?.getItem('adminToken') || '';
$('token').value = token;
$('remember').checked = !!store('localStorage')?.getItem('adminToken');

function setMsg(text, kind = '') {
  $('msg').textContent = text;
  $('msg').className = 'status ' + kind;
}

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

const cell = (text, cls) => {
  const td = document.createElement('td');
  td.textContent = text;
  if (cls) td.className = cls;
  return td;
};

function button(text, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'small';
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
}

const qrHref = (short) => `index.html?text=${encodeURIComponent(short)}`;

function render(links) {
  const rows = $('rows');
  rows.replaceChildren();
  for (const l of links) {
    const tr = document.createElement('tr');
    const code = document.createElement('td');
    const a = document.createElement('a');
    a.href = l.short;
    a.textContent = l.code;
    a.target = '_blank';
    a.rel = 'noopener';
    code.append(a);
    const dest = document.createElement('td');
    dest.className = 'dest';
    dest.textContent = l.url;
    if (l.label) {
      const small = document.createElement('div');
      small.className = 'muted';
      small.textContent = l.label;
      dest.prepend(small);
    }
    const actions = document.createElement('td');
    actions.className = 'actions-cell';
    const qr = document.createElement('a');
    qr.href = qrHref(l.short);
    qr.textContent = 'QR';
    qr.className = 'btnlink';
    actions.append(
      qr,
      button('Edit', async () => {
        const next = prompt(`Where should /c/${l.code} go?`, l.url);
        if (next === null || next.trim() === l.url) return;
        try { await api(`/api/links/${l.code}`, { method: 'PATCH', body: { url: next } }); await load(); } catch (e) { setMsg(e.message, 'bad'); }
      }),
      button('Delete', async () => {
        if (!confirm(`Delete /c/${l.code}? Printed codes will stop working and the code is never reused.`)) return;
        try { await api(`/api/links/${l.code}`, { method: 'DELETE' }); await load(); } catch (e) { setMsg(e.message, 'bad'); }
      }),
    );
    tr.append(code, dest, cell(String(l.hits), 'num'), cell(new Date(l.created_at * 1000).toLocaleDateString()), actions);
    rows.append(tr);
  }
  $('table').hidden = links.length === 0;
  setMsg(links.length ? '' : 'No links yet.');
}

async function load() {
  if (!token) return setMsg('Enter your admin token to manage links.', 'warn');
  try {
    setMsg('Loading…');
    render((await api('/api/links?limit=200')).links);
  } catch (e) {
    $('table').hidden = true;
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
$('refresh').addEventListener('click', load);

$('create').addEventListener('click', async () => {
  const box = $('created');
  box.hidden = true;
  if (!token) return setMsg('Enter your admin token first.', 'warn');
  try {
    const l = await api('/api/links', { method: 'POST', body: { url: $('dest').value, label: $('label').value || undefined } });
    box.hidden = false;
    box.replaceChildren();
    const strong = document.createElement('strong');
    strong.textContent = l.short;
    const go = document.createElement('a');
    go.href = qrHref(l.short);
    go.className = 'btnlink primary';
    go.textContent = 'Make the QR code →';
    box.append('Created ', strong, ' ', go);
    $('dest').value = '';
    $('label').value = '';
    await load();
  } catch (e) {
    setMsg(e.message, 'bad');
  }
});

load();
