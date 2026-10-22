// threecast — MIT License

import type { HubAsyncResult, HubResult } from "@farcaster/core";

/** A failure the user can act on. `message` says what went wrong, `hint` says what to do next. */
export class TcError extends Error {
  hint: string | undefined;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = "TcError";
    this.hint = hint;
  }
}

/** An error response from the node's HTTP API. */
export class NodeError extends TcError {
  status: number;
  path: string;
  /** The node's own words, e.g. "cast not found" or "message has already been merged". */
  reason: string;
  /** HubError code when the node sent one, e.g. "bad_request.duplicate". */
  code: string | undefined;
  /** Snapchain reports a missing record as HTTP 400 with status NotFound, never as 404. */
  notFound: boolean;

  constructor(status: number, path: string, error: string, detail: string) {
    const parsed = parseDetail(detail);
    const reason = parsed.message || detail || error;
    super(`The node answered ${path} with an error: ${reason}`, "Check that the node is synced (./threecast status). If it is, please report this with the command you ran.");
    this.name = "NodeError";
    this.status = status;
    this.path = path;
    this.reason = reason;
    this.code = parsed.code;
    this.notFound = status === 400 && (/status: NotFound/.test(detail) || /not found/i.test(reason));
  }
}

// error_detail is a stringified gRPC status:
//   status: NotFound, message: "cast not found", details: [], metadata: MetadataMap { headers: {} }
// and for submits the message carries the HubError code: "bad_request.duplicate/message has already been merged".
function parseDetail(detail: string): { message: string; code: string | undefined } {
  const quoted = /message: "((?:[^"\\]|\\.)*)"/.exec(detail)?.[1]?.replace(/\\"/g, '"') ?? "";
  const coded = /^([a-z_]+\.[a-z_]+)\/(.*)$/s.exec(quoted);
  if (coded) return { code: coded[1], message: coded[2] ?? "" };
  return { code: undefined, message: quoted };
}

/** Unwraps a neverthrow result from @farcaster/core, naming the step that failed. */
export async function unwrap<T>(result: HubResult<T> | HubAsyncResult<T>, step: string): Promise<T> {
  const r = await result;
  if (r.isErr()) throw new TcError(`${step} failed: ${r.error.message}`, "Nothing was sent to the node. If this happens again, please report it with the command you ran.");
  return r.value;
}
