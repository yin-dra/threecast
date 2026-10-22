// threecast — MIT License
// new-account against a fake OP Mainnet JSON-RPC and a fake node. Checks what would be signed and
// sent (one IdGateway.register with exactly the price), and that nothing is sent without a yes.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { ID_GATEWAY_ADDRESS, ID_REGISTRY_ADDRESS, Message, MessageType, idGatewayABI, idRegistryABI } from "@farcaster/core";
import {
  bytesToHex,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  toFunctionSelector,
  zeroAddress,
} from "viem";
import type { Hex, TransactionSerialized } from "viem";
import { Hub } from "../src/hub.ts";
import { newAccount } from "../src/register.ts";
import { currentFid } from "../src/store.ts";
import { mockNode, notFound, quietly, useTempHome } from "./helpers.ts";

useTempHome();
const FID = 3_400_001n;
const PRICE = 81_402_795_512_410n;

// The fake chain: registered once a raw transaction arrives; funded after a few balance checks.
const chain = { balanceChecks: 0, sent: [] as Hex[], registeredTo: undefined as Hex | undefined };
const uint = (n: bigint) => encodeAbiParameters([{ type: "uint256" }], [n]);
const selector = (signature: string) => toFunctionSelector(signature);

function call(params: { to: string; data: Hex }): Hex {
  const to = params.to.toLowerCase();
  const sel = params.data.slice(0, 10);
  if (to === ID_REGISTRY_ADDRESS.toLowerCase() && sel === selector("idOf(address)")) return uint(chain.registeredTo ? FID : 0n);
  if (sel === selector("price()")) return uint(PRICE);
  if (sel === selector("ethUsdPrice()")) return uint(245_691_807_930n);
  if (sel === selector("register(address)")) return encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [FID, 0n]);
  throw new Error(`unexpected eth_call ${params.to} ${sel}`);
}

function receipt(hash: Hex) {
  const to = chain.registeredTo as Hex;
  return {
    transactionHash: hash,
    transactionIndex: "0x0",
    blockHash: `0x${"11".repeat(32)}`,
    blockNumber: "0x2",
    from: to,
    to: ID_GATEWAY_ADDRESS,
    cumulativeGasUsed: "0x30d40",
    gasUsed: "0x30d40",
    effectiveGasPrice: "0xf4240",
    contractAddress: null,
    logsBloom: `0x${"00".repeat(256)}`,
    status: "0x1",
    type: "0x2",
    logs: [
      {
        address: ID_REGISTRY_ADDRESS,
        topics: encodeEventTopics({ abi: idRegistryABI, eventName: "Register", args: { to, id: FID } }),
        data: encodeAbiParameters([{ type: "address" }], [zeroAddress]),
        blockNumber: "0x2",
        blockHash: `0x${"11".repeat(32)}`,
        transactionHash: hash,
        transactionIndex: "0x0",
        logIndex: "0x0",
        removed: false,
      },
    ],
  };
}

const rpcServer = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const { id, method, params } = JSON.parse(Buffer.concat(chunks).toString()) as { id: number; method: string; params: unknown[] };
  const results: Record<string, () => unknown> = {
    eth_chainId: () => "0xa",
    eth_call: () => call(params[0] as { to: string; data: Hex }),
    eth_gasPrice: () => "0xf4240",
    eth_maxPriorityFeePerGas: () => "0x1",
    eth_getBalance: () => (++chain.balanceChecks >= 3 ? "0x5af3107a4000" : "0x0"),
    eth_getTransactionCount: () => "0x0",
    eth_estimateGas: () => "0x30d40",
    eth_blockNumber: () => "0x2",
    eth_getBlockByNumber: () => ({ number: "0x2", hash: `0x${"11".repeat(32)}`, baseFeePerGas: "0xf4240", timestamp: "0x1", gasLimit: "0x1c9c380", gasUsed: "0x0", transactions: [] }),
    eth_sendRawTransaction: () => {
      const raw = params[0] as Hex;
      chain.sent.push(raw);
      return keccak256(raw);
    },
    eth_getTransactionReceipt: () => (chain.sent.length ? receipt(params[0] as Hex) : null),
  };
  if (method === "eth_sendRawTransaction") {
    chain.registeredTo = await recoverTransactionAddress({ serializedTransaction: params[0] as TransactionSerialized });
  }
  const result = results[method];
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(result ? { jsonrpc: "2.0", id, result: result() } : { jsonrpc: "2.0", id, error: { code: -32601, message: `no ${method}` } }));
});
await new Promise<void>((resolve) => rpcServer.listen(0, "127.0.0.1", resolve));
const rpcUrl = `http://127.0.0.1:${(rpcServer.address() as AddressInfo).port}`;
after(() => new Promise<void>((resolve) => rpcServer.close(() => resolve())));

