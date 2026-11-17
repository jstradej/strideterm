export type AutomationEventSource = "azure-devops" | "github" | "jira";

/** Only metadata is carried into an automation; event bodies are fetched separately by the agent. */
export interface AutomationEvent {
  id: string;
  detectedAt: string;
  source: AutomationEventSource;
  kind: AutomationEventKind;
  profileId: string;
  connectionId: string;
  pr?: {
    prKey: string;
    repositoryName: string;
    pullRequestNumber: number;
    title: string;
    webUrl: string;
    headSha: string;
    role: "author" | "reviewer";
    targetBranch?: string;
    draft: boolean;
  };
  jira?: { issueId: string; issueKey: string; queryId: string };
  check?: { checkId: string; name: string; result: string };
}

const EVENT_CATALOG = [
  {
    kind: "pr-new",
    label: "Pull request added",
    sources: ["azure-devops", "github"],
    restrictions: "Azure DevOps: reviewer only",
  },
  { kind: "pr-ready", label: "Pull request ready", sources: ["azure-devops", "github"] },
  {
    kind: "pr-new-comment",
    label: "Pull request comment",
    sources: ["azure-devops", "github"],
    restrictions: "Own comments are excluded",
  },
  { kind: "pr-vote-changed", label: "Review vote changed", sources: ["azure-devops", "github"] },
  {
    kind: "pr-source-updated",
    label: "Pull request source updated",
    sources: ["azure-devops", "github"],
    restrictions: "GitHub: reviewer only",
  },
  {
    kind: "pr-merge-status-changed",
    label: "Merge status changed",
    sources: ["azure-devops"],
    restrictions: "Author only",
  },
  { kind: "pr-checks-failed", label: "Checks failed", sources: ["github"], restrictions: "Author only" },
  { kind: "pr-check-finished", label: "Check finished", sources: ["azure-devops", "github"] },
  { kind: "pr-merged", label: "Pull request merged", sources: ["azure-devops", "github"] },
  { kind: "pr-closed", label: "Pull request closed", sources: ["azure-devops", "github"] },
  { kind: "jira-issue-added", label: "Jira issue added", sources: ["jira"] },
  { kind: "jira-issue-removed", label: "Jira issue removed", sources: ["jira"] },
  { kind: "jira-issue-changed", label: "Jira issue changed", sources: ["jira"] },
] as const satisfies ReadonlyArray<{
  kind: string;
  label: string;
  sources: readonly AutomationEventSource[];
  restrictions?: string;
}>;

export type AutomationEventKind = (typeof EVENT_CATALOG)[number]["kind"];
export const AUTOMATION_EVENT_CATALOG: ReadonlyArray<{
  kind: AutomationEventKind;
  label: string;
  sources: readonly AutomationEventSource[];
  restrictions?: string;
}> = EVENT_CATALOG;
export const AUTOMATION_EVENT_KINDS = EVENT_CATALOG.map((event) => event.kind) as [
  AutomationEventKind,
  ...AutomationEventKind[],
];
