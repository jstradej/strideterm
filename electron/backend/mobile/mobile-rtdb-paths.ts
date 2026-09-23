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

// ---------------------------------------------------------------------------
// The account, billing and claim-sync contract
//
// Exactly ONE of these branches is reachable by this desktop at all:
// `tokenRefreshPath`, whose rule is `auth.uid === $uid` and which is how a client
// learns its claims changed without polling. Everything else here is Admin-SDK-only
// and is mirrored for the same reason the diagnostics and admission branches above
// are — the drift check compares the WHOLE path contract, and a branch that only one
// repo knows about is a branch that can be renamed in silence.
// ---------------------------------------------------------------------------

export const ACCOUNTS_ROOT = "v2/accounts";
export const ACCOUNT_BY_UID_ROOT = "v2/accountByUid";
export const ACCOUNT_BY_INSTALLATION_KEY_ROOT = "v2/accountByInstallationKey";
export const ACCOUNT_BY_MOBILE_KEY_ROOT = "v2/accountByMobileKey";
export const ACCOUNT_BY_PAIR_ROOT = "v2/accountByPair";
export const ENTITLEMENT_REVOCATIONS_ROOT = "v2/entitlementRevocations";
export const REVOKED_UIDS_ROOT = "v2/revokedUids";
export const ACCOUNT_REVOCATIONS_ROOT = "v2/accountRevocations";
export const PAIRING_CLAIM_ROLLBACKS_ROOT = "v2/pairingClaimRollbacks";
export const PAIRING_CLAIM_DECISIONS_ROOT = "v2/pairingClaimDecisions";
export const PAIRING_CLAIM_DECISION_QUARANTINE_ROOT = "v2/pairingClaimDecisionQuarantine";
export const TRIAL_INSTALLATIONS_ROOT = "v2/trialInstallations";
export const INCIDENT_COMPENSATION_ROOT = "v2/system/incidentCompensation";
export const OPERATOR_STATUS_ROOT = "v2/system/operatorStatus";
export const BILLING_CUSTOMERS_ROOT = "v2/billing/customers";
export const BILLING_SUBSCRIPTIONS_ROOT = "v2/billing/subscriptions";
export const BILLING_TRANSACTIONS_ROOT = "v2/billing/transactions";
export const BILLING_ADJUSTMENT_REPAIRS_ROOT = "v2/billing/adjustmentRepairs";
export const BILLING_CHECKOUT_SLOTS_ROOT = "v2/billing/checkoutSlots";
export const BILLING_CHECKOUT_INTENTS_ROOT = "v2/billing/checkoutIntents";
export const BILLING_PROVIDER_MUTATIONS_ROOT = "v2/billing/providerMutations";
export const BILLING_EVENTS_ROOT = "v2/billing/events";
export const INSTALLATION_CHALLENGES_ROOT = "v2/installationChallenges";
export const TOKEN_REFRESH_ROOT = "v2/tokenRefresh";
export const CLAIM_SYNC_PENDING_ROOT = "v2/claimSyncPending";
export const ACCOUNT_NOTICE_SCHEDULE_ROOT = "v2/accountNoticeSchedule";
export const OPERATOR_AUDIT_ROOT = "v2/operatorAudit";
export const RELAY_REVOCATION_OUTBOX_ROOT = "v2/relayRevocationOutbox";

/**
 * The whole account subtree. Admin-only in both directions — no client read rule, no client
 * write rule — and NOT in the recovery-minimum capsule as a unit: it mixes our own
 * irreplaceable truth (uids, installations, mobile devices, trial) with a Paddle projection
 * that must be rebuilt from Paddle rather than restored, and with notices that are transient.
 * The children below say which is which, and the capsule is built from those.
 */
export function accountPath(accountId: string): string {
  return `v2/accounts/${accountId}`;
}

/**
 * { ownerUid, status, createdAt } where status is active | deletion_pending | deleted.
 *
 * No email. Firebase Auth is the authority for the login identity and Paddle for the billing
 * one; a copy here would be a third place to keep in sync and a PII branch to protect, and
 * the owner uid plus the owner's `stridetermRecoveryAccountId` are enough to re-cross the two
 * after a total loss of this database.
 */
