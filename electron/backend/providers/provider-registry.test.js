import { describe, expect, test, beforeEach } from "vitest";
import { getProvider, getAllProviders, getProviderChoices, parseProviderFromCommand } from "./provider-registry.js";
import { ClaudeProvider } from "./claude-provider.js";
import { CodexProvider } from "./codex-provider.js";
import { GeminiProvider } from "./gemini-provider.js";

describe("provider-registry", () => {
  describe("getProvider", () => {
    test("returns ClaudeProvider for 'claude'", () => {
      const p = getProvider("claude");
      expect(p).toBeInstanceOf(ClaudeProvider);
    });

    test("returns CodexProvider for 'codex'", () => {
      const p = getProvider("codex");
      expect(p).toBeInstanceOf(CodexProvider);
    });

    test("returns GeminiProvider for 'gemini'", () => {
      const p = getProvider("gemini");
      expect(p).toBeInstanceOf(GeminiProvider);
    });

    test("throws for unknown provider", () => {
      expect(() => getProvider("unknown-provider")).toThrow("Unknown provider: unknown-provider");
    });
  });

  describe("getAllProviders", () => {
    test("returns all three built-in providers", () => {
      const all = getAllProviders();
      const ids = all.map((P) => P.id);
      expect(ids).toContain("claude");
      expect(ids).toContain("codex");
      expect(ids).toContain("gemini");
    });
  });

  describe("getProviderChoices", () => {
    test("returns serializable choices with id, name, models", () => {
      const choices = getProviderChoices();
      expect(choices.length).toBeGreaterThanOrEqual(3);
      for (const c of choices) {
        expect(c.id).toBeTruthy();
        expect(c.name).toBeTruthy();
        expect(Array.isArray(c.models)).toBe(true);
        expect(c.models.length).toBeGreaterThan(0);
      }
    });

    test("claude models include opus and sonnet", () => {
      const choices = getProviderChoices();
      const claude = choices.find((c) => c.id === "claude");
      const ids = claude.models.map((m) => m.id);
      expect(ids).toContain("sonnet");
      expect(ids).toContain("opus");
    });
  });

  describe("parseProviderFromCommand", () => {
    test("returns claude/sonnet default for empty command", () => {
      expect(parseProviderFromCommand("")).toEqual({ providerId: "claude", model: "sonnet" });
      expect(parseProviderFromCommand(null)).toEqual({ providerId: "claude", model: "sonnet" });
      expect(parseProviderFromCommand(undefined)).toEqual({ providerId: "claude", model: "sonnet" });
    });

    test("parses claude with explicit model", () => {
      const result = parseProviderFromCommand("claude --dangerously-skip-permissions --model opus");
      expect(result.providerId).toBe("claude");
      expect(result.model).toBe("opus");
    });

    test("parses claude without model (defaults to sonnet)", () => {
      const result = parseProviderFromCommand("claude --dangerously-skip-permissions");
      expect(result.providerId).toBe("claude");
      expect(result.model).toBe("sonnet");
    });

    test("parses codex command", () => {
      const result = parseProviderFromCommand("codex --dangerously-bypass-approvals-and-sandbox -s danger-full-access");
      expect(result.providerId).toBe("codex");
      expect(result.model).toBe("o4-mini");
    });

    test("parses gemini command", () => {
      const result = parseProviderFromCommand("gemini -m gemini-2.5-pro");
      expect(result.providerId).toBe("gemini");
    });
  });
});

describe("ClaudeProvider", () => {
  let provider;
  beforeEach(() => {
    provider = new ClaudeProvider();
  });

  test("buildCommand without model returns base command", () => {
    const cmd = provider.buildCommand({});
    expect(cmd).toBe("claude --dangerously-skip-permissions");
  });

  test("buildCommand with model includes --model flag", () => {
    const cmd = provider.buildCommand({ model: "opus" });
    expect(cmd).toBe("claude --dangerously-skip-permissions --model opus");
  });

  test("buildCommand with mcp config includes --mcp-config flag", () => {
    const cmd = provider.buildCommand({ model: "sonnet", extra: { mcpConfig: "/path/to/mcp.json" } });
    expect(cmd).toContain("--mcp-config /path/to/mcp.json");
  });

  test("getEnvironment returns CLAUDE_CODE_DISABLE_BACKGROUND_TASKS", () => {
    const env = provider.getEnvironment();
    expect(env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe("1");
  });

  test("idleDetection is osc133", () => {
    expect(provider.idleDetection).toBe("osc133");
  });

  test("idleTimeoutMs is 2000", () => {
    expect(provider.idleTimeoutMs).toBe(2000);
  });

  test("static id and displayName", () => {
    expect(ClaudeProvider.id).toBe("claude");
    expect(ClaudeProvider.displayName).toBe("Claude Code");
  });
});

describe("CodexProvider", () => {
  let provider;
  beforeEach(() => {
    provider = new CodexProvider();
  });

  test("buildCommand includes bypass flags", () => {
    const cmd = provider.buildCommand({});
    expect(cmd).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(cmd).toContain("-s danger-full-access");
  });

  test("buildCommand with model includes --model flag", () => {
    const cmd = provider.buildCommand({ model: "o3" });
    expect(cmd).toContain("--model o3");
  });

  test("getEnvironment returns empty object", () => {
    const env = provider.getEnvironment();
    expect(Object.keys(env)).toHaveLength(0);
  });

  test("idleDetection is silence", () => {
    expect(provider.idleDetection).toBe("silence");
  });

  test("idleTimeoutMs is 8000", () => {
    expect(provider.idleTimeoutMs).toBe(8000);
  });

  test("static id and displayName", () => {
    expect(CodexProvider.id).toBe("codex");
    expect(CodexProvider.displayName).toBe("Codex CLI");
  });
});

describe("GeminiProvider", () => {
  let provider;
  beforeEach(() => {
    provider = new GeminiProvider();
  });

  test("buildCommand starts with gemini", () => {
    const cmd = provider.buildCommand({});
    expect(cmd).toBe("gemini");
  });

  test("buildCommand with model includes -m flag", () => {
    const cmd = provider.buildCommand({ model: "gemini-2.5-pro" });
    expect(cmd).toBe("gemini -m gemini-2.5-pro");
  });

  test("getEnvironment returns empty object", () => {
    const env = provider.getEnvironment();
    expect(Object.keys(env)).toHaveLength(0);
  });

  test("idleDetection is silence", () => {
    expect(provider.idleDetection).toBe("silence");
  });

  test("static id and displayName", () => {
    expect(GeminiProvider.id).toBe("gemini");
    expect(GeminiProvider.displayName).toBe("Gemini CLI");
  });
});
