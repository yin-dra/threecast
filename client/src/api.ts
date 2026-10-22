// threecast — MIT License
// The client's public surface. The CLI (cli.ts) and the local web client (web.ts) both build on
// these functions only, so they read and write in exactly the same way.

import { CastType } from "@farcaster/core";
import { bytesToHex } from "viem";
import { appBreakdown as breakdown, flushAttributions } from "./apps.ts";
import { NodeError, TcError } from "./errors.ts";
import { PARALLEL, followsOf, mapLimit, homeFeed as readHomeFeed, userCasts as readUserCasts } from "./feed.ts";
import { Hub, normalizeNodeUrl, readStatus } from "./hub.ts";
import type { NodeStatus } from "./hub.ts";
import { fidByName, flushNames, getProfile, resolveFid } from "./names.ts";
import { currentFid, listAccounts, loadAccount } from "./store.ts";
import type { Account } from "./store.ts";
import {
  buildCast,
  buildCastRemove,
  buildFollow,
  buildReaction,
  castKind,
  extractMentions,
  followHash,
  getCast,
  mentionTokens,
  parseRef,
  reactionHash,
  requireActiveKey,
  requireCast,
  signingFor,
  submitConfirmed,
} from "./write.ts";
import type { Mentions } from "./write.ts";

export { TcError };
/** The word that selects an app in a FeedFilter and after --app: "farcaster", "base", "self", "unknown" or an app fid. */
export { filterWord } from "./apps.ts";

/** Who wrote a post. Fields are null when the account has not set them. */
export interface Author {
  fid: number;
  username: string | null;
  displayName: string | null;
  pfp: string | null;
}

/**
 * The app behind a post, from the key that signed it. `fid` is the app's fid (null when it
 * cannot be told), `label` a display name such as "Farcaster", "Base App", "own key" (a key the
 * author requested for themselves) or "threecast" (a key made on this laptop). `source` says how
 * it was found: a gasless KEY_ADD, an onchain KeyRegistry event, or not at all.
 */
export interface AppTag {
  fid: number | null;
  label: string;
  source: "gasless" | "onchain" | "unknown";
  status: "active" | "expired" | "removed";
}

/** One cast, ready to display. `ref` ("fid:0xhash") is what write functions take. */
export interface Post {
  ref: string;
  fid: number;
  hash: string;
  /** With mentions put back in as @username. */
  text: string;
  /** Unix ms. */
  time: number;
  author: Author;
  /** The cast this replies to, the channel URL it was posted in, or null. */
  parent: { fid: number; hash: string } | { url: string } | null;
  /** URLs, and quoted casts as "fid:0xhash". */
  embeds: string[];
  app: AppTag;
}

/**
 * Which posts to keep. `apps` and `notApps` take app fids, labels ("farcaster", "base") or the
 * words "self" and "unknown". Unknown-app posts are dropped by default once `apps` is set;
 * `unknown` overrides that. Replies are hidden unless `replies` is true. `limit` defaults to 20.
 */
export interface FeedFilter {
  apps?: string[];
  notApps?: string[];
  unknown?: "include" | "exclude";
  replies?: boolean;
  limit?: number;
}

/**
 * A node to talk to and whose eyes to read through. `viewerFid` is the logged-in account, or the
 * fid passed as `as`; `canWrite` is true only for the logged-in account.
 */
export interface Session {
  nodeUrl: string;
  viewerFid: number | null;
  canWrite: boolean;
}

/**
 * Node: `opts.node`, else the THREECAST_NODE environment variable (which ./threecast sets to the
 * SSH tunnel). Viewer: `opts.as` for a read-only look at someone else's feed, else the account in
 * $TC_HOME/accounts/current, else nobody.
 */
export async function openSession(opts: { node?: string; as?: number } = {}): Promise<Session> {
  const raw = opts.node ?? process.env.THREECAST_NODE;
  if (!raw) {
    throw new TcError(
      "There is no node to talk to.",
      "Run ./threecast client (it opens the tunnel to your node), or pass --node URL. For a read-only look meanwhile: --node https://snap.farcaster.xyz:3381 --as 3",
    );
  }
  const nodeUrl = normalizeNodeUrl(raw);
  if (opts.as !== undefined) {
    if (!Number.isInteger(opts.as) || opts.as <= 0) throw new TcError(`"${opts.as}" is not an FID.`, "--as takes a number such as 3.");
    return { nodeUrl, viewerFid: opts.as, canWrite: false };
  }
  const fid = currentFid() ?? null;
  return { nodeUrl, viewerFid: fid, canWrite: fid !== null };
}

