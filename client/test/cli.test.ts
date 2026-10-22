// threecast — MIT License
// The command line as a process: what it prints when used the wrong way, and when its output
// is piped into head or a pager that quits before reading everything.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

test("a reader that closes the pipe early ends the command quietly", async () => {
  const child = spawn(process.execPath, [CLI, "feed", "--help"], { stdio: ["ignore", "pipe", "pipe"] });
  // Closed before the command writes anything, so its first write fails with EPIPE.
  child.stdout.destroy();
  let err = "";
  child.stderr.on("data", (d: Buffer) => (err += d.toString()));
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(err, "");
  assert.equal(code, 0);
});

test("--as on a command that signs explains that --as only reads", () => {
  const home = mkdtempSync(join(tmpdir(), "threecast-cli-"));
  const r = spawnSync(process.execPath, [CLI, "cast", "hello", "--as", "3"], {
    env: { ...process.env, THREECAST_HOME: home, NO_COLOR: "1" },
    encoding: "utf8",
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--as only reads .*cast signs with your own app key/);
  assert.match(r.stderr, /\.\/threecast login/);
});
