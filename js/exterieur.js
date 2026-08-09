// Feuille « Repas extérieur » : logger un repas mangé dehors (resto, invitation).
// On part d'un preset resto (léger / normal / copieux — valeurs sourcées du
// catalogue) puis on ajuste kcal, protéines et fibres au curseur.
// Confirmation → onLog({kcal, prot_g, fibres_g, ref}) : compté dans les jauges
// du jour, sans toucher au stock (aucun ingrédient consommé).
// Le curseur fibres part du preset et reste ajustable (décision Azur du
// 2026-08-09, qui lève le « 1 preset + 2 curseurs » de la SPEC §1) : sans lui,
// un jour de resto creuserait la jauge sans aucun recours.
import { h, clear, num, thumbOnlySlider } from './util.js';

const KCAL_MAX = 2000;
const PROT_MAX = 80;
// 30 g, c'est la cible d'une JOURNÉE entière (skill nutrition §6) : un seul
// repas ne peut pas raisonnablement la dépasser.
const FIBRES_MAX = 30;

/** openExterieur(presets, onLog) — presets:[{id,nom,macros:{kcal,prot_g,fibres_g}}]. */
export function openExterieur(presets, onLog) {
  const list = (presets && presets.length) ? presets : [{
    id: '', nom: 'Repas extérieur', macros: { kcal: 800, prot_g: 25, fibres_g: 5 },
  }];

  const root = document.getElementById('sheet-root');
  clear(root);
  const backdrop = h('div', { class: 'sheet-backdrop' });
  const close = () => backdrop.remove();
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

  // État courant (preset choisi + valeurs ajustées).
  let current = list[Math.min(1, list.length - 1)];   // « normal » par défaut si dispo
  const fibresDe = (p) => Number(p.macros.fibres_g) || 0;
  let kcal = current.macros.kcal;
  let prot = current.macros.prot_g;
  let fibres = fibresDe(current);

  const kcalSlider = h('input', { type: 'range', class: 'qty__slider', min: '0', max: String(KCAL_MAX), step: '25', value: String(kcal), 'aria-label': 'Calories du repas' });
  const protSlider = h('input', { type: 'range', class: 'qty__slider', min: '0', max: String(PROT_MAX), step: '1', value: String(prot), 'aria-label': 'Protéines du repas' });
  const fibresSlider = h('input', { type: 'range', class: 'qty__slider', min: '0', max: String(FIBRES_MAX), step: '1', value: String(fibres), 'aria-label': 'Fibres du repas' });

  const kcalStat = h('b', {}, num(kcal));
  const protStat = h('b', {}, num(prot));
  const fibresStat = h('b', {}, num(fibres));

  const chips = list.map((p) => {
    const chip = h('button', { class: 'qty__chip', type: 'button' }, p.nom);
    chip.addEventListener('click', () => selectPreset(p, chip));
    return { p, chip };
  });

  function syncChips(active) {
    chips.forEach(({ chip }) => chip.classList.toggle('is-on', chip === active));
  }
  function renderStats() {
    kcalStat.textContent = num(kcal);
    protStat.textContent = num(prot);
    fibresStat.textContent = num(fibres);
  }
  function selectPreset(p, chip) {
    current = p;
    kcal = p.macros.kcal; prot = p.macros.prot_g; fibres = fibresDe(p);
    kcalSlider.value = String(Math.min(KCAL_MAX, kcal));
    protSlider.value = String(Math.min(PROT_MAX, prot));
    fibresSlider.value = String(Math.min(FIBRES_MAX, fibres));
    renderStats();
    syncChips(chip);
  }

  kcalSlider.addEventListener('input', () => { kcal = Number(kcalSlider.value); renderStats(); });
  protSlider.addEventListener('input', () => { prot = Number(protSlider.value); renderStats(); });
  fibresSlider.addEventListener('input', () => { fibres = Number(fibresSlider.value); renderStats(); });

  const confirm = h('button', { class: 'btn btn--primary', type: 'button' }, 'Logger le repas');
  confirm.addEventListener('click', () => {
    confirm.disabled = true;
    close();
    onLog({ kcal, prot_g: prot, fibres_g: fibres, ref: current.id || '' });
  });

  const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' },
    h('div', { class: 'sheet__handle' }),
    h('h2', {}, 'Repas extérieur'),
    h('p', { class: 'sub' }, 'Pars d’un preset, puis ajuste calories, protéines et fibres. Compté dans les jauges du jour, sans toucher au stock.'),
    h('div', { class: 'qty__chips' }, ...chips.map((c) => c.chip)),
    h('div', { class: 'ext-slider' },
      h('label', { class: 'ext-slider__lbl' }, 'Calories'),
      thumbOnlySlider(kcalSlider)),
    h('div', { class: 'ext-slider' },
      h('label', { class: 'ext-slider__lbl' }, 'Protéines'),
      thumbOnlySlider(protSlider)),
    h('div', { class: 'ext-slider' },
      h('label', { class: 'ext-slider__lbl' }, 'Fibres'),
      thumbOnlySlider(fibresSlider)),
    h('div', { class: 'qty__preview' },
      h('div', { class: 'qty__stat qty__stat--prot' }, protStat, h('span', {}, 'g prot')),
      h('div', { class: 'qty__stat qty__stat--kcal' }, kcalStat, h('span', {}, 'kcal')),
      h('div', { class: 'qty__stat qty__stat--fibres' }, fibresStat, h('span', {}, 'g fibres'))),
    confirm,
  );

  syncChips(chips.find((c) => c.p === current).chip);
  renderStats();

  backdrop.append(sheet);
  root.append(backdrop);
}
