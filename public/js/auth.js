// Admin sign-in and API calls, shared by every page.
//
// The admin token lives in sessionStorage, and also in localStorage when
// "Remember on this device" is ticked. Both copies are always written and
// cleared together, so a stale remembered token can never outlive a new one.

const KEY = 'adminToken';
export const store = (area) => { try { return window[area]; } catch { return null; } };

export const getToken = () => store('sessionStorage')?.getItem(KEY) || store('localStorage')?.getItem(KEY) || '';
export const isRemembered = () => !!store('localStorage')?.getItem(KEY);

/** Use this token from now on (and keep remembering it if a token was remembered). */
export function setToken(token, remember = isRemembered()) {
  store('sessionStorage')?.setItem(KEY, token);
  if (remember) store('localStorage')?.setItem(KEY, token);
  else store('localStorage')?.removeItem(KEY);
}

export function clearToken() {
  store('sessionStorage')?.removeItem(KEY);
  store('localStorage')?.removeItem(KEY);
  window.dispatchEvent(new Event('auth-change'));
}

/**
 * Calls an API method, e.g. api('link.update', { code, url }) (see src/worker.js).
 * A rejected token is forgotten, so the next sign-in starts clean.
 */
export async function api(method, params = {}) {
  const res = await fetch(`/api/${method}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) clearToken();
  if (!res.ok) {
    const err = new Error(res.status === 401 ? 'Wrong or missing admin token.' : data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/** Calls a method that answers with something other than JSON (e.g. qr.read with format "svg"). */
export async function apiText(method, params = {}) {
  const res = await fetch(`/api/${method}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (res.status === 401) clearToken();
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(res.status === 401 ? 'Wrong or missing admin token.' : data.error || `Request failed (${res.status})`);
  }
  return res.text();
}

/**
 * Wires a page's sign-in form (#signin with #token and #remember) to the
 * stored token and calls onSignIn after a new token is entered or on sign out.
 *
 * While signed in, the form (and its password field) is hidden and a small
 * "Signed in" bar with Sign out takes its place. A filled password field on
 * every page made mobile Chrome offer to save the password over and over.
 *
 * Pressing Enter or Sign in fires the field's change event and the submit
 * together; they are collapsed into one sign-in.
 *
 * @param {() => void} onSignIn
 * @param {{bar?: boolean, showToken?: boolean}} opts  bar: false leaves the form's
 *   visibility to the page; showToken: the bar can show and copy the token.
 */
export function bindSignIn(onSignIn, { bar = true, showToken = false } = {}) {
  const $ = (id) => document.getElementById(id);
  const form = $('signin'), input = $('token'), remember = $('remember');
  remember.checked = isRemembered();
  input.value = '';

  let barEl = null, tokenEl = null, showBtn = null;
  if (bar) {
    barEl = document.createElement('div');
    barEl.className = 'signed-in row';
    const label = document.createElement('span');
    label.textContent = 'Signed in as admin';
    barEl.append(label);
    const button = (text, onClick) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'small';
      b.textContent = text;
      b.addEventListener('click', onClick);
      return b;
    };
    if (showToken) {
      // The token as text, never in a password field (see above).
      tokenEl = document.createElement('code');
      tokenEl.className = 'mono token';
      let shown = false;
      const mask = () => { const t = getToken(); tokenEl.textContent = shown ? t : `${t.slice(0, 4)}${'•'.repeat(10)}`; };
      showBtn = button('Show token', () => { shown = !shown; showBtn.textContent = shown ? 'Hide token' : 'Show token'; mask(); });
      const copyBtn = button('Copy token', async () => {
        try { await navigator.clipboard.writeText(getToken()); copyBtn.textContent = 'Copied'; setTimeout(() => { copyBtn.textContent = 'Copy token'; }, 1500); }
        catch { prompt('Copy your admin token:', getToken()); }
      });
      tokenEl._mask = mask;
      barEl.append(tokenEl, showBtn, copyBtn);
    }
    barEl.append(button('Sign out', () => { clearToken(); onSignIn(); }));
    form.after(barEl);
  }

  const update = () => {
    if (!bar) return;
    const signedIn = !!getToken();
    form.hidden = signedIn;
    barEl.hidden = !signedIn;
    if (signedIn) input.value = ''; // no password value left on the page
    tokenEl?._mask();
  };

  let last = null;
  const apply = () => {
    const token = input.value.trim();
    const now = Date.now();
    if (last && last.token === token && now - last.at < 1500) return;
    last = { token, at: now };
    setToken(token, remember.checked);
    update();
    onSignIn();
  };
  input.addEventListener('change', apply);
  form.addEventListener('submit', (e) => { e.preventDefault(); apply(); });
  remember.addEventListener('change', () => { if (getToken()) setToken(getToken(), remember.checked); });
  // A rejected token is cleared by api(): show the form again.
  window.addEventListener('auth-change', update);
  update();
}
