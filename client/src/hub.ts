// threecast — MIT License
// A small typed client for a Snapchain node's HTTP API (port 3381).

import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
import { Message } from "@farcaster/core";
import { NodeError, TcError } from "./errors.ts";

// Node gives each resolved address 250 ms to connect before giving up on it. From a far-away
// network (Southeast Asia to a us-east node, measured) the TCP handshake alone takes longer, IPv6 fails
// fast, and the request dies with ETIMEDOUT. 2.5 s per attempt fixes that and costs nothing.
setDefaultAutoSelectFamilyAttemptTimeout(2500);

export type QueryValue = string | number | boolean | (string | number)[] | undefined;
export type Query = Record<string, QueryValue>;

const READ_TIMEOUT_MS = 20_000;
const SUBMIT_TIMEOUT_MS = 30_000;

// A home feed fans out into hundreds of small GETs. Six at a time over keep-alive connections
// finish about as fast as a burst of hundreds, and do not hammer a shared public node.
const MAX_IN_FLIGHT = 6;
const slots = new Map<string, { active: number; waiting: (() => void)[] }>();

async function withSlot<T>(origin: string, work: () => Promise<T>): Promise<T> {
  let slot = slots.get(origin);
  if (!slot) {
    slot = { active: 0, waiting: [] };
    slots.set(origin, slot);
  }
  const s = slot;
  if (s.active >= MAX_IN_FLIGHT) await new Promise<void>((resolve) => s.waiting.push(resolve));
  else s.active++;
  try {
    return await work();
  } finally {
    const next = s.waiting.shift();
    if (next) next();
    else s.active--;
  }
}

/** The JSON a node returns for one message (`data.timestamp` is in Farcaster seconds). */
export interface MessageJson {
  data: {
    type: string;
    fid: number;
    timestamp: number;
    network: string;
    castAddBody?: CastAddBodyJson;
    reactionBody?: { type: string; targetCastId?: CastIdJson; targetUrl?: string };
    linkBody?: { type: string; targetFid: number; displayTimestamp: number | null };
    userDataBody?: { type: string; value: string };
  };
  hash: string;
  signer: string;
}

export interface CastIdJson {
  fid: number;
  hash: string;
}

export interface CastAddBodyJson {
  text: string;
  type: string;
  embeds: ({ url: string } | { castId: CastIdJson })[];
  embedsDeprecated: string[];
  mentions: number[];
  mentionsPositions: number[];
  parentCastId: CastIdJson | null;
  parentUrl: string | null;
}

export interface PageJson {
  messages: MessageJson[];
  nextPageToken?: string | null;
}

export interface SignerEventBodyJson {
  key: string;
  keyType: number;
  eventType: string;
  metadata: string; // base64, unlike every other byte field
  metadataType: number;
}

export interface OnChainEventJson {
  type: string;
  fid: number;
  blockTimestamp: number;
  signerEventBody?: SignerEventBodyJson;
  idRegisterEventBody?: { to: string; from: string; eventType: string; recoveryAddress: string };
}

export interface SignerJson {
  source: "SIGNER_SOURCE_ONCHAIN" | "SIGNER_SOURCE_OFFCHAIN";
  key: string;
  keyType: number;
  fid: number;
  addedAt?: number; // Unix seconds, like lastUsedAt and expiresAt
  lastUsedAt?: number;
  ttl?: number;
  expiresAt?: number;
  scopes?: string[];
  requestFid?: number;
  nonce?: number;
  onChainEvent?: OnChainEventJson;
}

export interface SignersByFidJson {
  signers: SignerJson[];
  nextPageToken?: string;
  gaslessSignerCount: number;
  gaslessSignerLimit: number;
  currentUserNonce: number;
  requesterFidNonces?: Record<string, number>;
}

export interface InfoJson {
  version: string;
  shardInfos: { shardId: number; maxHeight: number; numMessages: number; blockDelay: number }[];
}

/**
 * Builds a query string the way the node's strict serde_qs parser accepts it:
 * booleans as true/false (reverse=1 is a 400) and arrays with literal brackets.
 */
export function buildQuery(query: Query): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      // requesterFids[]=3 works; the percent-encoded requesterFids%5B%5D=3 is silently ignored.
      for (const item of value) parts.push(`${encodeURIComponent(key)}[]=${encodeURIComponent(String(item))}`);
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    }
  }
  return parts.join("&");
}

/**
 * True when a nextPageToken means there are no more pages. Single-shard routes (castsByFid,
 * linksByFid, ...) end with "". Fan-out routes (castsByParent, reactionsByCast, ...) never do:
 * their token is base64 JSON with one entry per shard, and [null,null] means all are exhausted.
 */
export function isLastPage(token: string | null | undefined): boolean {
  if (!token) return true;
  try {
    const perShard: unknown = JSON.parse(Buffer.from(token, "base64").toString("utf8"));
    return Array.isArray(perShard) && perShard.every((t) => t === null);
  } catch {
    return false;
  }
}

export function normalizeNodeUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new TcError(`"${raw}" is not a node address.`, "Use a full URL such as http://127.0.0.1:13381 or https://snap.farcaster.xyz:3381.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TcError(`"${raw}" is not an http(s) address.`, "Snapchain's HTTP API listens on port 3381, e.g. http://127.0.0.1:13381 through the threecast tunnel.");
  }
  return url.origin;
}

export class Hub {
  readonly url: string;
  /**
   * This laptop's clock minus the node's, from the Date header of the latest answer (whole
   * seconds, plus the time the answer took to arrive). Undefined until a node has answered.
   */
  clockSkewMs: number | undefined;

  constructor(url: string) {
    this.url = normalizeNodeUrl(url);
  }

