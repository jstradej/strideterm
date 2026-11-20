import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DefineComponent } from "vue";
import type { SidebarNote, SidebarNotes } from "../../../electron/shared/sidebar-notes.js";
import { useAppStore } from "../../stores/app.js";
import { useNotificationStore } from "../../stores/notifications.js";
import { apiKey } from "../../types/keys.js";
import NotificationCenter from "./NotificationCenter.vue";
import SidebarNotesPanel from "./SidebarNotesPanel.vue";

const workspaceNote: SidebarNote = { id: "note-a", text: "Start", revision: 1, canUndo: false };
const fixture: SidebarNotes = {
  workspace: [workspaceNote],
  global: [{ id: "global-a", text: "Pinned checklist", revision: 1, canUndo: false }],
};

let host: HTMLElement;
const NotesPanel = SidebarNotesPanel as DefineComponent<{
  host: HTMLElement | null;
  profileId: string;
  workspaceId: string;
}>;
let wrapper: VueWrapper<InstanceType<typeof NotesPanel>>;
const listSidebarNotes = vi.fn();
const saveSidebarNote = vi.fn();
const undoSidebarNote = vi.fn();

function query<T extends HTMLElement = HTMLElement>(selector: string): T {
  const target = host.querySelector<T>(selector);
  if (!target) throw new Error(`Missing: ${selector}`);
  return target;
}

async function click(selector: string) {
  query(selector).click();
  await flushPromises();
}

async function edit(value: string) {
  const editor = query<HTMLTextAreaElement>("textarea");
  editor.value = value;
  editor.dispatchEvent(new Event("input", { bubbles: true }));
  await flushPromises();
}

beforeEach(() => {
  vi.useFakeTimers();
  setActivePinia(createPinia());
  host = document.createElement("div");
  document.body.append(host);
  listSidebarNotes.mockReset().mockResolvedValue(fixture);
  saveSidebarNote.mockReset();
  undoSidebarNote.mockReset();
  wrapper = mount(NotesPanel, {
    props: { host, profileId: "profile-a", workspaceId: "workspace-a" },
    global: { provide: { [apiKey]: { listSidebarNotes, saveSidebarNote, undoSidebarNote } } },
  });
});

afterEach(() => {
  wrapper.unmount();
  host.remove();
  vi.useRealTimers();
});

