import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  peerAttachmentCopySchema,
  type PeerAttachedHost,
  type PeerAttachmentItem,
} from "../../../electron/shared/peers.js";
import type { PeerAttachmentCopyRun } from "../../../electron/shared/peer-attachment-copy-events.js";
import type { AttachmentRecord } from "../../attachments.js";
import { apiKey } from "../../types/keys.js";
import { setWindowBackend } from "../../window-backend.js";

const openProfilesDialog = vi.fn();
vi.mock("../../stores/app.js", () => ({ useAppStore: () => ({ openProfilesDialog }) }));

import WorkspaceAttachments from "./WorkspaceAttachments.vue";
import CustomSelect from "../common/CustomSelect.vue";
import { useNotificationStore } from "../../stores/notifications.js";
import { usePeerAttachmentCopiesStore } from "../../stores/peer-attachment-copies.js";
import { usePeersStore } from "../../stores/peers.js";

const HOST_ID = "host-aaaa1111";
const COPY_ID = "11111111-1111-4111-8111-111111111111";

function host(overrides: Partial<PeerAttachedHost> = {}): PeerAttachedHost {
  return {
    id: HOST_ID,
    label: "macmini.local",
    address: "10.0.0.5",
    port: 47821,
    hostPublicKey: "",
    pairedAt: 1,
    state: "online",
    hostAppVersion: "3.4.1",
    localAppVersion: "3.4.1",
    profiles: [],
    checkedAt: 1,
    ...overrides,
  };
}

let sequence = 0;
function item(overrides: Partial<PeerAttachmentItem> = {}): PeerAttachmentItem {
  sequence += 1;
  return {
    profileId: "p1",
    profileName: "Work",
    workspaceId: "host-ws-1",
    workspaceName: "api",
    transferId: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    name: `file-${sequence}.png`,
    size: 2048,
    sha256: sequence.toString(16).padStart(64, "0"),
    uploadedAt: Date.now() - sequence * 1000,
    ...overrides,
  };
}

function runOf(source: PeerAttachmentItem, overrides: Partial<PeerAttachmentCopyRun> = {}): PeerAttachmentCopyRun {
  return {
    copyId: COPY_ID,
    profileId: "default",
    workspaceId: "ws-1",
    hostId: HOST_ID,
    hostLabel: "macmini.local",
    source: {
      workspaceId: source.workspaceId,
      transferId: source.transferId,
      name: source.name,
      size: source.size,
      sha256: source.sha256,
    },
    state: "running",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: null,
    bytesDone: 512,
    bytesTotal: source.size,
    ...overrides,
  };
}

const TARGETS = [
  { id: "ws-1", name: "repo" },
  { id: "ws-2", name: "docs" },
];

function makeApi(items: PeerAttachmentItem[], extra: Record<string, unknown> = {}) {
  return {
    isRemote: false,
    attachmentList: vi.fn().mockResolvedValue([]),
    openTerminalPath: vi.fn().mockResolvedValue({ ok: true }),
    listPeerAttachments: vi.fn().mockResolvedValue({ items, truncated: false }),
    startPeerAttachmentCopy: vi.fn().mockResolvedValue({ copyId: COPY_ID }),
    cancelPeerAttachmentCopy: vi.fn().mockResolvedValue({ ok: true }),
    onPeerAttachmentCopyFinished: vi.fn(() => () => {}),
    ...extra,
  };
}

function mountPanel(
  api: ReturnType<typeof makeApi>,
  hosts: PeerAttachedHost[] = [host()],
  props: Record<string, unknown> = {},
) {
  const peers = usePeersStore();
  peers.hosts = hosts;
  const copies = usePeerAttachmentCopiesStore();
  copies.init(
    api as never,
    () => "default",
    () => "C:\\work\\repo",
  );
  const wrapper = mount(WorkspaceAttachments, {
    props: {
      workspaceId: "ws-1",
      workspaceRoot: "C:\\work\\repo",
      workspaceName: "repo",
      copyTargets: TARGETS,
      openByDefault: true,
      panel: true,
      ...props,
    },
    global: { provide: { [apiKey as symbol]: api }, stubs: { teleport: true } },
  });
  return { wrapper, copies, peers };
}

