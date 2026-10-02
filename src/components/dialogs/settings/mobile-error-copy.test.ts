import { describe, expect, test } from "vitest";
import { mobileErrorCopy, mobileResultReasonCopy } from "./mobile-error-copy.js";
import { NETWORK_TLS_UNTRUSTED_COPY } from "../../../lib/network-error-copy.js";

describe("mobile error copy", () => {
  test("maps the exact Electron-wrapped entitlement refusal to actionable plan guidance", () => {
    const error = new Error(
      "Error invoking remote method 'mobile:pairing:create': MobileFirebaseCallableError: createPairingInvitation failed (PERMISSION_DENIED: entitlement-required)",
    );

    expect(mobileErrorCopy(error, "pair")).toBe(
      "Pairing a phone requires an active mobile plan. Open Account settings to sign in with an account that has one, or start the free 14-day trial if you are eligible.",
    );
  });

  test("maps structured and serialized authorization, network, and capacity reasons", () => {
    expect(mobileErrorCopy({ status: "unauthenticated", reason: null }, "pair")).toContain("Account settings");
    expect(mobileErrorCopy(new Error("revokeDevice failed (permission-denied)"), "revoke")).toContain("not authorized");
    expect(mobileResultReasonCopy("network:tls-untrusted", "approve")).toBe(NETWORK_TLS_UNTRUSTED_COPY);
    expect(
      mobileErrorCopy(new Error("createPairingInvitation failed (PERMISSION_DENIED: too-many-active)"), "pair"),
    ).toContain("pairing in progress");
    expect(mobileResultReasonCopy("device-revoked-remotely", "approve")).toContain("has been revoked");
  });

  test("uses a fixed action fallback for unknown errors and never exposes backend text", () => {
    const secret = "database path /private/customer-17 and token=abc123";
    const copy = mobileErrorCopy(new Error(`unrecognized refusal: ${secret}`), "pair");

    expect(copy).toBe("Could not create a pairing invitation. Please try again.");
    expect(copy).not.toContain(secret);
    expect(mobileResultReasonCopy(secret, "approve")).toBe(
      "Could not activate this phone. It remains inactive. Please try again.",
    );
    expect(mobileResultReasonCopy("constructor", "pair")).toBe(
      "Could not create a pairing invitation. Please try again.",
    );
  });
});
