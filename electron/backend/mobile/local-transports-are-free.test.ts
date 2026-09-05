// The free half of the product, pinned as a SHAPE rather than as a behaviour.
//
// WHAT THE PLAN PROMISES (§12.2 step 18, and the closing invariants): a lapse, a sign-out or a
// revoke never limits the local desktop, the LAN remote client or the Quick Tunnel. The hosted
// control plane is what is paid for; the terminal on this machine and the two transports that reach
// it without leaving the user's own network are not.
//
// WHY A SOURCE-SHAPE TEST AND NOT A SCENARIO. "It still works when the entitlement lapses" is a
// statement about something NOT happening, and a scenario can only ever demonstrate one arrangement
// of it — sign in, lapse, try. The stronger and cheaper statement is structural: these modules do
// not reach the account state at all, so there is no code path along which an entitlement could
// begin to matter. That is a property a future refactor can break silently, which is exactly the
// kind of thing worth a test.
//
// The cloud half of step 18 — the managed relay grant, the RTDB stream and a queued push all ending
// at the same instant — lives in `strideterm-mobile`'s `cloud/e2e/account-lifecycle.test.mts`, where
// the emulators are. These two halves are the same promise seen from its two sides.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BACKEND_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** Anything that would make a free transport depend on the hosted control plane. */
const HOSTED_IMPORT_PATTERNS = [/\/account\//, /^\.\/account\//, /mobile-firebase/, /entitlement/i];

function sourceOf(relative: string): string {
  return readFileSync(path.join(BACKEND_DIR, relative), "utf8");
}

/** Every module specifier a file imports from, however the import statement is formatted. */
function importSpecifiers(source: string): string[] {
  return [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]!);
}

/**
 * The one assertion, applied to one module.
 *
 * Both halves are needed. The import check catches a dependency added deliberately; the text check
 * catches one added by reaching for a global or a dynamic import — and it refuses even a read that
 * is then ignored, because a read is how a gate starts.
 */
function expectFreeOfTheControlPlane(moduleName: string): void {
  const source = sourceOf(moduleName);
  const offending = importSpecifiers(source).filter((specifier) =>
    HOSTED_IMPORT_PATTERNS.some((pattern) => pattern.test(specifier)),
  );
  expect(offending).toEqual([]);
  expect(source).not.toMatch(/entitlement/i);
  expect(source).not.toMatch(/\baccountManager\b/);
  expect(source).not.toMatch(/\baccountState\b/);
}

describe("the free transports do not depend on the hosted control plane", () => {
  it("the LAN and remote web client server never reads an entitlement", () => {
    // `remote-server.ts` is the LAN/remote web client, and the local self-hosted path a developer
    // runs against it. It is started from `runtime.ts`, which of course knows about everything — a
    // wiring file is not evidence of a dependency, which is why the check is on the module that
    // does the work.
    expectFreeOfTheControlPlane("remote-server.ts");
  });

  it("the Quick Tunnel manager never reads an entitlement", () => {
    expectFreeOfTheControlPlane("tunnel-manager.ts");
  });

  it("the local PTY session manager never reads an entitlement or the mobile relay", () => {
    // Plan §11 row 22 ("relay/issuer down... local desktop still works"): a lapsed or unreachable
    // hosted control plane must leave the terminal itself untouched. The relay connector runs in the
    // same process, so it is not enough that the relay retries sanely on its own (Package 2) — the
    // session manager it would otherwise share a process with must have no path TO it at all.
    expectFreeOfTheControlPlane("session-manager.ts");
    const source = sourceOf("session-manager.ts");
    expect(source).not.toMatch(/mobile-relay/i);
  });

  it("an entitlement IS read somewhere, so the two checks above mean something", () => {
    // The positive half. A test that passed because nothing anywhere consults an entitlement would
    // be proving the feature missing rather than the boundary correct.
    expect(sourceOf(path.join("account", "account-state.ts"))).toMatch(/entitlement/i);
  });
});
