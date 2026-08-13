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
- **L'écran Aujourd'hui ne peint que l'état du serveur.** Aucun optimisme sur le **stock**.
  Pendant l'envoi, les lignes sont gelées ; si le lot part en file, elles restent gelées,
  marquées « en attente », et un bandeau prévient que les chiffres ne comptent pas encore ces
  modifications. Empiler une saisie sur un état local divergent était la manœuvre exacte qui
  produisait les doublons.
  - **Seule exception, ajoutée le 2026-08-13 :** au tap sur « Valider », les anneaux partent vers
    la valeur **projetée** (macros × grammes, calculées localement), en teinte atténuée, et se
    calent sur la réponse. Ce n'est pas un retour de l'optimisme d'avant : la projection **n'est
    écrite nulle part** et se recalcule depuis l'état serveur à chaque peinture — un échec
    d'envoi la reprend. Ce qui produisait les doublons était un bump **persisté** qui survivait à
    l'échec. La ligne de partage à tenir : *on peut anticiper un affichage dérivé, jamais
    mémoriser un état que le serveur n'a pas confirmé.*
- **Un curseur reculé retire aussi les apports du jour**, plafonné à ce qui a été logué le jour
  même (`commit_`) : un `ajustement` seul ne touche pas les jauges, c'était le bug.
- Un lot de curseurs = **un seul POST `commit`**. Démarrage = **un seul GET `boot`**
  (state + catalog). Ne pas revenir à N appels.
- **Toute réponse d'écriture contient l'état frais** (`ecrire_` l'attache, plus le catalogue
  quand il a pu changer). La PWA l'adopte : **ne jamais réintroduire un `boot` enchaîné derrière
  une écriture** — c'était deux exécutions Apps Script pour un seul geste.

## Règle n°3 : la lenteur vient d'Apps Script, pas de nous

Mesuré le **2026-08-13** (12 appels sur une requête à une seule lecture d'onglet) : médiane
~2,3 s, mais **un appel sur trois dépasse 22 s**, max 36,6 s. Tout ce temps part dans le
**premier saut HTTP** (`script.google.com`, où le script s'exécute) ; le second, qui rapporte le
corps, coûte 0,3 s. Ce plancher de ~1,8 s est l'ordonnancement de Google et ne s'optimise pas.

- Les appels lents **finissent par réussir**. `fetchDouble` (`pwa/js/api.js`) en lance donc un
  second à 6 s (12 s en écriture) et garde celui qui répond ; l'`op_id` rend le doublon inoffensif.
  **Toute écriture doit en porter un** — `apiPost` en frappe un si l'appelant n'en fournit pas.
- **Un timeout ne veut pas dire « hors-ligne ».** Vérifier `navigator.onLine` avant de l'écrire :
  annoncer une panne de réseau à quelqu'un de connecté l'envoie chercher un problème inexistant.
- Côté backend, ce qui s'ajoute au plancher se réduit vraiment : mémo par exécution
  (`readTable_`), lectures bornées à la queue de `log`/`ops` (`readTail_`), `boot` en
  `CacheService` sous **clé versionnée** — versionnée et non effacée, sinon une lecture partie
  avant l'écriture peut y redéposer un état périmé. **Ne pas ajouter de lecture d'onglet non
  mémoïsée sur un chemin de requête.**
- **Ne jamais conclure à une panne du backend sur un seul appel lent** : refaire la mesure,
  `-m 90`. Détail chiffré dans `backend-doc/README.md` §1 (OneDrive).

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
`APP_VERSION` (`pwa/js/config.js`) se bumpe **avec** lui : les Réglages affichent les deux, et une
divergence est le symptôme d'une mise à jour à moitié appliquée.

Publication de la PWA : `git subtree push --prefix=pwa origin gh-pages`. GitHub Pages sert
l'ancienne version jusqu'à ~10 min (`max-age=600`) — vérifier avec un paramètre anti-cache avant
de croire à un échec de déploiement.

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
