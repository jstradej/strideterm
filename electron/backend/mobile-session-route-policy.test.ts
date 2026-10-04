import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  MOBILE_DENIED_PREFIXES,
  MOBILE_GET_DETAIL_ROUTES,
  MOBILE_NON_POST_ROUTES,
  MOBILE_PROBE_ROUTES,
  classifyMobileRoute,
  evaluateMobileRoute,
  type MobileRouteClass,
  type MobileRouteInput,
} from "./mobile-session-route-policy.js";

const PROFILE = "home";
const WORKSPACES: Record<string, string> = { "ws-home": "home", "ws-work": "work" };
const CONNECTIONS: Record<string, string> = { "az-home": "home", "az-work": "work" };

function decide(pathname: string, body: Record<string, unknown> = {}) {
  const input: MobileRouteInput = {
    pathname,
    body,
    profileId: PROFILE,
    workspaceProfile: (id) => WORKSPACES[id],
    connectionProfile: (id) => CONNECTIONS[id],
  };
  return evaluateMobileRoute(input);
}

/**
 * Every `"/api/..."` literal in remote-server.ts, and what a mobile session gets for it.
 * A route added to the server without a line here fails the completeness test below:
 * it has to be placed on purpose, never inherited.
 *   deny       never available to a mobile session
 *   own-check  carries its own authorization (the session itself, not a target in the body)
 *   guarded    allowed, with the blanket profile guard over the targets its body names
 */
