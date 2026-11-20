// Authors page: create, view, copy, rotate and revoke author API tokens, set
// an author's own short-link address (author.* methods, admin only), and
// view/copy this browser's admin token.

import { api, getToken, bindSignIn } from './auth.js';

const $ = (id) => document.getElementById(id);

const setMsg = (text, kind = '') => { $('msg').textContent = text; $('msg').className = 'status ' + kind; };

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const button = (label, onClick, cls = 'small') => {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', async () => { try { await onClick(b); } catch (e) { setMsg(e.message, 'bad'); } });
  return b;
};
const mask = (t) => `${t.slice(0, 8)}${'•'.repeat(12)}`;
const when = (s) => (s ? new Date(s * 1000).toLocaleString() : 'never');

async function copy(text, done) {
  try {
    await navigator.clipboard.writeText(text);
    setMsg(done, 'ok');
  } catch {
    prompt('Copy this:', text);
  }
}

/**
 * The author's own short-link address (author.update {short_base}). Empty:
 * their codes print this site's address.
 */
function shortBaseField(a) {
  const input = el('input');
  Object.assign(input, { type: 'text', value: a.short_base || '', placeholder: 'this site', spellcheck: false, autocomplete: 'off', maxLength: 200 });
  input.setAttribute('aria-label', `Short address for ${a.name}`);
  const save = button('Save', async () => {
    const next = input.value.trim().replace(/\/+$/, '');
    const old = a.short_base || '';
    if (next.toLowerCase() === old) return setMsg(`${a.name}'s short address is unchanged.`);
    const warn = old ? `\n\nCodes already printed with ${old}/c/… stop working.` : '';
    const ask = next
      ? `Print ${a.name}'s codes as ${next}/c/<code>?\n\nThat site must already serve /c/<code> by asking this site with the X-Short-Link-Host header.${warn}`
      : `Print ${a.name}'s codes with this site's address again?${warn}`;
    if (!confirm(ask)) return;
    const saved = await api('author.update', { name: a.name, short_base: next });
    await load(saved.short_base ? `${a.name}'s codes now print ${saved.short_base}/c/<code>.` : `${a.name}'s codes now print this site's address.`);
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save.click(); });
  const wrap = el('div', 'row nowrap');
  wrap.append(input, save);
  return wrap;
}

function render(authors) {
  const rows = $('rows');
  rows.replaceChildren();
  for (const a of authors) {
    const tr = el('tr');
    const tokenCell = el('td');
    const shown = el('code', 'mono token', mask(a.token));
    let visible = false;
    tokenCell.append(shown, ' ',
      button('Show', (b) => { visible = !visible; shown.textContent = visible ? a.token : mask(a.token); b.textContent = visible ? 'Hide' : 'Show'; }),
      ' ',
      button('Copy', () => copy(a.token, `Copied ${a.name}'s token.`)));
    const codes = el('a', null, `${a.codes} code${a.codes === 1 ? '' : 's'}`);
    codes.href = `saved.html?author=${encodeURIComponent(a.name)}`;
    const codesCell = el('td');
    codesCell.append(codes, `, ${a.links} link${a.links === 1 ? '' : 's'}`);
    const shortCell = el('td', 'short-base');
    shortCell.append(shortBaseField(a));
    const actions = el('td', 'row');
    actions.append(
      button('Rotate', async () => {
        if (!confirm(`Give ${a.name} a new token? The current one stops working immediately.`)) return;
        await api('author.update', { name: a.name, rotate_token: true });
        await load(`New token issued for ${a.name}.`);
      }),
      button('Rename', async () => {
        const next = prompt('New name (their saved codes are relabelled too):', a.name);
        if (next === null || next.trim() === a.name) return;
        try {
          await api('author.update', { name: a.name, new_name: next });
        } catch (e) {
          if (!/adopt_existing/.test(e.message) || !confirm(`${e.message.replace(/ Send.*$/, '')}

Give them to ${next.trim()}?`)) throw e;
          await api('author.update', { name: a.name, new_name: next, adopt_existing: true });
        }
        await load(`Renamed to ${next.trim()}.`);
      }),
      button('Revoke', async () => {
        if (!confirm(`Revoke ${a.name}? Their token stops working; their saved codes stay.`)) return;
        await api('author.delete', { name: a.name });
        await load(`Revoked ${a.name}.`);
      }),
    );
    tr.append(el('td', null, a.name), tokenCell, codesCell, shortCell, el('td', null, when(a.last_used)), actions);
    rows.append(tr);
  }
  $('table').hidden = !authors.length;
}

async function load(done = '') {
  if (!getToken()) { $('table').hidden = true; return setMsg('Enter your admin token to manage authors.', 'warn'); }
  try {
    const { authors } = await api('author.read', { include_tokens: true });
    render(authors);
    setMsg(done || (authors.length ? '' : 'No authors yet. Add one above to give them an API token.'), done ? 'ok' : '');
  } catch (e) {
    $('table').hidden = true;
    setMsg(e.message, 'bad');
  }
}

$('create').addEventListener('click', async () => {
  const name = $('newName').value.trim();
  if (!name) return setMsg('Enter the author\'s name first.', 'warn');
  try {
    let a;
    try {
      a = await api('author.create', { name });
    } catch (e) {
      if (!/adopt_existing/.test(e.message) || !confirm(`${e.message.replace(/ Send.*$/, '')}

Give them to ${name}'s new token?`)) throw e;
      a = await api('author.create', { name, adopt_existing: true });
    }
    $('newName').value = '';
    await load(`Created a token for ${a.name}. You can view or copy it below at any time.`);
  } catch (e) {
    setMsg(e.message, 'bad');
  }
});


$('refresh').addEventListener('click', () => load());

bindSignIn(() => load(), { showToken: true });
load();
