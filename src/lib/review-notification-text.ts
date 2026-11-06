/**
 * A pull-request notification leads with the PR's own title — that is what tells the user which PR it is —
 * and keeps what happened ("New comment on repo #12") as the line above it.
 *
 * Event titles and bodies come from the backend already worded for a single line, and some of them carry the
 * PR title themselves (Azure "New pull request: project / repo — <title>", the ready-for-review body, GitHub
 * "<author>: <title>"). Those copies are dropped here so the title is not printed twice. Older history entries
 * with no `pullRequestTitle` keep their text unchanged.
 */
export interface ReviewNotificationText {
  prTitle: string;
  event: string;
  detail: string;
}

export function reviewNotificationText(
  title: unknown,
  body: unknown,
  pullRequestTitle: unknown,
): ReviewNotificationText {
  const prTitle = String(pullRequestTitle || "").trim();
  const event = String(title || "");
  const detail = String(body || "");
  if (!prTitle) return { prTitle: "", event, detail };
  const titleSuffix = ` — ${prTitle}`;
  const authorPrefix = detail.endsWith(`: ${prTitle}`) ? detail.slice(0, -(prTitle.length + 2)) : "";
  return {
    prTitle,
    event: event.endsWith(titleSuffix) ? event.slice(0, -titleSuffix.length) : event,
    detail: detail === prTitle ? "" : authorPrefix ? `by ${authorPrefix}` : detail,
  };
}
