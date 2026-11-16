import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { bundleSandboxRuntime, collectClosure } from "./bundle-sandbox-runtime.mts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function pkg(dir: string, name: string, version: string, dependencies: Record<string, string> = {}, files = true) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version, license: "MIT", dependencies }));
  if (files) writeFileSync(path.join(dir, "LICENSE"), "licence");
}

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "sbx-closure-"));
  roots.push(root);
  const modules = path.join(root, "node_modules");
  pkg(path.join(modules, "@anthropic-ai", "sandbox-runtime"), "@anthropic-ai/sandbox-runtime", "1.0.0", {
    zod: "^3",
    plain: "^1",
  });
  pkg(path.join(modules, "zod"), "zod", "4.0.0");
  pkg(path.join(modules, "plain"), "plain", "1.2.3");
  pkg(path.join(modules, "app-only"), "app-only", "9.9.9");
  return { root, modules, runtime: path.join(modules, "@anthropic-ai", "sandbox-runtime") };
}

describe("collectClosure", () => {
  test("resolves each dependency from the depending package, so its nested version wins", () => {
    const { runtime } = fixture();
    pkg(path.join(runtime, "node_modules", "zod"), "zod", "3.25.0");
    const closure = collectClosure(path.resolve(runtime, "..", "..", ".."));
    expect(closure.map((member) => `${member.name}@${member.version}`).sort()).toEqual([
      "@anthropic-ai/sandbox-runtime@1.0.0",
      "plain@1.2.3",
      "zod@3.25.0",
    ]);
  });

  test("fails with both versions named when the flat tree could not hold them", () => {
    const { root, modules, runtime } = fixture();
    pkg(path.join(runtime, "node_modules", "zod"), "zod", "3.25.0");
    pkg(path.join(modules, "plain"), "plain", "1.2.3", { zod: "^4" });
    expect(() => collectClosure(root)).toThrow(/Two versions of zod are needed \(3\.25\.0 and 4\.0\.0\)/u);
  });

  test("fails for a dependency that is not installed", () => {
    const { root, modules } = fixture();
    rmSync(path.join(modules, "plain"), { recursive: true });
    expect(() => collectClosure(root)).toThrow(/plain .* is not installed/u);
  });
});

describe("bundleSandboxRuntime", () => {
  test("writes a flat tree without nested node_modules or unrelated packages, and the version", () => {
    const { root, runtime } = fixture();
    pkg(path.join(runtime, "node_modules", "zod"), "zod", "4.0.0");
    const out = path.join(root, "out");
    mkdirSync(out);
    writeFileSync(path.join(out, "stale"), "x");
    const rows = bundleSandboxRuntime(root, out);
    expect(existsSync(path.join(out, "stale"))).toBe(false);
    expect(existsSync(path.join(out, "node_modules", "@anthropic-ai", "sandbox-runtime", "package.json"))).toBe(true);
    expect(existsSync(path.join(out, "node_modules", "@anthropic-ai", "sandbox-runtime", "node_modules"))).toBe(false);
    expect(readFileSync(path.join(out, "node_modules", "zod", "package.json"), "utf8")).toContain("4.0.0");
    expect(existsSync(path.join(out, "node_modules", "app-only"))).toBe(false);
    expect(readFileSync(path.join(out, "VERSION"), "utf8")).toBe("1.0.0");
    expect(rows.every((row) => row.licenceFile && row.license === "MIT")).toBe(true);
  });
});
