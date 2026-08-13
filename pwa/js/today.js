// Écran « Aujourd'hui » : jauges du JOUR + inventaire à curseurs.
// Modèle inventaire : chaque curseur = PART DU PAQUET EN COURS déjà consommée
// (0 → 100 %). Sa position est dérivée du stock, donc elle persiste après
// validation : on la fait avancer au fil de la semaine, et la reculer corrige
// une saisie erronée (remise au stock ET retrait des apports du jour).
// Un seul bouton « Valider ».
// Tout est en grammes ; les macros du catalogue sont pour 100 g.
//
// Règle depuis le 2026-08-13 : **l'écran n'affiche jamais un stock que le
// serveur n'a pas confirmé.** Pendant l'envoi les lignes sont gelées ; si le
// lot part en file (hors-ligne), elles restent gelées avec le stock du serveur
// et un badge « en attente ». Empiler une saisie sur un état local non
// synchronisé était la cause des quantités comptées deux fois.
import { h, clear, num, numEntier, thumbOnlySlider, bandeauCache } from './util.js';
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

const NS_SVG = 'http://www.w3.org/2000/svg';
function svgEl(nom, attrs) {
  const el = document.createElementNS(NS_SVG, nom);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
  return el;
}

/** L'app est censée bouger, pas gigoter : tout ce qui s'anime ici se coupe. */
const sobre = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const DUREE_COMPTEUR = 560;

/**
 * Une jauge, construite UNE fois et mise à jour en place par `maj()`.
 *
 * C'est le point clé de l'animation (2026-08-13). La transition CSS sur
 * `stroke-dashoffset` existait depuis le début, mais ne s'est jamais jouée :
 * `renderToday` vide et reconstruit tout l'écran à chaque peinture, et un
 * cercle SVG créé à l'instant naît déjà à sa valeur finale — il n'y a rien
 * entre quoi et quoi transitionner. La section de jauges est donc désormais
 * conservée d'une peinture à l'autre (cf. `renderToday`), et seules ses valeurs
 * changent : l'anneau se remplit, le nombre défile.
 */
