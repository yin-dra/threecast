# shellcheck shell=bash
# threecast — MIT License
# `down`: delete a rented server and everything threecast created with it, or forget your own.

down_usage() {
  cat <<'EOF'
Usage: ./threecast down [--name N] [--yes]

Rented server: deletes the server, its volume (the node database), firewall,
IP addresses and the SSH key threecast uploaded, so billing stops. You type the
name to confirm.
Your own server (--host): offers to stop the node, then forgets the server.
Nothing on it is deleted unless you add --purge.

  --purge                          own server only: also delete the data
                                   directory
  --provider hetzner|digitalocean  clean up after an interrupted ./threecast up:
                                   deletes what threecast created for --name
                                   even though it was never saved
  --yes                            do not ask
EOF
}

cmd_down() {
  local provider='' purge=0 name
  while [ $# -gt 0 ]; do
    case "$1" in
      --provider=*) provider=${1#*=}; shift ;;
      --provider)   [ $# -ge 2 ] || die "--provider needs a value."; provider=$2; shift 2 ;;
      --purge)      purge=1; shift ;;
      -h|--help)    down_usage; return 0 ;;
      *) die "Unknown option for down: $1" "See the options: ./threecast down --help" ;;
    esac
  done
  name=$(target_name)
  valid_target_name "$name"

  if target_exists "$name"; then
    load_target "$name"
    [ -z "$provider" ] || [ "$provider" = "$PROVIDER" ] || die "'$name' is a $PROVIDER server, not $provider."
  elif [ -n "$provider" ]; then
    case "$provider" in hetzner|digitalocean) ;; *) die "--provider takes hetzner or digitalocean." ;; esac
    NAME=$name PROVIDER=$provider HOST=''
  else
    die "No server named '$name' is set up on this laptop." \
      "Saved servers are in $TC_HOME/targets" \
      "If an interrupted ./threecast up left resources behind, delete them by name:" \
      "  ./threecast down --provider hetzner --name $name    (or --provider digitalocean)"
  fi

  case "$PROVIDER" in
    hetzner)      need_cmd curl jq; hz_down "$NAME" ;;
    digitalocean) need_cmd curl jq; do_down "$NAME" ;;
    byo)          down_byo "$purge" ;;
    *) die "Unknown provider '$PROVIDER' in $(target_file "$name")." ;;
  esac
  down_forget "$name"
}

# down_saved_but_missing WHERE WHICH_TOKEN — a saved server that the provider does not list was
# deleted by hand, or the token belongs to another account, where it would go on billing.
# Only the user can tell, so forgetting it needs their yes.
down_saved_but_missing() {
  [ -n "${HOST:-}" ] || return 0
  warn "'$NAME' was saved with the address $HOST, but $1 has nothing for it."
  hint "If you deleted it yourself, that is expected. If it still shows in your provider's console,"
  hint "this token is from $2: run ./threecast down again with that one's token."
  confirm "Forget '$NAME' on this laptop?" || die "Kept '$NAME'. Nothing was deleted."
}

down_keep_target() { # NAME HOW_TO_FIX
  die "Some resources are still there, so threecast keeps '$1' saved for another try." "$2"
}

down_confirm_name() {
  local answer
  [ "$TC_YES" != 1 ] || return 0
  [ -t 0 ] || die "Deleting needs a confirmation." "Run this in a terminal, or add --yes to skip the question."
  printf "Type the name '%s' to confirm: " "$1"
  read -r answer || answer=''
  [ "$answer" = "$1" ] || die "Nothing was deleted (you typed '$answer', not '$1')."
}

down_forget() {
  if [ -n "${HOST:-}" ]; then
    tunnel_down
    ssh-keygen -R "$HOST" -f "$TC_HOME/known_hosts" >/dev/null 2>&1 || true
  fi
  rm -f "$(target_file "$1")"
  if [ -f "$TC_HOME/current" ] && [ "$(cat "$TC_HOME/current")" = "$1" ]; then rm -f "$TC_HOME/current"; fi
  ok "Forgot '$1' on this laptop."
}

down_byo() {
  local purge=$1 stopped=0
  say "'$NAME' is your own server ($SSH_USER@$HOST). threecast deletes nothing on it unless you add --purge."
  if confirm "Stop the node on $HOST now (its containers and the weekly auto-upgrade job)?"; then
    if down_byo_stop; then stopped=1; else warn "Could not stop the node over SSH; it may still be running on $HOST."; fi
  fi
  [ "$purge" = 1 ] || return 0

  local re='^/[A-Za-z0-9._-]+/[A-Za-z0-9._/-]*[A-Za-z0-9._-]$'
  [[ $DATA_DIR =~ $re ]] && [[ $DATA_DIR != *..* ]] || die "Refusing to delete '$DATA_DIR': --purge only deletes a directory at least two levels deep." \
    "Delete it yourself: ./threecast ssh"
  say "--purge also deletes $DATA_DIR on $HOST: the Snapchain database (about 556 GiB) and its settings."
  say "This cannot be undone."
  down_confirm_name "$NAME"
  [ "$stopped" = 1 ] || down_byo_stop || die "Could not stop the node, so $DATA_DIR was left alone."
  step "Deleting $DATA_DIR on ${HOST}…"
  ssh_node ${SUDO:+"$SUDO"} rm -rf -- "$DATA_DIR" || die "Could not delete $DATA_DIR on $HOST." \
    "'$NAME' stays saved; run ./threecast down --purge again, or delete it over ./threecast ssh"
  ok "Deleted $DATA_DIR on $HOST."
}

down_byo_stop() {
  step "Stopping the node on $HOST (systemd unit, Docker containers, auto-upgrade cron job)…"
  down_byo_stop_script | ssh_node sh -s "$DATA_DIR" "${SUDO:-}" || return 1
  ok "The node on $HOST is stopped."
}

# Runs on the server under plain sh. $1 is the data directory, $2 is "sudo" or empty.
# snapchain.sh's weekly autoupgrade would start the node again, so its cron line goes too.
down_byo_stop_script() {
  cat <<'EOF'
dir=$1
run=${2:-}
$run systemctl stop threecast-node 2>/dev/null || true
if $run test -f "$dir/docker-compose.yml"; then
  $run sh -c 'cd "$1" && if docker compose version >/dev/null 2>&1; then docker compose down; else docker-compose down; fi' sh "$dir"
fi
if command -v crontab >/dev/null 2>&1; then
  $run sh -c 'crontab -l 2>/dev/null | grep -v "snapchain.sh autoupgrade" | crontab -'
fi
EOF
}
