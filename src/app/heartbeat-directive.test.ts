import { describe, expect, test, beforeEach, afterEach, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { defineComponent, ref } from "vue";
import { vHeartbeat } from "./heartbeat-directive.js";
import {
  HEARTBEAT_ON_CLASS,
  HEARTBEAT_PERIOD_MS,
  heartbeatTargetCount,
  resetHeartbeatForTests,
} from "./status-heartbeat.js";

/**
 * The directive is the only lifecycle glue components use. It must register on
 * the way into an active state, dispose on the way out, and survive a value
 * flip without the element being remounted.
 */

let rafQueue: Map<number, FrameRequestCallback>;
let rafHandle: number;

function flushFrame(): void {
  const queued = [...rafQueue.values()];
  rafQueue.clear();
  for (const cb of queued) cb(0);
}

describe("v-heartbeat directive", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    rafQueue = new Map();
    rafHandle = 0;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      rafQueue.set(++rafHandle, cb);
      return rafHandle;
    });
    vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
      rafQueue.delete(handle);
    });
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.documentElement.classList.remove("app-hidden");
    resetHeartbeatForTests();
  });

  afterEach(() => {
    resetHeartbeatForTests();
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  test("inactive on mount does not register; flipping active registers the same element", async () => {
    const active = ref(false);
    const Comp = defineComponent({
      directives: { heartbeat: vHeartbeat },
      setup() {
        return { active };
      },
      template: `<span class="dot" v-heartbeat="active" />`,
    });

    const wrapper = mount(Comp, { attachTo: document.body });
    expect(heartbeatTargetCount()).toBe(0);

    const el = wrapper.get("span.dot").element;
    active.value = true;
    await wrapper.vm.$nextTick();
    expect(heartbeatTargetCount()).toBe(1);

    vi.advanceTimersByTime(HEARTBEAT_PERIOD_MS);
    flushFrame();
    expect(el.classList.contains(HEARTBEAT_ON_CLASS)).toBe(true);

    // Same element, no remount — going inactive must deregister and clean up.
    active.value = false;
    await wrapper.vm.$nextTick();
    expect(heartbeatTargetCount()).toBe(0);
    expect(el.classList.contains(HEARTBEAT_ON_CLASS)).toBe(false);
    expect(wrapper.get("span.dot").element).toBe(el);

    wrapper.unmount();
  });

  test("re-rendering with an unchanged active value does not register twice", async () => {
    const bump = ref(0);
    const Comp = defineComponent({
      directives: { heartbeat: vHeartbeat },
      setup() {
        return { bump };
      },
      template: `<span class="dot" v-heartbeat="true">{{ bump }}</span>`,
    });

    const wrapper = mount(Comp, { attachTo: document.body });
    expect(heartbeatTargetCount()).toBe(1);

    bump.value = 1;
    await wrapper.vm.$nextTick();
    bump.value = 2;
    await wrapper.vm.$nextTick();
    expect(heartbeatTargetCount()).toBe(1);

    wrapper.unmount();
  });

  test("unmount deregisters and leaves no pulse class behind", () => {
    const Comp = defineComponent({
      directives: { heartbeat: vHeartbeat },
      template: `<span class="dot" v-heartbeat="true" />`,
    });

    const wrapper = mount(Comp, { attachTo: document.body });
    const el = wrapper.get("span.dot").element;

    vi.advanceTimersByTime(HEARTBEAT_PERIOD_MS);
    flushFrame();
    expect(el.classList.contains(HEARTBEAT_ON_CLASS)).toBe(true);

    wrapper.unmount();
    expect(heartbeatTargetCount()).toBe(0);
    expect(el.classList.contains(HEARTBEAT_ON_CLASS)).toBe(false);
  });

  test("several bound elements share one registry", () => {
    const Comp = defineComponent({
      directives: { heartbeat: vHeartbeat },
      template: `
        <div>
          <span class="a" v-heartbeat="true" />
          <span class="b" v-heartbeat="true" />
          <span class="c" v-heartbeat="false" />
        </div>
      `,
    });

    const wrapper = mount(Comp, { attachTo: document.body });
    expect(heartbeatTargetCount()).toBe(2);

    vi.advanceTimersByTime(HEARTBEAT_PERIOD_MS);
    flushFrame();
    expect(wrapper.get("span.a").classes()).toContain(HEARTBEAT_ON_CLASS);
    expect(wrapper.get("span.b").classes()).toContain(HEARTBEAT_ON_CLASS);
    expect(wrapper.get("span.c").classes()).not.toContain(HEARTBEAT_ON_CLASS);

    wrapper.unmount();
  });
});
