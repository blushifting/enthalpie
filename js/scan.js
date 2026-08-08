// Feuille « Scanner un produit » (SPEC §2, §4 ; BUILD-PWA §4).
//
// Chaîne : caméra (getUserMedia, HTTPS obligatoire) → détection code-barres via
// BarcodeDetector natif (Chrome Android — cible d'Azur). Repli universel :
// saisie manuelle de l'EAN (fonctionne partout, y compris en preview sans
// caméra). EAN résolu :
//   - produit DÉJÀ au catalogue  → « j'en ai N » (réappro, POST courses) ou
//                                  « contenant vide » (POST pot_fini) ;
//   - produit INCONNU            → fiche OpenFoodFacts pré-remplie → ajout au
//                                  catalogue AVEC stock initial (POST add_produit).
//
// Deux règles à ne pas perdre de vue dans ce fichier :
//   1. OpenFoodFacts donne des valeurs POUR 100 g. Le Sheet, lui, stocke des
//      valeurs POUR 100 g, et le Sheet aussi : plus aucune conversion ici. Le
//      seul chiffre à connaître est le poids du paquet.
//   2. Un produit ajouté sans stock initial n'apparaît pas dans « Mon stock »
//      (l'inventaire ne liste que stock > 0) → on demande toujours la quantité.
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
 *   findByEan(ean) -> food|null,          // recherche dans le catalogue courant
 *   onRestock(food, unites) -> Promise,   // POST courses (+ stock) + rafraîchissement
 *   onPotFini(food) -> Promise,           // POST pot_fini + rafraîchissement
 *   onAddProduit(fiche) -> Promise,       // POST add_produit + rafraîchissement
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

    const manuel = h('button', { class: 'btn btn--ghost scan-nocode', type: 'button' },
      'Pas de code-barres (vrac, fait maison…)');
    manuel.addEventListener('click', () => showForm('', null, null));

    body.append(frame, camNote,
      h('div', { class: 'scan-manual' }, input, go),
      manuel);

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
    let offErr = null;
    try {
      fiche = await fetchOFF(ean);
    } catch (err) {
      // Hors-ligne / OFF injoignable : cas TRÈS différent de « pas dans la base ».
      // On le distingue à l'écran pour ne pas croire à tort que le produit est inconnu.
      offErr = err instanceof ApiError ? err.message : 'OpenFoodFacts injoignable';
    }
    showForm(ean, fiche, offErr);
  }

  /* ---------------- Vue : produit connu → réappro ou contenant vide -------- */
  function showKnown(food, ean) {
    clear(body);
    const chips = macroChips(food.macros || {});
    const paquet = Math.max(0, Number(food.paquet) || 0);

    let unites = 1;
    const valEl = h('span', { class: 'stepper__val' }, num(unites));
    const dec = h('button', { class: 'stepper__btn', type: 'button', 'aria-label': 'Moins' }, '−');
    const inc = h('button', { class: 'stepper__btn', type: 'button', 'aria-label': 'Plus' }, '＋');
    const apport = h('span', {}, '');
    const applyQty = (u) => {
      unites = Math.max(1, u);
      valEl.textContent = num(unites);
      dec.disabled = unites <= 1;
      apport.textContent = paquet > 0 ? `+ ${num(unites * paquet)} g au stock` : 'poids du paquet inconnu';
    };
    dec.addEventListener('click', () => applyQty(unites - 1));
    inc.addEventListener('click', () => applyQty(unites + 1));
    applyQty(1);

    const addBtn = h('button', { class: 'btn btn--primary', type: 'button' }, 'Ajouter à mon stock');
    addBtn.addEventListener('click', async () => {
      addBtn.disabled = true;
      try { await ctx.onRestock(food, unites); showDone(`${food.nom} — ${num(unites * paquet)} g ajoutés`); }
      catch (err) { addBtn.disabled = false; toast(err instanceof ApiError ? err.message : 'Ajout impossible', 'err'); }
    });

    const finiBtn = h('button', { class: 'btn btn--ghost', type: 'button' }, 'Contenant vide → stock 0');
    finiBtn.addEventListener('click', async () => {
      finiBtn.disabled = true;
      try { await ctx.onPotFini(food); showDone(`${food.nom} — marqué fini`); }
      catch (err) { finiBtn.disabled = false; toast(err instanceof ApiError ? err.message : 'Échec', 'err'); }
    });

    body.append(
      h('div', { class: 'scan-hit' },
        h('div', { class: 'scan-hit__tag' }, '✓ Déjà au catalogue'),
        h('div', { class: 'scan-hit__nom' }, food.nom),
        h('div', { class: 'scan-hit__stock' },
          food.stock > 0
            ? `En stock : ${num(Math.round(food.stock))} g`
            : 'Stock à zéro'),
        chips.length ? h('div', { class: 'scan-hit__macros' },
          ...chips.map(([k, v]) => h('span', {}, h('b', {}, v), ' ', k)),
          h('span', {}, '/ 100 g')) : null,
      ),
      h('div', { class: 'field' },
        h('label', {}, 'Combien de paquets ajoutes-tu ?'),
        h('div', { class: 'crs-row__qty scan-qty' },
          h('div', { class: 'stepper' }, dec, valEl, inc),
          h('span', { class: 'crs-row__unit' }, paquet > 0 ? `× ${num(paquet)} g` : '')),
        h('div', { class: 'field__hint' }, apport)),
      h('div', { class: 'sheet__actions' },
        h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => showScanner() }, 'Scanner un autre'),
        addBtn),
      h('div', { class: 'sheet__actions' }, finiBtn),
    );
  }

  /* ---------------- Vue : produit inconnu → fiche à valider ---------------- */
  // fiche : normalisée depuis OFF (valeurs POUR 100 g) ou null.
  // offErr : message si l'appel OFF a échoué (≠ produit absent de la base).
  function showForm(ean, fiche, offErr) {
    clear(body);
    const errEl = h('div', { class: 'form-error' });

    const nomIn = field_('Nom du produit', fiche && fiche.nom, 'text',
      fiche && fiche.marque ? `Marque : ${fiche.marque}` : 'Tel qu\'il apparaîtra dans l\'app.');
    // Un seul poids à connaître : celui du paquet. Tout le reste s'en déduit —
    // il n'y a plus ni portion ni unité de vente (modèle du 2026-08-08).
    const poidsInit = (fiche && fiche.poids_net_g)
      || parseContenanceG_(fiche && fiche.quantite)
      || '';

    const poidsIn = field_('Poids du paquet (g)', poidsInit, 'number',
      'Le chiffre indispensable : sans lui, aucun apport ne peut être calculé.');
    const kcalIn = field_('kcal pour 100 g', fiche ? fiche.kcal_100g : '', 'number', null);
    const protIn = field_('Protéines pour 100 g (g)', fiche ? fiche.prot_100g : '', 'number', null);
    const fibresIn = field_('Fibres pour 100 g (g)',
      fiche && fiche.fibres_100g != null ? fiche.fibres_100g : '', 'number',
      'Facultatif, souvent absent des étiquettes. Enregistré pour plus tard — aucune jauge ne l\'affiche aujourd\'hui.');
    const stockIn = field_('Combien de paquets as-tu ?', 1, 'number',
      'À 0, le produit n\'apparaîtra pas dans « Mon stock ».');

    const poidsVal = () => Number(poidsIn.input.value) || 0;

    const preview = h('div', { class: 'scan-preview' });
    function syncPreview() {
      const poids = poidsVal();
      const paquets = Math.max(0, Number(stockIn.input.value) || 0);
      clear(preview);

      if (poids <= 0) {
        // Aucun apport n'est calculable sans poids : on le dit plutôt que de
        // laisser croire à un produit correctement enregistré.
        preview.append(h('div', { class: 'scan-preview__line scan-preview__line--warn' },
          'Poids du paquet manquant : les apports ne pourront pas être calculés.'));
        return;
      }

      const r = poids / 100;
      const kcal = Math.round((Number(kcalIn.input.value) || 0) * r);
      const prot = Math.round((Number(protIn.input.value) || 0) * r * 10) / 10;
      preview.append(
        h('div', { class: 'scan-preview__line' },
          'Un paquet entier = ', h('b', {}, `${num(kcal)} kcal`), ' · ',
          h('b', {}, `${num(prot)} g`), ' de protéines'),
        h('div', { class: 'scan-preview__line scan-preview__line--faint' },
          paquets > 0
            ? `Stock de départ : ${num(Math.round(paquets * poids))} g`
            : 'Stock de départ : 0 → n\'apparaîtra pas dans « Mon stock »'),
      );
    }
    [poidsIn, kcalIn, protIn, stockIn].forEach((f) =>
      f.input.addEventListener('input', syncPreview));

    const glutenBox = h('input', { type: 'checkbox', checked: !!(fiche && fiche.flag_gluten === 'oui') });
    const lactoseBox = h('input', { type: 'checkbox', checked: !!(fiche && fiche.flag_lactose === 'oui') });
    const flags = h('div', { class: 'scan-flags' },
      h('label', { class: 'scan-flag' }, glutenBox, h('span', {}, 'Contient du gluten')),
      h('label', { class: 'scan-flag' }, lactoseBox, h('span', {}, 'Contient du lactose')));

    // Trois situations distinctes — surtout ne pas dire « introuvable » quand
    // c'est le réseau qui a lâché.
    const suffix = ean ? ` · EAN ${ean}` : '';
    let head; let note;
    if (fiche) {
      head = h('div', { class: 'scan-hit__tag scan-hit__tag--new' }, `Nouveau${suffix}`);
      note = 'Fiche OpenFoodFacts pré-remplie. Vérifie surtout le poids du paquet.';
    } else if (offErr) {
      head = h('div', { class: 'scan-hit__tag scan-hit__tag--warn' }, `Recherche impossible${suffix}`);
      note = `${offErr} — le produit n'est pas forcément inconnu. Tu peux réessayer plus tard, ou saisir les infos à la main.`;
    } else if (ean) {
      head = h('div', { class: 'scan-hit__tag scan-hit__tag--warn' }, `Absent d'OpenFoodFacts${suffix}`);
      note = 'Aucune fiche dans la base : renseigne les infos depuis l\'étiquette.';
    } else {
      head = h('div', { class: 'scan-hit__tag scan-hit__tag--new' }, 'Produit sans code-barres');
      note = 'Renseigne les infos à la main.';
    }

    const save = h('button', { class: 'btn btn--primary', type: 'button' }, 'Ajouter au catalogue');
    save.addEventListener('click', async () => {
      const nom = nomIn.input.value.trim();
      if (!nom) { errEl.textContent = 'Le nom est requis.'; nomIn.input.focus(); return; }
      const poids = poidsVal();
      if (poids <= 0) {
        errEl.textContent = 'Le poids du paquet est requis : sans lui, aucun apport ne peut être calculé.';
        poidsIn.input.focus();
        return;
      }
      const paquets = Math.max(0, Number(stockIn.input.value) || 0);
      const fibres = fibresIn.input.value.trim();
      const produit = {
        nom, ean,
        marque_magasin: (fiche && fiche.marque) || '',
        // Le Sheet stocke tout POUR 100 g ; aucune conversion ici.
        kcal_100g: Number(kcalIn.input.value) || 0,
        prot_100g: Number(protIn.input.value) || 0,
        // Vide (pas 0) si non renseigné : « sans fibres » et « inconnu » doivent
        // rester distinguables le jour où la jauge fibres arrivera.
        fibres_100g: fibres === '' ? '' : Number(fibres),
        poids_paquet_g: poids,
        flag_gluten: glutenBox.checked ? 'oui' : 'non',
        flag_lactose: lactoseBox.checked ? 'oui' : 'non',
        stock_initial: Math.round(paquets * poids),
      };
      save.disabled = true; errEl.textContent = '';
      try { await ctx.onAddProduit(produit); showDone(`« ${nom} » ajouté avec ${num(Math.round(paquets * poids))} g en stock`); }
      catch (err) { save.disabled = false; errEl.textContent = (err instanceof ApiError ? err.message : 'Ajout impossible'); }
    });

    body.append(head,
      h('p', { class: 'scan-note' }, note),
      nomIn.el, poidsIn.el,
      kcalIn.el, protIn.el, fibresIn.el, stockIn.el,
      preview, flags, errEl,
      h('div', { class: 'sheet__actions' },
        h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => showScanner() }, 'Annuler'),
        save));
    syncPreview();
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
    // Enchaînement rapide quand on inventorie : on reste sur le scanner.
    setTimeout(() => { if (backdrop.isConnected && body.querySelector('.state__icon')) showScanner(); }, 1600);
  }

  showScanner();
}

