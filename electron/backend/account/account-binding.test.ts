// The guard on the anonymous fallback, as a rule (G13).
//
// The marker used to be a boolean and the guard read `false` for a marker that could not be read, an
// intent a crashed enrolment left behind, and a marker an older build never wrote. In the guard those
// three were indistinguishable from "the server said this machine is not bound", and that is the one
// answer that releases the installation's identity.
import { describe, expect, test } from "vitest";

import { bindingSaysEnrolled, newIdentityIsRefused, parseInstallationBinding } from "./account-binding.js";

describe("the binding marker's states", () => {
  test("parses the three markers, and everything else — including the absence of one — as `absent`", () => {
    expect(parseInstallationBinding("bound")).toBe("bound");
    expect(parseInstallationBinding("enrolling")).toBe("enrolling");
    expect(parseInstallationBinding("none")).toBe("none");
    expect(parseInstallationBinding(undefined)).toBe("absent");
    expect(parseInstallationBinding(null)).toBe("absent");
    expect(parseInstallationBinding("")).toBe("absent");
    expect(parseInstallationBinding("true")).toBe("absent");
  });

  test("only a marker that positively says `none` releases the identity", () => {
    // The whole of G13: every way of NOT knowing keeps the identity and offers the recovery path.
    expect(newIdentityIsRefused("none", false)).toBe(false);
    expect(newIdentityIsRefused("bound", false)).toBe(true);
    expect(newIdentityIsRefused("enrolling", false)).toBe(true);
    expect(newIdentityIsRefused("absent", false)).toBe(true);
    expect(newIdentityIsRefused("unknown", false)).toBe(true);
  });

  test("what the server has told THIS process outranks a `none` on disk", () => {
    // The manager learned from an overview that this installation is listed; a stale `none` — a
    // sign-out that was undone by a re-enrolment whose write failed — must not release it.
    expect(newIdentityIsRefused("none", true)).toBe(true);
  });

  test("the Account page shows only a CONFIRMED enrolment as enrolled", () => {
    // Display and destruction are different questions: an intent keeps the identity but is not shown
    // as an enrolment the server has confirmed.
    expect(bindingSaysEnrolled("bound")).toBe(true);
    expect(bindingSaysEnrolled("enrolling")).toBe(false);
    expect(bindingSaysEnrolled("absent")).toBe(false);
    expect(bindingSaysEnrolled("unknown")).toBe(false);
    expect(bindingSaysEnrolled("none")).toBe(false);
  });
});
