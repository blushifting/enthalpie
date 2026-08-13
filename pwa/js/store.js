// Persistance locale : token, API base, cache du dernier state, file de log offline.
import { KEY, DEFAULT_API_BASE } from './config.js';

function read(key, fallback = null) {
  try { const v = localStorage.getItem(key); return v == null ? fallback : v; }
  catch { return fallback; }
}
function readJSON(key, fallback) {
  const raw = read(key);
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}
function write(key, value) {
  try { localStorage.setItem(key, value); } catch { /* quota / mode privé */ }
}

export const store = {
  // --- Token (secret, jamais commité) ---
  getToken() { return read(KEY.token, ''); },
  setToken(t) { write(KEY.token, String(t || '').trim()); },
  hasToken() { return !!this.getToken(); },

  // --- API base ---
  getApiBase() { return read(KEY.apiBase, '') || DEFAULT_API_BASE; },
  setApiBase(u) { write(KEY.apiBase, String(u || '').trim()); },

  // --- Cache du state / catalog (offline-first) ---
  cacheState(state) {
    write(KEY.state, JSON.stringify({ at: Date.now(), state }));
  },
  getCachedState() { return readJSON(KEY.state, null); },
  cacheCatalog(catalog) {
    write(KEY.catalog, JSON.stringify({ at: Date.now(), catalog }));
  },
  getCachedCatalog() { return readJSON(KEY.catalog, null); },
  cacheCourses(courses) {
    write(KEY.courses, JSON.stringify({ at: Date.now(), courses }));
  },
  getCachedCourses() { return readJSON(KEY.courses, null); },

  /**
   * Jette un cache d'écran devenu faux (une réappro change la liste de courses,
   * un batch cuisiné change la cuisine). Le supprimer plutôt que d'y écrire
   * `null` : `getCached*` teste la présence de la charge, et un `{courses:null}`
   * se comporterait comme un cache vide tout en occupant la place.
   */
  clearCache(nom) {
    const k = KEY[nom];
    if (!k) return;
    try { localStorage.removeItem(k); } catch { /* mode privé */ }
  },
  cacheCuisine(cuisine) {
    write(KEY.cuisine, JSON.stringify({ at: Date.now(), cuisine }));
  },
  getCachedCuisine() { return readJSON(KEY.cuisine, null); },
  cacheBilan(bilan) {
    write(KEY.bilan, JSON.stringify({ at: Date.now(), bilan }));
  },
  getCachedBilan() { return readJSON(KEY.bilan, null); },

  // --- Échelle de l'écran Bilan (jour | semaine), retenue entre deux visites ---
  getBilanMode() { return read(KEY.bilanMode) === 'jour' ? 'jour' : 'semaine'; },
  setBilanMode(m) { write(KEY.bilanMode, m === 'jour' ? 'jour' : 'semaine'); },

  // --- Ajouts manuels de courses (texte libre, locaux, hors compteurs) ---
  getCoursesManual() { return readJSON(KEY.manual, []); },
  addCoursesManual(texte) {
    const t = String(texte || '').trim();
    if (!t) return this.getCoursesManual();
    const list = this.getCoursesManual();
    list.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, texte: t });
    write(KEY.manual, JSON.stringify(list));
    return list;
  },
  removeCoursesManual(id) {
    const list = this.getCoursesManual().filter((x) => x.id !== id);
    write(KEY.manual, JSON.stringify(list));
    return list;
  },

  // --- Brouillon de courses (cases cochées + quantités ajustées, persisté) ---
  getCoursesDraft() {
    const d = readJSON(KEY.draft, null);
    return d && typeof d === 'object' ? { checked: d.checked || {}, qty: d.qty || {} } : { checked: {}, qty: {} };
  },
  setCoursesDraft(d) { write(KEY.draft, JSON.stringify(d || { checked: {}, qty: {} })); },

  // --- Articles retirés (« ne plus proposer », masquage local réversible) ---
  getCoursesExclus() { return readJSON(KEY.exclus, []); },
  addCoursesExclus(id, nom) {
    const list = this.getCoursesExclus();
    if (!list.some((x) => x.id === id)) { list.push({ id, nom: nom || id }); write(KEY.exclus, JSON.stringify(list)); }
    return list;
  },
  removeCoursesExclus(id) {
    const list = this.getCoursesExclus().filter((x) => x.id !== id);
    write(KEY.exclus, JSON.stringify(list));
    return list;
  },

  // --- Dernier lot de courses validé (pour annulation) ---
  getLastCourses() { return readJSON(KEY.last, null); },
  setLastCourses(batch) { write(KEY.last, JSON.stringify(batch)); },
  clearLastCourses() { try { localStorage.removeItem(KEY.last); } catch { /* mode privé */ } },

  // --- File de log offline (rejouée au retour réseau) ---
  getQueue() { return readJSON(KEY.queue, []); },
  /**
   * Met une action en attente. L'`id` de l'item EST son `op_id` : si le payload
   * en porte déjà un (tentative directe partie puis perdue), on le REPREND tel
   * quel. En générer un nouveau ferait recompter une écriture qui avait abouti —
   * c'est exactement le bug de double comptage du 2026-08-13.
   */
  enqueue(payload) {
    const q = this.getQueue();
    const id = (payload && payload.op_id)
      || `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    q.push({ id, payload: { ...payload, op_id: id }, at: Date.now() });
    write(KEY.queue, JSON.stringify(q));
    return q;
  },
  setQueue(q) { write(KEY.queue, JSON.stringify(q || [])); },
  queueSize() { return this.getQueue().length; },

  /**
   * Références d'aliments touchées par une action encore en attente.
   * L'écran Aujourd'hui verrouille ces lignes : tant qu'une modification n'est
   * pas partie, le stock affiché n'est plus celui du serveur, et rejouer un
   * curseur par-dessus produisait des doubles comptages (2026-08-13).
   * @returns {Set<string>}
   */
  pendingRefs() {
    const refs = new Set();
    for (const it of this.getQueue()) {
      const p = it.payload || {};
      if (p.ref) refs.add(String(p.ref));
      for (const c of p.changes || []) if (c && c.ref) refs.add(String(c.ref));
      // `items` porte `produit_id` sur les courses et `ref` sur les ajustements
      // groupés (2026-08-13) : les deux verrouillent la ligne concernée.
      for (const i of p.items || []) {
        if (i && i.produit_id) refs.add(String(i.produit_id));
        if (i && i.ref) refs.add(String(i.ref));
      }
    }
    return refs;
  },
};
