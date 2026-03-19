import { describe, expect, test } from "vitest";
import { render } from "lit";
import { renderAzureReviewView } from "./azure-devops-view.js";

function renderTemplate(template) {
  const container = document.createElement("div");
  render(template, container);
  return container;
}

describe("renderAzureReviewView", () => {
  test("shows failed checks on summary tab with enhanced details", () => {
    const container = renderTemplate(renderAzureReviewView({
      prKey: "ado:repo:123",
      project: { name: "MSP_MHUB" },
      repository: { name: "mhub" },
      role: "reviewer",
      author: { displayName: "Veselka, Jan 3 (Green:Code s.r.o.)" },
      pullRequest: {
        id: 29130,
        title: "[MSP-81823] status codes updated",
        description: "Body",
        sourceRefName: "refs/heads/feature/test",
        targetRefName: "refs/heads/develop",
        webUrl: "https://dev.azure.com/example/pr/29130",
        creationDate: "2026-03-17T08:00:00.000Z",
        mergeStatus: "succeeded",
      },
      checks: {
        failedCount: 1,
        pendingCount: 0,
        passedCount: 0,
        optionalFailedCount: 1,
        requiredFailedCount: 0,
        items: [
          {
            id: "policy:1",
            name: "MHUB JUnit Tests",
            description: "JFrog gradle and Sonar analyze build and publish / JFrog Maven",
            state: "failed",
            stateLabel: "failed",
            optional: true,
            source: "Build",
            url: "https://dev.azure.com/example/build/1",
            errorMessage: "Error: Command failed: mvn clean install",
            buildInfo: "mhub-snapshot #20260313.8",
          },
        ],
      },
      reviewerSummary: {
        totalCount: 1,
        reviewers: [{ displayName: "Reviewer", vote: 0 }],
      },
      changedFiles: [{ path: "/src/auth.js", changeType: "edit" }],
      threads: [],
    }, "workspace-1", {
      comments: [{ commentKey: "task-1", commentKind: "local-comment", payload: { questionBody: "test" } }],
      drafts: [],
      syncQueue: [],
    }, {
      activeReviewTab: "summary",
    }));

    expect(container.textContent).toContain("failed checks");
    expect(container.textContent).toContain("MHUB JUnit Tests");
    expect(container.querySelector('[data-action="open-azure-browser"][data-url="https://dev.azure.com/example/build/1"]')).not.toBeNull();
  });

  test("renders new tab structure: Summary, Files, Comments, Conflicts, Agent", () => {
    const container = renderTemplate(renderAzureReviewView({
      prKey: "ado:repo:456",
      project: { name: "TestProject" },
      repository: { name: "repo" },
      role: "reviewer",
      pullRequest: {
        id: 100,
        title: "Test PR",
        description: "Test",
        sourceRefName: "refs/heads/feature",
        targetRefName: "refs/heads/main",
        mergeStatus: "succeeded",
        creationDate: "2026-03-15T10:00:00.000Z",
      },
      reviewerSummary: { totalCount: 0, reviewers: [] },
      changedFiles: [{ path: "file.txt", changeType: "edit" }],
      threads: [{ id: 1, status: "active", comments: [{ id: 1, content: "Fix this", author: { displayName: "Author" } }] }],
    }, "ws-1", { comments: [], drafts: [], syncQueue: [] }, { activeReviewTab: "summary" }));

    const tabs = container.querySelectorAll("[data-action='review-switch-tab']");
    const tabLabels = [...tabs].map((t) => t.dataset.tab);
    expect(tabLabels).toEqual(["summary", "files", "comments", "conflicts", "agent"]);
  });

  test("summary tab shows creation date and wait time", () => {
    const container = renderTemplate(renderAzureReviewView({
      prKey: "ado:repo:789",
      project: { name: "P" },
      repository: { name: "R" },
      role: "reviewer",
      author: { displayName: "Test Author" },
      pullRequest: {
        id: 200,
        title: "Date PR",
        description: "",
        sourceRefName: "refs/heads/a",
        targetRefName: "refs/heads/b",
        creationDate: "2026-03-10T08:00:00.000Z",
      },
      reviewerSummary: { totalCount: 0, reviewers: [] },
      changedFiles: [],
      threads: [],
    }, "ws-2", { comments: [], drafts: [], syncQueue: [] }, { activeReviewTab: "summary" }));

    expect(container.textContent).toContain("Created:");
    expect(container.textContent).toContain("Waiting:");
    expect(container.textContent).toContain("Test Author");
  });

  test("comments tab merges threads and local tasks", () => {
    const container = renderTemplate(renderAzureReviewView({
      prKey: "ado:repo:101",
      project: { name: "P" },
      repository: { name: "R" },
      role: "reviewer",
      pullRequest: { id: 300, title: "Comment PR", sourceRefName: "refs/heads/a", targetRefName: "refs/heads/b" },
      reviewerSummary: { totalCount: 0, reviewers: [] },
      changedFiles: [],
      threads: [
        { id: 1, status: "active", filePath: "src/app.js", lineStart: 10, lineEnd: 15, comments: [{ id: 1, content: "Fix null check", author: { displayName: "Alice" } }] },
        { id: 2, status: "fixed", comments: [{ id: 2, content: "Looks good", author: { displayName: "Bob" } }] },
      ],
    }, "ws-3", {
      comments: [{ commentKey: "local-1", commentKind: "local-comment", title: "My note", summary: "A note", payload: { questionBody: "What about X?" } }],
      drafts: [],
      syncQueue: [],
    }, { activeReviewTab: "comments" }));

    expect(container.textContent).toContain("3 conversations");
    expect(container.textContent).toContain("Fix null check");
    expect(container.textContent).toContain("Alice");
    expect(container.textContent).toContain("src/app.js");
    expect(container.textContent).toContain("Local comments");
    expect(container.textContent).toContain("What about X?");
  });

  test("conflicts tab shows merge status", () => {
    const container = renderTemplate(renderAzureReviewView({
      prKey: "ado:repo:102",
      project: { name: "P" },
      repository: { name: "R" },
      role: "reviewer",
      pullRequest: { id: 400, title: "Conflict PR", sourceRefName: "refs/heads/a", targetRefName: "refs/heads/b", mergeStatus: "conflicts" },
      reviewerSummary: { totalCount: 0, reviewers: [] },
      changedFiles: [],
      threads: [],
    }, "ws-4", { comments: [], drafts: [], syncQueue: [] }, { activeReviewTab: "conflicts" }));

    expect(container.textContent).toContain("Merge conflicts detected");
    expect(container.textContent).toContain("Resolve conflicts");
  });

  test("agent tab has English prompts with copy buttons", () => {
    const container = renderTemplate(renderAzureReviewView({
      prKey: "ado:repo:103",
      project: { name: "P" },
      repository: { name: "R" },
      role: "reviewer",
      pullRequest: { id: 500, title: "Agent PR", sourceRefName: "refs/heads/a", targetRefName: "refs/heads/b" },
      reviewerSummary: { totalCount: 0, reviewers: [] },
      changedFiles: [],
      threads: [],
    }, "ws-5", {
      comments: [], drafts: [], syncQueue: [],
      agentPrompts: [
        { promptId: "full-review", title: "Full code review", description: "Comprehensive review", template: "Review this PR", sortOrder: 0 },
        { promptId: "quick-summary", title: "Quick summary", description: "Overview", template: "Summarize changes", sortOrder: 1 },
        { promptId: "write-comment", title: "Write a review comment", description: "Targeted comment", template: "Write comment about...", sortOrder: 2 },
      ],
    }, { activeReviewTab: "agent" }));

    expect(container.textContent).toContain("Full code review");
    expect(container.textContent).toContain("Quick summary");
    expect(container.textContent).toContain("Write a review comment");
    const copyButtons = container.querySelectorAll('[data-action="copy-text"]');
    expect(copyButtons.length).toBeGreaterThan(0);
    const editButtons = container.querySelectorAll('[data-action="edit-agent-prompt"]');
    expect(editButtons.length).toBe(3);
  });

  test("files tab shows file list", () => {
    const container = renderTemplate(renderAzureReviewView({
      prKey: "ado:repo:104",
      project: { name: "P" },
      repository: { name: "R" },
      role: "reviewer",
      pullRequest: { id: 600, title: "Files PR", sourceRefName: "refs/heads/a", targetRefName: "refs/heads/b" },
      reviewerSummary: { totalCount: 0, reviewers: [] },
      changedFiles: [
        { path: "src/main/config.properties", changeType: "edit" },
        { path: "src/test/Setup.java", changeType: "add" },
      ],
      threads: [],
    }, "ws-6", { comments: [], drafts: [], syncQueue: [] }, { activeReviewTab: "files" }));

    expect(container.textContent).toContain("2 files");
    expect(container.textContent).toContain("config.properties");
    expect(container.textContent).toContain("Setup.java");
    expect(container.textContent).toContain("Click on a file");
    const diffButtons = container.querySelectorAll('[data-action="review-select-file-diff"]');
    expect(diffButtons.length).toBe(2);
  });
});
