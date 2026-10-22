// threecast — MIT License
// The public API end to end against a fake node that "merges" whatever is submitted, with a
// throwaway app key standing in for a logged-in account.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, test } from "node:test";
import { Message, MessageType, NobleEd25519Signer, ReactionType, validations } from "@farcaster/core";
import { bytesToHex } from "viem";
import * as api from "../src/api.ts";
import { TcError } from "../src/errors.ts";
import { saveAccount, setCurrentFid } from "../src/store.ts";
import { mockNode, notFound, useTempHome } from "./helpers.ts";
import type { MockReply } from "./helpers.ts";

useTempHome();
const ME = 4242;
const privateKey = new Uint8Array(randomBytes(32));
const publicKey = bytesToHex((await new NobleEd25519Signer(privateKey).getSignerKey())._unsafeUnwrap());
const OTHER = { fid: 3, hash: "0x0256ae66308d546514fa666cda44052abbfea066" };

// What the fake network has merged: casts by hash, reactions and follows by their target.
const casts = new Map<string, number>([[OTHER.hash, OTHER.fid]]);
const reactions = new Map<string, string>();
const follows = new Map<number, string>();
const submitted: Message[] = [];

const found = (hash: string | undefined): MockReply => (hash ? { json: { hash } } : notFound("Failed", "not found"));

const node = await mockNode({
  "/v1/submitMessage": async (req) => {
    const message = Message.decode(req.body);
    assert.ok((await validations.validateMessage(message)).isOk());
    submitted.push(message);
    const data = message.data!;
    const hash = bytesToHex(message.hash);
    if (data.type === MessageType.CAST_ADD) casts.set(hash, data.fid);
    if (data.type === MessageType.CAST_REMOVE) casts.delete(bytesToHex(data.castRemoveBody!.targetHash));
    if (data.type === MessageType.REACTION_ADD || data.type === MessageType.REACTION_REMOVE) {
      const body = data.reactionBody!;
      const key = `${body.type}:${bytesToHex(body.targetCastId!.hash)}`;
      if (data.type === MessageType.REACTION_ADD) reactions.set(key, hash);
      else reactions.delete(key);
    }
    if (data.type === MessageType.LINK_ADD) follows.set(data.linkBody!.targetFid!, hash);
    if (data.type === MessageType.LINK_REMOVE) follows.delete(data.linkBody!.targetFid!);
    return { json: { hash } };
  },
  "/v1/signer": (req) =>
    req.query.get("signer") === publicKey
      ? { json: { signer: { source: "SIGNER_SOURCE_OFFCHAIN", key: publicKey, keyType: 1, fid: ME, requestFid: ME, expiresAt: 4_000_000_000 } } }
      : notFound("Failed to get signer", "Active signer not found"),
  "/v1/castById": (req) => (casts.get(req.query.get("hash") ?? "") === Number(req.query.get("fid")) ? found(req.query.get("hash") ?? "") : notFound("Failed to get cast", "cast not found")),
  "/v1/reactionById": (req) => {
    const type = req.query.get("reaction_type") === "Like" ? ReactionType.LIKE : ReactionType.RECAST;
    return found(reactions.get(`${type}:${req.query.get("target_hash")}`));
  },
  "/v1/linkById": (req) => found(follows.get(Number(req.query.get("target_fid")))),
  "/v1/userNameProofByName": (req) => (req.query.get("name") === "dwr" ? { json: { fid: 3, name: "dwr" } } : notFound("Failed to get username proof", "Username proof not found")),
});
after(() => node.close());

test("openSession: node from the option or THREECAST_NODE; --as is read-only", async () => {
  delete process.env.THREECAST_NODE;
  await assert.rejects(api.openSession(), (e: unknown) => e instanceof TcError && /no node/.test(e.message) && /--node/.test(e.hint ?? ""));
  process.env.THREECAST_NODE = `${node.url}/`;
  assert.deepEqual(await api.openSession(), { nodeUrl: node.url, viewerFid: null, canWrite: false });
  assert.deepEqual(await api.openSession({ as: 3 }), { nodeUrl: node.url, viewerFid: 3, canWrite: false });
  await assert.rejects(api.post(await api.openSession({ as: 3 }), "hi"), /not logged in|only views/);
});

