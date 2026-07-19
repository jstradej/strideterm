import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import DockerDetailInspect from "./DockerDetailInspect.vue";
import { useNotificationStore } from "../../../stores/notifications.js";

const MOCK_INSPECT = JSON.stringify(
  [
    {
      Id: "abc123def456",
      Name: "/myapp_web_1",
      State: { Status: "running", Running: true, Pid: 1234 },
      Config: {
        Env: ["PATH=/usr/local/bin:/usr/bin", "NODE_ENV=production"],
        Image: "node:18-alpine",
        Cmd: ["node", "server.js"],
      },
      HostConfig: { RestartPolicy: { Name: "unless-stopped" } },
    },
  ],
  null,
  0,
);

describe("DockerDetailInspect — visual render with mock data", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("renders pretty-printed JSON with syntax highlight classes", async () => {
    const wrapper = mount(DockerDetailInspect, {
      props: {
        containerId: "abc123",
        backendId: "host",
        contextName: "default",
        mockJson: MOCK_INSPECT,
      },
    });
    await flushPromises();

    const html = wrapper.html();
    // Body present
    expect(wrapper.find(".inspect__pre").exists()).toBe(true);
    // Key syntax highlight spans applied
    expect(html).toContain("json-key");
    expect(html).toContain("json-string");
    // Content
    expect(html).toContain("myapp_web_1");
    expect(html).toContain("node:18-alpine");
  });

  it("shows empty state when mock JSON is empty string", async () => {
    const wrapper = mount(DockerDetailInspect, {
      props: {
        containerId: "abc",
        backendId: "host",
        contextName: "default",
        mockJson: "",
      },
    });
    await flushPromises();
    expect(wrapper.find(".inspect__empty").exists()).toBe(true);
  });

  it("renders toolbar with Reload button", () => {
    const wrapper = mount(DockerDetailInspect, {
      props: {
        containerId: "abc",
        backendId: "host",
        contextName: "default",
        mockJson: MOCK_INSPECT,
      },
    });
    expect(wrapper.find(".inspect__toolbar").exists()).toBe(true);
    expect(wrapper.text()).toContain("Reload");
  });

  // Category B (code-review batch, 2026-07): copyToClipboard used to swallow
  // a rejected navigator.clipboard.writeText with zero user-visible feedback.
  it("a rejected clipboard write surfaces a 'Copy failed' notification instead of failing silently", async () => {
    Object.defineProperty(window.navigator, "clipboard", {
      value: { writeText: vi.fn().mockRejectedValue(new Error("clipboard blocked")) },
      configurable: true,
    });
    const wrapper = mount(DockerDetailInspect, {
      props: {
        containerId: "abc",
        backendId: "host",
        contextName: "default",
        mockJson: MOCK_INSPECT,
      },
    });
    await flushPromises();
    const notifications = useNotificationStore();
    const showErrorSpy = vi.spyOn(notifications, "showError");

    const copyBtn = wrapper.findAll("button").find((b) => b.text() === "Copy")!;
    await copyBtn.trigger("click");
    await flushPromises();

    expect(showErrorSpy).toHaveBeenCalledTimes(1);
    expect(showErrorSpy).toHaveBeenCalledWith("Copy failed", expect.stringContaining("clipboard blocked"));
  });
});
