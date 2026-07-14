export const SMOKE_READY_MARKER = "STRIDETERM_SMOKE_RENDERER_READY";

export function buildSmokeElectronArgs(dataDir: string): string[] {
  return [".", "--data-dir", dataDir];
}

export function isSuccessfulSmokeResult(code: number | null, stdout: string): boolean {
  return (
    code === 0 &&
    stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .includes(SMOKE_READY_MARKER)
  );
}
