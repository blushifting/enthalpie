// Écran « Aujourd'hui » : jauges du JOUR + liste d'aliments dispo (curseur) +
// section plats repliée (option occasionnelle). Modèle produit-centrique.
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

/* ---------- Liste d'aliments (curseur intégré) ---------- */
function foodRow(food, onLogFood) {
  const m = food.macros || {};
  const stock = Number(food.stock) || 0;
  const sliderMax = Math.max(2, Math.ceil(stock));
  let qty = stock >= 1 ? 1 : Math.max(0.25, Math.round(stock * 4) / 4);

  const live = h('div', { class: 'food-row__live' });
  const qtyB = h('span', { class: 'food-row__qty' });
  const slider = h('input', {
    type: 'range', class: 'food-row__slider',
    min: '0.25', max: String(sliderMax), step: '0.25', value: String(qty),
    'aria-label': `Quantité de ${food.nom} en portions`,
  });
  const logBtn = h('button', { class: 'food-row__log', type: 'button' }, 'Loguer');

  function refresh() {
    qtyB.textContent = `×${num(qty)}`;
    const prot = (Number(m.prot_g) || 0) * qty;
    const kcal = (Number(m.kcal) || 0) * qty;
    const fer = (Number(m.fer_mg) || 0) * qty;
    live.replaceChildren(
      h('b', {}, `${num(prot)} g`), ' prot · ',
      h('b', {}, `${num(kcal)}`), ' kcal',
      (Number(m.fer_mg) || 0) > 0 ? h('span', {}, ' · ', h('b', {}, `${num(fer)} mg`), ' fer') : '',
    );
  }
  slider.addEventListener('input', () => { qty = Number(slider.value); refresh(); });
  logBtn.addEventListener('click', () => onLogFood(food, qty));
  refresh();

  return h('div', { class: 'food-row' },
    h('div', { class: 'food-row__top' },
      h('div', { class: 'food-row__nom' }, food.nom),
      h('div', { class: 'food-row__stock' }, h('b', {}, num(stock)), ' en stock'),
    ),
    live,
    h('div', { class: 'food-row__ctl' }, slider, qtyB, logBtn),
  );
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
 * @param model { state, foods:[{id,nom,macros,stock,...}], plats:[...] }
 * @param handlers { onPick(food), onLogPlat(plat) }
 */
export function renderToday(root, model, handlers) {
  clear(root);
  const { state, foods, plats } = model;

  if (state.__offline) {
    root.append(h('div', { class: 'offline-banner' }, '⚡ Hors-ligne — données du dernier chargement'));
  }

  root.append(h('p', { class: 'day-caption' }, 'Apports du jour'));
  root.append(gaugesRow(state.jauges));

  // Aliments dispo (stock > 0), triés silencieusement par priorité du jour.
  const dispo = foods.filter((f) => f.stock > 0);
  const ordered = rank(state, dispo).map((r) => r.item);

  root.append(h('div', { class: 'list-head' },
    h('span', {}, 'Mes aliments'),
    h('span', { class: 'list-head__hint' }, 'règle la quantité, puis Loguer'),
  ));

  if (!ordered.length) {
    root.append(h('div', { class: 'state', style: 'padding:32px 8px' },
      h('div', { class: 'state__icon' }, '🧺'),
      h('div', { class: 'state__msg' }, 'Aucun aliment en stock. Passe par « Courses » pour réapprovisionner.')));
  } else {
    root.append(h('div', { class: 'food-list' }, ...ordered.map((f) => foodRow(f, handlers.onLogFood))));
  }

  const ps = platsSection(plats, handlers.onLogPlat);
  if (ps) root.append(ps);
}
