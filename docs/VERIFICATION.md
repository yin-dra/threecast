# What has been verified, and what has not

Status on 2026-10-22. Two kinds of check:

- **The real run, 2026-10-21**: the owner's first run, on a real Hetzner account, the Farcaster
  mainnet and OP Mainnet. The node's timeline is in
  [runs/2026-10-21-hetzner-cpx42.md](runs/2026-10-21-hetzner-cpx42.md).
- **Local checks** (everything under "Verified locally"), run on 2026-10-21 on one laptop:
  macOS 15.7.7, `/bin/bash` 3.2.57 with `LANG=en_US.UTF-8` (what a macOS terminal sets),
  Node 24.12.0, OpenSSH 9.9p2, curl 8.7.1, jq 1.7.1, shellcheck 0.11.0. Each command ran with
  `THREECAST_HOME` set to a fresh empty directory. These checks submitted nothing to a Farcaster
  node, created no cloud resources, spent no money and used no real recovery phrase or key. The
  only phrase typed in was a throwaway one generated for the test, with no account behind it.

## Real run, 2026-10-21

One run of each, by the owner, on real accounts. No phrase or key from it appears here.

| What | Command | Result |
|---|---|---|
| Rent a server on a real Hetzner account | `./threecast up --provider hetzner` | A new account, billed in USD. Hetzner asked for a $25 prepayment to verify it, instead of an ID. `up` then created a cpx42 (8 vCPU, 16 GB) and a 1000 GB volume, and first boot mounted the volume (984 GiB usable). Price: $0.2553 an hour. |
| Restore the snapshot | `./threecast node` | 3 h 12 min: shard 0 in 13 min (37 GiB), shard 1 in 66 min (261 GiB), shard 2 in 113 min (259 GiB). Every chunk's MD5 matched its ETag, with no retries. 19 MB/s in the first minute, then 50 to 72 MB/s. |
| Install | the same run | 51 s, unattended, through the official `snapchain.sh`. snapchain 0.14.3. |
| Catch up to the sync gate | the same run | 6 h 57 min. Shard 2's snapshot was about 26 h old when the node started (94,660 s behind), and the node closed that gap at about 3.8 s of chain per second. |
| From `node` to synced, in all | the same run | 10 h 10 min, $2.60 at $0.2553 an hour. After sync, 557 GiB used of 984 GiB. |
| Register a test account on OP Mainnet | `./threecast new-account` | Quoted 0.00008140279551241 ETH (about $0.20) for an account with one storage unit, plus at most 0.0000023004773 ETH of gas, and asked for at least 0.000084 ETH. Registered FID <fid> with one storage unit. The node had its IdRegister event and its storage unit within about a minute; `onChainIdRegistryEventByAddress` answered in 8 ms. |
| Authorize an app key: the gasless KEY_ADD, relayed through our read node | the login step of `new-account` | `fidAddressType` confirmed the custody address, `storageLimitsByFid` returned 1 unit, `signersByFid` gave next nonce 1. The KEY_ADD went to `http://127.0.0.1:13381` (the SSH tunnel to the node) as `POST /v1/submitMessage`, was accepted for relay, and `/v1/signer` returned the key as active 3 s later. The app key was saved to `~/.threecast/accounts/<fid>.json`, mode 600. |

This settles several rows that used to be under "Not verified yet": the real Hetzner API for
`up`, first boot and the volume mount, the SSH tunnel through real OpenSSH, `node.sh`,
`restore.sh` and `synced.sh` on Ubuntu 24.04 with systemd, the unattended `snapchain.sh`,
restore throughput, sync time, `new-account`, and the KEY_ADD's relay and merge.

### Writes, 2026-10-22, FID <fid> through our own node

| Write | What the client printed | Checked on Farcaster's public node (snap.farcaster.xyz) |
|---|---|---|
| Cast | `✓ Cast <fid>:0x… (CAST_ADD): your node serves it.` | `castById` returns the `MESSAGE_TYPE_CAST_ADD` |
| Follow FID 37 | `✓ Followed FID 37 (LINK_ADD): your node serves it.` | `linkById` returns the `MESSAGE_TYPE_LINK_ADD` |
| Recast | `✓ Sent a recast on 37:0x… (REACTION_ADD): your node serves it.` | `reactionById` returns the `REACTION_TYPE_RECAST` |

