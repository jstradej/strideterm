import { describe, expect, it } from "vitest";
import { SMOKE_READY_MARKER, buildSmokeElectronArgs, isSuccessfulSmokeResult } from "./smoke-protocol.js";

describe("smoke protocol", () => {
  it("launches Electron with an isolated data directory", () => {
    expect(buildSmokeElectronArgs("C:\\Temp\\strideterm-smoke-123")).toEqual([
      ".",
      "--data-dir",
      "C:\\Temp\\strideterm-smoke-123",
    ]);
  });

  it("requires the renderer-ready marker as well as a clean exit", () => {
    expect(isSuccessfulSmokeResult(0, "")).toBe(false);
    expect(isSuccessfulSmokeResult(0, `${SMOKE_READY_MARKER}\n`)).toBe(true);
    expect(isSuccessfulSmokeResult(1, `${SMOKE_READY_MARKER}\n`)).toBe(false);
  });

  it("does not accept the marker as part of an unrelated log line", () => {
    expect(isSuccessfulSmokeResult(0, `prefix-${SMOKE_READY_MARKER}-suffix\n`)).toBe(false);
  });
});
