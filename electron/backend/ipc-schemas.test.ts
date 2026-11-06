import { describe, expect, test } from "vitest";
import {
  validateIpc,
  workspaceSchema,
  reviewBridgeQueueSchema,
  reviewGitStartSchema,
  workspaceIdSchema,
  workspaceDeleteOptionsSchema,
  azureCommentSchema,
  azureVoteSchema,
  azureThreadStatusSchema,
  gitBranchDeleteSchema,
  gitBranchListSchema,
  gitBranchRenameSchema,
  gitCheckoutRemoteSchema,
  gitPayloadSchema,
  gitTagSchema,
  quickFixCreateSchema,
  githubQuickFixCreateSchema,
  gitInterestSchema,
  wsGitInterestSchema,
  gitDiffPreviewSchema,
  gitLogPageSchema,
  gitLogGraphSchema,
  gitStageFileSchema,
  gitStageHunkSchema,
  gitCommitStagedSchema,
  workspaceUIStateSchema,
  settingsSchema,
  gitRemoteBranchDeleteSchema,
  terminalResizeSchema,
  profileSchema,
  worktreeSchema,
  removeWorktreeSchema,
  dockerSessionSchema,
  approvalAuditLogQuerySchema,
  mobileCreatePairingInvitationSchema,
  mobileRenameDeviceSchema,
  mobileUpdateDeviceAllowlistSchema,
  mobileAuditLogQuerySchema,
  telegramConnectionSchema,
  accountSignInStartSchema,
  onlineBootstrapStateOutputSchema,
  sanitizeAccountUiStateOutput,
  sshKeyTransferStartSchema,
  startReviewAgentPreparationSchema,
  jiraConnectionDtoSchema,
  jiraConnectionSaveSchema,
  jiraSavedQueryDtoSchema,
  jiraCommentDraftDtoSchema,
  jiraProjectDtoSchema,
  jiraVerifyConnectionDtoSchema,
  jiraTaskContextDtoSchema,
  jiraWriteInvokeResultDtoSchema,
  jiraLinkedWorkDtoSchema,
  jiraBoardSearchSchema,
  jiraBoardSearchResultDtoSchema,
  jiraSearchSchema,
  jiraIssueLookupSchema,
  jiraRecentListSchema,
  jiraWorkspaceViewsGetSchema,
  jiraWorkspaceProjectScopeGetSchema,
  jiraWorkspaceProjectScopeSetSchema,
  jiraWorkspaceViewSaveSchema,
  jiraWorkspaceViewRenameSchema,
  jiraWorkspaceViewReorderSchema,
  jiraWorkspaceViewTargetSchema,
  jiraWorkspaceViewRefreshSchema,
  jiraRememberSearchSchema,
  jiraRememberIssueViewedSchema,
  jiraRecentIssuesDtoSchema,
  jiraOwnIdentitySchema,
  jiraCommentAttributionSchema,
  jiraOwnIssuesQuerySchema,
} from "./ipc-schemas.js";

