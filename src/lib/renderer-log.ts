// Structured renderer logging that lands in the main-process log file
// (strideterm.log, tagged `[renderer]`) via the preload `log:renderer` bridge.
// Lets renderer-only flows — git actions, dialogs, activation — be analysed
// from the dev log without attaching DevTools. No-ops on transports without the
// Electron preload (remote/web client), so callers can log unconditionally.
//
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyWin = any;

export function rlog(level: "debug" | "info" | "warn" | "error", msg: string, meta?: Record<string, unknown>): void {
  try {
    (window as AnyWin)?.strideterm?.logRenderer?.(level, msg, meta || {});
  } catch {
    // Logging must never break the caller (IPC torn down, preload gone, etc.).
  }
}
