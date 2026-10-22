#!/usr/bin/env bash
# threecast — MIT License
# Tests for step 1, the read node.
#
#   tests/node/run.sh          offline tests and shellcheck
#   tests/node/run.sh --live   also the partial restore from the real public
#                              bucket (about 250 MB, deleted afterwards)
set -euo pipefail
# shellcheck source=tests/node/testlib.sh
. "$(dirname "$0")/testlib.sh"

suites="synced-fixtures.sh node-sh.sh local-node.sh restore-mock.sh"
case ${1:-} in
  "") ;;
  --live) suites="$suites restore-live.sh" ;;
  *) echo "usage: tests/node/run.sh [--live]" >&2; exit 2 ;;
esac

for tool in shellcheck node jq curl; do
  command -v "$tool" >/dev/null 2>&1 || { echo "tests need $tool" >&2; exit 2; }
done

# The local side must run on macOS /bin/bash 3.2, so the suites run there too, in the
# UTF-8 locale a macOS terminal sets.
export LANG=en_US.UTF-8
for suite in $suites; do
  printf '\n== %s\n' "$suite"
  if /bin/bash "$TESTS_DIR/$suite"; then passed "$suite"; else failed "$suite"; fi
done

printf '\n== shellcheck\n'
# From the repo root, where the "# shellcheck source=" paths are rooted.
cd "$REPO"
check "shellcheck: node/, lib/node.sh, tests/node/" shellcheck -x -s bash node/*.sh lib/node.sh tests/node/*.sh
# bash 3.2 in a UTF-8 locale reads "$name…" as a variable called "name…".
check "no \$name directly before a non-ASCII character" \
  sh -c "! grep -nE '\\\$[A-Za-z_][A-Za-z0-9_]*[^ -~[:space:]]' node/*.sh lib/node.sh"

finish
