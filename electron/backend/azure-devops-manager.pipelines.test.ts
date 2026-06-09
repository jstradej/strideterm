import { describe, expect, test, vi } from "vitest";
import { AzureDevOpsManager } from "./azure-devops-manager.js";

function createCredentialStore(secrets: Record<string, string> = {}) {
  return {
    getSecret(ref: string) {
      return secrets[ref] || "";
    },
  };
}

function createReviewStore() {
  const state = { connections: {} as Record<string, unknown>, trackedPullRequests: {} as Record<string, unknown> };
  return {
    getState: () => state,
    getTrackedPullRequest: () => null,
    async upsertTrackedPullRequest() {},
    async upsertConnectionState() {},
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createManager(fetchImpl: any) {
  const manager = new AzureDevOpsManager({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    credentialStore: createCredentialStore({ "cred:ado-1": "pat-token" }) as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    reviewStore: createReviewStore() as any,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    now: () => new Date("2026-03-17T10:00:00.000Z").getTime(),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (manager as any).snapshot = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...((manager as any).snapshot || {}),
    connections: [
      {
        id: "ado-1",
        label: "ADO",
        orgUrl: "https://dev.azure.com/org",
        login: "me@example.com",
        tokenRef: "cred:ado-1",
        enabled: true,
        projectFilters: ["Platform"],
      },
    ],
  };
  return manager;
}

function ok(body: unknown) {
  return { ok: true, json: async () => body };
}

describe("AzureDevOpsManager pipelines", () => {
  test("listPipelines maps definitions + latest run and honors projectFilters", async () => {
    const fetchImpl = vi.fn(async (url: unknown) => {
      const href = String(url);
      if (href.includes("/_apis/projects")) {
        return ok({
          value: [
            { id: "p1", name: "Platform" },
            { id: "p2", name: "Other" },
          ],
        });
      }
      if (href.includes("/Platform/_apis/build/definitions")) {
        return ok({
          value: [
            {
              id: 10,
              name: "ci-build",
              path: "\\CI",
              queueStatus: "enabled",
              _links: { web: { href: "https://web/def/10" } },
              project: { id: "p1", name: "Platform" },
              latestBuild: {
                id: 555,
                buildNumber: "20260317.3",
                status: "completed",
                result: "succeeded",
                sourceBranch: "refs/heads/main",
                finishTime: "2026-03-17T09:00:00.000Z",
                requestedFor: { displayName: "Alice" },
                reason: "manual",
                _links: { web: { href: "https://web/build/555" } },
              },
            },
          ],
        });
      }
      // "Other" is filtered out by projectFilters; if it were ever queried, fail loudly.
      return ok({ value: [] });
    });

    const manager = createManager(fetchImpl);
    const pipelines = await manager.listPipelines({ connectionId: "ado-1" });

    expect(pipelines).toHaveLength(1);
    const p = pipelines[0];
    expect(p.id).toBe(10);
    expect(p.name).toBe("ci-build");
    expect(p.project.name).toBe("Platform");
    expect(p.queueStatus).toBe("enabled");
    expect(p.webUrl).toBe("https://web/def/10");
    expect(p.lastRun?.id).toBe(555);
    expect(p.lastRun?.status).toBe("completed");
    expect(p.lastRun?.result).toBe("succeeded");
    expect(p.lastRun?.sourceBranch).toBe("refs/heads/main");
    expect(p.lastRun?.requestedFor).toBe("Alice");
    // The filtered-out "Other" project must never be queried.
    expect(fetchImpl.mock.calls.some((c) => String(c[0]).includes("/Other/_apis/build/definitions"))).toBe(false);
  });

  test("getPipelineRunSeed extracts branch, parameters and blanks secret variables", async () => {
    const fetchImpl = vi.fn(async (url: unknown) => {
      const href = String(url);
      if (href.includes("/_apis/pipelines/10/runs/555")) {
        return ok({
          templateParameters: { environment: "staging", runTests: true },
          variables: {
            imageTag: { value: "1.4.2" },
            apiKey: { value: "shh", isSecret: true },
          },
          resources: { repositories: { self: { refName: "refs/heads/release" } } },
        });
      }
      return ok({});
    });

    const manager = createManager(fetchImpl);
    const seed = await manager.getPipelineRunSeed({
      connectionId: "ado-1",
      projectName: "Platform",
      pipelineId: 10,
      runId: 555,
    });

    expect(seed.branch).toBe("refs/heads/release");
    expect(seed.parameters).toEqual({ environment: "staging", runTests: "true" });
    expect(seed.variables).toContainEqual({ name: "imageTag", value: "1.4.2", isSecret: false });
    expect(seed.variables).toContainEqual({ name: "apiKey", value: "", isSecret: true });
  });

  test("runPipeline posts branch + parameters and omits blank/secret variables", async () => {
    let captured: unknown = null;
    const fetchImpl = vi.fn(async (url: unknown, options: { body?: string } = {}) => {
      const href = String(url);
      if (href.includes("/_apis/pipelines/10/runs")) {
        captured = JSON.parse(options.body || "{}");
        return ok({ id: 999, state: "inProgress", _links: { web: { href: "https://web/run/999" } } });
      }
      return ok({});
    });

    const manager = createManager(fetchImpl);
    const result = await manager.runPipeline({
      connectionId: "ado-1",
      projectName: "Platform",
      pipelineId: 10,
      branch: "refs/heads/main",
      parameters: { environment: "prod" },
      variables: [
        { name: "imageTag", value: "2.0.0" },
        { name: "apiKey", value: "", isSecret: true },
      ],
    });

    expect(captured).toEqual({
      resources: { repositories: { self: { refName: "refs/heads/main" } } },
      templateParameters: { environment: "prod" },
      variables: { imageTag: { value: "2.0.0" } },
    });
    expect(result).toEqual({ id: 999, state: "inProgress", result: undefined, webUrl: "https://web/run/999" });
  });

  test("getPipelineRunParameterSchema maps the data provider and caches per pipeline/branch", async () => {
    const fetchImpl = vi.fn(async (url: unknown) => {
      const href = String(url);
      if (href.includes("/_apis/Contribution/HierarchyQuery")) {
        return ok({
          dataProviders: {
            "ms.vss-build-web.pipeline-run-parameters-data-provider": {
              templateParameters: [
                // Azure encodes types as numeric codes: "5" string-with-values, "3" boolean.
                { name: "variant", type: "5", default: "full", values: ["full", "vcf-push", "spin-email"] },
                { name: "tenant", displayName: "Tenant (brand) to test", type: "5", default: "all" },
                { name: "keepRunning", displayName: "Keep containers running", type: "3", default: "False" },
                { type: "3" }, // nameless → dropped
              ],
            },
          },
        });
      }
      return ok({});
    });

    const manager = createManager(fetchImpl);
    const args = { connectionId: "ado-1", projectName: "Platform", pipelineId: 10, branch: "refs/heads/develop" };
    const defs = await manager.getPipelineRunParameterSchema(args);

    expect(defs).toEqual([
      // Choice param (has values) keeps its raw type; the dialog renders it as a dropdown.
      {
        name: "variant",
        displayName: "variant",
        type: "5",
        default: "full",
        values: ["full", "vcf-push", "spin-email"],
      },
      { name: "tenant", displayName: "Tenant (brand) to test", type: "5", default: "all", values: undefined },
      // Numeric "3" + true/false default normalises to "boolean" → checkbox.
      {
        name: "keepRunning",
        displayName: "Keep containers running",
        type: "boolean",
        default: "False",
        values: undefined,
      },
    ]);

    // Second call for the same pipeline/branch is served from cache (no extra fetch).
    const hierarchyCalls = () =>
      fetchImpl.mock.calls.filter((c) => String(c[0]).includes("/_apis/Contribution/HierarchyQuery")).length;
    expect(hierarchyCalls()).toBe(1);
    await manager.getPipelineRunParameterSchema(args);
    expect(hierarchyCalls()).toBe(1);
    // A different branch is a different cache key → fetches again.
    await manager.getPipelineRunParameterSchema({ ...args, branch: "refs/heads/main" });
    expect(hierarchyCalls()).toBe(2);
  });

  test("listPipelineRefs returns full branch + tag refs for an Azure Git pipeline", async () => {
    const fetchImpl = vi.fn(async (url: unknown) => {
      const href = String(url);
      if (/\/_apis\/build\/definitions\/10\?/.test(href)) {
        return ok({ repository: { id: "repo-1", type: "TfsGit" } });
      }
      if (href.includes("/repositories/repo-1/refs") && href.includes("filter=heads")) {
        return ok({ value: [{ name: "refs/heads/main" }, { name: "refs/heads/develop" }] });
      }
      if (href.includes("/repositories/repo-1/refs") && href.includes("filter=tags")) {
        return ok({ value: [{ name: "refs/tags/v1.0" }] });
      }
      return ok({});
    });

    const manager = createManager(fetchImpl);
    const refs = await manager.listPipelineRefs({ connectionId: "ado-1", projectName: "Platform", pipelineId: 10 });

    expect(refs).toEqual({
      branches: ["refs/heads/main", "refs/heads/develop"],
      tags: ["refs/tags/v1.0"],
      repositoryId: "repo-1",
    });
  });

  test("listPipelineRefs returns empty (no picker) for a non-Azure-Git repo", async () => {
    const fetchImpl = vi.fn(async (url: unknown) => {
      const href = String(url);
      if (/\/_apis\/build\/definitions\/10\?/.test(href)) {
        return ok({ repository: { id: "ghrepo", type: "GitHub" } });
      }
      return ok({ value: [] });
    });

    const manager = createManager(fetchImpl);
    const refs = await manager.listPipelineRefs({ connectionId: "ado-1", projectName: "Platform", pipelineId: 10 });

    expect(refs).toEqual({ branches: [], tags: [], repositoryId: "" });
    // The refs endpoint must never be queried for a repo type we can't enumerate.
    expect(fetchImpl.mock.calls.some((c) => String(c[0]).includes("/refs"))).toBe(false);
  });

  test("listPipelineCommits maps recent commits for the repo", async () => {
    const fetchImpl = vi.fn(async (url: unknown) => {
      const href = String(url);
      if (href.includes("/repositories/repo-1/commits")) {
        return ok({
          value: [
            {
              commitId: "0123456789abcdef0123456789abcdef01234567",
              comment: "Fix the thing\nmore detail",
              author: { name: "Alice", date: "2026-06-01T10:00:00Z" },
            },
            { commitId: "fedcba9876543210fedcba9876543210fedcba98", comment: "Initial", author: { name: "Bob" } },
          ],
        });
      }
      return ok({});
    });

    const manager = createManager(fetchImpl);
    const commits = await manager.listPipelineCommits({
      connectionId: "ado-1",
      projectName: "Platform",
      repositoryId: "repo-1",
    });

    expect(commits).toEqual([
      {
        id: "0123456789abcdef0123456789abcdef01234567",
        shortId: "01234567",
        comment: "Fix the thing", // first line only
        author: "Alice",
        date: "2026-06-01T10:00:00Z",
      },
      {
        id: "fedcba9876543210fedcba9876543210fedcba98",
        shortId: "fedcba98",
        comment: "Initial",
        author: "Bob",
        date: undefined,
      },
    ]);
  });

  test("listPipelineCommits returns [] without a repository id (no extra fetch)", async () => {
    const fetchImpl = vi.fn(async () => ok({}));
    const manager = createManager(fetchImpl);
    const commits = await manager.listPipelineCommits({
      connectionId: "ado-1",
      projectName: "Platform",
      repositoryId: "",
    });
    expect(commits).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("runPipeline sends a 40-char commit id as `version`, not `refName`", async () => {
    let captured: unknown = null;
    const fetchImpl = vi.fn(async (url: unknown, options: { body?: string } = {}) => {
      if (String(url).includes("/_apis/pipelines/10/runs")) {
        captured = JSON.parse(options.body || "{}");
        return ok({ id: 1, state: "inProgress", _links: { web: { href: "https://web/run/1" } } });
      }
      return ok({});
    });

    const manager = createManager(fetchImpl);
    const sha = "0123456789abcdef0123456789abcdef01234567";
    await manager.runPipeline({ connectionId: "ado-1", projectName: "Platform", pipelineId: 10, branch: sha });

    expect(captured).toEqual({ resources: { repositories: { self: { version: sha } } } });
  });

  test("getBuildLogText concatenates step logs ordered + labelled by the timeline", async () => {
    const fetchImpl = vi.fn(async (url: unknown) => {
      const href = String(url);
      if (/\/_apis\/build\/builds\/555\/timeline/.test(href)) {
        return ok({
          records: [
            { name: "Build", type: "Job", order: 1, log: { id: 2 } },
            { name: "Tests", type: "Task", order: 2, log: { id: 3 } },
            { name: "Checkout", type: "Task", order: 0, log: { id: 1 } },
          ],
        });
      }
      const single = href.match(/\/_apis\/build\/builds\/555\/logs\/(\d+)/);
      if (single) {
        return { ok: true, text: async () => `content for log ${single[1]}\n` };
      }
      if (/\/_apis\/build\/builds\/555\/logs\?/.test(href)) {
        return ok({ value: [{ id: 1 }, { id: 2 }, { id: 3 }] });
      }
      return ok({});
    });

    const manager = createManager(fetchImpl);
    const log = await manager.getBuildLogText({ connectionId: "ado-1", projectName: "Platform", buildId: 555 });

    // Ordered by timeline order: Checkout (0) → Build (1) → Tests (2).
    const iCheckout = log.indexOf("===== Task: Checkout =====");
    const iBuild = log.indexOf("===== Job: Build =====");
    const iTests = log.indexOf("===== Task: Tests =====");
    expect(iCheckout).toBeGreaterThanOrEqual(0);
    expect(iCheckout).toBeLessThan(iBuild);
    expect(iBuild).toBeLessThan(iTests);
    expect(log).toContain("content for log 1");
    expect(log).toContain("content for log 3");
  });

  test("runPipeline propagates a 403 with the HTTP status in the message", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      text: async () => JSON.stringify({ message: "TF400813: no access" }),
    }));

    const manager = createManager(fetchImpl);
    await expect(
      manager.runPipeline({
        connectionId: "ado-1",
        projectName: "Platform",
        pipelineId: 10,
        branch: "refs/heads/main",
      }),
    ).rejects.toThrow(/\(403\)/);
  });
});
