import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetSystemCaForTests, applySystemCaTrust, type CaCertificateType } from "./system-ca.js";

function fakeStore(stores: Partial<Record<CaCertificateType, string[] | Error>>) {
  const get = vi.fn((type: CaCertificateType) => {
    const value = stores[type];
    if (value instanceof Error) throw value;
    return value ?? [];
  });
  const set = vi.fn((_certs: string[]) => {});
  return { get, set };
}

describe("applySystemCaTrust", () => {
  afterEach(() => __resetSystemCaForTests());

  it("merges default and system, deduplicates, and sets exactly once", () => {
    const { get, set } = fakeStore({ default: ["A", "B"], system: ["B", "C", "C"] });
    const result = applySystemCaTrust({ getCACertificates: get, setDefaultCACertificates: set, env: {} });
    expect(set).toHaveBeenCalledTimes(1);
    expect([...set.mock.calls[0][0]].sort()).toEqual(["A", "B", "C"]);
    expect(result).toMatchObject({ status: "applied", defaultCount: 2, systemCount: 3, addedCount: 1 });
  });

  it("keeps every bundled/default certificate in the result", () => {
    const defaults = ["D1", "D2", "D3"];
    const { get, set } = fakeStore({ default: defaults, system: ["S1"] });
    applySystemCaTrust({ getCACertificates: get, setDefaultCACertificates: set, env: {} });
    for (const cert of defaults) expect(set.mock.calls[0][0]).toContain(cert);
  });

  it("returns the stored result on a second call without setting again", () => {
    const { get, set } = fakeStore({ default: ["A"], system: ["B"] });
    const first = applySystemCaTrust({ getCACertificates: get, setDefaultCACertificates: set, env: {} });
    const second = applySystemCaTrust({ getCACertificates: get, setDefaultCACertificates: set, env: {} });
    expect(second).toBe(first);
    expect(set).toHaveBeenCalledTimes(1);
  });

  it("STRIDETERM_DISABLE_SYSTEM_CA=1 returns disabled and never sets", () => {
    const { get, set } = fakeStore({ default: ["A"], system: ["B"] });
    const result = applySystemCaTrust({
      getCACertificates: get,
      setDefaultCACertificates: set,
      env: { STRIDETERM_DISABLE_SYSTEM_CA: "1" },
    });
    expect(result).toEqual({ status: "disabled" });
    expect(set).not.toHaveBeenCalled();
  });

  it("a Node without the API returns unsupported", () => {
    const result = applySystemCaTrust({
      getCACertificates: undefined as never,
      setDefaultCACertificates: "nope" as never,
      env: {},
    });
    expect(result).toEqual({ status: "unsupported" });
  });

  it("a failing system store returns failed, does not throw, and keeps the bundled roots", () => {
    const { get, set } = fakeStore({ default: ["A"], system: new Error("store unavailable") });
    let result: ReturnType<typeof applySystemCaTrust> | undefined;
    expect(() => {
      result = applySystemCaTrust({ getCACertificates: get, setDefaultCACertificates: set, env: {} });
    }).not.toThrow();
    expect(result).toMatchObject({ status: "failed", error: "store unavailable" });
    expect(set).not.toHaveBeenCalled();
  });

  it("an empty system store is applied with addedCount 0", () => {
    const { get, set } = fakeStore({ default: ["A"], system: [] });
    const result = applySystemCaTrust({ getCACertificates: get, setDefaultCACertificates: set, env: {} });
    expect(result).toMatchObject({ status: "applied", systemCount: 0, addedCount: 0 });
  });

  it("reports durationMs from the injected clock", () => {
    const { get, set } = fakeStore({ default: ["A"], system: ["B"] });
    const ticks = [10, 42];
    const result = applySystemCaTrust({
      getCACertificates: get,
      setDefaultCACertificates: set,
      env: {},
      now: () => ticks.shift() ?? 42,
    });
    expect(result).toMatchObject({ durationMs: 32 });
  });
});
