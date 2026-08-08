/**
 * Enthalpie — Catalogue de départ
 * -------------------------------
 * Peuple les onglets `produits` et `plats`. Converti au modèle « gramme »
 * (2026-08-08) : poids du paquet en grammes, valeurs nutritionnelles POUR
 * 100 g, compositions en grammes. Plus aucune notion de portion.
 *
 * Origine des valeurs : Ciqual (ANSES) pour les génériques, OpenFoodFacts /
 * fiches marques pour les produits de marque. La conversion depuis l'ancien
 * format (par portion) est une simple division par le poids de portion, lui
 * même déduit de l'unité de vente — aucun chiffre nutritionnel n'a été inventé.
 *
 * ⚠️ TROIS PRODUITS SONT INCOMPLETS. Leur ancienne unité de vente (« au kg »,
 * « boîte de 6 », « paquet ») ne portait aucun poids, et le poids d'un paquet
 * n'a jamais été stocké : impossible de convertir leurs valeurs sans inventer.
 * Renseigne les trois poids ci-dessous et tout se recalcule — y compris les
 * huit plats qui en dépendent, aujourd'hui ignorés.
 *
 * Usage : coller dans le même projet Apps Script que Code.gs, lancer setup()
 * puis seedCatalogue() UNE fois. Réécrit produits/plats, garde le reste.
 */

/**
 * Poids d'UN paquet, en grammes. Mets un nombre à la place de null pour
 * réactiver le produit et les plats qui l'utilisent.
 *   P01 Tomates       — vendues au kilo : 1000 pour un kilo.
 *   P03 Œufs          — boîte de 6 : le poids net, souvent inscrit dessus.
 *   P17 Pain complet  — le poids du paquet.
 */
var POIDS_A_COMPLETER = { P01: null, P03: null, P17: null };

// Colonnes : id, nom, marque_magasin, ean, poids_paquet_g,
//            kcal_100g, prot_100g, fibres_100g, flag_gluten, flag_lactose,
//            perissable_jours, actif
var CATALOGUE_PRODUITS = [
  ['P02', 'Feta', 'Carrefour', '', 200, 265, 14, '', 'non', 'oui', 15, 'oui'],
  ['P04', 'Pommes de terre', 'Carrefour', '', 2000, 85, 2, '', 'non', 'non', 30, 'oui'],
  ['P05', 'Margarine', 'Carrefour', '', 250, 720, 0, '', 'non', 'non', 60, 'oui'],
  ['P06', 'Fromage affiné (comté/emmental)', 'Carrefour', '', 200, 351, 24, '', 'non', 'non', 30, 'oui'],
  ['P07', 'Skyr sans lactose', 'Carrefour', '', 150, 63, 11, '', 'non', 'non', 20, 'oui'],
  ['P08', 'HiPro à boire', 'Carrefour', '', 330, 52, 7.6, '', 'non', 'oui', 90, 'oui'],
  ['P09', 'HiPro yaourt', 'Carrefour', '', 160, 63, 9.4, '', 'non', 'oui', 20, 'oui'],
  ['P10', 'Tranches végé pois chiches (Fleury Michon)', 'Carrefour', '3302740087042', 120, 143, 8, '', 'non', 'non', 20, 'oui'],
  ['P11', 'Tofu fumé', 'Carrefour', '', 200, 150, 16, '', 'non', 'non', 15, 'oui'],
  ['P12', 'Lentilles (Cassegrain)', 'Carrefour', '', 265, 78, 7.5, '', 'non', 'non', 730, 'oui'],
  ['P13', 'Aubergines cuisinées (Cassegrain)', 'Carrefour', '', 375, 72, 1.2, '', 'non', 'non', 730, 'oui'],
  ['P14', 'Beans en sauce (Heinz)', 'Carrefour', '', 415, 92, 4.5, '', 'non', 'non', 730, 'oui'],
  ['P15', 'Riz', 'Carrefour', '', 1000, 254, 5.2, '', 'non', 'non', 730, 'oui'],
  ['P16', 'Pâtes', 'Carrefour', '', 500, 364, 14, '', 'oui', 'non', 730, 'oui'],
  ['P18', 'Truite fumée', 'Carrefour', '', 120, 180, 21, '', 'non', 'non', 10, 'oui']
];

