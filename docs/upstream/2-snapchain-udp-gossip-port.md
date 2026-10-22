# Upstream PR 2: snapchain, gossip port 3382 is UDP

- Repo: `farcasterxyz/snapchain`
- Base: `main` at `fc87f2686472598143062a00e1c2b2633b2d87ab` (tag `@latest`, release v0.14.3)
- Files: `site/docs/pages/guides/running-a-node.mdx` (live at https://snapchain.farcaster.xyz/guides/running-a-node), `site/docs/pages/getting-started.mdx` (live at https://snapchain.farcaster.xyz/getting-started)
- Patch: `2-snapchain-udp-gossip-port.patch` (2 files, +15 / -2, text only)
- Branch name to push: `docs/udp-gossip-port`
- Unclaimed as of 2026-10-21: #1040 fixes the same port line in `README.md` only. #1043, #1053 and #1065 edit other lines of these two files and still apply on top of this patch.

## Title

docs: open the gossip port 3382 as UDP, not TCP

## Description

<!-- body -->
The AWS guide asks readers to edit their security group "until they match the below", and the inbound screenshot it shows opens 3382 as Custom TCP. Snapchain gossips over QUIC, which runs on UDP. The mainnet compose file binds gossip to `/ip4/0.0.0.0/udp/3382/quic-v1` ([docker-compose.mainnet.yml#L45-L47](https://github.com/farcasterxyz/snapchain/blob/fc87f2686472598143062a00e1c2b2633b2d87ab/docker-compose.mainnet.yml#L45-L47)) and publishes `3382:3382/udp` ([#L85-L88](https://github.com/farcasterxyz/snapchain/blob/fc87f2686472598143062a00e1c2b2633b2d87ab/docker-compose.mainnet.yml#L85-L88)). With only a TCP rule on 3382, a peer cannot open a connection to the node's gossip port. Getting Started has a smaller version of the same gap: it asks for "ports 3381 - 3383 exposed" with no protocol ([getting-started.mdx#L12](https://github.com/farcasterxyz/snapchain/blob/fc87f2686472598143062a00e1c2b2633b2d87ab/site/docs/pages/getting-started.mdx#L12)).

The Ports table in the managing-a-node guide already lists the right protocols ([managing-a-node.mdx#L128-L138](https://github.com/farcasterxyz/snapchain/blob/fc87f2686472598143062a00e1c2b2633b2d87ab/site/docs/pages/guides/managing-a-node.mdx#L128-L138)), so both pages now point to it.

In running-a-node, the inbound screenshot becomes a four-row table (SSH 22, 3381 TCP, 3382 UDP, 3383 TCP) that uses the Type names the AWS console shows, plus one sentence on why 3382 must be UDP. The outbound screenshot allows all traffic, which is correct, so it stays.

In getting-started, the requirement now reads "ports 3381 and 3383 (TCP) and 3382 (UDP) exposed", with a link to the Ports table. That is the same wording #1040 uses for the README.

`site/docs/public/images/inbound.png` is now unreferenced. I left it in so the diff stays text only. I can delete it in this PR if you prefer.
<!-- /body -->

## Before you open it

1. Check that nobody filed it since 2026-10-21:

```bash
gh pr list --repo farcasterxyz/snapchain --state all --search "udp" --limit 20
gh pr list --repo farcasterxyz/snapchain --state all --search "firewall" --limit 20
gh search prs --repo farcasterxyz/snapchain "3382" --limit 20
gh search prs --repo farcasterxyz/snapchain "inbound" --limit 20
```

2. Read the patch. The commit author is `yin-dra <12395328+yin-dra@users.noreply.github.com>`, and the message ends with a `Co-Authored-By: Claude` trailer. To drop the trailer, run `git commit --amend` after `git am` and delete that line.

3. Optional: preview the page. The site is Vocs under `site/`. The table and the `/guides/managing-a-node#ports` anchor follow patterns already used in these docs (`/node-types#mempool`), but the page was not rendered here.

## Commands (fork, push, open)

```bash
TC=~/threecast   # where you cloned threecast
# Skip this block if you already forked and cloned for PR 1.
gh repo fork farcasterxyz/snapchain --clone
cd snapchain

# Branch from current upstream main and apply the patch.
git fetch upstream
git checkout -b docs/udp-gossip-port upstream/main
git am -3 "$TC"/docs/upstream/2-snapchain-udp-gossip-port.patch

# Push to the fork.
git push -u origin docs/udp-gossip-port

# Extract the description above into a body file and open the PR.
awk '/^<!-- \/body -->$/{f=0} f; /^<!-- body -->$/{f=1}' \
  "$TC"/docs/upstream/2-snapchain-udp-gossip-port.md > /tmp/pr2-body.md
gh pr create --repo farcasterxyz/snapchain --base main \
  --head yin-dra:docs/udp-gossip-port \
  --title "docs: open the gossip port 3382 as UDP, not TCP" \
  --body-file /tmp/pr2-body.md
```
