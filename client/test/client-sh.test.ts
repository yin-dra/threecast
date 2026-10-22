// threecast — MIT License
// lib/client.sh under /bin/bash (3.2 on macOS), with the tunnel functions from lib/remote.sh
// stubbed and a fake node standing in for the real one.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { mockNode } from "./helpers.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "threecast-sh-"));

// Sources the real helpers, stubs what other files provide, then runs "$@".
const harness = join(scratch, "harness.sh");
writeFileSync(
  harness,
  `set -euo pipefail
TC_ROOT=${JSON.stringify(ROOT.replace(/\/$/, ""))}
export TC_ROOT
. "$TC_ROOT/lib/common.sh"
. "$TC_ROOT/lib/client.sh"
usage() { echo "USAGE"; }
tunnel_up() { echo "TUNNEL_UP"; }
tunnel_url() { echo "$FAKE_TUNNEL_URL"; }
tc_init_home
"$@"
`,
);

let synced = true;
const node = await mockNode({
  "/v1/info": () => ({
    json: { version: "0.14.3", shardInfos: [0, 1, 2].map((shardId) => ({ shardId, maxHeight: 1, numMessages: 2_000_000, blockDelay: synced ? 0 : 7200 })) },
  }),
});
after(() => node.close());

// Asynchronous on purpose: the fake node lives in this process and must keep answering.
function run(args: string[], options: { home?: string; env?: Record<string, string> } = {}): Promise<{ code: number | null; out: string; err: string; all: string }> {
  const home = options.home ?? mkdtempSync(join(scratch, "home-"));
  const env: Record<string, string | undefined> = { ...process.env, THREECAST_HOME: home, FAKE_TUNNEL_URL: node.url, NO_COLOR: "1", ...options.env };
  if (!options.env?.THREECAST_NODE) delete env.THREECAST_NODE;
  const child = spawn("/bin/bash", [harness, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.on("data", (d: Buffer) => (out += d.toString()));
  child.stderr.on("data", (d: Buffer) => (err += d.toString()));
  return new Promise((resolve) => child.on("close", (code) => resolve({ code, out, err, all: out + err })));
}

function homeWithTarget(): string {
  const home = mkdtempSync(join(scratch, "home-"));
  mkdirSync(join(home, "targets"), { recursive: true });
  writeFileSync(join(home, "targets", "threecast.env"), "NAME=threecast\nHOST=203.0.113.7\n");
  return home;
}

test("runs under the bash that ships with macOS", () => {
  const version = spawnSync("/bin/bash", ["-c", "echo $BASH_VERSION"], { encoding: "utf8" }).stdout.trim();
  assert.match(version, /^\d+\./);
  assert.equal(spawnSync("/bin/bash", ["-n", join(ROOT, "lib/client.sh")]).status, 0);
});

test("an unknown command prints the usage and fails", async () => {
  const r = await run(["client_passthrough", "bogus"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /There is no command 'bogus'/);
  assert.match(r.all, /USAGE/);
});

test("--help never opens a tunnel", async () => {
  const r = await run(["client_passthrough", "feed", "--help"], { home: homeWithTarget() });
  assert.equal(r.code, 0);
  assert.match(r.out, /Usage: \.\/threecast feed/);
  assert.doesNotMatch(r.out, /TUNNEL_UP/);
});

test("whoami works with no server and no node", async () => {
  const r = await run(["client_passthrough", "whoami"]);
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /Not logged in/);
  assert.doesNotMatch(r.out, /TUNNEL_UP/);
});

test("a read with no server and no --node says to run up first", async () => {
  const r = await run(["client_passthrough", "feed", "--as", "3"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /No server named 'threecast' yet/);
  assert.match(r.err, /threecast up/);
});

test("--node skips the tunnel", async () => {
  const r = await run(["client_passthrough", "profile", "@x", "--node", "http://127.0.0.1:9"], { home: homeWithTarget() });
  assert.doesNotMatch(r.out, /TUNNEL_UP/);
});

test("client on a node that is still syncing offers the public read-only preview", async () => {
  synced = false;
  const r = await run(["cmd_client"], { home: homeWithTarget() });
  synced = true;
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /TUNNEL_UP/);
  assert.match(r.err, /answers but is not synced yet/);
  assert.match(r.out, /feed --node https:\/\/snap\.farcaster\.xyz:3381 --as 3/);
  assert.match(r.out, /threecast status/);
});

test("client with no account goes to login, which needs a terminal for the phrase", async () => {
  const r = await run(["cmd_client"], { home: homeWithTarget() });
  assert.equal(r.code, 1, r.all);
  assert.match(r.out, /is synced/);
  assert.match(r.out, /no app key yet/);
  assert.match(r.err, /There is no terminal to type the phrase into/);
  assert.match(r.err, /--phrase-file/);
});

test("client rejects options it does not know", async () => {
  const r = await run(["cmd_client", "--frobnicate"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /does not take '--frobnicate'/);
});

test("an old Node.js is caught with the fix", async () => {
  const bin = mkdtempSync(join(scratch, "bin-"));
  writeFileSync(join(bin, "node"), '#!/bin/sh\ncase "$1" in -p) echo 22 ;; --version) echo v22.1.0 ;; esac\n');
  chmodSync(join(bin, "node"), 0o755);
  const r = await run(["client_need_node"], { env: { PATH: `${bin}:/usr/bin:/bin` } });
  assert.equal(r.code, 1);
  assert.match(r.err, /v22\.1\.0 is too old/);
  assert.match(r.err, /nvm install 24/);
});

test("npm ci runs only when the lockfile is newer than the last install", () => {
  const root = mkdtempSync(join(scratch, "root-"));
  mkdirSync(join(root, "client", "node_modules"), { recursive: true });
  mkdirSync(join(root, "lib"));
  const bin = mkdtempSync(join(scratch, "bin-"));
  writeFileSync(join(bin, "npm"), '#!/bin/sh\necho "NPM $*"\ntouch node_modules/.package-lock.json\n');
  chmodSync(join(bin, "npm"), 0o755);
  const deps = `. ${JSON.stringify(join(ROOT, "lib/common.sh"))}; . ${JSON.stringify(join(ROOT, "lib/client.sh"))}; TC_ROOT=${JSON.stringify(root)}; client_deps`;
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  const lock = join(root, "client", "package-lock.json");
  writeFileSync(lock, "{}");
  const first = spawnSync("/bin/bash", ["-c", deps], { env, encoding: "utf8" });
  assert.match(first.stdout, /NPM ci --omit=dev/);
  const second = spawnSync("/bin/bash", ["-c", deps], { env, encoding: "utf8" });
  assert.doesNotMatch(second.stdout, /NPM/);
});
