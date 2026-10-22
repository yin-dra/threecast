# Upstream PR 1: snapchain, KEY_ADD error table

- Repo: `farcasterxyz/snapchain`
- Base: `main` at `fc87f2686472598143062a00e1c2b2633b2d87ab` (tag `@latest`, release v0.14.3)
- File: `site/docs/pages/guides/writing-messages.mdx` (live at https://snapchain.farcaster.xyz/guides/writing-messages)
- Patch: `1-snapchain-key-add-error-table.patch` (1 file, +7 / -4)
- Branch name to push: `docs/key-add-error-table`
- Unclaimed as of 2026-10-21: no open or closed PR touches this table. #1042 and #1047 edit other lines of the same file and still apply on top of this patch.

## Title

docs: match the KEY_ADD error table to the node's error strings

## Description

<!-- body -->
The table under "If the node rejects the message" in the writing-messages guide lists shortened error strings. The node never returns those exact strings, so a developer who searches the guide for the error they got finds nothing. One row also merges two different errors, and two common rejections are missing.

What a v0.14.3 node returns (source at fc87f26):

| Guide today | Node returns | Source |
| --- | --- | --- |
| `nonce is not greater than stored nonce` | `gasless-key nonce <n> is not greater than stored nonce <m>` (code `bad_request.conflict`) | [key_nonce_store.rs#L101-L109](https://github.com/farcasterxyz/snapchain/blob/fc87f2686472598143062a00e1c2b2633b2d87ab/src/storage/store/account/key_nonce_store.rs#L101-L109) |
| `invalid signed key request` | `SignedKeyRequest metadata is malformed or signature does not verify` | [error.rs#L159-L160](https://github.com/farcasterxyz/snapchain/blob/fc87f2686472598143062a00e1c2b2633b2d87ab/src/core/validations/error.rs#L159-L160), [key.rs#L312-L341](https://github.com/farcasterxyz/snapchain/blob/fc87f2686472598143062a00e1c2b2633b2d87ab/src/core/validations/key.rs#L312-L341) |
| (same row) | `requestSigner does not match custody address of requestFid` | [error.rs#L163-L164](https://github.com/farcasterxyz/snapchain/blob/fc87f2686472598143062a00e1c2b2633b2d87ab/src/core/validations/error.rs#L163-L164), [gasless_key_merge.rs#L122-L133](https://github.com/farcasterxyz/snapchain/blob/fc87f2686472598143062a00e1c2b2633b2d87ab/src/storage/store/account/gasless_key_merge.rs#L122-L133) |
| (missing) | `SignedKeyRequest deadline has expired` | [key.rs#L322-L326](https://github.com/farcasterxyz/snapchain/blob/fc87f2686472598143062a00e1c2b2633b2d87ab/src/core/validations/key.rs#L322-L326) |
| `invalid scope` | `scope "<n>" is not a valid MessageType` | [error.rs#L173-L174](https://github.com/farcasterxyz/snapchain/blob/fc87f2686472598143062a00e1c2b2633b2d87ab/src/core/validations/error.rs#L173-L174), [key.rs#L403-L405](https://github.com/farcasterxyz/snapchain/blob/fc87f2686472598143062a00e1c2b2633b2d87ab/src/core/validations/key.rs#L403-L405) |
| `active key cap exceeded` | `active-key cap exceeded: 1000 keys per FID` | [error.rs#L191-L192](https://github.com/farcasterxyz/snapchain/blob/fc87f2686472598143062a00e1c2b2633b2d87ab/src/core/validations/error.rs#L191-L192), [gasless_key_merge.rs#L217-L221](https://github.com/farcasterxyz/snapchain/blob/fc87f2686472598143062a00e1c2b2633b2d87ab/src/storage/store/account/gasless_key_merge.rs#L217-L221) |
| (missing) | `rate limit exceeded for FID <fid>`, one KEY_ADD per fid per minute, KEY_REMOVE exempt | [mempool.rs#L128-L168](https://github.com/farcasterxyz/snapchain/blob/fc87f2686472598143062a00e1c2b2633b2d87ab/src/mempool/mempool.rs#L128-L168), [mempool.rs#L841-L847](https://github.com/farcasterxyz/snapchain/blob/fc87f2686472598143062a00e1c2b2633b2d87ab/src/mempool/mempool.rs#L841-L847) |

The `invalid signature` row was already right ([error.rs#L13-L14](https://github.com/farcasterxyz/snapchain/blob/fc87f2686472598143062a00e1c2b2633b2d87ab/src/core/validations/error.rs#L13-L14), [gasless_key_merge.rs#L157-L158](https://github.com/farcasterxyz/snapchain/blob/fc87f2686472598143062a00e1c2b2633b2d87ab/src/storage/store/account/gasless_key_merge.rs#L157-L158)) and is unchanged.

All of these reach the caller of `submitMessage`. KEY_ADD routes to shard 0 ([routing.rs#L55-L62](https://github.com/farcasterxyz/snapchain/blob/fc87f2686472598143062a00e1c2b2633b2d87ab/src/mempool/routing.rs#L55-L62)), and the node simulates it there before admitting it, returning the first error ([server.rs#L772-L787](https://github.com/farcasterxyz/snapchain/blob/fc87f2686472598143062a00e1c2b2633b2d87ab/src/network/server.rs#L772-L787)). The rate limit is checked at mempool admission and comes back through the same call.

The change only touches the table. It quotes the real strings with `<n>` placeholders for the numbers, gives the custody mismatch its own row, and adds rows for the expired deadline and the rate limit. The scope row now names the numeric values of `KEY_ADD` (16) and `KEY_REMOVE` (17), since the error prints the number. The table also says that metadata from `getSignedKeyRequestMetadata()` fails with the "malformed or signature does not verify" error. That follows from [key.rs#L331-L341](https://github.com/farcasterxyz/snapchain/blob/fc87f2686472598143062a00e1c2b2633b2d87ab/src/core/validations/key.rs#L331-L341): the node rebuilds the typed data on the gasless domain, so a signature over the onchain domain recovers a different address than `requestSigner`.

The strings are read from source at v0.14.3. I did not trigger each one against mainnet.
<!-- /body -->

## Before you open it

1. Check that nobody filed it since 2026-10-21:

```bash
gh pr list --repo farcasterxyz/snapchain --state all --search "error table" --limit 20
gh pr list --repo farcasterxyz/snapchain --state all --search "writing-messages" --limit 20
gh search prs --repo farcasterxyz/snapchain "KEY_ADD error" --limit 20
```

2. Read the patch. The commit author is `yin-dra <12395328+yin-dra@users.noreply.github.com>`, and the message ends with a `Co-Authored-By: Claude` trailer. To drop the trailer, run `git commit --amend` after `git am` and delete that line.

## Commands (fork, push, open)

```bash
TC=~/threecast   # where you cloned threecast
# Fork once and clone the fork. Sets origin = yin-dra/snapchain, upstream = farcasterxyz/snapchain.
gh repo fork farcasterxyz/snapchain --clone
cd snapchain

# Branch from current upstream main and apply the patch (-3 falls back to a 3-way merge if main moved).
git fetch upstream
git checkout -b docs/key-add-error-table upstream/main
git am -3 "$TC"/docs/upstream/1-snapchain-key-add-error-table.patch

# Push to the fork.
git push -u origin docs/key-add-error-table

# Extract the description above into a body file and open the PR.
awk '/^<!-- \/body -->$/{f=0} f; /^<!-- body -->$/{f=1}' \
  "$TC"/docs/upstream/1-snapchain-key-add-error-table.md > /tmp/pr1-body.md
gh pr create --repo farcasterxyz/snapchain --base main \
  --head yin-dra:docs/key-add-error-table \
  --title "docs: match the KEY_ADD error table to the node's error strings" \
  --body-file /tmp/pr1-body.md
```

PR 2 uses the same snapchain clone. Run its commands from inside that `snapchain` directory and skip the fork step.
