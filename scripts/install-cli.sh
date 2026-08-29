#!/usr/bin/env bash
# Link the current checkout into ~/.local/bin (development install).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${1:-$HOME/.local/bin}"
UI_TOTAL_STEPS=3

# shellcheck source=lib/install-ui.sh
source "$(dirname "$0")/lib/install-ui.sh"

ui_init
ui_banner "$(node -p "require('$ROOT/package.json').version" 2>/dev/null || echo "")"
ui_meta "Checkout" "$ROOT"
ui_meta "Bin" "$TARGET"

ui_step "Building from source"
if command -v pnpm >/dev/null 2>&1; then
  ui_ok "Using pnpm"
  (cd "$ROOT" && pnpm build)
else
  ui_ok "Using npm"
  (cd "$ROOT" && npm run build)
fi
ui_ok "Build complete"

ui_step "Linking assentor CLI"
mkdir -p "$TARGET"
chmod +x "$ROOT/bin/assentor"
ln -sfn "$ROOT/bin/assentor" "$TARGET/assentor"
if [[ -L "$TARGET/forge" ]]; then
  rm -f "$TARGET/forge"
  ui_warn "Removed legacy forge symlink"
fi
ui_ok "Linked ${TARGET}/assentor"

ui_step "Verify PATH"
if command -v assentor >/dev/null 2>&1; then
  ui_ok "assentor is on PATH ($(command -v assentor))"
else
  ui_warn "assentor not on PATH yet"
fi

VERSION="$(node -p "require('$ROOT/package.json').version" 2>/dev/null || echo "dev")"
ui_panel "Development install ready" \
  "${UI_BOLD}Binary${UI_RESET}     ${TARGET}/assentor" \
  "${UI_BOLD}Version${UI_RESET}    v${VERSION}" \
  "${UI_BOLD}Target${UI_RESET}     ${ROOT}/bin/assentor" \
  "" \
  "If needed, add to your shell profile:" \
  "  export PATH=\"${TARGET}:\$PATH\""

ui_panel "Next steps" \
  "  assentor doctor" \
  "  assentor ui --project ."
