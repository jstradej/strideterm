/// <reference types="node" />
import path from "node:path";
import os from "node:os";
import { mkdirSync } from "node:fs";
import winston from "winston";
import { APP_CONFIG } from "../../config/app-config.js";
import { operationContextStorage } from "./effect/operation-context.js";

// In a Vitest worker we deliberately redirect to a per-process temp dir so
// running `npm run test:backend` doesn't append `ws1:p1` / `workspace-a` /
// `wrong-secret` / `/tmp/test` lines to the user's production
// ~/.strideterm/logs/strideterm.log. Without this, every test run pollutes
// real diagnostic output — and because file paths live for the lifetime of
// the singleton logger, setLogDir() called later can't unspoil writes that
// already happened during module import.
//
// Vitest sets process.env.VITEST="true" in workers; we also honour an
// explicit STRIDETERM_LOG_DIR override for any other "don't write to ~"
// scenario (CI without a real home, sandbox runs, etc).
function defaultLogDir(): string {
  if (process.env.STRIDETERM_LOG_DIR) return process.env.STRIDETERM_LOG_DIR;
  if (process.env.VITEST === "true" || process.env.NODE_ENV === "test") {
    return path.join(os.tmpdir(), `strideterm-test-logs-${process.pid}`);
  }
  return path.join(os.homedir(), ".strideterm", "logs");
}

let LOG_DIR = defaultLogDir();

/**
 * Override the log directory. Must be called before initLogger().
 */
export function setLogDir(dir: string): void {
  LOG_DIR = dir;
}

// Winston uses syslog-adjacent levels by default. We define custom levels
// matching the familiar ERROR / WARN / INFO / DEBUG / TRACE hierarchy.
const CUSTOM_LEVELS = {
  levels: {
    error: 0,
    warn: 1,
    info: 2,
    debug: 3,
    trace: 4,
  },
};

type LogLevelName = keyof typeof CUSTOM_LEVELS.levels;
const LOG_METHODS = Object.keys(CUSTOM_LEVELS.levels) as LogLevelName[];

const TIMESTAMP_FORMAT = winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss.SSS" });

// ---------------------------------------------------------------------------
// Token redaction
// ---------------------------------------------------------------------------
// strideterm carries a handful of high-value secrets through error paths
// (Azure PAT, GitHub PAT, Telegram bot token, remote-access token, SSH
// passphrases). When an outbound HTTP call fails the URL or Authorization
// header can land in the log. We strip those patterns before winston ever
// sees the structured payload so a leaked log directory doesn't double as
// a credential dump.
//
// The patterns are deliberately broad — we'd rather over-redact a stray
// "token=..." in user content than under-redact a real secret. Bot tokens
// in URL paths (`/bot<token>/`, used by Telegram) and bearer tokens in
// Authorization headers are the highest-priority cases.
const REDACTED = "[REDACTED]";
const TOKEN_PATTERNS: Array<[RegExp, string]> = [
  // Telegram: https://api.telegram.org/bot<digits>:<token>/method
  [/(\/bot)\d{6,}:[A-Za-z0-9_-]{20,}/g, `$1${REDACTED}`],
  // Authorization: Bearer <token>  /  authorization: bearer <token>
  [/(authorization\s*[:=]\s*"?\s*bearer\s+)[^\s",}\]]+/gi, `$1${REDACTED}`],
  [/(\bbearer\s+)[A-Za-z0-9._\-+/=]{16,}/gi, `$1${REDACTED}`],
  // Azure PAT / generic ?token=... or &pat=... query strings
  [/([?&](?:token|pat|access_token|api[_-]?key)=)[^&\s"']+/gi, `$1${REDACTED}`],
  // JSON-style: "token":"...",  "pat":"...",  "password":"...", "secret":"..."
  [
    /("(?:token|pat|access[_-]?token|api[_-]?key|password|passphrase|secret|botToken)"\s*:\s*")[^"]+/gi,
    `$1${REDACTED}`,
  ],
];

function redactSecrets(value: string): string {
  let result = value;
  for (const [pattern, replacement] of TOKEN_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

const PRINT_FORMAT = winston.format.printf(({ timestamp, level, label, message, ...rest }) => {
  const tag = label ? `[${label}]` : "";
  const safeMessage = typeof message === "string" ? redactSecrets(message) : String(message);
  const extra = Object.keys(rest).length ? ` ${redactSecrets(JSON.stringify(rest))}` : "";
  return `${timestamp} ${level.toUpperCase().padEnd(5)} ${tag} ${safeMessage}${extra}`;
});

// Exposed for the focused unit test in logger-redaction.test.ts. Not part
// of the public Logger interface — callers should never need to redact
// before logging; the format does it on every emission.
export const __redactSecretsForTesting = redactSecrets;

type LogMethod = (message: string, meta?: Record<string, unknown>) => void;

export interface Logger {
  error: LogMethod;
  warn: LogMethod;
  info: LogMethod;
  debug: LogMethod;
  trace: LogMethod;
}

interface LogConfig {
  level: string;
  maxSizeMb: number;
  maxFiles: number;
}

let logger: winston.Logger | null = null;
// Flipped by shutdownLogger() so late callers (PTY exit/data events that fire
// after we've ended winston's transports) silently drop their log entries
// instead of crashing the process with "write after end" NodeError.
let loggerClosed = false;

function resolveConfig(overrides: Partial<LogConfig> = {}): LogConfig {
  const cfg = (APP_CONFIG.logging || {}) as Partial<LogConfig>;
  return {
    level: overrides.level || cfg.level || "warn",
    maxSizeMb: overrides.maxSizeMb ?? cfg.maxSizeMb ?? 5,
    maxFiles: overrides.maxFiles ?? cfg.maxFiles ?? 3,
  };
}

function ensureLogDir(): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
  } catch {
    // Best-effort — if mkdir fails, winston will error on first write
  }
}

function createWinstonLogger({ level, maxSizeMb, maxFiles }: LogConfig): winston.Logger {
  ensureLogDir();

  const instance = winston.createLogger({
    levels: CUSTOM_LEVELS.levels,
    level,
    format: winston.format.combine(TIMESTAMP_FORMAT, PRINT_FORMAT),
    transports: [
      new winston.transports.File({
        filename: path.join(LOG_DIR, "strideterm.log"),
        maxsize: maxSizeMb * 1024 * 1024,
        maxFiles,
        // tailable: true would rename strideterm.log → strideterm1.log on every
        // rotation, but Windows blocks renaming a file that still has an open
        // handle (winston's own writer). winston then retries forever via
        // fs.rename + suppressedCallback, which on a busy dev session burned
        // ~1.4 % CPU constantly in the libuv thread pool. With tailable off
        // winston rotates forward (new chunk lands in strideterm1.log, old
        // strideterm.log stays put), so the active file handle never needs to
        // move.
        tailable: false,
      }),
      new winston.transports.File({
        filename: path.join(LOG_DIR, "strideterm-error.log"),
        level: "error",
        maxsize: 2 * 1024 * 1024,
        maxFiles: 2,
        tailable: true,
      }),
    ],
  });

  // In dev mode also log to console (respects the same level). Tests get
  // suppressed regardless — vitest reporters interleave their own output and
  // raw winston lines just add noise.
  const isTest = process.env.VITEST === "true" || process.env.NODE_ENV === "test";
  if (!isTest && process.env.NODE_ENV !== "production" && !process.env.STRIDETERM_NO_CONSOLE_LOG) {
    instance.add(
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.colorize({
            colors: { error: "red", warn: "yellow", info: "cyan", debug: "grey", trace: "grey" },
          }),
          TIMESTAMP_FORMAT,
          PRINT_FORMAT,
        ),
      }),
    );
  }

  return instance;
}

