#!/usr/bin/env node
// threecast — MIT License
// Builds site/index.html from site/content.md, with no dependencies:
//
//   node site/build.mjs
//
// It reads the Markdown subset content.md uses: YAML front matter, # to ### headings, paragraphs,
// "-" and "1." lists with one level of nesting, | tables |, ```sh, ```text and ```prompt fences,
// **bold**, *italic*, `code`, [links](url), "Term" + ": definition" lists, and inline [UNVERIFIED: …]
// and [PLACEHOLDER: …] notes. Page furniture (hero, index, diagrams, asides, accordions) is added
// here, keyed by heading or paragraph text. When a key no longer matches, the build says so.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = "https://github.com/yin-dra/threecast";
const warnings = [];

// ---------------------------------------------------------------- text

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const pad2 = (n) => String(n).padStart(2, "0");
const plain = (md) => md.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[`*]/g, "");

const usedSlugs = new Map();
/** GitHub's heading slug, so links written for the README style keep working here. */
function slug(md) {
  const s = plain(md).toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
  const n = usedSlugs.get(s) ?? 0;
  usedSlugs.set(s, n + 1);
  return n ? `${s}-${n}` : s;
}

function note(kind, text) {
  const label = kind === "UNVERIFIED" ? "Unverified:" : "To be filled in:";
  return `<!-- ${kind} --><span class="unv" data-${kind.toLowerCase()}><span class="unv__k">${label}</span> ${text}</span>`;
}

function inline(md) {
  const codes = [];
  let s = md.replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = esc(s);
  s = s.replace(/\[(UNVERIFIED|PLACEHOLDER): ([^\]]+)\]/g, (_, kind, text) => note(kind, text));
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, href) => `<a href="${href}">${text}</a>`);
  s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[\s(])\*(?=\S)(.+?)\*(?=$|[\s.,;:)])/g, "$1<em>$2</em>");
  // Dates never break at their hyphens ("2026-10-" / "21"). Tags, and so link targets, are skipped.
  s = s.replace(/(<[^>]*>)|(\d{4}-\d{2}-\d{2})/g, (m, tag, d) => tag ?? `<span class="nw">${d}</span>`);
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codeWords(codes[Number(i)])}</code>`);
}

// Inline code breaks only at its spaces, so "--phrase-file" never wraps as "--phrase-" / "file".
// Tokens longer than a phone's column stay breakable anywhere.
function codeWords(c) {
  return c.split(/( +)/).map((p) => (!p || / /.test(p) || p.length > 34 ? esc(p) : `<span class="nw">${esc(p)}</span>`)).join("");
}

// ---------------------------------------------------------------- blocks

const LIST = /^(\s*)([-*]|\d+\.)\s+(.*)$/;

