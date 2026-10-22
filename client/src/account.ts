// threecast — MIT License
// Logging in: a TEST account's recovery phrase authorizes a new app key with one gasless KEY_ADD.
// The phrase stays in this process's memory; only the new app key is written to disk.

import { randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { Stats } from "node:fs";
import {
  FarcasterNetwork,
  MAX_KEY_TTL_SECONDS,
  MessageType,
  NobleEd25519Signer,
  ViemLocalEip712Signer,
  decodeGaslessSignedKeyRequestMetadata,
  getFarcasterTime,
  makeKeyAdd,
  makeKeyAddBody,
  makeKeyRemove,
  makeKeyRemoveBodySelfRevoke,
  validations,
  verifyGaslessKeyRequest,
} from "@farcaster/core";
import type { Message } from "@farcaster/core";
import { validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { bytesToHex, hexToBytes } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { rememberRevokedKey } from "./apps.ts";
import { TcError, unwrap } from "./errors.ts";
import { readStatus } from "./hub.ts";
import type { Hub, OnChainEventJson, SignersByFidJson } from "./hub.ts";
import { getProfile } from "./names.ts";
import { short } from "./format.ts";
import { hint, ok, readHidden, say, step, warn } from "./out.ts";
import { accountPath, loadAccount, removeAccount, saveAccount, setCurrentFid } from "./store.ts";
import type { Account } from "./store.ts";
import { checkClock, find, keyState, poll, signingFor, submitConfirmed, submitExplained } from "./write.ts";

/** What a threecast key may sign: casts, deletes, likes and recasts, follows. No profile or key changes. */
export const APP_KEY_SCOPES = [
  MessageType.CAST_ADD,
  MessageType.CAST_REMOVE,
  MessageType.REACTION_ADD,
  MessageType.REACTION_REMOVE,
  MessageType.LINK_ADD,
  MessageType.LINK_REMOVE,
];

/** 90 days, the protocol maximum. The window slides: every merged message restarts it. */
export const APP_KEY_TTL = MAX_KEY_TTL_SECONDS;

/** How long the custody signature inside a KEY_ADD or KEY_REMOVE stays valid, in seconds. */
const SIGNATURE_LIFETIME = 3600;

// Validators accept one KEY_ADD per minute per fid. A read node does not enforce it: it answers
// 200 and the validators drop the message, so threecast waits instead of retrying early.
const KEY_ADD_INTERVAL_MS = 60_000;

const ENGLISH = new Set(wordlist);

/** Farcaster time: seconds since 2021-01-01 UTC. Message timestamps and deadlines use it. */
export function farcasterNow(): Promise<number> {
  return unwrap(getFarcasterTime(), "Reading the clock");
}

/** Lowercase, single spaces. viem would derive a different key from "Word" than from "word". */
export function normalizePhrase(raw: string): string {
  return raw.trim().toLowerCase().split(/\s+/).join(" ");
}

/**
 * Throws a TcError naming what is wrong with a normalized phrase, without echoing any word.
 * viem's mnemonicToAccount accepts a bad checksum and quietly derives an unrelated address,
 * so the checksum is verified here first.
 */
export function checkPhrase(phrase: string): void {
  const words = phrase === "" ? [] : phrase.split(" ");
  if (![12, 15, 18, 21, 24].includes(words.length)) {
    throw new TcError(`That was ${words.length} word${words.length === 1 ? "" : "s"}; a recovery phrase has 12 (sometimes 24).`, "Type it again with the words separated by spaces.");
  }
  const unknown = words.flatMap((w, i) => (ENGLISH.has(w) ? [] : [i + 1]));
  if (unknown.length > 0) {
    const which = unknown.length === 1 ? `Word ${unknown[0]} is` : `Words ${unknown.join(", ")} are`;
    throw new TcError(`${which} not in the BIP-39 English word list.`, "Check those words for typos.");
  }
  if (!validateMnemonic(phrase, wordlist)) {
    throw new TcError(
      "Every word is valid, but the phrase's checksum does not match.",
      "A word is probably wrong or out of order. A wrong phrase would lead to a different, empty address, so threecast stops here.",
    );
  }
}

/** Builds and checks a self-requested gasless KEY_ADD for `appKey`, signed by `custody`. */
export async function buildKeyAdd(
  custody: ViemLocalEip712Signer,
  appKey: NobleEd25519Signer,
  request: { fid: number; nonce: number; now: number },
): Promise<Message> {
  const key = await unwrap(appKey.getSignerKey(), "Reading the new app key");
  const body = await unwrap(
    makeKeyAddBody(
      { fid: BigInt(request.fid), key, scopes: APP_KEY_SCOPES, ttl: APP_KEY_TTL, nonce: request.nonce, deadline: request.now + SIGNATURE_LIFETIME },
      custody,
    ),
    "Signing the KEY_ADD",
  );
  const custodyAddress = await unwrap(custody.getSignerKey(), "Reading the custody address");
  await checkKeyRequest(body.metadata, key, request, bytesToHex(custodyAddress));
  // The envelope is signed by the new key itself: that is its proof of possession.
  const message = await unwrap(makeKeyAdd(body, { fid: request.fid, network: FarcasterNetwork.MAINNET }, appKey), "Building the KEY_ADD");
  await unwrap(validations.validateMessage(message), "Checking the KEY_ADD");
  return message;
}

/**
 * Checks the node cannot do for us before merge. Local validation accepts metadata signed on the
 * onchain KeyRegistry domain, which then fails at merge; and a deadline in Unix seconds instead of
 * Farcaster seconds is accepted and silently lasts about 51 years.
 */
export async function checkKeyRequest(metadata: Uint8Array, key: Uint8Array, request: { fid: number; now: number }, custodyAddress: string): Promise<void> {
  const md = await unwrap(decodeGaslessSignedKeyRequestMetadata(metadata), "Decoding the key request");
  const verified = await unwrap(
    verifyGaslessKeyRequest({ requestFid: md.requestFid, key, deadline: md.deadline }, md.signature, hexToBytes(md.requestSigner)),
    "Verifying the key request",
  );
  if (!verified) throw new TcError("The key request is not signed on the gasless KeyAdd domain; the network would reject it.");
  if (Number(md.requestFid) !== request.fid || md.requestSigner.toLowerCase() !== custodyAddress.toLowerCase()) {
    throw new TcError("The key request does not name this account and its custody address as the requester.");
  }
  const lifetime = Number(md.deadline) - request.now;
  if (lifetime <= 0 || lifetime > 86_400) {
    throw new TcError(`The key request deadline is ${lifetime} s away; it must be within the next day, in Farcaster seconds.`);
  }
}

/** A KEY_REMOVE signed by the key it removes. It needs no phrase, and uses the requester's app nonce. */
export async function buildSelfRevoke(appKey: NobleEd25519Signer, request: { fid: number; nonce: number; now: number }): Promise<Message> {
  const key = await unwrap(appKey.getSignerKey(), "Reading the app key");
  const body = await unwrap(makeKeyRemoveBodySelfRevoke({ key, nonce: request.nonce, deadline: request.now + SIGNATURE_LIFETIME }), "Building the KEY_REMOVE body");
  const message = await unwrap(makeKeyRemove(body, { fid: request.fid, network: FarcasterNetwork.MAINNET }, appKey), "Signing the KEY_REMOVE");
  await unwrap(validations.validateMessage(message), "Checking the KEY_REMOVE");
  return message;
}

export interface LoginOptions {
  phraseFile?: string;
  accountIndex?: number;
}

/** The interactive login: checks the node, warns, reads the phrase, then authorizes a new key. */
export async function login(hub: Hub, options: LoginOptions = {}): Promise<Account> {
  await requireSynced(hub);
  phraseWarning();
  const phrase = await readPhrase(options.phraseFile);
  const account = await authorize(hub, phrase, { accountIndex: options.accountIndex });
  ok("Your recovery phrase was not saved anywhere.");
  return account;
}

// Shown right before the phrase is asked for, every time.
function phraseWarning(): void {
  say();
  warn("Use a TEST account, never your main one.");
  hint(
    "Typing a recovery phrase into a program is like running rm -rf: powerful and irreversible. " +
      "Whoever gets the phrase owns the account and its name for good. Only give it to code from " +
      "developers you trust, after reading what it does with it (here: client/src/account.ts).",
  );
  hint(
    "Day to day, apps should use delegated signers instead, and that is what this makes: the phrase " +
      "signs one KEY_ADD for a new app key, in memory, and is never saved or sent. The app key can " +
      "cast, like and follow, but cannot move the account or add keys.",
  );
  say();
}

export async function requireSynced(hub: Hub): Promise<void> {
  step(`Checking that your node at ${hub.url} is synced (GET /v1/info)…`);
  const status = await readStatus(hub);
  if (!status.synced) {
    throw new TcError("Your node is still syncing, so it cannot vouch for your account yet.", "Follow it with ./threecast status and try again once it reports synced.");
  }
  checkClock(hub);
  ok(`Synced (snapchain ${status.version}).`);
}

/**
 * Everything after the phrase: custody address → fid → checks → new app key → KEY_ADD → merged.
 * `waitForFid` keeps asking for a while when the fid was registered moments ago (new-account).
 */
export async function authorize(hub: Hub, phrase: string, options: { accountIndex?: number; waitForFid?: boolean } = {}): Promise<Account> {
  const index = options.accountIndex ?? 0;
  step(`Deriving your custody address (BIP-44 path m/44'/60'/0'/0/${index}, the one the Farcaster app uses)…`);
  const custody = mnemonicToAccount(phrase, { addressIndex: index });
  ok(`Custody address ${custody.address}`);

  const fid = await findFid(hub, custody.address, index, options.waitForFid ?? false);

  step(`Checking that FID ${fid} has storage (storageLimitsByFid)…`);
  const storage = await hub.get<{ units: number }>("/v1/storageLimitsByFid", { fid });
  if (!(storage.units > 0)) {
    throw new TcError(
      `FID ${fid} has no storage units, so the network would quietly drop everything it posts.`,
      "Rent one unit first (about $0.20 of ETH on Optimism, StorageRegistry.rent). The Farcaster app does this at sign-up.",
    );
  }
  ok(`${storage.units} storage unit${storage.units === 1 ? "" : "s"}.`);

  const previous = loadAccount(fid);
  if (previous) {
    const state = await keyState(hub, previous);
    if (state.state === "active") {
      setCurrentFid(fid);
      ok(`You are already logged in as FID ${fid} with an active app key (${short(previous.appKeyPublic)}). Nothing new was signed.`);
      hint("To replace the key: ./threecast logout, then ./threecast login.");
      return previous;
    }
    const wait = previous.createdAt + KEY_ADD_INTERVAL_MS - Date.now();
    if (wait > 0) {
      step(`Waiting ${Math.ceil(wait / 1000)} s: validators accept one KEY_ADD per minute per account…`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  step(`Reading FID ${fid}'s key nonce (signersByFid)…`);
  const signers = await hub.get<SignersByFidJson>("/v1/signersByFid", { fid, pageSize: 1 });
  if (signers.gaslessSignerCount >= signers.gaslessSignerLimit) {
    throw new TcError(`FID ${fid} already has ${signers.gaslessSignerCount} app keys, the most allowed.`, "Revoke some in the apps that made them, then log in again.");
  }
  const nonce = signers.currentUserNonce + 1;
  ok(`Next nonce ${nonce}.`);

  step("Creating a new Ed25519 app key on this laptop…");
  const privateKey = new Uint8Array(randomBytes(32));
  const appKey = new NobleEd25519Signer(privateKey);
  const publicKey = bytesToHex(await unwrap(appKey.getSignerKey(), "Reading the new app key"));

  step("Signing a KEY_ADD for it with your custody key (it may cast, delete, like, recast and follow; it expires after 90 days unused)…");
  const keyAdd = await buildKeyAdd(new ViemLocalEip712Signer(custody), appKey, { fid, nonce, now: await farcasterNow() });

  step(`Submitting the KEY_ADD to ${hub.url} (POST /v1/submitMessage)…`);
  await submitExplained(hub, keyAdd);
  const account: Account = {
    fid,
    custodyAddress: custody.address,
    appKeyPrivate: bytesToHex(privateKey),
    appKeyPublic: publicKey,
    nonce,
    requestFid: fid,
    createdAt: Date.now(),
  };
  // Saved before confirmation, so a slow merge never strands a key the network ends up accepting.
  saveAccount(account);
  setCurrentFid(fid);
  ok(`Accepted for relay. App key saved to ${accountPath(fid)} (mode 600).`);

  step("Waiting for the network to merge it (checking /v1/signer every 3 s, for up to 3 minutes)…");
  const started = Date.now();
  const merged = await poll(async () => (await keyState(hub, account)).state === "active", 3_000, 180_000);
  if (!merged) {
    throw new TcError(
      "Your node accepted the KEY_ADD, but the network has not merged it after 3 minutes.",
      "Check again with ./threecast whoami in a few minutes. If it is still not active, run ./threecast login again.",
    );
  }
  ok(`App key ${short(publicKey)} is active for FID ${fid} (merged after ${Math.round((Date.now() - started) / 1000)} s).`);
  return account;
}

export async function readPhrase(file: string | undefined): Promise<string> {
  let raw: string;
  if (file) {
    let stat: Stats;
    try {
      stat = statSync(file);
    } catch {
      throw new TcError(`There is no file at ${file}.`, "Check the --phrase-file path.");
    }
    if (!stat.isFile()) throw new TcError(`${file} is not a file.`, "--phrase-file takes a text file that holds the 12 words.");
    if (stat.mode & 0o077) warn(`${file} is readable by other users of this computer. chmod 600 it, and delete it once you are logged in.`);
    raw = readFileSync(file, "utf8");
  } else {
    say("Type your Farcaster account recovery phrase (12 words), then press Enter. Nothing appears while you type.");
    hint("Farcaster mobile app: Settings → Advanced. Use the account phrase, not the wallet phrase.");
    raw = await readHidden("Phrase: ");
  }
  const phrase = normalizePhrase(raw);
  checkPhrase(phrase);
  ok(`${phrase.split(" ").length} words, checksum valid.`);
  return phrase;
}

async function findFid(hub: Hub, address: string, index: number, waitForFid: boolean): Promise<number> {
  step(
    waitForFid
      ? "Waiting for your node to see the new registration (IdRegistry events; checking every 15 s, for up to 10 minutes)…"
      : "Asking your node which FID this address controls (IdRegistry events; the first lookup can take 30 s)…",
  );
  const event = waitForFid ? await waitForRegistration(hub, address) : await registrationOf(hub, address);
  if (!event) {
    throw new TcError(
      `No FID is registered to ${address}.`,
      [
        "Use the Farcaster account recovery phrase (mobile app: Settings → Advanced), not the wallet phrase.",
        index === 0 ? "If the phrase comes from another wallet app, the account may be at another index: try --account-index 1, 2, …" : "",
        "Accounts made in the Base App are held by a smart wallet and cannot log in with a phrase.",
        "No TEST account yet? ./threecast new-account makes one (about $0.20 of ETH on Optimism).",
      ].filter(Boolean).join("\n  "),
    );
  }
  const fid = event.fid;
  // The lookup returns the first event sent to this address, which is stale after a transfer.
  step(`Checking that ${short(address)} still controls FID ${fid} (fidAddressType)…`);
  const type = await hub.get<{ is_custody: boolean; is_auth: boolean; is_verified: boolean }>("/v1/fidAddressType", { fid, address });
  if (!type.is_custody) {
    if (type.is_auth || type.is_verified) {
      throw new TcError("This looks like a wallet phrase: its address is linked to the account but cannot authorize keys.", "Reveal the Farcaster account recovery phrase instead (mobile app: Settings → Advanced).");
    }
    throw new TcError(`${address} no longer controls FID ${fid}: the account was transferred or recovered.`, "Use the phrase of the address that controls it now.");
  }
  const { username } = await getProfile(hub, fid);
  ok(`FID ${fid}${username ? ` (@${username})` : ""}, and this address is its custody address.`);
  return fid;
}

async function registrationOf(hub: Hub, address: string): Promise<OnChainEventJson | undefined> {
  // On a miss the node scans every IdRegister event, which takes about 25 s on mainnet.
  return find<OnChainEventJson>(hub, "/v1/onChainIdRegistryEventByAddress", { address }, 90_000);
}

async function waitForRegistration(hub: Hub, address: string): Promise<OnChainEventJson | undefined> {
  const deadline = Date.now() + 600_000;
  for (;;) {
    const event = await registrationOf(hub, address);
    if (event || Date.now() > deadline) return event;
    await new Promise((r) => setTimeout(r, 15_000));
  }
}

/** Revokes the app key with a self-signed KEY_REMOVE, then forgets it locally. */
export async function logout(hub: Hub, account: Account): Promise<void> {
  step(`Checking app key ${short(account.appKeyPublic)} on ${hub.url} (/v1/signer)…`);
  const state = await keyState(hub, account);
  if (state.state !== "active") {
    const why = state.state === "expired" ? "it already expired, so it cannot sign anything" : "the network does not list it (revoked, or never merged)";
    ok(`Nothing to revoke: ${why}.`);
    forget(account);
    return;
  }

  checkClock(hub);
  step(`Reading the app nonce of requester FID ${account.requestFid} (signersByFid with requesterFids[]=${account.requestFid})…`);
  const signers = await hub.get<SignersByFidJson>("/v1/signersByFid", { fid: account.fid, pageSize: 1, requesterFids: [account.requestFid] });
  const nonce = (signers.requesterFidNonces?.[String(account.requestFid)] ?? 0) + 1;

  step("Signing a KEY_REMOVE with the app key itself (a self-revoke, so no recovery phrase is needed)…");
  const keyRemove = await buildSelfRevoke(signingFor(account).signer, { fid: account.fid, nonce, now: await farcasterNow() });

  step(`Submitting it to ${hub.url} and waiting for the network to merge it…`);
  const gone = async () => (await keyState(hub, account)).state === "missing";
  const { confirmed } = await submitConfirmed(hub, keyRemove, gone, { everyMs: 3_000, timeoutMs: 120_000 });
  if (!confirmed) {
    throw new TcError("The node accepted the KEY_REMOVE, but the key still shows as active.", "The local key was kept. Run ./threecast logout again in a few minutes.");
  }
  ok(`App key ${short(account.appKeyPublic)} is revoked. Casts made with it stay on the network.`);
  forget(account);
}

function forget(account: Account): void {
  // Once revoked, the node can no longer say which app a key belonged to; remember it here.
  rememberRevokedKey(account.fid, account.appKeyPublic);
  removeAccount(account.fid);
  ok(`Deleted ${accountPath(account.fid)}.`);
}
