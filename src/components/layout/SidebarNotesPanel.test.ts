import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DefineComponent } from "vue";
import type { PeerAttachedHost, PeerHostState } from "../../../electron/shared/peers.js";
import type { InstallationNote, SidebarNote, SidebarNotes } from "../../../electron/shared/sidebar-notes.js";
import { useAppStore } from "../../stores/app.js";
import { useNotificationStore } from "../../stores/notifications.js";
import { usePeersStore } from "../../stores/peers.js";
import { apiKey } from "../../types/keys.js";
import { setWindowBackend } from "../../window-backend.js";
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
const getInstallationNote = vi.fn();
const saveInstallationNote = vi.fn();
const undoInstallationNote = vi.fn();
const emptyInstallation: InstallationNote = {
  note: { id: "global", text: "", revision: 0, canUndo: false },
  installationName: "PC-1",
};
const INSTALLATION = ".sidebar-notes__installation";

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

function mountPanel(workspaceId = "workspace-a", isRemote = false) {
  return mount(NotesPanel, {
    props: { host, profileId: "profile-a", workspaceId },
    global: {
      provide: {
        [apiKey]: {
          isRemote,
          listSidebarNotes,
          saveSidebarNote,
          undoSidebarNote,
          getInstallationNote,
          saveInstallationNote,
          undoInstallationNote,
        },
      },
    },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.removeItem("strideterm.sidebarNotes.open");
  localStorage.removeItem("strideterm.sidebarNotes.installationCollapsed");
  setActivePinia(createPinia());
  host = document.createElement("div");
  document.body.append(host);
  listSidebarNotes.mockReset().mockResolvedValue(fixture);
  saveSidebarNote.mockReset();
  undoSidebarNote.mockReset();
  getInstallationNote.mockReset().mockResolvedValue(emptyInstallation);
  saveInstallationNote.mockReset();
  undoInstallationNote.mockReset();
  wrapper = mountPanel();
});

afterEach(() => {
  wrapper.unmount();
  host.remove();
  vi.useRealTimers();
});

describe("SidebarNotesPanel", () => {
  it("keeps the three sections in order and supports keyboard resizing of both dividers", async () => {
    await flushPromises();
    expect(Array.from(host.querySelectorAll("h3"), (heading) => heading.textContent)).toEqual([
      "Workspace",
      "Profile",
      "Global",
    ]);
    const [first, second] = Array.from(host.querySelectorAll<HTMLElement>(".sidebar-notes__divider"));
    expect(host.querySelectorAll(".sidebar-notes__divider")).toHaveLength(2);
    first.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    await flushPromises();
    expect(first.getAttribute("aria-valuenow")).toBe("50");
    first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    await flushPromises();
    expect(first.getAttribute("aria-valuenow")).toBe("45");
    expect(second.getAttribute("aria-valuenow")).toBe("70");
    second.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    await flushPromises();
    expect(second.getAttribute("aria-valuenow")).toBe("80");
    expect(first.getAttribute("aria-valuenow")).toBe("45");
    second.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    await flushPromises();
    expect(second.getAttribute("aria-valuenow")).toBe("65");
  });

  it("keeps Global's size when the first divider goes to Home or is dragged past the minimum", async () => {
    await flushPromises();
    vi.spyOn(query(".sidebar-notes__split"), "getBoundingClientRect").mockReturnValue({
      height: 200,
      top: 100,
    } as DOMRect);
    const [first, second] = Array.from(host.querySelectorAll<HTMLElement>(".sidebar-notes__divider"));
    first.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    await flushPromises();
    expect(second.getAttribute("aria-valuenow")).toBe("70");
    first.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    await flushPromises();
    expect(first.getAttribute("aria-valuenow")).toBe("20");
    expect(second.getAttribute("aria-valuenow")).toBe("70");
    first.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 5, button: 0 }));
    first.dispatchEvent(new PointerEvent("pointermove", { pointerId: 5, clientY: 40 }));
    await flushPromises();
    expect(first.getAttribute("aria-valuenow")).toBe("20");
    expect(second.getAttribute("aria-valuenow")).toBe("70");
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
    divider.dispatchEvent(new PointerEvent("pointermove", { pointerId: 3, clientY: 160 }));
    await flushPromises();
    expect(divider.getAttribute("aria-valuenow")).toBe("30");
    divider.dispatchEvent(new PointerEvent("pointermove", { pointerId: 3, clientY: 298 }));
    divider.dispatchEvent(new PointerEvent("pointerup", { pointerId: 3 }));
    divider.dispatchEvent(new PointerEvent("pointermove", { pointerId: 3, clientY: 120 }));
    await flushPromises();
    expect(divider.getAttribute("aria-valuenow")).toBe("50");
  });

  it("drags the lower divider without moving the upper one, and keeps every panel usable", async () => {
    await flushPromises();
    vi.spyOn(query(".sidebar-notes__split"), "getBoundingClientRect").mockReturnValue({
      height: 200,
      top: 100,
    } as DOMRect);
    const [first, second] = Array.from(host.querySelectorAll<HTMLElement>(".sidebar-notes__divider"));
    second.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 4, button: 0 }));
    second.dispatchEvent(new PointerEvent("pointermove", { pointerId: 4, clientY: 240 }));
    await flushPromises();
    expect(second.getAttribute("aria-valuenow")).toBe("70");
    second.dispatchEvent(new PointerEvent("pointermove", { pointerId: 4, clientY: 120 }));
    await flushPromises();
    expect(second.getAttribute("aria-valuenow")).toBe("60");
    second.dispatchEvent(new PointerEvent("pointermove", { pointerId: 4, clientY: 400 }));
    await flushPromises();
    expect(second.getAttribute("aria-valuenow")).toBe("80");
    expect(first.getAttribute("aria-valuenow")).toBe("40");
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

  it("keeps several notes open at once and remembers them after the panel is mounted again", async () => {
    listSidebarNotes.mockResolvedValue({
      global: [],
      workspace: [workspaceNote, { id: "note-b", text: "Second", revision: 1, canUndo: false }],
    });
    await wrapper.setProps({ workspaceId: "workspace-c" });
    await flushPromises();
    const [first, second] = host.querySelectorAll<HTMLButtonElement>(".sidebar-notes__note-title");
    first.click();
    second.click();
    await flushPromises();
    expect(host.querySelectorAll("[data-note-editor]")).toHaveLength(2);
    query('[data-note-editor="note-a"]').dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flushPromises();
    expect(Array.from(host.querySelectorAll<HTMLElement>("[data-note-editor]"), (el) => el.dataset.noteEditor)).toEqual(
      ["note-b"],
    );

    wrapper.unmount();
    wrapper = mountPanel("workspace-c");
    await flushPromises();
    expect(Array.from(host.querySelectorAll<HTMLElement>("[data-note-editor]"), (el) => el.dataset.noteEditor)).toEqual(
      ["note-b"],
    );
    await wrapper.setProps({ workspaceId: "workspace-a" });
    await flushPromises();
    expect(host.querySelector("[data-note-editor]")).toBeNull();
  });

  it("shows how long ago each note was last edited, and keeps the age current", async () => {
    const updatedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    listSidebarNotes.mockResolvedValue({
      global: [],
      workspace: [workspaceNote, { ...workspaceNote, id: "b", updatedAt }],
    });
    await wrapper.setProps({ workspaceId: "workspace-c" });
    await flushPromises();
    const ages = host.querySelectorAll<HTMLElement>(".sidebar-notes__age");
    expect(ages).toHaveLength(1);
    expect(ages[0].textContent).toBe("5m");
    expect(ages[0].title).toBe(`Last edited ${new Date(updatedAt).toLocaleString()}`);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(query(".sidebar-notes__age").textContent).toBe("1h");
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

  it("opens the tab note editor although the clicked button loses focus as it is replaced", async () => {
    const appStore = useAppStore();
    vi.spyOn(appStore, "getPanelByViewId").mockReturnValue({
      workspace: { id: "workspace-a", profileId: "profile-a" },
      panel: { title: "Shell", notes: "" },
    });
    appStore.activeViewId = "workspace-a:terminal";
    await flushPromises();
    const button = query(".sidebar-notes__tab-body");
    button.click();
    // Chromium fires focusout from a focused element that is being removed, with no relatedTarget.
    button.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    await flushPromises();
    expect(document.activeElement).toBe(query("[data-tab-note-editor]"));
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

  describe("Global note", () => {
    const stored = (text: string, revision: number, canUndo = false): InstallationNote => ({
      note: { id: "global", text, revision, canUndo, updatedAt: new Date().toISOString() },
      installationName: "PC-1",
    });
    const editGlobal = async (value: string) => {
      const editor = query<HTMLTextAreaElement>("[data-installation-editor]");
      editor.value = value;
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      await flushPromises();
    };

    it("labels the card as this computer in a desktop window and by its name on a remote client", async () => {
      await flushPromises();
      expect(query(`${INSTALLATION} .sidebar-notes__tab-title`).textContent).toBe("This computer (PC-1)");
      expect(query(".sidebar-notes__section--installation h3").getAttribute("title")).toContain(
        "One note per computer",
      );
      wrapper.unmount();
      wrapper = mountPanel("workspace-a", true);
      await flushPromises();
      expect(query(`${INSTALLATION} .sidebar-notes__tab-title`).textContent).toBe("PC-1");
    });

    it("has no add button, an empty note is not saved, and the editor autosaves with undo", async () => {
      await flushPromises();
      expect(
        host.querySelector(".sidebar-notes__section--installation .sidebar-notes__add:not(.sidebar-notes__collapse)"),
      ).toBeNull();
      await click(`${INSTALLATION} .sidebar-notes__tab-body`);
      await editGlobal("   ");
      await vi.advanceTimersByTimeAsync(1000);
      expect(saveInstallationNote).not.toHaveBeenCalled();
      saveInstallationNote.mockResolvedValueOnce(stored("Shared checklist", 1));
      await editGlobal("Shared checklist");
      expect(host.textContent).toContain("Unsaved changes");
      await vi.advanceTimersByTimeAsync(1000);
      expect(saveInstallationNote).toHaveBeenCalledWith({ text: "Shared checklist", expectedRevision: 0 });
      expect(query(`${INSTALLATION} .sidebar-notes__status--saved`).textContent).toContain("✓ Saved");
      expect(query(`${INSTALLATION} .sidebar-notes__age`).getAttribute("title")).toContain("Last edited");

      saveInstallationNote.mockResolvedValueOnce(stored("Second", 2, true));
      await editGlobal("Second");
      await vi.advanceTimersByTimeAsync(1000);
      undoInstallationNote.mockResolvedValueOnce(stored("Shared checklist", 3));
      await click(`${INSTALLATION} .sidebar-notes__link`);
      expect(undoInstallationNote).toHaveBeenCalledWith({ expectedRevision: 2 });
      expect(query<HTMLTextAreaElement>("[data-installation-editor]").value).toBe("Shared checklist");
    });

    it("closes the editor with Escape after saving", async () => {
      await flushPromises();
      await click(`${INSTALLATION} .sidebar-notes__tab-body`);
      saveInstallationNote.mockResolvedValueOnce(stored("Done", 1));
      await editGlobal("Done");
      query("[data-installation-editor]").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await flushPromises();
      expect(saveInstallationNote).toHaveBeenCalledTimes(1);
      expect(host.querySelector("[data-installation-editor]")).toBeNull();
      expect(query(`${INSTALLATION} .sidebar-notes__tab-body`).textContent?.trim()).toBe("Done");
    });

    it("keeps a draft when the note changed elsewhere and offers the latest saved text", async () => {
      await flushPromises();
      await click(`${INSTALLATION} .sidebar-notes__tab-body`);
      saveInstallationNote.mockRejectedValueOnce(new Error("This note has changed. Reload it before trying again."));
      await editGlobal("My draft");
      await vi.advanceTimersByTimeAsync(1000);
      expect(query(`${INSTALLATION} .sidebar-notes__problem`).textContent).toContain("This note has changed");
      expect(query<HTMLTextAreaElement>("[data-installation-editor]").value).toBe("My draft");
      getInstallationNote.mockResolvedValue(stored("Written on the phone", 4, true));
      const reviewLatest = Array.from(host.querySelectorAll<HTMLButtonElement>(`${INSTALLATION} button`)).find(
        (button) => button.textContent?.trim() === "Review latest",
      );
      reviewLatest?.click();
      await flushPromises();
      expect(query(`${INSTALLATION} .sidebar-notes__recovery pre`).textContent).toBe("Written on the phone");
      saveInstallationNote.mockResolvedValueOnce(stored("My draft", 5, true));
      const saveDraft = Array.from(host.querySelectorAll<HTMLButtonElement>(`${INSTALLATION} button`)).find(
        (button) => button.textContent?.trim() === "Save my draft",
      );
      saveDraft?.click();
      await flushPromises();
      expect(saveInstallationNote).toHaveBeenLastCalledWith({ text: "My draft", expectedRevision: 4 });
      expect(host.querySelector(`${INSTALLATION} .sidebar-notes__problem`)).toBeNull();
    });

    it("reloads when the installation counter moves and keeps a draft being typed", async () => {
      await flushPromises();
      const setCounter = async (revision: number) => {
        useAppStore().payload = { installationNoteRevision: revision } as unknown as ReturnType<
          typeof useAppStore
        >["payload"];
        await flushPromises();
      };
      await setCounter(5);
      getInstallationNote.mockClear();
      await setCounter(5);
      expect(getInstallationNote).not.toHaveBeenCalled();
      getInstallationNote.mockResolvedValue(stored("From another device", 1));
      await setCounter(6);
      expect(getInstallationNote).toHaveBeenCalledTimes(1);
      expect(query(`${INSTALLATION} .sidebar-notes__tab-body`).textContent).toContain("From another device");
      await click(`${INSTALLATION} .sidebar-notes__tab-body`);
      await editGlobal("Typing");
      getInstallationNote.mockResolvedValue(stored("Newer elsewhere", 2));
      await setCounter(7);
      expect(query<HTMLTextAreaElement>("[data-installation-editor]").value).toBe("Typing");
    });

    it("shows a load error with a retry that is separate from the other sections", async () => {
      getInstallationNote.mockRejectedValueOnce(new Error("Offline"));
      wrapper.unmount();
      wrapper = mountPanel();
      await flushPromises();
      expect(query(`${INSTALLATION} .sidebar-notes__problem`).textContent).toContain("Offline");
      expect(host.querySelector(".sidebar-notes__load-error")).toBeNull();
      await click(`${INSTALLATION} .sidebar-notes__problem button`);
      expect(host.querySelector(`${INSTALLATION} .sidebar-notes__problem`)).toBeNull();
    });

    it("collapses to its heading, remembers it, and leaves the lower divider inactive", async () => {
      await flushPromises();
      const toggle = query<HTMLButtonElement>(".sidebar-notes__collapse");
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
      toggle.click();
      await flushPromises();
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      expect(host.querySelector(INSTALLATION)).toBeNull();
      expect(host.querySelector(".sidebar-notes__section--installation h3")?.textContent).toBe("Global");
      expect(localStorage.getItem("strideterm.sidebarNotes.installationCollapsed")).toBe("1");
      const [, second] = Array.from(host.querySelectorAll<HTMLElement>(".sidebar-notes__divider"));
      expect(second.getAttribute("aria-disabled")).toBe("true");
      expect(second.getAttribute("tabindex")).toBe("-1");
      wrapper.unmount();
      wrapper = mountPanel();
      await flushPromises();
      expect(host.querySelector(INSTALLATION)).toBeNull();
      query<HTMLButtonElement>(".sidebar-notes__collapse").click();
      await flushPromises();
      expect(host.querySelector(INSTALLATION)).not.toBeNull();
      expect(localStorage.getItem("strideterm.sidebarNotes.installationCollapsed")).toBeNull();
    });
  });

  describe("Global notes of paired desktops", () => {
    const getPeerGlobalNote = vi.fn();
    const savePeerGlobalNote = vi.fn();
    const undoPeerGlobalNote = vi.fn();
    const getPeerHostState = vi.fn();
    let onNoteChanged: ((event: { hostId: string; revision: number }) => void) | null = null;
    let onPeersUpdated: (() => void) | null = null;

    const attached = (id: string, label: string, state: PeerAttachedHost["state"] = "online"): PeerAttachedHost => ({
      id,
      label,
      address: "10.0.0.5",
      port: 43124,
      hostPublicKey: "",
      pairedAt: 1,
      state,
      hostAppVersion: "3.4.1",
      localAppVersion: "3.4.1",
      profiles: [],
      checkedAt: 1,
    });
    const hostNote = (text: string, revision: number, canUndo = false): InstallationNote => ({
      note: { id: "global", text, revision, canUndo, updatedAt: new Date().toISOString() },
      installationName: "ignored-host-name",
    });
    const hostState = (devices: Array<{ id: string; name: string }>): PeerHostState =>
      ({ devices: devices.map((device) => ({ ...device, platform: "win32" })) }) as unknown as PeerHostState;

    async function mountWithHosts(hosts: PeerAttachedHost[], options: { methods?: boolean; isRemote?: boolean } = {}) {
      wrapper.unmount();
      usePeersStore().hosts = hosts;
      const withMethods = options.methods ?? true;
      wrapper = mount(NotesPanel, {
        props: { host, profileId: "profile-a", workspaceId: "workspace-a" },
        global: {
          provide: {
            [apiKey]: {
              isRemote: options.isRemote ?? false,
              listSidebarNotes,
              saveSidebarNote,
              undoSidebarNote,
              getInstallationNote,
              saveInstallationNote,
              undoInstallationNote,
              ...(withMethods
                ? {
                    getPeerGlobalNote,
                    savePeerGlobalNote,
                    undoPeerGlobalNote,
                    getPeerHostState,
                    onPeerHostNoteChanged: (handler: typeof onNoteChanged) => {
                      onNoteChanged = handler;
                      return () => {
                        onNoteChanged = null;
                      };
                    },
                    onPeersUpdated: (handler: () => void) => {
                      onPeersUpdated = handler;
                      return () => {
                        onPeersUpdated = null;
                      };
                    },
                  }
                : {}),
            },
          },
        },
      });
      await flushPromises();
    }

    const titles = () =>
      Array.from(host.querySelectorAll(".sidebar-notes__installation .sidebar-notes__tab-title"), (el) =>
        el.textContent?.trim(),
      );
    const hostCard = (id: string) => query(`[data-host-note="${id}"]`);
    const editHost = async (id: string, value: string) => {
      const editor = hostCard(id).querySelector<HTMLTextAreaElement>("[data-installation-editor]")!;
      editor.value = value;
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      await flushPromises();
    };

    beforeEach(() => {
      onNoteChanged = null;
      onPeersUpdated = null;
      getPeerGlobalNote.mockReset().mockImplementation(async (hostId: string) => hostNote(`note of ${hostId}`, 1));
      savePeerGlobalNote.mockReset();
      undoPeerGlobalNote.mockReset();
      getPeerHostState.mockReset().mockResolvedValue(hostState([]));
      setWindowBackend({ kind: "local" });
    });

    afterEach(() => {
      setWindowBackend({ kind: "local" });
    });

    it("shows this computer first and then one card per online host, ordered by label", async () => {
      await mountWithHosts([attached("host-zzzz0001", "zeta.local"), attached("host-aaaa0001", "alpha.local")]);
      expect(titles()).toEqual(["This computer (PC-1)", "alpha.local", "zeta.local"]);
      expect(getPeerGlobalNote).toHaveBeenCalledWith("host-aaaa0001");
      expect(getPeerGlobalNote).toHaveBeenCalledWith("host-zzzz0001");
      expect(hostCard("host-aaaa0001").textContent).toContain("note of host-aaaa0001");
      expect(host.querySelector(".sidebar-notes__section--installation h3")?.getAttribute("title")).toContain(
        "attached to this one show their own",
      );
      expect(host.querySelector(".sidebar-notes__section--installation h3")?.getAttribute("title")).toContain(
        "readable and editable by its phones, browser sessions and attached desktops",
      );
    });

    it("does no peer work until the Notes tab shows the expanded Global section, then does it once", async () => {
      wrapper.unmount();
      const open = vi.spyOn(usePeersStore(), "open").mockResolvedValue(undefined);
      const mountHidden = () =>
        mount(NotesPanel, {
          props: { host: null, profileId: "profile-a", workspaceId: "workspace-a" },
          global: {
            provide: {
              [apiKey]: {
                isRemote: false,
                listSidebarNotes,
                saveSidebarNote,
                undoSidebarNote,
                getInstallationNote,
                saveInstallationNote,
                undoInstallationNote,
                getPeerGlobalNote,
                savePeerGlobalNote,
                undoPeerGlobalNote,
                getPeerHostState,
                onPeerHostNoteChanged: () => () => undefined,
                onPeersUpdated: () => () => undefined,
              },
            },
          },
        });
      wrapper = mountHidden();
      await flushPromises();
      expect(open).not.toHaveBeenCalled();
      expect(getPeerHostState).not.toHaveBeenCalled();
      await wrapper.setProps({ host });
      await flushPromises();
      expect(open).toHaveBeenCalledTimes(1);
      expect(getPeerHostState).toHaveBeenCalledTimes(1);
      await wrapper.setProps({ host: null });
      await wrapper.setProps({ host });
      await flushPromises();
      expect(open).toHaveBeenCalledTimes(1);

      wrapper.unmount();
      open.mockClear();
      getPeerHostState.mockClear();
      localStorage.setItem("strideterm.sidebarNotes.installationCollapsed", "1");
      wrapper = mountHidden();
      await wrapper.setProps({ host });
      await flushPromises();
      expect(open).not.toHaveBeenCalled();
      query<HTMLButtonElement>(".sidebar-notes__collapse").click();
      await flushPromises();
      expect(open).toHaveBeenCalledTimes(1);
      expect(getPeerHostState).toHaveBeenCalledTimes(1);
    });

    it("shows an offline, unpaired or mismatched host as one status row with a link to Profiles and no editor", async () => {
      const openProfilesDialog = vi.spyOn(useAppStore(), "openProfilesDialog").mockImplementation(() => undefined);
      await mountWithHosts([
        attached("host-aaaa0001", "alpha.local", "offline"),
        attached("host-bbbb0001", "beta.local", "not-paired"),
        attached("host-cccc0001", "gamma.local", "version-mismatch"),
        attached("host-dddd0001", "delta.local", "wrong-host"),
      ]);
      expect(titles()).toEqual(["This computer (PC-1)"]);
      const rows = Array.from(host.querySelectorAll(".sidebar-notes__host-status"), (el) => el.textContent ?? "");
      expect(rows).toHaveLength(4);
      expect(rows[0]).toContain("alpha.local is offline.");
      expect(rows[1]).toContain("beta.local no longer pairs with this desktop.");
      expect(rows[2]).toContain("Another strIDEterm answers at the address of delta.local.");
      expect(rows[3]).toContain("gamma.local runs a different version of strIDEterm.");
      expect(getPeerGlobalNote).not.toHaveBeenCalled();
      expect(host.querySelectorAll("[data-installation-editor]")).toHaveLength(0);
      const link = Array.from(host.querySelectorAll<HTMLButtonElement>(".sidebar-notes__host-status button")).find(
        (button) => button.textContent?.includes("Open Profiles"),
      );
      link?.click();
      expect(openProfilesDialog).toHaveBeenCalledTimes(1);
    });

    it("loads the card when a host comes online", async () => {
      await mountWithHosts([attached("host-aaaa0001", "alpha.local", "offline")]);
      expect(getPeerGlobalNote).not.toHaveBeenCalled();
      usePeersStore().hosts = [attached("host-aaaa0001", "alpha.local", "online")];
      await flushPromises();
      expect(getPeerGlobalNote).toHaveBeenCalledTimes(1);
      expect(titles()).toEqual(["This computer (PC-1)", "alpha.local"]);
    });

    it("edits a host's note through the device channel and saves it with the host's revision", async () => {
      await mountWithHosts([attached("host-aaaa0001", "alpha.local")]);
      hostCard("host-aaaa0001").querySelector<HTMLButtonElement>(".sidebar-notes__tab-body")!.click();
      await flushPromises();
      savePeerGlobalNote.mockResolvedValueOnce(hostNote("changed", 2, true));
      await editHost("host-aaaa0001", "changed");
      expect(host.textContent).toContain("Unsaved changes");
      await vi.advanceTimersByTimeAsync(1000);
      expect(savePeerGlobalNote).toHaveBeenCalledWith("host-aaaa0001", { text: "changed", expectedRevision: 1 });
      expect(saveInstallationNote).not.toHaveBeenCalled();
      expect(hostCard("host-aaaa0001").querySelector(".sidebar-notes__status--saved")?.textContent).toContain(
        "✓ Saved",
      );
      undoPeerGlobalNote.mockResolvedValueOnce(hostNote("note of host-aaaa0001", 3));
      hostCard("host-aaaa0001").querySelector<HTMLButtonElement>(".sidebar-notes__link")!.click();
      await flushPromises();
      expect(undoPeerGlobalNote).toHaveBeenCalledWith("host-aaaa0001", { expectedRevision: 2 });
    });

    it("keeps the draft on a conflict, shows the host's sentence and offers the latest saved text", async () => {
      await mountWithHosts([attached("host-aaaa0001", "alpha.local")]);
      hostCard("host-aaaa0001").querySelector<HTMLButtonElement>(".sidebar-notes__tab-body")!.click();
      await flushPromises();
      savePeerGlobalNote.mockRejectedValueOnce(
        new Error(
          "Error invoking remote method 'peers:client:global-note:save': Error: This note has changed. Reload it before trying again.",
        ),
      );
      await editHost("host-aaaa0001", "My draft");
      await vi.advanceTimersByTimeAsync(1000);
      const problem = hostCard("host-aaaa0001").querySelector(".sidebar-notes__problem")!;
      expect(problem.textContent).toContain("This note has changed. Reload it before trying again.");
      expect(problem.textContent).not.toContain("Error invoking");
      getPeerGlobalNote.mockResolvedValue(hostNote("Written on the host", 4, true));
      Array.from(hostCard("host-aaaa0001").querySelectorAll<HTMLButtonElement>("button"))
        .find((button) => button.textContent?.trim() === "Review latest")!
        .click();
      await flushPromises();
      expect(hostCard("host-aaaa0001").querySelector(".sidebar-notes__recovery pre")?.textContent).toBe(
        "Written on the host",
      );
      savePeerGlobalNote.mockResolvedValueOnce(hostNote("My draft", 5, true));
      Array.from(hostCard("host-aaaa0001").querySelectorAll<HTMLButtonElement>("button"))
        .find((button) => button.textContent?.trim() === "Save my draft")!
        .click();
      await flushPromises();
      expect(savePeerGlobalNote).toHaveBeenLastCalledWith("host-aaaa0001", { text: "My draft", expectedRevision: 4 });
    });

    it("shows a load failure in the card with a retry that does not touch the other cards", async () => {
      getPeerGlobalNote.mockRejectedValueOnce(new Error("Host PC cannot be reached."));
      await mountWithHosts([attached("host-aaaa0001", "alpha.local")]);
      expect(hostCard("host-aaaa0001").querySelector(".sidebar-notes__problem")?.textContent).toContain(
        "Host PC cannot be reached.",
      );
      expect(query(INSTALLATION).querySelector(".sidebar-notes__problem")).toBeNull();
      hostCard("host-aaaa0001").querySelector<HTMLButtonElement>(".sidebar-notes__problem button")!.click();
      await flushPromises();
      expect(hostCard("host-aaaa0001").querySelector(".sidebar-notes__problem")).toBeNull();
    });

    it("reloads a card when its host reports a change, keeps a draft being typed, and ignores other hosts", async () => {
      await mountWithHosts([
        attached("host-aaaa0001", "alpha.local"),
        attached("host-bbbb0001", "beta.local", "offline"),
      ]);
      expect(onNoteChanged).not.toBeNull();
      getPeerGlobalNote.mockClear();
      onNoteChanged!({ hostId: "host-unknown1", revision: 3 });
      onNoteChanged!({ hostId: "host-bbbb0001", revision: 3 });
      await flushPromises();
      expect(getPeerGlobalNote).not.toHaveBeenCalled();

      getPeerGlobalNote.mockResolvedValue(hostNote("Changed on the host", 2, true));
      onNoteChanged!({ hostId: "host-aaaa0001", revision: 2 });
      await flushPromises();
      expect(getPeerGlobalNote).toHaveBeenCalledTimes(1);
      expect(hostCard("host-aaaa0001").textContent).toContain("Changed on the host");

      hostCard("host-aaaa0001").querySelector<HTMLButtonElement>(".sidebar-notes__tab-body")!.click();
      await flushPromises();
      await editHost("host-aaaa0001", "Typing");
      getPeerGlobalNote.mockResolvedValue(hostNote("Newer on the host", 3, true));
      onNoteChanged!({ hostId: "host-aaaa0001", revision: 3 });
      await flushPromises();
      expect(hostCard("host-aaaa0001").querySelector<HTMLTextAreaElement>("[data-installation-editor]")!.value).toBe(
        "Typing",
      );
    });

    it("reloads the host cards when the section is expanded again", async () => {
      await mountWithHosts([attached("host-aaaa0001", "alpha.local")]);
      query<HTMLButtonElement>(".sidebar-notes__collapse").click();
      await flushPromises();
      expect(host.querySelector("[data-host-note]")).toBeNull();
      getPeerGlobalNote.mockClear();
      query<HTMLButtonElement>(".sidebar-notes__collapse").click();
      await flushPromises();
      expect(getPeerGlobalNote).toHaveBeenCalledWith("host-aaaa0001");
    });

    it("shows no host cards on a remote client, without the device methods, or in a window attached to another desktop", async () => {
      const hosts = [attached("host-aaaa0001", "alpha.local")];
      await mountWithHosts(hosts, { methods: false });
      expect(titles()).toEqual(["This computer (PC-1)"]);
      expect(host.querySelector(".sidebar-notes__host-status")).toBeNull();

      await mountWithHosts(hosts, { isRemote: true });
      expect(titles()).toEqual(["PC-1"]);
      expect(host.querySelector(".sidebar-notes__host-status")).toBeNull();

      setWindowBackend({
        kind: "peer",
        hostId: "host-aaaa0001",
        hostLabel: "alpha.local",
        remoteProfileId: "home",
        clientId: "wclient",
        terminalFontSize: 13,
      });
      await mountWithHosts(hosts);
      expect(titles()).toEqual(["PC-1"]);
      expect(getPeerGlobalNote).not.toHaveBeenCalled();
      expect(getPeerHostState).not.toHaveBeenCalled();
    });

    it("lists a paired device whose note cannot be seen here, but not one that is also an attached host", async () => {
      getPeerHostState.mockResolvedValue(
        hostState([
          { id: "host-aaaa0001", name: "Laptop that is also attached" },
          { id: "device-zzzz01", name: "Zed-PC" },
          { id: "device-aaaa01", name: "Alpha-PC" },
        ]),
      );
      await mountWithHosts([attached("host-aaaa0001", "alpha.local")]);
      const rows = Array.from(host.querySelectorAll(".sidebar-notes__host-status"), (el) => el.textContent?.trim());
      expect(rows).toEqual([
        "Alpha-PC is connected to this computer. You will see its note here once you connect to it from here too.",
        "Zed-PC is connected to this computer. You will see its note here once you connect to it from here too.",
      ]);
      expect(host.querySelector(".sidebar-notes__host-status button")).toBeNull();
      expect(titles()).toEqual(["This computer (PC-1)", "alpha.local"]);

      getPeerHostState.mockResolvedValue(hostState([{ id: "device-zzzz01", name: "Zed-PC" }]));
      onPeersUpdated!();
      await flushPromises();
      expect(host.querySelectorAll(".sidebar-notes__host-status")).toHaveLength(1);
    });

    it("lists no device rows without paired devices, and none in a remote client", async () => {
      await mountWithHosts([]);
      expect(host.querySelector(".sidebar-notes__host-status")).toBeNull();
      getPeerHostState.mockResolvedValue(hostState([{ id: "device-zzzz01", name: "Zed-PC" }]));
      await mountWithHosts([], { isRemote: true });
      expect(host.querySelector(".sidebar-notes__host-status")).toBeNull();
    });
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
