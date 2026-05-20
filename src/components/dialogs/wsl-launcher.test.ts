import { describe, test, expect } from "vitest";
import { buildWslCommand, parseWslCommand } from "./wsl-launcher.js";

describe("buildWslCommand", () => {
  test("builds the full distro + cwd + command + keepOpen form", () => {
    const out = buildWslCommand({
      distro: "Ubuntu-22.04",
      cwd: "/home/kamil",
      command: "claude --dangerously-skip-permissions '/ai-devops-agent'",
      keepOpen: true,
    });
    expect(out).toBe(
      `wsl -d Ubuntu-22.04 -- bash -lic "cd /home/kamil && claude --dangerously-skip-permissions '/ai-devops-agent'; exec bash"`,
    );
  });

  test("omits -d flag when distro is empty", () => {
    const out = buildWslCommand({ distro: "", cwd: "/tmp", command: "ls", keepOpen: false });
    expect(out).toBe(`wsl -- bash -lic "cd /tmp && ls"`);
  });

  test("omits cd prefix when cwd is empty", () => {
    const out = buildWslCommand({ distro: "", cwd: "", command: "uname -a", keepOpen: false });
    expect(out).toBe(`wsl -- bash -lic "uname -a"`);
  });

  test("returns just exec bash when only keepOpen is set", () => {
    const out = buildWslCommand({ distro: "", cwd: "", command: "", keepOpen: true });
    expect(out).toBe(`wsl -- bash -lic "exec bash"`);
  });

  test("returns empty string when everything is blank", () => {
    expect(buildWslCommand({ distro: "", cwd: "", command: "", keepOpen: false })).toBe("");
  });

  test("escapes embedded double quotes and backslashes in the inner command", () => {
    const out = buildWslCommand({
      distro: "",
      cwd: "",
      command: `echo "hi \\there"`,
      keepOpen: false,
    });
    // The double quotes and backslashes inside the inner command get escaped
    // so the outer bash -lic "…" wrapper stays balanced.
    expect(out).toBe(`wsl -- bash -lic "echo \\"hi \\\\there\\""`);
  });

  test("quotes a cwd containing whitespace", () => {
    const out = buildWslCommand({
      distro: "",
      cwd: "/home/my projects/app",
      command: "ls",
      keepOpen: false,
    });
    expect(out).toBe(`wsl -- bash -lic "cd '/home/my projects/app' && ls"`);
  });

  test("quotes a cwd containing a literal single quote", () => {
    const out = buildWslCommand({
      distro: "",
      cwd: "/tmp/it's-here",
      command: "ls",
      keepOpen: false,
    });
    // close-quote, backslash-escape the apostrophe, reopen-quote
    expect(out).toBe(`wsl -- bash -lic "cd '/tmp/it'\\\\''s-here' && ls"`);
  });

  test("passes a plain cwd through without quotes for readability", () => {
    const out = buildWslCommand({ distro: "", cwd: "/home/user", command: "ls", keepOpen: false });
    expect(out).toBe(`wsl -- bash -lic "cd /home/user && ls"`);
  });

  test("trims surrounding whitespace from each field", () => {
    const out = buildWslCommand({
      distro: "  Ubuntu  ",
      cwd: "  /home  ",
      command: "  ls  ",
      keepOpen: false,
    });
    expect(out).toBe(`wsl -d Ubuntu -- bash -lic "cd /home && ls"`);
  });
});

describe("parseWslCommand", () => {
  test("parses the canonical full-form command", () => {
    const parsed = parseWslCommand(
      `wsl -d Ubuntu-22.04 -- bash -lic "cd /home/kamil && claude --dangerously-skip-permissions '/ai-devops-agent'; exec bash"`,
    );
    expect(parsed).toEqual({
      distro: "Ubuntu-22.04",
      cwd: "/home/kamil",
      command: "claude --dangerously-skip-permissions '/ai-devops-agent'",
      keepOpen: true,
    });
  });

  test("parses no-distro form", () => {
    expect(parseWslCommand(`wsl -- bash -lic "cd /tmp && ls"`)).toEqual({
      distro: "",
      cwd: "/tmp",
      command: "ls",
      keepOpen: false,
    });
  });

  test("parses command-only form (no cwd, no keepOpen)", () => {
    expect(parseWslCommand(`wsl -- bash -lic "uname -a"`)).toEqual({
      distro: "",
      cwd: "",
      command: "uname -a",
      keepOpen: false,
    });
  });

  test("parses exec-bash-only form (keepOpen alone)", () => {
    expect(parseWslCommand(`wsl -- bash -lic "exec bash"`)).toEqual({
      distro: "",
      cwd: "",
      command: "",
      keepOpen: true,
    });
  });

  test("returns null for non-WSL commands", () => {
    expect(parseWslCommand(`bash -c "ls"`)).toBeNull();
    expect(parseWslCommand("")).toBeNull();
    expect(parseWslCommand("claude --dangerously-skip-permissions")).toBeNull();
  });

  test("unescapes quotes and backslashes inside the inner command", () => {
    const parsed = parseWslCommand(`wsl -- bash -lic "echo \\"hi \\\\there\\""`);
    expect(parsed).toEqual({
      distro: "",
      cwd: "",
      command: `echo "hi \\there"`,
      keepOpen: false,
    });
  });

  test("parses a single-quoted cwd containing whitespace", () => {
    const parsed = parseWslCommand(`wsl -- bash -lic "cd '/home/my projects/app' && ls"`);
    expect(parsed).toEqual({
      distro: "",
      cwd: "/home/my projects/app",
      command: "ls",
      keepOpen: false,
    });
  });

  test("parses a single-quoted cwd containing an escaped single quote", () => {
    const parsed = parseWslCommand(`wsl -- bash -lic "cd '/tmp/it'\\\\''s-here' && ls"`);
    expect(parsed).toEqual({
      distro: "",
      cwd: "/tmp/it's-here",
      command: "ls",
      keepOpen: false,
    });
  });
});

describe("buildWslCommand ⇄ parseWslCommand round-trip", () => {
  const fixtures = [
    { distro: "Ubuntu", cwd: "/home/a", command: "ls -la", keepOpen: true },
    { distro: "", cwd: "/tmp", command: "pwd", keepOpen: false },
    { distro: "Debian", cwd: "", command: "echo hi", keepOpen: true },
    { distro: "", cwd: "", command: `claude --model sonnet '/agent'`, keepOpen: true },
    { distro: "Alpine", cwd: "/root", command: "", keepOpen: true },
  ];

  for (const fixture of fixtures) {
    test(`round-trip ${JSON.stringify(fixture)}`, () => {
      const built = buildWslCommand(fixture);
      const parsed = parseWslCommand(built);
      expect(parsed).toEqual(fixture);
    });
  }
});
