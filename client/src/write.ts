// threecast — MIT License
// The messages a client writes: built and signed on this laptop, submitted to the node, then
// confirmed by reading them back, because a 200 from submitMessage only means "accepted for relay".

import {
  CastType,
  FarcasterNetwork,
  NobleEd25519Signer,
  ReactionType,
  makeCastAdd,
  makeCastRemove,
  makeLinkAdd,
  makeLinkRemove,
  makeReactionAdd,
  makeReactionRemove,
  validations,
} from "@farcaster/core";
import type { HubAsyncResult, Message } from "@farcaster/core";
import { hexToBytes } from "viem";
import { NodeError, TcError, unwrap } from "./errors.ts";
import { duration } from "./format.ts";
import type { Hub, MessageJson, SignerJson } from "./hub.ts";
import { warn } from "./out.ts";
import { loadLastFeed } from "./store.ts";
import type { Account } from "./store.ts";

export const CAST_MAX_BYTES = 320;
export const LONG_CAST_MAX_BYTES = 1024;

export interface CastId {
  fid: number;
  hash: string;
}

/** Who signs: the account's fid and its Ed25519 app key. */
export interface Signing {
  fid: number;
  signer: NobleEd25519Signer;
}

export function signingFor(account: Account): Signing {
  return { fid: account.fid, signer: new NobleEd25519Signer(hexToBytes(account.appKeyPrivate as `0x${string}`)) };
}

/**
 * Accepts "fid:0xhash" or a number from the last printed feed ("3" or "#3").
 */
export function parseRef(ref: string): CastId {
  const input = ref.trim();
  const full = /^(\d+):(0x[0-9a-fA-F]{40})$/.exec(input);
  if (full) return { fid: Number(full[1]), hash: (full[2] as string).toLowerCase() };
  const numbered = /^#?(\d+)$/.exec(input);
  if (!numbered) {
    throw new TcError(`"${ref}" is not a cast reference.`, "Use the number next to a cast in ./threecast feed (like 3), or the full fid:0xhash.");
  }
  const n = Number(numbered[1]);
  const last = loadLastFeed();
  if (!last || last.refs.length === 0) {
    throw new TcError(`There is no feed to count #${n} from yet.`, "Run ./threecast feed first, then use the number shown next to a cast.");
  }
  const picked = last.refs[n - 1];
  if (picked === undefined) {
    throw new TcError(`The last feed listed ${last.refs.length} casts, so there is no #${n}.`, "Run ./threecast feed again to see the current numbers.");
  }
  return parseRef(picked);
}

/**
 * CAST up to 320 bytes, LONG_CAST up to 1024 (open to everyone). Longer needs Pro (TEN_K_CAST).
 * `text` is the text as stored, with mentioned names taken out; a cast that only mentions
 * someone may have empty text.
 */
export function castKind(text: string, mentions = 0): { type: CastType; bytes: number } {
  const bytes = Buffer.byteLength(text, "utf8");
  if (text.trim() === "" && mentions === 0) throw new TcError("A cast needs some text.", `Example: ./threecast cast "hello from my own node"`);
  if (bytes <= CAST_MAX_BYTES) return { type: CastType.CAST, bytes };
  if (bytes <= LONG_CAST_MAX_BYTES) return { type: CastType.LONG_CAST, bytes };
  const extra = bytes - LONG_CAST_MAX_BYTES;
  throw new TcError(
    `This cast is ${bytes} bytes; Farcaster allows ${LONG_CAST_MAX_BYTES}.`,
    `Cut ${extra} byte${extra === 1 ? "" : "s"}. Sizes are UTF-8 bytes: most emoji take 4, accented letters 2.${mentions > 0 ? " Mentioned @names do not count." : ""}`,
  );
}

/** The node refuses a cast with more mentions than this ("mentions > 10"). */
export const MAX_MENTIONS = 10;

/** One "@name" in typed text: the name (lowercase, without "@") and where it sits (string indexes). */
export interface MentionToken {
  name: string;
  start: number;
  end: number;
}

