export type MobileAccessWarning = "trial-expired" | "authorization-denied" | "trial-expiring";

export const MOBILE_TRIAL_WARNING_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

export function getMobileAccessWarning(input: {
  mobileEnabled: boolean;
  pairedPhoneCount: number;
  health: { running?: boolean; pairAuthorization?: string } | null | undefined;
  entitlement: { state?: string; source?: string; notAfter?: number } | null | undefined;
  now?: number;
}): MobileAccessWarning | null {
  if (!input.mobileEnabled && input.pairedPhoneCount === 0) return null;

  const entitlement = input.entitlement;
  const notAfter = entitlement?.notAfter;
  const now = input.now ?? Date.now();
  const isKnownTrial = entitlement?.source === "trial";
  const hasTrialState = entitlement?.state === "trial" || entitlement?.state === "lapsed";
  if (
    isKnownTrial &&
    hasTrialState &&
    typeof notAfter === "number" &&
    Number.isFinite(notAfter) &&
    notAfter > 0 &&
    notAfter <= now
  ) {
    return "trial-expired";
  }

  if (input.health?.running === true && input.health.pairAuthorization === "denied") {
    return "authorization-denied";
  }

  if (
    isKnownTrial &&
    entitlement?.state === "trial" &&
    typeof notAfter === "number" &&
    Number.isFinite(notAfter) &&
    notAfter > now &&
    notAfter - now <= MOBILE_TRIAL_WARNING_WINDOW_MS
  ) {
    return "trial-expiring";
  }

  return null;
}
