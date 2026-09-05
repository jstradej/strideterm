// The control-plane epoch transition, carried out — as one function with one honest answer.
//
// F14 made the transition durable: accepting an envelope and APPLYING it are two facts, the pending
// transition is read from disk before any client is built, and the marker is written LAST. What it
// did not do is make the marker depend on the work (G06): the cleanup ran inside a `try`, its failure
// was logged with the words "it stays pending" — and the line after the `catch` marked it applied
// anyway. A credential store that could not be written, or a device store that could not be cleared,
// therefore produced exactly the state the marker exists to rule out: the old project's refresh token
// and pairings still on disk, and a next launch that finds nothing pending.
//
// So the steps report, and the marker is written only when every REQUIRED step has succeeded. Each
// step is idempotent, so a launch that fails half-way repeats them all next time; nothing here is
// "mostly applied".

export interface EpochTransitionLike {
  readonly fromEpoch: number;
  readonly toEpoch: number;
  readonly toProjectId: string;
  readonly identityInvalidated: boolean;
}

export interface EpochTransitionDeps {
  /** Forgets the old project's session credential and binding marker. */
  readonly credentialStore: { deleteSecret(ref: string): Promise<void> };
  readonly refreshTokenRef: string;
  readonly bindingRef: string;
  /** Drops every device record: rows in the OLD project's database. */
  readonly deviceStore: { clearAll(): Promise<void> };
  /** Records that the transition has been carried out. Called ONLY when it has. */
  readonly markApplied: (epoch: number, projectId: string) => void;
  readonly log: { info(message: string): void; warn(message: string, fields?: Record<string, unknown>): void };
}

/** The three things a project change discards, in the order they are discarded. */
export type EpochTransitionStep = "refresh-token" | "binding-marker" | "pairings";

export type EpochTransitionOutcome =
  | { readonly applied: true }
  /** Marked NOTHING. The transition stays pending and the next launch repeats every step. */
  | { readonly applied: false; readonly failedStep: EpochTransitionStep; readonly error: string };

/**
 * Applies one pending transition and marks it applied only if every step succeeded.
 *
 * ONLY WHEN THE PROJECT CHANGES is anything discarded: an epoch that rotates a key or moves an endpoint
 * is not a reason to sign anybody out, and such a transition is marked applied at once — there is no
 * work whose failure could leave it half done.
 */
export async function applyEpochTransition(
  pending: EpochTransitionLike,
  deps: EpochTransitionDeps,
): Promise<EpochTransitionOutcome> {
  deps.log.info(
    `control-plane bootstrap: applying epoch ${pending.fromEpoch} -> ${pending.toEpoch}` +
      (pending.identityInvalidated ? " (the project changed; local identity is being reset)" : ""),
  );
  if (pending.identityInvalidated) {
    const steps: readonly [EpochTransitionStep, () => Promise<void>][] = [
      ["refresh-token", () => deps.credentialStore.deleteSecret(deps.refreshTokenRef)],
      ["binding-marker", () => deps.credentialStore.deleteSecret(deps.bindingRef)],
      // The pairings too: a pair id, a phone's uid and a device record are all rows in the OLD
      // project's database. Leaving them would show the user devices they cannot reach and would
      // feed dead pair ids to the next enrolment as adoption hints.
      ["pairings", () => deps.deviceStore.clearAll()],
    ];
    for (const [step, run] of steps) {
      try {
        await run();
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        // Reported, and NOT marked applied: the transition stays pending and the next launch retries
        // it. Half a transition that believed itself finished is the state this exists to avoid — and
        // it is what a `catch` followed by an unconditional mark used to produce.
        deps.log.warn("control-plane bootstrap: the epoch transition could not complete; it stays pending", {
          step,
          error,
        });
        return { applied: false, failedStep: step, error };
      }
    }
  }
  deps.markApplied(pending.toEpoch, pending.toProjectId);
  return { applied: true };
}
