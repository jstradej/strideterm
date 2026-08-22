import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import ReviewPipelinesTab from "./ReviewPipelinesTab.vue";
import { apiKey } from "../../../types/keys.js";
import { heartbeatTargetCount, resetHeartbeatForTests } from "../../../app/status-heartbeat.js";

/**
 * Only the per-list `auto ●` summary beats. A pull request can carry dozens of
 * pending checks and one target per row would defeat the point of a shared,
 * bounded registry — the summary already says polling is running, and each
 * row's amber icon says that row is pending.
 */

function checks(pendingCount: number) {
  return {
    pendingCount,
    failedCount: 0,
    passedCount: 1,
    items: [
      { id: "a", name: "build", state: "pending", stateLabel: "Running" },
      { id: "b", name: "lint", state: "pending", stateLabel: "Running" },
      { id: "c", name: "test", state: "succeeded", stateLabel: "Passed" },
    ],
  };
}

function mountTab(pendingCount: number) {
  return mount(ReviewPipelinesTab, {
    props: { checks: checks(pendingCount) },
    global: { provide: { [apiKey]: {} } },
  });
}

describe("ReviewPipelinesTab — only the polling summary beats", () => {
  beforeEach(() => {
    resetHeartbeatForTests();
  });

  afterEach(() => {
    resetHeartbeatForTests();
  });

  it("registers exactly one target while polling, never one per pending row", () => {
    const wrapper = mountTab(2);

    const summary = wrapper.get(".pipelines-summary__polling");
    expect(summary.text()).toContain("auto");
    expect(wrapper.findAll(".pipeline-item__icon--pending")).toHaveLength(2);
    expect(heartbeatTargetCount()).toBe(1);

    wrapper.unmount();
    expect(heartbeatTargetCount()).toBe(0);
  });

  it("registers nothing when no check is pending", () => {
    const wrapper = mountTab(0);

    expect(wrapper.find(".pipelines-summary__polling").exists()).toBe(false);
    expect(heartbeatTargetCount()).toBe(0);

    wrapper.unmount();
  });
});
