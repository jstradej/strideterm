import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AzureDevOpsManager } from "./azure-devops-manager.js";
import { GitHubManager } from "./github-manager.js";
import { createAzureReviewStore } from "./azure-review-store.js";

type Provider = "azure-devops" | "github";
type GitHubOptions = NonNullable<ConstructorParameters<typeof GitHubManager>[0]>;
type AzureOptions = NonNullable<ConstructorParameters<typeof AzureDevOpsManager>[0]>;
interface RemotePr {
  number: number;
  draft: boolean;
  author?: string;
  reviewer?: boolean;
  assigned?: boolean;
}
interface Activity {
  id: string;
  kind: string;
  provider: Provider;
  profileId: string;
  draftState: "draft" | "ready";
  pullRequestNumber: number;
}

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    const target = path.resolve(directory);
    if (
      path.dirname(target) !== path.resolve(os.tmpdir()) ||
      !path.basename(target).startsWith("strideterm-pr-events-")
    ) {
      throw new Error("Refusing to remove an unexpected fixture directory.");
    }
    await fs.rm(target, { recursive: true, force: true });
  }
});

async function fixture(provider: Provider, options: { watchRepository?: boolean; ownerOnly?: boolean } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-pr-events-"));
  directories.push(directory);
  const file = path.join(directory, "review.json");
  const remote: RemotePr[] = [];
  const queries: string[] = [];
  let clock = Date.parse("2026-10-17T12:00:00Z");
  const connection = {
    id: `${provider}-connection`,
    label: "Team",
    profileId: "team",
    orgUrl: "https://dev.azure.com/acme",
    hostUrl: "https://github.com",
    currentUserLogin: "me",
    login: "me@example.com",
    tokenRef: "test:token",
    enabled: true,
    repositoryFilters: provider === "github" && options.watchRepository !== false ? ["acme/web"] : [],
    ownerFilters: options.ownerOnly ? ["acme"] : [],
  };
  const gitHubPr = (pr: RemotePr) => ({
    number: pr.number,
    title: `Change ${pr.number}`,
    body: "A change to review",
    state: "open",
    draft: pr.draft,
    html_url: `https://github.com/acme/web/pull/${pr.number}`,
    created_at: "2026-10-17T10:00:00Z",
    updated_at: "2026-10-17T11:00:00Z",
    user: { login: pr.author || "alice", name: "Author" },
    base: {
      ref: "main",
      repo: { owner: { login: "acme" }, name: "web", clone_url: "https://github.com/acme/web.git" },
    },
    head: { ref: `change-${pr.number}`, sha: `${pr.number}`.padStart(40, "0") },
  });
  const azurePr = (pr: RemotePr) => ({
    pullRequestId: pr.number,
    title: `Change ${pr.number}`,
    status: "active",
    isDraft: pr.draft,
    mergeStatus: "succeeded",
    sourceRefName: `refs/heads/change-${pr.number}`,
    targetRefName: "refs/heads/main",
    creationDate: "2026-10-17T10:00:00Z",
    lastMergeSourceCommit: { commitId: `${pr.number}`.padStart(40, "0"), committer: { date: "2026-10-17T11:00:00Z" } },
    createdBy: { id: "author", displayName: "Author", uniqueName: `${pr.author || "alice"}@example.com` },
    repository: {
      id: "repo",
      name: "web",
      remoteUrl: "https://dev.azure.com/acme/Team/_git/web",
      project: { id: "project", name: "Team" },
    },
    reviewers: pr.reviewer
      ? [{ id: "me", uniqueName: "me@example.com", displayName: "Me", vote: 0, isRequired: true }]
      : [],
  });

  async function start() {
    const persisted = await createAzureReviewStore(file);
    const credentialStore = {
      getSecret: () => "fixture-token",
      setSecret: async () => {},
      hasSecret: () => true,
      deleteSecret: async () => {},
      listRefs: () => ["test:token"],
      isEncryptionAvailable: () => true,
    };
    const manager =
      provider === "github"
        ? new GitHubManager({
            credentialStore: credentialStore as GitHubOptions["credentialStore"],
            reviewStore: persisted as unknown as GitHubOptions["reviewStore"],
            now: () => clock,
          })
        : new AzureDevOpsManager({
            credentialStore: credentialStore as AzureOptions["credentialStore"],
            reviewStore: persisted as unknown as AzureOptions["reviewStore"],
            now: () => clock,
          });
    manager.api =
      provider === "github"
        ? {
            searchPullRequests: vi.fn(async (_connection: unknown, _token: string, query: string) => {
              queries.push(query);
              const matches = remote.filter((pr) =>
                query.includes("review-requested:")
                  ? pr.reviewer && !pr.draft
                  : query.includes("author:")
                    ? pr.author === "me"
                    : query.includes("assignee:")
                      ? pr.assigned
                      : query.includes("repo:acme/web"),
              );
              return matches.map((pr) => ({
                number: pr.number,
                pull_request: { url: `https://api.github.com/repos/acme/web/pulls/${pr.number}` },
                repository_url: "https://api.github.com/repos/acme/web",
                assignees: pr.assigned ? [{ login: "me" }] : [],
              }));
            }),
            getPullRequest: vi.fn(
              async (_connection: unknown, _token: string, _owner: string, _repo: string, number: number) => {
                const pr = remote.find((item) => item.number === number);
                if (!pr) throw new Error("Unexpected PR lookup.");
                return gitHubPr(pr);
              },
            ),
            listReviews: async () => [],
            listReviewComments: async () => [],
            listIssueComments: async () => [],
            listRequestedReviewers: async (
              _connection: unknown,
              _token: string,
              _owner: string,
              _repo: string,
              number: number,
            ) => ({
              users: remote.some((pr) => pr.number === number && pr.reviewer && !pr.draft) ? [{ login: "me" }] : [],
              teams: [],
            }),
          }
        : {
            listProjects: async () => [{ id: "project", name: "Team" }],
            listPullRequestsByProject: async () => remote.map(azurePr),
            listThreads: async () => [],
          };
    return {
      persisted,
      async poll() {
        clock += 60_000;
        const snapshot = await manager.sync({ connections: [connection], workspaces: [], gitSnapshots: {} });
        expect((snapshot.connections as Array<{ status: string }>)[0]).toMatchObject({ status: "ok" });
        return snapshot.reviewActivity as Activity[];
      },
    };
  }
  return { start, remote, queries };
}

