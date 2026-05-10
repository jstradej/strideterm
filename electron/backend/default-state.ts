/// <reference types="node" />
import os from "node:os";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { APP_CONFIG } from "../../config/app-config.js";
import type {
  AppState,
  WorkspaceState,
  Profile,
  TabTemplate,
  WorkspaceGridState,
  WorkspaceGridLayout,
  WindowSlot,
} from "../shared/types/state.js";

const UTF8_DECODER = (() => {
  try {
    return new TextDecoder("utf-8", { fatal: true });
  } catch {
    return null;
  }
})();

const WINDOWS_1250_ENCODER_MAP = (() => {
  try {
    const decoder = new TextDecoder("windows-1250");
    const bytes = Uint8Array.from({ length: 256 }, (_value, index) => index);
    const decoded = decoder.decode(bytes);
    const map = new Map<string, number>();
    for (let index = 0; index < decoded.length; index += 1) {
      if (!map.has(decoded[index])) {
        map.set(decoded[index], index);
      }
    }
    return map;
  } catch {
    return null;
  }
})();

const MOJIBAKE_MARKER_RE = /[ĂÂÄÅĹâđź]/u;

function defaultCwd(): string {
  return os.homedir();
}

/**
 * Returns the strIDEterm user-data directory, honoring the STRIDETERM_DATA_DIR
 * env var used by dev.ps1 and --data-dir. Centralized here so every module
 * that falls back to a "default" path under strIDEterm's data dir picks up the
 * override consistently — otherwise dev instances bleed into ~/.strideterm.
 */
export function strideDataDir(): string {
  return process.env.STRIDETERM_DATA_DIR
    ? path.resolve(process.env.STRIDETERM_DATA_DIR)
    : path.join(os.homedir(), ".strideterm");
}

function defaultAzureReviewRoot(): string {
  return path.join(strideDataDir(), "azure-pr");
}

function defaultGitHubReviewRoot(): string {
  return path.join(strideDataDir(), "github-pr");
}

export function createAccessToken(): string {
  // 32 bytes = 256 bits of entropy. The remote-access token guards an
  // HTTP/WS surface that exposes terminal sessions, file CRUD and git
  // operations to the LAN / Cloudflare tunnel — at this blast radius
  // we want the OAuth-grade 256-bit standard, not the previous 144 bits.
  return randomBytes(32).toString("base64url");
}

function decodeUtf8Mojibake(value: string): string {
  if (!value || !UTF8_DECODER || !WINDOWS_1250_ENCODER_MAP || !MOJIBAKE_MARKER_RE.test(value)) {
    return value;
  }

  const bytes = [];
  for (const character of value) {
    const nextByte = WINDOWS_1250_ENCODER_MAP.get(character);
    if (nextByte == null) {
      return value;
    }
    bytes.push(nextByte);
  }

  try {
    return UTF8_DECODER.decode(Uint8Array.from(bytes));
  } catch {
    return value;
  }
}

