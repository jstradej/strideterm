import { describe, expect, test, vi } from "vitest";
import { JiraWriteSafety, type JiraWriteIdentity } from "./jira-write-safety.js";
import { JiraWriteJournal, type JiraWriteJournalState } from "./jira-write-journal.js";

const issue = { connectionId: "c1", issueId: "100", issueKey: "APP-1" };
const mine: JiraWriteIdentity = { kind: "cloud", accountId: "acct-1" };
function setup() {
  const store = {
    value: undefined as JiraWriteJournalState | undefined,
    async load() {
      return this.value && structuredClone(this.value);
    },
    async save(value: JiraWriteJournalState) {
      this.value = structuredClone(value);
    },
  };
  const journal = new JiraWriteJournal({ store });
  const attribution = {
    setting: { enabled: true, text: "On behalf of {user}", position: "before" as "before" | "after" },
    names: { user: "Alice", profile: "Work", account: "jira-tech" } as {
      user?: string;
      profile?: string;
      account?: string;
    },
  };
  const hooks = {
    listTransitions: vi.fn(async () => [{ id: "31", name: "In Progress" }]),
    transition: vi.fn(async () => ({ ok: true })),
    addComment: vi.fn(async () => ({ ok: true })),
    addRemoteLink: vi.fn(async () => ({ ok: true })),
    addWorklog: vi.fn(async () => ({ ok: true })),
    getMyself: vi.fn(async () => mine),
    canWorklog: vi.fn(async () => true),
    journal,
    getAuditContext: vi.fn(async () => ({
      profileId: "p1",
      requester: "Alice",
      apiActor: "jira-tech (verified)",
      actor: mine,
      commentAttribution: { setting: { ...attribution.setting }, names: { ...attribution.names } },
    })),
    freshIssueState: vi.fn(async () => ({ status: "To Do", updated: "2026-10-23T10:00:00Z" })),
    reconcile: vi.fn(async () => "applied" as const),
  };
  return { safety: new JiraWriteSafety(hooks), hooks, store, attribution };
}

