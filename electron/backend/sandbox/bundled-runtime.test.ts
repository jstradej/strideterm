import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SANDBOX_SRT_VERSION } from "../../shared/sandbox.js";
import type { SandboxGateway } from "./gateway.js";
import { findBundledSandboxRuntime } from "./bundled-runtime.js";
import {
  describeSandboxHost,
  parseProbe,
  planInstall,
  type CommandRunner,
  type ProbeResult,
} from "./sandbox-environment.js";
import { SandboxService } from "./sandbox-service.js";

const dirs: string[] = [];
const temp = (name: string) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), `sbx-bundle-${name}-`));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeBundle(root: string, version = SANDBOX_SRT_VERSION): string {
  const bundle = path.join(root, "sandbox-runtime");
  const pkg = path.join(bundle, "node_modules", "@anthropic-ai", "sandbox-runtime");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ version }));
  writeFileSync(path.join(bundle, "VERSION"), version);
  return bundle;
}

describe("the sandbox runtime dependency", () => {
  it("is installed at exactly the version the sandbox pins", () => {
    const manifest = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../node_modules/@anthropic-ai/sandbox-runtime/package.json",
    );
    expect(JSON.parse(readFileSync(manifest, "utf8")).version).toBe(SANDBOX_SRT_VERSION);
  });
});

describe("findBundledSandboxRuntime", () => {
  it("prefers the packaged resources folder", () => {
    const resources = temp("res");
    const bundle = makeBundle(resources);
    expect(findBundledSandboxRuntime(resources, temp("empty"))).toBe(bundle);
  });

  it("finds the build output above the module when nothing is packaged", () => {
    const repo = temp("repo");
    const bundle = makeBundle(path.join(repo, "dist-electron"));
    const nested = path.join(repo, "dist-electron", "electron", "backend", "sandbox");
    mkdirSync(nested, { recursive: true });
    expect(findBundledSandboxRuntime(undefined, nested)).toBe(bundle);
  });

  it("offers nothing for a missing bundle or one built for another pinned version", () => {
    const resources = temp("res2");
    expect(findBundledSandboxRuntime(resources, temp("none"))).toBeNull();
    makeBundle(resources, "0.0.1");
    expect(findBundledSandboxRuntime(resources, temp("none2"))).toBeNull();
  });
});

