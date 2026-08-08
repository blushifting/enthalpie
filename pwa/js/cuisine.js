// Écran « Cuisine » : recette de la semaine (badge nouveau / batch classique),
// bibliothèque des recettes batch (« je l'ai cuisinée » = POST batch_cuisine) et
// compteurs gamifiés (SPEC §4.3, §7). Lecture + une action par recette.
import { h, clear, num, macroChips, frDate } from './util.js';

// Les macros du catalogue sont POUR 100 g ; sur une carte recette, ce qui parle
// c'est ce que la fournée entière apporte.
function macrosLine(m, poids) {
  const r = (Number(poids) || 0) / 100;
  return h('div', { class: 'recipe-card__macros' },
    ...macroChips({ kcal: Math.round((m.kcal || 0) * r), prot_g: Math.round((m.prot_g || 0) * r) })
      .map(([k, v]) => h('span', {}, h('b', {}, v), ' ', k)));
}

function stockChip(rec) {
  const n = Number(rec.stock_g) || 0;
  return n > 0
    ? h('span', { class: 'recipe-card__stock is-stocked' }, `${num(Math.round(n))} g en stock`)
    : h('span', { class: 'recipe-card__stock' }, 'à cuisiner');
}

/** Carte recette : hero = recette de la semaine, sinon carte de bibliothèque. */
function recipeCard(rec, handlers, { hero = false } = {}) {
  const poids = Number(rec.poids_produit_g) || 0;
  const isNew = rec.nouveau || rec.jamais_cuisinee;
  const badge = hero
    ? h('span', { class: `recipe-card__badge ${isNew ? 'is-new' : ''}` }, isNew ? '✨ Nouveau' : '♻ Batch classique')
    : (isNew ? h('span', { class: 'recipe-card__badge is-new' }, '✨ Nouveau') : null);

  const meta = h('div', { class: 'recipe-card__meta' },
    `Fournée de ${num(Math.round(poids))} g`,
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
    poids ? h('span', { class: 'recipe-card__cta-sub' }, `+${num(Math.round(poids))} g`) : null);
  // Désactive à la volée pour éviter un double POST ; la vue est reconstruite après.
  cta.addEventListener('click', () => { cta.disabled = true; handlers.onCuisiner(rec); });

  return h('article', { class: `recipe-card ${hero ? 'recipe-card--hero' : ''}` },
    h('div', { class: 'recipe-card__top' },
      h('div', { class: 'recipe-card__titles' }, badge, h('h3', { class: 'recipe-card__nom' }, rec.nom)),
      stockChip(rec)),
    macrosLine(rec.macros, rec.poids_produit_g),
    meta,
    toggle,
    steps,
    cta);
}

/**
 * @param root      conteneur
 * @param data      { recette_semaine, bibliotheque:[...] }
 * @param handlers  { onCuisiner(recette) }
 */
export function renderCuisine(root, data, handlers) {
  const d = data || { recette_semaine: null, bibliotheque: [] };
  clear(root);

  if (d.__offline) {
    root.append(h('div', { class: 'offline-banner' }, '⚡ Hors-ligne — dernière cuisine connue'));
  }

  root.append(h('p', { class: 'day-caption' }, 'Cuisine'));

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
