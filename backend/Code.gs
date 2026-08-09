/**
 * Enthalpie — Backend Apps Script (WebApp)
 * ----------------------------------------
 * Source de vérité : le Google Sheet porteur de ce script.
 * Déploiement : Déployer > Nouveau déploiement > Application Web
 *   - Exécuter en tant que : moi
 *   - Accès : tout le monde (l'auth réelle se fait par token dans l'URL)
 *
 * Endpoints :
 *   GET  ?token=…&action=state          → jauges du jour, pools par créneau, stock
 *   GET  ?token=…&action=catalog        → produits + plats actifs
 *   GET  ?token=…&action=courses        → liste de courses (par magasin/rayon)
 *   GET  ?token=…&action=cuisine        → recette de la semaine + biblio batch + compteurs
 *   GET  ?token=…&action=bilan          → prot/kcal/fibres vs cibles : 7 derniers jours + 4 sem.
 *   POST {token, action:'log', ...}     → plat | produit | pot_fini | batch_cuisine | courses | ajustement | exterieur
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
  produits: [
    'id', 'nom', 'marque_magasin', 'ean', 'poids_paquet_g',
    'kcal_100g', 'prot_100g', 'fibres_100g', 'flag_gluten', 'flag_lactose', 'perissable_jours', 'actif'
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
  ]
};

// Valeurs de créneau reconnues (SPEC §3.2).
var CRENEAUX = ['petit_dej', 'dejeuner', 'diner', 'collation'];

/* ===================================================================== */
/* 2. SETUP — création / réinitialisation des onglets                    */
/* ===================================================================== */

/**
 * À exécuter UNE FOIS à la main depuis l'éditeur Apps Script après avoir
 * collé ce fichier dans le Sheet. Crée les 7 onglets avec en-têtes et
 * pré-remplit objectifs (cibles du skill nutrition) + parametres.
 * Idempotent : ne réécrit pas les en-têtes si déjà présents.
 */
function setup() {
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
    SpreadsheetApp.getActiveSpreadsheet().toast('Setup terminé — 7 onglets prêts.', 'Enthalpie', 5);
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

/** Lit un onglet en tableau d'objets {header: valeur}. */
function readTable_(name) {
  var sh = sheet_(name);
  var values = sh.getDataRange().getValues();
  if (values.length < 2) return [];
  var headers = values[0];
  return values.slice(1)
    .filter(function (row) { return row.join('') !== ''; })
    .map(function (row) {
      var o = {};
      headers.forEach(function (h, i) { o[h] = row[i]; });
      o._row = null; // rempli au besoin par les fonctions qui écrivent
      return o;
    });
}

/** Ajoute une ligne depuis un objet, dans l'ordre des en-têtes. */
function appendRow_(name, obj) {
  var sh = sheet_(name);
  var headers = SCHEMA[name];
  sh.appendRow(headers.map(function (h) {
    return obj[h] === undefined ? '' : obj[h];
  }));
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

function handle_(e, p) {
  try {
    checkToken_(p.token);
    var action = p.action || 'state';
    var result;
    switch (action) {
      case 'state':          result = getState_(); break;
      case 'catalog':        result = getCatalog_(); break;
      case 'courses':        result = getCourses_(); break;
      case 'cuisine':        result = getCuisine_(); break;
      case 'bilan':          result = getBilan_(); break;
      case 'search_catalog': result = searchCatalog_(p.q); break;
      case 'log':            result = postLog_(p); break;
      case 'add_produit':    result = addProduit_(p); break;
      default: throw new Error('Action inconnue : ' + action);
    }
    return json_({ ok: true, action: action, data: result });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
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

  // Consommation du jour à partir du log (plats ET produits bruts loggués au curseur)
  var conso = { kcal: 0, prot_g: 0, fibres_g: 0 };
  readTable_('log').forEach(function (l) {
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

  // Pools par créneau : plats actifs, marqués faisables ou non selon le stock
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
    stock: stock
  };
}

function getCatalog_() {
  // Un plat cuisiné n'a pas d'emballage : son « paquet » est la fournée. Le
  // front en a besoin comme référence du curseur (% de la fournée mangé), et
  // ce poids n'est pas une colonne — il se déduit de la composition.
  var plats = readTable_('plats').filter(actif_).map(function (pl) {
    pl.poids_fournee_g = Math.round(poidsFournee_(pl));
    return pl;
  });
  return { produits: readTable_('produits').filter(actif_), plats: plats };
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

/** Apports journaliers reconstruits du journal : plats (médian inclus) + produits bruts. */
function intakeParJour_(tz) {
  var platsById = indexBy_(readTable_('plats'), 'id');
  var produitsById = indexBy_(readTable_('produits'), 'id');
  var parJour = {};
  readTable_('log').forEach(function (l) {
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
 * protéines (nb de semaines récentes consécutives dans la fenêtre prot). La
 * semaine courante est partielle : on divise par les jours écoulés, pas 7.
 * `parJour` est optionnel (recalculé si absent) — getBilan_ le partage avec
 * joursRecents_ pour ne lire le journal qu'une fois.
 */
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
  var streak = 0;
  if (cibleProt > 0) {
    for (var i = semaines.length - 1; i >= 0; i--) {
      if (semaines[i].jours_avec_donnees > 0 && semaines[i].moyennes.prot_g >= cibleProt - tolProt) streak++;
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
    streak_prot: streak
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
    actif: 'oui'
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
    ean: String(pr.ean || ''), actif: pr.actif
  };
}

/** Ajustement manuel de stock (secours). */
function ajustement_(p, now) {
  if (!p.ref) throw new Error('ref requis.');
  var delta = Number(p.delta);
  if (isNaN(delta)) throw new Error('delta numérique requis.');
  adjustStock_(p.ref, delta);
  appendRow_('log', { timestamp: now, type: 'ajustement', ref: p.ref, quantite: delta, source: p.source || 'manuel' });
  return { ajuste: p.ref, delta: delta };
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
  readTable_('log').forEach(function (l) {
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
}
