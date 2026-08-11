// Écran « Aujourd'hui » : jauges du JOUR + inventaire à curseurs.
// Modèle inventaire : chaque curseur = PART DU PAQUET EN COURS déjà consommée
// (0 → 100 %). Sa position est dérivée du stock, donc elle persiste après
// validation : on la fait avancer au fil de la semaine, et la reculer corrige
// une saisie erronée (remise au stock). Un seul bouton « Valider ».
// Tout est en grammes ; les macros du catalogue sont pour 100 g.
import { h, clear, num, numEntier, thumbOnlySlider } from './util.js';
import { REPLI_CIBLES, CATEGORIES } from './config.js';
import { normaliser } from './categories.js';
import { openExterieur } from './exterieur.js';

const R = 42;
const C = 2 * Math.PI * R;

/**
 * Positions atteignables du curseur d'inventaire, en % du paquet : la grille
 * des 5 % plus les sixièmes, arrondis à l'entier (17 / 33 / 67 / 83 — un tiers
 * de point d'écart avec la fraction exacte, soit ~1 g sur un paquet de 500 g,
 * là où une décimale afficherait une précision qu'on n'a pas). Le 1/2, le 1/4,
 * le 3/4 et les cinquièmes tombent déjà sur la grille des 5 %.
 *
 * 25 crans : assez pour dire ce qu'on a mangé, assez peu pour que chaque cran
 * soit large au doigt. Les valeurs interdites sont interdites au geste comme au
 * clavier (cf. thumbOnlySlider).
 */
const CRANS_PAQUET = [0, 5, 10, 15, 17, 20, 25, 30, 33, 35, 40, 45, 50,
  55, 60, 65, 67, 70, 75, 80, 83, 85, 90, 95, 100];

/* ---------- Jauges (apports du jour) ---------- */
function gauge({ kind, label, unit, valeur, cible, ratio, fmt = num, attente = false }) {
  // `attente` : les chiffres du jour ne sont pas encore arrivés du backend (on
  // affiche le stock en cache tout de suite). Un anneau vide et « … » disent
  // qu'on ne sait pas encore — afficher les valeurs de la veille mentirait.
  if (attente) {
    return h('div', { class: `gauge gauge--${kind} is-attente` },
      h('div', { class: 'gauge__ring' },
        h('div', { html: `<svg viewBox="0 0 100 100" aria-hidden="true">
          <circle class="gauge__track" cx="50" cy="50" r="${R}"></circle></svg>` }),
        h('div', { class: 'gauge__center' }, h('span', { class: 'gauge__value' }, '…'))),
      h('div', { class: 'gauge__label' }, label),
      h('span', { class: 'gauge__badge' }, 'actualisation'));
  }

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
        over ? `+${fmt(valeur - cible)} ${unit}` : `${pct} %`);

  return h('div', { class: `gauge gauge--${kind}` },
    h('div', { class: 'gauge__ring' },
      h('div', { html: svg }),
      h('div', { class: 'gauge__center' },
        h('span', { class: 'gauge__value' }, fmt(valeur)),
        h('span', { class: 'gauge__target' }, isInfo ? unit : `/ ${fmt(cible)} ${unit}`),
      ),
    ),
    h('div', { class: 'gauge__label' }, label),
    badge,
  );
}

/**
 * Applique la cible de repli quand le backend n'en renvoie pas (`cible: 0` →
 * `ratio: null`, ce qui affichait la jauge en « informatif »). Une cible du
 * projet ne dépend pas de l'état d'une colonne du Sheet : la jauge fibres est
 * dure, comme les deux autres.
 */
function avecRepli(j, repli) {
  const valeur = Number(j.valeur) || 0;
  const cible = Number(j.cible) > 0 ? Number(j.cible) : (Number(repli) || 0);
  return { valeur, cible, ratio: cible > 0 ? valeur / cible : null };
}

