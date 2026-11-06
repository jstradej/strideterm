import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  assertExternalCompilerOutputs,
  startAfterInitialCompiles,
  startDevElectron,
  waitForInitialCompile,
} from "./dev-readiness.mjs";

test("waits for the first clean watch compilation marker", async () => {
  const stream = new PassThrough();
  let ready = false;
  const waiting = waitForInitialCompile(stream, { timeoutMs: 1000 }).then(() => {
    ready = true;
  });

  stream.write("Starting compilation in watch mode...\nFound 0 errors.\n");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ready, false);
  stream.write("Watching for file changes.\n");
  await waiting;
  assert.equal(ready, true);
});

test("does not treat an initial compile with errors as ready", async () => {
  const stream = new PassThrough();
  let ready = false;
  const waiting = waitForInitialCompile(stream, { timeoutMs: 1000 }).then(() => {
    ready = true;
  });

  stream.write("Found 1 error. Watching for file changes.\n");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ready, false);
  stream.write("Found 0 errors. Watching for file changes.\n");
  await waiting;
  assert.equal(ready, true);
});

test("does not start Electron until both backend and preload initial builds finish", async () => {
  let finishBackend;
  let finishPreload;
  let started = false;
  const backend = new Promise((resolve) => (finishBackend = resolve));
  const preload = new Promise((resolve) => (finishPreload = resolve));
  const starting = startAfterInitialCompiles([backend, preload], () => {
    started = true;
  });

  finishBackend();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started, false);
  finishPreload();
  await starting;
  assert.equal(started, true);
});

test("owns backend and preload compilers by default and waits for both before Electron", async () => {
  const startedCompilers = [];
  let finishBackend;
  let finishPreload;
  let electronStarted = false;
  const backend = new Promise((resolve) => (finishBackend = resolve));
  const preload = new Promise((resolve) => (finishPreload = resolve));
  const started = startDevElectron({
    externalCompilers: false,
    startCompiler: (name, config) => {
      startedCompilers.push([name, config]);
      return { child: name, ready: name === "backend" ? backend : preload };
    },
    waitForRenderer: async () => {},
    startElectron: () => {
      electronStarted = true;
      return "electron";
    },
  });

  assert.deepEqual(startedCompilers, [
    ["backend", "tsconfig.backend.json"],
    ["preload", "tsconfig.preload.json"],
  ]);
  finishBackend();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(electronStarted, false);
  finishPreload();
  const result = await started;
  assert.equal(electronStarted, true);
  assert.equal(result.electron, "electron");
  assert.equal(result.compilers.length, 2);
});

test("external compiler mode owns no watchers, still waits for renderer, then starts Electron", async () => {
  let compilerStarts = 0;
  const order = [];
  const result = await startDevElectron({
    externalCompilers: true,
    startCompiler: () => {
      compilerStarts += 1;
      throw new Error("must use PowerShell-owned compilers");
    },
    waitForRenderer: async () => {
      order.push("renderer");
    },
    startElectron: () => {
      order.push("electron");
      return "electron";
    },
  });

  assert.equal(compilerStarts, 0);
  assert.deepEqual(order, ["renderer", "electron"]);
  assert.deepEqual(result.compilers, []);
});

test("external compiler mode refuses to start if a required output is missing", () => {
  assert.doesNotThrow(() => assertExternalCompilerOutputs(["main.js", "preload.cjs"], () => true));
  assert.throws(
    () => assertExternalCompilerOutputs(["main.js", "preload.cjs"], (outputPath) => outputPath === "main.js"),
    /missing: preload\.cjs/,
  );
});
