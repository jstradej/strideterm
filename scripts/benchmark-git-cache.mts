import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import { GitManager } from "../electron/backend/git-manager.js";
import { execFileText } from "../electron/backend/process-utils.js";

const count = Number(process.argv.find((arg) => arg.startsWith("--workspaces="))?.split("=")[1] ?? 100);
const files = Number(process.argv.find((arg) => arg.startsWith("--files="))?.split("=")[1] ?? 1000);
const worktrees = Number(process.argv.find((arg) => arg.startsWith("--worktrees="))?.split("=")[1] ?? 0);
if (
  !Number.isInteger(count) ||
  count < 1 ||
  count > 1000 ||
  !Number.isInteger(files) ||
  files < 1 ||
  files > 300_000 ||
  !Number.isInteger(worktrees) ||
  worktrees < 0 ||
  worktrees > 100
) {
  throw new Error("Use --workspaces=1..1000, --files=1..300000 and --worktrees=0..100.");
}

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-git-cache-bench-"));
const root = path.join(scratch, "repository with spaces");
const env = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: path.join(scratch, "empty-config"),
  GIT_TERMINAL_PROMPT: "0",
};
const commands: Record<string, number> = {};
const git = (cwd: string, args: string[]) => execFileText("git", args, { cwd, env, timeout: 30_000 });
let clock = Date.now();
const manager = new GitManager({
  now: () => new Date(clock),
  execGitImpl: async (cwd, args) => {
    const verb = args.find((arg) => !arg.startsWith("-")) ?? "unknown";
    commands[verb] = (commands[verb] ?? 0) + 1;
    return git(cwd, args);
  },
});
manager.detectLazygit = async () => ({ available: false, backend: null, error: "", launch: null });
const loop = monitorEventLoopDelay({ resolution: 10 });
const cpu = process.cpuUsage();
loop.enable();

async function removeFixture(directory: string): Promise<void> {
  const resolved = path.resolve(directory);
  if (
    path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
    !path.basename(resolved).startsWith("strideterm-git-cache-bench-")
  )
    throw new Error("Invalid benchmark cleanup path.");
  await fs.rm(resolved, { recursive: true, force: true });
}

try {
  await fs.mkdir(root);
  await git(root, ["init", "--initial-branch=main"]);
  await git(root, ["config", "user.name", "Cache benchmark"]);
  await git(root, ["config", "user.email", "cache@example.invalid"]);
  await git(root, ["config", "core.autocrlf", "false"]);
  for (let offset = 0; offset < files; offset += 100) {
    await Promise.all(
      Array.from({ length: Math.min(100, files - offset) }, (_, index) =>
        fs.writeFile(path.join(root, `file-${offset + index}.txt`), "initial\n"),
      ),
    );
  }
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "Initial benchmark fixture"]);
  const workspace = { id: "active", cwd: root, kind: "terminal" };
  const sleeping = Array.from({ length: count - 1 }, (_, index) => ({
    id: `sleeping-${index}`,
    cwd: path.join(scratch, `sleeping-${index}`),
    kind: "terminal",
  }));
  for (const item of sleeping) {
    await fs.mkdir(item.cwd);
    await fs.cp(path.join(root, ".git"), path.join(item.cwd, ".git"), { recursive: true });
  }
  for (let index = 0; index < worktrees; index++)
    await git(root, ["worktree", "add", "--detach", path.join(scratch, `linked-${index}`)]);
  const phases: Record<string, { durationMs: number; commands: number; byCommand: Record<string, number> }> = {};
  async function measure(name: string, task: () => Promise<unknown>) {
    const before = { ...commands };
    const started = performance.now();
    await task();
    const byCommand = Object.fromEntries(
      Object.entries(commands)
        .map(([verb, value]): [string, number] => [verb, value - (before[verb] ?? 0)])
        .filter(([, value]) => value !== 0),
    );
    phases[name] = {
      durationMs: Number((performance.now() - started).toFixed(2)),
      commands: Object.values(byCommand).reduce((sum, value) => sum + value, 0),
      byCommand,
    };
  }
  await measure("registration", async () => {
    await manager.registerWorkspaces([workspace, ...sleeping]);
  });
  if (phases.registration.commands !== 0) throw new Error("Registering sleeping repositories started Git processes.");
  await measure("cold", () => manager.refreshWorkspaces([workspace]));
  const cacheLatencies: number[] = [];
  await measure("sixtyCachedEntries", async () => {
    for (let index = 0; index < 60; index++) {
      const started = performance.now();
      await manager.refreshWorkspaces([workspace]);
      cacheLatencies.push(performance.now() - started);
    }
  });
  clock += 60_000;
  await fs.writeFile(path.join(root, "file-0.txt"), "external edit\n");
  await measure("editAndTwoClients", () =>
    Promise.all([manager.refreshWorkspaces([workspace]), manager.refreshWorkspaces([workspace])]),
  );
  if (manager.getSnapshot("active")?.dirtyCount !== 1) throw new Error("External edit was not refreshed.");
  if (phases.sixtyCachedEntries.commands !== 0) throw new Error("Cache hits started Git processes.");
  const disk = await fs.statfs(scratch);
  console.log(
    JSON.stringify(
      {
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        git: (await git(root, ["--version"])).stdout.trim(),
        filesystemType: disk.type,
        trackedFiles: files,
        linkedWorktrees: worktrees,
        registeredWorkspaces: count,
        sleepingWorkspaces: sleeping.length,
        phases,
        sleepingSnapshots: sleeping.filter((item) => manager.getSnapshot(item.id)).length,
        cacheEntryP95Ms: Number(
          cacheLatencies.sort((a, b) => a - b)[Math.ceil(cacheLatencies.length * 0.95) - 1].toFixed(3),
        ),
        processStats: manager.getProcessStats(),
        nodeCpuMicros: process.cpuUsage(cpu),
        eventLoopP99Ms: Number((loop.percentile(99) / 1e6).toFixed(2)),
        memory: process.memoryUsage(),
      },
      null,
      2,
    ),
  );
} finally {
  loop.disable();
  const disposable = manager as GitManager & { dispose?: () => void };
  disposable.dispose?.();
  await removeFixture(scratch);
}
