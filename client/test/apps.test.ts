// threecast — MIT License
// App attribution (signer → app fid) against a fake node, using real onchain metadata captured
// from a public node, plus the include/exclude filter rules.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import type { AppTag, Post } from "../src/api.ts";
import { appBreakdown, appFor, filterWord, flushAttributions, matchesApp, passesFilter, rememberRevokedKey, requestFidFromMetadata } from "../src/apps.ts";
import { Hub } from "../src/hub.ts";
import type { OnChainEventJson } from "../src/hub.ts";
import { mockNode, notFound, useTempHome } from "./helpers.ts";

useTempHome();

// fid 191's signer history, captured from crackle.farcaster.xyz on 2026-10-21 (trimmed to 4 events).
const history = JSON.parse(readFileSync(new URL("./fixtures/signer-events-191.json", import.meta.url), "utf8")) as { events: OnChainEventJson[] };
const [farcasterAdd, legacyAdd, removal, authAddress] = history.events.map((e) => e.signerEventBody!);

test("decodes the app fid from real onchain KeyRegistry metadata", () => {
  const decode = (b64: string) => requestFidFromMetadata(new Uint8Array(Buffer.from(b64, "base64")));
  assert.equal(decode(farcasterAdd!.metadata), 9152);
  assert.equal(decode(legacyAdd!.metadata), 19528);
  assert.equal(removal!.metadata, "");
  assert.equal(decode(removal!.metadata), null);
  assert.equal(authAddress!.keyType, 2);
});

const KEYS = {
  gasless: `0x${"a1".repeat(32)}`,
  expired: `0x${"a2".repeat(32)}`,
  onchain: farcasterAdd!.key,
  removed: legacyAdd!.key,
  revokedGasless: `0x${"a3".repeat(32)}`,
  mine: `0x${"a4".repeat(32)}`,
  appOwned: `0x${"a5".repeat(32)}`,
};

const node = await mockNode({
  "/v1/signer": (req) => {
    const fid = Number(req.query.get("fid"));
    const key = req.query.get("signer");
    const now = Math.floor(Date.now() / 1000);
    const offchain = (requestFid: number, expiresAt: number) => ({ json: { signer: { source: "SIGNER_SOURCE_OFFCHAIN", key, keyType: 1, fid, requestFid, expiresAt } } });
    if (key === KEYS.gasless) return offchain(fid, now + 3600);
    if (key === KEYS.expired) return offchain(fid, now - 3600);
    if (key === KEYS.mine) return offchain(fid, now + 3600);
    if (key === KEYS.appOwned) return offchain(193137, now + 3600);
    if (key === KEYS.onchain) {
      return { json: { signer: { source: "SIGNER_SOURCE_ONCHAIN", key, keyType: 1, fid, onChainEvent: { type: "EVENT_TYPE_SIGNER", fid, blockTimestamp: 1, signerEventBody: farcasterAdd } } } };
    }
    return notFound("Failed to get signer", "Active signer not found");
  },
  "/v1/onChainEventsByFid": () => ({ json: history }),
  "/v1/userDataByFid": () => ({ json: { messages: [], nextPageToken: "" } }),
});
after(() => node.close());
const hub = new Hub(node.url);
const none = new Set<string>();

test("gasless keys: requestFid straight from /v1/signer, with expiry", async () => {
  assert.deepEqual(await appFor(hub, 191, KEYS.gasless, none), { fid: 191, label: "own key", source: "gasless", status: "active" });
  assert.deepEqual(await appFor(hub, 191, KEYS.expired, none), { fid: 191, label: "own key", source: "gasless", status: "expired" });
  assert.deepEqual(await appFor(hub, 191, KEYS.appOwned, none), { fid: 193137, label: "Supercast", source: "gasless", status: "active" });
});

test("onchain keys: requestFid decoded from the KeyRegistry metadata", async () => {
  assert.deepEqual(await appFor(hub, 191, KEYS.onchain, none), { fid: 9152, label: "Farcaster", source: "onchain", status: "active" });
});

test("removed onchain keys fall back to the fid's signer history", async () => {
  assert.deepEqual(await appFor(hub, 191, KEYS.removed, none), { fid: 19528, label: "legacy-signer", source: "onchain", status: "removed" });
});

