// threecast — MIT License
// The attribution cache across rechecks: a gasless key revoked since it was cached keeps the app
// it was seen with, and entries are per (fid, key), so one fid's answer never labels another's.
// Its own file, because the cache is read from disk once per process.

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { appFor } from "../src/apps.ts";
import { Hub } from "../src/hub.ts";
import { mockNode, notFound, useTempHome } from "./helpers.ts";

const home = useTempHome();
const REVOKED = `0x${"c1".repeat(32)}`;
const UNKNOWN = `0x${"c2".repeat(32)}`;
const DAY_AND_A_BIT = 25 * 3600_000;
mkdirSync(join(home, "cache"), { recursive: true });
writeFileSync(
  join(home, "cache", "attribution.json"),
  JSON.stringify({
    [`191:${REVOKED}`]: { appFid: 193137, source: "gasless", status: "active", at: Date.now() - DAY_AND_A_BIT },
    [`191:${UNKNOWN}`]: { appFid: null, source: "unknown", status: "removed", at: Date.now() - 2 * 3600_000 },
  }),
);

// The node no longer knows either key, except that UNKNOWN has since been seen (the node caught up).
const node = await mockNode({
  "/v1/signer": (req) =>
    req.query.get("signer") === UNKNOWN && req.query.get("fid") === "191"
      ? { json: { signer: { source: "SIGNER_SOURCE_OFFCHAIN", key: UNKNOWN, keyType: 1, fid: 191, requestFid: 9152 } } }
      : notFound("Failed to get signer", "Active signer not found"),
  "/v1/onChainEventsByFid": () => ({ json: { events: [] } }),
  "/v1/userDataByFid": () => ({ json: { messages: [], nextPageToken: "" } }),
});
after(() => node.close());
const hub = new Hub(node.url);
const none = new Set<string>();

test("a revoked gasless key keeps the app it was seen with", async () => {
  assert.deepEqual(await appFor(hub, 191, REVOKED, none), { fid: 193137, label: "Supercast", source: "gasless", status: "removed" });
});

test("the same key under another fid is looked up on its own", async () => {
  assert.deepEqual(await appFor(hub, 192, REVOKED, none), { fid: null, label: "unknown", source: "unknown", status: "removed" });
});

test("an unknown answer is checked again within hours, not days", async () => {
  assert.deepEqual(await appFor(hub, 191, UNKNOWN, none), { fid: 9152, label: "Farcaster", source: "gasless", status: "active" });
});
