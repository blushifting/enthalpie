// Feuille « Scanner un produit » (SPEC §2, §4 ; BUILD-PWA §4).
//
// Chaîne : caméra (getUserMedia, HTTPS obligatoire) → détection code-barres via
// BarcodeDetector natif (Chrome Android — cible d'Azur). Repli universel :
// saisie manuelle de l'EAN (fonctionne partout, y compris en preview sans
// caméra). EAN résolu :
//   - produit DÉJÀ au catalogue  → « pot fini » (POST pot_fini, recalibration) ;
//   - produit INCONNU            → fiche OpenFoodFacts pré-remplie → 1 tap pour
//                                  l'ajouter au catalogue (POST add_produit).
//
// Le lecteur ZXing-js (repli pour navigateurs sans BarcodeDetector, ex. iOS)
// n'est pas embarqué pour l'instant : sur ces navigateurs on bascule sur la
// saisie manuelle. Le point d'accroche est prêt (voir tryOtherDecoder_).
import { h, clear, num, macroChips, toast } from './util.js';
import { fetchOFF, ApiError } from './api.js';

const EAN_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128'];

/**
 * openScan(ctx)
 * ctx = {
 *   findByEan(ean) -> food|null,   // recherche dans le catalogue courant
 *   onPotFini(food) -> Promise,     // POST pot_fini + rafraîchissement
 *   onAddProduit(fiche) -> Promise, // POST add_produit + rafraîchissement
 * }
 */
