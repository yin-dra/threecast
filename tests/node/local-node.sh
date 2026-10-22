#!/usr/bin/env bash
# threecast — MIT License
# lib/node.sh (cmd_node, cmd_status) with ssh_node and scp_node replaced by
# fakes that replay scripted server states. Runs under macOS /bin/bash 3.2.
set -euo pipefail
# shellcheck source=tests/node/testlib.sh
. "$(dirname "$0")/testlib.sh"

WORK=$(mktemp -d "${TMPDIR:-/tmp}/threecast-local-node.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

export THREECAST_HOME=$WORK/home THREECAST_TARGET=test NO_COLOR=1
TC_ROOT=$REPO
# shellcheck source=lib/common.sh
. "$REPO/lib/common.sh"
# shellcheck source=lib/node.sh
. "$REPO/lib/node.sh"
tc_init_home
NODE_POLL=0

write_target() {  # extra KEY=value lines
  {
    printf '%s\n' NAME=test PROVIDER=hetzner HOST=203.0.113.7 SSH_USER=root DATA_DIR=/root/snapchain \
      "CREATED_AT=$(($(date +%s) - 7 * 3600 - 59))" PRICE_HOURLY=0.19 PRICE_CURRENCY=EUR
    for line in "$@"; do printf '%s\n' "$line"; done
  } > "$TC_HOME/targets/test.env"
}

# Server states, replayed one per state fetch: state UNIT STATUS-JSON [LIVE-JSON]
reset_states() { rm -rf "$WORK/states" "$WORK/ssh.log"; mkdir -p "$WORK/states"; echo 0 > "$WORK/next"; }
state() {
  local n
  n=$(find "$WORK/states" -type f | wc -l | tr -d ' ')
  printf 'unit=%s\ndisk=612G 984G 63%%\ndisk_kb=641728512 1031798784\nstatus=%s\nlive=%s\n' \
    "$1" "$2" "${3:-}" > "$WORK/states/$n"
}
# A state fetch that fails the way ssh does: exit 255, and ssh's own error.
state_unreachable() {  # [ssh's error]
  local n
  n=$(find "$WORK/states" -type f | wc -l | tr -d ' ')
  printf 'unreachable\n%s\n' "${1:-ssh: connect to host 203.0.113.7 port 22: Operation timed out}" > "$WORK/states/$n"
}

ssh_node() {
  printf 'ssh %s\n' "$*" >> "$WORK/ssh.log"
  case $* in
    "sh -s "*)
      local n
      cat > /dev/null
      n=$(cat "$WORK/next")
      [ -f "$WORK/states/$n" ] || n=$((n - 1))
      echo $((n + 1)) > "$WORK/next"
      if [ "$(head -n 1 "$WORK/states/$n")" = unreachable ]; then
        sed 1d "$WORK/states/$n" >&2
        return 255
      fi
      cat "$WORK/states/$n"
      ;;
    *"tail -n 30"*) printf '2026-10-21T01:00:00Z restore: Not enough free space in /root/snapchain\n' ;;
  esac
}
scp_node() { printf 'scp %s\n' "$*" >> "$WORK/ssh.log"; }

run() {  # command... ; output in $WORK/out, exit code in RC
  RC=0
  ("$@") > "$WORK/out" 2>&1 || RC=$?
}
run_json() {  # command... ; stdout in $WORK/json, stderr in $WORK/err, exit code in RC
  RC=0
  ("$@") > "$WORK/json" 2> "$WORK/err" || RC=$?
}
said() { grep -qF -- "$1" "$WORK/out"; }
not_said() { ! grep -qF -- "$1" "$WORK/out"; }
sent() { grep -qF -- "$1" "$WORK/ssh.log"; }
not_sent() { ! grep -qF -- "$1" "$WORK/ssh.log" 2>/dev/null; }
exits() { [ "$RC" = "$1" ]; }
fetches() { [ "$(grep -c '^ssh sh -s ' "$WORK/ssh.log")" = "$1" ]; }

