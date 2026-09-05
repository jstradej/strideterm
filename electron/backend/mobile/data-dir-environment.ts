// Binds this desktop's data directory to the environment it was FIRST declared for (plan §3.3).
//
// THE GAP THIS CLOSES. `bootstrap-client.ts` persists an envelope, a rollback epoch floor and an
// applied-transition marker under the data directory — and `runtime.ts` keeps the mobile Auth refresh
// token and the account-binding marker in the SAME directory's credential store, under fixed,
// environment-free keys. None of that state names which environment wrote it. So re-declaring
// `STRIDETERM_ENV` over an already-used data directory — `local` today, `dev` tomorrow, same
// `--data-dir` or the same default — inherited whatever the OTHER environment had left there: a
// rollback floor that has nothing to do with the new backend, and a refresh token minted against a
// project the new declaration does not name.
//
// A DATA DIRECTORY IS FOR ONE ENVIRONMENT. The binding is written the first time a resolved
// environment is asked for, and every later declaration is checked against it. It is never
// overwritten to heal a mismatch — that would be exactly the silent re-declaration this file exists
// to refuse. The only way to move it is a human action: delete the marker (a fresh profile in the
// same directory) or point `--data-dir`/`STRIDETERM_DATA_DIR` at a new one — "vyžádá nový izolovaný
// profil" (plan §3.3).
//
// "UNRESOLVED" IS NOT AN ENVIRONMENT. A build with no recognised `STRIDETERM_ENV` already refuses a
// new sign-in and treats the trust set as production's (see `bootstrap-trust.ts`) — see
// `bootstrapEnvironmentFor`. Binding a data directory to that fail-closed substitute would risk
// permanently locking a fresh directory to `prod` over a transient misconfiguration, so callers must
// only ask this module about one of the four real environments.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { BootstrapEnvironment } from "./control-plane-bootstrap.js";

const BINDING_FILE = "mobile-environment.json";

interface StoredBinding {
  readonly environment: BootstrapEnvironment;
}

export interface DataDirEnvironmentBinding {
  /** The environment this data directory is bound to, after this call. */
  readonly bound: BootstrapEnvironment;
  /** Present only when `declared` disagreed with an EXISTING binding. */
  readonly mismatch?: { readonly boundTo: BootstrapEnvironment };
}

function isBootstrapEnvironment(value: unknown): value is BootstrapEnvironment {
  return value === "local" || value === "dev" || value === "qa" || value === "prod";
}

function read(bindingPath: string): StoredBinding | null {
  try {
    const parsed = JSON.parse(readFileSync(bindingPath, "utf8")) as { environment?: unknown };
    return isBootstrapEnvironment(parsed?.environment) ? { environment: parsed.environment } : null;
  } catch {
    // Missing or unreadable: no binding has ever been recorded here, which is the correct starting
    // state and not an error worth failing a launch over — same treatment as the bootstrap state file.
    return null;
  }
}

function write(bindingPath: string, next: StoredBinding): void {
  mkdirSync(dirname(bindingPath), { recursive: true });
  const temporary = `${bindingPath}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  renameSync(temporary, bindingPath);
}

/**
 * Binds `stateDir` to `declared` the first time it is asked, and reports a mismatch every time after
 * that a DIFFERENT environment is declared over it.
 *
 * `declared` must be one of the four real environments — never `"unresolved"` — see the module
 * header. Idempotent when the declaration agrees with what is already bound: a restart under the same
 * `STRIDETERM_ENV` is the ordinary case and must not look like a fresh binding each time.
 */
export function bindDataDirToEnvironment(stateDir: string, declared: BootstrapEnvironment): DataDirEnvironmentBinding {
  const bindingPath = join(stateDir, BINDING_FILE);
  const stored = read(bindingPath);
  if (!stored) {
    write(bindingPath, { environment: declared });
    return { bound: declared };
  }
  if (stored.environment !== declared) {
    return { bound: stored.environment, mismatch: { boundTo: stored.environment } };
  }
  return { bound: stored.environment };
}
