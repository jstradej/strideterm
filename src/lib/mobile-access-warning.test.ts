import { describe, expect, test } from "vitest";
import {
  formatMobileAccessRemaining,
  getMobileAccessDeadline,
  getMobileAccessWarning,
  getMobileWarningPulseInterval,
  MOBILE_ACCESS_CRITICAL_WINDOW_MS,
  MOBILE_CRITICAL_PULSE_INTERVAL_MS,
  MOBILE_TRIAL_WARNING_WINDOW_MS,
  MOBILE_WARNING_PULSE_INTERVAL_MS,
} from "./mobile-access-warning.js";

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

  test("warns for finite operator access and marks its final day as critical", () => {
    const notAfter = NOW + MOBILE_ACCESS_CRITICAL_WINDOW_MS;
    expect(getMobileAccessDeadline({ state: "active", source: "operator", notAfter })).toBe(notAfter);
    expect(
      getMobileAccessWarning({
        ...base,
        entitlement: { state: "active", source: "operator", notAfter },
      }),
    ).toBe("access-expiring");
    expect(getMobileWarningPulseInterval(MOBILE_ACCESS_CRITICAL_WINDOW_MS)).toBe(MOBILE_CRITICAL_PULSE_INTERVAL_MS);
  });

  test("marks finite incident access expired without trial wording", () => {
    expect(
      getMobileAccessWarning({
        ...base,
        entitlement: { state: "lapsed", source: "incident", notAfter: NOW - 1 },
      }),
    ).toBe("access-expired");
  });

  test("uses a scheduled subscription cancellation, not renewal or the later grace deadline", () => {
    const cancellationAt = NOW + 15 * 60 * 60_000 + 20 * 60_000;
    const entitlement = {
      state: "active",
      source: "subscription",
      renewalAt: NOW + 30 * 86_400_000,
      cancellationAt,
      notAfter: cancellationAt + 3 * 86_400_000,
    };
    expect(getMobileAccessDeadline(entitlement)).toBe(cancellationAt);
    expect(getMobileAccessWarning({ ...base, entitlement })).toBe("access-expiring");
    expect(
      getMobileAccessWarning({
        ...base,
        entitlement,
        now: cancellationAt + 1,
      }),
    ).toBeNull();
    expect(
      getMobileAccessDeadline({
        state: "active",
        source: "subscription",
        renewalAt: cancellationAt,
        notAfter: cancellationAt + 3 * 86_400_000,
      }),
    ).toBeNull();
  });

  test("uses a 15-minute pulse outside the final day and an hourly pulse inside it", () => {
    expect(getMobileWarningPulseInterval(MOBILE_ACCESS_CRITICAL_WINDOW_MS + 1)).toBe(MOBILE_WARNING_PULSE_INTERVAL_MS);
    expect(getMobileWarningPulseInterval(MOBILE_ACCESS_CRITICAL_WINDOW_MS)).toBe(MOBILE_CRITICAL_PULSE_INTERVAL_MS);
    expect(getMobileWarningPulseInterval(0)).toBeNull();
  });

  test("formats positive time without rounding down to zero", () => {
    expect(formatMobileAccessRemaining(0)).toBe("0h 0m");
    expect(formatMobileAccessRemaining(1)).toBe("0h 1m");
    expect(formatMobileAccessRemaining(60 * 60_000 + 1)).toBe("1h 1m");
    expect(formatMobileAccessRemaining(2 * 86_400_000 + 3 * 60 * 60_000 + 4 * 60_000)).toBe("51h 4m");
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
