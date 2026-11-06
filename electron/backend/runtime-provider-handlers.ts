import { createAzureHandlers } from "./runtime-azure-handlers.js";
import { createGitHubHandlers } from "./runtime-github-handlers.js";
import { createReviewBridgeHandlers } from "./runtime-review-bridge-handlers.js";
import { createJiraHandlers } from "./jira/runtime-jira-handlers.js";

/**
 * Factory for all provider API handlers (Azure DevOps, GitHub, Review Bridge).
 *
 * Thin combiner — each domain lives in its own module for modularity and testability.
 * Receives a context object with all runtime dependencies (same pattern as app-dialog-actions.js).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createProviderHandlers(ctx: any) {
  const jira = createJiraHandlers(ctx);
  const linkingCtx = { ...ctx, jiraResolveWorkItem: jira.jiraResolveWorkItem };
  return {
    ...createAzureHandlers(linkingCtx),
    ...createGitHubHandlers(linkingCtx),
    ...createReviewBridgeHandlers(ctx),
    ...jira,
  };
}
