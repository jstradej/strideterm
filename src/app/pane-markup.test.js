import { describe, expect, test } from "vitest";
import { JSDOM } from "jsdom";
import { render } from "lit";
import { renderDockerMarkup, renderGitMarkup } from "./pane-markup.js";

function parseMarkup(markup) {
  const dom = new JSDOM("<body></body>");
  const { document } = dom.window;
  const container = document.createElement("div");
  document.body.append(container);
  if (typeof markup === "string") {
    container.innerHTML = markup;
  } else {
    render(markup, container);
  }
  return container;
}

function serializeMarkup(element) {
  return element.innerHTML.replace(/<!--.*?-->/gs, "");
}

function createSnapshot(overrides = {}) {
  return {
    available: true,
    repository: "demo",
    root: "/repo",
    branch: "feature-x",
    commitCount: 3,
    dirty: false,
    dirtyCount: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    diffStat: { files: 0, insertions: 0, deletions: 0, renames: 0, deletes: 0 },
    log: [],
    lazygit: { available: false, backend: null, error: "", launch: null },
    isMainWorktree: true,
    worktreePath: "/repo",
    mainWorktreePath: "/repo",
    siblingWorktrees: [],
    upstream: "",
    baseBranch: "",
    aheadCount: 0,
    behindCount: 0,
    compareWithBase: {
      baseBranch: "",
      aheadCount: 0,
      behindCount: 0,
      commits: [],
      files: [],
      diffStat: { files: 0, insertions: 0, deletions: 0, renames: 0, deletes: 0 },
    },
    lastFetchAt: null,
    operationState: {
      kind: "idle",
      inProgress: false,
      label: "",
      details: "",
      conflicts: [],
      canContinue: false,
      canAbort: false,
    },
    ...overrides,
  };
}

function createDockerState(overrides = {}) {
  return {
    available: true,
    contexts: [{ Name: "default", Current: "*", DockerEndpoint: "unix:///var/run/docker.sock" }],
    containers: [],
    lazydocker: { available: false },
    ...overrides,
  };
}

