import { describe, expect, test } from "vitest";
import { mount } from "@vue/test-utils";
import PrRow from "./PrRow.vue";

function mountRow(item: Record<string, unknown>, props: Record<string, unknown> = {}) {
  return mount(PrRow, { props: { item, ...props } });
}

async function expand(wrapper: ReturnType<typeof mountRow>) {
  await wrapper.find(".azure-pr-row__expand").trigger("click");
}

function fact(wrapper: ReturnType<typeof mountRow>, label: string): string | undefined {
  const dt = wrapper.findAll(".azure-pr-row__fact dt").find((el) => el.text() === label);
  return dt?.element.nextElementSibling?.textContent?.trim();
}

describe("PrRow — provider defaults to azure", () => {
  const azureItem = {
    prKey: "pr:1",
    role: "reviewer",
    hasAttention: true,
    attentionReason: "New comment",
    project: { name: "MyProject" },
    repository: { name: "myrepo" },
    author: { displayName: "Alice" },
    commentCount: 5,
    unresolvedThreadCount: 2,
    newCommentsCount: 1,
    latestCommentPreview: "Looks good overall",
    checks: { passedCount: 3, failedCount: 1, pendingCount: 0 },
    reviewerSummary: {
      reviewers: [{ vote: 10, isRequired: true }, { vote: -5 }, { vote: -10 }],
    },
    pullRequest: {
      id: 42,
      title: "Fix the thing",
      isDraft: true,
      status: "active",
      mergeStatus: "conflicts",
      description: "Some description",
      creationDate: "2026-01-01T00:00:00.000Z",
      sourceCommitId: "abcdef1234567890",
      sourceRefName: "refs/heads/feature",
      targetRefName: "refs/heads/main",
      webUrl: "https://dev.azure.com/pr/42",
    },
  };

  test("renders the Azure-shaped id, draft flag, and repo meta (project / repo)", () => {
    const wrapper = mountRow(azureItem);
    expect(wrapper.find(".azure-pr-row__id").text()).toBe("#42");
    expect(wrapper.text()).toContain("Draft");
    expect(wrapper.find(".azure-pr-row__meta").text()).toContain("MyProject / myrepo");
  });

  test("expanded view shows Status (not State), the 2-state merge label, and the unresolved-comment dimension", async () => {
    const wrapper = mountRow(azureItem);
    await expand(wrapper);

    expect(fact(wrapper, "Status")).toBe("active");
    expect(fact(wrapper, "State")).toBeUndefined();
    expect(fact(wrapper, "Merge")).toBe("Conflicts detected");
    expect(fact(wrapper, "Comments")).toBe("5 total · 2 unresolved · 1 new");
    expect(fact(wrapper, "Updated")).toBeUndefined();
  });

  test("reviewerLabel tallies raw vote codes (approved/waiting/rejected/required)", async () => {
    const wrapper = mountRow(azureItem);
    await expand(wrapper);
    expect(fact(wrapper, "Reviewers")).toBe("3 total · 1 required · 1 approved · 1 waiting · 1 rejected");
  });

  test("HEAD fact reads sourceCommitId, and the Azure-only latest-comment preview renders", async () => {
    const wrapper = mountRow(azureItem);
    await expand(wrapper);
    expect(fact(wrapper, "HEAD")).toBe("abcdef1");
    expect(wrapper.find(".azure-pr-row__comment-preview").text()).toContain("Looks good overall");
  });

  test("primary and browser buttons carry Azure-only tooltips", () => {
    const wrapper = mountRow(azureItem);
    const [primaryBtn, browserBtn] = wrapper.findAll(".azure-pr-row__actions button");
    expect(primaryBtn.attributes("title")).toBeTruthy();
    expect(browserBtn.attributes("title")).toBe("Open this pull request in your default browser.");
  });

  test("does not show GitHub-only reviewer-count badges", () => {
    const wrapper = mountRow({ ...azureItem, reviewerSummary: { approvedCount: 2, reviewers: [] } });
    expect(wrapper.text()).not.toContain("approved");
  });

  test("clicking browser emits the legacy .url fallback when webUrl is missing", async () => {
    const wrapper = mountRow({
      ...azureItem,
      pullRequest: { ...azureItem.pullRequest, webUrl: "", url: "https://legacy/pr/42" },
    });
    await wrapper.findAll(".azure-pr-row__actions button")[1].trigger("click");
    expect(wrapper.emitted("browser")?.[0]).toEqual(["https://legacy/pr/42"]);
  });
});

