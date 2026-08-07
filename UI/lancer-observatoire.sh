#!/bin/sh
# lancer-observatoire.sh — démarre l'observatoire du second cerveau et l'ouvre.
# Peut être appelé par une app du Dock « Observatoire ». Idempotent : si le
# serveur tourne déjà, on ne relance rien, on ouvre juste le navigateur.
#
# Portable : la racine du second cerveau est DÉDUITE de l'emplacement de ce
# script (UI/ est un sous-dossier de la racine), et node est résolu soi-même
# (nvm, Homebrew, /usr/local, PATH) sans dépendre du profil du shell — ce qui
# le rend robuste au contexte GUI (PATH minimal des apps macOS).

PORT=4321

# --- racine déduite : le dossier parent de UI/ ---
UI_DIR="$(cd "$(dirname "$0")" && pwd)"
KB="$(cd "$UI_DIR/.." && pwd)"
URL="http://127.0.0.1:$PORT/univers"

# --- résoudre node ---
NODE=""
for n in "$HOME"/.nvm/versions/node/*/bin/node /opt/homebrew/bin/node /usr/local/bin/node "$(command -v node 2>/dev/null)"; do
  [ -x "$n" ] && NODE="$n" && break
done
if [ -z "$NODE" ]; then
  echo "Node.js est introuvable — impossible de démarrer le serveur." >&2
  command -v osascript >/dev/null 2>&1 && \
    osascript -e 'display alert "Observatoire" message "Node.js est introuvable. Impossible de démarrer le serveur." as critical' 2>/dev/null
  exit 1
fi

# --- la racine existe-t-elle (volume monté) ? ---
if [ ! -d "$KB" ] || [ ! -f "$KB/UI/server.js" ]; then
  echo "Second cerveau introuvable à : $KB" >&2
  command -v osascript >/dev/null 2>&1 && \
    osascript -e 'display alert "Observatoire" message "Le second cerveau est introuvable (racine ou volume absent)." as critical' 2>/dev/null
  exit 1
fi

# --- le serveur tourne-t-il déjà ? ---
CODE=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/" 2>/dev/null || echo 000)
if [ "$CODE" != "200" ]; then
  cd "$KB" || exit 1
  # Détacher vraiment le serveur : le sous-shell « ( … & ) » se termine aussitôt,
  # ce qui reparente node à launchd (PID 1). Il survit ainsi à la fermeture de
  # l'app du Dock — nohup seul ne protège pas du SIGTERM envoyé par macOS.
  ( "$NODE" UI/server.js --port "$PORT" </dev/null >/tmp/observatoire.log 2>&1 & )
  # attendre que le serveur réponde (max ~6 s)
  i=0
  while [ "$i" -lt 24 ]; do
    sleep 0.25
    CODE=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/" 2>/dev/null || echo 000)
    [ "$CODE" = "200" ] && break
    i=$((i + 1))
  done
fi

# --- ouvrir ---
# Sur macOS avec Chrome : fenêtre « application » sans barres, maximisée, dans un
# profil dédié pour honorer les drapeaux même si Chrome tourne déjà. Le ?app=1 dit
# à la page de passer en plein écran HTML5 au premier clic (touche F pour basculer).
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PROFIL="$HOME/.observatoire-chrome"
if [ -x "$CHROME" ]; then
  ( "$CHROME" --user-data-dir="$PROFIL" \
      --app="$URL?app=1" --start-maximized --no-first-run --no-default-browser-check \
      </dev/null >/dev/null 2>&1 & )
elif command -v open >/dev/null 2>&1; then
  open "$URL"                       # macOS : navigateur par défaut (F = plein écran)
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$URL"                   # Linux
else
  echo "Observatoire prêt : $URL"
fi
