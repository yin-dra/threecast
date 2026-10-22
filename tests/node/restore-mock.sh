#!/usr/bin/env bash
# threecast — MIT License
# node/restore.sh against a mock bucket (mock-bucket.mjs) serving a tiny
# 3-shard snapshot built here: happy path, bad ETags, daily rotation.
set -euo pipefail
# shellcheck source=tests/node/testlib.sh
. "$(dirname "$0")/testlib.sh"

WORK=$(mktemp -d "${TMPDIR:-/tmp}/threecast-restore-mock.XXXXXX")
MOCK_PID=
cleanup() {
  [ -z "$MOCK_PID" ] || kill "$MOCK_PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

build_snapshot() {
  local s f size
  mkdir -p "$WORK/src" "$WORK/tars"
  for s in 0 1 2; do
    mkdir -p "$WORK/src/shard-$s/sub"
    for f in 000011.sst 000012.sst 000013.sst; do
      size=$((150000 + s * 160000 + RANDOM))
      head -c "$size" /dev/urandom > "$WORK/src/shard-$s/$f"
    done
    printf 'MANIFEST-000005\n' > "$WORK/src/shard-$s/CURRENT"
    head -c 4099 /dev/urandom > "$WORK/src/shard-$s/sub/OPTIONS-000007"
    (cd "$WORK/src" && COPYFILE_DISABLE=1 tar -cf "$WORK/tars/shard-$s.tar" "shard-$s")
  done
}

start_mock() {  # scenario
  SCENARIO=$1
  rm -f "$WORK/port"
  node "$TESTS_DIR/mock-bucket.mjs" "$WORK/tars" "$SCENARIO" "$WORK/port" > "$WORK/requests-$SCENARIO.log" &
  MOCK_PID=$!
  for _ in $(seq 1 50); do
    if [ -s "$WORK/port" ]; then return 0; fi
    sleep 0.1
  done
  echo "the mock bucket did not start" >&2
  exit 1
}

stop_mock() {
  kill "$MOCK_PID" 2>/dev/null || true
  wait "$MOCK_PID" 2>/dev/null || true
  MOCK_PID=
}

# run_restore [VAR=value...] [-- restore.sh args...]: against the current
# mock, data in $WORK/data-$SCENARIO. Sets RC and OUT.
run_restore() {
  local vars=()
  while [ $# -gt 0 ] && [ "$1" != -- ]; do vars+=("$1"); shift; done
  [ $# -eq 0 ] || shift
  DATA=$WORK/data-$SCENARIO
  OUT=$WORK/out-$SCENARIO.log
  RC=0
  env SNAPSHOT_BASE="http://127.0.0.1:$(cat "$WORK/port")" AHEAD=3 RETRY_DELAY=0 HEADROOM_GIB=0 \
    STAGE_DIR="$WORK/stage-$SCENARIO" ${vars[@]+"${vars[@]}"} \
    "$NODE_BASH" "$REPO/node/restore.sh" "$@" "$DATA" > "$OUT" 2>&1 || RC=$?
}

exits() { [ "$RC" = "$1" ]; }
same_tree() { diff -r "$WORK/src/shard-$1" "$DATA/.rocks/shard-$1" >/dev/null; }
marked_with() { grep -q "$2" "$DATA/.threecast/shard-$1.done" 2>/dev/null; }
not_there() { [ ! -e "$DATA/$1" ]; }
logged() { grep -q -- "$1" "$OUT"; }
status_is() { jq -e "$1" "$DATA/.threecast/status.json" >/dev/null; }
listed_at_least() { [ "$(wc -l < "$DATA/.threecast/shard-0.list")" -ge "$1" ]; }
last_line_says() { tail -n 1 "$OUT" | grep -q -- "$1"; }
no_curl_left() { ! pgrep -f "$WORK/stage-$SCENARIO" >/dev/null 2>&1; }

requests() {  # jq condition on a request line -> how many matched
  jq -s "[.[] | select($1)] | length" "$WORK/requests-$SCENARIO.log"
}
requested() { [ "$(requests "$1")" = "$2" ]; }

inflight_between() {
  local max
  max=$(jq -s '[.[].inflight // 0] | max' "$WORK/requests-$SCENARIO.log")
  [ "$max" -ge "$1" ] && [ "$max" -le "$2" ]
}

every_chunk_verified() {
  [ "$(grep -c 'md5 matches ETag' "$OUT")" = "$(requests '.path | test("chunk_")')" ]
}

build_snapshot
echo "restore.sh runs under $("$NODE_BASH" --version | head -n 1)"

start_mock happy
run_restore
check "happy: exits 0" exits 0
for s in 0 1 2; do
  check "happy: shard $s unpacked byte for byte" same_tree "$s"
  check "happy: shard $s marked done with its key" marked_with "$s" "snapshot-test-$s-gen0"
done
check "happy: every chunk checked against its ETag" every_chunk_verified
check "happy: downloads overlap, at most AHEAD=3 in flight" inflight_between 2 3
check "happy: final status is shard 2 with all chunks done" \
  status_is '.phase == "restore" and .shard == 2 and .done == .total and .eta_s == 0'
check "happy: staging directory removed" [ ! -e "$WORK/stage-happy" ]
before=$(wc -l < "$WORK/requests-happy.log")
run_restore
check "happy: re-run exits 0" exits 0
check "happy: re-run downloads nothing" [ "$(wc -l < "$WORK/requests-happy.log")" = "$before" ]
check "happy: re-run says the shards are restored" logged "all shards are already restored"
stop_mock

start_mock check
run_restore -- --check
check "--check: passes with room to spare" exits 0
run_restore HEADROOM_GIB=100000 -- --check
check "--check: fails when the disk is too small" exits 1
check "--check: says how much space is needed" last_line_says "Not enough free space in $DATA: need"
check "--check: extracts nothing" not_there .rocks/shard-0
stop_mock

start_mock maxchunks
run_restore MAX_CHUNKS=2
check "MAX_CHUNKS=2: exits 0 although tar stops at the cut" exits 0
check "MAX_CHUNKS=2: downloads exactly 2 chunks" requested '.path | test("chunk_")' 2
check "MAX_CHUNKS=2: tar listed shard-0/ and what follows it" listed_at_least 2
check "MAX_CHUNKS=2: extracts nothing" not_there .rocks/shard-0
check "MAX_CHUNKS=2: marks nothing done" not_there .threecast/shard-0.done
stop_mock

start_mock bad-etag-once
run_restore
check "bad ETag once: exits 0 after a retry" exits 0
check "bad ETag once: logged the mismatch" logged "chunk_0002.bin: MD5 does not match its ETag 00000000"
check "bad ETag once: that chunk was fetched twice" requested '.path | test("/0/.*chunk_0002")' 2
check "bad ETag once: shard 0 byte for byte" same_tree 0
stop_mock

start_mock bad-etag
run_restore
check "bad ETag: exits 1" exits 1
check "bad ETag: shard 0, restored before, is kept" same_tree 0
check "bad ETag: shard 1 not marked done" not_there .threecast/shard-1.done
check "bad ETag: no partial shard 1 left in .rocks" not_there .rocks/shard-1
check "bad ETag: shard 2 never started" requested '.path | test("/2/.*chunk_")' 0
check "bad ETag: 6 tries per chunk, 3 tries for the shard" requested '.path | test("/1/.*chunk_0003")' 18
check "bad ETag: the last line says what failed" last_line_says "Shard 1 could not be restored after 3 attempts"
check "bad ETag: no downloads left running" no_curl_left
stop_mock

start_mock cut-once
run_restore
check "broken-off download: exits 0 after a retry" exits 0
check "broken-off download: logged as a failed download, not a bad ETag" \
  logged "chunk_0002.bin: download failed (HTTP 200, curl exit 18)"
check "broken-off download: shard 2 byte for byte" same_tree 2
stop_mock

start_mock rotate
run_restore
check "rotation: exits 0" exits 0
check "rotation: noticed the 404" logged "is gone (404)"
check "rotation: fresh latest.json for the retry (plan + 2 attempts)" \
  requested '.path == "FARCASTER_NETWORK_MAINNET/1/latest.json"' 3
check "rotation: shard 1 done with the new key" marked_with 1 "snapshot-test-1-gen1"
for s in 0 1 2; do check "rotation: shard $s byte for byte" same_tree "$s"; done
check "rotation: no downloads left running" no_curl_left
stop_mock

start_mock rotate-always
run_restore
check "rotation on every attempt: exits 1" exits 1
check "rotation on every attempt: 3 attempts, each with fresh metadata" \
  requested '.path == "FARCASTER_NETWORK_MAINNET/1/latest.json"' 4
check "rotation on every attempt: shard 1 not done" not_there .threecast/shard-1.done
check "rotation on every attempt: no partial shard 1 left" not_there .rocks/shard-1
stop_mock

finish
