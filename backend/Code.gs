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
 *   GET  ?token=…&action=bilan          → moyennes hebdo prot/fer/kcal vs cibles (4 sem.)
 *   POST {token, action:'log', ...}     → plat | produit | pot_fini | batch_cuisine | courses | ajustement | exterieur
 *   POST {token, action:'cloture'}      → clôture médiane du jour (aussi appelable par trigger)
 *
 * Conforme à SPEC.md §3 (modèle de données) et §5-6 (moteur / liste).
 * 100 % déterministe, aucune IA ici (SPEC §1 principe 6).
 */

/* ===================================================================== */
/* 1. SCHÉMA DES ONGLETS                                                  */
/* ===================================================================== */

var SCHEMA = {
  produits: [
    'id', 'nom', 'marque_magasin', 'ean', 'unite_de_vente', 'portions_par_unite',
    'kcal', 'prot_g', 'fer_mg', 'flag_gluten', 'flag_lactose', 'perissable_jours', 'actif'
  ],
  plats: [
    'id', 'nom', 'creneau', 'composition', 'kcal', 'prot_g', 'fer_mg',
    'type', 'gabarit', 'actif'
  ],
  recettes: [
    'id', 'plat_id', 'portions_produites', 'instructions', 'derniere_realisation'
  ],
  log: [
    'timestamp', 'type', 'ref', 'quantite', 'source', 'extra'
  ],
  stock: [
    'ref', 'portions'
  ],
  objectifs: [
    'kcal_jour', 'prot_g_jour', 'fer_mg_jour', 'tol_kcal', 'tol_prot',
    'mode_strict_gluten', 'mode_strict_lactose'
  ],
  parametres: [
    'cle', 'valeur'
  ]
};

