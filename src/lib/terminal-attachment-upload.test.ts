import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useNotificationStore } from "../stores/notifications.js";
import { canUploadToTerminal, pastedImageName, uploadFilesToTerminal } from "./terminal-attachment-upload.js";

function fakeFile(name: string, size = 5): File {
  return { name, size, slice: () => ({ arrayBuffer: async () => new Uint8Array(size).buffer }) } as unknown as File;
}

function makeApi(overrides: Record<string, unknown> = {}) {
  return {
    isRemote: true,
    attachmentUploadBegin: vi.fn(async () => ({ transferId: "xfer", chunkBytes: 1024, received: 0 })),
    attachmentUploadChunk: vi.fn(async (req: { offset: number }) => ({ received: req.offset + 5 })),
    attachmentUploadFinish: vi.fn(async () => ({
      transferId: "xfer",
      path: ".strideterm/attachments/xfer/my shot.png",
      size: 5,
      sha256: "a".repeat(64),
      name: "my shot.png",
    })),
    attachmentUploadCancel: vi.fn(async () => undefined),
    ...overrides,
  };
}

function payload(
  platform: string,
  cwd: string,
  panel: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
) {
  return {
    meta: { platform },
    appState: { workspaces: [{ id: "ws1", cwd, panels: [{ id: "p1", title: "t", command: "", ...panel }], ...extra }] },
  };
}

