// Écran « Bilan » (lecture seule) : prot/kcal vs cibles, à deux échelles au
// choix — les 7 derniers jours (un point par jour) ou 4 semaines glissantes
// (moyenne journalière) — + streak protéines (SPEC §4.4, §7).
// Graphiques SVG maison, zéro dépendance.
import { h, clear, num, frDate } from './util.js';
import { store } from './store.js';

const METRICS = [
  { key: 'prot_g',   label: 'Protéines', unit: 'g',    kind: 'prot' },
  { key: 'kcal',     label: 'Calories',  unit: 'kcal', kind: 'kcal' },
  { key: 'fibres_g', label: 'Fibres',    unit: 'g',    kind: 'fibres',
    // Seul endroit de l'app où il y a la place de le dire : la jauge fibres
    // minore toujours (skill nutrition §6).
    note: 'Ne compte que les produits dont les fibres sont renseignées.' },
];

const MODES = {
  jour: {
    onglet: 'Jour',
    caption: 'Bilan · 7 jours',
    hint: 'Par jour',
    unite: (u) => u,                  // valeur brute du jour
  },
  semaine: {
    onglet: 'Semaine',
    caption: 'Bilan · 4 semaines',
    hint: 'Moyenne journalière',
    unite: (u) => `${u}/j`,           // moyenne par jour
  },
};

/**
 * Points à tracer pour un mode donné : { label, value, vide }.
 * `vide` = rien de saisi ce jour-là (pas de clôture médiane), à distinguer d'un
 * vrai zéro ; une semaine sans aucune saisie est traitée pareil.
 */
function serie(mode, data, metricKey) {
  if (mode === 'jour') {
    return (data.jours || []).map((j) => ({
      label: j.label || frDate(j.date),
      value: Number(j[metricKey]) || 0,
      vide: !j.a_donnees,
    }));
  }
  return (data.semaines || []).map((s) => ({
    label: s.label || '',
    value: Number((s.moyennes || {})[metricKey]) || 0,
    vide: !s.jours_avec_donnees,
  }));
}

/** Mini graphe en barres (une barre par point) + ligne de cible. */
function metricChart(metric, points, cible, tol) {
  const hasCible = Number(cible) > 0;
  const top = Math.max(hasCible ? cible : 0, ...points.map((p) => p.value), 1) * 1.2;

  const W = 320, H = 132, padT = 16, padB = 24, padX = 6;
  const plotH = H - padT - padB, plotW = W - padX * 2;
  const n = points.length || 1;
  const slot = plotW / n;
  const bw = Math.min(52, slot * 0.5);
  const base = padT + plotH;

  const y = (v) => padT + plotH * (1 - v / top);
  const inWindow = (v) => !hasCible || v >= cible - (Number(tol) || 0);

  const bars = points.map((p, i) => {
    const x = padX + slot * i + (slot - bw) / 2;
    // Jour sans saisie : un simple trait sur la ligne de base, pas une barre à
    // zéro — l'app ne prétend pas savoir qu'on n'a rien mangé.
    if (p.vide) {
      return `<line x1="${x.toFixed(1)}" x2="${(x + bw).toFixed(1)}" y1="${base}" y2="${base}" class="mc-empty"></line>`;
    }
    const yv = y(p.value);
    const bh = Math.max(0, base - yv);
    const cls = `mc-bar mc-bar--${metric.kind}${inWindow(p.value) ? '' : ' is-under'}${i === points.length - 1 ? ' is-current' : ''}`;
    return `<rect x="${x.toFixed(1)}" y="${yv.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="5" class="${cls}"></rect>`
      + `<text x="${(x + bw / 2).toFixed(1)}" y="${(yv - 5).toFixed(1)}" class="mc-val" text-anchor="middle">${num(p.value)}</text>`;
  }).join('');

  const labels = points.map((p, i) => {
    const x = padX + slot * i + slot / 2;
    return `<text x="${x.toFixed(1)}" y="${(H - 8).toFixed(1)}" class="mc-lbl" text-anchor="middle">${p.label}</text>`;
  }).join('');

  let cibleLine = '';
  if (hasCible) {
    const yc = y(cible).toFixed(1);
    cibleLine = `<line x1="${padX}" x2="${W - padX}" y1="${yc}" y2="${yc}" class="mc-cible"></line>`;
  }

  // Au-delà de 5 barres les valeurs se touchent : on rapetisse les chiffres.
  const dense = points.length > 5 ? ' metric-chart--dense' : '';
  return `<svg viewBox="0 0 ${W} ${H}" class="metric-chart${dense}" role="img" aria-label="${metric.label} — ${points.length} points">${cibleLine}${bars}${labels}</svg>`;
}

