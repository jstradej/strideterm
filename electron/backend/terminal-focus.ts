/**
 * Focus reporting (DECSET 1004) for a PTY that several viewers share — the
 * desktop windows and any number of remote clients.
 *
 * Each viewer's terminal emits its own `ESC[I` / `ESC[O`, and passing them
 * through means the app hears whichever viewer spoke last: a phone that merely
 * connects tells it focus was lost while the desktop is still on it. So, as
 * tmux does, a viewer's report is consumed as that viewer's flag, and the app
 * is told only when "some viewer has this terminal focused" changes.
 */

export const FOCUS_IN = "\x1b[I";
export const FOCUS_OUT = "\x1b[O";

export function focusReportOf(data: string): boolean | null {
  if (data === FOCUS_IN) return true;
  if (data === FOCUS_OUT) return false;
  return null;
}

export class TerminalFocusArbiter {
  /** sessionId → viewerKey → that viewer's last report. */
  private readonly reports = new Map<string, Map<string, boolean>>();
  /** sessionId → what the app was last told. Absent: told nothing yet. */
  private readonly told = new Map<string, boolean>();

  /** `wantsReports`: whether the session's app has focus reporting (1004) on right now. */
  constructor(private readonly wantsReports: (sessionId: string) => boolean) {}

  /**
   * Record one viewer's report. Returns the report to send the app, or null
   * when the combined state is what the app already has, or the app has not
   * asked for focus reports.
   */
  report(sessionId: string, viewerKey: string, focused: boolean): string | null {
    let viewers = this.reports.get(sessionId);
    if (!viewers) {
      viewers = new Map();
      this.reports.set(sessionId, viewers);
    }
    viewers.set(viewerKey, focused);
    return this.settle(sessionId);
  }

  isFocused(sessionId: string): boolean {
    for (const focused of this.reports.get(sessionId)?.values() ?? []) if (focused) return true;
    return false;
  }

  /** A viewer went away. Returns the reports its absence makes due, per session. */
  dropViewer(viewerKey: string): Array<{ sessionId: string; data: string }> {
    const due: Array<{ sessionId: string; data: string }> = [];
    for (const [sessionId, viewers] of this.reports) {
      if (!viewers.delete(viewerKey)) continue;
      const data = this.settle(sessionId);
      if (data) due.push({ sessionId, data });
    }
    return due;
  }

  /**
   * The app (re)enabled focus reporting: it holds no state we told it before,
   * so the next report goes through whatever it says.
   */
  forgetTold(sessionId: string): void {
    this.told.delete(sessionId);
  }

  /** The session's process is gone or restarted. */
  forgetSession(sessionId: string): void {
    this.reports.delete(sessionId);
    this.told.delete(sessionId);
  }

  forgetSessionsWithPrefix(prefix: string): void {
    for (const sessionId of [...this.reports.keys(), ...this.told.keys()]) {
      if (sessionId.startsWith(prefix)) this.forgetSession(sessionId);
    }
  }

  private settle(sessionId: string): string | null {
    if (!this.wantsReports(sessionId)) return null;
    const focused = this.isFocused(sessionId);
    if (this.told.get(sessionId) === focused) return null;
    this.told.set(sessionId, focused);
    return focused ? FOCUS_IN : FOCUS_OUT;
  }
}
