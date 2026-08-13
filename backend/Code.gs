/**
 * Enthalpie — Backend Apps Script (WebApp)
 * ----------------------------------------
 * Source de vérité : le Google Sheet porteur de ce script.
 * Déploiement : Déployer > Nouveau déploiement > Application Web
 *   - Exécuter en tant que : moi
 *   - Accès : tout le monde (l'auth réelle se fait par token dans l'URL)
 *
 * Endpoints :
 *   GET  ?token=…&action=boot           → { state, catalog } en UN aller-retour
 *   GET  ?token=…&action=state          → jauges du jour, pools par créneau, stock, journal du jour
 *   GET  ?token=…&action=catalog        → produits + plats actifs
 *   GET  ?token=…&action=courses        → liste de courses (par magasin/rayon)
 *   GET  ?token=…&action=cuisine        → recette de la semaine + biblio batch + compteurs
 *   GET  ?token=…&action=bilan          → prot/kcal/fibres vs cibles : 7 derniers jours + 4 sem.
 *   POST {token, action:'commit', op_id, changes:[…]} → tout l'inventaire d'un coup + état frais
 *   POST {token, action:'log', ...}     → plat | produit | pot_fini | batch_cuisine | courses | ajustement | exterieur
 *   POST {token, action:'set_categorie', items:[{produit_id, categorie}]} → rangement du stock
 *   POST {token, action:'annuler_exterieur', op_id, rang} → retire un repas extérieur du jour
 *
 * TOUTE écriture est sérialisée (verrou) et idempotente si elle porte un `op_id`
 * (cf. §4). C'est la règle qui empêche un rejeu de compter deux fois — le bug
 * de synchro du 2026-08-13.
 *
 * Conforme à SPEC.md §3 (modèle de données) et §5-6 (moteur / liste).
 * 100 % déterministe, aucune IA ici (SPEC §1 principe 6).
 */

/* ===================================================================== */
/* 1. SCHÉMA DES ONGLETS                                                  */
/* ===================================================================== */

// Unité interne UNIQUE : le gramme. Le stock, les quantités des logs et les
// compositions sont tous en grammes ; les valeurs nutritionnelles sont toutes
// POUR 100 g. La notion de « portion » a été retirée (2026-08-08) : elle voulait
// dire « une tranche » côté usage et « 100 g » côté jargon, d'où des calculs
// faux. L'app raisonne désormais en pourcentage d'un paquet dont on connaît le
// poids. Migration des données existantes : migrerEnGrammes().
var SCHEMA = {
  // ⚠️ `categorie` ajoutée EN FIN DE LISTE (2026-08-11), pour la même raison que
  // dans `objectifs` : setup() réécrit la ligne d'en-tête sans toucher aux
  // données, une insertion au milieu décalerait tout.
  produits: [
    'id', 'nom', 'marque_magasin', 'ean', 'poids_paquet_g',
    'kcal_100g', 'prot_100g', 'fibres_100g', 'flag_gluten', 'flag_lactose', 'perissable_jours', 'actif',
    'categorie'
  ],
  plats: [
    'id', 'nom', 'creneau', 'composition', 'kcal_100g', 'prot_100g', 'fibres_100g',
    'type', 'gabarit', 'actif'
  ],
  recettes: [
    'id', 'plat_id', 'poids_produit_g', 'instructions', 'derniere_realisation'
  ],
  log: [
    'timestamp', 'type', 'ref', 'quantite', 'source', 'extra'
  ],
  stock: [
    'ref', 'grammes'
  ],
  // ⚠️ Colonnes ajoutées EN FIN DE LISTE, impérativement : setup() réécrit la
  // ligne d'en-tête sans toucher aux lignes de données. Une insertion au milieu
  // décalerait les en-têtes par rapport aux valeurs déjà saisies.
  objectifs: [
    'kcal_jour', 'prot_g_jour', 'tol_kcal', 'tol_prot',
    'mode_strict_gluten', 'mode_strict_lactose',
    'fibres_g_jour', 'tol_fibres'          // ajout 2026-08-09 (skill nutrition §6)
  ],
  parametres: [
    'cle', 'valeur'
  ],
  // Journal des opérations d'écriture déjà appliquées (2026-08-13). Sert
  // uniquement à l'idempotence : une action rejouée après une réponse perdue
  // retrouve son `op_id` ici et n'est PAS réappliquée.
  ops: [
    'op_id', 'timestamp', 'action', 'resume'
  ]
};

// Valeurs de créneau reconnues (SPEC §3.2).
var CRENEAUX = ['petit_dej', 'dejeuner', 'diner', 'collation'];

/* ===================================================================== */
/* 2. SETUP — création / réinitialisation des onglets                    */
/* ===================================================================== */

/**
 * À exécuter UNE FOIS à la main depuis l'éditeur Apps Script après avoir
 * collé ce fichier dans le Sheet. Crée les onglets avec en-têtes et
 * pré-remplit objectifs (cibles du skill nutrition) + parametres.
 * Idempotent : ne réécrit pas les en-têtes si déjà présents.
 *
 * Aucun onglet ajouté depuis n'exige de relancer setup() : `assurerOnglet_`
 * crée ce qui manque à la première écriture (cf. `ops`, 2026-08-13).
 */
function setup() {
  oublierTout_();                        // les en-têtes vont bouger sous le mémo
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(SCHEMA).forEach(function (name) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    var headers = SCHEMA[name];
    var first = sh.getRange(1, 1, 1, headers.length).getValues()[0];
    if (first.join('') !== headers.join('')) {
      sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
      sh.setFrozenRows(1);
    }
  });

  // Onglet par défaut « Feuille 1 » si vide → on le retire proprement
  var def = ss.getSheetByName('Feuille 1') || ss.getSheetByName('Sheet1');
  if (def && ss.getSheets().length > 1) ss.deleteSheet(def);

  seedDefaults_();
  SpreadsheetApp.getUi &&
    SpreadsheetApp.getActiveSpreadsheet().toast(
      'Setup terminé — ' + Object.keys(SCHEMA).length + ' onglets prêts.', 'Enthalpie', 5);
}

/** Pré-remplit objectifs (cibles figées du skill) et parametres si vides. */
function seedDefaults_() {
  var obj = readTable_('objectifs');
  if (obj.length === 0) {
    // Cibles issues de skill-nutrition/SKILL.md :
    //  - protéines 110 g/j (1,7 g/kg)  - calories 2850 kcal/j (point de départ, à calibrer)
    //  - fibres 30 g/j (fenêtre 25–35 g)
    appendRow_('objectifs', {
      kcal_jour: 2850, prot_g_jour: 110, fibres_g_jour: FIBRES_DEFAUT.cible,
      tol_kcal: 200, tol_prot: 10, tol_fibres: FIBRES_DEFAUT.tolerance,
      mode_strict_gluten: 'off', mode_strict_lactose: 'off'
    });
  }
  var par = readTable_('parametres');
  if (par.length === 0) {
    var defaults = {
      token: 'CHANGE_ME_' + Utilities.getUuid().slice(0, 8),
      jour_courses: 'samedi',
      horizon_jours: '7',
      marge_jours: '2',
      magasins_ordre: 'A,B,Naturenville,Naturalia',
      tz: 'Europe/Paris'
    };
    Object.keys(defaults).forEach(function (k) {
      appendRow_('parametres', { cle: k, valeur: defaults[k] });
    });
  }
}

/* ===================================================================== */
/* 3. HELPERS D'ACCÈS AU SHEET                                            */
/* ===================================================================== */

function sheet_(name) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) throw new Error('Onglet manquant : ' + name + ' (lancer setup()).');
  return sh;
}

/* ---- Mémo par exécution (2026-08-13) ------------------------------------
 * Chaque `getDataRange().getValues()` est un aller-retour vers le Sheet, et un
 * même onglet était relu quatre à cinq fois dans une seule requête : `params_()`
 * dans `checkToken_` puis dans `getState_`, `plats` deux fois dans `getState_`,
 * `produits` une fois par plat dans `macrosOf_`… Un `commit` totalisait une
 * quinzaine de lectures pour six onglets distincts. C'était une part majeure du
 * temps de réponse ressenti (mesuré le 2026-08-13 : le plancher Apps Script est
 * de ~1,8 s, chaque lecture ajoutait par-dessus).
 *
 * Le mémo est valable pour UNE exécution : il est vidé en tête de `handle_`, et
 * toute écriture invalide l'onglet touché (`oublierOnglet_`). Il ne peut donc pas
 * servir de données périmées — le contexte V8 d'Apps Script ne survit pas à la
 * requête de toute façon.
 */
var _memo = {};
function oublierTout_() { _memo = {}; }

/** Lit un onglet en tableau d'objets {header: valeur}. Mémoïsé (cf. `oublier_`). */
function readTable_(name) {
  if (_memo[name]) return _memo[name];
  var sh = sheet_(name);
  var values = sh.getDataRange().getValues();
  if (values.length < 2) { _memo[name] = []; return _memo[name]; }
  var headers = values[0];
  _memo[name] = values.slice(1)
    .filter(function (row) { return row.join('') !== ''; })
    .map(function (row) {
      var o = {};
      headers.forEach(function (h, i) { o[h] = row[i]; });
      o._row = null; // rempli au besoin par les fonctions qui écrivent
      return o;
    });
  return _memo[name];
}

/**
 * Lit la FIN d'un onglet append-only, en remontant par blocs jusqu'à dépasser
 * `depuisMs`. Même sortie que `readTable_`, sans en payer le prix.
 *
 * Pourquoi (2026-08-13) : `getState_` lisait deux fois l'intégralité de l'onglet
 * `log` — tout l'historique — alors qu'il ne lui faut que la journée en cours.
 * Le coût grandissait donc à chaque repas saisi, définitivement. `log` et `ops`
 * ne s'écrivent que par ajout en fin (la seule suppression, `annulerExterieur_`,
 * retire une ligne sans déranger l'ordre) : lire la queue suffit et borne le
 * coût pour de bon.
 *
 * `depuisMs = null` relit tout (migrations, statistiques longues).
 */
var BLOC_QUEUE = 500;
function readTail_(name, colTemps, depuisMs) {
  if (depuisMs == null) return readTable_(name);
  var cle = name + '@' + depuisMs;
  if (_memo[cle]) return _memo[cle];

  var sh = sheet_(name);
  var last = sh.getLastRow();
  var largeur = Math.max(1, sh.getLastColumn());
  if (last < 2) { _memo[cle] = []; return _memo[cle]; }

  var headers = sh.getRange(1, 1, 1, largeur).getValues()[0];
  var iTemps = headers.indexOf(colTemps);
  var lignes = [];
  var fin = last;
  while (fin >= 2) {
    var debut = Math.max(2, fin - BLOC_QUEUE + 1);
    var bloc = sh.getRange(debut, 1, fin - debut + 1, largeur).getValues();
    lignes = bloc.concat(lignes);
    // La plus ancienne du bloc est déjà avant la coupure → inutile de remonter.
    // Un horodatage illisible donne NaN, dont toute comparaison est fausse : on
    // s'arrête, ce qui est le bon réflexe (on ne sait plus dater, on ne remonte
    // pas à l'aveugle sur tout l'historique).
    if (iTemps === -1 || !(tsOf_(bloc[0][iTemps]) >= depuisMs)) break;
    fin = debut - 1;
  }

  _memo[cle] = lignes
    .filter(function (row) { return row.join('') !== ''; })
    .map(function (row) {
      var o = {};
      headers.forEach(function (h, i) { o[h] = row[i]; });
      o._row = null;
      return o;
    });
  return _memo[cle];
}

/** Lignes de `log` depuis `depuisMs` (null = tout l'historique). */
function readLog_(depuisMs) { return readTail_('log', 'timestamp', depuisMs); }

/**
 * Coupure des lectures « du jour », en millisecondes.
 *
 * Volontairement LARGE : minuit moins 26 heures. La date du jour est calculée
 * dans le fuseau du paramètre `tz`, alors que `new Date(a, m, j)` construit son
 * minuit dans celui du script — les deux coïncident aujourd'hui (Europe/Paris
 * des deux côtés) mais rien ne le garantit, et un décalage ferait disparaître
 * les apports du matin. Les appelants refiltrent tous sur la date exacte
 * (`formatTs_(…) !== today`) : lire un jour de trop ne coûte qu'une poignée de
 * lignes, en rater une coûte un repas.
 */
function debutDuJour_(tz) {
  var iso = Utilities.formatDate(new Date(), tz || 'Europe/Paris', 'yyyy-MM-dd');
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;                    // date illisible → lecture complète
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() - 26 * 3600000;
}

/** Ajoute une ligne depuis un objet, dans l'ordre des en-têtes. */
function appendRow_(name, obj) {
  var sh = sheet_(name);
  var headers = SCHEMA[name];
  sh.appendRow(headers.map(function (h) {
    return obj[h] === undefined ? '' : obj[h];
  }));
  oublierOnglet_(name);
}

