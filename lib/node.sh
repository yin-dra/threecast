# threecast — MIT License
# shellcheck shell=bash
# Step 1 from the laptop: start the read node on the server, then follow it.
# cmd_node and cmd_status. Sourced by ./threecast; bash 3.2 compatible.

NODE_UNIT=threecast-node
NODE_REMOTE_DIR=/root/threecast
NODE_POLL=15
NODE_LINE=

node_usage() {
  cat <<'EOF'
Usage: ./threecast node [--name N] [--detach]

Step 1 of 3. On your server: restore the public Snapchain snapshot, install the
official read node with snapchain.sh, and wait until it is in sync with the
network. It runs there as the systemd unit threecast-node, so you can close
this terminal at any time. Running it again re-attaches, or resumes.

  --detach                          start or resume it, print one status line
                                    and return without watching (for scripts
                                    and coding agents; then: status --json)
  OPERATOR_FID=N ./threecast node   use your FID to pick the official weekly
                                    auto-upgrade day (default: a random day)
EOF
}

status_usage() {
  cat <<'EOF'
Usage: ./threecast status [--name N] [--json]

One look at your server: what node.sh is doing, how far behind the network the
node is, disk use, the snapchain version, and what the server has cost so far.

  --json   one JSON object on stdout and nothing else, for scripts and coding
           agents. Exit code: 0 in sync, 3 still working (preflight, restore,
           install, catchup), 1 error, not started, unreachable or no server.
EOF
}

