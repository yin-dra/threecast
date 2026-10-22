#!/bin/bash
# threecast — MIT License
# Provisioning tests: lib/up.sh, lib/down.sh and lib/remote.sh run under /bin/bash against mock
# Hetzner and DigitalOcean APIs (Node, no dependencies) and a fake ssh. No real cloud is touched.
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
root=$(cd "$here/../.." && pwd)

command -v node >/dev/null 2>&1 || { echo "These tests need Node 24 (node --test)." >&2; exit 1; }

if command -v shellcheck >/dev/null 2>&1; then
  (cd "$root" && shellcheck -x lib/up.sh lib/down.sh lib/remote.sh provision/hetzner.sh \
    provision/digitalocean.sh tests/provision/tc.sh tests/provision/bin/ssh tests/provision/run.sh)
  echo "shellcheck: clean"
fi

# Under a UTF-8 locale, macOS bash 3.2 reads "$name…" as a variable called "name…" (unbound).
if (cd "$root" && grep -nE '\$[A-Za-z_][A-Za-z0-9_]*[^ -~[:space:]]' threecast lib/*.sh provision/*.sh); then
  echo "Write \${name} before a non-ASCII character (lines above)." >&2
  exit 1
fi

node --test --test-reporter=spec "$here/provision.test.mjs"