/**
 * Invalide le mémo d'un onglet qu'on vient d'écrire — y compris ses lectures de
 * queue, dont la clé porte une coupure (`log@1755…`). Sans ça, le `getState_`
 * qui suit une écriture repartirait des lignes lues AVANT elle, et la réponse
 * renverrait un état qui ignore ce qu'on vient d'enregistrer.
 */
function oublierOnglet_(name) {
  Object.keys(_memo).forEach(function (k) {
    if (k === name || k.indexOf(name + '@') === 0) delete _memo[k];
  });
}

/**
 * Ajoute PLUSIEURS lignes en une seule écriture. Valider huit aliments faisait
 * huit `appendRow_` (donc huit allers-retours vers le Sheet, ~200 ms pièce) :
 * c'est une bonne part de la lenteur ressentie à la validation.
 */
function appendRows_(name, objs) {
  if (!objs || !objs.length) return;
  var sh = sheet_(name);
  var headers = SCHEMA[name];
  var lignes = objs.map(function (obj) {
    return headers.map(function (h) { return obj[h] === undefined ? '' : obj[h]; });
  });
  sh.getRange(sh.getLastRow() + 1, 1, lignes.length, headers.length).setValues(lignes);
  oublierOnglet_(name);
}

/**
 * Crée un onglet manquant avec ses en-têtes, sans exiger un `setup()` manuel.
 * Même parade que `assurerCibleFibres_` : une migration ne doit jamais dépendre
 * d'un geste dans l'éditeur Apps Script — on l'oublie, et la panne est muette.
 */
