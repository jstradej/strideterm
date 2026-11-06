import type { Readable } from "node:stream";

export function waitForInitialCompile(
  _stream: Readable,
  _options: { timeoutMs: number; onText?: (_text: string) => void },
): Promise<void>;

export function startAfterInitialCompiles<T>(_readiness: Promise<unknown>[], _start: () => T | Promise<T>): Promise<T>;

export function startDevElectron<TChild, TElectron>(_options: {
  externalCompilers: boolean;
  startCompiler: (_name: string, _config: string) => { child: TChild; ready: Promise<unknown> };
  waitForRenderer: () => Promise<void>;
  startElectron: () => TElectron | Promise<TElectron>;
}): Promise<{ electron: TElectron; compilers: Array<{ child: TChild; ready: Promise<unknown> }> }>;

export function assertExternalCompilerOutputs(_paths: string[], _hasOutput?: (_outputPath: string) => boolean): void;
