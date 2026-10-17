import { beforeEach, describe, expect, it, vi } from "vitest";
import { computed, shallowRef } from "vue";
import { createPinia, setActivePinia } from "pinia";

vi.mock("../composables/useNotificationSound.js", () => ({ fireNotificationAlert: vi.fn() }));

import { fireNotificationAlert } from "../composables/useNotificationSound.js";
import { useNotificationStore } from "./notifications.js";
import { createReviewGitOperations, describeProposal, describeReviewGitOutcome } from "./review-git-operations.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;

const event = (overrides: Record<string, unknown> = {}) => ({
  operationId: "op-1",
  profileId: "default",
  workspaceId: "ws-1",
  kind: "push",
  source: "ui",
  state: "succeeded",
  startedAt: "2026-10-17T10:00:00.000Z",
  finishedAt: "2026-10-17T10:00:01.000Z",
  result: { status: "pushed", message: "Pushed abc to feature." },
  ...overrides,
});

function setup({ profile = "default" as string | null } = {}) {
  const payload = shallowRef<AnyApi>({
    appState: { workspaces: [{ id: "ws-1", name: "repo PR #7" }] },
    reviewGit: { running: [], lastRuns: [] },
  });
  const startReviewGitOperation = vi.fn(async (_input: AnyApi) => ({ started: true as const, operationId: "op-1" }));
  const confirmInApp = vi.fn(async (_opts: AnyApi) => true);
  const ops = createReviewGitOperations({
    payload,
    myActiveProfileId: computed(() => profile),
    getApi: () => ({ startReviewGitOperation }) as AnyApi,
    confirmInApp,
  });
  return { ops, payload, startReviewGitOperation, confirmInApp };
}

const proposal = (overrides: Record<string, unknown> = {}) => ({
  proposalId: "prop-1",
  kind: "reset",
  title: "Reset onto the rewritten pull request branch?",
  message: "The PR branch no longer contains HEAD.",
  facts: { headSha: "a".repeat(40), liveSha: "b".repeat(40), baselineSha: null },
  affectedCommits: [{ sha: "a".repeat(40), subject: "my local commit" }],
  affectedTotal: 1,
  incomingCommits: [{ sha: "b".repeat(40), subject: "rewritten" }],
  incomingTotal: 1,
  choices: [
    { id: "proceed", label: "Discard local commits and reset" },
    { id: "keep", label: "Keep local" },
    { id: "cancel", label: "Cancel" },
  ],
  ...overrides,
});

beforeEach(() => {
  setActivePinia(createPinia());
  window.localStorage.clear();
  vi.mocked(fireNotificationAlert).mockClear();
});

describe("run", () => {
  it("starts at once and resolves with the result the live event carries", async () => {
    const { ops, startReviewGitOperation } = setup();
    const pending = ops.run("push", "ws-1");
    await vi.waitFor(() => expect(startReviewGitOperation).toHaveBeenCalled());
    expect(startReviewGitOperation).toHaveBeenCalledWith({ kind: "push", workspaceId: "ws-1" });

    ops.reportOperation(event());

    await expect(pending).resolves.toEqual({ status: "pushed", message: "Pushed abc to feature." });
  });

  it("a result event that beats the start call's response is not lost", async () => {
    const { ops, startReviewGitOperation } = setup();
    startReviewGitOperation.mockImplementationOnce(async () => {
      ops.reportOperation(event());
      return { started: true as const, operationId: "op-1" };
    });
    await expect(ops.run("push", "ws-1")).resolves.toMatchObject({ status: "pushed" });
  });

  it("learns the outcome from the payload's last runs when the live event was missed", async () => {
    const { ops, payload } = setup();
    const pending = ops.run("push", "ws-1");
    await vi.waitFor(() => expect(payload.value).toBeTruthy());
    payload.value = { ...payload.value, reviewGit: { running: [], lastRuns: [event()] } };
    ops.reconcilePayload(payload.value.reviewGit);
    await expect(pending).resolves.toMatchObject({ status: "pushed" });
  });

  it("a failed operation rejects with the runtime's error", async () => {
    const { ops, startReviewGitOperation } = setup();
    startReviewGitOperation.mockImplementationOnce(async () => {
      ops.reportOperation(event({ state: "failed", result: undefined, error: "lease rejected" }));
      return { started: true as const, operationId: "op-1" };
    });
    await expect(ops.run("force-push", "ws-1")).rejects.toThrow("lease rejected");
  });

  it("a start the runtime refuses (wrong profile, no connection) rejects immediately", async () => {
    const { ops, startReviewGitOperation } = setup();
    startReviewGitOperation.mockRejectedValueOnce(new Error("Cross-profile refused"));
    await expect(ops.run("refresh", "ws-1")).rejects.toThrow("Cross-profile refused");
  });
});

