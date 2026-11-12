import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { nextTick } from "vue";
import {
  sshFileDeleteSchema,
  sshFileDownloadSchema,
  sshFileListSchema,
  sshFileMkdirSchema,
  sshFileTransferCancelSchema,
  sshFileUploadSchema,
} from "../../../electron/backend/ipc-schemas.js";
import type { SshFileEntry } from "../../../electron/shared/ssh-file-events.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fakeApi: Record<string, any> = {};
const appState = {
  remote: false,
  mobile: false,
  workspaces: [
    {
      id: "ws-1",
      profileId: "default",
      cwd: "/work/app",
      gitRoots: ["/work/app", "/work/lib"],
      panels: [{ id: "panel-sftp", title: "Files · box", command: "__sftp__" }],
    },
    { id: "ws-2", profileId: "other", cwd: "/elsewhere", panels: [] },
  ],
};
const openDialog = vi.fn();
const closeDialog = vi.fn();
const confirmInApp = vi.fn(async () => true);
const showError = vi.fn();
const pushEphemeralToast = vi.fn();
const addAlertEvent = vi.fn((payload: { sourceAlertId?: string }) => ({ event: { ...payload }, inserted: true }));
const runWithToast = vi.fn(async (title: string, fn: () => Promise<unknown>) => {
  try {
    await fn();
    return true;
  } catch (error) {
    showError(title, error);
    return false;
  }
});

vi.mock("../../stores/app.js", () => ({
  useAppStore: () => ({
    getApi: () => fakeApi,
    get isRemoteTransport() {
      return appState.remote;
    },
    isMobileSession: () => appState.mobile,
    payload: { appState: { workspaces: appState.workspaces } },
    myActiveProfileId: "default",
    openDialog,
    closeDialog,
    confirmInApp,
  }),
}));
vi.mock("../../stores/notifications.js", () => ({
  useNotificationStore: () => ({ showError, runWithToast, pushEphemeralToast, addAlertEvent, pushToast: vi.fn() }),
}));
vi.mock("../../composables/useNotificationSound.js", () => ({ fireNotificationAlert: vi.fn() }));

import SftpBrowserPane from "./SftpBrowserPane.vue";
import { useSshFileTransfersStore } from "../../stores/ssh-file-transfers.js";
import { PATHS_MIME } from "../../lib/terminal-path-drop.js";

const NOW = Date.UTC(2026, 0, 2, 3, 4);
const entry = (overrides: Partial<SshFileEntry> & { name: string }): SshFileEntry => ({
  type: "file",
  size: 100,
  mtimeMs: NOW,
  mode: 0o644,
  ...overrides,
});
const LISTING = {
  path: "/srv",
  truncated: false,
  entries: [
    entry({ name: "b.txt", size: 2048 }),
    entry({ name: "docs", type: "dir", mode: 0o755 }),
    entry({ name: "a.txt" }),
    entry({ name: "latest", type: "symlink", linkTarget: "docs", mode: 0o777 }),
  ],
};

function resetApi() {
  for (const key of Object.keys(fakeApi)) delete fakeApi[key];
  fakeApi.isRemote = appState.remote;
  fakeApi.onSshFileTransferProgress = vi.fn();
  fakeApi.onSshFileTransferFinished = vi.fn();
  fakeApi.sshFileRealpath = vi.fn(async () => ({ path: "/srv" }));
  fakeApi.sshFileList = vi.fn(async ({ path }: { path?: string }) => ({
    ...LISTING,
    path: path ?? "/srv",
    entries: path === "/srv/docs" ? [entry({ name: "inner.md" })] : LISTING.entries,
  }));
  fakeApi.sshFileMkdir = vi.fn(async () => ({ ok: true }));
  fakeApi.sshFileRename = vi.fn(async () => ({ ok: true }));
  fakeApi.sshFileDelete = vi.fn(async () => ({ deleted: 1 }));
  fakeApi.sshFileUpload = vi.fn(async () => ({ started: true, transferId: "t-up" }));
  fakeApi.sshFileDownload = vi.fn(async () => ({ started: true, transferId: "t-down" }));
  fakeApi.sshFileTransferCancel = vi.fn(async () => ({ ok: true }));
  if (!appState.remote) {
    fakeApi.browsePaths = vi.fn(async () => ["/home/me/a.zip"]);
    fakeApi.browseDirectory = vi.fn(async () => "/home/me/Downloads");
    fakeApi.getPathForDroppedFile = vi.fn((file: File) => `/dropped/${file.name}`);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const wrappers: VueWrapper<any>[] = [];

async function mountPane() {
  setActivePinia(createPinia());
  window.localStorage.clear();
  resetApi();
  openDialog.mockClear();
  closeDialog.mockClear();
  showError.mockClear();
  pushEphemeralToast.mockClear();
  confirmInApp.mockClear();
  const transfers = useSshFileTransfersStore();
  transfers.init(fakeApi as never, () => "default");
  const wrapper = mount(SftpBrowserPane, {
    props: { workspaceId: "ws-1", panelId: "panel-sftp" },
    attachTo: document.body,
  });
  wrappers.push(wrapper);
  await flushPromises();
  return { wrapper, transfers };
}

const rowNames = (wrapper: VueWrapper) =>
  wrapper.findAll(".sftp-row:not(.sftp-row--head) .sftp-name").map((n) => n.text());

beforeEach(() => {
  appState.remote = false;
  appState.mobile = false;
});
afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
});

