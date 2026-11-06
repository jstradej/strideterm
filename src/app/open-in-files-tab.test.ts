import { beforeEach, describe, expect, test, vi } from "vitest";
import { openPathInFilesTab } from "./open-in-files-tab.js";

const mocks = vi.hoisted(() => ({
  workspaces: [] as Array<Record<string, unknown>>,
  activateView: vi.fn(async () => {}),
  init: vi.fn(async () => {}),
  openFileAbsPath: vi.fn(async () => true),
}));
vi.mock("../stores/app.js", () => ({
  useAppStore: () => ({
    payload: { appState: { workspaces: mocks.workspaces } },
    activateView: mocks.activateView,
  }),
}));
vi.mock("../stores/file-manager.js", () => ({
  useFileManagerStore: () => ({ init: mocks.init, openFileAbsPath: mocks.openFileAbsPath }),
}));

describe("openPathInFilesTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.openFileAbsPath.mockResolvedValue(true);
    mocks.workspaces = [
      {
        id: "ws-files",
        cwd: "C:/work/fix",
        panels: [
          { id: "p1", command: "claude" },
          { id: "p2", command: "__files__" },
        ],
      },
      { id: "ws-bare", cwd: "C:/work/bare", panels: [{ id: "p3", command: "claude" }] },
    ];
  });

  test("an unknown workspace id touches nothing", async () => {
    expect(await openPathInFilesTab("nope", "C:/x")).toBe("no-workspace");
    expect(mocks.activateView).not.toHaveBeenCalled();
  });

  test("a workspace without a Files tab is reported", async () => {
    expect(await openPathInFilesTab("ws-bare", "C:/work/bare/a")).toBe("no-files-tab");
    expect(mocks.activateView).not.toHaveBeenCalled();
  });

  test("opens the path in the Files tab of the named workspace", async () => {
    expect(await openPathInFilesTab("ws-files", "C:/work/fix/a.md")).toBe("opened");
    expect(mocks.activateView).toHaveBeenCalledWith("files:p2");
    expect(mocks.init).toHaveBeenCalledWith("C:/work/fix");
    expect(mocks.openFileAbsPath).toHaveBeenCalledWith("C:/work/fix/a.md");
  });

  test("a path the Files pane cannot show is reported as outside", async () => {
    mocks.openFileAbsPath.mockResolvedValue(false);
    expect(await openPathInFilesTab("ws-files", "D:/elsewhere")).toBe("outside");
  });
});