describe("consent", () => {
  function scripted(...results: Array<Record<string, unknown>>) {
    const harness = setup();
    let call = 0;
    harness.startReviewGitOperation.mockImplementation(async () => {
      const operationId = `op-${call + 1}`;
      const result = results[call++];
      harness.ops.reportOperation(event({ operationId, result }));
      return { started: true as const, operationId };
    });
    return harness;
  }

  it("a confirmation-required outcome opens the runtime's proposal; accepting continues with exactly that proposal", async () => {
    const { ops, startReviewGitOperation, confirmInApp } = scripted(
      { status: "confirm-required", proposal: proposal(), message: "m" },
      { status: "reset", message: "Reset." },
    );

    const outcome = await ops.run("refresh", "ws-1");

    expect(outcome).toMatchObject({ status: "reset" });
    expect(confirmInApp).toHaveBeenCalledTimes(1);
    const dialog = confirmInApp.mock.calls[0][0];
    expect(dialog).toMatchObject({
      title: "Reset onto the rewritten pull request branch?",
      confirmLabel: "Discard local commits and reset",
      cancelLabel: "Keep as is",
      danger: true,
    });
    expect(dialog.message).toContain("aaaaaaaa my local commit");
    expect(dialog.message).toContain("bbbbbbbb rewritten");
    expect(startReviewGitOperation).toHaveBeenNthCalledWith(1, { kind: "refresh", workspaceId: "ws-1" });
    // The continuation names the proposal AND hands back the facts the user was shown.
    expect(startReviewGitOperation).toHaveBeenNthCalledWith(2, {
      kind: "refresh",
      workspaceId: "ws-1",
      confirmation: {
        proposalId: "prop-1",
        facts: { headSha: "a".repeat(40), liveSha: "b".repeat(40), baselineSha: null },
      },
    });
  });

  it("declining changes nothing and never starts the continuation", async () => {
    const { ops, startReviewGitOperation, confirmInApp } = scripted({
      status: "confirm-required",
      proposal: proposal(),
    });
    confirmInApp.mockResolvedValueOnce(false);

    const outcome = await ops.run("refresh", "ws-1");

    expect(outcome).toMatchObject({ status: "cancelled", message: "Cancelled — nothing was changed." });
    expect(startReviewGitOperation).toHaveBeenCalledTimes(1);
  });

  it("a proposal the repository outgrew while the user was deciding is shown again, marked as changed", async () => {
    const { ops, confirmInApp } = scripted(
      { status: "confirm-required", proposal: proposal() },
      { status: "confirm-required", stale: true, proposal: proposal({ proposalId: "prop-2" }) },
      { status: "reset", message: "Reset." },
    );

    await expect(ops.run("refresh", "ws-1")).resolves.toMatchObject({ status: "reset" });

    expect(confirmInApp).toHaveBeenCalledTimes(2);
    expect(confirmInApp.mock.calls[1][0].message).toContain("The repository changed while you were deciding.");
  });

  it("never loops forever on proposals", async () => {
    const stale = { status: "confirm-required", stale: true, proposal: proposal() };
    const { ops, confirmInApp } = scripted(stale, stale, stale, stale, stale);
    const outcome = await ops.run("refresh", "ws-1");
    expect(confirmInApp).toHaveBeenCalledTimes(3);
    expect(outcome).toMatchObject({ status: "blocked", reason: "proposal-unstable" });
  });

  it("push-and-publish asks about its push, and a push that needs consent publishes nothing until answered", async () => {
    const { ops, startReviewGitOperation, confirmInApp } = scripted(
      {
        kind: "push-and-publish",
        push: {
          status: "confirm-required",
          proposal: proposal({ proposalId: "prop-9", kind: "push", title: "Push to feature?" }),
        },
        publish: { attempted: false, published: [], failed: [] },
      },
      {
        kind: "push-and-publish",
        push: { status: "pushed", message: "Pushed." },
        publish: { attempted: true, published: ["c1"], failed: [] },
      },
    );

    const outcome = await ops.run("push-and-publish", "ws-1");

    expect(confirmInApp.mock.calls[0][0].title).toBe("Push to feature?");
    expect(startReviewGitOperation).toHaveBeenNthCalledWith(2, {
      kind: "push-and-publish",
      workspaceId: "ws-1",
      confirmation: {
        proposalId: "prop-9",
        facts: { headSha: "a".repeat(40), liveSha: "b".repeat(40), baselineSha: null },
      },
    });
    expect(outcome.publish.published).toEqual(["c1"]);
  });

  it("with confirm disabled the proposal is returned for the caller to present", async () => {
    const { ops, confirmInApp } = scripted({ status: "confirm-required", proposal: proposal() });
    const outcome = await ops.run("refresh", "ws-1", { confirm: false });
    expect(outcome.status).toBe("confirm-required");
    expect(confirmInApp).not.toHaveBeenCalled();
  });
});

