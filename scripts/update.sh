#!/usr/bin/env bash
# Update Assentor to the latest main (or rebuild the current checkout).
# Prefer the one-line installer when installed under ~/.assentor.
set -euo pipefail

REPO_URL="${ASSENTOR_REPO:-https://github.com/MasterAkbariDev/Assentor.git}"
INSTALL_DIR="${ASSENTOR_HOME:-$HOME/.assentor}"
BIN_DIR="${ASSENTOR_BIN:-$HOME/.local/bin}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> Assentor update"

# If this checkout is the managed install home, or home exists as a git clone,
# refresh via install.sh semantics.
if [[ "$ROOT" == "$INSTALL_DIR" ]] || [[ -d "$INSTALL_DIR/.git" ]]; then
  echo "    using installer at $INSTALL_DIR"
  exec bash "$ROOT/scripts/install.sh"
fi

# Dev / linked checkout: pull (if git) + rebuild + re-link bin
echo "    package root: $ROOT"
if [[ -d "$ROOT/.git" ]]; then
  echo "==> Pulling latest"
  git -C "$ROOT" pull --ff-only || {
    echo "Warning: git pull failed — rebuilding current checkout" >&2
  }
fi

if command -v pnpm >/dev/null 2>&1; then
  echo "==> Building (pnpm)"
  (cd "$ROOT" && pnpm install && pnpm build)
elif command -v npm >/dev/null 2>&1; then
  echo "==> Building (npm)"
  (cd "$ROOT" && npm install && npm run build)
else
  echo "Error: npm or pnpm is required." >&2
  exit 1
fi

mkdir -p "$BIN_DIR"
chmod +x "$ROOT/bin/assentor"
ln -sfn "$ROOT/bin/assentor" "$BIN_DIR/assentor"

echo
echo "✓ Assentor updated"
echo "  binary: $BIN_DIR/assentor -> $ROOT/bin/assentor"