describe("Jira write safety", () => {
  test("requires fresh matching transition and one-use explicit confirmation", async () => {
    const { safety, hooks } = setup();
    await expect(safety.previewTransition(issue, "31", "move issue forward")).resolves.toMatchObject({
      preview: "Transition APP-1 to In Progress",
    });
    const confirmation = await safety.previewTransition(issue, "31", "move issue forward");
    await expect(safety.executeTransition(issue, "32", confirmation)).rejects.toThrow("confirmation");
    await expect(safety.executeTransition(issue, "31", confirmation)).resolves.toMatchObject({
      status: "succeeded",
      journalId: expect.any(String),
    });
    await expect(safety.executeTransition(issue, "31", confirmation)).rejects.toThrow("confirmation");
    expect(hooks.listTransitions).toHaveBeenCalledTimes(3);
  });

  test("technical comment preview carries the attribution and the token covers the final text", async () => {
    const { safety, hooks } = setup();
    const confirmation = await safety.previewComment(issue, "Deployment completed.", "post this update", "technical");
    expect(confirmation.preview).toBe("On behalf of Alice\n\nDeployment completed.");
    await expect(safety.executeComment(issue, "changed content", confirmation)).rejects.toThrow("confirmation");
    await expect(safety.executeComment(issue, "Deployment completed.", confirmation)).resolves.toMatchObject({
      status: "succeeded",
      journalId: expect.any(String),
    });
    expect(hooks.addComment).toHaveBeenCalledWith(issue, confirmation.preview);
    const history = await safety.getHistory("p1");
    expect(history[0].metadata).toMatchObject({ kind: "comment", bodyHash: expect.any(String) });
  });

  test("technical comment can carry the attribution after the body", async () => {
    const { safety, attribution } = setup();
    attribution.setting.position = "after";
    const confirmation = await safety.previewComment(issue, "Body", "post this update", "technical");
    expect(confirmation.preview).toBe("Body\n\nOn behalf of Alice");
  });

  test("personal comments are posted exactly as typed", async () => {
    const { safety, hooks } = setup();
    const confirmation = await safety.previewComment(issue, "Body", "post this update", "personal");
    expect(confirmation.preview).toBe("Body");
    await safety.executeComment(issue, "Body", confirmation);
    expect(hooks.addComment).toHaveBeenCalledWith(issue, "Body");
  });

  test("a disabled or empty attribution adds nothing", async () => {
    const { safety, attribution } = setup();
    attribution.setting.enabled = false;
    await expect(safety.previewComment(issue, "Body", "post this update", "technical")).resolves.toMatchObject({
      preview: "Body",
    });
    attribution.setting.enabled = true;
    attribution.setting.text = "   ";
    await expect(safety.previewComment(issue, "Body", "post this update", "technical")).resolves.toMatchObject({
      preview: "Body",
    });
  });

  test("placeholders fall back from the own identity to the profile name to nothing", async () => {
    const { safety, attribution } = setup();
    attribution.setting.text = "{user} via {account} {other}";
    await expect(safety.previewComment(issue, "B", "post this update", "technical")).resolves.toMatchObject({
      preview: "Alice via jira-tech {other}\n\nB",
    });
    attribution.names.user = undefined;
    await expect(safety.previewComment(issue, "B", "post this update", "technical")).resolves.toMatchObject({
      preview: "Work via jira-tech {other}\n\nB",
    });
    attribution.names.profile = undefined;
    await expect(safety.previewComment(issue, "B", "post this update", "technical")).resolves.toMatchObject({
      preview: "via jira-tech {other}\n\nB",
    });
  });

  test("a settings change after the preview does not change what is posted", async () => {
    const { safety, hooks, attribution } = setup();
    const confirmation = await safety.previewComment(issue, "Body", "post this update", "technical");
    attribution.setting.text = "Changed later";
    attribution.setting.enabled = false;
    await safety.executeComment(issue, "Body", confirmation);
    expect(hooks.addComment).toHaveBeenCalledWith(issue, "On behalf of Alice\n\nBody");
    expect(confirmation.preview).toBe("On behalf of Alice\n\nBody");
  });

  test("durably records intent before POST and marks ambiguous accept unknown without retry", async () => {
    const { safety, hooks, store } = setup();
    let accepted = false;
    hooks.addComment.mockImplementation(async () => {
      accepted = true;
      throw new Error("timeout after remote accept");
    });
    const confirmation = await safety.previewComment(issue, "Deployment completed.", "post this update", "technical");
    await expect(safety.executeComment(issue, "Deployment completed.", confirmation)).rejects.toMatchObject({
      status: "unknown",
      journalId: expect.any(String),
    });
    expect(accepted).toBe(true);
    const history = await safety.getHistory("p1");
    expect(history[0]).toMatchObject({ state: "unknown", kind: "comment" });
    const next = await safety.previewComment(issue, "Deployment completed.", "post this update", "technical");
    await expect(safety.executeComment(issue, "Deployment completed.", next)).rejects.toThrow("Reconcile");
    expect(hooks.addComment).toHaveBeenCalledTimes(1);
    const restartedHooks = { ...hooks, journal: new JiraWriteJournal({ store }) };
    const restarted = new JiraWriteSafety(restartedHooks);
    const afterRestart = await restarted.previewComment(
      issue,
      "Deployment completed.",
      "post this update",
      "technical",
    );
    await expect(restarted.executeComment(issue, "Deployment completed.", afterRestart)).rejects.toThrow("Reconcile");
    expect(hooks.addComment).toHaveBeenCalledTimes(1);
    hooks.reconcile.mockResolvedValue("applied");
    await expect(safety.reconcileWrite("p1", history[0].id)).resolves.toMatchObject({
      outcome: "applied",
      status: "reconciled",
    });
  });

  test("does not POST when durable intent persistence fails", async () => {
    const { safety, hooks, store } = setup();
    const confirmation = await safety.previewComment(issue, "A private comment", "post a private comment", "technical");
    store.save = async () => {
      throw new Error("disk unavailable");
    };
    await expect(safety.executeComment(issue, "A private comment", confirmation)).rejects.toThrow(
      "no Jira request was sent",
    );
    expect(hooks.addComment).not.toHaveBeenCalled();
  });

  test("two safety instances sharing the runtime journal serialize identical concurrent writes", async () => {
    const { safety, hooks } = setup();
    let release!: () => void;
    hooks.addComment.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true });
        }),
    );
    const firstConfirmation = await safety.previewComment(issue, "Same update", "post same update", "technical");
    const secondSafety = new JiraWriteSafety({ ...hooks });
    const secondConfirmation = await secondSafety.previewComment(issue, "Same update", "post same update", "technical");
    const first = safety.executeComment(issue, "Same update", firstConfirmation);
    await vi.waitFor(() => expect(hooks.addComment).toHaveBeenCalledTimes(1));
    const second = secondSafety.executeComment(issue, "Same update", secondConfirmation);
    await expect(second).rejects.toThrow("Reconcile");
    release();
    await expect(first).resolves.toMatchObject({ status: "succeeded" });
    expect(hooks.addComment).toHaveBeenCalledTimes(1);
  });

  test("worklog requires personal account, fresh identity match, and permission", async () => {
    const { safety, hooks } = setup();
    await expect(
      safety.previewWorklog(
        issue,
        { seconds: 60, started: "2026-10-23T10:00:00Z" },
        "record my work",
        "technical",
        mine,
      ),
    ).rejects.toThrow("personal");
    hooks.getMyself.mockResolvedValue({ kind: "cloud", accountId: "other" });
    await expect(
      safety.previewWorklog(
        issue,
        { seconds: 60, started: "2026-10-23T10:00:00Z" },
        "record my work",
        "personal",
        mine,
      ),
    ).rejects.toThrow("no longer matches");
    hooks.getMyself.mockResolvedValue(mine);
    hooks.canWorklog.mockResolvedValue(false);
    await expect(
      safety.previewWorklog(
        issue,
        { seconds: 60, started: "2026-10-23T10:00:00Z" },
        "record my work",
        "personal",
        mine,
      ),
    ).rejects.toThrow("cannot log work");
    hooks.canWorklog.mockResolvedValue(true);
    const confirmation = await safety.previewWorklog(
      issue,
      { seconds: 60, started: "2026-10-23T10:00:00Z" },
      "record my work",
      "personal",
      mine,
    );
    await expect(
      safety.executeWorklog(issue, { seconds: 60, started: "2026-10-23T10:00:00Z" }, confirmation, "personal", mine),
    ).resolves.toMatchObject({ status: "succeeded", journalId: expect.any(String) });
    expect(hooks.getMyself).toHaveBeenCalledTimes(4);
    expect(hooks.canWorklog).toHaveBeenCalledTimes(3);
  });
});
