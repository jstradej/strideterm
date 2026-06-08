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
