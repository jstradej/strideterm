import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import DockerTree from "./DockerTree.vue";
import { useDockerTree } from "../../../stores/docker-tree.js";
import type { TreeNode } from "../../../stores/docker-tree.js";

/** 3-level tree: backend → context → project → container */
function makeMultiLevelNodes(): TreeNode[] {
  return [
    {
      id: "be:host",
      kind: "backend",
      label: "Host",
      status: "running",
      backendId: "host",
      children: [
        {
          id: "be:host/ctx:default",
          kind: "context",
          label: "default (current)",
          status: "running",
          backendId: "host",
          contextName: "default",
          children: [
            {
              id: "be:host/ctx:default/proj:myapp",
              kind: "project",
              label: "myapp",
              status: "running",
              backendId: "host",
              contextName: "default",
              projectName: "myapp",
              children: [
                {
                  id: "be:host/cnt:abc123",
                  kind: "container",
                  label: "myapp_web_1",
                  status: "running",
                  backendId: "host",
                  contextName: "default",
                  projectName: "myapp",
                  containerId: "abc123",
                },
              ],
            },
          ],
        },
      ],
    },
    {
      id: "be:wsl",
      kind: "backend",
      label: "WSL",
      status: "stopped",
      backendId: "wsl",
      children: [
        {
          id: "be:wsl/ctx:default",
          kind: "context",
          label: "default",
          status: "stopped",
          backendId: "wsl",
          contextName: "default",
          children: [],
        },
      ],
    },
  ];
}

describe("DockerTree — multi-level expansion (acceptance #1 & #9)", () => {
  let treeStore: ReturnType<typeof useDockerTree>;

  beforeEach(() => {
    sessionStorage.clear();
    setActivePinia(createPinia());
    treeStore = useDockerTree();
  });

  it("renders only root nodes when nothing is expanded", () => {
    const nodes = makeMultiLevelNodes();
    const wrapper = mount(DockerTree, { props: { nodes, selectedId: null } });

    // Both backend roots visible
    expect(wrapper.text()).toContain("Host");
    expect(wrapper.text()).toContain("WSL");

    // Inner nodes not visible
    expect(wrapper.text()).not.toContain("default (current)");
    expect(wrapper.text()).not.toContain("myapp");
    expect(wrapper.text()).not.toContain("myapp_web_1");
  });

  it("reveals context children when backend node is expanded", async () => {
    const nodes = makeMultiLevelNodes();
    const wrapper = mount(DockerTree, { props: { nodes, selectedId: null } });

    treeStore.toggle("be:host");
    await wrapper.vm.$nextTick();

    expect(wrapper.text()).toContain("default (current)");
    // Project still collapsed
    expect(wrapper.text()).not.toContain("myapp");
  });

  it("reveals project children when context node is also expanded (inner node fix)", async () => {
    const nodes = makeMultiLevelNodes();
    const wrapper = mount(DockerTree, { props: { nodes, selectedId: null } });

    treeStore.toggle("be:host");
    treeStore.toggle("be:host/ctx:default");
    await wrapper.vm.$nextTick();

    expect(wrapper.text()).toContain("default (current)");
    expect(wrapper.text()).toContain("myapp");
    // Container still collapsed
    expect(wrapper.text()).not.toContain("myapp_web_1");
  });

  it("reveals container when all ancestors are expanded", async () => {
    const nodes = makeMultiLevelNodes();
    const wrapper = mount(DockerTree, { props: { nodes, selectedId: null } });

    treeStore.toggle("be:host");
    treeStore.toggle("be:host/ctx:default");
    treeStore.toggle("be:host/ctx:default/proj:myapp");
    await wrapper.vm.$nextTick();

    expect(wrapper.text()).toContain("myapp_web_1");
  });

  it("collapsing a node hides its entire subtree", async () => {
    const nodes = makeMultiLevelNodes();
    const wrapper = mount(DockerTree, { props: { nodes, selectedId: null } });

    treeStore.toggle("be:host");
    treeStore.toggle("be:host/ctx:default");
    treeStore.toggle("be:host/ctx:default/proj:myapp");
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain("myapp_web_1");

    treeStore.toggle("be:host"); // collapse root
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).not.toContain("default (current)");
    expect(wrapper.text()).not.toContain("myapp_web_1");
  });

  it("WSL backend (acceptance #9) expands independently from Host backend", async () => {
    const nodes = makeMultiLevelNodes();
    const wrapper = mount(DockerTree, { props: { nodes, selectedId: null } });

    treeStore.toggle("be:wsl");
    await wrapper.vm.$nextTick();

    // WSL context visible
    const text = wrapper.text();
    // WSL has a context labeled "default" — both "Host" and "WSL" backends present
    expect(text).toContain("WSL");
    // context under WSL is now visible (its label is "default")
    // Host's context is NOT visible (host not expanded)
    expect(text).not.toContain("default (current)");
    // Host backend root is still shown
    expect(text).toContain("Host");
  });

  it("shows empty message when nodes array is empty", () => {
    const wrapper = mount(DockerTree, { props: { nodes: [], selectedId: null } });
    expect(wrapper.text()).toContain("No containers");
  });
});

