const BASE = import.meta.env.VITE_API_URL || 'http://localhost:4000';

// The token lives in sessionStorage (cleared when the tab closes) and is sent as a Bearer header,
// so no cookie is involved and CSRF does not apply. The server re-checks role on every request:
// the UI only hides things, it never grants anything.
let token = sessionStorage.getItem('bv_token');
export const setToken = (t) => {
  token = t;
  if (t) sessionStorage.setItem('bv_token', t);
  else sessionStorage.removeItem('bv_token');
};
export const hasToken = () => Boolean(token);

export async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data.issues?.map((i) => `${i.path}: ${i.message}`).join('; ');
    const err = new Error(detail || data.error || `request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const money = (cents) => (cents / 100).toLocaleString(undefined, { style: 'currency', currency: 'USD' });
export const toCents = (str) => Math.round(Number(str) * 100);
export const newKey = () => crypto.randomUUID();