describe.each<Provider>(["azure-devops", "github"])("%s PR notification polling", (provider) => {
  test("baselines existing PRs, then announces new drafts and ready PRs without a renderer", async () => {
    const { start, remote } = await fixture(provider);
    remote.push({ number: 1, draft: false, reviewer: true });
    const runtime = await start();
    expect(await runtime.poll()).toEqual([]);
    remote.push({ number: 2, draft: true, reviewer: true }, { number: 3, draft: false, reviewer: true });
    const events = await runtime.poll();
    expect(events).toHaveLength(2);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider,
          kind: "pr-new",
          profileId: "team",
          pullRequestNumber: 2,
          draftState: "draft",
        }),
        expect.objectContaining({
          provider,
          kind: "pr-new",
          profileId: "team",
          pullRequestNumber: 3,
          draftState: "ready",
        }),
      ]),
    );
    expect((await runtime.poll()).map((event) => event.id)).toEqual(events.map((event) => event.id));
  });

  test("detects draft-to-ready and newly arrived PRs across persisted restarts once", async () => {
    const { start, remote } = await fixture(provider);
    remote.push({ number: 1, draft: true, reviewer: true });
    const first = await start();
    expect(await first.poll()).toEqual([]);
    expect(Object.values(first.persisted.getState().trackedPullRequests)[0]).toMatchObject({ lastDraftState: "draft" });
    remote[0].draft = false;
    remote.push({ number: 2, draft: false, reviewer: true });
    const restarted = await start();
    const events = await restarted.poll();
    expect(events.filter((event) => event.kind === "pr-ready")).toEqual([
      expect.objectContaining({ pullRequestNumber: 1, draftState: "ready", profileId: "team" }),
    ]);
    expect(events.filter((event) => event.kind === "pr-new")).toEqual([
      expect.objectContaining({ pullRequestNumber: 2, draftState: "ready", profileId: "team" }),
    ]);
    expect((await restarted.poll()).map((event) => event.id)).toEqual(events.map((event) => event.id));
    expect(await (await start()).poll()).toEqual([]);
  });
});

test("GitHub keeps an unassigned watched draft visible when it becomes ready", async () => {
  const { start, remote, queries } = await fixture("github");
  const runtime = await start();
  await runtime.poll();
  remote.push({ number: 4, draft: true });
  expect(await runtime.poll()).toEqual([
    expect.objectContaining({ kind: "pr-new", draftState: "draft", pullRequestNumber: 4 }),
  ]);
  remote[0].draft = false;
  expect((await runtime.poll()).filter((event) => event.kind === "pr-ready")).toEqual([
    expect.objectContaining({ pullRequestNumber: 4, draftState: "ready" }),
  ]);
  expect(queries).toContain("is:pr is:open archived:false repo:acme/web");
  expect(queries.some((query) => query.includes("draft:true"))).toBe(false);
});

test("GitHub discovers assigned drafts without broadening an owner filter to all PRs", async () => {
  const { start, remote, queries } = await fixture("github", { watchRepository: false, ownerOnly: true });
  const runtime = await start();
  await runtime.poll();
  remote.push({ number: 5, draft: true, assigned: true }, { number: 6, draft: true });
  expect(await runtime.poll()).toEqual([
    expect.objectContaining({ kind: "pr-new", pullRequestNumber: 5, draftState: "draft" }),
  ]);
  expect(queries).toContain("is:pr is:open archived:false assignee:me org:acme");
  expect(queries).not.toContain("is:pr is:open archived:false org:acme");
});

test("GitHub does not announce self-authored watched PRs as incoming requests", async () => {
  const { start, remote } = await fixture("github");
  const runtime = await start();
  await runtime.poll();
  remote.push({ number: 7, draft: true, author: "me" });
  expect(await runtime.poll()).toEqual([]);
});
