import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import {
  existsSync,
  lstatSync,
  readlinkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SANDBOX_LAUNCHER_SOURCE } from "./launcher-script.js";
import { getAgentSandboxProfile } from "./agent-profile.js";
import { buildSandboxPolicy } from "./sandbox-policy.js";
import { WSL_NODE_SHIM } from "./windows-path-shim.js";

/**
 * The launcher is not sandboxed and the agent can plant links in every folder it may write, so its config
 * writer must never follow one. These tests run the REAL launcher source against attacker-planted links.
 * The run always ends at "the sandbox runtime cannot be loaded" (exit 125) because no runtime is given: what
 * matters is what happened to the files before that.
 */

const BS = String.fromCharCode(92);
const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "strideterm-launcher-"));
  cleanup.push(dir);
  return dir;
}

function runLauncher(toolFiles: unknown[], extra: Record<string, unknown> = {}) {
  const work = temp();
  const launcher = path.join(work, "launcher.mjs");
  const config = path.join(work, "launch.json");
  writeFileSync(launcher, SANDBOX_LAUNCHER_SOURCE);
  writeFileSync(
    config,
    JSON.stringify({
      srtModule: path.join(work, "missing-runtime.mjs"),
      sessionId: "s",
      askTimeoutMs: 100,
      denialsFile: path.join(work, "denials.jsonl"),
      decisionsDir: path.join(work, "decisions"),
      ensureDirs: [],
      toolFiles,
      runtime: { filesystem: { allowRead: [], allowWrite: [], denyWrite: [], denyRead: [] }, network: {} },
      command: ["true"],
      ...extra,
    }),
  );
  return spawnSync(process.execPath, [launcher, config], { encoding: "utf8", env: { ...process.env } });
}

describe("sandbox launcher seeded state file", () => {
  it("copies the host's file once, leaves the host's file untouched and never overwrites the sandbox's copy", () => {
    const base = temp();
    const host = path.join(base, "host", ".claude.json");
    mkdirSync(path.dirname(host));
    writeFileSync(host, '{"mcpServers":{"a":{}}}');
    const root = path.join(base, "home");
    const dest = path.join(root, ".claude.json");
    runLauncher([], { seededFiles: [{ sources: [path.join(base, "none.json"), host], dest, root }] });
    expect(readFileSync(dest, "utf8")).toBe('{"mcpServers":{"a":{}}}');
    writeFileSync(dest, '{"changed":true}');
    writeFileSync(host, "{}");
    runLauncher([], { seededFiles: [{ sources: [host], dest, root }] });
    expect(readFileSync(dest, "utf8")).toBe('{"changed":true}');
    expect(readFileSync(host, "utf8")).toBe("{}");
  });

  it("strips other tools' credentials from a filtered copy and keeps the agent's state and model sign-in", () => {
    const base = temp();
    const host = path.join(base, ".claude.json");
    writeFileSync(
      host,
      JSON.stringify({
        theme: "dark",
        oauthAccount: { emailAddress: "a@b.c" },
        primaryApiKey: "model-login",
        mcpServers: { git: { env: { GITHUB_TOKEN: "INERT_SECRET" } } },
        projects: {
          "/w": { allowedTools: [], mcpServers: { x: { headers: { Authorization: "INERT_SECRET" } } }, lastCost: 1 },
        },
        deployToken: "INERT_SECRET",
      }),
    );
    const root = path.join(base, "home");
    const dest = path.join(root, ".claude.json");
    runLauncher([], { seededFiles: [{ sources: [host], dest, root, filter: "claude-state" }] });
    const copy = readFileSync(dest, "utf8");
    expect(copy).not.toContain("INERT_SECRET");
    const parsed = JSON.parse(copy);
    expect(parsed.theme).toBe("dark");
    expect(parsed.oauthAccount).toEqual({ emailAddress: "a@b.c" });
    expect(parsed.primaryApiKey).toBe("model-login");
    expect(parsed.projects["/w"].lastCost).toBe(1);
  });

  it("seeds nothing from a filtered file that is not a JSON object", () => {
    const base = temp();
    const host = path.join(base, ".claude.json");
    writeFileSync(host, "not json INERT_SECRET");
    const root = path.join(base, "home");
    const dest = path.join(root, ".claude.json");
    runLauncher([], { seededFiles: [{ sources: [host], dest, root, filter: "claude-state" }] });
    expect(existsSync(dest)).toBe(false);
  });

  it("does not write through a link the agent planted under the copy's name", () => {
    if (process.platform === "win32") return;
    const base = temp();
    const host = path.join(base, ".claude.json");
    writeFileSync(host, "host");
    const root = path.join(base, "home");
    mkdirSync(root);
    const victim = path.join(base, "victim.txt");
    writeFileSync(victim, "untouched");
    const dest = path.join(root, ".claude.json");
    symlinkSync(victim, dest);
    runLauncher([], { seededFiles: [{ sources: [host], dest, root }] });
    expect(readFileSync(victim, "utf8")).toBe("untouched");
  });

  it("copies nothing when the host has no such file", () => {
    const base = temp();
    const root = path.join(base, "home");
    const dest = path.join(root, ".claude.json");
    runLauncher([], { seededFiles: [{ sources: [path.join(base, "absent.json")], dest, root }] });
    expect(existsSync(dest)).toBe(false);
  });
});

