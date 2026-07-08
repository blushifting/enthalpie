// Client API du backend Apps Script (cf. BUILD-PWA.md §1, backend/README.md).
// Réponses : { ok:true, action, data } | { ok:false, error }.
import { store } from './store.js';

// Mode démo : ?demo dans l'URL -> sert la fixture locale, sans token ni réseau.
export const IS_DEMO = new URLSearchParams(location.search).has('demo');

class ApiError extends Error {
  constructor(message, kind = 'api') { super(message); this.name = 'ApiError'; this.kind = kind; }
}
export { ApiError };

async function parseResponse(res) {
  if (!res.ok) throw new ApiError(`HTTP ${res.status}`, 'http');
  let json;
  try { json = await res.json(); }
  catch { throw new ApiError('Réponse illisible du serveur', 'parse'); }
  if (!json || json.ok !== true) {
    throw new ApiError((json && json.error) || 'Erreur inconnue', 'backend');
  }
  return json.data;
}

// --- Lecture (GET) ---
export async function apiGet(action, params = {}) {
  if (IS_DEMO) return demoData(action);
  const token = store.getToken();
  if (!token) throw new ApiError('Token manquant', 'noauth');
  const url = new URL(store.getApiBase());
  url.searchParams.set('token', token);
  url.searchParams.set('action', action);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  let res;
  try { res = await fetch(url.toString(), { method: 'GET', redirect: 'follow' }); }
  catch { throw new ApiError('Réseau indisponible', 'network'); }
  return parseResponse(res);
}

// --- Écriture (POST) ---
// Corps en text/plain (JSON.stringify) pour éviter le pre-flight CORS ; le
// backend parse postData.contents (BUILD-PWA.md §1).
export async function apiPost(body) {
  if (IS_DEMO) return { demo: true, ...body };
  const token = store.getToken();
  if (!token) throw new ApiError('Token manquant', 'noauth');
  let res;
  try {
    res = await fetch(store.getApiBase(), {
      method: 'POST',
      redirect: 'follow',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ token, ...body }),
    });
  } catch { throw new ApiError('Réseau indisponible', 'network'); }
  return parseResponse(res);
}

// Raccourcis typés.
export const getState   = () => apiGet('state');
export const getCatalog = () => apiGet('catalog');
export const getCourses = () => apiGet('courses');
export const postLog     = (payload) => apiPost({ action: 'log', ...payload });
export const logProduit  = (ref, quantite) => postLog({ type: 'produit', ref, quantite });
export const logPlat     = (ref, quantite = 1) => postLog({ type: 'plat', ref, quantite });

// --- Fixture démo (chargée à la volée) ---
let _demoCache;
async function demoData(action) {
  if (!_demoCache) {
    const res = await fetch(new URL('../demo/state.json', import.meta.url));
    _demoCache = await res.json();
  }
  const map = { state: _demoCache.state, catalog: _demoCache.catalog, courses: _demoCache.courses };
  if (!(action in map)) throw new ApiError('Action démo inconnue : ' + action, 'backend');
  return map[action];
}
