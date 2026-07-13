// Écran « Aujourd'hui » : jauges du JOUR + inventaire à curseurs.
// Modèle inventaire : chaque curseur = niveau de stock (% du plein, ou nombre
// d'unités pour les dénombrables). On baisse les curseurs au fil de la semaine ;
// un seul bouton « Valider » enregistre les baisses (= consommation → nutrition).
// Les curseurs modifiés sont surlignés jusqu'à validation.
import { h, clear, num, macroChips } from './util.js';
import { rank } from './engine.js';
import { openExterieur } from './exterieur.js';

const R = 42;
const C = 2 * Math.PI * R;

/* ---------- Jauges (apports du jour) ---------- */
function gauge({ kind, label, unit, valeur, cible, ratio }) {
  const isInfo = ratio == null;                     // fer : informatif, pas de cible
  const over = !isInfo && valeur > cible && cible > 0;
  const clamped = isInfo ? 0 : Math.max(0, Math.min(1, ratio || 0));
  const offset = C * (1 - clamped);
  const pct = isInfo ? null : Math.round((ratio || 0) * 100);

  const svg = `
    <svg viewBox="0 0 100 100" aria-hidden="true">
      <circle class="gauge__track" cx="50" cy="50" r="${R}"></circle>
      ${isInfo ? '' :
        `<circle class="gauge__fill ${over ? 'is-over' : ''}" cx="50" cy="50" r="${R}"
          stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${offset.toFixed(1)}"></circle>`}
    </svg>`;

  const badge = isInfo
    ? h('span', { class: 'gauge__badge' }, 'informatif')
    : h('span', { class: `gauge__badge ${over ? 'is-over' : pct >= 90 ? 'is-ok' : ''}` },
        over ? `+${num(valeur - cible)} ${unit}` : `${pct} %`);

  return h('div', { class: `gauge gauge--${kind}` },
    h('div', { class: 'gauge__ring' },
      h('div', { html: svg }),
      h('div', { class: 'gauge__center' },
        h('span', { class: 'gauge__value' }, num(valeur)),
        h('span', { class: 'gauge__target' }, isInfo ? unit : `/ ${num(cible)} ${unit}`),
      ),
    ),
    h('div', { class: 'gauge__label' }, label),
    badge,
  );
}

function gaugesRow(jauges) {
  return h('section', { class: 'gauges', 'aria-label': 'Apports du jour' },
    gauge({ kind: 'prot', label: 'Protéines', unit: 'g',
      valeur: jauges.prot_g.valeur, cible: jauges.prot_g.cible, ratio: jauges.prot_g.ratio }),
    gauge({ kind: 'fer', label: 'Fer', unit: 'mg',
      valeur: jauges.fer_mg.valeur, cible: jauges.fer_mg.cible, ratio: jauges.fer_mg.ratio }),
    gauge({ kind: 'kcal', label: 'Calories', unit: 'kcal',
      valeur: jauges.kcal.valeur, cible: jauges.kcal.cible, ratio: jauges.kcal.ratio }),
  );
}

/* ---------- Inventaire ---------- */
/** Métadonnées de stock : plein (capacité), unité, dénombrable. */
function stockMeta(food) {
  const committed = Math.max(0, Number(food.stock) || 0);
  const unit = Math.max(1, Number(food.portions_par_unite) || 1);
  const denombrable = !!food.denombrable;
  // Plein = capacité arrondie au conteneur entier (au moins une unité de vente).
  const full = Math.max(unit, Math.ceil(committed / unit) * unit) || 1;
  return { committed, unit, denombrable, full };
}

/** Extrait la contenance (g/ml) de l'unité de vente, si présente. */
function parseContenance(unite) {
  const m = String(unite || '').toLowerCase().match(/(\d+(?:[.,]\d+)?)\s*(kg|g|cl|ml|l)\b/);
  if (!m) return null;
  const v = parseFloat(m[1].replace(',', '.'));
  switch (m[2]) {
    case 'kg': return { value: v * 1000, unit: 'g' };
    case 'g':  return { value: v, unit: 'g' };
    case 'l':  return { value: v * 1000, unit: 'ml' };
    case 'cl': return { value: v * 10, unit: 'ml' };
    case 'ml': return { value: v, unit: 'ml' };
    default:   return null;
  }
}

/** Bloc info (toggle « ⓘ nutri ») : ce que représente une portion, macros, plein. */
function infoBlock(food, meta) {
  const cont = parseContenance(food.unite_de_vente);
  const portionPct = Math.max(1, Math.round(100 / meta.full));
  let l1 = meta.denombrable ? '1 unité' : '1 portion';
  if (cont) l1 += ` ≈ ${num(cont.value / meta.unit)} ${cont.unit}`;
  l1 += ` · ${portionPct} % du plein`;

  const macroTxt = macroChips(food.macros).map(([k, v]) => `${v} ${k}`).join(' · ');
  const plein = `plein : ${num(meta.full)} ${meta.denombrable ? 'unités' : 'portions'}`
    + (food.unite_de_vente ? ` · ${food.unite_de_vente}` : '');

  return h('div', { class: 'inv-row__info' },
    h('div', { class: 'inv-row__info-line' }, l1),
    h('div', { class: 'inv-row__info-line' }, `${macroTxt} / portion`),
    h('div', { class: 'inv-row__info-line inv-row__info-faint' }, plein),
  );
}

/** Construit une ligne d'inventaire. Le curseur = PART DU STOCK CONSOMMÉE
 *  (0 % → 100 %), remis à 0 après validation. Le stock restant est affiché à
 *  droite. Renvoie une API {el, isDirty, reset, getChange}. */
function invRow(food, onChange) {
  const meta = stockMeta(food);
  const m = food.macros || {};
  const isCount = meta.denombrable;
  const stock = meta.committed;
  const max = isCount ? Math.max(0, Math.floor(stock)) : 100;

  const noun = (n) => (isCount ? 'unité' : 'portion') + (Math.abs(n) > 1 ? 's' : '');
  const level = h('span', { class: 'inv-row__level' }, `${num(stock)} ${noun(stock)}`);
  const delta = h('div', { class: 'inv-row__delta', hidden: true });
  const slider = h('input', {
    type: 'range', class: 'inv-row__slider',
    min: '0', max: String(max), step: '1', value: '0',
    'aria-label': `Part consommée de ${food.nom}`,
  });

  const row = h('div', { class: 'inv-row', id: `food-${food.id}` },
    h('div', { class: 'inv-row__top' },
      h('span', { class: 'inv-row__nom' }, food.nom),
      level,
    ),
    infoBlock(food, meta),
    slider,
    delta,
  );

  const val = () => Number(slider.value);
  const dirty = () => val() > 0;
  const consumed = (v) => (isCount ? v : (v / 100) * stock);   // portions consommées

  function renderLevel() {
    const v = val();
    const isDirty = v > 0;
    row.classList.toggle('is-dirty', isDirty);
    if (isDirty) {
      const d = Math.round(consumed(v) * 100) / 100;
      const pct = isCount ? '' : `${v} % · `;
      delta.className = 'inv-row__delta is-eat';
      delta.textContent = `🍽 ${pct}${num(d)} ${noun(d)} · ${num(m.kcal * d)} kcal · ${num(m.prot_g * d)} g prot`;
      delta.hidden = false;
    } else {
      delta.hidden = true;
    }
  }
  slider.addEventListener('input', () => { renderLevel(); onChange(); });
  renderLevel();

  return {
    el: row,
    isDirty: dirty,
    reset() { slider.value = '0'; renderLevel(); },
    getChange() {
      if (!dirty()) return null;
      const d = Math.round(consumed(val()) * 1000) / 1000; // portions consommées (>0)
      return { food, ref: food.id, delta: d, newStock: stock - d, macros: food.macros };
    },
  };
}

/** Barre de validation (visible dès qu'il y a des modifications). */
function validateBar(onValider, onAnnuler) {
  const count = h('span', { class: 'valbar__count' });
  const bar = h('div', { class: 'valbar', hidden: true },
    h('span', { class: 'valbar__info' }, h('span', { class: 'valbar__dot' }), count),
    h('div', { class: 'valbar__actions' },
      h('button', { class: 'valbar__annuler', type: 'button', onclick: onAnnuler }, 'Annuler'),
      h('button', { class: 'valbar__valider', type: 'button', onclick: onValider }, 'Valider'),
    ),
  );
  return {
    el: bar,
    set(n) {
      bar.hidden = n === 0;
      count.textContent = `${n} aliment${n > 1 ? 's' : ''} modifié${n > 1 ? 's' : ''}`;
    },
  };
}

/* ---------- Bloc « Repas extérieur » ---------- */
/** Logger un repas mangé dehors (resto, invitation) : ouvre la feuille de saisie
 *  (preset + curseurs kcal/prot). Compte dans les jauges, pas dans le stock. */
function exterieurBlock(exterieurs, onExterieur) {
  const btn = h('button', { class: 'ext-card', type: 'button' },
    h('span', { class: 'ext-card__ico' }, '🍽️'),
    h('span', { class: 'ext-card__txt' },
      h('span', { class: 'ext-card__title' }, 'Repas extérieur'),
      h('span', { class: 'ext-card__sub' }, 'Resto, invitation… — ajuste kcal et prot')),
    h('span', { class: 'ext-card__go' }, '›'),
  );
  btn.addEventListener('click', () => openExterieur(exterieurs, onExterieur));
  return h('section', { style: 'margin-top:22px' },
    h('div', { class: 'list-head' }, h('span', {}, 'Manger dehors')),
    btn,
  );
}

/**
 * @param root  conteneur
 * @param model { state, foods:[{id,nom,kind,macros,stock,portions_par_unite,denombrable}], exterieurs:[...] }
 * @param handlers { onCommit(changes), onExterieur(macros) }
 */
export function renderToday(root, model, handlers) {
  clear(root);
  const { state, foods, exterieurs } = model;
  const fab = document.getElementById('btn-quoi-manger');

  if (state.__offline) {
    root.append(h('div', { class: 'offline-banner' }, '⚡ Hors-ligne — données du dernier chargement'));
  }

  root.append(h('p', { class: 'day-caption' }, 'Apports du jour'));
  root.append(gaugesRow(state.jauges));

  // Aliments en stock, triés silencieusement par priorité du jour.
  const dispo = foods.filter((f) => (Number(f.stock) || 0) > 0);
  const ordered = rank(state, dispo).map((r) => r.item);

  const listEl = h('div', { class: 'inv-list' });
  const infoBtn = h('button', { class: 'infotoggle', type: 'button', 'aria-pressed': 'false' }, 'ⓘ nutri');
  infoBtn.addEventListener('click', () => {
    const on = listEl.classList.toggle('show-nutri');
    infoBtn.classList.toggle('is-on', on);
    infoBtn.setAttribute('aria-pressed', String(on));
  });

  root.append(h('div', { class: 'list-head' },
    h('span', {}, 'Mon stock'),
    infoBtn,
  ));
  root.append(h('p', { class: 'section-hint' },
    'Glisse chaque curseur sur la part que tu as mangée (0 → 100 %), puis Valide.'));

  if (!ordered.length) {
    root.append(h('div', { class: 'state', style: 'padding:32px 8px' },
      h('div', { class: 'state__icon' }, '🧺'),
      h('div', { class: 'state__msg' }, 'Aucun aliment en stock. Passe par « Courses » pour réapprovisionner.')));
  } else {
    const bar = validateBar(() => onValider(), () => onAnnuler());
    const rows = ordered.map((f) => invRow(f, () => updateBar()));
    rows.forEach((r) => listEl.append(r.el));
    root.append(listEl);
    root.append(bar.el);

    function updateBar() {
      const n = rows.filter((r) => r.isDirty()).length;
      bar.set(n);
      if (fab) fab.hidden = n > 0;           // le FAB s'efface tant qu'il y a des modifs
    }
    function onAnnuler() { rows.forEach((r) => r.reset()); updateBar(); }
    function onValider() {
      const changes = rows.map((r) => r.getChange()).filter(Boolean);
      if (changes.length) handlers.onCommit(changes);
    }
    updateBar();
  }

  root.append(exterieurBlock(exterieurs || [], handlers.onExterieur));
}
