# Enthalpie — instructions projet (pour Claude Code)

Assistant nutrition perso : PWA vanilla JS + Google Sheet piloté par Apps Script.
**Le build est livré** (2026-07-14) et en ligne sur https://blushifting.github.io/enthalpie/.
On est en phase de **rodage** : corrections, ajustements UX, enrichissement du catalogue.

## Règle n°1 : le gramme

Refonte du **2026-08-08** — à ne jamais reperdre :

- **Le gramme est l'unité interne unique** : stock, quantités des logs, compositions.
- **Toutes les valeurs nutritionnelles sont pour 100 g**, côté OpenFoodFacts comme côté Sheet.
  **Aucune conversion nulle part** (`scan.js` n'en fait plus).
- **Plus de portions.** L'app raisonne en pourcentage d'un paquet dont on connaît le poids
  (`poids_paquet_g`) — c'est le pivot du curseur de l'écran Aujourd'hui.
- **Plus de fer.** `fibres_100g` a pris sa place et porte **sa propre jauge depuis le 2026-08-09**
  (cible 30 g/j, colonne `objectifs.fibres_g_jour`). Vide ≠ 0 (« on ne sait pas » vs « sans
  fibres ») : ce `null` se propage jusqu'à l'écran, qui affiche « — fibres ».
  **La jauge sous-compte par construction** : elle additionne les aliments documentés et n'estime
  jamais les autres (skill nutrition §6). Ne pas « boucher les trous » — les renseigner depuis
  Ciqual, produit par produit. Et **ne pas en faire un axe de score** dans `engine.js` : pondérer
  une donnée absente d'un aliment sur trois pénalise les produits mal documentés, ce qui est
  exactement l'erreur qui avait coûté sa place au fer.
- **Plus de clôture médiane** ni de ligne `médian` : elle inventait une consommation *et* puisait
  dans le stock. Un jour sans saisie ne génère rien.

Le schéma qui fait foi est la constante `SCHEMA` en tête de `backend/Code.gs`.

## Règle n°2 : on n'affiche jamais un stock non synchronisé

Refonte du **2026-08-13**, après des doubles comptages en usage réel :

- **Toute écriture porte un `op_id`** et le backend mémorise ceux déjà appliqués
  (onglet `ops`). Apps Script répond en 1 à 3 s derrière une redirection : quand la réponse se
  perd, la PWA rejoue — sans identifiant, le rejeu comptait une deuxième fois. **Ne jamais
  ajouter un appel d'écriture sans `op_id`**, et **reprendre le même** quand on met en file une
  tentative perdue (`store.enqueue` s'en charge si le payload le porte).
- **Toute écriture passe par `ecrire_()`** côté backend, donc par `LockService`. Sans verrou,
  deux `adjustStock_` concurrents lisent le même stock et le second écrase le premier.
- **L'écran Aujourd'hui ne peint que l'état du serveur.** Plus d'optimisme sur le stock ni sur
  les jauges (sauf mode démo). Pendant l'envoi, les lignes sont gelées ; si le lot part en file,
  elles restent gelées, marquées « en attente », et un bandeau prévient que les chiffres ne
  comptent pas encore ces modifications. Empiler une saisie sur un état local divergent était
  la manœuvre exacte qui produisait les doublons.
- **Un curseur reculé retire aussi les apports du jour**, plafonné à ce qui a été logué le jour
  même (`commit_`) : un `ajustement` seul ne touche pas les jauges, c'était le bug.
- Un lot de curseurs = **un seul POST `commit`**, dont la réponse contient l'état frais.
  Démarrage = **un seul GET `boot`** (state + catalog). Ne pas revenir à N appels.

## Deux invariants du scan / de toute entrée de stock

1. **Un produit à stock 0 est invisible dans l'inventaire** (`today.js` ne liste que `stock > 0`).
   Toute voie d'ajout au catalogue doit demander une quantité (`stock_initial`).
2. **Scanner un produit déjà connu ne doit pas proposer d'abord « contenant vide »** : inventorier
   ses courses viderait le stock. L'action principale est « j'en ai N paquets » → `log/courses`.

## Organisation

- `pwa/` — la PWA. Vanilla JS, single-page, installable, offline-first. **Pas de framework, pas de
  build step.** Écrans : `today.js`, `courses.js`, `cuisine.js`, `bilan.js` ; transverses :
  `api.js`, `store.js`, `sync.js`, `engine.js`, `scan.js`, `exterieur.js`, `quoimanger.js`.
- `backend/` — `Code.gs` (WebApp Apps Script) + `deployer.sh`.
- `BUILD-PWA.md` — **archive** du brief de build de juillet. Périmé, conservé pour mémoire.

## Documentation de référence (dans OneDrive, pas ici)

| Besoin | Fichier |
|---|---|
| Contrat d'API, schéma des onglets, redéploiement, piège curl | `C:\Users\antoi\OneDrive\Desktop\Enthalpie\backend-doc\README.md` |
| Spec : écrans, moteur, modèle, feuille de route | `C:\Users\antoi\OneDrive\Desktop\Enthalpie\SPEC.md` (révisée 2026-08-09) |
| Cibles nutritionnelles figées | `…\Enthalpie\skill-nutrition\SKILL.md` |

**Règle projet : aucune valeur nutritionnelle chiffrée improvisée.** Les cibles viennent du skill,
les valeurs par aliment d'OpenFoodFacts (produits de marque) ou de Ciqual/ANSES (génériques).

## Backend — redéploiement

`bash backend/deployer.sh` : pousse `Code.gs` via clasp et crée une **nouvelle version du
déploiement existant**, donc l'`API_BASE` ne change pas. **Ne jamais créer un nouveau
déploiement** — l'URL changerait et la PWA pointerait dans le vide. Si `SCHEMA` a bougé, relancer
`setup()` une fois dans l'éditeur Apps Script.

Prérequis non versionnés : `backend/.clasp.json` et `backend/.deployment-id`.

**Ordre : backend d'abord, PWA ensuite.** Le front rend conditionnellement ce que le backend
pourrait ne pas encore renvoyer (jauge fibres, `jours[]` du bilan) ; l'ordre inverse afficherait une
version dégradée le temps du décalage. Et **bumper `CACHE` dans `pwa/sw.js`** à chaque release,
sinon l'ancien app-shell reste servi et la modif n'apparaît pas — le piège classique de ce projet.

**Piège curl** : ne jamais mettre `-X POST` pour appeler l'API. Apps Script répond 302 ; avec
`-X POST` curl re-POSTe sur la cible et reçoit une page HTML d'erreur **alors que l'écriture a eu
lieu**. Sans `-X`, curl bascule en GET sur la redirection, comme le navigateur.

## Secrets

Le **token** de l'API est un secret : saisi une fois dans la PWA, gardé en `localStorage`.
**Jamais dans le repo** — pas de token en dur, pas dans un `config.js` poussé. L'`API_BASE`, elle,
n'est pas un secret et vit dans `pwa/js/config.js`.

## Périmètre v1 (ne PAS faire)

Pas d'OCR d'étiquettes, pas de photo de repas, pas de multi-utilisateur. Modes stricts
gluten/lactose = OFF (flags posés, activables après diagnostic — **ne pas retirer le gluten avant
le test cœliaque**, la sérologie serait faussée).

## Chantiers ouverts

- Les onglets `plats` et `recettes` sont **vides** : l'écran Cuisine est inerte et la liste de
  courses ne s'appuie que sur les produits bruts.
- La liste de courses reste vide tant que le journal n'a pas 14 jours de consommation (le rythme
  est nul). Normal, pas un bug.
- Routine hebdo (SPEC §9) : pas encore construite.

## Langue

Français partout (UI, commentaires, commits). Anglais seulement pour les identifiants techniques.
