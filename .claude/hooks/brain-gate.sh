#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# brain-gate.sh — hook PreToolUse, matcher "WebSearch|WebFetch" (DESIGN.md §7.2)
#
# Role : empecher un aller-retour sur le web tant que la base locale n'a pas
#        ete interrogee dans la session — SANS jamais pouvoir coincer la session.
#
# Une porte qui bloque tout un apres-midi coute plus cher que les quelques
# recherches web qu'elle aurait evitees. D'ou six garde-fous :
#
#   1. KILL SWITCH  : BRAIN_GATE_OFF=1 dans l'environnement -> la porte est ouverte.
#   2. REFUS UNIQUE : le refus n'est emis QU'UNE FOIS par session. Le marqueur
#      /tmp/brain-denied-<session> est cree sous « set -o noclobber » (equivalent
#      shell de O_EXCL) : le premier gagne, et si la creation echoue on laisse
#      passer. Les fois suivantes : simple rappel non bloquant.
#   3. TTL 30 min   : un temoin plus vieux que 1800 s est perime — on rappelle,
#      on ne refuse pas. Une consultation d'il y a deux heures ne prouve rien
#      sur la question posee maintenant, mais elle ne merite pas un blocage.
#   4. INDEX PERIME : si une fiche de wiki/ est plus recente que l'index, la
#      base n'est pas en droit d'exiger d'etre crue -> rappel, pas refus.
#   5. ECHEC OUVERT : toute erreur interne, tout JSON illisible -> on laisse passer.
#   6. PORTEE       : uniquement WebSearch/WebFetch (le matcher du settings.json).
#      Jamais Bash ni Grep : une commande composee n'a pas de cible analysable.
#
# « deny » est le SEUL verdict dont la raison est transmise au modele : ni
# « allow » ni « ask » ne remontent permissionDecisionReason. Le rappel non
# bloquant passe donc par systemMessage, qui s'adresse a l'utilisateur.
#
# La raison de refus porte la commande exacte a executer et, quand c'est
# possible, la liste des sections locales deja trouvees : un refus doit
# apprendre quelque chose, pas seulement bloquer.
# ---------------------------------------------------------------------------

set -u

pass() { exit 0; }
trap 'pass' ERR

# --- garde-fou 1 : kill switch ---------------------------------------------
[ "${BRAIN_GATE_OFF:-0}" = "1" ] && pass

INPUT="$(cat 2>/dev/null || true)"
[ -n "${INPUT:-}" ] || pass

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-}"
if [ -z "$PROJECT_DIR" ]; then
  PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." 2>/dev/null && pwd)" || pass
fi
BRAIN="$PROJECT_DIR/brain.js"

if command -v jq >/dev/null 2>&1; then ENGINE="jq"; else ENGINE="node"; fi

read_path() { # $1 = chemin type "session_id" ou "tool_input.query" ; JSON sur stdin
  if [ "$ENGINE" = "jq" ]; then
    jq -r --arg p "$1" '
      ($p | split(".")) as $k
      | reduce $k[] as $s (.; if (type == "object") then (.[$s] // null) else null end)
      | if . == null then "" else tostring end' 2>/dev/null
  else
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{let v=JSON.parse(s);for(const k of process.argv[1].split(".")){v=(v&&typeof v==="object")?v[k]:undefined;}process.stdout.write(v==null?"":String(v));}catch(e){}});' "$1" 2>/dev/null
  fi
}

SESSION="$(printf '%s' "$INPUT" | read_path session_id)"
[ -n "${SESSION:-}" ] || SESSION="${CLAUDE_SESSION_ID:-inconnue}"
SESSION_SAFE="$(printf '%s' "$SESSION" | tr -c 'A-Za-z0-9_.-' '_')"
WITNESS="/tmp/brain-consulted-${SESSION_SAFE}"
DENIED="/tmp/brain-denied-${SESSION_SAFE}"

TOOL="$(printf '%s' "$INPUT" | read_path tool_name)"
[ -n "${TOOL:-}" ] || TOOL="l'outil web"

