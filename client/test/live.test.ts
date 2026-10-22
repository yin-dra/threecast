// threecast — MIT License
// Read-only checks against a real public node. Skipped unless THREECAST_LIVE=1. A handful of
// GETs, nothing is ever submitted.

import assert from "node:assert/strict";
import { test } from "node:test";
import * as api from "../src/api.ts";
import { appFor } from "../src/apps.ts";
import { homeFeed, userCasts } from "../src/feed.ts";
import { Hub, readStatus } from "../src/hub.ts";
import type { MessageJson, OnChainEventJson } from "../src/hub.ts";
import { resolveFid } from "../src/names.ts";
import { useTempHome } from "./helpers.ts";

const live = process.env.THREECAST_LIVE === "1";
const hub = new Hub(process.env.THREECAST_LIVE_NODE ?? "https://snap.farcaster.xyz:3381");
const none = new Set<string>();
useTempHome();

test("the public node is synced", { skip: !live }, async () => {
  const status = await readStatus(hub);
  assert.equal(status.synced, true);
  assert.deepEqual(status.shards.map((s) => s.id).slice(0, 3), [0, 1, 2]);
});

test("custody address → fid (onChainIdRegistryEventByAddress), confirmed by fidAddressType", { skip: !live, timeout: 120_000 }, async () => {
  // dwr's custody address, from the node's own IdRegistry data.
  const address = "0x6b0bda3f2ffed5efc83fa8c024acff1dd45793f1";
  const event = await hub.get<OnChainEventJson>("/v1/onChainIdRegistryEventByAddress", { address }, 90_000);
  assert.equal(event.fid, 3);
  const type = await hub.get<{ is_custody: boolean }>("/v1/fidAddressType", { fid: 3, address });
  assert.equal(type.is_custody, true);
});

test("@dwr → fid 3 (userNameProofByName)", { skip: !live }, async () => {
  assert.equal(await resolveFid(hub, "@dwr"), 3);
  assert.equal(await resolveFid(hub, "DWR"), 3);
});

test("castsByFid for fid 3, newest first", { skip: !live }, async () => {
  const page = await hub.get<{ messages: MessageJson[]; nextPageToken: string }>("/v1/castsByFid", { fid: 3, pageSize: 5, reverse: true });
  assert.ok(page.messages.length > 0);
  const times = page.messages.map((m) => m.data.timestamp);
  assert.deepEqual(times, [...times].sort((a, b) => b - a));
  assert.ok(page.messages.every((m) => m.data.fid === 3 && /^MESSAGE_TYPE_CAST_(ADD|REMOVE)$/.test(m.data.type)));
});

test("a real fid-3 cast is attributed to the Farcaster app (onchain key, metadata decoded)", { skip: !live }, async () => {
  const cast = await hub.get<MessageJson>("/v1/castById", { fid: 3, hash: "0x0256ae66308d546514fa666cda44052abbfea066" });
  assert.deepEqual(await appFor(hub, 3, cast.signer, none), { fid: 9152, label: "Farcaster", source: "onchain", status: "active" });
});

test("a removed onchain key is still attributed, from the signer history", { skip: !live }, async () => {
  const tag = await appFor(hub, 191, "0xebf3521414b175e784fb2e106a698b0bef194a223d7d3ba0cf31caed357f626c", none);
  assert.equal(tag.source, "onchain");
  assert.equal(tag.status, "removed");
  assert.ok(tag.fid !== null);
});

test("an expired gasless key still resolves, to its self-requesting fid", { skip: !live }, async () => {
  const tag = await appFor(hub, 280, "0xce34e6c9ed05dee9f36db4354ca9a8f93d1f50a55a4bb0c2ed9adcfc71ee297a", none);
  assert.deepEqual(tag, { fid: 280, label: "own key", source: "gasless", status: "expired" });
});

test("home feed as fid 3, five follows only", { skip: !live, timeout: 60_000 }, async () => {
  const feed = await homeFeed(hub, 3, { limit: 5, replies: true }, { ownKeys: none, followCap: 5 });
  assert.ok(feed.following > 5);
  assert.ok(feed.scanned > 0 && feed.scanned <= 50);
  assert.ok(feed.posts.length > 0 && feed.posts.length <= 5);
  for (const post of feed.posts) {
    assert.match(post.ref, /^\d+:0x[0-9a-f]{40}$/);
    assert.ok(post.time > Date.UTC(2021, 0, 1) && post.time <= Date.now() + 600_000);
    assert.ok(post.app.label.length > 0);
  }
  const times = feed.posts.map((p) => p.time);
  assert.deepEqual(times, [...times].sort((a, b) => b - a));
});

test("FID 347's cast dated 2061 is left out of its casts, and counted", { skip: !live, timeout: 60_000 }, async () => {
  const { posts, futureDated } = await userCasts(hub, 347, { limit: 3, replies: true }, none);
  assert.ok(futureDated >= 1);
  assert.ok(posts.every((p) => p.time <= Date.now() + 600_000));
});

test("@dwr and @v in a draft become mentions of FIDs 3 and 2", { skip: !live }, async () => {
  const session = { nodeUrl: hub.url, viewerFid: null, canWrite: false };
  const draft = await api.draftCast(session, "gm @dwr and @v");
  assert.deepEqual([draft.text, draft.mentions, draft.mentionsPositions], ["gm  and ", [3, 2], [3, 8]]);
});

test("viewerReactions answers for a real cast", { skip: !live }, async () => {
  const ref = "3:0x0256ae66308d546514fa666cda44052abbfea066";
  const answer = await api.viewerReactions({ nodeUrl: hub.url, viewerFid: 3, canWrite: false }, [ref]);
  assert.deepEqual(Object.keys(answer), [ref]);
  assert.equal(typeof answer[ref]?.like, "boolean");
});
