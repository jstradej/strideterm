import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { useAppStore } from "./app.js";
import { useNotificationStore } from "./notifications.js";
import { reviewTrustViewId, useReviewTrustStore } from "./review-trust.js";
import type { StatePayload } from "../../electron/shared/types/state.js";
import type { Transport } from "../transport.js";
import { trustReviewFolderSchema } from "../../electron/shared/pull-request-review.js";

const entry = {
  sessionId: "review-ws:agent",
  workspaceId: "review-ws",
  profileId: "p1",
  provider: "claude",
  prKey: "gh:acme:web:7",
  since: "2026-11-20T10:00:00.000Z",
};

function payload(waiting: (typeof entry)[]): StatePayload {
  return {
    meta: {},
    appState: {
      profiles: [{ id: "p1", name: "Personal" }],
      windowSlots: [{ id: "slot1", profileId: "p1", activeWorkspaceId: "review-ws" }],
      workspaces: [{ id: "review-ws", name: "acme/web PR #7", kind: "terminal", profileId: "p1", panels: [] }],
      settings: {},
    },
    attention: { sessions: {}, alerts: [] },
    reviewTrust: { waiting },
  } as unknown as StatePayload;
}

function event(viewId = reviewTrustViewId(entry.sessionId)) {
  return useNotificationStore()
    .sessions.find((session) => session.viewId === viewId)
    ?.events.at(0);
}

beforeEach(() => {
  setActivePinia(createPinia());
  window.localStorage.clear();
  vi.stubGlobal("strideterm", { startupFlags: { windowId: "slot1" } });
});
afterEach(() => vi.unstubAllGlobals());

describe("review trust questions", () => {
  it("turns a waiting review into one actionable question and settles it when the runtime stops listing it", async () => {
    const app = useAppStore();
    const store = useReviewTrustStore();
    store.start();
    app.payload = payload([entry]);
    await nextTick();
    app.payload = payload([entry]);
    await nextTick();
    expect(store.records.filter((record) => record.outcome === "pending")).toHaveLength(1);
    expect(event()?.title).toBe("Review waits for you to trust its folder");

    app.payload = payload([]);
    await nextTick();
    expect(store.records[0]?.outcome).toBe("answered");
    expect(event()?.title).toMatch(/No longer waiting/u);
  });

  it("raises only the questions of the profile on screen, and settles one left from before a reload", async () => {
    const app = useAppStore();
    const store = useReviewTrustStore();
    const notifications = useNotificationStore();
    notifications.addAlertEvent({
      title: "Review waits for you to trust its folder",
      body: "",
      kind: "question",
      tier: 1,
      urgency: "normal",
      workspaceId: "old-ws",
      workspaceName: "old",
      tabName: "Folder trust",
      viewId: reviewTrustViewId("old-ws:agent"),
      category: "review-trust",
      meta: { profileId: "p1" },
      sourceAlertId: "review-trust:old-ws:agent:x",
      occurredAt: "2026-11-20T09:00:00.000Z",
    } as Parameters<typeof notifications.addAlertEvent>[0]);
    store.start();
    app.payload = payload([{ ...entry, profileId: "p2" }]);
    await nextTick();
    expect(store.records).toHaveLength(0);
    expect(notifications.sessions.find((session) => session.viewId === reviewTrustViewId("old-ws:agent"))?.state).toBe(
      "resolved",
    );
  });

  it("answers through the transport and reports a refusal without losing the question", async () => {
    const app = useAppStore();
    const store = useReviewTrustStore();
    store.start();
    app.payload = payload([entry]);
    await nextTick();
    const api = {
      trustReviewFolder: vi
        .fn()
        .mockRejectedValueOnce(new Error("Could not select “Yes, I trust this folder”."))
        .mockResolvedValueOnce({ trusted: true }),
    } as unknown as Transport;

    await store.trust(api, entry.sessionId);
    expect(store.records[0]).toMatchObject({ outcome: "pending", busy: false });
    expect(
      useNotificationStore().sessions.some(
        (session) => session.events[0]?.title === "Could not trust the review folder",
      ),
    ).toBe(true);

    await store.trust(api, entry.sessionId);
    expect(api.trustReviewFolder).toHaveBeenLastCalledWith({ sessionId: entry.sessionId });
    // Held to the route's real strict schema, not only to this store's own expectation.
    const sent = (api.trustReviewFolder as unknown as { mock: { lastCall: unknown[] } }).mock.lastCall[0];
    expect(trustReviewFolderSchema.safeParse(sent).success).toBe(true);
    expect(store.records[0]?.outcome).toBe("trusted");
    expect(event()?.title).toBe("Folder trusted — the review is running");
  });
});
