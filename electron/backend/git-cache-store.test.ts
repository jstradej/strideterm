import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Worker } from "node:worker_threads";
import { GitCacheStore, type GitCacheEntry } from "./git-cache-store.js";

const entry = (root: string, revision = "r1"): GitCacheEntry => ({
  checkoutRoot: root,
  gitDir: `${root}/.git`,
  commonDir: `${root}/.git`,
  validatedAt: Date.now(),
  revision,
  summary: { branch: "main", dirtyCount: 0 },
});
const largeStatus = (prefix: string) =>
  Array.from({ length: 132 }, (_, index) => ({
    path: `${prefix}/${index}-${"s".repeat(16_000)}`,
    code: "M",
    credential: "must not persist",
  }));
describe("GitCacheStore", () => {
  it("persists across store restart and coalesces concurrent reads", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "git-cache-"));
    const first = new GitCacheStore(dir);
    first.write(entry("/repo"));
    await first.close();
    const second = new GitCacheStore(dir);
    const [a, b] = await Promise.all([second.read(entry("/repo")), second.read(entry("/repo"))]);
    expect(a?.revision).toBe("r1");
    expect(b?.summary).toEqual({ branch: "main", dirtyCount: 0 });
    await second.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  it("does not report intentional worker termination as a warning", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "git-cache-close-normal-"));
    const warnings: Array<{ message: string; meta: unknown }> = [];
    const store = new GitCacheStore(dir, { warn: (message, meta) => warnings.push({ message, meta }) });
    await store.read(entry("/close-normal"));
    await store.close();
    expect(warnings.some(({ message }) => message.includes("worker exited"))).toBe(false);
    await fs.rm(dir, { recursive: true, force: true });
  });
  it("reports a short close deadline with counts only", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "git-cache-close-timeout-"));
    const warnings: Array<{ message: string; meta: unknown }> = [];
    const store = new GitCacheStore(dir, { warn: (message, meta) => warnings.push({ message, meta }) });
    await store.read(entry("/private/root"));
    store.write({ ...entry("/private/root/credential-canary-one"), status: [{ path: "secret-one.txt" }] });
    store.write({ ...entry("/private/root/credential-canary-two"), status: [{ path: "secret-two.txt" }] });
    let releaseWrite!: () => void;
    const writeGate = new Promise<unknown>((resolve) => {
      releaseWrite = () => resolve(true);
    });
    const internal = store as unknown as {
      call(op: string, args?: unknown): Promise<unknown>;
      flushWrites(): Promise<void>;
      inFlightWriteCount: number;
    };
    internal.call = () => writeGate;
    const flush = internal.flushWrites();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(internal.inFlightWriteCount).toBe(2);
    await store.close(5);
    const deadline = warnings.find(
      ({ message, meta }) =>
        message.includes("close timed out") && (meta as { operation?: string })?.operation === "close",
    );
    expect(deadline).toBeDefined();
    expect(deadline?.meta).toMatchObject({
      code: "TIMEOUT",
      operation: "close",
      pendingWrites: 2,
      inFlightWrites: 2,
    });
    expect(typeof (deadline?.meta as { pendingRequests?: unknown }).pendingRequests).toBe("number");
    expect(typeof (deadline?.meta as { pendingWrites?: unknown }).pendingWrites).toBe("number");
    expect(JSON.stringify(deadline).includes("credential-canary")).toBe(false);
    expect(JSON.stringify(deadline).includes("secret-one.txt")).toBe(false);
    releaseWrite();
    await flush;
    await fs.rm(dir, { recursive: true, force: true });
  });
  it("excludes completed writes from close deadline counts", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "git-cache-close-inflight-count-"));
    const warnings: Array<{ message: string; meta: unknown }> = [];
    const store = new GitCacheStore(dir, { warn: (message, meta) => warnings.push({ message, meta }) });
    await store.read(entry("/private/root"));
    store.write(entry("/private/root/first"));
    store.write(entry("/private/root/second"));
    let releaseSecond!: () => void;
    const secondWrite = new Promise<unknown>((resolve) => {
      releaseSecond = () => resolve(true);
    });
    let callCount = 0;
    const internal = store as unknown as {
      call(op: string, args?: unknown): Promise<unknown>;
      flushWrites(): Promise<void>;
      inFlightWriteCount: number;
    };
    internal.call = () => {
      callCount++;
      return callCount === 1 ? Promise.resolve(true) : secondWrite;
    };
    const flush = internal.flushWrites();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(callCount).toBe(2);
    expect(internal.inFlightWriteCount).toBe(1);
    await store.close(5);
    const deadline = warnings.find(
      ({ message, meta }) =>
        message.includes("close timed out") && (meta as { operation?: string })?.operation === "close",
    );
    expect(deadline?.meta).toMatchObject({ pendingWrites: 1, inFlightWrites: 1 });
    releaseSecond();
    await flush;
    await fs.rm(dir, { recursive: true, force: true });
  });
  it("logs postMessage failures without leaking the error payload", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "git-cache-post-message-"));
    const warnings: Array<{ message: string; meta: unknown }> = [];
    const store = new GitCacheStore(dir, { warn: (message, meta) => warnings.push({ message, meta }) });
    await store.read(entry("/post-message"));
    const internal = store as unknown as {
      worker: Worker | null;
      call(op: string, args?: unknown): Promise<unknown>;
    };
    const worker = internal.worker;
    internal.worker = {
      postMessage: () => {
        throw new Error("could not clone https://user:secret@private.example/path");
      },
    } as unknown as Worker;
    expect(await internal.call("read", { checkoutRoot: "/private/root" })).toBeNull();
    const warning = warnings.find(({ meta }) => (meta as { operation?: string })?.operation === "read");
    expect(warning?.meta).toMatchObject({ code: "POST_MESSAGE", operation: "read" });
    expect(JSON.stringify(warning).includes("secret")).toBe(false);
    expect(JSON.stringify(warning).includes("private.example")).toBe(false);
    internal.worker = worker;
    await store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  it("hydrates by exact root with its summary and status", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "git-cache-hydrate-"));
    const store = new GitCacheStore(dir);
    store.write({
      ...entry("/repos/app"),
      summary: {
        branch: "main",
        dirtyCount: 1,
        credential: "secret",
        paths: ["should-not-persist"],
      } as GitCacheEntry["summary"],
      status: [{ path: "private/file.txt", code: "M", token: "also-secret" }],
    });
    await store.close();
    const rawDb = new DatabaseSync(path.join(dir, "cache", "git-cache.sqlite"));
    rawDb.prepare("UPDATE summaries SET body=? WHERE checkout_root=?").run("{malformed-and-status-heavy", "/repos/app");
    rawDb.close();
    const restarted = new GitCacheStore(dir);
    const summary = await restarted.readByRoot("/repos/app");
    expect(summary).toMatchObject({ checkoutRoot: "/repos/app", summary: { branch: "main", dirtyCount: 1 } });
    expect(JSON.stringify(summary).includes("secret")).toBe(false);
    expect(summary?.summary).not.toHaveProperty("paths");
    expect(summary?.status).toEqual([{ path: "private/file.txt", code: "M" }]);
    expect(await restarted.readByRoot("/repos/app/subdir")).toBeNull();
    expect(await restarted.readByRoot("/repos/application")).toBeNull();
    await restarted.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  it("hydrates exact root aliases across restart and merges them within a 64 path limit", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "git-cache-root-aliases-"));
    const canonical = "/repos/canonical";
    const first = new GitCacheStore(dir);
    first.write({
      ...entry(canonical),
      rootAliases: [
        ...Array.from({ length: 60 }, (_, index) => `/workspace/alias-${index}`),
        "https://user:secret@example.invalid/repo",
        42,
      ] as string[],
      summary: { branch: "main", dirtyCount: 2, role: "must not persist" } as GitCacheEntry["summary"],
      status: [{ path: "private/status.txt", code: "M" }],
    });
    await first.close();

    const second = new GitCacheStore(dir);
    second.write({
      ...entry(canonical),
      rootAliases: Array.from({ length: 10 }, (_, index) => `/workspace/new-${index}`),
    });
    await second.close();

    const reopened = new GitCacheStore(dir);
    const hydrated = await reopened.readByRoot("/workspace/new-3");
    expect(hydrated).toMatchObject({
      checkoutRoot: canonical,
      summary: { branch: "main", dirtyCount: 2 },
    });
    expect(hydrated?.status).toEqual([{ path: "private/status.txt", code: "M" }]);
    expect(hydrated?.summary).not.toHaveProperty("role");
    expect((await reopened.readByRoot("/workspace/alias-0"))?.summary.branch).toBe("main");
    expect(await reopened.readByRoot("/workspace/new-4")).toBeNull();
    expect(await reopened.readByRoot("https://user:secret@example.invalid/repo")).toBeNull();
    const byCanonical = await reopened.readByRoot(canonical);
    expect(byCanonical?.rootAliases).toHaveLength(64);
    expect(byCanonical?.rootAliases).toContain("/workspace/alias-0");
    expect(byCanonical?.rootAliases).toContain("/workspace/new-3");
    expect(JSON.stringify(byCanonical).includes("secret")).toBe(false);
    await reopened.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  it("keeps every root alias of writes coalesced before a flush", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "git-cache-coalesced-aliases-"));
    const canonical = "/private/var/repos/app";
    const store = new GitCacheStore(dir);
    store.write({ ...entry(canonical, "first"), rootAliases: ["/var/repos/app"] });
    store.write({ ...entry(canonical, "second"), rootAliases: ["/var/repos/app/subdir"] });
    await store.close();

    const reopened = new GitCacheStore(dir);
    expect(await reopened.readByRoot("/var/repos/app")).toMatchObject({ checkoutRoot: canonical, revision: "second" });
    expect(await reopened.readByRoot("/var/repos/app/subdir")).toMatchObject({ checkoutRoot: canonical });
    await reopened.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  it("fails open for a corrupt database and an unusable data directory", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "git-cache-bad-"));
    await fs.mkdir(path.join(dir, "cache"));
    await fs.writeFile(path.join(dir, "cache", "git-cache.sqlite"), "not sqlite");
    const store = new GitCacheStore(dir);
    expect(await store.read(entry("/missing"))).toBeNull();
    await store.close();
    const blockingFile = path.join(dir, "not-a-directory");
    await fs.writeFile(blockingFile, "x");
    const warnings: unknown[] = [];
    const bad = new GitCacheStore(blockingFile, { warn: (_message, details) => warnings.push(details) });
    expect(await bad.read(entry("/missing"))).toBeNull();
    await bad.close();
    expect(warnings.length > 0).toBe(true);
    await fs.rm(dir, { recursive: true, force: true });
  });
  it("leaves an incompatible SQLite database untouched", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "git-cache-version-"));
    const cacheDir = path.join(dir, "cache");
    await fs.mkdir(cacheDir);
    const db = new DatabaseSync(path.join(cacheDir, "git-cache.sqlite"));
    db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE preserve_me (value TEXT)");
    db.prepare("INSERT INTO meta VALUES('format','999')").run();
    db.prepare("INSERT INTO preserve_me VALUES('sentinel')").run();
    db.close();
    const store = new GitCacheStore(dir);
    expect(await store.read(entry("/x"))).toBeNull();
    await store.close();
    const reopened = new DatabaseSync(path.join(cacheDir, "git-cache.sqlite"));
    expect((reopened.prepare("SELECT value FROM preserve_me").get() as { value: string }).value).toBe("sentinel");
    reopened.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  it("leaves an unversioned database with existing tables untouched", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "git-cache-unversioned-"));
    const cacheDir = path.join(dir, "cache");
    await fs.mkdir(cacheDir);
    const dbPath = path.join(cacheDir, "git-cache.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE preserve_me (value TEXT)");
    db.prepare("INSERT INTO meta VALUES('other','sentinel')").run();
    db.prepare("INSERT INTO preserve_me VALUES('keep')").run();
    db.close();

    const warnings: unknown[] = [];
    const store = new GitCacheStore(dir, { warn: (_message, meta) => warnings.push(meta) });
    expect(await store.read(entry("/unversioned"))).toBeNull();
    await store.close();
    const reopened = new DatabaseSync(dbPath);
    expect(reopened.prepare("SELECT value FROM meta WHERE key='format'").get()).toBeUndefined();
    expect((reopened.prepare("SELECT value FROM meta WHERE key='other'").get() as { value: string }).value).toBe(
      "sentinel",
    );
    expect((reopened.prepare("SELECT value FROM preserve_me").get() as { value: string }).value).toBe("keep");
    expect(reopened.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='summaries'").get()).toBe(
      undefined,
    );
    expect(warnings.some((meta) => (meta as { code?: string })?.code === "INCOMPATIBLE_FORMAT")).toBe(true);
    reopened.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  it("round-trips the renderable detail and tokens through read and readByRoot", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "git-cache-detail-"));
    const detail = {
      root: "/repos/detail",
      log: [{ hash: "abc1234", subject: "first" }],
      changes: { staged: { name: "Staged", files: [{ path: "a.ts", code: "M" }] } },
      stateToken: "state-token",
      configurationToken: "config-token",
      operationState: { kind: "idle", inProgress: false },
      branchNames: ["main", "origin/main"],
      lastChangeAt: 1234,
    };
    const first = new GitCacheStore(dir);
    first.write({
      ...entry("/repos/detail"),
      status: { staged: [{ path: "a.ts", code: "M" }], unstaged: [], untracked: [], conflicts: [] },
      detail,
    });
    expect((await first.read(entry("/repos/detail")))?.detail).toEqual(detail);
    await first.close();
    const restarted = new GitCacheStore(dir);
    expect((await restarted.read(entry("/repos/detail")))?.detail).toEqual(detail);
    const byRoot = await restarted.readByRoot("/repos/detail");
    expect(byRoot?.detail).toEqual(detail);
    expect(byRoot?.status).toEqual({
      staged: [{ path: "a.ts", code: "M" }],
      unstaged: [],
      untracked: [],
      conflicts: [],
    });
    await restarted.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  it("keeps only the allowed detail keys", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "git-cache-detail-keys-"));
    const store = new GitCacheStore(dir);
    store.write({
      ...entry("/repos/keys"),
      detail: {
        stateToken: "kept",
        log: [],
        workspaceId: "must not persist",
        error: "must not persist",
        refreshError: "must not persist",
        remoteSecret: "must not persist",
      },
    });
    await store.close();
    const reopened = new GitCacheStore(dir);
    const stored = await reopened.read(entry("/repos/keys"));
    expect(stored?.detail).toEqual({ stateToken: "kept", log: [] });
    expect(JSON.stringify(await reopened.readByRoot("/repos/keys")).includes("must not persist")).toBe(false);
    await reopened.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  it("drops a detail over 1 MiB and still stores the summary and status", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "git-cache-detail-large-"));
    const store = new GitCacheStore(dir);
    store.write({
      ...entry("/repos/large"),
      status: { staged: [], unstaged: [{ path: "kept.ts", code: "M" }], untracked: [], conflicts: [] },
      detail: {
        stateToken: "token",
        branchNames: Array.from({ length: 70_000 }, (_, index) => `branch-${index}-xxxxxxxx`),
      },
    });
    store.write({ ...entry("/repos/small"), detail: { stateToken: "small" } });
    await store.close();
    const reopened = new GitCacheStore(dir);
    const large = await reopened.read(entry("/repos/large"));
    expect(large?.detail).toBeUndefined();
    expect(large?.summary).toEqual({ branch: "main", dirtyCount: 0 });
    expect(large?.status).toEqual({
      staged: [],
      unstaged: [{ path: "kept.ts", code: "M" }],
      untracked: [],
      conflicts: [],
    });
    expect((await reopened.read(entry("/repos/small")))?.detail).toEqual({ stateToken: "small" });
    await reopened.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  it("counts the detail in the status budget and evicts the oldest status and detail together", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "git-cache-detail-budget-"));
    const store = new GitCacheStore(dir);
    const baseTime = Date.now();
    const bulky = (name: string) => ({
      stateToken: name,
      branchNames: Array.from({ length: 24_000 }, (_, index) => `${name}-${index}-xxxxxxxxxxxxxxxxxxxx`),
    });
    const names = ["oldest", "older", "middle", "newer", "newest"];
    names.forEach((name, index) =>
      store.write({
        ...entry(`/repos/${name}`),
        validatedAt: baseTime + index * 1000,
        status: { staged: [{ path: `${name}.ts`, code: "M" }], unstaged: [], untracked: [], conflicts: [] },
        detail: bulky(name),
      }),
    );
    await store.close();
    const reopened = new GitCacheStore(dir);
    const oldest = await reopened.read(entry("/repos/oldest"));
    const newest = await reopened.read(entry("/repos/newest"));
    expect(oldest?.revision).toBe("r1");
    expect(oldest?.detail).toBeUndefined();
    expect(oldest?.status).toBeUndefined();
    expect(newest?.detail?.stateToken).toBe("newest");
    expect(newest?.status).toBeDefined();
    await reopened.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  it("replaces a database of the previous format instead of disabling the cache", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "git-cache-previous-format-"));
    const cacheDir = path.join(dir, "cache");
    await fs.mkdir(cacheDir);
    const dbPath = path.join(cacheDir, "git-cache.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec(
      "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE summaries (id TEXT PRIMARY KEY, checkout_root TEXT NOT NULL, git_dir TEXT NOT NULL, common_dir TEXT NOT NULL, validated_at INTEGER NOT NULL, revision TEXT NOT NULL, body TEXT NOT NULL, summary_body TEXT NOT NULL, status_body TEXT, bytes INTEGER NOT NULL, summary_bytes INTEGER NOT NULL, alias_bytes INTEGER NOT NULL, status_bytes INTEGER NOT NULL); CREATE TABLE checkout_aliases (alias_root TEXT PRIMARY KEY, entry_id TEXT NOT NULL REFERENCES summaries(id) ON DELETE CASCADE);",
    );
    db.prepare("INSERT INTO meta VALUES('format','7')").run();
    db.close();

    const warnings: unknown[] = [];
    const store = new GitCacheStore(dir, { warn: (_message, meta) => warnings.push(meta) });
    store.write({ ...entry("/repos/migrated"), detail: { stateToken: "migrated" } });
    await store.close();
    const reopened = new GitCacheStore(dir);
    expect((await reopened.read(entry("/repos/migrated")))?.detail).toEqual({ stateToken: "migrated" });
    await reopened.close();
    expect(warnings.some((meta) => (meta as { code?: string })?.code === "INCOMPATIBLE_FORMAT")).toBe(false);
    await fs.rm(dir, { recursive: true, force: true });
  });
  it("flushes latest coalesced values on close and bounds oversized entries", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "git-cache-bounds-"));
    const store = new GitCacheStore(dir);
    store.write({ ...entry("/same", "old"), status: [{ path: "名 file.txt", code: "M" }] });
    store.write({ ...entry("/same", "new"), status: [{ path: "名 file.txt", code: "M" }] });
    store.write({ ...entry("/huge"), status: "x".repeat(7 * 1024 * 1024) });
    await store.close();
    const reopened = new GitCacheStore(dir);
    expect((await reopened.read(entry("/same")))?.revision).toBe("new");
    expect((await reopened.read(entry("/huge")))?.status).toBeUndefined();
    expect((await reopened.read(entry("/same")))?.status).toEqual([{ path: "名 file.txt", code: "M" }]);
    await Promise.all([reopened.read(entry("/same")), reopened.read(entry("/same")), reopened.close()]);
    await fs.rm(dir, { recursive: true, force: true });
  });
  it("evicts status bytes independently and drains writes added during a flush", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "git-cache-status-budget-"));
    const warnings: unknown[] = [];
    const store = new GitCacheStore(dir, { warn: (_message, meta) => warnings.push(meta) });
    const oldStatus = largeStatus("old");
    const newStatus = largeStatus("new");
    const baseTime = Date.now();
    store.write({ ...entry("/old"), validatedAt: baseTime, status: oldStatus });
    store.write({ ...entry("/new"), validatedAt: baseTime + 1000, status: newStatus });
    const flush = (store as unknown as { flushWrites(): Promise<void> }).flushWrites();
    store.write(entry("/during-flush"));
    await flush;
    await store.close();
    expect(warnings.some((meta) => (meta as { code?: string } | undefined)?.code === "TIMEOUT")).toBe(false);
    const cachePath = path.join(dir, "cache", "git-cache.sqlite");
    const diskBytes = await Promise.all(
      [cachePath, `${cachePath}-wal`, `${cachePath}-shm`].map(async (file) =>
        fs.stat(file).then(
          (s) => s.size,
          () => 0,
        ),
      ),
    );
    expect(diskBytes.reduce((sum, n) => sum + n, 0)).toBeLessThan(12 * 1024 * 1024);
    const reopened = new GitCacheStore(dir);
    const oldEntry = await reopened.read(entry("/old"));
    const newEntry = await reopened.read(entry("/new"));
    expect(oldEntry?.status === undefined).toBe(true);
    expect(newEntry?.status !== undefined).toBe(true);
    expect(JSON.stringify(newEntry?.status).includes("credential")).toBe(false);
    const statusBytes = [oldEntry?.status, newEntry?.status].reduce<number>(
      (sum, value) => sum + Buffer.byteLength(JSON.stringify(value ?? null)),
      0,
    );
    expect(statusBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect((await reopened.read(entry("/during-flush")))?.revision).toBe("r1");
    await reopened.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  it("avoids repeated same-revision timestamp writes within one minute", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "git-cache-revision-"));
    const baseTime = Date.now();
    const store = new GitCacheStore(dir);
    store.write({ ...entry("/same-revision"), validatedAt: baseTime });
    await store.close();
    const second = new GitCacheStore(dir);
    second.write({ ...entry("/same-revision"), validatedAt: baseTime + 500 });
    await second.close();
    const third = new GitCacheStore(dir);
    expect((await third.read(entry("/same-revision")))?.validatedAt).toBe(baseTime);
    third.write({ ...entry("/same-revision"), validatedAt: baseTime + 60_000 });
    await third.close();
    const fourth = new GitCacheStore(dir);
    expect((await fourth.read(entry("/same-revision")))?.validatedAt).toBe(baseTime + 60_000);
    await fourth.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
});