node_prepare() {
  need_cmd ssh scp jq
  load_target
  DATA_DIR=${DATA_DIR:-/root/snapchain}
  case $DATA_DIR in
    /*) ;;
    *) die "DATA_DIR must be an absolute path, got '$DATA_DIR'." "Change it in $(target_file)." ;;
  esac
  case $DATA_DIR in
    *[!A-Za-z0-9._/-]*) die "DATA_DIR may only use letters, digits and . _ / -, got '$DATA_DIR'." "Change it in $(target_file)." ;;
  esac
  case ${OPERATOR_FID:-} in
    *[!0-9]*) die "OPERATOR_FID must be your numeric Farcaster ID, got '$OPERATOR_FID'." "Or unset it: threecast then picks the auto-upgrade day." ;;
  esac
  if [ -z "${SUDO+set}" ]; then
    if [ "${SSH_USER:-root}" = root ]; then SUDO=; else SUDO='sudo -n'; fi
  fi
}

# Runs on the server: one key=value line each for the unit state, disk use,
# node.sh's status.json and a live sync check. Arguments: DATA_DIR UNIT
# REMOTE_DIR [sudo prefix...].
node_state_script() {
  cat <<'EOF'
d=$1 unit=$2 dir=$3
shift 3
echo "unit=$(systemctl is-active "$unit" 2>/dev/null)"
echo "disk=$("$@" df -Ph "$d" 2>/dev/null | awk 'NR == 2 { print $3, $2, $5 }')"
echo "disk_kb=$("$@" df -Pk "$d" 2>/dev/null | awk 'NR == 2 { print $3, $2 }')"
echo "status=$("$@" cat "$d/.threecast/status.json" 2>/dev/null | tr -d '\n')"
echo "live=$("$@" "$dir/synced.sh" 2>/dev/null)"
EOF
}

node_fetch_state() {
  NODE_STATE=$(node_state_script | ssh_node "sh -s $DATA_DIR $NODE_UNIT $NODE_REMOTE_DIR ${SUDO:-}")
}

# node_fetch_state for a single look. ssh's own error still reaches stderr, and
# node_unreachable reads it to say why the look failed.
node_fetch_once() {
  local err=$TC_HOME/run/$NAME.ssh.err rc=0
  node_fetch_state 2>"$err" || rc=$?
  NODE_SSH_ERR=$(cat "$err" 2>/dev/null || true)
  rm -f "$err"
  [ -z "$NODE_SSH_ERR" ] || printf '%s\n' "$NODE_SSH_ERR" >&2
  return "$rc"
}

# Sets NODE_WHY and NODE_FIX after node_fetch_once failed. A refused key or a
# changed host key is not a server that is down: waiting will not fix those.
node_unreachable() {
  case ${NODE_SSH_ERR:-} in
    *"Permission denied"*)
      NODE_WHY="$HOST refused the SSH login as ${SSH_USER:-root} (Permission denied)."
      NODE_FIX="The key threecast uses is not authorized there. ./threecast ssh shows the same error." ;;
    *"Host key verification failed"*)
      NODE_WHY="The SSH host key of $HOST is not the one threecast saw there before."
      NODE_FIX="If the server was rebuilt, remove the old key: ssh-keygen -R $HOST -f $TC_HOME/known_hosts" ;;
    *)
      NODE_WHY="Cannot reach $HOST over SSH."
      NODE_FIX="Is the server running? Try ./threecast ssh, or your provider's console." ;;
  esac
}

node_field() { printf '%s\n' "$NODE_STATE" | sed -n "s/^$1=//p"; }

node_phase() { printf '%s' "$1" | jq -r '.phase // empty' 2>/dev/null || true; }

node_live_synced() { node_field live | jq -e '.synced == true' >/dev/null 2>&1; }

# One line for a status.json (or a synced.sh summary given a phase).
node_render() {
  if [ -z "$1" ]; then
    printf 'starting  node.sh is starting on the server\n'
    return 0
  fi
  printf '%s' "$1" | jq -r '
    def pad: (. + "          ")[0:10];
    def two: tostring | if length < 2 then "0" + . else . end;
    def dur: floor
      | if . >= 86400 then "\(. / 86400 | floor)d\(. % 86400 / 3600 | floor)h"
        elif . >= 3600 then "\(. / 3600 | floor)h\(. % 3600 / 60 | floor | two)m"
        elif . >= 60 then "\(. / 60 | floor)m\(. % 60 | two)s"
        else "\(.)s" end;
    if .phase == "restore" and .shard != null then
      ("restore" | pad) + "shard \(.shard) (\(.shard + 1) of 3)  chunk \(.done)/\(.total)"
      + (if .done > 0 then "  \(.mbps) MB/s  ~\(.eta_s | dur) left" else "" end)
    elif .phase == "catchup" and ((.shards // []) | length) > 0 then
      ("catch-up" | pad) + ([.shards[] | "shard \(.id) \(.blockDelay | dur)"] | join(" · ")) + " behind"
    elif .phase == "catchup" then
      ("catch-up" | pad) + "waiting for the node to answer (it opens its database first)"
    elif .phase == "synced" then
      ("synced" | pad) + "all 3 shards within 10 s of the network"
    else
      (.phase | pad) + (.message // "")
    end'
}

# On a terminal the progress line rewrites itself; otherwise each change is a new line.
node_show() {
  if [ -t 1 ]; then
    printf '\r\033[K%s' "$1"
  elif [ "$1" != "$NODE_LINE" ]; then
    printf '%s\n' "$1"
  fi
  NODE_LINE=$1
}

node_end_line() {
  if [ -t 1 ] && [ -n "$NODE_LINE" ]; then printf '\n'; fi
  NODE_LINE=
}

node_running() { case $1 in active|activating|reloading) return 0 ;; *) return 1 ;; esac; }

node_rank() {
  case $1 in
    preflight) echo 1 ;; restore) echo 2 ;; install) echo 3 ;; catchup) echo 4 ;; synced) echo 5 ;;
    *) echo 0 ;;
  esac
}

node_announce() {  # previous-phase phase
  if [ -z "$1" ] || [ "$1" = "$2" ]; then return 0; fi
  node_end_line
  if [ "$(node_rank "$2")" -gt "$(node_rank "$1")" ]; then
    case $1 in
      preflight) ok "Server checks passed: volume, memory, tools, free space." ;;
      restore) ok "Snapshot restored into $DATA_DIR/.rocks." ;;
      install) ok "Official node installed; its Docker container is starting." ;;
    esac
  elif [ "$1" = catchup ] && [ "$2" = restore ]; then
    warn "Shard 0 came up nearly empty (snapchain #1044); reloading it from the snapshot."
  fi
}

node_explain() {
  say "  It runs on the server in three phases, about 10 hours in all (our first run: 10 h 10 min):"
  say "    restore   fetch the public snapshot (~500 GB), unpack it shard by shard   ~3 h"
  say "    install   the official snapchain.sh sets up Docker and starts the node    ~1 min"
  say "    catch-up  the node replays the blocks made since the snapshot was taken   up to ~7 h"
  hint "threecast answers the installer's two questions for you: a read node earns no"
  if [ -n "${OPERATOR_FID:-}" ]; then
    hint "rewards (AGREE_NO_REWARDS_FOR_ME=true), and FID $OPERATOR_FID picks the weekly auto-upgrade day."
  else
    hint "rewards (AGREE_NO_REWARDS_FOR_ME=true), and the weekly auto-upgrade day is random."
  fi
}

node_watch_hint() {
  hint "Ctrl-C only stops this view; the node keeps going on the server."
  hint "Check on it with ./threecast status, or watch again with ./threecast node."
}

node_detached() {  # status-json
  say "$(node_render "$1")"
  hint "Not watching it (--detach). Check on it with ./threecast status --json,"
  hint "or watch it with ./threecast node."
}

node_upload_scripts() {
  local src=$TC_ROOT/node
  if [ -z "$SUDO" ]; then
    ssh_node "mkdir -p $NODE_REMOTE_DIR" </dev/null || return 1
    scp_node "$src/node.sh" "$src/restore.sh" "$src/synced.sh" "$NODE_REMOTE_DIR/" || return 1
    ssh_node "chmod 755 $NODE_REMOTE_DIR/node.sh $NODE_REMOTE_DIR/restore.sh $NODE_REMOTE_DIR/synced.sh" </dev/null
  else
    ssh_node "mkdir -p threecast-node" </dev/null || return 1
    scp_node "$src/node.sh" "$src/restore.sh" "$src/synced.sh" threecast-node/ || return 1
    ssh_node "$SUDO mkdir -p $NODE_REMOTE_DIR && $SUDO install -m 755 threecast-node/node.sh threecast-node/restore.sh threecast-node/synced.sh $NODE_REMOTE_DIR/" </dev/null
  fi
}

node_copy_scripts() {
  step "Copying node.sh, restore.sh and synced.sh to $HOST:${NODE_REMOTE_DIR}…"
  if ! node_upload_scripts; then
    [ -z "$SUDO" ] || die "Could not install the node scripts into $NODE_REMOTE_DIR on $HOST." \
      "Your login user ($SSH_USER) needs passwordless sudo there, or register the server as root."
    die "Could not copy the node scripts to $HOST." "Check that ./threecast ssh works, then run ./threecast node again."
  fi
  ok "Copied."
}

node_start() {
  local setenv="--setenv=DATA_DIR=$DATA_DIR"
  [ -z "${OPERATOR_FID:-}" ] || setenv="$setenv --setenv=OPERATOR_FID=$OPERATOR_FID"
  step "Starting node.sh as the systemd unit $NODE_UNIT, so it outlives this SSH session…"
  # A status.json from an earlier run must not be mistaken for this run's.
  ssh_node "$SUDO rm -f $DATA_DIR/.threecast/status.json && $SUDO systemd-run --quiet --collect --unit $NODE_UNIT $setenv $NODE_REMOTE_DIR/node.sh" </dev/null ||
    die "Could not start $NODE_UNIT on $HOST." "Look around with ./threecast ssh, then run ./threecast node again."
  ok "Started. It keeps running when you close this terminal or your laptop."
}

node_log_tail() {
  ssh_node "$SUDO tail -n 30 $DATA_DIR/.threecast/node.log 2>/dev/null || $SUDO journalctl -u $NODE_UNIT -n 30 --no-pager" </dev/null |
    sed 's/^/  | /' || true
}

node_failed() {  # status-json
  local message
  message=$(printf '%s' "$1" | jq -r '.message // "no message"')
  say "Last 30 lines of $DATA_DIR/.threecast/node.log on the server:"
  node_log_tail
  die "node.sh stopped on the server: $message" \
    "Fix the cause above, then run ./threecast node again. Restored shards are kept."
}

node_stopped() {  # last-phase
  say "Last 30 lines of $DATA_DIR/.threecast/node.log on the server:"
  node_log_tail
  die "node.sh is no longer running on the server (it stopped during ${1:-start-up})." \
    "That happens after a reboot, or when the process is killed." \
    "Run ./threecast node again: it resumes where it stopped."
}

node_synced() {  # status or synced.sh summary
  local version
  version=$(printf '%s' "$1" | jq -r '.version // "unknown"')
  ok "Your read node is in sync: shards 0, 1 and 2 are within 10 s of the network (snapchain $version)."
  hint "It serves the Farcaster HTTP API on the server at 127.0.0.1:3381; the client reaches it over an SSH tunnel."
  say ""
  node_next_client
}

node_next_client() {
  say "Next: ./threecast client   (step 2 of 3)"
  hint "With no app key on this laptop yet, it asks for a TEST account's recovery phrase."
  hint "Type that yourself, in your own terminal: never into a chat or a coding agent."
}

node_stop_watching() {
  node_end_line
  say "Stopped watching. The node keeps working on the server."
  hint "./threecast status for a quick look, ./threecast node to watch again."
  exit 130
}

node_follow() {
  local unit status phase prev="" lost=0
  NODE_LINE=
  trap node_stop_watching INT
  while :; do
    if ! node_fetch_state; then
      if [ "$lost" = 0 ]; then
        node_end_line
        warn "Lost the connection to $HOST; retrying every ${NODE_POLL}s. The node itself is not affected."
      fi
      lost=1
      sleep "$NODE_POLL"
      continue
    fi
    lost=0
    unit=$(node_field unit)
    status=$(node_field status)
    phase=$(node_phase "$status")
    node_announce "$prev" "$phase"
    case $phase in
      synced) trap - INT; node_end_line; node_synced "$status"; return 0 ;;
      error) trap - INT; node_end_line; node_failed "$status" ;;
    esac
    if ! node_running "$unit"; then
      trap - INT
      node_end_line
      node_stopped "$phase"
    fi
    node_show "$(node_render "$status")"
    prev=$phase
    sleep "$NODE_POLL"
  done
}

cmd_node() {
  local detach=0 a
  for a in "$@"; do
    case $a in
      -h|--help) node_usage; return 0 ;;
      --detach) detach=1 ;;
      *) die "Unknown argument for node: $a" "Usage: ./threecast node [--name N] [--detach]" ;;
    esac
  done
  node_prepare
  step "Setting up your Snapchain read node on $HOST (step 1 of 3)…"
  node_fetch_once || { node_unreachable; die "$NODE_WHY" "$NODE_FIX"; }
  if node_running "$(node_field unit)"; then
    if [ "$detach" = 1 ]; then
      ok "node.sh is already running on the server."
      node_detached "$(node_field status)"
      return 0
    fi
    ok "node.sh is already running on the server; showing its progress."
  elif node_live_synced; then
    node_synced "$(node_field live)"
    return 0
  else
    node_explain
    node_copy_scripts
    node_start
    # node_start cleared status.json, so there is nothing newer to show yet.
    if [ "$detach" = 1 ]; then node_detached ""; return 0; fi
  fi
  node_watch_hint
  node_follow
}

node_epoch() {  # CREATED_AT, as unix seconds or ISO 8601 UTC -> unix seconds
  case $1 in
    *[!0-9]*) date -u -d "$1" +%s 2>/dev/null || date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$1" +%s 2>/dev/null ;;
    *) printf '%s\n' "$1" ;;
  esac
}

node_duration() {  # seconds
  local s=$1
  if [ "$s" -ge 86400 ]; then
    printf '%dd%dh' $((s / 86400)) $((s % 86400 / 3600))
  elif [ "$s" -ge 3600 ]; then
    printf '%dh%02dm' $((s / 3600)) $((s % 3600 / 60))
  else
    printf '%dm' $((s / 60))
  fi
}

# Seconds since the rented server was created; fails for your own server.
node_up_secs() {
  local created secs
  if [ "${PROVIDER:-byo}" = byo ] || [ -z "${CREATED_AT:-}" ]; then return 1; fi
  created=$(node_epoch "$CREATED_AT") || return 1
  secs=$(($(date +%s) - created))
  [ "$secs" -ge 0 ] || return 1
  printf '%s\n' "$secs"
}

# "up 7h12m, about 1.38 EUR so far at 0.19 EUR/h", or nothing for your own server.
node_billing() {
  local secs
  secs=$(node_up_secs) || return 0
  printf 'up %s' "$(node_duration "$secs")"
  if [ -n "${PRICE_HOURLY:-}" ]; then
    LC_ALL=C awk -v h="$PRICE_HOURLY" -v s="$secs" -v c="${PRICE_CURRENCY:-EUR}" \
      'BEGIN { printf ", about %.2f %s so far at %s %s/h", h * s / 3600, c, h, c }'
  fi
}

# The --json object. Arguments: phase error-message. Reads the loaded target
# and, when the server answered, status_json's status, live and disk_kb.
# Everything from the server goes in through --arg and is parsed by jq itself.
status_json_print() {
  local hourly="" so_far="" secs
  if [ -n "${PRICE_HOURLY:-}" ] && secs=$(node_up_secs); then
    hourly=$PRICE_HOURLY
    so_far=$(LC_ALL=C awk -v h="$PRICE_HOURLY" -v s="$secs" 'BEGIN { printf "%.2f", h * s / 3600 }')
  fi
  jq -nc --arg name "${NAME:-$(target_name)}" --arg provider "${PROVIDER:-}" --arg host "${HOST:-}" \
    --arg phase "$1" --arg error "$2" --arg status "${status:-}" --arg live "${live:-}" \
    --arg disk "${disk_kb:-}" --arg currency "${PRICE_CURRENCY:-EUR}" --arg hourly "$hourly" \
    --arg so_far "$so_far" --arg log "${DATA_DIR:-/root/snapchain}/.threecast/node.log" '
    def object: try fromjson catch null | if type == "object" then . else null end;
    def text: if . == "" then null else . end;
    def gib: tonumber / 104857.6 + 0.5 | floor / 10;
    ($status | object) as $s | ($live | object) as $l
    | {
        name: $name,
        provider: ($provider | text),
        host: ($host | text),
        phase: $phase,
        synced: ($phase == "synced"),
        restore: (if $s.phase == "restore" and $s.shard != null
          then $s | {shard, done, total, mbps, eta_s} else null end),
        shards: (if ($l.shards | type) == "array"
          then [$l.shards[] | objects | {id, height: .maxHeight, delay_s: .blockDelay, messages: .numMessages}]
          else null end),
        disk: ($disk | [scan("[0-9]+")]
          | if length == 2 then {used_gb: (.[0] | gib), total_gb: (.[1] | gib)} else null end),
        version: ($l.version | strings // null),
        cost: (if $hourly == "" then null
          else {currency: $currency, hourly: ($hourly | tonumber? // null), so_far: ($so_far | tonumber)} end),
        error: (($error | text) // (if $phase == "error" then $s.message // "node.sh stopped on the server" else null end)),
        log: (if $s == null then null else $s.log // $log end)
      }'
}

status_json() {
  local err unit status="" live="" disk_kb="" sphase version phase message=""
  command -v jq >/dev/null 2>&1 || need_cmd jq
  # node_prepare dies when there is no target or a setting is wrong. Run it in
  # a subshell first, so that its message goes into the JSON instead.
  if ! err=$(node_prepare 2>&1 >/dev/null); then
    if target_exists; then load_target; fi
    err=${err#✗ }
    status_json_print error "${err//$'\n'  / }"
    return 1
  fi
  node_prepare
  step "Asking $HOST how your node is doing…" >&2
  if ! node_fetch_once; then
    node_unreachable
    status_json_print unreachable "$NODE_WHY $NODE_FIX"
    return 1
  fi
  unit=$(node_field unit)
  status=$(node_field status)
  live=$(node_field live)
  disk_kb=$(node_field disk_kb)
  sphase=$(node_phase "$status")
  version=$(printf '%s' "$live" | jq -r '.version // empty' 2>/dev/null || true)
  # The live check is the truth once it says synced; otherwise status.json is
  # node.sh's last word, and a stopped node.sh needs someone to resume it.
  if node_live_synced; then
    phase=synced
  elif [ "$sphase" = error ]; then
    phase=error
  elif node_running "$unit"; then
    case $sphase in
      preflight|restore|install|catchup) phase=$sphase ;;
      synced) phase=catchup ;;
      *) phase=preflight ;;
    esac
  elif [ "$sphase" = synced ] && [ -n "$version" ]; then
    # node.sh is done; the node in Docker catches up by itself (after an upgrade, say).
    phase=catchup
  elif [ "$sphase" = synced ]; then
    phase=error
    message="The node is not answering on 127.0.0.1:3381 on the server. Start it again with ./threecast node --detach"
  elif [ -z "$sphase" ]; then
    phase=not-started
  else
    phase=error
    message="node.sh is no longer running on the server (it stopped during $sphase). Resume it with ./threecast node --detach"
  fi
  status_json_print "$phase" "$message"
  case $phase in
    synced) return 0 ;;
    preflight|restore|install|catchup) return 3 ;;
    *) return 1 ;;
  esac
}

cmd_status() {
  local unit status live phase disk used size pct billing version json=0 a
  for a in "$@"; do
    case $a in
      -h|--help) status_usage; return 0 ;;
      --json) json=1 ;;
      *) die "Unknown argument for status: $a" "Usage: ./threecast status [--name N] [--json]" ;;
    esac
  done
  if [ "$json" = 1 ]; then status_json; return; fi
  node_prepare
  step "Asking $HOST how your node is doing…"
  node_fetch_once || { node_unreachable; die "$NODE_WHY" "$NODE_FIX"; }
  unit=$(node_field unit)
  status=$(node_field status)
  live=$(node_field live)
  phase=$(node_phase "$status")
  disk=$(node_field disk)
  billing=$(node_billing)
  version=$(printf '%s' "$live" | jq -r '.version // empty' 2>/dev/null || true)

  say "  server     $NAME · ${PROVIDER:-byo} · $HOST"
  [ -z "$billing" ] || say "  billing    $billing"
  if [ "$unit" = active ]; then
    say "  node.sh    running (systemd unit $NODE_UNIT)"
  elif [ "$phase" = synced ]; then
    say "  node.sh    finished; the node itself keeps running in Docker"
  else
    say "  node.sh    not running"
  fi
  # Once installed, the live check is the truth; status.json is node.sh's last word.
  if [ -n "$version" ] && { [ "$phase" = catchup ] || [ "$phase" = synced ]; }; then
    say "  progress   $(node_render "$(printf '%s' "$live" | jq -c '{phase: (if .synced then "synced" else "catchup" end)} + .')")"
  elif [ -z "$status" ]; then
    say "  progress   not started yet"
  else
    say "  progress   $(node_render "$status")"
  fi
  if [ -n "$disk" ]; then
    read -r used size pct <<<"$disk"
    say "  disk       $used of $size used ($pct) on $DATA_DIR"
  fi
  if [ -n "$version" ]; then
    say "  snapchain  $version, answering on 127.0.0.1:3381"
  else
    case $phase in
      ''|preflight|restore) say "  snapchain  not installed yet; snapchain.sh installs it once the snapshot is restored" ;;
      *) say "  snapchain  not answering on 127.0.0.1:3381" ;;
    esac
  fi
  [ -z "$billing" ] || hint "Billing runs until the server is deleted: ./threecast down"
  say ""
  if node_live_synced; then
    node_next_client
  elif [ "$phase" = error ]; then
    say "node.sh stopped: $(printf '%s' "$status" | jq -r '.message // ""')"
    say "Fix that, then resume with ./threecast node (./threecast ssh to look around)."
  elif [ "$unit" = active ]; then
    say "Watch it live: ./threecast node"
  elif [ -z "$phase" ]; then
    say "The node has not been started yet: ./threecast node"
  else
    say "node.sh stopped during $phase. Resume it with ./threecast node"
  fi
}
