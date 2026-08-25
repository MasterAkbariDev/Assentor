#!/usr/bin/env bash
# Uninstall the Assentor CLI symlink (and optionally the managed install dir).
# Does NOT delete project .assentor/ folders.
#
# Usage:
#   ./scripts/uninstall.sh
#   ./scripts/uninstall.sh --purge   # also remove ~/.assentor managed install
set -euo pipefail

BIN_DIR="${ASSENTOR_BIN:-$HOME/.local/bin}"
INSTALL_DIR="${ASSENTOR_HOME:-$HOME/.assentor}"
PURGE=false

for arg in "$@"; do
  case "$arg" in
    --purge) PURGE=true ;;
    -h|--help)
      echo "Usage: uninstall.sh [--purge]"
      echo "  Removes $BIN_DIR/assentor"
      echo "  --purge also removes $INSTALL_DIR (managed install only)"
      exit 0
      ;;
  esac
done

echo "==> Assentor uninstall"

if [[ -L "$BIN_DIR/assentor" || -f "$BIN_DIR/assentor" ]]; then
  rm -f "$BIN_DIR/assentor"
  echo "✓ Removed $BIN_DIR/assentor"
else
  echo "· No assentor binary at $BIN_DIR/assentor"
fi

# Legacy forge symlink
if [[ -L "$BIN_DIR/forge" ]]; then
  rm -f "$BIN_DIR/forge"
  echo "✓ Removed legacy $BIN_DIR/forge"
fi

if [[ "$PURGE" == true ]]; then
  if [[ -d "$INSTALL_DIR" ]]; then
    if [[ -f "$INSTALL_DIR/package.json" ]] && grep -q '"name"[[:space:]]*:[[:space:]]*"assentor"' "$INSTALL_DIR/package.json" 2>/dev/null; then
      # Refuse to purge if INSTALL_DIR looks like an active developer workspace under Developer/
      case "$INSTALL_DIR" in
        */Developer/*|*/dev/*)
          echo "Refusing to --purge developer checkout: $INSTALL_DIR" >&2
          echo "Remove the bin symlink only, or delete the folder yourself." >&2
          exit 1
          ;;
      esac
      rm -rf "$INSTALL_DIR"
      echo "✓ Removed managed install $INSTALL_DIR"
    else
      echo "Skip purge: $INSTALL_DIR does not look like an Assentor install"
    fi
  else
    echo "· No managed install at $INSTALL_DIR"
  fi
else
  echo "· Kept $INSTALL_DIR (pass --purge to remove managed install)"
fi

echo
echo "Project folders (.assentor/) were not touched."
echo "Done."