export function accountProfilePath(accountId: string): string {
  return `v2/accounts/${accountId}/profile`;
}

/**
 * The monotonic revision the issuer trigger watches. Every transaction that changes an
 * entitlement source or a uid membership raises it in the same commit, and
 * `syncEntitlementClaims` is an onValueWritten trigger on THIS node and nothing else — which
 * is what gives the ADR its single issuer surface without a second network or client authority.
 */
export function accountClaimSyncRevisionPath(accountId: string): string {
  return `v2/accounts/${accountId}/claimSyncRevision`;
}

/**
 * The ledger: { revision, effectiveState, effectiveSource, entitlementNotAfter } plus one node
 * per source. The summary fields are a projection — recomputable from the sources by the
 * reducer — which is why the container is classified as one and why a restore rebuilds it
 * instead of trusting the copy it restored.
 */
export function accountEntitlementPath(accountId: string): string {
  return `v2/accounts/${accountId}/entitlement`;
}

/**
 * { startedAt, notAfter, installationFingerprint }. Card-free trial history exists nowhere
 * else: Paddle never saw it, so losing it means either handing out a second free trial or
 * refusing one somebody never had.
 */
export function accountEntitlementTrialPath(accountId: string): string {
  return `v2/accounts/${accountId}/entitlement/trial`;
}

/**
 * The last authoritative Paddle snapshot plus the ordering metadata that makes at-least-once
 * webhooks deterministic: { provider, customerId, subscriptionId, status, paidThrough,
 * graceNotAfter, priceId, productId, lastOccurredAt, lastEventId, generation }.
 *
 * Rebuildable in full from Paddle list/get plus `custom_data`, and therefore deliberately NOT
 * in the recovery capsule: restoring a stale copy of somebody's billing state is worse than
 * asking the merchant of record what it is now.
 */
export function accountEntitlementSubscriptionPath(accountId: string): string {
  return `v2/accounts/${accountId}/entitlement/subscription`;
}

/** { notAfter, lastGrantId }. An operator grant has no provider to be re-read from. */
export function accountEntitlementOperatorPath(accountId: string): string {
  return `v2/accounts/${accountId}/entitlement/operator`;
}

/**
 * { incidentId, startsAt, notAfter, billingMutationId } — the one per-account row a disaster
 * compensation materialises. Future-dated on purpose: for an annual subscriber the grant
 * begins at the billing boundary the pause takes effect at, not now, so the paid period is
 * consumed first.
 */
export function accountEntitlementIncidentPath(accountId: string): string {
  return `v2/accounts/${accountId}/entitlement/incident`;
}

/** { active, reason, at }. Suppresses every source while set; nothing else can express that. */
export function accountEntitlementRiskHoldPath(accountId: string): string {
  return `v2/accounts/${accountId}/entitlement/riskHold`;
}

/**
 * { kind, boundAt, revokedAt, desiredClaimState, claimRevisionApplied } for one Firebase uid.
 * `kind` is account-owner | desktop-installation | mobile-device.
 *
 * A revoked row is a TOMBSTONE, not a deletion: the issuer has to be told to remove that uid's
 * claims and revoke its refresh tokens, and it cannot be told about a row that is gone. The
 * finalize job minimises it once the issuer has acknowledged, which is a different event from
 * the revoke.
 */
export function accountUidPath(accountId: string, uid: string): string {
  return `v2/accounts/${accountId}/uids/${uid}`;
}

/** Every uid of one account. Bounded by the two caps, so the issuer can walk it whole. */
export function accountUidsPath(accountId: string): string {
  return `v2/accounts/${accountId}/uids`;
}

/**
 * { uid, label, keyFingerprint, registeredAt, lastSeenAt, revokedAt } for one desktop data
 * directory. `keyFingerprint` is the Ed25519 relay installation key's fingerprint — a public
 * value; the private key never leaves the desktop and is not recoverable from here.
 */
