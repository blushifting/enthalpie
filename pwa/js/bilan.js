// Écran « Bilan » (lecture seule) : moyennes journalières hebdo prot/fer/kcal vs
// cibles sur 4 semaines glissantes + streak protéines (SPEC §4.4, §7).
// Graphiques SVG maison, zéro dépendance.
import { h, clear, num, frDate } from './util.js';

const METRICS = [
  { key: 'prot_g', label: 'Protéines', unit: 'g',    kind: 'prot' },
  { key: 'kcal',   label: 'Calories',  unit: 'kcal', kind: 'kcal' },
  { key: 'fer_mg', label: 'Fer',       unit: 'mg',   kind: 'fer'  },
];

/** Mini graphe en barres (une barre par semaine) + ligne de cible. */
function metricChart(metric, semaines, cible, tol) {
  const vals = semaines.map((s) => Number((s.moyennes || {})[metric.key]) || 0);
  const hasCible = Number(cible) > 0;
  const top = Math.max(hasCible ? cible : 0, ...vals, 1) * 1.2;

  const W = 320, H = 132, padT = 16, padB = 24, padX = 6;
  const plotH = H - padT - padB, plotW = W - padX * 2;
  const n = vals.length || 1;
  const slot = plotW / n;
  const bw = Math.min(52, slot * 0.5);

  const y = (v) => padT + plotH * (1 - v / top);
  const inWindow = (v) => !hasCible || v >= cible - (Number(tol) || 0);

  const bars = vals.map((v, i) => {
    const x = padX + slot * i + (slot - bw) / 2;
    const yv = y(v);
    const bh = Math.max(0, padT + plotH - yv);
    const cls = `mc-bar mc-bar--${metric.kind}${inWindow(v) ? '' : ' is-under'}${i === vals.length - 1 ? ' is-current' : ''}`;
    return `<rect x="${x.toFixed(1)}" y="${yv.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="5" class="${cls}"></rect>`
      + `<text x="${(x + bw / 2).toFixed(1)}" y="${(yv - 5).toFixed(1)}" class="mc-val" text-anchor="middle">${num(v)}</text>`;
  }).join('');

  const labels = semaines.map((s, i) => {
    const x = padX + slot * i + slot / 2;
    return `<text x="${x.toFixed(1)}" y="${(H - 8).toFixed(1)}" class="mc-lbl" text-anchor="middle">${s.label || ''}</text>`;
  }).join('');

  let cibleLine = '';
  if (hasCible) {
    const yc = y(cible).toFixed(1);
    cibleLine = `<line x1="${padX}" x2="${W - padX}" y1="${yc}" y2="${yc}" class="mc-cible"></line>`;
  }

  return `<svg viewBox="0 0 ${W} ${H}" class="metric-chart" role="img" aria-label="${metric.label} par semaine">${cibleLine}${bars}${labels}</svg>`;
}

function metricBlock(metric, data) {
  const semaines = data.semaines || [];
  const cible = Number((data.cibles || {})[metric.key]) || 0;
  const tol = Number((data.tolerances || {})[metric.key]) || 0;
  const last = semaines.length ? (semaines[semaines.length - 1].moyennes || {}) : {};
  const current = Number(last[metric.key]) || 0;
  const cibleTxt = cible > 0 ? `cible ${num(cible)} ${metric.unit}/j` : 'informatif';

  return h('section', { class: `bilan-metric bilan-metric--${metric.kind}` },
    h('div', { class: 'bilan-metric__head' },
      h('span', { class: 'bilan-metric__label' }, metric.label),
      h('span', { class: 'bilan-metric__now' },
        h('b', {}, num(current)), ` ${metric.unit}/j `,
        h('span', { class: 'bilan-metric__cible' }, `· ${cibleTxt}`))),
    h('div', { html: metricChart(metric, semaines, cible, tol) }));
}

/** @param root conteneur @param data { cibles, tolerances, semaines:[...], streak_prot } */
export function renderBilan(root, data) {
  const d = data || { semaines: [] };
  clear(root);

  if (d.__offline) {
    root.append(h('div', { class: 'offline-banner' }, '⚡ Hors-ligne — dernier bilan connu'));
  }

  root.append(h('p', { class: 'day-caption' }, 'Bilan · 4 semaines'));

  const semaines = d.semaines || [];
  const withData = semaines.filter((s) => s.jours_avec_donnees > 0);
  if (!withData.length) {
    root.append(h('div', { class: 'state', style: 'padding:48px 8px' },
      h('div', { class: 'state__icon' }, '📈'),
      h('div', { class: 'state__title' }, 'Pas encore de données'),
      h('div', { class: 'state__msg' }, 'Les moyennes hebdomadaires apparaîtront après quelques jours de suivi.')));
    return;
  }

  // Streak protéines (gamification douce, SPEC §7).
  const streak = Number(d.streak_prot) || 0;
  root.append(h('div', { class: `bilan-streak ${streak > 0 ? 'is-on' : ''}` },
    h('span', { class: 'bilan-streak__ico' }, streak > 0 ? '🔥' : '💤'),
    streak > 0
      ? h('span', {}, h('b', {}, `${streak} semaine${streak > 1 ? 's' : ''}`), ' dans la fenêtre protéines')
      : h('span', {}, 'Fenêtre protéines pas encore tenue sur une semaine complète')));

  const range = `${frDate(semaines[0].debut)} → ${frDate(semaines[semaines.length - 1].fin)}`;
  root.append(h('p', { class: 'section-hint', style: 'margin:14px 2px 4px' }, `Moyenne journalière · ${range}`));

  METRICS.forEach((m) => root.append(metricBlock(m, d)));

  root.append(h('p', { class: 'bilan-foot' }, 'Lecture seule — l’analyse fine est le travail de la routine hebdo.'));
}
