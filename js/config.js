// Constantes globales (aucun secret ici — le token vit en localStorage).

// Version du build, affichée dans Réglages.
// ⚠️ À garder synchro avec `CACHE` dans `sw.js` — les deux sont bumpés ensemble
// à chaque release. Pas de source unique possible : `sw.js` est un worker
// classique, il ne peut pas importer ce module. L'écran Réglages affiche donc
// les DEUX valeurs : si elles divergent, l'anomalie se voit au lieu de rester
// silencieuse (typiquement : app-shell en cache plus vieux que le code chargé).
export const APP_VERSION = 'v21';

// API_BASE du backend Apps Script déjà déployé (cf. BUILD-PWA.md §1).
export const DEFAULT_API_BASE =
  'https://script.google.com/macros/s/AKfycbykJsqIOSd40mhD9YNOHg42rEhgg_Bzf_EAdMJnEaaiD1C9P29Ukg4x44mUcW00SBSN/exec';

// Cibles nutritionnelles de repli (skill nutrition §6, figées le 2026-08-09).
//
// Le backend est la source de vérité — ces valeurs ne servent QUE si la réponse
// arrive sans cible chiffrée (`cible: 0` → `ratio: null`), ce qui suffisait
// jusqu'ici à faire basculer la jauge fibres en « informatif ». Une jauge dure
// ne doit pas dépendre du fait qu'une colonne du Sheet soit remplie : la cible
// est une décision du projet, pas une donnée d'exploitation.
export const REPLI_CIBLES = {
  fibres_g: 30,          // 30 g/j, fenêtre 25–35 g
};
export const REPLI_TOLERANCES = {
  fibres_g: 5,           // ±5 g
};

// Catégories de rangement du stock (2026-08-11) — « où est-ce rangé », et non
// « qu'est-ce que ça apporte » : on cherche un aliment là où il est posé.
// ⚠️ Les `id` doivent rester identiques à `CATEGORIES` dans backend/Code.gs.
// `court` sert aux pastilles de filtre, où la place manque sous 360 px.
export const CATEGORIES = [
  { id: 'frigo',          label: 'Frigo',              court: 'Frigo' },
  { id: 'congelo',        label: 'Congélo',            court: 'Congélo' },
  { id: 'placard',        label: 'Placard sec',        court: 'Placard' },
  { id: 'fruits_legumes', label: 'Fruits & légumes',   court: 'Fruits/lég' },
  { id: 'epices',         label: 'Épices & condiments', court: 'Épices' },
];

// Clés localStorage.
export const KEY = {
  token:   'enthalpie.token',
  apiBase: 'enthalpie.apiBase',
  state:   'enthalpie.state.cache',
  catalog: 'enthalpie.catalog.cache',
  courses: 'enthalpie.courses.cache',
  cuisine: 'enthalpie.cuisine.cache',
  bilan:   'enthalpie.bilan.cache',
  bilanMode: 'enthalpie.bilan.mode',     // échelle de l'écran Bilan : jour | semaine
  manual:  'enthalpie.courses.manual',   // ajouts manuels (texte libre)
  draft:   'enthalpie.courses.draft',    // cases cochées + quantités ajustées
  exclus:  'enthalpie.courses.exclus',   // articles « ne plus proposer »
  last:    'enthalpie.courses.last',     // dernier lot validé (pour annuler)
  queue:   'enthalpie.queue',
};
