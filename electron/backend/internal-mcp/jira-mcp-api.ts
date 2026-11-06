import { lstat, mkdir, open, readdir, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import type { JiraConnection, JiraComment, JiraIssue, JiraManager } from "../jira/jira-manager.js";
import { InternalMcpError } from "./errors.js";
import { jiraMcpCallSucceeded, jiraUnavailableError } from "./jira-mcp-errors.js";
import type { JiraInternalMcpApi } from "./internal-mcp-broker.js";
import type { InternalMcpScope } from "./task-service.js";
import {
  jiraCommentDraftResultDtoSchema,
  jiraIssueDtoSchema,
  jiraCommentDtoSchema,
  jiraLinkedWorkDtoSchema,
  jiraMcpAttachmentDtoSchema,
  jiraProjectDtoSchema,
  jiraSavedFilterDtoSchema,
  jiraBoardDtoSchema,
  jiraBoardViewDtoSchema,
  jiraTransitionDtoSchema,
  jiraMcpConnectionDtoSchema,
  jiraSearchResultDtoSchema,
} from "../ipc-schemas.js";

export interface JiraMcpReader extends Pick<
  JiraManager,
  | "issue"
  | "search"
  | "searchPage"
  | "comments"
  | "projects"
  | "favoriteFilters"
  | "savedFilter"
  | "boardMetadata"
  | "boards"
  | "boardView"
  | "transitions"
> {
  attachmentBytes(
    connection: JiraConnection,
    issueId: string,
    attachmentId: string,
    options: { maxBytes: number; maxDurationMs: number },
  ): Promise<{ bytes: Uint8Array; mediaType: string }>;
  linkedWork(connection: JiraConnection, issueId: string): Promise<unknown>;
}

export interface JiraMcpApiOptions {
  manager: JiraMcpReader;
  listConnections(scope: InternalMcpScope): Promise<JiraConnection[]> | JiraConnection[];
  resolveConnection(scope: InternalMcpScope, connectionId: string): Promise<JiraConnection | undefined>;
  authorizeConnection(scope: InternalMcpScope, connectionId: string): Promise<boolean>;
  authorizeIssue(scope: InternalMcpScope, connectionId: string, issueIdOrKey: string): Promise<boolean>;
  managedDataRoot(scope: InternalMcpScope): Promise<string>;
  saveCommentDraft(
    scope: InternalMcpScope,
    input: { connectionId: string; issueId: string; body: string },
  ): Promise<{ draftId: string; createdAt: string }>;
  maxAttachmentBytes?: number;
  attachmentTimeoutMs?: number;
  maxAttachmentFiles?: number;
  maxAttachmentFolderBytes?: number;
  /** Live folder limits (the desktop setting); wins over the static options when given. */
  attachmentFolderLimits?: () => { maxFiles: number; maxMegabytes: number };
}

const MAX_RETURNED_TEXT = 20_000;
const MAX_COMMENTS = 100;
const MAX_LINKED_WORK = 100;
const SECRET_FIELD = /(?:access|refresh)?token|secret|cookie|authorization|password|credential|private.?key/i;

export function createJiraInternalMcpApi(options: JiraMcpApiOptions): JiraInternalMcpApi {
  const maxAttachmentBytes = Math.min(options.maxAttachmentBytes ?? 5 * 1024 * 1024, 10 * 1024 * 1024);
  const attachmentTimeoutMs = Math.min(options.attachmentTimeoutMs ?? 15_000, 20_000);
  const maxAttachmentFiles = Math.min(options.maxAttachmentFiles ?? 50, 500);
  const maxAttachmentFolderBytes = Math.min(options.maxAttachmentFolderBytes ?? 50 * 1024 * 1024, 500 * 1024 * 1024);
  if (
    !Number.isSafeInteger(maxAttachmentBytes) ||
    maxAttachmentBytes < 1 ||
    !Number.isSafeInteger(attachmentTimeoutMs) ||
    attachmentTimeoutMs < 1 ||
    !Number.isSafeInteger(maxAttachmentFiles) ||
    maxAttachmentFiles < 1 ||
    !Number.isSafeInteger(maxAttachmentFolderBytes) ||
    maxAttachmentFolderBytes < 1
  )
    throw new Error("Jira MCP attachment limits are invalid.");
  function folderLimits(): { maxFiles: number; maxBytes: number } {
    const live = options.attachmentFolderLimits?.();
    if (!live) return { maxFiles: maxAttachmentFiles, maxBytes: maxAttachmentFolderBytes };
    return { maxFiles: live.maxFiles, maxBytes: live.maxMegabytes * 1024 * 1024 };
  }
  const attachmentLocks = new Map<string, Promise<void>>();

  async function connection(scope: InternalMcpScope, connectionId: string): Promise<JiraConnection> {
    if (!(await options.authorizeConnection(scope, connectionId)))
      throw new InternalMcpError("scope_denied", "This Jira connection is outside the agent grant.");
    const found = await options.resolveConnection(scope, connectionId);
    if (!found || !found.enabled || found.profileId !== scope.profileId)
      throw new InternalMcpError("scope_denied", "This Jira connection is not available to the agent grant.");
    return found;
  }

  async function authorizeIssue(scope: InternalMcpScope, connectionId: string, issueIdOrKey: string): Promise<void> {
    if (!(await options.authorizeIssue(scope, connectionId, issueIdOrKey)))
      throw new InternalMcpError("scope_denied", "This Jira issue is outside the agent grant.");
  }

  async function safeCall<T>(operation: string, connectionId: string, call: () => Promise<T>): Promise<T> {
    try {
      const result = await call();
      jiraMcpCallSucceeded({ operation, connectionId });
      return result;
    } catch (error) {
      throw jiraUnavailableError(error, { operation, connectionId });
    }
  }

  return {
    listConnections: async (scope) => {
      const items = await options.listConnections(scope);
      const authorized = await Promise.all(
        items
          .filter((item) => item.enabled && item.profileId === scope.profileId)
          .slice(0, 100)
          .map(async (item) => ((await options.authorizeConnection(scope, item.id)) ? item : null)),
      );
      return jiraMcpConnectionDtoSchema
        .array()
        .max(100)
        .parse(
          authorized
            .filter((item): item is JiraConnection => item !== null)
            .map((item) => ({
              id: item.id,
              label: item.label,
              deployment: item.deployment,
              enabled: true,
              accountPurpose: item.accountPurpose,
            })),
        );
    },
    getIssue: (scope, input) =>
      safeCall("getIssue", input.connectionId, async () => {
        const jiraConnection = await connection(scope, input.connectionId);
        await authorizeIssue(scope, input.connectionId, input.issueId);
        const issue = await options.manager.issue(jiraConnection, input.issueId);
        await authorizeIssue(scope, input.connectionId, issue.ref.issueId);
        return jiraIssueDtoSchema.parse(sanitizeIssue(issue, jiraConnection.webUrl));
      }),
    search: (scope, input) =>
      safeCall("search", input.connectionId, async () => {
        const limit = Math.min(50, Math.max(1, Math.trunc(input.limit ?? 50)));
        const jiraConnection = await connection(scope, input.connectionId);
        const issues = await options.manager.search(jiraConnection, input.query, limit);
        const allowed = await Promise.all(
          issues
            .slice(0, limit)
            .map(async (issue) =>
              (await options.authorizeIssue(scope, input.connectionId, issue.ref.issueId))
                ? sanitizeIssue(issue, jiraConnection.webUrl)
                : null,
            ),
        );
        return jiraIssueDtoSchema
          .array()
          .max(50)
          .parse(allowed.filter((issue): issue is JiraIssue => issue !== null));
      }),
    myOpenIssues: (scope, input) =>
      safeCall("myOpenIssues", input.connectionId, async () => {
        const jiraConnection = await connection(scope, input.connectionId);
        const identity = jiraConnection.ownIdentity;
        const identityValue = identity?.kind === "cloud" ? identity.accountId : identity?.name;
        if (!identity || !identityValue)
          throw new InternalMcpError(
            "scope_denied",
            "A verified human Jira identity is not configured for this connection.",
          );
        const escaped = identityValue.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
        const query = `assignee = "${escaped}" AND statusCategory != Done ORDER BY updated DESC`;
        const limit = Math.min(50, Math.max(1, Math.trunc(input.limit ?? 50)));
        const page = await options.manager.searchPage(jiraConnection, query, limit, input.cursor);
        await connection(scope, input.connectionId);
        const allowed = await Promise.all(
          page.issues
            .slice(0, limit)
            .map(async (issue) =>
              (await options.authorizeIssue(scope, input.connectionId, issue.ref.issueId))
                ? sanitizeIssue(issue, jiraConnection.webUrl)
                : null,
            ),
        );
        return jiraSearchResultDtoSchema.parse({
          issues: allowed.filter((issue): issue is JiraIssue => issue !== null),
          hasMore: page.hasMore,
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
          truncated: page.truncated,
        });
      }),
    getComments: (scope, input) =>
      safeCall("getComments", input.connectionId, async () => {
        const jiraConnection = await connection(scope, input.connectionId);
        await authorizeIssue(scope, input.connectionId, input.issueId);
        const comments = await options.manager.comments(jiraConnection, input.issueId);
        await authorizeIssue(scope, input.connectionId, input.issueId);
        return (
          jiraCommentDtoSchema
            .array()
            .max(MAX_COMMENTS)
            // Comments come oldest-first; an agent needs the latest discussion, so a long thread keeps its tail.
            .parse(comments.slice(-MAX_COMMENTS).map(sanitizeComment))
        );
      }),
    listProjects: (scope, input) =>
      safeCall("listProjects", input.connectionId, async () => {
        const result = await options.manager.projects(await connection(scope, input.connectionId));
        await connection(scope, input.connectionId);
        return jiraProjectDtoSchema.array().max(100).parse(result.slice(0, 100));
      }),
    listFilters: (scope, input) =>
      safeCall("listFilters", input.connectionId, async () => {
        const result = await options.manager.favoriteFilters(await connection(scope, input.connectionId));
        await connection(scope, input.connectionId);
        return jiraSavedFilterDtoSchema.array().max(20).parse(result.slice(0, 20));
      }),
    getFilter: (scope, input) =>
      safeCall("getFilter", input.connectionId, async () => {
        const jiraConnection = await connection(scope, input.connectionId);
        const result = await options.manager.savedFilter(jiraConnection, input.filterId);
        await connection(scope, input.connectionId);
        return jiraSavedFilterDtoSchema.parse(result);
      }),
    listBoards: (scope, input) =>
      safeCall("listBoards", input.connectionId, async () => {
        const result = await options.manager.boards(await connection(scope, input.connectionId));
        await connection(scope, input.connectionId);
        return jiraBoardDtoSchema.array().max(500).parse(result.slice(0, 500));
      }),
    boardView: (scope, input) =>
      safeCall("boardView", input.connectionId, async () => {
        const jiraConnection = await connection(scope, input.connectionId);
        if (input.mode === "sprints") {
          const board = await options.manager.boardMetadata(jiraConnection, input.boardId);
          if (board.type === "kanban")
            throw new InternalMcpError("jira_unavailable", "Sprint views are only available for Scrum boards.");
        }
        const result = await options.manager.boardView(
          jiraConnection,
          input.boardId,
          input.mode,
          input.cursor,
          input.sprintId,
        );
        await connection(scope, input.connectionId);
        return jiraBoardViewDtoSchema.parse({
          ...result,
          issues: result.issues.slice(0, 100).map((issue) => sanitizeIssue(issue, jiraConnection.webUrl)),
        });
      }),
    activeSprint: (scope, input) =>
      safeCall("activeSprint", input.connectionId, async () => {
        const jiraConnection = await connection(scope, input.connectionId);
        const board = await options.manager.boardMetadata(jiraConnection, input.boardId);
        if (board.type === "kanban")
          throw new InternalMcpError("jira_unavailable", "Sprint views are only available for Scrum boards.");
        const discovery = await options.manager.boardView(jiraConnection, input.boardId, "sprints");
        const active = discovery.sprints?.find((sprint) => sprint.state === "active");
        await connection(scope, input.connectionId);
        if (!active) {
          const withoutCursors = { ...discovery };
          delete withoutCursors.nextCursor;
          delete withoutCursors.sprintsNextCursor;
          delete withoutCursors.selectedSprintId;
          return jiraBoardViewDtoSchema.parse({
            ...withoutCursors,
            sprints: [],
            issues: [],
            hasMore: false,
            truncated: false,
            sprintsHasMore: false,
          });
        }
        const detail = await options.manager.boardView(
          jiraConnection,
          input.boardId,
          "sprints",
          undefined,
          Number(active.id),
        );
        await connection(scope, input.connectionId);
        const allowedIssues = await Promise.all(
          detail.issues.map(async (issue) =>
            (await options.authorizeIssue(scope, input.connectionId, issue.ref.issueId))
              ? sanitizeIssue(issue, jiraConnection.webUrl)
              : null,
          ),
        );
        return jiraBoardViewDtoSchema.parse({
          ...detail,
          sprints: [active],
          issues: allowedIssues.filter((issue): issue is JiraIssue => issue !== null),
          selectedSprintId: Number(active.id),
        });
      }),
    getTransitions: (scope, input) =>
      safeCall("getTransitions", input.connectionId, async () => {
        const jiraConnection = await connection(scope, input.connectionId);
        await authorizeIssue(scope, input.connectionId, input.issueId);
        const transitions = await options.manager.transitions(jiraConnection, input.issueId);
        await authorizeIssue(scope, input.connectionId, input.issueId);
        return jiraTransitionDtoSchema.array().max(100).parse(transitions.slice(0, 100));
      }),
    getAttachment: (scope, input) =>
      safeCall("getAttachment", input.connectionId, async () => {
        const jiraConnection = await connection(scope, input.connectionId);
        await authorizeIssue(scope, input.connectionId, input.issueId);
        const actualRoot = await attachmentDirectory(scope, options.managedDataRoot);
        const fileName = path.basename(input.fileName);
        if (
          fileName !== input.fileName ||
          fileName === "." ||
          fileName === ".." ||
          !/^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/.test(fileName)
        )
          throw new InternalMcpError("file_not_accessible", "The attachment target name is invalid.");
        const target = path.resolve(actualRoot, fileName);
        if (path.dirname(target) !== actualRoot)
          throw new InternalMcpError("file_not_accessible", "The attachment target is outside the managed folder.");
        const downloaded = await options.manager.attachmentBytes(jiraConnection, input.issueId, input.attachmentId, {
          maxBytes: maxAttachmentBytes,
          maxDurationMs: attachmentTimeoutMs,
        });
        await authorizeIssue(scope, input.connectionId, input.issueId);
        if (!(downloaded.bytes instanceof Uint8Array) || downloaded.bytes.byteLength > maxAttachmentBytes)
          throw new InternalMcpError("file_not_accessible", "The attachment exceeds the allowed size.");
        await withAttachmentLock(actualRoot, attachmentLocks, async () => {
          const limits = folderLimits();
          if (downloaded.bytes.byteLength > limits.maxBytes)
            throw new InternalMcpError(
              "file_not_accessible",
              `The attachment is larger than the ${Math.round(limits.maxBytes / (1024 * 1024))} MB agent attachment folder limit. Raise it in Settings → Jira → Agent attachment folder.`,
            );
          const files: Array<{ name: string; size: number; mtimeMs: number }> = [];
          for (const name of await readdir(actualRoot)) {
            const info = await lstat(path.join(actualRoot, name)).catch(() => null);
            if (info?.isFile()) files.push({ name, size: info.size, mtimeMs: info.mtimeMs });
          }
          const existing = await lstat(target)
            .then(() => true)
            .catch((error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return false;
              throw error;
            });
          if (existing) throw new InternalMcpError("file_not_accessible", "The attachment target already exists.");
          let totalBytes = files.reduce((sum, file) => sum + file.size, 0);
          files.sort((left, right) => left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name));
          while (
            files.length > 0 &&
            (files.length >= limits.maxFiles || totalBytes + downloaded.bytes.byteLength > limits.maxBytes)
          ) {
            const oldest = files.shift()!;
            await unlink(path.join(actualRoot, oldest.name)).catch((error: NodeJS.ErrnoException) => {
              if (error.code !== "ENOENT") throw error;
            });
            totalBytes -= oldest.size;
          }
          const handle = await open(target, "wx", 0o600);
          try {
            await handle.writeFile(downloaded.bytes);
          } finally {
            await handle.close();
          }
        });
        return jiraMcpAttachmentDtoSchema.parse({
          fileName,
          filePath: target,
          mediaType: safeMediaType(downloaded.mediaType),
          sizeBytes: downloaded.bytes.byteLength,
        });
      }),
    linkedWork: (scope, input) =>
      safeCall("linkedWork", input.connectionId, async () => {
        const jiraConnection = await connection(scope, input.connectionId);
        await authorizeIssue(scope, input.connectionId, input.issueId);
        const result = await options.manager.linkedWork(jiraConnection, input.issueId);
        await authorizeIssue(scope, input.connectionId, input.issueId);
        return jiraLinkedWorkDtoSchema.array().max(MAX_LINKED_WORK).parse(sanitizeValue(result, 0));
      }),
    proposeComment: async (scope, input) => {
      await connection(scope, input.connectionId);
      await authorizeIssue(scope, input.connectionId, input.issueId);
      try {
        const draft = await options.saveCommentDraft(scope, input);
        return jiraCommentDraftResultDtoSchema.parse({
          draftId: draft.draftId,
          createdAt: draft.createdAt,
          status: "draft",
          reviewLocation: "Jira workspace → Agent comment drafts",
          message: "Saved for review only; nothing was posted to Jira.",
        });
      } catch (error) {
        if (error instanceof InternalMcpError) throw error;
        throw new InternalMcpError("jira_draft_not_saved", "The Jira comment draft could not be saved.", {
          cause: error,
        });
      }
    },
  };
}

