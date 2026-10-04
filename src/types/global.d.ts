import type { StridetermAPI } from "../../electron/shared/ipc-bridge.js";

declare global {
  interface Window {
    strideterm: StridetermAPI;
    StridetermHost?: { postMessage?: (..._args: [string]) => void };
    StridetermViewport?: { postMessage?: (message: string) => void };
    __stridetermViewport?: {
      update: (payload: { width: number; height: number; bottom: number; controlsSide?: "left" | "right" }) => void;
    };
  }
}

export type {};
