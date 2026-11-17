import { randomUUID } from "node:crypto";
import type { AutomationState } from "../../shared/automation.js";
import type { AutomationEvent } from "../../shared/automation-events.js";
import type { AutomationJournal } from "./automation-journal.js";

export interface EventAutomation {
  workspaceId: string;
  profileId: string;
  automation: AutomationState;
}

export function automationEventSubject(event: AutomationEvent): string | null {
  if (event.pr) return `pr:${event.source}:${event.pr.repositoryName.toLowerCase()}:${event.pr.pullRequestNumber}`;
  if (event.jira) return `jira:${event.jira.issueId}`;
  return null;
}

export function matchesAutomationEvent(rule: EventAutomation, event: AutomationEvent): boolean {
  const definition = rule.automation;
  const trigger = definition.trigger;
  if (!definition.enabled || trigger.type !== "event" || !definition.enabledAt) return false;
  if (event.profileId !== rule.profileId || event.source !== trigger.source || !trigger.kinds.includes(event.kind))
    return false;
  const detected = Date.parse(event.detectedAt);
  if (!Number.isFinite(detected) || detected < Date.parse(definition.enabledAt)) return false;
  if (trigger.connectionId && trigger.connectionId !== event.connectionId) return false;
  if (trigger.repositories?.length && (!event.pr || !trigger.repositories.includes(event.pr.repositoryName)))
    return false;
  if (trigger.role && trigger.role !== event.pr?.role) return false;
  if (
    trigger.targetBranches?.length &&
    (!event.pr?.targetBranch ||
      !trigger.targetBranches.some(
        (branch) => branch.replace(/^refs\/heads\//u, "") === event.pr!.targetBranch!.replace(/^refs\/heads\//u, ""),
      ))
  )
    return false;
  if (trigger.jiraQueryId && trigger.jiraQueryId !== event.jira?.queryId) return false;
  return automationEventSubject(event) !== null;
}

/** Queue matching events durably. The runner claims and removes a pending entry atomically with creating a run. */
export class AutomationEventRouter {
  constructor(
    private readonly journal: AutomationJournal,
    private readonly ready: (workspaceId: string) => void,
    private readonly isCurrent: (rule: EventAutomation) => boolean = () => true,
  ) {}

  async route(rule: EventAutomation, event: AutomationEvent, ownPollIntervalMs: number): Promise<void> {
    rule = structuredClone(rule);
    if (!matchesAutomationEvent(rule, event)) return;
    const subject = automationEventSubject(event)!;
    // Construct a fresh object so future source extensions cannot accidentally copy comment or issue bodies.
    const metadata: AutomationEvent = {
      id: event.id,
      detectedAt: event.detectedAt,
      source: event.source,
      kind: event.kind,
      profileId: event.profileId,
      connectionId: event.connectionId,
      ...(event.pr
        ? {
            pr: {
              prKey: event.pr.prKey,
              repositoryName: event.pr.repositoryName,
              pullRequestNumber: event.pr.pullRequestNumber,
              title: event.pr.title,
              webUrl: event.pr.webUrl,
              headSha: event.pr.headSha,
              role: event.pr.role,
              targetBranch: event.pr.targetBranch,
              draft: event.pr.draft,
            },
          }
        : {}),
      ...(event.jira
        ? { jira: { issueId: event.jira.issueId, issueKey: event.jira.issueKey, queryId: event.jira.queryId } }
        : {}),
      ...(event.check
        ? { check: { checkId: event.check.checkId, name: event.check.name, result: event.check.result } }
        : {}),
    };
    const enqueued = await this.journal.update(rule.workspaceId, (state) => {
      if (!this.isCurrent(rule)) return false;
      if (state.seenEventIds.includes(event.id)) return false;
      state.seenEventIds.push(event.id);
      const at = Date.parse(event.detectedAt);
      const ownWindow = state.runs.some(
        (run) =>
          run.subject === subject &&
          run.state !== "skipped" &&
          at >= Date.parse(run.startedAt) &&
          (!run.finishedAt || at <= Date.parse(run.finishedAt) + ownPollIntervalMs),
      );
      const previous = state.runs
        .filter((run) => run.subject === subject && run.state !== "skipped" && Date.parse(run.startedAt) <= at)
        .at(-1);
      const inCooldown =
        previous && at - Date.parse(previous.startedAt) < rule.automation.policy.subjectCooldownMinutes * 60_000;
      const pending = state.pendingEvents.find((item) => item.subject === subject);
      const reason =
        ownWindow || inCooldown ? "cooldown" : !pending && state.pendingEvents.length >= 20 ? "queue-full" : null;
      if (reason) {
        state.runs.push({
          runId: randomUUID(),
          trigger: { type: "event", eventIds: [event.id] },
          subject,
          state: "skipped",
          reason,
          startedAt: event.detectedAt,
          finishedAt: event.detectedAt,
        });
        return false;
      }
      if (pending) pending.events.push(metadata);
      else state.pendingEvents.push({ subject, events: [metadata] });
      return true;
    });
    if (enqueued) this.ready(rule.workspaceId);
  }
}

/** Advance through skipped subjects; an active run or a retained busy subject waits for a later drain. */
export async function drainAutomationEventQueue(
  journal: AutomationJournal,
  runner: { fire(workspaceId: string, trigger: { type: "event" }, subject: string): Promise<string> },
  workspaceId: string,
  error: (workspaceId: string, cause: unknown) => void,
): Promise<void> {
  while (true) {
    const pending = (await journal.read(workspaceId)).pendingEvents[0];
    if (!pending) return;
    try {
      await runner.fire(workspaceId, { type: "event" }, pending.subject);
    } catch (cause) {
      if (!(cause instanceof Error && cause.message.includes("remains queued"))) error(workspaceId, cause);
      return;
    }
    const after = await journal.read(workspaceId);
    if (
      after.pendingEvents[0]?.subject === pending.subject ||
      after.runs.some((run) => ["starting", "running", "awaiting-user"].includes(run.state))
    )
      return;
  }
}
