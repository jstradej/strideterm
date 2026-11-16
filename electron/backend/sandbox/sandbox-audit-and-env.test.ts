import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { SANDBOX_SRT_VERSION } from "../../shared/sandbox.js";
import { createRegistryAudit } from "./registry-audit.js";
import { createSandboxAuditLogStore } from "./sandbox-audit-log-store.js";
import {
  describeSandboxHost,
  FIND_AGENT_SCRIPT,
  PROBE_SCRIPT,
  wslVersionOf,
  parseProbe,
  planInstall,
  probeSandboxHost,
  type CommandRunner,
  type ProbeResult,
} from "./sandbox-environment.js";

describe("registry audit", () => {
  const subject = { profileId: "p", workspaceId: "w", connectionId: "c", label: "Corp" };
  type Store = Parameters<typeof createRegistryAudit>[0];
  let store: { insertEntry: Mock<Store["insertEntry"]>; finishEntry: Mock<Store["finishEntry"]> };

  beforeEach(() => {
    vi.useFakeTimers();
    store = { insertEntry: vi.fn<Store["insertEntry"]>(() => 7), finishEntry: vi.fn<Store["finishEntry"]>(() => true) };
  });
  afterEach(() => vi.useRealTimers());

  it("writes the intent when the window opens, before any request is counted", () => {
    const audit = createRegistryAudit(store);
    expect(audit.begin(subject)).toBe(true);
    expect(store.insertEntry).toHaveBeenCalledTimes(1);
    expect(store.insertEntry.mock.calls[0][0]).toMatchObject({
      workspaceId: "w",
      connectionId: "c",
      operation: "registryRead",
      success: false,
    });
    expect(store.finishEntry).not.toHaveBeenCalled();
  });

  it("aggregates one row per (workspace, connection, window) and finishes it with the totals", () => {
    const audit = createRegistryAudit(store, { windowMs: 1000 });
    audit.begin(subject);
    audit.end(subject, { status: 200, bytes: 100 });
    audit.begin(subject);
    audit.end(subject, { status: 404, bytes: 5 });
    audit.end(subject, { status: 0, bytes: 0 });
    expect(store.insertEntry).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(store.finishEntry).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        success: false,
        details: expect.objectContaining({
          requests: 3,
          bytes: 105,
          failures: 2,
          statuses: { "2xx": 1, "4xx": 1, error: 1 },
        }),
      }),
    );
    audit.begin(subject);
    expect(store.insertEntry).toHaveBeenCalledTimes(2);
  });

  it("writes one intent row per broker operation and finishes that same row", () => {
    const audit = createRegistryAudit(store);
    const finish = audit.beginOperation({
      profileId: "p",
      workspaceId: "w",
      sessionId: "w:agent",
      route: "internal-mcp",
      method: "POST",
    });
    expect(finish).not.toBeNull();
    expect(store.insertEntry.mock.calls[0][0]).toMatchObject({
      operation: "brokerOperation",
      resourceId: "internal-mcp",
      category: "write",
      success: false,
    });
    expect(store.finishEntry).not.toHaveBeenCalled();
    finish!({ status: 200, bytes: 12 });
    expect(store.finishEntry).toHaveBeenCalledWith(7, expect.objectContaining({ success: true }));
  });

  it("returns no finisher when a broker operation's intent cannot be written", () => {
    store.insertEntry.mockReturnValue(null as never);
    const audit = createRegistryAudit(store);
    expect(
      audit.beginOperation({ profileId: "p", workspaceId: "w", sessionId: "s", route: "notify", method: "POST" }),
    ).toBeNull();
  });

  it("keeps windows of different workspaces apart", () => {
    const audit = createRegistryAudit(store);
    audit.begin(subject);
    audit.begin({ ...subject, workspaceId: "other" });
    expect(store.insertEntry).toHaveBeenCalledTimes(2);
  });

  it("refuses when the intent cannot be written", () => {
    store.insertEntry.mockReturnValue(null);
    expect(createRegistryAudit(store).begin(subject)).toBe(false);
  });

  it("finishes every open window on flush", () => {
    const audit = createRegistryAudit(store);
    audit.begin(subject);
    audit.flush();
    expect(store.finishEntry).toHaveBeenCalledTimes(1);
  });
});

