/**
 * The desktop's authoritative command policy (review 2 §P0.3).
 *
 * WHAT WAS WRONG. `Command` used to carry a `requiredCapability` string, written by the mobile
 * client, and `mobile-command-dispatch.ts` authorized against it:
 *
 *     if (!device.capabilities.includes(command.requiredCapability)) reject();
 *
 * That is a confused deputy in the textbook shape. The party being authorized chose the label it
 * was authorized against, so a hostile or modified client could send `task.reset` (destructive,
 * wipes a task) while declaring `requiredCapability: "notifications"` — a grant every paired phone
 * holds — and the check would pass. Nothing else in the pipeline looked at the command's *type*
 * when deciding whether it was allowed.
 *
 * It was also, separately, simply broken: the desktop's pairing dialog granted coarse capabilities
 * (`task.control`, `remote.request`) while the mobile stamped the command TYPE into
 * `requiredCapability` (`task.pause`), so `capabilities.includes("task.pause")` was false for every
 * command a legitimately-paired device sent. The field had never authorized anything correctly in
 * either direction.
 *
 * WHAT REPLACES IT. This table. The required capability, the destructiveness, the maximum lifetime
 * and the kind of target a command may name are properties of the command TYPE, decided here, by
 * the party that executes — read from a plaintext only this desktop can decrypt. The wire field is
 * gone from the protocol entirely, so there is nothing left for a client to assert.
 *
 * EXHAUSTIVENESS. `COMMAND_POLICY` is typed as `Record<MobileCommandType, CommandPolicy>`, so
 * adding a command type to the shared union without adding a row here is a compile error, not a
 * runtime "capability not found" that fails open or closed by accident. `mobile-command-policy.test.ts`
 * additionally asserts at runtime that the table's keys are exactly the schema union's, which
 * catches the reverse (a row for a type that no longer exists) and covers the case where the union
 * is widened by something other than a literal type.
 */
import {
  MAX_CLIENT_CLOCK_SKEW_MS,
  MAX_COMMAND_TTL_MS,
  MAX_DESTRUCTIVE_COMMAND_TTL_MS,
  type Capability,
  type Command,
} from "./mobile-schemas.js";
import type { MobileCommandType } from "../../shared/types/notifications.js";

/** What kind of installation a command may be addressed to. Every command on this channel travels mobile -> desktop. */
export type CommandTargetKind = "desktop";

export interface CommandPolicy {
  /** The one grant a device must hold for this type. Derived from the type, never from the message. */
  requiredCapability: Capability;
  /**
   * Whether executing this command destroys work. Destructive types get a much shorter maximum TTL
   * (a stop/reset that sat in a mailbox for a day and then ran is a surprise, not an instruction)
   * and are the ones the mobile UI must confirm before building at all — which the wire schema also
   * enforces, via `confirmed: true` on their payloads.
   */
  destructive: boolean;
  /** The installation kind this command may name as its target. */
  allowedTargetKind: CommandTargetKind;
  /**
   * Whether re-running the underlying runtime call from scratch after a crash converges to the same
   * target state. A non-idempotent command interrupted between claim and result becomes
   * `outcome-unknown` on restart rather than being silently re-executed.
   */
  idempotent: boolean;
  /** The longest `expiresAt - createdAt` this type may declare. */
  maxTtlMs: number;
}

const TWENTY_FOUR_HOURS = MAX_COMMAND_TTL_MS;
const FIVE_MINUTES = MAX_DESTRUCTIVE_COMMAND_TTL_MS;

