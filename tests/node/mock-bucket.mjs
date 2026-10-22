// threecast — MIT License
// A stand-in for the public snapshot bucket, for tests/node/restore-mock.sh.
//
//   node mock-bucket.mjs <dir with shard-0.tar shard-1.tar shard-2.tar> <scenario> <port-file>
//
// Each shard's tar is cut at arbitrary byte offsets and every piece is gzipped
// on its own, the way snapchain's MultiChunkWriter does it. Responses carry
// ETag = md5(body), as R2 does. One line of JSON per request goes to stdout.
//
// Scenarios:
//   happy          everything is served correctly (so is any unknown name)
//   bad-etag-once  shard 0 chunk_0002.bin has a wrong ETag on its first request only
//   bad-etag       shard 1 chunk_0003.bin always has a wrong ETag
//   rotate         after 3 chunk requests, shard 1 publishes a new snapshot
//                  (new key, different cuts) and its old chunks start to 404
//   rotate-always  shard 1 does that again on every attempt
//   cut-once       shard 2 chunk_0002.bin breaks off half-way on its first request
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const [dir, scenario, portFile] = process.argv.slice(2);
const NETWORK = "FARCASTER_NETWORK_MAINNET";
const md5 = (buf) => createHash("md5").update(buf).digest("hex");

// Deterministic cut sizes between 40,000 and 160,000 bytes, different per seed.
function cut(tar, seed) {
  const pieces = [];
  let x = seed * 7919 + 17;
  for (let at = 0; at < tar.length; ) {
    x = (x * 1103515245 + 12345) % 2147483648;
    const size = 40000 + (x % 120000);
    pieces.push(gzipSync(tar.subarray(at, at + size)));
    at += size;
  }
  return pieces;
}

const shards = [0, 1, 2].map((id) => ({ id, tar: readFileSync(`${dir}/shard-${id}.tar`), generation: -1 }));

function publish(shard) {
  shard.generation += 1;
  shard.key = `${NETWORK}/${shard.id}/snapshot-test-${shard.id}-gen${shard.generation}.tar.gz`;
  shard.chunks = cut(shard.tar, shard.id * 100 + shard.generation);
  shard.served = 0;
}
shards.forEach(publish);

let inflight = 0;
const firstRequest = new Set();

function chunkResponse(shard, index) {
  const body = shard.chunks[index];
  let etag = md5(body);
  const url = `${shard.key}/${index}`;
  const wrong =
    (scenario === "bad-etag" && shard.id === 1 && index === 2) ||
    (scenario === "bad-etag-once" && shard.id === 0 && index === 1 && !firstRequest.has(url));
  firstRequest.add(url);
  if (wrong) etag = "0".repeat(32);
  return { body, etag };
}

function rotateIfDue(shard) {
  shard.served += 1;
  const due = shard.id === 1 && shard.served === 3;
  if (due && (scenario === "rotate-always" || (scenario === "rotate" && shard.generation === 0))) {
    publish(shard);
  }
}

const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname).slice(1);
  const log = (status, extra = {}) =>
    process.stdout.write(JSON.stringify({ method: req.method, path, status, ...extra }) + "\n");

  const meta = path.match(/^FARCASTER_NETWORK_MAINNET\/(\d)\/latest\.json$/);
  if (meta) {
    const shard = shards[Number(meta[1])];
    const names = shard.chunks.map((_, i) => `chunk_${String(i + 1).padStart(4, "0")}.bin`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ key_base: shard.key, chunks: names, timestamp: Date.now() }));
    log(200, { key: shard.key });
    return;
  }

  const chunk = path.match(/^(.+)\/chunk_(\d{4})\.bin$/);
  const shard = chunk && shards.find((s) => s.key === chunk[1]);
  const index = chunk ? Number(chunk[2]) - 1 : -1;
  if (!shard || index < 0 || index >= shard.chunks.length) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Object not found");
    log(404);
    return;
  }

  inflight += 1;
  log(200, { inflight });
  const cutOff = scenario === "cut-once" && shard.id === 2 && index === 1 && !firstRequest.has(`${shard.key}/${index}`);
  const { body, etag } = chunkResponse(shard, index);
  rotateIfDue(shard);
  if (cutOff) {
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": body.length, ETag: `"${etag}"` });
    res.write(body.subarray(0, body.length >> 1), () => { inflight -= 1; res.destroy(); });
    return;
  }
  // A short delay so that parallel downloads overlap and the test can see it.
  setTimeout(() => {
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": body.length, ETag: `"${etag}"` });
    res.end(body, () => (inflight -= 1));
  }, 40);
});

server.listen(0, "127.0.0.1", () => writeFileSync(portFile, String(server.address().port)));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