function assurerOnglet_(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, SCHEMA[name].length).setValues([SCHEMA[name]]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

/** Renvoie {cle: valeur} de l'onglet parametres. */
function params_() {
  var out = {};
  readTable_('parametres').forEach(function (r) { out[String(r.cle)] = r.valeur; });
  return out;
}

// Cible fibres du skill nutrition §6, utilisée à deux endroits : le pré-remplissage
// d'un Sheet neuf (seedDefaults_) et le rattrapage d'un Sheet déjà rempli
// (assurerCibleFibres_). Une seule définition pour que les deux ne divergent pas.
var FIBRES_DEFAUT = { cible: 30, tolerance: 5 };

// Catégories de rangement (choix d'Azur du 2026-08-11 : « où est-ce rangé »,
// et non « qu'est-ce que ça apporte » — on cherche un aliment là où il est).
// Un produit n'en porte qu'UNE ; vide = pas encore rangé, la PWA le signale.
// Liste FERMÉE : la PWA affiche une pastille par valeur, une valeur inconnue
// arrivée par le Sheet retomberait dans « non rangé ».
var CATEGORIES = ['frigo', 'congelo', 'placard', 'fruits_legumes', 'epices'];

/** Normalise une catégorie : hors liste ou vide → '' (non rangé). */
function normCategorie_(v) {
  var s = String(v == null ? '' : v).trim().toLowerCase();
  return CATEGORIES.indexOf(s) === -1 ? '' : s;
}

// La colonne `categorie` n'existe pas sur un Sheet créé avant le 2026-08-11 :
// `readTable_` renverrait `undefined` et l'écriture d'un rangement irait dans
// le vide. Même parade que `assurerCibleFibres_` — l'en-tête est complété à la
// première lecture du catalogue, sans aucun geste manuel (ni `setup()`).
var _colonnesProduitsVerifiees = false;
function assurerColonnesProduits_() {
  if (_colonnesProduitsVerifiees) return;
  _colonnesProduitsVerifiees = true;
  try {
    var sh = sheet_('produits');
    var largeur = SCHEMA.produits.length;
    var entetes = sh.getRange(1, 1, 1, largeur).getValues()[0];
    if (entetes.join('') !== SCHEMA.produits.join('')) {
      sh.getRange(1, 1, 1, largeur).setValues([SCHEMA.produits]).setFontWeight('bold');
      oublierOnglet_('produits');       // les en-têtes ont changé : le mémo est faux
    }
  } catch (e) {
    Logger.log('assurerColonnesProduits_ : ' + e);
  }
}

/** Objet objectifs (première ligne). */
function objectifs_() {
  assurerCibleFibres_();
  var rows = readTable_('objectifs');
  return rows[0] || {};
}

var _cibleFibresVerifiee = false;

/**
 * Rattrapage automatique de la cible fibres (2026-08-09), au plus une fois par
 * exécution.
 *
 * Pourquoi ça ne peut pas passer par setup() : `seedDefaults_` ne s'exécute que
 * si l'onglet est VIDE, et `setup()` ne réécrit que la ligne d'en-tête. Sur un
 * Sheet en service, les deux nouvelles cellules resteraient donc vides — la
 * cible vaudrait 0, `gauge_` renverrait `ratio: null` et la PWA afficherait la
 * jauge en mode « informatif ». Panne parfaitement silencieuse, sans la moindre
 * erreur : c'est exactement le genre de piège qu'on ne veut pas laisser
 * dépendre d'un geste manuel.
 *
 * N'écrase jamais une valeur existante : si la cible a été ajustée à la main
 * dans le Sheet, elle est conservée.
 */
function assurerCibleFibres_() {
  if (_cibleFibresVerifiee) return;
  _cibleFibresVerifiee = true;
  try {
    var sh = sheet_('objectifs');
    var largeur = SCHEMA.objectifs.length;
    var entetes = sh.getRange(1, 1, 1, largeur).getValues()[0];
    if (entetes.join('') !== SCHEMA.objectifs.join('')) {
      sh.getRange(1, 1, 1, largeur).setValues([SCHEMA.objectifs]).setFontWeight('bold');
    }
    if (sh.getLastRow() < 2) return;          // onglet sans données : seedDefaults_ s'en charge
    var cF = SCHEMA.objectifs.indexOf('fibres_g_jour') + 1;
    var cT = SCHEMA.objectifs.indexOf('tol_fibres') + 1;
    if (!sh.getRange(2, cF).getValue()) sh.getRange(2, cF).setValue(FIBRES_DEFAUT.cible);
    if (!sh.getRange(2, cT).getValue()) sh.getRange(2, cT).setValue(FIBRES_DEFAUT.tolerance);
    oublierOnglet_('objectifs');
  } catch (e) {
    // Une lecture ne doit jamais échouer à cause d'une migration : au pire la
    // jauge reste « informative », ce qui est le comportement d'avant.
    Logger.log('assurerCibleFibres_ : ' + e);
  }
}

/* ===================================================================== */
/* 4. ROUTAGE HTTP                                                        */
/* ===================================================================== */

function doGet(e) {
  return handle_(e, (e && e.parameter) || {});
}

function doPost(e) {
  var body = {};
  try {
    if (e && e.postData && e.postData.contents) body = JSON.parse(e.postData.contents);
  } catch (err) { /* corps non-JSON → traité comme vide */ }
  // Fusionne query params (pour token) et corps JSON
  var merged = {};
  if (e && e.parameter) Object.keys(e.parameter).forEach(function (k) { merged[k] = e.parameter[k]; });
  Object.keys(body).forEach(function (k) { merged[k] = body[k]; });
  return handle_(e, merged);
}

// Les actions qui MODIFIENT le Sheet. Elles passent toutes par `ecrire_` :
// verrou global + déduplication par `op_id`. Aucune ne doit être ajoutée
// ailleurs — c'est la seule garantie que deux écritures ne se croisent pas.
var ACTIONS_ECRITURE = {
  log: 1, commit: 1, add_produit: 1, set_categorie: 1, annuler_exterieur: 1
};

function handle_(e, p) {
  var action = (p && p.action) || 'state';
  oublierTout_();                       // le mémo ne vaut que pour CETTE requête
  try {
    checkToken_(p.token);
    var result = ACTIONS_ECRITURE[action] ? ecrire_(action, p) : lire_(action, p);
    return json_({ ok: true, action: action, data: result });
  } catch (err) {
    // `transient` distingue « réessaie plus tard » (verrou occupé, quota) d'un
    // refus définitif (ref inconnue, token invalide). Sans ce drapeau, la PWA
    // abandonne une action récupérable ou, pire, garde en file une action que
    // le serveur refusera toujours.
    return json_({
      ok: false,
      error: String(err && err.message || err),
      transient: !!(err && err.transient)
    });
  }
}

function lire_(action, p) {
  switch (action) {
    // Démarrage en UN aller-retour. Deux GET séparés, c'était deux exécutions
    // Apps Script (~1,5 s pièce) pour des données lues dans les mêmes onglets.
    case 'boot':           return boot_();
    case 'state':          return getState_();
    case 'catalog':        return getCatalog_();
    case 'courses':        return getCourses_();
    case 'cuisine':        return getCuisine_();
    case 'bilan':          return getBilan_();
    case 'search_catalog': return searchCatalog_(p.q);
    default: throw new Error('Action inconnue : ' + action);
  }
}

/* ---- Cache du payload de démarrage (2026-08-13) -------------------------
 *
 * `boot` est de loin l'appel le plus fréquent, et le seul dont le contenu ne
 * change QUE sur écriture. Le servir depuis `CacheService` évite de relire six
 * onglets pour recomposer un objet identique — c'est ce qui ramène l'appel au
 * plancher d'Apps Script (~1,8 s mesurés le 2026-08-13, redirection comprise).
 *
 * La clé porte un NUMÉRO DE VERSION, bumpé par chaque écriture, et non un simple
 * effacement. La différence est ce qui rend le cache sûr : une lecture partie
 * avant une écriture, et qui reviendrait la déposer en cache après elle, écrit
 * sous l'ANCIENNE clé — elle ne peut donc pas ressusciter un état périmé. Un
 * effacement, lui, laissait cette course ouverte pendant toute la durée du TTL.
 *
 * La date est dans la clé aussi : à minuit, les jauges repartent à zéro sans
 * qu'aucune écriture n'ait eu lieu.
 */
var CACHE_BOOT_S = 240;
var CACHE_BOOT_MAX = 95000;             // CacheService plafonne une valeur à 100 ko

function versionDonnees_() {
  try { return PropertiesService.getScriptProperties().getProperty('data_version') || '0'; }
  catch (e) { return null; }            // Properties indisponible → on saute le cache
}
function bumperVersionDonnees_() {
  try { PropertiesService.getScriptProperties().setProperty('data_version', String(Date.now())); }
  catch (e) { /* au pire le cache expire tout seul au bout de CACHE_BOOT_S */ }
}

function boot_() {
  var tz = params_().tz || 'Europe/Paris';
  var v = versionDonnees_();
  var cle = v == null ? null
    : 'boot:' + v + ':' + Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');

  if (cle) {
    try {
      var brut = CacheService.getScriptCache().get(cle);
      if (brut) return JSON.parse(brut);
    } catch (e) { /* cache illisible : on recalcule, c'est tout */ }
  }

  var data = { state: getState_(), catalog: getCatalog_() };
  if (cle) {
    try {
      var s = JSON.stringify(data);
      // Un catalogue volumineux dépasserait le plafond : `put` lèverait, et on
      // paierait l'exception à chaque appel pour rien.
      if (s.length <= CACHE_BOOT_MAX) CacheService.getScriptCache().put(cle, s, CACHE_BOOT_S);
    } catch (e) { /* pas de cache cette fois-ci */ }
  }
  return data;
}

/**
 * Toute écriture, sous verrou et dédupliquée.
 *
 * Deux garanties, et c'est le correctif du bug de synchro du 2026-08-13 :
 *  1. **Sérialisation** — `adjustStock_` lit le stock puis le réécrit. Deux
 *     requêtes concurrentes lisaient la même valeur et la seconde écrasait la
 *     première : un décrément disparaissait, le stock restait haut, et l'app
 *     semblait « avoir rajouté des trucs ».
 *  2. **Idempotence** — Apps Script répond en 1 à 3 s derrière une redirection ;
 *     sur un réseau mobile, la réponse se perd alors que l'écriture a eu lieu.
 *     La PWA rejouait alors son action et comptait deux fois. Un `op_id` déjà vu
 *     n'est plus jamais réappliqué.
 */
function ecrire_(action, p) {
  var opId = trim_((p && p.op_id) || '');
  var lock = LockService.getScriptLock();
  try {
    // 12 s (et non 25) depuis le 2026-08-13 : la PWA double désormais une
    // requête restée sans réponse, et le doublon d'une écriture arrive avec le
    // MÊME `op_id`. S'il campait 25 s sur le verrou, il tiendrait la file
    // ouverte bien après que l'original a fini. Rendre la main vite, en
    // `transient`, laisse la PWA réessayer sur un serveur libre.
    if (!lock.tryLock(12000)) {
      var occupe = new Error('Serveur occupé (écriture concurrente). Réessaie.');
      occupe.transient = true;
      throw occupe;
    }
  } catch (err) {
    if (err && err.transient) throw err;
    var indispo = new Error('Verrou indisponible : ' + (err && err.message || err));
    indispo.transient = true;
    throw indispo;
  }

  try {
    if (opId) {
      var vue = opVue_(opId);
      // Déjà appliquée : on renvoie une réponse VALIDE (pas une erreur), sinon
      // la PWA croirait l'action perdue et la remettrait en file indéfiniment.
      if (vue) return rejeu_(action, vue);
    }
    var res;
    switch (action) {
      case 'log':           res = postLog_(p); break;
      case 'commit':        res = commit_(p); break;
      case 'add_produit':   res = addProduit_(p); break;
      case 'set_categorie': res = setCategorie_(p); break;
      case 'annuler_exterieur': res = annulerExterieur_(p); break;
      default: throw new Error('Action inconnue : ' + action);
    }
    // L'état frais voyage avec TOUTE réponse d'écriture (2026-08-13). `commit`
    // le faisait déjà ; les autres non, et la PWA enchaînait donc un `boot`
    // complet derrière chaque geste — scanner un produit acheté, dire « pot
    // fini », ranger, cuisiner : deux exécutions Apps Script au lieu d'une, soit
    // ~4 s d'attente inutile à chaque fois. Le calcul est quasi gratuit ici :
    // les onglets sont déjà en mémo, l'écriture vient de les invalider.
    if (res && typeof res === 'object' && !Array.isArray(res)) {
      if (!res.state) res.state = getState_();
      // Le catalogue n'est renvoyé que quand il a pu changer : c'est le plus
      // gros des deux payloads, inutile de l'imposer à un simple log de repas.
      if ((action === 'add_produit' || action === 'set_categorie') && !res.catalog) {
        res.catalog = getCatalog_();
      }
    }
    if (opId) enregistrerOp_(opId, action, res);
    bumperVersionDonnees_();            // le `boot` en cache ne vaut plus rien
    return res;
  } finally {
    lock.releaseLock();
  }
}

/* ---- Idempotence : journal des op_id déjà appliqués ---- */

/**
 * Ligne de l'onglet `ops` pour cet op_id, ou null.
 *
 * Ne lit que la QUEUE de l'onglet (2026-08-13) : le scan intégral se payait à
 * chaque écriture et grandissait sans fin. Une file offline ne se rejoue jamais
 * au-delà de quelques jours, et `purgerOps_` borne déjà l'onglet à 30 jours :
 * les dernières lignes suffisent largement à reconnaître un doublon.
 */
var OPS_QUEUE = 800;
function opVue_(opId) {
  var sh = assurerOnglet_('ops');
  var last = sh.getLastRow();
  if (last < 2) return null;
  var debut = Math.max(2, last - OPS_QUEUE + 1);
  var vals = sh.getRange(debut, 1, last - debut + 1, 4).getValues();
  for (var r = vals.length - 1; r >= 0; r--) {          // du plus récent au plus ancien
    if (String(vals[r][0]) === String(opId)) {
      return { op_id: vals[r][0], timestamp: vals[r][1], action: vals[r][2], resume: vals[r][3] };
    }
  }
  return null;
}

/** Trace une écriture appliquée. `resume` reste court : c'est un accusé, pas une copie. */
function enregistrerOp_(opId, action, res) {
  assurerOnglet_('ops');
  var resume = '';
  try {
    // `state` et `catalog` voyagent avec toutes les réponses d'écriture depuis
    // le 2026-08-13 : les recopier ici remplirait les 400 caractères d'un état
    // tronqué au milieu, illisible au rejeu. On ne garde que l'accusé.
    var court = {};
    Object.keys(res || {}).forEach(function (k) {
      if (k !== 'state' && k !== 'catalog') court[k] = res[k];
    });
    resume = JSON.stringify(court).slice(0, 400);
  } catch (e) { resume = ''; }
  appendRow_('ops', { op_id: opId, timestamp: new Date(), action: action, resume: resume });
  purgerOps_();
}

// Une file offline ne se rejoue jamais au-delà de quelques jours : garder
// 30 jours d'op_id est large, et borne la lecture de l'onglet.
var OPS_RETENTION_JOURS = 30;
function purgerOps_() {
  try {
    var sh = sheet_('ops');
    var last = sh.getLastRow();
    if (last < 400) return;                             // rien à gagner avant
    var limite = Date.now() - OPS_RETENTION_JOURS * 86400000;
    // Seule la colonne des horodatages sert ici : lire les quatre colonnes de
    // tout l'onglet à chaque écriture était du poids mort sur le chemin critique.
    var ts = sh.getRange(2, 2, last - 1, 1).getValues();
    var garde = 0;                                      // nb de lignes à supprimer
    while (garde < ts.length && tsOf_(ts[garde][0]) < limite) garde++;
    if (garde > 0) { sh.deleteRows(2, garde); oublierOnglet_('ops'); }
  } catch (e) { Logger.log('purgerOps_ : ' + e); }
}

/**
 * Réponse à une action rejouée. Rien n'est réappliqué ; on renvoie l'accusé
 * d'origine, plus l'état frais pour les actions dont la PWA attend un état
 * (un `commit` rejoué doit repartir avec la vérité du serveur, pas dans le vide).
 */
function rejeu_(action, vue) {
  var out = { deja_traite: true, op_id: vue.op_id, applique_le: vue.timestamp };
  try { if (vue.resume) out.resume = JSON.parse(vue.resume); } catch (e) { /* résumé tronqué */ }
  // Toujours l'état frais, pour TOUTE action rejouée : la PWA se recale dessus
  // sans redemander un `boot` derrière. C'est d'autant plus vrai depuis qu'elle
  // double une requête lente — le doublon est un rejeu, et il doit rapporter
  // exactement ce que l'original a rapporté.
  out.state = getState_();
  if (action === 'add_produit' || action === 'set_categorie') out.catalog = getCatalog_();
  return out;
}

function checkToken_(token) {
  var expected = params_().token;
  if (!expected) throw new Error('Token non configuré (lancer setup()).');
  if (String(token) !== String(expected)) throw new Error('Token invalide.');
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ===================================================================== */
/* 5. LECTURES (GET)                                                      */
/* ===================================================================== */

/** État du jour : jauges (prot/kcal consommés vs cibles), pools par créneau, stock. */
function getState_() {
  var tz = params_().tz || 'Europe/Paris';
  var today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');

  var platsById = indexBy_(readTable_('plats'), 'id');
  var produitsById = indexBy_(readTable_('produits'), 'id');
  var stock = stockMap_();

  // Consommation du jour à partir du log (plats ET produits bruts loggués au curseur).
  // Seule la journée est lue : relire tout l'historique deux fois par `getState_`
  // coûtait de plus en plus cher à chaque repas saisi (2026-08-13).
  var depuis = debutDuJour_(tz);
  var conso = { kcal: 0, prot_g: 0, fibres_g: 0 };
  readLog_(depuis).forEach(function (l) {
    if (formatTs_(l.timestamp, tz) !== today) return;
    // Les macros de plats/produits sont POUR 100 g et la quantité loguée est en
    // grammes → facteur q/100. Le repas extérieur, lui, porte des macros
    // absolues saisies à la main : pas de mise à l'échelle.
    var m = null; var f = 0;
    if (l.type === 'plat') { m = macrosOf_(l.ref, platsById); f = (Number(l.quantite) || 0) / 100; }
    else if (l.type === 'produit') { m = macrosProduit_(l.ref, produitsById); f = (Number(l.quantite) || 0) / 100; }
    else if (l.type === 'exterieur') { m = parseExtra_(l.extra); f = 1; }
    else return;
    conso.kcal += m.kcal * f; conso.prot_g += m.prot_g * f;
    // `|| 0` assumé : un aliment sans donnée de fibres ne compte pas. C'est le
    // sous-comptage documenté au skill nutrition §6 — la jauge fibres minore
    // toujours, elle ne majore jamais.
    conso.fibres_g += (m.fibres_g || 0) * f;
  });

  var obj = objectifs_();
  var jauges = {
    prot_g:   gauge_(conso.prot_g, obj.prot_g_jour),
    kcal:     gauge_(conso.kcal, obj.kcal_jour),
    fibres_g: gauge_(conso.fibres_g, obj.fibres_g_jour)
  };

  // Pools par créneau : plats actifs, marqués faisables ou non selon le stock.
  // `readTable_` est mémoïsé : c'est la même lecture que `platsById` plus haut.
  var pools = {};
  CRENEAUX.forEach(function (c) { pools[c] = []; });
  readTable_('plats').forEach(function (pl) {
    if (String(pl.actif).toLowerCase() === 'non' || pl.actif === false) return;
    var creneaux = String(pl.creneau).split(/[;,]/).map(trim_);
    var faisable = platFaisable_(pl, stock);
    creneaux.forEach(function (c) {
      if (pools[c]) pools[c].push({
        id: pl.id, nom: pl.nom, type: pl.type,
        macros: macrosOf_(pl.id, platsById), faisable: faisable
      });
    });
  });

  return {
    date: today,
    creneau_courant: creneauCourant_(tz),
    jauges: jauges,
    pools: pools,
    stock: stock,
    journal: journalDuJour_(tz, today, platsById, produitsById, depuis)
  };
}

/**
 * Ce qui a été mangé aujourd'hui, tel que la PWA le relit sous les jauges
 * (2026-08-13). Deux règles :
 *
 *  1. **Agrégé par aliment**, pas par ligne de log. Faire avancer le curseur du
 *     riz trois fois dans la journée produit trois lignes ; ce qu'on relit et
 *     ce qu'on corrige, c'est le cumul — c'est d'ailleurs ce que le curseur
 *     lui-même affiche. Les corrections déjà passées (quantités négatives) sont
 *     dans la somme, donc un aliment ramené à zéro disparaît de la liste.
 *  2. **Un repas extérieur reste une entrée à part entière** : deux restos dans
 *     la journée sont deux repas, pas « 2 × repas extérieur ». Son `rang` est sa
 *     position parmi les extérieurs DU JOUR — l'identifiant qui permet d'en
 *     retirer un seul (les lignes de log n'ont pas d'id, et les nouvelles
 *     s'ajoutent toujours après, donc le rang d'une entrée affichée ne bouge pas).
 */
function journalDuJour_(tz, today, platsById, produitsById, depuis) {
  var parRef = {};
  var ordre = [];
  var sorties = [];
  var rangExt = 0;

  // Même coupure que `getState_` : la lecture est mémoïsée, les deux parcours
  // ne coûtent donc qu'un seul aller-retour vers le Sheet.
  readLog_(depuis === undefined ? debutDuJour_(tz) : depuis).forEach(function (l) {
    if (formatTs_(l.timestamp, tz) !== today) return;

    if (l.type === 'exterieur') {
      var m = parseExtra_(l.extra);
      var preset = platsById[l.ref];
      sorties.push({
        id: 'ext:' + rangExt, type: 'exterieur', rang: rangExt,
        ref: l.ref || '', nom: (preset && preset.nom) || 'Repas extérieur',
        grammes: 0, paquet_g: 0,
        kcal: round1_(m.kcal), prot_g: round1_(m.prot_g), fibres_g: round1_(m.fibres_g)
      });
      rangExt++;
      return;
    }
    // `ajustement` est un mouvement de stock sans repas derrière (correction
    // d'une saisie d'un autre jour) : il n'a rien à faire dans « ce que j'ai
    // mangé aujourd'hui ».
    if (l.type !== 'plat' && l.type !== 'produit') return;

    var ref = String(l.ref);
    var cle = l.type + ':' + ref;
    if (!parRef[cle]) {
      var src = l.type === 'plat' ? platsById[ref] : produitsById[ref];
      if (!src) return;                       // référence disparue du catalogue
      parRef[cle] = {
        id: cle, type: l.type, rang: -1, ref: ref,
        nom: src.nom || ref, grammes: 0,
        paquet_g: l.type === 'plat'
          ? Math.round(poidsFournee_(src))     // la fournée tient lieu de paquet
          : (Number(src.poids_paquet_g) || 0),
        kcal: 0, prot_g: 0, fibres_g: 0
      };
      ordre.push(cle);
    }
    parRef[cle].grammes += (Number(l.quantite) || 0);
  });

  ordre.forEach(function (cle) {
    var e = parRef[cle];
    var g = round2_(e.grammes);
    if (!(g > 0.01)) return;                  // entièrement corrigé → plus rien à montrer
    var m = e.type === 'plat' ? macrosOf_(e.ref, platsById) : macrosProduit_(e.ref, produitsById);
    var f = g / 100;                          // macros pour 100 g (règle du gramme)
    e.grammes = g;
    e.kcal = round1_(m.kcal * f);
    e.prot_g = round1_(m.prot_g * f);
    e.fibres_g = round1_((m.fibres_g || 0) * f);
    sorties.push(e);
  });

  return sorties;
}

function getCatalog_() {
  assurerColonnesProduits_();
  // Un plat cuisiné n'a pas d'emballage : son « paquet » est la fournée. Le
  // front en a besoin comme référence du curseur (% de la fournée mangé), et
  // ce poids n'est pas une colonne — il se déduit de la composition.
  var produits = readTable_('produits').filter(actif_);
  var produitsById = indexBy_(produits, 'id');
  var plats = readTable_('plats').filter(actif_).map(function (pl) {
    pl.poids_fournee_g = Math.round(poidsFournee_(pl));
    // L'onglet `plats` n'a pas de colonnes d'allergènes : les badges G/L d'un
    // plat cuisiné se déduisent de sa composition (2026-08-13). Un ingrédient
    // au flag vide (« on ne sait pas ») ne rend pas le plat positif — l'app ne
    // décrète jamais la présence d'un allergène qu'elle n'a pas lue.
    var f = flagsComposition_(pl, produitsById);
    pl.flag_gluten = f.gluten;
    pl.flag_lactose = f.lactose;
    return pl;
  });
  return { produits: produits, plats: plats };
}

/** Recherche catalogue (tuile « ➕ autre » / scan) : produits actifs par nom ou EAN. */
function searchCatalog_(q) {
  var query = trim_(q || '').toLowerCase();
  var res = readTable_('produits').filter(actif_).filter(function (pr) {
    if (!query) return true;
    return String(pr.nom).toLowerCase().indexOf(query) !== -1 ||
           String(pr.ean).indexOf(query) !== -1;
  }).slice(0, 20).map(publicProduit_);
  return { produits: res };
}

/* ===================================================================== */
/* 6. LISTE DE COURSES (SPEC §6)                                          */
/* ===================================================================== */

/**
 * besoin(produit) = consommation_prévue(horizon) − stock, arrondi à l'unité de vente.
 * consommation_prévue dérive du rythme observé sur le log (14 jours glissants).
 * Regroupée par magasin (ordre paramétré) puis nom.
 */
function getCourses_() {
  var par = params_();
  var horizon = Number(par.horizon_jours || 7) + Number(par.marge_jours || 0);
  var ordre = String(par.magasins_ordre || '').split(',').map(trim_);

  var produits = readTable_('produits').filter(actif_);
  var produitsById = indexBy_(produits, 'id');
  var platsById = indexBy_(readTable_('plats'), 'id');
  var stock = stockMap_();

  // Rythme : grammes consommés par produit sur 14 j → par jour
  var perDay = consoParProduitParJour_(platsById, produitsById, 14);

  var lignes = [];
  produits.forEach(function (pr) {
    var besoinG = (perDay[pr.id] || 0) * horizon;
    var enStock = Number(stock[pr.id] || 0);
    var manque = besoinG - enStock;
    if (manque <= 0) return;
    var paquet = Number(pr.poids_paquet_g) || 0;
    // Sans poids de paquet connu, on ne peut pas convertir en nombre d'articles
    // à acheter : on affiche 1 et le manque en grammes reste l'information sûre.
    var unites = paquet > 0 ? Math.ceil(manque / paquet) : 1;
    lignes.push({
      produit_id: pr.id, nom: pr.nom, magasin: magasinOf_(pr.marque_magasin),
      unites: unites,
      poids_paquet_g: paquet,
      grammes_manquants: Math.round(manque)
    });
  });

  // Tri par ordre de magasin puis nom
  lignes.sort(function (a, b) {
    var ia = ordre.indexOf(a.magasin), ib = ordre.indexOf(b.magasin);
    if (ia === -1) ia = 99; if (ib === -1) ib = 99;
    return ia - ib || String(a.nom).localeCompare(b.nom);
  });

  // Groupé par magasin pour l'affichage
  var groupes = {};
  lignes.forEach(function (l) { (groupes[l.magasin] = groupes[l.magasin] || []).push(l); });
  return { horizon_jours: horizon, groupes: groupes, lignes: lignes };
}

/* ===================================================================== */
/* 6bis. CUISINE + BILAN (SPEC §4.3-4.4, §7)                             */
/* ===================================================================== */

/**
 * Écran Cuisine : recette de la semaine (badge nouveau / batch classique) +
 * bibliothèque des recettes batch (« je l'ai cuisinée » = POST batch_cuisine,
 * qui transforme les ingrédients en poids de fournée dans le stock).
 */
function getCuisine_() {
  var tz = params_().tz || 'Europe/Paris';
  var platsById = indexBy_(readTable_('plats'), 'id');
  var stock = stockMap_();

  var biblio = readTable_('recettes').map(function (rec) {
    var pl = platsById[rec.plat_id] || {};
    var jamais = !rec.derniere_realisation || String(rec.derniere_realisation).trim() === '';
    return {
      recette_id: rec.id,
      plat_id: rec.plat_id,
      nom: pl.nom || String(rec.plat_id),
      type: pl.type || 'batch',
      macros: macrosOf_(rec.plat_id, platsById),
      // Poids de la fournée : colonne si renseignée, sinon somme des ingrédients.
      poids_produit_g: Math.round(Number(rec.poids_produit_g) || poidsFournee_(pl)),
      instructions: String(rec.instructions || ''),
      stock_g: Math.round(Number(stock[rec.plat_id] || 0)),
      derniere_realisation: jamais ? '' : formatTs_(rec.derniere_realisation, tz),
      jamais_cuisinee: jamais
    };
  });

  // Recette de la semaine : override paramétré (posé par la routine hebdo §9) sinon
  // repli déterministe = recette cuisinée il y a le plus longtemps (jamais → priorité).
  var override = trim_(params_().recette_semaine || '');
  var vedette = null;
  if (override) {
    biblio.forEach(function (r) { if (!vedette && (r.recette_id === override || r.plat_id === override)) vedette = r; });
  }
  if (!vedette && biblio.length) {
    vedette = biblio.slice().sort(function (a, b) {
      if (a.jamais_cuisinee !== b.jamais_cuisinee) return a.jamais_cuisinee ? -1 : 1;
      return String(a.derniere_realisation).localeCompare(String(b.derniere_realisation));
    })[0];
  }
  var recetteSemaine = vedette ? {
    recette_id: vedette.recette_id, plat_id: vedette.plat_id, nom: vedette.nom,
    macros: vedette.macros, poids_produit_g: vedette.poids_produit_g,
    instructions: vedette.instructions, stock_g: vedette.stock_g,
    nouveau: vedette.jamais_cuisinee, derniere_realisation: vedette.derniere_realisation
  } : null;

  return {
    recette_semaine: recetteSemaine,
    bibliotheque: biblio
  };
}

/**
 * Bilan prot/kcal vs cibles (SPEC §4.4), servi aux deux échelles que propose
 * l'écran : `jours` (les 7 derniers jours, un point par jour) et `semaines`
 * (4 semaines glissantes, moyenne journalière). Les deux se lisent contre les
 * mêmes cibles — une cible est journalière, la moyenne hebdo ne la change pas.
 */
function getBilan_() {
  var tz = params_().tz || 'Europe/Paris';
  var parJour = intakeParJour_(tz);              // un seul balayage du journal
  var bilan = moyennesHebdo_(tz, 4, parJour);
  bilan.jours = joursRecents_(tz, 7, parJour);
  return bilan;
}

// Le Bilan regarde 4 semaines révolues + les 7 derniers jours : 45 jours de
// journal couvrent tout, avec de la marge pour les semaines partielles. Au-delà,
// c'est de l'historique que personne ne consulte, et le relire à chaque ouverture
// de l'écran alourdissait la réponse sans rien changer à l'affichage.
var BILAN_JOURS = 45;

/** Apports journaliers reconstruits du journal : plats (médian inclus) + produits bruts. */
function intakeParJour_(tz) {
  var platsById = indexBy_(readTable_('plats'), 'id');
  var produitsById = indexBy_(readTable_('produits'), 'id');
  var parJour = {};
  readLog_(Date.now() - BILAN_JOURS * 86400000).forEach(function (l) {
    // Même mise à l'échelle que getState_ : macros pour 100 g × grammes/100,
    // sauf le repas extérieur dont les macros sont absolues.
    var m = null; var f = 0;
    if (l.type === 'plat') { m = macrosOf_(l.ref, platsById); f = (Number(l.quantite) || 0) / 100; }
    else if (l.type === 'produit') { m = macrosProduit_(l.ref, produitsById); f = (Number(l.quantite) || 0) / 100; }
    else if (l.type === 'exterieur') { m = parseExtra_(l.extra); f = 1; }
    else return;
    var day = formatTs_(l.timestamp, tz);
    var b = parJour[day] || (parJour[day] = { kcal: 0, prot_g: 0, fibres_g: 0 });
    b.kcal += m.kcal * f; b.prot_g += m.prot_g * f;
    b.fibres_g += (m.fibres_g || 0) * f;      // même sous-comptage que getState_
  });
  return parJour;
}

/**
 * Moyennes journalières par semaine glissante (nb semaines de 7 j finissant
 * aujourd'hui), du plus ancien au plus récent, + cibles/tolérances + streak
 * protéines (nb de semaines RÉVOLUES consécutives dans la fenêtre prot).
 * `parJour` est optionnel (recalculé si absent) — getBilan_ le partage avec
 * joursRecents_ pour ne lire le journal qu'une fois.
 */
// Jours saisis (sur 7) en deçà desquels une semaine ne peut pas prétendre être
// « tenue ». 6 et non 7 : un oubli de saisie dans la semaine ne doit pas effacer
// un mois de régularité — mais le jour manquant compte pour 0 dans la moyenne,
// donc la tolérance ne rend jamais le compteur plus généreux qu'il ne doit.
var COUVERTURE_MINI = 6;

function moyennesHebdo_(tz, nb, parJour) {
  parJour = parJour || intakeParJour_(tz);
  var obj = objectifs_();
  var JOURS = 7;
  var today = midiDuJour_(tz);
  var semaines = [];
  for (var w = nb - 1; w >= 0; w--) {
    var fin = new Date(today.getTime() - w * JOURS * 86400000);
    var debut = new Date(fin.getTime() - (JOURS - 1) * 86400000);
    var somme = { kcal: 0, prot_g: 0, fibres_g: 0 };
    var joursEcoules = 0, joursAvecDonnees = 0;
    for (var d = 0; d < JOURS; d++) {
      var jour = new Date(debut.getTime() + d * 86400000);
      if (jour.getTime() > today.getTime()) break;   // futur (semaine courante partielle)
      joursEcoules++;
      var b = parJour[Utilities.formatDate(jour, tz, 'yyyy-MM-dd')];
      if (b) {
        somme.kcal += b.kcal; somme.prot_g += b.prot_g;
        somme.fibres_g += (b.fibres_g || 0);
        joursAvecDonnees++;
      }
    }
    var denom = joursEcoules || 1;
    semaines.push({
      debut: Utilities.formatDate(debut, tz, 'yyyy-MM-dd'),
      fin: Utilities.formatDate(fin, tz, 'yyyy-MM-dd'),
      label: w === 0 ? 'Cette sem.' : 'S-' + w,
      jours_ecoules: joursEcoules,
      jours_avec_donnees: joursAvecDonnees,
      // `revolue` : la fenêtre ne contient pas la journée en cours. Seules
      // celles-là peuvent entrer au streak (cf. plus bas) — et la PWA en a
      // besoin pour dire « il manque encore des jours » sans redériver les dates.
      revolue: w > 0,
      moyennes: {
        kcal: round1_(somme.kcal / denom),
        prot_g: round1_(somme.prot_g / denom),
        fibres_g: round1_(somme.fibres_g / denom)
      }
    });
  }

  var cibleProt = Number(obj.prot_g_jour) || 0;
  var tolProt = Number(obj.tol_prot) || 0;
  // Le streak reste sur les PROTÉINES seules (SPEC §7 : gamification minimale).
  // L'étendre aux fibres reviendrait à faire un compteur de régularité sur un
  // indicateur qui sous-compte structurellement — générateur de culpabilité
  // injustifiée (skill nutrition §6).
  //
  // Deux conditions ajoutées le 2026-08-13 — sans elles, le compteur annonçait
  // « 1 semaine tenue » à quelqu'un qui n'avait pas une seule semaine de suivi :
  //  1. La semaine doit être RÉVOLUE. Celle qui finit aujourd'hui contient une
  //     journée en cours, comptée pour ce qu'on en a saisi à cette heure-ci : sa
  //     moyenne monte au fil des repas, donc le compteur se serait allumé et
  //     éteint plusieurs fois par jour.
  //  2. Elle doit être COUVERTE — au moins COUVERTURE_MINI jours saisis sur 7.
  //     Une semaine dont deux jours copieux sont saisis et cinq laissés vides a
  //     beau afficher une moyenne flatteuse, elle ne dit rien de la régularité :
  //     c'est un trou de saisie, pas une semaine tenue.
  var streak = 0;
  if (cibleProt > 0) {
    for (var i = semaines.length - 1; i >= 0; i--) {
      var s = semaines[i];
      if (!s.revolue) continue;                       // la semaine en cours ne compte pas encore
      if (s.jours_avec_donnees >= COUVERTURE_MINI && s.moyennes.prot_g >= cibleProt - tolProt) streak++;
      else break;
    }
  }

  return {
    cibles: {
      kcal: Number(obj.kcal_jour) || 0,
      prot_g: cibleProt,
      fibres_g: Number(obj.fibres_g_jour) || 0
    },
    tolerances: {
      kcal: Number(obj.tol_kcal) || 0,
      prot_g: tolProt,
      fibres_g: Number(obj.tol_fibres) || 0
    },
    semaines: semaines,
    streak_prot: streak,
    // La PWA affiche l'exigence de couverture au lieu d'un simple « pas tenu » :
    // elle doit donc connaître le seuil, pas le deviner.
    couverture_mini: COUVERTURE_MINI
  };
}

/** Aujourd'hui dans `tz`, calé à midi : l'arithmétique en jours ignore l'heure d'été. */
function midiDuJour_(tz) {
  return new Date(Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd') + 'T12:00:00');
}

var JOURS_FR_ = ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'];

/**
 * Les `nb` derniers jours finissant aujourd'hui, du plus ancien au plus récent :
 * l'apport réel du jour, pas une moyenne. `a_donnees` distingue « rien saisi »
 * (pas de clôture médiane depuis le 2026-08-08) d'un vrai zéro.
 */
function joursRecents_(tz, nb, parJour) {
  parJour = parJour || intakeParJour_(tz);
  var today = midiDuJour_(tz);
  var jours = [];
  for (var d = nb - 1; d >= 0; d--) {
    var jour = new Date(today.getTime() - d * 86400000);
    var iso = Utilities.formatDate(jour, tz, 'yyyy-MM-dd');
    var b = parJour[iso];
    jours.push({
      date: iso,
      label: d === 0 ? 'Auj.' : JOURS_FR_[jour.getDay()],
      a_donnees: !!b,
      kcal: round1_(b ? b.kcal : 0),
      prot_g: round1_(b ? b.prot_g : 0),
      fibres_g: round1_(b ? b.fibres_g : 0)
    });
  }
  return jours;
}

/** Timestamp (Date ou chaîne) → ms epoch. */
function tsOf_(ts) { return ts instanceof Date ? ts.getTime() : new Date(ts).getTime(); }

/* ===================================================================== */
/* 7. ÉCRITURES (POST)                                                    */
/* ===================================================================== */

function postLog_(p) {
  var type = p.type;
  var tz = params_().tz || 'Europe/Paris';
  var now = new Date();

  switch (type) {
    case 'plat':          return logPlat_(p, now);
    case 'produit':       return logProduit_(p, now);
    case 'pot_fini':      return potFini_(p, now, tz);
    case 'batch_cuisine': return batchCuisine_(p, now);
    case 'courses':       return coursesValidees_(p, now);
    case 'ajustement':    return ajustement_(p, now);
    case 'exterieur':     return exterieur_(p, now);
    default: throw new Error('Type de log inconnu : ' + type);
  }
}

/* ---------------------------------------------------------------------- */
/* Validation groupée de l'inventaire (action `commit`)                     */
/* ---------------------------------------------------------------------- */

/**
 * Applique TOUS les mouvements de curseurs d'un coup et renvoie l'état frais.
 *
 * Corps : { action:'commit', op_id, changes:[{ ref, kind:'produit'|'plat', delta }] }
 * `delta` en grammes : > 0 = consommé, < 0 = correction (« je n'avais pas mangé ça »).
 *
 * Pourquoi une action dédiée (2026-08-13) : la PWA envoyait un POST par aliment
 * puis deux GET de recalage — huit aliments valaient dix exécutions Apps Script,
 * concurrentes qui plus est. Ici : une exécution, un verrou, une écriture de
 * stock, une réponse qui contient déjà le nouvel état.
 *
 * **Une correction annule la consommation du jour, pas seulement le stock.**
 * C'est le second bug du 2026-08-13 : reculer un curseur passait par un
 * `ajustement`, que `getState_` ignore pour les jauges — le stock revenait, les
 * calories restaient. On journalise donc une quantité NÉGATIVE, plafonnée à ce
 * qui a été logué aujourd'hui pour cette référence : le reliquat (une saisie
 * d'hier qu'on corrige ce matin) part en `ajustement`, car il ne doit surtout
 * pas creuser les jauges du jour.
 */
function commit_(p) {
  var changes = (p && p.changes) || [];
  if (!changes.length) throw new Error('changes requis (liste des mouvements).');

  var tz = params_().tz || 'Europe/Paris';
  var now = new Date();
  var today = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
  var produitsById = indexBy_(readTable_('produits'), 'id');
  var platsById = indexBy_(readTable_('plats'), 'id');

  // Consommation déjà journalisée AUJOURD'HUI, par référence : c'est le plafond
  // de ce qu'une correction peut annuler. Lecture bornée à la journée.
  var consoJour = {};
  readLog_(debutDuJour_(tz)).forEach(function (l) {
    if (l.type !== 'plat' && l.type !== 'produit') return;
    if (formatTs_(l.timestamp, tz) !== today) return;
    var k = String(l.ref);
    consoJour[k] = (consoJour[k] || 0) + (Number(l.quantite) || 0);
  });

  var deltas = {};      // ref → variation de stock (g), cumulée avant écriture
  var lignes = [];      // lignes de log, écrites en un seul bloc
  var applique = [];
  var ignores = [];
  var pousser = function (ref, g) { deltas[ref] = (deltas[ref] || 0) + g; };

  changes.forEach(function (c) {
    var ref = trim_((c && c.ref) || '');
    var d = round2_(Number(c && c.delta) || 0);
    if (!ref || !d) return;

    var pl = platsById[ref];
    var estPlat = String(c.kind) === 'plat' || (!produitsById[ref] && !!pl);
    // Référence inconnue : on l'écarte et on le dit, sans faire échouer le lot.
    // Lever ici perdrait les sept autres aliments de la validation — et la PWA
    // classerait le rejet comme définitif, donc l'action serait abandonnée.
    if (estPlat ? !pl : !produitsById[ref]) { ignores.push(ref); return; }
    var type = estPlat ? 'plat' : 'produit';
    var source = trim_(c.source || '') || 'curseur';

    // Le stock bouge dans les deux sens de la même façon : ce qu'on mange sort,
    // ce qu'on corrige revient. `-d` couvre les deux cas.
    if (estPlat && String(pl.type) !== 'batch') {
      // Assemblage : ce sont les INGRÉDIENTS qui bougent, au prorata de la fournée.
      var poids = poidsFournee_(pl);
      var part = poids > 0 ? d / poids : 0;
      composition_(pl).forEach(function (ing) { pousser(ing.produit_id, -ing.grammes * part); });
    } else {
      pousser(ref, -d);
    }

    if (d > 0) {
      lignes.push({ timestamp: now, type: type, ref: ref, quantite: d, source: source });
      consoJour[ref] = (consoJour[ref] || 0) + d;
      applique.push({ ref: ref, mange_g: d });
    } else {
      var annulable = Math.min(-d, Math.max(0, consoJour[ref] || 0));
      if (annulable > 0) {
        lignes.push({ timestamp: now, type: type, ref: ref, quantite: -annulable, source: 'correction' });
        consoJour[ref] -= annulable;
      }
      var residu = round2_(-d - annulable);
      if (residu > 0) {
        // Rien à annuler dans la journée : la saisie corrigée date d'un jour
        // précédent. Seul le stock revient — creuser les jauges d'aujourd'hui
        // avec une erreur d'hier serait un second mensonge.
        lignes.push({ timestamp: now, type: 'ajustement', ref: ref, quantite: residu, source: 'correction' });
      }
      applique.push({ ref: ref, rendu_g: -d, conso_annulee_g: annulable });
    }
  });

  appendRows_('log', lignes);
  appliquerDeltas_(deltas);

  // L'état frais voyage AVEC la réponse : plus besoin d'un GET de recalage, et
  // surtout la PWA n'a plus à deviner ce que le serveur a retenu.
  return { applique: applique, ignores: ignores, state: getState_() };
}

/** Log d'un plat consommé → journal + décrément du stock des ingrédients. */
function logPlat_(p, now) {
  if (!p.ref) throw new Error('ref (plat_id) requis.');
  var platsById = indexBy_(readTable_('plats'), 'id');
  var pl = platsById[p.ref];
  if (!pl) throw new Error('Plat inconnu : ' + p.ref);
  var q = Number(p.quantite) || 1;

  appendRow_('log', {
    timestamp: now, type: 'plat', ref: p.ref, quantite: q,
    source: p.source || 'tap'
  });

  // Décrément stock : plat batch consomme son propre stock, sinon ses ingrédients
  if (String(pl.type) === 'batch') {
    adjustStock_(pl.id, -q);
  } else {
    // Assemblage : q est le poids mangé (g) rapporté au poids de la fournée.
    var poids = poidsFournee_(pl);
    var part = poids > 0 ? q / poids : 0;
    composition_(pl).forEach(function (c) {
      adjustStock_(c.produit_id, -c.grammes * part);
    });
  }
  return { logged: 'plat', ref: p.ref, quantite: q };
}

/**
 * Log d'un aliment brut consommé (modèle produit-centrique) : quantité en
 * GRAMMES (fractions acceptées, dérivées du curseur côté PWA). Journalise et
 * décrémente le stock du produit. Ses macros — pour 100 g, donc mises à
 * l'échelle par quantite/100 — comptent dans les jauges du jour (getState_).
 */
function logProduit_(p, now) {
  if (!p.ref) throw new Error('ref (produit_id) requis.');
  var produitsById = indexBy_(readTable_('produits'), 'id');
  var pr = produitsById[p.ref];
  if (!pr) throw new Error('Produit inconnu : ' + p.ref);
  var q = Number(p.quantite);
  if (!(q > 0)) throw new Error('quantite (grammes) > 0 requise.');

  appendRow_('log', {
    timestamp: now, type: 'produit', ref: p.ref, quantite: q,
    source: p.source || 'tap'
  });
  adjustStock_(p.ref, -q); // stock peut passer sous 0 (dérive, recalé au scan « pot fini »)
  return { logged: 'produit', ref: p.ref, quantite: q };
}

/**
 * Scan « pot fini » (SPEC §3.5) : force le stock du produit à 0 et répartit
 * rétroactivement l'écart (conso supposée vs réelle) sur les lignes médian
 * récentes du/des créneaux où ce produit apparaît. Lissage auto-correcteur.
 */
function potFini_(p, now, tz) {
  if (!p.ref) throw new Error('ref (produit_id) requis.');
  var avant = Number(stockMap_()[p.ref] || 0);
  setStock_(p.ref, 0);
  appendRow_('log', { timestamp: now, type: 'pot_fini', ref: p.ref, quantite: 1, source: p.source || 'scan' });

  // Le stock est simplement recalé à 0. L'écart n'est plus réparti sur des
  // repas supposés : la clôture médiane a été retirée (2026-08-08), elle
  // inventait une consommation ET puisait dans le stock.
  return { calibrated: p.ref, stock_avant: round1_(avant) };
}

/** Batch cuisiné → ajoute au stock le poids de la fournée (somme des ingrédients). */
function batchCuisine_(p, now) {
  if (!p.ref) throw new Error('ref (recette_id ou plat_id) requis.');
  var recettes = indexBy_(readTable_('recettes'), 'id');
  var rec = recettes[p.ref];
  var platId = rec ? rec.plat_id : p.ref;
  var pl = indexBy_(readTable_('plats'), 'id')[platId];
  if (!pl) throw new Error('Plat inconnu : ' + platId);

  // Un plat cuisiné n'a pas d'emballage : le poids de la fournée EST la somme
  // des ingrédients consommés (décision Azur, 2026-08-08). La colonne
  // poids_produit_g permet de corriger à la main (évaporation, ajout d'eau…).
  var poids = Number(p.poids_g) || (rec ? Number(rec.poids_produit_g) : 0) || poidsFournee_(pl);
  if (!(poids > 0)) throw new Error('Poids de la fournée inconnu : composition vide ?');

  // Cuisiner = transformer : − les ingrédients, + la fournée dans le stock.
  composition_(pl).forEach(function (c) { adjustStock_(c.produit_id, -c.grammes); });
  adjustStock_(platId, poids);
  appendRow_('log', { timestamp: now, type: 'batch_cuisine', ref: platId, quantite: poids, source: p.source || 'tap' });
  // Met à jour derniere_realisation pour la rotation des suggestions hebdo
  if (rec) touchRecette_(p.ref, now);
  return { batch: platId, grammes_ajoutes: Math.round(poids) };
}

/** Courses validées → incrémente le stock des articles cochés. */
function coursesValidees_(p, now) {
  var items = p.items || []; // [{produit_id, unites}] ou [{produit_id, grammes}]
  if (!items.length) throw new Error('items requis (liste des articles cochés).');
  var produitsById = indexBy_(readTable_('produits'), 'id');
  var ajouts = [];
  items.forEach(function (it) {
    var pr = produitsById[it.produit_id];
    if (!pr) return;
    var grammes = it.grammes != null
      ? Number(it.grammes)
      : Number(it.unites || 1) * (Number(pr.poids_paquet_g) || 0);
    if (!(grammes > 0)) return;   // poids de paquet inconnu → rien à ajouter
    adjustStock_(it.produit_id, grammes);
    ajouts.push({ produit_id: it.produit_id, grammes: grammes });
  });
  appendRow_('log', { timestamp: now, type: 'courses', ref: '', quantite: ajouts.length, source: p.source || 'tap' });
  return { courses_validees: ajouts };
}

/**
 * Ajout d'un produit au catalogue depuis un scan (fiche OpenFoodFacts validée
 * dans la PWA). Idempotent sur l'EAN : rescanner un EAN déjà connu renvoie le
 * produit existant sans créer de doublon. Génère l'id (P + n° suivant).
 * Corps attendu : { action:'add_produit', produit:{ nom, ean, kcal, prot_g,
 *   poids_paquet_g, flag_gluten, flag_lactose,
 *   marque_magasin?, perissable_jours?, stock_initial? } }
 * Valeurs nutritionnelles POUR 100 g ; stock_initial et poids_paquet_g en grammes.
 */
function addProduit_(p) {
  assurerColonnesProduits_();
  var f = p.produit || p; // accepte {produit:{…}} ou champs à plat
  var nom = trim_(f.nom || '');
  if (!nom) throw new Error('nom requis pour ajouter un produit.');
  var ean = String(f.ean == null ? '' : f.ean).replace(/\D/g, '');

  var produits = readTable_('produits');
  // Idempotence : un EAN déjà présent renvoie le produit existant.
  if (ean) {
    var exist = null;
    produits.forEach(function (pr) {
      if (String(pr.ean).replace(/\D/g, '') === ean) exist = pr;
    });
    if (exist) return { produit: publicProduit_(exist), existe_deja: true };
  }

  var id = nextProduitId_(produits);
  appendRow_('produits', {
    id: id, nom: nom,
    marque_magasin: trim_(f.marque_magasin || f.marque || ''),
    ean: ean,
    poids_paquet_g: Number(f.poids_paquet_g) || 0,
    kcal_100g: Number(f.kcal_100g) || 0,
    // Vide si non renseigné : distinguer « sans fibres » de « on ne sait pas »
    // sera impossible plus tard, et la jauge fibres viendra peut-être un jour.
    fibres_100g: (f.fibres_100g === '' || f.fibres_100g == null) ? '' : Number(f.fibres_100g),
    prot_100g: Number(f.prot_100g) || 0,
    flag_gluten: normFlag_(f.flag_gluten),
    flag_lactose: normFlag_(f.flag_lactose),
    perissable_jours: (f.perissable_jours === '' || f.perissable_jours == null) ? '' : Number(f.perissable_jours),
    actif: 'oui',
    categorie: normCategorie_(f.categorie)
  });

  // Stock initial optionnel (grammes) ; 0 par défaut : on scanne souvent un
  // contenant déjà entamé/fini, le réappro passe par « courses ».
  var stock0 = Number(f.stock_initial);
  if (stock0 > 0) setStock_(id, stock0);

  appendRow_('log', { timestamp: new Date(), type: 'add_produit', ref: id, quantite: 1, source: p.source || 'scan' });
  return { produit: publicProduit_(indexBy_(readTable_('produits'), 'id')[id]) };
}

/** Prochain id produit disponible : P + (max numérique + 1), zéro-paddé sur 2. */
function nextProduitId_(produits) {
  var max = 0;
  produits.forEach(function (pr) {
    var m = /^P0*(\d+)$/.exec(String(pr.id).trim());
    if (m) max = Math.max(max, Number(m[1]));
  });
  var n = max + 1;
  return 'P' + (n < 10 ? '0' + n : String(n));
}

/** Normalise un flag oui/non (défaut : chaîne vide = inconnu). */
/**
 * Allergènes d'un plat, hérités de ses ingrédients : 'oui' dès qu'un ingrédient
 * est positif, '' (inconnu) si aucun ne l'est mais qu'au moins un n'est pas
 * renseigné, 'non' seulement quand toute la composition est documentée et
 * négative. Le « je ne sais pas » ne se transforme jamais en « non ».
 */
function flagsComposition_(pl, produitsById) {
  var out = { gluten: 'non', lactose: 'non' };
  var inconnu = { gluten: false, lactose: false };
  composition_(pl).forEach(function (c) {
    var pr = produitsById[c.produit_id];
    ['gluten', 'lactose'].forEach(function (k) {
      var v = pr ? normFlag_(pr['flag_' + k]) : '';
      if (v === 'oui') out[k] = 'oui';
      else if (v === '') inconnu[k] = true;
    });
  });
  if (out.gluten !== 'oui' && inconnu.gluten) out.gluten = '';
  if (out.lactose !== 'oui' && inconnu.lactose) out.lactose = '';
  return out;
}

function normFlag_(v) {
  var s = String(v == null ? '' : v).toLowerCase();
  if (s === 'oui' || s === 'true' || s === '1' || s === 'yes') return 'oui';
  if (s === '') return '';
  return 'non';
}

/** Vue publique d'un produit (sous-ensemble utile à la PWA). */
function publicProduit_(pr) {
  return {
    id: pr.id, nom: pr.nom,
    kcal_100g: Number(pr.kcal_100g) || 0,
    prot_100g: Number(pr.prot_100g) || 0,
    // Chaîne vide conservée telle quelle : « on ne sait pas » ≠ 0 (skill §6).
    fibres_100g: (pr.fibres_100g === '' || pr.fibres_100g == null) ? '' : Number(pr.fibres_100g),
    poids_paquet_g: Number(pr.poids_paquet_g) || 0,
    ean: String(pr.ean || ''), actif: pr.actif,
    categorie: normCategorie_(pr.categorie)
  };
}

/**
 * Range des produits : {action:'set_categorie', items:[{produit_id, categorie}]}.
 * Écrit la seule cellule `categorie`, ligne par ligne (le reste ne bouge pas).
 * Une catégorie vide déclasse volontairement le produit en « non rangé » —
 * c'est le moyen d'annuler un rangement fait par erreur.
 */
function setCategorie_(p) {
  assurerColonnesProduits_();
  var items = p.items || [];
  if (!items.length) return { rangés: 0 };

  var sh = sheet_('produits');
  var values = sh.getDataRange().getValues();
  var col = SCHEMA.produits.indexOf('categorie') + 1;
  var ligneDe = {};
  for (var r = 1; r < values.length; r++) ligneDe[String(values[r][0]).trim()] = r + 1;

  var n = 0;
  items.forEach(function (it) {
    var ligne = ligneDe[trim_(it.produit_id || it.id || '')];
    if (!ligne) return;                    // id inconnu : ignoré, pas d'erreur bloquante
    sh.getRange(ligne, col).setValue(normCategorie_(it.categorie));
    n++;
  });
  oublierOnglet_('produits');
  return { ranges: n };
}

/**
 * Ajustement manuel de stock (secours), à l'unité ou par LOT.
 *
 * Le lot (`items: [{ref, delta}]`) existe depuis le 2026-08-13 : annuler des
 * courses de dix articles envoyait dix POST concurrents, qui se disputaient le
 * verrou d'écriture un par un — dix exécutions Apps Script en file, chacune à
 * plusieurs secondes. Un seul appel prend le verrou une fois, écrit ses lignes
 * d'un bloc et applique les deltas de stock en une passe.
 */
function ajustement_(p, now) {
  var items = Array.isArray(p.items) && p.items.length
    ? p.items
    : [{ ref: p.ref, delta: p.delta }];

  var deltas = {};
  var lignes = [];
  var ajustes = [];
  items.forEach(function (it) {
    var ref = trim_((it && it.ref) || '');
    var delta = Number(it && it.delta);
    if (!ref) throw new Error('ref requise pour chaque ajustement.');
    if (isNaN(delta)) throw new Error('delta numérique requis pour ' + ref + '.');
    if (!delta) return;
    deltas[ref] = (deltas[ref] || 0) + delta;
    lignes.push({ timestamp: now, type: 'ajustement', ref: ref, quantite: delta,
      source: p.source || 'manuel' });
    ajustes.push({ ref: ref, delta: delta });
  });

  appendRows_('log', lignes);
  appliquerDeltas_(deltas);
  return { ajustes: ajustes, ajuste: ajustes.length === 1 ? ajustes[0].ref : null };
}

/**
 * Repas extérieur (resto, invitation…) : macros libres saisies au curseur dans
 * la PWA (défaut = preset resto du catalogue, ajustable). Comptent dans les
 * jauges du jour, SANS toucher au stock (aucun ingrédient consommé). Les macros
 * sont stockées dans la colonne `extra` du log pour être relues par state/bilan.
 */
function exterieur_(p, now) {
  // Pas de curseur fibres dans la PWA (SPEC §1 principe 2 : 1 preset + 2
  // curseurs) : la valeur vient du preset resto choisi, et vaut 0 sans preset.
  var macros = {
    kcal: Number(p.kcal) || 0,
    prot_g: Number(p.prot_g) || 0,
    fibres_g: Number(p.fibres_g) || 0
  };
  appendRow_('log', {
    timestamp: now, type: 'exterieur', ref: p.ref || '', quantite: 1,
    source: p.source || 'tap', extra: JSON.stringify(macros)
  });
  return { exterieur: macros, ref: p.ref || '' };
}

/**
 * Retire un repas extérieur du jour depuis le résumé de la journée (2026-08-13).
 *
 * Corps : { action:'annuler_exterieur', op_id, rang, kcal? }
 * `rang` = position parmi les extérieurs d'AUJOURD'HUI, telle que `journalDuJour_`
 * l'a servie. `kcal` est facultatif mais vérifié quand il est là : si la ligne
 * trouvée ne porte pas ce montant, c'est que l'écran affichait un journal
 * périmé — mieux vaut refuser que supprimer le mauvais repas.
 *
 * La ligne est retirée pour de bon, pas neutralisée par une ligne négative :
 * c'est une saisie erronée, et une paire « +800 / −800 » polluerait le résumé
 * du jour qu'on vient justement d'ajouter. La trace reste dans `ops`.
 */
function annulerExterieur_(p) {
  var rang = Number(p && p.rang);
  if (!(rang >= 0)) throw new Error('rang requis (position du repas dans la journée).');

  var tz = params_().tz || 'Europe/Paris';
  var today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  var sh = sheet_('log');
  var vals = sh.getDataRange().getValues();
  var head = vals[0];
  var cType = head.indexOf('type');
  var cTs = head.indexOf('timestamp');
  var cExtra = head.indexOf('extra');

  var vu = -1;
  for (var r = 1; r < vals.length; r++) {
    if (String(vals[r][cType]) !== 'exterieur') continue;
    if (formatTs_(vals[r][cTs], tz) !== today) continue;
    vu++;
    if (vu !== rang) continue;

    var m = parseExtra_(vals[r][cExtra]);
    var attendu = Number(p.kcal);
    if (p.kcal != null && p.kcal !== '' && Math.abs(m.kcal - attendu) > 1) {
      throw new Error('Le repas affiché ne correspond plus à celui enregistré. Recharge l’écran.');
    }
    sh.deleteRow(r + 1);                       // +1 : la ligne d'en-tête
    oublierOnglet_('log');
    return { annule: 'exterieur', rang: rang, kcal: m.kcal, state: getState_() };
  }
  throw new Error('Repas extérieur introuvable (déjà retiré ?).');
}

/** Parse la colonne `extra` d'un log (JSON de macros) → {kcal,prot_g,fibres_g}. */
function parseExtra_(extra) {
  var vide = { kcal: 0, prot_g: 0, fibres_g: 0 };
  if (!extra) return vide;
  try {
    var o = typeof extra === 'string' ? JSON.parse(extra) : extra;
    return {
      kcal: Number(o.kcal) || 0,
      prot_g: Number(o.prot_g) || 0,
      // Les repas extérieurs d'avant le 2026-08-09 n'ont pas ce champ : 0.
      fibres_g: Number(o.fibres_g) || 0
    };
  } catch (e) { return vide; }
}

/* ===================================================================== */
/* 8. CLÔTURE MÉDIANE QUOTIDIENNE (SPEC §3.4)                             */
/* ===================================================================== */


/* ===================================================================== */
/* 9. STOCK — utilitaires                                                 */
/* ===================================================================== */

function stockMap_() {
  var out = {};
  readTable_('stock').forEach(function (r) { out[String(r.ref)] = Number(r.grammes) || 0; });
  return out;
}

function setStock_(ref, grammes) {
  var sh = sheet_('stock');
  var values = sh.getDataRange().getValues();
  oublierOnglet_('stock');
  for (var r = 1; r < values.length; r++) {
    if (String(values[r][0]) === String(ref)) {
      sh.getRange(r + 1, 2).setValue(round2_(grammes));
      return;
    }
  }
  sh.appendRow([ref, round2_(grammes)]);
}

function adjustStock_(ref, delta) {
  var cur = Number(stockMap_()[ref] || 0);
  setStock_(ref, cur + delta); // le stock peut passer sous 0 (info de dérive)
}

/**
 * Applique un lot de variations {ref: delta} en UNE lecture et UNE écriture.
 * `adjustStock_` relit tout l'onglet à chaque référence : sur une validation de
 * huit aliments, ça faisait seize allers-retours vers le Sheet.
 */
function appliquerDeltas_(deltas) {
  var refs = Object.keys(deltas || {}).filter(function (r) { return deltas[r]; });
  if (!refs.length) return;

  var sh = sheet_('stock');
  var vals = sh.getDataRange().getValues();
  var ligneDe = {};
  for (var r = 1; r < vals.length; r++) ligneDe[String(vals[r][0])] = r;

  var nouvelles = [];
  refs.forEach(function (ref) {
    var i = ligneDe[ref];
    if (i == null) nouvelles.push([ref, round2_(deltas[ref])]);
    else vals[i][1] = round2_((Number(vals[i][1]) || 0) + deltas[ref]);
  });

  // Réécrit la colonne des grammes en un bloc, puis ajoute les refs inconnues.
  // Une ligne sans référence est recopiée telle quelle : y écrire un 0 la
  // rendrait « non vide » et ferait apparaître une entrée fantôme dans le stock.
  if (vals.length > 1) {
    sh.getRange(2, 2, vals.length - 1, 1).setValues(vals.slice(1).map(function (row) {
      var g = row.length > 1 ? row[1] : '';
      if (trim_(row[0]) === '') return [g == null ? '' : g];
      return [g === '' || g == null ? 0 : g];
    }));
  }
  if (nouvelles.length) {
    sh.getRange(sh.getLastRow() + 1, 1, nouvelles.length, 2).setValues(nouvelles);
  }
  oublierOnglet_('stock');
}

/* ===================================================================== */
/* 10. AIDES DIVERSES                                                     */
/* ===================================================================== */

function indexBy_(arr, key) {
  var o = {};
  arr.forEach(function (x) { o[String(x[key])] = x; });
  return o;
}

function actif_(row) {
  var v = String(row.actif).toLowerCase();
  return v !== 'non' && v !== 'false' && v !== '0';
}

function trim_(s) { return String(s).trim(); }

/** Parse le champ composition d'un plat en [{produit_id, grammes}].
 *  Formats acceptés : JSON [["P01",2],["P02",1]] ou "P01:2,P02:1". */
function composition_(pl) {
  var raw = pl.composition;
  if (!raw) return [];
  var s = String(raw).trim();
  var out = [];
  if (s.charAt(0) === '[' || s.charAt(0) === '{') {
    try {
      var arr = JSON.parse(s);
      arr.forEach(function (e) {
        if (Array.isArray(e)) out.push({ produit_id: e[0], grammes: Number(e[1]) || 0 });
        else out.push({ produit_id: e.produit_id || e.id, grammes: Number(e.grammes || e.g) || 0 });
      });
      return out;
    } catch (err) { /* fallback texte */ }
  }
  s.split(',').forEach(function (part) {
    var kv = part.split(':').map(trim_);
    if (kv[0]) out.push({ produit_id: kv[0], grammes: Number(kv[1]) || 0 });
  });
  return out;
}

/**
 * Macros POUR 100 g d'un plat : colonnes pré-calculées si présentes, sinon
 * déduites de la composition. Un plat cuisiné n'a pas d'emballage : son
 * « paquet » est la fournée, dont le poids est la somme des ingrédients
 * (décision Azur, 2026-08-08). On somme donc les apports de la recette entière,
 * puis on ramène à 100 g en divisant par ce poids total.
 */
function macrosOf_(platId, platsById) {
  var pl = platsById[platId];
  if (!pl) return { kcal: 0, prot_g: 0, fibres_g: null };
  if (pl.kcal_100g !== '' && pl.kcal_100g != null) {
    return {
      kcal: Number(pl.kcal_100g) || 0,
      prot_g: Number(pl.prot_100g) || 0,
      fibres_g: fibresOu_(pl.fibres_100g)
    };
  }
  // Mémoïsé : cette ligne relisait TOUT l'onglet `produits` pour chaque plat
  // dépourvu de colonnes pré-calculées, et `macrosOf_` est appelée dans des
  // boucles (pools par créneau, journal du jour, bilan). Invisible tant que
  // l'onglet `plats` est vide — ruineux le jour où il sera peuplé.
  var produitsById = indexBy_(readTable_('produits'), 'id');
  var tot = { kcal: 0, prot_g: 0, fibres_g: 0 };
  var poids = 0;
  var avecFibres = 0;                     // ingrédients qui portent réellement la donnée
  composition_(pl).forEach(function (c) {
    var pr = produitsById[c.produit_id];
    if (!pr) return;
    var r = c.grammes / 100;
    tot.kcal += (Number(pr.kcal_100g) || 0) * r;
    tot.prot_g += (Number(pr.prot_100g) || 0) * r;
    var fib = fibresOu_(pr.fibres_100g);
    if (fib != null) { tot.fibres_g += fib * r; avecFibres++; }
    poids += c.grammes;
  });
  if (!(poids > 0)) return { kcal: 0, prot_g: 0, fibres_g: null };
  var k = 100 / poids;
  // On additionne ce qu'on a : un plat n'est « sans donnée » que si AUCUN de ses
  // ingrédients n'en porte (décision 2026-08-09, skill nutrition §6).
  return {
    kcal: tot.kcal * k,
    prot_g: tot.prot_g * k,
    fibres_g: avecFibres > 0 ? tot.fibres_g * k : null
  };
}

/** Poids total d'une fournée = somme des ingrédients de la composition (g). */
function poidsFournee_(pl) {
  var poids = 0;
  composition_(pl).forEach(function (c) { poids += c.grammes; });
  return poids;
}

/** Macros POUR 100 g d'un produit brut. Multiplier par grammes/100 pour l'apport. */
function macrosProduit_(produitId, produitsById) {
  var pr = produitsById[produitId];
  if (!pr) return { kcal: 0, prot_g: 0, fibres_g: null };
  return {
    kcal: Number(pr.kcal_100g) || 0,
    prot_g: Number(pr.prot_100g) || 0,
    // null, PAS 0 : « on ne sait pas » doit rester distinct de « sans fibres »
    // (l'étiquetage des fibres est facultatif, ~1 fiche OFF sur 3 est muette).
    // C'est le seul filet qui permettra un jour de mesurer la couverture, la
    // décision étant de ne rien boucher (skill nutrition §6).
    fibres_g: fibresOu_(pr.fibres_100g)
  };
}

/** Colonne fibres → nombre, ou null si la cellule est vide (donnée absente). */
function fibresOu_(v) {
  return (v === '' || v == null) ? null : (Number(v) || 0);
}

function platFaisable_(pl, stock) {
  if (String(pl.type) === 'batch') return Number(stock[pl.id] || 0) > 0;
  return composition_(pl).every(function (c) {
    return Number(stock[c.produit_id] || 0) >= c.grammes;
  });
}

/**
 * Consommation quotidienne moyenne PAR PRODUIT (grammes/j) sur `jours` glissants.
 * Compte tous les événements où un ingrédient quitte le stock :
 *  - log `produit` (conso au curseur) : le produit lui-même ;
 *  - log `plat` assemblage : ses ingrédients (composition × quantité) ;
 *  - log `batch_cuisine` : ses ingrédients (la composition entière, une fois).
 * On ignore les plats batch mangés (ils consomment le stock du plat, les
 * ingrédients ayant déjà été décomptés à la cuisson) et les repas extérieurs.
 */
function consoParProduitParJour_(platsById, produitsById, jours) {
  var cutoff = Date.now() - jours * 86400000;
  var totals = {};
  var add = function (id, n) { totals[id] = (totals[id] || 0) + n; };
  readLog_(cutoff).forEach(function (l) {
    if (tsOf_(l.timestamp) < cutoff) return;
    var q = Number(l.quantite) || 1;
    if (l.type === 'produit') {
      add(l.ref, q);
    } else if (l.type === 'batch_cuisine') {
      // Cuisiner consomme la composition entière, une fois : q est le poids
      // produit, pas un multiplicateur.
      var plb = platsById[l.ref];
      if (plb) composition_(plb).forEach(function (c) { add(c.produit_id, c.grammes); });
    } else if (l.type === 'plat') {
      var pl = platsById[l.ref];
      if (!pl || String(pl.type) === 'batch') return;   // batch mangé → aucun ingrédient consommé
      var poids = poidsFournee_(pl);
      var part = poids > 0 ? q / poids : 0;
      composition_(pl).forEach(function (c) { add(c.produit_id, c.grammes * part); });
    }
  });
  var perDay = {};
  Object.keys(totals).forEach(function (id) { perDay[id] = totals[id] / jours; });
  return perDay;
}

function gauge_(valeur, cible) {
  var c = Number(cible) || 0;
  return {
    valeur: round1_(valeur),
    cible: c,
    ratio: c > 0 ? round2_(valeur / c) : null
  };
}

function magasinOf_(marqueMagasin) {
  // Champ « marque / magasin » : on prend la partie après « / » si présente
  var s = String(marqueMagasin || '');
  var parts = s.split('/');
  return trim_(parts[parts.length - 1]) || 'Autre';
}

function creneauCourant_(tz) {
  var h = Number(Utilities.formatDate(new Date(), tz, 'H'));
  if (h < 11) return 'petit_dej';
  if (h < 15) return 'dejeuner';
  if (h < 18) return 'collation';
  return 'diner';
}

function touchRecette_(recetteId, now) {
  var sh = sheet_('recettes');
  var values = sh.getDataRange().getValues();
  oublierOnglet_('recettes');
  var iId = SCHEMA.recettes.indexOf('id');
  var iDate = SCHEMA.recettes.indexOf('derniere_realisation');
  for (var r = 1; r < values.length; r++) {
    if (String(values[r][iId]) === String(recetteId)) {
      sh.getRange(r + 1, iDate + 1).setValue(now);
      return;
    }
  }
}

function formatTs_(ts, tz) {
  var d = ts instanceof Date ? ts : new Date(ts);
  return Utilities.formatDate(d, tz, 'yyyy-MM-dd');
}

function round1_(x) { return Math.round(Number(x) * 10) / 10; }
function round2_(x) { return Math.round(Number(x) * 100) / 100; }

/* ===================================================================== */
/* 11. DÉCLENCHEUR — clôture médiane automatique                          */
/* ===================================================================== */

/** À exécuter une fois pour installer le trigger quotidien (03h). */
/**
 * La clôture médiane a été retirée (2026-08-08) : sur une journée non saisie,
 * elle inscrivait d'office un repas « médian » ET décrémentait le stock de ses
 * ingrédients — une consommation fictive doublée d'un stock faux. Le rattrapage
 * des jours en retard devra se faire par l'utilisateur.
 *
 * À lancer UNE FOIS depuis l'éditeur pour supprimer le déclencheur nocturne
 * s'il avait été installé. clotureMedianeAuto_ reste une fonction vide le temps
 * que ce soit fait : un déclencheur pointant vers une fonction disparue échoue
 * chaque nuit et envoie un mail d'erreur.
 */
function desinstallerTriggers() {
  var n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'clotureMedianeAuto_') { ScriptApp.deleteTrigger(t); n++; }
  });
  Logger.log(n + ' déclencheur(s) supprimé(s).');
  return { supprimes: n };
}

