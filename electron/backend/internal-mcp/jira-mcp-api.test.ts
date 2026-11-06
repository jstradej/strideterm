import { mkdir, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JiraConnection, JiraComment, JiraIssue } from "../jira/jira-manager.js";
import { createJiraInternalMcpApi, type JiraMcpApiOptions, type JiraMcpReader } from "./jira-mcp-api.js";
import { InternalMcpError } from "./errors.js";

const connection: JiraConnection = {
  id: "jira-connection-1",
  profileId: "profile-a",
  label: "Jira",
  enabled: true,
  deployment: "cloud",
  webUrl: "https://jira.example.invalid",
  apiBaseUrl: "https://api.atlassian.com",
  cloudId: "cloud-1",
  auth: { kind: "cloud-api-token", secretRef: "never-return-this", email: "me@example.com" },
  accountPurpose: "personal",
};
const scope = { profileId: "profile-a", workspaceId: "workspace-a" };
const issue: JiraIssue = {
  ref: { provider: "jira", connectionId: connection.id, issueId: "100", issueKey: "TEST-1" },
  summary: "Issue summary",
  status: "In Progress",
  issueType: "Task",
  projectKey: "TEST",
  updated: "2026-10-23T10:00:00Z",
  url: "https://jira.example.invalid/browse/TEST-1",
  description: "External issue content",
};

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function createApi(overrides: Partial<JiraMcpApiOptions> = {}) {
  const manager = {
    issue: vi.fn(async () => issue),
    search: vi.fn(async () => [issue]),
    searchPage: vi.fn(async (_connection: JiraConnection, _query: string, _limit: number, cursor?: string) => ({
      issues: [issue],
      hasMore: !cursor,
      ...(!cursor ? { nextCursor: "next-page" } : {}),
      truncated: !cursor,
    })),
    comments: vi.fn(async (): Promise<JiraComment[]> => [
      { id: "comment-1", author: "User", created: "today", body: "Untrusted comment" },
    ]),
    attachmentBytes: vi.fn(
      async (
        _connection: JiraConnection,
        _issueId: string,
        _attachmentId: string,
        options: { maxBytes: number; maxDurationMs: number },
      ) => {
        expect(options.maxBytes).toBeGreaterThan(0);
        expect(options.maxDurationMs).toBeGreaterThan(0);
        return { bytes: new Uint8Array([1, 2, 3]), mediaType: "application/pdf" };
      },
    ),
    linkedWork: vi.fn(async () => [
      { id: "1", url: "https://github.com/org/repo/pull/1", title: "PR", accessToken: "secret" },
    ]),
    projects: vi.fn(async () => [{ id: "1", key: "TEST", name: "Test" }]),
    favoriteFilters: vi.fn(async () => [{ id: "4", name: "Open" }]),
    savedFilter: vi.fn(async () => ({ id: "4", name: "Open", jql: "project = TEST" })),
    boardMetadata: vi.fn<JiraMcpReader["boardMetadata"]>(async () => ({ id: 1, name: "Board", type: "scrum" })),
    boards: vi.fn<JiraMcpReader["boards"]>(async () => [{ id: 1, name: "Board", type: "scrum" }]),
    boardView: vi.fn<JiraMcpReader["boardView"]>(async () => ({
      boardId: 1,
      mode: "issues",
      issues: [issue],
      hasMore: false,
      truncated: false,
      cache: { source: "network", fetchedAt: Date.now(), stale: false },
      capabilities: {
        configuration: "unknown",
        quickFilters: "unknown",
        issues: "available",
        backlog: "available",
        sprints: "available",
      },
    })),
    transitions: vi.fn(async () => []),
  };
  const saveCommentDraft = vi.fn(async () => ({ draftId: "draft-1", createdAt: "2026-10-23T10:00:00Z" }));
  const api = createJiraInternalMcpApi({
    manager,
    listConnections: async () => [connection],
    resolveConnection: async () => connection,
    authorizeConnection: async () => true,
    authorizeIssue: async () => true,
    managedDataRoot: async () => process.cwd(),
    saveCommentDraft,
    ...overrides,
  } as never);
  return { api, manager, saveCommentDraft };
}

