/**
 * Hand-authored mirror of strideterm-mobile's canonical RTDB path contract
 * (protocol/schemas/rtdb-paths.json, code-generated there into
 * protocol/typescript/src/generated/rtdb-paths.ts and
 * protocol/dart/lib/src/generated/rtdb_paths.dart).
 *
 * Same reason mobile-schemas.ts is a hand mirror rather than an import: this
 * repo cannot reach across to the sibling checkout at build time and no
 * published @strideterm/mobile-protocol package exists yet. The interim safety
 * net is the same one too — `npm run check:mobile-schema-drift` imports the
 * generated module from the sibling repo and compares every builder's output
 * against this file's, so a renamed branch here or there is caught before it
 * becomes a live pairing failure rather than after.
 *
 * Do not spell a path out anywhere else in electron/backend/mobile/: the whole
 * point of the contract is that there is exactly one place per repo where a
 * branch name appears.
 */

export const PAIRS_ROOT = "v2/pairs";
export const PRIVATE_PUSH_TOKENS_ROOT = "v2/privatePushTokens";
export const PAIRING_INVITATIONS_ROOT = "v2/pairingInvitations";
export const CLEANUP_CHECKPOINT_PATH = "v2/_internal/cleanupCheckpoint";

/**
 * Diagnostics reports a phone's user chose to send. Admin-SDK-only in both directions — mirrored here
 * because the drift check compares the whole path contract, not because the desktop touches it.
 */
export const DIAGNOSTIC_REPORTS_ROOT = "v2/diagnosticReports";

export function diagnosticReportPath(uid: string, reportId: string): string {
  return `v2/diagnosticReports/${uid}/${reportId}`;
}

export function diagnosticReportsForUidPath(uid: string): string {
  return `v2/diagnosticReports/${uid}`;
}

/** The region every callable and RTDB trigger is deployed in (ADR 0003, EU data residency). */
export const FUNCTIONS_REGION = "europe-west1";

export function pairPath(pairId: string): string {
  return `v2/pairs/${pairId}`;
}

export function pairPublicMetaPath(pairId: string): string {
  return `v2/pairs/${pairId}/publicMeta`;
}

export function pairMemberPath(pairId: string, uid: string): string {
  return `v2/pairs/${pairId}/members/${uid}`;
}

export function pairMembersPath(pairId: string): string {
  return `v2/pairs/${pairId}/members`;
}

export function pairDevicePath(pairId: string, deviceId: string): string {
  return `v2/pairs/${pairId}/devices/${deviceId}`;
}

export function pairDevicesPath(pairId: string): string {
  return `v2/pairs/${pairId}/devices`;
}

export function pairEventPath(pairId: string, targetDeviceId: string, eventId: string): string {
  return `v2/pairs/${pairId}/events/${targetDeviceId}/${eventId}`;
}

export function pairEventsForTargetPath(pairId: string, targetDeviceId: string): string {
  return `v2/pairs/${pairId}/events/${targetDeviceId}`;
}

export function pairEventsPath(pairId: string): string {
  return `v2/pairs/${pairId}/events`;
}

export function pairCommandPath(pairId: string, commandId: string): string {
  return `v2/pairs/${pairId}/commands/${commandId}`;
}

export function pairCommandsPath(pairId: string): string {
  return `v2/pairs/${pairId}/commands`;
}

export function pairCommandsPendingCountPath(pairId: string): string {
  return `v2/pairs/${pairId}/commandsPendingCount`;
}

export function pairResultPath(pairId: string, targetDeviceId: string, commandId: string): string {
  return `v2/pairs/${pairId}/results/${targetDeviceId}/${commandId}`;
}

export function pairResultsForTargetPath(pairId: string, targetDeviceId: string): string {
  return `v2/pairs/${pairId}/results/${targetDeviceId}`;
}

export function pairResultsPath(pairId: string): string {
  return `v2/pairs/${pairId}/results`;
}

export function pairPresencePath(pairId: string, deviceId: string): string {
  return `v2/pairs/${pairId}/presence/${deviceId}`;
}

