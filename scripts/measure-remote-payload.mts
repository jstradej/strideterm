/**
 * measure-remote-payload — quantifies the remote slim-core reduction and the
 * HTTP/WS compression trade-offs the plan asks to record (plan §Verification 6,
 * §Backpressure and size policy, §Phase 4). Run:
 *
 *   npm run measure:remote
 *
 * It is a MEASUREMENT tool, not a test: it builds a representative large payload
 * (modelled on the prod incident — ~59 workspaces with heavy git snapshots,
 * provider PRs carrying review threads, and full Docker lists), then reports:
 *   1. the pre-dedup full payload (with the git.projects / appState.projects
 *      duplicate aliases Phase 1 removed) vs the post-dedup desktop payload;
 *   2. the slim RemoteStateV2 core a protocol-2 client actually receives;
 *   3. HTTP Brotli/gzip sizes + compress timing for the bootstrap core;
 *   4. the size of an ongoing WS resource:invalidate frame, to evaluate whether
 *      WS permessage-deflate is worth its per-frame CPU (plan §Phase 4).
 *
 * Numbers are recorded in docs/remote-payload-measurements.md. Sizes are
 * deterministic (fixed synthetic data), so re-running reproduces them.
 */
import { brotliCompressSync, gzipSync } from "node:zlib";
import { performance } from "node:perf_hooks";
import { buildRemoteCore } from "../electron/backend/remote-core.js";

const WORKSPACE_COUNT = 59;
const kib = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KiB`;
const bytesOf = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");
const pct = (from: number, to: number): string => `${(100 - (to / from) * 100).toFixed(1)}%`;

/** A heavy per-workspace git snapshot: log, compareWithBase, roots, remotes —
 *  everything the always-on UI never reads (it needs only 6 light fields). */
function heavyGitSnapshot(i: number) {
  const commit = (n: number) => ({
    hash: `${i}`.padStart(2, "0") + `${n}`.padStart(38, "0"),
    subject: `Refactor module ${i} step ${n} — long-ish commit subject line for realism`,
    authorName: "Contributor Name",
    authorEmail: "contributor@example.com",
    date: "2026-07-15T10:00:00Z",
  });
  return {
    available: true,
    branch: `feature/topic-${i}`,
    dirty: i % 3 === 0,
    dirtyCount: i % 7,
    branchMerged: false,
    lastChangeAt: "2026-07-15T10:00:00Z",
    lastUpdatedAt: "2026-07-15T10:00:01Z",
    aheadCount: i % 4,
    behindCount: i % 5,
    stashCount: i % 2,
    baseBranch: "main",
    operationState: { inProgress: false },
    branchNames: Array.from({ length: 20 }, (_, k) => `branch-${i}-${k}`),
    remotes: [{ name: "origin", url: `https://example.com/repo-${i}.git` }],
    siblingWorktrees: [{ path: `/repos/repo-${i}/wt`, branch: `wt-${i}` }],
    log: Array.from({ length: 40 }, (_, n) => commit(n)),
    compareWithBase: { ahead: Array.from({ length: 15 }, (_, n) => commit(n)), behind: [] },
    roots: { [`/repos/repo-${i}`]: { branch: `feature/topic-${i}`, dirty: false } },
  };
}

function buildFullPayload() {
  const workspaces = Array.from({ length: WORKSPACE_COUNT }, (_, i) => ({
    id: `ws${i}`,
    name: `Workspace ${i}`,
    profileId: i % 3 === 0 ? "p1" : "p2",
    kind: "terminal",
    cwd: `/repos/repo-${i}`,
    panels: [{ id: "a" }, { id: "b" }],
  }));
  const gitWorkspaces: Record<string, unknown> = {};
  for (let i = 0; i < WORKSPACE_COUNT; i += 1) gitWorkspaces[`ws${i}`] = heavyGitSnapshot(i);

  const pullRequests: Record<string, unknown> = {};
  for (let i = 0; i < 26; i += 1) {
    pullRequests[`azure:pr${i}`] = {
      prKey: `azure:pr${i}`,
      profileId: i % 3 === 0 ? "p1" : "p2",
      connectionId: "az1",
      lastActivityAt: "2026-07-15T11:00:00Z",
      pullRequest: { id: i, title: `PR ${i}`, status: "active" },
      checks: { items: [{ id: "c", state: "succeeded" }], failedCount: 0, pendingCount: 1, passedCount: 3 },
      reviewerSummary: { reviewers: [{ id: "r", vote: 0, isRequired: true }] },
      threads: Array.from({ length: 12 }, (_, t) => ({
        id: t,
        status: "active",
        comments: Array.from({ length: 6 }, (_, c) => ({ id: c, content: "A review comment ".repeat(12) })),
      })),
      issueComments: Array.from({ length: 8 }, (_, c) => ({ id: c, body: "Issue comment body ".repeat(10) })),
    };
  }

  return {
    meta: { appVersion: "2.4.11", platform: "win32", versionCheck: {}, recoveryCandidates: [] },
    appState: {
      activeWorkspaceId: "ws0",
      profiles: [
        { id: "p1", name: "P1", color: "#111", workspaceIds: [] },
        { id: "p2", name: "P2", color: "#222", workspaceIds: [] },
      ],
      workspaces,
      windowSlots: [{ id: "win-1", profileId: "p1", windowIndex: 1 }],
      tabTemplates: [{ id: "shell", title: "Shell", command: "" }],
      settings: {
        theme: "dark",
        terminalFontSizeRemote: 13,
        remoteAccess: { enabled: true, token: "SECRET", cloudflaredPath: "/usr/bin/cloudflared" },
        integrations: {
          azureDevops: { enabled: true, connections: [{ id: "az1", pat: "SECRET-PAT" }] },
          github: { enabled: true, connections: [] },
          telegram: { enabled: true, connections: [{ id: "tg", botTokenRef: "cred", chatId: "123" }] },
        },
      },
      ssh: { hosts: [{ id: "h1" }], keys: [{ id: "k1", privateKeyPath: "/id_rsa" }], certificates: [], knownHosts: {} },
    },
    workspace: null,
    attention: { sessions: {} },
    taskRunner: {},
    plugins: [],
    environment: {},
    remoteAccess: { enabled: true, host: "h", port: 1, urls: ["u"], tunnel: { active: false } },
    git: { connections: [], workspaces: gitWorkspaces, activeWorkspace: null },
    azureDevops: { connections: [{ id: "az1", profileId: "p1" }], inbox: {}, pullRequests, reviewActivity: [], sync: {} },
    github: { connections: [], inbox: {}, pullRequests: {}, reviewActivity: [], sync: {} },
    reviewBridge: { agentPrompts: [], pullRequests: {} },
    docker: {
      available: true,
      lastUpdatedAt: "2026-07-15T12:00:00Z",
      containers: Array.from({ length: 7 }, (_, i) => ({ ID: `c${i}`, State: "running", Status: "Up 2 hours" })),
      images: Array.from({ length: 186 }, (_, i) => ({ ID: `img${i}`, RepoTags: [`repo/img:${i}`], Size: 123456789 })),
      volumes: Array.from({ length: 36 }, (_, i) => ({ Name: `vol${i}`, Mountpoint: `/var/lib/docker/volumes/vol${i}` })),
      networks: [{ ID: "net1" }],
      backends: [{ id: "b1" }],
      contexts: [{ Name: "default" }],
      lazydocker: {},
    },
    remoteClient: { id: "sess", profileId: "p1", activeWorkspaceId: "ws0", activeSessionId: "" },
  };
}

