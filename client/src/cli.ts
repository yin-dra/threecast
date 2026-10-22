// threecast — MIT License
// The command-line client. ./threecast hands every client command to this file (lib/client.sh);
// it also runs on its own: node src/cli.ts feed --node https://snap.farcaster.xyz:3381 --as 3

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as api from "./api.ts";
import type { AppTag, FeedFilter, Post, Session } from "./api.ts";
import { login, logout } from "./account.ts";
import { TcError } from "./errors.ts";
import { Hub } from "./hub.ts";
import { ago, displayName, duration, short, shortRef, wrap } from "./format.ts";
import { bold, columns, dim, fail, hint, ok, print, say, step, warn } from "./out.ts";
import { newAccount } from "./register.ts";
import { accountPath, currentFid, loadAccount, saveLastFeed } from "./store.ts";
import { FOLLOW_CAP } from "./feed.ts";
import { CAST_MAX_BYTES, MAX_MENTIONS, castKind, clockProblem, keyState, mentionTokens } from "./write.ts";

type FlagKind = "string" | "boolean";
// [kind, help, placeholder shown in --help for string flags]
type FlagSpec = [FlagKind, string, string?];
type Flags = Record<string, string | true | undefined>;

interface Command {
  usage: string;
  about: string[];
  flags: Record<string, FlagSpec>;
  run(args: string[], flags: Flags): Promise<number | void>;
}

const NODE_FLAG: Record<string, FlagSpec> = {
  node: ["string", "the node to use, e.g. https://snap.farcaster.xyz:3381 (default: your node, through the SSH tunnel)", "URL"],
};
const READ_FLAGS: Record<string, FlagSpec> = {
  ...NODE_FLAG,
  as: ["string", "read as this FID instead of your account (read-only; no login needed)", "FID"],
  json: ["boolean", "print JSON instead of text"],
};
const FILTER_FLAGS: Record<string, FlagSpec> = {
  app: ["string", "only casts made with these apps: fids or names, comma-separated (farcaster, base, self, ...)", "LIST"],
  "not-app": ["string", "hide casts made with these apps", "LIST"],
  unknown: ["string", "show or hide casts whose app cannot be told (default: hide once --app is set)", "include|exclude"],
  replies: ["boolean", "include replies (hidden by default)"],
  limit: ["string", "how many casts to show (default 20)", "N"],
};