/**
 * Recent casts from the accounts the viewer follows (the 300 most recent follows), newest first.
 * `following` is how many accounts the viewer follows; `scanned` how many casts were read;
 * `unread` how many accounts' casts could not be read this time and are missing; `futureDated`
 * how many casts were left out because they are dated more than 10 minutes ahead of the node.
 */
export async function homeFeed(s: Session, f: FeedFilter = {}): Promise<{ posts: Post[]; following: number; scanned: number; unread: number; futureDated: number }> {
  if (s.viewerFid === null) {
    throw new TcError("There is no account to read a home feed for.", "Log in with ./threecast login, or look through someone else's eyes with --as FID.");
  }
  const viewer = s.viewerFid;
  return cached(() => readHomeFeed(new Hub(s.nodeUrl), viewer, f, { ownKeys: ownKeys() }));
}

/**
 * One account's own casts, newest first. `user` is "@name", "name" or a numeric fid.
 * `futureDated` counts casts left out for being dated more than 10 minutes ahead of the node.
 */
export async function userCasts(s: Session, user: string, f: FeedFilter = {}): Promise<{ posts: Post[]; futureDated: number }> {
  const hub = new Hub(s.nodeUrl);
  return cached(async () => readUserCasts(hub, await resolveFid(hub, user), f, ownKeys()));
}

/** How many of `posts` each app made, most first. */
export function appBreakdown(posts: Post[]): { app: AppTag; count: number }[] {
  return breakdown(posts);
}

/**
 * A profile: who they are, how many accounts they follow, and whether the viewer follows them
 * (null without a viewer, or when it is the viewer's own profile).
 */
export async function profile(s: Session, user: string): Promise<{ author: Author; bio: string | null; following: number; followedByViewer: boolean | null }> {
  const hub = new Hub(s.nodeUrl);
  return cached(async () => {
    const fid = await resolveFid(hub, user);
    const viewer = s.viewerFid;
    const [p, follows, viewerFollows] = await Promise.all([
      getProfile(hub, fid),
      followsOf(hub, fid),
      viewer === null || viewer === fid ? Promise.resolve(null) : followHash(hub, viewer, fid).then((h) => h !== undefined),
    ]);
    return {
      author: { fid, username: p.username, displayName: p.displayName, pfp: p.pfp },
      bio: p.bio,
      following: follows.length,
      followedByViewer: viewerFollows,
    };
  });
}

/**
 * A cast as it will be published. Every @name the node knows becomes a mention: the cast stores
 * the account's fid and where the name goes, not the name. `unknown` names (no account has them)
 * and names past the tenth mention (`overLimit`) stay in the text as typed. `bytes` counts the
 * text without the mentioned names; over 320 it goes out as a long cast (`long`).
 */
export interface CastDraft extends Mentions {
  bytes: number;
  long: boolean;
}

/** Looks up the @names in `typed` on the node and builds the draft. Refuses text over 1024 bytes. */
export async function draftCast(s: Session, typed: string): Promise<CastDraft> {
  const hub = new Hub(s.nodeUrl);
  const names = [...new Set(mentionTokens(typed).map((t) => t.name))];
  const found = await cached(() => mapLimit(names, PARALLEL, (name) => fidByName(hub, name)));
  const fids = new Map<string, number>();
  names.forEach((name, i) => {
    const fid = found[i];
    if (fid !== undefined) fids.set(name, fid);
  });
  const draft = extractMentions(typed, fids);
  const { type, bytes } = castKind(draft.text, draft.mentions.length);
  return { ...draft, bytes, long: type === CastType.LONG_CAST };
}

/**
 * Publishes a cast (a reply when `replyTo` is a ref) and waits until the node serves it.
 * `cast` is the text as typed, or a draft from draftCast. The answer repeats which names became
 * mentions and which stayed plain text.
 */
export async function post(
  s: Session,
  cast: string | CastDraft,
  opts: { replyTo?: string } = {},
): Promise<{ ref: string; confirmed: boolean; ms: number; mentioned: string[]; unknown: string[]; overLimit: string[] }> {
  const { hub, account } = writer(s);
  const draft = typeof cast === "string" ? await draftCast(s, cast) : cast;
  const parent = opts.replyTo ? parseRef(opts.replyTo) : undefined;
  if (parent) await requireCast(hub, parent);
  await requireActiveKey(hub, account);
  const message = await buildCast(signingFor(account), draft, parent);
  const hash = bytesToHex(message.hash);
  const result = await submitConfirmed(hub, message, async () => (await getCast(hub, { fid: account.fid, hash })) !== undefined);
  return { ref: `${account.fid}:${hash}`, ...result, mentioned: draft.mentioned, unknown: draft.unknown, overLimit: draft.overLimit };
}

