#!/bin/sh
# Dream Sequence quotidienne — distillation raw/ → wiki/ (brouillons), sur Haiku,
# via l'ABONNEMENT claude.ai (claude -p headless). Jamais l'API facturée au token.
#
# DÉCLENCHEMENT : deux options (voir routines/README.md).
#   a) launchd (com.secondbrain.dream.plist) si votre installation le permet ;
#   b) opportuniste : si le second cerveau vit sur un volume amovible, launchd
#      peut ne pas pouvoir l'exécuter (TCC volumes amovibles → exit 126). Dans ce
#      cas, tools/capture-session.js (hook SessionEnd) peut lancer ce script en
#      arrière-plan quand la dernière passe date de plus de 24 h — il tourne alors
#      dans la session utilisateur, avec tous les droits.
#
# Cascade de portes par coût croissant (le pire cas est un report, jamais une corruption) :
#   1. verrou (reprise des verrous morts après 2 h)
#   2. réindexation brain.js — gratuite, déterministe
#   3. estampille .brain/last-dream (au plus une tentative par 24 h)
#   4. y a-t-il du travail ? (raw non traité OU brouillons à consolider) sinon STOP
#   5. seulement alors : appel IA (Haiku), qui n'écrit qu'en statut draft
#
# Journal : .brain/dream-nightly.log

# Racine DÉDUITE de l'emplacement du script (routines/ est sous la racine).
KB="$(cd "$(dirname "$0")/.." && pwd)"
# node et claude résolus génériquement (PATH), sans chemin personnel codé en dur.
NODE="$(command -v node || echo node)"
CLAUDE="$(command -v claude || true)"

cd "$KB" || exit 0
mkdir -p .brain
LOG="$KB/.brain/dream-nightly.log"
LOCK="$KB/.brain/dream.lock"

# ── porte 1 : verrou ─────────────────────────────────────────────────────────
if [ -f "$LOCK" ]; then
  if [ -n "$(find "$LOCK" -mmin +120 2>/dev/null)" ]; then
    rm -f "$LOCK"                          # verrou mort (> 2 h) : on reprend
  else
    exit 0                                 # une passe tourne déjà
  fi
fi
echo $$ > "$LOCK"
trap 'rm -f "$LOCK"' EXIT INT TERM

echo "== $(date '+%F %T') — passe nocturne" >> "$LOG"

# ── porte 2 : réindexation (gratuite) ────────────────────────────────────────
"$NODE" brain.js index >> "$LOG" 2>&1

# ── porte 3 : estampille — au plus une tentative par 24 h ───────────────────
date '+%F %T' > "$KB/.brain/last-dream"

# ── porte 4 : y a-t-il du travail pour l'IA ? ───────────────────────────────
UNPROC=$("$NODE" brain.js lint --json 2>/dev/null | "$NODE" -e '
let s = "";
process.stdin.on("data", d => s += d).on("end", () => {
  try { console.log((JSON.parse(s).raw_unprocessed || []).length); }
  catch (e) { console.log(0); }
});')
DRAFTS=$(grep -rl "statut: draft" wiki --include="*.md" 2>/dev/null | grep -cv "_templates/")

if [ "${UNPROC:-0}" = "0" ] && [ "${DRAFTS:-0}" = "0" ]; then
  echo "rien à distiller (raw à jour, aucun brouillon) — pas d'appel IA" >> "$LOG"
  exit 0
fi

# ── porte 5 : Dream sur Haiku, abonnement, brouillons uniquement ────────────
[ -x "$CLAUDE" ] || CLAUDE="$(command -v claude)"
if [ -z "$CLAUDE" ] || [ ! -x "$CLAUDE" ]; then
  echo "claude introuvable — passe reportée" >> "$LOG"
  exit 0
fi

"$CLAUDE" -p "/dream" --model haiku --permission-mode acceptEdits >> "$LOG" 2>&1
echo "fin $(date '+%T') — traité : $UNPROC source(s) brute(s), $DRAFTS brouillon(s)" >> "$LOG"
