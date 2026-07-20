import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import DockerDetail from "./DockerDetail.vue";
import DockerResourceInspect from "./DockerResourceInspect.vue";
import { useDockerDetail } from "../../../stores/docker-detail.js";
import { useAppStore } from "../../../stores/app.js";

/**
 * DockerResourceInspect has its own isolated unit test (DockerResourceInspect.test.ts)
 * but its real consumer, DockerDetail.vue, wires the `resourceKey`/`fetcher` props
 * from the docker-detail store and doesn't have any test coverage. These tests
 * exercise that wiring end-to-end: real store, real DockerDetail, real
 * DockerResourceInspect — only the other sub-tab panels are stubbed out.
 */

const STUBS = {
  DockerDetailTabs: true,
  DockerDetailToolbar: true,
  DockerDetailSubTabs: true,
  DockerDetailLog: true,
  DockerDetailShell: true,
  DockerDetailStats: true,
  DockerDetailEnv: true,
  DockerDetailTop: true,
};

const WORKSPACE_ID = "ws-1";
const CONTAINER_ID = "container-abc";
const BACKEND_ID = "backend-1";
const CONTEXT_NAME = "ctx-1";
const TAB_ID = `container:${BACKEND_ID}:${CONTEXT_NAME}:${CONTAINER_ID}`;

describe("DockerDetail — DockerResourceInspect wiring for the Inspect sub-tab", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("renders DockerResourceInspect with kind + resourceKey wired from the active tab, and its fetcher calls appStore.dockerInspect with the tab's real ids", async () => {
    const detailStore = useDockerDetail();
    const appStore = useAppStore();
    const dockerInspectSpy = vi.spyOn(appStore, "dockerInspect").mockResolvedValue('{"Id":"abc"}');

    detailStore.openContainer(WORKSPACE_ID, CONTAINER_ID, BACKEND_ID, CONTEXT_NAME, "my-container");
    detailStore.setActiveSubTab(WORKSPACE_ID, TAB_ID, "inspect");

    const wrapper = mount(DockerDetail, {
      props: { workspaceId: WORKSPACE_ID },
      global: { stubs: STUBS },
    });
    await flushPromises();

    const inspect = wrapper.findComponent({ name: "DockerResourceInspect" });
    expect(inspect.exists()).toBe(true);
    expect(inspect.props("kind")).toBe("container");
    expect(inspect.props("resourceKey")).toBe(`${BACKEND_ID}:${CONTEXT_NAME}:${CONTAINER_ID}`);

    // DockerResourceInspect invokes its `fetcher` prop itself on mount (no mockJson
    // given) — this proves the closure actually reaches appStore.dockerInspect with
    // the tab's real ids, not just that the prop function exists.
    expect(dockerInspectSpy).toHaveBeenCalledWith(CONTAINER_ID, BACKEND_ID, CONTEXT_NAME);
  });

  it("stops rendering DockerResourceInspect once the sub-tab moves away from 'inspect'", async () => {
    const detailStore = useDockerDetail();
    const appStore = useAppStore();
    vi.spyOn(appStore, "dockerInspect").mockResolvedValue("{}");

    detailStore.openContainer(WORKSPACE_ID, CONTAINER_ID, BACKEND_ID, CONTEXT_NAME, "my-container");
    detailStore.setActiveSubTab(WORKSPACE_ID, TAB_ID, "inspect");

    const wrapper = mount(DockerDetail, {
      props: { workspaceId: WORKSPACE_ID },
      global: { stubs: STUBS },
    });
    await flushPromises();
    expect(wrapper.findComponent(DockerResourceInspect).exists()).toBe(true);
    expect(wrapper.find(".r-inspect").exists()).toBe(true);

    detailStore.setActiveSubTab(WORKSPACE_ID, TAB_ID, "env");
    await flushPromises();

    expect(wrapper.findComponent(DockerResourceInspect).exists()).toBe(false);
    expect(wrapper.find(".r-inspect").exists()).toBe(false);
  });
});