# The status --json contract (DESIGN.md, CLI surface), checked on every answer.
# shellcheck disable=SC2016 # $p is a jq variable
SHAPE='
  def text_or_null: type == "string" or type == "null";
  def number: type == "number";
  def number_or_null: type == "number" or type == "null";
  .phase as $p
  | keys_unsorted == ["name", "provider", "host", "phase", "synced", "restore", "shards", "disk",
                      "version", "cost", "error", "log"]
  and (.name | type == "string")
  and (.provider | text_or_null) and (.host | text_or_null)
  and (["preflight", "restore", "install", "catchup", "synced", "error", "not-started", "unreachable"]
       | any(.[]; . == $p))
  and .synced == ($p == "synced")
  and (.restore == null or (.restore | keys_unsorted == ["shard", "done", "total", "mbps", "eta_s"]
       and (.shard | number) and (.done | number) and (.total | number)
       and (.mbps | number_or_null) and (.eta_s | number_or_null)))
  and (.shards == null or (.shards | type == "array"
       and all(.[]; keys_unsorted == ["id", "height", "delay_s", "messages"] and (.id | number))))
  and (.disk == null or (.disk | keys_unsorted == ["used_gb", "total_gb"]
       and (.used_gb | number) and (.total_gb | number)))
  and (.version | text_or_null)
  and (.cost == null or (.cost | keys_unsorted == ["currency", "hourly", "so_far"]
       and (.currency | type == "string") and (.hourly | number) and (.so_far | number)))
  and (.error | text_or_null) and (.log | text_or_null)'
# Exactly one JSON object, on one line, and nothing else on stdout.
json_ok() {
  [ "$(wc -l < "$WORK/json" | tr -d ' ')" = 1 ] &&
    jq -se 'length == 1' "$WORK/json" >/dev/null &&
    jq -e "$SHAPE" "$WORK/json" >/dev/null
}
json_is() { jq -e "$1" "$WORK/json" >/dev/null; }

RESTORE_0='{"phase":"restore","shard":0,"done":120,"total":372,"bytes":10000000000,"mbps":41.3,"eta_s":4320,"key":"k","updated":1}'
RESTORE_2='{"phase":"restore","shard":2,"done":2649,"total":2649,"bytes":1,"mbps":50,"eta_s":0,"key":"k","updated":1}'
CATCHUP='{"phase":"catchup","synced":false,"reason":"shard 1 is 11040 s behind the network","version":"0.14.3","shards":[{"id":0,"maxHeight":1,"blockDelay":2,"numMessages":12671345},{"id":1,"maxHeight":1,"blockDelay":11040,"numMessages":1},{"id":2,"maxHeight":1,"blockDelay":10260,"numMessages":1}]}'
SYNCED='{"phase":"synced","synced":true,"version":"0.14.3","shards":[]}'
LIVE_SYNCED='{"synced":true,"version":"0.14.3","shards":[]}'

write_target

reset_states
state inactive ''
state active ''
state active '{"phase":"preflight","message":"checking the data volume, memory, tools and free space"}'
state active "$RESTORE_0"
state active "$RESTORE_2"
state active '{"phase":"install","message":"the official snapchain.sh is installing Docker and starting the node"}'
state active '{"phase":"catchup","message":"waiting for the node to answer on http://127.0.0.1:3381"}'
state active "$CATCHUP"
state inactive "$SYNCED"
run cmd_node
check "fresh start: exits 0" exits 0
check "fresh start: explains the three phases up front" said "catch-up  the node replays the blocks made since the snapshot was taken"
check "fresh start: says Ctrl-C only stops watching" said "Ctrl-C only stops this view; the node keeps going on the server."
check "fresh start: copies the three scripts" \
  sent "scp $REPO/node/node.sh $REPO/node/restore.sh $REPO/node/synced.sh /root/threecast/"
check "fresh start: clears the old status, then starts the unit" \
  sent "rm -f /root/snapchain/.threecast/status.json &&  systemd-run --quiet --collect --unit threecast-node --setenv=DATA_DIR=/root/snapchain /root/threecast/node.sh"
check "fresh start: restore line" said "restore   shard 0 (1 of 3)  chunk 120/372  41.3 MB/s  ~1h12m left"
check "fresh start: restore done" said "✓ Snapshot restored into /root/snapchain/.rocks."
check "fresh start: install line" said "install   the official snapchain.sh is installing Docker and starting the node"
check "fresh start: waiting line" said "catch-up  waiting for the node to answer (it opens its database first)"
check "fresh start: catch-up line" said "catch-up  shard 0 2s · shard 1 3h04m · shard 2 2h51m behind"
check "fresh start: success" said "✓ Your read node is in sync: shards 0, 1 and 2 are within 10 s of the network (snapchain 0.14.3)."
check "fresh start: next command" said "Next: ./threecast client   (step 2 of 3)"
check "fresh start: the phrase is for the person to type" \
  said "Type that yourself, in your own terminal: never into a chat or a coding agent."