export function openScan(ctx) {
  const root = document.getElementById('sheet-root');
  clear(root);

  let stopCam = null;          // fonction d'arrêt de la caméra (si active)
  let handled = false;         // anti double-détection

  const backdrop = h('div', { class: 'sheet-backdrop' });
  const body = h('div', { class: 'scan-body' });
  const sheet = h('div', { class: 'sheet scan-sheet', role: 'dialog', 'aria-modal': 'true' },
    h('div', { class: 'sheet__handle' }),
    h('h2', {}, 'Scanner un produit'),
    body);
  backdrop.append(sheet);
  root.append(backdrop);

  function close() {
    if (stopCam) { try { stopCam(); } catch { /* ignore */ } stopCam = null; }
    backdrop.remove();
  }
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

  /* ---------------- Vue : scan (caméra + saisie manuelle) ---------------- */
  function showScanner(note) {
    handled = false;
    if (stopCam) { try { stopCam(); } catch { /* ignore */ } stopCam = null; }
    clear(body);

    const video = h('video', { class: 'scan-cam', muted: true, autoplay: true, playsinline: true });
    const frame = h('div', { class: 'scan-frame' }, video, h('div', { class: 'scan-frame__line' }));
    const camNote = h('p', { class: 'scan-note' }, note || 'Vise le code-barres du produit.');

    const input = h('input', {
      class: 'scan-input', type: 'text', inputmode: 'numeric', pattern: '[0-9]*',
      placeholder: 'ou saisis le code (EAN)', autocomplete: 'off', spellcheck: 'false',
      'aria-label': 'Code-barres (EAN)',
    });
    const go = h('button', { class: 'btn btn--primary scan-input__go', type: 'button' }, 'Chercher');
    const submit = () => {
      const code = input.value.replace(/\D/g, '');
      if (code.length < 6) { toast('Code-barres trop court', 'err'); return; }
      onDetected(code);
    };
    go.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });

    body.append(frame, camNote,
      h('div', { class: 'scan-manual' }, input, go));

    startCamera_(video, onDetected).then((stop) => { stopCam = stop; }).catch((err) => {
      // Pas de caméra / accès refusé / navigateur sans détecteur → saisie manuelle.
      frame.classList.add('is-off');
      clear(frame);
      frame.append(h('div', { class: 'scan-frame__off' },
        h('span', { class: 'scan-frame__off-ico', 'aria-hidden': 'true' }, '⌗'),
        h('span', {}, camReason_(err))));
      camNote.textContent = 'Saisis le code-barres à la main ci-dessous.';
      setTimeout(() => input.focus(), 60);
    });
  }

  function onDetected(ean) {
    if (handled) return;
    handled = true;
    if (stopCam) { try { stopCam(); } catch { /* ignore */ } stopCam = null; }
    resolve(ean);
  }

  /* ---------------- Résolution de l'EAN ---------------- */
  async function resolve(ean) {
    const food = ctx.findByEan(ean);
    if (food) { showKnown(food, ean); return; }

    showLoading('Recherche sur OpenFoodFacts…');
    let fiche = null;
    try {
      fiche = await fetchOFF(ean);
    } catch (err) {
      // Hors-ligne / OFF injoignable : on ouvre quand même le formulaire vierge.
      toast(err instanceof ApiError ? err.message : 'OpenFoodFacts injoignable', 'err');
    }
    showForm(ean, fiche);
  }

  /* ---------------- Vue : produit connu → pot fini ---------------- */
  function showKnown(food, ean) {
    clear(body);
    const chips = macroChips(food.macros || {});
    body.append(
      h('div', { class: 'scan-hit' },
        h('div', { class: 'scan-hit__tag' }, '✓ Déjà au catalogue'),
        h('div', { class: 'scan-hit__nom' }, food.nom),
        h('div', { class: 'scan-hit__stock' },
          food.stock > 0
            ? `En stock : ${num(food.stock)} portion${food.stock > 1 ? 's' : ''}`
            : 'Stock déjà à zéro'),
        chips.length ? h('div', { class: 'scan-hit__macros' },
          ...chips.map(([k, v]) => h('span', {}, h('b', {}, v), ' ', k))) : null,
      ),
      h('p', { class: 'scan-note' }, 'Tu scannes le contenant vide ? Marque-le fini : le stock repart de zéro et la calibration se recale.'),
      h('div', { class: 'sheet__actions' },
        h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => showScanner() }, 'Scanner un autre'),
        h('button', { class: 'btn btn--primary', type: 'button',
          onclick: async (e) => {
            const btn = e.currentTarget; btn.disabled = true;
            try { await ctx.onPotFini(food); showDone(`${food.nom} — marqué fini`); }
            catch { btn.disabled = false; }
          } }, 'C\'est fini (pot vide)')),
    );
  }

  /* ---------------- Vue : produit inconnu → fiche à valider ---------------- */
  function showForm(ean, fiche) {
    clear(body);
    const errEl = h('div', { class: 'form-error' });

    const nomIn = field_('Nom du produit', fiche && fiche.nom, 'text',
      fiche && fiche.marque ? `Marque : ${fiche.marque}` : 'Tel qu\'il apparaîtra dans l\'app.');
    const kcalIn = field_('kcal / portion', fiche ? fiche.kcal_100g : '', 'number',
      fiche ? 'OpenFoodFacts : valeur pour 100 g — ajuste si une portion ≠ 100 g.' : null);
    const protIn = field_('Protéines / portion (g)', fiche ? fiche.prot_100g : '', 'number');
    const uniteIn = field_('Unité de vente', fiche && fiche.quantite, 'text', 'ex. « pot 500 g », « boîte de 6 ».');
    const ppuIn = field_('Portions par unité', 1, 'number', 'Combien de portions dans un contenant.');

    const glutenBox = h('input', { type: 'checkbox', checked: !!(fiche && fiche.flag_gluten === 'oui') });
    const lactoseBox = h('input', { type: 'checkbox', checked: !!(fiche && fiche.flag_lactose === 'oui') });
    const flags = h('div', { class: 'scan-flags' },
      h('label', { class: 'scan-flag' }, glutenBox, h('span', {}, 'Contient du gluten')),
      h('label', { class: 'scan-flag' }, lactoseBox, h('span', {}, 'Contient du lactose')));

    const head = fiche
      ? h('div', { class: 'scan-hit__tag scan-hit__tag--new' }, `Nouveau · EAN ${ean}`)
      : h('div', { class: 'scan-hit__tag scan-hit__tag--warn' }, `Introuvable sur OpenFoodFacts · EAN ${ean}`);

    const save = h('button', { class: 'btn btn--primary', type: 'button' }, 'Ajouter au catalogue');
    save.addEventListener('click', async () => {
      const nom = nomIn.input.value.trim();
      if (!nom) { errEl.textContent = 'Le nom est requis.'; nomIn.input.focus(); return; }
      const produit = {
        nom, ean,
        marque_magasin: (fiche && fiche.marque) || '',
        kcal: Number(kcalIn.input.value) || 0,
        prot_g: Number(protIn.input.value) || 0,
        fer_mg: (fiche && fiche.fer_100g_mg) || 0,
        unite_de_vente: uniteIn.input.value.trim(),
        portions_par_unite: Number(ppuIn.input.value) || 1,
        flag_gluten: glutenBox.checked ? 'oui' : 'non',
        flag_lactose: lactoseBox.checked ? 'oui' : 'non',
      };
      save.disabled = true; errEl.textContent = '';
      try { await ctx.onAddProduit(produit); showDone(`« ${nom} » ajouté au catalogue`); }
      catch (err) { save.disabled = false; errEl.textContent = (err instanceof ApiError ? err.message : 'Ajout impossible'); }
    });

    body.append(head,
      h('p', { class: 'scan-note' }, fiche
        ? 'Vérifie et complète, puis ajoute-le. Tu pourras affiner dans le Sheet.'
        : 'Aucune fiche trouvée : renseigne les infos toi-même.'),
      nomIn.el, kcalIn.el, protIn.el, uniteIn.el, ppuIn.el, flags, errEl,
      h('div', { class: 'sheet__actions' },
        h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => showScanner() }, 'Annuler'),
        save));
    setTimeout(() => nomIn.input.focus(), 60);
  }

  /* ---------------- Vues utilitaires ---------------- */
  function showLoading(msg) {
    clear(body);
    body.append(h('div', { class: 'state', style: 'padding:34px 8px' },
      h('div', { class: 'spinner' }),
      h('div', { class: 'state__msg' }, msg)));
  }

  function showDone(msg) {
    clear(body);
    body.append(h('div', { class: 'state', style: 'padding:30px 8px' },
      h('div', { class: 'state__icon' }, '✓'),
      h('div', { class: 'state__msg' }, msg)),
      h('div', { class: 'sheet__actions' },
        h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => showScanner() }, 'Scanner un autre'),
        h('button', { class: 'btn btn--primary', type: 'button', onclick: close }, 'Terminé')));
    setTimeout(() => { if (backdrop.isConnected && body.querySelector('.state__icon')) close(); }, 2200);
  }

  showScanner();
}