test("post, reply and delete, each confirmed by reading it back", async () => {
  saveAccount({ fid: ME, custodyAddress: "0x0000000000000000000000000000000000000001", appKeyPrivate: bytesToHex(privateKey), appKeyPublic: publicKey, nonce: 1, requestFid: ME, createdAt: 0 });
  setCurrentFid(ME);
  const s = await api.openSession({ node: node.url });
  assert.deepEqual([s.viewerFid, s.canWrite], [ME, true]);
  const cast = await api.post(s, "hello from my own node");
  assert.equal(cast.confirmed, true);
  assert.match(cast.ref, new RegExp(`^${ME}:0x[0-9a-f]{40}$`));
  const reply = await api.post(s, "replying", { replyTo: `${OTHER.fid}:${OTHER.hash}` });
  assert.equal(reply.confirmed, true);
  assert.equal(bytesToHex(submitted.at(-1)!.data!.castAddBody!.parentCastId!.hash), OTHER.hash);
  assert.deepEqual(await api.remove(s, cast.ref), { confirmed: true });
  assert.equal(casts.has(cast.ref.split(":")[1]!), false);
  await assert.rejects(api.remove(s, `${OTHER.fid}:${OTHER.hash}`), /only delete your own/);
  await assert.rejects(api.post(s, "x", { replyTo: `3:0x${"00".repeat(20)}` }), /no cast/);
});

test("like, recast and their undos", async () => {
  const s = await api.openSession({ node: node.url });
  const ref = `${OTHER.fid}:${OTHER.hash}`;
  assert.deepEqual(await api.react(s, "like", ref), { confirmed: true });
  assert.equal(reactions.size, 1);
  assert.deepEqual(await api.react(s, "recast", ref), { confirmed: true });
  assert.deepEqual(await api.react(s, "like", ref, true), { confirmed: true });
  assert.deepEqual(await api.react(s, "recast", ref, true), { confirmed: true });
  assert.equal(reactions.size, 0);
});

test("follow and unfollow by @name", async () => {
  const s = await api.openSession({ node: node.url });
  assert.deepEqual(await api.follow(s, "@dwr"), { fid: 3, confirmed: true });
  assert.equal(follows.has(3), true);
  assert.deepEqual(await api.follow(s, "3", true), { fid: 3, confirmed: true });
  assert.equal(follows.has(3), false);
  await assert.rejects(api.follow(s, "@nobody-here"), /No account is called @nobody-here/);
  await assert.rejects(api.follow(s, String(ME)), /your own account/);
});

test("@names the node knows go out as mentions; unknown ones stay plain text", async () => {
  const s = await api.openSession({ node: node.url });
  const result = await api.post(s, "gm @DWR and @nobody-here");
  assert.equal(result.confirmed, true);
  assert.deepEqual([result.mentioned, result.unknown, result.overLimit], [["dwr"], ["nobody-here"], []]);
  const body = submitted.at(-1)!.data!.castAddBody!;
  assert.deepEqual([body.text, body.mentions, body.mentionsPositions], ["gm  and @nobody-here", [3], [3]]);
  const draft = await api.draftCast(s, `${"a".repeat(318)} @dwr`);
  assert.deepEqual([draft.bytes, draft.long], [319, false]);
});

test("viewerReactions: whether the viewer liked and recast each cast", async () => {
  const s = await api.openSession({ node: node.url });
  const ref = `${OTHER.fid}:${OTHER.hash}`;
  const other = `3:0x${"ab".repeat(20)}`;
  await api.react(s, "recast", ref);
  assert.deepEqual(await api.viewerReactions(s, [ref, other]), { [ref]: { like: false, recast: true }, [other]: { like: false, recast: false } });
  await api.react(s, "recast", ref, true);
  assert.deepEqual(await api.viewerReactions(s, [ref]), { [ref]: { like: false, recast: false } });
  // A node that cannot be reached answers nothing, rather than failing the page.
  assert.deepEqual(await api.viewerReactions({ ...s, nodeUrl: "http://127.0.0.1:1" }, [ref, other]), {});
  assert.deepEqual(await api.viewerReactions({ ...s, viewerFid: null }, [ref]), {});
});

test("a write with a key the node does not list fails before submitting", async () => {
  const before = submitted.length;
  saveAccount({ fid: ME, custodyAddress: "0x0000000000000000000000000000000000000001", appKeyPrivate: `0x${"33".repeat(32)}`, appKeyPublic: `0x${"44".repeat(32)}`, nonce: 1, requestFid: ME, createdAt: 0 });
  const s = await api.openSession({ node: node.url });
  await assert.rejects(api.post(s, "hi"), (e: unknown) => e instanceof TcError && /not active/.test(e.message) && /login/.test(e.hint ?? ""));
  assert.equal(submitted.length, before);
});
