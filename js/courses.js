// Écran « Courses » : liste de réappro auto (backend) groupée par magasin,
// + ajouts manuels en texte libre (locaux, hors compteurs, sans magasin).
//
// Modèle d'interaction (choix Azur) :
// - tout est DÉCOCHÉ par défaut : on coche ce qu'on prend (pas l'inverse) ;
// - l'état des cases + les quantités ajustées sont mémorisés (brouillon local)
//   pour survivre à un rechargement en plein magasin ;
// - « Valider » POST-e les cases cochées (type courses → +stock) puis efface leur
//   brouillon ; le reste repart de l'état par défaut (décoché) ;
// - « ✕ » sur une ligne auto = masquage local (« ne plus proposer »), réversible
//   depuis la section « Articles retirés » ;
// - un bandeau permet d'annuler le dernier lot validé.
import { h, clear, num } from './util.js';
import { store } from './store.js';

/**
 * @param root      conteneur
 * @param data      { horizon_jours, groupes:{magasin:[ligne]}, lignes:[{produit_id,nom,magasin,unites,unite_de_vente,portions_manquantes}] }
 * @param handlers  { onValider(items), onUndo(), onExclure(id, nom) }
 */
export function renderCourses(root, data, handlers) {
  const courses = data || { horizon_jours: 0, groupes: {}, lignes: [] };
  const rerender = () => renderCourses(root, courses, handlers);

  const draft = store.getCoursesDraft();            // { checked:{key:true}, qty:{id:unites} }
  const exclus = store.getCoursesExclus();          // [{id, nom}]
  const exclusIds = new Set(exclus.map((x) => x.id));

  const saveDraft = () => store.setCoursesDraft(draft);
  const setChecked = (key, on) => { if (on) draft.checked[key] = true; else delete draft.checked[key]; saveDraft(); };
  const setQty = (id, u) => { draft.qty[id] = u; saveDraft(); };

  clear(root);

  if (courses.__offline) {
    root.append(h('div', { class: 'offline-banner' }, '⚡ Hors-ligne — dernière liste connue'));
  }

  root.append(h('p', { class: 'day-caption' }, 'Liste de courses'));
  if (courses.horizon_jours) {
    root.append(h('p', { class: 'section-hint', style: 'margin: 2px 2px 6px' },
      `Réappro estimée pour les ${num(courses.horizon_jours)} prochains jours.`));
  }

  // Bandeau d'annulation du dernier lot validé.
  const last = store.getLastCourses();
  if (last && last.reverse && last.reverse.length) {
    const n = last.reverse.length;
    root.append(h('div', { class: 'undo-banner' },
      h('span', {}, `Dernières courses : ${n} article${n > 1 ? 's' : ''} ajouté${n > 1 ? 's' : ''} au stock.`),
      h('button', { class: 'undo-banner__btn', type: 'button', onclick: () => handlers.onUndo() }, '↩ Annuler')));
  }

  const groupes = courses.groupes || {};
  const boxes = [];          // lignes auto : { key, box, produit_id, getChecked, getUnites }
  const manualBoxes = [];    // ajouts manuels : { key, getChecked, id }
  const groupToggles = [];   // { refresh } pour les boutons « tout cocher »

  const visibles = (courses.lignes || []).filter((l) => !exclusIds.has(l.produit_id));

  /* ---------- Liste auto, groupée par magasin ---------- */
  if (!visibles.length) {
    root.append(h('div', { class: 'state', style: 'padding:40px 8px' },
      h('div', { class: 'state__icon' }, '🎉'),
      h('div', { class: 'state__title' }, 'Rien à racheter'),
      h('div', { class: 'state__msg' }, 'Ton stock couvre la période. Reviens après quelques repas.')));
  } else {
    for (const mag of Object.keys(groupes)) {
      const lignes = (groupes[mag] || []).filter((l) => !exclusIds.has(l.produit_id));
      if (!lignes.length) continue;

      const list = h('div', { class: 'crs-list' });
      const groupBoxes = [];

      for (const l of lignes) {
        const key = l.produit_id;
        const box = h('input', { type: 'checkbox', class: 'crs-row__box', checked: !!draft.checked[key] });
        let unites = draft.qty[key] != null ? Number(draft.qty[key]) : Number(l.unites) || 1;

        const valEl = h('span', { class: 'stepper__val' }, num(unites));
        const dec = h('button', { class: 'stepper__btn', type: 'button', 'aria-label': `Moins de ${l.nom}` }, '−');
        const inc = h('button', { class: 'stepper__btn', type: 'button', 'aria-label': `Plus de ${l.nom}` }, '＋');
        const applyQty = (u) => { unites = Math.max(1, u); valEl.textContent = num(unites); dec.disabled = unites <= 1; setQty(key, unites); };
        dec.addEventListener('click', () => applyQty(unites - 1));
        inc.addEventListener('click', () => applyQty(unites + 1));
        dec.disabled = unites <= 1;

        const excl = h('button', { class: 'crs-row__excl', type: 'button', 'aria-label': `Ne plus proposer ${l.nom}`, title: 'Ne plus proposer' }, '✕');
        excl.addEventListener('click', () => { handlers.onExclure(l.produit_id, l.nom); rerender(); });

        const row = h('div', { class: 'crs-row' + (box.checked ? ' is-checked' : '') },
          h('div', { class: 'crs-row__body' },
            h('label', { class: 'crs-row__head' }, box, h('span', { class: 'crs-row__nom' }, l.nom)),
            h('div', { class: 'crs-row__qty' }, h('div', { class: 'stepper' }, dec, valEl, inc),
              h('span', { class: 'crs-row__unit' }, `× ${l.unite_de_vente || 'unité'}`)),
            h('span', { class: 'crs-row__hint' }, `manque ~${num(l.portions_manquantes)} portions`),
          ),
          excl,
        );
        box.addEventListener('change', () => {
          row.classList.toggle('is-checked', box.checked);
          setChecked(key, box.checked);
          updateBar();
        });

        const entry = { key, box, produit_id: l.produit_id, getChecked: () => box.checked, getUnites: () => unites };
        boxes.push(entry); groupBoxes.push(entry);
        list.append(row);
      }

      const toggleAll = h('button', { class: 'crs-group__toggle', type: 'button' }, 'Tout cocher');
      const refresh = () => { toggleAll.textContent = groupBoxes.every((b) => b.getChecked()) ? 'Tout décocher' : 'Tout cocher'; };
      toggleAll.addEventListener('click', () => {
        const on = !groupBoxes.every((b) => b.getChecked());
        groupBoxes.forEach((b) => {
          b.box.checked = on;
          b.box.closest('.crs-row').classList.toggle('is-checked', on);
          setChecked(b.key, on);
        });
        updateBar();
      });
      groupToggles.push({ refresh });

      root.append(h('section', { class: 'crs-group' },
        h('div', { class: 'crs-group__head' },
          h('span', { class: 'crs-group__mag' }, mag),
          h('span', { class: 'crs-group__count' }, String(lignes.length)),
          toggleAll),
        list,
      ));
      refresh();
    }
  }

  /* ---------- Ajouts manuels (texte libre, hors compteurs, sans magasin) ---------- */
  const manual = store.getCoursesManual();
  const manualList = h('div', { class: 'crs-list' });
  for (const it of manual) {
    const key = 'm:' + it.id;
    const box = h('input', { type: 'checkbox', class: 'crs-row__box', checked: !!draft.checked[key] });
    const del = h('button', { class: 'crs-row__excl', type: 'button', 'aria-label': `Retirer ${it.texte}`, title: 'Retirer' }, '✕');
    const row = h('div', { class: 'crs-row crs-row--manual' + (box.checked ? ' is-checked' : '') },
      h('div', { class: 'crs-row__body' },
        h('label', { class: 'crs-row__head' }, box, h('span', { class: 'crs-row__nom' }, it.texte))),
      del,
    );
    box.addEventListener('change', () => { row.classList.toggle('is-checked', box.checked); setChecked(key, box.checked); updateBar(); });
    del.addEventListener('click', () => { store.removeCoursesManual(it.id); delete draft.checked[key]; saveDraft(); rerender(); });
    manualBoxes.push({ key, id: it.id, getChecked: () => box.checked });
    manualList.append(row);
  }

  const input = h('input', { type: 'text', class: 'crs-add__input', placeholder: 'Ajouter un article…', autocomplete: 'off', spellcheck: 'false' });
  const addBtn = h('button', { class: 'crs-add__btn', type: 'button', 'aria-label': 'Ajouter' }, '＋');
  const addManual = () => { const t = input.value.trim(); if (!t) return; store.addCoursesManual(t); rerender(); };
  addBtn.addEventListener('click', addManual);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addManual(); } });

  root.append(h('section', { class: 'crs-group crs-group--manual' },
    h('div', { class: 'crs-group__head' },
      h('span', { class: 'crs-group__mag' }, 'Ajouts manuels'),
      manual.length ? h('span', { class: 'crs-group__count' }, String(manual.length)) : null),
    manual.length ? manualList : h('p', { class: 'crs-empty' }, 'Rien pour l’instant — ajoute ce que le calcul n’a pas prévu.'),
    h('div', { class: 'crs-add' }, input, addBtn),
  ));

  /* ---------- Articles retirés (masquage local, réversible) ---------- */
  if (exclus.length) {
    const body = h('div', { class: 'crs-list' });
    for (const x of exclus) {
      body.append(h('div', { class: 'crs-excl-row' },
        h('span', {}, x.nom || x.id),
        h('button', { class: 'crs-excl-row__btn', type: 'button', onclick: () => { store.removeCoursesExclus(x.id); rerender(); } }, 'Remettre')));
    }
    const sec = h('section', { class: 'creneau crs-retires' },
      h('button', { class: 'creneau__head', type: 'button' },
        h('span', { class: 'creneau__emoji' }, '🚫'), 'Articles retirés',
        h('span', { class: 'creneau__count' }, String(exclus.length)),
        h('span', { class: 'creneau__chevron' }, '›')),
      h('div', { class: 'creneau__body' }, body));
    sec.querySelector('.creneau__head').addEventListener('click', () => sec.classList.toggle('is-open'));
    root.append(sec);
  }

  /* ---------- Barre de validation ---------- */
  const countEl = h('span', { class: 'valbar__count' });
  const bar = h('div', { class: 'valbar', hidden: true },
    h('span', { class: 'valbar__info' }, h('span', { class: 'valbar__dot', style: 'background:var(--accent)' }), countEl),
    h('div', { class: 'valbar__actions' },
      h('button', { class: 'valbar__valider', type: 'button', onclick: onValider }, 'Valider les courses')));
  root.append(bar);

  function updateBar() {
    const n = boxes.filter((b) => b.getChecked()).length + manualBoxes.filter((b) => b.getChecked()).length;
    bar.hidden = n === 0;
    countEl.textContent = `${n} article${n > 1 ? 's' : ''} coché${n > 1 ? 's' : ''}`;
    groupToggles.forEach((g) => g.refresh());
  }

  function onValider() {
    const autoChecked = boxes.filter((b) => b.getChecked());
    const items = autoChecked.map((b) => ({ produit_id: b.produit_id, unites: b.getUnites() }));
    const manualIds = manualBoxes.filter((b) => b.getChecked()).map((b) => b.id);
    if (!items.length && !manualIds.length) return;

    // Nettoyage brouillon + manuels validés, retrait optimiste des lignes.
    manualIds.forEach((id) => { store.removeCoursesManual(id); delete draft.checked['m:' + id]; });
    autoChecked.forEach((b) => { delete draft.checked[b.key]; delete draft.qty[b.key]; });
    saveDraft();

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
