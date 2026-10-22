// threecast — MIT License
// The local web client's guards: the per-process token, the Host and Origin checks, JSON-only
// writes, the response headers, and that it listens on 127.0.0.1 only. Read-only session against
// a fake node; nothing is signed.

import assert from "node:assert/strict";
import { request } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import { connect } from "node:net";
import { networkInterfaces } from "node:os";
import { after, test } from "node:test";
import { FARCASTER_EPOCH } from "@farcaster/core";
import { startWeb } from "../src/web.ts";
import { mockNode, notFound, quietly, useTempHome } from "./helpers.ts";

useTempHome();
process.env.THREECAST_NO_OPEN = "1";

// FID 3 follows FID 10, whose two casts were signed with a key the Farcaster app (fid 9152)
// requested. The newer one claims a date in 2061.
const hash = (n: number) => `0x${String(n).padStart(40, "0")}`;
const cast = (n: number, at: number) => ({
  data: {
    type: "MESSAGE_TYPE_CAST_ADD",
    fid: 10,
    timestamp: Math.floor((at - FARCASTER_EPOCH) / 1000),
    network: "FARCASTER_NETWORK_MAINNET",
    castAddBody: { text: `cast ${n}`, type: "CAST", embeds: [], embedsDeprecated: [], mentions: [], mentionsPositions: [], parentCastId: null, parentUrl: null },
  },
  hash: hash(n),
  signer: `0x${"c".repeat(64)}`,
});
const node = await mockNode({
  "/v1/info": () => ({ json: { version: "0.14.3", shardInfos: [0, 1, 2].map((shardId) => ({ shardId, maxHeight: 1, numMessages: 2_000_000, blockDelay: 0 })) } }),
  "/v1/linksByFid": () => ({ json: { messages: [{ data: { type: "MESSAGE_TYPE_LINK_ADD", fid: 3, timestamp: 1, linkBody: { type: "follow", targetFid: 10 } } }], nextPageToken: "" } }),
  "/v1/castsByFid": () => ({ json: { messages: [cast(2, Date.UTC(2061, 8, 12)), cast(1, Date.now() - 60_000)], nextPageToken: "" } }),
  "/v1/userDataByFid": () => ({ json: { messages: [], nextPageToken: "" } }),
  "/v1/signer": () => ({ json: { signer: { source: "SIGNER_SOURCE_OFFCHAIN", key: `0x${"c".repeat(64)}`, keyType: 1, fid: 10, requestFid: 9152 } } }),
  "/v1/reactionById": (req) => (req.query.get("reaction_type") === "Like" && req.query.get("target_hash") === hash(1) ? { json: { hash: hash(9) } } : notFound("Failed to get reaction", "reaction not found")),
});
const web = await quietly(() => startWeb({ port: 47_040, session: { nodeUrl: node.url, viewerFid: 3, canWrite: false } }));
after(async () => {
  await web.close();
  await node.close();
});
const { port } = new URL(web.url);
const host = `127.0.0.1:${port}`;

interface Answer {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

// node:http rather than fetch, because fetch will not send a made-up Host header.
function call(path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: options.method ?? "GET", headers: { host, ...options.headers } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end(options.body);
  });
}

const page = await call("/");
const token = /<meta name="threecast-token" content="([0-9a-f]{64})">/.exec(page.body)?.[1] ?? "";
const withToken = { "x-threecast-token": token };

test("the page carries a fresh token and strict headers, and no CORS", () => {
  assert.equal(page.status, 200);
  assert.equal(token.length, 64);
  const csp = String(page.headers["content-security-policy"]);
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
  assert.equal(page.headers["x-frame-options"], "DENY");
  assert.equal(page.headers["x-content-type-options"], "nosniff");
  assert.ok(Object.keys(page.headers).every((name) => !name.startsWith("access-control-")));
});

test("every /api route needs the token, unknown routes and errors included", async () => {
  for (const path of ["/api/session", "/api/feed", "/api/node", "/api/nothing-here"]) {
    const answer = await call(path);
    assert.equal(answer.status, 403, path);
    assert.match(JSON.parse(answer.body).error, /token/);
    assert.ok(Object.keys(answer.headers).every((name) => !name.startsWith("access-control-")));
  }
  assert.equal((await call("/api/node", { headers: withToken })).status, 200);
  assert.equal((await call("/api/nothing-here", { headers: withToken })).status, 404);
});

