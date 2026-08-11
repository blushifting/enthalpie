// Bootstrap : shell, navigation, gate token, chargement state+catalog, handlers.
import { h, $, clear, toast, num } from './util.js';
import { store } from './store.js';
import { getState, getCatalog, getCourses, getCuisine, getBilan, logProduit, logPlat, adjustStock, logCourses, logPotFini, logBatch, logExterieur, addProduit, setCategories, ApiError, IS_DEMO } from './api.js';
import { renderToday } from './today.js';
import { renderCourses } from './courses.js';
import { renderCuisine } from './cuisine.js';
import { renderBilan } from './bilan.js';
import { openQuoiManger } from './quoimanger.js';
import { openScan } from './scan.js';
import { openRanger } from './ranger.js';
import { flushQueue, updateQueueBadge, registerServiceWorker, applyUpdate, versionAppShell, chercherMiseAJour } from './sync.js';
import { DEFAULT_API_BASE, APP_VERSION } from './config.js';

const appEl = $('#app');
const sheetRoot = $('#sheet-root');
const fab = $('#btn-quoi-manger');

let currentScreen = 'today';
let M = null; // modèle courant { state, foods, plats }
let CoursesData = null; // dernière liste de courses chargée
let CuisineData = null; // dernière cuisine chargée (recette semaine + biblio)

/** Met une action en file offline + rafraîchit le badge « en attente ». */
function enqueue(payload) { store.enqueue(payload); updateQueueBadge(); }

/**
 * Trait de progression sous la barre du haut. Les écrans s'affichent désormais
 * depuis le cache sans attendre le réseau : ce trait est le seul signe qu'un
 * rafraîchissement est en cours — sans lui, une valeur qui change toute seule
 * une seconde plus tard paraîtrait sortie de nulle part.
 * Compteur, parce que plusieurs chargements peuvent se chevaucher.
 */
let enCours = 0;
function syncing(on) {
  enCours = Math.max(0, enCours + (on ? 1 : -1));
  const bar = $('#syncbar');
  if (bar) bar.hidden = enCours === 0;
}

/** Recharge l'écran courant (après synchro d'une file rejouée, retour réseau…). */
function refreshCurrent() {
  if (currentScreen === 'today') renderTodayScreen();
  else if (currentScreen === 'courses') renderCoursesScreen();
  else if (currentScreen === 'cuisine') renderCuisineScreen();
  else if (currentScreen === 'bilan') renderBilanScreen();
}

/* ------------------------------------------------------------------ */
/* Construction du modèle produit-centrique                            */
/* ------------------------------------------------------------------ */
function buildModel(state, catalog) {
  const stock = state.stock || {};
  const plats = catalog.plats || [];

  // Tout est en grammes ; les macros sont POUR 100 g (cf. Code.gs, en-tête).
  // `paquet` est la référence du curseur : il exprime le pourcentage d'UN
  // paquet consommé, pas du stock total, sinon la position ne voudrait plus
  // rien dire dès qu'on rachète.
  const macros100 = (x) => ({
    kcal: Number(x.kcal_100g) || 0,
    prot_g: Number(x.prot_100g) || 0,
    // null (pas 0) quand la colonne est vide : la jauge fibres additionne ce
    // qu'elle a et n'invente rien, mais l'écran doit pouvoir afficher « — »
    // plutôt qu'un « 0 g » qui ferait croire à un aliment sans fibres.
    fibres_g: (x.fibres_100g === '' || x.fibres_100g == null) ? null : Number(x.fibres_100g),
  });

  const foods = (catalog.produits || []).map((pr) => ({
    id: pr.id,
    nom: pr.nom,
    kind: 'produit',
    ean: String(pr.ean || '').replace(/\D/g, ''),
    macros: macros100(pr),
    stock: Number(stock[pr.id]) || 0,          // grammes
    paquet: Number(pr.poids_paquet_g) || 0,    // 0 = poids inconnu
    // '' = pas encore rangé (colonne absente d'un Sheet d'avant le 2026-08-11).
    categorie: String(pr.categorie || ''),
  }));

  // Plats batch cuisinés = articles de stock au curseur, comme le reste. Leur
  // « paquet » est la fournée, dont le poids vient du backend (somme des
  // ingrédients). Manger = log `plat` en grammes.
  for (const pl of plats) {
    if (String(pl.type) !== 'batch') continue;
    const s = Number(stock[pl.id]) || 0;
    if (s <= 0) continue;                    // pas cuisiné / épuisé → absent de l'inventaire
    foods.push({
      id: pl.id, nom: pl.nom, kind: 'plat', ean: '',
      macros: macros100(pl),
      stock: s, paquet: Number(pl.poids_fournee_g) || 0,
    });
  }

  // Presets « repas extérieur » : macros ABSOLUES d'un repas, pas pour 100 g —
  // il n'y a ni paquet ni poids à peser au restaurant. L'onglet `plats` n'a
  // qu'un seul jeu de colonnes nutritionnelles : pour un plat de type
  // `exterieur`, `kcal_100g`/`prot_100g`/`fibres_100g` portent le total du
  // repas. Lire `pl.kcal` (comme avant le 2026-08-09) donnait des presets à
  // 0 kcal / 0 g — invisible tant que l'onglet `plats` était vide.
  const exterieurs = plats.filter((pl) => String(pl.type) === 'exterieur').map((pl) => ({
    id: pl.id, nom: pl.nom,
    macros: {
      kcal: Number(pl.kcal_100g) || 0,
      prot_g: Number(pl.prot_100g) || 0,
      // Pas de curseur fibres au resto (SPEC §1 principe 2) : la seule source
      // est le preset. Sans valeur, le repas ne creuse pas la jauge par erreur…
      // il ne la remplit simplement pas.
      fibres_g: Number(pl.fibres_100g) || 0,
    },
  }));

  return { state, foods, exterieurs };
}

