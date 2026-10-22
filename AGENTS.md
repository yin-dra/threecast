# threecast: playbook for coding agents

For Claude Code, Codex and other agents setting up threecast, and for the humans who ask them.

## What this repo does

`./threecast up` rents a server (Hetzner, DigitalOcean) or registers the human's own over SSH. `./threecast node` restores the public Snapchain snapshot there and runs the official read node until it is in sync. `./threecast client` authorizes an app key for a TEST Farcaster account and opens a local client that reads, casts, likes, recasts and follows through that node.

## The rule: the agent runs the commands, the human holds the keys

The cloud API token, the Farcaster recovery phrase, the SSH keys and the money stay with the human. threecast reads the secrets at hidden prompts and shows the price before it spends. Balaji's warning about recovery phrases (treat pasting one like `rm -rf`: only into software from developers you trust) applies to agents: you are software, and once a secret is in your context nobody can see where it goes.

Never:

- ask for, or accept, a cloud API token, a recovery phrase or an SSH key passphrase in chat;
- print, write or pass one: no `HCLOUD_TOKEN=… ./threecast …`, no `--phrase-file` you made, no `env` or `printenv`;
- read `~/.threecast/credentials`, `~/.threecast/accounts/` (app keys, saved phrases), `~/.threecast/ssh/` or `~/.ssh`, or add keys to an ssh-agent;
- run `./threecast login` or `./threecast new-account`, or drive any threecast prompt with `expect`, `tmux send-keys`, `script` or another pty wrapper;
- run `./threecast up`, or skip a question on any command with `--yes`, `-y` or `THREECAST_YES=1`;
- send ETH or pay for anything, even with a wallet tool;
- run `./threecast down`: the human runs it and types the name. It deletes the server and the node's database, and rebuilding takes about 10 hours;
- leave a server running without telling the human its cost per hour and so far.

threecast's error hints are written for a person at a terminal. When one says `export HCLOUD_TOKEN=<token>`, `pass --phrase-file PATH`, `Re-run with --yes`, `add --yes` or `Run this in a terminal`, do none of it: stop and hand that command to the human.

"The human's own terminal" is a window outside your session, not your shell and not Claude Code's `!` prefix: whatever runs through your session lands in the conversation log, and `new-account` prints its phrase on screen. Do not read that terminal during Gate 2.

If the human pastes a token or a phrase into the chat anyway: stop, do not use or repeat it, and tell them it is now in the conversation log. A token: revoke it in the provider's console and make a new one. A phrase: treat that account as exposed and use a fresh test account (`./threecast new-account`, in their terminal).

If `[ -n "${HCLOUD_TOKEN:-}${DIGITALOCEAN_TOKEN:-}" ] && echo set` prints `set`, a token is in your environment and every command you run can read it. Do not print it. Tell the human, and ask them to unset it and start you again from a shell without it.

## Where to run

On the human's machine, as their user: threecast keeps its state in `~/.threecast` (or `THREECAST_HOME`), and the human's prompts write there. Your shell needs outbound SSH (port 22) and HTTPS, and write access to that directory. Codex's default sandbox has neither network access nor writes outside the repo: ask the human to allow both for this task. A cloud agent (Codex cloud, Claude Code on the web) cannot do this setup: it shares neither the human's `~/.threecast` nor their terminal.

Use the human's `THREECAST_HOME` and `--name`; by default neither is set. Look at no other name: each command that loads a server makes it the default for the human's next `node`, `ssh` or `down`.

Plain `./threecast node` watches for hours, and your shell's timeout kills it. Wherever threecast's output says `./threecast node`, run `./threecast node --detach`.

## Preflight (you may do this)

```sh
uname -s                          # Darwin or Linux; anything else: stop and tell the human
git --version; jq --version; curl --version | head -n 1
command -v ssh scp ssh-keygen npm
node -p 'process.versions.node'   # 24 or newer
```

