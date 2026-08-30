/**
 * V3 review, §2 — the lock signal itself: when it engages, when it releases,
 * and the grace interval that keeps a mid-gesture pointer slip from unlocking.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { defineComponent, h, ref, type Ref } from "vue";
import { mount } from "@vue/test-utils";
import { SIDEBAR_UNLOCK_GRACE_MS, useSidebarInteractionLock } from "./useSidebarInteractionLock.js";

/**
 * A minimal host: one div bound to the lock's four handlers, exactly the way
 * SidebarPanel binds them.
 */
function mountLock(drawerOpen: Ref<boolean> = ref(false)) {
  const element = ref<HTMLElement | null>(null);
  let lock!: ReturnType<typeof useSidebarInteractionLock>;
  const Host = defineComponent({
    setup() {
      lock = useSidebarInteractionLock({ element, drawerOpen });
      return () =>
        h(
          "div",
          {
            ref: (el) => {
              element.value = el as HTMLElement | null;
            },
            "data-role": "list",
            onPointerenter: lock.onPointerEnter,
            onPointerleave: lock.onPointerLeave,
            onFocusin: lock.onFocusIn,
            onFocusout: lock.onFocusOut,
          },
          [h("button", { "data-role": "row" }, "row")],
        );
    },
  });
  const wrapper = mount(Host, { attachTo: document.body });
  return { wrapper, lock: () => lock, element };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("useSidebarInteractionLock", () => {
  it("starts unlocked", () => {
    const { lock } = mountLock();
    expect(lock().locked.value).toBe(false);
  });

  it("locks on pointerenter and releases only after the grace interval", async () => {
    vi.useFakeTimers();
    const { wrapper, lock } = mountLock();

    await wrapper.get('[data-role="list"]').trigger("pointerenter");
    expect(lock().locked.value).toBe(true);

    await wrapper.get('[data-role="list"]').trigger("pointerleave");
    // Still locked: the grace is what makes a slip off a row harmless.
    expect(lock().locked.value).toBe(true);

    await vi.advanceTimersByTimeAsync(SIDEBAR_UNLOCK_GRACE_MS - 1);
    expect(lock().locked.value).toBe(true);

    await vi.advanceTimersByTimeAsync(1);
    expect(lock().locked.value).toBe(false);
  });

  it("a pointer returning during the grace cancels the release", async () => {
    vi.useFakeTimers();
    const { wrapper, lock } = mountLock();
    const list = wrapper.get('[data-role="list"]');

    await list.trigger("pointerenter");
    await list.trigger("pointerleave");
    await vi.advanceTimersByTimeAsync(SIDEBAR_UNLOCK_GRACE_MS / 2);
    await list.trigger("pointerenter");
    await vi.advanceTimersByTimeAsync(SIDEBAR_UNLOCK_GRACE_MS * 2);

    expect(lock().locked.value).toBe(true);
  });

  it("locks on focus inside, and a focus move between two rows does not release it", async () => {
    const { wrapper, lock } = mountLock();
    const list = wrapper.get('[data-role="list"]');
    const row = wrapper.get('[data-role="row"]');

    await list.trigger("focusin");
    expect(lock().locked.value).toBe(true);

    await list.trigger("focusout", { relatedTarget: row.element });
    expect(lock().locked.value).toBe(true);
  });

  it("a focus that genuinely leaves the list starts the grace", async () => {
    vi.useFakeTimers();
    const { wrapper, lock } = mountLock();
    const outside = document.createElement("button");
    document.body.appendChild(outside);

    await wrapper.get('[data-role="list"]').trigger("focusin");
    await wrapper.get('[data-role="list"]').trigger("focusout", { relatedTarget: outside });
    expect(lock().locked.value).toBe(true);

    await vi.advanceTimersByTimeAsync(SIDEBAR_UNLOCK_GRACE_MS);
    expect(lock().locked.value).toBe(false);

    outside.remove();
  });

  it("a focusout with no relatedTarget at all is treated as leaving", async () => {
    vi.useFakeTimers();
    const { wrapper, lock } = mountLock();

    await wrapper.get('[data-role="list"]').trigger("focusin");
    await wrapper.get('[data-role="list"]').trigger("focusout");
    await vi.advanceTimersByTimeAsync(SIDEBAR_UNLOCK_GRACE_MS);

    expect(lock().locked.value).toBe(false);
  });

  it("an open drawer locks with no pointer and releases the instant it closes", async () => {
    vi.useFakeTimers();
    const drawerOpen = ref(true);
    const { lock } = mountLock(drawerOpen);
    expect(lock().locked.value).toBe(true);

    // No grace for the drawer: it is an explicit close, and the pending state
    // is meant to land right after it.
    drawerOpen.value = false;
    expect(lock().locked.value).toBe(false);
  });

  it("keeps the lock while the drawer is open even after the pointer leaves", async () => {
    vi.useFakeTimers();
    const drawerOpen = ref(true);
    const { wrapper, lock } = mountLock(drawerOpen);

    await wrapper.get('[data-role="list"]').trigger("pointerenter");
    await wrapper.get('[data-role="list"]').trigger("pointerleave");
    await vi.advanceTimersByTimeAsync(SIDEBAR_UNLOCK_GRACE_MS * 2);

    expect(lock().locked.value).toBe(true);
  });

  it("releases when the list element goes away", async () => {
    const element = ref<HTMLElement | null>(document.createElement("div"));
    const drawerOpen = ref(false);
    let lock!: ReturnType<typeof useSidebarInteractionLock>;
    const Host = defineComponent({
      setup() {
        lock = useSidebarInteractionLock({ element, drawerOpen });
        return () => h("div");
      },
    });
    const wrapper = mount(Host);

    lock.onPointerEnter();
    expect(lock.locked.value).toBe(true);

    element.value = null;
    await wrapper.vm.$nextTick();
    expect(lock.locked.value).toBe(false);
  });

  it("uses a grace inside the 400–600 ms window the plan specifies", () => {
    expect(SIDEBAR_UNLOCK_GRACE_MS).toBeGreaterThanOrEqual(400);
    expect(SIDEBAR_UNLOCK_GRACE_MS).toBeLessThanOrEqual(600);
  });
});
