// Catégories de rangement du stock (choix d'Azur du 2026-08-11 : « où est-ce
// rangé » plutôt que « qu'est-ce que ça apporte »). Un produit n'en porte
// qu'une ; vide = pas encore rangé.
//
// La devinette ci-dessous ne sert QU'À PRÉ-SÉLECTIONNER une pastille dans
// l'écran de rangement : elle propose, Azur tranche. Elle ne s'écrit jamais
// toute seule dans le Sheet — une catégorie fausse posée en silence serait pire
// qu'une case vide, qui, elle, se voit.
import { CATEGORIES } from './config.js';

/** Libellé lisible d'une catégorie ('' → « Non rangé »). */
export function labelCategorie(id) {
  const c = CATEGORIES.find((x) => x.id === id);
  return c ? c.label : 'Non rangé';
}

/**
 * Minuscules sans accents : « Épinards » et « epinards » doivent matcher.
 * Les ligatures sont traitées à part — `normalize('NFD')` ne décompose PAS
 * « œ », si bien que « Œufs » ne répondait ni à la devinette ni à une recherche
 * tapée « oeufs ».
 */
export function normaliser(s) {
  return String(s || '').toLowerCase()
    .replace(/œ/g, 'oe').replace(/æ/g, 'ae')
    .normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Ordre significatif : le premier motif qui accroche gagne. « Épinards
// surgelés » doit tomber dans congélo, pas dans fruits & légumes — le mode de
// conservation prime sur la nature de l'aliment.
const INDICES = [
  ['congelo', /surgel|congel|glacon/],
  ['epices', /\b(sel|poivre|curry|curcuma|cumin|paprika|cannelle|muscade|herbe|basilic|thym|laurier|origan|persil|epice|bouillon|vinaigre|moutarde|ketchup|sauce soja|tabasco|harissa)\b/],
  ['frigo', /yaourt|skyr|fromage|lait\b|creme|beurre|margarine|\boeuf|tofu|tempeh|seitan|houmous|jambon|saucisse|charcuterie|pate a|levure fraiche|tzatziki|compote fraiche/],
  ['fruits_legumes', /pomme|banane|orange|citron|clementine|poire|raisin|fraise|avocat|tomate|salade|laitue|carotte|courgette|brocoli|chou|epinard|poireau|oignon|echalote|\bail\b|poivron|champignon|concombre|aubergine|haricot vert|patate|celeri|betterave|radis|navet|potiron|courge/],
  ['placard', /riz|pate|spaghetti|penne|semoule|quinoa|boulgour|lentille|pois chiche|haricot|feve|farine|sucre|huile|avoine|muesli|granola|cereale|conserve|bocal|thon|sardine|biscuit|chocolat|amande|noix|noisette|cajou|pistache|graine|sesame|lin\b|chia|levure|cafe|the\b|infusion|miel|confiture|compote|galette|pain|tortilla|couscous|polenta|soja texture|proteine de/],
];

/**
 * Catégorie probable d'un produit d'après son nom. '' quand rien n'accroche —
 * ne jamais deviner au hasard : une case vide se corrige, une case fausse se
 * recopie.
 */
export function devineCategorie(nom) {
  const n = normaliser(nom);
  for (const [id, motif] of INDICES) if (motif.test(n)) return id;
  return '';
}