/* ------------------------------------------------------------------ */
/* Navigation                                                          */
/* ------------------------------------------------------------------ */
function setScreen(name) {
  currentScreen = name;
  document.querySelectorAll('.tab').forEach((t) =>
    t.classList.toggle('is-active', t.dataset.screen === name));
  fab.hidden = name !== 'today';
  const render = {
    today: renderTodayScreen,
    courses: renderCoursesScreen,
    cuisine: renderCuisineScreen,
    bilan: renderBilanScreen,
  }[name] || renderTodayScreen;
  render();
}

/* ------------------------------------------------------------------ */
/* Écran Aujourd'hui                                                   */
/* ------------------------------------------------------------------ */
/**
 * Premier lancement, rien en cache : logo de l'app plutôt qu'un spinner nu —
 * le même écran que le splash statique d'index.html, pour qu'il n'y ait aucune
 * rupture visuelle entre le HTML et la prise de main du JS.
 * Le logo est cloné depuis la barre du haut : une seule source de vérité.
 */
function loadingState() {
  clear(appEl);
  const logo = document.querySelector('.topbar__logo svg');
  appEl.append(h('div', { class: 'splash' },
    logo ? logo.cloneNode(true) : null,
    h('div', { class: 'splash__nom' }, 'Enthalpie'),
    h('div', { class: 'splash__sub' }, 'Chargement…')));
}

function errorState(message, onRetry) {
  clear(appEl);
  appEl.append(h('div', { class: 'state' },
    h('div', { class: 'state__icon' }, '⚠'),
    h('div', { class: 'state__title' }, 'Impossible de charger'),
    h('div', { class: 'state__msg' }, message),
    h('button', { class: 'btn btn--primary', style: 'max-width:220px', onclick: onRetry }, 'Réessayer')));
}

function paint() {
  if (currentScreen === 'today' && M) renderToday(appEl, M, handlers);
}

/** Date du jour au format du backend ('yyyy-MM-dd'), en heure locale. */
function isoLocal(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Peint l'écran depuis le dernier state/catalog connus SANS attendre le réseau
 * (Apps Script met facilement une à deux secondes à répondre — c'est tout le
 * temps de chargement ressenti). Le rafraîchissement se fait ensuite en fond,
 * comme sur Courses / Cuisine / Bilan.
 *
 * Un cache d'hier garde son stock (il n'a pas bougé pendant la nuit) mais pas
 * ses jauges : les apports de la veille affichés comme ceux du jour seraient un
 * mensonge, donc les anneaux passent en attente jusqu'à la réponse.
 * Renvoie false s'il n'y a rien en cache.
 */
function peindreDepuisCache() {
  const cs = store.getCachedState();
  const cc = store.getCachedCatalog();
  if (!cs || !cs.state || !cc || !cc.catalog) return false;
  M = buildModel({ ...cs.state, __attente: cs.state.date !== isoLocal() }, cc.catalog);
  paint();
  return true;
}

