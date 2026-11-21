import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import TabNoteMarker from "./TabNoteMarker.vue";

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("TabNoteMarker", () => {
  it("shows the note as a post-it after a short hover, and hides it on leave", async () => {
    vi.useFakeTimers();
    const wrapper = mount(TabNoteMarker, { props: { notes: "first line\nsecond line" }, attachTo: document.body });
    const marker = wrapper.get(".tab__notes");
    expect(marker.attributes("title")).toBe("");
    expect(marker.attributes("aria-label")).toBe("Tab note: first line\nsecond line");
    await marker.trigger("mouseenter");
    expect(document.querySelector(".tab-note-postit")).toBeNull();
    await vi.advanceTimersByTimeAsync(300);
    expect(document.querySelector(".tab-note-postit")?.textContent).toBe("first line\nsecond line");
    await marker.trigger("mouseleave");
    expect(document.querySelector(".tab-note-postit")).toBeNull();
    wrapper.unmount();
  });

  it("asks to edit the note on a click, without the click reaching the tab", async () => {
    const tabClick = vi.fn();
    const wrapper = mount(
      {
        components: { TabNoteMarker },
        template: '<button @click="tabClick"><TabNoteMarker notes="note" @edit="edit" /></button>',
        setup: () => ({ tabClick, edit: vi.fn() }),
      },
      { attachTo: document.body },
    );
    await wrapper.get(".tab__notes").trigger("click");
    expect(wrapper.findComponent(TabNoteMarker).emitted("edit")).toHaveLength(1);
    expect(tabClick).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("does not show the post-it when the pointer leaves before the delay", async () => {
    vi.useFakeTimers();
    const wrapper = mount(TabNoteMarker, { props: { notes: "note" }, attachTo: document.body });
    await wrapper.get(".tab__notes").trigger("mouseenter");
    await wrapper.get(".tab__notes").trigger("mouseleave");
    await vi.advanceTimersByTimeAsync(300);
    expect(document.querySelector(".tab-note-postit")).toBeNull();
    wrapper.unmount();
  });
});
