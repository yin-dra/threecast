// threecast — MIT License
// The HTTP client against a fake node: query encoding, both pagination styles, error shapes,
// and the exact bytes and header of a submit.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { Message, NobleEd25519Signer, validations } from "@farcaster/core";
import { bytesToHex } from "viem";
import { NodeError, TcError } from "../src/errors.ts";
import { Hub, buildQuery, isLastPage, normalizeNodeUrl, readStatus } from "../src/hub.ts";
import type { MessageJson } from "../src/hub.ts";
import { buildCast } from "../src/write.ts";
import { mockNode, notFound } from "./helpers.ts";

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");

test("query strings follow the node's strict serde_qs rules", () => {
  assert.equal(buildQuery({ fid: 3, reverse: true, pageSize: 10 }), "fid=3&reverse=true&pageSize=10");
  assert.equal(buildQuery({ reverse: false }), "reverse=false");
  // Literal brackets: the percent-encoded form is silently ignored by the node.
  assert.equal(buildQuery({ fid: 280, requesterFids: [280, 3] }), "fid=280&requesterFids[]=280&requesterFids[]=3");
  // Page tokens are standard base64; + and / and = must survive.
  assert.equal(buildQuery({ pageToken: "AwAAAAMB+/qBm=" }), "pageToken=AwAAAAMB%2B%2FqBm%3D");
  assert.equal(buildQuery({ pageToken: undefined, fid: 1 }), "fid=1");
});

test("isLastPage understands both token styles", () => {
  // Single-shard routes end with "".
  assert.equal(isLastPage(""), true);
  assert.equal(isLastPage(undefined), true);
  assert.equal(isLastPage(null), true);
  assert.equal(isLastPage("AwAAAAMBCuR3qgJWrmYwjVRlFPpmbNpEBSq7/qBm"), false);
  // Fan-out routes never send "": they end with base64 of [null,null].
  assert.equal(isLastPage("W251bGwsbnVsbF0="), true);
  assert.equal(isLastPage(b64([null, null, null])), true);
  assert.equal(isLastPage(b64([[4, 0, 0, 41], null])), false);
  // signersByFid's token is a JSON object, which is not the end either.
  assert.equal(isLastPage(b64({ onchain: [12, 1], gasless: null })), false);
});

test("node URLs are validated and reduced to their origin", () => {
  assert.equal(normalizeNodeUrl("http://127.0.0.1:13381/"), "http://127.0.0.1:13381");
  assert.equal(normalizeNodeUrl(" https://snap.farcaster.xyz:3381 "), "https://snap.farcaster.xyz:3381");
  assert.throws(() => normalizeNodeUrl("snap.farcaster.xyz"), TcError);
  assert.throws(() => normalizeNodeUrl("ftp://x"), TcError);
});

const pagesSeen: string[] = [];
const node = await mockNode({
  "/v1/castsByFid": (req) => {
    pagesSeen.push(req.rawQuery);
    const token = req.query.get("pageToken");
    const cast = (n: number): MessageJson => ({ data: { type: "MESSAGE_TYPE_CAST_ADD", fid: 3, timestamp: n, network: "FARCASTER_NETWORK_MAINNET" }, hash: `0x${n}`, signer: "0x01" });
    if (!token) return { json: { messages: [cast(1), cast(2)], nextPageToken: "Ab+/c=" } };
    return { json: { messages: [cast(3)], nextPageToken: "" } };
  },
  "/v1/castsByParent": (req) => {
    const token = req.query.get("pageToken");
    const msg: MessageJson = { data: { type: "MESSAGE_TYPE_CAST_ADD", fid: 9, timestamp: 1, network: "" }, hash: "0x09", signer: "0x01" };
    return { json: { messages: [msg], nextPageToken: token ? "W251bGwsbnVsbF0=" : b64([[1, 2], null]) } };
  },
  "/v1/castById": () => notFound("Failed to get cast", "cast not found"),
  "/v1/reactionsByFid": () => ({ status: 400, text: "Invalid query parameters: missing field `reaction_type`" }),
  "/v1/info": () => ({
    json: {
      version: "0.14.3",
      shardInfos: [
        { shardId: 0, maxHeight: 9, numMessages: 12_671_345, blockDelay: 1 },
        { shardId: 2, maxHeight: 9, numMessages: 455_648_188, blockDelay: 0 },
        { shardId: 1, maxHeight: 9, numMessages: 458_631_061, blockDelay: 3 },
      ],
    },
  }),
});
after(() => node.close());

