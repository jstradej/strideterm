import { beforeEach, describe, expect, test, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { peerAttachmentCopySchema } from "../../electron/shared/peers.js";
import type { PeerAttachmentCopyRun } from "../../electron/shared/peer-attachment-copy-events.js";

const showError = vi.fn();
const addAlertEvent = vi.fn((payload: { sourceAlertId?: string; threadKey?: string; title: string; body: string }) => ({
  event: { ...payload, id: `evt-${payload.sourceAlertId}` },
  inserted: true,
}));
const pushToast = vi.fn();
vi.mock("./notifications.js", () => ({
  useNotificationStore: () => ({ showError, addAlertEvent, pushToast, pinned: false }),
}));
vi.mock("../composables/useNotificationSound.js", () => ({ fireNotificationAlert: vi.fn() }));

import { usePeerAttachmentCopiesStore } from "./peer-attachment-copies.js";

type Handler = (payload: unknown) => void;

const COPY_ID = "11111111-1111-4111-8111-111111111111";
const TRANSFER_ID = "22222222-2222-4222-8222-222222222222";
const HOST_ID = "host-aaaa1111";

function makeApi() {
  const handlers: { finished?: Handler; progress?: Handler } = {};
  const api = {
    isRemote: false,
    onPeerAttachmentCopyProgress: vi.fn((handler: Handler) => {
      handlers.progress = handler;
      return () => {};
    }),
    onPeerAttachmentCopyFinished: vi.fn((handler: Handler) => {
      handlers.finished = handler;
      return () => {};
    }),
    startPeerAttachmentCopy: vi.fn(async (_input: unknown) => ({ copyId: COPY_ID })),
    cancelPeerAttachmentCopy: vi.fn(async (_copyId: string) => ({ ok: true as const })),
    listPeerAttachments: vi.fn(async (_hostId: string) => ({ items: [], truncated: false })),
  };
  return { api, handlers };
}

function run(overrides: Partial<PeerAttachmentCopyRun> = {}): PeerAttachmentCopyRun {
  return {
    copyId: COPY_ID,
    profileId: "default",
    workspaceId: "ws-1",
    hostId: HOST_ID,
    hostLabel: "macmini.local",
    source: { workspaceId: "host-ws", transferId: TRANSFER_ID, name: "photo.png", size: 2048, sha256: "a".repeat(64) },
    state: "succeeded",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:05.000Z",
    bytesDone: 2048,
    bytesTotal: 2048,
    result: {
      transferId: "local-1",
      path: ".strideterm/attachments/local-1/photo.png",
      name: "photo.png",
      size: 2048,
      sha256: "a".repeat(64),
    },
    ...overrides,
  };
}

function boot(root = "C:\\work\\repo") {
  setActivePinia(createPinia());
  const store = usePeerAttachmentCopiesStore();
  const { api, handlers } = makeApi();
  store.init(
    api as never,
    () => "default",
    () => root,
  );
  return { store, api, handlers };
}

beforeEach(() => {
  window.localStorage.clear();
  showError.mockClear();
  addAlertEvent.mockClear();
  pushToast.mockClear();
});

describe("peer attachment copies store", () => {
  test("a success is one Notification Center entry with the absolute path, from the event and from the payload", () => {
    const { store, handlers } = boot();
    handlers.finished!(run());
    handlers.finished!(run());
    store.reconcile({ running: [], lastResults: [run()] });
    expect(addAlertEvent).toHaveBeenCalledTimes(1);
    expect(addAlertEvent.mock.calls[0]![0]).toMatchObject({
      title: "Copied photo.png from macmini.local",
      body: "C:\\work\\repo\\.strideterm\\attachments\\local-1\\photo.png",
      category: "peer-attachment",
      sourceAlertId: `peer-attachment:${COPY_ID}`,
      meta: { path: "C:\\work\\repo\\.strideterm\\attachments\\local-1\\photo.png", copyId: COPY_ID },
    });
    expect(pushToast).toHaveBeenCalledTimes(1);
  });

  test("each copy gets its own notification thread, so a later copy into the same workspace does not hide an earlier one", () => {
    const { handlers } = boot();
    handlers.finished!(run());
    handlers.finished!(run({ copyId: "33333333-3333-4333-8333-333333333333" }));
    expect(addAlertEvent.mock.calls.map((call) => call[0].threadKey)).toEqual([
      COPY_ID,
      "33333333-3333-4333-8333-333333333333",
    ]);
  });

  test("a window that missed the event learns from the payload once, and not again after a reload", () => {
    const first = boot("/work/repo");
    first.store.reconcile({ running: [], lastResults: [run()] });
    first.store.reconcile({ running: [], lastResults: [run()] });
    expect(addAlertEvent).toHaveBeenCalledTimes(1);
    expect(addAlertEvent.mock.calls[0]![0]).toMatchObject({
      body: "/work/repo/.strideterm/attachments/local-1/photo.png",
    });
    const stored = JSON.parse(window.localStorage.getItem("strideterm-peer-attachment-copies-notified") || "[]");
    expect(stored).toEqual([COPY_ID]);

    const reloaded = boot("/work/repo");
    reloaded.store.reconcile({ running: [], lastResults: [run()] });
    expect(addAlertEvent).toHaveBeenCalledTimes(1);
  });

  test("a failed copy is one error toast, once; a cancelled copy says nothing", () => {
    const { store, handlers } = boot();
    const failed = run({ state: "failed", result: undefined, error: { message: "Host went away." } });
    handlers.finished!(failed);
    store.reconcile({ running: [], lastResults: [failed] });
    expect(showError).toHaveBeenCalledTimes(1);
    expect(showError.mock.calls[0]![1]).toBe("Host went away.");
    expect(addAlertEvent).not.toHaveBeenCalled();

    handlers.finished!(run({ copyId: "33333333-3333-4333-8333-333333333333", state: "cancelled", result: undefined }));
    expect(showError).toHaveBeenCalledTimes(1);
    expect(addAlertEvent).not.toHaveBeenCalled();
  });

  test("a copy of another profile is not announced", () => {
    const { store } = boot();
    store.reconcile({ running: [], lastResults: [run({ profileId: "other" })] });
    expect(addAlertEvent).not.toHaveBeenCalled();
  });

  test("a progress event advances the matching running copy only, never backwards and never a finished one", () => {
    const { store, handlers } = boot();
    const running = run({ state: "running", bytesDone: 512, finishedAt: null, result: undefined });
    store.reconcile({ running: [running] });
    handlers.progress!({ copyId: COPY_ID, bytesDone: 1024, bytesTotal: 2048 });
    expect(store.runFor(HOST_ID, TRANSFER_ID)).toMatchObject({ state: "running", bytesDone: 1024 });
    handlers.progress!({ copyId: COPY_ID, bytesDone: 256, bytesTotal: 2048 });
    expect(store.runFor(HOST_ID, TRANSFER_ID)?.bytesDone).toBe(1024);
    handlers.progress!({ copyId: "33333333-3333-4333-8333-333333333333", bytesDone: 1, bytesTotal: 2 });
    expect(Object.keys(store.runs)).toEqual([COPY_ID]);
    handlers.finished!(run());
    handlers.progress!({ copyId: COPY_ID, bytesDone: 4096, bytesTotal: 2048 });
    expect(store.runFor(HOST_ID, TRANSFER_ID)).toMatchObject({ state: "succeeded", bytesDone: 2048 });
  });

  test("the payload carries progress for a running copy and awaitFinished settles from it", async () => {
    const { store } = boot();
    store.reconcile({ running: [run({ state: "running", bytesDone: 512, finishedAt: null, result: undefined })] });
    expect(store.runFor(HOST_ID, TRANSFER_ID)?.bytesDone).toBe(512);
    const waiting = store.awaitFinished(COPY_ID);
    store.reconcile({ running: [], lastResults: [run()] });
    await expect(waiting).resolves.toMatchObject({ state: "succeeded" });
  });

  test("start sends a payload the real schema accepts and returns the copyId", async () => {
    const { store, api } = boot();
    const copyId = await store.start({
      hostId: HOST_ID,
      source: {
        workspaceId: "host-ws",
        transferId: TRANSFER_ID,
        name: "photo.png",
        size: 2048,
        sha256: "a".repeat(64),
      },
      targetWorkspaceId: "ws-1",
    });
    expect(copyId).toBe(COPY_ID);
    expect(peerAttachmentCopySchema.safeParse(api.startPeerAttachmentCopy.mock.calls[0]![0]).success).toBe(true);
    expect(store.runFor(HOST_ID, TRANSFER_ID)?.state).toBe("queued");
  });

  test("a refused start rejects", async () => {
    const { store, api } = boot();
    api.startPeerAttachmentCopy.mockRejectedValueOnce(new Error("Attachment quota exceeded"));
    await expect(
      store.start({
        hostId: HOST_ID,
        source: { workspaceId: "w", transferId: TRANSFER_ID, name: "a.png", size: 1, sha256: "b".repeat(64) },
        targetWorkspaceId: "ws-1",
      }),
    ).rejects.toThrow("quota");
  });

  test("a listing failure stays on the listing and is rethrown", async () => {
    const { store, api } = boot();
    api.listPeerAttachments.mockRejectedValueOnce(
      new Error("Error invoking remote method 'x': Error: Host is offline"),
    );
    await expect(store.loadListing(HOST_ID)).rejects.toThrow();
    expect(store.listings[HOST_ID]).toMatchObject({ loading: false, error: "Host is offline" });
  });

  test("a host too old to share attachments is a quiet note on the listing, not a failure", async () => {
    const { store, api } = boot();
    api.listPeerAttachments.mockRejectedValueOnce(
      Object.assign(new Error("Office runs an older strIDEterm that cannot share attachments."), {
        code: "unsupported",
        peerError: { code: "unsupported" },
      }),
    );
    await expect(store.loadListing(HOST_ID)).resolves.toBeUndefined();
    expect(store.listings[HOST_ID]).toMatchObject({
      loading: false,
      error: "",
      unsupported: "Office runs an older strIDEterm that cannot share attachments.",
    });
  });

  test("the collapsed state is remembered in storage", () => {
    const { store } = boot();
    store.setCollapsed(HOST_ID, true);
    expect(store.isCollapsed(HOST_ID)).toBe(true);
    expect(JSON.parse(window.localStorage.getItem("strideterm-peer-attachments-collapsed") || "{}")).toEqual({
      [HOST_ID]: true,
    });
    store.setCollapsed(HOST_ID, false);
    expect(store.isCollapsed(HOST_ID)).toBe(false);
  });
});
