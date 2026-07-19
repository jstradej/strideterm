/**
 * Frontend-only mock fixtures for the Azure DevOps and GitHub integration
 * panes. These are dev-debug helpers — the user explicitly asked for backend
 * mocks so the UI for those screens can be exercised and tuned without a
 * real Azure DevOps / GitHub backend wired up. Loaded via the URL hash:
 *
 *     #mock=azure-rich        — populate Azure inbox + a sample review PR
 *     #mock=github-rich       — populate GitHub inbox + a sample review PR
 *     #mock=both              — both above
 *     #mock=clear             — strip mocks back out (also: reload the app)
 *
 * Or call `injectAzureMocks(payload)` / `injectGitHubMocks(payload)` directly
 * from a unit test to assert UI behaviour against a stable shape.
 *
 * The data shape mirrors what the backend AzureDevOpsManager / GitHubManager
 * produce (see electron/backend/azure-devops-manager.ts), so mock-driven UI
 * code paths use the exact same selectors as real-backend code paths.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>;

// Stable timestamps so re-injecting the mock doesn't shuffle the "X hours ago"
// labels and the UI feels predictable when iterating on layout changes.
const NOW = "2026-05-04T12:00:00.000Z";
const HOURS_AGO = (h: number) => new Date(Date.parse(NOW) - h * 60 * 60 * 1000).toISOString();

function buildAzureSnapshot(): AnyRecord {
  const conn = {
    id: "mock-azure-1",
    label: "Mock org",
    orgUrl: "https://dev.azure.com/mock-org",
    login: "mock.user@example.com",
    enabled: true,
    // Mock fixture defaults to the "default" profile so per-window filters
    // (AzureInboxPane / selectors.getWorkspaceTabs) match it without
    // needing custom test setup. Real backend snapshots include profileId
    // since createConnectionSnapshot was updated to carry it.
    profileId: "default",
    pollSeconds: 120,
    projectFilters: ["MockProject", "PlatformX"],
    status: "ok",
    lastSyncAt: HOURS_AGO(0.05),
    lastError: "",
  };

  const author = { displayName: "Alice Example", uniqueName: "alice@example.com", id: "alice" };
  const reviewer = { displayName: "You", uniqueName: "mock.user@example.com", id: "you" };

  const prRow = (overrides: AnyRecord) => ({
    prKey: overrides.prKey,
    // Tying PR summaries back to their connection is what lets the inbox
    // filter ("show only PRs whose connection is in my profile") work.
    // Production AzurePrSummary always carries this field; the mock used
    // to omit it, which silently filtered every PR out post the filter
    // landing.
    connectionId: conn.id,
    project: { name: "MockProject" },
    repository: { name: "platform-api" },
    pullRequest: {
      id: overrides.id,
      title: overrides.title,
      isDraft: overrides.isDraft || false,
      sourceRefName: `refs/heads/${overrides.source || "feature/x"}`,
      targetRefName: "refs/heads/main",
      url: `https://dev.azure.com/mock-org/MockProject/_git/platform-api/pullrequest/${overrides.id}`,
    },
    author,
    role: overrides.role || "reviewer",
    hasAttention: !!overrides.hasAttention,
    attentionReason: overrides.attentionReason || "",
    checks: { failedCount: overrides.failed || 0, pendingCount: overrides.pending || 0, passedCount: 3 },
    ...overrides,
  });

  const recentlyUpdated = [
    prRow({
      prKey: "azure:1001",
      id: 1001,
      title: "Add tunnel URL command for Telegram bot",
      role: "reviewer",
      source: "feat/telegram-tunnel",
      hasAttention: true,
      attentionReason: "new comment",
    }),
    prRow({
      prKey: "azure:1002",
      id: 1002,
      title: "Refactor azure-devops-manager poll loop to use Effect",
      role: "author",
      source: "refactor/azure-poll",
      hasAttention: true,
      attentionReason: "checks failed",
      failed: 2,
    }),
    prRow({
      prKey: "azure:1003",
      id: 1003,
      title: "Documentation polish for Worktrees tab",
      role: "reviewer",
      source: "docs/worktrees",
      isDraft: true,
    }),
    prRow({
      prKey: "azure:1004",
      id: 1004,
      title: "Bump electron to 33 and update IPC schema validators",
      role: "reviewer",
      source: "chore/electron-33",
      pending: 1,
    }),
    prRow({
      prKey: "azure:1005",
      id: 1005,
      title: "GitHub Inbox responsive overhaul",
      role: "author",
      source: "feat/github-mobile",
    }),
  ];

  const needsAttention = recentlyUpdated.filter((p) => p.hasAttention);
  const myPullRequests = recentlyUpdated.filter((p) => p.role === "author");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const needsMyReview = recentlyUpdated.filter((p: any) => p.role === "reviewer" && !p.isDraft);

  // Detail PR — drives the AzureReviewPane Summary + Files + Comments tabs.
  const detail = {
    pullRequest: {
      id: 1001,
      title: "Add tunnel URL command for Telegram bot",
      description:
        "Adds /tunnel command + Tunnel URL menu button.\n\n" +
        "- Picks Cloudflare URL when connected, LAN otherwise\n" +
        "- Inline keyboard for one-tap open\n" +
        "- 5 vitest tests + audit log entry",
      isDraft: false,
      sourceRefName: "refs/heads/feat/telegram-tunnel",
      targetRefName: "refs/heads/main",
      url: "https://dev.azure.com/mock-org/MockProject/_git/platform-api/pullrequest/1001",
      mergeStatus: "succeeded",
      createdBy: author,
    },
    project: { name: "MockProject" },
    repository: { name: "platform-api" },
    role: "reviewer",
    hasAttention: true,
    attentionReason: "new comment",
    reviewerSummary: {
      reviewers: [
        { displayName: "You", uniqueName: reviewer.uniqueName, vote: 0, isRequired: true },
        { displayName: "Bob Reviewer", uniqueName: "bob@example.com", vote: 10, isRequired: false },
      ],
    },
    checks: {
      failedCount: 0,
      pendingCount: 1,
      passedCount: 3,
      checks: [
        { id: "ci/build", name: "CI / build", state: "passed", durationMs: 124000 },
        { id: "ci/lint", name: "CI / lint", state: "passed", durationMs: 14000 },
        { id: "ci/test-backend", name: "CI / test-backend", state: "passed", durationMs: 49000 },
        { id: "ci/test-frontend", name: "CI / test-frontend", state: "pending", durationMs: 0 },
      ],
    },
    changedFiles: [
      { path: "/electron/backend/telegram-manager.ts", changeType: "edit" },
      { path: "/electron/backend/runtime.ts", changeType: "edit" },
      { path: "/electron/backend/telegram-manager.test.ts", changeType: "edit" },
      { path: "/src/components/workspace/AzureInboxPane.vue", changeType: "edit" },
    ],
    threads: [
      {
        id: 9001,
        status: "active",
        isDeleted: false,
        filePath: "/electron/backend/telegram-manager.ts",
        lineStart: 120,
        lineEnd: 120,
        publishedDate: HOURS_AGO(2),
        lastUpdatedDate: HOURS_AGO(1),
        comments: [
          {
            id: 9001,
            parentCommentId: 0,
            content: "Could we also fall back to the LAN URL when Cloudflare returns 503?",
            author: { displayName: "Bob Reviewer", uniqueName: "bob@example.com" },
            publishedDate: HOURS_AGO(2),
          },
          {
            id: 9002,
            parentCommentId: 9001,
            content: "Good catch — added in the latest push, see line 132.",
            author,
            publishedDate: HOURS_AGO(1),
          },
        ],
      },
    ],
  };

  return {
    connections: [conn],
    inbox: {
      recentlyUpdated,
      needsAttention,
      needsMyReview,
      myPullRequests,
    },
    pullRequests: { "azure:1001": detail },
  };
}

function buildGitHubSnapshot(): AnyRecord {
  const conn = {
    id: "mock-github-1",
    label: "Mock GitHub",
    hostUrl: "https://api.github.com",
    currentUserLogin: "mock-user",
    enabled: true,
    // See buildAzureSnapshot for why profileId is needed on mock connections.
    profileId: "default",
    pollSeconds: 120,
    ownerFilters: ["mock-org"],
    repositoryFilters: ["mock-org/strideterm"],
    status: "ok",
    lastSyncAt: HOURS_AGO(0.05),
    lastError: "",
  };

  const author = { displayName: "Alice Example", login: "alice", id: "alice" };

  const prRow = (overrides: AnyRecord) => ({
    prKey: overrides.prKey,
    // See buildAzureSnapshot prRow comment.
    connectionId: conn.id,
    repository: { fullName: "mock-org/strideterm" },
    pullRequest: {
      id: overrides.id,
      number: overrides.id,
      title: overrides.title,
      draft: overrides.isDraft || false,
      sourceRefName: overrides.source || "feature/x",
      targetRefName: "main",
      sourceBranch: overrides.source || "feature/x",
      targetBranch: "main",
      webUrl: `https://github.com/mock-org/strideterm/pull/${overrides.id}`,
    },
    author,
    role: overrides.role || "reviewer",
    hasAttention: !!overrides.hasAttention,
    attentionReason: overrides.attentionReason || "",
    checks: { failedCount: overrides.failed || 0, pendingCount: overrides.pending || 0, passedCount: 4 },
    reviewerSummary: { approvedCount: overrides.approved || 0, changesRequestedCount: overrides.changes || 0 },
    ...overrides,
  });

  const recentlyUpdated = [
    prRow({
      prKey: "github:42",
      id: 42,
      title: "Mobile: collapsible Azure DevOps + GitHub inbox chrome",
      role: "author",
      source: "mobilnivzled",
      hasAttention: true,
      attentionReason: "review state changed",
      approved: 1,
    }),
    prRow({
      prKey: "github:41",
      id: 41,
      title: "Add /tunnel Telegram command",
      role: "reviewer",
      source: "feat/telegram-tunnel",
    }),
    prRow({
      prKey: "github:40",
      id: 40,
      title: "Fix WebGL fallback on integrated GPUs",
      role: "reviewer",
      source: "fix/webgl-fallback",
      isDraft: true,
    }),
    prRow({
      prKey: "github:39",
      id: 39,
      title: "Bump dependencies + lockfile",
      role: "reviewer",
      source: "chore/deps",
      pending: 2,
    }),
  ];

  const needsAttention = recentlyUpdated.filter((p) => p.hasAttention);
  const myPullRequests = recentlyUpdated.filter((p) => p.role === "author");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const needsMyReview = recentlyUpdated.filter((p: any) => p.role === "reviewer" && !p.isDraft);

  const detail = {
    pullRequest: {
      id: 42,
      number: 42,
      title: "Mobile: collapsible Azure DevOps + GitHub inbox chrome",
      body: "Mirrors the Git pane redesign. ⋮ Actions and tab popover collapse on phones.",
      draft: false,
      sourceRefName: "mobilnivzled",
      targetRefName: "main",
      sourceBranch: "mobilnivzled",
      targetBranch: "main",
      webUrl: "https://github.com/mock-org/strideterm/pull/42",
      createdBy: author,
    },
    repository: { fullName: "mock-org/strideterm" },
    role: "author",
    hasAttention: true,
    attentionReason: "review state changed",
    reviewerSummary: {
      approvedCount: 1,
      changesRequestedCount: 0,
      reviewers: [
        { login: "octocat", displayName: "octocat", state: "approved" },
        { login: "robotreviewer", displayName: "robot reviewer", state: "pending" },
      ],
    },
    checks: {
      failedCount: 0,
      pendingCount: 0,
      passedCount: 4,
      checks: [
        { id: "ci/build", name: "build", state: "passed", durationMs: 91000 },
        { id: "ci/lint", name: "lint", state: "passed", durationMs: 12000 },
        { id: "ci/test", name: "test", state: "passed", durationMs: 65000 },
        { id: "ci/types", name: "typecheck", state: "passed", durationMs: 34000 },
      ],
    },
    changedFiles: [
      { path: "src/components/workspace/AzureInboxPane.vue", changeType: "edit" },
      { path: "src/components/workspace/AzureReviewPane.vue", changeType: "edit" },
      { path: "src/components/workspace/GitHubInboxPane.vue", changeType: "edit" },
      { path: "src/styles/review.css", changeType: "edit" },
      { path: "src/stores/dev-mocks.ts", changeType: "add" },
    ],
    issueComments: [],
    threads: [],
  };

  return {
    connections: [conn],
    inbox: {
      recentlyUpdated,
      needsAttention,
      needsMyReview,
      myPullRequests,
    },
    pullRequests: { "github:42": detail },
  };
}

export function injectAzureMocks(payload: AnyRecord | null): AnyRecord | null {
  if (!payload) return payload;
  const next = { ...payload, azureDevops: buildAzureSnapshot() };
  return next;
}

export function injectGitHubMocks(payload: AnyRecord | null): AnyRecord | null {
  if (!payload) return payload;
  const next = { ...payload, github: buildGitHubSnapshot() };
  return next;
}

export function injectAllMocks(payload: AnyRecord | null): AnyRecord | null {
  if (!payload) return payload;
  return injectGitHubMocks(injectAzureMocks(payload));
}

/**
 * Read `#mock=...` from the current URL and apply the matching mock to the
 * payload. Returns the original payload untouched when no mock is requested.
 *
 * Use this where the renderer accepts a fresh payload from the backend so the
 * mocks survive every state broadcast (a one-shot patch would be wiped on the
 * next refresh).
 */
export function maybeApplyMockFromUrl(payload: AnyRecord | null): AnyRecord | null {
  if (!payload) return payload;
  if (typeof window === "undefined") return payload;
  const hash = String(window.location?.hash || "");
  const match = hash.match(/[#&]mock=([a-zA-Z0-9_-]+)/);
  const kind = match?.[1] || "";
  if (!kind) return payload;
  if (kind === "clear" || kind === "off") return payload;
  if (kind === "azure" || kind === "azure-rich") return injectAzureMocks(payload);
  if (kind === "github" || kind === "github-rich") return injectGitHubMocks(payload);
  if (kind === "both" || kind === "all" || kind === "rich") return injectAllMocks(payload);
  return payload;
}
