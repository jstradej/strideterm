import { describe, expect, it, vi } from "vitest";
import { LOAD_BUSY_KEYS, useJiraPaneCore } from "./useJiraPaneCore.js";
import type { JiraPaneContext } from "./jira-pane-context.js";
import type { JiraInboxPaneProps } from "./jira-pane-types.js";

vi.mock("../../../../stores/app.js", () => ({
  useAppStore: () => ({
    getApi: () => ({ isRemote: false }),
    myActiveProfileId: "default",
    activeProfile: null,
    isMobileSession: () => false,
  }),
}));

function core() {
  return useJiraPaneCore({} as JiraPaneContext, {} as JiraInboxPaneProps);
}

describe("busy markers", () => {
  it("a superseded request frees its own marker without hiding a newer one", () => {
    const { beginBusy, isBusy } = core();
    const endFirst = beginBusy("search");
    const endSecond = beginBusy("search");
    endFirst();
    expect(isBusy("search")).toBe(true);
    endSecond();
    expect(isBusy("search")).toBe(false);
  });

  it("releasing twice is harmless and never frees another request's marker", () => {
    const { beginBusy, isBusy } = core();
    const endFirst = beginBusy("sprint");
    const endSecond = beginBusy("sprint");
    endFirst();
    endFirst();
    expect(isBusy("sprint")).toBe(true);
    endSecond();
    expect(isBusy("sprint")).toBe(false);
  });

  it("a request started before clearBusy cannot free a request started after it", () => {
    const { beginBusy, clearBusy, isBusy } = core();
    const endStale = beginBusy("board");
    clearBusy();
    expect(isBusy("board")).toBe(false);
    const endFresh = beginBusy("board");
    endStale();
    expect(isBusy("board")).toBe(true);
    endFresh();
    expect(isBusy("board")).toBe(false);
  });
  it("resetting the load markers leaves the markers of writes and creates alone", () => {
    const { beginBusy, clearBusy, isBusy } = core();
    const endBoard = beginBusy("board");
    const endCreate = beginBusy("task-create");
    const endSend = beginBusy("write-send");
    clearBusy({ only: LOAD_BUSY_KEYS });
    expect(isBusy("board")).toBe(false);
    expect(isBusy("task-create")).toBe(true);
    expect(isBusy("write-send")).toBe(true);
    endBoard();
    endCreate();
    endSend();
    expect(isBusy()).toBe(false);
  });
});
