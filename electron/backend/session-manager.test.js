import { beforeEach, describe, expect, test, vi } from "vitest";

const handles = [];

class FakePtyHandle {
  constructor() {
    this.dataHandlers = [];
    this.exitHandlers = [];
  }

  onData(handler) {
    this.dataHandlers.push(handler);
  }

  onExit(handler) {
    this.exitHandlers.push(handler);
  }

  resize() {}

  write() {}

  kill(exitCode = 0) {
    queueMicrotask(() => {
      this.exitHandlers.forEach((handler) => handler({ exitCode }));
    });
  }
}

vi.mock("node-pty", () => ({
  default: {
    spawn: vi.fn(() => {
      const handle = new FakePtyHandle();
      handles.push(handle);
      return handle;
    }),
  },
}));

import { SessionManager } from "./session-manager.js";

function createState() {
  return {
    activeWorkspaceId: "workspace-a",
    workspaces: [
      {
        id: "workspace-a",
        cwd: "/home/user/workspace",
        activePanelId: "shell",
        panels: [
          {
            id: "shell",
            title: "Shell",
            command: "",
            startup: "default",
          },
        ],
      },
    ],
  };
}

describe("SessionManager", () => {
  beforeEach(() => {
    handles.length = 0;
  });

  test("hard restart spawns a fresh session and marks old exit as intentional", async () => {
    const manager = new SessionManager();
    const exits = [];
    manager.on("terminal:exit", (payload) => exits.push(payload));

    manager.ensureSession(createState(), "workspace-a:shell");
    const restarted = await manager.restartSession(createState(), "workspace-a:shell");

    expect(exits).toHaveLength(1);
    expect(exits[0]).toMatchObject({
      sessionId: "workspace-a:shell",
      intentional: true,
    });
    expect(handles).toHaveLength(2);
    expect(restarted.status).toBe("running");
    expect(manager.sessions.get("workspace-a:shell")?.status).toBe("running");
  });

  test("marks unexpected exits as non-intentional", () => {
    const manager = new SessionManager();
    const exits = [];
    manager.on("terminal:exit", (payload) => exits.push(payload));

    manager.ensureSession(createState(), "workspace-a:shell");
    handles[0].kill(7);
    return new Promise((resolve) => queueMicrotask(resolve)).then(() => {
      expect(exits).toHaveLength(1);
      expect(exits[0]).toMatchObject({
        sessionId: "workspace-a:shell",
        exitCode: 7,
        intentional: false,
      });
    });
  });
});
