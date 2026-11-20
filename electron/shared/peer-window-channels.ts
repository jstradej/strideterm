/**
 * The IPC channels a window attached to another desktop may still call on this machine. Such a window runs the
 * local renderer with the full preload, but every piece of workspace, terminal, file, git, settings, credential
 * or state data it shows comes from the host over the peer link. A renderer path that bypassed the transport
 * would otherwise hit THIS runtime with ids that belong to the host, so anything not named here is refused.
 *
 * Hosting (`peers:host:*`) is managed from a local window and is deliberately absent.
 */
export const PEER_WINDOW_ALLOWED_CHANNELS: ReadonlySet<string> = new Set([
  "window:get-backend",
  "peers:client:list",
  "peers:client:refresh",
  "peers:client:pair:start",
  "peers:client:pair:cancel",
  "peers:client:remove",
  "peers:client:update-address",
  "peers:local-profiles",
  "peers:window:open",
  "peers:window:activate",
  "peers:window:activate-local",
  "peers:window:set-profile",
  "peers:window:attention",
  "peers:window:font-size",
  "peer:http",
  "peer:ws:open",
  "peer:ws:send",
  "peer:ws:close",
  "notification:show-system",
  "log:renderer",
  // Opens an http(s) URL in this machine's browser; touches no data.
  "shell:open-external",
  // This window's own chrome and lifecycle. window:create opens a window of a LOCAL profile.
  "window:get-id",
  "window:focus-current",
  "window:create",
  "window:close",
  "window:confirm-close-response",
  // Updates of this app, and diagnostics of this process.
  "app:update-status",
  "app:download-update",
  "app:open-update-release",
  "app:restart-for-update",
  "perf:get-snapshot",
  "perf:capture-cpu-profile",
  "perf:reveal-cpu-profile",
]);

/**
 * The events pushed into a window attached to another desktop. The local runtime broadcasts its own state, terminal
 * output and notifications to every window; none of that belongs in a window whose data comes from the host. The
 * window-level ones are sent to one window directly and listed so a new one needs a decision.
 */
export const PEER_WINDOW_EVENT_PREFIXES: readonly string[] = ["peers:", "peer:"];
export const PEER_WINDOW_ALLOWED_EVENTS: ReadonlySet<string> = new Set([
  "app:update-status-changed",
  "window:visibility",
  "window:confirm-close-request",
  "shortcut:new-window",
]);

export const PEER_WINDOW_REFUSED_MESSAGE = "This action is not available in a window attached to another desktop.";

export function isChannelAllowedInPeerWindow(channel: string): boolean {
  return PEER_WINDOW_ALLOWED_CHANNELS.has(channel);
}

export function isEventAllowedInPeerWindow(channel: string): boolean {
  return (
    PEER_WINDOW_ALLOWED_EVENTS.has(channel) || PEER_WINDOW_EVENT_PREFIXES.some((prefix) => channel.startsWith(prefix))
  );
}
