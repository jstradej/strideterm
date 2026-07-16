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
 *      the REAL web client (served from dist/) rendering the slim core over the
 *      tunnel — terminal, wide multi-cell grid, no size-induced 1013 loop, no JS
 *      errors — one screenshot per device profile.
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
import { chromium, devices, type Browser } from "playwright";
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
    browser = await chromium.launch();
    const artDir = path.join(REPO_ROOT, "docs", "remote-smoke-artifacts");
    await mkdir(artDir, { recursive: true });
    const profiles: Array<[string, Record<string, unknown>]> = [
      ["phone", { ...devices["iPhone 13"] }],
      ["tablet", { ...devices["iPad (gen 7)"] }],
      ["wide", { viewport: { width: 1600, height: 950 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false }],
    ];
    for (const [label, device] of profiles) {
      await runDeviceProfile(browser, device, label, tunnelUrl, artDir);
    }
  } finally {
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

async function runDeviceProfile(
  browser: Browser,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  device: any,
  label: string,
  tunnelUrl: string,
  artDir: string,
): Promise<void> {
  const context = await browser.newContext(device);
  const page = await context.newPage();
  const jsErrors: string[] = [];
  const wsCloses: number[] = [];
  page.on("pageerror", (e) => jsErrors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") jsErrors.push(m.text());
  });
  page.on("websocket", (ws) => {
    ws.on("close", () => {
      // Playwright doesn't expose the close code directly; the app logs a 1013
      // reconnect loop as repeated closes — we assert the socket stays healthy
      // by counting closes within the observation window instead.
      wsCloses.push(1);
    });
  });
  try {
    await page.goto(`${tunnelUrl}/?token=${TOKEN}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const appeared = await page
      .waitForSelector("h1.brand, .app-shell, .sidebar, [data-testid='workspace']", { timeout: 25_000 })
      .then(() => true)
      .catch(() => false);
    // Observe for a few seconds to catch a 1013 reconnect loop.
    await page.waitForTimeout(6000);
    const bodyText =
      (await page
        .locator("body")
        .innerText()
        .catch(() => "")) || "";
    const looksConnected = appeared && !/disconnected|reconnect/i.test(bodyText.slice(0, 400));
    record(
      `device[${label}]: real web client renders the slim core over the tunnel`,
      appeared,
      appeared ? "shell mounted" : "shell not found",
    );
    record(
      `device[${label}]: no size-induced 1013 reconnect loop`,
      wsCloses.length <= 2,
      `${wsCloses.length} ws closes in window`,
    );
    record(`device[${label}]: no renderer JS errors`, jsErrors.length === 0, jsErrors.slice(0, 2).join(" | "));
    void looksConnected;
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