describe("PrRow — provider=github", () => {
  const githubItem = {
    prKey: "pr:gh:1",
    role: "author",
    hasAttention: false,
    author: { login: "bob" },
    repository: { fullName: "acme/widgets" },
    commentCount: 4,
    newCommentsCount: 2,
    checks: { passedCount: 1, failedCount: 0, pendingCount: 1 },
    reviewerSummary: {
      reviewers: [{}, {}],
      approvedCount: 1,
      changesRequestedCount: 1,
      requestedCount: 1,
    },
    pullRequest: {
      number: 7,
      title: "Add widget",
      draft: false,
      state: "open",
      mergeableState: "dirty",
      body: "Adds a widget",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      headSha: "0123456789abcdef",
      webUrl: "https://github.com/acme/widgets/pull/7",
    },
  };

  test("renders the GitHub-shaped id and combined repo fullName", () => {
    const wrapper = mountRow(githubItem, { provider: "github" });
    expect(wrapper.find(".azure-pr-row__id").text()).toBe("#7");
    expect(wrapper.find(".azure-pr-row__meta").text()).toContain("acme/widgets");
  });

  test("shows inline approved/changes-requested badges from reviewerSummary counts", () => {
    const wrapper = mountRow(githubItem, { provider: "github" });
    expect(wrapper.text()).toContain("1 approved");
    expect(wrapper.text()).toContain("1 changes requested");
  });

  test("expanded view shows State (not Status), Created AND Updated, and the 5-state merge label", async () => {
    const wrapper = mountRow(githubItem, { provider: "github" });
    await expand(wrapper);

    expect(fact(wrapper, "State")).toBe("open");
    expect(fact(wrapper, "Status")).toBeUndefined();
    expect(fact(wrapper, "Created")).toBeTruthy();
    expect(fact(wrapper, "Updated")).toBeTruthy();
    expect(fact(wrapper, "Merge")).toBe("Conflicts detected");
  });

  test("commentLabel has no unresolved dimension", async () => {
    const wrapper = mountRow(githubItem, { provider: "github" });
    await expand(wrapper);
    expect(fact(wrapper, "Comments")).toBe("4 total · 2 new");
  });

  test("reviewerLabel trusts the pre-aggregated summary counts, not raw vote tallies", async () => {
    const wrapper = mountRow(githubItem, { provider: "github" });
    await expand(wrapper);
    expect(fact(wrapper, "Reviewers")).toBe("2 total · 1 approved · 1 changes requested · 1 requested");
  });

  test("HEAD fact reads headSha, and there is no Azure-only latest-comment preview", async () => {
    const wrapper = mountRow({ ...githubItem, latestCommentPreview: "should never show" }, { provider: "github" });
    await expand(wrapper);
    expect(fact(wrapper, "HEAD")).toBe("0123456");
    expect(wrapper.find(".azure-pr-row__comment-preview").exists()).toBe(false);
  });

  test("author name falls back to login when displayName is absent", () => {
    const wrapper = mountRow(githubItem, { provider: "github" });
    expect(wrapper.find(".azure-pr-row__meta").text()).toContain("bob");
  });

  test("primary and browser buttons carry no title tooltip", () => {
    const wrapper = mountRow(githubItem, { provider: "github" });
    const [primaryBtn, browserBtn] = wrapper.findAll(".azure-pr-row__actions button");
    expect(primaryBtn.attributes("title")).toBeUndefined();
    expect(browserBtn.attributes("title")).toBeUndefined();
  });

  test("draft flag also honors the legacy isDraft field", () => {
    const wrapper = mountRow({
      ...githubItem,
      pullRequest: { ...githubItem.pullRequest, draft: false, isDraft: true },
    }, { provider: "github" });
    expect(wrapper.text()).toContain("Draft");
  });
});

describe("PrRow — shared behavior across providers", () => {
  const baseItem = {
    prKey: "pr:1",
    role: "reviewer",
    hasAttention: true,
    pullRequest: { id: 1, title: "Something", sourceRefName: "refs/heads/a", targetRefName: "refs/heads/b" },
  };

  test("showSeen=false hides the Seen button", () => {
    const wrapper = mountRow(baseItem, { showSeen: false });
    const buttons = wrapper.findAll(".azure-pr-row__actions button").map((b) => b.text());
    expect(buttons).not.toContain("Seen");
  });

  test("seen only emits when the PR has attention", async () => {
    const wrapperNoAttention = mountRow({ ...baseItem, hasAttention: false });
    const seenBtn = wrapperNoAttention.findAll(".azure-pr-row__actions button").find((b) => b.text() === "Seen")!;
    await seenBtn.trigger("click");
    expect(wrapperNoAttention.emitted("seen")).toBeUndefined();

    const wrapperWithAttention = mountRow({ ...baseItem, hasAttention: true });
    const seenBtn2 = wrapperWithAttention.findAll(".azure-pr-row__actions button").find((b) => b.text() === "Seen")!;
    await seenBtn2.trigger("click");
    expect(wrapperWithAttention.emitted("seen")?.[0]).toEqual(["pr:1"]);
  });

  test("opening=true disables the primary action and shows 'Opening…'", () => {
    const wrapper = mountRow(baseItem, { opening: true });
    const primaryBtn = wrapper.findAll(".azure-pr-row__actions button")[0];
    expect(primaryBtn.attributes("disabled")).toBeDefined();
    expect(primaryBtn.text()).toBe("Opening…");
  });

  test("clicking the primary action emits open with the prKey and resolved workspace id", async () => {
    const wrapper = mountRow({
      ...baseItem,
      role: "author",
      existingWorkspaceId: "ws-42",
      reviewWorkspaceId: "",
    });
    await wrapper.findAll(".azure-pr-row__actions button")[0].trigger("click");
    expect(wrapper.emitted("open")?.[0]).toEqual([{ prKey: "pr:1", workspaceId: "ws-42" }]);
  });

  test("expand toggle reveals and hides the details block", async () => {
    const wrapper = mountRow(baseItem);
    expect(wrapper.find(".azure-pr-row__details").exists()).toBe(false);
    await expand(wrapper);
    expect(wrapper.find(".azure-pr-row__details").exists()).toBe(true);
    await expand(wrapper);
    expect(wrapper.find(".azure-pr-row__details").exists()).toBe(false);
  });
});
