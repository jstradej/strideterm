import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";

vi.unmock("./MonacoDiffPanel.vue");

const monacoHarness = vi.hoisted(() => {
  let model: { original: Model; modified: Model } | null = null;
  let diffUpdated: (() => void) | null = null;
  const setModel = vi.fn((next: { original: Model; modified: Model } | null) => {
    model = next;
  });
  const revealFirstDiff = vi.fn();
  const updateDiffDisposable = { dispose: vi.fn() };
  const editorSide = {
    getModel: () => null,
    revealLine: vi.fn(),
    revealLineInCenter: vi.fn(),
    setPosition: vi.fn(),
    focus: vi.fn(),
  };
  const editor = {
    setModel,
    getModel: () => model,
    getLineChanges: vi.fn(() => []),
    revealFirstDiff,
    onDidUpdateDiff: vi.fn((callback: () => void) => {
      diffUpdated = callback;
      return updateDiffDisposable;
    }),
    getOriginalEditor: () => editorSide,
    getModifiedEditor: () => editorSide,
    updateOptions: vi.fn(),
    layout: vi.fn(),
    dispose: vi.fn(),
  };
  const models: Model[] = [];
  return {
    editor,
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
    updateDiffDisposable,
    revealFirstDiff,
    setModel,
    reset() {
      model = null;
      diffUpdated = null;
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
  observe() {}
  disconnect() {}
}

describe("MonacoDiffPanel first change reveal", () => {
  beforeEach(() => {
    monacoHarness.reset();
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
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

    wrapper.unmount();
    expect(monacoHarness.updateDiffDisposable.dispose).toHaveBeenCalledOnce();
    onUpdate?.();
    expect(monacoHarness.revealFirstDiff).toHaveBeenCalledOnce();
  });
});
