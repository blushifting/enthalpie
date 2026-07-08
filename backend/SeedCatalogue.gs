/**
 * Enthalpie — Catalogue de départ (Phase 2)
 * -----------------------------------------
 * Peuple les onglets `produits` et `plats` à partir des indications de l'utilisateur
 * (juillet 2026, stock estival). Valeurs PAR PORTION, sourcées Ciqual (ANSES) pour les
 * génériques et OpenFoodFacts / fiches marques pour les produits de marque.
 *
 * ⚠️ Valeurs indicatives à recaler sur l'étiquette au prochain achat (surtout les items
 * marqués « à confirmer » dans catalogue.md). Le fer est en suivi informatif (pas de cible).
 *
 * Usage : coller ce fichier dans le même projet Apps Script que Code.gs, puis exécuter
 * seedCatalogue() UNE fois. Idempotent : réécrit produits/plats (garde le reste intact).
 */

var CATALOGUE_PRODUITS = [
  // id, nom, marque_magasin, ean, unite_de_vente, portions_par_unite,
  //   kcal, prot_g, fer_mg, flag_gluten, flag_lactose, perissable_jours, actif
  ['P01', 'Tomates',                    'Carrefour', '', 'au kg',            6,   27,  1.2, 0.5, 'non', 'non',   7, 'oui'],
  ['P02', 'Feta',                       'Carrefour', '', 'paquet 200 g',     5,  106,  5.6, 0.2, 'non', 'oui',  15, 'oui'],
  ['P03', 'Œufs',                       'Carrefour', '', 'boîte de 6',       3,  145, 12.6, 1.8, 'non', 'non',  21, 'oui'],
  ['P04', 'Pommes de terre',            'Carrefour', '', 'sac 2 kg',        10,  170,  4.0, 1.4, 'non', 'non',  30, 'oui'],
  ['P05', 'Margarine',                  'Carrefour', '', 'barquette 250 g', 25,   72,  0.0, 0.0, 'non', 'non',  60, 'oui'],
  ['P06', 'Fromage affiné (comté/emmental)', 'Carrefour', '', 'morceau 200 g', 6, 117,  8.0, 0.1, 'non', 'non',  30, 'oui'],
  ['P07', 'Skyr sans lactose',          'Carrefour', '', 'pot 150 g',        1,   95, 16.5, 0.1, 'non', 'non',  20, 'oui'],
  ['P08', 'HiPro à boire',              'Carrefour', '', 'brique 330 ml',    1,  170, 25.0, 0.0, 'non', 'oui',  90, 'oui'],
  ['P09', 'HiPro yaourt',               'Carrefour', '', 'pot 160 g',        1,  100, 15.0, 0.0, 'non', 'oui',  20, 'oui'],
  ['P10', 'Tranches végé pois chiches (Fleury Michon)', 'Carrefour', '3302740087042', 'barquette 4 tr (120 g)', 2, 86, 4.8, 0.9, 'non', 'non', 20, 'oui'],
  ['P11', 'Tofu fumé',                  'Carrefour', '', 'bloc 200 g',       2,  150, 16.0, 2.4, 'non', 'non',  15, 'oui'],
  ['P12', 'Lentilles (Cassegrain)',     'Carrefour', '', 'boîte 265 g',      2,  104, 10.0, 3.0, 'non', 'non', 730, 'oui'],
  ['P13', 'Aubergines cuisinées (Cassegrain)', 'Carrefour', '', 'boîte 375 g', 3, 90,  1.5, 0.5, 'non', 'non', 730, 'oui'],
  ['P14', 'Beans en sauce (Heinz)',     'Carrefour', '', 'boîte 415 g',      2,  190,  9.4, 2.8, 'non', 'non', 730, 'oui'],
  ['P15', 'Riz',                        'Carrefour', '', 'paquet 1 kg',     13,  195,  4.0, 0.6, 'non', 'non', 730, 'oui'],
  ['P16', 'Pâtes',                      'Carrefour', '', 'paquet 500 g',     7,  260, 10.0, 1.5, 'oui', 'non', 730, 'oui'],
  ['P17', 'Pain complet',               'Carrefour', '', 'paquet',           6,  150,  5.4, 1.5, 'oui', 'non',   7, 'oui'],
  ['P18', 'Truite fumée',               'Carrefour', '', 'paquet 4 tr (120 g)', 2, 108, 12.6, 0.5, 'non', 'non', 10, 'oui']
];

