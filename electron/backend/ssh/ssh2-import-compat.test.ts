import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

const productionModules = ["./runtime-ssh-handlers.ts", "./ssh-manager.ts", "./ssh-session.ts"];

describe("ssh2 ESM import compatibility", () => {
  test("production modules use the CommonJS-compatible default import", async () => {
    const sources = await Promise.all(
      productionModules.map((modulePath) => readFile(new URL(modulePath, import.meta.url), "utf8")),
    );

    for (const source of sources) {
      expect(source).not.toMatch(/import\s*\{[^}]+\}\s*from\s*["']ssh2["']/);
    }
  });

  test("Node ESM can read the installed ssh2 runtime exports through its default import", () => {
    const result = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "import ssh2 from 'ssh2'; if (typeof ssh2.utils?.parseKey !== 'function' || typeof ssh2.Client !== 'function') process.exit(1)",
      ],
      { cwd: process.cwd(), windowsHide: true, encoding: "utf8" },
    );
    expect(result).toBe("");
  });
});
