import { z } from "zod";

/**
 * Performance-diagnostics data contract shared across the IPC boundary.
 *
 * These schemas live next to the other shared IPC types (not in the headless
 * runtime) because process metrics are an Electron-adapter concern — the
 * headless backend has no knowledge of Electron child processes. The renderer
 * imports the schemas to validate the response it receives over the transport;
 * the main process produces snapshots via `electron/performance-metrics.ts`.
 *
 * All memory values are in kilobytes to match Electron's `app.getAppMetrics()`
 * (`MemoryInfo`) and `process.getSystemMemoryInfo()`. `privateBytes` is only
 * reported on Windows, so `privateBytesKb` is optional. CPU values are the
 * `percentCPUUsage` measured since the previous sample; the first sample after
 * the sampler starts has no prior baseline (`warmingUp: true`) and reports 0.
 */

export const performanceProcessSampleSchema = z.object({
  pid: z.number(),
  /** Electron process type: Browser, Tab, GPU, Utility, Zygote, … */
  type: z.string(),
  name: z.string().optional(),
  serviceName: z.string().optional(),
  /** ms since epoch; pair with pid to disambiguate reused PIDs. */
  creationTime: z.number(),
  cpuPercent: z.number(),
  workingSetKb: z.number(),
  /** Windows-only; absent on macOS/Linux. */
  privateBytesKb: z.number().optional(),
  isCurrentRenderer: z.boolean(),
});

export const performanceSnapshotSchema = z.object({
  sampledAt: z.number(),
  /** ms between this sample and the previous one; null on the first sample. */
  intervalMs: z.number().nullable(),
  /** True on the first sample — CPU percentages are not yet meaningful. */
  warmingUp: z.boolean(),
  currentRendererPid: z.number().nullable(),
  totalCpuPercent: z.number(),
  totalWorkingSetKb: z.number(),
  systemMemory: z.object({
    totalKb: z.number(),
    freeKb: z.number(),
  }),
  processes: z.array(performanceProcessSampleSchema),
});

/**
 * Result of a renderer CPU-profile capture. `ok:true` carries the on-disk
 * path of the written `.cpuprofile`; `ok:false` carries a human-readable
 * error (e.g. DevTools already attached in dev, or a capture already running).
 */
export const cpuProfileCaptureResultSchema = z.object({
  ok: z.boolean(),
  path: z.string().optional(),
  durationMs: z.number().optional(),
  error: z.string().optional(),
});

/** Result of revealing a captured profile in the OS file manager. */
export const revealResultSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
});

export type PerformanceProcessSample = z.infer<typeof performanceProcessSampleSchema>;
export type PerformanceSnapshot = z.infer<typeof performanceSnapshotSchema>;
export type CpuProfileCaptureResult = z.infer<typeof cpuProfileCaptureResultSchema>;
export type RevealResult = z.infer<typeof revealResultSchema>;
