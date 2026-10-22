#!/usr/bin/env bash
# threecast — MIT License
# Step 1, on the server, as root: restore the snapshot, install the official
# Snapchain read node, wait until it is in sync. `./threecast node` starts it
# as the systemd unit threecast-node, so a closed laptop never stops it.
# Re-running is safe: finished work is skipped.
#
# Environment: DATA_DIR (default /root/snapchain), OPERATOR_FID (optional,
# only used by the official script to pick the weekly auto-upgrade day).
#
# Progress goes to $DATA_DIR/.threecast/status.json, one JSON object with a
# "phase": preflight, restore, install, catchup, synced, or error.
set -euo pipefail

DATA_DIR=${DATA_DIR:-/root/snapchain}
OPERATOR_FID=${OPERATOR_FID:-}
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
STATE=$DATA_DIR/.threecast
LOG=$STATE/node.log
NODE_URL=http://127.0.0.1:3381
INSTALLER_URL=https://raw.githubusercontent.com/farcasterxyz/snapchain/@latest/scripts/snapchain.sh
INSTALL_TIMEOUT=1800
SILENCE_LIMIT=1800
SYNC_POLL=30
PHASE=preflight

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

json_string() {
  local s=${1//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\t'/\\t}
  s=${s//$'\r'/}
  printf '"%s"' "$s"
}

# Plain printf rather than jq: jq may not be installed yet during preflight.
set_status() {  # phase message
  PHASE=$1
  printf '{"phase":"%s","message":%s,"log":%s,"updated":%s}\n' \
    "$1" "$(json_string "$2")" "$(json_string "$LOG")" "$(date +%s)" > "$STATE/status.json.tmp"
  mv "$STATE/status.json.tmp" "$STATE/status.json"
  log "$1: $2"
}

set_sync_status() {  # phase synced.sh-summary
  PHASE=$1
  jq -c --arg phase "$1" --arg log "$LOG" '{phase: $phase} + . + {log: $log, updated: (now | floor)}' \
    <<<"$2" > "$STATE/status.json.tmp"
  mv "$STATE/status.json.tmp" "$STATE/status.json"
}

fail() {
  set_status error "$1"
  exit 1
}

on_exit() {
  local code=$?
  if [ "$code" -ne 0 ] && [ "$PHASE" != error ]; then
    set_status error "node.sh stopped during $PHASE (exit $code). Run ./threecast node to resume."
  fi
}

all_restored() {
  [ -f "$STATE/shard-0.done" ] && [ -f "$STATE/shard-1.done" ] && [ -f "$STATE/shard-2.done" ]
}

node_answers() { curl -fsS -m 5 "$NODE_URL/v1/info" >/dev/null 2>&1; }

compose() {
  if command -v docker-compose >/dev/null 2>&1; then
    (cd "$DATA_DIR" && docker-compose "$@")
  else
    (cd "$DATA_DIR" && docker compose "$@")
  fi
}

env_get() { sed -n "s/^$1=//p" "$DATA_DIR/.env" 2>/dev/null | tail -n 1; }

env_set() {  # key value: replaces every earlier line for key
  local env=$DATA_DIR/.env
  touch "$env"
  [ "$(grep -c "^$1=" "$env")" = 1 ] && grep -qxF "$1=$2" "$env" && return 0
  { grep -v "^$1=" "$env" || true; printf '%s=%s\n' "$1" "$2"; } > "$env.tmp"
  mv "$env.tmp" "$env"
}

check_volume() {
  # Only a mount point listed in fstab must be mounted: a server you brought
  # yourself may keep DATA_DIR on its root disk.
  if awk -v d="$DATA_DIR" '$1 !~ /^#/ && $2 == d { found = 1 } END { exit !found }' /etc/fstab 2>/dev/null &&
    ! mountpoint -q "$DATA_DIR"; then
    fail "The data volume is not mounted at $DATA_DIR. Mount it (mount $DATA_DIR), check it with lsblk, then run ./threecast node again."
  fi
}

check_memory() {
  local kib gib
  kib=$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo)
  gib=$(((kib + 524288) / 1048576))
  [ "$kib" -ge $((7 * 1048576)) ] || fail "Snapchain needs 16 GB of memory; this server has about $gib GB."
  [ "$kib" -ge $((14 * 1048576)) ] || log "warning: about $gib GB of memory; Snapchain asks for 16 GB. Continuing."
}

install_tools() {
  local missing=""
  command -v curl >/dev/null 2>&1 || missing="$missing curl"
  command -v jq >/dev/null 2>&1 || missing="$missing jq"
  command -v crontab >/dev/null 2>&1 || missing="$missing cron"
  [ -n "$missing" ] || return 0
  command -v apt-get >/dev/null 2>&1 || fail "Missing tools:$missing. Install them, then run ./threecast node again."
  log "installing$missing"
  apt-get -o DPkg::Lock::Timeout=600 update -q || fail "apt-get update failed (details in $LOG)."
  # shellcheck disable=SC2086 # one package name per word
  apt-get -o DPkg::Lock::Timeout=600 install -y -q $missing || fail "apt-get could not install$missing (details in $LOG)."
}

# A node installed before threecast, say by the official script on a server
# you brought, has its own database: keep it rather than download it again.
# A broken shard 0 in it is caught later, in wait_for_sync.
adopt_existing_db() {
  local s
  for s in 0 1 2; do
    [ ! -f "$STATE/shard-$s.done" ] || return 0
    [ -d "$DATA_DIR/.rocks/shard-$s" ] || return 0
  done
  node_answers || return 0
  log "a Snapchain node already runs here with its own database in $DATA_DIR/.rocks; keeping it instead of restoring the snapshot"
  for s in 0 1 2; do echo adopted > "$STATE/shard-$s.done"; done
}

preflight() {
  set_status preflight "checking the data volume, memory, tools and free space"
  [ "$(id -u)" = 0 ] || fail "node.sh must run as root."
  case $OPERATOR_FID in *[!0-9]*) fail "OPERATOR_FID must be a number, got '$OPERATOR_FID'." ;; esac
  check_volume
  check_memory
  install_tools
  adopt_existing_db
  if ! all_restored; then run_restore --check; fi
}

