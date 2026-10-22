// threecast — MIT License
// Local state under $TC_HOME (default ~/.threecast): directories 0700, files 0600, written atomically.

import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { TcError } from "./errors.ts";

/** One authorized app key. The recovery phrase is never part of this. */
export interface Account {
  fid: number;
  custodyAddress: string;
  /** Ed25519 private key, 0x hex. Anyone holding it can post as this fid until the key is revoked. */
  appKeyPrivate: string;
  appKeyPublic: string;
  /** The KEY_ADD nonce this key was registered with. */
  nonce: number;
  /** The fid that requested the key; threecast keys are self-requested, so this equals fid. */
  requestFid: number;
  /** Unix ms. */
  createdAt: number;
}

export function home(): string {
  return process.env.THREECAST_HOME || join(homedir(), ".threecast");
}

function dir(name: "accounts" | "cache"): string {
  const path = join(home(), name);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  // The mode above only applies to a directory this call creates; app keys live in this one.
  if (name === "accounts") chmodSync(path, 0o700);
  return path;
}

/** Writes via a temp file and rename, so a crash never leaves half a key file behind. */
export function writePrivate(path: string, data: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(tmp, 0o600); // the mode passed to openSync only applies when the file is new
  renameSync(tmp, path);
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

export function accountPath(fid: number): string {
  return join(dir("accounts"), `${fid}.json`);
}

export function saveAccount(account: Account): void {
  writePrivate(accountPath(account.fid), `${JSON.stringify(account, null, 2)}\n`);
}

export function loadAccount(fid: number): Account | undefined {
  const path = accountPath(fid);
  const text = readText(path);
  if (text === undefined) return undefined;
  try {
    const account = JSON.parse(text) as Account;
    if (account.fid === fid && /^0x[0-9a-f]{64}$/i.test(account.appKeyPrivate)) return account;
  } catch {
    // reported below
  }
  throw new TcError(`${path} is damaged.`, `Delete it and run ./threecast login again.`);
}

export function listAccounts(): Account[] {
  const accounts: Account[] = [];
  for (const name of readdirSync(dir("accounts"))) {
    const match = /^(\d+)\.json$/.exec(name);
    if (!match) continue;
    const account = loadAccount(Number(match[1]));
    if (account) accounts.push(account);
  }
  return accounts;
}

export function removeAccount(fid: number): void {
  rmSync(accountPath(fid), { force: true });
  if (currentFid() === fid) setCurrentFid(undefined);
}

export function currentFid(): number | undefined {
  const text = readText(join(dir("accounts"), "current"))?.trim();
  if (!text || !/^\d+$/.test(text)) return undefined;
  const fid = Number(text);
  return existsSync(accountPath(fid)) ? fid : undefined;
}

export function setCurrentFid(fid: number | undefined): void {
  const path = join(dir("accounts"), "current");
  if (fid === undefined) rmSync(path, { force: true });
  else writePrivate(path, `${fid}\n`);
}

/** Saves a freshly generated phrase (new-account only, and only when the user says yes). */
export function savePhrase(address: string, phrase: string): string {
  const path = join(dir("accounts"), `${address.toLowerCase()}.phrase`);
  writePrivate(path, `${phrase}\n`);
  return path;
}

function readJsonFile(path: string): unknown {
  const text = readText(path);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined; // a damaged cache is rebuilt, not reported
  }
}

/**
 * A JSON map in $TC_HOME/cache. flush() merges into what is on disk, so a long-running web
 * client and a CLI command can share one cache file without erasing each other's entries.
 */
export class Cache<V> {
  private readonly path: string;
  private entries: Record<string, V> | undefined;
  private readonly changed = new Set<string>();

  constructor(name: "attribution" | "names") {
    this.path = join(dir("cache"), `${name}.json`);
  }

  get(key: string): V | undefined {
    return this.load()[key];
  }

  set(key: string, value: V): void {
    this.load()[key] = value;
    this.changed.add(key);
  }

  flush(): void {
    if (this.changed.size === 0) return;
    const merged = asMap<V>(readJsonFile(this.path));
    const entries = this.load();
    for (const key of this.changed) {
      const value = entries[key];
      if (value !== undefined) merged[key] = value;
    }
    writePrivate(this.path, JSON.stringify(merged));
    this.changed.clear();
  }

  private load(): Record<string, V> {
    this.entries ??= asMap<V>(readJsonFile(this.path));
    return this.entries;
  }
}

function asMap<V>(data: unknown): Record<string, V> {
  return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, V>) : {};
}

/** What `threecast feed` last printed, so `threecast like 3` can mean "item 3". */
export interface LastFeed {
  nodeUrl: string;
  at: number;
  refs: string[];
}

export function saveLastFeed(feed: LastFeed): void {
  writePrivate(join(dir("cache"), "last-feed.json"), JSON.stringify(feed));
}

export function loadLastFeed(): LastFeed | undefined {
  const data = readJsonFile(join(dir("cache"), "last-feed.json")) as Partial<LastFeed> | undefined;
  return data && Array.isArray(data.refs) ? (data as LastFeed) : undefined;
}
