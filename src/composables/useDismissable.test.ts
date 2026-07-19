/**
 * useDismissable replaced hand-rolled "close on outside click" wiring that was
 * duplicated (with minor variations — mousedown vs. click vs. pointerdown,
 * capture:true, one vs. two container refs, an opener-selector to ignore, a
 * requestAnimationFrame-deferred attach) across CustomSelect.vue,
 * BranchSelectPopover.vue, NotificationCenter.vue, TabPickerDropdown.vue,
 * GitBranchTab.vue's split-button dropdown, GitCommitContextMenu.vue, and
 * AzurePipelineRunDialog.vue's branch picker. This file exercises the
 * composable directly through a synthetic host component.
 */
import { describe, expect, test, vi, afterEach } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import { defineComponent, h, nextTick, ref, shallowRef, type Ref } from "vue";
import { useDismissable, type UseDismissableOptions } from "./useDismissable.js";

let liveWrappers: VueWrapper[] = [];

afterEach(() => {
  liveWrappers.forEach((w) => w.unmount());
  liveWrappers = [];
  document.body.innerHTML = "";
});

function dispatchOn(target: EventTarget, type: string, init: MouseEventInit = {}) {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }));
}

function buildHarness(
  isOpen: Ref<boolean> | (() => boolean),
  containers: Ref<HTMLElement | null> | Ref<HTMLElement | null>[],
  options: UseDismissableOptions,
) {
  const Host = defineComponent({
    setup() {
      useDismissable(isOpen, containers, options);
      return () => h("div");
    },
  });
  const wrapper = mount(Host);
  liveWrappers.push(wrapper);
  return wrapper;
}

describe("useDismissable", () => {
  test("clicking outside the container dismisses; clicking inside does not", () => {
    const container = document.createElement("div");
    const outside = document.createElement("div");
    document.body.append(container, outside);
    const onDismiss = vi.fn();

    buildHarness(ref(true), shallowRef(container), { onDismiss });

    dispatchOn(container, "click");
    expect(onDismiss).not.toHaveBeenCalled();

    dispatchOn(outside, "click");
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  test("no dismiss fires while isOpen is false", () => {
    const outside = document.createElement("div");
    document.body.append(outside);
    const onDismiss = vi.fn();

    buildHarness(ref(false), shallowRef(null), { onDismiss });

    dispatchOn(outside, "click");
    expect(onDismiss).not.toHaveBeenCalled();
  });

  test("supports multiple containers (e.g. a root button plus a teleported list)", () => {
    const root = document.createElement("div");
    const list = document.createElement("div");
    const outside = document.createElement("div");
    document.body.append(root, list, outside);
    const onDismiss = vi.fn();

    buildHarness(ref(true), [shallowRef(root), shallowRef(list)], { onDismiss });

    dispatchOn(root, "click");
    dispatchOn(list, "click");
    expect(onDismiss).not.toHaveBeenCalled();

    dispatchOn(outside, "click");
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  test("respects a custom eventName and capture flag", () => {
    const outside = document.createElement("div");
    document.body.append(outside);
    const onDismiss = vi.fn();

    buildHarness(ref(true), shallowRef(null), { onDismiss, eventName: "mousedown", capture: true });

    dispatchOn(outside, "click");
    expect(onDismiss).not.toHaveBeenCalled();

    dispatchOn(outside, "mousedown");
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  test("ignoreSelector treats a matching target as inside, even outside every container", () => {
    const opener = document.createElement("button");
    opener.dataset.role = "opener";
    document.body.append(opener);
    const onDismiss = vi.fn();

    buildHarness(ref(true), shallowRef(null), { onDismiss, ignoreSelector: "[data-role='opener']" });

    dispatchOn(opener, "click");
    expect(onDismiss).not.toHaveBeenCalled();
  });

  test("toggling isOpen back on re-attaches the listener", async () => {
    const outside = document.createElement("div");
    document.body.append(outside);
    const onDismiss = vi.fn();
    const isOpen = ref(false);

    buildHarness(isOpen, shallowRef(null), { onDismiss });

    isOpen.value = true;
    await nextTick();
    dispatchOn(outside, "click");
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  test("unmounting detaches the listener", () => {
    const outside = document.createElement("div");
    document.body.append(outside);
    const onDismiss = vi.fn();

    const wrapper = buildHarness(ref(true), shallowRef(null), { onDismiss });
    wrapper.unmount();

    dispatchOn(outside, "click");
    expect(onDismiss).not.toHaveBeenCalled();
  });

  test("deferAttach delays attaching past the current microtask flush (avoids self-dismissing the opening click)", async () => {
    const container = document.createElement("div");
    const outside = document.createElement("div");
    document.body.append(container, outside);
    const onDismiss = vi.fn();
    const isOpen = ref(false);

    buildHarness(isOpen, shallowRef(container), { onDismiss, deferAttach: true });

    isOpen.value = true;
    await nextTick(); // the watcher fired and scheduled requestAnimationFrame(attach)

    // Not attached yet — the animation frame hasn't run, so this is a no-op.
    dispatchOn(outside, "click");
    expect(onDismiss).not.toHaveBeenCalled();

    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    dispatchOn(outside, "click");
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
