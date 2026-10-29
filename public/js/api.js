// API page: fetches the specification from spec.read (admin only, so the spec
// itself stays behind the token) and renders it. Everything is built with
// textContent; nothing from the response is parsed as HTML.

const $ = (id) => document.getElementById(id);
const store = (area) => { try { return window[area]; } catch { return null; } };
let token = store('sessionStorage')?.getItem('adminToken') || store('localStorage')?.getItem('adminToken') || '';
$('token').value = token;
$('remember').checked = !!store('localStorage')?.getItem('adminToken');

const setMsg = (text, kind = '') => { $('msg').textContent = text; $('msg').className = 'status ' + kind; };

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const code = (text) => el('code', null, text);
const ROLE_NAMES = { admin: 'Admin token', api: 'API key' };

function table(headers, rows) {
  const wrap = el('div', 'table-wrap');
  const t = el('table');
  const head = el('tr');
  for (const h of headers) head.append(el('th', null, h));
  const thead = el('thead');
  thead.append(head);
  const body = el('tbody');
  for (const cells of rows) {
    const tr = el('tr');
    for (const c of cells) {
      const td = el('td');
      td.append(...(Array.isArray(c) ? c : [c]));
      tr.append(td);
    }
    body.append(tr);
  }
  t.append(thead, body);
  wrap.append(t);
  return wrap;
}

function section(title, ...children) {
  const s = el('section', 'panel');
  s.append(el('h2', null, title), ...children);
  return s;
}

function exampleCall(spec, m, role) {
  const url = spec.base.replace('<method>', m.name);
  const tokenVar = role === 'api' ? '$API_TOKEN' : '$ADMIN_TOKEN';
  return [
    `curl -X POST ${url} \\`,
    `  -H "Authorization: Bearer ${tokenVar}" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '${JSON.stringify(m.example ?? {})}'`,
  ].join('\n');
}

function overview(spec) {
  const list = el('dl', 'metrics');
  const add = (k, ...v) => { const dd = el('dd'); dd.append(...v); list.append(el('dt', null, k), dd); };
  add('Endpoint', code(spec.base));
  add('Calling', spec.transport);
  add('Auth', spec.auth);
  add('Errors', 'Status code plus ', code(spec.errorBody), ' (see Errors below).');
  for (const [role, text] of Object.entries(spec.roles)) add(ROLE_NAMES[role] || role, text);
  return section('Overview', list);
}

/** The API key's capabilities in plain words, from the methods it may call. */
function apiKeyActions(spec) {
  const can = spec.methods.filter((m) => m.roles.includes('api'));
  const cannot = spec.methods.filter((m) => !m.roles.includes('api'));
  const ul = el('ul', 'api-list');
  for (const m of can) {
    const li = el('li');
    const scoped = m.params.some((p) => p.name === 'author' && p.required === 'API key');
    li.append(code(m.name), ` ${m.summary}${scoped ? ' Only for the author passed in "author".' : ''}`);
    ul.append(li);
  }
  const no = el('p', 'hint');
  no.append('Admin only: ', ...cannot.flatMap((m, i) => [i ? ', ' : '', code(m.name)]),
    '. The API key also cannot move a code to another author (new_author).');
  return section('What the API key can do', ul, no);
}

function objects(spec) {
  const out = [];
  for (const [name, fields] of Object.entries(spec.objects)) {
    out.push(el('h3', null, name === 'design' ? 'Saved code (design)' : 'Link'));
    out.push(table(['Field', 'Type and meaning'], Object.entries(fields).map(([k, v]) => [code(k), v])));
  }
  return section('Objects returned', ...out);
}

function method(spec, m) {
  const s = el('section', 'panel api-method');
  s.id = m.name;
  const h = el('h2');
  h.append(code(m.name));
  const tags = el('p', 'api-tags');
  for (const v of m.verbs) tags.append(el('span', 'badge', v));
  for (const r of m.roles) tags.append(el('span', `badge role-${r}`, ROLE_NAMES[r] || r));
  s.append(h, tags, el('p', null, m.summary));
  if (m.params.length) {
    s.append(el('h3', null, 'Params'));
    s.append(table(['Name', 'Type', 'Required', 'Description'], m.params.map((p) => [
      code(p.name), p.type, p.required === true ? 'yes' : p.required === false ? 'no' : `with the ${p.required}`, p.desc,
    ])));
  } else {
    s.append(el('p', 'hint', 'No params.'));
  }
  const ret = el('p');
  ret.append(el('strong', null, 'Returns: '), m.returns);
  s.append(ret);
  if (m.notes) s.append(el('p', 'hint', m.notes));
  s.append(el('h3', null, 'Example'));
  s.append(el('pre', 'code-block', exampleCall(spec, m, m.roles.includes('api') ? 'api' : 'admin')));
  return s;
}

function render(spec) {
  const root = $('spec');
  const toc = el('p', 'api-toc');
  toc.append('Methods: ', ...spec.methods.flatMap((m, i) => {
    const a = el('a', null, m.name);
    a.href = `#${m.name}`;
    return i ? [' · ', a] : [a];
  }));
  root.replaceChildren(
    overview(spec),
    apiKeyActions(spec),
    section('Methods', toc),
    ...spec.methods.map((m) => method(spec, m)),
    objects(spec),
    section('Errors', table(['Status', 'Meaning'], spec.errors.map((e) => [String(e.status), e.meaning]))),
  );
  root.hidden = false;
}

async function load() {
  $('spec').hidden = true;
  if (!token) return setMsg('Enter your admin token to see the API specification.', 'warn');
  try {
    setMsg('Loading…');
    const res = await fetch('/api/spec.read', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(res.status === 401 ? 'Wrong admin token.' : data.error || `Request failed (${res.status})`);
    render(data);
    setMsg('');
  } catch (e) {
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
