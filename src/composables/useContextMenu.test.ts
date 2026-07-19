/**
 * useContextMenu replaced the "dismiss on outside click + companion Escape
 * listener, mounted and torn down together" boilerplate duplicated across
 * ContextMenu.vue (the app's shared tab context menu), SidebarPanel.vue's
 * workspace-actions menu, FileManagerPane.vue's file context menu,
 * GitChangesTab.vue's file/dir context menu, and GitBranchesTab.vue's commit
 * file context menu. Each caller keeps its own viewport-clamp watch (the
 * clamp math and state-mutation shape differ enough between call sites —
 * some overwrite their own menu-state ref, ContextMenu.vue keeps separate
 * display refs — that folding it in here risked a re-render loop); this
 * composable only owns the dismiss wiring.
 */
import { describe, expect, test, vi, afterEach } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import { defineComponent, h, ref } from "vue";
import { useContextMenu, type UseContextMenuOptions } from "./useContextMenu.js";

let liveWrappers: VueWrapper[] = [];

afterEach(() => {
  liveWrappers.forEach((w) => w.unmount());
  liveWrappers = [];
  document.body.innerHTML = "";
});

function dispatchOn(target: EventTarget, type: string, init: MouseEventInit = {}) {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }));
}

function dispatchKey(key: string) {
  document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

function buildHarness(options: UseContextMenuOptions) {
  const Host = defineComponent({
    setup() {
      useContextMenu(options);
      return () => h("div");
    },
  });
  const wrapper = mount(Host);
  liveWrappers.push(wrapper);
  return wrapper;
}

describe("useContextMenu", () => {
  test("clicking outside the menu closes it", () => {
    const menuEl = document.createElement("div");
    const outside = document.createElement("div");
    document.body.append(menuEl, outside);
    const onClose = vi.fn();

    buildHarness({ isOpen: ref(true), menuRef: ref(menuEl), onClose });

    dispatchOn(menuEl, "click");
    expect(onClose).not.toHaveBeenCalled();

    dispatchOn(outside, "click");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("pressing Escape closes the menu even without a click", () => {
    const onClose = vi.fn();

    buildHarness({ isOpen: ref(true), menuRef: ref(null), onClose });

    dispatchKey("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("other keys don't close the menu", () => {
    const onClose = vi.fn();

    buildHarness({ isOpen: ref(true), menuRef: ref(null), onClose });

    dispatchKey("Enter");
    expect(onClose).not.toHaveBeenCalled();
  });

  test("outside-click dismissal is gated by isOpen — no dismiss fires while closed", () => {
    const outside = document.createElement("div");
    document.body.append(outside);
    const onClose = vi.fn();

    buildHarness({ isOpen: ref(false), menuRef: ref(null), onClose });

    dispatchOn(outside, "click");
    expect(onClose).not.toHaveBeenCalled();
  });

  test("Escape isn't gated by isOpen — matches every original call site, which never checked it either (harmless no-op onClose when already closed)", () => {
    const onClose = vi.fn();

    buildHarness({ isOpen: ref(false), menuRef: ref(null), onClose });

    dispatchKey("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("ignoreSelector lets an opener element toggle isOpen without immediately closing it", () => {
    const opener = document.createElement("button");
    opener.dataset.role = "workspace-layout-chip";
    document.body.append(opener);
    const onClose = vi.fn();

    buildHarness({
      isOpen: ref(true),
      menuRef: ref(null),
      onClose,
      ignoreSelector: "[data-role='workspace-layout-chip']",
    });

    dispatchOn(opener, "click");
    expect(onClose).not.toHaveBeenCalled();
  });

  test("unmounting tears down both the click and Escape listeners", () => {
    const outside = document.createElement("div");
    document.body.append(outside);
    const onClose = vi.fn();

    const wrapper = buildHarness({ isOpen: ref(true), menuRef: ref(null), onClose });
    wrapper.unmount();

    dispatchOn(outside, "click");
    dispatchKey("Escape");
    expect(onClose).not.toHaveBeenCalled();
  });
});