const COMMANDS: Record<string, Command> = {
  login: {
    usage: "login [--phrase-file PATH] [--account-index N]",
    about: [
      "Authorizes a new app key for a TEST account from its recovery phrase, with one gasless KEY_ADD. The phrase is read from a hidden prompt (or a file), used to sign that one message, and never saved.",
    ],
    flags: {
      ...NODE_FLAG,
      "phrase-file": ["string", "read the phrase from this file instead of the prompt", "PATH"],
      "account-index": ["string", "address index for phrases from other wallets (m/44'/60'/0'/0/N, default 0)", "N"],
    },
    async run(args, flags) {
      none(args, "login");
      const session = await api.openSession({ node: str(flags.node) });
      const index = flags["account-index"] === undefined ? undefined : count(flags["account-index"], "--account-index", 0, 1000);
      await login(new Hub(session.nodeUrl), { phraseFile: str(flags["phrase-file"]), accountIndex: index });
      say();
      say(`Next: ./threecast client opens your feed in the browser, or try ./threecast cast "hello from my own node"`);
    },
  },

  "new-account": {
    usage: "new-account [--recovery ADDRESS] [--phrase-file PATH] [--rpc URL]",
    about: [
      "Creates a new TEST account. It generates a recovery phrase on this laptop and shows it once, waits for you to send about $0.21 of ETH on Optimism to the account's address, asks, registers it (IdGateway.register on OP Mainnet), and then logs in with it like ./threecast login.",
    ],
    flags: {
      ...NODE_FLAG,
      recovery: ["string", "an address that can recover the account if the phrase is lost (default: none)", "ADDRESS"],
      "phrase-file": ["string", "resume with a phrase from an earlier run instead of generating one", "PATH"],
      rpc: ["string", "OP Mainnet JSON-RPC endpoint (default: https://mainnet.optimism.io)", "URL"],
    },
    async run(args, flags) {
      none(args, "new-account");
      // It shows a phrase on screen and asks before paying: both need a person at a terminal.
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new TcError("new-account needs a terminal: it shows a recovery phrase once and asks before spending.", "Run it directly in a terminal window, not through a pipe or a log.");
      }
      const session = await api.openSession({ node: str(flags.node) });
      await newAccount(new Hub(session.nodeUrl), { recovery: str(flags.recovery), phraseFile: str(flags["phrase-file"]), rpcUrl: str(flags.rpc) });
      say();
      say(`Next: ./threecast client opens your feed, or ./threecast cast "hello from my own node"`);
      hint("The account has no username yet; set one in any Farcaster app.");
    },
  },

  whoami: {
    usage: "whoami",
    about: ["Shows the logged-in account, where its app key is stored, and whether the node lists the key as active."],
    flags: NODE_FLAG,
    async run(args, flags) {
      none(args, "whoami");
      const fid = currentFid();
      const account = fid === undefined ? undefined : loadAccount(fid);
      if (!account) {
        say("Not logged in.");
        hint("Log in with ./threecast login (a TEST account's recovery phrase).");
        return;
      }
      // What this laptop knows comes first, so it shows even when the node cannot be reached.
      say(bold(`FID ${account.fid}`));
      const column = 19;
      say(`  Custody address  ${account.custodyAddress}`, column);
      say(`  App key          ${account.appKeyPublic}`, column);
      say(`  Stored in        ${accountPath(account.fid)} (the phrase is not stored)`, column);
      let session: Session;
      try {
        session = await api.openSession({ node: str(flags.node) });
      } catch {
        say("  On the network   unknown: no node configured (pass --node URL)", column);
        return;
      }
      try {
        const [author, state] = await Promise.all([api.profile(session, String(account.fid)).then((p) => p.author), keyState(new Hub(session.nodeUrl), account)]);
        const until = (s: number) => new Date(s * 1000).toISOString().slice(0, 10);
        const line =
          state.state === "active"
            ? `active${state.expiresAt ? `, expires ${until(state.expiresAt)} unless used before then` : ""}`
            : state.state === "expired"
              ? `expired on ${until(state.expiresAt)}; run ./threecast login for a new key`
              : "not listed: still merging if you just logged in, otherwise run ./threecast login";
        say(`  Name             ${displayName(author)}`, column);
        say(`  On the network   ${line} (asked ${session.nodeUrl})`, column);
      } catch (e) {
        if (!(e instanceof TcError)) throw e;
        say(`  On the network   unknown: ${e.message}`, column);
        if (e.hint) hint(e.hint);
        return 1;
      }
    },
  },

  logout: {
    usage: "logout",
    about: [
      "Revokes this laptop's app key with a KEY_REMOVE signed by the key itself (no phrase needed), then deletes the local key file. Casts made with the key stay on the network.",
    ],
    flags: NODE_FLAG,
    async run(args, flags) {
      none(args, "logout");
      const fid = currentFid();
      const account = fid === undefined ? undefined : loadAccount(fid);
      if (!account) throw new TcError("You are not logged in, so there is no key to revoke.", "./threecast whoami shows which account this laptop uses.");
      const session = await api.openSession({ node: str(flags.node) });
      await logout(new Hub(session.nodeUrl), account);
    },
  },

  feed: {
    usage: "feed [--app LIST] [--not-app LIST] [--unknown include|exclude] [--replies] [--limit N] [--as FID]",
    about: [
      "Recent casts from the accounts you follow, newest first, each tagged with the app that made it.",
      "Numbers (#1, #2, ...) can be used with like, recast, delete and --reply-to.",
    ],
    flags: { ...READ_FLAGS, ...FILTER_FLAGS },
    async run(args, flags) {
      none(args, "feed");
      const session = await readSession(flags);
      const feed = await api.homeFeed(session, filterFrom(flags));
      if (flags.json) return printJson(feed);
      remember(session, feed.posts);
      printPosts(feed.posts);
      if (feed.unread > 0) warn(`The casts of ${feed.unread} account${feed.unread === 1 ? "" : "s"} could not be read this time, so they are missing here. Run the command again to retry.`);
      const whose = session.canWrite ? "you follow" : `FID ${session.viewerFid} follows`;
      if (feed.following === 0) {
        say(`FID ${session.viewerFid} does not follow anyone yet, so there is nothing to show.`);
        hint(session.canWrite ? "Follow someone first: ./threecast follow @dwr" : "Try an account that follows people, e.g. --as 3");
        return;
      }
      if (feed.posts.length === 0) {
        say(`None of the ${feed.scanned} recent casts from the accounts ${whose} matched.`);
        noteFutureDated(feed.futureDated);
        hint(`./threecast apps${asFlag(session)} shows which apps appear in this feed and the words --app accepts.`);
        return;
      }
      const scope = feed.following > FOLLOW_CAP ? `the ${FOLLOW_CAP} most recent of the ${feed.following} accounts ${whose}` : `the ${feed.following} accounts ${whose}`;
      say(dim(`${feed.posts.length} of ${feed.scanned} recent casts from ${scope}, read from ${session.nodeUrl}.`));
      noteFutureDated(feed.futureDated);
      if (session.canWrite) say(dim(`Next: ./threecast like 1 · cast "…" --reply-to 1 · feed --app farcaster`));
      else if (currentFid() !== undefined) say(dim(`Read-only view as FID ${session.viewerFid}. Leave out --as to act as yourself.`));
      else say(dim("Read-only view. Log in (./threecast login) to like, recast and reply."));
    },
  },

  apps: {
    usage: "apps [--limit N] [--replies] [--as FID]",
    about: [
      "Which apps made the casts in your feed. A cast carries no app name: threecast looks up the key that signed it (GET /v1/signer) and the app fid that requested that key.",
    ],
    flags: { ...READ_FLAGS, replies: FILTER_FLAGS.replies as FlagSpec, limit: ["string", "how many recent casts to count (default 100)", "N"] },
    async run(args, flags) {
      none(args, "apps");
      const session = await readSession(flags);
      const limit = flags.limit === undefined ? 100 : count(flags.limit, "--limit", 1, 500);
      const feed = await api.homeFeed(session, { limit, replies: flags.replies === true });
      const rows = api.appBreakdown(feed.posts);
      if (flags.json) return printJson(rows);
      if (rows.length === 0) {
        say(feed.following === 0 ? `FID ${session.viewerFid} does not follow anyone, so there are no casts to count.` : "There are no casts to count yet.");
        hint(session.canWrite ? "Follow someone first: ./threecast follow @dwr" : "Try an account that follows people, e.g. --as 3");
        return;
      }
      say(`Apps behind the ${feed.posts.length} most recent casts in FID ${session.viewerFid}'s home feed:`);
      const width = Math.max(...rows.map((r) => r.app.label.length));
      for (const { app, count: n } of rows) {
        const share = `${Math.round((100 * n) / feed.posts.length)}%`.padStart(4);
        say(`  ${String(n).padStart(4)} ${share}  ${app.label.padEnd(width)}  ${dim(describeApp(app))}`);
      }
      say();
      say(dim("Filter the feed with the word after --app, for example:"));
      say(dim(`  ./threecast feed --app farcaster${asFlag(session)}    ./threecast feed --not-app self${asFlag(session)}`));
    },
  },

  profile: {
    usage: "profile USER [--limit N] [--as FID]",
    about: ["Shows an account (USER is @name, name, or a numeric FID) and its latest casts."],
    flags: { ...READ_FLAGS, replies: FILTER_FLAGS.replies as FlagSpec, limit: ["string", "how many casts to show (default 5)", "N"] },
    async run(args, flags) {
      const user = one(args, "USER", "profile @dwr");
      const session = await readSession(flags, false);
      const limit = flags.limit === undefined ? 5 : count(flags.limit, "--limit", 1, 100);
      const [p, { posts: casts, futureDated }] = await Promise.all([api.profile(session, user), api.userCasts(session, user, { limit, replies: flags.replies === true })]);
      if (flags.json) return printJson({ ...p, casts, futureDated });
      say(`${bold(displayName(p.author))}  ${dim(`FID ${p.author.fid}`)}`);
      if (p.bio) for (const line of p.bio.split("\n")) say(`  ${line}`);
      const relation = p.followedByViewer === null ? "" : p.followedByViewer ? " · you follow them" : " · you do not follow them";
      say(dim(`  Follows ${p.following} accounts${relation}`));
      say();
      remember(session, casts);
      if (casts.length === 0) say("No casts to show.");
      printPosts(casts);
      noteFutureDated(futureDated);
    },
  },

  cast: {
    usage: 'cast "TEXT" [--reply-to REF]',
    about: [
      "Publishes a cast signed with your app key. Up to 320 bytes is a regular cast; up to 1024 is sent as a long cast. REF is a number from the last feed (like 3) or fid:0xhash.",
      `Each @name becomes a mention: the cast stores that account's FID and where the name goes, so the mention keeps pointing at the account if it is renamed. Mentioned names do not count toward the size, and a cast can mention up to ${MAX_MENTIONS} accounts.`,
    ],
    flags: { ...NODE_FLAG, "reply-to": ["string", "reply to this cast: a number from the last feed, or fid:0xhash", "REF"] },
    async run(args, flags) {
      if (args.length === 0) throw new TcError("What should the cast say?", `Example: ./threecast cast "hello from my own node"`);
      const text = args.join(" ");
      if (text.trim() === "") castKind(text);
      const session = await writeSession(flags);
      const names = [...new Set(mentionTokens(text).map((t) => `@${t.name}`))];
      if (names.length > 0) step(`Looking up ${list(names)} on ${session.nodeUrl} to turn ${names.length === 1 ? "it into a mention" : "them into mentions"} (userNameProofByName)…`);
      const draft = await api.draftCast(session, text);
      for (const name of draft.unknown) warn(`No account is called @${name} on this node, so it stays plain text.`);
      if (draft.overLimit.length > 0) warn(`A cast can mention at most ${MAX_MENTIONS} accounts, so ${list(draft.overLimit.map((n) => `@${n}`))} stay${draft.overLimit.length === 1 ? "s" : ""} plain text.`);
      if (draft.long) warn(`${draft.bytes} bytes is over ${CAST_MAX_BYTES}, so this goes out as a long cast (up to 1024 bytes). Some apps cut long casts short.`);
      const replyTo = str(flags["reply-to"]);
      const n = draft.mentions.length;
      const what = [replyTo ? "a reply" : "", n > 0 ? `${n} mention${n === 1 ? "" : "s"}` : ""].filter(Boolean).join(", ");
      step(`Signing a CAST_ADD${what ? ` (${what})` : ""} with your app key and submitting it to ${session.nodeUrl}…`);
      const result = await api.post(session, draft, { replyTo });
      if (!result.confirmed) return unconfirmed(result.ref);
      ok(`Published ${shortRef(result.ref)}: your node served it back after ${(result.ms / 1000).toFixed(1)} s.`);
      hint(`Reply to it: ./threecast cast "…" --reply-to ${result.ref}`);
    },
  },

  delete: {
    usage: "delete REF",
    about: ["Deletes one of your casts with a CAST_REMOVE. Other apps may have shown it already; the network stops serving it."],
    flags: NODE_FLAG,
    async run(args, flags) {
      const ref = one(args, "REF", "delete 3");
      const session = await writeSession(flags);
      step(`Signing a CAST_REMOVE and submitting it to ${session.nodeUrl}…`);
      const { confirmed } = await api.remove(session, ref);
      if (!confirmed) return unconfirmed(ref);
      ok("Deleted: your node no longer serves that cast.");
    },
  },

  like: reaction("like", false),
  unlike: reaction("like", true),
  recast: reaction("recast", false),
  unrecast: reaction("recast", true),
  follow: following(false),
  unfollow: following(true),

  web: {
    usage: "web [--as FID]",
    about: ["Starts the local web client on http://127.0.0.1:4040, or the next free port after it (./threecast client does this for you)."],
    flags: { ...NODE_FLAG, as: READ_FLAGS.as as FlagSpec },
    async run(args, flags) {
      none(args, "web");
      const session = await readSession(flags, false);
      const file = new URL("./web.ts", import.meta.url);
      if (!existsSync(fileURLToPath(file))) {
        throw new TcError("The web client is not in this checkout (client/src/web.ts is missing).", "The command line works meanwhile: ./threecast feed, ./threecast cast \"…\"");
      }
      const web = (await import(file.href)) as { startWeb(options: { port: number; session: Session }): Promise<unknown> };
      await web.startWeb({ port: 4040, session });
    },
  },

  // Used by lib/client.sh before opening the web client. Exit 0 when synced, 3 when still syncing.
  ping: {
    usage: "ping",
    about: ["Checks that the node answers and is synced."],
    flags: NODE_FLAG,
    async run(args, flags) {
      none(args, "ping");
      const session = await api.openSession({ node: str(flags.node) });
      const status = await api.nodeStatus(session);
      const clock = clockProblem(status.clockSkewMs);
      if (clock) warn(`${clock} Turn on automatic date and time before you post.`);
      const shards = status.shards.map((s) => `shard ${s.id} ${s.delay <= 10 ? "current" : `${duration(s.delay)} behind`}`).join(", ");
      if (status.synced) {
        ok(`The node at ${session.nodeUrl} is synced (snapchain ${status.version}; ${shards}).`);
        return 0;
      }
      warn(`The node at ${session.nodeUrl} answers but is not synced yet (${shards || "no shards reported"}).`);
      return 3;
    },
  },
};

