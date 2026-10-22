#!/usr/bin/env bash
# threecast — MIT License
# Streams the public Snapchain snapshot into DATA_DIR/.rocks, one shard at a
# time, before the node starts for the first time.
#
# Why not the node's own loader: it keeps every compressed chunk and every
# assembled .tar until all shards are done (about 1.6 TB at peak, more than a
# 1 TB volume), and it reads all shards' metadata up front, so a download that
# outlives the daily snapshot rotation dies on 404s and leaves shard 0 to
# replay from genesis (snapchain #1044).
#
# Here each shard gets fresh metadata right before it starts, chunks are
# checked against their ETag (R2 sets it to the MD5 of the object), and a
# shard is only marked done when its whole tar stream unpacked cleanly.
#
# Usage: restore.sh [--check] [DATA_DIR]
#   --check        only check there is room for the shards not restored yet
# Environment:
#   SNAPSHOT_BASE  bucket URL (tests point it at a mock)
#   AHEAD          chunks downloading at once, default 6
#   MAX_CHUNKS     test mode: send only the first N chunks of the first missing
#                  shard into `tar -t`; nothing is extracted or marked done
#   STAGE_DIR      where chunks wait to be unpacked, default /var/tmp/threecast-chunks
#   RETRY_DELAY    seconds before a chunk retry, times the attempt number, default 10
#   HEADROOM_GIB   free space to keep beyond the unpacked snapshot, default 64
set -euo pipefail

CHECK_ONLY=0
if [ "${1:-}" = --check ]; then CHECK_ONLY=1; shift; fi
DATA_DIR=${1:-${DATA_DIR:-/root/snapchain}}

BASE=${SNAPSHOT_BASE:-https://pub-d352dd8819104a778e20d08888c5a661.r2.dev}
NETWORK=FARCASTER_NETWORK_MAINNET
AHEAD=${AHEAD:-6}
MAX_CHUNKS=${MAX_CHUNKS:-0}
# Local disk, not the volume: the volume is network storage, and it is already
# busy taking the unpacked data.
STAGE=${STAGE_DIR:-/var/tmp/threecast-chunks}
RETRY_DELAY=${RETRY_DELAY:-10}
TRIES_PER_CHUNK=6
TRIES_PER_SHARD=3

DB=$DATA_DIR/.rocks
STATE=$DATA_DIR/.threecast
CHUNK_KIB=$((100 * 1024))           # a chunk holds at most 100 MiB of tar (snapchain backup.rs)
HEADROOM_KIB=$((${HEADROOM_GIB:-64} * 1024 * 1024))  # for catch-up writes and RocksDB compactions

CHUNKS=()  # chunk names of the shard being streamed
PIDS=()    # curl pid per chunk index
COUNT=()   # chunk count per shard, from the metadata read at start

log() { printf '%s restore: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }

# The last line printed before a failure is the reason; node.sh shows it.
die() { log "$*"; exit 1; }

md5_of() {
  if command -v md5sum >/dev/null 2>&1; then
    md5sum < "$1" | cut -d' ' -f1
  else
    md5 -q "$1"
  fi
}

free_kib() { df -Pk "$1" | awk 'NR == 2 { print $4 }'; }

is_done() { [ -f "$STATE/shard-$1.done" ]; }

fetch_metadata() {
  local meta
  meta=$(curl -fsS --retry 5 --retry-delay 5 --max-time 60 "$BASE/$NETWORK/$1/latest.json") || return 1
  jq -e '(.key_base | type) == "string" and (.chunks | type) == "array" and (.chunks | length) > 0' \
    >/dev/null 2>&1 <<<"$meta" || return 1
  printf '%s\n' "$meta"
}

write_status() {  # shard done total bytes seconds chunks-in-later-shards key
  jq -cn --argjson shard "$1" --argjson finished "$2" --argjson total "$3" --argjson bytes "$4" \
    --argjson secs "$5" --argjson later "$6" --arg key "$7" '
    ([$secs, 1] | max) as $t
    | {phase: "restore", shard: $shard, done: $finished, total: $total, bytes: $bytes,
       mbps: ($bytes / $t / 1e5 | floor / 10),
       eta_s: (if $finished > 0 then ($total - $finished + $later) * $t / $finished | floor else null end),
       key: $key, updated: (now | floor)}' > "$STATE/status.json.tmp" &&
    mv "$STATE/status.json.tmp" "$STATE/status.json"
}

start_download() {  # key index
  rm -f "$STAGE/$2" "$STAGE/$2.head" "$STAGE/$2.code"
  curl -sS --connect-timeout 20 --speed-limit 100000 --speed-time 60 \
    -D "$STAGE/$2.head" -o "$STAGE/$2" -w '%{http_code}' \
    "$BASE/$1/${CHUNKS[$2]}" > "$STAGE/$2.code" 2> "$STAGE/$2.err" &
  PIDS[$2]=$!
}

etag_of() { tr -d '\r"' < "$1" | awk 'tolower($1) == "etag:" { tag = $2 } END { print tag }'; }

# Waits for chunk $2 and re-downloads it until md5(body) == ETag. Returns 1 on
# a 404, which means the bucket replaced this snapshot; the shard must restart.
await_chunk() {  # key index
  local key=$1 i=$2 name=${CHUNKS[$2]} try code etag rc
  for ((try = 1; try <= TRIES_PER_CHUNK; try++)); do
    rc=0
    wait "${PIDS[i]}" || rc=$?
    code=$(cat "$STAGE/$i.code" 2>/dev/null || true)
    # curl reports 200 for a transfer it gave up on half-way (too slow, connection reset).
    case $rc:$code in
      0:200)
        etag=$(etag_of "$STAGE/$i.head")
        if [ "$(md5_of "$STAGE/$i")" = "$etag" ]; then
          log "$name: md5 matches ETag $etag"
          return 0
        fi
        log "$name: MD5 does not match its ETag $etag (attempt $try)"
        ;;
      0:404)
        log "$name is gone (404): the bucket has published a newer snapshot of this shard"
        return 1
        ;;
      *)
        log "$name: download failed (HTTP ${code:-none}, curl exit $rc) $(tr '\n' ' ' < "$STAGE/$i.err" 2>/dev/null)(attempt $try)"
        ;;
    esac
    [ "$try" -lt "$TRIES_PER_CHUNK" ] || break
    sleep $((try * RETRY_DELAY))
    start_download "$key" "$i"
  done
  log "$name: giving up after $TRIES_PER_CHUNK attempts"
  return 1
}