export function pairPresenceRootPath(pairId: string): string {
  return `v2/pairs/${pairId}/presence`;
}

export function pairQuotaWindowPath(pairId: string, windowId: string): string {
  return `v2/pairs/${pairId}/quotaWindows/${windowId}`;
}

export function pairQuotaWindowsPath(pairId: string): string {
  return `v2/pairs/${pairId}/quotaWindows`;
}

export function privatePushTokenPath(uid: string, deviceId: string): string {
  return `v2/privatePushTokens/${uid}/${deviceId}`;
}

export function privatePushTokensForUidPath(uid: string): string {
  return `v2/privatePushTokens/${uid}`;
}

export const UID_QUOTAS_ROOT = "v2/uidQuotas";

export function uidQuotaWindowPath(uid: string, windowId: string): string {
  return `v2/uidQuotas/${uid}/${windowId}`;
}

export function uidQuotaWindowsPath(uid: string): string {
  return `v2/uidQuotas/${uid}`;
}

export function uidPairCountPath(uid: string): string {
  return `v2/uidQuotas/${uid}/pairCount`;
}

export function pairingInvitationPath(pairingId: string): string {
  return `v2/pairingInvitations/${pairingId}`;
}

/**
 * Per-desktop index of the invitations that desktop created (review 3 §P0.5).
 *
 * Admin-SDK-only, like everything below: this desktop never reads or writes any of these branches. They
 * are mirrored here because `check:mobile-schema-drift` compares this file against the generated path
 * contract export-for-export, and a branch that exists on one side only is exactly the drift that check
 * is for — a path the two repos disagree about is a write the rules silently reject.
 */
export const PAIRING_INVITATIONS_BY_DESKTOP_ROOT = "v2/pairingInvitationsByDesktop";

export function pairingInvitationIndexPath(desktopDeviceId: string, pairingId: string): string {
  return `v2/pairingInvitationsByDesktop/${desktopDeviceId}/${pairingId}`;
}

export function pairingInvitationIndexForDesktopPath(desktopDeviceId: string): string {
  return `v2/pairingInvitationsByDesktop/${desktopDeviceId}`;
}

/**
 * Create-only id reservations, taken by `enqueueEvent`/`enqueueCommand` before any quota is spent
 * (review 3 §P0.2/§P1.4). Admin-SDK-only.
 */
export function pairEventReservationPath(pairId: string, targetDeviceId: string, eventId: string): string {
  return `v2/pairs/${pairId}/eventReservations/${targetDeviceId}/${eventId}`;
}

export function pairEventReservationsPath(pairId: string): string {
  return `v2/pairs/${pairId}/eventReservations`;
}

export function pairCommandReservationPath(pairId: string, commandId: string): string {
  return `v2/pairs/${pairId}/commandReservations/${commandId}`;
}

export function pairCommandReservationsPath(pairId: string): string {
  return `v2/pairs/${pairId}/commandReservations`;
}

/**
 * The persistent admission ledger (review 3 §P0.5): per-principal, per-UTC-day invitation counters and
 * idempotency keys, deliberately outside the invitation records so retention cannot refund a limit.
 * Admin-SDK-only.
 */
export const ADMISSION_ROOT = "v2/admission";

export function admissionInvitationDayPath(principalId: string, utcDay: string): string {
  return `v2/admission/${principalId}/invitationDays/${utcDay}`;
}

export function admissionInvitationDaysPath(principalId: string): string {
  return `v2/admission/${principalId}/invitationDays`;
}

export function admissionDiagnosticsDayPath(principalId: string, utcDay: string): string {
  return `v2/admission/${principalId}/diagnosticsDays/${utcDay}`;
}

export function admissionDiagnosticsDaysPath(principalId: string): string {
  return `v2/admission/${principalId}/diagnosticsDays`;
}

export function admissionIdempotencyPath(principalId: string, idempotencyKey: string): string {
  return `v2/admission/${principalId}/idempotency/${idempotencyKey}`;
}

export function admissionPrincipalPath(principalId: string): string {
  return `v2/admission/${principalId}`;
}