function gauge({ kind, label, unit, fmt = num }) {
  const track = svgEl('circle', { class: 'gauge__track', cx: 50, cy: 50, r: R });
  const fill = svgEl('circle', {
    class: 'gauge__fill', cx: 50, cy: 50, r: R,
    'stroke-dasharray': C.toFixed(1), 'stroke-dashoffset': C.toFixed(1),
  });
  const svg = svgEl('svg', { viewBox: '0 0 100 100', 'aria-hidden': 'true' });
  svg.append(track, fill);

  const valueEl = h('span', { class: 'gauge__value' }, '…');
  const targetEl = h('span', { class: 'gauge__target' });
  const badge = h('span', { class: 'gauge__badge' });
  const el = h('div', { class: `gauge gauge--${kind}` },
    h('div', { class: 'gauge__ring' },
      svg,
      h('div', { class: 'gauge__center' }, valueEl, targetEl)),
    h('div', { class: 'gauge__label' }, label),
    badge,
  );

  let affichee = null;      // valeur au compteur, pour repartir d'où il en est
  let ratioVu = null;       // dernier ratio peint, pour détecter le franchissement
  let anim = 0;
  let secours = 0;

  const poser = (v) => { affichee = v; valueEl.textContent = fmt(v); };

  /** Compteur : le nombre rejoint sa cible au lieu de sauter. Même durée que
   *  l'anneau, pour qu'ils arrivent ensemble. */
  function compter(vers) {
    cancelAnimationFrame(anim);
    clearTimeout(secours);
    // Premier affichage ou appareil sobre : on pose la valeur, sans détour.
    if (affichee == null || sobre()) { poser(vers); return; }
    const depart = affichee;
    if (Math.abs(vers - depart) < 0.05) { poser(vers); return; }

    // Filet : `requestAnimationFrame` ne se déclenche pas quand la page n'est
    // pas peinte (app passée en arrière-plan, écran verrouillé pendant la
    // validation). Sans lui, le nombre resterait figé sur l'ancienne valeur —
    // un chiffre faux, pas seulement une animation manquée.
    secours = setTimeout(() => { cancelAnimationFrame(anim); poser(vers); }, DUREE_COMPTEUR + 150);

    const t0 = performance.now();
    const pas = (t) => {
      const k = Math.min(1, (t - t0) / DUREE_COMPTEUR);
      const e = 1 - Math.pow(1 - k, 3);                 // easeOutCubic, comme l'anneau
      affichee = depart + (vers - depart) * e;
      valueEl.textContent = fmt(affichee);
      if (k < 1) { anim = requestAnimationFrame(pas); return; }
      clearTimeout(secours);
      poser(vers);
    };
    anim = requestAnimationFrame(pas);
  }

  /**
   * @param etat { valeur, cible, ratio, attente, projection }
   * `projection` : la valeur n'est pas encore confirmée par le serveur — elle
   * est calculée depuis les macros qu'on a sous la main pendant l'aller-retour.
   * L'anneau y va quand même, en teinte atténuée, et se cale sur la réponse.
   */
  function maj(etat) {
    const { attente = false, projection = false } = etat || {};
    el.classList.toggle('is-attente', attente);
    el.classList.toggle('is-projection', !attente && projection);

    if (attente) {
      // Les chiffres du jour ne sont pas encore arrivés (le stock en cache est
      // déjà à l'écran). Anneau vide et « … » : afficher ceux de la veille
      // serait un mensonge, et le compteur repartira de la vraie valeur.
      cancelAnimationFrame(anim);
      affichee = null;
      valueEl.textContent = '…';
      targetEl.textContent = '';
      fill.setAttribute('stroke-dashoffset', C.toFixed(1));
      fill.style.display = 'none';
      badge.className = 'gauge__badge';
      badge.textContent = 'actualisation';
      ratioVu = null;
      return;
    }

    const valeur = Number(etat.valeur) || 0;
    const cible = Number(etat.cible) || 0;
    const ratio = etat.ratio;
    const isInfo = ratio == null;                     // réservé : jauge sans cible chiffrée
    const over = !isInfo && valeur > cible && cible > 0;
    const borne = isInfo ? 0 : Math.max(0, Math.min(1, ratio || 0));

    fill.style.display = isInfo ? 'none' : '';
    fill.classList.toggle('is-over', over);
    fill.setAttribute('stroke-dashoffset', (C * (1 - borne)).toFixed(1));

    compter(valeur);
    targetEl.textContent = isInfo ? unit : `/ ${fmt(cible)} ${unit}`;

    const pct = isInfo ? null : Math.round((ratio || 0) * 100);
    badge.className = `gauge__badge ${isInfo ? '' : over ? 'is-over' : pct >= 90 ? 'is-ok' : ''}`;
    badge.textContent = isInfo ? 'informatif'
      : over ? `+${fmt(valeur - cible)} ${unit}` : `${pct} %`;

    // Franchissement de la cible : une pulsation, une seule fois, au moment où
    // ça arrive. C'est le seul instant de la journée qui mérite d'être souligné.
    if (!isInfo && !sobre() && ratioVu != null && ratioVu < 1 && (ratio || 0) >= 1) {
      el.classList.remove('is-atteinte');
      void el.offsetWidth;                            // relance l'animation
      el.classList.add('is-atteinte');
      setTimeout(() => el.classList.remove('is-atteinte'), 900);
    }
    ratioVu = ratio;
  }

  el.maj = maj;
  return el;
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

/**
 * Section des trois jauges, construite une fois puis mise à jour en place.
 * Elle expose `maj(jauges, {attente, ajout})` :
 *  - `attente` : les apports du jour ne sont pas encore connus ;
 *  - `ajout`   : {kcal, prot_g, fibres_g} à AJOUTER aux valeurs du serveur —
 *    c'est la projection affichée pendant l'aller-retour d'une validation.
 */
function gaugesRow() {
  const el = h('section', { class: 'gauges', 'aria-label': 'Apports du jour' });
  const jaugesEl = {
    prot_g: gauge({ kind: 'prot', label: 'Protéines', unit: 'g', fmt: num }),
    kcal: gauge({ kind: 'kcal', label: 'Calories', unit: 'kcal', fmt: numEntier }),
    fibres_g: gauge({ kind: 'fibres', label: 'Fibres', unit: 'g', fmt: num }),
  };
  el.append(jaugesEl.prot_g, jaugesEl.kcal, jaugesEl.fibres_g);

  el.maj = (jauges, { attente = false, ajout = null } = {}) => {
    const projection = !!ajout;
    const ajuste = (j, cle, repli) => {
      const base = repli != null ? avecRepli(j, repli)
        : { valeur: Number(j.valeur) || 0, cible: Number(j.cible) || 0, ratio: j.ratio };
      if (!ajout) return base;
      // Une correction ne peut pas descendre sous zéro, et le serveur ne
      // renverra jamais mieux : plafonner ici évite un anneau négatif le temps
      // de l'aller-retour.
      const valeur = Math.max(0, base.valeur + (Number(ajout[cle]) || 0));
      return { valeur, cible: base.cible,
        ratio: base.cible > 0 ? valeur / base.cible : base.ratio };
    };

    jaugesEl.prot_g.maj({ ...ajuste(jauges.prot_g, 'prot_g'), attente, projection });
    jaugesEl.kcal.maj({ ...ajuste(jauges.kcal, 'kcal'), attente, projection });
    // La jauge fibres est absente tant que le backend n'a pas été redéployé : on
    // ne la montre que si elle arrive, sinon l'app plante à froid entre les deux
    // déploiements (même garde-fou que `jours` dans bilan.js). Le repli porte
    // sur la CIBLE manquante, jamais sur la valeur consommée — celle-là, seul
    // le backend la connaît.
    const fib = jauges.fibres_g;
    jaugesEl.fibres_g.hidden = !fib;
    if (fib) jaugesEl.fibres_g.maj({
      ...ajuste(fib, 'fibres_g', REPLI_CIBLES.fibres_g), attente, projection });
  };

  return el;
}

/** Ramène en haut de page, là où sont les jauges. Glissé, sauf si l'appareil
 *  demande la sobriété — auquel cas le saut est immédiat, pas absent. */
function remonter() {
  try { window.scrollTo({ top: 0, behavior: sobre() ? 'auto' : 'smooth' }); }
  catch { window.scrollTo(0, 0); }        // vieux Safari : pas d'objet d'options
}

/** Apports d'un lot de curseurs, depuis les macros déjà en mémoire : c'est
 *  exactement ce que le backend recalculera (macros /100 g × grammes / 100). */
function projeter(changes) {
  const somme = { kcal: 0, prot_g: 0, fibres_g: 0 };
  (changes || []).forEach((c) => {
    const m = (c && c.macros) || {};
    const f = (Number(c && c.delta) || 0) / 100;
    somme.kcal += (Number(m.kcal) || 0) * f;
    somme.prot_g += (Number(m.prot_g) || 0) * f;
    // `|| 0` : un aliment sans donnée de fibres ne fait pas bouger sa jauge,
    // exactement comme côté serveur (skill nutrition §6).
    somme.fibres_g += (Number(m.fibres_g) || 0) * f;
  });
  return somme;
}

/* ---------- Résumé du jour ---------- */

/*
 * Seuils du code couleur du stock. Les deux premiers ne sont pas improvisés :
 * ce sont les allégations nutritionnelles du règlement UE 1924/2006, celles-là
 * mêmes qu'un fabricant doit respecter pour écrire « source de » sur un paquet.
 *   - source de protéines : elles fournissent au moins 12 % de l'énergie ;
 *   - source de fibres    : au moins 3 g pour 100 g.
 * Les deux paliers de calories, eux, sont des choix d'AFFICHAGE (à quel moment
 * la densité calorique devient l'information dominante d'une ligne), pas des
 * recommandations nutritionnelles — c'est pourquoi ils vivent ici et non dans
 * le skill nutrition.
 */
const PART_ENERGIE_PROT = 0.12;   // UE 1924/2006 — « source de protéines »
const FIBRES_SOURCE_G = 3;        // UE 1924/2006 — « source de fibres », /100 g
// Plancher absolu : sans lui, un épinard (3 g de protéines mais 25 kcal) sort
// « source de protéines » — formellement vrai, absurde dans une liste de stock,
// puisqu'il en faudrait 400 g pour que ça compte.
const PROT_PLANCHER_G = 5;
const KCAL_DENSE = 400;           // huile, oléagineux : la densité prime sur le reste
const KCAL_NOTABLE = 150;         // en dessous, un aliment sans prot ni fibres n'est marquant sur rien

/**
 * Macro dominante d'un aliment, pour 100 g → 'prot' | 'kcal' | 'fibres' | ''
 * (rien de marquant : épices, bouillon, légumes très légers).
 *
 * Une première version comparait les trois macros en part de cible journalière.
 * Elle donnait des verdicts absurdes sur les aliments cuits, dont les trois
 * valeurs sont basses : le riz complet cuit ressortait « fibres » parce que ses
 * 1,8 g pesaient un cheveu de plus que ses 130 kcal. On classe donc par seuils
 * absolus, et un aliment qui n'en franchit aucun n'est coloré par rien.
 */
export function macroDominante(macros) {
  const m = macros || {};
  const kcal = Number(m.kcal) || 0;
  const prot = Number(m.prot_g) || 0;
  // `|| 0` : une fiche dont les fibres ne sont pas renseignées (null) ne peut
  // pas prétendre au vert — la jauge fibres minore, le code couleur aussi.
  const fibres = Number(m.fibres_g) || 0;

  if (kcal >= KCAL_DENSE) return 'kcal';

  const candidats = [];
  const partProt = kcal > 0 ? (prot * 4) / kcal : 0;
  if (prot >= PROT_PLANCHER_G && partProt >= PART_ENERGIE_PROT) {
    candidats.push({ kind: 'prot', score: partProt / PART_ENERGIE_PROT });
  }
  if (fibres >= FIBRES_SOURCE_G) {
    candidats.push({ kind: 'fibres', score: fibres / FIBRES_SOURCE_G });
  }
  // Deux fois « source de » : on garde celui qui dépasse son seuil de le plus
  // loin, seule comparaison qui ait un sens entre deux unités différentes.
  if (candidats.length) return candidats.sort((a, b) => b.score - a.score)[0].kind;

  return kcal >= KCAL_NOTABLE ? 'kcal' : '';
}

/**
 * Ce qui a été mangé aujourd'hui, entre les jauges et « Manger dehors ».
 *
 * Volontairement minimal (choix d'Azur du 2026-08-13) : une ligne par aliment,
 * son nom, la part du paquet consommée, et un ✕. Ni poids ni macros — les
 * jauges au-dessus disent déjà le total, et le détail par aliment est dans le
 * mode « ⓘ nutri » du stock. Ce bloc répond à une seule question : « qu'est-ce
 * que j'ai compté aujourd'hui, et où est mon erreur ? »
 *
 * Le ✕ n'ouvre pas de confirmation : pour un aliment, il rend la quantité au
 * stock et retire les apports du jour — c'est le curseur reculé, en un tap.
 */
function journalBlock(state, onSupprimer, dejaVus) {
  const entrees = Array.isArray(state.journal) ? state.journal : null;
  // Backend pas encore redéployé : pas de `journal` du tout. On ne montre alors
  // rien plutôt qu'une section vide qui laisserait croire à une journée blanche.
  if (!entrees) return null;

  const head = h('div', { class: 'list-head' },
    h('span', {}, 'Mangé aujourd’hui'),
    entrees.length ? h('span', { class: 'list-head__n' }, `${entrees.length} entrée${entrees.length > 1 ? 's' : ''}`) : null);

  // Cache d'un autre jour : le journal affiché serait celui d'hier. Même règle
  // que les anneaux, qui passent en « actualisation » (2026-08-11).
  if (state.__attente) {
    return h('section', { class: 'jrn-section' }, head,
      h('div', { class: 'jrn' }, h('div', { class: 'jrn__vide' }, 'Actualisation…')));
  }

  if (!entrees.length) {
    return h('section', { class: 'jrn-section' }, head,
      h('div', { class: 'jrn' },
        h('div', { class: 'jrn__vide' }, 'Rien saisi aujourd’hui.')));
  }

  const liste = h('div', { class: 'jrn' });
  // Le plus récent en tête : c'est là que se trouve l'erreur qu'on vient de faire.
  entrees.slice().reverse().forEach((e) => {
    const ext = e.type === 'exterieur';
    const paquet = Number(e.paquet_g) || 0;
    const grammes = Number(e.grammes) || 0;
    // La part du paquet, et à défaut les grammes : sans poids de paquet connu,
    // un pourcentage n'aurait aucune référence (même dégradé que le curseur).
    const mesure = ext
      ? `${numEntier(e.kcal)} kcal`
      : (paquet > 0 ? `${Math.round((grammes / paquet) * 100)} %` : `${num(Math.round(grammes))} g`);

    const x = h('button', {
      class: 'jrn__x', type: 'button',
      'aria-label': `Retirer ${e.nom} du journal du jour`,
    }, '✕');
    // Entrée qui n'était pas là à la peinture précédente : elle se signale une
    // fois. C'est la réponse à « qu'est-ce que je viens de compter ? », posée
    // juste après une validation, quand la liste s'est réordonnée.
    const nouvelle = dejaVus && !dejaVus.has(String(e.id));
    const row = h('div', { class: `jrn__row ${ext ? 'is-ext' : ''} ${nouvelle ? 'is-neuve' : ''}` },
      h('span', { class: 'jrn__nom' }, ext ? `Repas extérieur${e.nom && e.nom !== 'Repas extérieur' ? ` · ${e.nom}` : ''}` : e.nom),
      h('span', { class: 'jrn__pct' }, mesure),
      x);
    x.addEventListener('click', () => {
      // Gelée pendant l'aller-retour : un double tap enverrait deux annulations,
      // et la seconde retirerait le repas suivant (le rang aurait glissé).
      if (x.disabled) return;
      x.disabled = true;
      // La ligne se replie pendant l'envoi au lieu de disparaître d'un coup à la
      // repeinture : on voit ce qu'on vient de retirer partir.
      row.classList.add('is-envoi', 'is-partante');
      Promise.resolve(onSupprimer(e)).catch(() => {
        x.disabled = false;
        row.classList.remove('is-envoi', 'is-partante');
      });
    });
    liste.append(row);
  });

  return h('section', { class: 'jrn-section' }, head, liste);
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

/**
 * Badges « G » (gluten) et « L » (lactose), à la suite du nom (2026-08-13).
 * Uniquement quand la base l'affirme : un produit non renseigné n'affiche rien,
 * et l'absence de badge ne vaut donc pas « sans gluten ». Volontairement gris —
 * les couleurs de la liste sont déjà prises par les macros, et un allergène
 * n'est pas une alerte ici (aucun mode strict n'est activé).
 */
function badgesAllergenes(food) {
  const badge = (lettre, titre) => h('span', {
    class: 'inv-row__flag', title: titre, 'aria-label': titre, role: 'img',
  }, lettre);
  const out = [];
  if (food.gluten) out.push(badge('G', 'Contient du gluten'));
  if (food.lactose) out.push(badge('L', 'Contient du lactose'));
  return out;
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
function invRow(food, onChange, enAttente = false) {
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

  // Ligne gelée : une modification de cet aliment attend encore de partir. Le
  // stock affiché est celui du serveur, il ne tient donc PAS compte de ce qui
  // est en file — rejouer un curseur par-dessus rejouerait la même consommation
  // en double, ce qui est exactement le bug du 2026-08-13.
  if (enAttente) slider.disabled = true;

  // Liseré de gauche = macro dominante (2026-08-13). La liste était monochrome :
  // seul le nom distinguait un féculent d'une source de protéines, ce qui oblige
  // à lire chaque ligne. La couleur est celle de la jauge correspondante — aucun
  // vocabulaire nouveau à apprendre.
  const dom = macroDominante(food.macros);

  const row = h('div', { class: `inv-row inv-row--${dom || 'neutre'} ${enAttente ? 'is-attente' : ''}`, id: `food-${food.id}` },
    h('div', { class: 'inv-row__top' },
      h('span', { class: 'inv-row__nom' }, food.nom, ...badgesAllergenes(food)),
      level,
    ),
    infoBlock(food, meta),
    enAttente ? h('div', { class: 'inv-row__attente' }, '⏳ modification en attente de synchro') : null,
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
      // Reculer le curseur = « je n'avais pas mangé ça » : remise au stock ET
      // retrait des apports du jour (2026-08-13 — avant, seul le stock revenait
      // et les calories restaient acquises).
      // « jusqu'à » : le backend ne peut annuler que ce qui a été logué
      // AUJOURD'HUI pour cet aliment ; corriger ce matin une saisie d'hier rend
      // le stock sans creuser les jauges du jour, ce qui est le comportement juste.
      delta.className = 'inv-row__delta is-undo';
      delta.textContent = `↩ correction : ${-dp} % rendus au stock · `
        + `jusqu'à ${num(Math.round(m.kcal * r))} kcal retirés du jour`;
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
    enAttente,
    // Gel le temps de l'aller-retour : un curseur qui bouge pendant l'envoi ne
    // correspondrait plus au lot parti. Une ligne déjà en attente reste gelée.
    lock(on) {
      if (!enAttente) slider.disabled = !!on;
      row.classList.toggle('is-envoi', !!on);
    },
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
  const annuler = h('button', { class: 'valbar__annuler', type: 'button', onclick: onAnnuler }, 'Annuler');
  const valider = h('button', { class: 'valbar__valider', type: 'button', onclick: onValider }, 'Valider');
  // Pilotée par une CLASSE et non par `hidden` : `[hidden]{display:none}` sort
  // l'élément du flux d'un coup, et rien ne peut plus s'animer. Avec une classe,
  // la barre glisse depuis le bas de l'écran quand la première modification
  // arrive, et redescend quand la dernière est annulée.
  const bar = h('div', { class: 'valbar' },
    h('span', { class: 'valbar__info' }, h('span', { class: 'valbar__dot' }), count),
    h('div', { class: 'valbar__actions' }, annuler, valider),
  );
  let n = 0;
  const libelle = () => `${n} aliment${n > 1 ? 's' : ''} modifié${n > 1 ? 's' : ''}`;
  return {
    el: bar,
    set(v) {
      n = v;
      bar.classList.toggle('is-on', n > 0);
      count.textContent = libelle();
    },
    /** Envoi en cours : la barre dit ce qui se passe et se refuse au double tap. */
    envoi(on) {
      bar.classList.toggle('is-envoi', !!on);
      annuler.disabled = !!on;
      valider.disabled = !!on;
      valider.textContent = on ? 'Enregistrement…' : 'Valider';
      count.textContent = on ? 'Envoi au serveur…' : libelle();
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
 * @param model { state, foods:[{id,nom,kind,macros,stock,paquet}], exterieurs:[...],
 *                pending:Set<string> — refs dont une modification attend de partir }
 * @param handlers { onCommit(changes) → {repaint}, onExterieur(macros) }
 */
export function renderToday(root, model, handlers) {
  const { state, foods, exterieurs } = model;
  const pending = model.pending || new Set();
  const fab = document.getElementById('btn-quoi-manger');

  // La section de jauges SURVIT à la peinture : on la détache, on repeint le
  // reste, on la remet. C'est ce qui permet à l'anneau de s'animer — recréé, il
  // naîtrait à sa valeur finale et la transition n'aurait rien à jouer.
  const gauges = root.querySelector('.gauges') || gaugesRow();
  // Première peinture de la session : l'inventaire s'y déroule en cascade. Aux
  // suivantes (après chaque validation), il apparaît d'un bloc — rejouer la
  // cascade à chaque aller-retour serait épuisant.
  const premierRendu = !root.querySelector('.inv-list');
  const jrnVus = root.__jrnVus || null;

  clear(root);

  if (state.__offline) {
    root.append(bandeauCache(state.__offline, 'données du dernier chargement'));
  }

  // Tout ce qui est affiché vient du serveur. Ce qui attend encore de partir
  // n'est donc compté NULLE PART à l'écran : le dire est la seule façon de ne
  // pas laisser croire que les jauges et le stock sont à jour.
  if (pending.size) {
    root.append(h('div', { class: 'pending-banner' },
      h('span', {}, `⏳ ${pending.size} aliment${pending.size > 1 ? 's' : ''} en attente de synchro`),
      h('span', { class: 'pending-banner__sub' },
        'Les chiffres ci-dessous sont ceux du serveur : ils ne comptent pas encore ces modifications.')));
  }

  root.append(h('p', { class: 'day-caption' }, 'Apports du jour'));
  root.append(gauges);
  void gauges.offsetWidth;               // la section vient d'être ré-insérée
  gauges.maj(state.jauges, { attente: !!state.__attente });

  // Ce qui a été compté aujourd'hui, juste sous les jauges qu'il explique.
  const journal = journalBlock(state, (e) => handlers.onSupprimerEntree(e), jrnVus);
  if (journal) root.append(journal);
  root.__jrnVus = new Set((state.journal || []).map((e) => String(e.id)));

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
  const rows = ordered.map((f) => invRow(f, () => updateBar(), pending.has(String(f.id))));

  // Cascade d'entrée, première peinture seulement, et seulement sur ce qui tient
  // à l'écran : au-delà d'une douzaine de lignes on n'anime plus rien de visible,
  // on ne fait qu'ajouter du retard avant que la liste soit utilisable.
  if (premierRendu && !sobre()) {
    rows.slice(0, 12).forEach((r, i) => {
      r.el.classList.add('is-entree');
      r.el.style.setProperty('--i', String(i));
    });
  }

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

  /**
   * Envoi : l'écran se gèle jusqu'à la réponse plutôt que d'afficher un stock
   * que le serveur n'a pas encore vu. `repaint` dit si l'app a repeint depuis
   * l'état frais — sinon on rend la main avec les curseurs INTACTS, pour que la
   * saisie survive à un refus et puisse être retentée.
   */
  let envoiEnCours = false;
  async function onValider() {
    if (envoiEnCours) return;
    const changes = rows.map((r) => r.getChange()).filter(Boolean);
    if (!changes.length) return;
    envoiEnCours = true;
    bar.envoi(true);
    rows.forEach((r) => r.lock(true));

    // Remontée en haut, et les anneaux partent tout de suite vers la valeur
    // projetée. On valide en bas d'une longue liste : sans ça, l'effet de la
    // saisie se produit hors de l'écran, et il ne reste que l'attente.
    //
    // La projection ne contredit pas la règle du 2026-08-13 (« on n'affiche
    // jamais un état non confirmé ») : elle ne touche ni au stock ni aux lignes,
    // n'est écrite nulle part, et se recalcule à chaque peinture depuis l'état
    // du serveur. Le double comptage qu'évitait cette règle venait d'un bump
    // PERSISTÉ qui survivait à l'échec de l'envoi — ici, un échec la reprend.
    remonter();
    if (!state.__attente) gauges.maj(state.jauges, { ajout: projeter(changes) });

    let res;
    try { res = await handlers.onCommit(changes); }
    finally {
      envoiEnCours = false;
      if (!res || !res.repaint) {          // l'écran n'a pas été refait : on dégèle
        rows.forEach((r) => r.lock(false));
        bar.envoi(false);
        gauges.maj(state.jauges, { attente: !!state.__attente });   // projection reprise
      }
    }
  }
  updateBar();
  appliquer(filtres.actif(), '');
}
