import { Effect, Layer, ManagedRuntime } from "effect";
import { NodeServices } from "@effect/platform-node";
import { withOperation } from "./operation-context.js";
import type { OperationContext } from "./operation-context.js";

// Merge Node platform services (FileSystem, Path, Stdio, Terminal) as the
// base layer.  Additional application layers (Logger, etc.) are composed here.
export const MainLayer = NodeServices.layer;

// Single shared ManagedRuntime for the Electron main process.  Disposed on
// app quit — see wiring.ts.
export const runtime = ManagedRuntime.make(MainLayer);

// Run an Effect and return a Promise.  For use in non-Effect callers (IPC
// handlers, legacy async code).
export const runEffect = <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> =>
  runtime.runPromise(effect);

// Run fn() inside an operation context scope.  Enables any transitive Effect
// code invoked by fn to see the operation context.
export const withOperationPromise = <A>(
  ctx: Partial<OperationContext>,
  fn: () => Promise<A>,
): Promise<A> => runtime.runPromise(withOperation(ctx, Effect.promise(fn)));