var CATALOGUE_PLATS = [
  // id, nom, creneau, composition, kcal, prot_g, fer_mg, type, gabarit, actif
  //   kcal/prot/fer laissés vides → calculés à la volée depuis les ingrédients
  ['M01', 'Tomates-feta + truite fumée + pain', 'dejeuner;diner', 'P01:1,P02:1,P18:1,P17:1,P06:1', '', '', '', 'assemblage', 'proteine=truite;legume=tomate;feculent=pain', 'oui'],
  ['M02', 'Salade tomates-feta + œufs',         'dejeuner;diner', 'P01:1,P02:1,P03:1',             '', '', '', 'assemblage', 'proteine=oeuf;legume=tomate', 'oui'],
  ['M03', 'Tomates + tranches pois chiches + pain', 'dejeuner;diner', 'P01:1,P10:2,P17:1',         '', '', '', 'assemblage', 'proteine=pois-chiche;legume=tomate;feculent=pain', 'oui'],
  ['M04', 'Tofu fumé + riz + aubergines',       'dejeuner;diner', 'P11:1,P15:1,P13:1',             '', '', '', 'assemblage', 'proteine=tofu;legume=aubergine;feculent=riz', 'oui'],
  ['M05', 'Lentilles + œufs + tomates',         'dejeuner;diner', 'P12:1,P03:1,P01:1',             '', '', '', 'assemblage', 'proteine=lentille+oeuf;legume=tomate', 'oui'],
  ['M06', 'Beans sur pain + fromage',           'petit_dej;dejeuner;diner', 'P14:1,P17:1,P06:1',   '', '', '', 'assemblage', 'proteine=beans;feculent=pain', 'oui'],
  ['M07', 'Pâtes + fromage + tomates',          'dejeuner;diner', 'P16:1,P06:1,P01:1',             '', '', '', 'assemblage', 'proteine=fromage;legume=tomate;feculent=pates', 'oui'],
  ['M08', 'Pommes de terre + œufs + tomates',   'dejeuner;diner', 'P04:1,P03:1,P01:1',             '', '', '', 'assemblage', 'proteine=oeuf;legume=tomate;feculent=pdt', 'oui'],
  ['M09', 'Skyr (+ fruits)',                    'petit_dej;collation', 'P07:1',                    '', '', '', 'assemblage', 'proteine=skyr', 'oui'],
  ['M10', 'HiPro à boire',                      'petit_dej;collation', 'P08:1',                    '', '', '', 'assemblage', 'proteine=hipro', 'oui'],
  ['M11', 'HiPro yaourt',                       'petit_dej;collation', 'P09:1',                    '', '', '', 'assemblage', 'proteine=hipro', 'oui'],
  ['M12', 'Fromage + pain',                     'collation',      'P06:1,P17:1',                   '', '', '', 'assemblage', 'proteine=fromage;feculent=pain', 'oui'],
  ['M13', 'Tranches pois chiches (collation)',  'collation',      'P10:2',                         '', '', '', 'assemblage', 'proteine=pois-chiche', 'oui']
];

/** Écrit produits + plats (efface les anciennes lignes, garde les en-têtes). */
function seedCatalogue() {
  writeTable_('produits', CATALOGUE_PRODUITS);
  writeTable_('plats', CATALOGUE_PLATS);

  // Adapte l'ordre des magasins au contexte réel (Carrefour + Picard)
  setParam_('magasins_ordre', 'Carrefour,Picard');

  SpreadsheetApp.getActiveSpreadsheet()
    .toast('Catalogue chargé : ' + CATALOGUE_PRODUITS.length + ' produits, ' +
           CATALOGUE_PLATS.length + ' plats.', 'Enthalpie', 5);
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