describe("ipc-schemas", () => {
  test("Jira project scope is bounded, normalized, and distinguishes inherited scope from all projects", () => {
    expect(jiraSearchSchema.parse({ connectionId: "jira-a", jql: "", projectKeys: [" ops "] }).projectKeys).toEqual([
      "OPS",
    ]);
    expect(jiraSearchSchema.parse({ connectionId: "jira-a", jql: "", projectKeys: [] }).projectKeys).toEqual([]);
    expect(jiraSearchSchema.safeParse({ connectionId: "jira-a", jql: "", projectKeys: ["OPS; DROP"] }).success).toBe(
      false,
    );
    expect(
      jiraSearchSchema.safeParse({ connectionId: "jira-a", jql: "", projectKeys: Array(51).fill("OPS") }).success,
    ).toBe(false);
    expect(jiraWorkspaceProjectScopeGetSchema.parse({ workspaceId: "jira-ws", connectionId: "jira-a" })).toEqual({
      workspaceId: "jira-ws",
      connectionId: "jira-a",
    });
    expect(
      jiraWorkspaceProjectScopeSetSchema.parse({
        workspaceId: "jira-ws",
        connectionId: "jira-a",
        projectKeys: null,
      }).projectKeys,
    ).toBeNull();
  });

  test("Jira workspace-view APIs strictly validate scoped targets and bounded view config", () => {
    expect(jiraWorkspaceViewsGetSchema.parse({ workspaceId: "jira-ws" })).toEqual({ workspaceId: "jira-ws" });
    expect(jiraWorkspaceViewsGetSchema.safeParse({ workspaceId: "jira-ws", profileId: "p2" }).success).toBe(false);
    expect(
      jiraWorkspaceViewRenameSchema.parse({ workspaceId: "jira-ws", viewId: "opaque", title: "Platform" }),
    ).toMatchObject({ title: "Platform" });
    expect(
      jiraWorkspaceViewRenameSchema.safeParse({ workspaceId: "jira-ws", viewId: "issues", title: " " }).success,
    ).toBe(false);
    expect(jiraWorkspaceViewReorderSchema.safeParse({ workspaceId: "jira-ws", viewIds: ["a", "a"] }).success).toBe(
      false,
    );
    expect(
      jiraWorkspaceViewReorderSchema.safeParse({
        workspaceId: "jira-ws",
        viewIds: Array.from({ length: 51 }, (_, i) => String(i)),
      }).success,
    ).toBe(false);
    expect(jiraWorkspaceViewTargetSchema.safeParse({ workspaceId: "jira-ws", viewId: "opaque" }).success).toBe(true);
    expect(jiraWorkspaceViewTargetSchema.safeParse({ workspaceId: "jira-ws", viewId: "x".repeat(129) }).success).toBe(
      false,
    );
    expect(jiraWorkspaceViewRefreshSchema.parse({ workspaceId: "jira-ws" })).toEqual({ workspaceId: "jira-ws" });
    expect(jiraWorkspaceViewRefreshSchema.safeParse({ workspaceId: "jira-ws", viewId: "x", extra: true }).success).toBe(
      false,
    );

    const saveInput = {
      workspaceId: "jira-ws",
      view: {
        kind: "board",
        connectionId: "jira-a",
        boardId: 7,
        title: "Platform",
        quickFilterIds: [2],
      },
    };
    expect(jiraWorkspaceViewSaveSchema.parse(saveInput)).toEqual(saveInput);
    expect(
      jiraWorkspaceViewSaveSchema.parse({
        workspaceId: "jira-ws",
        view: { kind: "personal", connectionId: "jira-a", personalScope: "all" },
      }).view.personalScope,
    ).toBe("all");
    expect(
      jiraWorkspaceViewSaveSchema.safeParse({
        workspaceId: "jira-ws",
        view: { kind: "board", connectionId: "jira-a", boardId: 7, personalScope: "all" },
      }).success,
    ).toBe(false);
    expect(jiraOwnIssuesQuerySchema.parse({ connectionId: "jira-a", personalScope: "all" }).personalScope).toBe("all");
    expect(
      jiraOwnIssuesQuerySchema.parse({ connectionId: "jira-a", smartFilters: ["watching", "current-sprint"] })
        .smartFilters,
    ).toEqual(["watching", "current-sprint"]);
    expect(jiraOwnIssuesQuerySchema.safeParse({ connectionId: "jira-a", smartFilters: ["assignee = x"] }).success).toBe(
      false,
    );
    expect(
      jiraWorkspaceViewSaveSchema.parse({
        ...saveInput,
        view: { ...saveInput.view, presentation: "list", statusFilter: null },
      }).view,
    ).toMatchObject({ presentation: "list", statusFilter: null });
    expect(
      jiraWorkspaceViewSaveSchema.parse({
        ...saveInput,
        view: { ...saveInput.view, projectKeys: null },
      }).view.projectKeys,
    ).toBeNull();
    expect(
      jiraWorkspaceViewSaveSchema.parse({
        ...saveInput,
        view: { ...saveInput.view, projectKeys: [] },
      }).view.projectKeys,
    ).toEqual([]);
    expect(
      jiraWorkspaceViewSaveSchema.safeParse({
        ...saveInput,
        view: { ...saveInput.view, boardId: null },
      }).success,
    ).toBe(false);
    expect(
      jiraWorkspaceViewSaveSchema.safeParse({
        ...saveInput,
        view: { ...saveInput.view, quickFilterIds: Array.from({ length: 51 }, (_, index) => index + 1) },
      }).success,
    ).toBe(false);
    expect(
      jiraWorkspaceViewSaveSchema.safeParse({
        ...saveInput,
        view: { ...saveInput.view, profileId: "other-profile" },
      }).success,
    ).toBe(false);
  });

  test("Jira comment attribution is strict and bounded", () => {
    const ok = { enabled: true, text: "On behalf of {user}", position: "before" };
    expect(jiraCommentAttributionSchema.safeParse(ok).success).toBe(true);
    expect(jiraCommentAttributionSchema.safeParse({ ...ok, text: "" }).success).toBe(true);
    expect(jiraCommentAttributionSchema.safeParse({ ...ok, text: "x".repeat(501) }).success).toBe(false);
    expect(jiraCommentAttributionSchema.safeParse({ ...ok, position: "middle" }).success).toBe(false);
    expect(jiraCommentAttributionSchema.safeParse({ ...ok, enabled: "yes" }).success).toBe(false);
    expect(jiraCommentAttributionSchema.safeParse({ ...ok, profileId: "spoof" }).success).toBe(false);
  });

  test("Jira recent history is bounded and cannot select another profile", () => {
    expect(jiraOwnIdentitySchema.safeParse({ connectionId: "jira-a", userId: "alice" }).success).toBe(true);
    expect(jiraOwnIdentitySchema.safeParse({ connectionId: "jira-a", userId: " " }).success).toBe(false);
    expect(
      jiraOwnIdentitySchema.safeParse({ connectionId: "jira-a", userId: "alice", profileId: "spoof" }).success,
    ).toBe(false);
    expect(jiraRecentListSchema.parse({ connectionId: "jira-a", limit: 20 }).limit).toBe(20);
    expect(jiraRecentListSchema.safeParse({ connectionId: "jira-a", limit: 21 }).success).toBe(false);
    expect(jiraRecentListSchema.safeParse({ connectionId: "jira-a", profileId: "other" }).success).toBe(false);
    expect(jiraRememberSearchSchema.safeParse({ connectionId: "jira-a", jql: " ", label: "Empty" }).success).toBe(
      false,
    );
    expect(
      jiraRememberIssueViewedSchema.safeParse({
        ref: { provider: "github", connectionId: "jira-a", issueId: "1", issueKey: "OPS-1" },
      }).success,
    ).toBe(false);
    expect(
      jiraRecentIssuesDtoSchema.safeParse([
        {
          ref: { provider: "jira", connectionId: "jira-a", issueId: "1", issueKey: "OPS-1" },
          summary: "Cached",
          status: "Open",
          viewedAt: 1,
          description: "must not be sent in a recent summary",
        },
      ]).success,
    ).toBe(false);
  });

  test("Jira cache-first and background flags survive input validation", () => {
    const flags = { cacheOnly: true, forceRefresh: false, refreshInBackground: true };
    expect(jiraSearchSchema.parse({ connectionId: "jira-a", jql: "key = OPS-1", ...flags })).toMatchObject(flags);
    expect(jiraIssueLookupSchema.parse({ connectionId: "jira-a", issueId: "1", ...flags })).toMatchObject(flags);
    expect(jiraSearchSchema.safeParse({ connectionId: "jira-a", refreshInBackground: "true" }).success).toBe(false);
  });

  test("Jira board search uses bounded pages and a validated offset cursor", () => {
    expect(jiraBoardSearchSchema.parse({ connectionId: "jira-a", query: " Platform " })).toEqual({
      connectionId: "jira-a",
      query: "Platform",
      limit: 50,
    });
    expect(jiraBoardSearchSchema.safeParse({ connectionId: "jira-a", limit: 101 }).success).toBe(false);
    expect(jiraBoardSearchSchema.safeParse({ connectionId: "jira-a", cursor: "1x" }).success).toBe(false);
    expect(
      jiraBoardSearchResultDtoSchema.safeParse({
        boards: [{ id: 1, name: "Platform", type: "kanban" }],
        hasMore: true,
        nextCursor: "50",
        truncated: true,
      }).success,
    ).toBe(true);
  });

  test("Jira output DTOs reject secrets, unbounded lists, and arbitrary task snapshot fields", () => {
    const connection = {
      id: "c",
      profileId: "p",
      label: "Jira",
      enabled: true,
      deployment: "cloud",
      webUrl: "https://x.atlassian.net",
      apiBaseUrl: "",
      auth: { kind: "cloud-api-token", email: "me@example.com" },
      accountPurpose: "personal",
    };
    expect(jiraConnectionDtoSchema.safeParse(connection).success).toBe(true);
    expect(
      jiraConnectionDtoSchema.safeParse({
        ...connection,
        deployment: "data-center",
        apiBaseUrl: "https://gateway.example.com/prefix",
        auth: { kind: "dc-apim" },
        subscriptionHeaderName: "Ocp-Apim-Subscription-Key",
        clientCertificatePath: "C:\\certs\\jira.pfx",
      }).success,
    ).toBe(true);
    expect(
      jiraConnectionDtoSchema.safeParse({ ...connection, auth: { kind: "cloud-api-token", accessToken: "secret" } })
        .success,
    ).toBe(false);
    expect(
      jiraConnectionDtoSchema.safeParse({ ...connection, auth: { kind: "dc-apim", passphraseRef: "secret-ref" } })
        .success,
    ).toBe(false);
    expect(
      jiraConnectionSaveSchema.safeParse({
        label: "Gateway",
        deployment: "data-center",
        webUrl: "https://jira.example.com",
        apiBaseUrl: "https://gateway.example.com/prefix",
        authMode: "apim",
        subscriptionKey: "temporary-test-key",
        subscriptionHeaderName: "Ocp-Apim-Subscription-Key",
        clientCertificatePath: "C:\\certs\\jira.pfx",
        clientCertificatePassword: "temporary-test-password",
      }).success,
    ).toBe(true);
    expect(
      jiraSavedQueryDtoSchema.safeParse({
        id: "q",
        profileId: "p",
        connectionId: "c",
        name: "Q",
        jql: "project=ABC",
        notificationsEnabled: false,
        updatedAt: "now",
        refreshToken: "secret",
      }).success,
    ).toBe(false);
    expect(
      jiraCommentDraftDtoSchema.safeParse({
        id: "d",
        ref: { provider: "jira", connectionId: "c", issueId: "1", issueKey: "ABC-1" },
        body: "draft",
        sourceWorkspaceId: "w",
        createdAt: "now",
        accessToken: "secret",
      }).success,
    ).toBe(false);
    expect(jiraProjectDtoSchema.safeParse({ id: "1", key: "ABC", name: "Project", raw: { token: "x" } }).success).toBe(
      false,
    );
    expect(
      jiraVerifyConnectionDtoSchema.safeParse({
        identity: { kind: "cloud", accountId: "a", displayName: "Bot" },
        serverTitle: "Jira",
        rawResponse: { accessToken: "secret" },
      }).success,
    ).toBe(false);
    const badTask = {
      jiraIssueRefs: [],
      jiraPreparedSnapshot: [{ ref: { connectionId: "c", issueId: "1" }, fields: { comments: "private" } }],
      jiraIssueSnapshots: [],
    };
    expect(jiraTaskContextDtoSchema.safeParse(badTask).success).toBe(false);
    expect(
      jiraTaskContextDtoSchema.safeParse({
        jiraIssueRefs: [],
        jiraPreparedSnapshot: [],
        jiraIssueSnapshots: [],
        refreshToken: "secret",
      }).success,
    ).toBe(false);
  });

  test("Jira write envelopes and MCP linked-work DTOs are bounded clone-safe allowlists", () => {
    const safe = {
      ok: false,
      error: { code: "jira-write-unknown", message: "Reconcile before retrying.", journalId: "j1", status: "unknown" },
    };
    expect(jiraWriteInvokeResultDtoSchema.parse(JSON.parse(JSON.stringify(safe)))).toEqual(safe);
    expect(jiraWriteInvokeResultDtoSchema.safeParse({ ...safe, rawProviderError: { body: "secret" } }).success).toBe(
      false,
    );
    expect(
      jiraWriteInvokeResultDtoSchema.safeParse({
        ok: true,
        data: { status: "succeeded", journalId: "j1", result: { body: "comment" } },
      }).success,
    ).toBe(false);
    expect(
      jiraLinkedWorkDtoSchema.safeParse([
        { id: "1", url: "https://github.com/org/repo/pull/1", title: "PR", accessToken: "secret" },
      ]).success,
    ).toBe(false);
  });
  test("review Git operation starts accept an optional bounded idempotency key", () => {
    expect(reviewGitStartSchema.safeParse({ kind: "push", workspaceId: "ws-1" }).success).toBe(true);
    expect(
      reviewGitStartSchema.safeParse({ kind: "push", workspaceId: "ws-1", idempotencyKey: "retry-key-123" }).success,
    ).toBe(true);
    expect(reviewGitStartSchema.safeParse({ kind: "push", workspaceId: "ws-1", idempotencyKey: "short" }).success).toBe(
      false,
    );
  });

  test("validates stage-file paths and non-empty commit-staged messages", () => {
    expect(validateIpc(gitStageFileSchema, { workspaceId: "ws", path: "src/a.ts" }, "git:stage-file")).toMatchObject({
      workspaceId: "ws",
      path: "src/a.ts",
    });
    for (const path of ["-A", "/absolute", ""]) {
      expect(() => validateIpc(gitStageFileSchema, { workspaceId: "ws", path }, "git:stage-file")).toThrow();
    }
    expect(() =>
      validateIpc(gitCommitStagedSchema, { workspaceId: "ws", message: "  " }, "git:commit-staged"),
    ).toThrow();
    expect(() =>
      validateIpc(gitStageHunkSchema, { workspaceId: "ws", path: "a", diffToken: "bad", hunk: "@@" }, "git:stage-hunk"),
    ).toThrow();
  });
  test("preserves partial Git UI settings while accepting retired fields from older clients", () => {
    expect(
      validateIpc(settingsSchema, { git: { ui: { newView: false, showAllActions: true } } }, "settings:update"),
    ).toMatchObject({ git: { ui: { newView: false, showAllActions: true } } });
    expect(validateIpc(settingsSchema, { git: { ui: { updateStrategy: "merge" } } }, "settings:update")).toMatchObject({
      git: { ui: { updateStrategy: "merge" } },
    });
  });
  test("validates persisted Git view preference ids", () => {
    expect(
      validateIpc(
        workspaceUIStateSchema,
        { workspaceId: "ws", uiState: { gitViewPreferences: { "profile::ws::root::pr": "review" } } },
        "workspace:set-ui-state",
      ).uiState.gitViewPreferences,
    ).toEqual({ "profile::ws::root::pr": "review" });
    expect(() =>
      validateIpc(
        workspaceUIStateSchema,
        { workspaceId: "ws", uiState: { gitViewPreferences: { "profile::ws::root::pr": "checkout" } } },
        "workspace:set-ui-state",
      ),
    ).toThrow();
  });
  describe("sshKeyTransferStartSchema", () => {
    const base = { profileId: "default", keyId: "key-1" };
    const draft = {
      host: "mini.local",
      username: "alice",
      advanced: { launchVia: "ssh2" },
    };

    test("accepts exactly one saved host ID or validated draft", () => {
      expect(sshKeyTransferStartSchema.parse({ ...base, hostId: "host-1" })).toMatchObject({ hostId: "host-1" });
      expect(sshKeyTransferStartSchema.parse({ ...base, draft })).toMatchObject({ draft });
    });

    test("rejects missing or ambiguous target and malformed draft", () => {
      for (const value of [
        base,
        { ...base, hostId: "host-1", draft },
        { ...base, draft: { ...draft, host: "" } },
        { ...base, draft: { ...draft, port: 0 } },
      ]) {
        expect(() => sshKeyTransferStartSchema.parse(value)).toThrow();
      }
    });
  });

  test("validates the per-connection Telegram notification forwarding choice", () => {
    expect(
      validateIpc(
        telegramConnectionSchema,
        { id: "tg-1", enabled: true, notificationsEnabled: false },
        "telegram:save",
      ),
    ).toMatchObject({ id: "tg-1", enabled: true, notificationsEnabled: false });
    expect(() => validateIpc(telegramConnectionSchema, { notificationsEnabled: "off" }, "telegram:save")).toThrow(
      /IPC validation failed/,
    );
  });

  describe("reviewBridgeQueueSchema", () => {
    test("accepts exactly one queue identifier for direct draft and latest-by-comment operations", () => {
      expect(
        validateIpc(reviewBridgeQueueSchema, { prKey: "pr-1", draftId: "draft-1" }, "review-bridge:draft:queue"),
      ).toEqual({ prKey: "pr-1", draftId: "draft-1" });
      expect(
        validateIpc(reviewBridgeQueueSchema, { prKey: "pr-1", commentKey: "comment-1" }, "review-bridge:draft:queue"),
      ).toEqual({ prKey: "pr-1", commentKey: "comment-1" });
    });

    test("rejects missing, empty, or ambiguous queue identifiers", () => {
      for (const value of [
        { prKey: "pr-1" },
        { prKey: "pr-1", draftId: "" },
        { prKey: "pr-1", commentKey: "" },
        { prKey: "pr-1", draftId: "draft-1", commentKey: "comment-1" },
      ]) {
        expect(() => validateIpc(reviewBridgeQueueSchema, value, "review-bridge:draft:queue")).toThrow();
      }
    });
  });

  describe("validateIpc", () => {
    test("validates Git view interest identity and ordering", () => {
      const valid = {
        viewId: "view-1",
        workspaceId: "ws-1",
        rootPath: "/repo",
        scope: "detail",
        active: true,
        generation: 2,
      };
      expect(gitInterestSchema.safeParse(valid).success).toBe(true);
      expect(gitInterestSchema.safeParse({ ...valid, generation: -1 }).success).toBe(false);
      expect(gitInterestSchema.safeParse({ ...valid, rootPath: "x".repeat(4097) }).success).toBe(false);
    });
    test("validates typed WebSocket Git interests", () => {
      const valid = {
        type: "git:interest",
        viewId: "pane-uuid",
        workspaceId: "ws-1",
        rootPath: "/repo",
        scope: "detail",
        active: true,
        generation: 1,
      };
      expect(wsGitInterestSchema.safeParse(valid).success).toBe(true);
      expect(wsGitInterestSchema.safeParse({ ...valid, viewId: "x".repeat(201) }).success).toBe(false);
      expect(wsGitInterestSchema.safeParse({ ...valid, rootPath: "x".repeat(4097) }).success).toBe(false);
    });
    test("returns validated data on success", () => {
      const result = validateIpc(gitPayloadSchema, { workspaceId: "ws-1" }, "test");
      expect(result.workspaceId).toBe("ws-1");
    });

    test("throws descriptive error on failure", () => {
      expect(() => validateIpc(gitPayloadSchema, {}, "git:fetch")).toThrow(/IPC validation failed on 'git:fetch'/);
    });

    test("throws on null payload", () => {
      expect(() => validateIpc(gitPayloadSchema, null, "test")).toThrow();
    });

    test("validates optional long Git idempotency keys", () => {
      expect(gitPayloadSchema.safeParse({ workspaceId: "ws-1", idempotencyKey: "client-op-1" }).success).toBe(true);
      expect(gitPayloadSchema.safeParse({ workspaceId: "ws-1", idempotencyKey: "" }).success).toBe(false);
      expect(gitPayloadSchema.safeParse({ workspaceId: "ws-1", idempotencyKey: "x".repeat(201) }).success).toBe(false);
    });
  });

  describe("accountSignInStartSchema", () => {
    // Regression: account-manager.ts's `revoke-device` purpose (plan §7/C2) is only reachable if the
    // IPC boundary in front of it accepts the value at all — every other test for this purpose drives
    // AccountManager or the Vue store directly and never exercises this Zod schema, which is exactly
    // how it stayed missing from the enum after the purpose itself was added.
    test("accepts the revoke-device purpose, with its packed target as offerId", () => {
      const result = validateIpc(
        accountSignInStartSchema,
        { email: "owner@example.test", purpose: "revoke-device", offerId: '["mobile-device","abcd1234"]' },
        "account:sign-in:start",
      );
      expect(result.purpose).toBe("revoke-device");
    });

    test("rejects an unknown purpose", () => {
      expect(() =>
        validateIpc(accountSignInStartSchema, { email: "owner@example.test", purpose: "not-a-purpose" }, "test"),
      ).toThrow();
    });
  });

  describe("onlineBootstrapStateOutputSchema", () => {
    test("accepts the bounded safe error fields and preserves the state update", () => {
      const state = sanitizeAccountUiStateOutput({
        phase: "signed-out",
        onlineBootstrap: {
          phase: "failed",
          purpose: "sign-in",
          url: "https://bootstrap.example.test/prod.json",
          retryAt: 1_800_000_000_000,
          error: {
            stage: "fetch",
            category: "http",
            status: 503,
            retryAfterMs: 30_000,
            message: "The configuration server is temporarily unavailable.",
          },
        },
      });
      expect(state.phase).toBe("signed-out");
      expect(state.onlineBootstrap?.phase).toBe("failed");
      expect(state.onlineBootstrap?.phase === "failed" && state.onlineBootstrap.error.status).toBe(503);
    });

    test("drops a malformed bootstrap detail without losing the rest of the account state", () => {
      const state = sanitizeAccountUiStateOutput({
        phase: "signed-out",
        ownerEmail: "owner@example.test",
        onlineBootstrap: {
          phase: "failed",
          purpose: "sign-in",
          url: "https://bootstrap.example.test/prod.json",
          error: {
            stage: "fetch",
            category: "http",
            message: "x".repeat(501),
          },
        },
      });
      expect(state.phase).toBe("signed-out");
      expect(state.ownerEmail).toBe("owner@example.test");
      expect(state.onlineBootstrap).toBeUndefined();
    });

    test("rejects an invalid discriminant directly", () => {
      expect(
        onlineBootstrapStateOutputSchema.safeParse({ phase: "downloading", url: "https://example.test" }).success,
      ).toBe(false);
    });
  });

  describe("workspaceSchema", () => {
    test("accepts valid workspace", () => {
      const result = validateIpc(
        workspaceSchema,
        {
          id: "ws-1",
          name: "My Workspace",
          cwd: "/home/user/project",
          panels: [{ id: "p1", title: "Shell" }],
        },
        "workspace:save",
      );
      expect(result.id).toBe("ws-1");
    });

    test("rejects workspace without id", () => {
      expect(() => validateIpc(workspaceSchema, { name: "test" }, "test")).toThrow();
    });

    test("rejects empty id", () => {
      expect(() => validateIpc(workspaceSchema, { id: "", name: "test" }, "test")).toThrow();
    });

    test("passes through extra fields", () => {
      const result = validateIpc(
        workspaceSchema,
        {
          id: "ws-1",
          name: "test",
          kind: "terminal",
          customField: "hello",
        },
        "test",
      );
      expect(result.customField).toBe("hello");
    });
  });

  describe("startReviewAgentPreparationSchema", () => {
    test("accepts provider-specific repository identities without a client-supplied remote URL", () => {
      expect(
        startReviewAgentPreparationSchema.parse({
          parentWorkspaceId: "parent-1",
          provider: "azure-devops",
          connectionId: "connection-1",
          projectName: "Project",
          repositoryId: "repo-1",
          panelId: "panel-1",
          idempotencyKey: "run-1",
        }),
      ).toMatchObject({ provider: "azure-devops", repositoryId: "repo-1" });
      expect(
        startReviewAgentPreparationSchema.parse({
          parentWorkspaceId: "parent-1",
          provider: "github",
          connectionId: "connection-1",
          owner: "org",
          repo: "repo",
          panelId: "panel-1",
          idempotencyKey: "run-1",
        }),
      ).toMatchObject({ provider: "github", owner: "org", repo: "repo" });
    });

    test("rejects remote URLs and command text from the caller", () => {
      expect(
        startReviewAgentPreparationSchema.safeParse({
          parentWorkspaceId: "parent-1",
          provider: "github",
          connectionId: "connection-1",
          owner: "org",
          repo: "repo",
          panelId: "panel-1",
          idempotencyKey: "run-1",
          remoteUrl: "https://attacker.invalid/repo.git",
          command: "claude --dangerously-skip-permissions",
        }).success,
      ).toBe(false);
    });
  });

  describe("azureCommentSchema", () => {
    test("accepts valid comment", () => {
      const result = validateIpc(
        azureCommentSchema,
        {
          prKey: "org/project/repo/1",
          content: "LGTM",
          threadId: null,
          parentCommentId: 0,
        },
        "test",
      );
      expect(result.prKey).toBe("org/project/repo/1");
    });

    test("rejects missing prKey", () => {
      expect(() => validateIpc(azureCommentSchema, { content: "hi" }, "test")).toThrow();
    });
  });

  describe("azureVoteSchema", () => {
    test("accepts valid vote", () => {
      const result = validateIpc(azureVoteSchema, { prKey: "key", vote: 10 }, "test");
      expect(result.vote).toBe(10);
    });

    test("rejects non-numeric vote", () => {
      expect(() => validateIpc(azureVoteSchema, { prKey: "key", vote: "yes" }, "test")).toThrow();
    });
  });

  describe("azureThreadStatusSchema", () => {
    test("accepts valid status", () => {
      const result = validateIpc(
        azureThreadStatusSchema,
        {
          prKey: "key",
          threadId: 42,
          status: "fixed",
        },
        "test",
      );
      expect(result.status).toBe("fixed");
    });

    test("rejects invalid status value", () => {
      expect(() =>
        validateIpc(
          azureThreadStatusSchema,
          {
            prKey: "key",
            threadId: 42,
            status: "invalid",
          },
          "test",
        ),
      ).toThrow();
    });
  });

  describe("gitDiffPreviewSchema", () => {
    test("accepts valid diff preview request", () => {
      const result = validateIpc(
        gitDiffPreviewSchema,
        {
          workspaceId: "ws-1",
          path: "src/app.js",
          scope: "staged",
        },
        "test",
      );
      expect(result.path).toBe("src/app.js");
    });

    test("rejects empty path", () => {
      expect(() =>
        validateIpc(
          gitDiffPreviewSchema,
          {
            workspaceId: "ws-1",
            path: "",
          },
          "test",
        ),
      ).toThrow();
    });
  });

  describe("gitLogPageSchema", () => {
    test("applies default skip and limit", () => {
      const result = validateIpc(gitLogPageSchema, { workspaceId: "ws-1" }, "git:log-page");
      expect(result.skip).toBe(0);
      expect(result.limit).toBe(100);
    });

    test("clamps limit to <= 500", () => {
      expect(() => validateIpc(gitLogPageSchema, { workspaceId: "ws-1", limit: 9999 }, "test")).toThrow();
    });

    test("rejects negative skip", () => {
      expect(() => validateIpc(gitLogPageSchema, { workspaceId: "ws-1", skip: -1 }, "test")).toThrow();
    });
  });

  describe("gitLogGraphSchema", () => {
    test("accepts minimal payload", () => {
      const result = validateIpc(gitLogGraphSchema, { workspaceId: "ws-1" }, "git:log-graph");
      expect(result.workspaceId).toBe("ws-1");
    });

    test("accepts full filter set", () => {
      const result = validateIpc(
        gitLogGraphSchema,
        {
          workspaceId: "ws-1",
          limit: 500,
          includeRemotes: true,
          branch: "main",
          sinceDate: "2 weeks ago",
          untilDate: "2026-01-01",
          paths: ["src/foo.ts", "docs/README.md"],
          topoOrder: true,
          author: "alice@example.com",
        },
        "git:log-graph",
      );
      expect(result.sinceDate).toBe("2 weeks ago");
      expect(result.paths).toEqual(["src/foo.ts", "docs/README.md"]);
      expect(result.topoOrder).toBe(true);
      expect(result.author).toBe("alice@example.com");
    });

    test("rejects sinceDate starting with '-' (flag-injection guard)", () => {
      expect(() => validateIpc(gitLogGraphSchema, { workspaceId: "ws-1", sinceDate: "--malicious" }, "test")).toThrow();
    });

    test("rejects path containing '..' (traversal guard)", () => {
      expect(() => validateIpc(gitLogGraphSchema, { workspaceId: "ws-1", paths: ["../etc/passwd"] }, "test")).toThrow();
    });

    test("rejects path starting with '-' (flag-injection guard)", () => {
      expect(() => validateIpc(gitLogGraphSchema, { workspaceId: "ws-1", paths: ["-rf"] }, "test")).toThrow();
    });

    test("rejects more than 32 paths", () => {
      const paths = Array.from({ length: 33 }, (_, i) => `f${i}.ts`);
      expect(() => validateIpc(gitLogGraphSchema, { workspaceId: "ws-1", paths }, "test")).toThrow();
    });

    test("rejects author starting with '-' (flag-injection guard)", () => {
      expect(() => validateIpc(gitLogGraphSchema, { workspaceId: "ws-1", author: "-x" }, "test")).toThrow();
    });

    test("clamps limit to <= 2000", () => {
      expect(() => validateIpc(gitLogGraphSchema, { workspaceId: "ws-1", limit: 9999 }, "test")).toThrow();
    });
  });

  describe("gitBranchListSchema", () => {
    test("accepts minimal payload", () => {
      const result = validateIpc(gitBranchListSchema, { workspaceId: "ws-1" }, "git:list-branches");
      expect(result.workspaceId).toBe("ws-1");
    });

    test("accepts rootPath when provided", () => {
      const result = validateIpc(
        gitBranchListSchema,
        { workspaceId: "ws-1", rootPath: "/repo/sub" },
        "git:list-branches",
      );
      expect(result.rootPath).toBe("/repo/sub");
    });

    test("rejects missing workspaceId", () => {
      expect(() => validateIpc(gitBranchListSchema, {}, "test")).toThrow();
    });

    test("rejects empty workspaceId", () => {
      expect(() => validateIpc(gitBranchListSchema, { workspaceId: "" }, "test")).toThrow();
    });
  });

  describe("gitBranchDeleteSchema", () => {
    test("accepts a normal branch name", () => {
      const result = validateIpc(
        gitBranchDeleteSchema,
        { workspaceId: "ws-1", branch: "feature/foo" },
        "git:delete-branch",
      );
      expect(result.branch).toBe("feature/foo");
    });

    test("force flag round-trips", () => {
      const result = validateIpc(
        gitBranchDeleteSchema,
        { workspaceId: "ws-1", branch: "feature/foo", force: true },
        "test",
      );
      expect(result.force).toBe(true);
    });

    test("rejects branch starting with '-' (flag-injection guard)", () => {
      expect(() => validateIpc(gitBranchDeleteSchema, { workspaceId: "ws-1", branch: "-D" }, "test")).toThrow();
    });

    test("rejects missing branch field", () => {
      expect(() => validateIpc(gitBranchDeleteSchema, { workspaceId: "ws-1" }, "test")).toThrow();
    });
  });

  describe("gitRemoteBranchDeleteSchema", () => {
    test("accepts a normal branch+remote pair", () => {
      const result = validateIpc(
        gitRemoteBranchDeleteSchema,
        { workspaceId: "ws-1", branch: "feature/foo", remote: "origin" },
        "git:delete-remote-branch",
      );
      expect(result.remote).toBe("origin");
    });

    test("remote is optional (defaults applied downstream)", () => {
      const result = validateIpc(gitRemoteBranchDeleteSchema, { workspaceId: "ws-1", branch: "feature/foo" }, "test");
      expect(result.remote).toBeUndefined();
    });

    test("rejects branch starting with '-' (flag-injection guard)", () => {
      expect(() =>
        validateIpc(gitRemoteBranchDeleteSchema, { workspaceId: "ws-1", branch: "-rf", remote: "origin" }, "test"),
      ).toThrow();
    });

    test("rejects remote starting with '-' (flag-injection guard)", () => {
      expect(() =>
        validateIpc(
          gitRemoteBranchDeleteSchema,
          { workspaceId: "ws-1", branch: "feature/foo", remote: "--upload-pack=evil" },
          "test",
        ),
      ).toThrow();
    });
  });

  describe("gitBranchRenameSchema", () => {
    test("accepts both old and new name", () => {
      const result = validateIpc(
        gitBranchRenameSchema,
        { workspaceId: "ws-1", branch: "old-name", newName: "new-name" },
        "git:rename-branch",
      );
      expect(result.newName).toBe("new-name");
    });

    test("old branch is optional (renaming current branch)", () => {
      const result = validateIpc(gitBranchRenameSchema, { workspaceId: "ws-1", newName: "new-name" }, "test");
      expect(result.branch).toBeUndefined();
    });

    test("rejects newName starting with '-' (flag-injection guard)", () => {
      expect(() => validateIpc(gitBranchRenameSchema, { workspaceId: "ws-1", newName: "-D" }, "test")).toThrow();
    });

    test("rejects old branch starting with '-' (flag-injection guard)", () => {
      expect(() =>
        validateIpc(
          gitBranchRenameSchema,
          { workspaceId: "ws-1", branch: "--config=core.fsmonitor=evil.sh", newName: "ok" },
          "test",
        ),
      ).toThrow();
    });

    test("rejects missing newName", () => {
      expect(() => validateIpc(gitBranchRenameSchema, { workspaceId: "ws-1", branch: "old" }, "test")).toThrow();
    });
  });

  describe("gitCheckoutRemoteSchema", () => {
    test("accepts remoteBranch and optional localBranch", () => {
      const result = validateIpc(
        gitCheckoutRemoteSchema,
        { workspaceId: "ws-1", remoteBranch: "origin/feature", localBranch: "feature" },
        "git:checkout-remote-branch",
      );
      expect(result.remoteBranch).toBe("origin/feature");
      expect(result.localBranch).toBe("feature");
    });

    test("localBranch is optional (derived downstream)", () => {
      const result = validateIpc(
        gitCheckoutRemoteSchema,
        { workspaceId: "ws-1", remoteBranch: "origin/feature" },
        "test",
      );
      expect(result.localBranch).toBeUndefined();
    });

    test("rejects remoteBranch starting with '-' (flag-injection guard)", () => {
      expect(() =>
        validateIpc(gitCheckoutRemoteSchema, { workspaceId: "ws-1", remoteBranch: "-rf" }, "test"),
      ).toThrow();
    });

    test("rejects localBranch starting with '-' (flag-injection guard)", () => {
      expect(() =>
        validateIpc(
          gitCheckoutRemoteSchema,
          { workspaceId: "ws-1", remoteBranch: "origin/feature", localBranch: "-D" },
          "test",
        ),
      ).toThrow();
    });

    test("rejects missing remoteBranch", () => {
      expect(() => validateIpc(gitCheckoutRemoteSchema, { workspaceId: "ws-1" }, "test")).toThrow();
    });
  });

  describe("terminalResizeSchema", () => {
    test("accepts valid resize", () => {
      const result = validateIpc(terminalResizeSchema, { cols: 80, rows: 24 }, "test");
      expect(result.cols).toBe(80);
    });

    test("rejects non-integer cols", () => {
      expect(() => validateIpc(terminalResizeSchema, { cols: 80.5, rows: 24 }, "test")).toThrow();
    });

    test("rejects zero rows", () => {
      expect(() => validateIpc(terminalResizeSchema, { cols: 80, rows: 0 }, "test")).toThrow();
    });
  });

  describe("profileSchema", () => {
    test("accepts valid profile", () => {
      const result = validateIpc(profileSchema, { name: "Work" }, "test");
      expect(result.name).toBe("Work");
    });

    test("passes through extra fields", () => {
      const result = validateIpc(profileSchema, { name: "Work", color: "#ff0000" }, "test");
      expect(result.color).toBe("#ff0000");
    });
  });

  describe("worktreeSchema", () => {
    test("accepts valid worktree request", () => {
      const result = validateIpc(
        worktreeSchema,
        {
          workspaceId: "ws-1",
          name: "feature-branch",
        },
        "test",
      );
      expect(result.name).toBe("feature-branch");
    });

    test("rejects empty name", () => {
      expect(() =>
        validateIpc(
          worktreeSchema,
          {
            workspaceId: "ws-1",
            name: "",
          },
          "test",
        ),
      ).toThrow();
    });
  });

  describe("removeWorktreeSchema", () => {
    test("accepts valid remove request", () => {
      const result = validateIpc(
        removeWorktreeSchema,
        {
          workspaceId: "ws-1",
          worktreePath: "/path/to/tree",
        },
        "test",
      );
      expect(result.worktreePath).toBe("/path/to/tree");
    });

    test("deleteBranch defaults to undefined", () => {
      const result = validateIpc(
        removeWorktreeSchema,
        {
          workspaceId: "ws-1",
          worktreePath: "/path",
        },
        "test",
      );
      expect(result.deleteBranch).toBeUndefined();
    });
  });

  describe("dockerSessionSchema", () => {
    test("accepts valid docker session", () => {
      const result = validateIpc(
        dockerSessionSchema,
        {
          workspaceId: "ws-1",
          containerId: "abc123",
          mode: "shell",
        },
        "test",
      );
      expect(result.mode).toBe("shell");
    });
  });

  describe("workspaceIdSchema", () => {
    test("accepts non-empty string", () => {
      expect(validateIpc(workspaceIdSchema, "ws-123", "test")).toBe("ws-123");
    });

    test("rejects empty string", () => {
      expect(() => validateIpc(workspaceIdSchema, "", "test")).toThrow();
    });

    test("rejects non-string", () => {
      expect(() => validateIpc(workspaceIdSchema, 42, "test")).toThrow();
    });

    test("rejects null/undefined", () => {
      expect(() => validateIpc(workspaceIdSchema, null, "test")).toThrow();
      expect(() => validateIpc(workspaceIdSchema, undefined, "test")).toThrow();
    });
  });

  describe("workspaceDeleteOptionsSchema", () => {
    test("accepts empty object (no disk delete)", () => {
      const result = validateIpc(workspaceDeleteOptionsSchema, {}, "test");
      expect(result.deleteFromDisk).toBeUndefined();
      expect(result.diskPath).toBeUndefined();
    });

    test("accepts valid deleteFromDisk + diskPath", () => {
      const result = validateIpc(
        workspaceDeleteOptionsSchema,
        { deleteFromDisk: true, diskPath: "/tmp/workspace" },
        "test",
      );
      expect(result.deleteFromDisk).toBe(true);
      expect(result.diskPath).toBe("/tmp/workspace");
    });

    test("accepts missing optional fields", () => {
      expect(() => validateIpc(workspaceDeleteOptionsSchema, { deleteFromDisk: false }, "test")).not.toThrow();
      expect(() => validateIpc(workspaceDeleteOptionsSchema, { diskPath: "/tmp/x" }, "test")).not.toThrow();
    });

    test("rejects extra keys (strict)", () => {
      expect(() =>
        validateIpc(workspaceDeleteOptionsSchema, { deleteFromDisk: true, unknownKey: "bad" }, "test"),
      ).toThrow();
    });

    test("rejects wrong types", () => {
      expect(() => validateIpc(workspaceDeleteOptionsSchema, { deleteFromDisk: "yes" }, "test")).toThrow();
      expect(() => validateIpc(workspaceDeleteOptionsSchema, { diskPath: 123 }, "test")).toThrow();
    });
  });

  describe("approvalAuditLogQuerySchema", () => {
    test("carries the keyset cursors the Notification Center back-fill pages with", () => {
      // A zod object DROPS what it does not declare, so an undeclared cursor
      // would reach the store as no cursor at all — the desktop back-fill
      // would silently re-read page one for ever.
      const result = validateIpc(
        approvalAuditLogQuerySchema,
        { limit: 50, profileId: "profile-a", afterId: 12, beforeId: 99 },
        "test",
      );
      expect(result).toMatchObject({ afterId: 12, beforeId: 99 });
    });

    test("rejects a cursor that is not a positive integer", () => {
      expect(() => validateIpc(approvalAuditLogQuerySchema, { afterId: 0 }, "test")).toThrow();
      expect(() => validateIpc(approvalAuditLogQuerySchema, { beforeId: -1 }, "test")).toThrow();
      expect(() => validateIpc(approvalAuditLogQuerySchema, { afterId: 1.5 }, "test")).toThrow();
      expect(() => validateIpc(approvalAuditLogQuerySchema, { beforeId: "42" }, "test")).toThrow();
    });
  });

  describe("mobileCreatePairingInvitationSchema", () => {
    test("accepts a valid options payload", () => {
      const result = validateIpc(
        mobileCreatePairingInvitationSchema,
        { profileAllowlist: ["default"], capabilities: ["task.control", "remote.request"] },
        "mobile:pairing:create",
      );
      expect(result.profileAllowlist).toEqual(["default"]);
      expect(result.capabilities).toEqual(["task.control", "remote.request"]);
    });

    test("rejects an empty profileAllowlist", () => {
      expect(() =>
        validateIpc(
          mobileCreatePairingInvitationSchema,
          { profileAllowlist: [], capabilities: ["task.control"] },
          "test",
        ),
      ).toThrow();
    });

    test("rejects an empty capabilities list", () => {
      expect(() =>
        validateIpc(mobileCreatePairingInvitationSchema, { profileAllowlist: ["default"], capabilities: [] }, "test"),
      ).toThrow();
    });

    test("rejects a missing field", () => {
      expect(() =>
        validateIpc(mobileCreatePairingInvitationSchema, { profileAllowlist: ["default"] }, "test"),
      ).toThrow();
    });

    test("rejects an empty-string list entry", () => {
      expect(() =>
        validateIpc(
          mobileCreatePairingInvitationSchema,
          { profileAllowlist: [""], capabilities: ["task.control"] },
          "test",
        ),
      ).toThrow();
    });
  });

  describe("mobileRenameDeviceSchema", () => {
    test("accepts a valid rename payload", () => {
      const result = validateIpc(mobileRenameDeviceSchema, { deviceId: "mobile-1", label: "My Pixel" }, "test");
      expect(result).toEqual({ deviceId: "mobile-1", label: "My Pixel" });
    });

    test("rejects an empty deviceId", () => {
      expect(() => validateIpc(mobileRenameDeviceSchema, { deviceId: "", label: "x" }, "test")).toThrow();
    });

    test("rejects an empty label", () => {
      expect(() => validateIpc(mobileRenameDeviceSchema, { deviceId: "mobile-1", label: "" }, "test")).toThrow();
    });

    test("rejects a label over 60 characters", () => {
      expect(() =>
        validateIpc(mobileRenameDeviceSchema, { deviceId: "mobile-1", label: "x".repeat(61) }, "test"),
      ).toThrow();
    });

    test("rejects a missing deviceId", () => {
      expect(() => validateIpc(mobileRenameDeviceSchema, { label: "x" }, "test")).toThrow();
    });
  });

  describe("mobileUpdateDeviceAllowlistSchema", () => {
    test("accepts deviceId alone (both allowlist fields optional)", () => {
      const result = validateIpc(mobileUpdateDeviceAllowlistSchema, { deviceId: "mobile-1" }, "test");
      expect(result.deviceId).toBe("mobile-1");
      expect(result.capabilities).toBeUndefined();
      expect(result.profileAllowlist).toBeUndefined();
    });

    test("accepts a full payload", () => {
      const result = validateIpc(
        mobileUpdateDeviceAllowlistSchema,
        { deviceId: "mobile-1", capabilities: ["remote.request"], profileAllowlist: ["default", "other"] },
        "test",
      );
      expect(result.capabilities).toEqual(["remote.request"]);
      expect(result.profileAllowlist).toEqual(["default", "other"]);
    });

    test("rejects a missing deviceId", () => {
      expect(() =>
        validateIpc(mobileUpdateDeviceAllowlistSchema, { capabilities: ["task.control"] }, "test"),
      ).toThrow();
    });

    test("rejects an empty-string capability entry", () => {
      expect(() =>
        validateIpc(mobileUpdateDeviceAllowlistSchema, { deviceId: "mobile-1", capabilities: [""] }, "test"),
      ).toThrow();
    });
  });

  describe("mobileAuditLogQuerySchema", () => {
    test("accepts an empty filter object", () => {
      expect(() => validateIpc(mobileAuditLogQuerySchema, {}, "test")).not.toThrow();
    });

    test("accepts a full filter payload", () => {
      const result = validateIpc(
        mobileAuditLogQuerySchema,
        {
          from: "2026-01-01",
          to: "2026-01-02",
          deviceId: "mobile-1",
          action: "event.sent",
          status: "success",
          limit: 10,
          offset: 0,
        },
        "test",
      );
      expect(result.status).toBe("success");
      expect(result.limit).toBe(10);
    });

    test("rejects an invalid status value", () => {
      expect(() => validateIpc(mobileAuditLogQuerySchema, { status: "maybe" }, "test")).toThrow();
    });

    test("rejects a negative offset", () => {
      expect(() => validateIpc(mobileAuditLogQuerySchema, { offset: -1 }, "test")).toThrow();
    });

    test("rejects a non-positive limit", () => {
      expect(() => validateIpc(mobileAuditLogQuerySchema, { limit: 0 }, "test")).toThrow();
    });
  });

  describe("gitTagSchema", () => {
    test("keeps the root and the retry key that the tag handlers read", () => {
      expect(
        validateIpc(
          gitTagSchema,
          { workspaceId: "ws", tagName: "v1", rootPath: "/repo/b", idempotencyKey: "key-1" },
          "test",
        ),
      ).toEqual({ workspaceId: "ws", tagName: "v1", rootPath: "/repo/b", idempotencyKey: "key-1" });
    });
  });

  describe("quick-fix create payloads", () => {
    const azure = {
      connectionId: "az-1",
      projectName: "Engineering",
      repositoryId: "repo-1",
      repositoryName: "web",
      remoteUrl: "https://dev.azure.com/org/project/_git/web",
      baseBranch: "main",
      newBranchName: "feature/ENG-1-fix-login",
    };
    const github = {
      connectionId: "gh-1",
      owner: "acme",
      repo: "web",
      remoteUrl: "https://github.com/acme/web.git",
      baseBranch: "main",
      newBranchName: "feature/ENG-1-fix-login",
    };
    const jiraIssueRef = { connectionId: "jira-1", issueId: "1001", issueKey: "ENG-1" };

    test.each([
      ["azure", quickFixCreateSchema, azure],
      ["github", githubQuickFixCreateSchema, github],
    ])("%s accepts the payload with and without a Jira issue link", (_name, schema, payload) => {
      expect(validateIpc(schema, payload, "test")).toEqual(payload);
      expect(validateIpc(schema, { ...payload, jiraIssueRef }, "test")).toEqual({ ...payload, jiraIssueRef });
    });

    test.each([
      ["azure", quickFixCreateSchema, azure],
      ["github", githubQuickFixCreateSchema, github],
    ])("%s refuses an incomplete or widened Jira issue link", (_name, schema, payload) => {
      expect(() =>
        validateIpc(schema, { ...payload, jiraIssueRef: { connectionId: "jira-1", issueId: "1" } }, "test"),
      ).toThrow();
      expect(() =>
        validateIpc(schema, { ...payload, jiraIssueRef: { ...jiraIssueRef, profileId: "p" } }, "test"),
      ).toThrow();
      expect(() =>
        validateIpc(schema, { ...payload, jiraIssueRef: { ...jiraIssueRef, issueKey: "" } }, "test"),
      ).toThrow();
    });
  });
});
