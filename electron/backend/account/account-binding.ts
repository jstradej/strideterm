// The durable, LOCAL record of whether this installation is enrolled in an account — as a state
// machine, not a boolean.
//
// F12 made the binding a local fact: a marker in the credential store, read on a cold start before any
// network call, consulted by the guard that decides whether a rejected refresh token may be answered
// by minting a NEW anonymous uid. That closed the case the review named — a bound machine whose token
// was rejected while the server could not be asked. It left three other doors open, and every one of
// them degraded to the SAME answer the marker exists to prevent (G13):
//
//   - a write that failed after a successful enrolment (the server enrolled, the disk did not say so);
//   - a read that failed (a locked keychain, a corrupt store), which answered "false";
//   - an installation enrolled by a build that wrote no marker at all.
//
// "I could not read the marker" and "the marker says this machine was never enrolled" are different
// facts, and only the second may release the identity. So the marker has four readable states:
//
//   `absent`     nothing was ever written. A brand-new install, OR one an older build enrolled. Not
//                evidence either way, so the guard treats it as bound until the server answers.
//   `enrolling`  the INTENT, written before the server is asked to enrol. A crash after the server
//                said yes and before `bound` was written leaves this, and this is treated as bound.
//   `bound`      the server confirmed the enrolment, or listed this installation on an overview.
//   `none`       the server ANSWERED that this installation is not bound — an overview that did not
//                list it, a refused enrolment, a completed sign-out. The ONE state that releases the
//                identity.
//   `unknown`    the store could not be read. Treated exactly like `absent`: the identity is kept and
//                the recovery path is offered, because a broken store is not a proof of anything.
//
// The guard therefore fails CLOSED: it refuses a new identity unless the marker positively says `none`
// (or the manager has learned from the server that this machine is enrolled). The cost of a wrong
// refusal is the `installation-identity-lost` recovery state on the Account page — which the user can
// resolve with a recover-uid enrolment, or by signing the installation out, which writes `none`. The
// cost of a wrong release was a machine that vanished from its own account.

/** What is written. `none` is a VALUE, not a deletion: an absent marker means "never answered". */
export type InstallationBindingMarker = "bound" | "enrolling" | "none";

/** What is read: the three markers, plus the two ways of not having one. */
export type InstallationBindingState = InstallationBindingMarker | "absent" | "unknown";

/**
 * Parses what the credential store holds. Anything that is not one of the three markers is `absent`:
 * the marker an earlier build wrote was the bare string `bound`, which parses as itself.
 */
export function parseInstallationBinding(raw: string | null | undefined): InstallationBindingState {
  if (raw === "bound" || raw === "enrolling" || raw === "none") return raw;
  return "absent";
}

/**
 * Whether a rejected refresh token may be answered by minting a NEW anonymous uid.
 *
 * `false` — the identity may be released — only when the marker positively says the server declared
 * this installation unbound and nothing this process has learned since says otherwise. Every other
 * state keeps the identity: `bound` and `enrolling` because the server may well know this uid, `absent`
 * and `unknown` because nothing says it does not.
 */
export function newIdentityIsRefused(state: InstallationBindingState, registeredPerServer: boolean): boolean {
  if (registeredPerServer) return true;
  return state !== "none";
}

/** Whether the local record alone says this machine is enrolled — what the Account page may show. */
export function bindingSaysEnrolled(state: InstallationBindingState): boolean {
  return state === "bound";
}
