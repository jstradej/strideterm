import { describe, it, expect, beforeEach, vi } from "vitest";
import { flushPromises } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";
import { useAppStore } from "../stores/app.js";
import { useNotificationStore } from "../stores/notifications.js";
import { useNotificationCapture } from "./useNotificationCapture.js";
import { fireNotificationAlert } from "./useNotificationSound.js";

vi.mock("./useNotificationSound.js", () => ({
  fireNotificationAlert: vi.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;

const STARTED = {
  deviceId: "dev-1",
  name: "Pixel 8",
  profileId: "default",
  profileName: "Default",
  startedAt: Date.parse("2026-09-30T10:00:00.000Z"),
};

describe("a phone session starting becomes one Notification Center entry", () => {
  let emitStarted: (event: AnyApi) => void;
  let emitStatus: (event: AnyApi) => void;

  beforeEach(() => {
    setActivePinia(createPinia());
    window.localStorage.removeItem("strideterm-notifications-v2");
    window.localStorage.removeItem("strideterm-notifications-pinned");
    (window as AnyApi).strideterm = { startupFlags: { windowId: "win-1" } };
    vi.mocked(fireNotificationAlert).mockClear();
    emitStarted = () => {};
    emitStatus = () => {};
    const transport = {
      isRemote: false,
      getState: vi.fn(() => new Promise(() => {})),
      onStateUpdated: vi.fn(),
      onConnectionState: vi.fn(),
      onApprovalRecorded: vi.fn(),
      queryApprovalAuditLog: vi.fn(async () => ({ entries: [], total: 0 })),
      onMobileSessionStarted: (handler: (event: AnyApi) => void) => {
        emitStarted = handler;
      },
      onMobileStatus: (handler: (event: AnyApi) => void) => {
        emitStatus = handler;
      },
    };
    useAppStore().init(transport as AnyApi);
    useNotificationCapture(transport as AnyApi);
  });

  it("adds exactly one informational, history-only entry with the agreed wording", () => {
    const notifications = useNotificationStore();
    emitStarted(STARTED);

    expect(notifications.sessions).toHaveLength(1);
    const session = notifications.sessions[0]!;
    expect(session.events).toHaveLength(1);
    expect(session.events[0]).toMatchObject({
      title: "Phone connected",
      body: "Pixel 8 opened a session on profile Default",
      kind: "info",
      // Tier 3 is "history only": no sound, no OS popup.
      tier: 3,
      urgency: "normal",
    });
    expect(session.category).toBe("mobile");
    expect(session.meta).toMatchObject({ profileId: "default", deviceId: "dev-1" });
    // No sound or OS notification, no toast.
    expect(fireNotificationAlert).not.toHaveBeenCalled();
    expect(notifications.latestToast).toBeNull();
  });

  it("does not duplicate the entry when the same session start is delivered twice", () => {
    const notifications = useNotificationStore();
    emitStarted(STARTED);
    emitStarted({ ...STARTED });
    expect(notifications.sessions.flatMap((session) => session.events)).toHaveLength(1);
  });

  it("a later session from the same phone is a second entry in the same thread", () => {
    const notifications = useNotificationStore();
    emitStarted(STARTED);
    emitStarted({ ...STARTED, startedAt: STARTED.startedAt + 3_600_000 });
    expect(notifications.sessions).toHaveLength(1);
    expect(notifications.sessions[0]!.events).toHaveLength(2);
  });

  it("adds nothing when the phone list empties (no entry on end)", () => {
    const notifications = useNotificationStore();
    emitStarted(STARTED);
    emitStatus({ connectedDevices: [] });
    expect(notifications.sessions.flatMap((session) => session.events)).toHaveLength(1);
  });

  it("keeps the entry in a window on another profile, stamped with the phone's profile", () => {
    const notifications = useNotificationStore();
    emitStarted({ ...STARTED, profileId: "work", profileName: "Work" });
    expect(notifications.sessions[0]!.meta).toMatchObject({ profileId: "work" });
  });
});

describe("the app store follows mobile:status for the connected-phone list", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    (window as AnyApi).strideterm = { startupFlags: { windowId: "win-1" } };
  });

  function makeTransport(overrides: AnyApi = {}) {
    let statusHandler: (event: AnyApi) => void = () => {};
    const transport = {
      isRemote: false,
      getState: vi.fn(() => new Promise(() => {})),
      onStateUpdated: vi.fn(),
      onConnectionState: vi.fn(),
      onMobileStatus: (handler: (event: AnyApi) => void) => {
        statusHandler = handler;
      },
      refreshMobileConnectionHealth: vi.fn(async () => ({ health: null, quota: null })),
      ...overrides,
    };
    return { transport, emitStatus: (event: AnyApi) => statusHandler(event) };
  }

  const PHONE = { deviceId: "dev-1", name: "Pixel 8", profileId: "default", startedAt: 1000 };

  it("a renderer that loads while a phone is connected shows it without waiting for an event", async () => {
    const { transport } = makeTransport({
      getMobileRelayStatus: vi.fn(async () => ({ enabled: false, state: "off", connectedDevices: [PHONE] })),
    });
    const store = useAppStore();
    store.init(transport as AnyApi);
    await flushPromises();
    expect(store.mobileConnectedDevices).toEqual([PHONE]);
  });

  it("mobile:status replaces the list, drops malformed entries, and does not trigger a health round trip", async () => {
    const { transport, emitStatus } = makeTransport();
    const store = useAppStore();
    store.init(transport as AnyApi);
    await flushPromises();

    emitStatus({ connectedDevices: [PHONE] });
    expect(store.mobileConnectedDevices).toEqual([PHONE]);
    expect(transport.refreshMobileConnectionHealth).not.toHaveBeenCalled();

    emitStatus({ connectedDevices: [{ deviceId: 7 }] });
    expect(store.mobileConnectedDevices).toEqual([]);

    emitStatus({ connectedDevices: [PHONE] });
    emitStatus({ connectedDevices: [] });
    expect(store.mobileConnectedDevices).toEqual([]);
  });

  it("other mobile:status payloads leave the list alone", async () => {
    const { transport, emitStatus } = makeTransport();
    const store = useAppStore();
    store.init(transport as AnyApi);
    await flushPromises();

    emitStatus({ connectedDevices: [PHONE] });
    emitStatus({ running: true });
    expect(store.mobileConnectedDevices).toEqual([PHONE]);
  });
});