function repairVisibleText(value: unknown, fallback = ""): string {
  let current = String(value ?? fallback);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const repaired = decodeUtf8Mojibake(current);
    if (repaired === current) {
      break;
    }
    current = repaired;
  }
  return current;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeLaunch(launch: any): Record<string, unknown> | null {
  if (!launch) return null;
  // SSH launch: carries either a reference to a saved host or an inline ad-hoc
  // definition. We preserve both shapes faithfully so the panel survives
  // reload. Private material is NEVER stored here — only refs into the
  // credential store.
  if (launch.kind === "ssh") {
    const normalized: Record<string, unknown> = { kind: "ssh" };
    if (launch.sshHostId) normalized.sshHostId = String(launch.sshHostId);
    if (launch.sshInline && typeof launch.sshInline === "object") {
      const inline = launch.sshInline;
      const auth = inline.auth || {};
      normalized.sshInline = {
        host: String(inline.host || ""),
        port: Number(inline.port) > 0 ? Number(inline.port) : 22,
        username: String(inline.username || ""),
        hostKeyPolicy: ["strict", "warn", "accept-new"].includes(inline.hostKeyPolicy) ? inline.hostKeyPolicy : "warn",
        auth: {
          methods: Array.isArray(auth.methods) && auth.methods.length ? [...auth.methods] : ["publickey"],
          keyRef: auth.keyRef || "",
          certRef: auth.certRef || "",
          passwordRef: auth.passwordRef || "",
          passphraseRef: auth.passphraseRef || "",
          agent: ["auto", "socket", "pageant", "pipe", "off"].includes(auth.agent) ? auth.agent : "auto",
        },
        advanced: {
          launchVia: ["ssh2", "system-ssh", "wsl"].includes(inline.advanced?.launchVia)
            ? inline.advanced.launchVia
            : "ssh2",
          command: inline.advanced?.command || "",
          agentForward: Boolean(inline.advanced?.agentForward),
        },
      };
    }
    return normalized;
  }
  // Classic PTY launch (file + args).
  return {
    file: launch.file || "",
    args: [...(launch.args || [])],
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizePanel(panel: any, panelIndex = 0): any {
  return {
    id: panel.id || `panel-${panelIndex + 1}`,
    title: repairVisibleText(panel.title || `Panel ${panelIndex + 1}`),
    command: panel.command || "",
    launch: normalizeLaunch(panel.launch),
    shell: panel.shell !== false,
    startup: panel.startup || (panelIndex === 0 ? APP_CONFIG.ui.defaultPanelStartup : APP_CONFIG.ui.manualPanelStartup),
    cwd: panel.cwd || "",
    alertsForceOn: panel.alertsForceOn === true,
  };
}

const KNOWN_VIEW_PREFIXES = [
  "git:",
  "docker:",
  "azure:",
  "github:",
  "review:",
  "files:",
  "browser:",
  "task-dashboard:",
];
const VALID_SPLIT_LAYOUTS = new Set(["cols", "rows", "top-split", "left-split", "grid"]);

function isKnownPrefixViewId(viewId: unknown): boolean {
  return typeof viewId === "string" && KNOWN_VIEW_PREFIXES.some((prefix) => viewId.startsWith(prefix));
}

function isValidWorkspaceViewId(viewId: unknown, workspaceId: string, panels: Array<{ id: string }>): boolean {
  if (typeof viewId !== "string" || !viewId) return false;
  if (isKnownPrefixViewId(viewId)) return true;
  const sessionPrefix = `${workspaceId}:`;
  if (!viewId.startsWith(sessionPrefix)) return false;
  const panelId = viewId.slice(sessionPrefix.length);
  return panels.some((panel) => panel.id === panelId);
}

function panelViewId(panel: { id: string; command?: string } | null | undefined, workspaceId: string): string | null {
  if (!panel) return null;
  if (panel.command === "__task-dashboard__") return `task-dashboard:${panel.id}`;
  if (panel.command === "__files__") return `files:${panel.id}`;
  if (/^https?:\/\//i.test(panel.command || "")) return `browser:${panel.id}`;
  return `${workspaceId}:${panel.id}`;
}

// Rewrites a session-style viewId (`${workspaceId}:${panelId}`) to its canonical
// form when it points to a non-terminal panel (dashboard/files/browser). Older
// state files persisted the session-style id for dashboard panels, which then
// failed to match splitGroup.viewIds and collapsed the layout to solo.
function canonicalizeViewId(
  viewId: string,
  workspaceId: string,
  panels: Array<{ id: string; command?: string }>,
): string {
  if (typeof viewId !== "string" || !viewId) return viewId;
  if (isKnownPrefixViewId(viewId)) return viewId;
  const sessionPrefix = `${workspaceId}:`;
  if (!viewId.startsWith(sessionPrefix)) return viewId;
  const panelId = viewId.slice(sessionPrefix.length);
  const panel = panels.find((p) => p.id === panelId);
  if (!panel) return viewId;
  return panelViewId(panel, workspaceId) ?? viewId;
}

function normalizeWorkspaceUIState(
  workspace: any, // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: legacy raw state JSON, typed migration pending
  workspaceId: string,
  panels: Array<{ id: string; command?: string }>,
  activePanelId: string | null,
): {
  activeViewId: string | null;
  splitLayout: string | null;
  splitViewIds: string[];
  activeRootPath: string;
} {
  const activePanel = activePanelId ? panels.find((p) => p.id === activePanelId) : null;
  const fallbackViewId = panelViewId(activePanel, workspaceId);
  const rawViewId = typeof workspace.activeViewId === "string" ? workspace.activeViewId : "";
  const canonicalRaw = canonicalizeViewId(rawViewId, workspaceId, panels);
  const activeViewId = isValidWorkspaceViewId(canonicalRaw, workspaceId, panels) ? canonicalRaw : fallbackViewId;

  const rawLayout = workspace.splitLayout;
  const rawSplitIds: string[] = Array.isArray(workspace.splitViewIds) ? (workspace.splitViewIds as string[]) : [];
  const canonicalSplitIds = rawSplitIds
    .map((id) => canonicalizeViewId(id, workspaceId, panels))
    .filter((id) => isValidWorkspaceViewId(id, workspaceId, panels));
  if (!VALID_SPLIT_LAYOUTS.has(rawLayout) || canonicalSplitIds.length < 2) {
    return { activeViewId, splitLayout: null, splitViewIds: [], activeRootPath: workspace.activeRootPath || "" };
  }
  return {
    activeViewId,
    splitLayout: rawLayout,
    splitViewIds: canonicalSplitIds,
    activeRootPath: workspace.activeRootPath || "",
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function normalizeWorkspace(workspace: any, index = 0): WorkspaceState {
  const isDockerWorkspace = (workspace.id || "") === "docker" || workspace.kind === "docker";
  const isAzureWorkspace = workspace.kind === "azure";
  const isGitHubWorkspace = workspace.kind === "github";
  const isTaskWorkspace = workspace.kind === "task";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawPanels: any[] = isDockerWorkspace
    ? (workspace.panels || []).filter(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (panel: any) => !(panel.id === "lazydocker" && panel.command === "lazydocker" && !panel.launch),
      )
    : // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (workspace.panels || []).filter((panel: any) => !(panel.id === "git" && !panel.command && !panel.launch));
  const panels = rawPanels.map((panel, panelIndex) => normalizePanel(panel, panelIndex));
  const fallbackPanelId = panels[0]?.id || null;
  const activePanelId = panels.some((panel) => panel.id === workspace.activePanelId)
    ? workspace.activePanelId
    : fallbackPanelId;
  const workspaceId = workspace.id || `workspace-${index + 1}`;
  const { activeViewId, splitLayout, splitViewIds, activeRootPath } = normalizeWorkspaceUIState(
    workspace,
    workspaceId,
    panels,
    activePanelId,
  );

  return {
    id: workspaceId,
    name: repairVisibleText(workspace.name || `Workspace ${index + 1}`),
    icon: repairVisibleText(workspace.icon || APP_CONFIG.ui.defaultProjectIcon),
    color: workspace.color || APP_CONFIG.ui.defaultProjectColor,
    kind: isDockerWorkspace
      ? "docker"
      : isAzureWorkspace
        ? "azure"
        : isGitHubWorkspace
          ? "github"
          : isTaskWorkspace
            ? "task"
            : workspace.kind || APP_CONFIG.ui.defaultProjectKind,
    source: workspace.source === "plugin" ? "plugin" : "manual",
    pluginId: workspace.pluginId || "",
    cwd: workspace.cwd || (isAzureWorkspace || isGitHubWorkspace ? "" : defaultCwd()),
    gitRoots: (function () {
      // Don't allow gitRoots on review workspaces or task workspaces that run in a worktree
      if (isAzureWorkspace || isGitHubWorkspace) return [];
      if (isTaskWorkspace && workspace.task?.worktreeBranch) return [];
      const roots: unknown[] = Array.isArray(workspace.gitRoots)
        ? (workspace.gitRoots as unknown[]).filter(Boolean)
        : [];
      return roots
        .map((r) => String(r).replace(/\\/g, "/").replace(/\/+$/, ""))
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "accent" }));
    })(),
    activeRootPath: activeRootPath || "",
    notes: repairVisibleText(workspace.notes || ""),
    profileId: workspace.profileId || "default",
    connectionId: workspace.connectionId || workspace.quickfix?.connectionId || workspace.review?.connectionId || "",
    activePanelId,
    activeViewId,
    splitLayout,
    splitViewIds,
    panels,
    review: workspace.review
      ? {
          provider: workspace.review.provider || "",
          prKey: workspace.review.prKey || "",
          connectionId: workspace.review.connectionId || "",
          orgUrl: workspace.review.orgUrl || "",
          parentWorkspaceId: workspace.review.parentWorkspaceId || "",
          project: workspace.review.project
            ? {
                id: workspace.review.project.id || "",
                name: workspace.review.project.name || "",
              }
            : null,
          repository: workspace.review.repository
            ? {
                id: workspace.review.repository.id || "",
                name: workspace.review.repository.name || "",
                remoteUrl: workspace.review.repository.remoteUrl || "",
              }
            : null,
          pullRequest: workspace.review.pullRequest
            ? {
                id: workspace.review.pullRequest.id || workspace.review.pullRequest.number || 0,
                number: workspace.review.pullRequest.number || workspace.review.pullRequest.id || 0,
                title: workspace.review.pullRequest.title || "",
                status: workspace.review.pullRequest.status || workspace.review.pullRequest.state || "",
                mergeStatus:
                  workspace.review.pullRequest.mergeStatus || workspace.review.pullRequest.mergeableState || "",
                url: workspace.review.pullRequest.url || "",
                webUrl: workspace.review.pullRequest.webUrl || "",
                sourceRefName:
                  workspace.review.pullRequest.sourceRefName || workspace.review.pullRequest.sourceBranch || "",
                targetRefName:
                  workspace.review.pullRequest.targetRefName || workspace.review.pullRequest.targetBranch || "",
              }
            : null,
          role: workspace.review.role || "",
          checkout: workspace.review.checkout
            ? {
                mode: workspace.review.checkout.mode || "",
                rootPath: workspace.review.checkout.rootPath || "",
                cacheRepoPath: workspace.review.checkout.cacheRepoPath || "",
              }
            : null,
        }
      : null,
    quickfix: workspace.quickfix
      ? {
          connectionId: workspace.quickfix.connectionId || "",
          projectName: workspace.quickfix.projectName || "",
          repositoryId: workspace.quickfix.repositoryId || "",
          repositoryName: workspace.quickfix.repositoryName || "",
          remoteUrl: workspace.quickfix.remoteUrl || "",
          baseBranch: workspace.quickfix.baseBranch || "",
          parentWorkspaceId: workspace.quickfix.parentWorkspaceId || "",
        }
      : null,
    starred: Boolean(workspace.starred),
    task: workspace.task
      ? {
          // Spread first: preserves runtime-only properties (promptSent,
          // pausedFromState, showerResumePrompt, etc.) that the task runner
          // sets directly on the object during execution.  Without this,
          // store.mutate() → normalizeState would strip them, causing bugs
          // like duplicate prompt injection on workspace switch.
          ...workspace.task,
          // Normalize/default all persisted properties (overrides spread)
          taskId: workspace.task.taskId || "",
          description: workspace.task.description || "",
          parentWorkspaceId: workspace.task.parentWorkspaceId || "",
          worktreeBase: workspace.task.worktreeBase || "",
          worktreeBranch: workspace.task.worktreeBranch || "",
          workerPanelId: workspace.task.workerPanelId || "",
          judgePanelId: workspace.task.judgePanelId || "",
          maxRounds: workspace.task.maxRounds || 10,
          showerInterval: workspace.task.showerInterval ?? 5,
          state: workspace.task.state || "idle",
          currentRound: workspace.task.currentRound || 0,
          rounds: Array.isArray(workspace.task.rounds) ? workspace.task.rounds : [],
          lastShowerRound: workspace.task.lastShowerRound || 0,
          lastJudgeInstructions: workspace.task.lastJudgeInstructions || "",
          // Provider configs — migrated from panel command strings if absent
          workerProviderConfig: workspace.task.workerProviderConfig || null,
          judgeProviderConfig: workspace.task.judgeProviderConfig || null,
          // Defaults for runtime-only properties (needed when loading from disk
          // where these don't exist; during runtime the spread above preserves them)
          promptSent: workspace.task.promptSent ?? false,
          pausedFromState: workspace.task.pausedFromState ?? "",
          showerResumePrompt: workspace.task.showerResumePrompt ?? "",
          startedAt: workspace.task.startedAt || null,
          totalPausedMs: workspace.task.totalPausedMs || 0,
          pausedAt: workspace.task.pausedAt || null,
          finishedAt: workspace.task.finishedAt || null,
          rateLimitedUntil: workspace.task.rateLimitedUntil || null,
        }
      : null,
  };
}

export function createDefaultState(): AppState & { activeProjectId: string; projects: WorkspaceState[] } {
  const state = {
    activeWorkspaceId: "",
    activeProfileId: "default",
    settings: {
      theme: APP_CONFIG.ui.defaultTheme,
      sidebarWidth: APP_CONFIG.ui.sidebarWidth,
      sidebarCollapsed: APP_CONFIG.ui.sidebarCollapsed,
      logLevel: APP_CONFIG.logging.level as "error" | "warn" | "info" | "debug" | "trace",
      notifications: {
        promptQuietMs: APP_CONFIG.notifications.promptQuietMs,
        agentQuietMs: APP_CONFIG.notifications.agentQuietMs,
        agentQuietFastMs: APP_CONFIG.notifications.agentQuietFastMs,
        alertCooldownMs: APP_CONFIG.notifications.alertCooldownMs,
        userInteractionGraceMs: APP_CONFIG.notifications.userInteractionGraceMs,
        shellIntegration: APP_CONFIG.notifications.shellIntegration,
        agentHook: APP_CONFIG.notifications.agentHook,
        debug: APP_CONFIG.notifications.debug,
        agentsOnly: APP_CONFIG.notifications.agentsOnly,
      },
      remoteAccess: {
        enabled: APP_CONFIG.remoteAccess.enabled,
        host: APP_CONFIG.remoteAccess.host,
        port: APP_CONFIG.remoteAccess.port,
        token: createAccessToken(),
        customPublicUrl: "",
        cloudflaredPath: "",
      },
      taskDefaults: {
        workerProvider: { providerId: "claude", model: "sonnet" },
        judgeProvider: { providerId: "claude", model: "opus" },
      },
      integrations: {
        azureDevops: {
          enabled: true,
          reviewRoot: defaultAzureReviewRoot(),
          defaultPollSeconds: 120,
          connections: [],
        },
        github: {
          enabled: true,
          reviewRoot: defaultGitHubReviewRoot(),
          defaultPollSeconds: 120,
          connections: [],
        },
        telegram: {
          enabled: true,
          defaultPollSeconds: 5,
          connections: [],
        },
      },
      git: {
        ui: {
          showAllActions: false,
        },
      },
      externalPathOpener: {
        mode: "system" as const,
        command: "",
      },
    },
    tabTemplates: [
      { id: "shell", title: "Shell", command: "", icon: "\u{1F4BB}" },
      { id: "powershell", title: "PowerShell", command: "powershell", icon: "\u{1F537}", platforms: ["win32"] },
      { id: "pwsh", title: "PowerShell 7", command: "pwsh", icon: "⚡", platforms: ["win32"] },
      { id: "git-bash", title: "Git Bash", command: "bash --login -i", icon: "\u{1F333}", platforms: ["win32"] },
      { id: "wsl", title: "WSL", command: "wsl", icon: "\u{1F427}", platforms: ["win32"] },
      { id: "bash", title: "Bash", command: "bash", icon: "\u{1F41A}", platforms: ["darwin", "linux"] },
      { id: "zsh", title: "Zsh", command: "zsh", icon: "\u{1F41A}", platforms: ["darwin", "linux"] },
      { id: "fish", title: "Fish", command: "fish", icon: "\u{1F420}", platforms: ["darwin", "linux"] },
      { id: "claude", title: "Claude Code", command: "claude", icon: "\u{1F916}" },
      { id: "codex", title: "Codex", command: "codex", icon: "\u{1F9E0}" },
      { id: "gemini", title: "Gemini CLI", command: "gemini", icon: "\u2728" },
      { id: "copilot", title: "GitHub Copilot", command: "copilot", icon: "\u{1F419}" },
      { id: "opencode", title: "OpenCode", command: "opencode", icon: "\u{1F9EC}" },
      { id: "devserver", title: "Dev Server", command: "npm run dev", icon: "\u{1F680}" },
      { id: "tests", title: "Tests", command: "npm test", icon: "\u{1F9EA}" },
      { id: "docker", title: "Docker Compose", command: "docker compose up", icon: "\u{1F433}" },
      { id: "lazygit", title: "Lazygit", command: "lazygit", icon: "\u{1F500}" },
      { id: "browser", title: "Browser", command: "https://", icon: "\u{1F310}" },
      { id: "files", title: "Files", command: "__files__", icon: "\u{1F4C2}" },
    ],
    profiles: [{ id: "default", name: "Default", color: "#ffa424", workspaceIds: [] as string[] }],
    workspaces: [] as WorkspaceState[],
    windowSlots: [] as WindowSlot[],
    ssh: {
      hosts: [],
      keys: [],
      certificates: [],
      knownHosts: {},
      settings: {
        defaultAgentMode: "auto",
        importedSshConfig: false,
      },
    },
  };

  return {
    ...state,
    activeProjectId: state.activeWorkspaceId,
    profiles: state.profiles.map((profile) => ({
      ...profile,
      projectIds: [...profile.workspaceIds],
    })),
    projects: state.workspaces,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeProfiles(rawProfiles: any, defaults: { profiles: Profile[] }): Profile[] {
  return Array.isArray(rawProfiles) && rawProfiles.length
    ? rawProfiles.map((profile: Record<string, unknown>) => ({
        id: String(profile.id || `profile-${Date.now()}`),
        name: String(profile.name || "Unnamed"),
        color: String(profile.color || "#ffa424"),
        workspaceIds: Array.isArray(profile.workspaceIds)
          ? (profile.workspaceIds as string[])
          : Array.isArray(profile.projectIds)
            ? (profile.projectIds as string[])
            : [],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        workspaceGrid: (profile.workspaceGrid as any) ?? null,
      }))
    : defaults.profiles;
}

const DEFAULT_BOUNDS = { x: 100, y: 100, width: 1280, height: 800 };

/**
 * Normalise windowSlots:
 * - Ensure no two slots share the same profileId (drop duplicates, log warn).
 * - Fill missing fields with defaults.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeWindowSlots(rawSlots: any, profiles: Profile[], activeProfileId: string, activeWorkspaceId: string): WindowSlot[] {
  if (!Array.isArray(rawSlots) || rawSlots.length === 0) {
    // Migration: create one slot from the current global state
    return [{
      id: randomUUID(),
      profileId: activeProfileId,
      activeWorkspaceId,
      activeSessionId: "",
      bounds: { ...DEFAULT_BOUNDS },
      lastFocusedAt: Date.now(),
    }];
  }

  const seen = new Set<string>();
  const result: WindowSlot[] = [];
  for (const raw of rawSlots as Record<string, unknown>[]) {
    const profileId = String(raw.profileId || activeProfileId);
    if (seen.has(profileId)) {
      console.warn("[default-state] duplicate profileId in windowSlots, dropping", { profileId });
      continue;
    }
    if (!profiles.some((p) => p.id === profileId)) {
      console.warn("[default-state] windowSlot references unknown profile, dropping", { profileId });
      continue;
    }
    seen.add(profileId);
    result.push({
      id: String(raw.id || randomUUID()),
      profileId,
      activeWorkspaceId: String(raw.activeWorkspaceId || ""),
      activeSessionId: String(raw.activeSessionId || ""),
      bounds: raw.bounds && typeof raw.bounds === "object"
        ? {
            x: Number((raw.bounds as Record<string, unknown>).x) || DEFAULT_BOUNDS.x,
            y: Number((raw.bounds as Record<string, unknown>).y) || DEFAULT_BOUNDS.y,
            width: Number((raw.bounds as Record<string, unknown>).width) || DEFAULT_BOUNDS.width,
            height: Number((raw.bounds as Record<string, unknown>).height) || DEFAULT_BOUNDS.height,
          }
        : { ...DEFAULT_BOUNDS },
      displayId: typeof raw.displayId === "number" ? raw.displayId : undefined,
      isMaximized: Boolean(raw.isMaximized),
      lastFocusedAt: typeof raw.lastFocusedAt === "number" ? raw.lastFocusedAt : Date.now(),
    });
  }

  if (result.length === 0) {
    return [{
      id: randomUUID(),
      profileId: activeProfileId,
      activeWorkspaceId,
      activeSessionId: "",
      bounds: { ...DEFAULT_BOUNDS },
      lastFocusedAt: Date.now(),
    }];
  }

  return result;
}

/**
 * Ensure child workspaces are positioned right after their parent workspace.
 */
function groupChildWorkspaces(workspaces: WorkspaceState[]): WorkspaceState[] {
  const byId = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
  const children = new Map<string, WorkspaceState[]>(); // parentId -> [child workspaces]
  const roots: WorkspaceState[] = [];

  // Index workspaces by cwd for fast parent lookup via directory path.
  // When multiple workspaces share the same cwd, prefer a same-profile match,
  // so build a Map<cwd, workspace[]> and resolve per-child below.
  const byCwd = new Map<string, WorkspaceState[]>();
  for (const workspace of workspaces) {
    if (!workspace.cwd) continue;
    const norm = workspace.cwd.replace(/\\/g, "/").replace(/\/+$/, "");
    if (!byCwd.has(norm)) byCwd.set(norm, []);
    byCwd.get(norm)!.push(workspace);
  }

  // Also index each workspace's gitRoots so worktree children of multi-repo parents can find their parent
  for (const workspace of workspaces) {
    if (!Array.isArray(workspace.gitRoots)) continue;
    for (const root of workspace.gitRoots) {
      if (!root) continue;
      const norm = root.replace(/\\/g, "/").replace(/\/+$/, "");
      if (!byCwd.has(norm)) byCwd.set(norm, []);
      const entry = byCwd.get(norm)!;
      if (!entry.includes(workspace)) entry.push(workspace);
    }
  }

  function findParentByCwd(workspace: WorkspaceState): WorkspaceState | null {
    const cwd = (workspace.cwd || "").replace(/\\/g, "/").replace(/\/+$/, "");
    const marker = "/.strideterm/tree/";
    const idx = cwd.lastIndexOf(marker);
    if (idx < 0) return null;
    const parentCwd = cwd.slice(0, idx);
    const candidates = byCwd.get(parentCwd);
    if (!candidates) return null;
    const childProfile = workspace.profileId || "default";
    // Exclude task workspaces and other worktree children — only real root workspaces can be parents.
    const isEligibleParent = (c: WorkspaceState) =>
      c.id !== workspace.id && c.kind !== "task" && !(c.notes || "").startsWith("Worktree of ");
    return (
      candidates.find((c) => isEligibleParent(c) && (c.profileId || "default") === childProfile) ||
      candidates.find((c) => isEligibleParent(c)) ||
      null
    );
  }

  function addChild(parentId: string, workspace: WorkspaceState): void {
    if (!parentId) {
      roots.push(workspace);
      return;
    }
    if (!children.has(parentId)) {
      children.set(parentId, []);
    }
    children.get(parentId)!.push(workspace);
  }

  for (const workspace of workspaces) {
    if ((workspace.notes || "").startsWith("Worktree of ")) {
      const parentName = workspace.name.split(" / ")[0];
      const childProfile = workspace.profileId || "default";
      const parent =
        findParentByCwd(workspace) ||
        workspaces.find(
          (candidate) =>
            candidate.name === parentName &&
            candidate.id !== workspace.id &&
            (candidate.profileId || "default") === childProfile,
        ) ||
        workspaces.find((candidate) => candidate.name === parentName && candidate.id !== workspace.id) ||
        null;
      addChild(parent?.id || "", workspace);
      continue;
    }

    if (workspace.review?.provider === "azure-devops" && workspace.review?.checkout?.mode === "managed-worktree") {
      const explicitParent =
        workspace.review.parentWorkspaceId && byId.has(workspace.review.parentWorkspaceId)
          ? workspace.review.parentWorkspaceId
          : "";
      const fallbackParent =
        explicitParent ||
        workspaces.find(
          (candidate) =>
            candidate.kind === "azure" &&
            candidate.id !== workspace.id &&
            (candidate.profileId || "default") === (workspace.profileId || "default"),
        )?.id ||
        "";
      addChild(fallbackParent, workspace);
      continue;
    }

    if (workspace.review?.provider === "github" && workspace.review?.checkout?.mode === "managed-worktree") {
      const explicitParent =
        workspace.review.parentWorkspaceId && byId.has(workspace.review.parentWorkspaceId)
          ? workspace.review.parentWorkspaceId
          : "";
      const fallbackParent =
        explicitParent ||
        workspaces.find(
          (candidate) =>
            candidate.kind === "github" &&
            candidate.id !== workspace.id &&
            (candidate.profileId || "default") === (workspace.profileId || "default"),
        )?.id ||
        "";
      addChild(fallbackParent, workspace);
      continue;
    }

    if (workspace.quickfix?.parentWorkspaceId) {
      const parentId = byId.has(workspace.quickfix.parentWorkspaceId)
        ? workspace.quickfix.parentWorkspaceId
        : workspaces.find(
            (candidate) =>
              candidate.kind === "azure" &&
              candidate.id !== workspace.id &&
              (candidate.profileId || "default") === (workspace.profileId || "default"),
          )?.id || "";
      addChild(parentId, workspace);
      continue;
    }

    if (workspace.task?.parentWorkspaceId) {
      const parentId = byId.has(workspace.task.parentWorkspaceId) ? workspace.task.parentWorkspaceId : "";
      addChild(parentId, workspace);
      continue;
    }

    roots.push(workspace);
  }

  const result: WorkspaceState[] = [];
  const appendChildren = (parentId: string): void => {
    const kids = children.get(parentId);
    if (!kids) {
      return;
    }
    for (const child of kids) {
      result.push(child);
      appendChildren(child.id);
    }
    children.delete(parentId);
  };

  for (const workspace of roots) {
    result.push(workspace);
    appendChildren(workspace.id);
  }

  for (const kids of children.values()) {
    result.push(...kids);
  }
  return result;
}

const GRID_LAYOUT_SLOTS: Record<string, number> = {
  cols: 2,
  rows: 2,
  "top-split": 3,
  "left-split": 3,
  grid: 4,
};
const VALID_GRID_LAYOUTS = new Set(Object.keys(GRID_LAYOUT_SLOTS));

/**
 * Validate and normalise a raw workspaceGrid value.
 * Returns null when the grid is empty, invalid, or all cells are empty.
 * Clears any cell whose workspace no longer exists in the active profile.
 */
export function normalizeWorkspaceGrid(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  grid: any,
  workspaces: WorkspaceState[],
  activeProfileId: string,
): WorkspaceGridState | null {
  if (!grid || typeof grid !== "object") return null;

  const layout = grid.layout as string;
  if (!VALID_GRID_LAYOUTS.has(layout)) return null;

  const slots = GRID_LAYOUT_SLOTS[layout];
  const rawIds: unknown[] = Array.isArray(grid.cellWorkspaceIds) ? grid.cellWorkspaceIds : [];

  const activeProfileWsIds = new Set(
    workspaces.filter((ws) => (ws.profileId || "default") === activeProfileId).map((ws) => ws.id),
  );

  const seen = new Set<string>();
  const cellWorkspaceIds: (string | null)[] = [];

  for (let i = 0; i < slots; i++) {
    const raw = i < rawIds.length ? rawIds[i] : null;
    if (typeof raw === "string" && raw && activeProfileWsIds.has(raw) && !seen.has(raw)) {
      cellWorkspaceIds.push(raw);
      seen.add(raw);
    } else {
      cellWorkspaceIds.push(null);
    }
  }

  if (cellWorkspaceIds.every((id) => id === null)) return null;

  return { layout: layout as WorkspaceGridLayout, cellWorkspaceIds };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function normalizeState(rawState: any = {}): AppState & { activeProjectId: string; projects: WorkspaceState[] } {
  const defaults = createDefaultState();
  const rawWorkspaces = rawState.workspaces || rawState.projects || defaults.workspaces;
  const rawTemplates = rawState.tabTemplates;
  const tabTemplates =
    Array.isArray(rawTemplates) && rawTemplates.length
      ? rawTemplates.map((tmpl) => ({
          id: tmpl.id || `tmpl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          title: repairVisibleText(tmpl.title || "Untitled"),
          command: tmpl.command ?? "",
          icon: repairVisibleText(tmpl.icon || "\u{1F4BB}"),
          ...(Array.isArray(tmpl.platforms) ? { platforms: tmpl.platforms.slice() } : {}),
        }))
      : defaults.tabTemplates;
  // Ensure the "files" template exists for existing users.
  if (!tabTemplates.some((t) => t.id === "files" || t.command === "__files__")) {
    tabTemplates.push({ id: "files", title: "Files", command: "__files__", icon: "\u{1F4C2}" });
  }
  // Platform-conditional shell migrations. Insert right after the "shell"
  // template so the shells stay grouped in the Tab picker dropdown.
  const shellIdx = tabTemplates.findIndex((t) => t.id === "shell");
  const insertAfterShell = (tmpl: TabTemplate) => {
    if (shellIdx >= 0) tabTemplates.splice(shellIdx + 1, 0, tmpl);
    else tabTemplates.push(tmpl);
  };
  if (process.platform === "win32") {
    const ensureWinShell = (spec: TabTemplate, match: (t: TabTemplate) => boolean) => {
      if (!tabTemplates.some(match)) insertAfterShell(spec);
    };
    ensureWinShell(
      { id: "powershell", title: "PowerShell", command: "powershell", icon: "\u{1F537}", platforms: ["win32"] },
      (t) => t.id === "powershell" || t.command === "powershell",
    );
    ensureWinShell(
      { id: "pwsh", title: "PowerShell 7", command: "pwsh", icon: "⚡", platforms: ["win32"] },
      (t) => t.id === "pwsh" || t.command === "pwsh",
    );
    ensureWinShell(
      {
        id: "git-bash",
        title: "Git Bash",
        command: "bash --login -i",
        icon: "\u{1F333}",
        platforms: ["win32"],
      },
      (t) => t.id === "git-bash" || (typeof t.command === "string" && t.command.startsWith("bash")),
    );
    ensureWinShell(
      { id: "wsl", title: "WSL", command: "wsl", icon: "\u{1F427}", platforms: ["win32"] },
      (t) => t.id === "wsl" || t.command === "wsl" || (typeof t.command === "string" && t.command.startsWith("wsl ")),
    );
  } else {
    const ensurePosixShell = (spec: TabTemplate, match: (t: TabTemplate) => boolean) => {
      if (!tabTemplates.some(match)) insertAfterShell(spec);
    };
    ensurePosixShell(
      { id: "bash", title: "Bash", command: "bash", icon: "\u{1F41A}", platforms: ["darwin", "linux"] },
      (t) => t.id === "bash" || t.command === "bash",
    );
    ensurePosixShell(
      { id: "zsh", title: "Zsh", command: "zsh", icon: "\u{1F41A}", platforms: ["darwin", "linux"] },
      (t) => t.id === "zsh" || t.command === "zsh",
    );
    ensurePosixShell(
      { id: "fish", title: "Fish", command: "fish", icon: "\u{1F420}", platforms: ["darwin", "linux"] },
      (t) => t.id === "fish" || t.command === "fish",
    );
  }
  // Migration for existing users: ensure the "copilot" agent template exists
  // alongside claude/codex/gemini. Insert right after the last built-in agent
  // so the group stays tidy in the Tab picker dropdown.
  if (!tabTemplates.some((t) => t.id === "copilot" || t.command === "copilot")) {
    const copilotTemplate = { id: "copilot", title: "GitHub Copilot", command: "copilot", icon: "\u{1F419}" };
    const anchorIdx = (() => {
      for (const anchor of ["gemini", "codex", "claude"]) {
        const idx = tabTemplates.findIndex((t) => t.id === anchor);
        if (idx >= 0) return idx;
      }
      return -1;
    })();
    if (anchorIdx >= 0) tabTemplates.splice(anchorIdx + 1, 0, copilotTemplate);
    else tabTemplates.push(copilotTemplate);
  }
  // Migration for existing users: ensure the "opencode" agent template exists.
  // Insert right after "copilot" (or after the last built-in agent) so the
  // agent group stays tidy in the Tab picker dropdown.
  if (!tabTemplates.some((t) => t.id === "opencode" || t.command === "opencode")) {
    const opencodeTemplate = { id: "opencode", title: "OpenCode", command: "opencode", icon: "\u{1F9EC}" };
    const anchorIdx = (() => {
      for (const anchor of ["copilot", "gemini", "codex", "claude"]) {
        const idx = tabTemplates.findIndex((t) => t.id === anchor);
        if (idx >= 0) return idx;
      }
      return -1;
    })();
    if (anchorIdx >= 0) tabTemplates.splice(anchorIdx + 1, 0, opencodeTemplate);
    else tabTemplates.push(opencodeTemplate);
  }
  const profiles = normalizeProfiles(rawState.profiles, defaults);
  const rawActive = rawState.activeProfileId;
  const activeProfileFound = profiles.some((profile) => profile.id === rawActive);
  const activeProfileId = activeProfileFound ? rawActive : profiles[0]?.id || "default";
  if (rawActive && !activeProfileFound) {
    // The active profile id stored in raw state is no longer present in the
    // normalized profiles list — this normalization step silently falls back
    // to the first profile, which has bitten us before (workspace lands on
    // "default" even though the user thinks "asdf" is active). Surface it
    // loudly so the regression is obvious in the log next time.

    console.warn("[default-state] activeProfileId not in profiles, falling back", {
      rawActive,
      profileIds: profiles.map((p) => p.id),
      fallback: activeProfileId,
    });
  }

  const VALID_LOG_LEVELS = ["error", "warn", "info", "debug", "trace"];
  const rawLogLevel = (rawState.settings || {}).logLevel;
  const rawNotifications = (rawState.settings || {}).notifications || {};
  const normalizedSettings = {
    ...defaults.settings,
    ...(rawState.settings || {}),
    logLevel: VALID_LOG_LEVELS.includes(rawLogLevel) ? rawLogLevel : defaults.settings.logLevel,
    notifications: {
      promptQuietMs:
        Number(rawNotifications.promptQuietMs) > 0
          ? Number(rawNotifications.promptQuietMs)
          : defaults.settings.notifications.promptQuietMs,
      agentQuietMs:
        Number(rawNotifications.agentQuietMs) > 0
          ? Number(rawNotifications.agentQuietMs)
          : defaults.settings.notifications.agentQuietMs,
      agentQuietFastMs:
        Number(rawNotifications.agentQuietFastMs) > 0
          ? Number(rawNotifications.agentQuietFastMs)
          : defaults.settings.notifications.agentQuietFastMs,
      alertCooldownMs:
        Number(rawNotifications.alertCooldownMs) >= 0
          ? Number(rawNotifications.alertCooldownMs)
          : defaults.settings.notifications.alertCooldownMs,
      userInteractionGraceMs:
        Number(rawNotifications.userInteractionGraceMs) >= 0
          ? Number(rawNotifications.userInteractionGraceMs)
          : defaults.settings.notifications.userInteractionGraceMs,
      shellIntegration:
        typeof rawNotifications.shellIntegration === "boolean"
          ? rawNotifications.shellIntegration
          : defaults.settings.notifications.shellIntegration,
      agentHook:
        typeof rawNotifications.agentHook === "boolean"
          ? rawNotifications.agentHook
          : defaults.settings.notifications.agentHook,
      debug:
        typeof rawNotifications.debug === "boolean" ? rawNotifications.debug : defaults.settings.notifications.debug,
      agentsOnly:
        typeof rawNotifications.agentsOnly === "boolean"
          ? rawNotifications.agentsOnly
          : defaults.settings.notifications.agentsOnly,
    },
    remoteAccess: {
      ...defaults.settings.remoteAccess,
      ...((rawState.settings || {}).remoteAccess || {}),
      host:
        ((rawState.settings || {}).remoteAccess || {}).host === "127.0.0.1"
          ? "0.0.0.0"
          : ((rawState.settings || {}).remoteAccess || {}).host || defaults.settings.remoteAccess.host,
      token: ((rawState.settings || {}).remoteAccess || {}).token || defaults.settings.remoteAccess.token,
    },
    integrations: {
      ...defaults.settings.integrations,
      ...((rawState.settings || {}).integrations || {}),
      azureDevops: {
        ...defaults.settings.integrations.azureDevops,
        ...(((rawState.settings || {}).integrations || {}).azureDevops || {}),
        connections: Array.isArray((((rawState.settings || {}).integrations || {}).azureDevops || {}).connections)
          ? (((rawState.settings || {}).integrations || {}).azureDevops || {}).connections.map(
              // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: raw persisted state, no schema yet
              (connection: any, index: number) => ({
                id: connection.id || `ado-${index + 1}`,
                label: connection.label || connection.id || `Azure ${index + 1}`,
                orgUrl: connection.orgUrl || "",
                login: connection.login || "",
                tokenRef: connection.tokenRef || "",
                enabled: connection.enabled !== false,
                profileId: connection.profileId || "",
                projectFilters: Array.isArray(connection.projectFilters) ? [...connection.projectFilters] : [],
                repositoryFilters: Array.isArray(connection.repositoryFilters) ? [...connection.repositoryFilters] : [],
                pollSeconds:
                  Number(connection.pollSeconds) || defaults.settings.integrations.azureDevops.defaultPollSeconds,
                reviewRoot: connection.reviewRoot || defaults.settings.integrations.azureDevops.reviewRoot,
              }),
            )
          : [],
      },
      github: {
        ...defaults.settings.integrations.github,
        ...(((rawState.settings || {}).integrations || {}).github || {}),
        connections: Array.isArray((((rawState.settings || {}).integrations || {}).github || {}).connections)
          ? (((rawState.settings || {}).integrations || {}).github || {}).connections.map(
              // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: raw persisted state, no schema yet
              (connection: any, index: number) => ({
                id: connection.id || `gh-${index + 1}`,
                label: connection.label || connection.id || `GitHub ${index + 1}`,
                hostUrl: connection.hostUrl || "https://github.com",
                apiBaseUrl: connection.apiBaseUrl || "",
                currentUserLogin: connection.currentUserLogin || "",
                tokenRef: connection.tokenRef || "",
                enabled: connection.enabled !== false,
                profileId: connection.profileId || "",
                ownerFilters: Array.isArray(connection.ownerFilters) ? [...connection.ownerFilters] : [],
                repositoryFilters: Array.isArray(connection.repositoryFilters) ? [...connection.repositoryFilters] : [],
                pollSeconds: Number(connection.pollSeconds) || defaults.settings.integrations.github.defaultPollSeconds,
                reviewRoot: connection.reviewRoot || defaults.settings.integrations.github.reviewRoot,
              }),
            )
          : [],
      },
      telegram: {
        ...defaults.settings.integrations.telegram,
        ...(((rawState.settings || {}).integrations || {}).telegram || {}),
        connections: Array.isArray((((rawState.settings || {}).integrations || {}).telegram || {}).connections)
          ? (((rawState.settings || {}).integrations || {}).telegram || {}).connections.map(
              // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: raw persisted state, no schema yet
              (connection: any, index: number) => ({
                id: connection.id || `tg-${index + 1}`,
                label: connection.label || connection.id || `Telegram ${index + 1}`,
                botTokenRef: connection.botTokenRef || "",
                chatId: connection.chatId || "",
                enabled: connection.enabled !== false,
                pollSeconds:
                  Number(connection.pollSeconds) || defaults.settings.integrations.telegram.defaultPollSeconds,
                forwardKinds: Array.isArray(connection.forwardKinds) ? [...connection.forwardKinds] : [],
                agentCommand: typeof connection.agentCommand === "string" ? connection.agentCommand : "",
              }),
            )
          : [],
      },
    },
    taskDefaults: {
      ...defaults.settings.taskDefaults,
      ...((rawState.settings || {}).taskDefaults || {}),
      workerProvider: {
        ...defaults.settings.taskDefaults.workerProvider,
        ...(((rawState.settings || {}).taskDefaults || {}).workerProvider || {}),
      },
      judgeProvider: {
        ...defaults.settings.taskDefaults.judgeProvider,
        ...(((rawState.settings || {}).taskDefaults || {}).judgeProvider || {}),
      },
    },
    git: {
      ui: {
        showAllActions:
          typeof (rawState.settings || {}).git?.ui?.showAllActions === "boolean"
            ? (rawState.settings || {}).git.ui.showAllActions
            : defaults.settings.git.ui.showAllActions,
      },
    },
    externalPathOpener: {
      mode:
        ((rawState.settings || {}).externalPathOpener || {}).mode === "command" ||
        ((rawState.settings || {}).externalPathOpener || {}).mode === "internal"
          ? ((rawState.settings || {}).externalPathOpener || {}).mode
          : defaults.settings.externalPathOpener.mode,
      command:
        typeof ((rawState.settings || {}).externalPathOpener || {}).command === "string"
          ? ((rawState.settings || {}).externalPathOpener || {}).command
          : defaults.settings.externalPathOpener.command,
    },
  };
  const workspaces = groupChildWorkspaces(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: raw JSON from disk has unknown workspace shape
    (rawWorkspaces as any[])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: same raw JSON workspace
      .map((workspace: any, index: number) => normalizeWorkspace(workspace, index))
      .map((workspace) => {
        if (workspace.kind === "azure" && !String(workspace.cwd || "").trim()) {
          return {
            ...workspace,
            cwd:
              normalizedSettings.integrations.azureDevops.reviewRoot ||
              defaults.settings.integrations.azureDevops.reviewRoot,
          };
        }
        if (workspace.kind === "github" && !String(workspace.cwd || "").trim()) {
          return {
            ...workspace,
            cwd: normalizedSettings.integrations.github.reviewRoot || defaults.settings.integrations.github.reviewRoot,
          };
        }
        return workspace;
      }),
  );

  // Validate activeWorkspaceId against workspaces in the active profile
  const profileWorkspaces = workspaces.filter((workspace) => (workspace.profileId || "default") === activeProfileId);
  const requestedActiveWorkspaceId = rawState.activeWorkspaceId || rawState.activeProjectId;
  const activeWorkspaceId = profileWorkspaces.some((workspace) => workspace.id === requestedActiveWorkspaceId)
    ? requestedActiveWorkspaceId
    : profileWorkspaces[0]?.id || "";

  // Migrate Azure connections without profileId: assign to the profile that owns
  // the Azure workspace, or fallback to the active profile.
  const azureConnections = normalizedSettings.integrations?.azureDevops?.connections || [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hasUntaggedConnections = azureConnections.some((c: any) => !c.profileId);
  if (hasUntaggedConnections) {
    const azureWorkspaceProfile = workspaces.find((w) => w.kind === "azure")?.profileId || activeProfileId;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    normalizedSettings.integrations.azureDevops.connections = azureConnections.map((c: any) =>
      c.profileId ? c : { ...c, profileId: azureWorkspaceProfile },
    );
  }

  const ssh = {
    ...defaults.ssh,
    ...(rawState.ssh || {}),
    settings: {
      ...defaults.ssh.settings,
      ...((rawState.ssh || {}).settings || {}),
    },
  };

  // Per-profile workspace grids.
  // Migration: if profiles don't have workspaceGrid yet, move the global
  // workspaceGrid to the active profile so it is preserved.
  const profilesWithGrid: Profile[] = profiles.map((profile) => {
    if (profile.workspaceGrid !== undefined) {
      // Already migrated — just re-normalize the grid cells.
      return {
        ...profile,
        workspaceGrid: normalizeWorkspaceGrid(profile.workspaceGrid, workspaces, profile.id),
      };
    }
    if (profile.id === activeProfileId && rawState.workspaceGrid) {
      // First-time migration: move the global grid under the active profile.
      return {
        ...profile,
        workspaceGrid: normalizeWorkspaceGrid(rawState.workspaceGrid, workspaces, profile.id),
      };
    }
    return { ...profile, workspaceGrid: null };
  });

  // Keep the deprecated global workspaceGrid for downgrade compatibility (the
  // old version reads it from the top level if windowSlots don't exist).
  const activeProfile = profilesWithGrid.find((p) => p.id === activeProfileId);
  const workspaceGrid = activeProfile?.workspaceGrid ?? null;

  const windowSlots = normalizeWindowSlots(
    (rawState as Record<string, unknown>).windowSlots,
    profilesWithGrid,
    activeProfileId,
    activeWorkspaceId,
  );

  const normalized = {
    ...defaults,
    ...rawState,
    ssh,
    activeWorkspaceId,
    activeProfileId,
    settings: normalizedSettings,
    tabTemplates,
    profiles: profilesWithGrid,
    workspaces,
    workspaceGrid,
    windowSlots,
  };

  return {
    ...normalized,
    activeProjectId: normalized.activeWorkspaceId,
    profiles: (normalized.profiles as Profile[]).map((profile) => ({
      ...profile,
      projectIds: [...profile.workspaceIds],
    })),
    projects: normalized.workspaces as WorkspaceState[],
  };
}

export function createSessionId(workspaceId: string, panelId: string): string {
  return `${workspaceId}:${panelId}`;
}

export function parseSessionId(sessionId: string): { workspaceId: string; panelId: string } | null {
  const [workspaceId, panelId] = String(sessionId || "").split(":");
  if (!workspaceId || !panelId) {
    return null;
  }

  return { workspaceId, panelId };
}

// Backward-compatible aliases while the wider codebase migrates from project naming.
export const normalizeProject = normalizeWorkspace;
