// threecast — MIT License
// Cast references, the submit-then-read-back loop, and how casts are shown: mentions, times.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, test } from "node:test";
import { CastType, NobleEd25519Signer, validations } from "@farcaster/core";
import { TcError } from "../src/errors.ts";
import { insertMentions } from "../src/feed.ts";
import { ago } from "../src/format.ts";
import { Hub } from "../src/hub.ts";
import { saveLastFeed } from "../src/store.ts";
import { MAX_MENTIONS, buildCast, castKind, extractMentions, mentionTokens, parseRef, submitConfirmed } from "../src/write.ts";
import { mockNode, useTempHome } from "./helpers.ts";

useTempHome();
const HASH = "0x4f8122235ed0a713b94f407cfdde8b55b35f0998";

test("refs: fid:0xhash, or a number from the last feed", () => {
  assert.deepEqual(parseRef(`3356280:${HASH.toUpperCase().replace("0X", "0x")}`), { fid: 3356280, hash: HASH });
  assert.throws(() => parseRef("3"), (e: unknown) => e instanceof TcError && /no feed/.test(e.message) && /threecast feed/.test(e.hint ?? ""));
  saveLastFeed({ nodeUrl: "http://127.0.0.1:13381", at: 0, refs: [`2:${HASH}`, `3:${HASH}`] });
  assert.deepEqual(parseRef("2"), { fid: 3, hash: HASH });
  assert.deepEqual(parseRef("#1"), { fid: 2, hash: HASH });
  assert.throws(() => parseRef("3"), /listed 2 casts/);
  assert.throws(() => parseRef("2:0x1234"), /not a cast reference/);
});

test("mentions go back in at their UTF-8 byte offsets", () => {
  // "gm  and 🙂 " with @dwr at byte 3 and @v at byte 13 (the emoji is 4 bytes).
  assert.equal(insertMentions("gm  and 🙂 ", [{ at: 3, name: "dwr" }, { at: 13, name: "v" }]), "gm @dwr and 🙂 @v");
  assert.equal(insertMentions("hi", []), "hi");
  assert.equal(insertMentions("x", [{ at: 99, name: "far" }]), "x@far");
});

const signer = new NobleEd25519Signer(new Uint8Array(randomBytes(32)));
const message = await buildCast({ fid: 999_999_999, signer }, "hello");

const FIDS = new Map([
  ["dwr", 3],
  ["v", 2],
  ["alice", 1001],
  ["bob.eth", 1002],
]);
const NAMES = new Map([...FIDS].map(([name, fid]) => [fid, name]));

/** Typed text → signed, validated CAST_ADD → insertMentions, as a reading client would. */
async function roundTrip(typed: string, fids: ReadonlyMap<string, number> = FIDS, names: ReadonlyMap<number, string> = NAMES): Promise<string> {
  const draft = extractMentions(typed, fids);
  const built = await buildCast({ fid: 999_999_999, signer }, draft);
  assert.ok((await validations.validateMessage(built)).isOk());
  const body = built.data?.castAddBody;
  assert.ok(body);
  assert.deepEqual(body.mentions, draft.mentions);
  return insertMentions(body.text, body.mentions.map((fid, i) => ({ at: body.mentionsPositions[i] ?? -1, name: names.get(fid) ?? "?" })));
}

test("@names become mentions at UTF-8 byte offsets, and read back as typed", async () => {
  const draft = extractMentions("gm @dwr and 🙂 @v", FIDS);
  assert.deepEqual(draft, { text: "gm  and 🙂 ", mentions: [3, 2], mentionsPositions: [3, 13], mentioned: ["dwr", "v"], unknown: [], overLimit: [] });
  for (const typed of [
    "gm @dwr and 🙂 @v",
    "@dwr",
    "@dwr @v",
    "(@dwr) and \"@v\", then @alice.",
    "héllo @bob.eth, ça va? @dwr!",
    "line one\n@v on line two",
    "@dwr@v stays one word after the first",
  ]) {
    assert.equal(await roundTrip(typed), typed, typed);
  }
});

