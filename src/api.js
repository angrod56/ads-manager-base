import 'dotenv/config';

const BASE_URL = 'https://graph.facebook.com';
const VERSION = process.env.META_API_VERSION || 'v21.0';
const ENV_TOKEN = process.env.META_ACCESS_TOKEN;

export async function apiRequest(endpoint, params = {}, method = 'GET', body = null, token = null) {
  const activeToken = token || ENV_TOKEN;
  if (!activeToken) throw new Error('No hay token de Meta configurado');

  const url = new URL(`${BASE_URL}/${VERSION}${endpoint}`);
  url.searchParams.set('access_token', activeToken);

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, value);
    }
  }

  const options = { method };

  if (method === 'POST' && body) {
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(body)) form.set(k, v);
    options.headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
    options.body = form.toString();
  }

  const response = await fetch(url.toString(), options);
  const json = await response.json();

  if (!response.ok || json.error) {
    const err = json.error || { message: `HTTP ${response.status}` };
    throw new Error(`[Meta API] ${err.message} (code: ${err.code || response.status})`);
  }

  return json;
}

export async function paginateAll(endpoint, params = {}, token = null) {
  let results = [];
  let nextUrl = null;

  const first = await apiRequest(endpoint, params, 'GET', null, token);
  results = results.concat(first.data || []);
  nextUrl = first.paging?.next || null;

  while (nextUrl) {
    const response = await fetch(nextUrl);
    const json = await response.json();

    if (json.error) throw new Error(`[Meta API] ${json.error.message}`);

    results = results.concat(json.data || []);
    nextUrl = json.paging?.next || null;
  }

  return results;
}
