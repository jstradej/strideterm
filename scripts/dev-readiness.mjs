import { existsSync } from "node:fs";

/** Resolve only after TypeScript watch has completed a clean initial emit. */
export function waitForInitialCompile(stream, { timeoutMs, onText = () => {} }) {
  return new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.off("data", onData);
      stream.off("error", onError);
      stream.off("end", onEnd);
      if (error) reject(error);
      else resolve();
    };
    const onData = (chunk) => {
      const text = chunk.toString();
      onText(text);
      output = `${output}${text}`.slice(-2048);
      if (/Found 0 errors\./i.test(output) && /Watching for file changes\./i.test(output)) finish();
    };
    const onError = (error) => finish(error);
    const onEnd = () => finish(new Error("TypeScript watch process ended before its first successful build."));
    const timer = setTimeout(
      () => finish(new Error("Timed out waiting for the initial TypeScript watch build to succeed.")),
      timeoutMs,
    );
    stream.on("data", onData);
    stream.once("error", onError);
    stream.once("end", onEnd);
  });
}

export async function startAfterInitialCompiles(readiness, start) {
  await Promise.all(readiness);
  return start();
}

export async function startDevElectron({ externalCompilers, startCompiler, waitForRenderer, startElectron }) {
  const compilerConfigs = externalCompilers
    ? []
    : [
        ["backend", "tsconfig.backend.json"],
        ["preload", "tsconfig.preload.json"],
      ];
  const compilers = compilerConfigs.map(([name, config]) => startCompiler(name, config));
  await Promise.all(compilers.map((compiler) => compiler.ready));
  await waitForRenderer();
  return { electron: await startElectron(), compilers };
}

export function assertExternalCompilerOutputs(paths, hasOutput = existsSync) {
  const missing = paths.filter((outputPath) => !hasOutput(outputPath));
  if (missing.length) {
    throw new Error(`External compiler mode requires compiled backend/preload outputs; missing: ${missing.join(", ")}`);
  }
}
