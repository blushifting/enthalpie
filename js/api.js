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
  if (IS_DEMO) return demoData(action, params);
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
  if (IS_DEMO) {
    // Écho suffisant pour l'UI ; pour les courses on simule la réponse backend
    // (portions ajoutées) afin que l'annulation fonctionne aussi en démo.
    if (body && body.type === 'courses') {
      return { courses_validees: (body.items || []).map((i) => ({ produit_id: i.produit_id, portions: Number(i.unites) || 0 })) };
    }
    // Ajout catalogue depuis un scan : on simule un produit créé (id factice).
    if (body && body.action === 'add_produit') {
      const f = body.produit || {};
      return { produit: { id: 'Pdemo', actif: 'oui', ...f }, demo: true };
    }
    return { demo: true, ...body };
  }
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
export const getCuisine = () => apiGet('cuisine');
export const getBilan   = () => apiGet('bilan');
export const postLog     = (payload) => apiPost({ action: 'log', ...payload });
export const logProduit  = (ref, quantite) => postLog({ type: 'produit', ref, quantite });
export const logPlat     = (ref, quantite = 1) => postLog({ type: 'plat', ref, quantite });
export const adjustStock = (ref, delta) => postLog({ type: 'ajustement', ref, delta });
export const logCourses  = (items) => postLog({ type: 'courses', items });
export const logPotFini  = (ref) => postLog({ type: 'pot_fini', ref, source: 'scan' });
export const logBatch    = (ref) => postLog({ type: 'batch_cuisine', ref });

// --- Scan : ajout catalogue + recherche (action dédiée, hors "log") ---
// Nécessitent le redéploiement du backend (endpoints add_produit / search_catalog).
export const addProduit    = (produit) => apiPost({ action: 'add_produit', produit });
export const searchCatalog = (q) => apiGet('search_catalog', { q });

// --- Fixture démo (chargée à la volée) ---
let _demoCache;
async function demoData(action, params = {}) {
  if (!_demoCache) {
    const res = await fetch(new URL('../demo/state.json', import.meta.url));
    _demoCache = await res.json();
  }
  // Recherche catalogue simulée (tuile « ➕ autre »).
  if (action === 'search_catalog') {
    const q = String(params.q || '').toLowerCase();
    const produits = (_demoCache.catalog.produits || []).filter((p) =>
      !q || String(p.nom).toLowerCase().includes(q) || String(p.ean || '').includes(q));
    return JSON.parse(JSON.stringify({ produits }));
  }
  const map = { state: _demoCache.state, catalog: _demoCache.catalog, courses: _demoCache.courses,
    cuisine: _demoCache.cuisine, bilan: _demoCache.bilan };
  if (!(action in map)) throw new ApiError('Action démo inconnue : ' + action, 'backend');
  // Copie profonde : l'UI peut muter l'objet (retrait optimiste) sans corrompre la fixture.
  return JSON.parse(JSON.stringify(map[action]));
}

/* ------------------------------------------------------------------ */
/* OpenFoodFacts — fiche produit depuis un EAN (scan produit inconnu)   */
/* ------------------------------------------------------------------ */
// API publique, CORS ouvert : appel direct navigateur (le service worker
// laisse passer sans cacher, cf. sw.js). Renvoie une fiche normalisée ou null.
const OFF_BASE = 'https://world.openfoodfacts.org/api/v2/product/';
const OFF_FIELDS = 'product_name,brands,quantity,nutriments,allergens_tags';

export async function fetchOFF(ean) {
  const code = String(ean || '').replace(/\D/g, '');
  if (!code) return null;
  let res;
  try {
    res = await fetch(`${OFF_BASE}${code}.json?fields=${OFF_FIELDS}`, { redirect: 'follow' });
  } catch { throw new ApiError('Réseau indisponible (OpenFoodFacts)', 'network'); }
  if (!res.ok && res.status !== 404) throw new ApiError(`OpenFoodFacts a répondu ${res.status}`, 'http');
  let json;
  try { json = await res.json(); } catch { throw new ApiError('Réponse OpenFoodFacts illisible', 'parse'); }
  const p = json && json.product;
  const found = p && (json.status === 1 || json.status === 'success' || p.product_name || p.nutriments);
  return found ? normalizeOFF(code, p) : null;
}

function offNum(nutr, keys) {
  for (const k of keys) {
    const v = Number(nutr && nutr[k]);
    if (Number.isFinite(v) && v > 0) return v;
  }
  return 0;
}

/** Fiche OFF → valeurs pour 100 g + flags allergènes (gluten / lactose). */
function normalizeOFF(ean, p) {
  const n = p.nutriments || {};
  const allerg = (p.allergens_tags || []).map((t) => String(t).toLowerCase());
  const has = (frag) => allerg.some((t) => t.includes(frag));
  return {
    ean: String(ean),
    nom: String(p.product_name || '').trim(),
    marque: String(p.brands || '').split(',')[0].trim(),
    quantite: String(p.quantity || '').trim(),
    kcal_100g: Math.round(offNum(n, ['energy-kcal_100g', 'energy-kcal_serving'])),
    prot_100g: Math.round(offNum(n, ['proteins_100g', 'proteins_serving']) * 10) / 10,
    fer_100g_mg: Math.round(offNum(n, ['iron_100g']) * 1000 * 100) / 100, // OFF : fer en g/100 g
    flag_gluten: has('gluten') ? 'oui' : 'non',
    flag_lactose: (has('milk') || has('lactose')) ? 'oui' : 'non',
  };
}
