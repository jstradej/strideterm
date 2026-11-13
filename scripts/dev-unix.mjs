import { spawn, execFileSync } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { waitForInitialCompile } from "./dev-readiness.mjs";
import { nonExecutableSpawnHelpers } from "./node-pty-spawn-helper.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const options = { port: 1420, timeout: 30, dataDir: join(homedir(), ".strideterm-dev"), autoRestart: true,
  firebase: process.env.STRIDETERM_MOBILE_FIREBASE_CONFIG };
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--help" || arg === "-h") {
    console.log("Usage: ./dev.sh [--port 1420] [--timeout-seconds 30] [--data-dir PATH] [--no-auto-restart] [--mobile-firebase-config-path PATH]");
    process.exit(0);
  }
  if (arg === "--no-auto-restart") { options.autoRestart = false; continue; }
  const key = { "--port": "port", "--timeout-seconds": "timeout", "--data-dir": "dataDir", "--mobile-firebase-config-path": "firebase" }[arg];
  if (!key || !args[i + 1] || args[i + 1].startsWith("--")) throw new Error(`Unknown option or missing value: ${arg}`);
  options[key] = ["port", "timeout"].includes(key) ? Number(args[++i]) : args[++i];
}
if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535 || !Number.isInteger(options.timeout) || options.timeout < 1) {
  throw new Error("Port must be 1–65535 and timeout must be a positive integer.");
}
const env = { ...process.env, STRIDETERM_DATA_DIR: resolve(options.dataDir), STRIDETERM_RENDERER_PORT: String(options.port),
  STRIDETERM_ENV: process.env.STRIDETERM_ENV || "local", STRIDETERM_LOG_LEVEL: process.env.STRIDETERM_LOG_LEVEL || "trace",
  STRIDETERM_REMOTE_PORT: process.env.STRIDETERM_REMOTE_PORT || "43124" };
const log = (message) => console.log(`[${new Date().toLocaleTimeString()}] ${message}`);
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const children = new Set();
let stopping = false;
let electron;

function importFirebase() {
  const names = ["STRIDETERM_MOBILE_FIREBASE_PROJECT_ID", "STRIDETERM_MOBILE_FIREBASE_API_KEY", "STRIDETERM_MOBILE_FIREBASE_DATABASE_URL"];
  if (names.every((name) => env[name])) return;
  if (env.STRIDETERM_ENV === "dev" && env.STRIDETERM_BOOTSTRAP_URL && env.STRIDETERM_BOOTSTRAP_TRUST_KEYS && !options.firebase) return;
  const local = env.STRIDETERM_ENV === "local";
  if (!local && !options.firebase) throw new Error(`Set ${names.filter((name) => !env[name]).join(", ")} or --mobile-firebase-config-path for ${env.STRIDETERM_ENV}.`);
  const candidates = options.firebase ? [resolve(options.firebase)] : [];
  if (local) {
    const sibling = "strideterm-mobile/app/android/app/src/local/google-services.json";
    try {
      const common = execFileSync("git", ["-C", root, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      candidates.push(resolve(dirname(dirname(common)), sibling));
    } catch { /* Ordinary sibling discovery still works without Git. */ }
    candidates.push(resolve(root, "..", sibling));
  }
  try {
    const path = candidates.find((candidate) => existsSync(candidate));
    if (!path) throw new Error(`Firebase config not found (searched: ${candidates.join(", ")}).`);
    const config = JSON.parse(readFileSync(path, "utf8"));
    const project = config.project_info?.project_id;
    const key = config.client?.[0]?.api_key?.[0]?.current_key;
    if (!project || !key) throw new Error("Firebase project_id or client api_key missing.");
    if (env[names[0]] && env[names[0]] !== project) {
      log("Firebase config describes another project; keeping explicit environment values without importing its key or database.");
      return;
    }
    env[names[0]] ||= project;
    env[names[1]] ||= key;
    env[names[2]] ||= config.project_info.firebase_url || "";
    log(`Loaded Firebase config from ${path} (values hidden).`);
  } catch (error) {
    if (!local) throw error;
    log(`${error.message} Mobile commands may be unavailable.`);
  }
}

// Each owned command gets its own process group, including all npm/Electron descendants.
function start(command, argv, extra = {}) {
  if (stopping) throw new Error("Development startup interrupted.");
  const child = spawn(command, argv, { cwd: root, env, detached: true, stdio: "inherit", ...extra });
  children.add(child);
  child.on("error", (error) => { console.error(error.message); void shutdown(1); });
  child.once("exit", () => children.delete(child));
  return child;
}
async function stop(child) {
  if (!child?.pid) return;
  try { process.kill(-child.pid, "SIGTERM"); } catch { return; }
  await delay(500);
  try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already stopped. */ }
}
async function shutdown(code) {
  if (stopping) return;
  stopping = true;
  log("Stopping development environment...");
  await Promise.all([...children].map(stop));
  process.exit(code);
}
process.once("SIGINT", () => void shutdown(130));
process.once("SIGTERM", () => void shutdown(143));
function reachable() {
  return new Promise((done) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: options.port });
    const finish = (value) => { socket.destroy(); done(value); };
    socket.setTimeout(500, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}
async function startVite(timeout = options.timeout) {
  const child = start("npm", ["run", "dev:web"]);
  const deadline = Date.now() + timeout * 1000;
  while (Date.now() < deadline && !stopping) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("Vite exited before becoming ready.");
    if (await reachable()) return child;
    await delay(300);
  }
  throw new Error("Timed out waiting for Vite.");
}
let restarting = false;
async function launchElectron() {
  if (stopping) return;
  const child = start("npm", ["run", "dev:electron", "--", "--external-compilers"]);
  electron = child;
  child.once("exit", (code) => {
    if (!stopping && !restarting && electron === child) void shutdown(code ?? 1);
  });
}