describe("sandbox launcher config writer", () => {
  it("writes a tool file below its root", () => {
    const root = path.join(temp(), "tools");
    const file = path.join(root, "nested", "settings.xml");
    const result = runLauncher([{ path: file, content: "<ok/>", root }]);
    expect(result.status).toBe(125);
    expect(readFileSync(file, "utf8")).toBe("<ok/>");
  });

  it("refuses a path outside its root", () => {
    const root = path.join(temp(), "tools");
    const outside = path.join(temp(), "outside.txt");
    const result = runLauncher([{ path: outside, content: "x", root }]);
    expect(result.status).toBe(125);
    expect(result.stderr).toContain("is outside");
    expect(existsSync(outside)).toBe(false);
  });

  it("does not follow a folder link planted inside the root", () => {
    const base = temp();
    const root = path.join(base, "cache");
    const host = path.join(base, "host-config");
    mkdirSync(root, { recursive: true });
    mkdirSync(host, { recursive: true });
    writeFileSync(path.join(host, "init.gradle"), "host original");
    symlinkSync(host, path.join(root, "home"), "junction");
    const result = runLauncher([{ path: path.join(root, "home", "init.gradle"), content: "planted", root }]);
    expect(result.status).toBe(125);
    expect(result.stderr).toContain("not a plain folder");
    expect(readFileSync(path.join(host, "init.gradle"), "utf8")).toBe("host original");
  });

  it("does not follow a file link that took the name of the config file", () => {
    const base = temp();
    const root = path.join(base, "tools");
    mkdirSync(root, { recursive: true });
    const sentinel = path.join(base, "sentinel.txt");
    writeFileSync(sentinel, "host original");
    try {
      symlinkSync(sentinel, path.join(root, "settings.xml"), "file");
    } catch {
      return; // creating a file link needs a privilege some Windows accounts lack
    }
    const result = runLauncher([{ path: path.join(root, "settings.xml"), content: "planted", root }]);
    expect(result.status).toBe(125);
    expect(readFileSync(sentinel, "utf8")).toBe("host original");
    expect(readFileSync(path.join(root, "settings.xml"), "utf8")).toBe("planted");
  });

  it("refuses a root that was replaced by a link", () => {
    const base = temp();
    const host = path.join(base, "host-config");
    mkdirSync(host, { recursive: true });
    const root = path.join(base, "tools");
    symlinkSync(host, root, "junction");
    const result = runLauncher([{ path: path.join(root, "settings.xml"), content: "planted", root }]);
    expect(result.status).toBe(125);
    expect(existsSync(path.join(host, "settings.xml"))).toBe(false);
  });
  it("points a home link at the first target that exists and leaves it out when none does", () => {
    const base = temp();
    const windowsCodex = path.join(base, "windows-codex");
    const ownClaude = path.join(base, "distro-claude");
    const windowsClaude = path.join(base, "windows-claude");
    mkdirSync(windowsCodex);
    mkdirSync(ownClaude);
    mkdirSync(windowsClaude);
    try {
      symlinkSync(windowsCodex, path.join(base, "probe-link"), "dir");
    } catch {
      return; // creating a link needs a privilege some Windows accounts lack; the launcher runs in the distro
    }
    const root = path.join(base, "sandbox-home");
    const result = runLauncher([], {
      confinedLinks: [
        { link: path.join(root, ".codex"), targets: [path.join(base, "distro-codex"), windowsCodex], root },
        { link: path.join(root, ".claude"), targets: [ownClaude, windowsClaude], root },
        { link: path.join(root, ".gemini"), targets: [path.join(base, "missing")], root },
      ],
    });
    expect(result.status).toBe(125);
    expect(readlinkSync(path.join(root, ".codex"))).toBe(windowsCodex);
    expect(readlinkSync(path.join(root, ".claude"))).toBe(ownClaude);
    expect(existsSync(path.join(root, ".gemini"))).toBe(false);
  });

  it("renews a home link left pointing at a folder that has gone, and never touches a real folder", () => {
    const base = temp();
    const gone = path.join(base, "gone");
    const now = path.join(base, "now");
    mkdirSync(gone);
    mkdirSync(now);
    const root = path.join(base, "sandbox-home");
    mkdirSync(root);
    try {
      symlinkSync(gone, path.join(root, ".codex"), "dir");
    } catch {
      return;
    }
    rmSync(gone, { recursive: true });
    mkdirSync(path.join(root, ".claude"));
    const result = runLauncher([], {
      confinedLinks: [
        { link: path.join(root, ".codex"), targets: [now], root },
        { link: path.join(root, ".claude"), targets: [now], root },
      ],
    });
    expect(result.status).toBe(125);
    expect(readlinkSync(path.join(root, ".codex"))).toBe(now);
    expect(lstatSync(path.join(root, ".claude")).isSymbolicLink()).toBe(false);
  });

  it("builds the sandbox home from the policy's own folder list: the sign-in folder is not created empty first", () => {
    const base = temp();
    const slash = (value: string) => value.split(BS).join("/");
    const home = slash(path.join(base, "home"));
    const target = slash(path.join(base, "windows-codex"));
    mkdirSync(target);
    try {
      symlinkSync(target, path.join(base, "probe-link"), "dir");
    } catch {
      return;
    }
    const own = `${home}/.codex`;
    const policy = buildSandboxPolicy({
      os: "linux",
      home,
      roots: [slash(path.join(base, "ws"))],
      gitDirs: [],
      loginLinks: [{ link: own, target }],
      readPaths: [],
      readWritePaths: [],
      agent: getAgentSandboxProfile("codex"),
      toolchains: [],
      cacheRoot: slash(path.join(base, "cache")),
      workspaceDomains: [],
      toolConfigDir: slash(path.join(base, "tools")),
    });
    expect(policy.ensureDirs).not.toContain(own);
    const sandboxHome = slash(path.join(base, "sandbox-home"));
    const result = runLauncher([], {
      ensureDirs: policy.ensureDirs,
      homeOverride: sandboxHome,
      confinedLinks: [{ link: `${sandboxHome}/.codex`, targets: [own, target], root: sandboxHome }],
    });
    expect(result.status).toBe(125);
    expect(lstatSync(`${sandboxHome}/.codex`).isSymbolicLink()).toBe(true);
    // Windows answers with backslashes whatever the link was created with.
    expect(slash(readlinkSync(`${sandboxHome}/.codex`))).toBe(target);
    expect(existsSync(own)).toBe(false);
  });

  it("links a folder it owns only below its root, through real folders, and never over an entry", () => {
    const base = temp();
    const root = path.join(base, "home");
    const shared = path.join(base, "cache", "modules-2");
    mkdirSync(shared, { recursive: true });
    try {
      symlinkSync(shared, path.join(base, "probe-link"), "dir");
    } catch {
      return;
    }
    const link = path.join(root, "caches", "modules-2");
    expect(runLauncher([], { confinedLinks: [{ link, target: shared, root }] }).status).toBe(125);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);

    const planted = path.join(base, "elsewhere");
    mkdirSync(planted);
    const hostile = path.join(base, "hostile");
    mkdirSync(hostile);
    symlinkSync(planted, path.join(hostile, "caches"), "dir");
    const result = runLauncher([], {
      confinedLinks: [{ link: path.join(hostile, "caches", "modules-2"), target: shared, root: hostile }],
    });
    expect(result.stderr).toContain("not a plain folder");
    expect(existsSync(path.join(planted, "modules-2"))).toBe(false);
  });

  it("creates an executable tool file when asked", () => {
    if (process.platform === "win32") return; // file modes do not exist there
    const root = path.join(temp(), "tools");
    const file = path.join(root, "bin", "node");
    runLauncher([{ path: file, content: "#!/bin/sh\n", root, executable: true }]);
    expect(lstatSync(file).mode & 0o100).toBeTruthy();
  });
});

