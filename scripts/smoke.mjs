import { spawn } from "node:child_process";
import electronPath from "electron";
import { APP_CONFIG } from "../config/app-config.js";

const child = spawn(electronPath, ["."], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    STRIDETERM_SMOKE_TEST: "1",
    STRIDETERM_FORCE_DIST: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let stderr = "";
let stdout = "";
let settled = false;

child.stdout.on("data", (chunk) => {
  stdout += chunk.toString();
});

child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

const timeout = setTimeout(() => {
  if (settled) {
    return;
  }
  settled = true;
  child.kill("SIGTERM");
  console.log(`Smoke: app stayed alive for ${APP_CONFIG.electron.smokeAliveMs}ms without crashing.`);
  process.exit(0);
}, APP_CONFIG.electron.smokeAliveMs);

child.on("exit", (code) => {
  if (settled) {
    return;
  }
  clearTimeout(timeout);
  settled = true;
  if (code === 0) {
    console.log("Smoke: app exited cleanly.");
    process.exit(0);
    return;
  }
  console.error("Smoke failed.");
  if (stdout.trim()) {
    console.error(stdout.trim());
  }
  if (stderr.trim()) {
    console.error(stderr.trim());
  }
  process.exit(code || 1);
});
