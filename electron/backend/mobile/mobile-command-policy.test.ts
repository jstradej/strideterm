/**
 * Review 2 §P0.3: the desktop's authoritative command policy.
 *
 * The point of these tests is not that the table has the values it has — that is a product
 * decision, and a diff would show it changing. It is that the table is TOTAL over the command
 * union, that authorization is derived from the type rather than from anything the message
 * carried, and that a destructive command cannot buy itself a longer life by saying so.
 */
import { describe, expect, test } from "vitest";
import { ALL_CAPABILITIES, COMMAND_POLICY, checkCommandPolicy, policyFor } from "./mobile-command-policy.js";
import {
  CapabilitySchema,
  CommandSchema,
  MAX_CLIENT_CLOCK_SKEW_MS,
  MAX_DESTRUCTIVE_COMMAND_TTL_MS,
} from "./mobile-schemas.js";
import type { Capability, Command } from "./mobile-schemas.js";
import type { MobileCommandType } from "../../shared/types/notifications.js";

/** Every command type the wire union actually admits, read from the schema rather than re-typed. */
const SCHEMA_COMMAND_TYPES = CommandSchema.options.map((option) => option.shape.type.value as MobileCommandType);

const NOW = 1_755_302_400_000;

function commandOfType(type: MobileCommandType, overrides: Partial<Command> = {}): Command {
  return {
    commandId: "cmd-1",
    idempotencyKey: "idem-1",
    createdAt: NOW,
    expiresAt: NOW + 60_000,
    profileId: "default",
    targetDeviceId: "desktop-1",
    status: "queued",
    type,
    payload: {},
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- payload shape is irrelevant here; the policy never reads it
  } as any as Command;
}

describe("COMMAND_POLICY is exhaustive over the command union", () => {
  test("every wire command type has exactly one policy row, and there are no extra rows", () => {
    // The compiler already enforces one direction (`Record<MobileCommandType, ...>`). This catches
    // the other — a row left behind for a type that no longer exists would otherwise sit there
    // looking authoritative — and it reads the type list off CommandSchema, so a new variant added
    // to the protocol without a policy fails here even before anyone tries to dispatch one.
    expect(Object.keys(COMMAND_POLICY).sort()).toEqual([...SCHEMA_COMMAND_TYPES].sort());
  });

  test("every required capability is a member of the Capability enum", () => {
    for (const type of SCHEMA_COMMAND_TYPES) {
      expect(CapabilitySchema.safeParse(policyFor(type).requiredCapability).success).toBe(true);
    }
  });

  test("ALL_CAPABILITIES is exactly the set the table actually uses, deduplicated", () => {
    const used = new Set(SCHEMA_COMMAND_TYPES.map((type) => policyFor(type).requiredCapability));
    expect([...ALL_CAPABILITIES].sort()).toEqual([...used].sort());
  });

  test("destructive types get the short TTL, and no non-destructive type is held to it by accident", () => {
    for (const type of SCHEMA_COMMAND_TYPES) {
      const policy = policyFor(type);
      if (policy.destructive) {
        expect(policy.maxTtlMs).toBe(MAX_DESTRUCTIVE_COMMAND_TTL_MS);
      }
      expect(policy.maxTtlMs).toBeGreaterThan(0);
    }
  });

  test("every command on this channel is addressed to a desktop", () => {
    for (const type of SCHEMA_COMMAND_TYPES) {
      expect(policyFor(type).allowedTargetKind).toBe("desktop");
    }
  });
});

describe("the capability required is a property of the type, not of the message", () => {
  test("a destructive type cannot be executed by a device holding only the ordinary task grant", () => {
    // The confused-deputy case in one assertion: under v1 the mobile wrote `requiredCapability`, so
    // a client could send task.reset while declaring a grant it happened to hold, and the check
    // passed. There is no field left to write.
    expect(checkCommandPolicy(commandOfType("task.reset"), ["task.control"], NOW)).toEqual({
      ok: false,
      reason: "missing-capability",
    });
    expect(checkCommandPolicy(commandOfType("task.reset"), ["task.destructive"], NOW)).toEqual({ ok: true });
  });

  test("holding every OTHER capability does not admit a type whose own grant is missing", () => {
    for (const type of SCHEMA_COMMAND_TYPES) {
      const required = policyFor(type).requiredCapability;
      const everythingElse = ALL_CAPABILITIES.filter((c) => c !== required) as Capability[];
      expect(checkCommandPolicy(commandOfType(type), everythingElse, NOW)).toEqual({
        ok: false,
        reason: "missing-capability",
      });
      expect(checkCommandPolicy(commandOfType(type), [required], NOW)).toEqual({ ok: true });
    }
  });

  test("opening the remote UI is a separate grant from asking for a tunnel", () => {
    // A live view of the whole remote web UI is strictly more than "reconnect the tunnel", and the
    // pairing dialog can now hand out one without the other.
    expect(checkCommandPolicy(commandOfType("remote.webSession.issue"), ["remote.request"], NOW)).toEqual({
      ok: false,
      reason: "missing-capability",
    });
    expect(checkCommandPolicy(commandOfType("remote.endpoint.request"), ["remote.webSession"], NOW)).toEqual({
      ok: false,
      reason: "missing-capability",
    });
  });

  test("reading status does not require the grant that lets a device change anything", () => {
    expect(checkCommandPolicy(commandOfType("workspace.status.get"), ["status.read"], NOW)).toEqual({ ok: true });
    expect(checkCommandPolicy(commandOfType("task.pause"), ["status.read"], NOW)).toEqual({
      ok: false,
      reason: "missing-capability",
    });
  });
});

