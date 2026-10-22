// threecast — MIT License
// The local web client: three static files and a small JSON API over api.ts, on 127.0.0.1 only.
// Any website open in the same browser can send requests to 127.0.0.1, so every /api request must
// carry the per-process token that only this server's page can read, the Host header must name
// this server (which defeats DNS rebinding), and no CORS headers are ever sent.

import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import * as api from "./api.ts";
import type { FeedFilter, Post, Session } from "./api.ts";
import { TcError } from "./api.ts";
import { say } from "./out.ts";

const PORTS_TO_TRY = 10;
const MAX_BODY_BYTES = 16 * 1024;
// As many casts as the page shows at most; each costs the node two reactionById reads.
const MAX_REACTION_REFS = 100;
const APPS_SAMPLE = 100;
const APPS_FRESH_MS = 2 * 60_000;
const TOKEN_PLACEHOLDER = "__THREECAST_TOKEN__";
const WEB_DIR = new URL("../web/", import.meta.url);

const HEADERS = {
  "Content-Security-Policy": "default-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

const STATIC_FILES: Record<string, string> = {
  "/static/app.js": "text/javascript; charset=utf-8",
  "/static/style.css": "text/css; charset=utf-8",
};

/** An answer other than 200, for requests refused before they reach api.ts. */
class Refusal extends Error {
  status: number;
  hint: string | undefined;

  constructor(status: number, message: string, hint?: string) {
    super(message);
    this.status = status;
    this.hint = hint;
  }
}

type Query = URLSearchParams;
type Body = Record<string, unknown>;

interface AppCount {
  /** What the feed filter takes for this app, the same word as after --app: "farcaster", "self", an app fid, ... */
  word: string;
  label: string;
  fid: number | null;
  count: number;
}

/**
 * Serves the web client on 127.0.0.1:`port`, or the next free port after it, prints the address
 * and opens it in the browser. Resolves once the server is listening; it then runs until Ctrl-C
 * or close().
 */
export async function startWeb(opts: { port: number; session: Session }): Promise<{ url: string; close(): Promise<void> }> {
  const { session } = opts;
  const token = randomBytes(32).toString("hex");
  const files = loadFiles(token);
  const reads = readRoutes(session);
  const writes = writeRoutes(session);

  const server = createServer((req, res) => {
    const port = (server.address() as AddressInfo).port;
    handle(req, res, { port, token: Buffer.from(token), files, reads, writes }).catch((e: unknown) => {
      // handle() answers every error itself; this only fires if writing the answer failed.
      process.stderr.write(`! The web client could not answer ${req.url ?? "a request"}: ${String(e)}\n`);
    });
  });

  const port = await listenNear(server, opts.port);
  const url = `http://127.0.0.1:${port}`;
  const who = session.viewerFid === null ? "no account" : session.canWrite ? `FID ${session.viewerFid}` : `FID ${session.viewerFid}, read-only`;
  say(`✓ Your web client is running at ${url}`);
  if (port !== opts.port) say(`  Port ${opts.port} was taken, so it uses ${port}.`);
  say(`  Only this laptop can open it. It reads through ${session.nodeUrl} as ${who}. Ctrl-C stops it.`);
  openBrowser(url);

  const stop = () => {
    say("\n✓ Stopped the web client. ./threecast client starts it again.");
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return {
    url,
    close: () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}

function loadFiles(token: string): Map<string, { type: string; body: Buffer }> {
  const read = (name: string) => {
    try {
      return readFileSync(new URL(name, WEB_DIR));
    } catch {
      throw new TcError(`The web client's ${name} is missing from client/web/.`, "Restore the checkout (git checkout client/web), then start it again.");
    }
  };
  const index = read("index.html").toString("utf8");
  if (!index.includes(TOKEN_PLACEHOLDER)) throw new TcError(`client/web/index.html has no ${TOKEN_PLACEHOLDER} to fill in.`);
  const files = new Map([["/", { type: "text/html; charset=utf-8", body: Buffer.from(index.replace(TOKEN_PLACEHOLDER, token)) }]]);
  for (const [path, type] of Object.entries(STATIC_FILES)) files.set(path, { type, body: read(path.slice("/static/".length)) });
  return files;
}

async function listenNear(server: Server, first: number): Promise<number> {
  for (let port = first; port < first + PORTS_TO_TRY; port++) {
    if (await listen(server, port)) return port;
  }
  throw new TcError(
    `Ports ${first} to ${first + PORTS_TO_TRY - 1} on 127.0.0.1 are all taken.`,
    "Another web client is probably running: stop it with Ctrl-C in its terminal, or open the address it printed.",
  );
}

function listen(server: Server, port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const onError = (e: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      if (e.code === "EADDRINUSE") resolve(false);
      else reject(e);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve(true);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

function openBrowser(url: string): void {
  const skip = process.env.THREECAST_NO_OPEN;
  if (skip && skip !== "0") return;
  const command = process.platform === "darwin" ? "open" : process.platform === "linux" ? "xdg-open" : undefined;
  if (!command) return;
  const child = spawn(command, [url], { stdio: "ignore", detached: true });
  child.on("error", () => say(`  Could not open a browser (${command} failed). Open ${url} yourself.`));
  child.unref();
}

interface Context {
  port: number;
  token: Buffer;
  files: Map<string, { type: string; body: Buffer }>;
  reads: Record<string, (q: Query) => Promise<unknown>>;
  writes: Record<string, (body: Body) => Promise<unknown>>;
}

async function handle(req: IncomingMessage, res: ServerResponse, ctx: Context): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const path = url.pathname;
  const isApi = path.startsWith("/api/");
  try {
    checkHost(req, ctx.port);
    if (!isApi) return serveFile(req, res, ctx, path);
    checkCaller(req, ctx);
    const read = Object.hasOwn(ctx.reads, path) ? ctx.reads[path] : undefined;
    const write = Object.hasOwn(ctx.writes, path) ? ctx.writes[path] : undefined;
    if (!read && !write) throw new Refusal(404, `There is no ${path} in this web client.`);
    if (read && req.method === "GET") return sendJson(res, 200, await read(url.searchParams));
    if (write && req.method === "POST") return sendJson(res, 200, await write(await readJson(req)));
    throw new Refusal(405, `${path} does not take ${req.method ?? "this method"}.`);
  } catch (e) {
    const { status, body } = errorAnswer(e, path);
    if (isApi) return sendJson(res, status, body);
    send(res, status, "text/plain; charset=utf-8", `${body.error}${body.hint ? `\n${body.hint}` : ""}\n`);
  }
}

// A page on another site can make the browser resolve its own hostname to 127.0.0.1 and then read
// this server as "same origin". The Host header still carries that other name, so it is refused.
function checkHost(req: IncomingMessage, port: number): void {
  const host = (req.headers.host ?? "").toLowerCase();
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
    throw new Refusal(403, `This web client only answers to 127.0.0.1:${port} (the request named "${host}").`, `Open http://127.0.0.1:${port} directly.`);
  }
}

function checkCaller(req: IncomingMessage, ctx: Context): void {
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== `http://127.0.0.1:${ctx.port}` && origin !== `http://localhost:${ctx.port}`) {
    throw new Refusal(403, `Requests from ${origin} are not allowed.`);
  }
  const given = req.headers["x-threecast-token"];
  // Lengths are compared in bytes: timingSafeEqual throws on buffers of different sizes.
  const bytes = typeof given === "string" ? Buffer.from(given) : undefined;
  const ok = bytes !== undefined && bytes.length === ctx.token.length && timingSafeEqual(bytes, ctx.token);
  if (!ok) {
    throw new Refusal(403, "This page's token does not match the running web client.", "The token changes every time the web client starts: reload the page.");
  }
}

function serveFile(req: IncomingMessage, res: ServerResponse, ctx: Context, path: string): void {
  const file = ctx.files.get(path);
  if (!file) throw new Refusal(404, `There is no ${path} here.`, `The client lives at http://127.0.0.1:${ctx.port}/`);
  if (req.method !== "GET") throw new Refusal(405, `${path} only answers GET.`);
  send(res, 200, file.type, file.body);
}

function send(res: ServerResponse, status: number, type: string, body: string | Buffer): void {
  res.writeHead(status, { ...HEADERS, "Content-Type": type, "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  send(res, status, "application/json; charset=utf-8", JSON.stringify(value ?? null));
}

function errorAnswer(e: unknown, path: string): { status: number; body: { error: string; hint?: string } } {
  if (e instanceof Refusal) return { status: e.status, body: { error: e.message, hint: e.hint } };
  if (e instanceof TcError) return { status: 400, body: { error: e.message, hint: e.hint } };
  const message = e instanceof Error ? e.message : String(e);
  process.stderr.write(`✗ Unexpected error in ${path}: ${message}\n`);
  if (process.env.THREECAST_DEBUG && e instanceof Error) process.stderr.write(`${e.stack}\n`);
  return { status: 500, body: { error: `Unexpected error: ${message}`, hint: "This is a threecast bug. Please report it with what you clicked." } };
}

function readJson(req: IncomingMessage): Promise<Body> {
  // Insisting on JSON also keeps out plain HTML forms, which can only send form encodings or text.
  const type = (req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
  if (type !== "application/json") return Promise.reject(new Refusal(415, "Send the request body as application/json."));
  const tooLarge = new Refusal(413, `The request body is over ${MAX_BODY_BYTES} bytes.`);
  if (Number(req.headers["content-length"] ?? 0) > MAX_BODY_BYTES) return Promise.reject(tooLarge);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      chunks.push(chunk);
      if (size <= MAX_BODY_BYTES) return;
      // Keep reading and discarding the rest, so the refusal reaches the client instead of a reset.
      req.off("data", onData);
      req.resume();
      reject(tooLarge);
    };
    req.on("data", onData);
    req.on("error", reject);
    req.on("end", () => {
      try {
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (value && typeof value === "object" && !Array.isArray(value)) resolve(value as Body);
        else reject(new Refusal(400, "The request body must be a JSON object."));
      } catch {
        reject(new Refusal(400, "The request body is not valid JSON."));
      }
    });
  });
}

function readRoutes(session: Session): Record<string, (q: Query) => Promise<unknown>> {
  const appCounts = appCounter(session);
  return {
    "/api/session": () => sessionInfo(session),
    "/api/feed": (q) => api.homeFeed(session, feedFilter(q)),
    "/api/apps": (q) => appCounts(flagParam(q, "replies")),
    "/api/profile": (q) => api.profile(session, userParam(q)),
    "/api/user-casts": (q) => api.userCasts(session, userParam(q), { replies: flagParam(q, "replies"), limit: limitParam(q) }),
    "/api/node": () => api.nodeStatus(session),
    "/api/reactions": (q) => api.viewerReactions(session, refsParam(q)),
  };
}

function writeRoutes(session: Session): Record<string, (body: Body) => Promise<unknown>> {
  return {
    "/api/cast": async (body) => {
      const replyTo = optionalString(body, "replyTo");
      const result = await api.post(session, requiredString(body, "text"), { replyTo: replyTo === undefined ? undefined : castRef(replyTo) });
      log(result.confirmed, `${replyTo ? "Reply" : "Cast"} ${result.ref} (CAST_ADD)`);
      return result;
    },
    "/api/react": async (body) => {
      const kind = body.kind;
      if (kind !== "like" && kind !== "recast") throw new TcError(`"kind" must be "like" or "recast".`);
      const ref = castRef(requiredString(body, "ref"));
      const undo = optionalFlag(body, "undo");
      const result = await api.react(session, kind, ref, undo);
      log(result.confirmed, `${undo ? "Took back the" : "Sent a"} ${kind} on ${ref} (${undo ? "REACTION_REMOVE" : "REACTION_ADD"})`);
      return result;
    },
    "/api/follow": async (body) => {
      const undo = optionalFlag(body, "undo");
      const result = await api.follow(session, requiredString(body, "user"), undo);
      log(result.confirmed, `${undo ? "Unfollowed" : "Followed"} FID ${result.fid} (${undo ? "LINK_REMOVE" : "LINK_ADD"})`);
      return result;
    },
    "/api/delete": async (body) => {
      const ref = castRef(requiredString(body, "ref"));
      const result = await api.remove(session, ref);
      log(result.confirmed, `Deleted ${ref} (CAST_REMOVE)`);
      return result;
    },
  };
}

// The terminal that started the web client narrates what the page publishes.
function log(confirmed: boolean, what: string): void {
  say(confirmed ? `✓ ${what}: your node serves it.` : `! ${what}: accepted, not visible on your node yet.`);
}

async function sessionInfo(session: Session): Promise<unknown> {
  let viewer: api.Author | null = null;
  if (session.viewerFid !== null) {
    try {
      viewer = (await api.profile(session, String(session.viewerFid))).author;
    } catch {
      // The node line on the page reports an unreachable node; the viewer then shows as a bare fid.
    }
  }
  const host = new URL(session.nodeUrl).hostname;
  return {
    nodeUrl: session.nodeUrl,
    // 127.0.0.1 is the SSH tunnel to the user's own node; anything else is a node they named.
    ownNode: host === "127.0.0.1" || host === "localhost" || host === "[::1]",
    viewerFid: session.viewerFid,
    canWrite: session.canWrite,
    viewer,
  };
}

/**
 * Counts the apps behind the latest casts in the home feed, unfiltered, so the page can offer
 * them as filters. It reads the whole feed again, so one answer is reused for two minutes.
 */
function appCounter(session: Session): (replies: boolean) => Promise<{ sample: number; apps: AppCount[] }> {
  const recent = new Map<boolean, { at: number; answer: Promise<{ sample: number; apps: AppCount[] }> }>();
  return (replies) => {
    const hit = recent.get(replies);
    if (hit && Date.now() - hit.at < APPS_FRESH_MS) return hit.answer;
    const answer = api.homeFeed(session, { limit: APPS_SAMPLE, replies }).then(({ posts }) => ({ sample: posts.length, apps: countApps(posts) }));
    answer.catch(() => recent.delete(replies));
    recent.set(replies, { at: Date.now(), answer });
    return answer;
  };
}

// Grouped by the filter word rather than by label, so that each button selects exactly the posts
// it counts: every self-requested key (own key, threecast) is one "self" group whatever the author.
function countApps(posts: Post[]): AppCount[] {
  const groups = new Map<string, AppCount>();
  for (const post of posts) {
    const word = api.filterWord(post.app);
    const group = groups.get(word);
    if (group) group.count++;
    else groups.set(word, { word, label: word === "self" || word === "unknown" ? word : post.app.label, fid: word === "self" ? null : post.app.fid, count: 1 });
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function feedFilter(q: Query): FeedFilter {
  const unknown = q.get("unknown") ?? undefined;
  if (unknown !== undefined && unknown !== "include" && unknown !== "exclude") {
    throw new TcError(`"unknown" must be include or exclude, not "${unknown}".`);
  }
  return { apps: words(q.get("app")), notApps: words(q.get("notApp")), unknown, replies: flagParam(q, "replies"), limit: limitParam(q) };
}

function words(value: string | null): string[] | undefined {
  const list = (value ?? "").split(",").map((w) => w.trim()).filter(Boolean);
  return list.length > 0 ? list : undefined;
}

function flagParam(q: Query, name: string): boolean {
  const value = q.get(name);
  return value === "1" || value === "true";
}

function limitParam(q: Query): number | undefined {
  const value = q.get("limit");
  if (value === null) return undefined;
  const n = /^\d+$/.test(value) ? Number(value) : NaN;
  if (!(n >= 1 && n <= 100)) throw new TcError(`"limit" takes a whole number from 1 to 100, not "${value}".`);
  return n;
}

function refsParam(q: Query): string[] {
  const refs = [...new Set(words(q.get("refs")) ?? [])].map(castRef);
  if (refs.length > MAX_REACTION_REFS) throw new TcError(`Ask about at most ${MAX_REACTION_REFS} casts at a time, not ${refs.length}.`);
  return refs;
}

function userParam(q: Query): string {
  const user = q.get("user")?.trim();
  if (!user) throw new TcError("Which account? Pass ?user=@name or a numeric FID.");
  return user;
}

function requiredString(body: Body, key: string): string {
  const value = body[key];
  if (typeof value !== "string") throw new TcError(`"${key}" must be a string.`);
  return value;
}

function optionalString(body: Body, key: string): string | undefined {
  return body[key] === undefined || body[key] === null ? undefined : requiredString(body, key);
}

function optionalFlag(body: Body, key: string): boolean {
  const value = body[key] ?? false;
  if (typeof value !== "boolean") throw new TcError(`"${key}" must be true or false.`);
  return value;
}

// The CLI also accepts "3" for item 3 of its last printed feed. The page always knows the full
// reference, and a bare number here would silently point at whatever the terminal printed last.
function castRef(ref: string): string {
  if (!/^\d+:0x[0-9a-fA-F]{40}$/.test(ref.trim())) {
    throw new TcError(`"${ref}" is not a cast reference.`, "The web client sends fid:0xhash; reload the page and try again.");
  }
  return ref.trim();
}