/**
 * Produits en attente d'un poids. Valeurs conservées dans leur forme d'origine
 * (PAR PORTION + nombre de portions par paquet) : c'est la seule information
 * dont on dispose, et elle suffit à tout recalculer dès que le poids est connu.
 * [id, nom, magasin, ean, portions_par_paquet, kcal_portion, prot_portion,
 *  gluten, lactose, perissable]
 */
var PRODUITS_INCOMPLETS = [
  ['P01', 'Tomates', 'Carrefour', '', 6, 27, 1.2, 'non', 'non', 7],
  ['P03', 'Œufs', 'Carrefour', '', 3, 145, 12.6, 'non', 'non', 21],
  ['P17', 'Pain complet', 'Carrefour', '', 6, 150, 5.4, 'oui', 'non', 7]
];

// Colonnes : id, nom, creneau, composition (JSON [[produit, grammes], …]),
//            kcal_100g, prot_100g, fibres_100g, type, gabarit, actif
//   Les trois colonnes nutritionnelles vides = calculées à la volée depuis les
//   ingrédients par macrosOf_ (Code.gs).
var CATALOGUE_PLATS = [
  ['M04', 'Tofu fumé + riz + aubergines', 'dejeuner;diner', '[["P11",100],["P15",77],["P13",125]]', '', '', '', 'assemblage', 'proteine=tofu;legume=aubergine;feculent=riz', 'oui'],
  ['M09', 'Skyr (+ fruits)', 'petit_dej;collation', '[["P07",150]]', '', '', '', 'assemblage', 'proteine=skyr', 'oui'],
  ['M10', 'HiPro à boire', 'petit_dej;collation', '[["P08",330]]', '', '', '', 'assemblage', 'proteine=hipro', 'oui'],
  ['M11', 'HiPro yaourt', 'petit_dej;collation', '[["P09",160]]', '', '', '', 'assemblage', 'proteine=hipro', 'oui'],
  ['M13', 'Tranches pois chiches (collation)', 'collation', '[["P10",120]]', '', '', '', 'assemblage', 'proteine=pois-chiche', 'oui']
];

/**
 * Plats dépendant d'au moins un produit incomplet. Composition dans sa forme
 * d'origine (en portions) : convertie automatiquement dès que les poids
 * manquants sont renseignés.
 */
var PLATS_INCOMPLETS = [
  ['M01', 'Tomates-feta + truite fumée + pain', 'dejeuner;diner', 'P01:1,P02:1,P18:1,P17:1,P06:1', 'proteine=truite;legume=tomate;feculent=pain'],
  ['M02', 'Salade tomates-feta + œufs', 'dejeuner;diner', 'P01:1,P02:1,P03:1', 'proteine=oeuf;legume=tomate'],
  ['M03', 'Tomates + tranches pois chiches + pain', 'dejeuner;diner', 'P01:1,P10:2,P17:1', 'proteine=pois-chiche;legume=tomate;feculent=pain'],
  ['M05', 'Lentilles + œufs + tomates', 'dejeuner;diner', 'P12:1,P03:1,P01:1', 'proteine=lentille+oeuf;legume=tomate'],
  ['M06', 'Beans sur pain + fromage', 'petit_dej;dejeuner;diner', 'P14:1,P17:1,P06:1', 'proteine=beans;feculent=pain'],
  ['M07', 'Pâtes + fromage + tomates', 'dejeuner;diner', 'P16:1,P06:1,P01:1', 'proteine=fromage;legume=tomate;feculent=pates'],
  ['M08', 'Pommes de terre + œufs + tomates', 'dejeuner;diner', 'P04:1,P03:1,P01:1', 'proteine=oeuf;legume=tomate;feculent=pdt'],
  ['M12', 'Fromage + pain', 'collation', 'P06:1,P17:1', 'proteine=fromage;feculent=pain']
];

