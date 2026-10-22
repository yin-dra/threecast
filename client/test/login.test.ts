// threecast — MIT License
// login and logout against a fake node, with a phrase generated for this test only. Covers the
// happy path and every guard that stops a login before anything is signed.

import assert from "node:assert/strict";
import { chmodSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { Message, MessageType, validations } from "@farcaster/core";
import { bytesToHex } from "viem";
import { generateMnemonic, english, mnemonicToAccount } from "viem/accounts";
import { login, logout } from "../src/account.ts";
import { TcError } from "../src/errors.ts";
import { Hub } from "../src/hub.ts";
import { accountPath, currentFid, loadAccount } from "../src/store.ts";
import { mockNode, notFound, quietly, useTempHome } from "./helpers.ts";

const home = useTempHome();
const FID = 777_777;
const phrase = generateMnemonic(english);
const address = mnemonicToAccount(phrase).address;
const phraseFile = join(home, "phrase.txt");
writeFileSync(phraseFile, `${phrase}\n`);
chmodSync(phraseFile, 0o600);

let scenario: "ok" | "unsynced" | "no-fid" | "wallet" | "no-storage" = "ok";
const activeKeys = new Set<string>();
const submitted: Message[] = [];

const node = await mockNode({
  "/v1/info": () => ({
    json: {
      version: "0.14.3",
      shardInfos: [0, 1, 2].map((shardId) => ({ shardId, maxHeight: 1, numMessages: 2_000_000, blockDelay: scenario === "unsynced" && shardId === 0 ? 4000 : 1 })),
    },
  }),
  "/v1/onChainIdRegistryEventByAddress": (req) =>
    scenario === "no-fid" || req.query.get("address") !== address
      ? notFound("Failed to get id registry event", "no id-registry event for address")
      : { json: { type: "EVENT_TYPE_ID_REGISTER", fid: FID, blockTimestamp: 1, idRegisterEventBody: { to: address.toLowerCase(), from: "0x", eventType: "Register", recoveryAddress: "0x" } } },
  "/v1/fidAddressType": () => ({ json: { is_custody: scenario !== "wallet", is_auth: false, is_verified: scenario === "wallet" } }),
  "/v1/storageLimitsByFid": () => ({ json: { units: scenario === "no-storage" ? 0 : 1 } }),
  "/v1/userDataByFid": () => ({ json: { messages: [], nextPageToken: "" } }),
  "/v1/signersByFid": (req) => ({
    json: { signers: [], gaslessSignerCount: activeKeys.size, gaslessSignerLimit: 1000, currentUserNonce: 0, requesterFidNonces: req.rawQuery.includes(`requesterFids[]=${FID}`) ? { [FID]: 5 } : undefined },
  }),
  "/v1/signer": (req) => {
    const key = req.query.get("signer") ?? "";
    return activeKeys.has(key) ? { json: { signer: { source: "SIGNER_SOURCE_OFFCHAIN", key, keyType: 1, fid: FID, requestFid: FID, nonce: 1 } } } : notFound("Failed to get signer", "Active signer not found");
  },
  "/v1/submitMessage": async (req) => {
    const message = Message.decode(req.body);
    assert.ok((await validations.validateMessage(message)).isOk());
    submitted.push(message);
    const data = message.data!;
    if (data.type === MessageType.KEY_ADD) activeKeys.add(bytesToHex(data.keyAddBody!.key));
    if (data.type === MessageType.KEY_REMOVE) activeKeys.delete(bytesToHex(data.keyRemoveBody!.key));
    return { json: {} };
  },
});
after(() => node.close());
const hub = new Hub(node.url);

async function loginFails(when: typeof scenario, expected: RegExp): Promise<void> {
  scenario = when;
  const before = submitted.length;
  await assert.rejects(quietly(() => login(hub, { phraseFile })), (e: unknown) => e instanceof TcError && expected.test(`${e.message} ${e.hint}`));
  assert.equal(submitted.length, before, "nothing was submitted");
  scenario = "ok";
}

test("refuses to start against a node that is still syncing", () => loginFails("unsynced", /still syncing/));
test("explains a phrase that controls no fid", () => loginFails("no-fid", /No FID is registered.*account recovery phrase.*--account-index.*\.\/threecast new-account/s));
test("spots a wallet phrase", () => loginFails("wallet", /wallet phrase/));
test("refuses an account without storage", () => loginFails("no-storage", /no storage units/));

test("logs in: one KEY_ADD signed by the new key, confirmed, saved 0600 without the phrase", async () => {
  const account = await quietly(() => login(hub, { phraseFile }));
  assert.equal(account.fid, FID);
  assert.equal(currentFid(), FID);
  assert.equal(account.custodyAddress, address);
  const keyAdd = submitted.at(-1)!;
  assert.equal(keyAdd.data?.type, MessageType.KEY_ADD);
  assert.equal(bytesToHex(keyAdd.signer), account.appKeyPublic);
  assert.equal(keyAdd.data?.keyAddBody?.nonce, 1);
  assert.equal(statSync(accountPath(FID)).mode & 0o777, 0o600);
  const saved = JSON.stringify(loadAccount(FID));
  for (const word of phrase.split(" ")) assert.ok(!saved.includes(` ${word} `));
  assert.ok(!saved.includes(phrase));
});

test("a second login with the key still active signs nothing", async () => {
  const before = submitted.length;
  await quietly(() => login(hub, { phraseFile }));
  assert.equal(submitted.length, before);
});

test("logout self-revokes with the app nonce and deletes the local key", async () => {
  const account = loadAccount(FID)!;
  await quietly(() => logout(hub, account));
  const keyRemove = submitted.at(-1)!;
  assert.equal(keyRemove.data?.type, MessageType.KEY_REMOVE);
  assert.equal(keyRemove.data?.keyRemoveBody?.nonce, 6, "app nonce read with literal requesterFids[] brackets, plus one");
  assert.equal(bytesToHex(keyRemove.signer), account.appKeyPublic);
  assert.equal(activeKeys.size, 0);
  assert.equal(loadAccount(FID), undefined);
  assert.equal(currentFid(), undefined);
});