/**
 * One relay-grant issuance window for one principal. Admin-SDK-only, like everything under
 * `v2/admission` — mirrored here because the drift check compares the whole path contract.
 */
export function admissionRelayWindowPath(principalId: string, windowId: string): string {
  return `v2/admission/${principalId}/relayWindows/${windowId}`;
}

export function admissionRelayWindowsPath(principalId: string): string {
  return `v2/admission/${principalId}/relayWindows`;
}

/** `{deviceId: expiresAt}` for the relay sessions one entitlement currently holds. */
export function admissionRelaySessionsPath(principalId: string): string {
  return `v2/admission/${principalId}/relaySessions`;
}

/**
 * Pair-level quota counter key: `{kind}-{windowStart}`, where windowStart is
 * the UTC-aligned bucket start in epoch milliseconds. This is the key the
 * mobile app reads for "pushes used today" and the one database.rules.json's
 * modulo-alignment check re-derives.
 */
export function quotaWindowId(kind: string, windowStart: number): string {
  return `${kind}-${windowStart}`;
}

/**
 * Device-scoped counterpart — a *different* counter with a different cap (the
 * per-device delivery quota, decided server-side by deliverPush). Never
 * interchangeable with quotaWindowId().
 */
export function scopedQuotaWindowId(kind: string, scopeId: string, windowStart: number): string {
  return `${kind}-${scopeId}-${windowStart}`;
}

/**
 * The Realtime Database namespace for a project: `{projectId}-default-rtdb`.
 *
 * Not left to a client library's default. firebase-admin, given no explicit databaseURL, derives
 * the LEGACY `https://{projectId}.firebaseio.com`, whose namespace is just `{projectId}` — so the
 * Cloud Functions would write to one database while every client read another, with no error on
 * either side. Observed for real against the Functions emulator.
 */
export function databaseNamespace(projectId: string): string {
  return `${projectId}-default-rtdb`;
}

/** The production instance URL for this project, in the contract region. */
export function databaseInstanceUrl(projectId: string): string {
  return `https://${databaseNamespace(projectId)}.${FUNCTIONS_REGION}.firebasedatabase.app`;
}

/**
 * The emulator equivalent. `host` is the bare `host:port` the Firebase CLI exports in
 * FIREBASE_DATABASE_EMULATOR_HOST; the `?ns=` query is what selects the namespace there.
 */
export function emulatorDatabaseUrl(host: string, projectId: string): string {
  return `http://${host}?ns=${databaseNamespace(projectId)}`;
}

/** Duration of each quota window kind, in milliseconds. Mirrors quota-window-core.ts. */
export const QUOTA_WINDOW_DURATIONS_MS: Record<string, number> = {
  "push-day": 24 * 60 * 60 * 1000,
  "push-hour": 60 * 60 * 1000,
  "push-minute": 60 * 1000,
  "command-day": 24 * 60 * 60 * 1000,
  "command-minute": 60 * 1000,
  "uid-command-day": 24 * 60 * 60 * 1000,
  "uid-command-minute": 60 * 1000,
  // The event equivalents, added with server-side event admission (review 3 §P0.2): `enqueueEvent`
  // applies these on top of the pair-scoped push windows, because pairId := desktopDeviceId is
  // client-chosen and one identity could otherwise mint pairs to multiply its own event budget.
  "uid-push-day": 24 * 60 * 60 * 1000,
  "uid-push-minute": 60 * 1000,
};

export interface QuotaWindowBounds {
  windowId: string;
  windowStart: number;
  windowEnd: number;
}

/** The UTC-aligned [windowStart, windowEnd) bucket `now` falls into, for a pair-level counter. */
export function computeQuotaWindowBounds(kind: string, now: number): QuotaWindowBounds {
  const duration = QUOTA_WINDOW_DURATIONS_MS[kind];
  if (!duration) throw new Error(`unknown quota window kind: ${kind}`);
  const windowStart = Math.floor(now / duration) * duration;
  return { windowId: quotaWindowId(kind, windowStart), windowStart, windowEnd: windowStart + duration };
}
