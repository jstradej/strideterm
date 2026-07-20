import { describe, expect, test } from "vitest";
import { mount } from "@vue/test-utils";
import BootstrapError from "./BootstrapError.vue";
import { apiKey } from "../../types/keys.js";

describe("BootstrapError", () => {
  test("renders remote auth form when api.isRemote is true", () => {
    const wrapper = mount(BootstrapError, {
      props: { message: "Could not connect to server" },
      global: {
        provide: {
          [apiKey]: { isRemote: true, getRemoteToken: () => "", setRemoteToken: () => {} },
        },
      },
    });

    expect(wrapper.find("form.boot-form").exists()).toBe(true);
    expect(wrapper.find('input[name="token"]').exists()).toBe(true);
    expect(wrapper.find('button[type="submit"]').text()).toContain("Connect");
    expect(wrapper.text()).toContain("Remote Access");
  });

  test("renders retry button when not remote", () => {
    const wrapper = mount(BootstrapError, {
      props: { message: "Startup error details" },
      global: {
        provide: { [apiKey]: { isRemote: false } },
      },
    });

    expect(wrapper.find("form").exists()).toBe(false);
    expect(wrapper.find('button[type="button"]').text()).toContain("Retry");
    expect(wrapper.text()).toContain("Startup Error");
    expect(wrapper.text()).toContain("Startup error details");
  });
});
