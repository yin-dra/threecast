// threecast — MIT License
// Every message threecast writes, built with throwaway keys and checked with the same local
// validation the node runs. Nothing here touches the network.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import {
  CastType,
  KEY_REMOVE_SIGNATURE_TYPE_SELF,
  Message,
  MessageType,
  NobleEd25519Signer,
  ReactionType,
  ViemLocalEip712Signer,
  decodeGaslessSignedKeyRequestMetadata,
  makeKeyAddBody,
  validations,
} from "@farcaster/core";
import { bytesToHex } from "viem";
import { generateMnemonic, english, mnemonicToAccount } from "viem/accounts";
import { APP_KEY_SCOPES, APP_KEY_TTL, buildKeyAdd, buildSelfRevoke, checkKeyRequest, farcasterNow } from "../src/account.ts";
import { TcError } from "../src/errors.ts";
import { buildCast, buildCastRemove, buildFollow, buildReaction, castKind } from "../src/write.ts";
import type { Signing } from "../src/write.ts";

const FID = 999_999_999;
const custodyAccount = mnemonicToAccount(generateMnemonic(english));
const custody = new ViemLocalEip712Signer(custodyAccount);
const appKey = new NobleEd25519Signer(new Uint8Array(randomBytes(32)));
const signing: Signing = { fid: FID, signer: appKey };
const target = { fid: 218957, hash: "0x5c5b64edc095ec945bb85cd7f5eb31e7ca187045" };

async function assertValid(message: Message, type: MessageType): Promise<void> {
  assert.equal(message.data?.type, type);
  assert.equal(message.data?.fid, FID);
  assert.deepEqual((await appKey.getSignerKey())._unsafeUnwrap(), message.signer, "signed by the app key");
  assert.ok((await validations.validateMessage(message)).isOk());
  // What goes over the wire decodes back to the same message.
  const wire = Message.decode(Message.encode(message).finish());
  assert.deepEqual(wire.hash, message.hash);
}

test("KEY_ADD: self-requested, gasless domain, Farcaster-seconds deadline, signed by the new key", async () => {
  const now = await farcasterNow();
  const message = await buildKeyAdd(custody, appKey, { fid: FID, nonce: 1, now });
  await assertValid(message, MessageType.KEY_ADD);
  const body = message.data?.keyAddBody;
  assert.ok(body);
  assert.deepEqual(body.scopes, APP_KEY_SCOPES);
  assert.equal(body.ttl, APP_KEY_TTL);
  assert.equal(body.nonce, 1);
  assert.equal(body.deadline - now, 3600);
  const md = decodeGaslessSignedKeyRequestMetadata(body.metadata)._unsafeUnwrap();
  assert.equal(md.requestFid, BigInt(FID));
  assert.equal(md.requestSigner.toLowerCase(), custodyAccount.address.toLowerCase());
  assert.equal(Number(md.deadline) - now, 3600);
});

test("Farcaster time is seconds since 2021-01-01, not Unix seconds", async () => {
  const now = await farcasterNow();
  assert.ok(Math.abs(now - (Math.floor(Date.now() / 1000) - 1_609_459_200)) <= 2);
});

test("the KEY_ADD guard rejects metadata signed on the onchain domain", async () => {
  const now = await farcasterNow();
  const key = (await appKey.getSignerKey())._unsafeUnwrap();
  // This helper signs for the onchain KeyRegistry. Local validation accepts it; merge would not.
  const onchain = (await custody.getSignedKeyRequestMetadata({ requestFid: BigInt(FID), key, deadline: BigInt(now + 3600) }))._unsafeUnwrap();
  await assert.rejects(checkKeyRequest(onchain, key, { fid: FID, now }, custodyAccount.address), /gasless KeyAdd domain/);
});

test("the KEY_ADD guard rejects a deadline in Unix seconds", async () => {
  const now = await farcasterNow();
  const key = (await appKey.getSignerKey())._unsafeUnwrap();
  const unixDeadline = Math.floor(Date.now() / 1000) + 3600;
  const body = (await makeKeyAddBody({ fid: BigInt(FID), key, scopes: APP_KEY_SCOPES, ttl: APP_KEY_TTL, nonce: 1, deadline: unixDeadline }, custody))._unsafeUnwrap();
  await assert.rejects(checkKeyRequest(body.metadata, key, { fid: FID, now }, custodyAccount.address), /deadline/);
});

