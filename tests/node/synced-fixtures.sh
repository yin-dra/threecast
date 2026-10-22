#!/usr/bin/env bash
# threecast — MIT License
# node/synced.sh against saved /v1/info responses. info-synced.json is a live
# capture from crackle.farcaster.xyz (2026-10-21); the others are edits of it.
set -euo pipefail
# shellcheck source=tests/node/testlib.sh
. "$(dirname "$0")/testlib.sh"

FIXTURES=$TESTS_DIR/fixtures
SYNCED=$REPO/node/synced.sh

judge() {  # fixture -> sets RC and OUT
  RC=0
  OUT=$("$NODE_BASH" "$SYNCED" - < "$FIXTURES/$1") || RC=$?
}
exits() { [ "$RC" = "$1" ]; }
summary_is() { printf '%s' "$OUT" | jq -e "$1" >/dev/null; }
reason_has() { printf '%s' "$OUT" | jq -e --arg r "$1" '.reason | contains($r)' >/dev/null; }
one_json_line() { [ "$(printf '%s\n' "$OUT" | wc -l | tr -d ' ')" = 1 ] && printf '%s' "$OUT" | jq -e . >/dev/null; }

judge info-synced.json
check "synced: exits 0" exits 0
check "synced: one line of JSON" one_json_line
check "synced: summary has all shards and the version" \
  summary_is '.synced and .version == "0.14.2" and ([.shards[].id] == [0, 1, 2])'

judge info-unordered.json
check "shards listed 0, 2, 1 (as snap does): still synced" exits 0

judge info-behind.json
check "behind: exits 1" exits 1
check "behind: names the slowest shard" reason_has "shard 1 is 11040 s behind"
check "behind: still one line of JSON" one_json_line

judge info-just-behind.json
check "11 s behind is not synced (limit is 10 s)" exits 1

judge info-missing-shard.json
check "missing shard: exits 1" exits 1
check "missing shard: names it" reason_has "shard 2 not reported yet"

judge info-shard0-empty.json
check "shard 0 empty (#1044): exits 1" exits 1
check "shard 0 empty (#1044): says it was not restored" reason_has "shard 0 has only 4211 messages"

judge not-info.html
check "an HTML error page: exits 1" exits 1
check "an HTML error page: says so" reason_has "not a /v1/info response"

RC=0
OUT=$(NODE_URL=http://127.0.0.1:9 "$NODE_BASH" "$SYNCED") || RC=$?
check "unreachable node: never synced" exits 1
check "unreachable node: says no answer" reason_has "no answer from http://127.0.0.1:9/v1/info"

# Over HTTP, the way node.sh calls it.
WORK=$(mktemp -d "${TMPDIR:-/tmp}/threecast-synced.XXXXXX")
node -e '
  const fs = require("node:fs");
  const body = fs.readFileSync(process.argv[1]);
  const server = require("node:http").createServer((req, res) => {
    if (req.url !== "/v1/info") { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(body);
  });
  server.listen(0, "127.0.0.1", () => fs.writeFileSync(process.argv[2], String(server.address().port)));
' "$FIXTURES/info-synced.json" "$WORK/port" &
SERVER=$!
stop_server() {
  kill "$SERVER" 2>/dev/null || true
  wait "$SERVER" 2>/dev/null || true
  rm -rf "$WORK"
}
trap stop_server EXIT
for _ in $(seq 1 50); do
  if [ -s "$WORK/port" ]; then break; fi
  sleep 0.1
done
RC=0
OUT=$(NODE_URL="http://127.0.0.1:$(cat "$WORK/port")" "$NODE_BASH" "$SYNCED") || RC=$?
check "over HTTP: synced node exits 0" exits 0

finish