export function accountInstallationPath(accountId: string, installationId: string): string {
  return `v2/accounts/${accountId}/installations/${installationId}`;
}

/** Bounded by MAX_INSTALLATIONS_PER_ENTITLEMENT, so counting active rows is one read. */
export function accountInstallationsPath(accountId: string): string {
  return `v2/accounts/${accountId}/installations`;
}

/**
 * One PHONE — keyed by the fingerprint of the X25519 public key SecureKeyStore keeps across
 * pairings, not by a pairing's device id. That is the whole reason a phone paired with five
 * desktops counts once against the cap: `mobileDeviceId` is a per-pair record id and was never
 * a billable unit.
 */
export function accountMobileDevicePath(accountId: string, mobileInstallationFingerprint: string): string {
  return `v2/accounts/${accountId}/mobileDevices/${mobileInstallationFingerprint}`;
}

export function accountMobileDevicesPath(accountId: string): string {
  return `v2/accounts/${accountId}/mobileDevices`;
}

/**
 * One relationship between this phone and one desktop pair. Removing the last one is what
 * makes the mobile device row inactive; removing one of several does not, which is the
 * difference between `revokeDevice` and `revokeAccountMobileDevice`.
 */
export function accountMobileDevicePairPath(
  accountId: string,
  mobileInstallationFingerprint: string,
  pairId: string,
  pairDeviceId: string,
): string {
  return `v2/accounts/${accountId}/mobileDevices/${mobileInstallationFingerprint}/pairs/${pairId}/${pairDeviceId}`;
}

export function accountMobileDevicePairsPath(accountId: string, mobileInstallationFingerprint: string): string {
  return `v2/accounts/${accountId}/mobileDevices/${mobileInstallationFingerprint}/pairs`;
}

/**
 * { kind, effectiveAt, createdAt, acknowledgedAt, deliveryByMobileKey }. A materialised
 * account notice — trial T-3/T-1, or a once-only cap-hit. Never carries a price or a link.
 */
export function accountNoticePath(accountId: string, noticeId: string): string {
  return `v2/accounts/${accountId}/notices/${noticeId}`;
}

export function accountNoticesPath(accountId: string): string {
  return `v2/accounts/${accountId}/notices`;
}

/**
 * uid -> accountId. The reverse index every bound-account door resolves through, and an
 * EXCLUSIVE active binding: while it is set, no other account may adopt that uid. Removed
 * only after the issuer has acknowledged claim removal, never as part of the revoke itself.
 */
export function accountByUidPath(uid: string): string {
  return `v2/accountByUid/${uid}`;
}

/**
 * Desktop installation key fingerprint -> accountId. Exclusive, and NOT a trial tombstone:
 * a detached installation frees this row and does not free `trialInstallations`.
 */
export function accountByInstallationKeyPath(ed25519Fingerprint: string): string {
  return `v2/accountByInstallationKey/${ed25519Fingerprint}`;
}

/**
 * Phone installation key fingerprint -> accountId. A second account's invitation scanned by
 * an already-bound phone is refused with the public reason `account-mismatch`, which says
 * nothing about whose account it already belongs to.
 */
export function accountByMobileKeyPath(x25519Fingerprint: string): string {
  return `v2/accountByMobileKey/${x25519Fingerprint}`;
}

/**
 * pairId -> accountId. What `deliverPush` and every other deferred side effect resolves so it
 * can re-check the account's entitlement at the moment of the effect rather than trusting that
 * the enqueue was once authorized.
 */
export function accountByPairPath(pairId: string): string {
  return `v2/accountByPair/${pairId}`;
}

/**
 * { active, ledgerRevision, reasonCode, updatedAt } — the NEGATIVE projection of the ledger.
 *
 * Firebase ID tokens live up to an hour and carry their claims with them, so a refund, a
 * chargeback, an operator revoke or a deletion cannot wait for expiry. This node is read by
 * database.rules.json and by every caller-entitlement call site before the side effect, keyed
 * by the claim's own `entitlementId`. It is an emergency override and never a second positive
 * entitlement system: an ACTIVE revocation may be cached, an absent one may not.
 */
