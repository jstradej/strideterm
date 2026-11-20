import { describe, expect, test } from "vitest";
import {
  isChannelAllowedInPeerWindow,
  isEventAllowedInPeerWindow,
  PEER_WINDOW_ALLOWED_CHANNELS,
  PEER_WINDOW_ALLOWED_EVENTS,
} from "./peer-window-channels.js";

describe("peer window event allowlist", () => {
  test("the peer link and the peer management events pass", () => {
    for (const channel of [
      "peer:ws:state",
      "peer:ws:message",
      "peers:updated",
      "peers:pairing-progress",
      "peers:pairing-result",
    ]) {
      expect(isEventAllowedInPeerWindow(channel), channel).toBe(true);
    }
  });

  test("the window-level events pass", () => {
    for (const channel of PEER_WINDOW_ALLOWED_EVENTS) expect(isEventAllowedInPeerWindow(channel), channel).toBe(true);
    for (const channel of [
      "app:update-status-changed",
      "window:visibility",
      "window:confirm-close-request",
      "shortcut:new-window",
    ]) {
      expect(isEventAllowedInPeerWindow(channel), channel).toBe(true);
    }
  });

  test("this machine's data events do not", () => {
    for (const channel of [
      "state:updated",
      "terminal:data",
      "terminal:exit",
      "git:push-progress",
      "ssh:state",
      "docker:logs:write",
      "approval:recorded",
      "operation:finished",
      "sandbox:denied",
      "mobile:status",
      "account:updated",
      "notification:target-removed",
      "peersx:updated",
    ]) {
      expect(isEventAllowedInPeerWindow(channel), channel).toBe(false);
    }
  });
});

describe("peer window channel allowlist", () => {
  test("the font size channel is allowed, host management and local data are not", () => {
    expect(isChannelAllowedInPeerWindow("peers:window:font-size")).toBe(true);
    expect(isChannelAllowedInPeerWindow("shell:open-external")).toBe(true);
    for (const channel of ["peers:host:get", "state:get", "diff:popout:open", "file:popout:open", "terminal:input"]) {
      expect(isChannelAllowedInPeerWindow(channel), channel).toBe(false);
    }
    expect([...PEER_WINDOW_ALLOWED_CHANNELS].some((channel) => channel.startsWith("peers:host:"))).toBe(false);
  });
});