async function renderTodayScreen() {
  if (!IS_DEMO && !store.hasToken()) { openSettings({ force: true }); return; }
  if (M) paint();
  else if (!peindreDepuisCache()) loadingState();

  syncing(true);
  try {
    const [state, catalog] = await Promise.all([getState(), getCatalog()]);
    M = buildModel(state, catalog);
    store.cacheState(state);
    store.cacheCatalog(catalog);
    paint();
  } catch (err) {
    const cs = store.getCachedState();
    const cc = store.getCachedCatalog();
    if (cs && cs.state && cc && cc.catalog) {
      // Même règle qu'en peinture immédiate : le stock d'hier reste vrai, ses
      // jauges non — hors-ligne on ne peut plus les mettre à jour, alors on les
      // laisse en attente plutôt que de dater les apports de la veille.
      M = buildModel({ ...cs.state, __offline: true, __attente: cs.state.date !== isoLocal() }, cc.catalog);
      paint();
      toast('Hors-ligne — données en cache', 'err');
    } else if (err instanceof ApiError && err.kind === 'noauth') {
      openSettings({ force: true });
    } else if (currentScreen === 'today') {
      errorState(describeError(err), renderTodayScreen);
    }
  } finally {
    syncing(false);
  }
}

function describeError(err) {
  if (!(err instanceof ApiError)) return String((err && err.message) || err);
  switch (err.kind) {
    case 'network': return 'Réseau indisponible. Vérifie ta connexion.';
    case 'backend': return `Le backend a répondu : « ${err.message} ». Vérifie le token dans les réglages.`;
    case 'http':    return `Le serveur a renvoyé une erreur (${err.message}).`;
    default:        return err.message;
  }
}

/* ------------------------------------------------------------------ */
/* Écran Courses                                                       */
/* ------------------------------------------------------------------ */
function loadingMsg(msg) {
  clear(appEl);
  appEl.append(h('div', { class: 'state' },
    h('div', { class: 'spinner' }),
    h('div', { class: 'state__msg' }, msg)));
}

const coursesHandlers = {
  onValider: (items) => validerCourses(items),
  onUndo: () => undoCourses(),
  onExclure: (id, nom) => exclureCourse(id, nom),
};

async function renderCoursesScreen() {
  if (!IS_DEMO && !store.hasToken()) { openSettings({ force: true }); return; }
  // Affiche le dernier contenu connu immédiatement (pas de spinner), puis rafraîchit en fond.
  const cached = store.getCachedCourses();
  const hadCache = !!(cached && cached.courses);
  if (hadCache) { CoursesData = cached.courses; renderCourses(appEl, cached.courses, coursesHandlers); }
  else loadingMsg('Chargement des courses…');
  syncing(true);
  try {
    const courses = await getCourses();
    store.cacheCourses(courses);
    const changed = !hadCache || !sameData(courses, cached.courses);
    CoursesData = courses;
    if (currentScreen === 'courses' && changed) renderCourses(appEl, courses, coursesHandlers);
  } catch (err) {
    const cc = store.getCachedCourses();
    if (cc && cc.courses) {
      if (currentScreen === 'courses') renderCourses(appEl, { ...cc.courses, __offline: true }, coursesHandlers);
    } else if (err instanceof ApiError && err.kind === 'noauth') {
      openSettings({ force: true });
    } else if (currentScreen === 'courses') {
      errorState(describeError(err), renderCoursesScreen);
    }
  } finally {
    syncing(false);
  }
}

/** Valide les articles cochés : POST courses (incrémente le stock côté backend). */
async function validerCourses(items) {
  if (!items.length) return;
  try {
    const res = await logCourses(items);
    const reverse = res && Array.isArray(res.courses_validees)
      ? res.courses_validees.map((a) => ({ produit_id: a.produit_id, grammes: Number(a.grammes) || 0 }))
      : items.map((i) => ({ produit_id: i.produit_id, grammes: Number(i.grammes) || 0 }));
    store.setLastCourses({ at: Date.now(), reverse });   // pour l'annulation
    const n = items.length;
    toast(`${n} article${n > 1 ? 's' : ''} ajouté${n > 1 ? 's' : ''} au stock`, 'ok');
    M = null;                       // le stock a changé → Aujourd'hui se rechargera
    if (currentScreen === 'courses') renderCourses(appEl, CoursesData, coursesHandlers); // affiche le bandeau d'annulation
  } catch (err) {
    if (isOffline(err)) {
      enqueue({ action: 'log', type: 'courses', items });
      toast('Hors-ligne — validation mise en file', 'err');
      // Pas d'annulation hors-ligne : les grammes exacts ne sont connus qu'à la réponse backend.
    } else {
      toast(describeError(err), 'err');
    }
  }
}

