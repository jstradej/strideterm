/**
 * The auto-approval trail as a dock tab.
 *
 * The list is a grid, not a `<table>`, and its rows are grouped by the same
 * day bands the Alerts tab uses; the things worth pinning down are the ones a
 * refactor could quietly break — keyset paging, profile scoping, the delete
 * affordance that must not exist on a transport that cannot delete, and the
 * search filter that a live arrival must not contradict.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import ApprovalsPanel from "./ApprovalsPanel.vue";

interface Row {
  id: number;
  timestamp: string;
  workspaceId?: string;
  workspaceName?: string;
  panelTitle?: string;
  sessionId?: string;
  toolName?: string;
  summary?: string;
  profileId?: string;
  outcome?: string;
  decisionReason?: string;
  claudeSessionId?: string;
}

/** Midday today: far enough from either midnight that a band never flips. */
function noon(daysAgo = 0): Date {
  const at = new Date();
  at.setHours(12, 0, 0, 0);
  at.setDate(at.getDate() - daysAgo);
  return at;
}

function row(id: number, overrides: Partial<Row> = {}): Row {
  return {
    id,
    // Higher id, later timestamp — the real store's ids are monotonic, and
    // `ORDER BY id DESC` is newest-first only because of that.
    timestamp: new Date(noon().getTime() + id * 1000).toISOString(),
    workspaceId: "ws-a",
    workspaceName: "Alpha",
    panelTitle: "Claude Code",
    sessionId: "ws-a:shell",
    toolName: "Bash",
    summary: `Bash: step ${id}`,
    profileId: "default",
    outcome: "decision-issued",
    ...overrides,
  };
}

/** A fake transport whose calls are recorded, like the real IPC surface. */
function makeApi(rows: Row[], { canDelete = true } = {}) {
  const queryCalls: Record<string, unknown>[] = [];
  const deleteCalls: Record<string, unknown>[] = [];
  let store = [...rows];

  const api: Record<string, unknown> = {
    isRemote: !canDelete,
    queryApprovalAuditLog: (filters: Record<string, unknown>) => {
      queryCalls.push(filters);
      const limit = Number(filters.limit) || 40;
      const before = Number(filters.beforeId) || 0;
      const term = String(filters.search || "").toLowerCase();
      const profileId = String(filters.profileId || "");
      const matching = store
        .filter((entry) => !profileId || entry.profileId === profileId)
        .filter(
          (entry) =>
            !term ||
            String(entry.summary || "")
              .toLowerCase()
              .includes(term),
        )
        .sort((a, b) => b.id - a.id);
      const page = matching.filter((entry) => (before ? entry.id < before : true)).slice(0, limit);
      return Promise.resolve({ entries: page, total: matching.length });
    },
  };
  if (canDelete) {
    api.deleteApprovalAuditEntries = (payload: Record<string, unknown>) => {
      deleteCalls.push(payload);
      const ids = new Set((payload.ids as number[] | undefined) || []);
      store = payload.all ? [] : store.filter((entry) => !ids.has(entry.id));
      return Promise.resolve({ deleted: 1 });
    };
  }
  return { api, queryCalls, deleteCalls };
}

async function mountPanel(rows: Row[], options: { canDelete?: boolean; profileId?: string; pageSize?: number } = {}) {
  const harness = makeApi(rows, { canDelete: options.canDelete ?? true });
  const wrapper = mount(ApprovalsPanel, {
    props: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      api: harness.api as any,
      profileId: options.profileId ?? "default",
      ...(options.pageSize ? { pageSize: options.pageSize } : {}),
    },
  });
  await flushPromises();
  return { wrapper, ...harness };
}