describe("SftpBrowserPane", () => {
  test("opens in the tab's start folder, folders first", async () => {
    const { wrapper } = await mountPane();
    expect(fakeApi.sshFileRealpath).toHaveBeenCalledWith({ workspaceId: "ws-1", panelId: "panel-sftp" });
    expect(rowNames(wrapper)).toEqual(["docs", "a.txt", "b.txt", "latest"]);
    expect((wrapper.find('[data-testid="sftp-path"]').element as HTMLInputElement).value).toBe("/srv");
    expect(wrapper.find('[data-testid="sftp-row-docs"]').text()).toContain("drwxr-xr-x");
    expect(wrapper.find('[data-testid="sftp-row-latest"]').text()).toContain("→ docs");
  });

  test("a double click opens a folder with a payload the main process accepts", async () => {
    const { wrapper } = await mountPane();
    await wrapper.find('[data-testid="sftp-row-docs"]').trigger("dblclick");
    await flushPromises();

    const sent = fakeApi.sshFileList.mock.calls.at(-1)![0];
    expect(sent).toEqual({ workspaceId: "ws-1", panelId: "panel-sftp", path: "/srv/docs" });
    expect(sshFileListSchema.safeParse(sent).success).toBe(true);
    expect(rowNames(wrapper)).toEqual(["inner.md"]);

    await wrapper.find('[data-testid="sftp-up"]').trigger("click");
    await flushPromises();
    expect(fakeApi.sshFileList.mock.calls.at(-1)![0].path).toBe("/srv");
  });

  test("clicking a column sorts, folders stay on top", async () => {
    const { wrapper } = await mountPane();
    const sizeHeader = wrapper.findAll(".sftp-cell--head").find((cell) => cell.text().startsWith("Size"))!;
    await sizeHeader.trigger("click");
    await sizeHeader.trigger("click");
    expect(rowNames(wrapper)).toEqual(["docs", "b.txt", "a.txt", "latest"]);
  });

  test("a failed listing is shown in the pane and reaches the notification store", async () => {
    setActivePinia(createPinia());
    resetApi();
    fakeApi.sshFileList = vi.fn(async () => {
      throw Object.assign(new Error("Connect the SSH tab first."), { code: "not-connected" });
    });
    showError.mockClear();
    useSshFileTransfersStore().init(fakeApi as never, () => "default");
    const wrapper = mount(SftpBrowserPane, { props: { workspaceId: "ws-1", panelId: "panel-sftp" } });
    wrappers.push(wrapper);
    await flushPromises();

    expect(wrapper.find('[data-testid="sftp-error"]').text()).toContain("Connect the SSH tab first.");
    expect(showError).toHaveBeenCalledWith("Couldn't open the remote folder", expect.any(Error), {
      workspaceId: "ws-1",
    });
  });

  test("Upload files… sends the picked paths into the current folder", async () => {
    const { wrapper } = await mountPane();
    await wrapper.find('[data-testid="sftp-upload-files"]').trigger("click");
    await flushPromises();

    expect(fakeApi.browsePaths).toHaveBeenCalledWith({ files: true, directories: false, title: "Upload files" });
    const sent = fakeApi.sshFileUpload.mock.calls[0]![0];
    expect(sent).toEqual({
      workspaceId: "ws-1",
      panelId: "panel-sftp",
      localPaths: ["/home/me/a.zip"],
      remoteDir: "/srv",
      conflict: "fail",
    });
    expect(sshFileUploadSchema.safeParse(sent).success).toBe(true);
  });

  test("Upload folder… asks for folders only", async () => {
    const { wrapper } = await mountPane();
    await wrapper.find('[data-testid="sftp-upload-folder"]').trigger("click");
    await flushPromises();
    expect(fakeApi.browsePaths).toHaveBeenCalledWith({ files: false, directories: true, title: "Upload folder" });
  });

  test("a conflict asks what to do, and Overwrite starts again with that policy", async () => {
    const { wrapper } = await mountPane();
    fakeApi.sshFileUpload.mockRejectedValueOnce(
      Object.assign(new Error("1 item already exists."), {
        code: "conflict",
        sshFileError: { code: "conflict", conflicts: ["/srv/a.zip"] },
      }),
    );
    await wrapper.find('[data-testid="sftp-upload-files"]').trigger("click");
    await flushPromises();

    expect(openDialog).toHaveBeenCalledWith(
      "SftpConflictDialog",
      expect.objectContaining({ conflicts: ["/srv/a.zip"] }),
    );
    const props = openDialog.mock.calls[0]![1] as { onChoose: (policy: string) => void };
    props.onChoose("overwrite");
    await flushPromises();

    expect(fakeApi.sshFileUpload).toHaveBeenCalledTimes(2);
    expect(fakeApi.sshFileUpload.mock.calls[1]![0].conflict).toBe("overwrite");
    expect(showError).not.toHaveBeenCalled();
  });

  test("cancelling the conflict dialog starts nothing", async () => {
    const { wrapper } = await mountPane();
    fakeApi.sshFileUpload.mockRejectedValueOnce(
      Object.assign(new Error("1 item already exists."), {
        code: "conflict",
        sshFileError: { code: "conflict", conflicts: ["/srv/a.zip"] },
      }),
    );
    await wrapper.find('[data-testid="sftp-upload-files"]').trigger("click");
    await flushPromises();
    (openDialog.mock.calls[0]![1] as { onCancel: () => void }).onCancel();
    await flushPromises();

    expect(fakeApi.sshFileUpload).toHaveBeenCalledTimes(1);
    expect(showError).not.toHaveBeenCalled();
  });

  test("any other start failure becomes an error toast", async () => {
    const { wrapper } = await mountPane();
    fakeApi.sshFileUpload.mockRejectedValueOnce(new Error("Connect the SSH tab first."));
    await wrapper.find('[data-testid="sftp-upload-files"]').trigger("click");
    await flushPromises();
    expect(showError).toHaveBeenCalledWith("Couldn't start the upload", expect.any(Error), { workspaceId: "ws-1" });
  });

  test("Download… on the desktop picks a folder and sends a valid payload", async () => {
    const { wrapper } = await mountPane();
    await wrapper.find('[data-testid="sftp-row-a.txt"]').trigger("click");
    await wrapper.find('[data-testid="sftp-row-b.txt"]').trigger("click", { ctrlKey: true });
    await wrapper.find('[data-testid="sftp-download"]').trigger("click");
    await flushPromises();

    const sent = fakeApi.sshFileDownload.mock.calls[0]![0];
    expect(sent).toEqual({
      workspaceId: "ws-1",
      panelId: "panel-sftp",
      remotePaths: ["/srv/a.txt", "/srv/b.txt"],
      localDir: "/home/me/Downloads",
      conflict: "fail",
    });
    expect(sshFileDownloadSchema.safeParse(sent).success).toBe(true);
  });

  test("a running transfer is listed, and Cancel sends only its id", async () => {
    const { wrapper, transfers } = await mountPane();
    transfers.reconcile({
      running: [
        {
          transferId: "t-run",
          profileId: "default",
          workspaceId: "ws-1",
          direction: "upload",
          source: "ui",
          hostLabel: "box",
          state: "running",
          startedAt: "2026-01-01T00:00:00.000Z",
          finishedAt: null,
          bytesDone: 50,
          bytesTotal: 100,
          filesDone: 0,
          filesTotal: 1,
          currentPath: "/home/me/a.zip",
        },
      ],
      lastRuns: [],
    });
    await flushPromises();
    expect(wrapper.find('[data-testid="sftp-transfer-t-run"]').text()).toContain("50%");

    await wrapper.find('[data-testid="sftp-transfer-cancel"]').trigger("click");
    await flushPromises();
    expect(fakeApi.sshFileTransferCancel).toHaveBeenCalledWith({ transferId: "t-run" });
    expect(sshFileTransferCancelSchema.safeParse(fakeApi.sshFileTransferCancel.mock.calls[0]![0]).success).toBe(true);
  });

  test("dropping paths dragged from the Files tab uploads them", async () => {
    const { wrapper } = await mountPane();
    const dataTransfer = {
      types: [PATHS_MIME],
      files: [],
      getData: (type: string) => (type === PATHS_MIME ? JSON.stringify(["/work/app/x.txt"]) : ""),
      dropEffect: "none",
    };
    await wrapper.find('[data-testid="sftp-list"]').trigger("drop", { dataTransfer });
    await flushPromises();
    expect(fakeApi.sshFileUpload.mock.calls[0]![0].localPaths).toEqual(["/work/app/x.txt"]);
  });

  test("dropping files from the OS uploads the paths the desktop reports", async () => {
    const { wrapper } = await mountPane();
    const file = new File(["x"], "report.pdf");
    const dataTransfer = { types: ["Files"], files: [file], getData: () => "" };
    await wrapper.find('[data-testid="sftp-list"]').trigger("drop", { dataTransfer });
    await flushPromises();
    expect(fakeApi.sshFileUpload.mock.calls[0]![0].localPaths).toEqual(["/dropped/report.pdf"]);
  });

  test("New folder creates it through a prompt and rereads the folder", async () => {
    const { wrapper } = await mountPane();
    await wrapper.find('[data-testid="sftp-new-folder"]').trigger("click");
    const props = openDialog.mock.calls[0]![1] as { onSubmit: (name: string) => Promise<void> };
    expect(openDialog.mock.calls[0]![0]).toBe("PromptDialog");
    await props.onSubmit("fresh");
    await flushPromises();

    const sent = fakeApi.sshFileMkdir.mock.calls[0]![0];
    expect(sent).toEqual({ workspaceId: "ws-1", panelId: "panel-sftp", path: "/srv/fresh" });
    expect(sshFileMkdirSchema.safeParse(sent).success).toBe(true);
    expect(fakeApi.sshFileList.mock.calls.length).toBeGreaterThan(1);
  });

  test("a refused folder name keeps the New folder dialog open and reports why", async () => {
    const { wrapper } = await mountPane();
    fakeApi.sshFileMkdir.mockRejectedValueOnce(new Error("A folder named fresh already exists."));
    await wrapper.find('[data-testid="sftp-new-folder"]').trigger("click");
    const props = openDialog.mock.calls[0]![1] as { onSubmit: (name: string) => Promise<void> };
    await props.onSubmit("fresh");
    await flushPromises();

    expect(showError).toHaveBeenCalledWith("Couldn't create the folder", expect.any(Error));
    expect(closeDialog).not.toHaveBeenCalled();
  });

  test("Delete asks first, and a folder in the selection is deleted recursively", async () => {
    const { wrapper } = await mountPane();
    await wrapper.find('[data-testid="sftp-row-docs"]').trigger("click");
    await wrapper.find('[data-testid="sftp-row-docs"]').trigger("contextmenu", { clientX: 5, clientY: 5 });
    await wrapper.find('[data-testid="sftp-menu-delete"]').trigger("click");
    await flushPromises();

    expect(confirmInApp).toHaveBeenCalledWith(expect.objectContaining({ danger: true, confirmLabel: "Delete" }));
    const sent = fakeApi.sshFileDelete.mock.calls[0]![0];
    expect(sent).toEqual({ workspaceId: "ws-1", panelId: "panel-sftp", paths: ["/srv/docs"], recursive: true });
    expect(sshFileDeleteSchema.safeParse(sent).success).toBe(true);
  });

  test("declining the delete confirmation deletes nothing", async () => {
    const { wrapper } = await mountPane();
    confirmInApp.mockResolvedValueOnce(false);
    await wrapper.find('[data-testid="sftp-row-a.txt"]').trigger("click");
    await wrapper.trigger("keydown", { key: "Delete" });
    await flushPromises();
    expect(fakeApi.sshFileDelete).not.toHaveBeenCalled();
  });

  test("a folder being created shows a busy indicator until the server answers", async () => {
    const { wrapper } = await mountPane();
    let answer!: (value: unknown) => void;
    fakeApi.sshFileMkdir = vi.fn(() => new Promise((resolve) => (answer = resolve)));
    await wrapper.find('[data-testid="sftp-new-folder"]').trigger("click");
    const props = openDialog.mock.calls[0]![1] as { onSubmit: (name: string) => Promise<void> };
    const submitted = props.onSubmit("fresh");
    await flushPromises();

    expect(wrapper.find('[data-testid="sftp-busy"]').text()).toContain("Creating folder…");
    expect(wrapper.find('[data-testid="sftp-new-folder"]').attributes("disabled")).toBeDefined();

    answer({ ok: true });
    await submitted;
    await flushPromises();
    expect(wrapper.find('[data-testid="sftp-busy"]').exists()).toBe(false);
  });

  test("the first load says it is connecting, before the folder is known", async () => {
    setActivePinia(createPinia());
    window.localStorage.clear();
    resetApi();
    fakeApi.sshFileRealpath = vi.fn(() => new Promise(() => {}));
    useSshFileTransfersStore().init(fakeApi as never, () => "default");
    const wrapper = mount(SftpBrowserPane, { props: { workspaceId: "ws-1", panelId: "panel-sftp" } });
    wrappers.push(wrapper);
    await nextTick();

    expect(wrapper.find('[data-testid="sftp-loading"]').text()).toContain("Connecting…");
  });
});

