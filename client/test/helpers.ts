// threecast — MIT License
// Test helpers: a throwaway $TC_HOME and a fake node on 127.0.0.1.

import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { sink } from "../src/out.ts";

/** Points $THREECAST_HOME at a fresh temporary directory and returns it. */
export function useTempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "threecast-test-"));
  process.env.THREECAST_HOME = dir;
  return dir;
}

export interface MockRequest {
  method: string;
  path: string;
  /** The raw query string, so tests can check exactly how it was encoded. */
  rawQuery: string;
  query: URLSearchParams;
  headers: IncomingMessage["headers"];
  body: Buffer;
}

export interface MockReply {
  status?: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
}

export type Route = (req: MockRequest) => MockReply | Promise<MockReply>;

/** A fake Snapchain HTTP API. Unknown routes answer 404 "Not Found" like the real one. */
export async function mockNode(routes: Record<string, Route>): Promise<{ url: string; requests: MockRequest[]; close(): Promise<void> }> {
  const requests: MockRequest[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const [path = "", rawQuery = ""] = (req.url ?? "").split("?", 2);
    const request: MockRequest = {
      method: req.method ?? "GET",
      path,
      rawQuery,
      query: new URLSearchParams(rawQuery),
      headers: req.headers,
      body: Buffer.concat(chunks),
    };
    requests.push(request);
    const route = routes[path];
    const reply = route ? await route(request) : { status: 404, text: "Not Found" };
    res.statusCode = reply.status ?? 200;
    for (const [name, value] of Object.entries(reply.headers ?? {})) res.setHeader(name, value);
    if (reply.json !== undefined) {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(reply.json));
    } else {
      res.end(reply.text ?? "");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** The node's not-found shape: HTTP 400 with a stringified gRPC status. */
export function notFound(error: string, message: string): MockReply {
  return {
    status: 400,
    json: { error, error_detail: `status: NotFound, message: "${message}", details: [], metadata: MetadataMap { headers: {} }` },
  };
}

/** Runs `work` with threecast's narration discarded (the test runner itself reports over stdout). */
export async function quietly<T>(work: () => Promise<T>): Promise<T> {
  const { out, err } = sink;
  const discard = new Writable({ write: (_chunk, _encoding, done) => done() });
  sink.out = discard;
  sink.err = discard;
  try {
    return await work();
  } finally {
    sink.out = out;
    sink.err = err;
  }
}
