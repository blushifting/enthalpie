// Moteur de priorité (SPEC §5) — 100 % déterministe, calculé côté PWA.
//
// Classe une liste d'items { id, nom, macros:{kcal,prot_g}, ... } par
// COMPLÉMENTARITÉ avec les jauges restantes du jour : si la journée manque de
// protéines, les aliments protéinés remontent. Sert à trier silencieusement la
// liste d'aliments ET à alimenter « Quoi manger ? ».
//
// Le fer a été retiré du modèle (2026-08-08) : OpenFoodFacts le renseigne trop
// rarement pour qu'un score le distingue, et il n'avait pas de cible chiffrée.
// Signaux différés (enrichissement backend) : fraîcheur de rotation, périssabilité.

const W = { prot: 1.0, kcal: 0.6 };

function context(state) {
  const j = state.jauges;
  const cibleProt = Number(j.prot_g.cible) || 0;
  const cibleKcal = Number(j.kcal.cible) || 0;
  return {
    cibleProt, cibleKcal,
    remProt: Math.max(0, cibleProt - Number(j.prot_g.valeur)),
    remKcal: Math.max(0, cibleKcal - Number(j.kcal.valeur)),
    overKcal: Number(j.kcal.valeur) >= cibleKcal && cibleKcal > 0,
  };
}

function scoreItem(item, ctx) {
  const m = item.macros || {};
  // Gain utile borné par le besoin restant : récompense la complémentarité, pas l'excès.
  const gainProt = ctx.cibleProt ? Math.min(Number(m.prot_g) || 0, ctx.remProt) / ctx.cibleProt : 0;
  const gainKcal = ctx.cibleKcal ? Math.min(Number(m.kcal) || 0, ctx.remKcal) / ctx.cibleKcal : 0;

  let penalty = 0;
  if (ctx.overKcal) penalty += ((Number(m.kcal) || 0) / (ctx.cibleKcal || 1)) * 0.6;

  const parts = { prot: W.prot * gainProt, kcal: W.kcal * gainKcal };
  return { parts, score: parts.prot + parts.kcal - penalty };
}

/** Classe des items par priorité décroissante. @returns [{item, score, parts, reason}] */
export function rank(state, items) {
  if (!items || !items.length) return [];
  const ctx = context(state);
  return items
    .map((item) => {
      const s = scoreItem(item, ctx);
      return { item, score: s.score, parts: s.parts, reason: reasonOf(s.parts, ctx) };
    })
    .sort((a, b) => b.score - a.score);
}

/** Raison en un mot selon l'axe dominant (SPEC §5). */
function reasonOf(parts, ctx) {
  if (ctx.remProt <= 0 && ctx.remKcal <= 0) return { emoji: '🍃', mot: 'léger' };
  const top = Object.entries(parts).sort((a, b) => b[1] - a[1])[0][0];
  if (top === 'prot') return { emoji: '💪', mot: 'protéines' };
  return { emoji: '🔥', mot: 'calories' };
}
