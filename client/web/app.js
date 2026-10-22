// threecast — MIT License
// The web client's page. It only draws: every read and every signature happens in the local
// server (src/web.ts), which talks to your node. Text from the network is always inserted as text
// nodes, never as HTML.

const token = document.querySelector('meta[name="threecast-token"]').content;
const $ = (id) => document.getElementById(id);

const CAST_BYTES = 320;
const LONG_CAST_BYTES = 1024;
const PAGE = 20;
const MAX_LIMIT = 100;
const NODE_EVERY_MS = 30_000;
const SUGGESTED = ["dwr", "v", "balajis"];

const state = {
  session: null,
  apps: null, // { replies, sample, apps } for the filter bar
  replyTo: null, // { ref, name }
  limit: PAGE,
  posting: false,
  loads: 0, // a newer load makes the answers of older ones stale
  // Whether you liked and recast each cast on the page, by ref: { like, recast, asked, clicked }.
  // Filled from your node (reactionById) after the posts are drawn, and by your clicks here.
  reactions: new Map(),
};

// `status` is the web client's HTTP status: 400 is a problem it explains (often the node's),
// 403 a page from an earlier run, and 0 means the web client itself did not answer.
class ApiError extends Error {
  constructor(message, hint, status) {
    super(message);
    this.hint = hint;
    this.status = status;
  }
}

async function call(path, body) {
  const init = { headers: { "X-Threecast-Token": token } };
  if (body !== undefined) {
    init.method = "POST";
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError("The web client is not answering.", "Is ./threecast client still running in your terminal? Start it again, then reload this page.", 0);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(data?.error ?? `The web client answered HTTP ${res.status}.`, data?.hint, res.status);
  return data;
}

// el("p", { class: "x", onclick: f }, "text", child). Strings become text nodes.
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  node.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}

let noticeTimer;

// The notice sits in the sticky top bar, so it is in view wherever the click happened.
// Successes clear themselves; errors and notes stay until dismissed.
function notify(kind, text, hint, link) {
  $("notice-kind").textContent = kind;
  $("notice-text").textContent = text;
  const extra = link ? [" ", el("a", { href: link.href }, link.text)] : [];
  $("notice-hint").replaceChildren(hint ?? "", ...extra);
  $("notice").classList.toggle("notice--error", kind === "Error");
  $("notice").hidden = false;
  clearTimeout(noticeTimer);
  if (kind === "Done") noticeTimer = setTimeout(() => ($("notice").hidden = true), 12_000);
}

function showError(e) {
  notify("Error", e.message, e.hint);
}

