import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { nextTick } from "vue";
import TerminalSearchOverlay from "./TerminalSearchOverlay.vue";

// The overlay only talks to the store via three methods. Mocking the store
// module lets us hand it a fake SearchAddon stub and inspect calls without
// standing up the full terminal-controller pipeline.
const stubAddon = {
  findNext: vi.fn(),
  findPrevious: vi.fn(),
  clearDecorations: vi.fn(),
  onDidChangeResults: vi.fn(() => ({ dispose: vi.fn() })),
};
const focusActiveTerminalMock = vi.fn();
const getSearchAddonMock = vi.fn(() => stubAddon);

vi.mock("../../stores/terminal.js", () => ({
  useTerminalStore: () => ({
    getSearchAddon: getSearchAddonMock,
    focusActiveTerminal: focusActiveTerminalMock,
    requestSearch: (sessionId: string) =>
      window.dispatchEvent(new CustomEvent("strideterm:terminal-search", { detail: { sessionId } })),
  }),
}));

const SESSION_ID = "workspace-1:shell-1";
const OTHER_SESSION_ID = "workspace-1:shell-2";

function openOverlay(sessionId: string = SESSION_ID): void {
  window.dispatchEvent(new CustomEvent("strideterm:terminal-search", { detail: { sessionId } }));
}

// Capture the change-results callback the overlay registered so tests can
// drive its "X of Y" path independently of the addon's real timing.
function lastResultsCallback(): ((event: { resultIndex: number; resultCount: number }) => void) | null {
  const calls = stubAddon.onDidChangeResults.mock.calls as unknown as Array<
    [(event: { resultIndex: number; resultCount: number }) => void]
  >;
  if (calls.length === 0) return null;
  return calls[calls.length - 1][0];
}

