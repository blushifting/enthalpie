// Écran « Aujourd'hui » : jauges du JOUR + inventaire à curseurs.
// Modèle inventaire : chaque curseur = PART DU PAQUET EN COURS déjà consommée
// (0 → 100 %). Sa position est dérivée du stock, donc elle persiste après
// validation : on la fait avancer au fil de la semaine, et la reculer corrige
// une saisie erronée (remise au stock). Un seul bouton « Valider ».
// Tout est en grammes ; les macros du catalogue sont pour 100 g.
import { h, clear, num } from './util.js';
import { rank } from './engine.js';
import { openExterieur } from './exterieur.js';

const R = 42;
const C = 2 * Math.PI * R;

/* ---------- Jauges (apports du jour) ---------- */
function gauge({ kind, label, unit, valeur, cible, ratio }) {
  const isInfo = ratio == null;                     // réservé : jauge sans cible chiffrée
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
    gauge({ kind: 'kcal', label: 'Calories', unit: 'kcal',
      valeur: jauges.kcal.valeur, cible: jauges.kcal.cible, ratio: jauges.kcal.ratio }),
  );
}

/* ---------- Inventaire ---------- */
/**
 * Repères de stock, tout en grammes. Le curseur exprime la part D'UN PAQUET
 * consommée, jamais du stock entier : sinon sa position changerait de sens à
 * chaque réappro, et il ne pourrait pas rester où on l'a laissé.
 *
 * 840 g de riz par paquets de 500 g = un paquet plein en réserve et un paquet
 * entamé à 340 g → curseur à 32 %.
 */
function stockMeta(food) {
  const stock = Math.max(0, Number(food.stock) || 0);
  const paquet = Math.max(0, Number(food.paquet) || 0);
  if (!(paquet > 0)) {
    // Poids de paquet inconnu : repli sur « part du stock restant », sans
    // mémoire de position. Dégradé assumé, annoncé dans le bloc info.
    return { stock, paquet: 0, reserve: 0, ouvert: stock, pct: 0, inconnu: true };
  }
  let entiers = Math.floor(stock / paquet);
  let ouvert = stock - entiers * paquet;
  // Multiple exact = paquet neuf, pas un paquet vide : on ouvre le suivant.
  if (ouvert <= 0.0001 && stock > 0) { entiers -= 1; ouvert = paquet; }
  return {
    stock, paquet,
    reserve: entiers * paquet,
    ouvert,
    pct: Math.round(((paquet - ouvert) / paquet) * 100),
    inconnu: false,
  };
}

/** Bloc info (toggle « ⓘ nutri ») : état du paquet en cours et macros /100 g. */
function infoBlock(food, meta) {
  const m = food.macros || {};
  // Le poids du paquet reste écrit : c'est l'ancre qui donne son sens au %.
  const etat = meta.inconnu
    ? `${num(Math.round(meta.stock))} g en stock · poids du paquet inconnu`
    : `paquet de ${num(meta.paquet)} g · il en reste ${100 - meta.pct} %`
      + (meta.reserve > 0 ? ` · ${num(Math.round(meta.reserve / meta.paquet))} paquet(s) d'avance` : '');

  return h('div', { class: 'inv-row__info' },
    h('div', { class: 'inv-row__info-line' }, etat),
    h('div', { class: 'inv-row__info-line' },
      `${num(m.kcal)} kcal · ${num(m.prot_g)} g prot / 100 g`),
  );
}

/** Construit une ligne d'inventaire. Le curseur = PART DU PAQUET EN COURS déjà
 *  consommée. Sa position est DÉRIVÉE du stock, elle n'est donc pas remise à
 *  zéro après validation : elle reste là où le stock l'amène, et le reculer
 *  corrige une erreur de saisie.
 *  Renvoie une API {el, isDirty, reset, getChange}. */
