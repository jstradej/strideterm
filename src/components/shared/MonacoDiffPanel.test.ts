import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";

vi.unmock("./MonacoDiffPanel.vue");

const monacoHarness = vi.hoisted(() => {
  let model: { original: Model; modified: Model } | null = null;
  let diffUpdated: (() => void) | null = null;
  let paneWidths = { original: 320, modified: 480, originalContent: 240, modifiedContent: 400 };
  let domNodesAvailable = true;
  const paneLayoutListeners: Record<"original" | "modified", Array<() => void>> = { original: [], modified: [] };
  const paneLayoutDisposables: Array<{ dispose: ReturnType<typeof vi.fn> }> = [];
  function emitPaneLayout(side: "original" | "modified") {
    paneLayoutListeners[side].forEach((listener) => listener());
  }
  const setModel = vi.fn((next: { original: Model; modified: Model } | null) => {
    model = next;
  });
  const revealFirstDiff = vi.fn();
  const updateDiffDisposable = { dispose: vi.fn() };
  function createEditorSide(side: "original" | "modified") {
    return {
      getLayoutInfo: () => ({
        width: paneWidths[side],
        contentWidth: side === "original" ? paneWidths.originalContent : paneWidths.modifiedContent,
      }),
      getDomNode: () =>
        domNodesAvailable
          ? {
              getBoundingClientRect: () => ({
                left: side === "original" ? 0 : paneWidths.original + 8,
                right: side === "original" ? paneWidths.original : paneWidths.original + 8 + paneWidths[side],
              }),
            }
          : null,
      onDidLayoutChange: vi.fn((listener: () => void) => {
        paneLayoutListeners[side].push(listener);
        const disposable = {
          dispose: vi.fn(() => {
            const index = paneLayoutListeners[side].indexOf(listener);
            if (index >= 0) paneLayoutListeners[side].splice(index, 1);
          }),
        };
        paneLayoutDisposables.push(disposable);
        return disposable;
      }),
      getModel: () => null,
      revealLine: vi.fn(),
      revealLineInCenter: vi.fn(),
      setPosition: vi.fn(),
      focus: vi.fn(),
    };
  }
  const originalEditor = createEditorSide("original");
  const modifiedEditor = createEditorSide("modified");
  const editor = {
    setModel,
    getModel: () => model,
    getLineChanges: vi.fn(() => []),
    revealFirstDiff,
    onDidUpdateDiff: vi.fn((callback: () => void) => {
      diffUpdated = callback;
      return updateDiffDisposable;
    }),
    getOriginalEditor: () => originalEditor,
    getModifiedEditor: () => modifiedEditor,
    updateOptions: vi.fn(),
    layout: vi.fn(() => {
      emitPaneLayout("original");
      emitPaneLayout("modified");
    }),
    dispose: vi.fn(),
  };
  const models: Model[] = [];
  return {
    editor,
    paneLayoutDisposables,
    models,
    createModel: vi.fn((value: string, language: string) => {
      const created = {
        getValue: () => value,
        getLanguageId: () => language,
        getLineCount: () => value.split("\n").length,
        dispose: vi.fn(),
      };
      models.push(created);
      return created;
    }),
    createDiffEditor: vi.fn(() => editor),
    getDiffUpdated: () => diffUpdated,
    setPaneWidths(
      original: number,
      modified: number,
      originalContent = original - 80,
      modifiedContent = modified - 80,
    ) {
      paneWidths = { original, modified, originalContent, modifiedContent };
    },
    setDomNodesAvailable(available: boolean) {
      domNodesAvailable = available;
    },
    emitPaneLayout,
    updateDiffDisposable,
    revealFirstDiff,
    setModel,
    reset() {
      model = null;
      diffUpdated = null;
      paneWidths = { original: 320, modified: 480, originalContent: 240, modifiedContent: 400 };
      domNodesAvailable = true;
      paneLayoutListeners.original.length = 0;
      paneLayoutListeners.modified.length = 0;
      paneLayoutDisposables.length = 0;
      models.length = 0;
      vi.clearAllMocks();
    },
  };
});

type Model = ReturnType<(typeof monacoHarness)["createModel"]>;