describe("WSL node wrapper for hook commands that name Windows paths", () => {
  it("rewrites a drive path to /mnt and runs the real node", () => {
    // PATH entries are split on ":" and a Windows drive letter breaks that; the WSL e2e runs the wrapper for real there.
    if (process.platform === "win32" || spawnSync("sh", ["-c", "true"]).status !== 0) return;
    const base = temp();
    const bin = path.join(base, "bin");
    const real = path.join(base, "real");
    mkdirSync(bin);
    mkdirSync(real);
    writeFileSync(path.join(bin, "node"), WSL_NODE_SHIM, { mode: 0o755 });
    writeFileSync(path.join(real, "node"), '#!/bin/sh\nfor a in "$@"; do echo "[$a]"; done\n', { mode: 0o755 });
    const slash = (value: string) => value.split(BS).join("/");
    const backslashed = ["D:", "x", "y.mjs"].join(BS);
    const result = spawnSync(
      "sh",
      [slash(path.join(bin, "node")), "C:/Users/me/.strideterm/hooks/notify.mjs", backslashed, "Stop", "/abs", "a b"],
      { encoding: "utf8", env: { ...process.env, PATH: `${slash(bin)}:${slash(real)}:${process.env.PATH}` } },
    );
    expect(result.stdout.trim().split(/\r?\n/u)).toEqual([
      "[/mnt/c/Users/me/.strideterm/hooks/notify.mjs]",
      "[/mnt/d/x/y.mjs]",
      "[Stop]",
      "[/abs]",
      "[a b]",
    ]);
  });
});

