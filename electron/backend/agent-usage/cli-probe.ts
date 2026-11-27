import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { UsageUnavailable } from "./unavailable.js";

const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_LINE = 256 * 1024;
const MAX_TOTAL = 1024 * 1024;

type UsageCli = "codex" | "claude";
interface JsonlCliOptions {
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

interface Launch {
  file: string;
  prefixArgs: string[];
}

async function executable(file: string): Promise<boolean> {
  try {
    await access(file, constants.X_OK);
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

// npm puts a .cmd launcher on the Windows PATH. Resolve its installed binary or
// JS entry directly so quoting, pipe lifetimes and cleanup do not depend on cmd.exe.
export async function resolveUsageCli(
  command: UsageCli,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): Promise<Launch> {
  const dirs = (env.PATH || "").split(path.delimiter).filter((dir) => path.isAbsolute(dir));
  const windows = platform === "win32";
  for (const dir of dirs) {
    const file = path.join(dir, windows ? command + ".exe" : command);
    if (await executable(file)) return { file, prefixArgs: [] };
    if (!windows || !(await executable(path.join(dir, command + ".cmd")))) continue;

    const modules = path.join(dir, "node_modules");
    const pkg =
      command === "claude"
        ? path.join(modules, "@anthropic-ai", "claude-code")
        : path.join(modules, "@openai", "codex");
    if (command === "claude") {
      const native = path.join(pkg, "bin", "claude.exe");
      if (await executable(native)) return { file: native, prefixArgs: [] };
    } else {
      const triple = process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
      for (const parent of [path.join(pkg, "node_modules"), modules]) {
        const vendor = path.join(parent, "@openai", `codex-win32-${process.arch}`, "vendor", triple);
        for (const subdir of ["bin", "codex"]) {
          const native = path.join(vendor, subdir, "codex.exe");
          if (await executable(native)) return { file: native, prefixArgs: [] };
        }
      }
    }
    const script = command === "claude" ? path.join(pkg, "cli.js") : path.join(pkg, "bin", "codex.js");
    if (await executable(script)) {
      for (const nodeDir of dirs) {
        const file = path.join(nodeDir, "node.exe");
        if (await executable(file)) return { file, prefixArgs: [script] };
      }
    }
  }
  throw new Error(`${command} CLI executable was not found`);
}

/** Run a newline-delimited JSON CLI protocol without invoking a model conversation. */
export async function runJsonlCli<T>(
  command: UsageCli,
  args: string[],
  initial: Record<string, unknown>,
  onMessage: (_message: unknown, _send: (_value: Record<string, unknown>) => void) => T | undefined,
  options: JsonlCliOptions = {},
): Promise<T> {
  const env = options.env || process.env;
  const launch = await resolveUsageCli(command, process.platform, env);
  const file = launch.file;
  return new Promise<T>((resolve, reject) => {
    let child;
    try {
      child = spawn(file, [...launch.prefixArgs, ...args], {
        windowsHide: true,
        cwd: os.homedir(),
        env,
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch {
      reject(new Error(`${command} CLI could not start`));
      return;
    }

    let buffer = "";
    let total = 0;
    let settled = false;
    const timer = setTimeout(
      () => finish(new Error(`${command} CLI request timed out`)),
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    const finish = (error?: Error, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin?.end();
      if (!child.killed) child.kill();
      if (error) reject(error);
      else resolve(value as T);
    };
    const send = (value: Record<string, unknown>) => {
      if (settled) return;
      child.stdin?.write(`${JSON.stringify(value)}\n`);
    };
    child.on("error", () => finish(new Error(`${command} CLI could not start`)));
    child.stdin?.on("error", () => finish(new Error(`${command} CLI input could not be written`)));
    child.on("close", () => finish(new Error(`${command} CLI closed before returning usage`)));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (settled) return;
      total += Buffer.byteLength(chunk);
      if (total > MAX_TOTAL) return finish(new Error(`${command} CLI response exceeded the size limit`));
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_LINE && !buffer.includes("\n"))
        return finish(new Error(`${command} CLI returned an oversized line`));
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        if (Buffer.byteLength(line) > MAX_LINE) return finish(new Error(`${command} CLI returned an oversized line`));
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        try {
          const value = onMessage(message, send);
          if (value !== undefined) return finish(undefined, value);
        } catch (error) {
          if (error instanceof UsageUnavailable) return finish(error);
          return finish(new Error(`${command} CLI returned an invalid usage response`));
        }
      }
      // If this chunk ended with a partial line after one or more valid lines,
      // the pre-loop check above may have seen a newline and skipped the cap.
      if (Buffer.byteLength(buffer) > MAX_LINE) return finish(new Error(`${command} CLI returned an oversized line`));
    });
    send(initial);
  });
}