function invRow(food, onChange) {
  const meta = stockMeta(food);
  const m = food.macros || {};
  // Référence des 100 % du curseur : un paquet, ou à défaut le stock restant.
  const ref = meta.paquet > 0 ? meta.paquet : meta.stock;
  const depart = meta.pct;

  // Affichage en POURCENTAGE : on raisonne en part de paquet, pas en grammes —
  // « il reste 40 % » se visualise, « il reste 83 g » demande un calcul.
  const restant = (pct) => (meta.inconnu
    ? `${num(Math.round(meta.stock))} g`
    : `reste ${100 - pct} %` + (meta.reserve > 0
        ? ` +${Math.round(meta.reserve / meta.paquet)} paq.` : ''));
  const level = h('span', { class: 'inv-row__level' }, restant(meta.pct));
  const delta = h('div', { class: 'inv-row__delta', hidden: true });
  const slider = h('input', {
    type: 'range', class: 'inv-row__slider',
    min: '0', max: '100', step: '1', value: String(depart),
    'aria-label': `Part du paquet consommée — ${food.nom}`,
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
  const dirty = () => val() !== depart;
  // Grammes en jeu depuis la position validée : > 0 mangé, < 0 correction.
  const grammes = () => ((val() - depart) / 100) * ref;

  /**
   * Colore la piste : bleu jusqu'à la part DÉJÀ validée, ambre sur la part en
   * cours de saisie, gris ensuite. Le curseur montre ainsi d'un coup d'œil ce
   * qui est acquis et ce qui ne l'est pas encore.
   */
  function paintTrack() {
    const a = Math.min(depart, val());
    const b = Math.max(depart, val());
    slider.style.background = 'linear-gradient(to right,'
      + ` var(--accent) 0 ${a}%,`
      + ` var(--warn) ${a}% ${b}%,`
      + ` var(--surface-2) ${b}% 100%)`;
  }

  function renderLevel() {
    const g = grammes();
    const dp = val() - depart;              // écart en points de pourcentage
    row.classList.toggle('is-dirty', dirty());
    paintTrack();
    level.textContent = restant(val());
    if (!dirty()) { delta.hidden = true; return; }
    const r = Math.abs(g) / 100;
    if (g > 0) {
      delta.className = 'inv-row__delta is-eat';
      delta.textContent = `🍽 ${dp} % du paquet · ${num(Math.round(m.kcal * r))} kcal · `
        + `${num(Math.round(m.prot_g * r * 10) / 10)} g prot`;
    } else {
      // Reculer le curseur = « je n'avais pas mangé ça » → remise au stock.
      delta.className = 'inv-row__delta is-undo';
      delta.textContent = `↩ correction : ${-dp} % rendus au stock`;
    }
    delta.hidden = false;
  }
  // Le curseur ne bouge que si la prise démarre SUR la pastille. Sans ça, un
  // appui n'importe où sur la piste fait sauter la valeur d'un coup, et le
  // moindre frôlement en faisant défiler la liste déplace un curseur au hasard.
  // (Le défilement vertical, lui, est rendu au navigateur par touch-action.)
  const THUMB_PX = 30;   // diamètre de la pastille, cf. styles.css
  slider.addEventListener('pointerdown', (e) => {
    const r = slider.getBoundingClientRect();
    const maxV = Number(slider.max) || 0;
    const ratio = maxV > 0 ? Number(slider.value) / maxV : 0;
    const centre = r.left + THUMB_PX / 2 + ratio * (r.width - THUMB_PX);
    if (Math.abs(e.clientX - centre) > THUMB_PX) e.preventDefault();
  });

  slider.addEventListener('input', () => { renderLevel(); onChange(); });
  renderLevel();

  return {
    el: row,
    isDirty: dirty,
    // Annuler = revenir à la position que le stock impose, pas à zéro.
    reset() { slider.value = String(depart); renderLevel(); },
    getChange() {
      if (!dirty()) return null;
      const d = Math.round(grammes() * 100) / 100;   // grammes, signé
      return { food, ref: food.id, delta: d, newStock: meta.stock - d, macros: food.macros };
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
 * @param model { state, foods:[{id,nom,kind,macros,stock,paquet}], exterieurs:[...] }
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
