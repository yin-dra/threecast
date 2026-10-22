# threecast

Your own Farcaster read node and client, in three commands. threecast rents a server or uses yours, restores the public Snapchain snapshot, and runs the official read node. The client runs on your laptop: it reads your feed from that node, posts, follows, likes and recasts through it, and filters casts by the app that made them. No Farcaster API key is needed; the only token is your cloud provider's.

Tutorial: **https://yin-dra.github.io/threecast**

```sh
cd ~
git clone https://github.com/yin-dra/threecast.git
cd threecast
./threecast up
./threecast node
./threecast client
```

Run them one at a time:

- `up` (step 0) rents a server on Hetzner or DigitalOcean, or registers yours with `--host user@ip`. It shows the price and creates nothing until you say yes.
- `node` (step 1) restores the snapshot on the server, starts the read node and waits for sync: 10 h 10 min and $2.60 on our first run, a Hetzner cpx42 ([run log](docs/runs/2026-10-21-hetzner-cpx42.md)); budget about 10 hours, less if you start it in the UTC evening. You can close the laptop meanwhile; `./threecast status` checks on it.
- `client` (step 2) authorizes an app key from a TEST account's recovery phrase, which it never saves, and opens the web client. No test account yet? Run `./threecast new-account` first.

In a new Terminal window, `cd ~/threecast` first.

## Prerequisites

- macOS or Linux, with git, Node.js 24 or newer, and jq (`brew install git node jq`; no Homebrew yet? see [the tutorial](https://yin-dra.github.io/threecast/#installing-the-tools-on-a-mac)).
- One of:
  - a Hetzner Cloud account. New accounts must verify with an ID or a prepayment (ours: $25, after which it created the server) and may hold at most 1024 GB of volumes. Since 2026-06-26 Hetzner restricts new servers for new customers, and credit does not lift that.
  - a DigitalOcean account at resource tier 3. A new account gets there before `up`: Control Panel → Resource Limits → a one-time $250 prepayment (credit for the bill, not refunded, expires after 18 months), or Request an increase.
  - your own Ubuntu or Debian server: systemd, 4+ cores, 16 GB RAM, 700 GiB free, SSH key login as root or with passwordless sudo.

  No cloud account yet? Try Hetzner; if `up` is refused, use DigitalOcean.
- A TEST Farcaster account that has storage, never your main one. No test account yet? Once your node is synced, `./threecast new-account` registers one on OP Mainnet for about $0.20 of ETH.

## Cost and teardown

On 2026-10-21, before VAT:

| | per hour | per day | per month, at most |
|---|---|---|---|
| Hetzner cpx42 + 1000 GB volume | ≈ €0.20 | ≈ €4.89 | ≈ €127.19 |
| DigitalOcean s-8vcpu-16gb + 1000 GiB volume | ≈ $0.29 | ≈ $7.00 | ≈ $196.00 |

Billing runs until `./threecast down`, even with the server switched off. Optionally revoke the app key first, while the node still runs, with `./threecast logout`. `down` deletes the server, volume, firewall, IPs and SSH key, then checks that nothing is left. Afterwards, check the provider's console: Servers and Volumes (Hetzner) or Droplets and Volumes (DigitalOcean) should be empty.

## Verification status

Tested against mock cloud APIs, the public snapshot bucket and Farcaster's public node. Run for real on 2026-10-21: `up` on Hetzner, `node` to sync, and `new-account` on OP Mainnet with its gasless KEY_ADD ([run log](docs/runs/2026-10-21-hetzner-cpx42.md)). Not yet run: casts, reactions and follows, `logout`, `down` against a real API, DigitalOcean, your own server, Linux laptops. Every command and its result: [docs/VERIFICATION.md](docs/VERIFICATION.md).

## Repo map

```text
threecast            entrypoint (bash 3.2 compatible)
lib/                 laptop side: up, down, ssh and tunnel, node and status, client
provision/           Hetzner and DigitalOcean API calls, cloud-init for first boot
node/                runs on the server: node.sh, restore.sh (streaming snapshot restore), synced.sh
client/src/          the client, TypeScript run directly by Node 24
client/web/          the local web client (http://127.0.0.1:4040)
tests/               mock cloud APIs, mock snapshot bucket, fixtures
site/                the tutorial (node site/build.mjs builds index.html from content.md)
docs/VERIFICATION.md what was tested, and how
docs/upstream/       fixes sent upstream (snapchain#1077, docs#472)
```

Tests: `/bin/bash tests/provision/run.sh`, `/bin/bash tests/node/run.sh`, `cd client && npm ci && npm test`.

## Upstream fixes

Docs errors found while building threecast, sent to Farcaster's repos:

- [farcasterxyz/snapchain#1077](https://github.com/farcasterxyz/snapchain/pull/1077): the KEY_ADD error table in the writing-messages guide now quotes the strings a node actually returns.
- [farcasterxyz/docs#472](https://github.com/farcasterxyz/docs/pull/472): storage units cost $0.20 and hold 100 casts, 200 reactions and 200 links, not $7 and 5000.

The patches and descriptions are in [docs/upstream/](docs/upstream/). A third fix, gossip port 3382 being UDP, was already filed by someone else as [snapchain#1069](https://github.com/farcasterxyz/snapchain/pull/1069), so it was dropped.

## License

MIT, see [LICENSE](LICENSE). Snapchain is GPL-3.0; threecast never copies its files. Farcaster's `snapchain.sh` fetches them on your server at install time.

By @thisiscryptome.