async function withAttachmentLock<T>(
  root: string,
  locks: Map<string, Promise<void>>,
  action: () => Promise<T>,
): Promise<T> {
  const prior = locks.get(root) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = prior.then(() => current);
  locks.set(root, queued);
  await prior;
  try {
    return await action();
  } finally {
    release();
    if (locks.get(root) === queued) locks.delete(root);
  }
}

async function attachmentDirectory(
  scope: InternalMcpScope,
  managedDataRoot: (scope: InternalMcpScope) => Promise<string>,
): Promise<string> {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(scope.profileId) ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(scope.workspaceId)
  )
    throw new InternalMcpError("file_not_accessible", "The granted workspace has an invalid identifier.");
  const configuredRoot = path.resolve(await managedDataRoot(scope));
  await mkdir(configuredRoot, { recursive: true });
  const base = await realpath(configuredRoot);
  let parent = base;
  for (const segment of [scope.profileId, scope.workspaceId, "jira-attachments"]) {
    const child = path.join(parent, segment);
    await mkdir(child).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    const info = await lstat(child);
    if (info.isSymbolicLink())
      throw new InternalMcpError("file_not_accessible", "The managed attachment folder cannot contain links.");
    const resolved = await realpath(child);
    const relative = path.relative(base, resolved);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      throw new InternalMcpError("file_not_accessible", "The managed attachment folder escaped its data root.");
    parent = resolved;
  }
  return parent;
}