/** Annule le dernier lot validé : ajustement négatif du stock par produit. */
async function undoCourses() {
  const last = store.getLastCourses();
  if (!last || !last.reverse || !last.reverse.length) return;
  try {
    await Promise.all(last.reverse.map((r) => adjustStock(r.produit_id, -Number(r.grammes) || 0)));
    store.clearLastCourses();
    M = null;
    toast('Dernières courses annulées', 'ok');
    renderCoursesScreen();          // recharge : les articles annulés réapparaissent
  } catch (err) {
    if (isOffline(err)) {
      last.reverse.forEach((r) => enqueue({ action: 'log', type: 'ajustement', ref: r.produit_id, delta: -Number(r.grammes) || 0 }));
      store.clearLastCourses();
      toast('Hors-ligne — annulation mise en file', 'err');
      renderCoursesScreen();
    } else {
      toast(describeError(err), 'err');
    }
  }
}

/** « Ne plus proposer » : masquage local réversible (aucun appel backend). */
function exclureCourse(id, nom) {
  store.addCoursesExclus(id, nom);
  const d = store.getCoursesDraft();
  delete d.checked[id]; delete d.qty[id];
  store.setCoursesDraft(d);
  toast(`« ${nom} » retiré des courses`, 'ok');
}

/* ------------------------------------------------------------------ */
/* Écran Cuisine                                                       */
/* ------------------------------------------------------------------ */
const cuisineHandlers = { onCuisiner: (rec) => cuisinerBatch(rec) };

async function renderCuisineScreen() {
  if (!IS_DEMO && !store.hasToken()) { openSettings({ force: true }); return; }
  // Cache d'abord (affichage instantané), puis rafraîchissement en fond.
  const cached = store.getCachedCuisine();
  const hadCache = !!(cached && cached.cuisine);
  if (hadCache) { CuisineData = cached.cuisine; renderCuisine(appEl, cached.cuisine, cuisineHandlers); }
  else loadingMsg('Chargement de la cuisine…');
  syncing(true);
  try {
    const data = await getCuisine();
    store.cacheCuisine(data);
    const changed = !hadCache || !sameData(data, cached.cuisine);
    CuisineData = data;
    if (currentScreen === 'cuisine' && changed) renderCuisine(appEl, data, cuisineHandlers);
  } catch (err) {
    const cc = store.getCachedCuisine();
    if (cc && cc.cuisine) {
      CuisineData = cc.cuisine;
      if (currentScreen === 'cuisine') renderCuisine(appEl, { ...cc.cuisine, __offline: true }, cuisineHandlers);
    } else if (err instanceof ApiError && err.kind === 'noauth') {
      openSettings({ force: true });
    } else if (currentScreen === 'cuisine') {
      errorState(describeError(err), renderCuisineScreen);
    }
  } finally {
    syncing(false);
  }
}

/** « Je l'ai cuisinée » : POST batch_cuisine (+stock du plat batch). */
async function cuisinerBatch(rec) {
  const ref = rec.recette_id || rec.plat_id;
  const poids = Number(rec.poids_produit_g) || 0;
  try {
    await logBatch(ref);
    const label = poids ? `+${num(Math.round(poids))} g` : 'cuisiné';
    toast(`${rec.nom} — ${label}`, 'ok');
    M = null;                                 // le stock du plat batch a changé → Aujourd'hui se rechargera
    if (IS_DEMO) { bumpCuisineLocal(rec, poids); renderCuisine(appEl, CuisineData, cuisineHandlers); }
    else renderCuisineScreen();               // recharge la vérité backend (stock, dernière réalisation, compteurs)
  } catch (err) {
    if (isOffline(err)) {
      enqueue({ action: 'log', type: 'batch_cuisine', ref });
      toast('Hors-ligne — cuisine mise en file', 'err');
    } else {
      toast(describeError(err), 'err');
      renderCuisine(appEl, CuisineData, cuisineHandlers);   // réactive le bouton désactivé
    }
  }
}

/** Reflet optimiste local (démo : la fixture est statique, on simule le +stock). */
function bumpCuisineLocal(rec, poids) {
  if (!CuisineData) return;
  const today = new Date().toISOString().slice(0, 10);
  const bump = (r) => {
    if (!r) return;
    r.stock_g = Math.round((Number(r.stock_g) || 0) + poids);
    r.derniere_realisation = today;
    r.jamais_cuisinee = false; r.nouveau = false;
  };
  const rs = CuisineData.recette_semaine;
  if (rs && rs.recette_id === rec.recette_id) bump(rs);
  (CuisineData.bibliotheque || []).forEach((r) => { if (r.recette_id === rec.recette_id) bump(r); });
}

