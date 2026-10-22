#!/usr/bin/env bash
# threecast — MIT License
# Is this Snapchain read node in sync? Prints a one-line JSON summary and
# exits 0 only when it is.
#
#   synced.sh                  ask the node at $NODE_URL (default http://127.0.0.1:3381)
#   synced.sh - < info.json    judge a saved /v1/info response
#
# In sync means: shards 0, 1 and 2 are all reported, each is at most 10 s
# behind the network, and shard 0 holds more than 1,000,000 messages. The
# last rule catches a node whose shard 0 was never restored and is replaying
# from genesis (snapchain #1044): its reads look healthy, but every write
# fails with "unknown fid", because key registrations live on shard 0.
set -euo pipefail

NODE_URL=${NODE_URL:-http://127.0.0.1:3381}
MAX_DELAY=10
MIN_SHARD0_MESSAGES=1000000

not_synced() {
  jq -cn --arg reason "$1" '{synced: false, reason: $reason}'
  exit 1
}

if [ "${1:-}" = - ]; then
  info=$(cat)
elif ! info=$(curl -fsS -m 10 "$NODE_URL/v1/info" 2>/dev/null); then
  not_synced "no answer from $NODE_URL/v1/info"
fi

# shardInfos is not sorted (live nodes list 0, 2, 1), so shards are looked up by id.
summary=$(jq -c --argjson max "$MAX_DELAY" --argjson min "$MIN_SHARD0_MESSAGES" '
  select(type == "object" and (.shardInfos | type) == "array")
  | .shardInfos as $all
  | [range(0; 3) as $id | [$all[] | select(.shardId == $id)][0]] as $s
  | [range(0; 3) | select($s[.] == null)] as $missing
  | ([$s[] | select(. != null)] | max_by(.blockDelay // infinite)) as $slowest
  | {
      version: .version,
      shards: [$s[] | select(. != null) | {id: .shardId, maxHeight, blockDelay, numMessages}]
    }
  | if ($missing | length) > 0 then
      {synced: false, reason: "shard \($missing | map(tostring) | join(", ")) not reported yet"} + .
    elif ($s[0].numMessages // 0) <= $min then
      {synced: false, reason: "shard 0 has only \($s[0].numMessages // 0) messages: it was not restored from the snapshot"} + .
    elif ($slowest.blockDelay | type) != "number" or $slowest.blockDelay > $max then
      {synced: false, reason: "shard \($slowest.shardId) is \($slowest.blockDelay) s behind the network"} + .
    else
      {synced: true} + .
    end
' <<<"$info" 2>/dev/null) || summary=

[ -n "$summary" ] || not_synced "not a /v1/info response"

printf '%s\n' "$summary"
jq -e '.synced' >/dev/null <<<"$summary"
