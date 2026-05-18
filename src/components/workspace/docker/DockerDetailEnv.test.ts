import { describe, it, expect, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import DockerDetailEnv from "./DockerDetailEnv.vue";

const MOCK_INSPECT = JSON.stringify([
  {
    Id: "abc",
    Name: "/x",
    Config: {
      Env: ["NODE_ENV=production", "PATH=/usr/local/bin:/usr/bin", "DB_URL=postgres://x:y@db/app", "DEBUG="],
    },
  },
]);

describe("DockerDetailEnv — visual render with mock inspect data", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("renders env vars sorted alphabetically as key=value rows", async () => {
    const wrapper = mount(DockerDetailEnv, {
      props: { containerId: "abc", backendId: "host", contextName: "default", mockJson: MOCK_INSPECT },
    });
    await flushPromises();

    const rows = wrapper.findAll(".env__table tbody tr");
    expect(rows.length).toBe(4);

    const keys = rows.map((r) => r.find(".env__key").text());
    expect(keys).toEqual(["DB_URL", "DEBUG", "NODE_ENV", "PATH"]);

    expect(rows[0].find(".env__val").text()).toBe("postgres://x:y@db/app");
    expect(rows[1].find(".env__val").text()).toBe(""); // DEBUG empty
  });

  it("filters by key/value substring", async () => {
    const wrapper = mount(DockerDetailEnv, {
      props: { containerId: "abc", backendId: "host", contextName: "default", mockJson: MOCK_INSPECT },
    });
    await flushPromises();

    await wrapper.find(".env__filter").setValue("path");
    expect(wrapper.findAll(".env__table tbody tr").length).toBe(1);
    expect(wrapper.find(".env__key").text()).toBe("PATH");
  });

  it("shows empty state when no env vars", async () => {
    const wrapper = mount(DockerDetailEnv, {
      props: {
        containerId: "abc",
        backendId: "host",
        contextName: "default",
        mockJson: JSON.stringify([{ Config: { Env: [] } }]),
      },
    });
    await flushPromises();
    expect(wrapper.find(".env__empty").exists()).toBe(true);
    expect(wrapper.text()).toContain("No environment variables");
  });

  it("count shows filtered/total", async () => {
    const wrapper = mount(DockerDetailEnv, {
      props: { containerId: "abc", backendId: "host", contextName: "default", mockJson: MOCK_INSPECT },
    });
    await flushPromises();
    expect(wrapper.find(".env__count").text()).toBe("4 / 4");

    await wrapper.find(".env__filter").setValue("db");
    expect(wrapper.find(".env__count").text()).toBe("1 / 4");
  });
});
