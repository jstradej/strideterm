// The epoch transition marks itself applied only when its work is done (G06).
//
// F14 made the transition a durable next-launch step with the marker written last. The runtime then
// ran the cleanup inside a `try`, logged a failure as "it stays pending" — and marked it applied on the
// line after the `catch`. So a credential store that could not be written, or a device store that
// could not be cleared, produced the state the marker exists to rule out: the old project's token and
// pairings still on disk, and a next launch that finds nothing pending.
import { describe, expect, test } from "vitest";

import { applyEpochTransition, type EpochTransitionDeps } from "./epoch-transition.js";

const PENDING = { fromEpoch: 3, toEpoch: 5, toProjectId: "strideterm-restored", identityInvalidated: true };

function world(options: { failSecret?: string; failClear?: boolean } = {}) {
  const deleted: string[] = [];
  const marked: Array<[number, string]> = [];
  const warnings: Array<Record<string, unknown> | undefined> = [];
  let cleared = 0;
  const deps: EpochTransitionDeps = {
    credentialStore: {
      async deleteSecret(ref) {
        if (ref === options.failSecret) throw new Error("the keychain is locked");
        deleted.push(ref);
      },
    },
    refreshTokenRef: "mobile:firebase-refresh-token",
    bindingRef: "mobile:account-binding",
    deviceStore: {
      async clearAll() {
        if (options.failClear) throw new Error("SQLITE_BUSY");
        cleared += 1;
      },
    },
    markApplied: (epoch, projectId) => void marked.push([epoch, projectId]),
    log: { info: () => {}, warn: (_message, fields) => void warnings.push(fields) },
  };
  return { deps, deleted, marked, warnings, cleared: () => cleared };
}

describe("applyEpochTransition", () => {
  test("a transition whose every step succeeds is marked applied, last", async () => {
    const w = world();
    const outcome = await applyEpochTransition(PENDING, w.deps);
    expect(outcome).toEqual({ applied: true });
    expect(w.deleted).toEqual(["mobile:firebase-refresh-token", "mobile:account-binding"]);
    expect(w.cleared()).toBe(1);
    expect(w.marked).toEqual([[5, "strideterm-restored"]]);
  });

  test("a credential store that cannot be written leaves the transition PENDING — nothing is marked", async () => {
    // The G06 case: the refresh token could not be deleted. The old code logged this and marked the
    // epoch applied anyway.
    const w = world({ failSecret: "mobile:firebase-refresh-token" });
    const outcome = await applyEpochTransition(PENDING, w.deps);
    expect(outcome).toEqual({ applied: false, failedStep: "refresh-token", error: "the keychain is locked" });
    expect(w.marked).toEqual([]);
    expect(w.warnings[0]).toMatchObject({ step: "refresh-token" });
  });

  test("a device store that cannot be cleared leaves it pending too, after the credentials went", async () => {
    // Every step is idempotent, so the next launch repeating the two that succeeded costs nothing; the
    // one that did not is the one that matters.
    const w = world({ failClear: true });
    const outcome = await applyEpochTransition(PENDING, w.deps);
    expect(outcome).toMatchObject({ applied: false, failedStep: "pairings" });
    expect(w.deleted).toHaveLength(2);
    expect(w.marked).toEqual([]);
  });

  test("a failed binding-marker delete is a failed transition as well", async () => {
    const w = world({ failSecret: "mobile:account-binding" });
    expect(await applyEpochTransition(PENDING, w.deps)).toMatchObject({ applied: false, failedStep: "binding-marker" });
    expect(w.marked).toEqual([]);
  });

  test("an epoch that keeps the same project discards nothing and is marked applied at once", async () => {
    // A key rotation or an endpoint move. Signing everybody out for it would be a self-inflicted
    // outage, and there is no work whose failure could leave it half done.
    const w = world({ failSecret: "mobile:firebase-refresh-token", failClear: true });
    const outcome = await applyEpochTransition({ ...PENDING, identityInvalidated: false }, w.deps);
    expect(outcome).toEqual({ applied: true });
    expect(w.deleted).toEqual([]);
    expect(w.marked).toEqual([[5, "strideterm-restored"]]);
  });
});
