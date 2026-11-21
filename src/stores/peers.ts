import { defineStore } from "pinia";
import { computed, ref, shallowRef } from "vue";
import {
  PEER_DEFAULT_PORT,
  peerConnectSchema,
  type LocalProfileOverview,
  type PeerAttachedHost,
  type PeerPairingResult,
  type PeerStartedPairing,
} from "../../electron/shared/peers.js";
import { userFacingMessage } from "../lib/error-message.js";
import { useNotificationStore } from "./notifications.js";

const COLLAPSED_KEY = "strideterm-peer-host-collapsed";
const PORT_MESSAGE = "Enter a port between 1 and 65535.";
const ADDRESS_MESSAGE = "Enter a host name or an IP address.";

type Bridge = Window["strideterm"];

/** The desktop bridge about THIS machine. Absent on the web and mobile client, never routed through the transport. */
function bridge(): Partial<Bridge> | undefined {
  return typeof window === "undefined" ? undefined : (window.strideterm as Partial<Bridge> | undefined);
}

export function peersBridgeAvailable(): boolean {
  return typeof bridge()?.listPeerHosts === "function";
}

export function parsePeerAddress(
  addressText: string,
  portText: string,
): { ok: true; value: { address: string; port: number } } | { ok: false; error: string } {
  const trimmedPort = portText.trim();
  const port = /^\d{1,5}$/.test(trimmedPort) ? Number(trimmedPort) : Number.NaN;
  const parsed = peerConnectSchema.safeParse({ address: addressText, port });
  if (parsed.success) return { ok: true, value: parsed.data };
  const onPort = parsed.error.issues.some((issue) => issue.path[0] === "port");
  return { ok: false, error: onPort ? PORT_MESSAGE : ADDRESS_MESSAGE };
}

function loadCollapsed(): Record<string, boolean> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(COLLAPSED_KEY) || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) => value === true));
  } catch {
    return {};
  }
}

function saveCollapsed(value: Record<string, boolean>): void {
  try {
    window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify(value));
  } catch {
    // Storage unavailable: the in-memory state still holds for this window.
  }
}

export interface PeerPairingView {
  started: PeerStartedPairing;
  end: PeerPairingResult | null;
}