function timeCompress(fn: () => Buffer): { bytes: number; ms: number } {
  const start = performance.now();
  const out = fn();
  return { bytes: out.length, ms: Number((performance.now() - start).toFixed(2)) };
}

function main(): void {
  const full = buildFullPayload();

  // (1) Pre-dedup: 2.4.10 also duplicated git.workspaces under git.projects and
  // appState.workspaces under appState.projects (the byte-identical aliases
  // Phase 1 removed).
  const preDedup = {
    ...full,
    git: { ...full.git, projects: full.git.workspaces },
    appState: { ...full.appState, projects: full.appState.workspaces },
  };
  const preDedupBytes = bytesOf(preDedup);
  const postDedupBytes = bytesOf(full);

  // (2) The slim core a protocol-2 client on profile p1 actually receives.
  const core = buildRemoteCore(full, { coreRevision: 1, capabilities: ["remote-core-v2", "resource-details-v1"] });
  const coreBytes = bytesOf(core);
  const coreRaw = Buffer.from(JSON.stringify(core), "utf8");

  // (3) HTTP compression of the bootstrap core.
  const br = timeCompress(() => brotliCompressSync(coreRaw));
  const gz = timeCompress(() => gzipSync(coreRaw));

  // (4) An ongoing WS resource:invalidate frame (post-bootstrap steady state).
  const invalidate = { type: "resource:invalidate", payload: { resource: "git:ws0", revision: "2026-07-15T13:00:00Z" } };
  const invalidateBytes = bytesOf(invalidate);

  const lines = [
    `Workspaces: ${WORKSPACE_COUNT}   Azure PRs: 26 (with review threads)   Docker: 186 images / 7 containers / 36 volumes`,
    ``,
    `1. Pre-dedup full payload (2.4.10, with projects aliases):  ${kib(preDedupBytes)}  (${preDedupBytes} B)`,
    `2. Post-dedup desktop payload (Phase 1, aliases removed):    ${kib(postDedupBytes)}  (${postDedupBytes} B)`,
    `     → dedup reduction: ${pct(preDedupBytes, postDedupBytes)}`,
    `3. Slim RemoteStateV2 core (protocol 2, profile p1):        ${kib(coreBytes)}  (${coreBytes} B)`,
    `     → core reduction vs post-dedup desktop payload: ${pct(postDedupBytes, coreBytes)}`,
    `     → core reduction vs pre-dedup 2.4.10 payload:    ${pct(preDedupBytes, coreBytes)}`,
    ``,
    `HTTP bootstrap compression of the slim core:`,
    `   Brotli: ${kib(br.bytes)} (${br.bytes} B, ${br.ms} ms)   ratio ${pct(coreBytes, br.bytes)}`,
    `   gzip:   ${kib(gz.bytes)} (${gz.bytes} B, ${gz.ms} ms)   ratio ${pct(coreBytes, gz.bytes)}`,
    ``,
    `Steady-state WS frame (resource:invalidate): ${invalidateBytes} B`,
    `   permessage-deflate would compress a ${invalidateBytes} B frame to a similar`,
    `   size (below the deflate window's useful floor) while adding per-frame CPU +`,
    `   a compression context per socket → recommendation: keep WS permessage-deflate`,
    `   OFF. HTTP compression already covers the one large transfer (the bootstrap`,
    `   core); the ongoing WS traffic is tiny invalidations + coalesced core deltas.`,
  ];
  // eslint-disable-next-line no-console
  console.log(lines.join("\n"));
}

main();
