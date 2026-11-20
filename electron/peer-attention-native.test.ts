import { describe, expect, it } from "vitest";
import {
  computeAppBadge,
  peerAttentionBody,
  pickPeerWindowToFocus,
  shouldNotifyPeerAttention,
  topAttentionProfile,
} from "./peer-attention-native.js";

describe("computeAppBadge", () => {
  it("is the local total with no attached host", () => {
    expect(computeAppBadge(4, [])).toBe(4);
  });

  it("counts the polled total once per host, not the sum of its windows", () => {
    expect(computeAppBadge(1, [{ polledTotal: 5, windowCounts: [2, 2] }])).toBe(6);
  });

  it("counts a host with no open window by its polled total", () => {
    expect(computeAppBadge(0, [{ polledTotal: 3, windowCounts: [] }])).toBe(3);
  });

  it("falls back to the largest window count before the first poll", () => {
    expect(computeAppBadge(2, [{ polledTotal: null, windowCounts: [1, 4, 2] }])).toBe(6);
    expect(computeAppBadge(2, [{ polledTotal: null, windowCounts: [] }])).toBe(2);
  });

  it("trusts a polled zero over stale window numbers", () => {
    expect(computeAppBadge(0, [{ polledTotal: 0, windowCounts: [3] }])).toBe(0);
  });

  it("adds hosts together", () => {
    expect(
      computeAppBadge(1, [
        { polledTotal: 2, windowCounts: [] },
        { polledTotal: null, windowCounts: [3] },
      ]),
    ).toBe(6);
  });
});

describe("shouldNotifyPeerAttention", () => {
  const base = { previousTotal: 1, total: 2, hostWindowFocused: false };
  it("notifies on a rise nobody is looking at", () => {
    expect(shouldNotifyPeerAttention(base)).toBe(true);
    expect(shouldNotifyPeerAttention({ ...base, previousTotal: 0 })).toBe(true);
  });
  it("stays quiet for the same count, a fall and the first answer", () => {
    expect(shouldNotifyPeerAttention({ ...base, total: 1 })).toBe(false);
    expect(shouldNotifyPeerAttention({ ...base, total: 0 })).toBe(false);
    expect(shouldNotifyPeerAttention({ ...base, previousTotal: null })).toBe(false);
  });
  it("stays quiet while a window of that host has focus", () => {
    expect(shouldNotifyPeerAttention({ ...base, hostWindowFocused: true })).toBe(false);
  });
});

describe("notification wording and click target", () => {
  it("handles the singular", () => {
    expect(peerAttentionBody(1)).toBe("1 item needs your attention");
    expect(peerAttentionBody(3)).toBe("3 items need your attention");
  });

  it("picks the profile with the most alerts, ignoring empty ones", () => {
    expect(topAttentionProfile([])).toBeNull();
    expect(topAttentionProfile([{ profileId: "a", count: 0 }])).toBeNull();
    expect(
      topAttentionProfile([
        { profileId: "a", count: 1 },
        { profileId: "b", count: 4 },
      ]),
    ).toBe("b");
  });

  it("prefers the window on the profile with the highest count, and returns null when none is open", () => {
    const profiles = [
      { profileId: "a", count: 1 },
      { profileId: "b", count: 4 },
    ];
    expect(
      pickPeerWindowToFocus(
        [
          { id: "w1", remoteProfileId: "a" },
          { id: "w2", remoteProfileId: "b" },
        ],
        profiles,
      ),
    ).toBe("w2");
    expect(pickPeerWindowToFocus([{ id: "w1", remoteProfileId: "zzz" }], profiles)).toBe("w1");
    expect(pickPeerWindowToFocus([], profiles)).toBeNull();
  });
});