describe("SftpBrowserPane as a remote client", () => {
  beforeEach(() => {
    appState.remote = true;
  });

  test("hides the native pickers and explains how to upload", async () => {
    const { wrapper } = await mountPane();
    expect(wrapper.find('[data-testid="sftp-upload-files"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="sftp-upload-folder"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="sftp-remote-hint"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="sftp-download"]').exists()).toBe(true);
  });

  test("Download… chooses a workspace folder of the profile, not a native dialog", async () => {
    const { wrapper } = await mountPane();
    await wrapper.find('[data-testid="sftp-row-a.txt"]').trigger("click");
    await wrapper.find('[data-testid="sftp-download"]').trigger("click");
    await flushPromises();

    expect(openDialog).toHaveBeenCalledWith(
      "SftpDownloadTargetDialog",
      expect.objectContaining({ roots: ["/work/app", "/work/lib"] }),
    );
    (openDialog.mock.calls[0]![1] as { onSubmit: (dir: string) => void }).onSubmit("/work/app/downloads");
    await flushPromises();
    expect(fakeApi.sshFileDownload.mock.calls[0]![0]).toMatchObject({
      remotePaths: ["/srv/a.txt"],
      localDir: "/work/app/downloads",
    });
  });

  test("dropping a file from the OS is refused with an explanation", async () => {
    const { wrapper } = await mountPane();
    const dataTransfer = { types: ["Files"], files: [new File(["x"], "r.pdf")], getData: () => "" };
    await wrapper.find('[data-testid="sftp-list"]').trigger("drop", { dataTransfer });
    await flushPromises();
    expect(fakeApi.sshFileUpload).not.toHaveBeenCalled();
    expect(pushEphemeralToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Cannot drop here" }));
  });
});

describe("SftpBrowserPane as a mobile session", () => {
  beforeEach(() => {
    appState.remote = true;
    appState.mobile = true;
  });

  test("never offers Download, in the toolbar or the menu, and download does nothing if called", async () => {
    const { wrapper } = await mountPane();
    expect(wrapper.find('[data-testid="sftp-download"]').exists()).toBe(false);
    await wrapper.find('[data-testid="sftp-row-a.txt"]').trigger("contextmenu", { clientX: 1, clientY: 1 });
    expect(wrapper.find('[data-testid="sftp-menu"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="sftp-menu-download"]').exists()).toBe(false);
    expect(fakeApi.sshFileDownload).not.toHaveBeenCalled();
  });
});
