import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { afterEach, describe, expect, test } from "vitest";
import { createVersionChecker, parseVersion, compareVersions } from "./version-checker.js";

const tempPaths: string[] = [];

async function createTempDir() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-version-check-"));
  tempPaths.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((p) => fs.rm(p, { recursive: true, force: true })));
});

// -- Helpers for mock fetch --

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mockRelease(tag: any, { prerelease = false, draft = false } = {}) {
  return {
    tag_name: tag,
    html_url: `https://github.com/test/repo/releases/tag/${tag}`,
    published_at: "2026-01-01T00:00:00Z",
    prerelease,
    draft,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createMockFetch(releases: any, { etag = '"abc"', status = 200 } = {}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async (_url: any, _opts: any) => ({
    ok: status >= 200 && status < 300,
    status,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    headers: { get: (name: any) => (name === "etag" ? etag : null) },
    json: async () => releases,
  });
}

function createFailingFetch() {
  return async () => {
    throw new Error("Network error");
  };
}

function create304Fetch() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async (): Promise<any> => ({
    ok: false,
    status: 304,
    headers: { get: () => null },
  });
}

// -- parseVersion --

describe("parseVersion", () => {
  test("parses v-prefixed version", () => {
    expect(parseVersion("v1.4.1")).toEqual({ major: 1, minor: 4, patch: 1 });
  });

  test("parses version without prefix", () => {
    expect(parseVersion("2.0.0")).toEqual({ major: 2, minor: 0, patch: 0 });
  });

  test("returns null for nightly", () => {
    expect(parseVersion("nightly")).toBeNull();
  });

  test("returns null for non-string", () => {
    expect(parseVersion(null)).toBeNull();
    expect(parseVersion(undefined)).toBeNull();
    expect(parseVersion(123)).toBeNull();
  });

  test("returns null for partial version", () => {
    expect(parseVersion("1.2")).toBeNull();
    expect(parseVersion("v1")).toBeNull();
  });

  test("parses v0.0.0", () => {
    expect(parseVersion("v0.0.0")).toEqual({ major: 0, minor: 0, patch: 0 });
  });
});

// -- compareVersions --

describe("compareVersions", () => {
  test("equal versions return 0", () => {
    expect(compareVersions("v1.4.1", "1.4.1")).toBe(0);
  });

  test("greater major", () => {
    expect(compareVersions("v2.0.0", "v1.9.9")).toBe(1);
  });

  test("lesser major", () => {
    expect(compareVersions("v1.0.0", "v2.0.0")).toBe(-1);
  });

  test("greater minor", () => {
    expect(compareVersions("v1.5.0", "v1.4.9")).toBe(1);
  });

  test("greater patch", () => {
    expect(compareVersions("v1.4.2", "v1.4.1")).toBe(1);
  });

  test("returns 0 for unparseable input", () => {
    expect(compareVersions("nightly", "v1.0.0")).toBe(0);
    expect(compareVersions("v1.0.0", "nightly")).toBe(0);
  });
});

// -- createVersionChecker --

describe("createVersionChecker", () => {
  test("returns newer releases and version count", async () => {
    const dir = await createTempDir();
    const releases = [mockRelease("v1.6.0"), mockRelease("v1.5.0"), mockRelease("v1.4.1"), mockRelease("v1.4.0")];
    const checker = createVersionChecker({
      currentVersion: "1.4.1",
      repositoryUrl: "https://github.com/test/repo",
      userDataPath: dir,
      fetchImpl: createMockFetch(releases),
    });

    const result = await checker.checkForUpdates();

    expect(result!.latestVersion).toBe("1.6.0");
    expect(result!.versionsBehind).toBe(2);
    expect(result!.releases).toHaveLength(2);
    expect(result!.releases[0].tag).toBe("v1.6.0");
    expect(result!.releases[1].tag).toBe("v1.5.0");
  });

  test("filters out nightly, prerelease, and draft", async () => {
    const dir = await createTempDir();
    const releases = [
      mockRelease("v2.0.0"),
      mockRelease("nightly"),
      mockRelease("v1.9.0", { prerelease: true }),
      mockRelease("v1.8.0", { draft: true }),
      mockRelease("v1.5.0"),
    ];
    const checker = createVersionChecker({
      currentVersion: "1.4.1",
      repositoryUrl: "https://github.com/test/repo",
      userDataPath: dir,
      fetchImpl: createMockFetch(releases),
    });

    const result = await checker.checkForUpdates();

    expect(result!.versionsBehind).toBe(2);
    expect(result!.releases.map((r) => r.tag)).toEqual(["v2.0.0", "v1.5.0"]);
  });

  test("returns 0 versions behind when up to date", async () => {
    const dir = await createTempDir();
    const releases = [mockRelease("v1.4.1"), mockRelease("v1.4.0")];
    const checker = createVersionChecker({
      currentVersion: "1.4.1",
      repositoryUrl: "https://github.com/test/repo",
      userDataPath: dir,
      fetchImpl: createMockFetch(releases),
    });

    const result = await checker.checkForUpdates();

    expect(result!.versionsBehind).toBe(0);
    expect(result!.releases).toHaveLength(0);
    expect(result!.latestVersion).toBe("1.4.1");
  });

  test("handles network error gracefully, returns null on first check", async () => {
    const dir = await createTempDir();
    const checker = createVersionChecker({
      currentVersion: "1.4.1",
      repositoryUrl: "https://github.com/test/repo",
      userDataPath: dir,
      fetchImpl: createFailingFetch(),
    });

    const result = await checker.checkForUpdates();

    expect(result).toBeNull();
  });

  test("handles network error gracefully, returns cached result", async () => {
    const dir = await createTempDir();
    // First: successful check
    const checker = createVersionChecker({
      currentVersion: "1.4.1",
      repositoryUrl: "https://github.com/test/repo",
      userDataPath: dir,
      fetchImpl: createMockFetch([mockRelease("v1.5.0")]),
    });
    const first = await checker.checkForUpdates();
    expect(first!.versionsBehind).toBe(1);

    // Second: network error — should return the cached first result
    const checker2 = createVersionChecker({
      currentVersion: "1.4.1",
      repositoryUrl: "https://github.com/test/repo",
      userDataPath: dir,
      fetchImpl: createFailingFetch(),
    });
    const second = await checker2.checkForUpdates(true);
    expect(second!.versionsBehind).toBe(1);
  });

  test("304 Not Modified returns cached data with updated timestamp", async () => {
    const dir = await createTempDir();
    // Seed cache with a stale timestamp so the 304 handler clearly writes a newer one
    const checker = createVersionChecker({
      currentVersion: "1.4.1",
      repositoryUrl: "https://github.com/test/repo",
      userDataPath: dir,
      fetchImpl: createMockFetch([mockRelease("v1.5.0")]),
    });
    const first = await checker.checkForUpdates();

    // Backdate the cached timestamp so the 304 path produces a detectably newer one
    const cachePath = path.join(dir, "version-check.json");
    const cached = JSON.parse(await fs.readFile(cachePath, "utf8"));
    cached.lastCheckAt = "2020-01-01T00:00:00.000Z";
    await fs.writeFile(cachePath, JSON.stringify(cached));

    // Create new instance that gets 304
    const checker2 = createVersionChecker({
      currentVersion: "1.4.1",
      repositoryUrl: "https://github.com/test/repo",
      userDataPath: dir,
      fetchImpl: create304Fetch(),
    });
    const second = await checker2.checkForUpdates(true);

    expect(second!.versionsBehind).toBe(1);
    expect(second!.lastCheckAt).not.toBe("2020-01-01T00:00:00.000Z");
  });

  test("throttle: second call within 24h returns cache without fetching", async () => {
    const dir = await createTempDir();
    let fetchCount = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const countingFetch = async (url: any, opts: any) => {
      fetchCount++;
      return createMockFetch([mockRelease("v1.5.0")])(url, opts);
    };

    const checker = createVersionChecker({
      currentVersion: "1.4.1",
      repositoryUrl: "https://github.com/test/repo",
      userDataPath: dir,
      fetchImpl: countingFetch,
    });

    await checker.checkForUpdates();
    expect(fetchCount).toBe(1);

    await checker.checkForUpdates();
    expect(fetchCount).toBe(1); // No second fetch
  });

  test("force bypasses throttle", async () => {
    const dir = await createTempDir();
    let fetchCount = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const countingFetch = async (url: any, opts: any) => {
      fetchCount++;
      return createMockFetch([mockRelease("v1.5.0")])(url, opts);
    };

    const checker = createVersionChecker({
      currentVersion: "1.4.1",
      repositoryUrl: "https://github.com/test/repo",
      userDataPath: dir,
      fetchImpl: countingFetch,
    });

    await checker.checkForUpdates();
    expect(fetchCount).toBe(1);

    await checker.checkForUpdates(true);
    expect(fetchCount).toBe(2);
  });

  test("sends ETag in request when cached", async () => {
    const dir = await createTempDir();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: test local variable capturing untyped fetch headers
    let capturedHeaders: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const capturingFetch = async (url: any, opts: any) => {
      capturedHeaders = opts.headers;
      return createMockFetch([mockRelease("v1.5.0")], { etag: '"etag-value"' })(url, opts);
    };

    const checker = createVersionChecker({
      currentVersion: "1.4.1",
      repositoryUrl: "https://github.com/test/repo",
      userDataPath: dir,
      fetchImpl: capturingFetch,
    });

    // First call — no ETag
    await checker.checkForUpdates();
    expect(capturedHeaders["If-None-Match"]).toBeUndefined();

    // Second call (forced) — should send ETag
    await checker.checkForUpdates(true);
    expect(capturedHeaders["If-None-Match"]).toBe('"etag-value"');
  });

  test("getCachedResult returns null before first check", async () => {
    const dir = await createTempDir();
    const checker = createVersionChecker({
      currentVersion: "1.4.1",
      repositoryUrl: "https://github.com/test/repo",
      userDataPath: dir,
      fetchImpl: createMockFetch([]),
    });

    expect(checker.getCachedResult()).toBeNull();
  });

  test("getCachedResult returns data after check", async () => {
    const dir = await createTempDir();
    const checker = createVersionChecker({
      currentVersion: "1.4.1",
      repositoryUrl: "https://github.com/test/repo",
      userDataPath: dir,
      fetchImpl: createMockFetch([mockRelease("v1.5.0")]),
    });

    await checker.checkForUpdates();
    const cached = checker.getCachedResult();

    expect(cached).not.toBeNull();
    expect(cached!.versionsBehind).toBe(1);
  });

  test("invalid repository URL returns no-op checker", async () => {
    const checker = createVersionChecker({
      currentVersion: "1.4.1",
      repositoryUrl: "not-a-github-url",
      userDataPath: "/tmp",
    });

    expect(await checker.checkForUpdates()).toBeNull();
    expect(checker.getCachedResult()).toBeNull();
  });

  test("persists and loads cache across instances", async () => {
    const dir = await createTempDir();

    const checker1 = createVersionChecker({
      currentVersion: "1.4.1",
      repositoryUrl: "https://github.com/test/repo",
      userDataPath: dir,
      fetchImpl: createMockFetch([mockRelease("v1.6.0"), mockRelease("v1.5.0")]),
    });
    await checker1.checkForUpdates();

    // New instance, no fetch — should load from cache on first access
    const checker2 = createVersionChecker({
      currentVersion: "1.4.1",
      repositoryUrl: "https://github.com/test/repo",
      userDataPath: dir,
      fetchImpl: createFailingFetch(),
    });
    // Throttle will kick in since lastCheckAt is fresh
    const result = await checker2.checkForUpdates();
    expect(result!.versionsBehind).toBe(2);
  });

  test("handles non-OK response (rate limit) gracefully", async () => {
    const dir = await createTempDir();
    const checker = createVersionChecker({
      currentVersion: "1.4.1",
      repositoryUrl: "https://github.com/test/repo",
      userDataPath: dir,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchImpl: async (): Promise<any> => ({ ok: false, status: 403, headers: { get: () => null } }),
    });

    const result = await checker.checkForUpdates();
    expect(result).toBeNull();
  });

  test("throttle path recomputes versionsBehind against the current binary version", async () => {
    const dir = await createTempDir();
    // Seed cache as if running v1.4.0: both v1.5.0 and v1.6.0 are newer.
    const seedChecker = createVersionChecker({
      currentVersion: "1.4.0",
      repositoryUrl: "https://github.com/test/repo",
      userDataPath: dir,
      fetchImpl: createMockFetch([mockRelease("v1.6.0"), mockRelease("v1.5.0")]),
    });
    const seeded = await seedChecker.checkForUpdates();
    expect(seeded!.versionsBehind).toBe(2);

    // User updates the binary in-place to v1.6.0; new instance starts within 24h.
    // Throttle would normally hand back the stale cached count (2) — it must recompute (0).
    const updatedChecker = createVersionChecker({
      currentVersion: "1.6.0",
      repositoryUrl: "https://github.com/test/repo",
      userDataPath: dir,
      fetchImpl: createFailingFetch(), // proves we never fetched
    });
    const result = await updatedChecker.checkForUpdates();
    expect(result!.versionsBehind).toBe(0);
    expect(result!.latestVersion).toBe("1.6.0");

    // Partial update (v1.5.0): one cached release still newer.
    const partialChecker = createVersionChecker({
      currentVersion: "1.5.0",
      repositoryUrl: "https://github.com/test/repo",
      userDataPath: dir,
      fetchImpl: createFailingFetch(),
    });
    const partial = await partialChecker.checkForUpdates();
    expect(partial!.versionsBehind).toBe(1);
  });

  test("304 path recomputes versionsBehind against the current binary version", async () => {
    const dir = await createTempDir();
    const seedChecker = createVersionChecker({
      currentVersion: "1.4.0",
      repositoryUrl: "https://github.com/test/repo",
      userDataPath: dir,
      fetchImpl: createMockFetch([mockRelease("v1.6.0"), mockRelease("v1.5.0")]),
    });
    await seedChecker.checkForUpdates();

    // Backdate so the throttle expires and we actually hit the 304 branch.
    const cachePath = path.join(dir, "version-check.json");
    const cached = JSON.parse(await fs.readFile(cachePath, "utf8"));
    cached.lastCheckAt = "2020-01-01T00:00:00.000Z";
    await fs.writeFile(cachePath, JSON.stringify(cached));

    const updatedChecker = createVersionChecker({
      currentVersion: "1.6.0",
      repositoryUrl: "https://github.com/test/repo",
      userDataPath: dir,
      fetchImpl: create304Fetch(),
    });
    const result = await updatedChecker.checkForUpdates(true);
    expect(result!.versionsBehind).toBe(0);
  });

  test("getCachedResult recomputes versionsBehind against the current binary version", async () => {
    const dir = await createTempDir();
    const seedChecker = createVersionChecker({
      currentVersion: "1.4.0",
      repositoryUrl: "https://github.com/test/repo",
      userDataPath: dir,
      fetchImpl: createMockFetch([mockRelease("v1.6.0"), mockRelease("v1.5.0")]),
    });
    await seedChecker.checkForUpdates();

    const updatedChecker = createVersionChecker({
      currentVersion: "1.6.0",
      repositoryUrl: "https://github.com/test/repo",
      userDataPath: dir,
      fetchImpl: createFailingFetch(),
    });
    // Trigger the lazy load via checkForUpdates — getCachedResult itself doesn't load.
    await updatedChecker.checkForUpdates();
    const cachedView = updatedChecker.getCachedResult();
    expect(cachedView!.versionsBehind).toBe(0);
  });
});