/* ------------------------------------------------------------------ */
/* Lot écrit en toutes lettres → nombre de portions + poids unitaire    */
/* ------------------------------------------------------------------ */
/**
 * « 360 g (6 x 60 g) » → { n: 6, g: 60 }. Motif fréquent sur les lots (œufs,
 * yaourts, tranches) : il donne d'un coup le nombre de portions et leur poids,
 * les deux inconnues du formulaire. Renvoie null si le motif est absent.
 */
function parseLotG_(texte) {
  const m = String(texte || '').toLowerCase()
    .match(/(\d+)\s*[x×]\s*(\d+(?:[.,]\d+)?)\s*(kg|g|cl|ml|l)\b/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const v = parseFloat(m[2].replace(',', '.'));
  if (!Number.isFinite(n) || n < 1 || !Number.isFinite(v) || v <= 0) return null;
  const mult = { kg: 1000, g: 1, l: 1000, cl: 10, ml: 1 }[m[3]];
  return { n, g: Math.round(v * mult) };
}

/* ------------------------------------------------------------------ */
/* Contenance d'une unité de vente → grammes (ou ml, assimilés)         */
/* ------------------------------------------------------------------ */
/** « pot 500 g » → 500 ; « brique 1 L » → 1000 ; « boîte de 6 » → null. */
function parseContenanceG_(unite) {
  const m = String(unite || '').toLowerCase().match(/(\d+(?:[.,]\d+)?)\s*(kg|g|cl|ml|l)\b/);
  if (!m) return null;
  const v = parseFloat(m[1].replace(',', '.'));
  if (!Number.isFinite(v) || v <= 0) return null;
  switch (m[2]) {
    case 'kg': return v * 1000;
    case 'g':  return v;
    case 'l':  return v * 1000;
    case 'cl': return v * 10;
    case 'ml': return v;
    default:   return null;
  }
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
