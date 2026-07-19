import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  configureCopilotHook,
  removeCopilotHook,
  detectCopilotHookStatus,
  findExistingHook,
  getCopilotConfigPath,
  getCopilotHome,
  COPILOT_HOOK_MAP,
  HOOKS_TO_REGISTER,
} from "./copilot-hook-config.js";

let tempDir: string;
let mockHomedir: string;
let userDataPath: string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let originalHomedir: any;
let originalCopilotHome: string | undefined;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-copilot-hook-"));
  mockHomedir = path.join(tempDir, "home");
  await fs.mkdir(mockHomedir, { recursive: true });
  userDataPath = path.join(tempDir, "strideterm-data");
  await fs.mkdir(userDataPath, { recursive: true });

  originalHomedir = os.homedir;
  os.homedir = () => mockHomedir;
  originalCopilotHome = process.env.COPILOT_HOME;
  delete process.env.COPILOT_HOME;
});

afterEach(async () => {
  os.homedir = originalHomedir;
  if (originalCopilotHome === undefined) delete process.env.COPILOT_HOME;
  else process.env.COPILOT_HOME = originalCopilotHome;
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe("configureCopilotHook", () => {
  test("writes notify.mjs and top-level hooks with flat bash/powershell schema", async () => {
    const result = await configureCopilotHook(userDataPath);

    expect(result.ok).toBe(true);
    expect(result.registered).toEqual([...HOOKS_TO_REGISTER]);
    expect(result.configPath).toBe(path.join(mockHomedir, ".copilot", "config.json"));
    expect(result.scriptPath).toBe(path.join(userDataPath, "hooks", "notify.mjs"));

    expect(existsSync(result.scriptPath!)).toBe(true);

    const config = JSON.parse(await fs.readFile(getCopilotConfigPath(), "utf8"));
    for (const [copilotEvent, canonicalName] of Object.entries(COPILOT_HOOK_MAP)) {
      expect(config.hooks[copilotEvent]).toHaveLength(1);
      const entry = config.hooks[copilotEvent][0];
      expect(entry.type).toBe("command");
      expect(entry.bash).toContain("notify.mjs");
      expect(entry.bash).toContain(canonicalName);
      expect(entry.powershell).toContain("notify.mjs");
      expect(entry.powershell).toContain(canonicalName);
      expect(entry.timeoutSec).toBe(5);
    }
  });

  test("preserves unrelated top-level config keys (model, theme, allowedUrls)", async () => {
    const copilotDir = path.join(mockHomedir, ".copilot");
    await fs.mkdir(copilotDir, { recursive: true });
    const existing = {
      model: "gpt-5.4",
      theme: "dark",
      allowedUrls: ["https://example.com"],
      trustedFolders: ["/home/user/proj"],
      customKey: "keepMe",
    };
    await fs.writeFile(getCopilotConfigPath(), JSON.stringify(existing, null, 2));

    const result = await configureCopilotHook(userDataPath);
    expect(result.ok).toBe(true);

    const merged = JSON.parse(await fs.readFile(getCopilotConfigPath(), "utf8"));
    expect(merged.model).toBe("gpt-5.4");
    expect(merged.theme).toBe("dark");
    expect(merged.allowedUrls).toEqual(["https://example.com"]);
    expect(merged.trustedFolders).toEqual(["/home/user/proj"]);
    expect(merged.customKey).toBe("keepMe");
    expect(merged.hooks.sessionEnd).toHaveLength(1);
  });

  test("parses and merges an externally-authored JSONC config (line/block comments + trailing commas)", async () => {
    const copilotDir = path.join(mockHomedir, ".copilot");
    await fs.mkdir(copilotDir, { recursive: true });
    // Genuine JSONC, not JSON.stringify output: header line comment, an
    // inline trailing comment, a block comment, and trailing commas before
    // both `]` and the top-level `}` — all of which JSON.parse would reject.
    const jsoncConfig = `// Copilot CLI user settings
{
  "model": "gpt-5.4", // pinned model
  /* theme block
     comment */
  "theme": "dark",
  "trustedFolders": [
    "/home/user/proj",
  ],
}
`;
    await fs.writeFile(getCopilotConfigPath(), jsoncConfig);

    const result = await configureCopilotHook(userDataPath);
    expect(result.ok).toBe(true);

    const merged = JSON.parse(await fs.readFile(getCopilotConfigPath(), "utf8"));
    expect(merged.model).toBe("gpt-5.4");
    expect(merged.theme).toBe("dark");
    expect(merged.trustedFolders).toEqual(["/home/user/proj"]);
    expect(merged.hooks.sessionEnd).toHaveLength(1);
    expect(merged.hooks.userPromptSubmitted).toHaveLength(1);
  });

  test("preserves user-authored hook entries", async () => {
    const copilotDir = path.join(mockHomedir, ".copilot");
    await fs.mkdir(copilotDir, { recursive: true });
    const existing = {
      hooks: {
        sessionEnd: [{ type: "command", bash: "echo custom-bash", powershell: "echo custom-ps" }],
        preToolUse: [{ type: "command", bash: "echo tool-start" }],
      },
    };
    await fs.writeFile(getCopilotConfigPath(), JSON.stringify(existing, null, 2));

    await configureCopilotHook(userDataPath);

    const config = JSON.parse(await fs.readFile(getCopilotConfigPath(), "utf8"));
    // User hook still there; strIDEterm entry appended
    expect(config.hooks.sessionEnd).toHaveLength(2);
    expect(config.hooks.sessionEnd[0].bash).toBe("echo custom-bash");
    expect(config.hooks.sessionEnd[1].bash).toContain("notify.mjs");
    // Unrelated preToolUse entries are untouched
    expect(config.hooks.preToolUse).toHaveLength(1);
    expect(config.hooks.preToolUse[0].bash).toBe("echo tool-start");
  });

  test("is idempotent — re-running replaces strIDEterm entry in place", async () => {
    await configureCopilotHook(userDataPath);
    await configureCopilotHook(userDataPath);

    const config = JSON.parse(await fs.readFile(getCopilotConfigPath(), "utf8"));
    for (const event of HOOKS_TO_REGISTER) {
      expect(config.hooks[event]).toHaveLength(1);
    }
  });

  test("uses forward slashes in hook commands for cross-platform shell compat", async () => {
    await configureCopilotHook(userDataPath);
    const config = JSON.parse(await fs.readFile(getCopilotConfigPath(), "utf8"));
    expect(config.hooks.sessionEnd[0].bash).not.toContain("\\");
    expect(config.hooks.sessionEnd[0].powershell).not.toContain("\\");
  });

  test("honors COPILOT_HOME env var override", async () => {
    const customHome = path.join(tempDir, "custom-copilot");
    process.env.COPILOT_HOME = customHome;

    expect(getCopilotHome()).toBe(customHome);
    expect(getCopilotConfigPath()).toBe(path.join(customHome, "config.json"));

    const result = await configureCopilotHook(userDataPath);
    expect(result.ok).toBe(true);
    expect(existsSync(path.join(customHome, "config.json"))).toBe(true);
    // The default ~/.copilot/config.json must not have been created
    expect(existsSync(path.join(mockHomedir, ".copilot", "config.json"))).toBe(false);
  });
});

describe("findExistingHook", () => {
  test("returns -1 when hooks section is missing", () => {
    expect(findExistingHook({}, "sessionEnd")).toBe(-1);
    expect(findExistingHook({ hooks: {} }, "sessionEnd")).toBe(-1);
  });

  test("returns index of strIDEterm entry identified by bash field", () => {
    const config = {
      hooks: {
        sessionEnd: [
          { type: "command", bash: "echo user" },
          { type: "command", bash: 'node "/x/hooks/notify.mjs" Stop', powershell: 'node "/x/hooks/notify.mjs" Stop' },
        ],
      },
    };
    expect(findExistingHook(config, "sessionEnd")).toBe(1);
  });

  test("matches entries that set only powershell field", () => {
    const config = {
      hooks: {
        sessionEnd: [{ type: "command", powershell: 'node "C:\\x\\hooks\\notify.mjs" Stop' }],
      },
    };
    expect(findExistingHook(config, "sessionEnd")).toBe(0);
  });

  test("ignores entries without the marker", () => {
    const config = {
      hooks: {
        sessionEnd: [{ type: "command", bash: "other-tool --foo" }],
      },
    };
    expect(findExistingHook(config, "sessionEnd")).toBe(-1);
  });
});

describe("removeCopilotHook", () => {
  test("removes strIDEterm entries and leaves user entries intact", async () => {
    const copilotDir = path.join(mockHomedir, ".copilot");
    await fs.mkdir(copilotDir, { recursive: true });
    await fs.writeFile(
      getCopilotConfigPath(),
      JSON.stringify({
        model: "gpt-5.4",
        hooks: { sessionEnd: [{ type: "command", bash: "echo user" }] },
      }),
    );
    await configureCopilotHook(userDataPath);

    const result = await removeCopilotHook();
    expect(result.ok).toBe(true);
    expect(result.removed).toBe(true);
    expect(result.removedFrom).toContain("sessionEnd");

    const config = JSON.parse(await fs.readFile(getCopilotConfigPath(), "utf8"));
    expect(config.model).toBe("gpt-5.4");
    expect(config.hooks.sessionEnd).toHaveLength(1);
    expect(config.hooks.sessionEnd[0].bash).toBe("echo user");
  });

  test("is a no-op when config exists but has no strIDEterm hooks", async () => {
    const copilotDir = path.join(mockHomedir, ".copilot");
    await fs.mkdir(copilotDir, { recursive: true });
    await fs.writeFile(getCopilotConfigPath(), JSON.stringify({ model: "gpt-5.4" }));

    const result = await removeCopilotHook();
    expect(result.ok).toBe(true);
    expect(result.removed).toBe(false);
  });

  test("returns removed=false when config file is missing", async () => {
    const result = await removeCopilotHook();
    expect(result.ok).toBe(true);
    expect(result.removed).toBe(false);
  });
});

describe("detectCopilotHookStatus", () => {
  test("returns not-configured when config file is missing", async () => {
    const status = await detectCopilotHookStatus(userDataPath);
    expect(status.status).toBe("not-configured");
  });

  test("returns not-configured when config has no strIDEterm entries", async () => {
    const copilotDir = path.join(mockHomedir, ".copilot");
    await fs.mkdir(copilotDir, { recursive: true });
    await fs.writeFile(getCopilotConfigPath(), JSON.stringify({ model: "gpt-5.4" }));

    const status = await detectCopilotHookStatus(userDataPath);
    expect(status.status).toBe("not-configured");
  });

  test("returns configured after configureCopilotHook", async () => {
    await configureCopilotHook(userDataPath);
    const status = await detectCopilotHookStatus(userDataPath);
    expect(status.status).toBe("configured");
    expect(status.registered).toEqual([...HOOKS_TO_REGISTER]);
  });

  test("returns configured for a hand-authored JSONC config with comments and trailing commas", async () => {
    const copilotDir = path.join(mockHomedir, ".copilot");
    await fs.mkdir(copilotDir, { recursive: true });
    const hooksDir = path.join(userDataPath, "hooks");
    await fs.mkdir(hooksDir, { recursive: true });
    await fs.writeFile(path.join(hooksDir, "notify.mjs"), "// stub\n");

    // Simulates Copilot's own config.json shape: header comment, an inline
    // trailing comment, a block comment, and trailing commas before `]`/`}`.
    const jsoncConfig = `// Copilot CLI settings
{
  "model": "gpt-5.4",
  /* strIDEterm-managed hooks below */
  "hooks": {
    "sessionEnd": [
      { "type": "command", "bash": "node \\"/x/hooks/notify.mjs\\" Stop", "powershell": "node \\"/x/hooks/notify.mjs\\" Stop", "timeoutSec": 5 }, // notify on stop
    ],
    "userPromptSubmitted": [
      { "type": "command", "bash": "node \\"/x/hooks/notify.mjs\\" UserPromptSubmit", "powershell": "node \\"/x/hooks/notify.mjs\\" UserPromptSubmit", "timeoutSec": 5 },
    ],
  },
}
`;
    await fs.writeFile(getCopilotConfigPath(), jsoncConfig);

    const status = await detectCopilotHookStatus(userDataPath);
    expect(status.status).toBe("configured");
    expect(status.registered).toEqual([...HOOKS_TO_REGISTER]);
  });

  test("returns partial when only some events are registered", async () => {
    await configureCopilotHook(userDataPath);
    const config = JSON.parse(await fs.readFile(getCopilotConfigPath(), "utf8"));
    delete config.hooks.userPromptSubmitted;
    await fs.writeFile(getCopilotConfigPath(), JSON.stringify(config, null, 2));

    const status = await detectCopilotHookStatus(userDataPath);
    expect(status.status).toBe("partial");
    expect(status.missingHooks).toContain("userPromptSubmitted");
  });

  test("returns script-missing when hooks exist but notify.mjs is gone", async () => {
    await configureCopilotHook(userDataPath);
    await fs.rm(path.join(userDataPath, "hooks", "notify.mjs"));

    const status = await detectCopilotHookStatus(userDataPath);
    expect(status.status).toBe("script-missing");
  });

  test("returns configured-but-disabled when disableAllHooks: true", async () => {
    await configureCopilotHook(userDataPath);
    const config = JSON.parse(await fs.readFile(getCopilotConfigPath(), "utf8"));
    config.disableAllHooks = true;
    await fs.writeFile(getCopilotConfigPath(), JSON.stringify(config, null, 2));

    const status = await detectCopilotHookStatus(userDataPath);
    expect(status.status).toBe("configured-but-disabled");
  });

  test("returns error when config file is malformed JSON", async () => {
    const copilotDir = path.join(mockHomedir, ".copilot");
    await fs.mkdir(copilotDir, { recursive: true });
    await fs.writeFile(getCopilotConfigPath(), "{ not valid json");

    const status = await detectCopilotHookStatus(userDataPath);
    expect(status.status).toBe("error");
  });
});
