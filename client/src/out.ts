// threecast — MIT License
// Terminal output in the same voice as lib/common.sh, plus prompts that never echo secrets.

import { createInterface } from "node:readline/promises";
import { TcError } from "./errors.ts";
import { wrap } from "./format.ts";

const styled = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

/** Where narration goes. Tests swap these out, because the test runner reports over stdout. */
export const sink: { out: NodeJS.WritableStream; err: NodeJS.WritableStream } = { out: process.stdout, err: process.stderr };

export const bold = (s: string): string => (styled ? `\x1b[1m${s}\x1b[0m` : s);
export const dim = (s: string): string => (styled ? `\x1b[2m${s}\x1b[0m` : s);

/** How wide to wrap narration: the terminal's width, capped for readability. Pipes and files get whole lines. */
export function columns(stream: NodeJS.WritableStream = sink.out): number {
  const tty = stream as NodeJS.WriteStream;
  return tty.isTTY && tty.columns ? Math.min(tty.columns, 100) : 0;
}

/** One line of narration, wrapped to the terminal. `indent` sets where continuation lines start. */
export function say(line = "", indent?: number): void {
  sink.out.write(`${wrap(line, columns(), indent)}\n`);
}

/** Output a program may parse (JSON): written as is, never wrapped. */
export function print(text: string): void {
  sink.out.write(`${text}\n`);
}

export function step(line: string): void {
  say(bold(`→ ${line}`));
}

export function ok(line: string): void {
  say(`✓ ${line}`);
}

export function hint(line: string): void {
  say(dim(`  ${line}`));
}

export function warn(line: string): void {
  sink.err.write(`${wrap(`! ${line}`, columns(sink.err))}\n`);
}

export function fail(message: string, next?: string): void {
  sink.err.write(`${wrap(`✗ ${message}`, columns(sink.err))}\n`);
  if (next) sink.err.write(`${wrap(`  ${next}`, columns(sink.err))}\n`);
}

/** Reads one line from the terminal without echoing it. Ctrl-C cancels. */
export function readHidden(prompt: string): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY) {
    return Promise.reject(new TcError("There is no terminal to type the phrase into.", "Run this in a terminal, or pass --phrase-file PATH."));
  }
  process.stderr.write(prompt);
  input.setRawMode(true);
  input.setEncoding("utf8");
  input.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (error?: Error) => {
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
      process.stderr.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      const chars = [...chunk];
      for (let i = 0; i < chars.length; i++) {
        const ch = chars[i] as string;
        const enter = ch === "\r" || ch === "\n";
        // A pasted phrase arrives in one chunk and may have a line per word. Only a line break
        // with nothing but line breaks after it is the Enter key; the others separate words.
        if (enter && !/^[\r\n]*$/.test(chars.slice(i + 1).join(""))) value += " ";
        else if (enter || ch === "\u0004") return finish();
        else if (ch === "\u0003") return finish(new TcError("Cancelled. Nothing was signed or sent."));
        else if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else if (ch === "\t") value += " ";
        else if (ch >= " ") value += ch;
      }
    };
    input.on("data", onData);
  });
}

/** Asks a yes/no question; anything but y/yes is no. Ctrl-C throws a TcError. */
export async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    throw new TcError(`There is no terminal to answer "${question}" on.`, "Run this command in a terminal.");
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^(y|yes)$/i.test(answer.trim());
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") throw new TcError("Cancelled at the prompt.");
    throw e;
  } finally {
    rl.close();
  }
}
