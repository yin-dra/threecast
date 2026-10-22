#!/bin/bash
# threecast — MIT License
# Runs one provisioning command the way ./threecast does, but loads only the provisioning
# libraries, so these tests do not depend on lib/node.sh or lib/client.sh.
set -euo pipefail

TC_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
export TC_ROOT
# shellcheck source=lib/common.sh
. "$TC_ROOT/lib/common.sh"
# shellcheck source=lib/up.sh
. "$TC_ROOT/lib/up.sh"
# shellcheck source=lib/down.sh
. "$TC_ROOT/lib/down.sh"
# shellcheck source=lib/remote.sh
. "$TC_ROOT/lib/remote.sh"

parse_common_flags "$@"
set -- "${TC_ARGS[@]+"${TC_ARGS[@]}"}"
cmd=$1
shift
tc_init_home

case "$cmd" in
  up)          cmd_up "$@" ;;
  down)        cmd_down "$@" ;;
  ssh)         cmd_ssh "$@" ;;
  tunnel-up)   load_target; tunnel_up; tunnel_url ;;
  tunnel-down) load_target; tunnel_down ;;
  *) die "tc.sh: unknown command $cmd" ;;
esac
