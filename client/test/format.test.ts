// threecast — MIT License
// Wrapping narration to the terminal's width.

import assert from "node:assert/strict";
import { test } from "node:test";
import { wrap } from "../src/format.ts";

test("short lines and width 0 are left alone", () => {
  assert.equal(wrap("✓ Synced (snapchain 0.14.3).", 80), "✓ Synced (snapchain 0.14.3).");
  assert.equal(wrap("x ".repeat(100), 0), "x ".repeat(100));
});

test("long lines break at spaces and continue under their own text", () => {
  const out = wrap("→ Asking your node which FID this address controls (IdRegistry events; the first lookup can take 30 s)…", 40);
  for (const line of out.split("\n")) assert.ok(line.length <= 40, line);
  assert.match(out, /^→ Asking/);
  assert.ok(out.split("\n").slice(1).every((line) => line.startsWith("  ") && !line.startsWith("   ")));
  assert.equal(out.replace(/\n +/g, " "), "→ Asking your node which FID this address controls (IdRegistry events; the first lookup can take 30 s)…");
});

test("indentation, explicit hanging indents, styling and embedded line breaks", () => {
  assert.equal(wrap("  one two three four", 10), "  one two\n  three\n  four");
  assert.equal(wrap("--node URL  the node to use", 26, 12), "--node URL  the node to\n            use");
  const styled = `\x1b[2m  ${"word ".repeat(10).trim()}\x1b[0m`;
  assert.ok(wrap(styled, 30).split("\n").every((line) => line.replace(/\x1b\[[0-9;]*m/g, "").length <= 30));
  assert.equal(wrap("a b\n  c d e", 4), "a b\n  c\n  d\n  e");
  assert.equal(wrap("https://example.com/a/very/long/path/that/does/not/fit", 10), "https://example.com/a/very/long/path/that/does/not/fit");
});
