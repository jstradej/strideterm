import { describe, expect, test, beforeEach, afterEach, vi } from "vitest";
import { ref } from "vue";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fakeApi: Record<string, any> = {};
const confirmInApp = vi.fn(async () => true);
const openDialog = vi.fn();
const closeDialog = vi.fn();
const gitSwitchTab = vi.fn();

vi.mock("../../../stores/app.js", () => ({
  useAppStore: () => ({ getApi: () => fakeApi, confirmInApp, openDialog, closeDialog }),
}));
vi.mock("../../../stores/git-ui.js", () => ({
  useGitUiStore: () => ({ getActiveRoot: () => "/repo", refreshGit: vi.fn(async () => {}), gitSwitchTab }),
}));
vi.mock("../../../stores/notifications.js", () => ({
  useNotificationStore: () => ({ pushEphemeralToast: vi.fn() }),
}));
vi.mock("../../../composables/useIsNarrow.js", () => ({
  useIsNarrow: () => ({ isNarrow: ref(false), isMobile: ref(false) }),
}));

import GitStashesTab from "./GitStashesTab.vue";
import StashListItem from "./StashListItem.vue";
import StashDetailPane from "./StashDetailPane.vue";
import { useGitStashStore } from "../../../stores/git-stash.js";

const SAMPLE = [
  {
    index: 0,
    ref: "stash@{0}",
    date: "",
    author: "",
    branch: "master",
    baseCommit: "",
    baseSubject: "",
    message: "On master: fix race",
    customMessage: "fix race",
    isWipDefault: false,
    fileCount: 2,
  },
  {
    index: 1,
    ref: "stash@{1}",
    date: "",
    author: "",
    branch: "feat/x",
    baseCommit: "",
    baseSubject: "",
    message: "On feat/x: experiment",
    customMessage: "experiment",
    isWipDefault: false,
    fileCount: 1,
  },
];

