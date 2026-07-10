// Bootstrap : shell, navigation, gate token, chargement state+catalog, handlers.
import { h, $, clear, toast, num } from './util.js';
import { store } from './store.js';
import { getState, getCatalog, getCourses, getCuisine, getBilan, logProduit, logPlat, adjustStock, logCourses, logPotFini, logBatch, addProduit, ApiError, IS_DEMO } from './api.js';
import { renderToday } from './today.js';
import { renderCourses } from './courses.js';
import { renderCuisine } from './cuisine.js';
import { renderBilan } from './bilan.js';
import { openQuoiManger } from './quoimanger.js';
import { openScan } from './scan.js';
import { flushQueue, updateQueueBadge, registerServiceWorker } from './sync.js';
import { DEFAULT_API_BASE, CRENEAUX } from './config.js';

const appEl = $('#app');
const sheetRoot = $('#sheet-root');
const fab = $('#btn-quoi-manger');

let currentScreen = 'today';
let M = null; // modèle courant { state, foods, plats }
let CoursesData = null; // dernière liste de courses chargée
let CuisineData = null; // dernière cuisine chargée (recette semaine + biblio)

/** Met une action en file offline + rafraîchit le badge « en attente ». */
function enqueue(payload) { store.enqueue(payload); updateQueueBadge(); }

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
  const foods = (catalog.produits || []).map((pr) => ({
    id: pr.id,
    nom: pr.nom,
    kind: 'produit',
    ean: String(pr.ean || '').replace(/\D/g, ''),
    macros: { kcal: Number(pr.kcal) || 0, prot_g: Number(pr.prot_g) || 0, fer_mg: Number(pr.fer_mg) || 0 },
    stock: Number(stock[pr.id]) || 0,
    portions_par_unite: Number(pr.portions_par_unite) || 1,
    unite_de_vente: pr.unite_de_vente || '',
    denombrable: pr.denombrable === true || String(pr.denombrable).toLowerCase() === 'oui',
  }));

  const seen = new Set();
  const plats = [];
  for (const c of CRENEAUX) {
    for (const p of (state.pools && state.pools[c.id]) || []) {
      if (!seen.has(p.id)) { seen.add(p.id); plats.push(p); }
    }
  }
  return { state, foods, plats };
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
function loadingState() {
  clear(appEl);
  appEl.append(h('div', { class: 'state' },
    h('div', { class: 'spinner' }),
    h('div', { class: 'state__msg' }, 'Chargement de la journée…')));
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

async function renderTodayScreen() {
  if (!IS_DEMO && !store.hasToken()) { openSettings({ force: true }); return; }
  if (M) paint(); else loadingState();

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
      M = buildModel({ ...cs.state, __offline: true }, cc.catalog);
      paint();
      toast('Hors-ligne — données en cache', 'err');
    } else if (err instanceof ApiError && err.kind === 'noauth') {
      openSettings({ force: true });
    } else if (currentScreen === 'today') {
      errorState(describeError(err), renderTodayScreen);
    }
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
  loadingMsg('Chargement des courses…');
  try {
    const courses = await getCourses();
    CoursesData = courses;
    store.cacheCourses(courses);
    renderCourses(appEl, courses, coursesHandlers);
  } catch (err) {
    const cc = store.getCachedCourses();
    if (cc && cc.courses) {
      renderCourses(appEl, { ...cc.courses, __offline: true }, coursesHandlers);
      toast('Hors-ligne — dernière liste connue', 'err');
    } else if (err instanceof ApiError && err.kind === 'noauth') {
      openSettings({ force: true });
    } else if (currentScreen === 'courses') {
      errorState(describeError(err), renderCoursesScreen);
    }
  }
}

