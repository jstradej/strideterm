// The data-directory/environment binding (plan §3.3): a data directory is for ONE environment, and a
// later declaration of a different one is refused rather than silently adopted.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { bindDataDirToEnvironment } from "./data-dir-environment.js";

let stateDir = "";

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "strideterm-env-binding-"));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

describe("binding a data directory to an environment", () => {
  test("a fresh directory binds to whatever is declared first", () => {
    const result = bindDataDirToEnvironment(stateDir, "local");
    expect(result).toEqual({ bound: "local" });
    const stored = JSON.parse(readFileSync(join(stateDir, "mobile-environment.json"), "utf8"));
    expect(stored).toEqual({ environment: "local" });
  });

  test("re-declaring the SAME environment is a no-op, not a fresh binding", () => {
    bindDataDirToEnvironment(stateDir, "dev");
    const second = bindDataDirToEnvironment(stateDir, "dev");
    expect(second).toEqual({ bound: "dev" });
  });

  test("re-declaring a DIFFERENT environment is a mismatch, and the binding does not move", () => {
    bindDataDirToEnvironment(stateDir, "local");
    const mismatch = bindDataDirToEnvironment(stateDir, "dev");
    expect(mismatch).toEqual({ bound: "local", mismatch: { boundTo: "local" } });

    // NEVER HEALED. A third call with the original declaration finds the binding untouched, and one
    // more with the mismatched declaration reports the same mismatch again — the file was not
    // silently overwritten by either intervening call.
    expect(bindDataDirToEnvironment(stateDir, "local")).toEqual({ bound: "local" });
    expect(bindDataDirToEnvironment(stateDir, "dev")).toEqual({ bound: "local", mismatch: { boundTo: "local" } });
  });

  test("every ordered pair of the four environments is caught, not just local/dev", () => {
    const environments = ["local", "dev", "qa", "prod"] as const;
    for (const first of environments) {
      for (const second of environments) {
        if (first === second) continue;
        const dir = mkdtempSync(join(tmpdir(), "strideterm-env-binding-pair-"));
        try {
          bindDataDirToEnvironment(dir, first);
          const result = bindDataDirToEnvironment(dir, second);
          expect(result, `${first} -> ${second}`).toEqual({ bound: first, mismatch: { boundTo: first } });
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  });

  test("an unreadable or foreign-shaped binding file is treated as unbound, not a crash", () => {
    writeFileSync(join(stateDir, "mobile-environment.json"), "{ not json");
    expect(bindDataDirToEnvironment(stateDir, "qa")).toEqual({ bound: "qa" });
  });
});
