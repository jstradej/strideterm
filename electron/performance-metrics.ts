import type { ProcessMetric, SystemMemoryInfo } from "electron";
import type { PerformanceProcessSample, PerformanceSnapshot } from "./shared/performance.js";

/**
 * Performance-metrics sampler for the Electron adapter layer.
 *
 * The Electron adapter owns process metrics because the headless runtime has
 * no knowledge of Electron child processes. This module is deliberately split
 * into a *pure* normalization/aggregation function (`buildPerformanceSnapshot`)
 * and a small stateful *cache* (`createPerformanceSampler`) so the aggregation
 * logic is testable without any Electron API.
 *
 * The cache matters for multi-window: `app.getAppMetrics()` reports
 * `percentCPUUsage` relative to the *previous* call, so if two windows each
 * called it within a few milliseconds the second reading would be measured
 * over a meaningless sub-interval. Caching one raw sample for a short window
 * means near-simultaneous requests from several windows share the same sample
 * (and thus the same, meaningful, CPU interval). The per-window
 * "current renderer" marker is applied fresh on every request, so the shared
 * raw sample is still correct for each caller.
 *
 * There is no background sampler — a new sample is only taken when an open
 * panel asks for one and the cache has expired.
 */

/** Default cache window. Smaller than the fastest UI refresh (1s) so a single
 *  polling window always gets a fresh sample while bursts of near-simultaneous
 *  multi-window requests are coalesced onto one sample. */
export const DEFAULT_SAMPLE_CACHE_MS = 750;

interface RawSample {
  metrics: ProcessMetric[];
  systemMemory: SystemMemoryInfo;
  sampledAt: number;
  intervalMs: number | null;
  warmingUp: boolean;
}

/**
 * Pure aggregation: turn a raw Electron metrics snapshot into the immutable
 * wire shape. `currentRendererPid` is the OS pid of the renderer that made the
 * request (from `event.sender.getOSProcessId()`); the matching process is
 * flagged and surfaced as `currentRendererPid` in the result.
 */
export function buildPerformanceSnapshot(input: {
  metrics: ProcessMetric[];
  systemMemory: SystemMemoryInfo;
  currentRendererPid: number | null;
  sampledAt: number;
  intervalMs: number | null;
  warmingUp: boolean;
}): PerformanceSnapshot {
  const { metrics, systemMemory, currentRendererPid, sampledAt, intervalMs, warmingUp } = input;

  let totalCpuPercent = 0;
  let totalWorkingSetKb = 0;
  let matchedRenderer: number | null = null;

  const processes: PerformanceProcessSample[] = metrics.map((m) => {
    const cpuPercent = m.cpu?.percentCPUUsage ?? 0;
    const workingSetKb = m.memory?.workingSetSize ?? 0;
    const isCurrentRenderer = currentRendererPid != null && m.pid === currentRendererPid;
    if (isCurrentRenderer) {
      matchedRenderer = m.pid;
    }
    totalCpuPercent += cpuPercent;
    totalWorkingSetKb += workingSetKb;

    const sample: PerformanceProcessSample = {
      pid: m.pid,
      type: m.type ?? "Unknown",
      creationTime: m.creationTime ?? 0,
      cpuPercent,
      workingSetKb,
      isCurrentRenderer,
    };
    if (m.name) sample.name = m.name;
    if (m.serviceName) sample.serviceName = m.serviceName;
    if (typeof m.memory?.privateBytes === "number") sample.privateBytesKb = m.memory.privateBytes;
    return sample;
  });

  // Sort primarily by CPU (desc), then working set (desc) so the hottest
  // process is always at the top of the table.
  processes.sort((a, b) => b.cpuPercent - a.cpuPercent || b.workingSetKb - a.workingSetKb);

  return {
    sampledAt,
    intervalMs,
    warmingUp,
    currentRendererPid: matchedRenderer,
    totalCpuPercent,
    totalWorkingSetKb,
    systemMemory: {
      totalKb: systemMemory?.total ?? 0,
      freeKb: systemMemory?.free ?? 0,
    },
    processes,
  };
}

export interface PerformanceSamplerDeps {
  getAppMetrics: () => ProcessMetric[];
  getSystemMemoryInfo: () => SystemMemoryInfo;
  now: () => number;
  /** Override the cache window (mainly for tests). */
  cacheMs?: number;
}

export interface PerformanceSampler {
  sample: (currentRendererPid: number | null) => PerformanceSnapshot;
}

/**
 * Create the shared, cached sampler. A single instance is created in the main
 * process and reused across all windows.
 */
export function createPerformanceSampler(deps: PerformanceSamplerDeps): PerformanceSampler {
  const cacheMs = deps.cacheMs ?? DEFAULT_SAMPLE_CACHE_MS;
  let cached: RawSample | null = null;

  return {
    sample(currentRendererPid: number | null): PerformanceSnapshot {
      const now = deps.now();
      if (!cached || now - cached.sampledAt >= cacheMs) {
        const metrics = deps.getAppMetrics();
        const systemMemory = deps.getSystemMemoryInfo();
        cached = {
          metrics,
          systemMemory,
          sampledAt: now,
          intervalMs: cached ? now - cached.sampledAt : null,
          warmingUp: cached === null,
        };
      }
      return buildPerformanceSnapshot({
        metrics: cached.metrics,
        systemMemory: cached.systemMemory,
        currentRendererPid,
        sampledAt: cached.sampledAt,
        intervalMs: cached.intervalMs,
        warmingUp: cached.warmingUp,
      });
    },
  };
}