describe("uploadFilesToTerminal", () => {
  let showError: ReturnType<typeof vi.fn>;
  let toast: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setActivePinia(createPinia());
    const store = useNotificationStore();
    showError = vi.fn();
    toast = vi.fn(() => "toast-1");
    store.showError = showError as never;
    store.pushEphemeralToast = toast as never;
    store.dismissPersistentToast = vi.fn() as never;
  });

  it("uploads to the active workspace and types the quoted path of the backend machine (posix)", async () => {
    const write = vi.fn();
    const api = makeApi();
    await uploadFilesToTerminal({
      api: api as never,
      sessionId: "ws1:p1",
      files: [fakeFile("my shot.png")],
      payload: payload("linux", "/home/dev/proj") as never,
      write,
    });
    expect(api.attachmentUploadBegin).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws1", name: "my shot.png", size: 5 }),
    );
    expect(write).toHaveBeenCalledWith("'/home/dev/proj/.strideterm/attachments/xfer/my shot.png' ");
  });

  it("builds the path with the separator of the backend platform (windows) and quotes it for PowerShell", async () => {
    const write = vi.fn();
    await uploadFilesToTerminal({
      api: makeApi() as never,
      sessionId: "ws1:p1",
      files: [fakeFile("my shot.png")],
      payload: payload("win32", "C:\\Work\\proj", { command: "pwsh" }) as never,
      write,
    });
    expect(write).toHaveBeenCalledWith("'C:\\Work\\proj\\.strideterm\\attachments\\xfer\\my shot.png' ");
  });

  it("types nothing for a cancelled upload", async () => {
    const write = vi.fn();
    let cancelToast: (() => void) | undefined;
    toast.mockImplementation((args: { undo?: { run: () => void } }) => {
      cancelToast = args.undo?.run;
      return "t";
    });
    let release!: (value: { received: number }) => void;
    const api = makeApi({
      attachmentUploadChunk: vi.fn(() => new Promise<{ received: number }>((resolve) => (release = resolve))),
    });
    vi.useFakeTimers();
    const done = uploadFilesToTerminal({
      api: api as never,
      sessionId: "ws1:p1",
      files: [fakeFile("a.png", 10)],
      payload: payload("linux", "/w") as never,
      write,
    });
    await vi.advanceTimersByTimeAsync(500);
    vi.useRealTimers();
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Uploading to the terminal" }));
    cancelToast!();
    release({ received: 5 });
    await done;
    expect(write).not.toHaveBeenCalled();
    expect(api.attachmentUploadCancel).toHaveBeenCalledOnce();
    expect(showError).not.toHaveBeenCalled();
  });

  it("types nothing for a failed upload and raises an error with the server sentence", async () => {
    const write = vi.fn();
    const sentence = "The workspace already holds 100 attachments.";
    await uploadFilesToTerminal({
      api: makeApi({
        attachmentUploadBegin: vi.fn(async () => {
          throw new Error(sentence);
        }),
      }) as never,
      sessionId: "ws1:p1",
      files: [fakeFile("a.png")],
      payload: payload("linux", "/w", {}, { profileId: "work" }) as never,
      write,
    });
    expect(write).not.toHaveBeenCalled();
    expect(showError).toHaveBeenCalledWith("Upload failed", sentence, { workspaceId: "ws1", profileId: "work" });
  });

  it("refuses SSH terminals and container workspaces without uploading", async () => {
    const api = makeApi();
    const write = vi.fn();
    await uploadFilesToTerminal({
      api: api as never,
      sessionId: "ws1:p1",
      files: [fakeFile("a.png")],
      payload: payload("linux", "/w", { launch: { kind: "ssh" } }) as never,
      write,
    });
    await uploadFilesToTerminal({
      api: api as never,
      sessionId: "ws1:p1",
      files: [fakeFile("a.png")],
      payload: payload("linux", "/w", {}, { kind: "docker" }) as never,
      write,
    });
    expect(api.attachmentUploadBegin).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledTimes(2);
    expect(write).not.toHaveBeenCalled();
  });

  it.each([["resolves"], ["rejects"]])(
    "the toast says finishing instead of freezing at 100 % while the host verifies the file, and ends when it %s",
    async (how) => {
      const dismiss = useNotificationStore().dismissPersistentToast as unknown as ReturnType<typeof vi.fn>;
      let finish!: { resolve: (_value: unknown) => void; reject: (_reason: unknown) => void };
      const api = makeApi({
        attachmentUploadFinish: vi.fn(
          () =>
            new Promise((resolve, reject) => {
              finish = { resolve, reject };
            }),
        ),
      });
      vi.useFakeTimers();
      try {
        const done = uploadFilesToTerminal({
          api: api as never,
          sessionId: "ws1:p1",
          files: [fakeFile("a.png")],
          payload: payload("linux", "/w") as never,
          write: vi.fn(),
        });
        await vi.advanceTimersByTimeAsync(500);
        const bodies = toast.mock.calls.map(([args]) => (args as { body: string }).body);
        expect(bodies.at(-1)).toBe("a.png (finishing…)");
        expect(bodies.some((body) => body.includes("100 %"))).toBe(false);

        if (how === "resolves")
          finish.resolve({ transferId: "xfer", path: ".s/a.png", size: 5, sha256: "a", name: "a.png" });
        else finish.reject(new Error("The checksum did not match."));
        await done;
        expect(dismiss).toHaveBeenCalled();
        if (how === "rejects")
          expect(showError).toHaveBeenCalledWith("Upload failed", "The checksum did not match.", expect.anything());
      } finally {
        vi.useRealTimers();
      }
    },
  );
});

describe("helpers", () => {
  it("uploads from a terminal only in a remote window that has the upload API", () => {
    expect(canUploadToTerminal(makeApi())).toBe(true);
    expect(canUploadToTerminal(makeApi({ isRemote: false }))).toBe(false);
    expect(canUploadToTerminal({ isRemote: true })).toBe(false);
  });

  it("names generic screenshots by time and keeps real names", () => {
    const now = new Date("2026-11-20T14:30:12.345Z");
    expect(pastedImageName({ name: "image.png", type: "image/png" } as File, now)).toBe("pasted-20261120-143012.png");
    expect(pastedImageName({ name: "", type: "image/jpeg" } as File, now)).toBe("pasted-20261120-143012.jpg");
    expect(pastedImageName({ name: "diagram.svg", type: "image/svg+xml" } as File, now)).toBe("diagram.svg");
  });
});
