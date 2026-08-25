#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${1:-$HOME/.local/bin}"

mkdir -p "$TARGET"
chmod +x "$ROOT/bin/assentor"

if command -v pnpm >/dev/null 2>&1; then
  (cd "$ROOT" && pnpm build)
else
  (cd "$ROOT" && npm run build)
fi

ln -sfn "$ROOT/bin/assentor" "$TARGET/assentor"

# Remove legacy forge symlink if present
if [[ -L "$TARGET/forge" ]]; then
  rm -f "$TARGET/forge"
fi

echo "Installed: $TARGET/assentor -> $ROOT/bin/assentor"
echo
echo "Make sure this is on your PATH:"
echo "  export PATH=\"$TARGET:\$PATH\""
echo
echo "Then run:"
echo "  assentor doctor"
echo "  assentor run --project . --executor mock --reviewer mock \"Say hello\""
