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
    // `transient` (2026-08-13) : le backend distingue « réessaie » (verrou
    // occupé, quota) d'un refus définitif. Sans ça, une écriture récupérable
    // était classée « rejet backend » et abandonnée par la file.
    const kind = json && json.transient ? 'http' : 'backend';
    throw new ApiError((json && json.error) || 'Erreur inconnue', kind);
  }
  return json.data;
}

/* ------------------------------------------------------------------ */
/* Requête doublée — la parade à la latence d'Apps Script              */
/* ------------------------------------------------------------------ */
/**
 * Mesure du 2026-08-13, 12 appels sur le backend déployé, sur une requête qui ne
 * fait qu'une lecture d'onglet avant de répondre :
 *
 *     1,9  36,6  1,8  3,6  32,2  3,0  2,0  34,1  22,1  1,9  1,8  12,4  (secondes)
 *
 * Médiane ~2,3 s, mais un appel sur trois dépasse 22 s. En séparant les deux
 * sauts HTTP, tout le temps part dans le PREMIER (`script.google.com`, où le
 * script s'exécute) ; le second ne coûte que 0,3 s. C'est de l'ordonnancement
 * Google — démarrage de conteneur — et aucune optimisation de `Code.gs` ne peut
 * l'enlever. C'est aussi ce qui faisait dire « Hors-ligne » à l'app : l'ancienne
 * borne de 25 s tombait pile au milieu de cette queue de distribution.
 *
 * Fait décisif : ces appels lents FINISSENT par réussir (JSON correct après 22 et
 * 34 s). La requête n'est pas perdue, elle attend son tour. On en lance donc une
 * SECONDE au bout de quelques secondes et on garde la première qui répond : pour
 * que l'attente reste longue, il faut désormais que les deux tombent dans la
 * queue lente.
 *
 * C'est gratuit sur un GET (idempotent), et sans risque sur un POST grâce à
 * l'`op_id` : le backend mémorise les opérations déjà appliquées et ne les
 * rejoue jamais (Code.gs §4). Le doublon d'une écriture est donc un rejeu — il
 * rapporte l'accusé d'origine et l'état frais, sans rien réécrire.
 */
const DOUBLON_LECTURE_MS = 6000;
// Plus tardif sur une écriture : le doublon attend le verrou du backend, il ne
// sert donc à rien de le lancer tant que l'original a des chances d'aboutir.
const DOUBLON_ECRITURE_MS = 12000;
// Budget total avant d'abandonner. Large exprès : on sait maintenant qu'une
// réponse peut mettre 35 s à venir, et abandonner à 25 s revenait à jeter une
// requête qui allait aboutir.
const BUDGET_MS = 45000;

/** `navigator.onLine` ment sur le « vrai », jamais sur le « faux » : un `false`
 *  signifie l'interface réseau coupée. Un `true` avec un échec pointe donc vers
 *  le serveur, et le dire évite d'annoncer « Hors-ligne » à quelqu'un de
 *  parfaitement connecté — le reproche exact d'Azur le 2026-08-13. */
function erreurReseau(avorte) {
  const enLigne = navigator.onLine !== false;
  const err = new ApiError(
    enLigne
      ? (avorte ? 'Le serveur Google ne répond pas (il est parfois très lent)'
                : 'Le serveur Enthalpie est injoignable')
      : 'Pas de connexion',
    'network');
  err.enLigne = enLigne;
  return err;
}

