import {
  AUTOMATION_EVENT_KINDS,
  type AutomationEvent,
  type AutomationEventKind,
} from "../../shared/automation-events.js";
import type { ReviewActivityEvent } from "../shared/review-activity.js";

/** Convert provider activity without copying notification bodies or actors. */
export function reviewActivityToAutomationEvent(
  activity: ReviewActivityEvent,
  detectedAt: string,
): AutomationEvent | null {
  if (!(activity.provider === "github" || activity.provider === "azure-devops")) return null;
  if (!AUTOMATION_EVENT_KINDS.includes(activity.kind as AutomationEventKind) || !activity.kind.startsWith("pr-"))
    return null;
  if (!activity.profileId || !activity.connectionId || !activity.repositoryName || !activity.pullRequestNumber)
    return null;
  if (activity.role !== "author" && activity.role !== "reviewer") return null;
  if (!("headSha" in activity) || !Number.isFinite(Date.parse(detectedAt))) return null;
  return {
    id: activity.id,
    detectedAt,
    source: activity.provider,
    kind: activity.kind as AutomationEventKind,
    profileId: activity.profileId,
    connectionId: activity.connectionId,
    pr: {
      prKey: activity.prKey,
      repositoryName: activity.repositoryName,
      pullRequestNumber: activity.pullRequestNumber,
      title: activity.pullRequestTitle,
      webUrl: activity.webUrl,
      headSha: activity.headSha,
      role: activity.role,
      ...(activity.targetBranch ? { targetBranch: activity.targetBranch } : {}),
      draft: activity.draftState === "draft",
    },
  };
}

/** An in-process fan-out; consumers own persistence and error reporting. */
export class AutomationEventBus {
  private readonly subscribers = new Set<(event: AutomationEvent) => void>();
  subscribe(subscriber: (event: AutomationEvent) => void): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }
  publish(event: AutomationEvent): void {
    for (const subscriber of this.subscribers) subscriber(event);
  }
  publishReviewActivity(events: readonly ReviewActivityEvent[], detectedAt: string): void {
    for (const activity of events) {
      const event = reviewActivityToAutomationEvent(activity, detectedAt);
      if (event) this.publish(event);
    }
  }
}

/** Tracks check transitions when fresh provider data arrives, without polling or retaining check output. */
export class AutomationCheckTracker {
  private readonly states = new Map<string, string>();

  constructor(
    private readonly publish: (event: AutomationEvent) => void,
    private readonly startedAt = Date.now(),
  ) {}

  observe(source: "github" | "azure-devops", value: Record<string, unknown>, detectedAt: string): void {
    const repository = value.repository as { fullName?: string; name?: string } | undefined;
    const pr = value.pullRequest as
      | {
          number?: number;
          id?: number | string;
          title?: string;
          webUrl?: string;
          headSha?: string;
          sourceCommitId?: string;
          targetRefName?: string;
          draft?: boolean;
          isDraft?: boolean;
        }
      | undefined;
    const checks = value.checks as { items?: Array<{ id?: string; name?: string; state?: string }> } | undefined;
    const profileId = String(value.profileId || "");
    const connectionId = String(value.connectionId || "");
    const prKey = String(value.prKey || "");
    const headSha = String(pr?.headSha || pr?.sourceCommitId || "");
    const repositoryName = repository?.fullName || repository?.name || "";
    const pullRequestNumber = Number(pr?.number || pr?.id);
    const role = value.role;
    if (
      !profileId ||
      !connectionId ||
      !prKey ||
      !pr ||
      !repositoryName ||
      !Number.isSafeInteger(pullRequestNumber) ||
      pullRequestNumber < 1 ||
      !headSha ||
      (role !== "author" && role !== "reviewer") ||
      !Number.isFinite(Date.parse(detectedAt))
    )
      return;
    for (const check of checks?.items || []) {
      if (!check.id) continue;
      const key = JSON.stringify([source, profileId, connectionId, prKey, headSha, check.id]);
      const previous = this.states.get(key);
      const state = String(check.state || "");
      this.states.delete(key);
      this.states.set(key, state);
      while (this.states.size > 5000) this.states.delete(this.states.keys().next().value!);
      if (Date.parse(detectedAt) - this.startedAt < 10_000) continue;
      if (previous !== "pending" || (state !== "succeeded" && state !== "failed")) continue;
      this.publish({
        id: `check:${key}:${state}`,
        detectedAt,
        source,
        kind: "pr-check-finished",
        profileId,
        connectionId,
        pr: {
          prKey,
          repositoryName,
          pullRequestNumber,
          title: pr.title || "",
          webUrl: pr.webUrl || "",
          headSha,
          role,
          ...(pr.targetRefName ? { targetBranch: pr.targetRefName.replace(/^refs\/heads\//u, "") } : {}),
          draft: pr.draft === true || pr.isDraft === true,
        },
        check: { checkId: String(check.id), name: String(check.name || "Check"), result: state },
      });
    }
  }
}

/** Convert a Jira polling delta into metadata; issue descriptions and comments are never copied. */
export function jiraPollToAutomationEvent(
  notification: import("../jira/jira-polling.js").JiraPollNotification,
): AutomationEvent {
  return {
    id: notification.eventId,
    detectedAt: new Date(notification.observedAt).toISOString(),
    source: "jira",
    kind: `jira-issue-${notification.type}`,
    profileId: notification.profileId,
    connectionId: notification.connectionId,
    jira: { issueId: notification.issueId, issueKey: notification.issueKey, queryId: notification.queryId },
  };
}
