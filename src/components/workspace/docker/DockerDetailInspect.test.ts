import { describe, it, expect, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import DockerDetailInspect from "./DockerDetailInspect.vue";

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
});