function fetchDouble(url, options = {}, doublonMs = DOUBLON_LECTURE_MS) {
  return new Promise((resolve, reject) => {
    const ctrls = [];
    let reglee = false;
    let enVol = 0;
    let avorte = false;
    let tDoublon = null;

    // Le contrôleur GAGNANT ne doit surtout pas être avorté : `fetch` a résolu,
    // mais le corps n'est pas encore lu (`res.json()` vient après) — l'avorter
    // ferait échouer la lecture de la réponse qu'on vient de gagner.
    const finir = (fn, valeur, gagnant) => {
      if (reglee) return;
      reglee = true;
      clearTimeout(tDoublon);
      clearTimeout(tBudget);
      ctrls.forEach((c) => { if (c !== gagnant) { try { c.abort(); } catch { /* déjà fini */ } } });
      fn(valeur);
    };

    const tBudget = setTimeout(() => { avorte = true; finir(reject, erreurReseau(true)); }, BUDGET_MS);

    const lancer = () => {
      const c = new AbortController();
      ctrls.push(c);
      enVol++;
      fetch(url, { ...options, signal: c.signal }).then(
        (res) => { enVol--; finir(resolve, res, c); },
        () => {
          enVol--;
          // Une tentative avortée parce que l'autre a gagné n'est pas un échec ;
          // on n'abandonne que quand plus rien n'est en vol.
          if (!reglee && enVol === 0) finir(reject, erreurReseau(avorte));
        });
    };

    lancer();
    tDoublon = setTimeout(() => { if (!reglee) lancer(); }, doublonMs);
  });
}

/**
 * Identifiant d'opération : rend une écriture rejouable sans risque. Le backend
 * mémorise les `op_id` déjà appliqués et ne les rejoue jamais (Code.gs §4).
 */
export function opId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
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
  const res = await fetchDouble(url.toString(), { method: 'GET', redirect: 'follow' });
  return parseResponse(res);
}

