// Synchronisation offline : rejeu de la file de log + badge « en attente »,
// et enregistrement du service worker (app-shell offline).
// La file (store.enqueue) est remplie quand un POST échoue faute de réseau ;
// on la rejoue au boot, au retour de connexion (event `online`) et à la demande.
import { store } from './store.js';
import { apiPost, ApiError, IS_DEMO } from './api.js';
import { toast } from './util.js';

/* ------------------------------------------------------------------ */
/* Badge « actions en attente » (topbar)                               */
/* ------------------------------------------------------------------ */
let badgeEl;
export function updateQueueBadge() {
  if (!badgeEl) badgeEl = document.getElementById('queue-badge');
  if (!badgeEl) return;
  const n = store.queueSize();
  badgeEl.hidden = n === 0;
  const nEl = badgeEl.querySelector('.queue-badge__n');
  if (nEl) nEl.textContent = String(n);
  badgeEl.classList.toggle('is-offline', !navigator.onLine);
}

/* ------------------------------------------------------------------ */
/* Rejeu de la file                                                    */
/* ------------------------------------------------------------------ */
let flushing = false;

// Seul un rejet métier explicite du backend est définitif : l'item ne
// passera jamais (ref inconnue…), on l'abandonne pour ne pas bloquer la file.
// Tout le reste (réseau, HTTP momentané, token absent, réponse illisible) est
// transitoire : on garde l'item et on réessaiera plus tard.
function isPermanent(err) {
  return err instanceof ApiError && err.kind === 'backend';
}

/**
 * Rejoue la file de log séquentiellement (FIFO, ordre préservé).
 * Retire chaque item au succès ; s'arrête à la première erreur transitoire.
 * @returns {Promise<{sent:number, dropped:number, remaining:number}>}
 */
export async function flushQueue({ silent = false } = {}) {
  if (IS_DEMO) return { sent: 0, dropped: 0, remaining: 0 };
  if (flushing) return { sent: 0, dropped: 0, remaining: store.queueSize(), busy: true };
  if (!navigator.onLine || !store.hasToken() || !store.queueSize()) {
    updateQueueBadge();
    return { sent: 0, dropped: 0, remaining: store.queueSize() };
  }

  flushing = true;
  let sent = 0;
  let dropped = 0;
  try {
    // On relit la file à chaque tour et on retire l'item traité PAR ID : une
    // action enfilée pendant l'await réseau est ainsi préservée (pas écrasée).
    while (true) {
      const q = store.getQueue();
      if (!q.length) break;
      const item = q[0];
      try {
        await apiPost(item.payload);
        sent++;
      } catch (err) {
        if (!isPermanent(err)) break;   // transitoire → on garde l'item, on réessaiera
        dropped++;                      // rejet backend → item abandonné (ne bloque pas la suite)
      }
      store.setQueue(store.getQueue().filter((x) => x.id !== item.id));
      updateQueueBadge();
    }
  } finally {
    flushing = false;
  }

  updateQueueBadge();
  if (!silent) {
    if (sent) toast(`${sent} action${sent > 1 ? 's' : ''} synchronisée${sent > 1 ? 's' : ''}`, 'ok');
    if (dropped) toast(`${dropped} action${dropped > 1 ? 's' : ''} rejetée${dropped > 1 ? 's' : ''} par le serveur`, 'err');
    else if (!sent && store.queueSize()) toast('Toujours hors-ligne — file conservée', 'err');
  }
  return { sent, dropped, remaining: store.queueSize() };
}

/* ------------------------------------------------------------------ */
/* Service worker (app-shell offline)                                  */
/* ------------------------------------------------------------------ */
// Enregistré uniquement hors développement local : sur localhost le SWR
// servirait des fichiers en cache et masquerait les modifications en cours.
export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const host = location.hostname;
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.local');
  if (isLocal) { console.info('[sw] dev local — service worker non enregistré'); return; }
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
      .catch((e) => console.warn('[sw] enregistrement échoué', e));
  });
}
