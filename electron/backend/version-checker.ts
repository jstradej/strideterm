/// <reference types="node" />
import path from "node:path";
import fs from "node:fs/promises";
import { getLogger } from "./logger.js";

const log = getLogger("version-check");

const THROTTLE_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_NEWER_RELEASES = 20;

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

interface CachedResult {
  lastCheckAt: string;
  etag: string;
  latestVersion: string;
  latestUrl: string;
  versionsBehind: number;
  releases: Array<{ tag: string; url: string; publishedAt: string }>;
}

interface GitHubRelease {
  tag_name: string;
  html_url: string;
  published_at: string;
  prerelease: boolean;
  draft: boolean;
}

interface FetchResponse {
  ok: boolean;
  status: number;
  headers: { get: (name: string) => string | null };
  json: () => Promise<unknown>;
}

type FetchImpl = (url: string, opts: { headers: Record<string, string> }) => Promise<FetchResponse>;

/**
 * Parse a version string like "v1.4.1" or "1.4.1" into { major, minor, patch }.
 * Returns null if the string is not a valid semver-like version.
 */
export function parseVersion(tag: unknown): ParsedVersion | null {
  if (typeof tag !== "string") return null;
  const match = tag.match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/**
 * Compare two version strings. Returns -1 (a < b), 0 (a === b), or 1 (a > b).
 * Returns 0 if either version is unparseable.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
  return 0;
}

/**
 * Extract owner and repo from a GitHub URL like "https://github.com/jstradej/strideterm".
 */
function parseGitHubUrl(url: string): { owner: string; repo: string } | null {
  const match = url.match(/github\.com\/([^/]+)\/([^/.]+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

/**
 * Atomic write: write to a temp file first, then rename over the target.
 */
async function atomicWriteFile(filePath: string, data: string): Promise<void> {
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  await fs.writeFile(tmpPath, data);
  await fs.rename(tmpPath, filePath);
}

async function loadCache(cachePath: string): Promise<CachedResult | null> {
  try {
    const raw = await fs.readFile(cachePath, "utf8");
    return JSON.parse(raw) as CachedResult;
  } catch {
    return null;
  }
}

async function saveCache(cachePath: string, data: CachedResult): Promise<void> {
  try {
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await atomicWriteFile(cachePath, JSON.stringify(data, null, 2));
  } catch {
    // Ignore write failures — cache is best-effort.
  }
}

/**
 * Create a version checker instance.
 */
export function createVersionChecker({
  currentVersion,
  repositoryUrl,
  userDataPath,
  fetchImpl,
}: {
  currentVersion: string;
  repositoryUrl: string;
  userDataPath: string;
  fetchImpl?: FetchImpl;
}) {
  const githubParsed = parseGitHubUrl(repositoryUrl);
  if (!githubParsed) {
    log.warn("cannot parse GitHub URL", { repositoryUrl });
    return { checkForUpdates: async (): Promise<null> => null, getCachedResult: (): null => null };
  }
  const github: { owner: string; repo: string } = githubParsed;

  const cachePath = path.join(userDataPath, "version-check.json");
  const doFetch: FetchImpl = fetchImpl || (globalThis.fetch as unknown as FetchImpl);
  let cachedResult: CachedResult | null = null;
  let loaded = false;

  async function ensureLoaded(): Promise<void> {
    if (loaded) return;
    loaded = true;
    cachedResult = await loadCache(cachePath);
  }

  // Cache stores versionsBehind as it was at fetch time, but the user can update the
  // binary between the fetch and the next read. Recompute against the live currentVersion
  // every time we hand the cache out so the count never lags behind an in-place update.
  function withCurrentVersionsBehind(cached: CachedResult): CachedResult {
    const versionsBehind = cached.releases.filter((r) => compareVersions(r.tag, currentVersion) > 0).length;
    return { ...cached, versionsBehind };
  }

  function getCachedResult(): CachedResult | null {
    return cachedResult ? withCurrentVersionsBehind(cachedResult) : null;
  }

  async function checkForUpdates(force = false): Promise<CachedResult | null> {
    await ensureLoaded();

    // Throttle: skip if checked within the last 24 hours (unless forced).
    if (!force && cachedResult?.lastCheckAt) {
      const elapsed = Date.now() - new Date(cachedResult.lastCheckAt).getTime();
      if (elapsed < THROTTLE_MS) {
        return withCurrentVersionsBehind(cachedResult);
      }
    }

    const apiUrl = `https://api.github.com/repos/${github.owner}/${github.repo}/releases?per_page=50`;
    const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
    if (cachedResult?.etag) {
      headers["If-None-Match"] = cachedResult.etag;
    }

    let response: FetchResponse;
    try {
      response = await doFetch(apiUrl, { headers });
    } catch {
      // Network error — return cached result silently.
      return cachedResult ? withCurrentVersionsBehind(cachedResult) : null;
    }

    // 304 Not Modified — data unchanged, just update the timestamp.
    if (response.status === 304) {
      cachedResult = { ...cachedResult!, lastCheckAt: new Date().toISOString() };
      await saveCache(cachePath, cachedResult);
      return withCurrentVersionsBehind(cachedResult);
    }

    // Non-OK response (rate limit, server error) — return cached result.
    if (!response.ok) {
      return cachedResult ? withCurrentVersionsBehind(cachedResult) : null;
    }

    let releases: GitHubRelease[];
    try {
      releases = (await response.json()) as GitHubRelease[];
    } catch {
      return cachedResult ? withCurrentVersionsBehind(cachedResult) : null;
    }

    const etag = response.headers?.get?.("etag") || cachedResult?.etag || "";

    // Filter out nightly, pre-release, and draft releases.
    const stable = releases.filter(
      (r) => r.tag_name !== "nightly" && !r.prerelease && !r.draft && parseVersion(r.tag_name),
    );

    // Sort by version descending.
    stable.sort((a, b) => compareVersions(b.tag_name, a.tag_name));

    // Find releases newer than currentVersion.
    const newer = stable.filter((r) => compareVersions(r.tag_name, currentVersion) > 0).slice(0, MAX_NEWER_RELEASES);

    const latestRelease = stable[0] || null;
    const latestTag = latestRelease?.tag_name || "";
    const latestParsed = parseVersion(latestTag);

    cachedResult = {
      lastCheckAt: new Date().toISOString(),
      etag,
      latestVersion: latestParsed ? `${latestParsed.major}.${latestParsed.minor}.${latestParsed.patch}` : "",
      latestUrl: latestRelease?.html_url || "",
      versionsBehind: newer.length,
      releases: newer.map((r) => ({
        tag: r.tag_name,
        url: r.html_url,
        publishedAt: r.published_at || "",
      })),
    };

    await saveCache(cachePath, cachedResult);
    return cachedResult;
  }

  return { checkForUpdates, getCachedResult };
}
