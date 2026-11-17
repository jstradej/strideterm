import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveExternalGitDirs } from "./git-dirs.js";
import {
  buildGradleInit,
  buildMavenSettings,
  buildNpmrc,
  buildPipConf,
  mavenArgs,
  type GatewayRegistryEndpoint,
} from "./registry-tool-config.js";
import { detectToolchains, toolchainEnv, TOOLCHAIN_PROFILES } from "./toolchain-profile.js";
import { distroOfPaths, windowsPathToWsl } from "../../shared/wsl-paths.js";
import type { RegistryConnection } from "../../shared/registry.js";

const dirs: string[] = [];
function temp(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sbx-small-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("windowsPathToWsl", () => {
  it("maps a drive path to /mnt and a WSL UNC path to its Linux path", () => {
    expect(windowsPathToWsl("C:\\work\\app")).toEqual({ path: "/mnt/c/work/app", windowsDrive: true });
    expect(windowsPathToWsl("D:/x")?.path).toBe("/mnt/d/x");
    expect(windowsPathToWsl("\\\\wsl$\\Ubuntu\\home\\me\\p")).toEqual({
      path: "/home/me/p",
      distro: "Ubuntu",
      windowsDrive: false,
    });
    expect(windowsPathToWsl("\\\\wsl.localhost\\Debian")?.path).toBe("/");
  });

  it("refuses other UNC shares and relative paths", () => {
    expect(windowsPathToWsl("\\\\server\\share\\x")).toBeNull();
    expect(windowsPathToWsl("relative\\x")).toBeNull();
  });

  it("agrees on one distro or refuses", () => {
    expect(distroOfPaths(["C:\\a", "\\\\wsl$\\Ubuntu\\x"])).toBe("Ubuntu");
    expect(distroOfPaths(["C:\\a"])).toBeUndefined();
    expect(() => distroOfPaths(["\\\\wsl$\\Ubuntu\\x", "\\\\wsl$\\Debian\\y"])).toThrow(/different WSL/);
  });
});

describe("detectToolchains", () => {
  it("selects profiles by the files at the top of a root", () => {
    const root = temp();
    writeFileSync(path.join(root, "package.json"), "{}");
    writeFileSync(path.join(root, "pom.xml"), "<project/>");
    writeFileSync(path.join(root, "build.gradle.kts"), "");
    expect(detectToolchains([root]).map((profile) => profile.id)).toEqual(["node", "maven", "gradle"]);
    expect(detectToolchains([path.join(root, "missing")])).toEqual([]);
  });

  it("finds the toolchains of a monorepo one level below the root", () => {
    const root = temp();
    mkdirSync(path.join(root, "frontend"));
    mkdirSync(path.join(root, "backend"));
    writeFileSync(path.join(root, "frontend", "package.json"), "{}");
    writeFileSync(path.join(root, "backend", "pom.xml"), "<project/>");
    expect(detectToolchains([root]).map((profile) => profile.id)).toEqual(["node", "maven"]);
  });

  it("does not look two levels down, into dot folders or into dependency and build output folders", () => {
    const root = temp();
    for (const dir of [".hidden", "node_modules", "target", "build", "dist", "vendor", "deep/inner"]) {
      mkdirSync(path.join(root, dir), { recursive: true });
    }
    writeFileSync(path.join(root, ".hidden", "package.json"), "{}");
    writeFileSync(path.join(root, "node_modules", "pom.xml"), "");
    writeFileSync(path.join(root, "target", "go.mod"), "");
    writeFileSync(path.join(root, "build", "Cargo.toml"), "");
    writeFileSync(path.join(root, "dist", "build.gradle"), "");
    writeFileSync(path.join(root, "vendor", "setup.py"), "");
    writeFileSync(path.join(root, "deep", "inner", "Cargo.toml"), "{}");
    writeFileSync(path.join(root, "package.json"), "not a marker of the others");
    expect(detectToolchains([root]).map((profile) => profile.id)).toEqual(["node"]);
  });

  it("looks at no more than 40 subdirectories of a root", () => {
    const root = temp();
    for (let index = 0; index < 41; index += 1) mkdirSync(path.join(root, `dir-${String(index).padStart(2, "0")}`));
    const entries = readdirSync(root);
    const beyondCap = entries.slice(40)[0];
    writeFileSync(path.join(root, beyondCap, "package.json"), "{}");
    expect(detectToolchains([root])).toEqual([]);
    writeFileSync(path.join(root, entries[0], "package.json"), "{}");
    expect(detectToolchains([root]).map((profile) => profile.id)).toEqual(["node"]);
  });

  it("points each tool's cache at the shared cache root, outside the home directory", () => {
    const node = TOOLCHAIN_PROFILES.find((profile) => profile.id === "node")!;
    expect(toolchainEnv("/var/tmp/cache", node)).toMatchObject({
      npm_config_cache: "/var/tmp/cache/node/npm",
      YARN_CACHE_FOLDER: "/var/tmp/cache/node/yarn",
    });
  });
});

describe("resolveExternalGitDirs", () => {
  function linkedWorktree() {
    const common = path.join(temp(), "repo.git");
    const worktreeGit = path.join(common, "worktrees", "wt");
    mkdirSync(worktreeGit, { recursive: true });
    const linked = temp();
    writeFileSync(
      path.join(linked, ".git"),
      `gitdir: ${worktreeGit}
`,
    );
    writeFileSync(
      path.join(worktreeGit, "gitdir"),
      `${path.join(linked, ".git")}
`,
    );
    return { common, worktreeGit, linked };
  }

  it("is empty for an ordinary checkout and names a linked worktree's git dirs", () => {
    const main = temp();
    mkdirSync(path.join(main, ".git"));
    expect(resolveExternalGitDirs(main)).toEqual({ dirs: [], pointerFiles: [] });

    const { common, worktreeGit, linked } = linkedWorktree();
    const result = resolveExternalGitDirs(linked);
    expect(result.dirs).toEqual([worktreeGit, common]);
    expect(result.pointerFiles).toEqual([
      path.join(linked, ".git"),
      path.join(worktreeGit, "gitdir"),
      path.join(worktreeGit, "commondir"),
    ]);
  });

  it("never derives the common dir from the commondir file an agent can edit", () => {
    const { worktreeGit, common, linked } = linkedWorktree();
    writeFileSync(path.join(worktreeGit, "commondir"), "../../../../elsewhere\n");
    expect(resolveExternalGitDirs(linked).dirs).toEqual([worktreeGit, common]);
  });

  it("grants nothing when the pointer names a directory that is not a worktree of this checkout", () => {
    const home = temp();
    const credentials = path.join(home, "credentials");
    mkdirSync(credentials, { recursive: true });
    const planted = temp();
    writeFileSync(path.join(planted, ".git"), `gitdir: ${credentials}\n`);
    expect(resolveExternalGitDirs(planted).dirs).toEqual([]);

    // A `worktrees/<name>` layout without the back-reference git writes is refused too.
    const fake = path.join(home, "worktrees", "x");
    mkdirSync(fake, { recursive: true });
    writeFileSync(path.join(planted, ".git"), `gitdir: ${fake}\n`);
    expect(resolveExternalGitDirs(planted).dirs).toEqual([]);

    // A real worktree of ANOTHER checkout names that checkout, not this one.
    const other = linkedWorktree();
    writeFileSync(path.join(planted, ".git"), `gitdir: ${other.worktreeGit}\n`);
    expect(resolveExternalGitDirs(planted).dirs).toEqual([]);
  });

  // A \\wsl$ path only means something on a Windows host: elsewhere `path` does not split on backslashes and
  // the checkout's own absolute path starts with "/", which the resolver reads as a path inside the distro.
  it.skipIf(process.platform !== "win32")(
    "reads a Linux gitdir of a WSL checkout as a \\\\wsl$ path and checks its back-reference through it",
    () => {
      const linked = temp();
      const pointer = "gitdir: /home/me/repo/.git/worktrees/wt\n";
      writeFileSync(path.join(linked, ".git"), pointer);
      const refused = resolveExternalGitDirs(linked, {
        wslDistro: "Ubuntu",
        readText: (file) => (file.startsWith(linked) ? pointer : "/home/me/other/.git\n"),
        realPath: (file) => file,
      });
      expect(refused.dirs).toEqual([]);

      const accepted = resolveExternalGitDirs(linked, {
        wslDistro: "Ubuntu",
        readText: (file) => (file.startsWith(linked) ? pointer : `${linked}${path.sep}.git\n`),
        realPath: (file) => file,
      });
      expect(accepted.dirs[0]).toBe("\\\\wsl$\\Ubuntu\\home\\me\\repo\\.git\\worktrees\\wt");
    },
  );
});

function connection(overrides: Partial<RegistryConnection>): RegistryConnection {
  return {
    id: "r1",
    profileId: "default",
    label: "Corp",
    kind: "maven",
    url: "https://repo.corp.example/maven",
    mode: "mirror",
    authKind: "basic",
    username: "svc",
    npmScope: "",
    ...overrides,
  };
}
const gw = (id: string) => `http://gateway.strideterm.internal/registry/CAP/${id}`;
function endpoint(overrides: Partial<RegistryConnection>): GatewayRegistryEndpoint {
  const c = connection(overrides);
  return { connection: c, url: gw(c.id) };
}

describe("registry tool configuration", () => {
  it("writes a Maven mirror that points at the gateway and a proxy block read from the environment", () => {
    const xml = buildMavenSettings([endpoint({})]);
    expect(xml).toContain("<mirrorOf>*</mirrorOf>");
    expect(xml).toContain(`<url>${gw("r1")}</url>`);
    expect(xml).toContain("${env.STRIDETERM_SANDBOX_PROXY_HOST}");
    expect(xml).toContain("${env.STRIDETERM_SANDBOX_PROXY_USER}");
    expect(xml).not.toContain("corp.example");
    expect(xml).not.toMatch(/<server>/);
  });

  it("writes an additional Maven repository instead of a mirror, escaping XML", () => {
    const xml = buildMavenSettings([endpoint({ mode: "additional", label: "A&B <x>" })]);
    expect(xml).not.toContain("<mirrorOf>");
    expect(xml).toContain("<repository>");
    expect(xml).toContain("<pluginRepository>");
    const mirror = buildMavenSettings([endpoint({ label: "A&B <x>" })]);
    expect(mirror).toContain("A&amp;B &lt;x&gt;");
  });

  it("hands Maven the settings, a cache outside the home directory and the wagon transport", () => {
    expect(mavenArgs("/tmp/s/settings.xml", "/var/tmp/cache/maven/repository")).toBe(
      '-s "/tmp/s/settings.xml" -Dmaven.repo.local="/var/tmp/cache/maven/repository" -Dmaven.resolver.transport=wagon',
    );
  });

  it("writes an .npmrc without any credential, whole-registry or scoped", () => {
    expect(buildNpmrc([endpoint({ kind: "npm" })])).toBe(`registry=${gw("r1")}/\n`);
    expect(buildNpmrc([endpoint({ kind: "npm", npmScope: "@acme" })])).toBe(`@acme:registry=${gw("r1")}/\n`);
    expect(buildNpmrc([endpoint({ kind: "npm" })])).not.toMatch(/_auth|token/i);
    expect(buildNpmrc([endpoint({ kind: "maven" })])).toBe("");
  });

  it("writes pip.conf with an index, extra indexes and trusted hosts", () => {
    const conf = buildPipConf([endpoint({ kind: "pip" }), endpoint({ id: "r2", kind: "pip", mode: "additional" })]);
    expect(conf).toContain(`index-url = ${gw("r1")}/simple`);
    expect(conf).toContain(`extra-index-url = ${gw("r2")}/simple`);
    expect(conf).toContain("trusted-host = gateway.strideterm.internal");
    expect(buildPipConf([])).toBe("");
  });

  it("writes a Gradle init script only when a Gradle registry exists", () => {
    expect(buildGradleInit([endpoint({ kind: "maven" })])).toBe("");
    const init = buildGradleInit([endpoint({ kind: "gradle" })]);
    expect(init).toContain(JSON.stringify(gw("r1")));
    expect(init).toContain("allowInsecureProtocol = true");
    expect(init).toContain("handler.clear()");
    expect(buildGradleInit([endpoint({ kind: "gradle", mode: "additional" })])).not.toContain("handler.clear()");
  });
});
