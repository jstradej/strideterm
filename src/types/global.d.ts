import type { StridetermAPI } from "../../electron/shared/ipc-bridge.js";

declare global {
  interface Window {
    strideterm: StridetermAPI;
    StridetermViewport?: { postMessage?: (message: "ready") => void };
    __stridetermViewport?: {
      update: (payload: { width: number; height: number; bottom: number; controlsSide?: "left" | "right" }) => void;
    };
  }
}

export type {};