stop_downloads() {  # first-index end-index: kill the downloads not awaited yet
  local j
  for ((j = $1; j < $2; j++)); do kill "${PIDS[j]}" 2>/dev/null || true; done
  wait 2>/dev/null || true
}

# Writes the shard's tar stream to stdout. Chunks download AHEAD at a time but
# are decompressed strictly in order: each chunk is its own gzip member, and
# the tar stream inside runs across chunk boundaries.
stream_shard() {  # shard key chunk-count chunks-in-later-shards
  local shard=$1 key=$2 n=$3 later=$4 i next=0 bytes=0 started=$SECONDS
  PIDS=()
  write_status "$shard" 0 "$n" 0 0 "$later" "$key"
  for ((i = 0; i < n; i++)); do
    while [ "$next" -lt "$n" ] && [ "$next" -lt $((i + AHEAD)) ]; do
      start_download "$key" "$next"
      next=$((next + 1))
    done
    if ! await_chunk "$key" "$i"; then
      stop_downloads $((i + 1)) "$next"
      return 1
    fi
    if ! gzip -dc "$STAGE/$i"; then
      log "${CHUNKS[i]}: could not decompress it, or tar stopped reading"
      stop_downloads $((i + 1)) "$next"
      return 1
    fi
    bytes=$((bytes + $(wc -c < "$STAGE/$i")))
    rm -f "$STAGE/$i" "$STAGE/$i".*
    write_status "$shard" $((i + 1)) "$n" "$bytes" $((SECONDS - started)) "$later" "$key" || true
  done
}

load_chunks() {  # metadata-json
  local name
  CHUNKS=()
  while IFS= read -r name; do CHUNKS+=("$name"); done < <(jq -r '.chunks[]' <<<"$1")
}

# One attempt at a shard. Every attempt starts from a clean slate, and only a
# complete tar stream earns the .done marker.
restore_shard() {  # shard chunks-in-later-shards
  local shard=$1 later=$2 meta key
  rm -rf "${DB:?}/shard-$shard" "${STAGE:?}"
  mkdir -p "$STAGE" || return 1
  if ! meta=$(fetch_metadata "$shard"); then
    log "could not read $BASE/$NETWORK/$shard/latest.json"
    return 1
  fi
  key=$(jq -r .key_base <<<"$meta")
  load_chunks "$meta"
  log "shard $shard: ${#CHUNKS[@]} chunks from $key"

  stream_shard "$shard" "$key" "${#CHUNKS[@]}" "$later" | tar -xf - -C "$DB" || return 1
  if [ ! -d "$DB/shard-$shard" ]; then
    log "the snapshot of shard $shard has no shard-$shard/ directory"
    return 1
  fi
  printf '%s\n' "$key" > "$STATE/shard-$shard.done" || return 1
  log "shard $shard restored: $(du -sh "$DB/shard-$shard" | cut -f1)"
}

