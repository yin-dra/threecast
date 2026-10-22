// threecast — MIT License
// Which app made a cast? A cast has no app field. The app is whoever requested the key that signed it:
// message.signer → GET /v1/signer → requestFid (gasless keys) or the KeyRegistry metadata (onchain keys).

import { decodeGaslessSignedKeyRequestMetadata } from "@farcaster/core";
import type { AppTag, FeedFilter, Post } from "./api.ts";
import { NodeError } from "./errors.ts";
import type { Hub, OnChainEventJson, SignerJson } from "./hub.ts";
import { getProfile } from "./names.ts";
import { Cache } from "./store.ts";

interface Attribution {
  appFid: number | null;
  source: AppTag["source"];
  status: AppTag["status"];
  /** Set for keys this laptop authorized, so their casts stay labeled after logout revokes the key. */
  threecast?: boolean;
  at: number;
}

// Labels for app fids that show up on most feeds. Never derive an app fid from an fname:
// @supercast and @firefly are unrelated accounts, and fid 9152's username is still "warpcast".
const KNOWN_APPS: { fid: number; label: string; aliases: string[] }[] = [
  { fid: 9152, label: "Farcaster", aliases: ["warpcast"] },
  { fid: 309857, label: "Base App", aliases: ["base", "coinbasewallet"] },
  { fid: 193137, label: "Supercast", aliases: ["super"] },
  { fid: 18665, label: "herocast", aliases: [] },
  { fid: 16823, label: "Firefly", aliases: ["fireflyapp"] },
  { fid: 6131, label: "Neynar (via an app)", aliases: ["neynar"] },
  { fid: 19528, label: "legacy-signer", aliases: ["legacy"] },
];

// Onchain (fid, key) → requestFid never changes, so those entries are kept forever. A gasless
// key's status changes (it expires, or is revoked), so it is re-checked daily. "Unknown" may only
// mean the node has not caught up yet, so it is re-checked hourly.
const RECHECK_MS = 24 * 3600_000;
const RECHECK_UNKNOWN_MS = 3600_000;

function isFresh(entry: Attribution): boolean {
  if (entry.source === "onchain" || entry.threecast) return true;
  return Date.now() - entry.at < (entry.appFid === null ? RECHECK_UNKNOWN_MS : RECHECK_MS);
}

let cache: Cache<Attribution> | undefined;
const inflight = new Map<string, Promise<Attribution>>();
const histories = new Map<number, Promise<Map<string, number>>>();

function attributions(): Cache<Attribution> {
  cache ??= new Cache("attribution");
  return cache;
}

export function flushAttributions(): void {
  cache?.flush();
}

/** The app fid inside ABI-encoded SignedKeyRequestMetadata, or null when there is none. */
export function requestFidFromMetadata(metadata: Uint8Array): number | null {
  if (metadata.length === 0) return null; // REMOVE events carry empty metadata
  const decoded = decodeGaslessSignedKeyRequestMetadata(metadata);
  return decoded.isOk() ? Number(decoded.value.requestFid) : null;
}

function requestFidFromBase64(metadata: string): number | null {
  return requestFidFromMetadata(new Uint8Array(Buffer.from(metadata, "base64")));
}

/**
 * Records a revoked key of this laptop's. Once a gasless key is removed, the node can no longer say
 * which app it belonged to, so this is what keeps its casts labeled.
 */
export function rememberRevokedKey(fid: number, key: string): void {
  attributions().set(`${fid}:${key.toLowerCase()}`, { appFid: fid, source: "gasless", status: "removed", threecast: true, at: Date.now() });
  flushAttributions();
}

/** Tags a cast with the app behind its signer. `ownKeys` are this laptop's app keys (lowercase hex). */
export async function appFor(hub: Hub, authorFid: number, signer: string, ownKeys: ReadonlySet<string>): Promise<AppTag> {
  const key = signer.toLowerCase();
  const own = ownKeys.has(key);
  const found = await attribute(hub, authorFid, key, own);
  const label = own || found.threecast ? "threecast" : await labelFor(hub, authorFid, found);
  return { fid: found.appFid, label, source: found.source, status: found.status };
}

function attribute(hub: Hub, fid: number, key: string, own: boolean): Promise<Attribution> {
  const id = `${fid}:${key}`;
  const cached = attributions().get(id);
  if (cached && isFresh(cached)) return Promise.resolve(cached);
  let pending = inflight.get(id);
  if (!pending) {
    pending = lookup(hub, fid, key)
      .then((found) => {
        // A key's app never changes (a re-add must come from the same requester), but KEY_REMOVE
        // deletes a gasless key's record, and with it the node's answer. Keep what was learned.
        const known: Attribution = found.appFid === null && cached && cached.appFid !== null ? { ...cached, status: "removed", at: found.at } : found;
        const entry: Attribution = own ? { ...known, threecast: true } : known;
        attributions().set(id, entry);
        return entry;
      })
      .finally(() => inflight.delete(id));
    inflight.set(id, pending);
  }
  return pending;
}

