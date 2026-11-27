import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inheritShellPath } from "../fix-path.js";
import { runJsonlCli } from "./cli-probe.js";

describe("JSONL CLI probe", () => {
  it("keeps stdin open between initialize and the usage response", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "usage-probe-"));
    try {
      const windows = process.platform === "win32";
      // A searchable directory named after the CLI must not shadow a later executable.
      const firstPathEntry = path.join(dir, "first");
      await mkdir(path.join(firstPathEntry, windows ? "claude.exe" : "claude"), { recursive: true });
      const entry = windows
        ? path.join(dir, "node_modules", "@anthropic-ai", "claude-code", "cli.js")
        : path.join(dir, "claude");
      await mkdir(path.dirname(entry), { recursive: true });
      if (windows) await writeFile(path.join(dir, "claude.cmd"), "exit /b 1");
      await writeFile(
        entry,
        [
          "#!/usr/bin/env node",
          "const lines = require('node:readline').createInterface({ input: process.stdin });",
          "lines.on('line', line => {",
          "  const { id } = JSON.parse(line);",
          "  process.stdout.write(JSON.stringify({ id, ready: id === 1, usage: 42 }) + '\\n');",
          "});",
        ].join("\n"),
        { mode: 0o755 },
      );
      const result = await runJsonlCli(
        "claude",
        [],
        { id: 1 },
        (message, send) => {
          const response = message as { id: number; usage: number };
          if (response.id === 1) {
            send({ id: 2 });
            return undefined;
          }
          return response.usage;
        },
        {
          timeoutMs: 5_000,
          env: { ...process.env, PATH: [firstPathEntry, dir, path.dirname(process.execPath)].join(path.delimiter) },
        },
      );
      expect(result).toBe(42);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects CLI lines larger than the bounded parser limit", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "usage-probe-large-"));
    try {
      const entry =
        process.platform === "win32"
          ? path.join(dir, "node_modules", "@anthropic-ai", "claude-code", "cli.js")
          : path.join(dir, "claude");
      await mkdir(path.dirname(entry), { recursive: true });
      if (process.platform === "win32") await writeFile(path.join(dir, "claude.cmd"), "exit /b 1");
      await writeFile(
        entry,
        [
          ...(process.platform === "win32" ? [] : ["#!/usr/bin/env node"]),
          "process.stdout.write(JSON.stringify({ ready: true }) + '\\n' + 'x'.repeat(300000));",
        ].join("\n"),
        { mode: 0o755 },
      );
      await expect(
        runJsonlCli("claude", [], { request: true }, () => undefined, {
          timeoutMs: 5_000,
          env: { ...process.env, PATH: [dir, path.dirname(process.execPath)].join(path.delimiter) },
        }),
      ).rejects.toThrow("oversized line");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")("discovers and runs POSIX CLIs after restoring a GUI PATH", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "usage probe "));
    const originalPath = process.env.PATH;
    const originalShell = process.env.SHELL;
    try {
      const binDir = path.join(dir, "user bin");
      await mkdir(binDir, { recursive: true });
      const loginShell = path.join(dir, "login-shell");
      await writeFile(
        loginShell,
        [
          "#!/bin/sh",
          `printf '%s%s%s' '__STRIDETERM_PATH_START__' '${binDir}:${path.dirname(process.execPath)}' '__STRIDETERM_PATH_END__'`,
        ].join("\n"),
        { mode: 0o755 },
      );
      process.env.SHELL = loginShell;
      process.env.PATH = "/usr/bin:/bin";
      await inheritShellPath({ attemptTimeoutsMs: [5_000] });

      for (const command of ["claude", "codex"] as const) {
        const entry = path.join(binDir, command);
        await writeFile(
          entry,
          [
            "#!/usr/bin/env node",
            "const lines = require('node:readline').createInterface({ input: process.stdin });",
            "lines.on('line', line => {",
            "  const { id } = JSON.parse(line);",
            "  process.stdout.write(JSON.stringify({ id, usage: 42 }) + '\\n');",
            "});",
          ].join("\n"),
          { mode: 0o755 },
        );

        const result = await runJsonlCli(command, [], { id: 1 }, (message) => (message as { usage: number }).usage, {
          timeoutMs: 5_000,
          env: process.env,
        });
        expect(result).toBe(42);
      }
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (originalShell === undefined) delete process.env.SHELL;
      else process.env.SHELL = originalShell;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
