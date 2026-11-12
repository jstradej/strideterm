import { defineStore } from "pinia";
import { ref } from "vue";
import type { SshFileDownload, SshFileUpload } from "../../electron/backend/ipc-schemas.js";
import {
  sshFileTransferFinishedSchema,
  sshFileTransferProgressSchema,
  sshFileTransferRunSchema,
  type SshFileTransferFinished,
  type SshFileTransferProgress,
  type SshFileTransferRun,
} from "../../electron/shared/ssh-file-events.js";
import type { CallableTransport, Transport } from "../transport.js";
import { fireNotificationAlert } from "../composables/useNotificationSound.js";
import { useNotificationStore } from "./notifications.js";

/**
 * Transfers this client has already been told about, newest last. Per client (browser storage), bounded, and
 * separate from the notification history: removing an entry must not make the payload's replayed last run look
 * new again after a reload.
 */
const NOTIFIED_KEY = "strideterm-ssh-file-notified-transfers";
const NOTIFIED_MAX = 100;
const RUNS_MEMORY = 100;
const SPEED_WINDOW_MS = 5000;
const SPEED_MIN_SPAN_MS = 500;

function loadNotified(): string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(NOTIFIED_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function rememberNotified(transferId: string): void {
  try {
    const ids = [...loadNotified().filter((id) => id !== transferId), transferId];
    window.localStorage.setItem(NOTIFIED_KEY, JSON.stringify(ids.slice(-NOTIFIED_MAX)));
  } catch {
    // Storage unavailable: this renderer's in-memory set still holds for its lifetime.
  }
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function describeTransfer(run: SshFileTransferRun | SshFileTransferFinished): string {
  const verb = run.direction === "upload" ? "Uploaded" : "Downloaded";
  const preposition = run.direction === "upload" ? "to" : "from";
  if (run.state === "failed") return run.error?.message || "The transfer failed.";
  if (run.state === "cancelled") return "The transfer was cancelled.";
  const files = run.result?.files ?? 0;
  const skipped = run.result?.skipped.length ?? 0;
  const tail = skipped ? ` ${skipped} skipped.` : "";
  return `${verb} ${files} file${files === 1 ? "" : "s"} (${formatBytes(run.result?.bytes ?? 0)}) ${preposition} ${run.hostLabel}.${tail}`;
}

export function formatSpeed(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}

export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  const wholeSeconds = Math.ceil(seconds);
  if (wholeSeconds < 60) return `${wholeSeconds} s left`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} min left`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min left`;
}

/** A conflict is not a failure: the caller asked what to do and restarts with the answer. */
export class SshFileConflictError extends Error {
  readonly conflicts: string[];
  constructor(message: string, conflicts: string[]) {
    super(message);
    this.name = "SshFileConflictError";
    this.conflicts = conflicts;
  }
}