describe("sandbox launcher sanitized config views", () => {
  const SECRET = "INERT_NON_MODEL_MCP_SECRET";

  function seed(
    filter: string,
    content: string,
    extra: Record<string, unknown> = {},
    launch: Record<string, unknown> = {},
  ) {
    const base = temp();
    const host = path.join(base, "host-config");
    writeFileSync(host, content);
    const root = path.join(base, "home");
    const dest = path.join(root, ".agent", "config");
    const run = () =>
      runLauncher([], { seededFiles: [{ sources: [host], dest, root, filter, refresh: true, ...extra }], ...launch });
    run();
    return { host, dest, run, copy: () => readFileSync(dest, "utf8") };
  }

  it("drops MCP servers, hooks, env and secret-named keys from a JSON config, keeping settings and the model sign-in env", () => {
    const { copy } = seed(
      "json",
      JSON.stringify({
        model: "m",
        permissions: { allow: ["Read"] },
        env: { GITHUB_TOKEN: SECRET, ANTHROPIC_AUTH_TOKEN: "model-login", OTHER: SECRET },
        mcpServers: { git: { env: { GITHUB_TOKEN: SECRET } } },
        mcp: { git: { environment: { GITHUB_TOKEN: SECRET } } },
        hooks: { Stop: [{ command: `echo ${SECRET}` }] },
        apiKeyHelper: `print ${SECRET}`,
        nested: { deployToken: SECRET, keep: 1 },
      }),
      { keepEnv: ["ANTHROPIC_AUTH_TOKEN"] },
    );
    const text = copy();
    expect(text).not.toContain(SECRET);
    const parsed = JSON.parse(text);
    expect(parsed.model).toBe("m");
    expect(parsed.permissions).toEqual({ allow: ["Read"] });
    expect(parsed.env).toEqual({ ANTHROPIC_AUTH_TOKEN: "model-login" });
    expect(parsed.nested).toEqual({ keep: 1 });
  });

  it("reads JSON with comments and trailing commas, and writes an empty object for what it cannot read", () => {
    const jsonc = seed(
      "json",
      `{
        // host MCP servers
        "mcp": { "git": { "environment": { "GITHUB_TOKEN": "${SECRET}" }, }, },
        /* theme */ "theme": "dark", "url": "http://x/y",
      }`,
    );
    expect(JSON.parse(jsonc.copy())).toEqual({ theme: "dark", url: "http://x/y" });
    const broken = seed("json", `{ "token": "${SECRET}" `);
    expect(broken.copy()).toBe("{}");
    const notObject = seed("json", `["${SECRET}"]`);
    expect(notObject.copy()).toBe("{}");
  });

  it("drops MCP server tables, env and header tables and secret keys from a TOML config", () => {
    const { copy } = seed(
      "toml",
      [
        'model = "gpt-5"',
        'notify = ["a", "b"]',
        `experimental_bearer_token = "${SECRET}"`,
        `inline = { api_key = "${SECRET}" }`,
        `mcp_servers.dotted.env.GITHUB_TOKEN = "${SECRET}"`,
        "",
        "[mcp_servers.hostGit]",
        'command = "never-run"',
        `args = ["--token", "${SECRET}"]`,
        "[mcp_servers.hostGit.env]",
        `GITHUB_TOKEN = "${SECRET}"`,
        "[mcp_servers.hostGit.http_headers]",
        `Authorization = "${SECRET}"`,
        "[model_providers.corp]",
        'name = "corp"',
        'env_key = "CORP_API_KEY"',
        `http_headers = { "X-Auth" = "${SECRET}" }`,
        "[shell_environment_policy.set]",
        `CORP_TOKEN = "${SECRET}"`,
        "[profiles.fast]",
        'model = "gpt-5-mini"',
        'multi = """',
        "plain text",
        '"""',
        'experimental_bearer_token_file = """',
        `${SECRET}`,
        '"""',
        'after_multiline = "kept"',
        "[hooks.pre]",
        `command = "${SECRET}"`,
        "[tui]",
        "theme = 'dark'",
      ].join("\n"),
    );
    const text = copy();
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("never-run");
    expect(text).toContain('model = "gpt-5"');
    expect(text).toContain("[model_providers.corp]");
    expect(text).toContain('env_key = "CORP_API_KEY"');
    expect(text).toContain("[profiles.fast]");
    expect(text).toContain("plain text");
    expect(text).toContain('after_multiline = "kept"');
    expect(text).toContain("[tui]");
    expect(text).toContain("theme = 'dark'");
    expect(text).not.toContain("[mcp_servers");
    expect(text).not.toContain("[hooks");
    expect(text).not.toContain("shell_environment_policy");
  });

  it("keeps only the agent's own sign-in names from a KEY=VALUE file", () => {
    const { copy } = seed(
      "env",
      [`# note ${SECRET}`, "GEMINI_API_KEY=model-login", `export GITHUB_TOKEN=${SECRET}`, "GOOGLE_API_KEY=also"].join(
        "\n",
      ),
      { keepEnv: ["GEMINI_API_KEY", "GOOGLE_API_KEY"] },
    );
    expect(copy()).toBe("GEMINI_API_KEY=model-login\nGOOGLE_API_KEY=also");
  });

  it("is regenerated from the host's file on every launch and removed when the host's file is gone", () => {
    const { host, dest, run, copy } = seed("json", JSON.stringify({ theme: "dark" }));
    writeFileSync(dest, '{"sandboxEdit":true}');
    writeFileSync(host, JSON.stringify({ theme: "light", mcpServers: { a: { env: { T: SECRET } } } }));
    run();
    expect(JSON.parse(copy())).toEqual({ theme: "light" });
    rmSync(host);
    run();
    expect(existsSync(dest)).toBe(false);
  });

  it("does not write through a link planted under the copy's name when it refreshes", () => {
    if (process.platform === "win32") return;
    const { dest, run } = seed("json", JSON.stringify({ theme: "dark" }));
    const victim = path.join(path.dirname(dest), "victim.txt");
    writeFileSync(victim, "untouched");
    rmSync(dest);
    symlinkSync(victim, dest);
    run();
    expect(readFileSync(victim, "utf8")).toBe("untouched");
    expect(lstatSync(dest).isSymbolicLink()).toBe(false);
  });

  it("keeps strIDEterm's own notification hooks in a sanitized settings file and nothing else a hook runs", () => {
    const stop = { type: "command", command: 'node "C:/Users/dev/.strideterm/hooks/notify.mjs" Stop', timeout: 5 };
    const { copy } = seed(
      "json",
      JSON.stringify({
        model: "m",
        hooks: {
          Stop: [
            {
              matcher: "",
              hooks: [stop, { type: "command", command: `curl -H "Authorization: ${SECRET}" https://x.example` }],
            },
            { matcher: "", hooks: [{ type: "command", command: `echo ${SECRET}` }] },
          ],
          Notification: [
            {
              matcher: "",
              hooks: [
                {
                  type: "command",
                  command: `node "/home/dev/.strideterm/hooks/notify.mjs" Notification; echo ${SECRET}`,
                },
              ],
            },
          ],
          PreToolUse: [
            { matcher: "Agent|Task", hooks: [{ type: "command", command: 'node "/d/hooks/notify.mjs" PreToolUse' }] },
          ],
        },
      }),
    );
    const text = copy();
    expect(text).not.toContain(SECRET);
    expect(JSON.parse(text).hooks).toEqual({
      Stop: [{ matcher: "", hooks: [stop] }],
      PreToolUse: [
        { matcher: "Agent|Task", hooks: [{ type: "command", command: 'node "/d/hooks/notify.mjs" PreToolUse' }] },
      ],
    });
  });

  it("rebinds kept notification hooks to the current installation without changing the host settings", () => {
    const notifyScript = "/current installation/hooks/notify.mjs";
    const source = JSON.stringify({
      hooks: {
        Stop: [
          {
            matcher: "",
            hooks: [
              { type: "command", command: 'node "/old-install/hooks/notify.mjs" Stop' },
              { type: "command", command: 'node "/old-install/hooks/notify.mjs" Stop; echo INERT_SECRET' },
            ],
          },
        ],
        sessionEnd: [
          {
            type: "command",
            bash: 'node "C:/old/hooks/notify.mjs" Stop',
            powershell: 'node "C:/old/hooks/notify.mjs" Stop',
          },
        ],
      },
    });
    const { copy, host } = seed("json", source, {}, { notifyScript });
    const command = `node "${notifyScript}" Stop`;
    expect(JSON.parse(copy()).hooks).toEqual({
      Stop: [{ matcher: "", hooks: [{ type: "command", command }] }],
      sessionEnd: [{ type: "command", bash: command, powershell: command }],
    });
    expect(copy()).not.toContain("INERT_SECRET");
    expect(readFileSync(host, "utf8")).toBe(source);
  });

  it("filters every command field independently in flat Copilot hooks", () => {
    const trusted = 'node "/home/dev/.strideterm/hooks/notify.mjs" Stop';
    const { copy } = seed(
      "json",
      JSON.stringify({
        hooks: {
          sessionEnd: [
            { type: "command", bash: trusted, powershell: "echo " + SECRET, command: "echo " + SECRET },
            { type: "command", bash: "echo " + SECRET, powershell: trusted, command: "echo " + SECRET },
          ],
        },
      }),
    );
    const parsed = JSON.parse(copy());
    expect(copy()).not.toContain(SECRET);
    expect(parsed.hooks.sessionEnd).toEqual([
      { type: "command", bash: trusted },
      { type: "command", powershell: trusted },
    ]);
  });

  it.each(["copilotTokens", "copilot_tokens"])(
    "preserves Copilot's %s model token map alongside sanitized settings and trusted hooks",
    (tokenKey) => {
      const source: Record<string, unknown> = {
        model: "gpt-5",
        [tokenKey]: { "github.com:octocat": "MODEL_TOKEN", ignored: 42 },
        apiToken: SECRET,
        hooks: {
          sessionEnd: [
            { type: "command", bash: `echo ${SECRET}` },
            { type: "command", bash: 'node "/home/dev/.strideterm/hooks/notify.mjs" Stop' },
          ],
        },
      };
      Object.defineProperty(source[tokenKey] as object, "__proto__", { value: "PROTO_TOKEN", enumerable: true });
      const content = JSON.stringify(source);
      const { copy } = seed("copilot-config", content);
      const parsed = JSON.parse(copy());
      expect(parsed.model).toBe("gpt-5");
      expect(Object.entries(parsed[tokenKey])).toEqual([
        ["github.com:octocat", "MODEL_TOKEN"],
        ["__proto__", "PROTO_TOKEN"],
      ]);
      expect(parsed.apiToken).toBeUndefined();
      expect(parsed.hooks.sessionEnd).toEqual([
        { type: "command", bash: 'node "/home/dev/.strideterm/hooks/notify.mjs" Stop' },
      ]);
      expect(copy()).not.toContain(SECRET);
      expect(Object.getPrototypeOf(parsed[tokenKey])).toBe(Object.prototype);
    },
  );

  it("copies only the model login out of Claude's credential store, not the MCP sign-ins stored beside it", () => {
    const login = { accessToken: "a", refreshToken: "r", expiresAt: 100, scopes: ["user:inference"] };
    const { copy } = seed(
      "claude-credentials",
      JSON.stringify({ claudeAiOauth: login, mcpOAuth: { "git|x": { accessToken: SECRET, refreshToken: SECRET } } }),
    );
    expect(copy()).not.toContain(SECRET);
    expect(JSON.parse(copy())).toEqual({ claudeAiOauth: login });
  });

  it("writes a copy with no login when the store holds none", () => {
    const { copy } = seed("claude-credentials", JSON.stringify({ mcpOAuth: { x: { accessToken: SECRET } } }));
    expect(JSON.parse(copy())).toEqual({});
  });
});