function clotureMedianeAuto_() { /* retiré — voir desinstallerTriggers() */ }

/* ===================================================================== */
/* 11bis. MIGRATION « CIBLE FIBRES » (2026-08-09)                         */
/* ===================================================================== */

/**
 * Vérification manuelle de la cible fibres — **facultative**.
 *
 * Le rattrapage est automatique : `assurerCibleFibres_()` s'exécute à la
 * première lecture qui touche `objectifs` (voir §3). Cette fonction ne sert
 * qu'à le déclencher et à le constater depuis l'éditeur, sans passer par la
 * PWA. Elle n'écrase jamais une valeur saisie à la main.
 *
 * Valeurs : skill-nutrition/SKILL.md §6 et §12 (30 g/j, tolérance ±5 g).
 */
function migrerFibres() {
  var obj = objectifs_();                     // déclenche assurerCibleFibres_
  Logger.log('Cible fibres : ' + obj.fibres_g_jour + ' g/j (±' + obj.tol_fibres + ')');
  return { fibres_g_jour: obj.fibres_g_jour, tol_fibres: obj.tol_fibres };
}

/* ===================================================================== */
/* 12. MIGRATION « PORTIONS → GRAMMES » (2026-08-08)                      */
/* ===================================================================== */

/**
 * Convertit un Sheet écrit dans l'ancien modèle (valeurs PAR PORTION, stock en
 * portions) vers le nouveau (valeurs POUR 100 g, stock en grammes).
 *
 * À exécuter UNE FOIS depuis l'éditeur, AVANT setup(). Non destructif : le
 * classeur est dupliqué d'abord, et rien n'est écrit si une conversion est
 * impossible sans inventer un chiffre.
 *
 * Limite structurelle : convertir demande le poids d'une portion, qui n'existe
 * nulle part — on ne peut que le déduire de `unite_de_vente` (« pot 500 g » ÷
 * portions_par_unite). Les produits dont l'unité de vente ne porte aucun poids
 * (« bocal », « sachet », « boîte de 6 ») sont donc INCONVERTIBLES : la
 * fonction les laisse intacts et les liste. Il faut leur donner un poids à la
 * main, puis relancer.
 *
 * Renvoie (et journalise) un rapport : convertis / en attente.
 */
