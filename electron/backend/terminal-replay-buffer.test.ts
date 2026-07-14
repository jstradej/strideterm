import { describe, test, expect } from "vitest";
import { TerminalReplayStore } from "./terminal-replay-buffer.js";

describe("TerminalReplayStore", () => {
  test("sequence numbers increase independently per session", () => {
    const store = new TerminalReplayStore(1024);
    expect(store.append("ws:a", "x")).toBe(1);
    expect(store.append("ws:a", "y")).toBe(2);
    expect(store.append("ws:b", "z")).toBe(1);
    expect(store.append("ws:a", "w")).toBe(3);
    expect(store.append("ws:b", "q")).toBe(2);
  });

  test("snapshot returns concatenated data and the newest seq as throughSeq", () => {
    const store = new TerminalReplayStore(1024);
    store.append("ws:a", "hello ");
    store.append("ws:a", "world");
    expect(store.snapshot("ws:a")).toEqual({ data: "hello world", throughSeq: 2 });
  });

  test("unknown session snapshots to empty with throughSeq 0", () => {
    const store = new TerminalReplayStore(1024);
    expect(store.snapshot("nope")).toEqual({ data: "", throughSeq: 0 });
  });

  test("eviction removes whole chunks from the head, never splitting", () => {
    const store = new TerminalReplayStore(10);
    store.append("s", "aaaa"); // 4 bytes
    store.append("s", "bbbb"); // 8 bytes total
    store.append("s", "cccc"); // 12 > 10 → evict "aaaa"
    const snap = store.snapshot("s");
    expect(snap.data).toBe("bbbbcccc"); // whole chunks only, no partial "aa"
    expect(snap.throughSeq).toBe(3);
  });

  test("stays bounded and correct across many small appends at the cap (head-index ring)", () => {
    // Regression: eviction used Array.shift() (O(n) per append) once the buffer
    // filled. The head-index ring must keep the store bounded AND keep the
    // newest content over thousands of appends without the array growing without
    // bound. 10-byte budget, single-char chunks → at most 10 live chars.
    const store = new TerminalReplayStore(10);
    for (let i = 0; i < 5000; i++) {
      store.append("s", String.fromCharCode(97 + (i % 26)));
    }
    const snap = store.snapshot("s");
    expect(Buffer.byteLength(snap.data, "utf8")).toBeLessThanOrEqual(10);
    expect(snap.throughSeq).toBe(5000);
    // The tail must be the last 10 characters appended, in order.
    const expected = Array.from({ length: 10 }, (_, k) => String.fromCharCode(97 + ((5000 - 10 + k) % 26))).join("");
    expect(snap.data).toBe(expected);
  });

  test("counts UTF-8 bytes, not code units", () => {
    // "é" is 2 UTF-8 bytes; budget 5 holds two of them but not three.
    const store = new TerminalReplayStore(5);
    store.append("s", "é"); // 2 bytes
    store.append("s", "é"); // 4 bytes
    store.append("s", "é"); // 6 > 5 → evict head
    expect(store.snapshot("s").data).toBe("éé");
  });

  test("evicts a lone newest chunk that alone exceeds the budget (never split)", () => {
    const store = new TerminalReplayStore(4);
    store.append("s", "aa");
    store.append("s", "this-single-chunk-is-way-over-budget");
    // Plan v2: chunks are never split. A lone chunk larger than the whole budget
    // is evicted entirely rather than truncated, so replay never begins partway
    // through an ANSI sequence. The store is left empty; the seq counter advances.
    const snap = store.snapshot("s");
    expect(snap.data).toBe("");
    expect(snap.throughSeq).toBe(2);
    expect(Buffer.byteLength(snap.data, "utf8")).toBeLessThanOrEqual(4);
  });

  test("assigns a seq even when storage is disabled (maxBytes 0)", () => {
    const store = new TerminalReplayStore(0);
    expect(store.append("s", "x")).toBe(1);
    expect(store.append("s", "y")).toBe(2);
    // Nothing is stored, but the counter still advances so live-frame ordering
    // stays well-defined regardless of the byte budget.
    expect(store.snapshot("s")).toEqual({ data: "", throughSeq: 2 });
  });

  test("clear() empties output but keeps the counter (restart continuity)", () => {
    const store = new TerminalReplayStore(1024);
    store.append("s", "old-gen");
    expect(store.snapshot("s").throughSeq).toBe(1);
    store.clear("s");
    expect(store.snapshot("s")).toEqual({ data: "", throughSeq: 1 });
    // New generation continues the counter so old throughSeq can't shadow it.
    expect(store.append("s", "new-gen")).toBe(2);
    expect(store.snapshot("s")).toEqual({ data: "new-gen", throughSeq: 2 });
  });

  test("delete() drops output and the counter (destroy)", () => {
    const store = new TerminalReplayStore(1024);
    store.append("s", "data");
    store.delete("s");
    expect(store.snapshot("s")).toEqual({ data: "", throughSeq: 0 });
    expect(store.append("s", "fresh")).toBe(1); // counter reset after destroy
  });

  test("deleteWorkspace() drops only sessions under that workspace prefix", () => {
    const store = new TerminalReplayStore(1024);
    store.append("ws1:a", "1a");
    store.append("ws1:b", "1b");
    store.append("ws2:a", "2a");
    store.deleteWorkspace("ws1");
    expect(store.snapshot("ws1:a").data).toBe("");
    expect(store.snapshot("ws1:b").data).toBe("");
    expect(store.snapshot("ws2:a").data).toBe("2a");
  });
});
