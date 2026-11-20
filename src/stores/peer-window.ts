import { ref, watch, type ComputedRef, type ShallowRef } from "vue";
import type { PeerAttachedHost } from "../../electron/shared/peers.js";
import type { StatePayload } from "../../electron/shared/types/state.js";
import { rlog } from "../lib/renderer-log.js";
import {
  isFinalPeerReason,
  peerDisconnectMessage,
  peerFailureFrom,
  type PeerFailure,
  type PeerWindowBackend,
} from "../peer-link.js";
import type { Transport } from "../transport.js";
import { useNotificationStore } from "./notifications.js";

/** The link probes during a short disconnect are spaced out: the transport's own backoff already retries. */
const PROBE_INTERVAL_MS = 10_000;

interface ConnectionStateLike {
  connected?: boolean;
  message?: string;
  reconnecting?: boolean;
  reconnectAt?: unknown;
}

type PeerPreload = {
  refreshPeerHost?: (hostId: string, options?: { force?: boolean }) => Promise<PeerAttachedHost | null>;
  setPeerWindowProfile?: (profileId: string) => Promise<boolean>;
};

function preload(): PeerPreload {
  return ((window as unknown as { strideterm?: PeerPreload }).strideterm ?? {}) as PeerPreload;
}

interface PeerWindowSessionContext {
  backend: PeerWindowBackend;
  api: Transport;
  payload: ShallowRef<StatePayload | null>;
  myActiveProfileId: ComputedRef<string | null>;
  activateProfile: (profileId: string) => Promise<void>;
  setIssue: (message: string, hint?: string, reconnectAt?: unknown) => void;
  clearIssue: () => void;
}

/**
 * Everything that differs in a window attached to another desktop: how a lost connection is told and when it
 * becomes a screen of its own, and which remote profile the window reports to the main process.
 */
export function createPeerWindowSession(ctx: PeerWindowSessionContext) {
  const { backend } = ctx;
  const failure = ref<PeerFailure | null>(null);
  /** The window was opened on the host's fallback profile and is moving to the one it was bound to. */
  const profilePending = ref(false);
  let probing = false;
  let lastProbeAt = 0;

  async function probe(force: boolean): Promise<PeerAttachedHost | null | undefined> {
    const refresh = preload().refreshPeerHost;
    if (!refresh) return undefined;
    try {
      return await refresh(backend.hostId, force ? { force: true } : undefined);
    } catch (err) {
      rlog("warn", "[peer] could not check the host", { hostId: backend.hostId, error: (err as Error)?.message });
      return undefined;
    }
  }

  function fallbackFor(host: PeerAttachedHost | null | undefined): "offline" | "session-ended" {
    return host?.state === "online" ? "session-ended" : "offline";
  }

  /** The window stops talking to the host: nothing it would retry changes, and the screen asks the user. */
  function enterFailure(next: PeerFailure): void {
    failure.value = next;
    ctx.clearIssue();
    ctx.api.suspendConnection?.();
    rlog("warn", "[peer] window cannot reach its host", { hostId: backend.hostId, reason: next.reason });
  }

  async function showFailure(): Promise<void> {
    const host = await probe(false);
    if (failure.value) return;
    enterFailure(peerFailureFrom(host ?? null, backend.hostLabel, fallbackFor(host)));
  }

  async function probeDuringDisconnect(): Promise<void> {
    if (probing || failure.value) return;
    const now = Date.now();
    if (now - lastProbeAt < PROBE_INTERVAL_MS) return;
    lastProbeAt = now;
    probing = true;
    try {
      const host = await probe(false);
      if (failure.value || !host) return;
      const next = peerFailureFrom(host, backend.hostLabel, "offline");
      if (isFinalPeerReason(next.reason)) enterFailure(next);
    } finally {
      probing = false;
    }
  }

  function onConnectionState(connection: ConnectionStateLike): void {
    if (connection.connected) {
      failure.value = null;
      ctx.clearIssue();
      return;
    }
    if (failure.value) return;
    if (connection.reconnecting === false) {
      void showFailure();
      return;
    }
    ctx.setIssue(
      peerDisconnectMessage(backend.hostLabel, connection.message || "", connection.reconnecting === true),
      "",
      connection.reconnectAt,
    );
    void probeDuringDisconnect();
  }

  /** The first state could not be loaded. */
  function onBootstrapFailure(error: unknown): Promise<void> {
    rlog("warn", "[peer] first state load failed", {
      hostId: backend.hostId,
      error: (error as Error)?.message,
      status: (error as { statusCode?: number })?.statusCode,
    });
    return showFailure();
  }

  /**
   * The user's Reconnect. Lifts the "no longer paired" latch and tries the network once; a host that answers
   * reloads the window, anything else updates the reason on screen. A throw reaches the caller's toast.
   */
  async function reconnect(): Promise<void> {
    const refresh = preload().refreshPeerHost;
    if (!refresh) throw new Error("Reconnecting is not available in this window.");
    const host = await refresh(backend.hostId, { force: true });
    if (host?.state === "online") {
      window.location.reload();
      return;
    }
    if (!host) {
      failure.value = {
        reason: "not-paired",
        title: `${backend.hostLabel} is no longer attached to this desktop`,
        message: "Attach it again from Profiles, or switch to a local profile.",
      };
      return;
    }
    failure.value = peerFailureFrom(host, backend.hostLabel, "offline");
  }

  let profileSettled = false;
  function reportProfile(profileId: string): void {
    const report = preload().setPeerWindowProfile;
    if (!report) return;
    report(profileId).catch((err: unknown) => {
      rlog("warn", "[peer] could not record the window's profile", {
        profileId,
        error: (err as Error)?.message,
      });
    });
  }

  /**
   * The remote client's profile is learned in one place, `myActiveProfileId`. The host opens a new client on its
   * fallback profile, so the first value is moved to the one this window was bound to, if the host still has it.
   */
  function watchProfile(): void {
    watch(
      () => (ctx.payload.value ? ctx.myActiveProfileId.value : null),
      (profileId) => {
        if (!profileId) return;
        if (profileSettled) {
          reportProfile(profileId);
          return;
        }
        profileSettled = true;
        if (profileId === backend.remoteProfileId) return;
        const profiles = (ctx.payload.value?.appState?.profiles ?? []) as Array<{ id?: string }>;
        if (profiles.some((profile) => profile.id === backend.remoteProfileId)) {
          profilePending.value = true;
          ctx
            .activateProfile(backend.remoteProfileId)
            .catch((err: unknown) => {
              useNotificationStore().showError("Could not open the profile", err);
            })
            .finally(() => {
              profilePending.value = false;
            });
          return;
        }
        useNotificationStore().pushEphemeralToast({
          title: "That profile is no longer on the other computer",
          body: `${backend.hostLabel} is showing another profile instead.`,
          kind: "warning",
        });
        reportProfile(profileId);
      },
      { immediate: true },
    );
  }

  return { failure, profilePending, onConnectionState, onBootstrapFailure, reconnect, watchProfile };
}

export type PeerWindowSession = ReturnType<typeof createPeerWindowSession>;