// Valeurs de créneau reconnues (SPEC §3.2). Collation = optionnel, pas de médian.
var CRENEAUX = ['petit_dej', 'dejeuner', 'diner', 'collation'];
var CRENEAUX_MEDIAN = ['petit_dej', 'dejeuner', 'diner']; // SPEC §3.4 : collation exclue

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
    //  - fer : PAS de cible dure → suivi informatif, cible = 0
    appendRow_('objectifs', {
      kcal_jour: 2850, prot_g_jour: 110, fer_mg_jour: 0,
      tol_kcal: 200, tol_prot: 10,
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

/** Objet objectifs (première ligne). */
function objectifs_() {
  var rows = readTable_('objectifs');
  return rows[0] || {};
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
      case 'cloture':        result = clotureMediane_(p.date); break;
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

/** État du jour : jauges (prot/fer/kcal consommés vs cibles), pools par créneau, stock. */
function getState_() {
  var tz = params_().tz || 'Europe/Paris';
  var today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');

  var platsById = indexBy_(readTable_('plats'), 'id');
  var produitsById = indexBy_(readTable_('produits'), 'id');
  var stock = stockMap_();

  // Consommation du jour à partir du log (plats ET produits bruts loggués au curseur)
  var conso = { kcal: 0, prot_g: 0, fer_mg: 0 };
  readTable_('log').forEach(function (l) {
    if (formatTs_(l.timestamp, tz) !== today) return;
    var m = null;
    if (l.type === 'plat') m = macrosOf_(l.ref, platsById);
    else if (l.type === 'produit') m = macrosProduit_(l.ref, produitsById);
    else if (l.type === 'exterieur') m = parseExtra_(l.extra);
    else return;
    var q = Number(l.quantite) || 1;
    conso.kcal += m.kcal * q; conso.prot_g += m.prot_g * q; conso.fer_mg += m.fer_mg * q;
  });

  var obj = objectifs_();
  var jauges = {
    prot_g: gauge_(conso.prot_g, obj.prot_g_jour),
    fer_mg: gauge_(conso.fer_mg, obj.fer_mg_jour),
    kcal:   gauge_(conso.kcal, obj.kcal_jour)
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
  return {
    produits: readTable_('produits').filter(actif_),
    plats: readTable_('plats').filter(actif_)
  };
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

  // Rythme : portions consommées par produit sur 14 j → par jour
  var perDay = consoParProduitParJour_(platsById, produitsById, 14);

  var lignes = [];
  produits.forEach(function (pr) {
    var portionsBesoin = (perDay[pr.id] || 0) * horizon;
    var enStock = Number(stock[pr.id] || 0);
    var manque = portionsBesoin - enStock;
    if (manque <= 0) return;
    var parUnite = Number(pr.portions_par_unite) || 1;
    var unites = Math.ceil(manque / parUnite); // arrondi à l'unité de vente sup.
    lignes.push({
      produit_id: pr.id, nom: pr.nom, magasin: magasinOf_(pr.marque_magasin),
      unites: unites, unite_de_vente: pr.unite_de_vente,
      portions_manquantes: round1_(manque)
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
 * qui transforme ingrédients → portions du plat batch dans le stock).
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
      portions_produites: Number(rec.portions_produites) || 0,
      instructions: String(rec.instructions || ''),
      stock_portions: round1_(Number(stock[rec.plat_id] || 0)),
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
    macros: vedette.macros, portions_produites: vedette.portions_produites,
    instructions: vedette.instructions, stock_portions: vedette.stock_portions,
    nouveau: vedette.jamais_cuisinee, derniere_realisation: vedette.derniere_realisation
  } : null;

  return {
    recette_semaine: recetteSemaine,
    bibliotheque: biblio
  };
}

/** Bilan 4 semaines glissantes : moyennes journalières prot/fer/kcal vs cibles (SPEC §4.4). */
function getBilan_() {
  return moyennesHebdo_(params_().tz || 'Europe/Paris', 4);
}

/** Apports journaliers reconstruits du journal : plats (médian inclus) + produits bruts. */
function intakeParJour_(tz) {
  var platsById = indexBy_(readTable_('plats'), 'id');
  var produitsById = indexBy_(readTable_('produits'), 'id');
  var parJour = {};
  readTable_('log').forEach(function (l) {
    var m = null;
    if (l.type === 'plat') m = macrosOf_(l.ref, platsById);
    else if (l.type === 'produit') m = macrosProduit_(l.ref, produitsById);
    else if (l.type === 'exterieur') m = parseExtra_(l.extra);
    else return;
    var q = Number(l.quantite) || 1;
    var day = formatTs_(l.timestamp, tz);
    var b = parJour[day] || (parJour[day] = { kcal: 0, prot_g: 0, fer_mg: 0 });
    b.kcal += m.kcal * q; b.prot_g += m.prot_g * q; b.fer_mg += m.fer_mg * q;
  });
  return parJour;
}

/**
 * Moyennes journalières par semaine glissante (nb semaines de 7 j finissant
 * aujourd'hui), du plus ancien au plus récent, + cibles/tolérances + streak
 * protéines (nb de semaines récentes consécutives dans la fenêtre prot). La
 * semaine courante est partielle : on divise par les jours écoulés, pas 7.
 */
function moyennesHebdo_(tz, nb) {
  var parJour = intakeParJour_(tz);
  var obj = objectifs_();
  var JOURS = 7;
  var today = new Date(Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd') + 'T12:00:00');
  var semaines = [];
  for (var w = nb - 1; w >= 0; w--) {
    var fin = new Date(today.getTime() - w * JOURS * 86400000);
    var debut = new Date(fin.getTime() - (JOURS - 1) * 86400000);
    var somme = { kcal: 0, prot_g: 0, fer_mg: 0 };
    var joursEcoules = 0, joursAvecDonnees = 0;
    for (var d = 0; d < JOURS; d++) {
      var jour = new Date(debut.getTime() + d * 86400000);
      if (jour.getTime() > today.getTime()) break;   // futur (semaine courante partielle)
      joursEcoules++;
      var b = parJour[Utilities.formatDate(jour, tz, 'yyyy-MM-dd')];
      if (b) { somme.kcal += b.kcal; somme.prot_g += b.prot_g; somme.fer_mg += b.fer_mg; joursAvecDonnees++; }
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
        fer_mg: round1_(somme.fer_mg / denom)
      }
    });
  }

  var cibleProt = Number(obj.prot_g_jour) || 0;
  var tolProt = Number(obj.tol_prot) || 0;
  var streak = 0;
  if (cibleProt > 0) {
    for (var i = semaines.length - 1; i >= 0; i--) {
      if (semaines[i].jours_avec_donnees > 0 && semaines[i].moyennes.prot_g >= cibleProt - tolProt) streak++;
      else break;
    }
  }

  return {
    cibles: { kcal: Number(obj.kcal_jour) || 0, prot_g: cibleProt, fer_mg: Number(obj.fer_mg_jour) || 0 },
    tolerances: { kcal: Number(obj.tol_kcal) || 0, prot_g: tolProt },
    semaines: semaines,
    streak_prot: streak
  };
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
    composition_(pl).forEach(function (c) {
      adjustStock_(c.produit_id, -c.nb_portions * q);
    });
  }
  return { logged: 'plat', ref: p.ref, quantite: q };
}

/**
 * Log d'un aliment brut consommé (modèle produit-centrique) : quantité en
 * PORTIONS (fractions acceptées, saisies au curseur côté PWA). Journalise et
 * décrémente le stock du produit. Ses macros par portion comptent dans les
 * jauges du jour (voir getState_).
 */
function logProduit_(p, now) {
  if (!p.ref) throw new Error('ref (produit_id) requis.');
  var produitsById = indexBy_(readTable_('produits'), 'id');
  var pr = produitsById[p.ref];
  if (!pr) throw new Error('Produit inconnu : ' + p.ref);
  var q = Number(p.quantite);
  if (!(q > 0)) throw new Error('quantite (portions) > 0 requise.');

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

  // Écart = stock qu'on croyait encore avoir (avant). S'il est positif, on a
  // sur-estimé le stock → on a donc sous-compté la conso réelle : on impute
  // cet écart aux lignes médian récentes contenant ce produit.
  var repartis = 0;
  if (avant > 0) repartis = repartirEcartSurMedian_(p.ref, avant, tz);

  return { calibrated: p.ref, stock_avant: round1_(avant), ecart_reparti: round1_(repartis) };
}

/** Batch cuisiné → crée portions_produites unités de stock du plat batch. */
function batchCuisine_(p, now) {
  if (!p.ref) throw new Error('ref (recette_id ou plat_id) requis.');
  var recettes = indexBy_(readTable_('recettes'), 'id');
  var rec = recettes[p.ref];
  var platId, portions;
  if (rec) { platId = rec.plat_id; portions = Number(rec.portions_produites) || 0; }
  else { platId = p.ref; portions = Number(p.portions) || 0; }
  if (!portions) throw new Error('portions_produites introuvable/nul.');

  // Cuisiner = transformer : − ingrédients (composition × portions produites),
  // + portions du plat batch dans le stock (ensuite loguables comme un aliment).
  var pl = indexBy_(readTable_('plats'), 'id')[platId];
  if (pl) composition_(pl).forEach(function (c) { adjustStock_(c.produit_id, -c.nb_portions * portions); });
  adjustStock_(platId, portions);
  appendRow_('log', { timestamp: now, type: 'batch_cuisine', ref: platId, quantite: portions, source: p.source || 'tap' });
  // Met à jour derniere_realisation pour la rotation des suggestions hebdo
  if (rec) touchRecette_(p.ref, now);
  return { batch: platId, portions_ajoutees: portions };
}

/** Courses validées → incrémente le stock des articles cochés. */
function coursesValidees_(p, now) {
  var items = p.items || []; // [{produit_id, unites}] ou [{produit_id, portions}]
  if (!items.length) throw new Error('items requis (liste des articles cochés).');
  var produitsById = indexBy_(readTable_('produits'), 'id');
  var ajouts = [];
  items.forEach(function (it) {
    var pr = produitsById[it.produit_id];
    if (!pr) return;
    var portions = it.portions != null
      ? Number(it.portions)
      : Number(it.unites || 1) * (Number(pr.portions_par_unite) || 1);
    adjustStock_(it.produit_id, portions);
    ajouts.push({ produit_id: it.produit_id, portions: portions });
  });
  appendRow_('log', { timestamp: now, type: 'courses', ref: '', quantite: ajouts.length, source: p.source || 'tap' });
  return { courses_validees: ajouts };
}

/**
 * Ajout d'un produit au catalogue depuis un scan (fiche OpenFoodFacts validée
 * dans la PWA). Idempotent sur l'EAN : rescanner un EAN déjà connu renvoie le
 * produit existant sans créer de doublon. Génère l'id (P + n° suivant).
 * Corps attendu : { action:'add_produit', produit:{ nom, ean, kcal, prot_g,
 *   fer_mg, unite_de_vente, portions_par_unite, flag_gluten, flag_lactose,
 *   marque_magasin?, perissable_jours?, stock_initial? } }
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
    unite_de_vente: trim_(f.unite_de_vente || ''),
    portions_par_unite: Number(f.portions_par_unite) || 1,
    kcal: Number(f.kcal) || 0,
    prot_g: Number(f.prot_g) || 0,
    fer_mg: Number(f.fer_mg) || 0,
    flag_gluten: normFlag_(f.flag_gluten),
    flag_lactose: normFlag_(f.flag_lactose),
    perissable_jours: (f.perissable_jours === '' || f.perissable_jours == null) ? '' : Number(f.perissable_jours),
    actif: 'oui'
  });

  // Stock initial optionnel (portions) ; 0 par défaut : on scanne souvent un
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
    kcal: Number(pr.kcal) || 0, prot_g: Number(pr.prot_g) || 0, fer_mg: Number(pr.fer_mg) || 0,
    unite_de_vente: pr.unite_de_vente, portions_par_unite: Number(pr.portions_par_unite) || 1,
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
  var macros = { kcal: Number(p.kcal) || 0, prot_g: Number(p.prot_g) || 0, fer_mg: Number(p.fer_mg) || 0 };
  appendRow_('log', {
    timestamp: now, type: 'exterieur', ref: p.ref || '', quantite: 1,
    source: p.source || 'tap', extra: JSON.stringify(macros)
  });
  return { exterieur: macros, ref: p.ref || '' };
}

/** Parse la colonne `extra` d'un log (JSON de macros) → {kcal,prot_g,fer_mg}. */
function parseExtra_(extra) {
  if (!extra) return { kcal: 0, prot_g: 0, fer_mg: 0 };
  try {
    var o = typeof extra === 'string' ? JSON.parse(extra) : extra;
    return { kcal: Number(o.kcal) || 0, prot_g: Number(o.prot_g) || 0, fer_mg: Number(o.fer_mg) || 0 };
  } catch (e) { return { kcal: 0, prot_g: 0, fer_mg: 0 }; }
}

/* ===================================================================== */
/* 8. CLÔTURE MÉDIANE QUOTIDIENNE (SPEC §3.4)                             */
/* ===================================================================== */

/**
 * Pour la date donnée (défaut : hier), tout créneau de CRENEAUX_MEDIAN sans
 * log « plat » reçoit une ligne médian = plat médian (en kcal) du pool.
 * À câbler sur un déclencheur temporel quotidien (voir installTriggers()).
 */
function clotureMediane_(dateStr) {
  var tz = params_().tz || 'Europe/Paris';
  var d = dateStr ? new Date(dateStr) : new Date(Date.now() - 86400000);
  var day = Utilities.formatDate(d, tz, 'yyyy-MM-dd');

  // Journée activement suivie au produit (log fractionné) → aucun médian, sinon
  // on double-compterait les apports déjà saisis au curseur.
  var hasProduit = readTable_('log').some(function (l) {
    return l.type === 'produit' && formatTs_(l.timestamp, tz) === day;
  });
  if (hasProduit) return { date: day, medians_ajoutes: [], note: 'jour suivi au produit — médian ignoré' };

  // Créneaux déjà loggés ce jour-là
  var loggedCreneaux = {};
  var platsById = indexBy_(readTable_('plats'), 'id');
  readTable_('log').forEach(function (l) {
    if (l.type !== 'plat') return;
    if (formatTs_(l.timestamp, tz) !== day) return;
    var pl = platsById[l.ref];
    if (!pl) return;
    String(pl.creneau).split(/[;,]/).map(trim_).forEach(function (c) { loggedCreneaux[c] = true; });
  });

  var ajouts = [];
  CRENEAUX_MEDIAN.forEach(function (c) {
    if (loggedCreneaux[c]) return;
    var medianId = platMedianKcal_(c, platsById);
    if (!medianId) return;
    var ts = new Date(day + 'T20:00:00'); // ancré en soirée du jour clôturé
    appendRow_('log', { timestamp: ts, type: 'plat', ref: medianId, quantite: 1, source: 'median' });
    // Décrément stock côté ingrédients aussi (cohérence du stock)
    var pl = platsById[medianId];
    if (String(pl.type) === 'batch') adjustStock_(medianId, -1);
    else composition_(pl).forEach(function (x) { adjustStock_(x.produit_id, -x.nb_portions); });
    ajouts.push({ creneau: c, plat_median: medianId });
  });
  return { date: day, medians_ajoutes: ajouts };
}

/** Plat médian (par kcal) d'un pool de créneau, parmi les plats actifs. */
function platMedianKcal_(creneau, platsById) {
  var candidats = Object.keys(platsById).map(function (k) { return platsById[k]; })
    .filter(function (pl) {
      if (!actif_(pl)) return false;
      return String(pl.creneau).split(/[;,]/).map(trim_).indexOf(creneau) !== -1;
    })
    .sort(function (a, b) { return (Number(a.kcal) || 0) - (Number(b.kcal) || 0); });
  if (!candidats.length) return null;
  return candidats[Math.floor((candidats.length - 1) / 2)].id;
}

/** Répartit un écart de portions sur les lignes médian récentes du produit. */
function repartirEcartSurMedian_(produitId, ecart, tz) {
  var platsById = indexBy_(readTable_('plats'), 'id');
  // Lignes médian récentes (30 j) dont le plat contient ce produit
  var sh = sheet_('log');
  var values = sh.getDataRange().getValues();
  var headers = values[0];
  var iType = headers.indexOf('type'), iRef = headers.indexOf('ref'),
      iQte = headers.indexOf('quantite'), iSrc = headers.indexOf('source'),
      iTs = headers.indexOf('timestamp');
  var cutoff = Date.now() - 30 * 86400000;
  var cibles = [];
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    if (row[iSrc] !== 'median') continue;
    var pl = platsById[row[iRef]];
    if (!pl) continue;
    var contient = composition_(pl).some(function (c) { return c.produit_id === produitId; });
    if (!contient) continue;
    var ts = row[iTs] instanceof Date ? row[iTs].getTime() : new Date(row[iTs]).getTime();
    if (ts < cutoff) continue;
    cibles.push(r + 1); // n° de ligne Sheet (1-based, +1 pour l'en-tête)
  }
  if (!cibles.length) return 0;
  var part = ecart / cibles.length;
  cibles.forEach(function (rowNum) {
    var cur = Number(sh.getRange(rowNum, iQte + 1).getValue()) || 1;
    sh.getRange(rowNum, iQte + 1).setValue(round2_(cur + part));
  });
  return ecart;
}

/* ===================================================================== */
/* 9. STOCK — utilitaires                                                 */
/* ===================================================================== */

function stockMap_() {
  var out = {};
  readTable_('stock').forEach(function (r) { out[String(r.ref)] = Number(r.portions) || 0; });
  return out;
}

function setStock_(ref, portions) {
  var sh = sheet_('stock');
  var values = sh.getDataRange().getValues();
  for (var r = 1; r < values.length; r++) {
    if (String(values[r][0]) === String(ref)) {
      sh.getRange(r + 1, 2).setValue(round2_(portions));
      return;
    }
  }
  sh.appendRow([ref, round2_(portions)]);
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

/** Parse le champ composition d'un plat en [{produit_id, nb_portions}].
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
        if (Array.isArray(e)) out.push({ produit_id: e[0], nb_portions: Number(e[1]) || 1 });
        else out.push({ produit_id: e.produit_id || e.id, nb_portions: Number(e.nb_portions || e.n) || 1 });
      });
      return out;
    } catch (err) { /* fallback texte */ }
  }
  s.split(',').forEach(function (part) {
    var kv = part.split(':').map(trim_);
    if (kv[0]) out.push({ produit_id: kv[0], nb_portions: Number(kv[1]) || 1 });
  });
  return out;
}

/** Macros d'un plat : colonnes pré-calculées si présentes, sinon somme des ingrédients. */
function macrosOf_(platId, platsById) {
  var pl = platsById[platId];
  if (!pl) return { kcal: 0, prot_g: 0, fer_mg: 0 };
  if (pl.kcal !== '' && pl.kcal != null) {
    return { kcal: Number(pl.kcal) || 0, prot_g: Number(pl.prot_g) || 0, fer_mg: Number(pl.fer_mg) || 0 };
  }
  var produitsById = indexBy_(readTable_('produits'), 'id');
  var m = { kcal: 0, prot_g: 0, fer_mg: 0 };
  composition_(pl).forEach(function (c) {
    var pr = produitsById[c.produit_id];
    if (!pr) return;
    m.kcal += (Number(pr.kcal) || 0) * c.nb_portions;
    m.prot_g += (Number(pr.prot_g) || 0) * c.nb_portions;
    m.fer_mg += (Number(pr.fer_mg) || 0) * c.nb_portions;
  });
  return m;
}

/** Macros par portion d'un produit brut (colonnes kcal/prot_g/fer_mg). */
function macrosProduit_(produitId, produitsById) {
  var pr = produitsById[produitId];
  if (!pr) return { kcal: 0, prot_g: 0, fer_mg: 0 };
  return { kcal: Number(pr.kcal) || 0, prot_g: Number(pr.prot_g) || 0, fer_mg: Number(pr.fer_mg) || 0 };
}

function platFaisable_(pl, stock) {
  if (String(pl.type) === 'batch') return Number(stock[pl.id] || 0) >= 1;
  return composition_(pl).every(function (c) {
    return Number(stock[c.produit_id] || 0) >= c.nb_portions;
  });
}

/**
 * Consommation quotidienne moyenne PAR PRODUIT (portions/j) sur `jours` glissants.
 * Compte tous les événements où un ingrédient quitte le stock :
 *  - log `produit` (conso au curseur) : le produit lui-même ;
 *  - log `plat` assemblage : ses ingrédients (composition × quantité) ;
 *  - log `batch_cuisine` : ses ingrédients (composition × portions produites).
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
      var plb = platsById[l.ref];
      if (plb) composition_(plb).forEach(function (c) { add(c.produit_id, c.nb_portions * q); });
    } else if (l.type === 'plat') {
      var pl = platsById[l.ref];
      if (!pl || String(pl.type) === 'batch') return;   // batch mangé → aucun ingrédient consommé
      composition_(pl).forEach(function (c) { add(c.produit_id, c.nb_portions * q); });
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
function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'clotureMedianeAuto_') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('clotureMedianeAuto_').timeBased().atHour(3).everyDays(1).create();
}

function clotureMedianeAuto_() { clotureMediane_(); }