test("a wrong token is refused, also one whose bytes are longer than its characters", async () => {
  assert.equal((await call("/api/session", { headers: { "x-threecast-token": "0".repeat(64) } })).status, 403);
  // "ÿ" is one character in the header but two bytes in UTF-8: refused, not a crash.
  const answer = await call("/api/session", { headers: { "x-threecast-token": `ÿ${token.slice(1)}` } });
  assert.equal(answer.status, 403, answer.body);
});

test("another Host name (DNS rebinding) or a foreign Origin is refused", async () => {
  assert.equal((await call("/", { headers: { host: `attacker.test:${port}` } })).status, 403);
  assert.equal((await call("/api/session", { headers: { ...withToken, host: `attacker.test:${port}` } })).status, 403);
  assert.equal((await call("/api/session", { headers: { ...withToken, origin: "https://attacker.test" } })).status, 403);
  assert.equal((await call("/api/session", { headers: { ...withToken, host: `localhost:${port}`, origin: `http://localhost:${port}` } })).status, 200);
});

test("writes take JSON only, small, on POST", async () => {
  const post = (type: string, body: string) => call("/api/cast", { method: "POST", headers: { ...withToken, "content-type": type }, body });
  assert.equal((await post("text/plain", '{"text":"hi"}')).status, 415);
  assert.equal((await post("application/x-www-form-urlencoded", "text=hi")).status, 415);
  assert.equal((await post("application/json", "[1]")).status, 400);
  assert.equal((await post("application/json", JSON.stringify({ text: "x".repeat(20_000) }))).status, 413);
  assert.equal((await call("/api/cast", { headers: withToken })).status, 405);
  const readOnly = await post("application/json", '{"text":"hi"}');
  assert.equal(readOnly.status, 400);
  assert.match(JSON.parse(readOnly.body).hint, /--as/);
});

test("the feed leaves out the cast dated 2061, and counts it", async () => {
  const feed = JSON.parse((await call("/api/feed", { headers: withToken })).body);
  assert.deepEqual(feed.posts.map((p: { hash: string }) => p.hash), [hash(1)]);
  assert.equal(feed.futureDated, 1);
  const own = JSON.parse((await call("/api/user-casts?user=10", { headers: withToken })).body);
  assert.deepEqual([own.posts.length, own.futureDated], [1, 1]);
});

test("app filters use the same words as --app", async () => {
  const { apps } = JSON.parse((await call("/api/apps", { headers: withToken })).body);
  assert.deepEqual(apps, [{ word: "farcaster", label: "Farcaster", fid: 9152, count: 1 }]);
  const only = JSON.parse((await call("/api/feed?app=farcaster", { headers: withToken })).body);
  assert.equal(only.posts.length, 1);
});

test("reactions: the viewer's like and recast on each cast asked about", async () => {
  const refs = `10:${hash(1)},10:${hash(2)}`;
  const answer = await call(`/api/reactions?refs=${encodeURIComponent(refs)}`, { headers: withToken });
  assert.equal(answer.status, 200, answer.body);
  assert.deepEqual(JSON.parse(answer.body), { [`10:${hash(1)}`]: { like: true, recast: false }, [`10:${hash(2)}`]: { like: false, recast: false } });
  assert.equal((await call("/api/reactions?refs=3", { headers: withToken })).status, 400);
  const tooMany = Array.from({ length: 101 }, (_, i) => `10:${hash(100 + i)}`).join(",");
  assert.equal((await call(`/api/reactions?refs=${tooMany}`, { headers: withToken })).status, 400);
});

test("only the three page files are served", async () => {
  assert.equal((await call("/static/app.js")).status, 200);
  for (const path of ["/static/../src/web.ts", "/static/%2e%2e/src/web.ts", "/static/..%2Fpackage.json", "/index.html", "/web/app.js"]) {
    assert.equal((await call(path)).status, 404, path);
  }
});

test("it listens on 127.0.0.1 only", async () => {
  const lan = Object.values(networkInterfaces())
    .flat()
    .find((a) => a && a.family === "IPv4" && !a.internal);
  if (!lan) return;
  const reached = await new Promise<boolean>((resolve) => {
    const socket = connect({ host: lan.address, port: Number(port) });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
  assert.equal(reached, false, `reachable on ${lan.address}`);
});
