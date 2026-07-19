import { describe, expect, it, vi } from "vitest";
import { SessionMap } from "./session-map.js";

// Synthetic session type — deliberately unrelated to docker — to prove
// SessionMap is a generic bookkeeping helper, not tied to any one backend.
class FakeSession {
  stopped = false;
  constructor(readonly id: string) {}
  stop(): void {
    this.stopped = true;
  }
}

describe("SessionMap", () => {
  it("set()/get() store and retrieve a session", () => {
    const map = new SessionMap<FakeSession>();
    const session = new FakeSession("a");
    map.set("a", session);
    expect(map.get("a")).toBe(session);
    expect(map.get("missing")).toBeUndefined();
  });

  it("has() / hasAny() reflect current contents", () => {
    const map = new SessionMap<FakeSession>();
    expect(map.has("a")).toBe(false);
    expect(map.hasAny()).toBe(false);

    map.set("a", new FakeSession("a"));
    expect(map.has("a")).toBe(true);
    expect(map.hasAny()).toBe(true);
  });

  it("remove() stops the session and drops it from the map", () => {
    const map = new SessionMap<FakeSession>();
    const session = new FakeSession("a");
    map.set("a", session);

    map.remove("a");

    expect(session.stopped).toBe(true);
    expect(map.has("a")).toBe(false);
  });

  it("remove() on an unknown id is a silent no-op", () => {
    const map = new SessionMap<FakeSession>();
    expect(() => map.remove("nope")).not.toThrow();
  });

  it("delete() drops the entry without calling stop()", () => {
    const map = new SessionMap<FakeSession>();
    const session = new FakeSession("a");
    map.set("a", session);

    map.delete("a");

    expect(session.stopped).toBe(false);
    expect(map.has("a")).toBe(false);
  });

  it("stopAll() stops every tracked session and clears the map", () => {
    const map = new SessionMap<FakeSession>();
    const a = new FakeSession("a");
    const b = new FakeSession("b");
    map.set("a", a);
    map.set("b", b);

    map.stopAll();

    expect(a.stopped).toBe(true);
    expect(b.stopped).toBe(true);
    expect(map.hasAny()).toBe(false);
    expect(map.has("a")).toBe(false);
    expect(map.has("b")).toBe(false);
  });

  it("set() with an existing id overwrites the previous session (no implicit stop)", () => {
    const map = new SessionMap<FakeSession>();
    const first = new FakeSession("a");
    const second = new FakeSession("a");
    map.set("a", first);
    map.set("a", second);

    expect(map.get("a")).toBe(second);
    expect(first.stopped).toBe(false);
  });

  it("stop() failures propagate out of stopAll() (no swallowing)", () => {
    const map = new SessionMap<{ stop(): void }>();
    const throwing = { stop: vi.fn(() => { throw new Error("boom"); }) };
    map.set("a", throwing);

    expect(() => map.stopAll()).toThrow("boom");
  });
});