Suggest installs; ask before running them. macOS: `brew install git node jq`. Debian/Ubuntu: `sudo apt-get install -y git jq curl openssh-client`, then `nvm install 24` (apt's Node is too old). Then:

```sh
git clone https://github.com/yin-dra/threecast.git && cd threecast
(cd client && npm ci --omit=dev --no-audit --no-fund --loglevel=error)
```

The `npm ci` is what threecast runs on first use anyway. Done now, its output never lands in front of a `--json` read.

## The sequence

### Gate 1: the human runs `./threecast up`

They run `./threecast up` from the repo, in their own terminal. It asks where the node should run, takes the API token at a hidden prompt, shows the cost (about €5/day on Hetzner, $6.13/day on a USD account, $7/day on DigitalOcean, before VAT, until `down`), and creates nothing until they type `y`. Their own server (`--host user@ip`) needs no token and rents nothing. Tell them before they start:

- Type the token at the prompt. Do not export `HCLOUD_TOKEN` or `DIGITALOCEAN_TOKEN` in a shell the agent runs in or was started from.
- Answer `n` when `up` offers to save the token. A saved token lets any program in their account, an agent included, rent or delete servers with `--yes`. If they saved one before, they can delete its line from `~/.threecast/credentials`.
- `up` ends with `Next: ./threecast node`. They can stop there and tell you. If they run it anyway, it starts the same unit, and `--detach` then says it is already running.

Wait until they say it finished. Then `./threecast status --json` shows `"phase": "not-started"` and exits 1 with `error` null: Gate 1 is done. From here on, read the setup only through `status --json`.

### You: start the node and watch it

```sh
./threecast node --detach     # copies the scripts, starts or resumes the unit threecast-node, exit 0
./threecast status --json     # one JSON object on stdout; the step line and ssh's errors on stderr
```

Poll every 10 to 15 minutes, not faster: each call is an SSH round trip. Restore takes about 3 hours, install about a minute, and catch-up about 1 hour for every 3.8 hours of the snapshot's age when the node starts (6 h 57 min from a 26 h old one; 10 h 10 min in all on the first real run, `docs/runs/2026-10-21-hetzner-cpx42.md`). Each report gives the phase, the progress, and `cost.so_far` and `cost.hourly` in `cost.currency` (`cost` is null on the human's own server). If you cannot wait in one session, say so and ask the human to have you check later; the node does not need you.

When `node --detach` or `status` prints `Next: ./threecast client`, that is Gate 2: hand it to the human. Do not run it.

Meanwhile, reads work through Farcaster's public node. Every read needs `--node`, and `feed` and `apps` also need `--as`:

```sh
./threecast feed --node https://snap.farcaster.xyz:3381 --as 3 --json
./threecast apps --node https://snap.farcaster.xyz:3381 --as 3 --json
./threecast profile @dwr --node https://snap.farcaster.xyz:3381 --json
```

Pass `--node` on each command. Do not export `THREECAST_NODE`: it would also send later writes and `client` to the public node instead of the human's.

### Gate 2: the human logs in

Once `status --json` exits 0 (login refuses earlier), the human runs one of these in their own terminal, with a TEST account, never their main one:

- `./threecast login`: an existing test account's phrase at the hidden prompt, pasted once `Phrase:` shows. It signs one gasless KEY_ADD for a new app key and does not save the phrase.
- `./threecast new-account`: a fresh test account. It shows a new phrase once, waits for about $0.20 of ETH on OP Mainnet at the address it prints, and asks before paying. The human sends that ETH from their own wallet.

Done when `./threecast whoami` shows `active` on its `On the network` line. If `whoami` fails with `Could not open the SSH tunnel`, ask the public node instead: `./threecast whoami --node https://snap.farcaster.xyz:3381`.

Do not run `./threecast client` before then: with no app key on this laptop, it starts `login` and opens the phrase prompt in your shell.

### You: read and write

```sh
./threecast feed --json                     # --app farcaster, --not-app self, --limit N, --replies
./threecast apps --json                     # which apps made the casts in the feed
./threecast profile @dwr --json
./threecast cast "hello from my own node"   # --reply-to REF
./threecast like REF    # also unlike, recast, unrecast, delete REF; follow, unfollow @name
./threecast client      # web client for the human on http://127.0.0.1:4040, runs until stopped
```

The first client command after Gate 2 opens the SSH tunnel and prints that step on stdout, ahead of the JSON. The Gate 2 `whoami` opens it for you; if `jq` still cannot parse a `--json` read, run the read again.

Writes are public and signed as the human: make only the casts, likes and follows they asked for, with text they approved. Use full refs (`fid:0xhash`, the `ref` field): `feed --json` does not record the numbers that `like 3` counts from. Start `client` only after Gate 2, in the background, and give the human its address; do not call its `/api` yourself.

### Gate 3: teardown

When the human is done, and before ending any session that leaves the server up, tell them the cost so far and per hour, and that billing runs until `down`. Offer `./threecast logout` first: it revokes the app key without the phrase, needs the node up, and you may run it once they agree. Then the human runs `./threecast down` in their own terminal and types the name. It deletes the server, volume, firewall, IPs and SSH key, and checks that nothing is left. On their own server it offers to stop the node, and deletes data only with `--purge`.

## What success looks like

