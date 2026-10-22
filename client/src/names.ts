// threecast — MIT License
// @name → fid, and fid → profile, cached in $TC_HOME/cache/names.json.

import { NodeError, TcError } from "./errors.ts";
import type { Hub, MessageJson } from "./hub.ts";
import { Cache } from "./store.ts";

export interface Profile {
  fid: number;
  username: string | null;
  displayName: string | null;
  pfp: string | null;
  bio: string | null;
}

interface CachedProfile extends Profile {
  at: number;
}

interface CachedName {
  at: number;
  fid: number;
}

// Profiles and names change rarely; a day keeps the feed fast without showing stale names for long.
const FRESH_MS = 24 * 3600_000;
const FNAME = /^[a-z0-9][a-z0-9-]{0,15}$/;
const ENS = /^([a-z0-9-]+\.)+eth$/;

// One file, two kinds of entry: "name:<fname>" → CachedName and "fid:<n>" → CachedProfile.
let cache: Cache<CachedProfile | CachedName> | undefined;
const inflight = new Map<string, Promise<Profile>>();

function names(): Cache<CachedProfile | CachedName> {
  cache ??= new Cache("names");
  return cache;
}

export function flushNames(): void {
  cache?.flush();
}

/** Accepts a numeric fid, "@name", "name" or an ENS name such as "dwr.eth". */
export async function resolveFid(hub: Hub, user: string): Promise<number> {
  const input = user.trim();
  if (/^\d+$/.test(input) && Number(input) > 0) return Number(input);
  // The node stores names lowercase and does not strip "@": "@dwr" and "DWR" are both not found.
  const name = input.replace(/^@/, "").toLowerCase();
  if (!FNAME.test(name) && !ENS.test(name)) {
    throw new TcError(`"${user}" is not a Farcaster name or fid.`, "Use @name, name, name.eth, or a number such as 3.");
  }
  const fid = await fidByName(hub, name);
  if (fid === undefined) {
    throw new TcError(`No account is called @${name} on this node.`, "Check the spelling, or use the numeric fid. A node that is still syncing may not know every name yet.");
  }
  return fid;
}

/**
 * The fid that owns `name` (an fname or ENS name, lowercase, without "@"), from the node's
 * username proofs. Undefined when no account has that name.
 */
export async function fidByName(hub: Hub, name: string): Promise<number | undefined> {
  const cached = names().get(`name:${name}`) as CachedName | undefined;
  if (cached && Date.now() - cached.at < FRESH_MS) return cached.fid;
  try {
    const proof = await hub.get<{ fid: number }>("/v1/userNameProofByName", { name });
    names().set(`name:${name}`, { at: Date.now(), fid: proof.fid });
    return proof.fid;
  } catch (e) {
    if (e instanceof NodeError && e.notFound) return undefined;
    throw e;
  }
}

/** Username, display name, avatar and bio from the fid's USER_DATA messages. */
export function getProfile(hub: Hub, fid: number): Promise<Profile> {
  const key = `fid:${fid}`;
  const cached = names().get(key) as CachedProfile | undefined;
  if (cached && Date.now() - cached.at < FRESH_MS) {
    const { username, displayName, pfp, bio } = cached;
    return Promise.resolve({ fid, username, displayName, pfp, bio });
  }
  let pending = inflight.get(key);
  if (!pending) {
    pending = fetchProfile(hub, fid).finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  return pending;
}

async function fetchProfile(hub: Hub, fid: number): Promise<Profile> {
  const latest = new Map<string, MessageJson>();
  for await (const page of hub.pages("/v1/userDataByFid", { fid }, 100)) {
    for (const m of page) {
      const type = m.data.userDataBody?.type;
      const seen = type && latest.get(type);
      if (type && (!seen || seen.data.timestamp < m.data.timestamp)) latest.set(type, m);
    }
  }
  const value = (type: string) => latest.get(type)?.data.userDataBody?.value || null;
  const profile: Profile = {
    fid,
    username: value("USER_DATA_TYPE_USERNAME"),
    displayName: value("USER_DATA_TYPE_DISPLAY"),
    pfp: value("USER_DATA_TYPE_PFP"),
    bio: value("USER_DATA_TYPE_BIO"),
  };
  names().set(`fid:${fid}`, { ...profile, at: Date.now() });
  return profile;
}