// Same wording as the CLI (src/format.ts). A few mainnet casts claim dates decades ahead.
function ago(time, now = Date.now()) {
  if (time - now > 600_000) return `dated ${new Date(time).toISOString().slice(0, 10)}`;
  const s = Math.max(0, Math.round((now - time) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 30 * 86_400) return `${Math.floor(s / 86_400)}d ago`;
  return new Date(time).toISOString().slice(0, 10);
}

function duration(seconds) {
  if (seconds < 120) return `${seconds} s`;
  if (seconds < 7200) return `${Math.round(seconds / 60)} min`;
  return `${Math.round(seconds / 3600)} h`;
}

function shortRef(ref) {
  const [fid, hash = ""] = ref.split(":");
  return `${fid}:${hash.slice(0, 6)}…${hash.slice(-4)}`;
}

function handle(author) {
  return author.username ? `@${author.username}` : `FID ${author.fid}`;
}

function nodeName() {
  return state.session.ownNode ? "your node" : new URL(state.session.nodeUrl).host;
}

function safeUrl(text) {
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

// A URL's last characters are usually the sentence's: "see https://x.com/a." or "(https://x.com/b)".
function trimUrl(word) {
  let w = word;
  for (;;) {
    const last = w.at(-1);
    const unbalanced = last === ")" && w.split("(").length < w.split(")").length;
    if (!".,;:!?'\"".includes(last) && !unbalanced) return w;
    w = w.slice(0, -1);
  }
}

const LINKABLE = /https?:\/\/[^\s<>"'`]+|@[a-z0-9][a-z0-9-]{0,15}(?:\.eth)?/gi;

/** Text with http(s) URLs as links that open outside, and @names as links to their profiles. */
function linkify(text) {
  const out = [];
  let last = 0;
  for (const match of text.matchAll(LINKABLE)) {
    const start = match.index;
    let word = match[0];
    let link;
    if (word.startsWith("@")) {
      // "me@example.com" is an address, not a mention.
      if (start > 0 && /[\w.]/.test(text[start - 1])) continue;
      link = el("a", { href: `#/u/${word.slice(1).toLowerCase()}` }, word);
    } else {
      word = trimUrl(word);
      const url = safeUrl(word);
      if (!url) continue;
      link = el("a", { href: url, target: "_blank", rel: "noopener noreferrer" }, word);
    }
    out.push(text.slice(last, start), link);
    last = start + word.length;
  }
  out.push(text.slice(last));
  return out;
}

function appName(post) {
  if (post.app.fid === null) return "unknown";
  if (post.app.label === "threecast") return "threecast";
  if (post.app.fid === post.fid) return "self";
  return post.app.label;
}

function appDetail(post) {
  const { fid, source, status } = post.app;
  if (fid === null) return "The key that signed this cast was revoked and its record went with it, so its app cannot be told.";
  const how = source === "onchain" ? "registered onchain in the KeyRegistry" : "added with a gasless KEY_ADD";
  const now = status === "active" ? "" : ` The key is ${status} now.`;
  if (post.app.label === "threecast") return `Signed with an app key threecast made on this laptop.${now}`;
  if (fid === post.fid) return `Signed with a key FID ${post.fid} requested for itself, ${how}.${now}`;
  return `Signed with a key that app FID ${fid} requested, ${how}.${now}`;
}

function renderViewer() {
  const s = state.session;
  const name = s.viewer?.username ? `@${s.viewer.username}` : null;
  if (s.viewerFid === null) {
    $("viewer").textContent = "not logged in";
    return;
  }
  const text = s.canWrite ? (name ?? `fid ${s.viewerFid}`) : `read-only as fid ${s.viewerFid}${name ? ` · ${name}` : ""}`;
  $("viewer").replaceChildren(el("a", { href: `#/u/${s.viewerFid}` }, text));
}

async function refreshNode() {
  $("node-label").textContent = state.session.ownNode ? "[ Your node ]" : "[ Node ]";
  const where = state.session.ownNode ? "" : `${new URL(state.session.nodeUrl).host} · `;
  const line = $("node-line");
  try {
    const status = await call("/api/node");
    const behind = Math.max(0, ...status.shards.map((s) => s.delay));
    const parts = [`v${status.version}`, `${status.shards.length} shards`, `${duration(behind)} behind`];
    if (!status.synced) parts.push("not synced yet: posting waits until it is");
    const skew = status.clockSkewMs;
    if (skew !== null && Math.abs(skew) >= 60_000) {
      parts.push(`this laptop's clock is ${duration(Math.round(Math.abs(skew) / 1000))} ${skew > 0 ? "ahead" : "behind"}; posts more than 10 min off are rejected`);
    }
    line.textContent = where + parts.join(" · ");
    $("node").classList.remove("is-down");
  } catch (e) {
    if (e.status === 400) {
      line.textContent = `${where}not answering. ${e.message} ${e.hint ?? ""}`.trim();
      $("node").classList.add("is-down");
    } else {
      line.textContent = `${where}status unknown: the web client did not answer.`;
      $("node").classList.remove("is-down");
      showError(e);
    }
  }
}

function currentView() {
  return /^#\/u\//.test(location.hash) ? "profile" : "home";
}

function readHash() {
  const [path, query = ""] = location.hash.replace(/^#/, "").split("?");
  const profile = /^\/u\/(.+)$/.exec(path);
  if (profile) return { view: "profile", user: decodeSafely(profile[1]) };
  const q = new URLSearchParams(query);
  const words = (key) => (q.get(key) ?? "").split(",").map((w) => w.trim()).filter(Boolean);
  const unknown = q.get("unknown");
  return {
    view: "home",
    filter: {
      apps: words("app"),
      notApps: words("not"),
      unknown: unknown === "include" || unknown === "exclude" ? unknown : null,
      replies: q.get("replies") === "1",
    },
  };
}

function decodeSafely(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function homeHash(filter) {
  const q = new URLSearchParams();
  if (filter.apps.length) q.set("app", filter.apps.join(","));
  if (filter.notApps.length) q.set("not", filter.notApps.join(","));
  if (filter.unknown) q.set("unknown", filter.unknown);
  if (filter.replies) q.set("replies", "1");
  const query = q.toString().replaceAll("%2C", ",");
  return query ? `#/?${query}` : "#/";
}

function go(filter) {
  location.hash = homeHash(filter);
}

function route() {
  const where = readHash();
  $("home").hidden = where.view !== "home";
  $("profile").hidden = where.view !== "profile";
  updateCompose();
  if (where.view === "home") {
    state.limit = PAGE;
    loadHome(where.filter, false);
  } else {
    loadProfile(where.user);
  }
}

// The compose box sits under the heading of the open view: always on the feed, and on a
// profile only while replying to one of its casts.
function updateCompose() {
  const compose = $("compose");
  const view = currentView();
  const head = view === "home" ? $("home-head") : $("profile-head");
  if (head.nextElementSibling !== compose) head.after(compose);
  compose.hidden = !state.session.canWrite || (view !== "home" && state.replyTo === null);
}

function setReply(reply) {
  state.replyTo = reply;
  $("reply").hidden = reply === null;
  $("reply-to").textContent = reply ? `Replying to ${reply.name}` : "";
  updateCompose();
  if (reply) {
    const bar = document.querySelector(".top").offsetHeight;
    window.scrollTo({ top: $("compose").getBoundingClientRect().top + window.scrollY - bar - 16, behavior: "smooth" });
    $("text").focus({ preventScroll: true });
  }
}

const encoder = new TextEncoder();

function updateCount() {
  const text = $("text").value.trim();
  const bytes = encoder.encode(text).length;
  const count = $("count");
  count.classList.toggle("is-long", bytes > CAST_BYTES && bytes <= LONG_CAST_BYTES);
  count.classList.toggle("is-over", bytes > LONG_CAST_BYTES);
  if (bytes <= CAST_BYTES) count.textContent = `${bytes} / ${CAST_BYTES}`;
  else if (bytes <= LONG_CAST_BYTES) count.textContent = `long cast · ${bytes} / ${LONG_CAST_BYTES}`;
  else count.textContent = `too long · ${bytes} / ${LONG_CAST_BYTES}`;
  $("post").disabled = state.posting || text === "" || bytes > LONG_CAST_BYTES;
}

async function postCast() {
  const text = $("text").value.trim();
  if (state.posting || text === "" || encoder.encode(text).length > LONG_CAST_BYTES) return;
  const reply = state.replyTo;
  state.posting = true;
  $("post").textContent = "Posting…";
  updateCount();
  const lookup = /@[a-z0-9]/i.test(text) ? `Looking up the @names on ${nodeName()} (userNameProofByName), signing` : "Signing";
  notify("Working", `${lookup} a CAST_ADD${reply ? ` that replies to ${reply.name}` : ""} with your app key, submitting it to ${nodeName()}, and waiting until the node serves it back…`);
  try {
    const result = await call("/api/cast", { text, replyTo: reply?.ref });
    $("text").value = "";
    setReply(null);
    const mine = `#/u/${result.ref.split(":")[0]}`;
    const plain = plainNames(result);
    if (result.confirmed) {
      notify("Done", `Published ${shortRef(result.ref)}: ${nodeName()} served it back after ${(result.ms / 1000).toFixed(1)} s.`, plain, { href: mine, text: "See it on your profile" });
    } else {
      notify("Note", `${nodeName()} accepted ${shortRef(result.ref)}, but has not shown it after two minutes.`, `It may still land: messages relay through the validators. Check your profile in a minute; nothing needs undoing. ${plain}`.trim());
    }
    if (location.hash === mine) route();
  } catch (e) {
    showError(e);
  } finally {
    state.posting = false;
    $("post").textContent = "Post";
    updateCount();
  }
}

function nameList(list) {
  const at = list.map((name) => `@${name}`);
  return at.length < 2 ? (at[0] ?? "") : `${at.slice(0, -1).join(", ")} and ${at.at(-1)}`;
}

// Mentions are stored as FIDs, so a name the node does not know cannot become one.
function plainNames(result) {
  const parts = [];
  if (result.unknown?.length) parts.push(`No account is called ${nameList(result.unknown)} on ${nodeName()}, so ${result.unknown.length === 1 ? "it stays" : "they stay"} plain text.`);
  if (result.overLimit?.length) parts.push(`A cast can mention at most 10 accounts, so ${nameList(result.overLimit)} ${result.overLimit.length === 1 ? "stays" : "stay"} plain text.`);
  return parts.join(" ");
}

function futureNote(count) {
  if (!count) return "";
  return ` Left out ${count} cast${count === 1 ? "" : "s"} dated more than 10 minutes in the future. A cast's time comes from the app that signed it, so it can be wrong.`;
}

async function loadHome(filter, keepRows) {
  const load = ++state.loads;
  const s = state.session;
  const feed = $("feed");
  if (s.viewerFid === null) {
    $("home-sub").textContent = "There is no account on this laptop yet, so there is no home feed to read.";
    $("apps").hidden = true;
    feed.replaceChildren(el("p", { class: "feed__state" }, "Log in with ./threecast login, or look through someone else's eyes: ./threecast web --as 3"));
    return;
  }
  renderFilters(filter);
  $("home-sub").textContent = s.canWrite ? "Casts from the accounts you follow, newest first." : `Read-only: the casts FID ${s.viewerFid} sees.`;
  const reading = el("p", { class: "feed__state" }, `Reading the latest casts of every account ${s.canWrite ? "you follow" : `FID ${s.viewerFid} follows`} from ${nodeName()}, one castsByFid request each…`);
  if (keepRows) feed.append(reading);
  else feed.replaceChildren(reading);
  let data;
  try {
    data = await call(`/api/feed?${feedQuery(filter, state.limit)}`);
  } catch (e) {
    if (load !== state.loads) return;
    reading.textContent = "The feed could not be read.";
    if (!state.apps) $("apps").hidden = true;
    showError(e);
    return;
  }
  if (load !== state.loads) return;
  $("home-sub").textContent = homeSummary(data);
  feed.replaceChildren(...feedRows(data, filter));
  // With no follows there is nothing to filter yet.
  $("apps").hidden = data.following === 0;
  if (data.following > 0) loadApps(filter);
  loadReactions(data.posts);
}

function feedQuery(filter, limit) {
  const q = new URLSearchParams({ limit: String(limit) });
  if (filter.apps.length) q.set("app", filter.apps.join(","));
  if (filter.notApps.length) q.set("notApp", filter.notApps.join(","));
  if (filter.unknown) q.set("unknown", filter.unknown);
  if (filter.replies) q.set("replies", "1");
  return q.toString();
}

function homeSummary(data) {
  const s = state.session;
  if (data.following === 0) return s.canWrite ? "Casts from the accounts you follow appear here, newest first." : `FID ${s.viewerFid} does not follow anyone.`;
  const whose = s.canWrite ? "you follow" : `FID ${s.viewerFid} follows`;
  const scope = data.following > 300 ? `the 300 most recent of the ${data.following} accounts ${whose}` : `the ${data.following} accounts ${whose}`;
  const missing = data.unread > 0 ? ` The casts of ${data.unread} account${data.unread === 1 ? "" : "s"} could not be read this time; reload to retry.` : "";
  const summary = `${data.posts.length} of ${data.scanned} recent casts from ${scope}, newest first, read from ${nodeName()}.${missing}${futureNote(data.futureDated)}`;
  return s.canWrite ? summary : `${summary} Read-only: log in with ./threecast login to cast, like and follow.`;
}

function feedRows(data, filter) {
  const s = state.session;
  if (data.following === 0) {
    if (!s.canWrite) return [el("p", { class: "feed__state" }, `FID ${s.viewerFid} does not follow anyone yet, so there is nothing to show. Try an account that follows people: ./threecast web --as 3`)];
    return [el("p", { class: "feed__state" }, "Your feed is empty because you do not follow anyone yet."), ...followBox()];
  }
  if (data.posts.length === 0) {
    return [
      el("p", { class: "feed__state" }, `None of the ${data.scanned} recent casts matched this filter. `, el("a", { href: homeHash({ apps: [], notApps: [], unknown: null, replies: filter.replies }) }, "Show all apps")),
    ];
  }
  const rows = data.posts.map(postRow);
  if (data.posts.length >= state.limit && state.limit < MAX_LIMIT) {
    rows.push(
      el("button", {
        class: "button more",
        type: "button",
        onclick: (e) => {
          e.currentTarget.remove();
          state.limit = Math.min(MAX_LIMIT, state.limit + PAGE);
          loadHome(filter, true);
        },
      }, `Show ${PAGE} more`),
    );
  }
  return rows;
}

function followBox() {
  const input = el("input", { class: "field", type: "text", placeholder: "@dwr", "aria-label": "Account to follow", autocomplete: "off", autocapitalize: "none", spellcheck: "false" });
  const button = el("button", { class: "button", type: "submit" }, "Follow");
  const form = el("form", { class: "followbox" }, input, button);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const user = input.value.trim();
    if (user === "") {
      input.focus();
      return;
    }
    button.disabled = true;
    notify("Working", `Signing a LINK_ADD (follow) for ${user} with your app key and submitting it to ${nodeName()}…`);
    try {
      const result = await call("/api/follow", { user });
      notify(result.confirmed ? "Done" : "Note", result.confirmed ? `You now follow ${user} (FID ${result.fid}). Reading your feed again…` : `${nodeName()} accepted the follow, but does not show it yet. Reload in a minute.`);
      route();
    } catch (err) {
      showError(err);
      button.disabled = false;
    }
  });
  const names = SUGGESTED.flatMap((name, i) => [i ? ", " : "", el("a", { href: `#/u/${name}` }, `@${name}`)]);
  return [el("p", { class: "feed__state" }, "Follow someone to fill your feed: ", ...names), form];
}

function postRow(post) {
  const s = state.session;
  const author = post.author;
  const named = author.displayName && author.displayName !== author.username;
  const when = new Date(post.time);
  const row = el("article", { class: "post" });
  row.append(
    el("p", { class: "post__via", title: appDetail(post) }, `via ${appName(post)}`),
    el(
      "div",
      { class: "post__main" },
      el(
        "p",
        { class: "post__who" },
        el("a", { href: `#/u/${post.fid}` }, el("b", {}, named ? author.displayName : handle(author)), named ? ` ${handle(author)}` : ""),
        " · ",
        el("time", { datetime: when.toISOString(), title: when.toLocaleString() }, ago(post.time)),
      ),
      context(post),
      post.text ? el("p", { class: "post__text" }, linkify(post.text)) : null,
      embeds(post),
      s.canWrite ? actions(post, row) : null,
    ),
  );
  return row;
}

function context(post) {
  const parent = post.parent;
  if (!parent) return null;
  if ("fid" in parent) return el("p", { class: "post__ctx" }, "reply to a cast by ", el("a", { href: `#/u/${parent.fid}` }, `FID ${parent.fid}`));
  const channel = /\/~\/channel\/([^/?#]+)/.exec(parent.url);
  return el("p", { class: "post__ctx" }, `in ${channel ? `/${channel[1]}` : parent.url}`);
}

function embeds(post) {
  // Apps usually put a link in the text and again as an embed; show it once.
  const extra = [...new Set(post.embeds)].filter((embed) => !post.text.includes(embed));
  if (extra.length === 0) return null;
  const items = extra.map((embed) => {
    const quote = /^(\d+):0x[0-9a-f]+$/i.exec(embed);
    if (quote) return el("li", {}, `quotes ${shortRef(embed)} by `, el("a", { href: `#/u/${quote[1]}` }, `FID ${quote[1]}`));
    const url = safeUrl(embed);
    return el("li", {}, url ? el("a", { href: url, target: "_blank", rel: "noopener noreferrer" }, embed) : embed);
  });
  return el("ul", { class: "post__embeds" }, items);
}

function reactionOf(ref) {
  let entry = state.reactions.get(ref);
  if (!entry) {
    entry = { like: false, recast: false, asked: false, clicked: new Set() };
    state.reactions.set(ref, entry);
  }
  return entry;
}

// Asks your node once per cast whether you liked or recast it, for the posts just drawn. Until the
// answer arrives the buttons show as not pressed; a click in the meantime wins over the answer.
async function loadReactions(posts) {
  if (!state.session.canWrite) return;
  const refs = posts.map((p) => p.ref).filter((ref) => !reactionOf(ref).asked);
  if (refs.length === 0) return;
  for (const ref of refs) reactionOf(ref).asked = true;
  let answer = {};
  try {
    answer = await call(`/api/reactions?refs=${encodeURIComponent(refs.join(","))}`);
  } catch {
    // The buttons keep their state; the node line above reports a node that is not answering.
  }
  for (const ref of refs) {
    const entry = reactionOf(ref);
    const mine = answer[ref];
    if (!mine) {
      entry.asked = false; // asked again the next time this cast is drawn
      continue;
    }
    for (const kind of ["like", "recast"]) if (!entry.clicked.has(kind)) entry[kind] = mine[kind];
  }
  for (const button of document.querySelectorAll(".act[data-kind]")) {
    const entry = state.reactions.get(button.dataset.ref);
    if (entry) button.setAttribute("aria-pressed", String(entry[button.dataset.kind]));
  }
}

function actions(post, row) {
  const mine = reactionOf(post.ref);
  const buttons = [
    reactionButton("Like", "like", post, mine),
    reactionButton("Recast", "recast", post, mine),
    el("button", { class: "act", type: "button", onclick: () => setReply({ ref: post.ref, name: handle(post.author) }) }, "Reply"),
  ];
  if (post.fid === state.session.viewerFid) {
    buttons.push(el("button", { class: "act", type: "button", onclick: () => deleteCast(post, row) }, "Delete"));
  }
  const parts = buttons.flatMap((b, i) => (i ? [el("span", { class: "sep", "aria-hidden": "true" }, "·"), b] : [b]));
  return el("p", { class: "post__acts" }, parts);
}

const REACTION_DONE = { like: ["Liked", "Took back the like on"], recast: ["Recast", "Took back the recast of"] };

function reactionButton(label, kind, post, mine) {
  const button = el("button", { class: "act", type: "button", "aria-pressed": String(mine[kind]), "data-ref": post.ref, "data-kind": kind }, label);
  button.addEventListener("click", async () => {
    const undo = mine[kind];
    mine.clicked.add(kind);
    const set = (on) => {
      mine[kind] = on;
      button.setAttribute("aria-pressed", String(on));
    };
    set(!undo);
    button.disabled = true;
    notify("Working", `Signing a ${undo ? "REACTION_REMOVE" : "REACTION_ADD"} (${kind}) with your app key and submitting it to ${nodeName()}…`);
    try {
      const result = await call("/api/react", { kind, ref: post.ref, undo });
      const done = `${REACTION_DONE[kind][undo ? 1 : 0]} ${handle(post.author)}'s cast`;
      if (result.confirmed) notify("Done", `${done}: ${nodeName()} shows the change.`);
      else notify("Note", `${done}: ${nodeName()} accepted it, but does not show it yet.`, "It may still land. Nothing needs undoing.");
    } catch (e) {
      set(undo);
      showError(e);
    } finally {
      button.disabled = false;
    }
  });
  return button;
}

async function deleteCast(post, row) {
  if (!window.confirm("Delete this cast? Your node stops serving it, but apps that already showed it may keep a copy.")) return;
  row.hidden = true;
  notify("Working", `Signing a CAST_REMOVE for ${shortRef(post.ref)} with your app key and submitting it to ${nodeName()}…`);
  try {
    const result = await call("/api/delete", { ref: post.ref });
    if (result.confirmed) notify("Done", `Deleted ${shortRef(post.ref)}: ${nodeName()} no longer serves it.`);
    else notify("Note", `${nodeName()} accepted the delete, but still serves the cast.`, "It may still land. Reload in a minute; nothing needs redoing.");
  } catch (e) {
    row.hidden = false;
    showError(e);
  }
}

async function loadApps(filter) {
  if (state.apps?.replies === filter.replies) return;
  try {
    const answer = await call(`/api/apps${filter.replies ? "?replies=1" : ""}`);
    state.apps = { replies: filter.replies, ...answer };
  } catch (e) {
    state.apps = { replies: filter.replies, sample: 0, apps: [], error: e.message };
  }
  const where = readHash();
  if (where.view === "home") renderFilters(where.filter);
}

// One click shows only that app, a second click hides it, a third shows it again.
// Alt-click hides an app straight away.
function cycle(filter, word, alt) {
  const without = (list) => list.filter((w) => w !== word);
  if (filter.notApps.includes(word)) return { ...filter, notApps: without(filter.notApps) };
  if (alt || filter.apps.includes(word)) return { ...filter, apps: without(filter.apps), notApps: [...filter.notApps, word] };
  return { ...filter, apps: [word], notApps: without(filter.notApps) };
}

function filterButton(label, count, pressed, hidden, onclick, title) {
  return el(
    "button",
    { class: hidden ? "filter is-hidden" : "filter", type: "button", "aria-pressed": String(pressed), title, onclick },
    label,
    count === null ? null : [" ", el("b", {}, String(count))],
  );
}

function renderFilters(filter) {
  const known = state.apps?.replies === filter.replies ? state.apps : null;
  const all = filter.apps.length === 0 && filter.notApps.length === 0 && filter.unknown === null;
  const apps = [filterButton("All", null, all, false, () => go({ ...filter, apps: [], notApps: [], unknown: null }), "Every app, unknown ones included")];

  const rows = (known?.apps ?? []).filter((a) => a.word !== "unknown");
  // Words from the address that this sample does not contain still get a button, so they can be cleared.
  for (const word of [...filter.apps, ...filter.notApps]) {
    if (word !== "unknown" && !rows.some((a) => a.word === word)) rows.push({ word, label: /^\d+$/.test(word) ? `fid ${word}` : word, count: null });
  }
  for (const app of rows) {
    const only = filter.apps.includes(app.word);
    const hidden = filter.notApps.includes(app.word);
    const title = hidden ? "Hidden. Click to show it again." : only ? "Only this app. Click again to hide it instead." : "Click to see only this app. Alt-click to hide it.";
    apps.push(filterButton(app.label, app.count, only, hidden, (e) => go(cycle(filter, app.word, e.altKey)), title));
  }
  if (!known) apps.push(el("span", { class: "filters__note" }, "Counting the apps behind the latest 100 casts…"));
  else if (known.error) apps.push(el("span", { class: "filters__note" }, `The apps could not be counted: ${known.error}`));
  else apps.push(el("span", { class: "filters__note" }, `in the latest ${known.sample} casts`));

  const defaultUnknown = filter.apps.length ? "exclude" : "include";
  const unknown = filter.unknown ?? defaultUnknown;
  const unknownCount = known?.apps.find((a) => a.word === "unknown")?.count ?? null;
  const flipUnknown = () => {
    const next = unknown === "include" ? "exclude" : "include";
    go({ ...filter, unknown: next === defaultUnknown ? null : next });
  };
  const toggles = [
    filterButton(`Unknown app: ${unknown === "include" ? "shown" : "hidden"}`, unknownCount, false, false, flipUnknown, "Casts whose signing key was revoked, so their app cannot be told"),
    filterButton(`Replies: ${filter.replies ? "shown" : "hidden"}`, null, false, false, () => go({ ...filter, replies: !filter.replies }), "Replies to other casts"),
  ];
  $("filters").replaceChildren(el("div", { class: "filters" }, apps), el("div", { class: "filters" }, toggles));
}

async function loadProfile(user) {
  const load = ++state.loads;
  const head = $("profile-head");
  const casts = $("profile-casts");
  head.replaceChildren(el("p", { class: "kicker head__kicker" }, "Profile"), el("h1", { class: "head__title" }, user));
  casts.replaceChildren(el("p", { class: "feed__state" }, `Reading ${user}'s profile (userDataByFid) and latest casts (castsByFid) from ${nodeName()}…`));
  const who = encodeURIComponent(user);
  let profile;
  let list;
  try {
    [profile, list] = await Promise.all([call(`/api/profile?user=${who}`), call(`/api/user-casts?user=${who}`)]);
  } catch (e) {
    if (load !== state.loads) return;
    casts.replaceChildren(el("p", { class: "feed__state" }, "This profile could not be read. ", el("a", { href: "#/" }, "Back to the feed")));
    showError(e);
    return;
  }
  if (load !== state.loads) return;
  head.replaceChildren(...profileHead(profile).filter(Boolean));
  const rows = list.posts.length ? list.posts.map(postRow) : [el("p", { class: "feed__state" }, "No casts to show yet (replies are not listed here).")];
  const future = futureNote(list.futureDated).trim();
  if (future) rows.push(el("p", { class: "feed__state" }, future));
  casts.replaceChildren(...rows);
  loadReactions(list.posts);
}

function dataRow(label, value) {
  const b = el("b", {}, value);
  return { row: el("div", { class: "row" }, el("span", {}, label), b), value: b };
}

function profileHead(p) {
  const s = state.session;
  const a = p.author;
  const named = a.displayName && a.displayName !== a.username;
  const self = a.fid === s.viewerFid;
  const following = dataRow("Follows", `${p.following} accounts`);
  const followed = p.followedByViewer === null ? null : dataRow(s.canWrite ? "Followed by you" : `Followed by FID ${s.viewerFid}`, p.followedByViewer ? "yes" : "no");
  return [
    el("p", { class: "kicker head__kicker" }, `Profile · FID ${a.fid}${self ? " · you" : ""}`),
    el("h1", { class: "head__title" }, named ? a.displayName : handle(a)),
    named && a.username ? el("p", { class: "head__handle" }, `@${a.username}`) : null,
    p.bio ? el("p", { class: "head__sub" }, linkify(p.bio)) : null,
    el("div", { class: "rows rows--hard head__rows" }, following.row, followed?.row),
    s.canWrite && p.followedByViewer !== null ? followButton(p, followed.value) : null,
  ];
}

function followButton(p, shown) {
  let on = p.followedByViewer;
  const name = handle(p.author);
  const button = el("button", { class: "button", type: "button" }, on ? "Unfollow" : "Follow");
  const set = (value) => {
    on = value;
    button.textContent = on ? "Unfollow" : "Follow";
    shown.textContent = on ? "yes" : "no";
  };
  button.addEventListener("click", async () => {
    const undo = on;
    set(!undo);
    button.disabled = true;
    notify("Working", `Signing a ${undo ? "LINK_REMOVE (unfollow)" : "LINK_ADD (follow)"} for ${name} with your app key and submitting it to ${nodeName()}…`);
    try {
      const result = await call("/api/follow", { user: String(p.author.fid), undo });
      const done = undo ? `You no longer follow ${name}` : `You now follow ${name}`;
      if (result.confirmed) notify("Done", `${done}. Their casts ${undo ? "leave" : "join"} your home feed.`, "", { href: "#/", text: "Back to your feed" });
      else notify("Note", `${done}: ${nodeName()} accepted it, but does not show it yet.`, "It may still land. Nothing needs undoing.");
    } catch (e) {
      set(undo);
      showError(e);
    } finally {
      button.disabled = false;
    }
  });
  return el("div", { class: "head__actions" }, button);
}

async function start() {
  $("notice-close").addEventListener("click", () => {
    $("notice").hidden = true;
  });
  $("text").addEventListener("input", updateCount);
  $("text").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      postCast();
    }
  });
  $("post").addEventListener("click", postCast);
  $("reply-cancel").addEventListener("click", () => setReply(null));
  try {
    state.session = await call("/api/session");
  } catch (e) {
    showError(e);
    return;
  }
  renderViewer();
  refreshNode();
  setInterval(refreshNode, NODE_EVERY_MS);
  window.addEventListener("hashchange", route);
  route();
}

start();