/** Valide les articles cochés : POST courses (incrémente le stock côté backend). */
async function validerCourses(items) {
  if (!items.length) return;
  try {
    const res = await logCourses(items);
    const reverse = res && Array.isArray(res.courses_validees)
      ? res.courses_validees.map((a) => ({ produit_id: a.produit_id, portions: Number(a.portions) || 0 }))
      : items.map((i) => ({ produit_id: i.produit_id, portions: Number(i.unites) || 0 }));
    store.setLastCourses({ at: Date.now(), reverse });   // pour l'annulation
    const n = items.length;
    toast(`${n} article${n > 1 ? 's' : ''} ajouté${n > 1 ? 's' : ''} au stock`, 'ok');
    M = null;                       // le stock a changé → Aujourd'hui se rechargera
    if (currentScreen === 'courses') renderCourses(appEl, CoursesData, coursesHandlers); // affiche le bandeau d'annulation
  } catch (err) {
    if (isOffline(err)) {
      enqueue({ action: 'log', type: 'courses', items });
      toast('Hors-ligne — validation mise en file', 'err');
      // Pas d'annulation hors-ligne : les portions exactes ne sont connues qu'à la réponse backend.
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
    await Promise.all(last.reverse.map((r) => adjustStock(r.produit_id, -Number(r.portions) || 0)));
    store.clearLastCourses();
    M = null;
    toast('Dernières courses annulées', 'ok');
    renderCoursesScreen();          // recharge : les articles annulés réapparaissent
  } catch (err) {
    if (isOffline(err)) {
      last.reverse.forEach((r) => enqueue({ action: 'log', type: 'ajustement', ref: r.produit_id, delta: -Number(r.portions) || 0 }));
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
  loadingMsg('Chargement de la cuisine…');
  try {
    const data = await getCuisine();
    CuisineData = data;
    store.cacheCuisine(data);
    renderCuisine(appEl, data, cuisineHandlers);
  } catch (err) {
    const cc = store.getCachedCuisine();
    if (cc && cc.cuisine) {
      CuisineData = cc.cuisine;
      renderCuisine(appEl, { ...cc.cuisine, __offline: true }, cuisineHandlers);
      toast('Hors-ligne — dernière cuisine connue', 'err');
    } else if (err instanceof ApiError && err.kind === 'noauth') {
      openSettings({ force: true });
    } else if (currentScreen === 'cuisine') {
      errorState(describeError(err), renderCuisineScreen);
    }
  }
}

/** « Je l'ai cuisinée » : POST batch_cuisine (+stock du plat batch). */
async function cuisinerBatch(rec) {
  const ref = rec.recette_id || rec.plat_id;
  const portions = Number(rec.portions_produites) || 0;
  try {
    await logBatch(ref);
    const label = portions ? `+${num(portions)} portion${portions > 1 ? 's' : ''}` : 'cuisiné';
    toast(`${rec.nom} — ${label}`, 'ok');
    M = null;                                 // le stock du plat batch a changé → Aujourd'hui se rechargera
    if (IS_DEMO) { bumpCuisineLocal(rec, portions); renderCuisine(appEl, CuisineData, cuisineHandlers); }
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
function bumpCuisineLocal(rec, portions) {
  if (!CuisineData) return;
  const today = new Date().toISOString().slice(0, 10);
  const bump = (r) => {
    if (!r) return;
    r.stock_portions = Math.round(((Number(r.stock_portions) || 0) + portions) * 10) / 10;
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
  loadingMsg('Chargement du bilan…');
  try {
    const data = await getBilan();
    store.cacheBilan(data);
    renderBilan(appEl, data);
  } catch (err) {
    const cb = store.getCachedBilan();
    if (cb && cb.bilan) {
      renderBilan(appEl, { ...cb.bilan, __offline: true });
      toast('Hors-ligne — dernier bilan connu', 'err');
    } else if (err instanceof ApiError && err.kind === 'noauth') {
      openSettings({ force: true });
    } else if (currentScreen === 'bilan') {
      errorState(describeError(err), renderBilanScreen);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Actions de log                                                      */
/* ------------------------------------------------------------------ */
const handlers = {
  onCommit: (changes) => commitChanges(changes),   // validation de l'inventaire
  onLogPlat: (plat) => logPlatAction(plat),
};

/**
 * Valide les mouvements d'inventaire d'un coup : chaque baisse de curseur =
 * consommation (log produit → compte dans les jauges) ; chaque hausse =
 * correction de stock (ajustement, sans impact nutritionnel).
 */
async function commitChanges(changes) {
  const snapshot = cloneModel(M);

  // Optimiste : jauges + stock local.
  for (const c of changes) {
    if (c.delta > 0) applyMacros(M.state, c.macros, c.delta, +1);
    const f = M.foods.find((x) => x.id === c.ref);
    if (f) f.stock = Math.round(c.newStock * 1000) / 1000;
  }
  paint();

  const ops = changes.map((c) => (c.delta > 0
    ? logProduit(c.ref, c.delta)          // baisse = consommé
    : adjustStock(c.ref, -c.delta)));     // hausse = -delta ajouté au stock
  const results = await Promise.allSettled(ops);
  const failed = results.filter((r) => r.status === 'rejected');

  if (!failed.length) {
    toast(`${changes.length} aliment${changes.length > 1 ? 's' : ''} mis à jour`, 'ok');
    reconcile();
  } else if (failed.every((r) => isOffline(r.reason))) {
    changes.forEach((c, i) => {
      if (results[i].status === 'rejected') {
        enqueue(c.delta > 0
          ? { action: 'log', type: 'produit', ref: c.ref, quantite: c.delta }
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

async function logPlatAction(plat) {
  const snapshot = cloneModel(M);
  applyMacros(M.state, plat.macros, 1, +1);
  paint();
  try {
    await logPlat(plat.id);
    toast(`${plat.nom} — loggé`, 'ok');
    reconcile();
  } catch (err) {
    if (isOffline(err)) {
      enqueue({ action: 'log', type: 'plat', ref: plat.id });
      toast('Hors-ligne — action mise en file', 'err');
    } else {
      M = snapshot; paint();
      toast(describeError(err), 'err');
    }
  }
}

function isOffline(err) {
  return err instanceof ApiError && (err.kind === 'network' || err.kind === 'http');
}

/* ------------------------------------------------------------------ */
/* Scan code-barres                                                    */
/* ------------------------------------------------------------------ */
const scanContext = {
  findByEan: (ean) => foodByEan(ean),
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
    macros: { kcal: Number(pr.kcal) || 0, prot_g: Number(pr.prot_g) || 0, fer_mg: Number(pr.fer_mg) || 0 },
    stock: Number(st[pr.id]) || 0,
  };
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
  try {
    const [state, catalog] = await Promise.all([getState(), getCatalog()]);
    M = buildModel(state, catalog);
    store.cacheState(state);
    store.cacheCatalog(catalog);
    paint();
  } catch { /* garde l'optimiste si le recalage échoue */ }
}

function cloneModel(m) {
  return {
    state: JSON.parse(JSON.stringify(m.state)),
    foods: m.foods.map((f) => ({ ...f })),
    plats: m.plats,
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
  bump(j.fer_mg, macros.fer_mg);
  bump(j.kcal, macros.kcal);
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
registerServiceWorker();
setScreen('today');
syncQueue({ silent: true });
