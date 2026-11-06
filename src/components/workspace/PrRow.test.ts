import { afterEach, describe, expect, test, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import PrRow from "./PrRow.vue";
import { shortPersonName, splitTicketPrefix } from "./prRowFormat.js";

function mountRow(item: Record<string, unknown>, props: Record<string, unknown> = {}) {
  // The hover card is teleported to <body>; the stub keeps it inside the wrapper.
  return mount(PrRow, { props: { item, ...props }, global: { stubs: { teleport: true } } });
}

/** Rest the mouse on the row's information columns until the hover card opens. */
async function hover(wrapper: ReturnType<typeof mountRow>, pointerType = "mouse") {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await wrapper.get(".azure-pr-row__info").trigger("pointerenter", { pointerType });
  vi.advanceTimersByTime(400);
  await nextTick();
  return wrapper.find(".azure-pr-hovercard");
}

async function expand(wrapper: ReturnType<typeof mountRow>) {
  await wrapper.find(".azure-pr-row__expand").trigger("click");
}

function fact(wrapper: ReturnType<typeof mountRow>, label: string): string | undefined {
  const dt = wrapper.findAll(".azure-pr-row__fact dt").find((el) => el.text() === label);
  return dt?.element.nextElementSibling?.textContent?.trim();
}

function actionButtons(wrapper: ReturnType<typeof mountRow>) {
  return wrapper.findAll(".azure-pr-row__actions button");
}

afterEach(() => vi.useRealTimers());

describe("PrRow — provider defaults to azure", () => {
  const azureItem = {
    prKey: "pr:1",
    role: "reviewer",
    hasAttention: true,
    attentionReason: "New comment",
    myReviewerId: "me",
    project: { name: "MyProject" },
    repository: { name: "myrepo" },
    author: { displayName: "Alice" },
    commentCount: 5,
    unresolvedThreadCount: 2,
    newCommentsCount: 1,
    latestCommentPreview: "Looks good overall",
    checks: { passedCount: 3, failedCount: 1, pendingCount: 0 },
    lastSeenActivityAt: "2026-01-01T00:00:00.000Z",
    lastRemoteActivityAt: "2026-01-02T00:00:00.000Z",
    lastActivityAt: "2026-01-02T00:00:00.000Z",
    reviewerSummary: {
      reviewers: [
        { id: "a", displayName: "Ann Approver", vote: 10, isRequired: true },
        { id: "me", displayName: "Me Myself", vote: 0 },
        { id: "w", displayName: "Wendy Waiter", vote: -5 },
        { id: "r", displayName: "Rob Rejecter", vote: -10 },
        { id: "g", displayName: "Core Team", vote: 0, isContainer: true },
      ],
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

  test("renders the Azure-shaped id and draft flag without a role chip; the branch is left to the details", async () => {
    const wrapper = mountRow(azureItem);
    expect(wrapper.find(".azure-pr-row__id").text()).toBe("#42");
    expect(wrapper.find(".azure-pr-row__chip--draft").text()).toBe("Draft");
    expect(wrapper.get(".azure-pr-row__line").text()).not.toContain("feature → main");
    expect(wrapper.get(".azure-pr-row__line").text()).not.toContain("reviewer");
    await expand(wrapper);
    expect(fact(wrapper, "Branch")).toBe("feature → main");
  });

  test("the repository column is shown only when asked to, by name, with the project in the hover card", async () => {
    expect(mountRow(azureItem).find(".azure-pr-row__repo").exists()).toBe(false);
    const wrapper = mountRow(azureItem, { showRepo: true });
    expect(wrapper.classes()).toContain("azure-pr-row--with-repo");
    const repo = wrapper.get(".azure-pr-row__repo");
    expect(repo.text()).toBe("myrepo");
    expect(repo.attributes("aria-label")).toBe("Repository MyProject / myrepo");
    const card = await hover(wrapper);
    expect(card.get(".azure-pr-hovercard__repo").text()).toBe("MyProject / myrepo");
  });

  test("the row drops the organisation suffix of a name; the hover card keeps the full one", async () => {
    const wrapper = mountRow({ ...azureItem, author: { displayName: "Doe, Jane (Acme Ltd.)" } });
    expect(wrapper.get(".azure-pr-row__author").text()).toBe("Doe, Jane");
    await hover(wrapper);
    expect(fact(wrapper, "Author")).toBe("Doe, Jane (Acme Ltd.)");
  });

  test("leading ticket keys are muted so the rest of the title stands out", () => {
    const title = "ABC-91511 ABC-91974 | CORE | Spring Boot 4.1.2";
    const wrapper = mountRow({ ...azureItem, pullRequest: { ...azureItem.pullRequest, title } });
    expect(wrapper.get(".azure-pr-row__keys").text()).toBe("ABC-91511 ABC-91974 |");
    expect(wrapper.get(".azure-pr-row__name").text()).toBe(`Unread: ${title}`);
    expect(mountRow(azureItem).find(".azure-pr-row__keys").exists()).toBe(false);
  });

  test("the author is You on the user's own PR and the display name otherwise", () => {
    expect(mountRow(azureItem).find(".azure-pr-row__author").text()).toBe("Alice");
    const own = mountRow({ ...azureItem, role: "author" });
    expect(own.find(".azure-pr-row__author").text()).toBe("You");
    expect(own.find(".azure-pr-row__author--you").exists()).toBe(true);
  });

  test("unread title: bold with a screen-reader prefix; read title has neither", () => {
    const unread = mountRow(azureItem);
    expect(unread.classes()).toContain("azure-pr-row--unread");
    expect(unread.find(".azure-pr-row__name .azure-pr-row__sr").text()).toBe("Unread:");

    const read = mountRow({ ...azureItem, lastSeenActivityAt: "2026-01-02T00:00:00.000Z" });
    expect(read.classes()).not.toContain("azure-pr-row--unread");
    expect(read.find(".azure-pr-row__sr").exists()).toBe(false);
  });

  test("a PR that was never opened counts as unread", () => {
    const wrapper = mountRow({ ...azureItem, lastSeenActivityAt: null });
    expect(wrapper.classes()).toContain("azure-pr-row--unread");
  });

  test("a PR with no activity for 30 days is muted", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-15T00:00:00.000Z"));
    expect(mountRow(azureItem).classes()).toContain("azure-pr-row--old");
    vi.setSystemTime(new Date("2026-01-10T00:00:00.000Z"));
    expect(mountRow(azureItem).classes()).not.toContain("azure-pr-row--old");
  });

  test("attention chip reads N new comments, else the capitalised reason", () => {
    expect(mountRow(azureItem).find(".azure-pr-row__chip--attention").text()).toBe("1 new comment");
    expect(
      mountRow({ ...azureItem, newCommentsCount: 3 })
        .find(".azure-pr-row__chip--attention")
        .text(),
    ).toBe("3 new comments");
    expect(
      mountRow({ ...azureItem, newCommentsCount: 0, attentionReason: "new push after your vote" })
        .find(".azure-pr-row__chip--attention")
        .text(),
    ).toBe("New push after your vote");
    expect(
      mountRow({ ...azureItem, hasAttention: false })
        .find(".azure-pr-row__chip--attention")
        .exists(),
    ).toBe(false);
  });

  test("reviewer avatars in the hover card: initials, vote state, group shape and the you-ring", async () => {
    const wrapper = mountRow(azureItem);
    expect(wrapper.find(".azure-avatar").exists()).toBe(false);
    const avatars = (await hover(wrapper)).findAll(".azure-avatar");
    expect(avatars.map((a) => a.text())).toEqual(["AA", "MM", "WW", "RR", "CT"]);
    expect(avatars.map((a) => a.attributes("aria-label"))).toEqual([
      "Ann Approver: Approved · required",
      "Me Myself (you): No vote yet",
      "Wendy Waiter: Waiting for author",
      "Rob Rejecter: Rejected",
      "Core Team: No vote yet",
    ]);
    expect(avatars.map((a) => a.find(".azure-avatar__badge").classes()[1])).toEqual([
      "azure-avatar__badge--approved",
      "azure-avatar__badge--none",
      "azure-avatar__badge--waiting",
      "azure-avatar__badge--rejected",
      "azure-avatar__badge--none",
    ]);
    expect(avatars.map((a) => a.classes().includes("azure-avatar--ring"))).toEqual([false, true, false, false, false]);
    expect(avatars.map((a) => a.classes().includes("azure-avatar--group"))).toEqual([false, false, false, false, true]);
  });

  test("comments show the total with the full tally in their name, conflicts get a flag", () => {
    const wrapper = mountRow(azureItem);
    expect(wrapper.find(".azure-pr-row__comments").text()).toBe("5");
    expect(wrapper.find(".azure-pr-row__comments").attributes("aria-label")).toBe(
      "Comments: 5 total · 2 unresolved · 1 new",
    );
    expect(wrapper.find(".azure-pr-row__conflicts").text()).toBe("Conflicts");
    const clean = mountRow({
      ...azureItem,
      commentCount: 0,
      pullRequest: { ...azureItem.pullRequest, mergeStatus: "" },
    });
    expect(clean.find(".azure-pr-row__comments").exists()).toBe(false);
    expect(clean.find(".azure-pr-row__conflicts").exists()).toBe(false);
  });

  test("last activity age is coloured by recency and 'opened' is in the hover card", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-02T05:00:00.000Z"));
    const fresh = mountRow(azureItem);
    expect(fresh.find(".azure-pr-row__age").text()).toBe("5h ago");
    expect(fresh.find(".azure-pr-row__age--fresh").exists()).toBe(true);
    await fresh.get(".azure-pr-row__info").trigger("pointerenter", { pointerType: "mouse" });
    vi.advanceTimersByTime(400);
    await nextTick();
    expect(fact(fresh, "Opened")).toMatch(/^1d ago · /);

    vi.setSystemTime(new Date("2026-01-12T00:00:00.000Z"));
    expect(mountRow(azureItem).find(".azure-pr-row__age--aging").exists()).toBe(true);
  });

  test("omits missing and invalid timestamps", async () => {
    const wrapper = mountRow({
      ...azureItem,
      lastActivityAt: "invalid-date",
      lastRemoteActivityAt: "invalid-date",
      pullRequest: { ...azureItem.pullRequest, creationDate: "invalid-date" },
    });
    expect(wrapper.get(".azure-pr-row__age").text()).toBe("");
    await hover(wrapper);
    expect(fact(wrapper, "Opened")).toBeUndefined();
    expect(fact(wrapper, "Last activity")).toBeUndefined();
  });

  test("expanded view: since-you-looked, reviewers and status columns", async () => {
    const wrapper = mountRow(azureItem);
    await expand(wrapper);

    expect(wrapper.find(".azure-pr-row__section h3").text()).toContain("Since you last looked");
    expect(wrapper.find(".azure-pr-row__section").text()).toContain("1 new comment");
    expect(wrapper.find(".azure-pr-row__description").text()).toBe("Some description");
    expect(wrapper.find(".azure-pr-row__comment-preview").text()).toContain("Looks good overall");

    const names = wrapper.findAll(".azure-pr-row__reviewer").map((r) => r.text());
    expect(names[0]).toContain("Ann Approver");
    expect(names[0]).toContain("required");
    expect(names[1]).toContain("Me Myself (you)");

    expect(fact(wrapper, "Merge")).toBe("Conflicts detected");
    expect(fact(wrapper, "Comments")).toBe("5 total · 2 unresolved · 1 new");
    expect(fact(wrapper, "Checks")).toBe("3 passed · 1 failed");
    expect(fact(wrapper, "Opened")).toBeTruthy();
    expect(fact(wrapper, "Last activity")).toBeTruthy();
    expect(fact(wrapper, "HEAD")).toBe("abcdef1");
  });

  test("nothing new and no description fall back to their placeholders", async () => {
    const wrapper = mountRow({
      ...azureItem,
      hasAttention: false,
      attentionReason: "",
      newCommentsCount: 0,
      latestCommentPreview: "",
      lastSeenActivityAt: null,
      pullRequest: { ...azureItem.pullRequest, description: "" },
    });
    await expand(wrapper);
    expect(wrapper.text()).toContain("Since you last looked · never opened");
    expect(wrapper.text()).toContain("Nothing new since then.");
    expect(wrapper.find(".azure-pr-row__description--empty").text()).toBe("No description provided.");
  });

  test("actions: a primary button with a title, an icon-only browser button and mark as read", () => {
    const wrapper = mountRow(azureItem);
    const [primaryBtn, browserBtn, readBtn] = actionButtons(wrapper);
    expect(primaryBtn.text()).toBe("Review");
    expect(primaryBtn.attributes("title")).toBeTruthy();
    expect(browserBtn.attributes("aria-label")).toBe("Open #42 in the browser");
    expect(browserBtn.attributes("title")).toBe("Open this pull request in your default browser.");
    expect(readBtn.attributes("aria-label")).toBe("Mark #42 as read");
  });

  test("clicking browser emits the legacy .url fallback when webUrl is missing", async () => {
    const wrapper = mountRow({
      ...azureItem,
      pullRequest: { ...azureItem.pullRequest, webUrl: "", url: "https://legacy/pr/42" },
    });
    await actionButtons(wrapper)[1].trigger("click");
    expect(wrapper.emitted("browser")?.[0]).toEqual(["https://legacy/pr/42"]);
  });

  test("does not show GitHub-only reviewer-count badges", () => {
    const wrapper = mountRow({ ...azureItem, reviewerSummary: { approvedCount: 2, reviewers: [] } });
    expect(wrapper.text()).not.toContain("approved");
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
    lastSeenActivityAt: "2026-01-02T00:00:00.000Z",
    lastRemoteActivityAt: "2026-01-02T00:00:00.000Z",
    lastActivityAt: "2026-01-02T00:00:00.000Z",
    checks: { passedCount: 1, failedCount: 0, pendingCount: 1 },
    reviewerSummary: {
      myIsRequested: true,
      reviewers: [
        { login: "carol", displayName: "Carol Reviewer", state: "approved" },
        { login: "me", displayName: "Me Myself", state: "pending" },
        { login: "dave", displayName: "Dave D", state: "changes_requested" },
        { login: "team:core", displayName: "Core Team", state: "pending", isTeam: true },
      ],
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
      sourceRefName: "feature",
      targetRefName: "main",
      webUrl: "https://github.com/acme/widgets/pull/7",
    },
  };

  test("renders the GitHub-shaped id, and the repository name with its owner in the accessible name", () => {
    const wrapper = mountRow(githubItem, { provider: "github", showRepo: true });
    expect(wrapper.find(".azure-pr-row__id").text()).toBe("#7");
    expect(wrapper.find(".azure-pr-row__repo").text()).toBe("widgets");
    expect(wrapper.find(".azure-pr-row__repo").attributes("aria-label")).toBe("Repository acme/widgets");
  });

  test("shows the GitHub login when displayName is absent", () => {
    const wrapper = mountRow({ ...githubItem, role: "reviewer" }, { provider: "github" });
    expect(wrapper.find(".azure-pr-row__author").text()).toBe("bob");
  });

  test("GitHub reviewers map review state to vote badges, teams to squares, and ring the pending current user", async () => {
    const wrapper = mountRow(githubItem, { provider: "github", currentUserLogin: "Me" });
    const avatars = (await hover(wrapper)).findAll(".azure-avatar");
    expect(avatars.map((a) => a.find(".azure-avatar__badge").classes()[1])).toEqual([
      "azure-avatar__badge--approved",
      "azure-avatar__badge--none",
      "azure-avatar__badge--rejected",
      "azure-avatar__badge--none",
    ]);
    expect(avatars.map((a) => a.classes().includes("azure-avatar--ring"))).toEqual([false, true, false, false]);
    expect(avatars[3].classes()).toContain("azure-avatar--group");
    expect(avatars[2].attributes("aria-label")).toBe("Dave D: Changes requested");
  });

  test("Conflicts is flagged from mergeableState", () => {
    expect(mountRow(githubItem, { provider: "github" }).find(".azure-pr-row__conflicts").exists()).toBe(true);
    const clean = mountRow(
      { ...githubItem, pullRequest: { ...githubItem.pullRequest, mergeableState: "clean" } },
      { provider: "github" },
    );
    expect(clean.find(".azure-pr-row__conflicts").exists()).toBe(false);
  });

  test("comments have no open-thread dimension", () => {
    const wrapper = mountRow(githubItem, { provider: "github" });
    expect(wrapper.find(".azure-pr-row__comments").text()).toBe("4");
    expect(wrapper.find(".azure-pr-row__comments").attributes("aria-label")).toBe("Comments: 4 total · 2 new");
  });

  test("expanded view shows the 5-state merge label, comment tally and HEAD, but no Azure-only preview", async () => {
    const wrapper = mountRow({ ...githubItem, latestCommentPreview: "should never show" }, { provider: "github" });
    await expand(wrapper);
    expect(fact(wrapper, "Merge")).toBe("Conflicts detected");
    expect(fact(wrapper, "Comments")).toBe("4 total · 2 new");
    expect(fact(wrapper, "Checks")).toBe("1 passed · 1 pending");
    expect(fact(wrapper, "HEAD")).toBe("0123456");
    expect(wrapper.find(".azure-pr-row__comment-preview").exists()).toBe(false);
    expect(wrapper.findAll(".azure-pr-row__reviewer")).toHaveLength(4);
  });

  test("every action button explains itself, same as on an Azure row", () => {
    const wrapper = mountRow(githubItem, { provider: "github" });
    for (const button of actionButtons(wrapper)) {
      expect(button.attributes("title")).toBeTruthy();
    }
  });

  test("draft flag also honors the legacy isDraft field", () => {
    const wrapper = mountRow(
      { ...githubItem, pullRequest: { ...githubItem.pullRequest, draft: false, isDraft: true } },
      { provider: "github" },
    );
    expect(wrapper.find(".azure-pr-row__chip--draft").exists()).toBe(true);
  });

  test("descriptionText falls back to the legacy `description` field when `body` is missing", async () => {
    const wrapper = mountRow(
      { ...githubItem, pullRequest: { ...githubItem.pullRequest, body: undefined, description: "Legacy text" } },
      { provider: "github" },
    );
    await expand(wrapper);
    expect(wrapper.find(".azure-pr-row__description").text()).toBe("Legacy text");
  });

  test("descriptionText prefers `body` over `description` when both are present, and trims whitespace", async () => {
    const wrapper = mountRow(
      { ...githubItem, pullRequest: { ...githubItem.pullRequest, body: "  Adds a widget  ", description: "Legacy" } },
      { provider: "github" },
    );
    await expand(wrapper);
    expect(wrapper.find(".azure-pr-row__description").text()).toBe("Adds a widget");
  });
});

describe("PrRow — shared behavior across providers", () => {
  const baseItem = {
    prKey: "pr:1",
    role: "reviewer",
    hasAttention: true,
    pullRequest: { id: 1, title: "Something", sourceRefName: "refs/heads/a", targetRefName: "refs/heads/b" },
  };

  test("mark as read emits seen for an unread PR", async () => {
    const wrapper = mountRow({ ...baseItem, hasAttention: false });
    const readBtn = actionButtons(wrapper).find((b) => b.attributes("aria-label") === "Mark #1 as read")!;
    expect(readBtn.attributes("disabled")).toBeUndefined();
    await readBtn.trigger("click");
    expect(wrapper.emitted("seen")?.[0]).toEqual(["pr:1"]);
  });

  test("mark as read keeps its slot but is inert when the PR is read and has no attention", async () => {
    const wrapper = mountRow({
      ...baseItem,
      hasAttention: false,
      lastSeenActivityAt: "2026-01-02T00:00:00.000Z",
      lastRemoteActivityAt: "2026-01-01T00:00:00.000Z",
    });
    const readBtn = actionButtons(wrapper).find((b) => b.attributes("aria-label") === "Mark #1 as read")!;
    expect(readBtn.classes()).toContain("azure-pr-row__btn--idle");
    expect(readBtn.attributes("disabled")).toBeDefined();
    await readBtn.trigger("click");
    expect(wrapper.emitted("seen")).toBeUndefined();
  });

  test("mark as read is available for an attention PR that was already read", async () => {
    const wrapper = mountRow({
      ...baseItem,
      lastSeenActivityAt: "2026-01-02T00:00:00.000Z",
      lastRemoteActivityAt: "2026-01-01T00:00:00.000Z",
    });
    await actionButtons(wrapper)[2].trigger("click");
    expect(wrapper.emitted("seen")?.[0]).toEqual(["pr:1"]);
  });

  test("opening=true disables the primary action and shows 'Opening…'", () => {
    const wrapper = mountRow(baseItem, { opening: true });
    const primaryBtn = actionButtons(wrapper)[0];
    expect(primaryBtn.attributes("disabled")).toBeDefined();
    expect(primaryBtn.text()).toBe("Opening…");
  });

  test("focused=true expands and marks the row", () => {
    const wrapper = mountRow({ ...baseItem, connectionId: "conn-1" }, { focused: true });

    expect(wrapper.classes()).toContain("azure-pr-row--focused");
    expect(wrapper.classes()).toContain("azure-pr-row--expanded");
    expect(wrapper.find(".azure-pr-row__details").exists()).toBe(true);
    expect(wrapper.attributes("data-pr-key")).toBe("pr:1");
    expect(wrapper.attributes("data-connection-id")).toBe("conn-1");
  });

  test("the primary action is Review even when the author's checkout could be attached", async () => {
    const wrapper = mountRow({ ...baseItem, role: "author", existingWorkspaceId: "ws-42", reviewWorkspaceId: "" });
    const buttons = actionButtons(wrapper);
    expect(buttons.map((b) => b.text())).toEqual(["Work here", "Review", "", ""]);
    // forceReview is what stops the backend fallback attaching to ws-42.
    await buttons[1].trigger("click");
    expect(wrapper.emitted("open")?.[0]).toEqual([{ prKey: "pr:1", workspaceId: "", forceReview: true }]);
  });

  test("'Work here' attaches the PR to the author's existing checkout", async () => {
    const wrapper = mountRow({ ...baseItem, role: "author", existingWorkspaceId: "ws-42", reviewWorkspaceId: "" });
    const attachBtn = actionButtons(wrapper).find((b) => b.text() === "Work here")!;
    expect(attachBtn.attributes("title")).toContain("already have on this branch");
    await attachBtn.trigger("click");
    expect(wrapper.emitted("open")?.[0]).toEqual([{ prKey: "pr:1", workspaceId: "ws-42" }]);
  });

  test("'Work here' is offered only to an author with no review workspace yet", () => {
    const reviewer = mountRow({ ...baseItem, role: "reviewer", existingWorkspaceId: "", reviewWorkspaceId: "" });
    expect(actionButtons(reviewer).map((b) => b.text())).toEqual(["Review", "", ""]);

    const open = mountRow({ ...baseItem, role: "author", existingWorkspaceId: "ws-42", reviewWorkspaceId: "ws-9" });
    expect(actionButtons(open).map((b) => b.text())).toEqual(["Open", "", ""]);
  });

  test("a plain reviewer's Review click does not ask for forceReview", async () => {
    const wrapper = mountRow({ ...baseItem, role: "reviewer", existingWorkspaceId: "", reviewWorkspaceId: "" });
    await actionButtons(wrapper)[0].trigger("click");
    expect(wrapper.emitted("open")?.[0]).toEqual([{ prKey: "pr:1", workspaceId: "", forceReview: false }]);
  });

  test("expand toggle reveals and hides the details block and keeps aria-expanded in sync", async () => {
    const wrapper = mountRow(baseItem);
    const toggle = wrapper.find(".azure-pr-row__expand");
    expect(wrapper.find(".azure-pr-row__details").exists()).toBe(false);
    expect(toggle.attributes("aria-expanded")).toBe("false");
    await expand(wrapper);
    expect(wrapper.find(".azure-pr-row__details").exists()).toBe(true);
    expect(toggle.attributes("aria-expanded")).toBe("true");
    await expand(wrapper);
    expect(wrapper.find(".azure-pr-row__details").exists()).toBe(false);
  });
});

describe("PrRow — attention reasons and group reviewers", () => {
  const item = {
    prKey: "pr:9",
    role: "reviewer",
    hasAttention: true,
    attentionReason: "Review requested via Core Team",
    attentionReasons: [{ code: "group-review-requested", label: "Review requested via Core Team", ackOnSeen: true }],
    newCommentsCount: 4,
    pullRequest: { id: 9, title: "Grouped", sourceRefName: "refs/heads/a", targetRefName: "refs/heads/b" },
  };

  test("the chip shows attentionReason verbatim (no new-comment rule) and the icon follows the first code", () => {
    const chip = mountRow(item).find(".azure-pr-row__chip--attention");
    expect(chip.text()).toBe("Review requested via Core Team");
    const eye = mountRow(item).find(".azure-pr-row__chip--attention path").attributes("d");

    const iconOf = (code: string) =>
      mountRow({ ...item, attentionReasons: [{ code, label: "x", ackOnSeen: true }] })
        .find(".azure-pr-row__chip--attention path")
        .attributes("d");
    expect(iconOf("review-requested")).toBe(eye);
    expect(new Set(["push-after-approval", "changes-requested", "conflicts", "replies"].map(iconOf)).size).toBe(4);
    expect(iconOf("push-after-feedback")).toBe(iconOf("push-after-approval"));
    expect(iconOf("merge-failed")).toBe(iconOf("conflicts"));
    expect(iconOf("push-after-approval")).not.toBe(eye);
  });

  const withGroup = (via: Array<Record<string, unknown>>) => ({
    ...item,
    reviewerSummary: {
      reviewers: [{ id: "g1", displayName: "Core Team", vote: 0, isContainer: true, isRequired: true }],
    },
    reviewerVia: via,
  });

  test("a group the user belongs to that nobody covered gets the ring and a member label", async () => {
    const wrapper = mountRow(
      withGroup([{ id: "g1", displayName: "Core Team", isRequired: true, vote: 0, coveredBy: null }]),
    );
    const avatar = (await hover(wrapper)).get(".azure-avatar");
    expect(avatar.classes()).toContain("azure-avatar--ring");
    expect(avatar.attributes("aria-label")).toBe("Core Team (you're a member): No vote yet · required");
    await expand(wrapper);
    expect(wrapper.find(".azure-pr-row__reviewer-name").text()).toBe("Core Team · you're a member");
  });

  test("a group covered by a colleague's vote has no ring and says who covered it", async () => {
    const covered = withGroup([
      { id: "g1", displayName: "Core Team", isRequired: true, vote: 0, covered: true, coveredBy: "Sam Taylor" },
    ]);
    const wrapper = mountRow({
      ...covered,
      reviewerSummary: {
        reviewers: [
          ...covered.reviewerSummary.reviewers,
          { id: "jan", displayName: "Sam Taylor", vote: 10, votedFor: [{ id: "g1", displayName: "Core Team" }] },
        ],
      },
    });
    const avatar = (await hover(wrapper)).get(".azure-avatar");
    expect(avatar.classes()).not.toContain("azure-avatar--ring");
    expect(avatar.attributes("aria-label")).toContain("Approved by Sam Taylor");
  });

  test("unread follows other people's activity, so the user's own comment or push leaves the row read", () => {
    const seen = { lastSeenActivityAt: "2026-01-02T00:00:00.000Z", lastRemoteActivityAt: "2026-01-03T00:00:00.000Z" };
    const row = (others: string | null) =>
      mountRow({ ...item, ...seen, attentionReasons: [], hasAttention: false, lastOthersActivityAt: others }).find(
        ".azure-pr-row",
      );
    expect(row("2026-01-01T00:00:00.000Z").classes()).not.toContain("azure-pr-row--unread");
    expect(row(null).classes()).not.toContain("azure-pr-row--unread");
    expect(row("2026-01-03T00:00:00.000Z").classes()).toContain("azure-pr-row--unread");
  });

  test("a project-scoped group name drops its [Project]\\ prefix", async () => {
    const wrapper = mountRow({
      ...item,
      reviewerSummary: {
        reviewers: [
          { id: "g2", displayName: "[ACME_CORE]\\core PR Maintainers", vote: 0, isContainer: true, isRequired: true },
        ],
      },
    });
    const avatar = (await hover(wrapper)).get(".azure-avatar");
    expect(avatar.attributes("aria-label")).toBe("core PR Maintainers: No vote yet · required");
    expect(avatar.text()).toBe("CM");
  });

  test("mark as read is inert when only a review request remains, since opening does not clear it", () => {
    const read = { lastSeenActivityAt: "2026-01-02T00:00:00.000Z", lastRemoteActivityAt: "2026-01-01T00:00:00.000Z" };
    const markRead = (reasons: Array<Record<string, unknown>>) =>
      actionButtons(mountRow({ ...item, ...read, attentionReasons: reasons })).find(
        (b) => b.attributes("aria-label") === "Mark #9 as read",
      )!;
    expect(markRead([{ code: "review-requested", label: "Your review", ackOnSeen: false }]).classes()).toContain(
      "azure-pr-row__btn--idle",
    );
    expect(markRead([{ code: "replies", label: "1 reply to you", ackOnSeen: true }]).classes()).not.toContain(
      "azure-pr-row__btn--idle",
    );
  });

  test("a group covered by a colleague's 'waiting' vote says so, even when the group's own vote is 0", async () => {
    const wrapper = mountRow({
      ...item,
      reviewerSummary: {
        reviewers: [
          { id: "g1", displayName: "Core Team", vote: 0, isContainer: true, isRequired: true },
          { id: "jan", displayName: "Sam Taylor", vote: -5, votedFor: [{ id: "g1", displayName: "Core Team" }] },
        ],
      },
      reviewerVia: [
        { id: "g1", displayName: "Core Team", isRequired: true, vote: 0, covered: true, coveredBy: "Sam Taylor" },
      ],
    });
    const group = (await hover(wrapper)).findAll(".azure-avatar")[0];
    expect(group.attributes("aria-label")).toBe(
      "Core Team (you're a member): Waiting for author by Sam Taylor · required",
    );
    expect(group.classes()).not.toContain("azure-avatar--ring");
    expect(group.find(".azure-avatar__badge--waiting").exists()).toBe(true);
  });

  test("without reviewerVia a group is a plain group", async () => {
    const wrapper = mountRow({ ...withGroup([]), reviewerVia: undefined });
    expect((await hover(wrapper)).get(".azure-avatar").attributes("aria-label")).toBe(
      "Core Team: No vote yet · required",
    );
  });

  test("a reason the section heading states gets no chip; the next reason does, and the card lists both", async () => {
    const reasons = [
      { code: "review-requested", label: "Your review", ackOnSeen: false },
      { code: "replies", label: "2 replies to you", ackOnSeen: true },
    ];
    const implied = { impliedReasonCodes: ["review-requested"] };
    const only = mountRow({ ...item, attentionReason: "Your review", attentionReasons: reasons.slice(0, 1) }, implied);
    expect(only.find(".azure-pr-row__chip--attention").exists()).toBe(false);

    const wrapper = mountRow({ ...item, attentionReason: "Your review", attentionReasons: reasons }, implied);
    const chip = wrapper.get(".azure-pr-row__chip--attention");
    expect(chip.text()).toBe("2 replies to you");
    const replyIcon = mountRow({ ...item, attentionReasons: reasons.slice(1) })
      .get(".azure-pr-row__chip--attention path")
      .attributes("d");
    expect(chip.get("path").attributes("d")).toBe(replyIcon);
    const card = await hover(wrapper);
    expect(card.findAll(".azure-pr-hovercard__reason").map((r) => r.text())).toEqual([
      "Your review",
      "2 replies to you",
    ]);

    // Outside such a section the same reason keeps its chip.
    const plain = mountRow({ ...item, attentionReason: "Your review", attentionReasons: reasons.slice(0, 1) });
    expect(plain.get(".azure-pr-row__chip--attention").text()).toBe("Your review");
  });

  test("a Merge conflicts chip is red and not repeated by a Conflicts flag; a review request keeps the accent", async () => {
    const wrapper = mountRow({
      ...item,
      attentionReason: "Merge conflicts",
      attentionReasons: [{ code: "conflicts", label: "Merge conflicts", ackOnSeen: false }],
      pullRequest: { ...item.pullRequest, mergeStatus: "conflicts" },
    });
    const chip = wrapper.get(".azure-pr-row__chip--attention");
    expect(chip.text()).toBe("Merge conflicts");
    expect(chip.classes()).toContain("azure-pr-row__chip--danger");
    expect(wrapper.find(".azure-pr-row__conflicts").exists()).toBe(false);
    expect((await hover(wrapper)).get(".azure-pr-hovercard__reason").classes()).toContain(
      "azure-pr-hovercard__reason--danger",
    );

    const failed = [{ code: "merge-failed", label: "Merge check failed", ackOnSeen: false }];
    expect(
      mountRow({ ...item, attentionReasons: failed })
        .get(".azure-pr-row__chip--attention")
        .classes(),
    ).toContain("azure-pr-row__chip--danger");
    const review = [{ code: "review-requested", label: "Your review", ackOnSeen: false }];
    expect(
      mountRow({ ...item, attentionReasons: review })
        .get(".azure-pr-row__chip--attention")
        .classes(),
    ).not.toContain("azure-pr-row__chip--danger");
  });
});

describe("PrRow — hover card", () => {
  const item = {
    prKey: "pr:5",
    role: "reviewer",
    hasAttention: false,
    project: { name: "ACME_CORE" },
    repository: { name: "orders" },
    author: { displayName: "Doe, Jane (Acme Ltd.)" },
    pullRequest: {
      id: 5,
      title: "ABC-1 | Five",
      sourceRefName: "refs/heads/jdoe/ABC-1",
      targetRefName: "refs/heads/develop",
    },
  };

  test("opens after the pointer rests on the row, with the facts the row leaves out", async () => {
    const wrapper = mountRow(item, { showRepo: true });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await wrapper.get(".azure-pr-row__info").trigger("pointerenter", { pointerType: "mouse" });
    vi.advanceTimersByTime(200);
    await nextTick();
    expect(wrapper.find(".azure-pr-hovercard").exists()).toBe(false);
    vi.advanceTimersByTime(200);
    await nextTick();

    const card = wrapper.get(".azure-pr-hovercard");
    expect(card.attributes("role")).toBe("tooltip");
    expect(card.get(".azure-pr-hovercard__title").text()).toBe("ABC-1 | Five");
    expect(card.get(".azure-pr-hovercard__repo").text()).toBe("ACME_CORE / orders");
    expect(fact(wrapper, "Branch")).toBe("jdoe/ABC-1 → develop");
  });

  test("closes when the pointer leaves, and a leave before the delay never opens it", async () => {
    const wrapper = mountRow(item);
    await hover(wrapper);
    await wrapper.get(".azure-pr-row__info").trigger("pointerleave");
    expect(wrapper.find(".azure-pr-hovercard").exists()).toBe(false);

    await wrapper.get(".azure-pr-row__info").trigger("pointerenter", { pointerType: "mouse" });
    await wrapper.get(".azure-pr-row__info").trigger("pointerleave");
    vi.advanceTimersByTime(1000);
    await nextTick();
    expect(wrapper.find(".azure-pr-hovercard").exists()).toBe(false);
  });

  test("never opens for a touch, nor while the row is expanded, and expanding closes it", async () => {
    expect((await hover(mountRow(item), "touch")).exists()).toBe(false);

    const wrapper = mountRow(item);
    expect((await hover(wrapper)).exists()).toBe(true);
    await expand(wrapper);
    expect(wrapper.find(".azure-pr-hovercard").exists()).toBe(false);
    expect((await hover(wrapper)).exists()).toBe(false);
  });
});

describe("PrRow — title and name helpers", () => {
  test("splitTicketPrefix takes only leading ticket keys and their separator", () => {
    expect(splitTicketPrefix("ABC-90909 | ops | Forward events")).toEqual({
      prefix: "ABC-90909 | ",
      rest: "ops | Forward events",
    });
    expect(splitTicketPrefix("ABC-91591 CORE | OPS")).toEqual({ prefix: "ABC-91591 ", rest: "CORE | OPS" });
    expect(splitTicketPrefix("ABC-12: fix")).toEqual({ prefix: "ABC-12: ", rest: "fix" });
    for (const title of ["Fix ABC-12 later", "UTF-8 support", "ABC-123", "feat(x): y"]) {
      expect(splitTicketPrefix(title)).toEqual({ prefix: "", rest: title });
    }
  });

  test("shortPersonName drops one trailing parenthetical only", () => {
    expect(shortPersonName("Doe, Jane (Acme Ltd.)")).toBe("Doe, Jane");
    expect(shortPersonName("Brown, Alex 2 (Acme Ltd.)")).toBe("Brown, Alex 2");
    expect(shortPersonName("Alice")).toBe("Alice");
    expect(shortPersonName("(Bot)")).toBe("(Bot)");
  });
});
