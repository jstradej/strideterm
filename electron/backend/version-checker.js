import path from "node:path";
import fs from "node:fs/promises";

const THROTTLE_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_NEWER_RELEASES = 20;

/**
 * Parse a version string like "v1.4.1" or "1.4.1" into { major, minor, patch }.
 * Returns null if the string is not a valid semver-like version.
 */
export function parseVersion(tag) {
  if (typeof tag !== "string") return null;
  const match = tag.match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/**
 * Compare two version strings. Returns -1 (a < b), 0 (a === b), or 1 (a > b).
 * Returns 0 if either version is unparseable.
 */
export function compareVersions(a, b) {
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
function parseGitHubUrl(url) {
  const match = url.match(/github\.com\/([^/]+)\/([^/.]+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

/**
 * Atomic write: write to a temp file first, then rename over the target.
 */
async function atomicWriteFile(filePath, data) {
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  await fs.writeFile(tmpPath, data);
  await fs.rename(tmpPath, filePath);
}

async function loadCache(cachePath) {
  try {
    const raw = await fs.readFile(cachePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function saveCache(cachePath, data) {
  try {
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await atomicWriteFile(cachePath, JSON.stringify(data, null, 2));
  } catch {
    // Ignore write failures — cache is best-effort.
  }
}

/**
 * Create a version checker instance.
 *
 * @param {object} options
 * @param {string} options.currentVersion - The app's current version (e.g. "1.4.1")
 * @param {string} options.repositoryUrl  - GitHub repository URL
 * @param {string} options.userDataPath   - Path to the user data directory (e.g. ~/.strideterm)
 * @param {function} [options.fetchImpl]  - Optional fetch override (for testing)
 */
export function createVersionChecker({ currentVersion, repositoryUrl, userDataPath, fetchImpl }) {
  const github = parseGitHubUrl(repositoryUrl);
  if (!github) {
    console.warn("[version-checker] Cannot parse GitHub URL:", repositoryUrl);
    return { checkForUpdates: async () => null, getCachedResult: () => null };
  }

  const cachePath = path.join(userDataPath, "version-check.json");
  const doFetch = fetchImpl || globalThis.fetch;
  let cachedResult = null;
  let loaded = false;

  async function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    cachedResult = await loadCache(cachePath);
  }

  function getCachedResult() {
    return cachedResult;
  }

  async function checkForUpdates(force = false) {
    await ensureLoaded();

    // Throttle: skip if checked within the last 24 hours (unless forced).
    if (!force && cachedResult?.lastCheckAt) {
      const elapsed = Date.now() - new Date(cachedResult.lastCheckAt).getTime();
      if (elapsed < THROTTLE_MS) {
        return cachedResult;
      }
    }

    const apiUrl = `https://api.github.com/repos/${github.owner}/${github.repo}/releases?per_page=50`;
    const headers = { Accept: "application/vnd.github+json" };
    if (cachedResult?.etag) {
      headers["If-None-Match"] = cachedResult.etag;
    }

    let response;
    try {
      response = await doFetch(apiUrl, { headers });
    } catch {
      // Network error — return cached result silently.
      return cachedResult;
    }

    // 304 Not Modified — data unchanged, just update the timestamp.
    if (response.status === 304) {
      cachedResult = { ...cachedResult, lastCheckAt: new Date().toISOString() };
      await saveCache(cachePath, cachedResult);
      return cachedResult;
    }

    // Non-OK response (rate limit, server error) — return cached result.
    if (!response.ok) {
      return cachedResult;
    }

    let releases;
    try {
      releases = await response.json();
    } catch {
      return cachedResult;
    }

    const etag = response.headers?.get?.("etag") || cachedResult?.etag || "";

    // Filter out nightly, pre-release, and draft releases.
    const stable = releases.filter(
      (r) => r.tag_name !== "nightly" && !r.prerelease && !r.draft && parseVersion(r.tag_name),
    );

    // Sort by version descending.
    stable.sort((a, b) => compareVersions(b.tag_name, a.tag_name));

    // Find releases newer than currentVersion.
    const newer = stable
      .filter((r) => compareVersions(r.tag_name, currentVersion) > 0)
      .slice(0, MAX_NEWER_RELEASES);

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
