import { describe, expect, test } from "vitest";
import {
  AUTO_APPROVE_NEVER_TOOLS,
  SUMMARY_MAX_CHARS,
  decideAutoApprove,
  summarizePermissionRequest,
  summarizePermissionRequestParts,
  type AutoApproveContext,
} from "./auto-approve.js";

describe("summarizePermissionRequest", () => {
  test("Bash summarises the command with whitespace collapsed", () => {
    expect(summarizePermissionRequest("Bash", { command: "chmod   +x\n  deploy.sh" })).toBe("Bash: chmod +x deploy.sh");
  });

  test.each([
    ["Edit", { file_path: "src/foo.ts" }, "Edit: src/foo.ts"],
    ["Write", { file_path: "src/new.ts" }, "Write: src/new.ts"],
    ["MultiEdit", { file_path: "src/many.ts" }, "MultiEdit: src/many.ts"],
    ["NotebookEdit", { notebook_path: "nb.ipynb" }, "NotebookEdit: nb.ipynb"],
    ["Read", { file_path: "README.md" }, "Read: README.md"],
    ["Glob", { pattern: "**/*.ts" }, "Glob: **/*.ts"],
    ["Grep", { pattern: "TODO" }, "Grep: TODO"],
  ])("%s summarises its key argument", (tool, input, expected) => {
    expect(summarizePermissionRequest(tool, input)).toBe(expected);
  });

  test("WebFetch reduces the URL to its host", () => {
    expect(summarizePermissionRequest("WebFetch", { url: "https://example.com/a/b?c=d" })).toBe(
      "WebFetch: example.com",
    );
  });

  test("WebFetch with an unparseable url keeps the raw value rather than dropping it", () => {
    expect(summarizePermissionRequest("WebFetch", { url: "not a url" })).toBe("WebFetch: not a url");
  });

  test("an MCP tool uses its first string field, since its shape is unknown", () => {
    expect(summarizePermissionRequest("mcp__socraticode__codebase_search", { limit: 5, query: "auth flow" })).toBe(
      "mcp__socraticode__codebase_search: auth flow",
    );
  });

  test("an unknown tool degrades to just its name", () => {
    expect(summarizePermissionRequest("SomeFutureTool", { whatever: "x" })).toBe("SomeFutureTool");
  });

  test("a tool with no usable argument degrades to just its name", () => {
    expect(summarizePermissionRequest("Bash", {})).toBe("Bash");
    expect(summarizePermissionRequest("Bash", null)).toBe("Bash");
  });

  test("a missing tool name still produces a printable summary", () => {
    expect(summarizePermissionRequest("", {})).toBe("tool");
    expect(summarizePermissionRequest(undefined, undefined)).toBe("tool");
  });

  test("a bearer token in the command is redacted before it can be persisted", () => {
    const summary = summarizePermissionRequest("Bash", {
      command: 'curl -H "Authorization: Bearer sk-ant-super-secret-value" https://api.example.com',
    });
    expect(summary).not.toContain("sk-ant-super-secret-value");
    expect(summary).toContain("[REDACTED]");
  });

  test("a token query string in a fetched URL is redacted", () => {
    const summary = summarizePermissionRequest("Bash", {
      command: "curl https://api.example.com/x?token=abcdef123456",
    });
    expect(summary).not.toContain("abcdef123456");
  });

  test("a pathological argument is clipped", () => {
    const summary = summarizePermissionRequest("Bash", { command: "x".repeat(5_000) });
    expect(summary.length).toBe(SUMMARY_MAX_CHARS);
    expect(summary.endsWith("…")).toBe(true);
  });
});

describe("summarizePermissionRequestParts", () => {
  test("keeps the argument separate from the prefixed one-liner", () => {
    // The Notification Center writes the tool name itself, so handing it the
    // prefixed summary produced "Bash in Alpha: Bash: chmod +x deploy.sh".
    expect(summarizePermissionRequestParts("Bash", { command: "chmod +x deploy.sh" })).toEqual({
      tool: "Bash",
      detail: "chmod +x deploy.sh",
      summary: "Bash: chmod +x deploy.sh",
    });
  });

  test("a tool with no usable argument has an empty detail and a bare summary", () => {
    expect(summarizePermissionRequestParts("SomeFutureTool", { whatever: "x" })).toEqual({
      tool: "SomeFutureTool",
      detail: "",
      summary: "SomeFutureTool",
    });
  });

  test("the detail is redacted too — it is persisted and forwarded on its own", () => {
    const parts = summarizePermissionRequestParts("Bash", {
      command: 'curl -H "Authorization: Bearer sk-ant-super-secret-value" https://api.example.com',
    });
    expect(parts.detail).not.toContain("sk-ant-super-secret-value");
    expect(parts.detail).toContain("[REDACTED]");
  });
});

