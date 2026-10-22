// threecast — MIT License
// Local state: modes, atomic writes, the current account, caches shared between processes.

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Cache, accountPath, currentFid, listAccounts, loadAccount, loadLastFeed, removeAccount, saveAccount, saveLastFeed, savePhrase, setCurrentFid } from "../src/store.ts";
import type { Account } from "../src/store.ts";
import { TcError } from "../src/errors.ts";
import { useTempHome } from "./helpers.ts";

const home = useTempHome();
const mode = (path: string) => statSync(path).mode & 0o777;

const account: Account = {
  fid: 4242,
  custodyAddress: "0x0000000000000000000000000000000000000001",
  appKeyPrivate: `0x${"11".repeat(32)}`,
  appKeyPublic: `0x${"22".repeat(32)}`,
  nonce: 1,
  requestFid: 4242,
  createdAt: 0,
};

test("account files are 0600 in 0700 directories, with no temp files left behind", () => {
  saveAccount(account);
  assert.equal(mode(accountPath(4242)), 0o600);
  assert.equal(mode(join(home, "accounts")), 0o700);
  assert.deepEqual(loadAccount(4242), account);
  saveAccount({ ...account, nonce: 2 });
  assert.equal(loadAccount(4242)?.nonce, 2);
  assert.deepEqual(readdirSync(join(home, "accounts")).filter((f) => f.endsWith(".tmp")), []);
  assert.equal(mode(accountPath(4242)), 0o600, "still 0600 after an overwrite");
});

test("the current account must exist to count", () => {
  assert.equal(currentFid(), undefined);
  setCurrentFid(4242);
  assert.equal(currentFid(), 4242);
  assert.equal(mode(join(home, "accounts", "current")), 0o600);
  assert.deepEqual(listAccounts().map((a) => a.fid), [4242]);
  removeAccount(4242);
  assert.equal(currentFid(), undefined);
  assert.equal(loadAccount(4242), undefined);
});

test("a damaged account file is reported with the fix", () => {
  writeFileSync(accountPath(77), "{ not json");
  assert.throws(() => loadAccount(77), (e: unknown) => e instanceof TcError && /damaged/.test(e.message) && /login/.test(e.hint ?? ""));
  removeAccount(77);
});

test("caches merge on flush, so two processes do not erase each other's entries", () => {
  const first = new Cache<number>("names");
  const second = new Cache<number>("names");
  first.set("a", 1);
  second.set("b", 2);
  first.flush();
  second.flush();
  const onDisk = JSON.parse(readFileSync(join(home, "cache", "names.json"), "utf8")) as Record<string, number>;
  assert.deepEqual(onDisk, { a: 1, b: 2 });
  assert.equal(mode(join(home, "cache", "names.json")), 0o600);
  assert.equal(new Cache<number>("names").get("a"), 1);
});

test("a damaged cache is rebuilt instead of failing", () => {
  writeFileSync(join(home, "cache", "attribution.json"), "garbage");
  const cache = new Cache<number>("attribution");
  assert.equal(cache.get("x"), undefined);
  cache.set("x", 1);
  cache.flush();
  assert.equal(new Cache<number>("attribution").get("x"), 1);
});

test("last feed round-trips", () => {
  assert.equal(loadLastFeed(), undefined);
  saveLastFeed({ nodeUrl: "http://127.0.0.1:13381", at: 1, refs: ["3:0x01"] });
  assert.deepEqual(loadLastFeed()?.refs, ["3:0x01"]);
});

test("a saved phrase (new-account only) is 0600", () => {
  const path = savePhrase("0xABC", "word ".repeat(12).trim());
  assert.equal(mode(path), 0o600);
  assert.match(path, /0xabc\.phrase$/);
});
