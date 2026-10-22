# Upstream PR 3: docs.farcaster.xyz, storage unit price and limits

Opened on 2026-10-22 as [farcasterxyz/docs#472](https://github.com/farcasterxyz/docs/pull/472).

- Repo: `farcasterxyz/docs`
- Base: `main` at `da99c903033bbc06bad1ab5f78cb00a3b745997e` (2026-10-19, after #469)
- Files: `src/app/(docs)/learn/what-is-farcaster/messages/page.mdx` (live at https://docs.farcaster.xyz/learn/what-is-farcaster/messages), `src/app/(docs)/reference/contracts/page.mdx` (live at https://docs.farcaster.xyz/reference/contracts)
- Patch: `3-docs-storage-unit-price-limits.patch` (2 files, +11 / -9)
- Branch name to push: `docs/storage-unit-2025`
- Unclaimed as of 2026-10-21: no PR in `farcasterxyz/docs` touches either page's storage text. #470 and #471 edit other files and still apply on top of this patch. #427 (Chinese translation, open since 2025) only touches the legacy `docs/zh/` tree.

## Title

docs: storage units cost $0.20 and hold 100 casts, 200 reactions, 200 links

## Description

<!-- body -->
The Storage section of the Messages page still describes the original storage unit: "$7 today", with 5000 casts, 2500 reactions, 2500 links, 50 profile data and 50 verifications ([messages/page.mdx#L25-L31](https://github.com/farcasterxyz/docs/blob/da99c903033bbc06bad1ab5f78cb00a3b745997e/src/app/%28docs%29/learn/what-is-farcaster/messages/page.mdx#L25-L31)). The contracts overview says "7$ USD per unit" ([contracts/page.mdx#L28-L29](https://github.com/farcasterxyz/docs/blob/da99c903033bbc06bad1ab5f78cb00a3b745997e/src/app/%28docs%29/reference/contracts/page.mdx#L28-L29)). Both have been out of date since the [Storage Redenomination FIP](https://github.com/farcasterxyz/protocol/discussions/229) cut the price to $0.20 and resized the unit.

Price: `StorageRegistry.usdUnitPrice()` at `0x00000000fcCe7f938e7aE6D3c335bD6a1a7c593D` returned `20000000` on OP Mainnet at block 158482006 (read on 2026-10-21). The value has 8 decimals ([IStorageRegistry.sol#L37](https://github.com/farcasterxyz/contracts/blob/58d6b2873a5d67290c4f143a4e86a6e274de443b/src/interfaces/IStorageRegistry.sol#L37)), so one unit costs $0.20.

Limits: Snapchain gives each unit rented since 2025-07-16 room for 100 casts, 200 links, 200 reactions, 25 user data entries and 5 verifications ([stores.rs#L124-L134](https://github.com/farcasterxyz/snapchain/blob/fc87f2686472598143062a00e1c2b2633b2d87ab/src/storage/store/stores.rs#L124-L134), v0.14.3). The cutoff is `UNIT_TYPE_2024_CUTOFF_TIMESTAMP = 1752685200`, 2025-07-16 17:00 UTC ([onchain_event_store.rs#L29](https://github.com/farcasterxyz/snapchain/blob/fc87f2686472598143062a00e1c2b2633b2d87ab/src/storage/store/account/onchain_event_store.rs#L29)). Units rented earlier keep their larger limits ([stores.rs#L103-L123](https://github.com/farcasterxyz/snapchain/blob/fc87f2686472598143062a00e1c2b2633b2d87ab/src/storage/store/stores.rs#L103-L123)), and an account's limit for each type is the sum over its units ([stores.rs#L226-L237](https://github.com/farcasterxyz/snapchain/blob/fc87f2686472598143062a00e1c2b2633b2d87ab/src/storage/store/stores.rs#L226-L237)). Even the original unit allowed 25 verifications, not 50.

What changed: the Messages page gets the new price and limits, one sentence saying older units keep their limits and that limits add up across units, and a link to the redenomination FIP next to the existing FIP-6 link. "Hubs" becomes "nodes" in the pruning paragraph. The contracts overview now says "$0.20 USD per unit".

What I left alone: the sentence about a 30-day grace period after a unit expires. Snapchain's `StorageSlot::is_active` has no grace window ([onchain_event_store.rs#L1026-L1032](https://github.com/farcasterxyz/snapchain/blob/fc87f2686472598143062a00e1c2b2633b2d87ab/src/storage/store/account/onchain_event_store.rs#L1026-L1032)), but what happens to an expired account's existing messages depends on pruning, which runs when a new message merges. I'd rather not guess at that wording here. Glad to follow up if you can say what the intended behaviour is.
<!-- /body -->

## Before you open it

1. Check that nobody filed it since 2026-10-21:

```bash
gh pr list --repo farcasterxyz/docs --state all --search "storage" --limit 20
gh pr list --repo farcasterxyz/docs --state all --search "price" --limit 20
gh search prs --repo farcasterxyz/docs "storage unit" --limit 20
gh search prs --owner farcasterxyz "0.20" --created ">=2026-10-01" --limit 20
```

2. Optional: re-read the price right before opening, since it can change. `usdUnitPrice()` is a view call; any OP Mainnet RPC works. The read above used viem against `https://mainnet.optimism.io`. If the value is no longer `20000000`, update the block number in the description and the "$0.20" in both pages.

3. Read the patch. The commit author is `yin-dra <12395328+yin-dra@users.noreply.github.com>`, and the message ends with a `Co-Authored-By: Claude` trailer. To drop the trailer, run `git commit --amend` after `git am` and delete that line.

## Commands (fork, push, open)

```bash
TC=~/threecast   # where you cloned threecast
# Fork once and clone the fork. Sets origin = yin-dra/docs, upstream = farcasterxyz/docs.
# yin-dra had no repo named "docs" on 2026-10-21, so the default fork name is free.
gh repo fork farcasterxyz/docs --clone
cd docs

# Branch from current upstream main and apply the patch.
git fetch upstream
git checkout -b docs/storage-unit-2025 upstream/main
git am -3 "$TC"/docs/upstream/3-docs-storage-unit-price-limits.patch

# Push to the fork.
git push -u origin docs/storage-unit-2025

# Extract the description above into a body file and open the PR.
awk '/^<!-- \/body -->$/{f=0} f; /^<!-- body -->$/{f=1}' \
  "$TC"/docs/upstream/3-docs-storage-unit-price-limits.md > /tmp/pr3-body.md
gh pr create --repo farcasterxyz/docs --base main \
  --head yin-dra:docs/storage-unit-2025 \
  --title 'docs: storage units cost $0.20 and hold 100 casts, 200 reactions, 200 links' \
  --body-file /tmp/pr3-body.md
```