const keys = new Set<string>();
const node = await mockNode({
  "/v1/info": () => ({ json: { version: "0.14.3", shardInfos: [0, 1, 2].map((shardId) => ({ shardId, maxHeight: 1, numMessages: 2_000_000, blockDelay: 0 })) } }),
  "/v1/onChainIdRegistryEventByAddress": (req) => {
    const address = req.query.get("address")?.toLowerCase();
    if (!chain.registeredTo || address !== chain.registeredTo.toLowerCase()) return notFound("Failed to get id registry event", "no id-registry event for address");
    return { json: { type: "EVENT_TYPE_ID_REGISTER", fid: Number(FID), blockTimestamp: 1, idRegisterEventBody: { to: address, from: "0x", eventType: "Register", recoveryAddress: "0x" } } };
  },
  "/v1/fidAddressType": () => ({ json: { is_custody: true, is_auth: false, is_verified: false } }),
  "/v1/storageLimitsByFid": () => ({ json: { units: 1 } }),
  "/v1/userDataByFid": () => ({ json: { messages: [], nextPageToken: "" } }),
  "/v1/signersByFid": () => ({ json: { signers: [], gaslessSignerCount: 0, gaslessSignerLimit: 1000, currentUserNonce: 0 } }),
  "/v1/signer": (req) => (keys.has(req.query.get("signer") ?? "") ? { json: { signer: { source: "SIGNER_SOURCE_OFFCHAIN", key: req.query.get("signer"), keyType: 1, fid: Number(FID), requestFid: Number(FID) } } } : notFound("Failed to get signer", "Active signer not found")),
  "/v1/submitMessage": (req) => {
    const message = Message.decode(req.body);
    if (message.data?.type === MessageType.KEY_ADD) keys.add(bytesToHex(message.data.keyAddBody!.key));
    return { json: {} };
  },
});
after(() => node.close());

test("declining to pay sends nothing", async () => {
  const questions: string[] = [];
  const answer = async (q: string) => {
    questions.push(q);
    return !q.startsWith("Pay");
  };
  await assert.rejects(
    quietly(() => newAccount(new Hub(node.url), { rpcUrl, confirm: answer, pollMs: 5 })),
    /Stopped before paying/,
  );
  assert.equal(chain.sent.length, 0);
  assert.equal(questions.length, 2);
  assert.match(questions[1] ?? "", /^Pay 0\.00008140279551241 ETH .* IdGateway\.register \(no recovery address\) on OP Mainnet now\?$/);
});

test("pays exactly the price with one IdGateway.register, then logs in", async () => {
  chain.balanceChecks = 0;
  const account = await quietly(() => newAccount(new Hub(node.url), { rpcUrl, pollMs: 5, confirm: async () => true }));
  assert.equal(chain.sent.length, 1);
  const raw = chain.sent[0] as TransactionSerialized;
  const tx = parseTransaction(raw);
  assert.equal(tx.chainId, 10);
  assert.equal(tx.to?.toLowerCase(), ID_GATEWAY_ADDRESS.toLowerCase());
  assert.equal(tx.value, PRICE, "exactly IdGateway.price(), nothing extra");
  const decoded = decodeFunctionData({ abi: idGatewayABI, data: tx.data as Hex });
  assert.equal(decoded.functionName, "register");
  assert.deepEqual(decoded.args, [zeroAddress]);
  // Signed by the new account's own custody key, which is also what logged in.
  assert.equal(await recoverTransactionAddress({ serializedTransaction: raw }), account.custodyAddress);
  assert.equal(account.fid, Number(FID));
  assert.equal(currentFid(), Number(FID));
  assert.ok(keys.has(account.appKeyPublic));
});
