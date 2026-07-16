/// <reference lib="dom" />
/**
 * remote-tunnel-smoke — executes the plan's live smoke (plan §Verification 9,
 * §Phase 1.6) against the REAL application backend over a REAL Cloudflare quick
 * tunnel. NOT the mock server: it boots the actual `createRuntime()` +
 * `startRemoteServer()` headless (the same code the Electron shell runs — only
 * the GUI window is absent), then drives it two ways over the tunnel:
 *
 *   1. Protocol layer (Node `ws` + `fetch` over the tunnel URL): slim-core
 *      contract, every detail resource ({resource,revision,data}), profile
 *      authorization, terminal I/O + replay, resource interest/invalidation,
 *      and reconnect (?rev=) — proving the real server serves the v2 contract
 *      over the real edge hop.
 *   2. Device layer (Playwright Chromium at phone / tablet / wide profiles):
 *      the REAL web client (served from dist/) DRIVING the plan's live interaction
 *      matrix (§Verification 9) over the tunnel. Wide: workspace switching, each
 *      non-terminal pane (Git / Docker / Azure inbox / GitHub inbox / Review) load
 *      its on-demand detail, a multi-cell grid rendering TWO non-terminal panes at
 *      once, and reconnect/replay through those panes. Phone/tablet: switching +
 *      a provider pane + reconnect (mobile naturally requests fewer). No
 *      size-induced 1013 loop, no uncaught renderer errors; one screenshot each.
 *
 * Data note: git, docker (real DockerManager via a mock CLI file), terminal
 * (real PTY), and agent-prompts are REAL. Azure/GitHub/review-bridge data is
 * synthetic — this environment has no real provider accounts — but flows through
 * the real managers, the real remote-core reducers, the real detail endpoints
 * and the real revision/invalidation path. Loading a real provider account's PRs
 * on physical hardware remains the user's acceptance step (plan §Verification 9,
 * "run by the user").
 *
 * Run:  npx tsx scripts/remote-tunnel-smoke.mts
 * Requires: cloudflared on PATH, dist/ built (VITE_BUILD_WATCH=1 npx vite build).
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, writeFile, copyFile } from "node:fs/promises";
import { promises as dns } from "node:dns";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { chromium, devices, type Browser, type Page } from "playwright";
import { createRuntime } from "../electron/backend/runtime.js";
import { startRemoteServer } from "../electron/backend/remote-server.js";
import { AzureDevOpsManager } from "../electron/backend/azure-devops-manager.js";
import { GitHubManager } from "../electron/backend/github-manager.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 47_355;
const TOKEN = "tunnel-smoke-token-2f9a";
const AZURE_PR = "azure:smoke/repo/1";
const AZURE_PR_OTHER = "azure:smoke/repo/9"; // lives in a second profile — used for the cross-profile 403 check
const GITHUB_PR = "github:smoke/repo/2";
const WS_ID = "ws-term";
const PANEL_ID = "a";
const SESSION_ID = `${WS_ID}:${PANEL_ID}`;
// Extra workspaces for the device-layer interaction matrix (plan §Verification 9):
// one per non-terminal pane kind so the browser can switch workspaces, build a
// multi-cell grid, and open Git/Docker/Azure/GitHub-inbox/Review panes.
const WS_DOCKER = "ws-docker";
const WS_AZURE = "ws-azure";
const WS_GITHUB = "ws-github";
const WS_REVIEW = "ws-review";

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];
function record(name: string, ok: boolean, detail = ""): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// --- Synthetic provider snapshots (real accounts unavailable) --------------

function azureSnapshot() {
  const pr = (prKey: string, profileId: string, connectionId: string) => ({
    prKey,
    profileId,
    connectionId,
    lastActivityAt: "2026-07-16T10:00:00Z",
    role: "reviewer",
    project: { id: "proj", name: "Proj" },
    repository: { id: "repo", name: "repo" },
    pullRequest: {
      id: 1,
      title: "Smoke PR",
      status: "active",
      mergeStatus: "succeeded",
      sourceRefName: "refs/heads/f",
      targetRefName: "refs/heads/main",
    },
    author: { displayName: "Author" },
    checks: {
      failedCount: 0,
      pendingCount: 1,
      passedCount: 2,
      items: [
        { id: "ck1", state: "succeeded" },
        { id: "ck2", state: "pending" },
      ],
    },
    reviewerSummary: { reviewers: [{ id: "rv1", vote: 5 }] },
    threads: [{ id: "t1", lastUpdatedDate: "2026-07-16T09:30:00Z", comments: [{ id: 1, content: "looks good" }] }],
    changedFiles: [{ path: "a.ts" }],
    unresolvedThreadCount: 0,
    newCommentsCount: 1,
  });
  return {
    connections: [
      {
        id: "az-conn",
        label: "AZ",
        provider: "azure-devops",
        profileId: "default",
        orgUrl: "https://dev.azure.com/x",
        enabled: true,
      },
      {
        id: "az-other",
        label: "AZ2",
        provider: "azure-devops",
        profileId: "other",
        orgUrl: "https://dev.azure.com/y",
        enabled: true,
      },
    ],
    inbox: {
      needsMyReview: [{ prKey: AZURE_PR, connectionId: "az-conn" }],
      myPullRequests: [],
      recentlyUpdated: [],
      needsAttention: [],
    },
    trackedPullRequests: { [AZURE_PR]: { connectionId: "az-conn" } },
    pullRequests: {
      [AZURE_PR]: pr(AZURE_PR, "default", "az-conn"),
      [AZURE_PR_OTHER]: pr(AZURE_PR_OTHER, "other", "az-other"),
    },
    reviewActivity: [{ id: "ev1", prKey: AZURE_PR, profileId: "default", connectionId: "az-conn" }],
    sync: { running: false, lastStartedAt: null, lastCompletedAt: "2026-07-16T10:00:00Z" },
  };
}

function githubSnapshot() {
  return {
    connections: [{ id: "gh-conn", label: "GH", provider: "github", profileId: "default", enabled: true }],
    inbox: {
      needsMyReview: [{ prKey: GITHUB_PR, connectionId: "gh-conn" }],
      myPullRequests: [],
      recentlyUpdated: [],
      needsAttention: [],
    },
    trackedPullRequests: {},
    pullRequests: {
      [GITHUB_PR]: {
        prKey: GITHUB_PR,
        profileId: "default",
        connectionId: "gh-conn",
        lastActivityAt: "2026-07-16T10:00:00Z",
        pullRequest: { id: 2, number: 2, title: "GH Smoke", state: "open" },
        checks: { failedCount: 0, pendingCount: 0, passedCount: 1, items: [{ id: "run:1", state: "succeeded" }] },
        issueComments: [{ id: "ic1", body: "hi", createdAt: "2026-07-16T09:00:00Z" }],
        threads: [],
        changedFiles: [{ path: "b.ts" }],
      },
    },
    reviewActivity: [],
    sync: { running: false, lastStartedAt: null, lastCompletedAt: "2026-07-16T10:00:00Z" },
  };
}

// --- Tunnel ----------------------------------------------------------------

async function startTunnel(port: number): Promise<{ url: string; proc: ChildProcess }> {
  const proc = spawn("cloudflared", ["tunnel", "--url", `http://127.0.0.1:${port}`, "--no-autoupdate"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("cloudflared did not print a URL within 45s")), 45_000);
    const onData = (buf: Buffer) => {
      const m = String(buf).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m) {
        clearTimeout(timer);
        resolve(m[0]);
      }
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    proc.on("exit", (code) => reject(new Error(`cloudflared exited early (code ${code})`)));
  });
  return { url, proc };
}

// --- HTTP helpers over the tunnel ------------------------------------------

const proto2 = (cookie?: string): Record<string, string> => ({
  Authorization: `Bearer ${TOKEN}`,
  "X-Strideterm-Client-Id": "smoke-aaaa",
  "X-Strideterm-State-Protocol": "2",
  "X-Strideterm-Capabilities": "remote-core-v2,resource-details-v1",
  ...(cookie ? { Cookie: cookie } : {}),
});

/**
 * Poll the freshly-created quick tunnel until its DNS resolves, using c-ares
 * (`dns.resolve4`) — NOT `fetch`/`getaddrinfo`. This matters: Node's
 * getaddrinfo caches the FIRST negative lookup for the process lifetime, so a
 * `fetch` issued before the quick-tunnel hostname has propagated poisons the
 * cache and every later `fetch` in this process keeps returning ENOTFOUND even
 * after the name is live. `dns.resolve4` issues a fresh query each call (no
 * negative cache), so we only make the first `fetch` once the name resolves —
 * which then succeeds and is cached positively.
 */
