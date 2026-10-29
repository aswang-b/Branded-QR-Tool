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
 * stored token and calls onSignIn after a new token is entered. Pressing
 * Enter or Sign in fires the field's change event and the submit together;
 * they are collapsed into one sign-in.
 */
export function bindSignIn(onSignIn) {
  const $ = (id) => document.getElementById(id);
  const input = $('token'), remember = $('remember');
  input.value = getToken();
  remember.checked = isRemembered();
  let last = null;
  const apply = () => {
    const token = input.value.trim();
    const now = Date.now();
    if (last && last.token === token && now - last.at < 1500) return;
    last = { token, at: now };
    setToken(token, remember.checked);
    onSignIn();
  };
  input.addEventListener('change', apply);
  $('signin').addEventListener('submit', (e) => { e.preventDefault(); apply(); });
  remember.addEventListener('change', () => setToken(getToken(), remember.checked));
}