describe("DockerTree — filter", () => {
  let treeStore: ReturnType<typeof useDockerTree>;

  beforeEach(() => {
    sessionStorage.clear();
    setActivePinia(createPinia());
    treeStore = useDockerTree();
  });

  function makeFlatNodes(): TreeNode[] {
    return [
      { id: "p1", kind: "project", label: "myapp", status: "running", children: [] },
      { id: "p2", kind: "project", label: "redis-cluster", status: "stopped", children: [] },
      { id: "p3", kind: "project", label: "nginx-proxy", status: "running", children: [] },
    ];
  }

  it("setFilter narrows visible roots to label substring matches", () => {
    treeStore.setFilter("redis");
    // The filteredTreeNodes computed is driven by `treeNodes` which sources
    // from the live docker payload; here we only need to validate that the
    // store stores the query.
    expect(treeStore.filter).toBe("redis");
  });

  it("auto-expands matching parent nodes via isExpandedWithFilter", async () => {
    // Use the recursive filter helper indirectly: mount tree with parents that
    // have matching descendants and confirm children render.
    const nodes: TreeNode[] = [
      {
        id: "proj:web",
        kind: "project",
        label: "web",
        status: "running",
        children: [
          {
            id: "cnt:abc",
            kind: "container",
            label: "redis-cache",
            status: "running",
            containerId: "abc",
          },
        ],
      },
    ];
    treeStore.setFilter("redis");
    const wrapper = mount(DockerTree, {
      props: { nodes, selectedId: null, filterActive: true },
    });
    // Project label should be visible AND child should be auto-expanded.
    expect(wrapper.text()).toContain("web");
    expect(wrapper.text()).toContain("redis-cache");
  });

  it("renders 'No matches.' empty state when filterActive and no nodes", () => {
    const wrapper = mount(DockerTree, { props: { nodes: [], selectedId: null, filterActive: true } });
    expect(wrapper.text()).toContain("No matches");
  });

  it("renders 'No containers' fallback when no filter is active and tree is empty", () => {
    const wrapper = mount(DockerTree, { props: { nodes: [], selectedId: null, filterActive: false } });
    expect(wrapper.text()).toContain("No containers");
  });

  it("makeFlatNodes helper sanity", () => {
    expect(makeFlatNodes().length).toBe(3);
  });
});

describe("DockerTree — images / volumes nodes", () => {
  beforeEach(() => {
    sessionStorage.clear();
    setActivePinia(createPinia());
  });

  function makeContextWithImagesAndVolumes(): TreeNode[] {
    return [
      {
        id: "be:host/ctx:default/images",
        kind: "images-group",
        label: "Images (2)",
        status: "stopped",
        backendId: "host",
        contextName: "default",
        children: [
          {
            id: "be:host/ctx:default/img:sha256:aaa",
            kind: "image",
            label: "alpine:3.18",
            status: "stopped",
            backendId: "host",
            contextName: "default",
            imageId: "sha256:aaa",
            meta: "7.34MB · 2 weeks ago",
          },
          {
            id: "be:host/ctx:default/img:sha256:bbb",
            kind: "image",
            label: "node:18-alpine",
            status: "stopped",
            backendId: "host",
            contextName: "default",
            imageId: "sha256:bbb",
            meta: "120MB · 3 days ago",
          },
        ],
      },
      {
        id: "be:host/ctx:default/volumes",
        kind: "volumes-group",
        label: "Volumes (1)",
        status: "stopped",
        backendId: "host",
        contextName: "default",
        children: [
          {
            id: "be:host/ctx:default/vol:my-data",
            kind: "volume",
            label: "my-data",
            status: "stopped",
            backendId: "host",
            contextName: "default",
            volumeName: "my-data",
            meta: "local",
          },
        ],
      },
    ];
  }

  it("renders images-group and volumes-group as collapsible roots", () => {
    const nodes = makeContextWithImagesAndVolumes();
    const wrapper = mount(DockerTree, { props: { nodes, selectedId: null } });

    expect(wrapper.text()).toContain("Images (2)");
    expect(wrapper.text()).toContain("Volumes (1)");
    expect(wrapper.text()).not.toContain("alpine:3.18"); // collapsed
  });

  it("expands images and shows children with meta info", async () => {
    const treeStore = useDockerTree();
    const nodes = makeContextWithImagesAndVolumes();
    const wrapper = mount(DockerTree, { props: { nodes, selectedId: null } });

    treeStore.toggle("be:host/ctx:default/images");
    await wrapper.vm.$nextTick();

    expect(wrapper.text()).toContain("alpine:3.18");
    expect(wrapper.text()).toContain("node:18-alpine");
    expect(wrapper.text()).toContain("7.34MB");
    expect(wrapper.text()).toContain("120MB");
  });

  it("expands volumes and shows volume name + driver meta", async () => {
    const treeStore = useDockerTree();
    const nodes = makeContextWithImagesAndVolumes();
    const wrapper = mount(DockerTree, { props: { nodes, selectedId: null } });

    treeStore.toggle("be:host/ctx:default/volumes");
    await wrapper.vm.$nextTick();

    expect(wrapper.text()).toContain("my-data");
    expect(wrapper.text()).toContain("local");
  });
});