function migrerEnGrammes() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var produits = readTable_('produits');
  if (!produits.length) return { erreur: 'Onglet produits vide — rien à migrer.' };
  if (produits[0].poids_paquet_g !== undefined) {
    return { erreur: 'Déjà migré (colonne poids_paquet_g présente).' };
  }

  // 1. Poids d'une portion, par produit. Seule inconnue de toute la migration.
  var portionG = {};
  var bloquants = [];
  var repeches = [];
  produits.forEach(function (pr) {
    var ppu = Number(pr.portions_par_unite) || 0;
    var cont = contenanceEnGrammes_(pr.unite_de_vente);
    // Le poids du paquet n'a jamais eu de colonne : il n'existe que dans le
    // texte de l'unité de vente. Quand il n'y est pas, on le redemande à
    // OpenFoodFacts — c'est de là qu'il venait au scan.
    if (!(cont > 0) && pr.ean) {
      cont = poidsDepuisOFF_(pr.ean);
      if (cont > 0) repeches.push(pr.id + ' — ' + pr.nom + ' : ' + cont + ' g (OpenFoodFacts)');
    }
    if (cont > 0 && ppu > 0) portionG[pr.id] = cont / ppu;
    else bloquants.push(pr.id + ' — ' + pr.nom + ' (unité de vente : « ' + pr.unite_de_vente + ' »'
      + (pr.ean ? ', EAN ' + pr.ean + ' sans poids dans OpenFoodFacts' : ', pas d\'EAN') + ')');
  });
  if (repeches.length) Logger.log('Poids récupérés depuis OpenFoodFacts :\n' + repeches.join('\n'));

  if (bloquants.length) {
    Logger.log('MIGRATION IMPOSSIBLE — ' + bloquants.length + ' produit(s) sans poids déductible :\n'
      + bloquants.join('\n'));
    return {
      migre: false,
      motif: 'Poids d\'une portion indéductible pour ' + bloquants.length + ' produit(s).',
      a_completer: bloquants,
      remede: 'Écris le poids sur la ligne du produit (colonne unite_de_vente, ex. « 400 g »), puis relance. La colonne sera supprimée ensuite.'
    };
  }

  // 2. Sauvegarde intégrale avant toute écriture.
  var copie = ss.copy('Enthalpie — sauvegarde avant passage aux grammes ' +
    Utilities.formatDate(new Date(), params_().tz || 'Europe/Paris', 'yyyy-MM-dd HH:mm'));

  // 3. Logs : quantités en portions → grammes (avant de toucher aux tables).
  var platsById = indexBy_(readTable_('plats'), 'id');
  var shLog = sheet_('log');
  var lv = shLog.getDataRange().getValues();
  var hL = lv[0];
  var iT = hL.indexOf('type'), iR = hL.indexOf('ref'), iQ = hL.indexOf('quantite');
  for (var r = 1; r < lv.length; r++) {
    var type = lv[r][iT], ref = lv[r][iR], q = Number(lv[r][iQ]) || 0;
    var facteur = 0;
    if (type === 'produit' || type === 'courses' || type === 'ajustement') facteur = portionG[ref] || 0;
    else if (type === 'plat' || type === 'batch_cuisine') {
      var pl = platsById[ref];
      facteur = pl ? poidsCompositionAncienne_(pl, portionG) : 0;
    }
    if (facteur > 0) shLog.getRange(r + 1, iQ + 1).setValue(round2_(q * facteur));
  }

  // 4. Stock : portions → grammes.
  var shStock = sheet_('stock');
  var sv = shStock.getDataRange().getValues();
  for (var s = 1; s < sv.length; s++) {
    var ref2 = String(sv[s][0]);
    var f2 = portionG[ref2] || poidsCompositionAncienne_(platsById[ref2] || {}, portionG);
    if (f2 > 0) shStock.getRange(s + 1, 2).setValue(round2_((Number(sv[s][1]) || 0) * f2));
  }
  shStock.getRange(1, 2).setValue('grammes');

  // 5. Compositions : nb_portions → grammes.
  var shPlats = sheet_('plats');
  var pv = shPlats.getDataRange().getValues();
  var iComp = pv[0].indexOf('composition');
  for (var p2 = 1; p2 < pv.length; p2++) {
    var pl2 = platsById[String(pv[p2][0])];
    if (!pl2) continue;
    var conv = composition_(pl2).map(function (c) {
      // composition_ lit désormais `grammes`, mais l'ancien contenu portait des
      // portions : la valeur brute est la même, seule l'unité change.
      return [c.produit_id, round2_(c.grammes * (portionG[c.produit_id] || 0))];
    });
    shPlats.getRange(p2 + 1, iComp + 1).setValue(JSON.stringify(conv));
  }

  // 6. Valeurs nutritionnelles : par portion → pour 100 g, et en-têtes.
  convertirNutriments_('produits', portionG, ['kcal', 'prot_g'],
    ['kcal_100g', 'prot_100g']);
  renommerColonne_('produits', 'portions_par_unite', 'poids_paquet_g', function (val, row) {
    return round2_(contenanceEnGrammes_(row.unite_de_vente));
  });
  convertirNutrimentsPlats_(portionG, platsById);
  renommerColonne_('recettes', 'portions_produites', 'poids_produit_g', function (val, row) {
    var pl3 = platsById[row.plat_id];
    return pl3 ? round2_(poidsCompositionAncienne_(pl3, portionG) * (Number(val) || 1)) : '';
  });

  // 7. `unite_de_vente` a livré son poids : la colonne n'a plus d'usage. On la
  // supprime physiquement, sinon les en-têtes réécrits par setup() seraient
  // décalés d'une colonne par rapport aux données.
  supprimerColonne_('produits', 'unite_de_vente');

  Logger.log('Migration terminée. Sauvegarde : ' + copie.getUrl());
  return {
    migre: true,
    produits: produits.length,
    sauvegarde: copie.getUrl(),
    suite: 'Lancer setup() puis redéployer (bash backend/deployer.sh).'
  };
}

