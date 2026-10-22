#!/usr/bin/env bash
# threecast — MIT License
# node/node.sh, function by function, with crontab, docker, setsid,
# restore.sh and synced.sh replaced by stubs. What needs root, systemd, a
# volume or the real snapchain.sh is not covered here.
set -euo pipefail
# shellcheck source=tests/node/testlib.sh
. "$(dirname "$0")/testlib.sh"

WORK=$(mktemp -d "${TMPDIR:-/tmp}/threecast-node-sh.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
STUBS=$WORK/bin
mkdir -p "$STUBS"

cat > "$STUBS/crontab" <<'EOF'
#!/bin/sh
# crontab -l | crontab - , backed by a file
case $1 in
  -l) [ -f "$CRONTAB_FILE" ] && cat "$CRONTAB_FILE" ;;
  -) cat > "$CRONTAB_FILE" ;;
esac
EOF
cat > "$STUBS/docker" <<'EOF'
#!/bin/sh
echo "docker $*" >> "$DOCKER_LOG"
EOF
cat > "$STUBS/setsid" <<'EOF'
#!/bin/sh
exec perl -e 'use POSIX (); defined(POSIX::setsid()) or die "setsid: $!"; exec @ARGV or die' -- "$@"
EOF
chmod 755 "$STUBS"/*
export PATH="$STUBS:$PATH" CRONTAB_FILE=$WORK/crontab DOCKER_LOG=$WORK/docker.log

# fresh: a new DATA_DIR and a node.sh sourced against it, in the current shell.
fresh() {
  rm -rf "$WORK/data" "$WORK/here" "$CRONTAB_FILE" "$DOCKER_LOG"
  mkdir -p "$WORK/data/.threecast" "$WORK/here"
  export DATA_DIR=$WORK/data
  OPERATOR_FID=
  # shellcheck source=node/node.sh
  . "$REPO/node/node.sh"
  HERE=$WORK/here
}

run() {  # function... ; in a subshell, so that fail's exit is caught
  RC=0
  ("$@") >> "$WORK/data/.threecast/node.log" 2>&1 || RC=$?
}
exits() { [ "$RC" = "$1" ]; }
env_is() { [ "$(grep -c "^$1=" "$DATA_DIR/.env")" = 1 ] && grep -qxF "$1=$2" "$DATA_DIR/.env"; }
env_lacks() { ! grep -q "^$1=" "$DATA_DIR/.env"; }
status_is() { jq -e "$1" "$DATA_DIR/.threecast/status.json" >/dev/null; }
cron_lines() { cat "$CRONTAB_FILE" 2>/dev/null | grep -c 'snapchain.sh autoupgrade' || true; }
official_cron_line() {
  grep -Eqx "0 [0-6] \* \* [1-5] $DATA_DIR/snapchain.sh autoupgrade >> $DATA_DIR/snapchain-autoupgrade.log 2>&1" "$CRONTAB_FILE"
}
logged() { grep -qF -- "$1" "$DATA_DIR/.threecast/node.log"; }
docker_ran() { grep -qxF "docker $1" "$DOCKER_LOG" 2>/dev/null; }

fresh
printf 'other job\n' > "$CRONTAB_FILE"
run seed_env
check "seed_env without FID: agrees to no rewards" env_is AGREE_NO_REWARDS_FOR_ME true
check "seed_env without FID: HUB_OPERATOR_FID=0" env_is HUB_OPERATOR_FID 0
check "seed_env without FID: SKIP_CRONTAB=true (snapchain #1030)" env_is SKIP_CRONTAB true
check "seed_env without FID: own cron line in the official format" official_cron_line
check "seed_env without FID: keeps existing cron jobs" grep -qx 'other job' "$CRONTAB_FILE"
run seed_env
check "seed_env twice: still one cron line" [ "$(cron_lines)" = 1 ]
check "seed_env twice: no duplicate .env lines" [ "$(sort "$DATA_DIR/.env" | uniq -d | wc -l | tr -d ' ')" = 0 ]

fresh
printf 'FC_NETWORK_ID=1\nAGREE_NO_REWARDS_FOR_ME=false\nAGREE_NO_REWARDS_FOR_ME=maybe\n' > "$DATA_DIR/.env"
OPERATOR_FID=12345
run seed_env
check "seed_env with FID: HUB_OPERATOR_FID set" env_is HUB_OPERATOR_FID 12345
check "seed_env with FID: no SKIP_CRONTAB, the official script installs cron" env_lacks SKIP_CRONTAB
check "seed_env with FID: no cron line written by threecast" [ "$(cron_lines)" = 0 ]
check "seed_env: a refusal in .env is replaced by agreement" env_is AGREE_NO_REWARDS_FOR_ME true
check "seed_env: other .env lines kept" env_is FC_NETWORK_ID 1

fresh
printf 'HUB_OPERATOR_FID=777\n' > "$DATA_DIR/.env"
run seed_env
check "seed_env: an FID already in .env is kept" env_is HUB_OPERATOR_FID 777
check "seed_env: and the official cron is left to snapchain.sh" env_lacks SKIP_CRONTAB

fresh
cat > "$DATA_DIR/snapchain.sh" <<'EOF'
#!/bin/sh
echo "✅ Upgrade complete. Restarting with new version..."
sleep 1
echo "✅ Upgrade complete."
echo ""
echo "Monitor your node at http://localhost:3000/"
sleep 3001 &
wait
EOF
chmod 755 "$DATA_DIR/snapchain.sh"
started=$SECONDS
run run_installer
check "installer: returns once it printed 'Upgrade complete.'" exits 0
check "installer: did not stop at the self-upgrade line" logged "Monitor your node at http://localhost:3000/"
check "installer: returned within 15 s" [ $((SECONDS - started)) -le 15 ]
check "installer: its whole session was stopped (logs -f stand-in)" sh -c '! pgrep -f "sleep 3001" >/dev/null'
check "installer: output copied into node.log" logged "output of snapchain.sh upgrade:"

fresh
printf '#!/bin/sh\necho "❌ Neither docker-compose nor docker compose is available on this system."\nexit 1\n' > "$DATA_DIR/snapchain.sh"
chmod 755 "$DATA_DIR/snapchain.sh"
run run_installer
check "installer failing: exits 1" exits 1
check "installer failing: status is error" status_is '.phase == "error" and (.message | contains("stopped before"))'
check "installer failing: its output is in node.log" logged "Neither docker-compose nor docker compose"

# synced.sh stub: prints summary N of a scripted list on its Nth call, exits 0
# on the last one; every call also saves the status.json it sees.
script_sync() {  # summaries...
  local i=0 s
  for s in "$@"; do printf '%s\n' "$s" > "$WORK/here/sync.$i"; i=$((i + 1)); done
  echo 0 > "$WORK/here/sync.next"
  cat > "$WORK/here/synced.sh" <<EOF
#!/bin/sh
n=\$(cat "$WORK/here/sync.next")
echo \$((n + 1)) > "$WORK/here/sync.next"
cat "$DATA_DIR/.threecast/status.json" >> "$WORK/here/status.history" 2>/dev/null
cat "$WORK/here/sync.\$n"
[ "\$n" = $((i - 1)) ]
EOF
  cat > "$WORK/here/restore.sh" <<EOF
#!/bin/sh
[ -e "$DATA_DIR/.rocks/shard-0" ] && echo "restore.sh: shard-0 still there" >> "$WORK/here/restore.calls"
echo "restore.sh \$*" >> "$WORK/here/restore.calls"
touch "$DATA_DIR/.threecast/shard-0.done"
EOF
  chmod 755 "$WORK/here/synced.sh" "$WORK/here/restore.sh"
}
shards() {  # shard-0-messages delay
  printf '{"synced":false,"reason":"r","version":"0.14.3","shards":[{"id":0,"maxHeight":9,"blockDelay":%s,"numMessages":%s},{"id":1,"maxHeight":9,"blockDelay":%s,"numMessages":5},{"id":2,"maxHeight":9,"blockDelay":%s,"numMessages":5}]}' \
    "$2" "$1" "$2" "$2"
}

fresh
SYNC_POLL=0
mkdir -p "$DATA_DIR/.rocks/shard-0" "$DATA_DIR/.rocks/shard-1"
touch "$DATA_DIR/docker-compose.yml" "$DATA_DIR/.threecast/shard-0.done" "$DATA_DIR/.threecast/shard-1.done" "$DATA_DIR/.threecast/shard-2.done"
script_sync '{"synced":false,"reason":"no answer from http://127.0.0.1:3381/v1/info"}' \
  "$(shards 4211 49212912)" "$(shards 12671345 900)" \
  '{"synced":true,"version":"0.14.3","shards":[]}'
run wait_for_sync
check "catch-up: ends when synced.sh says synced" exits 0
check "catch-up: final status is synced" status_is '.phase == "synced" and .version == "0.14.3"'
check "catch-up: status carried the shard delays meanwhile" \
  grep -q '"phase":"catchup".*"blockDelay":900' "$WORK/here/status.history"
check "#1044 guard: stopped the node" docker_ran "compose stop snapchain"
check "#1044 guard: removed shard 0 before restoring" sh -c "! grep -q 'still there' '$WORK/here/restore.calls'"
check "#1044 guard: restored once" [ "$(grep -c '^restore.sh ' "$WORK/here/restore.calls")" = 1 ]
check "#1044 guard: kept shard 1" [ -d "$DATA_DIR/.rocks/shard-1" ]
check "#1044 guard: started the node again" docker_ran "compose up -d snapchain"

fresh
SYNC_POLL=0
touch "$DATA_DIR/docker-compose.yml"
script_sync "$(shards 4211 49212912)" "$(shards 4211 49212912)" '{"synced":true}'
run wait_for_sync
check "#1044 guard twice: gives up" exits 1
check "#1044 guard twice: says why" status_is '.phase == "error" and (.message | contains("still has only 4211 messages"))'

fresh
SYNC_POLL=0
SILENCE_LIMIT=0
script_sync '{"synced":false,"reason":"no answer"}' '{"synced":true}'
run wait_for_sync
check "silent node: gives up after SILENCE_LIMIT" exits 1
check "silent node: says the node is not answering" status_is '.message | contains("has not answered on http://127.0.0.1:3381")'
check "silent node: asked docker for its last log lines" docker_ran "compose logs --tail 30 snapchain"

fresh
mkdir -p "$DATA_DIR/.rocks/shard-0" "$DATA_DIR/.rocks/shard-1" "$DATA_DIR/.rocks/shard-2" "$WORK/fakenode/v1"
cp "$TESTS_DIR/fixtures/info-synced.json" "$WORK/fakenode/v1/info"
NODE_URL=file://$WORK/fakenode
run adopt_existing_db
check "existing node answering: its database is kept" grep -qx adopted "$DATA_DIR/.threecast/shard-2.done"
fresh
mkdir -p "$DATA_DIR/.rocks/shard-0" "$DATA_DIR/.rocks/shard-1" "$DATA_DIR/.rocks/shard-2"
NODE_URL=http://127.0.0.1:9
run adopt_existing_db
check "existing database, node not answering: restored as usual" [ ! -e "$DATA_DIR/.threecast/shard-0.done" ]
fresh
mkdir -p "$DATA_DIR/.rocks/shard-1" "$DATA_DIR/.rocks/shard-2" "$WORK/fakenode/v1"
NODE_URL=file://$WORK/fakenode
run adopt_existing_db
check "existing database without shard 0: restored as usual" [ ! -e "$DATA_DIR/.threecast/shard-1.done" ]

fresh
run "$NODE_BASH" -c ". '$REPO/node/node.sh'; trap on_exit EXIT; PHASE=restore; false"
check "unexpected exit: status says where it stopped" status_is '.phase == "error" and (.message | startswith("node.sh stopped during restore (exit 1)"))'

finish