describe("lifetime is bounded per type", () => {
  test("a destructive command declaring a 24-hour lifetime is refused", () => {
    // The cloud can only bound the envelope generically — it cannot read the type. This is the
    // per-type bound only the receiver can apply, and a stop/reset that sat in a mailbox for a day
    // before running is a surprise rather than an instruction.
    const command = commandOfType("task.stop", { createdAt: NOW, expiresAt: NOW + 86_400_000 });
    expect(checkCommandPolicy(command, ["task.destructive"], NOW)).toEqual({ ok: false, reason: "ttl-too-long" });
  });

  test("the same lifetime is fine for a non-destructive type", () => {
    const command = commandOfType("task.pause", { createdAt: NOW, expiresAt: NOW + 86_400_000 });
    expect(checkCommandPolicy(command, ["task.control"], NOW)).toEqual({ ok: true });
  });

  test("an already-expired command is refused even when everything else checks out", () => {
    const command = commandOfType("task.pause", { createdAt: NOW - 120_000, expiresAt: NOW - 1 });
    expect(checkCommandPolicy(command, ["task.control"], NOW)).toEqual({ ok: false, reason: "expired" });
  });

  test("capability is checked before lifetime, so a refusal names the real reason", () => {
    const command = commandOfType("task.stop", { createdAt: NOW, expiresAt: NOW + 86_400_000 });
    expect(checkCommandPolicy(command, [], NOW)).toEqual({ ok: false, reason: "missing-capability" });
  });

  test("a command created far in the future is refused, whatever its declared TTL", () => {
    // Review 3 §P0.4. The TTL check measures a DIFFERENCE between two numbers the sender chose, so it
    // says nothing about when "now" is: `createdAt = now + 23h55m` with a five-minute inner TTL passes
    // a five-minute policy and is still live almost a day later. Anchoring createdAt to the receiver's
    // clock is what makes the relative check mean anything.
    const destructive = commandOfType("task.reset", {
      createdAt: NOW + 86_400_000 - 300_000,
      expiresAt: NOW + 86_400_000,
    });
    expect(checkCommandPolicy(destructive, ["task.destructive"], NOW)).toEqual({
      ok: false,
      reason: "created-in-the-future",
    });
  });

  test("a small forward skew is tolerated rather than treated as an attack", () => {
    // Every device's clock is off by something between NTP syncs, and refusing a command a few seconds
    // ahead of the receiver would look like the feature being broken. The tolerance is the same
    // MAX_CLIENT_CLOCK_SKEW_MS the rules and the envelope checks use.
    const command = commandOfType("task.pause", {
      createdAt: NOW + MAX_CLIENT_CLOCK_SKEW_MS - 1_000,
      expiresAt: NOW + MAX_CLIENT_CLOCK_SKEW_MS + 60_000,
    });
    expect(checkCommandPolicy(command, ["task.control"], NOW)).toEqual({ ok: true });
  });

  test("a command older than its own type could possibly live is refused by the lower bound", () => {
    // The other half of anchoring to the receiver's clock: a destructive command whose createdAt is
    // older than five minutes plus the skew tolerance cannot be within its declared lifetime, whatever
    // its expiresAt claims — and `expired` alone would not catch a sender that moved both numbers.
    const command = commandOfType("task.reset", {
      createdAt: NOW - MAX_DESTRUCTIVE_COMMAND_TTL_MS - MAX_CLIENT_CLOCK_SKEW_MS - 1,
      expiresAt: NOW + 60_000,
    });
    expect(checkCommandPolicy(command, ["task.destructive"], NOW)).toEqual({
      ok: false,
      reason: "created-too-long-ago",
    });
  });
});
