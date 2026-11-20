/**
 * A paired desktop has the rights of a remote browser client, minus the host's own remote-access
 * posture (token, tunnels), its profile list, and its agent hook installation. Everything else goes
 * through the ordinary remote API, which already applies every remote-viewer restriction.
 */
export const PEER_DENIED_ROUTES: ReadonlySet<string> = new Set([
  "/api/remote/token/regenerate",
  "/api/tunnel/create",
  "/api/tunnel/stop",
  "/api/profile/save",
  "/api/profile/delete",
  ...["claude", "gemini", "codex", "copilot", "opencode"].flatMap((agent) =>
    ["configure", "remove", "test"].map((action) => `/api/${agent}-hook/${action}`),
  ),
]);

export function isPeerDeniedRoute(pathname: string): boolean {
  return PEER_DENIED_ROUTES.has(pathname);
}
