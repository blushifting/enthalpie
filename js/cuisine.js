// Écran « Cuisine » : recette de la semaine (badge nouveau / batch classique),
// bibliothèque des recettes batch (« je l'ai cuisinée » = POST batch_cuisine) et
// compteurs gamifiés (SPEC §4.3, §7). Lecture + une action par recette.
import { h, clear, num, macroChips, frDate } from './util.js';

function macrosLine(m) {
  return h('div', { class: 'recipe-card__macros' },
    ...macroChips(m).map(([k, v]) => h('span', {}, h('b', {}, v), ' ', k)));
}

function stockChip(rec) {
  const n = Number(rec.stock_portions) || 0;
  return n > 0
    ? h('span', { class: 'recipe-card__stock is-stocked' }, `${num(n)} en stock`)
    : h('span', { class: 'recipe-card__stock' }, 'à cuisiner');
}

/** Carte recette : hero = recette de la semaine, sinon carte de bibliothèque. */
function recipeCard(rec, handlers, { hero = false } = {}) {
  const portions = Number(rec.portions_produites) || 0;
  const isNew = rec.nouveau || rec.jamais_cuisinee;
  const badge = hero
    ? h('span', { class: `recipe-card__badge ${isNew ? 'is-new' : ''}` }, isNew ? '✨ Nouveau' : '♻ Batch classique')
    : (isNew ? h('span', { class: 'recipe-card__badge is-new' }, '✨ Nouveau') : null);

  const meta = h('div', { class: 'recipe-card__meta' },
    `Produit ${num(portions)} portion${portions > 1 ? 's' : ''}`,
    rec.derniere_realisation ? ` · cuisiné le ${frDate(rec.derniere_realisation)}` : ' · jamais cuisiné');

  // Instructions repliables (pas de recette → pas de bouton).
  const steps = h('p', { class: 'recipe-card__steps', hidden: true }, rec.instructions || '');
  const toggle = rec.instructions
    ? h('button', { class: 'recipe-card__toggle', type: 'button' }, 'Voir la recette')
    : null;
  if (toggle) toggle.addEventListener('click', () => {
    const on = steps.hidden;
    steps.hidden = !on;
    toggle.textContent = on ? 'Masquer la recette' : 'Voir la recette';
    toggle.classList.toggle('is-on', on);
  });

  const cta = h('button', { class: 'recipe-card__cta', type: 'button' },
    h('span', {}, 'Je l’ai cuisinée'),
    portions ? h('span', { class: 'recipe-card__cta-sub' }, `+${num(portions)} portion${portions > 1 ? 's' : ''}`) : null);
  // Désactive à la volée pour éviter un double POST ; la vue est reconstruite après.
  cta.addEventListener('click', () => { cta.disabled = true; handlers.onCuisiner(rec); });

  return h('article', { class: `recipe-card ${hero ? 'recipe-card--hero' : ''}` },
    h('div', { class: 'recipe-card__top' },
      h('div', { class: 'recipe-card__titles' }, badge, h('h3', { class: 'recipe-card__nom' }, rec.nom)),
      stockChip(rec)),
    macrosLine(rec.macros),
    meta,
    toggle,
    steps,
    cta);
}

function statsRow(stats) {
  const s = stats || {};
  const cell = (value, label, cls) =>
    h('div', { class: `cuisine-stat ${cls || ''}` }, h('b', {}, value), h('span', {}, label));
  const calib = s.calibration_jours == null ? '—' : `${s.calibration_jours} j`;
  return h('section', { class: 'cuisine-stats' },
    cell(`${num(s.streak_prot || 0)} sem.`, 'streak protéines', 'is-streak'),
    cell(num(s.recettes_essayees || 0), 'recettes essayées'),
    cell(num(s.recettes_adoptees || 0), 'adoptées'),
    cell(calib, 'depuis calibration'));
}

/**
 * @param root      conteneur
 * @param data      { recette_semaine, bibliotheque:[...], stats:{...} }
 * @param handlers  { onCuisiner(recette) }
 */
export function renderCuisine(root, data, handlers) {
  const d = data || { recette_semaine: null, bibliotheque: [], stats: {} };
  clear(root);

  if (d.__offline) {
    root.append(h('div', { class: 'offline-banner' }, '⚡ Hors-ligne — dernière cuisine connue'));
  }

  root.append(h('p', { class: 'day-caption' }, 'Cuisine'));
  root.append(statsRow(d.stats));

  const biblio = d.bibliotheque || [];
  const featuredId = d.recette_semaine && d.recette_semaine.recette_id;

  if (d.recette_semaine) {
    root.append(h('div', { class: 'section-hint', style: 'margin:20px 2px 8px' }, 'Recette de la semaine'));
    root.append(recipeCard(d.recette_semaine, handlers, { hero: true }));
  }

  // Bibliothèque : les autres recettes batch (la vedette est déjà mise en avant).
  const reste = biblio.filter((r) => r.recette_id !== featuredId);
  root.append(h('div', { class: 'list-head', style: 'margin-top:24px' },
    h('span', {}, 'Recettes batch'),
    h('span', { class: 'list-head__hint' }, String(reste.length))));

  if (!reste.length && !d.recette_semaine) {
    root.append(h('div', { class: 'state', style: 'padding:40px 8px' },
      h('div', { class: 'state__icon' }, '🍳'),
      h('div', { class: 'state__title' }, 'Pas encore de recettes'),
      h('div', { class: 'state__msg' }, 'Les recettes batch ajoutées au catalogue apparaîtront ici.')));
  } else if (!reste.length) {
    root.append(h('p', { class: 'crs-empty' }, 'Aucune autre recette batch pour l’instant.'));
  } else {
    const list = h('div', { class: 'recipe-list' });
    reste.forEach((r) => list.append(recipeCard(r, handlers)));
    root.append(list);
  }
}
