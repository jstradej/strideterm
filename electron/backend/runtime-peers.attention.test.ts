import { describe, expect, it } from "vitest";
import { defaultPeerSettings } from "../shared/peers.js";
import { createRuntimePeers } from "./runtime-peers.js";

function makePeers() {
  const state = {
    settings: { integrations: { peers: defaultPeerSettings() } },
    peerWindows: [],
    profiles: [
      { id: "home", name: "Home Secret Name", color: "#fff" },
      { id: "work", name: "Work", color: "#000" },
      { id: "quiet", name: "Quiet", color: "#111" },
    ],
    workspaces: [
      { id: "ws-home", name: "Private repo name", profileId: "home" },
      { id: "ws-work-1", name: "Work one", profileId: "work" },
      { id: "ws-work-2", name: "Work two", profileId: "work" },
    ],
    windowSlots: [],
  };
  const peers = createRuntimePeers({
    getState: () => state as never,
    mutate: async () => undefined,
    credentials: {} as never,
    appVersion: "1.0.0",
    emit: () => undefined,
    getInstallationNoteRevision: () => 7,
    getAttentionPayload: () => ({
      appState: { workspaces: state.workspaces },
      attention: {
        byWorkspace: {
          "ws-home": { alerts: [{ kind: "agent_done", title: "secret alert text" } as { kind: string }] },
          "ws-work-1": { alerts: [{ kind: "agent_done" }, { kind: "agent_needs_input" }] },
          "ws-work-2": { alerts: [{ kind: "agent_done" }] },
        },
      },
    }),
  });
  return peers;
}

describe("runtime peers: attention for an attached desktop", () => {
  it("counts per profile with the desktop's own counting, leaves quiet profiles out, and carries no text", () => {
    const peers = makePeers();
    const summary = peers.attention();
    expect(summary).toEqual({
      total: 4,
      profiles: [
        { profileId: "home", count: 1 },
        { profileId: "work", count: 3 },
      ],
      globalNoteRevision: 7,
    });
    const text = JSON.stringify(summary);
    for (const leaked of ["secret", "Private", "Work one", "Home Secret Name"]) expect(text).not.toContain(leaked);
    peers.dispose();
  });

  it("starts with no polled host and stops its timer on dispose", async () => {
    const peers = makePeers();
    await peers.start();
    expect(peers.getPeerHostAttention()).toEqual([]);
    peers.dispose();
  });
});
