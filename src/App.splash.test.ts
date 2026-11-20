import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import App from "./App.vue";
import { apiKey } from "./types/keys.js";
import { setWindowBackend } from "./window-backend.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;

describe("App splash", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    (window as AnyApi).strideterm = { startupFlags: { windowId: "win-test" } };
  });
  afterEach(() => {
    delete (window as AnyApi).strideterm;
    setWindowBackend({ kind: "local" });
  });

  function mountApp() {
    const api: AnyApi = new Proxy({ isRemote: false } as AnyApi, {
      get: (target, prop) => (prop in target ? target[prop] : () => undefined),
      has: () => true,
    });
    return mount(App, { shallow: true, global: { provide: { [apiKey as unknown as symbol]: api } } });
  }

  it("a window attached to another desktop says whom it is waiting for", () => {
    setWindowBackend({
      kind: "peer",
      hostId: "host-0001",
      hostLabel: "Studio Mac",
      remoteProfileId: "work",
      clientId: "c",
      terminalFontSize: 13,
    });
    const wrapper = mountApp();
    expect(wrapper.find(".splash").exists()).toBe(true);
    const caption = wrapper.get('[data-testid="splash-peer-caption"]');
    expect(caption.attributes("role")).toBe("status");
    expect(caption.text()).toBe("Connecting to Studio Mac…");
    wrapper.unmount();
  });

  it("a local window keeps the plain splash", () => {
    const wrapper = mountApp();
    expect(wrapper.find(".splash").exists()).toBe(true);
    expect(wrapper.find('[data-testid="splash-peer-caption"]').exists()).toBe(false);
    wrapper.unmount();
  });
});
