import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotePopoutTarget, SidebarNote } from "../electron/shared/sidebar-notes.js";
import NotePopoutApp from "./NotePopoutApp.vue";
import { useAppStore } from "./stores/app.js";
import { apiKey } from "./types/keys.js";

const listSidebarNotes = vi.fn();
const saveSidebarNote = vi.fn();
const undoSidebarNote = vi.fn();
const getInstallationNote = vi.fn();
const saveInstallationNote = vi.fn();
const undoInstallationNote = vi.fn();
const getPeerGlobalNote = vi.fn();
const savePeerGlobalNote = vi.fn();
const undoPeerGlobalNote = vi.fn();
const listPeerHosts = vi.fn();
const getNotePopoutInit = vi.fn();
let hostNoteHandler: ((event: { hostId: string; revision: number }) => void) | null = null;

const noteTarget: NotePopoutTarget = { kind: "note", profileId: "p", workspaceId: "w", noteId: "n1" };
const record = (text: string, revision: number, canUndo = false): SidebarNote => ({
  id: "n1",
  text,
  revision,
  canUndo,
});
const CHANGED = "This note has changed. Reload it before trying again.";

let wrapper: VueWrapper;

async function mountApp(target: NotePopoutTarget | null = noteTarget) {
  getNotePopoutInit.mockResolvedValue(target);
  wrapper = mount(NotePopoutApp, {
    global: {
      provide: {
        [apiKey]: {
          listSidebarNotes,
          saveSidebarNote,
          undoSidebarNote,
          getInstallationNote,
          saveInstallationNote,
          undoInstallationNote,
          getPeerGlobalNote,
          savePeerGlobalNote,
          undoPeerGlobalNote,
          listPeerHosts,
          getNotePopoutInit,
          onPeerHostNoteChanged: (handler: typeof hostNoteHandler) => {
            hostNoteHandler = handler;
            return () => {
              hostNoteHandler = null;
            };
          },
        },
      },
    },
  });
  await flushPromises();
  return wrapper;
}

async function type(value: string) {
  await wrapper.get<HTMLTextAreaElement>("textarea").setValue(value);
  await flushPromises();
}

const editorValue = () => wrapper.get<HTMLTextAreaElement>("textarea").element.value;
const button = (label: string) => wrapper.findAll("button").find((entry) => entry.text() === label);
const setPayload = (payload: Record<string, unknown>) => {
  useAppStore().payload = payload as never;
};

beforeEach(() => {
  vi.useFakeTimers();
  setActivePinia(createPinia());
  for (const mock of [
    listSidebarNotes,
    saveSidebarNote,
    undoSidebarNote,
    getInstallationNote,
    saveInstallationNote,
    undoInstallationNote,
    getPeerGlobalNote,
    savePeerGlobalNote,
    undoPeerGlobalNote,
    listPeerHosts,
    getNotePopoutInit,
  ])
    mock.mockReset();
  hostNoteHandler = null;
  listSidebarNotes.mockResolvedValue({ workspace: [record("First line\nrest", 3, true)], global: [] });
});

afterEach(() => {
  wrapper?.unmount();
  vi.useRealTimers();
});

