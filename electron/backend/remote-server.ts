/// <reference types="node" />
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { WebSocketServer } from "ws";
import * as fm from "./file-manager.js";
import { wsTerminalInputSchema, wsTerminalResizeSchema } from "./ipc-schemas.js";
import { getLogger } from "./logger.js";

const log = getLogger("remote-server");

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;

/**
 * Minimal Runtime interface covering the methods used in the remote server.
 * The actual runtime object returned by createRuntime() satisfies this shape.
 */
interface Runtime {
  getPayload(): {
    appState: {
      settings: {
        remoteAccess: { enabled: boolean; host: string; port: number; token: string };
      };
    };
  };
  getInitialState(): Promise<unknown>;
  setRemoteInfo(info: { enabled: boolean; urls?: string[]; port?: number; host?: string; error?: string }): void;
  listRemoteUrls(): string[];
  on(channel: string, handler: AnyFn): () => void;
  writeToSession(sessionId: string, data: string): void;
  resizeSession(sessionId: string, size: { cols: number; rows: number }): void;
  // All other methods accessed dynamically via string keys
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

function json(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

const MAX_BODY_SIZE = 5 * 1024 * 1024; // 5 MB

function readRequestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = "";
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        request.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      raw += chunk.toString();
    });
    request.on("end", () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function getTokenFromRequest(requestUrl: string, headers: IncomingMessage["headers"]): string {
  const url = new URL(requestUrl, "http://localhost");
  const header = (headers.authorization as string) || "";
  if (header.toLowerCase().startsWith("bearer ")) {
    return header.slice(7);
  }

  return url.searchParams.get("token") || "";
}

function listRemoteUrls(host: string, port: number, token: string): string[] {
  const urls: string[] = [];
  const interfaces = os.networkInterfaces();

  if (host === "0.0.0.0") {
    for (const addresses of Object.values(interfaces)) {
      for (const address of addresses || []) {
        if (address.family === "IPv4" && !address.internal) {
          urls.push(`http://${address.address}:${port}/?token=${token}`);
        }
      }
    }
  } else {
    urls.push(`http://${host}:${port}/?token=${token}`);
  }

  return urls;
}

async function serveStatic(staticRoot: string, requestUrl: string, response: ServerResponse): Promise<void> {
  const url = new URL(requestUrl, "http://localhost");
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const resolvedPath = path.normalize(path.join(staticRoot, pathname));
  const safeRoot = path.normalize(staticRoot);
  if (!resolvedPath.startsWith(safeRoot)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  let finalPath = resolvedPath;
  if (!existsSync(finalPath)) {
    finalPath = path.join(staticRoot, "index.html");
  }

  try {
    const buffer = await fs.readFile(finalPath);
    const contentType = CONTENT_TYPES[path.extname(finalPath)] || "application/octet-stream";
    response.writeHead(200, { "Content-Type": contentType });
    response.end(buffer);
  } catch {
    response.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("strIDEterm remote UI is unavailable until the renderer build exists.");
  }
}

async function handleApiRequest(runtime: Runtime, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url!, "http://localhost");

  try {
    if (request.method === "GET" && url.pathname === "/api/state") {
      json(response, 200, await runtime.getInitialState());
      return;
    }

    const body = await readRequestBody(request);

    if (
      request.method === "POST" &&
      (url.pathname === "/api/workspace/activate" || url.pathname === "/api/project/activate")
    ) {
      json(response, 200, await runtime.activateWorkspace((body.workspaceId || body.projectId) as string));
      return;
    }

    if (request.method === "POST" && (url.pathname === "/api/workspace/save" || url.pathname === "/api/project/save")) {
      json(response, 200, await runtime.saveWorkspace(body.workspace || body.project));
      return;
    }

    if (
      request.method === "POST" &&
      (url.pathname === "/api/workspace/delete" || url.pathname === "/api/project/delete")
    ) {
      json(response, 200, await runtime.deleteWorkspace((body.workspaceId || body.projectId) as string, body));
      return;
    }

    if (
      request.method === "POST" &&
      (url.pathname === "/api/workspace/reorder" || url.pathname === "/api/project/reorder")
    ) {
      json(response, 200, await runtime.reorderWorkspaces((body.workspaceIds || body.projectIds || []) as string[]));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/settings/update") {
      const result = await runtime.updateSettings(body.settings || {});
      json(response, 200, result.payload);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/azure/verify-connection") {
      json(response, 200, await runtime.verifyAzureConnection(body.connection || {}));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/azure/save-connection") {
      const result = await runtime.saveAzureConnection(body.connection || {});
      json(response, 200, result.payload);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/azure/delete-connection") {
      json(response, 200, await runtime.deleteAzureConnection(body.connectionId));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/azure/refresh") {
      json(response, 200, await runtime.refreshAzureState());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/azure/audit-log/query") {
      json(response, 200, runtime.queryAzureAuditLog(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/azure/audit-log/stats") {
      json(response, 200, runtime.getAzureAuditStats(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/azure/pull-request/seen") {
      json(response, 200, await runtime.markAzurePullRequestSeen(body.prKey));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/azure/pull-request/open") {
      json(response, 200, await runtime.openAzurePullRequest(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/azure/pull-request/comment") {
      json(response, 200, await runtime.commentAzurePullRequest(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/azure/pull-request/thread-status") {
      json(response, 200, await runtime.updateAzureThreadStatus(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/review-bridge/draft-comment/create") {
      json(response, 200, await runtime.createReviewBridgeDraftComment(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/review-bridge/draft/save") {
      json(response, 200, await runtime.saveReviewBridgeDraft(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/review-bridge/draft/queue") {
      json(response, 200, await runtime.queueReviewBridgeDraft(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/review-bridge/draft/delete") {
      json(response, 200, await runtime.deleteReviewBridgeDraft(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/review-bridge/comment/delete") {
      json(response, 200, await runtime.deleteReviewBridgeComment(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/review-bridge/agent-prompt/reset") {
      json(response, 200, await runtime.resetAgentPrompts());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/review-bridge/comment/reply-with-changes") {
      json(response, 200, await runtime.replyWithCodeChanges(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/review-bridge/pull-request/sync") {
      json(response, 200, await runtime.syncReviewBridgePullRequest(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/review-bridge/pull-request/push-and-publish") {
      json(response, 200, await runtime.pushAndPublishReview(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/azure/pull-request/vote") {
      json(response, 200, await runtime.voteAzurePullRequest(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/azure/workspace/fetch") {
      json(response, 200, await runtime.fetchAzureReviewWorkspace(body.workspaceId));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/azure/workspace/rebase") {
      json(response, 200, await runtime.rebaseAzureReviewWorkspace(body.workspaceId));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/azure/workspace/push") {
      json(
        response,
        200,
        await runtime.pushAzureReviewWorkspace(body.workspaceId as string, { force: Boolean(body.force) }),
      );
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/azure/create-pull-request") {
      json(response, 200, await runtime.azureCreatePullRequest(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/azure/list-remote-branches") {
      json(response, 200, await runtime.azureListRemoteBranches(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/azure/quickfix/list-projects") {
      json(response, 200, await runtime.azureQuickFixListProjects(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/azure/quickfix/list-repositories") {
      json(response, 200, await runtime.azureQuickFixListRepositories(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/azure/quickfix/list-branches") {
      json(response, 200, await runtime.azureQuickFixListBranches(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/azure/quickfix/create") {
      json(response, 200, await runtime.azureQuickFixCreate(body));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/azure/rerun-check") {
      json(response, 200, await runtime.rerunAzureCheck(body.prKey, body.checkItem));
      return;
    }

    // --- GitHub ---
    if (request.method === "POST" && url.pathname === "/api/github/verify-connection") {
      json(response, 200, await runtime.verifyGitHubConnection(body.connection || {}));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/github/save-connection") {
      const result = await runtime.saveGitHubConnection(body.connection || {});
      json(response, 200, result.payload);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/github/delete-connection") {
      json(response, 200, await runtime.deleteGitHubConnection(body.connectionId));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/github/refresh") {
      json(response, 200, await runtime.refreshGitHubState());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/github/audit-log/query") {
      json(response, 200, runtime.queryGitHubAuditLog(body));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/github/audit-log/stats") {
      json(response, 200, runtime.getGitHubAuditStats(body));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/github/pull-request/seen") {
      json(response, 200, await runtime.markGitHubPullRequestSeen(body.prKey));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/github/pull-request/open") {
      json(response, 200, await runtime.openGitHubPullRequest(body));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/github/pull-request/comment") {
      json(response, 200, await runtime.commentGitHubPullRequest(body));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/github/pull-request/review") {
      json(response, 200, await runtime.submitGitHubPullRequestReview(body));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/github/rerun-check") {
      json(response, 200, await runtime.rerunGitHubCheck(body.prKey, body.checkItem));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/github/workspace/fetch") {
      json(response, 200, await runtime.fetchGitHubReviewWorkspace(body.workspaceId));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/github/workspace/rebase") {
      json(response, 200, await runtime.rebaseGitHubReviewWorkspace(body.workspaceId));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/github/workspace/push") {
      json(response, 200, await runtime.pushGitHubReviewWorkspace(body.workspaceId, body));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/github/list-remote-branches") {
      json(response, 200, await runtime.githubListRemoteBranches(body));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/github/create-pull-request") {
      json(response, 200, await runtime.githubCreatePullRequest(body));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/github/quickfix/list-repos") {
      json(response, 200, await runtime.githubQuickFixListRepos(body));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/github/quickfix/list-branches") {
      json(response, 200, await runtime.githubQuickFixListBranches(body));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/github/quickfix/create") {
      json(response, 200, await runtime.githubQuickFixCreate(body));
      return;
    }

    // --- Telegram ---
    if (request.method === "POST" && url.pathname === "/api/telegram/verify-connection") {
      json(response, 200, await runtime.verifyTelegramConnection(body.connection || {}));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/telegram/detect-chats") {
      json(response, 200, await runtime.detectTelegramChats(body.connection || {}));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/telegram/save-connection") {
      const result = await runtime.saveTelegramConnection(body.connection || {});
      json(response, 200, result.payload);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/telegram/delete-connection") {
      json(response, 200, await runtime.deleteTelegramConnection(body.connectionId));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/telegram/refresh") {
      json(response, 200, await runtime.refreshTelegramState());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/remote/token/regenerate") {
      json(response, 200, await runtime.regenerateRemoteToken());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/tunnel/refresh") {
      json(response, 200, await runtime.refreshTunnelState());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/tunnel/create") {
      json(response, 200, await runtime.createCloudflareTunnel());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/tunnel/stop") {
      json(response, 200, await runtime.stopCloudflareTunnel());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/claude-hook/configure") {
      json(response, 200, await runtime.configureClaudeHook());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/claude-hook/remove") {
      json(response, 200, await runtime.removeClaudeHook());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/claude-hook/status") {
      json(response, 200, await runtime.getClaudeHookStatus());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/gemini-hook/configure") {
      json(response, 200, await runtime.configureGeminiHook());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/gemini-hook/remove") {
      json(response, 200, await runtime.removeGeminiHook());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/gemini-hook/status") {
      json(response, 200, await runtime.getGeminiHookStatus());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/claude-hook/test") {
      json(response, 200, await runtime.testClaudeHook());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/gemini-hook/test") {
      json(response, 200, await runtime.testGeminiHook());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/codex-hook/configure") {
      json(response, 200, await runtime.configureCodexHook());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/codex-hook/remove") {
      json(response, 200, await runtime.removeCodexHook());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/codex-hook/status") {
      json(response, 200, await runtime.getCodexHookStatus());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/codex-hook/test") {
      json(response, 200, await runtime.testCodexHook());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/copilot-hook/configure") {
      json(response, 200, await runtime.configureCopilotHook());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/copilot-hook/remove") {
      json(response, 200, await runtime.removeCopilotHook());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/copilot-hook/status") {
      json(response, 200, await runtime.getCopilotHookStatus());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/copilot-hook/test") {
      json(response, 200, await runtime.testCopilotHook());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/opencode-hook/configure") {
      json(response, 200, await runtime.configureOpencodeHook());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/opencode-hook/remove") {
      json(response, 200, await runtime.removeOpencodeHook());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/opencode-hook/status") {
      json(response, 200, await runtime.getOpencodeHookStatus());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/opencode-hook/test") {
      json(response, 200, await runtime.testOpencodeHook());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/check-command") {
      json(response, 200, await runtime.checkCommand(body.command));
      return;
    }

    // --- Task runner ---
    if (request.method === "POST" && url.pathname === "/api/task/recheck-claude") {
      json(response, 200, await runtime.recheckClaude());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/task/check-providers") {
      json(response, 200, await runtime.checkProviders());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/task/check-git-repo") {
      json(response, 200, await runtime.checkIsGitRepo(String(body?.cwd || "")));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/fs/probe-directory") {
      json(response, 200, await runtime.probeDirectory(String(body?.cwd || "")));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/task/create") {
      json(response, 200, await runtime.createTaskWorkspace(body));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/task/start") {
      json(response, 200, await runtime.startTask(body.workspaceId));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/task/stop") {
      json(response, 200, runtime.stopTask(body.workspaceId));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/task/pause") {
      json(response, 200, runtime.pauseTask(body.workspaceId));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/task/resume") {
      json(response, 200, runtime.resumeTask(body.workspaceId));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/task/reset") {
      json(response, 200, await runtime.resetTask(body.workspaceId));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/task/reject-verdict") {
      json(response, 200, await runtime.rejectTaskVerdict(body.workspaceId, body.feedback));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/task/status") {
      json(response, 200, runtime.getTaskStatus(body.workspaceId));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/session/activate") {
      json(response, 200, await runtime.activateSession(body.sessionId));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/workspace/set-ui-state") {
      json(response, 200, await runtime.setWorkspaceUIState(body.workspaceId, body.uiState));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/attention/sync") {
      json(response, 200, await runtime.syncAttentionContext(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/attention/clear-all") {
      json(response, 200, runtime.clearAllAttention());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/attention/clear-session") {
      json(
        response,
        200,
        runtime.clearAlertForSession(String(body.sessionId || ""), { dismissed: body.dismissed === true }),
      );
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/terminal/restart") {
      json(response, 200, await runtime.restartSession(body.sessionId));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/docker/refresh") {
      json(response, 200, await runtime.refreshDockerState());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/git/refresh") {
      json(response, 200, await runtime.refreshGitState(body.projectId || null));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/git/fetch") {
      json(response, 200, await runtime.gitFetch(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/git/pull") {
      json(response, 200, await runtime.gitPull(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/git/push") {
      json(response, 200, await runtime.gitPush(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/git/checkout-branch") {
      json(response, 200, await runtime.gitCheckoutBranch(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/git/create-branch") {
      json(response, 200, await runtime.gitCreateBranch(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/git/merge-into-current") {
      json(response, 200, await runtime.gitMergeIntoCurrent(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/git/rebase-onto") {
      json(response, 200, await runtime.gitRebaseOnto(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/git/continue") {
      json(response, 200, await runtime.gitContinueOperation(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/git/abort") {
      json(response, 200, await runtime.gitAbortOperation(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/git/diff-preview") {
      json(response, 200, await runtime.gitDiffPreview(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/git/merge-into-base") {
      json(response, 200, await runtime.gitMergeCurrentIntoBase(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/git/remove-worktree") {
      json(response, 200, await runtime.gitRemoveWorktree(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/git/commit-all") {
      json(response, 200, await runtime.gitCommitAll(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/git/stash") {
      json(response, 200, await runtime.gitStash(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/git/stash-pop") {
      json(response, 200, await runtime.gitStashPop(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/git/commit-diff") {
      json(response, 200, await runtime.gitCommitDiff(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/git/list-tags") {
      json(response, 200, await runtime.gitListTags(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/git/create-tag") {
      json(response, 200, await runtime.gitCreateTag(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/git/delete-tag") {
      json(response, 200, await runtime.gitDeleteTag(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/git/push-tag") {
      json(response, 200, await runtime.gitPushTag(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/git/push-all-tags") {
      json(response, 200, await runtime.gitPushAllTags(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/git/delete-remote-tag") {
      json(response, 200, await runtime.gitDeleteRemoteTag(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/git/force-push-with-lease") {
      json(response, 200, await runtime.gitForcePushWithLease(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/docker/action") {
      json(response, 200, await runtime.dockerAction(body.action, body.containerId));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/docker/open-session") {
      json(response, 200, await runtime.openDockerSession(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/docker/open-lazydocker") {
      json(response, 200, await runtime.openLazydockerSession(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/git/open-lazygit") {
      json(response, 200, await runtime.openLazygitSession(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/git/create-worktree") {
      json(response, 200, await runtime.createWorktree(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/profile/save") {
      json(response, 200, await runtime.saveProfile(body.profile));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/profile/delete") {
      json(response, 200, await runtime.deleteProfile(body.profileId));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/profile/activate") {
      json(response, 200, await runtime.activateProfile(body.profileId));
      return;
    }

    // --- File manager endpoints (read-only by default for remote) ---
    if (request.method === "POST" && url.pathname === "/api/file/list") {
      json(response, 200, await fm.listDirectory(body.rootPath as string, body.relativePath as string));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/file/tree") {
      json(response, 200, await fm.getDirectoryTree(body.rootPath as string, body.relativePath as string));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/file/preview") {
      json(response, 200, await fm.readFilePreview(body.rootPath as string, body.relativePath as string));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/file/read") {
      json(response, 200, await fm.readFileContent(body.rootPath as string, body.relativePath as string));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/file/write") {
      json(
        response,
        200,
        await fm.writeFileContent(body.rootPath as string, body.relativePath as string, body.content as string),
      );
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/file/create-file") {
      json(response, 200, await fm.createFile(body.rootPath as string, body.parentPath as string, body.name as string));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/file/create-dir") {
      json(
        response,
        200,
        await fm.createDirectory(body.rootPath as string, body.parentPath as string, body.name as string),
      );
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/file/rename") {
      json(
        response,
        200,
        await fm.renameEntry(body.rootPath as string, body.relativePath as string, body.newName as string),
      );
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/file/delete") {
      json(response, 200, await fm.deleteEntry(body.rootPath as string, body.relativePath as string));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/file/move") {
      json(response, 200, await fm.moveEntry(body.rootPath as string, body.fromPath as string, body.toPath as string));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/file/copy") {
      json(response, 200, await fm.copyEntry(body.rootPath as string, body.fromPath as string, body.toPath as string));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/file/open-in-explorer") {
      // Open-in-explorer is an Electron-only feature; noop for remote.
      json(response, 200, { ok: true });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/file/open-in-editor") {
      // Open-in-editor is an Electron-only feature; noop for remote.
      json(response, 200, { ok: true });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/file/info") {
      json(response, 200, await fm.getFileInfo(body.rootPath as string, body.relativePath as string));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/file/git-status") {
      json(
        response,
        200,
        await fm.getGitFileStatus(body.rootPath as string, { includeIgnored: !!body.includeIgnored }),
      );
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/file/git-refs") {
      json(response, 200, await fm.getGitRefs(body.rootPath as string, (body.relativePath as string) || ""));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/file/git-diff") {
      json(
        response,
        200,
        await fm.computeFileDiff(body.rootPath as string, body.relativePath as string, {
          source: (body.source as string) || "head",
          revisionRef: (body.revisionRef as string) || "",
        }),
      );
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/file/commit-files") {
      json(response, 200, await fm.getCommitFiles(body.rootPath as string, body.hash as string));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/file/commit-diff") {
      json(
        response,
        200,
        await fm.computeCommitFileDiff(body.rootPath as string, body.relativePath as string, body.hash as string),
      );
      return;
    }

    // --- SSH (remote is read-only per plan §14) ---
    if (request.method === "POST" && url.pathname === "/api/ssh/hosts/list") {
      json(response, 200, await runtime["ssh:hosts:list"]());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/ssh/keys/list") {
      // Returns metadata only; private-key material never leaves the host.
      json(response, 200, await runtime["ssh:keys:list"]());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/ssh/certs/list") {
      json(response, 200, await runtime["ssh:certs:list"]());
      return;
    }
    // Remote sessions are allowed to respond to active prompts only — they
    // can't create/edit credentials. This mirrors how the user is already
    // attached to a session created locally.
    if (request.method === "POST" && url.pathname === "/api/ssh/auth/answer") {
      json(response, 200, await runtime["ssh:auth:answer"](body));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/ssh/auth/cancel") {
      json(response, 200, await runtime["ssh:auth:cancel"](body));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/ssh/host-key/accept") {
      json(response, 200, await runtime["ssh:host-key:accept"](body));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/ssh/host-key/reject") {
      json(response, 200, await runtime["ssh:host-key:reject"](body));
      return;
    }
    // Explicitly forbid credential/host administration from remote clients
    // so a leaked token can't exfiltrate or plant SSH hosts/keys. See plan
    // §14 — this must never be opened up without a per-host-on-remote
    // authorization story.
    if (
      request.method === "POST" &&
      (url.pathname === "/api/ssh/hosts/create" ||
        url.pathname === "/api/ssh/hosts/update" ||
        url.pathname === "/api/ssh/hosts/delete" ||
        url.pathname === "/api/ssh/hosts/duplicate" ||
        url.pathname === "/api/ssh/hosts/test" ||
        url.pathname === "/api/ssh/keys/import" ||
        url.pathname === "/api/ssh/keys/generate" ||
        url.pathname === "/api/ssh/keys/delete" ||
        url.pathname === "/api/ssh/certs/import" ||
        url.pathname === "/api/ssh/certs/delete" ||
        url.pathname === "/api/ssh/config/preview" ||
        url.pathname === "/api/ssh/config/import" ||
        url.pathname === "/api/ssh/known-hosts/import")
    ) {
      json(response, 403, { error: "SSH administration is not permitted on remote clients." });
      return;
    }

    json(response, 404, { error: "Not found" });
  } catch (error) {
    json(response, 500, { error: (error as Error).message || "Remote API failed" });
  }
}

export async function startRemoteServer({
  runtime,
  staticRoot,
  logger: _logger = console,
}: {
  runtime: Runtime;
  staticRoot: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  logger?: any;
}): Promise<{ close: () => Promise<void> }> {
  const { enabled, host, port, token } = runtime.getPayload().appState.settings.remoteAccess;
  if (!enabled) {
    runtime.setRemoteInfo({ enabled: false, urls: [], port, host });
    return { close: async () => {} };
  }

  const server = http.createServer(async (request, response) => {
    const requestUrl = request.url || "/";
    const url = new URL(requestUrl, "http://localhost");
    const requestToken = getTokenFromRequest(requestUrl, request.headers);
    const isApiRoute = url.pathname.startsWith("/api/");

    if (requestToken !== token && isApiRoute) {
      response.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Unauthorized");
      return;
    }

    if (isApiRoute) {
      await handleApiRequest(runtime, request, response);
      return;
    }

    await serveStatic(staticRoot, requestUrl, response);
  });

  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Set<import("ws").WebSocket>();

  function broadcast(message: unknown): void {
    const payload = JSON.stringify(message);
    for (const socket of sockets) {
      if (socket.readyState === socket.OPEN) {
        socket.send(payload);
      }
    }
  }

  const unsubscribe = [
    runtime.on("state:updated", (payload: unknown) => broadcast({ type: "state:updated", payload })),
    runtime.on("terminal:data", (payload: unknown) => broadcast({ type: "terminal:data", payload })),
    runtime.on("terminal:exit", (payload: unknown) => broadcast({ type: "terminal:exit", payload })),
    runtime.on("ssh:auth-prompt", (payload: unknown) => broadcast({ type: "ssh:auth-prompt", payload })),
    runtime.on("ssh:host-key-change", (payload: unknown) => broadcast({ type: "ssh:host-key-change", payload })),
    runtime.on("ssh:state", (payload: unknown) => broadcast({ type: "ssh:state", payload })),
    runtime.on("ssh:connection-state", (payload: unknown) => broadcast({ type: "ssh:connection-state", payload })),
  ];

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url || "/", "http://localhost");
    if (url.pathname !== "/ws" || getTokenFromRequest(request.url || "/", request.headers) !== token) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, async (ws) => {
      log.debug("WebSocket client connected", { remoteAddress: request.socket?.remoteAddress });
      sockets.add(ws);
      ws.send(JSON.stringify({ type: "state:updated", payload: await runtime.getInitialState() }));

      ws.on("message", (raw: Buffer) => {
        try {
          const message = JSON.parse(raw.toString()) as { type: string };
          if (message.type === "terminal:input") {
            const parsed = wsTerminalInputSchema.safeParse(message);
            if (parsed.success) {
              runtime.writeToSession(parsed.data.sessionId, parsed.data.data);
            }
          } else if (message.type === "terminal:resize") {
            const parsed = wsTerminalResizeSchema.safeParse(message);
            if (parsed.success) {
              runtime.resizeSession(parsed.data.sessionId, { cols: parsed.data.cols, rows: parsed.data.rows });
            }
          }
        } catch {
          // Ignore malformed remote messages.
        }
      });

      ws.on("close", () => {
        log.debug("WebSocket client disconnected", { remaining: sockets.size - 1 });
        sockets.delete(ws);
      });
    });
  });

  const listenResult = await new Promise<{ ok: boolean; error?: Error }>((resolve) => {
    server.once("error", (error: Error) => {
      const isPortBusy = (error as NodeJS.ErrnoException).code === "EADDRINUSE" || /EADDRINUSE/.test(error.message);
      if (isPortBusy) {
        log.warn("remote access port already in use — disabled until restart", {
          port,
          host,
          hint: "Set STRIDETERM_REMOTE_PORT to pick a different port, or stop the other strideterm instance.",
        });
      } else {
        log.warn("remote access server failed", { err: error.message, port, host });
      }
      resolve({ ok: false, error });
    });
    server.listen(port, host, () => resolve({ ok: true }));
  });

  if (!listenResult.ok) {
    unsubscribe.forEach((dispose) => dispose());
    wss.close();
    server.close();
    runtime.setRemoteInfo({ enabled: false, urls: [], port, host, error: listenResult.error!.message });
    return { close: async () => {} };
  }

  runtime.setRemoteInfo({
    enabled: true,
    host,
    port,
    urls: listRemoteUrls(host, port, token),
  });
  const urls = runtime.listRemoteUrls();
  if (urls.length > 0) {
    log.info("remote access ready", { url: urls[0] });
  }

  return {
    async close() {
      unsubscribe.forEach((dispose) => dispose());
      for (const socket of sockets) {
        socket.close();
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