describe("busy state", () => {
  it("comes from the runtime's list of running operations, per workspace and kind", () => {
    const { ops, payload } = setup();
    expect(ops.isBusy("ws-1")).toBe(false);
    payload.value = {
      ...payload.value,
      reviewGit: {
        running: [event({ state: "running", kind: "rebase", result: undefined, finishedAt: null })],
        lastRuns: [],
      },
    };
    expect(ops.isBusy("ws-1")).toBe(true);
    expect(ops.isBusy("ws-1", ["rebase"])).toBe(true);
    expect(ops.isBusy("ws-1", ["push"])).toBe(false);
    expect(ops.isBusy("ws-2")).toBe(false);
  });
});

describe("operations started somewhere else", () => {
  const entries = () => useNotificationStore().sessions.flatMap((session) => session.events);

  it("raise one Notification Center entry per operation per client — live and replayed from the payload alike", () => {
    const { ops } = setup();
    ops.reportOperation(event({ operationId: "op-7" }));
    ops.reconcilePayload({ running: [], lastRuns: [event({ operationId: "op-7" })] });
    expect(entries().filter((entry) => entry.sourceAlertId === "review-git:op-7")).toHaveLength(1);
    expect(fireNotificationAlert).toHaveBeenCalledTimes(1);
  });

  it("a reload does not re-announce an operation this client was already told about, even if the entry was removed", () => {
    const first = setup();
    first.ops.reportOperation(event({ operationId: "op-8" }));
    useNotificationStore().clearAll?.();

    setActivePinia(createPinia());
    const reloaded = setup();
    reloaded.ops.reconcilePayload({ running: [], lastRuns: [event({ operationId: "op-8" })] });

    expect(entries()).toHaveLength(0);
  });

  it("an agent's operation is reported to the agent, not announced in the UI", () => {
    const { ops } = setup();
    ops.reportOperation(event({ source: "mcp" }));
    expect(entries()).toHaveLength(0);
  });

  it("another profile's operation is not shown while viewing this one", () => {
    const { ops } = setup({ profile: "work" });
    ops.reportOperation(event({ profileId: "default" }));
    expect(entries()).toHaveLength(0);
  });

  it("an operation this renderer started and awaits is answered to its caller, not announced again", async () => {
    const { ops, startReviewGitOperation } = setup();
    startReviewGitOperation.mockImplementationOnce(async () => {
      ops.reportOperation(event());
      return { started: true as const, operationId: "op-1" };
    });
    await ops.run("push", "ws-1");
    expect(entries()).toHaveLength(0);
  });

  it("is not re-announced from the payload once ownership has lapsed", async () => {
    vi.useFakeTimers();
    try {
      const { ops, startReviewGitOperation } = setup();
      startReviewGitOperation.mockImplementationOnce(async () => {
        ops.reportOperation(event());
        return { started: true as const, operationId: "op-1" };
      });
      await ops.run("push", "ws-1");
      await vi.advanceTimersByTimeAsync(6_000);
      ops.reconcilePayload({ running: [], lastRuns: [event()] });
      expect(entries()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an operation whose wait gave up is still announced when its outcome arrives", async () => {
    vi.useFakeTimers();
    try {
      const { ops, startReviewGitOperation } = setup();
      startReviewGitOperation.mockImplementationOnce(async () => ({ started: true as const, operationId: "op-1" }));
      const pending = ops.run("push", "ws-1");
      const settled = expect(pending).rejects.toThrow("Lost track");
      await vi.advanceTimersByTimeAsync(16 * 60 * 1000);
      await settled;
      await vi.advanceTimersByTimeAsync(6_000);
      ops.reportOperation(event());
      expect(entries()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a failure is announced as an error", () => {
    const { ops } = setup();
    ops.reportOperation(event({ state: "failed", result: undefined, error: "lease rejected" }));
    expect(entries()[0]).toMatchObject({ title: "Git push failed", body: "lease rejected" });
  });

  it("malformed events are ignored", () => {
    const { ops } = setup();
    ops.reportOperation({ operationId: "x" });
    ops.reconcilePayload({ lastRuns: [{ nonsense: true }] });
    expect(entries()).toHaveLength(0);
  });
});

describe("wording", () => {
  it("describeProposal names the kind of commits at stake", () => {
    expect(describeProposal(proposal() as AnyApi)).toContain("Local commits that would be discarded (1):");
    expect(describeProposal(proposal({ kind: "force-push" }) as AnyApi)).toContain(
      "Server commits that would be replaced (1):",
    );
    expect(describeProposal(proposal({ kind: "rebase" }) as AnyApi)).toContain(
      "Local commits that would be rewritten (1):",
    );
  });

  it("describeReviewGitOutcome reports a push and its comments independently", () => {
    expect(
      describeReviewGitOutcome("push-and-publish", {
        push: { status: "pushed", message: "Pushed abc." },
        publish: { attempted: true, published: ["a", "b"], failed: [{ error: "403" }] },
      }),
    ).toBe("Pushed abc. 2 comments published, 1 failed (403).");
    expect(
      describeReviewGitOutcome("push-and-publish", {
        push: { status: "blocked", message: "wrong branch" },
        publish: { attempted: false, published: [], failed: [] },
      }),
    ).toBe("wrong branch No comments were published.");
  });
});