function resetApi(stashes: typeof SAMPLE) {
  for (const k of Object.keys(fakeApi)) delete fakeApi[k];
  fakeApi.isRemote = false;
  fakeApi.gitListStashes = vi.fn(async () => ({ ok: true, stashes }));
  fakeApi.gitStashFiles = vi.fn(async () => ({ ok: true, files: [] }));
  fakeApi.gitStashFileDiff = vi.fn(async () => ({ ok: true }));
  fakeApi.gitStashApply = vi.fn(async () => ({ result: { ok: true, summary: "applied" } }));
  fakeApi.gitStashPop = vi.fn(async () => ({ result: { ok: true, summary: "popped" } }));
  fakeApi.gitStashDrop = vi.fn(async () => ({ result: { ok: true, summary: "dropped" } }));
  fakeApi.gitStashBranch = vi.fn(async () => ({ result: { ok: true, summary: "branched" } }));
  fakeApi.gitStashExport = vi.fn(async () => ({ ok: true, patch: "diff --git", suggestedFilename: "x.patch" }));
  fakeApi.gitStashImport = vi.fn(async () => ({ result: { ok: true, summary: "imported" } }));
  fakeApi.browseFile = vi.fn(async () => null);
  fakeApi.saveFile = vi.fn(async () => null);
  fakeApi.fileRead = vi.fn(async () => ({ ok: true, content: "" }));
  fakeApi.fileWrite = vi.fn(async () => ({ ok: true }));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mountedWrappers: VueWrapper<any>[] = [];

async function mountTab(opts: { stashes?: typeof SAMPLE; dirty?: boolean } = {}) {
  setActivePinia(createPinia());
  resetApi(opts.stashes ?? SAMPLE);
  confirmInApp.mockClear();
  openDialog.mockClear();
  gitSwitchTab.mockClear();
  const wrapper = mount(GitStashesTab, {
    props: {
      workspaceId: "ws1",
      snapshot: { dirty: !!opts.dirty, branch: "master", stashCount: (opts.stashes ?? SAMPLE).length },
      activeRootPath: "/repo",
    },
  });
  mountedWrappers.push(wrapper);
  await flushPromises();
  return wrapper;
}

beforeEach(() => setActivePinia(createPinia()));
// Unmount after every test so the components' selectedRef/file watchers don't
// fire lazy loadFiles/loadDiff calls after this file's app-store mock is gone —
// otherwise they reject against the real (null) api in a later test file. Flush
// first to let any in-flight lazy load settle against the (still-mocked) api,
// then unmount to stop further watcher fires, then flush the unmount's effects.
afterEach(async () => {
  for (const w of mountedWrappers) w.unmount();
  mountedWrappers.length = 0;
  await flushPromises();
});

describe("GitStashesTab", () => {
  test("renders the empty state when there are no stashes", async () => {
    const wrapper = await mountTab({ stashes: [] });
    expect(wrapper.text()).toContain("No stashes");
  });

  test("renders a row per stash when the list is non-empty", async () => {
    const wrapper = await mountTab();
    expect(wrapper.findAllComponents(StashListItem)).toHaveLength(2);
  });

  test("filter narrows the visible items", async () => {
    const wrapper = await mountTab();
    useGitStashStore().setFilter("ws1", "experiment");
    await flushPromises();
    const items = wrapper.findAllComponents(StashListItem);
    expect(items).toHaveLength(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((items[0].props() as any).entry.customMessage).toBe("experiment");
  });

  test("filter matches file paths returned by listStashes without hydrating files", async () => {
    const stashes = [
      { ...SAMPLE[0], filePaths: ["src/foo.ts", "src/bar.ts"] },
      { ...SAMPLE[1], filePaths: ["README.md"] },
    ];
    const wrapper = await mountTab({ stashes });
    // "readme" matches nothing in the messages/branches — only stash@{1}'s
    // eagerly-returned file path. The entry was never expanded, so this only
    // works because the filter falls back to entry.filePaths.
    useGitStashStore().setFilter("ws1", "readme");
    await flushPromises();
    const items = wrapper.findAllComponents(StashListItem);
    expect(items).toHaveLength(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((items[0].props() as any).entry.ref).toBe("stash@{1}");
  });

  test("selecting a row loads that stash's files", async () => {
    const wrapper = await mountTab();
    fakeApi.gitStashFiles.mockClear();
    await wrapper.findAllComponents(StashListItem)[1].vm.$emit("select");
    await flushPromises();
    expect(fakeApi.gitStashFiles).toHaveBeenCalledWith(
      expect.objectContaining({ ref: "stash@{1}", workspaceId: "ws1" }),
    );
  });

  test("clicking a file in the detail pane loads its diff", async () => {
    const wrapper = await mountTab();
    // Detail pane needs file rows to click — back the lazily-loaded stash with
    // one. stash@{1} isn't pre-loaded (only the default stash@{0} is), so
    // selecting it triggers a fresh gitStashFiles call that returns this file.
    fakeApi.gitStashFiles.mockResolvedValue({
      ok: true,
      files: [{ path: "src/foo.ts", code: "M", status: "modified", additions: 1, deletions: 0, isBinary: false }],
    });
    await wrapper.findAllComponents(StashListItem)[1].vm.$emit("select");
    await flushPromises();
    const detail = wrapper.findComponent(StashDetailPane);
    await detail.find(".stash-detail__file").trigger("click");
    await flushPromises();
    expect(fakeApi.gitStashFileDiff).toHaveBeenCalledWith(
      expect.objectContaining({ ref: "stash@{1}", relativePath: "src/foo.ts", workspaceId: "ws1" }),
    );
  });

  test("Apply always opens a confirm dialog (clean tree)", async () => {
    const wrapper = await mountTab({ dirty: false });
    await wrapper.findAllComponents(StashListItem)[0].vm.$emit("apply");
    await flushPromises();
    expect(confirmInApp).toHaveBeenCalledWith(expect.objectContaining({ title: "Apply stash" }));
  });

  test("Drop opens a confirm dialog echoing the stash message", async () => {
    const wrapper = await mountTab();
    await wrapper.findAllComponents(StashListItem)[0].vm.$emit("drop");
    await flushPromises();
    expect(confirmInApp).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Drop stash", message: expect.stringContaining("fix race") }),
    );
  });

  test("Pop on a dirty tree shows the dirty-tree confirm", async () => {
    const wrapper = await mountTab({ dirty: true });
    await wrapper.findAllComponents(StashListItem)[0].vm.$emit("pop");
    await flushPromises();
    expect(confirmInApp).toHaveBeenCalledWith(expect.objectContaining({ title: "Pop into dirty tree" }));
  });

  test("Pop on a clean tree pops without a confirm", async () => {
    const wrapper = await mountTab({ dirty: false });
    await wrapper.findAllComponents(StashListItem)[0].vm.$emit("pop");
    await flushPromises();
    expect(confirmInApp).not.toHaveBeenCalled();
    expect(fakeApi.gitStashPop).toHaveBeenCalledWith(expect.objectContaining({ ref: "stash@{0}" }));
  });

  test("Branch dialog defaults 'switch immediately' ON when the tree is clean", async () => {
    const wrapper = await mountTab({ dirty: false });
    await wrapper.findAllComponents(StashListItem)[0].vm.$emit("branch");
    await flushPromises();
    expect(openDialog).toHaveBeenCalledWith(
      "PromptDialog",
      expect.objectContaining({ checkboxInitial: true, pattern: "^[A-Za-z0-9._/-]+$" }),
    );
  });

  test("Branch dialog defaults 'switch immediately' OFF (with warning) when the tree is dirty", async () => {
    const wrapper = await mountTab({ dirty: true });
    await wrapper.findAllComponents(StashListItem)[0].vm.$emit("branch");
    await flushPromises();
    expect(openDialog).toHaveBeenCalledWith(
      "PromptDialog",
      expect.objectContaining({ checkboxInitial: false, checkboxHintWarn: true }),
    );
  });

  test("'New stash in Changes…' switches to the Changes tab (creation lives there now)", async () => {
    const wrapper = await mountTab();
    const btn = wrapper.findAll("button").find((b) => b.text().includes("New stash in Changes"));
    expect(btn).toBeTruthy();
    await btn!.trigger("click");
    expect(gitSwitchTab).toHaveBeenCalledWith("ws1", "changes");
  });

  test("Import patch… opens the desktop file picker", async () => {
    const wrapper = await mountTab();
    const importBtn = wrapper.findAll("button").find((b) => b.text().includes("Import patch"));
    await importBtn!.trigger("click");
    await flushPromises();
    expect(fakeApi.browseFile).toHaveBeenCalled();
  });

  test("Export on the desktop fetches the patch and writes it via the save dialog", async () => {
    const wrapper = await mountTab();
    fakeApi.isRemote = false;
    fakeApi.saveFile.mockResolvedValueOnce("/home/user/Downloads/x.patch");
    await wrapper.findAllComponents(StashListItem)[0].vm.$emit("export");
    await flushPromises();
    expect(fakeApi.gitStashExport).toHaveBeenCalledWith(
      expect.objectContaining({ ref: "stash@{0}", workspaceId: "ws1" }),
    );
    expect(fakeApi.saveFile).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: "x.patch", content: "diff --git" }),
    );
  });

  test("Export on the web client downloads via a blob instead of the save dialog", async () => {
    const wrapper = await mountTab();
    fakeApi.isRemote = true;
    // jsdom lacks the blob-URL APIs the web download path uses — stub them.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const u = URL as any;
    const origCreate = u.createObjectURL;
    const origRevoke = u.revokeObjectURL;
    u.createObjectURL = vi.fn(() => "blob:mock");
    u.revokeObjectURL = vi.fn();
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    try {
      await wrapper.findAllComponents(StashListItem)[0].vm.$emit("export");
      await flushPromises();
      expect(fakeApi.gitStashExport).toHaveBeenCalled();
      expect(fakeApi.saveFile).not.toHaveBeenCalled();
      expect(u.createObjectURL).toHaveBeenCalled();
      expect(clickSpy).toHaveBeenCalled();
    } finally {
      u.createObjectURL = origCreate;
      u.revokeObjectURL = origRevoke;
      clickSpy.mockRestore();
    }
  });

  test("Import patch… reads the file, shows the confirm dialog, then submits to gitStashImport", async () => {
    const wrapper = await mountTab();
    fakeApi.isRemote = false;
    fakeApi.browseFile.mockResolvedValueOnce({
      path: "/home/user/Downloads/my-fix.patch",
      content: "# strideterm-stash-patch v1\ndiff --git a/x b/x\n",
    });
    const importBtn = wrapper.findAll("button").find((b) => b.text().includes("Import patch"));
    await importBtn!.trigger("click");
    await flushPromises();
    // Preview/confirm step: a PromptDialog opens pre-filled with a message
    // derived from the filename, and nothing is submitted yet.
    expect(openDialog).toHaveBeenCalledWith(
      "PromptDialog",
      expect.objectContaining({ title: "Import patch as stash", value: "my fix" }),
    );
    expect(fakeApi.gitStashImport).not.toHaveBeenCalled();
    // Confirming the dialog submits the patch content + message.
    const lastCall = openDialog.mock.calls.at(-1) as [string, { onSubmit: (_m: string) => Promise<void> }];
    await lastCall[1].onSubmit("restored work");
    await flushPromises();
    expect(fakeApi.gitStashImport).toHaveBeenCalledWith(
      expect.objectContaining({
        patch: "# strideterm-stash-patch v1\ndiff --git a/x b/x\n",
        message: "restored work",
        workspaceId: "ws1",
      }),
    );
  });
});
