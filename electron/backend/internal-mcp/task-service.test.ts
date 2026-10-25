import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AppState, WorkspaceState } from "../../shared/types/state.js";
import type { Logger } from "../logger.js";
import { createOperationRegistry } from "../operation-registry.js";
import type { InternalMcpCompanionCreateInput } from "../../shared/internal-mcp.js";
import { describe, expect, test, vi } from "vitest";
import { createTaskService, remapAssignment } from "./task-service.js";

describe("remapAssignment", () => {
  const targets = [".strideterm/tasks/t/sources/01-asdf.md", ".strideterm/tasks/t/sources/02-notes.md"];

  test("rewrites a quoted path and keeps the rest of the sentence word for word", () => {
    const out = remapAssignment(
      "Implementuj podle zadání v C:/work/plans/asdf.md, nic dalšího.",
      [{ path: "C:/work/plans/asdf.md" }],
      targets,
    );
    expect(out).toBe("Implementuj podle zadání v .strideterm/tasks/t/sources/01-asdf.md, nic dalšího.");
  });

  test("matches either slash style and every occurrence", () => {
    const backslashed = "C:/work/plans/asdf.md".split("/").join("\\");
    const out = remapAssignment(
      `Read ${backslashed} first, then C:/work/plans/asdf.md again.`,
      [{ path: "C:/work/plans/asdf.md" }],
      targets,
    );
    expect(out).toBe(
      "Read .strideterm/tasks/t/sources/01-asdf.md first, then .strideterm/tasks/t/sources/01-asdf.md again.",
    );
  });

  test("a longer path wins over a shorter one it contains", () => {
    const out = remapAssignment(
      "See /a/notes.md and /a/notes.md.bak",
      [{ path: "/a/notes.md" }, { path: "/a/notes.md.bak" }],
      targets,
    );
    expect(out).toBe("See .strideterm/tasks/t/sources/01-asdf.md and .strideterm/tasks/t/sources/02-notes.md");
  });

  test("an assignment that names no source is returned untouched", () => {
    expect(remapAssignment("Do the thing", [{ path: "/a/b.md" }], targets)).toBe("Do the thing");
  });

  test("matches on path boundaries: a different path or word that merely contains the source is untouched", () => {
    const out = remapAssignment(
      "Implement docs/plan.md, follow myplan.md, ignore plan.md.old and plan.md-x, but do use plan.md.",
      [{ path: "plan.md" }],
      targets,
    );
    expect(out).toBe(
      "Implement docs/plan.md, follow myplan.md, ignore plan.md.old and plan.md-x, but do use .strideterm/tasks/t/sources/01-asdf.md.",
    );
  });

  test("a source named at the start, in quotes or in parentheses is rewritten", () => {
    const out = remapAssignment('plan.md first, "plan.md" and (plan.md)', [{ path: "plan.md" }], targets);
    expect(out).toBe('S first, "S" and (S)'.replaceAll("S", ".strideterm/tasks/t/sources/01-asdf.md"));
  });
});

async function createManagedReviewFixture(
  options: {
    providerAvailable?: boolean;
    createCompanion?: (args: {
      sourceSessionId: string;
      companionRole: string;
      companionProvider: { providerId: string; model: string; effort?: string; skipPermissions?: boolean };
      focus?: string;
      autoStartAfterCapture?: boolean;
      maxRounds?: number;
    }) => Promise<{ workspaceId: string }>;
    companionLifecycle?: {
      start?: () => Promise<boolean>;
      pause?: () => Promise<boolean>;
      answer?: () => Promise<boolean>;
    };
  } = {},
) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-managed-task-")));
  const cache = path.join(root, "cache", "repo");
  const source = path.join(root, "reviews", "pr-1");
  await fs.mkdir(cache, { recursive: true });
  const git = (args: string[], cwd = cache) =>
    execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
  git(["init", "-b", "main"]);
  git(["config", "user.email", "task-test@example.invalid"]);
  git(["config", "user.name", "Task Test"]);
  await fs.writeFile(path.join(cache, "README.md"), "review base\n");
  git(["add", "README.md"]);
  git(["commit", "-m", "review base"]);
  const sourceHead = git(["rev-parse", "HEAD"]);
  git(["branch", "pr-1"]);
  git(["worktree", "add", source, "pr-1"]);
  await fs.writeFile(path.join(cache, "README.md"), "new cache head\n");
  git(["commit", "-am", "advance cache"]);

  const parent = {
    id: "review-child",
    name: "PR #1",
    kind: "terminal",
    cwd: source,
    gitRoots: [source],
    profileId: "profile-a",
    internalMcpEnabled: true,
    review: {
      checkout: { mode: "managed-worktree", rootPath: source, cacheRepoPath: cache },
    },
    quickfix: null,
    panels: [{ id: "panel-source", title: "Primary", command: "codex -m gpt-5.5", shell: true, startup: "default" }],
  } as unknown as WorkspaceState;
  const state = { workspaces: [parent], settings: {}, profiles: [] } as unknown as AppState;
  const log = { debug() {}, info() {}, warn() {}, error() {}, trace() {} } as Logger;
  const operations = createOperationRegistry({
    dir: path.join(root, "operations"),
    log,
    emitFinished: () => {},
    onChange: () => {},
  });
  const worktreeCalls: Array<{ repo: string; branch: string; baseCommit?: string }> = [];
  const service = createTaskService({
    log,
    getState: () => state,
    operations,
    execFileText: async (cmd, args, options) => ({
      stdout: execFileSync(cmd, args, { cwd: options?.cwd, encoding: "utf8", windowsHide: true }),
      stderr: "",
    }),
    worktreeTreePath: (repository, branch) => path.join(repository, "task-worktrees", branch),
    ensureWorktree: async (repo, branch, options) => {
      worktreeCalls.push({ repo, branch, baseCommit: options?.baseCommit });
      const target = path.join(repo, "task-worktrees", branch);
      await fs.mkdir(path.dirname(target), { recursive: true });
      execFileSync("git", ["worktree", "add", "-b", branch, target, options?.baseCommit ?? "HEAD"], {
        cwd: repo,
        encoding: "utf8",
      });
      return target;
    },
    assertNoConflictingActiveTask: () => {},
    createTaskWorkspace: async () => ({ workspaceId: "", taskId: "" }),
    startTask: async () => ({ ok: true }),
    getAwaitingUserRoles: () => [],
    checkProviderAvailable: async () => ({ available: options.providerAvailable !== false }),
    createCompanion: options.createCompanion,
    startCompanion: options.companionLifecycle?.start,
    pauseCompanion: options.companionLifecycle?.pause,
    answerCompanion: options.companionLifecycle?.answer,
  });
  return { cache, operations, parent, root, service, source, sourceHead, worktreeCalls, state };
}