describe("renderGitMarkup", () => {
  test("renders tab navigation with status tab active by default", () => {
    const markup = renderGitMarkup(createSnapshot(), "workspace-1", {}, []);
    const document = parseMarkup(markup);
    const html = serializeMarkup(document);

    expect(html).toContain("git-tabs__item--active");
    expect(html).toContain('data-tab="status"');
    expect(html).toContain('data-tab="changes"');
    expect(html).toContain('data-tab="history"');
    expect(html).toContain('data-tab="worktrees"');
    expect(document.querySelector('.git-tabs[role="tablist"]')).not.toBeNull();
    expect(document.querySelector('.git-tabs__item[type="button"]')).not.toBeNull();
    expect(document.querySelector('[role="tabpanel"]')).not.toBeNull();
  });

  test("shows branch sync card on status tab with no-base-branch state", () => {
    const markup = renderGitMarkup(createSnapshot(), "workspace-1", { activeTab: "status" }, []);
    const html = serializeMarkup(parseMarkup(markup));

    expect(html).toContain("Base branch (local):</strong> not detected");
    expect(html).toContain("Base branch could not be detected automatically");
    expect(html).toContain("Merge Back");
    expect(html).toContain("Base branch was not detected.");
  });

  test("renders pending action confirmation banner on status tab", () => {
    const gitUi = {
      activeTab: "status",
      pendingAction: {
        type: "merge",
        baseBranch: "main",
        stashDirty: false,
        message: "Merge main into feature-x?",
      },
    };
    const markup = renderGitMarkup(createSnapshot({ baseBranch: "main" }), "workspace-1", gitUi, []);
    const html = serializeMarkup(parseMarkup(markup));

    expect(html).toContain("Confirm action");
    expect(html).toContain("Merge main into feature-x?");
    expect(html).toContain('data-action="git-confirm-action"');
    expect(html).toContain('data-action="git-cancel-action"');
  });

  test("renders changes tab with file lists and diff preview area", () => {
    const markup = renderGitMarkup(createSnapshot({
      dirty: true,
      dirtyCount: 1,
      untracked: [{ path: "docs/readme.md", code: "??" }],
      diffStat: { files: 1, insertions: 3, deletions: 0, renames: 0, deletes: 0 },
    }), "workspace-1", { activeTab: "changes" }, []);
    const html = serializeMarkup(parseMarkup(markup));

    expect(html).toContain('data-scope="untracked"');
    expect(html).toContain("docs/readme.md");
    expect(html).toContain("Diff Preview");
    expect(html).toContain("Select a file");
  });

  test("renders worktrees tab with repository context", () => {
    const markup = renderGitMarkup(createSnapshot(), "workspace-1", { activeTab: "worktrees" }, []);
    const html = serializeMarkup(parseMarkup(markup));

    expect(html).toContain("Worktree Context");
    expect(html).toContain("/repo");
  });

  test("shows dirty count badge on changes tab", () => {
    const markup = renderGitMarkup(createSnapshot({ dirty: true, dirtyCount: 5 }), "workspace-1", {}, []);
    const html = serializeMarkup(parseMarkup(markup));

    expect(html).toContain("git-tabs__badge");
    expect(html).toContain("5");
  });

  test("renders overlap warning as details instead of a long inline sentence", () => {
    const markup = renderGitMarkup(createSnapshot({
      dirty: true,
      staged: [{ path: "electron/backend/runtime.js", code: "M" }],
      unstaged: [{ path: "electron/backend/git-manager.js", code: "M" }],
      compareWithBase: {
        baseBranch: "master",
        aheadCount: 0,
        behindCount: 0,
        commits: [],
        files: [],
        diffStat: { files: 0, insertions: 0, deletions: 0, renames: 0, deletes: 0 },
        baseChangedFiles: [
          "electron/backend/runtime.js",
          "electron/backend/git-manager.js",
          "electron/backend/ipc.js",
        ],
      },
    }), "workspace-1", { activeTab: "status" }, []);
    const document = parseMarkup(markup);
    const html = serializeMarkup(document);

    expect(html).toContain("Conflict risk:");
    expect(html).toContain("Show overlapping files");
    expect(html).not.toContain("Conflicts are likely when merging.");
    expect(document.querySelector(".git-details .git-file-list")).not.toBeNull();
  });

  test("renders file actions as safe buttons", () => {
    const markup = renderGitMarkup(createSnapshot({
      dirty: true,
      dirtyCount: 1,
      untracked: [{ path: "docs/readme.md", code: "??" }],
    }), "workspace-1", { activeTab: "changes" }, []);
    const document = parseMarkup(markup);

    const fileButton = document.querySelector('.git-file[data-action="git-select-diff"]');
    expect(fileButton?.getAttribute("type")).toBe("button");
  });
});

describe("renderDockerMarkup", () => {
  test("renders docker cards inside a list with button actions", () => {
    const markup = renderDockerMarkup(createDockerState({
      lazydocker: { available: true },
      containers: [
        {
          ID: "abc123",
          Names: "web",
          Image: "nginx:latest",
          State: "running",
          Status: "Up 5 minutes",
          Ports: "80/tcp",
        },
      ],
    }));
    const document = parseMarkup(markup);

    expect(document.querySelector("section.docker-manager")).not.toBeNull();
    expect(document.querySelector("ul.docker-list > li > article.docker-card")).not.toBeNull();
    expect(document.querySelector('[data-action="open-lazydocker"]')?.getAttribute("type")).toBe("button");
    expect(document.querySelector('[data-action="docker-shell"]')?.getAttribute("type")).toBe("button");
    expect(document.querySelector('[data-action="docker-start"]')?.hasAttribute("disabled")).toBe(true);
  });
});
