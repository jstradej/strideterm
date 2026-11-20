import type { PeerAttachedHost, PeerHostLinkState, WindowBackend } from "../electron/shared/peers.js";

export type PeerWindowBackend = Extract<WindowBackend, { kind: "peer" }>;

/** Why a window attached to another desktop cannot show its host. */
export type PeerFailureReason = "offline" | "not-paired" | "wrong-host" | "version-mismatch" | "session-ended";

export interface PeerFailure {
  reason: PeerFailureReason;
  title: string;
  message: string;
}

/** The reasons no amount of retrying changes: the window stops reconnecting and waits for the user. */
export function isFinalPeerReason(reason: PeerFailureReason): boolean {
  return reason === "not-paired" || reason === "wrong-host" || reason === "version-mismatch";
}

/** What `refreshPeerHost` learned, as the reason the window shows. `online` or no answer keeps `fallback`. */
export function peerFailureFrom(
  host: Pick<PeerAttachedHost, "state" | "hostAppVersion" | "localAppVersion"> | null,
  hostLabel: string,
  fallback: "offline" | "session-ended",
): PeerFailure {
  const state: PeerHostLinkState | "none" = host?.state ?? "none";
  switch (state) {
    case "not-paired":
      return {
        reason: "not-paired",
        title: `${hostLabel} no longer accepts this desktop`,
        message: "Pair this desktop with it again from Profiles.",
      };
    case "wrong-host":
      return {
        reason: "wrong-host",
        title: `The address of ${hostLabel} now answers as another strIDEterm`,
        message: "Check the address in Profiles, or pair this desktop again.",
      };
    case "version-mismatch":
      return {
        reason: "version-mismatch",
        title: `${hostLabel} runs a different strIDEterm version`,
        message: `${hostLabel} runs ${host?.hostAppVersion || "an unknown version"} and this desktop runs ${
          host?.localAppVersion || "an unknown version"
        }. Update the older one so that both match.`,
      };
    default:
      return fallback === "session-ended"
        ? {
            reason: "session-ended",
            title: `The connection to ${hostLabel} was closed`,
            message: "Reconnect to continue.",
          }
        : {
            reason: "offline",
            title: `${hostLabel} cannot be reached`,
            message:
              "Check that strIDEterm is running on that computer and that both computers are on the same network.",
          };
  }
}

/** The banner of a short disconnect, naming the host. The `Reconnecting in Ns...` countdown is kept for the hero. */
export function peerDisconnectMessage(hostLabel: string, transportMessage: string, reconnecting: boolean): string {
  const countdown = /Reconnecting in \d+s\.\.\./i.exec(transportMessage)?.[0];
  if (countdown) return `Connection to ${hostLabel} lost. ${countdown}`;
  return reconnecting ? `Connection to ${hostLabel} lost. Reconnecting...` : `Cannot reach ${hostLabel} right now.`;
}
