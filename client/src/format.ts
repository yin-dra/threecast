// threecast — MIT License
// Small text helpers shared by the CLI's output.

import type { Author } from "./api.ts";

/** Shortens 0x-hex for display: 0x4f81…0998. */
export function short(hex: string): string {
  return hex.length > 14 ? `${hex.slice(0, 6)}…${hex.slice(-4)}` : hex;
}

/** "2:0x4f81…0998" from "2:0x4f8122235ed0a713b94f407cfdde8b55b35f0998". */
export function shortRef(ref: string): string {
  const [fid, hash] = ref.split(":");
  return `${fid}:${short(hash ?? "")}`;
}

/** "Dan Romero @dwr", or "@dwr", or "FID 3" when the account has no name. */
export function displayName(author: Author): string {
  const handle = author.username ? `@${author.username}` : `FID ${author.fid}`;
  return author.displayName && author.displayName !== author.username ? `${author.displayName} ${handle}` : handle;
}

export function ago(time: number, now = Date.now()): string {
  // Messages may be up to 10 minutes ahead of the clock; beyond that the timestamp is simply false
  // (a few casts on mainnet claim to come from 2061), so show it rather than "just now".
  if (time - now > 600_000) return `dated ${new Date(time).toISOString().slice(0, 10)}`;
  const s = Math.max(0, Math.round((now - time) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 30 * 86_400) return `${Math.floor(s / 86_400)}d ago`;
  return new Date(time).toISOString().slice(0, 10);
}

const STYLE = /\x1b\[[0-9;]*m/g;

/**
 * Breaks a line at spaces so it fits `width` visible columns (0 means never). Continuation lines
 * line up after the line's own indentation and leading mark ("→ ", "✓ ", "! ", "✗ "), or at
 * `indent` when given. Terminal styling codes do not count toward the width.
 */
export function wrap(text: string, width: number, indent?: number): string {
  return text
    .split("\n")
    .map((line) => wrapLine(line, width, indent))
    .join("\n");
}

function wrapLine(line: string, width: number, indent?: number): string {
  const visible = (s: string) => s.replace(STYLE, "").length;
  if (width <= 0 || visible(line) <= width) return line;
  const lead = /^\s*(?:[→✓!✗] )?/.exec(line.replace(STYLE, ""))?.[0].length ?? 0;
  const pad = " ".repeat(Math.min(indent ?? lead, Math.floor(width / 2)));
  const lines: string[] = [];
  const [first = "", ...words] = line.split(" ");
  let current = first;
  let hasWord = first.replace(STYLE, "") !== "";
  for (const word of words) {
    if (hasWord && word !== "" && visible(`${current} ${word}`) > width) {
      lines.push(current);
      current = pad + word;
    } else if (!(current === pad && word === "")) {
      current += ` ${word}`;
    }
    if (word.replace(STYLE, "") !== "") hasWord = true;
  }
  lines.push(current);
  return lines.join("\n");
}

export function duration(seconds: number): string {
  if (seconds < 120) return `${seconds} s`;
  if (seconds < 7200) return `${Math.round(seconds / 60)} min`;
  return `${Math.round(seconds / 3600)} h`;
}