export const useSshFileTransfersStore = defineStore("ssh-file-transfers", () => {
  const runs = ref<Record<string, SshFileTransferRun>>({});
  const dismissed = ref<string[]>([]);
  const speeds = ref<Record<string, number>>({});
  const profileId = ref<string | null>(null);
  let api: Transport | null = null;
  let bound = false;
  /** Transfers this client started: their outcome belongs to the user in front of the pane. */
  const owned = new Set<string>();
  const notifiedInMemory = new Set<string>();
  /** A quick transfer's finished event can beat the start call's response; judge those once it is in. */
  let startsInFlight = 0;
  const deferred: SshFileTransferRun[] = [];
  const samples = new Map<string, Array<{ at: number; bytes: number }>>();

  function remember(run: SshFileTransferRun): void {
    runs.value = { ...runs.value, [run.transferId]: run };
    const ids = Object.keys(runs.value);
    if (ids.length > RUNS_MEMORY) {
      const finished = ids
        .map((id) => runs.value[id]!)
        .filter((item) => item.state !== "running")
        .sort((a, b) => Date.parse(a.finishedAt ?? "") - Date.parse(b.finishedAt ?? ""));
      const next = { ...runs.value };
      for (const item of finished.slice(0, ids.length - RUNS_MEMORY)) delete next[item.transferId];
      runs.value = next;
    }
  }

  function announce(run: SshFileTransferRun): void {
    if (startsInFlight > 0) {
      deferred.push(run);
      return;
    }
    notifyOutcome(run);
  }

  /**
   * One Notification Center entry per transfer per client: for a transfer this client started, and for any
   * failure of the profile in view. A foreign success is not news; a user cancelling is not either.
   */
  function notifyOutcome(run: SshFileTransferRun): void {
    if (run.state === "running" || run.source !== "ui") return;
    if (run.profileId !== profileId.value) return;
    const mine = owned.has(run.transferId);
    if (run.state === "cancelled" && mine) return;
    if (!mine && run.state !== "failed") return;
    if (notifiedInMemory.has(run.transferId) || loadNotified().includes(run.transferId)) return;
    notifiedInMemory.add(run.transferId);
    rememberNotified(run.transferId);
    const notifications = useNotificationStore();
    const failed = run.state === "failed";
    const title = failed
      ? `${run.direction === "upload" ? "Upload" : "Download"} failed`
      : run.state === "cancelled"
        ? "Transfer cancelled"
        : `${run.direction === "upload" ? "Upload" : "Download"} finished`;
    const body = describeTransfer(run);
    if (failed) {
      notifications.showError(title, body, { workspaceId: run.workspaceId, profileId: run.profileId });
      return;
    }
    const { event, inserted } = notifications.addAlertEvent({
      title,
      body,
      kind: "completed",
      tier: 2,
      urgency: "normal",
      workspaceId: run.workspaceId,
      workspaceName: "",
      category: "ssh-file",
      meta: { profileId: run.profileId, transferId: run.transferId },
      sourceAlertId: `ssh-file:${run.transferId}`,
      occurredAt: run.finishedAt || new Date().toISOString(),
    });
    if (!inserted) return;
    if (!notifications.pinned) notifications.pushToast({ ...event, category: "ssh-file" });
    fireNotificationAlert(event.title, event.body, {
      tier: 2,
      urgency: "normal",
      sessionKey: `ssh-file:${run.workspaceId}`,
      dedupeKey: `ssh-file:${run.transferId}`,
    });
  }

  /** Speed is the growth over the last few seconds; a window too short or flat keeps the previous value. */
  function measureSpeed(transferId: string, bytes: number): void {
    const now = Date.now();
    const list = samples.get(transferId) ?? [];
    list.push({ at: now, bytes });
    const cutoff = now - SPEED_WINDOW_MS;
    while (list.length > 1 && list[1]!.at <= cutoff) list.shift();
    samples.set(transferId, list);
    const oldest = list[0]!;
    const span = now - oldest.at;
    if (span < SPEED_MIN_SPAN_MS || bytes <= oldest.bytes) return;
    speeds.value = { ...speeds.value, [transferId]: (bytes - oldest.bytes) / (span / 1000) };
  }

  function forgetSpeed(transferId: string): void {
    samples.delete(transferId);
    if (speeds.value[transferId] === undefined) return;
    const next = { ...speeds.value };
    delete next[transferId];
    speeds.value = next;
  }

  function onProgress(raw: unknown): void {
    const parsed = sshFileTransferProgressSchema.safeParse(raw);
    if (!parsed.success) return;
    const progress: SshFileTransferProgress = parsed.data;
    const current = runs.value[progress.transferId];
    if (!current || current.state !== "running") return;
    runs.value = {
      ...runs.value,
      [progress.transferId]: {
        ...current,
        bytesDone: progress.bytesDone,
        bytesTotal: progress.bytesTotal,
        filesDone: progress.filesDone,
        filesTotal: progress.filesTotal,
        currentPath: progress.currentPath,
      },
    };
    measureSpeed(progress.transferId, progress.bytesDone);
  }

  function onFinished(raw: unknown): void {
    const parsed = sshFileTransferFinishedSchema.safeParse(raw);
    if (!parsed.success) return;
    const event = parsed.data;
    const previous = runs.value[event.transferId];
    const run: SshFileTransferRun = {
      transferId: event.transferId,
      profileId: event.profileId,
      workspaceId: event.workspaceId,
      direction: event.direction,
      source: event.source,
      hostLabel: event.hostLabel,
      state: event.state,
      startedAt: event.startedAt,
      finishedAt: event.finishedAt,
      bytesDone: event.result?.bytes ?? previous?.bytesDone ?? 0,
      bytesTotal: previous?.bytesTotal ?? event.result?.bytes ?? 0,
      filesDone: event.result?.files ?? previous?.filesDone ?? 0,
      filesTotal: previous?.filesTotal ?? event.result?.files ?? 0,
      currentPath: "",
      ...(event.result ? { result: event.result } : {}),
      ...(event.error ? { error: event.error } : {}),
    };
    forgetSpeed(event.transferId);
    remember(run);
    announce(run);
  }

  /** The payload's `sshFileTransfers`: covers a transfer that began or ended while this client was not connected. */
  function reconcile(state: unknown): void {
    const value = state as { running?: unknown; lastRuns?: unknown } | null | undefined;
    for (const list of [value?.running, value?.lastRuns]) {
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        const parsed = sshFileTransferRunSchema.safeParse(item);
        if (!parsed.success) continue;
        const run = parsed.data;
        const known = runs.value[run.transferId];
        if (known && known.state !== "running") continue;
        if (run.state === "running" && known && known.bytesDone >= run.bytesDone) continue;
        remember(run);
        if (run.state !== "running") {
          forgetSpeed(run.transferId);
          announce(run);
        }
      }
    }
  }

  function init(transport: Transport, getProfileId: () => string | null): void {
    api = transport;
    profileId.value = getProfileId();
    if (bound) return;
    bound = true;
    transport.onSshFileTransferProgress?.((event) => onProgress(event));
    transport.onSshFileTransferFinished?.((event) => onFinished(event));
  }

  function setProfile(next: string | null): void {
    profileId.value = next;
  }

  function client(): CallableTransport {
    if (!api) throw new Error("File transfers are not available yet.");
    return api as CallableTransport;
  }

  /**
   * Starts a transfer and answers as soon as the runtime has accepted it. A `conflict` refusal comes back as
   * `SshFileConflictError` (the caller asks the user and starts again with a policy); every other failure rejects.
   */
  async function start(
    direction: "upload" | "download",
    payload: SshFileUpload | SshFileDownload,
    context: { hostLabel: string },
  ): Promise<string> {
    startsInFlight += 1;
    try {
      const started =
        direction === "upload"
          ? await client().sshFileUpload(payload as SshFileUpload)
          : await client().sshFileDownload(payload as SshFileDownload);
      owned.add(started.transferId);
      if (!runs.value[started.transferId]) {
        remember({
          transferId: started.transferId,
          profileId: profileId.value || "default",
          workspaceId: payload.workspaceId,
          direction,
          source: "ui",
          hostLabel: context.hostLabel,
          state: "running",
          startedAt: new Date().toISOString(),
          finishedAt: null,
          bytesDone: 0,
          bytesTotal: 0,
          filesDone: 0,
          filesTotal: 0,
          currentPath: "",
        });
      }
      return started.transferId;
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      if (code === "conflict") {
        const conflicts = (error as { sshFileError?: { conflicts?: string[] } }).sshFileError?.conflicts ?? [];
        throw new SshFileConflictError((error as Error).message, conflicts);
      }
      throw error;
    } finally {
      startsInFlight -= 1;
      if (startsInFlight === 0) for (const run of deferred.splice(0)) notifyOutcome(run);
    }
  }

  async function cancel(transferId: string): Promise<void> {
    await client().sshFileTransferCancel({ transferId });
  }

  function dismiss(transferId: string): void {
    if (!dismissed.value.includes(transferId)) dismissed.value = [...dismissed.value, transferId];
  }

  /** The runs of one workspace in the profile in view: running first, then the latest finished. */
  function forWorkspace(workspaceId: string): SshFileTransferRun[] {
    return Object.values(runs.value)
      .filter(
        (run) =>
          run.workspaceId === workspaceId &&
          run.source === "ui" &&
          (!profileId.value || run.profileId === profileId.value) &&
          !dismissed.value.includes(run.transferId),
      )
      .sort((a, b) => {
        if ((a.state === "running") !== (b.state === "running")) return a.state === "running" ? -1 : 1;
        return Date.parse(b.startedAt) - Date.parse(a.startedAt);
      });
  }

  return { runs, speeds, init, setProfile, reconcile, start, cancel, dismiss, forWorkspace };
});