test("pages() follows single-shard tokens until \"\" and sends them URL-encoded", async () => {
  const hub = new Hub(node.url);
  const all: MessageJson[] = [];
  for await (const page of hub.pages("/v1/castsByFid", { fid: 3, reverse: true }, 2)) all.push(...page);
  assert.deepEqual(all.map((m) => m.data.timestamp), [1, 2, 3]);
  assert.equal(pagesSeen[1], "fid=3&reverse=true&pageSize=2&pageToken=Ab%2B%2Fc%3D");
});

test("pages() stops on the fan-out [null,null] token", async () => {
  const hub = new Hub(node.url);
  let pages = 0;
  for await (const _page of hub.pages("/v1/castsByParent", { fid: 1, hash: "0x01" }, 1)) pages++;
  assert.equal(pages, 2);
});

test("not-found is a 400 with a gRPC status inside, parsed into NodeError.notFound", async () => {
  const hub = new Hub(node.url);
  const error = await hub.get("/v1/castById", { fid: 3, hash: "0x00" }).catch((e: unknown) => e);
  assert.ok(error instanceof NodeError);
  assert.equal(error.status, 400);
  assert.equal(error.notFound, true);
  assert.equal(error.reason, "cast not found");
});

test("query-parse errors are plain text and are not mistaken for not-found", async () => {
  const hub = new Hub(node.url);
  const error = await hub.get("/v1/reactionsByFid", { fid: 3 }).catch((e: unknown) => e);
  assert.ok(error instanceof NodeError);
  assert.equal(error.notFound, false);
  assert.match(error.reason, /missing field `reaction_type`/);
});

test("an unreachable node is a TcError with a next step", async () => {
  const closed = await mockNode({});
  await closed.close();
  const hub = new Hub(closed.url);
  const error = await hub.get("/v1/info").catch((e: unknown) => e);
  assert.ok(error instanceof TcError);
  assert.equal(error.message, `Nothing is listening at ${closed.url}.`);
  assert.match(error.hint ?? "", /threecast status/);
});

test("a tunnel with nothing behind it says the node is not running yet", async () => {
  // What ssh -L does when the server's 3381 refuses: accept here, then hang up.
  const tunnel = createServer((socket) => socket.end());
  await new Promise<void>((resolve) => tunnel.listen(0, "127.0.0.1", resolve));
  after(() => tunnel.close());
  const { port } = tunnel.address() as AddressInfo;
  const error = await new Hub(`http://127.0.0.1:${port}`).get("/v1/info").catch((e: unknown) => e);
  assert.ok(error instanceof TcError);
  assert.equal(error.message, `http://127.0.0.1:${port} closed the connection without answering.`);
  assert.match(error.hint ?? "", /not running yet.*threecast status/);
});

test("readStatus sorts shards and applies the sync gate", async () => {
  const status = await readStatus(new Hub(node.url));
  assert.deepEqual(status.shards.map((s) => s.id), [0, 1, 2]);
  assert.equal(status.synced, true);
  assert.equal(status.version, "0.14.3");
});

test("submit() posts the protobuf bytes as application/octet-stream; duplicate counts as landed", async () => {
  let replies = 0;
  const received: Buffer[] = [];
  const submitNode = await mockNode({
    "/v1/submitMessage": (req) => {
      received.push(req.body);
      assert.equal(req.method, "POST");
      assert.equal(req.headers["content-type"], "application/octet-stream");
      replies++;
      if (replies === 1) return { json: { hash: "0x00" } };
      if (replies === 2) {
        return { status: 400, json: { error: "Failed to submit message", error_detail: 'status: InvalidArgument, message: "bad_request.duplicate/message has already been merged", details: [], metadata: MetadataMap { headers: {} }' } };
      }
      return { status: 400, json: { error: "Failed to submit message", error_detail: 'status: InvalidArgument, message: "bad_request.validation_failure/invalid signer", details: [], metadata: MetadataMap { headers: {} }' } };
    },
  });
  try {
    const signer = new NobleEd25519Signer(new Uint8Array(randomBytes(32)));
    const message = await buildCast({ fid: 999_999_999, signer }, "hello");
    const hub = new Hub(submitNode.url);
    assert.deepEqual(await hub.submit(message), { duplicate: false });
    assert.deepEqual(await hub.submit(message), { duplicate: true });
    const rejected = await hub.submit(message).catch((e: unknown) => e);
    assert.ok(rejected instanceof NodeError);
    assert.equal(rejected.code, "bad_request.validation_failure");
    assert.equal(rejected.reason, "invalid signer");

    const decoded = Message.decode(received[0] as Buffer);
    assert.ok((await validations.validateMessage(decoded)).isOk(), "the node could validate what it received");
    assert.equal(bytesToHex(decoded.hash), bytesToHex(message.hash));
    assert.equal(decoded.data?.castAddBody?.text, "hello");
  } finally {
    await submitNode.close();
  }
});
