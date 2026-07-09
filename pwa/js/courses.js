// Écran « Courses » : liste de réappro auto (backend) groupée par magasin,
// + ajouts manuels en texte libre (hors compteurs, purement locaux). Les cases
// cochées, une fois validées, sont POST-ées (type courses) et incrémentent le
// stock côté backend. On coche par défaut (on rachète toute la liste) ; décocher
// = ne pas acheter cet article cette fois.
import { h, clear, num } from './util.js';
import { store } from './store.js';

/**
 * @param root      conteneur
 * @param data      { horizon_jours, groupes:{magasin:[ligne]}, lignes:[{produit_id,nom,magasin,unites,unite_de_vente,portions_manquantes}] }
 * @param handlers  { onValider(items) }  — items = [{produit_id, unites}] cochés
 */
export function renderCourses(root, data, handlers) {
  const courses = data || { horizon_jours: 0, groupes: {}, lignes: [] };
  const rerender = () => renderCourses(root, courses, handlers);

  clear(root);

  if (courses.__offline) {
    root.append(h('div', { class: 'offline-banner' }, '⚡ Hors-ligne — dernière liste connue'));
  }

  root.append(h('p', { class: 'day-caption' }, 'Liste de courses'));
  if (courses.horizon_jours) {
    root.append(h('p', { class: 'section-hint', style: 'margin: 2px 2px 6px' },
      `Réappro estimée pour les ${num(courses.horizon_jours)} prochains jours.`));
  }

  const groupes = courses.groupes || {};
  const magasins = Object.keys(groupes).filter((m) => (groupes[m] || []).length);
  const totalAuto = (courses.lignes || []).length;

  const boxes = [];   // lignes backend : { getChecked, produit_id, unites }

  /* ---------- Liste auto, groupée par magasin ---------- */
  if (!totalAuto) {
    root.append(h('div', { class: 'state', style: 'padding:40px 8px' },
      h('div', { class: 'state__icon' }, '🎉'),
      h('div', { class: 'state__title' }, 'Rien à racheter'),
      h('div', { class: 'state__msg' }, 'Ton stock couvre la période. Reviens après quelques repas.')));
  } else {
    for (const mag of magasins) {
      const lignes = groupes[mag];
      const list = h('div', { class: 'crs-list' });
      for (const l of lignes) {
        const box = h('input', { type: 'checkbox', class: 'crs-row__box', checked: true });
        const row = h('label', { class: 'crs-row is-checked' },
          box,
          h('span', { class: 'crs-row__body' },
            h('span', { class: 'crs-row__nom' }, l.nom),
            h('span', { class: 'crs-row__meta' },
              `${num(l.unites)} × ${l.unite_de_vente || 'unité'}`,
              h('span', { class: 'crs-row__hint' }, ` · manque ~${num(l.portions_manquantes)} portions`)),
          ),
        );
        box.addEventListener('change', () => {
          row.classList.toggle('is-checked', box.checked);
          updateBar();
        });
        boxes.push({ getChecked: () => box.checked, produit_id: l.produit_id, unites: l.unites });
        list.append(row);
      }
      root.append(h('section', { class: 'crs-group' },
        h('div', { class: 'crs-group__head' },
          h('span', { class: 'crs-group__mag' }, mag),
          h('span', { class: 'crs-group__count' }, String(lignes.length))),
        list,
      ));
    }
  }

  /* ---------- Ajouts manuels (texte libre, hors compteurs) ---------- */
  const manual = store.getCoursesManual();
  const manualBoxes = [];   // { getChecked, id }
  const manualList = h('div', { class: 'crs-list' });
  for (const it of manual) {
    const box = h('input', { type: 'checkbox', class: 'crs-row__box', checked: true });
    const del = h('button', { class: 'crs-row__del', type: 'button', 'aria-label': `Retirer ${it.texte}` }, '✕');
    const row = h('label', { class: 'crs-row crs-row--manual is-checked' },
      box,
      h('span', { class: 'crs-row__body' }, h('span', { class: 'crs-row__nom' }, it.texte)),
      del,
    );
    box.addEventListener('change', () => { row.classList.toggle('is-checked', box.checked); updateBar(); });
    del.addEventListener('click', (e) => { e.preventDefault(); store.removeCoursesManual(it.id); rerender(); });
    manualBoxes.push({ getChecked: () => box.checked, id: it.id });
    manualList.append(row);
  }

  const input = h('input', { type: 'text', class: 'crs-add__input',
    placeholder: 'Ajouter un article…', autocomplete: 'off', spellcheck: 'false' });
  const addBtn = h('button', { class: 'crs-add__btn', type: 'button', 'aria-label': 'Ajouter' }, '＋');
  function addManual() {
    const t = input.value.trim();
    if (!t) return;
    store.addCoursesManual(t);
    rerender();
  }
  addBtn.addEventListener('click', addManual);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addManual(); } });

  root.append(h('section', { class: 'crs-group crs-group--manual' },
    h('div', { class: 'crs-group__head' },
      h('span', { class: 'crs-group__mag' }, 'Ajouts manuels'),
      manual.length ? h('span', { class: 'crs-group__count' }, String(manual.length)) : null),
    manual.length ? manualList : h('p', { class: 'crs-empty' }, 'Rien pour l’instant — ajoute ce que le calcul n’a pas prévu.'),
    h('div', { class: 'crs-add' }, input, addBtn),
  ));

  /* ---------- Barre de validation ---------- */
  const countEl = h('span', { class: 'valbar__count' });
  const bar = h('div', { class: 'valbar', hidden: true },
    h('span', { class: 'valbar__info' }, h('span', { class: 'valbar__dot', style: 'background:var(--accent)' }), countEl),
    h('div', { class: 'valbar__actions' },
      h('button', { class: 'valbar__valider', type: 'button', onclick: onValider }, 'Valider les courses')),
  );
  root.append(bar);

  function updateBar() {
    const n = boxes.filter((b) => b.getChecked()).length + manualBoxes.filter((b) => b.getChecked()).length;
    bar.hidden = n === 0;
    countEl.textContent = `${n} article${n > 1 ? 's' : ''} coché${n > 1 ? 's' : ''}`;
  }

  function onValider() {
    const items = boxes.filter((b) => b.getChecked())
      .map((b) => ({ produit_id: b.produit_id, unites: b.unites }));
    const manualIds = manualBoxes.filter((b) => b.getChecked()).map((b) => b.id);
    if (!items.length && !manualIds.length) return;

    // Optimiste : retire de la vue les lignes validées.
    manualIds.forEach((id) => store.removeCoursesManual(id));
    const done = new Set(items.map((i) => i.produit_id));
    courses.lignes = (courses.lignes || []).filter((l) => !done.has(l.produit_id));
    for (const mag of Object.keys(courses.groupes || {})) {
      courses.groupes[mag] = (courses.groupes[mag] || []).filter((l) => !done.has(l.produit_id));
    }

    handlers.onValider(items);
    rerender();
  }

  updateBar();
}