const rows = (wrapper: ReturnType<typeof mount>) => wrapper.findAll("[data-role='peer-attachment-row']");

let showError: ReturnType<typeof vi.fn>;

beforeEach(() => {
  setActivePinia(createPinia());
  window.localStorage.clear();
  setWindowBackend({ kind: "local" });
  openProfilesDialog.mockClear();
  showError = vi.fn();
  vi.spyOn(useNotificationStore(), "showError").mockImplementation(showError as never);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("PeerAttachmentsSection", () => {
  it("lists an online host with the profile / workspace label and a muted status row for an offline one", async () => {
    const first = item();
    const api = makeApi([first]);
    const { wrapper } = mountPanel(api, [host(), host({ id: "host-bbbb2222", label: "nas.local", state: "offline" })]);
    await flushPromises();
    expect(api.listPeerAttachments).toHaveBeenCalledTimes(1);
    expect(api.listPeerAttachments).toHaveBeenCalledWith(HOST_ID);
    const sections = wrapper.findAll("[data-role='peer-attachments-host']");
    expect(sections).toHaveLength(2);
    expect(rows(wrapper)).toHaveLength(1);
    expect(wrapper.find("[data-role='peer-attachment-label']").text()).toBe("Work / api");
    const offline = sections[1]!;
    expect(offline.find("[data-role='peer-attachments-status']").text()).toContain("nas.local is offline");
    expect(offline.findAll("[data-role='peer-attachment-row']")).toHaveLength(0);
    await offline.find("[data-role='peer-attachments-profiles']").trigger("click");
    expect(openProfilesDialog).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["not-paired", "no longer pairs"],
    ["version-mismatch", "different version"],
    ["wrong-host", "Another strIDEterm"],
  ] as const)("shows a status row and no list for a %s host", async (state, text) => {
    const api = makeApi([item()]);
    const { wrapper } = mountPanel(api, [host({ state })]);
    await flushPromises();
    expect(wrapper.find("[data-role='peer-attachments-status']").text()).toContain(text);
    expect(rows(wrapper)).toHaveLength(0);
    expect(api.listPeerAttachments).not.toHaveBeenCalled();
  });

  it("shows the newest 10 and the rest behind Show all", async () => {
    const api = makeApi(Array.from({ length: 13 }, () => item()));
    const { wrapper } = mountPanel(api);
    await flushPromises();
    expect(rows(wrapper)).toHaveLength(10);
    const more = wrapper.find("[data-role='peer-attachments-show-all']");
    expect(more.text()).toBe("Show all (13)");
    await more.trigger("click");
    expect(rows(wrapper)).toHaveLength(13);
  });

  it("filters host rows by name and by the profile / workspace label", async () => {
    const api = makeApi([
      item({ name: "alpha.png", profileName: "Work", workspaceName: "api" }),
      item({ name: "beta.png", profileName: "Home", workspaceName: "photos" }),
    ]);
    const { wrapper } = mountPanel(api);
    await flushPromises();
    await wrapper.find("input[type='search']").setValue("home / pho");
    expect(rows(wrapper)).toHaveLength(1);
    expect(rows(wrapper)[0]!.text()).toContain("beta.png");
    await wrapper.find("input[type='search']").setValue("alpha");
    expect(rows(wrapper)).toHaveLength(1);
    expect(rows(wrapper)[0]!.text()).toContain("alpha.png");
    await wrapper.find("input[type='search']").setValue("nothing");
    expect(wrapper.find("[data-role='peer-attachments-empty']").text()).toBe("No matching attachments.");
  });

  it("offers the days of host attachments in the day filter and applies the choice to them", async () => {
    const today = new Date();
    today.setHours(10, 0, 0, 0);
    const old = new Date(today);
    old.setDate(old.getDate() - 3);
    const api = makeApi([
      item({ name: "new.png", uploadedAt: today.getTime() }),
      item({ name: "old.png", uploadedAt: old.getTime() }),
    ]);
    const { wrapper } = mountPanel(api);
    await flushPromises();
    const dayFilter = wrapper.findComponent(CustomSelect);
    const options = (dayFilter.props() as unknown as { options: Array<{ value: string }> }).options.map(
      (option) => option.value,
    );
    expect(options).toContain("today");
    expect(options.length).toBe(3);
    const dayOfOld = options.find((value) => value && value !== "today")!;
    await dayFilter.setValue(dayOfOld);
    expect(rows(wrapper).map((row) => row.text())).toEqual([expect.stringContaining("old.png")]);
  });

  it("Copy here sends a schema-valid request for the shown workspace and shows progress with Cancel", async () => {
    const source = item({ name: "photo.png", size: 2048 });
    const api = makeApi([source]);
    const { wrapper, copies } = mountPanel(api);
    await flushPromises();
    const button = wrapper.find("[data-role='peer-attachment-copy-here']");
    expect(button.attributes("title")).toBe("Copy into repo");
    await button.trigger("click");
    await flushPromises();
    const request = api.startPeerAttachmentCopy.mock.calls[0]![0];
    expect(peerAttachmentCopySchema.safeParse(request).success).toBe(true);
    expect(request).toMatchObject({
      hostId: HOST_ID,
      targetWorkspaceId: "ws-1",
      source: { transferId: source.transferId, workspaceId: "host-ws-1" },
    });
    copies.reconcile({ running: [runOf(source, { bytesDone: 1024 })], lastResults: [] });
    await flushPromises();
    expect(wrapper.find("[data-role='peer-attachment-progress']").text()).toContain("50 %");
    expect(wrapper.find("[role='progressbar']").attributes("aria-valuenow")).toBe("50");
    await wrapper.find("[data-role='peer-attachment-cancel']").trigger("click");
    await flushPromises();
    expect(api.cancelPeerAttachmentCopy).toHaveBeenCalledWith(COPY_ID);
    expect(wrapper.find("[data-role='peer-attachment-copy-here']").exists()).toBe(false);
  });

  it("Copy to lists the other workspaces of the window profile and copies into the chosen one", async () => {
    const source = item();
    const api = makeApi([source]);
    const { wrapper } = mountPanel(api);
    await flushPromises();
    await wrapper.find("[data-role='peer-attachment-menu-trigger']").trigger("click");
    const targets = wrapper.findAll("[data-role='peer-attachment-copy-to']");
    expect(targets.map((target) => target.attributes("data-workspace-id"))).toEqual(["ws-2"]);
    await targets[0]!.trigger("click");
    await flushPromises();
    const request = api.startPeerAttachmentCopy.mock.calls[0]![0];
    expect(request).toMatchObject({ targetWorkspaceId: "ws-2" });
    expect(peerAttachmentCopySchema.safeParse(request).success).toBe(true);
  });

  it("disables Copy here with the existing reason for an SSH workspace but keeps Copy to", async () => {
    const api = makeApi([item()]);
    const reason = "Attachments are not available in SSH workspaces.";
    const { wrapper } = mountPanel(api, [host()], { unavailableReason: reason });
    await flushPromises();
    const button = wrapper.find("[data-role='peer-attachment-copy-here']");
    expect(button.attributes("disabled")).toBeDefined();
    expect(button.attributes("title")).toBe(reason);
    await wrapper.find("[data-role='peer-attachment-menu-trigger']").trigger("click");
    expect(wrapper.find("[data-role='peer-attachment-menu-copy-here']").attributes("disabled")).toBeDefined();
    expect(wrapper.findAll("[data-role='peer-attachment-copy-to']").length).toBe(1);
  });

  it("marks a row Copied by sha256 and offers Copy path instead of Copy here", async () => {
    const source = item({ name: "photo.png" });
    const local: AttachmentRecord = {
      transferId: "local-1",
      path: ".strideterm/attachments/local-1/photo.png",
      size: 2048,
      sha256: source.sha256,
      name: "photo.png",
    };
    const api = makeApi([source], { attachmentList: vi.fn().mockResolvedValue([local]) });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const { wrapper } = mountPanel(api);
    await flushPromises();
    expect(wrapper.find("[data-role='peer-attachment-copied']").exists()).toBe(true);
    expect(wrapper.find("[data-role='peer-attachment-copy-here']").exists()).toBe(false);
    await wrapper.find("[data-role='peer-attachment-copy-path']").trigger("click");
    await flushPromises();
    expect(writeText).toHaveBeenCalledWith("C:\\work\\repo\\.strideterm\\attachments\\local-1\\photo.png");
  });

  it("Copy here and open copies first and opens the result once the copy succeeded", async () => {
    const source = item({ name: "photo.png" });
    const api = makeApi([source]);
    const { wrapper, copies } = mountPanel(api);
    await flushPromises();
    await wrapper.find("[data-role='peer-attachment-open']").trigger("click");
    await flushPromises();
    expect(api.startPeerAttachmentCopy).toHaveBeenCalledTimes(1);
    expect(api.openTerminalPath).not.toHaveBeenCalled();
    copies.reconcile({
      running: [],
      lastResults: [
        runOf(source, {
          state: "succeeded",
          finishedAt: "2026-01-01T00:00:05.000Z",
          bytesDone: 2048,
          result: {
            transferId: "local-1",
            path: ".strideterm/attachments/local-1/photo.png",
            name: "photo.png",
            size: 2048,
            sha256: source.sha256,
          },
        }),
      ],
    });
    await flushPromises();
    expect(api.openTerminalPath).toHaveBeenCalledWith({
      path: ".strideterm/attachments/local-1/photo.png",
      workspaceCwd: "C:\\work\\repo",
      forceSystem: true,
    });
  });

  it("opens an already copied file without copying again", async () => {
    const source = item({ name: "photo.png" });
    const local: AttachmentRecord = {
      transferId: "local-1",
      path: ".strideterm/attachments/local-1/photo.png",
      size: 2048,
      sha256: source.sha256,
      name: "photo.png",
    };
    const api = makeApi([source], { attachmentList: vi.fn().mockResolvedValue([local]) });
    const { wrapper } = mountPanel(api);
    await flushPromises();
    await wrapper.find("[data-role='peer-attachment-open']").trigger("click");
    await flushPromises();
    expect(api.startPeerAttachmentCopy).not.toHaveBeenCalled();
    expect(api.openTerminalPath).toHaveBeenCalledWith(expect.objectContaining({ path: local.path }));
  });

  it("a refused start is an error in the row and a toast", async () => {
    const api = makeApi([item()]);
    api.startPeerAttachmentCopy.mockRejectedValueOnce(new Error("Attachment quota exceeded"));
    const { wrapper } = mountPanel(api);
    await flushPromises();
    await wrapper.find("[data-role='peer-attachment-copy-here']").trigger("click");
    await flushPromises();
    expect(wrapper.find("[data-role='peer-attachment-failure']").text()).toBe("Attachment quota exceeded");
    expect(showError).toHaveBeenCalledTimes(1);
    expect(wrapper.find("[data-role='peer-attachment-copy-here']").text()).toBe("Retry");
  });

  it("a failed run shows its error in the row, offers Retry, and Retry starts the copy again", async () => {
    const source = item();
    const api = makeApi([source]);
    const { wrapper, copies } = mountPanel(api);
    await flushPromises();
    copies.reconcile({
      running: [],
      lastResults: [
        runOf(source, {
          state: "failed",
          finishedAt: "2026-01-01T00:00:05.000Z",
          error: { message: "Host went away." },
        }),
      ],
    });
    await flushPromises();
    expect(wrapper.find("[data-role='peer-attachment-failure']").text()).toBe("Host went away.");
    await wrapper.find("[data-role='peer-attachment-copy-here']").trigger("click");
    await flushPromises();
    expect(api.startPeerAttachmentCopy).toHaveBeenCalledTimes(1);
  });

  it("Retry copies into the workspace the failed run was for, and the row names that target", async () => {
    const source = item();
    const api = makeApi([source]);
    const { wrapper, copies } = mountPanel(api);
    await flushPromises();
    copies.reconcile({
      running: [],
      lastResults: [
        runOf(source, {
          workspaceId: "ws-2",
          state: "failed",
          finishedAt: "2026-01-01T00:00:05.000Z",
          error: { message: "Host went away." },
        }),
      ],
    });
    await flushPromises();
    expect(wrapper.find("[data-role='peer-attachment-failure']").text()).toBe("Copy to docs failed: Host went away.");
    await wrapper.find("[data-role='peer-attachment-copy-here']").trigger("click");
    await flushPromises();
    expect(api.startPeerAttachmentCopy).toHaveBeenCalledTimes(1);
    const sent = api.startPeerAttachmentCopy.mock.calls[0]![0] as { targetWorkspaceId: string };
    expect(sent.targetWorkspaceId).toBe("ws-2");
    expect(peerAttachmentCopySchema.safeParse(sent).success).toBe(true);
  });

  it("Discard sits next to Retry on a failed run, drops it through the transport, and is absent for a refused start", async () => {
    const source = item();
    const api = makeApi([source]);
    const { wrapper, copies } = mountPanel(api);
    await flushPromises();
    expect(wrapper.find("[data-role='peer-attachment-discard']").exists()).toBe(false);
    copies.reconcile({
      running: [],
      lastResults: [
        runOf(source, {
          state: "failed",
          finishedAt: "2026-01-01T00:00:05.000Z",
          error: { message: "Host went away." },
        }),
      ],
    });
    await flushPromises();
    await wrapper.find("[data-role='peer-attachment-discard']").trigger("click");
    await flushPromises();
    expect(api.cancelPeerAttachmentCopy).toHaveBeenCalledWith(COPY_ID);

    showError.mockClear();
    api.cancelPeerAttachmentCopy.mockRejectedValueOnce(new Error("Could not remove it"));
    await wrapper.find("[data-role='peer-attachment-discard']").trigger("click");
    await flushPromises();
    expect(showError).toHaveBeenCalledTimes(1);

    const other = item();
    const refused = makeApi([other]);
    refused.startPeerAttachmentCopy.mockRejectedValueOnce(new Error("Attachment quota exceeded"));
    const second = mountPanel(refused);
    await flushPromises();
    await second.wrapper.find("[data-role='peer-attachment-copy-here']").trigger("click");
    await flushPromises();
    expect(second.wrapper.find("[data-role='peer-attachment-discard']").exists()).toBe(false);
  });

  it("reloads the local list at once when a copy into this workspace succeeds, so the row shows Copied", async () => {
    const source = item({ name: "photo.png" });
    const api = makeApi([source]);
    const { wrapper, copies } = mountPanel(api);
    await flushPromises();
    const loads = api.attachmentList.mock.calls.length;
    const copied: AttachmentRecord = {
      transferId: "local-1",
      path: ".strideterm/attachments/local-1/photo.png",
      name: "photo.png",
      size: 2048,
      sha256: source.sha256,
    } as AttachmentRecord;
    api.attachmentList.mockResolvedValue([copied]);
    const finished = runOf(source, {
      state: "succeeded",
      finishedAt: "2026-01-01T00:00:05.000Z",
      bytesDone: 2048,
      result: { transferId: "local-1", path: copied.path, name: "photo.png", size: 2048, sha256: source.sha256 },
    });
    copies.reconcile({ running: [], lastResults: [finished] });
    await flushPromises();
    expect(api.attachmentList.mock.calls.length).toBe(loads + 1);
    expect(wrapper.find("[data-role='peer-attachment-copied']").exists()).toBe(true);
    expect(wrapper.find("[data-role='peer-attachment-copy-here']").exists()).toBe(false);

    copies.reconcile({
      running: [],
      lastResults: [{ ...finished, copyId: "33333333-3333-4333-8333-333333333333", workspaceId: "ws-2" }],
    });
    await flushPromises();
    expect(api.attachmentList.mock.calls.length).toBe(loads + 1);
  });

  it("refreshes every 30 s only while the host is online and the page is visible", async () => {
    vi.useFakeTimers();
    const api = makeApi([item()]);
    const { wrapper, peers } = mountPanel(api);
    await flushPromises();
    expect(api.listPeerAttachments).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.listPeerAttachments).toHaveBeenCalledTimes(2);

    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.listPeerAttachments).toHaveBeenCalledTimes(2);
    hidden.mockReturnValue(false);

    peers.hosts = [host({ state: "offline" })];
    await flushPromises();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(api.listPeerAttachments).toHaveBeenCalledTimes(2);

    peers.hosts = [host({ state: "online" })];
    await flushPromises();
    expect(api.listPeerAttachments).toHaveBeenCalledTimes(3);

    wrapper.unmount();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(api.listPeerAttachments).toHaveBeenCalledTimes(3);
  });

  it("does not poll a collapsed host and remembers the collapse", async () => {
    vi.useFakeTimers();
    const api = makeApi([item()]);
    const { wrapper } = mountPanel(api);
    await flushPromises();
    await wrapper.find("[data-role='peer-attachments-toggle']").trigger("click");
    await flushPromises();
    expect(rows(wrapper)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.listPeerAttachments).toHaveBeenCalledTimes(1);
    expect(JSON.parse(window.localStorage.getItem("strideterm-peer-attachments-collapsed") || "{}")).toEqual({
      [HOST_ID]: true,
    });
  });

  it("the Refresh button reloads the list and reports a failure as a toast", async () => {
    const api = makeApi([item()]);
    const { wrapper } = mountPanel(api);
    await flushPromises();
    api.listPeerAttachments.mockRejectedValueOnce(new Error("Host is offline"));
    await wrapper.find("[data-role='peer-attachments-refresh']").trigger("click");
    await flushPromises();
    expect(api.listPeerAttachments).toHaveBeenCalledTimes(2);
    expect(showError).toHaveBeenCalledTimes(1);
    expect(wrapper.find("[data-role='peer-attachments-error']").text()).toBe("Host is offline");
  });

  it("is absent in a window attached to another desktop and when the transport lacks the methods", async () => {
    setWindowBackend({
      kind: "peer",
      hostId: HOST_ID,
      hostLabel: "macmini.local",
      remoteProfileId: "p1",
      clientId: "wabc",
      terminalFontSize: 13,
    });
    const api = makeApi([item()]);
    const attached = mountPanel(api);
    await flushPromises();
    expect(attached.wrapper.find("[data-role='peer-attachments-host']").exists()).toBe(false);
    expect(api.listPeerAttachments).not.toHaveBeenCalled();
    attached.wrapper.unmount();

    setWindowBackend({ kind: "local" });
    const bare = makeApi([item()]);
    const without = { ...bare, listPeerAttachments: undefined };
    const plain = mountPanel(without as never);
    await flushPromises();
    expect(plain.wrapper.find("[data-role='peer-attachments-host']").exists()).toBe(false);
  });
});