try {
  if (!existsSync(join(root, "node_modules/typescript/bin/tsc"))) throw new Error("Dependencies missing. Run npm ci first.");
  const blocked = nonExecutableSpawnHelpers(root);
  if (blocked.length) {
    throw new Error(`node-pty spawn-helper is not executable, so every terminal would fail with "posix_spawnp failed.". Run npm ci (or: chmod +x ${blocked.join(" ")}).`);
  }
  importFirebase();
  mkdirSync(env.STRIDETERM_DATA_DIR, { recursive: true });
  log(`Using isolated data directory: ${env.STRIDETERM_DATA_DIR} (environment: ${env.STRIDETERM_ENV})`);
  for (const name of ["Cache", "GPUCache", "DawnGraphiteCache", "DawnWebGPUCache", "Code Cache"]) {
    rmSync(join(env.STRIDETERM_DATA_DIR, "electron-data", name), { recursive: true, force: true });
  }
  // Match dev.ps1's port cleanup, without killing unrelated Electron applications.
  if (await reachable()) {
    const owners = execFileSync("lsof", ["-tiTCP:" + options.port, "-sTCP:LISTEN"], { encoding: "utf8" }).trim().split(/\s+/);
    for (const pid of owners) process.kill(Number(pid), "SIGTERM");
    await delay(1000);
    if (await reachable()) throw new Error(`Port ${options.port} is still occupied.`);
  }
  let vite = await startVite();
  let buildVersion = 0;
  let handledVersion = 0;
  let lastBuildAt = 0;
  const compiling = new Set();
  const compilers = ["backend", "preload"].map((name) => {
    compiling.add(name);
    const child = start(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", `tsconfig.${name}.json`, "--watch", "--preserveWatchOutput", "--pretty", "false"], { stdio: ["ignore", "pipe", "inherit"] });
    let pending = "";
    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      pending += chunk.toString();
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) {
        if (/Starting (compilation|incremental compilation)/.test(line)) compiling.add(name);
        if (/Found 0 errors\./.test(line)) {
          compiling.delete(name);
          buildVersion++;
          lastBuildAt = Date.now();
        }
      }
    });
    child.once("exit", () => { if (!stopping) { console.error(`${name} watcher exited.`); void shutdown(1); } });
    return waitForInitialCompile(child.stdout, { timeoutMs: 120_000 });
  });
  await Promise.all(compilers);
  for (const entry of ["main.js", "preload.cjs"]) {
    if (!existsSync(join(root, "dist-electron/electron", entry))) throw new Error(`Missing compiled ${entry}.`);
  }
  const frontend = start("npm", ["exec", "--", "vite", "build", "--watch"], { env: { ...env, VITE_BUILD_WATCH: "1" } });
  frontend.once("exit", () => { if (!stopping) { console.error("Frontend build watcher exited."); void shutdown(1); } });
  handledVersion = buildVersion;
  await launchElectron();
  while (!stopping) {
    await delay(500);
    if (options.autoRestart && buildVersion !== handledVersion && compiling.size === 0 && Date.now() - lastBuildAt >= 2500) {
      restarting = true;
      log("Backend rebuilt; restarting Electron...");
      handledVersion = buildVersion;
      await stop(electron);
      await launchElectron();
      restarting = false;
    }
    if (!stopping && (vite.exitCode !== null || vite.signalCode !== null)) {
      log("Vite exited; restarting...");
      vite = await startVite(15);
    }
  }
} catch (error) {
  console.error(error.message);
  await shutdown(1);
}
