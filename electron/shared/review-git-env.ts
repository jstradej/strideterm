/**
 * Where the review MCP server finds its per-tab Git capability. Both ride the
 * PTY environment, never argv or persisted state — same as the SSH tools.
 */
export const REVIEW_GIT_ENV_PREFIX = "STRIDETERM_REVIEW_GIT_";
export const REVIEW_GIT_URL_ENV = "STRIDETERM_REVIEW_GIT_URL";
export const REVIEW_GIT_CAPABILITY_ENV = "STRIDETERM_REVIEW_GIT_CAPABILITY";
