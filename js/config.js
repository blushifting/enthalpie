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
  queue:   'enthalpie.queue',
};

// Créneaux dans l'ordre d'affichage (SPEC §3.2).
export const CRENEAUX = [
  { id: 'petit_dej', label: 'Petit déj', emoji: '🌅' },
  { id: 'dejeuner',  label: 'Déjeuner',  emoji: '🍽️' },
  { id: 'collation', label: 'Collation', emoji: '🍎' },
  { id: 'diner',     label: 'Dîner',     emoji: '🌙' },
];

export const CRENEAU_LABEL = Object.fromEntries(CRENEAUX.map((c) => [c.id, c.label]));