# restore.sh explains a failure on its last line; that line becomes the status.
run_restore() {
  "$HERE/restore.sh" "$@" "$DATA_DIR" && return 0
  fail "$(tail -n 1 "$LOG" | sed 's/^[^ ]* restore: //')"
}

restore_snapshot() {
  if all_restored; then
    log "snapshot already restored"
    return 0
  fi
  # A node can be running here already: on the shard 0 reload below, or on a
  # re-run after a .done marker was removed. Never unpack under a live node.
  if [ -f "$DATA_DIR/docker-compose.yml" ] && command -v docker >/dev/null 2>&1; then
    compose stop snapchain || true
  fi
  set_status restore "downloading the snapshot"
  run_restore
}

# snapchain.sh asks two questions on a terminal and fails without one. This
# answers both in .env first: no rewards for a read node, and the operator FID.
# With FID 0 it would exit before starting the node unless SKIP_CRONTAB is set
# (snapchain #1030), so threecast then writes the weekly upgrade job itself.
seed_env() {
  local fid
  env_set AGREE_NO_REWARDS_FOR_ME true
  fid=${OPERATOR_FID:-$(env_get HUB_OPERATOR_FID)}
  if [ -n "$fid" ] && [ "$fid" != 0 ]; then
    env_set HUB_OPERATOR_FID "$fid"
  else
    env_set HUB_OPERATOR_FID 0
    env_set SKIP_CRONTAB true
    install_upgrade_cron
  fi
}

# The line snapchain.sh would write: weekly, Monday to Friday, at an hour 00-06.
install_upgrade_cron() {
  local current
  current=$(crontab -l 2>/dev/null || true)
  if grep -q 'snapchain.sh autoupgrade' <<<"$current"; then return 0; fi
  {
    [ -z "$current" ] || printf '%s\n' "$current"
    printf '0 %d * * %d %s/snapchain.sh autoupgrade >> %s/snapchain-autoupgrade.log 2>&1\n' \
      $((RANDOM % 7)) $((RANDOM % 5 + 1)) "$DATA_DIR" "$DATA_DIR"
  } | crontab -
  log "installed the weekly auto-upgrade job: $(crontab -l | grep 'snapchain.sh autoupgrade')"
}

