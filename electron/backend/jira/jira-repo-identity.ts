export type JiraTaskRepoProvider = "github" | "azure";

function cleanPath(value: string): string[] {
  return value
    .split("/")
    .filter(Boolean)
    .map((part) => decodeURIComponent(part))
    .filter((part) => part !== "_git" && part !== "v3")
    .map((part) => part.replace(/\.git$/i, "").toLowerCase());
}

function parseRemote(value: string): { host: string; path: string[]; user?: string } | null {
  const input = value.trim();
  const colon = input.indexOf(":");
  const slashSlash = input.indexOf("://");
  if (colon > 0 && slashSlash !== colon) {
    const authority = input.slice(0, colon);
    const rawPath = input.slice(colon + 1);
    const at = authority.lastIndexOf("@");
    const user = at >= 0 ? authority.slice(0, at) : undefined;
    const host = at >= 0 ? authority.slice(at + 1) : authority;
    if (host && rawPath && !host.includes("/") && !host.includes(":"))
      return { host: host.toLowerCase(), path: cleanPath(rawPath), user };
  }
  try {
    const url = new URL(input);
    if (!/^https?:$|^ssh:$/.test(url.protocol) || url.password) return null;
    return { host: url.hostname.toLowerCase(), path: cleanPath(url.pathname), user: url.username || undefined };
  } catch {
    return null;
  }
}

/** Compare repository identity across supported HTTPS and SSH clone URL forms. */
export function sameProviderRepository(provider: JiraTaskRepoProvider, expected: string, actual: string): boolean {
  const left = parseRemote(expected);
  const right = parseRemote(actual);
  if (!left || !right) return false;
  if (provider === "github") {
    const canonicalHost = (host: string) => (host === "ssh.github.com" ? "github.com" : host);
    return (
      canonicalHost(left.host) === canonicalHost(right.host) &&
      left.path.length === 2 &&
      right.path.length === 2 &&
      left.path.join("/") === right.path.join("/")
    );
  }
  const azure = (remote: { host: string; path: string[]; user?: string }): string | null => {
    const p = remote.path;
    if (remote.host === "ssh.dev.azure.com" && p.length === 3) return `${p[0]}/${p[1]}/${p[2]}`;
    if (remote.host === "dev.azure.com" && p.length >= 3) return `${p[0]}/${p[1]}/${p[p.length - 1]}`;
    if (remote.host.endsWith(".visualstudio.com") && p.length >= 2) {
      const org = remote.user || remote.host.slice(0, -".visualstudio.com".length);
      return `${org}/${p[0]}/${p[p.length - 1]}`;
    }
    return null;
  };
  return azure(left) !== null && azure(left) === azure(right);
}
