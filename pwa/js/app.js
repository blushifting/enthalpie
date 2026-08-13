// Bootstrap : shell, navigation, gate token, chargement state+catalog, handlers.
import { h, $, clear, toast, num } from './util.js';
import { store } from './store.js';
import { getBoot, getCourses, getCuisine, getBilan, postCommit, adjustStockLot, logCourses, logPotFini, logBatch, logExterieur, annulerExterieur, addProduit, setCategories, opId, ApiError, IS_DEMO } from './api.js';
import { renderToday } from './today.js';
import { renderCourses } from './courses.js';
import { renderCuisine } from './cuisine.js';
import { renderBilan } from './bilan.js';
/* `scan.js` (23 ko), `ranger.js` et `quoimanger.js` ne servent qu'à un tap, et
 * jamais au démarrage : les charger à la demande retire leur téléchargement et
 * leur compilation du chemin critique du premier lancement — c'est près de la
 * moitié du JS de l'app. Le service worker les précharge de toute façon
 * (`SHELL` dans sw.js), donc le tap reste instantané dès la deuxième session.
 *
 * Les modules d'écran (courses, cuisine, bilan) restent statiques : ils sont
 * appelés à plusieurs endroits, y compris depuis des chemins qui repeignent
 * après une réponse réseau, et rendre ces appels asynchrones ouvrirait une
 * question d'ordre de peinture pour économiser quelques kilo-octets. */
import { flushQueue, updateQueueBadge, registerServiceWorker, applyUpdate, versionAppShell, chercherMiseAJour } from './sync.js';
import { DEFAULT_API_BASE, APP_VERSION } from './config.js';

const modules = {};
function charger(nom) {
  if (!modules[nom]) modules[nom] = import(`./${nom}.js`);
  return modules[nom];
}

const appEl = $('#app');
const sheetRoot = $('#sheet-root');
const fab = $('#btn-quoi-manger');

let currentScreen = 'today';
let M = null; // modèle courant { state, foods, plats }
let CatalogData = null; // dernier catalogue brut (pour reconstruire M depuis un state seul)
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

/* ------------------------------------------------------------------ */
/* Fenêtre de fraîcheur                                                */
/* ------------------------------------------------------------------ */
/**
 * Chaque retour sur un onglet relançait un appel réseau — soit, en usage réel,
 * une poignée d'allers-retours Apps Script par minute, à 2 s dans le meilleur
 * des cas et parfois trente. Or entre deux taps sur la barre du bas, rien n'a
 * bougé : c'est cette app qui écrit les données, et toute écriture rapporte
 * désormais l'état frais avec sa réponse.
 *
 * On ne redemande donc que si la dernière réponse a plus d'une minute. Le
 * rafraîchissement reste toujours accessible d'un geste (tirer vers le bas),
 * et une écriture périme immédiatement les écrans qu'elle a pu changer.
 */
const FRAICHEUR_MS = 60000;
const vuLe = { today: 0, courses: 0, cuisine: 0, bilan: 0 };
let forcerRechargement = false;         // armé par le tirer-pour-rafraîchir

function estFrais(nom) {
  if (forcerRechargement) return false;
  return Date.now() - (vuLe[nom] || 0) < FRAICHEUR_MS;
}
function perimer(...noms) { noms.forEach((n) => { vuLe[n] = 0; }); }