export const usePeersStore = defineStore("peers", () => {
  const notifications = useNotificationStore();

  const available = ref(peersBridgeAvailable());
  const hosts = shallowRef<PeerAttachedHost[]>([]);
  const localProfiles = shallowRef<LocalProfileOverview[]>([]);
  const loading = ref(false);
  const localProfilesLoading = ref(false);
  const checking = ref<Record<string, number>>({});
  const loadError = ref("");
  const starting = ref(false);
  const pairing = ref<PeerPairingView | null>(null);
  const collapsed = ref<Record<string, boolean>>(loadCollapsed());
  const localAppVersion = computed(() => hosts.value.find((host) => host.localAppVersion)?.localAppVersion || "");

  let watchers = 0;
  let offUpdated: (() => void) | null = null;
  let offPairing: (() => void) | null = null;
  let earlyResults: PeerPairingResult[] = [];

  function refreshAvailability(): boolean {
    available.value = peersBridgeAvailable();
    return available.value;
  }

  async function load(): Promise<void> {
    const list = bridge()?.listPeerHosts;
    if (!list) return;
    loading.value = true;
    try {
      hosts.value = await list();
      loadError.value = "";
    } catch (err) {
      loadError.value = userFacingMessage(err);
      notifications.showError("Could not load attached desktops", err);
    } finally {
      loading.value = false;
    }
  }

  async function loadLocalProfiles(): Promise<void> {
    const overview = bridge()?.getLocalProfilesOverview;
    if (!overview) return;
    localProfilesLoading.value = true;
    try {
      await notifications.runWithToast("Could not load the profiles of this desktop", async () => {
        localProfiles.value = await overview();
      });
    } finally {
      localProfilesLoading.value = false;
    }
  }

  function markChecking(hostId: string, delta: 1 | -1): void {
    const count = (checking.value[hostId] ?? 0) + delta;
    const next = { ...checking.value };
    if (count > 0) next[hostId] = count;
    else delete next[hostId];
    checking.value = next;
  }

  async function refresh(hostId: string, force = false): Promise<boolean> {
    const call = bridge()?.refreshPeerHost;
    if (!call) return false;
    markChecking(hostId, 1);
    try {
      return await notifications.runWithToast(
        force ? "Could not reconnect" : "Could not check the desktop",
        async () => {
          const next = await call(hostId, force ? { force: true } : {});
          if (next) hosts.value = hosts.value.map((host) => (host.id === next.id ? next : host));
          else await load();
        },
      );
    } finally {
      markChecking(hostId, -1);
    }
  }

  async function refreshAll(): Promise<void> {
    await Promise.all(hosts.value.map((host) => refresh(host.id)));
  }

  /** Subscribes to host changes while something shows them; the first caller starts it, the last stops it. */
  function watch(): () => void {
    watchers += 1;
    if (watchers === 1) {
      offUpdated = bridge()?.onPeersUpdated?.(() => void load()) ?? null;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      watchers -= 1;
      if (watchers === 0) {
        offUpdated?.();
        offUpdated = null;
      }
    };
  }

  async function open(): Promise<void> {
    if (!refreshAvailability()) return;
    await load();
    await refreshAll();
  }

  function isCollapsed(hostId: string): boolean {
    return collapsed.value[hostId] === true;
  }

  function setCollapsed(hostId: string, value: boolean): void {
    const next = { ...collapsed.value };
    if (value) next[hostId] = true;
    else delete next[hostId];
    collapsed.value = next;
    saveCollapsed(next);
  }

  async function removeHost(hostId: string): Promise<boolean> {
    const call = bridge()?.removePeerHost;
    if (!call) return false;
    const done = await notifications.runWithToast("Could not disconnect the desktop", async () => {
      await call(hostId);
    });
    if (done) {
      setCollapsed(hostId, false);
      await load();
    }
    return done;
  }

  async function updateAddress(hostId: string, address: string, port: number): Promise<boolean> {
    const call = bridge()?.updatePeerHostAddress;
    if (!call) return false;
    const done = await notifications.runWithToast("Could not change the address", async () => {
      await call({ hostId, address, port });
    });
    if (done) await load();
    return done;
  }

  async function renameHost(hostId: string, label: string): Promise<boolean> {
    const call = bridge()?.renamePeerHost;
    if (!call) return false;
    const done = await notifications.runWithToast("Could not rename the desktop", async () => {
      await call({ hostId, label });
    });
    if (done) await load();
    return done;
  }

  async function openWindow(hostId: string, profileId: string): Promise<boolean> {
    const call = bridge()?.openPeerWindow;
    if (!call) return false;
    return notifications.runWithToast("Could not open a window", async () => {
      await call({ hostId, profileId });
    });
  }

  async function activateProfile(hostId: string, profileId: string): Promise<{ reloaded: boolean } | null> {
    const call = bridge()?.activatePeerProfile;
    if (!call) return null;
    let result: { reloaded: boolean } | null = null;
    await notifications.runWithToast("Could not switch the profile", async () => {
      result = await call({ hostId, profileId });
    });
    return result;
  }

  async function activateLocalProfile(profileId: string): Promise<boolean> {
    const call = bridge()?.activateLocalProfile;
    if (!call) return false;
    return notifications.runWithToast("Could not switch the profile", async () => {
      await call(profileId);
    });
  }

  function applyPairingResult(result: PeerPairingResult): void {
    const current = pairing.value;
    if (!current || current.started.attemptId !== result.attemptId || current.end) return;
    pairing.value = { started: current.started, end: result };
    stopListeningForPairing();
    if (result.state === "approved") {
      if (result.hostId) setCollapsed(result.hostId, false);
      notifications.pushEphemeralToast({ title: `${current.started.hostName} attached`, body: "" });
      void load();
    }
  }

  function stopListeningForPairing(): void {
    offPairing?.();
    offPairing = null;
    earlyResults = [];
  }

  async function startPairing(address: string, port: number): Promise<void> {
    const call = bridge()?.startPeerPairing;
    if (!call || starting.value || (pairing.value && !pairing.value.end)) return;
    pairing.value = null;
    starting.value = true;
    earlyResults = [];
    offPairing?.();
    offPairing =
      bridge()?.onPeerPairingResult?.((result) => {
        if (pairing.value) applyPairingResult(result);
        else earlyResults.push(result);
      }) ?? null;
    try {
      const started = await call({ address, port });
      pairing.value = { started, end: null };
      const early = earlyResults.find((result) => result.attemptId === started.attemptId);
      earlyResults = [];
      if (early) applyPairingResult(early);
    } catch (err) {
      stopListeningForPairing();
      throw err;
    } finally {
      starting.value = false;
    }
  }

  /** Back to the address step. Cancels the attempt at the main process when it is still waiting. */
  async function resetPairing(): Promise<void> {
    const current = pairing.value;
    pairing.value = null;
    stopListeningForPairing();
    if (!current || current.end) return;
    const call = bridge()?.cancelPeerPairing;
    if (!call) return;
    await notifications.runWithToast("Could not cancel the pairing", async () => {
      await call(current.started.attemptId);
    });
  }

  return {
    available,
    hosts,
    localProfiles,
    loading,
    localProfilesLoading,
    loadError,
    starting,
    pairing,
    collapsed,
    localAppVersion,
    defaultPort: PEER_DEFAULT_PORT,
    refreshAvailability,
    load,
    loadLocalProfiles,
    refresh,
    refreshAll,
    checking,
    watch,
    open,
    isCollapsed,
    setCollapsed,
    removeHost,
    updateAddress,
    renameHost,
    openWindow,
    activateProfile,
    activateLocalProfile,
    startPairing,
    resetPairing,
  };
});