# Test mode: proves download, MD5 check and in-order decompression on real
# data without needing 600 GB. The stream is cut after MAX_CHUNKS chunks, so
# tar is expected to fail at the cut; only the download side must succeed.
list_first_chunks() {  # shard
  local shard=$1 meta key n list stray codes=(0 0)
  rm -rf "${STAGE:?}"
  mkdir -p "$STAGE"
  meta=$(fetch_metadata "$shard") || die "could not read the metadata of shard $shard"
  key=$(jq -r .key_base <<<"$meta")
  load_chunks "$meta"
  n=${#CHUNKS[@]}
  [ "$n" -le "$MAX_CHUNKS" ] || n=$MAX_CHUNKS
  list=$STATE/shard-$shard.list
  log "test mode: first $n chunks of shard $shard from $key"

  stream_shard "$shard" "$key" "$n" 0 | tar -tvf - > "$list" 2> "$list.err" || codes=("${PIPESTATUS[@]}")
  [ "${codes[0]}" = 0 ] || die "test mode: downloading or decompressing the chunks failed"
  [ -s "$list" ] || die "test mode: tar found no entries, the chunks do not form a tar stream"
  stray=$(awk -v p="shard-$shard/" 'index($NF, p) != 1 { print $NF; exit }' "$list")
  [ -z "$stray" ] || die "test mode: the tar stream has an entry outside shard-$shard/: $stray"
  rm -rf "${STAGE:?}"
  log "test mode: $n chunks matched their ETags and decompress into one tar stream," \
    "$(wc -l < "$list" | tr -d ' ') entries listed in $list; at the cut, as expected: $(head -n 1 "$list.err")"
}

main() {
  local s t first pending="" need_kib=0 later try meta
  mkdir -p "$STATE"
  for s in 0 1 2; do is_done "$s" || pending="$pending $s"; done
  if [ -z "$pending" ]; then
    log "all shards are already restored"
    return 0
  fi

  for s in $pending; do
    meta=$(fetch_metadata "$s") ||
      die "Could not read the snapshot list for shard $s from $BASE. Check the server's internet access and run again."
    COUNT[s]=$(jq '.chunks | length' <<<"$meta")
    need_kib=$((need_kib + COUNT[s] * CHUNK_KIB))
  done
  log "to restore: shards$pending, $((need_kib / 1048576)) GiB unpacked at most"

  if [ "$MAX_CHUNKS" -gt 0 ]; then
    first=${pending# }
    list_first_chunks "${first%% *}"
    return 0
  fi

  need_kib=$((need_kib + HEADROOM_KIB))
  [ "$(free_kib "$DATA_DIR")" -ge "$need_kib" ] ||
    die "Not enough free space in $DATA_DIR: need $((need_kib / 1048576)) GiB, $(($(free_kib "$DATA_DIR") / 1048576)) GiB free."
  mkdir -p "$STAGE"
  [ "$(free_kib "$STAGE")" -ge $(((AHEAD + 1) * 128 * 1024)) ] ||
    die "Not enough free space in $STAGE for $AHEAD chunks in flight: need $(((AHEAD + 1) * 128)) MiB."
  if [ "$CHECK_ONLY" = 1 ]; then
    log "enough free space in $DATA_DIR and $STAGE"
    return 0
  fi

  mkdir -p "$DB"
  for s in $pending; do
    later=0
    for t in $pending; do [ "$t" -le "$s" ] || later=$((later + COUNT[t])); done
    for ((try = 1; try <= TRIES_PER_SHARD; try++)); do
      restore_shard "$s" "$later" && break
      [ "$try" = "$TRIES_PER_SHARD" ] ||
        log "shard $s: attempt $try of $TRIES_PER_SHARD failed; starting the shard again with fresh metadata"
    done
    rm -rf "${STAGE:?}"
    if ! is_done "$s"; then
      rm -rf "${DB:?}/shard-$s"
      die "Shard $s could not be restored after $TRIES_PER_SHARD attempts; the reasons are in the lines above."
    fi
  done
  log "snapshot restored: $(du -sh "$DB" | cut -f1) in $DB"
}

main
