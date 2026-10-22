// threecast — MIT License
// The home feed's fan-out (one castsByFid per followed account) when some of those reads fail,
// and casts whose timestamps lie in the future.

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { FARCASTER_EPOCH } from "@farcaster/core";
import { homeFeed, userCasts } from "../src/feed.ts";
import { Hub } from "../src/hub.ts";
import { mockNode, notFound, useTempHome } from "./helpers.ts";

useTempHome();

const failing = new Set<number>();
// Extra casts per fid, served newest first ahead of its regular one, as castsByFid reverse=true does.
const extra = new Map<number, ReturnType<typeof cast>[]>();
const farcasterSeconds = (ms: number) => Math.floor((ms - FARCASTER_EPOCH) / 1000);
const cast = (fid: number, timestamp: number, n = 0) => ({
  data: {
    type: "MESSAGE_TYPE_CAST_ADD",
    fid,
    timestamp,
    network: "FARCASTER_NETWORK_MAINNET",
    castAddBody: { text: `cast by ${fid}`, type: "CAST", embeds: [], embedsDeprecated: [], mentions: [], mentionsPositions: [], parentCastId: null as { fid: number; hash: string } | null, parentUrl: null },
  },
  hash: `0x${String(n).padStart(20, "0")}${String(fid).padStart(20, "0")}`,
  signer: `0x${"b".repeat(64)}`,
});

const node = await mockNode({
  "/v1/linksByFid": () => ({
    json: { messages: [10, 11, 12].map((targetFid, i) => ({ data: { type: "MESSAGE_TYPE_LINK_ADD", fid: 1, timestamp: i, linkBody: { type: "follow", targetFid } } })), nextPageToken: "" },
  }),
  "/v1/castsByFid": (req) => {
    const fid = Number(req.query.get("fid"));
    if (failing.has(fid)) return { status: 500, text: "upstream timeout" };
    return { json: { messages: [...(extra.get(fid) ?? []), cast(fid, 100 + fid)], nextPageToken: "" } };
  },
  "/v1/userDataByFid": () => ({ json: { messages: [], nextPageToken: "" } }),
  "/v1/signer": () => notFound("Failed to get signer", "Active signer not found"),
  "/v1/onChainEventsByFid": () => ({ json: { events: [] } }),
});
after(() => node.close());
const hub = new Hub(node.url);
const none = new Set<string>();

test("one account that cannot be read is left out and counted, not fatal", async () => {
  failing.clear();
  failing.add(11);
  const feed = await homeFeed(hub, 1, {}, { ownKeys: none });
  assert.deepEqual(feed.posts.map((p) => p.fid), [12, 10]);
  assert.equal(feed.unread, 1);
  assert.equal(feed.following, 3);
});

test("when no account can be read, the node's error is reported", async () => {
  failing.clear();
  for (const fid of [10, 11, 12]) failing.add(fid);
  await assert.rejects(homeFeed(hub, 1, {}, { ownKeys: none }), /upstream timeout/);
});

test("a cast dated decades ahead is left out and counted, not put first", async () => {
  failing.clear();
  // FID 347 really has a cast dated 2061-09-12 on mainnet.
  extra.set(11, [cast(11, farcasterSeconds(Date.UTC(2061, 8, 12)), 1)]);
  try {
    const feed = await homeFeed(hub, 1, {}, { ownKeys: none });
    assert.deepEqual(feed.posts.map((p) => p.fid), [12, 11, 10]);
    assert.equal(feed.futureDated, 1);
    assert.equal(feed.scanned, 4);

    const own = await userCasts(hub, 11, {}, none);
    assert.deepEqual(own.posts.map((p) => p.hash), [cast(11, 0).hash]);
    assert.equal(own.futureDated, 1);
  } finally {
    extra.clear();
  }
});

test("a cast up to 10 minutes ahead is kept: the network allows that much clock skew", async () => {
  failing.clear();
  extra.set(10, [cast(10, farcasterSeconds(Date.now() + 5 * 60_000), 1)]);
  try {
    const feed = await homeFeed(hub, 1, {}, { ownKeys: none });
    assert.equal(feed.posts[0]?.hash, cast(10, 0, 1).hash);
    assert.equal(feed.futureDated, 0);
  } finally {
    extra.clear();
  }
});

test("a future-dated reply is not counted while replies are hidden", async () => {
  failing.clear();
  const reply = cast(12, farcasterSeconds(Date.UTC(2061, 8, 12)), 1);
  extra.set(12, [{ ...reply, data: { ...reply.data, castAddBody: { ...reply.data.castAddBody, parentCastId: { fid: 3, hash: `0x${"0".repeat(40)}` } } } }]);
  try {
    assert.equal((await homeFeed(hub, 1, {}, { ownKeys: none })).futureDated, 0);
    assert.equal((await homeFeed(hub, 1, { replies: true }, { ownKeys: none })).futureDated, 1);
  } finally {
    extra.clear();
  }
});
