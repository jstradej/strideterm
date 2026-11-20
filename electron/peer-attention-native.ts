export interface PeerHostBadgeInput {
  /** The host's own total from the last successful poll; null before the first one. */
  polledTotal: number | null;
  /** Counts the host's open windows last reported, one per window. */
  windowCounts: number[];
}

/**
 * The app badge: this machine's alerts plus, per attached host, its polled total. Two windows on one profile must
 * not count twice and a host's other profiles must count, so window-reported numbers are only the stand-in until a
 * host has answered once.
 */
export function computeAppBadge(localTotal: number, hosts: PeerHostBadgeInput[]): number {
  let total = localTotal;
  for (const host of hosts) {
    total += host.polledTotal ?? Math.max(0, ...host.windowCounts);
  }
  return total;
}

/** A rise that nobody is looking at: not the first answer, and no window of that host has focus. */
export function shouldNotifyPeerAttention(input: {
  previousTotal: number | null;
  total: number;
  hostWindowFocused: boolean;
}): boolean {
  return input.previousTotal !== null && input.total > input.previousTotal && !input.hostWindowFocused;
}

export function peerAttentionBody(total: number): string {
  return `${total} ${total === 1 ? "item needs" : "items need"} your attention`;
}

export function topAttentionProfile(profiles: Array<{ profileId: string; count: number }>): string | null {
  let best: { profileId: string; count: number } | null = null;
  for (const profile of profiles) {
    if (profile.count > 0 && (!best || profile.count > best.count)) best = profile;
  }
  return best?.profileId ?? null;
}

/** An open window of the host, preferring the profile with the most alerts; null when the host has none open. */
export function pickPeerWindowToFocus(
  windows: Array<{ id: string; remoteProfileId: string }>,
  profiles: Array<{ profileId: string; count: number }>,
): string | null {
  let best: { id: string; count: number } | null = null;
  for (const window of windows) {
    const count = profiles.find((profile) => profile.profileId === window.remoteProfileId)?.count ?? 0;
    if (!best || count > best.count) best = { id: window.id, count };
  }
  return best?.id ?? null;
}