function sanitizeIssue(issue: JiraIssue, connectionWebUrl: string): JiraIssue {
  return {
    ref: {
      provider: "jira",
      connectionId: issue.ref.connectionId,
      issueId: clip(issue.ref.issueId, 128),
      issueKey: clip(issue.ref.issueKey, 128),
    },
    summary: clip(issue.summary, MAX_RETURNED_TEXT),
    status: clip(issue.status, 256),
    issueType: clip(issue.issueType, 256),
    projectKey: clip(issue.projectKey, 128),
    updated: clip(issue.updated, 128),
    ...(issue.assignee ? { assignee: clip(issue.assignee, 256) } : {}),
    url: safeIssueUrl(issue.url, connectionWebUrl),
    ...(issue.description ? { description: clip(issue.description, MAX_RETURNED_TEXT) } : {}),
    ...(issue.attachments
      ? {
          attachments: issue.attachments.slice(0, 100).map((attachment) => ({
            id: clip(attachment.id, 32),
            fileName: clip(attachment.fileName.replace(/[\\/\0-\x1f]/g, "_"), 128),
            mediaType: safeMediaType(attachment.mediaType),
            sizeBytes: Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(attachment.sizeBytes))),
          })),
        }
      : {}),
  };
}

function sanitizeComment(comment: JiraComment): JiraComment {
  return {
    id: clip(comment.id, 128),
    author: clip(comment.author, 256),
    created: clip(comment.created, 128),
    ...(comment.updated ? { updated: clip(comment.updated, 128) } : {}),
    body: clip(comment.body, MAX_RETURNED_TEXT),
  };
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (depth > 8) return null;
  if (typeof value === "string") return clip(value, MAX_RETURNED_TEXT);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, MAX_LINKED_WORK).map((item) => sanitizeValue(item, depth + 1));
  if (typeof value !== "object") return null;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !SECRET_FIELD.test(key))
      .slice(0, 100)
      .map(([key, child]) => [clip(key, 128), sanitizeValue(child, depth + 1)]),
  );
}

function safeIssueUrl(value: string, expectedBase: string): string {
  try {
    const url = new URL(value);
    const base = new URL(expectedBase);
    return url.protocol === "https:" &&
      url.origin === base.origin &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
      ? url.toString()
      : "";
  } catch {
    return "";
  }
}

function safeMediaType(value: string): string {
  return /^[a-z0-9][a-z0-9.+-]{0,63}\/[a-z0-9][a-z0-9.+-]{0,63}$/i.test(value) ? value : "application/octet-stream";
}

function clip(value: string, max: number): string {
  return value.slice(0, max);
}