describe("NotePopoutApp", () => {
  it("loads the note, names the window after it and autosaves with expectedRevision after 1 s", async () => {
    saveSidebarNote.mockResolvedValue(record("changed", 4));
    await mountApp();
    expect(editorValue()).toBe("First line\nrest");
    expect(document.title).toBe("First line");
    await type("changed");
    await vi.advanceTimersByTimeAsync(999);
    expect(saveSidebarNote).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(saveSidebarNote).toHaveBeenCalledWith({
      profileId: "p",
      workspaceId: "w",
      id: "n1",
      text: "changed",
      expectedRevision: 3,
    });
    expect(wrapper.text()).toContain("Saved");
  });

  it("saves on blur at once and undoes through the runtime", async () => {
    saveSidebarNote.mockResolvedValue(record("x", 4, true));
    undoSidebarNote.mockResolvedValue(record("First line\nrest", 5));
    await mountApp();
    await type("x");
    await wrapper.get("textarea").trigger("blur");
    await flushPromises();
    expect(saveSidebarNote).toHaveBeenCalledTimes(1);
    await button("Undo last save")!.trigger("click");
    await flushPromises();
    expect(undoSidebarNote).toHaveBeenCalledWith({ profileId: "p", workspaceId: "w", id: "n1", expectedRevision: 4 });
    expect(editorValue()).toBe("First line\nrest");
  });

  it("offers the saved version or keeping the text after a conflict", async () => {
    saveSidebarNote.mockRejectedValueOnce(new Error(CHANGED));
    await mountApp();
    await type("mine");
    await vi.advanceTimersByTimeAsync(1000);
    expect(wrapper.get('[role="alert"]').text()).toContain("This note has changed");

    listSidebarNotes.mockResolvedValue({ workspace: [record("theirs", 7)], global: [] });
    saveSidebarNote.mockResolvedValue(record("mine", 8));
    await button("Keep mine")!.trigger("click");
    await flushPromises();
    expect(saveSidebarNote).toHaveBeenLastCalledWith(expect.objectContaining({ text: "mine", expectedRevision: 7 }));

    saveSidebarNote.mockRejectedValueOnce(new Error(CHANGED));
    await type("mine again");
    await vi.advanceTimersByTimeAsync(1000);
    listSidebarNotes.mockResolvedValue({ workspace: [record("theirs 2", 9)], global: [] });
    await button("Load the saved version")!.trigger("click");
    await flushPromises();
    expect(editorValue()).toBe("theirs 2");
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  });

  it("reloads when the profile counter moves, but never over unsaved text", async () => {
    setPayload({ sidebarNotesRevisions: { p: 1 } });
    await mountApp();
    listSidebarNotes.mockResolvedValue({ workspace: [record("elsewhere", 4)], global: [] });
    setPayload({ sidebarNotesRevisions: { p: 2 } });
    await flushPromises();
    expect(editorValue()).toBe("elsewhere");

    saveSidebarNote.mockImplementation(() => new Promise(() => {}));
    await type("typing");
    listSidebarNotes.mockResolvedValue({ workspace: [record("again elsewhere", 5)], global: [] });
    setPayload({ sidebarNotesRevisions: { p: 3 } });
    await flushPromises();
    expect(editorValue()).toBe("typing");
  });

  it("tints a workspace or profile note by its colour and follows reloads, even over unsaved text", async () => {
    listSidebarNotes.mockResolvedValue({
      workspace: [{ ...record("First line\nrest", 3), color: "green" }],
      global: [],
    });
    setPayload({ sidebarNotesRevisions: { p: 1 } });
    await mountApp();
    expect(wrapper.get(".note-popout").classes()).toContain("note-popout--green");
    listSidebarNotes.mockResolvedValue({ workspace: [{ ...record("First line\nrest", 3), color: "red" }], global: [] });
    setPayload({ sidebarNotesRevisions: { p: 2 } });
    await flushPromises();
    expect(wrapper.get(".note-popout").classes()).toContain("note-popout--red");
    saveSidebarNote.mockImplementation(() => new Promise(() => {}));
    await type("typing");
    listSidebarNotes.mockResolvedValue({ workspace: [record("First line\nrest", 3)], global: [] });
    setPayload({ sidebarNotesRevisions: { p: 3 } });
    await flushPromises();
    expect(editorValue()).toBe("typing");
    expect(wrapper.get(".note-popout").classes().join(" ")).not.toMatch(/note-popout--(green|orange|red)/);
  });

  it("never tints the installation note", async () => {
    getInstallationNote.mockResolvedValue({
      note: { id: "global", text: "g", revision: 2, canUndo: false, color: "red" },
      installationName: "PC-1",
    });
    await mountApp({ kind: "installation" });
    expect(wrapper.get(".note-popout").classes()).toEqual(["note-popout"]);
  });

  it("shows a muted message and no editor when the note is gone", async () => {
    await mountApp();
    listSidebarNotes.mockResolvedValue({ workspace: [], global: [] });
    setPayload({ sidebarNotesRevisions: { p: 9 } });
    await flushPromises();
    expect(wrapper.find("textarea").exists()).toBe(false);
    expect(wrapper.text()).toContain("This note no longer exists.");
  });

  it("treats a vanished workspace as gone", async () => {
    listSidebarNotes.mockRejectedValue(new Error("Notes workspace is unavailable in the active profile."));
    await mountApp();
    expect(wrapper.find("textarea").exists()).toBe(false);
    expect(wrapper.text()).toContain("no longer available");
  });

  it("flushes unsaved text on close, closes only after the save and stays open on failure", async () => {
    const close = vi.spyOn(window, "close").mockImplementation(() => undefined);
    saveSidebarNote.mockRejectedValueOnce(new Error("disk full"));
    await mountApp();
    await type("unsaved");
    const first = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(first);
    await flushPromises();
    expect(first.defaultPrevented).toBe(true);
    expect(close).not.toHaveBeenCalled();
    expect(wrapper.get('[role="alert"]').text()).toContain("disk full");
    expect(editorValue()).toBe("unsaved");

    saveSidebarNote.mockResolvedValue(record("unsaved", 4));
    window.dispatchEvent(new Event("beforeunload", { cancelable: true }));
    await flushPromises();
    expect(saveSidebarNote).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(1);

    const clean = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);
  });

  it("does not block closing a note with nothing unsaved", async () => {
    await mountApp();
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("edits the installation note with its name in the title, reloading on the counter", async () => {
    getInstallationNote.mockResolvedValue({
      note: { id: "global", text: "g", revision: 2, canUndo: false },
      installationName: "PC-1",
    });
    saveInstallationNote.mockResolvedValue({
      note: { id: "global", text: "g2", revision: 3, canUndo: false },
      installationName: "PC-1",
    });
    setPayload({ installationNoteRevision: 1 });
    await mountApp({ kind: "installation" });
    expect(document.title).toBe("Global — This computer (PC-1)");
    await type("g2");
    await vi.advanceTimersByTimeAsync(1000);
    expect(saveInstallationNote).toHaveBeenCalledWith({ text: "g2", expectedRevision: 2 });
    getInstallationNote.mockResolvedValue({
      note: { id: "global", text: "other", revision: 4, canUndo: false },
      installationName: "PC-1",
    });
    setPayload({ installationNoteRevision: 2 });
    await flushPromises();
    expect(editorValue()).toBe("other");
  });

  it("edits a host's note, titles it by the host label and reloads on its change event only", async () => {
    listPeerHosts.mockResolvedValue([{ id: "host-1", label: "alpha.local" }]);
    getPeerGlobalNote.mockResolvedValue({
      note: { id: "global", text: "h", revision: 1, canUndo: false },
      installationName: "ignored",
    });
    savePeerGlobalNote.mockResolvedValue({
      note: { id: "global", text: "h2", revision: 2, canUndo: false },
      installationName: "ignored",
    });
    await mountApp({ kind: "host", hostId: "host-1" });
    expect(document.title).toBe("Global — alpha.local");
    await type("h2");
    await vi.advanceTimersByTimeAsync(1000);
    expect(savePeerGlobalNote).toHaveBeenCalledWith("host-1", { text: "h2", expectedRevision: 1 });
    getPeerGlobalNote.mockClear();
    hostNoteHandler?.({ hostId: "host-2", revision: 5 });
    await flushPromises();
    expect(getPeerGlobalNote).not.toHaveBeenCalled();
    hostNoteHandler?.({ hostId: "host-1", revision: 5 });
    await flushPromises();
    expect(getPeerGlobalNote).toHaveBeenCalledTimes(1);
  });

  it("edits a tab note from the state payload without undo, and shows gone when the tab is removed", async () => {
    const workspace = { id: "w", profileId: "p", panels: [{ id: "t1", title: "Shell", notes: "tab text" }] };
    setPayload({ appState: { workspaces: [workspace] } });
    const saveTabNote = vi.spyOn(useAppStore(), "saveTabNote").mockResolvedValue(undefined);
    await mountApp({ kind: "tab", profileId: "p", viewId: "w:t1" });
    expect(document.title).toBe("Tab note — Shell");
    expect(editorValue()).toBe("tab text");
    await type("");
    await vi.advanceTimersByTimeAsync(1000);
    expect(saveTabNote).toHaveBeenCalledWith("w:t1", "");
    expect(button("Undo last save")).toBeUndefined();

    setPayload({ appState: { workspaces: [{ ...workspace, panels: [] }] } });
    await flushPromises();
    expect(wrapper.find("textarea").exists()).toBe(false);
    expect(wrapper.text()).toContain("This note no longer exists.");
  });

  it("explains a window that has no note to show", async () => {
    await mountApp(null);
    expect(wrapper.get('[role="alert"]').text()).toContain("no note to show");
  });
});
