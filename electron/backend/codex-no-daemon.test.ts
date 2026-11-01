import { describe, expect, test, vi } from "vitest";
import { createCodexVersionProbe, insertCodexNoDaemon, shouldAddCodexNoDaemon } from "./codex-no-daemon.js";

describe("insertCodexNoDaemon", () => {
  test.each([
    ["codex", "codex --no-daemon"],
    ["codex --yolo", "codex --no-daemon --yolo"],
    ['"C:\\Program Files\\x\\codex.cmd" --yolo', '"C:\\Program Files\\x\\codex.cmd" --no-daemon --yolo'],
    ["'/opt/my tools/codex' resume --last", "'/opt/my tools/codex' --no-daemon resume --last"],
    ["codex -- fix it", "codex --no-daemon -- fix it"],
    ["  codex  -m  o3", "  codex --no-daemon  -m  o3"],
  ])("%s", (input, expected) => {
    expect(insertCodexNoDaemon(input)).toBe(expected);
  });
});

describe("shouldAddCodexNoDaemon", () => {
  test.each([
    [[], true],
    [["--yolo"], true],
    [["resume", "--last"], true],
    [["fork"], true],
    [["fix the bug"], true],
    [["exec", "hi"], false],
    [["review"], false],
    [["agents"], false],
    [["app-server"], false],
    [["--no-daemon"], false],
    [["resume", "--no-daemon"], false],
    [["--remote"], false],
    [["--remote=ws://host:1"], false],
  ])("args %j -> %s", (args, expected) => {
    expect(shouldAddCodexNoDaemon(args, null)).toBe(expected);
  });

  test.each([
    ["0.156.9", false],
    ["0.99.12", false],
    ["0.157.0", true],
    ["0.166.0", true],
    ["1.0.0", true],
    [null, true],
  ])("version %s -> %s", (version, expected) => {
    expect(shouldAddCodexNoDaemon([], version)).toBe(expected);
  });
});

describe("createCodexVersionProbe", () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  test("returns null first, parses the version and caches it with one call", async () => {
    const exec = vi.fn(async () => ({ stdout: "codex-cli 0.166.0\n", stderr: "" }));
    const probe = createCodexVersionProbe({ exec, platform: "linux" });
    expect(probe.get("codex")).toBeNull();
    expect(probe.get("codex")).toBeNull();
    await flush();
    expect(probe.get("codex")).toBe("0.166.0");
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith("codex", ["--version"], { timeout: 5000 });
  });

  test("caches per executable", async () => {
    const exec = vi.fn(async (file: string) => ({ stdout: file === "a" ? "0.1.0" : "0.2.0", stderr: "" }));
    const probe = createCodexVersionProbe({ exec, platform: "linux" });
    probe.get("a");
    probe.get("b");
    await flush();
    expect([probe.get("a"), probe.get("b")]).toEqual(["0.1.0", "0.2.0"]);
  });

  test("a failure stays unknown without retrying", async () => {
    const exec = vi.fn(async () => {
      throw new Error("spawn codex ENOENT");
    });
    const probe = createCodexVersionProbe({ exec, platform: "linux" });
    probe.get("codex");
    await flush();
    expect(probe.get("codex")).toBeNull();
    expect(exec).toHaveBeenCalledTimes(1);
  });

  test("unparseable output stays unknown", async () => {
    const probe = createCodexVersionProbe({ exec: async () => ({ stdout: "hello", stderr: "" }), platform: "linux" });
    probe.get("codex");
    await flush();
    expect(probe.get("codex")).toBeNull();
  });

  test("on Windows runs through a shell and quotes a path with spaces", async () => {
    const exec = vi.fn(async () => ({ stdout: "0.166.0", stderr: "" }));
    createCodexVersionProbe({ exec, platform: "win32" }).get("C:\\Program Files\\codex.cmd");
    await flush();
    expect(exec).toHaveBeenCalledWith('"C:\\Program Files\\codex.cmd" --version', [], {
      timeout: 5000,
      shell: true,
    });
  });
});
