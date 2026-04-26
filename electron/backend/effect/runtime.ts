import { Effect } from "effect";
import { operationContextStorage } from "./operation-context.js";
import type { OperationContext } from "./operation-context.js";

// Run an Effect and return a Promise. For use in non-Effect callers (IPC
// handlers, legacy async code). Errors are thrown as exceptions.
export const runEffect = <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> => Effect.runPromise(effect);

// Run fn() inside an operation context so the logger proxy and any
// AsyncLocalStorage-aware code see the merged context throughout the
// entire async call tree.
export const withOperationPromise = <A>(ctx: Partial<OperationContext>, fn: () => A | Promise<A>): Promise<A> => {
  const merged: OperationContext = { opId: ctx.opId ?? "root", ...ctx };
  return operationContextStorage.run(merged, () => Promise.resolve(fn()));
};
