/**
 * What a session minted from a mobile ticket may call on the remote API.
 *
 * The phone's profile allowlist is enforced when the ticket is issued, when a
 * profile is activated and when a terminal is read — and, before this module,
 * nowhere else: every route in `API_ROUTES` ran for a mobile cookie exactly as
 * it does for the master token. This is the ONE place that closes that, called
 * from `handleHttpRequest` before the slot-aware dispatch and `API_ROUTES`.
 *
 * Two layers, both pure:
 *  1. a route that is never available to a mobile session (global security
 *     posture: tokens, tunnels, hooks, profiles, credentials, docker mutation,
 *     file writes, anything that restarts or steers another task);
 *  2. for every other route, a blanket guard over the targets the body names —
 *     a workspace, project, session, connection or profile that EXISTS must
 *     belong to the session's profile. An id that does not exist is allowed:
 *     the renderer generates the id of a new workspace on the client, so the
 *     creation flow arrives with ids the state has never seen, and there is
 *     nothing to protect behind an id that names nothing.
 *
 * `MOBILE_ROUTE_CLASSIFICATION` in the test pins that every `"/api/..."` literal
 * in `remote-server.ts` is classified, so a new route has to be placed here on
 * purpose rather than inheriting "guarded" by default.
 */

export type MobileRouteDenyReason = "route-not-available-to-mobile" | "target-outside-profile";

export type MobileRouteDecision = { allow: true } | { allow: false; reason: MobileRouteDenyReason; detail?: string };

/** How a route is treated for a mobile session. */
export type MobileRouteClass = "deny" | "own-check" | "guarded";

/** Exact routes that are never available. */
export const MOBILE_DENIED_ROUTES: ReadonlySet<string> = new Set([
  "/api/settings/update",
  "/api/azure/save-connection",
  "/api/azure/delete-connection",
  "/api/azure/verify-connection",
  "/api/github/save-connection",
  "/api/github/delete-connection",
  "/api/github/verify-connection",
  "/api/task/reject-verdict",
  "/api/task/resend-instruction",
  "/api/terminal/restart",
  "/api/session/activate",
  "/api/session/activate-in-window",
  "/api/file/write",
  "/api/file/create-file",
  "/api/file/create-dir",
  "/api/file/rename",
  "/api/file/delete",
  "/api/file/git-ignore",
  "/api/file/move",
  "/api/file/copy",
]);

/** Route families that are never available. */
export const MOBILE_DENIED_PREFIXES: readonly string[] = [
  "/api/remote/token/",
  "/api/tunnel/",
  "/api/telegram/",
  "/api/profile/",
  "/api/claude-hook/",
  "/api/gemini-hook/",
  "/api/codex-hook/",
  "/api/copilot-hook/",
  "/api/opencode-hook/",
  // Docker is not bound to a profile: a mutation or a shell acts on the host.
  "/api/docker/",
];

/** The docker routes that only look, carved out of the `/api/docker/` family. */
export const MOBILE_DOCKER_READ_ROUTES: ReadonlySet<string> = new Set([
  "/api/docker/refresh",
  "/api/docker/detail",
  "/api/docker/inspect",
  "/api/docker/top",
  "/api/docker/stats",
  "/api/docker/image/inspect",
  "/api/docker/volume/inspect",
  "/api/docker/network/inspect",
  "/api/docker/system/df",
  "/api/docker/volume/list",
  "/api/docker/volume/read",
  "/api/docker/logs/open",
  "/api/docker/logs/update",
  "/api/docker/logs/close",
]);

/**
 * Routes that carry their own authorization and must not be second-guessed by
 * the body guard (they read the session, not a target named in the body).
 */
export const MOBILE_OWN_CHECK_ROUTES: ReadonlySet<string> = new Set([
  "/api/ssh/capabilities",
  "/api/state",
  "/api/approvals/audit-log",
  "/api/approvals/audit-log/stats",
  "/api/mobile/session/bootstrap",
  "/api/mobile/attachments",
  "/api/attachment/list",
  "/api/attachment/delete",
]);

/**
 * The only `/api/...` routes answered for a method OTHER than POST.
 *
 * The mobile gate (`evaluateMobileSessionRequest`) runs for POST only, so a
 * route that answers a GET/PUT/DELETE is never judged by it. Today these three
 * are the whole list, and each is `own-check`: it reads the session (its
 * profile, or the master token's unbound view) and never a target named in a
 * body. A new non-POST handler must either go behind the gate or be added here
 * and classified on purpose — `mobile-session-route-policy.test.ts` reads
 * `remote-server.ts` and fails otherwise.
 */
export const MOBILE_NON_POST_ROUTES: ReadonlySet<string> = new Set([
  "/api/state",
  "/api/approvals/audit-log",
  "/api/approvals/audit-log/stats",
]);

/**
 * The slim-core detail resources (`DETAIL_ROUTES` in `remote-server.ts`): the
 * other non-POST API routes. They are GET-only and ALSO skip the gate, but are
 * not `own-check` in the table above — the DETAIL_ROUTES branch authorizes the
 * resource itself (`resourceProfileAuthorized` against the session's profile)
 * before it builds anything. The test pins both the list and that check.
 */
export const MOBILE_GET_DETAIL_ROUTES: ReadonlySet<string> = new Set([
  "/api/git/workspace-detail",
  "/api/docker/detail",
  "/api/azure/inbox",
  "/api/github/inbox",
  "/api/azure/pull-request-detail",
  "/api/github/pull-request-detail",
  "/api/review-bridge/pull-request",
  "/api/review-bridge/agent-prompts",
]);