All three went laptop → SSH tunnel → our read node → gossip → validators → block, and came back on both nodes.

## Verified locally

### The bash side, through the real entrypoint

| What | Command | Result |
|---|---|---|
| Help for every command | `./threecast help`, then `./threecast <cmd> --help` for all 22 commands | All print usage and exit 0. Every line fits 80 columns. |
| Rent a server, Hetzner (mock API) | `HCLOUD_API=<mock> HCLOUD_TOKEN=<test token> THREECAST_TEST_SKIP_REMOTE=1 ./threecast up --provider hetzner --yes` | SSH key, firewall, volume, server and its two IPs created. Target saved with mode 0600. Cost table shown before creating. |
| The same, interactively | `./threecast up` in a pseudo-terminal: menu `1`, token typed at the hidden prompt, `y` to save it, `y` to create | Same result. The token file is 0600. The terminal still echoes afterwards. |
| Status of a server that cannot be reached | `./threecast status` (the mock's address, 203.0.113.7, does not route) | After the 10 s SSH timeout: `✗ Cannot reach 203.0.113.7 over SSH.` with a next step. Exit 1, no stack of errors. `./threecast node` says the same. |
| Delete everything, Hetzner (mock) | `./threecast down --yes`, and `./threecast down` typing the name | Server, volume, firewall, both IPs and the SSH key deleted. The mock reports 0 billable resources left. Target forgotten. |
| Rent and delete, DigitalOcean (mock) | `DO_API=<mock> ./threecast up --provider digitalocean --yes`, then `./threecast down --yes` | Droplet, volume, firewall and key created, then all deleted. 0 left. |
| Commands with no server set up | `./threecast node`, `status`, `ssh`, `down`, `client`, `feed --as 3` | Each says what is missing and what to run. `feed` and `client` also show how to read through the public node meanwhile. |

### The client, read-only against Farcaster's public node

The node was `https://snap.farcaster.xyz:3381`. It reported snapchain 0.14.2 with all 3 shards current.

| What | Command | Result |
|---|---|---|
| Home feed | `THREECAST_NODE=… ./threecast feed --as 3 --limit 5` | 5 casts out of 740 recent ones, from the 79 accounts FID 3 follows. Each cast is tagged with its app. |
| App breakdown | `./threecast apps --as 3` | Farcaster 79, own key 17, Firefly 4. The example commands it suggests include `--as 3`, so they work as shown. |
| Filters | `./threecast feed --as 3 --app farcaster --limit 3`; `--not-app farcaster --limit 3` | The first shows only Farcaster casts. The second shows only the others. |
| Profile | `./threecast profile @dwr --as 3 --node https://snap.farcaster.xyz:3381` | Name, bio, follow count and 5 latest casts. |
| Writing in read-only mode | `./threecast cast "x" --as 3`, `./threecast like 1 --as 3` | Refused before anything is signed: `--as only reads (feed, apps, profile); cast signs with your own app key.` Exit 1. |
| Output piped into `head` | `./threecast feed --as 3 \| head -2`, `./threecast feed --help \| head -1` | Exits quietly. (Before the fix it printed a Node EPIPE stack trace.) |
| `client` with no account | `./threecast client` with `THREECAST_NODE` set and no TTY | Checks sync, says the laptop has no app key, prints the TEST-account warning, then explains that it needs a terminal or `--phrase-file`. |
| Login with a phrase that has no account | `./threecast client --phrase-file <0600 temp file>`, and the same phrase typed at the hidden prompt in a pseudo-terminal | `12 words, checksum valid`, custody address, then `✗ No FID is registered to 0x…` with four next steps, including `./threecast new-account`. No word of the phrase appears in the output. Nothing is written to `accounts/`. The temp file was deleted afterwards. |
| Node not synced | `./threecast client --node <fake node 3 h behind>` | Explains that logging in needs a synced node, and shows how to read from the public node meanwhile. `login` refuses with `still syncing`. |
| Node not answering behind the tunnel | `THREECAST_NODE=http://127.0.0.1:<port that accepts and hangs up>` | `closed the connection without answering`, plus a hint that the node on the server is usually not running yet, and to run `./threecast status`. |

### The web client, read-only

Started with `THREECAST_NO_OPEN=1 ./threecast web --as 3 --node https://snap.farcaster.xyz:3381`.

| Check (curl) | Result |
|---|---|
| Listens on | 127.0.0.1:4040 only |
| `/api/session`, `/api/node`, `/api/feed`, `/api/apps`, `/api/profile` with the page's token | 200 |
| Any `/api/*` route without the token, or with a wrong one | 403 |
| `Host: evil.test` on `/` and on `/api/*` | 403 |
| `Origin: https://evil.test` on a POST | 403 |
| POST with `text/plain` | 415 |
| POST `/api/cast` in read-only mode | 400, with a hint to leave out `--as` |
| GET on a POST route | 405 |
| `../` path traversal | 404 |
| `Access-Control-*` headers | none |
| CSP | `default-src 'self'`, `frame-ancestors 'none'`, plus `X-Frame-Options: DENY` |
| In a browser | Renders 20 posts and the app filter, with no console errors. |

### Test suites and lint

| Suite | Command | Result |
|---|---|---|
| Provisioning (mock Hetzner and DigitalOcean APIs, fake ssh) | `/bin/bash tests/provision/run.sh` | 28/28 pass |
| Node scripts, including the partial restore from the real public bucket | `/bin/bash tests/node/run.sh --live` | 174 ok, 0 FAIL. The first 3 chunks of shard 0 match the bucket's ETags (`6a036c13…`, `82ae3244…`, `07e9814e…`) and decompress into one tar stream. |
| Client unit tests | `cd client && npm run typecheck && npm test` | typecheck clean; 119 tests: 108 pass, 0 fail, 11 skipped (the live ones). Rerun 2026-10-22. |
| Client against the public node | `cd client && THREECAST_LIVE=1 npm test` | 119/119 pass (2026-10-22) |
| Lint | `shellcheck -x threecast lib/*.sh provision/*.sh tests/provision/{run.sh,tc.sh,bin/ssh}`; `shellcheck -x -s bash node/*.sh tests/node/*.sh` | clean, all 22 bash files |
| bash 3.2 parse | `/bin/bash -n` on every bash file | clean |

## Not verified yet

None of these has been run for real.

| What | Why it is not verified | How it will be checked |
|---|---|---|
| Writes not yet run for real: reply, delete, like/unlike, unrecast, unfollow | Not run yet. They use the same message types as the cast, follow and recast below, and their bytes are checked against `@farcaster/core` validation in the unit tests. | Use them once from `./threecast client`. |
| `./threecast login` with an existing account's phrase, end to end | Its parts ran separately: the phrase and the FID lookup against the public node (above), the KEY_ADD and its merge inside `new-account`. | Log in with a TEST account against your own synced node, then run `./threecast whoami`: it should show `active`. |
| Logout's self-revoking KEY_REMOVE | Not run for real yet. | `./threecast logout`, then the key should be gone from `/v1/signer`. |
| `down` against the real Hetzner API | Not run yet. The mocks follow the published API spec. | `./threecast down`, then check in the console that nothing is left. |
| The real DigitalOcean API | No token was used. Account limits, stock, error wording and timing can differ from the mock. | `./threecast up --provider digitalocean` and `./threecast down` with a real token. |
| Your own server (`up --host`) | Tested only with mocks and a fake ssh. | `./threecast up --host user@ip` on an Ubuntu or Debian server, then `./threecast node`. |
| A second account made in the Farcaster app, and the menu labels for its phrase (Settings → Advanced) | The labels come from an older Farcaster help page. Whether a second account costs money is not known. | Add a second account in the app and reveal its account phrase. |
| Clock-skew warning on a bare snapchain node | It reads the node's `Date` header, seen only on snap.farcaster.xyz, which sits behind a proxy. | `./threecast client` against your own node: the node line in the web client shows the skew. |
| Linux as the laptop | Only macOS was used. | The three commands from a Linux laptop. |
| Web client auto-open, Safari, Firefox, a phone | Only Chrome on macOS was used. | Manual. |

## Known limits seen during the checks

- On a hidden prompt, anything typed or pasted before the `Phrase:` prompt appears is echoed by
  the terminal, as with any password prompt. Paste only once `Phrase:` is on screen.
- Progress lines from `up` that name API calls (for example `→ Creating the firewall: …
  (POST /firewalls)…`) are 89 to 110 columns wide. In an 80-column terminal they wrap. The help
  texts, the menu and the cost table fit in 80 columns.
- `./threecast client` checks that the node is synced, then `login` checks again, so the
  check is printed twice.
