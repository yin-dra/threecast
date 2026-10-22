// threecast — MIT License
// The laptop's clock against the node's (its Date header). Messages more than 10 minutes off are
// rejected by the network, so writes stop before signing, and a smaller offset is a warning.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, test } from "node:test";
import { Writable } from "node:stream";
import { NobleEd25519Signer } from "@farcaster/core";
import { bytesToHex } from "viem";
import * as api from "../src/api.ts";
import { TcError } from "../src/errors.ts";
import { Hub, readStatus } from "../src/hub.ts";
import { sink } from "../src/out.ts";
import { saveAccount, setCurrentFid } from "../src/store.ts";
import { checkClock, clockProblem } from "../src/write.ts";
import { mockNode, useTempHome } from "./helpers.ts";

useTempHome();
const ME = 5151;
const privateKey = new Uint8Array(randomBytes(32));
const publicKey = bytesToHex((await new NobleEd25519Signer(privateKey).getSignerKey())._unsafeUnwrap());
saveAccount({ fid: ME, custodyAddress: "0x0", appKeyPrivate: bytesToHex(privateKey), appKeyPublic: publicKey, nonce: 1, requestFid: ME, createdAt: 0 });
setCurrentFid(ME);

// How far this laptop runs ahead of the fake node (negative: behind).
let laptopAheadMs = 0;
let submits = 0;
const nodeDate = () => ({ date: new Date(Date.now() - laptopAheadMs).toUTCString() });
const node = await mockNode({
  "/v1/info": () => ({ headers: nodeDate(), json: { version: "0.14.3", shardInfos: [0, 1, 2].map((shardId) => ({ shardId, maxHeight: 1, numMessages: 2_000_000, blockDelay: 0 })) } }),
  "/v1/signer": () => ({ headers: nodeDate(), json: { signer: { source: "SIGNER_SOURCE_OFFCHAIN", key: publicKey, keyType: 1, fid: ME, requestFid: ME } } }),
  "/v1/submitMessage": () => {
    submits++;
    return { json: {} };
  },
});
after(() => node.close());

test("the node's Date header gives the offset", async () => {
  laptopAheadMs = 15 * 60_000;
  const status = await readStatus(new Hub(node.url));
  assert.ok(status.clockSkewMs !== null && Math.abs(status.clockSkewMs - laptopAheadMs) < 3000);
  assert.match(clockProblem(status.clockSkewMs) ?? "", /15 min ahead of the node's/);
  assert.match(clockProblem(-status.clockSkewMs) ?? "", /15 min behind the node's/);
  assert.equal(clockProblem(5000), undefined);
  assert.equal(clockProblem(null), undefined);
});

test("a clock more than 10 minutes off stops a write before anything is signed", async () => {
  const session = await api.openSession({ node: node.url });
  for (const offset of [11 * 60_000, -11 * 60_000]) {
    laptopAheadMs = offset;
    await assert.rejects(api.post(session, "hello"), (e: unknown) => e instanceof TcError && /clock/.test(e.message) && /automatic date and time/.test(e.hint ?? ""));
  }
  assert.equal(submits, 0);
});

test("a clock a few minutes off is a warning, not a stop", async () => {
  laptopAheadMs = 3 * 60_000;
  const hub = new Hub(node.url);
  await hub.get("/v1/info");
  let said = "";
  const { err } = sink;
  sink.err = new Writable({ write: (chunk, _encoding, done) => ((said += String(chunk)), done()) });
  try {
    checkClock(hub);
  } finally {
    sink.err = err;
  }
  assert.match(said, /^! This laptop's clock is 3 min ahead/);
});
