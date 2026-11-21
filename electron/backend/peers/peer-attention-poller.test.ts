import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PeerHostLinkState } from "../../shared/peers.js";
import { PEER_HOST_NOTE_CHANGED_CHANNEL, type PeerHostNoteChanged } from "../../shared/peer-host-note-events.js";
import { PeerClientError, type PeerRequest, type PeerResponse } from "./peer-client.js";
import { shouldNotifyPeerAttention } from "../../peer-attention-native.js";
import {
  PEER_ATTENTION_BACKOFF_MS,
  PEER_ATTENTION_EVENT,
  PEER_ATTENTION_INTERVAL_MS,
  createPeerAttentionPoller,
  type PeerAttentionEvent,
} from "./peer-attention-poller.js";

const ok = (
  total: number,
  profiles: Array<{ profileId: string; count: number }> = [],
  globalNoteRevision = 0,
): PeerResponse => ({
  status: 200,
  headers: {},
  body: JSON.stringify({ total, profiles, globalNoteRevision }),
});

function setup() {
  const hosts = new Set(["host-aaaa-1"]);
  const status = new Map<string, { state: PeerHostLinkState; checkedAt: number }>();
  const requests: Array<{ hostId: string; request: PeerRequest }> = [];
  const events: PeerAttentionEvent[] = [];
  const noteEvents: PeerHostNoteChanged[] = [];
  const control = {
    reply: (async () => ok(0)) as (hostId: string) => Promise<PeerResponse>,
  };
  const poller = createPeerAttentionPoller({
    listHostIds: () => [...hosts],
    getHostStatus: (hostId) => status.get(hostId) ?? { state: "unknown", checkedAt: 0 },
    request: async (hostId, request) => {
      requests.push({ hostId, request });
      return control.reply(hostId);
    },
    emit: (event, payload) => {
      if (event === PEER_HOST_NOTE_CHANGED_CHANNEL) {
        noteEvents.push(payload as PeerHostNoteChanged);
        return;
      }
      expect(event).toBe(PEER_ATTENTION_EVENT);
      events.push(payload as PeerAttentionEvent);
    },
    now: () => Date.now(),
  });
  const advance = async (ms: number) => {
    await vi.advanceTimersByTimeAsync(ms);
  };
  return { poller, hosts, status, requests, events, noteEvents, control, advance };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("peer attention poller", () => {
  it("reports a host's global note change once, never on its first answer, and not for the same counter", async () => {
    const t = setup();
    const answers = [ok(0, [], 5), ok(0, [], 5), ok(0, [], 6), ok(0, [], 6)];
    t.control.reply = async () => answers.shift()!;
    t.poller.start();
    await t.advance(10_000);
    expect(t.noteEvents).toEqual([]);
    for (let i = 0; i < 3; i++) await t.advance(PEER_ATTENTION_INTERVAL_MS);
    expect(t.noteEvents).toEqual([{ hostId: "host-aaaa-1", revision: 6 }]);
    t.poller.stop();
  });

  it("still reports a change made while the host was unreachable", async () => {
    const t = setup();
    const answers: Array<PeerResponse | Error> = [
      ok(0, [], 1),
      new PeerClientError("unreachable", "host is down"),
      ok(0, [], 2),
    ];
    t.control.reply = async () => {
      const next = answers.shift()!;
      if (next instanceof Error) throw next;
      return next;
    };
    t.poller.start();
    await t.advance(10_000);
    await t.advance(PEER_ATTENTION_INTERVAL_MS);
    expect(t.noteEvents).toEqual([]);
    await t.advance(PEER_ATTENTION_BACKOFF_MS);
    expect(t.noteEvents).toEqual([{ hostId: "host-aaaa-1", revision: 2 }]);
    t.poller.stop();
  });

  it("polls soon after start, then every 30 s, with a plain GET of the attention route", async () => {
    const t = setup();
    t.poller.start();
    await t.advance(2_000);
    expect(t.requests).toHaveLength(0);
    await t.advance(8_000);
    expect(t.requests).toHaveLength(1);
    expect(t.requests[0]!.request).toEqual({ method: "GET", pathname: "/api/peer/attention" });
    await t.advance(PEER_ATTENTION_INTERVAL_MS - 5_000);
    expect(t.requests).toHaveLength(1);
    await t.advance(5_000);
    expect(t.requests).toHaveLength(2);
    t.poller.stop();
  });

  it("emits only when the total changes, the first answer carrying no previous total", async () => {
    const t = setup();
    const answers = [ok(0), ok(0), ok(2, [{ profileId: "p", count: 2 }]), ok(2, [{ profileId: "p", count: 2 }]), ok(1)];
    t.control.reply = async () => answers.shift()!;
    t.poller.start();
    await t.advance(10_000);
    for (let i = 0; i < 4; i++) await t.advance(PEER_ATTENTION_INTERVAL_MS);
    expect(t.events).toEqual([
      { hostId: "host-aaaa-1", total: 0, previousTotal: null, profiles: [] },
      { hostId: "host-aaaa-1", total: 2, previousTotal: 0, profiles: [{ profileId: "p", count: 2 }] },
      { hostId: "host-aaaa-1", total: 1, previousTotal: 2, profiles: [] },
    ]);
    expect(t.poller.getAll()).toMatchObject([{ hostId: "host-aaaa-1", total: 1 }]);
    t.poller.stop();
  });

  it("backs off to 2 minutes while the host is unreachable", async () => {
    const t = setup();
    t.control.reply = async () => ok(4);
    t.poller.start();
    await t.advance(10_000);
    t.control.reply = async () => {
      throw new PeerClientError("unreachable", "down");
    };
    await t.advance(PEER_ATTENTION_INTERVAL_MS);
    expect(t.requests).toHaveLength(2);
    await t.advance(PEER_ATTENTION_BACKOFF_MS - 10_000);
    expect(t.requests).toHaveLength(2);
    await t.advance(10_000);
    expect(t.requests).toHaveLength(3);
    t.poller.stop();
  });

  it("drops a host's count to 0 with an event when a poll fails, and restores it as a first answer", async () => {
    const t = setup();
    t.control.reply = async () => ok(4, [{ profileId: "p", count: 4 }]);
    t.poller.start();
    await t.advance(10_000);
    t.events.length = 0;
    t.control.reply = async () => {
      throw new PeerClientError("unreachable", "down");
    };
    await t.advance(PEER_ATTENTION_INTERVAL_MS);
    expect(t.poller.getAll()).toMatchObject([{ hostId: "host-aaaa-1", total: 0, profiles: [] }]);
    expect(t.events).toEqual([{ hostId: "host-aaaa-1", total: 0, previousTotal: 4, profiles: [] }]);
    expect(shouldNotifyPeerAttention({ ...t.events[0]!, hostWindowFocused: false })).toBe(false);

    t.events.length = 0;
    t.control.reply = async () => ok(4, [{ profileId: "p", count: 4 }]);
    await t.advance(PEER_ATTENTION_BACKOFF_MS);
    expect(t.poller.getAll()[0]!.total).toBe(4);
    expect(t.events).toEqual([
      { hostId: "host-aaaa-1", total: 4, previousTotal: null, profiles: [{ profileId: "p", count: 4 }] },
    ]);
    expect(shouldNotifyPeerAttention({ ...t.events[0]!, hostWindowFocused: false })).toBe(false);
    t.poller.stop();
  });

  it("emits the fall once, however many polls fail", async () => {
    const t = setup();
    t.control.reply = async () => ok(2);
    t.poller.start();
    await t.advance(10_000);
    t.events.length = 0;
    t.control.reply = async () => ({ status: 500, headers: {}, body: "" });
    await t.advance(PEER_ATTENTION_INTERVAL_MS + PEER_ATTENTION_BACKOFF_MS * 3);
    expect(t.events).toHaveLength(1);
    t.poller.stop();
  });

  it("clears the count of a host that enters a state in which it is not polled", async () => {
    const t = setup();
    t.control.reply = async () => ok(3);
    t.poller.start();
    await t.advance(10_000);
    t.events.length = 0;
    t.status.set("host-aaaa-1", { state: "version-mismatch", checkedAt: 9 });
    await t.advance(PEER_ATTENTION_INTERVAL_MS);
    expect(t.poller.getAll()[0]!.total).toBe(0);
    expect(t.events).toEqual([{ hostId: "host-aaaa-1", total: 0, previousTotal: 3, profiles: [] }]);
    t.poller.stop();
  });

  it("does not poll a host in version-mismatch, wrong-host or not-paired state", async () => {
    const t = setup();
    for (const state of ["version-mismatch", "wrong-host", "not-paired"] as const) {
      t.status.set("host-aaaa-1", { state, checkedAt: 5 });
      t.poller.start();
      await t.advance(PEER_ATTENTION_INTERVAL_MS * 3);
      t.poller.stop();
    }
    expect(t.requests).toHaveLength(0);
  });

  it("stops asking a host that refused this desktop until a refresh moves its status", async () => {
    const t = setup();
    t.status.set("host-aaaa-1", { state: "online", checkedAt: 7 });
    t.control.reply = async () => {
      throw new PeerClientError("not-paired", "no longer accepts");
    };
    t.poller.start();
    await t.advance(10_000);
    expect(t.requests).toHaveLength(1);
    await t.advance(PEER_ATTENTION_INTERVAL_MS * 10);
    expect(t.requests).toHaveLength(1);
    t.control.reply = async () => ok(1);
    t.status.set("host-aaaa-1", { state: "online", checkedAt: 99 });
    await t.advance(PEER_ATTENTION_INTERVAL_MS * 5);
    expect(t.requests.length).toBeGreaterThan(1);
    expect(t.poller.getAll()[0]!.total).toBe(1);
    t.poller.stop();
  });

  it("treats a bad status or an unreadable body as a failure and never throws", async () => {
    const t = setup();
    t.control.reply = async () => ({ status: 404, headers: {}, body: "" });
    t.poller.start();
    await t.advance(10_000);
    t.control.reply = async () => ({ status: 200, headers: {}, body: "{nope" });
    await t.advance(PEER_ATTENTION_BACKOFF_MS);
    t.control.reply = async () => ({ status: 200, headers: {}, body: JSON.stringify({ total: -1, profiles: [] }) });
    await t.advance(PEER_ATTENTION_BACKOFF_MS);
    t.control.reply = async () => {
      throw new Error("boom");
    };
    await t.advance(PEER_ATTENTION_BACKOFF_MS);
    expect(t.requests).toHaveLength(4);
    expect(t.poller.getAll()).toEqual([]);
    expect(t.events).toEqual([]);
    t.poller.stop();
  });

  it("forgets a host that was removed and stops on dispose", async () => {
    const t = setup();
    t.control.reply = async () => ok(3);
    t.poller.start();
    await t.advance(10_000);
    expect(t.poller.getAll()).toHaveLength(1);
    t.hosts.clear();
    expect(t.poller.getAll()).toEqual([]);
    t.hosts.add("host-aaaa-1");
    t.poller.stop();
    const before = t.requests.length;
    await t.advance(PEER_ATTENTION_INTERVAL_MS * 4);
    expect(t.requests).toHaveLength(before);
  });

  it("forgets a removed host at once and lets the badge know", async () => {
    const t = setup();
    t.control.reply = async () => ok(3);
    t.poller.start();
    await t.advance(10_000);
    t.events.length = 0;
    t.hosts.clear();
    t.poller.forget("host-aaaa-1");
    expect(t.poller.getAll()).toEqual([]);
    expect(t.events).toEqual([{ hostId: "host-aaaa-1", total: 0, previousTotal: 3, profiles: [] }]);
    t.poller.stop();
  });

  it("polls several hosts independently", async () => {
    const t = setup();
    t.hosts.add("host-bbbb-2");
    t.control.reply = async (hostId) => ok(hostId === "host-bbbb-2" ? 5 : 1);
    t.poller.start();
    await t.advance(10_000);
    expect(t.poller.getAll().map((entry) => [entry.hostId, entry.total])).toEqual([
      ["host-aaaa-1", 1],
      ["host-bbbb-2", 5],
    ]);
    t.poller.stop();
  });
});
