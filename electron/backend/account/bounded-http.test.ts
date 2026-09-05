// The bounded reader: three ways a body can fail to be a value, kept as three different facts (R04).
//
// The callers' error mapping rests on this distinction. A stream that BROKE is a transport outcome
// whatever the status line said; a body that was too large, or not JSON, is an answer this desktop
// cannot read. Folding them into one `null` — which is what the reader used to do — left every caller
// guessing, and the guesses were wrong in both directions: a 200 whose body broke off became `{}` (a
// send "confirmed" by nothing) at one caller, and a definite refusal at another.
import { describe, expect, test } from "vitest";

import { readBoundedBody, readBoundedJsonBody } from "./bounded-http.js";

const LIMIT = 1024;

function streaming(chunks: Uint8Array[], options: { failAfter?: boolean } = {}): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        if (options.failAfter) controller.error(new Error("connection reset"));
        else controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("readBoundedBody", () => {
  test("a whole body within the bound is `ok`", async () => {
    expect(await readBoundedBody(streaming([encode('{"a":'), encode("1}")]), LIMIT)).toEqual({
      kind: "ok",
      text: '{"a":1}',
    });
  });

  test("a stream that fails before it ends is `unreadable`, not an empty answer", async () => {
    // HTTP 200, half a body, then the connection drops. Nothing is known about what the peer said.
    const result = await readBoundedBody(streaming([encode('{"a":1,')], { failAfter: true }), LIMIT);
    expect(result).toEqual({ kind: "unreadable" });
  });

  test("a body past the bound is `too-large`, and the stream is cancelled at the limit", async () => {
    let pulled = 0;
    const chunk = encode("x".repeat(256));
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled += 1;
          if (pulled > 1000) return controller.close();
          controller.enqueue(chunk);
        },
      }),
      { status: 200 },
    );
    expect(await readBoundedBody(response, LIMIT)).toEqual({ kind: "too-large" });
    // Five chunks pass the 1 KiB bound; the peer was not allowed to send the other 995.
    expect(pulled).toBeLessThan(20);
  });

  test("a response with no stream at all is read whole and bounded by construction", async () => {
    expect(await readBoundedBody(new Response(null, { status: 204 }), LIMIT)).toEqual({ kind: "ok", text: "" });
  });
});

describe("readBoundedJsonBody", () => {
  test("a JSON object is `ok`", async () => {
    expect(await readBoundedJsonBody(streaming([encode('{"result":{"status":"ok"}}')]), LIMIT)).toEqual({
      kind: "ok",
      value: { result: { status: "ok" } },
    });
  });

  test("a body that is not JSON is `not-json` — distinct from a stream that failed", async () => {
    expect(await readBoundedJsonBody(streaming([encode("<html>gateway timeout</html>")]), LIMIT)).toEqual({
      kind: "not-json",
    });
    expect(await readBoundedJsonBody(streaming([encode("<html>")], { failAfter: true }), LIMIT)).toEqual({
      kind: "unreadable",
    });
  });

  test("an array is `not-json` too: every contract here is an object", async () => {
    expect(await readBoundedJsonBody(streaming([encode("[1,2,3]")]), LIMIT)).toEqual({ kind: "not-json" });
  });

  test("a too-large body is reported as such, not parsed", async () => {
    expect(await readBoundedJsonBody(streaming([encode(`{"pad":"${"p".repeat(LIMIT)}"}`)]), LIMIT)).toEqual({
      kind: "too-large",
    });
  });
});
