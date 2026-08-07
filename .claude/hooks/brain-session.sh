#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# brain-session.sh — hook SessionStart, matchers "startup|resume" (DESIGN.md §7.4)
#
# Role : ouvrir chaque session (et chaque reprise) sur l'etat reel de la base.
#        Tout ce qui part sur stdout est ajoute au contexte de demarrage.
#
# SessionStart est rejoue a chaque resume et a chaque fork : ce releve n'est
# donc jamais perime, contrairement a un texte injecte en milieu de session qui
# serait relu depuis le transcript.
#
# Sortie 0 dans tous les cas : une base non encore indexee ne doit pas empecher
# la session de demarrer.
# ---------------------------------------------------------------------------

set -u

quiet() { exit 0; }
trap 'quiet' ERR

cat >/dev/null 2>&1 || true   # on draine stdin, on n'en a pas besoin

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-}"
if [ -z "$PROJECT_DIR" ]; then
  PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." 2>/dev/null && pwd)" || quiet
fi
BRAIN="$PROJECT_DIR/brain.js"

command -v node >/dev/null 2>&1 || quiet
[ -f "$BRAIN" ] || quiet

STATS="$(cd "$PROJECT_DIR" && node "$BRAIN" stats --short 2>/dev/null)" || quiet
STATS="$(printf '%s' "$STATS" | tr -d '\r' | head -n 3)"
[ -n "${STATS:-}" ] || quiet

printf '%s\n' "$STATS"
printf 'Manuel opératoire : knowledge_base/CLAUDE.md. Moteur : node brain.js search "<termes>" --json --k 5.\n'
exit 0
