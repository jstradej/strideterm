import { existsSync, readdirSync, type Dirent } from "node:fs";
import path from "node:path";

/**
 * What the build tools of a workspace need inside the sandbox, chosen by what the workspace holds.
 * Dependency caches are writable folders OUTSIDE the home directory, shared between workspaces per
 * toolchain (they only ever hold downloaded artifacts).
 */
export interface ToolchainProfile {
  id: "node" | "maven" | "gradle" | "python" | "rust" | "go";
  /** File names (or `*.ext` patterns) whose presence in a workspace root selects the profile. */
  markers: string[];
  /** Home-relative tool installations (JDK, Node, language managers) readable by the sandbox. */
  readHome: string[];
  /** Public registries the tool may reach directly. */
  domains: string[];
  /** Subfolder of the shared cache root this toolchain writes to. */
  cacheDir: string;
  /** Environment redirecting the tool's cache into `<cacheRoot>/<cacheDir>`; `{cache}` is that folder. */
  env: Record<string, string>;
}

export const TOOLCHAIN_PROFILES: ToolchainProfile[] = [
  {
    id: "node",
    markers: ["package.json"],
    readHome: [".nvm", ".volta", ".fnm", ".local/share/fnm", ".npm-global", ".local/share/pnpm", ".asdf"],
    domains: ["registry.npmjs.org", "registry.yarnpkg.com"],
    cacheDir: "node",
    env: { npm_config_cache: "{cache}/npm", YARN_CACHE_FOLDER: "{cache}/yarn", npm_config_update_notifier: "false" },
  },
  {
    id: "maven",
    markers: ["pom.xml"],
    readHome: [".sdkman", ".jdks", ".asdf"],
    domains: ["repo.maven.apache.org", "repo1.maven.org"],
    cacheDir: "maven",
    env: {},
  },
  {
    id: "gradle",
    markers: ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"],
    readHome: [".sdkman", ".jdks", ".asdf"],
    domains: [
      "services.gradle.org",
      "downloads.gradle.org",
      "plugins.gradle.org",
      "plugins-artifacts.gradle.org",
      "repo.maven.apache.org",
      "repo1.maven.org",
    ],
    cacheDir: "gradle",
    env: {},
  },
  {
    id: "python",
    markers: ["pyproject.toml", "requirements.txt", "setup.py", "Pipfile"],
    readHome: [".pyenv", ".local/share/uv", ".asdf"],
    domains: ["pypi.org", "files.pythonhosted.org"],
    cacheDir: "python",
    env: { PIP_CACHE_DIR: "{cache}/pip", UV_CACHE_DIR: "{cache}/uv" },
  },
  {
    id: "rust",
    markers: ["Cargo.toml"],
    readHome: [".cargo/bin", ".rustup"],
    domains: ["crates.io", "index.crates.io", "static.crates.io"],
    cacheDir: "rust",
    env: { CARGO_HOME: "{cache}/cargo" },
  },
  {
    id: "go",
    markers: ["go.mod"],
    readHome: [".asdf", "go/bin"],
    domains: ["proxy.golang.org", "sum.golang.org"],
    cacheDir: "go",
    env: { GOMODCACHE: "{cache}/mod", GOCACHE: "{cache}/build", GOFLAGS: "-modcacherw" },
  },
];

function rootHasMarker(entries: Set<string>, marker: string): boolean {
  if (!marker.startsWith("*.")) return entries.has(marker);
  const suffix = marker.slice(1);
  for (const name of entries) if (name.endsWith(suffix)) return true;
  return false;
}

const SKIPPED_SUBDIRECTORIES = new Set(["node_modules", "target", "build", "dist", "vendor"]);
const MAX_SUBDIRECTORIES_PER_ROOT = 40;

function readEntries(dir: string): Dirent[] | null {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
}

/** The toolchains a set of workspace roots calls for. Looks at each root and its immediate subdirectories (a monorepo's `frontend/` and `backend/`), no deeper. */
export function detectToolchains(roots: string[]): ToolchainProfile[] {
  const found = new Set<ToolchainProfile["id"]>();
  const scan = (entries: Dirent[]) => {
    const names = new Set(entries.map((entry) => entry.name));
    for (const profile of TOOLCHAIN_PROFILES) {
      if (profile.markers.some((marker) => rootHasMarker(names, marker))) found.add(profile.id);
    }
  };
  for (const root of roots) {
    if (!root || !existsSync(root)) continue;
    const entries = readEntries(root);
    if (!entries) continue;
    scan(entries);
    const subdirectories = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !SKIPPED_SUBDIRECTORIES.has(entry.name))
      .slice(0, MAX_SUBDIRECTORIES_PER_ROOT);
    for (const subdirectory of subdirectories) {
      const inner = readEntries(path.join(root, subdirectory.name));
      if (inner) scan(inner);
    }
  }
  return TOOLCHAIN_PROFILES.filter((profile) => found.has(profile.id));
}

/** The cache folder a profile writes to, below the shared cache root (a path in the sandbox's own notation). */
export function toolchainCacheFolder(cacheRoot: string, profile: ToolchainProfile): string {
  return path.posix.join(cacheRoot.replace(/\\/gu, "/"), profile.cacheDir);
}

export function toolchainEnv(cacheRoot: string, profile: ToolchainProfile): Record<string, string> {
  const folder = toolchainCacheFolder(cacheRoot, profile);
  return Object.fromEntries(Object.entries(profile.env).map(([key, value]) => [key, value.replace("{cache}", folder)]));
}
