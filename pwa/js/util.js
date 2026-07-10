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
  if (m.fer_mg != null && Number(m.fer_mg) > 0) chips.push(['fer', `${num(m.fer_mg)} mg`]);
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
