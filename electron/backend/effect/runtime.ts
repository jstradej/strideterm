import { Effect } from "effect";
import { operationContextStorage } from "./operation-context.js";
import type { OperationContext } from "./operation-context.js";

// Run an Effect and return a Promise. For use in non-Effect callers (IPC
// handlers, legacy async code). Effects with a failure channel must provide an
// explicit conversion to the Error rejected by the Promise boundary.
export function runEffect<A>(effect: Effect.Effect<A, never, never>): Promise<A>;
export function runEffect<A, E>(effect: Effect.Effect<A, E, never>, onFailure: (error: E) => Error): Promise<A>;
export async function runEffect<A, E>(effect: Effect.Effect<A, E, never>, onFailure?: (error: E) => Error): Promise<A> {
  if (!onFailure) return Effect.runPromise(effect);

  const outcome = await Effect.runPromise(
    Effect.match(effect, {
      onSuccess: (value) => ({ ok: true as const, value }),
      onFailure: (error) => ({ ok: false as const, error: onFailure(error) }),
    }),
  );
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

// Run fn() inside an operation context so the logger proxy and any
// AsyncLocalStorage-aware code see the merged context throughout the
// entire async call tree.
export const withOperationPromise = <A>(ctx: Partial<OperationContext>, fn: () => A | Promise<A>): Promise<A> => {
  const merged: OperationContext = { opId: ctx.opId ?? "root", ...ctx };
  return operationContextStorage.run(merged, () => Promise.resolve(fn()));
};