/**
 * Poids net (g) d'un produit d'après OpenFoodFacts, ou 0. `product_quantity`
 * est le champ numérique ; `quantity` est du texte libre, souvent un simple
 * compte (« 6 pcs »), d'où le repli sur une lecture de la contenance.
 */
function poidsDepuisOFF_(ean) {
  var code = String(ean || '').replace(/\D/g, '');
  if (!code) return 0;
  try {
    var res = UrlFetchApp.fetch(
      'https://world.openfoodfacts.org/api/v2/product/' + code +
      '.json?fields=quantity,product_quantity',
      { muteHttpExceptions: true, followRedirects: true });
    if (res.getResponseCode() !== 200) return 0;
    var p = (JSON.parse(res.getContentText()) || {}).product || {};
    var n = Number(p.product_quantity);
    if (n > 0) return Math.round(n);
    return Math.round(contenanceEnGrammes_(p.quantity));
  } catch (err) {
    return 0;   // réseau ou fiche illisible → produit simplement listé à compléter
  }
}

/** « pot 500 g » → 500 ; « brique 1 L » → 1000 ; « boîte de 6 » → 0. */
function contenanceEnGrammes_(unite) {
  var m = String(unite || '').toLowerCase().match(/(\d+(?:[.,]\d+)?)\s*(kg|g|cl|ml|l)\b/);
  if (!m) return 0;
  var v = parseFloat(m[1].replace(',', '.'));
  if (!(v > 0)) return 0;
  var mult = { kg: 1000, g: 1, l: 1000, cl: 10, ml: 1 }[m[2]] || 0;
  return v * mult;
}