describe("planInstall with the sandbox runtime shipped", () => {
  const missingSrt = (platform: NodeJS.Platform): ProbeResult => ({
    facts: parseProbe(
      `home=/h\nnode=/n\nbwrap=/b\nsocat=/s\nrg=/r\npm=apt-get\nsandbox_exec=/x\nkernel=6.6.0-microsoft-standard-WSL2\n`,
    ),
    reachable: platform !== undefined,
  });
  const plan = (platform: NodeJS.Platform, dir: string | null | undefined, distro?: string) => {
    const description = describeSandboxHost(platform, missingSrt(platform), distro);
    return planInstall(platform, description.status, description.packageManager, distro, dir);
  };

  it("copies the tree on Linux or macOS, with the folder as an argument and not in the script", () => {
    const dir = "/opt/strIDEterm/resources/sandbox-runtime";
    const { steps, manual } = plan("linux", dir);
    expect(steps).toHaveLength(1);
    expect(steps[0].file).toBe("bash");
    expect(steps[0].args.slice(0, 1)).toEqual(["-lc"]);
    expect(steps[0].args.slice(2)).toEqual(["strideterm-sandbox", dir]);
    expect(steps[0].args[1]).not.toContain(dir);
    expect(steps[0].args[1]).toContain('cp -R "$1/node_modules"');
    expect(steps[0].args[1]).toContain('rm -rf "$prefix"');
    expect(steps[0].args[1]).toMatch(/vendor\/seccomp" -type f -exec chmod 755/u);
    expect(manual).toEqual([]);
  });

  it("copies from the Windows resources folder through WSL, in the chosen distribution", () => {
    const { steps, manual } = plan(
      "win32",
      String.raw`C:\Program Files\strIDEterm\resources\sandbox-runtime`,
      "Ubuntu",
    );
    expect(steps).toHaveLength(1);
    expect(steps[0].file).toBe("wsl.exe");
    expect(steps[0].args.slice(0, 5)).toEqual(["-d", "Ubuntu", "-e", "bash", "-lc"]);
    expect(steps[0].args.slice(6)).toEqual([
      "strideterm-sandbox",
      "/mnt/c/Program Files/strIDEterm/resources/sandbox-runtime",
    ]);
    expect(manual).toEqual([]);
  });

  it("omits -d without a distribution", () => {
    const { steps } = plan("win32", String.raw`C:\r\sandbox-runtime`);
    expect(steps[0].args.slice(0, 3)).toEqual(["-e", "bash", "-lc"]);
  });

  it("falls back to npm when the folder cannot be reached from WSL, and when there is no bundle", () => {
    for (const result of [
      plan("win32", "/not/a/windows/path", "Ubuntu"),
      plan("linux", null),
      plan("linux", undefined),
    ]) {
      expect(result.steps).toHaveLength(1);
      expect(result.steps[0].args.join(" ")).toContain(`npm install --prefix`);
      expect(result.manual).toHaveLength(1);
    }
  });
});

describe("SandboxService copies the shipped runtime on its own", () => {
  const withoutSrt = "home=/h\nnode=/n\nbwrap=/b\nsocat=/s\nrg=/r\npm=apt-get\n";
  const withSrt = `${withoutSrt}srt_module=/h/m/dist/index.js\nsrt_version=${SANDBOX_SRT_VERSION}\n`;
  const isCopy = (call: unknown[]) => (call[1] as string[]).includes("strideterm-sandbox");

  const makeService = (run: CommandRunner, bundledRuntimeDir: string | null = "/opt/sandbox-runtime") =>
    new SandboxService({
      dataDir: temp("data"),
      gateway: {} as SandboxGateway,
      platform: "linux",
      run,
      bundledRuntimeDir,
      getRegistries: () => [],
      getWorkspaceDomains: () => [],
      onDenied: () => undefined,
      onDeniedSettled: () => undefined,
    });

  it("copies once, probes again and reports the runtime as present", async () => {
    let copied = false;
    const run = vi.fn<CommandRunner>(async (_file, args) => {
      if (args.includes("strideterm-sandbox")) {
        copied = true;
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: copied ? withSrt : withoutSrt, stderr: "" };
    });
    const status = await makeService(run).getStatus();
    expect(run.mock.calls.map(isCopy)).toEqual([false, true, false]);
    expect(status.prerequisites.find((item) => item.id === "srt")?.ok).toBe(true);
  });

  it("does not try again after a failure, and does not loop", async () => {
    const run = vi.fn<CommandRunner>(async (_file, args) =>
      args.includes("strideterm-sandbox")
        ? { code: 1, stdout: "", stderr: "cp: cannot create directory" }
        : { code: 0, stdout: withoutSrt, stderr: "" },
    );
    const service = makeService(run);
    const status = await service.getStatus();
    expect(status.prerequisites.find((item) => item.id === "srt")?.ok).toBe(false);
    await service.getStatus({ force: true });
    expect(run.mock.calls.filter(isCopy)).toHaveLength(1);
  });

  it("does nothing when Node.js is missing, the runtime is present, or no bundle ships", async () => {
    const noNode = vi.fn<CommandRunner>(async () => ({
      code: 0,
      stdout: "home=/h\nbwrap=/b\npm=apt-get\n",
      stderr: "",
    }));
    await makeService(noNode).getStatus();
    expect(noNode.mock.calls.filter(isCopy)).toHaveLength(0);

    const present = vi.fn<CommandRunner>(async () => ({ code: 0, stdout: withSrt, stderr: "" }));
    await makeService(present).getStatus();
    expect(present.mock.calls.filter(isCopy)).toHaveLength(0);

    const noBundle = vi.fn<CommandRunner>(async () => ({ code: 0, stdout: withoutSrt, stderr: "" }));
    await makeService(noBundle, null).getStatus();
    expect(noBundle).toHaveBeenCalledTimes(1);
  });

  it("copies again for a runtime of another version", async () => {
    let copied = false;
    const run = vi.fn<CommandRunner>(async (_file, args) => {
      if (args.includes("strideterm-sandbox")) {
        copied = true;
        return { code: 0, stdout: "", stderr: "" };
      }
      return {
        code: 0,
        stdout: copied ? withSrt : `${withoutSrt}srt_module=/h/m/dist/index.js\nsrt_version=0.0.1\n`,
        stderr: "",
      };
    });
    await makeService(run).getStatus();
    expect(run.mock.calls.filter(isCopy)).toHaveLength(1);
  });
});
