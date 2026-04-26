/// <reference types="node" />
import { spawn } from "node:child_process";
import electronPath from "electron";

const forceDist = process.argv.includes("--dist");

const child = spawn(electronPath as unknown as string, ["."], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    ...(forceDist ? { STRIDETERM_FORCE_DIST: "1" } : {}),
  },
  stdio: "inherit",
});

child.on("exit", (code: number | null) => {
  process.exit(code ?? 0);
});
