import { Effect, Layer, ManagedRuntime } from "effect";
import { NodeServices } from "@effect/platform-node";
import { withOperation, operationContextStorage } from "./operation-context.js";
import type { OperationContext } from "./operation-context.js";

// Merge Node platform services (FileSystem, Path, Stdio, Terminal) as the
// base layer.  Additional application layers (Logger, etc.) are composed here.
export const MainLayer = NodeServices.layer;

// Single shared ManagedRuntime for the Electron main process.  Disposed on
// app quit — see wiring.ts.
export const runtime = ManagedRuntime.make(MainLayer);

// Run an Effect and return a Promise.  For use in non-Effect callers (IPC
// handlers, legacy async code).
export const runEffect = <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> => runtime.runPromise(effect);

// Run fn() inside an operation context scope.  Populates both the Effect
// Context.Reference (for Effect code) and AsyncLocalStorage (for synchronous
// code like the logger proxy) with the merged operation context.
export const withOperationPromise = <A>(ctx: Partial<OperationContext>, fn: () => A | Promise<A>): Promise<A> => {
  const merged: OperationContext = { opId: ctx.opId ?? "root", ...ctx };
  return operationContextStorage.run(merged, () =>
    runtime.runPromise(
      withOperation(
        ctx,
        Effect.promise(() => Promise.resolve(fn())),
      ),
    ),
  );
};