function gaugesRow(jauges, attente = false) {
  // La jauge fibres est absente tant que le backend n'a pas été redéployé : on
  // ne la rend que si elle arrive, sinon l'app plante à froid entre les deux
  // déploiements (même garde-fou que `jours` dans bilan.js). Le repli porte sur
  // la CIBLE manquante, jamais sur la valeur consommée — celle-là, seul le
  // backend la connaît.
  const fib = jauges.fibres_g;
  return h('section', { class: 'gauges', 'aria-label': 'Apports du jour' },
    gauge({ kind: 'prot', label: 'Protéines', unit: 'g', fmt: num, attente,
      valeur: jauges.prot_g.valeur, cible: jauges.prot_g.cible, ratio: jauges.prot_g.ratio }),
    gauge({ kind: 'kcal', label: 'Calories', unit: 'kcal', fmt: numEntier, attente,
      valeur: jauges.kcal.valeur, cible: jauges.kcal.cible, ratio: jauges.kcal.ratio }),
    fib ? gauge({ kind: 'fibres', label: 'Fibres', unit: 'g', fmt: num, attente,
      ...avecRepli(fib, REPLI_CIBLES.fibres_g) }) : null,
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

  // Le tiret des fibres EST l'information utile : il montre au coup d'œil quels
  // produits creusent la jauge sans qu'on le sache (skill nutrition §6). Le
  // remède est de renseigner la valeur depuis Ciqual, pas de l'estimer.
  const fibres = m.fibres_g == null ? '— fibres' : `${num(m.fibres_g)} g fibres`;

  return h('div', { class: 'inv-row__info' },
    h('div', { class: 'inv-row__info-line' }, etat),
    h('div', { class: 'inv-row__info-line' },
      `${num(m.kcal)} kcal · ${num(m.prot_g)} g prot · ${fibres} / 100 g`),
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
  // La position validée est dérivée du stock : elle peut tomber hors grille
  // (32 % d'un paquet de 500 g). On l'ajoute aux crans, sinon le curseur ne
  // pourrait plus revenir exactement là où il était.
  const crans = CRANS_PAQUET.includes(depart)
    ? CRANS_PAQUET
    : [...CRANS_PAQUET, depart].sort((a, b) => a - b);

  const row = h('div', { class: 'inv-row', id: `food-${food.id}` },
    h('div', { class: 'inv-row__top' },
      h('span', { class: 'inv-row__nom' }, food.nom),
      level,
    ),
    infoBlock(food, meta),
    thumbOnlySlider(slider, crans),
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
  // La prise sur la pastille (et elle seule) est gérée par thumbOnlySlider().
  slider.addEventListener('input', () => { renderLevel(); onChange(); });
  renderLevel();

  return {
    el: row,
    food,
    categorie: categorieDe(food),
    // Entamé = le paquet en cours a déjà été consommé en partie. Ce sont les
    // aliments de la semaine en cours, donc ceux qu'on cherche en premier.
    entame: meta.pct > 0,
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

/* ---------- Rangement : catégorie, tri, recherche, pastilles ---------- */

/**
 * Catégorie d'un article de stock. Un plat batch n'a pas de colonne
 * `categorie` (l'onglet `plats` n'en a pas) : une fournée cuisinée est au
 * frigo, c'est le seul rangement qui ait un sens. À revoir le jour où l'onglet
 * `plats` sera peuplé — ce sera alors une vraie colonne.
 */
export function categorieDe(food) {
  if (food.kind === 'plat') return 'frigo';
  return String(food.categorie || '');
}

/** Entamés d'abord, puis alphabétique (accents et casse ignorés). */
function trierStock(foods) {
  // Même source que la ligne elle-même (`stockMeta`) : deux définitions de
  // « entamé » finiraient par diverger, et le tri contredirait l'affichage.
  const entame = (f) => stockMeta(f).pct > 0;
  return foods.slice().sort((a, b) => {
    const ea = entame(a); const eb = entame(b);
    if (ea !== eb) return ea ? -1 : 1;
    return normaliser(a.nom).localeCompare(normaliser(b.nom));
  });
}

/** Champ de recherche instantané (filtre à la frappe, sans bouton). */
function champRecherche(onChange) {
  const input = h('input', {
    class: 'inv-search__input', type: 'search', inputmode: 'search',
    placeholder: 'Chercher un aliment', autocomplete: 'off', spellcheck: 'false',
    'aria-label': 'Chercher un aliment dans le stock',
  });
  input.addEventListener('input', () => onChange(input.value));
  const wrap = h('div', { class: 'inv-search' },
    h('span', { class: 'inv-search__ico', 'aria-hidden': 'true' }, '⌕'), input);
  Object.defineProperty(wrap, 'value', { get: () => input.value });
  return wrap;
}

/**
 * Pastilles de catégorie. N'affiche QUE les catégories réellement présentes
 * dans le stock : une pastille qui ne filtre rien est un piège à tap.
 *
 * Le filtre N'EST PAS mémorisé (demande d'Azur du 2026-08-11) : chaque ouverture
 * repart de « Tout ». Un filtre persistant fait rouvrir l'app sur un stock
 * amputé sans qu'on se souvienne pourquoi — l'inventaire complet est le seul
 * état par défaut qui ne cache rien.
 */
function filtreBar(foods, onPick) {
  const presentes = new Set(foods.map(categorieDe));
  const dispo = CATEGORIES.filter((c) => presentes.has(c.id));
  const nonRanges = presentes.has('');

  let actif = '';

  const el = h('div', { class: 'inv-filtres', role: 'group', 'aria-label': 'Filtrer par rangement' });
  const boutons = [];
  const ajouter = (id, texte) => {
    const b = h('button', {
      class: `inv-filtre ${id === actif ? 'is-on' : ''}`, type: 'button',
      'aria-pressed': id === actif ? 'true' : 'false',
    }, texte);
    b.addEventListener('click', () => {
      // Re-taper la pastille active revient à « Tout » : sortir d'un filtre ne
      // doit pas obliger à viser une autre pastille.
      actif = (id === actif && id !== '') ? '' : id;
      boutons.forEach(({ id: i, b: btn }) => {
        btn.classList.toggle('is-on', i === actif);
        btn.setAttribute('aria-pressed', i === actif ? 'true' : 'false');
      });
      onPick(actif);
    });
    boutons.push({ id, b });
    el.append(b);
  };

  ajouter('', 'Tout');
  dispo.forEach((c) => ajouter(c.id, c.court));
  if (nonRanges) ajouter('_vide', 'Non rangés');

  // Une seule catégorie en stock (ou aucune) : la barre n'apporte rien.
  if (dispo.length + (nonRanges ? 1 : 0) < 2) el.hidden = true;

  // Valeur transmise telle quelle : '' = tout, '_vide' = les non rangés,
  // sinon l'id de catégorie. Un seul vocabulaire, aucune traduction en route.
  return { el, actif: () => actif };
}

/* ---------- Bloc « Repas extérieur » ---------- */
/** Logger un repas mangé dehors (resto, invitation) : ouvre la feuille de saisie
 *  (preset + curseurs kcal/prot). Compte dans les jauges, pas dans le stock.
 *  Placé JUSTE SOUS LES JAUGES depuis le 2026-08-11 : c'est une action fréquente,
 *  et sous l'inventaire il fallait dérouler tout le stock pour l'atteindre. */
function exterieurBlock(exterieurs, onExterieur) {
  const btn = h('button', { class: 'ext-card', type: 'button' },
    h('span', { class: 'ext-card__ico' }, '🍽️'),
    h('span', { class: 'ext-card__txt' },
      h('span', { class: 'ext-card__title' }, 'Repas extérieur'),
      h('span', { class: 'ext-card__sub' }, 'Resto, invitation… — ajuste kcal et prot')),
    h('span', { class: 'ext-card__go' }, '›'),
  );
  btn.addEventListener('click', () => openExterieur(exterieurs, onExterieur));
  return h('section', { class: 'ext-section' },
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
  root.append(gaugesRow(state.jauges, !!state.__attente));

  // Manger dehors : au-dessus de l'inventaire, à portée de pouce.
  root.append(exterieurBlock(exterieurs || [], handlers.onExterieur));

  // Aliments en stock, ENTAMÉS D'ABORD puis par ordre alphabétique (choix
  // d'Azur du 2026-08-11). L'ancien tri par priorité du jour (`rank`) est
  // abandonné ici : il changeait l'ordre chaque matin, aucune mémoire visuelle
  // ne pouvait se former — c'était la cause du « bordel » ressenti. `rank`
  // continue de servir « Quoi manger ? », son vrai terrain.
  const dispo = foods.filter((f) => (Number(f.stock) || 0) > 0);
  const ordered = trierStock(dispo);

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
    return;
  }

  // Bouton de rangement : n'apparaît que s'il reste des produits sans catégorie.
  const aRanger = foods.filter((f) => f.kind === 'produit' && !categorieDe(f));
  if (aRanger.length && handlers.onRanger) {
    root.append(h('button', { class: 'ranger-cta', type: 'button', onclick: () => handlers.onRanger() },
      h('span', {}, `${aRanger.length} produit${aRanger.length > 1 ? 's' : ''} pas encore rangé${aRanger.length > 1 ? 's' : ''}`),
      h('span', { class: 'ranger-cta__go' }, 'Ranger ›')));
  }

  const bar = validateBar(() => onValider(), () => onAnnuler());
  const rows = ordered.map((f) => invRow(f, () => updateBar()));

  // Les lignes sont construites UNE fois et se contentent de se masquer : un
  // curseur déplacé puis filtré garde sa position (reconstruire la liste la
  // perdrait, et avec elle une saisie non validée).
  const filtres = filtreBar(ordered, (cat) => appliquer(cat, chercher.value));
  const chercher = champRecherche((q) => appliquer(filtres.actif(), q));
  const vide = h('p', { class: 'crs-empty', hidden: true }, 'Aucun aliment ne correspond.');

  const enCours = h('p', { class: 'inv-group', hidden: true }, 'Entamés');
  const reste = h('p', { class: 'inv-group', hidden: true }, 'Pas entamés');
  rows.forEach((r) => listEl.append(r.el));
  listEl.prepend(reste);
  listEl.prepend(enCours);
  // Les deux intertitres se placent aux frontières du tri : « Entamés » en tête,
  // « Pas entamés » juste avant la première ligne pleine.
  const premierPlein = rows.find((r) => !r.entame);
  if (premierPlein) listEl.insertBefore(reste, premierPlein.el);

  root.append(chercher, filtres.el, listEl, vide, bar.el);

  /** Applique catégorie + recherche : les lignes hors sélection se masquent. */
  function appliquer(cat, q) {
    const requete = normaliser(q).trim();
    let visibles = 0;
    let entamesVus = 0;
    let pleinsVus = 0;
    const passeCat = (r) => (!cat ? true : (cat === '_vide' ? r.categorie === '' : r.categorie === cat));
    rows.forEach((r) => {
      const ok = passeCat(r) && (!requete || normaliser(r.food.nom).includes(requete));
      r.el.hidden = !ok;
      if (!ok) return;
      visibles++;
      if (r.entame) entamesVus++; else pleinsVus++;
    });
    // Un intertitre sans ligne sous lui ne veut rien dire ; et un seul groupe
    // présent n'a pas besoin d'être nommé.
    const deuxGroupes = entamesVus > 0 && pleinsVus > 0;
    enCours.hidden = !deuxGroupes;
    reste.hidden = !deuxGroupes;
    vide.hidden = visibles > 0;
  }

  function updateBar() {
    // Compte TOUTES les lignes modifiées, y compris masquées par un filtre :
    // une saisie ne doit pas disparaître parce qu'on a tapé dans la recherche.
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
  appliquer(filtres.actif(), '');
}