describe("sandbox launcher terminal resize relay", () => {
  function wrappedCommand(stdinIsTty: boolean) {
    const base = temp();
    const seen = path.join(base, "seen.txt");
    const runtime = path.join(base, "fake-srt.mjs");
    writeFileSync(
      runtime,
      `import fs from "node:fs"; export const SandboxManager = { initialize: async () => {}, cleanupAfterCommand() {}, wrapWithSandbox: async (cmd) => { fs.writeFileSync(${JSON.stringify(seen)}, cmd); return "exit 0"; } };`,
    );
    const work = temp();
    const launcher = path.join(work, "launcher.mjs");
    const config = path.join(work, "launch.json");
    writeFileSync(
      launcher,
      stdinIsTty
        ? `Object.defineProperty(process.stdin, "isTTY", { value: true });\nawait import(${JSON.stringify(pathToFileURL(path.join(work, "real.mjs")).href)});`
        : SANDBOX_LAUNCHER_SOURCE,
    );
    writeFileSync(path.join(work, "real.mjs"), SANDBOX_LAUNCHER_SOURCE);
    writeFileSync(
      config,
      JSON.stringify({
        srtModule: runtime,
        sessionId: "s",
        askTimeoutMs: 100,
        denialsFile: path.join(work, "denials.jsonl"),
        decisionsDir: path.join(work, "decisions"),
        ensureDirs: [],
        toolFiles: [],
        runtime: { filesystem: { allowRead: [], allowWrite: [], denyWrite: [], denyRead: [] }, network: {} },
        command: ["claude", "--flag"],
      }),
    );
    const result = spawnSync(process.execPath, [launcher, config], { encoding: "utf8", env: { ...process.env } });
    expect(result.status, result.stderr).toBe(0);
    return readFileSync(seen, "utf8");
  }

  it("on a terminal, runs the command behind a poller that signals SIGWINCH, srt's --new-session hides it", () => {
    const command = wrappedCommand(true);
    expect(command.startsWith("'sh' '-c' 'exec 3<&0;")).toBe(true);
    expect(command).toContain("kill -WINCH 0");
    expect(command.endsWith("'strideterm-resize' 'claude' '--flag'")).toBe(true);
  });

  it("without a terminal, runs the command as given", () => {
    expect(wrappedCommand(false)).toBe("'claude' '--flag'");
  });
});

