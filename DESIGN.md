# threecast — design contract

This file is the contract between the pieces of threecast. If code and this file disagree, fix one of them in the same change.

Protocol facts were researched on 2026-10-21 against snapchain v0.14.3 and @farcaster/core 0.20.0, in the source first and live nodes second. What has and has not been run for real is in `docs/VERIFICATION.md`.

## What threecast is

Three commands that give a developer their own Farcaster stack:

```
./threecast up       # (0) rent a server (Hetzner, DigitalOcean) or register your own over SSH
./threecast node     # (1) restore the public snapshot, start an official Snapchain read node, wait for sync
./threecast client   # (2) authorize an app key from a TEST account's phrase, open the local client
```

Everything runs from the developer's laptop (macOS or Linux). The server only ever runs the node. The recovery phrase never leaves the laptop. `login` never writes it to disk; only the new Ed25519 app key is stored. The one exception is `new-account`, below.

## Layout

```
threecast                  entrypoint (bash, must run on macOS /bin/bash 3.2)
lib/common.sh              shared helpers: output, prompts, targets, ssh. Owned by the lead.
lib/up.sh                  cmd_up, cost table, rollback, BYO checks   (provision)
lib/down.sh                cmd_down                                    (provision)
lib/remote.sh              cmd_ssh, tunnel_up, tunnel_down, tunnel_url (provision)
lib/node.sh                cmd_node, cmd_status                        (node)
lib/client.sh              cmd_client, client_passthrough              (client)
provision/hetzner.sh       hz_* functions, sourced by lib/up.sh and lib/down.sh
provision/digitalocean.sh  do_* functions
provision/cloud-init.yaml  template, __VOLUME_DEVICE__ replaced at create time
node/                      runs ON THE SERVER as root (Ubuntu 24.04, bash 5): node.sh, restore.sh, synced.sh
client/                    TypeScript, Node >= 24 (native type stripping, no build step)
site/                      the tutorial microsite (static, GitHub Pages)
tests/                     shell + mock tests for the bash side
docs/VERIFICATION.md       what was run, on what, with what result
```

Local bash (everything except `node/`) must be bash 3.2 compatible: no `mapfile`, no associative arrays, no `${var,,}`, no `|&`, no `declare -n`. `node/` may use bash 5. Every script: `set -euo pipefail`, shellcheck-clean.

## Targets (one node = one target)

- State dir: `$TC_HOME` = `${THREECAST_HOME:-$HOME/.threecast}` (mode 700), with `targets/ accounts/ cache/ run/ ssh/`.
- Target file: `$TC_HOME/targets/<name>.env`, mode 600, `KEY=value` lines (values `%q`-quoted), sourced by `load_target`. Written only via `target_set KEY VALUE`.
- Name: default `threecast`; `--name NAME` (accepted anywhere on the line, for every command) or `THREECAST_TARGET` overrides; `$TC_HOME/current` remembers the last one used. Names match `^[a-z]([a-z0-9-]{0,38}[a-z0-9])?$`, because they end up in hostnames, cloud labels, volume names and file paths.
- Keys every target has: `NAME PROVIDER(hetzner|digitalocean|byo) HOST SSH_USER SSH_KEY DATA_DIR CREATED_AT TUNNEL_PORT PUBLIC_API(0|1)`.
  - `CREATED_AT` is Unix seconds (`date +%s`). `status` also reads ISO 8601 UTC, which older files may hold.
  - `SSH_KEY` is empty for a BYO target without `--key`: ssh then uses the agent and `~/.ssh`.