# --- rappel non bloquant (systemMessage), puis on laisse passer -------------
nudge() { # $1 = texte
  if [ "$ENGINE" = "jq" ]; then
    jq -n --arg m "$1" '{systemMessage: $m}' 2>/dev/null || pass
  else
    NUDGE_MSG="$1" node -e 'process.stdout.write(JSON.stringify({systemMessage:process.env.NUDGE_MSG}));' 2>/dev/null || pass
  fi
  exit 0
}

# --- garde-fou 3 : temoin present, et sa fraicheur --------------------------
if [ -f "$WITNESS" ]; then
  PERIME="$(find "$WITNESS" -mmin +30 -print 2>/dev/null || true)"
  if [ -n "$PERIME" ]; then
    nudge "brain.js n'a plus été interrogé depuis plus de 30 minutes dans cette session — ${TOOL} passe quand même. Un « node brain.js search » sur la question du moment reste moins cher qu'un aller-retour web."
  fi
  pass
fi

# --- garde-fou 4 : un index perime n'a pas le droit d'exiger d'etre cru -----
IDX="$PROJECT_DIR/.brain/index.json.gz"
if [ -f "$IDX" ] && [ -d "$PROJECT_DIR/wiki" ]; then
  PLUS_RECENT="$(find "$PROJECT_DIR/wiki" -name '*.md' -newer "$IDX" -print 2>/dev/null | head -n 1 || true)"
  if [ -n "$PLUS_RECENT" ]; then
    nudge "L'index local est plus ancien que wiki/ : ${TOOL} passe sans être refusé. Une réindexation (node brain.js index) rendrait la base à nouveau opposable."
  fi
fi

# --- temoin absent : refus MOTIVE, mais une seule fois par session ----------
# Creation atomique du marqueur : si le fichier existe deja, noclobber echoue
# et on degrade en rappel. Toute autre erreur laisse passer.
set -o noclobber
if ! (: > "$DENIED") 2>/dev/null; then
  set +o noclobber
  nudge "La base locale n'a toujours pas été interrogée dans cette session ; ${TOOL} passe quand même (le refus n'est émis qu'une fois). node brain.js search \"…\" reste le premier réflexe."
fi
set +o noclobber

# Termes : la requete WebSearch, sinon l'URL / le prompt du WebFetch.
TERMS="$(printf '%s' "$INPUT" | read_path tool_input.query)"
[ -n "${TERMS:-}" ] || TERMS="$(printf '%s' "$INPUT" | read_path tool_input.prompt)"
[ -n "${TERMS:-}" ] || TERMS="$(printf '%s' "$INPUT" | read_path tool_input.url)"
[ -n "${TERMS:-}" ] || TERMS="<termes de la recherche>"
TERMS_SHORT="$(printf '%s' "$TERMS" | tr '\n' ' ' | cut -c1-160)"

# Aperçu des resultats locaux, si le moteur est disponible et la requete utile.
LOCAL=""
if [ -f "$BRAIN" ] && command -v node >/dev/null 2>&1 && [ "$TERMS" != "<termes de la recherche>" ]; then
  RESULT="$(cd "$PROJECT_DIR" && node "$BRAIN" search "$TERMS_SHORT" --json --k 3 2>/dev/null)" || RESULT=""
  if [ -n "$RESULT" ]; then
    LOCAL="$(printf '%s' "$RESULT" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);const r=o.results||[];
if(!r.length)return;process.stdout.write(" Sections locales déjà repérées pour ces termes : "+r.map(x=>(x.file||"?")+"#L"+(x.line_start||0)+" ("+(x.evidence||"?")+")").join(" ; ")+".");}catch(e){}});' 2>/dev/null)" || LOCAL=""
  fi
fi

REASON="La base de connaissances locale n'a pas encore été interrogée dans cette session : ${TOOL} est refusé pour l'instant. Exécuter d'abord : node brain.js search \"${TERMS_SHORT}\" --json --k 5 (depuis knowledge_base/).${LOCAL} La règle vaut aussi pour les sous-agents lancés depuis cette session. Si le moteur renvoie confidence: low ou aucun résultat, relancer ${TOOL} : ce refus n'est émis qu'une fois par session, la porte laissera passer."

if [ "$ENGINE" = "jq" ]; then
  jq -n --arg r "$REASON" '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: $r}}' 2>/dev/null || pass
else
  REASON="$REASON" node -e 'process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:process.env.REASON}}));' 2>/dev/null || pass
fi
exit 0
