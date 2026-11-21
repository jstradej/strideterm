import { describe, expect, test } from "vitest";
import {
  isChannelAllowedInPeerWindow,
  isEventAllowedInPeerWindow,
  PEER_WINDOW_ALLOWED_CHANNELS,
  PEER_WINDOW_ALLOWED_EVENTS,
  PEER_WINDOW_EVENT_PREFIXES,
} from "./peer-window-channels.js";
import {
  PEER_ATTACHMENT_COPY_FINISHED_CHANNEL,
  PEER_ATTACHMENT_COPY_PROGRESS_CHANNEL,
} from "./peer-attachment-copy-events.js";
import { PEER_HOST_NOTE_CHANGED_CHANNEL } from "./peer-host-note-events.js";

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

  test("a copy into a local workspace, its end and its progress, is never pushed into a window attached to another desktop", () => {
    for (const channel of [PEER_ATTACHMENT_COPY_FINISHED_CHANNEL, PEER_ATTACHMENT_COPY_PROGRESS_CHANNEL]) {
      expect(isEventAllowedInPeerWindow(channel), channel).toBe(false);
      expect(
        PEER_WINDOW_EVENT_PREFIXES.some((prefix) => channel.startsWith(prefix)),
        channel,
      ).toBe(false);
      expect(PEER_WINDOW_ALLOWED_EVENTS.has(channel), channel).toBe(false);
    }
  });

  test("a host's note changing is never pushed into a window attached to another desktop", () => {
    expect(isEventAllowedInPeerWindow(PEER_HOST_NOTE_CHANGED_CHANNEL)).toBe(false);
    expect(PEER_WINDOW_EVENT_PREFIXES.some((prefix) => PEER_HOST_NOTE_CHANGED_CHANNEL.startsWith(prefix))).toBe(false);
    expect(PEER_WINDOW_ALLOWED_EVENTS.has(PEER_HOST_NOTE_CHANGED_CHANNEL)).toBe(false);
  });

  test("a note popout is a local window: its channels are refused in a window attached to another desktop", () => {
    for (const channel of ["notes:popout:open", "notes:popout:get-init"]) {
      expect(isChannelAllowedInPeerWindow(channel), channel).toBe(false);
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
    for (const channel of [
      "peers:client:global-note:get",
      "peers:client:global-note:save",
      "peers:client:global-note:undo",
    ]) {
      expect(isChannelAllowedInPeerWindow(channel), channel).toBe(false);
    }
    for (const channel of ["peers:host:get", "state:get", "diff:popout:open", "file:popout:open", "terminal:input"]) {
      expect(isChannelAllowedInPeerWindow(channel), channel).toBe(false);
    }
    expect([...PEER_WINDOW_ALLOWED_CHANNELS].some((channel) => channel.startsWith("peers:host:"))).toBe(false);
  });
});