vi.mock("monaco-editor", () => ({
  editor: {
    createDiffEditor: monacoHarness.createDiffEditor,
    createModel: monacoHarness.createModel,
  },
}));
vi.mock("../../app/monaco-setup.js", () => ({}));

import MonacoDiffPanel from "./MonacoDiffPanel.vue";

class ResizeObserverMock {
  static instances: ResizeObserverMock[] = [];

  constructor(private readonly _callback: ResizeObserverCallback) {
    ResizeObserverMock.instances.push(this);
  }

  observe() {}
  disconnect() {}

  trigger() {
    this._callback([], this as unknown as ResizeObserver);
  }
}

let nextFrameId = 0;
const pendingFrames = new Map<number, FrameRequestCallback>();

function flushLayoutFrames() {
  const frames = [...pendingFrames.values()];
  pendingFrames.clear();
  frames.forEach((callback) => callback(0));
}

describe("MonacoDiffPanel first change reveal", () => {
  beforeEach(() => {
    monacoHarness.reset();
    ResizeObserverMock.instances.length = 0;
    pendingFrames.clear();
    nextFrameId = 0;
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const id = ++nextFrameId;
      pendingFrames.set(id, callback);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => pendingFrames.delete(id));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([false, true])("reveals the first change after diff calculation (inline: %s)", async (initialInline) => {
    const wrapper = mount(MonacoDiffPanel, {
      props: { initialInline, payload: { leftContent: "same\nold", rightContent: "same\nnew" } },
    });
    await flushPromises();

    expect(monacoHarness.revealFirstDiff).not.toHaveBeenCalled();
    monacoHarness.getDiffUpdated()?.();
    expect(monacoHarness.revealFirstDiff).toHaveBeenCalledOnce();

    wrapper.unmount();
  });

  it("preserves an explicit target line instead of applying the default first-diff reveal", async () => {
    const wrapper = mount(MonacoDiffPanel, {
      props: { targetLine: 4, payload: { leftContent: "old", rightContent: "new" } },
    });
    await flushPromises();
    monacoHarness.getDiffUpdated()?.();

    expect(monacoHarness.revealFirstDiff).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("does not reset the reveal for same-content refreshes or later diff events", async () => {
    const payload = { leftContent: "same\nold", rightContent: "same\nnew", language: "typescript" };
    const wrapper = mount(MonacoDiffPanel, { props: { payload, popoutTitle: "src/a.ts @ abc123" } });
    await flushPromises();
    monacoHarness.getDiffUpdated()?.();
    await wrapper.setProps({ payload: { ...payload } });
    await flushPromises();
    monacoHarness.getDiffUpdated()?.();

    expect(monacoHarness.setModel).toHaveBeenCalledOnce();
    expect(monacoHarness.revealFirstDiff).toHaveBeenCalledOnce();
    wrapper.unmount();
  });

  it("reveals again when identical content belongs to a different comparison", async () => {
    const payload = {
      leftLabel: "HEAD",
      rightLabel: "working tree",
      leftContent: "same\nold",
      rightContent: "same\nnew",
    };
    const wrapper = mount(MonacoDiffPanel, { props: { payload, popoutTitle: "src/a.ts (working)" } });
    await flushPromises();
    monacoHarness.getDiffUpdated()?.();
    expect(monacoHarness.revealFirstDiff).toHaveBeenCalledOnce();

    await wrapper.setProps({ popoutTitle: "src/b.ts (working)" });
    await flushPromises();

    expect(monacoHarness.setModel).toHaveBeenCalledOnce();
    expect(monacoHarness.revealFirstDiff).toHaveBeenCalledTimes(2);
    wrapper.unmount();
  });

  it.each([
    ["insertion", "before", "before\nadded"],
    ["deletion", "before\nremoved", "before"],
  ])("reveals a new %s diff after a rapid payload switch", async (_kind, leftContent, rightContent) => {
    const wrapper = mount(MonacoDiffPanel, {
      props: { payload: { leftContent: "old", rightContent: "new" } },
    });
    await flushPromises();
    await wrapper.setProps({ payload: { leftContent, rightContent } });
    await flushPromises();

    // This may be an event queued by the superseded model pair. The callback
    // must only consume the pending reveal for the model currently installed.
    monacoHarness.getDiffUpdated()?.();
    expect(monacoHarness.revealFirstDiff).toHaveBeenCalledOnce();
    expect(monacoHarness.setModel).toHaveBeenCalledTimes(2);

    wrapper.unmount();
  });

  it("handles an empty diff and disposes the pending listener on unmount", async () => {
    const wrapper = mount(MonacoDiffPanel, {
      props: { payload: { leftContent: "unchanged", rightContent: "unchanged" } },
    });
    await flushPromises();
    const onUpdate = monacoHarness.getDiffUpdated();
    onUpdate?.();
    expect(monacoHarness.revealFirstDiff).toHaveBeenCalledOnce();

    monacoHarness.emitPaneLayout("original");
    expect(pendingFrames.size).toBe(1);
    wrapper.unmount();
    expect(pendingFrames.size).toBe(0);
    expect(monacoHarness.updateDiffDisposable.dispose).toHaveBeenCalledOnce();
    expect(monacoHarness.paneLayoutDisposables).toHaveLength(2);
    expect(monacoHarness.paneLayoutDisposables.every(({ dispose }) => dispose.mock.calls.length === 1)).toBe(true);
    onUpdate?.();
    expect(monacoHarness.revealFirstDiff).toHaveBeenCalledOnce();
  });

  it("tracks the internal sash using each editor's measured width", async () => {
    const wrapper = mount(MonacoDiffPanel, {
      props: { payload: { leftContent: "old", rightContent: "new" } },
    });
    await flushPromises();
    const labels = wrapper.get(".mdp__labels");

    expect(labels.attributes("style")).toContain("grid-template-columns: 320px 480px");
    expect(labels.attributes("style")).toContain("column-gap: 8px");

    monacoHarness.setPaneWidths(410, 390);
    monacoHarness.emitPaneLayout("original");
    monacoHarness.emitPaneLayout("modified");
    flushLayoutFrames();
    await flushPromises();

    expect(labels.attributes("style")).toContain("grid-template-columns: 410px 390px");
    expect(labels.attributes("style")).toContain("column-gap: 8px");
    wrapper.unmount();
  });

  it("uses zero sash gap until Monaco pane nodes are available, then measures the gap", async () => {
    monacoHarness.setDomNodesAvailable(false);
    const wrapper = mount(MonacoDiffPanel, {
      props: { payload: { leftContent: "old", rightContent: "new" } },
    });
    await flushPromises();
    const labels = wrapper.get(".mdp__labels");

    expect(labels.attributes("style")).toContain("grid-template-columns: 320px 480px");
    expect(labels.attributes("style")).toContain("column-gap: 0px");

    monacoHarness.setDomNodesAvailable(true);
    monacoHarness.emitPaneLayout("original");
    flushLayoutFrames();
    await flushPromises();
    expect(labels.attributes("style")).toContain("column-gap: 8px");
    wrapper.unmount();
  });

  it("tracks an outer panel resize and switches to inline metadata when Monaco hides a side", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 1008,
      height: 300,
    } as DOMRect);
    const wrapper = mount(MonacoDiffPanel, {
      props: { payload: { leftContent: "old", rightContent: "new" } },
    });
    await flushPromises();

    monacoHarness.setPaneWidths(490, 510);
    ResizeObserverMock.instances[0].trigger();
    flushLayoutFrames();
    await flushPromises();

    const labels = wrapper.get(".mdp__labels");
    expect(monacoHarness.editor.layout).toHaveBeenCalled();
    expect(labels.attributes("style")).toContain("grid-template-columns: 490px 510px");
    expect(labels.attributes("style")).toContain("column-gap: 8px");

    monacoHarness.setPaneWidths(0, 1008, 0, 928);
    monacoHarness.emitPaneLayout("original");
    monacoHarness.emitPaneLayout("modified");
    flushLayoutFrames();
    await flushPromises();
    expect(labels.classes()).toContain("mdp__labels--inline");
    expect(labels.attributes("style") || "").not.toContain("grid-template-columns");

    monacoHarness.setPaneWidths(490, 510);
    monacoHarness.emitPaneLayout("modified");
    flushLayoutFrames();
    await flushPromises();
    expect(labels.classes()).not.toContain("mdp__labels--inline");
    expect(labels.attributes("style")).toContain("grid-template-columns: 490px 510px");
    wrapper.unmount();
  });
});