// An fname (1 to 16 of a-z, 0-9 and "-") or an ENS name ending in ".eth", not running on into
// more name characters. It counts only at the start of the text or after a space, an opening
// bracket or a quote, so "me@example.com" and "https://example.com/@dwr" stay as they are.
const MENTION = /@([a-z0-9][a-z0-9-]*\.eth|[a-z0-9][a-z0-9-]{0,15})(?![\w-]|\.[a-z0-9])/gi;
const BEFORE_MENTION = /[\s([{"'“‘]/;

export function mentionTokens(typed: string): MentionToken[] {
  const tokens: MentionToken[] = [];
  for (const match of typed.matchAll(MENTION)) {
    const start = match.index;
    if (start > 0 && !BEFORE_MENTION.test(typed[start - 1] as string)) continue;
    tokens.push({ name: (match[1] as string).toLowerCase(), start, end: start + match[0].length });
  }
  return tokens;
}

/** A cast's text as the protocol stores it: each mention as an fid plus a UTF-8 byte offset. */
export interface CastText {
  text: string;
  mentions: number[];
  mentionsPositions: number[];
}

export interface Mentions extends CastText {
  /** The names turned into mentions, in order. */
  mentioned: string[];
  /** Names `fids` does not know. They stay in the text as typed. */
  unknown: string[];
  /** Known names past the tenth mention. They stay in the text as typed too. */
  overLimit: string[];
}

/**
 * Takes each @name that `fids` knows out of `typed` and records it as a mention: the account's
 * fid, and the byte offset in the remaining text where "@name" goes back in. insertMentions
 * (feed.ts) reverses this when casts are read.
 */
export function extractMentions(typed: string, fids: ReadonlyMap<string, number>): Mentions {
  const out: Mentions = { text: "", mentions: [], mentionsPositions: [], mentioned: [], unknown: [], overLimit: [] };
  const once = (list: string[], name: string) => list.includes(name) || list.push(name);
  let last = 0;
  let bytes = 0;
  for (const token of mentionTokens(typed)) {
    const fid = fids.get(token.name);
    if (fid === undefined) {
      once(out.unknown, token.name);
      continue;
    }
    if (out.mentions.length === MAX_MENTIONS) {
      once(out.overLimit, token.name);
      continue;
    }
    // "@" is ASCII, so a token never starts inside a surrogate pair or a multi-byte character.
    const before = typed.slice(last, token.start);
    out.text += before;
    bytes += Buffer.byteLength(before, "utf8");
    out.mentions.push(fid);
    out.mentionsPositions.push(bytes);
    out.mentioned.push(token.name);
    last = token.end;
  }
  out.text += typed.slice(last);
  return out;
}

const options = (s: Signing) => ({ fid: s.fid, network: FarcasterNetwork.MAINNET });
const castId = (c: CastId) => ({ fid: c.fid, hash: hexToBytes(c.hash as `0x${string}`) });

// The same checks the node runs before relaying (hash, signature, body rules), so a malformed
// message fails here with a clear step name instead of as a 400 from the node.
async function checked<M extends Message>(built: HubAsyncResult<M>, what: string): Promise<M> {
  const message = await unwrap(built, `Building the ${what}`);
  await unwrap(validations.validateMessage(message), `Checking the ${what}`);
  return message;
}

/** `cast` is plain text, or text with its mentions already taken out (extractMentions). */
export function buildCast(s: Signing, cast: string | CastText, parent?: CastId): Promise<Message> {
  const { text, mentions, mentionsPositions } = typeof cast === "string" ? { text: cast, mentions: [], mentionsPositions: [] } : cast;
  const { type } = castKind(text, mentions.length);
  const body = {
    text,
    type,
    embeds: [],
    embedsDeprecated: [],
    mentions,
    mentionsPositions,
    parentCastId: parent ? castId(parent) : undefined,
  };
  return checked(makeCastAdd(body, options(s), s.signer), parent ? "reply" : "cast");
}

export function buildCastRemove(s: Signing, hash: string): Promise<Message> {
  return checked(makeCastRemove({ targetHash: hexToBytes(hash as `0x${string}`) }, options(s), s.signer), "delete");
}

export function buildReaction(s: Signing, kind: "like" | "recast", target: CastId, undo: boolean): Promise<Message> {
  const body = { type: kind === "like" ? ReactionType.LIKE : ReactionType.RECAST, targetCastId: castId(target) };
  const built: HubAsyncResult<Message> = undo ? makeReactionRemove(body, options(s), s.signer) : makeReactionAdd(body, options(s), s.signer);
  return checked(built, undo ? `un${kind}` : kind);
}

export function buildFollow(s: Signing, targetFid: number, undo: boolean): Promise<Message> {
  const body = { type: "follow", targetFid };
  const built: HubAsyncResult<Message> = undo ? makeLinkRemove(body, options(s), s.signer) : makeLinkAdd(body, options(s), s.signer);
  return checked(built, undo ? "unfollow" : "follow");
}

/** Resolves true once `check` does, polling every `everyMs` for at most `timeoutMs`. */
export async function poll(check: () => Promise<boolean>, everyMs: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await new Promise((r) => setTimeout(r, everyMs));
    if (await check()) return true;
    if (Date.now() >= deadline) return false;
  }
}

export interface ConfirmTiming {
  everyMs: number;
  timeoutMs: number;
}

const READ_BACK: ConfirmTiming = { everyMs: 2_000, timeoutMs: 60_000 };

/**
 * Submits, then reads back until the message shows up. If it has not after a minute, submits
 * once more: a "duplicate" answer then means the first copy merged after all.
 */
export async function submitConfirmed(
  hub: Hub,
  message: Message,
  landed: () => Promise<boolean>,
  timing: ConfirmTiming = READ_BACK,
): Promise<{ confirmed: boolean; ms: number }> {
  const started = Date.now();
  for (let attempt = 1; attempt <= 2; attempt++) {
    const { duplicate } = await submitExplained(hub, message);
    if (duplicate || (await poll(landed, timing.everyMs, timing.timeoutMs))) return { confirmed: true, ms: Date.now() - started };
  }
  return { confirmed: false, ms: Date.now() - started };
}

// The node's reasons, mapped to what the user can do about them.
const SUBMIT_HINTS: [RegExp, string][] = [
  [/unknown fid/i, "Your node does not know this account yet. Shard 0 may be missing or still syncing: check ./threecast status."],
  [/invalid signer/i, "The node does not see your app key as active. If you just logged in, wait a minute; otherwise run ./threecast login."],
  [/last_used_at expired/i, "Your app key expired after going unused for 90 days. Run ./threecast login for a new one."],
  [/not in the scope/i, "Your app key is not allowed to sign this kind of message. Run ./threecast login for a key with the right scopes."],
  [/timestamp more than 10 mins/i, "Your laptop's clock is more than 10 minutes off. Turn on automatic date and time, then try again."],
  [/rate limit/i, "The network is rate-limiting this account. Wait a few minutes and try again."],
  [/is not greater than stored nonce/i, "Another key change for this account landed first. Run the command again to use a fresh nonce."],
  [/requestSigner does not match|SignedKeyRequest/i, "The phrase's address does not control this account. Check that it is the Farcaster account phrase."],
  [/active-key cap/i, "This account already has the maximum number of app keys. Revoke one in the app that made it."],
];

export async function submitExplained(hub: Hub, message: Message): Promise<{ duplicate: boolean }> {
  try {
    return await hub.submit(message);
  } catch (e) {
    if (!(e instanceof NodeError)) throw e;
    const hint = SUBMIT_HINTS.find(([pattern]) => pattern.test(e.reason))?.[1];
    throw new TcError(`Your node did not accept the message: ${e.reason}`, hint ?? "Nothing was published. Check ./threecast status, then try again.");
  }
}

/** GET that answers "does this exist": a NotFound becomes undefined, other errors propagate. */
export async function find<T>(hub: Hub, path: string, query: Record<string, string | number>, timeoutMs?: number): Promise<T | undefined> {
  try {
    return await hub.get<T>(path, query, timeoutMs);
  } catch (e) {
    if (e instanceof NodeError && e.notFound) return undefined;
    throw e;
  }
}

export function getCast(hub: Hub, c: CastId): Promise<MessageJson | undefined> {
  return find<MessageJson>(hub, "/v1/castById", { fid: c.fid, hash: c.hash });
}

export async function requireCast(hub: Hub, c: CastId): Promise<MessageJson> {
  const cast = await getCast(hub, c);
  if (!cast) throw new TcError(`Your node has no cast ${c.fid}:${c.hash}.`, "It may have been deleted, or the node may still be syncing that account.");
  return cast;
}

export type KeyState = { state: "active"; expiresAt: number | undefined } | { state: "expired"; expiresAt: number } | { state: "missing" };

/** Whether the node lists the account's key, and until when. Expired gasless keys stay listed. */
export async function keyState(hub: Hub, account: Account): Promise<KeyState> {
  const found = await find<{ signer: SignerJson }>(hub, "/v1/signer", { fid: account.fid, signer: account.appKeyPublic });
  if (!found) return { state: "missing" };
  const expiresAt = found.signer.expiresAt;
  if (expiresAt !== undefined && expiresAt * 1000 < Date.now()) return { state: "expired", expiresAt };
  return { state: "active", expiresAt };
}

// Messages carry this laptop's time, and the network rejects any more than 10 minutes off.
const CLOCK_LIMIT_MS = 10 * 60_000;
const CLOCK_WARN_MS = 60_000;
const CLOCK_FIX = "Turn on automatic date and time (macOS: System Settings → General → Date & Time).";

/** A sentence about this laptop's clock when it is a minute or more off the node's, else undefined. */
export function clockProblem(skewMs: number | null | undefined): string | undefined {
  if (skewMs === null || skewMs === undefined || Math.abs(skewMs) < CLOCK_WARN_MS) return undefined;
  const off = duration(Math.round(Math.abs(skewMs) / 1000));
  return `This laptop's clock is ${off} ${skewMs > 0 ? "ahead of" : "behind"} the node's; messages more than 10 minutes off are rejected.`;
}

/** Warns about a clock a minute off; stops before signing when it is off by more than the network allows. */
export function checkClock(hub: Hub): void {
  const problem = clockProblem(hub.clockSkewMs);
  if (!problem) return;
  if (Math.abs(hub.clockSkewMs ?? 0) >= CLOCK_LIMIT_MS) throw new TcError(problem, CLOCK_FIX);
  warn(`${problem} ${CLOCK_FIX}`);
}

/** Fails early, with the fix, when the app key cannot sign: missing on the node, or expired. */
export async function requireActiveKey(hub: Hub, account: Account): Promise<void> {
  const key = await keyState(hub, account);
  checkClock(hub);
  if (key.state === "missing") {
    throw new TcError(
      `Your app key for FID ${account.fid} is not active on ${hub.url}.`,
      "If you logged in a minute ago, it may still be merging: try again shortly. Otherwise run ./threecast login.",
    );
  }
  if (key.state === "expired") {
    throw new TcError(`Your app key for FID ${account.fid} expired on ${new Date(key.expiresAt * 1000).toDateString()}.`, "Run ./threecast login to authorize a new one.");
  }
}

export async function reactionHash(hub: Hub, fid: number, kind: "like" | "recast", target: CastId): Promise<string | undefined> {
  const reaction = await find<MessageJson>(hub, "/v1/reactionById", {
    fid,
    reaction_type: kind === "like" ? "Like" : "Recast",
    target_fid: target.fid,
    target_hash: target.hash,
  });
  return reaction?.hash;
}

export async function followHash(hub: Hub, fid: number, targetFid: number): Promise<string | undefined> {
  const link = await find<MessageJson>(hub, "/v1/linkById", { fid, link_type: "follow", target_fid: targetFid });
  return link?.hash;
}