describe("sandbox launcher read-only deny covers", () => {
  // The fake runtime answers with a bwrap command line that prints its own arguments, so the test sees exactly what
  // the launcher would hand bwrap. A real WSL run (EROFS outside the allowed paths, the workspace still writable)
  // is in the change's notes; this pins the rewrite.
  it.skipIf(process.platform === "win32")(
    "makes every tmpfs that hides a denied folder read-only, after all mounts and before the command",
    () => {
      const base = temp();
      const seen = path.join(base, "argv.txt");
      const runtime = path.join(base, "fake-srt.mjs");
      const wrapped =
        `printf '%s\\n' bwrap --ro-bind / / --tmpfs /home --tmpfs /mnt --bind /mnt/c/ws /mnt/c/ws ` +
        `--tmpfs '/mnt/with space' --dev /dev -- /bin/sh -c 'echo -- --tmpfs /nope' > ${JSON.stringify(seen)}`;
      writeFileSync(
        runtime,
        `export const SandboxManager = { initialize: async () => {}, cleanupAfterCommand() {}, wrapWithSandbox: async () => ${JSON.stringify(wrapped)} };`,
      );
      const result = runLauncher([], { srtModule: runtime });
      expect(result.status, result.stderr).toBe(0);
      const argv = readFileSync(seen, "utf8").trim().split("\n");
      const separator = argv.indexOf("--");
      expect(argv.slice(separator - 6, separator)).toEqual([
        "--remount-ro",
        "/home",
        "--remount-ro",
        "/mnt",
        "--remount-ro",
        "/mnt/with space",
      ]);
      expect(argv.indexOf("--remount-ro")).toBeGreaterThan(argv.indexOf("/mnt/c/ws"));
      expect(argv.slice(separator)).toEqual(["--", "/bin/sh", "-c", "echo -- --tmpfs /nope"]);
    },
  );
});

