# threecast — MIT License
# shellcheck shell=bash
# Shared helpers for the local (laptop) side. Sourced, never executed.
# Must stay bash 3.2 compatible: macOS ships /bin/bash 3.2.

TC_HOME=${THREECAST_HOME:-$HOME/.threecast}
TC_TARGET=${THREECAST_TARGET:-}
TC_YES=${THREECAST_YES:-0}

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  _b=$'\033[1m'; _d=$'\033[2m'; _r=$'\033[0m'
else
  _b=''; _d=''; _r=''
fi

say()  { printf '%s\n' "$*"; }
step() { printf '%s→ %s%s\n' "$_b" "$*" "$_r"; }
ok()   { printf '✓ %s\n' "$*"; }
hint() { printf '%s  %s%s\n' "$_d" "$*" "$_r"; }
warn() { printf '! %s\n' "$*" >&2; }
die()  {
  printf '✗ %s\n' "$1" >&2
  shift
  local line
  for line in "$@"; do printf '  %s\n' "$line" >&2; done
  exit 1
}

need_cmd() {
  local c
  for c in "$@"; do
    command -v "$c" >/dev/null 2>&1 || die "'$c' is not installed." \
      "macOS: brew install $c    Debian/Ubuntu: sudo apt-get install -y $c"
  done
}

# confirm "Question?" -> 0 on yes. --yes / THREECAST_YES=1 answers yes.
confirm() {
  [ "$TC_YES" = 1 ] && return 0
  [ -t 0 ] || die "$1" "No terminal to answer on. Re-run with --yes to accept."
  local a
  printf '%s [y/N] ' "$1"
  read -r a
  case "$a" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

# ask_secret "Prompt" VAR — hidden input, nothing echoed, nothing in history.
ask_secret() {
  [ -t 0 ] || die "Need a terminal to read $2."
  local v
  printf '%s ' "$1" >&2
  stty -echo
  # Ctrl-C at this prompt must not leave the terminal without echo.
  trap 'stty echo; printf "\n" >&2; exit 130' INT
  read -r v || true
  trap - INT
  stty echo
  printf '\n' >&2
  printf -v "$2" '%s' "$v"
}

tc_init_home() {
  umask 077
  mkdir -p "$TC_HOME/targets" "$TC_HOME/accounts" "$TC_HOME/cache" "$TC_HOME/run" "$TC_HOME/ssh"
  chmod 700 "$TC_HOME"
}

target_name() {
  if [ -n "$TC_TARGET" ]; then printf '%s\n' "$TC_TARGET"; return; fi
  if [ -f "$TC_HOME/current" ]; then cat "$TC_HOME/current"; return; fi
  printf 'threecast\n'
}

target_file() { printf '%s/targets/%s.env\n' "$TC_HOME" "${1:-$(target_name)}"; }

target_exists() { [ -f "$(target_file "${1:-}")" ]; }

# Loads the target's KEY=value file into the environment.
load_target() {
  local f
  f=$(target_file "${1:-}")
  [ -f "$f" ] || die "No server named '$(target_name)' yet." "Run ./threecast up first (step 0)."
  # shellcheck disable=SC1090
  . "$f"
  printf '%s\n' "$NAME" > "$TC_HOME/current"
}

# target_set KEY VALUE — upsert one line in the current target file.
target_set() {
  local f tmp
  f=$(target_file)
  tmp="$f.tmp"
  touch "$f"
  grep -v "^$1=" "$f" > "$tmp" || true
  printf '%s=%q\n' "$1" "$2" >> "$tmp"
  mv "$tmp" "$f"
  chmod 600 "$f"
  printf -v "$1" '%s' "$2"
}

_ssh_opts() {
  printf '%s\n' -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=30 \
    -o StrictHostKeyChecking=accept-new -o "UserKnownHostsFile=$TC_HOME/known_hosts" -o LogLevel=ERROR
  if [ -n "${SSH_KEY:-}" ]; then printf '%s\n' -i "$SSH_KEY" -o IdentitiesOnly=yes; fi
}

# ssh_node [cmd...] — runs on the loaded target as SSH_USER@HOST.
ssh_node() {
  local opts=() o
  while IFS= read -r o; do opts+=("$o"); done < <(_ssh_opts)
  # shellcheck disable=SC2029 # callers pass the remote command on purpose
  ssh "${opts[@]}" "${SSH_USER:-root}@$HOST" "$@"
}

# ssh_node_tty [cmd...] — same, with a terminal (for interactive shells).
ssh_node_tty() {
  local opts=() o
  while IFS= read -r o; do [ "$o" = BatchMode=yes ] && o=BatchMode=no; opts+=("$o"); done < <(_ssh_opts)
  ssh -t "${opts[@]}" "${SSH_USER:-root}@$HOST" "$@"
}

# scp_node SRC... DEST_ON_SERVER
scp_node() {
  local opts=() o args=() dest
  while IFS= read -r o; do opts+=("$o"); done < <(_ssh_opts)
  while [ $# -gt 1 ]; do args+=("$1"); shift; done
  dest=$1
  scp -q "${opts[@]}" "${args[@]}" "${SSH_USER:-root}@$HOST:$dest"
}

# Removes a leading --name/--yes from the arg list for every command.
# Usage: parse_common_flags "$@"; set -- "${TC_ARGS[@]+"${TC_ARGS[@]}"}"
parse_common_flags() {
  TC_ARGS=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --name) [ $# -ge 2 ] || die "--name needs a value"; TC_TARGET=$2; shift 2 ;;
      --name=*) TC_TARGET=${1#--name=}; shift ;;
      --yes|-y) TC_YES=1; shift ;;
      *) TC_ARGS+=("$1"); shift ;;
    esac
  done
}
