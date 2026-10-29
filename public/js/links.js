import { api, getToken, bindSignIn } from './auth.js';

const $ = (id) => document.getElementById(id);


function setMsg(text, kind = '') {
  $('msg').textContent = text;
  $('msg').className = 'status ' + kind;
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
        try { await api('link.update', { code: l.code, url: next }); await load(); } catch (e) { setMsg(e.message, 'bad'); }
      }),
      button('Author', async () => {
        const next = prompt(`Which author owns /c/${l.code}? Their API token can read and repoint it. Leave empty for none.`, l.author || '');
        if (next === null || next.trim() === (l.author || '')) return;
        try { await api('link.update', { code: l.code, new_author: next.trim() }); await load(); } catch (e) { setMsg(e.message, 'bad'); }
      }),
      button('Delete', async () => {
        if (!confirm(`Delete /c/${l.code}? Printed codes will stop working and the code is never reused.`)) return;
        try { await api('link.delete', { code: l.code }); await load(); } catch (e) { setMsg(e.message, 'bad'); }
      }),
    );
    tr.append(code, dest, cell(l.author || '—'), cell(String(l.hits), 'num'), cell(new Date(l.created_at * 1000).toLocaleDateString()), actions);
    rows.append(tr);
  }
  $('table').hidden = links.length === 0;
  setMsg(links.length ? '' : 'No links yet.');
}

async function load() {
  if (!getToken()) return setMsg('Enter your admin token to manage links.', 'warn');
  try {
    setMsg('Loading…');
    render((await api('link.read', { limit: 200 })).links);
  } catch (e) {
    $('table').hidden = true;
    setMsg(e.message, 'bad');
  }
}

$('refresh').addEventListener('click', load);

$('create').addEventListener('click', async () => {
  const box = $('created');
  box.hidden = true;
  if (!getToken()) return setMsg('Enter your admin token first.', 'warn');
  try {
    const l = await api('link.create', { url: $('dest').value, label: $('label').value || undefined, author: $('author').value.trim() || undefined });
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

// Suggest authorized authors (names only) in the Author field.
const loadAuthors = () => getToken() && api('author.read').then(({ authors }) => {
  $('authorList').replaceChildren(...authors.map((a) => Object.assign(document.createElement('option'), { value: a.name })));
}).catch(() => { /* suggestions only */ });

bindSignIn(() => { load(); loadAuthors(); });
loadAuthors();
load();