test("the KEY_ADD guard rejects a request made for another account", async () => {
  const now = await farcasterNow();
  const key = (await appKey.getSignerKey())._unsafeUnwrap();
  const body = (await makeKeyAddBody({ fid: BigInt(FID), key, scopes: APP_KEY_SCOPES, ttl: APP_KEY_TTL, nonce: 1, deadline: now + 3600, requestFid: 9152n }, custody))._unsafeUnwrap();
  await assert.rejects(checkKeyRequest(body.metadata, key, { fid: FID, now }, custodyAccount.address), /does not name this account/);
});

test("KEY_REMOVE (self-revoke) is signed by the key it removes and needs no custody signature", async () => {
  const message = await buildSelfRevoke(appKey, { fid: FID, nonce: 1, now: await farcasterNow() });
  await assertValid(message, MessageType.KEY_REMOVE);
  const body = message.data?.keyRemoveBody;
  assert.equal(body?.signatureType, KEY_REMOVE_SIGNATURE_TYPE_SELF);
  assert.equal(body?.signature.length, 0);
  assert.deepEqual(body?.key, message.signer);
});

test("cast and reply", async () => {
  const cast = await buildCast(signing, "gm from threecast");
  await assertValid(cast, MessageType.CAST_ADD);
  assert.equal(cast.data?.castAddBody?.type, CastType.CAST);
  assert.equal(cast.data?.castAddBody?.parentCastId, undefined);

  const reply = await buildCast(signing, "a reply", target);
  await assertValid(reply, MessageType.CAST_ADD);
  assert.equal(bytesToHex(reply.data?.castAddBody?.parentCastId?.hash ?? new Uint8Array()), target.hash);
  assert.equal(reply.data?.castAddBody?.parentCastId?.fid, target.fid);
});

test("casts over 320 bytes go out as LONG_CAST, over 1024 are refused", async () => {
  assert.deepEqual(castKind("a".repeat(320)), { type: CastType.CAST, bytes: 320 });
  assert.equal(castKind("a".repeat(321)).type, CastType.LONG_CAST);
  // Bytes, not characters: 81 four-byte emoji are 324 bytes.
  assert.equal(castKind("🙂".repeat(81)).type, CastType.LONG_CAST);
  const long = await buildCast(signing, "é".repeat(500));
  await assertValid(long, MessageType.CAST_ADD);
  assert.equal(long.data?.castAddBody?.type, CastType.LONG_CAST);
  assert.equal(castKind("a".repeat(1024)).type, CastType.LONG_CAST);
  assert.throws(() => castKind("a".repeat(1025)), (e: unknown) => e instanceof TcError && /1025 bytes/.test(e.message) && /Cut 1 byte\./.test(e.hint ?? ""));
  assert.throws(() => castKind("   "), TcError);
});

test("delete", async () => {
  const message = await buildCastRemove(signing, target.hash);
  await assertValid(message, MessageType.CAST_REMOVE);
  assert.equal(bytesToHex(message.data?.castRemoveBody?.targetHash ?? new Uint8Array()), target.hash);
});

test("like, unlike, recast, unrecast", async () => {
  const cases = [
    ["like", false, MessageType.REACTION_ADD, ReactionType.LIKE],
    ["like", true, MessageType.REACTION_REMOVE, ReactionType.LIKE],
    ["recast", false, MessageType.REACTION_ADD, ReactionType.RECAST],
    ["recast", true, MessageType.REACTION_REMOVE, ReactionType.RECAST],
  ] as const;
  for (const [kind, undo, type, reaction] of cases) {
    const message = await buildReaction(signing, kind, target, undo);
    await assertValid(message, type);
    assert.equal(message.data?.reactionBody?.type, reaction);
    assert.equal(message.data?.reactionBody?.targetCastId?.fid, target.fid);
  }
});

test("follow and unfollow", async () => {
  const follow = await buildFollow(signing, 3, false);
  await assertValid(follow, MessageType.LINK_ADD);
  assert.deepEqual([follow.data?.linkBody?.type, follow.data?.linkBody?.targetFid], ["follow", 3]);
  const unfollow = await buildFollow(signing, 3, true);
  await assertValid(unfollow, MessageType.LINK_REMOVE);
});
