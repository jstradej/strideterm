import { Effect } from "effect";
import type { IDisposable } from "node-pty";

export interface PtyOptions {
  name?: string;
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: Record<string, string | undefined>;
}

// Acquires a PTY session and releases it (kills the process) when the scope
// closes.  Import node-pty lazily to avoid loading it in renderer context.
export const acquirePtySession = (cmd: string, args: string[], opts: PtyOptions) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic require in ESM
      const pty = (globalThis as any).__nodePty ?? require("node-pty");
      return pty.spawn(cmd, args, opts) as IDisposable & {
        write: (data: string) => void;
        resize: (cols: number, rows: number) => void;
        onData: (handler: (data: string) => void) => IDisposable;
        onExit: (handler: (e: { exitCode: number; signal?: number }) => void) => IDisposable;
        pid: number;
        kill: (signal?: string) => void;
      };
    }),
    (handle) => Effect.sync(() => handle.kill()),
  );
