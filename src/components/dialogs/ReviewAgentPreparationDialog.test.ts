import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ReviewAgentPreparationDialog from "./ReviewAgentPreparationDialog.vue";
import type { OperationFinished } from "../../../electron/shared/operation-events.js";
import { useTerminalStore } from "../../stores/terminal.js";

vi.mock("../workspace/TerminalPane.vue", () => ({ default: { template: "<div data-testid='terminal' />" } }));

describe("ReviewAgentPreparationDialog", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("starts repositories in sequence and stops the prior ephemeral session on Alt+N", async () => {
    const terminal = useTerminalStore();
    const focus = vi.fn();
    terminal.views.set("session-1", { term: { focus } } as never);
    const retain = vi.spyOn(terminal, "retainTestSession");
    const release = vi.spyOn(terminal, "releaseTestSession");
    const listeners = new Set<(operation: OperationFinished) => void>();
    const onStart = vi
      .fn()
      .mockResolvedValueOnce({ operationId: "op-1" })
      .mockResolvedValueOnce({ operationId: "op-2" });
    const onStop = vi.fn().mockResolvedValue({ ok: true });
    const wrapper = mount(ReviewAgentPreparationDialog, {
      props: {
        parentWorkspaceId: "parent-1",
        profileId: "profile-a",
        selections: [
          {
            repositoryName: "one",
            selection: { provider: "github", connectionId: "gh", owner: "o", repo: "one", panelId: "agent" },
          },
          {
            repositoryName: "two",
            selection: { provider: "github", connectionId: "gh", owner: "o", repo: "two", panelId: "agent" },
          },
        ],
        onStart,
        onStop,
        subscribe: (listener: (operation: OperationFinished) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        getResult: () => undefined,
        onCancel: vi.fn(),
      },
    });
    await flushPromises();
    expect(onStart).toHaveBeenCalledTimes(1);
    const nextButton = wrapper.findAll("button").find((button) => button.text() === "Next");
    const closeButton = wrapper.findAll("button").find((button) => button.text() === "Close");
    expect(nextButton?.attributes("title")).toContain("next selected repository");
    expect(closeButton?.attributes("title")).toContain("No additional workspace is created.");
    for (const listener of listeners)
      listener({
        operationId: "op-1",
        kind: "review-agent.prepare",
        profileId: "profile-a",
        finishedAt: new Date().toISOString(),
        result: { sessionId: "session-1", repositoryName: "one", agentName: "Claude Code" },
      });
    await flushPromises();
    expect(retain).toHaveBeenCalledWith("session-1");
    expect(wrapper.get(".review-agent-preparation-dialog__terminal").attributes("aria-label")).toBe(
      "Temporary review agent terminal",
    );
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(focus).toHaveBeenCalled();
    expect(wrapper.text()).toContain("Repository 1 of 2");

    const firstNext = wrapper.get(".review-agent-preparation-dialog").trigger("keydown", { altKey: true, key: "n" });
    const duplicateNext = wrapper
      .get(".review-agent-preparation-dialog")
      .trigger("keydown", { altKey: true, key: "n" });
    await Promise.all([firstNext, duplicateNext]);
    await flushPromises();
    expect(onStop).toHaveBeenCalledWith("op-1");
    expect(release).toHaveBeenCalledWith("session-1");
    expect(onStart).toHaveBeenCalledTimes(2);
    expect(onStart.mock.calls[1][0]).toMatchObject({ repo: "two" });
    expect(wrapper.text()).toContain("Repository 2 of 2");
    const finishButton = wrapper.findAll("button").find((button) => button.text() === "Finish");
    expect(finishButton?.attributes("title")).toContain("close setup");
    wrapper.unmount();
  });

  it("stops an accepted operation when closed while its start request is pending", async () => {
    let acceptStart!: (value: { operationId: string }) => void;
    const onStart = vi.fn(
      () =>
        new Promise<{ operationId: string }>((resolve) => {
          acceptStart = resolve;
        }),
    );
    const onStop = vi.fn().mockResolvedValue({ ok: true });
    const onCancel = vi.fn();
    const terminal = useTerminalStore();
    const retain = vi.spyOn(terminal, "retainTestSession");
    const completed: OperationFinished = {
      operationId: "op-pending",
      kind: "review-agent.prepare",
      profileId: "profile-a",
      finishedAt: new Date().toISOString(),
      result: { sessionId: "session-late", repositoryName: "one", agentName: "Claude Code" },
    };
    const wrapper = mount(ReviewAgentPreparationDialog, {
      props: {
        parentWorkspaceId: "parent-1",
        profileId: "profile-a",
        selections: [
          {
            repositoryName: "one",
            selection: { provider: "github", connectionId: "gh", owner: "o", repo: "one", panelId: "agent" },
          },
        ],
        onStart,
        onStop,
        subscribe: () => () => {},
        getResult: () => completed,
        onCancel,
      },
    });
    const exposed = wrapper.vm.$.exposed as { requestClose: () => Promise<void> };
    const requestClose = exposed.requestClose();
    expect(onCancel).not.toHaveBeenCalled();
    acceptStart({ operationId: "op-pending" });
    await requestClose;
    expect(onStop).toHaveBeenCalledWith("op-pending");
    expect(onCancel).toHaveBeenCalledOnce();
    expect(retain).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("explains that Retry starts a fresh setup attempt for the same repository", async () => {
    const listeners = new Set<(operation: OperationFinished) => void>();
    const wrapper = mount(ReviewAgentPreparationDialog, {
      props: {
        parentWorkspaceId: "parent-1",
        profileId: "profile-a",
        selections: [
          {
            repositoryName: "one",
            selection: { provider: "github", connectionId: "gh", owner: "o", repo: "one", panelId: "agent" },
          },
        ],
        onStart: vi.fn().mockResolvedValue({ operationId: "op-1" }),
        onStop: vi.fn().mockResolvedValue({ ok: true }),
        subscribe: (listener: (operation: OperationFinished) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        getResult: () => undefined,
        onCancel: vi.fn(),
      },
    });
    await flushPromises();
    for (const listener of listeners)
      listener({
        operationId: "op-1",
        kind: "review-agent.prepare",
        profileId: "profile-a",
        finishedAt: new Date().toISOString(),
        error: { code: "clone_failed", message: "Could not clone repository" },
      });
    await flushPromises();

    expect(wrapper.get("button").text()).toBe("Retry");
    expect(wrapper.get("button").attributes("title")).toContain("relaunch the configured agent command");
    wrapper.unmount();
  });
});