reset_states
state inactive ''
state active '{"phase":"preflight","message":"checking"}'
state inactive '{"phase":"error","message":"Not enough free space in /root/snapchain: need 620 GiB, 300 GiB free.","log":"/root/snapchain/.threecast/node.log"}'
run cmd_node
check "error: exits 1" exits 1
check "error: shows the message" said "✗ node.sh stopped on the server: Not enough free space in /root/snapchain: need 620 GiB, 300 GiB free."
check "error: shows the log tail" said "  | 2026-10-21T01:00:00Z restore: Not enough free space in /root/snapchain"
check "error: says what to do next" said "then run ./threecast node again"

reset_states
state active "$RESTORE_0"
state inactive "$SYNCED"
run cmd_node
check "re-attach: says it is already running" said "node.sh is already running on the server; showing its progress."
check "re-attach: does not copy or restart" not_sent "systemd-run"
check "re-attach: does not overwrite the running scripts" not_sent "scp "
check "re-attach: ends in sync" said "Next: ./threecast client"

reset_states
state inactive "$SYNCED" "$LIVE_SYNCED"
run cmd_node
check "already synced: exits 0 at once" exits 0
check "already synced: says so" said "✓ Your read node is in sync"
check "already synced: starts nothing" not_sent "systemd-run"

reset_states
state inactive ''
state active "$RESTORE_0"
state inactive "$RESTORE_0"
run cmd_node
check "stopped mid-way: exits 1" exits 1
check "stopped mid-way: names the phase" said "node.sh is no longer running on the server (it stopped during restore)."
check "stopped mid-way: says how to resume" said "Run ./threecast node again: it resumes where it stopped."

reset_states
state inactive ''
state inactive "$SYNCED"
OPERATOR_FID=12345 run cmd_node
check "OPERATOR_FID: passed to the unit" sent "--setenv=DATA_DIR=/root/snapchain --setenv=OPERATOR_FID=12345 /root/threecast/node.sh"
check "OPERATOR_FID: mentioned up front" said "FID 12345 picks the weekly auto-upgrade day"
OPERATOR_FID=12ab run cmd_node
check "OPERATOR_FID: rejects a non-number" said "OPERATOR_FID must be your numeric Farcaster ID, got '12ab'."

write_target SSH_USER=ubuntu
reset_states
state inactive ''
state inactive "$SYNCED"
run cmd_node
check "non-root: installs the scripts with sudo" \
  sent "sudo -n mkdir -p /root/threecast && sudo -n install -m 755 threecast-node/node.sh threecast-node/restore.sh threecast-node/synced.sh /root/threecast/"
check "non-root: starts the unit with sudo" sent "sudo -n systemd-run --quiet --collect --unit threecast-node"
check "non-root: reads the state with sudo" sent "sh -s /root/snapchain threecast-node /root/threecast sudo -n"
write_target "DATA_DIR='/root/my data'"
run cmd_node
check "DATA_DIR: rejects characters that would need quoting" said "DATA_DIR may only use letters, digits and . _ / -, got '/root/my data'."
write_target

reset_states
state inactive ''
state active "$RESTORE_0"
state inactive "$SYNCED"
run cmd_node --detach
check "--detach: exits 0" exits 0
check "--detach: copies the three scripts, like node" \
  sent "scp $REPO/node/node.sh $REPO/node/restore.sh $REPO/node/synced.sh /root/threecast/"
check "--detach: starts the unit, like node" \
  sent "rm -f /root/snapchain/.threecast/status.json &&  systemd-run --quiet --collect --unit threecast-node --setenv=DATA_DIR=/root/snapchain /root/threecast/node.sh"
check "--detach: one status line" said "starting  node.sh is starting on the server"
check "--detach: says how to check on it" said "Not watching it (--detach). Check on it with ./threecast status --json,"
check "--detach: asked the server once and did not follow" fetches 1
check "--detach: no progress lines from following" not_said "restore   shard 0"
check "--detach: no Ctrl-C hint" not_said "Ctrl-C"