function reaction(kind: "like" | "recast", undo: boolean): Command {
  const name = `${undo ? "un" : ""}${kind}`;
  const type = undo ? "REACTION_REMOVE" : "REACTION_ADD";
  return {
    usage: `${name} REF`,
    about: [`${undo ? `Takes back a ${kind}` : kind === "like" ? "Likes a cast" : "Recasts a cast to your followers"} (${type}). REF is a number from the last feed or fid:0xhash.`],
    flags: NODE_FLAG,
    async run(args, flags) {
      const ref = one(args, "REF", `${name} 3`);
      const session = await writeSession(flags);
      step(`Signing a ${type} (${kind}) and submitting it to ${session.nodeUrl}…`);
      const { confirmed } = await api.react(session, kind, ref, undo);
      if (!confirmed) return unconfirmed(ref);
      const done = { like: ["Liked", "Unliked"], recast: ["Recast", "Took back the recast"] }[kind][undo ? 1 : 0];
      ok(`${done}: your node shows the change.`);
    },
  };
}

function following(undo: boolean): Command {
  const name = undo ? "unfollow" : "follow";
  const type = undo ? "LINK_REMOVE" : "LINK_ADD";
  return {
    usage: `${name} USER`,
    about: [`${undo ? "Stops following" : "Follows"} an account (${type}). USER is @name, name, or a numeric FID.`],
    flags: NODE_FLAG,
    async run(args, flags) {
      const user = one(args, "USER", `${name} @dwr`);
      const session = await writeSession(flags);
      step(`Signing a ${type} for ${user} and submitting it to ${session.nodeUrl}…`);
      const { fid, confirmed } = await api.follow(session, user, undo);
      if (!confirmed) return unconfirmed(`FID ${fid}`);
      ok(`${undo ? "You no longer follow" : "You now follow"} ${user} (FID ${fid}).`);
    },
  };
}

