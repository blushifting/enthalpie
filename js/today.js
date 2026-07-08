// Écran « Aujourd'hui » : jauges du JOUR + inventaire à curseurs.
// Modèle inventaire : chaque curseur = niveau de stock (% du plein, ou nombre
// d'unités pour les dénombrables). On baisse les curseurs au fil de la semaine ;
// un seul bouton « Valider » enregistre les baisses (= consommation → nutrition).
// Les curseurs modifiés sont surlignés jusqu'à validation.
import { h, clear, num, macroChips } from './util.js';
import { rank } from './engine.js';

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

/** Construit une ligne d'inventaire. Renvoie une API {el, isDirty, reset, getChange}. */
function invRow(food, onChange) {
  const meta = stockMeta(food);
  const m = food.macros || {};
  const isCount = meta.denombrable;
  const max = isCount ? meta.full : 100;
  const start = isCount ? meta.committed : Math.round((meta.committed / meta.full) * 100);

  const level = h('span', { class: 'inv-row__level' });
  const delta = h('div', { class: 'inv-row__delta', hidden: true });
  const slider = h('input', {
    type: 'range', class: 'inv-row__slider',
    min: '0', max: String(max), step: '1', value: String(start),
    'aria-label': `Stock de ${food.nom}`,
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
  const dirty = () => val() !== start;
  const noun = (n) => (meta.denombrable ? 'unité' : 'portion') + (Math.abs(n) > 1 ? 's' : '');
  const newStockOf = (v) => (isCount ? v : (v / 100) * meta.full);

  function renderLevel() {
    const v = val();
    level.textContent = isCount ? `${v} / ${meta.full}` : `${v} %`;
    const isDirty = dirty();
    row.classList.toggle('is-dirty', isDirty);

    if (isDirty) {
      const d = Math.round((meta.committed - newStockOf(v)) * 100) / 100; // >0 = consommé
      if (d > 0) {
        delta.className = 'inv-row__delta is-eat';
        delta.textContent = `🍽 ${num(d)} ${noun(d)} · ${num(m.kcal * d)} kcal · ${num(m.prot_g * d)} g prot`;
      } else {
        delta.className = 'inv-row__delta is-add';
        delta.textContent = `＋ ${num(-d)} ${noun(-d)} remises en stock`;
      }
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
    reset() { slider.value = String(start); renderLevel(); },
    getChange() {
      if (!dirty()) return null;
      const v = val();
      const newStock = newStockOf(v);
      const d = Math.round((meta.committed - newStock) * 1000) / 1000; // >0 = consommé
      return { food, ref: food.id, delta: d, newStock, macros: food.macros };
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

/* ---------- Section plats (repliée) ---------- */
function platsSection(plats, onLogPlat) {
  if (!plats.length) return null;
  const feasible = plats.filter((p) => p.faisable);
  const rest = plats.filter((p) => !p.faisable);
  const ordered = [...feasible, ...rest];

  const section = h('section', { class: 'creneau' },
    h('button', { class: 'creneau__head', type: 'button' },
      h('span', { class: 'creneau__emoji' }, '🍲'),
      'Plats & assemblages',
      h('span', { class: 'creneau__count' }, `${plats.length}`),
      h('span', { class: 'creneau__chevron' }, '›'),
    ),
    h('div', { class: 'creneau__body' },
      h('div', { class: 'tiles' },
        ...ordered.map((p) => h('button', {
          class: `tile ${p.faisable ? 'tile--feasible' : 'tile--infeasible'}`, type: 'button',
          onclick: () => onLogPlat(p),
        },
          p.type ? h('span', { class: 'tile__type' }, p.type) : null,
          h('span', { class: 'tile__nom' }, p.nom),
          h('span', { class: 'tile__macros' },
            ...macroChips(p.macros).map(([k, v]) => h('span', {}, h('b', {}, v), ' ', k))),
        )),
      ),
    ),
  );
  section.querySelector('.creneau__head').addEventListener('click',
    () => section.classList.toggle('is-open'));
  return section;
}

/**
 * @param root  conteneur
 * @param model { state, foods:[{id,nom,macros,stock,portions_par_unite,denombrable}], plats:[...] }
 * @param handlers { onCommit(changes), onLogPlat(plat) }
 */
export function renderToday(root, model, handlers) {
  clear(root);
  const { state, foods, plats } = model;
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

  const ps = platsSection(plats, handlers.onLogPlat);
  if (ps) root.append(ps);
}
