import { createAzureHandlers } from "./runtime-azure-handlers.js";
import { createGitHubHandlers } from "./runtime-github-handlers.js";
import { createReviewBridgeHandlers } from "./runtime-review-bridge-handlers.js";

/**
 * Factory for all provider API handlers (Azure DevOps, GitHub, Review Bridge).
 *
 * Thin combiner — each domain lives in its own module for modularity and testability.
 * Receives a context object with all runtime dependencies (same pattern as app-dialog-actions.js).
 */
export function createProviderHandlers(ctx) {
  return {
    ...createAzureHandlers(ctx),
    ...createGitHubHandlers(ctx),
    ...createReviewBridgeHandlers(ctx),
  };
}