- Provider keys: `HZ_SERVER_ID HZ_VOLUME_ID HZ_FIREWALL_ID HZ_SSH_KEY_ID HZ_SSH_KEY_OWNED(0|1)`, `DO_DROPLET_ID DO_VOLUME_ID DO_FIREWALL_ID DO_SSH_KEY_ID DO_SSH_KEY_OWNED(0|1)`, and for both `PRICE_HOURLY PRICE_CURRENCY` (the estimate shown before creating).
- BYO only: `SUDO=sudo` when the login user is not root and has passwordless sudo. Absent means root, or (for files without it) `sudo -n` for a non-root user.
- SSH key for rented servers: `$TC_HOME/ssh/id_ed25519` (generated). BYO uses the user's own key or agent unless `--key PATH` is given.
- Known hosts: `$TC_HOME/known_hosts` with `StrictHostKeyChecking=accept-new`. `up` and `down` remove the host's old entry, because providers reuse IP addresses.
- Cloud API tokens: `HCLOUD_TOKEN` / `DIGITALOCEAN_TOKEN` from the environment, else `$TC_HOME/credentials` (mode 600, `VAR=token` lines), else a hidden prompt. A pasted token is offered for saving only after the provider has accepted it, and never with `--yes`.

## Rented servers: what gets created, and how `down` finds it

Created after a cost table and a confirmation (`--yes` skips it), in this order. Hetzner: SSH key, firewall, volume, server. DigitalOcean: SSH key, volume, Droplet, then the firewall around the Droplet.

| | Hetzner | DigitalOcean |
|---|---|---|
| How `down` finds them | label `threecast=<name>` on every resource | tag `threecast:<name>` on Droplet and volume; firewall and SSH key by name (DO cannot tag them) |
| Server | `<name>`, first of `cpx42 ccx23 cax31 cx43` for sale, `ubuntu-24.04` | `<name>`, `s-8vcpu-16gb`, `ubuntu-24-04-x64` |
| Locations tried, in order | `fsn1 nbg1 hel1`; `--location any` adds `ash hil sin` | `fra1 ams3 lon1 nyc3 sfo3`; `any` adds every region |
| Volume | `<name>-data`, ext4, mounted by cloud-init at `/root/snapchain` | `<name>-data`, same mount |
| Firewall | `threecast-<name>` | `threecast-<name>` |
| SSH key | `threecast-<name>` (`threecast-<name>-<unix time>` if that name is taken) | `threecast-<name>` |
| IP addresses | labelled after create, `auto_delete: true` | part of the Droplet |

- A key already in the account with the same fingerprint is reused, recorded as `*_SSH_KEY_OWNED=0`, and never deleted.
- Volume size: `--volume-size GB`, default 1000, minimum 10; under 700 asks first. Server type: `--server-type T` overrides the list above.
- Before creating, `up` refuses if anything already carries the label/tag/name for `<name>`.
- Rollback: from the first billable resource until the target is saved, any exit (error, Ctrl-C, closed terminal, SIGPIPE) deletes everything this run created, then removes the half-written target.
- `down` (rented): lists what carries the label/tag/name, asks you to type the name (`--yes` skips), deletes servers first, then volumes, firewalls, IPs and owned keys, and checks again. If anything is left the target is kept for another try. `down --provider hetzner|digitalocean --name N` does the same for a name with no saved target (an interrupted `up`).
- `down` (BYO): offers to stop the node (systemd unit, `docker compose down`, the autoupgrade cron line), then forgets the target. `--purge` also deletes `DATA_DIR` after typing the name, and only a path at least two levels deep.

## Network exposure (deliberate)

Cloud firewall (outside the VM, because Docker-published ports bypass ufw):
- open: `22/tcp`, `3382/udp` (gossip, QUIC) to the world.
- closed by default: `3381/tcp` (HTTP API), `3383/tcp` (gRPC), `3000` (Grafana, admin/admin), `8125/udp`, `8126/tcp` (statsd).
- `up --public-api` additionally opens `3381/tcp` to the world. On a BYO server it only prints a warning: the user owns that firewall.

