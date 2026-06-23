import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import WorkspaceCell from "./WorkspaceCell.vue";
import { useAppStore } from "../../stores/app.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;

function makePayload(): AnyApi {
  return {
    appState: {
      activeWorkspaceId: "ws-a",
      profiles: [{ id: "default", name: "Default", color: "", workspaceIds: ["ws-a", "ws-b"] }],
      workspaces: [
        {
          id: "ws-a",
          name: "Alpha",
          profileId: "default",
          activeViewId: "ws-a:main",
          panels: [{ id: "main", command: "" }],
        },
        {
          id: "ws-b",
          name: "Beta",
          profileId: "default",
          activeViewId: "ws-b:main",
          panels: [{ id: "main", command: "" }],
        },
      ],
    },
    workspace: null,
  };
}

describe("WorkspaceCell", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("delegates non-focused cell activation to the parent focus handler", async () => {
    const store = useAppStore();
    store.payload = makePayload();
    store.activeViewId = "ws-a:main";
    const activateWorkspace = vi.spyOn(store, "activateWorkspace").mockResolvedValue(undefined);

    const wrapper = mount(WorkspaceCell, {
      props: {
        workspaceId: "ws-b",
        cellIndex: 1,
        focused: false,
      },
      global: {
        stubs: {
          WorkspaceCellHeader: { template: '<div class="workspace-cell-header"><slot /></div>' },
          WorkspacePickerPopover: true,
          TabStrip: true,
          TerminalPane: true,
        },
      },
    });

    await wrapper.find(".workspace-cell").trigger("mousedown");

    expect(wrapper.emitted("focus")).toHaveLength(1);
    expect(activateWorkspace).not.toHaveBeenCalled();
  });
});