/* ------------------------------------------------------------------ */
/* Caméra + détection                                                  */
/* ------------------------------------------------------------------ */
/**
 * Démarre la caméra arrière et branche la détection. Résout avec une fonction
 * d'arrêt (stream + boucle). Rejette si caméra indisponible / refusée / pas de
 * détecteur exploitable → l'appelant bascule sur la saisie manuelle.
 */
async function startCamera_(video, onCode) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new ApiError('nocam', 'nocam');
  }
  const detector = makeDetector_();
  if (!detector) throw new ApiError('nodetector', 'nodetector');

  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' } }, audio: false,
  });
  video.srcObject = stream;
  try { await video.play(); } catch { /* autoplay géré par l'attribut */ }

  let running = true;
  let rafId = 0;
  const tick = async () => {
    if (!running) return;
    try {
      const codes = await detector.detect(video);
      if (running && codes && codes.length && codes[0].rawValue) {
        const raw = String(codes[0].rawValue).replace(/\D/g, '');
        if (raw.length >= 6) { onCode(raw); return; }
      }
    } catch { /* frame non décodable → on continue */ }
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);

  return function stop() {
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
    stream.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
  };
}

/** BarcodeDetector natif si dispo, sinon repli (non embarqué pour l'instant). */
function makeDetector_() {
  if ('BarcodeDetector' in window) {
    try { return new window.BarcodeDetector({ formats: EAN_FORMATS }); }
    catch { try { return new window.BarcodeDetector(); } catch { /* ignore */ } }
  }
  return tryOtherDecoder_();
}

// Point d'accroche pour un lecteur JS (ZXing) sur navigateurs sans
// BarcodeDetector. Non embarqué → renvoie null (saisie manuelle).
function tryOtherDecoder_() { return null; }

function camReason_(err) {
  const k = err && err.kind;
  if (k === 'nodetector') return 'Scanner auto indisponible sur ce navigateur.';
  if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) return 'Accès caméra refusé.';
  if (err && err.name === 'NotFoundError') return 'Aucune caméra détectée.';
  return 'Caméra indisponible.';
}

/* ------------------------------------------------------------------ */
/* Petit champ de formulaire (label + input + hint)                    */
/* ------------------------------------------------------------------ */
function field_(label, value, type, hint) {
  const input = h('input', {
    type: type || 'text', value: value == null ? '' : String(value),
    autocomplete: 'off', spellcheck: 'false',
    inputmode: type === 'number' ? 'decimal' : undefined,
  });
  const el = h('div', { class: 'field' },
    h('label', {}, label), input,
    hint ? h('div', { class: 'field__hint' }, hint) : null);
  return { el, input };
}