function parseBlocks(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    let m;
    if ((m = line.match(/^```(\w*)\s*$/))) {
      const body = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++;
      out.push({ t: "code", lang: m[1] || "text", body });
      continue;
    }
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) { out.push({ t: "h", level: m[1].length, text: m[2].trim() }); i++; continue; }
    if (/^---\s*$/.test(line)) { out.push({ t: "hr" }); i++; continue; }
    if (line.startsWith("|")) {
      const rows = [];
      while (i < lines.length && lines[i].startsWith("|")) rows.push(lines[i++]);
      out.push(parseTable(rows));
      continue;
    }
    if (LIST.test(line)) {
      const items = [];
      while (i < lines.length && LIST.test(lines[i])) items.push(lines[i++]);
      out.push(parseList(items));
      continue;
    }
    if (i + 1 < lines.length && /^:\s+/.test(lines[i + 1])) {
      const items = [];
      while (i + 1 < lines.length && lines[i].trim() && /^:\s+/.test(lines[i + 1])) {
        items.push({ term: lines[i].trim(), def: lines[i + 1].replace(/^:\s+/, "") });
        i += 2;
        while (i < lines.length && !lines[i].trim()) i++;
      }
      out.push({ t: "dl", items });
      continue;
    }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^(```|#{1,4}\s|---\s*$|\|)/.test(lines[i]) && !LIST.test(lines[i])) buf.push(lines[i++].trim());
    out.push({ t: "p", text: buf.join(" ") });
  }
  return out;
}

function parseTable(rows) {
  const cells = (r) => r.replace(/^\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
  return { t: "table", head: cells(rows[0]), rows: rows.slice(2).map(cells) };
}

function parseList(lines) {
  const list = { t: "list", ordered: /^\d+\./.test(lines[0].trim()), start: parseInt(lines[0].trim(), 10) || 1, items: [] };
  for (const l of lines) {
    const [, indent, marker, text] = l.match(LIST);
    if (indent.length < 2 || list.items.length === 0) { list.items.push({ text, children: null }); continue; }
    const last = list.items[list.items.length - 1];
    last.children ??= { ordered: /^\d+\./.test(marker), items: [] };
    last.children.items.push({ text, children: null });
  }
  return list;
}

// ---------------------------------------------------------------- rendering

const isCaption = (text) => /^\*[^*][\s\S]*\*$/.test(text);
const isNote = (text) => /^\[(UNVERIFIED|PLACEHOLDER): [^\]]+\]$/.test(text);

function shLine(line) {
  const m = line.match(/^(.*?\S)(\s+#\s.*)$/);
  if (m) return `${esc(m[1])}<span class="c">${esc(m[2])}</span>`;
  if (/^\s*#/.test(line)) return `<span class="c">${esc(line)}</span>`;
  return esc(line);
}

function renderCode(tok, captionMd) {
  let block;
  if (tok.lang === "sh" && tok.body.length > 1) {
    // One line at a time: pasted together, a second line can be read as the answer to the first one's question.
    const rows = tok.body.map((l) => {
      const cmd = l.replace(/\s+#\s.*$/, "");
      return `<div class="cmd"><code class="cmd__c">${shLine(l)}</code><button class="copy" type="button" data-copy="${esc(cmd)}" aria-label="Copy ${esc(cmd)}" hidden>Copy</button></div>`;
    });
    block = `<div class="code code--sh code--lines"><div class="code__bar"><span class="code__k">Shell</span><span class="code__note">One line at a time</span></div>${rows.join("")}</div>`;
  } else if (tok.lang === "sh") {
    block = `<div class="code code--sh"><div class="code__bar"><span class="code__k">Shell</span><button class="copy" type="button" aria-label="Copy ${tok.body.length > 1 ? "these commands" : "this command"}" hidden>Copy</button></div><pre><code>${tok.body.map(shLine).join("\n")}</code></pre></div>`;
  } else if (tok.lang === "prompt") {
    // Text to paste to an agent: copyable like a command, and wrapped, since it is one long line.
    block = `<div class="code code--sh code--wrap"><div class="code__bar"><span class="code__k">Prompt</span><button class="copy" type="button" aria-label="Copy the prompt" hidden>Copy</button></div><pre><code>${esc(tok.body.join("\n"))}</code></pre></div>`;
  } else {
    // Output wraps on narrow screens instead of running off the edge, unless two or more of its
    // lines line up in columns (a table, a menu), which wrapping would scramble.
    const wrap = tok.body.filter((l) => /\S {2,}\S/.test(l)).length < 2;
    block = `<div class="code code--out${wrap ? " code--wrap" : ""}"><pre><code>${esc(tok.body.join("\n"))}</code></pre></div>`;
  }
  if (!captionMd) return block;
  return `<figure class="sample"><figcaption class="cap">${inline(captionMd.slice(1, -1))}</figcaption>${block}</figure>`;
}

function renderList(list) {
  const tag = list.ordered ? "ol" : "ul";
  const start = list.ordered && list.start > 1 ? ` start="${list.start}"` : "";
  const items = list.items.map((it) => `<li>${inline(it.text)}${it.children ? renderList(it.children) : ""}</li>`);
  return `<${tag}${start}>${items.join("")}</${tag}>`;
}

function renderTable(tok) {
  const numeric = tok.head.map((_, c) => {
    const vals = tok.rows.map((r) => r[c] ?? "").filter(Boolean);
    return c > 0 && vals.length > 0 && vals.every((v) => v.length <= 24) && vals.filter((v) => /^(\*\*)?(≈ ?|~)?[$€]?\d/.test(v)).length * 2 >= vals.length;
  });
  const th = tok.head.map((h, c) => `<th scope="col"${numeric[c] ? ' class="num"' : ""}>${inline(h)}</th>`).join("");
  const rows = tok.rows.map((r) => {
    const tds = tok.head.map((h, c) => {
      const v = r[c] ?? "";
      const cls = [numeric[c] ? "num" : "", v ? "" : "empty"].filter(Boolean).join(" ");
      return `<td data-label="${esc(plain(h))}"${cls ? ` class="${cls}"` : ""}>${inline(v)}</td>`;
    });
    return `<tr>${tds.join("")}</tr>`;
  });
  return `<div class="tbl"><table><thead><tr>${th}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
}

function renderDl(tok) {
  const items = tok.items.map((d) => `<div id="g-${slug(d.term)}"><dt>${inline(d.term)}</dt><dd>${inline(d.def)}</dd></div>`);
  return `<dl class="defs">${items.join("")}</dl>`;
}

function renderBlock(tok) {
  switch (tok.t) {
    case "p": return isNote(tok.text) ? `<p class="note">${inline(tok.text)}</p>` : `<p>${inline(tok.text)}</p>`;
    case "h": return `<h${tok.level} id="${slug(tok.text)}">${inline(tok.text)}</h${tok.level}>`;
    case "code": return renderCode(tok);
    case "list": return renderList(tok);
    case "table": return renderTable(tok);
    case "dl": return renderDl(tok);
    case "hr": return "";
    default: throw new Error(`unknown block ${tok.t}`);
  }
}

function accordion({ id, n, title, body, level, kind }) {
  return `<div class="acc acc--${kind}" id="${id}">` +
    `<h${level} class="acc__h"><span class="acc__head"><span class="acc__n">${n}</span><span class="acc__t">${title}</span><span class="acc__sign" aria-hidden="true">–</span></span></h${level}>` +
    `<div class="acc__body" id="${id}-p"><div class="acc__in">${body}</div></div></div>`;
}

/** Renders a run of blocks; a whole-italic paragraph right above a code block becomes its caption. */
function renderRun(tokens, hooks = []) {
  let html = "";
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.t === "p" && isCaption(t.text) && tokens[i + 1]?.t === "code") { html += renderCode(tokens[++i], t.text); continue; }
    if (t.t === "aside") { html += t.html(); continue; }
    html += renderBlock(t);
    if (t.t === "p") for (const h of hooks) if (!h.done && t.text.startsWith(h.after)) { html += h.html(); h.done = true; }
  }
  return html;
}

// ---------------------------------------------------------------- diagrams

const FIG_KEYS = () => `
<figure class="fig" data-reveal>
<div class="fig__k" aria-hidden="true">Figure 1 · From phrase to cast</div>
<svg viewBox="0 0 360 446" role="img" aria-labelledby="fig-keys-t" aria-describedby="fig-keys-d">
<title id="fig-keys-t">From recovery phrase to a cast: each key and record, and where it lives</title>
<desc id="fig-keys-d">Recovery phrase: your phone, and laptop memory during login only. It derives the custody key and address: laptop memory during login, then forgotten. The custody address owns the FID, recorded in the IdRegistry contract on OP Mainnet. The custody key signs a KEY_ADD, a gasless Snapchain message kept on shard 0. The KEY_ADD authorizes the app key, an Ed25519 key kept on the laptop disk in ~/.threecast/accounts/&lt;fid&gt;.json with mode 600. The app key signs casts, likes, recasts and follows, kept on Snapchain shards 1 and 2.</desc>
<defs><marker id="ah-keys" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M1 1L9 5L1 9" class="d-line"/></marker></defs>
<text class="d-k" x="16" y="12">KEY OR RECORD</text>
<text class="d-k" x="344" y="12" text-anchor="end">WHERE IT LIVES</text>
<line class="d-rule" x1="16" y1="20" x2="344" y2="20"/>

<text class="d-b" x="16" y="44">Recovery phrase</text>
<text class="d-s" x="16" y="58">12 words</text>
<text class="d-t" x="344" y="44" text-anchor="end">your phone, in the Farcaster app</text>
<text class="d-s" x="344" y="58" text-anchor="end">laptop memory, during login only</text>
<line class="d-line" x1="22" y1="66" x2="22" y2="104" marker-end="url(#ah-keys)"/>
<text class="d-t" x="34" y="82">derives</text>
<text class="d-s" x="34" y="95">path m/44'/60'/0'/0/0</text>

<text class="d-b" x="16" y="120">Custody key</text>
<text class="d-s" x="16" y="134">and its address, 0x…</text>
<text class="d-t" x="344" y="120" text-anchor="end">laptop memory, during login,</text>
<text class="d-s" x="344" y="134" text-anchor="end">then forgotten</text>
<line class="d-line" x1="22" y1="142" x2="22" y2="180" marker-end="url(#ah-keys)"/>
<text class="d-t" x="34" y="158">owns</text>
<text class="d-s" x="34" y="171">one FID per address</text>

<text class="d-b" x="16" y="196">FID</text>
<text class="d-s" x="16" y="210">the account's number</text>
<text class="d-t" x="344" y="196" text-anchor="end">IdRegistry contract,</text>
<text class="d-s" x="344" y="210" text-anchor="end">OP Mainnet</text>
<line class="d-line" x1="22" y1="218" x2="22" y2="256" marker-end="url(#ah-keys)"/>
<text class="d-t" x="34" y="234">its custody key signs</text>
<text class="d-s" x="34" y="247">two EIP-712 statements</text>

<text class="d-b" x="16" y="272">KEY_ADD</text>
<text class="d-s" x="16" y="286">a Snapchain message, no gas</text>
<text class="d-t" x="344" y="272" text-anchor="end">Snapchain, shard 0</text>
<line class="d-line" x1="22" y1="294" x2="22" y2="332" marker-end="url(#ah-keys)"/>
<text class="d-t" x="34" y="310">authorizes</text>
<text class="d-s" x="34" y="323">casts, reactions, follows</text>

<text class="d-b" x="16" y="348">App key</text>
<text class="d-s" x="16" y="362">Ed25519</text>
<text class="d-t" x="344" y="348" text-anchor="end">laptop disk, mode 600</text>
<text class="d-mono" x="344" y="362" text-anchor="end">~/.threecast/accounts/&lt;fid&gt;.json</text>
<line class="d-line" x1="22" y1="370" x2="22" y2="408" marker-end="url(#ah-keys)"/>
<text class="d-t" x="34" y="392">signs, on this laptop</text>

<text class="d-b" x="16" y="424">Casts, likes, follows</text>
<text class="d-s" x="16" y="438">recasts, deletes, undos</text>
<text class="d-t" x="344" y="424" text-anchor="end">Snapchain, shards 1 and 2</text>
</svg>
<figcaption>Whoever holds one of these keys controls every row below it.</figcaption>
</figure>`;

const FIG_CAST = () => `
<figure class="fig" data-reveal>
<div class="fig__k" aria-hidden="true">Figure 2 · The path of a cast</div>
<svg viewBox="-6 0 372 470" role="img" aria-labelledby="fig-cast-t" aria-describedby="fig-cast-d">
<title id="fig-cast-t">The path of a cast, from your laptop to the network and back</title>
<desc id="fig-cast-d">1: your laptop builds the cast and signs it with the app key. 2: it sends it to your read node with submitMessage, through the SSH tunnel. 3: the node checks it against its own state and answers 200, accepted for relay. 4: the node passes it to the validators over gossip on 3382/udp. 5: a validator puts it in a block. 6: your node fetches that block and merges the cast. 7: the client asks your node for the cast with castById every 2 seconds, and calls it published when the node returns it.</desc>
<defs><marker id="ah-cast" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M1 1L9 5L1 9" class="d-line"/></marker></defs>
<text class="d-k" x="16" y="12">YOURS</text>
<line class="d-rule" x1="16" y1="20" x2="236" y2="20"/>
<text class="d-k" x="264" y="12">THE NETWORK</text>
<line class="d-rule" x1="264" y1="20" x2="344" y2="20"/>

<text class="d-k" x="52" y="40" text-anchor="middle">YOUR LAPTOP</text>
<text class="d-s" x="52" y="54" text-anchor="middle">client + app key</text>
<text class="d-k" x="180" y="40" text-anchor="middle">YOUR READ NODE</text>
<text class="d-s" x="180" y="54" text-anchor="middle">on your server</text>
<text class="d-k" x="308" y="40" text-anchor="middle">VALIDATORS</text>
<text class="d-s" x="308" y="54" text-anchor="middle">vote on blocks</text>
<line class="d-life" x1="52" y1="64" x2="52" y2="462"/>
<line class="d-life" x1="180" y1="64" x2="180" y2="462"/>
<line class="d-life" x1="308" y1="64" x2="308" y2="462"/>

<rect class="d-dot" x="48" y="82" width="8" height="8"/>
<text class="d-t" x="64" y="86"><tspan class="d-n">1</tspan> builds, signs</text>
<text class="d-s" x="64" y="99">with the app key</text>

<line class="d-line" x1="52" y1="136" x2="179" y2="136" marker-end="url(#ah-cast)"/>
<text class="d-t" x="116" y="129" text-anchor="middle"><tspan class="d-n">2</tspan> submitMessage</text>
<text class="d-s" x="116" y="149" text-anchor="middle">through the SSH tunnel</text>

<rect class="d-dot" x="176" y="178" width="8" height="8"/>
<text class="d-t" x="192" y="182"><tspan class="d-n">3</tspan> checks it against</text>
<text class="d-s" x="192" y="195">its own state</text>
<line class="d-line d-ret" x1="180" y1="228" x2="53" y2="228" marker-end="url(#ah-cast)"/>
<text class="d-t" x="116" y="221" text-anchor="middle">200: accepted for relay</text>

<line class="d-line" x1="180" y1="276" x2="307" y2="276" marker-end="url(#ah-cast)"/>
<text class="d-t" x="244" y="269" text-anchor="middle"><tspan class="d-n">4</tspan> gossip, 3382/udp</text>
<text class="d-s" x="244" y="289" text-anchor="middle">to the validators</text>

<rect class="d-dot" x="304" y="318" width="8" height="8"/>
<text class="d-t" x="296" y="322" text-anchor="end"><tspan class="d-n">5</tspan> a validator puts</text>
<text class="d-s" x="296" y="335" text-anchor="end">it in a block</text>

<line class="d-line" x1="308" y1="372" x2="181" y2="372" marker-end="url(#ah-cast)"/>
<text class="d-t" x="244" y="365" text-anchor="middle"><tspan class="d-n">6</tspan> your node fetches</text>
<text class="d-s" x="244" y="385" text-anchor="middle">the block, merges it</text>

<line class="d-line" x1="52" y1="420" x2="179" y2="420" marker-end="url(#ah-cast)"/>
<text class="d-t" x="116" y="413" text-anchor="middle"><tspan class="d-n">7</tspan> castById, every 2 s</text>
<line class="d-line d-ret" x1="180" y1="452" x2="53" y2="452" marker-end="url(#ah-cast)"/>
<text class="d-t" x="116" y="445" text-anchor="middle">found: published</text>
</svg>
<figcaption>Your node answers at step 3, before any validator has the cast: accepted for relay, not in a block.</figcaption>
</figure>`;

// What is in a KEY_ADD: the fields buildKeyAdd fills, from client/src/account.ts and
// @farcaster/core 0.20.0's makeKeyAddBody.
const KEYADD_ROWS = [
  ["key", "The new app key's public half, 32 bytes, Ed25519."],
  ["scopes", "<code>CAST_ADD</code>, <code>CAST_REMOVE</code>, <code>REACTION_ADD</code>, <code>REACTION_REMOVE</code>, <code>LINK_ADD</code>, <code>LINK_REMOVE</code>. No profile or key changes."],
  ["ttl", "90 days, the protocol maximum. Every merged message restarts it."],
  ["nonce", "The account's current nonce plus one, from <code>signersByFid</code>."],
  ["deadline", "One hour after signing, in Farcaster time."],
  ["custodySignature", "The custody key's EIP-712 signature over the FID and the fields above."],
  ["metadata", "The key request: who asked for the key (your own FID), signed by the custody key on the gasless domain."],
];

const ASIDE_KEYADD = () => accordion({
  id: "aside-keyadd",
  n: "Aside",
  level: 4,
  kind: "aside",
  title: "What is in a KEY_ADD",
  body:
    `<p>The fields <code>buildKeyAdd</code> fills in <a href="${REPO}/blob/HEAD/client/src/account.ts"><code>client/src/account.ts</code></a>, with <code>makeKeyAddBody</code> from <code>@farcaster/core</code> 0.20.0:</p>` +
    `<dl class="kv">${KEYADD_ROWS.map(([k, v]) => `<div><dt><code>${k}</code></dt><dd>${v}</dd></div>`).join("")}</dl>`,
});

// ---------------------------------------------------------------- hero, index

const HERO_ROWS = [
  ["From <code>./threecast node</code> to synced, on our run", "10 h 10 min"],
  ["To budget, from a day-old snapshot", "≈ 10 h"],
  ["Hetzner, cost from <code>node</code> to synced, on our run", "$2.60"],
  ["Hetzner, per day, at our $0.2553 an hour", "≈ $6.13"],
  ["DigitalOcean, per day", "≈ $7.00"],
  ["A new DigitalOcean account, up front: credit for the bill", "$250, or ask"],
  ["Your own server", "nothing extra"],
  ["A test account, if you need one", "≈ $0.20 of ETH"],
  ["Farcaster API keys", "none"],
  ["Stop paying", "<code>./threecast down</code>"],
];
const RUN_LOG = `${REPO}/blob/HEAD/docs/runs/2026-10-21-hetzner-cpx42.md`;

const SHORT = { 1: "Needs and costs", 2: "Your phrase", 3: "Up", 4: "Node", 5: "Client", 6: "While it syncs", 7: "Troubleshooting", 8: "Teardown", 9: "How it's built" };

/** The hero, the quickstart, then `after` (the sections that follow the quickstart), then the lead. */
function renderHero(tokens, after = "") {
  const h1 = tokens.find((t) => t.t === "h" && t.level === 1);
  const code = tokens.find((t) => t.t === "code");
  const list = tokens.find((t) => t.t === "list");
  const notes = tokens.filter((t) => t.t === "p" && isNote(t.text));
  const ps = tokens.filter((t) => t.t === "p" && !isNote(t.text));
  if (!h1 || !code || !list || ps.length < 3) warnings.push("The block before the first --- no longer has an H1, a code block, a list and three paragraphs.");
  // Each command's line in content.md reads "- `up` (step 0): what it does."
  const rows = code.body.map((cmd, i) => {
    const item = list?.items[i]?.text ?? "";
    const m = item.match(/^`[^`]+` \(step (\d)\):\s*(.*?)\.?$/);
    if (!m) warnings.push(`Hero list item ${i + 1} does not read "\`cmd\` (step N): what it does."`);
    const [, n = "", desc = ""] = m ?? [];
    return `<li class="qs__row"><span class="qs__n" aria-hidden="true">${n}</span><span class="qs__main"><code class="qs__c">${esc(cmd)}</code><span class="qs__d">${inline(desc.charAt(0).toUpperCase() + desc.slice(1))}</span></span><button class="copy" type="button" data-copy="${esc(cmd)}" aria-label="Copy ${esc(cmd)}" hidden>Copy</button></li>`;
  });
  const clone = `cd ~ &amp;&amp; git clone ${REPO}.git &amp;&amp; cd threecast`;
  return `
<section class="hero wrap" aria-labelledby="hero-t">
<p class="hero__kicker">threecast · MIT licensed · by @thisiscryptome</p>
<h1 class="hero__title" id="hero-t">Your own Farcaster read node and client, in three commands.</h1>
</section>

<section class="qs wrap" id="quickstart" aria-label="The three commands">
<div class="rule rule--flush"><span class="rule__label">[ Quickstart ]</span><span class="rule__line"></span></div>
<p class="qs__first">Before you sign up with a provider, read the costs below. Billing runs until <code>./threecast down</code>.</p>
<p class="qs__new">New to Terminal on a Mac? <a href="#installing-the-tools-on-a-mac">Install the tools first</a>, then come back here.</p>
<p class="qs__pre"><span class="qs__pre-k">Get the code</span> <code class="qs__c qs__c--sm">${clone}</code><button class="copy" type="button" data-copy="${clone}" aria-label="Copy the git clone command" hidden>Copy</button></p>
${notes.map((t) => `<p class="qs__note">${inline(t.text)}</p>`).join("")}
<ol class="qs__list">${rows.join("")}</ol>
<p class="qs__after">Run them one at a time: <code>up</code> asks questions, and a pasted second line would be read as the answer. You need git, Node.js 24 or newer and jq, a cloud account or your own server, and a TEST Farcaster account (<a href="#what-you-need">the full list</a>).</p>
<div class="rule rule--flush"><span class="rule__label">[ Time, cost, teardown ]</span><span class="rule__line"></span></div>
<div class="rows rows--hard">${HERO_ROWS.map(([k, v]) => `<div class="row"><span>${k}</span><b>${v}</b></div>`).join("")}</div>
<p class="qs__sum">Start <code>./threecast node</code> in the UTC evening and it should be synced by the UTC morning: the snapshot's age when the node starts sets the catch-up time (<a href="#how-long-it-takes">part 1</a>).</p>
<p class="qs__src">Times and Hetzner costs from threecast's run on 2026-10-21, a cpx42 on a new USD account (<a href="${RUN_LOG}">run log</a>). Other prices from the providers' lists that day, before VAT. <a href="#what-it-costs">Details in part 1</a>.</p>
</section>
${after}

<section class="intro wrap" aria-label="What this page does">
<p class="intro__lead" id="lead">${inline(ps[1].text)}</p>
<div class="intro__body">${ps.slice(2).map((p) => `<p>${inline(p.text)}</p>`).join("")}</div>
</section>`;
}

function renderIndex(parts, { id, cls, label }) {
  const items = parts.map((p) => `<li><a href="#${p.id}"><span class="toc__n">${p.label ?? pad2(p.n)}</span><span class="toc__t">${SHORT[p.n] ?? p.title}</span>${p.step ? `<span class="toc__s">${p.step.toLowerCase()}</span>` : ""}</a></li>`);
  return `<nav class="${cls}" id="${id}" aria-label="${label}"><p class="toc__k">[ ${label} ]</p><ol class="toc__list">${items.join("")}</ol></nav>`;
}

// ---------------------------------------------------------------- after the quickstart

// Unnumbered "## Title" groups between the hero and part 1 sit right under the quickstart, in its
// style, and lead the index. `label` and `short` are what the index shows for each.
const AFTER_QS = { "With an AI agent": { label: "AI", short: "With an agent" } };

function renderAfterQs(tokens) {
  const title = tokens[0].text;
  const known = AFTER_QS[title];
  if (!known) warnings.push(`"## ${title}" has no number and no entry in AFTER_QS, so it is shown without an index entry.`);
  const id = slug(title);
  let firstP = true;
  const body = tokens.slice(1).map((t) => {
    if (t.t === "p" && !isNote(t.text)) {
      const cls = firstP ? "qs__first" : "qs__after";
      firstP = false;
      return `<p class="${cls}">${inline(t.text)}</p>`;
    }
    if (t.t === "p") return `<p class="qs__note">${inline(t.text)}</p>`;
    if (t.t === "code") return renderCode(t);
    warnings.push(`"## ${title}" holds a ${t.t}, which the quickstart style does not lay out; it is shown plain.`);
    return renderBlock(t);
  });
  return {
    id, label: known?.label, title: known?.short ?? title, indexed: !!known,
    // The rule is the visible heading, as in the quickstart; the h2 carries it for screen readers.
    html: `
<section class="qs wrap" id="${id}" data-target="${id}" aria-labelledby="${id}-t">
<div class="rule rule--flush" aria-hidden="true"><span class="rule__label">[ ${inline(title)} ]</span><span class="rule__line"></span></div>
<h2 class="sr-only" id="${id}-t">${inline(title)}</h2>
${body.join("\n")}
</section>`,
  };
}

// ---------------------------------------------------------------- parts

function renderPart(tokens) {
  const h2 = tokens[0];
  const [, num, title] = h2.text.match(/^(\d+)\.\s+(.*)$/);
  const n = Number(num);
  const id = slug(h2.text);
  const step = (title.match(/^(Step \d):/) ?? [])[1] ?? null;
  let body = tokens.slice(1);

  // The three steps open with the state they leave you in; the other parts need no such line.
  let goal = "";
  if (body[0]?.t === "p" && body[0].text.startsWith("You end with")) goal = `<p class="part__goal">${inline(body.shift().text)}</p>`;
  else if (step) warnings.push(`Part ${n} (${step}) does not open with "You end with…".`);
  // The kicker already says "Step N", so the heading shows only what the step does.
  const shown = title.replace(/^Step \d+:\s*/, "");
  const heading = shown.charAt(0).toUpperCase() + shown.slice(1);

  const hooks = [];
  if (n === 2) hooks.push({ after: "What threecast saves is the new app key", html: FIG_KEYS });
  if (n === 5) {
    hooks.push({ after: "Since engine version 16", html: ASIDE_KEYADD });
    hooks.push({ after: "Here is what happens after", html: FIG_CAST });
  }
  if (n === 4) body = wrapAside(body, "The snapshot, and why", 1, { id: "aside-snapshot", title: "Why not the node's own loader" });
  // Optional reading starts closed: the Mac setup (linked from the quickstart, which opens it) and the firewall.
  if (n === 1) body = foldSection(body, "Installing the tools on a Mac", { id: "installing-the-tools-on-a-mac", n: "Mac" });
  if (n === 3) body = foldSection(body, "The firewall", { id: "the-firewall", n: "Detail" });

  let inner;
  if (n === 7) inner = renderTroubleshooting(body);
  else inner = renderRun(body, hooks);
  for (const h of hooks) if (!h.done) warnings.push(`Part ${n}: no paragraph starts with "${h.after}", so its insert was skipped.`);

  return {
    n, id, title, step,
    html: `
<section class="part" id="part-${n}" data-target="${id}" aria-labelledby="${id}">
<div class="rule" data-reveal><span class="rule__label">[ Part ${pad2(n)}${step ? ` · ${step}` : ""} ]</span><span class="rule__line"></span></div>
<header class="part__head wrap" data-reveal><h2 id="${id}" class="part__t">${inline(heading)}</h2>${goal}</header>
<div class="prose wrap">${inner}</div>
</section>`,
  };
}

/** Keeps the first `keep` blocks after the matching H3 in view, and folds the rest of that subsection into an aside. */
function wrapAside(body, h3Start, keep, { id, title }) {
  const at = body.findIndex((t) => t.t === "h" && t.level === 3 && t.text.startsWith(h3Start));
  if (at < 0) { warnings.push(`No H3 starts with "${h3Start}", so the aside "${title}" was skipped.`); return body; }
  let end = at + 1 + keep;
  while (end < body.length && !(body[end].t === "h" && body[end].level <= 3)) end++;
  const folded = body.slice(at + 1 + keep, end);
  const aside = { t: "aside", html: () => accordion({ id, n: "Aside", level: 4, kind: "aside", title, body: renderRun(folded) }) };
  return [...body.slice(0, at + 1 + keep), aside, ...body.slice(end)];
}

/** Folds a whole H3 subsection, heading included, into a closed panel titled with that heading. */
function foldSection(body, h3Start, { id, n }) {
  const at = body.findIndex((t) => t.t === "h" && t.level === 3 && t.text.startsWith(h3Start));
  if (at < 0) { warnings.push(`No H3 starts with "${h3Start}", so it was not folded.`); return body; }
  let end = at + 1;
  while (end < body.length && !(body[end].t === "h" && body[end].level <= 3)) end++;
  const folded = body.slice(at + 1, end);
  const title = inline(body[at].text);
  const aside = { t: "aside", html: () => accordion({ id, n, level: 3, kind: "aside", title, body: renderRun(folded) }) };
  return [...body.slice(0, at), aside, ...body.slice(end)];
}

function renderTroubleshooting(body) {
  const ENTRY = /^\*\*(\d+)\.\s+(.+)\*\*$/;
  const first = body.findIndex((t) => t.t === "p" && ENTRY.test(t.text));
  if (first < 0) { warnings.push("Part 7 has no **N. Title** entries; rendered as plain text."); return renderRun(body); }
  const entries = [];
  for (const t of body.slice(first)) {
    const m = t.t === "p" && t.text.match(ENTRY);
    if (m) entries.push({ n: Number(m[1]), title: m[2], blocks: [] });
    else entries.at(-1).blocks.push(t);
  }
  const list = entries.map((e) => accordion({
    id: `trouble-${slug(e.title)}`, n: pad2(e.n), level: 3, kind: "trouble", title: inline(e.title), body: renderRun(e.blocks),
  }));
  return `${renderRun(body.slice(0, first))}<div class="acc-tools"><button class="acc-all" type="button" aria-controls="trouble-list" hidden>Open all</button></div><div class="acc-list" id="trouble-list">${list.join("")}</div>`;
}

// ---------------------------------------------------------------- page

const raw = readFileSync(join(here, "content.md"), "utf8");
const fm = raw.match(/^---\n([\s\S]*?)\n---\n/);
const meta = Object.fromEntries((fm?.[1] ?? "").split("\n").map((l) => l.match(/^(\w+):\s*(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]));
const tokens = parseBlocks(raw.slice(fm ? fm[0].length : 0).split("\n"));

const groups = [[]];
for (const t of tokens) if (t.t === "hr") groups.push([]); else groups.at(-1).push(t);
const sections = groups.slice(1).filter((g) => g.length && g[0].t === "h" && g[0].level === 2);
const numbered = (g) => /^\d+\.\s/.test(g[0].text);
const firstPart = sections.findIndex(numbered);
for (const g of sections.slice(firstPart + 1)) if (!numbered(g)) warnings.push(`"## ${g[0].text}" has no number but comes after part 1; it is shown under the quickstart.`);
const afterQs = sections.filter((g) => !numbered(g)).map(renderAfterQs);
const parts = sections.filter(numbered).map(renderPart);
const hero = renderHero(groups[0], afterQs.map((s) => s.html).join("\n"));
const index = [...afterQs.filter((s) => s.indexed), ...parts];

const description = esc(meta.description ?? "");

// Light / dark: Auto follows the system. The choice is kept in localStorage under THEME_KEY; the
// inline script in <head> applies it before the first paint, app.js wires the buttons (hidden without it).
const THEME_KEY = "threecast-theme";
const THEME_BG = { light: "#f7f7f7", dark: "#101010" }; // --bg in style.css, both themes
const THEME_SWITCH = `<span class="theme" id="theme" role="group" aria-label="Theme" hidden>` +
  ["Auto", "Light", "Dark"].map((t) => `<button class="theme__b" type="button" data-theme-set="${t.toLowerCase()}" data-label="${t}" aria-pressed="${t === "Auto"}">${t}</button>`)
    .join(`<span class="theme__sep" aria-hidden="true">·</span>`) +
  `</span>`;
const html = `<!doctype html>
<!-- Generated from content.md by build.mjs. Edit content.md (or build.mjs for page furniture), then run: node site/build.mjs -->
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(meta.title ?? "threecast")}</title>
<meta name="description" content="${description}">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="${THEME_BG.light}" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="${THEME_BG.dark}" media="(prefers-color-scheme: dark)">
<meta property="og:title" content="threecast">
<meta property="og:description" content="${description}">
<link rel="icon" href="data:,">
<script>
// Before the stylesheet paints: mark JS, and apply a saved Light or Dark choice so the page does not flash.
// Storage can throw (private windows, blocked site data); the page then follows the system.
(function (d) {
  d.classList.add("js");
  var t = null;
  try { t = localStorage.getItem("${THEME_KEY}"); } catch (e) {}
  if (t === "light" || t === "dark") {
    d.setAttribute("data-theme", t);
    var m = document.querySelectorAll('meta[name="theme-color"]');
    for (var i = 0; i < m.length; i++) m[i].setAttribute("content", t === "dark" ? "${THEME_BG.dark}" : "${THEME_BG.light}");
    document.querySelector('meta[name="color-scheme"]').setAttribute("content", t);
  }
  setTimeout(function () { if (!window.threecastReady) d.classList.remove("js"); }, 3000);
})(document.documentElement);
</script>
<link rel="stylesheet" href="style.css">
<script src="app.js" defer></script>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="top" id="top">
<a class="top__brand" href="#main">threecast</a>
<span class="top__now" id="top-now" aria-hidden="true"></span>
<span class="top__r">${THEME_SWITCH}<a class="top__index" id="top-index" href="#contents">Index</a><a class="top__src" href="${REPO}">Source</a></span>
</header>
${renderIndex(index, { id: "toc", cls: "toc", label: "Index" })}
<main id="main" tabindex="-1">
${hero}
<div class="contents wrap">${renderIndex(index, { id: "contents", cls: "contents__nav", label: "Contents" })}</div>
${parts.map((p) => p.html).join("\n")}
</main>
<footer class="foot">
<span>threecast</span>
<span>MIT licensed</span>
<span>By @thisiscryptome</span>
<a href="${REPO}">Source</a>
<a href="${REPO}/blob/HEAD/docs/VERIFICATION.md">Verification log</a>
<a href="content.md">This page as Markdown</a>
</footer>
<p class="sr-only" id="live" aria-live="polite"></p>
</body>
</html>
`;

writeFileSync(join(here, "index.html"), html);
for (const w of warnings) console.warn(`warning: ${w}`);
console.log(`site/index.html: ${Buffer.byteLength(html)} bytes, ${parts.length} parts${warnings.length ? `, ${warnings.length} warning(s)` : ""}.`);
