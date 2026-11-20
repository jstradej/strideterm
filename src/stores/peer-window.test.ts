import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computed, nextTick, shallowRef } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createPeerWindowSession } from "./peer-window.js";
import { useNotificationStore } from "./notifications.js";
import { setWindowBackend } from "../window-backend.js";
import type { PeerAttachedHost, WindowBackend } from "../../electron/shared/peers.js";
import type { StatePayload } from "../../electron/shared/types/state.js";
import type { Transport } from "../transport.js";

const backend: Extract<WindowBackend, { kind: "peer" }> = {
  kind: "peer",
  hostId: "host-0001",
  hostLabel: "Studio Mac",
  remoteProfileId: "work",
  clientId: "peer-window-0001",
  terminalFontSize: 13,
};

function host(state: PeerAttachedHost["state"], extra: Partial<PeerAttachedHost> = {}): PeerAttachedHost {
  return {
    id: backend.hostId,
    label: backend.hostLabel,
    address: "10.0.0.5",
    port: 43124,
    hostPublicKey: "k",
    pairedAt: 1,
    state,
    hostAppVersion: "2.0.0",
    localAppVersion: "2.0.0",
    profiles: [],
    checkedAt: 1,
    ...extra,
  };
}

function payloadWith(activeProfile: string, profileIds = ["default", "work"]): StatePayload {
  return {
    appState: { profiles: profileIds.map((id) => ({ id, name: id })), workspaces: [], windowSlots: [] },
    remoteClient: { profileId: activeProfile },
  } as unknown as StatePayload;
}

function setup() {
  const payload = shallowRef<StatePayload | null>(null);
  const myActiveProfileId = computed<string | null>(
    () =>
      (payload.value as unknown as { remoteClient?: { profileId?: string } } | null)?.remoteClient?.profileId ?? null,
  );
  const suspendConnection = vi.fn();
  const activateProfile = vi.fn().mockResolvedValue(undefined);
  const setIssue = vi.fn();
  const clearIssue = vi.fn();
  const session = createPeerWindowSession({
    backend,
    api: { suspendConnection } as unknown as Transport,
    payload,
    myActiveProfileId,
    activateProfile,
    setIssue,
    clearIssue,
  });
  return { payload, session, suspendConnection, activateProfile, setIssue, clearIssue };
}

async function settle(): Promise<void> {
  await nextTick();
  await Promise.resolve();
  await Promise.resolve();
}

