import { describe, expect, it } from "vitest";
import { checkRegistryUrl, registrySecretRef } from "./registry.js";
import { detectSandboxAgent, isSandboxedPanel } from "./sandbox-eligibility.js";
import { normalizeSandboxDomain, normalizeSandboxDomains, SANDBOX_MAX_WORKSPACE_DOMAINS } from "./sandbox.js";

describe("normalizeSandboxDomain", () => {
  it("accepts named hosts, wildcards and ports, lower-cased", () => {
    expect(normalizeSandboxDomain("Registry.Example.COM")).toBe("registry.example.com");
    expect(normalizeSandboxDomain("*.example.com")).toBe("*.example.com");
    expect(normalizeSandboxDomain("api.example.com:8443")).toBe("api.example.com:8443");
  });

  it("refuses everything that names a machine or 'everything'", () => {
    for (const bad of [
      "*",
      "*.com",
      "localhost",
      "10.0.0.1",
      "1.2.3.4:80",
      "example",
      "a b.com",
      "",
      "-a.com",
      "x.com:0",
      "x.com:70000",
    ]) {
      expect(normalizeSandboxDomain(bad), bad).toBeNull();
    }
    expect(normalizeSandboxDomain(42)).toBeNull();
  });

  it("de-duplicates and caps a list", () => {
    expect(normalizeSandboxDomains(["a.example.com", "A.example.com", "bad", 3])).toEqual(["a.example.com"]);
    const many = Array.from({ length: SANDBOX_MAX_WORKSPACE_DOMAINS + 20 }, (_, i) => `h${i}.example.com`);
    expect(normalizeSandboxDomains(many)).toHaveLength(SANDBOX_MAX_WORKSPACE_DOMAINS);
    expect(normalizeSandboxDomains("nope")).toEqual([]);
  });
});

describe("isSandboxedPanel", () => {
  const isolated = { sandboxEnabled: true, kind: "terminal" };

  it("wraps agent tabs of an isolated workspace only", () => {
    expect(isSandboxedPanel(isolated, { command: "claude --model opus" })).toBe(true);
    expect(isSandboxedPanel(isolated, { command: "codex" })).toBe(true);
    expect(isSandboxedPanel(isolated, { command: "gemini" })).toBe(true);
    expect(isSandboxedPanel(isolated, { command: "/usr/local/bin/opencode" })).toBe(true);
    expect(isSandboxedPanel(isolated, { command: "npm test" })).toBe(false);
    expect(isSandboxedPanel(isolated, { command: "" })).toBe(false);
  });

  it("never wraps a workspace that did not opt in, or a tab with its own launcher", () => {
    expect(isSandboxedPanel({ sandboxEnabled: false }, { command: "claude" })).toBe(false);
    expect(isSandboxedPanel(null, { command: "claude" })).toBe(false);
    expect(isSandboxedPanel(isolated, { command: "claude", launch: { kind: "ssh" } })).toBe(false);
  });

  it("wraps a shell tab only when it opted in, in an isolated workspace, without its own launcher", () => {
    expect(isSandboxedPanel(isolated, { command: "", sandboxShell: true })).toBe(true);
    expect(isSandboxedPanel(isolated, { command: "npm test", sandboxShell: true })).toBe(true);
    expect(isSandboxedPanel(isolated, { command: "", sandboxShell: false })).toBe(false);
    expect(isSandboxedPanel(isolated, { command: "" })).toBe(false);
    expect(isSandboxedPanel(isolated, { command: "", sandboxShell: true, launch: { kind: "ssh" } })).toBe(false);
    expect(isSandboxedPanel(isolated, { command: "__files__", sandboxShell: true })).toBe(false);
    expect(isSandboxedPanel({ sandboxEnabled: false, kind: "terminal" }, { command: "", sandboxShell: true })).toBe(
      false,
    );
    expect(isSandboxedPanel(null, { command: "", sandboxShell: true })).toBe(false);
  });

  it("wraps every Worker and Judge of a task, whatever they run, but not its dashboard", () => {
    const task = { sandboxEnabled: true, kind: "task" };
    expect(isSandboxedPanel(task, { command: "my-wrapper.sh" })).toBe(true);
    expect(isSandboxedPanel(task, { command: "__task-dashboard__" })).toBe(false);
  });

  it("detects the agent from the command's executable", () => {
    expect(detectSandboxAgent("C:\\tools\\gemini.cmd --yolo")).toBe("gemini");
    expect(detectSandboxAgent("claude mcp list")).toBeNull();
  });
});

describe("registry URLs", () => {
  it("accepts only an https URL without credentials, query or fragment", () => {
    expect(checkRegistryUrl("https://repo.example.com/maven/")).toEqual({
      ok: true,
      url: "https://repo.example.com/maven",
    });
    for (const bad of [
      "http://repo.example.com",
      "https://u:p@repo.example.com",
      "https://repo.example.com/?a=1",
      "https://x/#f",
      "nope",
      "",
    ]) {
      expect(checkRegistryUrl(bad).ok, bad).toBe(false);
    }
  });

  it("derives the secret reference from the id", () => {
    expect(registrySecretRef("abc")).toBe("registry:abc:secret");
  });
});