const APPROVABLE: AutoApproveContext = {
  enabled: true,
  toolName: "Bash",
  workspace: { kind: "terminal" },
  signal: { turnActive: true },
  ownershipProven: true,
};

describe("decideAutoApprove", () => {
  test("approves when everything lines up", () => {
    expect(decideAutoApprove(APPROVABLE)).toEqual({ approve: true, reason: "global" });
  });

  test("refuses when the setting is off (the default)", () => {
    expect(decideAutoApprove({ ...APPROVABLE, enabled: false })).toEqual({ approve: false, reason: "disabled" });
  });

  test.each([...AUTO_APPROVE_NEVER_TOOLS])("refuses %s — it is on the never-list", (toolName) => {
    expect(decideAutoApprove({ ...APPROVABLE, toolName })).toEqual({ approve: false, reason: "never-list" });
  });

  test("the never-list is exactly AskUserQuestion and ExitPlanMode", () => {
    // Both need `updatedInput` alongside `allow` — a bare approval answers an
    // AskUserQuestion with empty answers (changelog 2.1.69) and rubber-stamps a
    // plan the user never read.
    expect([...AUTO_APPROVE_NEVER_TOOLS].sort()).toEqual(["AskUserQuestion", "ExitPlanMode"]);
  });

  test("the never-list holds even when the tool would otherwise be approvable", () => {
    // Guards against a future reordering that lets a session check answer
    // first and hides a never-list regression behind an unrelated refusal.
    for (const toolName of AUTO_APPROVE_NEVER_TOOLS) {
      expect(decideAutoApprove({ ...APPROVABLE, toolName }).approve).toBe(false);
    }
  });

  test("refuses when the session's workspace is unknown", () => {
    expect(decideAutoApprove({ ...APPROVABLE, workspace: null })).toEqual({
      approve: false,
      reason: "unknown-session",
    });
  });

  test("refuses when this instance has never seen the session", () => {
    expect(decideAutoApprove({ ...APPROVABLE, signal: null })).toEqual({
      approve: false,
      reason: "unknown-session",
    });
  });

  test("refuses inside a task workspace — the task runner owns its own prompts", () => {
    expect(decideAutoApprove({ ...APPROVABLE, workspace: { kind: "task" } })).toEqual({
      approve: false,
      reason: "task-workspace",
    });
  });

  test("refuses a workspace carrying a task even if its kind says otherwise", () => {
    // `kind` is a normalized label; the `task` object is the structural fact.
    // A state file that lost `kind` must not become an auto-approving task
    // workspace.
    expect(decideAutoApprove({ ...APPROVABLE, workspace: { kind: "terminal", hasTask: true } })).toEqual({
      approve: false,
      reason: "task-workspace",
    });
  });

  test("refuses when the hook did not prove which PTY it came from", () => {
    // The whole P0-2 case: a `claude` started in a plain terminal inside the
    // same repository, a second panel sharing the `cwd`, dev beside prod —
    // cwd routing reaches this responder for all of them, and only the token
    // injected into the PTY tells them apart.
    expect(decideAutoApprove({ ...APPROVABLE, ownershipProven: false })).toEqual({
      approve: false,
      reason: "unproven-session",
    });
  });

  test("ownership is checked before turn state, so a missing token is never reported as an idle session", () => {
    expect(decideAutoApprove({ ...APPROVABLE, ownershipProven: false, signal: { turnActive: false } })).toEqual({
      approve: false,
      reason: "unproven-session",
    });
  });

  test("refuses outside an active turn", () => {
    // A permission request only happens between UserPromptSubmit and Stop.
    // Gating on `turnActive` rather than the sticky hasUserInput/agentLike
    // flags means a session that went quiet hours ago is no longer eligible.
    expect(decideAutoApprove({ ...APPROVABLE, signal: { turnActive: false } })).toEqual({
      approve: false,
      reason: "session-not-active",
    });
    expect(decideAutoApprove({ ...APPROVABLE, signal: {} })).toEqual({
      approve: false,
      reason: "session-not-active",
    });
  });
});
