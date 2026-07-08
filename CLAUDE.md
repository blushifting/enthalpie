# Enthalpie — instructions projet (pour Claude Code)

Assistant nutrition perso. Ce dossier contient déjà la spec, le backend déployé et le catalogue.
Ta mission : **construire la PWA (Phase 4) et la déployer sur GitHub Pages, en autonomie.**

## Ce qui existe déjà (ne pas refaire)
- `SPEC.md` — spécification complète (source de vérité). Écrans §4, moteur §5, courses §6.
- `BUILD-PWA.md` — **brief de build à suivre** : contrat d'API, API_BASE, écrans, ordre de build en 8 étapes.
- `backend/` — Apps Script **déjà déployé et testé** (Google Sheet + WebApp). Ne pas redéployer.
  Contrat d'API dans `backend/README.md`. L'API_BASE est dans `BUILD-PWA.md`.
- `skill-nutrition/SKILL.md` — cibles nutritionnelles figées (110 g prot, 2850 kcal, fer non chiffré).
  Règle projet : **aucune valeur nutritionnelle chiffrée improvisée** hors de ce skill.

## Où travailler
- Mets tout le code PWA dans un sous-dossier **`pwa/`** (ne pas polluer `backend/` ni la racine).
- Vanilla JS, single-page, installable, offline-first. **Pas de framework, pas de build step** si évitable
  (GitHub Pages sert du statique). Voir contraintes design dans `BUILD-PWA.md §6`.

## GitHub / déploiement (à faire toi-même via `gh` CLI)
- Repo cible : **`blushifting/enthalpie`** (le créer avec `gh repo create` s'il n'existe pas ; public, sinon Pages payant).
- `git init` ici si besoin, commits propres, push sur `main`.
- Activer **GitHub Pages** sur `main` (racine ou `/pwa` selon structure) via `gh api` — cible finale
  `https://blushifting.github.io/enthalpie`. HTTPS obligatoire (service worker + caméra du scan).
- Demander confirmation avant le premier `push` et avant de rendre le repo public.

## Secrets — important
- Le **token** de l'API backend est un secret : il est saisi une fois dans la PWA et stocké en
  `localStorage`. **Ne jamais le committer** dans le repo (pas de token en dur, pas dans un `config.js` poussé).

## Périmètre v1 (SPEC §11 — ne PAS faire)
Pas d'OCR d'étiquettes, pas de photo de repas, pas de multi-utilisateur. Modes stricts gluten/lactose = OFF.
Jauge fer informative (pas de cible). Commencer par l'écran **« Aujourd'hui » + log 1-tap** (priorité pour
le rodage avant le 18 juillet), puis dérouler l'ordre de build de `BUILD-PWA.md`.

## Manque backend connu (à ajouter dans `backend/Code.gs` au moment du scan)
Endpoints `add_produit` (ajout catalogue depuis une fiche OpenFoodFacts) et `search_catalog` (tuile
« ➕ autre »). Non bloquant pour les premiers écrans. Si tu les ajoutes, me le signaler : le Sheet devra
être redéployé (nouvelle version du déploiement WebApp).
