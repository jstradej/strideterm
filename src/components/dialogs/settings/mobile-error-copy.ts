import { describeNetworkErrorCode } from "../../../lib/network-error-copy.js";

export type MobileErrorAction =
  "approve" | "enable" | "forget" | "pair" | "relay" | "reject" | "review" | "revoke" | "test-push";

const ACTION_FALLBACK = new Map<MobileErrorAction, string>([
  ["approve", "Could not activate this phone. It remains inactive. Please try again."],
  ["enable", "Could not update phone pairing. Please try again."],
  ["forget", "Could not remove this phone. Please try again."],
  ["pair", "Could not create a pairing invitation. Please try again."],
  ["relay", "Could not update the remote connection. Please try again."],
  ["reject", "Could not revoke this pairing. Please try again."],
  ["review", "Could not load the pairing code. Start pairing again or try again later."],
  ["revoke", "Could not revoke this phone. Please try again."],
  ["test-push", "Could not send the test notification. Please try again."],
]);

const KNOWN_REASONS = new Map<string, string>([
  [
    "entitlement-required",
    "Pairing a phone requires an active mobile plan. Open Account settings to sign in with an account that has one, or start the free 14-day trial if you are eligible.",
  ],
  ["daily-limit-reached", "The daily pairing limit has been reached. Please try again after it resets."],
  [
    "too-many-pairs-for-uid",
    "This account has reached its device pairing limit. Contact support if you need to connect another device.",
  ],
  ["too-many-active", "There is already a pairing in progress. Finish or cancel it, then try again."],
  [
    "fingerprint-mismatch",
    "The pairing details could not be verified. Create a new pairing invitation and scan it again.",
  ],
  ["malformed", "The pairing invitation is invalid. Create a new invitation and scan it again."],
  ["device-not-found", "This phone is no longer available. Refresh the phone list and try again."],
  ["device-revoked", "This phone has been revoked. Pair it again to restore access."],
  ["device-revoked-remotely", "This phone has been revoked. Pair it again to restore access."],
  ["cloud-revoke-pending", "The service is still processing this revoke. Try again shortly."],
  [
    "desktop-device-conflict",
    "This desktop is already linked to a different account. Review the account linked to this installation in Account settings.",
  ],
  ["not-awaiting-approval", "This phone is no longer waiting for approval. Refresh the phone list and try again."],
  ["unusable-key-material", "The pairing details could not be verified. Revoke this request and pair the phone again."],
]);

const STATUS_COPY = new Map<string, string>([
  ["UNAUTHENTICATED", "Sign in to your account in Account settings, then try again."],
  ["PERMISSION_DENIED", "This action is not authorized. Check your account and phone access in Account settings."],
  ["RESOURCE_EXHAUSTED", "A service limit has been reached. Please try again later."],
  ["UNAVAILABLE", "The mobile service is temporarily unavailable. Check your connection and try again."],
  ["DEADLINE_EXCEEDED", "The mobile service did not respond in time. Check your connection and try again."],
  ["NOT_FOUND", "This phone or pairing is no longer available. Refresh the phone list and try again."],
]);

const NETWORK_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
  "NETWORK_ERROR",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function safeReason(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const known = KNOWN_REASONS.get(value);
  if (known) return known;
  if (value.startsWith("callable:")) {
    const lastColon = value.lastIndexOf(":");
    return lastColon > "callable:".length ? safeStatus(value.slice(lastColon + 1)) : null;
  }
  if (value.startsWith("network:")) return describeNetworkErrorCode(value);
  return null;
}

function safeStatus(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.toUpperCase().replace(/-/g, "_");
  return STATUS_COPY.get(normalized) ?? null;
}

function parseKnownCallable(message: string): { status: string; reason?: string } | null {
  let details = message;
  if (details.startsWith("Error invoking remote method '")) {
    const prefixEnd = details.indexOf("': ");
    if (prefixEnd < 0) return null;
    details = details.slice(prefixEnd + 3);
  }
  if (details.startsWith("MobileFirebaseCallableError: ")) {
    details = details.slice("MobileFirebaseCallableError: ".length);
  }

  const separator = details.indexOf(" failed (");
  if (separator <= 0 || !details.endsWith(")")) return null;
  const functionName = details.slice(0, separator);
  if (!isIdentifier(functionName)) return null;
  const outcome = details.slice(separator + " failed (".length, -1);
  const reasonSeparator = outcome.indexOf(": ");
  return reasonSeparator < 0
    ? { status: outcome }
    : { status: outcome.slice(0, reasonSeparator), reason: outcome.slice(reasonSeparator + 2) };
}

function isIdentifier(value: string): boolean {
  if (!value || !isAsciiLetter(value.charCodeAt(0))) return false;
  for (let index = 1; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (!isAsciiLetter(code) && !(code >= 48 && code <= 57)) return false;
  }
  return true;
}

function isAsciiLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isKnownNetworkFailure(error: unknown): boolean {
  if (!isRecord(error)) return false;
  if (typeof error.code === "string" && NETWORK_CODES.has(error.code.toUpperCase())) return true;
  if (error.name !== "TypeError" || typeof error.message !== "string") return false;
  return ["Failed to fetch", "fetch failed", "NetworkError when attempting to fetch resource."].includes(error.message);
}

export function mobileErrorCopy(error: unknown, action: MobileErrorAction): string {
  const fallback = ACTION_FALLBACK.get(action)!;
  if (isKnownNetworkFailure(error)) {
    return "Could not reach the mobile service. Check your internet connection and try again.";
  }

  if (isRecord(error)) {
    const reasonCopy = safeReason(error.reason);
    if (reasonCopy) return reasonCopy;
    const statusCopy = safeStatus(error.status);
    if (statusCopy) return statusCopy;
  }

  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const callable = parseKnownCallable(message);
  if (callable) {
    return safeReason(callable.reason) ?? safeStatus(callable.status) ?? fallback;
  }
  return fallback;
}

export function mobileResultReasonCopy(reason: unknown, action: MobileErrorAction): string {
  return safeReason(reason) ?? ACTION_FALLBACK.get(action)!;
}
