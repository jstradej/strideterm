import os from "node:os";
import path from "node:path";
import http from "node:http";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { WebSocketServer } from "ws";

const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function json(response, statusCode, body) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk.toString();
    });
    request.on("end", () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function getTokenFromRequest(requestUrl, headers) {
  const url = new URL(requestUrl, "http://localhost");
  const header = headers.authorization || "";
  if (header.toLowerCase().startsWith("bearer ")) {
    return header.slice(7);
  }

  return url.searchParams.get("token") || "";
}

function listRemoteUrls(host, port, token) {
  const urls = [];
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

async function serveStatic(staticRoot, requestUrl, response) {
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

async function handleApiRequest(runtime, request, response) {
  const url = new URL(request.url, "http://localhost");

  try {
    if (request.method === "GET" && url.pathname === "/api/state") {
      json(response, 200, await runtime.getInitialState());
      return;
    }

    const body = await readRequestBody(request);

    if (request.method === "POST" && (url.pathname === "/api/workspace/activate" || url.pathname === "/api/project/activate")) {
      json(response, 200, await runtime.activateWorkspace(body.workspaceId || body.projectId));
      return;
    }

    if (request.method === "POST" && (url.pathname === "/api/workspace/save" || url.pathname === "/api/project/save")) {
      json(response, 200, await runtime.saveWorkspace(body.workspace || body.project));
      return;
    }

    if (request.method === "POST" && (url.pathname === "/api/workspace/delete" || url.pathname === "/api/project/delete")) {
      json(response, 200, await runtime.deleteWorkspace(body.workspaceId || body.projectId, body));
      return;
    }

    if (request.method === "POST" && (url.pathname === "/api/workspace/reorder" || url.pathname === "/api/project/reorder")) {
      json(response, 200, await runtime.reorderWorkspaces(body.workspaceIds || body.projectIds || []));
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
      json(response, 200, await runtime.pushAzureReviewWorkspace(body.workspaceId, { force: Boolean(body.force) }));
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

    if (request.method === "POST" && url.pathname === "/api/session/activate") {
      json(response, 200, await runtime.activateSession(body.sessionId));
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

    if (request.method === "POST" && url.pathname === "/api/git/push") {
      json(response, 200, await runtime.gitPush(body));
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

    json(response, 404, { error: "Not found" });
  } catch (error) {
    json(response, 500, { error: error.message || "Remote API failed" });
  }
}

export async function startRemoteServer({ runtime, staticRoot, logger = console }) {
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
  const sockets = new Set();

  function broadcast(message) {
    const payload = JSON.stringify(message);
    for (const socket of sockets) {
      if (socket.readyState === socket.OPEN) {
        socket.send(payload);
      }
    }
  }

  const unsubscribe = [
    runtime.on("state:updated", (payload) => broadcast({ type: "state:updated", payload })),
    runtime.on("terminal:data", (payload) => broadcast({ type: "terminal:data", payload })),
    runtime.on("terminal:exit", (payload) => broadcast({ type: "terminal:exit", payload })),
  ];

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url || "/", "http://localhost");
    if (url.pathname !== "/ws" || getTokenFromRequest(request.url || "/", request.headers) !== token) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, async (ws) => {
      sockets.add(ws);
      ws.send(JSON.stringify({ type: "state:updated", payload: await runtime.getInitialState() }));

      ws.on("message", (raw) => {
        try {
          const message = JSON.parse(raw.toString());
          if (message.type === "terminal:input") {
            runtime.writeToSession(message.sessionId, message.data || "");
          }
          if (message.type === "terminal:resize") {
            runtime.resizeSession(message.sessionId, { cols: message.cols, rows: message.rows });
          }
        } catch {
          // Ignore malformed remote messages.
        }
      });

      ws.on("close", () => {
        sockets.delete(ws);
      });
    });
  });

  const listenResult = await new Promise((resolve) => {
    server.once("error", (error) => {
      logger.warn(`Remote access server failed: ${error.message}`);
      resolve({ ok: false, error });
    });
    server.listen(port, host, () => resolve({ ok: true }));
  });

  if (!listenResult.ok) {
    unsubscribe.forEach((dispose) => dispose());
    wss.close();
    server.close();
    runtime.setRemoteInfo({ enabled: false, urls: [], port, host, error: listenResult.error.message });
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
    logger.log(`strIDEterm remote access ready: ${urls[0]}`);
  }

  return {
    async close() {
      unsubscribe.forEach((dispose) => dispose());
      for (const socket of sockets) {
        socket.close();
      }
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
