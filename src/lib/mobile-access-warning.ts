export type MobileAccessWarning =
  "trial-expired" | "trial-expiring" | "access-expired" | "access-expiring" | "authorization-denied";

export const MOBILE_TRIAL_WARNING_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
export const MOBILE_ACCESS_CRITICAL_WINDOW_MS = 24 * 60 * 60 * 1000;
export const MOBILE_WARNING_PULSE_INTERVAL_MS = 15 * 60 * 1000;
export const MOBILE_CRITICAL_PULSE_INTERVAL_MS = 60 * 60 * 1000;

export function getMobileAccessDeadline(
  entitlement: { state?: string; source?: string; notAfter?: number; cancellationAt?: number } | null | undefined,
): number | null {
  if (entitlement?.state === "active" && entitlement.source === "subscription") {
    const cancellationAt = entitlement.cancellationAt;
    return typeof cancellationAt === "number" && Number.isFinite(cancellationAt) && cancellationAt > 0
      ? cancellationAt
      : null;
  }
  const deadline = entitlement?.notAfter;
  if (typeof deadline !== "number" || !Number.isFinite(deadline) || deadline <= 0) return null;
  if (entitlement?.state === "trial") return deadline;
  if (
    (entitlement?.state === "active" || entitlement?.state === "lapsed") &&
    (entitlement.source === "operator" || entitlement.source === "incident")
  ) {
    return deadline;
  }
  if (entitlement?.state === "lapsed" && entitlement.source === "trial") return deadline;
  return null;
}

export function formatMobileAccessRemaining(remainingMs: number): string {
  if (remainingMs <= 0) return "0h 0m";
  const totalMinutes = Math.max(1, Math.ceil(remainingMs / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}

export function getMobileWarningPulseInterval(remainingMs: number): number | null {
  if (remainingMs <= 0 || remainingMs > MOBILE_TRIAL_WARNING_WINDOW_MS) return null;
  return remainingMs <= MOBILE_ACCESS_CRITICAL_WINDOW_MS
    ? MOBILE_CRITICAL_PULSE_INTERVAL_MS
    : MOBILE_WARNING_PULSE_INTERVAL_MS;
}

export function getMobileAccessWarning(input: {
  mobileEnabled: boolean;
  pairedPhoneCount: number;
  health: { running?: boolean; pairAuthorization?: string } | null | undefined;
  entitlement: { state?: string; source?: string; notAfter?: number; cancellationAt?: number } | null | undefined;
  now?: number;
}): MobileAccessWarning | null {
  if (!input.mobileEnabled && input.pairedPhoneCount === 0) return null;

  const entitlement = input.entitlement;
  const notAfter = getMobileAccessDeadline(entitlement);
  const now = input.now ?? Date.now();
  const isTrial = entitlement?.source === "trial" || entitlement?.state === "trial";
  const scheduledSubscriptionCancellation = entitlement?.state === "active" && entitlement.source === "subscription";
  if (
    notAfter !== null &&
    (entitlement?.state === "lapsed" || (notAfter <= now && !scheduledSubscriptionCancellation))
  ) {
    return isTrial ? "trial-expired" : "access-expired";
  }

  if (input.health?.running === true && input.health.pairAuthorization === "denied") {
    return "authorization-denied";
  }

  if (
    notAfter !== null &&
    entitlement?.state !== "lapsed" &&
    notAfter > now &&
    notAfter - now <= MOBILE_TRIAL_WARNING_WINDOW_MS
  ) {
    return isTrial ? "trial-expiring" : "access-expiring";
  }

  return null;
}