/**
 * Probe routes: classified `guarded`, yet their body names no workspace,
 * session, connection or profile — only a path or a command — so the body guard
 * has nothing to check and a mobile session may point them at ANY path on the
 * desktop. That is accepted, and named here so it is not inherited silently.
 *
 * What a phone learns through them, and nothing more:
 *  - `/api/fs/probe-directory` — the path echoed back, whether it is a git
 *    repository, and the paths of git repositories found up to two directory
 *    levels below it (directory names only, bounded by a read/time budget). A
 *    missing or unreadable directory answers like an empty one.
 *  - `/api/task/check-git-repo` — whether the path is inside a git work tree,
 *    with the reason (`not-a-repo`, `error`) and, on failure, git's stderr.
 *  - `/api/check-command` — whether a command name resolves on PATH
 *    (`where` / `which`), as a boolean.
 * No file contents, no listing of a directory's files.
 *
 * Why it is accepted: creating a workspace from the phone sends a cwd the state
 * has never seen, and the new-workspace dialog probes it first. The browser
 * remote already had the same reach.
 *
 * Rule for the future: any route that reads a path (or runs a command) the body
 * names, without a workspace/profile target the guard can check, must be added
 * here on purpose or be given a target. Never let it inherit "guarded" quietly.
 */
export const MOBILE_PROBE_ROUTES: ReadonlySet<string> = new Set([
  "/api/fs/probe-directory",
  "/api/task/check-git-repo",
  "/api/check-command",
]);

/** Families that carry their own authorization (`/api/mobile/workspaces/*`, `/api/remote-client/*`). */
export const MOBILE_OWN_CHECK_PREFIXES: readonly string[] = ["/api/mobile/workspaces/", "/api/remote-client/"];

export function classifyMobileRoute(pathname: string): MobileRouteClass {
  if (MOBILE_OWN_CHECK_ROUTES.has(pathname) || MOBILE_OWN_CHECK_PREFIXES.some((p) => pathname.startsWith(p))) {
    return "own-check";
  }
  if (MOBILE_DENIED_ROUTES.has(pathname)) return "deny";
  if (MOBILE_DENIED_PREFIXES.some((p) => pathname.startsWith(p))) {
    return MOBILE_DOCKER_READ_ROUTES.has(pathname) ? "guarded" : "deny";
  }
  return "guarded";
}

export interface MobileRouteInput {
  pathname: string;
  body: Record<string, unknown>;
  /** The profile the session is bound to. */
  profileId: string;
  /** Profile of an EXISTING workspace, or undefined when no workspace has that id. */
  workspaceProfile(workspaceId: string): string | undefined;
  /** Profile of an EXISTING azure/github connection, or undefined. */
  connectionProfile(connectionId: string): string | undefined;
}

const WORKSPACE_ID_KEYS = ["workspaceId", "projectId", "parentWorkspaceId"] as const;
const WORKSPACE_ID_LIST_KEYS = ["workspaceIds", "projectIds"] as const;
const SESSION_ID_LIST_KEYS = ["visibleSessionIds"] as const;

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** Workspace id a terminal session id (`<workspaceId>:<panelId>`) belongs to. */
export function workspaceOfSessionId(sessionId: string): string {
  const cut = sessionId.lastIndexOf(":");
  return cut > 0 ? sessionId.slice(0, cut) : sessionId;
}

export function evaluateMobileRoute(input: MobileRouteInput): MobileRouteDecision {
  const { pathname, body, profileId } = input;
  const cls = classifyMobileRoute(pathname);
  if (cls === "own-check") return { allow: true };
  if (cls === "deny") {
    return { allow: false, reason: "route-not-available-to-mobile" };
  }

  const outside = (kind: string, id: string): MobileRouteDecision => ({
    allow: false,
    reason: "target-outside-profile",
    detail: `${kind} ${id}`,
  });
  const checkWorkspace = (id: string): boolean => {
    const owner = input.workspaceProfile(id);
    return owner === undefined || owner === profileId;
  };

  for (const key of WORKSPACE_ID_KEYS) {
    const id = body[key];
    if (typeof id === "string" && id && !checkWorkspace(id)) return outside("workspace", id);
  }
  for (const key of ["workspace", "project"] as const) {
    const nested = body[key];
    const id = nested && typeof nested === "object" ? (nested as { id?: unknown }).id : undefined;
    if (typeof id === "string" && id && !checkWorkspace(id)) return outside("workspace", id);
  }
  for (const key of WORKSPACE_ID_LIST_KEYS) {
    for (const id of asStrings(body[key])) if (!checkWorkspace(id)) return outside("workspace", id);
  }
  const sessionIds = [
    ...(typeof body.sessionId === "string" ? [body.sessionId] : []),
    ...SESSION_ID_LIST_KEYS.flatMap((key) => asStrings(body[key])),
  ];
  for (const id of sessionIds) {
    if (id && !checkWorkspace(workspaceOfSessionId(id))) return outside("session", id);
  }
  const connectionId = body.connectionId;
  if (typeof connectionId === "string" && connectionId) {
    const owner = input.connectionProfile(connectionId);
    if (owner !== undefined && owner !== profileId) return outside("connection", connectionId);
  }
  const asserted = body.profileId;
  if (typeof asserted === "string" && asserted && asserted !== profileId) return outside("profile", asserted);
  return { allow: true };
}
