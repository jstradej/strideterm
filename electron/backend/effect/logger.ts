import { Context, Effect, Layer } from "effect";
import { getOperation } from "./operation-context.js";

type LogLevel = "error" | "warn" | "info" | "debug" | "trace";
type LogMethod = (message: string, meta?: Record<string, unknown>) => Effect.Effect<void>;

export interface LoggerShape {
  readonly error: LogMethod;
  readonly warn: LogMethod;
  readonly info: LogMethod;
  readonly debug: LogMethod;
  readonly trace: LogMethod;
}

// Effect Logger service — wraps the existing winston logger and enriches
// every structured log entry with the current OperationContext.
export class Logger extends Context.Service<Logger, LoggerShape>()("strideterm/Logger") {}

// Build a live implementation from any object that has the five log methods.
// The caller (main.ts wiring) passes the existing winston logger proxy.
export const makeLoggerLive = (
  winstonLike: Record<LogLevel, (msg: string, meta?: Record<string, unknown>) => void>,
): Layer.Layer<Logger> =>
  Layer.effect(
    Logger,
    Effect.sync(() => {
      const makeLogFn =
        (level: LogLevel): LogMethod =>
        (message, meta) =>
          Effect.gen(function* () {
            const ctx = yield* getOperation;
            winstonLike[level](message, { ...ctx, ...(meta ?? {}) });
          });

      return Logger.of({
        error: makeLogFn("error"),
        warn: makeLogFn("warn"),
        info: makeLogFn("info"),
        debug: makeLogFn("debug"),
        trace: makeLogFn("trace"),
      });
    }),
  );
