import { spawn } from "node:child_process";
import electronPath from "electron";

const forceDist = process.argv.includes("--dist");

const child = spawn(electronPath, ["."], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    ...(forceDist ? { STRIDETERM_FORCE_DIST: "1" } : {}),
  },
  stdio: "inherit",
});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});
