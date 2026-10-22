// threecast — MIT License
// Reading casts: the home feed (casts by the accounts you follow) and one account's casts.

import { FARCASTER_EPOCH } from "@farcaster/core";
import type { FeedFilter, Post } from "./api.ts";
import { appFor, passesFilter } from "./apps.ts";
import { TcError } from "./errors.ts";
import type { Hub, MessageJson } from "./hub.ts";
import { getProfile } from "./names.ts";

/** Follows beyond this many (most recent first) are left out of the home feed to keep it quick. */
export const FOLLOW_CAP = 300;
const CASTS_PER_AUTHOR = 10;
/** Lookups started at once by one feed (the Hub caps requests in flight per node on top of this). */
export const PARALLEL = 8;
const DEFAULT_LIMIT = 20;
// The network rejects new messages dated more than 10 minutes ahead of its clock, yet a few casts
// on mainnet carry dates decades ahead (FID 347 has one dated 2061). Sorted by time, each would
// lead every feed it appears in until that date.
const FUTURE_LIMIT_MS = 10 * 60_000;

/**
 * Runs `work` over `items` with at most `limit` calls in flight, keeping the input order.
 * The first failure rejects, and no new calls start after it.
 */
export async function mapLimit<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  async function worker(): Promise<void> {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        results[i] = await work(items[i] as T);
      } catch (e) {
        failed = true;
        throw e;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Everyone `fid` follows, with the time each follow was made (Farcaster seconds). */
export async function followsOf(hub: Hub, fid: number): Promise<{ fid: number; at: number }[]> {
  const follows: { fid: number; at: number }[] = [];
  for await (const page of hub.pages("/v1/linksByFid", { fid, link_type: "follow" }, 1000)) {
    for (const m of page) {
      const target = m.data.linkBody?.targetFid;
      if (target !== undefined) follows.push({ fid: target, at: m.data.timestamp });
    }
  }
  return follows;
}

// castsByFid returns CAST_REMOVE messages mixed in with the casts; a removed cast's ADD is already gone.
function castsOnly(messages: MessageJson[]): MessageJson[] {
  return messages.filter((m) => m.data.type === "MESSAGE_TYPE_CAST_ADD" && m.data.castAddBody);
}

// Replies are hidden unless asked for. This is the cheap part of the filter, run before any lookup.
function wanted(m: MessageJson, filter: FeedFilter): boolean {
  return filter.replies === true || !m.data.castAddBody?.parentCastId;
}

/**
 * Splits off casts dated more than 10 minutes after the node's clock (this laptop's clock,
 * corrected by the node's Date header). `futureDated` counts those the filter would have shown.
 */
function withoutFutureDated(hub: Hub, casts: MessageJson[], filter: FeedFilter): { casts: MessageJson[]; futureDated: number } {
  const latest = Date.now() - (hub.clockSkewMs ?? 0) + FUTURE_LIMIT_MS;
  const kept: MessageJson[] = [];
  let futureDated = 0;
  for (const m of casts) {
    if (FARCASTER_EPOCH + m.data.timestamp * 1000 <= latest) kept.push(m);
    else if (wanted(m, filter)) futureDated++;
  }
  return { casts: kept, futureDated };
}

export interface FeedOptions {
  ownKeys: ReadonlySet<string>;
  followCap?: number;
}

export async function homeFeed(
  hub: Hub,
  viewerFid: number,
  filter: FeedFilter,
  options: FeedOptions,
): Promise<{ posts: Post[]; following: number; scanned: number; unread: number; futureDated: number }> {
  const follows = await followsOf(hub, viewerFid);
  const recent = follows.sort((a, b) => b.at - a.at).slice(0, options.followCap ?? FOLLOW_CAP);
  // One account that times out should not cost the whole feed, so failures are counted and
  // skipped. If the first few all fail, the node itself is the problem: stop and say so.
  let read = 0;
  let unread = 0;
  let firstError: TcError | undefined;
  const perAuthor = await mapLimit(recent, PARALLEL, async (f) => {
    try {
      const page = await hub.get<{ messages: MessageJson[] }>("/v1/castsByFid", { fid: f.fid, pageSize: CASTS_PER_AUTHOR, reverse: true });
      read++;
      return castsOnly(page.messages);
    } catch (e) {
      if (!(e instanceof TcError)) throw e;
      unread++;
      firstError ??= e;
      if (read === 0 && unread >= PARALLEL) throw e;
      return [];
    }
  });
  if (firstError && read === 0) throw firstError;
  const all = perAuthor.flat();
  const { casts, futureDated } = withoutFutureDated(hub, all, filter);
  casts.sort((a, b) => b.data.timestamp - a.data.timestamp);
  const posts = await selectPosts(hub, casts, filter, options.ownKeys, filter.limit ?? DEFAULT_LIMIT);
  return { posts, following: follows.length, scanned: all.length, unread, futureDated };
}

/** One account's own casts, newest first, scanning at most a few hundred to satisfy the filter. */
export async function userCasts(hub: Hub, fid: number, filter: FeedFilter, ownKeys: ReadonlySet<string>): Promise<{ posts: Post[]; futureDated: number }> {
  const limit = filter.limit ?? DEFAULT_LIMIT;
  const posts: Post[] = [];
  let futureDated = 0;
  let pagesLeft = 6;
  for await (const page of hub.pages("/v1/castsByFid", { fid, reverse: true }, 50)) {
    const split = withoutFutureDated(hub, castsOnly(page), filter);
    futureDated += split.futureDated;
    posts.push(...(await selectPosts(hub, split.casts, filter, ownKeys, limit - posts.length)));
    if (posts.length >= limit || --pagesLeft === 0) break;
  }
  return { posts, futureDated };
}

/**
 * Turns casts (newest first) into Posts until `limit` pass the filter. Attribution and profiles
 * cost requests, so the cheap reply check runs first and only as many casts as needed are resolved.
 */
async function selectPosts(hub: Hub, casts: MessageJson[], filter: FeedFilter, ownKeys: ReadonlySet<string>, limit: number): Promise<Post[]> {
  const candidates = casts.filter((m) => wanted(m, filter));
  const posts: Post[] = [];
  for (let i = 0; i < candidates.length && posts.length < limit; i += PARALLEL) {
    const batch = await mapLimit(candidates.slice(i, i + PARALLEL), PARALLEL, (m) => toPost(hub, m, ownKeys));
    for (const post of batch) {
      if (posts.length < limit && passesFilter(post, filter)) posts.push(post);
    }
  }
  return posts;
}

export async function toPost(hub: Hub, m: MessageJson, ownKeys: ReadonlySet<string>): Promise<Post> {
  const body = m.data.castAddBody;
  if (!body) throw new Error(`message ${m.hash} is not a cast`);
  const [profile, app, text] = await Promise.all([
    getProfile(hub, m.data.fid),
    appFor(hub, m.data.fid, m.signer, ownKeys),
    withMentions(hub, body.text, body.mentions, body.mentionsPositions),
  ]);
  const parent = body.parentCastId
    ? { fid: body.parentCastId.fid, hash: body.parentCastId.hash }
    : body.parentUrl
      ? { url: body.parentUrl }
      : null;
  const embeds = [
    ...body.embeds.map((e) => ("url" in e ? e.url : `${e.castId.fid}:${e.castId.hash}`)),
    ...body.embedsDeprecated,
  ];
  return {
    ref: `${m.data.fid}:${m.hash}`,
    fid: m.data.fid,
    hash: m.hash,
    text,
    time: FARCASTER_EPOCH + m.data.timestamp * 1000,
    author: { fid: profile.fid, username: profile.username, displayName: profile.displayName, pfp: profile.pfp },
    parent,
    embeds,
    app,
  };
}

async function withMentions(hub: Hub, text: string, mentions: number[], positions: number[]): Promise<string> {
  if (mentions.length === 0) return text;
  const profiles = await Promise.all(mentions.map((fid) => getProfile(hub, fid)));
  return insertMentions(text, mentions.map((fid, i) => ({ at: positions[i] ?? 0, name: profiles[i]?.username ?? `fid:${fid}` })));
}

/**
 * Casts store mentions outside the text: "gm  and " plus fids and BYTE offsets (UTF-8) where
 * each "@name" belongs. This puts the names back.
 */
export function insertMentions(text: string, mentions: { at: number; name: string }[]): string {
  const bytes = Buffer.from(text, "utf8");
  let out = "";
  let last = 0;
  for (const { at, name } of [...mentions].sort((a, b) => a.at - b.at)) {
    const cut = Math.min(Math.max(at, last), bytes.length);
    out += `${bytes.subarray(last, cut).toString("utf8")}@${name}`;
    last = cut;
  }
  return out + bytes.subarray(last).toString("utf8");
}
