// The listener that was missing: what "your claims changed" has to do, and in what order.
//
// R12's last third. `AccountManager.onClaimsChanged()` existed and refreshed the OWNER session; an
// IPC method called `accountClaimsChanged` existed for a renderer to invoke. Neither is a listener,
// so nothing in the desktop was subscribed to `v2/tokenRefresh/{uid}` and the only thing that ever
// picked up a claim change was the next token expiry — up to an hour of a paid account being refused,
// and up to an hour of a revoked one still being served on a long-lived RTDB stream.
//
// The order is the part worth pinning. A Firebase RTDB SSE stream authenticates ONCE, at connect, so
// a stream opened with the old token keeps whatever it was granted until it is torn down: refreshing
// the token and leaving the stream up is the half-fix that looks like it worked.

import { describe, expect, it, vi } from "vitest";

import {
  createInstallationTokenRefreshListener,
  TOKEN_REFRESH_MIN_INTERVAL_MS,
  type TokenRefreshSource,
} from "./installation-token-refresh.js";

const UID = "inst-uid-1";

function fakes(options: { refreshRejects?: boolean } = {}) {
  const order: string[] = [];
  let emit: ((event: { data: unknown }) => void) | null = null;
  let streamedPath = "";
  let unsubscribed = 0;
  const client: TokenRefreshSource = {
    currentSession: vi.fn(async () => ({ uid: UID })),
    refreshSession: vi.fn(async () => {
      order.push("refresh-token");
      if (options.refreshRejects) throw new Error("nope");
      return {};
    }),
    stream: vi.fn((path, handlers) => {
      streamedPath = path;
      emit = handlers.onEvent;
      return () => {
        unsubscribed += 1;
      };
    }),
  };
  let clock = 1_000_000;
  const errors: unknown[] = [];
  const listener = createInstallationTokenRefreshListener({
    client,
    restartStreams: () => order.push("restart-streams"),
    refreshAccount: async () => void order.push("refresh-account"),
    now: () => clock,
    onError: (error) => errors.push(error),
  });
  return {
    client,
    listener,
    order,
    errors,
    path: () => streamedPath,
    unsubscribed: () => unsubscribed,
    emit: (data: unknown) => emit?.({ data }),
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("the installation token-refresh listener", () => {
  it("refreshes the final marker after the cooldown without needing another event", async () => {
    vi.useFakeTimers();
    const harness = fakes();
    try {
      await harness.listener.start();
      harness.emit({ revision: 1 });
      await vi.advanceTimersByTimeAsync(0);
      harness.emit({ revision: 2 });
      harness.emit({ revision: 3 });
      expect(harness.client.refreshSession).toHaveBeenCalledTimes(1);
      harness.advance(TOKEN_REFRESH_MIN_INTERVAL_MS);
      await vi.advanceTimersByTimeAsync(TOKEN_REFRESH_MIN_INTERVAL_MS);
      expect(harness.client.refreshSession).toHaveBeenCalledTimes(2);
    } finally {
      harness.listener.stop();
      vi.useRealTimers();
    }
  });

  it("cancels a queued refresh when stopped", async () => {
    vi.useFakeTimers();
    const harness = fakes();
    try {
      await harness.listener.start();
      harness.emit({ revision: 1 });
      await vi.advanceTimersByTimeAsync(0);
      harness.emit({ revision: 2 });
      harness.listener.stop();
      harness.advance(TOKEN_REFRESH_MIN_INTERVAL_MS);
      await vi.advanceTimersByTimeAsync(TOKEN_REFRESH_MIN_INTERVAL_MS);
      expect(harness.client.refreshSession).toHaveBeenCalledTimes(1);
    } finally {
      harness.listener.stop();
      vi.useRealTimers();
    }
  });

  it("subscribes to the marker for ITS OWN uid, taken from the session", async () => {
    // The marker's own rule is `auth.uid === $uid`, so a listener on anybody else's path would be
    // refused — and asking for one would mean this module had an opinion about which installation it
    // is. The uid comes from the session and from nowhere else.
    const harness = fakes();
    await harness.listener.start();
    expect(harness.path()).toBe(`v2/tokenRefresh/${UID}`);
    expect(harness.client.currentSession).toHaveBeenCalled();
  });

  it("mints the token BEFORE tearing the streams down, and re-reads the page after", async () => {
    const harness = fakes();
    await harness.listener.start();
    harness.emit({ revision: 7, changedAt: 1 });
    await vi.waitFor(() => expect(harness.order.length).toBe(3));
    // The order is the whole point: a stream opened with the old token keeps what it was granted.
    expect(harness.order).toEqual(["refresh-token", "restart-streams", "refresh-account"]);
  });

  it("ignores an EMPTY marker, so a machine with none does nothing on subscribe", async () => {
    // The first event of an SSE subscription is the node's current value, and for an installation
    // that has never had a claim change that is `null`.
    const harness = fakes();
    await harness.listener.start();
    harness.emit(null);
    harness.emit(undefined);
    await Promise.resolve();
    expect(harness.order).toEqual([]);
  });

  it("collapses a burst rather than restarting the streams once per marker", async () => {
    // A re-issue across five devices writes five markers within a second. Five stream restarts would
    // be worse than the staleness they were fixing.
    const harness = fakes();
    await harness.listener.start();
    harness.emit({ revision: 1 });
    await vi.waitFor(() => expect(harness.order.length).toBe(3));
    harness.emit({ revision: 2 });
    harness.emit({ revision: 3 });
    await Promise.resolve();
    expect(harness.order.filter((entry) => entry === "restart-streams")).toHaveLength(1);

    // Past the interval it works again — the collapse is a rate limit, not a one-shot.
    harness.advance(TOKEN_REFRESH_MIN_INTERVAL_MS + 1);
    harness.emit({ revision: 4 });
    await vi.waitFor(() => expect(harness.order.filter((entry) => entry === "restart-streams")).toHaveLength(2));
  });

  it("a failed refresh changes nothing and is reported, never thrown into the caller", async () => {
    // This path exists to make things better sooner; it must not be able to make them worse.
    const harness = fakes({ refreshRejects: true });
    await harness.listener.start();
    harness.emit({ revision: 9 });
    await vi.waitFor(() => expect(harness.errors).toHaveLength(1));
    expect(harness.order).toEqual(["refresh-token"]);
  });

  it("stops cleanly, and starting twice subscribes once", async () => {
    const harness = fakes();
    await harness.listener.start();
    await harness.listener.start();
    expect(harness.client.stream).toHaveBeenCalledTimes(1);
    harness.listener.stop();
    expect(harness.unsubscribed()).toBe(1);
    harness.listener.stop();
    expect(harness.unsubscribed()).toBe(1);
  });
});

describe("the applied-marker memory", () => {
  it("does not restart anything when the stream reconnects and re-sends the marker it already applied", async () => {
    // 2026-10-05: the ID token behind the SSE stream expires about hourly, the stream reconnects, and
    // RTDB re-sends the CURRENT value first. That is not news.
    const harness = fakes();
    await harness.listener.start();
    harness.emit({ revision: 7, changedAt: 1 });
    await vi.waitFor(() => expect(harness.order.length).toBe(3));
    harness.advance(TOKEN_REFRESH_MIN_INTERVAL_MS * 10);
    harness.emit({ revision: 7, changedAt: 1 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(harness.client.refreshSession).toHaveBeenCalledTimes(1);
    harness.emit({ revision: 8, changedAt: 2 });
    await vi.waitFor(() => expect(harness.client.refreshSession).toHaveBeenCalledTimes(2));
  });

  it("does not treat the unchanged marker as news after a process restart either", async () => {
    let stored: string | null = null;
    const make = () => {
      const order: string[] = [];
      let emit: ((event: { data: unknown }) => void) | null = null;
      const client: TokenRefreshSource = {
        currentSession: async () => ({ uid: UID }),
        refreshSession: async () => void order.push("refresh-token"),
        stream: (_path, handlers) => {
          emit = handlers.onEvent;
          return () => {};
        },
      };
      const listener = createInstallationTokenRefreshListener({
        client,
        restartStreams: () => order.push("restart-streams"),
        refreshAccount: async () => void order.push("refresh-account"),
        loadAppliedMarker: () => stored,
        saveAppliedMarker: (marker) => {
          stored = marker;
        },
      });
      return { listener, order, emit: (data: unknown) => emit?.({ data }) };
    };
    const first = make();
    await first.listener.start();
    first.emit({ revision: 3 });
    await vi.waitFor(() => expect(first.order.length).toBe(3));
    first.listener.stop();

    const second = make();
    await second.listener.start();
    second.emit({ revision: 3 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(second.order).toEqual([]);
    second.emit({ revision: 4 });
    await vi.waitFor(() => expect(second.order.length).toBe(3));
    second.listener.stop();
  });
});
