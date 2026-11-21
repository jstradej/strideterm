import { beforeEach, describe, expect, test } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import PeerHostGroup from "./PeerHostGroup.vue";
import type { PeerAttachedHost } from "../../../electron/shared/peers.js";

function host(overrides: Partial<PeerAttachedHost> = {}): PeerAttachedHost {
  return {
    id: "host-0001",
    label: "Studio Mac",
    address: "studio.local",
    port: 43200,
    hostPublicKey: "key",
    pairedAt: 1,
    state: "online",
    hostAppVersion: "1.0.0",
    localAppVersion: "1.0.0",
    profiles: [],
    checkedAt: 1,
    ...overrides,
  };
}

function mountGroup(next: PeerAttachedHost) {
  return mount(PeerHostGroup, { props: { host: next, busyKey: null } });
}

describe("PeerHostGroup failure reason", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  test("an offline host with a reason says why and offers the collapsed help", () => {
    const wrapper = mountGroup(host({ state: "offline", reason: "timeout" }));
    expect(wrapper.find('[data-testid="peer-offline-reason"]').text()).toContain("studio.local:43200 did not answer.");
    expect(wrapper.find('[data-testid="peer-failure-firewall"]').text()).toContain("43200");
  });

  test("a refused host shows its own sentence", () => {
    const wrapper = mountGroup(host({ state: "offline", reason: "refused" }));
    expect(wrapper.find('[data-testid="peer-offline-reason"]').text()).toContain(
      "Nothing is listening at studio.local:43200.",
    );
  });

  test("an online host and an offline host without a reason show none", () => {
    expect(mountGroup(host()).find('[data-testid="peer-offline-reason"]').exists()).toBe(false);
    const stale = mountGroup(host({ state: "online", reason: "timeout" }));
    expect(stale.find('[data-testid="peer-offline-reason"]').exists()).toBe(false);
    expect(
      mountGroup(host({ state: "offline" }))
        .find('[data-testid="peer-offline-reason"]')
        .exists(),
    ).toBe(false);
  });
});
