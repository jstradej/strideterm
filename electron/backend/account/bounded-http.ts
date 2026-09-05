// Two rules every account request obeys, in one place: it ends, and it reads a bounded number of
// bytes.
//
// WHY A SHARED MODULE AND NOT THREE COPIES. `account-client.ts` talks to Firebase, `account-transport.ts`
// to the callables and `email-signin-broker.ts` to the auth Worker, and F04 asks the same two things of
// all three. Three implementations of "stop after 64 KiB" is three chances for one of them to be the
// lenient one — and the lenient one is the one somebody finds.
//
// WHAT "BOUNDED" HAS TO MEAN, and why the old shape did not mean it. Every one of these read
// `await response.text()` and then compared `text.length`. That is a check performed AFTER the whole
// body has been decoded into memory: a host that answers a hundred megabytes has already been handed a
// hundred megabytes by the time the limit is consulted, and the limit only decides whether the string
// is then thrown away. It also counted UTF-16 code units rather than bytes. This reads the body as a
// stream and abandons it the moment the byte count passes the limit, which is the property the plan
// asks for — §"Bezpečnostní hranice": "Odpovědi se parsují s limitem velikosti".
//
// AND A TIMEOUT HAS TO COVER THE BODY. A request whose headers arrive in 20 ms and whose body then
// trickles for ever is a hung request, and a timer cleared when `fetch` resolves does not see it. The
// deadline here is armed before the request and disarmed after the body has been read.
//
// AND THE THREE WAYS A BODY CAN FAIL ARE THREE DIFFERENT FACTS (R04). The reader used to fold "the
// stream broke", "it was too large" and "it was not JSON" into one `null`, and the callers then had to
// guess which: a 200 whose body broke off before the timer fired became `{}` at the Firebase client —
// a send "confirmed" by a body nobody read — and `malformed-response` at the callable transport, which
// the manager took as a definite refusal and dropped the idempotency key on. A stream that failed is
// a TRANSPORT outcome, whatever the status line said; an oversized or unparseable body is an answer
// this desktop cannot read, which for a mutation is an UNKNOWN outcome and not a refusal. The caller
// decides what each means; this module only refuses to blur them.

/** A deadline for one request, covering the response body as well as the headers. */
export interface RequestDeadline {
  /** Pass to `fetch`. Aborts on the timeout, and when the caller's own signal aborts. */
  readonly signal: AbortSignal;
  /** Whether this deadline is the reason the request aborted, as opposed to the caller's signal. */
  timedOut(): boolean;
  /** Disarms the timer. Always call it, in a `finally`. */
  dispose(): void;
}

/**
 * Arms a request deadline, optionally chained to a flow's own abort signal.
 *
 * TWO REASONS A REQUEST CAN END EARLY, and the caller needs to tell them apart: this request took too
 * long, or the FLOW it belongs to was cancelled. `timedOut()` answers that — the first is a network
 * failure to report, the second is a flow that no longer wants an answer.
 */
export function requestDeadline(timeoutMs: number, external?: AbortSignal): RequestDeadline {
  const controller = new AbortController();
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    controller.abort();
  }, timeoutMs);
  timer.unref?.();
  const onExternalAbort = (): void => controller.abort();
  if (external !== undefined) {
    if (external.aborted) controller.abort();
    else external.addEventListener("abort", onExternalAbort, { once: true });
  }
  return {
    signal: controller.signal,
    timedOut: () => expired,
    dispose: () => {
      clearTimeout(timer);
      external?.removeEventListener("abort", onExternalAbort);
    },
  };
}

/**
 * What came back when a body was read, as one of three distinct facts.
 *
 *   - `ok` — the whole body, within the bound.
 *   - `too-large` — the peer sent more than the bound allows; the stream was cancelled at the limit.
 *   - `unreadable` — the stream failed before it ended: the connection dropped, the deadline aborted
 *     it, the flow was abandoned. NOTHING IS KNOWN about what the peer meant to say, which is why this
 *     is not folded into either neighbour.
 */
export type BoundedBody =
  { readonly kind: "ok"; readonly text: string } | { readonly kind: "too-large" } | { readonly kind: "unreadable" };

/**
 * Reads at most `maxBytes` of a response body.
 *
 * The counting is of BYTES ACTUALLY RECEIVED. The moment the running total passes the limit the stream
 * is cancelled, so the peer is told to stop rather than being allowed to finish into a buffer that is
 * about to be discarded.
 */
export async function readBoundedBody(response: Response, maxBytes: number): Promise<BoundedBody> {
  const body = response.body;
  if (body === null || body === undefined) {
    // No stream at all: an empty body, or a `Response` built without one. `text()` on it is bounded by
    // construction, and reading it cannot cost anything.
    try {
      const text = await response.text();
      return byteLength(text) > maxBytes ? { kind: "too-large" } : { kind: "ok", text };
    } catch {
      return { kind: "unreadable" };
    }
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        // OVER THE LIMIT: stop the peer rather than draining what is left.
        await reader.cancel().catch(() => {});
        return { kind: "too-large" };
      }
      chunks.push(value);
    }
  } catch {
    // An aborted or broken stream. The caller's own error mapping decides what that means — and it is
    // told that THIS is what happened, not handed a value that looks like "the peer said nothing".
    return { kind: "unreadable" };
  } finally {
    reader.releaseLock?.();
  }
  return {
    kind: "ok",
    text: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength))).toString(
      "utf8",
    ),
  };
}

/**
 * The bounded body, parsed as a JSON object — or which of the three ways it failed to be one.
 *
 * `not-json` covers an array too: every contract here is an object, and `[...]` reaching a caller that
 * indexes fields by name is a value that reads as "every field is missing" rather than as a refusal.
 */
export type BoundedJson =
  | { readonly kind: "ok"; readonly value: Record<string, unknown> }
  | { readonly kind: "too-large" }
  | { readonly kind: "unreadable" }
  | { readonly kind: "not-json" };

export async function readBoundedJsonBody(response: Response, maxBytes: number): Promise<BoundedJson> {
  const body = await readBoundedBody(response, maxBytes);
  if (body.kind !== "ok") return body;
  try {
    const parsed = JSON.parse(body.text) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { kind: "not-json" };
    return { kind: "ok", value: parsed as Record<string, unknown> };
  } catch {
    return { kind: "not-json" };
  }
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}
