// Bootstrap : shell, navigation, gate token, chargement state+catalog, handlers.
import { h, $, clear, toast } from './util.js';
import { store } from './store.js';
import { getState, getCatalog, logProduit, logPlat, adjustStock, ApiError, IS_DEMO } from './api.js';
import { renderToday } from './today.js';
import { openQuoiManger } from './quoimanger.js';
import { DEFAULT_API_BASE, CRENEAUX } from './config.js';

const appEl = $('#app');
const sheetRoot = $('#sheet-root');
const fab = $('#btn-quoi-manger');

let currentScreen = 'today';
let M = null; // modèle courant { state, foods, plats }

/* ------------------------------------------------------------------ */
/* Construction du modèle produit-centrique                            */
/* ------------------------------------------------------------------ */
function buildModel(state, catalog) {
  const stock = state.stock || {};
  const foods = (catalog.produits || []).map((pr) => ({
    id: pr.id,
    nom: pr.nom,
    kind: 'produit',
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
  if (name === 'today') renderTodayScreen();
  else renderPlaceholder(name);
}

function renderPlaceholder(name) {
  const titles = { courses: '🛒 Courses', cuisine: '🍳 Cuisine', bilan: '📈 Bilan' };
  clear(appEl);
  appEl.append(h('div', { class: 'placeholder-screen' },
    h('h2', {}, titles[name] || name),
    h('p', {}, 'Écran à venir — prochaine étape du build.')));
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
        store.enqueue(c.delta > 0
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
      store.enqueue({ action: 'log', type: 'plat', ref: plat.id });
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
$('#btn-scan').addEventListener('click', () => toast('Scan code-barres — étape suivante du build'));
fab.addEventListener('click', () => {
  if (M) openQuoiManger(M.state, M.foods, (food) => scrollToFood(food.id));
});

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

window.addEventListener('online', () => { if (currentScreen === 'today') renderTodayScreen(); });

setScreen('today');