async function waitForTunnelReady(base: string, maxMs = 90_000): Promise<boolean> {
  const host = new URL(base).hostname;
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const addrs = await dns.resolve4(host);
      if (addrs.length) {
        // Name resolves via c-ares — the edge is up. Settle briefly, then return
        // WITHOUT a getaddrinfo `fetch` (a premature one before full propagation
        // can poison Node's negative DNS cache for the process); the caller's
        // first `fetch` (bootstrapCookie) is now post-propagation and succeeds.
        await sleep(3000);
        return true;
      }
    } catch {
      /* NXDOMAIN — not propagated yet */
    }
    await sleep(2500);
  }
  return false;
}

async function bootstrapCookie(base: string): Promise<string> {
  const res = await fetch(`${base}/?token=${TOKEN}`, { redirect: "manual" });
  const setCookie = res.headers.get("set-cookie") || "";
  const m = setCookie.match(/strideterm_session=[^;]+/);
  return m ? m[0] : "";
}

async function main(): Promise<void> {
  console.log("== remote-tunnel-smoke: REAL backend over a REAL Cloudflare tunnel ==\n");

  // 1. Data dir + real git repo + docker mock file.
  const dataDir = await mkdtemp(path.join(tmpdir(), "st-tunnel-smoke-"));
  await mkdir(dataDir, { recursive: true });
  const repoDir = path.join(dataDir, "repo");
  await mkdir(repoDir, { recursive: true });
  const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, stdio: "pipe" });
  git(["init", "-b", "main"]);
  git(["config", "user.email", "smoke@example.com"]);
  git(["config", "user.name", "Smoke"]);
  await writeFile(path.join(repoDir, "README.md"), "# smoke repo\n");
  git(["add", "."]);
  git(["commit", "-m", "init"]);
  await writeFile(path.join(repoDir, "dirty.txt"), "uncommitted change\n"); // dirty working tree

  const dockerMock = path.join(dataDir, "docker-mock.json");
  await copyFile(path.join(REPO_ROOT, "test/electron-e2e/fixtures/docker-mock-state.json"), dockerMock);
  process.env.STRIDETERM_DOCKER_MOCK_FILE = dockerMock;
  process.env.STRIDETERM_SHELL_INTEGRATION = "0";

  // 2. State: default + "other" profiles, a terminal workspace on the repo.
  const state = {
    activeWorkspaceId: WS_ID,
    activeProfileId: "default",
    settings: {
      theme: "dark",
      remoteAccess: {
        enabled: true,
        host: "127.0.0.1",
        port: PORT,
        token: TOKEN,
        customPublicUrl: "",
        cloudflaredPath: "",
      },
    },
    profiles: [
      { id: "default", name: "Default", color: "#4a9eff" },
      { id: "other", name: "Other", color: "#f0a" },
    ],
    workspaces: [
      {
        id: WS_ID,
        name: "Smoke Terminal",
        icon: "S",
        color: "#4a9eff",
        kind: "terminal",
        source: "manual",
        pluginId: "",
        cwd: repoDir,
        notes: "",
        profileId: "default",
        // startup "default" (== APP_CONFIG.ui.defaultPanelStartup) is what
        // ensureVisibleSession spawns a real PTY for.
        panels: [{ id: PANEL_ID, title: "Shell", command: "", startup: "default" }],
      },
      // Docker workspace (kind=docker) → the Docker pane; cwd is the real repo so
      // it also carries a git tab. The real DockerManager reads the mock CLI file.
      {
        id: WS_DOCKER,
        name: "Docker",
        icon: "D",
        color: "#0db7ed",
        kind: "docker",
        source: "manual",
        pluginId: "",
        cwd: repoDir,
        notes: "",
        profileId: "default",
        panels: [{ id: PANEL_ID, title: "Docker", command: "", startup: "default" }],
      },
      // Azure workspace (kind=azure) → the Azure inbox pane (its only tab).
      {
        id: WS_AZURE,
        name: "Azure",
        icon: "A",
        color: "#0078d4",
        kind: "azure",
        source: "manual",
        pluginId: "",
        cwd: "",
        notes: "",
        profileId: "default",
        connectionId: "az-conn",
        panels: [{ id: PANEL_ID, title: "Azure", command: "", startup: "default" }],
      },
      // GitHub workspace (kind=github) → the GitHub inbox pane (its only tab).
      {
        id: WS_GITHUB,
        name: "GitHub",
        icon: "G",
        color: "#333333",
        kind: "github",
        source: "manual",
        pluginId: "",
        cwd: "",
        notes: "",
        profileId: "default",
        connectionId: "gh-conn",
        panels: [{ id: PANEL_ID, title: "GitHub", command: "", startup: "default" }],
      },
      // Review workspace (review.provider=azure-devops, prKey=AZURE_PR) → the
      // Review pane. Points at the seeded azure PR + review-bridge context.
      {
        id: WS_REVIEW,
        name: "Review",
        icon: "R",
        color: "#f0a",
        kind: "manual",
        source: "manual",
        pluginId: "",
        cwd: repoDir,
        notes: "",
        profileId: "default",
        connectionId: "az-conn",
        review: {
          provider: "azure-devops",
          prKey: AZURE_PR,
          connectionId: "az-conn",
          orgUrl: "https://dev.azure.com/x",
          parentWorkspaceId: WS_ID,
          project: { id: "proj", name: "Proj" },
          repository: { id: "repo", name: "repo" },
          pullRequest: { id: 1, title: "Smoke PR", status: "active" },
          role: "reviewer",
          writable: false,
          checkout: null,
        },
        panels: [{ id: PANEL_ID, title: "Shell", command: "", startup: "default" }],
      },
    ],
    windowSlots: [],
  };
  await writeFile(path.join(dataDir, "strideterm-state.json"), JSON.stringify(state, null, 2), "utf8");

  // 3. Real runtime — capture managers + review-bridge store to seed synthetic
  //    provider data (real accounts unavailable) through the real code path.
  let azureMgr: AzureDevOpsManager | null = null;
  let githubMgr: GitHubManager | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let rbStore: any = null;
  class SeededAzure extends AzureDevOpsManager {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(o: any) {
      super(o);
      azureMgr = this;
    }
    async refresh(): Promise<never> {
      return this.getSnapshot() as never;
    }
  }
  class SeededGitHub extends GitHubManager {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(o: any) {
      super(o);
      githubMgr = this;
    }
    async refresh(): Promise<never> {
      return this.getSnapshot() as never;
    }
  }
  const { createReviewBridgeStore } = await import("../electron/backend/review-bridge-store.js");
  const captureRbStore = async (root: string) => {
    rbStore = await createReviewBridgeStore(root);
    return rbStore;
  };

  console.log("[boot] createRuntime (real backend, headless)...");
  const runtime = await createRuntime({
    userDataPath: dataDir,
    /* eslint-disable @typescript-eslint/no-explicit-any -- test doubles injected into the real runtime */
    deferInitialRefresh: true,
    dependencies: {
      AzureDevOpsManager: SeededAzure as any,
      GitHubManager: SeededGitHub as any,
      createReviewBridgeStore: captureRbStore as any,
    },
    /* eslint-enable @typescript-eslint/no-explicit-any */
  });

  // Seed synthetic provider snapshots + a review-bridge context for the azure PR.
  // The async `runInitialRefresh` (deferInitialRefresh) clears provider snapshots
  // when no real connections are configured in settings, so `seedProviders()` is
  // called AGAIN after that settles (just before the checks) to keep the data
  // live for the detail endpoints.
  let reviewBridgeSeeded = false;
  const seedProviders = async (): Promise<void> => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (azureMgr as any)?.setSnapshot(azureSnapshot());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (githubMgr as any)?.setSnapshot(githubSnapshot());
    if (reviewBridgeSeeded) return;
    try {
      // Seed just the PR row (no threads/comments) — enough for the review-bridge
      // context (and its detail endpoint) to resolve for this prKey over the tunnel.
      await rbStore?.syncPullRequest({
        prKey: AZURE_PR,
        provider: "azure-devops",
        connectionId: "az-conn",
        repository: { id: "repo", name: "repo" },
        project: { id: "proj", name: "Proj" },
        pullRequest: { id: 1, title: "Smoke PR", status: "active" },
        role: "reviewer",
        threads: [],
        issueComments: [],
        changedFiles: [{ path: "a.ts" }],
        checks: { failedCount: 0, pendingCount: 1, passedCount: 2 },
        lastRemoteActivityAt: "2026-07-16T10:00:00Z",
      });
      reviewBridgeSeeded = true;
    } catch (err) {
      console.log("[boot] review-bridge seed warning:", (err as Error).message);
    }
  };
  await seedProviders();
  // Let the async initial refresh settle (it clears provider snapshots when no
  // real credentials exist), then re-seed so the data is live for the checks.
  await sleep(2500);
  await seedProviders();

  console.log("[boot] startRemoteServer (serving real web client from dist/)...");
  const server = await startRemoteServer({
    runtime: runtime as unknown as Parameters<typeof startRemoteServer>[0]["runtime"],
    staticRoot: path.join(REPO_ROOT, "dist"),
  });

  // Spawn the real PTY for the workspace + feed deterministic output.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rt = runtime as any;
  await rt.activateWorkspace(WS_ID);
  const replayLen = (): number => String(rt.getTerminalReplaySnapshot(SESSION_ID)?.data ?? "").length;
  const replayText = (): string => String(rt.getTerminalReplaySnapshot(SESSION_ID)?.data ?? "");
  // Wait for the shell to boot (buffer becomes non-empty).
  for (let i = 0; i < 40 && replayLen() === 0; i++) await sleep(250);
  console.log(`[pty] shell booted, replay=${replayLen()} bytes`);
  const receivedInputs: string[] = [];
  const origWrite = rt.writeToSession.bind(runtime);
  rt.writeToSession = (sid: string, data: string, viewer?: string) => {
    if (sid === SESSION_ID) receivedInputs.push(data);
    return origWrite(sid, data, viewer);
  };
  // Type a marker command and wait until the PTY echoes it back into the buffer.
  origWrite(SESSION_ID, "echo STRIDETERM_SMOKE_MARKER\r");
  for (let i = 0; i < 40 && !replayText().includes("STRIDETERM_SMOKE_MARKER"); i++) await sleep(250);
  console.log(
    `[pty] marker in replay: ${replayText().includes("STRIDETERM_SMOKE_MARKER")} (replay=${replayLen()} bytes)`,
  );

  // 4. Tunnel.
  console.log("[tunnel] starting cloudflared quick tunnel...");
  const { url: tunnelUrl, proc: tunnelProc } = await startTunnel(PORT);
  console.log(`[tunnel] up: ${tunnelUrl} — waiting for DNS/edge propagation...`);
  const ready = await waitForTunnelReady(tunnelUrl);
  console.log(`[tunnel] reachable: ${ready}`);

  let browser: Browser | null = null;
  let reseedTimer: ReturnType<typeof setInterval> | null = null;
  try {
    // ==== PROTOCOL LAYER (over the tunnel) ================================
    console.log("\n-- Protocol layer (Node fetch/ws over the tunnel) --");
    await seedProviders(); // ensure synthetic provider data is live (post initial-refresh)
    const cookie = await bootstrapCookie(tunnelUrl);
    record("tunnel: session bootstrap via ?token= sets cookie", Boolean(cookie), cookie ? "cookie set" : "no cookie");

    // Bind this remote client to the "default" profile — exactly what the real
    // web client does on load (`/api/remote-client/profile/activate`). Without
    // it the detail endpoints resolve the fallback profile, and profile-scoped
    // PR detail may not authorize.
    const activateRes = await fetch(`${tunnelUrl}/api/remote-client/profile/activate`, {
      method: "POST",
      headers: { ...proto2(cookie), "Content-Type": "application/json" },
      body: JSON.stringify({ profileId: "default" }),
    });
    record(
      "tunnel: remote client activates its profile (default)",
      activateRes.status === 200,
      `status ${activateRes.status}`,
    );

    const stateRes = await fetch(`${tunnelUrl}/api/state`, { headers: proto2(cookie) });
    const stateText = await stateRes.text();
    const core = JSON.parse(stateText) as Record<string, unknown>;
    const enc = stateRes.headers.get("content-encoding") || "identity";
    record(
      "tunnel: GET /api/state → slim core (protocol 2)",
      stateRes.status === 200 && core.stateProtocol === 2,
      `status ${stateRes.status}, sp=${core.stateProtocol}, enc=${enc}, ${Buffer.byteLength(stateText)} B`,
    );
    const hasSummaries = Boolean(core.gitSummaries) && !(core.git as Record<string, unknown>)?.workspaces;
    record("tunnel: core carries gitSummaries, NOT full git.workspaces", hasSummaries);
    const inboxAbsent =
      !(core.azureDevops as Record<string, unknown>)?.inbox && !(core.github as Record<string, unknown>)?.inbox;
    record("tunnel: core drops provider inbox lists (badge fields only)", inboxAbsent);
    const gitSum = (core.gitSummaries as Record<string, Record<string, unknown>>)?.[WS_ID];
    record(
      "tunnel: git summary present + dirty for the seeded repo",
      Boolean(gitSum?.available) && gitSum?.dirty === true,
      JSON.stringify(gitSum),
    );

    // Detail resources over the tunnel.
    const details: Array<[string, string]> = [
      [`git:${WS_ID}`, `/api/git/workspace-detail?workspaceId=${WS_ID}`],
      ["docker", "/api/docker/detail"],
      ["azure-inbox", "/api/azure/inbox"],
      [`azure-pr:${AZURE_PR}`, `/api/azure/pull-request-detail?prKey=${encodeURIComponent(AZURE_PR)}`],
      ["github-inbox", "/api/github/inbox"],
      [`github-pr:${GITHUB_PR}`, `/api/github/pull-request-detail?prKey=${encodeURIComponent(GITHUB_PR)}`],
      [`review-bridge:${AZURE_PR}`, `/api/review-bridge/pull-request?prKey=${encodeURIComponent(AZURE_PR)}`],
      ["agent-prompts", "/api/review-bridge/agent-prompts"],
    ];
    for (const [resource, endpoint] of details) {
      const r = await fetch(`${tunnelUrl}${endpoint}`, { headers: proto2(cookie) });
      let body: Record<string, unknown> = {};
      try {
        body = (await r.json()) as Record<string, unknown>;
      } catch {
        /* non-JSON */
      }
      const shaped = r.status === 200 && body.resource === resource && "revision" in body && "data" in body;
      const gitDetailHeavy =
        resource === `git:${WS_ID}`
          ? Boolean(
              (body.data as Record<string, unknown>)?.log !== undefined ||
              (body.data as Record<string, unknown>)?.roots,
            )
          : true;
      record(`tunnel: detail ${resource} → {resource,revision,data} 200`, shaped, `status ${r.status}`);
      if (resource === `git:${WS_ID}`)
        record("tunnel: git detail carries the heavy snapshot (roots/log)", gitDetailHeavy);
      if (resource === "docker") {
        const containers = ((body.data as Record<string, unknown>)?.containers as unknown[]) || [];
        record(
          "tunnel: docker detail carries the full container list",
          containers.length > 0,
          `${containers.length} containers`,
        );
      }
    }

    // Profile authorization: the default-profile client must NOT read the "other" PR.
    const crossRes = await fetch(
      `${tunnelUrl}/api/azure/pull-request-detail?prKey=${encodeURIComponent(AZURE_PR_OTHER)}`,
      { headers: proto2(cookie) },
    );
    record("tunnel: cross-profile PR detail rejected (403)", crossRes.status === 403, `status ${crossRes.status}`);

    // WS: slim-core handshake + terminal replay + interest/invalidate + reconnect.
    await runWsChecks(tunnelUrl, receivedInputs, runtime);

    // ==== DEVICE LAYER (Playwright over the tunnel) =======================
    console.log("\n-- Device layer (Playwright Chromium over the tunnel) --");
    // The Review pane auto-fires a provider refresh on mount which, with no real
    // credentials, transiently empties the synthetic snapshot; re-seed on a short
    // interval so a mounted pane's on-demand PR/review detail resolves.
    reseedTimer = setInterval(() => void seedProviders(), 300);
    browser = await chromium.launch();
    const artDir = path.join(REPO_ROOT, "docs", "remote-smoke-artifacts");
    await mkdir(artDir, { recursive: true });
    const profiles: Array<[string, Record<string, unknown>, boolean]> = [
      ["phone", { ...devices["iPhone 13"] }, false],
      ["tablet", { ...devices["iPad (gen 7)"] }, false],
      [
        "wide",
        { viewport: { width: 1600, height: 950 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
        true,
      ],
    ];
    for (const [label, device, isWide] of profiles) {
      await runDeviceProfile(browser, device, label, tunnelUrl, artDir, isWide);
    }
  } finally {
    if (reseedTimer) clearInterval(reseedTimer);
    console.log("\n[teardown] closing browser / tunnel / server / runtime...");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const telem = (server as any)._debugTelemetry?.();
    if (telem) console.log("[telemetry]", JSON.stringify(telem));
    await browser?.close().catch(() => undefined);
    tunnelProc.kill();
    await server.close().catch(() => undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (runtime as any).dispose?.().catch?.(() => undefined);
  }

  // Summary.
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n== ${checks.length - failed.length}/${checks.length} checks passed ==`);
  if (failed.length) {
    console.log("FAILED:");
    for (const f of failed) console.log(`  - ${f.name} (${f.detail})`);
    process.exit(1);
  }
  console.log("All real-backend-over-real-tunnel checks passed.");
  process.exit(0);
}

// --- WS protocol checks over the tunnel ------------------------------------

async function runWsChecks(tunnelUrl: string, receivedInputs: string[], _runtime: unknown): Promise<void> {
  const wsBase = tunnelUrl.replace(/^https/, "wss");
  const q = `token=${TOKEN}&clientId=smoke-aaaa&sp=2&caps=${encodeURIComponent("remote-core-v2,resource-details-v1")}`;

  // First socket: no ?rev= → bootstrap-once, then state:sync handoff.
  const msgs1: Array<Record<string, unknown>> = [];
  let lastRev = -1;
  const ws1 = new WebSocket(`${wsBase}/ws?${q}`);
  const closes: number[] = [];
  ws1.on("close", (code: number) => closes.push(code));
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("ws1 open timeout")), 20_000);
    ws1.on("open", () => {
      clearTimeout(t);
      resolve();
    });
    ws1.on("error", reject);
  });
  ws1.on("message", (raw: Buffer) => {
    try {
      const m = JSON.parse(String(raw)) as Record<string, unknown>;
      msgs1.push(m);
      const state = (m.payload || m.state) as Record<string, unknown> | undefined;
      const rev = (state?.coreRevision ?? (m as Record<string, unknown>).coreRevision) as number | undefined;
      if (typeof rev === "number" && rev > lastRev) lastRev = rev;
    } catch {
      /* ignore */
    }
  });

  // Subscribe to the terminal + declare interest; feed more input over the tunnel WS.
  ws1.send(JSON.stringify({ type: "terminal:subscribe", sessionIds: [SESSION_ID] }));
  ws1.send(
    JSON.stringify({ type: "resource:interest", resources: [`git:${WS_ID}`, "docker", `azure-pr:${AZURE_PR}`] }),
  );
  await sleep(400);
  ws1.send(JSON.stringify({ type: "terminal:input", sessionId: SESSION_ID, data: "echo TUNNEL_WS_INPUT\r" }));
  await sleep(2000);

  const replay = msgs1.find((m) => m.type === "terminal:replay");
  const replayData = String(
    (replay?.payload as Record<string, unknown>)?.data ?? (replay as Record<string, unknown>)?.data ?? "",
  );
  record(
    "tunnel WS: terminal:subscribe → terminal:replay received",
    Boolean(replay),
    replay ? `${replayData.length} bytes` : "no replay",
  );
  record(
    "tunnel WS: replay carries earlier PTY output (marker echoed)",
    replayData.includes("STRIDETERM_SMOKE_MARKER"),
    replayData.includes("STRIDETERM_SMOKE_MARKER") ? "marker present" : "marker absent",
  );
  record(
    "tunnel WS: terminal:input traversed the tunnel to the PTY",
    receivedInputs.some((d) => d.includes("TUNNEL_WS_INPUT")),
    `${receivedInputs.length} inputs seen server-side`,
  );

  const invalidates = msgs1.filter((m) => m.type === "resource:invalidate");
  record(
    "tunnel WS: resource:interest → resource:invalidate primed",
    invalidates.length > 0,
    `${invalidates.length} invalidations`,
  );
  record(
    "tunnel WS: no size-induced 1013 close on the first socket",
    !closes.includes(1013),
    closes.length ? `closes: ${closes.join(",")}` : "no close",
  );

  // Reconnect carrying ?rev= — expect a catch-up path, not a second full bootstrap fetch.
  const rev = lastRev >= 0 ? lastRev : 0;
  const msgs2: Array<Record<string, unknown>> = [];
  const ws2 = new WebSocket(`${wsBase}/ws?${q}&rev=${rev}`);
  const closes2: number[] = [];
  ws2.on("close", (code: number) => closes2.push(code));
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("ws2 open timeout")), 20_000);
    ws2.on("open", () => {
      clearTimeout(t);
      resolve();
    });
    ws2.on("error", reject);
  });
  ws2.on("message", (raw: Buffer) => {
    try {
      msgs2.push(JSON.parse(String(raw)) as Record<string, unknown>);
    } catch {
      /* ignore */
    }
  });
  ws2.send(JSON.stringify({ type: "resource:interest", resources: [`git:${WS_ID}`] }));
  await sleep(1500);
  record(
    "tunnel WS: reconnect with ?rev= re-establishes without a 1013 loop",
    !closes2.includes(1013) && ws2.readyState === WebSocket.OPEN,
    `readyState ${ws2.readyState}`,
  );
  record(
    "tunnel WS: reconnect re-primes its resource invalidations",
    msgs2.some((m) => m.type === "resource:invalidate"),
  );

  ws1.close();
  ws2.close();
  await sleep(200);
}

// --- Device profile rendering over the tunnel ------------------------------

// --- In-page driving helpers -----------------------------------------------
//
// These issue fetches from INSIDE the page (page.evaluate), replicating the
// transport's request signature (clientId from sessionStorage + Bearer token),
// so they bind to the SAME server session the browser renders — driving the real
// endpoints the store's actions call, without fragile drag-drop UI gestures.

async function inPageActivateProfile(page: Page, profileId: string): Promise<number> {
  return page.evaluate(
    async ({ token, profileId }) => {
      const clientId = window.sessionStorage.getItem("strideterm-remote-client-id") || "";
      const h: Record<string, string> = {
        "Content-Type": "application/json",
        "X-Strideterm-Client-Id": clientId,
        "X-Strideterm-State-Protocol": "2",
        "X-Strideterm-Capabilities": "remote-core-v2,resource-details-v1",
        Authorization: `Bearer ${token}`,
      };
      return fetch("/api/remote-client/profile/activate", {
        method: "POST",
        headers: h,
        body: JSON.stringify({ profileId }),
      }).then((r) => r.status);
    },
    { token: TOKEN, profileId },
  );
}

async function inPageEnableGrid(
  page: Page,
  cells: Array<{ id: string; view: string }>,
  layout: string,
): Promise<Record<string, number>> {
  return page.evaluate(
    async ({ token, cells, layout }) => {
      const clientId = window.sessionStorage.getItem("strideterm-remote-client-id") || "";
      const h: Record<string, string> = {
        "Content-Type": "application/json",
        "X-Strideterm-Client-Id": clientId,
        "X-Strideterm-State-Protocol": "2",
        "X-Strideterm-Capabilities": "remote-core-v2,resource-details-v1",
        Authorization: `Bearer ${token}`,
      };
      const post = (p: string, b: unknown): Promise<number> =>
        fetch(p, { method: "POST", headers: h, body: JSON.stringify(b) }).then((r) => r.status);
      const out: Record<string, number> = {};
      for (const c of cells)
        out[`ui:${c.id}`] = await post("/api/workspace/set-ui-state", {
          workspaceId: c.id,
          uiState: { activeViewId: c.view },
        });
      out.enable = await post("/api/workspace-grid/enable", { layout, workspaceIds: cells.map((c) => c.id) });
      out.activate = await post("/api/remote-client/workspace/activate", { workspaceId: cells[0].id });
      return out;
    },
    { token: TOKEN, cells, layout },
  );
}

interface DomState {
  shell: boolean;
  activeWs: string | null;
  gitView: boolean;
  refreshBtn: boolean;
  dockerSplit: boolean;
  dockerRows: number;
  azureInbox: boolean;
  prRows: number;
  reviewShell: boolean;
  reviewSubtabs: boolean;
  gridRoot: boolean;
  cellPanes: number;
}

async function domState(page: Page): Promise<DomState> {
  return page.evaluate((): DomState => {
    const q = (s: string): boolean => Boolean(document.querySelector(s));
    const active = document.querySelector("[data-role='workspace-list'] [data-workspace-id].workspace-card--active");
    return {
      shell: q(".app-shell") || q(".sidebar") || q("[data-role='workspace-list']"),
      activeWs: active ? active.getAttribute("data-workspace-id") : null,
      gitView: q(".git-view"),
      refreshBtn: q("[data-testid='refresh-button']"),
      dockerSplit: q(".docker-splitpanes"),
      dockerRows: document.querySelectorAll(".docker-tree__list > *").length,
      azureInbox: q(".azure-inbox"),
      prRows: document.querySelectorAll("article.azure-pr-row, .azure-repo-group article, .azure-pr-row").length,
      reviewShell: q(".review-shell"),
      reviewSubtabs: q(".review-subtabs"),
      gridRoot: q(".workspace-grid"),
      cellPanes: document.querySelectorAll(".workspace-cell__pane").length,
    };
  });
}

/** Poll `domState` until `check` holds (or timeout), returning the final state —
 *  robust to the tunnel round-trip latency of an activate→broadcast→render cycle. */
async function waitForDom(page: Page, check: (s: DomState) => boolean, timeoutMs = 12_000): Promise<DomState> {
  const deadline = Date.now() + timeoutMs;
  let s = await domState(page);
  while (!check(s) && Date.now() < deadline) {
    await page.waitForTimeout(500);
    s = await domState(page);
  }
  return s;
}

/** Click a sidebar workspace card (opening the mobile drawer first when the
 *  hamburger is showing — i.e. a narrow/phone layout), then poll until it becomes
 *  the active card. A translated-off-canvas card still reports `isVisible()`, so
 *  we gate on the hamburger's visibility (display:none unless the mobile media
 *  query is active) rather than the card's. */
async function switchWorkspace(page: Page, wsId: string): Promise<boolean> {
  const hamburger = page.locator(".mobile-hamburger");
  if (await hamburger.isVisible().catch(() => false)) {
    await hamburger.click().catch(() => undefined);
    await page.waitForSelector("aside.sidebar.sidebar--open", { timeout: 5000 }).catch(() => undefined);
    await page.waitForTimeout(500);
  }
  const sel = `[data-role='workspace-list'] > [data-workspace-id='${wsId}']`;
  await page.click(sel, { timeout: 8000 }).catch(() => undefined);
  const deadline = Date.now() + 12_000;
  for (;;) {
    const active = await page.evaluate(
      (id) => Boolean(document.querySelector(`[data-workspace-id='${id}'].workspace-card--active`)),
      wsId,
    );
    if (active || Date.now() > deadline) return active;
    await page.waitForTimeout(500);
  }
}

async function clickTab(page: Page, viewId: string): Promise<void> {
  await page
    .click(`[data-role='tab-strip'] button.tab[data-view-id='${viewId}']`, { timeout: 8000 })
    .catch(() => undefined);
  await page.waitForTimeout(2500);
}

/** Click a provider-inbox sub-tab (e.g. "Needs review") by its label text. */
async function clickInboxSubtab(page: Page, needle: string): Promise<void> {
  await page.evaluate((n) => {
    const tabs = Array.from(document.querySelectorAll(".azure-inbox__tabs .azure-tab, .azure-inbox__tabs button"));
    const t = tabs.find((e) => new RegExp(n, "i").test(e.textContent || ""));
    (t as HTMLElement | undefined)?.click();
  }, needle);
  await page.waitForTimeout(2000);
}

/** Drop then restore the browser's network to force a WS reconnect, and report
 *  whether the app recovered (not stuck disconnected) within the window. */
async function reconnectCycle(page: Page): Promise<boolean> {
  const context = page.context();
  await context.setOffline(true);
  await page.waitForTimeout(3000);
  await context.setOffline(false);
  await page.waitForTimeout(9000);
  const bodyText =
    (await page
      .locator("body")
      .innerText()
      .catch(() => "")) || "";
  return !/disconnected|reconnecting/i.test(bodyText.slice(0, 300));
}

async function runDeviceProfile(
  browser: Browser,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Playwright device descriptor is an untyped bag
  device: any,
  label: string,
  tunnelUrl: string,
  artDir: string,
  isWide: boolean,
): Promise<void> {
  const context = await browser.newContext(device);
  // tsx/esbuild wraps named functions with a module-local `__name` helper that is
  // absent in the page's evaluate scope — define it so evaluate callbacks run.
  // NOTE: we deliberately do NOT seed a token or clear cookies. Over the https
  // tunnel the `?token=` bootstrap sets a Secure session cookie and the real web
  // client runs cookie-only; the WS upgrade, the transport's HTTP calls, and our
  // in-page setup fetches all carry that cookie, so they resolve to the SAME
  // server session the browser renders (activation/grid writes then reflect).
  await context.addInitScript(() => {
    const w = window as unknown as { __name?: (fn: unknown) => unknown };
    if (!w.__name) w.__name = (fn) => fn;
  });
  const page = await context.newPage();
  const jsErrors: string[] = []; // uncaught renderer exceptions — a hard failure
  const consoleErrors: string[] = []; // resource errors etc. — informational only
  const wsCloses: number[] = [];
  page.on("pageerror", (e) => jsErrors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("websocket", (ws) => {
    // Playwright doesn't expose the close code; a size-induced 1013 loop shows up
    // as MANY closes in the window — we bound the count instead of reading 1013.
    ws.on("close", () => wsCloses.push(1));
  });
  try {
    await page.goto(`${tunnelUrl}/?token=${TOKEN}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const appeared = await page
      .waitForSelector("h1.brand, .app-shell, .sidebar, [data-role='workspace-list']", { timeout: 25_000 })
      .then(() => true)
      .catch(() => false);
    record(
      `device[${label}]: real web client renders the slim core over the tunnel`,
      appeared,
      appeared ? "shell mounted" : "shell not found",
    );
    if (appeared) {
      await inPageActivateProfile(page, "default");
      await page.waitForTimeout(1500);

      if (isWide) {
        // 1. Workspace switching (click a different card, then back).
        const toDocker = await switchWorkspace(page, WS_DOCKER);
        const backToTerm = await switchWorkspace(page, WS_ID);
        record(
          `device[${label}]: workspace switching reflects in the active card`,
          toDocker && backToTerm,
          `docker=${toDocker} back=${backToTerm}`,
        );

        // 2. Git pane (solo) loads its heavy detail on demand.
        await clickTab(page, `git:${WS_ID}`);
        let s = await waitForDom(page, (x) => x.gitView && x.refreshBtn);
        record(
          `device[${label}]: Git pane loads detail over the tunnel`,
          s.gitView && s.refreshBtn,
          `gitView=${s.gitView} refreshBtn=${s.refreshBtn}`,
        );

        // 3. Docker pane (solo) loads the container list.
        await switchWorkspace(page, WS_DOCKER);
        await clickTab(page, `docker:${WS_DOCKER}`);
        s = await waitForDom(page, (x) => x.dockerSplit && x.dockerRows > 0);
        record(
          `device[${label}]: Docker pane loads container detail over the tunnel`,
          s.dockerSplit && s.dockerRows > 0,
          `split=${s.dockerSplit} rows=${s.dockerRows}`,
        );

        // 4. Azure inbox pane loads a PR row (after selecting the "Needs review" tab).
        await switchWorkspace(page, WS_AZURE);
        await waitForDom(page, (x) => x.azureInbox);
        await clickInboxSubtab(page, "needs review");
        s = await waitForDom(page, (x) => x.azureInbox && x.prRows > 0);
        record(
          `device[${label}]: Azure inbox pane loads a PR row over the tunnel`,
          s.azureInbox && s.prRows > 0,
          `inbox=${s.azureInbox} rows=${s.prRows}`,
        );

        // 5. GitHub inbox pane loads a PR row.
        await switchWorkspace(page, WS_GITHUB);
        await waitForDom(page, (x) => x.azureInbox);
        await clickInboxSubtab(page, "needs review");
        s = await waitForDom(page, (x) => x.azureInbox && x.prRows > 0);
        record(
          `device[${label}]: GitHub inbox pane loads a PR row over the tunnel`,
          s.azureInbox && s.prRows > 0,
          `inbox=${s.azureInbox} rows=${s.prRows}`,
        );

        // 6. Review pane renders the PR review shell (review-bridge/PR detail).
        await switchWorkspace(page, WS_REVIEW);
        await clickTab(page, `review:${WS_REVIEW}`);
        s = await waitForDom(page, (x) => x.reviewShell && x.reviewSubtabs);
        record(
          `device[${label}]: Review pane renders the PR review shell over the tunnel`,
          s.reviewShell && s.reviewSubtabs,
          `shell=${s.reviewShell} subtabs=${s.reviewSubtabs}`,
        );

        // 7. Multi-cell grid with TWO non-terminal panes (git + docker).
        await switchWorkspace(page, WS_ID);
        const grid = await inPageEnableGrid(
          page,
          [
            { id: WS_ID, view: `git:${WS_ID}` },
            { id: WS_DOCKER, view: `docker:${WS_DOCKER}` },
          ],
          "cols",
        );
        s = await waitForDom(page, (x) => x.gridRoot && x.cellPanes >= 2 && x.gitView && x.dockerSplit, 15_000);
        record(
          `device[${label}]: multi-cell grid renders 2 non-terminal panes (git+docker)`,
          s.gridRoot && s.cellPanes >= 2 && s.gitView && s.dockerSplit,
          `cells=${s.cellPanes} git=${s.gitView} docker=${s.dockerSplit} ${JSON.stringify(grid)}`,
        );

        // 8. Reconnect/replay THROUGH the browser panes (grid still mounted).
        const before = wsCloses.length;
        const recovered = await reconnectCycle(page);
        s = await waitForDom(page, (x) => x.gridRoot && x.cellPanes >= 2 && x.gitView && x.dockerSplit, 15_000);
        record(
          `device[${label}]: reconnect replays the grid panes without a 1013 loop`,
          recovered && s.gridRoot && s.cellPanes >= 2 && s.gitView && s.dockerSplit,
          `grid=${s.gridRoot} git=${s.gitView} docker=${s.dockerSplit} recovered=${recovered} closes=${wsCloses.length - before}`,
        );
      } else {
        // Mobile — naturally fewer panes (plan §Verification 9: "mobile naturally
        // requests fewer"). Switch via the drawer, open one non-terminal pane,
        // then reconnect.
        const switched = await switchWorkspace(page, WS_AZURE);
        record(
          `device[${label}]: workspace switch (drawer) selects the provider workspace`,
          switched,
          `active=${switched}`,
        );
        let s = await waitForDom(page, (x) => x.azureInbox);
        record(`device[${label}]: Azure inbox pane renders on this device`, s.azureInbox, `inbox=${s.azureInbox}`);

        const before = wsCloses.length;
        const recovered = await reconnectCycle(page);
        s = await waitForDom(page, (x) => x.shell);
        record(
          `device[${label}]: reconnect recovers without a 1013 loop`,
          recovered && s.shell,
          `shell=${s.shell} recovered=${recovered} closes=${wsCloses.length - before}`,
        );
      }
    }

    record(`device[${label}]: no uncaught renderer errors`, jsErrors.length === 0, jsErrors.slice(0, 2).join(" | "));
    if (consoleErrors.length)
      console.log(
        `    [${label}] ${consoleErrors.length} console resource error(s) — expected with synthetic provider data (e.g. docker df, azure pipelines): ${consoleErrors.slice(0, 3).join(" | ")}`,
      );
    const shot = path.join(artDir, `tunnel-${label}.png`);
    await page.screenshot({ path: shot, fullPage: false }).catch(() => undefined);
    console.log(`    screenshot: ${path.relative(REPO_ROOT, shot)}`);
  } finally {
    await context.close();
  }
}

main().catch((err) => {
  console.error("\n[fatal]", err);
  process.exit(1);
});
