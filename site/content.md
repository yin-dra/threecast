---
title: threecast
description: Your own Farcaster read node and client, in three commands. MIT licensed.
---

# threecast

Your own Farcaster read node and client, in three commands. MIT licensed, by @thisiscryptome.

```sh
./threecast up
./threecast node
./threecast client
```

- `up` (step 0): rent a server, or use your own.
- `node` (step 1): restore the snapshot, run a read node, wait for sync.
- `client` (step 2): log in with a test account, open your client.


Farcaster is a social network whose posts live on Snapchain, a public chain anyone can follow by running a node. threecast runs one on a server you control, with a client on your laptop that reads and posts through it.

No Farcaster API key is needed. The only token is your cloud provider's, and your own server needs none.

Logging in takes the 12-word recovery phrase of a test account, never your main one. [Part 2](#2-before-you-start-your-recovery-phrase-is-root-access) explains why.

---

## With an AI agent

The agent runs the commands, you hold the keys: you type the cloud token and the recovery phrase yourself, at threecast's hidden prompts in your own terminal, and never paste either into a chat. The agent starts and watches the node, and hands you each command that asks for a secret or a yes: `up`, `login` or `new-account`, and `down`.

It starts the node with `node --detach` and checks `status --json` every 10 to 15 minutes; the node keeps running if you close the agent. After you log in, it can cast, like and follow as you, and the playbook allows only what you asked for. Answer `n` when `up` offers to save the token: a saved token lets any program in your account, the agent included, rent or delete servers. `down` asks for it again.

Paste this to a coding agent on your laptop, such as Claude Code or Codex:

```prompt
Clone https://github.com/yin-dra/threecast and set up my Farcaster read node and client by following AGENTS.md. Stop at every human gate.
```

[AGENTS.md](https://github.com/yin-dra/threecast/blob/HEAD/AGENTS.md) lists what the agent may run and where it stops for you.

---

## 1. What you need, and what it costs

### What you need

- **A Mac or Linux laptop** with git, Node.js 24 or newer, and jq ([Mac setup below](#installing-the-tools-on-a-mac)).
- **A place for the node**, one of:
  - Hetzner. A new account first verifies with an ID or a prepayment.
  - DigitalOcean. A new account must first reach resource tier 3: before `up`, Control Panel → Resource Limits → prepay $250 (credit for the bill), or Request an increase and wait.
  - Your own Ubuntu or Debian server: systemd, 4 cores, 16 GB of RAM, 700 GiB free, SSH key login as root or with passwordless sudo.
- **A TEST Farcaster account with storage**: a second account in the Farcaster app [UNVERIFIED: how to add one, and whether it costs money.], or `./threecast new-account` once your node syncs, about $0.20 of ETH ([part 5](#no-test-account-yet-new-account)).

No cloud account yet? Try Hetzner: on our new account, verified with a $25 prepayment, `up` created the server and volume. Since 2026-06-26 Hetzner restricts servers for new customers ([status](https://status.hetzner.com/incident/0a75c7ae-3377-41dc-aabe-601063724d24)), so if `up` is refused, use DigitalOcean.

In each new Terminal window, run `cd ~/threecast` first. Every command has `--help`.

### Installing the tools on a Mac

Open Terminal (Command-Space, type Terminal, Return) and run each line on its own. Homebrew asks for your Mac password, shows nothing as you type, and may first install Apple's Command Line Tools, which takes several minutes.

```sh
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

On an Apple-chip Mac (Apple menu → About This Mac shows Chip: Apple M…), the first two lines put `brew` on your PATH; on Intel, skip them. Node must be `v24` or higher.

```sh
echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
eval "$(/opt/homebrew/bin/brew shellenv)"
brew install git node jq
node --version
```

### What it costs

From the providers' price lists on 2026-10-21, before VAT. `up` shows yours, in your currency, before it creates anything.

| Where | Per hour | Per day | Per month, at most |
|---|---|---|---|
| Hetzner: cpx42 server, IPv4, 1000 GB volume | ≈ €0.2039 | ≈ €4.89 | ≈ €127.19 |
| Hetzner, the same, on our USD account | $0.2553 | ≈ $6.13 | |
| DigitalOcean: s-8vcpu-16gb Droplet, 1000 GiB volume | ≈ $0.2917 | ≈ $7.00 | ≈ $196.00 |
| Your own server | nothing extra | | |

The $250 prepayment is credit for the bill, not refunded, and expires after 18 months ([terms](https://www.digitalocean.com/legal/prepayments-and-resource-tier-terms)).

### How long it takes

| Phase | Time | Our run, 2026-10-21, Hetzner cpx42 |
|---|---|---|
| `up` | minutes | not timed; it waits at most 10 min for the server and 5 for SSH |
| Restore the snapshot | about 3 h | 3 h 12 min: shard 0 13 min, shard 1 66 min, shard 2 113 min |
| Install the node | about 1 min | 51 s, unattended, through the official `snapchain.sh` |
| Catch up | about 1 h per 3.8 h of snapshot age | 6 h 57 min, from a snapshot about 26 h old |
| **Total** | **about 10 h, less from an evening start** | **10 h 10 min** |

Our node closed the gap at about 3.8 s of chain per second, so catch-up takes about the snapshot's age when the node starts, divided by 3.8. Shard 1's snapshot is published around 16:00 UTC and shard 2's around 10:00 UTC, so a start in the UTC evening finds both recent ([run log](https://github.com/yin-dra/threecast/blob/HEAD/docs/runs/2026-10-21-hetzner-cpx42.md)).

---

## 2. Before you start: your recovery phrase is root access

### What the phrase controls

A Farcaster account is a number, its **FID**, owned by an Ethereum address, its **custody address**. The 12-word recovery phrase derives that address's private key. Whoever has it can transfer the account, change its recovery address, and add or remove app keys.

Balaji's advice for this bounty: treat a seed phrase like `rm -rf`, useful and with no undo.

1. **Use a test account only.**
2. **Enter a phrase only into software from developers you trust, or that you have read.** Here, that is [`client/src/account.ts`](https://github.com/yin-dra/threecast/blob/HEAD/client/src/account.ts).
3. **For a real account, use a delegated signer.** An app makes a key and you approve it in the Farcaster app, which keeps your phrase. threecast's app key is the same kind of key, but your phrase approves it, as the bounty asks for phrase import. Approval in the app is not built yet.

Type or paste the phrase only once `Phrase:` is on screen. Before that, the terminal shows what you type.

### Which phrase: the account phrase, not the wallet phrase

In the Farcaster app, signed in to the test account, Settings → Advanced shows the **account** recovery phrase. The **wallet** phrase beside it cannot authorize app keys. [UNVERIFIED: these menu labels come from an older Farcaster help page.] Base App accounts cannot log in this way.

### What threecast does with the phrase

It reads the phrase from a hidden prompt or a `--phrase-file`, never from the command line or the environment, derives the custody address (`m/44'/60'/0'/0/0`, the Farcaster app's path), signs one `KEY_ADD` on your laptop, and forgets it. The phrase is never written to disk or sent.

What threecast saves is the new app key, in `~/.threecast/accounts/<fid>.json` with mode 600. That key can cast, like, recast and follow, but cannot move the account or add keys. The server only sees signed messages.

---

## 3. Step 0: provision a server

You end with a server threecast can reach over SSH: rented, with a 1000 GB data volume and a firewall, or your own.

```sh
./threecast up
```

### What `up` does

- It asks where the node runs: Hetzner, DigitalOcean, or your own server (`--host root@203.0.113.7`).
- For a rented server it asks for an API token. Make one first:
  - Hetzner: [console.hetzner.com](https://console.hetzner.com) → open or create a project → Security → API tokens → Generate API token, Read & Write.
  - DigitalOcean: [cloud.digitalocean.com](https://cloud.digitalocean.com) → API → Generate New Token, Full Access.
- Paste it with Command-V, then Return; nothing appears. Answer `y` to saving it, since `down` needs it too; with an agent, answer `n` ([why](#with-an-ai-agent)).
- It shows the price and creates nothing until you answer yes.
- It creates an SSH key, a firewall, a 1000 GB volume and an Ubuntu 24.04 server, labelled for `down`, and waits for first boot to mount the volume. Keep the window open and the Mac awake until it prints `Next: ./threecast node`.
- If anything fails or is interrupted, it deletes what it created; run `up` again.
- On your own server it creates nothing: it checks the system over SSH and saves the address.

*The price check, against a mock of Hetzner's API with its real 2026-10-21 EUR prices. On our USD account, the real `up` created a cpx42 and a 1000 GB volume that day, at $0.2553 an hour.*

```text
  threecast would create, with cpx42 in fsn1:
    Prices in EUR, before VAT                  per hour   per month
    Server cpx42 in fsn1 (8 vCPU, 16 GB RAM)     0.1114   at most 69.49
    Public IPv4 address                          0.0008   at most 0.50
    Volume, 1000 GB for the database            ≈0.0917   57.20
    Total                                       ≈0.2039   ≈127.19
  About 4.89 EUR a day. Billing runs until you run ./threecast down.
  A stopped server still bills.
```

### The firewall

| Port | State | What it is |
|---|---|---|
| 22/tcp | open | SSH, for threecast and the tunnel |
| 3382/udp | open | Snapchain gossip from other nodes |
| 3381/tcp | closed | the node's HTTP API |
| 3383/tcp, 3000/tcp, 8125/udp, 8126/tcp | closed | gRPC, Grafana (login admin/admin), metrics |

Docker publishes ports past the server's own `ufw`, so threecast uses the provider's cloud firewall; on your own server, the firewall is yours. Your laptop reaches the API through an SSH tunnel, `127.0.0.1:13381` to the server's `127.0.0.1:3381`, so nobody else can read from your node or write through it. `up --public-api` opens 3381 to everyone instead.

---

## 4. Step 1: the read node

You end with a read node in sync on all 3 shards.

```sh
./threecast node
```

### What `node` does

It copies three scripts to the server and runs `node.sh` as the systemd unit `threecast-node`, so closing the laptop does not stop it. It has three phases ([times](#how-long-it-takes)):

- **Restore**: `restore.sh` downloads and unpacks Farcaster's public snapshot, shard by shard.
- **Install**: Farcaster's own `snapchain.sh` sets up Docker and starts the node.
- **Catch-up**: the node replays the blocks made since the snapshot.

On our run, `snapchain.sh upgrade` started the node on the restored database in 51 s, unattended.

*The progress line's formats, from `lib/node.sh` with test inputs:*

```text
restore   shard 1 (2 of 3)  chunk 1200/2673  72.4 MB/s  ~1h30m left
install   the official snapchain.sh is installing Docker and starting the node
catch-up  shard 0 4h00m · shard 1 2h30m · shard 2 1m01s behind
synced    all 3 shards within 10 s of the network
```

It ends with `✓ Your read node is in sync`: every shard within 10 seconds of the newest block, and over 1,000,000 messages on shard 0.

Close the laptop if you like. Later, in a new Terminal window, run `cd ~/threecast`, then `./threecast status` for progress and the cost so far, or `./threecast node` to watch again. Ctrl-C (Control, not Command) stops only the view.

### Messages, blocks and shards

Every Farcaster action (a cast, a like, a follow, a new app key) is a signed **message**. **Snapchain** orders messages into blocks that every node applies in the same order, so all nodes hold the same state. It has three **shards**: shard 0 holds app keys (`KEY_ADD`), and shards 1 and 2 split casts, reactions, follows and profiles by FID.

### Read node or validator

A **validator** proposes and votes on blocks. A **read node** never votes: it fetches committed blocks, stores the state and serves the API. Anyone can run one. It also relays writes: it checks a message against its own state and gossips it to the validators. So a `200` from your node means "accepted for relay", not "in a block".

### The snapshot, and why threecast restores it itself

Farcaster publishes a daily snapshot of each shard in a public bucket, so a new node need not replay from the beginning. On 2026-10-20 it was 5,694 chunks: 505.7 GB compressed, about 556 GiB unpacked.

The node's own loader keeps every chunk until all three shards are done, a peak of about 1,583 GiB, more than a new Hetzner account may hold. It also lists every file up front, while the bucket deletes old snapshots daily. A long download then hits a missing file, and the node restarts and replays the missing shards from the beginning. If shard 0 is one, every write fails with `unknown fid` ([snapchain #1044](https://github.com/farcasterxyz/snapchain/issues/1044)); the 1,000,000-message rule catches that.

So `restore.sh` restores one shard at a time, before the node first starts, with a fresh file list each, checking every chunk's MD5 ETag and deleting it once unpacked. On our run every chunk matched on the first try, and the synced node used 557 GiB.

---

## 5. Step 2: the client

You end with an active app key and a client reading your feed from your node.

```sh
./threecast client
```

### What `client` does

- No test account yet? Run `./threecast new-account` first ([below](#no-test-account-yet-new-account)).
- The first time, it installs its pinned libraries. It opens the SSH tunnel and checks that your node is synced.
- With no app key on this laptop, it shows the part 2 warning and asks for the test account's phrase.
- It is done when it prints `✓ Your web client is running at http://127.0.0.1:4040` (or the next free port) and a browser tab opens. Keep Terminal open while you use it.

### No test account yet: `new-account`

```sh
./threecast new-account
```

It needs a synced node, and it is the only command that pays onchain. It makes a 12-word phrase on your laptop and shows it once: write it down before sending anything. Then it shows an address and an amount, about $0.20 of ETH. Send that from an exchange or a wallet on the network named Optimism or OP Mainnet, not Ethereum or Base. An exchange's minimum and fee may make you send more; the rest stays at the new address, and only the new phrase can move it. It asks before paying, registers the FID with one storage unit, and logs in. The account has no username and follows nobody: try `./threecast follow @dwr`.

*Real output on OP Mainnet, 2026-10-21, trimmed; the FID, address and key are replaced with placeholders. Our node had the new FID and its storage unit within about a minute.*

```text
✓ An account costs 0.00008140279551241 ETH (about $0.20); gas adds at most 0.0000023004773 ETH.
…
  Send at least 0.000084 ETH (about $0.20) on OP Mainnet (Optimism, chain id 10) to the account's address:
…
→ Waiting for it to be included in a block…
✓ Registered FID <fid> with one storage unit.
→ Waiting for your node to see the new registration (IdRegistry events; checking every 15 s, for up to 10 minutes)…
```

### Logging in

*Real output, 2026-10-21: the login that `new-account` ran next, through our own node. `./threecast login` first asks for the phrase and looks up its FID.*

```text
→ Checking that 0x… still controls FID <fid> (fidAddressType)…
✓ FID <fid>, and this address is its custody address.
→ Checking that FID <fid> has storage (storageLimitsByFid)…
✓ 1 storage unit.
→ Reading FID <fid>'s key nonce (signersByFid)…
✓ Next nonce 1.
→ Creating a new Ed25519 app key on this laptop…
→ Signing a KEY_ADD for it with your custody key (it may cast, delete, like, recast
  and follow; it expires after 90 days unused)…
→ Submitting the KEY_ADD to http://127.0.0.1:13381 (POST /v1/submitMessage)…
✓ Accepted for relay. App key saved to ~/.threecast/accounts/<fid>.json
  (mode 600).
→ Waiting for the network to merge it (checking /v1/signer every 3 s, for up to 3
  minutes)…
✓ App key 0x… is active for FID <fid> (merged after 3 s).
```

"Active" means your node returns the key from `/v1/signer`: it landed. `./threecast whoami` shows it at any time.

### FIDs and custody addresses

Your node holds every event of IdRegistry, the OP Mainnet contract that records FIDs, so it finds an address's FID without an Ethereum RPC: for our new account, `onChainIdRegistryEventByAddress` answered in 8 ms. Accounts can move, so threecast then checks that the address is still the custody address.

### Storage rent

Accounts rent **storage** onchain. A unit costs about $0.20 of ETH on OP Mainnet, lasts 365 days, and holds 100 casts, 200 reactions, 200 follows and 25 profile fields, pruning the oldest past that. With no storage, your node still accepts messages but validators drop them, so login stops. [UNVERIFIED: read from Snapchain's code, not seen on a live node.]

### App keys and the gasless KEY_ADD

An **app key**, or signer, is an Ed25519 key that signs for your FID within its **scopes**, here casts, cast deletes, reactions and follows. It expires after 90 days unused.

Since engine version 16 went live on 2026-05-07, adding a key is **gasless**: a Snapchain message, not an OP Mainnet transaction. Your custody key signs two EIP-712 statements, one adding the key to your FID and one naming who requested it, here you. The new key signs the message that carries them. A rising nonce blocks replays, and validators take one `KEY_ADD` per account per minute.

### Posting: what a message is

A Snapchain message has five parts:

- **data**: the type (`CAST_ADD`), your FID, a timestamp (seconds since 2021-01-01 UTC), the network and the body;
- **hash**: BLAKE3 of the data, cut to 20 bytes, the `0x…` in cast references;
- **signature**: Ed25519, over the hash, by your app key;
- **signer**: that key's public half, so anyone can check;
- the names of both schemes.

Here is what happens after `./threecast cast "hello from my own node"`.

At step 7 the client asks every 2 seconds until your node serves the cast back:

```text
✓ Published <fid>:<hash>: your node served it back after <n> s.
```

After a minute without it, the client submits once more, then reports. On our run a cast, a follow and a recast each came back from our own node on the first read-back, and Farcaster's public node served all three when we checked a few minutes later. Messages dated over 10 minutes off are rejected, so threecast first checks your clock against the node's. [UNVERIFIED: whether a bare snapchain node sends the Date header this reads.]

### Follows, likes, recasts, deletes

Each is one message, confirmed the same way.

| `./threecast …` | Message |
|---|---|
| `cast "TEXT"` · `delete REF` | `CAST_ADD` · `CAST_REMOVE` |
| `like REF` · `unlike REF`, `recast REF` · `unrecast REF` | `REACTION_ADD` · `REACTION_REMOVE` |
| `follow USER` · `unfollow USER` | `LINK_ADD` · `LINK_REMOVE` |
| `logout` | `KEY_REMOVE`, signed by the app key itself, so no phrase is needed |

`REF` is a number from the last feed. [UNVERIFIED: logout's KEY_REMOVE has not been submitted to a node yet.]

### Which app made this cast

A cast has no app field, only the key that signed it. Apps request keys under their own FID, the key's `requestFid`, so threecast asks your node about each cast's key (`GET /v1/signer`) to name the app. A revoked gasless key loses its record, so its casts are `unknown`.

*`./threecast apps --as 3` against Farcaster's public node, 2026-10-21:*

```text
Apps behind the 100 most recent casts in FID 3's home feed:
    79  79%  Farcaster  --app farcaster · app FID 9152
    17  17%  own key    --app self · a key the author requested for themselves
     4   4%  Firefly    --app firefly · app FID 16823
```

To include or exclude apps:

```sh
./threecast feed --app farcaster       # only casts made with the Farcaster app
./threecast feed --not-app farcaster   # everything except those
./threecast feed --app firefly,self    # several apps at once
./threecast feed --unknown exclude     # leave out casts whose app is unknown
```

### The web client

The network has no home feed, so threecast builds yours from the latest casts of up to 300 accounts you follow. The page adds a cast box, Like, Recast, Reply and an `[ Apps ]` filter. Its API listens only on 127.0.0.1 and wants a random token only its page has, so other websites cannot post as you. Tried only in Chrome on macOS: if Safari misbehaves, use Chrome.

---

## 6. While your node syncs

The client can read from any Snapchain node. Farcaster runs a public one, and `--as <fid>` reads as any account without logging in:

```sh
./threecast feed --node https://snap.farcaster.xyz:3381 --as 3
./threecast web --node https://snap.farcaster.xyz:3381 --as 3
```

The second opens the web client read-only, as `./threecast client` offers while your node syncs. Anything that signs is refused. These reads come from Farcaster's node, not yours.

---

## 7. Troubleshooting

threecast's errors start with `✗`, then say what to do. These first lines are quoted from the code.

**1. A command or tool is not found**

```text
✗ 'jq' is not installed.
✗ Node.js v22.12.0 is too old: the client needs 24 or newer.
```

Run `brew install jq` or `brew upgrade node` ([Homebrew](#installing-the-tools-on-a-mac)). For `no such file or directory: ./threecast`, run `cd ~/threecast` first.

**2. Hetzner refuses the server or the volume**

```text
✗ Hetzner did not let this account create a server (403 …).
✗ Hetzner refused a 1000 GB volume: this account's volume limit is lower (403 resource_limit_exceeded: …).
```

New Hetzner customers may be refused servers ([part 1](#what-you-need)), must verify with an ID or a prepayment, and may hold at most 1024 GB of volumes. `up` has already deleted what it made: use `--provider digitalocean` or your own server. [UNVERIFIED: Hetzner's error wording for a restricted account.]

**3. DigitalOcean refuses the Droplet or the volume**

```text
✗ DigitalOcean refused the 1000 GiB volume (…).
```

New teams start at tier 1 (Droplets up to $48 a month, volumes up to 100 GiB, [limits](https://docs.digitalocean.com/platform/resource-limits/)). Raise it to tier 3 as in [part 1](#what-you-need), then run `up` again.

**4. The server cannot be reached**

```text
✗ Cannot reach 203.0.113.7 over SSH.
```

After a 10-second timeout. Check in the provider's console that the server is running, and that your network allows outgoing port 22.

**5. `node.sh` stopped on the server**

```text
✗ node.sh stopped on the server: <the reason>
✗ node.sh is no longer running on the server (it stopped during restore).
```

The first gives the reason, such as too little free space, and the log's last 30 lines; the second follows a reboot. Fix the cause and run `./threecast node` again; restored shards are kept.

**6. The node is not ready yet**

```text
✗ Your node is still syncing, so it cannot vouch for your account yet.
✗ http://127.0.0.1:13381 closed the connection without answering.
✗ Your node did not accept the message: unknown fid
```

The node is not in sync or not running yet: check `./threecast status`, and read through the [public node](#6-while-your-node-syncs) meanwhile. `unknown fid` means shard 0 is incomplete, or the account is only minutes old.

**7. The phrase or the account is rejected**

```text
✗ Every word is valid, but the phrase's checksum does not match.
✗ No FID is registered to 0x….
✗ This looks like a wallet phrase: its address is linked to the account but cannot authorize keys.
✗ FID <fid> has no storage units, so the network would quietly drop everything it posts.
```

A checksum error means a word is wrong or out of order. The next two mean you used the [wallet phrase](#which-phrase-the-account-phrase-not-the-wallet-phrase), or the account sits at another index (`--account-index 1`). For storage, rent a unit, about $0.20 of ETH.

**8. Accepted, but not showing up**

```text
✗ Your node accepted the KEY_ADD, but the network has not merged it after 3 minutes.
! Your node accepted the message, but it has not shown up after two minutes (…).
```

No validator has included it yet, or the gossip was lost. Wait a few minutes, then check `./threecast whoami` or the feed; if the key is still not active, run `./threecast login` again.

---

## 8. Teardown

**To stop paying, run `./threecast down`.** A rented server bills from `up` until `down`, switched on or off ([prices](#what-it-costs)). Optional, first, while your node runs: `./threecast logout` revokes the app key.

```sh
./threecast down
```

It asks for the API token again if you did not save it, lists what threecast created, and asks you to type the server's name (`threecast` by default). It deletes the server, the volume and its data, the firewall, the IPs and the SSH key it uploaded, then checks that nothing is left. [UNVERIFIED: `down` has not been run against the real Hetzner and DigitalOcean APIs.]

*The last lines of `down --yes` against the Hetzner test mock:*

```text
→ Checking that nothing labelled threecast=threecast is left…
✓ Nothing is left. Billing for 'threecast' has stopped.
✓ Forgot 'threecast' on this laptop.
```

Then check by hand in the provider's console: Servers and Volumes (Hetzner) or Droplets and Volumes (DigitalOcean) should be empty. Delete the API token there, and its saved copy: `rm ~/.threecast/credentials`. On your own server, `down` offers to stop the node, and deletes data only with `--purge`.

---

## 9. How it's built and verified

### Code and tests

The client uses `@farcaster/core` 0.20.0, `viem` 2.57.3 and `@scure/bip39` 1.6.0, talks to the node over plain HTTP, and has no build step. Snapchain is GPL-3.0, so threecast, which is MIT, copies none of its files: `snapchain.sh` downloads them on your server. The [README](https://github.com/yin-dra/threecast#repo-map) maps the repo and lists the fixes drafted for upstream docs.

On 2026-10-21, on macOS with `/bin/bash` 3.2 and Node 24.12.0:

| Suite | Command | Result |
|---|---|---|
| Provisioning, against mock Hetzner and DigitalOcean APIs | `/bin/bash tests/provision/run.sh` | 28 of 28 pass |
| Server scripts, with a partial restore from the real bucket | `/bin/bash tests/node/run.sh --live` | 174 checks, none failed |
| Client | `cd client && npm ci && npm test` | 108 of 119 pass, 11 live ones skipped |
| Client, live against the public node | `cd client && THREECAST_LIVE=1 npm test` | 119 of 119 pass |

These suites submit nothing to Farcaster and create no cloud resources. [VERIFICATION.md](https://github.com/yin-dra/threecast/blob/HEAD/docs/VERIFICATION.md) lists each command run and its result.

### What has run for real

On 2026-10-21, on a new Hetzner account: `up` rented the cpx42 and volume, `node` reached sync in 10 h 10 min for $2.60 ([run log](https://github.com/yin-dra/threecast/blob/HEAD/docs/runs/2026-10-21-hetzner-cpx42.md)), and `new-account` registered FID <fid> on OP Mainnet. Its gasless `KEY_ADD`, relayed through our read node, merged after 3 s. A cast, a follow and a recast from the web client then reached Farcaster's public node ([VERIFICATION.md](https://github.com/yin-dra/threecast/blob/HEAD/docs/VERIFICATION.md#real-run-2026-10-21)).

Not run yet: `login` with an existing account's phrase, likes, replies, deletes and unfollows (same message types as what did run), `logout`, `down` against a real API, DigitalOcean, your own server, a second account made in the Farcaster app, and Linux laptops. Two other entries, [runfcx](https://github.com/antonpecherkin/runfcx) and [farcaster-bounty](https://github.com/vrajdesai78/farcaster-bounty), report casts, likes and follows landing on mainnet through their own 0.14.3 read nodes, the same path.