reset_states
state active "$RESTORE_0"
state inactive "$SYNCED"
run cmd_node --detach
check "--detach, already running: exits 0" exits 0
check "--detach, already running: says so" said "✓ node.sh is already running on the server."
check "--detach, already running: its status line" said "restore   shard 0 (1 of 3)  chunk 120/372  41.3 MB/s  ~1h12m left"
check "--detach, already running: does not copy or restart" not_sent "systemd-run"
check "--detach, already running: does not overwrite the running scripts" not_sent "scp "
check "--detach, already running: did not follow" fetches 1

reset_states
state inactive "$SYNCED" "$LIVE_SYNCED"
run cmd_node --detach
check "--detach, already synced: exits 0" exits 0
check "--detach, already synced: says so" said "✓ Your read node is in sync"
check "--detach, already synced: starts nothing" not_sent "systemd-run"

reset_states
state inactive "$SYNCED" "$LIVE_SYNCED"
run cmd_node --detach
check "--detach, already synced: the phrase is for the person to type" \
  said "Type that yourself, in your own terminal: never into a chat or a coding agent."

reset_states
state_unreachable
run cmd_node --detach
check "--detach, unreachable: exits 1" exits 1
check "--detach, unreachable: shows ssh's error" said "ssh: connect to host 203.0.113.7 port 22: Operation timed out"
check "--detach, unreachable: says so" said "✗ Cannot reach 203.0.113.7 over SSH."
check "--detach, unreachable: starts nothing" not_sent "systemd-run"

reset_states
state_unreachable "root@203.0.113.7: Permission denied (publickey)."
run cmd_node --detach
check "--detach, key refused: exits 1" exits 1
check "--detach, key refused: says it is the key, not the server" \
  said "✗ 203.0.113.7 refused the SSH login as root (Permission denied)."
check "--detach, key refused: no talk of the server being down" not_said "Is the server running?"

run cmd_node --follow
check "node: rejects an unknown flag" said "✗ Unknown argument for node: --follow"
check "node: unknown flag exits 1" exits 1

# A fresh CREATED_AT, so the uptime below still reads 7h00m.
write_target
reset_states
state active "$CATCHUP" "$(printf '%s' "$CATCHUP" | jq -c 'del(.phase)')"
run cmd_status
check "status: server line" said "  server     test · hetzner · 203.0.113.7"
check "status: uptime and cost" said "  billing    up 7h00m, about 1.33 EUR so far at 0.19 EUR/h"
check "status: node.sh running" said "  node.sh    running (systemd unit threecast-node)"
check "status: live catch-up line" said "  progress   catch-up  shard 0 2s · shard 1 3h04m · shard 2 2h51m behind"
check "status: disk line" said "  disk       612G of 984G used (63%) on /root/snapchain"
check "status: version from /v1/info" said "  snapchain  0.14.3, answering on 127.0.0.1:3381"
check "status: reminds that billing runs until down" said "Billing runs until the server is deleted: ./threecast down"
check "status: next step while running" said "Watch it live: ./threecast node"

reset_states
state inactive "$SYNCED" "$LIVE_SYNCED"
run cmd_status
check "status synced: next step is the client" said "Next: ./threecast client   (step 2 of 3)"
check "status synced: the phrase is for the person to type" said "it asks for a TEST account's recovery phrase."
check "status synced: node.sh finished, node runs on" said "  node.sh    finished; the node itself keeps running in Docker"

reset_states
state_unreachable
run cmd_status
check "status unreachable: exits 1" exits 1
check "status unreachable: says so, with what to try" said "✗ Cannot reach 203.0.113.7 over SSH."
check "status unreachable: shows ssh's error" said "Operation timed out"

reset_states
state inactive '' ''
write_target PROVIDER=byo
run cmd_status
check "status never started: says how to start" said "The node has not been started yet: ./threecast node"
check "status never started: progress says so" said "  progress   not started yet"
check "status byo: no billing line" not_said "billing"
check "status never started: node not installed yet" said "  snapchain  not installed yet; snapchain.sh installs it once the snapshot is restored"

write_target
NODE_LOG=/root/snapchain/.threecast/node.log