describe("SidebarNotesPanel", () => {
  it("keeps the two sections in order and supports keyboard resizing", async () => {
    await flushPromises();
    expect(Array.from(host.querySelectorAll("h3"), (heading) => heading.textContent)).toEqual([
      "Workspace",
      "All workspaces",
    ]);
    const divider = query('[role="separator"]');
    divider.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    await flushPromises();
    expect(divider.getAttribute("aria-valuenow")).toBe("80");
    divider.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    await flushPromises();
    expect(divider.getAttribute("aria-valuenow")).toBe("75");
  });

  it("tracks the pointer and clamps the split to keep both sections available", async () => {
    await flushPromises();
    vi.spyOn(query(".sidebar-notes__split"), "getBoundingClientRect").mockReturnValue({
      height: 200,
      top: 100,
    } as DOMRect);
    const divider = query('[role="separator"]');
    divider.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 3, button: 0 }));
    divider.dispatchEvent(new PointerEvent("pointermove", { pointerId: 8, clientY: 280 }));
    await flushPromises();
    expect(divider.getAttribute("aria-valuetext")).toBe("Automatic");
    divider.dispatchEvent(new PointerEvent("pointermove", { pointerId: 3, clientY: 220 }));
    await flushPromises();
    expect(divider.getAttribute("aria-valuenow")).toBe("60");
    divider.dispatchEvent(new PointerEvent("pointermove", { pointerId: 3, clientY: 298 }));
    divider.dispatchEvent(new PointerEvent("pointerup", { pointerId: 3 }));
    divider.dispatchEvent(new PointerEvent("pointermove", { pointerId: 3, clientY: 120 }));
    await flushPromises();
    expect(divider.getAttribute("aria-valuenow")).toBe("80");
  });

  it("automatically sizes the workspace until the user resizes the split", async () => {
    await flushPromises();
    const split = query(".sidebar-notes__split");
    expect(split.classList.contains("sidebar-notes__split--automatic")).toBe(true);
    listSidebarNotes.mockResolvedValue({ global: fixture.global, workspace: [] });
    await wrapper.setProps({ workspaceId: "workspace-b" });
    await flushPromises();
    expect(split.classList.contains("sidebar-notes__split--automatic")).toBe(true);
    query('[role="separator"]').dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    await flushPromises();
    expect(split.classList.contains("sidebar-notes__split--automatic")).toBe(false);
  });

  it("can drag the compact divider by a small amount in a tall dock", async () => {
    await flushPromises();
    vi.spyOn(query(".sidebar-notes__split"), "getBoundingClientRect").mockReturnValue({
      height: 1000,
      top: 100,
    } as DOMRect);
    const divider = query('[role="separator"]');
    vi.spyOn(divider, "getBoundingClientRect").mockReturnValue({ top: 160 } as DOMRect);
    divider.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 3, button: 0, clientY: 164 }));
    divider.dispatchEvent(new PointerEvent("pointermove", { pointerId: 3, clientY: 174 }));
    await flushPromises();
    expect(divider.getAttribute("aria-valuenow")).toBe("7");
  });

  it("shows a single load error and retries both collections", async () => {
    listSidebarNotes.mockRejectedValueOnce(
      new Error("Error invoking remote method 'notes:list': Error: Notes are unavailable."),
    );
    await wrapper.setProps({ workspaceId: "workspace-b" });
    await flushPromises();
    expect(host.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(query('[role="alert"]').textContent).toBe("Notes are unavailable.");
    await click(".sidebar-notes__load-error button");
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).toContain("Pinned checklist");
    expect(host.textContent).toContain("Start");
  });

  it("debounces and serializes saves, then undoes the last saved text", async () => {
    let finishFirstSave: (_note: SidebarNote) => void = () => undefined;
    saveSidebarNote.mockReturnValueOnce(
      new Promise<SidebarNote>((resolve) => {
        finishFirstSave = resolve;
      }),
    );
    saveSidebarNote.mockResolvedValueOnce({ id: "note-a", text: "Third", revision: 3, canUndo: true });
    undoSidebarNote.mockResolvedValue({ id: "note-a", text: "Second", revision: 4, canUndo: false });
    await flushPromises();
    await click(".sidebar-notes__note-title");
    await edit("Second");
    await vi.advanceTimersByTimeAsync(999);
    expect(saveSidebarNote).not.toHaveBeenCalled();
    expect(query('[role="status"]').textContent?.trim()).toBe("Unsaved changes");
    await vi.advanceTimersByTimeAsync(1);
    expect(saveSidebarNote).toHaveBeenCalledWith({
      profileId: "profile-a",
      workspaceId: "workspace-a",
      id: "note-a",
      text: "Second",
      expectedRevision: 1,
    });
    expect(query('[role="status"]').getAttribute("aria-label")).toBe("Saving…");
    await edit("Third");
    await vi.advanceTimersByTimeAsync(1000);
    expect(saveSidebarNote).toHaveBeenCalledTimes(1);
    finishFirstSave({ id: "note-a", text: "Second", revision: 2, canUndo: true });
    await flushPromises();
    await vi.advanceTimersByTimeAsync(1000);
    expect(saveSidebarNote).toHaveBeenLastCalledWith(expect.objectContaining({ expectedRevision: 2, text: "Third" }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(query('[role="status"]').textContent?.trim()).toBe("✓ Saved");
    query<HTMLButtonElement>(".sidebar-notes__editor-actions button").click();
    await flushPromises();
    expect(undoSidebarNote).toHaveBeenCalledWith({
      profileId: "profile-a",
      workspaceId: "workspace-a",
      id: "note-a",
      expectedRevision: 3,
    });
    expect(query<HTMLTextAreaElement>("textarea").value).toBe("Second");
  });

  it("does not create an empty global note, and flushes typed text on blur", async () => {
    saveSidebarNote.mockImplementation(async ({ id, text }) => ({ id, text, revision: 1, canUndo: true }));
    await flushPromises();
    await click('[aria-label="New note for all workspaces"]');
    expect(query(".sidebar-notes__editor-actions").textContent).toContain("Saves automatically as you type");
    await edit("   ");
    await vi.advanceTimersByTimeAsync(1000);
    expect(saveSidebarNote).not.toHaveBeenCalled();
    await edit("Global thought");
    query("textarea").dispatchEvent(new FocusEvent("blur"));
    await flushPromises();
    expect(saveSidebarNote).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: "profile-a",
        workspaceId: null,
        text: "Global thought",
        expectedRevision: 0,
      }),
    );
  });

  it("retains a failed draft across profiles and only replaces the latest with explicit action", async () => {
    saveSidebarNote.mockRejectedValueOnce(new Error("Note changed")).mockResolvedValue({
      ...workspaceNote,
      text: "My draft",
      revision: 3,
    });
    await flushPromises();
    await click(".sidebar-notes__note-title");
    await edit("My draft");
    await vi.advanceTimersByTimeAsync(1000);
    expect(host.textContent).toContain("Note changed");
    listSidebarNotes.mockResolvedValueOnce({ global: [], workspace: [] });
    await wrapper.setProps({ profileId: "profile-b", workspaceId: "workspace-b" });
    await flushPromises();
    expect(host.textContent).not.toContain("My draft");
    listSidebarNotes.mockResolvedValue({
      global: fixture.global,
      workspace: [{ ...workspaceNote, text: "Someone else's text", revision: 2 }],
    });
    await wrapper.setProps({ profileId: "profile-a", workspaceId: "workspace-a" });
    await flushPromises();
    const recovery = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Review latest",
    );
    recovery?.click();
    await flushPromises();
    expect(query<HTMLTextAreaElement>("textarea").value).toBe("My draft");
    expect(host.textContent).toContain("Someone else's text");
    expect(saveSidebarNote).toHaveBeenCalledTimes(1);
    const overwrite = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Save my draft",
    );
    overwrite?.click();
    await flushPromises();
    expect(saveSidebarNote).toHaveBeenLastCalledWith(
      expect.objectContaining({ expectedRevision: 2, text: "My draft" }),
    );
  });

  it("previews the body of a collapsed note and closes the editor with Escape after saving", async () => {
    listSidebarNotes.mockResolvedValue({
      global: [],
      workspace: [{ ...workspaceNote, text: "Deploy\n\n first step \nsecond step" }],
    });
    saveSidebarNote.mockResolvedValue({ ...workspaceNote, text: "Deploy\nchanged", revision: 2, canUndo: true });
    await wrapper.setProps({ workspaceId: "workspace-c" });
    await flushPromises();
    expect(query(".sidebar-notes__note-name").textContent).toBe("Deploy");
    expect(query(".sidebar-notes__note-preview").textContent).toBe("first step\nsecond step");
    await click(".sidebar-notes__note-title");
    expect(host.querySelector(".sidebar-notes__note-preview")).toBeNull();
    await edit("Deploy\nchanged");
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true });
    const dockKeydown = vi.fn();
    host.addEventListener("keydown", dockKeydown);
    query("textarea").dispatchEvent(escape);
    await flushPromises();
    expect(dockKeydown).not.toHaveBeenCalled();
    expect(saveSidebarNote).toHaveBeenCalledWith(expect.objectContaining({ text: "Deploy\nchanged" }));
    expect(host.querySelector("textarea")).toBeNull();
    expect(document.activeElement).toBe(query(".sidebar-notes__note-title"));
  });

  it("resizes the tab note editor with its grip, keeps editing, and remembers the height", async () => {
    localStorage.removeItem("strideterm.sidebarNotes.editorHeight.tab");
    const appStore = useAppStore();
    vi.spyOn(appStore, "getPanelByViewId").mockReturnValue({
      workspace: { id: "workspace-a", profileId: "profile-a" },
      panel: { title: "Shell", notes: "long note" },
    });
    appStore.activeViewId = "workspace-a:terminal";
    await flushPromises();
    await click(".sidebar-notes__tab-body");
    const editor = query<HTMLTextAreaElement>("[data-tab-note-editor]");
    const grip = query('[aria-label="Resize tab note editor"]');
    expect(grip.getAttribute("aria-valuetext")).toBe("Automatic");
    editor.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: grip }));
    await flushPromises();
    expect(host.querySelector("[data-tab-note-editor]")).toBe(editor);
    const windowFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    editor.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    await flushPromises();
    expect(host.querySelector("[data-tab-note-editor]")).toBe(editor);
    windowFocus.mockRestore();

    vi.spyOn(editor, "offsetHeight", "get").mockReturnValue(120);
    grip.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 2, button: 0, clientY: 300 }));
    grip.dispatchEvent(new PointerEvent("pointermove", { pointerId: 2, clientY: 380 }));
    grip.dispatchEvent(new PointerEvent("pointerup", { pointerId: 2, clientY: 380 }));
    await flushPromises();
    expect(editor.style.height).toBe("200px");
    expect(editor.style.maxHeight).toBe("none");
    expect(localStorage.getItem("strideterm.sidebarNotes.editorHeight.tab")).toBe("200");

    grip.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    await flushPromises();
    expect(grip.getAttribute("aria-valuenow")).toBe("180");
    grip.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await flushPromises();
    expect(editor.style.height).toBe("");
    expect(localStorage.getItem("strideterm.sidebarNotes.editorHeight.tab")).toBeNull();
  });

  it("names each section's scope with the workspace's colour and the profile", async () => {
    const appStore = useAppStore();
    appStore.payload = {
      appState: {
        profiles: [
          { id: "profile-a", name: "Work" },
          { id: "profile-b", name: "Home" },
        ],
        workspaces: [{ id: "workspace-b", profileId: "profile-a", name: "demo", color: "#ff8800" }],
      },
    } as unknown as typeof appStore.payload;
    listSidebarNotes.mockResolvedValue({ global: [], workspace: [workspaceNote] });
    await wrapper.setProps({ workspaceId: "workspace-b" });
    await flushPromises();
    const [workspaceSection, globalSection] = Array.from(host.querySelectorAll<HTMLElement>("section"));
    expect(workspaceSection.style.getPropertyValue("--notes-section-accent")).toBe("#ff8800");
    expect(workspaceSection.querySelector(".sidebar-notes__context")?.textContent).toBe("demo");
    expect(workspaceSection.querySelector(".sidebar-notes__count")?.textContent).toBe("1");
    expect(workspaceSection.querySelector('[aria-label="New note for demo"]')).not.toBeNull();
    expect(globalSection.querySelector(".sidebar-notes__context")?.textContent).toBe("Work");
    expect(globalSection.querySelector(".sidebar-notes__count")).toBeNull();
    expect(globalSection.querySelector(".sidebar-notes__empty")?.textContent).toContain(
      "No notes shared by all workspaces yet.",
    );
  });

  it("offers to add a note from the empty state", async () => {
    listSidebarNotes.mockResolvedValue({ global: [], workspace: [] });
    await wrapper.setProps({ workspaceId: "workspace-c" });
    await flushPromises();
    const [workspaceEmpty] = host.querySelectorAll<HTMLButtonElement>(".sidebar-notes__empty");
    workspaceEmpty.click();
    await flushPromises();
    expect(host.querySelector("textarea")?.getAttribute("aria-label")).toBe("Workspace note text");
  });

  it("shows the active tab's note inline and saves edits to that tab", async () => {
    const appStore = useAppStore();
    const panel = { title: "Shell", notes: "waiting on review\nthen merge" };
    vi.spyOn(appStore, "getPanelByViewId").mockReturnValue({
      workspace: { id: "workspace-a", profileId: "profile-a" },
      panel,
    });
    const saveTabNote = vi.spyOn(appStore, "saveTabNote").mockImplementation(async (_viewId, text) => {
      panel.notes = text.trim();
    });
    appStore.activeViewId = "workspace-a:terminal";
    await flushPromises();
    expect(query(".sidebar-notes__tab-title").textContent).toBe("Shell");
    expect(query(".sidebar-notes__tab-body").textContent?.trim()).toBe("waiting on review\nthen merge");
    await click(".sidebar-notes__tab-body");
    const editor = query<HTMLTextAreaElement>("[data-tab-note-editor]");
    expect(document.activeElement).toBe(editor);
    editor.value = "merged";
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(999);
    expect(saveTabNote).not.toHaveBeenCalled();
    expect(query('[role="status"]').textContent?.trim()).toBe("Unsaved changes");
    await vi.advanceTimersByTimeAsync(1);
    expect(saveTabNote).toHaveBeenCalledWith("workspace-a:terminal", "merged");
    expect(query('[role="status"]').textContent?.trim()).toBe("✓ Saved");
    await vi.advanceTimersByTimeAsync(5000);
    expect(query('[role="status"]').textContent?.trim()).toBe("✓ Saved");
    editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flushPromises();
    expect(host.querySelector("[data-tab-note-editor]")).toBeNull();
    expect(saveTabNote).toHaveBeenCalledTimes(1);
  });

  it("keeps a tab note draft that failed to save and retries it", async () => {
    const appStore = useAppStore();
    const panel = { title: "Shell", notes: "" };
    vi.spyOn(appStore, "getPanelByViewId").mockReturnValue({
      workspace: { id: "workspace-a", profileId: "profile-a" },
      panel,
    });
    const saveTabNote = vi
      .spyOn(appStore, "saveTabNote")
      .mockRejectedValueOnce(new Error("Error invoking remote method 'state:save-workspace': Error: Disk full"))
      .mockImplementation(async (_viewId, text) => {
        panel.notes = text.trim();
      });
    appStore.activeViewId = "workspace-a:terminal";
    await flushPromises();
    expect(query(".sidebar-notes__tab-body").textContent?.trim()).toBe("Add a note for this tab…");
    await click(".sidebar-notes__tab-body");
    const editor = query<HTMLTextAreaElement>("[data-tab-note-editor]");
    editor.value = "draft";
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    editor.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    await flushPromises();
    expect(query('.sidebar-notes__problem[role="alert"]').textContent).toContain("Disk full");
    expect(query(".sidebar-notes__tab-body").textContent?.trim()).toBe("draft");
    await click(".sidebar-notes__problem button");
    expect(saveTabNote).toHaveBeenCalledTimes(2);
    expect(host.querySelector(".sidebar-notes__problem")).toBeNull();
  });

  describe("notes changed elsewhere", () => {
    const setCounter = async (revisions: Record<string, number>) => {
      useAppStore().payload = { sidebarNotesRevisions: revisions } as unknown as ReturnType<
        typeof useAppStore
      >["payload"];
      await flushPromises();
    };

    it("reloads when the profile's counter changes, not when it stays or another profile's moves", async () => {
      await setCounter({ "profile-a": 1 });
      await flushPromises();
      listSidebarNotes.mockClear();
      await setCounter({ "profile-a": 1 });
      await setCounter({ "profile-a": 1, "profile-b": 7 });
      expect(listSidebarNotes).not.toHaveBeenCalled();
      await setCounter({ "profile-a": 2, "profile-b": 7 });
      expect(listSidebarNotes).toHaveBeenCalledTimes(1);
    });

    it("updates a note that is not being edited and keeps a draft being typed", async () => {
      listSidebarNotes.mockResolvedValue({
        global: [{ id: "global-a", text: "Pinned checklist", revision: 1, canUndo: false }],
        workspace: [workspaceNote, { id: "note-b", text: "Other", revision: 1, canUndo: false }],
      });
      await flushPromises();
      await setCounter({ "profile-a": 1 });
      await click(".sidebar-notes__note-title");
      await edit("My typing");
      listSidebarNotes.mockResolvedValue({
        global: fixture.global,
        workspace: [
          { ...workspaceNote, text: "Remote edit of a", revision: 2 },
          { id: "note-b", text: "Remote edit of b", revision: 2, canUndo: true },
        ],
      });
      await setCounter({ "profile-a": 2 });
      expect(query<HTMLTextAreaElement>("textarea").value).toBe("My typing");
      expect(host.textContent).toContain("Remote edit of b");
      expect(host.textContent).not.toContain("Remote edit of a");
      saveSidebarNote.mockRejectedValue(new Error("This note has changed. Reload it before trying again."));
      await vi.advanceTimersByTimeAsync(1000);
      expect(saveSidebarNote).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 1, text: "My typing" }));
      expect(query<HTMLTextAreaElement>("textarea").value).toBe("My typing");
      expect(host.textContent).toContain("This note has changed");
      expect(host.textContent).toContain("Review latest");
    });

    it("costs one extra reload after the panel's own save and does not loop", async () => {
      saveSidebarNote.mockResolvedValue({ ...workspaceNote, text: "Mine", revision: 2, canUndo: true });
      await setCounter({ "profile-a": 1 });
      await click(".sidebar-notes__note-title");
      await edit("Mine");
      await vi.advanceTimersByTimeAsync(1000);
      listSidebarNotes.mockClear();
      listSidebarNotes.mockResolvedValue({
        global: fixture.global,
        workspace: [{ ...workspaceNote, text: "Mine", revision: 2, canUndo: true }],
      });
      await setCounter({ "profile-a": 2 });
      await vi.advanceTimersByTimeAsync(5000);
      expect(listSidebarNotes).toHaveBeenCalledTimes(1);
      expect(query<HTMLTextAreaElement>("textarea").value).toBe("Mine");
      expect(saveSidebarNote).toHaveBeenCalledTimes(1);
    });

    it("still reloads once on a profile switch, without a second reload from the counter", async () => {
      await setCounter({ "profile-a": 1, "profile-b": 5 });
      listSidebarNotes.mockClear();
      await wrapper.setProps({ profileId: "profile-b", workspaceId: "workspace-b" });
      await flushPromises();
      expect(listSidebarNotes).toHaveBeenCalledTimes(1);
    });
  });

  it("opens Notes from the dock's compact shortcut", async () => {
    const notifications = useNotificationStore();
    notifications.panelOpen = true;
    const dock = mount(NotificationCenter, {
      attachTo: document.body,
      global: { provide: { [apiKey]: { listSidebarNotes } } },
    });
    try {
      await dock.get(".notification-center__tab--compact-notes").trigger("click");
      await flushPromises();
      expect(dock.get(".notification-center__body--notes").text()).toContain("Pinned checklist");
      expect(dock.get(".notification-center__tabmenu-current").text()).toBe("Notes");
      expect(dock.find(".notification-center__tab--compact-notes").exists()).toBe(false);
    } finally {
      dock.unmount();
    }
  });
});