/** Recharge l'écran courant (après synchro d'une file rejouée, retour réseau…). */
function refreshCurrent() {
  // Renvoie la promesse : le tirer-pour-rafraîchir doit savoir quand relâcher
  // son indicateur, et le rendre en `then` plutôt qu'à l'aveugle après un délai.
  if (currentScreen === 'courses') return renderCoursesScreen();
  if (currentScreen === 'cuisine') return renderCuisineScreen();
  if (currentScreen === 'bilan') return renderBilanScreen();
  return renderTodayScreen();
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

  // Badges G / L du stock (2026-08-13). Seul un « oui » explicite allume le
  // badge : une colonne vide veut dire « pas renseigné », et afficher un badge
  // par défaut — dans un sens comme dans l'autre — serait une affirmation que
  // la base ne porte pas. Les flags des produits sont saisis au scan, ceux des
  // plats sont hérités de leur composition (backend, flagsComposition_).
  const flags = (x) => ({
    gluten: String(x.flag_gluten || '').toLowerCase() === 'oui',
    lactose: String(x.flag_lactose || '').toLowerCase() === 'oui',
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
    ...flags(pr),
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
      ...flags(pl),
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
// Ordre de la barre du bas : il donne le SENS du glissement. Aller vers Bilan
// pousse vers la gauche, revenir vers Aujourd'hui ramène vers la droite — le
// mouvement dit où l'on est allé, ce qu'un fondu ne raconte pas.
const ORDRE_ECRANS = ['today', 'courses', 'cuisine', 'bilan'];

function setScreen(name) {
  if (name === currentScreen) { window.scrollTo(0, 0); refreshCurrent(); return; }
  const avant = ORDRE_ECRANS.indexOf(name) > ORDRE_ECRANS.indexOf(currentScreen);
  currentScreen = name;

  const appliquer = () => {
    document.querySelectorAll('.tab').forEach((t) =>
      t.classList.toggle('is-active', t.dataset.screen === name));
    fab.hidden = name !== 'today';
    window.scrollTo(0, 0);               // on arrive en haut d'un écran, pas au milieu
    const render = {
      today: renderTodayScreen,
      courses: renderCoursesScreen,
      cuisine: renderCuisineScreen,
      bilan: renderBilanScreen,
    }[name] || renderTodayScreen;
    // Volontairement SANS `return` : les fonctions d'écran sont asynchrones, et
    // rendre leur promesse ferait attendre la transition jusqu'à la réponse du
    // serveur — soit, un jour sur trois, une trentaine de secondes d'écran figé.
    // Leur partie synchrone (peinture depuis le cache, ou squelette) suffit, et
    // c'est justement l'image que la transition doit capturer.
    render();
  };

  // View Transitions : le navigateur photographie l'écran avant et après, et
  // fait le fondu-glissé lui-même. C'est fait pour exactement ce cas — une app
  // qui repeint tout son contenu d'un coup. Absente (Firefox, vieux Safari) ou
  // refusée par l'appareil : on applique directement, sans rien casser.
  if (!document.startViewTransition || estSobre() || document.hidden) { appliquer(); return; }
  document.documentElement.dataset.sens = avant ? 'avant' : 'arriere';
  const vt = document.startViewTransition(appliquer);
  // Une transition abandonnée rejette `ready` et `finished`. Ça arrive
  // normalement — deux taps rapides sur la barre du bas, ou une page qui ne
  // peint pas (app en arrière-plan). Le changement d'écran a lieu quand même,
  // via le callback : seule l'animation saute. Sans ces `catch`, chaque
  // occurrence remonte en « Uncaught (in promise) » dans la console.
  vt.ready.catch(() => {});
  vt.finished.catch(() => {});
}

/** L'appareil demande qu'on limite les animations. */
function estSobre() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
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

/**
 * Peint l'écran Aujourd'hui. `pending` = les références qu'une action encore en
 * file touche : leurs lignes sont verrouillées, parce que le stock affiché pour
 * elles n'est plus celui du serveur (2026-08-13).
 */
function paint() {
  if (currentScreen === 'today' && M) {
    renderToday(appEl, { ...M, pending: store.pendingRefs() }, handlers);
  }
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
  CatalogData = cc.catalog;
  M = buildModel({ ...cs.state, __attente: cs.state.date !== isoLocal() }, cc.catalog);
  paint();
  return true;
}

/** Adopte un couple state/catalog frais : modèle, cache et peinture. */
function adopter(state, catalog) {
  if (catalog) { CatalogData = catalog; store.cacheCatalog(catalog); }
  if (!state || !CatalogData) return;
  M = buildModel(state, CatalogData);
  store.cacheState(state);
  // Cet état vient du serveur à l'instant, qu'il arrive d'un `boot` ou de la
  // réponse d'une écriture : l'écran Aujourd'hui n'a rien à redemander.
  vuLe.today = Date.now();
  paint();
}

async function renderTodayScreen() {
  if (!IS_DEMO && !store.hasToken()) { openSettings({ force: true }); return; }
  if (M) paint();
  else if (!peindreDepuisCache()) loadingState();

  // Modèle déjà à jour, jauges du bon jour : rien à redemander. C'est le cas le
  // plus fréquent (aller sur Courses et revenir), et c'était un appel réseau
  // complet à chaque fois.
  if (M && !M.state.__attente && estFrais('today')) return;

  syncing(true);
  try {
    // UN aller-retour au lieu de deux : `state` et `catalog` se lisent dans les
    // mêmes onglets côté backend, et chaque exécution Apps Script coûte 1 à 3 s.
    const { state, catalog } = await getBoot();
    adopter(state, catalog);
  } catch (err) {
    const cs = store.getCachedState();
    const cc = store.getCachedCatalog();
    if (cs && cs.state && cc && cc.catalog) {
      // Même règle qu'en peinture immédiate : le stock d'hier reste vrai, ses
      // jauges non — hors-ligne on ne peut plus les mettre à jour, alors on les
      // laisse en attente plutôt que de dater les apports de la veille.
      CatalogData = cc.catalog;
      M = buildModel({ ...cs.state, __offline: causeCache(err), __attente: cs.state.date !== isoLocal() }, cc.catalog);
      paint();
      toast(err instanceof ApiError && err.enLigne === false
        ? 'Hors-ligne — données du dernier chargement'
        : 'Serveur lent — données du dernier chargement', 'err');
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
    // `enLigne` (2026-08-13) : la mesure a montré qu'un appel sur trois met plus
    // de 20 s à revenir d'Apps Script alors que la connexion est parfaite.
    // Annoncer « Vérifie ta connexion » envoyait chercher une panne qui n'existe
    // pas — et fait douter d'un réseau qui marche.
    case 'network': return err.enLigne
      ? 'Le serveur Google n’a pas répondu à temps. C’est lui, pas ta connexion — réessaie.'
      : 'Pas de connexion. Tes actions sont gardées et partiront au retour du réseau.';
    case 'backend': return `Le backend a répondu : « ${err.message} ». Vérifie le token dans les réglages.`;
    case 'http':    return `Le serveur a renvoyé une erreur (${err.message}).`;
    default:        return err.message;
  }
}

/**
 * Pourquoi on retombe sur le cache : `'reseau'` (vraiment déconnecté) ou
 * `'serveur'` (Apps Script n'a pas répondu dans les temps). Le bandeau des
 * écrans le dit tel quel — annoncer « Hors-ligne » à quelqu'un de connecté
 * l'envoie chercher une panne qui n'existe pas.
 */
function causeCache(err) {
  return err instanceof ApiError && err.enLigne === false ? 'reseau' : 'serveur';
}

/** Formulation d'une mise en file : « hors-ligne » n'est vrai que si on l'est. */
function libelleFile(err, quoi) {
  const vraimentHorsLigne = err instanceof ApiError && err.enLigne === false;
  return vraimentHorsLigne
    ? `Hors-ligne — ${quoi} mis en file`
    : `Serveur lent — ${quoi} gardé, ça repartira tout seul`;
}

/* ------------------------------------------------------------------ */
/* Écran Courses                                                       */
/* ------------------------------------------------------------------ */
/**
 * Squelette de premier chargement, à la place du spinner nu. Il dessine la
 * FORME de l'écran qui arrive : l'œil se pose déjà au bon endroit, et la page
 * ne saute pas quand le contenu remplace le vide. Un spinner, lui, ne dit rien
 * de ce qu'on attend et fait paraître l'attente plus longue qu'elle n'est.
 * N'apparaît qu'au tout premier chargement d'un écran — ensuite le cache prend
 * le relais et l'affichage est immédiat.
 */
const SQUELETTES = {
  courses: [20, 64, 64, 64, 20, 64, 64],
  cuisine: [20, 168, 20, 92, 92],
  bilan:   [34, 56, 100, 100, 100],
};
function squelette(kind) {
  clear(appEl);
  appEl.append(h('div', { class: 'skel', role: 'status', 'aria-label': 'Chargement' },
    ...(SQUELETTES[kind] || [20, 64, 64, 64]).map((px) =>
      h('div', { class: 'skel__bloc', style: `height:${px}px` }))));
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
  else squelette('courses');
  if (hadCache && estFrais('courses')) return;
  syncing(true);
  try {
    const courses = await getCourses();
    store.cacheCourses(courses);
    vuLe.courses = Date.now();
    const changed = !hadCache || !sameData(courses, cached.courses);
    CoursesData = courses;
    if (currentScreen === 'courses' && changed) renderCourses(appEl, courses, coursesHandlers);
  } catch (err) {
    const cc = store.getCachedCourses();
    if (cc && cc.courses) {
      if (currentScreen === 'courses') renderCourses(appEl, { ...cc.courses, __offline: causeCache(err) }, coursesHandlers);
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
  const id = opId();
  try {
    const res = await logCourses(items, id);
    const reverse = res && Array.isArray(res.courses_validees)
      ? res.courses_validees.map((a) => ({ produit_id: a.produit_id, grammes: Number(a.grammes) || 0 }))
      : items.map((i) => ({ produit_id: i.produit_id, grammes: Number(i.grammes) || 0 }));
    store.setLastCourses({ at: Date.now(), reverse });   // pour l'annulation
    const n = items.length;
    toast(`${n} article${n > 1 ? 's' : ''} ajouté${n > 1 ? 's' : ''} au stock`, 'ok');
    perimer('courses');
    // L'état frais voyage avec la réponse depuis le 2026-08-13 : on l'adopte au
    // lieu de vider `M` et de déclencher un `boot` complet au prochain passage
    // sur Aujourd'hui. Un aller-retour Apps Script économisé par validation.
    if (res && res.state) adopter(res.state);
    else M = null;
    if (currentScreen === 'courses') renderCourses(appEl, CoursesData, coursesHandlers); // affiche le bandeau d'annulation
  } catch (err) {
    if (isOffline(err)) {
      enqueue({ action: 'log', type: 'courses', items, op_id: id });
      toast(libelleFile(err, 'la validation'), 'err');
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
  // UN seul op_id, pour UN seul POST : l'annulation part en lot depuis le
  // 2026-08-13. Avant, c'était un appel par article — dix articles valaient dix
  // exécutions Apps Script qui se disputaient le verrou d'écriture une par une.
  const id = opId();
  const items = last.reverse.map((r) => ({ ref: r.produit_id, delta: -Number(r.grammes) || 0 }));
  try {
    const res = await adjustStockLot(items, id);
    store.clearLastCourses();
    perimer('courses');
    if (res && res.state) adopter(res.state); else M = null;
    toast('Dernières courses annulées', 'ok');
    renderCoursesScreen();          // recharge : les articles annulés réapparaissent
  } catch (err) {
    if (isOffline(err)) {
      enqueue({ action: 'log', type: 'ajustement', items, op_id: id });
      store.clearLastCourses();
      toast(libelleFile(err, 'l’annulation'), 'err');
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
  else squelette('cuisine');
  if (hadCache && estFrais('cuisine')) return;
  syncing(true);
  try {
    const data = await getCuisine();
    store.cacheCuisine(data);
    vuLe.cuisine = Date.now();
    const changed = !hadCache || !sameData(data, cached.cuisine);
    CuisineData = data;
    if (currentScreen === 'cuisine' && changed) renderCuisine(appEl, data, cuisineHandlers);
  } catch (err) {
    const cc = store.getCachedCuisine();
    if (cc && cc.cuisine) {
      CuisineData = cc.cuisine;
      if (currentScreen === 'cuisine') renderCuisine(appEl, { ...cc.cuisine, __offline: causeCache(err) }, cuisineHandlers);
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
  const id = opId();
  try {
    const res = await logBatch(ref, id);
    const label = poids ? `+${num(Math.round(poids))} g` : 'cuisiné';
    toast(`${rec.nom} — ${label}`, 'ok');
    // Le stock arrive avec la réponse ; la « dernière réalisation » et les
    // compteurs de l'écran Cuisine, eux, ne sont que dans le payload `cuisine` —
    // on ne le redemande donc que si cet écran est bien celui qu'on regarde.
    if (res && res.state) adopter(res.state); else M = null;
    perimer('cuisine', 'courses');       // fournée en stock, ingrédients consommés
    if (IS_DEMO) { bumpCuisineLocal(rec, poids); renderCuisine(appEl, CuisineData, cuisineHandlers); }
    else if (currentScreen === 'cuisine') renderCuisineScreen();
  } catch (err) {
    if (isOffline(err)) {
      enqueue({ action: 'log', type: 'batch_cuisine', ref, op_id: id });
      toast(libelleFile(err, 'la cuisine'), 'err');
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
  else squelette('bilan');
  if (hadCache && estFrais('bilan')) return;
  syncing(true);
  try {
    const data = await getBilan();
    store.cacheBilan(data);
    vuLe.bilan = Date.now();
    const changed = !hadCache || !sameData(data, cached.bilan);
    if (currentScreen === 'bilan' && changed) renderBilan(appEl, data);
  } catch (err) {
    const cb = store.getCachedBilan();
    if (cb && cb.bilan) {
      if (currentScreen === 'bilan') renderBilan(appEl, { ...cb.bilan, __offline: causeCache(err) });
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
  onRanger: async () => (await charger('ranger')).openRanger(M ? M.foods : [], rangerAction),
  onSupprimerEntree: (entree) => supprimerEntree(entree),   // ✕ du résumé du jour
};

/**
 * ✕ du résumé du jour : retire une entrée de la journée.
 *
 * Un aliment n'a besoin d'aucune mécanique nouvelle — c'est un `commit` de delta
 * négatif, exactement ce que produit un curseur reculé : la quantité repart au
 * stock et les apports quittent les jauges. Un repas extérieur, lui, n'a ni
 * stock ni curseur : il faut retirer sa ligne du journal côté serveur.
 */
async function supprimerEntree(e) {
  if (!e) return;
  if (e.type !== 'exterieur') {
    const grammes = Number(e.grammes) || 0;
    if (!(grammes > 0)) return;
    const res = await commitChanges(
      [{ ref: e.ref, food: { kind: e.type }, delta: -grammes }],
      { libelle: `${e.nom} retiré du jour` });
    // Refus du serveur : l'écran n'a pas été repeint, donc la ligne du journal
    // est toujours là — il faut la dégeler.
    if (res && res.repaint === false) throw new Error('refus serveur');
    return;
  }

  const id = opId();
  syncing(true);
  try {
    const data = await annulerExterieur(e.rang, e.kcal, id);
    toast('Repas extérieur retiré', 'ok');
    perimer('bilan');
    if (data && data.state) adopter(data.state);
    else await reconcile();                    // mode démo : pas d'état renvoyé
  } catch (err) {
    // Pas de mise en file hors-ligne : `rang` désigne une position dans le
    // journal du jour, et rejouer plus tard une annulation calculée sur un
    // journal périmé retirerait le mauvais repas. On demande de réessayer.
    toast(describeError(err), 'err');
    throw err;                                 // la ligne se dégèle côté écran
  } finally {
    syncing(false);
  }
}

/** Enregistre un lot de rangements, puis recharge le catalogue (les pastilles
 *  de filtre en dépendent). Pas de file offline : ranger n'est pas urgent, et
 *  rejouer un rangement obsolète écraserait un choix plus récent. */
async function rangerAction(items) {
  const res = await setCategories(items);          // l'erreur remonte → la feuille l'affiche
  // `state` ET `catalog` reviennent avec la réponse : ranger change les
  // pastilles de filtre, ce qui obligeait à redemander un `boot` complet.
  if (res && res.state) adopter(res.state, res.catalog);
  else { M = null; refreshCurrent(); }
}

/**
 * Valide les mouvements d'inventaire — TOUT le lot en un seul POST, dont la
 * réponse contient déjà l'état frais du serveur.
 *
 * Refonte du 2026-08-13, sur trois constats d'usage :
 *
 *  1. **On n'affiche plus de stock non synchronisé.** L'ancienne version
 *     écrivait le nouveau stock dans le modèle AVANT la réponse ; en cas
 *     d'échec, cet optimisme survivait (rien ne le reprenait dans la branche
 *     hors-ligne). L'écran montrait alors un stock que le serveur ignorait, et
 *     toute nouvelle validation partait de ce faux point de départ : les
 *     quantités s'empilaient. Désormais le stock affiché vient TOUJOURS du
 *     serveur, et un lot non parti verrouille ses lignes.
 *  2. **Un curseur reculé retire aussi les macros du jour** (c'est le backend
 *     qui s'en charge, `commit_`), au lieu de ne rendre que le stock.
 *  3. **Un aller-retour au lieu de N+2.** Huit aliments valaient huit POST
 *     concurrents plus deux GET de recalage — d'où la lenteur, et les courses
 *     entre écritures simultanées sur le même onglet.
 *
 * @returns {Promise<{repaint:boolean}>} repaint=true → l'écran a été repeint,
 *   le DOM de l'appelant est caduc (sinon il garde ses curseurs pour réessayer).
 */
async function commitChanges(changes, { libelle = '' } = {}) {
  const id = opId();
  const payload = changes.map((c) => ({
    ref: c.ref,
    kind: c.food && c.food.kind === 'plat' ? 'plat' : 'produit',
    delta: c.delta,                       // grammes signés : > 0 mangé, < 0 correction
  }));

  syncing(true);
  try {
    const data = await postCommit(payload, id);
    const n = changes.length;
    toast(libelle || `${n} aliment${n > 1 ? 's' : ''} mis à jour`, 'ok');
    perimer('courses', 'bilan');          // stock entamé, apports du jour comptés
    if (data && data.state) adopter(data.state);
    else await reconcile();               // mode démo : pas d'état renvoyé
    if (data && data.ignores && data.ignores.length) {
      toast(`${data.ignores.length} référence(s) inconnue(s) ignorée(s)`, 'err');
    }
    return { repaint: true };
  } catch (err) {
    if (isOffline(err)) {
      // Même op_id que la tentative perdue : si elle était en fait passée, le
      // rejeu sera sans effet côté backend.
      enqueue({ action: 'commit', op_id: id, changes: payload });
      toast(libelleFile(err, 'la validation'), 'err');
      paint();                            // les lignes concernées passent « en attente »
      return { repaint: true };
    }
    // Refus du serveur : rien n'a été écrit, on laisse les curseurs en place
    // pour que la saisie ne soit pas perdue.
    toast(describeError(err), 'err');
    return { repaint: false };
  } finally {
    syncing(false);
  }
}

/** Repas extérieur : macros libres → jauges du jour, sans toucher au stock. */
async function exterieurAction(macros) {
  const id = opId();
  syncing(true);
  try {
    const res = await logExterieur(macros, id);
    toast('Repas extérieur ajouté', 'ok');
    perimer('bilan');
    if (IS_DEMO) { applyMacros(M.state, macros, 1, +1); paint(); }  // fixture statique
    else if (res && res.state) adopter(res.state);
    else await reconcile();
  } catch (err) {
    if (isOffline(err)) {
      enqueue({ action: 'log', type: 'exterieur', ...macros, op_id: id });
      // Pas de bump optimiste des jauges : un repas en file n'est pas encore
      // compté par le serveur, et l'afficher comme acquis est précisément ce
      // qui rendait l'état local et l'état distant impossibles à départager.
      toast(libelleFile(err, 'le repas'), 'err');
      paint();
    } else {
      toast(describeError(err), 'err');
    }
  } finally {
    syncing(false);
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
  const n = Math.max(1, Number(unites) || 1);
  const grammes = n * paquet;
  const id = opId();
  // Aucun +stock local avant la réponse : tant que le serveur n'a pas confirmé,
  // le stock affiché reste le sien (règle du 2026-08-13).
  try {
    const res = await logCourses([{ produit_id: food.id, unites: n }], id);
    toast(`${food.nom} — +${num(Math.round(grammes))} g`, 'ok');
    // La liste de courses, elle, se recalcule côté serveur : on la relit
    // seulement si elle est à l'écran. Sinon le prochain passage s'en chargera.
    perimer('courses');
    if (res && res.state) { adopter(res.state); if (currentScreen !== 'today') refreshCurrent(); }
    else { M = null; refreshCurrent(); }
  } catch (err) {
    if (isOffline(err)) {
      enqueue({ action: 'log', type: 'courses', items: [{ produit_id: food.id, unites: n }], source: 'scan', op_id: id });
      toast(libelleFile(err, 'l’ajout'), 'err');
      if (currentScreen === 'today') paint();
    } else {
      toast(describeError(err), 'err');
      throw err;                 // la feuille de scan réactive son bouton
    }
  }
}

/** « Pot fini » depuis le scan : force le stock à 0 + recalibration backend. */
async function potFiniAction(food) {
  const id = opId();
  try {
    const res = await logPotFini(food.id, id);
    toast(`${food.nom} — pot fini`, 'ok');
    perimer('courses');   // le produit repasse en besoin
    if (res && res.state) { adopter(res.state); if (currentScreen !== 'today') refreshCurrent(); }
    else { M = null; refreshCurrent(); }
  } catch (err) {
    if (isOffline(err)) {
      enqueue({ action: 'log', type: 'pot_fini', ref: food.id, source: 'scan', op_id: id });
      toast(libelleFile(err, '« pot fini »'), 'err');
      if (currentScreen === 'today') paint();
    } else {
      toast(describeError(err), 'err');
      throw err;                 // la feuille de scan réactive son bouton
    }
  }
}

/** Ajout au catalogue depuis une fiche OpenFoodFacts validée. */
async function addProduitAction(fiche) {
  const res = await addProduit(fiche);   // l'erreur remonte → la feuille l'affiche
  perimer('courses');
  if (res && res.state) { adopter(res.state, res.catalog); if (currentScreen !== 'today') refreshCurrent(); }
  else { M = null; refreshCurrent(); }
  return res;
}

/** Recale silencieusement depuis la source de vérité. */
async function reconcile() {
  syncing(true);
  try {
    const { state, catalog } = await getBoot();
    adopter(state, catalog);
  } catch { /* le dernier état connu reste affiché si le recalage échoue */ }
  finally { syncing(false); }
}

/**
 * Applique des macros aux jauges. **Mode démo uniquement** depuis le
 * 2026-08-13 : hors démo, les jauges affichées viennent toujours du serveur.
 * Un bump local survivait à l'échec de l'envoi et faisait diverger l'écran de
 * la vérité — le point de départ des synchros fantômes.
 */
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
  // Le cas « cache à jour, page pas rechargée » est le plus courant des deux et
  // le plus déroutant : la mise à jour EST là, elle attend juste un
  // rechargement. Constater la divergence ne suffisait pas — Azur a passé deux
  // échanges à croire à un bug de filtres alors qu'il tournait sur l'ancienne
  // page (2026-08-11). Le bouton est donc l'action, pas la note de bas de page.
  const recharger = h('button', { class: 'btn btn--primary', type: 'button', hidden: true,
    onclick: () => location.reload() }, 'Recharger l’app maintenant');

  versionAppShell().then((shell) => {
    if (shell == null) {
      shellEl.textContent = 'aucun (pas de cache hors-ligne)';
      etat.textContent = 'Service worker inactif — normal en développement local.';
      return;
    }
    shellEl.textContent = shell;
    if (shell === APP_VERSION) {
      etat.textContent = 'Code et app-shell en cache sont sur la même version.';
      return;
    }
    etat.textContent = `⚠ La page ouverte tourne en ${APP_VERSION}, alors que la version `
      + `${shell} est déjà en cache. Recharge pour l’utiliser.`;
    recharger.hidden = false;
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
    recharger,
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
  popinMaj('Une nouvelle version est prête.', () => applyUpdate(reg));
}

/**
 * Cas vécu le 2026-08-11 : le cache portait déjà la v20 pendant que la page
 * ouverte tournait en v19. La mise à jour était là — installée, activée — mais
 * aucun service worker n'attendait, donc aucun popin ne s'affichait, et l'app
 * continuait d'exécuter l'ancien code. Deux échanges à chercher un bug de
 * filtres qui était en réalité déjà corrigé.
 *
 * On compare donc aussi les NUMÉROS au démarrage. Un shell plus ANCIEN que le
 * code est l'inverse (installation en cours) : transitoire, on se tait.
 */
async function verifierVersionPage() {
  const numero = (v) => {
    const tous = String(v || '').match(/v(\d+)/g);
    return tous ? Math.max(...tous.map((x) => Number(x.slice(1)))) : null;
  };
  const enCache = numero(await versionAppShell());
  const chargee = numero(APP_VERSION);
  if (enCache == null || chargee == null || enCache <= chargee) return;
  popinMaj('Elle est déjà téléchargée : recharge pour l’utiliser.', () => location.reload());
}

/** Bandeau « Mise à jour disponible » — le bouton fait ce qu'on lui passe. */
function popinMaj(sous, action) {
  if (document.querySelector('.update-popin')) return;      // déjà proposé
  const btn = h('button', { class: 'update-popin__btn', type: 'button' }, 'Recharger');
  btn.onclick = () => {
    btn.disabled = true;
    btn.textContent = '…';
    action();
  };
  const plusTard = h('button', {
    class: 'update-popin__close', type: 'button', 'aria-label': 'Plus tard',
    onclick: () => { el.remove(); document.body.classList.remove('has-update'); },
  }, '✕');

  const el = h('div', { class: 'update-popin', role: 'status' },
    h('span', { class: 'update-popin__ico', 'aria-hidden': 'true' }, '✨'),
    h('div', { class: 'update-popin__txt' },
      h('div', { class: 'update-popin__title' }, 'Mise à jour disponible'),
      h('div', { class: 'update-popin__sub' }, sous)),
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
$('#btn-scan').addEventListener('click', async () => (await charger('scan')).openScan(scanContext));
fab.addEventListener('click', async () => {
  if (!M) return;
  const { openQuoiManger } = await charger('quoimanger');
  openQuoiManger(M.state, M.foods, (food) => scrollToFood(food.id));
});

// Badge « en attente » : rejeu manuel de la file (utile si l'event `online` a raté).
$('#queue-badge').addEventListener('click', () => syncQueue({ silent: false }));

/** Rejoue la file offline ; si des actions sont parties, le backend a changé → recharge. */
async function syncQueue(opts) {
  const res = await flushQueue(opts);
  if (!res.sent) return res;
  CoursesData = null;
  // Un `commit` rejoué rapporte déjà l'état frais : inutile de le redemander.
  if (res.state) {
    adopter(res.state);
    if (currentScreen !== 'today') refreshCurrent();
  } else {
    M = null; refreshCurrent();
  }
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

/* ------------------------------------------------------------------ */
/* Tirer pour rafraîchir                                               */
/* ------------------------------------------------------------------ */
/**
 * Contrepartie de la fenêtre de fraîcheur : puisque l'app ne redemande plus le
 * serveur à chaque retour d'onglet, il faut un moyen de le faire exprès. Le
 * geste est celui que tout le monde connaît, et il ne prend aucune place à
 * l'écran — contrairement à un bouton, qui aurait dû cohabiter avec la barre de
 * validation, le FAB et la barre du bas.
 *
 * `overscroll-behavior-y: none` (feuille de style) empêche le rebond natif :
 * la page ne bouge pas sous le doigt, seul l'indicateur descend.
 */
const PTR_SEUIL = 68;
function installerPullToRefresh() {
  const ind = h('div', { class: 'ptr', hidden: true, 'aria-hidden': 'true' },
    h('span', { class: 'ptr__ico' }, '↻'));
  document.body.append(ind);

  let depart = null;
  let tire = 0;

  const ranger = () => {
    ind.hidden = true;
    ind.style.transform = '';
    ind.classList.remove('is-arme', 'is-actif');
    depart = null; tire = 0;
  };

  document.addEventListener('touchstart', (e) => {
    // Uniquement en haut de page, un seul doigt, et pas par-dessus une feuille
    // modale ouverte (le geste y voudrait dire « fermer », pas « recharger »).
    if (e.touches.length !== 1 || window.scrollY > 0 || sheetRoot.firstChild) { depart = null; return; }
    depart = e.touches[0].clientY;
    tire = 0;
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (depart == null) return;
    const dy = e.touches[0].clientY - depart;
    if (dy <= 0 || window.scrollY > 0) { ranger(); return; }
    // Résistance : le doigt parcourt deux fois la distance de l'indicateur, ce
    // qui rend l'armement volontaire et évite les déclenchements au défilement.
    tire = Math.min(dy * 0.5, 92);
    ind.hidden = false;
    ind.style.transform = `translateX(-50%) translateY(${tire}px) rotate(${tire * 3}deg)`;
    ind.classList.toggle('is-arme', tire >= PTR_SEUIL);
  }, { passive: true });

  document.addEventListener('touchend', () => {
    if (depart == null) return;
    if (tire < PTR_SEUIL) { ranger(); return; }
    depart = null;
    ind.style.transform = 'translateX(-50%) translateY(46px)';
    ind.classList.add('is-actif');
    forcerRechargement = true;
    Promise.resolve(refreshCurrent())
      .catch(() => {})
      .finally(() => { forcerRechargement = false; ranger(); });
  });
}

/**
 * Précharge en fond les écrans qu'on n'a pas encore ouverts, une fois
 * Aujourd'hui peint. Un onglet visité pour la première fois affichait un
 * squelette puis attendait la réponse ; ici la donnée est déjà là quand le
 * doigt arrive. Silencieux et sans conséquence s'il échoue.
 */
async function prechargerOnglets() {
  if (IS_DEMO || !store.hasToken() || !navigator.onLine) return;
  const manquants = [
    ['courses', store.getCachedCourses(), getCourses, store.cacheCourses],
    ['bilan', store.getCachedBilan(), getBilan, store.cacheBilan],
  ].filter(([nom, cache]) => !cache && !estFrais(nom));
  // En série, pas en parallèle : deux requêtes simultanées vers Apps Script se
  // gênent plus qu'elles ne s'aident, et rien ne presse ici.
  for (const [nom, , charger, cacher] of manquants) {
    try {
      const data = await charger();
      cacher.call(store, data);
      vuLe[nom] = Date.now();
    } catch { /* le prochain passage sur l'onglet réessaiera */ }
  }
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
installerPullToRefresh();
setScreen('today');
syncQueue({ silent: true });
verifierVersionPage();     // cache plus récent que la page ouverte → propose le rechargement
// Les autres onglets se chargent pendant qu'on regarde ses jauges : leur
// première ouverture est alors instantanée, au lieu d'un squelette + 2 s.
setTimeout(prechargerOnglets, 2500);