describe("createJiraInternalMcpApi", () => {
  it("discovers only enabled same-profile connections without credentials, refs, or certificate paths", async () => {
    const other: JiraConnection = {
      ...connection,
      id: "jira-other-profile",
      profileId: "profile-b",
      auth: { kind: "dc-apim", secretRef: "sensitive-ref", passphraseRef: "sensitive-passphrase-ref" },
      clientCertificatePath: "C:\\private\\cert.pfx",
    };
    const disabled: JiraConnection = { ...connection, id: "disabled", enabled: false };
    const { api } = createApi({ listConnections: () => [connection, other, disabled] });
    const result = await api.listConnections(scope, {});
    expect(result).toEqual([
      {
        id: connection.id,
        label: connection.label,
        deployment: connection.deployment,
        enabled: true,
        accountPurpose: connection.accountPurpose,
      },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/secret|credential|cert\.pfx|passphrase/i);
  });

  it("exposes the manager-backed project/filter/board/transition reads with bounded DTOs", async () => {
    const { api, manager } = createApi();
    expect(await api.listProjects(scope, { connectionId: connection.id })).toEqual([
      { id: "1", key: "TEST", name: "Test" },
    ]);
    expect(await api.listFilters(scope, { connectionId: connection.id })).toEqual([{ id: "4", name: "Open" }]);
    expect(await api.getFilter(scope, { connectionId: connection.id, filterId: "4" })).toMatchObject({
      id: "4",
      jql: "project = TEST",
    });
    expect(await api.listBoards(scope, { connectionId: connection.id })).toMatchObject([{ id: 1, name: "Board" }]);
    expect(await api.boardView(scope, { connectionId: connection.id, boardId: 1 })).toMatchObject({
      boardId: 1,
      issues: [{ ref: { issueKey: "TEST-1" } }],
    });
    await api.boardView(scope, { connectionId: connection.id, boardId: 1, mode: "sprints" });
    expect(manager.boardMetadata).toHaveBeenCalledWith(connection, 1);
    expect(manager.boards).toHaveBeenCalledTimes(1);
    expect(await api.getTransitions(scope, { connectionId: connection.id, issueId: "100" })).toEqual([]);
    expect(manager.boardView).toHaveBeenCalled();
    expect(manager.transitions).toHaveBeenCalledWith(connection, "100");
  });

  it("paginates my open issues using only the saved human identity and authorizes every result", async () => {
    const humanConnection: JiraConnection = {
      ...connection,
      ownIdentity: { kind: "cloud", accountId: "human-123", displayName: "Human" },
    };
    const authorizeIssue = vi.fn(async () => true);
    const { api, manager } = createApi({ resolveConnection: async () => humanConnection, authorizeIssue });
    const first = (await api.myOpenIssues(scope, { connectionId: connection.id, limit: 12 })) as {
      issues: JiraIssue[];
      hasMore: boolean;
      nextCursor?: string;
      truncated: boolean;
    };
    expect(first).toMatchObject({
      issues: [{ ref: { issueKey: "TEST-1" } }],
      hasMore: true,
      nextCursor: "next-page",
      truncated: true,
    });
    expect(manager.searchPage).toHaveBeenCalledWith(
      humanConnection,
      'assignee = "human-123" AND statusCategory != Done ORDER BY updated DESC',
      12,
      undefined,
    );
    expect(authorizeIssue).toHaveBeenCalledWith(scope, connection.id, issue.ref.issueId);
    const second = await api.myOpenIssues(scope, { connectionId: connection.id, limit: 12, cursor: first.nextCursor });
    expect(manager.searchPage).toHaveBeenLastCalledWith(
      humanConnection,
      'assignee = "human-123" AND statusCategory != Done ORDER BY updated DESC',
      12,
      "next-page",
    );
    expect(second).toMatchObject({ hasMore: false, truncated: false });
  });

  it("does not fall back to the API account when a verified human identity is absent", async () => {
    const { api, manager } = createApi();
    await expect(api.myOpenIssues(scope, { connectionId: connection.id })).rejects.toMatchObject({
      code: "scope_denied",
    });
    expect(manager.searchPage).not.toHaveBeenCalled();
  });

  it("returns active sprint issues even when sprint discovery has more than 100 historical sprints", async () => {
    const { api, manager } = createApi();
    manager.boardView.mockImplementation(async (_connection, _boardId, mode, _cursor, sprintId) =>
      sprintId === undefined
        ? {
            boardId: 1,
            mode: mode || "sprints",
            issues: [],
            sprints: [{ id: "501", name: "Current", state: "active" }],
            hasMore: true,
            truncated: true,
            cache: { source: "network", fetchedAt: Date.now(), stale: false },
            capabilities: {
              configuration: "available",
              quickFilters: "unknown",
              issues: "unknown",
              backlog: "unknown",
              sprints: "available",
            },
          }
        : {
            boardId: 1,
            mode: "sprints",
            issues: [issue],
            sprints: [{ id: "501", name: "Current", state: "active" }],
            hasMore: false,
            truncated: false,
            selectedSprintId: sprintId,
            cache: { source: "network", fetchedAt: Date.now(), stale: false },
            capabilities: {
              configuration: "available",
              quickFilters: "unknown",
              issues: "available",
              backlog: "unknown",
              sprints: "available",
            },
          },
    );
    const result = await api.activeSprint(scope, { connectionId: connection.id, boardId: 1 });
    expect(result).toMatchObject({
      selectedSprintId: 501,
      sprints: [{ id: "501", state: "active" }],
      issues: [{ ref: { issueKey: "TEST-1" } }],
    });
    expect(manager.boards).not.toHaveBeenCalled();
    expect(manager.boardView).toHaveBeenLastCalledWith(connection, 1, "sprints", undefined, 501);
  });

  it("reports Kanban sprint requests as unsupported before making a sprint call", async () => {
    const { api, manager } = createApi();
    manager.boardMetadata.mockResolvedValue({ id: 1, name: "Board", type: "kanban" });
    await expect(api.activeSprint(scope, { connectionId: connection.id, boardId: 1 })).rejects.toMatchObject({
      code: "jira_unavailable",
      message: "Sprint views are only available for Scrum boards.",
    });
    expect(manager.boardView).not.toHaveBeenCalled();
  });

  it("does not substitute or paginate historical sprints when no active sprint exists", async () => {
    const { api, manager } = createApi();
    manager.boardView.mockResolvedValue({
      boardId: 1,
      mode: "sprints",
      issues: [],
      sprints: [{ id: "499", name: "Old", state: "closed" }],
      hasMore: true,
      nextCursor: "closed-sprint-next",
      truncated: true,
      cache: { source: "network", fetchedAt: Date.now(), stale: false },
      sprintsHasMore: true,
      sprintsNextCursor: "closed-sprint-next",
      capabilities: {
        configuration: "available",
        quickFilters: "unknown",
        issues: "unknown",
        backlog: "unknown",
        sprints: "available",
      },
    });
    const result = await api.activeSprint(scope, { connectionId: connection.id, boardId: 1 });
    expect(result).toMatchObject({
      sprints: [],
      issues: [],
      hasMore: false,
      truncated: false,
      sprintsHasMore: false,
    });
    expect(result).not.toHaveProperty("nextCursor");
    expect(manager.boardView).toHaveBeenCalledTimes(1);
  });

  it("checks grant profile and connection status before reading, without exposing Jira errors", async () => {
    const manager = {
      issue: vi.fn(async () => {
        throw new Error("provider error included never-return-this");
      }),
      search: vi.fn(),
      comments: vi.fn(),
      attachmentBytes: vi.fn(),
      linkedWork: vi.fn(),
    };
    const api = createJiraInternalMcpApi({
      manager: manager as never,
      listConnections: async () => [connection],
      resolveConnection: async () => ({ ...connection, profileId: "profile-b" }),
      authorizeConnection: async () => true,
      authorizeIssue: async () => true,
      managedDataRoot: async () => "unused",
      saveCommentDraft: async () => ({ draftId: "draft", createdAt: "now" }),
    });
    await expect(api.getIssue(scope, { connectionId: connection.id, issueId: "100" })).rejects.toMatchObject({
      code: "scope_denied",
    });
    expect(manager.issue).not.toHaveBeenCalled();
    const unavailable = createJiraInternalMcpApi({
      manager: {
        ...manager,
        issue: async () => {
          throw new Error("provider error included never-return-this");
        },
      } as never,
      listConnections: async () => [connection],
      resolveConnection: async () => connection,
      authorizeConnection: async () => true,
      authorizeIssue: async () => true,
      managedDataRoot: async () => "unused",
      saveCommentDraft: async () => ({ draftId: "draft", createdAt: "now" }),
    });
    const error = await unavailable
      .getIssue(scope, { connectionId: connection.id, issueId: "100" })
      .catch((cause) => cause);
    expect(error).toBeInstanceOf(InternalMcpError);
    expect(error instanceof Error ? error.message : String(error)).not.toContain("never-return-this");
  });

  it("returns normalized issue and comment content without auth metadata", async () => {
    const { api } = createApi();
    const found = (await api.getIssue(scope, { connectionId: connection.id, issueId: "100" })) as Record<
      string,
      unknown
    >;
    expect(found).toMatchObject({ ref: { issueId: "100", issueKey: "TEST-1" }, summary: "Issue summary" });
    expect(JSON.stringify(found)).not.toContain("never-return-this");
    const comments = await api.getComments(scope, { connectionId: connection.id, issueId: "100" });
    expect(comments).toMatchObject([{ body: "Untrusted comment" }]);
  });

  it("gives an agent the newest 100 comments of a longer thread", async () => {
    const { api, manager } = createApi();
    manager.comments.mockResolvedValue(
      Array.from({ length: 150 }, (_, index) => ({
        id: String(index + 1),
        author: "U",
        created: "today",
        body: `comment ${index + 1}`,
      })),
    );
    const comments = (await api.getComments(scope, { connectionId: connection.id, issueId: "100" })) as Array<{
      id: string;
    }>;
    expect(comments).toHaveLength(100);
    expect(comments[0].id).toBe("51");
    expect(comments.at(-1)?.id).toBe("150");
  });

  it("never hands rendered HTML to agents", async () => {
    const { api, manager } = createApi();
    manager.issue.mockResolvedValue({ ...issue, descriptionHtml: "<p>html</p>" } as never);
    manager.comments.mockResolvedValue([
      { id: "c", author: "U", created: "today", body: "text", bodyHtml: "<p>html</p>" },
    ]);
    const found = await api.getIssue(scope, { connectionId: connection.id, issueId: "100" });
    const comments = await api.getComments(scope, { connectionId: connection.id, issueId: "100" });
    expect(JSON.stringify(found)).not.toContain("html");
    expect(JSON.stringify(comments)).not.toContain("html");
  });

  it("enforces grant connection and issue permissions before reads and filters search results", async () => {
    const unauthorizedConnection = createApi({ authorizeConnection: async () => false });
    await expect(
      unauthorizedConnection.api.getIssue(scope, { connectionId: connection.id, issueId: "100" }),
    ).rejects.toMatchObject({ code: "scope_denied" });
    expect(unauthorizedConnection.manager.issue).not.toHaveBeenCalled();
    const unauthorizedIssue = createApi({ authorizeIssue: async () => false });
    await expect(
      unauthorizedIssue.api.getComments(scope, { connectionId: connection.id, issueId: "100" }),
    ).rejects.toMatchObject({ code: "scope_denied" });
    expect(unauthorizedIssue.manager.comments).not.toHaveBeenCalled();
    const filtered = createApi({
      manager: {
        issue: vi.fn(async () => issue),
        search: vi.fn(async () => [issue, { ...issue, ref: { ...issue.ref, issueId: "200", issueKey: "TEST-2" } }]),
        comments: vi.fn(async () => []),
        attachmentBytes: vi.fn(async () => ({ bytes: new Uint8Array(), mediaType: "application/octet-stream" })),
        linkedWork: vi.fn(async () => []),
      } as never,
      authorizeIssue: async (_scope, _connectionId, issueId) => issueId !== "200",
    });
    const results = await filtered.api.search(scope, {
      connectionId: connection.id,
      query: "project = TEST",
      limit: 2,
    });
    expect(results).toMatchObject([{ ref: { issueId: "100" } }]);
    expect(results).toHaveLength(1);
    const wrongWorkspace = createApi({
      authorizeIssue: async (grant, _connectionId, issueId) => grant.workspaceId === "workspace-a" && issueId === "100",
    });
    await expect(
      wrongWorkspace.api.getIssue(
        { ...scope, workspaceId: "workspace-b" },
        { connectionId: connection.id, issueId: "100" },
      ),
    ).rejects.toMatchObject({ code: "scope_denied" });
  });

  it("writes one bounded attachment only into its managed workspace folder and returns metadata only", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "jira-agent-attachments-"));
    roots.push(root);
    const { api, manager } = createApi({ managedDataRoot: async () => root });
    const saved = (await api.getAttachment(scope, {
      connectionId: connection.id,
      issueId: "100",
      attachmentId: "attachment-1",
      fileName: "design.pdf",
    })) as Record<string, unknown>;
    expect(saved).toMatchObject({ fileName: "design.pdf", mediaType: "application/pdf", sizeBytes: 3 });
    expect(saved).not.toHaveProperty("bytes");
    const target = path.join(root, "profile-a", "workspace-a", "jira-attachments", "design.pdf");
    expect(await readFile(target)).toEqual(Buffer.from([1, 2, 3]));
    expect(manager.attachmentBytes).toHaveBeenCalledTimes(1);
    await expect(
      api.getAttachment(scope, {
        connectionId: connection.id,
        issueId: "100",
        attachmentId: "attachment-1",
        fileName: "design.pdf",
      }),
    ).rejects.toMatchObject({ code: "file_not_accessible" });
    expect(await readFile(target)).toEqual(Buffer.from([1, 2, 3]));
    await expect(
      api.getAttachment(scope, {
        connectionId: connection.id,
        issueId: "100",
        attachmentId: "attachment-1",
        fileName: "../outside.pdf",
      }),
    ).rejects.toBeInstanceOf(InternalMcpError);
  });

  it("rejects symlinked workspace folders and oversized attachments", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "jira-agent-attachments-"));
    const outside = await mkdtemp(path.join(tmpdir(), "jira-agent-outside-"));
    const oversizedRoot = await mkdtemp(path.join(tmpdir(), "jira-agent-oversized-"));
    roots.push(root, outside, oversizedRoot);
    await symlink(outside, path.join(root, "profile-a"), process.platform === "win32" ? "junction" : "dir");
    const linked = createApi({ managedDataRoot: async () => root });
    await expect(
      linked.api.getAttachment(scope, {
        connectionId: connection.id,
        issueId: "100",
        attachmentId: "attachment-1",
        fileName: "bad.pdf",
      }),
    ).rejects.toBeInstanceOf(InternalMcpError);
    const oversized = createApi({
      manager: {
        issue: vi.fn(async () => issue),
        search: vi.fn(async () => [issue]),
        comments: vi.fn(async () => []),
        attachmentBytes: vi.fn(async () => ({ bytes: new Uint8Array(3), mediaType: "application/pdf" })),
        linkedWork: vi.fn(async () => []),
      } as never,
      managedDataRoot: async () => oversizedRoot,
      maxAttachmentBytes: 2,
    });
    await expect(
      oversized.api.getAttachment(scope, {
        connectionId: connection.id,
        issueId: "100",
        attachmentId: "attachment-1",
        fileName: "large.pdf",
      }),
    ).rejects.toMatchObject({ code: "file_not_accessible" });
    expect(
      await readFile(path.join(oversizedRoot, "profile-a", "workspace-a", "jira-attachments", "large.pdf")).catch(
        () => null,
      ),
    ).toBeNull();
  });

  describe("attachment folder limits", () => {
    const folder = (root: string) => path.join(root, "profile-a", "workspace-a", "jira-attachments");
    async function seed(root: string, names: string[]) {
      await mkdir(folder(root), { recursive: true });
      for (const [index, name] of names.entries()) {
        const file = path.join(folder(root), name);
        await writeFile(file, Buffer.alloc(10));
        const when = new Date(Date.now() - (names.length - index) * 60_000);
        await utimes(file, when, when);
      }
    }
    const download = (api: ReturnType<typeof createApi>["api"], fileName: string) =>
      api.getAttachment(scope, { connectionId: connection.id, issueId: "100", attachmentId: "a", fileName });

    it("evicts the oldest files when the file count would be exceeded", async () => {
      const root = await mkdtemp(path.join(tmpdir(), "jira-agent-evict-"));
      roots.push(root);
      await seed(root, ["old.bin", "mid.bin", "new.bin"]);
      const { api } = createApi({
        managedDataRoot: async () => root,
        attachmentFolderLimits: () => ({ maxFiles: 3, maxMegabytes: 50 }),
      });
      await download(api, "fresh.bin");
      expect((await readdir(folder(root))).sort()).toEqual(["fresh.bin", "mid.bin", "new.bin"]);
    });

    it("evicts the oldest files when the byte limit would be exceeded, reading the limit live", async () => {
      const root = await mkdtemp(path.join(tmpdir(), "jira-agent-evict-bytes-"));
      roots.push(root);
      await seed(root, ["old.bin", "new.bin"]);
      let limits = { maxFiles: 50, maxMegabytes: 50 };
      const { api } = createApi({ managedDataRoot: async () => root, attachmentFolderLimits: () => limits });
      await download(api, "one.bin");
      expect((await readdir(folder(root))).sort()).toEqual(["new.bin", "old.bin", "one.bin"]);
      limits = { maxFiles: 1, maxMegabytes: 50 };
      await download(api, "two.bin");
      expect(await readdir(folder(root))).toEqual(["two.bin"]);
    });

    it("refuses a single file larger than the byte limit and names the setting", async () => {
      const root = await mkdtemp(path.join(tmpdir(), "jira-agent-evict-big-"));
      roots.push(root);
      await seed(root, ["keep.bin"]);
      const { api } = createApi({
        managedDataRoot: async () => root,
        attachmentFolderLimits: () => ({ maxFiles: 50, maxMegabytes: 1 }),
        manager: {
          issue: vi.fn(async () => issue),
          attachmentBytes: vi.fn(async () => ({
            bytes: new Uint8Array(2 * 1024 * 1024),
            mediaType: "application/pdf",
          })),
        } as never,
        maxAttachmentBytes: 10 * 1024 * 1024,
      });
      await expect(download(api, "big.bin")).rejects.toThrow(/1 MB.*Settings/);
      expect(await readdir(folder(root))).toEqual(["keep.bin"]);
    });
  });

  it("strips sensitive linked-work fields and only saves comment drafts", async () => {
    const { api, manager, saveCommentDraft } = createApi();
    const linked = await api.linkedWork(scope, { connectionId: connection.id, issueId: "100" });
    expect(JSON.stringify(linked)).not.toContain("accessToken");
    const draft = await api.proposeComment(scope, { connectionId: connection.id, issueId: "100", body: "Draft only" });
    expect(draft).toEqual({
      draftId: "draft-1",
      createdAt: "2026-10-23T10:00:00Z",
      status: "draft",
      reviewLocation: "Jira workspace → Agent comment drafts",
      message: "Saved for review only; nothing was posted to Jira.",
    });
    expect(saveCommentDraft).toHaveBeenCalledWith(scope, {
      connectionId: connection.id,
      issueId: "100",
      body: "Draft only",
    });
    expect(Object.keys(manager)).not.toContain("addComment");
  });

  it("fails closed when a manager returns a malformed Jira DTO", async () => {
    const { api, manager } = createApi();
    const unsafeProtocol = ["java", "script", ":"].join("");
    manager.issue.mockResolvedValue({ ...issue, url: `${unsafeProtocol}alert(1)`, accessToken: "secret" } as never);
    await expect(api.getIssue(scope, { connectionId: connection.id, issueId: "100" })).rejects.toMatchObject({
      code: "jira_unavailable",
    });
  });
});
