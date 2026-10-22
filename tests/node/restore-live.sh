#!/usr/bin/env bash
# threecast — MIT License
# node/restore.sh against the real public bucket, in test mode: the first 3
# chunks of shard 0 (about 250 MB, deleted afterwards). Proves that md5(body)
# equals the ETag the bucket reports, and that the chunks, decompressed in
# order, form one tar stream across chunk boundaries.
set -euo pipefail
# shellcheck source=tests/node/testlib.sh
. "$(dirname "$0")/testlib.sh"

BASE=https://pub-d352dd8819104a778e20d08888c5a661.r2.dev
MIB100=104857600  # a chunk holds at most 100 MiB of tar

WORK=$(mktemp -d "${TMPDIR:-/tmp}/threecast-restore-live.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
DATA=$WORK/data
OUT=$WORK/out.log

RC=0
MAX_CHUNKS=3 AHEAD=3 STAGE_DIR=$WORK/stage "$NODE_BASH" "$REPO/node/restore.sh" "$DATA" > "$OUT" 2>&1 || RC=$?
sed 's/^/      /' "$OUT"
check "live: test mode exits 0" [ "$RC" = 0 ]

key=$(jq -r .key "$DATA/.threecast/status.json")

# The bucket's own ETag for a chunk, fetched separately with HEAD.
server_etag() {
  curl -fsSI "$BASE/$key/$1" | tr -d '\r"' | awk 'tolower($1) == "etag:" { print $2 }'
}
for n in 0001 0002 0003; do
  etag=$(server_etag "chunk_$n.bin")
  check "live: chunk_$n.bin md5 equals the bucket's ETag $etag" grep -q "chunk_$n.bin: md5 matches ETag $etag" "$OUT"
done

# Offset of the last tar header that `tar -tv` printed: every entry before it
# takes a 512-byte header plus its data rounded up to 512. A header beyond
# 100 MiB can only have been read from chunk 2 or later.
size_field=5
if tar --version 2>/dev/null | grep -q 'GNU tar'; then size_field=3; fi
last_header=$(awk -v f="$size_field" '
  { if (NR > 1) at += 512 + int((prev + 511) / 512) * 512; prev = $f }
  END { print at }' "$DATA/.threecast/shard-0.list")
entries=$(wc -l < "$DATA/.threecast/shard-0.list" | tr -d ' ')
echo "      $entries entries, last header at byte $last_header of the tar stream"
check "live: tar read headers past the first chunk" [ "$last_header" -gt "$MIB100" ]
check "live: nothing extracted" [ ! -e "$DATA/.rocks/shard-0" ]
check "live: nothing marked done" [ ! -e "$DATA/.threecast/shard-0.done" ]
check "live: staged chunks deleted" [ ! -e "$WORK/stage" ]

finish
