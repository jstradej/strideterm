import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { apiKey } from "../../types/keys.js";
import { sandboxDecisionSchema } from "../../../electron/backend/ipc-schemas.js";
import type { SandboxDeniedRequest } from "../../../electron/shared/sandbox.js";

vi.mock("../../composables/useNotificationSound.js", () => ({ fireNotificationAlert: vi.fn() }));
const saveWorkspace = vi.fn(async (_workspace: unknown) => undefined);
const appState = {
  myActiveProfileId: "default",
  saveWorkspace,
  payload: {
    appState: {
      workspaces: [{ id: "w1", name: "demo", profileId: "default", panels: [{ id: "p1", title: "🤖 Claude Code" }] }],
    },
  },
};
vi.mock("../../stores/app.js", () => ({ useAppStore: () => appState }));

import SandboxRequestList from "./SandboxRequestList.vue";
import { useNotificationStore } from "../../stores/notifications.js";
import { useSandboxRequestsStore } from "../../stores/sandbox-requests.js";

const request = (overrides: Partial<SandboxDeniedRequest> = {}): SandboxDeniedRequest => ({
  id: "req-1",
  workspaceId: "w1",
  sessionId: "w1:p1",
  host: "api.datadoghq.com",
  port: 443,
  at: Date.now(),
  state: "pending",
  ...overrides,
});

function makeApi() {
  const handlers: { denied?: (r: SandboxDeniedRequest) => void; settled?: (r: SandboxDeniedRequest) => void } = {};
  const api = {
    onSandboxDenied: vi.fn((handler: (r: SandboxDeniedRequest) => void) => {
      handlers.denied = handler;
      return () => undefined;
    }),
    onSandboxDeniedSettled: vi.fn((handler: (r: SandboxDeniedRequest) => void) => {
      handlers.settled = handler;
      return () => undefined;
    }),
    listSandboxRequests: vi.fn(async () => [] as SandboxDeniedRequest[]),
    decideSandboxRequest: vi.fn(async (_payload: unknown) => ({ ok: true, remembered: "" })),
  };
  return { api, handlers };
}

async function mountList() {
  const { api, handlers } = makeApi();
  await useSandboxRequestsStore().start(api as never);
  const wrapper = mount(SandboxRequestList, {
    props: { workspaceId: "w1", fallback: "Earlier history" },
    global: { provide: { [apiKey]: api } },
  });
  return { api, handlers, wrapper };
}

describe("SandboxRequestList", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
    saveWorkspace.mockClear();
  });

  test("a pending request names who asked, emphasises the registrable domain and has three equal buttons", async () => {
    const { handlers, wrapper } = await mountList();
    expect(wrapper.text()).toContain("Earlier history");
    handlers.denied!(request());
    await flushPromises();

    const row = wrapper.get('[data-testid="sandbox-request"]');
    expect(row.text()).toContain("Claude Code · demo");
    expect(row.get(".sandbox-request__domain").text()).toBe("datadoghq.com");
    expect(row.get(".sandbox-request__host").text()).toBe("api.datadoghq.com");

    const buttons = row.findAll("button");
    expect(buttons.map((button) => button.text())).toEqual(["Allow for this workspace", "Allow this time", "Deny"]);
    expect(new Set(buttons.map((button) => button.attributes("class"))).size).toBe(1);
    expect(buttons.some((button) => /primary/u.test(button.attributes("class") || ""))).toBe(false);
  });

  test.each([
    ["sandbox-allow-workspace", true, true, "Allowed for this workspace"],
    ["sandbox-allow-once", true, false, "Allowed once"],
    ["sandbox-deny", false, false, "Refused"],
  ] as const)(
    "%s sends a payload the real schema accepts and shows the outcome",
    async (testId, allow, remember, text) => {
      const { api, handlers, wrapper } = await mountList();
      handlers.denied!(request());
      await flushPromises();
      await wrapper.get(`[data-testid="${testId}"]`).trigger("click");
      await flushPromises();

      const payload = api.decideSandboxRequest.mock.calls.at(-1)![0];
      expect(payload).toEqual({ requestId: "req-1", allow, remember });
      expect(sandboxDecisionSchema.safeParse(payload).success).toBe(true);
      expect(wrapper.get('[data-testid="sandbox-outcome"]').text()).toBe(text);
      expect(wrapper.find('[data-testid="sandbox-deny"]').exists()).toBe(false);
    },
  );

  test("an expired request keeps its outcome and offers to allow the destination for the workspace", async () => {
    const { api, handlers, wrapper } = await mountList();
    handlers.denied!(request());
    await flushPromises();
    handlers.settled!(request({ state: "expired" }));
    await flushPromises();

    expect(wrapper.get('[data-testid="sandbox-outcome"]').text()).toBe("Refused — no answer in time");
    expect(wrapper.find('[data-testid="sandbox-allow-once"]').exists()).toBe(false);
    await wrapper.get('[data-testid="sandbox-allow-later"]').trigger("click");
    await flushPromises();

    expect(api.decideSandboxRequest).toHaveBeenLastCalledWith({ requestId: "req-1", allow: true, remember: true });
    expect(saveWorkspace).not.toHaveBeenCalled();
    expect(wrapper.get('[data-testid="sandbox-outcome"]').text()).toContain("Added to this workspace");
    expect(wrapper.find('[data-testid="sandbox-allow-later"]').exists()).toBe(false);
  });

  test("a failed answer is an error toast and the buttons stay", async () => {
    const { api, handlers, wrapper } = await mountList();
    api.decideSandboxRequest.mockRejectedValueOnce(new Error("disk full"));
    const showError = vi.spyOn(useNotificationStore(), "showError");
    handlers.denied!(request());
    await flushPromises();
    await wrapper.get('[data-testid="sandbox-deny"]').trigger("click");
    await flushPromises();

    expect(showError).toHaveBeenCalled();
    expect(wrapper.find('[data-testid="sandbox-deny"]').exists()).toBe(true);
  });

  test("an entry the user removed from the history takes its request with it", async () => {
    const { handlers, wrapper } = await mountList();
    handlers.denied!(request());
    await flushPromises();
    handlers.settled!(request({ state: "denied" }));
    useNotificationStore().remove(useNotificationStore().sessions[0]!.id);
    await flushPromises();

    expect(wrapper.find('[data-testid="sandbox-request"]').exists()).toBe(false);
  });
});