/** Deletes one of the viewer's own casts. `ref` is "fid:0xhash" or a number from the last feed. */
export async function remove(s: Session, ref: string): Promise<{ confirmed: boolean }> {
  const { hub, account } = writer(s);
  const target = parseRef(ref);
  if (target.fid !== account.fid) {
    throw new TcError(`That cast belongs to FID ${target.fid}; you can only delete your own.`);
  }
  await requireCast(hub, target);
  await requireActiveKey(hub, account);
  const message = await buildCastRemove(signingFor(account), target.hash);
  const { confirmed } = await submitConfirmed(hub, message, async () => (await getCast(hub, target)) === undefined);
  return { confirmed };
}

/** Likes or recasts a cast, or with `undo` takes that back. */
export async function react(s: Session, kind: "like" | "recast", ref: string, undo = false): Promise<{ confirmed: boolean }> {
  const { hub, account } = writer(s);
  const target = parseRef(ref);
  if (!undo) await requireCast(hub, target);
  await requireActiveKey(hub, account);
  const message = await buildReaction(signingFor(account), kind, target, undo);
  const hash = bytesToHex(message.hash);
  const { confirmed } = await submitConfirmed(hub, message, async () => {
    const current = await reactionHash(hub, account.fid, kind, target);
    return undo ? current === undefined : current === hash;
  });
  return { confirmed };
}

/**
 * Whether the viewer has liked and recast each cast in `refs` ("fid:0xhash"), from one
 * reactionById per cast and kind. A cast whose lookup failed is left out of the answer; once the
 * node cannot be reached at all, the remaining casts are not asked about.
 */
export async function viewerReactions(s: Session, refs: string[]): Promise<Record<string, { like: boolean; recast: boolean }>> {
  const viewer = s.viewerFid;
  if (viewer === null) return {};
  const hub = new Hub(s.nodeUrl);
  let unreachable = false;
  const answers = await mapLimit(refs, PARALLEL, async (ref) => {
    if (unreachable || !/^\d+:0x[0-9a-fA-F]{40}$/.test(ref)) return undefined;
    const target = parseRef(ref);
    try {
      const [like, recast] = await Promise.all([reactionHash(hub, viewer, "like", target), reactionHash(hub, viewer, "recast", target)]);
      return [ref, { like: like !== undefined, recast: recast !== undefined }] as const;
    } catch (e) {
      if (e instanceof NodeError) return undefined;
      if (e instanceof TcError) {
        unreachable = true;
        return undefined;
      }
      throw e;
    }
  });
  return Object.fromEntries(answers.filter((a) => a !== undefined));
}

/** Follows `user` ("@name", "name" or fid), or with `undo` unfollows. Returns their fid. */
export async function follow(s: Session, user: string, undo = false): Promise<{ fid: number; confirmed: boolean }> {
  const { hub, account } = writer(s);
  const fid = await cached(() => resolveFid(hub, user));
  if (fid === account.fid) throw new TcError("That is your own account.");
  await requireActiveKey(hub, account);
  const message = await buildFollow(signingFor(account), fid, undo);
  const hash = bytesToHex(message.hash);
  const { confirmed } = await submitConfirmed(hub, message, async () => {
    const current = await followHash(hub, account.fid, fid);
    return undo ? current === undefined : current === hash;
  });
  return { fid, confirmed };
}

/**
 * The node's version and per-shard progress. `synced` means shards 0, 1 and 2 are all within 10 s
 * of the newest block and shard 0 holds a restored snapshot (over a million messages).
 */
export async function nodeStatus(s: Session): Promise<NodeStatus> {
  return readStatus(new Hub(s.nodeUrl));
}

function writer(s: Session): { hub: Hub; account: Account } {
  if (s.viewerFid === null) throw new TcError("You are not logged in.", "Run ./threecast login first.");
  if (!s.canWrite) throw new TcError(`This session only views FID ${s.viewerFid}; it cannot act as them.`, "Leave out --as to use your own account.");
  const account = loadAccount(s.viewerFid);
  if (!account) throw new TcError(`There is no app key for FID ${s.viewerFid} on this laptop.`, "Run ./threecast login.");
  return { hub: new Hub(s.nodeUrl), account };
}

function ownKeys(): Set<string> {
  return new Set(listAccounts().map((a) => a.appKeyPublic.toLowerCase()));
}

// Name and attribution lookups are cached on disk; write the new entries out after each call.
async function cached<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } finally {
    flushNames();
    flushAttributions();
  }
}
