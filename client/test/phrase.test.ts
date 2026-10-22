// threecast — MIT License
// Recovery phrase handling. Every phrase here is generated on the spot and controls nothing.

import assert from "node:assert/strict";
import { test } from "node:test";
import { validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { generateMnemonic, english, mnemonicToAccount } from "viem/accounts";
import { checkPhrase, normalizePhrase } from "../src/account.ts";
import { TcError } from "../src/errors.ts";

const phrase = generateMnemonic(english);
const words = phrase.split(" ");

/** The same phrase with its last word swapped for one that breaks the checksum. */
function badChecksum(): string {
  for (const candidate of wordlist) {
    const swapped = [...words.slice(0, -1), candidate].join(" ");
    if (!validateMnemonic(swapped, wordlist)) return swapped;
  }
  throw new Error("unreachable");
}

test("normalizes case and whitespace the way it was typed or pasted", () => {
  const messy = `  ${words.map((w, i) => (i % 2 ? w.toUpperCase() : w)).join(" \t\n ")}  `;
  assert.equal(normalizePhrase(messy), phrase);
  assert.doesNotThrow(() => checkPhrase(normalizePhrase(messy)));
});

test("rejects a bad checksum that viem would silently accept", () => {
  const wrong = badChecksum();
  // The trap: viem derives an address from it anyway, an empty account nobody controls on purpose.
  const derived = mnemonicToAccount(wrong).address;
  assert.match(derived, /^0x[0-9a-fA-F]{40}$/);
  assert.notEqual(derived, mnemonicToAccount(phrase).address);
  assert.throws(() => checkPhrase(wrong), (e: unknown) => e instanceof TcError && /checksum/.test(e.message));
});

test("uppercase derives a different key in viem, which is why phrases are lowercased first", () => {
  assert.notEqual(mnemonicToAccount(phrase.toUpperCase()).address, mnemonicToAccount(phrase).address);
});

test("names unknown words by position without echoing them", () => {
  const typo = [...words];
  typo[4] = "notaword";
  const error = (() => {
    try {
      checkPhrase(typo.join(" "));
    } catch (e) {
      return e;
    }
  })();
  assert.ok(error instanceof TcError);
  assert.match(error.message, /Word 5 is not in the BIP-39 English word list/);
  assert.doesNotMatch(`${error.message} ${error.hint}`, /notaword/);
  for (const word of words) assert.ok(!error.message.includes(` ${word} `));
});

test("counts words", () => {
  assert.throws(() => checkPhrase(words.slice(0, 11).join(" ")), /That was 11 words/);
  assert.throws(() => checkPhrase(""), /That was 0 words/);
});

test("derives m/44'/60'/0'/0/N, the Farcaster app's path at N = 0", () => {
  // Hardhat's published test phrase: a known vector, and for the same reason never an account to use.
  const vector = "test test test test test test test test test test test junk";
  assert.doesNotThrow(() => checkPhrase(vector));
  assert.equal(mnemonicToAccount(vector).address, "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
  assert.equal(mnemonicToAccount(vector, { addressIndex: 1 }).address, "0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
});