/** Poids (g) de la composition d'un plat, lue à l'ANCIENNE (en portions). */
function poidsCompositionAncienne_(pl, portionG) {
  var tot = 0;
  composition_(pl).forEach(function (c) { tot += c.grammes * (portionG[c.produit_id] || 0); });
  return tot;
}

/** Divise les colonnes par-portion par le poids de portion → pour 100 g. */
function convertirNutriments_(onglet, portionG, avant, apres) {
  var sh = sheet_(onglet);
  var v = sh.getDataRange().getValues();
  var idx = avant.map(function (h) { return v[0].indexOf(h); });
  for (var r = 1; r < v.length; r++) {
    var pg = portionG[String(v[r][0])] || 0;
    if (!(pg > 0)) continue;
    idx.forEach(function (i) {
      if (i === -1) return;
      sh.getRange(r + 1, i + 1).setValue(round2_((Number(v[r][i]) || 0) * 100 / pg));
    });
  }
  idx.forEach(function (i, k) { if (i !== -1) sh.getRange(1, i + 1).setValue(apres[k]); });
}

/** Idem pour les plats, dont le diviseur est le poids de la composition. */
function convertirNutrimentsPlats_(portionG, platsById) {
  var sh = sheet_('plats');
  var v = sh.getDataRange().getValues();
  var cols = ['kcal', 'prot_g'];
  var noms = ['kcal_100g', 'prot_100g'];
  var idx = cols.map(function (h) { return v[0].indexOf(h); });
  for (var r = 1; r < v.length; r++) {
    var pl = platsById[String(v[r][0])];
    var pg = pl ? poidsCompositionAncienne_(pl, portionG) : 0;
    if (!(pg > 0)) continue;
    idx.forEach(function (i) {
      if (i === -1 || v[r][i] === '') return;
      sh.getRange(r + 1, i + 1).setValue(round2_((Number(v[r][i]) || 0) * 100 / pg));
    });
  }
  idx.forEach(function (i, k) { if (i !== -1) sh.getRange(1, i + 1).setValue(noms[k]); });
}

