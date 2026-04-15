import path from "node:path";
import os from "node:os";
import { mkdirSync } from "node:fs";
import winston from "winston";
import { APP_CONFIG } from "../../config/app-config.js";

let LOG_DIR = path.join(os.homedir(), ".strideterm", "logs");

/**
 * Override the log directory. Must be called before initLogger().
 */
export function setLogDir(dir) {
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

const LOG_METHODS = Object.keys(CUSTOM_LEVELS.levels);

const TIMESTAMP_FORMAT = winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss.SSS" });
const PRINT_FORMAT = winston.format.printf(({ timestamp, level, label, message, ...rest }) => {
  const tag = label ? `[${label}]` : "";
  const extra = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : "";
  return `${timestamp} ${level.toUpperCase().padEnd(5)} ${tag} ${message}${extra}`;
});

let logger = null;

function resolveConfig(overrides = {}) {
  const cfg = APP_CONFIG.logging || {};
  return {
    level: overrides.level || cfg.level || "warn",
    maxSizeMb: overrides.maxSizeMb ?? cfg.maxSizeMb ?? 5,
    maxFiles: overrides.maxFiles ?? cfg.maxFiles ?? 3,
  };
}

function ensureLogDir() {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
  } catch {
    // Best-effort — if mkdir fails, winston will error on first write
  }
}

function createWinstonLogger({ level, maxSizeMb, maxFiles }) {
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
        tailable: true,
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

  // In dev mode also log to console (respects the same level).
  if (process.env.NODE_ENV !== "production" && !process.env.STRIDETERM_NO_CONSOLE_LOG) {
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
export function initLogger(overrides = {}) {
  const config = resolveConfig(overrides);
  logger = createWinstonLogger(config);
  return logger;
}

/**
 * Re-initialise the logger with new settings (e.g. after loading persisted
 * user settings from the store).  Child loggers obtained via getLogger()
 * are proxies — they automatically pick up the new instance.
 */
export function reconfigureLogger(overrides = {}) {
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
export function getLogger(label) {
  if (!logger) {
    // Lazy-init with defaults if initLogger wasn't called yet (e.g. tests)
    initLogger();
  }
  const proxy = {};
  for (const method of LOG_METHODS) {
    proxy[method] = (message, meta) => logger[method](message, meta ? { ...meta, label } : { label });
  }
  return proxy;
}

/**
 * Change the runtime log level without restart.
 */
export function setLogLevel(level) {
  if (logger && CUSTOM_LEVELS.levels[level] !== undefined) {
    logger.level = level;
  }
}

/**
 * Flush and close transports (call on app shutdown).
 */
export async function shutdownLogger() {
  if (!logger) return;
  return new Promise((resolve) => {
    logger.on("finish", resolve);
    logger.end();
  });
}