async function lookup(hub: Hub, fid: number, key: string): Promise<Attribution> {
  const at = Date.now();
  try {
    const { signer } = await hub.get<{ signer: SignerJson }>("/v1/signer", { fid, signer: key });
    if (signer.source === "SIGNER_SOURCE_OFFCHAIN") {
      // The node keeps listing expired gasless keys; expiry only blocks new messages.
      const expired = signer.expiresAt !== undefined && signer.expiresAt * 1000 < at;
      return { appFid: signer.requestFid ?? null, source: "gasless", status: expired ? "expired" : "active", at };
    }
    // Onchain keys carry no requestFid in this JSON: it is inside the KeyRegistry metadata (base64).
    const metadata = signer.onChainEvent?.signerEventBody?.metadata;
    const appFid = signer.requestFid ?? (metadata ? requestFidFromBase64(metadata) : null);
    return { appFid, source: "onchain", status: "active", at };
  } catch (e) {
    if (!(e instanceof NodeError && e.notFound)) throw e;
  }
  // A removed onchain key keeps its casts (since engine V14) but disappears from /v1/signer.
  // Its ADD event, with the metadata, is still in the fid's onchain history.
  const appFid = (await signerHistory(hub, fid)).get(key);
  if (appFid !== undefined) return { appFid, source: "onchain", status: "removed", at };
  // What is left is a gasless key revoked with KEY_REMOVE, whose record (and requestFid) is gone.
  return { appFid: null, source: "unknown", status: "removed", at };
}

function signerHistory(hub: Hub, fid: number): Promise<Map<string, number>> {
  let pending = histories.get(fid);
  if (!pending) {
    pending = hub
      .get<{ events: OnChainEventJson[] }>("/v1/onChainEventsByFid", { fid, event_type: "EVENT_TYPE_SIGNER" })
      .then(({ events }) => {
        const keys = new Map<string, number>();
        for (const event of events) {
          const body = event.signerEventBody;
          // keyType 2 entries are auth addresses, which never sign casts.
          if (!body || body.eventType !== "SIGNER_EVENT_TYPE_ADD" || body.keyType !== 1) continue;
          const appFid = requestFidFromBase64(body.metadata);
          if (appFid !== null) keys.set(body.key.toLowerCase(), appFid);
        }
        return keys;
      });
    pending.catch(() => histories.delete(fid));
    histories.set(fid, pending);
  }
  return pending;
}

async function labelFor(hub: Hub, authorFid: number, found: Attribution): Promise<string> {
  if (found.appFid === null) return "unknown";
  // Self-requested keys are what people's own clients (threecast included) register.
  if (found.appFid === authorFid) return "own key";
  const known = KNOWN_APPS.find((app) => app.fid === found.appFid);
  if (known) return known.label;
  const profile = await getProfile(hub, found.appFid);
  return profile.username ?? profile.displayName ?? `fid ${found.appFid}`;
}

function isUnknown(app: AppTag): boolean {
  return app.fid === null;
}

/**
 * Whether one filter word names the app behind a post: "self" (key requested by the author
 * themselves), "unknown", an app fid, or a label such as "farcaster", "base" or "supercast".
 */
export function matchesApp(word: string, post: Pick<Post, "fid" | "app">): boolean {
  const w = word.trim().toLowerCase();
  if (w === "unknown") return isUnknown(post.app);
  if (isUnknown(post.app)) return false;
  if (w === "self") return post.app.fid === post.fid;
  if (/^\d+$/.test(w)) return post.app.fid === Number(w);
  if (post.app.label.toLowerCase() === w) return true;
  const known = KNOWN_APPS.find((app) => app.fid === post.app.fid);
  return known !== undefined && known.aliases.includes(w);
}

/**
 * Applies a FeedFilter to one post. Replies (casts with a parent cast) are hidden unless
 * `replies` is set. Casts whose app is unknown are hidden by default once `apps` is set,
 * because "only these apps" cannot vouch for a cast nobody can attribute.
 */
export function passesFilter(post: Pick<Post, "fid" | "app" | "parent">, filter: FeedFilter): boolean {
  if (!filter.replies && post.parent !== null && "fid" in post.parent) return false;
  const include = filter.apps ?? [];
  if ((filter.notApps ?? []).some((word) => matchesApp(word, post))) return false;
  if (isUnknown(post.app) && filter.unknown) return filter.unknown === "include";
  return include.length === 0 || include.some((word) => matchesApp(word, post));
}

/**
 * How many of `posts` each app made, most first. Keys that authors requested for themselves
 * count as one group per label ("own key", "threecast"), whatever the author.
 */
export function appBreakdown(posts: Post[]): { app: AppTag; count: number }[] {
  const groups = new Map<string, { app: AppTag; count: number }>();
  for (const post of posts) {
    const id = post.app.fid === post.fid ? `self:${post.app.label}` : `${post.app.fid ?? "-"}:${post.app.label}`;
    const group = groups.get(id);
    if (group) group.count++;
    else groups.set(id, { app: post.app, count: 1 });
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.app.label.localeCompare(b.app.label));
}

/** The word that selects this app with --app or --not-app. */
export function filterWord(app: AppTag): string {
  if (app.fid === null) return "unknown";
  if (app.label === "own key" || app.label === "threecast") return "self";
  const known = KNOWN_APPS.find((a) => a.fid === app.fid);
  if (!known) return String(app.fid);
  return known.label.includes(" ") ? (known.aliases[0] ?? String(app.fid)) : known.label.toLowerCase();
}