/**
 * Alternative à migrerEnGrammes() : on repart de zéro et on rescanne tout.
 *
 * Vide produits, plats, recettes, stock et log ; PRÉSERVE objectifs et
 * parametres — le token de l'app y vit, l'effacer déconnecterait le téléphone.
 * Duplique le classeur avant toute chose.
 *
 * Ce qui est perdu et ne revient pas par le scan : les plats, les recettes et
 * leurs compositions (écrits à la main), et l'historique du bilan (4 semaines).
 *
 * Garde-fou : exige la confirmation littérale, pour qu'un lancement distrait
 * depuis l'éditeur ne puisse rien détruire.
 *   reinitialiserDonnees('EFFACER')
 */
/**
 * Point d'entrée SANS ARGUMENT, à lancer depuis le menu de l'éditeur — lequel
 * ne sait pas passer de paramètre. Le nom en majuscules tient lieu de garde-fou
 * dans une liste déroulante où l'on clique vite.
 */
function EFFACER_TOUT_ET_RECOMMENCER() {
  var r = reinitialiserDonnees('EFFACER');
  Logger.log(JSON.stringify(r, null, 2));
  return r;
}

function reinitialiserDonnees(confirmation) {
  if (confirmation !== 'EFFACER') {
    return {
      efface: false,
      mode_emploi: 'Relancer avec reinitialiserDonnees(\'EFFACER\') pour confirmer.',
      seront_vides: ['produits', 'plats', 'recettes', 'stock', 'log'],
      seront_gardes: ['objectifs', 'parametres (dont le token)'],
      perdu_definitivement: 'Plats, recettes et compositions (non rescannables) + historique du bilan.'
    };
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var copie = ss.copy('Enthalpie — sauvegarde avant remise à zéro ' +
    Utilities.formatDate(new Date(), params_().tz || 'Europe/Paris', 'yyyy-MM-dd HH:mm'));

  var vides = [];
  ['produits', 'plats', 'recettes', 'stock', 'log'].forEach(function (nom) {
    var sh = ss.getSheetByName(nom);
    if (!sh) return;
    var n = sh.getLastRow() - 1;          // hors ligne d'en-tête
    if (n > 0) sh.deleteRows(2, n);
    vides.push(nom + ' (' + Math.max(0, n) + ' ligne(s))');
  });

  Logger.log('Remise à zéro faite. Sauvegarde : ' + copie.getUrl());
  return {
    efface: true,
    vides: vides,
    sauvegarde: copie.getUrl(),
    suite: 'Lancer setup() (écrit les nouveaux en-têtes), puis rescanner les produits.'
  };
}

/** Supprime une colonne par son en-tête (no-op si absente). */
function supprimerColonne_(onglet, nom) {
  var sh = sheet_(onglet);
  var i = sh.getDataRange().getValues()[0].indexOf(nom);
  if (i !== -1) sh.deleteColumn(i + 1);
  oublierTout_();                        // la structure a bougé : tout mémo est faux
}

/** Renomme une colonne et recalcule ses valeurs via `calcul(ancienne, ligne)`. */
function renommerColonne_(onglet, avant, apres, calcul) {
  var sh = sheet_(onglet);
  var v = sh.getDataRange().getValues();
  var i = v[0].indexOf(avant);
  if (i === -1) return;
  var lignes = readTable_(onglet);
  for (var r = 1; r < v.length; r++) {
    sh.getRange(r + 1, i + 1).setValue(calcul(v[r][i], lignes[r - 1] || {}));
  }
  sh.getRange(1, i + 1).setValue(apres);
  oublierTout_();
}