test("only real @names count: not e-mail addresses, URLs or longer words", () => {
  const names = (typed: string) => mentionTokens(typed).map((t) => t.name);
  assert.deepEqual(names("mail me@example.com or see https://example.com/@dwr"), []);
  assert.deepEqual(names("@dwr_x @dwr.base @abcdefghijklmnopq"), []);
  assert.deepEqual(names("@DWR, @v. @dwr.eth"), ["dwr", "v", "dwr.eth"]);
});

test("unknown names and mentions past the tenth stay plain text", async () => {
  const draft = extractMentions("hi @dwr and @nobody-here", FIDS);
  assert.equal(draft.text, "hi  and @nobody-here");
  assert.deepEqual(draft.unknown, ["nobody-here"]);
  assert.equal(await roundTrip("hi @dwr and @nobody-here"), "hi @dwr and @nobody-here");

  const many = new Map(Array.from({ length: 12 }, (_, i) => [`u${i}`, 100 + i] as [string, number]));
  const manyNames = new Map([...many].map(([name, fid]) => [fid, name]));
  const typed = [...many.keys()].map((name) => `@${name}`).join(" ");
  const capped = extractMentions(typed, many);
  assert.equal(capped.mentions.length, MAX_MENTIONS);
  assert.deepEqual(capped.overLimit, ["u10", "u11"]);
  assert.equal(await roundTrip(typed, many, manyNames), typed);
});

test("the size limit counts the text without the mentioned names", async () => {
  // 315 bytes typed, 311 stored: a regular cast, not a long one.
  const typed = `${"a".repeat(310)} @dwr`;
  const draft = extractMentions(typed, FIDS);
  assert.equal(castKind(draft.text, draft.mentions.length).type, CastType.CAST);
  // A cast that only mentions someone has empty text, which the network accepts.
  assert.deepEqual(castKind(extractMentions("@dwr", FIDS).text, 1), { type: CastType.CAST, bytes: 0 });
  assert.throws(() => castKind("", 0), /needs some text/);
});
const fast = { everyMs: 5, timeoutMs: 40 };

let submits = 0;
let mode: "lands" | "lands-late" | "never" = "lands";
const node = await mockNode({
  "/v1/submitMessage": () => {
    submits++;
    if (mode === "lands-late" && submits === 2) {
      return { status: 400, json: { error: "Failed to submit message", error_detail: 'status: InvalidArgument, message: "bad_request.duplicate/message has already been merged"' } };
    }
    return { json: {} };
  },
});
after(() => node.close());
const hub = new Hub(node.url);

test("confirmed as soon as the read-back sees it", async () => {
  submits = 0;
  mode = "lands";
  let reads = 0;
  const result = await submitConfirmed(hub, message, async () => ++reads >= 2, fast);
  assert.equal(result.confirmed, true);
  assert.equal(submits, 1);
});

test("resubmits once after the read-back times out; duplicate means it landed", async () => {
  submits = 0;
  mode = "lands-late";
  const result = await submitConfirmed(hub, message, async () => false, fast);
  assert.equal(result.confirmed, true);
  assert.equal(submits, 2);
});

test("gives up after two tries and says so", async () => {
  submits = 0;
  mode = "never";
  const result = await submitConfirmed(hub, message, async () => false, fast);
  assert.equal(result.confirmed, false);
  assert.equal(submits, 2);
});

test("relative times, including timestamps from the future", () => {
  const now = Date.UTC(2026, 9, 21, 12);
  assert.equal(ago(now - 30_000, now), "just now");
  assert.equal(ago(now + 120_000, now), "just now");
  assert.equal(ago(now - 5 * 60_000, now), "5m ago");
  assert.equal(ago(now - 3 * 3600_000, now), "3h ago");
  assert.equal(ago(now - 2 * 86_400_000, now), "2d ago");
  assert.equal(ago(Date.UTC(2026, 0, 2), now), "2026-01-02");
  assert.equal(ago(Date.UTC(2061, 8, 12), now), "dated 2061-09-12");
});
