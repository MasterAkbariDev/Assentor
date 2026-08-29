#!/usr/bin/env bash
# Assentor installer (macOS / Linux)
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/MasterAkbariDev/Assentor/main/scripts/install.sh | bash
set -euo pipefail

REPO_URL="${ASSENTOR_REPO:-https://github.com/MasterAkbariDev/Assentor.git}"
INSTALL_DIR="${ASSENTOR_HOME:-$HOME/.assentor}"
BIN_DIR="${ASSENTOR_BIN:-$HOME/.local/bin}"
UI_TOTAL_STEPS=5

# Inline UI (curl | bash has no lib file). Keep in sync with scripts/lib/install-ui.sh
UI_STEP=0
ui_init() {
  if [[ -t 1 ]] && [[ "${TERM:-}" != "dumb" ]] && [[ "${NO_COLOR:-}" == "" ]]; then
    UI_RESET=$'\033[0m'; UI_BOLD=$'\033[1m'; UI_DIM=$'\033[2m'
    UI_CYAN=$'\033[36m'; UI_GREEN=$'\033[32m'; UI_YELLOW=$'\033[33m'
    UI_RED=$'\033[31m'; UI_MAGENTA=$'\033[35m'; UI_BLUE=$'\033[34m'; UI_WHITE=$'\033[97m'
  else
    UI_RESET=""; UI_BOLD=""; UI_DIM=""; UI_CYAN=""; UI_GREEN=""
    UI_YELLOW=""; UI_RED=""; UI_MAGENTA=""; UI_BLUE=""; UI_WHITE=""
  fi
}
ui_banner() {
  echo
  if [[ -n "$UI_CYAN" ]]; then
    echo "${UI_CYAN}${UI_BOLD}    ╭──────────────────────────────────────────────╮${UI_RESET}"
    echo "${UI_CYAN}${UI_BOLD}    │${UI_RESET}  ${UI_WHITE}${UI_BOLD}⬡  ASSENTOR${UI_RESET}  ${UI_DIM}AI agent supervisor${UI_RESET}           ${UI_CYAN}${UI_BOLD}│${UI_RESET}"
    echo "${UI_CYAN}${UI_BOLD}    │${UI_RESET}  ${UI_DIM}Professional installer${UI_RESET}                    ${UI_CYAN}${UI_BOLD}│${UI_RESET}"
    echo "${UI_CYAN}${UI_BOLD}    ╰──────────────────────────────────────────────╯${UI_RESET}"
  else
    echo "  ASSENTOR — AI agent supervisor"
  fi
  echo
}
ui_meta() { printf "  ${UI_DIM}%-10s${UI_RESET} ${UI_WHITE}%s${UI_RESET}\n" "$1" "$2"; }
ui_step() { UI_STEP=$((UI_STEP + 1)); echo; echo "  ${UI_BLUE}${UI_BOLD}[${UI_STEP}/${UI_TOTAL_STEPS}]${UI_RESET} ${UI_BOLD}$1${UI_RESET}"; }
ui_ok() { echo "      ${UI_GREEN}${UI_BOLD}✔${UI_RESET}  $*"; }
ui_warn() { echo "      ${UI_YELLOW}${UI_BOLD}!${UI_RESET}  $*"; }
ui_fail() { echo "      ${UI_RED}${UI_BOLD}✖${UI_RESET}  $*" >&2; }
ui_die() { ui_fail "$@"; echo >&2; exit 1; }
ui_panel() {
  local title="$1"; shift
  echo; echo "  ${UI_GREEN}${UI_BOLD}╭─ ${title}${UI_RESET}"
  while (($#)); do echo "  ${UI_GREEN}${UI_BOLD}│${UI_RESET}  $1"; shift; done
  echo "  ${UI_GREEN}${UI_BOLD}╰─${UI_RESET}  ${UI_DIM}────────────────────────────────────────${UI_RESET}"; echo
}
ui_code() { echo "      ${UI_MAGENTA}${UI_BOLD}$*${UI_RESET}"; }

ui_init
ui_banner
ui_meta "Install" "$INSTALL_DIR"
ui_meta "Bin" "$BIN_DIR"

ui_step "Checking prerequisites"
if ! command -v node >/dev/null 2>&1; then
  ui_die "Node.js v20+ is required — https://nodejs.org"
fi
NODE_VER="$(node -v)"
NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  ui_die "Node.js v20+ required (found ${NODE_VER})"
fi
ui_ok "Node.js ${NODE_VER}"

if ! command -v git >/dev/null 2>&1; then
  ui_die "git is required — https://git-scm.com"
fi
ui_ok "git $(git --version | awk '{print $3}')"

if command -v pnpm >/dev/null 2>&1; then
  PKG_MGR="pnpm"
  ui_ok "pnpm $(pnpm --version)"
elif command -v npm >/dev/null 2>&1; then
  PKG_MGR="npm"
  ui_ok "npm $(npm --version)"
else
  ui_die "npm or pnpm is required"
fi

ui_step "Fetching Assentor"
if [[ -d "$INSTALL_DIR/.git" ]]; then
  ui_ok "Existing install detected — updating main"
  git -C "$INSTALL_DIR" fetch --depth 1 origin main
  git -C "$INSTALL_DIR" checkout -B main origin/main
else
  ui_ok "Cloning ${REPO_URL}"
  rm -rf "$INSTALL_DIR"
  git clone --depth 1 --branch main "$REPO_URL" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"

ui_step "Installing dependencies"
if [[ "$PKG_MGR" == "pnpm" ]]; then
  pnpm install
else
  npm install
fi
ui_ok "Dependencies installed"

ui_step "Building Assentor"
if [[ "$PKG_MGR" == "pnpm" ]]; then
  pnpm build
else
  npm run build
fi
ui_ok "Build complete"

ui_step "Linking CLI"
mkdir -p "$BIN_DIR"
chmod +x "$INSTALL_DIR/bin/assentor"
ln -sfn "$INSTALL_DIR/bin/assentor" "$BIN_DIR/assentor"
if [[ -L "$BIN_DIR/forge" ]]; then
  rm -f "$BIN_DIR/forge"
  ui_warn "Removed legacy forge symlink"
fi
ui_ok "Linked ${BIN_DIR}/assentor"

INSTALLED_VERSION=""
if [[ -f "$INSTALL_DIR/package.json" ]] && command -v node >/dev/null 2>&1; then
  INSTALLED_VERSION="$(node -p "require('./package.json').version" 2>/dev/null || true)"
fi

PANEL_LINES=()
PANEL_LINES+=("${UI_BOLD}Binary${UI_RESET}     ${BIN_DIR}/assentor")
if [[ -n "$INSTALLED_VERSION" ]]; then
  PANEL_LINES+=("${UI_BOLD}Version${UI_RESET}    v${INSTALLED_VERSION}")
fi
PANEL_LINES+=("${UI_BOLD}Source${UI_RESET}     ${INSTALL_DIR}")

if ! command -v assentor >/dev/null 2>&1; then
  ui_panel "Installed — add Assentor to your PATH" \
    "${PANEL_LINES[@]}" \
    "" \
    "Add to ~/.zshrc or ~/.bashrc:" \
    "  export PATH=\"${BIN_DIR}:\$PATH\"" \
    "" \
    "Then open a new terminal."
else
  ui_panel "Installed successfully" \
    "${PANEL_LINES[@]}" \
    "" \
    "${UI_GREEN}${UI_BOLD}Ready to run.${UI_RESET}"
fi

ui_panel "Quick start" \
  "  assentor doctor" \
  "  assentor ui --project ." \
  "  assentor run --project . --executor mock --reviewer mock \"Say hello\""