  /** GET /v1/<route>. Throws NodeError for error responses, TcError when the node is unreachable. */
  async get<T>(path: string, query: Query = {}, timeoutMs = READ_TIMEOUT_MS): Promise<T> {
    const qs = buildQuery(query);
    const res = await this.request(path, qs ? `${path}?${qs}` : path, {}, timeoutMs);
    if (!res.ok) throw toNodeError(res.status, path, res.text);
    try {
      return JSON.parse(res.text) as T;
    } catch {
      throw new TcError(`${this.url} answered ${path} with something that is not JSON.`, "Is this address really a Snapchain node's HTTP API (port 3381)?");
    }
  }

  /**
   * POST /v1/submitMessage. A 200 means the node accepted the message for relay, not that it merged;
   * callers confirm by reading it back. A "duplicate" reply means it already merged.
   */
  async submit(message: Message): Promise<{ duplicate: boolean }> {
    const path = "/v1/submitMessage";
    const res = await this.request(path, path, {
      method: "POST",
      // Compared byte for byte by the node: no "; charset=" suffix.
      headers: { "Content-Type": "application/octet-stream" },
      body: Message.encode(message).finish(),
    }, SUBMIT_TIMEOUT_MS);
    if (res.ok) return { duplicate: false };
    const error = toNodeError(res.status, path, res.text);
    if (error.code === "bad_request.duplicate") return { duplicate: true };
    throw error;
  }

  /** Yields a paged route one page at a time until it is exhausted. Breaking out stops the fetching. */
  async *pages(path: string, query: Query, pageSize: number): AsyncGenerator<MessageJson[]> {
    let token: string | undefined;
    for (;;) {
      const page = await this.get<PageJson>(path, { ...query, pageSize, pageToken: token });
      yield page.messages;
      if (page.messages.length === 0 || isLastPage(page.nextPageToken)) return;
      token = page.nextPageToken ?? undefined;
    }
  }

  // Resolves with the response once its body is read, so the slot is held for the whole exchange.
  private request(path: string, pathAndQuery: string, init: RequestInit, timeoutMs: number): Promise<{ ok: boolean; status: number; text: string }> {
    return withSlot(this.url, async () => {
      try {
        const res = await fetch(`${this.url}${pathAndQuery}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
        const text = await res.text();
        const nodeTime = Date.parse(res.headers.get("date") ?? "");
        if (!Number.isNaN(nodeTime)) this.clockSkewMs = Date.now() - nodeTime;
        return { ok: res.ok, status: res.status, text };
      } catch (e) {
        throw this.unreachable(path, e, timeoutMs);
      }
    });
  }

  private unreachable(path: string, e: unknown, timeoutMs: number): TcError {
    const hint = "Check the node with ./threecast status.";
    if (e instanceof Error && e.name === "TimeoutError") {
      return new TcError(`${this.url} did not answer ${path} within ${Math.round(timeoutMs / 1000)} s.`, hint);
    }
    const cause = e instanceof Error && e.cause instanceof Error ? e.cause : undefined;
    const code = cause && "code" in cause ? String(cause.code) : "";
    if (code === "ECONNREFUSED") return new TcError(`Nothing is listening at ${this.url}.`, hint);
    if (code === "ENOTFOUND") return new TcError(`The host in ${this.url} does not resolve.`, "Check the --node address for typos.");
    // The SSH tunnel accepts on this laptop, then hangs up when nothing listens on the server's 3381.
    if (/^http:\/\/(127\.0\.0\.1|localhost)(:|$)/.test(this.url) && (code === "UND_ERR_SOCKET" || code === "ECONNRESET")) {
      return new TcError(
        `${this.url} closed the connection without answering.`,
        "Through the SSH tunnel, that usually means the node on the server is not running yet (or is restarting). ./threecast status shows where it is.",
      );
    }
    const why = code || cause?.message || (e instanceof Error ? e.message : String(e));
    return new TcError(`Could not reach ${this.url} (${why}).`, hint);
  }
}

// Errors come back as JSON {error, error_detail}, except query-parse failures, which are plain text.
function toNodeError(status: number, path: string, text: string): NodeError {
  try {
    const body = JSON.parse(text) as { error?: unknown; error_detail?: unknown };
    if (typeof body.error === "string") {
      return new NodeError(status, path, body.error, typeof body.error_detail === "string" ? body.error_detail : "");
    }
  } catch {
    // plain text body
  }
  return new NodeError(status, path, text.trim() || `HTTP ${status}`, "");
}

export interface NodeStatus {
  version: string;
  synced: boolean;
  shards: { id: number; height: number; delay: number; messages: number }[];
  /** This laptop's clock minus the node's, in ms, or null when the node sent no Date header. */
  clockSkewMs: number | null;
}

/**
 * GET /v1/info plus the sync gate threecast uses everywhere: shards 0, 1 and 2 all present and
 * within 10 s of the newest block, and shard 0 holding over a million messages. Shard 0 is where
 * fids and keys live; a node without it answers every submit with "unknown fid".
 */
export async function readStatus(hub: Hub): Promise<NodeStatus> {
  const info = await hub.get<InfoJson>("/v1/info", {}, 10_000);
  const shards = (info.shardInfos ?? [])
    .map((s) => ({ id: s.shardId, height: s.maxHeight, delay: s.blockDelay, messages: s.numMessages }))
    .sort((a, b) => a.id - b.id);
  const core = [0, 1, 2].map((id) => shards.find((s) => s.id === id));
  const synced = core.every((s) => s !== undefined && s.delay <= 10) && (core[0]?.messages ?? 0) > 1_000_000;
  return { version: info.version, synced, shards, clockSkewMs: hub.clockSkewMs ?? null };
}