/**
 * Initialise the singleton logger.
 *
 * Call once at startup (before any getLogger() calls).
 * Reads level/maxSizeMb/maxFiles from APP_CONFIG.logging (with env var
 * overrides) and applies any explicit `overrides` on top.
 */
export function initLogger(overrides: Partial<LogConfig> = {}): winston.Logger {
  const config = resolveConfig(overrides);
  logger = createWinstonLogger(config);
  return logger;
}

/**
 * Re-initialise the logger with new settings (e.g. after loading persisted
 * user settings from the store).  Child loggers obtained via getLogger()
 * are proxies — they automatically pick up the new instance.
 */
export function reconfigureLogger(overrides: Partial<LogConfig> = {}): winston.Logger {
  const config = resolveConfig(overrides);
  if (!logger) {
    return initLogger(overrides);
  }
  // Close old transports and create a fresh instance
  logger.close();
  logger = createWinstonLogger(config);
  return logger;
}

/**
 * Returns a proxy logger tagged with the given module label.
 *
 * The proxy delegates every call to the current singleton, so it survives
 * reconfigureLogger() without going stale.
 *
 * Usage:
 *   import { getLogger } from "./logger.js";
 *   const log = getLogger("runtime");
 *   log.trace("some detail");
 *   log.error("something broke", { err: error.message });
 */
export function getLogger(label: string): Logger {
  if (!logger) {
    // Lazy-init with defaults if initLogger wasn't called yet (e.g. tests)
    initLogger();
  }
  const proxy = {} as Logger;
  for (const method of LOG_METHODS) {
    proxy[method] = (message, meta) => {
      if (loggerClosed) return;
      const ctx = operationContextStorage.getStore();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: winston logger method dispatch via string key; logger is hot path called from all layers
      (logger! as any)[method](message, { ...ctx, ...(meta || {}), label });
    };
  }
  return proxy;
}

/**
 * Change the runtime log level without restart.
 */
export function setLogLevel(level: string): void {
  if (logger && CUSTOM_LEVELS.levels[level as LogLevelName] !== undefined) {
    logger.level = level;
  }
}

/**
 * Flush and close transports (call on app shutdown).
 */
export async function shutdownLogger(): Promise<void> {
  if (!logger) return;
  // Set the gate before calling end(): any log emitted on this microtask or
  // later (PTY exit/data events ride a synchronous emit chain that may run
  // after we've called end() but before "finish" fires) becomes a no-op.
  loggerClosed = true;
  return new Promise((resolve) => {
    logger!.on("finish", resolve);
    logger!.end();
  });
}

/**
 * Create a dedicated audit logger writing to its own file at always-info
 * level. Independent of the main logger's user-configurable level so a
 * forensic trail is always captured for security-relevant events.
 *
 * Reuses the same token-redaction format as the main logger.
 */
export function createAuditLogger(name: string): { info: LogMethod; warn: LogMethod; close: () => void } {
  ensureLogDir();
  const filename = path.join(LOG_DIR, `${name}.log`);
  const instance = winston.createLogger({
    levels: CUSTOM_LEVELS.levels,
    level: "info",
    format: winston.format.combine(TIMESTAMP_FORMAT, PRINT_FORMAT),
    transports: [
      new winston.transports.File({
        filename,
        maxsize: 5 * 1024 * 1024,
        maxFiles: 5,
        tailable: true,
      }),
    ],
  });
  return {
    info: (message, meta) => instance.info(message, { ...(meta || {}), label: name }),
    warn: (message, meta) => instance.warn(message, { ...(meta || {}), label: name }),
    close: () => instance.close(),
  };
}
