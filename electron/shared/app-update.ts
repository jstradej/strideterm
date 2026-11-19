export type AppUpdateStatus =
  | { phase: "unsupported" | "idle" | "checking" | "current" }
  | { phase: "downloading"; version: string; percent: number }
  | { phase: "ready" | "restarting"; version: string }
  | { phase: "failed"; message: string; retryable: boolean };

export const APP_UPDATE_RELEASES_URL = "https://github.com/jstradej/strideterm/releases/latest";
