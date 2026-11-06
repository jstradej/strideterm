import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { nextTick, ref } from "vue";
import { useDelayedFlag } from "./useDelayedFlag";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useDelayedFlag", () => {
  test("stays false for a source that ends before the delay", async () => {
    const source = ref(false);
    const flag = useDelayedFlag(source, { delayMs: 200, minVisibleMs: 300 });
    source.value = true;
    await nextTick();
    vi.advanceTimersByTime(150);
    expect(flag.value).toBe(false);
    source.value = false;
    await nextTick();
    vi.advanceTimersByTime(1000);
    expect(flag.value).toBe(false);
  });

  test("turns true after the delay and stays for the minimum visible time", async () => {
    const source = ref(false);
    const flag = useDelayedFlag(source, { delayMs: 200, minVisibleMs: 300 });
    source.value = true;
    await nextTick();
    vi.advanceTimersByTime(200);
    expect(flag.value).toBe(true);
    vi.advanceTimersByTime(50);
    source.value = false;
    await nextTick();
    expect(flag.value).toBe(true);
    vi.advanceTimersByTime(249);
    expect(flag.value).toBe(true);
    vi.advanceTimersByTime(1);
    expect(flag.value).toBe(false);
  });

  test("hides at once when the minimum time already passed", async () => {
    const source = ref(false);
    const flag = useDelayedFlag(source, { delayMs: 100, minVisibleMs: 300 });
    source.value = true;
    await nextTick();
    vi.advanceTimersByTime(100);
    vi.advanceTimersByTime(500);
    source.value = false;
    await nextTick();
    expect(flag.value).toBe(false);
  });

  test("a restart while still visible cancels the pending hide", async () => {
    const source = ref(false);
    const flag = useDelayedFlag(source, { delayMs: 100, minVisibleMs: 300 });
    source.value = true;
    await nextTick();
    vi.advanceTimersByTime(100);
    source.value = false;
    await nextTick();
    source.value = true;
    await nextTick();
    vi.advanceTimersByTime(1000);
    expect(flag.value).toBe(true);
  });
});