/* ------------------------------------------------------------------ */
/* Écran Bilan (lecture seule)                                         */
/* ------------------------------------------------------------------ */
async function renderBilanScreen() {
  if (!IS_DEMO && !store.hasToken()) { openSettings({ force: true }); return; }
  // Cache d'abord (affichage instantané), puis rafraîchissement en fond.
  const cached = store.getCachedBilan();
  const hadCache = !!(cached && cached.bilan);
  if (hadCache) renderBilan(appEl, cached.bilan);
  else loadingMsg('Chargement du bilan…');
  syncing(true);
  try {
    const data = await getBilan();
    store.cacheBilan(data);
    const changed = !hadCache || !sameData(data, cached.bilan);
    if (currentScreen === 'bilan' && changed) renderBilan(appEl, data);
  } catch (err) {
    const cb = store.getCachedBilan();
    if (cb && cb.bilan) {
      if (currentScreen === 'bilan') renderBilan(appEl, { ...cb.bilan, __offline: true });
    } else if (err instanceof ApiError && err.kind === 'noauth') {
      openSettings({ force: true });
    } else if (currentScreen === 'bilan') {
      errorState(describeError(err), renderBilanScreen);
    }
  } finally {
    syncing(false);
  }
}

/* ------------------------------------------------------------------ */
/* Actions de log                                                      */
/* ------------------------------------------------------------------ */
const handlers = {
  onCommit: (changes) => commitChanges(changes),   // validation de l'inventaire
  onExterieur: (macros) => exterieurAction(macros),
  onRanger: () => openRanger(M ? M.foods : [], rangerAction),
};

/** Enregistre un lot de rangements, puis recharge le catalogue (les pastilles
 *  de filtre en dépendent). Pas de file offline : ranger n'est pas urgent, et
 *  rejouer un rangement obsolète écraserait un choix plus récent. */
async function rangerAction(items) {
  await setCategories(items);                      // l'erreur remonte → la feuille l'affiche
  M = null;
  refreshCurrent();
}

/**
 * Valide les mouvements d'inventaire d'un coup : chaque baisse de curseur =
 * consommation (log produit → compte dans les jauges) ; chaque hausse =
 * correction de stock (ajustement, sans impact nutritionnel).
 */
async function commitChanges(changes) {
  const snapshot = cloneModel(M);

  // Optimiste : jauges + stock local.
  for (const c of changes) {
    // Macros pour 100 g, delta en grammes → facteur delta/100.
    if (c.delta > 0) applyMacros(M.state, c.macros, c.delta / 100, +1);
    const f = M.foods.find((x) => x.id === c.ref);
    if (f) f.stock = Math.round(c.newStock * 1000) / 1000;
  }
  paint();

  // Baisse = consommé : un batch cuisiné se logge en `plat` (décrémente son
  // propre stock), un aliment brut en `produit`. Hausse = correction de stock.
  const isBatch = (c) => c.food && c.food.kind === 'plat';
  const ops = changes.map((c) => (c.delta > 0
    ? (isBatch(c) ? logPlat(c.ref, c.delta) : logProduit(c.ref, c.delta))
    : adjustStock(c.ref, -c.delta)));
  const results = await Promise.allSettled(ops);
  const failed = results.filter((r) => r.status === 'rejected');

  if (!failed.length) {
    toast(`${changes.length} aliment${changes.length > 1 ? 's' : ''} mis à jour`, 'ok');
    reconcile();
  } else if (failed.every((r) => isOffline(r.reason))) {
    changes.forEach((c, i) => {
      if (results[i].status === 'rejected') {
        enqueue(c.delta > 0
          ? { action: 'log', type: isBatch(c) ? 'plat' : 'produit', ref: c.ref, quantite: c.delta }
          : { action: 'log', type: 'ajustement', ref: c.ref, delta: -c.delta });
      }
    });
    toast('Hors-ligne — modifications mises en file', 'err');
  } else {
    // Échec métier : le serveur fait foi, on recale.
    toast(describeError(failed[0].reason), 'err');
    reconcile();
  }
}

