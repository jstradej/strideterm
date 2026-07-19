import { describe, expect, test, vi } from "vitest";
import { useMonacoDiffLoader } from "./useMonacoDiffLoader.js";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("useMonacoDiffLoader", () => {
  test("starts with no payload and not loading", () => {
    const { payload, loading } = useMonacoDiffLoader(vi.fn());
    expect(payload.value).toBeNull();
    expect(loading.value).toBe(false);
  });

  test("load() sets loading true, then applies the resolved payload and clears loading", async () => {
    const fetchThunk = vi.fn().mockResolvedValue({ ok: true, leftContent: "a", rightContent: "b" });
    const { payload, loading, load } = useMonacoDiffLoader(fetchThunk);

    const p = load("path.ts", "staged");
    expect(loading.value).toBe(true);
    await p;

    expect(fetchThunk).toHaveBeenCalledWith("path.ts", "staged");
    expect(payload.value).toEqual({ ok: true, leftContent: "a", rightContent: "b" });
    expect(loading.value).toBe(false);
  });

  test("a rejected fetch produces a uniform error payload and clears loading", async () => {
    const fetchThunk = vi.fn().mockRejectedValue(new Error("boom"));
    const { payload, loading, load } = useMonacoDiffLoader(fetchThunk, "Failed to load thing");

    await load("path.ts", "head");

    expect(loading.value).toBe(false);
    expect(payload.value).toEqual({
      ok: false,
      leftError: "boom",
      leftContent: "",
      rightContent: "",
      leftLabel: "",
      rightLabel: "",
      leftMissing: true,
      rightMissing: true,
      language: "plaintext",
    });
  });

  test("a rejection with no message falls back to the configured errorMessage", async () => {
    const fetchThunk = vi.fn().mockRejectedValue({});
    const { payload, load } = useMonacoDiffLoader(fetchThunk, "Failed to load commit diff");
    await load("a", "b");
    expect(payload.value?.leftError).toBe("Failed to load commit diff");
  });

  test("defaults the error message to 'Failed to load diff' when none is given", async () => {
    const fetchThunk = vi.fn().mockRejectedValue({});
    const { payload, load } = useMonacoDiffLoader(fetchThunk);
    await load("a");
    expect(payload.value?.leftError).toBe("Failed to load diff");
  });

  test("seq-guard: an in-flight response that resolves after a newer call is ignored", async () => {
    const first = deferred<{ marker: string }>();
    const second = deferred<{ marker: string }>();
    const fetchThunk = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { payload, loading, load } = useMonacoDiffLoader(fetchThunk);

    const p1 = load("first");
    const p2 = load("second");

    // Resolve the SECOND (newer) call first, then the stale first call.
    second.resolve({ marker: "second" });
    await p2;
    expect(payload.value).toEqual({ marker: "second" });

    first.resolve({ marker: "first" });
    await p1;
    // The stale response must NOT have clobbered the newer one.
    expect(payload.value).toEqual({ marker: "second" });
    expect(loading.value).toBe(false);
  });

  test("seq-guard: a stale rejection after a newer call does not overwrite the newer payload", async () => {
    const first = deferred<never>();
    const second = deferred<{ marker: string }>();
    const fetchThunk = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { payload, load } = useMonacoDiffLoader(fetchThunk);

    const p1 = load("first");
    const p2 = load("second");

    second.resolve({ marker: "second" });
    await p2;
    expect(payload.value).toEqual({ marker: "second" });

    first.reject(new Error("stale failure"));
    await p1;
    expect(payload.value).toEqual({ marker: "second" });
  });

  test("a stale in-flight request does not clear loading after a newer request finishes", async () => {
    const first = deferred<{ marker: string }>();
    const second = deferred<{ marker: string }>();
    const fetchThunk = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { loading, load } = useMonacoDiffLoader(fetchThunk);

    const p1 = load("first");
    const p2 = load("second");
    expect(loading.value).toBe(true);

    second.resolve({ marker: "second" });
    await p2;
    expect(loading.value).toBe(false);

    // The stale first call's `finally` must not flip loading back to true or
    // otherwise disturb state once it eventually settles.
    first.resolve({ marker: "first" });
    await p1;
    expect(loading.value).toBe(false);
  });
});