function str(value: string | true | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function count(value: string | true | undefined, flag: string, min: number, max: number): number {
  const n = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!(n >= min && n <= max)) throw new TcError(`${flag} takes a whole number from ${min} to ${max}.`, `For example: ${flag} ${min === 0 ? 1 : min * 5}`);
  return n;
}

function fidFlag(value: string | true | undefined, flag: string): number {
  const n = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!(n >= 1 && Number.isSafeInteger(n))) throw new TcError(`${flag} takes an FID, a whole number.`, `For example: ${flag} 3 (that is @dwr).`);
  return n;
}

function none(args: string[], command: string): void {
  if (args.length > 0) throw new TcError(`${command} does not take "${args[0]}".`, `See ./threecast ${command} --help`);
}

function one(args: string[], name: string, example: string): string {
  if (args.length !== 1) throw new TcError(`This command takes one ${name}.`, `Example: ./threecast ${example}`);
  return args[0] as string;
}

function words(value: string | true | undefined): string[] | undefined {
  const parts = str(value)?.split(",").map((w) => w.trim()).filter(Boolean);
  return parts && parts.length > 0 ? parts : undefined;
}

/** "@a", "@a and @b", "@a, @b and @c". */
function list(items: string[]): string {
  return items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function filterFrom(flags: Flags): FeedFilter {
  const unknown = str(flags.unknown);
  if (unknown !== undefined && unknown !== "include" && unknown !== "exclude") {
    throw new TcError("--unknown takes include or exclude.");
  }
  return {
    apps: words(flags.app),
    notApps: words(flags["not-app"]),
    unknown,
    replies: flags.replies === true,
    limit: flags.limit === undefined ? undefined : count(flags.limit, "--limit", 1, 100),
  };
}

async function readSession(flags: Flags, needViewer = true): Promise<Session> {
  const as = flags.as === undefined ? undefined : fidFlag(flags.as, "--as");
  const session = await api.openSession({ node: str(flags.node), as });
  if (needViewer && session.viewerFid === null) {
    throw new TcError("You are not logged in, so there is no feed of yours to read.", "Log in with ./threecast login, or read someone else's feed with --as 3.");
  }
  return session;
}

/** " --as 3" in a suggested command when this session reads as someone else, so it runs as shown. */
function asFlag(session: Session): string {
  return session.canWrite || session.viewerFid === null ? "" : ` --as ${session.viewerFid}`;
}

async function writeSession(flags: Flags): Promise<Session> {
  const session = await api.openSession({ node: str(flags.node) });
  if (!session.canWrite) throw new TcError("You need to log in before you can post, like or follow.", "Run ./threecast login.");
  return session;
}

function unconfirmed(what: string): number {
  warn(`Your node accepted the message, but it has not shown up after two minutes (${what}).`);
  hint("It may still land: messages relay through the validators. Check again in a minute; nothing needs undoing.");
  return 1;
}

function describeApp(app: AppTag): string {
  const word = `--app ${api.filterWord(app)}`;
  if (app.fid === null) return `${word} · the key was revoked, so the app cannot be told`;
  if (app.label === "threecast") return `${word} · a key made on this laptop`;
  if (app.label === "own key") return `${word} · a key the author requested for themselves`;
  return `${word} · app FID ${app.fid}`;
}

function printPosts(posts: Post[]): void {
  posts.forEach((p, i) => {
    say(`${bold(displayName(p.author))} ${dim("·")} ${ago(p.time)} ${dim("·")} via ${p.app.label}`);
    if (p.parent && "fid" in p.parent) say(dim(`  ↪ reply to ${p.parent.fid}:${short(p.parent.hash)}`));
    else if (p.parent) say(dim(`  in ${p.parent.url}`));
    if (p.text !== "") for (const line of p.text.split("\n")) say(`  ${line}`);
    // Apps usually put a link in the text and again as an embed; show it once.
    for (const embed of new Set(p.embeds)) {
      if (/^\d+:0x/.test(embed)) say(`  ${dim("[quote]")} ${shortRef(embed)}`);
      else if (!p.text.includes(embed)) say(`  ${dim("[link]")} ${embed}`);
    }
    say(dim(`  #${i + 1}  ${shortRef(p.ref)}`));
    say();
  });
}

function noteFutureDated(count: number): void {
  if (count === 0) return;
  say(dim(`Left out ${count} cast${count === 1 ? "" : "s"} dated more than 10 minutes in the future. A cast's time comes from the app that signed it, so it can be wrong.`));
}

function remember(session: Session, posts: Post[]): void {
  saveLastFeed({ nodeUrl: session.nodeUrl, at: Date.now(), refs: posts.map((p) => p.ref) });
}

function printJson(value: unknown): void {
  print(JSON.stringify(value, null, 2));
}

function parseFlags(command: string, argv: string[], spec: Command["flags"]): { args: string[]; flags: Flags } {
  const args: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--") {
      args.push(...argv.slice(i + 1));
      break;
    }
    if (arg === "-h" || arg === "--help") {
      flags.help = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      args.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const kind = spec[name]?.[0];
    if (!kind && name === "as") {
      throw new TcError(`--as only reads (feed, apps, profile); ${command} signs with your own app key.`, "Log in with a TEST account first: ./threecast login");
    }
    if (!kind) throw new TcError(`${command} has no option --${name}.`, `See ./threecast ${command} --help`);
    if (kind === "boolean") {
      flags[name] = true;
      continue;
    }
    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
    if (value === undefined || value === "") throw new TcError(`--${name} needs a value.`, `See ./threecast ${command} --help`);
    flags[name] = value;
  }
  return { args, flags };
}

