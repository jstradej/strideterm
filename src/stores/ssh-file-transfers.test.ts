import { beforeEach, describe, expect, test, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import {
  sshFileDownloadSchema,
  sshFileTransferCancelSchema,
  sshFileUploadSchema,
} from "../../electron/backend/ipc-schemas.js";
import type { SshFileTransferFinished, SshFileTransferRun } from "../../electron/shared/ssh-file-events.js";

const showError = vi.fn();
const addAlertEvent = vi.fn((payload: { sourceAlertId?: string; title: string; body: string }) => ({
  event: { ...payload, id: `evt-${payload.sourceAlertId}` },
  inserted: true,
}));
const pushToast = vi.fn();
vi.mock("./notifications.js", () => ({
  useNotificationStore: () => ({ showError, addAlertEvent, pushToast, pinned: false }),
}));
vi.mock("../composables/useNotificationSound.js", () => ({ fireNotificationAlert: vi.fn() }));

import {
  SshFileConflictError,
  describeTransfer,
  formatBytes,
  formatEta,
  formatSpeed,
  useSshFileTransfersStore,
} from "./ssh-file-transfers.js";

type Handler = (payload: unknown) => void;

function makeApi() {
  const handlers: { progress?: Handler; finished?: Handler } = {};
  const api = {
    isRemote: false,
    onSshFileTransferProgress: vi.fn((handler: Handler) => {
      handlers.progress = handler;
    }),
    onSshFileTransferFinished: vi.fn((handler: Handler) => {
      handlers.finished = handler;
    }),
    sshFileUpload: vi.fn(async (_payload: unknown) => ({ started: true as const, transferId: "t-1" })),
    sshFileDownload: vi.fn(async (_payload: unknown) => ({ started: true as const, transferId: "t-2" })),
    sshFileTransferCancel: vi.fn(async (_payload: unknown) => ({ ok: true as const })),
  };
  return { api, handlers };
}

function finished(overrides: Partial<SshFileTransferFinished> = {}): SshFileTransferFinished {
  return {
    transferId: "t-1",
    profileId: "default",
    workspaceId: "ws-1",
    direction: "upload",
    source: "ui",
    hostLabel: "box",
    state: "succeeded",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:05.000Z",
    result: { files: 2, bytes: 2048, skipped: [] },
    ...overrides,
  };
}

function run(overrides: Partial<SshFileTransferRun> = {}): SshFileTransferRun {
  return {
    transferId: "t-9",
    profileId: "default",
    workspaceId: "ws-1",
    direction: "upload",
    source: "ui",
    hostLabel: "box",
    state: "running",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: null,
    bytesDone: 10,
    bytesTotal: 100,
    filesDone: 0,
    filesTotal: 1,
    currentPath: "/x",
    ...overrides,
  };
}

function setup(profile: string | null = "default") {
  setActivePinia(createPinia());
  window.localStorage.clear();
  const harness = makeApi();
  const store = useSshFileTransfersStore();
  store.init(harness.api as never, () => profile);
  return { store, ...harness };
}

const uploadPayload = {
  workspaceId: "ws-1",
  panelId: "panel-1",
  localPaths: ["/home/me/a.txt"],
  remoteDir: "/srv",
  conflict: "fail" as const,
};

describe("ssh file transfers store", () => {
  beforeEach(() => {
    showError.mockClear();
    addAlertEvent.mockClear();
    pushToast.mockClear();
  });

  test("an upload is sent exactly as the main-process schema wants it", async () => {
    const { store, api } = setup();
    const id = await store.start("upload", uploadPayload, { hostLabel: "box" });

    expect(id).toBe("t-1");
    const sent = api.sshFileUpload.mock.calls[0]![0];
    expect(sshFileUploadSchema.safeParse(sent).success).toBe(true);
    expect(sshFileUploadSchema.safeParse({ ...(sent as object), extra: true }).success).toBe(false);
    expect(store.forWorkspace("ws-1").map((item) => [item.transferId, item.state])).toEqual([["t-1", "running"]]);
  });

  test("a download is sent exactly as the main-process schema wants it", async () => {
    const { store, api } = setup();
    await store.start(
      "download",
      { workspaceId: "ws-1", panelId: "p", remotePaths: ["/srv/a"], localDir: "/home/me", conflict: "skip" },
      { hostLabel: "box" },
    );
    expect(sshFileDownloadSchema.safeParse(api.sshFileDownload.mock.calls[0]![0]).success).toBe(true);
  });

  test("a conflict refusal becomes a conflict error carrying the paths, other failures pass through", async () => {
    const { store, api } = setup();
    api.sshFileUpload.mockRejectedValueOnce(
      Object.assign(new Error("1 item already exists."), {
        code: "conflict",
        sshFileError: { code: "conflict", conflicts: ["/srv/a.txt"] },
      }),
    );
    const failure = await store.start("upload", uploadPayload, { hostLabel: "box" }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SshFileConflictError);
    expect((failure as SshFileConflictError).conflicts).toEqual(["/srv/a.txt"]);

    api.sshFileUpload.mockRejectedValueOnce(
      Object.assign(new Error("Connect the SSH tab first."), { code: "not-connected" }),
    );
    await expect(store.start("upload", uploadPayload, { hostLabel: "box" })).rejects.toThrow(
      "Connect the SSH tab first.",
    );
    expect(store.forWorkspace("ws-1")).toEqual([]);
  });

  test("progress moves a running transfer; the finish settles it", async () => {
    const { store, handlers } = setup();
    await store.start("upload", uploadPayload, { hostLabel: "box" });
    handlers.progress!({
      transferId: "t-1",
      profileId: "default",
      bytesDone: 50,
      bytesTotal: 100,
      filesDone: 0,
      filesTotal: 1,
      currentPath: "/home/me/a.txt",
    });
    expect(store.runs["t-1"]).toMatchObject({ bytesDone: 50, bytesTotal: 100, state: "running" });

    handlers.finished!(finished());
    expect(store.runs["t-1"]).toMatchObject({ state: "succeeded", filesDone: 2 });
    // Late progress for a settled transfer is ignored.
    handlers.progress!({
      transferId: "t-1",
      profileId: "default",
      bytesDone: 1,
      bytesTotal: 100,
      filesDone: 0,
      filesTotal: 1,
      currentPath: "",
    });
    expect(store.runs["t-1"]!.state).toBe("succeeded");
  });

  test("a malformed event is ignored", async () => {
    const { store, handlers } = setup();
    handlers.finished!({ transferId: "t-1" });
    handlers.progress!("nope");
    expect(Object.keys(store.runs)).toEqual([]);
  });

  test("my own success is announced once, even when the payload replays it", async () => {
    const { store, handlers } = setup();
    await store.start("upload", uploadPayload, { hostLabel: "box" });
    handlers.finished!(finished());
    store.reconcile({ running: [], lastRuns: [run({ transferId: "t-1", state: "succeeded", finishedAt: "x" })] });
    handlers.finished!(finished());

    expect(addAlertEvent).toHaveBeenCalledTimes(1);
    expect(addAlertEvent.mock.calls[0]![0]).toMatchObject({ sourceAlertId: "ssh-file:t-1", title: "Upload finished" });
    expect(showError).not.toHaveBeenCalled();
  });

  test("a new store instance (a reload) does not announce what was already announced", async () => {
    const first = setup();
    await first.store.start("upload", uploadPayload, { hostLabel: "box" });
    first.handlers.finished!(finished());
    expect(addAlertEvent).toHaveBeenCalledTimes(1);

    // Same browser storage, fresh renderer: the replayed last run is not mine any more and not a failure.
    setActivePinia(createPinia());
    const second = makeApi();
    const store = useSshFileTransfersStore();
    store.init(second.api as never, () => "default");
    store.reconcile({ running: [], lastRuns: [run({ transferId: "t-1", state: "succeeded", finishedAt: "x" })] });
    expect(addAlertEvent).toHaveBeenCalledTimes(1);
  });

  test("a foreign success is not announced; a foreign failure is, once, as an error", () => {
    const { handlers } = setup();
    handlers.finished!(finished({ transferId: "t-foreign" }));
    expect(addAlertEvent).not.toHaveBeenCalled();

    const failure = finished({
      transferId: "t-fail",
      state: "failed",
      result: undefined,
      error: { code: "io", message: "Disk full" },
    });
    handlers.finished!(failure);
    handlers.finished!(failure);
    expect(showError).toHaveBeenCalledTimes(1);
    expect(showError.mock.calls[0]![0]).toBe("Upload failed");
    expect(showError.mock.calls[0]![1]).toBe("Disk full");
  });

  test("a transfer of another profile, or an agent's, is not announced", () => {
    const { handlers } = setup("default");
    handlers.finished!(
      finished({ transferId: "t-other", profileId: "other", state: "failed", error: { code: "io", message: "x" } }),
    );
    handlers.finished!(
      finished({ transferId: "t-mcp", source: "mcp", state: "failed", error: { code: "io", message: "x" } }),
    );
    expect(showError).not.toHaveBeenCalled();
    expect(addAlertEvent).not.toHaveBeenCalled();
  });

  test("a user cancelling their own transfer is not announced", async () => {
    const { store, handlers } = setup();
    await store.start("upload", uploadPayload, { hostLabel: "box" });
    handlers.finished!(finished({ state: "cancelled", result: undefined }));
    expect(addAlertEvent).not.toHaveBeenCalled();
    expect(store.runs["t-1"]!.state).toBe("cancelled");
  });

  test("an outcome that beats the start response is judged once the response is in", async () => {
    const { store, api, handlers } = setup();
    api.sshFileUpload.mockImplementationOnce(async () => {
      handlers.finished!(finished());
      return { started: true as const, transferId: "t-1" };
    });
    await store.start("upload", uploadPayload, { hostLabel: "box" });
    expect(addAlertEvent).toHaveBeenCalledTimes(1);
  });

  test("the payload brings in a run this client missed, and keeps the newer progress", () => {
    const { store, handlers } = setup();
    store.reconcile({ running: [run({ transferId: "t-9", bytesDone: 10 })], lastRuns: [] });
    handlers.progress!({
      transferId: "t-9",
      profileId: "default",
      bytesDone: 60,
      bytesTotal: 100,
      filesDone: 0,
      filesTotal: 1,
      currentPath: "/x",
    });
    store.reconcile({ running: [run({ transferId: "t-9", bytesDone: 20 })], lastRuns: [] });
    expect(store.runs["t-9"]!.bytesDone).toBe(60);
  });

  test("cancel sends only the transfer id", async () => {
    const { store, api } = setup();
    await store.cancel("t-1");
    expect(sshFileTransferCancelSchema.safeParse(api.sshFileTransferCancel.mock.calls[0]![0]).success).toBe(true);
  });

  test("forWorkspace shows one workspace of the profile in view, running first, minus dismissed", () => {
    const { store } = setup("default");
    store.reconcile({
      running: [run({ transferId: "t-run" })],
      lastRuns: [
        run({ transferId: "t-done", state: "succeeded", finishedAt: "2026-01-01T00:00:09.000Z" }),
        run({ transferId: "t-other-ws", workspaceId: "ws-2", state: "succeeded", finishedAt: "x" }),
        run({ transferId: "t-other-profile", profileId: "other", state: "succeeded", finishedAt: "x" }),
        run({ transferId: "t-agent", source: "mcp", state: "succeeded", finishedAt: "x" }),
      ],
    });
    expect(store.forWorkspace("ws-1").map((item) => item.transferId)).toEqual(["t-run", "t-done"]);
    store.dismiss("t-done");
    expect(store.forWorkspace("ws-1").map((item) => item.transferId)).toEqual(["t-run"]);
  });

  test("describes outcomes and sizes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(describeTransfer(finished())).toBe("Uploaded 2 files (2.0 KB) to box.");
    expect(
      describeTransfer(
        finished({ direction: "download", result: { files: 1, bytes: 1, skipped: [{ path: "a", reason: "x" }] } }),
      ),
    ).toBe("Downloaded 1 file (1 B) from box. 1 skipped.");
  });

  test("speed is the growth over the sampled window, and is dropped when the transfer ends", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      const { store, handlers } = setup();
      const progress = (bytesDone: number) => ({
        transferId: "t-1",
        profileId: "default",
        bytesDone,
        bytesTotal: 10000,
        filesDone: 0,
        filesTotal: 1,
        currentPath: "/x",
      });
      store.reconcile({ running: [run({ transferId: "t-1", bytesDone: 0, bytesTotal: 10000 })], lastRuns: [] });
      handlers.progress!(progress(0));
      expect(store.speeds["t-1"]).toBeUndefined();

      vi.setSystemTime(new Date("2026-01-01T00:00:01.000Z"));
      handlers.progress!(progress(2048));
      expect(store.speeds["t-1"]).toBe(2048);

      handlers.finished!(finished({ transferId: "t-1" }));
      expect(store.speeds["t-1"]).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  test("no speed is shown from a window shorter than half a second", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      const { store, handlers } = setup();
      store.reconcile({ running: [run({ transferId: "t-1", bytesDone: 0, bytesTotal: 10000 })], lastRuns: [] });
      const progress = (bytesDone: number) => ({
        transferId: "t-1",
        profileId: "default",
        bytesDone,
        bytesTotal: 10000,
        filesDone: 0,
        filesTotal: 1,
        currentPath: "",
      });
      handlers.progress!(progress(0));
      vi.setSystemTime(new Date("2026-01-01T00:00:00.100Z"));
      handlers.progress!(progress(500));
      expect(store.speeds["t-1"]).toBeUndefined();
      vi.setSystemTime(new Date("2026-01-01T00:00:01.000Z"));
      handlers.progress!(progress(1000));
      expect(store.speeds["t-1"]).toBe(1000);
    } finally {
      vi.useRealTimers();
    }
  });

  test("formats speed", () => {
    expect(formatSpeed(0)).toBe("0 B/s");
    expect(formatSpeed(2048)).toBe("2.0 KB/s");
    expect(formatSpeed(5 * 1024 * 1024)).toBe("5.0 MB/s");
  });

  test("formats time left", () => {
    expect(formatEta(0)).toBe("");
    expect(formatEta(-3)).toBe("");
    expect(formatEta(Number.NaN)).toBe("");
    expect(formatEta(Number.POSITIVE_INFINITY)).toBe("");
    expect(formatEta(0.2)).toBe("1 s left");
    expect(formatEta(42)).toBe("42 s left");
    expect(formatEta(59.5)).toBe("1 min left");
    expect(formatEta(61)).toBe("2 min left");
    expect(formatEta(600)).toBe("10 min left");
    expect(formatEta(3600)).toBe("1 h 0 min left");
    expect(formatEta(3725)).toBe("1 h 3 min left");
  });
});