/** Poids d'une portion, par produit — nécessaire pour convertir les compositions. */
function portionsParProduit_() {
  var pg = {};
  CATALOGUE_PRODUITS.forEach(function (r) {
    // Produits déjà convertis : la composition les référence en grammes, on
    // repart du paquet entier (une « portion » historique n'existe plus).
    pg[r[0]] = { paquet: r[4], portion: null };
  });
  PRODUITS_INCOMPLETS.forEach(function (r) {
    var poids = Number(POIDS_A_COMPLETER[r[0]]);
    if (poids > 0) pg[r[0]] = { paquet: poids, portion: poids / r[4] };
  });
  return pg;
}

/** Écrit produits + plats (efface les anciennes lignes, garde les en-têtes). */
function seedCatalogue() {
  var produits = CATALOGUE_PRODUITS.slice();
  var plats = CATALOGUE_PLATS.slice();
  var enAttente = [];

  // Portions historiques des produits déjà convertis, pour les compositions.
  var portionHist = { P02: 40, P04: 200, P05: 10, P06: 200 / 6, P07: 150, P08: 330,
    P09: 160, P10: 60, P11: 100, P12: 132.5, P13: 125, P14: 207.5, P15: 1000 / 13,
    P16: 500 / 7, P18: 60 };

  PRODUITS_INCOMPLETS.forEach(function (r) {
    var poids = Number(POIDS_A_COMPLETER[r[0]]);
    if (!(poids > 0)) { enAttente.push(r[0] + ' ' + r[1]); return; }
    var portion = poids / r[4];
    portionHist[r[0]] = portion;
    produits.push([r[0], r[1], r[2], r[3], Math.round(poids),
      Math.round(r[5] / portion * 100), Math.round(r[6] / portion * 1000) / 10,
      '', r[7], r[8], r[9], 'oui']);
  });

  PLATS_INCOMPLETS.forEach(function (p) {
    var parts = String(p[3]).split(',').map(function (x) { return x.split(':'); });
    var manque = parts.some(function (kv) { return !(portionHist[kv[0]] > 0); });
    if (manque) return;
    var compo = parts.map(function (kv) {
      return [kv[0], Math.round(Number(kv[1]) * portionHist[kv[0]])];
    });
    plats.push([p[0], p[1], p[2], JSON.stringify(compo), '', '', '', 'assemblage', p[4], 'oui']);
  });

  writeTable_('produits', produits);
  writeTable_('plats', plats);
  setParam_('magasins_ordre', 'Carrefour,Picard');

  var msg = produits.length + ' produits, ' + plats.length + ' plats.';
  if (enAttente.length) {
    msg += ' EN ATTENTE (poids manquant) : ' + enAttente.join(', ') + '.';
    Logger.log('Produits non écrits, faute de poids de paquet : ' + enAttente.join(', ')
      + '\nRenseigne POIDS_A_COMPLETER en haut de SeedCatalogue.gs, puis relance.');
  }
  SpreadsheetApp.getActiveSpreadsheet().toast('Catalogue chargé : ' + msg, 'Enthalpie', 8);
  return { produits: produits.length, plats: plats.length, en_attente: enAttente };
}

/** Remplace le corps d'un onglet (sous la ligne d'en-têtes) par `rows`. */
function writeTable_(name, rows) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) throw new Error('Onglet manquant : ' + name + ' (lancer setup() d’abord).');
  var lastRow = sh.getLastRow();
  if (lastRow > 1) sh.getRange(2, 1, lastRow - 1, sh.getLastColumn()).clearContent();
  if (rows.length) sh.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
}

/** Met à jour (ou crée) une clé de l'onglet parametres. */
function setParam_(cle, valeur) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('parametres');
  var values = sh.getDataRange().getValues();
  for (var r = 1; r < values.length; r++) {
    if (String(values[r][0]) === cle) { sh.getRange(r + 1, 2).setValue(valeur); return; }
  }
  sh.appendRow([cle, valeur]);
}
