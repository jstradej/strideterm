import type { StridetermAPI } from "../../electron/shared/ipc-bridge.js";

declare global {
  interface Window {
    strideterm: StridetermAPI;
  }
}

export type {};
