import { describe, expect, it } from "vitest";
import type { AgentUsage } from "../../shared/agent-usage.js";
import { projectMobileAgentUsage } from "./mobile-projection.js";

describe("mobile provider usage projection", () => {
  it("keeps opted-in account labels and quota while removing local profile metadata", () => {
    const usage: AgentUsage[] = [
      {
        provider: "claude",
        checkedAt: 1000,
        account: { label: "active@example.invalid", key: "host-account-key" },
        windows: [{ label: "5-hour", usedPercent: 25, durationMinutes: 300 }],
        otherAccounts: [
          {
            id: "local-profile-key",
            label: "former@example.invalid",
            status: "last-seen",
            checkedAt: 900,
            windows: [{ label: "Weekly", usedPercent: 10 }],
            removable: true,
          },
          {
            id: "unknown-profile-key",
            label: `${"C:\\private\\"}${"a".repeat(100)} · account identity unknown`,
            status: "separate-login",
            identityUnknown: true,
          },
          { id: "candidate-key", label: "C:\\private\\candidate", status: "candidate" },
          { id: "duplicate-key", label: "active@example.invalid", status: "separate-login", sameAsDefault: true },
          { id: "listed-local", label: "C:\\private\\missing", status: "listed" },
        ],
      },
      {
        provider: "gemini",
        checkedAt: 2000,
        windows: [],
        unavailable: "path-bearing raw error",
        otherAccounts: [
          { id: "gemini-local-id", label: "listed@example.invalid", status: "listed" },
          { id: "gemini-candidate", label: "ignore@example.invalid", status: "candidate" },
        ],
      },
    ];

    const projected = projectMobileAgentUsage(usage);
    expect(projected).toMatchObject([
      {
        provider: "claude",
        account: { label: "active@example.invalid", key: "mobile-claude-active" },
        windows: [{ label: "5-hour", usedPercent: 25, durationMinutes: 300 }],
        otherAccounts: [
          {
            id: "claude-other-0",
            label: "former@example.invalid",
            status: "last-seen",
            checkedAt: 900,
            windows: [{ label: "Weekly", usedPercent: 10 }],
          },
        ],
      },
      {
        provider: "gemini",
        unavailable: "Open /model or /stats model in Gemini CLI to check quota for this account.",
        otherAccounts: [{ id: "gemini-other-0", label: "listed@example.invalid", status: "listed" }],
      },
    ]);
    const serialized = JSON.stringify(projected);
    for (const forbidden of [
      "host-account-key",
      "local-profile-key",
      "unknown-profile-key",
      "candidate-key",
      "duplicate-key",
      "listed-local",
      "gemini-local-id",
      "C:\\private\\",
      "removable",
      "identityUnknown",
      "sameAsDefault",
      "path-bearing raw error",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("omits long unknown-folder labels even when their marker follows the display limit", () => {
    const projected = projectMobileAgentUsage([
      {
        provider: "codex",
        checkedAt: 1000,
        windows: [],
        otherAccounts: [
          {
            id: "opaque-folder-id",
            label: `${"x".repeat(100)} · account identity unknown`,
            status: "separate-login",
            identityUnknown: true,
          },
        ],
      },
    ]);
    expect(projected[0]?.otherAccounts).toBeUndefined();
  });
});
