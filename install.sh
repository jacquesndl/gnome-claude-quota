#!/usr/bin/env bash
# Installe (ou met à jour) l'extension dans le dossier utilisateur et l'active.
# Usage : ./install.sh            installe / met à jour
#         ./install.sh --remove   désinstalle
set -euo pipefail

UUID="claude-quota@jacques.local"
SRC="$(cd "$(dirname "$0")" && pwd)/$UUID"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"

if [[ "${1:-}" == "--remove" ]]; then
    gnome-extensions disable "$UUID" 2>/dev/null || true
    rm -rf "$DEST"
    echo "Désinstallée. Reconnecte-toi pour retirer l'indicateur de la barre."
    exit 0
fi

major=$(gnome-shell --version | grep -oE '[0-9]+' | head -1)
if ! grep -q "\"$major\"" "$SRC/metadata.json"; then
    echo "Attention : GNOME Shell $major absent de shell-version dans metadata.json." >&2
    echo "Ajoute \"$major\" à la liste, sinon GNOME refusera de charger l'extension." >&2
fi

if [[ ! -f "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.credentials.json" ]]; then
    echo "Attention : Claude Code n'est pas connecté (lance claude puis /login)." >&2
fi

mkdir -p "$DEST"
cp "$SRC/extension.js" "$SRC/metadata.json" "$DEST/"
gnome-extensions enable "$UUID" 2>/dev/null || true

echo "Installée dans $DEST."
if [[ "${XDG_SESSION_TYPE:-}" == "wayland" ]]; then
    echo "Wayland : ferme ta session et reconnecte-toi pour charger la nouvelle version."
else
    echo "X11 : Alt+F2, r, Entrée pour recharger GNOME Shell."
fi