const MOBILE_ROUTE_CLASSIFICATION: Record<string, MobileRouteClass> = {
  "/api/ssh/capabilities": "own-check",
  "/api/azure/delete-connection": "deny",
  "/api/azure/save-connection": "deny",
  "/api/azure/verify-connection": "deny",
  "/api/claude-hook/configure": "deny",
  "/api/claude-hook/remove": "deny",
  "/api/claude-hook/status": "deny",
  "/api/claude-hook/test": "deny",
  "/api/codex-hook/configure": "deny",
  "/api/codex-hook/remove": "deny",
  "/api/codex-hook/status": "deny",
  "/api/codex-hook/test": "deny",
  "/api/copilot-hook/configure": "deny",
  "/api/copilot-hook/remove": "deny",
  "/api/copilot-hook/status": "deny",
  "/api/copilot-hook/test": "deny",
  "/api/docker/action": "deny",
  "/api/docker/builder/prune": "deny",
  "/api/docker/compose-action": "deny",
  "/api/docker/image/prune": "deny",
  "/api/docker/image/pull": "deny",
  "/api/docker/image/remove": "deny",
  "/api/docker/network/prune": "deny",
  "/api/docker/network/remove": "deny",
  "/api/docker/open-lazydocker": "deny",
  "/api/docker/open-session": "deny",
  "/api/docker/shell/close": "deny",
  "/api/docker/shell/open": "deny",
  "/api/docker/volume/prune": "deny",
  "/api/docker/volume/remove": "deny",
  "/api/file/copy": "deny",
  "/api/file/create-dir": "deny",
  "/api/file/create-file": "deny",
  "/api/file/delete": "deny",
  "/api/file/git-ignore": "deny",
  "/api/file/move": "deny",
  "/api/file/rename": "deny",
  "/api/file/write": "deny",
  "/api/gemini-hook/configure": "deny",
  "/api/gemini-hook/remove": "deny",
  "/api/gemini-hook/status": "deny",
  "/api/gemini-hook/test": "deny",
  "/api/github/delete-connection": "deny",
  "/api/github/save-connection": "deny",
  "/api/github/verify-connection": "deny",
  "/api/opencode-hook/configure": "deny",
  "/api/opencode-hook/remove": "deny",
  "/api/opencode-hook/status": "deny",
  "/api/opencode-hook/test": "deny",
  "/api/profile/delete": "deny",
  "/api/profile/save": "deny",
  "/api/remote/token/regenerate": "deny",
  "/api/session/activate": "deny",
  "/api/session/activate-in-window": "deny",
  "/api/settings/update": "deny",
  "/api/task/reject-verdict": "deny",
  "/api/task/resend-instruction": "deny",
  "/api/telegram/delete-connection": "deny",
  "/api/telegram/detect-chats": "deny",
  "/api/telegram/refresh": "deny",
  "/api/telegram/save-connection": "deny",
  "/api/telegram/verify-connection": "deny",
  "/api/terminal/restart": "deny",
  "/api/tunnel/create": "deny",
  "/api/tunnel/refresh": "deny",
  "/api/tunnel/stop": "deny",
  "/api/approvals/audit-log": "own-check",
  "/api/approvals/audit-log/stats": "own-check",
  "/api/attachment/delete": "own-check",
  "/api/attachment/list": "own-check",
  "/api/mobile/attachments": "own-check",
  "/api/mobile/session/bootstrap": "own-check",
  "/api/mobile/workspaces/": "own-check",
  "/api/mobile/workspaces/create": "own-check",
  "/api/mobile/workspaces/directories/create": "own-check",
  "/api/mobile/workspaces/directories/list": "own-check",
  "/api/mobile/workspaces/scratchpads/create": "own-check",
  "/api/mobile/workspaces/scratchpads/discard": "own-check",
  "/api/mobile/workspaces/scratchpads/keep": "own-check",
  "/api/mobile/workspaces/scratchpads/list": "own-check",
  "/api/remote-client/": "own-check",
  "/api/remote-client/profile/activate": "own-check",
  "/api/remote-client/session/activate": "own-check",
  "/api/remote-client/workspace/activate": "own-check",
  "/api/state": "own-check",
  "/api/": "guarded",
  "/api/attention/clear-all": "guarded",
  "/api/attention/clear-session": "guarded",
  "/api/attention/sync": "guarded",
  "/api/azure/audit-log/query": "guarded",
  "/api/azure/audit-log/stats": "guarded",
  "/api/azure/create-pull-request": "guarded",
  "/api/azure/inbox": "guarded",
  "/api/azure/list-remote-branches": "guarded",
  "/api/azure/pipelines/build-log": "guarded",
  "/api/azure/pipelines/cancel": "guarded",
  "/api/azure/pipelines/commits": "guarded",
  "/api/azure/pipelines/list": "guarded",
  "/api/azure/pipelines/refs": "guarded",
  "/api/azure/pipelines/run": "guarded",
  "/api/azure/pipelines/run-detail": "guarded",
  "/api/azure/pipelines/run-parameters": "guarded",
  "/api/azure/pipelines/run-seed": "guarded",
  "/api/azure/pipelines/run-status": "guarded",
  "/api/azure/pipelines/runs": "guarded",
  "/api/azure/pull-request-detail": "guarded",
  "/api/azure/pull-request/comment": "guarded",
  "/api/azure/pull-request/open": "guarded",
  "/api/azure/pull-request/seen": "guarded",
  "/api/azure/pull-request/thread-status": "guarded",
  "/api/azure/pull-request/vote": "guarded",
  "/api/azure/quickfix/create": "guarded",
  "/api/azure/quickfix/list-branches": "guarded",
  "/api/azure/quickfix/list-projects": "guarded",
  "/api/azure/quickfix/list-repositories": "guarded",
  "/api/azure/refresh": "guarded",
  "/api/azure/rerun-check": "guarded",
  "/api/azure/workspace/fetch": "guarded",
  "/api/azure/workspace/push": "guarded",
  "/api/azure/workspace/rebase": "guarded",
  "/api/azure/workspace/sync": "guarded",
  "/api/check-command": "guarded",
  "/api/docker/detail": "guarded",
  "/api/docker/image/inspect": "guarded",
  "/api/docker/inspect": "guarded",
  "/api/docker/logs/close": "guarded",
  "/api/docker/logs/open": "guarded",
  "/api/docker/logs/update": "guarded",
  "/api/docker/network/inspect": "guarded",
  "/api/docker/refresh": "guarded",
  "/api/docker/stats": "guarded",
  "/api/docker/system/df": "guarded",
  "/api/docker/top": "guarded",
  "/api/docker/volume/inspect": "guarded",
  "/api/docker/volume/list": "guarded",
  "/api/docker/volume/read": "guarded",
  "/api/file/clipboard-copy": "guarded",
  "/api/file/commit-diff": "guarded",
  "/api/file/commit-files": "guarded",
  "/api/file/git-diff": "guarded",
  "/api/file/git-refs": "guarded",
  "/api/file/git-status": "guarded",
  "/api/file/info": "guarded",
  "/api/file/list": "guarded",
  "/api/file/open-in-editor": "guarded",
  "/api/file/open-in-explorer": "guarded",
  "/api/file/preview": "guarded",
  "/api/file/read": "guarded",
  "/api/file/tree": "guarded",
  "/api/fs/probe-directory": "guarded",
  "/api/git/abort": "guarded",
  "/api/git/checkout-branch": "guarded",
  "/api/git/checkout-remote-branch": "guarded",
  "/api/git/cherry-pick": "guarded",
  "/api/git/commit-all": "guarded",
  "/api/git/commit-diff": "guarded",
  "/api/git/commit-info": "guarded",
  "/api/git/compare-branch": "guarded",
  "/api/git/conflict-detail": "guarded",
  "/api/git/continue": "guarded",
  "/api/git/create-branch": "guarded",
  "/api/git/create-tag": "guarded",
  "/api/git/create-worktree": "guarded",
  "/api/git/delete-branch": "guarded",
  "/api/git/delete-remote-branch": "guarded",
  "/api/git/delete-remote-tag": "guarded",
  "/api/git/delete-tag": "guarded",
  "/api/git/diff-preview": "guarded",
  "/api/git/fetch": "guarded",
  "/api/git/force-push-with-lease": "guarded",
  "/api/git/list-branches": "guarded",
  "/api/git/list-conflicts": "guarded",
  "/api/git/list-tags": "guarded",
  "/api/git/log-graph": "guarded",
  "/api/git/log-page": "guarded",
  "/api/git/merge-into-base": "guarded",
  "/api/git/merge-into-current": "guarded",
  "/api/git/open-lazygit": "guarded",
  "/api/git/pull": "guarded",
  "/api/git/push": "guarded",
  "/api/git/push-all-tags": "guarded",
  "/api/git/push-tag": "guarded",
  "/api/git/rebase-onto": "guarded",
  "/api/git/refresh": "guarded",
  "/api/git/remove-worktree": "guarded",
  "/api/git/rename-branch": "guarded",
  "/api/git/resolve-conflict": "guarded",
  "/api/git/skip": "guarded",
  "/api/git/squash-commits": "guarded",
  "/api/git/stash": "guarded",
  "/api/git/stash-apply": "guarded",
  "/api/git/stash-branch": "guarded",
  "/api/git/stash-drop": "guarded",
  "/api/git/stash-export": "guarded",
  "/api/git/stash-file-diff": "guarded",
  "/api/git/stash-files": "guarded",
  "/api/git/stash-import": "guarded",
  "/api/git/stash-list": "guarded",
  "/api/git/stash-pop": "guarded",
  "/api/git/unresolve-conflict": "guarded",
  "/api/git/workspace-detail": "guarded",
  "/api/github/audit-log/query": "guarded",
  "/api/github/audit-log/stats": "guarded",
  "/api/github/create-pull-request": "guarded",
  "/api/github/inbox": "guarded",
  "/api/github/list-remote-branches": "guarded",
  "/api/github/pull-request-detail": "guarded",
  "/api/github/pull-request/comment": "guarded",
  "/api/github/pull-request/open": "guarded",
  "/api/github/pull-request/review": "guarded",
  "/api/github/pull-request/seen": "guarded",
  "/api/github/quickfix/create": "guarded",
  "/api/github/quickfix/list-branches": "guarded",
  "/api/github/quickfix/list-repos": "guarded",
  "/api/github/refresh": "guarded",
  "/api/github/rerun-check": "guarded",
  "/api/github/workspace/fetch": "guarded",
  "/api/github/workspace/push": "guarded",
  "/api/github/workspace/rebase": "guarded",
  "/api/github/workspace/sync": "guarded",
  "/api/project/activate": "guarded",
  "/api/project/delete": "guarded",
  "/api/project/reorder": "guarded",
  "/api/project/save": "guarded",
  "/api/review-bridge/agent-prompt/reset": "guarded",
  "/api/review-bridge/agent-prompts": "guarded",
  "/api/review-bridge/comment/delete": "guarded",
  "/api/review-bridge/comment/reply-with-changes": "guarded",
  "/api/review-bridge/draft-comment/create": "guarded",
  "/api/review-bridge/draft/delete": "guarded",
  "/api/review-bridge/draft/queue": "guarded",
  "/api/review-bridge/draft/save": "guarded",
  "/api/review-bridge/pull-request": "guarded",
  "/api/review-bridge/pull-request/push-and-publish": "guarded",
  "/api/review-bridge/pull-request/sync": "guarded",
  "/api/session/take-control": "guarded",
  "/api/ssh/auth/answer": "guarded",
  "/api/ssh/auth/cancel": "guarded",
  "/api/ssh/certs/delete": "guarded",
  "/api/ssh/certs/import": "guarded",
  "/api/ssh/certs/list": "guarded",
  "/api/ssh/config/import": "guarded",
  "/api/ssh/config/preview": "guarded",
  "/api/ssh/host-key/accept": "guarded",
  "/api/ssh/host-key/reject": "guarded",
  "/api/ssh/hosts/create": "guarded",
  "/api/ssh/hosts/delete": "guarded",
  "/api/ssh/hosts/duplicate": "guarded",
  "/api/ssh/hosts/list": "guarded",
  "/api/ssh/hosts/test": "guarded",
  "/api/ssh/hosts/update": "guarded",
  "/api/ssh/keys/delete": "guarded",
  "/api/ssh/keys/generate": "guarded",
  "/api/ssh/keys/import": "guarded",
  "/api/ssh/keys/list": "guarded",
  "/api/ssh/keys/rename": "guarded",
  "/api/ssh/keys/transfer/start": "guarded",
  "/api/ssh/keys/transfer/stop": "guarded",
  "/api/ssh/known-hosts/import": "guarded",
  "/api/task-recovery/resolve": "guarded",
  "/api/task/answer-companion": "guarded",
  "/api/task/check-git-repo": "guarded",
  "/api/task/check-providers": "guarded",
  "/api/task/create": "guarded",
  "/api/task/create-companion": "guarded",
  "/api/task/pause": "guarded",
  "/api/task/recheck-claude": "guarded",
  "/api/task/reset": "guarded",
  "/api/task/resume": "guarded",
  "/api/task/start": "guarded",
  "/api/task/status": "guarded",
  "/api/task/stop": "guarded",
  "/api/task/update-description": "guarded",
  "/api/terminal/replay": "guarded",
  "/api/workspace-grid/disable": "guarded",
  "/api/workspace-grid/enable": "guarded",
  "/api/workspace-grid/set-cell": "guarded",
  "/api/workspace-grid/set-layout": "guarded",
  "/api/workspace-grid/swap-cells": "guarded",
  "/api/workspace/activate": "guarded",
  "/api/workspace/delete": "guarded",
  "/api/workspace/reorder": "guarded",
  "/api/workspace/save": "guarded",
  "/api/workspace/set-ui-state": "guarded",
};

