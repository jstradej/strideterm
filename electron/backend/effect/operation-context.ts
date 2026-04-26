import { AsyncLocalStorage } from "node:async_hooks";
import { Context, Effect } from "effect";

export interface OperationContext {
  readonly workspaceId?: string;
  readonly opId: string;
  readonly correlationId?: string;
}

export const OperationContextRef = Context.Reference<OperationContext>("strideterm/OperationContext", {
  defaultValue: () => ({ opId: "root" }),
});

// AsyncLocalStorage adapter — lets non-Effect code (logger proxy) read the
// current operation context synchronously without being inside an Effect fiber.
// withOperationPromise populates this alongside the Effect context.
export const operationContextStorage = new AsyncLocalStorage<OperationContext>();

// Run `effect` with an updated operation context derived from the current one.
// Uses Effect.gen so the Reference can be yielded and the new value provided
// via Effect.provideService (v4's replacement for Effect.locallyWith).
export const withOperation = <A, E, R>(
  ctx: Partial<OperationContext>,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const current = yield* OperationContextRef;
    const next: OperationContext = {
      ...current,
      ...ctx,
      opId: ctx.opId ?? crypto.randomUUID(),
    };
    return yield* effect.pipe(Effect.provideService(OperationContextRef, next));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: cast needed; provideService narrowing strips R but can't verify it
  }) as any as Effect.Effect<A, E, R>;

// Yield the current OperationContext in Effect.gen code.
export const getOperation = Effect.gen(function* () {
  return yield* OperationContextRef;
});
