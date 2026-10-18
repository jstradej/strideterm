import { describe, expect, test, vi } from "vitest";

const { debugSpy } = vi.hoisted(() => ({ debugSpy: vi.fn() }));
vi.mock("./logger.js", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: debugSpy, error: vi.fn() }),
}));

import { execFileText, parseJsonLines, ProcessCommandError, spawnTextStreaming } from "./process-utils.js";

// Portable across Windows/macOS/Linux — spawn the same node binary running the
// tests, so no external command needs to exist on PATH.
const NODE = process.execPath;

describe("spawnTextStreaming", () => {
  test("streams stdout chunks via onData and resolves with the full buffers", async () => {
    const chunks: string[] = [];
    const result = await spawnTextStreaming(
      NODE,
      ["-e", "process.stdout.write('hello'); process.stderr.write('warn');"],
      { onData: (c) => chunks.push(c) },
    );

    expect(result.stdout).toContain("hello");
    expect(result.stderr).toContain("warn");
    // onData saw the output live (not just at the end).
    expect(chunks.join("")).toContain("hello");
    expect(chunks.join("")).toContain("warn");
  });

  test("rejects with stdout, stderr AND exitCode on a non-zero exit", async () => {
    await expect(
      spawnTextStreaming(NODE, [
        "-e",
        "process.stdout.write('out-part'); process.stderr.write('err-part'); process.exit(3);",
      ]),
    ).rejects.toMatchObject({
      _tag: "ProcessCommandError",
      stdout: expect.stringContaining("out-part"),
      stderr: expect.stringContaining("err-part"),
      exitCode: 3,
      message: expect.stringContaining("err-part"),
    });
  });

  test("rejects with an error when the binary cannot be spawned", async () => {
    await expect(spawnTextStreaming("definitely-not-a-real-binary-xyz", ["--version"])).rejects.toMatchObject({
      _tag: "ProcessCommandError",
      exitCode: null,
      code: "ENOENT",
      cause: expect.objectContaining({ code: expect.any(String) }),
    });
  });

  test("execFileText rejects with the tagged error and captured output", async () => {
    await expect(execFileText(NODE, ["-e", "process.stderr.write('failed'); process.exit(7);"])).rejects.toMatchObject({
      _tag: "ProcessCommandError",
      stderr: "failed",
      exitCode: 7,
      code: 7,
      message: expect.stringContaining("failed"),
      cause: expect.any(Error),
    });
  });

  test("exports a real Error subtype", () => {
    expect(new ProcessCommandError("failure", "", "", null, null, new Error("cause"))).toBeInstanceOf(Error);
  });
});

describe("parseJsonLines", () => {
  test("parses every line when all are valid JSON (regression guard)", () => {
    const input = ['{"a":1}', '{"b":2}', '{"c":3}'].join("\n");
    expect(parseJsonLines(input)).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
    expect(debugSpy).not.toHaveBeenCalled();
  });

  test("skips a non-JSON line mixed among good ones instead of throwing", () => {
    debugSpy.mockClear();
    const input = ['{"a":1}', "Warning: something printed by a CLI tool", '{"c":3}'].join("\n");

    const result = parseJsonLines(input);

    expect(result).toEqual([{ a: 1 }, { c: 3 }]);
    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining("skipped 1"),
      expect.objectContaining({ skipped: 1 }),
    );
  });

  test("ignores blank lines without counting them as skipped", () => {
    debugSpy.mockClear();
    const input = ['{"a":1}', "", "   ", '{"b":2}'].join("\n");

    const result = parseJsonLines(input);

    expect(result).toEqual([{ a: 1 }, { b: 2 }]);
    expect(debugSpy).not.toHaveBeenCalled();
  });
});