describe("peer window session", () => {
  const preload = {
    logRenderer: vi.fn(),
    refreshPeerHost: vi.fn(),
    setPeerWindowProfile: vi.fn(),
  };

  beforeEach(() => {
    setActivePinia(createPinia());
    setWindowBackend(backend);
    preload.refreshPeerHost.mockReset();
    preload.setPeerWindowProfile.mockReset().mockResolvedValue(true);
    preload.logRenderer.mockReset();
    (window as unknown as Record<string, unknown>).strideterm = preload;
  });
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).strideterm;
    setWindowBackend({ kind: "local" });
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe("profile", () => {
    it("moves the first payload from the host fallback profile to the profile the window was bound to", async () => {
      const { payload, session, activateProfile } = setup();
      session.watchProfile();
      payload.value = payloadWith("default");
      await nextTick();

      expect(activateProfile).toHaveBeenCalledWith("work");
      expect(preload.setPeerWindowProfile).not.toHaveBeenCalled();

      payload.value = payloadWith("work");
      await nextTick();
      expect(preload.setPeerWindowProfile).toHaveBeenCalledWith("work");
    });

    it.each([["resolves"], ["rejects"]])(
      "reports the move to the bound profile as pending until the activation %s",
      async (how) => {
        const { payload, session, activateProfile } = setup();
        let release!: { resolve: () => void; reject: (_reason: unknown) => void };
        activateProfile.mockReturnValue(
          new Promise<void>((resolve, reject) => {
            release = { resolve, reject };
          }),
        );
        expect(session.profilePending.value).toBe(false);
        session.watchProfile();
        payload.value = payloadWith("default");
        await nextTick();
        expect(session.profilePending.value).toBe(true);

        if (how === "resolves") release.resolve();
        else release.reject(new Error("boom"));
        await settle();
        expect(session.profilePending.value).toBe(false);
        if (how === "rejects") {
          const titles = useNotificationStore().sessions.flatMap((entry) => entry.events.map((event) => event.title));
          expect(titles).toContain("Could not open the profile");
        }
      },
    );

    it("is not pending when the host already opened the bound profile or the profile is gone", async () => {
      const { payload, session } = setup();
      session.watchProfile();
      payload.value = payloadWith("work");
      await nextTick();
      expect(session.profilePending.value).toBe(false);

      const gone = setup();
      gone.session.watchProfile();
      gone.payload.value = payloadWith("default", ["default"]);
      await nextTick();
      expect(gone.session.profilePending.value).toBe(false);
    });

    it("does not activate anything when the host already opened the bound profile", async () => {
      const { payload, session, activateProfile } = setup();
      session.watchProfile();
      payload.value = payloadWith("work");
      await nextTick();
      expect(activateProfile).not.toHaveBeenCalled();
    });

    it("stays where the host put the window, says so and tells the main process when the profile is gone", async () => {
      const { payload, session, activateProfile } = setup();
      session.watchProfile();
      payload.value = payloadWith("default", ["default"]);
      await nextTick();

      expect(activateProfile).not.toHaveBeenCalled();
      expect(preload.setPeerWindowProfile).toHaveBeenCalledWith("default");
      expect(useNotificationStore().persistentToasts.map((toast) => toast.title)).toContain(
        "That profile is no longer on the other computer",
      );
    });

    it("reports every later change of the remote profile", async () => {
      const { payload, session } = setup();
      session.watchProfile();
      payload.value = payloadWith("work");
      await nextTick();
      payload.value = payloadWith("default");
      await nextTick();
      expect(preload.setPeerWindowProfile).toHaveBeenLastCalledWith("default");
    });

    it("shows an error when moving to the bound profile fails", async () => {
      const { payload, session, activateProfile } = setup();
      activateProfile.mockRejectedValue(new Error("boom"));
      session.watchProfile();
      payload.value = payloadWith("default");
      await settle();

      const titles = useNotificationStore().sessions.flatMap((entry) => entry.events.map((event) => event.title));
      expect(titles).toContain("Could not open the profile");
    });

    it("logs, and does not throw, when the main process refuses the profile record", async () => {
      preload.setPeerWindowProfile.mockRejectedValue(new Error("refused"));
      const { payload, session } = setup();
      session.watchProfile();
      payload.value = payloadWith("work");
      await settle();
      payload.value = payloadWith("default");
      await settle();
      expect(preload.logRenderer).toHaveBeenCalledWith("warn", expect.stringContaining("profile"), expect.anything());
    });
  });

  describe("connection", () => {
    it("names the host in the banner of a short disconnect and keeps the countdown", () => {
      const { session, setIssue } = setup();
      preload.refreshPeerHost.mockResolvedValue(host("offline"));
      session.onConnectionState({
        connected: false,
        reconnecting: true,
        message: "The connection to the other computer was lost. Reconnecting in 4s...",
        reconnectAt: 123,
      });

      expect(setIssue).toHaveBeenCalledWith("Connection to Studio Mac lost. Reconnecting in 4s...", "", 123);
      expect(session.failure.value).toBeNull();
    });

    it("says the host cannot be reached for a request that failed while the socket is still retrying", () => {
      const { session, setIssue } = setup();
      preload.refreshPeerHost.mockResolvedValue(host("offline"));
      session.onConnectionState({ connected: false, message: "Cannot reach the other computer right now." });
      expect(setIssue.mock.calls[0][0]).toBe("Cannot reach Studio Mac right now.");
    });

    it("clears the banner once connected", () => {
      const { session, clearIssue } = setup();
      session.onConnectionState({ connected: true });
      expect(clearIssue).toHaveBeenCalled();
    });

    it("stops reconnecting and shows the not-paired screen when a disconnect turns out to be a removed pairing", async () => {
      preload.refreshPeerHost.mockResolvedValue(host("not-paired"));
      const { session, suspendConnection, clearIssue } = setup();

      session.onConnectionState({ connected: false, reconnecting: true, message: "x" });
      await vi.waitFor(() => expect(session.failure.value).not.toBeNull());

      expect(session.failure.value?.reason).toBe("not-paired");
      expect(session.failure.value?.title).toContain("Studio Mac");
      expect(suspendConnection).toHaveBeenCalledOnce();
      expect(clearIssue).toHaveBeenCalled();
    });

    it("keeps reconnecting when the host merely does not answer", async () => {
      preload.refreshPeerHost.mockResolvedValue(host("offline"));
      const { session, suspendConnection } = setup();
      session.onConnectionState({ connected: false, reconnecting: true, message: "x" });
      await settle();
      expect(preload.refreshPeerHost).toHaveBeenCalled();
      expect(session.failure.value).toBeNull();
      expect(suspendConnection).not.toHaveBeenCalled();
    });

    it.each([
      ["not-paired", host("not-paired"), "no longer accepts"],
      ["wrong-host", host("wrong-host"), "another strIDEterm"],
      ["version-mismatch", host("version-mismatch", { hostAppVersion: "2.1.0", localAppVersion: "2.0.3" }), "2.1.0"],
      ["offline", host("offline"), "cannot be reached"],
      ["session-ended", host("online"), "was closed"],
    ])("explains %s when the transport gives up", async (reason, answer, text) => {
      preload.refreshPeerHost.mockResolvedValue(answer);
      const { session, suspendConnection } = setup();

      session.onConnectionState({ connected: false, reconnecting: false, message: "Session ended." });
      await vi.waitFor(() => expect(session.failure.value).not.toBeNull());

      expect(session.failure.value?.reason).toBe(reason);
      expect(`${session.failure.value?.title} ${session.failure.value?.message}`).toContain(text);
      expect(suspendConnection).toHaveBeenCalledOnce();
    });

    it("names both versions on a version mismatch", async () => {
      preload.refreshPeerHost.mockResolvedValue(
        host("version-mismatch", { hostAppVersion: "2.1.0", localAppVersion: "2.0.3" }),
      );
      const { session } = setup();
      await session.onBootstrapFailure(new Error("x"));
      expect(session.failure.value?.message).toContain("2.1.0");
      expect(session.failure.value?.message).toContain("2.0.3");
    });

    it("shows the unreachable screen for a first load that failed, naming the host and never the web wording", async () => {
      preload.refreshPeerHost.mockResolvedValue(host("offline"));
      const { session } = setup();

      await session.onBootstrapFailure(Object.assign(new Error("Cannot reach"), { statusCode: 0 }));

      expect(session.failure.value?.reason).toBe("offline");
      const text = `${session.failure.value?.title} ${session.failure.value?.message}`;
      expect(text).toContain("Studio Mac");
      expect(text).not.toMatch(/token|reload|page/i);
    });

    it("falls back to unreachable when the host cannot be asked at all", async () => {
      preload.refreshPeerHost.mockRejectedValue(new Error("ipc"));
      const { session } = setup();
      await session.onBootstrapFailure(new Error("x"));
      expect(session.failure.value?.reason).toBe("offline");
    });
  });

  describe("reconnect", () => {
    it("forces the check and reloads the window once the host answers", async () => {
      const reload = vi.fn();
      vi.stubGlobal("location", { ...window.location, reload });
      preload.refreshPeerHost.mockResolvedValue(host("online"));
      const { session } = setup();

      await session.reconnect();

      expect(preload.refreshPeerHost).toHaveBeenCalledWith(backend.hostId, { force: true });
      expect(reload).toHaveBeenCalled();
    });

    it("updates the message and stays when the host is still unreachable", async () => {
      const reload = vi.fn();
      vi.stubGlobal("location", { ...window.location, reload });
      preload.refreshPeerHost.mockResolvedValue(host("offline"));
      const { session } = setup();

      await session.reconnect();

      expect(reload).not.toHaveBeenCalled();
      expect(session.failure.value?.reason).toBe("offline");
    });

    it("says so when the host is no longer attached", async () => {
      preload.refreshPeerHost.mockResolvedValue(null);
      const { session } = setup();
      await session.reconnect();
      expect(session.failure.value?.title).toContain("no longer attached");
    });

    it("rejects so the caller can toast when the check itself fails", async () => {
      preload.refreshPeerHost.mockRejectedValue(new Error("ipc down"));
      const { session } = setup();
      await expect(session.reconnect()).rejects.toThrow("ipc down");
    });
  });
});
