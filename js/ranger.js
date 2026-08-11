// Feuille « Ranger mes produits » : une pastille de catégorie par produit, en
// une passe. C'est le seul moyen de peupler la colonne `categorie` d'un
// catalogue existant sans saisie manuelle dans le Sheet.
//
// Les catégories proposées viennent du NOM du produit (categories.js) : elles
// sont pré-sélectionnées mais rien n'est envoyé tant qu'Azur n'a pas validé —
// une devinette écrite en silence serait indétectable, alors qu'une case vide
// se voit.
import { h, clear, toast } from './util.js';
import { CATEGORIES } from './config.js';
import { devineCategorie, normaliser } from './categories.js';
import { ApiError } from './api.js';

/**
 * openRanger(foods, onSave)
 * foods  : [{id, nom, kind, categorie}] — le catalogue complet, stock ou pas :
 *          ranger un produit épuisé évite d'y revenir au prochain réappro.
 * onSave : (items:[{produit_id, categorie}]) => Promise
 */
export function openRanger(foods, onSave) {
  const root = document.getElementById('sheet-root');
  clear(root);
  const backdrop = h('div', { class: 'sheet-backdrop' });
  const close = () => backdrop.remove();
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

  // Les plats batch n'ont pas de colonne `categorie` (onglet `plats`) : rien à
  // ranger pour eux, ils sont exclus plutôt que présentés sans effet.
  const produits = (foods || [])
    .filter((f) => f.kind !== 'plat')
    .slice()
    .sort((a, b) => normaliser(a.nom).localeCompare(normaliser(b.nom)));

  // Choix courant par produit : ce qui est déjà rangé fait foi, sinon la
  // devinette. `null` n'existe pas ici — '' est un choix valide (non rangé).
  const choix = {};
  const initial = {};
  produits.forEach((p) => {
    const dejaRange = String(p.categorie || '');
    choix[p.id] = dejaRange || devineCategorie(p.nom);
    initial[p.id] = dejaRange;
  });

  const compteur = h('span', { class: 'ranger-count' });
  const save = h('button', { class: 'btn btn--primary', type: 'button' }, 'Enregistrer le rangement');
  const errEl = h('div', { class: 'form-error' });

  function majCompteur() {
    const restants = produits.filter((p) => !choix[p.id]).length;
    compteur.textContent = restants
      ? `${restants} produit${restants > 1 ? 's' : ''} sans rangement`
      : 'Tout est rangé';
  }

  const liste = h('div', { class: 'ranger-list' });
  produits.forEach((p) => {
    const pastilles = [];
    const setChoix = (id) => {
      choix[p.id] = id;
      pastilles.forEach(({ id: i, b }) => {
        b.classList.toggle('is-on', i === choix[p.id]);
        b.setAttribute('aria-pressed', i === choix[p.id] ? 'true' : 'false');
      });
      majCompteur();
    };
    const rangee = h('div', { class: 'ranger-chips' });
    CATEGORIES.forEach((c) => {
      const b = h('button', {
        class: `inv-filtre ${c.id === choix[p.id] ? 'is-on' : ''}`, type: 'button',
        'aria-pressed': c.id === choix[p.id] ? 'true' : 'false',
        'aria-label': `${p.nom} — ${c.label}`,
      }, c.court);
      // Re-taper la pastille active la retire : c'est la seule façon de dire
      // « finalement je ne sais pas » sans quitter l'écran.
      b.addEventListener('click', () => setChoix(c.id === choix[p.id] ? '' : c.id));
      pastilles.push({ id: c.id, b });
      rangee.append(b);
    });
    liste.append(h('div', { class: 'ranger-item' },
      h('div', { class: 'ranger-item__nom' }, p.nom), rangee));
  });

  save.addEventListener('click', async () => {
    // N'envoie que ce qui change : le Sheet n'a aucune raison d'être réécrit
    // en entier parce qu'on a ouvert l'écran.
    const items = produits
      .filter((p) => choix[p.id] !== initial[p.id])
      .map((p) => ({ produit_id: p.id, categorie: choix[p.id] }));
    if (!items.length) { close(); toast('Rien à changer', 'ok'); return; }
    save.disabled = true; errEl.textContent = '';
    try {
      await onSave(items);
      close();
      toast(`${items.length} produit${items.length > 1 ? 's' : ''} rangé${items.length > 1 ? 's' : ''}`, 'ok');
    } catch (err) {
      save.disabled = false;
      errEl.textContent = err instanceof ApiError ? err.message : 'Enregistrement impossible';
    }
  });

  majCompteur();

  const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' },
    h('div', { class: 'sheet__handle' }),
    h('h2', {}, 'Ranger mes produits'),
    h('p', { class: 'sub' },
      'Une pastille par produit : où le ranges-tu ? Les propositions sont devinées ',
      'depuis le nom — vérifie-les. Re-taper la pastille active l’enlève.'),
    h('div', { class: 'ranger-head' }, compteur),
    liste,
    errEl,
    h('div', { class: 'sheet__actions' },
      h('button', { class: 'btn btn--ghost', type: 'button', onclick: close }, 'Annuler'),
      save));

  backdrop.append(sheet);
  root.append(backdrop);
}