reset_states
state active ''
run_json cmd_status --json
check "status --json, node.sh just started: exits 3" exits 3
check "status --json, node.sh just started: shape" json_ok
check "status --json, node.sh just started: preflight" json_is '.phase == "preflight" and .log == null'
check "status --json: narration goes to stderr" grep -qF "→ Asking 203.0.113.7 how your node is doing…" "$WORK/err"

reset_states
state active "{\"phase\":\"preflight\",\"message\":\"checking\",\"log\":\"$NODE_LOG\"}"
run_json cmd_status --json
check "status --json preflight: exits 3" exits 3
check "status --json preflight: shape" json_ok
check "status --json preflight: fields" \
  json_is '.phase == "preflight" and .synced == false and .restore == null and .shards == null and .version == null and .error == null'
check "status --json preflight: log path from status.json" json_is ".log == \"$NODE_LOG\""

reset_states
state active "$RESTORE_0"
run_json cmd_status --json
check "status --json restore: exits 3" exits 3
check "status --json restore: shape" json_ok
check "status --json restore: progress" \
  json_is '.phase == "restore" and .restore == {shard: 0, done: 120, total: 372, mbps: 41.3, eta_s: 4320}'
check "status --json restore: server, disk and cost" \
  json_is '.name == "test" and .provider == "hetzner" and .host == "203.0.113.7"
    and .disk == {used_gb: 612, total_gb: 984} and .cost == {currency: "EUR", hourly: 0.19, so_far: 1.33}'
check "status --json restore: log path even without one in status.json" json_is ".log == \"$NODE_LOG\""

reset_states
state active '{"phase":"install","message":"the official snapchain.sh is installing Docker and starting the node"}'
run_json cmd_status --json
check "status --json install: exits 3" exits 3
check "status --json install: shape" json_ok
check "status --json install: phase" json_is '.phase == "install" and .restore == null'

reset_states
state active "$CATCHUP" "$(printf '%s' "$CATCHUP" | jq -c 'del(.phase)')"
run_json cmd_status --json
check "status --json catchup: exits 3" exits 3
check "status --json catchup: shape" json_ok
check "status --json catchup: shards from the live check" \
  json_is '.phase == "catchup" and .version == "0.14.3" and .shards == [
    {id: 0, height: 1, delay_s: 2, messages: 12671345},
    {id: 1, height: 1, delay_s: 11040, messages: 1},
    {id: 2, height: 1, delay_s: 10260, messages: 1}]'

reset_states
state inactive "$SYNCED" "$(printf '%s' "$CATCHUP" | jq -c 'del(.phase)')"
run_json cmd_status --json
check "status --json, synced before and behind now: exits 3" exits 3
check "status --json, synced before and behind now: catchup" json_is '.phase == "catchup" and .synced == false'

reset_states
state inactive "$SYNCED" "$LIVE_SYNCED"
run_json cmd_status --json
check "status --json synced: exits 0" exits 0
check "status --json synced: shape" json_ok
check "status --json synced: fields" json_is '.phase == "synced" and .synced == true and .version == "0.14.3" and .error == null'

reset_states
state inactive "{\"phase\":\"error\",\"message\":\"Not enough free space in /root/snapchain: need 620 GiB, 300 GiB free.\",\"log\":\"$NODE_LOG\"}"
run_json cmd_status --json
check "status --json error: exits 1" exits 1
check "status --json error: shape" json_ok
check "status --json error: node.sh's message and log" \
  json_is ".phase == \"error\" and .error == \"Not enough free space in /root/snapchain: need 620 GiB, 300 GiB free.\" and .log == \"$NODE_LOG\""

reset_states
state inactive '{"phase":"error","message":"a \"quoted\" path \\ and a tab\t","log":"x"}'
run_json cmd_status --json
check "status --json: quotes and backslashes from the server stay intact" \
  json_is '.error == "a \"quoted\" path \\ and a tab\t"'

reset_states
state inactive "$RESTORE_0"
run_json cmd_status --json
check "status --json, stopped mid-way: exits 1" exits 1
check "status --json, stopped mid-way: shape" json_ok
check "status --json, stopped mid-way: error says how to resume" \
  json_is '.phase == "error" and (.error | contains("stopped during restore")) and (.error | contains("./threecast node --detach"))'
check "status --json, stopped mid-way: keeps where the restore was" json_is '.restore.shard == 0 and .restore.done == 120'

