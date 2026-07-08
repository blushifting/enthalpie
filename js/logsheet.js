// Feuille de log fractionné : choisir la quantité (curseur) d'un aliment,
// aperçu nutrition en direct, puis loguer. Cœur du modèle produit-centrique.
import { h, num } from './util.js';

const PRESETS = [0.5, 1, 1.5, 2];

/** openLogSheet(food, onConfirm) — onConfirm(quantite) appelé au « Loguer ». */
export function openLogSheet(food, onConfirm) {
  const root = document.getElementById('sheet-root');
  root.replaceChildren();

  const stock = Number(food.stock) || 0;
  const sliderMax = Math.max(2, Math.ceil(stock));
  let qty = stock >= 1 ? 1 : Math.max(0.25, Math.round(stock * 4) / 4);

  const backdrop = h('div', { class: 'sheet-backdrop' });
  const close = () => backdrop.remove();
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

  // Aperçu (mis à jour à chaque changement).
  const qtyLabel = h('span', { class: 'qty__value' });
  const gramProt = h('b', {});
  const kcalVal = h('b', {});
  const ferVal = h('b', {});
  const resteVal = h('span', { class: 'qty__reste' });

  const slider = h('input', {
    type: 'range', class: 'qty__slider',
    min: '0.25', max: String(sliderMax), step: '0.25', value: String(qty),
    'aria-label': 'Quantité en portions',
  });

  function refresh() {
    const m = food.macros || {};
    qtyLabel.textContent = `${num(qty)} ${qty > 1.5 ? 'portions' : 'portion'}`;
    kcalVal.textContent = `${num((Number(m.kcal) || 0) * qty)}`;
    gramProt.textContent = `${num((Number(m.prot_g) || 0) * qty)} g`;
    ferVal.textContent = `${num((Number(m.fer_mg) || 0) * qty)} mg`;
    const reste = Math.round((stock - qty) * 100) / 100;
    resteVal.textContent = `reste ${num(reste)} en stock`;
    resteVal.classList.toggle('is-neg', reste < 0);
    document.querySelectorAll('.qty__chip').forEach((c) =>
      c.classList.toggle('is-on', Number(c.dataset.v) === qty));
  }

  slider.addEventListener('input', () => { qty = Number(slider.value); refresh(); });

  const chips = h('div', { class: 'qty__chips' },
    ...PRESETS.map((v) => h('button', {
      class: 'qty__chip', type: 'button', dataset: { v: String(v) },
      onclick: () => { qty = v; slider.value = String(v); refresh(); },
    }, num(v))),
  );

  const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' },
    h('div', { class: 'sheet__handle' }),
    h('h2', {}, food.nom),
    h('p', { class: 'sub' },
      `En stock : ${num(stock)} portion${stock > 1.5 ? 's' : ''}`,
      food.unite_de_vente ? ` · ${food.unite_de_vente}` : ''),

    h('div', { class: 'qty__head' }, qtyLabel, resteVal),
    slider,
    chips,

    h('div', { class: 'qty__preview' },
      h('div', { class: 'qty__stat qty__stat--prot' }, gramProt, h('span', {}, 'protéines')),
      h('div', { class: 'qty__stat qty__stat--kcal' }, kcalVal, h('span', {}, 'kcal')),
      h('div', { class: 'qty__stat qty__stat--fer' }, ferVal, h('span', {}, 'fer')),
    ),

    h('div', { class: 'sheet__actions' },
      h('button', { class: 'btn btn--ghost', onclick: close }, 'Annuler'),
      h('button', {
        class: 'btn btn--primary',
        onclick: () => { if (qty > 0) { close(); onConfirm(qty); } },
      }, 'Loguer'),
    ),
  );

  backdrop.append(sheet);
  root.append(backdrop);
  refresh();
}