describe("TerminalSearchOverlay", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    stubAddon.findNext.mockReset();
    stubAddon.findPrevious.mockReset();
    stubAddon.clearDecorations.mockReset();
    stubAddon.onDidChangeResults.mockReset();
    stubAddon.onDidChangeResults.mockImplementation(() => ({ dispose: vi.fn() }));
    focusActiveTerminalMock.mockReset();
    getSearchAddonMock.mockReset();
    getSearchAddonMock.mockReturnValue(stubAddon);
    document.body.innerHTML = "";
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  test("renders nothing before the open event fires", () => {
    const wrapper = mount(TerminalSearchOverlay, { props: { sessionId: SESSION_ID } });
    expect(wrapper.find(".term-search").exists()).toBe(false);
  });

  test("opens when the window search event targets our session", async () => {
    const wrapper = mount(TerminalSearchOverlay, {
      props: { sessionId: SESSION_ID },
      attachTo: document.body,
    });
    openOverlay(SESSION_ID);
    await nextTick();
    expect(wrapper.find(".term-search").exists()).toBe(true);
    expect(wrapper.find(".term-search__input").exists()).toBe(true);
  });

  test("ignores window search events for a different session", async () => {
    const wrapper = mount(TerminalSearchOverlay, { props: { sessionId: SESSION_ID } });
    openOverlay(OTHER_SESSION_ID);
    await nextTick();
    expect(wrapper.find(".term-search").exists()).toBe(false);
  });

  test("fresh typing anchors at the bottom via findPrevious (most-recent match first)", async () => {
    // Terminal scrollback puts newest output at the bottom; jumping the
    // viewport to the oldest match drags the user away from where they
    // were looking. findPrevious starts at the end of the buffer and walks
    // backward, so the first hit is the most recent occurrence.
    stubAddon.findPrevious.mockReturnValue(true);
    const wrapper = mount(TerminalSearchOverlay, {
      props: { sessionId: SESSION_ID },
      attachTo: document.body,
    });
    openOverlay();
    await nextTick();

    const input = wrapper.find<HTMLInputElement>(".term-search__input");
    input.element.value = "abc";
    await input.trigger("input");

    expect(stubAddon.findPrevious).toHaveBeenCalledTimes(1);
    expect(stubAddon.findPrevious.mock.calls[0][0]).toBe("abc");
    expect(stubAddon.findPrevious.mock.calls[0][1]).toMatchObject({
      caseSensitive: false,
      regex: false,
      wholeWord: false,
    });
    expect(stubAddon.findNext).not.toHaveBeenCalled();
  });

  test("extending the query by typing more chars uses findNext incremental (keep selection anchor)", async () => {
    stubAddon.findPrevious.mockReturnValue(true);
    stubAddon.findNext.mockReturnValue(true);
    const wrapper = mount(TerminalSearchOverlay, {
      props: { sessionId: SESSION_ID },
      attachTo: document.body,
    });
    openOverlay();
    await nextTick();

    const input = wrapper.find<HTMLInputElement>(".term-search__input");
    input.element.value = "ma";
    await input.trigger("input");
    // Initial search re-anchors via findPrevious.
    expect(stubAddon.findPrevious).toHaveBeenCalledTimes(1);
    expect(stubAddon.findNext).not.toHaveBeenCalled();

    // Extending: "ma" → "mas". Should use the addon's incremental fast
    // path so the current match expands instead of jumping elsewhere.
    input.element.value = "mas";
    await input.trigger("input");
    expect(stubAddon.findNext).toHaveBeenCalledTimes(1);
    expect(stubAddon.findNext.mock.calls[0][0]).toBe("mas");
    expect(stubAddon.findNext.mock.calls[0][1]).toMatchObject({ incremental: true });
  });

  test("shrinking / diverging the query re-anchors via findPrevious", async () => {
    stubAddon.findPrevious.mockReturnValue(true);
    stubAddon.findNext.mockReturnValue(true);
    const wrapper = mount(TerminalSearchOverlay, {
      props: { sessionId: SESSION_ID },
      attachTo: document.body,
    });
    openOverlay();
    await nextTick();

    const input = wrapper.find<HTMLInputElement>(".term-search__input");
    input.element.value = "master";
    await input.trigger("input");
    stubAddon.findPrevious.mockClear();
    stubAddon.findNext.mockClear();

    // Backspace several chars: "master" → "mas". Not an extension, so
    // we should re-anchor at the bottom rather than continue forward.
    input.element.value = "mas";
    await input.trigger("input");
    expect(stubAddon.findPrevious).toHaveBeenCalledTimes(1);
    expect(stubAddon.findNext).not.toHaveBeenCalled();

    // Diverging completely: "mas" → "xyz". Same — re-anchor.
    stubAddon.findPrevious.mockClear();
    input.element.value = "xyz";
    await input.trigger("input");
    expect(stubAddon.findPrevious).toHaveBeenCalledTimes(1);
    expect(stubAddon.findNext).not.toHaveBeenCalled();
  });

  test("Enter calls findNext, Shift+Enter calls findPrevious", async () => {
    stubAddon.findNext.mockReturnValue(true);
    stubAddon.findPrevious.mockReturnValue(true);
    const wrapper = mount(TerminalSearchOverlay, {
      props: { sessionId: SESSION_ID },
      attachTo: document.body,
    });
    openOverlay();
    await nextTick();

    const input = wrapper.find<HTMLInputElement>(".term-search__input");
    input.element.value = "foo";
    await input.trigger("input");
    stubAddon.findNext.mockClear();
    stubAddon.findPrevious.mockClear();

    await input.trigger("keydown", { key: "Enter" });
    expect(stubAddon.findNext).toHaveBeenCalledTimes(1);
    expect(stubAddon.findPrevious).not.toHaveBeenCalled();

    await input.trigger("keydown", { key: "Enter", shiftKey: true });
    expect(stubAddon.findPrevious).toHaveBeenCalledTimes(1);
  });

  test("Esc closes the overlay and clears decorations", async () => {
    stubAddon.findNext.mockReturnValue(true);
    const wrapper = mount(TerminalSearchOverlay, {
      props: { sessionId: SESSION_ID },
      attachTo: document.body,
    });
    openOverlay();
    await nextTick();

    const input = wrapper.find<HTMLInputElement>(".term-search__input");
    await input.trigger("keydown", { key: "Escape" });
    await nextTick();

    expect(wrapper.find(".term-search").exists()).toBe(false);
    expect(stubAddon.clearDecorations).toHaveBeenCalled();
    expect(focusActiveTerminalMock).toHaveBeenCalled();
  });

  test("shows 'No results' only when the search call returns false", async () => {
    // Fresh typing goes through findPrevious for the anchor-at-bottom flow.
    stubAddon.findPrevious.mockReturnValue(false);
    const wrapper = mount(TerminalSearchOverlay, {
      props: { sessionId: SESSION_ID },
      attachTo: document.body,
    });
    openOverlay();
    await nextTick();

    const input = wrapper.find<HTMLInputElement>(".term-search__input");
    input.element.value = "missing";
    await input.trigger("input");
    await nextTick();

    expect(wrapper.find(".term-search__count").text()).toBe("No results");
  });

  test("shows 'Match' (not 'No results') when the search returns true but addon reports count=0 (Claude Code redraw flake)", async () => {
    // Reproduces the original bug: SearchAddon's onDidChangeResults emits
    // resultCount=0 in between repaints when the buffer is being rewritten
    // continuously, even though the find call synchronously found a real
    // match. The fix is to trust the boolean over the event count.
    stubAddon.findPrevious.mockReturnValue(true);
    const wrapper = mount(TerminalSearchOverlay, {
      props: { sessionId: SESSION_ID },
      attachTo: document.body,
    });
    openOverlay();
    await nextTick();

    // Simulate the stale event firing first with count=0.
    const fire = lastResultsCallback();
    expect(fire).not.toBeNull();
    fire!({ resultIndex: -1, resultCount: 0 });

    const input = wrapper.find<HTMLInputElement>(".term-search__input");
    input.element.value = "master";
    await input.trigger("input");
    await nextTick();

    expect(wrapper.find(".term-search__count").text()).toBe("Match");
    expect(wrapper.find(".term-search__count").text()).not.toBe("No results");
  });

  test("shows 'X of Y' when the addon emits a positive count", async () => {
    stubAddon.findPrevious.mockReturnValue(true);
    const wrapper = mount(TerminalSearchOverlay, {
      props: { sessionId: SESSION_ID },
      attachTo: document.body,
    });
    openOverlay();
    await nextTick();

    const input = wrapper.find<HTMLInputElement>(".term-search__input");
    input.element.value = "foo";
    await input.trigger("input");

    const fire = lastResultsCallback();
    expect(fire).not.toBeNull();
    fire!({ resultIndex: 2, resultCount: 5 });
    await nextTick();

    expect(wrapper.find(".term-search__count").text()).toBe("3 of 5");
  });

  test("clears state and closes when the bound sessionId changes (pane reuse)", async () => {
    stubAddon.findNext.mockReturnValue(true);
    const wrapper = mount(TerminalSearchOverlay, {
      props: { sessionId: SESSION_ID },
      attachTo: document.body,
    });
    openOverlay();
    await nextTick();
    expect(wrapper.find(".term-search").exists()).toBe(true);

    // setProps's typing is too strict on script-setup components; cast to
    // accept the prop name the component does take.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (wrapper as any).setProps({ sessionId: OTHER_SESSION_ID });
    await nextTick();

    expect(wrapper.find(".term-search").exists()).toBe(false);
  });
});