export function entitlementRevocationPath(accountId: string): string {
  return `v2/entitlementRevocations/${accountId}`;
}

/**
 * The single boolean database.rules.json reads. Split out because a rule may only read a
 * value it names, and naming the parent would hand a client the reason code as well.
 */
export function entitlementRevocationActivePath(accountId: string): string {
  return `v2/entitlementRevocations/${accountId}/active`;
}

/**
 * { active, accountId, ledgerRevision, reasonCode, notBefore, expiresAt, updatedAt } — the negative
 * projection PER FIREBASE UID, beside the per-account one.
 *
 * `entitlementRevocations/{entitlementId}` closes a whole account, which is the refund and chargeback
 * case. Revoking ONE laptop is not that: the account is fine, everybody else's claims stay, and the
 * only thing that must stop is this uid. Removing its custom claims does not shorten the ID token
 * already in its hand, and the Rules compared `publicMeta.desktopUid` against that token — so a
 * revoked desktop kept reading its own mailbox until expiry.
 *
 * Admin-only, like every other branch here: this desktop never reads or writes it, and a client that
 * could read it could enumerate which of somebody's devices had been revoked.
 */
export function revokedUidPath(uid: string): string {
  return `v2/revokedUids/${uid}`;
}

/**
 * { accountId, scope, targetId, reason, ledgerRevision, uids, pairIds, indexPaths, steps, attempts,
 * nextAttemptAt, completedAt } — ONE durable revocation workflow.
 *
 * Five things have to happen when access ends, and the one that cannot finish inside the request that
 * started it is the acknowledgement gate: nothing may release an exclusive key binding before the
 * issuer confirms the claims are gone. Written as an inline sequence, a crash between any two steps
 * left a revocation that had partly happened and nothing that would finish it.
 */
export function accountRevocationPath(jobId: string): string {
  return `v2/accountRevocations/${jobId}`;
}

/**
 * { accountId, issuedAt, notAfter } — WRITE-ONCE, and never deleted by anything, including
 * account deletion and every cleanup sweep. It is the only record that a given desktop
 * installation key has already had its one card-free trial; a second account, a reinstall over
 * the same data directory, or a deleted-and-recreated account does not get another.
 *
 * A genuinely new data directory with a new key is a deliberate, documented reset (ADR 0025).
 */
export function trialInstallationPath(ed25519Fingerprint: string): string {
  return `v2/trialInstallations/${ed25519Fingerprint}`;
}

/**
 * { eligibleOwnerCreatedBefore, accessStartsAt, accessNotAfter, billingEffectivePolicy,
 * configDigest, activatedAt } — ONE global rule, not a grant per device.
 *
 * Eligibility is derived from Firebase Auth creation metadata, so the compensation needs no
 * hand-maintained list of who was affected and applying the same incidentId twice is a no-op.
 */
export function incidentCompensationPath(incidentId: string): string {
  return `v2/system/incidentCompensation/${incidentId}`;
}

/**
 * The latest bounded operational aggregate for one explicitly declared deployment environment.
 * The collector writes this from paged account/Auth reads; the operator endpoint only reads the
 * last complete snapshot and reports it stale or unknown when the collector has not finished.
 */
export function operatorStatusPath(environment: string): string {
  return `v2/system/operatorStatus/${environment}`;
}

/** Paddle customer id -> accountId. Routing only; no address, no payment method, no email. */
export function billingCustomerPath(customerId: string): string {
  return `v2/billing/customers/${customerId}`;
}

/**
 * { accountId, generation }. `generation` is what makes a resubscribe safe: an event for an
 * older subscription of the same account cannot overwrite a newer one.
 */
export function billingSubscriptionPath(subscriptionId: string): string {
  return `v2/billing/subscriptions/${subscriptionId}`;
}

/**
 * { accountId, subscriptionId, customerId, productId, priceId, lastOccurredAt } — the routing
 * an `adjustment.*` needs to resolve safely. Kept 35 days, not forever: a later adjustment is
 * resolved by a read-only lookup in Paddle, where the money actually lives.
 */