reset_states
state inactive "$SYNCED" '{"synced":false,"reason":"no answer from http://127.0.0.1:3381/v1/info"}'
run_json cmd_status --json
check "status --json, node no longer answering: exits 1" exits 1
check "status --json, node no longer answering: says so" \
  json_is '.phase == "error" and (.error | contains("not answering on 127.0.0.1:3381")) and .shards == null and .version == null'

reset_states
state active 'not json {'
run_json cmd_status --json
check "status --json, garbled status.json: still one valid object" json_ok
check "status --json, garbled status.json: still working" exits 3

reset_states
state inactive '' ''
write_target PROVIDER=byo
run_json cmd_status --json
check "status --json not-started: exits 1" exits 1
check "status --json not-started: shape" json_ok
check "status --json not-started: fields" \
  json_is '.phase == "not-started" and .provider == "byo" and .cost == null and .log == null and .error == null'

write_target
reset_states
state_unreachable
run_json cmd_status --json
check "status --json unreachable: exits 1" exits 1
check "status --json unreachable: shape" json_ok
check "status --json unreachable: fields" \
  json_is '.phase == "unreachable" and .host == "203.0.113.7" and .disk == null and .shards == null and .log == null
    and (.error | startswith("Cannot reach 203.0.113.7 over SSH."))'
check "status --json unreachable: cost still counted from the target" json_is '.cost.so_far == 1.33'
check "status --json unreachable: ssh's own error on stderr" grep -qF "Operation timed out" "$WORK/err"

reset_states
state_unreachable "root@203.0.113.7: Permission denied (publickey)."
run_json cmd_status --json
check "status --json, key refused: exits 1" exits 1
check "status --json, key refused: shape" json_ok
check "status --json, key refused: unreachable, and says it is the key" \
  json_is '.phase == "unreachable"
    and (.error | startswith("203.0.113.7 refused the SSH login as root (Permission denied)."))
    and (.error | contains("Is the server running") | not)'
check "status --json, key refused: ssh's own error on stderr" grep -qF "Permission denied (publickey)" "$WORK/err"

reset_states
state_unreachable "Host key verification failed."
run_json cmd_status --json
check "status --json, host key changed: says so and how to clear it" \
  json_is "(.error | startswith(\"The SSH host key of 203.0.113.7 is not the one threecast saw there before.\"))
    and (.error | contains(\"ssh-keygen -R 203.0.113.7 -f $TC_HOME/known_hosts\"))"
check "status --json: leaves no ssh error file behind" [ -z "$(find "$TC_HOME/run" -name '*.ssh.err')" ]

reset_states
TC_TARGET=nosuch run_json cmd_status --json
check "status --json, no target: exits 1" exits 1
check "status --json, no target: shape" json_ok
check "status --json, no target: fields" \
  json_is '.name == "nosuch" and .phase == "error" and .provider == null and .host == null and .cost == null
    and .error == "No server named '"'nosuch'"' yet. Run ./threecast up first (step 0)."'
check "status --json, no target: nothing on stderr either" [ ! -s "$WORK/err" ]
check "status --json, no target: no ssh" not_sent "ssh "

write_target "DATA_DIR='/root/my data'"
run_json cmd_status --json
check "status --json, bad DATA_DIR: exits 1" exits 1
check "status --json, bad DATA_DIR: shape" json_ok
check "status --json, bad DATA_DIR: says what to change" \
  json_is '.phase == "error" and .host == "203.0.113.7" and (.error | startswith("DATA_DIR may only use letters"))'
write_target

run cmd_status --jsn
check "status: rejects an unknown flag" said "✗ Unknown argument for status: --jsn"

check "render: restore before the first chunk" \
  [ "$(node_render '{"phase":"restore","shard":1,"done":0,"total":2673}')" = "restore   shard 1 (2 of 3)  chunk 0/2673" ]
check "render: phase message from node.sh" \
  [ "$(node_render '{"phase":"restore","message":"downloading the snapshot"}')" = "restore   downloading the snapshot" ]
check "render: nothing yet" [ "$(node_render '')" = "starting  node.sh is starting on the server" ]
check "duration: days" [ "$(node_duration 190000)" = "2d4h" ]
check "epoch: ISO 8601 UTC" [ "$(node_epoch 2026-10-21T00:00:00Z)" = 1792540800 ]
check "epoch: unix seconds" [ "$(node_epoch 1792540800)" = 1792540800 ]

finish