describe("MCP companion service", () => {
  test("deduplicates concurrent requests and rejects changed payload under the same key", async () => {
    let release!: (value: { workspaceId: string }) => void;
    const createCompanion = vi.fn(() => new Promise<{ workspaceId: string }>((resolve) => (release = resolve)));
    const fixture = await createManagedReviewFixture({ createCompanion });
    try {
      const scope = { profileId: "profile-a", workspaceId: "review-child" };
      const input: InternalMcpCompanionCreateInput = {
        companionRole: "reviewer",
        providerId: "codex",
        model: "gpt-5.5",
        idempotencyKey: "companion-key-123",
      };
      const first = fixture.service.companionCreate(scope, "review-child:panel-source", input);
      const second = fixture.service.companionCreate(scope, "review-child:panel-source", input);
      await expect(
        fixture.service.companionCreate(scope, "review-child:panel-source", { ...input, model: "different" }),
      ).rejects.toMatchObject({ code: "idempotency_conflict" });
      for (let attempt = 0; attempt < 100 && createCompanion.mock.calls.length === 0; attempt += 1)
        await new Promise((resolve) => setTimeout(resolve, 2));
      expect(createCompanion).toHaveBeenCalledTimes(1);
      release({ workspaceId: "companion-1" });
      expect(await first).toMatchObject({ workspaceId: "companion-1", replayed: false });
      expect(await second).toMatchObject({ workspaceId: "companion-1", replayed: true });
    } finally {
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("unavailable providers and wrong source scope fail before creation", async () => {
    const createCompanion = vi.fn(async () => ({ workspaceId: "never" }));
    const fixture = await createManagedReviewFixture({ providerAvailable: false, createCompanion });
    try {
      const scope = { profileId: "profile-a", workspaceId: "review-child" };
      const input: InternalMcpCompanionCreateInput = {
        companionRole: "critic",
        providerId: "codex",
        model: "gpt-5.5",
        idempotencyKey: "companion-key-456",
      };
      await expect(fixture.service.companionCreate(scope, "review-child:panel-source", input)).rejects.toMatchObject({
        code: "provider_unavailable",
      });
      await expect(fixture.service.companionCreate(scope, "other:panel-source", input)).rejects.toMatchObject({
        code: "scope_denied",
      });
      expect(createCompanion).not.toHaveBeenCalled();
    } finally {
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("lifecycle controls stay on the granted conversation and preserve a false result", async () => {
    const fixture = await createManagedReviewFixture({ companionLifecycle: { pause: async () => false } });
    try {
      fixture.state.workspaces.push({
        id: "companion-1",
        kind: "task",
        profileId: "profile-a",
        cwd: fixture.source,
        task: {
          taskId: "task-1",
          mode: "attached",
          workerWorkspaceId: "review-child",
          workerPanelId: "panel-source",
          state: "running",
          rounds: [],
        },
      } as unknown as WorkspaceState);
      const scope = { profileId: "profile-a", workspaceId: "review-child" };
      expect(await fixture.service.companionPause(scope, "review-child:panel-source", "companion-1")).toEqual({
        ok: false,
      });
      await expect(
        fixture.service.companionPause(scope, "review-child:other-panel", "companion-1"),
      ).rejects.toMatchObject({ code: "scope_denied" });
    } finally {
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  });
});

describe("managed review task checkouts", () => {
  test("forces a task worktree in the cache repo while preserving the review checkout revision", async () => {
    const fixture = await createManagedReviewFixture();
    try {
      const scope = { profileId: "profile-a", workspaceId: "review-child" };
      const here = await fixture.service.prepare(scope, {
        assignment: "Fix the review issue",
        worker: { providerId: "claude", model: "sonnet" },
        judge: { providerId: "claude", model: "opus" },
        checkout: { mode: "here" },
      });
      expect(here.choices.checkout.modes).toEqual(["worktree"]);
      expect(here.errors).toContainEqual(expect.objectContaining({ field: "checkout.mode" }));
      expect(here.missingInputs).toEqual([]);
      await expect(
        fixture.service.start(scope, {
          preparationId: here.preparationId,
          approvedInputHash: here.inputHash,
          idempotencyKey: "review-here-start-1",
        }),
      ).rejects.toMatchObject({ code: "preparation_not_ready" });

      const prepared = await fixture.service.prepare(scope, {
        assignment: "Fix the review issue",
        worker: { providerId: "claude", model: "sonnet" },
        judge: { providerId: "claude", model: "opus" },
        checkout: { mode: "worktree", repository: fixture.cache, branch: "task/review-fix" },
      });
      expect(prepared.status).toBe("ready");
      expect(prepared.errors).toEqual([]);
      expect(prepared.summary.checkout).toMatchObject({
        mode: "worktree",
        repository: fixture.cache,
        baseCommit: fixture.sourceHead,
        sourceHasUncommittedChanges: false,
      });
      expect(prepared.summary.checkout).not.toHaveProperty("cwd", fixture.source);

      const accepted = await fixture.service.start(scope, {
        preparationId: prepared.preparationId,
        approvedInputHash: prepared.inputHash,
        idempotencyKey: "review-task-start-1",
      });
      const operationId = String(accepted.operationId);
      for (let attempt = 0; attempt < 100 && fixture.operations.isRunning(operationId); attempt += 1)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(fixture.operations.find(operationId)?.status).toBe("succeeded");
      expect(fixture.worktreeCalls).toEqual([
        { repo: await fs.realpath(fixture.cache), branch: "task/review-fix", baseCommit: fixture.sourceHead },
      ]);
      expect(
        execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: path.join(fixture.cache, "task-worktrees", "task", "review-fix"),
          encoding: "utf8",
          windowsHide: true,
        }).trim(),
      ).toBe(fixture.sourceHead);
    } finally {
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("rejects a cache path that is a different git repository", async () => {
    const fixture = await createManagedReviewFixture();
    const other = path.join(fixture.root, "unrelated-repo");
    try {
      await fs.mkdir(other, { recursive: true });
      execFileSync("git", ["init", "-b", "main"], { cwd: other, encoding: "utf8", windowsHide: true });
      fixture.parent.review!.checkout!.cacheRepoPath = other;
      const prepared = await fixture.service.prepare(
        { profileId: "profile-a", workspaceId: "review-child" },
        { assignment: "Fix it", checkout: { mode: "worktree", repository: other, branch: "task/fix" } },
      );
      expect(prepared.errors).toContainEqual(expect.objectContaining({ code: "unsupported_workspace" }));
    } finally {
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("keeps linked existing reviews on the ordinary checkout choices", async () => {
    const fixture = await createManagedReviewFixture();
    try {
      fixture.parent.review!.checkout!.mode = "linked-existing-workspace";
      fixture.parent.review!.checkout!.cacheRepoPath = "";
      const prepared = await fixture.service.prepare(
        { profileId: "profile-a", workspaceId: "review-child" },
        { assignment: "Fix it", checkout: { mode: "here" } },
      );
      expect(prepared.choices.checkout.modes).toEqual(["here", "worktree"]);
      expect(prepared.errors).toEqual([]);
      expect(prepared.summary.checkout).toMatchObject({ mode: "here", cwd: fixture.source });
    } finally {
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("requires the same opted-in profile workspace at prepare time", async () => {
    const fixture = await createManagedReviewFixture();
    try {
      await expect(
        fixture.service.prepare({ profileId: "other-profile", workspaceId: "review-child" }, { assignment: "Fix it" }),
      ).rejects.toMatchObject({ code: "scope_denied" });
      fixture.parent.internalMcpEnabled = false;
      await expect(
        fixture.service.prepare({ profileId: "profile-a", workspaceId: "review-child" }, { assignment: "Fix it" }),
      ).rejects.toMatchObject({ code: "scope_denied" });
    } finally {
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("forces quickfix tasks into the separate worktree mode", async () => {
    const fixture = await createManagedReviewFixture();
    try {
      fixture.parent.quickfix = {} as NonNullable<WorkspaceState["quickfix"]>;
      const prepared = await fixture.service.prepare(
        { profileId: "profile-a", workspaceId: "review-child" },
        {
          assignment: "Fix it",
          worker: { providerId: "claude", model: "sonnet" },
          judge: { providerId: "claude", model: "opus" },
          checkout: { mode: "here" },
        },
      );
      expect(prepared.choices.checkout.modes).toEqual(["worktree"]);
      expect(prepared.errors).toContainEqual(expect.objectContaining({ field: "checkout.mode" }));
    } finally {
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  });
});