export function billingTransactionPath(transactionId: string): string {
  return `v2/billing/transactions/${transactionId}`;
}

/**
 * { accountId, idempotencyKey, expectedPriceId, createdAt, expiresAt, providerTransactionId,
 * status } with status prepared | creating | ambiguous | ready | consumed | failed.
 *
 * The first `subscription.created` must match a LIVE intent: `custom_data` travels with a
 * checkout link and is therefore not on its own proof of who is paying.
 */
export function billingCheckoutIntentPath(intentId: string): string {
  return `v2/billing/checkoutIntents/${intentId}`;
}

/**
 * { kind, accountId, attempt, requestHash, state, startedAt, resolvedAt, providerObjectId }.
 *
 * Paddle's create operations take no client-supplied idempotency key, so a timeout after the
 * request left is genuinely ambiguous. The journal row is written BEFORE the request and is
 * the only thing that stops a retry creating a second customer or a second subscription — which
 * is why an in-flight one is local truth and belongs in the recovery capsule.
 */
export function billingProviderMutationPath(mutationId: string): string {
  return `v2/billing/providerMutations/${mutationId}`;
}

/**
 * { adjustmentId, transactionId, action, occurredAt, reason, attempts, nextAttemptAt, resolvedAt } —
 * an adjustment whose effect on entitlement could not be DECIDED yet.
 *
 * An adjustment is the only event that can revoke, and the scheduled reconciliation walks
 * SUBSCRIPTION snapshots — so an undecidable one used to end as a completed event that did nothing
 * and nothing ever came back to it. A row here is the durable "come back to this".
 */
export function billingAdjustmentRepairPath(adjustmentId: string): string {
  return `v2/billing/adjustmentRepairs/${adjustmentId}`;
}

/**
 * { intentId, expiresAt, takenAt } — the ONE unfinished checkout an account may have.
 *
 * One personal plan means one subscription, and the only place that can be enforced before money
 * moves is here: a second `subscription.created` refused by the webhook is a refusal AFTER the
 * customer has paid twice.
 */
export function billingCheckoutSlotPath(accountId: string): string {
  return `v2/billing/checkoutSlots/${accountId}`;
}

/**
 * { occurredAt, type, state, leaseUntil, appliedAt, outcome } — the webhook receipt, keyed by
 * Paddle's own `event_id`. Never the raw body: it is signed input, it is large, and keeping it
 * would make this branch a copy of Paddle's event store.
 */
export function billingEventPath(eventId: string): string {
  return `v2/billing/events/${eventId}`;
}

/** Where the bounded scheduled sweep got to. A restart resumes; it never scans globally. */
export function billingReconciliationCheckpointPath(): string {
  return `v2/billing/reconciliation/checkpoint`;
}

/**
 * { accountId, installationId, publicKey, nonceHash, expiresAt, consumedAt } — one leg of the
 * two-identity handshake. The caller uid is recorded HERE, by the server, during Begin: the
 * Complete leg runs under the owner's transient session and must not be able to name an
 * installation uid of its own choosing.
 */
export function installationChallengePath(challengeId: string): string {
  return `v2/installationChallenges/${challengeId}`;
}

/**
 * { revision, changedAt } — the ONLY account branch with a client read rule, and that rule is
 * `auth.uid === $uid`. It is how a client learns its claims changed without polling, and it is
 * deliberately not a paid data path: a lapsed client must still be able to see that it lapsed.
 */
export function tokenRefreshPath(uid: string): string {
  return `v2/tokenRefresh/${uid}`;
}

/**
 * { phase, requestedAt, attempts, nextAttemptAt, cancelMutationId, blockedAtRevision } — the
 * durable deletion job for one account.
 *
 * `local-truth` and in the minimal capsule, because losing it mid-run is the one failure that
 * cannot be reconstructed from anywhere else: the account is marked `deletion_pending`, the
 * person has asked to stop being charged, and nothing left would say how far that got.
 */
