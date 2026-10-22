# shellcheck shell=bash
# threecast — MIT License
# SSH to the node: `threecast ssh`, and the tunnel through which the laptop reaches the node's
# HTTP API. The tunnel keeps 3381 closed to the internet, so nobody else can use your node.

TUNNEL_DEFAULT_PORT=13381

cmd_ssh() {
  case "${1:-}" in
    -h|--help)
      say "Usage: ./threecast ssh [--name N] [command...]"
      hint "Without a command: an interactive shell on the server."
      hint "With one, it runs there, e.g. ./threecast ssh df -h"
      return 0 ;;
  esac
  load_target
  if [ $# -eq 0 ]; then
    hint "Opening a shell on $SSH_USER@$HOST. Type exit to leave."
    ssh_node_tty
  else
    ssh_node "$@"
  fi
}

tunnel_socket() { printf '%s/run/%s.sock\n' "$TC_HOME" "$NAME"; }

tunnel_port_busy() {
  (: <"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}

tunnel_open() {
  ssh -S "$(tunnel_socket)" -O check "${SSH_USER:-root}@$HOST" 2>/dev/null
}

# tunnel_up — idempotent. Forwards 127.0.0.1:TUNNEL_PORT on this laptop to 127.0.0.1:3381 on the
# server through one background ssh (a control master, so it can be checked and closed later).
tunnel_up() {
  local port opts=() o log
  [ -n "${HOST:-}" ] || load_target
  tunnel_open && return 0
  rm -f "$(tunnel_socket)"
  port=${TUNNEL_PORT:-$TUNNEL_DEFAULT_PORT}
  if tunnel_port_busy "$port"; then
    local busy=$port
    while tunnel_port_busy "$port"; do
      port=$((port + 1))
      [ "$port" -lt $((busy + 100)) ] || die "Ports $busy to $port on this laptop are all in use; cannot open the tunnel."
    done
    hint "Port $busy is taken on this laptop, so the tunnel uses $port."
  fi
  [ "$port" = "${TUNNEL_PORT:-}" ] || target_set TUNNEL_PORT "$port"
  while IFS= read -r o; do opts+=("$o"); done < <(_ssh_opts)
  step "Opening an SSH tunnel: 127.0.0.1:$port on this laptop → the node's API on ${HOST}…"
  # The tunnel stays in the background after this command ends. Some OpenSSH versions keep
  # the caller's stdout and stderr open in it, which would hang `./threecast feed | head`.
  log=$TC_HOME/run/$NAME.tunnel.log
  if ! ssh "${opts[@]}" -o ExitOnForwardFailure=yes -M -S "$(tunnel_socket)" -fN \
    -L "127.0.0.1:$port:127.0.0.1:3381" "${SSH_USER:-root}@$HOST" </dev/null >/dev/null 2>"$log"; then
    cat "$log" >&2
    die "Could not open the SSH tunnel to $HOST." "Check that ./threecast ssh works, then try again."
  fi
}

tunnel_down() {
  [ -n "${HOST:-}" ] || return 0
  if tunnel_open; then
    ssh -S "$(tunnel_socket)" -O exit "${SSH_USER:-root}@$HOST" 2>/dev/null || true
    ok "Closed the SSH tunnel to $HOST."
  fi
  rm -f "$(tunnel_socket)"
}

tunnel_url() {
  printf 'http://127.0.0.1:%s\n' "${TUNNEL_PORT:-$TUNNEL_DEFAULT_PORT}"
}
