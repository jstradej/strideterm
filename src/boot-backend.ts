import type { WindowBackend } from "../electron/shared/peers.js";
import { rlog } from "./lib/renderer-log.js";

function isPeerBackend(value: unknown): value is Extract<WindowBackend, { kind: "peer" }> {
  const backend = value as Record<string, unknown> | null;
  return (
    backend?.kind === "peer" &&
    typeof backend.hostId === "string" &&
    typeof backend.hostLabel === "string" &&
    typeof backend.remoteProfileId === "string" &&
    typeof backend.clientId === "string"
  );
}

/**
 * Which backend this window's data comes from. A local window must never fail to start because of this
 * question: a missing preload method (web client, older preload) or a failed call means "local".
 */
export async function resolveWindowBackend(): Promise<WindowBackend> {
  const preload = (window as unknown as { strideterm?: { getWindowBackend?: () => Promise<unknown> } }).strideterm;
  if (typeof preload?.getWindowBackend !== "function") return { kind: "local" };
  try {
    const backend = await preload.getWindowBackend();
    if (isPeerBackend(backend)) return backend;
    if ((backend as { kind?: unknown } | null)?.kind === "local") return { kind: "local" };
    rlog("warn", "[boot] unrecognised window backend; continuing as a local window", { backend });
  } catch (err) {
    rlog("warn", "[boot] could not read the window backend; continuing as a local window", {
      error: (err as Error)?.message,
    });
  }
  return { kind: "local" };
}