export const COMMAND_POLICY: Record<MobileCommandType, CommandPolicy> = {
  "notification.acknowledge": {
    requiredCapability: "notifications",
    destructive: false,
    allowedTargetKind: "desktop",
    idempotent: true,
    maxTtlMs: TWENTY_FOUR_HOURS,
  },
  "task.pause": {
    requiredCapability: "task.control",
    destructive: false,
    allowedTargetKind: "desktop",
    idempotent: true,
    maxTtlMs: TWENTY_FOUR_HOURS,
  },
  "task.resume": {
    requiredCapability: "task.control",
    destructive: false,
    allowedTargetKind: "desktop",
    idempotent: true,
    maxTtlMs: TWENTY_FOUR_HOURS,
  },
  "task.stop": {
    // A separate grant from `task.control`: stopping and resetting throw work away, and a user who
    // wants a phone to be able to pause a run does not thereby want it able to discard one.
    requiredCapability: "task.destructive",
    destructive: true,
    allowedTargetKind: "desktop",
    idempotent: true,
    maxTtlMs: FIVE_MINUTES,
  },
  "task.reset": {
    requiredCapability: "task.destructive",
    destructive: true,
    allowedTargetKind: "desktop",
    idempotent: true,
    maxTtlMs: FIVE_MINUTES,
  },
  "task.updateDescription": {
    requiredCapability: "task.control",
    destructive: false,
    allowedTargetKind: "desktop",
    idempotent: true,
    maxTtlMs: TWENTY_FOUR_HOURS,
  },
  "task.sendInstruction": {
    requiredCapability: "task.control",
    destructive: false,
    allowedTargetKind: "desktop",
    // Re-running it re-sends text to the agent — a real duplicate side effect no state check undoes.
    idempotent: false,
    maxTtlMs: TWENTY_FOUR_HOURS,
  },
  "profile.catalog.get": {
    requiredCapability: "status.read",
    destructive: false,
    allowedTargetKind: "desktop",
    idempotent: true,
    maxTtlMs: TWENTY_FOUR_HOURS,
  },
  "remote.status.get": {
    requiredCapability: "status.read",
    destructive: false,
    allowedTargetKind: "desktop",
    idempotent: true,
    maxTtlMs: TWENTY_FOUR_HOURS,
  },
  "remote.endpoint.request": {
    requiredCapability: "remote.request",
    destructive: false,
    allowedTargetKind: "desktop",
    idempotent: false,
    maxTtlMs: FIVE_MINUTES,
  },
  "remote.tunnel.reconnect": {
    requiredCapability: "remote.request",
    destructive: false,
    allowedTargetKind: "desktop",
    // Restarting a *working* tunnel hands out a new URL, breaking an active mobile session.
    idempotent: false,
    maxTtlMs: FIVE_MINUTES,
  },
  "remote.webSession.issue": {
    // Its own grant: a WebView session is a live view of the whole remote UI, which is a strictly
    // larger thing to hand out than "may ask the tunnel to reconnect".
    requiredCapability: "remote.webSession",
    destructive: false,
    allowedTargetKind: "desktop",
    // Each call mints a brand-new single-use ticket.
    idempotent: false,
    maxTtlMs: FIVE_MINUTES,
  },
  "workspace.status.get": {
    requiredCapability: "status.read",
    destructive: false,
    allowedTargetKind: "desktop",
    idempotent: true,
    maxTtlMs: TWENTY_FOUR_HOURS,
  },
};

/** The policy for a command, by its type. Total by construction — see the module doc on exhaustiveness. */
export function policyFor(type: MobileCommandType): CommandPolicy {
  return COMMAND_POLICY[type];
}

/** Every capability the pairing dialog may offer, derived from the policy table rather than listed twice. */
export const ALL_CAPABILITIES: readonly Capability[] = [
  ...new Set(Object.values(COMMAND_POLICY).map((policy) => policy.requiredCapability)),
].sort();

export type CommandPolicyViolation =
  "missing-capability" | "ttl-too-long" | "expired" | "created-in-the-future" | "created-too-long-ago";

/**
 * The policy half of the authorization decision, as a pure function.
 *
 * Deliberately does NOT take a `requiredCapability` argument: there is nowhere for one to come from
 * any more. The only inputs are the command itself, the grants recorded on the device at pairing
 * time, and the clock.
 */
export function checkCommandPolicy(
  command: Command,
  deviceCapabilities: readonly string[],
  now: number,
): { ok: true } | { ok: false; reason: CommandPolicyViolation } {
  const policy = policyFor(command.type);
  if (!deviceCapabilities.includes(policy.requiredCapability)) {
    return { ok: false, reason: "missing-capability" };
  }
  // ABSOLUTE BOUNDS BEFORE THE RELATIVE ONE (review 3 §P0.4).
  //
  // The TTL check below measures a DIFFERENCE between two numbers the sender chose, and that is all it
  // ever measured. So a hostile phone could satisfy the five-minute destructive maximum with
  // `createdAt = now + 23h55m, expiresAt = createdAt + 5m`: the difference is five minutes, the
  // `expiresAt > now` test passes with almost a day to spare, and an offline desktop could execute the
  // command the following day. Anchoring `createdAt` to the receiver's clock is what makes the relative
  // bound mean "recent and short-lived" rather than merely "short".
  //
  // The skew tolerance is the same MAX_CLIENT_CLOCK_SKEW_MS the Security Rules and the callables use: a
  // device whose clock is a minute fast is every device between NTP syncs, and refusing its commands
  // outright would be a worse failure than accepting a slightly-future createdAt.
  if (command.createdAt > now + MAX_CLIENT_CLOCK_SKEW_MS) {
    return { ok: false, reason: "created-in-the-future" };
  }
  // A command may legitimately have waited in the mailbox for its whole declared lifetime, so the lower
  // bound is that lifetime plus skew — not a fixed number, or a destructive command's five minutes and
  // an ordinary command's day would share one wrong answer.
  if (command.createdAt < now - policy.maxTtlMs - MAX_CLIENT_CLOCK_SKEW_MS) {
    return { ok: false, reason: "created-too-long-ago" };
  }
  // A destructive command that declared a 24-hour lifetime is not a destructive command the user
  // meant to still be live tomorrow. The cloud bounds the envelope's TTL generically (it cannot see
  // the type); this is the per-type bound only the receiver can apply.
  if (command.expiresAt - command.createdAt > policy.maxTtlMs) {
    return { ok: false, reason: "ttl-too-long" };
  }
  if (command.expiresAt <= now) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true };
}
