import { defineStore } from "pinia";
import { ref, shallowRef } from "vue";
import type { PeerAttachmentCopyRequest, PeerAttachmentItem } from "../../electron/shared/peers.js";
import {
  peerAttachmentCopyRunSchema,
  type PeerAttachmentCopyProgress,
  type PeerAttachmentCopyRun,
} from "../../electron/shared/peer-attachment-copy-events.js";
import { fireNotificationAlert } from "../composables/useNotificationSound.js";
import { absoluteAttachmentPath } from "../lib/attachment-path.js";
import { userFacingMessage } from "../lib/error-message.js";
import type { CallableTransport, Transport } from "../transport.js";
import { useNotificationStore } from "./notifications.js";
import { isUnsupportedPeerFeature } from "./peers.js";

/**
 * Copies this client has already been told about, newest last. Per client (browser storage), bounded, and separate
 * from the notification history: removing an entry must not make the payload's replayed last result look new again.
 */
const NOTIFIED_KEY = "strideterm-peer-attachment-copies-notified";
const NOTIFIED_MAX = 100;
const COLLAPSED_KEY = "strideterm-peer-attachments-collapsed";
const RUNS_MEMORY = 100;

function loadNotified(): string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(NOTIFIED_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function rememberNotified(copyId: string): void {
  try {
    const ids = [...loadNotified().filter((id) => id !== copyId), copyId];
    window.localStorage.setItem(NOTIFIED_KEY, JSON.stringify(ids.slice(-NOTIFIED_MAX)));
  } catch {
    // Storage unavailable: this renderer's in-memory set still holds for its lifetime.
  }
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

export interface PeerAttachmentListing {
  items: PeerAttachmentItem[];
  truncated: boolean;
  loading: boolean;
  error: string;
  /** Set instead of `error` when the host is too old to share attachments: nothing failed, there is nothing to show. */
  unsupported: string;
  loadedAt: number;
}

export function hasPeerAttachmentCopy(api: Partial<Transport> | null | undefined): boolean {
  return (
    typeof api?.listPeerAttachments === "function" &&
    typeof api.startPeerAttachmentCopy === "function" &&
    typeof api.cancelPeerAttachmentCopy === "function"
  );
}

export function isPeerAttachmentCopyTerminal(run: PeerAttachmentCopyRun): boolean {
  return run.state === "succeeded" || run.state === "failed" || run.state === "cancelled";
}

export const usePeerAttachmentCopiesStore = defineStore("peer-attachment-copies", () => {
  const runs = shallowRef<Record<string, PeerAttachmentCopyRun>>({});
  const listings = shallowRef<Record<string, PeerAttachmentListing>>({});
  const collapsed = ref<Record<string, boolean>>(loadCollapsed());
  const profileId = ref<string | null>(null);
  let api: Transport | null = null;
  let bound = false;
  let workspaceRoot: (workspaceId: string) => string = () => "";
  const notifiedInMemory = new Set<string>();
  const waiters = new Map<string, Array<(run: PeerAttachmentCopyRun) => void>>();

  function remember(run: PeerAttachmentCopyRun): void {
    const next = { ...runs.value, [run.copyId]: run };
    const ids = Object.keys(next);
    if (ids.length > RUNS_MEMORY) {
      const finished = ids
        .map((id) => next[id]!)
        .filter(isPeerAttachmentCopyTerminal)
        .sort((a, b) => Date.parse(a.finishedAt ?? "") - Date.parse(b.finishedAt ?? ""));
      for (const item of finished.slice(0, ids.length - RUNS_MEMORY)) delete next[item.copyId];
    }
    runs.value = next;
    if (isPeerAttachmentCopyTerminal(run)) for (const resolve of waiters.get(run.copyId)?.splice(0) ?? []) resolve(run);
  }

  /** One Notification Center entry per copy per client: a success of the profile in view, or its failure. */
  function notifyOutcome(run: PeerAttachmentCopyRun): void {
    if (run.state === "cancelled" || !isPeerAttachmentCopyTerminal(run)) return;
    if (run.profileId !== profileId.value) return;
    if (notifiedInMemory.has(run.copyId) || loadNotified().includes(run.copyId)) return;
    notifiedInMemory.add(run.copyId);
    rememberNotified(run.copyId);
    const notifications = useNotificationStore();
    if (run.state === "failed") {
      notifications.showError(
        `Could not copy ${run.source.name} from ${run.hostLabel}`,
        run.error?.message || "The copy failed.",
        { workspaceId: run.workspaceId, profileId: run.profileId },
      );
      return;
    }
    const result = run.result;
    if (!result) return;
    const root = workspaceRoot(run.workspaceId);
    const path = root ? absoluteAttachmentPath(root, result.path) : result.path;
    const { event, inserted } = notifications.addAlertEvent({
      title: `Copied ${result.name} from ${run.hostLabel}`,
      body: path,
      kind: "completed",
      tier: 2,
      urgency: "normal",
      workspaceId: run.workspaceId,
      workspaceName: "",
      category: "peer-attachment",
      meta: { profileId: run.profileId, copyId: run.copyId, path },
      sourceAlertId: `peer-attachment:${run.copyId}`,
      threadKey: run.copyId,
      occurredAt: run.finishedAt || new Date().toISOString(),
    });
    if (!inserted) return;
    if (!notifications.pinned) notifications.pushToast({ ...event, category: "peer-attachment" });
    fireNotificationAlert(event.title, event.body, {
      tier: 2,
      urgency: "normal",
      sessionKey: `peer-attachment:${run.workspaceId}`,
      dedupeKey: `peer-attachment:${run.copyId}`,
    });
  }

  function onFinished(raw: unknown): void {
    const parsed = peerAttachmentCopyRunSchema.safeParse(raw);
    if (!parsed.success) return;
    remember(parsed.data);
    notifyOutcome(parsed.data);
  }

  /** Throttled progress of a copy this window already knows; an unknown copy joins with the next payload. */
  function onProgress(event: PeerAttachmentCopyProgress): void {
    const known = runs.value[event.copyId];
    if (!known || isPeerAttachmentCopyTerminal(known) || event.bytesDone <= known.bytesDone) return;
    runs.value = { ...runs.value, [event.copyId]: { ...known, bytesDone: event.bytesDone } };
  }

  /** The payload's `peerAttachmentCopies`: covers a copy that progressed or ended while this client was not listening. */
  function reconcile(state: unknown): void {
    const value = state as { running?: unknown; lastResults?: unknown } | null | undefined;
    for (const list of [value?.running, value?.lastResults]) {
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        const parsed = peerAttachmentCopyRunSchema.safeParse(item);
        if (!parsed.success) continue;
        const run = parsed.data;
        const known = runs.value[run.copyId];
        if (known && isPeerAttachmentCopyTerminal(known)) {
          notifyOutcome(known);
          continue;
        }
        if (
          !isPeerAttachmentCopyTerminal(run) &&
          known &&
          known.state === run.state &&
          known.bytesDone >= run.bytesDone
        )
          continue;
        remember(run);
        notifyOutcome(run);
      }
    }
  }

  function init(
    transport: Transport,
    getProfileId: () => string | null,
    getWorkspaceRoot: (workspaceId: string) => string,
  ): void {
    api = transport;
    profileId.value = getProfileId();
    workspaceRoot = getWorkspaceRoot;
    if (bound) return;
    bound = true;
    transport.onPeerAttachmentCopyFinished?.((event) => onFinished(event));
    transport.onPeerAttachmentCopyProgress?.((event) => onProgress(event));
  }

  function setProfile(next: string | null): void {
    profileId.value = next;
  }

  function client(): CallableTransport {
    if (!api) throw new Error("Copying attachments is not available yet.");
    return api as CallableTransport;
  }

  function setListing(hostId: string, patch: Partial<PeerAttachmentListing>): void {
    const current = listings.value[hostId] ?? {
      items: [],
      truncated: false,
      loading: false,
      error: "",
      unsupported: "",
      loadedAt: 0,
    };
    listings.value = { ...listings.value, [hostId]: { ...current, ...patch } };
  }

  /** Reads the host's recent attachments. A failure stays on the listing for the row and is rethrown for the caller. */
  async function loadListing(hostId: string): Promise<void> {
    setListing(hostId, { loading: true });
    try {
      const result = await client().listPeerAttachments(hostId);
      setListing(hostId, {
        items: result.items,
        truncated: result.truncated,
        loading: false,
        error: "",
        unsupported: "",
        loadedAt: Date.now(),
      });
    } catch (error) {
      if (isUnsupportedPeerFeature(error)) {
        setListing(hostId, { items: [], loading: false, error: "", unsupported: userFacingMessage(error) });
        return;
      }
      setListing(hostId, { loading: false, error: userFacingMessage(error), unsupported: "" });
      throw error;
    }
  }

  /** Starts a copy and answers as soon as the runtime has accepted it; every refusal rejects. */
  async function start(request: PeerAttachmentCopyRequest): Promise<string> {
    const { copyId } = await client().startPeerAttachmentCopy(request);
    if (!runs.value[copyId]) {
      remember({
        copyId,
        profileId: profileId.value || "default",
        workspaceId: request.targetWorkspaceId,
        hostId: request.hostId,
        hostLabel: "",
        source: request.source,
        state: "queued",
        startedAt: new Date().toISOString(),
        finishedAt: null,
        bytesDone: 0,
        bytesTotal: request.source.size,
      });
    }
    return copyId;
  }

  async function cancel(copyId: string): Promise<void> {
    await client().cancelPeerAttachmentCopy(copyId);
  }

  /** Resolves with the run once its outcome is known, from the event or from the payload. */
  function awaitFinished(copyId: string): Promise<PeerAttachmentCopyRun> {
    const known = runs.value[copyId];
    if (known && isPeerAttachmentCopyTerminal(known)) return Promise.resolve(known);
    return new Promise((resolve) => waiters.set(copyId, [...(waiters.get(copyId) ?? []), resolve]));
  }

  /** The latest copy of one source attachment, into any workspace of the profile in view. */
  function runFor(hostId: string, transferId: string): PeerAttachmentCopyRun | undefined {
    let latest: PeerAttachmentCopyRun | undefined;
    for (const run of Object.values(runs.value)) {
      if (
        run.hostId !== hostId ||
        run.source.transferId !== transferId ||
        (profileId.value && run.profileId !== profileId.value)
      )
        continue;
      if (!latest || Date.parse(run.startedAt) >= Date.parse(latest.startedAt)) latest = run;
    }
    return latest;
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

  return {
    runs,
    listings,
    collapsed,
    init,
    setProfile,
    reconcile,
    loadListing,
    start,
    cancel,
    awaitFinished,
    runFor,
    isCollapsed,
    setCollapsed,
  };
});