describe("mobile session route policy", () => {
  test("every /api literal in remote-server.ts is classified, and the policy agrees with the table", () => {
    const source = fs.readFileSync(path.join(__dirname, "remote-server.ts"), "utf8");
    const literals = [...new Set([...source.matchAll(/"(\/api\/[^"]*)"/g)].map((m) => m[1]))].sort();
    const unclassified = literals.filter((route) => !(route in MOBILE_ROUTE_CLASSIFICATION));
    expect(unclassified, "add the new route(s) to MOBILE_ROUTE_CLASSIFICATION on purpose").toEqual([]);
    const stale = Object.keys(MOBILE_ROUTE_CLASSIFICATION).filter((route) => !literals.includes(route));
    expect(stale, "routes no longer in remote-server.ts").toEqual([]);
    for (const route of literals) {
      expect(classifyMobileRoute(route), route).toBe(MOBILE_ROUTE_CLASSIFICATION[route]);
    }
  });

  test.each([
    "/api/remote/token/regenerate",
    "/api/tunnel/create",
    "/api/tunnel/stop",
    "/api/telegram/save-connection",
    "/api/telegram/delete-connection",
    "/api/profile/save",
    "/api/profile/delete",
    "/api/claude-hook/configure",
    "/api/gemini-hook/remove",
    "/api/codex-hook/configure",
    "/api/copilot-hook/configure",
    "/api/opencode-hook/configure",
    "/api/docker/action",
    "/api/docker/compose-action",
    "/api/docker/image/remove",
    "/api/docker/volume/prune",
    "/api/docker/open-session",
    "/api/docker/open-lazydocker",
    "/api/docker/shell/open",
    "/api/docker/shell/close",
    "/api/settings/update",
    "/api/azure/save-connection",
    "/api/azure/delete-connection",
    "/api/github/save-connection",
    "/api/github/delete-connection",
    "/api/task/reject-verdict",
    "/api/task/resend-instruction",
    "/api/terminal/restart",
    "/api/session/activate",
    "/api/file/write",
    "/api/file/create-file",
    "/api/file/create-dir",
    "/api/file/rename",
    "/api/file/delete",
    "/api/file/move",
    "/api/file/copy",
    "/api/file/git-ignore",
  ])("%s is never available to a mobile session", (route) => {
    expect(decide(route, { workspaceId: "ws-home" })).toMatchObject({ allow: false });
  });

  test("the docker family is denied except for routes that only look", () => {
    for (const route of [
      "/api/docker/refresh",
      "/api/docker/inspect",
      "/api/docker/top",
      "/api/docker/stats",
      "/api/docker/system/df",
      "/api/docker/volume/list",
      "/api/docker/volume/read",
      "/api/docker/logs/open",
      "/api/docker/logs/update",
      "/api/docker/logs/close",
    ]) {
      expect(decide(route), route).toEqual({ allow: true });
    }
    expect(MOBILE_DENIED_PREFIXES).toContain("/api/docker/");
  });

  test("settings/update is refused for a phone, whatever the body", () => {
    for (const settings of [{ terminalFontSizeRemote: 14 }, { externalEditor: "x" }, {}]) {
      expect(decide("/api/settings/update", { settings }), JSON.stringify(settings)).toMatchObject({
        allow: false,
        reason: "route-not-available-to-mobile",
      });
    }
  });

  test("a workspace, project or session of another profile is refused on any guarded route", () => {
    for (const route of ["/api/git/refresh", "/api/task/stop", "/api/workspace/delete", "/api/file/read"]) {
      expect(decide(route, { workspaceId: "ws-work" }), route).toMatchObject({
        allow: false,
        reason: "target-outside-profile",
      });
    }
    expect(decide("/api/git/refresh", { projectId: "ws-work" })).toMatchObject({ allow: false });
    expect(decide("/api/git/create-worktree", { parentWorkspaceId: "ws-work" })).toMatchObject({ allow: false });
    expect(decide("/api/task/stop", { sessionId: "ws-work:panel-1" })).toMatchObject({ allow: false });
    expect(decide("/api/attention/sync", { visibleSessionIds: ["ws-home:a", "ws-work:b"] })).toMatchObject({
      allow: false,
    });
    expect(decide("/api/workspace/reorder", { workspaceIds: ["ws-home", "ws-work"] })).toMatchObject({ allow: false });
    expect(decide("/api/workspace/save", { workspace: { id: "ws-work" } })).toMatchObject({ allow: false });
    expect(decide("/api/azure/pipelines/run", { connectionId: "az-work" })).toMatchObject({ allow: false });
    expect(decide("/api/workspace/save", { profileId: "work" })).toMatchObject({ allow: false });
  });

  test("the caller's own profile, and ids that name nothing yet, pass", () => {
    expect(decide("/api/task/stop", { workspaceId: "ws-home" })).toEqual({ allow: true });
    expect(decide("/api/task/stop", { sessionId: "ws-home:panel-1" })).toEqual({ allow: true });
    expect(decide("/api/azure/pipelines/run", { connectionId: "az-home" })).toEqual({ allow: true });
    // The renderer generates the id of a new workspace on the client, so creating one sends an
    // id the state has never seen: there is nothing behind it to protect.
    expect(decide("/api/workspace/save", { workspace: { id: "workspace-new-uuid", cwd: "/anywhere" } })).toEqual({
      allow: true,
    });
    expect(decide("/api/task/create", { workspaceId: "workspace-new-uuid" })).toEqual({ allow: true });
  });

  test("routes that carry their own authorization are not judged by the body guard", () => {
    for (const route of [
      "/api/state",
      "/api/mobile/attachments",
      "/api/mobile/workspaces/create",
      "/api/remote-client/profile/activate",
    ]) {
      expect(decide(route, { workspaceId: "ws-work", profileId: "work" }), route).toEqual({ allow: true });
    }
  });
});

function readRemoteServerSource(): string {
  return fs.readFileSync(path.join(__dirname, "remote-server.ts"), "utf8");
}

const sorted = (values: Iterable<string>) => [...values].sort();

describe("mobile route gate: methods other than POST", () => {
  // The gate in remote-server.ts runs for `request.method === "POST"` only. A route that answers
  // any other method therefore skips it. That has been harmless because the few such routes
  // authorize themselves — but it was an accident of the code, not a property anyone pinned.
  //
  // WHAT A FAILURE HERE MEANS: you added (or changed) a handler that reads `request.method` for a
  // method other than POST. Either put that route behind the mobile gate (run the gate for its
  // method too), or add it to MOBILE_NON_POST_ROUTES in mobile-session-route-policy.ts and
  // classify it "own-check" on purpose, with a reason it cannot name another profile's target.
  test("every /api route answered for a non-POST method is on the explicit allowlist", () => {
    let rest = readRemoteServerSource();
    const routes: string[] = [];

    // `request.method === "GET" && url.pathname === "/api/..."` (any non-POST method, any whitespace).
    rest = rest.replace(
      /request\.method === "(?:GET|HEAD|PUT|PATCH|DELETE|OPTIONS)"\s*&&\s*url\.pathname === "([^"]*)"/g,
      (_match, route: string) => {
        routes.push(route);
        return "";
      },
    );
    // The detail-resource table is looked up for GET only; its keys are pinned in the next test.
    rest = rest.replace(/request\.method === "GET" \? DETAIL_ROUTES\[url\.pathname\]/g, "");
    // A POST comparison and a log field (`method: request.method`) are not a non-POST handler.
    rest = rest.replace(/request\.method === "POST"/g, "").replace(/\bmethod: request\.method\b/g, "");

    const apiRoutes = routes.filter((route) => route.startsWith("/api/"));
    expect(sorted(apiRoutes)).toEqual(sorted(MOBILE_NON_POST_ROUTES));

    // Any other way of branching on the method is a handler this test cannot classify: refuse it
    // rather than guess (`!== "POST"`, `switch (request.method)`, `req.method`, `{ method } = request`).
    expect(rest.match(/\brequest\.method\b[^\n]*/g) ?? [], "unrecognised use of request.method").toEqual([]);
    expect(rest.match(/(?<!request)(?<!ctx\?)\.method\b[^\n]*/g) ?? [], "unrecognised .method access").toEqual([]);
    expect(rest.match(/\{[^{}]*\bmethod\b[^{}]*\}\s*=\s*(?:request|req)\b/g) ?? []).toEqual([]);

    // The two dispatchers that would answer a non-POST request are POST-only.
    const source = readRemoteServerSource();
    expect(source).toMatch(/if \(request\.method === "POST"\) \{\s*const handler = API_ROUTES\[url\.pathname\];/);
    expect(source).toMatch(/request\.method === "POST" \? slotAwareRoute\[url\.pathname\]/);
  });

  test("each non-POST route is classified own-check", () => {
    for (const route of MOBILE_NON_POST_ROUTES) {
      expect(MOBILE_ROUTE_CLASSIFICATION[route], route).toBe("own-check");
      expect(classifyMobileRoute(route), route).toBe("own-check");
    }
  });

  test("the GET detail table is exactly the allowlisted set, and authorizes the resource before building it", () => {
    const source = readRemoteServerSource();
    const start = source.indexOf("const DETAIL_ROUTES");
    expect(start, "DETAIL_ROUTES not found").toBeGreaterThan(-1);
    const end = source.indexOf("\n  };", start);
    const keys = [...source.slice(start, end).matchAll(/^ {4}"(\/api\/[^"]+)":/gm)].map((m) => m[1]);
    expect(sorted(keys)).toEqual(sorted(MOBILE_GET_DETAIL_ROUTES));
    for (const route of MOBILE_GET_DETAIL_ROUTES) {
      expect(MOBILE_ROUTE_CLASSIFICATION[route], route).toBeDefined();
    }

    // These skip the gate (GET), so the profile check is the branch's own, and it must precede the build.
    const branch = source.indexOf('request.method === "GET" ? DETAIL_ROUTES[url.pathname]');
    const authorize = source.indexOf("resourceProfileAuthorized(rawPayload, profileId, resourceKey)", branch);
    const build = source.indexOf("buildResourceDetail(rawPayload, profileId, resourceKey)", branch);
    expect(branch).toBeGreaterThan(-1);
    expect(authorize, "detail branch must authorize the resource").toBeGreaterThan(branch);
    expect(build, "detail branch must build the resource").toBeGreaterThan(authorize);
  });
});

describe("mobile probe routes", () => {
  // These routes name a path or a command in the body and no workspace/profile target, so the body
  // guard has nothing to check: a phone can probe any directory / command on the desktop. See the
  // doc comment on MOBILE_PROBE_ROUTES for exactly what that reveals and why it is accepted.
  //
  // WHAT A FAILURE HERE MEANS: a route in the set was renamed or removed (update the set), or you
  // are adding a route that reads a body-named path without a target — add it to
  // MOBILE_PROBE_ROUTES on purpose, or give it a workspace/profile target the guard can check.
  test("each probe route is classified guarded", () => {
    expect([...MOBILE_PROBE_ROUTES].sort()).toEqual([
      "/api/check-command",
      "/api/fs/probe-directory",
      "/api/task/check-git-repo",
    ]);
    for (const route of MOBILE_PROBE_ROUTES) {
      expect(MOBILE_ROUTE_CLASSIFICATION[route], route).toBe("guarded");
      expect(classifyMobileRoute(route), route).toBe("guarded");
    }
  });

  test("a mobile body naming an arbitrary path or command is allowed", () => {
    for (const route of MOBILE_PROBE_ROUTES) {
      expect(decide(route, { cwd: "/etc", path: String.raw`C:\Windows\System32`, command: "git" }), route).toEqual({
        allow: true,
      });
    }
  });

  test("every probe route exists as a literal in remote-server.ts", () => {
    const source = readRemoteServerSource();
    for (const route of MOBILE_PROBE_ROUTES) {
      expect(source, route).toContain(`"${route}"`);
    }
  });
});