describe("sandbox audit store", () => {
  it("keeps profile and workspace with the intent row and finishes the same row", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "sbx-audit-"));
    const store = createSandboxAuditLogStore(path.join(dir, "a.db"));
    try {
      const id = store.insertEntry({ operation: "registryRead", profileId: "p1", workspaceId: "w1", success: false });
      expect(id).toBeGreaterThan(0);
      expect(store.finishEntry(id!, { success: true, summary: "done", details: { requests: 2 } })).toBe(true);
      const rows = store.query({ providerFilters: { profile_id: "p1" } });
      expect(JSON.stringify(rows)).toContain("w1");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const ready = `home=/home/dev
node=/usr/bin/node
bwrap=/usr/bin/bwrap
socat=/usr/bin/socat
rg=/usr/bin/rg
pm=apt-get
agent_claude=/usr/bin/claude
agent_codex=/usr/local/bin/codex
agent_copilot=
agent_opencode=
agent_gemini=/mnt/c/Users/dev/AppData/Roaming/npm/gemini
uname=Linux
srt_module=/usr/lib/node_modules/@anthropic-ai/sandbox-runtime/dist/index.js
srt_version=${SANDBOX_SRT_VERSION}
wsl_gw=172.20.0.1
`;

describe("sandbox environment", () => {
  it("parses the probe output, ignoring the noise a login shell prints", () => {
    expect(parseProbe(`welcome\r\nhome=/h\r\nnode=\r\n junk`)).toEqual({ home: "/h", node: "" });
  });

  it("is ready on Linux when every prerequisite is present", () => {
    const description = describeSandboxHost("linux", { facts: parseProbe(ready), reachable: true });
    expect(description.status.ready).toBe(true);
    expect(description.environment).toMatchObject({
      os: "linux",
      home: "/home/dev",
      nodePath: "/usr/bin/node",
      srtModule: "/usr/lib/node_modules/@anthropic-ai/sandbox-runtime/dist/index.js",
    });
  });

  it("carries the sandbox host's own Codex version, which decides --no-daemon for an isolated tab", () => {
    const withCodex = describeSandboxHost("win32", {
      facts: parseProbe(`${ready}codex_version=codex-cli 0.104.0\n`),
      reachable: true,
    });
    expect(withCodex.environment?.codexVersion).toBe("codex-cli 0.104.0");
    expect(withCodex.status.wslHome).toBeUndefined();
    const named = describeSandboxHost("win32", { facts: parseProbe(`${ready}distro_name=Ubuntu\n`), reachable: true });
    expect(named.status.wslHome).toBe("\\\\wsl.localhost\\Ubuntu\\home\\dev");
    expect(describeSandboxHost("linux", { facts: parseProbe(ready), reachable: true }).environment).not.toHaveProperty(
      "codexVersion",
    );
  });

  it("asks only a Codex installed in the sandbox host for its version, never a Windows shim under /mnt", () => {
    expect(PROBE_SCRIPT).toContain("codex_path=$(find_agent codex)");
    expect(PROBE_SCRIPT).toContain(`case "$codex_path" in ""|/mnt/*) ;;`);
  });

  it("lists what is missing and offers to install it, but not Node.js", () => {
    const facts = parseProbe("home=/h\npm=apt-get\nnode=\nbwrap=\nsocat=/usr/bin/socat\nrg=/usr/bin/rg\n");
    const { status, environment } = describeSandboxHost("linux", { facts, reachable: true });
    expect(status.ready).toBe(false);
    expect(environment).toBeNull();
    const byId = Object.fromEntries(status.prerequisites.map((item) => [item.id, item]));
    expect(byId.node).toMatchObject({ ok: false, installable: false });
    expect(byId.bubblewrap).toMatchObject({ ok: false, installable: true });
    expect(byId.srt).toMatchObject({ ok: false, installable: false });
  });

  it("reports which agent CLIs are installed where the sandbox runs, without affecting readiness", () => {
    const linux = describeSandboxHost("linux", { facts: parseProbe(ready), reachable: true });
    expect(linux.status.ready).toBe(true);
    const byId = Object.fromEntries(linux.status.agents.map((item) => [item.id, item]));
    expect(byId.claude).toEqual({ id: "claude", ok: true });
    expect(byId.copilot).toEqual({ id: "copilot", ok: false, detail: "Not installed" });
    expect(byId.gemini.ok).toBe(true);
    const win = describeSandboxHost("win32", { facts: parseProbe(ready), reachable: true }, "Ubuntu");
    expect(win.status.ready).toBe(true);
    const winById = Object.fromEntries(win.status.agents.map((item) => [item.id, item]));
    expect(winById.claude.ok).toBe(true);
    expect(winById.gemini).toEqual({
      id: "gemini",
      ok: false,
      windowsOnly: true,
      detail: "Installed on Windows only. Isolated tabs run inside WSL — install it there.",
    });
    expect(winById.copilot.detail).toBe("Not installed inside WSL");
    expect(describeSandboxHost("win32", { facts: {}, reachable: false }).status.agents).toEqual([]);
  });

  it("probes for every agent CLI by name, and OpenCode in its installer's folder too", () => {
    for (const id of ["claude", "codex", "copilot", "gemini"]) {
      expect(PROBE_SCRIPT).toContain(`echo "agent_${id}=$(find_agent ${id})"`);
    }
    expect(PROBE_SCRIPT).toContain(`echo "agent_opencode=$(find_agent opencode ".opencode/bin")"`);
  });

  describe("finding an agent CLI", () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(path.join(os.tmpdir(), "sbx-find-"));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    const executable = (file: string) => {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, "#!/bin/sh\n", { mode: 0o755 });
    };
    const find = (args: string, env: { home: string; path: string }) =>
      execFileSync("bash", ["-c", `${FIND_AGENT_SCRIPT}\nfind_agent ${args}`], {
        env: { ...process.env, HOME: env.home, PATH: `${env.path}:/usr/bin:/bin` },
        encoding: "utf8",
      }).trim();

    it.skipIf(process.platform === "win32")(
      "takes the installer's folder when a non-interactive shell's PATH does not have it",
      () => {
        const home = path.join(dir, "home");
        executable(path.join(home, ".opencode/bin/opencode"));
        expect(find(`opencode ".opencode/bin"`, { home, path: path.join(dir, "empty") })).toBe(
          path.join(home, ".opencode/bin/opencode"),
        );
        executable(path.join(dir, "bin/opencode"));
        expect(find(`opencode ".opencode/bin"`, { home, path: path.join(dir, "bin") })).toBe(
          path.join(dir, "bin/opencode"),
        );
        expect(find("gemini", { home, path: path.join(dir, "bin") })).toBe("");
      },
    );
  });

  it("looks for the runtime in the private prefix before the global one", () => {
    const privateAt = PROBE_SCRIPT.indexOf("$HOME/.local/share/strideterm/sandbox-runtime/node_modules");
    expect(privateAt).toBeGreaterThan(-1);
    expect(privateAt).toBeLessThan(PROBE_SCRIPT.indexOf("npm root -g"));
    expect(PROBE_SCRIPT).not.toContain(SANDBOX_SRT_VERSION);
  });

  it("treats another sandbox runtime version as missing", () => {
    const facts = parseProbe(ready.replace(`srt_version=${SANDBOX_SRT_VERSION}`, "srt_version=0.0.1"));
    const srt = describeSandboxHost("linux", { facts, reachable: true }).status.prerequisites.find(
      (item) => item.id === "srt",
    );
    expect(srt).toMatchObject({ ok: false, installable: true });
    expect(srt?.detail).toContain("0.0.1");
  });

  it("needs Seatbelt, not bubblewrap, on macOS", () => {
    const facts = parseProbe(
      "home=/Users/dev\nnode=/opt/homebrew/bin/node\nsandbox_exec=/usr/bin/sandbox-exec\nsrt_module=/m/dist/index.js\n" +
        `srt_version=${SANDBOX_SRT_VERSION}\n`,
    );
    const { status, environment } = describeSandboxHost("darwin", { facts, reachable: true });
    expect(status.prerequisites.map((item) => item.id)).toEqual(["node", "srt", "seatbelt"]);
    expect(environment?.os).toBe("darwin");
  });

  it("on Windows needs WSL, says what is not covered, and reaches the host through the WSL gateway", () => {
    const gone = describeSandboxHost("win32", { facts: {}, reachable: false, detail: "no wsl" });
    expect(gone.status.ready).toBe(false);
    expect(gone.status.prerequisites[0]).toMatchObject({ id: "wsl", ok: false, installable: true, detail: "no wsl" });
    const nat = describeSandboxHost("win32", { facts: parseProbe(ready), reachable: true }, "Ubuntu");
    expect(nat.status.notes.join(" ")).toMatch(/Linux build tools/);
    expect(nat.environment).toMatchObject({ platform: "win32", distro: "Ubuntu", hostAddress: "172.20.0.1" });
    const mirrored = describeSandboxHost("win32", { facts: parseProbe(`${ready}wsl_net=mirrored\n`), reachable: true });
    expect(mirrored.environment?.hostAddress).toBe("127.0.0.1");
    const blind = describeSandboxHost("win32", {
      facts: parseProbe(ready.replace("wsl_gw=172.20.0.1", "")),
      reachable: true,
    });
    expect(blind.status.gateway).toBe("unavailable");
  });

  it("tells WSL2 from a reachable WSL1 distribution, which cannot run the sandbox", () => {
    expect(wslVersionOf("5.15.153.1-microsoft-standard-WSL2")).toBe(2);
    expect(wslVersionOf("4.4.0-19041-Microsoft")).toBe(1);
    expect(wslVersionOf("6.1.0-custom")).toBe(0);
    const wsl2 = describeSandboxHost(
      "win32",
      {
        facts: parseProbe(`${ready}kernel=5.15.153.1-microsoft-standard-WSL2
`),
        reachable: true,
      },
      "Ubuntu",
    );
    expect(wsl2.status.prerequisites[0]).toMatchObject({ id: "wsl", ok: true });
    const wsl1 = describeSandboxHost(
      "win32",
      {
        facts: parseProbe(`${ready}kernel=4.4.0-19041-Microsoft
distro_name=Ubuntu
`),
        reachable: true,
      },
      "Ubuntu",
    );
    expect(wsl1.status.ready).toBe(false);
    expect(wsl1.environment).toBeNull();
    expect(wsl1.status.prerequisites[0]).toMatchObject({ id: "wsl", ok: false, installable: true });
    expect(wsl1.status.prerequisites[0].detail).toContain("wsl --set-version Ubuntu 2");
  });

  it("offers a setup path for a missing WSL and for a WSL1 distribution", () => {
    const none = describeSandboxHost("win32", { facts: {}, reachable: false, detail: "no wsl" });
    const install = planInstall("win32", none.status, "", "Ubuntu");
    expect(install.steps).toEqual([]);
    expect(install.manual.join(" ")).toContain("wsl --install");
    const wsl1 = describeSandboxHost("win32", {
      facts: parseProbe(`${ready}kernel=4.4.0-19041-Microsoft
distro_name=Ubuntu
`),
      reachable: true,
    });
    const convert = planInstall("win32", wsl1.status, wsl1.packageManager, "Ubuntu");
    expect(convert.steps[0]).toMatchObject({ file: "wsl.exe", args: ["--set-version", "Ubuntu", "2"] });
  });

  it("probes through bash on Linux and through wsl.exe on Windows", async () => {
    const run = vi.fn<CommandRunner>(async () => ({ code: 0, stdout: ready, stderr: "" }));
    const linux = await probeSandboxHost({ platform: "linux", run });
    expect(linux.reachable).toBe(true);
    expect(run.mock.calls[0][0]).toBe("bash");
    await probeSandboxHost({ platform: "win32", distro: "Debian", run });
    expect(run.mock.calls[1][0]).toBe("wsl.exe");
    expect(run.mock.calls[1][1].slice(0, 3)).toEqual(["-d", "Debian", "-e"]);
    const down = await probeSandboxHost({
      platform: "win32",
      run: async () => ({ code: 1, stdout: "", stderr: "W\0S\0L" }),
    });
    expect(down).toMatchObject({ reachable: false, detail: "WSL" });
  });

  describe("planInstall", () => {
    const PREFIX = "$HOME/.local/share/strideterm/sandbox-runtime";
    const missing = (probe: ProbeResult, platform: NodeJS.Platform) => {
      const description = describeSandboxHost(platform, probe);
      return planInstall(platform, description.status, description.packageManager, "Ubuntu");
    };

    it("installs packages in WSL as root, which needs no password, and the runtime as the user", () => {
      const plan = missing({ facts: parseProbe("home=/h\nnode=/n\npm=apt-get\n"), reachable: true }, "win32");
      expect(plan.steps[0]).toMatchObject({ file: "wsl.exe" });
      expect(plan.steps[0].args).toEqual(expect.arrayContaining(["-u", "root"]));
      expect(plan.steps[0].args.join(" ")).toContain("apt-get install -y bubblewrap socat ripgrep");
      expect(plan.steps[1].args.join(" ")).toContain(`@anthropic-ai/sandbox-runtime@${SANDBOX_SRT_VERSION}`);
      expect(plan.steps[1].args.join(" ")).toContain(`--prefix "${PREFIX}"`);
      expect(plan.steps[1].args.join(" ")).not.toContain(" -g ");
    });

    it("hands the exact commands back on Linux, where the packages need sudo", () => {
      const plan = missing({ facts: parseProbe("home=/h\nnode=/n\npm=dnf\n"), reachable: true }, "linux");
      expect(plan.manual).toEqual(
        expect.arrayContaining([
          `sudo dnf install -y bubblewrap socat ripgrep`,
          `npm install --prefix "${PREFIX}" --no-audit --no-fund @anthropic-ai/sandbox-runtime@${SANDBOX_SRT_VERSION}`,
        ]),
      );
    });

    it("has nothing to do when everything is there", () => {
      const plan = missing({ facts: parseProbe(ready), reachable: true }, "linux");
      expect(plan).toEqual({ steps: [], manual: [] });
    });
  });
});

describe("sandbox Node.js version", () => {
  const nodePrerequisite = (version: string) =>
    describeSandboxHost("linux", {
      facts: parseProbe(`home=/h\nnode=/usr/bin/node\nnode_version=${version}\n`),
      reachable: true,
    }).status.prerequisites.find((item) => item.id === "node");

  it("refuses a Node.js older than the pinned runtime supports and says which was found", () => {
    expect(nodePrerequisite("20.19.0")).toMatchObject({ ok: false, detail: expect.stringContaining("20.19.0") });
    expect(nodePrerequisite("22.11.0")?.ok).toBe(false);
  });

  it("accepts the minimum and anything newer, and does not judge an unreported version", () => {
    expect(nodePrerequisite("22.12.0")?.ok).toBe(true);
    expect(nodePrerequisite("24.1.0")?.ok).toBe(true);
    expect(nodePrerequisite("")?.ok).toBe(true);
  });
});
