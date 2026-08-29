#!/usr/bin/env bash
# Shared terminal styling for Assentor install scripts.
# shellcheck shell=bash

UI_TOTAL_STEPS="${UI_TOTAL_STEPS:-5}"
UI_STEP=0

ui_init() {
  if [[ -t 1 ]] && [[ "${TERM:-}" != "dumb" ]] && [[ "${NO_COLOR:-}" == "" ]]; then
    UI_RESET=$'\033[0m'
    UI_BOLD=$'\033[1m'
    UI_DIM=$'\033[2m'
    UI_CYAN=$'\033[36m'
    UI_GREEN=$'\033[32m'
    UI_YELLOW=$'\033[33m'
    UI_RED=$'\033[31m'
    UI_MAGENTA=$'\033[35m'
    UI_BLUE=$'\033[34m'
    UI_WHITE=$'\033[97m'
    UI_BG_BLUE=$'\033[44m'
  else
    UI_RESET=""
    UI_BOLD=""
    UI_DIM=""
    UI_CYAN=""
    UI_GREEN=""
    UI_YELLOW=""
    UI_RED=""
    UI_MAGENTA=""
    UI_BLUE=""
    UI_WHITE=""
    UI_BG_BLUE=""
  fi
}

ui_banner() {
  local version="${1:-}"
  echo
  if [[ -n "$UI_CYAN" ]]; then
    echo "${UI_CYAN}${UI_BOLD}    ╭──────────────────────────────────────────────╮${UI_RESET}"
    echo "${UI_CYAN}${UI_BOLD}    │${UI_RESET}  ${UI_WHITE}${UI_BOLD}⬡  ASSENTOR${UI_RESET}  ${UI_DIM}AI agent supervisor${UI_RESET}           ${UI_CYAN}${UI_BOLD}│${UI_RESET}"
    if [[ -n "$version" ]]; then
      echo "${UI_CYAN}${UI_BOLD}    │${UI_RESET}  ${UI_DIM}Installer${UI_RESET}  ${UI_MAGENTA}v${version}${UI_RESET}                          ${UI_CYAN}${UI_BOLD}│${UI_RESET}"
    else
      echo "${UI_CYAN}${UI_BOLD}    │${UI_RESET}  ${UI_DIM}Professional installer${UI_RESET}                    ${UI_CYAN}${UI_BOLD}│${UI_RESET}"
    fi
    echo "${UI_CYAN}${UI_BOLD}    ╰──────────────────────────────────────────────╯${UI_RESET}"
  else
    echo "  ASSENTOR — AI agent supervisor"
    echo "  Installer"
  fi
  echo
}

ui_meta() {
  local label="$1"
  local value="$2"
  printf "  ${UI_DIM}%-10s${UI_RESET} ${UI_WHITE}%s${UI_RESET}\n" "$label" "$value"
}

ui_step() {
  local message="$1"
  UI_STEP=$((UI_STEP + 1))
  echo
  echo "  ${UI_BLUE}${UI_BOLD}[${UI_STEP}/${UI_TOTAL_STEPS}]${UI_RESET} ${UI_BOLD}${message}${UI_RESET}"
}

ui_ok() {
  echo "      ${UI_GREEN}${UI_BOLD}✔${UI_RESET}  $*"
}

ui_warn() {
  echo "      ${UI_YELLOW}${UI_BOLD}!${UI_RESET}  $*"
}

ui_fail() {
  echo "      ${UI_RED}${UI_BOLD}✖${UI_RESET}  $*" >&2
}

ui_die() {
  ui_fail "$@"
  echo >&2
  exit 1
}

ui_cmd() {
  echo "      ${UI_DIM}$ ${UI_RESET}${UI_CYAN}$*${UI_RESET}"
}

ui_panel() {
  local title="$1"
  shift
  echo
  echo "  ${UI_GREEN}${UI_BOLD}╭─ ${title}${UI_RESET}"
  while (($#)); do
    echo "  ${UI_GREEN}${UI_BOLD}│${UI_RESET}  $1"
    shift
  done
  echo "  ${UI_GREEN}${UI_BOLD}╰─${UI_RESET}  ${UI_DIM}────────────────────────────────────────${UI_RESET}"
  echo
}

ui_code() {
  echo "      ${UI_MAGENTA}${UI_BOLD}$*${UI_RESET}"
}