/** Repas extérieur : macros libres → jauges du jour, sans toucher au stock. */
async function exterieurAction(macros) {
  const snapshot = cloneModel(M);
  applyMacros(M.state, macros, 1, +1);
  paint();
  try {
    await logExterieur(macros);
    toast('Repas extérieur ajouté', 'ok');
    if (!IS_DEMO) reconcile();     // en démo la fixture est statique → garde le bump optimiste
  } catch (err) {
    if (isOffline(err)) {
      enqueue({ action: 'log', type: 'exterieur', ...macros });
      toast('Hors-ligne — repas mis en file', 'err');
    } else {
      M = snapshot; paint();
      toast(describeError(err), 'err');
    }
  }
}

function isOffline(err) {
  return err instanceof ApiError && (err.kind === 'network' || err.kind === 'http');
}

/** Deux payloads identiques ? (évite un re-render inutile après rafraîchissement en fond) */
function sameData(a, b) {
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}

/* ------------------------------------------------------------------ */
/* Scan code-barres                                                    */
/* ------------------------------------------------------------------ */
const scanContext = {
  findByEan: (ean) => foodByEan(ean),
  onRestock: (food, unites) => restockAction(food, unites),
  onPotFini: (food) => potFiniAction(food),
  onAddProduit: (fiche) => addProduitAction(fiche),
};

/** Retrouve un aliment par EAN dans le modèle courant ou le catalogue en cache. */
function foodByEan(ean) {
  const code = String(ean || '').replace(/\D/g, '');
  if (!code) return null;
  if (M && M.foods) {
    const hit = M.foods.find((f) => f.ean && f.ean === code);
    if (hit) return hit;
  }
  const cc = store.getCachedCatalog();
  const pr = cc && cc.catalog && (cc.catalog.produits || [])
    .find((p) => String(p.ean || '').replace(/\D/g, '') === code);
  if (!pr) return null;
  const cs = store.getCachedState();
  const st = (M && M.state && M.state.stock) || (cs && cs.state && cs.state.stock) || {};
  return {
    id: pr.id, nom: pr.nom, ean: code,
    macros: {
      kcal: Number(pr.kcal_100g) || 0,
      prot_g: Number(pr.prot_100g) || 0,
      fibres_g: (pr.fibres_100g === '' || pr.fibres_100g == null) ? null : Number(pr.fibres_100g),
    },
    stock: Number(st[pr.id]) || 0,
    // Nécessaire à la feuille de scan pour convertir « N paquets » → grammes.
    paquet: Number(pr.poids_paquet_g) || 0,
  };
}

/**
 * Réappro depuis le scan : « j'en ai N paquets » → +N × poids_paquet_g au
 * stock. Réutilise l'endpoint « courses » (même sémantique côté Sheet).
 */
async function restockAction(food, unites) {
  const paquet = Math.max(0, Number(food.paquet) || 0);
  const grammes = Math.max(1, Number(unites) || 1) * paquet;
  const f = M && M.foods && M.foods.find((x) => x.id === food.id);
  if (f) { f.stock = (Number(f.stock) || 0) + grammes; if (currentScreen === 'today') paint(); }
  try {
    await logCourses([{ produit_id: food.id, unites: Math.max(1, Number(unites) || 1) }]);
    toast(`${food.nom} — +${num(Math.round(grammes))} g`, 'ok');
    M = null; CoursesData = null; refreshCurrent();
  } catch (err) {
    if (isOffline(err)) {
      enqueue({ action: 'log', type: 'courses', items: [{ produit_id: food.id, unites: Math.max(1, Number(unites) || 1) }], source: 'scan' });
      toast('Hors-ligne — ajout mis en file', 'err');
    } else {
      toast(describeError(err), 'err');
      throw err;                 // la feuille de scan réactive son bouton
    }
  }
}

/** « Pot fini » depuis le scan : force le stock à 0 + recalibration backend. */
async function potFiniAction(food) {
  const f = M && M.foods && M.foods.find((x) => x.id === food.id);
  if (f) { f.stock = 0; if (currentScreen === 'today') paint(); }
  try {
    await logPotFini(food.id);
    toast(`${food.nom} — pot fini`, 'ok');
    M = null; refreshCurrent();
  } catch (err) {
    if (isOffline(err)) {
      enqueue({ action: 'log', type: 'pot_fini', ref: food.id, source: 'scan' });
      toast('Hors-ligne — « pot fini » mis en file', 'err');
    } else {
      toast(describeError(err), 'err');
      throw err;                 // la feuille de scan réactive son bouton
    }
  }
}

/** Ajout au catalogue depuis une fiche OpenFoodFacts validée. */
async function addProduitAction(fiche) {
  const res = await addProduit(fiche);   // l'erreur remonte → la feuille l'affiche
  M = null; CoursesData = null; refreshCurrent();
  return res;
}

