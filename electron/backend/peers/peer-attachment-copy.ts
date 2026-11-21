import { createHash, randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import { ATTACHMENT_READ_MAX_BYTES } from "../../shared/attachment-upload.js";
import {
  PEER_ATTACHMENT_COPY_FINISHED_CHANNEL,
  PEER_ATTACHMENT_COPY_PROGRESS_CHANNEL,
  type PeerAttachmentCopiesState,
  type PeerAttachmentCopyFinished,
  type PeerAttachmentCopyProgress,
  type PeerAttachmentCopyResult,
  type PeerAttachmentCopyRun,
  type PeerAttachmentCopyStarted,
} from "../../shared/peer-attachment-copy-events.js";
import type { PeerAttachmentCopyRequest, PeerHostLinkState } from "../../shared/peers.js";
import type { AppState } from "../../shared/types/state.js";
import * as attachments from "../attachments.js";
import { localAttachmentRoot } from "../attachment-root.js";
import { getLogger } from "../logger.js";
import type { PeerRequest, PeerResponse } from "./peer-client.js";

const log = getLogger("peers");

export const PEER_ATTACHMENT_COPY_RETENTION_MS = 24 * 60 * 60 * 1000;
export const PEER_ATTACHMENT_COPY_MAX_RESULTS = 50;
export const PEER_ATTACHMENT_COPY_CONCURRENCY_PER_HOST = 2;
export const PEER_ATTACHMENT_COPY_CONCURRENCY_PER_WORKSPACE = 2;
const PROGRESS_EVENT_MS = 300;
const BASE64_BLOCK = /^[A-Za-z0-9+/]+={0,2}$/;

class CopyCancelled extends Error {}

export interface PeerAttachmentCopiesDeps {
  getState: () => AppState;
  hostInfo: (hostId: string) => { label: string; state: PeerHostLinkState } | null;
  /** Refreshes the host and throws, with the reason, unless it is reachable and pairing this desktop. */
  requireHostOnline: (hostId: string) => Promise<unknown>;
  request: (hostId: string, request: PeerRequest) => Promise<PeerResponse>;
  emit: (channel: string, payload: unknown) => void;
  /** The payload changed: a copy was queued, started or ended (progress travels as its own event). */
  changed: () => void;
  now?: () => number;
}

interface CopyRecord {
  run: PeerAttachmentCopyRun;
  key: string;
  root: string;
  cancelRequested: boolean;
  discarding: boolean;
  progressAt: number;
  transferId?: string;
}

type Outcome =
  { state: "succeeded"; result: PeerAttachmentCopyResult } | { state: "failed" | "cancelled"; message: string };

function responseError(response: PeerResponse, label: string): string {
  let detail = "";
  try {
    const parsed = JSON.parse(response.body) as { error?: unknown };
    if (typeof parsed.error === "string") detail = parsed.error;
  } catch {
    // an answer that is not JSON has nothing to quote
  }
  if (response.status === 404) return `The attachment is no longer on ${label}.`;
  return `${label} refused to send the attachment${detail ? `: ${detail}` : ` (status ${response.status})`}.`;
}

/**
 * Copies an attachment of a paired desktop into a local workspace. The start answers at once; the run needs no caller
 * and writes only through `attachments.*` with the desktop limits. The idempotency key and owner derive from
 * (host, source transfer, target workspace), so starting the same copy again resumes the partial transfer `begin`
 * finds instead of starting over.
 */
export function createPeerAttachmentCopies(deps: PeerAttachmentCopiesDeps) {
  const now = deps.now ?? (() => Date.now());
  const records = new Map<string, CopyRecord>();
  let queue: CopyRecord[] = [];
  const activeByHost = new Map<string, number>();
  const activeByWorkspace = new Map<string, number>();
  const starting = new Map<string, Promise<PeerAttachmentCopyStarted>>();
  let disposed = false;

  function prune(): void {
    const cutoff = now() - PEER_ATTACHMENT_COPY_RETENTION_MS;
    const finished = [...records.values()]
      .filter((record) => record.run.finishedAt)
      .sort((a, b) => Date.parse(b.run.finishedAt ?? "") - Date.parse(a.run.finishedAt ?? ""));
    finished.forEach((record, index) => {
      if (Date.parse(record.run.finishedAt ?? "") < cutoff || index >= PEER_ATTACHMENT_COPY_MAX_RESULTS) {
        records.delete(record.run.copyId);
      }
    });
  }

  function progress(record: CopyRecord, bytesDone: number): void {
    record.run.bytesDone = bytesDone;
    if (disposed || now() - record.progressAt < PROGRESS_EVENT_MS) return;
    record.progressAt = now();
    const event: PeerAttachmentCopyProgress = {
      copyId: record.run.copyId,
      bytesDone,
      bytesTotal: record.run.bytesTotal,
    };
    deps.emit(PEER_ATTACHMENT_COPY_PROGRESS_CHANNEL, event);
  }

  function settle(record: CopyRecord, outcome: Outcome): void {
    const { run } = record;
    run.state = outcome.state;
    run.finishedAt = new Date(now()).toISOString();
    if (outcome.state === "succeeded") {
      run.result = outcome.result;
      run.bytesDone = run.bytesTotal;
    } else {
      run.error = { message: outcome.message };
    }
    if (disposed) return;
    const meta = { copyId: run.copyId, hostId: run.hostId, workspaceId: run.workspaceId, bytes: run.bytesDone };
    if (outcome.state === "succeeded") log.info("peer attachment copied", meta);
    else if (outcome.state === "cancelled") log.info("peer attachment copy cancelled", meta);
    else log.warn("peer attachment copy failed", { ...meta, err: outcome.message });
    prune();
    deps.emit(PEER_ATTACHMENT_COPY_FINISHED_CHANNEL, structuredClone(run) as PeerAttachmentCopyFinished);
    deps.changed();
  }

  async function readBlock(record: CopyRecord, offset: number): Promise<string> {
    const { run } = record;
    const response = await deps.request(run.hostId, {
      method: "POST",
      pathname: "/api/peer/attachments/read",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: run.source.workspaceId,
        transferId: run.source.transferId,
        name: run.source.name,
        offset,
        length: Math.min(ATTACHMENT_READ_MAX_BYTES, run.source.size - offset),
      }),
    });
    if (response.status !== 200) throw new Error(responseError(response, run.hostLabel));
    let parsed: { data?: unknown; size?: unknown };
    try {
      parsed = JSON.parse(response.body) as { data?: unknown; size?: unknown };
    } catch {
      throw new Error(`${run.hostLabel} sent an answer this version cannot read.`);
    }
    if (typeof parsed.data !== "string" || !parsed.data || !BASE64_BLOCK.test(parsed.data)) {
      throw new Error(`${run.hostLabel} sent an answer this version cannot read.`);
    }
    if (parsed.size !== run.source.size) throw new Error(`The attachment changed on ${run.hostLabel}.`);
    return parsed.data;
  }

  async function storedFileExists(root: string, relativePath: string): Promise<boolean> {
    try {
      return (await stat(path.join(root, relativePath))).isFile();
    } catch {
      return false;
    }
  }

  async function transfer(record: CopyRecord): Promise<PeerAttachmentCopyResult> {
    const { run, root, key } = record;
    const checkCancelled = () => {
      if (record.cancelRequested) throw new CopyCancelled("cancelled");
      if (disposed) throw new Error("strIDEterm is closing.");
    };
    const begin = () =>
      attachments.begin(root, run.source.name, run.source.size, "", key, key, attachments.DESKTOP_LIMITS);
    let started = await begin();
    if ("done" in started && started.done && !(await storedFileExists(root, started.done.path))) {
      await attachments.remove(root, started.transferId, started.done.name, key);
      started = await begin();
    }
    record.transferId = started.transferId;
    let offset = started.offset;
    progress(record, offset);
    if (!("done" in started && started.done)) {
      while (offset < run.source.size) {
        checkCancelled();
        const block = await readBlock(record, offset);
        checkCancelled();
        const next = (await attachments.chunk(root, started.transferId, offset, block, key)).offset;
        if (next <= offset) throw new Error("The attachment could not be written.");
        offset = next;
        progress(record, offset);
      }
      checkCancelled();
    }
    const finished = await attachments.finish(root, started.transferId, key);
    if (finished.sha256 !== run.source.sha256) {
      await attachments.remove(root, started.transferId, finished.name, key);
      throw new Error(`The copy from ${run.hostLabel} did not arrive intact and was removed.`);
    }
    return {
      transferId: finished.transferId,
      path: finished.path,
      name: finished.name,
      size: finished.size,
      sha256: finished.sha256,
    };
  }

  async function execute(record: CopyRecord): Promise<void> {
    record.run.state = "running";
    deps.changed();
    try {
      settle(record, { state: "succeeded", result: await transfer(record) });
    } catch (error) {
      if (error instanceof CopyCancelled) {
        if (record.transferId) {
          await attachments.cancel(record.root, record.transferId, record.key).catch((cleanupError: unknown) => {
            log.warn("peer attachment copy could not remove its partial transfer", {
              copyId: record.run.copyId,
              err: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
            });
          });
        }
        settle(record, { state: "cancelled", message: "The copy was cancelled." });
      } else {
        settle(record, { state: "failed", message: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  function pump(): void {
    for (const record of [...queue]) {
      const { hostId, workspaceId } = record.run;
      if (
        (activeByHost.get(hostId) ?? 0) >= PEER_ATTACHMENT_COPY_CONCURRENCY_PER_HOST ||
        (activeByWorkspace.get(workspaceId) ?? 0) >= PEER_ATTACHMENT_COPY_CONCURRENCY_PER_WORKSPACE
      )
        continue;
      queue.splice(queue.indexOf(record), 1);
      activeByHost.set(hostId, (activeByHost.get(hostId) ?? 0) + 1);
      activeByWorkspace.set(workspaceId, (activeByWorkspace.get(workspaceId) ?? 0) + 1);
      void execute(record).finally(() => {
        activeByHost.set(hostId, (activeByHost.get(hostId) ?? 1) - 1);
        activeByWorkspace.set(workspaceId, (activeByWorkspace.get(workspaceId) ?? 1) - 1);
        pump();
      });
    }
  }

  /** A failed copy keeps its partial for Retry; discarding it removes the partial and ends the run as cancelled. */
  async function discard(record: CopyRecord): Promise<{ ok: true }> {
    if (record.discarding) return { ok: true };
    record.discarding = true;
    try {
      const retrying = [...records.values()].some(
        (other) => other !== record && other.key === record.key && !other.run.finishedAt,
      );
      if (record.transferId && !retrying) await attachments.cancel(record.root, record.transferId, record.key);
    } catch (error) {
      record.discarding = false;
      throw error;
    }
    settle(record, { state: "cancelled", message: "The copy was discarded." });
    return { ok: true };
  }

  async function launch(
    request: PeerAttachmentCopyRequest,
    caller: { profileId: string },
    workspaceId: string,
    root: string,
    key: string,
  ): Promise<PeerAttachmentCopyStarted> {
    const host = deps.hostInfo(request.hostId);
    if (!host) throw new Error("This desktop is not attached.");
    if (host.state !== "online") await deps.requireHostOnline(request.hostId);

    const limits = attachments.DESKTOP_LIMITS;
    // A transfer this key already names is resumed (or answered) by `begin`, which stays the authority on quota.
    if (!(await attachments.findByIdempotencyKey(root, key))) {
      const { usage } = await attachments.listWithUsage(root, limits);
      if (usage.fileCount >= limits.fileCount) {
        throw new Error(`Attachment quota exceeded: a workspace holds at most ${limits.fileCount} attachments`);
      }
      if (usage.storageBytes + request.source.size > limits.storageBytes) {
        throw new Error(
          `Attachment quota exceeded: a workspace holds at most ${attachments.formatLimitBytes(limits.storageBytes)} of attachments`,
        );
      }
    }

    const run: PeerAttachmentCopyRun = {
      copyId: randomUUID(),
      profileId: caller.profileId,
      workspaceId,
      hostId: request.hostId,
      hostLabel: host.label,
      source: { ...request.source },
      state: "queued",
      startedAt: new Date(now()).toISOString(),
      finishedAt: null,
      bytesDone: 0,
      bytesTotal: request.source.size,
    };
    const record: CopyRecord = { run, key, root, cancelRequested: false, discarding: false, progressAt: 0 };
    records.set(run.copyId, record);
    queue.push(record);
    deps.changed();
    pump();
    return { copyId: run.copyId };
  }

  return {
    /** Validates and refuses synchronously (the throw reaches the user); the copy itself runs on its own. */
    async start(request: PeerAttachmentCopyRequest, caller: { profileId: string }): Promise<PeerAttachmentCopyStarted> {
      const workspace = deps
        .getState()
        .workspaces.find(
          (candidate) =>
            candidate.id === request.targetWorkspaceId && String(candidate.profileId || "default") === caller.profileId,
        );
      if (!workspace) throw new Error("The target workspace is not available in this profile.");
      const root = localAttachmentRoot(workspace);
      if (!deps.hostInfo(request.hostId)) throw new Error("This desktop is not attached.");

      const key =
        attachments.PEER_COPY_OWNER_PREFIX +
        createHash("sha256")
          .update(`${request.hostId}\n${request.source.transferId}\n${request.targetWorkspaceId}`)
          .digest("hex");
      for (const existing of records.values()) {
        if (existing.key === key && !existing.run.finishedAt) return { copyId: existing.run.copyId };
      }
      // Reserved before the first await: a second start of the same copy joins this one instead of racing it.
      const pending = starting.get(key);
      if (pending) return pending;
      const launching = launch(request, caller, workspace.id, root, key);
      starting.set(key, launching);
      try {
        return await launching;
      } finally {
        starting.delete(key);
      }
    },

    /** Validates synchronously. A running or queued copy is cancelled; a failed one is discarded with its partial. */
    cancel(copyId: string, caller: { profileId: string }): Promise<{ ok: true }> {
      const record = records.get(copyId);
      if (!record || record.run.profileId !== caller.profileId) throw new Error("That copy is not running.");
      if (record.run.finishedAt) {
        if (record.run.state !== "failed") throw new Error("That copy is not running.");
        return discard(record);
      }
      if (record.run.state === "queued") {
        queue.splice(queue.indexOf(record), 1);
        settle(record, { state: "cancelled", message: "The copy was cancelled." });
      } else {
        record.cancelRequested = true;
      }
      return Promise.resolve({ ok: true });
    },

    getPayload(): PeerAttachmentCopiesState {
      prune();
      const all = [...records.values()].map((record) => structuredClone(record.run));
      return {
        running: all.filter((run) => !run.finishedAt),
        lastResults: all
          .filter((run) => run.finishedAt)
          .sort((a, b) => Date.parse(b.finishedAt ?? "") - Date.parse(a.finishedAt ?? "")),
      };
    },

    /** Resolves when every started copy has ended (tests). */
    async idle(): Promise<void> {
      while ([...records.values()].some((record) => !record.run.finishedAt)) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },

    /** Ends running copies without reporting and starts no queued one: the process is going away and a partial transfer stays resumable. */
    dispose(): void {
      disposed = true;
      queue = [];
    },
  };
}

export type PeerAttachmentCopies = ReturnType<typeof createPeerAttachmentCopies>;
