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

  // --- File de log offline (rejouée au retour réseau) ---
  getQueue() { return readJSON(KEY.queue, []); },
  enqueue(payload) {
    const q = this.getQueue();
    q.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, payload, at: Date.now() });
    write(KEY.queue, JSON.stringify(q));
    return q;
  },
  setQueue(q) { write(KEY.queue, JSON.stringify(q || [])); },
  queueSize() { return this.getQueue().length; },
};