// Help is documentation: it fits 80 columns even when piped into a file or a pager.
function helpWidth(): number {
  return Math.min(columns() || 80, 80);
}

// A bracketed option such as "[--rpc URL]" is kept on one line.
function wrapUsage(usage: string, width: number, indent: number): string {
  const glued = usage.replace(/\[[^\]]*\]/g, (option) => option.replaceAll(" ", "\u00a0"));
  return wrap(glued, width, indent).replaceAll("\u00a0", " ");
}

function printHelp(name: string, command: Command): void {
  const width = helpWidth();
  print(wrapUsage(`Usage: ./threecast ${command.usage}`, width, "Usage: ./threecast ".length));
  print("");
  for (const paragraph of command.about) print(wrap(paragraph, width));
  const entries = Object.entries(command.flags);
  if (entries.length > 0) {
    print("");
    const left = ([flag, [kind, , value]]: [string, FlagSpec]) => (kind === "string" ? `--${flag} ${value ?? "VALUE"}` : `--${flag}`);
    const column = Math.max(...entries.map((entry) => left(entry).length));
    for (const entry of entries) print(wrap(`  ${left(entry).padEnd(column)}  ${entry[1][1]}`, width, column + 4));
  }
  if (name !== "web" && name !== "ping") print(dim("\nTutorial: https://yin-dra.github.io/threecast"));
}

