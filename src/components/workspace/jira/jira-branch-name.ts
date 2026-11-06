const BRANCH_PREFIX = "feature/";
const MAX_NAME_LENGTH = 50;

/**
 * A git-ref safe branch name for an issue: `feature/<KEY>-<summary words>`. The key keeps its case so Jira links the
 * branch to the issue; the summary part is lowercase ASCII. The part after `feature/` is cut at a word boundary to at
 * most `maxLength` characters.
 */
export function jiraBranchName(issueKey: string, summary = "", maxLength = MAX_NAME_LENGTH): string {
  const key = issueKey
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const words = summary
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const name = [key || "jira-task", words].filter(Boolean).join("-");
  if (name.length <= maxLength) return `${BRANCH_PREFIX}${name}`;
  const cut = name.slice(0, maxLength);
  const atWordBoundary = name[maxLength] === "-" ? cut : cut.slice(0, Math.max(cut.lastIndexOf("-"), key.length));
  return `${BRANCH_PREFIX}${atWordBoundary.replace(/-+$/g, "")}`;
}
