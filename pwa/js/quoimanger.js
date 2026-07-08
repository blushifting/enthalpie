// Feuille « Quoi manger ? » : top 3 aliments à privilégier maintenant, avec la
// raison (complémentarité des jauges du jour). Tap -> feuille de quantité.
import { h, clear, macroChips } from './util.js';
import { rank } from './engine.js';

/** openQuoiManger(state, foods, onChoose) — onChoose(food) au tap. */
export function openQuoiManger(state, foods, onChoose) {
  const root = document.getElementById('sheet-root');
  clear(root);

  const dispo = (foods || []).filter((f) => f.stock > 0);
  const picks = rank(state, dispo).slice(0, 3);

  const backdrop = h('div', { class: 'sheet-backdrop' });
  const close = () => backdrop.remove();
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

  const body = picks.length
    ? h('div', { class: 'suggest-list' },
        ...picks.map(({ item, reason }) =>
          h('button', { class: 'suggest-card', type: 'button',
            onclick: () => { close(); onChoose(item); } },
            h('div', { class: 'suggest-card__reason' }, `${reason.emoji} ${reason.mot}`),
            h('div', { class: 'suggest-card__nom' }, item.nom),
            h('div', { class: 'suggest-card__macros' },
              ...macroChips(item.macros).map(([k, v]) => h('span', {}, h('b', {}, v), ' ', k))),
            h('div', { class: 'suggest-card__go' }, 'y aller ›'),
          )))
    : h('div', { class: 'state', style: 'padding:28px 8px' },
        h('div', { class: 'state__icon' }, '🧺'),
        h('div', { class: 'state__msg' }, 'Rien en stock à proposer. Direction « Courses ».'));

  const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' },
    h('div', { class: 'sheet__handle' }),
    h('h2', {}, 'Quoi manger ?'),
    h('p', { class: 'sub' }, 'Priorité à ce qui te manque aujourd\'hui. Tape pour aller à son curseur.'),
    body,
  );
  backdrop.append(sheet);
  root.append(backdrop);
}