/** Recale silencieusement depuis la source de vérité. */
async function reconcile() {
  syncing(true);
  try {
    const [state, catalog] = await Promise.all([getState(), getCatalog()]);
    M = buildModel(state, catalog);
    store.cacheState(state);
    store.cacheCatalog(catalog);
    paint();
  } catch { /* garde l'optimiste si le recalage échoue */ }
  finally { syncing(false); }
}

function cloneModel(m) {
  return {
    state: JSON.parse(JSON.stringify(m.state)),
    foods: m.foods.map((f) => ({ ...f })),
    exterieurs: m.exterieurs,
  };
}

/** Applique des macros aux jauges (optimiste). */
function applyMacros(state, macros = {}, qty = 1, sign = +1) {
  const j = state.jauges;
  const bump = (g, add) => {
    const valeur = Math.max(0, Math.round((g.valeur + sign * (add || 0) * qty) * 10) / 10);
    g.valeur = valeur;
    g.ratio = g.cible > 0 ? Math.round((valeur / g.cible) * 100) / 100 : g.ratio;
  };
  bump(j.prot_g, macros.prot_g);
  bump(j.kcal, macros.kcal);
  // `bump` fait `add || 0` : un aliment sans donnée de fibres ne bouge rien.
  // Absent si le backend n'est pas encore redéployé.
  if (j.fibres_g) bump(j.fibres_g, macros.fibres_g);
}

/* ------------------------------------------------------------------ */
/* Bloc « Version » de la feuille Réglages                             */
/* ------------------------------------------------------------------ */
/**
 * Deux chiffres, pas un : `APP_VERSION` = la version du CODE en train de
 * tourner, `versionAppShell()` = celle de l'APP-SHELL EN CACHE. Elles doivent
 * être égales ; si elles divergent, c'est précisément le symptôme d'une mise à
 * jour à moitié appliquée, et on préfère le voir que le deviner.
 * Le bouton force le contrôle sans attendre le prochain retour au premier plan
 * (le CDN de Pages garde l'ancienne version jusqu'à 10 min, `max-age=600`).
 */
function versionBlock() {
  const shellEl = h('b', {}, '…');
  const etat = h('div', { class: 'field__hint' }, 'Contrôle de la version…');
  const btn = h('button', { class: 'btn btn--ghost', type: 'button' }, 'Chercher une mise à jour');

  versionAppShell().then((shell) => {
    if (shell == null) {
      shellEl.textContent = 'aucun (pas de cache hors-ligne)';
      etat.textContent = 'Service worker inactif — normal en développement local.';
      return;
    }
    shellEl.textContent = shell;
    etat.textContent = shell === APP_VERSION
      ? 'Code et app-shell en cache sont sur la même version.'
      : `⚠ Le code chargé est en ${APP_VERSION} et l'app-shell en cache en ${shell} : `
        + 'relance l’app, ou force le contrôle ci-dessous.';
  });

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    const avant = btn.textContent;
    btn.textContent = 'Recherche…';
    const res = await chercherMiseAJour();
    if (res === 'bascule') { btn.textContent = 'Mise à jour — rechargement…'; return; }
    btn.disabled = false;
    btn.textContent = avant;
    toast(res === 'a-jour' ? 'Déjà à la dernière version' : 'Service worker indisponible',
      res === 'a-jour' ? 'ok' : 'err');
  });

  return h('div', { class: 'field' },
    h('label', {}, 'Version'),
    h('div', { class: 'version-line' },
      h('span', {}, 'code ', h('b', {}, APP_VERSION)),
      h('span', {}, 'app-shell ', shellEl)),
    etat,
    btn,
  );
}

