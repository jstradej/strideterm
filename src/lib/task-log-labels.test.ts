import { describe, expect, it } from "vitest";
import { eventLabel, eventCategory } from "./task-log-labels.js";

/**
 * TaskDashboardStatusTab.vue and TaskDashboardLogTab.vue used to keep separate
 * EVENT_LABELS maps that had drifted: the Log tab's copy didn't know about
 * `judge-nudged` / `verdict-rejected`, so those events fell back to showing
 * the raw event id instead of a label. This is the canonical, merged map both
 * tabs now import — these events must resolve to a real label everywhere.
 */
describe("eventLabel", () => {
  it("resolves 'judge-nudged' to its label instead of the raw event id", () => {
    expect(eventLabel("judge-nudged")).toBe("Judge nudged");
  });

  it("resolves 'verdict-rejected' to its label instead of the raw event id", () => {
    expect(eventLabel("verdict-rejected")).toBe("User rejected verdict");
  });

  it("falls back to the raw event id for a genuinely unknown event", () => {
    expect(eventLabel("some-future-event")).toBe("some-future-event");
  });

  it("uses the more-complete label where the two prior maps overlapped", () => {
    // Status tab previously had "Worker idle"; Log tab had the more
    // descriptive "Worker idle detected" — the merge keeps the latter.
    expect(eventLabel("worker-idle-detected")).toBe("Worker idle detected");
  });
});

describe("eventCategory", () => {
  it("categorizes 'judge-nudged' as judge (prefix match)", () => {
    expect(eventCategory("judge-nudged")).toBe("judge");
  });

  it("categorizes 'verdict-rejected' as warn", () => {
    expect(eventCategory("verdict-rejected")).toBe("warn");
  });

  it("categorizes success/error/shower events correctly", () => {
    expect(eventCategory("task-completed")).toBe("success");
    expect(eventCategory("task-failed")).toBe("error");
    expect(eventCategory("shower-failed")).toBe("error");
    expect(eventCategory("shower-started")).toBe("shower");
  });

  it("falls back to info for an unrecognized event", () => {
    expect(eventCategory("task-started")).toBe("info");
  });
});
