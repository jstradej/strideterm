import { describe, expect, it, vi } from "vitest";
import { nextTick, ref } from "vue";
import {
  normalizeJiraIssueLinkRoutes,
  notifyJiraIssueLinkRoutesChanged,
  useJiraIssueLinkRoutes,
} from "./useJiraIssueLinkRoutes.js";

describe("normalizeJiraIssueLinkRoutes", () => {
  it("keeps only enabled connections in the active profile with literal prefixes and safe URLs", () => {
    expect(
      normalizeJiraIssueLinkRoutes(
        [
          {
            id: "one",
            profileId: "p1",
            enabled: true,
            label: "One",
            webUrl: "https://jira.example/base/",
            issueKeyPrefixes: ["APP"],
          },
          {
            id: "other",
            profileId: "p2",
            enabled: true,
            label: "Other",
            webUrl: "https://jira.example",
            issueKeyPrefixes: ["APP"],
          },
          {
            id: "disabled",
            profileId: "p1",
            enabled: false,
            label: "Disabled",
            webUrl: "https://jira.example",
            issueKeyPrefixes: ["APP"],
          },
          {
            id: "unsafe",
            profileId: "p1",
            enabled: true,
            label: "Unsafe",
            webUrl: "file:///tmp/jira",
            issueKeyPrefixes: ["APP"],
          },
          {
            id: "invalid",
            profileId: "p1",
            enabled: true,
            label: "Invalid",
            webUrl: "https://jira.example",
            issueKeyPrefixes: ["APP|OPS"],
          },
          {
            id: "direct-only",
            profileId: "p1",
            enabled: true,
            label: "Direct ref only",
            webUrl: "https://jira.example/dc/jira",
            issueKeyPrefixes: [],
          },
        ],
        "p1",
      ),
    ).toEqual([
      { connectionId: "one", label: "One", webUrl: "https://jira.example/base", issueKeyPrefixes: ["APP"] },
      { connectionId: "invalid", label: "Invalid", webUrl: "https://jira.example", issueKeyPrefixes: [] },
      {
        connectionId: "direct-only",
        label: "Direct ref only",
        webUrl: "https://jira.example/dc/jira",
        issueKeyPrefixes: [],
      },
    ]);
  });

  it("returns no routes when the active profile has no Jira mappings", () => {
    expect(normalizeJiraIssueLinkRoutes([], "p1")).toEqual([]);
  });

  it("clears routes synchronously on profile switch and ignores stale connection responses", async () => {
    const pending: Array<(value: unknown) => void> = [];
    const api = { listJiraConnections: vi.fn(() => new Promise((resolve) => pending.push(resolve))) };
    const profileId = ref("p1");
    const { routes } = useJiraIssueLinkRoutes(api, profileId);
    expect(api.listJiraConnections).toHaveBeenCalledTimes(1);
    profileId.value = "p2";
    await nextTick();
    expect(api.listJiraConnections).toHaveBeenCalledTimes(2);
    expect(routes.value).toEqual([]);
    pending[0]([
      {
        id: "old",
        profileId: "p1",
        enabled: true,
        label: "Old",
        webUrl: "https://old.example",
        issueKeyPrefixes: ["OLD"],
      },
    ]);
    await nextTick();
    expect(routes.value).toEqual([]);
    pending[1]([
      {
        id: "new",
        profileId: "p2",
        enabled: true,
        label: "New",
        webUrl: "https://new.example",
        issueKeyPrefixes: ["NEW"],
      },
    ]);
    await nextTick();
    expect(routes.value).toEqual([
      { connectionId: "new", label: "New", webUrl: "https://new.example", issueKeyPrefixes: ["NEW"] },
    ]);
  });

  it("clears stale routes and reloads after connection metadata or membership changes", async () => {
    const api = {
      listJiraConnections: vi
        .fn()
        .mockResolvedValueOnce([
          {
            id: "old",
            profileId: "p1",
            enabled: true,
            label: "Old",
            webUrl: "https://old.example",
            issueKeyPrefixes: ["OLD"],
          },
        ])
        .mockResolvedValueOnce([
          {
            id: "new",
            profileId: "p1",
            enabled: true,
            label: "New",
            webUrl: "https://new.example",
            issueKeyPrefixes: ["NEW"],
          },
        ]),
    };
    const { routes } = useJiraIssueLinkRoutes(api, ref("p1"));
    await vi.waitFor(() => expect(routes.value[0]?.connectionId).toBe("old"));
    notifyJiraIssueLinkRoutesChanged();
    expect(routes.value).toEqual([]);
    await vi.waitFor(() => expect(routes.value[0]?.connectionId).toBe("new"));
    expect(api.listJiraConnections).toHaveBeenCalledTimes(2);
  });
});