download_installer() {
  # The same cache-buster the official bootstrap uses.
  curl -fsSL --retry 3 -o "$DATA_DIR/snapchain.sh.tmp" "$INSTALLER_URL?t=$(date +%s)" ||
    fail "Could not download snapchain.sh from $INSTALLER_URL."
  chmod 755 "$DATA_DIR/snapchain.sh.tmp"
  mv "$DATA_DIR/snapchain.sh.tmp" "$DATA_DIR/snapchain.sh"
}

# `snapchain.sh upgrade` ends in `docker compose logs -f`, which never returns,
# so it runs in its own session and the whole session is stopped once it has
# printed its last line. Its self-upgrade prints "Upgrade complete. Restarting
# with new version...", hence the match on the line end.
run_installer() {
  local out=$STATE/upgrade.log pid waited=0
  (cd "$DATA_DIR" && exec setsid ./snapchain.sh upgrade) </dev/null >"$out" 2>&1 &
  pid=$!
  until grep -q 'Upgrade complete\.$' "$out"; do
    kill -0 "$pid" 2>/dev/null || break
    [ "$waited" -lt "$INSTALL_TIMEOUT" ] || break
    sleep 5
    waited=$((waited + 5))
  done
  kill -- -"$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  log "output of snapchain.sh upgrade:"
  cat "$out"
  grep -q 'Upgrade complete\.$' "$out" ||
    fail "The official snapchain.sh upgrade stopped before 'Upgrade complete.'; its output is at the end of $LOG."
}

install_node() {
  if [ -f "$STATE/install.done" ] && node_answers; then
    log "node already installed and answering on $NODE_URL"
    return 0
  fi
  set_status install "the official snapchain.sh is installing Docker and starting the node"
  seed_env
  download_installer
  run_installer
  touch "$STATE/install.done"
}

# A shard 0 with almost no messages was not restored and is replaying from
# genesis (snapchain #1044): every write would fail with "unknown fid".
reload_shard0() {  # messages-now
  log "shard 0 has only $1 messages: reloading it from the snapshot"
  compose stop snapchain || true
  rm -rf "$DATA_DIR/.rocks/shard-0" "$STATE/shard-0.done"
  restore_snapshot
  compose up -d snapchain || fail "Could not start the node again after reloading shard 0 (docker compose up)."
  set_status catchup "waiting for the node to answer on $NODE_URL"
}

wait_for_sync() {
  local summary messages reloaded=0 heard=$SECONDS polls=0
  set_status catchup "waiting for the node to answer on $NODE_URL"
  until summary=$("$HERE/synced.sh"); do
    if jq -e '.shards' >/dev/null <<<"$summary"; then
      heard=$SECONDS
      set_sync_status catchup "$summary"
      messages=$(jq '[.shards[] | select(.id == 0) | .numMessages][0] // empty' <<<"$summary")
      if [ -n "$messages" ] && [ "$messages" -le 1000000 ]; then
        [ "$reloaded" = 0 ] || fail "Shard 0 still has only $messages messages after reloading it from the snapshot."
        reload_shard0 "$messages"
        reloaded=1
        heard=$SECONDS
      fi
    elif [ $((SECONDS - heard)) -ge "$SILENCE_LIMIT" ]; then
      log "last lines of the node container:"
      compose logs --tail 30 snapchain 2>&1 || true
      fail "The node has not answered on $NODE_URL for $((SILENCE_LIMIT / 60)) minutes; its last log lines are in $LOG."
    fi
    # Every 10th poll is enough to follow the catch-up in the log.
    [ $((polls % 10)) != 0 ] || log "catch-up: $summary"
    polls=$((polls + 1))
    sleep "$SYNC_POLL"
  done
  set_sync_status synced "$summary"
  log "synced: $summary"
}

main() {
  mkdir -p "$STATE"
  exec >>"$LOG" 2>&1
  trap on_exit EXIT
  trap 'exit 143' TERM INT HUP
  # systemd sets no HOME for a root service; docker and snapchain.sh expect one.
  export HOME=${HOME:-/root} DEBIAN_FRONTEND=noninteractive
  log "node.sh starting: DATA_DIR=$DATA_DIR OPERATOR_FID=${OPERATOR_FID:-none}"
  preflight
  restore_snapshot
  install_node
  wait_for_sync
}

# Sourcing defines the functions without running anything (tests do this).
if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