// --- Écriture (POST) ---
// Corps en text/plain (JSON.stringify) pour éviter le pre-flight CORS ; le
// backend parse postData.contents (BUILD-PWA.md §1).
export async function apiPost(body) {
  if (IS_DEMO) {
    // Validation d'inventaire : la fixture est statique, on renvoie l'état tel
    // quel — le bump optimiste de la démo suffit à montrer le geste.
    if (body && body.action === 'commit') {
      return { applique: (body.changes || []).map((c) => ({ ref: c.ref })), ignores: [], demo: true };
    }
    // Écho suffisant pour l'UI ; pour les courses on simule la réponse backend
    // (portions ajoutées) afin que l'annulation fonctionne aussi en démo.
    if (body && body.type === 'courses') {
      return { courses_validees: (body.items || []).map((i) => ({ produit_id: i.produit_id, portions: Number(i.unites) || 0 })) };
    }
    // Rangement : la fixture est statique, on renvoie juste le compte.
    if (body && body.action === 'set_categorie') {
      return { ranges: (body.items || []).length, demo: true };
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
  // Un `op_id` sur TOUTE écriture : c'est lui qui rend la requête doublée sans
  // danger. Le frapper ici est correct — `apiPost` n'est appelée qu'une fois par
  // action, les deux tentatives partagent donc le même identifiant, et le
  // backend n'applique la seconde nulle part. Les appels qui en fournissent
  // déjà un (file offline rejouée, `commit`) gardent le leur : en changer
  // ferait recompter une écriture qui avait abouti.
  const corps = { token, ...body };
  if (!corps.op_id) corps.op_id = opId();
  const res = await fetchDouble(store.getApiBase(), {
    method: 'POST',
    redirect: 'follow',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(corps),
  }, DOUBLON_ECRITURE_MS);
  return parseResponse(res);
}

// Raccourcis typés.
/** Démarrage en un seul aller-retour : { state, catalog }. */
export const getBoot    = () => apiGet('boot');
export const getState   = () => apiGet('state');
export const getCatalog = () => apiGet('catalog');
export const getCourses = () => apiGet('courses');
export const getCuisine = () => apiGet('cuisine');
export const getBilan   = () => apiGet('bilan');
/**
 * Validation groupée de l'inventaire : TOUS les curseurs en un seul POST, et la
 * réponse contient déjà l'état frais (plus de GET de recalage derrière).
 * `changes` : [{ ref, kind:'produit'|'plat', delta }], delta en grammes signés.
 * `id` : op_id — le rejeu d'un commit déjà appliqué ne compte pas deux fois.
 */
export const postCommit = (changes, id) => apiPost({ action: 'commit', op_id: id, changes });
export const postLog     = (payload) => apiPost({ action: 'log', ...payload });
// `id` (op_id) est optionnel mais recommandé sur toute écriture susceptible
// d'être rejouée : sans lui, une réponse perdue fait recompter l'action.
export const logProduit  = (ref, quantite, id) => postLog({ type: 'produit', ref, quantite, op_id: id });
export const logPlat     = (ref, quantite = 1, id) => postLog({ type: 'plat', ref, quantite, op_id: id });
export const adjustStock = (ref, delta, id) => postLog({ type: 'ajustement', ref, delta, op_id: id });
/**
 * Ajustements groupés : `items` = [{ref, delta}] en grammes signés. Un seul
 * POST, donc une seule prise du verrou côté backend — annuler un lot de courses
 * envoyait auparavant un POST par article, qui se mettaient en file les uns
 * derrière les autres (2026-08-13).
 */
export const adjustStockLot = (items, id) => postLog({ type: 'ajustement', items, op_id: id });
export const logCourses  = (items, id) => postLog({ type: 'courses', items, op_id: id });
export const logPotFini  = (ref, id) => postLog({ type: 'pot_fini', ref, source: 'scan', op_id: id });
export const logBatch    = (ref, id) => postLog({ type: 'batch_cuisine', ref, op_id: id });
export const logExterieur = (macros, id) => postLog({ type: 'exterieur', ...macros, op_id: id });
/**
 * Retire un repas extérieur du journal du jour (✕ du résumé, 2026-08-13).
 * `rang` = sa position parmi les extérieurs du jour, telle que servie par
 * `state.journal` ; `kcal` sert de contrôle côté serveur pour ne pas supprimer
 * un autre repas si l'écran affichait un journal périmé.
 */
export const annulerExterieur = (rang, kcal, id) =>
  apiPost({ action: 'annuler_exterieur', rang, kcal, op_id: id });

// --- Scan : ajout catalogue + recherche (action dédiée, hors "log") ---
// Nécessitent le redéploiement du backend (endpoints add_produit / search_catalog).
export const addProduit    = (produit) => apiPost({ action: 'add_produit', produit });
/** Range des produits : [{produit_id, categorie}] — categorie vide = déclasser. */
export const setCategories = (items) => apiPost({ action: 'set_categorie', items });
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
    cuisine: _demoCache.cuisine, bilan: _demoCache.bilan,
    boot: { state: _demoCache.state, catalog: _demoCache.catalog } };
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
// `quantity` est du texte libre (« 6 pcs », « 360 g (6 x 60 g) », souvent vide) ;
// `product_quantity` est le poids net en grammes, numérique — c'est lui qui permet
// de calculer une portion. Les deux sont demandés : ni l'un ni l'autre n'est fiable
// seul (cf. boîtes d'œufs, qui ne donnent qu'un compte).
const OFF_FIELDS = 'product_name,brands,quantity,product_quantity,nutriments,allergens_tags';

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
    poids_net_g: Number(p.product_quantity) > 0 ? Math.round(Number(p.product_quantity)) : 0,
    kcal_100g: Math.round(offNum(n, ['energy-kcal_100g', 'energy-kcal_serving'])),
    prot_100g: Math.round(offNum(n, ['proteins_100g', 'proteins_serving']) * 10) / 10,
    // Fibres : facultatives sur l'étiquette, donc absentes d'environ un tiers des
    // fiches. null (et non 0) pour ne pas confondre « sans fibres » et « inconnu ».
    fibres_100g: n['fiber_100g'] != null ? Math.round(Number(n['fiber_100g']) * 10) / 10 : null,
    flag_gluten: has('gluten') ? 'oui' : 'non',
    flag_lactose: (has('milk') || has('lactose')) ? 'oui' : 'non',
  };
}
