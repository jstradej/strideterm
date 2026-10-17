import { describe, expect, test } from "vitest";
import { getMobileAccessWarning, MOBILE_TRIAL_WARNING_WINDOW_MS } from "./mobile-access-warning.js";

const NOW = Date.parse("2026-10-17T10:00:00Z");
const base = {
  mobileEnabled: true,
  pairedPhoneCount: 1,
  health: { running: true, pairAuthorization: "ok" },
  entitlement: { state: "active", source: "subscription" },
  now: NOW,
};

describe("getMobileAccessWarning", () => {
  test.each(["trial", "lapsed"] as const)("labels an elapsed authoritative %s trial", (state) => {
    expect(
      getMobileAccessWarning({
        ...base,
        entitlement: { state, source: "trial", notAfter: NOW - 1 },
      }),
    ).toBe("trial-expired");
  });

  test("uses trial state as sufficient evidence for the current trial", () => {
    expect(
      getMobileAccessWarning({
        ...base,
        entitlement: { state: "trial", notAfter: NOW - 1 },
      }),
    ).toBe("trial-expired");
  });

  test("requires the trial source before labeling a lapsed entitlement as an expired trial", () => {
    expect(
      getMobileAccessWarning({
        ...base,
        entitlement: { state: "lapsed", source: "subscription", notAfter: NOW - 1 },
      }),
    ).toBeNull();
  });

  test("uses generic authorization copy for a denied active account", () => {
    expect(
      getMobileAccessWarning({
        ...base,
        health: { running: true, pairAuthorization: "denied" },
      }),
    ).toBe("authorization-denied");
  });

  test("warns exactly three days before the authoritative trial deadline", () => {
    expect(
      getMobileAccessWarning({
        ...base,
        entitlement: { state: "trial", source: "trial", notAfter: NOW + MOBILE_TRIAL_WARNING_WINDOW_MS },
      }),
    ).toBe("trial-expiring");
  });

  test("does not warn more than three days before the trial deadline", () => {
    expect(
      getMobileAccessWarning({
        ...base,
        entitlement: { state: "trial", source: "trial", notAfter: NOW + MOBILE_TRIAL_WARNING_WINDOW_MS + 1 },
      }),
    ).toBeNull();
  });

  test("keeps authorization denial ahead of the upcoming-expiry warning", () => {
    expect(
      getMobileAccessWarning({
        ...base,
        health: { running: true, pairAuthorization: "denied" },
        entitlement: { state: "trial", source: "trial", notAfter: NOW + MOBILE_TRIAL_WARNING_WINDOW_MS },
      }),
    ).toBe("authorization-denied");
  });

  test.each([Number.NaN, 0, undefined])("does not call a trial expired for an invalid notAfter %s", (notAfter) => {
    expect(
      getMobileAccessWarning({
        ...base,
        entitlement: { state: "trial", source: "trial", notAfter },
      }),
    ).toBeNull();
  });

  test("does not warn a LAN-only setup with no mobile use", () => {
    expect(
      getMobileAccessWarning({
        ...base,
        mobileEnabled: false,
        pairedPhoneCount: 0,
        health: { running: true, pairAuthorization: "denied" },
        entitlement: { state: "lapsed", source: "trial", notAfter: NOW - 1 },
      }),
    ).toBeNull();
  });
});
