// Petits utilitaires DOM et formatage (aucune dépendance).

/** Crée un élément : h('div', {class:'x'}, child, ...). */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);

// Diamètre de la pastille — doit rester synchro avec `::-webkit-slider-thumb`
// dans styles.css.
const THUMB_PX = 30;

/**
 * Emballe un `<input type=range>` pour qu'il ne bouge QUE si la prise démarre
 * sur la pastille : un appui ailleurs sur la piste, ou un frôlement pendant
 * qu'on fait défiler la liste, ne doit rien changer.
 *
 * Le geste natif du navigateur ne peut pas être filtré de façon fiable (sur
 * mobile il passe par les événements *touch*, que `preventDefault()` sur
 * `pointerdown` ne bloque pas). On le neutralise donc complètement
 * (`pointer-events: none` sur l'input, cf. `.slider-wrap` dans styles.css) et
 * on pilote la valeur nous-mêmes depuis le wrapper.
 *
 * Le clavier reste natif (l'input garde le focus et ses flèches).
 * Renvoie l'élément à insérer dans le DOM à la place de l'input.
 */
export function thumbOnlySlider(input) {
  const wrap = h('div', { class: 'slider-wrap' }, input);

  const geom = () => {
    const r = input.getBoundingClientRect();
    const min = Number(input.min) || 0;
    const max = Number(input.max);
    return { left: r.left, min, span: (max - min) || 1, usable: Math.max(1, r.width - THUMB_PX) };
  };
  // Abscisse du centre de la pastille pour la valeur courante.
  const centre = () => {
    const { left, min, span, usable } = geom();
    const ratio = Math.min(1, Math.max(0, (Number(input.value) - min) / span));
    return left + THUMB_PX / 2 + ratio * usable;
  };

  let dragging = false;
  let saisie = 0;            // écart doigt ↔ centre au départ : évite le saut initial

  wrap.addEventListener('pointerdown', (e) => {
    if (input.disabled) return;
    if (Math.abs(e.clientX - centre()) > THUMB_PX / 2) return;   // pas sur la pastille
    dragging = true;
    saisie = e.clientX - centre();
    try { wrap.setPointerCapture(e.pointerId); } catch { /* pointeur déjà parti */ }
    e.preventDefault();
    input.focus({ preventScroll: true });
  });

  wrap.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    e.preventDefault();
    const { left, min, span, usable } = geom();
    const step = Number(input.step) || 1;
    const ratio = (e.clientX - saisie - left - THUMB_PX / 2) / usable;
    const brut = min + Math.min(1, Math.max(0, ratio)) * span;
    const v = Math.min(Number(input.max), Math.max(min, min + Math.round((brut - min) / step) * step));
    if (String(v) === input.value) return;
    input.value = String(v);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

  const fin = (e) => {
    if (!dragging) return;
    dragging = false;
    try { wrap.releasePointerCapture(e.pointerId); } catch { /* capture déjà relâchée */ }
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  wrap.addEventListener('pointerup', fin);
  wrap.addEventListener('pointercancel', fin);

  return wrap;
}

/** Vide un noeud. */
export function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

/** Nombre lisible : entiers pleins, 1 décimale sinon. */
export function num(n) {
  const v = Number(n) || 0;
  return Number.isInteger(v) ? String(v) : v.toFixed(1).replace(/\.0$/, '');
}

const MOIS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
/** 'yyyy-MM-dd' → '26 juin' (chaîne vide si non parsable). */
export function frDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  if (!m) return '';
  return `${Number(m[3])} ${MOIS[Number(m[2]) - 1] || ''}`.trim();
}

/** Macros compactes d'un plat -> tableau de fragments {label,value}. */
export function macroChips(m = {}) {
  const chips = [];
  if (m.prot_g != null) chips.push(['prot', `${num(m.prot_g)} g`]);
  if (m.kcal != null)   chips.push(['kcal', `${num(m.kcal)}`]);
  // Pas de puce quand la donnée manque : ne rien afficher est plus honnête
  // qu'un « 0 g » (l'étiquetage des fibres est facultatif).
  if (m.fibres_g != null) chips.push(['fibres', `${num(m.fibres_g)} g`]);
  return chips;
}

/** Toast éphémère (info/ok/err). */
let toastTimer;
export function toast(message, kind = '') {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const el = h('div', { class: `toast ${kind ? 'toast--' + kind : ''}` },
    kind === 'ok' ? '✓ ' : kind === 'err' ? '⚠ ' : '', message);
  document.body.append(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), kind === 'err' ? 4200 : 2400);
}