/**
 * Deliver one `approval:recorded` payload the way the dock does — as props.
 * The subscription lives in NotificationCenter, which is mounted for the life
 * of the renderer; this component is behind a `v-if` on its tab, and neither
 * transport hands back an unsubscribe.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fire(wrapper: any, signal: number, payload: Record<string, unknown>): Promise<void> {
  await wrapper.setProps({ liveApproval: payload, liveSignal: signal });
  await flushPromises();
}

beforeEach(() => {
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: vi.fn() } });
});

describe("ApprovalsPanel", () => {
  it("renders one row per approval, newest first, under a day band", async () => {
    const { wrapper } = await mountPanel([row(1), row(2), row(3)]);

    const rendered = wrapper.findAll(".approval-row");
    expect(rendered).toHaveLength(3);
    expect(rendered[0].text()).toContain("Bash: step 3");
    expect(rendered[2].text()).toContain("Bash: step 1");
    // All three are minutes old, so exactly one "Today" band covers them.
    const bands = wrapper.findAll(".notif-day-separator__label");
    expect(bands).toHaveLength(1);
    expect(bands[0].text()).toBe("Today");
  });

  it("groups rows under one band per calendar day", async () => {
    const { wrapper } = await mountPanel([
      row(30, { timestamp: noon(0).toISOString() }),
      row(20, { timestamp: noon(1).toISOString() }),
      row(10, { timestamp: noon(20).toISOString() }),
    ]);

    const bands = wrapper.findAll(".notif-day-separator__label").map((el) => el.text());
    expect(bands[0]).toBe("Today");
    expect(bands[1]).toBe("Yesterday");
    // Older than a week falls back to an explicit date rather than a weekday
    // name, which would be ambiguous three weeks out.
    expect(bands).toHaveLength(3);
    expect(bands[2]).not.toBe("Today");
    expect(bands[2]).not.toBe("Yesterday");
  });

  it("scopes every read to the active profile and re-reads when it changes", async () => {
    const { wrapper, queryCalls } = await mountPanel([row(1, { profileId: "work" }), row(2, { profileId: "home" })], {
      profileId: "work",
    });

    expect(queryCalls[0]).toMatchObject({ profileId: "work" });
    expect(wrapper.findAll(".approval-row")).toHaveLength(1);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- setProps' inferred type drops optional props
    await wrapper.setProps({ profileId: "home" } as any);
    await flushPromises();

    expect(queryCalls[queryCalls.length - 1]).toMatchObject({ profileId: "home" });
    expect(wrapper.text()).toContain("Bash: step 2");
  });

  it("pages with the store's keyset cursor, not an offset", async () => {
    const rows = Array.from({ length: 5 }, (_unused, index) => row(index + 1));
    const { wrapper, queryCalls } = await mountPanel(rows, { pageSize: 2 });

    expect(wrapper.findAll(".approval-row")).toHaveLength(2);
    await wrapper.find(".approvals__more").trigger("click");
    await flushPromises();

    // The second page asks for rows BELOW the oldest one on screen. A `to:`
    // timestamp window would have returned the same page again when several
    // approvals share a millisecond.
    expect(queryCalls[1]).toMatchObject({ beforeId: 4, limit: 2 });
    expect(queryCalls[1].offset).toBeUndefined();
    expect(wrapper.findAll(".approval-row")).toHaveLength(4);
  });

  it("opens the full command and the correlation fields on click", async () => {
    const { wrapper } = await mountPanel([
      row(1, { summary: "Bash: chmod +x deploy.sh", claudeSessionId: "claude-1", decisionReason: "global" }),
    ]);

    expect(wrapper.find(".approval-detail").exists()).toBe(false);
    await wrapper.find(".approval-row__main").trigger("click");

    const detail = wrapper.find(".approval-detail");
    expect(detail.exists()).toBe(true);
    expect(detail.find(".approval-detail__command").text()).toBe("Bash: chmod +x deploy.sh");
    expect(detail.text()).toContain("claude-1");
    expect(detail.text()).toContain("global");
    // The row says what it is evidence of, and what it is not.
    expect(detail.text()).toContain("decision-issued");
    expect(detail.text()).toContain("not that the tool ran");

    // Clicking again closes it — one row open at a time.
    await wrapper.find(".approval-row__main").trigger("click");
    expect(wrapper.find(".approval-detail").exists()).toBe(false);
  });

  it("deletes one row without re-reading the page under the cursor", async () => {
    const { wrapper, deleteCalls, queryCalls } = await mountPanel([row(1), row(2)]);
    const queriesBefore = queryCalls.length;

    await wrapper.find(".approval-row__main").trigger("click");
    await wrapper.find(".quick-action--danger").trigger("click");
    await flushPromises();

    // The first row is the newest, which is the highest id.
    expect(deleteCalls[0]).toMatchObject({ ids: [2], profileId: "default" });
    expect(wrapper.findAll(".approval-row")).toHaveLength(1);
    expect(wrapper.text()).not.toContain("Bash: step 2");
    // No reload: a re-read would also pull in whatever arrived since, and the
    // list would jump under the pointer that just clicked Delete.
    expect(queryCalls).toHaveLength(queriesBefore);
  });

  it("clears the whole trail for this profile and reports the new count", async () => {
    const { wrapper, deleteCalls } = await mountPanel([row(1), row(2)]);

    await wrapper.find(".approvals__clear").trigger("click");
    await flushPromises();

    expect(deleteCalls[0]).toMatchObject({ all: true, profileId: "default" });
    expect(wrapper.findAll(".approval-row")).toHaveLength(0);
    // The dock hides the tab when the trail empties, so the count has to go out.
    expect(wrapper.emitted("count")?.at(-1)).toEqual([0]);
  });

  it("offers no delete control at all on a transport that cannot delete", async () => {
    const { wrapper } = await mountPanel([row(1)], { canDelete: false });

    await wrapper.find(".approval-row__main").trigger("click");
    expect(wrapper.find(".approvals__clear").exists()).toBe(false);
    expect(wrapper.find(".quick-action--danger").exists()).toBe(false);
    // Reading is still the point of the tab on a remote client.
    expect(wrapper.find(".approval-detail").exists()).toBe(true);
  });

  it("copies the whole row, ids included, and the bare command on its own", async () => {
    const writeText = vi.fn();
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const { wrapper } = await mountPanel([
      row(1, {
        toolName: "WebFetch",
        summary: "WebFetch: example.com",
        workspaceName: "tes22222",
        panelTitle: "Claude Code",
        workspaceId: "workspace-355",
        sessionId: "workspace-355:panel-13d",
        decisionReason: "global",
        claudeSessionId: "claude-1",
      }),
    ]);
    await wrapper.find(".approval-row__main").trigger("click");
    const buttons = wrapper.findAll(".quick-action");

    await buttons.find((button) => button.text() === "Copy details")?.trigger("click");
    const details = writeText.mock.calls[0][0] as string;
    // Everything the expanded row shows, plus the ids it deliberately keeps
    // off screen — on a screen they are noise, in a pasted issue they are the
    // only thing that ties this approval to a log line.
    expect(details).toContain("WebFetch");
    expect(details).toContain("tes22222 › Claude Code");
    expect(details).toContain("workspace-355");
    expect(details).toContain("workspace-355:panel-13d");
    expect(details).toContain("decision-issued");
    expect(details).toContain("global");
    expect(details).toContain("claude-1");
    // The command goes last, after a blank line, so a multi-line one cannot
    // break up the header block.
    expect(details.endsWith("\n\nWebFetch: example.com")).toBe(true);

    await buttons.find((button) => button.text() === "Copy command")?.trigger("click");
    expect(writeText.mock.calls[1][0]).toBe("WebFetch: example.com");
  });

  it("emits the panel a Jump should land on", async () => {
    const { wrapper } = await mountPanel([row(1, { workspaceId: "ws-a", sessionId: "ws-a:shell" })]);

    await wrapper.find(".approval-row__main").trigger("click");
    await wrapper
      .findAll(".quick-action")
      .find((button) => button.text() === "Jump")
      ?.trigger("click");

    expect(wrapper.emitted("jump")?.[0]).toEqual([{ workspaceId: "ws-a", viewId: "ws-a:shell" }]);
  });

  it("a live approval refreshes the list, and one that fails the search does not", async () => {
    const { wrapper, queryCalls } = await mountPanel([row(1)]);
    const queriesBefore = queryCalls.length;

    await fire(wrapper, 1, { profileId: "default", toolName: "Write", summary: "Write: notes.md" });
    expect(queryCalls.length).toBe(queriesBefore + 1);

    // With a filter active, an arrival that does not match must not appear —
    // the list would then contradict its own search box.
    await wrapper.find(".approvals__search").setValue("chmod");
    await new Promise((resolve) => setTimeout(resolve, 300));
    await flushPromises();
    const queriesAfterSearch = queryCalls.length;

    await fire(wrapper, 2, { profileId: "default", toolName: "Write", summary: "Write: notes.md" });
    expect(queryCalls.length).toBe(queriesAfterSearch);
  });

  it("ignores a live approval from another profile", async () => {
    const { wrapper, queryCalls } = await mountPanel([row(1)], { profileId: "work" });
    const queriesBefore = queryCalls.length;

    await fire(wrapper, 1, { profileId: "home", toolName: "Bash", summary: "Bash: elsewhere" });

    expect(queryCalls.length).toBe(queriesBefore);
  });

  it("explains an empty trail differently from an empty search", async () => {
    const { wrapper } = await mountPanel([]);
    expect(wrapper.find(".approvals__empty").text()).toContain("No approvals recorded yet");

    const { wrapper: filtered } = await mountPanel([row(1)]);
    await filtered.find(".approvals__search").setValue("nothing-matches-this");
    await new Promise((resolve) => setTimeout(resolve, 300));
    await flushPromises();
    expect(filtered.find(".approvals__empty").text()).toContain("Nothing matches");
  });
});