test("a key nobody lists any more is unknown", async () => {
  assert.deepEqual(await appFor(hub, 191, KEYS.revokedGasless, none), { fid: null, label: "unknown", source: "unknown", status: "removed" });
});

test("this laptop's keys are labeled threecast, even after logout revokes them", async () => {
  assert.equal((await appFor(hub, 191, KEYS.mine, new Set([KEYS.mine]))).label, "threecast");
  const revoked = `0x${"a6".repeat(32)}`;
  rememberRevokedKey(191, revoked);
  assert.deepEqual(await appFor(hub, 191, revoked, none), { fid: 191, label: "threecast", source: "gasless", status: "removed" });
});

test("answers are cached: the same signer is looked up once", async () => {
  const before = node.requests.filter((r) => r.path === "/v1/signer").length;
  await appFor(hub, 191, KEYS.onchain, none);
  await appFor(hub, 191, KEYS.onchain.toUpperCase().replace("0X", "0x"), none);
  flushAttributions();
  assert.equal(node.requests.filter((r) => r.path === "/v1/signer").length, before);
});

function post(fid: number, app: AppTag, parent: Post["parent"] = null): Post {
  return { ref: `${fid}:0x00`, fid, hash: "0x00", text: "", time: 0, author: { fid, username: null, displayName: null, pfp: null }, parent, embeds: [], app };
}

const farcaster: AppTag = { fid: 9152, label: "Farcaster", source: "onchain", status: "active" };
const base: AppTag = { fid: 309857, label: "Base App", source: "onchain", status: "active" };
const unknown: AppTag = { fid: null, label: "unknown", source: "unknown", status: "removed" };
const own = (fid: number): AppTag => ({ fid, label: "own key", source: "gasless", status: "active" });

test("app words: labels, aliases, fids, self and unknown", () => {
  assert.ok(matchesApp("farcaster", post(1, farcaster)));
  assert.ok(matchesApp("Warpcast", post(1, farcaster)));
  assert.ok(matchesApp("base", post(1, base)));
  assert.ok(matchesApp("base app", post(1, base)));
  assert.ok(matchesApp("309857", post(1, base)));
  assert.ok(matchesApp("self", post(42, own(42))));
  assert.ok(!matchesApp("self", post(42, farcaster)));
  assert.ok(matchesApp("unknown", post(1, unknown)));
  assert.ok(!matchesApp("self", post(1, unknown)));
  assert.equal(filterWord(base), "base");
  assert.equal(filterWord(farcaster), "farcaster");
  assert.equal(filterWord(own(42)), "self");
  assert.equal(filterWord(unknown), "unknown");
  assert.equal(filterWord({ fid: 77, label: "someapp", source: "onchain", status: "active" }), "77");
});

test("filters: include, exclude, unknown defaults, replies", () => {
  const posts = [post(1, farcaster), post(2, base), post(3, own(3)), post(4, unknown), post(5, farcaster, { fid: 1, hash: "0x01" }), post(6, base, { url: "https://example.com/channel" })];
  const kept = (f: Parameters<typeof passesFilter>[1]) => posts.filter((p) => passesFilter(p, f)).map((p) => p.fid);
  assert.deepEqual(kept({}), [1, 2, 3, 4, 6], "replies hidden; channel posts are not replies");
  assert.deepEqual(kept({ replies: true }), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(kept({ apps: ["farcaster"] }), [1], "unknown excluded once an include list is set");
  assert.deepEqual(kept({ apps: ["farcaster"], unknown: "include" }), [1, 4]);
  assert.deepEqual(kept({ apps: ["farcaster", "unknown"] }), [1, 4]);
  assert.deepEqual(kept({ notApps: ["base"] }), [1, 3, 4]);
  assert.deepEqual(kept({ unknown: "exclude" }), [1, 2, 3, 6]);
  assert.deepEqual(kept({ apps: ["self", "base"] }), [2, 3, 6]);
});

test("appBreakdown counts per app and puts all self-requested keys in one group", () => {
  const rows = appBreakdown([post(1, farcaster), post(2, farcaster), post(3, own(3)), post(4, own(4)), post(5, base)]);
  assert.deepEqual(rows.map((r) => [r.app.label, r.count]), [["Farcaster", 2], ["own key", 2], ["Base App", 1]]);
});
