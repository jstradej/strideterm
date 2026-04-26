// Top-level Effect runtime lifecycle management.
// Import this in electron/main.ts and call shutdownEffect() on app quit.

import { runtime } from "./runtime.js";

export const shutdownEffect = async (): Promise<void> => {
  try {
    await runtime.dispose();
  } catch {
    // Best-effort — Electron is already shutting down.
  }
};
