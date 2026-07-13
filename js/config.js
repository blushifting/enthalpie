// Constantes globales (aucun secret ici — le token vit en localStorage).

// API_BASE du backend Apps Script déjà déployé (cf. BUILD-PWA.md §1).
export const DEFAULT_API_BASE =
  'https://script.google.com/macros/s/AKfycbykJsqIOSd40mhD9YNOHg42rEhgg_Bzf_EAdMJnEaaiD1C9P29Ukg4x44mUcW00SBSN/exec';

// Clés localStorage.
export const KEY = {
  token:   'enthalpie.token',
  apiBase: 'enthalpie.apiBase',
  state:   'enthalpie.state.cache',
  catalog: 'enthalpie.catalog.cache',
  courses: 'enthalpie.courses.cache',
  cuisine: 'enthalpie.cuisine.cache',
  bilan:   'enthalpie.bilan.cache',
  manual:  'enthalpie.courses.manual',   // ajouts manuels (texte libre)
  draft:   'enthalpie.courses.draft',    // cases cochées + quantités ajustées
  exclus:  'enthalpie.courses.exclus',   // articles « ne plus proposer »
  last:    'enthalpie.courses.last',     // dernier lot validé (pour annuler)
  queue:   'enthalpie.queue',
};
