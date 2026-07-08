# Enthalpie — Brief de build PWA (Phase 4)

> À ouvrir dans la session **Claude Code**, repo `blushifting/enthalpie`, déploiement **GitHub Pages**.
> Le backend (Google Sheet + Apps Script) est déjà déployé et testé. Ce doc est le contrat complet ;
> la spec de référence reste `SPEC.md` (§4 écrans, §5 moteur, §6 courses, §7 gamification).

## 0. Contexte en une ligne

Assistant nutrition perso, végé/musculation. Log des **exceptions** (pas des repas), **1 tap** par action,
jauges lissées, liste de courses auto. Toute l'intelligence est côté backend/Claude : **la PWA est 100 %
déterministe, offline-first, sans IA, sans framework** (vanilla JS, single-page, installable).

## 1. Backend — contrat d'API

- **API_BASE** : `https://script.google.com/macros/s/AKfycbykJsqIOSd40mhD9YNOHg42rEhgg_Bzf_EAdMJnEaaiD1C9P29Ukg4x44mUcW00SBSN/exec`
- **Auth** : paramètre `token` (secret, saisi une fois dans la PWA et gardé en `localStorage` — NE PAS committer le token dans le repo).
- **Réponse** : `{ ok:true, action, data }` ou `{ ok:false, error }`.
- **CORS/POST** : Apps Script accepte le POST ; envoyer le corps en `text/plain` (JSON.stringify) pour éviter le pre-flight CORS, le backend parse `postData.contents`. Suivre les redirections (`fetch` le fait par défaut).

### GET
| action | data renvoyé |
|---|---|
| `state` | `date`, `creneau_courant`, `jauges{prot_g,fer_mg,kcal:{valeur,cible,ratio}}`, `pools{petit_dej,dejeuner,diner,collation:[{id,nom,type,macros,faisable}]}`, `stock{ref:portions}` |
| `catalog` | `produits[]`, `plats[]` (actifs) |
| `courses` | `horizon_jours`, `groupes{magasin:[lignes]}`, `lignes[{produit_id,nom,magasin,unites,unite_de_vente,portions_manquantes}]` |

### POST (corps JSON, `action:"log"`)
| type | champs | effet |
|---|---|---|
| `plat` | `ref` (plat_id), `quantite?`, `source?` | log + décrément stock |
| `pot_fini` | `ref` (produit_id) | stock→0, recale les médians (calibration) |
| `batch_cuisine` | `ref` (recette/plat_id), `portions?` | +stock du plat batch |
| `courses` | `items:[{produit_id,unites}]` | +stock des articles cochés |
| `ajustement` | `ref`, `delta` | correction manuelle |

Autre : `{action:"cloture"}` (clôture médiane ; déjà automatisée à 3 h côté backend).

## 2. Écrans (SPEC §4)

1. **Aujourd'hui** (défaut) : 3 jauges (prot / fer / kcal) avec report hebdo discret ; tuiles par créneau
   (créneau courant déplié via `creneau_courant`), plats **faisables** en avant / grisés sinon ; tuile
   « ➕ autre » (recherche catalogue) et « ✗ sauté » ; bouton flottant **« Quoi manger ? »** ; bouton **scan**.
2. **Courses** : liste `action=courses` groupée par magasin (Carrefour, Picard) ; cases à cocher →
   « courses validées » = POST `courses` avec les items cochés ; ajout manuel texte libre (hors compteurs).
3. **Cuisine** : recette de la semaine (badge nouveau/batch) ; biblio recettes batch → « je l'ai cuisinée »
   = POST `batch_cuisine` ; compteurs gamifiés (§7).
4. **Bilan** (léger, lecture seule) : courbes 4 semaines prot/fer/kcal vs cibles.

## 3. Moteur « Quoi manger ? » (SPEC §5)

Sur les plats du pool du créneau courant : **filtre dur** `faisable` (déjà fourni par `state`), puis score =
complémentarité nutritionnelle (distance entre jauges restantes du jour et macros du plat — dominant pour
les **collations**) + fraîcheur de rotation (pénalité décroissante, avec plancher) + périssabilité (bonus).
Sortie : **top 3** avec une raison en un mot (« 🥬 fer », « ⏳ à finir », « 🔄 pas mangé depuis N j »). Tap =
POST `plat`. Le calcul se fait côté PWA à partir de `state` + `catalog` (déterministe).

## 4. Scan code-barres (SPEC §2, §4)

`BarcodeDetector` natif (Chrome Android) + fallback **ZXing-js**. EAN →
`https://world.openfoodfacts.org/api/v2/product/{ean}.json`. Selon contexte : produit **en stock** → « pot fini »
(POST `pot_fini`) ; produit **inconnu** → fiche OFF pré-remplie (kcal, prot, allergènes → flags gluten/lactose),
validation 1 tap qui l'ajoute au catalogue (nécessitera un petit endpoint `add_produit` — à ajouter à `Code.gs`).

## 5. Offline-first

Service worker : cache app-shell + dernier `state`/`catalog`. **Log offline mis en file** (localStorage/IndexedDB)
et rejoué au retour réseau. L'app doit rester utilisable et afficher les jauges même hors-ligne.

## 6. Design

Palette **sombre/neutre**, typo sobre, **gros touch targets**, zéro animation superflue. Mobile-first
(usage téléphone, quelques secondes). Le skill `frontend-design` peut être chargé.

## 7. Périmètre v1 (ne PAS faire — SPEC §11)

Pas d'OCR d'étiquettes, pas de photos de repas, pas de multi-utilisateur. Modes stricts gluten/lactose = OFF
(flags seulement). Pas de cible fer dure (jauge fer informative). Backlog v2 tenu à part.

## 8. Petit manque à combler côté backend

La PWA aura besoin d'un endpoint **`add_produit`** (ajout au catalogue depuis un scan OFF) et éventuellement
`search_catalog` (tuile « ➕ autre »). À ajouter dans `backend/Code.gs` quand on branchera le scan — pas
bloquant pour un premier écran « Aujourd'hui ».

---

### Ordre de build suggéré
1. App-shell + config token + `GET state` → écran Aujourd'hui avec jauges et pools.
2. Log 1-tap (POST `plat`) + rafraîchissement des jauges.
3. Moteur « Quoi manger ? ».
4. Écran Courses (+ POST `courses`).
5. Service worker / offline + file de log.
6. Scan (+ endpoints `add_produit`).
7. Écrans Cuisine et Bilan.
8. Déploiement GitHub Pages + manifest PWA (installable).
