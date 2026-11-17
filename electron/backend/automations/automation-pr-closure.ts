import type { AutomationEvent } from "../../shared/automation-events.js";

/** Persist only the fields needed to find a disappeared PR and route its terminal event. */
export interface AutomationPrReference {
  source: "github" | "azure-devops";
  profileId: string;
  connectionId: string;
  prKey: string;
  repositoryName: string;
  repositoryId: string;
  projectName: string;
  projectId: string;
  pullRequestNumber: number;
  title: string;
  webUrl: string;
  headSha: string;
  targetBranch: string;
  role: "author" | "reviewer";
  draft: boolean;
}

export function parseAutomationPrReference(value: unknown): AutomationPrReference | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const ref = value as Record<string, unknown>;
  if (ref.source !== "github" && ref.source !== "azure-devops") return null;
  if (typeof ref.pullRequestNumber !== "number" || (ref.role !== "author" && ref.role !== "reviewer")) return null;
  for (const key of [
    "profileId",
    "connectionId",
    "prKey",
    "repositoryName",
    "repositoryId",
    "projectName",
    "projectId",
    "title",
    "webUrl",
    "headSha",
    "targetBranch",
  ])
    if (typeof ref[key] !== "string") return null;
  if (typeof ref.draft !== "boolean") return null;
  return automationPrReference(ref.source, {
    profileId: ref.profileId,
    connectionId: ref.connectionId,
    prKey: ref.prKey,
    role: ref.role,
    repository: { fullName: ref.repositoryName, id: ref.repositoryId },
    project: { name: ref.projectName, id: ref.projectId },
    pullRequest: {
      number: ref.pullRequestNumber,
      title: ref.title,
      webUrl: ref.webUrl,
      headSha: ref.headSha,
      targetRefName: ref.targetBranch,
      draft: ref.draft,
    },
  });
}

export function automationPrReference(
  source: AutomationPrReference["source"],
  summary: Record<string, unknown>,
): AutomationPrReference | null {
  const repository = summary.repository as { id?: string; name?: string; fullName?: string } | undefined;
  const project = summary.project as { id?: string; name?: string } | undefined;
  const pr = summary.pullRequest as
    | {
        id?: string | number;
        number?: number;
        title?: string;
        webUrl?: string;
        headSha?: string;
        sourceCommitId?: string;
        targetRefName?: string;
        draft?: boolean;
        isDraft?: boolean;
      }
    | undefined;
  const role = summary.role;
  const profileId = String(summary.profileId || "");
  const connectionId = String(summary.connectionId || "");
  const prKey = String(summary.prKey || "");
  const repositoryName = String(repository?.fullName || repository?.name || "");
  const pullRequestNumber = Number(pr?.number || pr?.id);
  if (
    !pr ||
    !profileId ||
    !connectionId ||
    !prKey ||
    !repositoryName ||
    !Number.isSafeInteger(pullRequestNumber) ||
    pullRequestNumber < 1 ||
    (role !== "author" && role !== "reviewer")
  )
    return null;
  if (source === "github" && !repositoryName.includes("/")) return null;
  if (source === "azure-devops" && (!project?.name || !repository?.id)) return null;
  return {
    source,
    profileId,
    connectionId,
    prKey,
    repositoryName,
    repositoryId: String(repository?.id || ""),
    projectName: String(project?.name || ""),
    projectId: String(project?.id || ""),
    pullRequestNumber,
    title: String(pr.title || ""),
    webUrl: String(pr.webUrl || ""),
    headSha: String(pr.headSha || pr.sourceCommitId || ""),
    targetBranch: String(pr.targetRefName || ""),
    role,
    draft: pr.draft === true || pr.isDraft === true,
  };
}

export function automationPrTerminalEvent(
  reference: AutomationPrReference,
  kind: "pr-merged" | "pr-closed",
  detectedAt: string,
  terminalAt: string,
): AutomationEvent {
  return {
    id: `${reference.prKey}:${kind}:${terminalAt || reference.headSha}`,
    detectedAt,
    source: reference.source,
    kind,
    profileId: reference.profileId,
    connectionId: reference.connectionId,
    pr: {
      prKey: reference.prKey,
      repositoryName: reference.repositoryName,
      pullRequestNumber: reference.pullRequestNumber,
      title: reference.title,
      webUrl: reference.webUrl,
      headSha: reference.headSha,
      role: reference.role,
      ...(reference.targetBranch ? { targetBranch: reference.targetBranch } : {}),
      draft: reference.draft,
    },
  };
}