/* ------------------------------------------------------------------ */
/* Feuille Réglages / Token                                           */
/* ------------------------------------------------------------------ */
function openSettings({ force = false } = {}) {
  clear(sheetRoot);
  const backdrop = h('div', { class: 'sheet-backdrop' });
  const errEl = h('div', { class: 'form-error' });

  const apiInput = h('input', { type: 'url', value: store.getApiBase(),
    placeholder: DEFAULT_API_BASE, autocomplete: 'off', spellcheck: 'false' });
  const tokInput = h('input', { type: 'password', value: store.getToken(),
    placeholder: 'colle ton token ici', autocomplete: 'off', spellcheck: 'false' });

  function close() { if (!force || store.hasToken()) backdrop.remove(); }
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

  function save() {
    const token = tokInput.value.trim();
    const api = apiInput.value.trim() || DEFAULT_API_BASE;
    if (!token) { errEl.textContent = 'Le token est requis pour contacter le backend.'; return; }
    store.setApiBase(api);
    store.setToken(token);
    backdrop.remove();
    M = null;
    renderTodayScreen();
  }

  const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' },
    h('div', { class: 'sheet__handle' }),
    h('h2', {}, 'Connexion au backend'),
    h('p', { class: 'sub' }, 'Le token est stocké uniquement sur cet appareil (localStorage) et n\'est jamais envoyé ailleurs qu\'au backend Enthalpie.'),
    h('div', { class: 'field' },
      h('label', {}, 'Token d\'accès'),
      tokInput,
      h('div', { class: 'field__hint' }, 'Onglet « parametres » du Google Sheet, ligne token.')),
    h('div', { class: 'field' },
      h('label', {}, 'API_BASE (avancé)'),
      apiInput,
      h('div', { class: 'field__hint' }, 'Laisse la valeur par défaut sauf redéploiement du backend.')),
    versionBlock(),
    errEl,
    h('div', { class: 'sheet__actions' },
      force ? null : h('button', { class: 'btn btn--ghost', onclick: close }, 'Fermer'),
      h('button', { class: 'btn btn--primary', onclick: save }, 'Enregistrer')),
  );

  backdrop.append(sheet);
  sheetRoot.append(backdrop);
  setTimeout(() => tokInput.focus(), 50);
}

/* ------------------------------------------------------------------ */
/* Popin « mise à jour disponible »                                    */
/* ------------------------------------------------------------------ */
/** Affiché quand une nouvelle version du SW attend de prendre la main. */
function showUpdatePopin(reg) {
  if (document.querySelector('.update-popin')) return;      // déjà proposé
  const btn = h('button', { class: 'update-popin__btn', type: 'button' }, 'Recharger');
  btn.onclick = () => {
    btn.disabled = true;
    btn.textContent = '…';
    applyUpdate(reg);                                        // → bascule → rechargement auto
  };
  const plusTard = h('button', {
    class: 'update-popin__close', type: 'button', 'aria-label': 'Plus tard',
    onclick: () => { el.remove(); document.body.classList.remove('has-update'); },
  }, '✕');

  const el = h('div', { class: 'update-popin', role: 'status' },
    h('span', { class: 'update-popin__ico', 'aria-hidden': 'true' }, '✨'),
    h('div', { class: 'update-popin__txt' },
      h('div', { class: 'update-popin__title' }, 'Mise à jour disponible'),
      h('div', { class: 'update-popin__sub' }, 'Une nouvelle version est prête.')),
    btn, plusTard);

  document.body.append(el);
  document.body.classList.add('has-update');                 // fait remonter le FAB
}

/* ------------------------------------------------------------------ */
/* Câblage + boot                                                      */
/* ------------------------------------------------------------------ */
document.querySelectorAll('.tab').forEach((t) =>
  t.addEventListener('click', () => setScreen(t.dataset.screen)));

$('#btn-settings').addEventListener('click', () => openSettings());
$('#btn-scan').addEventListener('click', () => openScan(scanContext));
fab.addEventListener('click', () => {
  if (M) openQuoiManger(M.state, M.foods, (food) => scrollToFood(food.id));
});

// Badge « en attente » : rejeu manuel de la file (utile si l'event `online` a raté).
$('#queue-badge').addEventListener('click', () => syncQueue({ silent: false }));

/** Rejoue la file offline ; si des actions sont parties, le backend a changé → recharge. */
async function syncQueue(opts) {
  const res = await flushQueue(opts);
  if (res.sent) { M = null; CoursesData = null; refreshCurrent(); }
  return res;
}

/** Fait défiler jusqu'à la ligne d'un aliment et la fait clignoter (depuis « Quoi manger ? »). */
function scrollToFood(id) {
  const el = document.getElementById(`food-${id}`);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.remove('flash');
  void el.offsetWidth;           // relance l'animation
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1500);
}

window.addEventListener('online', async () => {
  updateQueueBadge();
  const res = await syncQueue({ silent: true });   // rejoue la file au retour réseau
  if (!res.sent) refreshCurrent();                 // syncQueue a déjà rechargé si des actions sont parties
});
window.addEventListener('offline', () => updateQueueBadge());

// Boot : badge, service worker (hors localhost), puis rejeu silencieux de la file.
updateQueueBadge();
registerServiceWorker(showUpdatePopin);
setScreen('today');
syncQueue({ silent: true });
