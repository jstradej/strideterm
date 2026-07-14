/// <reference types="node" />
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import electronPath from "electron";
import { APP_CONFIG } from "../config/app-config.js";
import { buildSmokeElectronArgs, isSuccessfulSmokeResult } from "../electron/shared/smoke-protocol.js";

type ExitResult = { kind: "exit"; code: number | null } | { kind: "error"; error: Error } | { kind: "timeout" };

async function run(): Promise<number> {
  const smokeDataDir = await mkdtemp(path.join(os.tmpdir(), "strideterm-smoke-"));
  let stdout = "";
  let stderr = "";

  const child = spawn(electronPath as unknown as string, buildSmokeElectronArgs(smokeDataDir), {
    cwd: process.cwd(),
    env: {
      ...process.env,
      STRIDETERM_SMOKE_TEST: "1",
      STRIDETERM_FORCE_DIST: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const exitResult = new Promise<ExitResult>((resolve) => {
    child.once("error", (error) => resolve({ kind: "error", error }));
    child.once("exit", (code) => resolve({ kind: "exit", code }));
  });
  let timeout: NodeJS.Timeout | undefined;
  const timeoutResult = new Promise<ExitResult>((resolve) => {
    timeout = setTimeout(() => resolve({ kind: "timeout" }), APP_CONFIG.electron.smokeAliveMs);
  });

  try {
    const result = await Promise.race([exitResult, timeoutResult]);
    if (timeout) clearTimeout(timeout);

    if (result.kind === "timeout") {
      child.kill("SIGTERM");
      await Promise.race([exitResult, new Promise((resolve) => setTimeout(resolve, 2_000))]);
      console.error(`Smoke failed: app did not exit within ${APP_CONFIG.electron.smokeAliveMs}ms.`);
      return 1;
    }

    if (result.kind === "error") {
      console.error(`Smoke failed to start: ${result.error.message}`);
      return 1;
    }

    if (isSuccessfulSmokeResult(result.code, stdout)) {
      console.log("Smoke: renderer loaded successfully in an isolated instance.");
      return 0;
    }

    console.error("Smoke failed before the renderer reported ready.");
    if (stdout.trim()) console.error(stdout.trim());
    if (stderr.trim()) console.error(stderr.trim());
    return result.code || 1;
  } finally {
    if (timeout) clearTimeout(timeout);
    await rm(smokeDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

process.exitCode = await run();
