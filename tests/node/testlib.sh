# threecast — MIT License
# Shared by the tests in tests/node/. Sourced; bash 3.2 compatible.
# shellcheck disable=SC2034 # REPO and NODE_BASH are for the scripts that source this

TESTS_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$TESTS_DIR/../.." && pwd)
FAILED=0

# node/ targets bash 5 on Ubuntu but is written to run on 3.2 as well;
# use a newer bash when this machine has one.
NODE_BASH=/bin/bash
for b in /opt/homebrew/bin/bash /usr/local/bin/bash; do
  if [ -x "$b" ]; then NODE_BASH=$b; break; fi
done

# Not named pass/fail: tests source node/node.sh, which has its own fail().
passed() { printf 'ok    %s\n' "$*"; }
failed() { printf 'FAIL  %s\n' "$*"; FAILED=$((FAILED + 1)); }

# check "description" command... : passes when the command succeeds.
check() {
  local what=$1
  shift
  if "$@"; then passed "$what"; else failed "$what"; fi
}

finish() {
  if [ "$FAILED" -gt 0 ]; then
    printf '%d check(s) failed in %s\n' "$FAILED" "$(basename "$0")"
    exit 1
  fi
}