| Step | Success |
|---|---|
| Gate 1 | `status --json`: `"phase": "not-started"`, `provider` and `host` set, `error` null, exit 1 (the one exit 1 that is good news) |
| `node --detach` | exit 0 and one of `starting  node.sh is starting on the server`, `✓ node.sh is already running on the server.` (then its status line), `✓ Your read node is in sync` |
| `status --json`, working | exit 3 through `preflight`; `restore` (`restore.shard` 0 to 2, `done`/`total` chunks, `mbps`, `eta_s` for the whole remaining restore, not only this shard); `install`; `catchup` (`shards[].delay_s` coming down) |
| `status --json`, synced | exit 0, `"synced": true`, `version` set, every `shards[].delay_s` 10 or less (shard 0 must also hold over 1,000,000 messages) |
| Every report | `cost` is before VAT; `disk.used_gb` and `disk.total_gb` are GiB; `log` is the path of node.log on the server, not its text |
| Gate 2 | `whoami` prints `FID n` and `active` on its `On the network` line |
| Reads | exit 0; `feed --json` is `{posts: [{ref, fid, hash, text, time, author, parent, embeds, app}], following, scanned, unread, futureDated}` |
| Writes | exit 0 and a `✓` line, e.g. `✓ Published 123:0xabcd…9f0e: your node served it back after 2.1 s.`; the full ref is on the `--reply-to` hint below it |
| `client` | `✓ Your web client is running at http://127.0.0.1:4040` (or the next free port). Without that line it did not start, even on exit 0 |

Every other exit from `status --json` is 1: branch on `phase` and read `error`.

## When something fails

| Output contains | You do | Hand to the human |
|---|---|---|
| `No server named '…' yet` | check that you run as their user, with their `THREECAST_HOME` and `--name` | Gate 1 |
| `API token found`, `export HCLOUD_TOKEN`, `export DIGITALOCEAN_TOKEN` | stop | Gate 1, the token at the prompt |
| `rejected the API token` | stop | a new token (Hetzner: Read & Write; DigitalOcean: Full Access). If it came from `credentials` or an environment variable, `up` will not ask: the human deletes that line or unsets the variable first. You do not edit that file |
| `Re-run with --yes`, `add --yes`, `Deleting needs a confirmation` | stop; never add `--yes`, `-y` or `THREECAST_YES=1` | that command, in their terminal |
| `sold out`, `sells none of these server types`, `No region threecast tried` | relay the options it prints | rerun `up` with one of them |
| `left from an earlier run` | stop: those resources bill | `./threecast down --provider P --name N` |
| `Cannot reach … over SSH` (phase `unreachable`, or from `node --detach`) | rerun the command that failed (`status --json` or `node --detach`) at the next poll | after 30 minutes: the provider's console (a stopped server still bills) |
| `refused the SSH login`, `Permission denied`, `SSH host key of` | stop; never ask for a key or a passphrase | SSH access: `./threecast ssh` shows the same error |
| `Could not open the SSH tunnel` | `status --json`, and follow its row; reads meanwhile with `--node https://snap.farcaster.xyz:3381` | |
| phase `not-started` after Gate 1 | `./threecast node --detach` | |
| phase `error`: `node.sh stopped during`, `no longer running`, `not answering on 127.0.0.1:3381` | `./threecast node --detach` once; it resumes and keeps restored shards | `error` and the log's last lines, if it fails again |
| phase `error`, any other message (`Not enough free space`, `volume is not mounted`, …) | do not retry; get the log's last lines with `./threecast ssh tail -n 30 <log>` (`sudo -n tail` when the login user is not root) | `error` and those lines |
| `no terminal to type the phrase into`, `new-account needs a terminal` | stop: that was a human gate | Gate 2 |
| `You are not logged in`, `Not logged in.`, `You need to log in` | for a read, add `--as FID`; never run `login` | Gate 2 |
| `Your node is still syncing` | wait for `status --json` to exit 0 | Gate 2, then |
| `No FID is registered to`, `has no storage units`, `looks like a wallet phrase` | relay the hint | `login` with the right phrase, or `new-account` |
| `is not active`, `expired` | right after login, retry once a minute later | `./threecast login` |
| `This laptop's clock is` | relay | turn on automatic date and time |
| `has not shown up after two minutes` (exit 1) | do not resend. A minute later: a cast or delete shows in `profile <their fid> --json`, a follow or unfollow in `followedByViewer` of `profile USER --json`; no read shows likes or recasts | that it may still land |
| `Nothing is listening at`, `closed the connection without answering` | `status --json`: the node is not up yet | |
| `jq` cannot parse a `--json` read | run it again: the first run printed setup lines (npm, the SSH tunnel) on stdout before the JSON | |

`THREECAST_DEBUG=1` adds stack traces to unexpected errors. Read-only looks at the server are fine (`./threecast ssh df -h`, `./threecast ssh tail -n 30 <log>`); changing anything there needs the human's go-ahead.

## Paste this to your agent

```text
Clone https://github.com/yin-dra/threecast and set up my Farcaster read node and client by following AGENTS.md. Stop at every human gate.
```

Changing threecast's code instead: `DESIGN.md` is the contract between the pieces, and `docs/VERIFICATION.md` lists what has been run.