function printOverview(): void {
  const width = helpWidth();
  print("threecast client commands (run any of them with --help):");
  print("");
  for (const [name, command] of Object.entries(COMMANDS)) {
    if (name === "ping" || name === "web") continue;
    print(wrapUsage(`  ./threecast ${command.usage}`, width, `  ./threecast ${name} `.length));
  }
}

async function main(argv: string[]): Promise<number> {
  const [name, ...rest] = argv;
  if (name === undefined || name === "help" || name === "--help" || name === "-h") {
    printOverview();
    return 0;
  }
  const command = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
  if (!command) {
    fail(`There is no command "${name}".`, "Run ./threecast help to see them all.");
    return 2;
  }
  const { args, flags } = parseFlags(name, rest, command.flags);
  if (flags.help) {
    printHelp(name, command);
    return 0;
  }
  return (await command.run(args, flags)) ?? 0;
}

// A reader that stops early (./threecast feed | head) closes the pipe. That ends the command; it is not a crash.
process.stdout.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code !== "EPIPE") throw e;
  process.exit(0);
});

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    if (e instanceof TcError) fail(e.message, e.hint);
    else {
      fail(`Unexpected error: ${e instanceof Error ? e.message : String(e)}`, "This is a threecast bug. Please report it with the command you ran.");
      if (process.env.THREECAST_DEBUG && e instanceof Error) process.stderr.write(`${e.stack}\n`);
    }
    process.exitCode = 1;
  },
);
