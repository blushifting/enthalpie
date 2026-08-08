#!/usr/bin/env bash
# Redéploiement du WebApp Apps Script sans passer par l'éditeur.
#
# Met à jour le déploiement EXISTANT (nouvelle version) : l'URL /exec — donc
# l'API_BASE de la PWA (pwa/js/config.js) — reste inchangée.
#
# Prérequis, une seule fois :
#   1. API Apps Script activée : https://script.google.com/home/usersettings
#   2. clasp login                      (OAuth dans le navigateur)
#   3. backend/.clasp.json présent      (scriptId + rootDir, non versionné)
#   4. backend/.deployment-id           (l'id AKfycb… , non versionné)
#
# Usage : bash backend/deployer.sh

set -euo pipefail

cd "$(dirname "$0")"

if [ ! -f .clasp.json ]; then
  echo "✗ backend/.clasp.json manquant — voir l'en-tête de ce script." >&2
  exit 1
fi
if [ ! -f .deployment-id ]; then
  echo "✗ backend/.deployment-id manquant — voir l'en-tête de ce script." >&2
  exit 1
fi

DEPLOYMENT_ID="$(tr -d ' \r\n' < .deployment-id)"

# --- Garde-fou d'identité --------------------------------------------------
# Vérifie que .clasp.json désigne bien LE projet qui sert l'API_BASE de la PWA.
# Sans ça, un scriptId erroné ferait pousser Enthalpie par-dessus un autre de
# tes scripts Apps Script — et clasp ne demande aucune confirmation.
if ! clasp list-deployments 2>/dev/null | grep -q "$DEPLOYMENT_ID"; then
  echo "✗ Arrêt : le déploiement $DEPLOYMENT_ID n'appartient pas au projet" >&2
  echo "  décrit par backend/.clasp.json. Mauvais scriptId — rien n'a été poussé." >&2
  exit 1
fi

# --- Garde-fou : le distant a-t-il divergé ? -------------------------------
# `clasp push` écrase le projet distant. Si quelqu'un a édité dans l'éditeur
# Apps Script sans reporter ici, on perdrait ces modifs. On récupère donc le
# distant dans un dossier jetable et on compare avant de pousser.
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cp .clasp.json "$TMP/.clasp.json"
( cd "$TMP" && clasp pull >/dev/null )

# On compare sur le nom SANS extension : Apps Script ne stocke pas d'extension,
# et clasp rapatrie un fichier `Code` en `Code.js` alors qu'il s'appelle `Code.gs`
# ici. Comparer `*.gs` à `*.gs` ne verrait donc jamais le distant.
remote_src() { find "$TMP" -maxdepth 1 -type f \( -name '*.gs' -o -name '*.js' -o -name '*.html' \) ; }

DIVERGENCE=0
for f in *.gs; do
  base="${f%.*}"
  jumeau=""
  if   [ -f "$TMP/${base}.gs" ]; then jumeau="$TMP/${base}.gs"
  elif [ -f "$TMP/${base}.js" ]; then jumeau="$TMP/${base}.js"
  fi
  if [ -z "$jumeau" ]; then
    echo "→ $f : nouveau fichier (absent du distant)"
  elif ! diff -q --strip-trailing-cr "$f" "$jumeau" >/dev/null; then
    echo "→ $f : modifié localement"
  fi
done

# Tout fichier source présent en ligne mais absent ici serait SUPPRIMÉ par le push.
while read -r r; do
  base="$(basename "${r%.*}")"
  if [ ! -f "${base}.gs" ]; then
    echo "⚠ $(basename "$r") existe SUR LE DISTANT mais pas ici — il serait supprimé."
    DIVERGENCE=1
  fi
done < <(remote_src)

# clasp refuse de pousser sans manifeste : on le récupère du distant au 1er run.
if [ ! -f appsscript.json ] && [ -f "$TMP/appsscript.json" ]; then
  cp "$TMP/appsscript.json" appsscript.json
  echo "→ appsscript.json récupéré du distant (manifeste requis par clasp)"
fi

if [ "$DIVERGENCE" = "1" ]; then
  echo
  echo "✗ Arrêt : le distant contient des fichiers absents du dépôt." >&2
  echo "  Récupère-les d'abord (clasp pull) avant de redéployer." >&2
  exit 1
fi

# --- Push + nouvelle version du déploiement existant ----------------------
echo
echo "· Envoi du code…"
clasp push --force

echo "· Nouvelle version sur le déploiement $DEPLOYMENT_ID…"
clasp update-deployment "$DEPLOYMENT_ID" -d "deploy $(date +%Y-%m-%d\ %H:%M)"

echo
echo "✓ Redéployé. L'API_BASE n'a pas changé."
echo "  Rappel : si SCHEMA a bougé, lancer setup() une fois dans l'éditeur"
echo "  (clasp run demande une config GCP séparée — non mise en place)."
