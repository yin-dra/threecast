# threecast — MIT License
# shellcheck shell=bash
# Step (2), the client. Sourced by ./threecast; defines cmd_client and client_passthrough.
# Must stay bash 3.2 compatible.

TC_PUBLIC_NODE=https://snap.farcaster.xyz:3381
TC_CLIENT_COMMANDS="login new-account whoami logout feed apps profile cast delete like unlike recast unrecast follow unfollow web"

client_usage() {
  cat <<'EOF'
Usage: ./threecast client [--node URL] [--phrase-file PATH] [--account-index N]

Installs the client's libraries if needed, opens the SSH tunnel to your node,
checks that the node is synced, logs you in if this laptop has no app key yet,
and opens the web client on http://127.0.0.1:4040 (or the next free port).

  --node URL            use this node instead of the tunnel, e.g. a public one
  --phrase-file PATH    passed to login: read the recovery phrase from a file
  --account-index N     passed to login: address index (other wallets' phrases)
EOF
}

client_need_node() {
  command -v node >/dev/null 2>&1 || die "Node.js is not installed. The client needs version 24 or newer." \
    "macOS: brew install node" "Any system: nvm install 24 (https://github.com/nvm-sh/nvm)"
  local major
  major=$(node -p 'process.versions.node.split(".")[0]')
  [ "$major" -ge 24 ] || die "Node.js $(node --version) is too old: the client needs 24 or newer." \
    "macOS: brew upgrade node    nvm: nvm install 24 && nvm use 24"
}

# npm ci when nothing is installed, or the lockfile changed since (after a git pull, say).
# npm writes node_modules/.package-lock.json after every install, so it dates the install.
client_deps() {
  local dir="$TC_ROOT/client"
  local installed="$dir/node_modules/.package-lock.json"
  if [ -f "$installed" ] && [ ! "$dir/package-lock.json" -nt "$installed" ]; then
    return 0
  fi
  need_cmd npm
  step "Installing the client's libraries with npm ci (pinned by package-lock.json)…"
  (cd "$dir" && npm ci --omit=dev --no-audit --no-fund --loglevel=error) \
    || die "npm ci failed." "Check your internet connection, then run the command again."
  ok "Client libraries installed."
}

client_node_given() {
  local a
  for a in "$@"; do
    case "$a" in --node|--node=*) return 0 ;; esac
  done
  [ -n "${THREECAST_NODE:-}" ]
}

client_wants_help() {
  local a
  for a in "$@"; do
    case "$a" in -h|--help) return 0 ;; esac
  done
  return 1
}

# Points the client at the node: --node or THREECAST_NODE if given, else the target's SSH tunnel.
client_connect() {
  client_node_given "$@" && return 0
  target_exists || die "No server named '$(target_name)' yet, so there is no node of yours to use." \
    "Set one up first: ./threecast up (step 0)." \
    "Reading works meanwhile, through Farcaster's public node:" \
    "  ./threecast feed --node $TC_PUBLIC_NODE --as 3"
  load_target
  tunnel_up
  THREECAST_NODE=$(tunnel_url)
  export THREECAST_NODE
}

client_logged_in() {
  local fid
  [ -f "$TC_HOME/accounts/current" ] || return 1
  fid=$(cat "$TC_HOME/accounts/current")
  [ -f "$TC_HOME/accounts/$fid.json" ]
}

client_cli() {
  node "$TC_ROOT/client/src/cli.ts" "$@"
}

cmd_client() {
  local node_args=() login_args=() rc=0
  while [ $# -gt 0 ]; do
    case "$1" in
      -h|--help) client_usage; return 0 ;;
      --node) [ $# -ge 2 ] || die "--node needs a URL."; node_args+=(--node "$2"); shift 2 ;;
      --node=*) node_args+=("$1"); shift ;;
      --phrase-file|--account-index) [ $# -ge 2 ] || die "$1 needs a value."; login_args+=("$1" "$2"); shift 2 ;;
      --phrase-file=*|--account-index=*) login_args+=("$1"); shift ;;
      *) die "./threecast client does not take '$1'." "See ./threecast client --help" ;;
    esac
  done

  client_need_node
  client_deps
  client_connect ${node_args[@]+"${node_args[@]}"}

  step "Checking that the node answers and is synced (GET /v1/info)…"
  client_cli ping ${node_args[@]+"${node_args[@]}"} || rc=$?
  if [ "$rc" = 3 ]; then
    say "Logging in and posting need a synced node."
    say "Reading works meanwhile, from Farcaster's public node:"
    hint "./threecast feed --node $TC_PUBLIC_NODE --as 3"
    hint "Your node's progress: ./threecast status"
    if { [ -t 0 ] || [ "$TC_YES" = 1 ]; } && confirm "Open the web client read-only on the public node, as FID 3?"; then
      exec node "$TC_ROOT/client/src/cli.ts" web --node "$TC_PUBLIC_NODE" --as 3
    fi
    return 0
  fi
  [ "$rc" = 0 ] || exit "$rc"

  if ! client_logged_in; then
    step "This laptop has no app key yet, so first: ./threecast login"
    client_cli login ${node_args[@]+"${node_args[@]}"} ${login_args[@]+"${login_args[@]}"}
  fi

  step "Starting the web client (it prints its address; Ctrl-C stops it)…"
  exec node "$TC_ROOT/client/src/cli.ts" web ${node_args[@]+"${node_args[@]}"}
}

# client_passthrough CMD ARGS — every client command other than `client` itself.
client_passthrough() {
  local cmd=$1
  shift
  case " $TC_CLIENT_COMMANDS " in
    *" $cmd "*) ;;
    *) warn "There is no command '$cmd'."; usage >&2; exit 1 ;;
  esac
  client_need_node
  client_deps
  if ! client_wants_help "$@"; then
    # whoami works without a node; it only asks one when there is one to ask.
    if [ "$cmd" != whoami ] || client_node_given "$@" || target_exists; then
      client_connect "$@"
    fi
  fi
  exec node "$TC_ROOT/client/src/cli.ts" "$cmd" "$@"
}
