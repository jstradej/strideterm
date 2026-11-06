/// <reference types="node" />
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import { fileURLToPath } from "node:url";
import electronPath from "electron";
import { APP_CONFIG } from "../config/app-config.js";
import { assertExternalCompilerOutputs, startDevElectron, waitForInitialCompile } from "./dev-readiness.mjs";

const cwd = process.cwd();
const compilerPath = fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url));
const mainEntry = fileURLToPath(new URL("../dist-electron/electron/main.js", import.meta.url));
const preloadEntry = fileURLToPath(new URL("../dist-electron/electron/preload.cjs", import.meta.url));
const externalCompilers = process.argv.includes("--external-compilers");
const children: ChildProcess[] = [];
let shuttingDown = false;

function shutdown(code: number, message?: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  if (message) console.error(`dev-electron: ${message}`);
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  process.exitCode = code;
}

process.once("SIGINT", () => shutdown(130));
process.once("SIGTERM", () => shutdown(143));

function startCompiler(name: string, config: string): { child: ChildProcess; ready: Promise<void> } {
  const child = spawn(
    process.execPath,
    [compilerPath, "-p", config, "--watch", "--preserveWatchOutput", "--pretty", "false"],
    { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  children.push(child);
  const output = (chunk: Buffer, stream: NodeJS.WriteStream) => stream.write(`[${name}] ${chunk.toString()}`);
  child.stdout?.on("data", (chunk: Buffer) => output(chunk, process.stdout));
  child.stderr?.on("data", (chunk: Buffer) => output(chunk, process.stderr));

  const ready = waitForInitialCompile(child.stdout!, {
    timeoutMs: Math.max(120_000, APP_CONFIG.renderer.waitTimeoutMs),
  }).then(() => {
    console.log(`dev-electron: ${name} initial build is ready`);
  });
  child.once("error", (error) => shutdown(1, `${name} compiler could not start: ${error.message}`));
  child.once("exit", (code) => {
    if (!shuttingDown) shutdown(code || 1, `${name} compiler exited before the dev session ended.`);
  });
  void ready.catch((error: unknown) => {
    shutdown(1, error instanceof Error ? error.message : `${name} compiler did not become ready.`);
  });
  return { child, ready };
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function waitForRenderer(): Promise<void> {
  const deadline = Date.now() + APP_CONFIG.renderer.waitTimeoutMs;
  while (Date.now() < deadline) {
    if (await canConnect(APP_CONFIG.renderer.devHost, APP_CONFIG.renderer.devPort)) return;
    await wait(APP_CONFIG.renderer.waitPollMs);
  }
  throw new Error(
    `Renderer did not become reachable on ${APP_CONFIG.renderer.devHost}:${APP_CONFIG.renderer.devPort}.`,
  );
}

try {
  if (externalCompilers) {
    assertExternalCompilerOutputs([mainEntry, preloadEntry], existsSync);
  }
  const { electron } = await startDevElectron({
    externalCompilers,
    startCompiler,
    waitForRenderer: async () => {
      if (shuttingDown) throw new Error("Development startup stopped before readiness checks completed.");
      await waitForRenderer();
    },
    startElectron: () => {
      if (shuttingDown) throw new Error("Development startup stopped before the renderer became ready.");
      return spawn(electronPath as unknown as string, ["."], {
        cwd,
        env: process.env,
        stdio: "inherit",
        windowsHide: true,
      });
    },
  });
  children.push(electron);
  electron.once("error", (error) => shutdown(1, `Electron could not start: ${error.message}`));
  electron.once("exit", (code) => shutdown(code ?? 1));
} catch (error) {
  shutdown(1, error instanceof Error ? error.message : "Development startup failed.");
}
