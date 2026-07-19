import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import DockerResourceInspect from "./DockerResourceInspect.vue";
import { useNotificationStore } from "../../../stores/notifications.js";

const MOCK_VOLUME_JSON = JSON.stringify(
  [
    {
      CreatedAt: "2024-09-12T14:21:33+02:00",
      Driver: "local",
      Mountpoint: "/var/lib/docker/volumes/myapp_data/_data",
      Name: "myapp_data",
      Options: null,
      Scope: "local",
    },
  ],
  null,
  0,
);

describe("DockerResourceInspect — visual render with mock data", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("renders pretty-printed JSON with syntax highlight classes", async () => {
    const wrapper = mount(DockerResourceInspect, {
      props: {
        kind: "volume",
        resourceKey: "abc",
        fetcher: vi.fn(),
        mockJson: MOCK_VOLUME_JSON,
      },
    });
    await flushPromises();

    const html = wrapper.html();
    expect(wrapper.find(".r-inspect__pre").exists()).toBe(true);
    expect(html).toContain("json-key");
    expect(html).toContain("json-string");
    expect(html).toContain("myapp_data");
    expect(html).toContain("local");
  });

  it("calls fetcher when no mock is provided, on mount", async () => {
    const fetcher = vi.fn().mockResolvedValue("[]");
    mount(DockerResourceInspect, {
      props: { kind: "image", resourceKey: "k", fetcher },
    });
    await flushPromises();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("renders error string when fetcher rejects", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("boom"));
    const wrapper = mount(DockerResourceInspect, {
      props: { kind: "image", resourceKey: "k", fetcher },
    });
    await flushPromises();
    expect(wrapper.find(".r-inspect__error").text()).toBe("boom");
  });

  it("reload button re-invokes the fetcher", async () => {
    const fetcher = vi.fn().mockResolvedValue("[]");
    const wrapper = mount(DockerResourceInspect, {
      props: { kind: "image", resourceKey: "k", fetcher },
    });
    await flushPromises();
    fetcher.mockClear();
    await wrapper.find("button.button--ghost").trigger("click");
    await flushPromises();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  // Category B (code-review batch, 2026-07): copy() used to swallow a
  // rejected navigator.clipboard.writeText with zero user-visible feedback.
  it("a rejected clipboard write surfaces a 'Copy failed' notification instead of failing silently", async () => {
    Object.defineProperty(window.navigator, "clipboard", {
      value: { writeText: vi.fn().mockRejectedValue(new Error("clipboard blocked")) },
      configurable: true,
    });
    const wrapper = mount(DockerResourceInspect, {
      props: {
        kind: "volume",
        resourceKey: "abc",
        fetcher: vi.fn(),
        mockJson: MOCK_VOLUME_JSON,
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