export function accountDeletionPath(accountId: string): string {
  return `v2/accountDeletions/${accountId}`;
}

/**
 * The container the scheduled deletion worker pages, oldest attempt first.
 */
export function accountDeletionsRoot(): string {
  return `v2/accountDeletions`;
}

/**
 * { revision, nextAttemptAt, attempts } — the global bounded repair index.
 *
 * The scheduled repair reads a page of THIS branch and only compare-and-set raises the
 * account's `claimSyncRevision`; it never calls the Claims API itself, so the issuer trigger
 * stays the single writer.
 */
export function claimSyncPendingPath(accountId: string): string {
  return `v2/claimSyncPending/${accountId}`;
}

/**
 * { effectiveAt, state } in a UTC-day bucket. A due index, so `createAccountNotices` reads the
 * buckets that are due instead of scanning every account on every tick.
 */
export function accountNoticeSchedulePath(utcBucket: string, accountId: string, noticeId: string): string {
  return `v2/accountNoticeSchedule/${utcBucket}/${accountId}/${noticeId}`;
}

export function accountNoticeScheduleBucketPath(utcBucket: string): string {
  return `v2/accountNoticeSchedule/${utcBucket}`;
}

/**
 * { action, actorSubjectHash, role, accountId, targetKind, reasonCode, ticketRef,
 * idempotencyKeyHash, beforeDigest, afterDigest, occurredAt, outcome }.
 *
 * `actorSubjectHash`, never an operator email or subject: the trail says which identity acted
 * without becoming a directory of who the operators are. Its retention is legally confirmed
 * separately, and until that confirmation exists the production preflight is NO-GO — cleanup
 * is not allowed to improvise a number.
 */
export function operatorAuditPath(entryId: string): string {
  return `v2/operatorAudit/${entryId}`;
}

/**
 * { accountId, installationId, ledgerRevision, state, attempts, nextAttemptAt } — one durable
 * item per installation whose managed-relay sessions must be closed now rather than at TTL.
 *
 * Deterministically rebuildable from the account ledger, so a restore recreates it instead of
 * replaying a snapshot's pending commands.
 */
export function relayRevocationOutboxPath(commandId: string): string {
  return `v2/relayRevocationOutbox/${commandId}`;
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

export function pairPendingCommandsPath(pairId: string): string {
  return `v2/pairs/${pairId}/pendingCommands`;
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

// --- the pairing-claim machinery's own branches -----------------------------------------------
//
// MIRRORED FOR COMPLETENESS, not because this desktop writes any of them. The path contract is a
// contract: `check-mobile-schema-drift` compares the whole exported surface, and a mirror that holds
// only the paths one side happens to use cannot tell "we do not use it" apart from "it moved and
// nobody noticed". The Security Rules are written against these exact strings, so a drifted one is a
// write the rules silently reject.

/** The rollback intent a pairing claim leaves behind when it dies between two writes. */
export function pairingClaimRollbackPath(pairingId: string): string {
  return `v2/pairingClaimRollbacks/${pairingId}`;
}

/** One claim attempt's decision, keyed by the attempt rather than by the invitation. */
export function pairingClaimDecisionPath(attempt: string): string {
  return `v2/pairingClaimDecisions/${attempt}`;
}

/** A decision the sweep could not reconcile, held rather than dropped. */
export function pairingClaimDecisionQuarantinePath(attempt: string): string {
  return `v2/pairingClaimDecisionQuarantine/${attempt}`;
}

/** The per-account revocation generations the relay's revocation ordering rests on. */
export function accountRevocationGenerationsPath(accountId: string): string {
  return `v2/accounts/${accountId}/revocationGenerations`;
}

/** The operations an account has already applied, so a replay is a no-op rather than a second effect. */
export function accountAppliedOperationsPath(accountId: string): string {
  return `v2/accounts/${accountId}/appliedOperations`;
}

/** One pairing claim, under the account that owns the invitation. */
export function accountPairingClaimPath(accountId: string, pairingId: string): string {
  return `v2/accounts/${accountId}/pairingClaims/${pairingId}`;
}
