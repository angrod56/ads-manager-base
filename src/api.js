import 'dotenv/config';

const BASE_URL = 'https://graph.facebook.com';
const VERSION = process.env.META_API_VERSION || 'v21.0';
const TOKEN = process.env.META_ACCESS_TOKEN;

if (!TOKEN || TOKEN === 'your_token_here') {
  console.error('[ERROR] META_ACCESS_TOKEN no configurado en .env');
  process.exit(1);
}

/**
 * Cliente base para Meta Marketing API.
 * Todas las funciones del proyecto pasan por aquí.
 *
 * @param {string} endpoint - Ruta relativa, ej: '/me/adaccounts'
 * @param {Object} params   - Query params adicionales
 * @param {string} method   - HTTP method (GET | POST)
 * @param {Object} body     - Body para POST requests
 */
export async function apiRequest(endpoint, params = {}, method = 'GET', body = null) {
  const url = new URL(`${BASE_URL}/${VERSION}${endpoint}`);

  url.searchParams.set('access_token', TOKEN);

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, value);
    }
  }

  const options = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };

  if (method === 'POST' && body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url.toString(), options);
  const json = await response.json();

  if (!response.ok || json.error) {
    const err = json.error || { message: `HTTP ${response.status}` };
    throw new Error(`[Meta API] ${err.message} (code: ${err.code || response.status})`);
  }

  return json;
}

/**
 * Pagina automáticamente todos los resultados de un endpoint.
 * Útil para endpoints con muchos registros.
 *
 * @param {string} endpoint
 * @param {Object} params
 * @returns {Array} Todos los items acumulados
 */
export async function paginateAll(endpoint, params = {}) {
  let results = [];
  let nextUrl = null;

  const first = await apiRequest(endpoint, params);
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