describe("sandbox launcher model login write-back", () => {
  const SECRET = "INERT_NON_MODEL_MCP_SECRET";

  function run(hostDoc: unknown, sandboxDoc: unknown) {
    const base = temp();
    const host = path.join(base, "host-credentials.json");
    writeFileSync(host, JSON.stringify(hostDoc));
    const root = path.join(base, "home");
    const dest = path.join(root, ".claude", ".credentials.json");
    const script = path.join(base, "agent.mjs");
    writeFileSync(
      script,
      `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(dest)}, ${JSON.stringify(JSON.stringify(sandboxDoc))});`,
    );
    const runtime = path.join(base, "fake-srt.mjs");
    writeFileSync(
      runtime,
      `export const SandboxManager = { initialize: async () => {}, cleanupAfterCommand() {}, wrapWithSandbox: async () => ${JSON.stringify(
        `"${process.execPath}" "${script}"`,
      )} };`,
    );
    const result = runLauncher([], {
      srtModule: runtime,
      seededFiles: [{ sources: [host], dest, root, filter: "claude-credentials", refresh: true }],
    });
    return { result, host: () => JSON.parse(readFileSync(host, "utf8")) };
  }

  const login = (expiresAt: number, refreshToken = "r") => ({
    accessToken: "a",
    refreshToken,
    expiresAt,
    scopes: ["s"],
  });

  it("carries a renewed model login back to the host and leaves everything else in the host's store alone", () => {
    const { result, host } = run(
      { claudeAiOauth: login(100), mcpOAuth: { x: { accessToken: SECRET } } },
      { claudeAiOauth: login(200, "rotated"), mcpOAuth: { planted: { accessToken: "evil" } }, extra: true },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(host()).toEqual({ claudeAiOauth: login(200, "rotated"), mcpOAuth: { x: { accessToken: SECRET } } });
  });

  it("does not carry back a login that expires no later than the host's, or one with no host login to renew", () => {
    expect(run({ claudeAiOauth: login(300) }, { claudeAiOauth: login(200, "older") }).host()).toEqual({
      claudeAiOauth: login(300),
    });
    expect(run({ mcpOAuth: {} }, { claudeAiOauth: login(200) }).host()).toEqual({ mcpOAuth: {} });
  });
});

describe("sandbox launcher mirrored agent folder", () => {
  function mirrorRun(base: string, mirror: Record<string, unknown>) {
    const recorded = path.join(base, "runtime-config.json");
    const srt = path.join(base, "fake-srt.mjs");
    writeFileSync(
      srt,
      `import fs from "node:fs";
export const SandboxManager = {
  async initialize(config) {
    fs.writeFileSync(${JSON.stringify(recorded)}, JSON.stringify(config));
    throw new Error("stop here");
  },
};
`,
    );
    const result = runLauncher([], {
      srtModule: srt,
      confinedMirrors: [mirror],
      runtime: {
        filesystem: { allowRead: ["/keep"], allowWrite: ["/keep"], denyWrite: [], denyRead: [] },
        network: {},
      },
    });
    const config = existsSync(recorded) ? JSON.parse(readFileSync(recorded, "utf8")) : null;
    return { result, config };
  }

  function hostFolder(base: string) {
    const folder = path.join(base, "host", ".codex");
    mkdirSync(path.join(folder, "sessions"), { recursive: true });
    writeFileSync(path.join(folder, "auth.json"), '{"tokens":"model-login"}');
    writeFileSync(path.join(folder, "config.toml"), `[mcp_servers.x.env]\nGITHUB_TOKEN = "INERT"\n`);
    writeFileSync(path.join(folder, "sessions", "a.jsonl"), "{}");
    return folder;
  }

  it("links every entry but the excluded config file, grants exactly those entries and never the folder", () => {
    if (process.platform === "win32") return; // creating links needs a privilege there; the WSL e2e runs this for real
    const base = temp();
    const source = hostFolder(base);
    const root = path.join(base, "home");
    const dir = path.join(root, ".codex");
    const { config } = mirrorRun(base, {
      dir,
      sources: [path.join(base, "none"), source],
      exclude: ["config.toml"],
      root,
    });
    expect(lstatSync(dir).isDirectory()).toBe(true);
    expect(lstatSync(dir).isSymbolicLink()).toBe(false);
    expect(readlinkSync(path.join(dir, "auth.json"))).toBe(path.join(source, "auth.json"));
    expect(readlinkSync(path.join(dir, "sessions"))).toBe(path.join(source, "sessions"));
    expect(existsSync(path.join(dir, "config.toml"))).toBe(false);
    expect(config).not.toBeNull();
    for (const list of [config.filesystem.allowRead, config.filesystem.allowWrite]) {
      expect(list).toContain("/keep");
      expect(list.some((item: string) => item.endsWith("auth.json"))).toBe(true);
      expect(list.some((item: string) => item.endsWith("sessions"))).toBe(true);
      expect(list.some((item: string) => item.endsWith("config.toml"))).toBe(false);
      expect(list).not.toContain(source);
    }
  });

  it("replaces an earlier whole-folder link, skips links inside the host folder and keeps the sandbox's own entries", () => {
    if (process.platform === "win32") return;
    const base = temp();
    const source = hostFolder(base);
    const elsewhere = path.join(base, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, path.join(source, "dotfiles"), "dir");
    const root = path.join(base, "home");
    mkdirSync(root);
    const dir = path.join(root, ".codex");
    symlinkSync(source, dir, "dir");
    mirrorRun(base, { dir, sources: [source], exclude: ["config.toml"], root });
    expect(lstatSync(dir).isSymbolicLink()).toBe(false);
    expect(existsSync(path.join(dir, "dotfiles"))).toBe(false);
    writeFileSync(path.join(dir, "history.jsonl"), "own");
    const planted = path.join(dir, "auth.json");
    rmSync(planted);
    symlinkSync(elsewhere, planted, "dir");
    mirrorRun(base, { dir, sources: [source], exclude: ["config.toml"], root });
    expect(readlinkSync(planted)).toBe(path.join(source, "auth.json"));
    expect(readFileSync(path.join(dir, "history.jsonl"), "utf8")).toBe("own");
  });

  it("makes nothing when the host has no such folder", () => {
    const base = temp();
    const root = path.join(base, "home");
    const dir = path.join(root, ".codex");
    mirrorRun(base, { dir, sources: [path.join(base, "none")], exclude: [], root });
    expect(existsSync(dir)).toBe(false);
  });
  it("migrates linked Codex SQLite state to local databases without sharing host data or grants", () => {
    if (process.platform === "win32") return;
    const base = temp();
    const source = hostFolder(base);
    const root = path.join(base, "home");
    const dir = path.join(root, ".codex");
    mkdirSync(dir, { recursive: true });
    const hostFile = path.join(source, "goals_1.sqlite");
    const host = new DatabaseSync(hostFile);
    host.exec("CREATE TABLE host_only(value TEXT); INSERT INTO host_only VALUES ('preserved')");
    host.close();
    const original = readFileSync(hostFile);
    symlinkSync(hostFile, path.join(dir, "goals_1.sqlite"));
    symlinkSync(`${hostFile}-wal`, path.join(dir, "goals_1.sqlite-wal"));
    symlinkSync(`${hostFile}-shm`, path.join(dir, "goals_1.sqlite-shm"));
    writeFileSync(path.join(dir, "state_5.sqlite"), "existing local state");
    const { config } = mirrorRun(base, { dir, sources: [source], exclude: ["config.toml"], root, localSqlite: true });
    expect(config).not.toBeNull();
    expect(existsSync(path.join(dir, "goals_1.sqlite"))).toBe(false);
    expect(() => lstatSync(path.join(dir, "goals_1.sqlite-wal"))).toThrow();
    expect(() => lstatSync(path.join(dir, "goals_1.sqlite-shm"))).toThrow();
    expect(readFileSync(path.join(dir, "state_5.sqlite"), "utf8")).toBe("existing local state");
    for (const grants of [config.filesystem.allowRead, config.filesystem.allowWrite]) {
      expect(grants).not.toContain(hostFile);
      expect(grants).not.toContain(source);
    }
    const local = new DatabaseSync(path.join(dir, "goals_1.sqlite"));
    local.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE sandbox_only(value TEXT); INSERT INTO sandbox_only VALUES ('local')",
    );
    expect(local.prepare("SELECT value FROM sandbox_only").get()).toEqual({ value: "local" });
    expect(local.prepare("SELECT name FROM sqlite_master WHERE name = 'host_only'").get()).toBeUndefined();
    local.close();
    expect(readFileSync(hostFile)).toEqual(original);
    expect(readlinkSync(path.join(dir, "auth.json"))).toBe(path.join(source, "auth.json"));
  });
});