function metricBlock(metric, data, mode) {
  const points = serie(mode, data, metric.key);
  const cible = Number((data.cibles || {})[metric.key]) || 0;
  const tol = Number((data.tolerances || {})[metric.key]) || 0;
  const last = points.length ? points[points.length - 1] : null;
  const cibleTxt = cible > 0 ? `cible ${num(cible)} ${metric.unit}/j` : 'informatif';

  return h('section', { class: `bilan-metric bilan-metric--${metric.kind}` },
    h('div', { class: 'bilan-metric__head' },
      h('span', { class: 'bilan-metric__label' }, metric.label),
      h('span', { class: 'bilan-metric__now' },
        last && !last.vide
          ? [h('b', {}, num(last.value)), ` ${MODES[mode].unite(metric.unit)} `]
          : h('span', { class: 'bilan-metric__vide' }, 'rien saisi '),
        h('span', { class: 'bilan-metric__cible' }, `· ${cibleTxt}`))),
    h('div', { html: metricChart(metric, points, cible, tol) }),
    metric.note ? h('p', { class: 'bilan-metric__note' }, metric.note) : null);
}

/** Bascule jour / semaine ; le choix est mémorisé d'une visite à l'autre. */
function echelleToggle(mode, onPick) {
  const btn = (m) => h('button', {
    type: 'button',
    class: `echelle__opt ${m === mode ? 'is-on' : ''}`,
    'aria-pressed': m === mode ? 'true' : 'false',
    onclick: () => { if (m !== mode) onPick(m); },
  }, MODES[m].onglet);
  return h('div', { class: 'echelle', role: 'group', 'aria-label': 'Échelle de temps' },
    btn('jour'), btn('semaine'));
}

/** @param root conteneur @param data { cibles, tolerances, jours:[...], semaines:[...], streak_prot } */
export function renderBilan(root, data) {
  const d = data || { semaines: [] };
  // Un backend pas encore redéployé ne renvoie pas `jours` : on reste en hebdo.
  const parJourDispo = Array.isArray(d.jours) && d.jours.length > 0;
  const mode = parJourDispo ? store.getBilanMode() : 'semaine';
  clear(root);

  if (d.__offline) {
    root.append(h('div', { class: 'offline-banner' }, '⚡ Hors-ligne — dernier bilan connu'));
  }

  const semaines = d.semaines || [];
  const withData = semaines.filter((s) => s.jours_avec_donnees > 0);
  if (!withData.length) {
    root.append(h('p', { class: 'day-caption' }, 'Bilan'));
    root.append(h('div', { class: 'state', style: 'padding:48px 8px' },
      h('div', { class: 'state__icon' }, '📈'),
      h('div', { class: 'state__title' }, 'Pas encore de données'),
      h('div', { class: 'state__msg' }, 'Les courbes apparaîtront après quelques jours de suivi.')));
    return;
  }

  root.append(h('div', { class: 'bilan-head' },
    h('p', { class: 'day-caption', style: 'margin:2px 2px' }, MODES[mode].caption),
    parJourDispo
      ? echelleToggle(mode, (m) => { store.setBilanMode(m); renderBilan(root, data); })
      : null));

  // Streak protéines (gamification douce, SPEC §7) — hebdo par nature, donc
  // affiché dans les deux modes.
  const streak = Number(d.streak_prot) || 0;
  root.append(h('div', { class: `bilan-streak ${streak > 0 ? 'is-on' : ''}` },
    h('span', { class: 'bilan-streak__ico' }, streak > 0 ? '🔥' : '💤'),
    streak > 0
      ? h('span', {}, h('b', {}, `${streak} semaine${streak > 1 ? 's' : ''}`), ' dans la fenêtre protéines')
      : h('span', {}, 'Fenêtre protéines pas encore tenue sur une semaine complète')));

  const jours = d.jours || [];
  const range = mode === 'jour' && jours.length
    ? `${frDate(jours[0].date)} → ${frDate(jours[jours.length - 1].date)}`
    : `${frDate(semaines[0].debut)} → ${frDate(semaines[semaines.length - 1].fin)}`;
  root.append(h('p', { class: 'section-hint', style: 'margin:14px 2px 4px' }, `${MODES[mode].hint} · ${range}`));

  // Backend pas encore redéployé : la réponse ne porte pas les fibres. Mieux
  // vaut ne rien montrer qu'un graphe plat à zéro annoncé « informatif ».
  const dispo = (m) => m.key !== 'fibres_g' || (d.cibles || {}).fibres_g != null;
  METRICS.filter(dispo).forEach((m) => root.append(metricBlock(m, d, mode)));

  root.append(h('p', { class: 'bilan-foot' }, 'Lecture seule — l’analyse fine est le travail de la routine hebdo.'));
}
