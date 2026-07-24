import { describe, expect, it } from "vitest";
import type { ProcessMetric, SystemMemoryInfo } from "electron";
import { buildPerformanceSnapshot, createPerformanceSampler } from "./performance-metrics.js";

function metric(overrides: Partial<ProcessMetric> & { pid: number }): ProcessMetric {
  return {
    pid: overrides.pid,
    type: "type" in overrides ? overrides.type : "Tab",
    creationTime: overrides.creationTime ?? 1_000,
    cpu: { percentCPUUsage: 0, idleWakeupsPerSecond: 0, ...(overrides.cpu ?? {}) },
    memory: { workingSetSize: 0, peakWorkingSetSize: 0, ...(overrides.memory ?? {}) },
    name: overrides.name,
    serviceName: overrides.serviceName,
  } as ProcessMetric;
}

const sysMem: SystemMemoryInfo = {
  total: 16_000_000,
  free: 4_000_000,
} as SystemMemoryInfo;

describe("buildPerformanceSnapshot", () => {
  it("sums CPU and working set across all processes", () => {
    const snap = buildPerformanceSnapshot({
      metrics: [
        metric({
          pid: 1,
          type: "Browser",
          cpu: { percentCPUUsage: 10 } as ProcessMetric["cpu"],
          memory: { workingSetSize: 100 } as ProcessMetric["memory"],
        }),
        metric({
          pid: 2,
          type: "Tab",
          cpu: { percentCPUUsage: 25 } as ProcessMetric["cpu"],
          memory: { workingSetSize: 200 } as ProcessMetric["memory"],
        }),
        metric({
          pid: 3,
          type: "GPU",
          cpu: { percentCPUUsage: 5 } as ProcessMetric["cpu"],
          memory: { workingSetSize: 50 } as ProcessMetric["memory"],
        }),
      ],
      systemMemory: sysMem,
      currentRendererPid: null,
      sampledAt: 5,
      intervalMs: 2000,
      warmingUp: false,
    });
    expect(snap.totalCpuPercent).toBe(40);
    expect(snap.totalWorkingSetKb).toBe(350);
    expect(snap.systemMemory).toEqual({ totalKb: 16_000_000, freeKb: 4_000_000 });
  });

  it("flags the current renderer among multiple Tab processes and sorts by CPU", () => {
    const snap = buildPerformanceSnapshot({
      metrics: [
        metric({ pid: 10, type: "Tab", cpu: { percentCPUUsage: 3 } as ProcessMetric["cpu"] }),
        metric({ pid: 11, type: "Tab", cpu: { percentCPUUsage: 42 } as ProcessMetric["cpu"] }),
        metric({ pid: 12, type: "Tab", cpu: { percentCPUUsage: 8 } as ProcessMetric["cpu"] }),
      ],
      systemMemory: sysMem,
      currentRendererPid: 12,
      sampledAt: 0,
      intervalMs: 2000,
      warmingUp: false,
    });
    expect(snap.currentRendererPid).toBe(12);
    const current = snap.processes.find((p) => p.isCurrentRenderer);
    expect(current?.pid).toBe(12);
    expect(snap.processes.filter((p) => p.isCurrentRenderer)).toHaveLength(1);
    // Sorted by CPU desc.
    expect(snap.processes.map((p) => p.pid)).toEqual([11, 12, 10]);
  });

  it("leaves currentRendererPid null when the renderer pid is not present", () => {
    const snap = buildPerformanceSnapshot({
      metrics: [metric({ pid: 1, type: "Browser" })],
      systemMemory: sysMem,
      currentRendererPid: 999,
      sampledAt: 0,
      intervalMs: null,
      warmingUp: true,
    });
    expect(snap.currentRendererPid).toBeNull();
    expect(snap.processes[0].isCurrentRenderer).toBe(false);
  });

  it("handles missing privateBytes and preserves an unknown process type + creationTime", () => {
    const snap = buildPerformanceSnapshot({
      metrics: [
        metric({
          pid: 1,
          type: "Utility",
          creationTime: 4242,
          memory: { workingSetSize: 10 } as ProcessMetric["memory"],
        }),
        metric({
          pid: 2,
          type: undefined as unknown as ProcessMetric["type"],
          memory: { workingSetSize: 20, privateBytes: 15 } as ProcessMetric["memory"],
        }),
      ],
      systemMemory: sysMem,
      currentRendererPid: null,
      sampledAt: 0,
      intervalMs: 2000,
      warmingUp: false,
    });
    const byPid = Object.fromEntries(snap.processes.map((p) => [p.pid, p]));
    expect(byPid[1].privateBytesKb).toBeUndefined();
    expect(byPid[1].creationTime).toBe(4242);
    expect(byPid[2].type).toBe("Unknown");
    expect(byPid[2].privateBytesKb).toBe(15);
  });
});

describe("createPerformanceSampler", () => {
  it("marks the first sample as warming up with a null interval", () => {
    const t = 1000;
    const sampler = createPerformanceSampler({
      getAppMetrics: () => [metric({ pid: 1, cpu: { percentCPUUsage: 0 } as ProcessMetric["cpu"] })],
      getSystemMemoryInfo: () => sysMem,
      now: () => t,
      cacheMs: 750,
    });
    const first = sampler.sample(1);
    expect(first.warmingUp).toBe(true);
    expect(first.intervalMs).toBeNull();
  });

  it("reuses a single sample for multiple requests inside the cache window", () => {
    let t = 1000;
    let calls = 0;
    const sampler = createPerformanceSampler({
      getAppMetrics: () => {
        calls++;
        return [metric({ pid: calls, cpu: { percentCPUUsage: calls } as ProcessMetric["cpu"] })];
      },
      getSystemMemoryInfo: () => sysMem,
      now: () => t,
      cacheMs: 750,
    });
    sampler.sample(null); // t=1000 → fresh (call 1)
    t = 1200;
    const second = sampler.sample(null); // within 750ms → cached
    expect(calls).toBe(1);
    expect(second.processes[0].pid).toBe(1);
  });

  it("takes a fresh sample after the cache expires and links the interval to the previous sample", () => {
    let t = 1000;
    let calls = 0;
    const sampler = createPerformanceSampler({
      getAppMetrics: () => {
        calls++;
        return [metric({ pid: 1, cpu: { percentCPUUsage: 0 } as ProcessMetric["cpu"] })];
      },
      getSystemMemoryInfo: () => sysMem,
      now: () => t,
      cacheMs: 750,
    });
    sampler.sample(null); // t=1000, first sample
    t = 3000; // 2000ms later, cache expired
    const second = sampler.sample(null);
    expect(calls).toBe(2);
    expect(second.warmingUp).toBe(false);
    expect(second.intervalMs).toBe(2000);
  });

  it("applies the per-window current renderer to a shared cached sample", () => {
    let t = 1000;
    const sampler = createPerformanceSampler({
      getAppMetrics: () => [metric({ pid: 10, type: "Tab" }), metric({ pid: 11, type: "Tab" })],
      getSystemMemoryInfo: () => sysMem,
      now: () => t,
      cacheMs: 750,
    });
    const windowA = sampler.sample(10); // fresh
    t = 1100;
    const windowB = sampler.sample(11); // cached sample, different renderer
    expect(windowA.currentRendererPid).toBe(10);
    expect(windowB.currentRendererPid).toBe(11);
    expect(windowA.processes.find((p) => p.isCurrentRenderer)?.pid).toBe(10);
    expect(windowB.processes.find((p) => p.isCurrentRenderer)?.pid).toBe(11);
  });
});
