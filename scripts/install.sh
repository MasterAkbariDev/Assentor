#!/usr/bin/env bash
# Assentor installer (macOS / Linux)
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/MasterAkbariDev/Assentor/main/scripts/install.sh | bash
set -euo pipefail

REPO_URL="${ASSENTOR_REPO:-https://github.com/MasterAkbariDev/Assentor.git}"
INSTALL_DIR="${ASSENTOR_HOME:-$HOME/.assentor}"
BIN_DIR="${ASSENTOR_BIN:-$HOME/.local/bin}"

echo "==> Assentor installer"
echo "    install dir: $INSTALL_DIR"
echo "    bin dir:     $BIN_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js is required (v20+)." >&2
  echo "Install from https://nodejs.org and re-run." >&2
  exit 1
fi

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  echo "Error: Node.js v20+ required (found $(node -v))." >&2
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  echo "Error: git is required." >&2
  exit 1
fi

if [[ -d "$INSTALL_DIR/.git" ]]; then
  echo "==> Updating existing install"
  git -C "$INSTALL_DIR" fetch --depth 1 origin main
  git -C "$INSTALL_DIR" checkout -B main origin/main
else
  echo "==> Cloning Assentor"
  rm -rf "$INSTALL_DIR"
  git clone --depth 1 --branch main "$REPO_URL" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"

if command -v pnpm >/dev/null 2>&1; then
  echo "==> Installing dependencies (pnpm)"
  pnpm install
  pnpm build
elif command -v npm >/dev/null 2>&1; then
  echo "==> Installing dependencies (npm)"
  npm install
  npm run build
else
  echo "Error: npm or pnpm is required." >&2
  exit 1
fi

mkdir -p "$BIN_DIR"
chmod +x "$INSTALL_DIR/bin/assentor"
ln -sfn "$INSTALL_DIR/bin/assentor" "$BIN_DIR/assentor"

# Drop legacy forge symlink if present
if [[ -L "$BIN_DIR/forge" ]]; then
  rm -f "$BIN_DIR/forge"
fi

echo
echo "✓ Assentor installed"
echo "  binary: $BIN_DIR/assentor"
echo
if ! command -v assentor >/dev/null 2>&1; then
  echo "Add this to your shell profile, then reopen the terminal:"
  echo "  export PATH=\"$BIN_DIR:\$PATH\""
  echo
fi
echo "Quick start:"
echo "  assentor doctor"
echo "  assentor run --project . --executor mock --reviewer mock \"Say hello\""
