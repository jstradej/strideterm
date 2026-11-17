import type { AutomationEvent } from "../../shared/automation-events.js";
import { clampJiraPollSeconds } from "../../shared/jira-poll-interval.js";
import { computeMinPollSeconds } from "../shared/runtime-provider-guards.js";

type Connection = { id: string; profileId?: string; enabled?: boolean; pollSeconds?: number };
type Settings = {
  github: { defaultPollSeconds: number; connections: Connection[] };
  azureDevops: { defaultPollSeconds: number; connections: Connection[] };
  jira: {
    defaultPollSeconds: number;
    connections: Connection[];
    queries: Array<{ id: string; connectionId: string; profileId: string; pollSeconds?: number }>;
  };
};

/** The cooldown follows the same polling interval as the source that observed the event. */
export function automationPollIntervalMs(event: AutomationEvent, settings: Settings): number {
  if (event.source === "jira") {
    const query = settings.jira.queries.find(
      (item) =>
        item.id === event.jira?.queryId &&
        item.connectionId === event.connectionId &&
        item.profileId === event.profileId,
    );
    const connection = settings.jira.connections.find(
      (item) => item.id === event.connectionId && (item.profileId || "default") === event.profileId,
    );
    return (
      clampJiraPollSeconds(query?.pollSeconds || connection?.pollSeconds || settings.jira.defaultPollSeconds) * 1000
    );
  }
  const provider = event.source === "github" ? settings.github : settings.azureDevops;
  const enabled = provider.connections.filter((connection) => connection.enabled !== false);
  return (
    (enabled.length
      ? computeMinPollSeconds(enabled, provider.defaultPollSeconds)
      : Math.max(15, Number(provider.defaultPollSeconds) || 120)) * 1000
  );
}
