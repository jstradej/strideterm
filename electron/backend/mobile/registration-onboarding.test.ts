import { describe, expect, test, vi } from "vitest";
import { createMobileRegistrationOnboarding } from "./registration-onboarding.js";

function harness({ mobile = false, relay = false }: { mobile?: boolean; relay?: boolean } = {}) {
  let marker: string | null = null;
  let mobileEnabled = mobile;
  let relayEnabled = relay;
  const enable = vi.fn(async () => {
    mobileEnabled = true;
    relayEnabled = true;
  });
  const onboarding = createMobileRegistrationOnboarding({
    readMarker: () => marker,
    writeMarker: async (value) => {
      marker = value;
    },
    clearMarker: async () => {
      marker = null;
    },
    enable,
  });
  return {
    onboarding,
    enable,
    read: () => ({ marker, mobileEnabled, relayEnabled }),
    setOff: () => {
      mobileEnabled = false;
      relayEnabled = false;
    },
  };
}

describe("mobile registration onboarding", () => {
  test("enables both integrations once for a new or already-bound installation", async () => {
    // Existing QA installations can already have Mobile on while the new relay defaults off.
    const h = harness({ mobile: true });

    expect(await h.onboarding.bound()).toBe(true);
    expect(h.read()).toEqual({ marker: "configured", mobileEnabled: true, relayEnabled: true });

    h.setOff();
    expect(await h.onboarding.bound()).toBe(false);
    expect(h.enable).toHaveBeenCalledTimes(1);
    expect(h.read()).toEqual({ marker: "configured", mobileEnabled: false, relayEnabled: false });
  });

  test("a later explicit choice is preserved, but a fresh registration gets onboarding again", async () => {
    const h = harness();
    await h.onboarding.bound();

    await h.onboarding.explicitlyConfigured();
    h.setOff();
    expect(await h.onboarding.bound()).toBe(false);
    expect(h.read().mobileEnabled).toBe(false);

    await h.onboarding.unbound();
    expect(h.read().marker).toBeNull();
    expect(await h.onboarding.bound()).toBe(true);
    expect(h.read()).toEqual({ marker: "configured", mobileEnabled: true, relayEnabled: true });
    expect(h.enable).toHaveBeenCalledTimes(2);
  });

  test("serializes bound restore with an explicit off choice", async () => {
    let enableStarted!: () => void;
    let finishEnable!: () => void;
    const started = new Promise<void>((resolve) => {
      enableStarted = resolve;
    });
    const enableGate = new Promise<void>((resolve) => {
      finishEnable = resolve;
    });
    let enabled = false;
    let marker: string | null = null;
    const onboarding = createMobileRegistrationOnboarding({
      readMarker: () => marker,
      writeMarker: async (value) => {
        marker = value;
      },
      clearMarker: async () => {
        marker = null;
      },
      enable: async () => {
        enableStarted();
        await enableGate;
        enabled = true;
      },
    });

    const restore = onboarding.bound();
    await started;
    const explicitChoice = (async () => {
      await onboarding.explicitlyConfigured();
      enabled = false;
    })();
    finishEnable();
    await Promise.all([restore, explicitChoice]);

    expect(marker).toBe("configured");
    expect(enabled).toBe(false);
    expect(await onboarding.bound()).toBe(false);
    expect(enabled).toBe(false);
  });

  test("retries an interrupted onboarding whose marker is still pending", async () => {
    let marker: string | null = null;
    let attempts = 0;
    const onboarding = createMobileRegistrationOnboarding({
      readMarker: () => marker,
      writeMarker: async (value) => {
        marker = value;
      },
      clearMarker: async () => {
        marker = null;
      },
      enable: async () => {
        attempts++;
        if (attempts === 1) throw new Error("settings write interrupted");
      },
    });

    await expect(onboarding.bound()).rejects.toThrow("settings write interrupted");
    expect(marker).toBe("pending");
    expect(await onboarding.bound()).toBe(true);
    expect(marker).toBe("configured");
    expect(attempts).toBe(2);
  });
});