The client reaches the node through an SSH tunnel: `127.0.0.1:$TUNNEL_PORT` → server `127.0.0.1:3381`. `TUNNEL_PORT` defaults to 13381; if that port is busy on the laptop, `tunnel_up` takes the next free one (up to 99 above) and saves it. Managed by `tunnel_up/tunnel_down` with an ssh control socket in `$TC_HOME/run/<name>.sock` (stderr in `run/<name>.tunnel.log`). `tunnel_url` prints `http://127.0.0.1:$TUNNEL_PORT`. Rationale for the tutorial: nobody else can read from or relay writes through your node, your laptop's IP can change freely, and the traffic is encrypted.

## Server layout

- Data: `DATA_DIR`, default `/root/snapchain` (the volume's mount point on rented servers; compose bind-mounts `.rocks` relative to it). BYO: `--data-dir DIR`, absolute, `[A-Za-z0-9._/-]` only, should have at least 700 GiB free (less asks first).
- threecast's scripts: `/root/threecast/{node.sh,restore.sh,synced.sh}` (a sudo user stages them in `~/threecast-node/` first).
- `node.sh` runs detached as the systemd unit `threecast-node` (`systemd-run --collect`, env `DATA_DIR`, optional `OPERATOR_FID`), so closing the laptop never kills a multi-hour restore. Re-running `./threecast node` re-attaches, or resumes where it stopped.
- `snapchain.sh` comes from the `@latest` tag into `DATA_DIR/snapchain.sh`. threecast answers its two questions in `DATA_DIR/.env`: `AGREE_NO_REWARDS_FOR_ME=true`, `HUB_OPERATOR_FID` (from `OPERATOR_FID`, else 0 plus `SKIP_CRONTAB=true`, and threecast writes the weekly `snapchain.sh autoupgrade` cron line itself).
- Snapshot chunks wait in `/var/tmp/threecast-chunks` (local disk, not the volume).

`DATA_DIR/.threecast/`:

| File | Written by | Meaning |
|---|---|---|
| `status.json` | node.sh, restore.sh | the current phase, one JSON object (below) |
| `node.log` | node.sh | everything node.sh and restore.sh print |
| `shard-0.done`, `shard-1.done`, `shard-2.done` | restore.sh | that shard unpacked cleanly; holds the snapshot key, or `adopted` for a database that was already there |
| `install.done` | node.sh | `snapchain.sh upgrade` printed `Upgrade complete.` |
| `upgrade.log` | node.sh | output of `snapchain.sh upgrade` |

`status.json`, always with `phase` and `updated` (Unix seconds):

```
preflight | install | error        {phase, message, log, updated}
restore (from restore.sh)          {phase, shard, done, total, bytes, mbps, eta_s|null, key, updated}
catchup | synced (synced.sh)       {phase, synced, reason?, version, shards: [{id, maxHeight, blockDelay, numMessages}], log, updated}
```

`restore` and `catchup` also appear in the first form, with a `message`, until restore.sh or the node has something to report.

In sync means the same thing everywhere (`node/synced.sh`, `hub.ts readStatus`): shards 0, 1 and 2 are reported, each `blockDelay` is at most 10 s, and shard 0 holds over 1,000,000 messages (a node whose shard 0 replays from genesis answers every write with "unknown fid", snapchain #1044).

## Client

- Node base URL precedence: `--node URL` flag > `THREECAST_NODE` env > the target's tunnel (`lib/client.sh` brings the tunnel up and exports `THREECAST_NODE`). With no target and no node, read commands print how to read through `https://snap.farcaster.xyz:3381 --as 3` meanwhile.
- Viewer: the logged-in account, or `--as FID` on read commands (`feed`, `apps`, `profile`, `web`), which is read-only. Any write command given `--as` refuses before signing.
- Accounts: `$TC_HOME/accounts/<fid>.json` mode 600: `{ fid, custodyAddress, appKeyPrivate, appKeyPublic, nonce, requestFid, createdAt }` (`createdAt` in Unix ms). `$TC_HOME/accounts/current` holds the active fid.
- Caches in `$TC_HOME/cache/`: `attribution.json` (signer → app; onchain entries forever, gasless daily, unknown hourly), `names.json` (name → fid and fid → profile, a day), `last-feed.json` (so `like 3` means item 3 of the last printed feed).
- The phrase is read from a hidden TTY prompt or `--phrase-file PATH`. Never argv, never env. `login` never writes it.
- Exception: `new-account` generates a phrase, shows it once, then asks whether to save it. Only on an explicit yes it writes `$TC_HOME/accounts/<address>.phrase` (mode 600), so a run stopped before paying can resume with `--phrase-file`. It needs a terminal for both the phrase and the question.
- Mentions on write: each `@name` (an fname, or a name ending in `.eth`) at the start of the text or after a space, bracket or quote is looked up with `userNameProofByName`. Known names are removed from the text and stored as `mentions` (fids) plus `mentionsPositions` (UTF-8 byte offsets into the remaining text), at most 10 per cast; `insertMentions` reverses this on read. Unknown names, and names past the tenth, stay in the text as typed, with a warning. The 320/1024-byte limits count the text without the mentioned names.
- Future-dated casts: a cast dated more than 10 minutes after the node's clock (laptop clock corrected by the node's `Date` header) is left out of the home feed and of profiles, and counted (`futureDated`), so it cannot lead every feed. Mainnet has one dated 2061 (FID 347).
- Local web client: `http://127.0.0.1:4040`, or the next free port up to 4049, bound to 127.0.0.1 only. Every `/api/*` request must carry `X-Threecast-Token: <random per process>` (the page gets it from the server-rendered HTML), the `Host` header must be `127.0.0.1:<port>` or `localhost:<port>` (DNS rebinding), a present `Origin` must be this server, writes must be `application/json` up to 16 KiB, and no CORS headers are ever sent. This blocks other websites from posting as you. `THREECAST_NO_OPEN=1` skips opening the browser.
- Web API (all over `api.ts`, the same functions the CLI uses): GET `/api/session`, `/api/node`, `/api/feed`, `/api/apps`, `/api/profile?user=`, `/api/user-casts?user=`, `/api/reactions?refs=fid:0xhash,…` (at most 100); POST `/api/cast`, `/api/react`, `/api/follow`, `/api/delete`. Writes take full `fid:0xhash` refs only. App filter words are `filterWord` from `api.ts`, the same words `--app` takes (`#/?app=farcaster`).
- When the session can write, the page asks `/api/reactions` about the posts it has just drawn (once per cast, after they render), so Like and Recast show whether you already did. Each cast costs two `reactionById` reads, under the same per-node cap of 6 requests in flight as every other read. The CLI does not ask.

## CLI surface

```
./threecast up [--provider hetzner|digitalocean] [--host user@ip] [--key PATH] [--data-dir DIR]
               [--location L] [--public-api] [--server-type T] [--volume-size GB] [--name N] [--yes]
OPERATOR_FID=N ./threecast node [--name N] [--detach]   start or re-attach; idempotent
./threecast status [--name N] [--json]
./threecast ssh [--name N] [cmd...]
./threecast down [--name N] [--provider hetzner|digitalocean] [--purge] [--yes]
./threecast client [--node URL] [--phrase-file PATH] [--account-index N]
./threecast login [--phrase-file PATH] [--account-index N] | new-account [--recovery ADDRESS] [--phrase-file PATH] [--rpc URL]
./threecast whoami | logout
./threecast feed [--app LIST] [--not-app LIST] [--unknown include|exclude] [--replies] [--limit N] [--as FID] [--json]
./threecast apps [--limit N] [--replies] [--as FID] [--json]
./threecast profile USER [--limit N] [--replies] [--as FID] [--json]
./threecast cast "text" [--reply-to REF]
./threecast delete REF | like REF | unlike REF | recast REF | unrecast REF
./threecast follow USER | unfollow USER
./threecast web [--as FID]            the local web client alone (client runs it for you)
```
Every client command also takes `--node URL`. `REF` = `fid:0xhash` or a number from the last feed. `USER` = `@fname`, `fname`, `name.eth` or a numeric fid. `LIST` = comma-separated app fids or words (`farcaster`, `base`, `self`, `unknown`, ...). `--json` prints what `api.ts` returns (for `profile`: the profile with `casts` and `futureDated` added).

`ping` is internal (`lib/client.sh` runs `node client/src/cli.ts ping`): exit 0 when the node is synced, 3 when it answers but is still syncing, 1 when it cannot be reached.

`node --detach` does what `node` does up to the point where it would follow: it copies the scripts and starts (or resumes) the unit, then prints one status line and exits 0. If the unit is already running it says so, prints that line, and exits 0. Already in sync: the same success message as `node`, exit 0.

`status --json` prints one JSON object on one line, and nothing else, on stdout (the step line goes to stderr):

```
{name, provider, host, phase, synced, restore: {shard, done, total, mbps, eta_s} | null,
 shards: [{id, height, delay_s, messages}] | null, disk: {used_gb, total_gb} | null,
 version: string | null, cost: {currency, hourly, so_far} | null, error: string | null, log: string | null}
```

- `phase`: `synced` when the live check (`synced.sh`) says so; else `error` when `status.json` says so; else, while node.sh runs, its phase (`preflight` before its first status.json); else `catchup` when node.sh has finished and the node answers but is behind; else `not-started` when there is no `status.json`; else `error` (node.sh stopped mid-way, or finished and the node no longer answers), with the command to run in `error`. `unreachable` when SSH fails. No target, or a target setting `node` would refuse: `error`, with the message `status` would print; `provider` and `host` are null without a target.
- Exit code: 0 `synced`; 3 `preflight`, `restore`, `install`, `catchup` (poll again); 1 everything else.
- `restore` is `status.json`'s restore progress (kept when node.sh stopped mid-restore). `shards` and `version` come only from the live check. `disk` is in GiB, as `df -h` counts, one decimal. `cost` is null for BYO, or without `CREATED_AT` or `PRICE_HOURLY`; `so_far` is rounded to cents, as `status` prints it. `log` is node.log's path on the server, null before node.sh first ran.
- Server text reaches the JSON only through `jq --arg` and `fromjson`; garbled `status.json` counts as none.

## Environment

`THREECAST_HOME`, `THREECAST_TARGET`, `THREECAST_NODE`, `THREECAST_YES=1` (same as `--yes`), `THREECAST_NO_OPEN=1`, `THREECAST_DEBUG=1` (stack traces for unexpected errors), `NO_COLOR`, `OPERATOR_FID`, `HCLOUD_TOKEN`, `DIGITALOCEAN_TOKEN`. Tests only: `HCLOUD_API`, `DO_API`, `THREECAST_TEST_SKIP_REMOTE=1`, `THREECAST_LIVE=1`, `THREECAST_LIVE_NODE`.

## Output voice

Short lines. Each step says what it does in protocol terms, once, e.g. `→ Asking your node which FID this address controls (IdRegistry)…`. `✓` for success, `!` for warnings, `✗` for errors followed by what to do next. No emoji, no banners, no colors when stdout is not a TTY. Errors name the fix, not just the failure. Help text fits 80 columns.

## Code style

Comments explain why, not what, and only where a reader would otherwise stumble (a protocol quirk, a non-obvious ordering). No commented-out code, no TODO litter, no decorative headers. Small files, plain names. MIT header line at the top of each script: `# threecast — MIT License`.

## Licensing boundary

Snapchain is GPL-3.0. threecast is MIT. Never copy snapchain files (compose, validators.toml, snapchain.sh) into this repo; fetch them from the `@latest` tag at install time. Do not copy code from other bounty entries.
