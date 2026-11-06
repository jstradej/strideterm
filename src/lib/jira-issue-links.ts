export interface JiraLinkRoute {
  connectionId: string;
  label: string;
  webUrl: string;
  issueKeyPrefixes: string[];
}

export function jiraIssueUrl(route: JiraLinkRoute, key: string): string | null {
  try {
    const base = new URL(route.webUrl);
    if (base.protocol !== "https:" && base.protocol !== "http:") return null;
    if (base.username || base.password || base.search || base.hash) return null;
    const path = base.pathname.replace(/\/$/, "");
    return new URL(`${path}/browse/${encodeURIComponent(key)}`, base.origin).toString();
  } catch {
    return null;
  }
}

export function jiraCandidates(key: string, routes: JiraLinkRoute[]): JiraLinkRoute[] {
  const match = /^([A-Z][A-Z0-9_]{0,19})-([1-9][0-9]*)$/i.exec(key);
  if (!match) return [];
  const prefix = match[1].toUpperCase();
  return routes.filter(
    (route) => route.issueKeyPrefixes.some((item) => item.toUpperCase() === prefix) && jiraIssueUrl(route, key),
  );
}

export function autolinkJiraText(text: string, routes: JiraLinkRoute[]): string {
  return autolinkEscapedJiraText(
    text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
    routes,
  );
}

export function autolinkEscapedJiraText(escaped: string, routes: JiraLinkRoute[]): string {
  const candidates: string[] = [];
  return escaped
    .replace(
      /(^|[^A-Z0-9_/:.])([A-Z][A-Z0-9_]{0,19}-[1-9][0-9]*)(?![A-Z0-9_])/gi,
      (whole, before: string, key: string) => {
        const matches = jiraCandidates(key, routes);
        if (matches.length > 1) {
          const token = `\u0000${candidates.length}\u0000`;
          candidates.push(`<button type="button" class="jira-issue-chooser" data-jira-key="${key}">${key}</button>`);
          return `${before}${token}`;
        }
        if (matches.length !== 1) return whole;
        const url = jiraIssueUrl(matches[0], key);
        if (!url) return whole;
        const token = `\u0000${candidates.length}\u0000`;
        candidates.push(
          `<a href="${url}" target="_blank" rel="noopener noreferrer" data-jira-issue="${key}">${key}</a>`,
        );
        return `${before}${token}`;
      },
    )
    .replace(/\u0000(\d+)\u0000/g, (_, index: string) => candidates[Number(index)]);
}
