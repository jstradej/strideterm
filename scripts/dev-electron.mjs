import net from "node:net";
import { spawn } from "node:child_process";
import electronPath from "electron";
import { APP_CONFIG } from "../config/app-config.js";

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function canConnect(host, port) {
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

async function waitForRenderer() {
  const deadline = Date.now() + APP_CONFIG.renderer.waitTimeoutMs;
  while (Date.now() < deadline) {
    if (await canConnect(APP_CONFIG.renderer.devHost, APP_CONFIG.renderer.devPort)) {
      return;
    }
    await wait(APP_CONFIG.renderer.waitPollMs);
  }

  throw new Error(`Renderer did not become reachable on ${APP_CONFIG.renderer.devHost}:${APP_CONFIG.renderer.devPort}.`);
}

await waitForRenderer();

const child = spawn(electronPath, ["."], {
  cwd: process.cwd(),
  env: {
    ...process.env,
  },
  stdio: "inherit",
});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});
